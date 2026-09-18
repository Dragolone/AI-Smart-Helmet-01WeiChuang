# CLAUDE.md — AI 智能头盔软件项目

> 本文件是整个项目的长期开发约定。Claude Code 和两位开发者在每次开发前都必须先读本文件。
> 状态（2026-08-16）：**Week 1、2 已达成；Week 3–4/5–6/7–8/9–10 B 线全部完成并验收（超前约 6 周）；Week 3–4 A 线 App 主线 UI 已合入 main，双端真机复验后才算关闭。**
> **Week 3–4 B 线（全部合入 main）**：Auth（#19）、设备绑定/凭证/状态快照（#20）、EMQX 设备认证 + Topic ACL（#22/#23）、raw_events source/clock_skew（#18）、**Admin 基础（#26，验收通过）**、MQTT 订阅重试修复（#27）。Admin 认证口径见 API.md §10（独立 admin_users + ADMIN_JWT_SECRET，12h 无 refresh）。
> **Week 5–6 B 线 + shared（#29/#30，负责人 2026-08-15 验收通过）**：packages/shared 落 TS 类型（Contract 编译期约束，四端引用）；location_points 表 + latest/轨迹查询 API（24h 上限定稿）+ **WebSocket 实时通道（原生 ws，决策 #25）**；**滑雪场景**：altitude 全链路透传、Mock 新增 SCENARIO=ski 滑雪剧本。
> **Week 7–8 B 线（#35/#38/#37，负责人 2026-08-16 逐步实测验收通过）**：紧急联系人（上限 5 定稿）；**服务端 SOS 状态机**（决策 #8/#26：60s 倒计时服务器时间权威、取消/确认、到期扫描、**重启接管实测通过**、通知重试留档、并发合并规则定稿）；Push/SMS Provider 薄接口 + Console Mock；事故记录查询（App + Admin，通知手机号接口层脱敏）；Mock 新增 SCENARIO=fall/sos。**B 线下一任务：Week 9–10（危险事件 + 设置下发 + 对讲后端）**（先出方案）。
> **Week 9–10 B 线（#40–#45，负责人 2026-08-16 实测验收通过；六口径见决策 #27）**：事件查询 API + WS 五类推送补齐 + Mock SCENARIO=risk；媒体表 + StorageProvider + 预签名 URL（10min 定稿）；**命令与回执状态机**（delivered=PUBACK、30s 超时 offline、仅 success 写入生效设置——"绝不把未执行显示为成功"实测钉死）；**对讲后端**（频道/邀请码/成员 + TRTC UserSig 自实现，Key 待 A 提供后补验）；Admin 事故/事件两页 + /admin/events。**B 线主线功能至此全部完成；下一步：联调准备与 A 线支援（见 weekly-plan Week 9–10 遗留与 A 线待办）。**
> **产品形态更新（2026-08-16，汤总拍板，决策 #28–#31，全部定稿）**：**双产品形态都进 MVP**——4G 版（=现有全部实现）+ **蓝牙版**（头盔经 BLE→App 中转→HTTP `/ingest/app-relay`→统一 Ingest；MVP 第一期中转 7 种事件，视频不走 BLE 走 SD+Wi-Fi，Contract 见 DEVICE_PROTOCOL §1.1 / API.md §12.1）；SOS 维持 60s 倒计时（对外口径「秒级检测、倒计时确认后自动通知」）；家属查看事故走「临时分享链接」排 MVP 后；**休眠/防丢正式移出 MVP**。**app-relay 中转入口已实现并验收（#49，2026-08-16）**——中转的 possible_fall 实测触发 SOS 状态机，蓝牙版与 4G 版业务层等价；Admin §10.2 规划端点亦已清零（#50：设备详情 + 概览统计，概览设为后台首页）。A 线新增 App BLE 中转模块（前置：硬件 BLE 协议，联调清单已发）。**B 线开发项已全部清零，转入「等外部件」状态：~~云服务器~~（**development 环境 2026-09-06 已上线并验收**：`dev-api`/`dev-admin`/`dev-mqtt.01weichuang.com`，手册 docs/DEPLOYMENT.md）、~~高德 Key~~（个人 Key 已到位，A 线地图已落地；企业认证 2026-09-06 已完成）、张森淼清单回复（→联调/蓝牙版）、TRTC Key（→补验）。**
> **链路形态更新（2026-08-24，硬件张森淼确认，决策 #35）**：**MVP 头盔不装 4G**（硬件「后面我们再扩展成 4G」）→ **BLE 成为唯一真机数据链路**（7 种事件范围不变，决策 #31 全部有效）；新增 **Wi-Fi 2.4G 近场通道**（头盔作 SoftAP、手机连头盔热点），用途仅三项：**实时视频预览 / TF 卡视频读取 / 对讲机配置**，**不承载事件数据**；4G/MQTT/EMQX 全链路代码保留不动，MVP 期间由 Mock Device 驱动。🔴 **待决**：① 无 4G 时「摔倒自动通知」依赖手机在身边且 App 运行，对外口径（决策 #28）必须补此前提。~~② 视频功能进不进 MVP~~ → **已拍板（2026-09-01，汤总，决策 #37）：实时视频预览进 MVP（A 线新增 RTSP 播放器双端 Spike → 预览页），TF 卡读取排 MVP 后第一迭代**。Wi-Fi 侧传输细节与 BLE 协议均待硬件提供（DEVICE_PROTOCOL §10；视频四项缺口已升级为 Spike 开工硬前置）。
> **A 线**：4/5 Spike 双端通过且结论已定案入 DECISIONS.md（TRTC 选型、定位持续监听口径、双 Bundle ID 口径）；expo-dev-client 双端落地。**Week 3–4 App 主线 UI 已合入 main（546e84a）**：注册/登录/我的设备/绑定/设备详情五页、Stack.Protected 登录门控、API 客户端（401 静默刷新 + 请求排队）、Zustand 会话 + expo-secure-store、错误码规范化文案。**Week 3–4 双端真机 DoD 已通过（2026-08-16）**：华为 P30 Pro 全流程（注册→绑定→实时状态→会话恢复）+ iPhone 14 Pro Max 同账号跨设备同步验证，附加修复登录门控 iOS 卡死（Stack.Protected）。**Week 3–4 已由负责人合验关闭（2026-08-17）。****地图已定案并落地（2026-08-16）**：高德个人 Key 到位当日完成 Spike 双路线补测，定案 WebView + JS API（决策 #33，amap3d iOS 新架构闪退判死）；Week 5–6 地图页主体已实现（Map 组件层 + WS 实时位置 + 轨迹回放 + 分享/导航跳转，实时通道客户端随本链合入，数据面经 Mock 全链路验证，**双端真机实测通过（2026-08-16 负责人确认；iOS 端修复三项：原生标签条 PNG 图标撑爆改 SF Symbols、浮层让位玻璃标签条、WKWebView 暗色渲染绕行）**）。**对讲页双端双账号进房实测通过（2026-08-16 负责人确认）**：修复原生 TRTC 残留会话致进房 -3340 卡死；两账号同房成员显示正常。MVP 明确不做 App 内导航（决策 #32）。剩余：BLE 后台断连（Week 11 防丢前必测）、APNs 远程推送（等公司账号）。**对讲页已接后端频道体系（2026-08-17）**：创建/邀请码加入/成员档案（昵称头像互见）/UserSig 服务端签发（决策 #27⑥），固定演示房间下线；个人资料支持头像上传（data-URI 存 avatarUrl，OSS 就绪换真 URL）。**Week 9–10 A 线补齐（2026-08-17）**：安全事件页（§6 历史+WS 免刷新+详情）、设备设置下发（回执状态流转 UI，未回执绝不显示成功）、SOS 开发快捷触发（app-relay 注入，__DEV__ 门控）——A 线已追平 B 线主线进度。**决策 #36 A 线对接完成（2026-08-25）**：App 已接 WS `device_command` + relay-ack 回执（commandId 去重、幂等重试；BLE 写入为占位——`__DEV__` 视为写入成功并模拟执行，模拟器实测下发→delivered→executed→设置页 success 全链路通过）；上行中转队列骨架已就绪（7 种事件过滤、批量 ≤100、断线保留按原 eventId 补传，`services/ble-relay*.ts`；队列文件持久化与 BLE 库等下次原生重建批次）。**A 线下一任务（清单见 weekly-plan Week 11「A 线当前进度与待办」）：① 云端真机联调（可立即做）；② BLE 中转模块收尾（**硬件 BLE 协议 v0.6 已定稿 2026-09-09，决策 #38，可开工**）；③ RTSP 播放器 Spike → 视频预览页（前置硬件四项参数）。**
> **注册短信验证码 + 找回密码（2026-09-09 负责人拍板，PR feat/sms-verify-code）**：`POST /auth/sms-code`（6 位、5 分钟、60s 限频、日限 10、错 5 次作废，库存哈希）、`register.code` 必填、`POST /auth/reset-password`（成功撤销全部会话）；`SmsProvider` 改模板式并落 `TencentSmsProvider`（配齐 `TENCENT_SMS_*` 六项即真发，否则 Console Mock 打印验证码）；App 注册页已加验证码控件，找回密码页 A 线已完成（2026-09-09，`app/src/app/(auth)/reset-password.tsx`）。
> 第三方（**台账见 `docs/THIRD_PARTY.md`，决策 #34**）：**云厂商统一腾讯云**（服务器/COS/短信/TRTC 同一账号）；**域名复用已备案的 `01weichuang.com` 子域名，ICP 备案免重做**——原 10–20 工作日的备案周期归零，服务器到位即可部署。Apple 公司账号走到 D-U-N-S 建档（待重提）；高德企业认证已完成（2026-09-06，企业 Key 待创建换入）；云服务器已购并部署 development（2026-09-06）；COS/短信/推送待申请；RTC 选型已定案（腾讯 TRTC），个人测试应用可用、正式应用待公司资质。进度明细见 `plan/weekly-plan.md`。仓库：<https://github.com/Dragolone/AI-Smart-Helmet-01WeiChuang>
> 已拍板的技术决策记录在 `docs/DECISIONS.md`，**不允许无理由重新推翻**。

---

## Project Overview

AI 智能头盔的**软件系统**：手机 App + 云端后端 + 管理后台。

- 硬件团队负责传感器、摄像头、雷达、GPS、蓝牙、Wi-Fi 2.4G（4G 后续扩展）、SOS 按钮、蜂鸣器、休眠等设备底层。
- 算法团队负责物体识别、危险判断、摔倒判断等所有智能判断。
- **软件团队只接收硬件/算法输出的最终结果，完成业务流程**（保存、展示、通知、记录、查询）。

核心原则：**硬件采集 → 算法判断 → 软件接收结果并完成业务流程。**

## MVP Goal

3 个月（约 12 周）内，两名开发者交付可运行、可演示、可后续接真实头盔的软件 MVP：

1. 用户系统 + 设备绑定 + 设备状态（在线/电量/版本）
2. 摔倒（possible_fall）与手动 SOS：服务端 60 秒倒计时状态机、取消、紧急联系人通知、事故记录
3. 危险事件（collision_risk / obstacle_risk）接收、展示、记录、查询、媒体关联
4. 定位、地图、历史轨迹、事故地点、位置分享与导航跳转
5. 管理后台（实用为主）
6. **网络对讲**：头盔作蓝牙耳机，实时语音走 App + RTC 云服务（决策 #20/#21；依赖手机蜂窝网络覆盖）
7. ~~休眠/防丢的软件配合~~——**已移出 MVP**（决策 #31，为蓝牙版让路；MVP 后第一迭代）
8. **BLE 中转链路**（决策 #29/#31/#35）：头盔经 BLE→App 中转→统一 Ingest，中转 7 种事件（保命链路 + 危险留档完整）——**决策 #35 后为 MVP 唯一真机数据链路**；视频不走 BLE（SD 卡 + Wi-Fi 2.4G 近场读取）

硬件/算法接口未就绪前，全部功能用 **Mock Device Simulator** 驱动，软件必须能独立运行和演示。

## Platform Policy（双端硬性要求）

**Android 和 iOS 都是 MVP 必须交付的平台。这是硬性要求，不可协商。**

- 所有核心功能（注册登录、绑定、设备状态、地图定位、轨迹、SOS 倒计时、紧急联系人、Push、危险事件、事故记录、媒体查看、设备设置、休眠状态、BLE 防丢）**双端都必须完成、可安装、可测试、可演示**。
- 禁止：Android 主 iOS 次、Android 全部做完最后补 iOS、某核心功能只在单端支持。
- 双端**同步开发**：一个 Feature 的 Android 与 iOS 在同一个开发周期内完成并验收。
- 应用商店正式上架审核不作为 MVP 验收条件，但 iOS 必须可通过 TestFlight/Ad Hoc 安装到真机完成全部功能。
- **不允许静默降级**：某功能在某平台受系统限制（尤其 iOS 后台 BLE / 后台任务），必须在实现前明确指出、记录到 docs/DEVELOPMENT.md「平台限制清单」，并与负责人确认口径。
- 涉及原生能力的库选型，必须**同时验证 Android 与 iOS 真机**后才算选定，定案写入 docs/DECISIONS.md。

## Team Scope（我们负责）

App、云端服务、数据库、管理后台、设备数据接入、事件业务流程、通知（推送/短信）、媒体元数据管理、Mock 设备模拟器、部署。

## Out of Scope（不属于我们）

- 硬件驱动、固件、传感器读取、视频采集、设备休眠/唤醒的真正执行、蓝牙底层
- 车辆/行人/障碍物识别、多传感器融合、摔倒判断、风险等级判断、模型训练与精度
- 定位精度、识别准确率、蓝牙实际距离、网络可达性等物理效果
- 毫秒级本地告警（蜂鸣/振动）由头盔本地执行，软件只做展示与留档
- “道路 AI 大模型”本体建设（MVP 只保证数据规范保存、可被未来 AI 服务读取）

**软件绝不基于原始传感器数据做任何判断。** 上游必须给出结构化最终结果。

## Architecture

**模块化单体（Modular Monolith）**。使用 MQTT 不改变这一点：禁止微服务、Kubernetes、Kafka、RabbitMQ、Redis、CQRS、Event Sourcing，除非有充分且被确认的理由。

```text
真实头盔(4G, 后续扩展) ──MQTT──→ ┐
Mock Device Simulator ──MQTT──→ ├─ EMQX Broker ──→ ┌────────────────────────┐
                                ┘                   │   NestJS 后端（单体）    │
云端算法服务(如有) ────HTTP Webhook ───────────────→ │   统一 Ingest 层        │
                                                    │        ↓               │
                                                    │   业务模块              │
                                                    │   Provider 层(Push/SMS/│
                                                    │   Storage, 各有 Mock)  │
                                                    └───┬──────────┬────────┘
                                                        ▼          ▼
                                                  PostgreSQL   对象存储
                                                        ▲
                                        REST / WebSocket / Push
                              ┌─────────────┴─────────────┐
                    用户 App（RN + Expo，双端）      管理后台（React + AntD）
                    地图 SDK 在 App 端接入

MVP 唯一真机链路（决策 #35，硬件不装 4G）：
    真实头盔 ──BLE──→ 手机 App 中转模块 ──HTTPS(/ingest/app-relay)──→ 统一 Ingest 层
    上图 4G/MQTT 链路代码已就绪，等硬件后续扩展 4G；MVP 期间由 Mock Device 驱动。

Wi-Fi 2.4G 近场（头盔作 SoftAP，手机连头盔热点，不经云端、不传事件数据）：
    手机 App ←── Wi-Fi ──→ 头盔：实时视频预览 / TF 卡视频读取 / 对讲机配置
```

### 数据接入（统一 Ingest / Adapter Layer）

三个入口，一个汇聚点：

- **设备（真机/Mock）→ MQTT → EMQX → 后端 MQTT 消费者**：设备类长连接通信走 MQTT。
- **云端算法服务（如有）→ HTTP Webhook → 后端**：服务器对服务器调用，**不经过 EMQX**——算法服务不是设备，没有弱网/长连接需求，HTTP + 鉴权最简单可靠。
- 全部入口进**统一 Ingest 层**（校验、eventId 幂等去重、格式适配）→ Internal Event → 业务模块。
- 业务模块不允许知道事件来源；业务代码禁止 `if (isMock)` 类分支。
- 未知 eventType / 校验失败的事件：记入原始事件表并告警，不进业务流程、不丢弃。

### SOS 状态机（服务端权威，App 只是显示器）

```text
possible_fall / manual_sos 事件
  ↓ Backend 创建 SOS/Accident（eventId 幂等，重复上报不重复建单）
  ↓ 服务端计算 deadline，与状态一起持久化到 PostgreSQL
  ↓ App 收到 deadline（WebSocket/Push），本地渲染 60、59、58…
  ↓ 用户可 Cancel（→ cancelled）或 SOS Now（→ 立即通知）
  ↓ deadline 到期未取消 → 服务端发通知（Push + SMS）→ notified
```

- deadline 与状态必须持久化；App 被杀、手机断网不影响服务端最终判断。
- **禁止仅依赖 setTimeout / 内存 timer**：用「PostgreSQL 持久化 deadline + 后台周期扫描任务」触发到期处理。
- **后端重启恢复**：启动时查询所有 `status = pending 且 deadline 未处理` 的 SOS 重新纳入调度。
- 通知记录成功/失败，失败按规则重试或切换通道。不引入 Redis / 专用任务队列。

### 设备通信（已确认）

**MVP 形态（决策 #35，硬件 2026-08-24 确认）：头盔不装 4G，数据经 BLE → 手机 App 中转 → HTTPS `/ingest/app-relay` → 统一 Ingest；Wi-Fi 2.4G 为近场功能通道（头盔作 SoftAP），仅用于实时视频预览 / TF 卡视频读取 / 对讲机配置，不承载事件数据；BLE 同时承担配对与蓝牙耳机（对讲音频）。** 4G 直连 MQTT 链路（决策 #6）代码保留不动，等硬件后续扩展 4G，MVP 期间由 Mock Device 驱动。传输层细节（BLE GATT、Wi-Fi 流协议与接口、TLS、Topic ACL、QoS、重连等）见 `docs/DEVICE_PROTOCOL.md`，其中标注 ⚠️ 的条目待硬件团队提供。

### 第三方 Provider 抽象（按实际归属划分）

- **Backend Provider**：`PushProvider` / `SmsProvider` / `StorageProvider` —— 薄接口 + 各一个 Mock/Console 实现，第三方账号未就绪不阻塞开发。
- **地图属于 App 端**：地图 SDK、展示、导航跳转在 Mobile App 内接入（封装成 App 内部的 Map 组件层，便于换库）；**Backend 只保存坐标和提供位置 API，不建 Backend MapProvider**。未来确有服务端 geocoding/routing 需求时再加，不为抽象提前建设。
- 只做薄接口封装，禁止 Plugin Architecture。

### 设置下发（命令 + 回执）

`pending → delivered → success / failed / offline`；设备离线显示未送达或等待执行，绝不把未执行显示为成功。

## Technology Stack

| 部分 | 选型 | 说明 |
|------|------|------|
| Node 版本 | **Node 24 LTS**（后端、admin、mock-device、工具链统一） | 仓库根放 `.nvmrc` 锁定；禁止使用已 EOL 的 Node 20 |
| App | React Native + **Expo SDK 57（已采用）+ Development Build / Prebuild** | **禁止 Expo Go 作为开发环境**；原生工程由 prebuild 生成，`app/ios`、`app/android` 不进 Git（CNG 工作流）；不用 beta/canary |
| App 路由 | **Expo Router**（正式方案） | Deep Link、Push 点击跳转都按 Expo Router 设计；除非遇到明确无法解决的问题，不重新评估 |
| App 主要库 | TanStack Query、Zustand、react-native-ble-plx | 新增大依赖需双人同意；原生库双端真机验证后定案并记入 DECISIONS.md |
| 后端 | **NestJS (TypeScript, Node 24 LTS)** | REST + WebSocket + MQTT 消费在同一应用 |
| ORM / Migration | **Prisma** | schema 即文档，migration 可审查 |
| 数据库 | **PostgreSQL 16**（单库） | 不用时序库 / Redis / PostGIS |
| MQTT Broker | **EMQX**（Docker） | 协议细节见 docs/DEVICE_PROTOCOL.md |
| 管理后台 | **React + Vite + Ant Design + TanStack Query** | 纯 SPA |
| 地图 | 高德优先（中国大陆市场），**App 端接入** | Week 2 双端真机 Spike 后定库；备用：WebView 内嵌高德 JS API |
| 推送 | 极光/厂商通道 + APNs，经 PushProvider | 未就绪时用开发证书 / Mock Provider |
| 短信 | 阿里云短信（暂定），经 SmsProvider | 未就绪时用 Mock Provider |
| 对象存储 | 云厂商 OSS/COS，预签名 URL 直传，经 StorageProvider | 本地可用 MinIO / 本地磁盘实现 |
| Package Manager | **npm workspaces，单一根 `package-lock.json`** | 禁止各子项目生成不同 package manager 的 lockfile |
| CI | **GitHub Actions** | Week 1 最低要求：install、typecheck、lint、test、build/check 全部可执行 |
| 测试 | Jest + supertest（后端）；App 单测 + 双端手动核心流程清单 | |

**服务器配置不是架构依赖**：最小可用配置（如 2C4G）起步，容量靠升配，业务架构与服务器规格无关。

## Repository Structure

单 **Monorepo**（npm workspaces）：

```text
AI-Smart-Helmet-01WeiChuang/
  .nvmrc              # 锁定 Node 24 LTS
  package.json        # npm workspaces 根
  package-lock.json   # 唯一 lockfile
  app/                # React Native App (Expo Dev Build + Expo Router)
  backend/            # NestJS 后端
  admin/              # 管理后台 (React + Vite)
  mock-device/        # Mock Device Simulator（Node，发 MQTT/HTTP）
  packages/
    shared/           # TS 共享类型：事件 Schema、API DTO、枚举
  plan/
    weekly-plan.md    # 12 周两人分工计划 + 新成员上手指引（每周对表、周五验收）
    onboarding.md     # 新成员从零上手指南（项目理解、名词、上手路线、Claude 协作规矩）
  deploy/             # development/production 部署编排（compose + Caddy + EMQX 模板；手册见 docs/DEPLOYMENT.md）
  docs/
    API.md            # REST API Contract（定义“传什么”给 App/Admin）
    EVENTS.md         # 事件 Contract：定义“传什么”（字段、类型、必填、单位、枚举、值域）
    DEVICE_PROTOCOL.md# 设备协议：定义“怎么传”（MQTT/TLS/ACL/QoS/重连/ACK 等）
    DECISIONS.md      # 已拍板技术决策记录（Date/Decision/Reason/Impact）
    DATABASE.md       # 数据模型设计决策（schema 以 Prisma 为准）
    DEVELOPMENT.md    # 本地环境、常用命令、联调方法、平台限制清单
    DEPLOYMENT.md     # 云端部署手册（development/production，含验收清单与排障）
    DEMO.md           # MVP 演示脚本（给演示者：每步做什么 → 应看到什么；Mock 剧本切换与复位）
    THIRD_PARTY.md    # 第三方账号/Key 状态台账（每周对表）
  .github/workflows/  # GitHub Actions CI
  docker-compose.yml  # 本地 PostgreSQL + EMQX
  CLAUDE.md
```

仓库地址：<https://github.com/Dragolone/AI-Smart-Helmet-01WeiChuang>。本地开发环境搭建与常用命令见 docs/DEVELOPMENT.md。

## Coding Standards

- 全栈 TypeScript，`strict: true`；ESLint + Prettier 统一配置，CI 检查。
- 命名：数据库 snake_case，TS 代码 camelCase，组件 PascalCase，文件 kebab-case（组件文件除外）。
- 时间一律 UTC 存储，ISO 8601 传输，展示层转本地时区。
- 注释只解释“为什么”；不留 AI 生成的冗余注释。
- 不过度抽象：同样的代码出现第三次才考虑抽取（Provider 接口是明确例外）。

## Git Workflow（两人规范）

- 分支模型：**只有 `main` + 短命 feature 分支**，不设 develop。`main` 必须始终可运行。
- 分支命名：`feat/auth`、`feat/device-binding`、`feat/location-map`、`feat/sos`、`fix/...`、`chore/...`。
- 流程：拉最新 `main` → 一个功能一个分支 → 小步提交 → 尽早提 PR → 对方 Review → **Squash Merge** → 删分支。
- 禁止长期巨型分支；PR 原则 < 500 行 diff。Hotfix 从 `main` 开 `fix/` 分支加急走同流程。
- Commit 格式：Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`）。
- **公共文件规则**：修改 `packages/shared`、Prisma schema、docs 下任何 Contract 文件、CI 配置前必须先沟通，PR 必须对方 Review。
- **Migration 规则**：一个 PR 最多一个 migration；创建前先拉最新 main；merge 前 main 有新 migration 则 rebase 后重新生成。
- 环境变量：`.env` 不进 Git；各子项目维护 `.env.example`；secret 走密码管理器。
- Claude Code 产出的代码：**作者本人逐行看懂并自测后才能提 PR**；Review 按人写代码同等标准。
- 每日 10 分钟同步；**每周至少一次 Cross Review / Code Walkthrough**。

## 模块责任（主负责 ≠ 独占）

- **Developer A — Mobile App 主负责**：React Native、UI/UX、地图、定位、Push、BLE、App SOS UI、App 事件 UI。
- **Developer B — Backend 主负责**：NestJS、PostgreSQL、MQTT、Event Ingest、SOS 服务端状态机、Mock Device、管理后台、部署。

两人都必须能运行全部项目、理解对方模块、互相 Review、修基础 Bug。

## API Rules

- REST，前缀 `/api/v1`；管理后台 `/api/v1/admin/*`（独立权限守卫）。
- 认证：App/Admin 用户 JWT（access + refresh）；设备用 deviceId + deviceSecret（详见 docs/DEVICE_PROTOCOL.md），Mock 设备走同一机制。
- 资源复数名词：`/devices/{deviceId}/locations`；分页 `?page=1&pageSize=20` → `{ items, total, page, pageSize }`。
- 时间戳 ISO 8601 UTC；业务主键 UUID v7 / cuid；设备用硬件团队的 deviceId。
- 统一错误格式：`{ "code": "DEVICE_NOT_FOUND", "message": "...", "requestId": "..." }`；客户端依赖 code 不依赖 message。
- 破坏性变更：先改 docs/API.md + packages/shared 并与对方确认，再改实现；后端先合并并对旧字段保持一版兼容。
- Contract-first：先写文档和共享类型，再写实现。

## Event Rules（硬件 / 算法 → 软件）

**docs/EVENTS.md 定义“传什么”，docs/DEVICE_PROTOCOL.md 定义“怎么传”。**

统一 envelope（详见 docs/EVENTS.md）：

```json
{
  "schemaVersion": 1,
  "eventId": "uuid（设备/算法侧生成，幂等去重依据）",
  "deviceId": "helmet_001",
  "eventType": "location_update",
  "timestamp": "2026-08-14T03:00:00Z",
  "firmwareVersion": "1.0.3",
  "payload": { }
}
```

- `timestamp` = 设备侧事件发生时间；`receivedAt` = 服务器收到时间，**由服务器生成并落库**，不由设备上传。设备时钟不可信时以 receivedAt 兜底（规则见 DEVICE_PROTOCOL.md）。
- `location_update` payload 必含：`latitude`、`longitude`、`coordinateSystem`（`wgs84` | `gcj02`，必填，不允许隐含）、`accuracy`（米）、`speed`（米/秒）、`heading`（度，正北为 0 顺时针 0–360）。
- **EVENTS.md 必须写明每个字段的数据类型、必填/选填、单位、枚举与值域；距离、速度、角度等禁止只写 number 不写单位。**
- MVP 事件类型：`device_status`、`location_update`、`possible_fall`、`manual_sos`、`collision_risk`、`obstacle_risk`、`risk_cleared`、`sleep_entered`、`sleep_exited`、`bluetooth_lost`、`video_ready`。
- 服务端按 `eventId` 幂等：重复上报只存一次、只通知一次。
- 所有事件原始 payload 落库（含 confidence、algorithmVersion），供未来 AI 服务读取。

## Mock Data Strategy

- `mock-device/` 与真实设备使用**完全相同**的 Event Contract、MQTT Topic、认证逻辑、字段、eventId 规则。对 Backend 而言 Mock 与真机不可区分。
- 真机接入 = 停 Mock、连真设备，业务代码零改动。**禁止为 Mock 写任何特殊业务逻辑。**
- 剧本化场景：正常骑行、摔倒、SOS、危险事件、休眠、蓝牙丢失、视频就绪；每种事件类型至少一个可重放剧本。
- SMS/Push/Storage 各有 Mock Provider，第三方账号审核中不得阻塞任何业务开发。
- 演示环境常驻 Mock 设备跑剧本，保证随时可 Demo。

## BLE 防丢口径

**禁止承诺“精确 8 米报警”。** 统一口径：

> 当头盔与手机之间的 BLE 连接持续断开、或信号持续异常达到设定条件后，触发防丢提醒。

- 软件模型只处理 `connected` / `disconnected` / `weak signal` / `disconnect duration`；RSSI 不当物理距离。
- iOS 后台 BLE 限制必须实测并记录在 docs/DEVELOPMENT.md 平台限制清单。

## Database Rules

- 单 PostgreSQL；schema 变更只通过 Prisma migration，禁止手改线上库。
- Migration 必须能在空库从头跑通（CI 验证）；不允许编辑已合并的 migration。
- 高频表（location_points、raw_events）：`(device_id, timestamp)` 索引；MVP 不做分区、不引入时序库。
- **位置数据生命周期**：MVP 不实现，但架构不得默认“每 5 秒一个点永久保存”。轨迹查询走服务层不裸查表、时间字段可分区、删旧数据不破坏业务，为未来 Retention / Downsampling / Archive 留余地。
- 软删除仅用于用户可见业务数据；核心表结构变更走公共文件规则。

## Testing Rules

- 后端：业务逻辑单测 + 关键 API 集成测试：注册登录、设备绑定、事件接入去重、**SOS 状态机全路径（含后端重启恢复）**。
- Migration：CI 对空库执行全部 migration。
- App：核心流程手动清单，**Android 真机 + iPhone 真机各过一遍**才算通过；工具函数写单测。
- Mock Device 剧本是端到端测试手段。
- **禁止为通过 CI 删除/跳过测试；禁止为通过测试修改正确的业务逻辑。**

## Security Rules

- 密码 bcrypt/argon2；JWT secret、第三方 key 全部走环境变量；任何 secret 不进 Git；`.env.example` 只放 key 名。
- 设备接口校验 deviceId 与凭证匹配；设备只能 Publish/Subscribe 自己被授权的 Topic（ACL，见 DEVICE_PROTOCOL.md）。
- 用户接口校验资源归属；Admin API 独立角色校验；管理后台不对公网匿名开放。
- 媒体用有时效预签名 URL；日志脱敏（不打印精确坐标、手机号）。

## Development Workflow（每个 Feature 的固定步骤）

**Claude Code 在每个 Feature 开始前必须依次执行：**

1. 阅读本 CLAUDE.md；
2. 阅读相关 Contract（docs/API.md、docs/EVENTS.md、docs/DEVICE_PROTOCOL.md、Prisma schema）与 docs/DECISIONS.md；
3. 阅读相关现有代码；
4. 明确需求（不明确先问，不臆测）；
5. 给出实现方案；
6. 列出计划修改的文件；
7. 说明影响范围：Android / iOS / Backend / Database；
8. 判断是否需要 Migration；
9. 判断是否影响 API Contract；
10. 判断是否影响 Event Contract；
11. **等待人工确认**；
12. 确认后才开始编码。

大型 Feature 严禁“收到需求后直接大量修改代码”。小型修复可简化，但涉及 Contract / Migration / 双端原生能力的一律走完整流程。

### 阶段验收流程

- 项目按 Roadmap 分阶段推进，**每个阶段结束必须由负责人验收后才进入下一阶段**。
- Claude 在每个阶段开始时告诉负责人本阶段目标和步骤；阶段结束时输出**验收清单**：逐条写明「操作步骤 → 预期看到的结果」，让非开发背景也能照着执行验收。
- 验收不通过的项列为本阶段遗留，修复后复验，不带病进入下一阶段。

### Definition of Done（统一标准，含双端）

任何 App 功能：**Android 真机 + iPhone 真机都正常**才算 Done。通用标准：

- App/Admin 可操作；后端逻辑与持久化完成；
- 错误 / 离线 / 权限被拒等边界状态有处理；
- Mock Device / Mock Provider 可完整演示该流程；
- 核心测试通过；`.env.example` / docs 受影响处已更新。

原生能力双端验收示例（同类功能照此原则）：

- **地图**：双端真机地图加载、Marker、Polyline、定位权限流程、错误状态处理均正常。
- **Push**：双端真机可收到；前台、后台分别测试；点击通知进入正确页面（按 Expo Router 路由设计）。
- **BLE**：双端真机验证；权限流程完成；连接/断开可识别；后台行为经实测；系统限制已记录。

## AI / Claude Rules

1. 每次开发前先读本文件、docs/DECISIONS.md、相关 Contract 与现有代码；
2. **docs/DECISIONS.md 中已确认的决策不允许无理由推翻**；确有新证据需要变更时，先说明理由并等负责人确认，再更新 DECISIONS.md；
3. 不擅自更换框架；不擅自升级 major dependency；不擅自引入大型新依赖；
4. 不擅自引入微服务、消息中间件、Redis 等被禁基础设施；
5. 不擅自修改 API Contract、Event Contract、Device Protocol、Prisma 核心 schema——修改前必须说明影响并获确认；
6. 跨多模块改动先给计划再执行；复杂改动先说明方案再动手；
7. 需求不明确先提问；不为“显得专业”过度设计，优先完成 MVP；
8. 写完代码必须自查（编译、lint、相关测试）；
9. 严禁删除/跳过测试来通过 CI；严禁为通过测试修改正确的业务逻辑；
10. 严禁把 Secret / API Key 写入任何会进 Git 的文件；
11. 严禁为 Mock 写特殊业务逻辑；
12. 严禁由软件实现车辆识别 / 摔倒判断，严禁基于原始传感器数据做算法决策；
13. **原生能力必须同时考虑 Android 和 iOS**；某平台有系统限制必须明确指出并记录，**不允许静默降级**；
14. 发现既定技术方向无法可靠支撑双端需求，必须立即提出。

## 环境规划

- `local`：开发机，Docker Compose 起 PostgreSQL + EMQX；Mock Device 与 Mock Provider 本地跑。
- `development`：一台最小可用配置云服务器（Docker Compose：后端 + EMQX + PG），供联调与内部演示。
- `production`：第 11～12 周从 development 配置复制建立；MVP 不设独立 staging。

## 12 周 Roadmap（里程碑基线）

| 周 | 重点 | 出口标准（验收依据） |
|----|------|---------|
| 1 | 架构确认、需求冻结、Repo（npm workspaces + .nvmrc）、GitHub Actions CI（install/typecheck/lint/test/build）、API/Event Contract 初稿、DEVICE_PROTOCOL 初稿、第三方账号申请启动、**Android + iOS Development Build** | **Android 真机和 iPhone 真机都能安装运行基础 App**；CI 全绿 |
| 2 | **双端技术 Spike**：地图、定位、BLE、Push、**RTC 语音（含蓝牙耳机路由、iOS 后台音频）**（双端真机逐项验证，结论记入 DECISIONS.md）；Backend 基础 + PG + MQTT + Mock Device | **确认技术栈可靠支持双端，无重大阻塞**；第一条 Mock 事件经 Ingest 层进入数据库 |
| 3–4 | Auth、设备绑定、设备状态、Admin 基础（双端同步开发） | App 双端完成注册→登录→绑定→看到状态电量 |
| 5–6 | 定位入库、地图当前位置、历史轨迹、WebSocket、Mock 骑行剧本 | 双端地图实时看 Mock 头盔移动并回放轨迹 |
| 7–8 | 紧急联系人、possible_fall、manual_sos、**服务端 SOS 状态机**、60 秒倒计时、Cancel/SOS Now、Push、SMS、事故记录 | 双端完整演示 SOS 全链路（含超时通知） |
| 9–10 | collision_risk、obstacle_risk、事件历史、媒体关联、设备设置下发、**网络对讲（App + RTC，频道/PTT，决策 #21）**、Admin 对应页面 | 双端危险事件可演示；**双端两台真机对讲通话成功** |
| 11 | 真机硬件/算法联调（若就绪，否则以 Mock 完成 MVP 验收）、**蓝牙版中转链路（B：app-relay 入口；A：App BLE 中转模块，前置=硬件 BLE 协议）**、双端回归、性能、Bug 修复（休眠/防丢已移出 MVP，决策 #31） | 核心链路双端回归清单全绿；蓝牙版保命链路（摔倒→60s→通知）可演示 |
| 12 | 只做：Bug 修复、UI 打磨、部署、Demo、文档、双端最终回归；**不开发大型新功能** | 完整可演示 MVP + 部署与演示文档 |

## 待确认事项

**已确认（记录于 docs/DECISIONS.md）**：MVP 链路 = BLE 中转 + Wi-Fi 2.4G 近场功能通道，4G 后续扩展（决策 #35）；两位开发者均有 iPhone 真机与 macOS；第三方资质由负责人申请；中国大陆市场优先。

**仍开放：**

1. **Apple Developer 公司账号**（进行中，2026-08-15）：公司专用 Apple ID 已建（QQ 邮箱 3840404902，凭证入密码库共享）、管理人实名通过、Organization 流程已走到 **D-U-N-S 邓白氏建档**（提交遇接口故障待重提；建档 1–7 个工作日出编码 → 回 Apple Developer App 填 Organization Details → 付 ¥688 → Apple 审核可能电话核实公司）。真机当前用个人开发证书（7 天过期需重装），TestFlight 与正式推送需公司账号。**正式包名/Bundle ID 已切换为 `com.lingyiweichuang.app`，显示名「零一唯创」（汤总 2026-09-10 拍板，A 线 2026-09-16 落地；原开发期 `com.dravenzhong.helmet` 弃用）**；高德 Key 绑定与 App 备案用此二值。公司信息：深圳零一唯创科技有限公司 / 91440300MAK7XEPD38 / 深圳市坪山区龙田街道竹坑社区翠景路33号3栋坪山工匠园402（最新地址，以此为准）。
2. **RTC 云服务账号**：选型已定案腾讯 TRTC（DECISIONS.md，2026-08-15）；当前用个人测试应用，正式应用/Key 待公司资质就绪后创建。
3. **短信签名/模板、地图企业 Key、推送厂商通道、云服务器、HTTPS 证书**：负责人启动申请；审核期间开发用 Mock Provider，不阻塞。**完整台账见 `docs/THIRD_PARTY.md`**（每周对表）。（进度 2026-08-16：云厂商统一腾讯云、域名走 `01weichuang.com` 子域名且**备案免重做**——决策 #34；高德个人 Key 已到位、**企业认证已完成（2026-09-06）**；云服务器已部署 development（2026-09-06）；COS/短信/推送待启动。）
4. **DEVICE_PROTOCOL.md 中标 ⚠️ 的传输层细节**：待硬件团队在联调前（最晚 Week 10）逐项确认。
5. **硬件对讲电台（双模兜底）**：频段/功率/实测距离由硬件团队评估（决策 #20）；软件仅承担频道设置下发。
