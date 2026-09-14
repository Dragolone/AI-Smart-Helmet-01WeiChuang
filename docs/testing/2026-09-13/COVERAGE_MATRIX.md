# COVERAGE_MATRIX.md — 覆盖台账（2026-09-13 / 14）

> 映射：需求/规则 → 实现位置 → 既有测试 → 本轮新增 → 层级/环境 → 结果 → 证据。
> 层级：static / unit / integration（进程内 e2e，真实 PostgreSQL）/ real-process（真实 dist 进程）/ device(browser)（真实 Chrome）/ device（真机，**本轮无**）/ real-third-party（**本轮无**）。
> **未覆盖项一律列出，不隐藏。**

## 0. 汇总

| 维度 | 数量 | 说明 |
|---|---|---|
| 台账条目（后端四域结构化） | 83 | PASS 54 · 含缺陷断言的混合结果 21 · FAIL 6 · BLOCKED 1 · OUT_OF_SCOPE 2 |
| 本轮新增测试文件 | 后端 19 个 `audit-*.e2e-spec.ts` + 5 个 helper；App 6 个 `audit-*.test.ts` | 见 §6 |
| 既有 E2E 基线 | 25 套件 / 227 用例全过 | `evidence/baseline/e2e-baseline.log` |
| 既有 E2E 源码覆盖率 | 语句 **92.35%** / 分支 **77.78%** / 函数 93.83% / 行 92.97% | 分母 = `backend/src/**/*.ts` 去掉 generated、`*.spec.ts`、杂散 `* 2.ts`、`main.ts`；`evidence/baseline/e2e-cov.log` |
| 后端单测 | 8 套件 86 用例全过；语句覆盖 21.06% | 单测只覆盖纯函数与少量 service |
| App 单测 | 7 套件 51 用例：40 过 / 11 为刻意保留的缺陷断言 | `evidence/ble/`、App 侧 jest |
| 真机验收 | **0 项** | 无 Android/iPhone 真机与可用模拟器 → `DEVICE_CHECKLIST.md` 全表未测 |
| 真实第三方 | **0 项** | 短信/推送/存储/TRTC 全部 Mock 或未配置 |

### 覆盖率分母说明（避免误读）

- 后端 e2e 92.35% 的分母**包含未被任何测试 import 的业务文件**（`collectCoverageFrom: src/**/*.ts`），已排除 Prisma 生成代码、测试文件、iCloud 杂散副本、`main.ts`。
- 最低覆盖文件：`ingest/mqtt-consumer.service.ts` **41%**（进程内 e2e 无 Broker，其订阅/重试/PUBACK 路径只由 MQTT 域的真实进程测试覆盖）、`providers/tencent-sms.provider.ts` 61%（真发分支未触达）、`health.controller.ts` 67%（503 分支）。分支覆盖最低目录：`providers` 21.9%。
- **App 覆盖率不给百分比**：jest 配置只统计被 import 的文件（默认无 `collectCoverageFrom`），先前 81% 的数字只覆盖 3 个文件，不代表 App 整体；页面/组件层无自动化测试。

## 1. 后端四域结构化台账

### sos

| 需求 / 规则 | 实现位置 | 既有测试 | 本轮新增 | 层级 | 结果 | 证据 |
|---|---|---|---|---|---|---|
| 全链路逐层：app-relay possible_fall → raw_events(source=app_relay, clock_skew) → sos_cases(deadline=服务器时间+倒计时) → WS/REST active/accidents/Admin → 到期 tick → 通知行 → Provider 次数 → 详情脱敏 | ingest/app-relay + sos-trigger/scheduler/notifier | sos.e2e、app-relay.e2e | audit-sos.e2e 用例 1 | integration(e2e in-process) | **PASS** | evidence/sos/final-run-sos-suites.log |
| 默认 60s 倒计时 + 真实扫描定时器（不手动 tick） | sos.constants countdownMs/scanIntervalMs | 无（旧用例均缩短） | audit-sos-realtime.e2e | integration(e2e in-process, 真实时间) | **PASS（55s 仍 pending，60–64s 内 notified，通知各恰一次）** | evidence/sos/audit-sos-realtime.log |
| 取消 / SOS Now / 终态后再操作 409 / 扫描不复活已取消单 | sos.service cancel/confirm | sos.e2e | audit-sos.e2e 取消用例 | integration | **PASS** | final-run-sos-suites.log |
| 重复触发只留档 / 同 eventId 重放 duplicate / pending 中 manual_sos 立即通知 / 终态后新事件建新单且旧单处置不污染新单 | sos-trigger createOrMerge/applyMergeRule | sos.e2e、hardening-sos | audit-sos.e2e 合并用例 | integration | **PASS** | final-run-sos-suites.log |
| 无联系人 / 重复手机号去重 / 通知部分失败只重试失败行 / 达上限 3 次终态 failed / 详情如实暴露 failed | sos-notifier finalizeNotified/deliverPending | sos.e2e、hardening-sos | audit-sos.e2e 3 用例 | integration | **PASS（语义问题见 SOS-04）** | final-run-sos-suites.log |
| 事件坐标非法（lat=91 / 缺 coordinateSystem）回落最新轨迹点；无轨迹空快照照建单；SMS 位置文本「暂不可用」 | extractSosLocation/resolveSnapshot | sos-trigger.service.spec、sos.e2e | audit-sos.e2e 快照用例 | integration | **PASS** | final-run-sos-suites.log |
| 竞态：25 并发 possible_fall 恰 1 单；同 eventId 并发重放 10 次仅 1 stored；cancel×5+confirm×5（含第二台 App token）恰 1 个 200；cancel/tick 同刻 5 轮；confirm/tick 同刻 5 轮；到期后 confirm+tick 同刻 5 轮 | partial unique index + 条件更新 + attempts 占位 | hardening-sos 8 用例 | audit-sos.e2e 4 用例 + faults ⑥ | integration | **PASS** | final-run-sos-suites.log |
| 真实进程重启接管（决策 #8）：deadline 前 SIGKILL → 过期后重启 → 启动接管日志 + notified + SMS/Push 各恰一次；「notified 但通知行 pending」续投；「failed 行」重试 | SosSchedulerService.onModuleInit/tick + deliverPending | 旧报告 §真实进程端到端（12s，非重启） | scripts/run-restart-recovery.sh（18 项断言） | real-process | **PASS** | evidence/sos/real-process-restart.json / .log / rp-backend-1..4.log |
| 故障注入：raw 落库后建单失败（①）、快照查询失败（②）、通知行创建后投递前中断（③）、占位后 Provider 挂起（④）、Provider 接收但 sent 未落库（⑤） | sos-trigger / sos-notifier | 无 | audit-sos-faults.e2e | integration | **①②④ FAIL（缺陷断言，SOS-02/01/05）；③⑤ PASS（SOS-06/07 记录）** | evidence/sos/audit-sos-faults.log |
| 交叉操作：pending 期间联系人增删改（finalize 时点读取）；换绑（原主可处置、新主 404/active null、到期通知原主联系人）；注销账号（token 全 401、到期照终态化、联系人软删 0 SMS、Admin 可见 deleted:<id>）；同账号多台 App WS 同步 | sos.service getOwned/ensureDeviceOwned、finalizeNotified 读联系人 | hardening-sos 换绑用例 | audit-sos.e2e 5 用例 | integration | **PASS（换绑合并规则缺口见 SOS-03）** | final-run-sos-suites.log |
| notified / 任务创建 / Provider 接收 / 联系人实际收到 四者语义区分 | sos.status + sos_notifications.status + Provider 日志 | 无 | audit-sos.e2e 无联系人与 SOS-04 用例 | integration + static | **FAIL（SOS-04）** | final-run-sos-suites.log；app/src/i18n/messages/auth.ts:64 |
| MQTT 入口触发 SOS（真实 EMQX） | mqtt consumer → ingestRaw(source='mqtt') | emqx-hook.e2e、mqtt 域 | 本域用 ingest.ingestRaw(...,'mqtt') 直接驱动（覆盖同一分发路径，未经真实 broker） | integration | **PASS（分发路径）/ NOT_RUN（真实 broker，归 mqtt 域代理）** | final-run-sos-suites.log |
| 真实短信/推送送达 | TencentSmsProvider / PushProvider（Console Mock） | 无 | 无 | real-third-party | **BLOCKED** | — |

### auth

| 需求 / 规则 | 实现位置 | 既有测试 | 本轮新增 | 层级 | 结果 | 证据 |
|---|---|---|---|---|---|---|
| 注册/登录/refresh/logout/找回/改密/换号/注销全流程 | backend/src/auth/*、users/* | test/auth.e2e-spec.ts 等（基线 25 套件） | audit-auth-account（18） | integration(e2e in-process) | **FAIL（3 缺陷断言：AUTH-01/02/03；其余 15 通过）** | account.log、jest-audit-auth-account.txt |
| 验证码：过期/60s/日限/错码上限/一次性/并发消费/并发发送/用途隔离/发送失败回滚/号码枚举 | sms-code.service.ts | sms-code.service.spec.ts | audit-auth-account 验证码 8 例 + audit-auth-extra 一次性 | integration | **PASS（并发消费恰 1 成功；发送失败回滚 + 不计限频）；FAIL 观察：并发发送穿透（AUTH-04）；号码枚举 BY_DESIGN（API.md §2 明示 409/404）** | account.log |
| refresh：过期/并发 ×8 只 1 成功/10s 宽限内复用只拒本次/超窗复用撤销全部 | auth.service.ts refresh | auth.e2e-spec | audit-auth-account refresh 3 例 | integration | **PASS** | account.log |
| 撤销矩阵：改密（其他撤销/本设备保留/他人 token 不保留）、找回（全撤）、换号（不撤）、注销（全撤 + 残留 access 9 接口 401 + 新 WS 4401 + 号码释放再注册） | auth.service / users.service / jwt-auth.guard / realtime.gateway | hardening 套件 | audit-auth-account 撤销矩阵 4 例 | integration | **PASS；已建立 WS 不踢=AUTH-05（注销）/ BY_DESIGN（改密/找回，§2 15 分钟窗口）** | account.log、extra.log |
| 授权矩阵：26 探针（设备/轨迹/事件/媒体/SOS/事故/联系人/频道/设置/命令/relay-ack/app-relay）× A 本人 / B 跨用户 / 匿名 / 过期 / 篡改签名 / alg=none / admin 密钥签用户 / 已注销 / ghost sub | jwt-auth.guard + 各 service getOwned | 各 e2e | audit-auth-authz（7） | integration | **PASS（跨用户一律 404 且状态未被改动；伪造 6 类 ×26 全 401；不存在资源 404 口径一致）** | authz.log |
| Admin 隔离：用户 token / 用户密钥 typ=admin / admin 密钥无 typ / 匿名 → 6 个 admin 路由 401；admin token 进用户接口 401；admin 不受绑定区间限制 | admin-auth.guard.ts | admin e2e | audit-auth-authz | integration | **PASS** | authz.log |
| PATCH /users/me 白名单（phone/passwordHash/deletedAt/id/createdAt 丢弃）；联系人/设备重命名 body 塞 userId/bindUserId/bindCode/settings 不生效 | ValidationPipe whitelist + DTO | 无 | audit-auth-authz | integration | **PASS** | authz.log |
| 决策 #39：A→B→A 三段区间（事件列表/详情、轨迹 latest/range、事故按 userId 固化）、8 个边界时刻（区间端点闭区间、间隙、绑定前）SQL 精确置时 | binding-scope.service + events/locations/media/sos | binding-scope e2e | audit-auth-binding（5） | integration | **PASS** | binding.log |
| 决策 #39 晚到/离线补传：timestamp 在 B 期、receivedAt 在 A 期 → 归 A（契约）；timestamp 在 A 期、receivedAt 在 B 期 → 归 B（A 自己骑行期间的事件归了 B——风险单列，未暗改为 timestamp） | 同上 | 无 | audit-auth-binding | integration | **PASS（按 receivedAt 既定规则）；风险：4G/离线补传场景前主数据可流向新主，建议 API.md §4 明写** | binding.log |
| battery-history 按区间过滤 | devices.service.ts batteryHistory | 无 | audit-auth-binding | integration | **FAIL（AUTH-06）** | binding.log |
| 绑定竞态（#10）：6 用户并发绑 → 1×200/5×409、区间 1 段；并发解绑+再绑 open 区间 ≤1 | devices.service.ts bind/unbind | devices.service.spec | audit-auth-binding | integration | **PASS** | binding.log |
| 限频（真实 HTTP，不设 RATE_LIMIT_DISABLED）：login 10/IP+号、100/IP；sms 5/IP/分；register 20；reset 10/IP+号；refresh 60；admin login 10；429 体 + Retry-After；env 运行时读取；logout/已登录接口无限频 | rate-limit.guard.ts + 各 controller | 无（基线固定 RATE_LIMIT_DISABLED=1） | audit-auth-ratelimit（6 e2e）+ real-ratelimit.sh | integration + real-process | **PASS（各限额、Retry-After=60、guard 先于校验故 400 也吃额度=BY_DESIGN、同出口第 6 用户 429=BY_DESIGN NAT 口径）** | ratelimit.log、real-ratelimit.log |
| 限频 X-Forwarded-For：helper 无 trust proxy 不可绕过；trust proxy=1 直连可绕过 | main.ts | 无 | audit-auth-ratelimit + real-ratelimit.sh | integration + real-process | **FAIL 条件性（AUTH-07，生产经 Caddy 缓解）** | ratelimit.log、real-ratelimit.log |
| 限频桶策略：窗口恢复/Retry-After 递减/60s 清理 24h 无命中桶/容量 5 万清表/规则顺序副作用 | rate-limit.guard.ts | 无 | audit-auth-ratelimit guard 单元 4 例 | unit（真实类） | **PASS 3 / FAIL 1（AUTH-08）** | ratelimit.log |
| 密码 72 字节：汉字（24=72B / 72=216B）、emoji（18=72B / 19=76B）、混合恰 72B，覆盖 register/login/reset/change-password | auth.dto.ts MaxBytes | auth.service.spec | audit-auth-account + audit-auth-extra | integration | **register/reset PASS；login/change-password FAIL（AUTH-01/02）** | account.log、extra.log |
| WS 按 access exp 断开（#13）；过期 token 连接 4401 | realtime.gateway.ts expiryTimers | realtime e2e | audit-auth-extra | integration | **PASS（exp=2s → 1145ms 后 4401）** | extra.log |
| App api 客户端：并发 401 只刷新一次；刷新与 signOut/换账号交错；刷新非 401 失败 | app/src/api/client.ts | 无 | app/src/api/__tests__/audit-auth-client.test.ts（4） | unit | **PASS 2 / FAIL 2（AUTH-09）；AUTH-10 观察** | jest-app-audit-auth-client.txt |
| Token/SecureStore/React Query/文件缓存/头像/日志跨账号隔离；分享/媒体 URL 时效 | App 各层 / media.service | 无 | 无 | static | **OUT_OF_SCOPE（App 运行时与媒体归 app/media 代理；本领域只做 api client 单测）** | — |
| 真实短信通道 / 真实推送 | TencentSmsProvider | 无 | 无 | — | **NOT_RUN（规则禁止真发；Mock 成功 ≠ 真实送达）** | — |

### ingest

| 需求 / 规则 | 实现位置 | 既有测试 | 本轮新增 | 层级 | 结果 | 证据 |
|---|---|---|---|---|---|---|
| 三入口（MQTT 消费路径 / webhook / app-relay）同一合法事件业务效果一致（raw source 各异；轨迹、快照、WS 五类推送、§6 可见） | ingest.service.ts ingestRaw/dispatchStored | app-relay/webhook/hardening-ingest e2e（各入口单独） | audit-ingest-entries「三入口业务等价」 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| 跨入口重放同 eventId 只存一次、possible_fall 跨入口重放只建一单 SOS | persist P2002 幂等 + SosTrigger 合并 | hardening-ingest（单入口） | audit-ingest-entries「跨入口重放」 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| MQTT topic/deviceId 不符 → device_id_mismatch_with_topic 留档到 topic 设备；未识别 topic 忽略 | mqtt-consumer.service.ts processPublish + envelope.ts | — | audit-ingest-entries「MQTT topic 解析」 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| 坏输入矩阵 30 条 × 三入口（schemaVersion 非整数/负/int32 越界/1e18、缺字段、未知 eventType、坏坐标、极端数值、非法日期 02-30/13 月/0000 年/缺时区/+25:00、payload 非对象、NUL 转义、1000 层嵌套）——正确拒绝或原始留档、接口不 5xx | envelope.ts validateEnvelope | hardening-ingest（部分） | audit-ingest-entries「坏输入矩阵」3 用例 + 「入库但不进业务」 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| 未知 schemaVersion（999）不进业务流程（EVENTS.md §1） | envelope.ts（缺失） | — | audit-ingest-entries「【INGEST-01 缺陷断言】」 | integration(e2e in-process) | **FAIL** | 见 INGEST-01 |
| HTTP 层坏体：非法 JSON 400、原始 NUL 字节 400、>100KB 413 PAYLOAD_TOO_LARGE（app-relay 与 webhook） | body-parser + UnifiedExceptionFilter | hardening-ingest | audit-ingest-entries「HTTP 层坏体」 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| webhook 非 JSON Content-Type / 空 body 走留档不 5xx | webhook.controller.ts | — | audit-ingest-entries「【INGEST-02 缺陷断言】」 | integration(e2e in-process) | **FAIL** | 见 INGEST-02（空 body 部分通过，text/plain 500） |
| MQTT 路径原始字节：非法 JSON → invalid_json；>64KB → payload_too_large（raw 截断 4096） | envelope.ts | — | audit-ingest-entries「MQTT 路径原始字节」 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| MQTT 路径原始 NUL 字节留档不丢 | envelope.ts buildInvalidRecord | — | audit-ingest-entries「【INGEST-03 缺陷断言】」 | integration(e2e in-process) | **FAIL** | 见 INGEST-03 |
| 部分批次中断：100 条发完后客户端立刻断开 → 服务端处理完 100 条、补传全 duplicate、possible_fall 仅一单；只发一半断开 → 0 条入库、补传全 accepted | app-relay.controller.ts 逐条顺序处理 | — | audit-ingest-entries「部分批次中断」2 用例（原始 socket destroy） | integration(e2e in-process, real TCP) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| DB 连接类故障（P1001）：app-relay/webhook 5xx INTERNAL_ERROR 不留档、恢复后重传入库；MQTT 路径重试 2 次（300ms 退避）后成功，3 次失败抛出放弃 | ingest.service.ts dbRejectionCode + mqtt-consumer PERSIST_RETRIES | — | audit-ingest-entries「数据库连接类故障」「MQTT 路径重试」 | integration(e2e in-process, spy 注入) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| DB 数据类拒绝（P2000）：三入口降级 _invalid reason=db_rejected_P2000，接口不 5xx | ingest.service.ts | hardening-ingest | audit-ingest-entries「数据类拒绝」 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| WS 缺失/乱码/伪造签名/过期 token → 4401 且不进连接表 | realtime.gateway.ts handleConnection | realtime / hardening-realtime | audit-realtime 用例 1 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 短 exp token 到期定时 4401 关闭；expiryTimers/clientUser/byUser 同步清理；到期前推送正常 | realtime.gateway.ts expiryTimers | hardening-realtime | audit-realtime 用例 2 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 重连语义：断线期间不补发；重连后 REST latest/轨迹拿到全部点（兜底） | gateway + locations API | — | audit-realtime 用例 3 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 慢客户端（socket 暂停）不拖慢同用户其他 5 连接（200 条 <3s 全收），慢连接不被踢、恢复后补收 | pushToUser 同步扇出 ws.send | — | audit-realtime 用例 4 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 上行垃圾帧（1MB 二进制/非 JSON/伪造 device_command/伪造 sos_update/订阅指令）：连接不断、不产生命令或 SOS、后续推送正常 | gateway 无上行处理 | hardening-realtime | audit-realtime 用例 5 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 多连接广播（同用户 4 连接全收、他人 0 收）与 close/terminate 混合断开后三张私有 Map 无残留 | handleDisconnect | hardening-realtime（300 连接） | audit-realtime 用例 6 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 连接补推：pending/delivered 按 issuedAt 升序补推；offline/success 不补推；他人连接不收 | commands.service.ts setUserConnectedHandler | commands-relay | audit-realtime 用例 7 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 注销账号后已建 WS 连接被关闭；同 token 重连 4401 | users.service.ts deleteAccount（未联动网关） | — | audit-realtime「【INGEST-04 缺陷断言】」 | integration(e2e in-process) | **FAIL** | 见 INGEST-04（重连 4401 部分通过） |
| 命令 pending→delivered（PUBACK=delivered、deliveredAt 落库、wire 含 commandId/params）；发布 reject 留 pending；未超时 tick 不动；超时 tick → offline；offline 期间设置不生效、REST 显示 offline/ackResult null | commands.service.ts putSettings + commands-scheduler.service.ts tick | commands.e2e | audit-commands 用例 1 | integration(e2e in-process, MqttConsumerService stub) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| delivered→success 写设置；delivered→failed 记 errorCode 不写设置；重复/翻转回执（MQTT 与 relay-ack）不改终态 | applyAck 条件更新 | commands.e2e / commands-relay | audit-commands 用例 2 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| 迟到 executed（MQTT 与 relay-ack 各一路）覆盖 offline 并写入设置；offline 后 relay delivered 不回退 | applyAck | commands.e2e / commands-relay（单路） | audit-commands 用例 3 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| 伪造/串线回执：未知 commandId、他设备冒领（MQTT）忽略；他人 relay-ack 404 DEVICE_NOT_FOUND；跨设备 404 NOT_FOUND；非法 JSON/非法 result 不炸 | handleAck parseAck / relayAck 归属校验 | commands.e2e | audit-commands 用例 4 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| 按键合并：A{vol=1,ledA} → B{vol=9} success → A 迟到 success：vol 保持 9、ledA 合入；正序 C→D 后者生效 | applyAck shadowed keys | commands.e2e（部分） | audit-commands 用例 5 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| 同一命令 MQTT cmd_ack(success) 与 relay-ack executed(failed) 并发 ×5：只终态化一次、终态/ackResult/errorCode 一致、设置只按赢家写、事后再补另一结果不翻转 | applyAck $transaction + updateMany 条件更新 | — | audit-commands 用例 6 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| 超时扫描 tick 与 success 回执并发 ×3：终态必为 success，后续 tick 不覆盖 | tick updateMany where status in pending/delivered | — | audit-commands 用例 7 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| executedAt 非法（MQTT 与 relay）→ 服务器时间兜底；stage=executed 缺 result / stage 非法 / result 非法 → 400 VALIDATION_FAILED 且状态不变 | parseAck / RelayAckDto | commands-relay | audit-commands 用例 8 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| settings 只含 success 命令的键、lastCommand 为最近一次下发；他人 404 | getSettings/getCommand | commands.e2e | audit-commands 用例 9 | integration(e2e in-process) | **PASS** | docs/testing/2026-09-13/evidence/ingest/audit-commands.run2.log |
| 「同一命令多台 App 下发 / App 重启重复接收 → 头盔只执行一次」 | App 侧 commandId 去重（ble-relay，A 线）；后端幂等已验 | app/src/services/__tests__（A 线） | — | — | **OUT_OF_SCOPE** | 后端只能保证回执幂等；「头盔真正执行次数」需真机/App 侧验证，本领域不覆盖 |
| 真实进程（dist, PORT=3400, SOS 15s/扫描 1s/命令超时 8s）+ Mock TRANSPORT=app-relay：SCENARIO=fall / sos / risk / ski 各一轮 | mock-device relay-transport + 全链路 | —（旧报告脚本未入库） | scripts/relay-audit.sh scenario | real-process + simulator | **PASS** | docs/testing/2026-09-13/evidence/ingest/scenarios.summary.log、mock-fall.log、mock-sos.log、mock-risk.log、mock-ski.log、backend-3400.log：1128 条 raw 全部唯一（1128=1128 distinct）；possible_fall 与 manual_sos 各建一单，deadline=创建+15s，均在 deadline 精确终态化 notified（backend 日志 14:25:36→14:25:51、14:25:58→14:26:13）；collision_risk 3 条 + risk_cleared 2 条；ski 114 个点带海拔（1790–2110m 透传） |
| RELAY_OFFLINE_CYCLE=3 断网补传：每第 3 次 flush 留缓存，下轮按原 eventId 补传，服务端无重复 | relay-transport 队列 | — | scripts/relay-audit.sh scenario riding 12 RELAY_OFFLINE_CYCLE=3 | real-process + simulator | **PASS** | docs/testing/2026-09-13/evidence/ingest/mock-riding-RELAY_OFFLINE_CYCLE.log：8 次模拟断网、补传后 accepted 计数与入队一致、duplicate=0；退出瞬间恰逢第 24 次 flush 命中断网周期 → 1 条留在 Mock 缓存未提交（Mock 行为，非后端问题） |
| MOCK_CMD_RESULT=success / failed / silent 经 WS device_command + relay-ack：success→settings 写入；failed→errorCode=MOCK_REJECTED 不写；silent→delivered 8s 后 offline 不写 | commands + relay-ack + scheduler | — | scripts/relay-audit.sh command | real-process + simulator | **PASS** | docs/testing/2026-09-13/evidence/ingest/scenarios.summary.log（三条命令终态 success/failed/offline；settings 仅 {volume_success:7}）、mock-cmd-*.log |
| 真实 EMQX Broker 链路（认证/ACL/订阅失败恢复/启动顺序） | mqtt-consumer + emqx-hook | emqx-hook.e2e | — | — | **OUT_OF_SCOPE** | 任务范围明确「不含真实 Broker」，归 mqtt 代理 |

### mqtt

| 需求 / 规则 | 实现位置 | 既有测试 | 本轮新增 | 层级 | 结果 | 证据 |
|---|---|---|---|---|---|---|
| 设备认证矩阵(正确/错误密钥/无凭证/空密码/不存在设备/冒用后端账号) | backend/src/emqx/emqx-hook.service.ts authenticate | 无专项 e2e | backend/test/audit-mqtt-hook.e2e-spec.ts(AUTHN-*);真机 scripts/auth-acl-matrix.mjs(AUTH-1..8) | real-process + integration | **PASS** | auth-acl-matrix.log AUTH-1..8 全 PASS;audit-mqtt-hook 15 项 authn/authz PASS |
| username=B 但 clientid≠B 可连接(hook 无 clientid 规则) | authenticate 忽略 clientid | 无 | auth-acl-matrix AUTH-5 | real-process | **PASS** | AUTH-5 connect(此即 MQTT-01 的根因表现) |
| Topic ACL:他人 cmd 订阅拒/他人 topic 发布静默丢弃/topic 内冒充 deviceId 留档/非协议/四段/通配/$SYS | emqx-hook.service.ts authorize + ingest device_id_mismatch_with_topic | 无专项 | audit-mqtt-hook(AUTHZ-*);auth-acl-matrix ACL-1..13 | real-process + integration | **PASS** | ACL-1..13 全 PASS(SUBACK 128、B 表 0 新增、device_id_mismatch_with_topic 留档);audit-mqtt-hook AUTHZ 全 PASS |
| 内部回调令牌:无/错令牌 401、fail-closed、header 与 query 两种携带 | internal-token.guard.ts | 无 | audit-mqtt-hook(AUTHN-TOKEN);internal-hook-token.log | real-process | **PASS** | no-token/bad-token→401、array-token→401、good-token→200/deny 判定正确 |
| 后端不可达 fail-closed(EMQX 侧不默认放行) | DEVICE_PROTOCOL §3.1 already implemented | 文档实测记录 2026-08-25 | 观测:后端启动前 EMQX authn/authz econnrefused、设备连接被拒 | real-process | **PASS** | backend-run2.log 启动阶段 econnrefused;EMQX no_match=deny 配置 |
| Caddyfile 是否暴露 /internal(静态) | deploy/Caddyfile | 无 | 静态审计 | static | **FAIL** | 见 MQTT-03 |
| 消费者:EMQX 重启后重连重订阅 | mqtt-consumer.service.ts on('connect')→subscribeWithRetry | 无 | docker restart emqx 后查 subs_cnt 与入库 | real-process | **PASS** | backend-run5.log;EMQX 重启后 subs_cnt=4、探针入库=1 |
| 消费者:启动顺序(后端先于 Broker) | reconnectPeriod + subscribeWithRetry | 无 | 后端先起、EMQX 认证 econnrefused 阶段自动重连 | real-process | **PASS** | backend-run2.log 反复重连直到 Broker+认证就绪后订阅成功 |
| 后端停机期间 QoS1 消息持久会话(clean:false)补投 | mqtt-consumer.service.ts clean:false | 无 | scripts/../offline-redeliver.mjs | real-process | **PASS** | 优雅停机→发 QoS1(stored=0)→重启→stored=1 |
| 消费者:clientId 顶替后重订阅/会话破坏 | 同上 | 无 | takeover.mjs + auth-acl-matrix AUTH-9/10 | real-process | **FAIL** | 见 MQTT-02(subs 4→0、入库 1→0) |
| 剧本 fall→SOS→到期通知(MQTT) | mock SCENARIO=fall→possible_fall→SosTrigger/SosNotifier | sos 域另测 | 真机 mock TRANSPORT=mqtt SCENARIO=fall | simulator + real-process | **PASS** | backend-run6.log:SOS 建单+[MOCK PUSH]倒计时→15s→notified+[MOCK SMS] sos_alert(手机号脱敏)。注:Mock Provider 成功≠真实送达 |
| 剧本 risk 五类 WS 推送(MQTT) | mock SCENARIO=risk→collision_risk/risk_cleared/video_ready→WS | 无 | ws-capture.mjs + mock SCENARIO=risk | simulator + real-process | **PASS** | ws-risk.log:WS 收到 risk_event×4、device_event×2、location_update×22、device_status×1 |
| 剧本 ski altitude 全链路透传(MQTT) | mock SCENARIO=ski→altitude→raw_events/location_points | 无 | mock SCENARIO=ski + psql 查 altitude | simulator + real-process | **PASS** | raw_events.payload.altitude 与 location_points.altitude 均为 1968/1985.5/2003 |
| 命令三态 success/failed/silent + 离线 pending→offline 绝不 success | commands.service.ts putSettings/applyAck + commands-scheduler.service.ts | audit-commands.e2e(in-process) | 真机 mock MOCK_CMD_RESULT=success/failed/silent + 无设备离线 | real-process + simulator | **PASS** | success→success+设置写入{volume:7};failed→failed+设置不写;silent→delivered→offline+不写;无设备→delivered(PUBACK)→offline。delivered=PUBACK≠success |
| 迟到 cmd_ack 覆盖 offline + 跨设备伪造回执拒绝 | applyAck offline 覆盖 + handleAck deviceId 校验 | 无 | lateack.mjs | real-process | **PASS** | backend-run6.log:B 对 A 命令的回执「设备不符，忽略」;A 迟到回执「已判 offline 如实覆盖→success」并写入 lateKey:9 |
| 1MB 消息/非 JSON/70KB/QoS 重复投递幂等 | envelope.ts + ingest eventId 唯一约束 + EMQX max_packet_size | ingest 域另测 | auth-acl-matrix MSG-1..4 | real-process | **PASS** | MSG-1 三次投递入库 1 条;MSG-2 invalid_json 留档;MSG-3 payload_too_large 留档;MSG-4 1.1MB 超 Broker 上限断连无 PUBACK |
| 既有 e2e 一套件 --detectOpenHandles 无 --forceExit 是否自然退出 | test/audit-sos-realtime.e2e-spec.ts | 该套件 | 带 --detectOpenHandles 运行 | integration | **PASS** | e2e-detectopenhandles.log:进程自然退出(无 'Jest did not exit'/'Force exiting'/open-handle 报告);唯一失败为 60s SOS 计时用例的时序(属 sos 域，非泄漏) |

## 2. 管理后台（浏览器实测，真实 Chrome + Vite dev + 真实后端）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 未登录深链 `/devices/{id}` → 跳登录页 | **PASS** | `screenshots/A1-unauth-deeplink.png` |
| 错误密码提示 | **PASS**（「用户名或密码错误」） | `A2-wrong-password.png` |
| 后端不可达与密码错误的区分 | **FAIL**（ADMIN-03） | `A3-backend-unreachable.png` |
| 正确凭证登录 → 进后台 | **PASS** | `A4-overview.png` |
| 概览五指标渲染 | **PASS**（设备 6 / 在线 0 / 用户 3 / 今日事件 13 / SOS 0） | `B1-overview-ok.png` |
| 用户 / 设备 / 事故 / 事件四页渲染 | **PASS** | `B2…B5*.png` |
| 昵称含 `<img onerror>` 不执行、原样转义 | **PASS**（`window.__XSS__` 未被置位） | `C1-xss-users.png` |
| emoji / 换行 / 超长昵称显示不破版 | **PASS** | 同上 |
| 搜索命中 + 清空恢复 | **PASS** | `browser-results.json` |
| 搜索 `%` 不当通配符 | **FAIL**（ADMIN-02，`%` 命中全部 3 行） | 同上 |
| 五页接口 500 的呈现 | **FAIL**（ADMIN-01，全部显示「暂无数据」／概览全 0） | `E1-users-500.png`、`E2-overview-500.png` |
| 无效/过期 token → 回登录页 | **PASS** | `F1-expired-token.png` |
| 退出登录清 token + 回登录页 | **PASS** | `browser-results-3.json` |
| 退出后浏览器后退不展示后台数据 | **PASS** | 同上 |
| 设备详情页渲染 + 刷新深层 URL | **PASS**（dev server history fallback；生产 Caddy SPA 回退见 §5） | `G1-device-detail.png` |
| 事件页分页控件 / 筛选控件 | **PASS**（13 行、1 页、1 个筛选控件） | 同上 |
| 第二个标签页共享登录态 | **PASS** | 同上 |
| 390px 小屏横向溢出 | **PARTIAL**（document scrollWidth 635 > 390；表格自带横向滚动，但整页可横向拖动） | `G5-mobile-users.png` |
| 后端边界 e2e（参数校验/分页/搜索/鉴权/概览 SQL 交叉核对/事故详情） | **25 过 / 4 失败**（4 个为 ADMIN-02/04 的缺陷断言） | `admin/audit-admin-run.log` |
| 已注销用户在后台的呈现 | **FAIL**（ADMIN-04，口径待拍板） | 同上 |
| 键盘操作 / 读屏无障碍 | **NOT_RUN** | 需人工 |

## 3. App（静态审计 + 单测；无真机无模拟器）

| 检查项 | 层级 | 结果 | 证据 / 说明 |
|---|---|---|---|
| 路由清单与 spike-* 页生产可达性 | static | **FAIL**（APP-02） | `.expo/types/router.d.ts` 含 5 条 spike 路由 |
| 账号切换的 React Query 缓存隔离 | static | **FAIL**（APP-01） | `profile.tsx:128` 是唯一 `clear()` |
| API 客户端 401 静默刷新 + 请求排队 | unit | **PASS 2 / FAIL 2** | `audit-auth-client.test.ts`（AUTH-09） |
| 刷新遇 429/5xx/断网的处理 | unit | **FAIL**（AUTH-10，误登出） | 同上 |
| 请求超时 | static | **FAIL**（APP-03，无超时） | `api/client.ts` |
| 错误码 → 文案覆盖 | unit | **PASS（缺口已钉死）** | `audit-error-messages.test.ts`：9 码回落「未知错误（CODE）」 |
| 三语字典 key 一致 / 无空串 / 占位符一致 | unit | **PASS 39/39** | `audit-i18n-parity.test.ts` |
| 导航跳转 scheme / 回落网页版 / 坐标系 | unit | **PASS 5/5** | `audit-nav-links.test.ts`（iosamap / androidamap / dev=0 / GCJ-02 不二次偏移） |
| 坐标转换纯函数 | unit | **PASS** | 既有 `coords.test.ts` |
| SOS 倒计时「截止时间戳 + 墙钟」口径 | static | **PASS** | `sos-active.tsx:23-24,39,57` |
| 短信重发 60s 倒计时同口径 | static | **PASS** | `register.tsx:43-48`、`reset-password.tsx:42-47` |
| 找回密码页完整性（含登录页入口） | static | **PASS** | `reset-password.tsx` + `login.tsx:92`（CLAUDE.md「归 A 线待办」已过时） |
| 实时视频预览（决策 #37） | static | **未实现** | `grep -i rtsp\|vlc\|softap` 全仓无命中 → 交付缺口 |
| 每页 loading/空/错误/权限/断网状态 | — | **NOT_RUN** | 需真机或模拟器逐页走 |
| 键盘遮挡 / 安全区 / 大字体 / 长列表 / 深浅色 | — | **NOT_RUN** | 需真机 |
| 权限矩阵（定位/蓝牙/麦克风/通知/相册） | — | **NOT_RUN** | 需真机，清单见 DEVICE_CHECKLIST §8 |
| 后台 10 分钟 / 杀进程 / 重启 / 低电量 / 华为后台 | — | **NOT_RUN** | 需真机，DEVICE_CHECKLIST §9 |
| 地图 WebView 真实渲染 / 轨迹回放交互 | — | **NOT_RUN** | 需真机，DEVICE_CHECKLIST §3 |

## 4. BLE 中转与硬件协议

| 检查项 | 层级 | 结果 |
|---|---|---|
| 上行队列：分批 0/1/99/100/101、幂等、断线补传 | unit | **PASS**（既有 + `audit-ble-uplink.test.ts`） |
| 多设备公平性 / 溢出丢高危 / 404 队头阻塞 / 账号隔离 / 重入 / 损坏文件 | unit | **FAIL ×6**（BLE-03…08，刻意保留） |
| 下行命令 `__DEV__=true/false` 行为 | unit | **PASS**（生产构建不回执，设置页如实 offline） |
| GATT 收发、握手、对时、MTU、ACK、Flash 补传、二进制→envelope、UUIDv5 eventId | — | **未实现**（交付缺口，见 BUGS.md §四 盘点表） |
| v0.6 手册与 DEVICE_PROTOCOL §1.2 摘要一致性 | static | **PASS**（帧长/事件码/地址/ACK 参数一致）；**哨兵值与 EVENTS.md 必填口径冲突** = CONTRACT-08 |
| 真机 BLE 全流程 | device | **NOT_RUN**（无头盔） |

## 5. 部署与运维

| 检查项 | 结果 | 证据 |
|---|---|---|
| 空库全量 migration（16 个） | **PASS** | `evidence/dbops/01-migrate-status-diff-deploy.log` |
| 上一版本升级路径 + `device_bindings` 回填 | **PASS** | `02-upgrade-path.log` |
| 约束（partial unique / 唯一 / 外键）与事务回滚 | **PASS** | `03-constraints.log`、`audit-dbops-run.log` |
| 重复部署幂等 | **PASS** | `01-…log` |
| 索引与查询计划（30 万点轨迹） | **PASS**（走索引）；分页排序不稳定 = DBOPS-01 | `05-explain-analyze.log`、`06-pagination-stability.log` |
| 容量压测（relay/查询/WS/设置/短信/混合 60s） | **PASS（无 5xx、零丢失）** | `30-load-results.jsonl`，数字见 REPORT §4 |
| 负载中注入 SOS 的端到端延迟 | **PASS** | 同上：提交→建单 54ms，到期后 722/941ms 通知 |
| 负载后资源回落 | **PARTIAL** | RSS 574MB 不回落（Node 堆特性，未增长）；PG 连接 10→1、fd 30→21 |
| SIGTERM 优雅退出 | **PARTIAL**（DBOPS-07 无排空期） | `41-recoverability-rerun.log` |
| 误配启动（缺密钥/错 DB） | **PASS**（全部 fail-fast） | `42-misconfig.log` |
| 备份恢复（pg_dump → pg_restore） | **PASS**（计数/约束/partial index 全一致） | `41-recoverability-rerun.log` |
| 依赖漏洞扫描 | **FAIL**（33 项，后端运行时命中 7 个） | `60/62/63/64-*.log` |
| Dockerfile / compose / Caddyfile / EMQX 模板对照 | **静态完成**；`/ws` 升级与 SPA 回退按配置成立；内部 hook 未在 Caddy 排除 = MQTT-03 | `evidence/mqtt/`、`evidence/dbops/` |
| 真实 development/production 环境打点 | **NOT_RUN**（规则禁止连云端） | — |

## 6. 本轮新增测试与脚本

**后端（`backend/test/`）**：`audit-sos.e2e-spec.ts`、`audit-sos-faults.e2e-spec.ts`、`audit-sos-realtime.e2e-spec.ts`、`audit-auth-account.e2e-spec.ts`、`audit-auth-authz.e2e-spec.ts`、`audit-auth-binding.e2e-spec.ts`、`audit-auth-extra.e2e-spec.ts`、`audit-auth-ratelimit.e2e-spec.ts`、`audit-ingest-entries.e2e-spec.ts`、`audit-realtime.e2e-spec.ts`、`audit-commands.e2e-spec.ts`、`audit-mqtt-hook.e2e-spec.ts`、`audit-admin.e2e-spec.ts`、`audit-dbops.e2e-spec.ts`、`audit-contract.e2e-spec.ts`、`audit-voice.e2e-spec.ts`、`audit-voice-defects.e2e-spec.ts`、`audit-media.e2e-spec.ts`、`audit-media-defects.e2e-spec.ts`；helper：`helpers/audit-{sos,auth,ingest,admin,voice}.ts`

**App（`app/src/`）**：`services/__tests__/audit-ble-uplink.test.ts`、`audit-ble-defects.test.ts`、`audit-ble-command.test.ts`、`api/__tests__/audit-auth-client.test.ts`、`audit-error-messages.test.ts`、`i18n/__tests__/audit-i18n-parity.test.ts`、`components/map/__tests__/audit-nav-links.test.ts`

**可复跑脚本（`docs/testing/2026-09-13/evidence/`）**：
- `run-audit-suite.sh <db-suffix> <file…>` —— 统一跑任一后端审计套件
- `baseline/e2e-cov.sh` + `jest-e2e-cov.json` —— 既有 e2e 全源码覆盖率
- `sos/scripts/` —— 真实进程重启接管
- `ingest/scripts/relay-audit.sh` —— 真实后端 + Mock 中转剧本（fall/sos/risk/ski/断网补传/命令三态）
- `mqtt/scripts/` —— 真实 EMQX 认证/ACL 矩阵、启停后端
- `dbops/scripts/` —— 升级路径、约束、灌数、EXPLAIN、分页稳定性、负载、可恢复性（41/42）
- `admin/scripts/` —— 起后端+Vite、造数据、Playwright 浏览器验收（02/03/04）

启动与清理：全部脚本只使用本轮隔离资源（PostgreSQL 容器 `helmet-audit-0913-pg` 端口 55432、EMQX 容器 `helmet-audit-0913-emqx` 端口 51883、后端端口 3010/3100/3300/3400/3500/3501/3502/3503、Vite 5173）。清理：`docker rm -f helmet-audit-0913-pg helmet-audit-0913-emqx`（无卷）。Playwright 装在 scratchpad 而非仓库。

## 7. 明确未覆盖（证据边界）

1. **真机双端全部功能** —— 无 Android/iPhone 真机，无可用模拟器会话（Expo Dev Build 需原生构建）。`DEVICE_CHECKLIST.md` 12 大节全部未测。
2. **真实第三方** —— 短信（腾讯云签名/模板未过审）、推送（极光/APNs 未申请）、对象存储（COS 未开通）、TRTC 真实进房。Mock Provider 成功 **≠** 联系人真实收到。
3. **真实头盔硬件** —— BLE GATT 全链路、Wi-Fi SoftAP、RTSP 视频流。
4. **云端 development/production 环境** —— 规则禁止连接；Caddy 对不可信 `X-Forwarded-For` 的实际处理（关系到 AUTH-07 的缓解是否成立）未验证。
5. **App 页面级交互** —— 每页 loading/空/错误/权限/断网/连点/返回等状态只做了源码审计，无运行时验证。
6. **长时稳定性** —— 最长连续负载 60 秒；无小时级浸泡测试。
7. **多实例/横向扩展** —— 限频与 WS 连接表均为单实例内存态，未测多实例行为（MVP 架构即单实例）。
8. **无障碍与键盘操作** —— Admin 与 App 均未测。
