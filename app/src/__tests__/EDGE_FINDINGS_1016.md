# App 边界单测发现（2026-10-16）

本轮在 `test/app-edge-1016` 上给 `services/`、`hooks/`、`i18n/` 等纯逻辑补边界单测。
非保命模块里修法小而明确的 bug 已直接修（见分支提交记录）；**这里只记保命链路里发现、按约定没有改行为的问题**。
对应的测试只断言现状，测试名里标了「现状」和编号；以后改了行为，同步改那几条断言即可。

---

## A1 服务端时钟：手机时间中途跳变后，偏移要二十多个响应才追上（`services/server-clock.ts`）

- **现象**：学到偏移之后手机时间被往前拨 1 小时（手动改时间、长时间离线后系统自动校时），
  下一个响应只追回 30%：`serverNow()` 仍比服务器快 42 分钟，倒计时页按它算剩余时间，会一打开就显示 0
  ——正是 F-3 当初要防的「用户以为已经通知了」。往回拨则倒计时停在 60 不动。要连续 23 个响应才追回到 1 秒以内。
- **复现**：`edge-server-clock-1016.test.ts`「手机时间被往前拨 1 小时」「跳变后要连续好几个响应才追回」。
- **期望**：样本和当前偏移差得很多（比如超过 30 秒，网络慢不会慢这么多）时，判为时钟跳变，直接采信新样本。
- **代码位置**：`noteServerDate` 第 19 行 `offsetMs = samples === 0 ? sample : Math.round(offsetMs * 0.7 + sample * 0.3)`。
- **建议修法**：`Math.abs(sample - offsetMs) > 30_000` 时 `offsetMs = sample`，否则照旧平滑。
- **附带两点（同一处，负责人定）**：
  1. 已知：冷启动第一个响应若是慢响应，会被直接采信，偏移偏低几秒（测试「第一个响应慢了 5 秒」钉了现状）。
     可以取「前几个样本里最大的那个」（Date 头只会偏早不会偏晚）。
  2. `Date.parse` 很宽松（V8 把 `"0"` 解析成 2000 年），坏代理改写 Date 头时偏移会变成负 26 年。
     可以加一道「和手机时钟差超过一年就忽略」。

## A2 头像首字：联系人名以零宽字符 / 方向控制符开头时头像是空白（`services/sos-delivery.ts`）

- **现象**：倒计时页和「求救短信已发出」页联系人头像里写名字第一个字。名字以 U+200B、U+202E 这类看不见的字符开头时，
  头像圆里是一个看不见的字（空白圆）；德文 ß 开头大写成「SS」两个字母；组合表情只取第一个码点（👨‍👩‍👧 显示 👨）。
  联系人名接口接受这些字符（头盔名同类问题本轮已修，见 `cleanHelmetName`）。
- **复现**：`edge-sos-display-1016.test.ts`「名字以零宽字符开头」「ß → SS」。
- **期望**：先去掉看不见的字符再取第一个字；大写后多于一个字符时保留原字。
- **代码位置**：`initialOf`（第 51–54 行）。
- **建议修法**：复用 `safety-status.ts` 的 `cleanHelmetName` 先整理，再 `Array.from(...)[0]`；`first.toUpperCase()` 长度不为 1 时用 `first`。
  影响面只是头像显示，风险很低，但文件在保命链路里，按约定不动。

## A3 通知发送结论：契约外的状态值让结论和轮询不一致（`services/sos-delivery.ts`）

- **现象**：短信记录的 `status` 不是 `pending / sent / failed` 三者之一（比如服务端以后加了 `queued`）时，
  `deliveryStateOf` 落到「全部失败」，`deliveryPollInterval` 却返回 `false` 停止轮询——页面会一直写「没发出去」，不再刷新。
- **复现**：`edge-sos-display-1016.test.ts`「契约外的状态值」。
- **期望**：认不出的状态按「还在发」处理（继续轮询、不下失败结论），或至少两边口径一致。
- **代码位置**：`deliveryStateOf` 第 33 行、`deliveryPollInterval` 第 45–47 行。
- **建议修法**：两处都把「不是 sent / failed」视为 pending。当前契约（shared `SosNotificationPublic.status`）只有三种值，不紧急，改契约时一起改。

## A4 求救相关的页面跳转把编号原样拼进路径（`services/push.ts`、`services/sos-alert.ts`、`hooks/use-realtime.ts` 等）

- **现象**：`/sos-active?sosId=${sosId}&deviceId=${deviceId}`、`/accident/${sosId}` 都没做 `encodeURIComponent`。
  编号里有 `&`、`?`、`/` 时会落到别的参数或别的页面（`sosId = "a&deviceId=x"` → 倒计时页拿到的 deviceId 是 x）。
- **复现**：`edge-push-1016.test.ts`「编号原样拼进路径」。
- **期望**：路径和查询参数里的编号一律编码。
- **现实影响**：sosId 是服务端生成的 UUID / cuid、deviceId 受 `[A-Za-z0-9_-]` 约束，今天不会出事；属于纵深防御。
  同样的写法还在 `safety-records.tsx`、`safety.tsx`、`accident/[accidentId].tsx` 等页面（非保命，但统一改更好）。
- **建议修法**：加一个 `sosActiveHref(sosId, deviceId)` 小函数集中拼接并编码，各处改用它；`audit-navigation` 加一条守护。

## A5 同一台头盔前后两单的 WS 消息乱序：旧单的终态把新单从「进行中」缓存里清掉（`services/sos-sync.ts`）

- **现象**：新单 s2 的 `pending` 先到、旧单 s1 的 `notified`（或 `cancelled`）后到时，`applySosUpdate` 无条件把
  `["sos-active", deviceId]` 写成 `{ sos: null }`。s2 的倒计时页已经拉起过不受影响，但：安全页「求救进行中」卡片消失
  （要等 30 秒轮询才回来）；这期间 App 退到后台，`alertPendingOnBackground` 读不到 s2，不会补弹锁屏通知（不变式 ③）。
- **复现**：`edge-sos-sync-1016.test.ts`「新单 s2 的 pending 先到、旧单 s1 的 notified 后到」。
- **现实概率**：服务端 notified 的推送在事务后立即发、同一条 WS 连接按序到达，正常不会乱序；
  REST 补拉（`resumePendingSos`）与 WS 交错、或服务端以后改成异步推送时可能出现。低。
- **期望**：终态只清掉「进行中缓存里正是这一单」的情况。
- **代码位置**：`applySosUpdate` 第 65–67 行。
- **建议修法**：终态时先读 `["sos-active", deviceId]`，只有其中 `sosId === sos.sosId`（或为空）才写 `null`。

## A6 档案晚到时，匿名分区里的高危事件被丢下（`hooks/use-realtime.ts` + `services/ble-relay-uplink.ts`）

- **现象**：钥匙串里只有 token、用户档案没落上盘时（上次登录档案落盘失败），冷启动先以匿名分区启动上行队列；
  `/users/me` 回来后 `onUserReady` 先 `stopRelayUplink()` 再 `startRelayUplink(uid)`。这段时间里收到的摔倒 / 求救如果首发失败
  （深睡刚醒、弱网），会留在**匿名**分区文件里，本人分区不会补传它；而头盔那边 App 一入队就回了 ACK、事件已擦除——这次摔倒就丢了。
  同一账号、同一把 token，只是档案晚到，被当成了「换了一个人」。
- **复现**：`edge-ble-relay-uplink-1016.test.ts`「匿名期间收到的摔倒首发失败，换到本人分区后不再补传」。
- **现实概率**：要同时满足「档案没落盘」「档案回来前的几秒里摔倒」「首发失败」，很低；但后果是静默丢失。
- **期望**：同一会话里从匿名换到本人名下时，把匿名队列里的事件带过去（它们就是这个 token 下收到的）；真正的「未登录 → 别人登录」仍不带。
- **代码位置**：`use-realtime.ts` `onUserReady`（第 113–116 行）；`ble-relay-uplink.ts` `startRelayUplink` / `stopRelayUplink`。
- **建议修法**：uplink 加一个 `adoptRelayUplinkOwner(uid)`：只在当前 owner 是匿名时调用，直接把内存队列改记到 uid 名下并落盘，
  再删掉匿名文件；`onUserReady` 在「上一次是匿名」时用它代替 stop + start。

## A7 413（请求体超 100 KB）时每轮重发同一批，这台头盔永远卡住（`services/ble-relay-uplink.ts`）

- **现象**：`flushRelayQueue` 把 413 当成「可能恢复」，整批保留、下轮原样重发；同一批永远超限，这台头盔的积压
  （高危排在批首，正是摔倒 / 求救）再也送不出去。别的头盔靠轮转不受影响。
- **复现**：`edge-ble-relay-uplink-1016.test.ts`「413 每轮重发同一批」。现有 `edge-ble-relay-uplink.test.ts` 把 413 和 429 / 5xx 归为一类。
- **现实概率**：今天一条中转事件约 300–400 字节，100 条约 35 KB，离 100 KB 还有余量；载荷以后加字段（原始字节、更长的固件版本）就可能撞上。
- **期望**：413 时把这台头盔的批次减半重试（至少保证高危事件能单条送出），而不是原样重发。
- **代码位置**：`flushRelayQueue` 第 255–258 行（`.slice(0, MAX_BATCH)`）与第 294–306 行的错误分支。
- **建议修法**：模块级记一个「这台头盔当前批量上限」，413 时减半（下限 1），成功后逐步恢复到 100。

## A8 2xx 但响应体是 null 时，「高危已接受」回调没走、网络锁没放（`services/ble-relay-uplink.ts`）

- **现象**：`relayApi.push` 返回 `null`（网关把响应体改成 `null`）时，这一批先出队，随后读 `counts.invalid` 抛 TypeError，
  落进 catch：日志写「提交失败,保留缓存」（其实已出队），`notifyCriticalAccepted` 不调（倒计时页少了这条拉起路径，仍有 WS / 推送兜底），
  `releaseNetwork` 不调（锁要等 90 秒超时）。
- **复现**：`edge-ble-relay-uplink-1016.test.ts`「响应体是 null」。
- **现实概率**：极低（服务端 202 一定带计数）；记下是因为日志会误导排查。
- **建议修法**：`const counts = (await relayApi.push(...)) ?? { accepted: 0, duplicate: 0, invalid: 0 }`，并按「已消化」走后续分支。

## A9 锁屏提醒：第一条通知没排上之后，同一单再也不排（`services/sos-alert.ts`）

- **现象**：`showSosAlertIfBackground` 一进来就把 sosId 记进 `alerts` 去重表，再去 `scheduleNotificationAsync`。
  排通知抛错时只打日志，表里的记录不撤——之后同一单再叫（`alertPendingOnBackground` 离开前台补弹、补拉、WS 重推）都在
  `alerts.has(sosId)` 那一行直接返回，这一单直到结束都不会再有锁屏提醒（不变式 ③）。
- **复现**：`edge-sos-alert-1016.test.ts`「第一条通知没排上……之后再叫也不再排」。
- **现实概率**：iOS 没权限时排通知不抛错（静默不显示）；Android 13+ 未授权、系统通知服务偶发异常时可能抛。
  用户在倒计时期间去设置里打开通知、再锁屏，这一单仍不会补弹。
- **期望**：第一条（会响铃的那条）没排上时把这一单从去重表里撤掉，下次还能再试。
- **代码位置**：`showSosAlertIfBackground` 的 `alerts.set(sosId, entry)`（第 375 行）与末尾 catch。
- **建议修法**：catch 里 `if (entry.ids.length <= 1 && alerts.get(sosId) === entry) alerts.delete(sosId)`
  （只在第一条都没排上时撤；刷新档失败不影响已经响过的那条）。

## A10 通知按钮「取消」遇到 404 / 403 也重试三次（`services/sos-alert.ts`）

- **现象**：`cancelFromNotification` 只把 `SOS_ALREADY_FINALIZED` 当成功，其余错误一律按 2 / 5 / 10 秒重试三次，
  用尽后弹「取消没送达」并带到倒计时页。这单不存在 / 不是本账号的（404，比如换账号后点了旧通知）时，重试注定失败，
  用户要白等 17 秒才看到结果，倒计时页显示的是「这条求救不存在」。
- **复现**：`edge-sos-alert-1016.test.ts`「这单不存在 / 不是自己的（404）也按 2 / 5 / 10 秒重试三次」。
- **期望**：404 / 403 这类服务端明确拒绝的不重试，直接撤掉通知并说明（与上行队列 `isUnrecoverable` 同口径）。
- **代码位置**：`cancelFromNotification` 的 catch 分支（第 292 行起）。
- **建议修法**：`status === 404 || status === 403` 时按「这单已不在」收尾：结束在途标记、撤通知，不排重试。低优先级。

## A11 绑了 20 顶以上时，BLE 只盯服务端列表的前 20 顶，可能把「当前头盔」排除在外（`services/ble-link.ts`）

- **现象**：`setBleTargets` 去重后 `slice(0, 20)`，注释说「服务端按绑定时间排，当前头盔在前」；但 `GET /devices` 是
  `orderBy: { boundAt: 'desc' }`（最新绑的在前），而「当前头盔」是用户在设备页「设为当前」选的，可以是很早绑的那顶。
  绑了 21 顶以上、当前头盔又排在 20 名以后时，这顶头盔不在扫描目标里，摔倒事件不会经 BLE 中转。
- **复现**：`ble-link.test.ts`「绑定上千顶时链路只盯列表最前面的 20 顶」已钉住「取列表前 20」这一现状；
  把当前头盔放到第 21 位即可看到它不在 `currentBleTargets()` 里。
- **现实概率**：真实用户绑不到 20 顶，几乎不会发生；记下是因为注释与实际排序不符。
- **期望**：截断前先把当前头盔（以及在线的）挪到最前。
- **代码位置**：`setBleTargets` 第 777–787 行；调用方 `use-realtime.ts` 的 `bleTargetsOf`。
- **建议修法**：调用方传目标时按 `currentHelmetOf` 的结果把当前头盔排第一；或者只改注释说明「取最新绑定的 20 顶」。
