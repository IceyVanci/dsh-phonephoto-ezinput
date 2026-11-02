// dsh-phonephoto-ezinput — host 半边：局域网 HTTP 服务 + 配对 + 手机页 + 投递
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import qrcode from "./vendor/qrcode-generator.js";
import { renderErrorPage, renderQrPage, renderPhonePage } from "./phone-page.js";
import { normalizeRows, rowFromSummary, buildSessionList, toWire } from "./sessions.js";

export const name = "dsh-phonephoto-ezinput";

const VERSION = "0.1.0";
const LOG = "[phonephoto]";
const COOKIE = "ps_device";

const DEFAULTS = {
  server: { host: "0.0.0.0", port: 8788, portRetries: 10, privateOnly: true },
  pairing: { ttlMs: 900000, persistDevices: true, pairMaxFailures: 5, deviceTtlMs: 604800000 },
  deviceTtlMs: 2592000000,
  upload: { maxFiles: 4, maxBytes: 10485760, maxTotalBytes: 26214400, targetMaxEdge: 2048, quality: 0.85, ratePerMinute: 12 },
  inject: { mode: "inbox", noteTemplate: "发送自 {ip}", sourceKind: "user", pendingTtlMs: 600000 },
  sessions: { recentWindowMs: 600000 },
  logUrls: true
};

function merge(base, extra) {
  if (extra === null || typeof extra !== "object" || Array.isArray(extra)) return base;
  const out = Object.assign({}, base);
  for (const key of Object.keys(extra)) {
    const a = base[key];
    const b = extra[key];
    out[key] = a && typeof a === "object" && !Array.isArray(a) && b && typeof b === "object" && !Array.isArray(b) ? merge(a, b) : b;
  }
  return out;
}

function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

// 局域网专用：短 token 足够（去掉易混字符 0/O/1/l/I）
const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function randomToken(length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += TOKEN_ALPHABET[crypto.randomInt(0, TOKEN_ALPHABET.length)];
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function dshHome() { return process.env.DSH_HOME || path.join(os.homedir(), ".dsh"); }

// 消息正文里的说明行：默认「发送自 <IP>」，{ip} 会被换成请求来源地址。
// 早先的 inject.notePrefix（固定文案）已废弃，出现时忽略。
function renderNote(inject, ip) {
  const template = inject && typeof inject.noteTemplate === "string" ? inject.noteTemplate : "";
  if (!template.trim()) return "";
  return template.replace(/\{ip\}/g, ip || "未知设备");
}

function svc(ctx, name) {
  try { const value = ctx && typeof ctx.get === "function" ? ctx.get(name) : undefined; if (value) return value; } catch {}
  return ctx ? ctx[name] : undefined;
}

function isPrivateAddress(address) {
  if (!address) return false;
  const addr = String(address).replace(/^::ffff:/i, "");
  if (addr === "127.0.0.1" || addr === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = addr.toLowerCase();
  return lower === "::1" || lower.indexOf("fc") === 0 || lower.indexOf("fd") === 0 || lower.indexOf("fe80") === 0;
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const key of Object.keys(ifaces)) {
    for (const info of ifaces[key] || []) {
      if (info.family === "IPv4" && !info.internal) out.push({ name: key, address: info.address });
    }
  }
  return out;
}

function securityHeaders(nonce) {
  return {
    "content-security-policy": "default-src 'none'; img-src 'self' data: blob:; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

class Pairing {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.current = null;
    this.previous = null;
  }
  issue() {
    this.previous = this.current;
    this.current = {
      token: randomToken(8),
      code: String(crypto.randomInt(0, 1000000)).padStart(6, "0"),
      expiresAt: Date.now() + this.ttlMs
    };
    return this.current;
  }
  ensure() {
    if (!this.current || Date.now() >= this.current.expiresAt) this.issue();
    return this.current;
  }
  checkToken(token) {
    if (!token) return "missing";
    const now = Date.now();
    if (this.current && safeEqual(token, this.current.token)) return now < this.current.expiresAt ? "ok" : "expired-token";
    if (this.previous && safeEqual(token, this.previous.token)) return "expired-token";
    return "bad-token";
  }
  checkCode(code) {
    const pair = this.ensure();
    if (Date.now() >= pair.expiresAt) return false;
    return safeEqual(code, pair.code);
  }
}

class DeviceStore {
  constructor(file, ttlMs, persist) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.persist = persist;
    this.devices = [];
    this.load();
  }
  load() {
    if (!this.persist) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const now = Date.now();
      if (Array.isArray(raw.devices)) {
        const kept = raw.devices.filter((d) => d && typeof d.hash === "string" && d.expiresAt > now && d.ip);
        const dropped = raw.devices.length - kept.length;
        if (dropped > 0) console.warn(LOG, "pruned " + dropped + " legacy device record(s) without ip");
        this.devices = DeviceStore.unique(kept);
      }
    } catch {}
  }
  save() {
    if (!this.persist) return;
    try {
      const now = Date.now();
      this.devices = DeviceStore.unique(this.devices.filter((d) => d.expiresAt > now));
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ devices: this.devices }, null, 2), { mode: 384 });
      try { fs.chmodSync(this.file, 384); } catch {}
    } catch (error) {
      console.warn(LOG, "device store write failed:", error && error.message ? error.message : String(error));
    }
  }
  add(label, ip) {
    const now = Date.now();
    const existing = this.devices.find((d) => d.ip === ip && d.expiresAt > now);
    if (existing) {
      const rotation = crypto.randomBytes(24).toString("base64url");
      existing.hash = sha256(rotation);
      existing.expiresAt = now + this.ttlMs;
      this.save();
      return { cookie: existing.id + "." + rotation, device: existing };
    }
    const id = crypto.randomBytes(9).toString("base64url");
    const secret = crypto.randomBytes(24).toString("base64url");
    const device = { id, hash: sha256(secret), label: String(label || "device").slice(0, 40), ip: ip || null, createdAt: now, expiresAt: now + this.ttlMs };
    this.devices.push(device);
    this.save();
    return { cookie: id + "." + secret, device };
  }
  setTtl(ms) {
    this.ttlMs = Math.max(60000, Number(ms) || this.ttlMs);
    const now = Date.now();
    for (const device of this.devices) {
      device.expiresAt = Math.max(now, device.lastSeenAt || device.createdAt || now) + this.ttlMs;
    }
    this.save();
  }
  revokeIp(ip) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.ip !== ip);
    this.save();
    return before - this.devices.length;
  }
  byIp(ip) {
    if (!ip) return null;
    const now = Date.now();
    return this.devices.find((d) => d.ip === ip && d.expiresAt > now) || null;
  }
  touch(device) {
    const now = Date.now();
    if (now - (device.lastSeenAt || 0) < 3600000) return;
    device.lastSeenAt = now;
    device.expiresAt = now + this.ttlMs;
    this.save();
  }
  verify(value) {
    const parts = String(value || "").split(".");
    if (parts.length !== 2) return null;
    const device = this.devices.find((d) => d.id === parts[0]);
    if (!device || device.expiresAt <= Date.now()) return null;
    return safeEqual(sha256(parts[1]), device.hash) ? device : null;
  }
  revokeAll() {
    this.devices = [];
    this.save();
  }
  static unique(devices) {
    const seen = new Map();
    for (const device of devices) {
      const key = device.ip || device.id;
      const previous = seen.get(key);
      if (!previous || (device.createdAt || 0) > (previous.createdAt || 0)) seen.set(key, device);
    }
    return [...seen.values()];
  }
  list() {
    return this.devices.map((d) => ({ id: d.id, label: d.label, ip: d.ip || null, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt || d.createdAt, expiresAt: d.expiresAt }));
  }
}

class PairFailures {
  constructor(max) { this.max = max; this.map = new Map(); }
  blockedMs(ip) {
    const entry = this.map.get(ip);
    if (!entry || !entry.until) return 0;
    return Math.max(0, entry.until - Date.now());
  }
  fail(ip) {
    const entry = this.map.get(ip) || { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= this.max) {
      const over = entry.count - this.max;
      entry.until = Date.now() + Math.min(60000, 1000 * Math.pow(2, Math.min(over, 6)));
    }
    this.map.set(ip, entry);
  }
  reset(ip) { this.map.delete(ip); }
}

function sniffImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const delimiter = Buffer.from("--" + boundary);
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    const end = buffer.indexOf(delimiter, cursor + delimiter.length);
    if (end === -1) break;
    const headerStart = cursor + delimiter.length;
    if (buffer[headerStart] === 0x2d && buffer[headerStart + 1] === 0x2d) break;
    const section = buffer.subarray(headerStart + 2, end - 2);
    const split = section.indexOf("\r\n\r\n");
    if (split > 0) {
      const headers = section.subarray(0, split).toString("utf8");
      const data = section.subarray(split + 4);
      const nameMatch = /name="([^"]*)"/.exec(headers);
      const fileMatch = /filename="([^"]*)"/.exec(headers);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
      parts.push({ name: nameMatch ? nameMatch[1] : "", filename: fileMatch ? fileMatch[1] : "", contentType: typeMatch ? typeMatch[1].trim() : "", data });
    }
    cursor = end;
  }
  return parts;
}

function qrSvg(text, cellSize) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cellSize || 6, margin: 4, scalable: true });
}

export function apply(ctx, rawConfig) {
  const config = merge(DEFAULTS, rawConfig || {});
  const logFile = path.join(dshHome(), "phone-shoot", "phone-shoot.log");
  const appendLog = (level, message) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const line = new Date().toISOString() + " [" + level + "] " + message + "\n";
      fs.appendFileSync(logFile, line);
      if (fs.statSync(logFile).size > 1048576) fs.renameSync(logFile, logFile + ".1");
    } catch {}
  };
  const log = (level, message) => {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger[level] === "function") logger[level](LOG + " " + message);
    else if (level === "warn" || level === "error") console.warn(LOG, message);
    else console.log(LOG, message);
    appendLog(level, message);
  };

  const pairing = new Pairing(config.pairing.ttlMs);
  const deviceTtlMs = config.pairing.deviceTtlMs || config.deviceTtlMs || 604800000;
  const devices = new DeviceStore(path.join(dshHome(), "phone-shoot", "devices.json"), deviceTtlMs, config.pairing.persistDevices !== false);
  const failures = new PairFailures(config.pairing.pairMaxFailures || 5);
  const settingsFile = path.join(dshHome(), "phone-shoot", "settings.json");
  const savedSettings = (() => { try { return JSON.parse(fs.readFileSync(settingsFile, "utf8")) || {}; } catch { return {}; } })();
  if (Number(savedSettings.deviceTtlMs) > 0) devices.setTtl(Number(savedSettings.deviceTtlMs));
  const saveSettings = () => {
    try {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ deviceTtlMs: devices.ttlMs }, null, 2), { mode: 384 });
    } catch (error) { log("warn", "settings write failed: " + (error && error.message)); }
  };

  const stamps = new Map();
  const pending = [];
  const pendingTotal = () => pending.reduce((sum, item) => sum + item.data.length, 0);
  const pendingPayload = () => {
    prunePending();
    return { ok: true, items: pending.map((item) => ({ id: item.id, sessionId: item.sessionId, name: item.name, mediaType: item.mediaType, createdAt: item.createdAt, data: item.data.toString("base64") })) };
  };
  const ackPending = (ids) => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (ids.includes(pending[index].id)) pending.splice(index, 1);
    }
    return pending.length;
  };
  const prunePending = () => {
    const now = Date.now();
    const ttl = config.inject.pendingTtlMs || 600000;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (now - pending[index].createdAt > ttl) pending.splice(index, 1);
    }
    while (pending.length > 20 || pendingTotal() > 41943040) pending.shift();
  };
  const counters = { pairs: 0, uploads: 0, sessions: 0, lastUploadAt: 0, lastUploadBytes: 0, lastUploadFiles: 0, clientSeenAt: 0, clientPolls: 0 };
  const startedAt = Date.now();
  const deviceCookie = (value) => COOKIE + "=" + encodeURIComponent(value) + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + Math.floor(config.deviceTtlMs / 1000);
  const uploadHits = new Map();
  const allowUpload = (ip) => {
    const now = Date.now();
    if (uploadHits.size > 256) {
      for (const [key, times] of uploadHits) {
        if (!times.length || now - times[times.length - 1] > 60000) uploadHits.delete(key);
      }
    }
    const hits = (uploadHits.get(ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= (config.upload.ratePerMinute || 12)) { uploadHits.set(ip, hits); return false; }
    hits.push(now);
    uploadHits.set(ip, hits);
    return true;
  };

  const baseUrls = () => lanAddresses().map((entry) => "http://" + entry.address + ":" + state.port + "/");
  const tokenUrls = () => {
    const pair = pairing.ensure();
    return baseUrls().map((base) => base + "?t=" + pair.token);
  };

  const state = { server: null, port: 0 };

  // 同源路由：给 DSH Web UI 的 client 半边用（避免跨端口 + CSP 限制）
  const registerWebRoutes = (webCtx) => {
    try {
      const ws = (webCtx && (webCtx.webServer || svc(webCtx, "webServer"))) || svc(ctx, "webServer");
      if (!ws || typeof ws.register !== "function") { log("warn", "webServer unavailable; same-origin routes skipped"); return; }
      const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
      ws.register({ kind: "exact", path: "/phone-shoot/pending", handler: async (req, res) => {
        if (req.method !== "GET") return json(res, 405, { ok: false });
        return json(res, 200, pendingPayload());
      } });
      ws.register({ kind: "exact", path: "/phone-shoot/ack", handler: async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { ok: false });
        let ids = [];
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        } catch { return json(res, 400, { ok: false }); }
        return json(res, 200, { ok: true, remaining: ackPending(ids) });
      } });
      ws.register({ kind: "exact", path: "/phone-shoot/status", handler: async (req, res) => {
        const pair = pairing.ensure();
        const urls = tokenUrls();
        return json(res, 200, {
          ok: true,
          version: VERSION,
          port: state.port,
          mode: config.inject.mode,
          modeSwitchable: ["draft", "display", "inbox", "followup", "steer"],
          urls,
          code: pair.code,
          expiresAt: pair.expiresAt,
          svg: urls.length ? qrSvg(urls[0]) : "",
          devices: devices.list().map((d) => ({ ip: d.ip || "unknown", createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, expiresAt: d.expiresAt })),
          stats: { uploads: counters.uploads, sessions: counters.sessions, clientPolls: counters.clientPolls || 0, pending: pending.length }
        });
      } });
      ws.register({ kind: "exact", path: "/phone-shoot/mode", handler: async (req, res) => {
        const inner = new URL(req.url || "/", "http://dsh.invalid");
        const value = inner.searchParams.get("value");
        if (value && ["draft", "display", "inbox", "followup", "steer"].includes(value)) {
          config.inject.mode = value;
          log("info", "inject mode switched to " + value + " (settings panel)");
        }
        return json(res, 200, { ok: true, mode: config.inject.mode });
      } });
      ws.register({ kind: "exact", path: "/phone-shoot/client-alive", handler: async (req, res) => {
        counters.clientSeenAt = Date.now();
        counters.clientPolls = (counters.clientPolls || 0) + 1;
        return json(res, 200, { ok: true });
      } });
      log("info", "same-origin routes registered (/phone-shoot/*)");
    } catch (error) {
      log("warn", "webServer route registration failed: " + (error && error.message));
    }
  };
  try {
    if (typeof ctx.inject === "function") ctx.inject(["webServer"], (webCtx) => registerWebRoutes(webCtx));
    else registerWebRoutes(ctx);
  } catch (error) { log("warn", "webServer inject threw: " + (error && error.message)); }

  const handler = async (req, res) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const url = new URL(req.url || "/", "http://localhost");
    const ip = (req.socket && req.socket.remoteAddress) || "";
    const send = (status, payload, extraHeaders) => {
      const isText = typeof payload === "string";
      const headers = Object.assign({}, securityHeaders(nonce), {
        "content-type": isText ? "text/html; charset=utf-8" : "application/json; charset=utf-8"
      }, extraHeaders || {});
      res.writeHead(status, headers);
      res.end(isText ? payload : JSON.stringify(payload));
    };
    const fail = (status, code, message) => send(status, { ok: false, code, message });

    try {
      if (config.server.privateOnly !== false && !isPrivateAddress(ip)) {
        return fail(403, "forbidden-network", "only private network clients are accepted");
      }

      const remoteIp = String(ip).replace(/^::ffff:/i, "");
      const cookies = parseCookies(req.headers.cookie);
      const cookieDevice = devices.verify(cookies[COOKIE]);
      const ipDevice = devices.byIp(remoteIp);
      if (ipDevice) devices.touch(ipDevice);
      const device = cookieDevice || ipDevice;
      const tokenParam = url.searchParams.get("t");
      const tokenState = tokenParam ? pairing.checkToken(tokenParam) : "missing";
      // 已配对 IP：忽略 token 是否正确（含缺失/过期/错误），直接放行
      const authed = !!device || tokenState === "ok";

      if (url.pathname === "/api/health") {
        return send(200, { ok: true, version: VERSION, port: state.port, mode: config.inject.mode, clientSeenAt: counters.clientSeenAt || 0 }, { "access-control-allow-origin": "*" });
      }

      if (url.pathname === "/qr") {
        const remote = String(ip).replace(/^::ffff:/i, "");
        if (remote !== "127.0.0.1" && remote !== "::1") return fail(403, "forbidden-network", "loopback only");
        const pair = pairing.ensure();
        const urls = tokenUrls();
        const svg = urls.length ? qrSvg(urls[0]) : "";
        return send(200, renderQrPage({ nonce, svg, urls, code: pair.code, expiresAt: pair.expiresAt, devices: devices.list(), loopbackOnly: true }));
      }

      if (url.pathname === "/api/pair" && req.method === "POST") {
        const blocked = failures.blockedMs(ip);
        if (blocked > 0) return fail(429, "rate-limited", "too many attempts, retry in " + Math.ceil(blocked / 1000) + "s");
        let body = {};
        try {
          const raw = await readBody(req, 4096);
          body = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          failures.fail(ip);
          return fail(400, "bad-request", "invalid body");
        }
        const code = String(body.code || "").trim();
        if (code && pairing.checkCode(code)) {
          failures.reset(ip);
          const created = devices.add(body.label || "phone", String(ip).replace(/^::ffff:/i, ""));
          counters.pairs += 1;
          return send(200, { ok: true, device: { id: created.device.id, label: created.device.label, expiresAt: created.device.expiresAt } }, {
            "set-cookie": deviceCookie(created.cookie)
          });
        }
        failures.fail(ip);
        return fail(401, "bad-token", "配对码错误或已过期");
      }

      if (url.pathname === "/api/sessions") {
        if (!authed) return fail(401, tokenState === "expired-token" ? "expired-token" : "bad-token", "设备未授权或已过期，请重新扫码");
        const controller = svc(ctx, "sessionController");
        if (!controller || typeof controller.list !== "function") return fail(503, "sessions-unavailable", "缺少 sessionController.list，DSH 版本可能不兼容");
        const raw = await controller.list();
        const summaries = normalizeRows(raw);
        counters.listShape = Array.isArray(raw) ? "array[" + raw.length + "]" : raw && typeof raw === "object" ? "object{" + Object.keys(raw).join(",") + "}" : typeof raw;
        counters.listRows = summaries.length;
        if (!Array.isArray(raw) && summaries.length === 0) {
          log("warn", "sessionController.list() shape unknown: " + counters.listShape);
        }
        const liveStore = svc(ctx, "sessions");
        const titleService = svc(ctx, "sessionTitle");
        const titleOf = (id) => {
          try {
            const session = liveStore && typeof liveStore.get === "function" ? liveStore.get(id) : undefined;
            if (!session) return undefined;
            const snapshot = titleService && typeof titleService.get === "function" ? titleService.get(session) : undefined;
            return snapshot && snapshot.title ? snapshot.title : undefined;
          } catch { return undefined; }
        };
        const rows = summaries.map((summary) => rowFromSummary(summary, titleOf));
        const registry = svc(ctx, "workspaceRegistry");
        const workspaces = [];
        if (registry && typeof registry.list === "function") {
          for (const workspace of registry.list()) {
            let missing = false;
            try { missing = (await workspace.status()) === "missing-dir"; } catch {}
            workspaces.push({
              id: workspace.id || (workspace.record && workspace.record.id) || workspace.path,
              title: workspace.title,
              path: workspace.path,
              sessionIds: workspace.sessionIds || [],
              missing
            });
          }
        }
        const archived = new Set(registry && registry.archivedSessionIds ? registry.archivedSessionIds : []);
        const list = buildSessionList({ rows, workspaces, archived, stamps, recentWindowMs: config.sessions.recentWindowMs, now: Date.now() });
        counters.sessions += 1;
        return send(200, Object.assign({ ok: true }, toWire(list)));
      }

      if (url.pathname === "/api/client-alive") {
        const cors0 = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
        if (req.method === "OPTIONS") { res.writeHead(204, Object.assign({}, securityHeaders(nonce), cors0)); return res.end(); }
        counters.clientSeenAt = Date.now();
        counters.clientPolls = (counters.clientPolls || 0) + 1;
        return send(200, { ok: true }, cors0);
      }

      if (url.pathname === "/api/pending" || url.pathname === "/api/pending/ack") {
        // 草稿队列里是未发送的原图，只给本机（DSH UI）或已配对设备读，别开给整个局域网
        const pendingRemote = String(ip).replace(/^::ffff:/i, "");
        const pendingLoopback = pendingRemote === "127.0.0.1" || pendingRemote === "::1";
        if (!pendingLoopback && !authed) return fail(403, "forbidden-network", "loopback or paired device only");
        const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
        if (req.method === "OPTIONS") { res.writeHead(204, Object.assign({}, securityHeaders(nonce), cors)); return res.end(); }
        if (url.pathname === "/api/pending") {
          prunePending();
          return send(200, { ok: true, items: pending.map((item) => ({ id: item.id, sessionId: item.sessionId, name: item.name, mediaType: item.mediaType, createdAt: item.createdAt, data: item.data.toString("base64") })) }, cors);
        }
        let ids = [];
        try {
          const raw = await readBody(req, 8192);
          const body = JSON.parse(raw.toString("utf8") || "{}");
          ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        } catch { return send(400, { ok: false, code: "bad-request" }, cors); }
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          if (ids.includes(pending[index].id)) pending.splice(index, 1);
        }
        return send(200, { ok: true, remaining: pending.length }, cors);
      }

      if (url.pathname === "/api/mode") {
        const remote = String(ip).replace(/^::ffff:/i, "");
        if (remote !== "127.0.0.1" && remote !== "::1") return fail(403, "forbidden-network", "loopback only");
        const requested = url.searchParams.get("value");
        if (requested && ["draft", "display", "inbox", "followup", "steer"].includes(requested)) {
          config.inject.mode = requested;
          log("info", "inject mode switched to " + requested);
        }
        return send(200, { ok: true, mode: config.inject.mode, changed: !!requested }, { "access-control-allow-origin": "*" });
      }

      if (url.pathname === "/api/devices" || url.pathname === "/api/devices/revoke" || url.pathname === "/api/devices/ttl") {
        const remote = String(ip).replace(/^::ffff:/i, "");
        const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
        if (remote !== "127.0.0.1" && remote !== "::1") return fail(403, "forbidden-network", "loopback only");
        if (req.method === "OPTIONS") { res.writeHead(204, Object.assign({}, securityHeaders(nonce), cors)); return res.end(); }
        if (url.pathname === "/api/devices/revoke") {
          const target = url.searchParams.get("ip");
          if (target === "all") { devices.revokeAll(); return send(200, { ok: true, removed: "all", devices: devices.list() }, cors); }
          if (!target) return fail(400, "bad-request", "ip required");
          const removed = devices.revokeIp(target);
          log("info", "device revoked: " + target + " (removed=" + removed + ")");
          return send(200, { ok: true, removed, devices: devices.list() }, cors);
        }
        if (url.pathname === "/api/devices/ttl") {
          const days = Number(url.searchParams.get("days"));
          if (days > 0) { devices.setTtl(Math.round(days * 86400000)); saveSettings(); log("info", "device ttl set to " + days + " days"); }
          return send(200, { ok: true, days: Math.round(devices.ttlMs / 86400000), devices: devices.list() }, cors);
        }
        return send(200, { ok: true, days: Math.round(devices.ttlMs / 86400000), devices: devices.list() }, cors);
      }

      if (url.pathname === "/api/panel") {
        const remote = String(ip).replace(/^::ffff:/i, "");
        if (remote !== "127.0.0.1" && remote !== "::1") return fail(403, "forbidden-network", "loopback only");
        const pair = pairing.ensure();
        const urls = tokenUrls();
        return send(200, {
          ok: true,
          version: VERSION,
          port: state.port,
          mode: config.inject.mode,
          deviceTtlDays: Math.round(devices.ttlMs / 86400000),
          lastUpload: { at: counters.lastUploadAt || 0, bytes: counters.lastUploadBytes || 0, files: counters.lastUploadFiles || 0, sessionId: counters.lastSessionId || null },
          urls,
          code: pair.code,
          expiresAt: pair.expiresAt,
          svg: urls.length ? qrSvg(urls[0]) : "",
          devices: devices.list().map((d) => ({ ip: d.ip || "unknown", createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, expiresAt: d.expiresAt })),
          stats: { uploads: counters.uploads, sessions: counters.sessions, clientPolls: counters.clientPolls || 0, pending: pending.length }
        }, { "access-control-allow-origin": "*" });
      }

      if (url.pathname === "/api/diagnostics") {
        const remote = String(ip).replace(/^::ffff:/i, "");
        if (remote !== "127.0.0.1" && remote !== "::1") return fail(403, "forbidden-network", "loopback only");
        return send(200, {
          ok: true,
          version: VERSION,
          port: state.port,
          uptimeMs: Date.now() - startedAt,
          counters,
          devices: devices.list().map((d) => ({ id: d.id, label: d.label, ip: d.ip, createdAt: d.createdAt, expiresAt: d.expiresAt })),
          limits: { maxFiles: config.upload.maxFiles, maxBytes: config.upload.maxBytes, maxTotalBytes: config.upload.maxTotalBytes },
          mode: config.inject.mode,
          pending: pending.length,
          clientSeenAt: counters.clientSeenAt || 0,
          clientPolls: counters.clientPolls || 0
        });
      }

      if (url.pathname === "/api/upload" && req.method === "POST") {
        if (!authed) return fail(401, tokenState === "expired-token" ? "expired-token" : "bad-token", "设备未授权或已过期，请重新扫码");
        if (!allowUpload(ip)) return fail(429, "rate-limited", "too many uploads, retry in a minute");
        const contentType = String(req.headers["content-type"] || "");
        const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
        if (!boundaryMatch) return fail(400, "bad-request", "multipart boundary required");
        const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim();
        let body;
        try { body = await readBody(req, config.upload.maxTotalBytes + 1048576); }
        catch { return fail(413, "file-too-large", "request body exceeds limit"); }
        const parts = parseMultipart(body, boundary);
        const sessionField = parts.find((part) => part.name === "sessionId");
        const sessionId = sessionField ? sessionField.data.toString("utf8").trim() : "";
        const files = parts.filter((part) => part.name === "files" || part.name === "files[]");
        if (files.length === 0) return fail(400, "bad-request", "no files field");
        if (files.length > config.upload.maxFiles) return fail(400, "too-many-files", "at most " + config.upload.maxFiles + " files");
        const images = [];
        let totalBytes = 0;
        for (const file of files) {
          if (file.data.length > config.upload.maxBytes) return fail(413, "file-too-large", "single file exceeds " + config.upload.maxBytes + " bytes");
          const mediaType = sniffImage(file.data);
          if (!mediaType) return fail(415, "unsupported-type", "only jpeg/png/webp are accepted");
          totalBytes += file.data.length;
          if (totalBytes > config.upload.maxTotalBytes) return fail(413, "file-too-large", "total exceeds limit");
          images.push({ data: file.data, mediaType, name: file.filename || "photo.jpg" });
        }
        if (!sessionId) return fail(400, "bad-request", "sessionId required");

        if (config.inject.mode === "draft") {
          prunePending();
          const created = images.map((image) => ({
            id: crypto.randomUUID(),
            sessionId,
            name: image.name || "photo.jpg",
            mediaType: image.mediaType,
            data: image.data,
            createdAt: Date.now()
          }));
          for (let index = pending.length - 1; index >= 0; index -= 1) {
            if (pending[index].sessionId === sessionId) pending.splice(index, 1);
          }
          for (const item of created) pending.push(item);
          counters.uploads += 1;
          counters.lastUploadAt = Date.now();
          counters.lastUploadBytes = totalBytes;
          counters.lastUploadFiles = created.length;
          counters.lastSessionId = sessionId;
          log("info", "draft queued: session=" + sessionId + " files=" + created.length + " bytes=" + totalBytes);
          return send(200, { ok: true, mode: "draft", delivered: false, received: created.length, totalBytes, sessionId, pendingIds: created.map((item) => item.id) });
        }

        const agents = svc(ctx, "agents");
        const attachments = svc(ctx, "attachments");
        if (!agents || !attachments) return fail(503, "delivery-unavailable", "缺少 agents/attachments 服务");
        let agent = agents.get(sessionId);
        let resumed = false;
        if (!agent) {
          try {
            const handle = await agents.resume({ resumeSessionId: sessionId });
            agent = handle && handle.agent ? handle.agent : handle;
            resumed = true;
          } catch (error) {
            log("warn", "resume failed for " + sessionId + ": " + (error && error.message));
            return fail(409, "session-closed", "该对话已关闭，请另选");
          }
        }
        if (!agent) return fail(409, "session-closed", "该对话已关闭，请另选");

        let refs;
        try {
          refs = await attachments.saveImages(images);
        } catch (error) {
          const code = String((error && error.code) || "");
          const mapped = { TOO_MANY_IMAGES: [400, "too-many-files"], IMAGES_TOO_LARGE: [413, "file-too-large"], UNSUPPORTED_IMAGE_TYPE: [415, "unsupported-type"] }[code] || [500, "attachment-failed"];
          log("warn", "saveImages failed: " + code + " " + (error && error.message));
          return fail(mapped[0], mapped[1], "附件入库失败：" + (error && error.message ? error.message : code));
        }

        let createUserMessage;
        try { ({ createUserMessage } = await import("@deepseek-ai/dsh-llm")); }
        catch (error) { return fail(500, "delivery-failed", "无法加载 dsh-llm：" + String(error && error.message)); }

        const content = [];
        const noteText = renderNote(config.inject, String(ip).replace(/^::ffff:/i, ""));
        if (noteText) content.push({ type: "text", text: noteText });
        for (const ref of refs) content.push({ type: "image", attachment: ref });
        const message = createUserMessage({ content, source: { kind: config.inject.sourceKind || "user" } });

        try {
          if (config.inject.mode === "inbox") {
            if (typeof agent.inject !== "function") throw new Error("当前会话不支持排队投递（agent.inject 不可用）");
            agent.inject(message);
          } else if (config.inject.mode === "steer") {
            agent.steer(message);
          } else if (config.inject.mode === "followup") {
            agent.followup(message);
          } else {
            const session = agent.session;
            if (!session || typeof session.append !== "function") throw new Error("当前会话不支持写入（session.append 不可用）");
            session.append("user/message", message, { surfaceOp: "append" });
          }
        } catch (error) {
          log("warn", "deliver failed for " + sessionId + ": " + (error && error.message));
          return fail(500, "delivery-failed", "投递失败：" + (error && error.message));
        }

        const deliveredAt = Date.now();
        stamps.set(sessionId, deliveredAt);
        counters.uploads += 1;
        counters.lastUploadAt = deliveredAt;
        counters.lastUploadBytes = totalBytes;
        counters.lastUploadFiles = refs.length;
        counters.lastSessionId = sessionId;
        log("info", "delivered: session=" + sessionId + " files=" + refs.length + " bytes=" + totalBytes + " mode=" + config.inject.mode + " resumed=" + resumed + " ms=" + (deliveredAt - startedAt));
        return send(200, {
          ok: true,
          received: refs.length,
          totalBytes,
          sessionId,
          resumed,
          mode: config.inject.mode,
          deliveredAt,
          refs: refs.map((ref) => ({ attachmentId: ref.attachmentId, mediaType: ref.mediaType, width: ref.width, height: ref.height })),
          delivered: true
        });
      }

      if (url.pathname === "/api/pairing") {
        if (!authed) return fail(401, tokenState === "expired-token" ? "expired-token" : "bad-token", "设备未授权或已过期，请重新扫码");
        const pair = pairing.ensure();
        return send(200, { ok: true, port: state.port, urls: tokenUrls(), code: pair.code, expiresAt: pair.expiresAt, devices: devices.list() });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (!authed) {
          const reason = tokenState === "expired-token" ? "expired" : tokenState === "bad-token" ? "bad" : "none";
          return send(401, renderErrorPage({ nonce, reason }));
        }
        const pageHeaders = {};
        if (!device && tokenState === "ok") {
          const created = devices.add("qr", String(ip).replace(/^::ffff:/i, ""));
          pageHeaders["set-cookie"] = deviceCookie(created.cookie);
          log("info", "device paired by qr token: " + created.device.id);
        }
        return send(200, renderPhonePage({ nonce, version: VERSION, config: { maxFiles: config.upload.maxFiles, maxBytes: config.upload.maxBytes, maxTotalBytes: config.upload.maxTotalBytes, targetMaxEdge: config.upload.targetMaxEdge, quality: config.upload.quality } }), pageHeaders);
      }

      return fail(404, "not-found", "no such route");
    } catch (error) {
      log("error", (error && error.stack) || String(error));
      try { return fail(500, "internal", "internal error"); } catch { return undefined; }
    }
  };

  function listenOnce(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { handler(req, res); });
      const onError = (error) => { try { server.close(); } catch {} reject(error); };
      server.once("error", onError);
      server.listen(port, config.server.host, () => {
        server.removeListener("error", onError);
        server.on("error", (error) => log("error", "server error: " + ((error && error.message) || String(error))));
        resolve({ server, port });
      });
    });
  }

  // 应用重启时，上一个进程的监听套接字可能还没释放，立刻换端口会造成“重启一次端口就往后跳”。
  // 先在同一个端口上短暂重试，实在占用才 +1。
  async function listen(port, tries, sameRetries) {
    const sameLeft = sameRetries == null ? 5 : sameRetries;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await listenOnce(port);
      } catch (error) {
        if (!error || error.code !== "EADDRINUSE") throw error;
        if (attempt < sameLeft) { await new Promise((r) => setTimeout(r, 200)); continue; }
        if (tries > 0) { log("warn", "port " + port + " busy, trying " + (port + 1)); return listen(port + 1, tries - 1, 0); }
        throw error;
      }
    }
  }

  const started = listen(config.server.port, config.server.portRetries || 10).then((result) => {
    state.server = result.server;
    state.port = result.port;
    const pair = pairing.ensure();
    log("info", "listening on http://" + config.server.host + ":" + result.port);
    if (config.logUrls !== false) {
      const ips = lanAddresses();
      if (ips.length === 0) log("warn", "no non-loopback IPv4 found; phone cannot reach this host over LAN");
      for (const ip of ips) log("info", "phone url: http://" + ip.address + ":" + result.port + "/?t=*** (token masked, see /qr on this machine)");
    }
    log("info", "pairing code: " + pair.code + " (ttl " + Math.round(config.pairing.ttlMs / 1000) + "s), qr page: http://127.0.0.1:" + result.port + "/qr");
    return result;
  }).catch((error) => {
    log("error", "failed to listen on port " + config.server.port + ": " + ((error && error.message) || String(error)));
    return null;
  });

  const dispose = () => {
    try { if (state.server) state.server.close(); } catch {}
    state.server = null;
  };
  try { if (ctx && typeof ctx.effect === "function") ctx.effect(() => dispose); } catch { try { ctx && ctx.on && ctx.on("dispose", dispose); } catch {} }

  return { started, port: () => state.port, dispose };
}
