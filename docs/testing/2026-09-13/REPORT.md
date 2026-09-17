# 全面测试与交付审计报告（2026-09-13 / 14）

> 上一轮报告：`docs/TEST_REPORT_2026-09-10.md`。本轮**不沿用其任何通过结论**，逐项在当前代码上复验。
> 三份配套文件：`BUGS.md`（缺陷全表）、`COVERAGE_MATRIX.md`（覆盖台账与未覆盖清单）、`DEVICE_CHECKLIST.md`（双端真机逐步验收，本轮全部未测）。证据在 `evidence/`。

## 1. 版本与环境

| 项 | 值 |
|---|---|
| HEAD | `2295eef9a132bdf04ea00c8ae1f6bce6d4c057ac`（main，无已跟踪改动） |
| 时间 | 2026-09-13 09:01Z 起，跨 2026-09-14（期间两次会话额度中断，已续跑） |
| 平台 | macOS 26.6.2（arm64，14 核 / 48GB），Docker 28.4.0 |
| Node | `nvm use 24` → v24.19.0（终端默认为 v25.9.0，与 `.nvmrc`=24 不符，已全程切换） |
| 数据库 | 隔离容器 `helmet-audit-0913-pg`（postgres:16.15，127.0.0.1:55432），14 个专用库，全部由空库跑完 16 个 migration |
| MQTT | 隔离容器 `helmet-audit-0913-emqx`（emqx:5，127.0.0.1:51883），配置为仓库 `emqx/emqx.conf` 副本，回调改指审计后端端口与专用令牌 |
| 第三方 | **全部为 Mock/未配置**：短信 Console Mock、推送 Console Mock、存储 Mock、TRTC 占位 Key。未向任何真实号码发送短信 |
| 真机 | **无**。Android/iPhone 真机与可用模拟器均不可得 |

未跟踪文件全部保留未动（含 7 个 iCloud `" 2"` 杂散副本）。未提交任何改动，未推送。

## 2. 执行概况

| 层 | 结果 |
|---|---|
| 静态检查 | backend/app/admin/shared/mock-device typecheck 全绿；admin/app lint 0 error；**backend lint 1 error**（唯一来源是 iCloud 杂散副本 `src/auth/sms-code.service.spec 2.ts:46`） |
| 后端单测 | 8 套件 / 86 用例全过 |
| App 单测 | 7 套件 / 51 用例：40 过 + **11 个刻意保留的缺陷断言失败** |
| 既有后端 E2E | 25 套件 / 227 用例全过（隔离库，67 秒） |
| 既有 E2E 源码覆盖率 | 语句 **92.35%** / 分支 **77.78%** / 函数 93.83%（分母为全部业务源码，最低 `mqtt-consumer.service.ts` 41%） |
| 本轮新增后端 E2E | 19 个 `audit-*` 套件 + 5 个 helper；**一键复跑 219 用例：188 过 / 31 为刻意保留的缺陷断言**（`evidence/run-all-audit.sh`，结果可复现） |
| Migration | 空库 16/16 通过；上一版本升级路径 + `device_bindings` 回填通过；重复部署幂等 |
| 构建 | `nest build`、`vite build` 均通过（dist 混入杂散 `* 2.js`） |
| 真实进程 | SOS 重启接管（SIGKILL → 重启 → 接管 notified，通知各恰一次，18 项全 PASS）；Mock 中转剧本 fall/sos/risk/ski + 断网补传 + 命令三态（1128 条事件唯一入库）；真实 EMQX 认证/ACL/消费者恢复矩阵 |
| 浏览器 | Admin 全页 Playwright + 本机 Chrome 实测（20 项，15 PASS / 4 FAIL / 1 PARTIAL） |
| 容量 | 6 类负载 + 60 秒混合负载，0 个 5xx、数据零丢失 |
| 缺陷总数 | **0 个 P0、4 个 P1、16 个 P2、其余 P3**；全部有失败测试或日志。唯一间歇复现项为 VOICE-01（4 次运行复现 1 次），其余均为确定性 |
| 最终校验 | backend `tsc` 0 错、`eslint` 审计文件 0 error（278 warning 与既有 e2e 同类）；app `tsc` 0 错、`expo lint` 0 error |

## 3. 最严重的问题（按影响排序）

### P1-1 `SOS-02` 原始事件已到服务器，建单失败即永久漏单
`raw_events` 落库成功后 `sos_cases.create` 失败（DB 瞬断或进程在分发阶段崩溃），入口仍返回 `202 accepted:1`，App 认为已送达不再补传；再次上报同 eventId 被幂等挡在 raw 层（只有 `stored` 才分发），扫描任务与重启都不对账。**决策 #8「App 被杀/断网/后端重启都不能丢 SOS」在「事件已到服务器」这一侧不成立。** 修法：扫描任务加一条对账查询（近 N 分钟内有 possible_fall/manual_sos 的 raw 但无对应 `trigger_event_id` 的单 → 重新触发）。

### P1-2 `SOS-05` 一条通知挂起拖停全站 SOS 扫描
`deliverPending` 顺序 `await provider.send()` 且**无超时**，`tick()` 又有全局 `running` 互斥——一个不返回的短信/推送调用会让其他用户到期的 SOS 一直停在 pending。实测 victim 设备越过 deadline 数秒、连续 5 轮 tick 全部跳过。修法：`send` 包超时 + 终态化与投递拆成两个独立互斥。

### P1-3 `MQTT-02` 消费者「假订阅」导致 4G 链路静默失聪
后端 MQTT 消费者用固定 clientId + `clean:false`。被同 clientId 顶替一次后自动重连，日志打印「已连接 / 已订阅」，但 Broker 侧实际 0 订阅——事件入口静默瘫痪且无告警，只有重启能恢复。配套的 `MQTT-01`：EMQX 认证回调根本不校验 clientId，任何持有合法设备密钥的人都能顶替后端会话。**MVP 期间 4G 链路由 Mock 驱动，真机走 BLE，故当前影响有限；但这是 4G 扩展前必须堵的洞。**

### P1-4 `SOS-01` 位置快照查询失败 → 摔倒事件不建单
触发事件没有内嵌位置时会回落查最新轨迹点，该查询抛错会让整个建单流程中止（`resolveSnapshot` 在 `create` 的 try 之外）。与既有「快照缺失不阻塞建单」（决策 #26③）口径直接冲突。一行 try/catch 即可修。

### P2 里最该先看的四条
- **`ADMIN-01`**：后台五个页面把接口 500 渲染成「暂无数据」，概览把故障显示成全 0——运维会把系统故障看成业务平静。
- **`AUTH-09`**：App 在 401 刷新在途时登出或切号，刷新结果会把旧账号 token 写回（会话复活 / 覆盖新账号）。
- **`APP-01`**：切换账号不清 React Query 缓存，且 `staleTime: 10s` 意味着新账号 10 秒内直接看到上一账号的设备与事件。
- **`SOS-04`**：短信全部失败或用户没设联系人时，状态、Push 与 App 文案依然说「紧急联系人已收到通知」。在最危急的时刻误导用户停止自救。

## 4. 性能与容量（本机参考值，非线上 SLO）

> 环境：M 系列 Mac，后端 `node dist/main` 单实例，PostgreSQL 在 Docker，**同机另有测试并行**（CPU 存在竞争，数字偏保守）。无产品 SLO，以下仅作基线参考。

| 场景 | 吞吐 | p50 / p95 / p99 | 错误 | 数据一致性 |
|---|---|---|---|---|
| app-relay C=20，批 50 | 44 req/s ≈ **2211 事件/秒** | 449 / 478 / 515 ms | 0 | 67,000 条全部入库 |
| app-relay C=50，批 50 | 44 req/s ≈ 2213 事件/秒 | 1127 / 1169 / 1189 ms | 0 | 67,500 条全部入库 |
| GET 轨迹 24h pageSize=100 C=50 | 215 req/s | 231 / 252 / 266 ms | 0 | — |
| WS 200 连接 × 50 推送 | 10,000/10,000 送达，334 ms | 1 / 3 / 4 ms | 0 | — |
| PUT settings + relay-ack C=50 | 586 req/s | 84 / 93 / 101 ms | 0 | 17,604 条命令全 success |
| sms-code（Console Mock）C=20 | 2512 req/s | 8 / 10 / 12 ms | 0.06%（429，限频正常） | — |
| 混合 60 秒（relay + 查询 + 设置 + 短信 + 20 WS 空闲） | 22,416 请求 | 各分项见上 | 6 个非 2xx（全是 429） | 22,000 条 relay 全部入库 |

**紧急事件不被普通流量饿死**：在上述混合负载中注入 possible_fall，HTTP 53 ms 返回、54 ms 内库中可见、WS pending 53 ms 送达，到期后 722 ms / 941 ms 完成通知（空载基线 351 ms）。

**资源**：RSS 267 → 574 MB 后进入平台期不再增长，负载停止后不回落（Node 堆特性）；PG 连接 10 → 1，文件描述符 30 → 21。上限约束是 Prisma 默认连接池 10（`pg_stat_activity` 峰值 10，无等待）。

## 5. 与 2026-09-10 报告的逐项对账

| 旧编号 | 本轮结论 | 说明 |
|---|---|---|
| #1 envelope 毒事件（NUL/int32/极值年份） | **复验通过** | 三入口均留档不 5xx。**但**原始 `0x00` 字节（非转义）在 MQTT 路径仍导致留档失败并丢弃 → 新 `INGEST-03` |
| #2 device_status 越界字段 | **复验通过** | 字段丢弃、`lastSeenAt` 照刷 |
| #3 媒体 sizeBytes ≥ 2GB | **复验通过** | BigInt 入库与序列化正确 |
| #4 无限频 | **复验通过** | 限频落地且真实进程验证 429 + Retry-After。**但**新发现 `AUTH-07`（trust proxy 直连可伪造 XFF）与 `AUTH-08`（桶满清表可重置全站额度） |
| #5 请求体 413 | **复验通过** | |
| #6 Admin 日期参数 500 | **复验通过** | `from=not-a-date` → 400 |
| #7/#8 名额并发（联系人 / 频道） | **复验通过** | advisory lock 生效。**但**新发现 `VOICE-01`（同一人并发加入满员频道得 409，与幂等契约不符） |
| #9 迟到回执覆盖新设置 | **复验通过** | 按键合并正确 |
| #10 绑定竞态 | **复验通过** | 6 用户并发恰 1 成功 |
| #11 密码 72 字节 | **部分复发** | register / reset-password 已修；**login 与 2026-09-11 新增的 change-password 未加字节校验** → `AUTH-01` / `AUTH-02` |
| #12 refresh 并发轮换 | **复验通过** | 并发 8 次 → 1 成功 7 拒 |
| #13 找回密码后旧 token / WS 不断开 | **复验通过** | WS 按 `exp` 定时 4401。15 分钟 access 窗口属 API.md §2 设计口径。**但**注销账号不踢已建立的 WS → `AUTH-05`/`INGEST-04` |
| #14 02-30 日期 | **复验通过** | |
| #15 换绑历史归属 | **按决策 #39 变更并复验通过** | 三段区间与边界时刻全部正确。**但** `battery-history` 未纳入区间过滤（`AUTH-06`）、SOS 合并规则未按 userId 区分（`SOS-03`） |
| #16 短信昵称回落 | **复验通过** | 无昵称时为脱敏手机号 |
| #17 app-relay 批量吞吐 | **复验通过（容量项）** | 本机 ~2200 事件/秒，MVP 规模够用 |
| 旧报告 §3 SOS 竞态通过项 | **复验通过** | 25 并发建 1 单、cancel×5+confirm×5 恰 1 个 200、通知恰一次等全部复现 |
| 旧报告 §5 MQTT 真跑 | **复验通过** | 在专用 EMQX 上重跑认证/ACL/冒充/命令三态全部通过 |

**新增覆盖面（旧报告未测）**：故障注入（8 类）、真实进程 SIGKILL 重启接管、clientId 顶替与消费者恢复、绑定区间边界、限频桶容量、App 客户端会话交错、BLE 中转队列缺陷、Admin 浏览器行为、备份恢复、依赖漏洞、误配启动。

## 6. 交付缺失项（不是缺陷，是没做）

| 项 | 决策依据 | 当前状态 |
|---|---|---|
| **实时视频预览** | 决策 #37（已拍板进 MVP） | App 端零实现（`grep rtsp\|vlc\|softap` 无命中）；硬件四项参数（子码流 id/分辨率、`rtsp_net_type`、拉流 URL 与鉴权、AP SSID/密码/IP）未提供，Spike 未开工 |
| **BLE GATT 收发与二进制解析** | 决策 #35/#38（BLE 是 MVP 唯一真机链路） | `ble-link.ts` 只有管理器与权限；扫描/连接/握手/对时/MTU/ACK/Flash 补传/帧翻译/UUIDv5 eventId 全部未实现。上行队列骨架已在，下行 `writeToHelmet` 是 `__DEV__` 占位 **→ ✅ 2026-09-16 已实现**（`services/ble/protocol.ts` + `ble-link.ts` + `ble-relay.ts`，仿真器 `tools/ble-helmet-sim/`；真机对仿真器与后台保活实测待做） |
| **真机双端验收** | CLAUDE.md Platform Policy（硬性） | 全部未测，清单见 `DEVICE_CHECKLIST.md` |
| **真实推送（APNs / 厂商通道）** | THIRD_PARTY #5/#6 | 未申请；App 杀后台收不到远程推送，SOS 只有 WS + 全屏页兜底 |
| **真实短信** | THIRD_PARTY #4 | 签名/模板待过审 + 运营商报备 ~2 周；代码就绪，配齐六项 env 即切换 |
| **对象存储 COS** | THIRD_PARTY #3 | 未开通；`MockStorageProvider` 返回的 URL **并非可访问对象** |
| 家属临时分享链接 | 决策 #30 | 明确排在 MVP 后 |
| 休眠 / BLE 防丢 | 决策 #31 | 明确移出 MVP |
| TF 卡视频读取 | 决策 #37 | 明确排在 MVP 后 |

## 7. 交付结论

**不能写「全部通过」，也不能写「可以正式上线」。** 依据：

1. 存在 4 个 P1 缺陷，其中 3 个在保命链路（SOS-01/02/05）。
2. 两项 MVP 范围内的功能零实现（实时视频预览、BLE 真机收发），而 BLE 是决策 #35 下**唯一的真机数据链路**。
3. 双端真机验收 0 项，CLAUDE.md 的 Definition of Done（Android 真机 + iPhone 真机都正常）完全未满足。
4. 真实第三方（短信/推送/存储/TRTC）全部未接，**Mock Provider 成功不等于联系人收到通知**。

**可以说的是**：在「事件已到达服务端」之后的服务端链路，本轮以隔离环境 + 真实进程 + 故障注入做了较完整的验证，SOS 状态机的竞态、幂等、重启接管、通知重试在默认 60 秒口径下行为正确；Ingest 三入口等价性、命令状态机「未回执绝不显示成功」、绑定区间归属、EMQX 认证与 ACL 均复验通过；容量在本机规模有数量级余量且紧急事件不被普通流量阻塞。

## 8. 建议的处理顺序

1. **修 3 个 SOS P1**（SOS-01 一行 try/catch；SOS-05 超时 + 拆互斥；SOS-02 扫描对账），配套跑 `audit-sos*.e2e-spec.ts` 让缺陷断言转绿。
2. **修 P2 里影响用户可见正确性的四条**：ADMIN-01（错误态）、AUTH-09 + APP-01（App 会话与缓存串账号）、SOS-04（通知文案语义）。
3. **堵 MQTT-01/02**（4G 扩展前必须，改动小：认证回调校验 clientId + 重连后校验订阅真实生效）。
4. **上线前跑一次 `npm audit fix`** 并回归（后端运行时命中 7 个漏洞包，@nestjs 与 prisma 有兼容补丁）；Dockerfile 加 `--omit=dev`。
5. **仓库卫生**：把仓库移出 iCloud 同步目录或给 tsconfig 加 include 白名单，清掉两个已提交的 `" 2"` 副本。
6. **补 BLE 中转队列的 4 条 P2**（BLE-04/05/06 与 BLE-03），这是 BLE 模块开工前的设计约束，不是事后优化。
7. 然后才谈真机验收与第三方接入。

## 9. 需要你提供的资源（按解锁价值排序）

| # | 资源 | 解锁什么 | 当前替代 |
|---|---|---|---|
| 1 | **Android 真机 + iPhone 真机**（各一台，能连 Mac 装 Dev Build） | `DEVICE_CHECKLIST.md` 全部 12 节：权限矩阵、后台/杀进程/锁屏、地图交互、SOS 全屏页、对讲双机通话。这是 CLAUDE.md Definition of Done 的硬要求 | 无（本轮 0 项） |
| 2 | **头盔真机 + v0.6 固件** | BLE 全链路（握手/对时/ACK/Flash 补传/帧翻译），即 MVP 唯一真机数据链路 | Mock 中转（业务层等价，物理层零覆盖） |
| 3 | **硬件补 Wi-Fi 四项参数**（子码流 id 与分辨率、`rtsp_net_type` 实配值、拉流 URL 与鉴权、AP 的 SSID/密码/IP） | 实时视频预览的 RTSP 播放器 Spike 开工（决策 #37 已拍板进 MVP，当前零实现） | 无 |
| 4 | **腾讯云短信签名 + 模板过审**（六项 env） | SOS 短信真实送达验证。**目前无法证明联系人真的收到过任何一条短信** | Console Mock |
| 5 | **推送通道**（极光 + APNs，依赖 Apple 公司账号） | App 被杀后的 SOS 兜底推送 | Console Mock + 本地通知 |
| 6 | **允许在 development 环境打一次点**（或你代跑一条 curl） | 验证 Caddy 是否剥离不可信 `X-Forwarded-For`（决定 AUTH-07 是否在生产被缓解）、内部 EMQX 回调是否真的对公网可达（MQTT-03） | 本轮按规则未连云端 |
| 7 | **拍板两处口径** | ① 已注销用户在后台是否应显示与计数（ADMIN-04）；② 换绑期间 SOS 合并规则按设备还是按用户（SOS-03） | 已记录为待定 |

## 10. 本轮资源与清理

**仍在运行（需要时请清理）**：
- Docker 容器 `helmet-audit-0913-pg`（127.0.0.1:55432）与 `helmet-audit-0913-emqx`（127.0.0.1:51883），均为本轮新建、无数据卷。清理：`docker rm -f helmet-audit-0913-pg helmet-audit-0913-emqx`
- 其中 14 个 `helmet_audit*` 库保留了本轮合成数据（供复核与复跑）；未触碰任何既有数据库或容器

**已清理**：所有临时后端进程（3010/3100/3300/3400/3500/3501/3502/3503）与 Vite（5173）均已停止，端口空闲；Playwright 装在 scratchpad 而非仓库。

**工作区改动**：
- 新增 `docs/testing/2026-09-13/`（报告 + 证据 + 可复跑脚本）
- 新增 19 个 `backend/test/audit-*.e2e-spec.ts` + 5 个 helper、6 个 `app/src/**/__tests__/audit-*.test.ts`
- `.gitignore` 追加两行（`docs/testing/**/.admin.env`、`docs/testing/**/.devices.env`），凭证文件不入 Git
- **未修改任何业务源码**，未提交、未推送
- 7 个 iCloud `" 2"` 杂散副本原样保留（另有 1 个 `nul.guard 2.ts` 在本轮期间由同步产生，内容与原文件一致）

## 11. 修复记录

见同目录 `FIXES.md`（2026-09-14/15，分支 `fix/audit-2026-09-13`）：4 个 P1 与大部分 P2 已修并用本轮审计测试复验转绿，既有 E2E 227/227、单测 86/86 无回归；SOS-03 已按负责人 2026-09-15 拍板（决策 #40，两单并存 + migration）修复；ADMIN-04 按负责人 2026-09-15「记录保留」口径修复（默认隐藏、可筛选、总数不计已注销）。
