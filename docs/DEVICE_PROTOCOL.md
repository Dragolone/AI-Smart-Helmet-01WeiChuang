# DEVICE_PROTOCOL.md — 设备通信协议（定义“怎么传”）

> 与 `EVENTS.md` 的分工：**EVENTS.md 定义传什么（字段、类型、单位、值域）；本文件定义怎么传（连接、认证、Topic、QoS、重连、ACK）。**
> 状态标记：✅ 已定 ｜ ⚠️ 待硬件团队确认（清单见 §10）｜ ⏸️ 后延至硬件扩展 4G 时确认。2026-09-19 按 BLE 协议 v0.6 去掉已答项。
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
- **BLE 传输细节 ✅ 已定稿（v0.6，决策 #38，2026-09-09）**：GATT 服务/特征值、单帧无分帧、高危事件 ACK 闭环、Flash 断连缓存与补传——摘要见 §1.2；余下修正与广播 FEE0 要求见 §10 A/B。

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
| 端口 | 8883（MQTT over TLS）；本地开发可用 1883 明文，云端环境**必须 TLS** | ⏸️ 4G 模组是否支持 TLS 及证书预置方式，扩展 4G 时确认（§10 E-18） |
| MQTT 版本 | 3.1.1（兼容性优先；硬件模组若支持 5.0 再评估） | ⏸️ 4G 扩展时确认 |

## 3. 设备认证

| 项 | 约定 | 状态 |
|----|------|------|
| 方式 | MQTT username = `deviceId`，password = `deviceSecret` | ✅ |
| deviceSecret 分发 | 出厂时由后端生成（`provision:batch` 按台出表），产线写入头盔 0x50（32B，只写不可读，v0.6 标「预留 4G 鉴权」）；Mock 设备用同一机制注册获取 | ✅ 写入位置已定（v0.6）；MVP 是否随 deviceId 一起烧待硬件答（§10 C-11） |
| 校验 | EMQX 认证对接后端（HTTP auth），后端为唯一凭证权威 | ✅ |
| clientId | 后端消费者的固定 clientId（`MQTT_BACKEND_CLIENT_ID`）为保留值：设备连接不得使用，服务账号必须使用（2026-09-14 审计 MQTT-01 修复）。设备 clientId 建议 = deviceId（Mock 已如此），是否强制待硬件确认 | ✅ 软件侧 / ⏸️ 设备侧 4G 扩展时确认 |

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
| QoS — event（SOS/摔倒/危险事件） | QoS 1（至少一次；重复交付由服务端 eventId 幂等消化） | ⏸️ 4G 扩展时确认（BLE 链路对应物 = v0.6 高危事件 ACK 闭环，已定） |
| QoS — location / status | QoS 0 或 1（高频数据可容忍丢点；带宽与功耗由硬件权衡） | ⏸️ 4G 扩展时确认（BLE：位置/心跳不 ACK，已定） |
| QoS — cmd / cmd_ack | QoS 1 | ⏸️ 4G 扩展时确认 |
| Keep Alive | 60s；Broker 判定 1.5 × KeepAlive 无心跳 = 离线 | ⏸️ 4G 扩展时确认（BLE：v0.6 心跳 60 s、链路监控超时 5 s） |
| 在线/离线判定 | 以 EMQX 连接事件 + status 心跳综合判定，后端落库 last_seen_at | ✅ 软件侧 |
| Clean Session | 待定：设备是否需要 Broker 侧离线消息（影响 cmd 下发策略） | ⏸️ 4G 扩展时确认（BLE 下行走 WS + App，决策 #36，无此概念） |

## 6. 重连 / 离线缓存 / 重发

| 项 | 约定 | 状态 |
|----|------|------|
| Reconnect | BLE（v0.6）：连续 5 s 无 PDU 判链路断，头盔恢复广播，App 指数退避重连；4G：设备断线后指数退避重连（建议 1s 起，上限 60s，带抖动） | ✅ BLE 已定 / ⏸️ 4G 固件实现 |
| Offline buffering | BLE（v0.6）：Flash 环形区 ≥ 1000 条 / 48 h，高危事件保护区永不覆盖、位置/心跳 FIFO；重连后 `0x07/0x08` 逐条补传、App ACK 即擦除，eventId 由 deviceId + Event_Seq 派生故补传天然幂等 | ✅ 已定；补传是否含位置/心跳待答（§10 B-5） |
| 补传时间语义 | 补传事件保留原 `timestamp`（事件发生时间）；服务端以 `receivedAt` 记录实际到达时间 | ✅ |
| Duplicate delivery | QoS 1 与补传都可能造成重复；**服务端按 eventId 幂等去重，只存一次、只通知一次**；设备无需保证不重发 | ✅ |
| Retry | BLE（v0.6）：高危事件 1.5 s 无 ACK 重发，3 次后入 Flash 保护队列；软件侧不假设“必达” | ✅ BLE 已定 / ⏸️ 4G 固件实现 |

## 7. 命令下发与 ACK（cmd / cmd_ack）

> 本节的 MQTT cmd/cmd_ack 通道属 **4G 链路**。**BLE 链路（MVP 唯一真机链路）的下行命令走决策 #36（Contract 已定稿，见 API.md §8/§11）**：
> 后端把命令经 WS `device_command` 消息推给绑定用户的 App（连接建立时补推 pending/delivered 存量）→ App 经 BLE 写给头盔 → App 提交 `POST /devices/{id}/commands/{cid}/relay-ack`（`stage=delivered` 表示已写入头盔；`stage=executed` 转发头盔执行结果）。
> **delivered 语义对齐**：4G 版 = PUBACK（送达 Broker）；蓝牙版 = App 确认写入（送达中转节点）——App 即蓝牙版的 Broker。状态机 `pending → delivered → success/failed/offline` 与 30s 超时口径（#27④）两链路完全一致。
> ✅ App→头盔的 BLE 写入 = v0.6 `0x03 WRITE [首地址 1B][数据 NB]`，逐键单写不连写（键→寄存器映射见 `app/src/services/ble/protocol.ts`）；头盔应答的错误码即回执 errorCode（EVENTS.md §6 码表）。
> ✅ 反向对齐（决策 #45）：App 每次握手完成后发 `READ 0x20 长度 0x0E` 把 14 个设置寄存器一次读回，翻成键值经 `POST /devices/{id}/settings/reported` 上报，云端显示随头盔实际状态校正（大灯 0x26 掉电不保存）。


命令消息（云 → 设备，格式细节在 EVENTS.md 定稿）：

```json
{ "commandId": "uuid", "type": "set_config", "params": { }, "issuedAt": "ISO8601" }
```

回执（设备 → 云）：

```json
{ "commandId": "uuid", "result": "success | failed", "errorCode": "可选", "executedAt": "ISO8601" }
```

- 服务端命令状态机：`pending → delivered → success / failed / offline`。✅
- 设备离线时命令保持 pending（4G 链路是否 Broker 离线暂存取决于 Clean Session 决策 ⏸️；BLE 链路由 App 中转，WS 连接建立时补推存量）；超时未回执标记为 `offline`/超时，**绝不显示为成功**。✅
- 允许远程设置的参数清单及取值范围：✅ 定稿（2026-09-19，决策 #43）= v0.6 内存控制表 0x20–0x2D 共 14 项，键名与范围见 API.md §8 表 / `@helmet/shared` `DEVICE_SETTINGS`；服务端入口按此校验，越界不下发。

## 8. 设备时钟与时间戳

| 项 | 约定 | 状态 |
|----|------|------|
| timestamp | 设备事件发生时间（UTC ISO 8601），设备生成 | ✅ |
| receivedAt | 服务器收到时间，服务端生成落库 | ✅ |
| 时钟偏移处理 | `timestamp` 与 `receivedAt` 偏差超过阈值（默认 5 分钟）且非补传场景时，标记 clock_skew 并以 receivedAt 为业务兜底时间 | ✅ 软件侧默认，阈值可调 |
| 设备对时方式 | ✅ v0.6：App 每次连接握手第 4 步 `TIME SYNC 0x04` 下发 UTC 秒校准头盔 RTC；RTC 晶振漂移 < 1.5 s/天；未校时的事件 Timestamp=0，App 以收到时刻代替 | ⚠️ RTC 掉电是否保持待硬件答（§10 B-9）：若关机归零，离线补传的事件时间会失真 |

## 9. 固件兼容

| 项 | 约定 | 状态 |
|----|------|------|
| firmwareVersion | 每条事件 envelope 携带，服务端落库 | ✅ |
| schemaVersion | 事件结构版本号；服务端按版本兼容解析，未知版本进原始事件表并告警 | ✅ |
| 兼容原则 | Contract 字段只增不改不删（新增为选填）；破坏性变更必须升 schemaVersion 并双方确认 | ✅ |

## 10. 待硬件团队确认清单（2026-09-19 重排；发硬件的完整说明见 `docs/HARDWARE_SYNC_2026-09-18.md`，09-18 已发张森淼，待回复）

**A. 卡工期（本周要答）**

1. 🔴 **实时视频预览四项**（决策 #37，A 线 RTSP Spike 开工硬前置；09-06 列催、09-08 问卷再问，硬件答「先做 BLE」）：① 子码流 rtsp id 与分辨率/帧率/码率；② `rtsp_net_type` 实配值（RTP/UDP 还是 RTP over TCP）；③ 完整拉流 URL 与是否鉴权；④ 热点 SSID/密码规则、头盔 IP 是否固定、并发连接数。附问：能否改 WebRTC（V821 文档称可移植，App 端成本大降）。硬件 08-25 已答部分：主控全志 V821，`sample_smartIPC_demo` 走 RTSP / H.264 / RTP，主子码流按 `rtsp id` 区分（`main_rtsp_id = 0`），文档 <https://docs.aw-ol.com/docs/soc/v821/solution/ipc-camera/>。App 侧影响与降级预案见决策 #37。
2. 🔴 **广播主包（ADV_IND）须携带 16-bit 服务 UUID `0xFEE0`**（2026-09-16 iPhone 真机实测：iOS 锁屏/退后台只允许按服务 UUID 过滤的扫描继续投递，否则断连后无法重连、事件堆在 Flash）。31 字节放得下：Flags 3 + UUID 4 + 名字 15。华为上按 FEE0 过滤扫不到 Mac 仿真器，真机到手复测。

**B. v0.6 手册修正与补充（A 线已按字节流实现，等书面确认或 v0.7）**

3. 例 4 / 4.5 节「0x26 连写 02 5A」把音量写到 0x27（跌倒使能），音量在 0x24；软件逐键单写，请确认固件对连写越界回 `ERR_PARAM_VALUE` 而非写坏 0x27。
4. 握手第 3 步读 0x40 只得 deviceId，固件版本另读 0x00–0x02（软件发两条 READ，请把手册改成两步）。
5. RESEND 补传范围：`0x07` 描述写「高危事件总数」，4.0 表又说位置/心跳走 FIFO 区——`0x08` 只吐四类高危，还是位置/心跳也吐。
6. 示例帧十六进制与十进制标注不一致：例 5/6 `88 79 A2 6A` = 0x6AA27988 = 1789032840（非 1788856200）；例 2/6/7 `ED 4E CD 01 / 17 7C 29 07` = 30.232301° / 120.159255°（非 30.256877 / 120.158231）。软件按字节流实现并作单测夹具，请确认「字节流为准」。
7. obstacle_risk（0x04）载荷格与 collision_risk 合并：确认同布局（15 B），及目标类型是否固定 3、方向固定 1。
8. location_update 地速无无效哨兵（航向 0xFFFF / 精度 0xFF / 海拔 0x7FFF 已定）：无定位时速度传 0 还是别的。
9. RTC 掉电是否保持（有无备电、关机多久内不丢）；否则离线补传事件 Timestamp=0，云端只能记补传时刻，事故时间失真。

**C. 出厂流程（第一台真机到手前定）**

10. deviceId 生成与交接：软件 `provision:batch` 按台生成 deviceId（`helmet_` + 6 位小写十六进制，13 字符，0x40 放得下，后 6 位即广播名）/ deviceSecret / 绑定码，出 CSV + 二维码；产线烧 0x40 并加锁。待答：产线有无按台烧字符串的工具、一批多少台、提前多久给表。
11. deviceSecret 是否现在烧 0x50（MVP BLE 链路不用，v0.6 标「预留 4G」；软件生成的正好 32 字符）。
12. 绑定二维码印制（§11 格式 ①，图由 `provision:batch` 产出）：机身还是说明卡、尺寸、能否按台印不同码。
13. 样机时间与数量（≥ 2 台，安卓与 iPhone 各接一台同时测）。

**D. 对讲机（决策 #20 / #35 ③）**

14. 硬件电台双模兜底做不做：频段 / 功率 / 实测距离（8 月中说评估，无结论）。不做则软件不做频道下发。
15. 若做：配置接口走 Wi-Fi 热点还是 BLE WRITE，参数清单（频道/频率/功率）与取值范围——v0.6 内存表 0x20–0x2D 无对讲机地址。

**E. 后延（不催，留档）**

16. TF 卡视频列表/下载接口（HTTP 文件服务或私有协议）——MVP 后第一迭代（决策 #37）。
17. 视频文件上云路径：SoftAP 模式头盔无外网，经 App 中转或头盔切 STA——影响 EVENTS.md 4.9 `storageKey` 与 COS 上传签名接口；video_ready 不在 BLE 第一期。
18. 4G 扩展时：模组 MQTT over TLS 与证书预置（`dev-mqtt.01weichuang.com:8883`）、MQTT 3.1.1/5.0、各 Topic QoS / Keep Alive / Clean Session、重连退避、`signalLevel` 分级；dev 防火墙 1883 届时按硬件出口 IP 收紧。
19. 休眠/防丢（决策 #31 移出 MVP）：`sleep reason` 集合、`bluetooth_lost` 语义。

**已由 v0.6 关闭（2026-09-19 去标记，不再问硬件）**：BLE 数据协议（决策 #38）；上报频率（位置 5 s 运动 / 静止超 3 min 30 s，心跳 60 s）；断连缓存（≥ 1000 条 / 48 h，高危永不覆盖）；可下发参数清单与错误码表（决策 #43）；GPS 输出 WGS-84；航向/精度/海拔无效值；风险等级/目标类型/方向枚举；对时方式（TIME SYNC）；deviceSecret 写入位置（0x50）。

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
