// 地图 Spike·路线 B（临时页面，定案后删除）：WebView + 高德 JS API 2.0
// 验证点：地图加载、Marker、Polyline、定位权限流程（含 WGS-84→GCJ-02 官方转换）、
// 错误状态（Key 无效/断网时 JS API 的表现）、手势流畅度（真机主观评估，与路线 A 对比）
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { WebView } from 'react-native-webview';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

const JS_KEY = process.env.EXPO_PUBLIC_AMAP_JS_KEY ?? '';
const SECURITY_CODE = process.env.EXPO_PUBLIC_AMAP_JS_SECURITY_CODE ?? '';

// 与路线 A 同一组测试坐标（GCJ-02），便于双端/双路线肉眼对比
const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html, body, #map { height: 100%; margin: 0; }</style>
<script>
  window._AMapSecurityConfig = { securityJsCode: '${SECURITY_CODE}' };
  function post(msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  }
  window.onerror = function (msg) { post('❌ JS 错误：' + msg); };
</script>
<script
  src="https://webapi.amap.com/maps?v=2.0&key=${JS_KEY}"
  onerror="post('❌ JS API 脚本加载失败（断网或 Key 服务不可达）')"></script>
</head>
<body>
<div id="map"></div>
<script>
  try {
    if (typeof AMap === 'undefined') throw new Error('AMap 未定义（脚本未加载成功）');
    var map = new AMap.Map('map', { center: [114.0579, 22.5431], zoom: 13 });
    map.on('complete', function () { post('✅ complete：地图加载完成'); });
    var marker = new AMap.Marker({ position: [114.0579, 22.5431], map: map });
    marker.on('click', function () { post('✅ Marker 点击事件正常'); });
    new AMap.Polyline({
      map: map,
      path: [[114.0579, 22.5431], [114.0611, 22.5462], [114.0587, 22.5488], [114.0632, 22.5512]],
      strokeColor: '#208AEF',
      strokeWeight: 6,
    });
    map.on('click', function (e) { post('点图：' + e.lnglat.getLat().toFixed(5) + ', ' + e.lnglat.getLng().toFixed(5)); });

    // RN 侧注入调用：WGS-84 GPS 坐标经高德官方 convertFrom 转 GCJ-02 后落点
    window.locateTo = function (lng, lat) {
      AMap.convertFrom([lng, lat], 'gps', function (status, result) {
        if (status === 'complete' && result.info === 'ok') {
          var p = result.locations[0];
          marker.setPosition(p);
          map.setZoomAndCenter(16, p);
          post('✅ convertFrom 转换成功，已定位（GCJ-02：' + p.getLat().toFixed(5) + ', ' + p.getLng().toFixed(5) + '）');
        } else {
          post('❌ convertFrom 转换失败：' + status);
        }
      });
    };
  } catch (e) {
    post('❌ 初始化失败：' + e.message);
  }
</script>
</body>
</html>`;

export default function SpikeMapWebScreen() {
  const webRef = useRef<WebView>(null);
  const [lines, setLines] = useState<string[]>([]);

  const log = (msg: string) => {
    console.log(`[spike-map-web] ${msg}`);
    setLines((prev) => [...prev.slice(-30), `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  // 流程按决策 #23：先用上次已知位置立即反馈，再持续监听等首次锁星（室内可能 1–2 分钟）
  const inject = (longitude: number, latitude: number, label: string) => {
    webRef.current?.injectJavaScript(`window.locateTo(${longitude}, ${latitude}); true;`);
    log(`${label} → 已注入 locateTo。若无 convertFrom 回执日志，说明 WebView 注入失效（记录！）`);
  };

  const locateMe = async () => {
    log('开始定位流程…');
    const servicesOn = await Location.hasServicesEnabledAsync();
    log(`系统定位开关：${servicesOn ? '开' : '关 ← 请到系统设置打开位置信息'}`);
    if (!servicesOn) return;
    const { status } = await Location.requestForegroundPermissionsAsync();
    log(`前台定位权限：${status}${status !== 'granted' ? ' ← 未授权，流程终止' : ''}`);
    if (status !== 'granted') return;

    // 上次已知位置：瞬时返回，先给用户一个立即反馈（可能为 null）
    const last = await Location.getLastKnownPositionAsync();
    if (last) {
      inject(last.coords.longitude, last.coords.latitude, '上次已知位置（可能过时）');
    } else {
      log('上次已知位置：无。等 GPS 首次锁星——室内可能 1–2 分钟，请到窗边/室外');
    }

    let gotFix = false;
    const watcher = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Highest, timeInterval: 2000, distanceInterval: 0 },
      (pos) => {
        gotFix = true;
        log(`实时 WGS-84 坐标：${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}（精度 ${pos.coords.accuracy?.toFixed(0)}m）→ 交给 JS API 转换`);
        inject(pos.coords.longitude, pos.coords.latitude, '实时定位');
        watcher.remove(); // Spike 只取一次
      },
    );
    setTimeout(() => {
      if (!gotFix) log('30 秒无实时坐标：GPS 仍在锁星（正常现象，非 Bug）。请到窗边/室外再等 1–2 分钟');
    }, 30_000);
  };

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <ThemedView style={styles.flex}>
        <WebView
          ref={webRef}
          style={styles.map}
          source={{ html: HTML, baseUrl: 'https://spike.helmet.local' }}
          originWhitelist={['*']}
          javaScriptEnabled
          onMessage={(e) => log(e.nativeEvent.data)}
          onError={(e) => log(`❌ WebView 错误：${e.nativeEvent.description}`)}
        />

        <View style={styles.panel}>
          <Pressable style={styles.button} onPress={locateMe}>
            <ThemedText type="smallBold" style={styles.buttonText}>
              定位权限流程 + 移动到我的位置
            </ThemedText>
          </Pressable>
          <ScrollView style={styles.logs}>
            {lines.length === 0 && (
              <ThemedText type="small" themeColor="textSecondary">
                等待 complete 消息…（无消息 = JS API 加载失败，看上方 WebView 表现并截图）
              </ThemedText>
            )}
            {lines.map((l, i) => (
              <ThemedText key={i} type="small">
                {l}
              </ThemedText>
            ))}
          </ScrollView>
        </View>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  map: { flex: 1 },
  panel: { padding: 12, gap: 8, maxHeight: 220 },
  logs: { flexGrow: 0 },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: { color: '#fff' },
});
