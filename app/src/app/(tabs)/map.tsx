// 地图（底部标签）正式版（Week 5–6 A 线，决策 #33：WebView + JS API）。
// 功能：实时位置（WS 直写缓存 + REST 兜底）、历史轨迹回放（1/6/24h + 近 7 天按日）、位置分享、导航跳转。
// 2026-09-10 重设计：全屏地图 + 左上设备药丸 + 右侧三枚圆钮（回中/跟随/分享）+ 底部统计卡，
// 回放面板收进卡内按需展开；唯一品牌填充控件是「导航到头盔」主按钮。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useKeepAwake } from "expo-keep-awake";
import { Image } from "expo-image";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  type LayoutChangeEvent,
  Platform,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LocationPoint, WsLocationData } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { realtimeClient } from "@/api/realtime";
import { PrimaryButton, SecondaryButton } from "@/components/form";
import { AmapView, type AmapViewHandle } from "@/components/map/amap-view";
import {
  cumulativeMeters,
  toGcj02,
  type LngLat,
} from "@/components/map/coords";
import { openAmapNavigation } from "@/components/map/nav-links";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { translate, useLocale, useT } from "@/i18n";
import { relativeTime } from "@/i18n/format";

const RANGE_OPTIONS = [1, 6, 24] as const;
type RangeHours = (typeof RANGE_OPTIONS)[number];
type Translate = ReturnType<typeof useT>;

/** 轨迹分页上限保护：10 页 × 100 点；超出如实提示截断（API.md §5：不假设所有点都在） */
const MAX_TRACK_PAGES = 10;
const TRACK_PAGE_SIZE = 100;
/** 回放步进：每 200ms 前进一个轨迹点（Mock 5s/点 ≈ 25 倍速） */
const REPLAY_TICK_MS = 200;
/** 近 7 天按日选择 */
const DAY_OFFSETS = [0, 1, 2, 3, 4, 5, 6] as const;

interface TrackResult {
  points: LocationPoint[];
  total: number;
  truncated: boolean;
}

/** dayOffset=0:此刻往前 hours;>0:N 天前整个自然日(24h 上限内,API.md §5) */
function trackWindow(
  hours: RangeHours,
  dayOffset: number,
): { from: Date; to: Date } {
  if (dayOffset === 0) {
    const to = new Date();
    return { from: new Date(to.getTime() - hours * 3_600_000), to };
  }
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const from = new Date(midnight.getTime() - dayOffset * 86_400_000);
  return { from, to: new Date(from.getTime() + 86_400_000 - 1) };
}

function dayLabel(offset: number, t: Translate): string {
  if (offset === 0) return t("common.today");
  if (offset === 1) return t("common.yesterday");
  if (offset === 2) return t("map.dayBefore");
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
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
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
      Math.min(
        1,
        Math.max(0, (x - THUMB_R) / Math.max(1, width.current - THUMB_R * 2)),
      ),
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
      onResponderMove={(e) => handle(e.nativeEvent.locationX)}
    >
      <View pointerEvents="none" style={styles.seekRail}>
        <View style={[styles.seekTrack, { backgroundColor: trackColor }]}>
          <View
            style={[
              styles.seekFill,
              { backgroundColor: accent, width: `${ratio * 100}%` },
            ]}
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

/** 右侧浮动圆钮：中性底 + 描边 + 白色图标；激活态只染图标色，不填充（品牌填充只留给主按钮） */
function RoundButton({
  icon,
  label,
  onPress,
  disabled = false,
  tint,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
}) {
  const theme = useTheme();
  return (
    <Tappable
      haptic
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.roundBtn,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}
    >
      <Ionicons name={icon} size={22} color={tint ?? theme.text} />
    </Tappable>
  );
}

function Chip({
  label,
  active,
  disabled = false,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Tappable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: active ? theme.brand : theme.backgroundSelected },
      ]}
    >
      <ThemedText
        type="smallBold"
        style={[
          styles.chipText,
          { color: active ? theme.onBrand : theme.textSecondary },
        ]}
      >
        {label}
      </ThemedText>
    </Tappable>
  );
}

function Stat({
  label,
  value,
  unit,
  valueColor,
}: {
  label: string;
  value: string;
  unit: string;
  valueColor?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stat}>
      <ThemedText
        type="small"
        themeColor="textSecondary"
        style={styles.statLabel}
      >
        {label}
      </ThemedText>
      <View style={styles.statValueRow}>
        <ThemedText
          type="display"
          style={[styles.statValue, { color: valueColor ?? theme.text }]}
          numberOfLines={1}
        >
          {value}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={styles.statUnit}
        >
          {unit}
        </ThemedText>
      </View>
    </View>
  );
}

export default function MapScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const t = useT();
  const locale = useLocale();
  const insets = useSafeAreaInsets();
  const mapRef = useRef<AmapViewHandle>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeHours>(1);
  const [dayOffset, setDayOffset] = useState(0);
  const [dateOpen, setDateOpen] = useState(false);
  // 回放面板默认收起，点「历史轨迹」展开
  const [historyOpen, setHistoryOpen] = useState(false);
  // 骑行面板收纳：收起只留状态行，地图占满（骑行中当仪表盘看时用）
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // 从安全事件「在地图上查看该时刻」跳入：?deviceId=&at=ISO → 定位到当天轨迹并把回放停在该时刻
  const params = useLocalSearchParams<{ deviceId?: string; at?: string }>();
  const [jumpAt, setJumpAt] = useState<number | null>(null);
  // null = 实时模式；数字 = 回放中的当前轨迹点下标
  // 地图页常亮:骑行中把手机当仪表盘看,不该黑屏
  useKeepAwake();
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);
  // 跟随模式:用户手势拖图即退出,右侧「跟随」圆钮可重新开启
  const [following, setFollowing] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });
  /** 底部卡进场动画:每次进入地图页(且有设备)从下方弹入;Animated.Value 惰性
   *  useState 持有(React Compiler 禁止渲染期读 ref,平台限制清单口径) */
  const [cardIn] = useState(() => new Animated.Value(0));
  /** WS 加速通道健康度:断线时药丸下方提示「重连中」,野外测试知道数据是否还新鲜 */
  const [wsUp, setWsUp] = useState(true);
  useEffect(() => realtimeClient.subscribeState(setWsUp), []);
  const deviceList = devices.data ?? [];
  const device =
    deviceList.find((d) => d.deviceId === selectedId) ?? deviceList[0];
  const hasDevice = device != null;
  const canPick = deviceList.length > 1;

  useFocusEffect(
    useCallback(() => {
      if (!hasDevice) {
        cardIn.setValue(0);
        return;
      }
      cardIn.setValue(0);
      Animated.spring(cardIn, {
        toValue: 1,
        useNativeDriver: true,
        friction: 9,
        tension: 70,
      }).start();
    }, [hasDevice, cardIn]),
  );
  const deviceId = device?.deviceId;

  // 路由参数是一次性外部输入，不是可推导状态：放到下一 tick 应用，避免 effect 内同步 setState 级联重渲染
  useEffect(() => {
    if (!params.at) return;
    const at = new Date(params.at).getTime();
    if (Number.isNaN(at)) return;
    const targetDevice = params.deviceId;
    const id = setTimeout(() => {
      if (targetDevice) setSelectedId(targetDevice);
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      if (at >= midnight.getTime()) {
        const hoursAgo = (Date.now() - at) / 3_600_000;
        setDayOffset(0);
        setRange(hoursAgo <= 1 ? 1 : hoursAgo <= 6 ? 6 : 24);
      } else {
        setDayOffset(Math.floor((midnight.getTime() - at) / 86_400_000) + 1);
      }
      setHistoryOpen(true);
      setPanelCollapsed(false);
      setJumpAt(at);
      // 用完即清，避免下次进页面重复跳
      router.setParams({ at: undefined, deviceId: undefined });
    }, 0);
    return () => clearTimeout(id);
  }, [params.at, params.deviceId]);

  // WS 推送直写此缓存（use-realtime）；REST 30s 轮询兜底（API.md §11 口径）
  const live = useQuery<WsLocationData | LocationPoint | null>({
    queryKey: ["device-location", deviceId],
    queryFn: async () => {
      const { location } = await devicesApi.latestLocation(deviceId!);
      return location;
    },
    enabled: !!deviceId,
    refetchInterval: 30_000,
  });

  const track = useQuery({
    queryKey: ["device-track", deviceId, range, dayOffset],
    queryFn: () => fetchTrack(deviceId!, range, dayOffset),
    enabled: !!deviceId,
  });

  const trackPoints = useMemo(() => track.data?.points ?? [], [track.data]);
  const gcjPath = useMemo<LngLat[]>(
    () => trackPoints.map(toGcj02),
    [trackPoints],
  );
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

  const canReplay = gcjPath.length > 1;
  const replayRatio =
    replayIdx !== null && canReplay ? replayIdx / (gcjPath.length - 1) : 0;
  const replayElapsedMs =
    replayIdx !== null && trackPoints[replayIdx]
      ? new Date(trackPoints[replayIdx].timestamp).getTime() - trackStartMs
      : 0;

  const togglePlay = () => {
    if (!canReplay) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    setReplayIdx((idx) =>
      idx === null || idx >= gcjPath.length - 1 ? 0 : idx,
    );
    setPlaying(true);
  };

  useEffect(() => {
    if (jumpAt === null || trackPoints.length === 0) return;
    let best = 0;
    let bestDiff = Number.POSITIVE_INFINITY;
    trackPoints.forEach((p, i) => {
      const diff = Math.abs(new Date(p.timestamp).getTime() - jumpAt);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    const id = setTimeout(() => {
      setPlaying(false);
      setReplayIdx(best);
      setJumpAt(null);
    }, 0);
    return () => clearTimeout(id);
  }, [jumpAt, trackPoints]);

  const exitReplay = () => {
    setPlaying(false);
    setReplayIdx(null);
    if (liveLoc) mapRef.current?.setHelmet(toGcj02(liveLoc), { follow: true });
  };

  // 收起面板时若还在回放，一并回到实时，避免地图停在旧点却没有退出入口
  const toggleHistory = () => {
    if (historyOpen && replayIdx !== null) exitReplay();
    setHistoryOpen((v) => !v);
  };

  const toggleFollow = () => {
    const next = !following;
    setFollowing(next);
    if (next && liveLoc)
      mapRef.current?.setHelmet(toGcj02(liveLoc), { follow: true });
  };

  const sharePos = statPoint ? toGcj02(statPoint) : null;

  const recenter = () => {
    if (sharePos) mapRef.current?.setCenter(sharePos, 15);
  };

  const shareLocation = async () => {
    if (!sharePos || !device) return;
    // 高德分享链接吃 GCJ-02；App 端生成（API.md §5：不做服务端短链）
    const name = device.name ?? device.deviceId;
    const url = `https://uri.amap.com/marker?position=${sharePos.longitude.toFixed(6)},${sharePos.latitude.toFixed(6)}&name=${encodeURIComponent(name)}`;
    await Share.share({
      message: translate("map.shareMessage", { name, url }),
    });
  };

  const navigateTo = async () => {
    if (!sharePos || !device) return;
    await openAmapNavigation(sharePos, device.name ?? device.deviceId);
  };

  const online = device?.online ?? false;
  const dotColor = !wsUp
    ? theme.warning
    : online
      ? theme.success
      : theme.textSecondary;
  const caption = statPoint
    ? t("map.updatedAgo", { ago: relativeTime(statPoint.timestamp, locale) })
    : t("map.waiting");

  const devicePillBody = (
    <>
      <View style={[styles.liveDot, { backgroundColor: dotColor }]} />
      <ThemedText type="smallBold" numberOfLines={1} style={styles.pillName}>
        {device?.name ?? device?.deviceId}
      </ThemedText>
      {canPick && (
        <Ionicons
          name={pickerOpen ? "chevron-up" : "chevron-down"}
          size={16}
          color={theme.textSecondary}
        />
      )}
    </>
  );
  const devicePillStyle = [
    styles.devicePill,
    { backgroundColor: theme.backgroundElement, borderColor: theme.border },
  ];

  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <AmapView
        // 外观切换时重挂载：底图样式在 WebView 初始化时决定；onReady 会重推当前状态
        key={scheme}
        light={scheme === "light"}
        style={StyleSheet.absoluteFill}
        controllerRef={mapRef}
        onUserPan={() => setFollowing(false)}
        onError={(msg) => setMapError(msg)}
        // 地图（重）就绪时重推当前状态：WebView 重挂载/进程重启后 effect 依赖未变不会重发
        onReady={() => {
          if (gcjPath.length > 1) mapRef.current?.setTrack(gcjPath);
          const pos =
            replayIdx !== null
              ? gcjPath[replayIdx]
              : liveLoc && toGcj02(liveLoc);
          if (pos) mapRef.current?.setHelmet(pos, { follow: true });
        }}
      />

      {/* 浮层：普通 View + 手动 insets（顶部安全区自算，底部按平台让位） */}
      <View
        style={[
          styles.overlay,
          { paddingTop: insets.top + 8 },
          // iOS 原生标签条是半透明玻璃且内容会垫入其下（Android 内容区不含标签条）：
          // 浮层底部让出「home 指示条 + 标签条」的高度，卡片不被玻璃盖住
          Platform.OS === "ios" && { paddingBottom: insets.bottom + 62 },
        ]}
        pointerEvents="box-none"
      >
        {/* 顶部：仅设备药丸（多设备可点开切换）+ 断线/地图异常横幅 */}
        <View style={styles.topArea} pointerEvents="box-none">
          {hasDevice &&
            (canPick ? (
              <Tappable
                accessibilityRole="button"
                onPress={() => setPickerOpen((v) => !v)}
                style={devicePillStyle}
              >
                {devicePillBody}
              </Tappable>
            ) : (
              <View style={devicePillStyle}>{devicePillBody}</View>
            ))}

          {hasDevice && !wsUp && (
            <View style={[styles.banner, { backgroundColor: theme.warningBg }]}>
              <Ionicons
                name="cloud-offline-outline"
                size={16}
                color={theme.warning}
              />
              <ThemedText
                type="small"
                style={[styles.bannerText, { color: theme.warning }]}
              >
                {t("map.reconnecting")}
              </ThemedText>
            </View>
          )}

          {mapError && (
            <View style={[styles.banner, { backgroundColor: theme.dangerBg }]}>
              <Ionicons
                name="alert-circle-outline"
                size={16}
                color={theme.danger}
              />
              <ThemedText
                type="small"
                style={[styles.bannerText, { color: theme.danger }]}
              >
                {t("map.error", { msg: mapError })}
              </ThemedText>
            </View>
          )}
        </View>

        {/* 设备切换下拉(多设备时点药丸展开) */}
        {pickerOpen && (
          <View
            style={[
              styles.devicePicker,
              {
                top: insets.top + 54,
                backgroundColor: theme.backgroundElement,
                borderColor: theme.border,
              },
            ]}
          >
            {deviceList.map((d) => (
              <Tappable
                key={d.deviceId}
                feedback="fill"
                style={styles.pickerRow}
                onPress={() => {
                  setSelectedId(d.deviceId);
                  setPickerOpen(false);
                  setFollowing(true);
                }}
              >
                <View
                  style={[
                    styles.liveDot,
                    {
                      backgroundColor: d.online
                        ? theme.success
                        : theme.textSecondary,
                    },
                  ]}
                />
                <ThemedText
                  type="smallBold"
                  themeColor={d.deviceId === deviceId ? "brand" : "text"}
                  numberOfLines={1}
                >
                  {d.name ?? d.deviceId}
                </ThemedText>
              </Tappable>
            ))}
          </View>
        )}

        {/* 空状态:成功拉取且无绑定设备——新用户引导去绑定(设备页同款头盔素材) */}
        {devices.isSuccess && deviceList.length === 0 && (
          <View style={styles.emptyWrap}>
            <View
              style={[
                styles.emptyCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                },
              ]}
            >
              <Image
                source={require("@/assets/images/helmet-urban-v5.webp")}
                style={styles.emptyImg}
                contentFit="contain"
              />
              <ThemedText type="subtitle">{t("map.emptyTitle")}</ThemedText>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.emptyText}
              >
                {t("map.emptyBody")}
              </ThemedText>
              <PrimaryButton
                title={t("map.bindNew")}
                icon="add"
                onPress={() => router.push("/bind-device")}
                style={styles.emptyBtn}
              />
            </View>
          </View>
        )}

        {/* 底部组:右侧圆钮栈悬在统计卡上方;无设备不渲染,进入页面时从下方弹入 */}
        {hasDevice && (
          <Animated.View
            pointerEvents="box-none"
            style={{
              opacity: cardIn,
              transform: [
                {
                  translateY: cardIn.interpolate({
                    inputRange: [0, 1],
                    outputRange: [72, 0],
                  }),
                },
              ],
            }}
          >
            <View style={styles.sideStack} pointerEvents="box-none">
              <RoundButton
                icon="locate"
                label={t("map.recenter")}
                onPress={recenter}
                disabled={!sharePos}
              />
              <RoundButton
                icon={following ? "navigate" : "navigate-outline"}
                label={t("map.follow")}
                onPress={toggleFollow}
                tint={following ? theme.brand : undefined}
              />
              <RoundButton
                icon="share-outline"
                label={t("map.share")}
                onPress={shareLocation}
                disabled={!sharePos}
              />
            </View>

            {/* 底部：统计卡（状态行 + 四格数据 + 动作行 + 可展开的回放面板） */}
            <View
              style={[
                styles.bottomCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                },
              ]}
            >
              <Tappable
                feedback="opacity"
                onPress={() => setPanelCollapsed((v) => !v)}
                style={styles.cardHeader}
              >
                <View style={styles.headerLeft}>
                  <View
                    style={[
                      styles.statusChip,
                      {
                        backgroundColor: online
                          ? theme.brand
                          : theme.backgroundSelected,
                      },
                    ]}
                  >
                    <ThemedText
                      type="smallBold"
                      style={[
                        styles.statusChipText,
                        { color: online ? theme.onBrand : theme.textSecondary },
                      ]}
                    >
                      {online ? t("map.riding") : t("map.offline")}
                    </ThemedText>
                  </View>
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    numberOfLines={1}
                    style={styles.caption}
                  >
                    {caption}
                  </ThemedText>
                </View>
                {!online && (
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    style={styles.captionRight}
                  >
                    {t("map.lastSeen", {
                      ago: relativeTime(device.lastSeenAt ?? null, locale),
                    })}
                  </ThemedText>
                )}
                <Ionicons
                  name={panelCollapsed ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={theme.textSecondary}
                />
              </Tappable>

              {!panelCollapsed && (
                <View style={styles.statsRow}>
                  <Stat
                    label={t("map.speed")}
                    value={statPoint ? (statPoint.speed * 3.6).toFixed(0) : "—"}
                    unit="km/h"
                  />
                  <Stat
                    label={t("map.distance")}
                    value={(distanceMeters / 1000).toFixed(1)}
                    unit="km"
                  />
                  <Stat
                    label={t("map.altitude")}
                    value={
                      statPoint?.altitude != null
                        ? statPoint.altitude.toFixed(0)
                        : "—"
                    }
                    unit="m"
                  />
                  <Stat
                    label={t("map.battery")}
                    value={
                      device.battery != null ? String(device.battery) : "—"
                    }
                    unit="%"
                    valueColor={theme.brand}
                  />
                </View>
              )}

              {!panelCollapsed && (
                <View style={styles.actionRow}>
                  <SecondaryButton
                    compact
                    title={t("map.history")}
                    icon="time-outline"
                    onPress={toggleHistory}
                    style={styles.flex1}
                  />
                  <PrimaryButton
                    compact
                    title={t("map.navigate")}
                    icon="navigate"
                    onPress={navigateTo}
                    disabled={!sharePos}
                    style={styles.flex1}
                  />
                </View>
              )}

              {historyOpen && !panelCollapsed && (
                <>
                  <View
                    style={[styles.divider, { backgroundColor: theme.border }]}
                  />

                  <View style={styles.replayHeader}>
                    <ThemedText
                      type="smallBold"
                      themeColor="textSecondary"
                      style={styles.panelTitle}
                    >
                      {t("map.replay")}
                    </ThemedText>
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      style={styles.panelMeta}
                    >
                      {canReplay ? (
                        <>
                          <ThemedText
                            type="small"
                            themeColor="brand"
                            style={styles.panelMeta}
                          >
                            {formatClock(replayElapsedMs)}
                          </ThemedText>
                          {" / "}
                          {formatClock(trackEndMs - trackStartMs)}
                        </>
                      ) : track.isLoading ? (
                        t("map.loadingTrack")
                      ) : (
                        t("map.noTrack")
                      )}
                    </ThemedText>
                  </View>

                  <View style={styles.chipRow}>
                    <Chip
                      label={`${dayLabel(dayOffset, t)} ▾`}
                      active={dayOffset > 0}
                      onPress={() => setDateOpen((v) => !v)}
                    />
                    {RANGE_OPTIONS.map((h) => (
                      <Chip
                        key={h}
                        label={`${h}h`}
                        active={dayOffset === 0 && range === h}
                        disabled={dayOffset > 0}
                        onPress={() => setRange(h)}
                      />
                    ))}
                  </View>

                  {dateOpen && (
                    <View style={styles.chipRow}>
                      {DAY_OFFSETS.map((d) => (
                        <Chip
                          key={d}
                          label={dayLabel(d, t)}
                          active={dayOffset === d}
                          onPress={() => {
                            setDayOffset(d);
                            setDateOpen(false);
                          }}
                        />
                      ))}
                    </View>
                  )}

                  <View style={styles.replayRow}>
                    <Tappable
                      accessibilityRole="button"
                      style={[
                        styles.playBtn,
                        { borderColor: canReplay ? theme.brand : theme.border },
                      ]}
                      onPress={togglePlay}
                      disabled={!canReplay}
                    >
                      <Ionicons
                        name={playing ? "pause" : "play"}
                        size={16}
                        color={canReplay ? theme.brand : theme.textSecondary}
                      />
                    </Tappable>
                    <Tappable
                      accessibilityRole="button"
                      style={[
                        styles.speedBtn,
                        { backgroundColor: theme.backgroundSelected },
                      ]}
                      disabled={!canReplay}
                      onPress={() =>
                        setSpeed((v) => (v === 1 ? 2 : v === 2 ? 4 : 1))
                      }
                    >
                      <ThemedText
                        type="smallBold"
                        style={[
                          styles.chipText,
                          {
                            color:
                              speed > 1 ? theme.brand : theme.textSecondary,
                          },
                        ]}
                      >
                        ×{speed}
                      </ThemedText>
                    </Tappable>
                    <View style={styles.seekColumn}>
                      <SeekBar
                        ratio={replayRatio}
                        accent={theme.brand}
                        trackColor={theme.backgroundSelected}
                        onSeek={(r) => {
                          if (!canReplay) return;
                          setPlaying(false);
                          setReplayIdx(Math.round(r * (gcjPath.length - 1)));
                        }}
                      />
                      <View style={styles.seekLabels}>
                        <ThemedText
                          type="small"
                          themeColor="textSecondary"
                          style={styles.seekLabel}
                        >
                          00:00
                        </ThemedText>
                        <ThemedText
                          type="small"
                          themeColor="textSecondary"
                          style={styles.seekLabel}
                        >
                          {canReplay
                            ? formatClock(trackEndMs - trackStartMs)
                            : "--:--"}
                        </ThemedText>
                      </View>
                    </View>
                    {replayIdx !== null && (
                      <Tappable
                        hitSlop={8}
                        style={styles.exitBtn}
                        onPress={exitReplay}
                      >
                        <ThemedText
                          type="smallBold"
                          themeColor="brand"
                          style={styles.chipText}
                        >
                          {t("map.backToLive")}
                        </ThemedText>
                      </Tappable>
                    )}
                  </View>

                  {track.data?.truncated && (
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      style={styles.note}
                    >
                      {t("map.truncated", {
                        shown: MAX_TRACK_PAGES * TRACK_PAGE_SIZE,
                        total: track.data.total,
                      })}
                    </ThemedText>
                  )}
                </>
              )}
            </View>
          </Animated.View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flex1: { flex: 1 },
  // 绝对定位 + zIndex：浮层明确压在全屏地图之上（双端触摸/渲染层级一致，模拟器已验证）
  overlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "space-between",
    padding: 14,
    zIndex: 10,
  },
  topArea: { alignItems: "flex-start", gap: 8 },
  devicePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingVertical: 9,
    paddingLeft: 12,
    paddingRight: 14,
    maxWidth: "70%",
  },
  pillName: { fontSize: 15, flexShrink: 1 },
  liveDot: { width: 10, height: 10, borderRadius: 5 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: Radius.control,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: "100%",
  },
  bannerText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  devicePicker: {
    position: "absolute",
    left: 14,
    minWidth: 220,
    borderRadius: Radius.card,
    borderWidth: 1,
    paddingVertical: 4,
    overflow: "hidden",
    zIndex: 30,
    elevation: 12,
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 44,
  },
  emptyWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    // 空态压暗底图:无定位时地图停默认视野,瓦片加载的斑驳不该抢戏
    backgroundColor: "rgba(8, 9, 11, 0.86)",
  },
  emptyCard: {
    alignItems: "center",
    gap: 8,
    borderRadius: Radius.card,
    borderWidth: 1,
    paddingHorizontal: 30,
    paddingVertical: 26,
    width: "84%",
  },
  emptyImg: { width: 168, height: 130, marginBottom: 2 },
  emptyText: { textAlign: "center", lineHeight: 19 },
  emptyBtn: { alignSelf: "stretch", marginTop: 10 },
  sideStack: { alignSelf: "flex-end", gap: 10, marginBottom: 12 },
  roundBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 14,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  statusChip: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  statusChipText: { fontSize: 12, lineHeight: 16 },
  caption: { fontSize: 12, lineHeight: 16, flexShrink: 1 },
  captionRight: { fontSize: 12, lineHeight: 16 },
  statsRow: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, gap: 4, minWidth: 0 },
  statLabel: { fontSize: 12, lineHeight: 16 },
  statValueRow: { flexDirection: "row", alignItems: "baseline", gap: 3 },
  statValue: { fontSize: 24, lineHeight: 28, fontWeight: 600, flexShrink: 1 },
  statUnit: { fontSize: 12, lineHeight: 16 },
  actionRow: { flexDirection: "row", gap: 10 },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: "stretch" },
  replayHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  panelTitle: { fontSize: 13 },
  panelMeta: { fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  // 触控最小 32px 高：7px 上下内边距 + 18px 行高
  chip: {
    borderRadius: Radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: "center",
  },
  chipText: { fontSize: 13, lineHeight: 18 },
  replayRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  speedBtn: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    minWidth: 40,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  seekColumn: { flex: 1, gap: 2 },
  seekLabels: { flexDirection: "row", justifyContent: "space-between" },
  seekLabel: { fontSize: 11, lineHeight: 14 },
  exitBtn: { paddingHorizontal: 4, minHeight: 32, justifyContent: "center" },
  note: { fontSize: 12, lineHeight: 16 },
  seekTouch: { flex: 1, height: 28, justifyContent: "center" },
  // 轨道两端内缩点半径：点的可动范围 = 轨道范围，0%/100% 不出界
  seekRail: { marginHorizontal: THUMB_R, justifyContent: "center" },
  seekTrack: { height: 4, borderRadius: 2, overflow: "hidden" },
  seekFill: { height: 4, borderRadius: 2 },
  seekThumb: {
    position: "absolute",
    width: THUMB_R * 2,
    height: THUMB_R * 2,
    borderRadius: THUMB_R,
    marginLeft: -THUMB_R,
    top: "50%",
    marginTop: -THUMB_R,
  },
});
