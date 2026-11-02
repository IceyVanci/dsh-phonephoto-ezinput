// phone-shoot — 页面模板（错误页 / 二维码页 / 手机页）
import { readFileSync, statSync } from "node:fs";

const PHONE_URL = new URL("./phone-page.html", import.meta.url);
let phoneCache = { mtime: -1, html: "" };

/** 按 mtime 缓存读取模板：改页面只需要刷新浏览器，不必重启应用。 */
function phoneHtml() {
  try {
    const mtime = statSync(PHONE_URL).mtimeMs;
    if (mtime !== phoneCache.mtime) phoneCache = { mtime, html: readFileSync(PHONE_URL, "utf8") };
  } catch {}
  return phoneCache.html;
}

const CSS = `
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#111; --muted:#666; --card:#fff; --line:#e5e5e5; --accent:#2563eb; --danger:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0b0c; --fg:#f2f2f2; --muted:#9a9a9a; --card:#151517; --line:#2a2a2e; --accent:#60a5fa; --danger:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 24px 18px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 8px 0; }
  .muted { color: var(--muted); font-size: 14px; }
  .card { background: var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-top:16px; }
  .qr { display:flex; justify-content:center; padding:8px; }
  .qr svg { width: min(78vw, 320px); height:auto; border-radius:8px; background:#fff; padding:8px; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; word-break: break-all; }
  .url { display:block; padding:8px 10px; background:var(--bg); border:1px dashed var(--line); border-radius:8px; margin:6px 0; }
  .code { font: 600 30px/1 ui-monospace, Consolas, monospace; letter-spacing: 8px; text-align:center; padding:12px 0 6px; }
  .err { color: var(--danger); }
  button { font: inherit; padding:10px 14px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
`;

function shell(nonce, title, body) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style nonce="${nonce}">${CSS}</style>
</head><body><main>${body}</main></body></html>`;
}

export function renderErrorPage(options) {
  const reason = options.reason;
  const messages = {
    expired: ["二维码已过期", "这个配对链接的有效期已过。请在电脑上重新生成二维码，或使用电脑上的 /qr 页面查看最新链接。"],
    bad: ["链接无效", "配对 token 不正确。请重新扫码，或在电脑上打开 /qr 页面重新生成。"],
    none: ["需要配对", "请扫描电脑上的二维码，或在手机浏览器输入配对码。"]
  };
  const info = messages[reason] || messages.none;
  const body = [
    "<h1 class=\"err\">" + info[0] + "</h1>",
    "<p>" + info[1] + "</p>",
    "<p class=\"muted\">为安全起见，本页面不会显示任何对话信息。</p>"
  ].join("");
  return shell(options.nonce, "phone-shoot · " + info[0], body);
}

export function renderQrPage(options) {
  const urls = options.urls || [];
  const devices = options.devices || [];
  const remaining = Math.max(0, Math.round((options.expiresAt - Date.now()) / 1000));
  const urlHtml = urls.length
    ? urls.map((u) => "<code class=\"url\">" + u + "</code>").join("")
    : "<p class=\"err\">没有检测到非回环 IPv4 地址，手机无法通过局域网访问。</p>";
  const body = [
    "<h1>手机照片便捷输入</h1>",
    "<p class=\"muted\">用手机相机扫描下方二维码（同一 Wi-Fi）。</p>",
    "<div class=\"card\"><div class=\"qr\">" + (options.svg || "") + "</div></div>",
    "<div class=\"card\"><p class=\"muted\">备用：手机浏览器打开下面任一地址，输入配对码</p>",
    urlHtml,
    "<p class=\"muted\">配对码（" + remaining + " 秒内有效）</p>",
    "<div class=\"code\">" + options.code + "</div>",
    "<div class=\"row\"><button onclick=\"location.reload()\">刷新二维码</button></div></div>",
    "<div class=\"card\"><p class=\"muted\">已配对设备（按 IP 去重）：",
    devices.length
      ? "<ul style=\"margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--muted)\">" + devices.map((d) => { var left = Math.max(0, Math.round(((d.expiresAt || 0) - Date.now()) / 86400000)); return "<li>" + (d.ip || "unknown") + (d.ip === "127.0.0.1" || d.ip === "::1" ? "（本机）" : "") + " · 还剩 " + left + " 天</li>"; }).join("") + "</ul>"
      : "无",
    "</p></div>",
    "<p class=\"muted\">本页面仅限本机（127.0.0.1）访问，链接里包含配对 token，请勿截图外传。</p>"
  ].join("");
  return shell(options.nonce, "phone-shoot · 配对", body);
}

export function renderPhonePage(options) {
  const config = options.config || {};
  const values = {
    "__NONCE__": options.nonce,
    "__MAX_FILES__": String(config.maxFiles != null ? config.maxFiles : 4),
    "__MAX_BYTES__": String(config.maxBytes != null ? config.maxBytes : 10485760),
    "__MAX_TOTAL__": String(config.maxTotalBytes != null ? config.maxTotalBytes : 26214400),
    "__MAX_EDGE__": String(config.targetMaxEdge != null ? config.targetMaxEdge : 2048),
    "__QUALITY__": String(config.quality != null ? config.quality : 0.85)
  };
  let html = phoneHtml();
  for (const key of Object.keys(values)) html = html.split(key).join(values[key]);
  return html;
}
