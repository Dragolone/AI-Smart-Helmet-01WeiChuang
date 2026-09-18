# EVENTS.md — 事件 Contract（定义“传什么”）

> 与 `DEVICE_PROTOCOL.md` 的分工：**本文件定义传什么（字段、类型、必填性、单位、枚举、值域）；DEVICE_PROTOCOL.md 定义怎么传（连接、认证、Topic、QoS、重连、ACK）。**
> 状态：**初稿（待双人 Review + 负责人确认后定稿）**。已在 `packages/shared` 落为 TS 类型（2026-08-15，含 ⚠️ 字段按当前默认值）；本文件变更时必须同步 `@helmet/shared`。
> 标记：✅ 软件侧已定 ｜ ⚠️ 默认建议，待硬件/算法团队确认。
> 兼容原则（DECISIONS #18）：**字段只增不改不删（新增一律选填）；破坏性变更必须升 schemaVersion 并双方确认。**

## 1. 统一事件 Envelope（✅）

所有入口（MQTT、算法 Webhook、Mock）使用同一 envelope；业务模块不感知事件来源。

```json
{
  "schemaVersion": 1,
  "eventId": "018f6b2a-7c3e-7000-8000-000000000001",
  "deviceId": "helmet_001",
  "eventType": "location_update",
  "timestamp": "2026-08-14T03:00:00Z",
  "firmwareVersion": "1.0.3",
  "payload": { }
}
```

| 字段 | 类型 | 必填 | 说明 / 值域 |
|------|------|------|-------------|
| schemaVersion | integer | 必填 | 事件结构版本，当前固定 `1`；未知版本按原 eventId 进原始事件表并告警、不进业务流程（app-relay/webhook 计入 `invalid`；✅ 2026-09-14 审计 INGEST-01 实现）。值域 0–2147483647（int4），越界按校验失败留档 |
| eventId | string (UUID) | 必填 | **设备/算法侧生成**；服务端幂等去重依据——同 eventId 只存一次、只通知一次 |
| deviceId | string | 必填 | 硬件团队分配的设备 ID，如 `helmet_001`；必须与 MQTT 认证身份一致，不一致拒收 |
| eventType | string (枚举) | 必填 | 见 §3 事件类型总表；未知类型进原始事件表并告警 |
| timestamp | string (ISO 8601 UTC) | 必填 | **设备侧事件发生时间**；补传事件保留原值。必须带显式时区（`Z` 或 `±hh:mm`）、日历合法（02-30 之类拒收）、年份 ≥ 1970 |
| firmwareVersion | string | 必填 | 设备固件版本；算法 Webhook 事件填算法服务版本来源（见 §5） |
| payload | object | 必填 | 按 eventType 定义，见 §4；允许为空对象 `{}` |

服务端补充字段（**不由设备上传**，✅）：

| 字段 | 生成方 | 说明 |
|------|--------|------|
| receivedAt | 服务端 | 服务器收到时间，落库；`timestamp` 与 `receivedAt` 偏差超阈值（默认 5 分钟）且非补传时标记 clock_skew，业务兜底用 receivedAt（规则见 DEVICE_PROTOCOL §8） |
| source | 服务端 | `mqtt` / `webhook` / `app_relay`（蓝牙版 App 中转，API.md §12.1）——仅存原始事件表用于排查；**业务模块不可见、不可依赖** |

## 2. 通用规则（✅）

1. **幂等**：服务端按 eventId 去重。QoS 1 重复交付、断网补传重发，都只落一次库、只触发一次通知。
2. **原始留档**：所有事件（含未知类型、校验失败）原始 payload 落 raw_events 表，供排查与未来 AI 服务读取；校验失败不进业务流程、不丢弃、需告警。
3. **单位约定**：距离米（m）、速度米每秒（m/s）、角度度（°，正北为 0 顺时针 0–360）、电量百分比整数（0–100）、时长秒（s）。**禁止出现无单位数值字段。**
4. **坐标**：任何坐标必须显式携带 `coordinateSystem`（`wgs84` | `gcj02`），不允许隐含约定。
5. **confidence / algorithmVersion**：算法类事件建议携带（选填），原样落库不参与软件判断——软件绝不基于原始数据做算法决策。
6. **字符集**：任何字符串字段不得含 NUL（`\u0000`），单条 envelope ≤ 64KB；违反者按校验失败留档（2026-09-10 加固）。数据库仍拒绝的个别值同样降级留档（reason=`db_rejected_*`），入口永不因单条脏数据 5xx。

## 3. 事件类型总表（MVP，✅ 类型集合已定）

| eventType | 方向 | MQTT Topic（见 DEVICE_PROTOCOL §4） | 业务动作 |
|-----------|------|--------------------------------------|----------|
| device_status | 设备→云 | `helmet/{deviceId}/status` | 更新设备在线/电量/版本；WebSocket 推给 App |
| location_update | 设备→云 | `helmet/{deviceId}/location` | 位置入库；WebSocket 推最新位置 |
| possible_fall | 设备→云 | `helmet/{deviceId}/event` | **创建 SOS（60s 倒计时状态机）**+ 事故记录 |
| manual_sos | 设备→云 | `helmet/{deviceId}/event` | **创建 SOS（60s 倒计时状态机）**+ 事故记录 |
| collision_risk | 设备→云 | `helmet/{deviceId}/event` | 危险事件入库、App 展示/通知 |
| obstacle_risk | 设备→云 | `helmet/{deviceId}/event` | 危险事件入库、App 展示/通知 |
| risk_cleared | 设备→云 | `helmet/{deviceId}/event` | 解除对应危险状态展示 |
| sleep_entered | 设备→云 | `helmet/{deviceId}/event` | 设备状态标记休眠；App 展示 |
| sleep_exited | 设备→云 | `helmet/{deviceId}/event` | 解除休眠标记；App 展示 |
| bluetooth_lost | 设备→云 | `helmet/{deviceId}/event` | 防丢提醒记录（App 近场判断另行走本地 BLE，见 CLAUDE.md 防丢口径） |
| video_ready | 设备→云 | `helmet/{deviceId}/event` | 媒体元数据入库，与相关事件关联 |

## 4. 各事件 payload 定义

### 4.1 device_status

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| battery | integer | 必填 | % | 0–100 |
| charging | boolean | 选填 | — | 是否充电中 |
| signalLevel | integer | 选填 | 级 | 蜂窝/无线信号强度 0–4（⏸️ 分级口径 4G 扩展时确认；**决策 #35 后 MVP 头盔无 4G，BLE 链路下本字段缺省** — v0.6 心跳只带电量与充电状态） |
| sleeping | boolean | 选填 | — | 当前是否处于休眠（与 sleep_entered/exited 冗余自校验用） |

上报频率 ✅ v0.6：心跳 60 s（可经设置 `heartbeatPeriod` 调整）；App 中转按收到的事件透传，云端不假设固定周期。

### 4.2 location_update

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| latitude | number | 必填 | ° | -90 ~ 90 |
| longitude | number | 必填 | ° | -180 ~ 180 |
| coordinateSystem | string (枚举) | 必填 | — | `wgs84` \| `gcj02`；✅ 头盔 GPS 输出 WGS-84（v0.6，int32 ×10⁶），App 中转填 `wgs84`；wgs84→gcj02 在 App 地图层转换（决策 #33） |
| accuracy | number | 必填 | m | ≥ 0，水平定位精度（68% 置信半径） |
| speed | number | 必填 | m/s | ≥ 0；v0.6 地速为 uint16 × 0.1 m/s，**无无效哨兵**，⚠️ 无定位时头盔填什么待硬件答（DEVICE_PROTOCOL §10 B-8）；无定位（精度 0xFF）的位置帧 App 整帧不上传 |
| heading | number | 必填 | ° | 0 ~ 360，正北为 0 顺时针；✅ v0.6 无效值 0xFFFF（静止时常见），App 翻译为 0 |
| altitude | number | 选填 | m | 海拔；v0.6 无效值 0x7FFF 时 App 省略本字段 |

上报频率 ✅ v0.6：运动 5 s / 连续静止超 3 min 后 30 s（可经设置 `locationPeriodMoving` / `locationPeriodStill` 调整）；软件侧仍不假设固定周期（CLAUDE.md 位置数据生命周期）。

### 4.3 possible_fall（触发 SOS 状态机）

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| confidence | number | 选填 | — | 0 ~ 1，算法置信度，原样落库 |
| algorithmVersion | string | 选填 | — | 算法版本，原样落库 |
| location | object | 选填 | — | 摔倒时位置快照，字段同 4.2（latitude/longitude/coordinateSystem 必填，其余选填） |

### 4.4 manual_sos（触发 SOS 状态机）

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| location | object | 选填 | — | 同 4.3 location |

> SOS 状态机为服务端权威（DECISIONS #8）：创建后服务端持久化 deadline 并经 WebSocket/Push 下发，App 只渲染倒计时；重复上报（同 eventId）不重复建单。
> **并发合并规则（✅ 定稿 2026-08-16，DECISIONS #26；2026-09-15 决策 #40 改为按「设备 + 当前绑定用户」判定）**：该设备在**同一绑定用户名下**已有进行中（pending）SOS 时——新 **possible_fall** 只留档不建单（同一事故的重复判定）；新 **manual_sos** 不建单但**立即触发通知**（倒计时中按实体键 = 明确人为求救，等价 App 端 SOS Now）。终态（notified/cancelled）后的新事件正常建新单。未绑定用户的设备只留档不建单。**换绑后**新用户的事件另建新单，前用户的进行中单不受影响（照常倒计时、到期通知前用户的联系人；数据库约束「每设备每用户至多一个 pending」）。deadline 一律按服务器时间计算，设备时钟偏移（clock_skew）不影响状态机。

### 4.5 collision_risk / obstacle_risk

两类事件 payload 结构相同（v0.6 两事件载荷共 15 字节同布局；obstacle_risk 的目标类型/方向取值待硬件确认，DEVICE_PROTOCOL §10 B-7）：

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| riskLevel | string (枚举) | 必填 | — | `low` \| `medium` \| `high`（✅ v0.6 三档 1/2/3 → low/medium/high；算法在头盔本地运行，此即算法口径；App 收到未知档位按 high 兜底） |
| objectType | string (枚举) | 选填 | — | `vehicle` \| `pedestrian` \| `obstacle` \| `unknown`（✅ v0.6：0/1/2/3 → unknown/vehicle/pedestrian/obstacle；集合外的值**原样落库**并告警，不改写——留档原则） |
| direction | string (枚举) | 选填 | — | `front` \| `rear` \| `left` \| `right`（✅ v0.6：1/2/3/4 → front/rear/left/right；未知值省略） |
| distance | number | 选填 | m | ≥ 0，目标距离 |
| confidence | number | 选填 | — | 0 ~ 1 |
| algorithmVersion | string | 选填 | — | 原样落库 |
| location | object | 选填 | — | 同 4.3 location |

> 毫秒级本地告警（蜂鸣/振动）由头盔本地执行；本事件仅用于展示、通知与留档，链路延迟不承诺实时性。

### 4.6 risk_cleared

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| clearedEventId | string (UUID) | 选填 | — | 被解除的危险事件 eventId；缺省表示解除该设备当前全部危险状态 |

### 4.7 sleep_entered / sleep_exited

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| reason | string (枚举) | 选填 | — | `inactivity` \| `manual` \| `low_battery`（⏸️ 休眠已移出 MVP，集合待硬件扩展时确认） |
| battery | integer | 选填 | % | 0–100，进入/退出时电量快照 |

### 4.8 bluetooth_lost

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| disconnectDuration | integer | 选填 | s | ≥ 0，触发上报时已断开时长 |

> 该事件为头盔经 4G 上报的“与手机 BLE 断连”留档；App 本地 BLE 断连提醒独立实现，两者口径均遵循 CLAUDE.md「BLE 防丢口径」（不承诺精确距离）。

### 4.9 video_ready

| 字段 | 类型 | 必填 | 单位 | 说明 / 值域 |
|------|------|------|------|-------------|
| videoId | string | 必填 | — | 设备侧媒体唯一 ID |
| relatedEventId | string (UUID) | 选填 | — | 关联的危险/摔倒事件 eventId |
| duration | integer | 选填 | s | 片段时长 |
| sizeBytes | integer | 选填 | byte | 文件大小 |
| storageKey | string | ⏸️ 待定 | — | 媒体在对象存储中的位置；**上云路径（SoftAP 无外网：经 App 中转 / 头盔切 STA）随 TF 卡读取排 MVP 后定稿**（DEVICE_PROTOCOL §10 E-17） |

## 5. 云端算法服务 Webhook（如有）

- 入口：`POST /api/v1/ingest/webhook`（鉴权见 API.md §8），**不经 EMQX**（DECISIONS #7）。
- 请求体 = 与 MQTT 完全一致的事件 envelope（§1）；`firmwareVersion` 填其判断所依据的设备固件版本，缺失时填 `"unknown"` ⚠️ 待算法团队确认。
- 幂等、落库、未知类型处理与 MQTT 入口完全一致。

## 6. 命令与回执 payload（云→设备 cmd / 设备→云 cmd_ack）

命令状态机、超时与离线语义见 DEVICE_PROTOCOL §7；此处定义消息体。

命令（`helmet/{deviceId}/cmd`）：

| 字段 | 类型 | 必填 | 说明 / 值域 |
|------|------|------|-------------|
| commandId | string (UUID) | 必填 | 服务端生成；回执按此关联 |
| type | string (枚举) | 必填 | MVP 只有 `set_config`；BLE 链路下状态可由 App 直接 READ 内存表，`request_status` 之类留到 4G 扩展再议 |
| params | object | 必填 | `set_config` 时为参数键值对；**✅ 清单与取值范围定稿（决策 #43）**：14 项见 API.md §8 表，代码以 `@helmet/shared` `DEVICE_SETTINGS` 为准 |
| issuedAt | string (ISO 8601 UTC) | 必填 | 服务端下发时间 |

回执（`helmet/{deviceId}/cmd_ack`）：

| 字段 | 类型 | 必填 | 说明 / 值域 |
|------|------|------|-------------|
| commandId | string (UUID) | 必填 | 对应命令 |
| result | string (枚举) | 必填 | `success` \| `failed` |
| errorCode | string | 选填 | 失败原因码。**✅ 码表 = BLE 协议 v0.6 §3.0**：`ERR_LENGTH` / `ERR_INSTRUCTION` / `ERR_ADDR_RANGE` / `ERR_EPROM_LOCKED` / `ERR_PARAM_VALUE` / `ERR_BATTERY_LOW` / `ERR_HARDWARE_FAULT`（`@helmet/shared` `HELMET_ERROR_CODES`）；App 中转侧追加 `:<key>` 指明设置项（如 `ERR_PARAM_VALUE:volume`），另有 `UNSUPPORTED_SETTING:<key>`、`EMPTY_PARAMS` 两个 App/Mock 自定义码。原样落库，不做枚举校验 |
| executedAt | string (ISO 8601 UTC) | 必填 | 设备执行时间 |

## 7. 待确认清单汇总

**硬件团队（余项，清单见 DEVICE_PROTOCOL §10）**：location_update 地速无效值（B-8）；后延：video 上云路径与 storageKey（E-17）、signalLevel 分级（4G 时）、sleep reason 集合（休眠移出 MVP）。（~~上报频率、GPS 坐标系、航向/精度/海拔无效值、可下发参数清单与错误码表、额外命令类型~~ 已由 v0.6 定稿，2026-09-19 去标记，决策 #43。）
**算法团队**：~~riskLevel 档位口径、objectType/direction 集合~~（算法在头盔本地运行，口径已随 v0.6 定稿）；Webhook 场景 firmwareVersion 取值仅当引入云端算法服务时再定。
**软件侧内部**：wgs84→gcj02 转换位置（随地图 Spike 定稿）。（~~同设备并发 SOS 合并规则~~ 已定稿 2026-08-16，见 §4.4 / DECISIONS #26。）

以上确认前，Mock Device 按本文件当前默认值出数据；确认后更新本文件并同步 Mock 与 `packages/shared`。
