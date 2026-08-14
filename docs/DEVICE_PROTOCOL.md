# DEVICE_PROTOCOL.md — 设备通信协议（定义“怎么传”）

> 与 `EVENTS.md` 的分工：**EVENTS.md 定义传什么（字段、类型、单位、值域）；本文件定义怎么传（连接、认证、Topic、QoS、重连、ACK）。**
> 状态标记：✅ 软件侧已定 ｜ ⚠️ 默认建议，待硬件团队确认（最晚 Week 10 联调前逐项确认并去除标记）。
> Mock Device 必须与本协议完全一致，对 Backend 不可区分。

## 1. 总体链路（✅ 负责人已确认，2026-08-14）

```text
头盔 ── 4G ── MQTT over TLS ── EMQX Broker ── NestJS 后端
BLE 仅用于手机近场：配对、防丢、必要近场能力（不是数据上传主通道）
云端算法服务（如有）── HTTPS Webhook ── 后端（不经 EMQX）
```

## 2. MQTT Broker

| 项 | 约定 | 状态 |
|----|------|------|
| Broker | EMQX（Docker 部署，local/development/production 同软件） | ✅ |
| 端口 | 8883（MQTT over TLS）；本地开发可用 1883 明文，云端环境**必须 TLS** | ⚠️ 硬件模组是否支持 TLS 及证书方式待确认 |
| MQTT 版本 | 3.1.1（兼容性优先；硬件模组若支持 5.0 再评估） | ⚠️ |

## 3. 设备认证

| 项 | 约定 | 状态 |
|----|------|------|
| 方式 | MQTT username = `deviceId`，password = `deviceSecret` | ✅ |
| deviceSecret 分发 | 出厂/注册时由后端生成并写入设备；Mock 设备用同一机制注册获取 | ⚠️ 写入方式待硬件确认 |
| 校验 | EMQX 认证对接后端（HTTP auth 或数据库认证），后端为唯一凭证权威 | ✅ |

## 4. Topic 与 ACL

**默认原则：设备只能 Publish / Subscribe 自己被授权的 Topic（按 deviceId 隔离），越权一律拒绝。** ✅

| 方向 | Topic | 用途 |
|------|-------|------|
| 设备 → 云 (publish) | `helmet/{deviceId}/status` | 设备状态（在线心跳、电量、版本） |
| 设备 → 云 (publish) | `helmet/{deviceId}/location` | 位置上报 |
| 设备 → 云 (publish) | `helmet/{deviceId}/event` | 业务事件（possible_fall、manual_sos、collision_risk 等） |
| 云 → 设备 (subscribe) | `helmet/{deviceId}/cmd` | 下发命令/配置 |
| 设备 → 云 (publish) | `helmet/{deviceId}/cmd_ack` | 命令执行回执 |

ACL 规则：设备 `helmet_001` 只允许 publish `helmet/helmet_001/{status,location,event,cmd_ack}`、subscribe `helmet/helmet_001/cmd`。✅（EMQX ACL 配置实现）

## 5. QoS / Keep Alive / 会话

| 项 | 默认建议 | 状态 |
|----|---------|------|
| QoS — event（SOS/摔倒/危险事件） | QoS 1（至少一次；重复交付由服务端 eventId 幂等消化） | ⚠️ |
| QoS — location / status | QoS 0 或 1（高频数据可容忍丢点；带宽与功耗由硬件权衡） | ⚠️ |
| QoS — cmd / cmd_ack | QoS 1 | ⚠️ |
| Keep Alive | 60s；Broker 判定 1.5 × KeepAlive 无心跳 = 离线 | ⚠️ |
| 在线/离线判定 | 以 EMQX 连接事件 + status 心跳综合判定，后端落库 last_seen_at | ✅ 软件侧 |
| Clean Session | 待定：设备是否需要 Broker 侧离线消息（影响 cmd 下发策略） | ⚠️ |

## 6. 重连 / 离线缓存 / 重发

| 项 | 约定 | 状态 |
|----|------|------|
| Reconnect | 设备断线后指数退避重连（建议 1s 起，上限 60s，带抖动） | ⚠️ 固件实现 |
| Offline buffering | 弱网/断网期间设备本地缓存关键事件（至少 event 类），恢复后按原 eventId 补传 | ⚠️ 固件能力待确认（缓存容量、保留时长） |
| 补传时间语义 | 补传事件保留原 `timestamp`（事件发生时间）；服务端以 `receivedAt` 记录实际到达时间 | ✅ |
| Duplicate delivery | QoS 1 与补传都可能造成重复；**服务端按 eventId 幂等去重，只存一次、只通知一次**；设备无需保证不重发 | ✅ |
| Retry | 设备侧发送失败重试策略由固件定义；软件侧不假设“必达” | ⚠️ |

## 7. 命令下发与 ACK（cmd / cmd_ack）

命令消息（云 → 设备，格式细节在 EVENTS.md 定稿）：

```json
{ "commandId": "uuid", "type": "set_config", "params": { }, "issuedAt": "ISO8601" }
```

回执（设备 → 云）：

```json
{ "commandId": "uuid", "result": "success | failed", "errorCode": "可选", "executedAt": "ISO8601" }
```

- 服务端命令状态机：`pending → delivered → success / failed / offline`。✅
- 设备离线时命令保持 pending（是否 Broker 离线暂存取决于 Clean Session 决策 ⚠️）；超时未回执标记为 `offline`/超时，**绝不显示为成功**。✅
- 允许远程设置的参数清单及取值范围：⚠️ 待硬件提供。

## 8. 设备时钟与时间戳

| 项 | 约定 | 状态 |
|----|------|------|
| timestamp | 设备事件发生时间（UTC ISO 8601），设备生成 | ✅ |
| receivedAt | 服务器收到时间，服务端生成落库 | ✅ |
| 时钟偏移处理 | `timestamp` 与 `receivedAt` 偏差超过阈值（默认 5 分钟）且非补传场景时，标记 clock_skew 并以 receivedAt 为业务兜底时间 | ✅ 软件侧默认，阈值可调 |
| 设备对时方式 | NTP / 4G 网络授时 | ⚠️ 固件实现 |

## 9. 固件兼容

| 项 | 约定 | 状态 |
|----|------|------|
| firmwareVersion | 每条事件 envelope 携带，服务端落库 | ✅ |
| schemaVersion | 事件结构版本号；服务端按版本兼容解析，未知版本进原始事件表并告警 | ✅ |
| 兼容原则 | Contract 字段只增不改不删（新增为选填）；破坏性变更必须升 schemaVersion 并双方确认 | ✅ |

## 10. 待硬件团队确认清单（汇总）

1. 4G 模组是否支持 MQTT over TLS，证书如何预置；
2. MQTT 3.1.1 / 5.0 支持情况；
3. deviceSecret 写入与出厂流程；
4. 各 Topic 的 QoS 与上报频率（location 频率直接影响功耗与流量）；
5. Keep Alive 值与 Clean Session / 离线消息需求；
6. 断网离线缓存能力（容量、保留时长、补传策略）；
7. 允许远程设置的参数清单、取值范围、执行回执错误码；
8. 设备对时方式；
9. 固件版本号规范。

以上确认前，Mock Device 按本文件默认值实现；确认后更新本文件并同步 Mock。
