// 帮助与反馈页：常见问题（8 条，qN/aN 成对）+ 联系我们
export const help = {
  "zh-CN": {
    "help.title": "帮助与反馈",
    "help.faqGroup": "常见问题",
    "help.contactGroup": "联系我们",
    "help.q1": "如何绑定头盔？",
    "help.a1":
      "打开头盔电源并靠近手机，在「设备」页选择「绑定头盔」，扫描头盔或说明卡上的绑定二维码，也可手动输入设备编号和绑定码。绑定后请完成蓝牙连接设置。每顶头盔同一时间只能绑定一个账号；如已绑定，请先在原账号解除绑定。",
    "help.q2": "为什么头盔显示离线？",
    "help.a2":
      "头盔的数据经蓝牙由手机转发到云端。头盔关机、蓝牙断开、手机断网，或 App 被系统关闭都会显示离线。请确认头盔已开机、手机蓝牙已开启、App 有蓝牙与后台运行权限，然后回到设备页下拉刷新。",
    "help.q3": "SOS 倒计时是怎样工作的？如何取消？",
    "help.a3":
      "头盔上报疑似摔倒或触发手动求救后，系统会开始 60 秒倒计时。期间可在求救页面向右滑动取消，或选择「立即求救」跳过等待。倒计时结束仍未取消，系统会向紧急联系人发送短信通知。",
    "help.q4": "紧急联系人会收到什么？",
    "help.a4":
      "系统会向紧急联系人发送求救短信，并向求救者的 App 发送推送。短信发送结果可在 SOS 记录中查看；已发送不代表对方已收到或已响应。系统不会自动拨打电话或联系急救机构。",
    "help.q5": "为什么摔倒通知需要手机在身边并运行 App？",
    "help.a5":
      "目前头盔本身不联网，事件必须先经蓝牙传到手机，再由 App 发到云端。因此手机需要在蓝牙范围内、App 保持运行（可在后台）且有网络。手机没电、离得太远或 App 被彻底关闭时，通知可能延迟或无法发出。",
    "help.q6": "如何调整蜂鸣音量？",
    "help.a6":
      "进入「设备」页，点击头盔后选择「蜂鸣音量」，拖动滑块并保存。头盔确认执行后，设置才显示为已生效；离线时无法送达。",
    "help.q7": "为什么地图上的位置有延迟？",
    "help.a7":
      "头盔位置通过蓝牙传至手机，再经网络同步，因此可能有延迟；室内、隧道或高楼附近也可能出现定位偏差。地图显示最近记录的位置，更新时间可在页面查看。「导航到记录位置」会打开高德地图，目的地为该记录位置。",
    "help.q8": "如何加入对讲频道？",
    "help.a8":
      "在「对讲」页选择「输入邀请码加入」，输入收到的 6 位邀请码。进入频道后，可使用「按住说话」或「持续通话」。使用头盔收发语音前，请确认头盔音频已连接到手机。对讲需要可用的网络。",
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
      "開啟頭盔電源並靠近手機，在「設備」頁選擇「綁定頭盔」，掃描頭盔或說明卡上的綁定 QR Code，也可手動輸入設備編號和綁定碼。綁定後請完成藍牙連線設定。每頂頭盔同一時間只能綁定一個帳號；如已綁定，請先在原帳號解除綁定。",
    "help.q2": "為什麼頭盔顯示離線？",
    "help.a2":
      "頭盔的資料經藍牙由手機轉送到雲端。頭盔關機、藍牙中斷、手機斷網，或 App 被系統關閉都會顯示離線。請確認頭盔已開機、手機藍牙已開啟、App 擁有藍牙與背景執行權限，然後回到裝置頁下拉重新整理。",
    "help.q3": "SOS 倒數是怎麼運作的？如何取消？",
    "help.a3":
      "頭盔回報疑似跌倒或觸發手動求救後，系統會開始 60 秒倒數。期間可在求救頁面向右滑動取消，或選擇「立即求救」跳過等待。倒數結束仍未取消，系統會向緊急聯絡人傳送簡訊通知。",
    "help.q4": "緊急聯絡人會收到什麼？",
    "help.a4":
      "系統會向緊急聯絡人傳送求救簡訊，並向求救者的 App 傳送推播。簡訊傳送結果可在 SOS 紀錄中查看；已傳送不代表對方已收到或已回應。系統不會自動撥打電話或聯絡急救機構。",
    "help.q5": "為什麼摔倒通知需要手機在身邊並執行 App？",
    "help.a5":
      "目前頭盔本身不連網，事件必須先經藍牙傳到手機，再由 App 送到雲端。因此手機需在藍牙範圍內、App 保持執行（可在背景）且有網路。手機沒電、距離太遠或 App 被完全關閉時，通知可能延遲或無法送出。",
    "help.q6": "如何調整蜂鳴音量？",
    "help.a6":
      "進入「裝置」頁，點選頭盔後選擇「蜂鳴音量」，拖曳滑桿並儲存。頭盔確認執行後，設定才顯示為已生效；離線時無法送達。",
    "help.q7": "為什麼地圖上的位置有延遲？",
    "help.a7":
      "頭盔位置透過藍牙傳至手機，再經網路同步，因此可能有延遲；室內、隧道或高樓附近也可能出現定位偏差。地圖顯示最近記錄的位置，更新時間可在頁面查看。「導航至記錄位置」會開啟高德地圖，目的地為該記錄位置。",
    "help.q8": "如何加入對講頻道？",
    "help.a8":
      "在「對講」頁選擇「輸入邀請碼加入」，輸入收到的 6 位邀請碼。進入頻道後，可使用「按住說話」或「持續通話」。使用頭盔收發語音前，請確認頭盔音訊已連接至手機。對講需要可用的網路。",
    "help.email": "寄送回饋郵件",
    "help.emailSubject": "零一唯創 App 回饋（版本 {v}）",
    "help.site": "官方網站",
    "help.openFailed": "無法開啟，請稍後再試",
  },
  en: {
    "help.title": "Help & Feedback",
    "help.faqGroup": "FAQ",
    "help.contactGroup": "Contact us",
    "help.q1": "How do I add a helmet?",
    "help.a1":
      "Turn on the helmet and keep it near your phone. Select “Add helmet” on the Devices tab, then scan the QR code on the helmet or instruction card, or enter the device ID and binding code manually. Complete Bluetooth connection setup afterwards. Each helmet can be linked to one account at a time. Remove it from the original account before adding it to another.",
    "help.q2": "Why does the helmet show as offline?",
    "help.a2":
      "Helmet data reaches the cloud over Bluetooth through your phone. The helmet shows offline when it is switched off, Bluetooth is disconnected, the phone has no network, or the system has closed the app. Make sure the helmet is on, Bluetooth is enabled, the app has Bluetooth and background permissions, then pull to refresh on the Devices tab.",
    "help.q3": "How does the SOS countdown work, and how do I cancel it?",
    "help.a3":
      "When the helmet reports a possible fall or a manual SOS is triggered, a 60-second countdown starts. Slide right on the SOS page to cancel, or select “Send SOS now” to skip the wait. If the countdown ends without cancellation, the system sends text alerts to your emergency contacts.",
    "help.q4": "What do emergency contacts receive?",
    "help.a4":
      "The system sends SOS text alerts to emergency contacts and push notifications to the person requesting help. Text sending results are available in SOS records. Sent does not confirm receipt or a response. The system does not make phone calls or contact emergency services automatically.",
    "help.q5":
      "Why must my phone be nearby with the app running for fall alerts?",
    "help.a5":
      "The helmet has no network connection of its own. Events travel over Bluetooth to your phone, and the app forwards them to the cloud. Your phone therefore needs to be within Bluetooth range, keep the app running (background is fine) and have a network connection. If the phone is out of battery, too far away, or the app has been fully closed, alerts may be delayed or not sent.",
    "help.q6": "How do I change the buzzer volume?",
    "help.a6":
      "On the Devices tab, select your helmet, then Buzzer volume. Adjust the slider and save. Settings are shown as applied only after the helmet confirms execution. They cannot be delivered while the helmet is offline.",
    "help.q7": "Why does the map position lag?",
    "help.a7":
      "Helmet location is sent to your phone over Bluetooth, then synced over the internet, so it may be delayed. Indoor areas, tunnels and tall buildings can reduce location accuracy. The map shows the latest recorded location and its update time. “Navigate to location” opens Amap with that location as the destination.",
    "help.q8": "How do I join an intercom channel?",
    "help.a8":
      "Select “Join with invite code” on the Intercom tab and enter the 6-digit code you received. Enter the channel to use hold-to-talk or open mic. To send and receive audio through your helmet, make sure helmet audio is connected to your phone. Intercom requires an internet connection.",
    "help.email": "Send feedback by email",
    "help.emailSubject": "Lingyi Weichuang app feedback (version {v})",
    "help.site": "Website",
    "help.openFailed": "Could not open. Please try again later.",
  },
} as const;
