# 2026-09-24 双端真机（推送首轮 + SOS 锁屏链路）发现的缺陷

| 编号 | 严重度 | 现象 | 根因 | 状态 |
|---|---|---|---|---|
| SOS-10 | 🔴 保命链路 | iPhone 锁屏通知点「取消」后不进 App，60 s 后照样进入 notified（通知联系人）；日志 `[SOS-ALERT] 通知取消失败 FetchRequestCanceledException` | 取消动作 `opensAppToForeground: false`，请求在后台发出，iOS 随即挂起进程，fetch 被中断；没有任何重试 | ✅ 已修（FIXES SOS-10） |
| APP-03 | 🟠 卡死 | 锁屏取消成功后打开 App，倒计时页仍在 pending，点取消一直弹 `Something went wrong SOS_ALREADY_FINALIZED`，只能杀 App | 慢网下迟到的 `/sos/active` pending 覆盖 WS 已写入的 cancelled；之后 active 查不到这单，queryFn 回退信本地缓存（就是那份 pending），永远出不来。错误码无文案 → 英文系统下显示回落文案 + 原始码 | ✅ 已修（FIXES APP-03） |
| PUSH-01 | 🟡 配置 | iPhone 极光 SDK `setAlias` 后立刻 FailedRegister，拿不到 registrationID | 极光控制台该应用未配 iOS 平台（Bundle ID + APNs .p8） | ⏳ 负责人配置 |
| PUSH-02 | ⚪ 预期 | 华为杀掉 App 后收不到推送 | 无厂商通道，极光自有长连接随进程一起死 | ⏳ THIRD_PARTY §6 厂商通道注册 |
| SOS-11 | 🔴 保命链路 | iPhone 刚按下锁屏的瞬间收到 SOS，锁屏上**没有**任何通知（上一秒锁屏就有） | WS 在 appState=inactive 到达，iOS 视为前台投递、要问 App 是否显示；App 从未设 `setNotificationHandler`，expo-notifications 默认不显示 → 通知被吞 | ✅ 已修（FIXES SOS-11） |
| SOS-12 | 🔴 保命链路 | 按下电源键的同一秒另一台触发 SOS，iPhone 什么都没收到，直到 60 s 到期通知联系人 | 锁屏瞬间 iOS 掐断 socket（`1006 Socket is not connected`），WS 5 s 后才重连；SOS 恰在这几秒内创建，WS 不重推，而 REST 补拉只在冷启动跑 | ✅ 已修（FIXES SOS-12）；根治仍是 APNs 远程推送（PUSH-01） |
| SOS-13 | 🔴 保命链路 | SOS 比锁屏早到一秒：倒计时页已弹出、随后用户锁屏，锁屏上什么都没有（也听不到声音，锁屏后音频会话激活失败） | 锁屏通知只在「SOS 到达时 App 不在前台」这一个时机弹；到达时在前台就再也没有机会 | ✅ 已修（FIXES SOS-13） |
| APP-04 | 🔴 保命链路 | 升级到带同意勾选的版本前就登录着的用户，极光永远不初始化（被杀后收不到 SOS 推送），日志只见「未同意隐私政策」 | 会话从 SecureStore 恢复、永远不经过登录页，没有任何 UI 能触发 accept()；2026-09-26 代码评审发现 | ✅ 已修（一次性同意弹窗，FIXES 09-26） |
| APP-05 | 🟡 UI | 紧急联系人为空时页面中间空态里有一个「添加第一位联系人」按钮、底部又有常驻的「添加联系人」——两个添加；空态里的按钮文字顶着药丸两端 | 空态与底部栏各放了一个入口；`PrimaryButton` 只按撑满宽度设计、没有水平内边距，按内容收缩时文字贴边 | ✅ 已修（2026-09-26 iPhone 真机发现） |
| APP-06 | 🟡 UI | 地图轨迹回放：一拖进度条/点播放就冒出「回实时」按钮，进度条被挤短一截；「回实时」不是人话 | 按钮是条件渲染插进同一行，行宽随之变化 | ✅ 已修（2026-09-26 iPhone）：该格常驻定宽，实时时显示灰字「实时」、回放时变「回到实时」 |
| APP-07 | 🟡 体验 | 飞行模式关掉后，顶部断网提示条还要拖十几秒才消失（8.1） | 断线重连按 1→2→4→8→16 s 指数退避，网络恢复时下一轮重连早已排到十几秒后，只能干等 | ✅ 已修（2026-09-26）：回前台立刻重连并清零退避 |
