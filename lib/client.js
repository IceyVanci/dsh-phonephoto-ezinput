// dsh-phonephoto-ezinput — browser half（手写 bundle，无构建）
// 两件事：
//   1) 设置页栏目「📷 手机拍照」：二维码 / 访问链接 / 投递模式 / 已配对设备
//   2) 轮询 /dsh-phonephoto-ezinput/pending，把队列里的图片交给 conversation.createDrafts（draft 模式实验用）
window.__ModuleLoader__.load({
  id: "dsh-phonephoto-ezinput",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    let React = null;
    try { React = require("react"); } catch (error) { /* 没有 react 也要能跑轮询 */ }

    /* ---------------- 轮询（draft 队列） ---------------- */
    const seen = new Set();
    let timer = null;
    let stopped = false;
    let resolvedBase = null;
    let routes = null;
    const SAME = { pending: "/dsh-phonephoto-ezinput/pending", ack: "/dsh-phonephoto-ezinput/ack", alive: "/dsh-phonephoto-ezinput/client-alive" };
    const LEGACY = { pending: "/api/pending", ack: "/api/pending/ack", alive: "/api/client-alive" };

    function log(m) { try { console.info("[dsh-phonephoto-ezinput] " + m); } catch {} }
    function warn(m) { try { console.warn("[dsh-phonephoto-ezinput] " + m); } catch {} }

    async function resolveBase(config) {
      if (resolvedBase !== null) return resolvedBase;
      try {
        const res = await fetch(SAME.pending, { cache: "no-store" });
        if (res.ok) { resolvedBase = ""; routes = SAME; return resolvedBase; }
      } catch {}
      const host = (config && config.server && config.server.clientHost) || "127.0.0.1";
      const start = (config && config.server && config.server.port) || 8788;
      for (let port = start; port < start + 10; port += 1) {
        const candidate = "http://" + host + ":" + port;
        try {
          const res = await fetch(candidate + "/api/health", { cache: "no-store" });
          if (res.ok) { resolvedBase = candidate; routes = LEGACY; return resolvedBase; }
        } catch {}
      }
      return null;
    }

    async function tick(ctx, config) {
      if (stopped) return;
      const base = await resolveBase(config);
      if (base === null) return;
      try { await fetch(base + routes.alive, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch {}
      const conversation = (typeof ctx.get === "function" ? ctx.get("conversation") : undefined) || ctx.conversation;
      if (!conversation || typeof conversation.createDrafts !== "function") return;
      let items = [];
      try {
        const res = await fetch(base + routes.pending, { cache: "no-store" });
        if (!res.ok) return;
        items = ((await res.json()) || {}).items || [];
      } catch { return; }
      if (!items.length) return;
      const consumed = [];
      for (const item of items) {
        if (seen.has(item.id)) continue;
        try {
          const bin = atob(item.data || "");
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          conversation.createDrafts(item.sessionId, [new File([bytes], item.name || "photo.jpg", { type: item.mediaType || "image/jpeg" })]);
          seen.add(item.id);
          consumed.push(item.id);
        } catch (error) { warn("createDrafts 失败: " + ((error && error.message) || error)); }
      }
      if (consumed.length) {
        try { await fetch(base + routes.ack, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: consumed }) }); } catch {}
      }
    }

    /* ---------------- 设置页面板 ---------------- */
    const CSS = [
      ".ps-wrap{max-width:720px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,inherit)}",
      ".ps-card{border:1px solid rgba(127,127,127,.22);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}",
      ".ps-h{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px}",
      ".ps-sub{font-size:12.5px;opacity:.65;line-height:1.6}",
      ".ps-qr{display:flex;justify-content:center;padding:6px}",
      ".ps-qr svg{width:220px;height:auto;background:#fff;padding:8px;border-radius:8px}",
      ".ps-url{display:flex;align-items:center;gap:8px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;word-break:break-all}",
      ".ps-url code{flex:1;padding:6px 8px;background:rgba(127,127,127,.12);border-radius:6px}",
      ".ps-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".ps-btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.28);background:transparent;color:inherit;cursor:pointer}",
      ".ps-btn[data-active='1']{background:#2563eb;border-color:#2563eb;color:#fff}",
      ".ps-dev{font-size:12.5px;opacity:.8}",
      ".ps-err{color:#b91c1c;font-size:13px}"
    ].join("");

    function ensureStyle() {
      try {
        if (document.querySelector("style[data-plugin='dsh-phonephoto-ezinput']")) return;
        const el = document.createElement("style");
        el.setAttribute("data-plugin", "dsh-phonephoto-ezinput");
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch {}
    }

    let panelBaseCache = null;
    async function panelBase() {
      if (panelBaseCache) return panelBaseCache;
      const start = 8788;
      for (let port = start; port < start + 10; port += 1) {
        const base = "http://127.0.0.1:" + port;
        try {
          const res = await fetch(base + "/api/health", { cache: "no-store" });
          if (!res.ok) continue;
          const body = await res.json();
          if (body && body.ok) { panelBaseCache = base; return base; }
        } catch {}
      }
      return null;
    }

    function Panel() {
      ensureStyle();
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(() => {
        panelBase()
          .then((base) => {
            if (!base) throw new Error("找不到插件端口（8788-8797）");
            return fetch(base + "/api/panel", { cache: "no-store" }).then((r) => r.json());
          })
          .then((data) => { setStatus(data); setError(""); })
          .catch((e) => setError(String((e && e.message) || e)));
      }, []);

      React.useEffect(() => {
        load();
        const t = setInterval(load, 8000);
        return () => clearInterval(t);
      }, [load]);

      const switchMode = React.useCallback((value) => {
        setBusy(true);
        panelBase()
          .then((base) => fetch(base + "/api/mode?value=" + encodeURIComponent(value), { cache: "no-store" }))
          .then((r) => r.json())
          .then(() => load())
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false));
      }, [load]);

      const act = React.useCallback((path) => {
        setBusy(true);
        panelBase()
          .then((base) => fetch(base + path, { cache: "no-store" }))
          .then((r) => r.json())
          .then(() => load())
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false));
      }, [load]);

      const h = React.createElement;
      if (error) return h("div", { className: "ps-wrap" }, h("div", { className: "ps-err" }, "读取状态失败：" + error));

      const s = status || {};
      const devices = s.devices || [];
      const urls = s.urls || [];
      const modes = s.modeSwitchable || [];

      return h("div", { className: "ps-wrap" },
        h("div", { className: "ps-h" }, "📷 手机拍照"),
        h("div", { className: "ps-sub" }, "手机扫码打开网页拍照，图片按所选模式进入对话。手机端无需安装任何 App，同一局域网即可。"),

        h("div", { className: "ps-card" },
          h("div", { className: "ps-h" }, "扫码配对"),
          h("div", { className: "ps-qr", dangerouslySetInnerHTML: { __html: s.svg || "" } }),
          urls.length
            ? urls.map((u) => h("div", { className: "ps-url", key: u },
                h("code", null, u),
                h("button", { className: "ps-btn", onClick: () => { try { navigator.clipboard.writeText(u); } catch {} } }, "复制")))
            : h("div", { className: "ps-sub" }, "没有检测到局域网 IPv4 地址"),
          h("div", { className: "ps-sub" }, "备用配对码：" + (s.code || "—") + "（15 分钟内有效，过期刷新本页）")
        ),

        h("div", { className: "ps-card" },
          h("div", { className: "ps-h" }, "投递模式"),
          h("div", { className: "ps-row" }, modes.map((m) => h("button", {
            key: m,
            className: "ps-btn",
            "data-active": s.mode === m ? "1" : "0",
            disabled: busy,
            onClick: () => switchMode(m)
          }, m))),
          h("div", { className: "ps-sub" },
            "inbox：作为待发送消息挂在对话里（默认）｜ display：直接写入对话不唤醒 ｜ followup：写入并唤醒 ｜ steer：插入当前回合 ｜ draft：输入框草稿（当前版本不显示）")
        ),

        h("div", { className: "ps-card" },
          h("div", { className: "ps-h" }, "已配对设备（按 IP）"),
          h("div", { className: "ps-row" },
            h("span", { className: "ps-sub" }, "有效期"),
            [1, 3, 7, 30].map((d) => h("button", {
              key: "ttl" + d,
              className: "ps-btn",
              "data-active": (s.deviceTtlDays || 0) === d ? "1" : "0",
              disabled: busy,
              onClick: () => act("/api/devices/ttl?days=" + d)
            }, d + " 天"))),
          devices.length
            ? devices.map((d) => {
                const left = Math.max(0, Math.round(((d.expiresAt || 0) - Date.now()) / 86400000));
                return h("div", { className: "ps-row", key: d.ip },
                  h("span", { className: "ps-dev", style: { flex: 1 } },
                    d.ip + (d.ip === "127.0.0.1" ? "（本机）" : "") + " · 还剩 " + left + " 天"),
                  h("button", {
                    className: "ps-btn",
                    disabled: busy,
                    onClick: () => { if (confirm("解除 " + d.ip + " 的配对？")) act("/api/devices/revoke?ip=" + encodeURIComponent(d.ip)); }
                  }, "删除"));
              })
            : h("div", { className: "ps-sub" }, "暂无已配对设备"),
          devices.length
            ? h("div", { className: "ps-row" },
                h("button", { className: "ps-btn", disabled: busy, onClick: () => { if (confirm("撤销全部设备？")) act("/api/devices/revoke?ip=all"); } }, "全部撤销"))
            : null,
          h("div", { className: "ps-sub" },
            "监听端口 " + (s.port || "—") + " · 上传 " + ((s.stats && s.stats.uploads) || 0) + " 次 · UI 心跳 " + ((s.stats && s.stats.clientPolls) || 0))
        )
      );
    }

    /* ---------------- 入口 ---------------- */
    exports.inject = ["slots"];

    exports.apply = function apply(ctx, config) {
      log("client half ready");
      const interval = Math.max(800, (config && config.clientPollMs) || 2000);
      const run = () => { tick(ctx, config).catch((e) => warn("tick failed: " + ((e && e.message) || e))); };
      run();
      timer = setInterval(run, interval);

      try {
        if (ctx.slots && typeof ctx.slots.inject === "function" && React) {
          ctx.slots.inject("settings.section", function () {
            return ctx.slots.register({
              name: "settings.section",
              id: "dsh-phonephoto-ezinput",
              order: 40,
              label: function () { return "📷 手机拍照"; }
            }, Panel);
          });
        }
      } catch (error) { warn("settings.section 注册失败: " + ((error && error.message) || error)); }

      return () => { stopped = true; if (timer) clearInterval(timer); timer = null; };
    };

    return module.exports;
  }
});
