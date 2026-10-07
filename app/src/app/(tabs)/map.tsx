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
  Pressable,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LocationPoint, WsLocationData } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { realtimeClient } from "@/api/realtime";
import { PrimaryButton, SecondaryButton } from "@/components/form";
import { AmapView, type AmapViewHandle } from "@/components/map/amap-view";
import { useAuthStore } from "@/stores/auth-store";
import {
  cumulativeMeters,
  toGcj02,
  type LngLat,
} from "@/components/map/coords";
import { openAmapNavigation } from "@/components/map/nav-links";
import { AnimatedChip, ValueTransition } from "@/components/motion";
import { PulseDot } from "@/components/motion";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { translate, useLocale, useT } from "@/i18n";
import { formatKm, relativeTime } from "@/i18n/format";

const RANGE_OPTIONS = [1, 6, 24] as const;
/** 底部抽屉过渡：点按/松手都用 220ms 缓出，不要弹簧的惯性（负责人 2026-09-17：点收起不要有惯性副作用） */
const SHEET_TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };
/** 展开态 maxHeight 取一个够大的值 = 自适应，内容开合永远不会被裁 */
const SHEET_OPEN = 4000;
/** iOS 原生玻璃标签条高度（不含 home 指示条） */
const IOS_TAB_BAR_H = 62;
const CARD_PAD_TOP = 8;
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
    <AnimatedChip
      label={label}
      active={active}
      disabled={disabled}
      onPress={onPress}
      style={styles.chip}
      textStyle={styles.chipText}
      activeBg={theme.brand}
      inactiveBg={theme.backgroundSelected}
      activeFg={theme.onBrand}
      inactiveFg={theme.textSecondary}
    />
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
        <ValueTransition value={value}>
          <ThemedText
            type="display"
            style={[styles.statValue, { color: valueColor ?? theme.text }]}
            numberOfLines={1}
          >
            {value}
          </ThemedText>
        </ValueTransition>
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
  // Marker 徽章显示本人头像（无头像回落头盔图标）
  const avatarUrl = useAuthStore((s) => s.user?.avatarUrl ?? null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeHours>(1);
  const [dayOffset, setDayOffset] = useState(0);
  const [dateOpen, setDateOpen] = useState(false);
  // 回放面板默认收起，点「历史轨迹」展开
  const [historyOpen, setHistoryOpen] = useState(false);
  // 骑行面板收纳：收起只留状态行，地图占满（骑行中当仪表盘看时用）
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // 底部统计卡 = 贴着标签栏的抽屉：下滑收起只留状态行，在状态行上滑展开；
  // 收起位移 = 卡高 − 状态行高（都用 onLayout 量，回放面板展开时卡高变了照样对）
  // 高度动画（不是位移）：位移会让卡身从半透明玻璃标签栏下面透出来；高度收到只剩状态行则干净。
  // iOS 卡片向下延伸到屏幕底、内容底部让出标签栏高度，玻璃条浮在卡上 = "连在一起"；Android 内容区不含标签栏。
  // 标签页内 insets.bottom 已含标签条高度（iPhone 17 Pro 实测 83 = 34 home 条 + 49 标签条）：
  // 内容底部让出 insets.bottom；卡片再向下延伸 62（overlay 原本给玻璃条留的浮空距离）到屏幕底
  const cardPadBottom = Platform.OS === "ios" ? 18 + insets.bottom : 18;
  // 抽屉用 maxHeight 而不是 height：展开 = maxHeight 足够大（自适应，历史轨迹开合随内容涨缩，
  // 不会裁在标签栏下、也不会留黑）；收起/拖动时 maxHeight = 具体值裁到只剩状态行。
  const maxH = useSharedValue(SHEET_OPEN);
  const sheetStart = useSharedValue(0);
  const contentH = useSharedValue(0);
  const headerH = useSharedValue(0);
  const collapsedSV = useSharedValue(false);
  const expandedH = () => CARD_PAD_TOP + contentH.get() + cardPadBottom;
  const collapsedH = () => CARD_PAD_TOP + headerH.get() + cardPadBottom;
  const snapSheet = (collapsed: boolean) => {
    collapsedSV.set(collapsed);
    setPanelCollapsed(collapsed);
    if (collapsed) {
      if (maxH.get() >= SHEET_OPEN) maxH.set(expandedH());
      maxH.set(withTiming(collapsedH(), SHEET_TIMING));
    } else {
      maxH.set(
        withTiming(expandedH(), SHEET_TIMING, () => {
          "worklet";
          // 到位后放开上限交还自适应；若途中又被收起（collapsedSV 已翻），什么都不做
          if (!collapsedSV.get()) maxH.set(SHEET_OPEN);
        }),
      );
    }
  };
  const onContentLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) contentH.set(h);
  };
  const onHeaderLayout = (e: LayoutChangeEvent) => {
    headerH.set(e.nativeEvent.layout.height);
  };
  // 手势只挂在状态行上：卡身里的按钮/拖杆不会被抽屉手势抢走（快速点击历史轨迹误触）。
  // 回调跑在 UI 线程（worklet）：只能用共享值和常量
  const makeSheetPan = (enabled: boolean) =>
    Gesture.Pan()
      .enabled(enabled)
      .activeOffsetY([-6, 6])
      .failOffsetX([-12, 12])
      .onStart(() => {
        const hi = CARD_PAD_TOP + contentH.get() + cardPadBottom;
        const cur = maxH.get() >= SHEET_OPEN ? hi : maxH.get();
        maxH.set(cur);
        sheetStart.set(cur);
      })
      .onUpdate((e) => {
        const lo = CARD_PAD_TOP + headerH.get() + cardPadBottom;
        const hi = CARD_PAD_TOP + contentH.get() + cardPadBottom;
        maxH.set(Math.min(hi, Math.max(lo, sheetStart.get() - e.translationY)));
      })
      .onEnd((e) => {
        const lo = CARD_PAD_TOP + headerH.get() + cardPadBottom;
        const hi = CARD_PAD_TOP + contentH.get() + cardPadBottom;
        const collapse =
          e.velocityY > 400 ||
          (e.velocityY > -400 && maxH.get() < (lo + hi) / 2);
        runOnJS(snapSheet)(collapse);
      });
  // 展开时：手势只在抓手 + 状态行 + 四格数据（按钮行不受影响）；
  // 收起时：整张可见的卡（含标签栏上方那段留白）都能上滑展开，不用精确按到状态行
  const sheetPan = makeSheetPan(!panelCollapsed);
  const cardPan = makeSheetPan(panelCollapsed);
  const sheetStyle = useAnimatedStyle(() => ({ maxHeight: maxH.get() }));
  // 右侧圆钮栈骑在抽屉上方：overlay 底部已让出 reserve，再补抽屉高出的部分
  const overlayReserve =
    Platform.OS === "ios" ? insets.bottom + IOS_TAB_BAR_H : 14;
  const liftStyle = useAnimatedStyle(() => {
    const natural = CARD_PAD_TOP + contentH.get() + cardPadBottom;
    const h = Math.min(maxH.get(), natural);
    return { paddingBottom: Math.max(0, h - overlayReserve) };
  });
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
      collapsedSV.set(false);
      setPanelCollapsed(false);
      maxH.set(SHEET_OPEN);
      setJumpAt(at);
      // 用完即清，避免下次进页面重复跳
      router.setParams({ at: undefined, deviceId: undefined });
    }, 0);
    return () => clearTimeout(id);
  }, [params.at, params.deviceId, collapsedSV, maxH]);

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
    // 打开回放面板时抽屉必须是展开的，否则面板长在看不见的地方
    if (collapsedSV.get()) snapSheet(false);
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
  // 离线时 Marker 变灰停波纹，一眼能看出"这不是实时位置"
  useEffect(() => {
    mapRef.current?.setHelmetOnline(online);
  }, [online]);
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
        avatarUrl={avatarUrl}
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
          mapRef.current?.setHelmetOnline(online);
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
            <Reanimated.View style={liftStyle} pointerEvents="box-none">
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
            </Reanimated.View>
          </Animated.View>
        )}
      </View>

      {/* 底部抽屉：贴着标签栏，绝对定位在屏幕底；下滑收起只留状态行、状态行上滑展开。
          iOS 卡身延伸到玻璃标签条下面（内容底部让出 insets.bottom），Android 内容区不含标签条 */}
      {hasDevice && (
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.sheetWrap,
            {
              opacity: cardIn,
              transform: [
                {
                  translateY: cardIn.interpolate({
                    inputRange: [0, 1],
                    outputRange: [72, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <GestureDetector gesture={cardPan}>
            <Reanimated.View
              style={[
                styles.bottomCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                  paddingBottom: cardPadBottom,
                },
                sheetStyle,
              ]}
            >
              {/* 裁切盒在底部内边距之上：收起时只露状态行，玻璃标签条下不再透出后面的内容 */}
              <View style={styles.cardClip}>
                <View style={styles.cardContent} onLayout={onContentLayout}>
                  {/* 手势区 = 抓手 + 状态行 + 四格数据（无按钮的区域都能拖），按钮行以下不响应抽屉手势 */}
                  <GestureDetector gesture={sheetPan}>
                    <View style={styles.gripZone}>
                      <View style={styles.gripHead} onLayout={onHeaderLayout}>
                        <Pressable
                          onPress={() => snapSheet(!panelCollapsed)}
                          hitSlop={{ top: 14, bottom: 6, left: 80, right: 80 }}
                          style={styles.grabberWrap}
                        >
                          <View
                            style={[
                              styles.grabber,
                              { backgroundColor: theme.border },
                            ]}
                          />
                        </Pressable>
                        <Tappable
                          feedback="opacity"
                          onPress={() => snapSheet(!panelCollapsed)}
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
                                  {
                                    color: online
                                      ? theme.onBrand
                                      : theme.textSecondary,
                                  },
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
                                ago: relativeTime(
                                  device.lastSeenAt ?? null,
                                  locale,
                                ),
                              })}
                            </ThemedText>
                          )}
                        </Tappable>
                      </View>

                      {
                        <View style={styles.statsRow}>
                          <Stat
                            label={t("map.speed")}
                            value={
                              statPoint
                                ? (statPoint.speed * 3.6).toFixed(0)
                                : "—"
                            }
                            unit="km/h"
                          />
                          <Stat
                            label={t("map.distance")}
                            value={formatKm(distanceMeters)}
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
                              device.battery != null
                                ? String(device.battery)
                                : "—"
                            }
                            unit="%"
                            valueColor={theme.brand}
                          />
                        </View>
                      }
                    </View>
                  </GestureDetector>

                  {
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
                  }

                  {historyOpen && (
                    <>
                      <View
                        style={[
                          styles.divider,
                          { backgroundColor: theme.border },
                        ]}
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
                        {/* 实时/回放状态放在这一行最右（负责人 2026-09-26 定的样式）：
                            不占进度条那一行的位置；实时 = 绿色呼吸点·实时，回放 = 红色「回到实时」可点 */}
                        {replayIdx !== null ? (
                          <Tappable
                            hitSlop={8}
                            accessibilityRole="button"
                            style={[
                              styles.liveSlot,
                              styles.backToLive,
                              {
                                backgroundColor: theme.dangerBg,
                                borderColor: theme.danger,
                              },
                            ]}
                            onPress={exitReplay}
                          >
                            <ThemedText
                              type="smallBold"
                              themeColor="danger"
                              style={styles.chipText}
                            >
                              {t("map.backToLive")}
                            </ThemedText>
                          </Tappable>
                        ) : (
                          <View style={styles.liveSlot}>
                            <PulseDot color={theme.success} size={7} active />
                            <ThemedText
                              type="small"
                              themeColor="textSecondary"
                              style={styles.chipText}
                            >
                              {t("map.liveNow")}
                            </ThemedText>
                          </View>
                        )}
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
                          accessibilityLabel={t(
                            playing ? "map.pause" : "map.play",
                          )}
                          style={[
                            styles.playBtn,
                            {
                              borderColor: canReplay
                                ? theme.brand
                                : theme.border,
                            },
                          ]}
                          onPress={togglePlay}
                          disabled={!canReplay}
                        >
                          <Ionicons
                            name={playing ? "pause" : "play"}
                            size={16}
                            color={
                              canReplay ? theme.brand : theme.textSecondary
                            }
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
                              setReplayIdx(
                                Math.round(r * (gcjPath.length - 1)),
                              );
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
              </View>
            </Reanimated.View>
          </GestureDetector>
        </Animated.View>
      )}
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
  sheetWrap: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 11,
  },
  bottomCard: {
    // 贴标签栏：满宽、底边不圆角不描边；高度由抽屉控制，超出裁掉
    borderTopLeftRadius: Radius.card,
    borderTopRightRadius: Radius.card,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: CARD_PAD_TOP,
    paddingHorizontal: 16,
  },
  cardClip: { overflow: "hidden", flexShrink: 1, minHeight: 0 },
  cardContent: { gap: 14 },
  gripZone: { gap: 14 },
  gripHead: { gap: 6 },
  grabberWrap: { alignItems: "center", paddingVertical: 2 },
  grabber: { width: 38, height: 5, borderRadius: 3 },
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
  // 「回到实时」要像个按钮：红边 + 淡红底的药丸，用户一眼知道能点（负责人 2026-09-26）
  backToLive: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
  },
  liveSlot: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 28,
    paddingHorizontal: 4,
  },
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
