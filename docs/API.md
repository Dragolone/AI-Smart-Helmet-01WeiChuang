# API.md — REST / WebSocket API Contract（App / Admin ↔ Backend）

> 状态：**初稿（待双人 Review + 负责人确认后定稿）**。已实现部分（§1/§2/§4/§10）的 DTO 已在 `packages/shared` 落为 TS 类型（2026-08-15）；本文件变更时必须同步 `@helmet/shared`。
> 破坏性变更流程见 CLAUDE.md「API Rules」：先改本文件 + shared 并确认，再改实现；后端先合并并对旧字段保持一版兼容。
> 标记：✅ 已定 ｜ ⚠️ 待定稿。

## 1. 通用约定（✅）

- Base URL：`/api/v1`；管理后台 `/api/v1/admin/*`（独立权限守卫）。
- 认证：`Authorization: Bearer <accessToken>`（JWT）。设备侧认证走 MQTT（DEVICE_PROTOCOL §3），不在本文件。
- 时间：一律 ISO 8601 UTC 字符串（如 `2026-08-14T03:00:00Z`）；展示层转本地时区。查询参数里的时间带时间部分时必须带显式时区（`Z` / `±hh:mm`；日期与时间之间用空格的写法同样要求，2026-10-17），缺时区 400（2026-10-17：原来按服务器进程时区解析）；只有日期（`2026-10-01`）按 UTC 零点。
- 业务主键：UUID v7 / cuid；设备用硬件团队的 `deviceId`。
- **请求头 `X-Client-Timezone`（可选，2026-10-22，O13）**：手机当前时区的 IANA 名（如 `Asia/Shanghai`、`Australia/Sydney`），App 每个请求都带（A 线 #366）。带了且合法（≤ 64 字符、`[A-Za-z0-9_+-/]`、运行环境认得）时，需登录的接口在值变化时把它记为该用户的时区；推送正文里的时间按它写当地时间，没有记录时写明「北京时间」（§7）。不合法、没带、带了多个都忽略，不报错、不清掉已记的值；注销时清空。不影响任何接口的入参出参（时间字段仍一律 UTC）。
- 分页：`?page=1&pageSize=20`（page 1–2147483647，超出 400 VALIDATION_FAILED（2026-10-16 #202）；pageSize 默认 20，最大 100）→ 响应 `{ "items": [...], "total": 0, "page": 1, "pageSize": 20 }`。
- **应答缓存（2026-10-22，上线清单 B 线 22）**：所有接口应答一律带 `Cache-Control: no-store`（含 400 / 401 / 404 等错误应答）。安卓 RN 的 OkHttp 带磁盘缓存，手机时间往回拨后会把旧应答当新鲜用（倒计时页拿到过期的求救状态）；App 端 #381 已在请求上带 no-store，服务端这一半让没带那个头的旧包、浏览器（管理后台）、第三方也不缓存。
- 统一错误格式：

```json
{ "code": "DEVICE_NOT_FOUND", "message": "human readable", "requestId": "req_..." }
```

客户端只依赖 `code` 不依赖 `message`。**错误码只增不改**。**可选 `details`（2026-10-22）**：个别错误码带一个结构化补充对象，客户端按 code 决定读哪些键——目前 `CHANNEL_FULL` / `CHANNEL_LIMIT_REACHED` / `EMERGENCY_CONTACT_LIMIT_REACHED` 带 `{ "limit": <上限> }`，App 文案里的数字以它为准，不再写死（TS 类型 `ApiErrorBody.details`）。

### 1.1 通用错误码（首批，✅）

| code | HTTP | 场景 |
|------|------|------|
| VALIDATION_FAILED | 400 | 请求体/参数校验失败（含任何字段带 NUL `\u0000`，PostgreSQL 不接受；设备入口 `/ingest/*` 例外——脏 envelope 留档为 invalid 不整批拒绝）。**请求体 JSON 嵌套超过 2000 层一律 400，设备入口也整批 400**（2026-10-16 #202：否则校验管道递归栈溢出成 500，公开接口不带令牌也能打） |
| UNAUTHORIZED | 401 | 未登录或 token 无效/过期 |
| ACCOUNT_DELETED | 401 | 账号已注销（2026-10-22，O15；原来同为 `UNAUTHORIZED`）：注销后残留的 access token 访问任何需登录接口、拿注销前的 refresh token 刷新，都回这个码。App 据此提示「账号已注销」，不再说成「登录已失效，密码可能已在别处修改」。HTTP 状态仍是 401，按 401 走的静默刷新 / 登出流程不变；登录接口不用它（号码已释放，与「手机号或密码错误」不区分） |
| FORBIDDEN | 403 | 无权访问该资源（含资源归属校验失败、非 Admin 访问 Admin API） |
| NOT_FOUND | 404 | 通用资源不存在 |
| DEVICE_NOT_FOUND | 404 | 设备不存在或未绑定到当前用户 |
| CONFLICT | 409 | 通用冲突 |
| DEVICE_ALREADY_BOUND | 409 | 设备已被绑定 |
| PHONE_ALREADY_REGISTERED | 409 | 注册/换绑手机号已存在 |
| PASSWORD_INCORRECT | 400 | 已登录用户提交的当前密码不正确（修改密码 / 注销账号） |
| BIND_CODE_INVALID | 403 | 设备绑定码不正确 |
| PAYLOAD_TOO_LARGE | 413 | 请求体超过 100KB（body-parser 上限；头像 data URI 上限 90KB） |
| RATE_LIMITED | 429 | 触发限流（公开认证接口与设备绑定按 IP / IP+手机号，响应带 `Retry-After` 秒数；规则见 §2） |
| INTERNAL_ERROR | 500 | 服务端异常（带 requestId 供排查） |
| SERVICE_UNAVAILABLE | 503 | 统一过滤器对 503 类异常的兜底码；各业务 503 有自己的码（见下表） |

各节自有错误码索引（客户端文案按 code 映射，全部列在此便于对表；详情见各节）：

| code | HTTP | 节 |
|------|------|----|
| SMS_CODE_INVALID / SMS_CODE_TOO_FREQUENT / SMS_CODE_DAILY_LIMIT / SMS_SEND_FAILED / PHONE_NOT_REGISTERED | 400 / 429 / 429 / 503 / 404 | §2 |
| EMERGENCY_CONTACT_LIMIT_REACHED / CONTACT_IS_SELF / CONTACT_DUPLICATE | 409 / 400 / 409 | §3 |
| SOS_IN_PROGRESS | 409 | §2（注销账号时还有进行中的求救） |
| SOS_ALREADY_FINALIZED | 409 | §7 |
| MEDIA_NOT_READY | 409 | §9 |
| CHANNEL_FULL / CHANNEL_LIMIT_REACHED / TRTC_NOT_CONFIGURED | 409 / 409 / 503 | §13 |

## 1.2 健康检查（✅ 已实现）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 服务与数据库连通性：`200 { "status": "ok", "database": "connected" }`；数据库不可达时 `503 { "status": "error", "database": "unreachable" }`；进程收到 SIGTERM 后的排空期（默认 3s，`SHUTDOWN_DRAIN_MS`）返回 `503 { "status": "draining", "database": "connected" }`——网关/拨测据此摘流量，在途请求照常完成。无需认证，供负载均衡/运维探活 |

## 2. 认证与用户

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /auth/sms-code | 下发短信验证码（✅ 2026-09-09 负责人拍板：注册必须验证码）。body：`{ phone, purpose: "register" \| "reset_password" \| "change_phone" }` → 204。规则：6 位数字、**5 分钟有效、一次性、连续错 5 次作废**；同号同用途 **60s 内重发 → 429 `SMS_CODE_TOO_FREQUENT`**，**每号每日 10 条（按号码合计、不分用途，2026-10-14 定）→ 429 `SMS_CODE_DAILY_LIMIT`**；`register` 用途下手机号已注册 → 409 `PHONE_ALREADY_REGISTERED`；`reset_password` 用途下未注册 → 404 `PHONE_NOT_REGISTERED`；**`change_phone` 用途（✅ 2026-09-11）：`phone` 为待换绑的新号**，已注册 → 409 `PHONE_ALREADY_REGISTERED`；短信通道失败或超时（`SMS_SEND_TIMEOUT_MS`，默认 10s）→ 503 `SMS_SEND_FAILED`（不计入限频）。同号同用途并发发码只放行一条（服务端事务内串行化）。库中只存验证码哈希 |
| POST | /auth/register | 注册。body：`{ phone, code, password, nickname? }`——`code` 为上一步 `register` 用途的验证码；错误/过期/已用/超次统一 400 `SMS_CODE_INVALID`（不区分原因）。校验顺序：手机号已注册 409 → 验证码 400 → 建号并返回 `{ accessToken, refreshToken, user }` |
| POST | /auth/reset-password | 找回密码。body：`{ phone, code, newPassword }`（`reset_password` 用途验证码）→ 204；成功后**该用户全部 refresh token 作废**，所有设备需重新登录。未注册 404 `PHONE_NOT_REGISTERED` |
| POST | /auth/login | 登录。body：`{ phone, password }` → `{ accessToken, refreshToken, user }`。密码 8–72 字符且 ≤ 72 字节（bcrypt 上限，超出 400） |
| POST | /auth/refresh | body：`{ refreshToken }` → 新 `{ accessToken, refreshToken }`（refresh 轮换，旧 refreshToken 作废；同一 token 并发刷新只有一方成功，其余 401。**已轮换的 token 再次出现**：0.5s 内（同一瞬间的并发竞态）401；0.5s–15min 内视为「上次应答没送到」——补发一对新的，替代它的那张新 token 不作废（服务端分不清手机拿到的是哪张：超时后的重试先到、原请求晚到时手机拿的正是替代者，作废它等于把手机登出；2026-10-21 起），每张旧 token 只补发一次（补发后它不再有替代者，再出现一律 401）；替代者已经用过则不补发（2026-10-06，评审 R-05；同日并发评审 #2 把并发窗口从 10s 缩到 0.5s，App 单飞刷新，一秒后同 token 再现只可能是应答丢失）；超过 15min 才视为盗用、撤销全部会话。轮换的三步（作废旧、签发新、记替代）在一个事务里。登出 / 改密作废的 token 没有替代者，任何时候再出现都是 401） |

限频（2026-09-10 加固，单实例内存滑动窗口，超限 429 `RATE_LIMITED` + `Retry-After`）：`/auth/login` 同 IP+手机号 10 次/分、同 IP 100 次/分；`/auth/sms-code` 同 IP 5 条/分、50 条/天（同号 60s/日限另计）；`/auth/register` 20 次/分；`/auth/reset-password` 同 IP+手机号 10 次/分；`/auth/refresh` 60 次/分；`/admin/auth/login` 10 次/分；`/devices/bind` 同 IP 10 次/分（2026-10-03：绑定码 8 位数字可被穷举，限的是尝试次数，窗口内猜中也返回 429）。
| POST | /auth/logout | 作废当前 refreshToken。带来的若是轮换前的旧 token（refresh 应答丢了），沿替代关系把这台设备现役的那张一并作废，旧 token 也不能再补发（2026-10-17） |
| POST | /auth/change-password | 修改密码（✅ 2026-09-11，**需登录**）。body：`{ oldPassword, newPassword, refreshToken? }` → 204。旧密码错误 → 400 `PASSWORD_INCORRECT`；`newPassword` 与注册同规则（8–72）。成功后**撤销该用户其他全部 refresh token**；带上当前设备的 `refreshToken`（须属于本人）则该会话保留，本设备免重新登录 |
| POST | /auth/change-phone | 换绑手机号（✅ 2026-09-11，**需登录**）。body：`{ newPhone, code, password }`（`code` 为 `change_phone` 用途、发往 `newPhone` 的验证码；`password` 为当前密码——持有会话不等于本人，与改密 / 注销同口径，2026-10-14 加）→ 200 返回更新后的 `user` 对象。校验顺序：密码错误 400 `PASSWORD_INCORRECT`（不消费验证码）→ `newPhone` 已注册 409 `PHONE_ALREADY_REGISTERED` → 验证码错误/过期/已用 400 `SMS_CODE_INVALID` → 改号。会话不受影响；原号即刻释放可供他人注册 |
| GET | /users/me | 当前用户信息；已注销账号的残留 access token → 401 `ACCOUNT_DELETED`（2026-10-22 起；原为 `UNAUTHORIZED`） |
| PATCH | /users/me | 更新昵称/头像等非敏感字段 |
| DELETE | /users/me | 注销账号（✅ 2026-09-11，**需登录**；App Store 要求应用内可注销）。body：`{ password }` → 204；密码错误 → 400 `PASSWORD_INCORRECT`；**本账号还有进行中的求救 → 409 `SOS_IN_PROGRESS`，什么都不改**（2026-10-22，O15：注销会删光紧急联系人，单子到点照常变「已通知」却一条短信都发不出去。按建单时固化的用户算，头盔已解绑的单也算，与 §7 `GET /users/me/sos/active` 同口径；App 先查进行中的求救、有就拦，这里是服务端兜底。注销与建单并发时两边串行：建单先提交则注销 409，注销先提交则那次摔倒 / 求救只留档不建单）。校验顺序：密码 → 进行中的求救。**软删除**（`users.deleted_at`），一个事务内完成：置 `deletedAt`、`phone` 改写为 `deleted:<userId>`（**原手机号不保留**，即刻可重新注册为全新账号）、清空 `avatarUrl`、撤销全部 refresh token、解绑名下全部设备（与 `DELETE /devices/{deviceId}/binding` 同口径，设备与历史事件留档）、软删除全部紧急联系人、**退出全部对讲频道（释放名额，频道本身保留；2026-09-14 审计 VOICE-02 补）**，并**主动以 4401 断开该账号已建立的 WebSocket 连接**（2026-09-14 审计 AUTH-05/INGEST-04 补）。事故记录/事件/轨迹按设备留档不动；**昵称保留**（Admin 按昵称找已注销账号做事故归属，ADMIN-04；隐私政策只承诺清手机号与头像，2026-10-14 定）。已注销用户：login 401 `UNAUTHORIZED`（号已改写）、refresh 401 `ACCOUNT_DELETED`（服务端先校验 `deletedAt`，再看 token 是否已撤销）；**JWT 守卫验签后查 `deleted_at`（✅ 2026-09-12 上线前探针修复）**——注销后残留的 access token 在全部 REST 接口上立即 401 `ACCOUNT_DELETED`、WS 连接 4401（关闭原因「账号已注销」；App 收到 4401 去刷新，从 refresh 的 `ACCOUNT_DELETED` 得知是注销），不能再绑设备、建联系人、改资料 |

**名字类字段入库前整理**（昵称、头盔名、联系人名、频道名；2026-10-16，10-16 夜测 N1 / N6）：去掉看不见的字符（零宽空格 / 零宽不连字、方向控制符、BOM、控制符等；表情组合用的零宽连接符与变体选择符保留），换行、制表等连续空白压成一个空格，去首尾空白——与 App 显示同一规则（`backend/src/common/display-name.ts` ↔ `app/src/services/safety-status.ts` `cleanHelmetName`）。长度上限按整理后的名字算。整理完为空：昵称存 null、头盔名等于清除、联系人名 / 频道名 400 VALIDATION_FAILED。

`user` 对象：`{ id, phone, nickname, avatarUrl?, createdAt }`。密码 bcrypt/argon2 存储，任何接口不回传。

Token 有效期（✅ 已定稿并实现，2026-08-15）：**access 15 分钟 / refresh 30 天**；refresh 轮换制——每次刷新旧 token 作废；已作废 token 再出现：0.5s 内并发竞态只拒本次、15min 内按应答丢失补发一次（替代者保留）、之后再出现的已轮换 token 视为盗用撤销该用户全部会话（补发过的那张旧 token 已没有替代者，只 401）（§2 refresh 行）。本节 register/login/refresh/logout 与 /users/me 均已实现；**短信验证码（sms-code / register.code / reset-password）2026-09-09 实现**；**账号与安全（change-password / change-phone / DELETE /users/me，✅ 2026-09-11 负责人拍板）已实现**，TS 类型见 `@helmet/shared` ChangePasswordRequest / ChangePhoneRequest / DeleteAccountRequest。本地与演示环境短信走 Console Mock，验证码打印在后端日志（`[MOCK SMS] … verify_code`），云端查看：`docker compose -f docker-compose.prod.yml logs backend | grep verify_code`；腾讯云通道配齐 `TENCENT_SMS_*` 六项环境变量即切换为真发（THIRD_PARTY.md §4）。

## 3. 紧急联系人

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /users/me/emergency-contacts | 列表（按创建先后排序） |
| POST | /users/me/emergency-contacts | body：`{ name, phone, relation? }`；超上限 → 409 `EMERGENCY_CONTACT_LIMIT_REACHED`（`details.limit` = 5）；**phone 是本人手机号 → 400 `CONTACT_IS_SELF`；与本人另一个未删联系人同号 → 409 `CONTACT_DUPLICATE`**（2026-10-22，B 线 23；已删的不算重复） |
| PATCH | /users/me/emergency-contacts/{contactId} | 更新（name/phone/relation 任意子集）；改 phone 时同样校验本人 / 重复（不算自己这条） |
| DELETE | /users/me/emergency-contacts/{contactId} | 删除（软删除，释放名额；历史 SOS 通知记录留档不受影响） |

`contact` 对象：`{ id, name, phone, relation: string|null, createdAt }`（TS 类型见 `@helmet/shared` EmergencyContact）。SOS 通知（SMS）发送对象即此列表。

- **上限 5 个（✅ 定稿 2026-08-16）**：按活跃（未删）联系人计数。
- phone 校验与注册同口径（大陆手机号）；对他人/已删联系人的改删一律 404（不泄露存在性）。
- ✅ 本节已实现（2026-08-16）。

## 4. 设备

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /devices/bind | 绑定。body：`{ deviceId, bindCode }`（deviceId 不分大小写：查不到时按小写再查，出厂编号一律小写，2026-10-17）（✅ 绑定凭证 = 出厂 8 位绑定码 + 绑定二维码，格式 DEVICE_PROTOCOL §11、由 `provision:batch` 产出；⚠️ 印制载体待硬件确认；Mock 设备用注册时生成的 bindCode 走同一流程） |
| GET | /devices | 我的设备列表 |
| GET | /devices/{deviceId} | 设备详情（含实时状态快照） |
| PATCH | /devices/{deviceId} | 重命名（2026-08-17）。body：`{ name?: string \| null }`（整理后 ≤20 字符，整理后空串或 null = 清除，App 回退显示 deviceId；**不传 name = 不改**，2026-10-16 B7——原来空对象也会清名）；返回更新后的 device 对象 |
| DELETE | /devices/{deviceId}/binding | 解绑（软删除绑定关系，设备数据留档；关闭当前这段绑定历史） |

绑定历史与可见范围（✅ 2026-09-10 负责人拍板，决策 #39）：每次绑定/解绑记一段区间（`device_bindings`）。§5 轨迹、§6 事件、§9 媒体只返回**当前用户在该设备上的绑定区间内**到达（服务端 `receivedAt`）的数据——换绑后新主看不到前主期间的数据；同一用户解绑再绑回同一台头盔，之前的记录仍然可见。§7 事故记录按建单时的 userId 固化，不受影响；Admin 全量可见。
| GET | /devices/{deviceId}/status | 设备状态：`{ online, lastSeenAt, battery, charging?, signalLevel?, sleeping, firmwareVersion }` |
| GET | /devices/{deviceId}/battery-history?hours=24 | 电量历史（✅ 2026-09-10）：`{ from, to, points: [{ timestamp, battery, charging }] }`。数据源=raw_events 的 `device_status` 心跳，按 **10 分钟桶取桶内最后一条**（24h ≤ 144 点）；`battery` 不是 0–100 整数的心跳按缺失跳过（与设备快照同口径，2026-10-03——不再把 255 这类越界值截成 100% 画出来）；`hours` 1–168 默认 24；仅本人设备（否则 404）。App 设备详情页据此画 24h 电量曲线（替代原大电量条）；**只返回本人绑定区间内（服务端 receivedAt）到达的心跳**（决策 #39 同口径，2026-09-14 审计 AUTH-06 补） |

device 对象补充字段（2026-08-17，TS 类型见 `@helmet/shared` DevicePublic）：`name`（用户自定义名，null 时 App 显示 deviceId；**解绑时清空**，2026-10-14——下一位主人不会看到上一位起的名字）、`bindCode`（仅经归属校验的端点返回——本人可见，供详情页展示）。

- MVP 绑定关系：一台设备同时只能绑定一个用户；一个用户可绑多台。⚠️ 家庭共享/多人查看不在 MVP。
- `online` 判定规则见 DEVICE_PROTOCOL §5，由服务端计算（lastSeenAt 距今 ≤ 90s），App 不自行判断。
- ✅ 本节已实现（2026-08-15）：bind / 列表 / 详情 / 解绑 / status；设备开通用 `npm run provision:device -w backend`（生成 deviceId+deviceSecret+bindCode，Mock 与真机同机制）；绑定码 MVP 为 8 位数字（随附形式 = 二维码 + 说明卡，印制待硬件确认，DEVICE_PROTOCOL §10 C-12）。

## 5. 位置与轨迹

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/locations/latest | 最新位置：`200 { "location": <location 对象> \| null }`（设备存在但尚无数据时为 null，✅ 定稿）。设备时钟跑到未来的点（`timestamp` 超过服务器当前时间 5 分钟以上，DEVICE_PROTOCOL §8 的偏移阈值）不参与「最新」判定——否则一条错误时间的点会永久排在最前；该点照常留档，按时间范围仍可查到（2026-10-03） |
| GET | /devices/{deviceId}/locations?from=&to=&page=&pageSize= | 历史轨迹（from/to 必填 ISO 8601；**单次范围上限 24h，✅ 定稿**；按 timestamp 升序；统一分页结构） |
| GET | /devices/{deviceId}/locations/summary?from=&to= | 区间轨迹统计（2026-09-17 A 线新增，App 首页「今日骑行」）：`200 { distanceMeters, movingSeconds, maxSpeed（只取 ≤ 55 m/s 的点速，更大的按 GPS 漂移不计，2026-10-17）, pointCount, firstAt, lastAt }`；from/to 规则同上（必填、≤24h）；服务端按相邻点大圆距离累加，间隔 >10 min 的段不桥接、隐含速度 >55 m/s 视为漂移不计；`movingSeconds` 只累计平均速度 ≥0.5 m/s 的段；`maxSpeed` 为设备上报速度最大值（m/s），无点时 maxSpeed/firstAt/lastAt 为 null。TS 类型 `LocationSummaryResponse` |
| GET | /devices/{deviceId}/rides?from=&to= | 行程列表（2026-10-07 A 线新增，App 地图页「行程」；B 线 10-08 Review 通过）：`200 { "rides": [{ startAt, endAt, distanceMeters, movingSeconds, maxSpeed, ongoing }] }`，最新在前；返回**起点**落在 `[from, to)` 内的行程（跨边界的那一趟归到起点所在的区间，App 按月往前翻页时不重不漏）。from/to 必填 ISO 8601、from < to、**单次范围上限 32 天**（够一个自然月；夏令时结束的那个月比 31 天多 1 小时）（服务端为了把跨边界的行程算完整，实际会多取 from 之前 24h、to 之后 48h 的点）。**一趟怎么切**（负责人 2026-10-07 定，展示用的分段，不是骑行状态判断、不触发任何业务流程）：相邻点断档超过 15 分钟，或停住不动超过 15 分钟（相邻点隐含速度 <0.5 m/s，口径同 summary 的 `movingSeconds`），上一趟就结束在最后一个在动的点；里程不足 50 m 的不算一趟。最后一趟若距最后一次在动不超过 15 分钟，`ongoing=true`，此时 `endAt` 是目前收到的最后一个点。**连续不停的超长行程**（真实头盔电量撑不到，常驻的 Mock 设备会这样）：在 `from + n×24h` 这些时刻，一趟若已经连续进行了 23 小时 45 分以上，就在该时刻结束、之后的第一个点起算新的一趟——否则它的起点早已在查询范围之外，当前这页里反而没有它。切点以 `from` 为基准，所以**调用方要固定用同一种对齐方式的 from**（App 一律用本地零点），不同页的结果才对得上；一趟因此最长不到 48 小时。各字段统计口径同 summary。设备时钟跑到未来的点不参与（同 latest）。只读、无表结构变更。TS 类型 `RidesResponse` / `RideSummary` **量级**：服务端一次把范围内（含前后各 1–2 天）的点全部读进内存再切分，一台常驻 Mock 每天约 9 千点、32 天约 28 万点（dev 库 10-08 实测 94 MB 表里 28 万行）仍可承受；真实头盔每天一两千点不成问题。若将来单设备月点数超过约 50 万，再改成按天分块计算。 |
| GET | /devices/{deviceId}/locations/track?from=&to=&maxPoints= | 抽稀轨迹（2026-10-07 A 线新增，App 地图页单趟行程的画线与回放；B 线 10-08 Review 通过）：`200 { points: <location 对象>[], total, summary }`。`points` 按 timestamp 升序，点数超过 `maxPoints`（选填，2–2000，默认 1000）时**等间隔抽稀**，首尾两点一定保留；`total` 是抽稀前的点数；`summary` 与上一行 summary 接口同结构，**用全部点计算**，不受抽稀影响。from/to 规则同上两行（必填、≤24h）。解决的问题：原分页接口每页上限 100，App 拉满 1000 点（运动时 5 秒一点，约 83 分钟）后更长的行程被截断。TS 类型 `TrackResponse` |

`location` 对象（与 EVENTS.md 4.2 对齐，TS 类型见 `@helmet/shared` LocationPoint）：`{ latitude, longitude, coordinateSystem, accuracy, speed, heading, altitude, timestamp, receivedAt }`（altitude 无值为 null——滑雪场景核心维度，设备上报则全链路透传）。

- 坐标系原样返回并带 `coordinateSystem`；是否服务端统一转 gcj02 随地图 Spike 定稿（DECISIONS 待定项）。
- 轨迹查询走服务层（为未来 Retention/降采样留余地），App/Admin 不假设“所有点都在”。
- 位置分享：MVP 用 App 端生成分享内容（坐标 + 高德跳转链接），**不做服务端分享短链** ⚠️ 若产品要求可访问网页版分享再评估。
- ✅ 本节已实现（2026-08-15）：位置由 Ingest 从 location_update 事件写入 location_points 表（仅已注册设备；payload 逐字段校验，不合法只留 raw）；归属校验与 §4 同口径（非本人 404），且 latest/范围查询只含本人绑定区间内的点（决策 #39）。

## 6. 事件查询（危险事件 / 全量事件历史）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/events?type=&from=&to=&page=&pageSize= | 事件历史（最新在前）；**只列 EVENTS.md §3 已知类型且 schemaVersion 受支持的事件**——未知类型 / 未知版本只留档、不进业务流程，App 查不到（列表与 `GET /events/{eventId}` 同口径，后者 404；Admin 事件查询不受影响；2026-10-16 #202）；`type` 可多值逗号分隔（取值 = EVENTS.md §3 eventType，未知值 400）；from/to 均选填（事件量级低，不设 §5 的 24h 上限），同给时须 from < to |
| GET | /events/{eventId} | 事件详情（含原始 payload、关联媒体） |

`event` 列表项（TS 类型见 `@helmet/shared` EventListItem）：`{ eventId, deviceId, eventType, timestamp, deviceTimestamp, receivedAt, summary }`；详情（EventDetail）追加 `payload`（原样）与 `media: [{ mediaId, status, duration }]`。

- **`timestamp` 是业务时间（决策 #59，2026-10-17）**：设备时钟可信时就是设备上报的时间；设备时间比收到时超前 5 分钟以上、或早 72 小时以上（时钟错乱，DEVICE_PROTOCOL §8）时取收到时间——与 §5 轨迹点的 `timestamp` 同一口径。列表按它倒序（并列按内部 id），`from` / `to` 也按它过滤。**`deviceTimestamp`** 是设备上报的原值（时钟错乱时可能是 1970 / 2099），仅供排查。WS `risk_event` / `device_event` 同口径。Admin 事件接口（§10）不受影响，照旧给设备原值。

- `summary` 为服务端生成的一句话摘要，仅兜底展示；**客户端逻辑不得依赖其内容**（App 有本地化文案时可忽略）。
- 归属口径：设备须**当前绑定**给本人（与 §4/§5 一致），且列表/详情只含本人**绑定区间内**到达的事件（决策 #39，按 receivedAt 判）；校验失败的 `_invalid` 占位事件不出现在任何查询结果。
- 「当前危险状态」由 App 从 WS `risk_event` 事件流推导，服务端不维护实时态（✅ 口径 2026-08-16 定稿，决策 #27）；历史随时可查本节接口。
- ✅ 本节已实现（2026-08-16）：media 数组由 §9 媒体表反查填充（WS `risk_event` 推送时媒体通常尚未上传，实时消息中恒为空，App 用详情接口兜底）。

## 7. SOS / 事故记录

SOS 状态机为服务端权威（DECISIONS #8/#26）：`pending → notified | cancelled`；App 仅渲染。deadline = 服务端接收时间 + 60s（`SOS_COUNTDOWN_SECONDS`），设备时钟不参与。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/sos/active | 当前进行中 SOS：`200 { "sos": <sos 对象> \| null }`（无进行中时为 null，**✅ 定稿**，与 §5 latest 同口径） |
| GET | /users/me/sos/active?page=&pageSize= | **本账号所有进行中的 SOS**（2026-10-17，上线清单 B 线第 12 项；多顶头盔时 App 不必逐台查上一行）：§1 统一分页 `{ items, total, page, pageSize }`，按 deadline 升序（同时到期按 sosId）；item = sos 对象 + `deviceName`（TS 类型 ActiveSosItem）。按建单时固化的用户查：**头盔已解绑、单仍是本人的照样列出**（解绑不影响处置权，上一行此时 404），前主人的单不列，终态不列；已过 deadline 但扫描任务尚未处理的仍是 pending，照样列。`deviceName` 只在头盔仍绑在本人名下且起过名时给（整理后的名字），否则 null。没有时 `items: []`（不是 404）。App 传 `pageSize=100`，多于 100 单按 `total` 翻页。上一行逐台接口保留（旧版 App 用） |
| POST | /sos/{sosId}/cancel | 取消（仅 pending 可取消；终态返回 409 `SOS_ALREADY_FINALIZED`）。**只看状态不看截止时间**（2026-10-22，决策 #63）：截止后、到期扫描（`SOS_SCAN_INTERVAL_MS`，默认 5 s）处理之前发来的取消仍然成功、不发通知——用户本人的明确取消优先于几秒的时序；扫描已终态化的再取消 409，App 拉取最新状态。App 侧口径：倒计时到 0 后写「正在通知…」但取消控件保留到服务端状态变化 |
| POST | /sos/{sosId}/confirm | “SOS Now”：跳过剩余倒计时立即通知。终态化（`notified`）与通知任务一起落库后立即返回，**不等短信 / 推送发完**（2026-10-22，SOS_MATRIX Q7：短信通道慢时响应原来会超过 App 的超时）；首轮投递在后台，没发完的由扫描续投，结果看事故详情 `notifications` |
| GET | /devices/{deviceId}/accidents?page=&pageSize= | 事故记录列表（含已取消供留档，最新在前；TS 类型 AccidentListItem）。换绑后新主看不到旧主的事故（deviceId+userId 双过滤） |
| GET | /accidents/{accidentId} | 事故详情（TS 类型 AccidentDetail）：sos 对象 + `location`（快照，source: event\|last_point）+ `triggerPayload`（触发事件原始 payload）+ `notifications`（通道/状态/重试次数/错误；**target 已脱敏**） |

`sos` 对象（TS 类型见 `@helmet/shared` Sos）：`{ sosId, deviceId, triggerEventId, triggerType: "possible_fall"|"manual_sos", status: "pending"|"notified"|"cancelled", deadline, createdAt, updatedAt, triggeredAt? }`。`triggeredAt`（2026-10-07 新增，可选）= 触发事件 envelope 的 `timestamp`（设备时钟），只供 App 写「约 N 小时前的事件，刚补传到」（决策 #52），不参与任何判定；10-07 之前建的单没有，App 缺省不显示。WS `sos_update`、`/sos/active`、事故列表 / 详情都带。

- App 收到 WebSocket/Push 的 `sos` 对象后按 `deadline` 本地倒计时渲染，不自行计时判断超时。
- 错误码：`SOS_ALREADY_FINALIZED`（409，取消/确认时状态机已终态）；取消/确认权限以**建单时固化的绑定用户**为准，他人操作一律 404（不泄露存在性）。进行中的单按「设备 + 用户」唯一（决策 #40）：换绑后新用户的求救另建新单，前用户的单不受影响。
- **Push 定向口径（2026-09-23，极光）**：服务端按 `alias = 用户 ID` 推送，App 登录成功后向极光 `setAlias(userId)`、退出登录 `deleteAlias`；未登记别名的用户推送记 failed（极光 1011），不影响短信。
- **iOS 推送字段（2026-10-06，评审 R-34 / 真机 10-06）**：「SOS 倒计时已开始」带 `category: "sos"`（App 登录后注册的通知类别，远程推送上因此有「我没事，取消」「查看」按钮，App 被杀时仍有效）与 `interruption-level: time-sensitive`；到期 / 确认后的「SOS 已通知紧急联系人」等只带时效性、不带类别。App 需声明 time-sensitive entitlement（A 线 10-06 已加）。
- **推送 extras（2026-10-22，O12）**：SOS 推送的 extras 都带 `sosId`、`deviceId`（App 点通知据此落到对应页面）；「SOS 倒计时已开始」另带 `kind: "sos_started"`——App 据此认出这一条（单子结束时撤掉它、结果通知留着），不靠标题文字；到期 / 确认后的结果推送不带 `kind`。没有 `kind` 或值不认识时 App 按原来的方式处理（10-22 之前的服务端不带这个字段）。极光 v3 的 `notification.android` 与 `options.third_party_channel` 都没有锁屏可见性字段（10-22 查官方文档）：极光自己显示的那条在系统「隐藏敏感内容」下照样被打码，App 在线时由本地求救提醒（单条设为锁屏公开）顶替并撤掉它；App 被杀、只走厂商通道时服务端控制不了。
- 通知：超时/确认后逐个紧急联系人发 SMS（同号去重）+ 本人 Push，逐条留档（成功/失败/通道/重试次数；**失败按退避重试，连首次最多 5 次，间隔 10 秒 / 1 分钟 / 5 分钟 / 15 分钟，前后约 21 分钟**——决策 #50，`SOS_NOTIFY_MAX_ATTEMPTS` / `SOS_NOTIFY_RETRY_DELAYS_SECONDS` 可调；单次 Provider 调用超时 `SOS_NOTIFY_TIMEOUT_MS` 默认 10s，超时按失败记 `timeout` 走重试；通道自身的超时（腾讯云短信 8 s、极光 `PUSH_SEND_TIMEOUT_MS` 默认 8 s）比它短，免得第 9.9 s 发成功却被记成超时、到点再发一条；同一条通知本进程在发时不会被扫描再占一次，结果只写回这次占位，2026-10-17）；事故位置快照优先取触发事件内嵌位置，回落最新轨迹点（✅ 口径 2026-08-16 定稿）。
- **状态语义（2026-09-14 审计 SOS-04 定稿）**：`status=notified` 只表示「已到期/已确认并创建了通知任务」，**不等于联系人已收到**——实际投递结果以 `GET /accidents/{id}` 的 `notifications[]` 逐条状态为准（`sent` = 服务商已接收，无回执时不代表送达）。本人 Push 正文里的时刻按用户手机时区写（`已于 14:05`），没报过时区的写「已于北京时间 14:05」（2026-10-22，O13；原来一律北京时间不标注）。本人 Push 标题按此刻短信结果生成：全部/部分成功 →「SOS 已通知紧急联系人」；全部失败 →「SOS 紧急联系人通知发送失败」；未设置联系人 →「SOS 未设置紧急联系人」。**重试后补推（2026-10-22，O17）**：本人收到的是「通知发送失败」、之后有短信重试成功时，再推一条「SOS 已在重试后通知紧急联系人」，正文「头盔 X 的求救短信已在重试后发给 N/M 位紧急联系人」（没发全时加「（其余仍在重试）」或「（其余发送失败）」，N 按补推发出时现算）；每单最多一条，部分成功的不补。extras 同结果推送（`sosId` / `deviceId`，不带 `kind`）。补推也是一条本人 push 通知行（重试退避、次数上限同上），所以 `notifications[]` 里可能有两条 push 行。App 文案统一为「已向紧急联系人发出通知」而非「已收到通知」。
- **可靠性兜底（2026-09-14 审计 SOS-01/02/05 修复）**：位置快照查询失败不阻塞建单；建单遇数据库瞬断进程内重试；启动时、以及之后每 `SOS_RECONCILE_INTERVAL_SECONDS`（默认 60）秒，对账最近 `SOS_RECONCILE_WINDOW_MINUTES`（默认 15）分钟内「raw 已落库但无 SOS 单」的摔倒/求救事件并按当时绑定用户补建（周期对账为决策 #51，2026-10-03）。
- **补传的旧事件（决策 #52，2026-10-03）**：摔倒/求救事件无论发生在多久之前，到达服务端时一律照常建单、从到达时刻起倒计时 60 秒并通知联系人；只在给本人的「SOS 倒计时已开始」推送正文里注明「约 X 分钟/小时前的事件，刚补传到」（事件时间早于当前 5 分钟以上、且不超过 72 小时才注明）。`sos` 对象字段不变。
- ✅ 实现状态（2026-08-16）：本节全部端点已实现（active / cancel / confirm / accidents 列表与详情 + 状态机：触发/合并/倒计时/扫描/重启接管/通知重试）。

## 8. 设备设置下发（命令）

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | /devices/{deviceId}/settings | body：`{ settings: { <key>: <值> } }`（扁平键值；**✅ 参数清单定稿 2026-09-19，决策 #43**：14 项，键名/类型/取值范围以 `@helmet/shared` 的 `DEVICE_SETTINGS` 为准，见下表；未知键、类型不符、越界 → `400 VALIDATION_FAILED`，**服务端就拦、不创建命令、不下发**）→ 创建 set_config 命令并双路下发，`202 { commandId, status: "pending" }`（TS 类型 PutSettingsResponse） |
| GET | /devices/{deviceId}/settings | `{ settings, lastCommand }`——settings 为当前生效设置（**只写设备确认过的值：命令 success 回执，或头盔上报的实际值**，决策 #45），lastCommand 为本人最近一次下发（TS 类型 SettingsResponse） |
| POST | /devices/{deviceId}/settings/reported | **头盔实际设置上报（✅ 2026-09-19，决策 #45）**：App 每次 BLE 握手后读回头盔 0x20–0x2D 上报，body `{ settings: { <key>: <值> } }`（≤ 32 键）→ `200 { settings, applied, skipped }`（TS 类型 ReportSettingsRequest / ReportSettingsResponse）。**逐键**校验：清单外、类型不符、越界只跳过该键（`reason: invalid`），不整批拒；**有未完成（pending/delivered）或 30 s 内刚 success 的命令碰过的键跳过**（`reason: recent_command`，以命令为准——App 读到的可能是写入前的旧值）；已判 offline 的命令不保护。不创建命令、不改 lastCommand。归属：非本人 404 DEVICE_NOT_FOUND；结构错误（非对象/空/超 32 键）400 VALIDATION_FAILED |
| GET | /devices/{deviceId}/commands?page=&pageSize= | 命令历史（最新在前，TS 类型 CommandPublic）。**只含本人下发的命令**（2026-10-14，决策 #39 同口径：换绑后新主人看不到上一位主人的设置记录，`GET /commands/{id}` 与 WS 连接补推同此） |
| GET | /commands/{commandId} | 命令状态：`pending → delivered → success \| failed \| offline`（语义见 DEVICE_PROTOCOL §7，**未回执绝不显示成功**） |
| POST | /devices/{deviceId}/commands/{commandId}/relay-ack | **BLE 下行链的回执入口（决策 #36）**：App 替头盔提交命令回执。body：`{ "stage": "delivered" }`（App 已收到命令并写入头盔——蓝牙版的 delivered 语义，对应 4G 版的 PUBACK）或 `{ "stage": "executed", "result": "success" \| "failed", "errorCode"?, "executedAt"? }`（头盔执行结果；executedAt 缺省、不是合法 ISO 8601、或年份不在 1970–9999 内时一律取服务器时间——设备/App 时钟不可信；MQTT cmd_ack 同口径）→ `200 { commandId, status }`（更新后状态）。**幂等不报错**：已终态命令再收 delivered/重复 executed 都返回当前状态；已判 offline 后迟到 executed 如实覆盖（同 MQTT cmd_ack 语义）。鉴权：用户 JWT + 设备归属（非本人 404 DEVICE_NOT_FOUND）+ 命令须属于该设备（否则 404 NOT_FOUND）。信任级与 §12.1 app-relay 一致（App 本就是蓝牙版设备的代理）；**只认本人下发的命令**：换绑后新主人回执前主人下发的命令 404、设置不生效，与列表 / 详情 / 连接补推同口径（2026-10-17） |

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

- 媒体元数据随 `video_ready` 事件入库（EVENTS.md 4.9），幂等：同 (deviceId, eventId) 或同 (deviceId, videoId) 只登记一条（决策 #54）。
- `storageKey` 缺失（上云路径 ⏸️ MVP 后定，DEVICE_PROTOCOL §10 E-17）时 status=`pending_upload`，换 URL 返回 409 `MEDIA_NOT_READY`（错误码只增）。
- §6 事件详情的 `media` 数组：危险/摔倒事件按 `relatedEventId` 反查，video_ready 事件带自身条目。
- ✅ 本节已实现（2026-08-16）：StorageProvider 薄接口 + Mock 实现（本地假 URL）。**2026-09-16 接入腾讯云 COS**（`TencentCosProvider`，env 齐全即切换，否则 Mock），返回的 `url` 为私有桶对象的签名 GET 链接，过期后 COS 侧返回 403；响应结构 `{ url, expiresAt }` 不变。

## 10. Admin API（/api/v1/admin/*，独立角色守卫）

MVP 实用为主，全部只读 + 少量运维操作。

**Admin 认证口径（✅ 已定稿并实现，2026-08-15）**：管理员与 App 用户是两套完全独立的体系（独立 `admin_users` 表 + 独立 JWT 签名密钥 `ADMIN_JWT_SECRET`）。密钥隔离使 admin token 与用户 token 互不可用（双向 401）。**admin accessToken 12 小时，无 refresh**，过期重新登录。token 带密码指纹：管理员被删除或改密（`create:admin --reset`）后旧 token 立即 401，不等 12 小时（2026-10-17）。管理员账号由脚本创建（`npm run create:admin -w backend`），不做自助注册；管理后台不对公网匿名开放。

- admin 守卫只在令牌无效（验签失败、不是 admin 令牌、管理员已删除或已改密）时回 401；查管理员表本身失败（数据库瞬断）回 500，不回 401——后台前端见 401 会清会话跳登录页（2026-10-17）。

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

- 端点：`/ws?token=<accessToken>`（✅ 定稿：**原生 ws**，决策 #25；token 走查询参数——RN/浏览器原生 WebSocket 无法可靠设置 header）；鉴权失败以关闭码 **4401** 断开（用户密钥签的 `typ=admin` token 同样 4401）；验签通过后查注销状态时数据库出错以 **1011** 断开（不是凭证问题，App 走普通退避重连、不刷新 token，2026-10-17）；客户端上行单帧超过 64 KiB 以 **1009** 断开（App 不往上发消息，2026-10-17）；连接在 accessToken 的 `exp` 到期时也以 4401 断开（连接不比凭证活得久），App 刷新 token 后重连。
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
| device_command | `{ deviceId, commandId, type, params, issuedAt }` | ① 新命令创建（§8 下发）时实时推送；② **连接建立时补推**该用户绑定设备上**本人下发的**、`status ∈ {pending, delivered}` 的命令（BLE 下行通道，决策 #36；只推本人的：换绑后上一位主人没执行完的命令不由新主人的 App 写进头盔，2026-10-14） |
| voice_taken_over | `{ channelId, clientId }`（TS 类型 WsVoiceTakenOverData） | 本账号在 `clientId` 那台手机上进了对讲（§13 `/token` 带 `purpose: "enter"`）；发给本账号的全部连接。`clientId` 不是自己、自己正在通话（或已拿到凭证正在进房）的 App 退房并提示「通话已被另一台手机接管」（决策 #62，2026-10-22） |

- WebSocket 是加速通道不是可靠通道：App 重连后须用 REST 拉取兜底；SOS 兜底靠 Push（deadline 持久化在服务端）。
- **服务端发送积压上限 4 MiB**（2026-10-17）：连接不读数据（脚本暂停读取、半开 TCP）导致服务端待发数据超过 4 MiB 时，服务端直接断开该连接（不发关闭帧，客户端看到 1006）。App 按普通断线重连并用 REST 补拉即可；正常读取的连接积压只有 KB 级，不会触发。
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

语音走腾讯 TRTC（App 端 SDK 直连 RTC 云），后端只做**频道管理 + 房间凭证签发**，不自研语音、不经手音频流。频道模型（✅ 口径 2026-08-16 定稿，决策 #27⑤）：**6 位邀请码加入（2026-10-15 决策 #57 起为 2–9 与去掉 I/L/O 的大写字母，输入不区分大小写、O/I/L 视为 0/1/1；此前发出的 6 位数字码继续有效）、TRTC 房间号 = 频道数字 roomId、成员上限 20**（`VOICE_CHANNEL_MEMBER_LIMIT` 可调）。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /voice/channels | 建频道。body：`{ name }`（整理后 1–30 字，全空白 / 只含零宽字符 400）→ channel 对象（创建者自动入频道）；**本账号已加入的频道数到上限 → 409 `CHANNEL_LIMIT_REACHED`**（`details.limit`，默认 20，`VOICE_CHANNELS_PER_USER_LIMIT` 可调；2026-10-22 B 线 23，退出频道即释放） |
| GET | /voice/channels | 我加入的频道列表 |
| POST | /voice/channels/join | body：`{ inviteCode }`（6 位字母 / 数字，不区分大小写；形状不对 400）；邀请码错误 404；满员 409 `CHANNEL_FULL`（`details.limit` = 成员上限）；本账号频道数到上限 409 `CHANNEL_LIMIT_REACHED`；重复加入幂等返回频道；限频每账号每分钟 10 次、同一 IP 每分钟 60 次（决策 #57，超限 429 `RATE_LIMITED`） |
| DELETE | /voice/channels/{channelId}/membership | 退出频道（非成员 404；频道保留，MVP 不做解散/回收） |
| GET | /voice/channels/{channelId}/members | 成员列表（仅成员可见）：`{ userId, nickname, avatarUrl, phone, joinedAt }`（**手机号脱敏**；avatarUrl 同频道成员互相可见,2026-08-17；TS 类型 VoiceChannelMemberPublic） |
| POST | /voice/channels/{channelId}/token | 进房凭证（仅成员）：`{ sdkAppId, userId, roomId, userSig, privateMapKey, expiresAt }`；`privateMapKey` 为**绑定该房间**的权限钥匙（TRTC PrivateMapKey，默认 10 分钟有效 `TRTC_ROOM_KEY_EXPIRE_SECONDS`，App 进房前现取，填 `TRTCParams.privateMapKey`；在房期间每 5 分钟再取一次交给 SDK（决策 #60），离开房间后最多 10 分钟作废；2026-10-14 决策 #56——TRTC 控制台开启「高级权限控制」后不带它进不了房）；TRTC 未配置时 503 `TRTC_NOT_CONFIGURED`。**可选请求体 `{ clientId, purpose }`**（决策 #62，见下文「一个账号只留一台在通话」） |

`channel` 对象（TS 类型见 `@helmet/shared` VoiceChannel）：`{ channelId, name, roomId, inviteCode, ownerId, memberCount, createdAt }`。`roomId` 为服务端随机 10 位数（2026-10-14 决策 #56；原自增号可猜）；`inviteCode` 为服务端生成的 6 位大写字母 / 数字（决策 #57）。

- **UserSig 由服务端签发**（官方 TLS-Sig-API-v2 HMAC-SHA256 算法自实现，不引 SDK 依赖，决策 #27⑥）；`TRTC_SDK_APP_ID` / `TRTC_SECRET_KEY` 走 env（当前个人测试应用，公司资质就绪后换正式 Key 零代码改动）；有效期 `TRTC_SIG_EXPIRE_SECONDS`（默认 24h）。
- App 端：拿 token 用 TRTC SDK 进房（roomId + privateMapKey）+ PTT 推流；蓝牙耳机路由等音频行为在 App 端处理（Week 2 Spike 已验证）。
- **一个账号同一时间只留一台手机在通话**（决策 #62，2026-10-22；REGRESSION 6.14）：同一 TRTC userId 两台同时在房时，TRTC 不移出先进的那台，而是让两台轮流断线重连、互相挤掉，谁都没法说话。`POST /voice/channels/{channelId}/token` 因此多一个**可选**请求体（TS 类型 VoiceTokenRequest）：
  - `clientId`：App 进程启动时随机生成的本机标识，8–64 位字母 / 数字 / `_` / `-`；只用来区分同一账号的几台手机，不落库。
  - `purpose: "enter"`：用户主动进房。服务端记下这台为本账号当前通话的手机，并经 §11 `voice_taken_over` 通知本账号的全部连接；别的手机据此退房。TRTC 未配置（503）等签发失败时不记录、不通知。
  - `purpose: "renew"`：在房续钥匙、断线后自动重进（决策 #60；都是接着这台原来的通话，不能抢别人的——否则通知漏收的那台一重连又把后进的挤掉）。本账号已被另一台手机 `enter` 过时返回 **409 `VOICE_TAKEN_OVER`**，App 按被接管退房——这是 WS 通知漏收时的兜底。「当前通话的手机」只记在服务端内存里，重启后清空、续钥匙照常放行（退回只靠 WS 通知）。
  - 带 `purpose` 时 `clientId` 必填，形状不对 400 `VALIDATION_FAILED`；整个请求体省略（旧包）时行为同从前：照常签发、不记录、不通知、不会 409。
- ✅ 本节已实现（2026-08-16）。

## 14. 待定稿清单汇总

**负责人**：注册凭据形式与验证码要求、位置分享是否需要网页版、Admin 概览指标集。（~~紧急联系人上限~~ 已定稿 5 个，2026-08-16）
**硬件团队**：绑定二维码印制载体（格式已定 DEVICE_PROTOCOL §11）；⏸️ 媒体上云路径（MVP 后）。（~~设置参数清单~~ 已定稿 2026-09-19，决策 #43；~~bindCode 来源~~ = 软件签发，`provision:batch` 按台出表。）
**软件侧内部**：token 有效期、轨迹单次查询范围上限、WebSocket 实现选型。（~~active SOS 空响应形式~~ 200 + null；~~预签名 URL 时效~~ 10 分钟；~~原始事件 Admin 端点形式~~ 合并单端点 + invalid 筛选——均已定稿 2026-08-16。）
