# 求救（SOS）App 端状态 × 事件矩阵（2026-10-20，按 main 代码枚举）

> 子代理只读代码做的枚举，格子里带 文件:行；Q2 / Q3 / Q4 已在模拟器复现并修（#318 / #317 / #319），其余可疑格子等负责人定口径。见 NIGHT_TEST.md「边界第三轮」。

# SOS 一单在 App 端的「状态 × 外部事件」矩阵（只读分析，2026-10-20）

分析对象：`helmet-ui-worktree` 分支 `fix/sos-link-bad-id`（= main + #315 的 400/403 小修）。全部结论来自读代码，没跑模拟器。
文件路径省略前缀：App 端 = `app/src/…`，后端 = `backend/src/…`。行号以本次读到的文件为准。

## 0. 先把机制摆清楚（后面每个格子都靠这几条）

| 机制 | 在哪 | 要点 |
|---|---|---|
| 服务端状态机 | `sos/sos.service.ts:97-127`、`sos/sos-notifier.service.ts:60-117`、`sos/sos-scheduler.service.ts:118-143` | `pending → notified \| cancelled`，三条路（cancel / confirm / 到期扫描 / 设备再发 manual_sos）全靠 `updateMany where status=pending` 条件更新，只有一方赢；输的一方 409 `SOS_ALREADY_FINALIZED`。到期扫描 5 s 一轮（`sos.constants.ts:13-14`），一轮最多 50 单。 |
| 谁能取消 / 确认 | `sos.service.ts:190-196` `getOwned` | 只认**建单时固化的 userId**，别人一律 404 `NOT_FOUND`（不是 DEVICE_NOT_FOUND）；头盔解绑、换绑都不影响本人处置权。 |
| WS 推送对象 | `realtime/realtime.gateway.ts:188-193` | 按 userId 推到该用户**所有**连接：建单（`sos-trigger.service.ts:218`）、取消（`sos.service.ts:111`）、notified（`sos-notifier.service.ts:103`，在投递之前）。 |
| 合并规则 | `sos-trigger.service.ts:184-237, 329-369` | 同一顶同一用户已有 pending：`possible_fall` 只留档；`manual_sos`（**不管来自实体键还是 App 长按**）直接 `finalizeNotified` = 立即通知；同一 eventId 重放跳过；升级时发现已被取消 → 当作终态后的新事件建新单。 |
| App 缓存键 | `services/sos-sync.ts:61-96`、`services/sos-queue.ts:30-48` | `["sos", sosId]` = 某单权威快照；`["sos-active", deviceId]` = 该头盔进行中那单（或 null）；队列从所有 `["sos-active", *]` 推导、每顶只留晚建的那单；`isFinal(["sos", id])` 是终态守卫，迟到的 pending 盖不回去（`sos-sync.ts:69, 113, 226, 240`）。 |
| 「拉起过」登记 | `sos-sync.ts:42-58`、`sos-active.tsx:199-201` | `presentedSos` 进程级集合；同一单只 `openCountdown` 一次；页面挂载即自登记（含胶囊切到的单）。**applySosUpdate 的锁屏提醒只在首次 present 时发**（`sos-sync.ts:84-93`），`resumePendingSos` 每次都发（`sos-sync.ts:116-121`）。 |
| 页面在屏标记 | `sos-queue.ts:15`、`sos-active.tsx:189-195`、`hooks/use-realtime.ts:188-193` | `sosScreen.mounted` 为真时新单只进队列不叠页；**演练页不置位**。界面被拆（`bridge-lifecycle.ts:15`）时 `openCountdown` 直接返回。 |
| 页面取权威状态 | `sos-active.tsx:228-257`、`api/sos.ts:50-69` | 进页 + 每 10 s（`sos-sync.ts:210-215`，null 也算没结束继续拉）`snapshot`：先 `/devices/{id}/sos/active`（设备 404 → 吞掉）再 `/accidents/{sosId}`；404/400/403 抛给页面当「没有这一单」（`sos-active.tsx:164-166`），其它错误返回缓存 ?? null。 |
| 本地倒计时 | `sos-active.tsx:217, 337-351, 490`、`services/server-clock.ts`、`services/countdown.ts:20-22` | `left = ⌈(deadline − serverNow())/1000⌉` 夹在 0–60；`serverNow` 偏移只从 **REST 响应的 Date 头**学（`api/client.ts:84-98`），样本与当前偏移差 >30 s 直接采信（`server-clock.ts:15, 28-31`）；WS / 极光不带时间。`finished` 只看 `status`（`sos-active.tsx:491`），**本机永远不自判到期**。 |
| 警报 | `sos-active.tsx:357-461` | `counting = sos.status==="pending" && !cancellingFromNotification`；每秒播 wav + Heavy 震动，最后 10 s 连两下；后台可播（`setAudioModeAsync shouldPlayInBackground`）。 |
| 按钮禁用 | `sos-active.tsx:206-212, 1068-1088, 1274, 1288-1297` | 本页 `busy`（cancel/confirm）互斥：确认键 `disabled={busy!==null}`，滑块 `busy={busy==="cancel" \|\| 通知按钮取消在途}`、`disabled={busy==="confirm"}`；`actAll` 也走 `busy`。 |
| 锁屏提醒 | `services/sos-alert.ts:385-490, 520-530` | App 非 active 时按 sosId 排一条 + 预排「还剩 30 / 10 秒」两条刷新；撤时按固定编号撤（进程被杀后也能撤）；iOS 顺手撤极光那条（`dismissRemoteTwins`，只在取消成功与首弹 sweep 时调）。 |
| 通知按钮取消 | `sos-alert.ts:272-360` | `begin(sosId)` 在途标记 → 页面「取消中…」+ 不响警报；409 当成功；404/403 不重试 + 撤通知 + 提示；其它失败 2/5/10 s 重试三次（回前台立刻再试一次不计数）→ 用尽后带到倒计时页 + 提示。 |
| 后台 / 孤儿 | `use-realtime.ts:370-380, 406-430`、`bridge-lifecycle.ts` | 退到 background 时按缓存补弹锁屏提醒（`sos-sync.ts:157-187`）；界面被划掉仍登录 → 订阅 / WS / 队列 / 别名都留着，只是不跳页；下次界面起来 `attachBridgeUi` → 清 `presentedSos` → 冷启动补拉重新弹页。 |

### 坐标轴

**App 端状态（列）**

| 列 | 含义 |
|---|---|
| S0 | 没有单（页面没开、缓存里没 pending） |
| S1a | 倒计时中 · 本机触发（安全页长按 / 结果页「我还是需要帮助」） |
| S1b | 倒计时中 · 头盔实体键 / 别的设备触发（页面由 WS / 补拉 / 通知拉起） |
| S1c | 演练（`?drill=1`，不碰服务端） |
| S2 | 正在提交「立即求救」（本页 `busy==="confirm"`） |
| S3 | 正在提交「取消」（本页 `busy==="cancel"`，或通知按钮 `inFlight[sosId]`） |
| S4 | 已通知（notified，含到期后收到终态；结果页 / 多单结果页） |
| S5 | 已取消（结果页，有「我还是需要帮助」） |
| S6 | 服务端已到期、本机还没收到终态（数字停在 0，仍 pending） |
| S7 | 状态未知（页面开着、两条 REST 都失败，数字「—」） |
| S8 | 页面没打开但锁屏通知挂着（App 在后台 / 被杀） |
| S9 | 界面被划掉但仍登录（孤儿期，#265 bridge-lifecycle） |

**事件（行）** E1–E23 见下表首列。

图例：✅ 处理得对 · ⚠ 可疑（编号见 §3）· ❌ 没处理 · — 不适用 / 到不了 · 「同 Sx」= 与该列同一路径。

## 1. 矩阵

| 事件 \ 状态 | S0 没有单 | S1a 倒计时·本机触发 | S1b 倒计时·头盔/他机触发 | S1c 演练 | S2 提交立即求救 | S3 提交取消 | S4 已通知 | S5 已取消 | S6 到期未收终态 | S7 状态未知「—」 | S8 页没开·通知挂着 | S9 孤儿期 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 BLE 来 fall（同一顶） | ✅ 建单→WS pending→弹页 [N1] | ✅ 服务端只留档，本机核对无变化 [N2] | 同 S1a | ⚠ 真单盖在演练上、两路警报 [Q4] | 同 S1a（服务端按 pending 合并） | 同 S1a | ✅ 新单→队列→自动切回倒计时 [N3] | 同 S4 | 同 S1a（服务端已 notified 则建新单） | ✅ 核对把快照写进缓存，页面活过来 [N4] | ✅ 锁屏再弹一条（新单）或无动作（同单） [N5] | ✅ 不跳页只弹锁屏 [N6] |
| E2 BLE sos 按钮（同一顶） | 同 E1 | ✅ 服务端升级为 notified→WS→页面「已通知」 [N2] | 同 S1a | ⚠ 同 Q4 | ✅ 两边都 notified，409 一方 refetch 收敛 [N7] | ✅ 谁先到谁赢，页面 refetch 收敛 [N7] | ✅ 终态后建新单→切回倒计时 [N3] | 同 S4 | 同 S1a | 同 S1a | 同 E1 | 同 E1 |
| E3 BLE collision | ✅ 不进 SOS，只失效事件缓存 [N8] | ✅ 同左 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| E4 头盔断开 | ✅ 与 SOS 无关 [N9] | ✅ 倒计时在服务端，不受影响 [N9] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅「我还是需要帮助」走 app-relay 不需要头盔 [N9] | ✅ | ✅ | ✅ | ✅ |
| E5 同一顶再来一单（本机漏了旧单终态） | 同 E1 | ✅ 直接切到新单、撤旧单提醒、补拉旧单终态 [N10] | 同 S1a | ⚠ Q4 | ⚠ busy 跨单残留 [Q9] | ⚠ Q9 | ✅ 队列→切回 [N3] | 同 S4 | ✅ N10（这正是 4.27 场景） | ✅ WS/补拉写缓存后页面切过去 [N4] | ✅ 新单再弹一条；旧单那条等它终态才撤 [N11] | ✅ N6 |
| E6 另一顶来一单 | 同 E1 | ✅ 不叠页：胶囊 + 「XX 也开始倒计时」+ 全部按钮 [N12] | 同 S1a | ⚠ Q4 | ✅ 进队列，按钮仍被 busy 禁用到请求回来 [Q9] | 同 S2 | ✅ 自动切到它并提示「已通知联系人，已切到下一单」 [N3] | ✅ 提示「已取消，已切到下一单」 [N3] | ✅ 进队列；到期单之后切走 [N12] | ✅ fallback/队列 [N4] | ✅ 各自一条锁屏提醒 [N5] | ✅ N6 |
| E7 极光推送到达（未点） | ✅ 前台→补拉→弹页；后台→系统通知 [N13] | ✅ 补拉发现同单，不重复弹 [N13] | ✅ | ⚠ Q4（补拉会 push 真单） | ✅ 无动作 | ✅ | ✅ 终态推送只是系统通知 | ✅ | ✅ | ✅ 补拉写缓存救活页面 [N4] | ✅ iOS 本地那条弹出后撤掉远程那条 [N14] | ✅ N6 |
| E8 WS 快照：状态变了 | ✅ pending→弹页；终态→写缓存、撤提醒、不弹页 [N15] | ✅ 终态→结果页 + 撤锁屏提醒 [N16] | ✅ | — 演练不读 WS | ✅ 页面先显示 WS 的终态，响应回来再写一遍 [N7] | ✅ 同 S2 | ✅ 迟到 pending 被终态守卫挡掉 [N17] | ✅ N17 | ✅ notified 到达→结果页 [N16] | ✅ 救活页面 [N4] | ✅ 终态→撤本地通知（极光那条 iOS 不撤） [Q10] | ✅ N6 |
| E9 WS 快照：没变（重复 pending） | ✅ present 去重，不重复弹 [N15] | ✅ 只重写缓存，环 / 数字不抖 [N18] | ✅ | — | ✅ | ✅ | ✅ 守卫挡掉 [N17] | ✅ N17 | ✅ | ✅ N4 | ✅ sos-alert 按 sosId 去重 [N5] | ✅ |
| E10 深链：同一单 | ✅ 开页→拉权威→按状态画 [N19] | ✅ singular，同参数无动作 [N19] | ✅ | — | ✅ | ✅ | ✅ 显示结果页 | ✅ | ✅ | ✅ | ✅ 拉起 App 进该单 | ✅ |
| E11 深链：别的单 | ✅ N19 | ✅ 同一张页改参数切过去；若那单已终态则自动切回仍在倒数的 [N20] | ✅ | ⚠ 演练没 sosId → 叠一页 [Q4] | ⚠ Q9 | ⚠ Q9 | ✅ N20 | ✅ N20 | ✅ | ✅ | ✅ 点通知同路 | ✅ |
| E12 深链：假单 400/403/404 | ✅ 「这条求救不存在」+ 关闭（#315） [N21] | ✅ 切回最早到期那单，不盖住 [N21] | ✅ | — | ✅ | ✅ | ✅ N21（栈里没东西回首页） | ✅ | ✅ | ✅ | ✅ | ✅ |
| E13 用户点「立即求救」 | — 没按钮 | ✅ confirm→setQueryData→结果页；409→refetch [N22] | ✅ | ✅ 本地状态 | — 已禁用 | ⚠ 本页取消在途时禁用；**通知按钮取消在途时仍可点** [Q1] | — 没按钮 | — | ✅ 0 秒仍可点，服务端未扫到就 notified [N23] | ✅ 可点，请求照发 [N24] | ✅ 通知「查看」→进页 | ✅ |
| E14 用户滑动取消 | — | ✅ cancel→结果页；失败弹错、圆钮回左 [N22] | ✅ | ✅ | — 滑块禁用 | — 滑块「取消中…」 | — | — | ✅ 0 秒仍可取消，扫描没抢先就成功 [N23] | ✅ N24 | ✅ 「我没事，取消」→直接调服务端 + 重试 [N25] | ✅ N25 |
| E15 别的设备取消 / 立即求救了同一单 | — | ✅ WS→结果页（无提示语）+ 撤提醒；WS 断则 10 s 内轮到 [N16] | ✅ | — | ✅ 409→refetch→画对方的终态 [N7] | ✅ N7（滑了取消却看到「已通知」是如实） | ✅ 守卫 | ✅ | ✅ | ✅ | ⚠ WS 不在时预排的「还剩 30/10 秒」照样响；回前台也不撤 [Q8] | ✅ WS 在就撤 |
| E16 倒计时到期 | — | ✅ 本机只显示 0，等 5 s 扫描 + WS/10 s 轮询变 notified [N23] | ✅ | ✅ 本机推导 notified（仅演练） | ✅ 扫描先赢则 409→refetch | ✅ 同左 | — | — | 就是本列 | ✅ 轮询到 notified | ✅ 预排的「还剩 10 秒」+ 服务端「已通知」推送 [N26] | ✅ |
| E17 网络失败 / 超时 / 高延迟 | ✅ 补拉失败静默，安全页仍轮询 | ✅ 轮询失败回落缓存继续倒数；动作失败弹错可重试 [N27] | ✅ | — | ⚠ 15 s 超时内按钮全灰；confirm 响应可能被内联投递拖过 15 s [Q7] | ✅ N27 | ✅ 发送结果 3/10 s 轮询 | ✅ | ✅ | ⚠ 「—」无任何提示；iOS 没出口 [Q5] | ✅ 取消按钮按节奏重试 [N25] | ✅ |
| E18 退后台 / 回前台 | ✅ 回前台 kick WS + 刷设备 | ✅ 退 background 补弹锁屏提醒；警报继续；回前台无额外动作 [N28] | ✅ | ✅ 不补弹（缓存无真单） | ✅ | ✅ 回前台触发一次不计数的重试 [N25] | ✅ | ✅ | ✅ | ✅ 回前台无额外拉取，靠 10 s 轮询 | 就是本列 | — |
| E19 冷启动 / 被杀 | ✅ 补拉→弹页 [N29] | ✅ 被杀后重开→补拉重新弹页；预排通知仍会响 [N29] | ✅ | ✅ 演练丢失，无害 | ✅ 请求丢失，重开后仍 pending 可再操作 | ✅ 同左；通知按钮重试链丢失，通知仍在 | ✅ | ✅ | ✅ | ✅ | ✅ 点通知按钮/横幅冷启动都接得住（4.8 / 4.15） [N30] | — |
| E20 登出 | ✅ | ⚠ 页面随守卫消失、警报停、提醒撤，服务端照常倒数通知；无确认 [Q6] | ⚠ Q6 | ✅ 消失 | ⚠ Q6 | ⚠ Q6；通知按钮重试链被 resetSosAlerts 清掉 | ✅ | ✅ | ⚠ Q6 | ⚠ Q6 | ⚠ 提醒被撤，之后取消不了 [Q6] | ✅ 孤儿整个拆掉 [N31] |
| E21 会话过期 401 | ✅ | ⚠ refresh 被否定 → 同 E20，前台只有登录页顶部说明 [Q6]；refresh 暂时失败 → 当未知，缓存继续倒数 [N32] | ⚠ Q6 | ✅ | ⚠ Q6 | ⚠ Q6 | ✅ | ✅ | ⚠ Q6 | ✅ N32 | ⚠ Q6 + 会话失效本地通知 | ✅ N31 |
| E22 手机时钟跳变 | ✅ 下次 REST 响应直接采信 | ⚠ ≤10 s 显示错秒数（前跳→0 整页红、后跳→60）；不会本机判 notified、不停警报 [Q3] | ⚠ Q3 | ⚠ 前跳直接「演练结束」 [Q3] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠ 后台久无 REST 时锁屏通知正文秒数按陈旧偏移算 [Q3] | ⚠ 同 S8 |
| E23 取消 + 立即求救同一秒 | — | ✅ 本页两键互斥 [N22]；两台手机各发一个→服务端条件更新只一方赢 [N7] | ✅ | ✅ | — | ⚠ 通知按钮取消 + 本页立即求救可并发 [Q1] | — | — | ✅ N7 | ✅ | ⚠ Q1（通知「我没事」后 App 起来立刻点「立即求救」） | — |

## 2. 格子说明（N 编号）

- **N1** 头盔事件进 App：`services/ble-link.ts:366-396` 翻译后 `enqueueRelayEvent` → `services/ble-relay-uplink.ts:191-234` 高危事件持网络锁并立即 `flushRelayQueue`（257-351）；202 后 `notifyCriticalAccepted(dev)`（305-310，duplicate 也算）→ `use-realtime.ts:246-255` `realtimeClient.kick()` + `resumePendingSos([deviceId])` → `sos-sync.ts:129-139` 账号级接口一次拿全 → `take` 写两份缓存 + `present` → `openCountdown` → `router.push`（`use-realtime.ts:188-193`）。服务端：`ingest/ingest.service.ts:209-211` → `sos-trigger.service.ts:184-221` 建单、deadline = 服务端 now + 60 s、WS 推 pending、后台发「倒计时已开始」推送（5 s / 20 s 重试，每次先确认仍 pending）。
- **N2** 倒计时中同一顶再来：`sos-trigger.service.ts:329-369`：同 eventId 跳过；`possible_fall` 只留档；`manual_sos` → `finalizeNotified`（notified + WS 推），升级失败且已被取消 → 当新事件建单。App 侧只会收到 WS 终态或什么都不收到；本机核对 `present` 去重（`sos-sync.ts:54`）。
- **N3** 结果页上再来单：`sos-active.tsx:516-531` `finished && nextSos(queue)` → `setSelected`；别的头盔才提示「已切到下一单」，同一顶（「我还是需要帮助」之后那单）不提示；`bulkIds` 内的不提示。新单由 `["sos", id]` 查询拉快照。
- **N4** 状态未知时被 WS / 补拉救活：`applySosUpdate` / `take` 都 `qc.setQueryData(["sos", sosId], sos)`（`sos-sync.ts:83, 115`），页面的 `useQuery` 同键立刻拿到数据，`left` 有值、`counting` 为真、警报起（`sos-active.tsx:274, 358-359`）。
- **N5** 锁屏提醒去重：`sos-alert.ts:393-394` active 时不弹、同 sosId 只弹一次；`applySosUpdate` 只在首次 present 时请求弹（`sos-sync.ts:84-93`），`resumePendingSos` 每次请求（116-121，靠 sos-alert 自己去重）。
- **N6** 孤儿期：`openCountdown` 看 `bridgeUi.attached`（`use-realtime.ts:191`）不跳页；`showSosAlertIfBackground` 因 AppState≠active 正常弹；界面回来 `attachBridgeUi()` 返回 true → `presentedSos.clear()`（`use-realtime.ts:110`）→ 冷启动补拉重新 push 页面（238-243）。
- **N7** 并发收敛：服务端 `cancel` 先查后条件更新（`sos.service.ts:98-106`），`confirm` 走 `finalizeNotified` 条件更新（`sos-notifier.service.ts:65-69`），到期扫描同一条件（`sos-scheduler.service.ts:133-137`）；输的一方 409。App：本页 `act` 的 409 分支 `sosQuery.refetch()`（`sos-active.tsx:476-484`），`actAll` 的 409 `invalidateQueries`（793-803），通知按钮取消的 409 当成功 `settled()`（`sos-alert.ts:299-301`）→ `use-realtime.ts:267-272` 写缓存 + 失效。谁先回谁先画，两边最终都画服务端那一个终态；两个终态不会互相覆盖（服务端不可能先回 cancelled 再回 notified）。
- **N8** collision：`ingest.service.ts:209` 只对 `possible_fall / manual_sos` 进状态机；App 端 `use-realtime.ts:326-331` 只失效 `["events"]`。
- **N9** 头盔断开：`ble-link.ts:625-633` 只改 phase + 重连；SOS 全在服务端；`needHelp`（`sos-active.tsx:709-751`）和安全页长按（`(tabs)/safety.tsx:307-334`）都经 `/ingest/app-relay`，不经头盔。
- **N10** 同一顶新单先到（#259）：`sos-active.tsx:311-320` `supersededBy` 渲染期直接 `setSelected(new)`，324-331 撤旧单提醒 + `refetchQueries(["sos", old])` 让它变终态、不再回潮。队列每顶只留晚建那单（`sos-queue.ts:30-48`）。
- **N11** 后台时旧单那条本地通知：只有收到旧单终态（`applySosUpdate` 95 → `clearSosAlert`）才撤；新单到达本身不撤旧单。
- **N12** 页面在屏时别的头盔来单：`openCountdown` 看 `sosScreen.mounted` 直接返回（`use-realtime.ts:191`），队列从 `["sos-active", dev2]` 推导；`sos-active.tsx:533-542` 首见提示「XX 也开始倒计时」；991-1091 胶囊 + 全部按钮；`others.length===1` 写「XX 也在倒计时」。
- **N13** 极光「到达」：`services/push.ts:302-326` `notificationArrived` 且有 sosId → `arrivalHandler` → `use-realtime.ts:257-265` `resumePendingSos([extras.deviceId])`；`present` 去重。
- **N14** iOS 远程 / 本地两条叠：`sos-alert.ts:443-446, 479` 首弹后 3 s / 10 s 扫两遍撤远程那条。
- **N15** WS 终态到达但页面没开：`sos-sync.ts:76-82` 只在 `["sos-active", dev]` 正是这一单时清空（别的单的终态不碰，A5）；83 写 `["sos", id]`；95 `clearLockScreenAlert`。不弹页、不提示（前台时无任何界面反馈；系统推送只在非 active 显示，`sos-alert.ts:111-119`）。
- **N16** 页面开着时终态到达：缓存变 → `finished`（`sos-active.tsx:491`）→ 已取消页（1407-1444）或已通知页（1445-1538，`detail` 查询按发送结果 3/10 s 轮询，618-628）；589-591 撤当前单提醒；593-603 按「处理过的单」逐个撤（自动切单时当前单的 effect 跑不到）。WS 断线时 `countdownPollInterval` 10 s 轮询兜底（`sos-sync.ts:210-215`）。别的设备取消时页面**没有**「已在别处取消」之类的提示，只显示「已取消」。
- **N17** 终态守卫：`applySosUpdate` 69、`take` 113、`settleSnapshot` 226、`guardActiveResult` 240、队列 `isFinal` 33。
- **N18** 重复 pending：`setQueryData` 换了对象引用 → `handled` 重登记一次（`sos-active.tsx:294-306`）+ 一次 `cacheTick`；环动画 effect 只依赖 `left`（647-662），不重启。
- **N19** 深链：`_layout.tsx:155-161` `dangerouslySingular` 只对带 sosId 的；同参数不新建；页面 `routeSosId` 变 → `setSelected`（`sos-active.tsx:181-187`）。`api/sos.ts:54-68` 只带 sosId 时直接查事故记录。
- **N20** 点了别的单：目标单仍 pending → 切过去；已终态 → `finished` → `next` 自动切回仍在倒数的（`sos-active.tsx:516-531`）；推送横幅那条路更早就做了判断（`push.ts:208-229`，#256/#257：同一顶有在倒数的去那单、别的头盔有在倒数的也先去那单）。
- **N21** 假单：`sos-active.tsx:164-166` 404/400/403 → `notFound`；909-911 有队列就 `setSelected(fallback)`；914-927 空态页，`canGoBack ? back : navigate("/")`；轮询停（254）。后端 400 来源：`common/nul.guard.ts` NUL 字符、`ValidationPipe`；403 目前后端 sos 接口不会发（他人的单是 404），App 顺手兜住。
- **N22** 本页动作：`sos-active.tsx:463-488` `setBusy` → 请求 → `setQueryData(["sos", sosId], updated)`（sosId 在闭包里，切单后仍写对单）→ 409 refetch → 其它错 `showNotice` → `finally busy=null`。按钮：确认键 1274 `disabled={busy!==null}`，滑块 1288-1297 `busy={cancelBusy} disabled={busy==="confirm"}`，手势只在 `idle` 时启用（`components/slide-to-cancel.tsx:89, 105-106`），读屏「activate」同样看 idle（194-196）。
- **N23** 本机 0 秒：`shownSeconds` 夹 0（`countdown.ts:20-22`）；`finished` 只看 status；扫描 5 s 一轮 + WS 推 notified，WS 断则 10 s 轮询；期间滑动取消照发、扫描没抢先就真的取消成功（服务端权威，符合决策 #8）。
- **N24** 状态未知下操作：`act` 不看 `sos`，直接按 sosId 发；成功后 `setQueryData` 让 `sosQuery.data` 有值 → 结果页。
- **N25** 通知按钮取消：`sos-alert.ts:197-216` 远程推送只接「取消」，本地两种都接；`cancelFromNotification` 272-360（重试节奏、409 当成功、404/403 放弃并提示、用尽后带到页面）；冷启动那次点击 224-242 `consumeLaunchResponse`；在途标记让页面「取消中…」+ 静音（`sos-active.tsx:209-212, 358-359`）。
- **N26** 到期时 S8：预排的「还剩 10 秒」是到期前；到期后服务端发「SOS 已通知紧急联系人」推送（不带 sos 类别，无取消键，`sos-notifier.service.ts:278-285`）。
- **N27** 轮询失败：`sos-active.tsx:241-249` 非 404/400/403 的错误返回缓存 ?? null；缓存是 pending 就继续倒数、警报不停；`retry` 只对 notFound 关掉（255）。动作失败：`showNotice(common.failed, toUserMessage)`（485），超时 15 s（`api/client.ts:82`）按「请求超时」文案。
- **N28** 退后台：`use-realtime.ts:370-380` 非 active 时 `alertPendingOnBackground`（只认 background，`sos-sync.ts:163`）按缓存补弹；页面警报 effect 不停（音频会话允许后台）；Android 硬件返回键在 counting 时被吞（`sos-active.tsx:581-585`）。
- **N29** 冷启动：`use-realtime.ts:238-243` 设备列表首拉后 `resumePendingSos`；拉不到目标时列表到位再补一次（284-297）；WS 每次由断转连也补拉（214-225）。
- **N30** 被杀后点通知：本地通知 → `sos-alert.ts:224-242`；极光横幅 → `push.ts:285-300` 从 expo 取回启动点击（带按钮的那次不清，留给 sos-alert）；落地 `landFromPush` 199-235（查不到就进倒计时页，R-27）。
- **N31** 登出 / 会话结束时的拆除：`use-realtime.ts:393-405` `stopShared`（WS、队列、BLE、别名 `deleteAlias`、`presentedSos.clear()`、`resetSosAlerts` 撤所有提醒 + 清在途标记 + 清取消重试）；`_layout.tsx:57-67` `queryClient.clear()`；孤儿期由 `orphanBridge` 的 watchLogout 整个拆掉（`bridge-lifecycle.ts:51-57`）。
- **N32** 401 两态：`api/client.ts:240-251` refresh 被明确否定 → `clearSession` + `SessionEndedError`（守卫翻转，页面卸载）；refresh 暂时失败（断网 / 429 / 5xx）→ `SessionCheckUnavailableError`，页面当未知错误处理 → 回落缓存继续倒数（N27），动作则弹「登录状态暂时核对不了」。

## 3. 可疑格子清单（按严重度）

严重度：**中** = 会让用户误判或多发一次通知；**低** = 显示 / 体验层面，或极少触发。都没有发现「已取消后被画成已通知」这种画错终态的路径。

### Q1 【中】通知按钮「取消」在途时，「立即求救」仍可点，两请求并发（S3 × E13 / E23）

- 位置：`sos-active.tsx:206-212` `cancelBusy` 把通知按钮的在途算进去了，但 1274 确认键只看 `busy !== null`（本页的），1068-1081 的「全部」按钮同样；`cancellingFromNotification` 为真时确认键是亮的。
- 结果：用户在锁屏按了「我没事，取消」，App 起来显示「取消中…」（请求还在重试，`sos-alert.ts:344-357`）；他若以为没算数再点「立即求救」，两个请求各自飞。服务端只一方赢（N7）：
  - 立即求救先到 → 联系人被通知；取消那条 409 → `settled()` 撤通知 + 写缓存 → 页面「已通知」。用户刚按过「我没事」，看到的是已通知。
  - 取消先到 → 页面 409 refetch → 「已取消」。
  两种都不会画错状态，问题是**动作互斥没覆盖通知来源的取消**，且「取消中…」期间按下立即求救没有任何确认。
- 复现（安卓模拟器 + 云端 dev）：
  1. App 退后台，云端用 mock 注入 `possible_fall` → 锁屏出现本地通知。
  2. 开飞行模式，长按通知点「我没事，取消」→ App 被拉起，倒计时页「取消中…」（请求失败进 2/5/10 s 重试，`inFlight` 一直为真）。
  3. 此时点「立即求救」：按钮可点，失败弹「网络错误」。
  4. 关飞行模式，在 2–10 s 内立刻再点「立即求救」：和重试里的取消几乎同时到服务端。看云端该单终态和页面显示；用 `GET /accidents/{id}` 看是否发了短信（测前清空联系人）。
  变体：用模拟器 Extended controls → Cellular 把网速调到 GPRS / 信号 Poor，不开飞行模式也能让两条同时在飞。

### Q2 【中】长按求救发出后页面弹出前再长按一次 / 断网时长按两次 → 第二条 manual_sos 让服务端跳过 60 秒直接通知（S1a × 用户再按）

- 位置：`(tabs)/safety.tsx:307-334` 每次长按 `buildRelayEnvelope` 新 eventId（315），`sosFired` 只管按钮果冻（306, 676, 686），没有「上一条已发出、等页面出现」的门控；断网时每次都 `enqueueRelayEvent`（328），恢复后 `flushRelayQueue` 一批同设备两条一起提交（`ble-relay-uplink.ts:273-285`）。服务端 `sos-trigger.service.ts:340-344`：pending 中再来 `manual_sos` = SOS Now。
- 结果：第一条建单、第二条把它升级成 notified，联系人立即收短信，60 秒取消窗口没有了。F-5 只解决了「同一次动作的重试复用 eventId」，没解决「用户因为没看到页面而按第二次」。页面要等 `relay 202 → resumePendingSos → GET /users/me/sos/active` 两个来回才出现（`use-realtime.ts:246-255`），慢网下这个窗口可达十几秒，且期间安全页上没有任何「已发出，正在打开倒计时」的反馈（只有一下震动）。
- 复现：
  - 确定性版本：开飞行模式 → 安全页长按 2 s（弹「发送失败，已暂存」）→ 再长按一次（再弹一次）→ 关飞行模式 → 看云端：该头盔的单直接 notified，倒计时页一出现就是「已通知」或者根本不经过倒计时；`GET /accidents` 该单 triggerEventId 是第一条、通知记录已生成。测前清空联系人。
  - 慢网版本：Extended controls 把网络调到 GPRS/Poor → 长按 → 页面没出来 → 2 s 后再长按。
- 这条是否算缺陷要负责人定口径（「实体键 = 明确求救」的规则延伸到 App 按钮是否合适）。

### Q3 【中】状态未知「—」时安卓返回键能关页，之后这单再也不会被拉起（S7 × 退出 / E17）

- 位置：`sos-active.tsx:581-585` 返回键只在 `counting` 时吞，`counting` 需要 `sos != null`（358-359）；页面挂载时已把 sosId 写进 `presentedSos`（199-201）。关页后：WS 推 pending → `applySosUpdate` 的 `present()` 返回 false（`sos-sync.ts:54-57`）→ 不 push 页面，**也不弹锁屏提醒**（84-93 只在首次 present 时弹）；重连补拉 `take` 同样不 push（123），锁屏提醒因 App 在前台被 `sos-alert.ts:393` 挡掉。
- 结果：网络恢复后用户在 App 里，没有页面、没有警报；只有安全页的「求救进行中」卡片（`safety.tsx:543-589`）能再进去。退后台会补弹锁屏提醒（N28），所以不是完全丢，但前台这 60 秒静默。
- 复现：
  1. 云端注入一单，倒计时页弹出后记下 sosId / deviceId；滑动取消它，再注入一单拿到新 sosId（或直接用第二单）。
  2. 开飞行模式，`adb shell am start -a android.intent.action.VIEW -d "lingyizhixing://sos-active?sosId=<新单>&deviceId=<设备>"`（App 已登录、页面没开着）→ 页面显示「—」、无警报。
  3. 按系统返回键 → 页面关了。
  4. 关飞行模式，等 WS 重连（Metro 日志「重连补拉」）→ 观察：页面不弹、无警报；切到安全页能看到卡片。
- 若认为「状态未知时就该能退出」，那至少退出时应把它从 `presentedSos` 摘掉。

### Q4 【中】演练页在屏时来了真单：真单页叠在演练上，两路警报 + 两路震动同时响（S1c × E1/E2/E5/E6/E7/E11）

- 位置：`sos-active.tsx:189-195` 演练不置 `sosScreen.mounted`；`use-realtime.ts:191-192` 于是 `router.push` 真单；`_layout.tsx:157-159` singular 只对带 sosId 的路由，演练页留在栈底不卸载；演练页的警报 effect（361-461）按 `counting` 继续每秒 `alarm.play()` + 震动，真单页另起一个 `useAudioPlayer` 同样每秒播。演练倒计时在底下继续走，到点自动变「演练结束（已通知）」。
- 结果：真出事时听到两路叠在一起的警报，最后 10 秒双倍震动；真单处理完关掉后露出一张「演练结束」。
- 复现：安全页打开「演练」→ 倒计时中云端注入 `possible_fall` → 看 Metro 日志出现两次「倒计时页开始警报」，听模拟器声音（模拟器 -no-audio 时看日志 + 震动日志）。
- 反向（真单页在屏时打开演练）到不了：演练入口在安全页，被全屏页盖着。

### Q5 【低】状态未知「—」没有任何「连不上服务器」的提示；iOS 上没有出口（S7 × E17）

- 位置：`sos-active.tsx:1164` 数字位置写「—」，`pendingBody`「倒计时结束后自动通知紧急联系人」照常显示（1135-1137）；根布局的 `ConnectionBanner` 只在标签根页显示（`components/connection-banner.tsx` 头注释）。iOS 该页 `gestureEnabled:false`、pending 布局没有关闭键，服务端 5xx 持续期间只能等 10 s 一轮的轮询自己恢复。
- 结果：用户不知道是「还没拿到状态」还是「出了什么事」；安卓能按返回（见 Q3），iOS 只能杀 App。
- 复现：云端注入一单 → 页面出现后把 adb 反向代理 / 云端域名断掉（或飞行模式）→ 杀掉 App 冷启动（缓存没了）→ 点通知进页 → 「—」。

### Q6 【低→中看口径】倒计时中会话被服务端否定 / 登出：页面静默消失、警报停、锁屏提醒撤，服务端照常倒数并通知联系人（S1/S2/S3/S6/S7/S8 × E20/E21）

- 位置：`api/client.ts:244-246` → `clearSession` → `_layout.tsx:75` 守卫翻转卸载页面；`use-realtime.ts:393-405` `stopShared` 撤提醒、清在途、`deleteAlias`；`_layout.tsx:57-67` 只在非 active 时发「会话已失效」本地通知，前台只有登录页顶部说明（`auth-store.sessionExpired`）。
- 结果：另一台手机改密码 / 注销 / refresh 被判复用，正好撞上倒计时 → 这台看到的是警报突然停、回到登录页；没有「有一条求救仍在倒数，重新登录可取消」的说法。服务端照常到期通知；极光别名已解绑，终态推送也收不到。重新登录后 `resumePendingSos` 会再弹（仍 pending 时）。
- 复现：云端注入一单 → 倒计时中在另一台（或 curl）改该账号密码 / 调 `/auth/logout` 作废 refresh → 这台下一次请求（10 s 轮询）401 → 观察。
- 用户主动「退出登录」到不了这格（结果页 / 倒计时页是全屏模态，退出入口被盖着）。

### Q7 【低】「立即求救」的 HTTP 响应被服务端内联投递拖长，可能撞 App 15 s 超时（S2 × E17）

- 位置：`sos.service.ts:116-127` `confirm` 等 `finalizeNotified(sosId)`，默认 `deliverInline` → `deliverPending` 串行发每位联系人短信 + 本人推送，每条 `withTimeout(notifyTimeoutMs()=10 s)`（`sos-notifier.service.ts:107-115, 201-209`）；App 请求超时 15 s（`api/client.ts:82`）。
- 结果：短信通道卡住或联系人多时 App 弹「请求超时」，但 WS 早在投递前就推了 notified（`sos-notifier.service.ts:103`），页面其实已是「已通知」+ 一个错误弹窗；WS 也断的话要等 10 s 轮询。不会重复通知（409）。
- 复现：云端 dev 不好复现（Mock 短信秒回）；本地后端把 SMS provider 的 `send` 加 `await sleep(9000)` 再配 2 位联系人即可。
- **✅ 2026-10-22 已修（#339）**：confirm 终态化（连同通知行同一事务落库）后立即返回，首投放到后台，没发完的由扫描续投；关停排空也等后台首投；顺带堵上「占位提交到登记在飞之间另一路再占一次」的同一联系人两条短信。云端更新后可按上面的复现法复测。

### Q8 【低，已知】后台且 WS 不在时别的设备取消 → 预排的「还剩 30 / 10 秒」本地通知照样响；回前台后也不主动撤（S8 × E15）

- 位置：`sos-alert.ts:460-478` 两条刷新是系统定时触发；撤只在 `applySosUpdate` 收到终态（`sos-sync.ts:95`）或本机取消成功时；`resumePendingSos` 只写 pending（111-126），`applyAccountActive` 只写缓存（`sos-queue.ts:76-117`），都不撤已结束单的通知。`sos-active.tsx:589` 注释（F6）已承认 WS 没连上时那两条会响。
- 结果：锁屏上出现「还剩 10 秒」而单其实已取消；点它「我没事，取消」→ 409 → 撤掉；点横幅 → 落记录页。
- 复现：两台同账号；A 机退后台并关 Wi-Fi（WS 断）；B 机取消；A 机在剩 30 s / 10 s 时收到刷新通知；A 开 Wi-Fi 回前台，通知仍在。

### Q9 【低】`busy` 不按单：切单（胶囊 / 同一顶新单顶替 / 深链切别的单）后上一单在途的请求仍把新单的按钮按住（S2/S3 × E5/E6/E11）

- 位置：`sos-active.tsx:206` 单个 `busy`；1068-1088、1274、1288-1297 都读它；`act` 的 `finally` 要等请求回来（最长 15 s）。
- 结果：慢网下滑动取消 A，立刻点胶囊切到 B：B 的「立即求救」是灰的、滑块写「取消中…」，直到 A 的请求返回。
- 复现：两顶各一单 → 网络调慢 → 滑动取消当前单 → 马上点另一顶胶囊 → 看按钮。

### Q10 【低，iOS 才看得到】别的设备取消 / 到期后，iOS 通知中心里极光那条「SOS 倒计时已开始」不撤（S8 × E8/E15）

- 位置：`sos-alert.ts:520-530` `clearSosAlert` 只撤本地编号；`dismissRemoteTwins`（493-504）只在 `cancelFromNotification.settled`（288）和首弹 sweep（443-446）调用。Android 极光通知不经 expo，本来撤不了（注释已说明）。
- 结果：那条带「我没事，取消」的远程推送一直挂着；点取消 → 409 → 撤；点横幅 → 记录页。安卓模拟器测不到，记着给 iPhone 列。

### Q11 【低】时钟跳变的几个小窗口（E22）

- 偏移只从 REST 响应学（`api/client.ts:88-95`），页面 pending 时 10 s 轮询 → 跳变后最多约 10 s 显示错秒数：前跳 ≥60 s 显示 0、整页转红、震动变两下（`sos-active.tsx:614, 448-450`）；后跳显示 60。**不会**本机判 notified、不会停警报（`finished` 只看 status）。
- 锁屏通知正文的秒数（`sos-alert.ts:378-382, 403-417`）和「还剩 30 / 10 秒」的预排时机（460-478）按当时的 `serverNow()` 算：App 后台很久没发 REST、期间用户改了手机时间，WS 来单时这条通知可能写「还剩 0 秒」或刷新错位；WS 之后页面一拉快照就纠正。
- 演练：`sos-active.tsx:219-225, 258-273` deadline 和 notified 都按本机推导，前跳直接「演练结束」。
- 复现（模拟器需 `adb root`）：App 后台 → `adb shell date 010112002026`（或 Extended controls 改时间）把时间拨快 3 分钟 → 云端注入一单 → 看锁屏通知正文；点开页面看第一秒数字再看 10 s 内是否回正。演练：演练中把时间拨快 2 分钟。

### Q12 【低】安全页长按求救不看 `counts.invalid`（S0 × 用户长按）

- 位置：`(tabs)/safety.tsx:316-318` `.then(() => notifyCriticalAccepted(...))`；对照 `sos-active.tsx:722-727` `needHelp` 和 `ble-relay-uplink.ts:293-300` 都处理了 invalid。
- 结果：服务端判 invalid 只留档不建单时，长按后只有一下震动、没有页面也没有提示。App 自建 envelope 几乎不会 invalid，极少触发。

### Q13 【低，待验证】孤儿期点本地通知的「查看」：`router.navigate` 可能在导航器挂好之前被调用

- 位置：`sos-alert.ts:212-215` 监听回调里直接 `router.navigate`，没有 try/catch；孤儿期 JS 活着、`responseSub` 还在（244-247），点击立即送达，而新界面要等 `hydrated` 等条件后才挂 `RootNavigator`（`_layout.tsx:249-254`）。
- 结果（推断）：expo-router 可能抛「navigate before mounting」，但冷启动补拉（N6）随后仍会把页面 push 出来，所以多半只是一条错误日志。「取消」按钮不跳页，不受影响。
- 复现：模拟器划掉 App（进程被推送服务撑着时）→ 云端注入 → 锁屏通知展开点「查看」→ 看 logcat / Metro 有无 navigate 报错、页面是否出现。

## 4. 确认「处理得对」的关键格子

1. **并发取消 vs 立即求救（本页）**：两键互斥（N22），服务端条件更新只一方赢（N7），输方 409 → refetch；没有「已取消后又画成已通知」的路径——两个终态不可能都从服务端回来，`settleSnapshot` / `isFinal` 只挡 pending 回潮，终态之间不需要挡。
2. **时钟跳变不会本机结单**：`finished` / `counting` 只看 `status`（`sos-active.tsx:358-359, 491`），秒数夹 0–60，服务端 5 s 扫描 + WS / 10 s 轮询给终态；偏移 >30 s 的跳变下一个 REST 响应直接采信（`server-clock.ts:28-31`）。
3. **状态未知不会永远停在「—」**：`countdownPollInterval(null)` 继续 10 s 轮询（`sos-sync.ts:210-215`），只有 404/400/403 才停（#315）；5xx / 超时 / 断网都回落缓存或 null 并继续拉（`sos-active.tsx:241-249`）；WS / 极光补拉写缓存也能直接救活页面（N4）。
4. **别的设备取消**：WS 推到该用户全部连接（`gateway.ts:188-193`）→ 页面「已取消」+ 本地通知按固定编号撤（`clearSosAlert`）；WS 断则 10 s 内轮到；期间本机的取消 / 立即求救 409 后 refetch。
5. **同一顶新单直接切（#259）**：`supersededBy` 渲染期切换 + 撤旧单提醒 + 补拉旧单终态（N10）；队列每顶只留晚建那单，避免了死循环（`sos-queue.ts:30-48`）。
6. **别的头盔来单**：不叠页，胶囊 / 提示 / 全部按钮；取消哪单撤哪单的通知——三处撤提醒都按 sosId（`sos-active.tsx:324-331, 589-591, 593-603`）。
7. **后端规则**：取消 / 确认只认建单用户（404 不泄露）；已 notified 再取消 409；重复取消 409（App 当成功）；到期后再 confirm：扫描已跑 → 409，没跑 → notified（同一结果）；到期扫描、cancel、confirm、设备 manual_sos 升级四条路全走同一条件更新；`triggerEventId` + partial unique index 保证并发建单幂等（`sos-trigger.service.ts:222-234`，migration `sos_cases_one_pending_per_device_user`）。
8. **通知按钮取消的全链路**：被杀 / 后台 / 前台三种拉起都接得住（N25, N30）；409 当成功；404/403 不空等；重试用尽把人带到页面；登出清掉重试链和在途标记（`sos-alert.ts:533-539`）。
9. **孤儿期**：不跳页但照弹锁屏提醒；界面回来清 `presentedSos` 再补拉（N6）；会话结束时整个拆掉（N31）。
10. **假链接 / 他人的单 / 已解绑头盔**：404/400/403 → 空态页或切回在倒数的单（N21）；设备 404 吞掉改查事故记录（`api/sos.ts:62-66`），解绑不影响倒数与处置（4.28）。
