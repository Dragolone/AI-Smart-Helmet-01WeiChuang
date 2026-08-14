# API.md — REST / WebSocket API Contract（App / Admin ↔ Backend）

> 状态：**初稿（待双人 Review + 负责人确认后定稿）**。定稿后 DTO 在 `packages/shared` 落为 TS 类型。
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
| VALIDATION_FAILED | 400 | 请求体/参数校验失败 |
| UNAUTHORIZED | 401 | 未登录或 token 无效/过期 |
| FORBIDDEN | 403 | 无权访问该资源（含资源归属校验失败、非 Admin 访问 Admin API） |
| NOT_FOUND | 404 | 通用资源不存在 |
| DEVICE_NOT_FOUND | 404 | 设备不存在或未绑定到当前用户 |
| CONFLICT | 409 | 通用冲突 |
| DEVICE_ALREADY_BOUND | 409 | 设备已被绑定 |
| RATE_LIMITED | 429 | 触发限流 |
| INTERNAL_ERROR | 500 | 服务端异常（带 requestId 供排查） |

## 2. 认证与用户

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /auth/register | 注册。body：`{ phone, password, nickname? }`（⚠️ 注册凭据用手机号还是邮箱、是否需要短信验证码，待负责人定；MVP 默认手机号 + 密码，验证码接入 SmsProvider 后补） |
| POST | /auth/login | 登录。body：`{ phone, password }` → `{ accessToken, refreshToken, user }` |
| POST | /auth/refresh | body：`{ refreshToken }` → 新 `{ accessToken, refreshToken }`（refresh 轮换，旧 refreshToken 作废） |
| POST | /auth/logout | 作废当前 refreshToken |
| GET | /users/me | 当前用户信息 |
| PATCH | /users/me | 更新昵称/头像等非敏感字段 |

`user` 对象：`{ id, phone, nickname, avatarUrl?, createdAt }`。密码 bcrypt/argon2 存储，任何接口不回传。

Token 有效期 ⚠️ 待定稿（建议 access 15min / refresh 30d）。

## 3. 紧急联系人

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /users/me/emergency-contacts | 列表（MVP 上限 5 个 ⚠️ 数量待定） |
| POST | /users/me/emergency-contacts | body：`{ name, phone, relation? }` |
| PATCH | /users/me/emergency-contacts/{contactId} | 更新 |
| DELETE | /users/me/emergency-contacts/{contactId} | 删除（软删除） |

`contact` 对象：`{ id, name, phone, relation?, createdAt }`。SOS 通知（SMS/Push）发送对象即此列表。

## 4. 设备

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /devices/bind | 绑定。body：`{ deviceId, bindCode }`（⚠️ 绑定凭证形式——机身二维码/出厂绑定码——待硬件确认；Mock 设备用注册时生成的 bindCode 走同一流程） |
| GET | /devices | 我的设备列表 |
| GET | /devices/{deviceId} | 设备详情（含实时状态快照） |
| DELETE | /devices/{deviceId}/binding | 解绑（软删除绑定关系，设备数据留档） |
| GET | /devices/{deviceId}/status | 设备状态：`{ online, lastSeenAt, battery, charging?, signalLevel?, sleeping, firmwareVersion }` |

- MVP 绑定关系：一台设备同时只能绑定一个用户；一个用户可绑多台。⚠️ 家庭共享/多人查看不在 MVP。
- `online` 判定规则见 DEVICE_PROTOCOL §5，由服务端计算，App 不自行判断。

## 5. 位置与轨迹

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/locations/latest | 最新位置一条 |
| GET | /devices/{deviceId}/locations?from=&to=&page=&pageSize= | 历史轨迹（时间范围必填，单次范围上限 24h ⚠️ 待定；按 timestamp 升序） |

`location` 对象（与 EVENTS.md 4.2 对齐）：`{ latitude, longitude, coordinateSystem, accuracy, speed, heading, altitude?, timestamp, receivedAt }`。

- 坐标系原样返回并带 `coordinateSystem`；是否服务端统一转 gcj02 随地图 Spike 定稿（DECISIONS 待定项）。
- 轨迹查询走服务层（为未来 Retention/降采样留余地），App/Admin 不假设“所有点都在”。
- 位置分享：MVP 用 App 端生成分享内容（坐标 + 高德跳转链接），**不做服务端分享短链** ⚠️ 若产品要求可访问网页版分享再评估。

## 6. 事件查询（危险事件 / 全量事件历史）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/events?type=&from=&to=&page=&pageSize= | 事件历史；`type` 可多值逗号分隔（取值 = EVENTS.md §3 eventType） |
| GET | /events/{eventId} | 事件详情（含原始 payload、关联媒体） |

`event` 列表项：`{ eventId, deviceId, eventType, timestamp, receivedAt, summary }`；详情追加 `payload`（原样）与 `media: [{ mediaId, status, duration? }]`。

## 7. SOS / 事故记录

SOS 状态机为服务端权威（DECISIONS #8）：`pending → notified | cancelled`；App 仅渲染。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /devices/{deviceId}/sos/active | 当前进行中 SOS（无则 404/空 ⚠️ 响应形式待定稿，建议 200 + `null`） |
| POST | /sos/{sosId}/cancel | 取消（仅 pending 可取消；已 notified 返回 CONFLICT） |
| POST | /sos/{sosId}/confirm | “SOS Now”：跳过剩余倒计时立即通知 |
| GET | /devices/{deviceId}/accidents?page= | 事故记录列表（含已取消，供留档） |
| GET | /accidents/{accidentId} | 事故详情：触发事件、位置快照、SOS 状态流转、通知发送记录（成功/失败/通道） |

`sos` 对象：`{ sosId, deviceId, triggerEventId, triggerType: "possible_fall"|"manual_sos", status: "pending"|"notified"|"cancelled", deadline, createdAt, updatedAt }`。

- App 收到 WebSocket/Push 的 `sos` 对象后按 `deadline` 本地倒计时渲染，不自行计时判断超时。
- 新增错误码：`SOS_ALREADY_FINALIZED`（409，取消/确认时状态机已终态）。

## 8. 设备设置下发（命令）

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | /devices/{deviceId}/settings | 下发设置（参数清单 ⚠️ 待硬件提供，见 EVENTS.md §6）→ 创建 command，返回 `{ commandId, status: "pending" }` |
| GET | /devices/{deviceId}/settings | 当前生效设置 + 最近一次下发状态 |
| GET | /devices/{deviceId}/commands?page= | 命令历史 |
| GET | /commands/{commandId} | 命令状态：`pending → delivered → success | failed | offline`（语义见 DEVICE_PROTOCOL §7，**未回执绝不显示成功**） |

## 9. 媒体

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /media/{mediaId}/url | 换取**有时效**预签名 URL：`{ url, expiresAt }`（时效建议 10min ⚠️ 待定）；归属校验：仅设备绑定用户可取 |

媒体元数据随 `video_ready` 事件入库（EVENTS.md 4.9）；设备上传方式待硬件确认后补充本节。

## 10. Admin API（/api/v1/admin/*，独立角色守卫）

MVP 实用为主，全部只读 + 少量运维操作：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /admin/auth/login | 管理员登录（独立于 App 用户体系） |
| GET | /admin/users?page=&keyword= | 用户列表/搜索 |
| GET | /admin/devices?page=&keyword=&online= | 设备列表（绑定用户、在线状态、电量、固件版本） |
| GET | /admin/devices/{deviceId} | 设备详情 + 最近事件 |
| GET | /admin/events?type=&deviceId=&from=&to=&page= | 全量事件查询（含未知类型/校验失败的原始事件 ⚠️ 是否单独端点待定稿） |
| GET | /admin/accidents?status=&page= | 事故/SOS 记录与通知发送结果 |
| GET | /admin/stats/overview | 概览：设备总数/在线数、今日事件数、进行中 SOS 数（⚠️ 指标集待定） |

管理员账号 MVP 由种子脚本创建，不做自助注册；管理后台不对公网匿名开放。

## 11. WebSocket（App 实时通道）

- 端点：`/ws`（⚠️ 具体实现 Socket.IO vs 原生 ws 随 NestJS Gateway 实现定稿）；连接时用 accessToken 鉴权，失败即断开。
- 连接后服务端自动按“当前用户绑定的设备”推送，无需客户端订阅指令（MVP 简化）。
- 消息统一格式：

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

- WebSocket 是加速通道不是可靠通道：App 重连后须用 REST 拉取兜底；SOS 兜底靠 Push（deadline 持久化在服务端）。

## 12. Ingest Webhook（云端算法服务 → 后端）

- `POST /api/v1/ingest/webhook`；请求体 = EVENTS.md §1 envelope。
- 鉴权：`X-Api-Key: <key>`（服务端环境变量配置 ⚠️ 若算法服务方有既定签名方案则从其约定）。
- 响应：`202 { "eventId": "...", "duplicate": false }`；幂等重复返回 `duplicate: true` 同样 202。
- 本入口与 MQTT 入口在统一 Ingest 层汇合，业务模块不感知来源。

## 13. 待定稿清单汇总

**负责人**：注册凭据形式与验证码要求、紧急联系人上限、位置分享是否需要网页版、Admin 概览指标集。
**硬件团队**：设备绑定凭证形式（bindCode 来源）、设置参数清单、媒体上传方式。
**软件侧内部**：token 有效期、active SOS 空响应形式、轨迹单次查询范围上限、预签名 URL 时效、WebSocket 实现选型、原始事件 Admin 端点形式。
