// App 内部 Map 组件层（决策 #11/#33）：WebView + 高德 JS API 2.0 的唯一封装点。
// 业务页只使用本组件的命令式接口（setHelmet/setTrack/…），不触碰 WebView/JS API 细节——换库只改这里。
// 底图样式跟随 App 外观（2026-09-10）：深色=高德 dark 样式 + 压暗滤镜；浅色=高德 normal 样式、不加滤镜。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { Colors } from "@/constants/theme";
import { useT } from "@/i18n";
import type { LngLat } from "./coords";

const JS_KEY = process.env.EXPO_PUBLIC_AMAP_JS_KEY ?? "";
const SECURITY_CODE = process.env.EXPO_PUBLIC_AMAP_JS_SECURITY_CODE ?? "";
/** 荧光柠檬品牌色：轨迹辉光与头盔 Marker 用 */
const ACCENT = Colors.dark.brand;
const ACCENT_LIGHT = Colors.light.brand;

/** 轨迹上的标记：一趟的起点、终点，和途中的安全事件 */
export interface MapMark extends LngLat {
  kind: "start" | "end" | "event";
  /** 事件标记里写什么：并了几个事件时写条数；不给就是一个感叹号 */
  label?: string;
  /** 事件标记用红色（碰撞 / 摔倒 / 求救） */
  danger?: boolean;
}

export interface TrackOptions {
  /** 把视野收进轨迹范围；默认 true。实时模式下定时刷新当前这一趟的线时传 false，不跟「跟随」抢镜头 */
  fit?: boolean;
  /** 收视野时四边各让出多少（上、下、左、右，dp）：底部抽屉和顶部药丸盖住的地方不算可见 */
  pad?: [number, number, number, number];
}

export interface AmapViewHandle {
  /** 移动头盔 Marker（实时位置或回放位置共用）；follow 时镜头平滑跟随 */
  setHelmet(pos: LngLat, opts?: { follow?: boolean }): void;
  /** 收起头盔 Marker：没有位置可画时（实时没定位、一趟的轨迹还没到），不能让它停在上一处 */
  hideHelmet(): void;
  /** 画整条轨迹（荧光双层线），默认把视野收进轨迹范围 */
  setTrack(path: LngLat[], opts?: TrackOptions): void;
  /**
   * 实时模式下把线头接到头盔此刻的位置：只传这一个点，接在 setTrack 那条线的末尾画；null = 不接。
   * 整条线只在服务端轨迹刷新（约 30 s）时重发——原来每来一个定位（约 5 s）就把最多 1000 个点整条注入一次，
   * 长时间停在地图页时 App 进程内存每分钟涨约 1.2 MB（10-20 长骑行 + 模拟器对照实验）
   */
  setTrackTip(tip: LngLat | null): void;
  clearTrack(): void;
  setCenter(pos: LngLat, zoom?: number): void;
  /** 离线：Marker 变灰、停波纹；上线恢复 */
  setHelmetOnline(online: boolean): void;
  /** 回放中：Marker 不放波纹（波纹只表示「这是实时位置」） */
  setHelmetReplay(replay: boolean): void;
  /** 换掉轨迹上的全部标记；传空数组 = 清空 */
  setMarks(marks: MapMark[]): void;
  /** 整页重新加载（高德脚本没拉到、初始化失败后重来）；之后的命令排队等新的 ready，ready 后再回调一次 onReady */
  reload(): void;
}

interface Props {
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onError?: (message: string) => void;
  /** 用户手势拖动地图(程序移动镜头不触发)——调用方用于退出跟随模式 */
  onUserPan?: () => void;
  /** 用户手势缩放 / 旋转地图（双指、双击）。和拖动分开报：看实时位置时缩放不该退出跟随 */
  onUserZoom?: () => void;
  /** 命令句柄注入位：父组件传 useRef(null)，本组件挂载后填充。
   *  不用 useImperativeHandle——实测其在本项目 React Compiler 下 ref 永不挂载（2026-08-16）。 */
  controllerRef: RefObject<AmapViewHandle | null>;
  /** 浅色外观：切换时父组件用 key 重挂载本组件（底图样式在初始化时决定） */
  light?: boolean;
  /** 用户头像（http 或 data URI）：有则 Marker 徽章显示头像，无则显示头盔图标 */
  avatarUrl?: string | null;
}

type Cmd =
  | { type: "helmet"; lng: number; lat: number; follow: boolean }
  | { type: "hideHelmet" }
  | {
      type: "track";
      path: [number, number][];
      fit: boolean;
      pad: [number, number, number, number];
    }
  | { type: "clearTrack" }
  | { type: "trackTip"; tip: [number, number] | null }
  | { type: "center"; lng: number; lat: number; zoom?: number }
  | { type: "helmetState"; online: boolean }
  | { type: "helmetReplay"; replay: boolean }
  | {
      type: "marks";
      items: {
        lng: number;
        lat: number;
        kind: string;
        label: string;
        danger: boolean;
      }[];
    }
  | { type: "avatar"; url: string | null };

/**
 * 就绪前排队的命令按「管的是哪样东西」归槽：同一槽只留最后一条（前面的已经过时），
 * 队列长度有上限，不会在地图迟迟起不来时越攒越多。头盔的显示 / 收起共用一槽，轨迹的画 / 清共用一槽
 */
const SLOT: Record<Cmd["type"], string> = {
  helmet: "helmet",
  hideHelmet: "helmet",
  track: "track",
  clearTrack: "track",
  trackTip: "trackTip",
  center: "center",
  helmetState: "helmetState",
  helmetReplay: "helmetReplay",
  marks: "marks",
  avatar: "avatar",
};

// 默认视野：深圳（设备无数据时的兜底画面）
const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body, #map { height: 100%; margin: 0; background: #0B0C0E; }
  /* 底图压暗去蓝调（对齐 design/map.png 近黑风格）：只压底图那一张画布（.amap-layers 的直接子画布）。
     DOM Marker 不受影响；轨迹画在另一张画布上（见下面的 trackLayer），也不受影响。
     仅 Android 应用——iOS WKWebView 对 canvas CSS 滤镜的合成有缺陷，会把整块画布渲染成黑屏
     （2026-08-16 模拟器实证）。 */
  body.with-canvas-filter #map .amap-layers > canvas { filter: saturate(0.35) brightness(0.85) contrast(1.08); }
  /* iOS：WebKit 下 JS API 不走矢量渲染、amap 暗色样式失效（webgl=true 仍如此，2026-08-16 实证），
     底图只能自己压暗。做法（2026-10-08 起）：在底图画布上面盖一层只带 backdrop-filter 的透明层 #dim，
     它只改「压在它下面的东西」——底图；排在它上面的轨迹画布和 Marker 原样显示，品牌色是多少就是多少。
     此前是给整个 #map 容器挂滤镜：轨迹和 Marker 一起被反色，只能用「预反色」的颜色去凑，
     而反色 + 转色相保不住亮度，亮黄怎么凑都只能得到橄榄绿（负责人 2026-10-08 iPhone：
     头像旁的颜色和轨迹不是品牌黄）。 */
  #dim { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 1; pointer-events: none;
    -webkit-backdrop-filter: invert(0.88) hue-rotate(180deg) saturate(0.5) brightness(1.05);
    backdrop-filter: invert(0.88) hue-rotate(180deg) saturate(0.5) brightness(1.05); }
  /* 退路：系统不认 backdrop-filter 时仍给整个容器挂滤镜（Marker / 轨迹用预反色的颜色，颜色会偏暗）。
     这时 Marker 不做反向滤镜（WebKit 嵌套滤镜+动画子层合成不可靠，实测失效） */
  body.ios-dark-legacy #map { filter: invert(0.88) hue-rotate(180deg) saturate(0.5) brightness(1.05); }
  .hm { position: relative; width: 64px; height: 72px; }
  .hm .ring { position: absolute; left: 4px; top: 4px; width: 56px; height: 56px;
    border-radius: 50%; border: 1.5px solid var(--neon, ${ACCENT}); opacity: 0;
    animation: pulse 2.4s ease-out infinite; }
  .hm .ring.r2 { animation-delay: 0.8s; }
  .hm .ring.r3 { animation-delay: 1.6s; }
  @keyframes pulse {
    0% { transform: scale(0.55); opacity: 0.85; }
    100% { transform: scale(1.3); opacity: 0; }
  }
  .hm .badge { position: absolute; left: 50%; top: 32px; width: 42px; height: 42px;
    transform: translate(-50%, -50%); border-radius: 50%;
    background: var(--badge, #17181B); border: 2.5px solid var(--neon, ${ACCENT});
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 18px var(--neon, ${ACCENT}); }
  /* 离线：变灰、停波纹。这三条原先被插在上面 .badge 那条规则的花括号里面，从来没有生效过（2026-10-07 挪出来） */
  .hm.off .badge { filter: grayscale(1); opacity: .55; }
  .hm.off .ring { display: none; }
  .hm.off .tip { opacity: .4; }
  .hm.replay .ring { display: none; }
  .hm .badge img.av { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
  /* iOS 暗色的退路（整个容器挂滤镜）：容器整体 invert 会把照片反色，头像自身再反一次抵消（静态滤镜，不含动画子层） */
  .hm .badge img.av.inv { filter: invert(1) hue-rotate(180deg); }
  /* 锚点荧光小圆点（map.png 的 Marker 底部落点） */
  .hm .tip { position: absolute; left: 50%; top: 60px; width: 10px; height: 10px;
    transform: translate(-50%, -50%); border-radius: 50%;
    background: var(--neon, ${ACCENT}); box-shadow: 0 0 10px var(--neon, ${ACCENT}); }
  /* 轨迹上的标记：起点空心、终点实心、途中的安全事件是提醒色圆点 */
  .mk { box-sizing: border-box; border-radius: 50%; }
  .mk.start { width: 14px; height: 14px; background: var(--el); border: 3px solid var(--neon, ${ACCENT}); }
  .mk.end { width: 14px; height: 14px; background: var(--neon, ${ACCENT}); border: 3px solid var(--el); }
  .mk.event { width: 26px; height: 26px; background: var(--warn); border: 3px solid var(--el);
    color: var(--el); font: 800 13px/20px -apple-system, "PingFang SC", sans-serif; text-align: center; }
  .mk.event.danger { background: var(--danger); }
</style>
<script>
  window._AMapSecurityConfig = { securityJsCode: '${SECURITY_CODE}' };
  function post(obj) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(obj));
  }
  window.onerror = function (msg) { post({ type: 'error', message: String(msg) }); };
  // 页内可见/上抛的错误文案由 RN 侧按当前语言注入（window.__I18N），页面自身不含任何语言文案
  function i18n(key, msg) {
    var raw = (window.__I18N || {})[key] || key;
    return msg === undefined ? raw : raw.replace('{msg}', msg);
  }
</script>
<script
  src="https://webapi.amap.com/maps?v=2.0&key=${JS_KEY}"
  onerror="post({ type: 'error', message: i18n('scriptLoad') })"></script>
</head>
<body>
<div id="map"></div>
<script>
try {
  if (typeof AMap === 'undefined') throw new Error(i18n('noAmap'));
  var LIGHT = !!window.__LIGHT;
  var IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  var BACKDROP_OK = !!(window.CSS && CSS.supports &&
    (CSS.supports('backdrop-filter', 'invert(1)') || CSS.supports('-webkit-backdrop-filter', 'invert(1)')));
  // iOS 深色：暗色样式在 WebKit 上不生效，底图一律按普通样式要、再自己压暗（见上面 #dim 的说明）。
  // 明确要普通样式而不是「要了暗色、指望它不生效」：哪天暗色样式在 iOS 上生效了，再反一次色就成了浅灰底图
  var IOS_DARK = !LIGHT && IOS;
  var IOS_DARK_LEGACY = IOS_DARK && !BACKDROP_OK;
  var MAP_STYLE = LIGHT || IOS_DARK ? 'amap://styles/normal' : 'amap://styles/dark';
  document.documentElement.style.background = LIGHT ? '#F4F5F7' : '#0B0C0E';
  document.body.style.background = LIGHT ? '#F4F5F7' : '#0B0C0E';
  if (!LIGHT) {
    document.body.classList.add(IOS_DARK_LEGACY ? 'ios-dark-legacy' : IOS_DARK ? 'ios-dark' : 'with-canvas-filter');
  }
  // 调色板：品牌色 / 深徽章 / 标记底色 / 提醒色，和 App 主题一致。
  // 只有退路（整个容器挂滤镜）才用预反色的那一套：经容器 invert+hue-rotate 后近似回到目标色
  var NEON = IOS_DARK_LEGACY ? '#A5B50D' : (LIGHT ? '${ACCENT_LIGHT}' : '${ACCENT}');
  document.body.style.setProperty('--neon', NEON);
  document.body.style.setProperty('--badge', IOS_DARK_LEGACY ? '#F2F3F6' : '#17181B');
  //（退路下提醒色反不回原样——容器滤镜带 saturate(0.5)，取能得到的最接近的暖色）
  document.body.style.setProperty('--el', LIGHT ? '${Colors.light.backgroundElement}' : (IOS_DARK_LEGACY ? '#F2F3F6' : '${Colors.dark.backgroundElement}'));
  document.body.style.setProperty('--warn', LIGHT ? '${Colors.light.warning}' : (IOS_DARK_LEGACY ? '#C62E00' : '${Colors.dark.warning}'));
  document.body.style.setProperty('--danger', LIGHT ? '${Colors.light.danger}' : '${Colors.dark.danger}');
  var ICON_FILL = IOS_DARK_LEGACY ? '#0B0C0E' : '#F4F5F7';
  var map = new AMap.Map('map', {
    mapStyle: MAP_STYLE,
    // 纯监控底图（对齐 design/map.png）：不渲染 POI 点标注层
    features: ['bg', 'road', 'building'],
    center: [114.0579, 22.5431],
    zoom: 13,
  });
  // Marker 按 map.png：暗色圆徽章（白色头盔图标）+ 荧光描边 + 波纹 + 底部荧光落点
  var helmetOnline = true;
  var helmetReplay = false;
  var avatarUrl = null;
  var marks = [];
  var HELMET_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="' + ICON_FILL + '">' +
    '<path d="M12 4a8 8 0 0 0-8 8v3.5A1.5 1.5 0 0 0 5.5 17H7l1.2 2.2c.3.5.8.8 1.4.8h4.8c.6 0 1.1-.3 1.4-.8L17 17h1.5a1.5 1.5 0 0 0 1.5-1.5V12a8 8 0 0 0-8-8Zm-6 8a6 6 0 0 1 12 0v1H6Z"/></svg>';
  // 徽章内容：有头像用头像（圆形裁切），否则头盔图标；src 经 encodeURI 防止引号截断标签
  function helmetHtml() {
    var inner = avatarUrl
      ? '<img class="av' + (IOS_DARK_LEGACY ? ' inv' : '') + '" src="' + String(avatarUrl).replace(/"/g, '&quot;') + '" alt="">'
      : HELMET_SVG;
    return '<div class="hm' + (helmetOnline ? '' : ' off') + (helmetReplay ? ' replay' : '') + '"><div class="ring"></div><div class="ring r2"></div><div class="ring r3"></div>' +
      '<div class="tip"></div><div class="badge">' + inner + '</div></div>';
  }
  var helmet = new AMap.Marker({
    content: helmetHtml(),
    // 锚点对准 .tip 荧光点（宽 64 的中线，纵向 60px 处）
    anchor: 'top-left',
    offset: new AMap.Pixel(-32, -60),
    zIndex: 120,
  });
  var helmetShown = false;
  var followed = false;
  // iOS 深色：把压暗底图的那一层放到底图画布上面（z-index 1：在轨迹画布 100、Marker 120 之下）。
  // 地图换样式时这一层可能被重建掉，所以每次 complete / 定时补设样式时都确认一遍它还在
  function ensureDim() {
    if (!IOS_DARK || IOS_DARK_LEGACY) return;
    var layers = document.querySelector('#map .amap-layers');
    if (!layers) return;
    var dim = document.getElementById('dim');
    if (dim && dim.parentNode === layers) return;
    if (!dim) { dim = document.createElement('div'); dim.id = 'dim'; }
    layers.appendChild(dim);
  }
  // 辉光轨迹（三层）：最宽淡光晕 + 中层柔光 + 细主线，画在单独的一张画布上（高德的自定义图层）。
  // 不用 AMap.Polyline：它和底图画在同一张画布里，底图一压暗 / 反色，线的颜色跟着变——
  // Android 深色下被去掉六成多饱和度，iOS 深色下成了橄榄绿，都不是品牌色（2026-10-08）。
  // 自定义图层的画布是 .amap-layers 里单独的一层（在底图画布之上、Marker 之下），
  // 高德每一帧视野变化都会回调 render，线和底图是一起动的。
  var LINE = IOS_DARK_LEGACY ? '#A5B50D' : NEON;
  var LINE_MAIN = IOS_DARK_LEGACY ? '#ABAB00' : NEON;
  var trackCanvas = document.createElement('canvas');
  trackCanvas.style.pointerEvents = 'none';
  var trackLayer = null;
  var trackPath = null;
  var trackTip = null;
  var trackShown = false;
  function drawTrack() {
    var size = map.getSize();
    var w = size.width, h = size.height;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (trackCanvas.width !== pw || trackCanvas.height !== ph) {
      trackCanvas.width = pw; trackCanvas.height = ph;
      trackCanvas.style.width = w + 'px'; trackCanvas.style.height = h + 'px';
    }
    var ctx = trackCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!trackShown || !trackPath) return;
    var base = trackPath.length, n = base + (trackTip ? 1 : 0);
    if (n < 2) return;
    var xs = new Array(n), ys = new Array(n);
    for (var i = 0; i < n; i++) {
      var q = map.lngLatToContainer(i < base ? trackPath[i] : trackTip);
      xs[i] = q.x; ys[i] = q.y;
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // 浅色底图上先垫一道深色细边：亮黄压在白色 / 浅绿的地块上，光靠颜色分不出来
    var passes = LIGHT
      ? [[12, 0.12, LINE], [6.5, 0.3, '#151804'], [4, 1, LINE_MAIN]]
      : [[12, 0.1, LINE], [7, 0.24, LINE], [4, 1, LINE_MAIN]];
    for (var k = 0; k < passes.length; k++) {
      ctx.lineWidth = passes[k][0]; ctx.globalAlpha = passes[k][1]; ctx.strokeStyle = passes[k][2];
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (var j = 1; j < n; j++) ctx.lineTo(xs[j], ys[j]);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // 留一条看不见的 AMap.Polyline 只给 setFitView 用（按轨迹定视野），显示全靠上面那张画布。
  // 懒创建：JS API 2.0 对空 path 构造会报 "error Polyline path"，首次收到轨迹再建。
  var fitLine = null;
  function ensureTrackLayer() {
    if (trackLayer) return;
    fitLine = new AMap.Polyline({ map: map, strokeOpacity: 0, strokeWeight: 1, zIndex: 1 });
    trackLayer = new AMap.CustomLayer(trackCanvas, { zooms: [2, 22], alwaysRender: true, zIndex: 100 });
    trackLayer.render = drawTrack;
    map.add(trackLayer);
  }
  // ready 重发兜底：complete 可能早于 RN 消息通道就绪，首发丢失会让所有命令永远排队。
  // 重发数次由 RN 侧幂等消化。
  var readyTries = 0;
  var readyTimer = setInterval(function () {
    post({ type: 'ready' });
    if (++readyTries >= 6) clearInterval(readyTimer);
  }, 700);
  // iOS WKWebView 偶发初始化期样式配置未生效：complete 后与延时各补设一次。
  // 只补 iOS：Android 初始化时就生效，而同样式再设一次不是空操作——高德重拉样式和瓦片、整图重画
  //（10-31 高德官方 demo + 桌面 Chromium：两次补设让瓦片 16→32 张、最后一次绘制约 1.5 s→3.3 s）
  map.on('complete', function () {
    if (IOS) map.setMapStyle(MAP_STYLE);
    ensureDim();
    post({ type: 'ready' });
  });
  // 用户手势拖图(程序 panTo/setCenter 不触发 dragstart)→ 上报供"退出跟随"用
  map.on('dragstart', function () { post({ type: 'userpan' }); });
  // 缩放 / 旋转不一样：程序收视野（setFitView）也会发 zoomstart。只认手指刚碰过地图之后的那些
  //（双指捏合在触摸中；双击放大在第二下抬起之后），算用户自己动的
  var lastTouchAt = 0;
  function touched() { lastTouchAt = Date.now(); }
  var mapEl = document.getElementById('map');
  mapEl.addEventListener('touchstart', touched, { capture: true, passive: true });
  mapEl.addEventListener('touchmove', touched, { capture: true, passive: true });
  mapEl.addEventListener('touchend', touched, { capture: true, passive: true });
  function userZoom() { if (Date.now() - lastTouchAt < 600) post({ type: 'userzoom' }); }
  map.on('zoomstart', userZoom);
  map.on('rotatestart', userZoom);
  setTimeout(function () { if (IOS) map.setMapStyle(MAP_STYLE); ensureDim(); }, 2500);
  ensureDim();

  window.__cmd = function (cmd) {
    try {
      if (cmd.type === 'helmet') {
        var p = new AMap.LngLat(cmd.lng, cmd.lat);
        helmet.setPosition(p);
        if (!helmetShown) { helmet.setMap(map); helmetShown = true; }
        if (cmd.follow) {
          // 页面加载后第一次跟随直接到位：默认中心写死深圳，头盔在外地时 panTo 会从深圳横扫过去
          //（10-31 实测定位在北京：看到位置 1.3 s→0.87 s）。WebView 重建后页面重载，这个标记自然复位
          if (followed) map.panTo(p);
          else { followed = true; map.setCenter(p, true); }
        }
      } else if (cmd.type === 'hideHelmet') {
        helmet.setMap(null); helmetShown = false;
      } else if (cmd.type === 'track') {
        if (!cmd.path.length) return;
        ensureTrackLayer();
        ensureDim();
        trackPath = cmd.path; trackShown = true;
        fitLine.setPath(cmd.path);
        drawTrack();
        if (cmd.fit && cmd.path.length > 1) map.setFitView([fitLine], true, cmd.pad);
      } else if (cmd.type === 'trackTip') {
        trackTip = cmd.tip;
        if (trackLayer) drawTrack();
      } else if (cmd.type === 'clearTrack') {
        if (trackLayer) { trackShown = false; drawTrack(); }
      } else if (cmd.type === 'center') {
        map.setZoomAndCenter(cmd.zoom || map.getZoom(), [cmd.lng, cmd.lat]);
      } else if (cmd.type === 'helmetState') {
        // 离线：整块 Marker 换成带 .off 的内容（setContent 是 2.0 公开 API，比摸 DOM 稳）
        if (helmetOnline === !!cmd.online) return;
        helmetOnline = !!cmd.online;
        helmet.setContent(helmetHtml());
      } else if (cmd.type === 'helmetReplay') {
        if (helmetReplay === !!cmd.replay) return;
        helmetReplay = !!cmd.replay;
        helmet.setContent(helmetHtml());
      } else if (cmd.type === 'marks') {
        for (var i = 0; i < marks.length; i++) marks[i].setMap(null);
        marks = [];
        for (var j = 0; j < cmd.items.length; j++) {
          var it = cmd.items[j];
          var isEvent = it.kind === 'event';
          var half = isEvent ? 13 : 7;
          marks.push(new AMap.Marker({
            map: map,
            position: [it.lng, it.lat],
            // label 只可能是条数：进页面前再滤一遍，只留数字
            content: '<div class="mk ' + (isEvent ? (it.danger ? 'event danger' : 'event') : it.kind === 'end' ? 'end' : 'start') + '">' + (isEvent ? (String(it.label || '').replace(/[^0-9]/g, '') || '!') : '') + '</div>',
            anchor: 'top-left',
            offset: new AMap.Pixel(-half, -half),
            // 都压在轨迹线之上、头盔 Marker（120）之下；事件比起终点高一层
            zIndex: isEvent ? 116 : 114,
          }));
        }
      } else if (cmd.type === 'avatar') {
        if (avatarUrl === (cmd.url || null)) return;
        avatarUrl = cmd.url || null;
        helmet.setContent(helmetHtml());
      }
    } catch (e) { post({ type: 'error', message: i18n('cmd', e.message) }); }
  };
} catch (e) {
  post({ type: 'error', message: i18n('init', e.message) });
}
</script>
</body>
</html>`;

export function AmapView({
  style,
  onReady,
  onError,
  onUserPan,
  onUserZoom,
  controllerRef,
  light = false,
  avatarUrl = null,
}: Props) {
  const webRef = useRef<WebView>(null);
  const t = useT();
  // 注入给页内 JS 的错误文案（key 与页内 i18n() 调用一一对应）；{msg} 由页内替换
  const i18nJson = JSON.stringify({
    scriptLoad: t("map.err.scriptLoad"),
    noAmap: t("map.err.noAmap"),
    cmd: t("map.err.cmd"),
    init: t("map.err.init"),
  });
  // 就绪标志与队列全用 ref：send 的行为不依赖渲染期状态，杜绝闭包捕获旧值
  //（曾因 onReady 回调里的命令带着 ready=false 旧闭包入队、错过唯一一次冲刷而丢失）
  const readyRef = useRef(false);
  const announcedRef = useRef(false);
  const pending = useRef<Cmd[]>([]);
  // WebView 内容进程被系统杀掉后只能换一个新的 WebView：用 key 重挂载
  const [webKey, setWebKey] = useState(0);

  const inject = useCallback((cmd: Cmd) => {
    webRef.current?.injectJavaScript(
      `window.__cmd(${JSON.stringify(cmd)}); true;`,
    );
  }, []);

  const send = useCallback(
    (cmd: Cmd) => {
      if (!readyRef.current) {
        const slot = SLOT[cmd.type];
        pending.current = pending.current.filter((c) => SLOT[c.type] !== slot);
        pending.current.push(cmd);
        return;
      }
      inject(cmd);
    },
    [inject],
  );

  // 页面换新（重载 / 内容进程被杀后重挂载）：新页面什么都没有，等它的 ready 再回调一次 onReady，
  // 让调用方把轨迹、标记、在线状态重推一遍；头像是本组件自己推的，这里重新排进队列
  const resetPage = useCallback(() => {
    readyRef.current = false;
    announcedRef.current = false;
    send({ type: "avatar", url: avatarUrl });
  }, [send, avatarUrl]);

  useEffect(() => {
    controllerRef.current = {
      setHelmet: (pos, opts) =>
        send({
          type: "helmet",
          lng: pos.longitude,
          lat: pos.latitude,
          follow: opts?.follow ?? false,
        }),
      setTrack: (path, opts) =>
        send({
          type: "track",
          path: path.map((p) => [p.longitude, p.latitude]),
          fit: opts?.fit ?? true,
          pad: opts?.pad ?? [70, 70, 70, 70],
        }),
      setTrackTip: (tip) =>
        send({
          type: "trackTip",
          tip: tip ? [tip.longitude, tip.latitude] : null,
        }),
      clearTrack: () => send({ type: "clearTrack" }),
      setCenter: (pos, zoom) =>
        send({ type: "center", lng: pos.longitude, lat: pos.latitude, zoom }),
      hideHelmet: () => send({ type: "hideHelmet" }),
      setHelmetOnline: (online) => send({ type: "helmetState", online }),
      setHelmetReplay: (replay) => send({ type: "helmetReplay", replay }),
      setMarks: (marks) =>
        send({
          type: "marks",
          items: marks.map((m) => ({
            lng: m.longitude,
            lat: m.latitude,
            kind: m.kind,
            label: m.label ?? "",
            danger: m.danger === true,
          })),
        }),
      // 断网冷启动进地图页，高德脚本拉不到就一直「地图异常」，联网也不会自己好（2026-10-15）：
      // 重载整页，就绪标志复位，期间来的命令先排队，新 ready 到了再冲刷
      reload: () => {
        resetPage();
        webRef.current?.reload();
      },
    };
    return () => {
      controllerRef.current = null;
    };
  }, [send, controllerRef, resetPage]);

  // 头像变化（或地图重挂载）时推进页内；未就绪会排队，ready 后统一冲刷
  useEffect(() => {
    send({ type: "avatar", url: avatarUrl });
  }, [avatarUrl, send]);

  // 切换语言不重挂载地图（会丢失镜头/轨迹），只把新文案推进页内
  useEffect(() => {
    webRef.current?.injectJavaScript(`window.__I18N=${i18nJson};true;`);
  }, [i18nJson]);

  const restartWebView = () => {
    resetPage();
    setWebKey((k) => k + 1);
  };

  const handleMessage = (e: WebViewMessageEvent) => {
    let msg: { type?: string; message?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data) as {
        type?: string;
        message?: string;
      };
    } catch {
      return;
    }
    if (msg.type === "ready") {
      // ready 会重发多次（对抗通道就绪竞态）：每次都冲刷队列（幂等），onReady 只回调一次
      readyRef.current = true;
      const queued = pending.current;
      pending.current = [];
      for (const cmd of queued) inject(cmd);
      if (!announcedRef.current) {
        announcedRef.current = true;
        onReady?.();
      }
    } else if (msg.type === "userpan") {
      onUserPan?.();
    } else if (msg.type === "userzoom") {
      onUserZoom?.();
    } else if (msg.type === "error") {
      onError?.(msg.message ?? t("map.err.unknown"));
    }
  };

  // 注意：react-native-webview 的 style 只作用于内部内容层，外层容器仍按 flex 流占位——
  // 用普通 View 承接调用方的 style（含 absoluteFill），WebView 在其中铺满。
  return (
    <View style={style}>
      <WebView
        key={webKey}
        injectedJavaScriptBeforeContentLoaded={`window.__LIGHT=${light ? "true" : "false"};window.__I18N=${i18nJson};true;`}
        ref={webRef}
        style={styles.fill}
        containerStyle={styles.fill}
        source={{ html: HTML, baseUrl: "https://uri.amap.com" }}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={handleMessage}
        onError={(e) =>
          onError?.(t("map.err.webview", { msg: e.nativeEvent.description }))
        }
        // 内容进程被系统回收（后台久了、内存紧）：原来的 WebView 从此一直白屏。
        // 换一个新的 WebView，排队中的命令保留，新页面 ready 后调用方重推全部状态
        onContentProcessDidTerminate={restartWebView}
        onRenderProcessGone={restartWebView}
        // 地图页手势全部交给 WebView；禁掉滚动回弹避免与地图拖动打架
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setBuiltInZoomControls={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0B0C0E" },
});
