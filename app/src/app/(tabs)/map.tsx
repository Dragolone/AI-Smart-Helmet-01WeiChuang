// 地图（底部标签）正式版（Week 5–6 A 线，决策 #33：WebView + JS API）。
// 功能：实时位置（WS 直写缓存 + REST 兜底）、历史轨迹回放（1/6/24h + 近 7 天按日）、位置分享、导航跳转。
// UI 对齐 design/map.png：全屏暗色地图 + 荧光轨迹 + 顶部实时药丸 + 底部统计卡 + 回放播放器。
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LocationPoint, WsLocationData } from '@helmet/shared';

import { devicesApi } from '@/api/devices';
import { AmapView, type AmapViewHandle } from '@/components/map/amap-view';
import { cumulativeMeters, toGcj02, type LngLat } from '@/components/map/coords';
import { openAmapNavigation } from '@/components/map/nav-links';
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

/** dayOffset=0:此刻往前 hours;>0:N 天前整个自然日(24h 上限内,API.md §5) */
function trackWindow(hours: RangeHours, dayOffset: number): { from: Date; to: Date } {
  if (dayOffset === 0) {
    const to = new Date();
    return { from: new Date(to.getTime() - hours * 3_600_000), to };
  }
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const from = new Date(midnight.getTime() - dayOffset * 86_400_000);
  return { from, to: new Date(from.getTime() + 86_400_000 - 1) };
}

/** 离线设备药丸用:最后在线的相对时间 */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

function dayLabel(offset: number): string {
  if (offset === 0) return '今天';
  if (offset === 1) return '昨天';
  if (offset === 2) return '前天';
  const d = new Date(Date.now() - offset * 86_400_000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function fetchTrack(
  deviceId: string,
  hours: RangeHours,
  dayOffset: number,
): Promise<TrackResult> {
  const { from, to } = trackWindow(hours, dayOffset);
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
  const [dayOffset, setDayOffset] = useState(0);
  const [dateOpen, setDateOpen] = useState(false);
  // null = 实时模式；数字 = 回放中的当前轨迹点下标
  // 地图页常亮:骑行中把手机当仪表盘看,不该黑屏
  useKeepAwake();
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);
  // 跟随模式:用户手势拖图即退出,浮出"回到跟随"按钮
  const [following, setFollowing] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const devices = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list });
  const deviceList = devices.data ?? [];
  const device = deviceList.find((d) => d.deviceId === selectedId) ?? deviceList[0];
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
    queryKey: ['device-track', deviceId, range, dayOffset],
    queryFn: () => fetchTrack(deviceId!, range, dayOffset),
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
    mapRef.current?.setHelmet(toGcj02(liveLoc), { follow: following });
  }, [liveLoc, replayIdx, following]);

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
    }, REPLAY_TICK_MS / speed);
    return () => clearInterval(timer);
  }, [playing, gcjPath.length, speed]);

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
    await openAmapNavigation(sharePos, device?.name ?? deviceId ?? '头盔位置');
  };

  const online = device?.online ?? false;
  const cardBg = 'rgba(21, 22, 25, 0.92)';
  const chipBg = 'rgba(255, 255, 255, 0.08)';

  return (
    <View style={styles.flex}>
      <AmapView
        style={StyleSheet.absoluteFill}
        controllerRef={mapRef}
        onUserPan={() => setFollowing(false)}
        onError={(msg) => setMapError(msg)}
        // 地图（重）就绪时重推当前状态：WebView 重挂载/进程重启后 effect 依赖未变不会重发
        onReady={() => {
          if (gcjPath.length > 1) mapRef.current?.setTrack(gcjPath);
          const pos = replayIdx !== null ? gcjPath[replayIdx] : liveLoc && toGcj02(liveLoc);
          if (pos) mapRef.current?.setHelmet(pos, { follow: true });
        }}
      />

      {/* 浮层：普通 View + 手动 insets（顶部安全区自算，底部按平台让位） */}
      <View
        style={[
          styles.overlay,
          { paddingTop: insets.top + 14 },
          // iOS 原生标签条是半透明玻璃且内容会垫入其下（Android 内容区不含标签条）：
          // 浮层底部让出「home 指示条 + 标签条」的高度，卡片不被玻璃盖住
          Platform.OS === 'ios' && { paddingBottom: insets.bottom + 62 },
        ]}
        pointerEvents="box-none">
        {/* 顶部：实时状态药丸 + 分享/导航 */}
        <View style={styles.topRow} pointerEvents="box-none">
          <Pressable
            onPress={() => deviceList.length > 1 && setPickerOpen((v) => !v)}
            style={[styles.livePill, { backgroundColor: cardBg, borderColor: theme.border }]}>
            <View
              style={[
                styles.liveDot,
                { backgroundColor: online ? theme.success : theme.textSecondary },
              ]}
            />
            <View>
              <ThemedText type="smallBold" style={styles.lightText}>
                {online || !device ? '实时追踪' : '设备离线'}
              </ThemedText>
              <ThemedText type="label" style={styles.dimText}>
                {device
                  ? online
                    ? statPoint
                      ? `${device.name ?? device.deviceId} · ${new Date(statPoint.timestamp).toLocaleTimeString()}`
                      : `${device.name ?? device.deviceId} · 等待位置上报`
                    : `${device.name ?? device.deviceId} · 最后在线 ${device.lastSeenAt ? timeAgo(device.lastSeenAt) : '未知'}`
                  : '未绑定设备'}
              </ThemedText>
            </View>
            {deviceList.length > 1 && (
              <Ionicons
                name={pickerOpen ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={theme.textSecondary}
              />
            )}
          </Pressable>
          {/* 竖排:分享 → 导航跳转(罗盘) → 回中(指针,地图通用"我的位置"语义) */}
          <View style={styles.topActions}>
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
              <MaterialCommunityIcons
                name="compass-outline"
                size={22}
                color={sharePos ? theme.brand : theme.textSecondary}
              />
            </Pressable>
            <Pressable
              style={[styles.roundBtn, { backgroundColor: cardBg, borderColor: theme.border }]}
              onPress={() => {
                if (sharePos) mapRef.current?.setCenter(sharePos, 15);
              }}
              disabled={!sharePos}>
              <Ionicons
                name="navigate-outline"
                size={20}
                color={sharePos ? theme.brand : theme.textSecondary}
              />
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

        {/* 设备切换下拉(多设备时点药丸展开) */}
        {pickerOpen && (
          <View
            style={[styles.devicePicker, { backgroundColor: cardBg, borderColor: theme.border }]}>
            {deviceList.map((d) => (
              <Pressable
                key={d.deviceId}
                style={styles.pickerRow}
                onPress={() => {
                  setSelectedId(d.deviceId);
                  setPickerOpen(false);
                  setFollowing(true);
                }}>
                <View
                  style={[
                    styles.liveDot,
                    { backgroundColor: d.online ? theme.success : theme.textSecondary },
                  ]}
                />
                <ThemedText
                  type="smallBold"
                  style={d.deviceId === deviceId ? { color: theme.brand } : styles.lightText}
                  numberOfLines={1}>
                  {d.name ?? d.deviceId}
                </ThemedText>
              </Pressable>
            ))}
          </View>
        )}

        {/* 空状态:成功拉取且无绑定设备——新用户引导去绑定 */}
        {devices.isSuccess && deviceList.length === 0 && (
          <View style={styles.emptyWrap} pointerEvents="box-none">
            <View style={[styles.emptyCard, { backgroundColor: cardBg, borderColor: theme.border }]}>
              <Ionicons name="bicycle" size={40} color={theme.brand} />
              <ThemedText type="subtitle">还没有绑定头盔</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>
                绑定后就能在这里实时查看位置、回放轨迹
              </ThemedText>
              <Pressable
                style={[styles.emptyBtn, { backgroundColor: theme.brand }]}
                onPress={() => router.push('/bind-device')}>
                <ThemedText type="smallBold" style={{ color: theme.onBrand }}>
                  去绑定设备
                </ThemedText>
              </Pressable>
            </View>
          </View>
        )}

        {/* 底部组:跟随按钮悬在统计卡上方(流式布局,不与卡片抢层级) */}
        <View pointerEvents="box-none">
          {/* 退出跟随后浮出:一键回到实时跟随 */}
          {!following && replayIdx === null && (
            <Pressable
              style={[styles.followBtn, { backgroundColor: theme.brand }]}
              onPress={() => {
                setFollowing(true);
                if (liveLoc) mapRef.current?.setHelmet(toGcj02(liveLoc), { follow: true });
              }}>
              <Ionicons name="locate" size={16} color={theme.onBrand} />
              <ThemedText type="smallBold" style={{ color: theme.onBrand, fontSize: 13 }}>
                回到跟随
              </ThemedText>
            </Pressable>
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
              <Pressable
                style={[
                  styles.chip,
                  { backgroundColor: dayOffset > 0 ? theme.brand : chipBg },
                ]}
                onPress={() => setDateOpen((v) => !v)}>
                <ThemedText
                  type="label"
                  style={dayOffset > 0 ? { color: theme.onBrand } : styles.dimText}>
                  {dayLabel(dayOffset)} ▾
                </ThemedText>
              </Pressable>
              {RANGE_OPTIONS.map((h) => {
                const active = dayOffset === 0 && range === h;
                return (
                  <Pressable
                    key={h}
                    disabled={dayOffset > 0}
                    style={[
                      styles.chip,
                      { backgroundColor: active ? theme.brand : chipBg },
                      dayOffset > 0 && styles.chipDisabled,
                    ]}
                    onPress={() => setRange(h)}>
                    <ThemedText
                      type="label"
                      style={active ? { color: theme.onBrand } : styles.dimText}>
                      {h}h
                    </ThemedText>
                  </Pressable>
                );
              })}
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

          {dateOpen && (
            <View style={styles.chipRow}>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <Pressable
                  key={d}
                  style={[
                    styles.chip,
                    { backgroundColor: dayOffset === d ? theme.brand : chipBg },
                  ]}
                  onPress={() => {
                    setDayOffset(d);
                    setDateOpen(false);
                  }}>
                  <ThemedText
                    type="label"
                    style={dayOffset === d ? { color: theme.onBrand } : styles.dimText}>
                    {dayLabel(d)}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          )}

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
            <Pressable
              style={[styles.speedBtn, { backgroundColor: chipBg }]}
              disabled={gcjPath.length < 2}
              onPress={() => setSpeed((v) => (v === 1 ? 2 : v === 2 ? 4 : 1))}>
              <ThemedText
                type="label"
                style={speed > 1 ? { color: theme.brand } : styles.dimText}>
                ×{speed}
              </ThemedText>
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
        </View>
      </View>
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
  emptyWrap: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    alignItems: 'center',
    gap: 10,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 28,
    paddingVertical: 24,
    maxWidth: '82%',
  },
  emptyText: { textAlign: 'center' },
  emptyBtn: {
    borderRadius: Radius.pill,
    paddingHorizontal: 22,
    paddingVertical: 11,
    marginTop: 4,
  },
  flex: { flex: 1, backgroundColor: '#0B0C0E' },
  // 绝对定位 + zIndex：浮层明确压在全屏地图之上（双端触摸/渲染层级一致，模拟器已验证）
  overlay: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'space-between',
    padding: 14,
    zIndex: 10,
  },
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
  devicePicker: {
    position: 'absolute',
    top: 86,
    left: 14,
    minWidth: 220,
    borderRadius: Radius.card,
    borderWidth: 1,
    paddingVertical: 4,
    zIndex: 30,
    elevation: 12,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  followBtn: {
    alignSelf: 'flex-end',
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: Radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 9,
    elevation: 8,
  },
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
  speedBtn: {
    borderRadius: Radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minWidth: 34,
    alignItems: 'center',
  },
  chipDisabled: { opacity: 0.35 },
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
