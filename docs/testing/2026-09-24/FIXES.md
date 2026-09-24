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
