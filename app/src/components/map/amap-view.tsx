// App 内部 Map 组件层（决策 #11/#33）：WebView + 高德 JS API 2.0 的唯一封装点。
// 业务页只使用本组件的命令式接口（setHelmet/setTrack/…），不触碰 WebView/JS API 细节——换库只改这里。
// 地图固定暗色样式（设计系统"深色监控台"口径，与 design/map.png 一致）。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Colors } from '@/constants/theme';
import type { LngLat } from './coords';

const JS_KEY = process.env.EXPO_PUBLIC_AMAP_JS_KEY ?? '';
const SECURITY_CODE = process.env.EXPO_PUBLIC_AMAP_JS_SECURITY_CODE ?? '';
/** 荧光柠檬品牌色：轨迹辉光与头盔 Marker 用（地图始终暗色，取 dark 值） */
const ACCENT = Colors.dark.brand;

export interface AmapViewHandle {
  /** 移动头盔 Marker（实时位置或回放位置共用）；follow 时镜头平滑跟随 */
  setHelmet(pos: LngLat, opts?: { follow?: boolean }): void;
  /** 画整条轨迹（荧光双层线）并把视野收进轨迹范围 */
  setTrack(path: LngLat[]): void;
  clearTrack(): void;
  setCenter(pos: LngLat, zoom?: number): void;
}

interface Props {
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onError?: (message: string) => void;
  /** 命令句柄注入位：父组件传 useRef(null)，本组件挂载后填充。
   *  不用 useImperativeHandle——实测其在本项目 React Compiler 下 ref 永不挂载（2026-08-16）。 */
  controllerRef: RefObject<AmapViewHandle | null>;
}

type Cmd =
  | { type: 'helmet'; lng: number; lat: number; follow: boolean }
  | { type: 'track'; path: [number, number][] }
  | { type: 'clearTrack' }
  | { type: 'center'; lng: number; lat: number; zoom?: number };

// 默认视野：深圳（设备无数据时的兜底画面）
const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body, #map { height: 100%; margin: 0; background: #0B0C0E; }
  /* 底图压暗去蓝调（对齐 design/map.png 近黑风格）：只作用于瓦片/线条画布，
     DOM Marker 不受影响；轨迹线亮度损失由更亮的描边色补偿 */
  #map canvas { filter: saturate(0.35) brightness(0.85) contrast(1.08); }
  .hm { position: relative; width: 64px; height: 72px; }
  .hm .ring { position: absolute; left: 4px; top: 4px; width: 56px; height: 56px;
    border-radius: 50%; border: 1.5px solid ${ACCENT}; opacity: 0;
    animation: pulse 2.4s ease-out infinite; }
  .hm .ring.r2 { animation-delay: 0.8s; }
  .hm .ring.r3 { animation-delay: 1.6s; }
  @keyframes pulse {
    0% { transform: scale(0.55); opacity: 0.85; }
    100% { transform: scale(1.3); opacity: 0; }
  }
  .hm .badge { position: absolute; left: 50%; top: 32px; width: 42px; height: 42px;
    transform: translate(-50%, -50%); border-radius: 50%;
    background: #17181B; border: 2.5px solid ${ACCENT};
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 18px ${ACCENT}59, 0 4px 14px rgba(0,0,0,0.6); }
  /* 锚点荧光小圆点（map.png 的 Marker 底部落点） */
  .hm .tip { position: absolute; left: 50%; top: 60px; width: 10px; height: 10px;
    transform: translate(-50%, -50%); border-radius: 50%;
    background: ${ACCENT}; box-shadow: 0 0 10px ${ACCENT}; }
</style>
<script>
  window._AMapSecurityConfig = { securityJsCode: '${SECURITY_CODE}' };
  function post(obj) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(obj));
  }
  window.onerror = function (msg) { post({ type: 'error', message: String(msg) }); };
</script>
<script
  src="https://webapi.amap.com/maps?v=2.0&key=${JS_KEY}"
  onerror="post({ type: 'error', message: 'JS API 脚本加载失败（网络不可达或 Key 服务异常）' })"></script>
</head>
<body>
<div id="map"></div>
<script>
try {
  if (typeof AMap === 'undefined') throw new Error('AMap 未定义（脚本未加载成功）');
  var map = new AMap.Map('map', {
    mapStyle: 'amap://styles/dark',
    center: [114.0579, 22.5431],
    zoom: 13,
  });
  // Marker 按 map.png：暗色圆徽章（白色头盔图标）+ 荧光描边 + 波纹 + 底部荧光落点
  var helmetContent =
    '<div class="hm"><div class="ring"></div><div class="ring r2"></div><div class="ring r3"></div>' +
    '<div class="tip"></div>' +
    '<div class="badge"><svg viewBox="0 0 24 24" width="24" height="24" fill="#F4F5F7">' +
    '<path d="M12 4a8 8 0 0 0-8 8v3.5A1.5 1.5 0 0 0 5.5 17H7l1.2 2.2c.3.5.8.8 1.4.8h4.8c.6 0 1.1-.3 1.4-.8L17 17h1.5a1.5 1.5 0 0 0 1.5-1.5V12a8 8 0 0 0-8-8Zm-6 8a6 6 0 0 1 12 0v1H6Z"/></svg></div></div>';
  var helmet = new AMap.Marker({
    content: helmetContent,
    // 锚点对准 .tip 荧光点（宽 64 的中线，纵向 60px 处）
    anchor: 'top-left',
    offset: new AMap.Pixel(-32, -60),
    zIndex: 120,
  });
  var helmetShown = false;
  // 辉光轨迹（三层）：最宽淡光晕 + 中层柔光 + 细亮主线；亮色补偿画布压暗。
  // 懒创建：JS API 2.0 对空 path 构造会报 "error Polyline path"，首次收到轨迹再建。
  var glowHalo = null, glowOuter = null, glowInner = null;
  function ensurePolylines() {
    if (glowInner) return;
    glowHalo = new AMap.Polyline({
      map: map, strokeColor: '${ACCENT}', strokeWeight: 12,
      strokeOpacity: 0.1, lineJoin: 'round', lineCap: 'round', zIndex: 98,
    });
    glowOuter = new AMap.Polyline({
      map: map, strokeColor: '${ACCENT}', strokeWeight: 7,
      strokeOpacity: 0.24, lineJoin: 'round', lineCap: 'round', zIndex: 100,
    });
    glowInner = new AMap.Polyline({
      map: map, strokeColor: '#E9FF54', strokeWeight: 4,
      strokeOpacity: 1, lineJoin: 'round', lineCap: 'round', zIndex: 110,
    });
  }
  // ready 重发兜底：complete 可能早于 RN 消息通道就绪，首发丢失会让所有命令永远排队。
  // 重发数次由 RN 侧幂等消化。
  var readyTries = 0;
  var readyTimer = setInterval(function () {
    post({ type: 'ready' });
    if (++readyTries >= 6) clearInterval(readyTimer);
  }, 700);
  map.on('complete', function () { post({ type: 'ready' }); });

  window.__cmd = function (cmd) {
    try {
      if (cmd.type === 'helmet') {
        var p = new AMap.LngLat(cmd.lng, cmd.lat);
        helmet.setPosition(p);
        if (!helmetShown) { helmet.setMap(map); helmetShown = true; }
        if (cmd.follow) map.panTo(p);
      } else if (cmd.type === 'track') {
        if (!cmd.path.length) return;
        ensurePolylines();
        glowHalo.setPath(cmd.path);
        glowOuter.setPath(cmd.path);
        glowInner.setPath(cmd.path);
        if (cmd.path.length > 1) map.setFitView([glowInner], true, [70, 70, 70, 70]);
      } else if (cmd.type === 'clearTrack') {
        if (glowInner) {
          glowHalo.setPath([]);
          glowOuter.setPath([]);
          glowInner.setPath([]);
        }
      } else if (cmd.type === 'center') {
        map.setZoomAndCenter(cmd.zoom || map.getZoom(), [cmd.lng, cmd.lat]);
      }
    } catch (e) { post({ type: 'error', message: 'cmd 执行失败：' + e.message }); }
  };
} catch (e) {
  post({ type: 'error', message: '初始化失败：' + e.message });
}
</script>
</body>
</html>`;

export function AmapView({ style, onReady, onError, controllerRef }: Props) {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // ready 前的命令排队，ready 后按序重放——调用方不用关心时序
  const pending = useRef<Cmd[]>([]);

  const send = useCallback(
    (cmd: Cmd) => {
      if (!ready) {
        pending.current.push(cmd);
        return;
      }
      webRef.current?.injectJavaScript(
        `window.__cmd(${JSON.stringify(cmd)}); true;`,
      );
    },
    [ready],
  );

  useEffect(() => {
    controllerRef.current = {
      setHelmet: (pos, opts) =>
        send({
          type: 'helmet',
          lng: pos.longitude,
          lat: pos.latitude,
          follow: opts?.follow ?? false,
        }),
      setTrack: (path) =>
        send({
          type: 'track',
          path: path.map((p) => [p.longitude, p.latitude]),
        }),
      clearTrack: () => send({ type: 'clearTrack' }),
      setCenter: (pos, zoom) =>
        send({ type: 'center', lng: pos.longitude, lat: pos.latitude, zoom }),
    };
    return () => {
      controllerRef.current = null;
    };
  }, [send, controllerRef]);

  const handleMessage = (e: WebViewMessageEvent) => {
    let msg: { type?: string; message?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data) as { type?: string; message?: string };
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      // ready 会重发多次（对抗通道就绪竞态），只处理首次
      if (ready) return;
      setReady(true);
      const queued = pending.current;
      pending.current = [];
      for (const cmd of queued) {
        webRef.current?.injectJavaScript(
          `window.__cmd(${JSON.stringify(cmd)}); true;`,
        );
      }
      onReady?.();
    } else if (msg.type === 'error') {
      onError?.(msg.message ?? '地图未知错误');
    }
  };

  // 注意：react-native-webview 的 style 只作用于内部内容层，外层容器仍按 flex 流占位——
  // 用普通 View 承接调用方的 style（含 absoluteFill），WebView 在其中铺满。
  return (
    <View style={style}>
      <WebView
        ref={webRef}
        style={styles.fill}
        containerStyle={styles.fill}
        source={{ html: HTML, baseUrl: 'https://helmet.map.local' }}
        originWhitelist={['*']}
        javaScriptEnabled
        onMessage={handleMessage}
        onError={(e) => onError?.(`WebView 错误：${e.nativeEvent.description}`)}
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
  fill: { flex: 1, backgroundColor: '#0B0C0E' },
});
