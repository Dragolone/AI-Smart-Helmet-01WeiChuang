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
