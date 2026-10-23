# 2026-10-24 全量测试记录（负责人凌晨布置：「检查之前有什么没跑的，整个 App 都跑，尽全力 debug」）

> 基线：origin/main `86e177c`（#418 之后）。本机 Mac（14 核）+ scratchpad worktree，Node 24.11。
> 结论先行：**CI 同款全部绿**；CI 之外补跑了 12 类检查，**发现并修掉 3 处**（1 个安卓崩溃、1 个生产依赖安全漏洞批次、1 个 admin 弃用告警），其余全部通过。本次合入：#425、#426、#427。

## 一、CI 同款（本机复跑，全绿）

| 项 | 结果 |
|---|---|
| typecheck × 5 workspace | ✅ |
| lint × 5 | ✅ |
| 单测 | backend 90 套 1341 ✅ · app 200 套 3293 ✅ · admin 20 套 209 ✅ · mock-device 73 ✅ · shared 21 ✅ |
| build backend / admin | ✅ |
| 容器 e2e（Linux，somaxconn 4096） | 90 套 850 例 ✅（253 s）；换新 lock 后重装复跑 850 ✅（257 s） |
| 空库 migration | ✅（容器里 `prisma migrate deploy`） |

测试文件计数与各 runner 实际执行数一一对上（backend spec 90 / e2e-spec 90、app 197+3 插件 = 200、admin 20），仓库里没有 `.skip` / `.todo` / `.only`。

## 二、CI 不覆盖、这次补跑的

| # | 检查 | 结果 |
|---|---|---|
| 1 | `prisma migrate diff`（迁移从头跑出来的库 vs schema.prisma） | 无漂移 ✅ |
| 2 | `expo export` 双端 Metro 打包 | ✅（Hermes 字节码两端各一份，28 MB） |
| 3 | `expo-doctor` | 3 项告警：react 双份（app 19.2.3 / 根 19.2.8，jest 已映射，Metro 取 app 下的）、29 个 expo 包落后补丁版（patch-package 钉着 expo-notifications 57.0.11，**不升**）、vlc 未标新架构。都不是缺陷 |
| 4 | `npm audit`（官方源；国内镜像不提供 audit 接口） | 生产依赖 28 条（2 critical / 17 high）→ **#425** 定点升级 proxy-addr 2.0.8（后端开着 trust proxy、限频按 IP，critical）、qs 6.16.1、@nestjs/platform-express 11.2.8（multer 2.4.0）、shell-quote、source-map-js、compression。整体 `npm audit fix` 因 jest-expo peer 冲突跑不了。剩余：uuid 9（tencentcloud-sdk 范围内装不到 11.1.1）、expo / expo-router 要升 major 的几条——留给升 SDK |
| 5 | 三个生产镜像用新 lock 构建 | backend 2.0 GB / mock 445 MB / gateway 90 MB ✅ |
| 6 | `deploy/docker-compose.prod.yml config` | 可解析（required 变量按设计报缺） ✅ |
| 7 | **真实 EMQX 认证 / ACL / 消息层矩阵** 27 项 | 全过 ✅：错密钥 / 无凭证 / 冒充服务账号 / 冒充后端消费者 clientId 全拒；越权订阅 / 发布一律被 Broker 断开（#239 的 `deny_action = disconnect` 口径，09-13 旧脚本预期的 SUBACK 128 已过时，脚本重写为 `scratchpad/mqtt-matrix-v2.mjs`，建议下次归档）；自己 topic 里冒充他人 deviceId → `_invalid device_id_mismatch_with_topic`；同 eventId 三次投递只入 1 条；非 JSON / 70 KB / 1.1 MB 三种坏消息各按口径处理 |
| 8 | **Mock 全链路（MQTT 4G 链路）** tour 剧本 | 206+ 事件入库；摔倒 → 60 s 倒计时 → 第二轮 manual_sos 按「SOS Now」升级立即通知 → SMS / Push Mock 各一条；第二单到期 notified；WS 五类推送（device_status / location_update / risk_event / device_event / sos_update）都到 |
| 9 | **Mock 全链路（app-relay = MVP 唯一真机链路）** | 断网补传（RELAY_OFFLINE_CYCLE=3）无重复；范围外事件本地跳过；`RELAY_SEND_OUT_OF_SCOPE=1` 时服务端留档 8 条 `event_type_not_allowed`；下行命令 WS → relay-ack delivered → executed success 0.5 s，生效设置只在 success 后写；MQTT 路径无设备回执 30 s → offline |
| 10 | **Admin 五页浏览器冒烟**（vite + 本地后端） | 概览 / 用户 / 设备 / 设备详情（生效设置 + 最近事件）/ 事故 / 事件（含「只看校验失败留档」）全部有数据、无报错；唯一控制台告警 antd `valueStyle` 弃用 → **#426** |
| 11 | **API 模糊测试**：60 条路由 × 畸形路径参数 / 查询串 / 请求体 = 870 个请求 | 0 个 5xx、0 个无 code 的错误体，后端日志无 ERROR ✅ |
| 12 | 媒体预签名 URL | `GET /media/:id/url` 200（COS 10 min 签名）✅ |
| 14 | `deploy/Caddyfile` 用 caddy:2 镜像 `caddy validate`（给齐 ACME_EMAIL / 三个域名）；`emqx.prod.conf.template` 渲染后 emqx:5 `check_config` | 都通过 ✅（Caddyfile 不给环境变量会在第 5 行 `email` 报错，是占位符不是缺陷） |
| 15 | `bash -n` deploy/backup.sh、render-config.sh、rtsp-mock/start_rtsp.sh、run-e2e-in-container.sh；`py_compile` ble-helmet-sim | ✅ |
| 13 | **后端倒计时中重启接管**（活体） | 摔倒单建好 6 s 后杀后端、23 s 后重启 → 日志「启动接管：1 个进行中 SOS 重新纳入调度」→ 到期 3 s 内 notified、SMS / Push 各 sent ✅ |

## 三、双端模拟器冒烟（iOS 26.5 iPhone 17 Pro Release 包 + Android 17 Pixel_8 Release 包，都指本机后端）

| 流程 | iOS | Android |
|---|---|---|
| 登录（本机账号）→ 设备页（电量 / 未连接 / 今日骑行） | ✅ | ✅ |
| 地图页（高德加载、头盔标记、离线卡片） | ✅ | ✅（暗色） |
| 对讲页空态 | ✅ | — |
| 安全页 / 我的页 / 紧急联系人 / 安全记录列表 | ✅ | ✅ |
| 设备详情：前照灯分段控件下发 → 「已发送，等待头盔确认执行」→ 「已生效」；失败回执 → 「执行失败（MOCK_REJECTED）」；无回执 30 s → 「上次设置未送达，请重试」 | — | ✅ 三态 |
| Mock 摔倒 → **双端同时弹倒计时页** → 安卓滑动取消 → **双端同步「已取消」** → 安卓「我还是需要帮助」→ 新建 manual_sos 倒计时（双端同步）→ 到期 → 双端「求救短信已发出 · 已发送」 | ✅ | ✅ |
| 会话被服务端作废（撤销 refresh + 换 JWT 密钥）→ 被动登出 | ✅ 登录页带「登录已失效（可能是在其他设备上修改了密码）…」 | ✅ |
| 链路前台服务：登录起 / 退出登录停 / 再登录回来 | n/a | ✅（修复包） |
| 深链 `lingyizhixing://sos-active?sosId=a&sosId=b`（#394） | — | ✅「这条求救不存在」+ 关闭 |
| 地图页断网 → 「连接中断，重连中…」→ 恢复网络 → WS 退避重连成功 | — | ✅（见五-3 的观察） |
| App 在后台时来单：通知栏「疑似摔倒或紧急求救 · helmet_fr_001 / 60 秒后将自动通知…」importance=5、锁屏可见（vis=1），带操作按钮；别处取消后这条通知被撤 | — | ✅ |

未签名的 iOS 模拟器包存不住钥匙串（文档已写明），重启要重登。

### 45 分钟 soak（03:12–03:57，Mock 骑行每秒 1 个位置点经 MQTT，双端停在地图页，每分钟采样）

| | 开始 | 最低 | 最高 | 结束 |
|---|---|---|---|---|
| Android PSS | 447 MB | 433 MB | 476 MB | 473 MB |
| iOS RSS | 396 MB | 387 MB | 418 MB | 413 MB |

3066 个位置点入库，双端崩溃 0，后端 RSS 160–171 MB、PG 3 连接、EMQX 261 MB 全程平稳。双端 App 各缓涨约 20 MB（有回落、不是单调），10-22 真机 32 分钟是 361–384 MB 波动；是否收敛看后面的长跑（03:57 起 tour 剧本到 11:40，每 2 分钟采样，结论见文末「长跑」一节）。

## 四、发现并修掉的

### 1. 🔴 安卓：链路前台服务「启动 Intent 还在路上就 stopService」→ 系统杀 App（#427，已合）

装包后首启、存着一个已失效的登录态时直接 FATAL：
`ForegroundServiceDidNotStartInTimeException: Context.startForegroundService() did not then call Service.startForeground(): HelmetLinkService`。

时间线（logcat）：链路 `startForegroundService` → 170 ms 后 WS 4401 → 刷新失败被动登出 → 模块 `stopService` → 系统 `Bringing down service while still waiting for start foreground` → 杀进程。AOSP 规则：startForegroundService 发出后、服务 startForeground 之前调 stopService，一律按「前台服务没按时露面」crash 调用方。首启主线程忙（dex 校验、首屏渲染），服务 200–450 ms 才轮到 onStartCommand，窗口就在这里。真机上「改过密码 / 被别处登出的人打开 App」就是这条路径。

改法：模块记「在路上的启动 Intent 数」，有在路上的不 stopService、只留标记；服务收到后露一面（CONNECTED_DEVICE 类型）就 stopSelf；新的 start 清标记。对讲 ACTION_MIC 路径 10-17 起本来就这么处理，这次把头盔链路补齐。

验证：修复前首启撞上 1 次；之后 5 次「重装 + 作废会话 + CPU 负载」的首启都差 1–11 ms 没撞上（服务露面紧接着就被登出），窗口确实窄。修复后同样场景不崩、登出后前台服务和通知收干净；正常登录 / 退出 / 再登录三轮无异常。**A 线真机复验项**：登录态失效时冷启动不崩；退出登录后通知栏「头盔连接」消失；对讲进房 / 退房前台服务类型照旧。

### 2. 生产依赖安全漏洞定点升级（#425，已合）——见二-4。

### 3. Admin 概览页 antd `valueStyle` 弃用告警（#426，已合）。

## 五、观察到、没改的

- **WS 重连撞上 access token 过期时多等一轮退避**（安卓断网 23 s 后恢复实测）：恢复后第一次重连用的是刚过期的 token → 4401 → 刷新成功 → 仍按当时的退避（第 5 次，16 s）才重连，期间实时通道空窗 16 s（求救推送走极光不受影响，倒计时页靠 WS / 轮询兜底）。这是 10-17 评审定的「连续被拒退避照涨」口径，没改。可考虑：① 刷新**成功**且是本轮第一次 4401 时把退避清零（第二次连续 4401 照涨，仍防住坏 token 每秒刷）；② 重连前先看 JWT `exp`，已过期就先刷新再连，省掉那次必败的握手。两条都是 A 线 `api/realtime.ts` 几行的事，建议 A 线定。

- `expo-doctor` 的 29 个 expo 补丁版落后：等 SDK 升级时一并；patch-package 钉着 expo-notifications 57.0.11。
- `npm audit` 剩余 moderate：uuid 9（tencentcloud-sdk）、xcode 下 uuid 7（expo config-plugins）、expo-router 的 query-string——都要升 major 才能修。
- 09-13 的 MQTT 矩阵脚本（`docs/testing/2026-09-13/evidence/mqtt/scripts/auth-acl-matrix.mjs`）预期 SUBACK 128，与 #239 之后的 `deny_action = disconnect` 不符，重跑会在 ACL-1 卡住；本次重写的 v2 脚本在 scratchpad，建议下次归档进 evidence。
- 安卓模拟器（Android 17）上 HelmetLinkService 首启露面耗时 160–460 ms（主线程忙），和真机数量级一致，首启窗口不是模拟器特有。
- 本机 `npm audit` 默认走 npmmirror，不提供 audit 接口，要加 `--registry=https://registry.npmjs.org`。

## 六、本机复跑方法

- 全套：scratchpad worktree → `npm ci` → `npm run build -w @helmet/shared` → `typecheck / lint / test --workspaces`；容器 e2e 用 `docs/testing/2026-10-03/run-e2e-in-container.sh` 的副本（容器名改成自己的）；换 lock 后要先删容器里的 node_modules 再跑（脚本见到 `.bin` 就跳过安装）。
- 本地栈：worktree 里 `docker compose up -d`（PG + EMQX）→ `prisma migrate deploy` → `provision:device` → `node dist/main.js`；Mock 用 `SCENARIO=tour`（MQTT）和 `TRANSPORT=app-relay`（中转）各跑一遍；Admin `vite --port 5173`。
- 模拟器：iOS 按 DEVELOPMENT.md「iOS 模拟器」；Android `assembleRelease -x lintVital*`，本地 http 后端要在 app.json 的 expo-build-properties 临时加 `android.usesCleartextTraffic: true`（**不要提交**），API 指 `http://10.0.2.2:3000/api/v1`。
