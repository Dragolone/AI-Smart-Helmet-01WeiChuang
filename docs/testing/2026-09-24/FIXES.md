# 2026-09-24 修复记录

## SOS-10 锁屏「取消」必须真的生效
- `services/sos-alert.ts`：取消动作改为 `opensAppToForeground: true`——请求在前台发出才不会被挂起中断；拉起后页面显示已取消，用户也得到确认。
- 新增 `cancelFromNotification()`：请求失败记下 sosId，App 回到前台立刻补发一次；`SOS_ALREADY_FINALIZED`（另一台先取消 / 最后一秒到期）视为成功不重试。
- 测试：`sos-alert.test.ts` 钉住动作选项、失败→前台重试一次、已结束视为成功。
- **边界口径（负责人 12:20 提问）**：服务端状态机是唯一权威（决策 #8）。「最后一秒点取消」→ 服务端已 notified 则返回 409，页面刷成「已通知」，如实展示；「两台同时取消」→ 后到的 409 视为成功，两台都显示「已取消」。App 不做任何本地判定。

## APP-03 倒计时页不再被迟到的 pending 卡死
- `api/sos.ts` 新增 `sosApi.snapshot(sosId, deviceId)`：active 没有这单就查事故记录（accidentId = sosId），只有两条 REST 都失败才信缓存。
- `app/sos-active.tsx`：`act()` 收到 `SOS_ALREADY_FINALIZED` 不弹错，刷一次权威状态让页面自己切到结束态。
- `error-messages.ts` + 三语字典：`SOS_ALREADY_FINALIZED` 补文案；审计清单 `KNOWN_UNMAPPED` 同步移出。
- 测试：`api/__tests__/sos-snapshot.test.ts`。

## SOS-11 锁屏瞬间到达的 SOS 通知不能被吞
- `services/sos-alert.ts` 新增前台展示策略 `setNotificationHandler`：SOS 类（category=sos）通知在非 active 状态一律横幅 + 声音；active 时倒计时页在屏上不重复弹；其他类别（低电量等）维持默认。纯函数 `sosPresentation()` 单测钉住。

## SOS-12 WS 重连后补拉进行中的 SOS
- `hooks/use-realtime.ts`：`realtimeClient.subscribeState` 每次由断转连都跑一次 `resumePendingSos`（原来只在冷启动跑）；找到 pending 时同时写 `['sos', sosId]` 缓存并调 `showSosAlertIfBackground`，App 在后台/锁屏时直接弹锁屏通知。
- 局限：断线期间 iOS 若已把进程挂起，重连要等回前台才发生——这段窗口只有 APNs 能覆盖，等极光 iOS 平台配好（PUSH-01）。

## SOS-13 倒计时进行中离开前台也要补弹锁屏通知
- `hooks/use-realtime.ts`：AppState 变为 background/inactive 时，遍历已绑定设备的 `['sos-active', id]` 缓存，有 pending 就 `showSosAlertIfBackground`（按 sosId 去重）。不变式：**App 不在前台 && 有 pending SOS ⇒ 锁屏上一定有通知**。

## 2026-09-26 代码评审（范围 c57f586..bf23e06）后的修正 —— commit 38f68f0
真机日以「先堵住」为主，两天后按评审逐条复核，9 条里 6 条成立、2 条效率/边界、1 条部分成立，全部处理：
- **SOS-10 补强**：取消失败不再撤通知；重试 2s/5s/10s 三次 + 回前台立即触发（原「等下一次 active」永远等不到，因为动作已把 App 拉到前台）。
- **APP-04（新）**：升级前就登录着的用户永远不经过登录页 → 永远没机会同意 → 极光永远不初始化。新增 `components/privacy-consent-modal.tsx`：已登录且本机未同意时一次性弹窗；不同意只能退出登录。**测试人员不再需要登出重登**。
- **SOS-11 补强**：前台展示策略不按类别过滤（极光远程推送没有 category）。
- **SOS-12 补强**：重连补拉不得用迟到的 pending 覆盖 WS 已推的 cancelled/notified。
- **SOS-13 收窄**：只认 background，避免系统 Alert/控制中心的 inactive 触发双重报警。
- 登录页：同意标记未读出时按「需要」处理。插件：mergeContents 锚不到是抛错，兜底改为真正可达。倒计时页结束后停轮询。

## APP-05 联系人空态双按钮 / 按钮文字贴边（2026-09-26）
- `app/contacts.tsx`：空态只保留图标 + 标题 + 引导语，底部常驻按钮是唯一入口。
- `components/form.tsx`：`PrimaryButton` 加 `paddingHorizontal: 20`——撑满宽度时无感，按内容收缩时（空态、行内）文字不再顶边。

## APP-06 回放进度条被「回实时」挤短（2026-09-26）
- `(tabs)/map.tsx`：状态从进度条那一行挪到 1h/6h/24h 那一行最右（负责人定的样式）：实时 = 绿色呼吸点·「实时」，回放 = 红色可点「回到实时」。进度条独占整行，宽度永不变化。文案三语「回到实时 / 回到即時 / Back to live」。

## APP-07 断网恢复后提示条拖十几秒（2026-09-26）
- `api/realtime.ts` 新增 `kick()`：未连上时清掉退避定时器、放弃卡在握手的旧连接、立刻重连；`use-realtime.ts` 在 AppState 变 active 时调用（关飞行模式必经控制中心，必有一次 active）。没引 NetInfo（新增依赖需双人同意）——只靠前台切换已覆盖实测场景。
- `api/__tests__/realtime.test.ts`：假 WebSocket 钉住指数退避、kick 清零、卡住的旧连接迟到的 onclose 不再触发重连。

## APP-08 通知权限被拒要有提示（2026-09-26）
- `services/sos-alert.ts` 新增 `isSosAlertPermissionDenied()`；`(tabs)/safety.tsx` 进页面与每次回前台各查一次，被拒时在页首放警示卡，点击跳系统设置。
- 顺带确认：App 不申请手机定位（地图展示的是头盔上报位置），8.2 的定位半边不适用；`app.json` 里 expo-location 的权限说明目前无对应使用，上架前清理（上线前清单）。
