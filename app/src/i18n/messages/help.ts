// 帮助与反馈页：常见问题（8 条，qN/aN 成对）+ 联系我们
export const help = {
  "zh-CN": {
    "help.title": "帮助与反馈",
    "help.faqGroup": "常见问题",
    "help.contactGroup": "联系我们",
    "help.q1": "如何绑定头盔？",
    "help.a1":
      "打开头盔电源并靠近手机，进入「设备」页点「绑定新设备」，按提示输入或扫描头盔上的设备 ID 完成蓝牙配对。一台头盔同一时间只能绑定一个账号，如提示已被绑定，请先在原账号解绑。",
    "help.q2": "为什么头盔显示离线？",
    "help.a2":
      "头盔的数据经蓝牙由手机转发到云端。头盔关机、蓝牙断开、手机断网，或 App 被系统关闭都会显示离线。请确认头盔已开机、手机蓝牙已开启、App 有蓝牙与后台运行权限，然后回到设备页下拉刷新。",
    "help.q3": "SOS 倒计时是怎样工作的？如何取消？",
    "help.a3":
      "头盔检测到疑似摔倒，或您按住求救按钮后，会开始 60 秒倒计时，由服务器计时。期间可以点「我没事」取消，或点「立即求救」跳过等待。倒计时结束仍未取消，系统会自动通知您的紧急联系人。",
    "help.q4": "紧急联系人会收到什么？",
    "help.a4":
      "倒计时结束后，每位紧急联系人会收到一条短信，包含您的昵称、事件类型、发生时间与事故位置链接；已安装 App 的联系人还会收到推送。系统不会替您拨打电话，也不会联系急救机构。",
    "help.q5": "为什么摔倒通知需要手机在身边并运行 App？",
    "help.a5":
      "目前头盔本身不联网，事件必须先经蓝牙传到手机，再由 App 发到云端。因此手机需要在蓝牙范围内、App 保持运行（可在后台）且有网络。手机没电、离得太远或 App 被彻底关闭时，通知可能延迟或无法发出。",
    "help.q6": "如何调整蜂鸣音量？",
    "help.a6":
      "进入「设备」页 → 点击头盔 → 「蜂鸣音量」，拖动滑块后保存。设置会下发到头盔，只有头盔回复执行成功后才显示为已生效；头盔离线时会显示等待送达。",
    "help.q7": "为什么地图上的位置有延迟？",
    "help.a7":
      "位置由头盔定位后经蓝牙和手机转发，再经网络上传，通常有几秒到十几秒的延迟；室内、隧道或高楼之间定位本身也会漂移。地图仅用于查看，不用于导航。",
    "help.q8": "如何加入对讲频道？",
    "help.a8":
      "进入「对讲」页，点「输入邀请码加入」，输入频道创建者分享给您的 6 位邀请码。加入后按住说话键即可通话；头盔连上手机后语音直接从头盔收发。对讲需要手机有可用网络。",
    "help.email": "发送反馈邮件",
    "help.emailSubject": "零一唯创 App 反馈（版本 {v}）",
    "help.site": "官网",
    "help.openFailed": "无法打开，请稍后重试",
  },
  "zh-TW": {
    "help.title": "說明與回饋",
    "help.faqGroup": "常見問題",
    "help.contactGroup": "聯絡我們",
    "help.q1": "如何綁定頭盔？",
    "help.a1":
      "開啟頭盔電源並靠近手機，進入「裝置」頁點「綁定新裝置」，依提示輸入或掃描頭盔上的裝置 ID 完成藍牙配對。一台頭盔同一時間只能綁定一個帳號，若提示已被綁定，請先在原帳號解除綁定。",
    "help.q2": "為什麼頭盔顯示離線？",
    "help.a2":
      "頭盔的資料經藍牙由手機轉送到雲端。頭盔關機、藍牙中斷、手機斷網，或 App 被系統關閉都會顯示離線。請確認頭盔已開機、手機藍牙已開啟、App 擁有藍牙與背景執行權限，然後回到裝置頁下拉重新整理。",
    "help.q3": "SOS 倒數是怎麼運作的？如何取消？",
    "help.a3":
      "頭盔偵測到疑似摔倒，或您長按求救按鈕後，會開始 60 秒倒數，由伺服器計時。期間可以點「我沒事」取消，或點「立即求救」跳過等待。倒數結束仍未取消，系統會自動通知您的緊急聯絡人。",
    "help.q4": "緊急聯絡人會收到什麼？",
    "help.a4":
      "倒數結束後，每位緊急聯絡人會收到一則簡訊，包含您的暱稱、事件類型、發生時間與事故位置連結；已安裝 App 的聯絡人還會收到推播。系統不會替您撥打電話，也不會聯絡急救單位。",
    "help.q5": "為什麼摔倒通知需要手機在身邊並執行 App？",
    "help.a5":
      "目前頭盔本身不連網，事件必須先經藍牙傳到手機，再由 App 送到雲端。因此手機需在藍牙範圍內、App 保持執行（可在背景）且有網路。手機沒電、距離太遠或 App 被完全關閉時，通知可能延遲或無法送出。",
    "help.q6": "如何調整蜂鳴音量？",
    "help.a6":
      "進入「裝置」頁 → 點選頭盔 → 「蜂鳴音量」，拖動滑桿後儲存。設定會下發到頭盔，只有頭盔回覆執行成功後才顯示為已生效；頭盔離線時會顯示等待送達。",
    "help.q7": "為什麼地圖上的位置有延遲？",
    "help.a7":
      "位置由頭盔定位後經藍牙和手機轉送，再經網路上傳，通常有幾秒到十幾秒的延遲；室內、隧道或高樓之間定位本身也會飄移。地圖僅供查看，不用於導航。",
    "help.q8": "如何加入對講頻道？",
    "help.a8":
      "進入「對講」頁，點「輸入邀請碼加入」，輸入頻道建立者分享給您的 6 位邀請碼。加入後長按說話鍵即可通話；頭盔連上手機後語音直接從頭盔收發。對講需要手機有可用的網路。",
    "help.email": "寄送回饋郵件",
    "help.emailSubject": "零一唯創 App 回饋（版本 {v}）",
    "help.site": "官方網站",
    "help.openFailed": "無法開啟，請稍後再試",
  },
  en: {
    "help.title": "Help & Feedback",
    "help.faqGroup": "FAQ",
    "help.contactGroup": "Contact us",
    "help.q1": "How do I pair the helmet?",
    "help.a1":
      'Turn the helmet on and keep it near your phone. Open the Devices tab, tap "Pair a new helmet", then enter or scan the device ID printed on the helmet to complete Bluetooth pairing. A helmet can be paired with only one account at a time; if it says the helmet is already paired, unpair it from the other account first.',
    "help.q2": "Why does the helmet show as offline?",
    "help.a2":
      "Helmet data reaches the cloud over Bluetooth through your phone. The helmet shows offline when it is switched off, Bluetooth is disconnected, the phone has no network, or the system has closed the app. Make sure the helmet is on, Bluetooth is enabled, the app has Bluetooth and background permissions, then pull to refresh on the Devices tab.",
    "help.q3": "How does the SOS countdown work, and how do I cancel it?",
    "help.a3":
      'When the helmet detects a possible fall, or you hold the SOS button, a 60-second countdown starts, timed by the server. During the countdown you can tap "I\'m OK" to cancel, or "SOS now" to skip the wait. If it is not cancelled before it ends, your emergency contacts are notified automatically.',
    "help.q4": "What do emergency contacts receive?",
    "help.a4":
      "When the countdown ends, each emergency contact gets an SMS with your nickname, the event type, the time and a link to the incident location. Contacts who have the app installed also get a push notification. The system does not place phone calls or contact emergency services on your behalf.",
    "help.q5":
      "Why must my phone be nearby with the app running for fall alerts?",
    "help.a5":
      "The helmet has no network connection of its own. Events travel over Bluetooth to your phone, and the app forwards them to the cloud. Your phone therefore needs to be within Bluetooth range, keep the app running (background is fine) and have a network connection. If the phone is out of battery, too far away, or the app has been fully closed, alerts may be delayed or not sent.",
    "help.q6": "How do I change the buzzer volume?",
    "help.a6":
      'Open the Devices tab, tap your helmet, then "Buzzer volume". Drag the slider and save. The setting is sent to the helmet and only shows as applied after the helmet confirms it; while the helmet is offline it shows as waiting for delivery.',
    "help.q7": "Why does the map position lag?",
    "help.a7":
      "The position is fixed by the helmet, relayed over Bluetooth through your phone and uploaded over the network, so a delay of a few seconds to over ten seconds is normal. Indoors, in tunnels or between tall buildings the fix itself can drift. The map is for viewing only and is not meant for navigation.",
    "help.q8": "How do I join an intercom channel?",
    "help.a8":
      'Open the Talk tab, tap "Join with invite code" and enter the 6-digit code shared by the channel creator. Once you are in, hold the talk button to speak; when the helmet is connected to your phone, audio goes through the helmet directly. Intercom needs a working network connection on your phone.',
    "help.email": "Send feedback by email",
    "help.emailSubject": "Lingyi Weichuang app feedback (version {v})",
    "help.site": "Website",
    "help.openFailed": "Could not open. Please try again later.",
  },
} as const;
