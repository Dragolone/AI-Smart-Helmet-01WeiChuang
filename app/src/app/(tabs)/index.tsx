// 设备（首页标签，2026-10-07 改版）：
// 标题 + 右上角「+」绑定 → 当前头盔（头盔图外一圈电量环、名字、连接状态）→ 两格摘要（安全 / 今日骑行）
// → 其他设备（连着的排前面）。同时在线多台时，可以在「其他设备」里把另一台设为当前。
// 当前头盔的规则见 services/safety-status.ts 的 currentHelmetOf，安全页的求救关联用同一条。
// 连接状态和「安全」那一格的结论，与安全页是同一套推导（helmetLinkOf / protectionStateOf）。
// 不在这一页的：速度和骑行状态（地图页）、最近上报与设备编号（详情页）。
// 数据：GET /devices（30s 轮询兜底，WS 直写缓存）。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import type { DevicePublic } from "@helmet/shared";

import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { BatteryArc } from "@/components/battery-arc";
import { DeviceGuide } from "@/components/device-guide";
import { EmptyState } from "@/components/empty-state";
import { IntercomMiniBar } from "@/components/intercom-mini-bar";
import { Card, type IconName } from "@/components/list";
import {
  CrossfadeIcon,
  PulseDot,
  TINT_MS,
  ValueTransition,
  listEntering,
  useTintStyle,
} from "@/components/motion";
import { Skeleton } from "@/components/skeleton";
import {
  BATTERY_TOP,
  HELMET_BOX,
  heroSplashOf,
} from "@/components/splash/hero-splash";
import { useSplashHold } from "@/components/splash/bus";
import { prepareGuideHandover } from "@/components/splash/guide-handover";
import {
  SplashAnchor,
  SplashPageMark,
} from "@/components/splash/splash-anchor";
import { SplashArrive } from "@/components/splash/splash-arrive";
import { SwitchHelmetPrompt } from "@/components/switch-helmet-prompt";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { helmetImageFor } from "@/constants/helmet-images";
import { Radius } from "@/constants/theme";
import { useAppActive } from "@/hooks/use-app-active";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { formatRideDuration, useRideToday } from "@/hooks/use-ride-today";
import {
  useCurrentHelmetChoice,
  useHelmetLinks,
  useNotifyPermission,
} from "@/hooks/use-safety";
import { useTheme } from "@/hooks/use-theme";
import { useRefetchOnFocus } from "@/hooks/use-refetch-on-focus";
import { useLocale, useT } from "@/i18n";
import { formatKm, relativeTime } from "@/i18n/format";
import { withAlpha } from "@/services/color";
import {
  OTHER_ROW_HEIGHT,
  TILE_HEIGHT,
  heroRingSize,
  linkPillOf,
  otherDevicesOf,
  safetyTileOf,
  type SafetyTileTone,
} from "@/services/device-home";
import { batteryTierOf } from "@/services/device-view";
import {
  currentHelmetOf,
  helmetNameOf,
  linkLevelOf,
  protectionStateOf,
  type HelmetLink,
} from "@/services/safety-status";
import { useAuthStore } from "@/stores/auth-store";
import { useGuideStore } from "@/stores/guide-store";
import {
  hadHelmetBefore,
  useHelmetHistoryStore,
} from "@/stores/helmet-history-store";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** 标题栏占的高度（含上边距）：算大图光晕能铺多大时要用 */
const HEADER_HEIGHT = 48;
/** 其他设备行里电量条的长度 */
const BATTERY_BAR_W = 44;

/**
 * 大图外的一层光晕：on 时跟着呼吸，off 时淡出。三种状态色各一层常驻，
 * 换色就是一层淡出、一层淡入；断开就全部淡出——都不硬切（负责人 2026-10-15 画板口径）。
 */
function GlowLayer({
  color,
  on,
  breathe,
  size,
  radius,
  alpha,
  mid,
}: {
  color: string;
  on: boolean;
  breathe: SharedValue<number>;
  size: number;
  radius: number;
  alpha: number;
  mid: number;
}) {
  const k = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    k.set(withTiming(on ? 1 : 0, { duration: TINT_MS }));
  }, [on, k]);
  const st = useAnimatedStyle(() => ({ opacity: breathe.get() * k.get() }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.abs,
        {
          left: size / 2 - radius,
          top: size / 2 - radius,
          width: radius * 2,
          height: radius * 2,
          experimental_backgroundImage: `radial-gradient(50% 50% at 50% 50%, ${withAlpha(color, alpha)} 0%, ${withAlpha(color, mid)} 46%, ${withAlpha(color, 0)} 100%)`,
        },
        st,
      ]}
    />
  );
}

/** 当前头盔：头盔图 + 外圈电量环 + 名字 + 连接状态。整块可点，进详情 */
function Hero({
  device,
  link,
  size,
  glowRadius,
}: {
  device: DevicePublic;
  link: HelmetLink;
  size: number;
  /** 光晕半径：不能超出滚动区上沿，否则会被齐齐裁出一条边 */
  glowRadius: number;
}) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const t = useT();
  const pill = linkPillOf(link);
  const battery = device.battery;
  const tier = batteryTierOf(battery);
  const low = tier === "low" || tier === "critical";
  // 连上时环和光晕是绿色，电量 ≤20% 变黄、≤10% 变红；没连上只剩灰色的环（显示的是上次电量），不发光
  const accent = !pill.linked
    ? null
    : tier === "critical"
      ? theme.danger
      : low
        ? theme.warning
        : theme.success;
  const name = helmetNameOf(device);
  const status = t(pill.text);

  // 光晕缓慢呼吸（5 s 一个来回），只在这一页显示着的时候跑。
  // 动的是透明度而不是大小：Android 上持续变 transform 会不停发无障碍「内容变了」事件，
  // 读屏和 uiautomator 都等不到界面静止。从暗往亮走：系统开了「减弱动态效果」时停在最亮。
  const breathe = useSharedValue(1);
  useFocusEffect(
    useCallback(() => {
      breathe.set(0.78);
      breathe.set(
        withRepeat(
          withTiming(1, { duration: 2500, easing: Easing.inOut(Easing.ease) }),
          -1,
          true,
        ),
      );
      return () => {
        cancelAnimation(breathe);
        breathe.set(1);
      };
    }, [breathe]),
  );
  // 光晕的浓度。浅色底上同样的浓度几乎看不出来，最浓的中间那块还被头盔背后的白底盖住，
  // 所以浅色给得更足、往外也退得更慢，环外面才留得下一圈颜色
  const glowAlpha = dark ? 0.32 : 0.34;
  const glowMid = dark ? glowAlpha / 3 : glowAlpha / 2;
  // 头盔图背后的一块柔光底：让深色头盔从近黑的页面底色里分出来
  const spot = dark ? theme.backgroundSelected : theme.backgroundElement;
  const valueColor = !pill.linked
    ? theme.textSecondary
    : low
      ? (accent ?? theme.text)
      : theme.text;
  // 连上 / 断开、电量跨档时颜色过渡而不是硬切；头盔图的明暗同理
  const valueTint = useTintStyle({ color: valueColor });
  const helmetFade = useAnimatedStyle(
    () => ({
      opacity: withTiming(pill.linked ? 1 : 0.45, { duration: TINT_MS }),
    }),
    [pill.linked],
  );
  const pillFg = pill.linked ? theme.success : theme.textSecondary;
  const pillTint = useTintStyle({
    backgroundColor: pill.linked ? theme.successBg : theme.backgroundSelected,
  });
  const pillTextTint = useTintStyle({ color: pillFg });
  // 冷启动的开屏动画会先在屏幕中间画出这块大图的替身、再送到这里（components/splash/landing-device）。
  // 替身照这份描述画，规则和下面是同一套（components/splash/hero-splash）：改了颜色 / 位置 / 文案，两边一起改
  const splash = heroSplashOf({
    device,
    link,
    theme,
    dark,
    t,
    glowRadius,
  });

  return (
    <Tappable
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={t("devices.heroA11y", { name, status })}
      onPress={() => router.navigate(`/device/${device.deviceId}`)}
      style={styles.hero}
    >
      <SplashAnchor
        name="hero"
        data={splash}
        style={{ width: size, height: size }}
      >
        {[theme.success, theme.warning, theme.danger].map((c) => (
          <GlowLayer
            key={c}
            color={c}
            on={accent === c}
            breathe={breathe}
            size={size}
            radius={glowRadius}
            alpha={glowAlpha}
            mid={glowMid}
          />
        ))}
        <View
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: size * 0.08,
              top: size * 0.08,
              width: size * 0.84,
              height: size * 0.84,
              experimental_backgroundImage: `radial-gradient(50% 50% at 50% 50%, ${spot} 0%, ${withAlpha(spot, dark ? 0.6 : 0.7)} 62%, ${withAlpha(spot, 0)} 100%)`,
            },
          ]}
        />
        <BatteryArc
          size={size}
          value={battery}
          color={accent ?? theme.textSecondary}
          track={splash.track}
          tick={theme.borderStrong}
          dimmed={!pill.linked}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              styles.abs,
              {
                // 图占环内 80%、水平居中，整体比环心略高一点（下面要给电量数字让位）
                left: size * HELMET_BOX.left,
                top: size * HELMET_BOX.top,
                width: size * HELMET_BOX.size,
                height: size * HELMET_BOX.size,
              },
              helmetFade,
            ]}
          >
            <Image
              source={helmetImageFor(device.deviceId)}
              contentFit="contain"
              style={styles.fill}
            />
          </Animated.View>
          <View style={[styles.battery, { top: size * BATTERY_TOP }]}>
            <ThemedText
              style={[styles.batteryLabel, { color: splash.labelColor }]}
            >
              {splash.label}
            </ThemedText>
            <ValueTransition value={battery ?? "—"}>
              <Animated.Text style={[styles.batteryValue, valueTint]}>
                {battery ?? "—"}
                {battery !== null && (
                  <Animated.Text style={[styles.batteryUnit, valueTint]}>
                    %
                  </Animated.Text>
                )}
              </Animated.Text>
            </ValueTransition>
          </View>
        </BatteryArc>
      </SplashAnchor>

      <SplashArrive cue="pill" lead={-40} kind="soft" style={styles.heroName}>
        <ThemedText numberOfLines={1} style={styles.heroNameText}>
          {name}
        </ThemedText>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={theme.textSecondary}
        />
      </SplashArrive>

      <SplashAnchor name="heroPill">
        <SplashArrive cue="pill" kind="pop">
          <Animated.View style={[styles.statusPill, pillTint]}>
            <PulseDot size={6} active={pill.searching} color={pillFg} />
            <Animated.Text style={[styles.statusText, pillTextTint]}>
              {status}
            </Animated.Text>
          </Animated.View>
        </SplashArrive>
      </SplashAnchor>
    </Tappable>
  );
}

/** 两格摘要共用的外框：左上图标、右上箭头、下面一行小标题 + 一行结论 */
function SummaryTile({
  icon,
  label,
  tone = "ok",
  accessibilityLabel,
  onPress,
  children,
}: {
  icon: IconName;
  label: string;
  tone?: SafetyTileTone;
  accessibilityLabel: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  // 格子保持中性底，颜色只落在图标圆和图标上（负责人 10-15 口径，和安全页状态卡一致）：
  // 提醒色给「没连上 / 通知关着 / 没有联系人」，红色只给身份不符
  const alert =
    tone === "warn" ? theme.warning : tone === "fault" ? theme.danger : null;
  // 变色是过渡的：底、描边、图标圆各 240 ms，和安全页状态卡同一个节奏
  const tileTint = useTintStyle({
    // 实色：格子背后有大图的光晕，半透明底会透出来
    backgroundColor: theme.backgroundElement,
    borderColor: theme.border,
  });
  const iconTint = useTintStyle({
    backgroundColor: alert ? withAlpha(alert, 0.18) : theme.backgroundSelected,
  });
  return (
    <View style={styles.flex}>
      <Tappable
        feedback="scale"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={styles.tile}
      >
        <Animated.View pointerEvents="none" style={[styles.tileBg, tileTint]} />
        <View style={styles.tileTop}>
          <Animated.View style={[styles.tileIcon, iconTint]}>
            <CrossfadeIcon name={icon} size={18} color={alert ?? theme.text} />
          </Animated.View>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={theme.textSecondary}
          />
        </View>
        <View>
          <ThemedText themeColor="textSecondary" style={styles.tileLabel}>
            {label}
          </ThemedText>
          {children}
        </View>
      </Tappable>
    </View>
  );
}

function SafetyTile({
  link,
  notify,
  contacts,
}: {
  link: HelmetLink;
  notify: ReturnType<typeof useNotifyPermission>;
  contacts: number | null;
}) {
  const theme = useTheme();
  const t = useT();
  const { text, tone } = safetyTileOf(
    protectionStateOf({ link, notify, contacts }),
    link,
  );
  const label = t("safety.title");
  const value = t(text);
  // 描边款（实心圆看着像贴纸）；换档时淡入淡出并弹一下，和安全页核对项一致
  const glyph: { name: IconName; color: string } =
    tone === "ok"
      ? { name: "checkmark-circle-outline", color: theme.success }
      : tone === "warn"
        ? { name: "alert-circle-outline", color: theme.warning }
        : tone === "fault"
          ? { name: "alert-circle-outline", color: theme.danger }
          : {
              name: "ellipsis-horizontal-circle-outline",
              color: theme.textSecondary,
            };
  return (
    <SummaryTile
      icon="shield-outline"
      label={label}
      tone={tone}
      accessibilityLabel={`${label}${t("common.a11ySep")}${value}`}
      onPress={() => router.navigate("/safety")}
    >
      <View style={styles.tileValueRow}>
        <CrossfadeIcon name={glyph.name} size={17} color={glyph.color} pop />
        <ThemedText
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
          style={styles.tileValue}
        >
          {value}
        </ThemedText>
      </View>
    </SummaryTile>
  );
}

function RideTile({ deviceId }: { deviceId: string }) {
  const t = useT();
  const ride = useRideToday(deviceId);
  const label = t("ride.today");
  const dur =
    ride.status === "rode" ? formatRideDuration(ride.movingSeconds) : null;
  const km = ride.status === "rode" ? formatKm(ride.distanceMeters) : null;
  const rest = dur
    ? `km · ${dur.value} ${t(dur.unit === "h" ? "ride.hours" : "ride.minutes")}`
    : ride.status === "none"
      ? t("devices.ride.none")
      : "—";
  return (
    <SummaryTile
      icon="bicycle-outline"
      label={label}
      accessibilityLabel={`${label}${t("common.a11ySep")}${km ? `${km} ${rest}` : rest}`}
      // 直接打开地图页的行程列表（今天在最上面）。带上头盔：地图页此刻看的不一定是这一顶
      onPress={() =>
        router.navigate({ pathname: "/map", params: { deviceId, rides: "1" } })
      }
    >
      <ThemedText
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        themeColor="textSecondary"
        style={styles.tileRest}
      >
        {km && (
          <ThemedText style={styles.tileValue}>
            {km}
            {"  "}
          </ThemedText>
        )}
        {rest}
      </ThemedText>
    </SummaryTile>
  );
}

function OtherRow({
  device,
  link,
  first,
  canSetCurrent,
  onSetCurrent,
}: {
  device: DevicePublic;
  link: HelmetLink;
  first: boolean;
  canSetCurrent: boolean;
  onSetCurrent: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const pill = linkPillOf(link);
  const battery = device.battery;
  const tier = batteryTierOf(battery);
  const bColor =
    tier === "critical"
      ? theme.danger
      : tier === "low"
        ? theme.warning
        : pill.linked
          ? theme.text
          : theme.textSecondary;
  const name = helmetNameOf(device);
  const bText = useTintStyle({ color: bColor });
  // 电量条的长度和颜色都过渡，和大图的电量环一个节奏
  const pct = Math.max(2, Math.min(100, battery ?? 0));
  const bFill = useAnimatedStyle(
    () => ({
      width: withTiming((BATTERY_BAR_W * pct) / 100, {
        duration: 700,
        easing: Easing.out(Easing.cubic),
      }),
      backgroundColor: withTiming(bColor, { duration: TINT_MS }),
    }),
    [pct, bColor],
  );
  return (
    <View
      style={[
        styles.otherRow,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.border,
        },
      ]}
    >
      <Tappable
        feedback="fill"
        accessibilityRole="button"
        onPress={() => router.navigate(`/device/${device.deviceId}`)}
        style={styles.otherMain}
      >
        <View
          style={[styles.thumb, { backgroundColor: theme.backgroundSelected }]}
        >
          <Image
            source={helmetImageFor(device.deviceId)}
            contentFit="contain"
            style={styles.thumbImage}
          />
        </View>
        <View style={styles.otherBody}>
          <ThemedText numberOfLines={1} style={styles.otherName}>
            {name}
          </ThemedText>
          <View style={styles.otherMeta}>
            <View
              style={[
                styles.dot,
                {
                  backgroundColor: pill.linked
                    ? theme.success
                    : theme.textSecondary,
                },
              ]}
            />
            <ThemedText
              themeColor="textSecondary"
              numberOfLines={1}
              style={styles.otherSub}
            >
              {/* 服务端说在线、只是这台手机连不上（手机蓝牙关着 / 没给蓝牙权限）：和大图的药丸一样写「未连接」，
                  不写「离线 · 刚刚」——它此刻正由别的手机带着在线（10-16 iPhone 关蓝牙时见到） */}
              {pill.linked || device.online
                ? t(pill.text)
                : `${t("common.offline")} · ${relativeTime(device.lastSeenAt, locale)}`}
            </ThemedText>
          </View>
        </View>
        <View style={styles.otherBattery}>
          {/* 充电中在数字前加一道闪电（读屏读「充电中」）：原来 100% 充电中和 100% 没充看不出区别（2026-10-15） */}
          <View
            style={styles.otherBatteryValue}
            accessible
            accessibilityLabel={
              device.charging
                ? // 电量没上报（越界值被后端丢掉、充电状态照留）时只读「充电中」：原来读成「充电中 —%」（10-19 夜测）
                  battery !== null
                  ? `${t("devices.charging")} ${battery}%`
                  : t("devices.charging")
                : undefined
            }
          >
            {device.charging === true && (
              <Ionicons name="flash" size={12} color={bColor} />
            )}
            <Animated.Text style={[styles.otherBatteryText, bText]}>
              {battery !== null ? `${battery}%` : "—"}
            </Animated.Text>
          </View>
          <View
            style={[
              styles.batteryTrack,
              { backgroundColor: theme.backgroundSelected },
            ]}
          >
            <Animated.View style={[styles.batteryFill, bFill]} />
          </View>
        </View>
        {!canSetCurrent && (
          <Ionicons
            name="chevron-forward"
            size={18}
            color={theme.textSecondary}
          />
        )}
      </Tappable>
      {canSetCurrent && (
        <Tappable
          feedback="opacity"
          haptic
          accessibilityRole="button"
          accessibilityLabel={t("devices.setCurrentA11y", { name })}
          onPress={onSetCurrent}
          style={styles.setCurrent}
        >
          <View
            style={[styles.setCurrentPill, { borderColor: theme.borderStrong }]}
          >
            <ThemedText style={styles.setCurrentText}>
              {t("devices.setCurrent")}
            </ThemedText>
          </View>
        </Tappable>
      )}
    </View>
  );
}

export default function DevicesScreen() {
  const theme = useTheme();
  const t = useT();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    refetchInterval: 30_000,
  });
  // 重拉途中查询把上一次的错误清掉了：红字按「最近一次失败」写，拿到列表才收（O26）
  // 渲染时就地记下来（不绕一圈 effect）
  const [lastListError, setLastListError] = useState<unknown>(null);
  if (devices.error && devices.error !== lastListError)
    setLastListError(devices.error);
  else if (
    !devices.error &&
    devices.data !== undefined &&
    lastListError !== null
  )
    setLastListError(null);
  const listErrorShown: unknown = devices.isError
    ? devices.error
    : devices.data === undefined
      ? lastListError
      : null;
  // 只由手势驱动：若绑到 isRefetching，后台轮询/回到页面的自动刷新也会拉出转圈，且偶发停在下拉位置不复位
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await devices.refetch();
    } finally {
      setRefreshing(false);
    }
  };
  // 回到设备页时重拉一次设备列表，不等下一次 30 秒轮询：在别处（另一台手机）刚绑上的头盔马上出来，
  // 三步指引接着往下走。10-16 iPhone：新账号登录后弹过「保存密码？」框、切到地图再回来，设备列表的轮询没再跑，
  // 指引在第一件停了一两分钟、要下拉才动（根因没坐实，这里兜住回来那一下）。联系人同理（10-19：别的设备改过）
  useRefetchOnFocus(["devices"]);
  useRefetchOnFocus(["contacts"]);
  const list = devices.data ?? [];
  const links = useHelmetLinks(list, !devices.isError);
  const choice = useCurrentHelmetChoice();
  const hero = currentHelmetOf(list, choice.chosenId);
  const isLinked = (d: DevicePublic) => linkLevelOf(links[d.deviceId]) === "ok";
  const others = hero ? otherDevicesOf(list, hero.deviceId, isLinked) : [];

  // 「安全」那一格与安全页状态卡同源：通知权限 + 联系人数量（同一个 query key，缓存共享）
  const notify = useNotifyPermission();
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
    enabled: hero !== undefined,
    refetchInterval: (q) => (q.state.data === undefined ? 30_000 : false),
  });
  // 没拿到列表（加载中 / 失败）≠ 0 位联系人
  const contactCount = contacts.data ? contacts.data.length : null;

  // 大图按一屏的余量定大小。滚动区高度量到之前不画内容（先是骨架，见 loading）：
  // 先按估的高度画、量到之后再改尺寸，下面的内容会跟着挪；「其他设备」那几行正在做进场动画时一挪，
  // 动画结束就停在旧位置上，被卡片裁掉一截（2026-10-08 模拟器冷启动见到）
  const windowHeight = useWindowDimensions().height;
  const [viewport, setViewport] = useState(0);
  const ringSize = heroRingSize(viewport || windowHeight - 200, others.length);
  // 光晕以大图为圆心，最大铺到大图边长的 1.05 倍；上方留白不够时缩到刚好碰到滚动区上沿
  const [spaceAbove, setSpaceAbove] = useState(4);
  const glowRadius = Math.min(
    ringSize * 1.05,
    HEADER_HEIGHT + spaceAbove + ringSize / 2,
  );

  // 账号下一台头盔都没有（列表拿到了才算，加载中 / 失败不算）：这一页是三步指引，而不是空白。
  // 头盔绑上之后指引接着做后两件，三件都处理完才变成下面的设备页（见 components/device-guide）
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const guideRunning = useGuideStore((s) => s.active && s.userId === userId);
  const guideBindOnly = useGuideStore((s) => s.bindOnly);
  const beginGuide = useGuideStore((s) => s.begin);
  const finishGuide = useGuideStore((s) => s.finish);
  const noHelmet = devices.data !== undefined && list.length === 0;
  // 三步指引只给从没绑过头盔的账号走一遍；绑过又解绑的只给绑定那一张卡。「绑过没有」记在本机：
  // 见到账号下有头盔就记上（stores/helmet-history-store）
  const hydrateHistory = useHelmetHistoryStore((s) => s.hydrate);
  const markHadHelmet = useHelmetHistoryStore((s) => s.markHad);
  const historyReady = useHelmetHistoryStore((s) => s.hydrated);
  const hadBefore = useHelmetHistoryStore((s) =>
    hadHelmetBefore(s.users, userId),
  );
  useEffect(() => {
    void hydrateHistory();
  }, [hydrateHistory]);
  const hasHelmet = list.length > 0;
  useEffect(() => {
    if (userId && hasHelmet) markHadHelmet(userId);
  }, [userId, hasHelmet, markHadHelmet]);
  // 记录还没读出来时先不定走哪一种（读盘只要几毫秒，这时页面还是骨架）
  const guideDue = noHelmet && historyReady;
  const guidePending = noHelmet && !historyReady;
  useEffect(() => {
    if (userId && guideDue) beginGuide(userId, hadBefore);
  }, [userId, guideDue, hadBefore, beginGuide]);
  const guideOn = guideRunning || guideDue;
  // 人是不是正看着这一页：指引自己打勾翻页、收尾变成设备页，只在这时走（见 components/device-guide）
  const focused = useIsFocused();
  const appActive = useAppActive();

  // 「设为当前」的选择还没从存储读出来时先不画大图：否则会先显示一台再跳到另一台。
  // 冷启动的开屏动画还在播路线那一段时也先画骨架，等它放行再搭（见 useSplashHold）
  const splashHold = useSplashHold();
  // 列表失败过之后的重拉（每 30 秒、回前台……）：没有旧数据时查询会回到「加载中」，原来就闪回骨架、红字收起又冒出来
  //（10-21 华为断网冷启动看到闪了一下，O26）。只有第一次加载画骨架；失败过就停在「没拉到」那一页，拿到了再换
  const loading =
    (devices.isLoading && devices.errorUpdateCount === 0) ||
    viewport === 0 ||
    (list.length > 0 && !choice.ready) ||
    guidePending ||
    splashHold;

  return (
    <ThemedView style={styles.flex}>
      <SplashPageMark />
      <SafeAreaView style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
          onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
          refreshControl={
            <RefreshControl
              tintColor={theme.brand}
              colors={[theme.brand]}
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
            />
          }
        >
          <View style={styles.header}>
            <SplashArrive cue="header" from={-14}>
              <ThemedText type="title" style={styles.pageTitle}>
                {t("devices.title")}
              </ThemedText>
            </SplashArrive>
            <SplashArrive cue="header" order={1} from={-14}>
              <Tappable
                feedback="opacity"
                accessibilityRole="button"
                accessibilityLabel={t("devices.bindNew")}
                onPress={() => router.navigate("/bind-device")}
                style={[
                  styles.addButton,
                  {
                    borderColor: theme.borderStrong,
                    backgroundColor: theme.backgroundElement,
                  },
                ]}
              >
                <Ionicons name="add" size={24} color={theme.text} />
              </Tappable>
            </SplashArrive>
          </View>

          {listErrorShown !== null && !isSessionEnded(listErrorShown) && (
            <ThemedText type="small" themeColor="danger">
              {toUserMessage(listErrorShown)}
            </ThemedText>
          )}

          {loading ? (
            <View style={styles.body}>
              <View style={styles.spaceAbove} />
              <View style={styles.hero}>
                <Skeleton width={220} height={220} radius={110} />
                <Skeleton width={140} height={22} style={styles.skeletonName} />
                <Skeleton width={84} height={18} />
              </View>
              <View style={styles.tiles}>
                <View style={styles.flex}>
                  <Skeleton height={TILE_HEIGHT} radius={Radius.card} />
                </View>
                <View style={styles.flex}>
                  <Skeleton height={TILE_HEIGHT} radius={Radius.card} />
                </View>
              </View>
              <View style={styles.spaceBelow} />
            </View>
          ) : guideOn ? (
            <DeviceGuide
              helmet={hero}
              link={hero ? links[hero.deviceId] : undefined}
              notify={notify}
              contacts={contactCount}
              // 指引已经开始了就按开始时定的走；还没开始（这一帧刚拿到列表）按记录
              bindOnly={guideRunning ? guideBindOnly : hadBefore}
              onStage={focused && appActive}
              onFinished={(from) => {
                if (from) prepareGuideHandover(from);
                finishGuide(from);
              }}
            />
          ) : hero ? (
            <View style={styles.body}>
              <View
                style={styles.spaceAbove}
                onLayout={(e) => setSpaceAbove(e.nativeEvent.layout.height)}
              />
              {/* 换了当前头盔时整块淡入，不让图和数字各变各的 */}
              <Animated.View
                key={hero.deviceId}
                entering={FadeIn.duration(220)}
              >
                <Hero
                  device={hero}
                  link={links[hero.deviceId]}
                  size={ringSize}
                  glowRadius={glowRadius}
                />
              </Animated.View>
              {/* 两格摘要紧跟在连接状态下面（负责人 2026-10-08：原先贴在页面底部，和大图之间空了一大截） */}
              <View style={styles.tiles}>
                <SplashArrive order={2.5} style={styles.flex}>
                  <SafetyTile
                    link={links[hero.deviceId]}
                    notify={notify}
                    contacts={contactCount}
                  />
                </SplashArrive>
                <SplashArrive order={3.5} style={styles.flex}>
                  <RideTile deviceId={hero.deviceId} />
                </SplashArrive>
              </View>
              {others.length > 0 && (
                <SplashArrive order={4.5} style={styles.others}>
                  <ThemedText
                    themeColor="textSecondary"
                    style={styles.othersTitle}
                  >
                    {t("devices.otherDevices")}
                  </ThemedText>
                  <Card>
                    {others.map((d, i) => (
                      <Animated.View
                        key={d.deviceId}
                        entering={listEntering(i)}
                      >
                        <OtherRow
                          device={d}
                          link={links[d.deviceId]}
                          first={i === 0}
                          // 只有此刻连着的才能设为当前：没开机的头盔收不到事件，求救不该记到它名下
                          canSetCurrent={d.online && isLinked(d)}
                          onSetCurrent={() => choice.choose(d.deviceId)}
                        />
                      </Animated.View>
                    ))}
                  </Card>
                </SplashArrive>
              )}
              <View style={styles.spaceBelow} />
            </View>
          ) : (
            // 列表没拉到（断网冷启动）≠ 没绑头盔：原来这里也写「尚未绑定头盔」+ 绑定按钮，
            // 绑着两顶的人断网开 App 会以为被解绑了（2026-10-15 模拟器正式包）。
            // 走到这里只剩这一种：拿到了列表却一顶都没有时，要么是三步指引、要么还在读「绑过没有」（画骨架）
            <EmptyState
              icon="cloud-offline-outline"
              title={t("devices.loadFailedTitle")}
              body={t("devices.loadFailedBody")}
            />
          )}
        </ScrollView>

        {/* 人在对讲房间里时占一行（不在时不占位置）：滚动区变矮，大图跟着缩 */}
        <IntercomMiniBar style={styles.miniBar} />
      </SafeAreaView>
      <SwitchHelmetPrompt />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  abs: { position: "absolute" },
  container: { flexGrow: 1, paddingHorizontal: 20, paddingBottom: 16 },
  header: {
    // 不能写死高度：iOS 辅助功能大字号下标题放到 2 倍多，固定 44 的头部装不下，字顶被滚动区上沿切掉（10-22 iPad 模拟器）
    minHeight: HEADER_HEIGHT - 4,
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pageTitle: { fontSize: 32, lineHeight: 40 },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flexGrow: 1 },
  // 一屏放得下时，余下的高度按 3 : 4 分在内容的上面和下面（下面那份在两格摘要 / 其他设备之后）。
  // 两格摘要挪到大图下面之前是 2 : 3；挪上来多占了一段固定间距，改成 3 : 4 大图才留在原来的高度
  spaceAbove: { flex: 3, minHeight: 4 },
  spaceBelow: { flex: 4 },
  hero: { alignItems: "center" },
  battery: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 6,
  },
  batteryLabel: { fontSize: 11, lineHeight: 14, fontWeight: 600 },
  batteryValue: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: 800,
    fontVariant: ["tabular-nums"],
  },
  batteryUnit: { fontSize: 12, lineHeight: 24, fontWeight: 700 },
  // 左边多留的 22 = 右边箭头 18 + 间距 4：名字本身居中
  heroName: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 44,
    marginTop: 2,
    paddingLeft: 32,
    paddingRight: 10,
  },
  heroNameText: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: 700,
    flexShrink: 1,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minHeight: 26,
    paddingVertical: 2,
    paddingLeft: 10,
    paddingRight: 11,
    borderRadius: 13,
  },
  statusText: { fontSize: 13, lineHeight: 18, fontWeight: 600 },
  tiles: { flexDirection: "row", gap: 12, marginTop: 16 },
  tile: {
    height: TILE_HEIGHT,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 14,
    paddingRight: 12,
    borderRadius: Radius.card,
    justifyContent: "space-between",
  },
  // 格子的底和描边单独一层：颜色要过渡，Tappable 自己的样式是按下时给 Pressable 的
  tileBg: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: Radius.card,
    borderWidth: 1,
  },
  tileIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  fill: { width: "100%", height: "100%" },
  tileTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tileLabel: { fontSize: 12, lineHeight: 16, fontWeight: 500 },
  tileValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  tileValue: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: 600,
    flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },
  tileRest: {
    fontSize: 13,
    lineHeight: 20,
    fontWeight: 500,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  others: { marginTop: 16 },
  othersTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: 500,
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  // 行高、药丸高都是「最小」：系统字体放大时名字和状态两行会超过 60，定高时字叠到下一行上
  //（2026-10-15 边界测试，2 倍字体）。1 倍字体下高度不变；放不下时页面本来就会改成滚动
  otherRow: {
    flexDirection: "row",
    minHeight: OTHER_ROW_HEIGHT,
  },
  otherMain: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 10,
    paddingRight: 12,
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: Radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbImage: { width: 38, height: 38 },
  otherBody: { flex: 1, minWidth: 0 },
  otherName: { fontSize: 15, lineHeight: 20, fontWeight: 600 },
  otherMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  otherSub: { fontSize: 13, lineHeight: 18, fontWeight: 500, flexShrink: 1 },
  otherBattery: { alignItems: "flex-end", gap: 4 },
  otherBatteryValue: { flexDirection: "row", alignItems: "center", gap: 2 },
  otherBatteryText: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: 600,
    fontVariant: ["tabular-nums"],
  },
  batteryTrack: {
    width: BATTERY_BAR_W,
    height: 5,
    borderRadius: 3,
    overflow: "hidden",
  },
  batteryFill: { height: 5, borderRadius: 3 },
  setCurrent: { justifyContent: "center", paddingRight: 10 },
  setCurrentPill: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
  },
  setCurrentText: { fontSize: 12, lineHeight: 16, fontWeight: 600 },
  skeletonName: { marginTop: 16, marginBottom: 10 },
  miniBar: { paddingHorizontal: 12, paddingBottom: 12 },
});
