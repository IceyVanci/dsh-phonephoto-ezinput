# dsh-phonephoto-ezinput

> 适用于主要使用 PC 端进行软件开发；借助本插件，可以方便地用手边的现役或已淘汰设备拍照，并把图片发送到对话窗口。

在 DSH 里开一个局域网小服务：手机扫码打开网页拍照，图片**直接投递到你指定的对话**。
手机端不装 App、不需要 HTTPS。

## 界面

手机端（扫码后，零安装）：

<p align="center">
  <img src="docs/phone-capture.jpg" width="52%" alt="手机上拍照或从相册选图">
</p>

扫码 → 在手机上选对话 → 拍照或从相册选图 → 预览确认后发送。
最多 4 张、单张 ≤ 10 MB、合计 ≤ 25 MB，发出前可以预览、删除、重拍。

图片到了电脑上，以一条 **「发送自 192.168.1.23」** 的待发送消息挂在对话底部，
旁边是缩略图；你补一句话发出去，它才跟着这一轮进上下文。

## 特性

- **手机零安装**：只用浏览器原生 `<input type="file" capture>`，纯 HTTP，不需要证书
- **投递到指定对话**：手机上先选对话再拍，图片直接进入那个对话
- **手机端预览确认**：拍完可看大图、删除、重拍，确认后才发送
- **客户端压缩**：长边 2048 / JPEG 0.85 / 自动修正 EXIF 方向，一张约 300~400 KB
- **不打断你干活**：图片挂成待发送消息，不自动跑模型；你回到电脑再决定要不要发
- **设置面板**：二维码、访问链接、已配对设备与有效期
- **安全默认**：仅私网、CSP nonce、magic bytes 校验、上传限速、IP 级授权

## 环境要求

- DeepSeek Harness 桌面端 `0.2.1-rc.5`（或相近版本）
- Node.js 20+（插件运行在 DSH 进程内，无需单独装）
- 手机与电脑在同一局域网

## 工作方式

```
电脑：插件起 HTTP 服务（默认 8788）→ 生成二维码
手机：扫码 → 选对话 → 拍照/选图 → 预览 → 发送
电脑：图片按 `inject.mode` 进入对话
```

## 行为

图片会作为**「待发送」消息**挂进你在手机上选的那个对话，**不会自动触发模型**；
你回电脑后补一句话发出去时，图片跟着这一轮一起提交。

> 改行为：配置文件里 `inject.mode` 可设为 `display`（只写入、不唤醒）、`followup`（写入并立刻回复）、
> `steer`（插入当前回合）、`draft`（输入框草稿，当前版本不渲染）。默认 `inbox`。

## 设置面板

装好后在 **更多 → 设置 → 手机照片便捷输入** 里可以看到：

- 二维码 + 局域网链接 + 6 位备用配对码（可直接复制）
- 已配对设备列表：IP、剩余天数、**逐条删除**、**全部撤销**
- 配对**有效期**：1 / 3 / 7 / 30 天
- 运行统计：监听端口、最近一次上传、UI 心跳

面板的数据走**同源路由** `/phone-shoot/*`（不跨端口），因此不受 DSH 页面 CSP 的
`connect-src` 限制；同源不可用时才回退去探测 `8788-8797`。

设备与设置落在 `~/.dsh/phone-shoot/`（目录名沿用早期版本，改名会导致已配对手机全部失效）。

## 安装

应用内 **设置 → 插件 → 安装本地路径包**，选择本目录。

装完或更新代码后，**要完整重启应用**才生效：

- **host 半边**（服务、投递）开关一次插件即可重载；
- **client 半边**（设置面板）在应用启动时构建进 Web UI，只开关插件不会刷新，
  界面上会继续显示旧版本。

> 想少掉这一步，装成真实目录、别用 `link:` 联接——更新时插件管理器的重装流程更干净。

配对设备与设置都存在 `~/.dsh/phone-shoot/`，重启不丢，手机上不用重新扫码。

## 路由

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 无 | `{ ok, version, port, mode }` |
| GET | `/qr` | 仅回环 | 二维码页（含 token，勿外传截图） |
| GET | `/` | token 或已配对 IP | 手机页 |
| GET | `/api/sessions` | 同上 | `{ recent, groups, total }` |
| POST | `/api/upload` | 同上 | multipart：`files` + `sessionId` |
| POST | `/api/pair` | 短码 | 换设备 cookie |
| GET | `/api/pairing` | 同上 | 当前配对信息 |
| GET | `/api/pending` | 同上 | 草稿队列（client 半边用） |
| POST | `/api/pending/ack` | 同上 | 确认消费 |
| GET | `/api/mode` | 仅回环 | 查看/切换投递模式 |
| GET | `/api/diagnostics` | 仅回环 | 计数器、设备、模式 |
| GET | `/phone-shoot/status` | 同源 | 面板数据（与 `/api/panel` 同结构） |
| GET | `/phone-shoot/pending` | 同源 | 草稿队列（client 半边轮询用） |
| POST | `/phone-shoot/ack` | 同源 | 确认消费草稿 |
| POST | `/phone-shoot/client-alive` | 同源 | UI 心跳（计 `clientPolls`） |
| GET | `/phone-shoot/ttl?days=` | 同源 | 设置配对有效期 |
| GET | `/phone-shoot/revoke?ip=` | 同源 | 删除设备（`ip=all` 全部撤销） |
| GET | `/phone-shoot/mode?value=` | 同源 | 运行时切换投递模式 |

> `/phone-shoot/*` 是挂在 DSH Web UI 上的同源路由，前缀沿用早期命名；插件停用后它们会返回
> `503 plugin-offline`。

## 配对与安全

- **已配对 IP 免 token**：首次用二维码里的 token（8 位）或 6 位短码配对后，同一 IP 之后的访问不再校验 token。
- 设备以 **IP** 为唯一键，有效期 `pairing.deviceTtlMs`（默认 7 天），每次访问滑动续期。
- 默认只接受私网来源（10/8、172.16/12、192.168/16、127/8）；`/qr`、`/api/mode`、`/api/diagnostics` 额外限制为回环。
- 页面安全头：CSP（nonce，无 `unsafe-inline`）、`no-referrer`、`no-store`、`nosniff`。
- 上传按 magic bytes 复核（JPEG/PNG/WebP），限速 12 次/分钟/IP。

## 配置

```yaml
server:   { host: 0.0.0.0, port: 8788, portRetries: 10, privateOnly: true }
pairing:  { ttlMs: 900000, persistDevices: true, pairMaxFailures: 5, deviceTtlMs: 604800000 }
upload:   { maxFiles: 4, maxBytes: 10485760, maxTotalBytes: 26214400, targetMaxEdge: 2048, quality: 0.85, ratePerMinute: 12 }
inject:   { mode: inbox, noteTemplate: '发送自 {ip}', sourceKind: user, pendingTtlMs: 600000 }
sessions: { recentWindowMs: 600000 }
```

`inject.noteTemplate` 里的 `{ip}` 会替换成手机的实际地址，写成 `'发送自 {ip}'` 就是
「发送自 192.168.1.23」；设成空串则不插入这行说明，只发图。

## 数据落点

- 已配对设备：`$DSH_HOME/phone-shoot/devices.json`（只存 cookie secret 的 sha256 + IP + 到期时间）
- 面板设置：`$DSH_HOME/phone-shoot/settings.json`
- 运行日志：`$DSH_HOME/phone-shoot/phone-shoot.log`（超过 1 MB 轮转）
- 不写临时文件；图片在内存中处理，投递后释放

## 排障

**症状：DSH 起不来，浏览器/日志里是 `web boot: 1 entry did not activate`**

```
Error: web boot: 1 entry did not activate
dsh-phonephoto-ezinput: import failed (see console for the import error)

client-modules: duplicate factory registration for "…" (bundle executed twice without invalidate?)
```

意思是浏览器半边的 bundle 在同一页面里被执行了两次：常见于**同一个插件装了两份**
（`link:` 联接 + 一份实体目录并存），或**启动那一刻插件文件正在被改写**。

处理：

1. 看 `~/.dsh/profiles/<profile>/node_modules`，同名的插件目录只能有一份；
2. `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里各出现一次，别一边 `link:` 一边又复制实体目录；
3. 删掉多余的那份，重启应用。

本插件的 client bundle 带自锁：被重复执行时只打一条 `executed twice, skipped re-registration`
警告，不再重复注册——因此不会再拖垮启动。但重复安装仍会让 host 半边起两个服务抢 8788，
该清的还是要清。

**症状：设置面板显示「读取状态失败：Failed to fetch」**

通常不是服务挂了。先用浏览器打开 `http://127.0.0.1:8788/api/health`：

- 打不开 → 服务没起来：看 `~/.dsh/phone-shoot/phone-shoot.log`，多半是端口被占或插件没启用；
- 能打开但面板仍报错 → **跨端口请求被页面策略拦了**。插件已改为优先走同源路由，
  出现这种情况说明页面里跑的还是旧版 client bundle，重启应用即可。

**症状：面板底部「UI 心跳」一直是 0，或端口一会儿 8788 一会儿 8790**

- 心跳为 0：client 半边没连上（旧 bundle，或插件被重载后路由指向旧实例）；
- 端口漂移：应用重启瞬间旧进程还没释放套接字。现在会先在原端口重试 5 次（每次 200ms），
  真被别的程序占用才 +1。

## 已知限制

1. **`draft` 模式（输入框草稿）不可用**：`conversation.createDrafts()` 只登记字节，真正渲染缩略图的是输入框组件内部的 `addFiles()`，未暴露给插件。代码保留，等上游开放 API。
2. **更新要走完整重启**：client 半边在应用启动时构建，只开关插件只重载 host 半边。
   （`link:` 联接本身能跑，但重装流程容易留下两份来源，见上面「DSH 起不来」那节。）
3. 服务端端口被占用时先在原端口重试，仍失败才 +1，最多试 10 次；client 会从 8788 起探测。
4. 设备按 IP 识别：同一 NAT 后的多台设备会合并成一条。
5. 草稿队列是内存态，重启即丢。

## 许可

MIT。二维码使用 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT, © 2009 Kazuhiko Arase），已内联到 `lib/vendor/` 并保留版权头。
