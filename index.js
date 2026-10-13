/**
 * dsh-eac-monitor — host half.
 *
 * EAC 悬浮监控窗的数据服务:
 *   - 余额:读取 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY,
 *     调用官方 api.deepseek.com/user/balance(无需登录 Edge)
 *   - 用量:通过 CDP 连接正在运行的 Edge(复用其登录态),
 *     在 platform.deepseek.com 页面上下文内 fetch 平台 API
 *   - 存储:统计 EAC 根目录、~/.dsh 目录、所有工作区目录、当前会话文件大小
 *   - 历史趋势:内存保留最近 240 个采样点,供浮窗画线形图
 *
 * 无额外进程:全部运行在 dsh web 进程内,随 EAC 启动自动加载。
 */
import { readFileSync, existsSync, appendFileSync, statSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { opendir, stat, readFile, writeFile, cp } from "node:fs/promises";
import { join, basename, dirname, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import vm from "node:vm";
import WebSocket from "ws";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

const name = "dsh-eac-monitor";
const inject = ["webServer"];
const REMOTE_PACKAGE = "dsh-eac-monitor";
const REMOTE_SERVICE = "eacMonitor";

const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const EAC_ROOT = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Deepseek Harness EAC");
// Edge 调试端口:默认 9222;9222 被占用时 Edge 会自动换端口并把实际端口写进
// 专用 profile 的 DevToolsActivePort,cdpPort 跟随该文件(见 readDevToolsPort)。
let cdpPort = 9222;
function cdpBase() {
  return "http://127.0.0.1:" + cdpPort;
}
// Edge 151+ 实测:--user-data-dir 指向"默认 profile 位置"时,即使空目录也忽略
// --remote-debugging-port(不写 DevToolsActivePort、不监听端口);复制到其他路径
// 即正常绑定。因此监控改用专用 profile(无空格路径),与用户日常 Edge 互不干扰,
// 重启监控 Edge 也不影响用户浏览。
const EDGE_DEFAULT_PROFILE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Microsoft", "Edge", "User Data");
const EDGE_PROFILE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "EACEdgeProfile");

// 读取专用 profile 实际监听的调试端口(Edge 官方机制:DevToolsActivePort 第一行)。
function readDevToolsPort() {
  try {
    const f = join(EDGE_PROFILE, "Default", "DevToolsActivePort");
    const first = readFileSync(f, "utf8").split(/\r?\n/)[0].trim();
    const n = Number(first);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  } catch { /* 文件不存在(Edge 未运行) */ }
  return 0;
}

const TTL_BALANCE = 60_000;
const TTL_USAGE = 60_000;
const TTL_STORAGE = 30_000;
const HISTORY_CAP = 240;
const COLLECT_STALE_MS = 10_000;
const COLLECT_INTERVAL_MS = 30_000;

// ── 设置(namespace: eac-monitor,settings.yaml 持久化) ──────────────────────
const NS = settingsNamespace("eac-monitor");
const CONFIG_DEFAULTS = {
  enabled: true,
  showBalance: true,
  showTokenStorage: true,
  chartRange: "30m",
  axisAuto: true,
  axisMax: 0,
  layerMode: "top",
  autoConnectEdge: true,
  nativeFloat: true, // v5 壳层浮窗无置顶/透明能力 → 用原生助手浮窗(4.4 时代设置)
};
const CONFIG_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  showBalance: z.boolean().default(true),
  showTokenStorage: z.boolean().default(true),
  chartRange: z.string().default("30m"),
  axisAuto: z.boolean().default(true),
  axisMax: z.number().default(0),
  layerMode: z.string().default("top"),
  autoConnectEdge: z.boolean().default(true),
  nativeFloat: z.boolean().default(true),
});
let cfg = { ...CONFIG_DEFAULTS };
let cfgGetter = null;

// ── 历史持久化(支持 1m ~ 7d 档度) ─────────────────────────────────────────
const HIST_FILE = join(HOME, "storages", "eac-monitor-history.jsonl");
const RANGES = {
  "1m": 60_000, "5m": 300_000, "10m": 600_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "1d": 86_400_000, "7d": 604_800_000,
};

// ── 按 API Key:历史紧凑结构 + 稳定配色序号 ─────────────────────────────────
// 配色在「整个历史窗口内」保持一致:按首次出现顺序分配 colorIndex,
// 因此某个 key 停用后其余 key 的颜色不会整体前移。
const KEY_HIST_MAX = 8;
const keyOrder = new Map(); // keyName -> colorIndex
let keyOrderNext = 0;

function colorIndexOf(name) {
  if (!keyOrder.has(name)) {
    keyOrder.set(name, keyOrderNext);
    keyOrderNext += 1;
  }
  return keyOrder.get(name);
}

function topKeysForHistory() {
  if (!Array.isArray(usageKeys) || !usageKeys.length) return [];
  return usageKeys.slice(0, KEY_HIST_MAX).map((e) => {
    let model = (e.models && e.models[0]) || "";
    if (e.models && e.models.length > 1) model += " 等" + e.models.length + "个";
    return {
      n: e.name,
      c: colorIndexOf(e.name),
      t: e.tokensTotal,
      cost: e.cost == null ? null : e.cost,
      req: e.requests,
      m: model,
    };
  });
}

function appendHistory(point) {
  try {
    appendFileSync(HIST_FILE, JSON.stringify(point) + "\n", "utf8");
    try {
      const st = statSync(HIST_FILE);
      if (st.size > 8 * 1024 * 1024) {
        const txt = readFileSync(HIST_FILE, "utf8");
        writeFileSync(HIST_FILE, txt.split("\n").slice(-20000).join("\n"), "utf8");
      }
    } catch { /* 截断失败忽略 */ }
  } catch { /* 写入失败忽略 */ }
}

function readHistory(rangeMs, maxPoints = 120) {
  const from = Date.now() - rangeMs;
  const pts = [];
  try {
    const txt = readFileSync(HIST_FILE, "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      try {
        const p = JSON.parse(line);
        if (p.ts >= from) pts.push(p);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 */ }
  if (pts.length > maxPoints) {
    const step = pts.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i += 1) out.push(pts[Math.floor(i * step)]);
    return out;
  }
  return pts;
}

// ── 设置写入(settings.yaml 文本层;settings 服务监听文件并热更新) ──────────
function writeConfig(key, value) {
  const file = join(HOME, "settings.yaml");
  try {
    let txt = readFileSync(file, "utf8");
    const val = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    const line = `  ${key}: ${val}\n`;
    if (txt.includes("eac-monitor:")) {
      txt = txt.replace(/^(eac-monitor:\s*\n)((?:\s+.*\n)*)/m, (m, head, body) => {
        const keyRe = new RegExp(`^\\s+${key}:.*\\n`, "m");
        return head + (keyRe.test(body) ? body.replace(keyRe, line) : body + line);
      });
    } else {
      txt = txt.replace(/\s*$/, "\n") + "eac-monitor:\n" + line;
    }
    writeFileSync(file, txt, "utf8");
    cfg = Object.assign({}, cfg, { [key]: value });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// dsh-host-apiproxy 只向 Web 设置客户端暴露白名单命名空间,这里幂等补丁
function ensureSettingsNamespaceExposed(nsName, logger) {
  try {
    const Module = createRequire(import.meta.url)("module");
    const cache = Module._cache ?? {};
    let target = "";
    for (const key of Object.keys(cache)) {
      if (key.includes(`${sep}dsh-host-apiproxy${sep}`) && key.endsWith(`${sep}index.js`)) { target = key; break; }
    }
    if (!target) return;
    const src = readFileSync(target, "utf8");
    if (src.includes(`"${nsName}"`)) return;
    const patched = src.replace(/(const WEB_SETTINGS_NAMESPACES = \[[\s\S]*?)(\n\s*\];)/, (m, pre, post) => {
      const trailingComma = /,\s*$/.test(pre) ? "" : ",";
      const sep2 = pre.trimEnd().endsWith("[") ? "" : trailingComma;
      return `${pre}${sep2}\n\t"${nsName}"${post}`;
    });
    if (patched !== src) {
      writeFileSync(target, patched, "utf8");
      logger?.info?.(`[eac-monitor] 已暴露设置命名空间 "${nsName}"`);
    }
  } catch (e) {
    logger?.warn?.(`[eac-monitor] 设置命名空间暴露失败: ${String((e && e.message) || e)}`);
  }
}

// ── EAC 主进程补丁(桌面置顶监控窗支持,幂等自愈) ───────────────────────────
const MAIN_PATCH_MARK = "// [dsh-eac-monitor] 监控置顶窗:monitor: 前缀 → 纯监控页 + 置顶 + 透明";
const MAIN_OLD_MARK_V1 = "// [dsh-eac-monitor] 监控置顶窗:sessionId 以 monitor: 开头 → 置顶 + 紧凑尺寸";
const MAIN_OLD_MARK_V2 = "// [dsh-eac-monitor] 监控置顶窗:monitor: 前缀 → 纯监控页 + 置顶";
const MAIN_ANCHOR_WIN = "  const win = new BrowserWindow({";
const MAIN_ANCHOR_MAIN = "  mainWindow = new BrowserWindow({";
const MAIN_ANCHOR_SESSION = "  floatBySession.set(sessionId, win);";
const MAIN_OLD_BLOCK_V1 =
  "  // [dsh-eac-monitor] 监控置顶窗:sessionId 以 monitor: 开头 → 置顶 + 紧凑尺寸\n" +
  "  if (String(sessionId || '').startsWith('monitor:')) {\n" +
  "    win.setMinimumSize(340, 480);\n" +
  "    win.setBounds({ width: 420, height: 640 });\n" +
  "    win.setAlwaysOnTop(true, 'screen-saver');\n" +
  "  }\n";
const MAIN_OLD_BLOCK_V2 =
  "  // [dsh-eac-monitor] 监控置顶窗:monitor: 前缀 → 纯监控页 + 置顶\n" +
  "  const monitorMode = String(sessionId || '').startsWith('monitor:');\n" +
  "  if (monitorMode) {\n" +
  "    win.setMinimumSize(340, 480);\n" +
  "    win.setBounds({ width: 420, height: 640 });\n" +
  "    win.setAlwaysOnTop(true, 'screen-saver');\n" +
  "  }\n";
const MAIN_BLOCK_V3 =
  "  // [dsh-eac-monitor] 监控置顶窗:monitor: 前缀 → 纯监控页 + 置顶 + 透明\n" +
  "  if (isMonitor) {\n" +
  "    win.setMinimumSize(340, 480);\n" +
  "    win.setBounds({ width: 420, height: 640 });\n" +
  "    win.setAlwaysOnTop(true, 'screen-saver');\n" +
  "  }\n";
const MAIN_BG_OLD = "    backgroundColor: '#0b1220',";
const MAIN_BG_NEW = "    backgroundColor: isMonitor ? '#00000000' : '#0b1220',";
const MAIN_FRAME_OLD = "    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),";
const MAIN_FRAME_NEW = "    ...(IS_WIN ? { frame: false, roundedCorners: true, ...(isMonitor ? { transparent: true } : {}) } : {}),";
const MAIN_LOADURL_ORIG = "  win.loadURL(webUrl).catch((err) => log('float', '浮窗加载失败: ' + ((err && err.message) || err)));";
const MAIN_LOADURL_V2 = "  win.loadURL(monitorMode ? webUrl + '/api/eac-monitor/page' : webUrl).catch((err) => log('float', '浮窗加载失败: ' + ((err && err.message) || err)));";
const MAIN_LOADURL_NEW = "  win.loadURL(isMonitor ? webUrl + '/api/eac-monitor/page' : webUrl).catch((err) => log('float', '浮窗加载失败: ' + ((err && err.message) || err)));";

// ── IPC 扩展补丁(v4.4.1 的 chrome:float-window 只接受 action==='open' 且 sender
//    必须是主窗口;监控窗(浮窗内 preload)调用 setTop/closeMonitor 会被拒,
//    导致图层切换/远程关闭失效。此补丁放行浮窗 sender 并加 top/close 分支。) ──
const MAIN_IPC_MARK = "// [dsh-eac-monitor] 监控窗图层切换(top/normal)";
const MAIN_IPC_ANCHOR_SIG = "ipcMain.handle('chrome:float-window', (event, { action, sessionId } = {}) => {";
const MAIN_IPC_ANCHOR_UNAUTH = "if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };";
const MAIN_IPC_BAD_ACTION = "    if (action !== 'open') return { ok: false, error: 'bad-action' };";
const MAIN_IPC_SIG_NEW = "ipcMain.handle('chrome:float-window', (event, { action, sessionId, enabled } = {}) => {";
const MAIN_IPC_UNAUTH_NEW =
  "if (!mainWindow || (event.sender !== mainWindow.webContents && " +
  "![...floatWindows].some((w) => !w.isDestroyed() && w.webContents === event.sender))) " +
  "return { ok: false, error: 'unauthorized' };";
// 旧版 top 分支(setAlwaysOnTop 带 level 参数,功能等价但便于迁移识别)
const MAIN_IPC_BLOCK_OLD =
  "    // [dsh-eac-monitor] 监控窗图层切换(top/normal)\n" +
  "    if (action === 'top') {\n" +
  "      const win = floatBySession.get('monitor:auto');\n" +
  "      if (!win || win.isDestroyed()) return { ok: false, error: 'no-monitor' };\n" +
  "      win.setAlwaysOnTop(!!enabled, 'screen-saver');\n" +
  "      return { ok: true };\n" +
  "    }\n" +
  "    // [dsh-eac-monitor] 远程关闭监控窗(主窗开关)\n" +
  "    if (action === 'close') {\n" +
  "      const win = floatBySession.get('monitor:auto');\n" +
  "      if (win && !win.isDestroyed()) { win.close(); return { ok: true }; }\n" +
  "      return { ok: false, error: 'no-monitor' };\n" +
  "    }\n";
const MAIN_IPC_BLOCK =
  "    // [dsh-eac-monitor] 监控窗图层切换(top/normal)\n" +
  "    if (action === 'top') {\n" +
  "      const win = floatBySession.get('monitor:auto');\n" +
  "      if (!win || win.isDestroyed()) return { ok: false, error: 'no-monitor' };\n" +
  "      if (enabled) win.setAlwaysOnTop(true, 'screen-saver'); else win.setAlwaysOnTop(false);\n" +
  "      return { ok: true };\n" +
  "    }\n" +
  "    // [dsh-eac-monitor] 远程关闭监控窗(主窗开关)\n" +
  "    if (action === 'close') {\n" +
  "      const win = floatBySession.get('monitor:auto');\n" +
  "      if (win && !win.isDestroyed()) { win.close(); return { ok: true }; }\n" +
  "      return { ok: false, error: 'no-monitor' };\n" +
  "    }\n";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function locateMainJs() {
  const cands = [];
  try {
    const rs = JSON.parse(readFileSync(join(process.env.APPDATA || "", "Deepseek Harness EAC", "run-state.json"), "utf8"));
    if (rs.exe) cands.push(join(dirname(rs.exe), "resources", "app", "main.js"));
  } catch { /* noop */ }
  cands.push(join(homedir(), "AppData", "Local", "Programs", "Deepseek Harness EAC", "resources", "app", "main.js"));
  cands.push("D:\\toolresources\\Deepseek Harness EAC\\resources\\app\\main.js");
  for (const c of cands) {
    if (existsSync(c)) return c;
  }
  return null;
}

let patchStatusCache = null; // { main, preload }

// ── 语法验证:补丁/恢复写文件前必须通过 JS 编译,杜绝写坏文件导致 EAC 打不开 ──
function isValidJs(src) {
  try {
    new vm.Script(src);
    return true;
  } catch {
    return false;
  }
}

// 纯函数:对 main.js 文本应用补丁(不碰磁盘)。返回 { ok, already, text, reason }
// 每个子补丁独立幂等:文件可能只缺其中一部分(如 EAC 更新覆盖后仅 IPC 补丁缺失),
// 重复插入会导致重复声明 → 语法错误,因此逐块检查后再替换。
// v0.1.1 修复要点:
//   1) EAC main.js 是 CRLF 行尾,常量按 LF 编写 —— 先归一化再匹配,改完还原行尾;
//   2) 不再用"标记存在即已应用"短路判断(曾导致部分补丁行被回退后自愈误判成功);
//   3) 透明选项的幂等判断改为"旧行是否还在" —— 主窗口已有 isMonitor 变体行,
//      用"新行已存在"判断会被主窗口行骗过,浮窗的透明选项永远补不上;
//   4) 幂等检查逐项独立:签名/授权放行/top+close 分支各自补齐,任一缺失都修复。
function applyMainPatchTo(txt) {
  const crlf = txt.includes("\r\n");
  const normalized = crlf ? txt.replace(/\r\n/g, "\n") : txt;
  // 迁移:移除 v1/v2 旧补丁块(如存在)
  let t = normalized.replace(MAIN_OLD_BLOCK_V1, "").replace(MAIN_OLD_BLOCK_V2, "");
  // v3 重复块自愈:旧版本曾重复插入同一块(重复 setBounds/setAlwaysOnTop,
  // 无语法错误但属冗余),只保留一份
  const blockRe = new RegExp(escapeRegExp(MAIN_BLOCK_V3) + "\\n\\s*" + escapeRegExp(MAIN_BLOCK_V3), "g");
  t = t.replace(blockRe, MAIN_BLOCK_V3);
  if (!t.includes(MAIN_ANCHOR_WIN) || !t.includes(MAIN_ANCHOR_SESSION)) {
    return { ok: false, already: false, text: txt, reason: "锚点不匹配(版本变更),请手动检查" };
  }
  if (!t.includes(MAIN_BG_OLD) || !t.includes(MAIN_FRAME_OLD)) {
    return { ok: false, already: false, text: txt, reason: "窗口选项锚点不匹配(版本变更),请手动检查" };
  }
  // IPC 锚点:签名新旧两版都接受(EAC v4.4.1 官方已带 enabled 参数),其余必须存在
  if (!(t.includes(MAIN_IPC_ANCHOR_SIG) || t.includes(MAIN_IPC_SIG_NEW)) || !t.includes(MAIN_IPC_ANCHOR_UNAUTH) || !t.includes(MAIN_IPC_BAD_ACTION)) {
    return { ok: false, already: false, text: txt, reason: "IPC 锚点不匹配(版本变更),请手动检查" };
  }
  let patched = t;
  // 1) createFloatWindow 内 isMonitor 定义(幂等)
  if (!patched.includes("const isMonitor = String(sessionId || '').startsWith('monitor:');")) {
    patched = patched.replace(MAIN_ANCHOR_WIN, "  const isMonitor = String(sessionId || '').startsWith('monitor:');\n" + MAIN_ANCHOR_WIN);
  }
  // 2) 主窗口防御:兼容 EAC 自愈机制注入的同类防御(文本不同),已存在则跳过
  if (!/const isMonitor = false;[\s\S]{0,200}?mainWindow = new BrowserWindow\(\{/.test(patched)) {
    patched = patched.replace(MAIN_ANCHOR_MAIN, "  const isMonitor = false; // 主窗口非 monitor,补丁兼容\n" + MAIN_ANCHOR_MAIN);
  }
  // 3) 窗口选项:透明背景/无边框 —— 整行锚定匹配(仅 4 空格缩进的那一行)。
  //    幂等判断用"旧行是否还在":主窗口已有 isMonitor 变体行,且向导窗口的
  //    6 空格行包含 4 空格子串,子串判断会误改/误判,必须整行匹配。
  const bgOldRe = /^    backgroundColor: '#0b1220',$/m;
  const frameOldRe = /^    \.\.\.\(IS_WIN \? \{ frame: false, roundedCorners: true \} : \{\}\),$/m;
  if (bgOldRe.test(patched)) patched = patched.replace(bgOldRe, MAIN_BG_NEW);
  if (frameOldRe.test(patched)) patched = patched.replace(frameOldRe, MAIN_FRAME_NEW);
  // 4) monitor 窗口尺寸/置顶块(幂等,含重复块去重)
  if (!patched.includes(MAIN_BLOCK_V3)) {
    patched = patched.replace(MAIN_ANCHOR_SESSION, MAIN_ANCHOR_SESSION + "\n" + MAIN_BLOCK_V3);
  }
  patched = patched.replace(blockRe, MAIN_BLOCK_V3);
  // 5) 监控页 loadURL(幂等)
  if (!patched.includes(MAIN_LOADURL_NEW)) {
    patched = patched.replace(MAIN_LOADURL_V2, MAIN_LOADURL_NEW).replace(MAIN_LOADURL_ORIG, MAIN_LOADURL_NEW);
  }
  // 6) IPC 扩展:签名/放行浮窗 sender/top+close 分支 —— 逐项独立幂等,
  //    任何一项被 EAC 更新回退都会单独补齐,不再整体跳过
  if (!patched.includes(MAIN_IPC_SIG_NEW)) patched = patched.replace(MAIN_IPC_ANCHOR_SIG, MAIN_IPC_SIG_NEW);
  if (!patched.includes(MAIN_IPC_UNAUTH_NEW)) patched = patched.replace(MAIN_IPC_ANCHOR_UNAUTH, MAIN_IPC_UNAUTH_NEW);
  patched = patched.replace(MAIN_IPC_BLOCK_OLD, MAIN_IPC_BLOCK);
  if (!patched.includes(MAIN_IPC_BLOCK)) {
    patched = patched.replace(MAIN_IPC_BAD_ACTION, MAIN_IPC_BLOCK + MAIN_IPC_BAD_ACTION);
  }
  if (patched === normalized) {
    return { ok: true, already: true, text: txt };
  }
  const outText = crlf ? patched.replace(/\n/g, "\r\n") : patched;
  if (!isValidJs(outText)) {
    return { ok: false, already: false, text: txt, reason: "补丁后语法错误,已拒绝写入(防 EAC 无法启动)" };
  }
  return { ok: true, already: false, text: outText };
}

// 纯函数:对 preload.js 文本应用补丁。返回 { ok, already, text, reason }
function applyPreloadPatchTo(txt) {
  if (txt.includes(PRELOAD_MARK)) {
    return { ok: true, already: true, text: txt };
  }
  if (!txt.includes(PRELOAD_ANCHOR)) {
    return { ok: false, already: false, text: txt, reason: "preload 锚点不匹配(版本变更),请手动检查" };
  }
  const patched = txt.replace(PRELOAD_ANCHOR, PRELOAD_ANCHOR + PRELOAD_BLOCK);
  if (patched === txt) {
    return { ok: false, already: false, text: txt, reason: "preload 替换未生效" };
  }
  if (!isValidJs(patched)) {
    return { ok: false, already: false, text: txt, reason: "preload 补丁后语法错误,已拒绝写入(防 EAC 无法启动)" };
  }
  return { ok: true, already: false, text: patched };
}

async function ensureMainJsPatch() {
  if (patchStatusCache && patchStatusCache.main) return patchStatusCache.main;
  const mainJs = locateMainJs();
  if (!mainJs) {
    patchStatusCache = Object.assign({}, patchStatusCache, { main: { ok: false, path: "", reason: "main.js 未找到" } });
    return patchStatusCache.main;
  }
  let result;
  try {
    let txt = await readFile(mainJs, "utf8");
    const r = applyMainPatchTo(txt);
    if (r.ok && r.already) {
      result = { ok: true, applied: true, path: mainJs };
    } else if (!r.ok) {
      result = { ok: false, applied: false, path: mainJs, reason: r.reason };
    } else {
      backupFile(mainJs, "main.js");
      await writeFile(mainJs, r.text, "utf8");
      result = { ok: true, applied: false, path: mainJs, note: "已写入置顶透明补丁,重启 EAC 生效" };
    }
  } catch (e) {
    result = { ok: false, applied: false, path: mainJs, reason: String((e && e.message) || e) };
  }
  patchStatusCache = Object.assign({}, patchStatusCache, { main: result });
  return result;
}

// ── preload.js 补丁(图层切换/远程关闭 IPC,随更新自愈) ─────────────────────
const PRELOAD_MARK = "// [dsh-eac-monitor] 监控窗图层切换与远程关闭";
const PRELOAD_ANCHOR = "    close: () => ipcRenderer.send('float:close'),";
const PRELOAD_BLOCK =
  "\n    // [dsh-eac-monitor] 监控窗图层切换与远程关闭\n" +
  "    setTop: (enabled) => ipcRenderer.invoke('chrome:float-window', { action: 'top', enabled: !!enabled }),\n" +
  "    closeMonitor: () => ipcRenderer.invoke('chrome:float-window', { action: 'close' }),";

async function ensurePreloadPatch() {
  if (patchStatusCache && patchStatusCache.preload) return patchStatusCache.preload;
  const mainJs = locateMainJs();
  if (!mainJs) {
    patchStatusCache = Object.assign({}, patchStatusCache, { preload: { ok: false, reason: "preload.js 未找到" } });
    return patchStatusCache.preload;
  }
  const preloadJs = join(dirname(mainJs), "preload.js");
  let result;
  try {
    let txt = await readFile(preloadJs, "utf8");
    const r = applyPreloadPatchTo(txt);
    if (r.ok && r.already) {
      result = { ok: true, applied: true, path: preloadJs };
    } else if (!r.ok) {
      result = { ok: false, applied: false, path: preloadJs, reason: r.reason };
    } else {
      backupFile(preloadJs, "preload.js");
      await writeFile(preloadJs, r.text, "utf8");
      result = { ok: true, applied: false, path: preloadJs, note: "已写入 preload 补丁,重启 EAC 生效" };
    }
  } catch (e) {
    result = { ok: false, applied: false, path: preloadJs, reason: String((e && e.message) || e) };
  }
  patchStatusCache = Object.assign({}, patchStatusCache, { preload: result });
  return result;
}

async function ensurePatches() {
  const [m, p] = await Promise.all([ensureMainJsPatch(), ensurePreloadPatch()]);
  return { main: m, preload: p };
}

// ── 更新预览:对比官方仓库目标版本的补丁锚点 ───────────────────────────────
const REPO = "zouyuxuan122/Deepseek-Harness-EAC";
const PREVIEW_ANCHORS = {
  main: [
    "const win = new BrowserWindow({",
    "floatBySession.set(sessionId, win);",
    "backgroundColor: '#0b1220'",
    "...(IS_WIN ? { frame: false, roundedCorners: true }",
    "ipcMain.handle('chrome:float-window'",
    "if (action !== 'open') return { ok: false, error: 'bad-action' };",
    "event.sender !== mainWindow.webContents",
  ],
  preload: ["floatWindow: {", "close: () => ipcRenderer.send('float:close')"],
};

// v4.6 起仓库把 Electron 桌面文件从 dsh-desktop/ 移到根目录;Tauri(Lite)版本
// 的 main.js 是 Tauri 主进程,与 Electron 补丁无关。取文件按候选路径逐级回退,
// 判定构建类型后再决定是否试打 —— 避免"路径 404"被误报成"升级后需人工适配"。
const DESKTOP_FILE_CANDIDATES = {
  "main.js": ["dsh-desktop/main.js", "main.js"],
  "preload.js": ["dsh-desktop/preload.js", "preload.js"],
  "client-updater.js": ["dsh-desktop/client-updater.js", "client-updater.js"],
};

async function fetchRepoText(tag, file) {
  const cands = DESKTOP_FILE_CANDIDATES[file] || [file];
  let lastErr = "";
  for (const p of cands) {
    try {
      const r = await fetch("https://raw.githubusercontent.com/" + REPO + "/" + tag + "/" + p, {
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return { ok: true, path: p, text: await r.text() };
      lastErr = p + " HTTP " + r.status;
    } catch (e) {
      lastErr = p + " " + String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastErr };
}

// Tauri(Lite)构建识别:release 名称/正文/资产含 "tauri" 字样即视为 Tauri 版
// (发布物为 Tauri 安装包,没有 Electron 桌面壳,Electron 补丁无需应用)。
function isTauriRelease(rel) {
  try {
    const hay = [
      rel && rel.name,
      rel && rel.tag_name,
      rel && rel.body,
      ...((rel && rel.assets) || []).map((a) => a && a.name),
    ].filter(Boolean).join(" ").toLowerCase();
    return /\btauri\b/.test(hay);
  } catch {
    return false;
  }
}

async function detectBuildKind(tag) {
  try {
    const r = await fetch("https://api.github.com/repos/" + REPO + "/releases/tags/" + encodeURIComponent(tag), {
      headers: { "User-Agent": "dsh-eac-monitor" },
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) {
      const rel = await r.json();
      return isTauriRelease(rel) ? "tauri" : "electron";
    }
  } catch { /* 网络不可达:按 Electron 处理,走试打路径自行判断 */ }
  return "electron";
}

async function updatePreview() {
  const out = { ok: false, tag: "", anchors: [], verdict: "", ts: Date.now() };
  try {
    // 目标版本:pendingClientVersion 优先,否则 GitHub latest
    let tag = "";
    try {
      const s = JSON.parse(readFileSync(join(process.env.APPDATA || "", "Deepseek Harness EAC", "settings.json"), "utf8"));
      if (s.pendingClientVersion) tag = "v" + String(s.pendingClientVersion);
    } catch { /* noop */ }
    if (!tag) {
      const rel = await (await fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
        headers: { "User-Agent": "dsh-eac-monitor" },
        signal: AbortSignal.timeout(12000),
      })).json();
      tag = rel.tag_name || "";
    }
    out.tag = tag;
    if (!tag) { out.verdict = "无法确定目标版本(GitHub 不可达?)"; return out; }
    // Tauri(Lite)构建:没有 Electron 桌面壳,Electron 补丁无需应用也不会被破坏
    if (await detectBuildKind(tag) === "tauri") {
      out.ok = true;
      out.verdict = "目标版本 " + tag + " 为 Tauri(Lite)构建:发布物是 Tauri 安装包,不含 Electron 桌面壳,Electron 补丁(main.js/preload.js)无需应用、也不会被破坏;当前 Electron 版 EAC 不受此版本影响 ✅";
      return out;
    }
    const mainF = await fetchRepoText(tag, "main.js");
    if (!mainF.ok) throw new Error("main.js 获取失败: " + mainF.error);
    const checks = [];
    const mainTxt = mainF.text;
    for (const a of PREVIEW_ANCHORS.main) checks.push({ file: "main.js", path: mainF.path, anchor: a, ok: mainTxt.includes(a) });
    const preF = await fetchRepoText(tag, "preload.js");
    if (!preF.ok) throw new Error("preload.js 获取失败: " + preF.error);
    const preTxt = preF.text;
    for (const a of PREVIEW_ANCHORS.preload) checks.push({ file: "preload.js", path: preF.path, anchor: a, ok: preTxt.includes(a) });
    const cuF = await fetchRepoText(tag, "client-updater.js");
    if (cuF.ok) checks.push({ file: "client-updater.js", path: cuF.path, anchor: "无 tasklist|find 管道", ok: !/tasklist[^\r\n]*\|[^\r\n]*find/i.test(cuF.text) });
    out.anchors = checks;
    const failed = checks.filter((c) => !c.ok);
    // 试打验证:真实补丁逻辑在内存副本上跑一遍(含语法验证),这是最有说服力的提前评估
    const dry = dryRunTexts(tag, mainTxt, preTxt);
    out.dryRun = dry;
    const dryOk = dry.main.ok && dry.preload.ok;
    if (dryOk) {
      out.ok = failed.length === 0;
      out.verdict = "目标版本 " + tag + " 试打验证通过:补丁(置顶透明窗/IPC)可自动重打,升级不会引发致命错误 ✅" +
        (failed.length ? " (锚点明细有 " + failed.length + " 项差异,但不影响补丁逻辑)" : "");
    } else {
      out.ok = false;
      out.verdict = "目标版本 " + tag + " 试打验证未通过: " +
        (dry.main.reason || "main 未知") + " / " + (dry.preload.reason || "preload 未知") +
        " ⚠️ 升级后补丁无法自动重打,需人工适配(升级前备份已自动保留)";
    }
    return out;
  } catch (e) {
    out.verdict = "预览失败: " + String((e && e.message) || e) + " (可能网络不可达,降级为本地自愈保障)";
    return out;
  }
}

function httpUpdatePreview(_req, res) {
  updatePreview().then(
    (r) => writeJson(res, r),
    (e) => writeJson(res, { ok: false, verdict: String((e && e.message) || e) })
  );
}

// 备份补丁目标文件(更新前留底;恢复用)
const PATCH_DIR = join(HOME, "storages", "eac-monitor-patches");
function backupFile(file, label) {
  try {
    mkdirSync(PATCH_DIR, { recursive: true });
    const name = label.replace(/\.js$/, "") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".js";
    writeFileSync(join(PATCH_DIR, name), readFileSync(file, "utf8"), "utf8");
    return name;
  } catch (e) {
    return "";
  }
}

// 备份列表(新→旧)
function listBackups() {
  try {
    return readdirSync(PATCH_DIR)
      .filter((f) => /^(main|preload)-[\w\-]+\.js$/.test(f))
      .map((f) => {
        const st = statSync(join(PATCH_DIR, f));
        return { file: f, mtimeMs: st.mtimeMs, size: st.size, kind: f.startsWith("main-") ? "main.js" : "preload.js" };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

// 一键恢复:从备份写回 main.js/preload.js(恢复前再备份当前,写前语法验证)
async function restoreBackup(file) {
  if (!/^(main|preload)-[\w\-]+\.js$/.test(file)) return { ok: false, error: "非法备份文件名" };
  const src = join(PATCH_DIR, file);
  if (!existsSync(src)) return { ok: false, error: "备份不存在: " + file };
  const mainJs = locateMainJs();
  if (!mainJs) return { ok: false, error: "未找到 EAC main.js" };
  const target = file.startsWith("main-") ? mainJs : join(dirname(mainJs), "preload.js");
  let txt;
  try { txt = readFileSync(src, "utf8"); } catch (e) { return { ok: false, error: "备份读取失败: " + String((e && e.message) || e) }; }
  if (!isValidJs(txt)) return { ok: false, error: "备份文件语法错误,拒绝恢复(防 EAC 无法启动)" };
  try {
    const cur = await readFile(target, "utf8");
    if (cur === txt) return { ok: true, target, file, note: "目标文件与备份一致,无需恢复" };
    backupFile(target, target.endsWith("main.js") ? "main.js" : "preload.js");
    await writeFile(target, txt, "utf8");
  } catch (e) {
    return { ok: false, error: "恢复写入失败: " + String((e && e.message) || e) };
  }
  patchStatusCache = null; // 强制下次重查
  logUpdate("[恢复] 已从备份恢复 " + file + " → " + target);
  return { ok: true, target, file, note: "已恢复,重启 EAC 生效" };
}

// ── 更新公告主动监测 ─────────────────────────────────────────────────────────
// 状态持久化:storages/eac-monitor-update.json
//   { lastKnownTag, lastCheck, announcements: [{ts, tag, name, publishedAt, body, dryRun, dryErr, verdict}] }
const UPD_STATE_FILE = join(HOME, "storages", "eac-monitor-update.json");
const UPD_LOG = join(process.env.APPDATA || "", "Deepseek Harness EAC", "logs", "eac-update-watch.log");

function logUpdate(m) {
  try {
    appendFileSync(UPD_LOG, "[" + new Date().toISOString() + "] " + m + "\n");
  } catch { /* 日志失败忽略 */ }
}

function readUpdState() {
  try {
    return JSON.parse(readFileSync(UPD_STATE_FILE, "utf8"));
  } catch {
    return { lastKnownTag: "", lastCheck: 0, announcements: [] };
  }
}

function writeUpdState(st) {
  try { writeFileSync(UPD_STATE_FILE, JSON.stringify(st, null, 2), "utf8"); } catch { /* 持久化失败忽略 */ }
}

let updState = null;
let announcementBusy = false;

// 对话通知队列(client 端轮询后发送到当前会话;每条带 id,送达后逐条确认,
// 避免"发送成功但确认丢失/页面重载"导致同一条公告反复投递)
let chatNotices = [];
let noticeSeq = 0;
function notifyChat(msg) {
  chatNotices.push({ id: "n" + Date.now() + "-" + (++noticeSeq), ts: Date.now(), msg });
  logUpdate("[通知] " + msg.slice(0, 200));
}

async function fetchLatestRelease() {
  const r = await fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
    headers: { "User-Agent": "dsh-eac-monitor" },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("GitHub API HTTP " + r.status);
  return await r.json();
}

// 试打补丁(内存副本):输入新版本文件文本,跑补丁逻辑 + 语法验证
// —— 这就是"提前评估":升级发生前就能确认补丁能否自动重打,不用等安装器覆盖文件。
function dryRunTexts(tag, mainTxt, preTxt) {
  const m = applyMainPatchTo(mainTxt);
  const p = applyPreloadPatchTo(preTxt);
  return {
    tag,
    main: { ok: m.ok, already: m.already || false, reason: m.reason || "", size: mainTxt.length },
    preload: { ok: p.ok, already: p.already || false, reason: p.reason || "", size: preTxt.length },
  };
}

async function dryRunForTag(tag) {
  // 路径逐级回退:dsh-desktop/ → 根目录(v4.6 起仓库结构变化)
  const [m, p] = await Promise.all([fetchRepoText(tag, "main.js"), fetchRepoText(tag, "preload.js")]);
  if (!m.ok) throw new Error("main.js 获取失败: " + m.error);
  if (!p.ok) throw new Error("preload.js 获取失败: " + p.error);
  return dryRunTexts(tag, m.text, p.text);
}

// 主动轮询官方更新公告(GitHub releases = 官方发布渠道)。新版本出现时:
//   1) 自动备份当前 main.js/preload.js(升级前留底)
//   2) 试打验证 → 评估"升级后补丁能否自动重打"
//   3) 结果持久化 + 通知对话
async function checkAnnouncements() {
  if (announcementBusy) return { ok: true, note: "检查进行中" };
  announcementBusy = true;
  try {
    const rel = await fetchLatestRelease();
    const tag = String(rel.tag_name || "").trim();
    if (!tag) throw new Error("release 无 tag_name");
    const st = updState || readUpdState();
    if (tag === st.lastKnownTag) {
      st.lastCheck = Date.now();
      writeUpdState(st);
      updState = st;
      return { ok: true, tag, fresh: false };
    }
    // 首次运行:只记录基线,不误报"新公告"
    if (!st.lastKnownTag) {
      st.lastKnownTag = tag;
      st.lastCheck = Date.now();
      writeUpdState(st);
      updState = st;
      logUpdate("首次监测,基线版本 " + tag + " (不触发通知)");
      return { ok: true, tag, fresh: false, note: "首次基线" };
    }
    logUpdate("检测到新版本公告: " + tag + " (" + (rel.name || "") + ") 发布于 " + (rel.published_at || "?"));
    // ① 提前备份当前补丁目标(升级前留底)
    const mainJs = locateMainJs();
    if (mainJs) {
      const bn = backupFile(mainJs, "main.js");
      const bn2 = backupFile(join(dirname(mainJs), "preload.js"), "preload.js");
      logUpdate("已自动备份升级前文件: " + bn + (bn2 ? ", " + bn2 : ""));
    }
    // ② 试打验证(提前评估补丁影响);Tauri(Lite)构建没有 Electron 桌面壳,跳过试打
    let dry = null;
    let dryErr = "";
    let tauri = false;
    try { tauri = await detectBuildKind(tag); } catch { /* 保持 false */ }
    if (tauri) {
      logUpdate("试打验证 " + tag + ": Tauri(Lite)构建,无 Electron 桌面壳,跳过试打");
    } else {
      try {
        dry = await dryRunForTag(tag);
        logUpdate("试打验证 " + tag + ": main=" + (dry.main.ok ? "可自动重打✅" : "失败:" + dry.main.reason) +
          ", preload=" + (dry.preload.ok ? "可自动重打✅" : "失败:" + dry.preload.reason));
      } catch (e) {
        dryErr = String((e && e.message) || e);
        logUpdate("试打验证失败(网络不可达?): " + dryErr);
      }
    }
    const dryOk = tauri || (dry && dry.main.ok && dry.preload.ok);
    const notice = {
      ts: Date.now(),
      tag,
      name: String(rel.name || ""),
      publishedAt: String(rel.published_at || ""),
      body: String(rel.body || "").slice(0, 600),
      dryRun: dry,
      dryErr: tauri ? "" : dryErr,
      verdict: tauri
        ? "新版本 " + tag + " 为 Tauri(Lite)构建:发布物不含 Electron 桌面壳,Electron 补丁无需应用、也不会被破坏,当前 Electron 版 EAC 不受影响 ✅"
        : dryOk
          ? "新版本 " + tag + " 补丁试打验证通过:升级后 main.js/preload.js 补丁可自动重打,无兼容性风险 ✅"
          : "新版本 " + tag + " 补丁试打验证未通过: " +
            (dryErr ? "(网络错误 " + dryErr + ",已保留升级前备份)" : (dry ? dry.main.reason + " / " + dry.preload.reason : "")) +
            " ⚠️ 升级后需人工适配,升级前备份已保留",
    };
    st.lastKnownTag = tag;
    st.lastCheck = Date.now();
    st.announcements = [notice].concat(st.announcements || []).slice(0, 10);
    writeUpdState(st);
    updState = st;
    notifyChat("📢 EAC 官方更新公告: 新版本 " + tag + "(" + notice.name + ")\n" + notice.verdict +
      (notice.body ? "\n公告摘录: " + notice.body.slice(0, 160) : ""));
    return { ok: true, tag, fresh: true };
  } catch (e) {
    logUpdate("公告检查失败: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    announcementBusy = false;
  }
}

// 补丁完整性定时检查:main.js/preload.js 被 EAC 更新覆盖(热更新/重装)后自动重打
async function patchIntegrityCheck() {
  try {
    patchStatusCache = null; // 强制重新校验
    const [m, p] = await Promise.all([ensureMainJsPatch(), ensurePreloadPatch()]);
    // 注意:ensureMainJsPatch 的 applied:true = "补丁已在位(无需写)";
    // 真正发生"缺失→重打"是 applied:false 且带 note。旧条件写反,
    // 每 5 分钟误报"缺失已重打",实际从未重复写盘。
    if (m && !m.applied && m.note) logUpdate("完整性检查:main.js 补丁缺失,已自动重打");
    if (p && !p.applied && p.note) logUpdate("完整性检查:preload.js 补丁缺失,已自动重打");
    return { main: m, preload: p };
  } catch (e) {
    logUpdate("完整性检查失败: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 本地当前版本(EAC 安装目录 package.json)
function currentLocalVersion() {
  try {
    const mainJs = locateMainJs();
    if (!mainJs) return "";
    const pkg = JSON.parse(readFileSync(join(dirname(mainJs), "package.json"), "utf8"));
    return pkg.version || "";
  } catch {
    return "";
  }
}

// HTTP:更新监测状态(公告 + 备份 + 补丁状态 + 本地版本)
function httpUpdateStatus(_req, res) {
  const st = updState || readUpdState();
  writeJson(res, {
    ok: true,
    ts: Date.now(),
    localVersion: currentLocalVersion(),
    latestTag: st.lastKnownTag,
    lastCheck: st.lastCheck,
    announcements: st.announcements || [],
    backups: listBackups(),
    patch: patchStatusCache,
  });
}

function httpBackups(_req, res) {
  writeJson(res, { ok: true, backups: listBackups() });
}

function httpRestoreBackup(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += String(chunk); });
  req.on("end", () => {
    try {
      const j = JSON.parse(body || "{}");
      restoreBackup(String(j.file || "")).then(
        (r) => writeJson(res, r),
        (e) => writeJson(res, { ok: false, error: String((e && e.message) || e) })
      );
    } catch (e) {
      writeJson(res, { ok: false, error: String((e && e.message) || e) });
    }
  });
  req.on("error", () => writeJson(res, { ok: false, error: "body error" }));
}

// 对话通知队列:GET 拉取,POST 逐条确认(delivered:[id])或整体清空(clear:true)
function httpNotifyPending(req, res) {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        if (j && j.clear) {
          chatNotices = [];
        } else if (j && Array.isArray(j.delivered) && j.delivered.length) {
          const delivered = new Set(j.delivered);
          chatNotices = chatNotices.filter((n) => !delivered.has(n.id));
        }
      } catch { /* noop */ }
      writeJson(res, { ok: true, pending: false });
    });
    req.on("error", () => writeJson(res, { ok: true, pending: false }));
    return;
  }
  const now = Date.now();
  const fresh = chatNotices.filter((n) => now - n.ts < 30 * 60 * 1000); // 30 分钟内有效
  writeJson(res, { ok: true, pending: fresh.length > 0, notices: fresh });
}

// watchdog 报告更新包下载完成 → 触发公告核查 + 通知
function httpUpdateDownloaded(_req, res) {
  logUpdate("watchdog 报告:新更新包已下载到 updates 目录");
  checkAnnouncements().then(
    (r) => writeJson(res, r),
    (e) => writeJson(res, { ok: false, error: String((e && e.message) || e) })
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── typert remote 模板(与 dsh-easy-setup 相同模式) ────────────────────────
const looseCodec = () => ({
  mode: "strict",
  typeSymbol: "dsh-eac-monitor/types#Json",
  schema: { parse: (value) => value },
});
const descriptor = (method, parameters) => ({
  id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/${method}`,
  service: REMOTE_SERVICE,
  namespace: REMOTE_SERVICE,
  method,
  invocation: { kind: "direct" },
  parameters: parameters.map((pn) => ({ name: pn, wire: pn, source: "json", codec: looseCodec() })),
  result: looseCodec(),
});
const REMOTE_INVOCATIONS = [
  descriptor("getSnapshot", []),
  descriptor("attachEdge", []),
  descriptor("openUsagePage", []),
  descriptor("getPatchStatus", []),
];

// ── 采集状态 ────────────────────────────────────────────────────────────────
const state = {
  edge: { status: "disconnected", detail: "未连接", hint: "" },
  balance: { status: "idle" },
  usage: { status: "idle" },
  keys: { status: "idle" }, // 按 API Key 分组的今日用量明细
  storage: { status: "idle" },
  history: [],
  lastCollect: 0,
  collecting: null,
};

// 按 API Key 分组的今日用量(最近一次成功抓取;失败时保留上次数值,避免视图闪空)
let usageKeys = [];

let apiKeyCache = null;

// ── 余额:官方 API(API Key) ─────────────────────────────────────────────────
function readApiKey() {
  if (apiKeyCache !== null) return apiKeyCache;
  try {
    const txt = readFileSync(join(HOME, ".credentials.yaml"), "utf8");
    const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*[:=]\s*["']?([A-Za-z0-9._\-]+)/m);
    apiKeyCache = m ? m[1] : "";
  } catch {
    apiKeyCache = "";
  }
  return apiKeyCache;
}

async function collectBalance() {
  const key = readApiKey();
  if (!key) {
    state.balance = { status: "no-key", detail: "未找到 DEEPSEEK_API_KEY", at: Date.now() };
    return state.balance;
  }
  try {
    const r = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      state.balance = { status: "http-" + r.status, detail: `余额接口 HTTP ${r.status}`, at: Date.now() };
      return state.balance;
    }
    const j = await r.json();
    const bi = (j.balance_infos || [])[0] || {};
    state.balance = {
      status: "ok",
      isAvailable: !!j.is_available,
      currency: bi.currency || "USD",
      total: bi.total_balance != null ? Number(bi.total_balance) : null,
      granted: bi.granted_balance != null ? Number(bi.granted_balance) : null,
      toppedUp: bi.topped_up_balance != null ? Number(bi.topped_up_balance) : null,
      at: Date.now(),
    };
  } catch (e) {
    state.balance = { status: "error", detail: "余额接口请求失败: " + String((e && e.message) || e), at: Date.now() };
  }
  return state.balance;
}

// ── Edge CDP:平台用量 ───────────────────────────────────────────────────────
async function cdpHttp(path, opts) {
  const r = await fetch(cdpBase() + path, Object.assign({ signal: AbortSignal.timeout(4000) }, opts));
  if (!r.ok) throw new Error("cdp http " + r.status);
  return r.json();
}

async function cdpAlive() {
  try {
    const v = await cdpHttp("/json/version");
    return !!(v && v["Browser"]);
  } catch {
    return false;
  }
}

async function ensureUsagePage() {
  const list = await cdpHttp("/json/list");
  let target = (list || []).find((t) => t.type === "page" && t.url && t.url.includes("platform.deepseek.com"));
  if (!target) {
    // /json/new 返回的页面常停在 about:blank,真正的导航由 cdpEval 里的 Page.navigate 完成
    target = await cdpHttp("/json/new?" + new URLSearchParams({ url: "https://platform.deepseek.com/usage" }).toString(), { method: "PUT" });
  }
  return target;
}

let cdpWs = null;
let cdpPageId = null;
let cdpSeq = 0;
const cdpPending = new Map();

async function cdpSend(method, params, timeoutMs = 20_000) {
  if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) throw new Error("cdp ws 未连接");
  const id = ++cdpSeq;
  return new Promise((res, rej) => {
    cdpPending.set(id, { res, rej });
    cdpWs.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (cdpPending.has(id)) {
        cdpPending.delete(id);
        rej(new Error("cdp timeout: " + method));
      }
    }, timeoutMs);
  });
}

async function cdpEval(expression, timeoutMs = 20_000) {
  const page = await ensureUsagePage();
  if (!cdpWs || cdpPageId !== page.id || cdpWs.readyState !== WebSocket.OPEN) {
    if (cdpWs) {
      try { cdpWs.close(); } catch { /* noop */ }
    }
    cdpWs = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${page.id}`);
    await new Promise((res, rej) => {
      cdpWs.once("open", res);
      cdpWs.once("error", rej);
    });
    cdpPageId = page.id;
    cdpWs.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      if (msg && msg.id && cdpPending.has(msg.id)) {
        const { res, rej } = cdpPending.get(msg.id);
        cdpPending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || "cdp error"));
        else res(msg.result);
      }
    });
  }
  // 确保页面真的停在 platform.deepseek.com(新建页常为 about:blank,需显式导航)
  let href = null;
  try {
    const r = await cdpSend("Runtime.evaluate", { expression: "location.href", returnByValue: true }, 5000);
    href = r && r.result ? r.result.value : null;
  } catch { /* 页面未就绪 */ }
  if (!href || !href.includes("platform.deepseek.com")) {
    await cdpSend("Page.navigate", { url: "https://platform.deepseek.com/usage" }, 10_000).catch(() => { /* 导航失败 */ });
    for (let i = 0; i < 10; i += 1) {
      await sleep(1000);
      try {
        const r2 = await cdpSend("Runtime.evaluate", { expression: "location.href", returnByValue: true }, 4000);
        const h2 = r2 && r2.result ? r2.result.value : null;
        if (h2 && h2.includes("platform.deepseek.com")) break;
      } catch { /* 页面仍在加载 */ }
    }
  }
  try {
    const r = await cdpSend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    return r && r.result ? r.result.value : null;
  } catch (e) {
    // 连接可能已损坏:丢弃,下次重建
    try { cdpWs && cdpWs.close(); } catch { /* noop */ }
    cdpWs = null;
    throw e;
  }
}

/**
 * 平台数据抓取(2026-08 实测版):
 *   鉴权 = localStorage.userToken → Authorization: Bearer <token>
 *   余额 = GET /api/v0/users/get_user_summary
 *   Token = GET /api/v0/usage/by_api_key/amount?start&end&tz (整点对齐)
 *   费用 = GET /api/v0/usage/by_api_key/cost?start&end&tz
 * 三个请求并行,约 0.3 秒完成。
 */
const PLATFORM_BASE = "https://platform.deepseek.com";

async function probeViaToken() {
  // 1) CDP 读 userToken(platform 页面 localStorage)
  const tokRaw = await cdpEval(
    `(function(){ try { var v = JSON.parse(localStorage.getItem('userToken') || '{}'); return v.value || ''; } catch (e) { return ''; } })()`,
    8000
  );
  const token = String(tokRaw || "").trim();
  const out = { loggedIn: null, balance: null, usage: null, usageUrl: "", errors: [] };
  if (!token) {
    out.loggedIn = false;
    out.errors.push("localStorage 无 userToken");
    return out;
  }
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  const j = async (u) => {
    try {
      const resp = await fetch(u, { headers, signal: AbortSignal.timeout(8000) });
      const text = await resp.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch (e) {
      out.errors.push(u + " -> " + String((e && e.message) || e));
      return null;
    }
  };
  // 2) 今日窗口(tz=东八区):start = GMT+8 今日 00:00(UTC epoch),
  //    end = 下一整点(服务端只收整点 end;用下一整点可让当前未完成小时桶一并返回,
  //    与平台页"今天"数字一致,平台页另有约 5 分钟数据延迟)。
  //    本地零点的 UTC epoch = floor((nowS+TZ)/86400)*86400-TZ;
  //    旧公式 (nowS-TZ)/86400*86400+TZ 会算成前一天 16:00,把昨天傍晚用量并入"今日"。
  const TZ = 28800;
  const nowS = Math.floor(Date.now() / 1000);
  const start = Math.floor((nowS + TZ) / 86400) * 86400 - TZ;
  const end = nowS - (nowS % 3600) + 3600;
  const base = PLATFORM_BASE + "/api/v0/usage/by_api_key/";
  const q = "?start=" + start + "&end=" + end + "&tz=" + TZ;
  // 3) 并行抓取
  const [summary, amountJson, costJson] = await Promise.all([
    j(PLATFORM_BASE + "/api/v0/users/get_user_summary"),
    j(base + "amount" + q),
    j(base + "cost" + q),
  ]);
  // 4) 登录判定
  const missingToken = (summary && (summary.code === 40002 || summary.code === 40001));
  if (missingToken || !summary || summary.code !== 0) {
    out.loggedIn = false;
    out.errors.push(
      "summary=" + (summary ? JSON.stringify(summary).slice(0, 160) : "null") +
      " tokenLen=" + token.length +
      " (errors: " + (out.errors.join(";") || "无") + ")"
    );
    return out;
  }
  out.loggedIn = true;
  // 5) 余额:normal_wallets + bonus_wallets,total_costs 累计
  const bd = summary.data && summary.data.biz_data;
  if (bd) {
    const norm = bd.normal_wallets || [];
    const bonus = bd.bonus_wallets || [];
    const costs = bd.total_costs || [];
    const currency = (norm[0] && norm[0].currency) || (bonus[0] && bonus[0].currency) || (costs[0] && costs[0].currency) || "CNY";
    const bonusSum = bonus.reduce((s, w) => s + Number(w.balance || 0), 0);
    const normSum = norm.reduce((s, w) => s + Number(w.balance || 0), 0);
    out.balance = {
      currency,
      total: normSum + bonusSum,
      granted: bonusSum,
      toppedUp: normSum,
      totalCost: costs.reduce((s, w) => s + Number(w.amount || 0), 0),
    };
  }
  // 6) Token 聚合(amount)+ 费用(cost)
  const agg = { in: 0, out: 0, cache: 0, requests: 0, cost: 0, hasCost: false, start, end };
  if (amountJson && amountJson.code === 0 && amountJson.data && amountJson.data.biz_data && amountJson.data.biz_data.series) {
    for (const s of amountJson.data.biz_data.series) {
      for (const b of s.buckets || []) {
        const u = b.usage || {};
        agg.in += Number(u.PROMPT_CACHE_MISS_TOKEN || 0) || 0;
        agg.cache += Number(u.PROMPT_CACHE_HIT_TOKEN || 0) || 0;
        agg.out += Number(u.RESPONSE_TOKEN || 0) || 0;
        agg.requests += Number(u.REQUEST || 0) || 0;
      }
    }
  }
  if (costJson && costJson.code === 0 && costJson.data && costJson.data.biz_data && costJson.data.biz_data.data) {
    for (const c of costJson.data.biz_data.data) {
      for (const s of c.series || []) {
        for (const b of s.buckets || []) {
          const cv = Number(b.cost || 0) || 0;
          agg.cost += cv;
          agg.hasCost = true; // 今天结构正常(哪怕均为 0)即显示 ¥0.00,而非 "—"
        }
      }
    }
  }
  out.usage = {
    tokensIn: agg.in,
    tokensOut: agg.out,
    tokensCache: agg.cache,
    requests: agg.requests,
    cost: agg.hasCost ? agg.cost : null,
    currency: (out.balance && out.balance.currency) || "CNY",
  };
  // 6b) 按 API Key 分组(视图用):不再把各 key 的 series 加总成一个总数
  //     分组键 = name || sensitive_id || tracking_id —— key 重命名会另开一项(可接受)
  //     colorIndex:按最终展示顺序(用量降序)分配,保证视图里第一行就是调色板首色;
  //     一旦分配过就固定下来,某个 key 停用后其余 key 颜色不会整体前移。
  const keyMap = new Map();
  const keyOf = (apiKey) => {
    const k = apiKey || {};
    return k.name || k.sensitive_id || k.tracking_id || "(未命名)";
  };
  const keyEntry = (apiKey) => {
    const k = apiKey || {};
    const id = keyOf(k);
    let e = keyMap.get(id);
    if (!e) {
      e = { name: id, masked: k.sensitive_id || "", trackingId: k.tracking_id || "", valid: k.valid !== false, models: [], tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensTotal: 0, requests: 0, cost: 0, hasCost: false };
      keyMap.set(id, e);
    }
    if (k.sensitive_id) e.masked = k.sensitive_id;
    return e;
  };
  if (amountJson && amountJson.code === 0 && amountJson.data && amountJson.data.biz_data && amountJson.data.biz_data.series) {
    for (const s of amountJson.data.biz_data.series) {
      const e = keyEntry(s.api_key);
      if (s.model && e.models.indexOf(s.model) === -1) e.models.push(s.model);
      for (const b of s.buckets || []) {
        const u = b.usage || {};
        e.tokensIn += Number(u.PROMPT_CACHE_MISS_TOKEN || 0) || 0;
        e.tokensCache += Number(u.PROMPT_CACHE_HIT_TOKEN || 0) || 0;
        e.tokensOut += Number(u.RESPONSE_TOKEN || 0) || 0;
        e.requests += Number(u.REQUEST || 0) || 0;
      }
    }
  }
  if (costJson && costJson.code === 0 && costJson.data && costJson.data.biz_data && Array.isArray(costJson.data.biz_data.data)) {
    for (const c of costJson.data.biz_data.data) {
      for (const s of c.series || []) {
        const e = keyEntry(s.api_key);
        for (const b of s.buckets || []) {
          const cv = Number(b.cost || 0) || 0;
          e.cost += cv;
          if (cv || b.cost != null) e.hasCost = true; // 结构正常即显示 ¥0.00
        }
      }
    }
  }
  const keys = Array.from(keyMap.values()).map((e) => {
    e.tokensTotal = e.tokensIn + e.tokensOut + e.tokensCache;
    e.cost = e.hasCost ? Number(e.cost.toFixed(4)) : null;
    return e;
  }).sort((a, b) => (b.tokensTotal - a.tokensTotal) || String(a.name).localeCompare(String(b.name)));
  // 按展示顺序分配配色序号(首次分配即固定)
  keys.forEach((e, i) => {
    if (!keyOrder.has(e.name)) { keyOrder.set(e.name, i); keyOrderNext = Math.max(keyOrderNext, i + 1); }
    e.colorIndex = keyOrder.get(e.name);
  });
  usageKeys = keys;
  out.keys = keys;
  out.usageUrl = base + "amount" + q;
  return out;
}

async function collectUsage() {
  if (state.edge.status !== "connected") {
    state.usage = { status: "no-edge", detail: "Edge 未连接", at: Date.now() };
    return state.usage;
  }
  // TTL:成功后 60 秒内不重抓(减轻平台压力、提速)
  if (state.usage && state.usage.status === "ok" && Date.now() - (state.usage.at || 0) < TTL_USAGE) {
    return state.usage;
  }
  try {
    // 时间盒:抓取最多 15 秒,防止阻塞数据端点
    const raw = await Promise.race([
      probeViaToken(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("平台抓取超时")), 15_000)),
    ]);
    if (!raw.loggedIn) {
      const why = (raw.errors || []).join("; ");
      state.usage = {
        status: "need-login",
        detail: "DeepSeek 平台未登录:请在 Edge 窗口中登录 platform.deepseek.com,登录后自动恢复监控" + (why ? " [" + why + "]" : ""),
        at: Date.now(),
      };
      return state.usage;
    }
    state.usage = {
      status: "ok",
      tokensIn: raw.usage.tokensIn,
      tokensOut: raw.usage.tokensOut,
      tokensCache: raw.usage.tokensCache,
      requests: raw.usage.requests,
      cost: raw.usage.cost,
      currency: raw.usage.currency,
      date: "",
      at: Date.now(),
    };
    // 按 API Key 分组的明细(今日窗口) → 供「各 Key 用量」视图使用
    try {
      usageKeys = Array.isArray(raw.keys) ? raw.keys : [];
      state.keys = { status: "ok", list: usageKeys, currency: raw.usage.currency, at: Date.now() };
    } catch { /* 明细失败不影响总数 */ }
    // 平台 summary 余额(更权威,覆盖 API key 通道)
    if (raw.balance) {
      state.balance = {
        status: "ok",
        isAvailable: true,
        currency: raw.balance.currency,
        total: raw.balance.total,
        granted: raw.balance.granted,
        toppedUp: raw.balance.toppedUp,
        totalCost: raw.balance.totalCost,
        at: Date.now(),
      };
    }
  } catch (e) {
    state.usage = { status: "error", detail: "平台抓取失败: " + String((e && e.message) || e), at: Date.now() };
    // CDP 断了 → 降级
    try { cdpWs && cdpWs.close(); } catch { /* noop */ }
    cdpWs = null;
    if (!(await cdpAlive())) state.edge.status = "disconnected";
  }
  return state.usage;
}

// ── 存储统计 ────────────────────────────────────────────────────────────────
const WALK_CONC = 16;

async function walkSize(root) {
  let bytes = 0;
  let files = 0;
  const parts = new Map();
  let running = 0;
  const queue = [];
  let settled = false;
  return new Promise((resolve) => {
    const finish = () => {
      if (!settled && running === 0 && queue.length === 0) {
        settled = true;
        resolve({ bytes, files, parts });
      }
    };
    const pump = () => {
      while (running < WALK_CONC && queue.length) {
        const task = queue.shift();
        running += 1;
        task().then(
          () => { running -= 1; pump(); },
          () => { running -= 1; pump(); }
        );
      }
      finish();
    };
    const pushDir = (dir, top) => {
      queue.push(async () => {
        let entries;
        try { entries = await opendir(dir); } catch { return; }
        const subs = [];
        for await (const ent of entries) {
          // junction / 符号链接:跳过,防止循环引用与重复统计
          if (ent.isSymbolicLink()) continue;
          const p = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (ent.name !== "node_modules") subs.push(p);
          } else if (ent.isFile()) {
            let s;
            try { s = await stat(p); } catch { continue; }
            bytes += s.size;
            files += 1;
            const key = top || "(files)";
            parts.set(key, (parts.get(key) || 0) + s.size);
          }
        }
        for (const s of subs) pushDir(s, top || basename(s));
      });
    };
    pushDir(root, null);
    pump();
  });
}

function readWorkspaces() {
  try {
    const j = JSON.parse(readFileSync(join(HOME, "storages", "workspace.json"), "utf8"));
    const ws = (j.tables && j.tables.workspaces) || {};
    return Object.values(ws).map((w) => ({ title: w.title || basename(w.path || ""), path: w.path || "" }));
  } catch {
    return [];
  }
}

async function findCurrentSession() {
  const sessionsRoot = join(HOME, "sessions");
  let best = null;
  let total = 0;
  let count = 0;
  try {
    const wsDirs = await opendir(sessionsRoot);
    for await (const wd of wsDirs) {
      if (!wd.isDirectory()) continue;
      const wsPath = join(sessionsRoot, wd.name);
      let sdirs;
      try { sdirs = await opendir(wsPath); } catch { continue; }
      for await (const sd of sdirs) {
        if (!sd.isDirectory()) continue;
        const f = join(wsPath, sd.name, "session.jsonl.zstd");
        try {
          const st = await stat(f);
          total += st.size;
          count += 1;
          if (!best || st.mtimeMs > best.mtimeMs) {
            best = { path: f, bytes: st.size, mtimeMs: st.mtimeMs, sessionId: sd.name };
          }
        } catch { /* 无会话文件 */ }
      }
    }
  } catch { /* sessions 目录不存在 */ }
  return { current: best, sessionsTotal: total, sessionCount: count };
}

async function collectStorage() {
  const [eac, dsh] = await Promise.all([
    walkSize(EAC_ROOT).catch(() => ({ bytes: 0, files: 0, parts: new Map() })),
    walkSize(HOME).catch(() => ({ bytes: 0, files: 0, parts: new Map() })),
  ]);
  const workspaces = readWorkspaces();
  const wsSizes = [];
  let wsTotal = 0;
  await Promise.all(
    workspaces.map(async (w) => {
      if (!w.path || !existsSync(w.path)) {
        wsSizes.push({ title: w.title, path: w.path, bytes: 0, missing: true });
        return;
      }
      const s = await walkSize(w.path).catch(() => ({ bytes: 0 }));
      wsSizes.push({ title: w.title, path: w.path, bytes: s.bytes });
      wsTotal += s.bytes;
    })
  );
  const ses = await findCurrentSession().catch(() => ({ current: null, sessionsTotal: 0, sessionCount: 0 }));
  const partObj = (m) => {
    const out = {};
    for (const [k, v] of m) out[k] = v;
    return out;
  };
  state.storage = {
    status: "ok",
    at: Date.now(),
    eac: { bytes: eac.bytes, files: eac.files, parts: partObj(eac.parts), note: "已跳过 node_modules" },
    dsh: { bytes: dsh.bytes, files: dsh.files, parts: partObj(dsh.parts), note: "已跳过 node_modules" },
    workspaces: wsSizes,
    wsTotal,
    currentSession: ses.current
      ? { sessionId: ses.current.sessionId, bytes: ses.current.bytes, mtimeMs: ses.current.mtimeMs }
      : null,
    sessionsTotal: ses.sessionsTotal,
    sessionCount: ses.sessionCount,
  };
  return state.storage;
}

// ── 汇总采集 ────────────────────────────────────────────────────────────────
async function collect() {
  const balance = await collectBalance();
  const usage = await collectUsage();
  const storage = await collectStorage();
  const ts = Date.now();
  const point = {
    ts,
    balance: balance && balance.status === "ok" ? balance.total : null,
    tokens: usage && usage.status === "ok" ? usage.tokensIn + usage.tokensOut + usage.tokensCache : null,
    cost: usage && usage.status === "ok" && usage.cost != null ? usage.cost : null,
    storage: storage && storage.status === "ok" ? storage.eac.bytes + storage.dsh.bytes : null,
  };
  // 按 Key 明细一并入历史(只存前 8 名,避免 jsonl 膨胀)
  const kp = topKeysForHistory();
  if (kp.length) point.keys = kp;
  state.history.push(point);
  appendHistory(point);
  if (state.history.length > HISTORY_CAP) state.history.splice(0, state.history.length - HISTORY_CAP);
  state.lastCollect = ts;
  return snapshot();
}

async function ensureCollect() {
  if (Date.now() - state.lastCollect < COLLECT_STALE_MS) return snapshot();
  if (state.collecting) {
    // 采集异常卡死时强制解锁,保证数据端点永不挂起
    if (state.collectingSince && Date.now() - state.collectingSince > 30_000) {
      state.collecting = null;
      state.collectingSince = 0;
    } else {
      return state.collecting;
    }
  }
  state.collectingSince = Date.now();
  state.collecting = collect().finally(() => {
    state.collecting = null;
    state.collectingSince = 0;
  });
  return state.collecting;
}

function snapshot() {
  return {
    ts: Date.now(),
    edge: { status: state.edge.status, detail: state.edge.detail, hint: state.edge.hint },
    balance: state.balance,
    usage: state.usage,
    keys: state.keys,
    storage: state.storage,
    history: state.history.slice(-120),
    config: cfg,
  };
}

// ── Edge 连接 ───────────────────────────────────────────────────────────────
let attachEdgeBusy = false; // 防并发:页面自动连接 + 手动点击同时触发时只跑一次
async function tryConnect() {
  if (!(await cdpAlive())) {
    // 9222 未就绪:优先跟随专用 profile 写入的实际端口
    const p = readDevToolsPort();
    if (p && p !== cdpPort) cdpPort = p;
  }
  if (!(await cdpAlive())) {
    state.edge = { status: "disconnected", detail: "未连接", hint: "Edge 需要以调试端口启动,点击「连接 Edge」自动拉起" };
    return state.edge;
  }
  try {
    await ensureUsagePage();
    const v = await cdpEval("1+1");
    state.edge = { status: "connected", detail: "已连接 Edge(端口 " + cdpPort + ")", hint: "" };
    if (v === undefined || v === null) throw new Error("cdp eval 无响应");
  } catch (e) {
    state.edge = { status: "connected", detail: "Edge 已连但页面抓取失败", hint: String((e && e.message) || e) };
  }
  return state.edge;
}

// 定位 msedge.exe:已知路径 → 注册表 App Paths → PATH 中的 where msedge
async function resolveEdgeExe() {
  const cands = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  for (const c of cands) {
    if (existsSync(c)) return c;
  }
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise((res) => {
      execFile("where.exe", ["msedge"], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        res(err ? "" : String(stdout || "").split(/\r?\n/)[0].trim());
      });
    });
    if (out && existsSync(out)) return out;
  } catch { /* where 不可用 */ }
  return "";
}

// 平台登录态迁移:把默认 Edge profile 的 Local Storage(含 leveldb 压缩块,
// 明文搜索不可见)整体复制到专用 profile,复制后重启专用 Edge 即可读到 userToken。
async function migrateLocalStorage() {
  const src = join(EDGE_DEFAULT_PROFILE, "Default", "Local Storage");
  const dst = join(EDGE_PROFILE, "Default", "Local Storage");
  try {
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(join(EDGE_PROFILE, "Default"), { recursive: true });
    await cp(src, dst, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

// 确认专用 profile 的 platform 页面已有登录 token(幂等)
async function ensurePlatformToken() {
  const readExpr =
    `(function(){ try { var v = JSON.parse(localStorage.getItem('userToken') || '{}'); return v.value || ''; } catch (e) { return ''; } })()`;
  try {
    const cur = await cdpEval(readExpr, 8000);
    if (String(cur || "").trim()) return { ok: true, source: "existing" };
  } catch { /* 页面未就绪,继续尝试迁移 */ }
  // 无 token:复制默认 Local Storage 后重启专用 Edge(leveldb 重新加载)
  const copied = await migrateLocalStorage();
  if (!copied) return { ok: false, reason: "Local Storage 复制失败,请在监控 Edge 窗口登录一次 platform.deepseek.com" };
  const exe = await resolveEdgeExe();
  const { spawn } = await import("node:child_process");
  const POWERSHELL = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  try {
    const psKill =
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'EACEdgeProfile' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", psKill], { detached: true, stdio: "ignore" });
    child.unref();
    await sleep(2500);
  } catch { /* 无专用 Edge 进程 */ }
  if (exe) {
    try {
      // 直接 spawn 启动(专用 profile 实测 1 秒绑定 9222)
      const child = spawn(exe, [
        "--remote-debugging-port=9222",
        "--user-data-dir=" + EDGE_PROFILE,
        "--no-first-run",
        "--no-default-browser-check",
      ], { detached: true, stdio: "ignore" });
      child.unref();
    } catch { /* 启动失败 */ }
  }
  // 等待调试端口就绪(9222 + DevToolsActivePort 双通道)后读 token
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    if (await cdpAlive()) break;
    const p = readDevToolsPort();
    if (p && p !== cdpPort) {
      cdpPort = p;
      if (await cdpAlive()) break;
    }
  }
  try {
    await tryConnect();
    await ensureUsagePage();
    const cur2 = await cdpEval(readExpr, 8000);
    if (String(cur2 || "").trim()) return { ok: true, source: "copied" };
  } catch { /* 页面未就绪 */ }
  return { ok: false, reason: "迁移后仍未读到登录态,请在监控 Edge 窗口打开 platform.deepseek.com 并登录一次" };
}

async function attachEdge() {
  if (attachEdgeBusy) return { ok: false, status: "busy", hint: "连接进行中,请稍候" };
  attachEdgeBusy = true;
  try {
    if (await tryConnect()) {
      if (state.edge.status === "connected") {
        try { await ensureUsagePage(); } catch { /* usage 页尽力打开 */ }
        try { await ensurePlatformToken(); } catch { /* token 迁移失败不影响连接 */ }
        return { ok: true, status: "connected" };
      }
    }
    const exe = await resolveEdgeExe();
    if (!exe) return { ok: false, status: "disconnected", hint: "未找到 msedge.exe,请在 Edge 安装后重试" };
    const { spawn } = await import("node:child_process");
    const POWERSHELL = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    // 只结束"专用监控 profile"的 Edge 进程(按命令行 user-data-dir 匹配),
    // 不再 taskkill 全部 msedge —— 用户日常 Edge 完全不受影响。
    try {
      const psKill =
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
        "Where-Object { $_.CommandLine -match 'EACEdgeProfile' } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", psKill], { detached: true, stdio: "ignore" });
      child.unref();
      await sleep(2500);
    } catch { /* 无专用 Edge 进程 */ }
    try {
      // 直接 spawn(CreateProcess)启动 msedge:专用 profile(非默认位置)下
      // 实测 1 秒绑定调试端口。不再依赖 PowerShell。
      const child = spawn(exe, [
        "--remote-debugging-port=9222",
        "--user-data-dir=" + EDGE_PROFILE,
        "--no-first-run",
        "--no-default-browser-check",
      ], { detached: true, stdio: "ignore" });
      child.unref();
    } catch { /* 启动失败,继续探测 */ }
    // 轮询等待调试端口就绪(冷启动可能较慢,最多 30 秒):
    // 9222 固定端口 + DevToolsActivePort 实际端口双通道,任一就绪即算连接成功。
    let ready = false;
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000);
      if (await cdpAlive()) { ready = true; break; }
      const p = readDevToolsPort();
      if (p && p !== cdpPort) {
        cdpPort = p;
        if (await cdpAlive()) { ready = true; break; }
      }
    }
    if (ready) {
      await tryConnect();
      try { await ensureUsagePage(); } catch { /* usage 页尽力打开 */ }
      try { await ensurePlatformToken(); } catch { /* token 迁移失败不影响连接 */ }
      return { ok: true, status: "connected", hint: "Edge 已连接(专用调试 profile),usage 页面已自动打开" };
    }
    return {
      ok: false,
      status: "disconnected",
      hint: "Edge 启动失败(30 秒内未就绪),请手动执行:msedge --remote-debugging-port=9222 --user-data-dir=\"" + EDGE_PROFILE + "\"",
    };
  } finally {
    attachEdgeBusy = false;
  }
}

async function openUsagePage() {
  if (!(await cdpAlive())) return { ok: false, hint: "Edge 未连接,请先连接" };
  try {
    const t = await ensureUsagePage();
    return { ok: true, url: t.url || "https://platform.deepseek.com/usage" };
  } catch (e) {
    return { ok: false, hint: String((e && e.message) || e) };
  }
}

// 打开 DeepSeek 平台余额/用量页(点击监控窗「账户余额」触发):
//   1) 监控 Edge(已带平台登录态)在线 → 在其 usage 页打开;
//   2) 否则降级为系统默认浏览器(Start-Process)。
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/usage";
async function openBalanceInBrowser() {
  try {
    const r = await openUsagePage();
    if (r && r.ok) return { ok: true, channel: "edge", url: r.url };
  } catch { /* 降级 */ }
  try {
    const POWERSHELL = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const { execFile } = await import("node:child_process");
    await new Promise((res) => {
      execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", "Start-Process '" + PLATFORM_USAGE_URL + "'"], { windowsHide: true, timeout: 10000 }, () => res());
    });
    return { ok: true, channel: "browser", url: PLATFORM_USAGE_URL };
  } catch (e) {
    return { ok: false, hint: String((e && e.message) || e) };
  }
}

function httpOpenBalance(_req, res) {
  openBalanceInBrowser().then(
    (r) => writeJson(res, r),
    (e) => writeJson(res, { ok: false, hint: String((e && e.message) || e) })
  );
}

// ── 纯监控页(桌面置顶窗专用,自包含无依赖) ─────────────────────────────────
const MONITOR_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>EAC 监控</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:rgba(11,18,32,var(--alpha,.88));color:#e6ecff;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px;padding:46px 14px 14px;overflow:auto}
  .card{background:rgba(16,24,40,var(--alpha,.88));border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:12px;margin-bottom:10px}
  .head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  .alphaRow{display:flex;align-items:center;gap:5px;font-size:10.5px;color:#6b7aa8;flex:none}
  .alphaRow input[type=range]{accent-color:#4d6bfe;width:64px;margin:0;cursor:pointer}
  .loginWarn{font-size:11px;color:#f87171;margin-top:6px;line-height:1.5}
  .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .title{font-size:13px;font-weight:700;flex:1}
  .btn{border:1px solid rgba(255,255,255,.14);background:transparent;color:#b8c5ea;border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit}
  .btn:hover{border-color:#4d6bfe;color:#e6ecff}
  .btn:disabled{opacity:.45;cursor:default}
  .btnPrimary{border-color:#4d6bfe;color:#fff;background:rgba(77,107,254,.3)}
  .hero{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums}
  .heroSub{font-size:11px;color:#6b7aa8;margin-top:2px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-top:8px}
  .row{display:flex;align-items:baseline;gap:6px;font-size:12px}
  .k{color:#6b7aa8;flex:1;min-width:0}
  .v{font-variant-numeric:tabular-nums;white-space:nowrap}
  .ws{font-size:10.5px;color:#6b7aa8;padding-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .seri{display:flex;gap:6px;margin-bottom:4px}
  .chip{font-size:10px;padding:2px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);color:#6b7aa8;cursor:pointer;background:transparent;font-family:inherit}
  .chip.on{border-color:#4d6bfe;color:#fff}
  canvas{width:100%;height:96px;display:block}
  .foot{font-size:10.5px;color:#6b7aa8;text-align:center;padding:2px 0 4px}
  .status{display:flex;align-items:center;gap:8px;font-size:11px;color:#6b7aa8}
  .hint{font-size:10.5px;color:#6b7aa8;margin-top:6px;line-height:1.5;word-break:break-all}
  .klHead{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  .klHead .title{font-size:13px}
  .klRow{margin-bottom:9px}
  .klTop{display:flex;align-items:baseline;gap:6px;font-size:11.5px;line-height:1.35}
  .klDot{width:8px;height:8px;border-radius:2px;flex:none;display:inline-block}
  .klName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dfe6ff}
  .klVal{font-variant-numeric:tabular-nums;white-space:nowrap;color:#fff;font-weight:600}
  .klBar{height:7px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:4px}
  .klBar i{display:block;height:100%;border-radius:4px;min-width:2px}
  .klSub{font-size:10px;color:#6b7aa8;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .klLegend{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:6px}
  .klLegItem{display:inline-flex;align-items:center;gap:5px;font-size:10px;line-height:1;padding:3px 8px 3px 6px;border-radius:999px;border:1px solid rgba(255,255,255,.12);color:#8b98be;cursor:pointer;background:transparent;font-family:inherit;font-variant-numeric:tabular-nums}
  .klLegItem i{width:8px;height:8px;border-radius:2px;flex:none;opacity:.5}
  .klLegItem.on{border-color:rgba(255,255,255,.45);color:#e6ecff}
  .klLegItem.on i{opacity:1}
  ::-webkit-scrollbar{width:8px;height:8px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:rgba(139,152,190,.28);border-radius:999px}
  ::-webkit-scrollbar-thumb:hover{background:rgba(77,107,254,.5)}
  ::-webkit-scrollbar-corner{background:transparent}
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <span class="dot" id="dotTop"></span>
      <span class="title">EAC 监控 · 桌面置顶窗</span>
      <div class="alphaRow" title="背景透明度">透明<input type="range" id="alpha" min="35" max="100" value="88" oninput="setAlpha(this.value)"><span id="alphaVal">88%</span></div>
      <button class="btn" id="layerBtn" onclick="toggleLayer()">图层:最上层</button>
      <button class="btn" id="closeBtn" onclick="try{window.dshDesktop.floatWindow.close()}catch(e){}">关闭窗口</button>
    </div>
    <div class="row" style="cursor:pointer" title="点击在浏览器/监控 Edge 中打开 DeepSeek 平台余额与用量页" onclick="openBalancePage()"><span class="k">账户余额 ↗</span><span class="hero" id="balance">—</span></div>
    <div class="heroSub" id="balanceSub" style="cursor:pointer" title="点击打开 DeepSeek 平台余额与用量页" onclick="openBalancePage()"></div>
    <div class="grid">
      <div class="row"><span class="k">今日消耗金额</span><span class="v" id="cost">—</span></div>
      <div class="row"><span class="k">今日 Token 输出</span><span class="v" id="tokensOut">—</span></div>
      <div class="row"><span class="k">输入 + 缓存命中</span><span class="v" id="io">—</span></div>
      <div class="row"><span class="k">总 Token(今日)</span><span class="v" id="tokensTotal">—</span></div>
      <div class="row"><span class="k">数据更新</span><span class="v" id="upd">—</span></div>
    </div>
    <div class="hint" id="usageHint"></div>
  </div>
  <div class="card">
    <div class="title" style="margin-bottom:6px">存储空间</div>
    <div class="grid">
      <div class="row"><span class="k">当前对话文件</span><span class="v" id="curSes">—</span></div>
      <div class="row"><span class="k">全部会话文件</span><span class="v" id="sesTotal">—</span></div>
      <div class="row"><span class="k">EAC 目录</span><span class="v" id="eacRoot">—</span></div>
      <div class="row"><span class="k">~/.dsh 目录</span><span class="v" id="dshHome">—</span></div>
      <div class="row"><span class="k">工作区合计</span><span class="v" id="wsTotal">—</span></div>
    </div>
    <div id="wsList"></div>
  </div>
  <div class="card">
    <div class="seri">
      <button class="chip on" id="chipBalance" onclick="setSeries('balance')">余额</button>
      <button class="chip" id="chipTokens" onclick="setSeries('tokens')">Token</button>
      <button class="chip" id="chipStorage" onclick="setSeries('storage')">存储</button>
      <button class="chip" id="chipKeys" onclick="setSeries('keys')">各 Key</button>
    </div>
    <div class="seri" id="keyChartMode" style="display:none">
      <button class="chip on" id="klcToken" onclick="setKeyChartMode('tokens')">Token</button>
      <button class="chip" id="klcCost" onclick="setKeyChartMode('cost')">金额</button>
    </div>
    <div class="seri" id="ranges"></div>
    <canvas id="chart"></canvas>
    <div id="keyLegend"></div>
    <div class="hint" id="histMeta"></div>
  </div>
  <div class="card">
    <div class="klHead">
      <span class="title">各 API Key 用量 · 今日</span>
      <button class="chip on" id="klModeToken" onclick="setKeyMode('tokens')">Token</button>
      <button class="chip" id="klModeCost" onclick="setKeyMode('cost')">金额</button>
    </div>
    <div id="keyList"><div class="hint" id="keyEmpty">等待平台数据…</div></div>
    <div class="hint" id="keyMeta"></div>
  </div>
  <div class="card status">
    <span class="dot" id="dotEdge"></span>
    <span style="flex:1" id="edgeText">Edge 未连接</span>
    <button class="btn btnPrimary" id="edgeBtn" onclick="connectEdge()">连接 Edge(将重启 Edge)</button>
  </div>
  <div class="hint" id="edgeHint"></div>
  <div class="loginWarn" id="loginWarn" style="display:none"></div>
  <div class="card">
    <div class="head">
      <span class="dot" id="dotUpd"></span>
      <span class="title">更新监测 · 官方公告</span>
      <button class="btn" id="updBtn" onclick="checkUpd()">立即检查</button>
    </div>
    <div class="grid">
      <div class="row"><span class="k">本地版本</span><span class="v" id="updLocal">—</span></div>
      <div class="row"><span class="k">最新公告</span><span class="v" id="updLatest">—</span></div>
    </div>
    <div class="hint" id="updVerdict"></div>
    <div class="hint" id="updMeta"></div>
  </div>
  <div class="foot" id="foot"></div>
<script>
(function () {
  var SERIES = { balance: { color: '#4d6bfe' }, tokens: { color: '#22c55e' }, storage: { color: '#f59e0b' } };
  var RANGE_LIST = ['1m', '5m', '10m', '30m', '1h', '2h', '1d', '7d'];
  var RANGE_MS = { '1m': 60000, '5m': 300000, '10m': 600000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '1d': 86400000, '7d': 604800000 };
  var cur = 'balance';
  var curRange = '30m';
  var hist = [];
  var bal = {};
  var lastLayerApplied = null;
  var klChartMode = 'tokens'; // 趋势图「各 Key」模式:Token / 金额
  var klLit = {};             // keyName -> true:图例里被点亮(高亮该 Key 曲线)的 Key
  var CONFIG = { layerMode: 'top', chartRange: '30m', showBalance: true, showTokenStorage: true, axisAuto: true, axisMax: 0, autoConnectEdge: true };
  function $(id) { return document.getElementById(id); }
  // v5 壳层适配:Rust 壳的浮窗无 setTop/透明窗口 API,且 iframe 内没有注入
  // window.dshDesktop(桥只注入顶层页)。检测不到 setTop 时:图层按钮如实
  // 显示"壳层固定"(禁用),透明度滑条保留并联动外层浮层背景(页面内即可生效)。
  var shellHasTop = !!(window.dshDesktop && window.dshDesktop.floatWindow && typeof window.dshDesktop.floatWindow.setTop === 'function');
  if (!shellHasTop) {
    try {
      var lb = $('layerBtn');
      if (lb) {
        lb.disabled = true;
        lb.textContent = '图层:置顶(壳层固定)';
        lb.title = '当前壳层(v5/Rust)不支持切换图层,浮窗由壳层固定置顶';
      }
    } catch (e) { /* 忽略 */ }
  }
  // 浮窗 iframe 内:关闭由壳层 24px 浮窗条的叉叉负责,隐藏页面自身的关闭按钮
  // (避免右上角出现多个叉叉重叠)。
  try {
    if (window.self !== window.top) {
      var cb = $('closeBtn');
      if (cb) cb.style.display = 'none';
    }
  } catch (e) { /* 忽略 */ }
  // 合并新采样点(按 ts 去重,保持升序);hist 是"全量"序列,
  // 具体档度窗口在 rangePts() 里过滤 —— 这样切档度不会再被 3 秒轮询覆盖。
  function mergePts(arr) {
    if (!arr || !arr.length) return;
    var byTs = {};
    var i;
    for (i = 0; i < hist.length; i += 1) byTs[hist[i].ts] = hist[i];
    var changed = false;
    for (i = 0; i < arr.length; i += 1) {
      var p = arr[i];
      if (p && typeof p.ts === 'number' && !byTs[p.ts]) { byTs[p.ts] = p; changed = true; }
    }
    if (!changed) return;
    hist = Object.keys(byTs).map(function (k) { return byTs[k]; }).sort(function (a, b) { return a.ts - b.ts; });
    if (hist.length > 4000) {
      var step = hist.length / 2000;
      var thinned = [];
      for (i = 0; i < 2000; i += 1) thinned.push(hist[Math.floor(i * step)]);
      hist = thinned;
    }
  }
  // 按当前档度过滤出折线数据点 {t, v}
  // field 省略时用当前序列;「各 Key」模式没有单一序列,退回合计(Token/金额)
  // —— histMeta 的采样点计数仍需要一个序列来数
  function rangePts(field) {
    var out = [];
    if (!field) field = (cur === 'keys') ? (klChartMode === 'cost' ? 'cost' : 'tokens') : cur;
    var from = Date.now() - (RANGE_MS[curRange] || RANGE_MS['30m']);
    for (var i = 0; i < hist.length; i += 1) {
      if (hist[i].ts < from) continue;
      var v = hist[i][field];
      if (v === null || v === undefined) continue;
      out.push({ t: hist[i].ts, v: v });
    }
    return out;
  }
  function fmtBytes(b) {
    if (b === null || b === undefined || isNaN(b)) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtMoney(n, c) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var sym = c === 'CNY' ? '¥' : c === 'USD' ? '$' : (c ? c + ' ' : '');
    return sym + (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toFixed(6));
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (v) { return String(v).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ── 各 API Key 用量视图(按 key 分色;Token / 金额 双模式)──────────────
  // 调色板:刻意避开余额蓝/Token 绿/存储橙,让「按 key」配色不与其他卡片混淆
  var KEY_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#fb7185', '#34d399', '#fbbf24', '#60a5fa', '#c084fc', '#2dd4bf', '#f97316', '#e879f9', '#84cc16'];
  var klMode = 'tokens';
  var klPayload = { status: 'idle', list: [] };
  function keyColor(i) { return KEY_COLORS[((i % KEY_COLORS.length) + KEY_COLORS.length) % KEY_COLORS.length]; }
  function fmtTok(n) {
    var v = Number(n || 0);
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
    return String(Math.round(v));
  }
  function keyName(e) { return String((e && e.name) || '(未命名)'); }
  function keyColorOf(e, idx) {
    var ci = (e && typeof e.colorIndex === 'number') ? e.colorIndex : idx;
    return keyColor(ci);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function drawKeys() {
    var box = $('keyList'); if (!box) return;
    var list = (klPayload && klPayload.list) || [];
    var currency = (klPayload && klPayload.currency) || (bal && bal.currency) || 'CNY';
    $('klModeToken').className = 'chip' + (klMode === 'tokens' ? ' on' : '');
    $('klModeCost').className = 'chip' + (klMode === 'cost' ? ' on' : '');
    if (!list.length) {
      var why = klPayload && klPayload.status && klPayload.status !== 'ok' ? '等待平台数据…' : '今日暂无用量';
      box.innerHTML = '<div class="hint" id="keyEmpty">' + esc(why) + '</div>';
      $('keyMeta').textContent = '';
      return;
    }
    var useCost = (klMode === 'cost');
    var sum = 0;
    list.forEach(function (e) {
      sum += useCost ? Number(e.cost || 0) : Number((e.tokensIn || 0) + (e.tokensOut || 0) + (e.tokensCache || 0));
    });
    var html = '';
    var shown = 0;
    list.forEach(function (e, idx) {
      var tok = Number((e.tokensIn || 0) + (e.tokensOut || 0) + (e.tokensCache || 0));
      var cost = (e.cost == null) ? null : Number(e.cost);
      var val = useCost ? (cost == null ? null : cost) : tok;
      // 金额模式下金额为空但有 token 的 key 仍要列出(显示为 —),否则会"凭空消失"
      if (useCost && val == null && tok === 0) return;
      shown += 1;
      var col = keyColorOf(e, idx);
      var share = sum > 0 && val != null ? (val / sum) : 0;
      var valTxt = val == null ? '—' : (useCost ? fmtMoney(val, currency) : fmtTok(val));
      var shareTxt = (useCost ? (cost != null && sum > 0 ? (cost / sum * 100).toFixed(1) : '0.0') : (sum > 0 ? (tok / sum * 100).toFixed(1) : '0.0')) + '%';
      var sub = [];
      if (!useCost) sub.push('出 ' + fmtTok(e.tokensOut) + ' · 入 ' + fmtTok(e.tokensIn) + ' · 缓存 ' + fmtTok(e.tokensCache));
      sub.push('金额 ' + (cost == null ? '—' : fmtMoney(cost, currency)));
      sub.push('请求 ' + fmtTok(e.requests));
      if (e.masked) sub.push(e.masked);
      if (e.models && e.models.length) sub.push(e.models.join('/'));
      if (e.valid === false) sub.push('已停用');
      html += '<div class="klRow" title="' + esc(keyName(e) + ' · ' + (e.masked || '') + ' · ' + (e.models || []).join('/')) + '">' +
        '<div class="klTop"><span class="klDot" style="background:' + col + '"></span>' +
        '<span class="klName">' + esc(keyName(e)) + '</span>' +
        '<span class="klVal">' + valTxt + ' · ' + shareTxt + '</span></div>' +
        '<div class="klBar"><i style="width:' + (share * 100).toFixed(1) + '%;background:' + col + '"></i></div>' +
        '<div class="klSub">' + esc(sub.join(' · ')) + '</div></div>';
    });
    // 多出来的 key 折叠成一行提示,避免浮窗无限变长
    var rest = list.length - shown;
    if (rest > 0) html += '<div class="hint">另有 ' + rest + ' 个 Key(今日用量较少,未展开)</div>';
    box.innerHTML = html;
    $('keyMeta').textContent = '共 ' + list.length + ' 个 Key · 合计 ' +
      (useCost ? fmtMoney(sum, currency) : fmtTok(sum) + ' Token') +
      (klPayload.at ? ' · ' + fmtTime(klPayload.at) : '');
  }
  window.setKeyMode = function (m) { klMode = (m === 'cost' ? 'cost' : 'tokens'); drawKeys(); };
  // ── 画布框架:数值轴网格 + 时间轴 ────────────────────────────────────────
  // allPts = 若干条 {t,v} 序列组成的数组,合并用于求共享值域(多序列共用一根轴);
  // fmtVal 负责刻度文案(余额→金额、Token→数量、各 Key→按模式的金额/数量)
  function drawFrame(g, w, H, allPts, fmtVal) {
    var padL = 54, padR = 8, padT = 8, padB = 16;
    var pw = w - padL - padR, ph = H - padT - padB;
    // 竖轴:窗口内最小值为底、最大值为顶(各留 6% 余量)。
    // 旧版把"当前值"固定为底 —— 对 Token/存储这类单调递增序列,
    // 当前值=最大值,整条曲线被压在最底部 5% 的空间,变化几乎不可见。
    var minV = Infinity, maxV = -Infinity;
    var i, k;
    for (i = 0; i < allPts.length; i += 1) {
      for (k = 0; k < allPts[i].length; k += 1) {
        if (allPts[i][k].v < minV) minV = allPts[i][k].v;
        if (allPts[i][k].v > maxV) maxV = allPts[i][k].v;
      }
    }
    var base = minV, top = maxV;
    if (!isFinite(base) || !isFinite(top)) { base = 0; top = 1; }
    if (top - base < 1e-9) { base -= 1; top += 1; }
    var pad6 = (top - base) * 0.06;
    top += pad6;
    base = (base - pad6 > 0) ? base - pad6 : 0; // 最小值贴近 0 时不产生负刻度
    if (!CONFIG.axisAuto && CONFIG.axisMax > 0 && CONFIG.axisMax > top) top = CONFIG.axisMax;
    var span = top - base || 1;
    // 数值轴刻度(左,5 条)
    g.font = '9px system-ui';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (var gi = 0; gi <= 4; gi += 1) {
      var vv = top - (span * gi / 4);
      var y = padT + (ph * gi / 4);
      g.strokeStyle = 'rgba(139,152,190,.14)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillStyle = 'rgba(139,152,190,.8)';
      g.fillText(fmtVal(vv), padL - 4, y);
    }
    // 时间轴:完整覆盖所选档度窗口(now-range → now),不再以首数据点为起点。
    // 数据不足一档(如 7d 档只有 4 天数据)时,轴仍按 7 天展开,数据铺在对应时段。
    g.textAlign = 'center';
    g.textBaseline = 'top';
    var t0 = Date.now() - (RANGE_MS[curRange] || RANGE_MS['30m']);
    var t1 = Date.now();
    for (i = 0; i < allPts.length; i += 1) {
      if (allPts[i].length && allPts[i][allPts[i].length - 1].t > t1) t1 = allPts[i][allPts[i].length - 1].t;
    }
    var axis = timeTicks(t0, t1);
    var tickMode = axis.step >= 86400000 ? 'md' : (axis.step < 60000 ? 'hms' : 'hm');
    for (var ti = 0; ti < axis.ts.length; ti += 1) {
      var tt = axis.ts[ti];
      var x = padL + ((tt - t0) / (t1 - t0 || 1)) * pw;
      g.fillStyle = 'rgba(139,152,190,.8)';
      g.fillText(fmtTick(tt, tickMode), x, padT + ph + 2);
    }
    return {
      X: function (t) { return padL + ((t - t0) / (t1 - t0 || 1)) * pw; },
      Y: function (v) { return padT + ph - ((v - base) / span) * ph; },
      t0: t0, t1: t1, padT: padT, ph: ph, padR: padR,
    };
  }
  // 画一条折线;只有一个采样点时画成圆点(刚切到某个档度时不至于什么都看不到)
  function plotLine(g, pts, X, Y, color, width) {
    if (!pts || !pts.length) return;
    if (pts.length === 1) {
      g.beginPath();
      g.arc(X(pts[0].t), Y(pts[0].v), width + 0.6, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      return;
    }
    g.beginPath();
    for (var q = 0; q < pts.length; q += 1) {
      if (q === 0) g.moveTo(X(pts[q].t), Y(pts[q].v)); else g.lineTo(X(pts[q].t), Y(pts[q].v));
    }
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.stroke();
  }
  // ── 趋势图「各 Key」:每个 Key 一条线,值域只按 Key 自己的最大值定 ────────
  // 特意**不含合计**:合计常是单个 Key 的好几倍,把它算进值域会把所有 Key
  // 压到贴近底边连成一片,一条都看不清(Y 轴按最高金额/最高 Token 来定)。
  // 历史点只存前 8 名(point.keys = [{n,c,t,cost,req,m}]),所以窗口内最多 8 条;
  // 其中 c 就是下方卡片用的 colorIndex —— 同一个 Key 上下同色。
  function keyWindowPts() {
    var field = (klChartMode === 'cost') ? 'cost' : 'tokens';
    var from = Date.now() - (RANGE_MS[curRange] || RANGE_MS['30m']);
    var byKey = {};
    var order = [];
    for (var i = 0; i < hist.length; i += 1) {
      var p = hist[i];
      if (!p || p.ts < from || !p.keys) continue;
      for (var k = 0; k < p.keys.length; k += 1) {
        var e = p.keys[k];
        var v = (field === 'cost') ? e.cost : e.t;
        if (v === null || v === undefined) continue;
        if (!byKey[e.n]) { byKey[e.n] = { n: e.n, c: e.c, pts: [] }; order.push(e.n); }
        byKey[e.n].pts.push({ t: p.ts, v: v });
      }
    }
    // 图例按窗口内最新值降序 —— 与下方卡片的用量排序一致
    var lastOf = function (n) { var a = byKey[n].pts; return a.length ? a[a.length - 1].v : -1; };
    order.sort(function (a, b) { return lastOf(b) - lastOf(a); });
    return { byKey: byKey, order: order, field: field };
  }
  function drawKeyChart(g, w, H) {
    var d = keyWindowPts();
    var fmtVal = (d.field === 'cost') ? function (v) { return fmtMoney(v, bal.currency); } : fmtNum;
    if (!d.order.length) {
      g.fillStyle = 'rgba(139,152,190,.6)';
      g.font = '11px system-ui';
      g.textAlign = 'center';
      g.fillText('窗口内暂无分 Key 采样(数据积累中)', 54 + (w - 62) / 2, 8 + 72 / 2);
      renderKeyLegend(d);
      return;
    }
    var axisPts = [];
    for (var i = 0; i < d.order.length; i += 1) axisPts.push(d.byKey[d.order[i]].pts);
    var fr = drawFrame(g, w, H, axisPts, fmtVal);
    var anyLit = false;
    for (var j = 0; j < d.order.length; j += 1) { if (klLit[d.order[j]]) { anyLit = true; break; } }
    // 一个都没点亮时全部正常画(免得一进去是空图);点亮之后未点亮的退成暗线做对比
    for (var k = 0; k < d.order.length; k += 1) {
      var n = d.order[k];
      var on = !!klLit[n];
      g.globalAlpha = (!anyLit || on) ? 1 : 0.28;
      plotLine(g, d.byKey[n].pts, fr.X, fr.Y, keyColor(d.byKey[n].c), on ? 2.2 : 1.5);
      g.globalAlpha = 1;
    }
    renderKeyLegend(d);
  }
  function renderKeyLegend(d) {
    var box = $('keyLegend');
    if (!box) return;
    if (!d) d = keyWindowPts();
    var fmtVal = (d.field === 'cost') ? function (v) { return fmtMoney(v, bal.currency); } : fmtTok;
    box.innerHTML = '';
    if (!d.order.length) {
      box.className = 'hint';
      box.textContent = '窗口内暂无分 Key 采样(数据积累中)';
      return;
    }
    box.className = 'klLegend';
    for (var i = 0; i < d.order.length; i += 1) {
      var n = d.order[i];
      var pts = d.byKey[n].pts;
      var last = pts.length ? pts[pts.length - 1].v : null;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'klLegItem' + (klLit[n] ? ' on' : '');
      b.title = '点一下高亮这个 Key 的曲线(再点取消)';
      var dot = document.createElement('i');
      dot.style.background = keyColor(d.byKey[n].c);
      b.appendChild(dot);
      var sp = document.createElement('span');
      sp.textContent = n + ' ' + (last === null ? '—' : fmtVal(last));
      b.appendChild(sp);
      b.onclick = (function (name) {
        return function () { klLit[name] = !klLit[name]; draw(); };
      }(n));
      box.appendChild(b);
    }
  }
  function setKeyChartMode(m) {
    klChartMode = (m === 'cost') ? 'cost' : 'tokens';
    $('klcToken').className = 'chip' + (klChartMode === 'tokens' ? ' on' : '');
    $('klcCost').className = 'chip' + (klChartMode === 'cost' ? ' on' : '');
    draw();
  }
  window.setKeyChartMode = setKeyChartMode;
  function draw() {
    var cv = $('chart');
    var w = cv.parentElement.clientWidth || 360;
    var dpr = window.devicePixelRatio || 1;
    var H = 96;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = w + 'px';
    cv.style.height = H + 'px';
    var g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, H);
    if (cur === 'keys') {
      $('keyLegend').style.display = '';
      drawKeyChart(g, w, H);
      return;
    }
    $('keyLegend').style.display = 'none';
    var color = SERIES[cur].color;
    // 数据点 {t, v}:按当前时间档度过滤,轮询数据与档度选择互不干扰
    var pts = rangePts();
    if (pts.length < 2) {
      g.fillStyle = 'rgba(139,152,190,.6)';
      g.font = '11px system-ui';
      g.textAlign = 'center';
      g.fillText('数据采集中…(选择时间档度后自动填充)', 54 + (w - 62) / 2, 8 + 72 / 2);
      return;
    }
    var fr = drawFrame(g, w, H, [pts], fmtY);
    // 折线 + 面积渐变(先描线再铺渐变,与旧版观感一致)
    plotLine(g, pts, fr.X, fr.Y, color, 1.6);
    var grad = g.createLinearGradient(0, fr.padT, 0, fr.padT + fr.ph);
    grad.addColorStop(0, color + '55');
    grad.addColorStop(1, color + '00');
    g.beginPath();
    for (var q = 0; q < pts.length; q += 1) {
      if (q === 0) g.moveTo(fr.X(pts[q].t), fr.Y(pts[q].v)); else g.lineTo(fr.X(pts[q].t), fr.Y(pts[q].v));
    }
    g.lineTo(fr.X(fr.t1), fr.padT + fr.ph);
    g.lineTo(fr.X(fr.t0), fr.padT + fr.ph);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    // 最新值标签
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(fmtY(pts[pts.length - 1].v), w - fr.padR - 2, fr.padT + 2);
  }
  // 时间轴刻度:按跨度自适应选步长(目标 5~10 个刻度,上限 14),
  // ≥2d 用每日日期刻度,1d~2d 每 6 小时;秒级刻度(15s/30s)只用于 ≤2m 档,
  // 5m 及以上一律分钟级起步 —— 避免秒数标签过多导致文字重叠。
  function timeTicks(t0, t1) {
    var span = t1 - t0;
    var i, t;
    if (span >= 172800000) { // ≥2d:每天一个刻度,日期格式
      var d0 = new Date(t0);
      var start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
      var out = [];
      for (t = start; t <= t1 + 1; t += 86400000) out.push(t);
      return { ts: out, step: 86400000 };
    }
    if (span >= 86400000) { // 1d~2d:每 6 小时
      var out2 = [];
      for (t = Math.floor(t0 / 21600000) * 21600000; t <= t1 + 1; t += 21600000) out2.push(t);
      return { ts: out2, step: 21600000 };
    }
    var step;
    if (span <= 120000) {
      // ≤2m:秒级刻度(15s/30s),标签带秒
      step = (span / 15000 <= 10) ? 15000 : 30000;
    } else {
      // >2m:分钟级起步(1m~6h),5m 及以上无秒数
      var MIN_STEPS = [60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 10800000, 21600000];
      step = MIN_STEPS[MIN_STEPS.length - 1];
      for (i = 0; i < MIN_STEPS.length; i += 1) {
        if (span / MIN_STEPS[i] <= 10) { step = MIN_STEPS[i]; break; }
      }
    }
    var out3 = [];
    for (t = Math.floor(t0 / step) * step; t <= t1 + 1; t += step) out3.push(t);
    if (out3.length > 14) { // 兜底:均匀抽到 ≤14 个
      var keep = [];
      for (i = 0; i < 14; i += 1) keep.push(out3[Math.floor(i * out3.length / 14)]);
      out3 = keep;
    }
    return { ts: out3, step: step };
  }
  function fmtTick(ts, mode) {
    var d = new Date(ts);
    var p = function (v) { return String(v).padStart(2, '0'); };
    var now = new Date();
    var same = d.toDateString() === now.toDateString();
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (mode === 'md') return (d.getMonth() + 1) + '-' + d.getDate();
    if (mode === 'hms') return same ? hm + ':' + p(d.getSeconds()) : (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm + ':' + p(d.getSeconds());
    return same ? hm : (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm;
  }
  function fmtY(v) {
    if (cur === 'balance') return fmtMoney(v, bal.currency);
    if (cur === 'tokens') return fmtNum(v);
    return fmtBytes(v);
  }
  function setSeries(k) {
    cur = k;
    $('chipBalance').className = 'chip' + (k === 'balance' ? ' on' : '');
    $('chipTokens').className = 'chip' + (k === 'tokens' ? ' on' : '');
    $('chipStorage').className = 'chip' + (k === 'storage' ? ' on' : '');
    $('chipKeys').className = 'chip' + (k === 'keys' ? ' on' : '');
    // Token/金额 子切换只在「各 Key」模式下出现
    $('keyChartMode').style.display = (k === 'keys') ? '' : 'none';
    draw();
  }
  window.setSeries = setSeries;
  function buildRanges() {
    var html = '';
    for (var i = 0; i < RANGE_LIST.length; i += 1) {
      var r = RANGE_LIST[i];
      html += '<button class="chip' + (r === curRange ? ' on' : '') + '" data-r="' + r + '" onclick="setRange(\\'' + r + '\\')">' + r + '</button>';
    }
    $('ranges').innerHTML = html;
  }
  function setRange(r) {
    curRange = r;
    var chips = $('ranges').children;
    for (var i = 0; i < chips.length; i += 1) chips[i].className = 'chip' + (chips[i].getAttribute('data-r') === r ? ' on' : '');
    loadHistory();
    saveCfg('chartRange', r);
  }
  window.setRange = setRange;
  function loadHistory() {
    fetch('/api/eac-monitor/history?range=' + curRange, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.points) {
          mergePts(d.points);
          var meta = $('histMeta');
          var view = rangePts();
          if (view.length >= 2) {
            var t0 = new Date(view[0].t);
            var t1 = new Date(view[view.length - 1].t);
            var p = function (v) { return String(v).padStart(2, '0'); };
            var f = function (t) { return p(t.getHours()) + ':' + p(t.getMinutes()); };
            var fmd = function (t) { return (t.getMonth() + 1) + '-' + t.getDate(); };
            var sameDay = t1.toDateString() === t0.toDateString();
            meta.textContent = '档度 ' + curRange + ' · 数据 ' + (sameDay ? f(t0) + ' → ' + f(t1) : fmd(t0) + ' ' + f(t0) + ' → ' + fmd(t1) + ' ' + f(t1)) +
              ' · ' + view.length + ' 个采样点(时间轴已按所选档度完整展开;数据不足一档时曲线靠右显示)';
          } else {
            meta.textContent = '档度 ' + curRange + ' · 数据积累中…';
          }
          draw();
        }
      })
      .catch(function () { /* 重试 */ });
  }
  function setLayerMode(m) {
    CONFIG.layerMode = m;
    // 按钮文字只能有一个真值来源。
    // 渲染循环每 3 秒会走到这里,读的是服务端 config(启动时取一次,之后不再刷新);
    // 而 inject-ui.js 每 2 秒拿宿主真实置顶状态写同一个按钮 —— 两者一旦不一致
    // (点过按钮就会不一致:点击只改宿主状态,不改 config),文字就在
    // 「图层:最上层 / 图层:一般」之间来回横跳。
    // 助手环境里 inject-ui.js 把宿主真实状态放在 window.__floatTop,以它为准;
    // 非助手环境(壳层)没有这个变量,按原逻辑用 m。
    var eff = (typeof window.__floatTop === 'boolean') ? (window.__floatTop ? 'top' : 'normal') : m;
    $('layerBtn').textContent = '图层:' + (eff === 'top' ? '最上层' : '一般');
    if (lastLayerApplied === eff) return; // 已应用,不重复发 IPC
    lastLayerApplied = eff;
    try { window.dshDesktop.floatWindow.setTop(eff === 'top'); } catch (e) { /* 非桌面环境 */ }
  }
  function toggleLayer() {
    var next = CONFIG.layerMode === 'top' ? 'normal' : 'top';
    setLayerMode(next);
    saveCfg('layerMode', next);
  }
  window.toggleLayer = toggleLayer;
  function saveCfg(k, v) {
    fetch('/api/eac-monitor/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k, value: v }),
      cache: 'no-store',
    }).catch(function () { /* noop */ });
  }
  function applyShow() {
    var cards = document.querySelectorAll('.card');
    if (cards.length >= 1) cards[0].style.display = CONFIG.showBalance === false ? 'none' : '';
    if (cards.length >= 2) cards[1].style.display = CONFIG.showTokenStorage === false ? 'none' : '';
  }
  // 每次启动监控窗自动连接 Edge(读取今日消耗/Token);关闭配置后不再自动连
  var autoAttached = false;
  function maybeAutoAttach() {
    if (autoAttached) return;
    if (CONFIG.autoConnectEdge === false) return;
    autoAttached = true;
    fetch('/api/eac-monitor/attach-edge', { method: 'POST', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.hint) $('edgeHint').textContent = d.hint; })
      .catch(function () { /* 连接失败等手动重试 */ });
  }
  function loadConfig() {
    fetch('/api/eac-monitor/config', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.config) {
          CONFIG = d.config;
          if (CONFIG.chartRange && RANGE_LIST.indexOf(CONFIG.chartRange) >= 0) curRange = CONFIG.chartRange;
          buildRanges();
          setLayerMode(CONFIG.layerMode === 'top' ? 'top' : 'normal');
          applyShow();
          maybeAutoAttach();
        }
      })
      .catch(function () { buildRanges(); maybeAutoAttach(); });
  }
  function setAlpha(v) {
    var a = (Number(v) / 100).toFixed(2);
    document.documentElement.style.setProperty('--alpha', a);
    $('alphaVal').textContent = v + '%';
    try { localStorage.setItem('eac-monitor-alpha', String(v)); } catch (e) { /* noop */ }
    // 同步到外层浮窗铺满层(同源 iframe 可访问父页):透明度变化立即可见,
    // 而不是只影响卡片、窗外层仍是实底。
    try {
      if (window.parent && window.parent.document) {
        var pf = window.parent.document.querySelector('.em-floatFull');
        if (pf) pf.style.background = 'rgba(11,18,32,' + a + ')';
      }
    } catch (e) { /* 忽略 */ }
  }
  window.setAlpha = setAlpha;
  (function initAlpha() {
    var v = '88';
    try { v = localStorage.getItem('eac-monitor-alpha') || '88'; } catch (e) { /* noop */ }
    $('alpha').value = v;
    setAlpha(v);
  })();
  function render(d) {
    bal = d.balance || {};
    var edge = d.edge || { status: 'disconnected' };
    var use = d.usage || {};
    var sto = d.storage || {};
    $('dotTop').style.background = edge.status === 'connected' ? (use.status === 'ok' ? '#22c55e' : '#eab308') : '#ef4444';
    $('balance').textContent = bal.status === 'ok' ? fmtMoney(bal.total, bal.currency) : '—';
    $('balanceSub').textContent = bal.status === 'ok' && bal.granted != null ? '赠 ' + fmtMoney(bal.granted, bal.currency) + ' · 充 ' + fmtMoney(bal.toppedUp, bal.currency) : '';
    $('cost').textContent = use.cost != null ? fmtMoney(use.cost, use.currency) : '—';
    $('tokensOut').textContent = use.status === 'ok' ? fmtNum(use.tokensOut) : '—';
    $('io').textContent = use.status === 'ok' ? fmtNum(use.tokensIn) + ' + ' + fmtNum(use.tokensCache) : '—';
    $('tokensTotal').textContent = use.status === 'ok' ? fmtNum(use.tokensIn + use.tokensOut + use.tokensCache) : '—';
    $('upd').textContent = d.ts ? fmtTime(d.ts) : '—';
    $('usageHint').textContent = use.detail || '';
    $('curSes').textContent = sto.currentSession ? fmtBytes(sto.currentSession.bytes) : '—';
    $('sesTotal').textContent = fmtBytes(sto.sessionsTotal);
    $('eacRoot').textContent = fmtBytes(sto.eac && sto.eac.bytes);
    $('dshHome').textContent = fmtBytes(sto.dsh && sto.dsh.bytes);
    $('wsTotal').textContent = fmtBytes(sto.wsTotal);
    var wsHtml = '';
    (sto.workspaces || []).forEach(function (w) {
      wsHtml += '<div class="ws">' + w.title + '  ' + fmtBytes(w.bytes) + (w.missing ? '  (缺失)' : '') + '</div>';
    });
    $('wsList').innerHTML = wsHtml;
    // 各 API Key 用量视图
    klPayload = d.keys || { status: 'idle', list: [] };
    drawKeys();
    $('dotEdge').style.background = edge.status === 'connected' ? (use.status === 'ok' ? '#22c55e' : '#eab308') : '#ef4444';
    $('edgeText').textContent = edge.status === 'connected' ? 'Edge 已连接' : 'Edge 未连接';
    $('edgeHint').textContent = edge.hint || '';
    var warn = $('loginWarn');
    if (use.status === 'need-login') {
      warn.style.display = 'block';
      warn.innerHTML = '⚠ ' + (use.detail || 'DeepSeek 平台未登录') + '。<a href="javascript:openLogin()" style="color:#93c5fd">打开平台登录页</a>';
    } else {
      warn.style.display = 'none';
    }
    $('foot').textContent = (shellHasTop ? '可拖动顶部栏移动 · 图层可切换 · ' : 'v5 壳层浮窗:普通窗口,置顶/透明由壳层决定 · 顶部 24px 条可拖动 · ') + fmtTime(Date.now());
    // 轮询快照与历史合并:只补新点,不再整段覆盖 hist(旧逻辑会把 7d 档度
    // 瞬时打回最近 ~1 小时的采样窗口,造成档度反复跳变)
    mergePts(d.history);
    // 图层状态跟随配置(设置页改图层后窗口立即生效;与按钮切换共用 lastLayerApplied 防重复)
    setLayerMode(CONFIG.layerMode === 'top' ? 'top' : 'normal');
    draw();
  }
  window.openLogin = function () {
    fetch('/api/eac-monitor/attach-edge', { method: 'POST', cache: 'no-store' }).catch(function () { /* noop */ });
  };
  // 点击「账户余额」→ 打开 DeepSeek 平台余额/用量页(宿主:监控 Edge 优先,
  // 否则系统默认浏览器);WebView2/iframe 内没有 dshDesktop,统一走宿主 HTTP。
  window.openBalancePage = function () {
    fetch('/api/eac-monitor/open-balance', { method: 'POST', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.hint) {
          var h = $('usageHint');
          if (h) h.textContent = d.hint;
        }
      })
      .catch(function () { /* 服务重启中,可重试 */ });
  };
  function tick() {
    fetch('/api/eac-monitor/data', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { /* 服务重启中,自动重试 */ });
  }
  window.connectEdge = function () {
    var btn = $('edgeBtn');
    btn.disabled = true;
    btn.textContent = '连接中…';
    fetch('/api/eac-monitor/attach-edge', { method: 'POST', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false;
        btn.textContent = '连接 Edge(将重启 Edge)';
        $('edgeHint').textContent = (d && (d.hint || (d.ok ? '已连接' : '连接失败'))) || '';
        setTimeout(tick, 2500);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = '连接 Edge(将重启 Edge)';
      });
  };
  // 更新监测卡片:展示本地版本/最新公告/评估结论/备份数
  function checkUpd() {
    var btn = $('updBtn');
    btn.disabled = true;
    btn.textContent = '检查中…';
    fetch('/api/eac-monitor/update-preview', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false;
        btn.textContent = '立即检查';
        if (d && d.dryRun) {
          var dry = d.dryRun;
          $('updVerdict').textContent = d.verdict || '';
          $('updMeta').textContent = '试打: main ' + (dry.main.ok ? '✅' : '❌ ' + (dry.main.reason || '')) +
            ' · preload ' + (dry.preload.ok ? '✅' : '❌ ' + (dry.preload.reason || ''));
          $('dotUpd').style.background = dry.main.ok && dry.preload.ok ? '#22c55e' : '#eab308';
        } else if (d) {
          $('updVerdict').textContent = d.verdict || '检查无结果';
        }
      })
      .catch(function () { btn.disabled = false; btn.textContent = '立即检查'; });
  }
  window.checkUpd = checkUpd;
  function loadUpd() {
    fetch('/api/eac-monitor/update-status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        $('updLocal').textContent = d.localVersion || '—';
        $('updLatest').textContent = d.latestTag || '—';
        var a = d.announcements && d.announcements[0];
        $('updVerdict').textContent = a ? a.verdict : '暂无公告记录(每 6 小时自动检查官方发布)';
        $('updMeta').textContent = '备份 ' + (d.backups ? d.backups.length : 0) + ' 份 · 上次检查 ' + (d.lastCheck ? fmtTime(d.lastCheck) : '—');
        $('dotUpd').style.background = !a ? '#6b7aa8' : (a.dryRun && a.dryRun.main && a.dryRun.main.ok && a.dryRun.preload && a.dryRun.preload.ok ? '#22c55e' : '#eab308');
      })
      .catch(function () { /* 服务重启中 */ });
  }
  // 启动:配置 → 历史 → 数据;3 秒数据轮询 + 30 秒历史/更新状态刷新
  loadConfig();
  loadHistory();
  tick();
  loadUpd();
  setInterval(tick, 3000);
  setInterval(loadHistory, 30000);
  setInterval(loadUpd, 30000);
})();
</script>
</body>
</html>`;

function httpData(_req, res) {
  ensureCollect().then(
    (s) => { writeJson(res, s); },
    () => { writeJson(res, snapshot()); }
  );
}

function writeJson(res, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  } catch { /* 客户端断开 */ }
}

function httpPage(_req, res) {
  try {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(MONITOR_PAGE);
  } catch { /* 客户端断开 */ }
}

function httpAttachEdge(_req, res) {
  attachEdge().then(
    (r) => writeJson(res, r),
    (e) => writeJson(res, { ok: false, hint: String((e && e.message) || e) })
  );
}

function httpHistory(req, res) {
  try {
    const u = new URL(req.url || "/", "http://x");
    const range = String(u.searchParams.get("range") || cfg.chartRange || "30m");
    const ms = RANGES[range] || RANGES["30m"];
    const points = readHistory(ms);
    writeJson(res, { ok: true, range, points });
  } catch (e) {
    writeJson(res, { ok: false, error: String((e && e.message) || e) });
  }
}

function httpConfig(req, res) {
  try {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        try {
          const j = JSON.parse(body || "{}");
          const key = String(j.key || "");
          if (!(key in CONFIG_DEFAULTS)) { writeJson(res, { ok: false, error: "unknown key" }); return; }
          const r = writeConfig(key, j.value);
          writeJson(res, r);
        } catch (e) {
          writeJson(res, { ok: false, error: String((e && e.message) || e) });
        }
      });
      req.on("error", () => { writeJson(res, { ok: false, error: "body error" }); });
      return;
    }
    writeJson(res, { ok: true, config: cfg });
  } catch (e) {
    writeJson(res, { ok: false, error: String((e && e.message) || e) });
  }
}

// 诊断:host 进程网络环境与平台连通性
async function httpDiag(_req, res) {
  const out = {
    ts: Date.now(),
    env: {
      HTTP_PROXY: process.env.HTTP_PROXY || "",
      HTTPS_PROXY: process.env.HTTPS_PROXY || "",
      http_proxy: process.env.http_proxy || "",
      https_proxy: process.env.https_proxy || "",
      NO_PROXY: process.env.NO_PROXY || "",
    },
    tests: [],
  };
  const targets = [
    "https://platform.deepseek.com/api/v0/users/get_user_summary",
    "https://api.deepseek.com/user/balance",
  ];
  for (const u of targets) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      out.tests.push({ url: u, status: r.status, body: (await r.text()).slice(0, 150) });
    } catch (e) {
      out.tests.push({ url: u, error: String((e && e.message) || e) });
    }
  }
  // token 读取与有效性诊断
  try {
    const tok = await cdpEval(
      `(function(){ try { var v = JSON.parse(localStorage.getItem('userToken') || '{}'); return v.value || ''; } catch (e) { return ''; } })()`,
      8000
    );
    const t = String(tok || "").trim();
    out.tokenDiag = { read: t ? "OK len=" + t.length : "EMPTY" };
    if (t) {
      try {
        const r = await fetch("https://platform.deepseek.com/api/v0/users/get_user_summary", {
          headers: { Authorization: "Bearer " + t, Accept: "application/json" },
          signal: AbortSignal.timeout(6000),
        });
        out.tokenDiag.summary = r.status + " " + (await r.text()).slice(0, 120);
      } catch (e) {
        out.tokenDiag.summary = "ERR " + String((e && e.message) || e);
      }
    }
  } catch (e) {
    out.tokenDiag = { read: "ERR " + String((e && e.message) || e) };
  }
  writeJson(res, out);
}

// ── 自动续对话:watchdog 检测到中断后排队指令,由浏览器端发送到会话 ────────
// conversation 服务是浏览器端(dsh-client-ui-conversation)能力,
// host 只能把"续对话指令"入队,client 插件轮询后真正发送。
//
// 判定依据:只有"服务退出时轮次仍在运行"才是真正的中断,才排队续对话;
// 用户主动结束对话(停止/中止)、任务自然完成、或服务在空闲时退出,
// 一律不自动续对话(否则会反复把已结束/已解决的任务塞回对话)。
let continuePending = null; // { ts, sessionId }

// 看门狗端口:从 dsh 进程参数 --port 动态读取(端口漂移/换机后仍正确),
// 缺省回退 53607(兼容旧布局)。
function serverPortArg() {
  try {
    const i = process.argv.indexOf("--port");
    if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1]);
  } catch { /* noop */ }
  return "53607";
}

// ── 运行状态跟踪(自动续对话的判定依据) ────────────────────────────────────
// 每次 agent 运行状态变化写盘(storages/eac-monitor-runstate.json):
// turn 进行中 → running=true;回到 idle(完成/中止/用户停止)→ running=false。
// 服务崩溃时保留最后一次"运行中"状态,重启后据此决定是否续对话。
const RUN_STATE_FILE = join(HOME, "storages", "eac-monitor-runstate.json");
const RUN_STATE_FRESH_MS = 24 * 3600 * 1000; // 超过 24h 的旧中断不再自动续
const PROCESS_START = Date.now();
// 自动续话总开关:storages/auto-continue.off 存在 = 用户已通过「关闭全部」收工,
// 此后任何方式启动 EAC(含手动双击)都不再自动续对话;该标记由
// 关闭全部.ps1 创建、启动全部.ps1 删除。
const AUTO_CONTINUE_OFF_FILE = join(HOME, "storages", "auto-continue.off");
function autoContinueOff() {
  try { return existsSync(AUTO_CONTINUE_OFF_FILE); } catch { return false; }
}

function readRunState() {
  try {
    return JSON.parse(readFileSync(RUN_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeRunState(st) {
  try {
    writeFileSync(RUN_STATE_FILE, JSON.stringify(st), "utf8");
  } catch { /* 持久化失败忽略 */ }
}

let runState = null; // { sessionId, running, updatedAt, turnStartedAt, continueDeliveredAt }
let runWatchInstalled = false;

function installRunWatcher(ctx) {
  if (runWatchInstalled) return;
  runWatchInstalled = true;
  runState = readRunState() || { sessionId: null, running: false, updatedAt: 0, turnStartedAt: null, continueDeliveredAt: null };
  const touch = (agent, running) => {
    if (!agent || !agent.id) return;
    const now = Date.now();
    const same = runState && runState.sessionId === agent.id;
    const prevRunning = same && runState.running === true;
    const next = {
      sessionId: agent.id,
      running: !!running,
      updatedAt: now,
      // 每轮 turn/start 记录一次时间戳,用于"同一轮只续一次对话"
      turnStartedAt: running && !prevRunning ? now : (same ? runState.turnStartedAt : null),
      continueDeliveredAt: same ? runState.continueDeliveredAt : null,
    };
    if (!runState || runState.sessionId !== next.sessionId || runState.running !== next.running || runState.turnStartedAt !== next.turnStartedAt) {
      runState = next;
      writeRunState(runState);
    } else if (now - (runState.updatedAt || 0) > 10000) {
      runState = { ...runState, updatedAt: now };
      writeRunState(runState);
    }
  };
  ctx.on("agent/status", ({ agent, status }) => touch(agent, status === "running"));
  ctx.on("dispose", () => {
    runWatchInstalled = false;
    runState = null;
  });
}

let bootDecisionMade = false;

function queueContinueIfInterrupted(ctx) {
  installRunWatcher(ctx);
  if (bootDecisionMade) return;
  bootDecisionMade = true;
  // 总开关关闭:用户主动收工后(或手动启动 EAC 时),启动不再自动续对话
  if (autoContinueOff()) {
    ctx.logger?.info?.(`${name}: 自动续话已关闭(auto-continue.off 存在),本次启动不排队自动续对话`);
    return;
  }
  const boot = readRunState();
  const interrupted = boot &&
    boot.running === true &&
    typeof boot.sessionId === "string" &&
    (boot.updatedAt || 0) < PROCESS_START &&
    (Date.now() - (boot.updatedAt || 0)) < RUN_STATE_FRESH_MS &&
    // 同一轮已续过就不再续(即使服务又重启/页面重载了)
    (!boot.continueDeliveredAt || (boot.turnStartedAt || 0) > boot.continueDeliveredAt);
  if (interrupted) {
    continuePending = { ts: Date.now(), sessionId: boot.sessionId };
    ctx.logger?.info?.(`${name}: 检测到上次退出时轮次仍在运行(session=${boot.sessionId}),已排队自动续对话指令`);
  } else {
    ctx.logger?.info?.(`${name}: 上次退出时无运行中的轮次(或该轮已续过),不排队自动续对话`);
  }
}

function httpContinue(_req, res) {
  // 总开关关闭时(watchdog 残留实例仍在跑)一律拒绝续话
  if (autoContinueOff()) {
    writeJson(res, { ok: true, pending: false, note: "自动续话已关闭(auto-continue.off 存在),跳过" });
    return;
  }
  // watchdog 的 down→up 只是"服务恢复"信号;是否续对话以运行状态为准
  if (!runState || runState.running !== true || typeof runState.sessionId !== "string") {
    writeJson(res, { ok: true, pending: false, note: "上次退出时无运行中的轮次,跳过自动续对话" });
    return;
  }
  if (runState.continueDeliveredAt && (runState.turnStartedAt || 0) <= runState.continueDeliveredAt) {
    writeJson(res, { ok: true, pending: false, note: "本轮中断已续过对话,跳过重复续对话" });
    return;
  }
  if (continuePending) {
    writeJson(res, { ok: true, pending: true, sessionId: continuePending.sessionId, note: "续对话指令已在队列" });
    return;
  }
  continuePending = { ts: Date.now(), sessionId: runState.sessionId };
  writeJson(res, { ok: true, pending: true, sessionId: runState.sessionId, note: "续对话指令已排队,由界面层发送" });
}

function httpContinuePending(req, res) {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        if (j && j.clear) continuePending = null;
        // 客户端确认已送达:记录到运行状态,防止服务重启/页面重载后重复注入
        if (j && j.delivered && runState) {
          runState = { ...runState, continueDeliveredAt: Date.now() };
          writeRunState(runState);
        }
      } catch { /* noop */ }
      writeJson(res, { ok: true, pending: false });
    });
    req.on("error", () => writeJson(res, { ok: true, pending: false }));
    return;
  }
  const p = continuePending;
  if (p && Date.now() - p.ts < 300000) {
    writeJson(res, { ok: true, pending: true, ts: p.ts, sessionId: p.sessionId });
  } else {
    writeJson(res, { ok: true, pending: false });
  }
}

function httpPing(_req, res) {
  writeJson(res, { ok: true, ts: Date.now() });
}

// ── v5 原生助手浮窗:每次拉起前把窗口位置预置为屏幕中心 ──────────────────
// EacMonitorFloat 助手按 float-config.json 恢复窗口几何(left/topY,DPI 物理像素),
// 且不带位置参数。每次 spawn 前改写该文件 left/topY 为主显示器工作区中央,
// 保证「每次打开监控都出现在屏幕中间」;用户会话内拖动的位置不受影响。
const CENTER_FLOAT_CFG_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class EacCC {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr h, out MONITORINFO mi);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
"@
[EacCC]::SetProcessDPIAware() | Out-Null
$p = New-Object EacCC+POINT
$mi = New-Object EacCC+MONITORINFO
$mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][EacCC+MONITORINFO])
$mon = [EacCC]::MonitorFromPoint($p, 2)
if ([EacCC]::GetMonitorInfoW($mon, [ref]$mi)) {
  $cfgPath = $env:DSH_FLOAT_CFG
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $w = [int]$cfg.w; $h = [int]$cfg.h
  $l = $mi.rcWork.L + [int](($mi.rcWork.R - $mi.rcWork.L - $w) / 2)
  $t = $mi.rcWork.T + [int](($mi.rcWork.B - $mi.rcWork.T - $h) / 2)
  if ($l -lt $mi.rcWork.L) { $l = $mi.rcWork.L }
  if ($t -lt $mi.rcWork.T) { $t = $mi.rcWork.T }
  $cfg.left = $l; $cfg.topY = $t
  $json = $cfg | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('{"ok":true,"left":' + $l + ',"top":' + $t + '}')
} else { Write-Output '{"ok":false,"reason":"monitor-info-failed"}' }
exit 0
`;

// 幂等:配置文件存在即把位置改为主屏中心(失败静默,不影响助手拉起)
function centerFloatConfig() {
  return new Promise((resolve) => {
    const cfgPath = "D:\\toolresources\\EacMonitorFloat\\float-config.json";
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    if (!existsSync(cfgPath)) { finish({ ok: false, reason: "no-config" }); return; }
    const POWERSHELL = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    let child = null;
    const timer = setTimeout(() => { try { child && child.kill(); } catch { /* noop */ } finish({ ok: false, reason: "timeout" }); }, 20000);
    import("node:child_process").then(({ spawn }) => {
      try {
        child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", CENTER_FLOAT_CFG_PS], {
          env: Object.assign({}, process.env, { DSH_FLOAT_CFG: cfgPath }),
          windowsHide: true,
        });
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, reason: "spawn-error" });
        return;
      }
      let out = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", () => { /* 忽略 */ });
      child.on("error", () => { clearTimeout(timer); finish({ ok: false, reason: "spawn-error" }); });
      child.on("close", () => {
        clearTimeout(timer);
        try { finish(JSON.parse(out.trim() || "{}")); } catch { finish({ ok: false, reason: "bad-output" }); }
      });
    }).catch(() => { clearTimeout(timer); finish({ ok: false, reason: "import-error" }); });
  });
}

// ── remote 服务 ─────────────────────────────────────────────────────────────
class EacMonitorGateway extends TypertRemoteService {
  static inject = ["typert"];

  constructor(ctx) {
    super(ctx, REMOTE_SERVICE);
    for (const m of ["getSnapshot", "attachEdge", "openUsagePage", "getPatchStatus"]) {
      const decorator = Remote(m);
      decorator(EacMonitorGateway.prototype[m], {
        name: m,
        private: false,
        static: false,
        addInitializer: (initializer) => initializer.call(this),
      });
    }
    const typert = ctx.typert;
    if (typert && typeof typert.register === "function") {
      try {
        const dispose = typert.register({
          package: REMOTE_PACKAGE,
          face: "host",
          model: "src",
          schemas: [],
          invocations: REMOTE_INVOCATIONS,
        });
        ctx.on("dispose", () => { try { dispose(); } catch { /* noop */ } });
      } catch (e) {
        ctx.logger?.warn?.(`${name}: typert 注册失败: ${String((e && e.message) || e)}`);
      }
    }
  }

  getSnapshot() {
    return ensureCollect().then(
      (s) => ({ ok: true, value: s }),
      (e) => ({ ok: true, value: Object.assign(snapshot(), { error: String((e && e.message) || e) }) })
    );
  }

  attachEdge() {
    return attachEdge().then(
      (r) => ({ ok: true, value: r }),
      (e) => ({ ok: false, value: { ok: false, hint: String((e && e.message) || e) } })
    );
  }

  openUsagePage() {
    return openUsagePage().then(
      (r) => ({ ok: true, value: r }),
      (e) => ({ ok: true, value: { ok: false, hint: String((e && e.message) || e) } })
    );
  }

  getPatchStatus() {
    return ensurePatches().then(
      (r) => ({ ok: true, value: r }),
      (e) => ({ ok: true, value: { ok: false, reason: String((e && e.message) || e) } })
    );
  }
}

export function apply(ctx) {
  // 诊断:记录 apply 执行(排查 watchdog 反复 spawn)
  ctx.logger?.info?.(`${name}: apply 执行 (ts=${Date.now()}, pid=${process.pid})`);
  // EAC 主进程补丁自愈(EAC 更新覆盖 main.js/preload.js 后自动重打;失败不阻塞插件)
  ensurePatches().catch(() => { /* 静默,getPatchStatus 可查 */ });
  // 应用上下文(自动续对话用,惰性取 sessions)
  let appCtx = ctx;
  // 自动续对话判定:安装运行状态跟踪;仅当上次退出时轮次仍在运行才排队续对话
  queueContinueIfInterrupted(ctx);
  // 原生监控浮窗(v5 壳层浮窗无置顶/透明能力 → 用 EacMonitorFloat 助手,
  // 支持 4.4 时代的 图层(置顶/普通)+ 透明度 设置;独立进程,零冲突)
  const NATIVE_FLOAT_EXE = "D:\\toolresources\\EacMonitorFloat\\EacMonitorFloat.exe";
  let nativeFloatProc = null;
  let nativeFloatSpawning = false;
  // 清掉上一轮宿主留下的浮窗:助手是 detached 拉起的,宿主退出后它仍存活,
  // 不清就会在新宿主里叠出第二个浮窗(设置里改图层/透明度触发的重拉同理)
  function killStrayFloats() {
    return new Promise((resolve) => {
      let child = null;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const POWERSHELL = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const psKill =
        "Get-CimInstance Win32_Process -Filter \"Name='EacMonitorFloat.exe'\" | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      const timer = setTimeout(() => { try { child && child.kill(); } catch { /* noop */ } finish(); }, 8000);
      import("node:child_process").then(({ spawn }) => {
        try {
          child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", psKill], { windowsHide: true, stdio: "ignore" });
        } catch { clearTimeout(timer); finish(); return; }
        child.on("error", () => { clearTimeout(timer); finish(); });
        child.on("close", () => { clearTimeout(timer); finish(); });
      }).catch(() => { clearTimeout(timer); finish(); });
    });
  }
  async function spawnNativeFloat() {
    // 同一 tick 里有两个调用者(模块级 maybeSpawnNativeFloat 与
    // installSettingsSection 的 onChange 首次回调),这里的存活守卫必须同步生效;
    // 否则两者都看到 nativeFloatProc === null,各自 await 完 centerFloatConfig
    // 后各拉一个浮窗
    if (nativeFloatSpawning) return;
    if (nativeFloatProc && !nativeFloatProc.killed) return;
    nativeFloatSpawning = true;
    try {
      if (!existsSync(NATIVE_FLOAT_EXE)) { ctx.logger?.warn?.(`${name}: 原生浮窗助手缺失 ${NATIVE_FLOAT_EXE}`); return; }
      await killStrayFloats();
      // 每次拉起前把助手配置里的窗口位置预置为屏幕中心(助手启动即居中,
      // 实测其按 float-config.json 恢复几何;此步失败不阻塞拉起)
      try { await centerFloatConfig(); } catch (e) { ctx.logger?.warn?.(`${name}: 居中预置失败: ${String((e && e.message) || e)}`); }
      const { spawn } = await import("node:child_process");
      const port = serverPortArg();
      const url = `http://127.0.0.1:${port}/api/eac-monitor/page`;
      const top = cfg.layerMode === "top" ? "1" : "0";
      const args = ["--url", url, "--top", top, "--opacity", "0.88"];
      nativeFloatProc = spawn(NATIVE_FLOAT_EXE, args, { detached: true, stdio: "ignore" });
      nativeFloatProc.unref();
      ctx.logger?.info?.(`${name}: 原生监控浮窗已启动 (${url}, top=${top})`);
    } catch (e) {
      ctx.logger?.warn?.(`${name}: 原生浮窗启动失败: ${String((e && e.message) || e)}`);
    } finally {
      nativeFloatSpawning = false;
    }
  }
  function maybeSpawnNativeFloat() {
    try {
      if (cfg.enabled !== false && cfg.nativeFloat !== false) spawnNativeFloat();
    } catch { /* noop */ }
  }
  maybeSpawnNativeFloat();
  // 自动续对话看门狗:独立进程,检测中断后自动继续对话
  (async () => {
    try {
      // 总开关关闭时不再拉起看门狗(避免「服务恢复」又自动续话)
      if (autoContinueOff()) {
        ctx.logger?.info?.(`${name}: 自动续话已关闭,不启动续话看门狗`);
        return;
      }
      // 已有存活 watchdog 实例则不再 spawn(避免 apply 重复执行时堆积)
      const lockFile = join(process.env.APPDATA || "", "Deepseek Harness EAC", "logs", "eac-watchdog.lock");
      if (existsSync(lockFile)) {
        try {
          const old = Number(readFileSync(lockFile, "utf8").trim());
          if (old && old !== process.pid) {
            let alive = true;
            try { process.kill(old, 0); } catch (e) { alive = false; }
            if (alive) return; // 已有实例在运行
          }
        } catch { /* 锁文件损坏,继续 spawn */ }
      }
      const { spawn } = await import("node:child_process");
      // 看门狗端口动态获取(--port 进程参数),端口漂移后仍能正确探测/续对话
      const wd = spawn(process.execPath, [fileURLToPath(new URL("./continue-watchdog.cjs", import.meta.url)), serverPortArg()], {
        detached: true,
        stdio: "ignore",
      });
      wd.unref();
    } catch (e) {
      ctx.logger?.warn?.(`${name}: 看门狗启动失败: ${String((e && e.message) || e)}`);
    }
  })();
  // 设置命名空间暴露(Web 设置页可编辑)
  ensureSettingsNamespaceExposed("eac-monitor", ctx.logger);
  // 设置热更新(settings.yaml 变化 → cfg 刷新)
  try {
    installSettingsSection(ctx, NS, CONFIG_SCHEMA, { ...CONFIG_DEFAULTS }, {
      setSource: (getter) => { cfgGetter = getter; },
      onChange: () => {
        try { if (cfgGetter) cfg = Object.assign({}, CONFIG_DEFAULTS, cfgGetter()); } catch { /* 保持旧值 */ }
        // 开关变化联动原生浮窗:开启→拉起,关闭→结束助手进程
        try {
          if (cfg.enabled !== false && cfg.nativeFloat !== false) {
            spawnNativeFloat();
          } else if (nativeFloatProc && !nativeFloatProc.killed) {
            nativeFloatProc.kill();
            nativeFloatProc = null;
          }
        } catch { /* noop */ }
      },
    });
  } catch (e) {
    ctx.logger?.warn?.(`${name}: 设置注册失败: ${String((e && e.message) || e)}`);
  }
  // 启动时后台预热一次(不阻塞插件加载)
  tryConnect().then(() => ensureCollect()).catch(() => { /* 预热失败,等首次拉取 */ });
  // 主动定时采集(30 秒):保证 1 分钟档度也有连续数据,不依赖请求触发
  const collectTimer = setInterval(() => {
    ensureCollect().catch(() => { /* 定时采集失败忽略 */ });
  }, COLLECT_INTERVAL_MS);
  ctx.on("dispose", () => clearInterval(collectTimer));
  // 更新公告主动监测:启动即查 + 每 6 小时轮询官方 releases(更新公告源头)
  checkAnnouncements().catch(() => { /* 首次失败等定时重试 */ });
  const updTimer = setInterval(() => {
    checkAnnouncements().catch(() => { /* 轮询失败忽略 */ });
  }, 6 * 3600 * 1000);
  // 补丁完整性检查:每 5 分钟确认 main.js/preload.js 补丁仍在(EAC 更新覆盖后自动重打)
  const integrityTimer = setInterval(() => {
    patchIntegrityCheck().catch(() => { /* 失败等下一轮 */ });
  }, 5 * 60 * 1000);
  ctx.on("dispose", () => {
    clearInterval(updTimer);
    clearInterval(integrityTimer);
  });
  // HTTP 端点:纯监控页 + 数据 + 连接 + 历史 + 配置 + 诊断 + 续对话 + 更新监测(桌面置顶窗专用)
  if (ctx.webServer && typeof ctx.webServer.register === "function") {
    try {
      const d1 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/page", handler: httpPage });
      const d2 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/data", handler: httpData });
      const d3 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/attach-edge", handler: httpAttachEdge });
      const d4 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/history", handler: httpHistory });
      const d5 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/config", handler: httpConfig });
      const d6 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/diag", handler: httpDiag });
      const d7 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/ping", handler: httpPing });
      const d8 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/continue", handler: httpContinue });
      const d9 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/continue-pending", handler: httpContinuePending });
      const d10 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/update-preview", handler: httpUpdatePreview });
      const d11 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/update-status", handler: httpUpdateStatus });
      const d12 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/backups", handler: httpBackups });
      const d13 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/restore-backup", handler: httpRestoreBackup });
      const d14 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/notify-pending", handler: httpNotifyPending });
      const d15 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/update-downloaded", handler: httpUpdateDownloaded });
      const d16 = ctx.webServer.register({ kind: "exact", path: "/api/eac-monitor/open-balance", handler: httpOpenBalance });
      ctx.effect(() => () => {
        try { d1(); d2(); d3(); d4(); d5(); d6(); d7(); d8(); d9(); d10(); d11(); d12(); d13(); d14(); d15(); d16(); } catch { /* 已释放 */ }
      }, "dsh-eac-monitor: routes");
    } catch (e) {
      ctx.logger?.warn?.(`${name}: 路由注册失败: ${String((e && e.message) || e)}`);
    }
  }
  ctx.plugin(EacMonitorGateway);
}

function __dirname2() {
  return new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

export { name, inject, applyMainPatchTo };
