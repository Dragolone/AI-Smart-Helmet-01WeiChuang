# FIXES.md — 审计缺陷修复记录（2026-09-14 / 15，分支 `fix/audit-2026-09-13`，未提交）

> 原则：只改业务源码里能确定「正确行为」的项；SOS-03（决策 #40）与 ADMIN-04（记录保留、默认隐藏、总数不计）均在负责人 2026-09-15 拍板后修复。
> 每项修复都以本轮审计测试转绿为验收，并复跑既有 25 套 E2E（227 用例）与单测（86 用例）确认无回归。
> **含一个 migration**（`20260914155128_sos_pending_per_device_user`，改 partial unique index，决策 #40）；Prisma schema 只改注释；无新依赖；新增 admin `QueryError` 组件。

## 逐项修法

| ID | 修法 | 涉及文件 | 验证 |
|---|---|---|---|
| **SOS-01** | 位置快照回落查询包 try/catch：失败记 warn、按空快照建单 | `sos/sos-trigger.service.ts` | audit-sos-faults ② 转绿 |
| **SOS-02** | ① 建单遇数据库错误进程内重试 2 次（200/400ms 退避）；② 调度器启动时对账最近 `SOS_RECONCILE_WINDOW_MINUTES`（默认 15）分钟内「raw 已落库、无 SOS 单、当时无进行中单可并入、当时有绑定用户」的摔倒/求救事件，按当时绑定用户重新触发（`reconcileLostTriggers()` 公开可调） | `sos/sos-trigger.service.ts`、`sos/sos-scheduler.service.ts`、`sos/sos.constants.ts`、`backend/.env.example` | audit-sos-faults ①（瞬断一次→重试补建）/ ①b（持续失败→对账补建、二次对账不重复）转绿。**注意**：对账查询走 `raw_events.received_at`，该表无此索引，故只在启动做一次而不每轮扫描；上线后若 raw 表很大建议补 `(event_type, received_at)` 索引（需 migration，走公共文件规则） |
| **SOS-05** | ① 每次 Provider 调用包 `SOS_NOTIFY_TIMEOUT_MS`（默认 10s）超时，超时按失败记 `timeout` 走既有重试；② 扫描拆成「到期终态化」与「通知投递」两个独立互斥阶段，到期终态化不再内联等第三方 | `sos/sos-notifier.service.ts`、`sos/sos-scheduler.service.ts` | audit-sos-faults ④ 转绿（挂起的短信不再拖停其他 SOS 终态化） |
| **SOS-04** | 本人 Push 标题/正文按此刻短信结果生成：全部/部分成功→「SOS 已通知紧急联系人」、全部失败→「SOS 紧急联系人通知发送失败」、未设置联系人→「SOS 未设置紧急联系人」；App 文案改「已向紧急联系人发出通知（结果以通知记录为准）」三语；API.md §7 写明 `notified` 不等于已送达 | `sos/sos-notifier.service.ts`、`app/src/i18n/messages/auth.ts`、`docs/API.md` | audit-sos 两个 SOS-04 用例转绿。**WS `sos_update` 未加字段**（避免 Contract 破坏性变更），App 端完整结果仍需看事故详情 |
| **SOS-03** | 决策 #40（负责人 2026-09-15 三选一拍板「两单并存」）：合并规则改为按「设备 + 当前绑定用户」找进行中的单；数据库 partial unique index 由「每设备至多一个 pending」改为「每设备每用户至多一个 pending」；启动对账同口径。前用户的单不受换绑影响（「解绑不影响处置权」保持），新用户的事件另建新单 | `sos/sos-trigger.service.ts`、`sos/sos-scheduler.service.ts`、migration `20260914155128_sos_pending_per_device_user`、`prisma/schema.prisma`（注释）、`docs/EVENTS.md §4.4`、`docs/DECISIONS.md #40`、`docs/API.md §7` | audit-sos 两个 SOS-03 用例转绿；既有 sos/hardening-sos/accidents/admin e2e 36/36；空库从头跑 17 个 migration 通过 |
| **SOS-08** | 重试成功后清 `lastError` | `sos/sos-notifier.service.ts` | audit-sos 通过 |
| **MQTT-01** | 认证回调接收 `clientid`：后端保留 clientId（`MQTT_BACKEND_CLIENT_ID`）只允许服务账号使用、服务账号必须用它；设备 clientId 未强制等于 deviceId（协议未约定，留待硬件） | `emqx/emqx-hook.service.ts`、`emqx/emqx-hook.controller.ts`、`docs/DEVICE_PROTOCOL.md §3` | audit-mqtt-hook 转绿；**真实 EMQX 复验**：设备密钥 + 后端 clientId → `Not authorized`（`evidence/mqtt/takeover-verify.log`）。复验中发现：频繁重启后端会让 EMQX 的 HTTP 回调连接池进入故障态而 fail-closed 全拒（DEVELOPMENT.md 已知坑），需 `docker restart` EMQX 清池后再测 |
| **MQTT-02** | `resubscribe: false`（mqtt.js 不再用内存缓存去重 subscribe，每次 connect 都真发 SUBSCRIBE）；SUBACK 里 qos=128 视为失败重试；日志打印 `sessionPresent` | `ingest/mqtt-consumer.service.ts` | **真实 EMQX 复验**：服务账号 clean:true 顶替 → 消费者重连（sessionPresent=true）→ 日志「已订阅」→ 探针事件照常入库（`evidence/mqtt/backend-fix-verify.log`） |
| **AUTH-01/02** | `LoginDto.password`、`ChangePasswordDto.oldPassword/newPassword` 加 `@MaxBytes(72)` | `auth/auth.dto.ts` | audit-auth-account、audit-contract 转绿 |
| **AUTH-03** | register / changePhone 捕获 P2002 → 409 `PHONE_ALREADY_REGISTERED` | `auth/auth.service.ts` | audit-auth-extra 转绿 |
| **AUTH-06** | battery-history 走 `BindingScopeService`，按 `receivedAt` 只返回本人绑定区间内的心跳；API.md §4 补口径 | `devices/devices.service.ts`、`docs/API.md` | audit-auth-binding、audit-contract 转绿；`devices.service.spec.ts` 补注入 |
| **AUTH-08** | 限频桶：所有规则判完才记账（被拒请求不建桶）；超容量改为淘汰最久无命中的桶，不再整表清空；`ip+phone` 只把合法手机号当 key | `common/rate-limit.guard.ts` | audit-auth-ratelimit 转绿（测试改用合法格式的合成号） |
| **AUTH-05 / INGEST-04** | 注销账号时服务端以 4401 主动断开该用户全部 WS 连接（`RealtimeGateway.closeUser`） | `realtime/realtime.gateway.ts`、`users/users.service.ts`、`users/users.module.ts`、`docs/API.md §2` | audit-realtime 转绿 |
| **AUTH-09 / AUTH-10** | App 刷新三态：只有 refresh 返回 401 才清会话；429/5xx/断网保留会话；刷新在途时用户已登出/换号则丢弃并作废新 token | `app/src/api/client.ts` | audit-auth-client 4/4 转绿 |
| **INGEST-01** | `SUPPORTED_SCHEMA_VERSIONS={1}`：未知版本按原 eventId 留档但不分发，app-relay/webhook 计入 `invalid`；对账查询同样只看支持的版本 | `ingest/envelope.ts`、`ingest/ingest.service.ts`、`docs/EVENTS.md` | audit-ingest-entries 转绿（矩阵里 schemaVersion=2 的期望改为「留档不分发」） |
| **INGEST-02** | webhook body 为 undefined（非 JSON Content-Type / 空体）时按空文本进 Ingest → 202 invalid 留档 | `ingest/webhook.controller.ts` | 转绿 |
| **INGEST-03** | `_invalid` 留档前把原始 NUL 字节改写为可见的反斜杠 u0000 转义文本，留档本身不再被 PostgreSQL 拒绝 | `ingest/envelope.ts` | 转绿 |
| **ADMIN-01** | 新增 `QueryError` 组件；五个页面接口失败时显示错误横幅 + 重试，表格不渲染数据；概览指标显示「—」而非 0 | `admin/src/components/QueryError.tsx`、五个 `admin/src/pages/*.tsx` | **真实浏览器复验** E1–E6 全部 PASS（`evidence/admin/browser-results-fix.json`、`screenshots/FIX-*.png`） |
| **ADMIN-02** | 关键词进 LIKE 前转义 `%`、`_`、反斜杠 | `admin/admin.service.ts` | audit-admin 转绿 |
| **ADMIN-03** | 登录页区分 401（凭证错误）与网络层失败（「无法连接服务器」） | `admin/src/pages/LoginPage.tsx` | 浏览器复验 A3 PASS |
| **APP-01** | 根布局订阅 auth store：登出或 user.id 变化时 `queryClient.clear()` | `app/src/app/_layout.tsx` | static（无运行时环境） |
| **APP-03 / APP-04（部分）** | 所有请求 15s 超时（AbortController）；新增 `error.timeout` 三语文案并映射 | `app/src/api/client.ts`、`app/src/api/error-messages.ts`、`app/src/i18n/messages/errors.ts` | 单测通过；9 个未映射后端码仍待补文案 |
| **BLE-03…08** | 上行队列重写：多设备轮转提交；溢出先丢周期事件、高危事件最后丢；4xx（404/403/400）不可恢复错误丢弃该设备批次不再无限重试；队列与文件按账号分区（`startRelayUplink(userId)`，文件带 `{v, owner, events}` 标记，旧裸数组不恢复）；恢复按 eventId 去重；文件内容非法不抛未处理 rejection；定时器 unref | `app/src/services/ble-relay-uplink.ts`、`app/src/hooks/use-realtime.ts` | audit-ble-defects 9/9 转绿、既有 uplink 测试通过（三个持久化用例改为带归属的文件格式） |
| **VOICE-01** | 加入频道的锁内先查成员身份，已是成员直接幂等返回 | `voice/voice.service.ts` | audit-voice-defects 转绿 |
| **VOICE-02** | 注销事务内删除全部频道成员行；API.md §2 补口径 | `users/users.service.ts`、`docs/API.md` | 转绿 |
| **MEDIA-01** | 事件详情的媒体反查限定同一 deviceId | `events/events.service.ts` | audit-media-defects 转绿 |
| **ADMIN-04** | 口径（负责人 2026-09-15 拍板「记录保留」）：已注销账号记录保留供事故归属与审计；用户列表默认 `deletedAt IS NULL`，`includeDeleted=true` 时列出并带 `deletedAt`；`stats/overview.userTotal` 只计未注销；后台用户页加「含已注销」筛选，已注销行以标记代替手机号并显示注销时间 | `admin/admin.service.ts`、`admin/admin.controller.ts`、`admin/admin.dto.ts`、`packages/shared/src/api.ts`（`AdminUserRow.deletedAt`）、`admin/src/pages/UsersPage.tsx`、`docs/API.md §10` | audit-admin 29/29 转绿；既有 admin/admin-detail-stats/admin-events/account e2e 32/32 |
| **DBOPS-01** | 轨迹查询 orderBy 追加 `id` 次序键 | `locations/locations.service.ts` | audit-dbops 转绿 |
| **DBOPS-05** | /health 503 直接写状态码返回文档规定的 `{status, database}` 体 | `health/health.controller.ts` | 转绿 |
| **SOS-09**（2026-09-17 补） | `deliverPending` 排序改为 `[{channel:'desc'},{createdAt:'asc'},{id:'asc'}]`：同一单 sms 先于 push，全序稳定，`take:100` 也优先装短信行；测试助手 `notificationsOf` 同口径读回 | `sos/sos-notifier.service.ts`、`test/helpers/audit-sos.ts`、新增 `test/sos-notify-order.e2e-spec.ts` | 新回归 2/2 转绿（含 push 行 backdate 5s 的最坏情况）；audit-sos-faults 7/7；全量 e2e 46 套件 452/452 |
| **APP-02**（2026-09-17 补） | 删除 5 个 spike-* 页与 `EXPO_PUBLIC_TRTC_SDKAPPID/SECRETKEY`（对讲早已改服务端签发 UserSig），`.env.example` 同步 | `app/src/app/(tabs)/spike-*.tsx`、`app/src/app/spike-map-web.tsx`、`app/.env.example`、`docs/THIRD_PARTY.md` | 客户端包内不再含任何 TRTC 密钥；App 单测 172/172 |
| **DBOPS-06** | 用户守卫拒绝 `typ=admin` 的 token；两密钥同值时启动打 ERROR 日志（不阻断启动） | `auth/jwt-auth.guard.ts`、`admin/admin.constants.ts` | 转绿 |
| **AUTH-04**（2026-09-18 补） | `issue()` 的「查最新 → 计数 → 建记录」放进事务并按 `sms:<purpose>:<phone>` 取 `pg_advisory_xact_lock`（项目既有约定），短信在事务外发 | `auth/sms-code.service.ts` | audit-auth-account「并发发送同一号 ×6」改为精确断言（1×204 + 5×429、库 1 条、Provider 1 次）转绿；单测断言锁在查写之前 |
| **AUTH-11**（2026-09-18 补） | 验证码短信调用包 `SMS_SEND_TIMEOUT_MS`（默认 10s）超时，超时按发送失败删记录并 503；`TencentSmsProvider` httpProfile `reqTimeout: 10` | `auth/sms-code.service.ts`、`common/with-timeout.ts`、`providers/tencent-sms.provider.ts` | 单测（假时钟）：挂起 Provider → 2s 后 503 + 删记录 |
| **AUTH-07**（2026-09-18 补） | `trust proxy` 改由 `TRUST_PROXY` 决定，默认不信任任何 X-Forwarded-For；compose 显式 `TRUST_PROXY=1`（backend 只经 Caddy 一跳） | `common/trust-proxy.ts`、`main.ts`、`deploy/docker-compose.prod.yml`、`.env.example` | 单测覆盖取值解析；audit-auth-ratelimit 既有「无 trust proxy 伪造 XFF 不能绕过」用例即默认形态 |
| **SOS-06**（2026-09-18 补） | `finalizeNotified` 内联首投包 try/catch 只记日志：终态化已提交即成功，投递由扫描续投 | `sos/sos-notifier.service.ts` | audit-sos-faults ③ 由「观察 500」改为断言 200 + notified、扫描续投恰一次 |
| **DBOPS-07**（2026-09-18 补） | 自管 SIGTERM/SIGINT：先把 `/health` 切到 `503 draining`，等 `SHUTDOWN_DRAIN_MS`（默认 3s）再 `app.close()` 退出 0；compose `stop_grace_period: 15s` | `main.ts`、`common/shutdown-state.ts`、`health/health.controller.ts` | 新增 audit-shutdown（真实进程 `node dist/main.js`）：SIGTERM 后 150ms 内 /health 503 draining、排空期内登录接口仍 401、期满退出 0 并释放端口；CI 把 Build 提到 e2e 之前 |
| **CONTRACT-04/05/06/11/12/13/14/15**（2026-09-18 补） | shared 增 `PutSettingsResponse`、`AdminDeviceRow` 改 `Omit<DevicePublic,'name'\|'bindCode'>`；API.md §1.1 补 SERVICE_UNAVAILABLE 与各节错误码索引、§1.2 补 draining、§8 补 executedAt 非法值口径、§13 补 joinedAt；EVENTS.md 4.5 改为「原样落库并告警」；删除未文档化的根路由 `GET /api/v1/`（AppController/AppService）；CLAUDE.md 找回密码页状态更新 | `packages/shared/src/api.ts`、`docs/API.md`、`docs/EVENTS.md`、`CLAUDE.md`、`backend/src/app.module.ts` | shared/backend/admin typecheck 通过；App 侧 `devices.ts` 改用 PutSettingsResponse 归 A 线 |
| **HYG-01/02**（2026-09-18 补） | `git rm` 两个已跟踪的「 2」副本；`.gitignore` 加 `* 2.*` / `* 2/`；backend tsconfig `exclude` 与 jest `testPathIgnorePatterns` 排除「 2.ts」 | `.gitignore`、`backend/tsconfig.json`、`backend/package.json`、`backend/test/jest-e2e*.json` | `git ls-files \| grep ' 2\.'` 为空 |

## 未修（需拍板或超出本轮范围）

- ~~SOS-06、AUTH-04/07/11、DBOPS-07、CONTRACT 差异、HYG~~（**2026-09-18 已修，见上表**）；SOS-07（BY_DESIGN：Provider 已收但 sent 未落库时下一轮重发，上限 `SOS_NOTIFY_MAX_ATTEMPTS`，宁可重发不可漏发——记录为设计口径）；MQTT-03（网关 `/api/v1/internal/*` 404，随部署配置批次 `chore/prod-ops`）；APP-04 的 9 条文案（A 线）；DBOPS-08（`npm audit fix` 涉及依赖升级需双人同意；本机 npm 源为 npmmirror 不提供 audit 接口，需 `--registry=https://registry.npmjs.org` 复跑；Dockerfile 含 devDependencies 是头注明的刻意取舍：provision/create:admin 脚本与 prisma CLI 要在容器内跑）；ENV-01/02 本机环境。

## 修复后的最终校验

- backend：`tsc` 0 错、`eslint`（改动的源码与测试）0 error、单测 86/86、既有 E2E 25 套件 227/227
- 本轮审计套件 219 用例全部通过（含 SOS-03、ADMIN-04 修复验证）
- app：`tsc` 0 错、`expo lint` 0 error、jest 98/98
- admin：`tsc -b` 0 错、`vite build` 通过

## 测试文件的同步调整（均为本轮审计新增的测试，非既有用例）

- `audit-sos-faults` ①：由「缺陷断言」改为「瞬断一次→进程内重试补建」；新增 ①b「持续失败→启动对账补建」
- `audit-sos`：零联系人与短信全失败两个用例改为断言新的 Push 标题
- `audit-auth-ratelimit` AUTH-08：攻击者合成号改为合法格式（守卫现在只把合法手机号当独立 key）
- `audit-ingest-entries`：坏输入矩阵里 schemaVersion=2 的期望改为「按原 eventId 留档、不分发、计入 invalid」（新增 `stored_quarantined` 期望类型）
- `audit-auth-client` AUTH-10：从「观察记录」改为断言 429/503/断网不清会话
- `audit-ble-defects` BLE-06/07：改为显式传入账号归属并使用带 owner 标记的文件格式
- `audit-ble-uplink` 三个持久化用例：断言改为读取 `{v, owner, events}` 结构
- `devices.service.spec.ts`：补 `BindingScopeService` 注入
