# 两人开发周计划（12 周 MVP）

> 本文档给两位开发者用：写清楚**每周谁做什么、为了实现什么、周末怎么验收**。
> 总纲是 CLAUDE.md（必读），本文只做展开；冲突时以 CLAUDE.md 为准。
> 每周结束由负责人按「验收标准」逐条检查，通过才进入下一周；没通过的列为遗留，修完复验。

## 角色分配

| 角色 | 主负责范围 | 姓名 |
|------|-----------|------|
| **Developer A — App 主负责** | React Native App、UI、地图、定位、Push、BLE、RTC 对讲 App 端、App 端 SOS/事件界面 | （同事，入职后填） |
| **Developer B — Backend 主负责** | NestJS 后端、数据库、MQTT、事件接入、SOS 状态机、Mock 设备、管理后台、部署 | Draven Zhong（Dragolone） |

**主负责 ≠ 独占**：两人都必须能在自己电脑上跑起全部项目、看懂对方的代码、互相 Review。每天固定 10 分钟同步进度和卡点；每周至少一次一起过一遍对方的代码。

## 新成员第一天上手（第一次开发必读）

> 想先建立整体理解（项目在做什么、系统全貌、名词解释、完整上手路线），读同目录的 **[onboarding.md](onboarding.md)**——为第一次开发 App 的新成员专门写的。本节只是环境搭建的操作部分。

### 推荐方式：让 Claude Code 带你

本仓库根目录的 `CLAUDE.md` 是整个项目的开发约定，**Claude Code 打开本项目时会自动读取它**——所以你不需要先看懂全部文档，直接让 Claude 带你走。步骤：

1. 先装好 VS Code 和 Claude Code 插件（或终端 `claude`），装机清单见 `docs/DEVELOPMENT.md` 第 1 节；
2. `git clone` 本仓库（命令见下方），用 VS Code 打开仓库根目录；
3. 打开 Claude Code，把下面这段话原样粘贴发送：

> 我是本项目的新成员，第一次做 App 开发，本地环境还没搭。请先读 CLAUDE.md、docs/DEVELOPMENT.md 和 plan/weekly-plan.md，然后带我一步一步完成环境搭建和全链路验证（Docker、后端、双端模拟器 App），每一步都告诉我要执行什么命令、应该看到什么结果；出错时先解释原因再给解决办法。在我明确要求之前不要写任何业务代码。

4. 全部跑通后，在群里说一声「环境 OK」，然后让 Claude 带你通读已合并的两份 Contract（docs/EVENTS.md、docs/API.md）做事后 Review——有疑问或异议直接在群里提或开 GitHub Issue。

**规矩**（对人和对 Claude 一样）：Claude 产出的代码必须自己逐行看懂并自测后才能提 PR；卡住超过 20 分钟发群里，别闷头折腾。

### 手动方式：照命令逐条执行

目标：把整个项目在自己的 Mac 上跑起来。**照顺序执行，每步都有"应该看到什么"。** 装机细节（Xcode、Android Studio、Docker 等一次性安装）见 `docs/DEVELOPMENT.md`，先装完再回来。

```bash
# 1. 克隆仓库（注意：路径里不能有空格和中文）
git clone https://github.com/Dragolone/AI-Smart-Helmet-01WeiChuang.git
cd AI-Smart-Helmet-01WeiChuang

# 2. 切换到项目锁定的 Node 24（没装 nvm 先看 DEVELOPMENT.md）
nvm install && nvm use          # 应显示 v24.x

# 3. 安装全部依赖（monorepo 一条命令装完）
npm ci

# 4. 启动本地数据库和 MQTT Broker（需要 Docker Desktop 在运行）
docker compose up -d            # 应看到 helmet-postgres 和 helmet-emqx 两个容器

# 5. 配置后端环境变量（一次性）
cp backend/.env.example backend/.env
# 编辑 backend/.env，填入本地数据库地址（凭证来自 docker-compose.yml）：
# DATABASE_URL=postgresql://helmet:helmet_local_dev@localhost:5432/helmet

# 6. 初始化数据库表（一次性；也会顺带生成 Prisma 客户端代码）
cd backend && npx prisma migrate dev && cd ..

# 7. 启动后端
npm run start:dev -w backend
# 浏览器开 http://localhost:3000/api/v1/health 应看到 {"status":"ok","database":"connected"}

# 8. 启动 App（另开一个终端；首次构建 10 分钟级别，属正常）
cd app
npx expo run:ios                # iOS 模拟器打开 App，看到欢迎页
npx expo run:android            # Android 模拟器同理（需先在 Android Studio 里启动一个模拟器）
```

全部走通后，在群里说一声「环境 OK」——这本身就是 Week 2 的一项验收。卡在任何一步超过 20 分钟：截图报错发群里，不要自己闷头折腾。

**日常开发节奏**（详见 CLAUDE.md「Git Workflow」）：拉最新 main → 开 `feat/xxx` 分支 → 小步提交 → 提 PR → 对方 Review → Squash Merge。禁止直接往 main 上推代码；PR 尽量小于 500 行。

---

## Week 1（✅ 出口标准已达成，2026-08-14）：地基

**为了实现什么**：定死架构和规则，把仓库、CI、文档、本地环境全部立起来——让后面 11 周只管写功能，不再折腾环境和方向。

已完成：架构定稿、仓库 + CI 全绿、三份 Contract 初稿合入 main、双端模拟器运行、**双端真机安装验证**（iPhone 13 Pro Max + 华为 P30 Pro）、开发期包名 `com.dravenzhong.helmet`。

唯一顺延项：**第三方账号申请启动**（负责人，Week 2 内完成即可）。注意清单已更新：**RTC 云服务账号（腾讯云 TRTC / 声网）与 Apple Developer 并列第一优先**——Week 2 Spike 就要用（决策 #21）。

**期间新增需求（老板，已定案）**：滑雪场景三项必保功能。①受伤定位 → 既有 SOS 链路（Week 7–8）；②后方靠近预警 → 既有 collision_risk 链路（Week 9–10）；③**网络对讲进 MVP**（决策 #20/#21，方案 A：排 Week 9–10，休眠/防丢让路顺延 Week 11）。硬件对讲电台（无信号双模兜底）属纯硬件功能，硬件团队评估中，软件仅做频道设置下发。

## Week 2：技术验证 + 第一条数据链路

**为了实现什么**：把 MVP 里所有「有技术风险的东西」提前验证掉（地图、定位、蓝牙、推送在两个平台是否都可靠可用），同时打通「设备 → MQTT → 后端 → 数据库」这条最核心的数据管道。这周结束后，项目就不应该再存在"不知道能不能做"的问题。

| 谁 | 做什么 | 为了什么 |
|----|--------|----------|
| A | 地图 Spike：高德 RN 库 vs WebView JS API，双端真机验证地图加载、Marker、轨迹线，结论记入 DECISIONS.md | 定死地图技术方案，Week 5–6 直接用 |
| A | 定位权限流程 + 拿到真实坐标（双端） | 验证定位链路，为轨迹功能铺路 |
| A | BLE Spike：react-native-ble-plx 双端连接/断开检测，重点实测 iOS 后台行为并记录 | BLE 防丢是 Week 9–10 功能，风险最大，必须提前探明 |
| A | Push 基础验证（本地通知 + 开发证书） | SOS 通知链路的前置 |
| A | **RTC 语音 Spike**：腾讯云 TRTC vs 声网 Demo 双端真机跑通（重点：蓝牙耳机音频路由、iOS 后台音频） | 网络对讲已进 MVP（决策 #21），Week 9–10 直接用，选型此周定案 |
| B | Prisma 接入 + 首个 migration（users / devices / raw_events） | 数据库地基 |
| B | 后端 MQTT 消费者接 EMQX + 统一 Ingest 层骨架（校验、eventId 幂等去重、原始落库） | 所有设备数据的唯一入口，后面每个功能都踩在它上面 |
| B | Mock Device v1：按 EVENTS.md 连 MQTT 发 location_update | 硬件没就绪前的"假头盔"，全项目的演示和测试都靠它 |
| 共同 | 新成员环境上手（见上文）；Contract 定稿后在 packages/shared 落 TS 类型 | 环境文档验真；前后端共用一套类型不再对字段 |

**验收标准**：① Mock Device 发一条 location_update，能在数据库表里查到这条记录；② 四个 Spike 双端真机结论写进 DECISIONS.md，无"无法支持"的红灯项。

### 进度记录（2026-08-15）

**B 线（已合入 main，PR #11–#15）**

- ✅ Prisma 接入 + 首个 migration（users / devices / raw_events 三表）+ /health 健康检查
- ✅ MQTT 消费者接 EMQX + 统一 Ingest 层：envelope 校验、eventId 幂等去重、无效事件 `_invalid` 留档、入库成功才 PUBACK、持久会话、优雅停机
- ✅ Mock Device v1：骑行剧本 + 心跳，与真机同 Contract/Topic/QoS
- ✅ 全量代码审查 33 项确认：19 项已修，6 项排入 Week 3–4（EMQX 认证+ACL、clock_skew/source migration、expo-dev-client 等）
- → B 线下一任务：Week 3 Auth 方案

**A 线（分支 feat/spike-location，PR #21）**

- ✅ 验收① 达成：Mock Device → EMQX → Ingest → PostgreSQL 全链路在新成员机器跑通（17 条事件入库；幂等去重与 `_invalid` 留档同步验证）
- ✅ 定位 Spike 双端通过：华为 P30 Pro（无 GMS）精度收敛至 5m、iPhone 14 Pro Max 15m；结论：正式功能须用持续监听而非一次性获取（冷启动锁星慢）；原始坐标为 WGS-84，接高德前须转 GCJ-02
- ✅ Push Spike 双端通过（本地通知：权限/通道/定时/后台弹出）；⚠️ APNs 远程推送个人团队无法签名，待公司账号
- ✅ BLE Spike 双端通过（前台扫描/连接/断开检测，react-native-ble-plx 3.5.1 兼容 RN 新架构）；⚠️ 后台断连检测未测，Week 11 防丢开发前必补（iOS bluetooth-central + 华为杀后台）
- ✅ RTC Spike 双端全关卡通过（腾讯 TRTC）：双机对讲互通（进房 243/251ms）、锁屏后台音频、蓝牙耳机路由——**选型证据齐备，待负责人确认后写入 DECISIONS.md 定案**
- ✅ 地图 Spike（2026-08-16，个人 Key 到位后补测）：路线 B（WebView + JS API）双端通过；路线 A（react-native-amap3d）Android 通过但 iOS 定位闪退（新架构不兼容，源码级确认）→ 定案路线 B，见决策 #33。附带发现：高德境外无底图（海外开发注意，见 DEVELOPMENT.md 平台限制清单）
- 环境新发现已记入 docs/DEVELOPMENT.md：Android 构建需 JDK 17；Bundle ID 跨个人团队冲突（公司 Apple Developer 账号加急的实证）

## Week 3–4：用户系统 + 设备绑定

**为了实现什么**：App 有真实的用户和设备了——用户能注册登录、把（Mock）头盔绑到自己账号、看到头盔在线/电量状态。这是后面一切功能的前提：没有"谁的设备"，就没有"谁的轨迹、谁的 SOS"。

| 谁 | 做什么 | 为了什么 | 状态 |
|----|--------|----------|------|
| A | App：注册/登录页、Token 管理、设备绑定流程 UI、设备状态页（在线/电量/固件版本） | 用户拿到手机第一眼的完整闭环 | ✅ 代码合入 main（546e84a）；**双端真机 DoD 通过（2026-08-16）**：华为 P30 Pro 走「注册→绑定 helmet_37580c→在线状态实时刷新→退出重登→杀进程重开」全流程；iPhone 14 Pro Max 同账号跨设备登录直接看到 P30 上绑定的设备（服务端权威多端同步验证）；待负责人合验关闭 |
| B | 后端：Auth 模块（JWT access+refresh）、设备绑定 API、device_status 事件入库并透出状态 API | 支撑 A 的全部界面 | ✅ PR #19/#20（含开通脚本、状态快照、在线判定） |
| B | Admin 基础：管理员登录 + 用户/设备列表页 | 运营侧从第一天就能看到数据 | ✅ PR #26（前后端 + e2e 双向 token 隔离；负责人 2026-08-15 验收通过） |
| B | **设备接入安全**：EMQX 认证对接后端（设备凭证校验）+ Topic ACL + 后端消费者自身凭证 | 原审查高危项 | ✅ PR #22/#23（三连验收：匿名拒、正凭证通、越权丢） |
| B | 小 migration：raw_events 补 clock_skew 标记 + source 字段 | 兑现 DEVICE_PROTOCOL §8 / EVENTS.md §1 承诺字段 | ✅ PR #18（复合幂等评估仍待硬件确认 eventId 规则） |
| A | App 基建：安装 expo-dev-client 并双端重装验证 | 杜绝误入 Expo Go；获得开发者菜单 | ✅ 2026-08-15 |
| 共同 | 双端同步开发：每个功能 Android 和 iOS 同周完成 | 项目铁律，不允许"iOS 以后补" | 持续 |
| 共同 | packages/shared 落 TS 类型（Contract → 编译期约束） | 前后端字段不一致在编译期报错 | ✅ PR #29（四端引用；App 侧已按 main 定义对齐） |

**验收标准**：双端真机走通「注册 → 登录 → 绑定 Mock 设备 → 看到在线状态和电量」；Admin 里能看到这个用户和设备。
**验收状态：✅ 已关闭（负责人合验 2026-08-17）。** Admin 侧 2026-08-15 已验收；App 侧 2026-08-16 双端真机通过：Android（华为 P30 Pro）注册→绑定→实时状态→会话恢复全流程；iOS（iPhone 14 Pro Max）同账号跨设备登录看到对侧绑定的设备。附加修复：登录门控改用 Stack.Protected（旧 Redirect 写法在 iOS 登录后卡死，已修）。

**B 线补充（2026-08-15）**：修复 MQTT 消费者订阅失败不重试的静默失聪 bug（PR #27，SUBACK 被拒时连着 Broker 却收不到消息）；定位并记录「残留后端进程劫持 EMQX 回调连接池 → 授权 fail-closed 全拒」环境坑（见 DEVELOPMENT.md 已知坑）。Admin 认证口径已定稿于 API.md §10（独立 admin_users 表 + ADMIN_JWT_SECRET，12h 无 refresh）。
**Week 2 遗留待核**：地图 SDK 渲染 Spike（Spike 批次验证了定位但未见地图 SDK 本体；Week 5–6 前必须定案高德 RN 库 vs WebView）。

**A 线进度（2026-08-16）**：Week 3–4 App 主线 UI 合入 main（546e84a）——登录/注册/我的设备/绑定/设备详情五页、Stack.Protected 登录门控、API 客户端（401 静默刷新与并发请求排队）、Zustand 会话 + expo-secure-store、错误码规范化文案；shared 类型与 #29 冲突处以 main 为准，App 侧引用已随之更名。环境提示：联调需要 `JWT_SECRET` / `EMQX_INTERNAL_TOKEN` / `MQTT_BACKEND_USERNAME` / `MQTT_BACKEND_PASSWORD`——这些键 `backend/.env.example` 里都有，本地 `.env` 建的早的照 example 补齐即可（`EMQX_INTERNAL_TOKEN` 本地填 `local_dev_emqx_token`）。
**遗留两项**：① **双端真机复验未做**（仅模拟器验证，见上方验收状态）；② 该批代码**直推 main 未走 PR/Review**，流程口径已与负责人重申——后续功能一律走 `feat/*` 分支 + PR，涉及 `packages/shared` 的改动按公共文件规则必须 Review。

## Week 5–6：定位、地图、轨迹

**为了实现什么**：地图上能实时看到头盔在哪、去过哪——骑行监护的核心画面。同时打通 WebSocket 实时通道，为 SOS 倒计时做技术准备。

| 谁 | 做什么 | 为了什么 | 状态 |
|----|--------|----------|------|
| A | 地图页：当前位置、实时移动（WebSocket）、历史轨迹回放、位置分享与导航跳转 | 用户最常看的页面 | 🔄 **主体已实现（2026-08-16）**：实时数据层（WS 指数退避重连、4401 借 refresh 轮换重连、推送直写 react-query 缓存、REST 兜底）+ 地图库定案 WebView + JS API（决策 #33）+ Map 组件层 + 实时位置/轨迹回放（1/6/24h）/位置分享/导航跳转；**双端真机实测通过（2026-08-16 负责人确认）**；iOS 端三项平台修复见 DEVELOPMENT.md 平台限制清单 |
| B | location_update 入库（高频表索引）、位置/轨迹查询 API、WebSocket 通道 | 数据侧与实时侧支撑 | ✅ PR #30（location_points 表、latest/范围查询 24h 上限定稿、原生 ws 决策 #25、4401 鉴权、定向推送；负责人 2026-08-15 验收通过） |
| B | Mock 骑行剧本：模拟一段真实骑行轨迹循环播放 | 随时可演示"头盔在动" | ✅ Week 2 已有骑行环路；PR #30 新增**滑雪剧本**（SCENARIO=ski，海拔 2110→1790 滑降+缆车循环，负责人滑雪场景需求） |

**验收标准**：双端地图上实时看到 Mock 头盔移动；能选时间段回放轨迹。（B 侧链路 2026-08-15 已实测验收：WS 实时推送含海拔、轨迹正序查询；双端地图待 A 线接入后合验。）

**滑雪场景口径（2026-08-15 负责人提出）**：altitude 全链路透传（位置表单列 → API → WS）；速度不设值域假设；Mock 提供滑雪剧本。受伤定位/后方预警/对讲的映射见 Week 1 备注。

## Week 7–8：SOS 全链路（MVP 最重要的两周）

**为了实现什么**：实现产品的安全核心——摔倒或按 SOS 后，60 秒倒计时，用户可取消；不取消则自动通知紧急联系人。这是整个产品「保命」的承诺，服务端必须做到 App 被杀、断网、后端重启都不丢。

| 谁 | 做什么 | 为了什么 | 状态 |
|----|--------|----------|------|
| A | 紧急联系人管理页；SOS 倒计时全屏页（收到推送/WS 后渲染倒计时、取消、立即求救）；Push 点击跳转 | 用户侧的完整 SOS 体验 | 🔄 后端 API/WS/shared 类型已全备（见下），可开工 |
| B | 服务端 SOS 状态机（deadline 持久化 + 周期扫描 + 重启恢复）、Push/SMS Provider 接入（未就绪用 Mock）、事故记录 | 服务端权威，可靠性全在这里 | ✅ PR #35/#38/#37（负责人 2026-08-16 验收通过，见下） |
| 共同 | SOS 状态机全路径测试（含后端重启恢复）——项目里唯一"必须写足测试"的硬指标 | 保命功能不允许赌运气 | ✅ B 侧已交付（e2e 12 项全路径 + 单测；A 侧 UI 测试随 A 线） |

**验收标准**：双端演示完整链路：Mock 发 possible_fall → 手机弹倒计时 → ① 取消则记录取消；② 不动则 60 秒后紧急联系人收到通知（Mock Provider 打印或真实短信）；后端中途重启不影响结果。

**B 线完成记录（2026-08-16，负责人逐步实测验收通过）**：
- **PR #35 紧急联系人**：CRUD + 上限 5（定稿）+ 软删除；**PR #38 状态机核心**：触发（含并发合并规则，决策 #26）/60s 倒计时（服务器时间权威，clock_skew 免疫）/取消/确认/到期扫描/重启接管/通知重试（≤3 留档）/Provider 薄接口 + Console Mock/WS sos_update/Mock 剧本 SCENARIO=fall|sos；**PR #37 事故查询**：列表/详情（通知手机号接口层脱敏）+ /admin/accidents。
- 验收实测亮点：后端宕机 70s 期间 deadline 到期，重启后 5s 内接管补发通知；且当时 MQTT 通道恰好断连，状态机照常工作（只依赖 PostgreSQL）。
- **A 线待办**：倒计时页消费 `sos_update` WS + `GET sos/active` 兜底 + cancel/confirm；联系人页；事故历史页；Push 点击跳转（data 已带 sosId/deviceId）。真实 SMS/Push Provider 等第三方账号，届时换实现零业务改动。

## Week 9–10：危险事件 + 设置 + 网络对讲（方案 A，决策 #21）

**为了实现什么**：补齐老板必保清单的最后两块——危险提醒留档可查（后方靠近预警的软件侧）、**队友间网络对讲**；外加远程设置下发和对应管理后台。原本排在这里的休眠/防丢顺延到 Week 11。

### A 线进度(2026-08-17,自主推进)

- ✅ **安全事件页**:§6 事件历史(筛选 全部/碰撞/障碍/摔倒求救、多设备聚合、WS 推送免刷新置顶、详情弹层含 riskLevel 徽章与原始 payload);入口在安全中心
- ✅ **设备设置下发**:设备详情页设置区(演示参数 蜂鸣音量/示廓灯,清单待硬件),PUT→回执状态流转 UI(下发中→已送达→执行成功/失败/离线,未回执绝不显示成功),Mock 回执闭环实测
- ✅ **SOS 开发快捷触发**(负责人要求):安全中心 __DEV__ 按钮经 app-relay(§12.1 真实契约)注入 possible_fall/manual_sos/collision_risk——SOS 全链路(注入→状态机→WS→60s 倒计时页自动弹出→取消留档)一键可测
- 未动:App BLE 中转模块(等硬件 BLE 协议,联调清单已发)

| 谁 | 做什么 | 为了什么 | 状态 |
|----|--------|----------|------|
| A | 危险事件列表/详情（含媒体查看）、设备设置页（下发状态展示：绝不把未执行显示为成功） | 老板需求②的用户侧 | 🔄 后端 API/WS/类型全备，可开工 |
| A | **网络对讲 App 端**：频道/队伍 UI、按住说话（PTT）、接 Week 2 定案的 RTC SDK、蓝牙耳机音频路由 | 老板需求③ | 🔄 频道/凭证 API 全备（API.md §13） |
| B | collision_risk/obstacle_risk 入库与查询、video_ready 媒体关联、命令下发与回执状态机、Admin 事件/事故页面 | 数据与状态机支撑 | ✅ PR #40/#41/#42/#44（负责人 2026-08-16 实测验收通过） |
| B | **对讲后端**：频道/成员管理 API、RTC 房间 token 签发（用 RTC 云服务，不自研语音） | 支撑 A 的对讲功能 | ✅ PR #43（UserSig 算法自实现；TRTC Key 待填，见遗留） |

**验收标准**：双端演示：Mock 发危险事件 → App 收到并可查历史；下发一个设置在设备离线时正确显示"未送达"；**两台真机加入同一频道，对讲通话清晰可用（含蓝牙耳机收发）**。

**B 线完成记录（2026-08-16，负责人逐步实测验收通过）**：
- **#40 事件查询**：§6 两端点 + WS 五类推送补齐（risk_event/device_event）+ Mock SCENARIO=risk；危险事件不建专表、当前危险状态 App 端推导（决策 #27①②）。**#41 媒体**：media 表双唯一幂等 + StorageProvider Mock + 预签名 URL（10min 定稿）+ §6 详情媒体关联。**#42 命令状态机**：pending→delivered→success/failed/offline、仅 success 回执写入生效设置、30s 超时判 offline、迟到回执如实覆盖；Mock 自动回执三态（MOCK_CMD_RESULT）。**#43 对讲后端**：频道模型（6 位邀请码/roomId/上限 20，决策 #27⑤）+ TLS-Sig-API-v2 UserSig 自实现（#27⑥）。**#44 Admin**：事故/事件两页 + /admin/events（invalid 视图定稿）。附 **#45**：验收现场抓到并修复 Admin dev 白屏（workspace CJS 包 Vite 预打包配置；教训——vite build 检不出 dev 白屏，**验收必须真打开页面**）。
- 实测验收要点：危险事件三类入列带摘要；媒体换 URL 时效分秒不差；设置离线路径 `delivered→offline` 且旧值不被覆盖（铁律成立）；对讲建频道/邀请码正常、凭证在 Key 未配时明确 503；Admin 两页 1983 条真数据翻页可用。
- **遗留**：① ~~TRTC Key 补验~~ **✅ 已清零（2026-08-16）**：A 提供个人测试应用凭证，填 `backend/.env` 后实测「注册 → 建频道 → 取进房凭证」通过，userSig 正常签发（216 字符 / 24h），**Week 9–10 B 线全部收口**；② 双端合验（App 收危险事件、App 对讲接后端频道管理后的真机复验）待 A 线 UI 完成后按验收标准执行。
- **A 线待办**：危险事件页（§6 + WS risk_event）、媒体查看（§9）、设置页（§8，注意渲染 offline=未送达）、对讲 UI（§13 + TRTC SDK PTT）；接口与 shared 类型全部就绪。

## Week 11：联调与回归（+ 顺延的休眠/防丢）

**为了实现什么**：如果硬件/算法就绪，用真头盔替换 Mock 验证"真机接入零业务改动"的承诺；无论就绪与否，把双端核心链路完整回归一遍，把 Bug 清干净。

- 两人一起：真机硬件联调（若就绪）/ Mock 完成 MVP 验收；双端回归清单逐条过；性能与 Bug 修复。
- ~~自 Week 9–10 顺延的休眠/防丢~~ → **已正式移出 MVP**（决策 #31，2026-08-16，为蓝牙版让路）。
- **链路形态更新（2026-08-24，决策 #35）**：硬件确认 **MVP 头盔不装 4G**（「后面我们再扩展成 4G」）→ **BLE 中转成为唯一真机数据链路**，下面这条从「双形态之一」升为「必做主线」；4G/MQTT 代码保留，MVP 期间由 Mock 驱动。另新增 **Wi-Fi 2.4G 近场通道**（头盔作 SoftAP）：实时视频预览 / TF 卡视频读取 / 对讲机配置——**已拍板（2026-09-01，汤总，决策 #37）：实时视频预览进 MVP，TF 卡读取排 MVP 后第一迭代**，传输细节待硬件提供。
- **实时视频预览（决策 #37，A 线新增，排 WS 下行对接与 BLE 中转骨架之后）**：① **RTSP 播放器双端真机 Spike**（iOS AVPlayer 与 WebView 均不支持 RTSP；候选 libVLC 系播放器——新架构兼容性存疑同 amap3d 风险类型，备选=推动硬件移植 WebRTC，降级预案=`rtsp://` 唤起系统 VLC）；② Spike 定案后开发预览页（连头盔热点引导 + 播放器封装 + 拉流）。**开工硬前置=硬件补四项**：子码流 id/分辨率、`rtsp_net_type` 实配值、拉流 URL 与鉴权、AP 的 SSID/密码/IP（DEVICE_PROTOCOL §10，已催张森淼）。**✅ 四项已到（2026-09-23，硬件发「APP 协议说明 + 无硬件测试包」）：`rtsp://192.168.176.1:8554/ch0`、H.264 720p30、RTSP over TCP、无鉴权、热点 `X821cam`/`Aa123456`——DEVICE_PROTOCOL §1.3；Spike 可开工，无硬件测试流 `tools/rtsp-mock/start_rtsp.sh`。**
- **BLE 中转链路（决策 #29/#31/#35）**：B——`/ingest/app-relay` 中转入口 **✅ 已实现并验收（#49，2026-08-16，负责人 curl 实测中转 fall 触发 SOS）**；A——App BLE 中转模块（收 7 种事件、断线缓存、批量补传、后台保活；**前置=硬件 BLE 协议定义，联调清单第 1 条已发张森淼**）。数据范围与视频边界见 DEVICE_PROTOCOL §1.1。另：Admin §10.2 规划端点已清零（#50 设备详情 + 概览统计，验收通过）。
- **B 线 2026-09-19 收口（硬件回复前可做项，三个 PR）**：设置参数清单落 shared + 服务端按清单校验 + Mock 头盔侧回执（#72，决策 #43）；批量开通脚本 `provision:batch`（#73，产线交接 CSV + 每台绑定二维码）；v0.6 已答 ⚠️ 去标记、§10 重排 A–E、eventId 粒度定案（决策 #44）。硬件待确认 19 条已于 09-18 发张森淼（`docs/HARDWARE_SYNC_2026-09-18.md`）。**09-20 硬件首轮回复**：官方例程板子蓝牙可用、自研固件蓝牙未通、先搞蓝牙；视频先等（看官方例程是否开 Wi-Fi）；对讲机属定制要改 Linux 驱动、需时间；已向硬件发去仿真器 + App 解析代码包。视频 Spike 与样机时间继续悬。
- **验收标准**：核心链路（注册→绑定→轨迹→SOS→危险事件）双端回归清单全绿；**蓝牙版保命链路可演示**（BLE 收 possible_fall → App 中转上云 → 60s 倒计时 → 通知，硬件未就绪则以「App 注入模拟 BLE 数据」验软件侧）。

### A 线当前进度与待办（2026-09-06，B 线整理；A 线直接按此推进，有疑问群里问）

> **📣 给 A 线的通知（2026-09-19，B 线）——四个 PR 已合 main，先看这段**
>
> **这次改了什么，跟你有关的：**
> - `@helmet/shared` 新增 `DEVICE_SETTINGS`（v0.6 内存表 0x20–0x2D 共 14 项：键名 / bool 或 int / 取值范围 / 出厂默认 / 说明）、`checkDeviceSetting()`、`DeviceSettings` 类型、`HELMET_ERROR_CODES`。**服务端 PUT settings 现在按这张表校验**：未知键、类型不符（字符串 "80"、小数、用 1 代替 true）、越界一律 400 `VALIDATION_FAILED`，不创建命令。你现在发的 `volume`（1–100）和 `light`（0–3）都在表内，行为不变。决策 #43，API.md §8 有表。
> - 事件 payload 补记了你 `translateEvent` 附上的原始字段（`impactG` / `tiltDeg`、`triggerMode` / `pressDurationMs`、`ttcSeconds` / `approachSpeedKmh`），EVENTS.md 4.3–4.5 与 shared `EventPayloadMap` 都有了，Mock 剧本也带同名字段。字段名是照你现在发的抄的，想改名两边一起改。
> - 后端新增 `provision:batch`：一次出 N 台 deviceId / 绑定码 + 每台一张二维码（SVG/PNG，§11 格式 ①）。要测试码找我要。
> - 硬件待确认 19 条已于 09-18 发张森淼（`docs/HARDWARE_SYNC_2026-09-18.md`，权威清单 DEVICE_PROTOCOL §10 A–E），视频四项参数在最前面，回了第一时间转你。
>
> **请你测（不等任何人，云端更新到 93bd4a4 之后）：**
> 1. **双端真机回归**：`docs/REGRESSION.md` 的 Android / iOS 两列基本还是空的，这是 Week 11 出口标准。两台真机对云端 dev 从注册到危险事件走一遍，结果直接填表，❌ 附一行现象。
> 2. **设置下发边界**：设备页音量拖到 1 和 100 应正常，云端对越界值会直接 400（App 只会在开发期注入时碰到）；Mock 现在对越界回 `failed + ERR_PARAM_VALUE:<key>`，看一眼回执状态流转 UI 是否把 errorCode 展示对。
> 3. **华为复验扫码绑定**（决策 #42 还挂着「待 Android 验收」）。
>
> **请你改（半天到一天量级）：**
> 4. `app/src/services/ble/protocol.ts` 里 14 个键的范围表与 shared `DEVICE_SETTINGS` 是两份，改成直接引用 shared，以后只改一处；`devicesApi.putSettings` 入参可以换成 `DeviceSettings` 拿编译期约束。
> 5. 事件详情页可以用 `EventPayloadMap` 新字段展示冲击力 / 倾角 / TTC / 逼近速度（真机和 Mock 现在都带）。
> 6. **设备页设置项补齐**：清单 14 项现在只暴露音量和大灯。跌倒检测开关 + 灵敏度、雷达开关 + 预警距离、障碍预警、SOS 按键使能、振动挡位、蜂鸣开关都可以做成开关 / 档位——后端已校验、Mock 已回执。暴露哪些让汤总定，UI 可以先做。
> 7. **Android 正式签名证书**（上线前清单 #1）：keytool 生成、入密码管理器、改 release 签名。现在 release 包还是 debug keystore，不能上架；不依赖任何外部件。
> 8. iOS 一个边界：系统回收进程后 BLE 状态恢复能否拉起 App（`restoreStateIdentifier` 配了但从没触发过），找机会用内存压力测一次，结论记 DEVELOPMENT.md 平台限制清单。
> 9. **设置显示与头盔实际状态对齐**（负责人 2026-09-19 要求，决策 #45；**后端接口已合入 main，云端要等 Draven 更新后才能调**）：云端「当前生效设置」原来只在下发成功时写入，头盔自己变了看不到。最明显的是大灯——v0.6 内存表 0x26「掉电不保存」，头盔重启后回到关，App 设备页和后台却还显示上次的挡位；RECOVERY 恢复出厂、别的手机改过设置同理。
>    - **你要做的**：五步握手完成后多发一条 READ `02 <seq> 20 0E`，把 0x20–0x2D 共 14 字节一次读回；按 `protocol.ts` 的键→寄存器映射反过来翻成键值（布尔项 0/1 → false/true，其余原值），调 `POST /devices/{deviceId}/settings/reported`，body `{ settings }`（类型 `ReportSettingsRequest`）。每次重连都报一次，不用先比对。
>    - **响应**（`ReportSettingsResponse`）：`settings` 是合入后的生效设置，直接写进 react-query 的 `["device-settings", deviceId]` 缓存即可，不用再 GET；`skipped` 里 `recent_command` 是正常情况（有命令在下发或刚成功，以命令为准），`invalid` 说明头盔寄存器里有清单外的值，开发期打日志。
>    - 不用你处理的：并发、与下发命令的先后顺序、非法值——服务端都兜了。
>    - **验收**：设备页把大灯调到低亮 → 成功；仿真器把 0x26 改成 0 模拟重启并断连重连 → 5 s 内设备页与后台都显示「大灯 关」。注意刚下发成功的 30 s 内上报会被跳过，测试时隔 30 s 再断连。
>
> **等硬件回复再动：** ~~视频四项到了开 RTSP Spike~~（✅ 09-23 到了，见下方 09-23 通知）；v0.6 修正确认后核对 protocol.ts 两处假设（obstacle_risk 与 collision_risk 载荷同布局、RESEND 是否只含四类高危）。

> **📣 给 A 线的通知（2026-09-23，B 线）——硬件视频参数到了，RTSP Spike 可以开工**
>
> - 张森淼 09-23 在项目群发了「APP 协议说明 + 无硬件测试包」，已入库 `docs/hardware/APP协议说明-2026-09-23.html`（先读这份，硬件写给 App 的）；定稿摘要在 DEVICE_PROTOCOL §1.3：热点 `X821cam` / `Aa123456`，头盔 `192.168.176.1`，`rtsp://192.168.176.1:8554/ch0`，H.264 720p30 无音频，**RTSP over TCP 强制**，无鉴权。真机热点无互联网。
> - **无硬件测试流**：`tools/rtsp-mock/start_rtsp.sh`（`brew install ffmpeg mediamtx`），电脑起一路同约定的彩条流，脚本打印 `rtsp://<电脑IP>:8554/ch0`，手机和电脑连同一个 Wi-Fi 就能拉；VLC 和 App 可同时拉。
> - **请你做（决策 #37 第 ① 步，双端真机）**：RTSP 播放器 Spike。硬件文档点名的坑：Android 连热点后必须 `bindProcessToNetwork`，否则流量走蜂窝黑屏；iOS 程序化连热点用 `NEHotspotConfiguration`，会弹「无互联网是否仍用」。先对着测试流出画，再等真机热点。结论（选型、新架构兼容、双端延迟）写 DECISIONS.md 后再做预览页。
> - 硬件真机用 VLC 拉流延迟 2–3 s，他们说还要优化；我们这边把实测延迟也记下来，方便对表。
> - 顺带：随包的 v0.6 手册改了例 4（0x23 蜂鸣器开关 + 0x24 音量连写），仓库副本已换新；`protocol.ts` 逐键单写不受影响。
> - **蓝牙工程模式页已加**（硬件 09-23 提的「测试模式」：登录页长按 App 名 3 秒进入，不登录、不上云，14 个编号按钮逐条发指令、每帧 hex + 解释、自动 ACK 开关、日志分享；清单 `docs/BLE_BENCH.md`）。B 线做的 App 侧代码，你 Review：`services/ble-bench.ts`、`services/ble/describe.ts`、`app/ble-bench.tsx`。给硬件的安卓 APK 由 B 打包。

> **📣 A 线回复（2026-09-21）——④⑤⑥⑨ 与 ② 已做完并合 main**
>
> 🔴 **先说一个线上缺陷（决策 #43 的连带影响，已修）**：App 的大灯一直发布尔 `light: true/false`，而 `DEVICE_SETTINGS` 把 light 定义为 int 0–3，服务端按表校验后 **dev 上「大灯 开」从 #43 合并那天起就一直 400**。实测 `PUT {light:true}` → 400 `VALIDATION_FAILED`、`PUT {light:1}` → 202。现在设备页按 0–3 出四档（关/低亮/高亮/爆闪），云端历史存的 `light: true` 按低亮显示、下发一次即自愈。以后新增设置项时请留意：**清单里的类型就是唯一口径，App 不再自己猜。**
>
> - **④ 双份参数表已消除**：`protocol.ts` 只保留「键 → 寄存器地址」，类型与取值范围全部改调 shared `checkDeviceSetting`，两端不可能再对同一个值有不同解释。`settingToRegisterWrite` 现在对类型不符/越界一律返回 null → 回执 failed，与服务端同口径。
> - **⑥ 设备页设置项已补齐**：新组件 `components/device-settings.tsx` 直接按 `DEVICE_SETTINGS` 渲染——bool 出开/关，小范围 int 出档位 chip（大灯、振动、灵敏度），`radarDistance` 出步进器。当前暴露 10 项（跌倒检测/灵敏度、SOS 按键、雷达/预警距离、障碍预警、大灯、振动、蜂鸣、断连蜂鸣），心跳与定位周期属工程参数没给终端用户。**要加/减哪项是一行数组的事**（`EXPOSED_SETTINGS`），汤总定了告诉我。
> - **⑨ App 侧已完成，但需要你重新部署 dev-api**：握手加了 Step 6，读回 `0x20–0x2D` 共 14 字节 → `registersToSettings()` 翻成键值 → 调 `POST /devices/{id}/settings/reported`。排在补传高危事件之后（保命链路优先），读失败或网络不通只记日志、不影响链路。**dev-api 现在这个接口还是 404（云端停在 #43，没到 82df138）**，麻烦你更新一次，我再用仿真器跑「0x26 改 0 模拟重启 → App 重连后设备页显示大灯关」的验收。单测已覆盖读回翻译与上报（含大灯掉电、越界字节丢弃、上报失败不断链）。
> - **⑤ 事件详情已展示新字段**：冲击力/倾角、触发方式/按键时长、预计碰撞时间/逼近速度，有就显示、没有不占位。模拟器对 dev 实测：跌倒事件显示 Impact 4.5 g / Tilt 85°。
> - **② 回执 errorCode 展示已检查并改进**：路径本来就通，但显示的是原始码。现在正文说人话（`ERR_BATTERY_LOW` → 「头盔电量过低，暂时无法修改设置」），原始码留在括号里给技术支持；单测遍历 `HELMET_ERROR_CODES` 保证以后新增的码不会漏文案。
>
> **仍欠着（需要真机/负责人）**：① 双端真机回归（REGRESSION.md 两列 37 行还是空的）、③ 华为复验扫码绑定、⑦ Android 正式签名证书（keytool 我能跑，密码要负责人定并进密码管理器）、⑧ iOS 被系统回收后能否靠 BLE 状态恢复拉起。

> **📣 给 A 线的通知（2026-09-09，B 线）——注册流程变了，请先看这段再动手**
>
> 1. **注册现在必须短信验证码**（负责人拍板）。后端已上线三个接口：`POST /auth/sms-code`、`POST /auth/register`（新增必填 `code`）、`POST /auth/reset-password`；Contract 见 API.md §2，类型在 shared（`SmsCodeRequest` / `RegisterRequest.code` / `ResetPasswordRequest`），`authApi` 已加 `sendSmsCode` / `resetPassword` 两个调用。
> 2. **注册页我已顺手加了验证码输入框 + 60s 倒计时按钮**（为了 CI 不红，最小改动），`app/src/app/(auth)/register.tsx`——请你按现有风格过一遍 UI，觉得不顺眼随便改。**找回密码页没做，归你**：登录页加「忘记密码」入口 → 手机号 + 验证码（`purpose: 'reset_password'`）+ 新密码 → 成功回登录页。约半天，细节见下方待办 ④。
> 3. **本地怎么拿验证码**：短信现在是 Console Mock，码打在后端终端日志 `[MOCK SMS] → 138****0000 [verify_code] 您的验证码为123456…`；连云端时 `docker compose -f docker-compose.prod.yml logs backend | grep verify_code`（让 B 帮你看也行）。真短信要等签名/模板过审 + 运营商报备，约两周。
> 4. **旧账号不受影响**，登录不需要验证码。你本地库里的测试账号照常能登。云端已验收通过并留了一个测试账号：手机 `19900001234` / 密码 `test_password_1`（昵称「云端测试」），直接登录联调即可。
> 5. ✅ **App 正式命名已完成（A 线 2026-09-16：`app.json` name「零一唯创」、`com.lingyiweichuang.app` 双端，prebuild --clean 重建；Xcode 工程名随之变为 `ios/app.xcworkspace`/scheme `app`；高德控制台需把 Android Key 改绑包名 `com.lingyiweichuang.app` + debug SHA1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`、iOS Key 改绑同名 Bundle ID——负责人操作；B 线备案用此二值）**（汤总 2026-09-10 拍板）：显示名与上架名 **「零一唯创」**（不再叫「AI智能头盔」，品牌 App 不限定头盔）；正式包名 / Bundle ID **`com.lingyiweichuang.app`**（安卓包名不能以数字开头，故不用 01weichuang）。请改 `app.json` 的 `name`、`android.package`、`ios.bundleIdentifier` 后 `npx expo prebuild --clean` 重建双端，高德平台 Key 绑定同步改。App 备案要用这两样，改完告诉 B。开屏/图标你已经切成公司品牌，正好对上。
> 📎 **向公司侧索取的资料清单**：`docs/ASSET_REQUESTS.md`（头盔产品图 / 型号与编号规则 / 品牌矢量 / 图标定稿 / 公司与客服信息 / 商店文案等 11 项）——负责人对表跟进。
>
> 6. 🆕 **UI 重设计已落地（2026-09-10，负责人验收设计稿后 B 线实现，PR `feat/ui-redesign`）**：五个主页按定稿重排（设备大卡 + 逐行列表 / 地图去调试条 + 底部信息卡 + 历史轨迹折叠 / 安全状态卡 + 底部 SOS 长按 / 对讲空态按钮下沉 + PTT 居中 / 我的紧凑设置行 + 单色图标）；**所有可点元素统一按压反馈**（`components/tappable.tsx`，列表行 fill、图标 opacity、主按钮 scale+触觉）；**三语切换**（简/繁/英，`src/i18n/`，字典按页分文件，「我的 → 语言」切换，跟随系统默认）；紧急联系人与事故记录拆成独立页 `contacts.tsx` / `accidents.tsx`。**请 Review 并双端真机过一遍**；新页面文案一律走 `useT()`，新增 key 三种语言都要补；spike-* 页不在范围。设计稿：见负责人发的画布链接。
> 7. 这次改动在 PR #56，**麻烦你 Review**（团队规则：动 Contract 和新依赖要对方看一眼；新依赖是腾讯云短信官方 SDK）。看完没问题 B 合并并更新云端。


**已完成（2f89744，2026-08-25 A 线自主推进）**：决策 #36 对接——App 接 WS `device_command` + relay-ack 回执（commandId 去重、幂等重试；BLE 写入为 `__DEV__` 占位，模拟器实测下发→delivered→executed→设置页 success 全链路通过）；上行中转队列骨架（7 种事件过滤、批量 ≤100、断线按原 eventId 补传，`app/src/services/ble-relay*.ts`）；地图跟随开关 + 设备切换 + 事故详情小地图导航 + 全局 Toast。交接文档已消化删除。

**云端 development 环境已上线（2026-09-06，B 线部署并验收，手册 docs/DEPLOYMENT.md）**——A 线从现在起联调不再依赖 B 的 Mac：

| 项 | 值 |
|---|---|
| App API 地址 | `app/.env` → `EXPO_PUBLIC_API_URL=https://dev-api.01weichuang.com/api/v1`（WS 自动走 wss） |
| 管理后台 | <https://dev-admin.01weichuang.com>（管理员账号问 B） |
| 云端常驻 Mock 头盔 | `helmet_94173f`，**绑定码 `94041564`**；App 注册→绑定后地图页可看到它在动（**已作为 compose 服务 `mock` 常驻服务器**，随后端自动起停，DEPLOYMENT.md §3 ⑦） |
| 本地开发 | 照旧 `http://<mac-lan-ip>:3000/api/v1`，两套环境随时切 |

**剩余任务（按优先级；① 可立即做，②③ 等硬件）**：

1. **云端真机联调（可立即做，也是 DEPLOYMENT.md 验收清单第 6 条）**：双端真机把 API 指到云端，走一遍注册→绑定 `helmet_94173f`→地图看 Mock 移动→SOS 开发快捷触发→倒计时→取消；顺带把设置下发在云端跑一遍（Mock 在 MQTT 模式会自动回执三态）。通过后在本节记一笔「双端云端联调通过 + 日期」。
2. **BLE 中转模块收尾（✅ 前置已解除：硬件 BLE 协议 v0.6 定稿 2026-09-09，决策 #38；Contract=`docs/hardware/BLE通信协议手册-v0.6.html`，速查 DEVICE_PROTOCOL §1.2 含二进制→envelope 翻译规则）**：队列文件持久化（App 被杀后补传）+ 引入 `react-native-ble-plx` + 后台保活双端实测（iOS 后台 BLE 限制记入 DEVELOPMENT.md 平台限制清单）。**进度（2026-09-10 合并 feat/native-batch）**：BLE 库/权限流程骨架、队列文件持久化、SOS 警报音+振动、地图/SOS 防锁屏已合入 main,双模拟器构建实测通过;剩余=GATT 对接(按 v0.6 手册,纯 JS 不再需要重建)+后台保活双端实测。**✅ GATT 对接完成（2026-09-16，A 线）**：协议层 `services/ble/protocol.ts`（帧编解码、事件→envelope 翻译、UUIDv5 eventId、设置键→内存表寄存器；17 单测含手册示例帧）+ 链路管理器 `services/ble-link.ts`（按 `Helmet-<后6位>` 扫描已绑定设备 → MTU 247 → 订阅 FEE1 → 读 deviceId/固件 → 对时 → 0x07/0x08 补传逐条 ACK → 事件入上行队列，高危立即 ACK + 立即冲刷，掉线指数退避重连，deviceId 不匹配拒绝）+ 下行 `ble-relay.ts` 改为真 WRITE（逐键写 0x24/0x26…，头盔错误码 → executed failed + errorCode；未连接不回执等服务端 30s offline；仅模拟器无蓝牙 + __DEV__ 保留模拟执行）；设备页新增「蓝牙连接」状态行（三语）。**自测工具**：`tools/ble-helmet-sim/helmet_sim.py`（Mac bless 扮演头盔，DEVELOPMENT.md 常用命令表）。**✅ iPhone 真机对仿真器联调通过（2026-09-16 深夜）**：扫描 1–3 s 发现并完成五步握手（deviceId/固件 1.0.3/对时/补传查询）；云端下发音量 70 → App 写 0x24 → 头盔应答 → 云端 `success`（delivered 到 executed 3 ms）；仿真器推跌倒 → 当秒 ACK → 上行队列立即冲刷 → 云端 accepted=1 → SOS 状态机建单（已手动取消）；离线压 2 条跌倒后重启仿真器 → App 5 s 内自动重连 → RESEND QUERY=2 → RESEND DATA 逐条 ACK → Flash 擦除归零；位置包每 5 s 一批 accepted=1。修正三处真机问题见 commit 478d2af。**锁屏实测已做（2026-09-16）：退后台链路断、锁屏 5 min 不重连，事件留头盔 Flash，回前台 4 s 补传建单。负责人拍板做「后台实时」低成本档（决策 #41）。**同日复测推翻前述结论**：「锁屏不重连」根因是 SOS 页警报音在锁屏下 `alarm.play()` 抛异常、Release 整 App 崩溃（三份崩溃报告同栈，commit 5e87692 修：try/catch + 音频会话可后台播放）；修复后 Release + 桌面启动 + 锁屏 5 min：进程存活、链路不断，60/180/300 s 三次跌倒当秒 ACK 上云建单——**iOS 后台实时中转验证通过**，无需原生侧方案。已加 iOS BLE 状态恢复。**Android 侧同日完成并验证（07:07）**：本地 Expo 模块 `helmet-link-service` 前台服务 + 设备页「后台运行」白名单引导；华为 P30 Pro 息屏 + HOME 退后台 6 min（未加白名单）进程存活，60/180/300 s 三次跌倒当秒上云建单；华为上 FEE0 过滤扫描扫不到仿真头盔，已加 20 s 无命中自动全量扫描兜底。**决策 #41 低成本档双端验证通过。**华为息屏 1 h 长跑（未加白名单）进程存活、6/6 跌倒当秒上云；发现 EMUI 深睡挂起后台 HTTP（BLE 不受影响），已加高危事件持锁 90 s 修复，零 adb 息屏 15 min 复测跌倒当秒上云；位置包由 BLE 事件驱动每 5 min 持锁冲一次（深睡中 JS 定时器不走），复测 3/3 准时。**华为口径：深睡下保命事件实时、轨迹最多延迟 5 min。**华为「手动清后台」实测：不拉回，事件留头盔 Flash 待重开补传（对外口径依据）。iPhone 09-17 复验：锁屏下警报音被 iOS 拒绝（后台不能激活音频会话），改为本地通知横幅 + 系统通知声实测通过；手动杀 App 不拉回、事件留 Flash（双端一致，对外口径「App 未被手动关闭」成立）。剩余：④ 系统回收（非手杀）后 iOS 状态恢复能否拉起未触发过；Critical Alerts entitlement 待公司账号；**动效批次 2 已合入（2026-09-17，`components/motion.tsx`）**：分段 chip 颜色过渡+选中弹一下（地图时段/事件筛选/灯光档）、输入框聚焦渐亮、主按钮弹性按压+三点 loading、数值变化上滚过渡（电量/速度/里程）、列表错峰入场（设备/联系人/事故）、蓝牙连接中呼吸点、SOS 长按未满松手果冻提示；模拟器逐页过图无回归。同日追加：地图底部统计卡改为贴标签栏的抽屉（下滑收起只留状态行、状态行上滑展开，iOS 卡身延伸到玻璃标签条下；右侧圆钮随抽屉高度上浮）；修音量高音量确认「取消」后停在 80 的 bug（拖动中即时下发的中间值在取消时发回起点值）。**UX 打磨批次（2026-09-17，负责人「直接都加上」，12 项）**：空态统一（图标+标题+一句话+主动作，`components/empty-state.tsx`）、表单字段级报错（红框+抖动+行内文案，登录/注册/找回）、设备页信息区折叠、下拉刷新品牌色、蓝牙首连引导卡（开蓝牙→权限→省电白名单，设备首页硬阻塞横幅）、首连「App 别关」一次性提示、锁屏 SOS 通知加倒计时正文（剩 30/10 s 静默刷新）+「我没事，取消」通知按钮直连服务端取消、地图离线 Marker 变灰停波纹、事件列表按天分组（今天/昨天/日期）、深浅色切换淡入过渡、电量环形仪表、PTT 波纹（原已有）。模拟器逐页过图；真机复验待负责人。**同日第二批（负责人「可以」）**：头盔低电量提醒（≤20/10% 各一次，前台 Toast/后台通知）、联系人「告诉 TA」分享说明、首页「今日骑行」卡（新增 API §5 `locations/summary`，服务端累加，**dev-api 待 Draven 部署后卡片才出现**）、SOS 演练模式（安全页入口，纯本地不通知）、**扫码绑定（决策 #42，新增 expo-camera；iOS 已装真机，华为待接线装新 APK 复验；硬件需印码，DEVICE_PROTOCOL §11）**；另修：根级错误边界、全局断线药丸、spike 页与 TRTC 客户端密钥清除、无障碍标签、水印 WebP。对外口径「手机随身且 App 未被手动关闭」。**
3. **实时视频预览（决策 #37；✅ 前置已解除 2026-09-23，参数定稿 DEVICE_PROTOCOL §1.3）**：先做 RTSP 播放器双端真机 Spike（候选 libVLC 系，如 `react-native-vlc-media-player`；备选推动硬件 WebRTC；降级 `rtsp://` 唤起系统 VLC），定案写 DECISIONS.md 后再做预览页。**Spike 结论未出前不承诺方案。** Spike 必须同时验：① 强制 RTSP over TCP 出画；② Android `bindProcessToNetwork` 绑热点（否则走 4G 黑屏）、iOS `NEHotspotConfiguration` 连热点；③ 进后台 TEARDOWN、回前台重 PLAY；④ 端到端延迟（硬件 VLC 实测 2–3 s）。无硬件先用 `tools/rtsp-mock/start_rtsp.sh`（Mac）起同约定的流，App 只改主机 IP。
4. **注册短信验证码 + 找回密码（🆕 2026-09-09 负责人拍板，后端已实现，API.md §2 / shared `SmsCodeRequest` / `RegisterRequest.code` / `ResetPasswordRequest`）**：① 注册页加「验证码」输入框 + 「获取验证码」按钮（点击 → `POST /auth/sms-code {phone, purpose:'register'}` → 60s 倒计时；429 `SMS_CODE_TOO_FREQUENT` 显示剩余秒数；409 提示去登录）；注册请求带 `code`，400 `SMS_CODE_INVALID` 提示重输；② 登录页加「忘记密码」→ 找回页（手机号 + 验证码 `purpose:'reset_password'` + 新密码 → `POST /auth/reset-password`，成功回登录页）。**本地/云端拿验证码**：Mock 通道把码打在后端日志，`grep verify_code`（DEVELOPMENT.md 常用命令表）。约半天。**✅ A 线完成（2026-09-09）**：找回密码页 + 登录页「忘记密码」入口已合入；模拟器全链路实测通过（取码→重置→旧会话作废→新密码登录）;注册页验证码 UI 审阅无需改动,风格已一致。PR #56 代码审阅意见已单独反馈 B。
5. **等外部件（与 B 线同）**：APNs 远程推送等 Apple 公司账号；高德企业 Key 创建后换入 `app/.env`（企业认证已完成 2026-09-06）。

## Week 12：收官

**为了实现什么**：交付一个可部署、可演示、有文档的 MVP。**本周禁止开发新功能。**

- 部署到云服务器、准备演示脚本（Mock 剧本常驻；**✅ 2026-09-18 `docs/DEMO.md` 已写：演示前检查、7 段故事线、复位与常见状况**）、补文档、双端最终回归、UI 打磨。
- **验收标准**：负责人在演示环境从头到尾走一遍全部功能，无阻塞性问题。

### 上线前提醒清单（2026-09-17 起累积；进入 Week 12 / 准备正式包时逐条过，Claude 负责主动提醒）

| # | 事项 | 谁 | 说明 |
|---|------|----|------|
| 1 | ~~生成公司 Android 正式签名证书~~ ✅ **2026-09-21 已生成** | A 线 | `~/.helmet/lingyiweichuang-release.keystore`，别名 `lingyiweichuang`，RSA 4096 / 10000 天（至 2054-02），主体 = 邓白氏登记英文名。**口令不进 Git**；本机存 `~/.helmet/android-release-keystore.env`（chmod 600，仓库外），密码管理器另留一份。`android/` 不进 Git 故不改 build.gradle，签名走命令行注入，命令见 DEVELOPMENT.md「Android 正式签名包」。🔴 **负责人待办：把 keystore 文件另外备份一份到公司长期保管处——文件丢了和口令丢了一样致命，补发不了** |
| 2 | ~~高德「AI头盔-安卓端」Key 改「发布版 SHA1」~~ ✅ **2026-09-23 负责人已改** | 负责人 | 第 1 项已完成，新证书 SHA1 `2E:36:B3:C2:11:88:82:8F:1B:E2:F1:AC:90:1E:34:12:3A:B4:29:D8` 已填入控制台「发布版安全码SHA1」；调试版保留 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`（开发包继续可用）。当前地图走 JS API Key 不校验签名，不急 |
| 3 | **高德商用授权决策** | 汤总 | 企业 Key 未购许可前只是「短期、少量测试」额度：买基础版 ¥5 万/年，或换腾讯/百度（地图层独立组件，约一周）。见 THIRD_PARTY.md §7 |
| 4 | Apple 公司账号 → TestFlight / APNs / Critical Alerts | 负责人 | ✅ D-U-N-S 已下发 576655751（2026-09-17）；等邓白氏→苹果同步（9-23 起在 Apple Developer App 重试组织信息）→ 付 ¥688 → 苹果审核；到位后 iOS 推送与 SOS 关键提醒补验 |
| 5 | App 备案（腾讯云） | 负责人 | 安卓、iOS 各一条，包名 `com.lingyiweichuang.app`，前置已满足 |
| 6 | **生产环境运维三件套** | B 线 | ① ✅ PostgreSQL 每日自动 `pg_dump` 到 COS（`deploy/backup.sh` + `backend/src/scripts/backup-upload.ts`；**2026-09-18 云端已部署并跑通：首份 13.24 MB 已进桶 `backups/`，crontab 每日 03:00 已加**；⚠️ 2026-09-22 发现定时任务 4 天未执行——crontab 日志写 `/var/log` 无权限、整条命令不跑，已改到 `/home/ubuntu/helmet-backup.log` 并手动补备份 17.40 MB；**2026-09-23 复查通过：19:00:01Z（北京 03:00）自动触发，上传 18.09 MB，桶内 3 份**）；② ✅ compose 全部服务 `logging: 20m × 5`（2026-09-18 云端已生效）；③ ✅ 对外 `/health` 拨测告警（**2026-09-22 已开通**：UptimeRobot 免费版，账号 zhongqilong@01weichuang.com，监控「dev 后端健康检查」HTTP/S 每 5 分钟、失败邮件告警；免费版编辑时不能改 Keyword 类型，但 `/health` 数据库断开返回 503，HTTP 监控即可发现；production 上线时加 `api.01weichuang.com` 一条） |

---

## 附：每周固定动作

1. **周一**：对照本文档确认本周两人各自的任务和"为了什么"。
2. **每天**：10 分钟同步（做了什么/今天做什么/卡在哪）。
3. **随时**：功能做完就提 PR，对方 24 小时内 Review。
4. **周五**：对照本周「验收标准」逐条自查；负责人验收；没过的记为遗留。
5. 涉及 Contract（docs/、packages/shared、Prisma schema）的改动：**先沟通再动手**。
