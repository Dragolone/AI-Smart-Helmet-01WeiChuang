# API.md — REST / WebSocket API Contract（App / Admin ↔ Backend）

> 状态：**初稿（待双人 Review + 负责人确认后定稿）**。已实现部分（§1/§2/§4/§10）的 DTO 已在 `packages/shared` 落为 TS 类型（2026-08-15）；本文件变更时必须同步 `@helmet/shared`。
> 破坏性变更流程见 CLAUDE.md「API Rules」：先改本文件 + shared 并确认，再改实现；后端先合并并对旧字段保持一版兼容。
> 标记：✅ 已定 ｜ ⚠️ 待定稿。

## 1. 通用约定（✅）

- Base URL：`/api/v1`；管理后台 `/api/v1/admin/*`（独立权限守卫）。
- 认证：`Authorization: Bearer <accessToken>`（JWT）。设备侧认证走 MQTT（DEVICE_PROTOCOL §3），不在本文件。
- 时间：一律 ISO 8601 UTC 字符串（如 `2026-08-14T03:00:00Z`）；展示层转本地时区。
- 业务主键：UUID v7 / cuid；设备用硬件团队的 `deviceId`。
- 分页：`?page=1&pageSize=20`（pageSize 默认 20，最大 100）→ 响应 `{ "items": [...], "total": 0, "page": 1, "pageSize": 20 }`。
- 统一错误格式：

```json
{ "code": "DEVICE_NOT_FOUND", "message": "human readable", "requestId": "req_..." }
```

客户端只依赖 `code` 不依赖 `message`。**错误码只增不改**。

### 1.1 通用错误码（首批，✅）

| code | HTTP | 场景 |
|------|------|------|
| VALIDATION_FAILED | 400 | 请求体/参数校验失败（含任何字段带 NUL `\u0000`，PostgreSQL 不接受；设备入口 `/ingest/*` 例外——脏 envelope 留档为 invalid 不整批拒绝） |
| UNAUTHORIZED | 401 | 未登录或 token 无效/过期 |
| FORBIDDEN | 403 | 无权访问该资源（含资源归属校验失败、非 Admin 访问 Admin API） |
| NOT_FOUND | 404 | 通用资源不存在 |
| DEVICE_NOT_FOUND | 404 | 设备不存在或未绑定到当前用户 |
| CONFLICT | 409 | 通用冲突 |
| DEVICE_ALREADY_BOUND | 409 | 设备已被绑定 |
| PHONE_ALREADY_REGISTERED | 409 | 注册/换绑手机号已存在 |
| PASSWORD_INCORRECT | 400 | 已登录用户提交的当前密码不正确（修改密码 / 注销账号） |
| BIND_CODE_INVALID | 403 | 设备绑定码不正确 |
| PAYLOAD_TOO_LARGE | 413 | 请求体超过 100KB（body-parser 上限；头像 data URI 上限 90KB） |
| RATE_LIMITED | 429 | 触发限流（公开认证接口按 IP / IP+手机号，响应带 `Retry-After` 秒数；规则见 §2） |
| INTERNAL_ERROR | 500 | 服务端异常（带 requestId 供排查） |
| SERVICE_UNAVAILABLE | 503 | 统一过滤器对 503 类异常的兜底码；各业务 503 有自己的码（见下表） |

各节自有错误码索引（客户端文案按 code 映射，全部列在此便于对表；详情见各节）：

| code | HTTP | 节 |
|------|------|----|
| SMS_CODE_INVALID / SMS_CODE_TOO_FREQUENT / SMS_CODE_DAILY_LIMIT / SMS_SEND_FAILED / PHONE_NOT_REGISTERED | 400 / 429 / 429 / 503 / 404 | §2 |
| EMERGENCY_CONTACT_LIMIT_REACHED | 409 | §3 |
| SOS_ALREADY_FINALIZED | 409 | §7 |
| MEDIA_NOT_READY | 409 | §9 |
| CHANNEL_FULL / TRTC_NOT_CONFIGURED | 409 / 503 | §13 |

## 1.2 健康检查（✅ 已实现）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 服务与数据库连通性：`200 { "status": "ok", "database": "connected" }`；数据库不可达时 `503 { "status": "error", "database": "unreachable" }`；进程收到 SIGTERM 后的排空期（默认 3s，`SHUTDOWN_DRAIN_MS`）返回 `503 { "status": "draining", "database": "connected" }`——网关/拨测据此摘流量，在途请求照常完成。无需认证，供负载均衡/运维探活 |

## 2. 认证与用户

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /auth/sms-code | 下发短信验证码（✅ 2026-09-09 负责人拍板：注册必须验证码）。body：`{ phone, purpose: "register" \| "reset_password" \| "change_phone" }` → 204。规则：6 位数字、**5 分钟有效、一次性、连续错 5 次作废**；同号同用途 **60s 内重发 → 429 `SMS_CODE_TOO_FREQUENT`**，**每号每日 10 条 → 429 `SMS_CODE_DAILY_LIMIT`**；`register` 用途下手机号已注册 → 409 `PHONE_ALREADY_REGISTERED`；`reset_password` 用途下未注册 → 404 `PHONE_NOT_REGISTERED`；**`change_phone` 用途（✅ 2026-09-11）：`phone` 为待换绑的新号**，已注册 → 409 `PHONE_ALREADY_REGISTERED`；短信通道失败或超时（`SMS_SEND_TIMEOUT_MS`，默认 10s）→ 503 `SMS_SEND_FAILED`（不计入限频）。同号同用途并发发码只放行一条（服务端事务内串行化）。库中只存验证码哈希 |
| POST | /auth/register | 注册。body：`{ phone, code, password, nickname? }`——`code` 为上一步 `register` 用途的验证码；错误/过期/已用/超次统一 400 `SMS_CODE_INVALID`（不区分原因）。校验顺序：手机号已注册 409 → 验证码 400 → 建号并返回 `{ accessToken, refreshToken, user }` |
| POST | /auth/reset-password | 找回密码。body：`{ phone, code, newPassword }`（`reset_password` 用途验证码）→ 204；成功后**该用户全部 refresh token 作废**，所有设备需重新登录。未注册 404 `PHONE_NOT_REGISTERED` |
| POST | /auth/login | 登录。body：`{ phone, password }` → `{ accessToken, refreshToken, user }`。密码 8–72 字符且 ≤ 72 字节（bcrypt 上限，超出 400） |
| POST | /auth/refresh | body：`{ refreshToken }` → 新 `{ accessToken, refreshToken }`（refresh 轮换，旧 refreshToken 作废；同一 token 并发刷新只有一方成功，其余 401；已轮换的 token 在 10s 并发窗口后再次出现才视为盗用撤销全部会话） |

限频（2026-09-10 加固，单实例内存滑动窗口，超限 429 `RATE_LIMITED` + `Retry-After`）：`/auth/login` 同 IP+手机号 10 次/分、同 IP 100 次/分；`/auth/sms-code` 同 IP 5 条/分、50 条/天（同号 60s/日限另计）；`/auth/register` 20 次/分；`/auth/reset-password` 同 IP+手机号 10 次/分；`/auth/refresh` 60 次/分；`/admin/auth/login` 10 次/分。
| POST | /auth/logout | 作废当前 refreshToken |
| POST | /auth/change-password | 修改密码（✅ 2026-09-11，**需登录**）。body：`{ oldPassword, newPassword, refreshToken? }` → 204。旧密码错误 → 400 `PASSWORD_INCORRECT`；`newPassword` 与注册同规则（8–72）。成功后**撤销该用户其他全部 refresh token**；带上当前设备的 `refreshToken`（须属于本人）则该会话保留，本设备免重新登录 |
| POST | /auth/change-phone | 换绑手机号（✅ 2026-09-11，**需登录**）。body：`{ newPhone, code }`（`code` 为 `change_phone` 用途、发往 `newPhone` 的验证码）→ 200 返回更新后的 `user` 对象。校验顺序：`newPhone` 已注册 409 `PHONE_ALREADY_REGISTERED` → 验证码错误/过期/已用 400 `SMS_CODE_INVALID` → 改号。会话不受影响；原号即刻释放可供他人注册 |
| GET | /users/me | 当前用户信息；已注销账号的残留 access token → 401 `UNAUTHORIZED` |
| PATCH | /users/me | 更新昵称/头像等非敏感字段 |
| DELETE | /users/me | 注销账号（✅ 2026-09-11，**需登录**；App Store 要求应用内可注销）。body：`{ password }` → 204；密码错误 → 400 `PASSWORD_INCORRECT`。**软删除**（`users.deleted_at`），一个事务内完成：置 `deletedAt`、`phone` 改写为 `deleted:<userId>`（**原手机号不保留**，即刻可重新注册为全新账号）、清空 `avatarUrl`、撤销全部 refresh token、解绑名下全部设备（与 `DELETE /devices/{deviceId}/binding` 同口径，设备与历史事件留档）、软删除全部紧急联系人、**退出全部对讲频道（释放名额，频道本身保留；2026-09-14 审计 VOICE-02 补）**，并**主动以 4401 断开该账号已建立的 WebSocket 连接**（2026-09-14 审计 AUTH-05/INGEST-04 补）。事故记录/事件/轨迹按设备留档不动。已注销用户：login 401（号已改写）、refresh 401（token 已撤销 + 服务端校验 `deletedAt`）；**JWT 守卫验签后查 `deleted_at`（✅ 2026-09-12 上线前探针修复）**——注销后残留的 access token 在全部 REST 接口与 WS 连接上立即 401 / 4401，不能再绑设备、建联系人、改资料 |

`user` 对象：`{ id, phone, nickname, avatarUrl?, createdAt }`。密码 bcrypt/argon2 存储，任何接口不回传。

Token 有效期（✅ 已定稿并实现，2026-08-15）：**access 15 分钟 / refresh 30 天**；refresh 轮换制——每次刷新旧 token 作废，已作废 token 被复用视为盗用信号、撤销该用户全部会话。本节 register/login/refresh/logout 与 /users/me 均已实现；**短信验证码（sms-code / register.code / reset-password）2026-09-09 实现**；**账号与安全（change-password / change-phone / DELETE /users/me，✅ 2026-09-11 负责人拍板）已实现**，TS 类型见 `@helmet/shared` ChangePasswordRequest / ChangePhoneRequest / DeleteAccountRequest。本地与演示环境短信走 Console Mock，验证码打印在后端日志（`[MOCK SMS] … verify_code`），云端查看：`docker compose -f docker-compose.prod.yml logs backend | grep verify_code`；腾讯云通道配齐 `TENCENT_SMS_*` 六项环境变量即切换为真发（THIRD_PARTY.md §4）。

## 3. 紧急联系人

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /users/me/emergency-contacts | 列表（按创建先后排序） |
| POST | /users/me/emergency-contacts | body：`{ name, phone, relation? }`；超上限 → 409 `EMERGENCY_CONTACT_LIMIT_REACHED` |
| PATCH | /users/me/emergency-contacts/{contactId} | 更新（name/phone/relation 任意子集） |
| DELETE | /users/me/emergency-contacts/{contactId} | 删除（软删除，释放名额；历史 SOS 通知记录留档不受影响） |

`contact` 对象：`{ id, name, phone, relation: string|null, createdAt }`（TS 类型见 `@helmet/shared` EmergencyContact）。SOS 通知（SMS）发送对象即此列表。

- **上限 5 个（✅ 定稿 2026-08-16）**：按活跃（未删）联系人计数。
- phone 校验与注册同口径（大陆手机号）；对他人/已删联系人的改删一律 404（不泄露存在性）。
- ✅ 本节已实现（2026-08-16）。

## 4. 设备

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /devices/bind | 绑定。body：`{ deviceId, bindCode }`（✅ 绑定凭证 = 出厂 8 位绑定码 + 绑定二维码，格式 DEVICE_PROTOCOL §11、由 `provision:batch` 产出；⚠️ 印制载体待硬件确认；Mock 设备用注册时生成的 bindCode 走同一流程） |
| GET | /devices | 我的设备列表 |
| GET | /devices/{deviceId} | 设备详情（含实时状态快照） |
| PATCH | /devices/{deviceId} | 重命名（2026-08-17）。body：`{ name?: string }`（≤20 字符，trim 后空串=清除，App 回退显示 deviceId）；返回更新后的 device 对象 |
| DELETE | /devices/{deviceId}/binding | 解绑（软删除绑定关系，设备数据留档；关闭当前这段绑定历史） |

绑定历史与可见范围（✅ 2026-09-10 负责人拍板，决策 #39）：每次绑定/解绑记一段区间（`device_bindings`）。§5 轨迹、§6 事件、§9 媒体只返回**当前用户在该设备上的绑定区间内**到达（服务端 `receivedAt`）的数据——换绑后新主看不到前主期间的数据；同一用户解绑再绑回同一台头盔，之前的记录仍然可见。§7 事故记录按建单时的 userId 固化，不受影响；Admin 全量可见。
| GET | /devices/{deviceId}/status | 设备状态：`{ online, lastSeenAt, battery, charging?, signalLevel?, sleeping, firmwareVersion }` |
| GET | /devices/{deviceId}/battery-history?hours=24 | 电量历史（✅ 2026-09-10）：`{ from, to, points: [{ timestamp, battery, charging }] }`。数据源=raw_events 的 `device_status` 心跳，按 **10 分钟桶取桶内最后一条**（24h ≤ 144 点）；`battery` 不是 0–100 整数的心跳按缺失跳过（与设备快照同口径，2026-10-03——不再把 255 这类越界值截成 100% 画出来）；`hours` 1–168 默认 24；仅本人设备（否则 404）。App 设备详情页据此画 24h 电量曲线（替代原大电量条）；**只返回本人绑定区间内（服务端 receivedAt）到达的心跳**（决策 #39 同口径，2026-09-14 审计 AUTH-06 补） |

device 对象补充字段（2026-08-17，TS 类型见 `@helmet/shared` DevicePublic）：`name`（用户自定义名，null 时 App 显示 deviceId）、`bindCode`（仅经归属校验的端点返回——本人可见，供详情页展示）。

- MVP 绑定关系：一台设备同时只能绑定一个用户；一个用户可绑多台。⚠️ 家庭共享/多人查看不在 MVP。
- `online` 判定规则见 DEVICE_PROTOCOL §5，由服务端计算（lastSeenAt 距今 ≤ 90s），App 不自行判断。
- ✅ 本节已实现（2026-08-15）：bind / 列表 / 详情 / 解绑 / status；设备开通用 `npm run provision:device -w backend`（生成 deviceId+deviceSecret+bindCode，Mock 与真机同机制）；绑定码 MVP 为 8 位数字（随附形式 = 二维码 + 说明卡，印制待硬件确认，DEVICE_PROTOCOL §10 C-12）。

## 5. 位置与轨迹

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/locations/latest | 最新位置：`200 { "location": <location 对象> \| null }`（设备存在但尚无数据时为 null，✅ 定稿）。设备时钟跑到未来的点（`timestamp` 超过服务器当前时间 5 分钟以上，DEVICE_PROTOCOL §8 的偏移阈值）不参与「最新」判定——否则一条错误时间的点会永久排在最前；该点照常留档，按时间范围仍可查到（2026-10-03） |
| GET | /devices/{deviceId}/locations?from=&to=&page=&pageSize= | 历史轨迹（from/to 必填 ISO 8601；**单次范围上限 24h，✅ 定稿**；按 timestamp 升序；统一分页结构） |
| GET | /devices/{deviceId}/locations/summary?from=&to= | 区间轨迹统计（2026-09-17 A 线新增，App 首页「今日骑行」）：`200 { distanceMeters, movingSeconds, maxSpeed, pointCount, firstAt, lastAt }`；from/to 规则同上（必填、≤24h）；服务端按相邻点大圆距离累加，间隔 >10 min 的段不桥接、隐含速度 >55 m/s 视为漂移不计；`movingSeconds` 只累计平均速度 ≥0.5 m/s 的段；`maxSpeed` 为设备上报速度最大值（m/s），无点时 maxSpeed/firstAt/lastAt 为 null。TS 类型 `LocationSummaryResponse` |

`location` 对象（与 EVENTS.md 4.2 对齐，TS 类型见 `@helmet/shared` LocationPoint）：`{ latitude, longitude, coordinateSystem, accuracy, speed, heading, altitude, timestamp, receivedAt }`（altitude 无值为 null——滑雪场景核心维度，设备上报则全链路透传）。

- 坐标系原样返回并带 `coordinateSystem`；是否服务端统一转 gcj02 随地图 Spike 定稿（DECISIONS 待定项）。
- 轨迹查询走服务层（为未来 Retention/降采样留余地），App/Admin 不假设“所有点都在”。
- 位置分享：MVP 用 App 端生成分享内容（坐标 + 高德跳转链接），**不做服务端分享短链** ⚠️ 若产品要求可访问网页版分享再评估。
- ✅ 本节已实现（2026-08-15）：位置由 Ingest 从 location_update 事件写入 location_points 表（仅已注册设备；payload 逐字段校验，不合法只留 raw）；归属校验与 §4 同口径（非本人 404），且 latest/范围查询只含本人绑定区间内的点（决策 #39）。

## 6. 事件查询（危险事件 / 全量事件历史）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/events?type=&from=&to=&page=&pageSize= | 事件历史（最新在前）；`type` 可多值逗号分隔（取值 = EVENTS.md §3 eventType，未知值 400）；from/to 均选填（事件量级低，不设 §5 的 24h 上限），同给时须 from < to |
| GET | /events/{eventId} | 事件详情（含原始 payload、关联媒体） |

`event` 列表项（TS 类型见 `@helmet/shared` EventListItem）：`{ eventId, deviceId, eventType, timestamp, receivedAt, summary }`；详情（EventDetail）追加 `payload`（原样）与 `media: [{ mediaId, status, duration }]`。

- `summary` 为服务端生成的一句话摘要，仅兜底展示；**客户端逻辑不得依赖其内容**（App 有本地化文案时可忽略）。
- 归属口径：设备须**当前绑定**给本人（与 §4/§5 一致），且列表/详情只含本人**绑定区间内**到达的事件（决策 #39，按 receivedAt 判）；校验失败的 `_invalid` 占位事件不出现在任何查询结果。
- 「当前危险状态」由 App 从 WS `risk_event` 事件流推导，服务端不维护实时态（✅ 口径 2026-08-16 定稿，决策 #27）；历史随时可查本节接口。
- ✅ 本节已实现（2026-08-16）：media 数组由 §9 媒体表反查填充（WS `risk_event` 推送时媒体通常尚未上传，实时消息中恒为空，App 用详情接口兜底）。

## 7. SOS / 事故记录

SOS 状态机为服务端权威（DECISIONS #8/#26）：`pending → notified | cancelled`；App 仅渲染。deadline = 服务端接收时间 + 60s（`SOS_COUNTDOWN_SECONDS`），设备时钟不参与。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/sos/active | 当前进行中 SOS：`200 { "sos": <sos 对象> \| null }`（无进行中时为 null，**✅ 定稿**，与 §5 latest 同口径） |
| POST | /sos/{sosId}/cancel | 取消（仅 pending 可取消；终态返回 409 `SOS_ALREADY_FINALIZED`） |
| POST | /sos/{sosId}/confirm | “SOS Now”：跳过剩余倒计时立即通知 |
| GET | /devices/{deviceId}/accidents?page=&pageSize= | 事故记录列表（含已取消供留档，最新在前；TS 类型 AccidentListItem）。换绑后新主看不到旧主的事故（deviceId+userId 双过滤） |
| GET | /accidents/{accidentId} | 事故详情（TS 类型 AccidentDetail）：sos 对象 + `location`（快照，source: event\|last_point）+ `triggerPayload`（触发事件原始 payload）+ `notifications`（通道/状态/重试次数/错误；**target 已脱敏**） |

`sos` 对象（TS 类型见 `@helmet/shared` Sos）：`{ sosId, deviceId, triggerEventId, triggerType: "possible_fall"|"manual_sos", status: "pending"|"notified"|"cancelled", deadline, createdAt, updatedAt }`。

- App 收到 WebSocket/Push 的 `sos` 对象后按 `deadline` 本地倒计时渲染，不自行计时判断超时。
- 错误码：`SOS_ALREADY_FINALIZED`（409，取消/确认时状态机已终态）；取消/确认权限以**建单时固化的绑定用户**为准，他人操作一律 404（不泄露存在性）。进行中的单按「设备 + 用户」唯一（决策 #40）：换绑后新用户的求救另建新单，前用户的单不受影响。
- **Push 定向口径（2026-09-23，极光）**：服务端按 `alias = 用户 ID` 推送，App 登录成功后向极光 `setAlias(userId)`、退出登录 `deleteAlias`；未登记别名的用户推送记 failed（极光 1011），不影响短信。
- 通知：超时/确认后逐个紧急联系人发 SMS（同号去重）+ 本人 Push，逐条留档（成功/失败/通道/重试次数；**失败按退避重试，连首次最多 5 次，间隔 10 秒 / 1 分钟 / 5 分钟 / 15 分钟，前后约 21 分钟**——决策 #50，`SOS_NOTIFY_MAX_ATTEMPTS` / `SOS_NOTIFY_RETRY_DELAYS_SECONDS` 可调；单次 Provider 调用超时 `SOS_NOTIFY_TIMEOUT_MS` 默认 10s，超时按失败记 `timeout` 走重试）；事故位置快照优先取触发事件内嵌位置，回落最新轨迹点（✅ 口径 2026-08-16 定稿）。
- **状态语义（2026-09-14 审计 SOS-04 定稿）**：`status=notified` 只表示「已到期/已确认并创建了通知任务」，**不等于联系人已收到**——实际投递结果以 `GET /accidents/{id}` 的 `notifications[]` 逐条状态为准（`sent` = 服务商已接收，无回执时不代表送达）。本人 Push 标题按此刻短信结果生成：全部/部分成功 →「SOS 已通知紧急联系人」；全部失败 →「SOS 紧急联系人通知发送失败」；未设置联系人 →「SOS 未设置紧急联系人」。App 文案统一为「已向紧急联系人发出通知」而非「已收到通知」。
- **可靠性兜底（2026-09-14 审计 SOS-01/02/05 修复）**：位置快照查询失败不阻塞建单；建单遇数据库瞬断进程内重试；启动时、以及之后每 `SOS_RECONCILE_INTERVAL_SECONDS`（默认 60）秒，对账最近 `SOS_RECONCILE_WINDOW_MINUTES`（默认 15）分钟内「raw 已落库但无 SOS 单」的摔倒/求救事件并按当时绑定用户补建（周期对账为决策 #51，2026-10-03）。
- **补传的旧事件（决策 #52，2026-10-03）**：摔倒/求救事件无论发生在多久之前，到达服务端时一律照常建单、从到达时刻起倒计时 60 秒并通知联系人；只在给本人的「SOS 倒计时已开始」推送正文里注明「约 X 分钟/小时前的事件，刚补传到」（事件时间早于当前 5 分钟以上、且不超过 72 小时才注明）。`sos` 对象字段不变。
- ✅ 实现状态（2026-08-16）：本节全部端点已实现（active / cancel / confirm / accidents 列表与详情 + 状态机：触发/合并/倒计时/扫描/重启接管/通知重试）。

## 8. 设备设置下发（命令）

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | /devices/{deviceId}/settings | body：`{ settings: { <key>: <值> } }`（扁平键值；**✅ 参数清单定稿 2026-09-19，决策 #43**：14 项，键名/类型/取值范围以 `@helmet/shared` 的 `DEVICE_SETTINGS` 为准，见下表；未知键、类型不符、越界 → `400 VALIDATION_FAILED`，**服务端就拦、不创建命令、不下发**）→ 创建 set_config 命令并双路下发，`202 { commandId, status: "pending" }`（TS 类型 PutSettingsResponse） |
| GET | /devices/{deviceId}/settings | `{ settings, lastCommand }`——settings 为当前生效设置（**只写设备确认过的值：命令 success 回执，或头盔上报的实际值**，决策 #45），lastCommand 为最近一次下发（TS 类型 SettingsResponse） |
| POST | /devices/{deviceId}/settings/reported | **头盔实际设置上报（✅ 2026-09-19，决策 #45）**：App 每次 BLE 握手后读回头盔 0x20–0x2D 上报，body `{ settings: { <key>: <值> } }`（≤ 32 键）→ `200 { settings, applied, skipped }`（TS 类型 ReportSettingsRequest / ReportSettingsResponse）。**逐键**校验：清单外、类型不符、越界只跳过该键（`reason: invalid`），不整批拒；**有未完成（pending/delivered）或 30 s 内刚 success 的命令碰过的键跳过**（`reason: recent_command`，以命令为准——App 读到的可能是写入前的旧值）；已判 offline 的命令不保护。不创建命令、不改 lastCommand。归属：非本人 404 DEVICE_NOT_FOUND；结构错误（非对象/空/超 32 键）400 VALIDATION_FAILED |
| GET | /devices/{deviceId}/commands?page=&pageSize= | 命令历史（最新在前，TS 类型 CommandPublic） |
| GET | /commands/{commandId} | 命令状态：`pending → delivered → success \| failed \| offline`（语义见 DEVICE_PROTOCOL §7，**未回执绝不显示成功**） |
| POST | /devices/{deviceId}/commands/{commandId}/relay-ack | **BLE 下行链的回执入口（决策 #36）**：App 替头盔提交命令回执。body：`{ "stage": "delivered" }`（App 已收到命令并写入头盔——蓝牙版的 delivered 语义，对应 4G 版的 PUBACK）或 `{ "stage": "executed", "result": "success" \| "failed", "errorCode"?, "executedAt"? }`（头盔执行结果；executedAt 缺省、不是合法 ISO 8601、或年份不在 1970–9999 内时一律取服务器时间——设备/App 时钟不可信；MQTT cmd_ack 同口径）→ `200 { commandId, status }`（更新后状态）。**幂等不报错**：已终态命令再收 delivered/重复 executed 都返回当前状态；已判 offline 后迟到 executed 如实覆盖（同 MQTT cmd_ack 语义）。鉴权：用户 JWT + 设备归属（非本人 404 DEVICE_NOT_FOUND）+ 命令须属于该设备（否则 404 NOT_FOUND）。信任级与 §12.1 app-relay 一致（App 本就是蓝牙版设备的代理） |

- **可下发参数（源 = BLE 协议 v0.6 内存控制表 0x20–0x2D，App 端寄存器映射见 `app/src/services/ble/protocol.ts`）**：

| 键 | 类型 / 范围 | 出厂默认 | 含义 |
|----|------------|---------|------|
| volume | 整数 1–100（%） | 80 | 蜂鸣器音量 |
| buzzer | 布尔 | true | 蜂鸣器提醒开关 |
| vibration | 整数 0–3 | 2 | 振动挡位：0 关 / 1 弱 / 2 中 / 3 强 |
| light | 整数 0–3 | 0 | 大灯挡位：0 关 / 1 低亮 / 2 高亮 / 3 爆闪（头盔侧不掉电保存） |
| fallDetect | 布尔 | true | 跌倒检测使能 |
| fallSensitivity | 整数 1–3 | 2 | 跌倒灵敏度：1 低 / 2 标准 / 3 灵敏 |
| radar | 布尔 | true | 后置毫米波雷达防碰撞使能 |
| radarDistance | 整数 5–30（m） | 15 | 后方碰撞预警距离门限 |
| obstacleWarn | 布尔 | true | 前方障碍物预警使能 |
| sosButton | 布尔 | true | SOS 物理按键使能（关 = 防误触） |
| disconnectBeep | 布尔 | false | BLE 断连本地蜂鸣提醒 |
| heartbeatPeriod | 整数 1–255（s） | 60 | 心跳上报周期 |
| locationPeriodMoving | 整数 1–255（s） | 5 | 运动状态定位周期 |
| locationPeriodStill | 整数 1–255（s） | 30 | 静止状态定位周期 |

  类型严格：布尔只收 `true/false`，整数只收整数 number（`"80"`、`80.5`、`1` 代替 `true` 都拒）。回执 `errorCode` 码表见 EVENTS.md §6。
- **下发通道（决策 #36）**：命令创建后**双路并行**——MQTT QoS1 发布（4G 链路）+ WS `device_command` 推送给绑定用户（BLE 链路）。业务与状态机不感知设备形态；先到的 delivered 生效（条件更新幂等）。
- **生效设置与头盔对齐（决策 #45）**：只靠命令回执时，头盔自己变了云端看不到——大灯挡位（0x26）掉电不保存，重启后回到关；RECOVERY 恢复出厂、别的手机改过也一样。上报与回执合入按设备串行化（事务级咨询锁），并发不互相覆盖；值与记录不符时后端日志打一行「已按上报校正」。
- **状态口径（✅ 定稿 2026-08-16，决策 #27④）**：`delivered` = MQTT PUBACK（送达 Broker，非送达设备）；**30s**（`COMMAND_ACK_TIMEOUT_SECONDS`）无 cmd_ack → `offline`（App 显示"未送达/等待执行"）；**迟到回执如实覆盖 offline**（设备实际执行了就记 success/failed）；但合入「当前生效设置」时，**比它更晚下发且已 success 的命令触碰过的键不回写**（旧回执不能把新值覆盖回去，2026-09-10 加固）。
- 设备离线：命令照发（Broker 持久会话补投，依赖 Clean Session 决策 ⏸️ 4G 扩展时确认；BLE 链路走 WS + App 中转，决策 #36）；发布失败留 pending 超时判 offline。
- 归属：非本人绑定设备一律 404。
- ✅ 本节已实现（2026-08-16）：Mock 设备订阅 cmd 并自动回执（`MOCK_CMD_RESULT=success|failed|silent` 三态可演示）。

## 9. 媒体

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /media/{mediaId}/url | 换取**有时效**预签名 URL：`{ url, expiresAt }`（**✅ 时效定稿 10 分钟**，env `MEDIA_URL_TTL_SECONDS` 可调）；归属校验：仅设备当前绑定用户可取，非本人一律 404 |

- 媒体元数据随 `video_ready` 事件入库（EVENTS.md 4.9），幂等：同 eventId 或同 (deviceId, videoId) 只登记一条。
- `storageKey` 缺失（上云路径 ⏸️ MVP 后定，DEVICE_PROTOCOL §10 E-17）时 status=`pending_upload`，换 URL 返回 409 `MEDIA_NOT_READY`（错误码只增）。
- §6 事件详情的 `media` 数组：危险/摔倒事件按 `relatedEventId` 反查，video_ready 事件带自身条目。
- ✅ 本节已实现（2026-08-16）：StorageProvider 薄接口 + Mock 实现（本地假 URL）。**2026-09-16 接入腾讯云 COS**（`TencentCosProvider`，env 齐全即切换，否则 Mock），返回的 `url` 为私有桶对象的签名 GET 链接，过期后 COS 侧返回 403；响应结构 `{ url, expiresAt }` 不变。

## 10. Admin API（/api/v1/admin/*，独立角色守卫）

MVP 实用为主，全部只读 + 少量运维操作。

**Admin 认证口径（✅ 已定稿并实现，2026-08-15）**：管理员与 App 用户是两套完全独立的体系（独立 `admin_users` 表 + 独立 JWT 签名密钥 `ADMIN_JWT_SECRET`）。密钥隔离使 admin token 与用户 token 互不可用（双向 401）。**admin accessToken 12 小时，无 refresh**，过期重新登录。管理员账号由脚本创建（`npm run create:admin -w backend`），不做自助注册；管理后台不对公网匿名开放。

### 10.1 已实现（✅ Week 3–4 Admin 基础）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /admin/auth/login | body：`{ username, password }` → `{ admin: { id, username }, accessToken }`。失败统一 401 UNAUTHORIZED（不区分账号不存在与密码错误） |
| GET | /admin/users?page=&pageSize=&keyword= | 用户列表/搜索（keyword 匹配 phone/nickname）。item：`{ id, phone, nickname, avatarUrl, createdAt, deviceCount }`；**已注销账号默认不列出、`includeDeleted=true` 时列出并带 `deletedAt`；`stats/overview.userTotal` 只计未注销账号**（口径 2026-09-15，审计 ADMIN-04；记录保留供事故归属与审计） |
| GET | /admin/devices?page=&pageSize=&keyword=&online= | 设备列表（keyword 匹配 deviceId/绑定手机号；`online=true|false` 按 90s 心跳窗口筛选，口径与 §4 status 一致）。item：`{ deviceId, online, lastSeenAt, battery, charging, signalLevel, sleeping, firmwareVersion, boundAt, createdAt, bindUser: { id, phone, nickname } | null }` |
| GET | /admin/accidents?status=&deviceId=&page=&pageSize= | 事故/SOS 记录（✅ 2026-08-16，Week 7–8）：`status=pending\|notified\|cancelled`、deviceId 精确筛；item = AccidentListItem + `user: { id, phone, nickname } \| null`（TS 类型 AdminAccidentRow），最新在前 |
| GET | /admin/events?type=&deviceId=&from=&to=&invalid=&page=&pageSize= | 全量事件查询（✅ 2026-08-16）：默认排除校验失败留档，`invalid=true` 切换到 `_invalid` 视图（**不设独立端点，定稿**）；Admin 是排查工具，item 带业务接口不可见的 `source`/`clockSkew` 与原样 `payload`（TS 类型 AdminEventRow），按接收时间最新在前 |
| GET | /admin/devices/{deviceId} | 设备详情 + 最近 10 条事件（含 `_invalid`，排查用）+ 当前生效设置（✅ 2026-08-16，TS 类型 AdminDeviceDetail）；不存在 404 |
| GET | /admin/stats/overview | 概览（✅ **指标集定稿 2026-08-16**，TS 类型 AdminStatsOverview）：`{ deviceTotal, deviceOnline, userTotal, todayEvents, activeSos, generatedAt }`——「今日」按 **UTC+8 自然日**、事件数不含 `_invalid`；指标只增不改 |

分页响应用 §1 统一结构 `{ items, total, page, pageSize }`。

### 10.2 规划中

（§10.2 原有条目已全部实现并移入 §10.1，2026-08-16。）

## 11. WebSocket（App 实时通道）

- 端点：`/ws?token=<accessToken>`（✅ 定稿：**原生 ws**，决策 #25；token 走查询参数——RN/浏览器原生 WebSocket 无法可靠设置 header）；鉴权失败以关闭码 **4401** 断开；连接在 accessToken 的 `exp` 到期时也以 4401 断开（连接不比凭证活得久），App 刷新 token 后重连。
- 连接后服务端自动按“当前用户绑定的设备”推送，无需客户端订阅指令（MVP 简化）；data 内带 `deviceId` 区分多设备。
- 消息统一格式（TS 类型见 `@helmet/shared` WsMessage）：

```json
{ "type": "sos_update", "data": { }, "sentAt": "2026-08-14T03:00:00Z" }
```

| type | data | 触发 |
|------|------|------|
| device_status | §4 status 对象 | device_status 事件 / 在线状态变化 |
| location_update | §5 location 对象 | location_update 事件 |
| sos_update | §7 sos 对象 | SOS 创建/取消/确认/超时通知 |
| risk_event | §6 event 详情对象 | collision_risk / obstacle_risk / risk_cleared |
| device_event | §6 event 列表项 | 其余事件（sleep_*、bluetooth_lost、video_ready） |
| device_command | `{ deviceId, commandId, type, params, issuedAt }` | ① 新命令创建（§8 下发）时实时推送；② **连接建立时补推**该用户绑定设备所有 `status ∈ {pending, delivered}` 的命令（BLE 下行通道，决策 #36） |

- WebSocket 是加速通道不是可靠通道：App 重连后须用 REST 拉取兜底；SOS 兜底靠 Push（deadline 持久化在服务端）。
- **device_command 的连接补推不违反「不补发」口径**：这是持久化命令的状态同步（commandId 幂等，App/头盔重复收到不重复执行），不是历史事件重放。补推含 `delivered` 是因为 delivered=PUBACK 只证明送达 Broker（口径 #27④）——蓝牙版设备不在 MQTT 上，PUBACK 照样成功，若只补推 pending 则蓝牙版 App 上线永远收不到已 PUBACK 的命令。`offline` 的命令不补推（用户可能已重发），REST 兜底可查。
- ✅ 实现状态（2026-08-16）：通道 + 全部五类推送均已实现（`device_status` / `location_update` / `sos_update` / `risk_event` / `device_event`）；`device_command` + relay-ack（决策 #36）已实现（2026-08-25，e2e 12 场景 + Mock 中转实测四场景通过）。

## 12. Ingest Webhook（云端算法服务 → 后端）

- `POST /api/v1/ingest/webhook`；请求体 = EVENTS.md §1 envelope。
- 鉴权：`X-Api-Key: <key>`（服务端环境变量配置 ⚠️ 若算法服务方有既定签名方案则从其约定）。
- 响应：`202 { "eventId": "...", "duplicate": false, "invalid": false }`；幂等重复返回 `duplicate: true` 同样 202；校验失败按 Ingest 层规则**留档不报错**，返回 `invalid: true`（eventId 尽力回传，无法解析时为 null）——算法服务侧无需实现重试/错误分支。
- ✅ 本节已实现（2026-08-25）：`X-Api-Key` 对 `INGEST_WEBHOOK_API_KEY` 环境变量比对，未配置时入口拒绝所有请求（fail-closed）。
- 本入口与 MQTT 入口在统一 Ingest 层汇合，业务模块不感知来源。

### 12.1 App 中转入口（蓝牙版，✅ Contract 定稿 2026-08-16，决策 #31；实现随蓝牙版排期）

- `POST /api/v1/ingest/app-relay`——蓝牙版头盔的数据经手机 App 中转模块提交云端的唯一入口。
- 鉴权：**用户 JWT**（App 已登录态）；服务端校验 `deviceId` 必须绑定于当前用户，非本人一律 404 `DEVICE_NOT_FOUND`（与 §4 同口径）。
- 请求体（支持断线补传的批量提交）：

```json
{ "deviceId": "helmet_001", "envelopes": [ { EVENTS.md §1 envelope }, ... ] }
```

- 单批上限 **100 条**；每条 envelope 的 `deviceId` 必须与外层一致（不一致该条按校验失败留档）；事件类型限蓝牙版范围（DEVICE_PROTOCOL §1.1 的 7 种，超范围按未知类型留档告警）。
- 响应：`202 { "accepted": n, "duplicate": n, "invalid": n }`——重复（eventId 已存在）与校验失败都不报错，App 补传无需关心哪些已传过。
- 进**统一 Ingest 层**（同校验、同幂等、同业务分发）；`source=app_relay` 仅排查可见，业务模块不感知。
- ✅ 本节已实现（2026-08-16）：中转的 possible_fall 照常触发 SOS 状态机、location_update 照常入轨迹表——蓝牙版与 4G 版在业务层完全等价。

## 13. 网络对讲（App + RTC，决策 #20/#21/#22）

语音走腾讯 TRTC（App 端 SDK 直连 RTC 云），后端只做**频道管理 + 房间凭证签发**，不自研语音、不经手音频流。频道模型（✅ 口径 2026-08-16 定稿，决策 #27⑤）：**6 位数字邀请码加入、TRTC 房间号 = 频道数字 roomId、成员上限 20**（`VOICE_CHANNEL_MEMBER_LIMIT` 可调）。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /voice/channels | 建频道。body：`{ name }` → channel 对象（创建者自动入频道） |
| GET | /voice/channels | 我加入的频道列表 |
| POST | /voice/channels/join | body：`{ inviteCode }`；邀请码错误 404；满员 409 `CHANNEL_FULL`；重复加入幂等返回频道 |
| DELETE | /voice/channels/{channelId}/membership | 退出频道（非成员 404；频道保留，MVP 不做解散/回收） |
| GET | /voice/channels/{channelId}/members | 成员列表（仅成员可见）：`{ userId, nickname, avatarUrl, phone, joinedAt }`（**手机号脱敏**；avatarUrl 同频道成员互相可见,2026-08-17；TS 类型 VoiceChannelMemberPublic） |
| POST | /voice/channels/{channelId}/token | 进房凭证（仅成员）：`{ sdkAppId, userId, roomId, userSig, expiresAt }`；TRTC 未配置时 503 `TRTC_NOT_CONFIGURED` |

`channel` 对象（TS 类型见 `@helmet/shared` VoiceChannel）：`{ channelId, name, roomId, inviteCode, ownerId, memberCount, createdAt }`。

- **UserSig 由服务端签发**（官方 TLS-Sig-API-v2 HMAC-SHA256 算法自实现，不引 SDK 依赖，决策 #27⑥）；`TRTC_SDK_APP_ID` / `TRTC_SECRET_KEY` 走 env（当前个人测试应用，公司资质就绪后换正式 Key 零代码改动）；有效期 `TRTC_SIG_EXPIRE_SECONDS`（默认 24h）。
- App 端：拿 token 用 TRTC SDK 进房（roomId）+ PTT 推流；蓝牙耳机路由等音频行为在 App 端处理（Week 2 Spike 已验证）。
- ✅ 本节已实现（2026-08-16）。

## 14. 待定稿清单汇总

**负责人**：注册凭据形式与验证码要求、位置分享是否需要网页版、Admin 概览指标集。（~~紧急联系人上限~~ 已定稿 5 个，2026-08-16）
**硬件团队**：绑定二维码印制载体（格式已定 DEVICE_PROTOCOL §11）；⏸️ 媒体上云路径（MVP 后）。（~~设置参数清单~~ 已定稿 2026-09-19，决策 #43；~~bindCode 来源~~ = 软件签发，`provision:batch` 按台出表。）
**软件侧内部**：token 有效期、轨迹单次查询范围上限、WebSocket 实现选型。（~~active SOS 空响应形式~~ 200 + null；~~预签名 URL 时效~~ 10 分钟；~~原始事件 Admin 端点形式~~ 合并单端点 + invalid 筛选——均已定稿 2026-08-16。）
