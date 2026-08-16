// 地图（底部标签）正式版（Week 5–6 A 线，决策 #33：WebView + JS API）。
// 功能：实时位置（WS 直写缓存 + REST 兜底）、历史轨迹回放（1/6/24h）、位置分享、导航跳转。
// UI 对齐 design/map.png：全屏暗色地图 + 荧光轨迹 + 顶部实时药丸 + 底部统计卡 + 回放播放器。
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import type { LocationPoint, WsLocationData } from '@helmet/shared';

import { devicesApi } from '@/api/devices';
import { AmapView, type AmapViewHandle } from '@/components/map/amap-view';
import { cumulativeMeters, toGcj02, type LngLat } from '@/components/map/coords';
import { ThemedText } from '@/components/themed-text';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const RANGE_OPTIONS = [1, 6, 24] as const;
type RangeHours = (typeof RANGE_OPTIONS)[number];

/** 轨迹分页上限保护：10 页 × 100 点；超出如实提示截断（API.md §5：不假设所有点都在） */
const MAX_TRACK_PAGES = 10;
const TRACK_PAGE_SIZE = 100;
/** 回放步进：每 200ms 前进一个轨迹点（Mock 5s/点 ≈ 25 倍速） */
const REPLAY_TICK_MS = 200;

interface TrackResult {
  points: LocationPoint[];
  total: number;
  truncated: boolean;
}

async function fetchTrack(deviceId: string, hours: RangeHours): Promise<TrackResult> {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  const points: LocationPoint[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_TRACK_PAGES; page++) {
    const res = await devicesApi.locations(
      deviceId,
      from.toISOString(),
      to.toISOString(),
      page,
      TRACK_PAGE_SIZE,
    );
    points.push(...res.items);
    total = res.total;
    if (points.length >= res.total || res.items.length < TRACK_PAGE_SIZE) {
      return { points, total, truncated: false };
    }
  }
  return { points, total, truncated: true };
}

function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 轻量进度条（点按/拖动 seek）——不引第三方 Slider 依赖。
 *  定位模型：轨道两端各内缩一个点半径，点在 0%–100% 全程都落在条内且与轨道垂直居中；
 *  视觉层全部 pointerEvents=none，触摸永远落在外层容器上，locationX 参照系稳定不跳变。 */
const THUMB_R = 7;

function SeekBar({
  ratio,
  onSeek,
  accent,
  trackColor,
}: {
  ratio: number;
  onSeek: (ratio: number) => void;
  accent: string;
  trackColor: string;
}) {
  const width = useRef(1);
  const handle = (x: number) =>
    onSeek(
      Math.min(1, Math.max(0, (x - THUMB_R) / Math.max(1, width.current - THUMB_R * 2))),
    );
  return (
    <View
      style={styles.seekTouch}
      onLayout={(e: LayoutChangeEvent) => {
        width.current = Math.max(1, e.nativeEvent.layout.width);
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => handle(e.nativeEvent.locationX)}
      onResponderMove={(e) => handle(e.nativeEvent.locationX)}>
      <View pointerEvents="none" style={styles.seekRail}>
        <View style={[styles.seekTrack, { backgroundColor: trackColor }]}>
          <View
            style={[styles.seekFill, { backgroundColor: accent, width: `${ratio * 100}%` }]}
          />
        </View>
        <View
          style={[
            styles.seekThumb,
            { backgroundColor: accent, left: `${ratio * 100}%` },
          ]}
        />
      </View>
    </View>
  );
}

export default function MapScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mapRef = useRef<AmapViewHandle>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeHours>(1);
  // null = 实时模式；数字 = 回放中的当前轨迹点下标
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const devices = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list });
  const device = devices.data?.[0];
  const deviceId = device?.deviceId;

  // WS 推送直写此缓存（use-realtime）；REST 30s 轮询兜底（API.md §11 口径）
  const live = useQuery<WsLocationData | LocationPoint | null>({
    queryKey: ['device-location', deviceId],
    queryFn: async () => {
      const { location } = await devicesApi.latestLocation(deviceId!);
      return location;
    },
    enabled: !!deviceId,
    refetchInterval: 30_000,
  });

  const track = useQuery({
    queryKey: ['device-track', deviceId, range],
    queryFn: () => fetchTrack(deviceId!, range),
    enabled: !!deviceId,
  });

  const trackPoints = useMemo(() => track.data?.points ?? [], [track.data]);
  const gcjPath = useMemo<LngLat[]>(() => trackPoints.map(toGcj02), [trackPoints]);
  const cumulative = useMemo(() => cumulativeMeters(gcjPath), [gcjPath]);
  const trackStartMs = trackPoints.length
    ? new Date(trackPoints[0].timestamp).getTime()
    : 0;
  const trackEndMs = trackPoints.length
    ? new Date(trackPoints[trackPoints.length - 1].timestamp).getTime()
    : 0;

  // 轨迹变化（换设备/换时间段/新数据）：渲染期重置回放状态（React 官方"adjusting state"模式）
  const [prevPath, setPrevPath] = useState(gcjPath);
  if (prevPath !== gcjPath) {
    setPrevPath(gcjPath);
    if (replayIdx !== null) setReplayIdx(null);
    if (playing) setPlaying(false);
  }

  // 画轨迹线（effect 只同步外部系统）
  useEffect(() => {
    if (gcjPath.length > 1) {
      mapRef.current?.setTrack(gcjPath);
    } else {
      mapRef.current?.clearTrack();
    }
  }, [gcjPath]);

  // 实时模式：跟随最新位置
  const liveLoc = live.data ?? null;
  useEffect(() => {
    if (replayIdx !== null || !liveLoc) return;
    mapRef.current?.setHelmet(toGcj02(liveLoc), { follow: true });
  }, [liveLoc, replayIdx]);

  // 回放模式：头盔沿轨迹移动
  useEffect(() => {
    if (replayIdx === null || !gcjPath[replayIdx]) return;
    mapRef.current?.setHelmet(gcjPath[replayIdx], { follow: true });
  }, [replayIdx, gcjPath]);

  // 回放计时器
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setReplayIdx((idx) => {
        const next = (idx ?? 0) + 1;
        if (next >= gcjPath.length) {
          setPlaying(false);
          return gcjPath.length - 1;
        }
        return next;
      });
    }, REPLAY_TICK_MS);
    return () => clearInterval(timer);
  }, [playing, gcjPath.length]);

  // 统计卡数据源：回放中取轨迹点，否则取实时点
  const statPoint: LocationPoint | null =
    replayIdx !== null ? (trackPoints[replayIdx] ?? null) : liveLoc;
  const distanceMeters =
    replayIdx !== null
      ? (cumulative[replayIdx] ?? 0)
      : (cumulative[cumulative.length - 1] ?? 0);

  const replayRatio =
    replayIdx !== null && gcjPath.length > 1 ? replayIdx / (gcjPath.length - 1) : 0;
  const replayElapsedMs =
    replayIdx !== null && trackPoints[replayIdx]
      ? new Date(trackPoints[replayIdx].timestamp).getTime() - trackStartMs
      : 0;

  const togglePlay = () => {
    if (gcjPath.length < 2) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    setReplayIdx((idx) =>
      idx === null || idx >= gcjPath.length - 1 ? 0 : idx,
    );
    setPlaying(true);
  };

  const exitReplay = () => {
    setPlaying(false);
    setReplayIdx(null);
    if (liveLoc) mapRef.current?.setHelmet(toGcj02(liveLoc), { follow: true });
  };

  const sharePos = statPoint ? toGcj02(statPoint) : null;

  const shareLocation = async () => {
    if (!sharePos || !deviceId) return;
    // 高德分享链接吃 GCJ-02；App 端生成（API.md §5：不做服务端短链）
    await Share.share({
      message: `头盔 ${deviceId} 的位置：https://uri.amap.com/marker?position=${sharePos.longitude.toFixed(6)},${sharePos.latitude.toFixed(6)}&name=${encodeURIComponent(deviceId)}`,
    });
  };

  const navigateTo = async () => {
    if (!sharePos) return;
    const { longitude, latitude } = sharePos;
    // 优先拉起高德 App（dev=0 表示坐标已是 GCJ-02）；未安装则回落网页版
    const scheme =
      Platform.OS === 'ios'
        ? `iosamap://navi?sourceApplication=helmet&lat=${latitude}&lon=${longitude}&dev=0`
        : `androidamap://navi?sourceApplication=helmet&lat=${latitude}&lon=${longitude}&dev=0`;
    try {
      await Linking.openURL(scheme);
    } catch {
      await Linking.openURL(
        `https://uri.amap.com/navigation?to=${longitude},${latitude},${encodeURIComponent(deviceId ?? '头盔位置')}&mode=car`,
      );
    }
  };

  const online = device?.online ?? false;
  const cardBg = 'rgba(21, 22, 25, 0.92)';
  const chipBg = 'rgba(255, 255, 255, 0.08)';

  return (
    <View style={styles.flex}>
      <AmapView
        style={StyleSheet.absoluteFill}
        controllerRef={mapRef}
        onError={(msg) => setMapError(msg)}
        // 地图（重）就绪时重推当前状态：WebView 重挂载/进程重启后 effect 依赖未变不会重发
        onReady={() => {
          if (gcjPath.length > 1) mapRef.current?.setTrack(gcjPath);
          const pos = replayIdx !== null ? gcjPath[replayIdx] : liveLoc && toGcj02(liveLoc);
          if (pos) mapRef.current?.setHelmet(pos, { follow: true });
        }}
      />

      <SafeAreaView
        style={[
          styles.overlay,
          // iOS 原生标签条是半透明玻璃且内容会垫入其下（Android 内容区不含标签条）：
          // 浮层底部让出「home 指示条 + 标签条」的高度，卡片不被玻璃盖住
          Platform.OS === 'ios' && { paddingBottom: insets.bottom + 62 },
        ]}
        edges={['top']}
        pointerEvents="box-none">
        {/* 顶部：实时状态药丸 + 分享/导航 */}
        <View style={styles.topRow} pointerEvents="box-none">
          <View style={[styles.livePill, { backgroundColor: cardBg, borderColor: theme.border }]}>
            <View
              style={[
                styles.liveDot,
                { backgroundColor: online ? theme.success : theme.textSecondary },
              ]}
            />
            <View>
              <ThemedText type="smallBold" style={styles.lightText}>
                实时追踪
              </ThemedText>
              <ThemedText type="label" style={styles.dimText}>
                {deviceId
                  ? statPoint
                    ? `${deviceId} · ${new Date(statPoint.timestamp).toLocaleTimeString()}`
                    : `${deviceId} · 等待位置上报`
                  : '未绑定设备'}
              </ThemedText>
            </View>
          </View>
          <View style={styles.topActions}>
            <Pressable
              style={[styles.roundBtn, { backgroundColor: cardBg, borderColor: theme.border }]}
              onPress={() => {
                if (sharePos) mapRef.current?.setCenter(sharePos, 15);
              }}
              disabled={!sharePos}>
              <MaterialCommunityIcons name="compass-outline" size={22} color={sharePos ? '#F4F5F7' : theme.textSecondary} />
            </Pressable>
            <Pressable
              style={[styles.roundBtn, { backgroundColor: cardBg, borderColor: theme.border }]}
              onPress={shareLocation}
              disabled={!sharePos}>
              <Ionicons name="share-outline" size={20} color={sharePos ? theme.brand : theme.textSecondary} />
            </Pressable>
            <Pressable
              style={[styles.roundBtn, { backgroundColor: cardBg, borderColor: theme.border }]}
              onPress={navigateTo}
              disabled={!sharePos}>
              <Ionicons name="navigate-outline" size={20} color={sharePos ? theme.brand : theme.textSecondary} />
            </Pressable>
          </View>
        </View>

        {mapError && (
          <View style={[styles.errorBanner, { backgroundColor: theme.dangerBg }]}>
            <ThemedText type="small" themeColor="danger">
              地图异常：{mapError}
            </ThemedText>
          </View>
        )}

        {/* 底部：统计卡 + 回放播放器 */}
        <View style={[styles.bottomCard, { backgroundColor: cardBg, borderColor: theme.border }]}>
          <View style={styles.statsRow}>
            <Stat icon="speedometer" label="速度" value={statPoint ? (statPoint.speed * 3.6).toFixed(0) : '—'} unit="km/h" caption="当前" />
            <View style={[styles.vDivider, { backgroundColor: theme.border }]} />
            <Stat icon="image-filter-hdr" label="海拔" value={statPoint?.altitude != null ? statPoint.altitude.toFixed(0) : '—'} unit="m" caption="高程" />
            <View style={[styles.vDivider, { backgroundColor: theme.border }]} />
            <Stat icon="battery-high" label="电量" value={device?.battery != null ? String(device.battery) : '—'} unit="%" caption={device?.charging ? '充电中' : '剩余'} />
            <View style={[styles.vDivider, { backgroundColor: theme.border }]} />
            <Stat icon="map-marker-distance" label="里程" value={(distanceMeters / 1000).toFixed(1)} unit="km" caption="行程" />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.replayHeader}>
            <ThemedText type="label" style={styles.dimText}>
              轨迹回放
            </ThemedText>
            <View style={styles.chipRow}>
              {RANGE_OPTIONS.map((h) => (
                <Pressable
                  key={h}
                  style={[
                    styles.chip,
                    { backgroundColor: range === h ? theme.brand : chipBg },
                  ]}
                  onPress={() => setRange(h)}>
                  <ThemedText
                    type="label"
                    style={range === h ? { color: theme.onBrand } : styles.dimText}>
                    {h}h
                  </ThemedText>
                </Pressable>
              ))}
            </View>
            <ThemedText type="label" style={styles.dimText}>
              {gcjPath.length > 1 ? (
                <>
                  <ThemedText type="label" themeColor="brand">
                    {formatClock(replayElapsedMs)}
                  </ThemedText>
                  {' / '}
                  {formatClock(trackEndMs - trackStartMs)}
                </>
              ) : track.isLoading ? (
                '轨迹加载中…'
              ) : (
                '该时段无轨迹'
              )}
            </ThemedText>
          </View>

          <View style={styles.replayRow}>
            <Pressable
              style={[styles.playBtn, { borderColor: theme.brand }]}
              onPress={togglePlay}
              disabled={gcjPath.length < 2}>
              <Ionicons
                name={playing ? 'pause' : 'play'}
                size={16}
                color={gcjPath.length < 2 ? theme.textSecondary : theme.brand}
              />
            </Pressable>
            <View style={styles.seekColumn}>
              <SeekBar
                ratio={replayRatio}
                accent={theme.brand}
                trackColor={chipBg}
                onSeek={(r) => {
                  if (gcjPath.length < 2) return;
                  setPlaying(false);
                  setReplayIdx(Math.round(r * (gcjPath.length - 1)));
                }}
              />
              <View style={styles.seekLabels}>
                <ThemedText type="label" style={styles.captionText}>
                  00:00
                </ThemedText>
                <ThemedText type="label" style={styles.captionText}>
                  {gcjPath.length > 1 ? formatClock(trackEndMs - trackStartMs) : '--:--'}
                </ThemedText>
              </View>
            </View>
            {replayIdx !== null && (
              <Pressable style={styles.exitBtn} onPress={exitReplay}>
                <ThemedText type="label" themeColor="brand">
                  回实时
                </ThemedText>
              </Pressable>
            )}
          </View>

          {track.data?.truncated && (
            <ThemedText type="label" style={styles.dimText}>
              该时段点位较多，仅加载前 {MAX_TRACK_PAGES * TRACK_PAGE_SIZE} 点（共{' '}
              {track.data.total} 点）
            </ThemedText>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function Stat({
  icon,
  label,
  value,
  unit,
  caption,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  value: string;
  unit: string;
  caption: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stat}>
      <MaterialCommunityIcons name={icon} size={18} color={theme.brand} />
      <ThemedText type="label" style={styles.dimText}>
        {label}
      </ThemedText>
      <View style={styles.statValueRow}>
        <ThemedText type="display" style={[styles.statValue, styles.lightText]}>
          {value}
        </ThemedText>
        <ThemedText type="label" style={styles.dimText}>
          {unit}
        </ThemedText>
      </View>
      <ThemedText type="label" style={styles.captionText}>
        {caption}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#0B0C0E' },
  overlay: { flex: 1, justifyContent: 'space-between', padding: 14 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 22,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  liveDot: { width: 10, height: 10, borderRadius: 5 },
  topActions: { flexDirection: 'column', gap: 8 },
  roundBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBanner: { borderRadius: Radius.control, padding: 10 },
  bottomCard: {
    borderRadius: 22,
    borderWidth: 1,
    padding: 14,
    gap: 9,
  },
  statsRow: { flexDirection: 'row', alignItems: 'stretch' },
  vDivider: { width: StyleSheet.hairlineWidth, marginHorizontal: 10 },
  stat: { gap: 3, alignItems: 'flex-start', flex: 1 },
  statValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  statValue: { fontSize: 22, lineHeight: 26 },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  replayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chipRow: { flexDirection: 'row', gap: 6 },
  chip: {
    borderRadius: Radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  replayRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  seekColumn: { flex: 1, gap: 2 },
  seekLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  playBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exitBtn: { paddingHorizontal: 4 },
  seekTouch: { flex: 1, height: 28, justifyContent: 'center' },
  // 轨道两端内缩点半径：点的可动范围 = 轨道范围，0%/100% 不出界
  seekRail: { marginHorizontal: THUMB_R, justifyContent: 'center' },
  seekTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  seekFill: { height: 4, borderRadius: 2 },
  seekThumb: {
    position: 'absolute',
    width: THUMB_R * 2,
    height: THUMB_R * 2,
    borderRadius: THUMB_R,
    marginLeft: -THUMB_R,
    top: '50%',
    marginTop: -THUMB_R,
  },
  lightText: { color: '#FFFFFF' },
  dimText: { color: '#9BA1AA' },
  captionText: { color: '#6E747D' },
});
