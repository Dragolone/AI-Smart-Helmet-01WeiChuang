# DEVICE_PROTOCOL.md — 设备通信协议（定义“怎么传”）

> 与 `EVENTS.md` 的分工：**EVENTS.md 定义传什么（字段、类型、单位、值域）；本文件定义怎么传（连接、认证、Topic、QoS、重连、ACK）。**
> 状态标记：✅ 软件侧已定 ｜ ⚠️ 默认建议，待硬件团队确认（最晚 Week 10 联调前逐项确认并去除标记）。
> Mock Device 必须与本协议完全一致，对 Backend 不可区分。

## 1. 总体链路（✅ 负责人已确认，2026-08-14；双产品形态 2026-08-16 补充，决策 #29/#31）

产品分**两种形态**，共用同一套事件 Contract（EVENTS.md）与后端统一 Ingest 层：

```text
【4G 版】 头盔 ── 4G/Wi-Fi ── MQTT over TLS ── EMQX Broker ── NestJS 后端
          BLE 用于手机近场：配对、防丢、蓝牙耳机（对讲音频）
【蓝牙版】头盔 ── BLE ── 手机 App 中转模块 ── HTTPS(/ingest/app-relay) ── 后端统一 Ingest
          头盔不装 4G 模块；视频不走 BLE（SD 卡存储 + 头盔连 Wi-Fi 直传云端）
云端算法服务（如有）── HTTPS Webhook ── 后端（不经 EMQX）
```

### 1.1 蓝牙版数据范围（✅ 汤总确认，2026-08-16，决策 #31）

- **MVP 第一期中转 7 种事件**：`device_status`、`location_update`、`possible_fall`、`manual_sos`、`collision_risk`、`obstacle_risk`、`risk_cleared`——保命链路与危险留档完整。
- **下一版本再接 4 种**（产品原因，非工作量）：`video_ready`（视频走 Wi-Fi，通知随之）、`sleep_entered/exited`（休眠展示已移出 MVP）、`bluetooth_lost`（蓝牙版中"断连=断网"，语义需重新设计）。
- App 中转模块**原样透传** MQTT 同款事件 envelope（EVENTS.md §1），不修改内容；eventId 幂等规则不变——断线补传、重复转发都由服务端去重消化。
- **BLE 传输细节**：硬件确认走**透传模块**路线后（2026-08-17 张森淼同步），GATT 层由模块决定、帧层由软件侧起草——提案见 §1.2 ⚠️，硬件确认后去标记。

### 1.2 蓝牙版 BLE 帧协议（⚠️ 软件侧提案 2026-08-17，待硬件确认）

**前提**（硬件 2026-08-17 同步）：BLE 用现成**透传模块**（主控经串口 + AT 指令驱动，模块型号选型中）。透传模块只搬字节、不管消息边界，因此协议分两层：

- **GATT 层 = 模块厂定死**：服务/特征值 UUID、MTU 随模块型号而定。硬件只需**告知模块型号**，App 端查手册接入，无需硬件设计任何 GATT 内容。
- **帧层 = 本节约定**：解决字节流上的消息边界、确认、断连补传。头盔主控视角只是「往串口写一行文本、从串口读一行文本」。

| # | 规则 | 说明 |
|---|------|------|
| 1 | **一条消息 = 一行**：UTF-8 JSON + `\n` 结尾 | 事件即 EVENTS.md §1 的 envelope 原文。JSON 规范强制转义控制字符，正文内不会出现裸换行，`\n` 可安全作分隔符。串口调试助手肉眼可读，硬件无需专用调试工具 |
| 2 | 方向：头盔→App 发 §1.1 的 7 种事件；App→头盔 发确认帧 `{"ack":"<eventId>"}` | 除确认帧外，App 不向头盔发数据（MVP 无蓝牙版下行命令） |
| 3 | 单行上限 **1024 字节**，超限整行丢弃并计数 | 现 7 种事件 envelope 均远小于此；给 firmwareVersion 等字段留余量 |
| 4 | **event 类须确认**（possible_fall / manual_sos / collision_risk / obstacle_risk / risk_cleared）：头盔发出后留在本地缓存，收到对应 `ack` 才删；建议 5s 未确认重发，**重发不换 eventId** | 保命链路不丢；重复到达由服务端 eventId 幂等消化（与 4G 版 QoS 1 同语义），头盔无需保证不重发 |
| 5 | **status / location 发完即忘**，不需要 ack，断连期间可丢 | 高频低价值，与 4G 版 QoS 0 同语义，省单片机内存 |
| 6 | 断连补传：重连后按发生顺序重发未确认的 event 类缓存 | 补传保留原 `timestamp`（§6 补传时间语义不变） |
| 7 | 缓存容量建议 ≥ **32 条** event；满时先丢最旧的危险类，`possible_fall` / `manual_sos` 最后丢 | 具体条数由硬件按内存定夺（见下需确认项） |
| 8 | 半包/粘包由 **App 端**处理（按 `\n` 切分、跨 BLE 包拼接缓冲） | BLE 单包几十到两百字节会把一行切碎——软件职责，硬件不用管 |
| 9 | 时间戳：蓝牙版无 4G 授时，`timestamp` 依赖 GPS 授时；时钟不可信时服务端 clock_skew 规则兜底（§8） | 与 4G 版同一套兜底，软件零改动 |

**需硬件确认三项**：① 模块型号（定了即发软件侧，查 UUID/MTU）；② 单片机侧「拼 JSON 写串口 + 读一行解析 ack」是否好实现——若资源紧张可改二进制 TLV 帧，软件适配成本约一天，但优先 NDJSON（可读、与 4G 版 envelope 同构）；③ event 缓存条数能做到多少。

**软件侧不等样机**：App 中转模块按本提案先行开发，用「模拟头盔」脚本注入同格式字节流驱动测试；样机到位后直接对接。

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
9. 固件版本号规范；
10. **蓝牙版**：BLE 透传模块型号（→ GATT UUID/MTU）；
11. **蓝牙版**：§1.2 帧协议提案三项确认（格式可实现性、ack 机制、缓存条数）。

以上确认前，Mock Device 按本文件默认值实现；确认后更新本文件并同步 Mock。
