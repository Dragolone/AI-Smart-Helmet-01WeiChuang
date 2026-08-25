# A 线交接：链路形态变更后你要做的事（2026-08-25）

> **给 Developer A 与 A 线的 Claude**：这是 B 线（负责人）写给你的一次性交接文档。
> 读完、把任务消化进你的工作流后，**本文件可以删掉**（`git rm docs/handoff-a-line-20260825.md`，提交信息 `docs: 移除已消化的 A 线交接文档` 即可）——它的全部内容都有正式出处（DECISIONS / DEVICE_PROTOCOL / API.md），本文件只是导读，不是 Contract 本体。
> **A 线的 Claude 请注意**：开工前照旧先读 CLAUDE.md 全文与下面「必读清单」，本文件不取代那套流程。

---

## 一、发生了什么（30 秒版）

1. **硬件确认（2026-08-24/25，张森淼微信）：MVP 头盔不装 4G**（「后面我们再扩展成 4G」）。→ **决策 #35**
2. 因此 **BLE→App 中转 成为 MVP 唯一真机数据链路**（7 种事件范围不变，决策 #31 全部有效）。
3. 头盔新增 **Wi-Fi 2.4G 近场通道**（头盔发热点、手机连头盔），只用于三件事：**实时视频预览 / TF 卡视频文件读取 / 对讲机配置**——不承载事件数据。视频推流协议已确认为 **RTSP/H.264**（主控全志 V821）。
4. 蓝牙版此前「设置下发没有下行通道」的缺口已由 B 线补齐：**决策 #36（方案 A）已实现并合入 main**——后端经 WS 推命令给 App，App 经 BLE 写头盔，回执走新的 relay-ack 端点。**服务端全部就绪，等你对接。**
5. 顺手修了 main CI 自 8-17 起的 lint 红灯（`users.controller.ts` 头像正则超行宽，3 个 prettier 错，纯格式重排零语义变化）。**以后 push 前请跑 `npm run lint -w backend`（或全量 `npm run lint --workspaces --if-present`）**——CI 红了会挡住所有人的 PR。

## 二、必读清单（按顺序，Claude 开工前必须读）

| 文件 | 读哪里 | 为什么 |
|---|---|---|
| `CLAUDE.md` | 顶部状态段（产品/链路形态更新两段） | 全局现状 |
| `docs/DECISIONS.md` | **#35、#36**（表末两条）+ 待定表 | 这次变更的权威记录 |
| `docs/DEVICE_PROTOCOL.md` | §1 / §1.1 / §7（BLE 下行）/ §10（联调清单） | 链路怎么走、还缺什么 |
| `docs/API.md` | §8（relay-ack）/ §11（device_command + 连接补推）/ §12.1（app-relay） | 你要调的接口 |
| `packages/shared/src/api.ts` | `WsDeviceCommandData` / `RelayAckRequest` / `RelayAckResponse` | 编译期类型，直接 import |
| `mock-device/src/relay-transport.ts` | 全文（约 250 行） | **App 中转模块的参考实现**——它模拟的正是你要写的东西（同 Contract 同行为），照抄逻辑换成 RN + BLE 即可 |

## 三、A 线任务（按优先级）

### 任务 1（可立即开工）：App 接入 WS 下行命令 + relay-ack

这是决策 #36 里 A 线的三件事，**不依赖硬件**，服务端已实现并有 e2e 保障：

1. **监听 WS `device_command` 消息**（你们的 WS 客户端已在地图页用过，同一条连接）：
   - 新命令实时推；**连接建立时服务端会把 pending/delivered 存量补推一遍**——必须按 `commandId` 去重（重复收到不重复执行）；
   - 消息 data：`{ deviceId, commandId, type, params, issuedAt }`（类型 `WsDeviceCommandData`）。
2. **经 BLE 写给头盔**——这步等硬件 GATT 协议，当前先留接口打日志（或在 `__DEV__` 下直接视为写入成功，方便联调）。
3. **提交回执** `POST /api/v1/devices/{deviceId}/commands/{commandId}/relay-ack`：
   - 写入头盔成功后 → `{ "stage": "delivered" }`；
   - 头盔回执行结果后 → `{ "stage": "executed", "result": "success"|"failed", "errorCode"?, "executedAt"? }`；
   - **幂等不报错**：重复提交、终态后再提交都返回 200 + 当前状态，不用做错误分支；
   - 设置页现有的回执状态流转 UI **不用改**——状态机与语义完全不变（`pending → delivered → success/failed/offline`，30s 超时）。

**本地验证方法**（不需要硬件）：起后端 + `PUT /devices/{id}/settings` 下发一条 → 你的 App 应收到 WS 消息并完成回执 → 设置页显示 success。也可对照跑 `TRANSPORT=app-relay` 模式的 mock-device（`docs/DEVELOPMENT.md` 常用命令表有完整用法）看正确行为长什么样。

### 任务 2（骨架可先搭，收尾等硬件）：App BLE 中转模块（上行）

蓝牙版核心（决策 #29/#31/#35）。**BLE GATT 协议是硬前置**（联调清单第 1 条，已催张森淼），但以下部分不依赖协议、可先写：

- 事件队列 + 批量提交 `POST /api/v1/ingest/app-relay`（单批 ≤100，envelope 原样透传）；
- 断线缓存 + 按**原 eventId** 补传（服务端幂等去重，重复提交返回 `duplicate` 计数，不报错）；
- 7 种事件的本地过滤（`BLE_RELAY_EVENT_TYPES`，shared 里有常量）；
- 队列持久化（App 被杀后补传）。
- 参考实现同上：`mock-device/src/relay-transport.ts`——它的 flush/补传/去重/401 刷新逻辑就是你要的行为。

### 任务 3（知悉即可，先别动手）：实时视频预览

- 硬件方案 RTSP/H.264。**iOS AVPlayer 与 WebView 都不支持 RTSP**——将来要么内嵌 libVLC 系播放器（新架构兼容性存疑，同 amap3d 风险类型，必须双端真机 Spike），要么推动硬件换 WebRTC。
- **是否进 MVP 待汤总拍板**（DECISIONS 待定表有完整分析）。拍板前不投入。

### 任务 4（提醒）：BLE 后台保活实测优先级升高

决策 #35 后 BLE 是**唯一**真机数据链路：手机锁屏/后台时 BLE 中转断了 = 保命链路断。原 Week 11 的「BLE 后台断连实测」（iOS `bluetooth-central` + 华为杀后台）现在是中转模块 DoD 的一部分，结果记入 DEVELOPMENT.md 平台限制清单。

## 四、规矩重申（出过事的两条）

1. **push 前跑 lint**——main 红过一周（§一.5）。
2. 改 `packages/shared`、docs 下 Contract 文件前先和 B 沟通（公共文件规则）；本次你要写的都是 App 侧代码，正常不会碰到。

## 五、有问题找谁

- 接口行为与文档不符 → 直接找 B（服务端有 18 套 e2e，行为以 API.md 为准，发现出入算 B 的 bug）。
- 硬件 BLE 协议进展 → B 在催张森淼，有回复会同步。

*（本文件阅后可删，见文首。）*
