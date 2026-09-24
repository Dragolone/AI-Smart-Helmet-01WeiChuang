# 2026-09-24 双端真机（推送首轮 + SOS 锁屏链路）发现的缺陷

| 编号 | 严重度 | 现象 | 根因 | 状态 |
|---|---|---|---|---|
| SOS-10 | 🔴 保命链路 | iPhone 锁屏通知点「取消」后不进 App，60 s 后照样进入 notified（通知联系人）；日志 `[SOS-ALERT] 通知取消失败 FetchRequestCanceledException` | 取消动作 `opensAppToForeground: false`，请求在后台发出，iOS 随即挂起进程，fetch 被中断；没有任何重试 | ✅ 已修（FIXES SOS-10） |
| APP-03 | 🟠 卡死 | 锁屏取消成功后打开 App，倒计时页仍在 pending，点取消一直弹 `Something went wrong SOS_ALREADY_FINALIZED`，只能杀 App | 慢网下迟到的 `/sos/active` pending 覆盖 WS 已写入的 cancelled；之后 active 查不到这单，queryFn 回退信本地缓存（就是那份 pending），永远出不来。错误码无文案 → 英文系统下显示回落文案 + 原始码 | ✅ 已修（FIXES APP-03） |
| PUSH-01 | 🟡 配置 | iPhone 极光 SDK `setAlias` 后立刻 FailedRegister，拿不到 registrationID | 极光控制台该应用未配 iOS 平台（Bundle ID + APNs .p8） | ⏳ 负责人配置 |
| PUSH-02 | ⚪ 预期 | 华为杀掉 App 后收不到推送 | 无厂商通道，极光自有长连接随进程一起死 | ⏳ THIRD_PARTY §6 厂商通道注册 |
