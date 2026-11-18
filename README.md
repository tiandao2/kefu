# 在线客服：独立网页与 Telegram 话题

正式入口：https://kf.wgioat.cn/

线上仅服务 `kf.wgioat.cn`。部署时同时安装 `deploy/reject-other-hosts.conf` 到 `/etc/nginx/conf.d/`，拒绝其他 SNI 域名的 TLS 握手和其他 Host 的 HTTP 请求。未发送 SNI 的连接仍使用默认的新域名证书。旧域名的 DNS 记录需在其 DNS 服务商处删除；删除服务器站点不会删除外部 DNS 记录。

网站页面、API、附件及 WebSocket 对所有地区开放，不按 IP 地域限制访问。访客 Cookie、消息与附件权限、来源检查和限流继续执行。`/telegram/webhook` 仅允许 Telegram 官方来源网段，并由应用验证 webhook 密钥；这属于回调认证。`/.well-known/acme-challenge/` 保持公开供证书续期使用。

部署时安装 `deploy/kf-proxy.conf`、`deploy/kf-telegram-sources.conf` 到 `/etc/nginx/snippets/`。真实客户端 IP 仅信任已配置的 Cloudflare 官方代理网段的 `CF-Connecting-IP`，不能对任意请求开启真实 IP 头信任。

## 使用

- 客户首次打开页面会立即建立本地会话并在后台创建 Telegram 话题，输入和消息持久化不等待 Telegram 建话题返回。编号区分客户，地区仅用于初始名称，不用于身份认证。
- 同一浏览器凭据有效期间复用同一话题；人工改名后系统不会覆盖。
- 话题自动名称为“编号-简短地区”，如 `12-河北石家庄`、`6-上海`，编号不补零，省／市及常见自治区后缀精简，直辖市不重复。国际地区沿用定位数据的文字，不额外猜测或翻译。旧自动名称可用 `scripts/rename-topics.mjs` 预览，带 `--apply` 执行现有话题改名；执行前备份，人工备注及不匹配当前编号的名称不批量覆盖。话题删除后的自动恢复也沿用新格式，人工名称保留。
- 批量改名时，Telegram 明确返回话题不存在／ID 无效的记录只更新保存的默认名称，保留原绑定，由下一次正常消息触发既有恢复流程；不会为改名额外重建话题。权限等其他错误保留原记录并明确报告失败。
- 人工删除客户话题后，下一次客户消息会自动创建替代话题并重试，保留原客户身份、编号与网页历史。仅关闭的话题会尝试重新打开。网络故障或权限不足不会反复创建新话题。
- 仅 `STAFF_IDS` 中的客服账号发送的文字、照片、文档及视频会转发到网页。
- 客户从网页上传的图片使用 Telegram 照片方式发送，不再作为原文件文档发送；系统选取 Telegram 返回的最大尺寸，并保存为网页中的图片版本。照片经 Telegram 确认成功后即显示“已发送”；最大尺寸回存在独立队列中重试，不阻塞文字、后续消息或其他访客，也不重复发送照片。
- 客服发给客户支持三种发送来源：作为文件发送的原文件、Telegram 高清／最大尺寸照片、普通压缩照片。原文件保持文件内容；照片选取 Telegram 提供的最大可用尺寸，不额外压缩。高清和普通压缩由客服在 Telegram 发送时选择，网页不增加格式选择器。HEIC/HEIF 原文件保留原字节，另生成 JPEG 网页预览；客户上传的 HEVC HEIC 在受限的系统解码进程中转换为 JPEG，再按 Telegram 照片方式发送。贴纸不推送。
- 网页移除了访客编号、聊天头像及“仅展示最近 24 小时记录”提示；24 小时访问限制继续执行。图片可点开预览，消息和大图预览均无图片下载按钮；普通文件及视频下载保留。
- 顶部采用紧凑布局，“很高兴为您服务”位于右侧“专属会话”下方，不再独占一行。手机端原约 118 px 的顶部区域缩减为约 51 px（不含设备额外安全区）。
- 页面外层固定，只有消息列表滚动；根据可见视口的高度和顶部偏移适配手机键盘，保留输入框和聊天区域，处理键盘动画后的延迟更新。输入文字至少为 16 px，浏览器双指缩放继续保留。
- 上传入口仍接受单个 20 MiB 以内附件。照片接口有独立的 10 MB、宽高和比例限制：兼容的 JPEG／PNG 不预先重压缩，其他格式或超限图片在受限资源下转换为 JPEG，按需缩小并为极端长图补边，不裁掉图片内容。无法解析的图片会明确提示发送失败。
- 回复客服自己或其他指定客服已转发的消息，发送“撤回”，只撤回网页内容。机器人通知“已撤回”，群内原文保留。兼容旧 `/ch` 指令。
- 编辑客服消息会同步更新网页，并通知“已更新”。编辑附件说明及替换附件也支持；消息元数据先入库，附件独立下载，编辑按 Telegram 来源版本核对，撤回持久化标记，避免旧下载或旧编辑在重试后重新出现。超过 20 MiB 的附件不会推送。
- 网页在前台、具有焦点且消息进入可见区域后，机器人对该条客服消息标记 👍，不再回复“已读”文字。每条消息只标记一次，编辑已读消息不会重新触发。客服群需允许 👍 反应。
- 网页展示最近 24 小时的消息。超过时限的消息及附件链接不可访问，编辑不会延长时限。
- 服务器每小时清理超过 7 天的消息和附件。访客与话题映射长期保留。Telegram 历史不清理。
- 最近 24 小时没有客服侧消息时显示固定欢迎语；欢迎语计入客服侧记录，刷新不会重复显示。

## 线上目录

| 内容 | 位置 |
|---|---|
| 源码 | `/opt/kf-chat` |
| 配置密钥 | `/etc/kf-chat.env`，root 权限 600 |
| 数据库 | `/var/lib/kf-chat/chat.sqlite` |
| 附件 | `/var/lib/kf-chat/files` |
| 客户身份映射备份 | `/var/lib/kf-chat/identity-backups` |
| Nginx 配置 | `/etc/nginx/sites-available/kf-wgioat` |
| HTTPS 证书 | `/etc/letsencrypt/live/kf.wgioat.cn` |

身份备份每天运行，保存最近 7 天的快照，仅包含访客身份及话题对应关系，不包含聊天和附件。备份含凭据摘要，应按敏感数据保管。它不能代替服务器外的灾难恢复副本。

## 常用维护命令

```sh
systemctl status kf-chat --no-pager
systemctl restart kf-chat
journalctl -u kf-chat -n 100 --no-pager
systemctl list-timers 'kf-*' --all
curl -fsS http://127.0.0.1:3000/healthz
```

更改名称或指定客服：编辑 `/etc/kf-chat.env` 的 `SITE_NAME`、`STAFF_IDS`，然后重启服务。使用 Telegram 数字用户 ID，多个用逗号分隔。

更换机器人 Token 后，除了修改环境文件和重启，还必须重新调用 `setWebhook`，设置地址为 `PUBLIC_ORIGIN/telegram/webhook`、`secret_token` 为环境文件中的 `WEBHOOK_SECRET`，订阅 `message` 和 `edited_message`。不要将密钥写进公开源码或发到群里。

服务由 systemd 自动启动和重启。每 5 分钟检查服务健康、磁盘使用率、待处理任务进展和新增终态失败。新增失败按发送、附件和辅助分类通知一次；同一任务人工重试后再次失败会形成新通知。持续异常最多每小时重复提醒，解除后发送恢复提醒。短时 retry_after 正常等待不告警，连续限流等待超过 15 分钟或任务无进展超过 10 分钟会提醒。告警发送失败返回非零退出码且不推进已通知状态。当前通知仍依赖 Telegram，同机检查不能替代独立外部监测。证书由 certbot 定期续期并自动重载 Nginx。

## 本地开发与测试

需要 Node.js 22.12 或更新的受支持版本，以及上述 HEIC 系统依赖（包括运行 HEIC 回归测试时）。

```sh
npm ci
cp .env.example .env
# 修改 .env
node --env-file=.env server.mjs
npm test
node scripts/browser-reliability-check.mjs
KF_BROWSER_ENGINE=webkit node scripts/browser-reliability-check.mjs
# 浏览器测试使用本地模拟 Telegram，不会连接真实客服群
npx playwright install chromium --with-deps
node scripts/browser-check.mjs
# 可选：在 WebKit 中重复浏览器回归与键盘视口模拟
npx playwright install webkit --with-deps
KF_BROWSER_ENGINE=webkit node scripts/browser-check.mjs
# 浏览器兼容回归：正常／旧浏览器方法缺失、请求失败及响应体超时；不覆盖截图
node scripts/browser-compat-check.mjs
```

默认绑定 127.0.0.1，端口 3000；本地开发需将 `PUBLIC_ORIGIN` 设为实际本地访问地址。线上由 Nginx 提供 HTTPS 和 WebSocket 代理，不公开应用端口。

测试覆盖客户隔离、话题复用及删除恢复、重复提交、客服权限、点赞已读、中文撤回、客服三种图片来源、客户照片发送与最大尺寸保存、下载重试不重发、图像转换及大小限制、24 小时访问限制、20 并发访客及 7 天清理。浏览器测试覆盖手机／桌面布局、紧凑顶部、键盘可见区域高度与偏移、多行输入／发送、键盘收起、历史阅读位置、双指缩放、横屏、320 px 窄屏，以及图片上传与预览、前后台已读、编辑撤回和话题恢复。键盘检查是浏览器视口模拟，不能替代真实 iPhone Safari 键盘验收。

## 数据和网络说明

- 客户身份通过随机凭据的安全 Cookie 识别，数据库仅保存其 SHA-256 摘要。清除 Cookie、换浏览器、换设备后会成为新客户。
- 地区主查询为 `https://ip.cn/ip/<IP>.html`。IP.cn 无结果或失败时顺序尝试 `https://ipwho.is/<IP>?lang=zh-CN&fields=success,ip,country,region,city`，无需注册、Token 或 API Key。两者均失败时暂用“未知地区”，独立的持久化地区队列有限重试，不阻塞建话题、页面初始化或客户消息投递。查询最多并发 2 个，每个来源超时 2 秒，成功结果缓存 24 小时，失败缓存 60 秒，最多缓存 512 项；查询函数最多容纳 128 个不同 IP 的在途/待处理请求，容量满时由持久化任务稍后重试。内网、回环、保留及非法地址不外发；第三方只收到公网 IP，不收到聊天内容、Cookie 或访客凭据。查询恢复后只补正本版本建立且仍保持自动名称的话题，人工名称和历史话题不批量覆盖。
- 聊天 API、附件返回 `Cache-Control: private, no-store`；Cloudflare 不应设置覆盖这些响应头的强制缓存规则。Cloudflare SSL 建议使用 Full (strict)。
- 客户发送成功表示服务器已接收。消息列表会继续显示转发中的状态，待 Telegram 接收后变为“已发送”。遇到 Telegram 限流时遵守 `retry_after` 并持久化重试。每个访客的投递按顺序执行；不同访客最多 4 条投递并发，附件回存/下载最多 2 条并发，已读与通知最多 2 条并发。文件和额外长说明分步记录，说明失败后不重发已成功文件。明确的永久错误立即终止，其他非限流错误最多尝试 8 次；限流等待不消耗该次数，任务超过 24 小时仍未完成则终止。网页显示失败原因并可点击重试；重试复用消息和已经完成的步骤。失败投递不继续挡住后续消息，人工重试旧失败消息可能在后发消息之后送达。
- Telegram 发送接口不提供业务幂等键。网络超时发生在 Telegram 已接受请求、但本服务未收到确认时，自动重试存在极小的重复发送可能。常规重复提交、重复更新与重连均已去重。
- 普通群原生删除没有 Bot API 通知，必须回复目标消息发送“撤回”来撤回网页消息。
- 60 GB 起步容量应结合附件量监测；更换服务器应迁移完整数据库、附件、配置，并保留访客映射。

## 手工重新部署

使用 Debian 13 或 Ubuntu、Node.js 22 LTS、Nginx、certbot。HEIC 支持需要系统 `/usr/bin/heif-convert` 与 HEVC 解码器：Debian 13 安装 `libheif-examples libheif-plugin-libde265 util-linux`；Ubuntu 22.04 安装 `libheif-examples util-linux`。`prlimit` 对解码子进程设置 CPU、地址空间、输出文件大小和超时限制。系统自带 Node.js 版本低于 22.12 时，安装官方 Node.js 22 二进制至 `/opt/node-v22`，并将 node/npm/npx 链接至 `/usr/local/bin/`。源码放置到 `/opt/kf-chat`，`npm ci --omit=dev`；创建 `kfchat` 系统用户和归其所有的 `/var/lib/kf-chat`。将 `.env.example` 填入 `/etc/kf-chat.env`，只允许 root 读取。安装 `deploy/*.service` 和 `deploy/*.timer` 到 `/etc/systemd/system/`。修改 Nginx 域名和证书路径，维护 Cloudflare 官方 IP 段的可信代理配置。申请域名证书后执行：

```sh
systemctl daemon-reload
systemctl enable --now kf-chat kf-monitor.timer kf-backup.timer
nginx -t && systemctl reload nginx
```

使用当前 `deploy/nginx.conf` 时，需先把 `deploy/kf-performance.conf` 安装到 `/etc/nginx/conf.d/kf-performance.conf`，再测试并重载 Nginx。它定义启动资源的耗时日志格式，不能只复制站点配置而遗漏此文件。

最后设置 Telegram Webhook，并检查机器人为群管理员且拥有管理话题权限。

## 访问速度诊断

诊断入口为 `/network-check.html`，由 `public/network-check.html` 和 `public/network-check.js` 提供。使用出现慢访问的同一设备、浏览器和网络打开，点击“开始检测”，复制结果并补充城市、运营商及 Wi-Fi／手机流量。

检测记录该诊断页的导航时间，并分三轮请求首页、CSS、JS 和健康接口。它不调用 `/api/session`、不建立 Telegram 话题、不发送聊天消息；资源请求不携带访客 Cookie。诊断页的首次导航和后续资源请求分别记录，后续连接复用不能代表冷启动速度。该页也不测量 DNS 导航开始前的浏览器界面延迟。

检测版本 2 不依赖 `AbortSignal.timeout()`，通过显式定时器和可用时的 AbortController 管理请求及响应体超时；没有 AbortController 时仍能结束等待，但无法主动取消底层网络请求。报告包含浏览器能力、错误详情和失败阶段，复制时应保留完整内容。旧版的瞬时报错可能是方法不兼容，不能直接作为线路不可达的证据。客服前端 API 请求同步采用兼容超时处理，当前前端版本为 `app.js?v=10`。

## 1.0.4 无需 Token 的中文备用

备用来源为 [ipwho.is 官方免费接口](https://ipwhois.io/documentation)，固定使用 `lang=zh-CN` 请求中文国家、省州和城市，只请求所需字段。解析时核验成功标志与返回 IP，并只采纳含中文且不含英文字母的地名；少数未翻译的省州或城市字段省略，保留已本地化的较粗地区。国家也没有中文时按未知处理，不自行猜测翻译。供应商部分中文名称可能使用繁体字。

官方当前免费额度为每个出口 IP 每天 1,000 次，支持 HTTPS、IPv4/IPv6，并允许商业使用。超过额度会返回 429；应用按 `Retry-After` 在本进程内暂停备用请求（没有有效值时暂停 60 秒），主查询仍可正常尝试。查询缓存与后台有限重试继续执行。环境示例无需额外凭据配置，旧备用的 Token 选项及相关代码已移除。

## 1.0.3 消息状态与地区补全

数据库为每个访客维护持久化状态序号，消息插入、编辑、投递/附件状态、已读、撤回及清理均推进序号；初始化和消息快照在同一数据库事务中取得消息及水位。实时消息、撤回和写接口返回都携带可比较的版本，前端拒绝落后于快照或已处理消息的事件，同时保留旧协议的本页修订保护。不会以客户端时间或 Telegram 秒级时间戳充当完整版本。

启动时为现有表增量增加 `visitors.state_version/auto_title/pending_title`、`messages.revision` 及消息状态触发器，原访客凭据、话题绑定、消息和附件路径保留。单应用进程限制继续适用。

地区查询有独立 `geo` 队列，最多并发 2 个，不占用客户投递的 4 个槽位。新话题可先使用“未知地区”，查询后自动补全；手工改名将取消自动名称标记。查询或自动改名期间发生人工修改时保留人工名称；机器人旧改名通知不会把人工名称改回去。地区任务沿用有限重试和 24 小时期限，两家来源不可用也不影响消息投递。IPv6 校验先规范化地址，缩写和完整写法可以正确匹配。

发布前备份一致性数据库、附件和配置，核对队列，再按新版本清单发布。回退旧应用时须先保全并隔离新版 `region`、`restore-title` 任务，旧工作器不识别这些任务种类；保留增量字段和触发器，不用发布前数据库覆盖已经接收新消息的当前数据库。

## 1.0.2 浏览器兼容及归属地来源

页面先通过 `https-upgrade.js` 将非回环的 HTTP 文档导航到 HTTPS，再初始化会话和实时连接；避免移动浏览器仍保留 HTTP 页面来源时与正式 HTTPS 来源不一致。开发时允许 localhost、127.0.0.1、IPv6 回环使用 HTTP。页面返回 `no-transform`，减少中间代理改写。

写接口和 WebSocket 优先验证明确的 Origin；缺失 Origin 的旧 WebView 可使用精确匹配白名单的 Referer 兜底。显式外站、HTTP 或 null 来源仍拒绝，缺失两项也拒绝，不按浏览器 UA 放行。拒绝日志只记录来源的协议/域名和 Fetch Site 分类，不记 Cookie、IP 或来源 URL 的路径与查询。

归属地已改为 IP.cn 当前查询页的数据，不依赖已失效的旧 `/api/index` 接口。IP.cn 未给出本项目可引用的公开稳定 API 合约，页面结构或可用性发生变化会按未知地区降级；不要把这项估算作为身份认证或访问控制。

## 1.0.1 可靠性更新

客户端为请求和实时更新记录本页修订顺序，旧 HTTP 快照、上传或重试响应不能覆盖已经收到的新编辑、撤回及投递状态。网络恢复复用健康连接，旧连接的关闭/错误回调不能关闭新连接或安排额外重连。

非入站元数据任务按创建时间在 24 小时后终止；调度扫描不等待 retry_after 到期，发起下一次 Telegram 请求前再次检查。已经发起的远端请求可能在截止后返回，不把它误认为尚未发送而盲目重发。入站元数据继续按现有版本和保留规则协调，不按发送任务期限丢弃。过期不会重置已成功的文件步骤，失败任务也不阻塞后续有效消息。人工重试保留原创建时间，并受消息 24 小时访问窗口限制。

`jobs` 新增最后尝试、失败时间及限流时间字段，增量迁移保留原记录。当前仍须单应用进程运行，访客锁与活动队列在进程内。

当前检测版本为 3，默认“复制简短结果”会复制约十余行摘要，包含检测编号、首屏 DNS/TCP/TLS、HTML 首字节与结束时间、首次绘制、四项请求范围及浏览器信息，便于手机转发。完整 JSON 仍在展开区保留，末尾也附带摘要，避免只复制最后一条健康请求而遗漏首屏数据。检测版本 3 继续使用上述兼容超时处理，不更改客服业务脚本。

`deploy/kf-performance.conf` 配合站点配置将指定路径的请求耗时写入 `/var/log/nginx/kf-performance.log`，包括 Nginx 请求耗时、上游连接／响应耗时，以及检测编号。此日志不记录查询全文、客户端 IP、Cookie、请求正文或附件路径。Nginx 请求耗时不包含浏览器 DNS 和 TLS 建连前的等待，需与浏览器报告合看。轮转沿用服务器 Nginx 的日志轮转配置。
