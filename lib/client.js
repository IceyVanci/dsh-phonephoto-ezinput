// dsh-phonephoto-ezinput — browser half（手写 bundle，无构建）
// 两件事：
//   1) 设置页栏目「手机照片便捷输入」：二维码 / 访问链接 / 已配对设备与有效期
//   2) 轮询 /phone-shoot/pending，把队列里的图片交给 conversation.createDrafts（draft 模式实验用）
(function () {
  // 该 bundle 一旦被重复执行（重复安装、重复条目、重复 script 标签），
  // client-modules 会抛 "duplicate factory registration" 并让整个 web boot 失败。
  // 这里先自锁：第二次直接跳过注册。
  var guardKey = "__dshPhonephotoClientRegistered";
  if (window[guardKey]) {
    try { console.warn("[phonephoto] client bundle executed twice, skipped re-registration"); } catch (e) {}
    return;
  }
  window[guardKey] = true;

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
    const SAME = { pending: "/phone-shoot/pending", ack: "/phone-shoot/ack", alive: "/phone-shoot/client-alive" };
    const LEGACY = { pending: "/api/pending", ack: "/api/pending/ack", alive: "/api/client-alive" };

    function log(m) { try { console.info("[phone-shoot] " + m); } catch {} }
    function warn(m) { try { console.warn("[phone-shoot] " + m); } catch {} }

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
      try { await fetch(base + routes.alive, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); }
      catch { resolvedBase = null; return; }
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
      ".ps-steps{margin:6px 0 0;padding-left:18px;font-size:12.5px;line-height:1.9;opacity:.8}",
      ".ps-dev{font-size:12.5px;opacity:.8}",
      ".ps-err{color:#b91c1c;font-size:13px}"
    ].join("");

    function ensureStyle() {
      try {
        if (document.querySelector("style[data-plugin='phonephoto']")) return;
        const el = document.createElement("style");
        el.setAttribute("data-plugin", "phonephoto");
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch {}
    }

    // null = 未探测；"" = 走同源路由；"http://..." = 直连端口
    let panelBaseCache = null;
    async function panelBase(force) {
      if (force) panelBaseCache = null;
      if (panelBaseCache !== null) return panelBaseCache;
      // 优先同源：DSH 的页面 CSP / 跨端口策略可能禁止 connect，直连端口会直接 Failed to fetch
      try {
        const res = await fetch("/phone-shoot/status", { cache: "no-store" });
        if (res.ok) {
          const body = await res.json();
          if (body && body.ok) { panelBaseCache = ""; return ""; }
        }
      } catch (e) {}
      const start = 8788;
      for (let port = start; port < start + 10; port += 1) {
        const base = "http://127.0.0.1:" + port;
        try {
          const res = await fetch(base + "/api/health", { cache: "no-store" });
          if (!res.ok) continue;
          const body = await res.json();
          if (body && body.ok) { panelBaseCache = base; return base; }
        } catch (e) {}
      }
      return null;
    }

    // 同一个动作在「同源」和「直连端口」两种模式下的地址不同
    function panelUrl(base, name, arg) {
      if (base) {
        if (name === "status") return base + "/api/panel";
        if (name === "ttl") return base + "/api/devices/ttl?days=" + encodeURIComponent(arg);
        return base + "/api/devices/revoke?ip=" + encodeURIComponent(arg);
      }
      if (name === "status") return "/phone-shoot/status";
      if (name === "ttl") return "/phone-shoot/ttl?days=" + encodeURIComponent(arg);
      return "/phone-shoot/revoke?ip=" + encodeURIComponent(arg);
    }

    function ageText(ts) {
      if (!ts) return "未知";
      var d = Date.now() - ts;
      if (d < 60000) return "刚刚";
      if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
      if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
      return Math.floor(d / 86400000) + " 天前";
    }

    function Panel() {
      ensureStyle();
      var st = React.useState(null); var status = st[0]; var setStatus = st[1];
      var er = React.useState(""); var error = er[0]; var setError = er[1];
      var bu = React.useState(false); var busy = bu[0]; var setBusy = bu[1];

      var load = React.useCallback(function () {
        panelBase()
          .then(function (base) {
            if (base === null) throw new Error("找不到插件（同源路由与 8788-8797 端口都无响应）");
            return fetch(panelUrl(base, "status"), { cache: "no-store" }).then(function (r) { return r.json(); });
          })
          .then(function (data) { setStatus(data); setError(""); })
          .catch(function (e) {
            // 插件可能重启换了端口（8788 被占用会往后挪）：清掉缓存，下一轮重新探测
            panelBaseCache = null;
            setError(String((e && e.message) || e));
          });
      }, []);

      React.useEffect(function () {
        load();
        var t = setInterval(load, 8000);
        return function () { clearInterval(t); };
      }, [load]);

      var act = React.useCallback(function (name, arg) {
        setBusy(true);
        panelBase()
          .then(function (base) {
            if (base === null) throw new Error("找不到插件");
            return fetch(panelUrl(base, name, arg), { cache: "no-store" });
          })
          .then(function (r) { return r.json(); })
          .then(function () { load(); })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .finally(function () { setBusy(false); });
      }, [load]);

      var h = React.createElement;

      if (error) {
        return h("div", { className: "ps-wrap" },
          h("div", { className: "ps-h" }, "手机照片便捷输入"),
          h("div", { className: "ps-err" }, "读取状态失败：" + error));
      }

      var st2 = status || {};
      var devices = st2.devices || [];
      var urls = st2.urls || [];
      var last = st2.lastUpload || {};

      return h("div", { className: "ps-wrap" },
        h("div", { className: "ps-h" }, "手机照片便捷输入"),
        h("div", { className: "ps-sub" },
          "手机扫码打开网页拍照，图片会作为「待发送」消息挂进你选的对话；回电脑补一句话时一起发出去。手机端无需安装 App，同一局域网即可。"),

        h("div", { className: "ps-card" },
          h("div", { className: "ps-h" }, "怎么用"),
          h("ol", { className: "ps-steps" },
            h("li", null, "手机扫下面的二维码（或打开链接，输入备用码）"),
            h("li", null, "在手机上选一个要投递的对话"),
            h("li", null, "拍照 / 选图 → 预览确认 → 发送"))),

        h("div", { className: "ps-card" },
          h("div", { className: "ps-h" }, "扫码配对"),
          h("div", { className: "ps-qr", dangerouslySetInnerHTML: { __html: st2.svg || "" } }),
          urls.length
            ? urls.map(function (u) {
                return h("div", { className: "ps-url", key: u },
                  h("code", null, u),
                  h("button", { className: "ps-btn", onClick: function () { try { navigator.clipboard.writeText(u); } catch (e) {} } }, "复制"));
              })
            : h("div", { className: "ps-sub" }, "没有检测到局域网 IPv4 地址"),
          h("div", { className: "ps-sub" }, "备用配对码 " + (st2.code || "—") + " · 15 分钟内有效，过期刷新本页")),

        h("div", { className: "ps-card" },
          h("div", { className: "ps-h" }, "已配对设备"),
          h("div", { className: "ps-row" },
            h("span", { className: "ps-sub" }, "有效期"),
            [1, 3, 7, 30].map(function (d) {
              return h("button", {
                key: "ttl" + d,
                className: "ps-btn",
                "data-active": (st2.deviceTtlDays || 0) === d ? "1" : "0",
                disabled: busy,
                onClick: function () { act("ttl", d); }
              }, d + " 天");
            })),
          devices.length
            ? devices.map(function (d) {
                var left = Math.max(0, Math.round(((d.expiresAt || 0) - Date.now()) / 86400000));
                return h("div", { className: "ps-row", key: d.ip },
                  h("span", { className: "ps-dev", style: { flex: 1 } },
                    d.ip + (d.ip === "127.0.0.1" ? "（本机）" : "") + " · 活跃于 " + ageText(d.lastSeenAt) + " · 还剩 " + left + " 天"),
                  h("button", {
                    className: "ps-btn",
                    disabled: busy,
                    onClick: function () { if (confirm("解除 " + d.ip + " 的配对？该设备需要重新扫码。")) act("revoke", d.ip); }
                  }, "删除"));
              })
            : h("div", { className: "ps-sub" }, "还没有设备配对。手机扫码后会自动记录。"),
          devices.length
            ? h("div", { className: "ps-row" },
                h("button", { className: "ps-btn", disabled: busy, onClick: function () { if (confirm("撤销全部设备？所有手机都需要重新扫码。")) act("revoke", "all"); } }, "全部撤销"))
            : null,
          h("div", { className: "ps-sub" },
            "监听端口 " + (st2.port || "—") +
            " · 最近上传 " + (last.at ? (new Date(last.at).toLocaleTimeString("zh-CN", { hour12: false }) + " · " + (last.files || 0) + " 张") : "无") +
            " · UI 心跳 " + ((st2.stats && st2.stats.clientPolls) || 0)))
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
              label: function () { return "手机照片便捷输入"; }
            }, Panel);
          });
        }
      } catch (error) { warn("settings.section 注册失败: " + ((error && error.message) || error)); }

      return () => { stopped = true; if (timer) clearInterval(timer); timer = null; };
    };

    return module.exports;
  }
});
})();
