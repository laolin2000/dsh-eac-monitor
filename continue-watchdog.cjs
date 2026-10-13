/**
 * continue-watchdog.cjs — EAC 监控自动续对话看门狗。
 *
 * 由 dsh-eac-monitor 插件随 EAC 启动拉起的独立进程(不随 dsh web 退出):
 *   1. 每 4 秒探测 dsh web 服务(/api/eac-monitor/ping)。
 *   2. 检测到"服务不可达 → 恢复"(即工具执行中断后的重启)时,
 *      自动 POST /api/eac-monitor/continue,由插件向当前会话发送
 *      "总结上一步并继续"的指令,实现报错后自动续对话。
 *   3. 单实例锁(独占本地端口),冷却 120 秒防重复触发。
 *
 * ── 2026-09-17 修复:单次 ping 超时不再被当成"服务重启"(误报根因) ──────────
 *   旧逻辑下 down→up 只要求"某一次 ping 失败 + 下一次成功";ping 超时仅 3 秒,
 *   而 DSH 后端做磁盘密集操作(写 session.jsonl.zstd / session_projcache.json 等)
 *   时事件循环偶发停顿 >3 秒,于是产生**假恢复**,进而误发续对话指令 ——
 *   实例:2026-09-16 全天 4 次误触发(23:04/23:07/23:28/23:31),而当日
 *   EAC/DSH 四个进程自 12:00 起持续存活 11.9 小时、从未重启。
 *   现改为三重保险:
 *     ① 超时 3s → 10s(容忍瞬时停顿);
 *     ② 连续 FAIL_THRESHOLD 次探测失败才判定 down(消除单点抖动);
 *     ③ 恢复时必须"证据表明服务真的重启过"(ping 的 ts 水位回退 = 服务端时钟
 *        重新开始)才续对话;ts 正常前进 = 服务从未重启 → 只记日志,绝不续话。
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.argv[2] || "53607";
const PING = "http://127.0.0.1:" + PORT + "/api/eac-monitor/ping";
const CONTINUE = "http://127.0.0.1:" + PORT + "/api/eac-monitor/continue";
const PREVIEW = "http://127.0.0.1:" + PORT + "/api/eac-monitor/update-preview";
const DOWNLOADED = "http://127.0.0.1:" + PORT + "/api/eac-monitor/update-downloaded";
const LOG = path.join(process.env.APPDATA || "", "Deepseek Harness EAC", "logs", "eac-continue.log");
const UPDATES_DIR = path.join(process.env.APPDATA || "", "Deepseek Harness EAC", "updates");
const COOLDOWN_MS = 120000;
const INTERVAL_MS = 4000;
const PROBE_TIMEOUT_MS = 10000; // 原 3000:事件循环停顿常超过 3 秒
const FAIL_THRESHOLD = 2;       // 连续失败次数达此值才判定服务 down

function log(m) {
  try {
    fs.appendFileSync(LOG, "[" + new Date().toISOString() + "] " + m + "\n");
  } catch (e) { /* 日志失败忽略 */ }
}

let lastUp = null;   // 上次探测到服务在线的时间戳(null = 当前 down)
let lastTrigger = 0; // 上次触发续对话的时间
let lastSetupSig = null; // 上次看到的更新包签名(null = 首次,只记录不触发)
let failStreak = 0;     // 连续探测失败次数
let tsWatermark = null; // 服务侧时钟水位(所有成功 ping 的 ts 最大值)

// ping 的 ts 是服务端 Date.now():同一进程内只会前进。
// 若恢复后 ts 反而低于停顿前的水位,说明服务端时钟重新开始 → 进程真重启过。
function advancedNormally(ts) {
  return typeof tsWatermark === "number" && typeof ts === "number" && ts >= tsWatermark;
}

async function probe() {
  // 锁归属自检:锁文件持有者不是自己 → 自我退出(防空转堆积)
  try {
    const cur = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (cur !== process.pid) {
      log("锁已由 PID " + cur + " 持有,本实例退出");
      process.exit(0);
    }
  } catch (e) {
    // 锁文件缺失/损坏:尝试重新获取,失败则退出
    if (!acquireLock()) process.exit(0);
  }

  let up = false;
  let pingTs = null;
  try {
    const r = await fetch(PING, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    up = r.ok;
    if (up) {
      try {
        const j = await r.json();
        if (j && typeof j.ts === "number") pingTs = j.ts;
      } catch (e) { /* 非 JSON 响应:ts 缺失,按"无重启证据"处理 */ }
    }
  } catch (e) { up = false; }

  if (up) {
    failStreak = 0;
    if (lastUp === null) {
      // 从 down → up:先要求"服务确实重启过"的证据,再谈续对话
      const now = Date.now();
      if (advancedNormally(pingTs)) {
        // ts 正常前进 = 服务端从未重启,刚才只是超时/停顿 → 误报,绝不续话
        log("服务恢复但服务端未重启(ts 正常前进),判定为误报,不续对话");
      } else if (now - lastTrigger > COOLDOWN_MS) {
        lastTrigger = now;
        log("检测到服务重启(down→up),发送自动续对话指令");
        try {
          const c = await fetch(CONTINUE, { method: "POST", signal: AbortSignal.timeout(20000) });
          const text = await c.text();
          log("continue 响应 " + c.status + ": " + text.slice(0, 300));
        } catch (e) {
          log("continue 请求失败: " + String((e && e.message) || e));
        }
      } else {
        log("检测到服务重启,冷却期内跳过");
      }
    }
    if (pingTs !== null) tsWatermark = pingTs;
    lastUp = Date.now();
  } else {
    failStreak++;
    if (failStreak >= FAIL_THRESHOLD && lastUp !== null) {
      log("连续 " + failStreak + " 次探测失败,判定服务 down");
      lastUp = null;
    }
    // 首次失败(failStreak=1)不改状态:单次抖动不足以认定服务消失
  }
}

// 更新包检测:updates 目录出现/变化 Setup exe → 自动请求更新预览(补丁兼容性检查)
// 并通知 host 触发公告核查(备份留底 + 试打验证)
async function checkUpdates() {
  try {
    const files = fs.readdirSync(UPDATES_DIR).filter((f) => /Setup.*\.exe$/i.test(f));
    if (!files.length) return;
    const f = files[0];
    const st = fs.statSync(path.join(UPDATES_DIR, f));
    const sig = f + "|" + st.size + "|" + st.mtimeMs;
    if (lastSetupSig !== null && sig !== lastSetupSig) {
      log("检测到新更新包: " + f + " (" + Math.round(st.size / 1048576) + "MB),自动执行更新预览(补丁兼容性检查)");
      try {
        const r = await fetch(PREVIEW, { signal: AbortSignal.timeout(45000) });
        const text = await r.text();
        log("更新预览结果: " + text.slice(0, 600));
      } catch (e) {
        log("更新预览请求失败: " + String((e && e.message) || e));
      }
      try {
        const r = await fetch(DOWNLOADED, { method: "POST", signal: AbortSignal.timeout(20000) });
        const text = await r.text();
        log("更新包下载通知结果: " + text.slice(0, 300));
      } catch (e) {
        log("更新包下载通知失败: " + String((e && e.message) || e));
      }
    }
    lastSetupSig = sig;
  } catch (e) { /* updates 目录不存在 */ }
}

// ── 单实例锁(文件锁 + PID 存活检查;Windows 端口锁不可靠) ─────────────────
const LOCK_FILE = path.join(process.env.APPDATA || "", "Deepseek Harness EAC", "logs", "eac-watchdog.lock");

function acquireLock() {
  const pid = process.pid;
  try {
    // 独占创建
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, String(pid));
    fs.closeSync(fd);
    log("watchdog 已获取锁 (PID " + pid + ")");
    return true;
  } catch (e) {
    // 文件已存在:检查持有者是否存活
    try {
      const old = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (old && old !== pid) {
        let alive = true;
        try { process.kill(old, 0); } catch (err) { alive = err && err.code === "EPERM"; }
        if (alive) {
          log("已有实例 PID " + old + " 在运行,本实例退出");
          return false;
        }
        // 持有者已死 → 接管
        try { fs.writeFileSync(LOCK_FILE, String(pid)); log("接管失效锁 (原 PID " + old + ")"); return true; } catch (e2) { return false; }
      }
    } catch (e3) { /* 锁文件损坏 */ }
    try { fs.writeFileSync(LOCK_FILE, String(pid)); return true; } catch (e4) { return false; }
  }
}

function releaseLock() {
  try {
    const cur = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (cur === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* 已不存在 */ }
}

(function main() {
  if (!acquireLock()) process.exit(0);
  log("watchdog 启动,监视端口 " + PORT);
  // 初始探测:记录当前状态,避免首次误触发
  (async () => {
    try {
      const r = await fetch(PING, { signal: AbortSignal.timeout(3000) });
      if (r.ok) lastUp = Date.now();
    } catch (e) { lastUp = null; }
    setInterval(probe, INTERVAL_MS);
    checkUpdates();
    setInterval(checkUpdates, 60000);
  })();
  process.on("exit", releaseLock);
})();
