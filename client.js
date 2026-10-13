/**
 * dsh-eac-monitor — browser half.
 *
 * 悬浮监控窗:Token/余额/用量 + 存储空间实时监控。
 *   - shell.overlay 槽位挂载(与 dsh-pet 相同),fixed 定位,可拖拽
 *   - 三个可折叠板块:Token 监控 / 存储监控 / 趋势图(canvas 线形图)
 *   - 可整体最小化成胶囊条,可逐板块伸缩
 *   - 数据经 typert remote 从 host 拉取(3s 轮询)
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-eac-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── v5 壳层浮窗适配 ───────────────────────────────────────────────────
    // v5(Rust 壳)的 float.open 只接受 sessionId,不接受 url/置顶/透明参数,
    // "monitor:auto" 会被当成普通会话窗口打开(里面是空对话)。这里检测到
    // 该浮窗后,由本插件在窗口内铺满 iframe 加载监控页 —— 数据端点与壳层无关,
    // 任何版本都能工作;窗口本身是普通窗口(置顶/透明由壳层决定,无对应 API)。
    var FLOAT_MODE = (typeof window !== "undefined" && window.__DSH_FLOAT__) || null;
    var MONITOR_FLOAT = !!(FLOAT_MODE && String(FLOAT_MODE.sessionId || "") === "monitor:auto");

    // ── CSS ────────────────────────────────────────────────────────────────
    var CSS =
      ".em-root{position:fixed;z-index:2147483646;width:352px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box}" +
      ".em-card{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#101828) 94%,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:hidden;box-sizing:border-box}" +
      ".em-head{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:grab;user-select:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}" +
      ".em-title{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#e6ecff);flex:1;display:flex;align-items:center;gap:6px}" +
      ".em-dot{width:8px;height:8px;border-radius:50%;flex:none}" +
      ".em-btn{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;font-family:inherit;line-height:1.5}" +
      ".em-btn:hover{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:var(--dsw-alias-label-primary,#e6ecff)}" +
      ".em-btn:disabled{opacity:.45;cursor:default}" +
      ".em-btnPrimary{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 30%,transparent)}" +
      ".em-sec{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}" +
      ".em-sec:last-child{border-bottom:none}" +
      ".em-secHead{display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;user-select:none}" +
      ".em-secTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b8c5ea);flex:1}" +
      ".em-chev{font-size:10px;color:var(--dsw-alias-label-tertiary,#6b7aa8);transition:transform .12s ease}" +
      ".em-body{padding:2px 12px 10px;display:flex;flex-direction:column;gap:5px}" +
      ".em-row{display:flex;align-items:baseline;gap:6px;font-size:12px}" +
      ".em-k{color:var(--dsw-alias-label-tertiary,#6b7aa8);flex:1;min-width:0}" +
      ".em-v{color:var(--dsw-alias-label-primary,#e6ecff);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".em-vSub{color:var(--dsw-alias-label-tertiary,#6b7aa8);font-size:10.5px}" +
      ".em-ws{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7aa8);padding-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".em-status{padding:6px 12px;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7aa8);cursor:pointer;user-select:none}" +
      ".em-status:hover{color:var(--dsw-alias-label-secondary,#b8c5ea)}" +
      ".em-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7aa8);padding:0 12px 8px;line-height:1.5;word-break:break-all}" +
      ".em-chart{width:100%;height:88px;display:block}" +
      ".em-seri{display:flex;gap:6px;padding:2px 12px 0}" +
      ".em-chip{font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));color:var(--dsw-alias-label-tertiary,#6b7aa8);cursor:pointer;background:transparent;font-family:inherit}" +
      ".em-chip.on{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff}" +
      ".em-mini{position:fixed;z-index:2147483646;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;cursor:pointer;box-sizing:border-box}" +
      ".em-num{font-variant-numeric:tabular-nums}" +
      ".em-err{font-size:10.5px;color:var(--dsw-alias-state-error-primary,#f87171);padding:0 12px 8px}" +
      ".em-desk{position:fixed;inset:0;z-index:2147482999;background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 96%,transparent);padding:46px 14px 14px;box-sizing:border-box;overflow:auto;display:flex;flex-direction:column;gap:10px;pointer-events:none}" +
      ".em-desk .em-deskCard{pointer-events:auto}" +
      ".em-deskCard{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#101828) 94%,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:10px 12px;box-sizing:border-box;flex:none}" +
      ".em-hero{font-size:24px;font-weight:800;color:var(--dsw-alias-label-primary,#e6ecff);font-variant-numeric:tabular-nums;letter-spacing:.3px}" +
      ".em-heroSub{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7aa8);margin-top:2px}" +
      ".em-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-top:8px}" +
      ".em-deskFoot{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7aa8);text-align:center;padding:2px 0 4px}" +
      ".em-onoff{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;user-select:none}" +
      ".em-switch{appearance:none;width:30px;height:17px;border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;position:relative;cursor:pointer;flex:none;margin:0}" +
      ".em-switch::after{content:'';position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:999px;background:rgba(128,128,128,.6);transition:left .14s ease}" +
      ".em-switch:checked{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#4caf7d) 30%,transparent);border-color:var(--dsw-alias-state-success-primary,#4caf7d)}" +
      ".em-switch:checked::after{left:15px;background:var(--dsw-alias-state-success-primary,#4caf7d)}" +
      ".em-quick{position:fixed;right:14px;bottom:14px;z-index:2147483646;display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#101828) 92%,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));cursor:pointer;user-select:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}" +
      ".em-quick:hover{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}" +
      ".em-quickText{font-size:11px;color:var(--dsw-alias-label-secondary,#b8c5ea)}" +
      ".em-set{max-width:640px;display:flex;flex-direction:column;gap:9px}" +
      ".em-setField{display:flex;flex-direction:column;gap:4px}" +
      ".em-setLabel{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e6ecff);display:flex;align-items:center;gap:6px}" +
      ".em-setHint{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7aa8)}" +
      ".em-setInput{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary,#e6ecff);border-radius:8px;padding:6px 10px;font-size:13px;font-family:inherit;box-sizing:border-box;width:100%}" +
      ".em-setCheck{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);width:16px;height:16px}" +
      ".em-setRow{display:flex;align-items:center;gap:8px}" +
      ".em-setActions{display:flex;gap:8px;align-items:center;margin-top:2px}" +
      ".em-setStatus{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7aa8)}" +
      ".em-setOk{font-size:12px;color:var(--dsw-alias-state-success-primary,#4caf7d)}" +
      ".em-desk::-webkit-scrollbar{width:8px;height:8px}" +
      ".em-desk::-webkit-scrollbar-track{background:transparent}" +
      ".em-desk::-webkit-scrollbar-thumb{background:rgba(139,152,190,.28);border-radius:999px}" +
      ".em-desk::-webkit-scrollbar-thumb:hover{background:rgba(77,107,254,.5)}" +
      ".em-desk::-webkit-scrollbar-corner{background:transparent}" +
      // v5 浮窗铺满层:让出顶部 24px 浮窗条(Rust 壳注入的拖拽/关闭条,z 3000),
      // 自身 z 2999 位于其下;关闭按钮 3001 位于浮窗条下方右缘。
      ".em-floatFull{position:fixed;left:0;right:0;top:24px;bottom:0;z-index:2147482999;background:rgba(11,18,32,.88);box-sizing:border-box}" +
      ".em-floatFull iframe{width:100%;height:100%;border:none;display:block;background:transparent}" +
      ".em-floatTag{position:fixed;top:28px;left:10px;z-index:2147483001;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7aa8);pointer-events:none}";
    var tagId = "dsh-eac-monitor/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-eac-monitor";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "eacMonitor";
    var zh = {
      title: "EAC 监控",
      tokenNav: "Token 与余额",
      storeNav: "存储空间",
      chartNav: "趋势图",
      balance: "账户余额",
      granted: "赠送额度",
      topped: "充值额度",
      available: "可用状态",
      todayTokens: "今日 Token",
      input: "输入",
      output: "输出",
      cache: "缓存命中",
      todayCost: "今日消耗金额",
      noData: "—",
      edgeConnect: "连接 Edge",
      edgeOpen: "打开 usage 页",
      edgeConnected: "Edge 已连接",
      edgeDisconnected: "Edge 未连接(点此连接)",
      curSession: "当前对话文件",
      sessionsTotal: "全部会话文件",
      workspaces: "工作区",
      wsTotal: "工作区合计",
      eacRoot: "EAC 目录",
      dshHome: "~/.dsh 目录",
      seriesBalance: "余额",
      seriesTokens: "Token",
      seriesStorage: "存储",
      minim: "—",
      restore: "展开",
      loading: "加载中…",
      fetching: "采集中…",
      openDesk: "桌面置顶窗",
      autoOpen: "EAC 启动自动打开",
      deskTitle: "EAC 监控 · 桌面置顶窗",
      deskClose: "关闭窗口",
      deskHint: "此窗口始终置顶显示,可拖动顶部标题栏移动位置",
      settingsNav: "EAC 监控",
      settingsIntro: "EAC 监控开关与图表配置。开启后启动即为桌面置顶窗(透明、可调图层);关闭则隐藏全部监控界面。",
      fEnabled: "启用 EAC 监控(启动即桌面置顶窗)",
      fAutoConnect: "启动监控时自动连接 Edge(读取今日消耗/Token)",
      fShowBalance: "显示账户余额",
      fShowTokenStorage: "显示 Token 与存储",
      fChartRange: "图表时间档度",
      fAxisAuto: "数值轴自动范围(最高→当前)",
      fAxisMax: "数值轴上限(自动范围关闭时)",
      fLayerMode: "桌面窗图层",
      optTop: "最上层(盖住游戏/全屏)",
      optNormal: "一般图层(可被游戏覆盖)",
      fNativeFloat: "原生浮窗(v5 壳层不支持置顶/透明时用此模式)",
      quickOn: "EAC 监控 开",
      quickOff: "EAC 监控 关",
    };
    var en = {
      title: "EAC Monitor",
      tokenNav: "Tokens & Balance",
      storeNav: "Storage",
      chartNav: "Trend",
      balance: "Balance",
      granted: "Granted",
      topped: "Topped up",
      available: "Available",
      todayTokens: "Tokens today",
      input: "Input",
      output: "Output",
      cache: "Cache hit",
      todayCost: "Cost today",
      noData: "—",
      edgeConnect: "Connect Edge",
      edgeOpen: "Open usage page",
      edgeConnected: "Edge connected",
      edgeDisconnected: "Edge disconnected (click to connect)",
      curSession: "Current session file",
      sessionsTotal: "All session files",
      workspaces: "Workspaces",
      wsTotal: "Workspaces total",
      eacRoot: "EAC dir",
      dshHome: "~/.dsh dir",
      seriesBalance: "Balance",
      seriesTokens: "Tokens",
      seriesStorage: "Storage",
      minim: "—",
      restore: "Expand",
      loading: "Loading…",
      fetching: "Collecting…",
      openDesk: "Desktop top window",
      autoOpen: "Auto-open on EAC start",
      deskTitle: "EAC Monitor · Desktop",
      deskClose: "Close",
      deskHint: "Always on top; drag the title bar to move",
      settingsNav: "EAC Monitor",
      settingsIntro: "Toggle and chart config for EAC Monitor. On = desktop top window on start; Off = hide all monitor UI.",
      fEnabled: "Enable EAC Monitor (desktop top window on start)",
      fAutoConnect: "Auto-connect Edge on monitor start (today's cost/tokens)",
      fShowBalance: "Show account balance",
      fShowTokenStorage: "Show tokens & storage",
      fChartRange: "Chart time range",
      fAxisAuto: "Auto value axis (max → current)",
      fAxisMax: "Value axis cap (when auto is off)",
      fLayerMode: "Desktop window layer",
      optTop: "Topmost (above games/fullscreen)",
      fNativeFloat: "Native float window (use when the v5 shell lacks top/opacity support)",
      optNormal: "Normal layer (can be covered by games)",
      quickOn: "Monitor On",
      quickOff: "Monitor Off",
    };

    // ── remote face ───────────────────────────────────────────────────────
    var looseCodec = () => ({
      mode: "strict",
      typeSymbol: "dsh-eac-monitor/types#Json",
      schema: { parse: (value) => value },
    });
    var descriptor = (method, parameters) => ({
      id: "dsh-eac-monitor#eacMonitor/" + method,
      service: "eacMonitor",
      namespace: "eacMonitor",
      method: method,
      invocation: { kind: "direct" },
      parameters: parameters.map(function (pn) { return { name: pn, wire: pn, source: "json", codec: looseCodec() }; }),
      result: looseCodec(),
    });
    var REMOTE = {
      package: "dsh-eac-monitor",
      descriptors: [
        descriptor("getSnapshot", []),
        descriptor("attachEdge", []),
        descriptor("openUsagePage", []),
      ],
    };

    // ── 格式化 ────────────────────────────────────────────────────────────
    function fmtBytes(b) {
      if (b === null || b === undefined || isNaN(b)) return zh.noData;
      if (b < 1024) return b + " B";
      if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
      if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
      return (b / 1073741824).toFixed(2) + " GB";
    }
    function fmtNum(n) {
      if (n === null || n === undefined || isNaN(n)) return zh.noData;
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return String(Math.round(n));
    }
    function fmtMoney(n, cur) {
      if (n === null || n === undefined || isNaN(n)) return zh.noData;
      var sym = cur === "CNY" ? "¥" : cur === "USD" ? "$" : (cur ? cur + " " : "");
      var s = n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
      return sym + s;
    }
    function fmtTime(ts) {
      var d = new Date(ts);
      var p = function (v) { return String(v).padStart(2, "0"); };
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    // ── 线形图(canvas 自绘) ───────────────────────────────────────────────
    function Chart(props) {
      var ref = react.useRef(null);
      var points = props.points;
      var color = props.color;
      var label = props.label;
      react.useEffect(function () {
        var canvas = ref.current;
        if (!canvas) return;
        var parent = canvas.parentElement;
        var w = (parent && parent.clientWidth) || 320;
        var dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(88 * dpr);
        canvas.style.width = w + "px";
        canvas.style.height = "88px";
        var ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, 88);
        var data = points || [];
        if (data.length < 2) {
          ctx.fillStyle = "rgba(139,152,190,.6)";
          ctx.font = "11px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(label + " 数据采集中…", w / 2, 44);
          return;
        }
        var vals = data.map(function (p) { return p.v; });
        var min = Math.min.apply(null, vals);
        var max = Math.max.apply(null, vals);
        if (max === min) { max = min + 1; min = min - 1; }
        var pad = 4;
        var padTop = 10;
        var padBot = 14;
        var plotW = w - pad * 2;
        var plotH = 88 - padTop - padBot;
        var x = function (i) { return pad + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW); };
        var y = function (v) { return padTop + plotH - ((v - min) / (max - min)) * plotH; };
        // 网格
        ctx.strokeStyle = "rgba(139,152,190,.15)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var g = 0; g <= 2; g += 1) {
          var gy = padTop + (plotH / 2) * g;
          ctx.moveTo(pad, gy);
          ctx.lineTo(w - pad, gy);
        }
        ctx.stroke();
        // 折线
        ctx.beginPath();
        data.forEach(function (p, i) {
          if (i === 0) ctx.moveTo(x(i), y(p.v));
          else ctx.lineTo(x(i), y(p.v));
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = "round";
        ctx.stroke();
        // 渐变填充
        var grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, color + "55");
        grad.addColorStop(1, color + "00");
        ctx.lineTo(x(data.length - 1), padTop + plotH);
        ctx.lineTo(x(0), padTop + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        // 首尾标签
        ctx.font = "10px system-ui";
        ctx.fillStyle = "rgba(139,152,190,.85)";
        ctx.textAlign = "left";
        ctx.fillText(String(data[0].l !== undefined ? data[0].l : ""), pad, 88 - 4);
        ctx.textAlign = "right";
        ctx.fillStyle = color;
        ctx.fillText(String(data[data.length - 1].l !== undefined ? data[data.length - 1].l : ""), w - pad, 88 - 4);
      }, [points, color, label]);
      return h("canvas", { className: "em-chart", ref: ref });
    }

    // ── 主组件 ─────────────────────────────────────────────────────────────
    function Monitor(props) {
      var t = props.t;
      var remote = props.remote;
      var scope = props.scope;
      // 开关:enabled=true 时由桌面置顶窗取代,软件内悬浮卡隐藏
      var enSt = react.useState(true);
      var enabled = enSt[0];
      react.useEffect(function () {
        if (!scope) return;
        var alive = true;
        var sync = function () {
          var snap = scope.getSnapshot();
          if (alive && snap.status === "ready" && snap.value !== undefined) {
            enSt[1](snap.value.enabled !== false);
          }
        };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        sync();
        return function () { alive = false; if (un) un(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [scope]);
      if (!enabled) return null;
      var st = react.useState({
        minimized: false,
        coll: { token: true, storage: true, chart: true },
        pos: null,
        data: null,
        busy: false,
        note: null,
        series: "balance",
        autoOn: (function () {
          try { return window.localStorage.getItem("eac-monitor-autoopen") !== "0"; } catch (e) { return true; }
        })(),
      });
      var S = st[0];
      var set = st[1];
      var patch = function (p) { set(function (prev) { return Object.assign({}, prev, p); }); };

      // 初始位置:右下角
      react.useEffect(function () {
        try {
          var saved = window.localStorage.getItem("eac-monitor-pos");
          if (saved) { patch({ pos: JSON.parse(saved) }); return; }
        } catch (e) { /* noop */ }
        patch({ pos: { left: Math.max(8, window.innerWidth - 380), top: Math.max(8, window.innerHeight - 460) } });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 自动开启桌面置顶监控窗(EAC 启动即生效;开关关闭或浮窗内不递归)
      react.useEffect(function () {
        if (window.__DSH_FLOAT__) return;
        var br = window.dshDesktop && window.dshDesktop.floatWindow;
        if (!br || typeof br.open !== "function") return;
        var auto = "1";
        try { auto = window.localStorage.getItem("eac-monitor-autoopen") || "1"; } catch (e) { /* noop */ }
        if (auto === "0") return;
        try {
          var snap = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
          if (snap && snap.status === "ready" && snap.value !== undefined && snap.value.enabled === false) return;
        } catch (e) { /* 保持默认开启 */ }
        br.open("monitor:auto").catch(function () { /* 窗口已存在则复用 */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 轮询数据
      react.useEffect(function () {
        var alive = true;
        var load = function () {
          remote().then(function (svc) { return svc.getSnapshot(); }).then(function (res) {
            var v = res && res.ok ? res.value : null;
            if (alive && v) patch({ data: v });
          }).catch(function () { /* 重试 */ });
        };
        load();
        var timer = setInterval(load, 3000);
        return function () { alive = false; clearInterval(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 拖拽
      function onDragStart(ev) {
        var startX = ev.clientX;
        var startY = ev.clientY;
        var base = S.pos || { left: 0, top: 0 };
        function onMove(e) {
          patch({ pos: { left: Math.max(4, base.left + e.clientX - startX), top: Math.max(4, base.top + e.clientY - startY) } });
        }
        function onUp() {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          try { window.localStorage.setItem("eac-monitor-pos", JSON.stringify(S.pos)); } catch (err) { /* noop */ }
        }
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }

      function savePos() {
        try { window.localStorage.setItem("eac-monitor-pos", JSON.stringify(S.pos)); } catch (e) { /* noop */ }
      }

      function toggleSec(key) {
        var next = Object.assign({}, S.coll);
        next[key] = !next[key];
        patch({ coll: next });
      }

      function onAttach() {
        if (S.busy) return;
        patch({ busy: true, note: null });
        remote().then(function (svc) { return svc.attachEdge(); }).then(function (res) {
          var v = res && res.ok ? res.value : null;
          patch({ busy: false, note: v ? (v.hint || (v.ok ? "已连接" : "连接失败")) : "无响应" });
        }).catch(function (e) { patch({ busy: false, note: String((e && e.message) || e) }); });
      }

      var data = S.data;
      var edge = (data && data.edge) || { status: "disconnected" };
      var bal = (data && data.balance) || {};
      var use = (data && data.usage) || {};
      var sto = (data && data.storage) || {};
      var autoOn = S.autoOn;
      var dotColor =
        edge.status === "connected"
          ? (use.status === "ok" ? "#22c55e" : "#eab308")
          : "#ef4444";
      var miniPos = S.pos;

      // 最小化胶囊
      if (S.minimized) {
        return h("div", {
          className: "em-card em-mini",
          style: { left: (miniPos ? miniPos.left : 0) + "px", top: (miniPos ? miniPos.top : 0) + "px" },
          title: t("restore"),
          onClick: function () { patch({ minimized: false }); },
        },
          h("span", { className: "em-dot", style: { background: dotColor } }),
          h("span", { className: "em-title", style: { fontSize: 12 } }, t("title")),
          h("span", { className: "em-vSub" }, bal.status === "ok" ? fmtMoney(bal.total, bal.currency) : t("noData"))
        );
      }

      // 历史序列
      var hist = (data && data.history) || [];
      function seriesPoints(kind, fmt) {
        return hist.map(function (p) {
          var v = p[kind];
          return { v: v, l: v === null ? "" : fmt(v) };
        }).filter(function (p) { return p.v !== null && p.v !== undefined; });
      }
      var seriesMap = {
        balance: {
          key: "balance",
          color: "#4d6bfe",
          label: t("seriesBalance"),
          fmt: function (v) { return fmtMoney(v, bal.currency); },
        },
        tokens: {
          key: "tokens",
          color: "#22c55e",
          label: t("seriesTokens"),
          fmt: function (v) { return fmtNum(v); },
        },
        storage: {
          key: "storage",
          color: "#f59e0b",
          label: t("seriesStorage"),
          fmt: function (v) { return fmtBytes(v); },
        },
      };
      var cur = seriesMap[S.series] || seriesMap.balance;
      var pts = seriesPoints(cur.key, cur.fmt);

      return h("div", {
        className: "em-root",
        style: S.pos ? { left: S.pos.left + "px", top: S.pos.top + "px" } : { right: 12, top: 12 },
      },
        h("div", { className: "em-card" },
          // 头部
          h("div", { className: "em-head", onMouseDown: onDragStart, onMouseUp: savePos },
            h("span", { className: "em-title" },
              h("span", { className: "em-dot", style: { background: dotColor } }),
              t("title")
            ),
            h("button", { className: "em-btn", onClick: function () { patch({ minimized: true }); }, title: t("minim") }, t("minim"))
          ),

          // Token 板块
          h("div", { className: "em-sec" },
            h("div", { className: "em-secHead", onClick: function () { toggleSec("token"); } },
              h("span", { className: "em-chev", style: { transform: S.coll.token ? "rotate(-90deg)" : "none" } }, "▼"),
              h("span", { className: "em-secTitle" }, t("tokenNav"))
            ),
            S.coll.token ? null : h("div", { className: "em-body" },
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("balance")),
                h("span", { className: "em-v" }, bal.status === "ok" ? fmtMoney(bal.total, bal.currency) : t("noData")),
                h("span", { className: "em-vSub" }, bal.status === "ok" && bal.granted != null ? "赠 " + fmtMoney(bal.granted, bal.currency) : "")
              ),
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("todayCost")),
                h("span", { className: "em-v" }, use.cost != null ? fmtMoney(use.cost, use.currency) : t("noData"))
              ),
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("todayTokens")),
                h("span", { className: "em-v" }, use.status === "ok" ? fmtNum(use.tokensIn + use.tokensOut + use.tokensCache) : t("noData"))
              ),
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("input") + " / " + t("output") + " / " + t("cache")),
                h("span", { className: "em-v" },
                  use.status === "ok"
                    ? fmtNum(use.tokensIn) + " / " + fmtNum(use.tokensOut) + " / " + fmtNum(use.tokensCache)
                    : t("noData"))
              ),
              use.detail ? h("div", { className: "em-ws" }, use.detail) : null
            )
          ),

          // 存储板块
          h("div", { className: "em-sec" },
            h("div", { className: "em-secHead", onClick: function () { toggleSec("storage"); } },
              h("span", { className: "em-chev", style: { transform: S.coll.storage ? "rotate(-90deg)" : "none" } }, "▼"),
              h("span", { className: "em-secTitle" }, t("storeNav"))
            ),
            S.coll.storage ? null : h("div", { className: "em-body" },
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("curSession")),
                h("span", { className: "em-v" }, sto.currentSession ? fmtBytes(sto.currentSession.bytes) : t("noData"))
              ),
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("sessionsTotal")),
                h("span", { className: "em-v" }, fmtBytes(sto.sessionsTotal))
              ),
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("eacRoot")),
                h("span", { className: "em-v" }, fmtBytes(sto.eac && sto.eac.bytes))
              ),
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("dshHome")),
                h("span", { className: "em-v" }, fmtBytes(sto.dsh && sto.dsh.bytes))
              ),
              h("div", { className: "em-row" },
                h("span", { className: "em-k" }, t("workspaces")),
                h("span", { className: "em-v" }, fmtBytes(sto.wsTotal))
              ),
              (sto.workspaces || []).map(function (w) {
                return h("div", { className: "em-ws", key: w.path || w.title },
                  w.title + "  " + fmtBytes(w.bytes) + (w.missing ? "  (缺失)" : ""));
              }),
              sto.eac && sto.eac.note ? h("div", { className: "em-ws" }, sto.eac.note) : null
            )
          ),

          // 趋势图板块
          h("div", { className: "em-sec" },
            h("div", { className: "em-secHead", onClick: function () { toggleSec("chart"); } },
              h("span", { className: "em-chev", style: { transform: S.coll.chart ? "rotate(-90deg)" : "none" } }, "▼"),
              h("span", { className: "em-secTitle" }, t("chartNav"))
            ),
            S.coll.chart ? null : h("div", null,
              h("div", { className: "em-seri" },
                Object.keys(seriesMap).map(function (k) {
                  return h("button", {
                    key: k,
                    className: "em-chip" + (S.series === k ? " on" : ""),
                    style: S.series === k ? { borderColor: seriesMap[k].color, color: seriesMap[k].color } : {},
                    onClick: function () { patch({ series: k }); },
                  }, t("series" + k.charAt(0).toUpperCase() + k.slice(1)));
                })
              ),
              h("div", { style: { padding: "2px 12px 4px" } },
                h(Chart, { points: pts, color: cur.color, label: cur.label })
              )
            )
          ),

          // 状态条
          h("div", { className: "em-status", onClick: onAttach },
            h("span", { className: "em-dot", style: { background: dotColor } }),
            h("span", { style: { flex: 1 } },
              edge.status === "connected" ? t("edgeConnected") : t("edgeDisconnected")),
            h("span", { className: "em-vSub" }, data ? fmtTime(data.ts) : "")
          ),
          h("div", { style: { padding: "0 12px 8px", display: "flex", gap: 6 } },
            h("button", { className: "em-btn", disabled: S.busy, onClick: onAttach }, S.busy ? "…" : t("edgeConnect"))
          ),
          h("div", { style: { padding: "0 12px 8px", display: "flex", gap: 6, alignItems: "center" } },
            h("button", { className: "em-btn em-btnPrimary", onClick: function () {
              // nativeFloat:原生助手浮窗由服务端拉起,无需/不可再开壳层浮窗
              try {
                var sn2 = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
                if (sn2 && sn2.status === "ready" && sn2.value && sn2.value.nativeFloat !== false) {
                  patch({ note: "原生浮窗模式:监控窗由 EAC 服务自动拉起(置顶/透明在窗内工具条调节)" });
                  return;
                }
              } catch (e2) { /* noop */ }
              var br = window.dshDesktop && window.dshDesktop.floatWindow;
              if (!br || typeof br.open !== "function") { patch({ note: "仅 EAC 桌面端支持" }); return; }
              br.open("monitor:auto").then(function (r) {
                patch({ note: r && r.ok ? "桌面置顶窗已打开" : ((r && r.error) || "打开失败") });
              }).catch(function (e) { patch({ note: String((e && e.message) || e) }); });
            } }, t("openDesk")),
            h("label", { className: "em-onoff" },
              h("input", { className: "em-switch", type: "checkbox", checked: autoOn, onChange: function (e) {
                var v = e.target.checked;
                try { window.localStorage.setItem("eac-monitor-autoopen", v ? "1" : "0"); } catch (err) { /* noop */ }
                patch({ autoOn: v });
              } }),
              t("autoOpen")
            )
          ),
          S.note ? h("div", { className: "em-hint" }, S.note) : null,
          edge.hint && edge.status !== "connected" ? h("div", { className: "em-hint" }, edge.hint) : null
        )
      );
    }

    // ── 设置页 section(设置 → EAC 监控) ───────────────────────────────────
    var SET_FIELDS = [
      { key: "enabled", label: "fEnabled", type: "checkbox" },
      { key: "autoConnectEdge", label: "fAutoConnect", type: "checkbox" },
      { key: "showBalance", label: "fShowBalance", type: "checkbox" },
      { key: "showTokenStorage", label: "fShowTokenStorage", type: "checkbox" },
      { key: "chartRange", label: "fChartRange", type: "select", options: ["1m", "5m", "10m", "30m", "1h", "2h", "1d", "7d"] },
      { key: "axisAuto", label: "fAxisAuto", type: "checkbox" },
      { key: "axisMax", label: "fAxisMax", type: "number" },
      { key: "layerMode", label: "fLayerMode", type: "select", options: ["top", "normal"], optionLabels: ["optTop", "optNormal"] },
      { key: "nativeFloat", label: "fNativeFloat", type: "checkbox" },
    ];

    function SettingsSection(props) {
      var t = props.t;
      var scope = props.scope;
      var st = react.useState(function () { return scope.getSnapshot(); });
      var snap = st[0];
      var setSnap = st[1];
      var draftSt = react.useState({});
      var draft = draftSt[0];
      var setDraft = draftSt[1];
      var busySt = react.useState(false);
      var busy = busySt[0];
      var setBusy = busySt[1];
      var noticeSt = react.useState(null);
      var notice = noticeSt[0];
      var setNotice = noticeSt[1];

      react.useEffect(function () {
        var alive = true;
        var sync = function () { if (alive) setSnap(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); };
      }, [scope]);

      var ready = snap.status === "ready" && snap.value !== undefined;
      react.useEffect(function () {
        if (ready) {
          var d = {};
          SET_FIELDS.forEach(function (f) {
            d[f.key] = f.type === "checkbox" ? Boolean(snap.value[f.key]) : String(snap.value[f.key] !== undefined ? snap.value[f.key] : "");
          });
          setDraft(d);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snap.status === "unavailable") {
        return h("p", { className: "em-setHint" }, "设置命名空间不可用(服务端未注册 eac-monitor?)");
      }
      if (!ready) return h("p", { className: "em-setStatus" }, "加载中…");

      function fieldVal(f) {
        if (draft[f.key] !== undefined) return draft[f.key];
        if (f.type === "checkbox") return Boolean(snap.value[f.key]);
        return String(snap.value[f.key] !== undefined ? snap.value[f.key] : "");
      }
      function setField(f, v) {
        var next = Object.assign({}, draft);
        next[f.key] = v;
        setDraft(next);
        setNotice(null);
      }
      function onSave() {
        setBusy(true);
        setNotice(null);
        Promise.all(SET_FIELDS.map(function (f) {
          var d = fieldVal(f);
          if (f.type === "checkbox") {
            if (Boolean(d) === Boolean(snap.value[f.key])) return Promise.resolve();
            return Boolean(d) ? scope.set(f.key, true) : scope.unset(f.key);
          }
          if (String(d) === String(snap.value[f.key] !== undefined ? snap.value[f.key] : "")) return Promise.resolve();
          if (String(d).trim() === "") return scope.unset(f.key);
          return scope.set(f.key, f.type === "number" ? Number(d) : d);
        })).then(function () {
          setBusy(false);
          setNotice("saved");
        }).catch(function (e) {
          setBusy(false);
          setNotice("err:" + String((e && e.message) || e));
        });
      }

      return h("div", { className: "em-set" },
        h("p", { className: "em-setHint", style: { margin: 0 } }, t("settingsIntro")),
        SET_FIELDS.map(function (f) {
          if (f.type === "checkbox") {
            return h("label", { key: f.key, className: "em-setField" },
              h("span", { className: "em-setRow" },
                h("input", { className: "em-setCheck", type: "checkbox", checked: Boolean(fieldVal(f)), onChange: function (e) { setField(f, e.target.checked); } }),
                h("span", { className: "em-setLabel" }, t(f.label))
              )
            );
          }
          return h("label", { key: f.key, className: "em-setField" },
            h("span", { className: "em-setLabel" }, t(f.label)),
            h("select", { className: "em-setInput", value: fieldVal(f), onChange: function (e) { setField(f, e.target.value); } },
              (f.options || []).map(function (o, i) {
                var lab = f.optionLabels && f.optionLabels[i] ? t(f.optionLabels[i]) : o;
                return h("option", { key: o, value: o }, lab);
              })
            )
          );
        }),
        h("div", { className: "em-setActions" },
          h("button", { className: "em-btn em-btnPrimary", disabled: busy, onClick: onSave }, busy ? "…" : t("save")),
          notice === "saved" ? h("span", { className: "em-setOk" }, t("saved")) : null,
          notice && String(notice).indexOf("err:") === 0 ? h("span", { className: "em-err" }, String(notice).slice(4)) : null
        )
      );
    }

    // ── v5 浮窗铺满层:sessionId=monitor:auto 的浮窗内 iframe 加载监控页 ──
    // 关闭由壳层 24px 浮窗条的叉叉负责,插件不再画自己的关闭按钮(避免双叉重叠)。
    function MonitorFloatFull(props) {
      var t = props.t;
      return h("div", { className: "em-floatFull" },
        h("iframe", { src: "/api/eac-monitor/page", title: t("title") }),
        h("div", { className: "em-floatTag" }, t("title"))
      );
    }

    // ── 对话界面快捷开关(唯一常驻 UI;监控本体为桌面置顶窗) ────────────────
    function QuickToggle(props) {
      var t = props.t;
      var scope = props.scope;
      var sessions = props.sessions;
      var st = react.useState({ enabled: true });
      var S = st[0];
      var set = st[1];
      react.useEffect(function () {
        var alive = true;
        // EAC 启动自动打开桌面置顶窗(软件内不显示监控卡)
        var openDesk = function () {
          var br = window.dshDesktop && window.dshDesktop.floatWindow;
          if (!br || typeof br.open !== "function") return;
          var auto = "1";
          try { auto = window.localStorage.getItem("eac-monitor-autoopen") || "1"; } catch (e) { /* noop */ }
          if (auto === "0") return;
          br.open("monitor:auto").catch(function () { /* 已存在则复用 */ });
        };
        var sync = function () {
          var snap = scope.getSnapshot();
          if (alive && snap.status === "ready" && snap.value !== undefined) {
            var en = snap.value.enabled !== false;
            set({ enabled: en });
            // nativeFloat:原生助手浮窗由服务端拉起,界面不再打开壳层浮窗
            if (en && snap.value.nativeFloat !== false) return;
            if (en) openDesk();
          }
        };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        sync();
        return function () { alive = false; if (un) un(); };
      }, [scope]);

      // 自动续对话 + 更新公告通知:轮询 host 排队指令,用浏览器端会话服务真正发送
      react.useEffect(function () {
        var alive = true;
        var currentSessionId = function () {
          try {
            return JSON.parse(window.localStorage.getItem("dsh.sessions.current") || "{}").sessionId;
          } catch (e) { return null; }
        };
        var sendToSession = function (text) {
          var sessionId = currentSessionId();
          if (!sessionId) return false;
          var conv = null;
          try {
            if (sessions && typeof sessions.scope === "function") {
              var scoped = sessions.scope(sessionId);
              conv = scoped && scoped.get("conversation");
            }
          } catch (e) { /* 服务未就绪 */ }
          if (conv && typeof conv.send === "function") {
            conv.send(text).catch(function () { /* 发送失败,下轮重试 */ });
            return true;
          }
          return false;
        };
        // 已送达公告 id 去重(页面重载后不重发同一条公告)
        var readDelivered = function () {
          try { return JSON.parse(window.localStorage.getItem("dsh-eac-monitor.delivered") || "[]"); }
          catch (e) { return []; }
        };
        var rememberDelivered = function (id) {
          try {
            var arr = readDelivered();
            if (arr.indexOf(id) < 0) {
              arr.push(id);
              if (arr.length > 100) arr = arr.slice(-100);
              window.localStorage.setItem("dsh-eac-monitor.delivered", JSON.stringify(arr));
            }
          } catch (e) { /* noop */ }
        };
        var ackNotice = function (id) {
          fetch("/api/eac-monitor/notify-pending", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delivered: [id] }),
            cache: "no-store",
          }).catch(function () { /* noop */ });
        };
        // 同一轮中断只注入一次:记住已送达的 pending ts,页面重载后不重发
        var readLastContinue = function () {
          try { return JSON.parse(window.localStorage.getItem("dsh-eac-monitor.lastContinue") || "null"); }
          catch (e) { return null; }
        };
        var rememberContinue = function (ts, sessionId) {
          try { window.localStorage.setItem("dsh-eac-monitor.lastContinue", JSON.stringify({ ts: ts, sessionId: sessionId })); }
          catch (e) { /* noop */ }
        };
        // 用户要求:会话里已经存在"【自动续对话】"这句话时,不再自动续对话,
        // 避免重复排队消息阻塞正常发送。
        var sessionAlreadyContinued = function (sessionId) {
          try {
            if (!sessions || typeof sessions.binding !== "function") return false;
            var b = sessions.binding(sessionId);
            var session = b && b.session;
            if (!session || !Array.isArray(session.events)) return false;
            return session.events.some(function (ev) {
              if (!ev || ev.type !== "user/message" || !ev.data || !Array.isArray(ev.data.content)) return false;
              return ev.data.content.some(function (c) {
                return c && typeof c.text === "string" && c.text.indexOf("【自动续对话】") >= 0;
              });
            });
          } catch (e) { return false; }
        };
        var check = function () {
          fetch("/api/eac-monitor/continue-pending", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!alive || !d || !d.pending) return;
              // 只注入"当时正在运行的那个会话";已结束对话或已换到别的会话则不打扰
              if (d.sessionId && d.sessionId !== currentSessionId()) return;
              // 同一条续对话指令(同一 ts)只注入一次,即使页面在发送后重载
              var last = readLastContinue();
              if (last && last.sessionId === d.sessionId && last.ts === d.ts) return;
              // 会话里已有续对话消息 → 不再注入,并清掉排队指令,恢复手动发送
              if (sessionAlreadyContinued(d.sessionId || currentSessionId())) {
                fetch("/api/eac-monitor/continue-pending", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ clear: true, delivered: true }),
                  cache: "no-store",
                }).catch(function () { /* noop */ });
                return;
              }
              if (sendToSession("【自动续对话】检测到工具执行中断,请先总结上一步完成到哪里,然后继续完成之前的任务。")) {
                if (d.ts && d.sessionId) rememberContinue(d.ts, d.sessionId);
                fetch("/api/eac-monitor/continue-pending", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ clear: true, delivered: true }),
                  cache: "no-store",
                }).catch(function () { /* noop */ });
              }
            })
            .catch(function () { /* 服务重启中 */ });
          // 更新公告/系统通知队列:逐条送达 + 逐条确认,不整批清空、不重发
          fetch("/api/eac-monitor/notify-pending", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!alive || !d || !d.pending || !d.notices || !d.notices.length) return;
              var delivered = readDelivered();
              d.notices.forEach(function (n) {
                if (!n || !n.msg) return;
                if (n.id && delivered.indexOf(n.id) >= 0) return;
                var sent = sendToSession("【EAC 更新监测】" + n.msg);
                if (sent) {
                  if (n.id) rememberDelivered(n.id);
                  if (n.id) ackNotice(n.id);
                }
              });
            })
            .catch(function () { /* 服务重启中 */ });
        };
        check();
        var timer = setInterval(check, 5000);
        return function () { alive = false; clearInterval(timer); };
      }, [sessions]);

      function onToggle() {
        var next = !S.enabled;
        set({ enabled: next });
        scope.set("enabled", next).catch(function () { /* 保存失败 */ });
        // nativeFloat:原生助手浮窗由服务端拉起,快捷开关不打开壳层浮窗
        try {
          var sn3 = scope.getSnapshot();
          if (sn3 && sn3.status === "ready" && sn3.value && sn3.value.nativeFloat !== false) return;
        } catch (e3) { /* noop */ }
        var br = window.dshDesktop && window.dshDesktop.floatWindow;
        if (br && typeof br.open === "function") {
          if (next) br.open("monitor:auto").catch(function () { /* noop */ });
          else if (typeof br.closeMonitor === "function") br.closeMonitor().catch(function () { /* noop */ });
        }
      }

      return h("div", {
        className: "em-quick",
        title: t("settingsNav"),
        onClick: onToggle,
      },
        h("span", { className: "em-dot", style: { background: S.enabled ? "#22c55e" : "#ef4444" } }),
        h("span", { className: "em-quickText" }, S.enabled ? t("quickOn") : t("quickOff"))
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    // 运行时 exports.inject 必须用服务名(cordis ctx.get(name) 门控);
    // manifest/package.json 的 dsh.client.inject 才是 bundle id(依赖解析)。
    // 原版误用 bundle id 导致 rc.2 下 ctx.get("...") 永远 undefined → pending 永不激活。
    var inject = ["slots", "locale", "remote", "settingsScope", "sessions"];

    function apply(ctx, config) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-eac-monitor: dictionaries");

      // 启动即尝试打开桌面置顶监控窗:独立于 remote/settingsScope/slots,
      // 兼容 rc.2 运行时差异;带重试等待 webUrl 就绪。设置就绪前不打开任何
      // 浮窗(nativeFloat 时由服务端拉起原生助手,避免先开壳层浮窗再切换)。
      (function autoOpen() {
        try {
          if (window.__DSH_FLOAT__) {
            // v5 浮窗模式:窗口标题跟随监控页,便于识别
            try { if (MONITOR_FLOAT) document.title = 'EAC 监控'; } catch (e) { /* 忽略 */ }
            return;
          }
          var auto = "1";
          try { auto = window.localStorage.getItem("eac-monitor-autoopen") || "1"; } catch (e) { /* noop */ }
          if (auto === "0") return;
          var sn = null;
          try {
            if (scope && typeof scope.getSnapshot === "function") {
              var s = scope.getSnapshot();
              if (s && s.status === "ready" && s.value) sn = s.value;
            }
          } catch (e) { /* noop */ }
          if (sn) {
            // nativeFloat:原生助手浮窗由服务端拉起,界面不再打开壳层浮窗
            if (sn.nativeFloat !== false && sn.enabled !== false) return;
            var br = window.dshDesktop && window.dshDesktop.floatWindow;
            if (br && typeof br.open === "function") {
              br.open("monitor:auto").catch(function () { /* 已存在则复用 */ });
              return;
            }
          }
        } catch (e) { /* noop */ }
        var tries = (window.__eacMonitorAutoRetries || 0) + 1;
        window.__eacMonitorAutoRetries = tries;
        if (tries <= 5) setTimeout(autoOpen, 1200 * tries);
      })();

      var mountPromise = (ctx.remote && typeof ctx.remote.$mount === "function")
        ? ctx.remote.$mount(REMOTE).then(function (dispose) {
          ctx.effect(function () { return dispose; }, "dsh-eac-monitor: remote face");
          return null;
        }, function (error) {
          console.error("dsh-eac-monitor: remote face mount failed", error);
          throw error;
        })
        : Promise.resolve(null);
      var remote = function () {
        var service = ctx.get("remote.eacMonitor");
        if (service) return Promise.resolve(service);
        return mountPromise.catch(function () {}).then(function () {
          var retry = ctx.get("remote.eacMonitor");
          if (!retry) throw new Error("eacMonitor 远程接口未注册");
          return retry;
        });
      };

      var scope = (ctx.settingsScope && typeof ctx.settingsScope.bind === "function")
        ? ctx.settingsScope.bind({ namespace: "eac-monitor" })
        : null;

      // 设置页 section
      ctx.slots.inject("settings.section", function* () {
        yield ctx.slots.register({
          name: "settings.section",
          id: "eac-monitor-settings",
          order: 30,
          label: function () { return t("settingsNav"); },
          locale: NS,
        }, function (props) {
          if (!scope) return null;
          return h(SettingsSection, Object.assign({}, props, { t: t, scope: scope }));
        });
      });

      // v5 浮窗铺满层:monitor:auto 浮窗内 iframe 加载监控页(壳层无关)
      if (MONITOR_FLOAT) {
        ctx.slots.inject("shell.overlay", function* () {
          yield ctx.slots.register({
            name: "shell.overlay",
            id: "eac-monitor-float-full",
            order: 210,
            label: function () { return t("title"); },
            locale: NS,
          }, function (props) {
            return h(MonitorFloatFull, Object.assign({}, props, { t: t }));
          });
        });
      }

      // 对话界面快捷开关(唯一常驻 UI;监控本体为桌面置顶窗,软件内不显示悬浮卡;
      // v5 的 monitor:auto 浮窗内不挂快捷开关,避免与铺满层重叠)
      if (!MONITOR_FLOAT) {
        ctx.slots.inject("shell.overlay", function* () {
          yield ctx.slots.register({
            name: "shell.overlay",
            id: "eac-monitor-quick",
            order: 130,
            label: function () { return t("settingsNav"); },
            locale: NS,
          }, function (props) {
            if (!scope) return null;
            return h(QuickToggle, Object.assign({}, props, { t: t, scope: scope, sessions: ctx.sessions }));
          });
        });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
