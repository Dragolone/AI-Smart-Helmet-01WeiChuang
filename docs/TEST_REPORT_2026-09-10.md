# 上线前全方位测试报告（2026-09-10）

> 范围：backend / admin / app / mock-device / shared 全部工作区；本机 Docker PostgreSQL 16 + EMQX 5。
> 方法：静态检查 → 既有单测/集成测 → 新增 6 个加固/压力套件（`backend/test/hardening-*.e2e-spec.ts`、`stress.e2e-spec.ts`）→ 真实进程端到端（dist 后端 + Mock Device 走 app-relay 跑摔倒剧本）。
> 结论：**核心保命链路（SOS 状态机）在全部并发/竞态用例下正确；测出的 11 个缺陷（3 个 Ingest 5xx/丢数据、2 个滥用面、4 个并发名额/顺序、若干记录项）已于同日全部修复并回归：单测 80/80、e2e 24 套件 209/209 全绿，真实进程端到端复跑通过。**
>
> **修复状态（2026-09-10 同日）**：下表 #1–#16 全部已修（详见 §6；#15 由负责人拍板为「按绑定区间归属」，决策 #39）；#17（relay 批量吞吐）为容量项，MVP 不动。

## 1. 总览

| 层 | 结果 |
|----|------|
| 静态检查 | backend typecheck ✅ / lint 0 error（190 warning 全是测试文件 `any`）✅；admin typecheck+lint+build ✅；shared/mock-device typecheck ✅；app typecheck ✅（见 §5 环境说明）、app jest 16/16 ✅ |
| 后端单测 | 8 套件 79/79 ✅ |
| 既有集成测 | 18 套件 135/135 ✅ |
| Migration | 空库 `prisma migrate deploy` 13 个 migration 全过 ✅；开发库与 schema 无漂移 ✅ |
| 构建 | backend `nest build` ✅、admin `vite build` ✅（提示单 chunk 1.1MB，可后续拆包） |
| 新增加固套件 | 66 用例：修复前 55 ✅ / 11 ✕（每个 ✕ 对应下表一个缺陷）→ **修复后 66/66 ✅** |
| 压力套件 | 8/8 ✅，无 5xx、无连接重置、数据零丢失 |
| 真实进程端到端 | Mock Device(app-relay, SCENARIO=fall) → 建单 → 12s 到期 → notified → SMS/Push Mock 发出 ✅；设备离线时设置下发 → offline ✅ |

合计：backend e2e 24 套件 209 用例，修复前 198 通过 / 11 失败（全部为新发现缺陷，非回归）；**修复后 209/209 通过**。

## 2. 缺陷清单（按严重度）

### P0 — 上线前必修（保命链路上的 5xx / 丢数据）

| # | 现象（用例可复现） | 影响 | 建议修法 |
|---|---|---|---|
| 1 | envelope 含 **NUL 字符（\u0000）**、`schemaVersion` **超出 int32**（2147483648 / 1e18）、`timestamp` **极值年份**（0000）时，`raw_events` 插入抛错 → `/ingest/app-relay` **返回 500** | app-relay 是**逐条顺序**处理且整个请求失败：一条“毒事件”会让 App 反复重传同一批，**后面的 possible_fall 也一起被卡住**（队头阻塞）。MQTT 路径重试 3 次后丢弃该条。 | `envelope.ts` 增加：schemaVersion ∈ [0, 2^31-1]；timestamp 年份范围（如 2000–2100）；字符串字段拒绝 `\u0000`。并在 `IngestService.persist` 把非 P2002 的 DB 错误降级为 `stored_invalid`（reason=`db_rejected`），保证原始留档、接口不 5xx。 |
| 2 | `device_status` 的 `battery`/`signalLevel` 超出 int 范围（如 1e12）→ 设备快照更新整体失败 → **lastSeenAt 不刷新，设备显示离线** | 展示面直接错；固件一个字段发飞就全线“离线” | `DeviceSnapshotService` 逐字段收敛：battery 0–100 整数、signalLevel 0–5 整数，非法字段丢弃但 lastSeenAt 必写 |
| 3 | `video_ready.sizeBytes ≥ 2^31`（约 2GB 以上视频）→ 媒体表插入失败，**只打 warn，媒体元数据静默丢失** | 事故视频关联丢失 | `Media.sizeBytes` 改 `BigInt`（一个 migration），或校验超范围置 null 并告警 |

### P1 — 上线前应修（滥用面 / 错误格式）

| # | 现象 | 影响 | 建议修法 |
|---|---|---|---|
| 4 | **无任何限频**：40 次并发错密码全部 401 无 429；20 个不同手机号发验证码全部 204 | 密码可被无限撞库；短信真发后可被“短信轰炸”烧钱、签名被封 | 引入 `@nestjs/throttler`：`/auth/login` 按 IP+手机号限频；`/auth/sms-code` 按 IP 每日上限；Caddy 层可再加 `rate_limit` |
| 5 | 请求体 >100KB 时 body-parser 抛 413，统一过滤器**当成未知异常返回 500** 并打印完整堆栈 | 客户端拿不到正确 code；可被用来刷 ERROR 日志 | `UnifiedExceptionFilter` 识别带 `status/statusCode` 的 HttpError（body-parser），映射为 413/400 + `HTTP_413` 码 |
| 6 | `GET /admin/events?from=not-a-date` → Prisma 校验异常 → 500 | 后台一个错参就 500 | `AdminEventsQueryDto.from/to` 加 `@IsISO8601({strict:true})`（与用户侧 §6 一致） |

### P2 — 并发正确性（名额 / 顺序）

| # | 现象 | 影响 | 建议修法 |
|---|---|---|---|
| 7 | 紧急联系人已有 4 个时并发创建 4 个 → **8 个活跃联系人**（上限 5） | 短信通知对象超限、与 Contract 不符 | create 放进事务并 `pg_advisory_xact_lock(hashtext(userId))` 后再计数；或 users 表加 `contactCount` 由 DB 约束 |
| 8 | 对讲频道上限 2 时并发加入 3 人 → **4 个成员** | TRTC 房间超员 | 同上，按 channelId 加事务锁 |
| 9 | 命令回执顺序：A(vol=1) 与 B(vol=9) 先后下发，B 先 success 生效，A 迟到 success → **生效设置被覆盖回 vol=1** | “迟到回执如实覆盖 offline”口径正确，但**不该覆盖更新的生效值** | `applyAck` 合入设置时只处理 `issuedAt` 晚于设备当前 `settingsUpdatedAt` 的命令（Device 加一列），否则只记终态不合入 |
| 10 | 绑定竞态：测试中恰好 200/409，但代码路径是“先查后写”，无条件更新 | 极端时序下两个用户都绑定成功、后写者胜 | `bind` 用 `updateMany({ where:{deviceId, bindUserId:null} })` 判 count |

### P3 — 记录在案的行为（请负责人拍板是否改）

| # | 行为 | 说明 |
|---|---|---|
| 11 | 密码 `MaxLength(72)` 按字符数，bcrypt 按 72 **字节**截断：72 个汉字密码登录时后 48 字随便填也能登录 | 改为 `Buffer.byteLength ≤ 72` 校验 |
| 12 | 同一 refresh token 并发 5 次 → 5 次都成功 | 轮换竞态窗口；不影响安全边界，但削弱“复用检测” |
| 13 | 找回密码后旧 access token 15 分钟内仍有效；WS 连接在 token 过期后不断开、继续收推送 | 15 分钟窗口属设计口径（API.md §2）；WS 建议按 `exp` 定时关闭或心跳复验 |
| 14 | `timestamp=2026-02-30T00:00:00Z` 被接受并入库为 03-02 | JS Date 回滚，设备侧日期 bug 会被掩盖；可在 envelope 校验中回验 `toISOString()` 前缀 |
| 15 | 设备换绑后，新主能看到**前主期间**的事件与轨迹（事故记录按 userId 固化，看不到） | 事件/轨迹归属按“当前绑定”是既定口径；二手/转让场景是否要按绑定时间截断，需产品拍板 |
| 16 | SOS 短信昵称回落为 deviceId 前 10 字符（示例：`helmet_e2e`） | 家属看到“您的联系人 helmet_e2e …”很怪；建议回落为“您的联系人”+脱敏手机号 |
| 17 | app-relay 单批 100 条在 60 并发批次下 p50≈4.7s（逐条顺序入库，每条约 5 次查询） | MVP 规模够用（本机约 1300 事件/秒）；量上来后可按批事务化 |

## 3. 通过项摘要（可作为验收依据）

- **SOS 状态机全部竞态用例通过**：25 个并发 possible_fall 只建 1 单；同 eventId 重放 10 次不重复；cancel×5 + confirm×5 并发恰好 1 个 200 其余 409；到期后 10 个并发 tick 每条通知恰好投递 1 次（同号联系人去重）；失败重试 3 次封顶；解绑后原主仍可处置、换绑后新主看不到旧单、旧单到期仍通知旧主联系人；位置快照非法坐标回落最新轨迹点；创建时 Push 抛错不影响建单；pending 中 manual_sos 立即终态化。
- **Ingest 幂等**：同批重复、6 个并发相同批次、并发重放全部只存一次；坏输入（非对象、缺时区、类型越界、坐标越界、外层 deviceId 不一致、范围外类型）全部留档不进业务。
- **鉴权隔离**：篡改签名 / alg=none / 过期 / admin 密钥 token 进用户接口 / 用户密钥伪造 typ=admin 进 admin 接口，全部 401；WS 同样 4401。
- **WebSocket**：300 连接广播 35ms；1MB 垃圾帧、非 JSON、伪造 device_command、伪“订阅”指令均不影响服务，非绑定用户收不到任何推送；关闭/强杀后连接表清空。
- **压力**（本机 M 系列 Mac，Docker PG）：Ingest 直灌 3000 条 1285 事件/秒零丢失；app-relay 60 批×100（含 20% 补传）6000 条计数精确；500 并发 GET /devices p95 104ms；60 并发 bcrypt 登录全部成功 p95 820ms；50 并发 PUT settings + 50 并发 relay-ack 全部正确；WS 200 连接×50 推送 10000/10000 送达 0.5s；混合负载 20s 共 19027 请求 0 个 5xx，堆内存 271MB→150MB 回落。
- **真实进程端到端**：dist 后端 + Mock Device app-relay 传输，3 个点后触发 possible_fall → 服务端建单（location source=event）→ 12s 后 notified → `[MOCK SMS] sos_alert` + `[MOCK PUSH]` 发出；设备离线时 `PUT settings` → pending → 5s 后 offline，从未显示成功。

## 4. 新增测试文件（未提交，供 Review）

```
backend/test/helpers/hardening.ts          公共辅助（起应用/造用户设备/清理/直方图/分位数）
backend/test/hardening-ingest.e2e-spec.ts  Ingest 边缘输入与并发（21 用例，6 ✕ = 缺陷 1/2/3/5）
backend/test/hardening-auth.e2e-spec.ts    认证/令牌/限频/请求体（18 用例，1 ✕ = 缺陷 5；4/11/12/13 以 console 记录）
backend/test/hardening-sos.e2e-spec.ts     SOS 并发竞态（8 用例，全过）
backend/test/hardening-devices.e2e-spec.ts 绑定/命令/查询边界/名额竞态/Admin（14 用例，4 ✕ = 缺陷 6/7/8/9）
backend/test/hardening-realtime.e2e-spec.ts WS 鉴权/风暴/垃圾帧（5 用例，全过）
backend/test/stress.e2e-spec.ts            压力（8 用例，全过，约 30s）
```

用例断言的是正确行为；修复后全部转绿，可随修复一起合入 main。`test:e2e` 脚本默认 `RATE_LIMIT_DISABLED=1`（同 IP 大量造用户），限频用例在套件内显式打开。

## 6. 修复记录（2026-09-10，与本报告同一分支）

| # | 修法 | 涉及文件 |
|---|---|---|
| 1 | envelope 校验：schemaVersion ∈ [0, 2^31-1]、timestamp 年份 ≥ 1970 且日历合法（02-30 拒收）、拒绝 `\u0000`；数据库仍拒绝的单条数据降级为 `_invalid` 留档（reason=`db_rejected_*`），连接类故障仍按 5xx/重试 | `ingest/envelope.ts`、`ingest/ingest.service.ts` |
| 2 | `normalizeDeviceStatus()`：battery 0–100 整数、signalLevel 0–4 整数，越界字段丢弃但 lastSeenAt 必写；WS device_status 推送复用同一收敛 | `devices/device-snapshot.service.ts`、`realtime/realtime-push.service.ts` |
| 3 | `media.size_bytes` 改 BigInt（migration `20260909200956_media_size_bytes_bigint`）；duration 超 int4 置 null | `prisma/schema.prisma`、`media/media-recorder.service.ts` |
| 4 | 自研单实例内存滑动窗口 `RateLimitGuard` + `@RateLimit()`（不引入 Redis/throttler）：login 同 IP+手机号 10/分、同 IP 100/分；sms-code 同 IP 5/分、50/天；register 20/分；reset 10/分；refresh 60/分；admin login 10/分；429 带 `Retry-After`；main.ts 开 `trust proxy` 取真实 IP；`RATE_LIMIT_DISABLED=1` 仅测试用 | `common/rate-limit.guard.ts`、`auth/auth.module.ts`、`auth/auth.controller.ts`、`admin/admin-auth.controller.ts`、`main.ts`、`.env.example` |
| 5 | 统一过滤器识别 body-parser 等 4xx HttpError：413 → `PAYLOAD_TOO_LARGE`，只记 warn 不打堆栈 | `common/http-exception.filter.ts` |
| 6 | `AdminEventsQueryDto.from/to` 加 `@IsISO8601({strict:true})` | `admin/admin.dto.ts` |
| 7/8 | 联系人创建、频道加入放进事务并 `pg_advisory_xact_lock(hashtext(...))` 串行化「计数 → 写入」 | `contacts/contacts.service.ts`、`voice/voice.service.ts` |
| 9 | 回执合入设置时剔除「更晚下发且已 success 的命令」触碰过的键（按键粒度，未被覆盖的键照常合入） | `commands/commands.service.ts` |
| 10 | 绑定改条件更新 `updateMany({ where: { deviceId, bindUserId: null } })`，命中 0 行 → 409 | `devices/devices.service.ts`（单测同步） |
| 11 | 密码加 `@MaxBytes(72)`（字节数） | `auth/auth.dto.ts` |
| 12 | refresh 轮换改条件更新：并发只有一方成功，输家 401 但不触发全局撤销 | `auth/auth.service.ts` |
| 13 | WS 连接按 token `exp` 定时以 4401 关闭 | `realtime/realtime.gateway.ts` |
| 14 | 见 #1（日历严格校验） | — |
| 16 | SOS 短信昵称缺省回落为脱敏手机号（11 字符，在腾讯云变量 12 字符限内） | `sos/sos-notifier.service.ts` |
| 15 | **决策 #39**：新表 `device_bindings` 记录每段绑定（migration `20260910031837_device_bindings`，回填现有绑定）；bind/unbind 同事务开关区间；事件列表/详情、轨迹 latest/范围、媒体取 URL 只返回本人绑定区间内（receivedAt）的数据。换绑新主看不到前主数据；同一人解绑再绑回来两段历史都可见。**注意：与 #3 的 migration 分属两个 PR（仓库规则一 PR 一 migration）** | `devices/binding-scope.service.ts`（新）、`devices/devices.service.ts`、`events/events.service.ts`、`locations/*`、`media/media.service.ts`、`docs/API.md §4/§5/§6`、`docs/DATABASE.md`、`docs/DECISIONS.md #39` |
| 文档 | API.md §1.1 新增 `PAYLOAD_TOO_LARGE`、§2 限频规则与密码字节上限、§8 迟到回执不回写新键、§11 WS 到期断开；EVENTS.md §1 值域与 §2 字符集规则 | `docs/API.md`、`docs/EVENTS.md` |

## 5. 环境层面的发现（非产品缺陷）

- 本机 **3000 端口被无关容器 `c3322-node` 占用**，仓库自带的 EMQX（回调 `host.docker.internal:3000`）打到了错的服务。**已绕过验证（2026-09-10）**：临时起第二个 EMQX 容器（1884 端口，回调改指 3100），dist 后端 + Mock Device 走 `TRANSPORT=mqtt` 真跑：设备认证正/误密、无凭证、冒用后端账号全部拒绝；合法设备订阅他人 `cmd` 被拒（SUBACK 失败）、向他人 topic 发布被 Broker 丢弃（他人设备 0 条入库）、在自己 topic 里冒充他人 deviceId 按 `device_id_mismatch_with_topic` 留档；正常事件入库、possible_fall → 12s → notified → 短信/推送；`PUT settings` → PUBACK 判 delivered → 设备 cmd_ack → success 且设置生效 `{beep:true,vol:7}`。脚本见 scratchpad `e2e-mqtt.sh`（未入库）。
- `app/` 本地 `node_modules` 与 lockfile 漂移（缺 expo-image-picker），且 `.expo/types/router.d.ts`（生成文件，已 gitignore）过期 → 本机 typecheck 红。执行 `npm install` 并移走过期生成文件后 typecheck 绿；`expo lint` 本机仍报 2 个 `import/no-unresolved`，CI 同一命令 0 error，属本机 resolver 差异。
- `npm audit` 在 npmmirror 镜像上不可用（未实现 advisories 接口）；上线前请用 `--registry=https://registry.npmjs.org` 跑一次。
- 部署层 Caddy 无请求体/限频配置，后端也无 throttler（见缺陷 4）。
