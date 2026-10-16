// 实时视频预览页文案（决策 #37/#49）。三种语言的 key 必须一一对应。
export const video = {
  "zh-CN": {
    "video.joining": "正在连接头盔 Wi-Fi「{ssid}」…",
    "video.joiningHint": "系统弹窗询问时请选择连接",
    "video.connecting": "正在连接画面…",
    "video.stalled":
      "画面还没出来。请确认头盔已开机、手机靠近头盔，并已连上「{ssid}」",
    "video.manual":
      "请到系统设置的 Wi-Fi 列表连接「{ssid}」（密码 {pass}），连好后回到这里点「已连接，继续」",
    "video.manual.openSettings": "去连接 Wi-Fi",
    "video.manual.continue": "已连接，继续",
    "video.retry": "重新连接",
    "video.err.denied": "你取消了连接头盔 Wi-Fi",
    "video.err.notFound": "没有连上头盔 Wi-Fi。请确认头盔已开机并在身边",
    "video.err.bind": "已连上头盔 Wi-Fi，但手机没有把流量切过去，请重试",
    "video.err.noWifi": "还没检测到 Wi-Fi 连接，请先连上「{ssid}」",
    "video.err.stream": "画面连接失败，请确认连的是头盔 Wi-Fi 后重试",
    "video.err.streamEnded": "画面中断了",
    "video.err.wifiLost": "与头盔 Wi-Fi 的连接断开了",
    "video.err.localNetwork":
      "如果之前拒绝过「本地网络」权限，画面会一直连不上：请到系统设置里找到「零一智行」，打开「本地网络」后重试",
    "video.err.openSettings": "去设置开启本地网络",
    "video.paused.sos": "检测到摔倒或求救，已暂停预览，优先上报求救信息",
    "video.snapshot": "截图",
    "video.snapshot.saved": "已保存到相册",
    "video.snapshot.failed": "截图失败，请重试",
    "video.snapshot.unsupported": "当前系统版本不支持保存到相册",
    "video.snapshot.denied": "未允许添加照片，可在系统设置中开启",
    "video.note":
      "连接头盔 Wi-Fi 期间手机暂时无法上网，这是正常的，离开本页后自动恢复。检测到摔倒或求救会立即中断预览、优先上报。",
    "video.note.hotspot": "头盔热点「{ssid}」",
  },
  "zh-TW": {
    "video.joining": "正在連接頭盔 Wi-Fi「{ssid}」…",
    "video.joiningHint": "系統彈窗詢問時請選擇連接",
    "video.connecting": "正在連接畫面…",
    "video.stalled":
      "畫面還沒出來。請確認頭盔已開機、手機靠近頭盔，並已連上「{ssid}」",
    "video.manual":
      "請到系統設定的 Wi-Fi 列表連接「{ssid}」（密碼 {pass}），連好後回到這裡點「已連接，繼續」",
    "video.manual.openSettings": "去連接 Wi-Fi",
    "video.manual.continue": "已連接，繼續",
    "video.retry": "重新連接",
    "video.err.denied": "你取消了連接頭盔 Wi-Fi",
    "video.err.notFound": "沒有連上頭盔 Wi-Fi。請確認頭盔已開機並在身邊",
    "video.err.bind": "已連上頭盔 Wi-Fi，但手機沒有把流量切過去，請重試",
    "video.err.noWifi": "還沒偵測到 Wi-Fi 連接，請先連上「{ssid}」",
    "video.err.stream": "畫面連接失敗，請確認連的是頭盔 Wi-Fi 後重試",
    "video.err.streamEnded": "畫面中斷了",
    "video.err.wifiLost": "與頭盔 Wi-Fi 的連接斷開了",
    "video.err.localNetwork":
      "如果之前拒絕過「區域網路」權限，畫面會一直連不上：請到系統設定裡找到「零一智行」，開啟「區域網路」後重試",
    "video.err.openSettings": "前往設定開啟區域網路",
    "video.paused.sos": "偵測到摔倒或求救，已暫停預覽，優先上報求救資訊",
    "video.snapshot": "截圖",
    "video.snapshot.saved": "已儲存到相簿",
    "video.snapshot.failed": "截圖失敗，請重試",
    "video.snapshot.unsupported": "目前系統版本不支援儲存到相簿",
    "video.snapshot.denied": "未允許加入照片，可在系統設定中開啟",
    "video.note":
      "連接頭盔 Wi-Fi 期間手機暫時無法上網，這是正常的，離開本頁後自動恢復。偵測到摔倒或求救會立即中斷預覽、優先上報。",
    "video.note.hotspot": "頭盔熱點「{ssid}」",
  },
  en: {
    "video.joining": 'Connecting to helmet Wi-Fi "{ssid}"…',
    "video.joiningHint": "Choose Connect when the system asks",
    "video.connecting": "Connecting to the camera…",
    "video.stalled":
      'No picture yet. Make sure the helmet is on, your phone is close to it, and you\'re connected to "{ssid}"',
    "video.manual":
      'Open the system Wi-Fi list and join "{ssid}" (password {pass}), then come back and tap "I\'m connected"',
    "video.manual.openSettings": "Open Wi-Fi settings",
    "video.manual.continue": "I'm connected",
    "video.retry": "Reconnect",
    "video.err.denied": "You cancelled joining the helmet Wi-Fi",
    "video.err.notFound":
      "Couldn't join the helmet Wi-Fi. Make sure the helmet is on and nearby",
    "video.err.bind":
      "Joined the helmet Wi-Fi, but traffic didn't switch over. Please retry",
    "video.err.noWifi": 'No Wi-Fi connection yet. Join "{ssid}" first',
    "video.err.stream":
      "Couldn't connect to the camera. Check you're on the helmet Wi-Fi and retry",
    "video.err.streamEnded": "The video stopped",
    "video.err.wifiLost": "Lost connection to the helmet Wi-Fi",
    "video.err.localNetwork":
      "If you denied Local Network access before, the video can't connect. Turn on Local Network for this app in Settings, then retry",
    "video.err.openSettings": "Open Settings",
    "video.paused.sos":
      "A fall or SOS was detected. Preview paused so the alert can be sent first",
    "video.snapshot": "Snapshot",
    "video.snapshot.saved": "Saved to Photos",
    "video.snapshot.failed": "Snapshot failed, please retry",
    "video.snapshot.unsupported":
      "Saving to Photos isn't supported on this system version",
    "video.snapshot.denied":
      "Photo access not allowed. You can enable it in Settings",
    "video.note":
      "Your phone can't reach the internet while on the helmet Wi-Fi. That's expected and it recovers when you leave this page. A fall or SOS stops the preview immediately so the alert goes out first.",
    "video.note.hotspot": 'Helmet hotspot "{ssid}"',
  },
};
