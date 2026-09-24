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
