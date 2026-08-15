# DECISIONS.md — 已拍板技术决策记录

> 记录项目已确认的技术决策。**已确认的决策不允许 Claude 或任何人无理由重新推翻**；确有新证据需变更时，先说明理由、经负责人确认后在此追加新条目（不删除旧记录，注明“取代 #N”）。
> 格式：Date / Decision / Reason / Impact。新决策追加到表末。

| # | Date | Decision | Reason | Impact |
|---|------|----------|--------|--------|
| 1 | 2026-08-14 | 架构采用模块化单体（NestJS 单应用）；禁止微服务、K8s、Kafka、RabbitMQ、Redis、CQRS、Event Sourcing | 两人三个月 MVP，简单稳定优先 | 全部后端功能在一个 NestJS 应用内按模块划分 |
| 2 | 2026-08-14 | App 采用 React Native + Expo Development Build / Prebuild，禁止 Expo Go 作为开发环境 | BLE/地图/Push/后台任务需自定义原生模块；全栈统一 TypeScript | 从第一天用 dev build；原生工程可扩展 |
| 3 | 2026-08-14 | Android + iOS 双端硬性交付，同周期开发，双端 DoD | 负责人硬性要求 | 所有 App 功能双端真机验收；不允许静默降级 |
| 4 | 2026-08-14 | 数据库 PostgreSQL 16 单库 + Prisma；MVP 不引入 Redis / 时序库 / PostGIS | 规模小，能不用复杂基础设施就不用 | 位置数据存普通表，为未来 Retention/归档留余地 |
| 5 | 2026-08-14 | 设备通信：MQTT（EMQX Broker）；App↔云 REST + WebSocket + Push | IoT 事实标准，硬件团队熟悉 | 协议细节见 docs/DEVICE_PROTOCOL.md |
| 6 | 2026-08-14 | **头盔 4G 直连云端 MQTT；BLE 仅近场（配对/防丢）** | 负责人确认（2026-08-14） | 移除 Hardware Contract Pending；若改手机网关模式须重新评估架构与工期 |
| 7 | 2026-08-14 | 云端算法服务（如有）经 HTTPS Webhook 直连后端，**不经 EMQX** | 算法服务是服务器不是设备，无弱网/长连接需求；HTTP + 鉴权最简单，与 MQTT 入口在统一 Ingest 层汇合 | Ingest 层提供 webhook 入口，事件 envelope 与 MQTT 完全一致 |
| 8 | 2026-08-14 | SOS 状态机服务端权威：deadline + 状态持久化 PostgreSQL，后台周期扫描触发，启动时恢复 pending；禁止仅靠内存 timer | App 被杀/断网/后端重启都不能丢 SOS | SOS 模块必须实现恢复逻辑与幂等 |
| 9 | 2026-08-14 | Mock Device 与真机同 Contract/Topic/认证/eventId 规则；业务代码禁止 `if (isMock)` | 真机接入零业务改动 | Mock 只在数据源层替换 |
| 10 | 2026-08-14 | 目标市场中国大陆优先：高德地图、国内云、阿里云短信（暂定）、极光+厂商通道 Push；Push/SMS/Storage 走薄 Provider 接口各带 Mock 实现 | 负责人确认市场方向；第三方审核期不阻塞开发 | 供应商可替换；业务代码不散布第三方 SDK 调用 |
| 11 | 2026-08-14 | 地图归 App 端：SDK、展示、导航跳转在 App 内封装；Backend 只存坐标提供位置 API，**不建 Backend MapProvider** | 不为抽象提前建设无用途的东西 | 未来确需服务端 geocoding/routing 再评估 |
| 12 | 2026-08-14 | BLE 防丢口径：按“连接持续断开或信号持续异常”触发，不承诺精确 8 米 | RSSI 不是可靠距离；iOS 后台限制 | 对外沟通统一此口径 |
| 13 | 2026-08-14 | Backend/工具链 Node 24 LTS，仓库根 `.nvmrc` 锁定；禁用已 EOL 的 Node 20 | 避免 EOL 运行时 | 初始化时创建 .nvmrc；CI 用同版本 |
| 14 | 2026-08-14 | App 路由采用 Expo Router；Deep Link 与 Push 点击跳转按 Expo Router 设计 | 与 Expo 生态一体，文件式路由降低学习成本 | 仅遇到明确无法解决的问题才重新评估 |
| 15 | 2026-08-14 | 按当前稳定 Expo SDK（计划 SDK 57）初始化；初始化前核对官方稳定版，transition 期用官方推荐 template；不用 beta/canary | 避免旧 SDK 或不稳定版本 | 初始化步骤需先查 Expo 官方版本状态 |
| 16 | 2026-08-14 | Monorepo 用 npm workspaces + 单一根 package-lock.json；根目录名 `AI-Smart-Helmet-01WeiChuang/` | 两人协作最简；避免多 lockfile 混乱 | 禁止子项目使用其他 package manager |
| 17 | 2026-08-14 | CI 用 GitHub Actions；Week 1 最低门槛：install、typecheck、lint、test、build/check | 与 GitHub PR 流程一体 | main 分支 PR 必须 CI 全绿 |
| 18 | 2026-08-14 | 事件 envelope 含 schemaVersion / eventId / deviceId / eventType / timestamp / firmwareVersion / payload；receivedAt 由服务器生成；EVENTS.md 所有字段必须写类型、必填性、单位、值域；坐标必须显式 coordinateSystem | 硬件/算法对接的歧义是最大联调风险 | EVENTS.md 按此标准编写；Contract 字段只增不改不删 |
| 19 | 2026-08-14 | 两位开发者均有 iPhone 真机与 macOS；第三方资质（Apple Developer、地图 Key、短信、Push、云、域名）由负责人申请 | 负责人确认 | 双端开发条件成立；Week 1 启动各项申请 |
| 20 | 2026-08-14 | **对讲功能软件侧技术方向**：头盔作蓝牙耳机（音频外设），网络语音走「手机 App + RTC 云服务」（服务商待选型：腾讯云 TRTC / 声网 Agora）。前提口径：网络对讲依赖手机蜂窝网络覆盖，无信号即不可用（与定位/SOS 依赖 4G 同一前提）。老板另提「无信号时对讲机模式兜底（双模）」：硬件电台属**纯硬件功能（声音不经手机/App）**，是否加做、频段/功率/实际距离由硬件团队评估（免执照公众频段限 0.5W，山地距离无法承诺 2km）；若做，软件仅承担频道设置下发（走既有 cmd 通道）。老板另两项需求映射既有链路：受伤定位=SOS/possible_fall 链路（Week 7–8），后方靠近预警=collision_risk 链路（Week 9–10，头盔本地即时报警，软件展示留档） | 硬件与软件负责人 2026-08-14 对齐：RTC 云服务成熟省时；硬件电台的法规与距离约束需硬件专项评估 | 软件新增实时语音模块（双端约 2–3 周，用 RTC SDK 不自研）；排期见 #21；RTC 服务商账号加入第三方申请清单；硬件对讲评估结论出来后在此追加 |
| 21 | 2026-08-14 | **网络对讲进 MVP，采用方案 A**：Week 9–10 调整为「危险事件 + 网络对讲」；休眠展示与 BLE 防丢顺延至 Week 11（若联调挤压则移至 MVP 后第一迭代）。Week 2 Spike 清单增加 RTC SDK 双端真机验证（蓝牙耳机音频路由 + iOS 后台音频）；RTC 服务商账号申请与 Apple Developer 并列第一优先 | 负责人确认（2026-08-14）：对讲是老板必保功能，防丢/休眠不在必保清单，让路合理；不与 Week 7–8 SOS 并行以保住保命链路质量 | CLAUDE.md Roadmap 与 plan/weekly-plan.md 同步更新；MVP Goal 增加网络对讲条目 |
| 22 | 2026-08-15 | **RTC 选型定案：腾讯云 TRTC** | Week 2 Spike 双端真机通过：双机对讲互通、锁屏后台音频（iOS UIBackgroundModes: audio）、蓝牙耳机路由（Developer A 实测，负责人确认） | Week 9–10 对讲功能直接基于 TRTC 开发；声网备选不再评估，除非 TRTC 出现阻塞性问题 |
| 23 | 2026-08-15 | **定位实现口径：一律持续监听（watchPosition）+ 中间状态展示，禁止一次性 getCurrentPosition 等待** | 华为（无 GMS）实测：冷启动锁星需 1–2 分钟，一次性等待长时间无反馈形同卡死；锁星后持续监听每 2s 稳定更新、精度可达 5m（负责人确认） | Week 5–6 地图/轨迹页按此口径实现；App 端定位封装层遵循此模式 |
| 24 | 2026-08-15 | **开发期双 Bundle ID 口径**：A 用 `com.zixim.helmet.spike`、B 用 `com.dravenzhong.helmet`；远程推送完整验证与签名统一等待公司 Apple Developer 账号 | iOS 免费个人团队无法签远程推送 entitlement，且同一 Bundle ID 无法注册到第二个个人团队（Week 2 实测，负责人确认） | 不阻塞开发；公司账号到位后统一换正式 Bundle ID（见 CLAUDE.md 待确认事项） |

## 待定决策（占位，定案后移入上表）

| 待定项 | 计划定案时间 | 说明 |
|--------|------------|------|
| 地图库最终选择（高德 RN 库 vs WebView JS API） | Week 2 Spike 后 | 双端真机验证通过才定案 |
| BLE 库最终确认（默认 react-native-ble-plx） | Week 2 Spike 后 | 含 iOS 后台行为实测记录 |
| iOS 后台能力限制口径（BLE 防丢、后台定位） | Week 2 Spike 后 | 实测记录进 DEVELOPMENT.md，口径与负责人确认 |
| 坐标转换位置（wgs84→gcj02 在服务端还是 App 端） | EVENTS.md 定稿时 | 取决于硬件 GPS 输出与地图库要求 |
| DEVICE_PROTOCOL.md 中标 ⚠️ 的传输层细节 | 最晚 Week 10 联调前 | 待硬件团队逐项确认 |
| 短信/推送服务商最终确认 | 资质下来后 | 当前暂定阿里云短信 + 极光 |
| ~~RTC 服务商选型~~ | 已定案 2026-08-15 | 定为腾讯云 TRTC，见决策 #22 |
| 硬件对讲电台（双模兜底）频段/功率/实测距离 | 硬件团队评估后 | 纯硬件功能；结论追加进决策 #20；软件仅承担频道设置下发 |
