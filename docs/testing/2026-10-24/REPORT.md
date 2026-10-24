# 2026-10-24 全量测试记录（负责人凌晨布置：「检查之前有什么没跑的，整个 App 都跑，尽全力 debug」）

> 基线：origin/main `86e177c`（#418 之后）。本机 Mac（14 核）+ scratchpad worktree，Node 24.11。
> 结论先行：**CI 同款全部绿**；CI 之外补跑了 12 类检查，**发现并修掉 5 处**（1 个安卓崩溃、1 个安卓日期跟系统语言、1 个 WS 重连空窗、1 个生产依赖安全漏洞批次、1 个 admin 弃用告警），其余全部通过。本次合入：#425、#426、#427、#429、#430；dev 云端已更新到 36ac9c0（DEPLOYMENT §5.1）。

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
| App 内语言切 English：五个标签 + 设备详情扫未翻译 | — | ✅ 0 条（只剩昵称） |
| 对讲：建频道 → 进房（服务端签 UserSig、TRTC EnterRoom、房内 PTT 页）→ 结束通话 | ✅（模拟器无麦克风） | — |
| 两顶头盔同时在线（第二顶跑滑雪剧本）：海拔 1790–2110 m 透传、地图可切换头盔、安全记录按头盔筛选 | ✅ | ✅ |
| 地图页断网 → 「连接中断，重连中…」→ 恢复网络 → WS 退避重连成功 | — | ✅（见五-3 的观察） |
| App 在后台时来单：通知栏「疑似摔倒或紧急求救 · helmet_fr_001 / 60 秒后将自动通知…」importance=5、锁屏可见（vis=1），带操作按钮；别处取消后这条通知被撤 | — | ✅ |

未签名的 iOS 模拟器包存不住钥匙串（文档已写明），重启要重登。

### 45 分钟 soak（03:12–03:57，Mock 骑行每秒 1 个位置点经 MQTT，双端停在地图页，每分钟采样）

| | 开始 | 最低 | 最高 | 结束 |
|---|---|---|---|---|
| Android PSS | 447 MB | 433 MB | 476 MB | 473 MB |
| iOS RSS | 396 MB | 387 MB | 418 MB | 413 MB |

3066 个位置点入库，双端崩溃 0，后端 RSS 160–171 MB、PG 3 连接、EMQX 261 MB 全程平稳。双端 App 各缓涨约 20 MB（有回落、不是单调），10-22 真机 32 分钟是 361–384 MB 波动；是否收敛看第七节的长跑（5 h 50 min）与隔离实验。

## 四、发现并修掉的

### 1. 🔴 安卓：链路前台服务「启动 Intent 还在路上就 stopService」→ 系统杀 App（#427，已合）

装包后首启、存着一个已失效的登录态时直接 FATAL：
`ForegroundServiceDidNotStartInTimeException: Context.startForegroundService() did not then call Service.startForeground(): HelmetLinkService`。

时间线（logcat）：链路 `startForegroundService` → 170 ms 后 WS 4401 → 刷新失败被动登出 → 模块 `stopService` → 系统 `Bringing down service while still waiting for start foreground` → 杀进程。AOSP 规则：startForegroundService 发出后、服务 startForeground 之前调 stopService，一律按「前台服务没按时露面」crash 调用方。首启主线程忙（dex 校验、首屏渲染），服务 200–450 ms 才轮到 onStartCommand，窗口就在这里。真机上「改过密码 / 被别处登出的人打开 App」就是这条路径。

改法：模块记「在路上的启动 Intent 数」，有在路上的不 stopService、只留标记；服务收到后露一面（CONNECTED_DEVICE 类型）就 stopSelf；新的 start 清标记。对讲 ACTION_MIC 路径 10-17 起本来就这么处理，这次把头盔链路补齐。

验证：修复前首启撞上 1 次；之后 5 次「重装 + 作废会话 + CPU 负载」的首启都差 1–11 ms 没撞上（服务露面紧接着就被登出），窗口确实窄。修复后同样场景不崩、登出后前台服务和通知收干净；正常登录 / 退出 / 再登录三轮无异常。**A 线真机复验项**：登录态失效时冷启动不崩；退出登录后通知栏「头盔连接」消失；对讲进房 / 退房前台服务类型照旧。

### 2. 生产依赖安全漏洞定点升级（#425，已合）——见二-4。

### 3. Admin 概览页 antd `valueStyle` 弃用告警（#426，已合）。

### 4. WS 重连撞上断网期间到期的 token 时多等一轮退避（#429，已合；负责人 05:10 定「测出来的就修」）

安卓断网 23 s 后恢复实测：恢复后第一次重连用的是断网期间过期的 access token → 4401 → 刷新成功 → 却仍按断网攒下的退避（第 5 次，16 s）才重连，实时通道空窗 16 s。access token 只有 15 分钟，骑行中信号差的路段每次恢复都可能撞上。改法：记连续被 4401 的次数（稳住一次清零）；本轮第一次被拒且确实换到了新 token → 退避清零、1 s 内重连；第二次起照 10-17 评审口径退避照涨，坏 token 仍刷不起来。edge-realtime 补 4 例，4 套 107 例全过。**A 线真机复验**：飞行模式 ≥ 1 分钟再关，顶部「连接中断」提示应几秒内消失。

### 5. 安卓上日期 / 星期 / 月份跟系统语言走、不跟 App 语言（#430，已合）

App 内语言切到 English 扫五个标签 + 设备详情：0 条未翻译。但 App 固定简体中文时，安卓系统语言 en-US 下安全记录写「今天 · Oct 24」、fr-FR 写「今天 · 24 oct.」，只有系统也是中文才是「10月24日」；iOS 同一段代码在英文系统下正常。代码给 `Intl.DateTimeFormat` 传的是 `LOCALE_TAGS[locale]`，是 Hermes 安卓端的 Intl 按系统 locale 输出（反过来英文用户的中文手机会看到中文日期）。改法：`i18n/format.ts` 的 7 个日期 / 星期 / 月份函数改为三种语言查表拼写，输出与原 Intl 逐字一致（8 个既有 i18n 测试文件一字未改全过）；新增 edge-format-1024 用假 Intl 钉住。修复包装回模拟器：三种系统语言下都是「今天 · 10月24日」。**A 线真机复验**：华为系统语言切英文、App 简体中文 → 安全记录 / 行程日历 / 事故详情的日期仍是中文写法。

## 五、观察到、没改的


- `expo-doctor` 的 29 个 expo 补丁版落后：等 SDK 升级时一并；patch-package 钉着 expo-notifications 57.0.11。
- `npm audit` 剩余 moderate：uuid 9（tencentcloud-sdk）、xcode 下 uuid 7（expo config-plugins）、expo-router 的 query-string——都要升 major 才能修。
- 09-13 的 MQTT 矩阵脚本（`docs/testing/2026-09-13/evidence/mqtt/scripts/auth-acl-matrix.mjs`）预期 SUBACK 128，与 #239 之后的 `deny_action = disconnect` 不符，重跑会在 ACL-1 卡住；本次重写的 v2 脚本在 scratchpad，建议下次归档进 evidence。
- 安卓模拟器（Android 17）上 HelmetLinkService 首启露面耗时 160–460 ms（主线程忙），和真机数量级一致，首启窗口不是模拟器特有。
- 本机 `npm audit` 默认走 npmmirror，不提供 audit 接口，要加 `--registry=https://registry.npmjs.org`。

## 六、本机复跑方法

- 全套：scratchpad worktree → `npm ci` → `npm run build -w @helmet/shared` → `typecheck / lint / test --workspaces`；容器 e2e 用 `docs/testing/2026-10-03/run-e2e-in-container.sh` 的副本（容器名改成自己的）；换 lock 后要先删容器里的 node_modules 再跑（脚本见到 `.bin` 就跳过安装）。
- 本地栈：worktree 里 `docker compose up -d`（PG + EMQX）→ `prisma migrate deploy` → `provision:device` → `node dist/main.js`；Mock 用 `SCENARIO=tour`（MQTT）和 `TRANSPORT=app-relay`（中转）各跑一遍；Admin `vite --port 5173`。
- 模拟器：iOS 按 DEVELOPMENT.md「iOS 模拟器」；Android `assembleRelease -x lintVital*`，本地 http 后端要在 app.json 的 expo-build-properties 临时加 `android.usesCleartextTraffic: true`（**不要提交**），API 指 `http://10.0.2.2:3000/api/v1`。

## 七、长跑（03:57 → 09:47，5 h 50 min；每 2 分钟采样 191 次）

负载：Mock `SCENARIO=tour TOUR_SOS=0`（每 2 s 一个位置点、每 30 s 心跳、每轮 8 条危险事件 + 解除 + 录像就绪 + 休眠 / 蓝牙断开）经 MQTT；05:30 起第二顶头盔（滑雪剧本）并行；iOS / Android 两台模拟器登录同一账号，主要停在地图页。期间穿插了双端操作（语言切换、对讲进房、设置下发等）。

| 指标 | 结果 |
|---|---|
| 入库事件 | +23 901 条（raw_events 1 068 → 24 969），期间无丢失、无 ERROR |
| 后端 RSS | 99–270 MB 波动；07:48 用 inspector 强制 GC 后 123 MB，heapUsed 全程 50–60 MB，活动句柄 16（1 Server + 15 Socket）→ 是 V8 惰性扩堆，**不是泄漏** |
| PostgreSQL 连接 | 3–6 |
| EMQX | 260–264 MB 平 |
| iOS App（Release，iPhone 17 Pro 模拟器） | `ps` RSS 312–556 MB 含共享页不作数；`vmmap` 物理足迹 09:07–10:25 在 265–277 MB 平 |
| Android App（Release，Pixel_8 / Android 17） | PSS 413 → 542 MB；`dumpsys meminfo` 分类：Dalvik 堆 20–21 MB 不变、Views 851 不变、WebViews 2 不变，**Native Heap 187 → 265 MB 持续上行** |
| 崩溃 | 0（logcat FATAL 0；iOS 进程未重启） |

### Android Native Heap 缓涨的隔离实验（09:07–10:45）

| # | 条件 | 时长 | Native Heap | 结论 |
|---|---|---|---|---|
| 基线 | 地图页前台、0.5 Hz 位置 + 心跳 + 危险事件 | 06:27→09:06 | 187 → 250 MB（~24 MB/h） | — |
| ① | 关掉模拟器蓝牙（App 停止每 20 s 的过滤 / 全量扫描切换） | 18 min | 251 → 258（~22 MB/h） | 不是 BLE 扫描 |
| ② | 离开地图页停设备页 | 20 min | 258.5 → 265.5（~21 MB/h） | 不是地图页 / WebView |
| ③ | 停掉事件流（WS 无消息） | 19 min | 265.5 → 265.7（+0.2） | **由事件驱动** |
| ④ | 恢复事件流并加倍到 1 Hz，App 退后台（WS 照收、前台服务在、UI 不渲染） | 19 min，1 157 条位置 | 265.2 → 264.9（不涨） | **不是 WS / JS 处理路径** |
| ⑤ | 同 1 Hz 纯骑行流，拉回前台停设备页 | 24 min，1 491 条位置 | 269.2 → 268.9（不涨） | 位置更新的前台渲染也不是 |
| ⑥ | tour 剧本 6 倍速（80 s 一轮 8 条危险事件 + 解除 + 录像就绪 + 休眠 / 蓝牙断开，448 条），前台设备页 | 14 min | 269.4 → 267.7（不涨） | 危险事件 / 事件页 refetch 也不是 |
| ⑦ | 把第二顶头盔（滑雪剧本，每 2 s 一点，581 条）加回来，两路流 + 前台设备页 | 19 min | 270.3 → 275.7（**~17 MB/h，涨回来了**） | **触发条件 = 第二顶（非当前）头盔的位置流** |

结论：安卓 App 在前台、账号下有第二顶头盔在持续上报位置时，**每条非当前头盔的位置更新在 native 堆上留下约 9 KB**（测试速率每 2 s 一条 ≈ 17–24 MB/h；只有当前头盔在发、或 App 退后台、或没有事件时都不涨）。Dalvik 堆、View 数、WebView 数全程不变，iOS 物理足迹同期也从 272 缓涨到 296 MB，所以更像两端共用的某条 JS 路径在非当前头盔的 `location_update` 上攒东西，再经原生模块（极可能是地图 WebView 的 postMessage / 其他头盔标记，或「其他头盔」行 / 换头盔提醒）落到 native 侧；不是 BLE 扫描、不是危险事件、不是事件页刷新、不是当前头盔的位置渲染（①–⑥ 逐一排除）。按云端真实速率（每 10 s 一点）折算约 3–5 MB/h，不致命，但「家里两顶头盔、一顶在骑、App 开着」是真实场景，值得查清。**交 A 线**：两顶头盔绑定同一账号，非当前那顶 `SCENARIO=riding LOCATION_INTERVAL_MS=2000`，App 前台任意标签停 20 分钟，用 dev-client + Android Studio Memory Profiler（Native allocations）/ Perfetto heapprofd 看分配栈，重点看 `use-realtime` 的 `location_update` 分支下游（`device-location` 缓存的消费者：地图页其他头盔、「其他头盔」行、换头盔提醒）。复现脚本与采样数据见 `scripts/longsoak-sample.sh` 与本节。
