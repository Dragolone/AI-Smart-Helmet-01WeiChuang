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
| 25 | 2026-08-15 | **WebSocket 实时通道选型：原生 ws（@nestjs/platform-ws），不用 Socket.IO** | RN 与浏览器用平台原生 WebSocket 直连、App 端零客户端依赖；MVP 无房间/轮询降级需求，不引 Socket.IO 私有协议开销。鉴权 `?token=` + 失败 4401；「按绑定设备自动推送、不做补发、REST 兜底」口径见 API.md §11 | App 端（Week 5–6 地图页）用原生 WebSocket 接入；若未来需要房间/广播语义再评估，不推翻现有消息格式 |
| 26 | 2026-08-16 | **SOS 状态机落地口径（负责人确认四项）**：① 并发合并规则——设备已有 pending 时新 possible_fall 只留档不建单、新 manual_sos 立即触发通知（等价 SOS Now），终态后新事件建新单；② active 空响应 = `200 { sos: null }`；③ 事故位置快照优先触发事件内嵌位置（逐字段校验），回落最新轨迹点，都无则空快照照建单；④ 紧急联系人上限 5 个（活跃计数）。附加口径：仅绑定用户的设备建单（无绑定即无人可通知/取消）；deadline 一律服务器时间（clock_skew 不影响保命链路）；每设备至多一个 pending 由 partial unique index 兜底 | 倒计时中实体键求救是明确人为意图不该再等；摔倒算法连发大概率是同一事故重复判定；快照缺失不能阻塞建单 | EVENTS.md §4.4、API.md §3/§7 同步定稿；实现于 backend/src/sos（触发/调度/通知三服务 + 条件更新竞态防护） |

| 27 | 2026-08-16 | **Week 9–10 落地口径（负责人确认六项）**：① 危险事件不建专表，§6 查询直接走 raw_events 服务层（type 白名单、`_invalid` 不出）；② 「当前危险状态」由 App 从 WS 事件流推导，服务端不维护实时态；③ 设置当前生效值存 devices.settings（命令 success 回执后才写入），commands 表留全历史；④ 命令 delivered = MQTT PUBACK，30s 无 cmd_ack → offline（⚠️ 真机联调可调）；⑤ 对讲频道模型：6 位邀请码加入、TRTC 房间号=频道 id、成员上限 20；⑥ TRTC UserSig 服务端自实现官方 HMAC-SHA256 算法（不引 SDK 依赖），SDKAppID/Key 走 env（先用个人测试应用） | 危险事件无独立状态可维护，头盔本地已实时告警、软件只展示留档（服务端实时态没有真实消费者）；「未回执绝不显示成功」要求生效值只认设备确认；签名算法是公开规范 | Week 9–10 B 线五个 PR 按此实现；若未来出现「监护人实时查看危险中设备」需求再评估服务端实时态，现有 raw_events 留档可随时构建 |

| 28 | 2026-08-16 | **SOS 通知节奏维持 60 秒倒计时；对外宣传口径统一为「秒级检测、倒计时确认后自动通知」** | 技术方案 PPT（第 12 页）写"判定事故后立即发短信"，与已实现的 60s 可取消机制不一致；汤总确认认可 60s 防误报设计，对外表述随软件实际行为统一 | 软件零改动（#38 已实现并验收）；对外材料按此口径修订 |
| 29 | 2026-08-16 | **双产品形态确认（汤总拍板：两种都要、MVP 也要）**：①蓝牙版——头盔无 4G，经 BLE→手机 App 中转→云端；②4G 版——自带 4G 直传 + SD 本地存储 + Wi-Fi 上传（即现有全部实现）。**架构方向**：蓝牙版数据经 App 新增中转模块以 HTTP 批量提交后端**统一 Ingest 层**（同 envelope/同 eventId 幂等，业务模块零改动，source=app_relay 仅排查可见）；触发决策 #6 的重评估条款 | 4G 版软件已全部就绪；统一 Ingest 当初的"业务不感知来源"设计使后端增量仅一个薄入口；真正增量在 App 中转模块（A 线）与头盔 BLE 数据协议（硬件） | 蓝牙版 **MVP 内深度（保命最小集 vs 全量）与「视频不走蓝牙（SD+Wi-Fi 补传）」边界待汤总 ①② 确认**（见待定表）；硬件需定义 BLE 数据协议（联调清单置顶）；确认后更新 DEVICE_PROTOCOL/API 并重排 weekly-plan |
| 30 | 2026-08-16 | **事故对外查看采用「临时分享链接」方案（档次一），排 MVP 后第一迭代**：SOS 通知短信内附带令牌化链接，家属免注册查看本次事故的位置与视频，24h 时效、单事故范围、留审计；救援机构门户（机构账号体系）待商务合作成熟后另立项 | PPT 第 12 页承诺"救援机构/家属远程调取"，现系统仅用户/管理员两种身份；临时链接以 1–2 周工作量兑现家属侧承诺，机构侧先决条件是商务而非代码 | MVP 零改动；对外口径="家属一键查看下一版本上线、机构对接规划中"；实现时新增分享令牌表 + H5 页 + 复用媒体预签名 URL |

| 31 | 2026-08-16 | **蓝牙版范围与视频边界定稿（汤总确认 ①②，决策 #29 收尾）**：①视频不走 BLE——SD 卡存储 + 头盔连 Wi-Fi 直传云端；②MVP 时间不变，蓝牙版第一期中转 **7 种事件**（device_status/location_update/possible_fall/manual_sos/collision_risk/obstacle_risk/risk_cleared），其余 4 种（video_ready/sleep×2/bluetooth_lost）下一版本——原因是产品逻辑（视频随 Wi-Fi、休眠防丢移出 MVP、蓝牙版断连语义需重设计）而非工作量；**休眠展示与 BLE 防丢正式移出 MVP** | BLE 带宽物理上限传不动 90s 视频；中转管道类型无关，7 种与 4 种的成本差仅测试量；保命链路（摔倒→60s→通知）与危险留档在蓝牙版完整 | Contract 已更新（DEVICE_PROTOCOL §1/§1.1、API.md §12.1 app-relay 入口）；B 线下一任务=中转入口实现；A 线新增 App 蓝牙中转模块（前置：硬件 BLE 协议，联调清单第 1 条）；weekly-plan 同步重排 |

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
| ~~蓝牙版 MVP 深度与视频边界~~ | 已定案 2026-08-16 | 汤总确认 ①②，见决策 #31 |
| 头盔 BLE 数据协议（蓝牙版：GATT 服务/分帧/确认机制） | 硬件团队定义，最晚随联调清单回复 | 蓝牙版软件开发的前置依赖（决策 #29/#31；**数据范围已定稿，只等传输细节**） |
