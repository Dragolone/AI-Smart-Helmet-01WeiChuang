// 地图（底部标签）（决策 #33：WebView + JS API）。只管两件事：现在在哪、骑过哪。
// 2026-10-07 改版（负责人定稿）：历史按「一趟」来组织，取代原来的 1 / 6 / 24 小时和选天——
//   实时：位置、速度、本趟里程、电量；右侧圆钮回到头盔并跟随；底部「行程」和「分享位置」，
//         头盔没连着时主按钮换成「导航到最后位置」；
//   行程：按天分组的列表，一趟一行，按月往前翻（服务器按定位点事后切分，API.md §5）；
//   一趟：地图只画这一趟，带小结、回放，路上的安全事件标在轨迹和进度条上。
// 底部抽屉沿用 2026-09 的做法：贴着标签栏，下滑收起只留第一行，上滑展开。
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Image } from "expo-image";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  AppState,
  BackHandler,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  Easing,
  FadeIn,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  LocationPoint,
  RideSummary,
  WsLocationData,
} from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { realtimeClient } from "@/api/realtime";
import { PrimaryButton, SecondaryButton } from "@/components/form";
import { IntercomMiniBar } from "@/components/intercom-mini-bar";
import {
  AmapView,
  type AmapViewHandle,
  type MapMark,
} from "@/components/map/amap-view";
import {
  isPlausibleFix,
  liveSpeedOf,
  newerFix,
  plausibleSpeed,
  toGcj02,
  type LngLat,
} from "@/components/map/coords";
import { HelmetPicker } from "@/components/map/helmet-picker";
import { openAmapNavigation } from "@/components/map/nav-links";
import { RideCalendar } from "@/components/map/ride-calendar";
import {
  RideList,
  rideTimeRange,
  type RideListStatus,
} from "@/components/map/ride-list";
import {
  RideReplay,
  type ReplayEvent,
  type TrackStatus,
} from "@/components/map/ride-replay";
import { ValueTransition } from "@/components/motion";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useAppActive } from "@/hooks/use-app-active";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { formatRideDuration } from "@/hooks/use-ride-today";
import {
  useRecentRides,
  useRideAt,
  useRideEvents,
  useRideMonth,
  useRidePages,
  useRideTrack,
} from "@/hooks/use-rides";
import { useRefetchOnFocus } from "@/hooks/use-refetch-on-focus";
import { useRouteParams } from "@/hooks/use-route-params";
import { useCurrentHelmetChoice, useHelmetLinks } from "@/hooks/use-safety";
import { useTheme } from "@/hooks/use-theme";
import { translate, useLocale, useT, type MessageKey } from "@/i18n";
import {
  dayTitle,
  formatKm,
  monthTitle,
  relativeTime,
  shortTime,
  timeWithDateIfNotToday,
} from "@/i18n/format";
import { batteryTierOf } from "@/services/device-view";
import {
  dayKeyOf,
  eventNear,
  filterRides,
  groupByDay,
  groupEvents,
  mergeRides,
  momentWindowOf,
  monthOf,
  nearestIndex,
  noonOfDayKey,
  parseMomentParam,
  placeEvents,
  rideAvgKmh,
  rideMaxKmh,
  rideSeconds,
  ridesByDay,
  trackWindowOf,
  type DayStat,
  type MonthCursor,
  type RideFilter,
} from "@/services/rides";
import { currentHelmetOf, helmetNameOf } from "@/services/safety-status";
import { serverNow } from "@/services/server-clock";
import { MOVING_MPS } from "@/services/switch-reminder";
import { useAuthStore } from "@/stores/auth-store";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** 底部抽屉过渡：点按/松手都用 220ms 缓出，不要弹簧的惯性（负责人 2026-09-17：点收起不要有惯性副作用） */
const SHEET_TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };
/** 展开态 maxHeight 取一个够大的值 = 自适应，内容开合永远不会被裁 */
const SHEET_OPEN = 4000;
/** iOS 原生玻璃标签条高度（不含 home 指示条） */
const IOS_TAB_BAR_H = 62;
const CARD_PAD_TOP = 8;
/** 回放步进：每 200ms 前进一个轨迹点（5 秒一个点 ≈ 25 倍速；长行程服务器已抽稀到 1000 点以内） */
const REPLAY_TICK_MS = 200;
const KEEP_AWAKE_TAG = "map-riding";
/** 地图出错后，实时通道连上引起的自动重载至少隔这么久 */
const WS_RELOAD_GAP_MS = 30_000;
const NO_POINTS: readonly LocationPoint[] = [];
const NO_DAY_STATS: ReadonlyMap<string, DayStat> = new Map();

/** 抽屉里在看什么 */
type Stage = "live" | "list" | "ride";
/**
 * 「一趟」那一页的对象：从列表点进来的是一趟行程；从安全事件「在地图上查看该时刻」进来的
 * 只知道一个时刻，它落在哪一趟里要先查（查不到就看那一刻前后各半小时）。
 */
type Detail =
  { kind: "ride"; ride: RideSummary } | { kind: "moment"; atMs: number };

/** 轨迹上标的事件叫什么（与安全记录页同一套叫法） */
const EVENT_NAME: Record<string, MessageKey> = {
  collision_risk: "events.type.collision_risk",
  obstacle_risk: "events.type.obstacle_risk",
  possible_fall: "safety.risk.fall",
  manual_sos: "safety.manualSos",
};

/**
 * 把一趟收进视野时四边让出多少（上、下、左、右）：上面是状态栏和药丸，下面是抽屉。
 * @param sheet 抽屉内容高度 + 底部内边距
 */
const fitPadOf = (
  safeTop: number,
  sheet: number,
): [number, number, number, number] => [
  safeTop + 84,
  CARD_PAD_TOP + sheet + 36,
  52,
  52,
];

/**
 * 「用高德导航过去」的图标：通用的路线指示牌（菱形 + 转弯箭头）。
 * 不用箭头：右侧「跟随」已经是箭头了；也不用带框的上箭头：那是分享。Ionicons 里没有这个形状，取自 MaterialIcons。
 */
function AmapNavIcon({ size, color }: { size: number; color: string }) {
  return <MaterialIcons name="directions" size={size} color={color} />;
}

/** 右侧浮动圆钮：中性底 + 描边 + 白色图标；激活态只染图标色，不填充（品牌填充只留给主按钮） */
function RoundButton({
  icon,
  renderIcon,
  label,
  onPress,
  disabled = false,
  tint,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  /** 图标不在 Ionicons 里时自己画 */
  renderIcon?: (props: { size: number; color: string }) => ReactNode;
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
      {renderIcon
        ? renderIcon({ size: 26, color: tint ?? theme.text })
        : icon && <Ionicons name={icon} size={22} color={tint ?? theme.text} />}
    </Tappable>
  );
}

/** 回放里用红色的事件，和安全记录列表（safety-records 的 tone: danger）同一口径 */
const DANGER_EVENTS = new Set([
  "collision_risk",
  "possible_fall",
  "manual_sos",
]);

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
        numberOfLines={1}
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
            // 一格只容四五个字符：「16:17」这样的长数字缩小字号放下，不截成「16:…」
            adjustsFontSizeToFit
            minimumFontScale={0.7}
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

/** 抽屉右上角的关闭圆钮（行程列表、一趟行程共用）：回到实时位置 */
function CloseButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Tappable
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.closeBtn, { backgroundColor: theme.backgroundSelected }]}
    >
      <Ionicons name="close" size={20} color={theme.text} />
    </Tappable>
  );
}

export default function MapScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const t = useT();
  const locale = useLocale();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  // 这一页此刻有没有人看：标签页不卸载，切走后 focused 才是假；停在地图页锁屏时 focused 还是真，要再看 App 在不在前台
  const appActive = useAppActive();
  const visible = focused && appActive;
  const { height: windowHeight } = useWindowDimensions();
  const mapRef = useRef<AmapViewHandle>(null);
  const queryClient = useQueryClient();
  // Marker 徽章显示本人头像（无头像回落头盔图标）
  const avatarUrl = useAuthStore((s) => s.user?.avatarUrl ?? null);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapErrorRef = useRef<string | null>(null);
  // 高德脚本没拉到 / 初始化失败（断网冷启动进来就是这样）：不会自己好，给一个「重新加载」，
  // 并且回到前台时自动重来一次（人多半是去开了网络）——2026-10-15 模拟器正式包
  const reloadMap = useCallback(() => {
    mapErrorRef.current = null;
    setMapError(null);
    mapRef.current?.reload();
  }, []);
  useEffect(() => {
    if (!mapError) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") reloadMap();
    });
    return () => sub.remove();
  }, [mapError, reloadMap]);

  const [stage, setStage] = useState<Stage>("live");
  const [detail, setDetail] = useState<Detail | null>(null);
  // null = 还没开始回放；数字 = 回放停在 / 走到的轨迹点下标
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);
  // 跟随模式：用户手势拖图即退出，右侧圆钮点一下回到头盔并重新跟随
  const [following, setFollowing] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 行程列表「按日期找」：列表只看某一天 / 某个月。月历开着时记下它正显示哪个月，
  // 以及打开那一刻的「今天」和「这个月」（晚于今天的日子、晚于这个月的月份不能选）
  const [rideFilter, setRideFilter] = useState<RideFilter>({ kind: "all" });
  const [calendar, setCalendar] = useState<{
    month: MonthCursor;
    max: MonthCursor;
    todayKey: string;
  } | null>(null);
  // 在地图上看哪顶头盔：null = 跟着当前头盔走；选了别的才记下来。只影响地图，不改当前头盔
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 骑行面板收纳：收起只留第一行，地图占满（骑行中当仪表盘看时用）
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // 底部抽屉贴着标签栏：下滑收起只留第一行，在第一行上滑展开；
  // 收起高度 = 第一行高（onLayout 量，三种内容各不一样）。
  // 高度动画（不是位移）：位移会让卡身从半透明玻璃标签栏下面透出来；高度收到只剩一行则干净。
  // iOS 卡片向下延伸到屏幕底、内容底部让出标签栏高度，玻璃条浮在卡上 = "连在一起"；Android 内容区不含标签栏。
  // 标签页内 insets.bottom 已含标签条高度（iPhone 17 Pro 实测 83 = 34 home 条 + 49 标签条）
  const cardPadBottom = Platform.OS === "ios" ? 18 + insets.bottom : 18;
  // 抽屉用 maxHeight 而不是 height：展开 = maxHeight 足够大（自适应，内容换了高度随之涨缩，
  // 不会裁在标签栏下、也不会留黑）；收起/拖动时 maxHeight = 具体值裁到只剩第一行。
  const maxH = useSharedValue(SHEET_OPEN);
  const sheetStart = useSharedValue(0);
  const contentH = useSharedValue(0);
  const headerH = useSharedValue(0);
  const collapsedSV = useSharedValue(false);
  // 抽屉内容高度在 JS 这边也留一份（状态，不是共享值）：
  // ① 把一趟的轨迹收进视野时，要让出抽屉盖住的那一块；
  // ② 右侧圆钮要垫高到抽屉上面——这个垫高量原先只读共享值 contentH，2026-10-07 华为真机上见过一次
  //    首次进页面时没跟上（圆钮停在抽屉后面，动一下抽屉才上来）；改成读这份状态，内容高度一变就重算
  const [sheetH, setSheetH] = useState(0);
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
  // 换内容（实时 / 列表 / 一趟）时抽屉一律展开：三种内容的第一行不一样高，收着换会裁歪。
  // 状态在渲染期跟着改（React 官方 "adjusting state" 模式），共享值在 effect 里同步
  const [sheetStage, setSheetStage] = useState(stage);
  if (sheetStage !== stage) {
    setSheetStage(stage);
    if (panelCollapsed) setPanelCollapsed(false);
  }
  useEffect(() => {
    collapsedSV.set(false);
    maxH.set(SHEET_OPEN);
  }, [stage, collapsedSV, maxH]);
  const onContentLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) {
      contentH.set(h);
      if (Math.abs(h - sheetH) > 0.5) setSheetH(h);
    }
  };
  const onHeaderLayout = (e: LayoutChangeEvent) => {
    headerH.set(e.nativeEvent.layout.height);
  };
  // 手势只挂在第一行和数据格上：卡身里的按钮/列表/进度条不会被抽屉手势抢走。
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
  // 展开时：手势只在抓手 + 第一行 + 数据格（按钮行以下不受影响）；
  // 收起时：整张可见的卡（含标签栏上方那段留白）都能上滑展开，不用精确按到第一行
  const sheetPan = makeSheetPan(!panelCollapsed);
  const cardPan = makeSheetPan(panelCollapsed);
  const sheetStyle = useAnimatedStyle(() => ({ maxHeight: maxH.get() }));
  // 右侧圆钮栈骑在抽屉上方：overlay 底部已让出 reserve，再补抽屉高出的部分
  const overlayReserve =
    Platform.OS === "ios" ? insets.bottom + IOS_TAB_BAR_H : 14;
  const liftStyle = useAnimatedStyle(() => {
    const natural = CARD_PAD_TOP + sheetH + cardPadBottom;
    const h = Math.min(maxH.get(), natural);
    return { paddingBottom: Math.max(0, h - overlayReserve) };
  });

  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });
  /** 底部卡进场动画:每次进入地图页(且有设备)从下方弹入;Animated.Value 惰性
   *  useState 持有(React Compiler 禁止渲染期读 ref,平台限制清单口径) */
  const [cardIn] = useState(() => new Animated.Value(0));
  /** WS 加速通道健康度:断线时药丸下方提示「重连中」,野外测试知道数据是否还新鲜 */
  const [wsUp, setWsUp] = useState(true);
  useEffect(() => realtimeClient.subscribeState(setWsUp), []);
  // 地图在看不见时就失败了（这页从启动起就挂着，安卓断网冷启动就是这样），之后网络恢复、切到地图页，
  // 还是红条和黑图：App 没离开过前台，上面回到前台那条不触发。切到这一页时立即重来一次。
  // 错误只从 ref 读、不放进依赖：还没网时重来又失败，不能接着再重来
  useEffect(() => {
    if (focused && mapErrorRef.current) reloadMap();
  }, [focused, reloadMap]);
  // 实时通道连上（等于网络恢复了）也重来，但只在看得见时、且至少隔 30 秒：隧道、弱网里通道反复断连（退避 1 秒起），
  // 每连上一次就整页重载、重拉高德脚本和瓦片，没人看也一样。只限这一条：切到这一页、回到前台、点按钮都有人在等，
  // 立即试，也不占这 30 秒。手机时间往回拨（差为负）时放行
  const wsReloadAt = useRef(0);
  useEffect(() => {
    if (!wsUp || !visible || !mapErrorRef.current) return;
    const now = Date.now();
    const since = now - wsReloadAt.current;
    if (since >= 0 && since < WS_RELOAD_GAP_MS) return;
    wsReloadAt.current = now;
    reloadMap();
  }, [wsUp, visible, reloadMap]);
  const deviceList = useMemo(() => devices.data ?? [], [devices.data]);
  const choice = useCurrentHelmetChoice();
  const current = currentHelmetOf(deviceList, choice.chosenId);
  const device = deviceList.find((d) => d.deviceId === selectedId) ?? current;
  const links = useHelmetLinks(deviceList, !devices.isError);
  const hasDevice = device != null;
  const canPick = deviceList.length > 1;
  const deviceId = device?.deviceId;
  const currentId = current?.deviceId;
  const online = device?.online ?? false;

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

  const resetReplay = () => {
    setPlaying(false);
    setReplayIdx(null);
  };
  const openRides = () => {
    resetReplay();
    setDetail(null);
    setStage("list");
    setFollowing(true);
  };
  /** 回到「全部行程」，月历也收起来 */
  const showAllRides = () => {
    setRideFilter({ kind: "all" });
    setCalendar(null);
  };
  /** 关掉行程，回到实时位置；下次再打开从全部行程看起 */
  const closeRides = () => {
    resetReplay();
    setDetail(null);
    setStage("live");
    setFollowing(true);
    showAllRides();
  };
  const openCalendar = () => {
    const now = new Date();
    setCalendar({
      // 正在看某一天 / 某个月：月历打开就停在那个月
      month: rideFilter.kind === "all" ? monthOf(now) : rideFilter.month,
      max: monthOf(now),
      todayKey: dayKeyOf(now.toISOString()),
    });
  };
  const pickRide = (ride: RideSummary) => {
    // 进行中的那一趟就是「现在」：回到实时看
    if (ride.ongoing) {
      closeRides();
      return;
    }
    resetReplay();
    setDetail({ kind: "ride", ride });
    setStage("ride");
  };
  const pickHelmet = (id: string) => {
    resetReplay();
    setSelectedId(id === currentId ? null : id);
    setDetail(null);
    // 正在看的那一趟是上一顶头盔的：退回这一顶的行程列表
    if (stage === "ride") setStage("list");
    // 选的日期也是照着上一顶头盔的行程选的
    showAllRides();
    setFollowing(true);
    setPickerOpen(false);
  };

  // 路由参数是一次性的外部输入：放到下一 tick 应用（不在 effect 里同步 setState），用完即清，
  // 免得之后在药丸里换了头盔、关了行程，又被换回来、重新打开。
  //   ?deviceId=           设备页带过来的头盔
  //   ?deviceId=&rides=1   设备页「今日骑行」那一格：打开这顶头盔的行程列表
  //   ?deviceId=&at=ISO    安全记录「在地图上查看该时刻」：打开那一刻所在的那一趟，回放停在那一刻
  const params = useRouteParams<{
    deviceId?: string;
    at?: string;
    rides?: string;
  }>();
  useEffect(() => {
    if (!params.deviceId && !params.at && !params.rides) return;
    const target = params.deviceId;
    const atMs = parseMomentParam(params.at);
    const wantRides = !!params.rides;
    const id = setTimeout(() => {
      if (target) setSelectedId(target === currentId ? null : target);
      if (atMs !== null) {
        setPlaying(false);
        setReplayIdx(null);
        setDetail({ kind: "moment", atMs });
        setStage("ride");
      } else if (wantRides) {
        setPlaying(false);
        setReplayIdx(null);
        setDetail(null);
        setStage("list");
        setRideFilter({ kind: "all" });
        setCalendar(null);
      } else if (target) {
        // 只带头盔号（外部链接）：和面板里换头盔（pickHelmet）一样——正在看的那一趟、按日期的筛选都是上一顶的，
        // 退回行程列表、筛选回到全部（10-19 夜测 #281 测出：药丸换了，抽屉还停在上一顶那一趟）
        setPlaying(false);
        setReplayIdx(null);
        setDetail(null);
        setStage((s) => (s === "ride" ? "list" : s));
        setRideFilter({ kind: "all" });
        setCalendar(null);
        setFollowing(true);
      }
      // 已经在这一页、抽屉又收着时再带参数进来：也要展开
      if (atMs !== null || wantRides) {
        collapsedSV.set(false);
        setPanelCollapsed(false);
        maxH.set(SHEET_OPEN);
      }
      router.setParams({
        deviceId: undefined,
        at: undefined,
        rides: undefined,
      });
    }, 0);
    return () => clearTimeout(id);
  }, [params.deviceId, params.at, params.rides, currentId, collapsedSV, maxH]);

  // —— 实时 ——
  // 看不见时第一个点还是要放上地图（见下面头盔 Marker 的 effect）：这顶头盔的点到了没有
  const [fixedId, setFixedId] = useState<string>();
  // WS 推送直写此缓存（use-realtime）；REST 30s 轮询兜底（API.md §11 口径）。
  // 看不见时不轮询，缓存更新也不让这一页重渲染：缓存照写（换头盔提醒读同一份），重新可见那次渲染直接拿到最新的点
  const live = useQuery<WsLocationData | LocationPoint | null>({
    queryKey: ["device-location", deviceId],
    queryFn: async () => {
      const { location } = await devicesApi.latestLocation(deviceId!);
      // 请求在路上时 WS 可能已经推来更新的点：留更新的那个，不把头盔往回拽
      return newerFix(
        queryClient.getQueryData<WsLocationData | LocationPoint | null>([
          "device-location",
          deviceId,
        ]),
        location,
      );
    },
    enabled: !!deviceId,
    refetchInterval: visible ? 30_000 : false,
    notifyOnChangeProps: visible || fixedId !== deviceId ? undefined : [],
  });
  useRefetchOnFocus(["device-location", deviceId]);
  // (0,0) 这类没定位时的占位值按「没有位置」处理：不画头盔、不给导航（2026-10-15 边界测试）
  const liveLoc = live.data && isPlausibleFix(live.data) ? live.data : null;
  const livePos = useMemo(() => (liveLoc ? toGcj02(liveLoc) : null), [liveLoc]);
  if (liveLoc && fixedId !== deviceId) setFixedId(deviceId);

  // 昨天零点以来的行程：第一条若是「进行中」，就是现在这一趟（本趟里程、实时模式下画的那条线）
  const recent = useRecentRides(deviceId, {
    enabled: focused && hasDevice,
    poll: online,
  });
  const currentRide = recent.data?.[0]?.ongoing ? recent.data[0] : null;
  // 定位停住不再来时（隧道、室内），「这个点还算不算此刻」要靠时间推着重算：看着实时页时每 10 秒取一次此刻
  const [clockMs, setClockMs] = useState(() => serverNow());
  const watchingLive = visible && stage === "live" && liveLoc !== null;
  useEffect(() => {
    if (!watchingLive) return;
    const tick = () => setClockMs(serverNow());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [watchingLive]);
  // 最后一个点超过 2 分钟就不再当「此刻的速度」（coords.LIVE_FIX_MAX_AGE_MS）
  const liveSpeed = liveSpeedOf(liveLoc, clockMs);
  // 服务器说这一趟还没结束（路口停着也算），或者此刻就在动（刚出发，服务器那边还没刷新到）
  const riding =
    online && (currentRide !== null || (liveSpeed ?? 0) >= MOVING_MPS);
  const liveTrack = useRideTrack(
    deviceId,
    currentRide ? trackWindowOf(currentRide) : null,
    true,
  );
  const liveTrackPoints = currentRide ? liveTrack.data?.points : undefined;
  // 这条线每 30 秒才向服务器取一次；此刻的位置作为「线头」单独接在末尾（setTrackTip），线头始终连着头盔。
  // 不把线头拼进整条线：那样每来一个定位就要把整条（最多 1000 点）重新注入地图页，长时间开着内存一直涨
  const livePath = useMemo<LngLat[]>(
    () => (liveTrackPoints ?? NO_POINTS).map(toGcj02),
    [liveTrackPoints],
  );

  // 屏幕常亮只在骑行中、且正看着地图页时开：把手机当仪表盘看时不该黑屏，停着的时候不白耗电
  useEffect(() => {
    if (!focused || !riding) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [focused, riding]);

  // —— 行程列表 ——
  const pages = useRidePages(deviceId, device?.createdAt, stage !== "live");
  const days = useMemo(
    () =>
      groupByDay(
        mergeRides([
          // 每 30 秒刷新的那一份排前面：同一趟以它为准（进行中的那趟在往前走，或者已经结束了）
          recent.data ?? [],
          ...(pages.data?.pages.map((p) => p.rides) ?? []),
        ]),
      ),
    [recent.data, pages.data],
  );
  const lastPage = pages.data?.pages[pages.data.pages.length - 1];
  const older = lastPage?.next ?? null;
  const listStatus = !pages.data
    ? pages.isError
      ? "error"
      : "loading"
    : days.length === 0 && older === null
      ? "empty"
      : "ready";

  // —— 按日期找 ——
  // 月历开着看它正显示的那个月；收起后看筛选落在的那个月。两处用的是同一份数据
  const monthCursor = calendar
    ? calendar.month
    : rideFilter.kind === "all"
      ? null
      : rideFilter.month;
  const monthQuery = useRideMonth(deviceId, monthCursor, stage !== "live");
  // 每 30 秒刷新的那一份排前面（同上）；不在这个月里的由下面按月 / 按天筛掉
  const monthRides = useMemo(
    () =>
      monthQuery.data ? mergeRides([recent.data ?? [], monthQuery.data]) : null,
    [recent.data, monthQuery.data],
  );
  const monthStatus = monthQuery.data
    ? "ready"
    : monthQuery.isError
      ? "error"
      : "loading";
  const calendarStats = useMemo(
    () => (calendar ? ridesByDay(monthRides ?? [], calendar.month) : null),
    [calendar, monthRides],
  );
  const filteredDays = useMemo(
    () =>
      rideFilter.kind === "all" || !monthRides
        ? []
        : groupByDay(filterRides(monthRides, rideFilter)),
    [rideFilter, monthRides],
  );
  const filteredStatus: RideListStatus =
    monthStatus !== "ready"
      ? monthStatus
      : filteredDays.length === 0
        ? "empty"
        : "ready";
  // 头盔登记到系统里的那个月：月历最早翻到这里（和「加载更早的行程」翻到头是同一个月）
  const sinceMs = device?.createdAt ? Date.parse(device.createdAt) : Number.NaN;
  const floorMonth: MonthCursor = Number.isNaN(sinceMs)
    ? { year: 2000, month: 0 }
    : monthOf(new Date(sinceMs));
  const filterLabel =
    rideFilter.kind === "day"
      ? dayTitle(noonOfDayKey(rideFilter.dayKey).toISOString(), locale)
      : rideFilter.kind === "month"
        ? monthTitle(rideFilter.month.year, rideFilter.month.month, locale)
        : null;

  // —— 一趟 ——
  // 只知道一个时刻时先查它落在哪一趟里；查到就按那一趟来看
  const momentMs = detail?.kind === "moment" ? detail.atMs : null;
  const rideAtQuery = useRideAt(deviceId, stage === "ride" ? momentMs : null);
  const ride =
    detail?.kind === "ride" ? detail.ride : (rideAtQuery.data ?? null);
  // 查那一刻落在哪一趟失败了：如实说查询失败、给重试。不能悄悄改看那一刻前后各一段——
  // 那等于把「没查到」当成「不在任何一趟里」
  const findFailed =
    momentMs !== null &&
    rideAtQuery.data === undefined &&
    rideAtQuery.isError &&
    !rideAtQuery.isFetching;
  const finding =
    momentMs !== null && rideAtQuery.data === undefined && !findFailed;
  const rideWindow =
    stage !== "ride" || finding || findFailed
      ? null
      : ride
        ? trackWindowOf(ride)
        : momentMs !== null
          ? { ...momentWindowOf(momentMs), clipped: false }
          : null;
  const rideTrack = useRideTrack(deviceId, rideWindow);
  const ridePoints = (rideWindow && rideTrack.data?.points) || NO_POINTS;
  const ridePath = useMemo<LngLat[]>(
    () => ridePoints.map(toGcj02),
    [ridePoints],
  );
  const rideTimes = useMemo(
    () => ridePoints.map((p) => new Date(p.timestamp).getTime()),
    [ridePoints],
  );
  // 已经有轨迹时按轨迹算：后台刷新失败不能把画着的线说成「轨迹加载失败」（与 listStatus 同一写法）
  const trackStatus: TrackStatus = findFailed
    ? "error"
    : !rideWindow
      ? "loading"
      : rideTrack.data
        ? ridePoints.length > 1
          ? "ready"
          : "empty"
        : rideTrack.isError
          ? "error"
          : "loading";
  const canReplay = trackStatus === "ready";
  // 回放控件不可用了、或离开了地图页：停下，计时器不在看不见 / 点不了的地方接着走
  if (playing && (!canReplay || !focused)) setPlaying(false);

  const rideEvents = useRideEvents(deviceId, rideWindow);
  const replayEvents = useMemo<ReplayEvent[]>(() => {
    if (rideTimes.length < 2) return [];
    const items = rideEvents.data?.items ?? [];
    const nameOf = (eventType: string) =>
      translate(EVENT_NAME[eventType] ?? "map.moment.mark", undefined, locale);
    // 从安全记录跳进来的那一刻单独标一处，不和别的并在一起——用户就是来看它的
    const jumped =
      momentMs === null
        ? undefined
        : items.find(
            (e) => Math.abs(new Date(e.timestamp).getTime() - momentMs) < 2000,
          );
    const out: ReplayEvent[] = groupEvents(
      placeEvents(
        items.filter((e) => e !== jumped),
        rideTimes,
      ),
      rideTimes.length,
    ).map((g) => ({
      key: g.first.event.eventId,
      index: g.first.index,
      time: shortTime(g.first.event.timestamp, locale),
      name: nameOf(g.first.event.eventType),
      count: g.count,
      danger: DANGER_EVENTS.has(g.first.event.eventType),
    }));
    if (momentMs !== null) {
      out.push({
        key: "moment",
        index: nearestIndex(rideTimes, momentMs),
        time: shortTime(new Date(momentMs).toISOString(), locale),
        name: jumped
          ? nameOf(jumped.eventType)
          : translate("map.moment.mark", undefined, locale),
        count: 1,
        danger: jumped ? DANGER_EVENTS.has(jumped.eventType) : false,
      });
      out.sort((a, b) => a.index - b.index);
    }
    return out;
  }, [rideEvents.data, rideTimes, momentMs, locale]);
  const moreEvents = Math.max(
    0,
    (rideEvents.data?.total ?? 0) - (rideEvents.data?.items.length ?? 0),
  );
  // 回放走到哪个事件上了：从安全记录跳进来的那一刻优先（它和旁边那一处可能挨得很近）
  const activeEvent =
    replayIdx === null
      ? null
      : (replayEvents.find(
          (e) => e.key === "moment" && e.index === replayIdx,
        ) ??
        eventNear(
          replayEvents.map((e) => ({ event: e, index: e.index, atMs: 0 })),
          replayIdx,
          ridePath.length,
        )?.event ??
        null);

  // 轨迹换了（换了一趟 / 重新加载）：渲染期重置回放状态（React 官方 "adjusting state" 模式）
  const [prevPath, setPrevPath] = useState(ridePath);
  if (prevPath !== ridePath) {
    setPrevPath(ridePath);
    if (replayIdx !== null) setReplayIdx(null);
    if (playing) setPlaying(false);
    // 从安全记录跳进来的：轨迹一到，回放就停在那一刻
    if (momentMs !== null && ridePath.length > 1) {
      setReplayIdx(nearestIndex(rideTimes, momentMs));
    }
  }

  // —— 地图（effect 只同步外部系统） ——
  const showRide = stage === "ride";
  const padTop = insets.top;
  // 收视野要让出抽屉盖住的那一块；抽屉在轨迹到了之后还会变高（事件那一行后到），
  // 变高了就按新的高度再收一次——除非用户已经自己拖过地图
  const fitted = useRef<{ path: LngLat[] | null; moved: boolean }>({
    path: null,
    moved: false,
  });
  // 看一趟和看实时分成两个 effect：实时定位每来一个点 livePath 就变，看历史行程时
  // 若也跟着重跑，没拖过地图就会被一次次重新收视野（用户刚捏合放大就被弹回去）
  useEffect(() => {
    if (!showRide) return;
    const map = mapRef.current;
    if (!map) return;
    if (ridePath.length > 1) {
      const fresh = fitted.current.path !== ridePath;
      if (fresh) fitted.current = { path: ridePath, moved: false };
      if (fresh || !fitted.current.moved) {
        map.setTrack(ridePath, {
          pad: fitPadOf(padTop, sheetH + cardPadBottom),
        });
      }
    } else map.clearTrack();
  }, [showRide, ridePath, padTop, cardPadBottom, sheetH]);
  // 看不见时不往 WebView 推线和点（下面三个 effect 都看 visible）：这页从启动起就一直挂着，头盔 1–5 秒一个定位，
  // 每个都让看不见的地图重画线、panTo，白费 JS 渲染、唤醒和瓦片流量。
  // 重新可见时这几个 effect 因 visible 变化重跑一次，把最新的线、线头、头盔位置补上
  useEffect(() => {
    if (showRide || !visible) return;
    const map = mapRef.current;
    if (!map) return;
    // 实时模式定时刷新这条线：不收视野，镜头归「跟随」管。服务端只有 1 个点时加上线头也能画成一段
    if (livePath.length > 0) map.setTrack(livePath, { fit: false });
    else map.clearTrack();
  }, [showRide, visible, livePath]);
  // 线头：每来一个定位只发这一个点
  useEffect(() => {
    if (!visible) return;
    const map = mapRef.current;
    if (!map) return;
    map.setTrackTip(!showRide && livePath.length > 0 ? livePos : null);
  }, [visible, showRide, livePath.length, livePos]);

  const marks = useMemo<MapMark[]>(() => {
    if (!showRide || ridePath.length < 2) return [];
    return [
      { ...ridePath[0], kind: "start" },
      { ...ridePath[ridePath.length - 1], kind: "end" },
      ...replayEvents.map((e): MapMark => ({
        ...ridePath[e.index],
        kind: "event",
        label: e.count > 1 ? String(Math.min(99, e.count)) : undefined,
        danger: e.danger,
      })),
    ];
  }, [showRide, ridePath, replayEvents]);
  useEffect(() => {
    mapRef.current?.setMarks(marks);
  }, [marks]);

  // 头盔 Marker：看一趟时停在回放的那个点（没开始回放就在起点），不跟镜头——整趟已经在视野里；
  // 其余时候是实时位置，跟不跟镜头看「跟随」
  // 没有可画的位置（实时还没定位、这一趟的轨迹还没到）就收起 Marker：不能停在上一顶头盔 / 上一处
  // 看不见时只放这顶头盔的第一个点：地图页从启动起就在后台加载，第一个点放上去，瓦片提前拉好，
  // 第一次打开时位置已就位，不在用户眼前从默认中心跳过去。之后的点等重新可见时一次补上
  const replayPos = showRide ? ridePath[replayIdx ?? 0] : undefined;
  const placedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible && (showRide || placedFor.current === deviceId)) return;
    const map = mapRef.current;
    if (!map) return;
    if (showRide) {
      if (replayPos) map.setHelmet(replayPos);
      else map.hideHelmet();
    } else if (livePos) {
      map.setHelmet(livePos, { follow: following });
      placedFor.current = deviceId;
    } else map.hideHelmet();
  }, [visible, deviceId, showRide, replayPos, livePos, following]);

  // 离线时 Marker 变灰停波纹，一眼能看出"这不是实时位置"；看一趟时它不是实时位置，也不放波纹
  useEffect(() => {
    mapRef.current?.setHelmetOnline(showRide || online);
    mapRef.current?.setHelmetReplay(showRide);
  }, [showRide, online]);

  // 回放计时器
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setReplayIdx((idx) => {
        const next = (idx ?? 0) + 1;
        if (next >= ridePath.length) {
          setPlaying(false);
          return ridePath.length - 1;
        }
        return next;
      });
    }, REPLAY_TICK_MS / speed);
    return () => clearInterval(timer);
  }, [playing, ridePath.length, speed]);

  const togglePlay = () => {
    if (!canReplay) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    setReplayIdx((idx) =>
      idx === null || idx >= ridePath.length - 1 ? 0 : idx,
    );
    setPlaying(true);
  };
  const seekTo = (index: number) => {
    if (!canReplay) return;
    setPlaying(false);
    setReplayIdx(Math.max(0, Math.min(ridePath.length - 1, index)));
  };

  // Android 返回键：先一层层退回实时（一趟 → 列表 → 实时；月历开着先收月历），到了实时才交还系统
  const calendarOpen = calendar !== null;
  useFocusEffect(
    useCallback(() => {
      if (stage === "live") return;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (stage === "list" && calendarOpen) {
          setCalendar(null);
          return true;
        }
        setPlaying(false);
        setReplayIdx(null);
        setDetail(null);
        setStage(stage === "ride" ? "list" : "live");
        if (stage !== "ride") {
          setFollowing(true);
          setRideFilter({ kind: "all" });
        }
        return true;
      });
      return () => sub.remove();
    }, [stage, calendarOpen]),
  );

  const recenter = () => {
    setFollowing(true);
    if (livePos) mapRef.current?.setCenter(livePos, 15);
  };

  const shareLocation = async () => {
    if (!livePos || !device) return;
    // 高德分享链接吃 GCJ-02；App 端生成（API.md §5：不做服务端短链）
    const name = helmetNameOf(device);
    const url = `https://uri.amap.com/marker?position=${livePos.longitude.toFixed(6)},${livePos.latitude.toFixed(6)}&name=${encodeURIComponent(name)}`;
    await Share.share({
      message: translate("map.shareMessage", { name, url }),
    });
  };

  const navigateTo = async () => {
    if (!livePos || !device) return;
    await openAmapNavigation(livePos, helmetNameOf(device));
  };

  const dotColor = !wsUp
    ? theme.warning
    : online
      ? theme.success
      : theme.textSecondary;
  const caption = !liveLoc
    ? t("map.waiting")
    : online
      ? t("map.updatedAgo", { ago: relativeTime(liveLoc.timestamp, locale) })
      : t("map.lastPosition", {
          ago: relativeTime(liveLoc.timestamp, locale),
        });
  const chip = riding
    ? { text: t("map.riding"), bg: theme.brand, fg: theme.onBrand }
    : {
        text: t(online ? "map.still" : "common.offline"),
        bg: theme.backgroundSelected,
        fg: theme.textSecondary,
      };

  // 一趟的小结：从列表带过来的（轨迹没取到也不受影响）；只知道一个时刻、又不在任何一趟里时，
  // 用那前后半小时的轨迹统计
  const momentSummary =
    !ride && momentMs !== null && rideWindow ? rideTrack.data?.summary : null;
  const summary: Pick<
    RideSummary,
    "startAt" | "endAt" | "distanceMeters" | "maxSpeed"
  > | null =
    ride ??
    (momentSummary?.firstAt && momentSummary.lastAt
      ? {
          startAt: momentSummary.firstAt,
          endAt: momentSummary.lastAt,
          distanceMeters: momentSummary.distanceMeters,
          maxSpeed: momentSummary.maxSpeed,
        }
      : null);
  const duration = summary ? formatRideDuration(rideSeconds(summary)) : null;
  const avgKmh = ride ? rideAvgKmh(ride) : null;
  // 最高不小于平均（O25）：只看一个时刻时没有平均，照头盔报的写
  const maxKmh = ride
    ? rideMaxKmh(ride)
    : plausibleSpeed(summary?.maxSpeed) !== null
      ? plausibleSpeed(summary?.maxSpeed)! * 3.6
      : null;
  const rideTitle = ride
    ? `${dayTitle(ride.startAt, locale)} ${rideTimeRange(ride, locale, t)}`
    : momentMs !== null
      ? t("map.moment.title", {
          when: timeWithDateIfNotToday(
            new Date(momentMs).toISOString(),
            locale,
          ),
        })
      : "";
  const replayNote = finding
    ? t("map.moment.finding")
    : !ride && momentMs !== null && trackStatus === "empty"
      ? t("map.moment.none")
      : null;

  // 行程列表的可见高度：约占屏幕一半多一点，上面留出地图和药丸
  const listHeight = Math.round(
    Math.min(520, Math.max(260, windowHeight * 0.52)),
  );

  const devicePillBody = (
    <>
      <View style={[styles.liveDot, { backgroundColor: dotColor }]} />
      {/* 放不下时截中间：默认名都是「helmet_」开头，区分得出是哪一顶的是后几位（10-17 英文下截成「helme…」） */}
      <ThemedText
        type="smallBold"
        numberOfLines={1}
        ellipsizeMode="middle"
        style={styles.pillName}
      >
        {device ? helmetNameOf(device) : ""}
      </ThemedText>
      {canPick && (
        <>
          {deviceId === currentId && (
            <View
              style={[
                styles.pillTag,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <ThemedText themeColor="textSecondary" style={styles.pillTagText}>
                {t("map.pill.current")}
              </ThemedText>
            </View>
          )}
          <ThemedText themeColor="textSecondary" style={styles.pillAction}>
            {t("map.pill.switch")}
          </ThemedText>
          <Ionicons name="chevron-down" size={16} color={theme.textSecondary} />
        </>
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
        onUserPan={() => {
          // 看一趟时拖地图是在看轨迹，不动「跟随」；记下来，之后不再替用户收视野
          if (showRide) fitted.current.moved = true;
          else setFollowing(false);
        }}
        // 捏合 / 双击缩放：看一趟时同拖动（不再替用户收视野）；看实时位置时只是放大看，不退出跟随
        onUserZoom={() => {
          if (showRide) fitted.current.moved = true;
        }}
        onError={(msg) => {
          mapErrorRef.current = msg;
          setMapError(msg);
        }}
        // 地图（重）就绪时重推当前状态：WebView 重挂载/进程重启后 effect 依赖未变不会重发
        onReady={() => {
          const map = mapRef.current;
          if (!map) return;
          if (showRide) {
            if (ridePath.length > 1) {
              map.setTrack(ridePath, {
                pad: fitPadOf(padTop, sheetH + cardPadBottom),
              });
            }
            if (replayPos) map.setHelmet(replayPos);
            else map.hideHelmet();
          } else {
            if (livePath.length > 0) {
              map.setTrack(livePath, { fit: false });
              map.setTrackTip(livePos);
            }
            if (livePos) map.setHelmet(livePos, { follow: true });
            else map.hideHelmet();
          }
          map.setMarks(marks);
          map.setHelmetOnline(showRide || online);
          map.setHelmetReplay(showRide);
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
        {/* 顶部：设备药丸（有两顶以上可点开换一台看）+ 断线/地图异常横幅 + 「对讲中」小条 */}
        <View style={styles.topArea} pointerEvents="box-none">
          {hasDevice &&
            (canPick ? (
              <Tappable
                feedback="scale"
                accessibilityRole="button"
                accessibilityLabel={t("map.pill.a11y", {
                  name: helmetNameOf(device),
                })}
                onPress={() => setPickerOpen(true)}
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
              <Tappable
                feedback="opacity"
                accessibilityRole="button"
                accessibilityLabel={t("map.errorRetry")}
                onPress={reloadMap}
                style={styles.bannerAction}
              >
                <ThemedText
                  type="smallBold"
                  style={[styles.bannerActionText, { color: theme.danger }]}
                >
                  {t("map.errorRetry")}
                </ThemedText>
              </Tappable>
            </View>
          )}

          <IntercomMiniBar style={styles.miniBar} />
        </View>

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
                source={require("@/assets/images/helmet-aero-v1.webp")}
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
                onPress={() => router.navigate("/bind-device")}
                style={styles.emptyBtn}
              />
            </View>
          </View>
        )}

        {/* 右侧圆钮栈悬在抽屉上方，只在看实时位置时有；无设备不渲染，进入页面时从下方弹入 */}
        {hasDevice && stage === "live" && (
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
                {/* 底部主按钮没占用的那个动作放这里：连着时主按钮是分享，这里是导航；没连着时反过来 */}
                {online ? (
                  <RoundButton
                    renderIcon={AmapNavIcon}
                    label={t("map.navigate")}
                    onPress={navigateTo}
                    disabled={!livePos}
                  />
                ) : (
                  <RoundButton
                    icon="share-outline"
                    label={t("map.shareLast")}
                    onPress={shareLocation}
                    disabled={!livePos}
                  />
                )}
                <RoundButton
                  icon={following ? "navigate" : "navigate-outline"}
                  label={t(following ? "map.following" : "map.followBack")}
                  onPress={recenter}
                  disabled={!livePos}
                  tint={following ? theme.brand : undefined}
                />
              </View>
            </Reanimated.View>
          </Animated.View>
        )}
      </View>

      {/* 底部抽屉：贴着标签栏，绝对定位在屏幕底；下滑收起只留第一行、在第一行上滑展开。
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
              {/* 裁切盒在底部内边距之上：收起时只露第一行，玻璃标签条下不再透出后面的内容 */}
              <View style={styles.cardClip}>
                <View style={styles.cardContent} onLayout={onContentLayout}>
                  {/* 手势区 = 抓手 + 第一行 + 数据格（无按钮的区域都能拖），以下不响应抽屉手势 */}
                  <GestureDetector gesture={sheetPan}>
                    <View style={styles.gripZone}>
                      <View style={styles.gripHead} onLayout={onHeaderLayout}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={t(
                            panelCollapsed
                              ? "map.sheet.expand"
                              : "map.sheet.collapse",
                          )}
                          accessibilityState={{ expanded: !panelCollapsed }}
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

                        {stage === "live" && (
                          <Tappable
                            feedback="opacity"
                            onPress={() => snapSheet(!panelCollapsed)}
                            style={styles.cardHeader}
                          >
                            <View
                              style={[
                                styles.statusChip,
                                { backgroundColor: chip.bg },
                              ]}
                            >
                              <ThemedText
                                type="smallBold"
                                style={[
                                  styles.statusChipText,
                                  { color: chip.fg },
                                ]}
                              >
                                {chip.text}
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
                          </Tappable>
                        )}

                        {stage === "list" && !calendar && (
                          <View style={styles.sheetHead}>
                            <ThemedText
                              type="smallBold"
                              accessibilityRole="header"
                              style={styles.sheetTitle}
                            >
                              {t("map.rides.title")}
                            </ThemedText>
                            <View style={styles.headTools}>
                              {/* 按日期找：没选时是「选日期」，选了之后写着在看哪一天 / 哪个月，再点可以换 */}
                              <Tappable
                                feedback="opacity"
                                accessibilityRole="button"
                                accessibilityLabel={
                                  filterLabel
                                    ? t("map.rides.filteredA11y", {
                                        label: filterLabel,
                                      })
                                    : t("map.rides.pickDateA11y")
                                }
                                onPress={openCalendar}
                                style={[
                                  styles.datePill,
                                  {
                                    backgroundColor: filterLabel
                                      ? theme.brand
                                      : theme.backgroundSelected,
                                  },
                                ]}
                              >
                                <Ionicons
                                  name="calendar-outline"
                                  size={16}
                                  color={
                                    filterLabel ? theme.onBrand : theme.text
                                  }
                                />
                                <ThemedText
                                  type="smallBold"
                                  numberOfLines={1}
                                  style={[
                                    styles.datePillText,
                                    {
                                      color: filterLabel
                                        ? theme.onBrand
                                        : theme.text,
                                    },
                                  ]}
                                >
                                  {filterLabel ?? t("map.rides.pickDate")}
                                </ThemedText>
                              </Tappable>
                              <CloseButton
                                label={t("map.rides.close")}
                                onPress={closeRides}
                              />
                            </View>
                          </View>
                        )}

                        {stage === "list" && calendar && (
                          <View style={styles.sheetHead}>
                            <Tappable
                              feedback="opacity"
                              accessibilityRole="button"
                              accessibilityLabel={t("map.ride.back")}
                              onPress={() => setCalendar(null)}
                              style={styles.backBtn}
                            >
                              <Ionicons
                                name="chevron-back"
                                size={20}
                                color={theme.text}
                              />
                              <ThemedText
                                type="smallBold"
                                style={styles.backText}
                              >
                                {t("map.rides.title")}
                              </ThemedText>
                            </Tappable>
                            <ThemedText
                              type="smallBold"
                              numberOfLines={1}
                              accessibilityRole="header"
                              style={styles.rideTitle}
                            >
                              {t("map.rides.calendarTitle")}
                            </ThemedText>
                            <CloseButton
                              label={t("map.rides.close")}
                              onPress={closeRides}
                            />
                          </View>
                        )}

                        {stage === "ride" && (
                          <View style={styles.sheetHead}>
                            <Tappable
                              feedback="opacity"
                              accessibilityRole="button"
                              accessibilityLabel={t("map.ride.back")}
                              onPress={openRides}
                              style={styles.backBtn}
                            >
                              <Ionicons
                                name="chevron-back"
                                size={20}
                                color={theme.text}
                              />
                              <ThemedText
                                type="smallBold"
                                style={styles.backText}
                              >
                                {t("map.rides.title")}
                              </ThemedText>
                            </Tappable>
                            {/* 最多两行：英文的「Yesterday 01:00 – 00:59 next day」一行放不下，原来截成「…ne…」
                                （10-15 iPhone）；两行仍在 44 高的头部里 */}
                            <ThemedText
                              type="smallBold"
                              numberOfLines={2}
                              accessibilityRole="header"
                              style={styles.rideTitle}
                            >
                              {rideTitle}
                            </ThemedText>
                            <CloseButton
                              label={t("map.rides.close")}
                              onPress={closeRides}
                            />
                          </View>
                        )}
                      </View>

                      {stage === "live" && (
                        <View style={styles.statsRow}>
                          <Stat
                            label={t("map.speed")}
                            value={
                              online && liveSpeed !== null
                                ? (liveSpeed * 3.6).toFixed(0)
                                : "—"
                            }
                            unit="km/h"
                          />
                          <Stat
                            label={t("map.rideDistance")}
                            value={
                              !online
                                ? "—"
                                : currentRide
                                  ? formatKm(currentRide.distanceMeters)
                                  : recent.isSuccess
                                    ? "0.0"
                                    : "—"
                            }
                            unit="km"
                          />
                          <Stat
                            label={t("map.altitude")}
                            value={
                              online && liveLoc?.altitude != null
                                ? liveLoc.altitude.toFixed(0)
                                : "—"
                            }
                            unit="m"
                          />
                          <Stat
                            label={t(
                              online ? "map.battery" : "map.batteryLast",
                            )}
                            value={
                              device.battery != null
                                ? String(device.battery)
                                : "—"
                            }
                            unit="%"
                            // 正常电量用正文色：品牌黄写在浅色面板上对比度只有 1.46:1（10-31）；低电量才提醒
                            valueColor={
                              !online
                                ? theme.textSecondary
                                : batteryTierOf(device.battery) === "critical"
                                  ? theme.danger
                                  : batteryTierOf(device.battery) === "low"
                                    ? theme.warning
                                    : undefined
                            }
                          />
                        </View>
                      )}

                      {stage === "ride" && (
                        <View style={styles.statsRow}>
                          <Stat
                            label={t("map.distance")}
                            value={
                              summary ? formatKm(summary.distanceMeters) : "—"
                            }
                            unit="km"
                          />
                          <Stat
                            label={t("map.ride.duration")}
                            value={duration ? duration.value : "—"}
                            unit={t(
                              duration?.unit === "h"
                                ? "ride.hours"
                                : "ride.minutes",
                            )}
                          />
                          <Stat
                            label={t("map.ride.max")}
                            value={maxKmh !== null ? maxKmh.toFixed(0) : "—"}
                            unit="km/h"
                          />
                          <Stat
                            label={t("map.ride.avg")}
                            value={avgKmh !== null ? avgKmh.toFixed(0) : "—"}
                            unit="km/h"
                          />
                        </View>
                      )}
                    </View>
                  </GestureDetector>

                  {stage === "live" && (
                    <Reanimated.View
                      entering={FadeIn.duration(180)}
                      style={styles.actionRow}
                    >
                      <SecondaryButton
                        compact
                        title={t("map.rides.title")}
                        icon="trail-sign-outline"
                        onPress={openRides}
                        style={styles.flex1}
                      />
                      {online ? (
                        <SecondaryButton
                          compact
                          title={t("map.share")}
                          icon="share-outline"
                          onPress={shareLocation}
                          disabled={!livePos}
                          style={styles.flex1}
                        />
                      ) : (
                        <PrimaryButton
                          compact
                          title={t("map.navigateLast")}
                          renderIcon={AmapNavIcon}
                          onPress={navigateTo}
                          disabled={!livePos}
                          style={styles.flex1}
                        />
                      )}
                    </Reanimated.View>
                  )}

                  {stage === "list" && calendar && (
                    <Reanimated.View entering={FadeIn.duration(180)}>
                      <RideCalendar
                        height={listHeight}
                        month={calendar.month}
                        min={floorMonth}
                        max={calendar.max}
                        todayKey={calendar.todayKey}
                        status={monthStatus}
                        stats={calendarStats ?? NO_DAY_STATS}
                        selectedDayKey={
                          rideFilter.kind === "day" ? rideFilter.dayKey : null
                        }
                        filtered={rideFilter.kind !== "all"}
                        onMonth={(month) => setCalendar({ ...calendar, month })}
                        onPickDay={(dayKey) => {
                          setRideFilter({
                            kind: "day",
                            month: calendar.month,
                            dayKey,
                          });
                          setCalendar(null);
                        }}
                        onPickMonth={() => {
                          setRideFilter({
                            kind: "month",
                            month: calendar.month,
                          });
                          setCalendar(null);
                        }}
                        onShowAll={showAllRides}
                        onRetry={() => void monthQuery.refetch()}
                      />
                    </Reanimated.View>
                  )}

                  {stage === "list" && !calendar && (
                    <Reanimated.View
                      // 换了筛选整块重新淡入：列表里的内容全换了
                      key={
                        rideFilter.kind === "all"
                          ? "all"
                          : rideFilter.kind === "day"
                            ? rideFilter.dayKey
                            : `${rideFilter.month.year}-${rideFilter.month.month}`
                      }
                      entering={FadeIn.duration(180)}
                    >
                      {rideFilter.kind === "all" ? (
                        <RideList
                          height={listHeight}
                          status={listStatus}
                          days={days}
                          onRetry={() => void pages.refetch()}
                          onPick={pickRide}
                          older={older}
                          loadingOlder={pages.isFetchingNextPage}
                          olderFailed={pages.isFetchNextPageError}
                          onLoadOlder={() => void pages.fetchNextPage()}
                        />
                      ) : (
                        <RideList
                          height={listHeight}
                          status={filteredStatus}
                          days={filteredDays}
                          onRetry={() => void monthQuery.refetch()}
                          onPick={pickRide}
                          older={null}
                          loadingOlder={false}
                          olderFailed={false}
                          onLoadOlder={showAllRides}
                          onShowAll={showAllRides}
                        />
                      )}
                    </Reanimated.View>
                  )}

                  {stage === "ride" && (
                    <Reanimated.View entering={FadeIn.duration(180)}>
                      <RideReplay
                        status={trackStatus}
                        points={ridePoints}
                        clipped={rideWindow?.clipped ?? false}
                        events={replayEvents}
                        moreEvents={moreEvents}
                        eventsFailed={rideEvents.isError}
                        activeEventKey={activeEvent?.key ?? null}
                        replayIdx={replayIdx}
                        playing={playing}
                        speed={speed}
                        note={replayNote}
                        failText={
                          findFailed ? t("map.moment.findFailed") : null
                        }
                        onTogglePlay={togglePlay}
                        onCycleSpeed={() =>
                          setSpeed((v) => (v === 1 ? 2 : v === 2 ? 4 : 1))
                        }
                        onSeek={seekTo}
                        onRetry={() => {
                          // 连这一刻在哪一趟都没查到：先重查它，查到了轨迹和事件自然跟着取
                          if (findFailed) {
                            void rideAtQuery.refetch();
                            return;
                          }
                          void rideTrack.refetch();
                          if (rideEvents.isError) void rideEvents.refetch();
                        }}
                        onRetryEvents={() => void rideEvents.refetch()}
                      />
                    </Reanimated.View>
                  )}
                </View>
              </View>
            </Reanimated.View>
          </GestureDetector>
        </Animated.View>
      )}

      <HelmetPicker
        visible={pickerOpen && canPick}
        devices={deviceList}
        links={links}
        viewedId={deviceId}
        currentId={currentId}
        onPick={pickHelmet}
        onClose={() => setPickerOpen(false)}
      />
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
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingVertical: 9,
    paddingLeft: 12,
    paddingRight: 12,
    maxWidth: "86%",
  },
  pillName: { fontSize: 15, flexShrink: 1 },
  pillTag: {
    height: 20,
    paddingHorizontal: 7,
    borderRadius: 10,
    justifyContent: "center",
  },
  pillTagText: { fontSize: 11, lineHeight: 14, fontWeight: 700 },
  pillAction: { fontSize: 13, lineHeight: 18 },
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
  bannerAction: { paddingHorizontal: 6, paddingVertical: 2, marginLeft: 2 },
  bannerActionText: { fontSize: 13, lineHeight: 18 },
  miniBar: { alignSelf: "stretch" },
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
    width: 48,
    height: 48,
    borderRadius: 24,
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
    gap: 8,
    minHeight: 32,
  },
  statusChip: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusChipText: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 13, lineHeight: 18, flex: 1, minWidth: 0 },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 44,
  },
  sheetTitle: { fontSize: 20, lineHeight: 26 },
  headTools: { flexDirection: "row", alignItems: "center", gap: 8 },
  datePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    maxWidth: 190,
    paddingHorizontal: 12,
    borderRadius: 18,
  },
  datePillText: { fontSize: 14, lineHeight: 20, flexShrink: 1 },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    height: 44,
    marginLeft: -6,
    paddingRight: 8,
  },
  backText: { fontSize: 15, lineHeight: 20 },
  rideTitle: {
    flex: 1,
    minWidth: 0,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 20,
    fontVariant: ["tabular-nums"],
  },
  statsRow: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, gap: 4, minWidth: 0 },
  statLabel: { fontSize: 12, lineHeight: 16 },
  statValueRow: { flexDirection: "row", alignItems: "baseline", gap: 3 },
  statValue: { fontSize: 24, lineHeight: 28, fontWeight: 600, flexShrink: 1 },
  statUnit: { fontSize: 12, lineHeight: 16 },
  actionRow: { flexDirection: "row", gap: 10 },
});
