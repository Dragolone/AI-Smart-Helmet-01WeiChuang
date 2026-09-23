// 隐私政策 / 用户服务协议：正文不再内置。
// 2026-09-23 起由后端托管（V1.0，深圳零一唯创科技有限公司），页面用 WebView 打开，
// 这里只留标题与加载失败的兜底文案。原先内置的 09-11 草案（privacy 9 节 / terms 10 节）
// 已与托管版不一致，同一个包里出现两份口径不同的隐私政策会卡上架审核，故整体删除。
// 地址见 constants/legal.ts。
export const legal = {
  "zh-CN": {
    "legal.privacy.title": "隐私政策",
    "legal.terms.title": "用户服务协议",
    "legal.loadError": "文档打不开，请检查网络后重试。",
    "legal.retry": "重试",
    "legal.openInBrowser": "用浏览器打开",
  },
  "zh-TW": {
    "legal.privacy.title": "隱私政策",
    "legal.terms.title": "使用者服務協議",
    "legal.loadError": "文件開不了，請檢查網路後重試。",
    "legal.retry": "重試",
    "legal.openInBrowser": "用瀏覽器開啟",
  },
  en: {
    "legal.privacy.title": "Privacy Policy",
    "legal.terms.title": "Terms of Service",
    "legal.loadError": "Couldn't load the document. Check your connection and try again.",
    "legal.retry": "Retry",
    "legal.openInBrowser": "Open in browser",
  },
} as const;
