# dsh-phonephoto-ezinput

> 适用于主要使用 PC 端进行软件开发；借助本插件，可以方便地用手边的现役或已淘汰设备拍照，并把图片发送到对话窗口。

在 DSH 里开一个局域网小服务：手机扫码打开网页拍照，图片**直接投递到你指定的对话**。
手机端不装 App、不需要 HTTPS。

## 界面

手机端（扫码后，零安装）：

<p align="center">
  <img src="docs/phone-sessions.jpg" width="46%" alt="手机上选择要投递的对话">
  <img src="docs/phone-capture.jpg" width="46%" alt="手机上拍照或从相册选图">
</p>

左边是选对话的：最近的对话排在最上面，其余按项目分组折叠；右边是拍图的：
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

装好后在 **更多 → 设置 → 手机拍照** 里可以看到：

- 二维码 + 局域网链接 + 6 位备用配对码（可直接复制）
- 已配对设备列表：IP、剩余天数、**逐条删除**、**全部撤销**
- 配对**有效期**：1 / 3 / 7 / 30 天
- 运行统计：监听端口、最近一次上传、UI 心跳

设备与设置落在 `~/.dsh/phone-shoot/`（目录名沿用早期版本，改名会导致已配对手机全部失效）。

## 安装

**必须装成真实目录**（`link:` 联接会导致 client 半边不加载）：

应用内 **设置 → 插件 → 安装本地路径包**，选择本目录。

> 若插件管理器记录的是 `link:`，可手动把 `dsh-phonephoto-ezinput` 复制到
> `~/.dsh/profiles/<profile>/node_modules/dsh-phonephoto-ezinput` 覆盖该联接。

安装/更新后**开关一次插件**（或重启应用）生效。

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
| GET/POST | `/phone-shoot/*` | 同源 | 给 DSH Web UI 的 client 半边用（内部前缀，沿用早期命名） |

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

## 已知限制

1. **`draft` 模式（输入框草稿）不可用**：`conversation.createDrafts()` 只登记字节，真正渲染缩略图的是输入框组件内部的 `addFiles()`，未暴露给插件。代码保留，等上游开放 API。
2. **client 半边要求真实目录安装**：`link:` 联接形态下不加载（心跳为 0 即可判定）。
3. 服务端端口被占用时自动 +1，最多试 10 次；client 会从 8788 起探测。
4. 设备按 IP 识别：同一 NAT 后的多台设备会合并成一条。
5. 草稿队列是内存态，重启即丢。

## 许可

MIT。二维码使用 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT, © 2009 Kazuhiko Arase），已内联到 `lib/vendor/` 并保留版权头。
