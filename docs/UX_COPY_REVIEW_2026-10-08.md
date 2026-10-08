# App 文案审校 — 2026-10-08

应用版本：`helmet-ui-worktree`（`feat/home-redesign`）。

修订 12 份现有文案字典、216 个文案键，共 596 条语言文案（含删除的重复说明）。另从对讲页面删除两处重复说明的展示。未增加功能，未变更交互动作、业务逻辑或接口；保留文案的插值参数不变。

## 文案原则

- 状态直接说明对象与结果，减少“还没有”“没加载出来”等口语表达。
- 同一事实只解释一次，避免标题与说明重复。
- 绑定账号与蓝牙连接分别表述；地图选择与当前头盔分别表述。
- 使用“疑似摔倒”，不将检测事件写成已确认事故。
- 位置描述说明记录属性；不将离线位置称为实时位置。
- 求救流程、短信发送结果与收件人实际收到分别表述。

## 事实依据

- 紧急联系人归属账号，所有已绑定头盔共用同一组联系人：`docs/API.md` §3、`backend/src/contacts/contacts.service.ts`。
- 联系人收到短信；推送发给求救者本人：`docs/API.md` §7、`backend/src/sos/sos-notifier.service.ts`。
- `notified` 代表通知流程已启动；`sent` 代表服务商接收发送请求，不保证送达或响应：`docs/API.md` §7。
- 当前短信服务使用固定模板，不承诺短信包含位置、昵称或事件详情：`backend/src/providers/tencent-sms.provider.ts`、决策 #46。
- 求救详情页时间来自 `createdAt`，故改为“求救创建时间”；位置可来自事件或最近定位点，故改为“求救记录位置”。
- “结束本次通话”保留频道成员身份，“退出频道”会移除成员身份。

## 简体中文修改对照

繁体中文和英文同步表达相同含义；英文账号绑定动作统一为 Add helmet，连接动作保留 Connect。

对讲列表页和“创建或加入频道”弹层均删除“同一时间只能在一个频道里通话”的重复提示及对应翻译键。切换频道时保留“切换频道将结束当前通话，保留频道成员身份”，将说明集中在影响用户操作的场景。新增/加入弹层仅保留两个操作及必要说明；通话、加入、退出的行为不变。

### accident.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `sosAlert.title` | 检测到摔倒 / 紧急求助 | 疑似摔倒或紧急求救 |
| `sosAlert.body` | 60 秒后将自动通知紧急联系人，如为误触请打开 App 取消 | 60 秒后将自动通知紧急联系人，如无需帮助请打开 App 取消 |
| `sosAlert.bodyCountdown` | {seconds} 秒后将自动通知紧急联系人，误触请点「我没事」取消 | {seconds} 秒后将自动通知紧急联系人，如无需帮助请取消求救 |
| `sosAlert.cancelFailedTitle` | 取消没有发出 | 取消请求发送失败 |
| `sosAlert.cancelFailedBody` | 网络不稳定，取消请求没有送到服务器。请在倒计时页再按一次「我没事」。 | 取消请求未送达服务器，请打开求救页面重试。 |
| `accident.triggeredAt` | 触发时间 | 求救创建时间 |
| `accident.location` | 触发时位置 | 求救记录位置 |
| `accident.locationSource.event` | 事件内嵌 | 头盔事件中的位置 |
| `accident.locationSource.track` | 最近轨迹点 | 最近一次定位记录 |
| `accident.openCountdown` | 倒计时进行中，去处理 | 查看进行中的求救 |
| `accident.notNotified` | 未发送通知（倒计时内取消） | 暂无通知发送记录 |
| `accident.notif.sent` | 已送达 | 已发送 |
| `accident.notif.failed` | 失败 | 发送失败 |

### auth.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `sos.drillNotifiedBody` | 真实情况下，此刻紧急联系人已收到带你位置的短信。 | 真实求救时，系统会尝试通过短信通知紧急联系人。 |
| `sos.drillCancelledBody` | 你已在倒计时内取消，真实情况下不会打扰任何人。 | 已在倒计时内取消。真实求救时，取消后不会发送联系人通知。 |
| `auth.confirmPlaceholder` | 再输一遍 | 再次输入密码 |
| `auth.nicknamePlaceholder` | 怎么称呼你 | 输入昵称 |
| `auth.sessionExpiredTitle` | 登录已失效，头盔保护已暂停 | 登录已失效，请重新登录 |
| `auth.deleteConsequenceRecords` | 事故记录与安全事件将无法再查看 | SOS 记录与安全事件将无法再查看 |
| `sos.fall` | 跌倒检测 | 疑似摔倒 |
| `sos.cancelledBody` | 本次求救已取消，没有通知任何人。记录已保留。 | 本次求救已取消，未发送联系人通知。记录已保留。 |
| `sos.notifiedBody` | 已向紧急联系人发出通知（发送结果以通知记录为准），请保持手机畅通；若无人回应请直接拨打电话求助。 | 通知流程已启动，发送结果请查看通知记录。请保持手机畅通；若无人回应，请直接拨打电话求助。 |
| `sos.notified.sent` | 已通知紧急联系人 | 求救短信已发出 |
| `sos.notified.none` | 没有人收到通知 | 未发送联系人通知 |
| `sos.notified.failed` | 通知没有发出去 | 求救短信发送失败 |
| `sos.notified.body` | 请保持手机畅通。若无人回应，请直接拨打电话求助。 | 请查看下方各联系人的发送结果。已发送不代表对方已收到，请保持手机畅通；若无人回应，请直接拨打电话求助。 |
| `sos.notified.noneBody` | 你还没有添加紧急联系人。请直接拨打电话求助。 | 未添加紧急联系人。请直接拨打电话求助。 |
| `sos.notified.failedBody` | 短信没有发出去。请直接拨打电话求助。 | 求救短信发送失败。请直接拨打电话求助。 |
| `sos.noContacts` | 还没有紧急联系人，倒计时结束后没有人会收到通知。 | 未添加紧急联系人，倒计时结束后无法发送联系人通知。 |
| `sos.noContactsDrill` | 还没有紧急联系人，真实求救时没有人会收到通知。 | 未添加紧急联系人，真实求救时无法发送联系人通知。 |
| `sos.lateEventMinutes` | 约 {n} 分钟前的事件，刚补传到 | 约 {n} 分钟前发生的事件，现已同步 |
| `sos.lateEventHours` | 约 {n} 小时前的事件，刚补传到 | 约 {n} 小时前发生的事件，现已同步 |
| `sos.sendNow` | 立即求救 SOS | 立即求救 |

### common.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `contacts.tell` | 告诉 TA | 分享联系人说明 |
| `contacts.tellMessage` | {name}，我在「零一唯创」智能头盔 App 里把你设为了紧急联系人。如果我骑行时摔倒或按下求救、且 60 秒内没有取消，你会收到一条带我位置的短信提醒——到时请先打我电话，联系不上就报警。谢谢！ | {name}，我已在「零一唯创」智能头盔 App 中将你设为紧急联系人。触发求救后，如果倒计时结束前未取消，系统会尝试向你发送短信提醒。收到后请先联系我；若无法联系，请协助求助。谢谢！ |
| `app.crashTitle` | 出了点问题 | 页面暂时无法显示 |
| `app.crashBody` | 这一页遇到了错误，你的数据和头盔连接不受影响。 | 请重试或重新打开 App。 |
| `ble.onboarding.title` | 让头盔连上手机 | 设置头盔连接 |
| `ble.onboarding.body` | 摔倒、危险预警都靠这条蓝牙链路上报，三步做完就一直自动连接 | 头盔通过蓝牙向手机发送安全事件。请完成以下设置。 |
| `ble.onboarding.whitelistHint` | 加入省电白名单，锁屏后链路不被系统清理 | 关闭省电限制，减少后台连接中断 |
| `keepalive.title` | 请不要手动关闭 App | 保持 App 在后台运行 |
| `keepalive.body` | 锁屏、切到别的 App 都没关系。但如果从多任务里把「零一唯创」上滑关闭，头盔检测到的摔倒会等到下次打开 App 才通知。 | 使用头盔时，请保持 App 运行，并确保手机蓝牙和网络可用。锁屏或切换应用后，App 可在后台运行；强制关闭 App 可能导致摔倒和求救通知延迟或无法发送。 |
| `keepalive.androidTip` | 华为等机型：在最近任务里长按本应用选择「锁定」，可以防止一键清理时被误关。 | 部分 Android 手机支持在最近任务中锁定应用，可减少一键清理导致的意外关闭。 |
| `empty.contactsTitle` | 还没有紧急联系人 | 尚未添加紧急联系人 |
| `empty.contactsBody` | 摔倒 60 秒未取消时会自动通知他们，至少添加一位 | 请添加至少一位可在紧急情况下联系的人。 |
| `empty.devicesTitle` | 还没有绑定头盔 | 尚未绑定头盔 |
| `contacts.lead` | SOS 倒计时结束后，系统会给这里的每个人发短信与推送（最多 {max} 人）。 | 求救倒计时结束或选择立即求救后，系统会向紧急联系人发送短信通知。最多可添加 {max} 人。 |
| `contacts.addLead` | SOS 触发且未取消时，系统将短信通知该联系人并附上事故位置 | 该联系人将作为求救短信的接收人。 |

### device.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `device.err.protocol` | 头盔没听懂这条指令，请重试 | 头盔无法识别该指令，请重试 |
| `device.err.paramValue` | 该取值头盔不接受 | 头盔不支持此设置值 |
| `device.set.fallDetect` | 跌倒检测 | 摔倒检测 |
| `device.set.sosButton` | SOS 物理按键 | 头盔求救按键 |
| `device.hint.sosButton` | 关闭可防误触，但摔倒仍会自动求救 | 关闭后无法通过头盔按键求救，不影响摔倒检测设置。 |
| `device.hint.light` | 头盔重启后会回到「关」（硬件不保存） | 头盔重启后，前照灯默认关闭。 |
| `scan.notBindCode` | 这不是绑定二维码，请换一个 | 无法用于绑定，请扫描头盔绑定二维码 |
| `scan.alreadyBound` | 这顶头盔刚才已经绑定好了 | 该头盔已绑定 |
| `scan.justFailed` | 这个码刚才没绑上，移开再对准可重试 | 绑定失败，请移开二维码后重新扫描 |
| `bind.doneBody` | 已加入你的设备。 | 头盔已绑定至本账号。 |
| `bind.doneBodySafety` | 已加入你的设备，下一步把安全设置做完。 | 头盔已绑定，请继续完成安全设置。 |
| `bind.finishSafety` | 完成，去做安全设置 | 前往安全设置 |
| `bind.failedTitle` | 没有绑定成功 | 绑定失败 |
| `device.sendFailed` | 下发失败 | 设置发送失败 |
| `device.applying` | 响应中… | 正在应用设置… |
| `device.cmd.pending` | 下发中… | 正在发送设置… |
| `device.cmd.delivered` | 已送达设备，等待执行回执 | 已发送，等待头盔确认执行 |
| `device.cmd.offline` | 设备离线未送达（不显示为已生效） | 头盔离线，设置未送达 |
| `device.unbindBody` | 确定解绑 {id} 吗？历史数据会保留。 | 确定解除 {id} 的账号绑定？头盔将从设备列表移除。 |
| `device.ble.handshaking` | 握手中… | 正在验证头盔… |
| `device.ble.serviceTitle` | 头盔连接守护中 | 头盔连接服务 |
| `device.ble.serviceConnected` | 已连接头盔 {names}，摔倒与危险事件实时上报 | 已连接 {names}，正在接收安全事件 |
| `device.batteryOpt.limited` | 受省电限制，点此加白名单 | 受省电限制，点击调整 |
| `device.batteryOpt.ok` | 不受限制 | 已关闭省电限制 |
| `device.cat.safetySummary` | 跌倒检测、雷达与障碍预警 | 摔倒检测、雷达与障碍预警 |
| `device.sum.fallOn` | 跌倒检测已开启 | 摔倒检测已开启 |
| `device.sum.fallOff` | 跌倒检测已关闭 | 摔倒检测已关闭 |

### devices.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `devices.bindNew` | 绑定新设备 | 绑定头盔 |
| `devices.emptyBody` | 绑定后可以查看在线状态、电量和骑行安全信息 | 绑定并连接头盔后，可查看连接状态、电量与安全信息。 |
| `devices.safety.linkDown` | 收不到安全事件 | 安全事件接收中断 |
| `devices.safety.noContacts` | 未设置接收人 | 未添加紧急联系人 |
| `devices.ride.none` | 还没有骑行 | 暂无骑行记录 |
| `devices.otherDevices` | 其他设备 | 其他头盔 |

### errors.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `error.deviceNotFound` | 设备不存在，请核对设备编号 | 未找到该头盔，请核对设备编号 |
| `error.deviceAlreadyBound` | 该设备已被其他用户绑定 | 该头盔已绑定其他账号 |
| `error.sosAlreadyFinalized` | 这次求救已经结束（已取消或已通知），无需再操作 | 本次求救已取消或已启动通知，无需重复操作 |

### events.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `events.field.ttc` | 预计碰撞时间 | 预计碰撞剩余时间 |
| `events.field.impact` | 冲击力 | 冲击加速度 |
| `events.type.obstacle_risk` | 障碍物 | 障碍物风险 |
| `events.type.bluetooth_lost` | 蓝牙断连 | 蓝牙连接断开 |

### help.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `help.a1` | 打开头盔电源并靠近手机，进入「设备」页点「绑定新设备」，按提示输入或扫描头盔上的设备 ID 完成蓝牙配对。一台头盔同一时间只能绑定一个账号，如提示已被绑定，请先在原账号解绑。 | 打开头盔电源并靠近手机，在「设备」页选择「绑定头盔」，扫描头盔或说明卡上的绑定二维码，也可手动输入设备编号和绑定码。绑定后请完成蓝牙连接设置。每顶头盔同一时间只能绑定一个账号；如已绑定，请先在原账号解除绑定。 |
| `help.a3` | 头盔检测到疑似摔倒，或您按住求救按钮后，会开始 60 秒倒计时，由服务器计时。期间可以点「我没事」取消，或点「立即求救」跳过等待。倒计时结束仍未取消，系统会自动通知您的紧急联系人。 | 头盔上报疑似摔倒或触发手动求救后，系统会开始 60 秒倒计时。期间可在求救页面向右滑动取消，或选择「立即求救」跳过等待。倒计时结束仍未取消，系统会向紧急联系人发送短信通知。 |
| `help.a4` | 倒计时结束后，每位紧急联系人会收到一条短信，包含您的昵称、事件类型、发生时间与事故位置链接；已安装 App 的联系人还会收到推送。系统不会替您拨打电话，也不会联系急救机构。 | 系统会向紧急联系人发送求救短信，并向求救者的 App 发送推送。短信发送结果可在 SOS 记录中查看；已发送不代表对方已收到或已响应。系统不会自动拨打电话或联系急救机构。 |
| `help.a6` | 进入「设备」页 → 点击头盔 → 「蜂鸣音量」，拖动滑块后保存。设置会下发到头盔，只有头盔回复执行成功后才显示为已生效；头盔离线时会显示等待送达。 | 进入「设备」页，点击头盔后选择「蜂鸣音量」，拖动滑块并保存。头盔确认执行后，设置才显示为已生效；离线时无法送达。 |
| `help.a7` | 位置由头盔定位后经蓝牙和手机转发，再经网络上传，通常有几秒到十几秒的延迟；室内、隧道或高楼之间定位本身也会漂移。地图仅用于查看，不用于导航。 | 头盔位置通过蓝牙传至手机，再经网络同步，因此可能有延迟；室内、隧道或高楼附近也可能出现定位偏差。地图显示最近记录的位置，更新时间可在页面查看。「导航到记录位置」会打开高德地图，目的地为该记录位置。 |
| `help.a8` | 进入「对讲」页，点「输入邀请码加入」，输入频道创建者分享给您的 6 位邀请码。加入后按住说话键即可通话；头盔连上手机后语音直接从头盔收发。对讲需要手机有可用网络。 | 在「对讲」页选择「输入邀请码加入」，输入收到的 6 位邀请码。进入频道后，可使用「按住说话」或「持续通话」。使用头盔收发语音前，请确认头盔音频已连接到手机。对讲需要可用的网络。 |

### intercom.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `intercom.emptyTitle` | 和队友保持通话 | 尚未加入对讲频道 |
| `intercom.emptyBody` | 创建一个频道，把邀请码发给同行的人；<br>头盔连上手机后语音直接从头盔收发。 | 创建频道并分享邀请码，或输入邀请码加入。<br>使用头盔通话时，请连接头盔音频。 |
| `intercom.leaveRoom` | 离开房间 | 结束本次通话 |
| `intercom.joinFailed` | 进房失败（{code}），请重试 | 通话连接失败（{code}），请重试 |
| `intercom.joinTimeout` | 进房超时，请重试 | 通话连接超时，请重试 |
| `intercom.micOpen` | 开麦 | 麦克风已开启 |
| `intercom.reconnected` | 已重新连上 | 连接已恢复 |
| `intercom.banner.net` | 连接断了，正在重连。你说的话别人暂时听不到。 | 连接中断，正在重连。暂时无法传送语音。 |
| `intercom.banner.helmet` | 头盔断开了，声音改从手机出。 | 头盔音频连接已断开，已切换至手机播放。 |
| `intercom.banner.helmetMuted` | 头盔断开了，声音改从手机出，麦克风已自动静音。 | 头盔音频连接已断开，已切换至手机播放并自动静音麦克风。 |
| `intercom.lobbyLead` | 你加入的频道都在这里。同一时间只能在一个频道里通话。 | （删除重复说明） |
| `intercom.loadFailedBody` | 请检查网络后重试。你加入的频道还在，没有被删除。 | 请检查网络后重试。 |
| `intercom.switch.lead` | 同一时间只能在一个频道里通话。切换会先离开当前房间。 | 切换频道将结束当前通话，保留频道成员身份。 |
| `intercom.switch.here` | 正在这个频道里 | 当前通话频道 |
| `intercom.add.title` | 新建或加入 | 创建或加入频道 |
| `intercom.add.lead` | 可以加入多个频道，但同一时间只能在一个里面通话。 | （删除重复说明） |
| `intercom.add.a11y` | 新建或加入频道 | 创建或加入频道 |
| `intercom.add.create` | 新建频道 | 创建频道 |
| `intercom.add.createHint` | 起个名字，再把邀请码发给一起骑的人 | 设置频道名称后，可分享邀请码 |
| `intercom.add.join` | 输入邀请码 | 加入频道 |
| `intercom.add.joinHint` | 别人给你的 6 位数字 | 使用收到的 6 位邀请码 |
| `intercom.more.quit` | 退出这个频道 | 退出频道 |
| `intercom.mode.open` | 一直开麦 | 持续通话 |
| `intercom.openMic.lead` | 进房期间麦克风一直开着，锁屏、切到别的页面也不会关。离开房间或切回「按住说话」才会关。风大的时候，别人会听到风声。 | 麦克风开启时会持续传送声音，锁屏或切换页面后仍保持开启。可点击静音、切换为「按住说话」或结束通话。风声等环境声音也会传送给频道成员。 |
| `intercom.openMic.confirm` | 开启一直开麦 | 开启持续通话 |
| `intercom.openMic.later` | 先不用 | 暂不开启 |
| `intercom.micOn` | 麦克风开着 | 麦克风已开启 |
| `intercom.micOn.a11y` | 麦克风开着，点一下静音 | 麦克风已开启，点击静音 |
| `intercom.micOff.a11y` | 已静音，点一下开麦 | 已静音，点击开启麦克风 |
| `intercom.caption.net` | 连上之后会有提示音 | 连接恢复后将播放提示音 |
| `intercom.caption.hold` | 屏幕保持常亮，方便随时按 | 通话期间屏幕保持常亮 |
| `intercom.caption.micOn` | 点一下静音。锁屏后也一直开着 | 点击静音，锁屏后仍会传送声音 |
| `intercom.caption.micOff` | 点一下开麦 | 点击开启麦克风 |
| `intercom.mini.micOn` | 麦克风开着 | 麦克风已开启 |
| `intercom.mini.micOff` | 麦克风关着 | 已静音 |

### map.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `map.updatedAgo` | 位置 {ago} 更新 | 位置更新：{ago} |
| `map.lastPosition` | 最后位置 · {ago} | 上次位置：{ago} |
| `map.waiting` | 等待位置上报 | 等待头盔位置 |
| `map.batteryLast` | 电量（上次） | 上次电量 |
| `map.navigate` | 导航到头盔 | 导航到记录位置 |
| `map.navigateLast` | 导航到最后位置 | 导航到上次位置 |
| `map.shareLast` | 分享最后位置 | 分享上次位置 |
| `map.pill.switch` | 换一台看 | 切换头盔 |
| `map.pill.a11y` | 切换在地图上看的头盔，现在看的是{name} | 切换地图显示的头盔，当前显示 {name} |
| `map.picker.title` | 在地图上看哪台头盔 | 选择查看的头盔 |
| `map.picker.lead` | 只换地图上显示的头盔，不会更换当前头盔，求救关联也不变。 | 此选择仅影响地图显示。当前头盔及手动求救关联的头盔保持不变。 |
| `map.rides.close` | 关闭行程，回到实时位置 | 关闭行程，返回位置查看 |
| `map.rides.moreFailed` | 更早的行程没加载出来，再点一次试试 | 行程加载失败，点击重试 |
| `map.rides.end` | 没有更早的行程了 | 已显示全部行程 |
| `map.rides.emptyTitle` | 还没有行程 | 暂无行程记录 |
| `map.rides.emptyBody` | 戴上头盔骑一段，结束后会出现在这里。 | 保持头盔连接并完成骑行后，可在此查看行程。 |
| `map.rides.errorTitle` | 行程没加载出来 | 行程加载失败 |
| `map.rides.errorBody` | 不是没有行程，是这次没取到。检查一下网络，再试一次。 | 请检查网络后重试。 |
| `map.ride.max` | 最高 | 最高速度 |
| `map.ride.avg` | 平均 | 平均速度 |
| `map.ride.hint` | 播放或拖动，看这一趟的每个时刻 | 播放或拖动进度条，查看行程轨迹 |
| `map.ride.moreEvents` | 还有 {n} 条没标出来 | 另有 {n} 条事件未显示 |
| `map.ride.eventsFailed` | 路上的安全事件没加载出来，点这里重试 | 安全事件加载失败，点击重试 |
| `map.ride.trackLoading` | 正在加载这一趟的轨迹… | 正在加载行程轨迹… |
| `map.ride.trackFailed` | 轨迹没加载出来，上面的小结不受影响 | 轨迹加载失败，仍可查看行程摘要 |
| `map.ride.trackEmpty` | 这一趟没有能画出来的定位点 | 暂无可显示的定位记录 |
| `map.ride.clipped` | 这一趟超过 24 小时，地图上只画最后 24 小时 | 行程超过 24 小时，仅显示最后 24 小时的轨迹 |
| `map.moment.finding` | 正在找这个时刻的行程… | 正在查找对应行程… |
| `map.moment.findFailed` | 没查到这个时刻的行程，检查一下网络再试 | 行程查询失败，请检查网络后重试 |
| `map.emptyTitle` | 把你的头盔连进来 | 尚未绑定头盔 |
| `map.emptyBody` | 绑定后地图将实时跟随头盔位置<br>支持行程回放、位置分享与一键导航 | 绑定并连接头盔后，可查看位置与骑行记录。 |
| `map.bindNew` | 绑定新设备 | 绑定头盔 |
| `map.shareMessage` | 头盔 {name} 的位置：{url} | 头盔 {name} 最近记录的位置：{url} |

### profile.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `profile.clearCacheBody` | 清理本地数据与图片缓存，不影响云端数据。 | 清除页面数据与图片缓存，不影响已保存的数据。 |
| `profile.signOutBody` | 清理登录态并返回登录页。 | 退出后，App 将停止转发头盔事件。请重新登录后再使用头盔。 |

### safety.ts

| 文案键 | 修改前 | 修改后 |
| --- | --- | --- |
| `safety.notifyAlertBody` | 关闭通知后，手机锁屏时将收不到摔倒和求救提醒，也无法在锁屏上一键取消误报。建议在系统设置里打开通知。 | 通知权限已关闭，锁屏时无法显示摔倒和求救提醒，也无法通过通知取消求救。请在系统设置中开启通知。 |
| `safety.helmet.sharedContacts` | 紧急联系人由账号共用，不随头盔切换。 | 本账号绑定的所有头盔使用同一组紧急联系人。 |
| `safety.state.unknown` | 正在确认防护状态 | 正在确认连接与通知状态 |
| `safety.state.unknownBody` | 暂未获取最新的连接与通知状态，请勿将此状态视为已就绪。 | 正在获取头盔连接、通知权限和紧急联系人信息。 |
| `safety.state.loadFailed` | 无法确认防护状态 | 连接与通知状态获取失败 |
| `safety.state.loadFailedBody` | 暂时连不上服务器，头盔状态未能更新。 | 无法连接服务器，请检查网络后重试。 |
| `safety.state.staleBody` | 暂时连不上服务器，下面的状态可能不是最新的。 | 暂时无法连接服务器，以下为上次获取的状态。 |
| `safety.state.linkDownBody` | 手机暂时收不到这顶头盔的安全事件。请靠近头盔，并确认它已开机。 | 手机暂时无法接收该头盔的安全事件。请确认头盔已开机，并保持在手机蓝牙范围内。 |
| `safety.state.bluetoothBody` | 蓝牙可用之前，手机连不上头盔，也收不到头盔的安全事件。 | 请开启手机蓝牙并允许 App 使用蓝牙，以连接头盔并接收安全事件。 |
| `safety.state.mismatchBody` | 连接到的头盔与绑定信息不一致，请到头盔详情里检查绑定。 | 连接到的头盔与绑定信息不一致，请在头盔详情中检查绑定。 |
| `safety.state.noContacts` | SOS 尚未设置接收人 | 尚未添加紧急联系人 |
| `safety.state.noContactsBody` | 添加紧急联系人后，求救通知才有人能收到。 | 请添加紧急联系人，以接收求救短信。 |
| `safety.state.noHelmetBody` | 绑定头盔后，这里会显示它的连接与防护配置。 | 绑定头盔后，可查看连接状态与求救通知配置。 |
| `safety.drillLink` | 先演练一次，看看求救长什么样 › | 体验求救演练 › |
| `safety.contactsNone` | 还未添加 | 未添加 |
| `safety.sosTarget` | 求救关联：{device} | 关联头盔：{device} |
| `safety.sosQueued` | 已保存，网络恢复后会自动发出；也可以再按一次。 | 求救请求已暂存，网络恢复后将自动发送。 |
| `safety.status.notified` | 已通知 | 通知已启动 |
| `records.partialFailed` | 有头盔的记录没有加载出来：{reason} | 部分头盔记录加载失败：{reason} |
| `records.noHelmetBody` | 绑定头盔后，它的风险提醒和 SOS 记录会出现在这里。 | 绑定头盔后，可查看风险提醒与 SOS 记录。 |
| `records.pending` | {device} 有一条进行中的 SOS | {device} 正在求救 |
| `safetySettings.groupContacts` | 接收求救通知 · 账号共用 | 求救通知 |
| `safetySettings.groupDrill` | 熟悉求救流程 | 流程体验 |
| `safetySettings.drillHint` | 不会通知任何人 | 仅模拟流程，不发送通知 |
| `safetySettings.groupHelmets` | 多顶头盔 | 头盔切换 |
| `safetySettings.switchReminder` | 更换头盔提醒 | 切换头盔提醒 |
| `safetySettings.switchReminderHint` | 当前头盔停着、另一顶在动时，问一次要不要更换 | 当前头盔静止、另一顶头盔移动时，提示切换当前头盔。 |
| `switchReminder.title` | 把当前头盔换成「{name}」吗？ | 将「{name}」设为当前头盔？ |
| `switchReminder.body` | 它正在移动，「{current}」停着没动。当前头盔决定设备页显示哪一顶，以及求救记在谁名下。 | 检测到该头盔正在移动，「{current}」处于静止状态。切换后，设备首页和手动求救将关联所选头盔。 |
| `switchReminder.where` | 勾选后不再弹出。<br>想重新开启：{tab} → {settings} → {item} | 可在 {tab} → {settings} → {item} 中重新开启。 |
| `switchReminder.switch` | 换成{name} | 切换至 {name} |
| `switchReminder.switched` | 当前头盔已换成{name} | 当前头盔已切换为 {name} |

## 验证范围

已与修改前快照逐项比对：除两处无调用的对讲重复文案外，字典键与占位符不变。类型检查、文案一致性、时间格式、通知结果、连接状态及导航相关的现有测试见本次执行结果。已结合现有页面截图核对上下文；本轮未完成更新后的真机页面排版复验。

本轮最终检查：6 个相关测试套件、101 项测试通过；文案字典及对讲页 lint 通过；`git diff --check` 通过。最后一次全量类型检查出现 11 个缺失翻译键错误，来自本轮工作期间新增的 `app/src/components/map/ride-calendar.tsx`（17:12:45 创建/更新），涉及月份、日期及筛选文案；这些键在本轮修改前后均不存在，未由本轮文案删除造成。该日历功能不在本轮文案修订范围内。
