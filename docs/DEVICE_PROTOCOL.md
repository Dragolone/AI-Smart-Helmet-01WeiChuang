# DEVICE_PROTOCOL.md — 设备通信协议（定义“怎么传”）

> 与 `EVENTS.md` 的分工：**EVENTS.md 定义传什么（字段、类型、单位、值域）；本文件定义怎么传（连接、认证、Topic、QoS、重连、ACK）。**
> 状态标记：✅ 软件侧已定 ｜ ⚠️ 默认建议，待硬件团队确认（最晚 Week 10 联调前逐项确认并去除标记）。
> Mock Device 必须与本协议完全一致，对 Backend 不可区分。

## 1. 总体链路（✅ 硬件 2026-08-24 确认链路形态，决策 #35；沿革：#6 → #29/#31 → #35）

**MVP 阶段头盔不装 4G 模块**（硬件口径「后面我们再扩展成 4G」）。数据链路只有一条：BLE → App 中转 → 后端统一 Ingest。Wi-Fi 2.4G 是**近场功能通道，不承载事件数据**。

```text
【MVP 形态（唯一真机链路）】
  头盔 ── BLE ── 手机 App 中转模块 ── HTTPS(/ingest/app-relay) ── 后端统一 Ingest
       └─ Wi-Fi 2.4G 近场（头盔作 SoftAP，手机连头盔热点）：
            实时视频预览 / TF 卡视频文件读取 / 对讲机配置
            ——按需前台使用，不传事件数据 ⚠️ 传输细节待硬件提供（§10）
       └─ BLE 同时用于：配对、蓝牙耳机（对讲音频，决策 #20/#22）

【4G 链路（代码已就绪，等硬件后续扩展；MVP 期间由 Mock Device 驱动）】
  头盔 ── 4G ── MQTT over TLS ── EMQX Broker ── NestJS 后端

云端算法服务（如有）── HTTPS Webhook ── 后端（不经 EMQX）
```

> 🔴 **无 4G 的产品前提**：头盔离开手机即无法上云。「摔倒自动通知」依赖**手机在身边且 App 在运行**——对外口径（决策 #28）必须补上此前提。

### 1.1 BLE 链路数据范围（✅ 汤总确认，2026-08-16，决策 #31；决策 #35 后为 MVP 唯一真机数据链路，范围不变）

- **MVP 第一期中转 7 种事件**：`device_status`、`location_update`、`possible_fall`、`manual_sos`、`collision_risk`、`obstacle_risk`、`risk_cleared`——保命链路与危险留档完整。
- **下一版本再接 4 种**（产品原因，非工作量）：`video_ready`（视频走 Wi-Fi，通知随之）、`sleep_entered/exited`（休眠展示已移出 MVP）、`bluetooth_lost`（蓝牙版中"断连=断网"，语义需重新设计）。
- App 中转模块**原样透传** MQTT 同款事件 envelope（EVENTS.md §1），不修改内容；eventId 幂等规则不变——断线补传、重复转发都由服务端去重消化。
- **BLE 传输细节 ⚠️ 待硬件团队定义**（联调清单第 1 条，**当前最卡工期的前置项**——决策 #35 后 BLE 是唯一真机数据链路）：GATT 服务/特征值、分帧与重组、App→头盔确认机制、头盔侧断连缓存与补传策略。

### 1.2 BLE 协议摘要（Contract 以 `docs/hardware/BLE通信协议手册-v0.6.html` 为准；本节为软件侧速查，2026-09-09）

| 项 | 定稿值 |
|---|---|
| GATT 角色 | 头盔 = Server（从机），App = Client（主机）；Just Works 配对，无 PIN |
| 广播名 / 间隔 | `Helmet-<deviceId 后 6 位>`；100 ms；**广播包须携带服务 UUID FEE0**（App 按服务 UUID 过滤扫描，iOS 后台扫描硬性要求，2026-09-16 真机实测；⚠️ 待硬件确认） |
| 服务 / 特征值 | 服务 `FEE0`；A `FEE1` Notify（上行：应答、事件、补传）；B `FEE2` Write / Write Without Response（下行：指令、ACK） |
| MTU / 字节序 | App 协商 247；单帧 4–25 B 无分帧；多字节小端 |
| 下行帧 | `[指令码 1B][Seq 1B][参数…]`；应答 `[指令码][Seq][ERROR 1B][数据…]` |
| 事件帧 | `[0x05][Event_Code 1B][Event_Seq 4B uint32][Timestamp 4B UTC 秒，未校时 0][载荷]`；Event_Seq 掉电保持、永不回绕（开机预分配 +1000） |
| 事件代码 | 0x01 possible_fall(11B) · 0x02 manual_sos(11B) · 0x03 collision_risk(15B) · 0x04 obstacle_risk(15B) · 0x05 risk_cleared(4B) · 0x06 location_update(15B) · 0x07 device_status(2B)——载荷布局见手册 1.4.5 |
| ACK | 高危四类必 ACK：`[0x06][Event_Code][Event_Seq 4B][0x00]`；1.5 s 无 ACK 重发，3 次后入 Flash 保护队列；位置/心跳周期事件不 ACK |
| 补传 | `0x07` 查条数 → `0x08 [偏移 2B][条数 1B]` → 逐条以实时事件帧 Notify → 结束帧 `[0x08][Seq][ERROR][实际条数]` → App 逐条 ACK 即擦除；缓存 ≥ 1000 条 / 48 h，高危永不覆盖 |
| 指令集 | 0x01 PING · 0x02 READ · 0x03 WRITE · 0x04 TIME SYNC（UTC 秒 4B）· 0x05 EVENT · 0x06 ACK · 0x07/0x08 RESEND · 0x09 RECOVERY · 0x0A RESET |
| 内存表关键地址 | 0x00–0x02 固件版本 · 0x20–0x2D 可远程设置项（App 设置下发映射到 WRITE）· 0x34 Event_Seq 基数 · **0x40 deviceId 16B ASCII（产线烧录）** · 0x50 deviceSecret 32B 只写 |
| 连接后固定流程 | MTU 247 → 订阅 A（CCCD）→ READ 0x40 deviceId + READ 0x00–0x02 固件 → TIME SYNC → RESEND QUERY/DATA 逐条 ACK → 正常收发 |
| 周期 | 位置 5 s（运动）/ 30 s（静止 >3 min）；心跳 60 s；连接间隔 20–40 ms；监控超时 5 s |
| 坐标系 | GPS 输出 **WGS-84**（int32 ×10⁶）；App 组 envelope 时 `coordinateSystem: 'wgs84'` |

**App 中转模块的翻译规则**（二进制帧 → EVENTS.md envelope，云端零改动）：`eventId` = 由 `deviceId + Event_Seq` 确定性生成的 UUID v5；`timestamp` = Timestamp≠0 ? ISO(UTC 秒) : 收到时刻；`firmwareVersion` = 0x00–0x02 拼 `x.y.z`；payload 按 EVENTS.md §4 字段映射（距离 0.1 m→m、速度 0.1 m/s→m/s、置信度 %→0–1、风险等级 1/2/3→low/medium/high、方向/目标类型枚举映射）；原始字节字段（冲击力、倾角、TTC、按键时长、触发方式）原样附在 payload 里落库。

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
| 校验 | EMQX 认证对接后端（HTTP auth），后端为唯一凭证权威 | ✅ |
| clientId | 后端消费者的固定 clientId（`MQTT_BACKEND_CLIENT_ID`）为保留值：设备连接不得使用，服务账号必须使用（2026-09-14 审计 MQTT-01 修复）。设备 clientId 建议 = deviceId（Mock 已如此），是否强制待硬件确认 | ✅ 软件侧 / ⚠️ 设备侧 |

### 3.1 EMQX → 后端 内部回调（✅ 已实现，部署时 EMQX 按此配置）

EMQX 不自己存凭证，每次连接/发布都回调后端裁决。两个端点都要求内部共享令牌（非用户 JWT），以 `?token=<EMQX_INTERNAL_TOKEN>` 或 `X-Internal-Token` 请求头携带（EMQX 配置用 query 形式）；令牌不匹配或未配置一律 401。端点**只在容器网络内可达，不经网关对公网暴露**。

| 方法 | 路径 | 请求体 | 响应 |
|------|------|--------|------|
| POST | /api/v1/internal/emqx/authenticate | `{ clientid, username, password }` | `200 { result: "allow" \| "deny" }`——username=deviceId、password=deviceSecret，与库中哈希比对 |
| POST | /api/v1/internal/emqx/authorize | `{ clientid, username, topic, action }` | `200 { result: "allow" \| "deny" }`——按 §4 ACL 规则判定设备是否越权 |

- 令牌配置在 `deploy/.env` 的 `EMQX_INTERNAL_TOKEN`，渲染进 EMQX 配置（`deploy/render-config.sh`）；改动后须重跑渲染并重启 EMQX。
- EMQX 侧超时：`connect_timeout` / `request_timeout` 均 5s，`enable_pipelining = 1`（避免连接池复用与后端 keep-alive 空闲关闭的竞态）。
- 授权无匹配规则时 `no_match = deny`（默认拒绝）。✅ **后端不可达时 fail-closed 已实测**（2026-08-25，两场景：回调返回非预期响应 / 端口无监听，均 `Connection refused: Not authorized`，不存在默认放行）。

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

> 本节的 MQTT cmd/cmd_ack 通道属 **4G 链路**。**BLE 链路（MVP 唯一真机链路）的下行命令走决策 #36（Contract 已定稿，见 API.md §8/§11）**：
> 后端把命令经 WS `device_command` 消息推给绑定用户的 App（连接建立时补推 pending/delivered 存量）→ App 经 BLE 写给头盔 → App 提交 `POST /devices/{id}/commands/{cid}/relay-ack`（`stage=delivered` 表示已写入头盔；`stage=executed` 转发头盔执行结果）。
> **delivered 语义对齐**：4G 版 = PUBACK（送达 Broker）；蓝牙版 = App 确认写入（送达中转节点）——App 即蓝牙版的 Broker。状态机 `pending → delivered → success/failed/offline` 与 30s 超时口径（#27④）两链路完全一致。
> ⚠️ App→头盔的 BLE 写入格式（命令的 GATT 表达）随硬件 BLE 协议定义（§10 第 1 条）。


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
- 允许远程设置的参数清单及取值范围：✅ 定稿（2026-09-19，决策 #43）= v0.6 内存控制表 0x20–0x2D 共 14 项，键名与范围见 API.md §8 表 / `@helmet/shared` `DEVICE_SETTINGS`；服务端入口按此校验，越界不下发。

## 8. 设备时钟与时间戳

| 项 | 约定 | 状态 |
|----|------|------|
| timestamp | 设备事件发生时间（UTC ISO 8601），设备生成 | ✅ |
| receivedAt | 服务器收到时间，服务端生成落库 | ✅ |
| 时钟偏移处理 | `timestamp` 与 `receivedAt` 偏差超过阈值（默认 5 分钟）且非补传场景时，标记 clock_skew 并以 receivedAt 为业务兜底时间 | ✅ 软件侧默认，阈值可调 |
| 设备对时方式 | NTP（经 Wi-Fi）/ BLE 由 App 下发对时 / 未来 4G 网络授时 | ⚠️ 固件实现，**决策 #35 后无 4G，对时方式需硬件明确** |

## 9. 固件兼容

| 项 | 约定 | 状态 |
|----|------|------|
| firmwareVersion | 每条事件 envelope 携带，服务端落库 | ✅ |
| schemaVersion | 事件结构版本号；服务端按版本兼容解析，未知版本进原始事件表并告警 | ✅ |
| 兼容原则 | Contract 字段只增不改不删（新增为选填）；破坏性变更必须升 schemaVersion 并双方确认 | ✅ |

## 10. 待硬件团队确认清单（汇总，2026-08-24 按决策 #35 重排）

**当前开工前置（最卡工期，优先级从高到低）：**

1. ✅ **BLE 数据协议已定稿（v0.6，硬件 Seamus Zhang 2026-09-08；决策 #38）**：原文 `docs/hardware/BLE通信协议手册-v0.6.html`，软件侧摘要见 §1.2。软件侧审阅 v0.5 提出的 7 项必改 + 5 项建议全部落实。**v0.6 遗留 3 处文档级修正（已回硬件，不阻塞开工）**：① 例 4 / 4.5 节「0x26 连写 02 5A」把音量写到了 0x27（跌倒检测使能），音量在 0x24，应拆两条写；② 握手第 3 步读 0x40×16B 只得 deviceId，固件版本需另读 0x00–0x02；③ RESEND 补传覆盖的事件类型（仅高危 vs 含位置/心跳 FIFO）需写明；④（2026-09-16 补）示例帧的十六进制与标注十进制不一致：例 5/6 `88 79 A2 6A` = 0x6AA27988 = 1789032840（非 1788856200），例 2/6/7 `ED 4E CD 01 17 7C 29 07` = 30.232301° / 120.159255°（非 30.256877 / 120.158231）——**字节流为准**，App 解析以字节实现并以此为单测夹具。**✅ A 线 App BLE 中转模块已按 v0.6 实现（2026-09-16）**：`app/src/services/ble/protocol.ts`（帧编解码 + envelope 翻译 + 设置键→寄存器映射，17 个单测钉住手册示例）、`app/src/services/ble-link.ts`（扫描/连接/五步握手/ACK/补传/重连）、`app/src/services/ble-relay.ts`（设置下发 → 0x03 WRITE → 按头盔错误码回执）；仿真器 `tools/ble-helmet-sim/helmet_sim.py`（DEVELOPMENT.md 常用命令）；
2. 🔴 **Wi-Fi 近场细节**：
   - ① 实时视频推流协议 —— ✅ **硬件 2026-08-25 已答**：主控 **全志 V821 SoC**，官方参考方案 `sample_smartIPC_demo` 走 **RTSP**，编码 **H.264**，媒体由 **RTP** 承载（RTP/UDP 还是 RTP over TCP 取决于 SDK 配置 `rtsp_net_type`），主/子码流以不同 `rtsp id` 区分（默认 `main_rtsp_id = 0`）。文档：<https://docs.aw-ol.com/docs/soc/v821/solution/ipc-camera/>
     **仍需硬件补充（🔴 2026-09-01 实时预览已拍板进 MVP——决策 #37，以下缺项连同 ④ 热点参数升级为 A 线 Spike 开工硬前置）**：⚠️ 子码流的 rtsp id 与分辨率（App 预览应用子码流，主码流解码与带宽压力过大）；⚠️ `rtsp_net_type` 实配值（局域网直连建议 RTP/UDP，延迟更低）；⚠️ 完整拉流 URL 格式与是否需要鉴权。
     **App 侧影响（结论未定，待 Spike）**：iOS AVPlayer **不支持 RTSP**（系统级限制），WebView 亦不支持 `rtsp://` —— 地图那套「WebView 绕过原生库」在此不适用；行业解法为内嵌 libVLC 系播放器（体积 +数十 MB，且 RN 0.86 / Expo SDK 57 新架构兼容性存疑，同决策 #33 amap3d 风险类型），**必须双端真机 Spike 后才能定案**；降级预案 = App 内以 `rtsp://` 链接唤起系统 VLC。若硬件愿改用 **WebRTC**（V821 文档称可自行移植），App 端成本显著降低（`react-native-webrtc` 成熟，且已有 TRTC 原生依赖经验）。
   - ② TF 卡视频文件的列表与下载接口（HTTP 文件服务？私有协议？）——**决策 #37 后 TF 卡读取排 MVP 后第一迭代，本项降为非紧急**；
   - ③ 对讲机配置接口与参数清单（频道/频率/功率及取值范围）；
   - ④ 热点参数：SSID 与密码规则、头盔侧 IP 是否固定；
3. 🔴 **无 4G 期间的设备对时方式**（原 §8 依赖 4G 网络授时）。

**Wi-Fi/BLE 形态下仍需确认：**

4. 各类事件的上报频率（location 频率直接影响功耗与 BLE 带宽）；
5. 断连离线缓存能力（容量、保留时长、补传策略）；
6. 允许远程设置的参数清单、取值范围、执行回执错误码；
7. deviceSecret 写入与出厂流程；
8. ⚠️ **绑定二维码印制**（§11）：头盔机身或随机说明卡印一枚二维码，内容按 §11 格式，与 deviceId / 绑定码一同出厂。

**⏸️ 后延至硬件扩展 4G 时再确认（决策 #35）：**

8. 4G 模组是否支持 MQTT over TLS，证书如何预置（地址 `dev-mqtt.01weichuang.com:8883`）；
9. MQTT 3.1.1 / 5.0 支持情况；
10. 各 Topic 的 QoS、Keep Alive 值、Clean Session / 离线消息需求。

## 11. 绑定二维码（App 扫码绑定，2026-09-17 A 线新增，⚠️ 待硬件确认印制）

App「绑定设备」页支持扫码：扫到后自动填入设备号与绑定码，用户只需点「绑定」。二维码内容（UTF-8 文本）三选一，**推荐 ①**：

| # | 内容 | 说明 |
|---|------|------|
| ① | `https://01weichuang.com/bind?d=<deviceId>&c=<bindCode>` | 推荐。微信/系统相机扫到也能落到网页（网页端后续做「请在 App 内扫码」引导），App 内扫直接绑定 |
| ② | `helmet://bind?d=<deviceId>&c=<bindCode>` | 自定义 scheme，仅 App 内可用 |
| ③ | `<deviceId>` 裸文本 | 旧批次只印编号；扫后设备号预填，绑定码手输 |

- `deviceId` 规则同 §3（`[A-Za-z0-9_-]{4,64}`）；`bindCode` 为 8 位数字（API.md §4 绑定码）。非上述格式 App 提示「不是绑定二维码」并继续扫。
- 绑定码印在二维码里意味着**拿到实物即可绑定**——与说明卡明文印绑定码的现状等价，不额外扩大风险；换绑后旧码失效由服务端绑定码轮换保证（API.md §4）。
- App 侧解析 `app/src/services/bind-qr.ts`（单测覆盖三种形式与非法输入）。
