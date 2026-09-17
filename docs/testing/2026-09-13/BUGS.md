# BUGS.md — 全面测试轮次缺陷清单（2026-09-13 / 14）

> HEAD `2295eef`（main，无已跟踪改动）。严重度：P0 上线阻断 ｜ P1 上线前必修 ｜ P2 上线前应修 ｜ P3 记录在案。
> 状态：**CONFIRMED**=已复现（有失败测试或日志）｜ **SUSPECTED**=静态怀疑未复现 ｜ **BY_DESIGN**=文档明确允许。
> 证据来源分级：static（静态审计）/ unit / integration（进程内 e2e）/ real-process（真实 dist 进程）/ simulator / device（真机）/ real-third-party（真实第三方）。
> **本轮无 P0。** 全部「缺陷断言」测试已提交在 `backend/test/audit-*.e2e-spec.ts` 与 `app/src/**/__tests__/audit-*.test.ts`，**修复前会失败，这是刻意保留的证据**（审计规则：不删不跳过失败测试）。


> **修复状态（2026-09-15）**：已修复并复验的 ID 见同目录 `FIXES.md`。**仍开放**（SOS-03 已按决策 #40 修复、ADMIN-04 已按「记录保留」口径修复；**APP-02 与新补录的 SOS-09 已于 2026-09-17 修复**）；SOS-06/07、AUTH-04/07/11、MQTT-03、APP-04、DBOPS-07/08、部分 CONTRACT 文档差异、HYG/ENV/TEST/COV 项。

## 索引

| ID | 严重度 | 状态 | 一句话 |
|---|---|---|---|
| SOS-01 | P1 | CONFIRMED | 位置快照回落查询抛错 → 摔倒事件不建 SOS 单 |
| SOS-02 | P1 | CONFIRMED | raw 已落库后建单失败 → 永久漏单，重放/重启都不恢复 |
| SOS-05 | P1 | CONFIRMED | 单条通知 Provider 挂起 → 占住整个扫描任务，别人的 SOS 不终态化 |
| MQTT-02 | P1 | CONFIRMED | clientId 顶替后消费者「假订阅」→ 4G 链路静默失聪至重启 |
| AUTH-02 | P2 | CONFIRMED | 改密缺字节校验 → 超长密码被 bcrypt 静默截断 |
| AUTH-03 | P2 | CONFIRMED | 注册/换号唯一约束竞态 → 500 而非 409 |
| AUTH-08 | P2 | CONFIRMED | 限频桶满即清空 → 单 IP 可重置全站限频 |
| AUTH-09 | P2 | CONFIRMED | App 刷新与登出/换号交错 → 会话复活 / 覆盖新账号 |
| INGEST-01 | P2 | CONFIRMED | 未知 schemaVersion 照常进业务流程 |
| INGEST-03 | P2 | CONFIRMED | MQTT 原始 NUL 字节消息留档失败并被丢弃 |
| MQTT-01 | P2 | CONFIRMED | EMQX 认证忽略 clientId → 可顶替后端消费者会话 |
| SOS-03 | P2 | CONFIRMED | 换绑后新主求救被并入旧主的单、通知旧主联系人 |
| SOS-04 | P2 | CONFIRMED | 通知全失败/零联系人时仍宣称「紧急联系人已收到通知」 |
| ADMIN-01 | P2 | CONFIRMED | 后台五个页面把接口 500 渲染成「暂无数据」、概览显示全 0 |
| APP-01 | P2 | CONFIRMED | 切换账号不清 React Query 缓存（staleTime 10s 内直接展示前一账号数据） |
| APP-02 | P2 | SUSPECTED | 五个 spike-* 页仍注册为生产路由，spike-rtc 读客户端 TRTC SecretKey |
| VOICE-02 | P2 | CONFIRMED | 注销账号不退出对讲频道：幽灵成员长期占名额 |
| BLE-04 | P2 | CONFIRMED | 中转队列溢出丢最旧 → 高危事件（possible_fall）可被周期事件挤掉 |
| BLE-05 | P2 | CONFIRMED | 某设备 404 时队头阻塞并无限重试，其余设备事件送不出 |
| BLE-06 | P2 | CONFIRMED | 中转队列与持久化文件不按用户隔离，账号切换后用 B 的会话补传 A 的事件 |
| ADMIN-02 | P3 | CONFIRMED | 后台搜索把 `%`/`_` 当 LIKE 通配符 |
| ADMIN-03 | P3 | CONFIRMED | 后端不可达被显示为「用户名或密码错误」 |
| ADMIN-04 | P3 | CONFIRMED | 已注销用户仍列在用户列表并计入 userTotal |
| APP-03 | P3 | CONFIRMED | App 请求无超时，后端挂起时页面永久 loading |
| APP-04 | P3 | CONFIRMED | 9 个后端错误码无 App 文案（回落「未知错误（CODE）」） |
| DBOPS-01 | P3 | CONFIRMED | 轨迹分页排序无唯一次序键，同时间戳点页序不稳定 |
| DBOPS-05 | P3 | CONFIRMED | /health 503 响应体与 API.md §1.2 不符 |
| DBOPS-06 | P3 | CONFIRMED | 两套 JWT 密钥误配同值时无运行时校验（admin token 可过用户守卫） |
| DBOPS-07 | P3 | CONFIRMED | SIGTERM 后立即停止接受连接，无排空期 |
| DBOPS-08 | P3 | CONFIRMED | 生产镜像含开发依赖；33 个依赖漏洞（含后端运行时 multer/qs/fast-uri/js-yaml） |
| VOICE-01 | P3 | CONFIRMED | 同一人并发加入满员频道得 409，与「重复加入幂等」契约不符 |
| MEDIA-01 | P3 | CONFIRMED | 他人设备可让自己的媒体条目出现在受害者事件详情（仅元数据） |
| MQTT-03 | P3 | SUSPECTED | 内部 EMQX 回调端点经公网网关可达 |
| BLE-03 | P3 | CONFIRMED | 多设备中转不公平：队头设备积压使另一台的 possible_fall 延迟 ~15s |
| BLE-07 | P3 | CONFIRMED | start→stop→start 重入导致持久化队列重复恢复 |
| BLE-08 | P3 | CONFIRMED | 队列文件内容为 `null` 时产生未处理的 Promise rejection |
| AUTH-01/04/05/06/07/10/11 | P3 | CONFIRMED | 见下文逐条 |
| SOS-06/07/08 | P3 | CONFIRMED/BY_DESIGN | 见下文逐条 |
| SOS-09 | P2 | CONFIRMED | 通知投递顺序不确定 → 本人 Push 可能抢在短信前发出，误报「短信全部失败」（2026-09-17 补录，已修） |
| INGEST-02/04 | P3 | CONFIRMED | 见下文逐条 |
| CONTRACT-01…15 | P3 | 混合 | Contract 一致性差异，见 `evidence/contract/diff-table.md` |
| HYG-01/02、ENV-01/02、TEST-01、COV-01/02 | P3 | CONFIRMED | 仓库卫生与测试基建，见 `evidence/baseline/main-agent-findings.md` |

---

## 一、后端主链路（SOS / 认证 / 接入 / MQTT）

### MQTT-02 · P1 · CONFIRMED — clientId 会话顶替后 MQTT 消费者「假重订阅」→ 全链路静默失聪，直到进程重启

| 项 | 内容 |
|---|---|
| 严重度理由 | 后端消费者被顶替踢线后自动重连并打印「已订阅」，但 EMQX 侧 subscriptions_cnt=0，此后所有设备事件(含 possible_fall/manual_sos 保命事件)在 MQTT 链路上被静默丢弃，无任何错误日志、无告警、不自愈。MVP 唯一真机链路为 BLE(决策#35)、MQTT 由 Mock 驱动，故对当前 MVP 定为 P1；一旦硬件扩展 4G(链路形态注明保留 4G 代码)即为 P0。EMQX 重启这类正常重连能正确重订阅，唯独 clientId 顶替路径不能恢复。 |
| 证据来源 | real-process |
| 影响范围 | 任一持有合法设备密钥者(或任何被顶替事件)使后端消费者进入 connected 但 0 订阅的「聋」态：device_status/location/possible_fall/manual_sos/collision_risk/cmd_ack 全部收不到，SOS 状态机在 4G 链路上不再建单，且无告警提示运维。 |
| 前置条件 | 后端 MQTT 消费者以固定 clientId(默认 backend_ingest / 本次 backend-audit-0913)、clean:false 连接;发生一次同 clientId 的 clean:true 顶替(见 MQTT-01)。 |
| 最小复现 | 1) 后端 dist/main 连真实 EMQX，确认 EMQX API /clients/<clientId> subscriptions_cnt=4、探针 location 入库(raw_events=1)。2) 用合法设备凭证 + clientId=后端 clientId + clean:true 连接 EMQX 2s 后断开(scripts/../takeover.mjs)。3) 等后端自动重连(日志打印「已连接」「已订阅」成功、无 error)。4) 再查 EMQX /clients/<clientId> → subscriptions_cnt=0;再发 location QoS1 → PUBACK 却 raw_events=0、后端无「→ stored」日志。5) 重启后端 → subscriptions_cnt=4、入库恢复。 |
| 预期 | 会话被顶替/丢失后，消费者重连必须真正恢复订阅并继续入库(或在无法恢复时告警并退出让守护进程重启);「已订阅」日志须与 Broker 实际订阅一致。 |
| 实际 | 重连后 mqtt.js 的 subscribe 回调返回成功(SUBACK 视为已订阅)，但 Broker 实际 0 订阅;消费者永久收不到消息，无错误、无告警，仅进程重启可恢复。 |
| 源码位置 | backend/src/ingest/mqtt-consumer.service.ts:120 (subscribeWithRetry 只在 SUBACK error 时重试，不校验订阅是否真正生效;connect 回调重订阅在顶替恢复场景下被 mqtt.js 内部订阅缓存吞掉) |
| 复现频率 | always (每次 clientId clean:true 顶替后必现;正常 EMQX 重启重连不受影响) |
| 证据文件 | docs/testing/2026-09-13/evidence/mqtt/auth-acl-matrix.log、docs/testing/2026-09-13/evidence/mqtt/probe-all.log、docs/testing/2026-09-13/evidence/mqtt/backend-run3.log、docs/testing/2026-09-13/evidence/mqtt/backend-run5.log |
| 建议修法 | ① 消费者监听 connack 的 sessionPresent，为 false(会话被清)时强制清缓存重订阅;或订阅后用 EMQX API/独立回环发布探针校验订阅确实生效，失败则退出让编排重启。② 更根本:堵住顶替(见 MQTT-01)。③ 增加「连续 N 秒无任何入站消息」健康探针告警，避免静默失聪不被发现。 |
| 回归范围 | MQTT 4G 上行全链路(status/location/event/cmd_ack)、SOS 4G 建单、命令 cmd_ack 回执。BLE app-relay 链路不受影响。 |
| 旧报告关联 | 无(2026-09-10 报告未测试 clientId 顶替场景) |

### SOS-01 · P1 · CONFIRMED — 位置快照回落查询（location_points）抛错时，possible_fall/manual_sos 不建 SOS 单

| 项 | 内容 |
|---|---|
| 严重度理由 | 保命链路：一次副表查询瞬断即丢单，raw 留档但无自动恢复；违反决策 #26 ③「都无则空快照照建单」的精神（快照缺失不能阻塞建单） |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 设备/中转上报的摔倒事件在服务端被吞：无倒计时、无通知、App 显示 accepted=1 不再补传，用户和联系人均不知情 |
| 前置条件 | 触发事件 payload 无合法 location（走 last_point 回落）且 locationPoint.findFirst 抛错一次（连接瞬断/超时/锁） |
| 最小复现 | backend/test/audit-sos-faults.e2e-spec.ts 用例 ②：failOnce(prisma.locationPoint,'findFirst') → relay possible_fall → 202 accepted=1 → sos_cases 无该 triggerEventId |
| 预期 | 建单成功，latitude/longitude/locationSource 为空（空快照） |
| 实际 | createOrMerge 在 resolveSnapshot 处抛错，handleTrigger 只记 ERROR 日志；无单、无 Push、无 WS |
| 源码位置 | backend/src/sos/sos-trigger.service.ts:100 (resolveSnapshot 调用在 create 的 try 之外) / :184 (findFirst) |
| 复现频率 | 确定性（注入即复现）；生产概率取决于 DB 抖动 |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/audit-sos-faults.log、docs/testing/2026-09-13/evidence/sos/final-run-sos-suites.log |
| 建议修法 | resolveSnapshot 内部 try/catch：查询失败 logger.warn 后返回 null，让建单继续（与 Push 失败不影响状态机同哲学）；单测补「快照查询抛错仍建单」 |
| 回归范围 | sos-trigger 单测、audit-sos-faults ②、sos.e2e 位置快照用例 |
| 旧报告关联 | 无（新发现） |

### SOS-02 · P1 · CONFIRMED — raw_events 已落库后 sos_cases.create 失败：入口仍 202 accepted，同 eventId 重放 duplicate，扫描/重启都无法恢复——永久漏单

| 项 | 内容 |
|---|---|
| 严重度理由 | 原始事件已到服务器却不进保命状态机；App 收到 accepted=1 不会重传；代码注释承诺的「raw 可人工回放」在代码中不存在回放路径 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 决策 #8「App 被杀/断网/后端重启都不能丢 SOS」在「事件已到服务器」这一侧被打破：DB 瞬断/进程在 dispatch 阶段崩溃时摔倒事件静默丢失 |
| 前置条件 | persist(raw) 成功后、sosCase.create 前/中出错（DB 错误、进程被杀） |
| 最小复现 | backend/test/audit-sos-faults.e2e-spec.ts 用例 ①：failOnce(prisma.sosCase,'create') → relay → {accepted:1}；再次 relay 同 envelope → {duplicate:1}；scheduler.tick() 后 sos_cases 仍为 0 |
| 预期 | 原始事件已在服务器，保命链路应能恢复：重放同 eventId 应补建单，或扫描/启动对账自动补建 |
| 实际 | 幂等挡在 raw 层（ingest.service.ts:126-129 只有 stored 才 dispatch），dispatch 失败被吞（sos-trigger.service.ts:77-83），无任何自动恢复；grep 全仓无回放工具 |
| 源码位置 | backend/src/ingest/ingest.service.ts:126-129,151-154；backend/src/sos/sos-trigger.service.ts:77-83；backend/src/ingest/app-relay.controller.ts:70 |
| 复现频率 | 确定性（注入即复现） |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/audit-sos-faults.log、docs/testing/2026-09-13/evidence/sos/final-run-sos-suites.log |
| 建议修法 | 最小改动：SosScheduler.tick 增加一条对账查询——raw_events 中 eventType in (possible_fall, manual_sos) 且 received_at 在最近 N 分钟、无对应 sos_cases.trigger_event_id、设备当时有绑定（device_bindings 区间）→ 重新调用 handleTrigger；同时 handleTrigger 失败时对 app-relay 返回可重试语义（或把 raw 落库与 SOS 建单放同一事务）。补 e2e：建单失败后 tick 自动补建 |
| 回归范围 | ingest 幂等用例、app-relay e2e、audit-sos-faults ①、决策 #26 合并规则用例 |
| 旧报告关联 | 无（旧报告仅验了 Push 抛错不影响建单） |

### SOS-05 · P1 · CONFIRMED — 单条通知的 Provider 调用挂起（无超时）会占住整个扫描任务：其他用户到期的 SOS 得不到终态化/通知

| 项 | 内容 |
|---|---|
| 严重度理由 | 一个慢/挂起的第三方调用让全站保命链路停摆；tick 串行 + running 互斥 + send 无超时三者叠加；MVP 单实例无其他扫描者兜底 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | victim 设备的 possible_fall 越过 deadline 数秒且 5 轮 tick 后仍 pending（tick 全部因 running=true 直接返回）；直到挂起释放才恢复 |
| 前置条件 | 任一 sms/push Provider 调用不返回（网络黑洞、SDK 无超时） |
| 最小复现 | backend/test/audit-sos-faults.e2e-spec.ts 用例 ④：sms.send 返回永不 resolve 的 Promise → 到期 tick 卡住 → 另一设备到期 → 5 次 tick 均跳过 → victim.status 仍 pending |
| 预期 | 一条通知慢/挂起不应阻塞其他 SOS 的到期终态化；超时后记 failed 由重试兜底 |
| 实际 | deliverPending 顺序 await this.send(...)，无超时；scheduler.tick 先 finalize 再 deliver 且整轮受 running 互斥 |
| 源码位置 | backend/src/sos/sos-notifier.service.ts:118（await send 无超时）；backend/src/sos/sos-scheduler.service.ts:48-61 |
| 复现频率 | 确定性（注入即复现） |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/audit-sos-faults.log、docs/testing/2026-09-13/evidence/sos/final-run-sos-suites.log |
| 建议修法 | ① send 外包 Promise.race 超时（如 10s，超时按 failed 记 lastError='timeout' 走既有重试）；② tick 拆成两个独立 running 标志：到期终态化（快、只写库）与通知投递互不阻塞；③ TencentSmsProvider/未来 Push SDK 显式配置超时 |
| 回归范围 | 扫描/通知全部用例、真实进程重启脚本、realtime 60s 用例 |
| 旧报告关联 | 无 |

### AUTH-02 · P2 · CONFIRMED — change-password 的 newPassword 缺 @MaxBytes：216 字节新密码被接受并静默截断为前 72 字节

| 项 | 内容 |
|---|---|
| 严重度理由 | 用户设置的密码与实际生效密码不一致（后 144 字节不参与），用户不知情；契约明确「newPassword 与注册同规则」 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 改密为 72 个汉字后，用「前 24 汉字 + 40 个 x」即可登录（实测 200） |
| 前置条件 | 已登录用户 |
| 最小复现 | backend/test/audit-auth-account.e2e-spec.ts「修改密码：newPassword 72 个汉字…」 |
| 预期 | 400 VALIDATION_FAILED（与 register/reset 同规则） |
| 实际 | 204，随后前缀登录 200 |
| 源码位置 | backend/src/auth/auth.dto.ts:91-97 |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/account.log、docs/testing/2026-09-13/evidence/auth/jest-audit-auth-account.txt |
| 建议修法 | ChangePasswordDto.newPassword 加 @MaxBytes(MAX_PASSWORD_BYTES)（一行）；oldPassword 同步加 @MaxBytes 保持对称 |
| 回归范围 | audit-auth-account 密码边界；auth.service.spec 单测补 change-password 字节用例 |
| 旧报告关联 | #11（修复遗漏 change-password，2026-09-11 新增接口） |

### AUTH-03 · P2 · CONFIRMED — change-phone / register「先查后写」撞 users.phone 唯一约束 → Prisma P2002 未捕获 → 500 INTERNAL_ERROR（契约 409）

| 项 | 内容 |
|---|---|
| 严重度理由 | 用户可见 5xx，且日志打印完整 Prisma 调用栈；窗口只在并发换号/注册同号时出现，不丢数据 |
| 证据来源 | integration(e2e in-process，jest.spyOn 注入竞态) |
| 影响范围 | 两个用户同时把同一新号用于「换绑」与「注册」（各自持独立用途的验证码，都能通过前置查重），后写者 500；验证码已被消费，用户需重新发码 |
| 前置条件 | 同一新号并发提交 change-phone 与 register（或两个 register） |
| 最小复现 | audit-auth-account「换手机号：…并发换号+注册同号不得 5xx」；audit-auth-extra「【AUTH-03 缺陷断言】注册 vs 换号同号竞态」 |
| 预期 | 409 PHONE_ALREADY_REGISTERED |
| 实际 | 500 INTERNAL_ERROR（Unique constraint failed on the fields: (`phone`)） |
| 源码位置 | backend/src/auth/auth.service.ts:90（register user.create）、:210（changePhone user.update） |
| 复现频率 | 注入下 100%；自然并发为窄窗口 |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/account.log、docs/testing/2026-09-13/evidence/auth/extra.log、docs/testing/2026-09-13/evidence/auth/jest-audit-auth-account.txt |
| 建议修法 | 两处 create/update 包 try/catch，捕获 PrismaClientKnownRequestError code==='P2002' 转 ConflictException PHONE_ALREADY_REGISTERED；或先 verifyAndConsume 再在同一事务内 updateMany/create 并判 count |
| 回归范围 | audit-auth-account / audit-auth-extra 竞态用例 |
| 旧报告关联 | 新增（2026-09-11 账号接口） |

### AUTH-08 · P2 · CONFIRMED — 限频桶 >50,000 即整表清空 + 被拒请求仍新建桶：单 IP 用 5 万个不同手机号的被拒登录可清空全站限频、同一分钟内重置自己的 login_ip 额度

| 项 | 内容 |
|---|---|
| 严重度理由 | 撞库者可用 ~5 万条垃圾请求（单机数十秒）换取再 100 次真实尝试并解除其他 IP/号码的 429；发码面同理（sms_min/sms_day 桶一并清空）。可用性无损，但限频形同可绕 |
| 证据来源 | unit（真实 RateLimitGuard 类 + 注入 Reflector/ExecutionContext） |
| 影响范围 | 实测：受害 IP 已 429 → 攻击者 50,200 次（放行 200 / 拒绝 50,000，桶数 203）→ 受害者立即 200、攻击者再获 100 次；另：per_ip 拒绝的请求仍在 per_phone 规则建桶并计 1 次（规则顺序副作用） |
| 前置条件 | 单实例内存限频；攻击者可发大量不同 phone 的公开接口请求 |
| 最小复现 | audit-auth-ratelimit「【AUTH-08 缺陷断言】桶容量 50,000 满即整表清空」 |
| 预期 | 同 IP 100 次/分、同 IP+号 10 次/分在同一分钟内不因他人流量重置 |
| 实际 | 清表后受害者 200、攻击者累计放行 200 |
| 源码位置 | backend/src/common/rate-limit.guard.ts:28、:76、:83-84 |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/ratelimit.log、docs/testing/2026-09-13/evidence/auth/jest-audit-auth-ratelimit.txt |
| 建议修法 | ① 超容量时不 clear()，改为淘汰最久未命中的桶（按 hits 末值排序删 10%）或直接 429 新 key；② 规则全部判定通过后再统一 push（被拒请求不建桶不计数）；③ ip+phone 规则的 phone 先做 /^1[3-9]\d{9}$/ 粗校验，不合法退化为 ip 桶，避免任意字符串造键 |
| 回归范围 | audit-auth-ratelimit guard 单元用例 + 各路由限额用例 |
| 旧报告关联 | #4（2026-09-10 修复引入） |

### AUTH-09 · P2 · CONFIRMED — App api 客户端：401 刷新进行中用户登出/另一账号登录，刷新返回后 setTokens 把旧账号新 token 写回（会话复活 / 覆盖新账号）

| 项 | 内容 |
|---|---|
| 严重度理由 | 登出后账号自动复活并持久化到 SecureStore（下次启动仍是旧账号）；换账号时旧账号 token 覆盖新账号→后续请求以错误身份发出。触发需 401 与登出/换号在同一 ~秒级窗口，但 15 分钟 access 过期是高频事件 |
| 证据来源 | unit（App jest-expo，fetch mock） |
| 影响范围 | refreshTokens() 未校验「当前会话仍是发起刷新时的那一份」，且 signOut 只作废旧 refresh（服务端已轮换为新 token，登出无效） |
| 前置条件 | 任一请求 401 → 刷新在途 → 用户点登出或切换账号 |
| 最小复现 | app/src/api/__tests__/audit-auth-client.test.ts 两条【AUTH-09 缺陷断言】 |
| 预期 | 登出后 tokens 保持 null；换账号后 tokens 仍为新账号 |
| 实际 | setTokens 被调用 1 次；tokens.refreshToken=旧账号刷新结果 |
| 源码位置 | app/src/api/client.ts:38-49；app/src/stores/auth-store.ts:78-94 |
| 复现频率 | 100%（单测） |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/jest-app-audit-auth-client.txt |
| 建议修法 | refreshTokens 记录发起时的 refreshToken，settle 后仅当 session.getTokens()?.refreshToken 仍等于它才 setTokens，否则丢弃并对新 token 调 /auth/logout；signOut 前 await 在途 refreshing |
| 回归范围 | App api client 单测；双端真机：请求 401 瞬间登出 → 重启 App 应停在登录页 |
| 旧报告关联 | 无（App 侧未覆盖） |

### INGEST-01 · P2 · CONFIRMED — 未知 schemaVersion（如 999）不被拦截，照常进入业务流程（建 SOS、刷快照、入轨迹表）

| 项 | 内容 |
|---|---|
| 严重度理由 | 当前无 v2 事件所以不出错，但 Contract 明文要求未知版本只留档告警不进业务；一旦硬件/算法升版本改字段语义，旧后端会用错误语义处理事件（保命链路上可能建错单或漏建单）。上一轮 contract 代理已静态发现，本轮复现。 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 版本演进时的静默错误处理；与 EVENTS.md §1 / DECISIONS #18 兼容原则不符 |
| 前置条件 | 设备已绑定；任意入口 |
| 最小复现 | backend/test/audit-ingest-entries.e2e-spec.ts 用例「【INGEST-01 缺陷断言】schemaVersion=999」：app-relay 提交 schemaVersion=999 的 possible_fall / device_status / location_update 各一条 |
| 预期 | 三条进 raw_events（可带告警），sos_cases 不建单、devices.battery 不变、location_points 不入 |
| 实际 | sosCreated=1、batteryChanged=true、pointRecorded=true（raw 亦入库） |
| 源码位置 | backend/src/ingest/envelope.ts:83-88（只校验整数与 int32 范围）；backend/src/ingest/ingest.service.ts:100-112（persist 后无版本门禁直接 dispatchStored） |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| 建议修法 | envelope.ts 增加 `SUPPORTED_SCHEMA_VERSIONS = new Set([1])`：不在集合内 → 按 `schema_version_unsupported` 走 buildInvalidRecord 留档并 warn（或保留原 eventType 入 raw 但在 ingestRaw 返回 'stored_invalid' 跳过 dispatchStored）；packages/shared 的 CURRENT_SCHEMA_VERSION 同步引用。 |
| 回归范围 | 三入口 + Mock（Mock 固定发 1 不受影响）；app-relay 响应 invalid 计数会变 |
| 旧报告关联 | —（上一轮 contract 代理静态发现） |

### INGEST-03 · P2 · CONFIRMED — MQTT 路径原始 NUL 字节（0x00）消息：invalid_json 留档本身被 PostgreSQL 拒绝（22P05），重试 3 次后消息被放弃，未留档

| 项 | 内容 |
|---|---|
| 严重度理由 | 违反 CLAUDE.md Event Rules「校验失败的事件必须留档不丢弃」；固件用 C 字符串带尾随 0x00 是常见情况，一旦出现该设备所有此类消息全部丢失且每条拖慢消费者 600ms（2×300ms 退避）。当前 MVP 无 4G 故只影响未来 4G/Mock MQTT 链路，定为 P2。 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 消息丢失、无 _invalid 留档、消费者被无谓重试拖慢；app-relay/webhook 侧同样字节会被 body-parser 400 拒绝（不受影响） |
| 前置条件 | MQTT 消费路径（processPublish） |
| 最小复现 | audit-ingest-entries 用例「【INGEST-03 缺陷断言】」：processPublish('helmet/{id}/event', '{"eventId":"m\x00"}') 与 合法 JSON + 尾随 0x00 |
| 预期 | resolve；raw_events 留 `_invalid` reason=invalid_json |
| 实际 | reject：PrismaClientKnownRequestError 22P05 `unsupported Unicode escape sequence`（来自 buildInvalidRecord 的 payload.raw 含 0x00）；MqttConsumer 重试耗尽后 error 日志并放弃 |
| 源码位置 | backend/src/ingest/envelope.ts:53（hasNul 只匹配转义 \\u0000 不匹配原始字节）；backend/src/ingest/envelope.ts:35（raw.slice 直接入 jsonb）；backend/src/ingest/ingest.service.ts:86-90（invalid 留档无二次防护） |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log |
| 建议修法 | buildInvalidRecord 里对 raw 做 `raw.replace(/\u0000/g, '\\u0000')`（或 Buffer 转义为可打印形式）再 slice；hasNul 同时匹配原始 `\u0000` 字符（`/\\u0000\|\u0000/`）。 |
| 回归范围 | 三入口的 _invalid 留档路径；现有 hardening-ingest NUL 用例 |
| 旧报告关联 | 旧报告 #1 的 NUL 修复只覆盖转义形式 |

### MQTT-01 · P2 · CONFIRMED — EMQX 认证回调忽略 clientId，可用后端消费者的固定 clientId 顶替其会话(DoS 触发器)

| 项 | 内容 |
|---|---|
| 严重度理由 | authenticate 回调只校验 username(deviceId)+password(deviceSecret)，完全不看 clientId，也不校验 clientId==deviceId。后端消费者用固定且可猜 clientId(默认 backend_ingest)。任一合法设备(username=自己、密钥正确、clientId=后端 id)即可连接并按 MQTT clientId 唯一性把后端消费者踢线。单独看只是可被踢线(会自动重连)，但叠加 MQTT-02 即造成永久静默失聪。需持有一份合法设备密钥方可利用，故定 P2。 |
| 证据来源 | real-process |
| 影响范围 | 任一合法设备密钥 → 反复顶替后端消费者;叠加 MQTT-02 → 整个 4G/MQTT 事件入口静默瘫痪。也说明 clientId 未与 deviceId 绑定，设备可任意伪造 clientId(AUTH-5 已连成功)。 |
| 前置条件 | 拥有任一有效 deviceId+deviceSecret;已知/猜中后端消费者 clientId。 |
| 最小复现 | 真实 EMQX:tryConnect({clientId: BACKEND_CLIENT_ID, username: 合法设备, password: 合法密钥, clean:true}) → 连接成功(AUTH-9)，同时后端消费者被踢线;进程内:POST /api/v1/internal/emqx/authenticate {clientid: 后端id, username: 设备, password: 正确密钥} → {result:'allow'}(audit-mqtt-hook.e2e 中 MQTT-01 断言失败)。 |
| 预期 | 设备连接应校验 clientId == username(deviceId);使用后端保留 clientId 或与设备名不符的 clientId 一律拒绝(deny)。 |
| 实际 | clientId 完全不参与判定，任意 clientId(含后端消费者 id)只要设备密钥正确即 allow。 |
| 源码位置 | backend/src/emqx/emqx-hook.controller.ts:29 与 emqx-hook.service.ts:37 (authenticate 未接收/校验 clientid) |
| 复现频率 | always |
| 证据文件 | docs/testing/2026-09-13/evidence/mqtt/auth-acl-matrix.log、docs/testing/2026-09-13/evidence/mqtt/internal-hook-token.log、docs/testing/2026-09-13/evidence/mqtt/audit-mqtt-hook.log |
| 建议修法 | authenticate 回调接收 clientid 并校验:设备连接要求 clientid===username;后端服务账号要求 clientid===MQTT_BACKEND_CLIENT_ID(或专用保留前缀)，其它一律 deny。EMQX authn body 增加 clientid 传参(emqx.conf 已传 ${clientid})。文档 DEVICE_PROTOCOL §3 增补 clientId 绑定规则。 |
| 回归范围 | 所有 MQTT 连接鉴权;间接影响 4G 上行全链路可用性。 |
| 旧报告关联 | 无(2026-09-10 报告 AUTH 项未含 clientId 绑定/顶替) |

### SOS-03 · P2 · CONFIRMED — 换绑后旧主 SOS 仍 pending 时，新主头盔的 possible_fall 被并入旧主的单、manual_sos 升级旧主的单并通知旧主联系人；新主 active 为 null 且无法处置

| 项 | 内容 |
|---|---|
| 严重度理由 | 前置条件苛刻（60s 倒计时内完成解绑+新绑），但一旦发生：新主按实体键求救 → 通知的是前主联系人、新主无单可见可取消；EVENTS.md §4.4 字面为「该设备已有 pending」按设备合并，故最终定性需负责人裁定（可能改为 BY_DESIGN 并补文档） |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 归属错位：与 API.md §7「处置权限以建单时固化的绑定用户为准」和决策 #39「按绑定区间归属」的方向冲突；新主的求救被吞 |
| 前置条件 | 设备 A 在 owner 名下 pending SOS；owner 解绑、other 绑定同一设备；other 经 app-relay 上报 possible_fall / manual_sos |
| 最小复现 | backend/test/audit-sos.e2e-spec.ts 两个【SOS-03 缺陷断言】用例 |
| 预期 | 新主事件为新主建单（或至少不把旧主单升级、不通知旧主联系人） |
| 实际 | createOrMerge 只按 deviceId+pending 找活动单（不看 userId）：新主 possible_fall 只留档；新主 manual_sos → finalizeNotified(旧主单) → 旧主联系人收到短信；GET sos/active(other) 为 null |
| 源码位置 | backend/src/sos/sos-trigger.service.ts:93,145（findFirst 只按 deviceId）/ :158-166（applyMergeRule） |
| 复现频率 | 确定性（前置条件满足即复现） |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/audit-sos.log、docs/testing/2026-09-13/evidence/sos/final-run-sos-suites.log |
| 建议修法 | createOrMerge 中若 active.userId !== 当前 bindUserId：不套合并规则——把旧主 pending 单立即终态化（安全侧：通知旧主联系人）或标记 cancelled(reason=rebound)，再为新主建新单；同步在 EVENTS.md §4.4 / DECISIONS #26 写明换绑场景口径；partial unique index「每设备至多一个 pending」保持 |
| 回归范围 | audit-sos 换绑两用例、hardening-sos 换绑用例、sos.e2e |
| 旧报告关联 | 旧报告 #15/决策 #39（历史数据归属）——本项为其 SOS 合并规则侧的未覆盖面 |

### SOS-04 · P2 · CONFIRMED — notified 状态、本人 Push「SOS 已通知紧急联系人」与 App 文案「紧急联系人已收到通知」在联系人短信全部失败或零联系人时依然如此宣称

| 项 | 内容 |
|---|---|
| 严重度理由 | 语义/文案缺陷不丢数据，但误导用户在最危急时刻停止自救（以为家人已知情）；Mock Provider 成功 ≠ 送达，真实运营商拒发时即发生 |
| 证据来源 | integration(e2e in-process) + static(App 文案) |
| 影响范围 | 四层语义混淆：sos.status=notified 实际只表示「通知任务行已创建」；Push/WS 文案静态；App sos-active 页把 notified 渲染为「紧急联系人已收到通知，请保持手机畅通」；零联系人用户也会看到同样文案 |
| 前置条件 | SMS Provider 对 sos_alert 全部抛错（或用户无紧急联系人） |
| 最小复现 | backend/test/audit-sos.e2e-spec.ts【SOS-04 缺陷断言】+「无联系人」用例；App 文案见 app/src/i18n/messages/auth.ts:64、app/src/app/sos-active.tsx:118 |
| 预期 | 文案区分「已发出通知任务」与「已送达」：全部失败/零联系人时提示「通知发送失败/未设置联系人，请直接拨打电话」；Push 正文按通知行结果生成 |
| 实际 | sos-notifier.send 的 push 标题正文固定为「已通知紧急联系人」；deliverPending 完成后不再推送汇总；App 只看 sos.status |
| 源码位置 | backend/src/sos/sos-notifier.service.ts:144；app/src/i18n/messages/auth.ts:64；app/src/app/sos-active.tsx:118 |
| 复现频率 | 确定性 |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/audit-sos.log、docs/testing/2026-09-13/evidence/sos/final-run-sos-suites.log |
| 建议修法 | deliverPending(sosId) 结束后按行结果生成汇总（sent/failed/无联系人）：本人 Push 与 WS sos_update 附带 notificationSummary；App 文案改为「已向 N 位紧急联系人发出通知（M 位失败）」，零联系人时引导设置/直接拨打；API.md §7 写明 notified = 已下发通知任务而非已送达 |
| 回归范围 | SOS 通知用例、WS sos_update 断言、App sos-active 页快照 |
| 旧报告关联 | 无 |

### AUTH-01 · P3 · CONFIRMED — 登录密码缺 @MaxBytes：72 汉字（216B）返回 401 而非契约 400；72B 密码 + 任意后缀可登录（bcrypt 前缀截断）

| 项 | 内容 |
|---|---|
| 严重度理由 | 不越权、不泄露；仅契约偏差 + bcrypt 截断导致「超 72 字节的后缀不参与比对」，撞库者收益极小 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | API.md §2 写明登录密码「≤72 字节，超出 400」；实际 LoginDto 只有 MaxLength(72)（按字符），无 MinLength(8)/MaxBytes。用 24 个汉字（72B）注册后，用「24 汉字 + x」（73B）或 19 个 emoji 登录 18 个 emoji 账号均 200 |
| 前置条件 | 任意账号 |
| 最小复现 | backend/test/audit-auth-account.e2e-spec.ts「登录：API.md §2 登录密码…」；audit-auth-extra「注册：18 emoji…」日志行 |
| 预期 | 72 汉字 → 400 VALIDATION_FAILED；73 字节 → 400（契约） |
| 实际 | 72 汉字 → 401；73 字节前缀匹配 → 200 |
| 源码位置 | backend/src/auth/auth.dto.ts:61-68 |
| 复现频率 | 100%（3 次运行一致） |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/account.log、docs/testing/2026-09-13/evidence/auth/extra.log、docs/testing/2026-09-13/evidence/auth/jest-audit-auth-account.txt |
| 建议修法 | LoginDto.password 加 @MinLength(8) @MaxBytes(72)（与 RegisterDto 同一装饰器）；或把契约改为「登录不校验长度」并同步 API.md |
| 回归范围 | audit-auth-account / audit-auth-extra 密码边界用例 |
| 旧报告关联 | #11（注册/找回已修，登录未修——部分复发） |

### AUTH-04 · P3 · CONFIRMED — 验证码 60s 重发间隔在并发下被穿透：同号 6 个并发 sms-code 全部 204、Provider 实际发送 6 次

| 项 | 内容 |
|---|---|
| 严重度理由 | 日限 10 条/号/用途仍生效，单号最多多烧 ≤9 条；真发短信后有小额费用与被封签名风险 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | issue() 先 findFirst 再 create，无锁；并发请求都看不到彼此的记录 |
| 前置条件 | 同号并发发码 |
| 最小复现 | audit-auth-account「并发发送同一号 ×6」 |
| 预期 | 并发下只放行 1 条，其余 429 SMS_CODE_TOO_FREQUENT |
| 实际 | {204:6}，库中 6 条，send 调用 6 次 |
| 源码位置 | backend/src/auth/sms-code.service.ts:63-97 |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/account.log |
| 建议修法 | issue() 内用 pg_advisory_xact_lock(hashtext(phone\|\|purpose)) 串行化（项目已有 advisory lock 约定），或对 (phone,purpose,created_at 分钟桶) 建唯一约束由 P2002 转 429 |
| 回归范围 | audit-auth-account 并发发码用例 |
| 旧报告关联 | 无 |

### AUTH-05 · P3 · CONFIRMED — 注销账号后已建立的 WS 连接不被踢（存活至 access exp，≤15 分钟）；改密/找回密码亦不踢（后者契约允许）

| 项 | 内容 |
|---|---|
| 严重度理由 | 注销时设备已全部解绑、pushToUser 无数据可推，实际泄露面≈0；只是连接与 byUser 映射多活 ≤15 分钟。API.md §2「WS 连接上立即 4401」的措辞更像针对新连接，已按此实测通过 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | realtime.gateway 只在 handleConnection 校验 deletedAt，无任何撤销钩子；UsersService.deleteAccount / AuthService.resetPassword 不通知网关 |
| 前置条件 | 注销前已建立 WS |
| 最小复现 | audit-auth-account「注销：…已建立的 WS 是否被踢（观察）」；audit-auth-extra「改密 / 找回密码后：已建立 WS 不被踢」 |
| 预期 | 契约字面：注销后 WS 立即 4401（新连接已满足）；改密/找回：API.md §2 只要求 refresh 撤销 → BY_DESIGN |
| 实际 | 注销后 1.5s 内未关闭；改密/找回后 1s 内未关闭；新连接 4401 正常 |
| 源码位置 | backend/src/realtime/realtime.gateway.ts:27（byUser）、backend/src/users/users.service.ts:29 |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/account.log、docs/testing/2026-09-13/evidence/auth/extra.log |
| 建议修法 | RealtimeGateway 加 closeUser(userId, code=4401)，deleteAccount 事务提交后调用；改密/找回是否踢由负责人按 §2 口径决定（建议不踢，维持 15 分钟窗口） |
| 回归范围 | audit-auth-account 注销用例 |
| 旧报告关联 | #13 相关（WS 按 exp 关闭已修） |

### AUTH-06 · P3 · CONFIRMED — battery-history 未接 BindingScope：换绑后新主能看到前主期间的电量点，且按设备 timestamp 而非 receivedAt 过滤

| 项 | 内容 |
|---|---|
| 严重度理由 | 电量曲线敏感度低于事件/轨迹，但违背决策 #39「换绑后新主看不到前主期间的数据」意图；API.md §4 battery-history 只写「仅本人设备」，未明列区间——需负责人确认是否纳入 #39 范围 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | A→B→A 场景下 A 的 24h 电量曲线含 B 期间 battery=42 的点；receivedAt 落在 B 区间但 timestamp 在当前的点也出现 |
| 前置条件 | 设备换绑且 24h 内有前主 device_status 心跳 |
| 最小复现 | audit-auth-binding「【AUTH-06 缺陷断言】battery-history 不按绑定区间过滤」 |
| 预期 | 只返回本人绑定区间内（receivedAt）的心跳点 |
| 实际 | 返回全部 device_status 心跳（按 timestamp 取窗口） |
| 源码位置 | backend/src/devices/devices.service.ts:182-190 |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/binding.log、docs/testing/2026-09-13/evidence/auth/jest-audit-auth-binding.txt |
| 建议修法 | batteryHistory 注入 BindingScopeService，where 加 AND:[scopeWhere('receivedAt', intervals)]；API.md §4 battery-history 补「按绑定区间」一句；上一轮 contract 代理同发现 |
| 回归范围 | audit-auth-binding 电量用例 |
| 旧报告关联 | #15（事件/轨迹/媒体已修，电量历史 2026-09-10 同日新增接口被遗漏） |

### AUTH-07 · P3 · CONFIRMED — main.ts trust proxy=1：后端可直连时逐条伪造 X-Forwarded-For 即可绕过全部按 IP 的限频（真实进程 8×204）

| 项 | 内容 |
|---|---|
| 严重度理由 | 生产/开发 compose 后端不映射宿主端口、只经 Caddy；Caddy 2（≥2.7）默认不信任来路 XFF 并以真实客户端 IP 覆写，故经网关不可绕过。风险仅在后端被直连或网关配置 trusted_proxies 放宽时成立；本机 npm run start 直接暴露 3000 亦可绕过（联调环境） |
| 证据来源 | real-process（node dist/main.js PORT=3160）+ integration |
| 影响范围 | helper 无 trust proxy：伪造 XFF 不能绕过（第 6 条 429）；trust proxy=1（main.ts 同配置）：逐条换 XFF ×12 全部 204 |
| 前置条件 | 攻击者能直接连到后端端口 |
| 最小复现 | docs/testing/2026-09-13/evidence/auth/real-ratelimit.sh；audit-auth-ratelimit「trust proxy=1…」 |
| 预期 | 限频按真实客户端 IP 计 |
| 实际 | 按客户端自报的 XFF 末值计 |
| 源码位置 | backend/src/main.ts:16-19；deploy/Caddyfile:10 |
| 复现频率 | 100%（直连条件下） |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/real-ratelimit.log、docs/testing/2026-09-13/evidence/auth/ratelimit.log |
| 建议修法 | 保持后端不映射端口（已如此）；DEPLOYMENT.md 明写「backend 端口绝不对外 + Caddy 不配 trusted_proxies」；可在 Caddyfile 显式 header_up X-Forwarded-For {remote_host} 消除对默认行为的依赖；开发机联调时用 RATE_LIMIT_DISABLED 而非放宽 XFF |
| 回归范围 | real-ratelimit.sh + audit-auth-ratelimit |
| 旧报告关联 | #4（限频已落地，本项为其配置面） |

### AUTH-10 · P3 · CONFIRMED — App api 客户端：刷新遇 429 / 5xx / 断网与 401 同样处理 → 清会话误登出

| 项 | 内容 |
|---|---|
| 严重度理由 | 只在 access 过期瞬间叠加网络异常时触发；后果是用户被登出需重登，不丢数据。是否属缺陷需产品确认（代码注释写「刷新失败=会话终结」） |
| 证据来源 | unit（App jest-expo） |
| 影响范围 | /auth/refresh 有 60 次/分/IP 限频（同出口 NAT 用户共享），429 会把用户登出；服务端重启窗口 5xx 同样登出 |
| 前置条件 | access 过期 + 刷新请求非 401 失败 |
| 最小复现 | audit-auth-client.test.ts「刷新遇 429 / 5xx / 网络错误」（观察项，console 输出） |
| 预期 | 仅 401 视为会话终结；其他失败抛错让请求方重试 |
| 实际 | {401,429,503,network} 全部 clearSession |
| 源码位置 | app/src/api/client.ts:47-52 |
| 复现频率 | 100%（单测） |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/jest-app-audit-auth-client.txt |
| 建议修法 | refreshTokens 返回 'ok'\|'unauthorized'\|'transient'，只有 unauthorized 才 clearSession |
| 回归范围 | App api client 单测 |
| 旧报告关联 | 无 |

### AUTH-11 · P3 · CONFIRMED — sms-code：Provider 挂起时请求随之挂起（应用层无超时，仅靠腾讯 SDK 默认 60s），挂起期间同号重发被 60s 限频

| 项 | 内容 |
|---|---|
| 严重度理由 | 只影响发码接口可用性；SDK 有 60s 兜底不至永久挂起；Console Mock 无此问题 |
| 证据来源 | integration(e2e in-process，Provider 注入挂起) |
| 影响范围 | 客户端 1.5s 超时前无响应；记录先落库导致重发 429 SMS_CODE_TOO_FREQUENT——用户既没收到码又要等 60s（与「发送失败不计限频」的设计意图冲突） |
| 前置条件 | 短信通道慢/挂起 |
| 最小复现 | audit-auth-extra「Provider 挂起」 |
| 预期 | 应用层 5–10s 超时 → 503 SMS_SEND_FAILED 并回滚记录 |
| 实际 | 挂起随 Provider；期间重发 429 |
| 源码位置 | backend/src/auth/sms-code.service.ts:97-108；backend/src/providers/tencent-sms.provider.ts:68-79 |
| 复现频率 | 100%（注入） |
| 证据文件 | docs/testing/2026-09-13/evidence/auth/extra.log |
| 建议修法 | sms.send 外包 Promise.race 超时（如 8s）按失败处理并删记录；TencentSmsProvider httpProfile 设 reqTimeout |
| 回归范围 | audit-auth-extra Provider 用例 |
| 旧报告关联 | 无 |

### INGEST-02 · P3 · CONFIRMED — webhook 收到非 JSON Content-Type（如 text/plain）请求体时返回 500 INTERNAL_ERROR 并打印堆栈

| 项 | 内容 |
|---|---|
| 严重度理由 | 需持有 X-Api-Key 才能触达；不丢数据、不影响设备链路；但违反 API.md §12「校验失败留档不报错，算法服务侧无需重试/错误分支」并制造 ERROR 日志噪音。 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 算法服务侧误配 Content-Type 会看到 500，触发其重试逻辑；ERROR 日志可被刷 |
| 前置条件 | 持有 INGEST_WEBHOOK_API_KEY |
| 最小复现 | audit-ingest-entries 用例「【INGEST-02 缺陷断言】」：POST /api/v1/ingest/webhook，Content-Type: text/plain，body `{"deviceId":"x"}` |
| 预期 | 202 { invalid: true }，raw_events 留一条 deviceId=unknown 的 _invalid |
| 实际 | 500 INTERNAL_ERROR；日志 `TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string ... Received undefined`（Express 5 未解析 body 时 req.body=undefined → JSON.stringify(undefined)=undefined → Buffer.byteLength(undefined) 抛错）。空 body + application/json 则正常 202 invalid。 |
| 源码位置 | backend/src/ingest/webhook.controller.ts:31-37；backend/src/ingest/envelope.ts:56（Buffer.byteLength(raw)） |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.final.log、docs/testing/2026-09-13/evidence/ingest/audit-ingest-entries.run3.log |
| 建议修法 | webhook.controller 里 `JSON.stringify(body) ?? 'null'`（或 body===undefined 时传 'undefined' 字面量），让 validateEnvelope 按 not_an_object 留档；顺手在 validateEnvelope 入口 `typeof raw !== 'string'` 防御。 |
| 回归范围 | 仅 webhook 入口 |
| 旧报告关联 | — |

### INGEST-04 · P3 · CONFIRMED — 注销账号（DELETE /users/me）后，已建立的 WS 连接不被关闭，继续接收该账号原绑定设备推送直到 access token 自然到期

| 项 | 内容 |
|---|---|
| 严重度理由 | 窗口 ≤15 分钟且注销时设备已解绑（解绑后新事件不会推给该 userId，故实际泄漏面很小）；但与 §11「连接不比凭证活得久」、#61「注销残留 token 全接口 401」口径不一致。 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 注销后旧 App 进程仍保持连接；若注销前后有他人重新绑定同设备，推送按 bindUserId 定向不会串到旧用户，风险主要是口径不一致 |
| 前置条件 | 用户已建 WS 连接后注销 |
| 最小复现 | backend/test/audit-realtime.e2e-spec.ts 用例「【INGEST-04 缺陷断言】」：连接 → DELETE /users/me（正确密码）→ 3s 内观察连接关闭码 |
| 预期 | 服务端以 4401 关闭；同 token 重连 4401（后者已通过） |
| 实际 | 3s 内连接仍 OPEN（still_open）；重连被正确拒绝 4401 |
| 源码位置 | backend/src/users/users.service.ts:24-44（deleteAccount 未通知网关）；backend/src/realtime/realtime.gateway.ts（无 closeUser(userId) 方法） |
| 复现频率 | 100% |
| 证据文件 | docs/testing/2026-09-13/evidence/ingest/audit-realtime.run2.log |
| 建议修法 | RealtimeGateway 增加 `closeUser(userId, code=4401, reason)` 遍历 byUser.get(userId) 关闭；UsersService.deleteAccount 事务提交后调用（也可用于 reset-password 撤销全部会话的场景）。 |
| 回归范围 | realtime.e2e / hardening-realtime / commands-relay 的连接计数用例 |
| 旧报告关联 | 旧报告 #13 部分（WS 按 exp 关闭已修，注销场景未覆盖） |

### MQTT-03 · P3 · SUSPECTED — 内部 EMQX 回调端点经公网 API 网关可达，与 DEVICE_PROTOCOL §3.1「不经网关对公网暴露」不符

| 项 | 内容 |
|---|---|
| 严重度理由 | deploy/Caddyfile 的 {$API_DOMAIN} 块把所有路径(含 /api/v1/internal/emqx/*)整体 reverse_proxy 给 backend:3000，无 /internal 排除。虽有 InternalTokenGuard(共享令牌)兜底(令牌错/缺一律 401，已实测)，但端点确实暴露公网，仅靠一个共享密钥，违反文档「只在容器网络内可达」的纵深防御口径。静态审计，未在真实网关上打点。 |
| 证据来源 | static |
| 影响范围 | 内部认证/授权判定接口对公网可达，令牌一旦泄露即可探测/滥用;不符合文档承诺的网络隔离层。 |
| 前置条件 | production 使用 deploy/Caddyfile 且 API_DOMAIN 对公网开放。 |
| 最小复现 | 读 deploy/Caddyfile:{$API_DOMAIN} { reverse_proxy backend:3000 } 无 handle /api/v1/internal/* 排除;对照 DEVICE_PROTOCOL §3.1「端点只在容器网络内可达，不经网关对公网暴露」。本地 3100 直连 /internal/emqx/authenticate 无令牌返回 401(fail-closed 生效)。 |
| 预期 | 网关层显式拒绝/404 /api/v1/internal/*(或按来源 IP 白名单),使内部端点不经公网可达。 |
| 实际 | API_DOMAIN 全量代理，/internal 随之暴露，仅共享令牌保护。 |
| 源码位置 | deploy/Caddyfile:9-11 ({$API_DOMAIN} reverse_proxy backend:3000，无 /internal 排除) |
| 复现频率 | always (部署形态) |
| 证据文件 | docs/testing/2026-09-13/evidence/mqtt/internal-hook-token.log |
| 建议修法 | 在 API_DOMAIN 块首加 `handle /api/v1/internal/* { respond 404 }` 或 `@internal path /api/v1/internal/*` + `respond @internal 404`;或用 remote_ip 白名单限容器网段。保留后端 InternalTokenGuard 作为二层防御。 |
| 回归范围 | 部署/网关配置;不影响本地与业务逻辑。 |
| 旧报告关联 | 无 |

### SOS-06 · P3 · CONFIRMED — confirm（SOS Now）在投递阶段遇 DB 错误返回 500，但服务端状态已 notified；下一轮扫描正确续投

| 项 | 内容 |
|---|---|
| 严重度理由 | 数据不丢、不重发，仅 HTTP 语义与实际状态不一致，App 需刷新 active 自愈 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | App 端可能显示「操作失败」并允许再次点 SOS Now → 得到 409，体验不一致 |
| 前置条件 | finalizeNotified 事务提交后 deliverPending 的首个 DB 查询抛错 |
| 最小复现 | backend/test/audit-sos-faults.e2e-spec.ts 用例 ③（该用例本身 PASS，观察记录） |
| 预期 | confirm 返回 200 + notified（终态化成功即成功），投递问题由扫描兜底 |
| 实际 | confirm 500；库内 notified，通知行 pending/0；tick 后 sent/1 且恰一次 |
| 源码位置 | backend/src/sos/sos.service.ts:70 → backend/src/sos/sos-notifier.service.ts:80（finalizeNotified 内联 await deliverPending） |
| 复现频率 | 确定性（注入即复现） |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/audit-sos-faults.log |
| 建议修法 | finalizeNotified 中 deliverPending 用 try/catch 包裹只记日志（终态化已提交即视为成功）；App 收到 5xx 后重新拉取 active |
| 回归范围 | confirm 用例、faults ③ |
| 旧报告关联 | 无 |

### SOS-07 · P3 · BY_DESIGN — Provider 已接收但 sent 未落库（update 抛错）→ 行记 failed → 下一轮重发：同一联系人收到重复短信（≤ SOS_NOTIFY_MAX_ATTEMPTS）

| 项 | 内容 |
|---|---|
| 严重度理由 | at-least-once 是代码明示的取舍（「宁可少发一次，不可无限重发」），有界重复对保命链路是安全侧 |
| 证据来源 | integration(e2e in-process) |
| 影响范围 | 极端情况下联系人收到 2–3 条相同短信；无服务商回执时无法做到 exactly-once |
| 前置条件 | sms.send 成功后 sosNotification.update(sent) 失败 |
| 最小复现 | backend/test/audit-sos-faults.e2e-spec.ts 用例 ⑤（PASS，记录行为） |
| 预期 | 有界重复（文档/注释口径） |
| 实际 | 与口径一致：attempts 1→failed→2→sent，Provider 调用 2 次 |
| 源码位置 | backend/src/sos/sos-notifier.service.ts:87,118-131 |
| 复现频率 | 确定性 |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/audit-sos-faults.log |
| 建议修法 | 无需修复；接入真实短信后可用 Provider 返回的 requestId 做幂等键降低重复（后续迭代） |
| 回归范围 | faults ⑤ |
| 旧报告关联 | 无 |

### SOS-08 · P3 · CONFIRMED — 通知行重试成功后 last_error 不清空：事故详情同时显示 status=sent 与旧错误文本

| 项 | 内容 |
|---|---|
| 严重度理由 | 仅记录/展示项，不影响投递 |
| 证据来源 | real-process |
| 影响范围 | App 事故详情/Admin 事故页对已成功的通知仍显示上一次错误，易被误读为失败 |
| 前置条件 | 某通知行首投 failed，扫描重试成功 |
| 最小复现 | docs/testing/2026-09-13/evidence/sos/scripts/run-restart-recovery.sh 场景 C：库态 failed/attempts=1/last_error='audit: 上一进程投递失败' → 重启 → sent/attempts=2 但 last_error 仍保留 |
| 预期 | 成功后 last_error 置空（或详情按 status 优先展示） |
| 实际 | update({status:'sent', sentAt}) 未写 lastError:null |
| 源码位置 | backend/src/sos/sos-notifier.service.ts:119-122 |
| 复现频率 | 确定性 |

### SOS-09 · P2 · CONFIRMED — 通知投递顺序不确定：本人 Push 抢在短信前发出，误报「短信全部失败」

> 2026-09-17 补录：本轮之外发现（跑全量 e2e 并开覆盖率插桩时，审计用例 ⑥ 的顺序断言翻转），同日已修复并加回归测试。

| 项 | 内容 |
|---|---|
| 严重度理由 | 不丢通知，但会在求救最关键的时刻给用户一条与事实相反的告警（「短信全部失败，请直接拨打电话求助」），可能让人放弃等待救援 |
| 证据来源 | integration（进程内 e2e） |
| 影响范围 | 每一次 SOS 终态化通知；顺序由数据库执行计划决定，两种结果都可能出现 |
| 前置条件 | SOS 终态化时同一事务创建 sms + push 两行通知 |
| 最小复现 | `backend/test/sos-notify-order.e2e-spec.ts`（把 push 行的 createdAt backdate 5s，即当年真实可能出现的 tie 结果之一）→ Push 标题为「SOS 紧急联系人通知发送失败」而短信随后成功 |
| 预期 | 同一单先投 sms 再投 push（SOS-04 的 pushText 按「此刻短信结果」生成正文，顺序是业务前提） |
| 实际 | `deliverPending` 只按 `createdAt asc` 排序；Postgres `now()` 返回事务开始时间，两行 createdAt 完全相同 → 无唯一次序键，顺序任意（与 DBOPS-01 同类） |
| 源码位置 | backend/src/sos/sos-notifier.service.ts（deliverPending 的 orderBy）；测试侧 `test/helpers/audit-sos.ts` 的 notificationsOf 同样缺次序键，导致审计用例 ⑥ 的断言本身也是 flaky |
| 复现频率 | 非确定性（负载/插桩会改变翻转概率） |
| 证据文件 | docs/testing/2026-09-13/evidence/sos/real-process-restart.json、docs/testing/2026-09-13/evidence/sos/real-process-restart.log |
| 建议修法 | 成功分支 data 增加 lastError: null |
| 回归范围 | 通知重试用例 |
| 旧报告关联 | 无 |

---

## 二、管理后台（本轮浏览器实测）

### ADMIN-01 · P2 · CONFIRMED — 五个页面把接口 500 渲染成「暂无数据」，概览把故障显示为全 0

| 项 | 内容 |
|---|---|
| 严重度理由 | 运维看后台判断系统状态；把「接口炸了」显示成「没有数据」会让真实故障被当成业务平静期，延误处置 |
| 证据来源 | device(browser) —— Playwright + 本机 Chrome，真实 Vite dev + 真实后端 |
| 影响范围 | 用户 / 设备 / 事故 / 事件四个列表页 + 概览页 |
| 前置条件 | 对应 admin 接口返回 5xx（本轮用 Playwright route 注入 500） |
| 最小复现 | `docs/testing/2026-09-13/evidence/admin/scripts/`（02/03-browser*.mjs）：拦截 `**/api/v1/admin/users**` 返回 500 → 打开 /users |
| 预期 | 显示「加载失败 / 请重试」之类错误态 |
| 实际 | 用户页正文为「…注册时间暂无数据暂无数据」；概览五个指标全部显示 0（设备总数 0、在线 0、用户总数 0、今日事件 0、进行中 SOS 0）；设备/事故/事件页同样显示「暂无数据」 |
| 源码位置 | `admin/src/pages/UsersPage.tsx:60`、`admin/src/pages/OverviewPage.tsx:24`（只用 `query.isLoading`，全项目无 `isError` 分支） |
| 复现频率 | 确定性 |
| 证据文件 | `evidence/admin/browser-results-2.json`、`evidence/admin/screenshots/E1-users-500.png`、`E2-overview-500.png` |
| 建议修法 | 每个页面加 `query.isError` 分支：表格用 antd `<Alert type="error">` + 重试按钮替代空态；概览在 error 时显示「—」并标红提示，不显示 0 |
| 回归范围 | admin 五个页面；建议补一条 Playwright 冒烟用例固定该行为 |

### ADMIN-02 · P3 · CONFIRMED — 后台搜索把 `%` / `_` 当 LIKE 通配符

| 项 | 内容 |
|---|---|
| 影响范围 | `/admin/users?keyword=`、`/admin/devices?keyword=`：搜 `%` 命中全部行，搜 `_` 命中任意单字符 |
| 证据来源 | integration（audit-admin e2e）+ device(browser)（D2 用例 rows(%)=rows(all)=3） |
| 最小复现 | `run-audit-suite.sh admin audit-admin`，用例「users keyword=% / _ / \ 只命中真正含该字符的行」 |
| 预期 | `%` 只命中昵称/手机号里真的含 `%` 的行 |
| 实际 | Prisma `contains` 直接拼 `LIKE '%kw%'`，未转义 `%`/`_` |
| 源码位置 | `backend/src/admin/admin.service.ts:25`、`:74` |
| 建议修法 | 入口对 keyword 做 `kw.replace(/[\\%_]/g, m => '\\' + m)` 并用 `mode:'insensitive'`；或改 `startsWith`/精确匹配 |
| 说明 | 非越权（admin 本就可列全部），属搜索语义缺陷 |

### ADMIN-03 · P3 · CONFIRMED — 后端不可达显示为「用户名或密码错误」

| 项 | 内容 |
|---|---|
| 影响范围 | Admin 登录页 |
| 最小复现 | Playwright `route.abort('connectionrefused')` 拦截登录接口 → 点登录 |
| 实际 | 提示「用户名或密码错误」，与真正的凭证错误无法区分 |
| 建议修法 | 区分 `ApiRequestError`（有 code）与网络层异常（fetch reject），后者提示「无法连接服务器」 |
| 证据文件 | `evidence/admin/screenshots/A3-backend-unreachable.png` |

### ADMIN-04 · P3 · CONFIRMED — 已注销用户仍在用户列表并计入 userTotal

| 项 | 内容 |
|---|---|
| 影响范围 | `/admin/users` 列表、`/admin/stats/overview.userTotal` |
| 实际 | 注销后 `phone` 被改写为 `deleted:<id>`、昵称保留，行仍出现；`userTotal` 用 `count()` 不过滤 `deleted_at` |
| 契约状态 | API.md §10 未定义注销用户在后台的口径 → **需负责人拍板**（运营审计视角保留合理；经营指标视角应剔除） |
| 源码位置 | `backend/src/admin/admin.service.ts`（listUsers / statsOverview） |
| 建议修法 | 二选一：① 列表默认过滤 `deletedAt: null` 并加「含已注销」筛选；② 保留但加「已注销」标记且 `userTotal` 只计活跃 |

---

## 三、App（静态审计 + 单测）

### APP-01 · P2 · CONFIRMED — 切换账号不清 React Query 缓存

| 项 | 内容 |
|---|---|
| 严重度理由 | 跨账号数据短暂可见；`staleTime: 10_000` 意味着 10 秒内**不发起重新请求**，直接把上一账号的设备/事件/事故渲染给新用户 |
| 证据来源 | static（源码路径确证）+ unit（App 客户端会话测试佐证会话交错） |
| 影响范围 | 全部 `useQuery` 页面：设备列表、事件、事故、联系人、频道、轨迹 |
| 最小复现 | 账号 A 登录浏览设备页 → 退出 → 账号 B 登录 → 设备页（10 秒内）显示 A 的设备 |
| 预期 | 登出/切号时清空查询缓存 |
| 实际 | `queryClient.clear()` 只出现在「我的 → 清除缓存」手动入口；`signOut`/`dropSession` 不清 |
| 源码位置 | `app/src/app/(tabs)/profile.tsx:128`（唯一 clear）、`app/src/stores/auth-store.ts` signOut/dropSession、`app/src/app/_layout.tsx:24`（staleTime 10s） |
| 建议修法 | 在 auth-store 的 `signOut`/`dropSession`/`signIn` 中调用注入的 `queryClient.clear()`（或在 `_layout` 监听 tokens 变化时 clear） |
| 回归范围 | 全部列表页；建议补一条 App 单测断言 signOut 后缓存为空 |

### APP-02 · P2 · SUSPECTED — spike-* 页仍是生产路由，且 spike-rtc 从客户端环境变量读 TRTC SecretKey

| 项 | 内容 |
|---|---|
| 影响范围 | `/spike-ble`、`/spike-location`、`/spike-push`、`/spike-rtc`、`/spike-map-web` 五条路由在 `.expo/types/router.d.ts` 中注册，可经 Deep Link 打开 |
| 实际 | `app/src/components/app-tabs.tsx:2` 注释「spike-* 页面文件保留…不再占标签位」——只是移出标签栏，路由仍在；`app/src/app/(tabs)/spike-rtc.tsx:16-17` 读 `EXPO_PUBLIC_TRTC_SDKAPPID/SECRETKEY` 在客户端生成 UserSig |
| 当前风险 | 本机 `app/.env` 两项为空，故当前构建不含密钥；但任何设置了该变量的构建会把 TRTC SecretKey 打进 bundle（THIRD_PARTY.md §8 已标记该风险） |
| 建议修法 | 正式包前删除 spike-* 页与 `EXPO_PUBLIC_TRTC_SECRETKEY`（对讲已切后端签发 UserSig）；或至少 `__DEV__` 门控路由注册 |
| 未复现原因 | 无真机/模拟器，未实际发起 Deep Link |

### APP-03 · P3 · CONFIRMED — API 客户端无请求超时

| 项 | 内容 |
|---|---|
| 影响 | 后端挂起/黑洞网络时 `fetch` 不返回，页面永久 loading，用户只能杀 App |
| 源码位置 | `app/src/api/client.ts`（无 `AbortController`/`signal`/timeout） |
| 建议修法 | 统一包 `AbortSignal.timeout(15000)`，超时抛可识别错误并映射到「网络超时」文案 |

### APP-04 · P3 · CONFIRMED — 9 个后端错误码无 App 文案

| 项 | 内容 |
|---|---|
| 缺口 | `CHANNEL_FULL`、`CONFLICT`、`EMERGENCY_CONTACT_LIMIT_REACHED`、`FORBIDDEN`、`MEDIA_NOT_READY`、`NOT_FOUND`、`PAYLOAD_TOO_LARGE`、`SOS_ALREADY_FINALIZED`、`TRTC_NOT_CONFIGURED` |
| 实际 | 回落 `error.unknown` → 显示「未知错误（CODE）」；不露 key，但对用户无指导 |
| 证据 | `app/src/api/__tests__/audit-error-messages.test.ts`（已把缺口清单钉死，新增码不同步会失败） |
| 建议修法 | 在 `error-messages.ts` + `i18n/messages/errors.ts` 三语补 9 条 |

### APP-05 · PASS（记录） — 倒计时口径正确

`sos-active.tsx:23-24,39,57` 与注册/找回密码页均为「截止时间戳 + 墙钟」实现（`Math.ceil((deadline - Date.now())/1000)` + 每秒刷新 `now`），符合 DEVELOPMENT.md 平台限制清单要求，退后台不会累计漂移。**注意**：依赖设备本地时钟，用户手动改表会让本地显示跳变（服务端 deadline 不受影响，取消/确认仍正确）——真机需按 DEVICE_CHECKLIST 4.7 实测。

---

## 四、BLE 中转（App 侧，`app/src/services/__tests__/audit-ble-*.test.ts`）

> 以下 6 条均已用 Jest 复现（11 个失败断言全部是刻意保留的缺陷证据）。运行：`cd app && npx jest --ci --watchman=false src/services/__tests__/audit-ble-`

| ID | 严重度 | 现象 | 源码位置 | 建议修法 |
|---|---|---|---|---|
| BLE-03 | P3 | 设备 A 积压 250 条 location_update 时，设备 B 的 possible_fall 要等到第 4 轮 flush（≈15s+）才送出 | `app/src/services/ble-relay-uplink.ts:76-80`（`queue[0].deviceId` 单设备成批） | 按设备轮转（round-robin）或按事件优先级排队：高危事件插队 |
| BLE-04 | P2 | 队列溢出（>1000）丢最旧：离线早期的 possible_fall / manual_sos 被后续周期事件挤出 | 同上 `:60-64`（无差别 `shift()`） | 溢出时优先丢 location_update/device_status，高危事件永不丢弃（与头盔 Flash「高危永不覆盖」口径一致） |
| BLE-05 | P2 | 某设备持续 404（已解绑）时队头阻塞：其余设备的 possible_fall 送不出，且 10 轮 flush 重试 10 次同一批 | 同上 `:84-92`（catch 后原样保留，下轮仍取 queue[0]） | 4xx 不可恢复错误：丢弃该设备批次并告警；失败设备移到队尾，保证其他设备可前进 |
| BLE-06 | P2 | 队列与持久化文件不按用户隔离：账号 A 退出、B 登录后，用 B 的会话补传 A 的设备事件（服务端 404），B 自己的事件被阻塞 | 同上（模块级单例 `queue` + 固定文件名 `ble-relay-queue.json`） | 文件名/队列按 userId 分区；`stopRelayUplink` 时按用户落盘，登录时只恢复本人分区 |
| BLE-07 | P3 | `start→stop→start` 在 load 完成前重入：同一 eventId 在内存队列出现两份，一次 flush 内重复提交 | 同上 `:106-112`（`void store.load().then` 无重入保护） | 用一个 `loading` Promise 做门闩；恢复时按 eventId 去重 |
| BLE-08 | P3 | 队列文件内容为 JSON `null` 时 `saved.length` 抛错 → 未处理的 Promise rejection | 同上 `:34`（`JSON.parse` 结果未校验是数组） | `Array.isArray(parsed) ? parsed : []`，并给 `.then` 加 `.catch` |

### BLE 实现状态盘点（决策 #38 v0.6 协议）

| 协议项 | 状态 | 位置 / 说明 |
|---|---|---|
| BleManager 生命周期、双端权限流程 | **已实现** | `app/src/services/ble-link.ts` |
| 扫描过滤（广播名 `Helmet-<后 6 位>`）、连接、Just Works 配对 | **未实现** | 同文件仅有 `bleReady()` |
| MTU 247 协商与回落 | **未实现** | — |
| 订阅 FEE1 Notify / 写 FEE2 | **未实现** | — |
| 握手（读 0x40 deviceId、0x00–0x02 固件、TIME SYNC） | **未实现** | — |
| 二进制帧 → EVENTS.md envelope 翻译层（含单位换算、WGS-84、无效哨兵 0xFFFF/0xFF/0x7FFF、UTC=0 回落） | **未实现** | DEVICE_PROTOCOL §1.2 有规则，代码无实现；哨兵值与 EVENTS.md 4.2「accuracy/speed/heading 必填」冲突（见 CONTRACT-08） |
| `eventId = UUIDv5(deviceId + Event_Seq)` 确定性生成 | **未实现** | 现有 `app/src/api/relay.ts:12` 是 `Math.random` v4，仅供开发注入 |
| 高危事件 ACK（1.5s×3）与 Flash 补传（0x07/0x08） | **未实现** | 风险：头盔收 ACK 即擦除 Flash，App 必须「先可靠落盘再 ACK」；当前 `enqueueRelayEvent` 是同步入内存 + 异步 `void store.save()`，若照此实现 ACK 会有丢数据窗口 |
| 上行中转队列（7 类过滤、批 ≤100、断线补传） | **已实现（骨架）** | `ble-relay-uplink.ts`，缺陷见上表 |
| 下行命令（WS → BLE 写入 → relay-ack） | **占位** | `ble-relay.ts:22-28` `writeToHelmet()` 直接 `return __DEV__`：开发构建模拟成功，生产构建只记日志不回执（设置页如实显示 offline，符合「不假装成功」铁律） |

---

## 五、对讲与媒体

### VOICE-02 · P2 · CONFIRMED — 注销账号不退出对讲频道

| 项 | 内容 |
|---|---|
| 影响 | 已注销用户仍在成员列表（昵称保留、手机号显示为 `del****`），并持续占用 20 人名额；满员频道无法加入新人 |
| 契约状态 | API.md §2 DELETE /users/me 列出的清理项不含频道 → 文档缺口，需补口径 |
| 最小复现 | `run-audit-suite.sh voice audit-voice-defects` 用例 VOICE-02 |
| 源码位置 | `backend/src/users/users.service.ts`（deleteAccount 事务只做会话/设备/联系人） |
| 建议修法 | 事务内加 `voiceChannelMember.deleteMany({ where:{ userId } })`；文档 §2 补一句 |

### VOICE-01 · P3 · CONFIRMED — 同一人并发加入满员频道返回 409

| 项 | 内容 |
|---|---|
| 实际 | 同一用户 5 次并发 join（其加入恰好填满频道）→ 1×200 + 4×409 CHANNEL_FULL（另一次观测 2×200 + 3×409）；数据层幂等成立（唯一约束只 1 行） |
| 复现频率 | **间歇（并发时序相关）**：4 次连续运行复现 1 次。已是成员的用户在并发下仍可能拿到 CHANNEL_FULL |
| 契约 | API.md §13「重复加入幂等返回频道」——接口层幂等在并发下不成立 |
| 源码位置 | `backend/src/voice/voice.service.ts:96-103`（advisory lock 内先数人再写，未先查自己是否已是成员） |
| 建议修法 | 锁内先查 `findUnique(channelId_userId)`，已是成员直接返回频道，不走名额判断 |

### MEDIA-01 · P3 · CONFIRMED — 他人设备的媒体可出现在受害者事件详情

| 项 | 内容 |
|---|---|
| 实际 | 攻击者用自己绑定的设备（走自己的 MQTT topic，未越权）上报 `video_ready`，`relatedEventId` 指向受害者的事件 → 受害者 `GET /events/{id}` 的 `media` 数组出现攻击者的条目（mediaId/status/duration）。`GET /media/{id}/url` 仍 404（归属校验有效），故不泄露视频内容 |
| 前置 | 需知道受害者的 eventId（设备生成的 UUID，难猜）→ 现实可利用性低 |
| 源码位置 | `backend/src/events/events.service.ts:96`（`OR: [{relatedEventId}, {eventId}]` 无 deviceId 限定） |
| 最小复现 | `run-audit-suite.sh voice audit-media-defects` |
| 建议修法 | 查询加 `deviceId: eventDeviceId` 限定 |

---

## 六、数据库 / 部署 / 容量

### DBOPS-01 · P3 · CONFIRMED — 轨迹分页排序无唯一次序键

`GET /devices/{id}/locations` 仅 `orderBy: timestamp`；同一时间戳多点时页序由执行计划决定（`evidence/dbops/05-explain-analyze.log`、`06-pagination-stability.log` 记录同页两种计划返回不同行）。修法：`orderBy: [{timestamp:'asc'},{id:'asc'}]`。

### DBOPS-05 · P3 · CONFIRMED — /health 503 响应体与文档不符

API.md §1.2 写 `{status:"error",database:"unreachable"}`，实际被统一异常过滤器改写为 `{code,message,requestId}`。修法二选一：改文档（推荐，探活只看状态码）或控制器直接 `res.status(503).json(...)`。

### DBOPS-06 · P3 · CONFIRMED — 两套 JWT 密钥误配同值无运行时校验

`deploy/.env.example` 要求 `ADMIN_JWT_SECRET` 与 `JWT_SECRET` 不同值，但代码不校验。同值时 admin token 能通过用户 `JwtAuthGuard`（用户侧无 `typ` 校验），`/users/me` 返回 404 而非 401；写接口（建频道/建联系人）会以不存在的 userId 落孤儿行。反向不成立（admin 守卫有 `typ==='admin'` 双保险）。修法：bootstrap 断言两者存在且不等；用户 token 也签 `typ:'user'` 并在守卫校验。

### DBOPS-07 · P3 · CONFIRMED — SIGTERM 无请求排空期

实测（`evidence/dbops/41-recoverability-rerun.log`）：发 SIGTERM 后 30 次顺序 `/health` 中 13 次连接被拒、17 次成功；进程 <1s 退出，端口正常释放。滚动发布时 Caddy 会短暂 502。修法：收到 SIGTERM 后先停止健康检查上报、延迟 3–5 秒再 `app.close()`。

### DBOPS-08 · P3 · CONFIRMED — 生产镜像含开发依赖；依赖漏洞 33 项

`backend/Dockerfile:24` 用 `npm ci -w backend -w packages/shared`（无 `--omit=dev`），jest/eslint/ts-node 等进镜像。`npm audit --registry=registry.npmjs.org`：**33 项（17 high / 16 moderate）**，其中**后端生产树命中** `multer`(high, DoS)、`qs`(moderate, DoS)、`fast-uri`(high)、`js-yaml`(high)、`mysql2`(high)、`deepmerge-ts`(high)、`uuid`(moderate)；直接依赖里 `@nestjs/*` 5 项与 `prisma` 标 high 且 `fixAvailable=true`。其余（`@xmldom/xmldom`、`image-size`、`decode-uri-component`）只在 Expo 工具链。修法：上线前跑一次 `npm audit fix`（@nestjs 与 prisma 有兼容补丁）并回归；Dockerfile 加 `--omit=dev`（注意 `npx prisma migrate deploy` 需要 prisma CLI 留在 dependencies）。证据：`evidence/dbops/60-npm-audit.log`、`62-npm-audit-prod.log`、`63-npm-audit.json`、`64-prod-dep-reachability.log`。

### DBOPS-09 · PASS（记录） — 误配启动全部 fail-fast

缺 `JWT_SECRET` / 缺 `ADMIN_JWT_SECRET` / 缺或错 `DATABASE_URL` → 进程 exit 1 且日志指明缺哪项；缺 `EMQX_INTERNAL_TOKEN` / `INGEST_WEBHOOK_API_KEY` → 进程正常启动但对应入口 fail-closed 全拒（符合设计）。证据：`evidence/dbops/42-misconfig.log`。

### DBOPS-10 · PASS（记录） — 备份恢复

`pg_dump -Fc` → 新库 `pg_restore`：9 张核心表计数逐一一致，约束数 131 vs 131，`sos_cases` 的 partial unique index（每设备至多一个 pending）正确恢复。**数据损失边界**：无 WAL 归档/PITR，最坏丢失「上次 dump 至故障」的全部数据；DEPLOYMENT.md §5 目前只给了手动 `pg_dump` 命令，无定时任务。证据：`evidence/dbops/41-recoverability-rerun.log`。

---

## 七、仓库卫生与测试基建（主代理直接确认）

见 `evidence/baseline/main-agent-findings.md`：HYG-01（两个 `" 2"` 杂散副本已提交进仓库，其中一个在 migration 目录）、HYG-02（未跟踪副本被 tsconfig 纳入编译，本机 lint 1 error 且 dist 混入 `* 2.js`；`sms-code.service 2.ts` 是缺 `change_phone` 的旧版本）、ENV-01（node_modules 383 个 `" 2"` 目录）、ENV-02（终端默认 Node 25 与 .nvmrc=24 不符）、TEST-01（`test:e2e` 固定 `RATE_LIMIT_DISABLED=1` + `--forceExit`）、COV-01/02（覆盖率分母口径）。
