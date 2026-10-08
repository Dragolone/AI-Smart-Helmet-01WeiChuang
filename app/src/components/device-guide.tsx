// 设备页还没绑定头盔时的三步指引：绑定头盔 → 允许通知 → 添加紧急联系人，一张卡一件事。
// 轮到的那张在最前面，后面两张只露出名字；做完一张，它收进下面进度条里对应的一格，后面那张上来。
// 三件都处理完（做了或点了「稍后」）页面变成平常的设备页。逻辑在 services/device-guide（2026-10-08 负责人确认）。
//
// 冷启动、账号下没有头盔时，开屏动画落在这一页上：最前面那张卡从商标的位置立起来，商标落成卡片左上角的
// 徽标，一道光沿卡片的边走到按钮、把按钮点亮（components/splash）。平时进这一页没有这些动作。
import { Ionicons } from "@expo/vector-icons";
import {
  BlurStyle,
  Canvas,
  PaintStyle,
  Picture,
  Skia,
  StrokeCap,
  createPicture,
} from "@shopify/react-native-skia";
import { Image } from "expo-image";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import type { DevicePublic } from "@helmet/shared";

import { useBleOnboardingSteps } from "@/components/ble-onboarding";
import { PulseRing } from "@/components/pulse-ring";
import {
  anchorRect,
  guideFrom,
  splashStory,
  useSplashLanding,
} from "@/components/splash/bus";
import { steady } from "@/components/splash/steady-style";
import { useSteadyId } from "@/components/splash/use-steady-id";
import { glide, spring } from "@/components/splash/landings";
import {
  MARK_LIFT,
  SCENE_W,
  clamp01,
  easeOut,
  lerp,
  smooth,
} from "@/components/splash/route-scene";
import { SplashAnchor } from "@/components/splash/splash-anchor";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { mixHex, withAlpha } from "@/services/color";
import {
  FINISH_MS,
  SEARCH_SLOW_MS,
  TICK_MS,
  guideAutoDone,
  guideCards,
  guideCurrent,
  guideDoneCount,
  guideSegments,
  type GuideAction,
  type GuideCard,
  type GuideFacts,
} from "@/services/device-guide";
import {
  helmetNameOf,
  type HelmetLink,
  type NotifyPermission,
} from "@/services/safety-status";
import { useBleStore } from "@/stores/ble-store";
import { useGuideStore, type GuideHandoverFrom } from "@/stores/guide-store";

/** 最前面那张卡的高；后面两张各往上错开 STEP、两边各收进 INSET */
const CARD_H = 252;
const STEP = 28;
const INSET = 16;
const RADIUS = 26;
const STACK_H = CARD_H + STEP * 2;
/** 卡片和进度之间 */
const GAP = 20;
/** 进度条那一格相对卡片堆顶部的位置：说明一行 18 + 间距 8 */
const SEG_TOP = STACK_H + GAP + 18 + 8;
const SEG_GAP = 8;
const EMBLEM = 36;
/** 卡片内边距（含 1 的描边） */
const PAD = 20;
const MOVE = { duration: 460, easing: Easing.bezier(0.3, 0.9, 0.25, 1) };

/** 变成设备页之前，卡片上的字淡掉用多久 */
const LEAVE_MS = 220;

/** 开屏落在这一页时，各样东西相对「卡片开始立起来」那一刻晚多少出发（毫秒） */
const LAND = {
  stand: 70,
  backs: 520,
  content: 560,
  progress: 920,
  emblem: 760,
  ripple: 800,
  edge: 900,
  ignite: 1340,
};

/** 开屏收尾时原地浮上来的一块内容；没有开屏在播时就是普通容器 */
function Rise({
  at,
  dur = 480,
  dy = 10,
  style,
  children,
}: {
  at: number;
  dur?: number;
  dy?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  // 样式没变时交回同一个对象，免得每帧都往原生推一次更新（见 splash/steady-style.ts）；下面几处同理
  const id = useSteadyId();
  const st = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from < 0)
      return steady(id, { opacity: 1, transform: [{ translateY: 0 }] });
    const p = clamp01((splashStory.get() - from - at) / dur);
    return steady(id, {
      opacity: easeOut(p / 0.7),
      transform: [{ translateY: dy * (1 - spring(p)) }],
    });
  });
  return <Animated.View style={[style, st]}>{children}</Animated.View>;
}

function CardBody({
  card,
  width,
  landing,
  onAction,
}: {
  card: GuideCard;
  width: number;
  /** 开屏正落在这一页：按钮先是暗着的，等那道光走到再亮 */
  landing: boolean;
  onAction: (a: GuideAction) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const chip =
    card.chip.tone === "good"
      ? { bg: theme.successBg, fg: theme.success }
      : card.chip.tone === "amber"
        ? { bg: theme.warningBg, fg: theme.warning }
        : { bg: theme.backgroundSelected, fg: theme.textSecondary };
  const ok = card.status?.tone === "ok";
  const tone = ok ? theme.success : theme.brand;
  // 按钮「没点亮」的样子：品牌色描边、淡淡一层底。盖在点亮的按钮上面，随那道光淡掉
  const unlit = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from < 0) return { opacity: 0 };
    return {
      opacity: 1 - smooth((splashStory.get() - from - LAND.ignite) / 380),
    };
  });
  const pressId = useSteadyId();
  const press = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from < 0) return steady(pressId, { transform: [{ scale: 1 }] });
    return steady(pressId, {
      transform: [
        {
          scale:
            0.94 +
            0.06 *
              spring((splashStory.get() - from - LAND.content - 170) / 520),
        },
      ],
    });
  });
  const icon =
    card.primary?.icon === "scan"
      ? "scan-outline"
      : card.primary?.icon === "bluetooth"
        ? "bluetooth"
        : card.primary?.icon === "bell"
          ? "notifications-outline"
          : "person-add-outline";

  return (
    <View style={[styles.body, { width }]}>
      <View style={styles.row}>
        <View style={styles.emblemSlot} />
        <Rise at={LAND.content}>
          <View style={[styles.chip, { backgroundColor: chip.bg }]}>
            <ThemedText style={[styles.chipText, { color: chip.fg }]}>
              {t(card.chip.text.key, card.chip.text.params)}
            </ThemedText>
          </View>
        </Rise>
      </View>

      {/* 这张卡里换了一种情况（比如从「打开蓝牙」到「打开头盔电源」）时，标题和说明淡入换上来 */}
      <Animated.View
        key={`${card.title}/${card.body.key}`}
        entering={FadeIn.duration(260)}
      >
        <Rise at={LAND.content + 60}>
          <ThemedText numberOfLines={1} style={styles.title}>
            {t(card.title)}
          </ThemedText>
        </Rise>
        <Rise at={LAND.content + 110}>
          <ThemedText
            numberOfLines={1}
            themeColor="textSecondary"
            style={styles.text}
          >
            {t(card.body.key, card.body.params)}
          </ThemedText>
        </Rise>
      </Animated.View>

      <Rise at={LAND.content + 170} style={styles.action}>
        {card.primary ? (
          <Animated.View style={press}>
            <Tappable
              feedback="scale"
              haptic
              accessibilityRole="button"
              accessibilityLabel={t(card.primary.label)}
              onPress={() => card.primary && onAction(card.primary.action)}
              style={[styles.button, { backgroundColor: theme.brand }]}
            >
              <Ionicons name={icon} size={20} color={theme.onBrand} />
              <ThemedText style={[styles.buttonText, { color: theme.onBrand }]}>
                {t(card.primary.label)}
              </ThemedText>
              {landing && (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.button,
                    styles.unlit,
                    {
                      backgroundColor: mixHex(
                        theme.backgroundElement,
                        theme.brand,
                        0.13,
                      ),
                      borderColor: withAlpha(theme.brand, 0.55),
                    },
                    unlit,
                  ]}
                >
                  <Ionicons name={icon} size={20} color={theme.brand} />
                  <ThemedText
                    style={[styles.buttonText, { color: theme.brand }]}
                  >
                    {t(card.primary.label)}
                  </ThemedText>
                </Animated.View>
              )}
            </Tappable>
          </Animated.View>
        ) : card.status ? (
          <Animated.View
            key={card.status.tone}
            entering={FadeIn.duration(220)}
            accessibilityRole="text"
            style={[
              styles.button,
              styles.status,
              {
                backgroundColor: ok
                  ? theme.successBg
                  : withAlpha(theme.brand, 0.13),
                borderColor: withAlpha(tone, ok ? 0.5 : 0.55),
              },
            ]}
          >
            {ok ? (
              <Ionicons name="checkmark" size={18} color={tone} />
            ) : (
              <ActivityIndicator size="small" color={tone} />
            )}
            <ThemedText style={[styles.buttonText, { color: tone }]}>
              {t(card.status.text.key, card.status.text.params)}
            </ThemedText>
          </Animated.View>
        ) : null}
      </Rise>

      <Rise at={LAND.content + 240} style={styles.linkRow}>
        {card.link && (
          <Tappable
            feedback="opacity"
            accessibilityRole="button"
            onPress={() => card.link && onAction(card.link.action)}
            style={styles.link}
          >
            <ThemedText themeColor="textSecondary" style={styles.linkText}>
              {t(card.link.label)}
            </ThemedText>
            <Ionicons
              name="chevron-forward"
              size={14}
              color={theme.textSecondary}
            />
          </Tappable>
        )}
      </Rise>
    </View>
  );
}

/**
 * 一张卡。slot：0 最前面，1 / 2 压在后面，-1 已经处理过（收进进度条里它那一格）。
 * 换位置时位置、大小、圆角一起过渡。
 */
function GuideCardView({
  card,
  slot,
  width,
  landing,
  leaving,
  onAction,
}: {
  card: GuideCard;
  slot: -1 | 0 | 1 | 2;
  width: number;
  landing: boolean;
  /** 0..1：三件都处理完之后，卡片上的字淡掉的程度 */
  leaving: SharedValue<number>;
  onAction: (a: GuideAction) => void;
}) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const t = useT();
  const { height: screenH, width: screenW } = useWindowDimensions();
  const pos = useSharedValue<number>(slot);
  useEffect(() => {
    pos.set(withTiming(slot, MOVE));
  }, [slot, pos]);

  const segW = (width - SEG_GAP * 2) / 3;
  const segX = (card.step - 1) * (segW + SEG_GAP);
  // 开屏里商标的中心在屏幕上的高度：卡片从那里立起来
  const markY = screenH / 2 - MARK_LIFT * (screenW / SCENE_W);

  const frame = useAnimatedStyle(() => {
    const p = pos.get();
    let left = 0;
    let top = STEP * 2;
    let w = width;
    let h = CARD_H;
    let radius = RADIUS;
    let opacity = 1;
    if (p >= 0) {
      const q = Math.min(2, p);
      left = INSET * q;
      top = STEP * (2 - q);
      w = width - INSET * 2 * q;
      h = CARD_H - 2 * Math.min(1, q);
    } else {
      const q = Math.min(1, -p);
      left = lerp(0, segX, q);
      top = lerp(STEP * 2, SEG_TOP, q);
      w = lerp(width, segW, q);
      h = lerp(CARD_H, 6, q);
      radius = lerp(RADIUS, 3, q);
      opacity = 1 - smooth((q - 0.35) / 0.56);
    }
    // 开屏落在这一页时：最前面那张从商标的位置立起来，后面两张稍晚从下面跟上
    const from = guideFrom.get();
    if (from < 0 || p < 0)
      return {
        left,
        top,
        width: w,
        height: h,
        borderRadius: radius,
        opacity,
        transform: [
          { perspective: 900 },
          { translateY: 0 },
          { rotateX: "0deg" },
          { rotate: "0deg" },
          { scale: 1 },
        ],
      };
    const u = splashStory.get() - from;
    if (p < 0.5) {
      const a = anchorRect.guideCard.get();
      const g = glide((u - LAND.stand) / 760);
      const up = easeOut((u - LAND.stand) / 620);
      const dy0 = a ? markY - (a.y + a.h / 2) + 40 : 0;
      return {
        left,
        top,
        width: w,
        height: h,
        borderRadius: radius,
        opacity: opacity * smooth((u - LAND.stand) / 200),
        transform: [
          { perspective: 900 },
          { translateY: lerp(dy0, 0, g) },
          { rotateX: `${62 * (1 - up)}deg` },
          { rotate: "0deg" },
          { scale: lerp(0.56, 1, g) },
        ],
      };
    }
    const k = p < 1.5 ? 0 : 1;
    const q = clamp01((u - LAND.backs - 110 * k) / 620);
    const sp = spring(q);
    return {
      left,
      top,
      width: w,
      height: h,
      borderRadius: radius,
      opacity: opacity * easeOut(q / 0.6),
      transform: [
        { perspective: 900 },
        { translateY: (34 + 26 * k) * (1 - sp) },
        { rotateX: "0deg" },
        { rotate: `${(k ? 3 : -3) * (1 - sp)}deg` },
        { scale: lerp(0.92, 1, easeOut(q)) },
      ],
    };
  });
  // 卡片的底色越往后越淡；卡片上的内容只有在最前面时才显示，压在后面时只露出左上角那一行名字
  const fill = useAnimatedStyle(() => {
    const p = Math.max(0, pos.get());
    return { opacity: p <= 1 ? lerp(1, 0.72, p) : lerp(0.72, 0.42, p - 1) };
  });
  const inner = useAnimatedStyle(() => {
    const p = pos.get();
    return {
      opacity:
        (p >= 0 ? smooth((0.55 - p) / 0.55) : 1 - smooth(-p / 0.35)) *
        (1 - leaving.get()),
    };
  });
  const strip = useAnimatedStyle(() => ({
    opacity: smooth((pos.get() - 0.45) / 0.45),
  }));

  return (
    <Animated.View
      pointerEvents={slot === 0 ? "auto" : "none"}
      style={[
        styles.card,
        {
          borderColor: dark
            ? `rgba(255,255,255,${slot === 0 ? 0.11 : slot === 2 ? 0.05 : 0.08})`
            : theme.border,
          zIndex: slot < 0 ? 5 : 4 - slot,
        },
        slot === 0 && styles.cardFront,
        frame,
      ]}
    >
      <Animated.View
        style={[
          styles.fill,
          dark
            ? styles.cardFillDark
            : { backgroundColor: theme.backgroundElement },
          fill,
        ]}
      />
      <Animated.View style={[styles.strip, strip]}>
        <ThemedText themeColor="textSecondary" style={styles.stripNo}>
          {card.step}
        </ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.stripText}>
          {t(card.strip)}
        </ThemedText>
      </Animated.View>
      <Animated.View style={inner}>
        <CardBody
          card={card}
          width={width - 2}
          landing={landing}
          onAction={onAction}
        />
      </Animated.View>
    </Animated.View>
  );
}

/** 开屏落在这一页时：一道光沿最前面那张卡的边，从徽标走到按钮；按钮被点亮的那一下往外泛一圈光 */
function EdgeLight({ width }: { width: number }) {
  const theme = useTheme();
  const brand = theme.brand;
  const margin = 30;
  const picture = useDerivedValue(() => {
    const from = guideFrom.get();
    const u = from < 0 ? -1 : splashStory.get() - from;
    return createPicture(
      (canvas) => {
        if (u < 0) return;
        const x0 = margin + 0.8;
        const y0 = margin + STEP * 2 + 0.8;
        const w = width - 1.6;
        const h = CARD_H - 1.6;
        const el = clamp01((u - LAND.edge) / 700);
        if (el > 0 && el < 1) {
          const r = RADIUS;
          const pb = Skia.PathBuilder.Make();
          // 从左上角的圆角之后出发，顺时针绕一圈（和设计稿里那条边线同一个走法）
          pb.moveTo(x0 + r, y0);
          pb.lineTo(x0 + w - r, y0);
          pb.cubicTo(
            x0 + w - r * 0.45,
            y0,
            x0 + w,
            y0 + r * 0.45,
            x0 + w,
            y0 + r,
          );
          pb.lineTo(x0 + w, y0 + h - r);
          pb.cubicTo(
            x0 + w,
            y0 + h - r * 0.45,
            x0 + w - r * 0.45,
            y0 + h,
            x0 + w - r,
            y0 + h,
          );
          pb.lineTo(x0 + r, y0 + h);
          pb.cubicTo(
            x0 + r * 0.45,
            y0 + h,
            x0,
            y0 + h - r * 0.45,
            x0,
            y0 + h - r,
          );
          pb.lineTo(x0, y0 + r);
          pb.cubicTo(x0, y0 + r * 0.45, x0 + r * 0.45, y0, x0 + r, y0);
          const path = pb.detach();
          const total = 2 * (w + h) - (8 - 2 * Math.PI) * r;
          // 光头走到全长的 64%，后面拖着最长 15% 的一段
          const head = (lerp(20, 640, smooth(el)) / 1000) * total;
          const tail = Math.min((150 / 1000) * total, head);
          const on = Math.min(1, Math.sin(Math.PI * el) * 1.6);
          const paint = Skia.Paint();
          paint.setAntiAlias(true);
          paint.setStyle(PaintStyle.Stroke);
          paint.setStrokeCap(StrokeCap.Round);
          paint.setPathEffect(
            Skia.PathEffect.MakeDash([tail, total * 2], tail - head),
          );
          const c = Skia.Color(brand);
          paint.setStrokeWidth(5);
          paint.setColor(Float32Array.of(c[0], c[1], c[2], 0.75 * on));
          paint.setMaskFilter(
            Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 4, true),
          );
          canvas.drawPath(path, paint);
          paint.setMaskFilter(null);
          paint.setStrokeWidth(1.8);
          paint.setColor(Float32Array.of(0.914, 1, 0.541, on));
          canvas.drawPath(path, paint);
        }
        // 按钮点亮的那一下
        const ig = clamp01((u - LAND.ignite) / 380);
        if (ig > 0 && ig < 1) {
          const glow = Math.sin(Math.PI * ig);
          const c = Skia.Color(brand);
          const paint = Skia.Paint();
          paint.setAntiAlias(true);
          paint.setColor(Float32Array.of(c[0], c[1], c[2], 0.5 * glow));
          paint.setMaskFilter(
            Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 9 * glow + 1, true),
          );
          const bx = margin + PAD;
          const by = margin + STEP * 2 + PAD + EMBLEM + 16 + 30 + 5 + 19 + 18;
          canvas.drawRRect(
            Skia.RRectXY(Skia.XYWHRect(bx, by, width - PAD * 2, 48), 24, 24),
            paint,
          );
        }
      },
      { width: width + margin * 2, height: STACK_H + margin * 2 },
    );
  });
  return (
    <Canvas
      pointerEvents="none"
      style={[
        styles.edge,
        {
          left: -margin,
          top: -margin,
          width: width + margin * 2,
          height: STACK_H + margin * 2,
        },
      ]}
    >
      <Picture picture={picture} />
    </Canvas>
  );
}

export function DeviceGuide({
  helmet,
  link,
  notify,
  contacts,
  onFinished,
}: {
  /** 已经绑定的那顶（当前头盔）；还没绑定是 undefined */
  helmet: DevicePublic | undefined;
  link: HelmetLink | undefined;
  notify: NotifyPermission | null;
  contacts: number | null;
  /** 三件都处理完了：页面该变成设备页了。带上最前面那张卡和徽标此刻的位置，衔接动画从那里接手 */
  onFinished: (from: GuideHandoverFrom | null) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const state = useGuideStore((s) => s.state);
  const mark = useGuideStore((s) => s.mark);
  const [width, setWidth] = useState(0);
  // 开屏正落在这一页（冷启动、没有头盔）：边上的那道光只在这时才有
  const landing = useSplashLanding() === "unbound";

  const phase = useBleStore((s) =>
    helmet ? s.links[helmet.deviceId]?.phase : undefined,
  );
  // 刚点完「允许通知」：系统弹窗的结果先用上，不等回到前台那次重查
  const [asked, setAsked] = useState<NotifyPermission | null>(null);
  const searching =
    !!helmet &&
    link !== "connected" &&
    link !== "online" &&
    link !== "bluetoothOff" &&
    link !== "bluetoothDenied";
  // 搜了一阵还没找到：换一句更具体的提示
  const [slowFor, setSlowFor] = useState<string | null>(null);
  const helmetId = helmet?.deviceId ?? null;
  useEffect(() => {
    if (!searching || !helmetId) return;
    const id = setTimeout(() => setSlowFor(helmetId), SEARCH_SLOW_MS);
    return () => clearTimeout(id);
  }, [searching, helmetId]);

  const facts: GuideFacts = {
    link: helmet ? (link ?? "unknown") : null,
    phase,
    helmet: helmet
      ? { name: helmetNameOf(helmet), battery: helmet.battery }
      : undefined,
    notify: asked ?? notify,
    contacts,
    slow: searching && slowFor === helmetId,
  };
  const cards = guideCards(facts);
  const cur = guideCurrent(state);
  // 三件都处理完之后、页面变过去之前，最后一张卡还留在前面
  const front = cur === 0 ? 3 : cur;

  // 轮到的那件事已经具备了：打个勾，停一下，翻到下一张
  const auto = guideAutoDone(state, facts);
  useEffect(() => {
    if (!auto) return;
    const id = setTimeout(() => mark(auto, "done"), TICK_MS);
    return () => clearTimeout(id);
  }, [auto, mark]);
  // 三件都处理完：卡片上的字和下面的进度先淡掉，只留下卡片的壳和徽标，然后交给衔接动画
  const leaving = useSharedValue(0);
  const arm = useGuideStore((s) => s.arm);
  useEffect(() => {
    if (cur !== 0) return;
    arm();
    const fade = setTimeout(
      () => leaving.set(withTiming(1, { duration: LEAVE_MS })),
      FINISH_MS - LEAVE_MS,
    );
    const id = setTimeout(() => {
      const card = anchorRect.guideCard.get();
      const emblem = anchorRect.guideEmblem.get();
      onFinished(card && emblem ? { card, emblem } : null);
    }, FINISH_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(id);
    };
  }, [cur, onFinished, leaving, arm]);
  const leave = useAnimatedStyle(() => ({ opacity: 1 - leaving.get() }));

  const ble = useBleOnboardingSteps();
  const act = (a: GuideAction) => {
    // 绑定页是扫码优先的一页（原来的表单页和单独的扫码页已并成它）：
    // 「扫码绑定」直接进取景，「手动输入」进去时面板已经开着
    if (a === "scan") router.navigate("/bind-device");
    else if (a === "manual")
      router.navigate({ pathname: "/bind-device", params: { manual: "1" } });
    else if (a === "openBluetooth")
      ble.find((s) => s.key === "bluetooth")?.action();
    else if (a === "openAppSettings") void Linking.openSettings();
    else if (a === "addContact") router.navigate("/add-contact");
    else if (a === "askNotify")
      void Notifications.requestPermissionsAsync()
        .then((p) => setAsked(p.granted ? "granted" : "denied"))
        .catch(() => undefined);
    else if (cur !== 0) mark(cur, "skipped");
  };

  const segments = guideSegments(state);
  const done = guideDoneCount(state);
  // 徽标落下来的那一下：先大一点再回到原大，同时往外泛一圈
  const emblemPop = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from < 0) return steady("guide.emblem", { transform: [{ scale: 1 }] });
    const u = splashStory.get() - from;
    return steady("guide.emblem", {
      transform: [{ scale: 1 + 0.22 * (1 - spring((u - LAND.emblem) / 520)) }],
    });
  });
  const ripple = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from < 0)
      return steady("guide.ripple", { opacity: 0, transform: [{ scale: 0 }] });
    const p = clamp01((splashStory.get() - from - LAND.ripple) / 620);
    return steady("guide.ripple", {
      opacity: p > 0 && p < 1 ? 0.55 * (1 - p) : 0,
      transform: [{ scale: easeOut(p) }],
    });
  });

  return (
    <LayoutAnimationConfig skipEntering>
      <View
        style={styles.wrap}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        <View style={styles.above} />
        <View style={styles.stack}>
          {/* 最前面那张卡平时所在的位置：开屏要知道卡片从哪里立起来 */}
          <SplashAnchor name="guideCard" style={styles.frontSlot} />
          {width > 0 &&
            cards.map((card) => (
              <GuideCardView
                key={card.step}
                card={card}
                slot={
                  card.step < front ? -1 : ((card.step - front) as 0 | 1 | 2)
                }
                width={width}
                landing={landing}
                leaving={leaving}
                onAction={act}
              />
            ))}
          {width > 0 && landing && <EdgeLight width={width} />}
          {/* 徽标一直在最前面那张卡的左上角。正在找头盔时从它这里一圈圈往外扩 */}
          <View pointerEvents="none" style={styles.emblemAt}>
            <PulseRing
              active={cards[0].ripple && front === 1}
              size={EMBLEM}
              color={withAlpha(theme.brand, 0.8)}
              duration={1700}
              maxScale={170 / EMBLEM}
            />
            <Animated.View
              style={[
                styles.landRipple,
                { borderColor: withAlpha(theme.brand, 0.8) },
                ripple,
              ]}
            />
            <SplashAnchor name="guideEmblem">
              <Animated.View style={emblemPop}>
                <Image
                  source={require("@/assets/images/company-mark-solid.webp")}
                  style={styles.emblem}
                  contentFit="contain"
                  accessible={false}
                />
              </Animated.View>
            </SplashAnchor>
          </View>
        </View>

        <Rise at={LAND.progress} dur={560} dy={16} style={styles.progress}>
          <Animated.View style={leave}>
            <View style={styles.caption}>
              <ThemedText themeColor="textSecondary" style={styles.captionText}>
                {t(done === 3 ? "guide.captionDone" : "guide.caption")}
              </ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.captionText}>
                {done} / 3
              </ThemedText>
            </View>
            <View style={styles.segments}>
              {segments.map((g) => (
                <View key={g.label} style={styles.segment}>
                  <View
                    style={[
                      styles.segBar,
                      {
                        backgroundColor:
                          g.tone === "done"
                            ? theme.success
                            : g.tone === "current"
                              ? withAlpha(theme.brand, 0.5)
                              : g.tone === "skipped"
                                ? "transparent"
                                : theme.backgroundSelected,
                        borderColor:
                          g.tone === "skipped"
                            ? withAlpha(theme.warning, 0.7)
                            : "transparent",
                      },
                    ]}
                  />
                  <ThemedText
                    style={[
                      styles.segLabel,
                      {
                        color:
                          g.tone === "done" || g.tone === "current"
                            ? theme.text
                            : g.tone === "skipped"
                              ? theme.warning
                              : theme.textSecondary,
                      },
                    ]}
                  >
                    {t(g.label)}
                  </ThemedText>
                </View>
              ))}
            </View>
          </Animated.View>
        </Rise>
        <View style={styles.below} />
      </View>
    </LayoutAnimationConfig>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1 },
  // 一屏放得下时，余下的高度按 3 : 4 分在上面和下面：三张卡和进度落在页面中间略偏上
  above: { flex: 3, minHeight: 4 },
  below: { flex: 4 },
  stack: { height: STACK_H },
  frontSlot: {
    position: "absolute",
    left: 0,
    right: 0,
    top: STEP * 2,
    height: CARD_H,
  },
  card: {
    position: "absolute",
    borderWidth: 1,
    overflow: "hidden",
    transformOrigin: "50% 100%",
  },
  cardFront: { boxShadow: "0 18px 40px rgba(0, 0, 0, 0.45)" },
  fill: { ...StyleSheet.absoluteFill },
  cardFillDark: {
    experimental_backgroundImage:
      "linear-gradient(180deg, #1D2024 0%, #141518 100%)",
  },
  strip: {
    position: "absolute",
    left: 18,
    top: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  stripNo: {
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: 700,
    fontVariant: ["tabular-nums"],
  },
  stripText: { fontSize: 12.5, lineHeight: 17, letterSpacing: 0.2 },
  body: { height: CARD_H - 2, paddingTop: 19, paddingHorizontal: 19 },
  row: {
    height: EMBLEM,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  emblemSlot: { width: EMBLEM, height: EMBLEM },
  chip: { height: 24, paddingHorizontal: 10, borderRadius: 12 },
  chipText: { fontSize: 12, lineHeight: 24, fontWeight: 600 },
  title: { marginTop: 16, fontSize: 24, lineHeight: 30, fontWeight: 700 },
  text: { marginTop: 5, fontSize: 13.5, lineHeight: 19 },
  action: { marginTop: 18, height: 48 },
  button: {
    height: 48,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  unlit: { ...StyleSheet.absoluteFill, borderWidth: 1 },
  status: { borderWidth: 1, gap: 9 },
  buttonText: { fontSize: 15, lineHeight: 20, fontWeight: 600 },
  linkRow: { height: 44, marginTop: -2, alignItems: "center" },
  link: {
    height: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  linkText: { fontSize: 13, lineHeight: 18 },
  edge: { position: "absolute", zIndex: 6 },
  emblemAt: {
    position: "absolute",
    left: PAD,
    top: STEP * 2 + PAD,
    width: EMBLEM,
    height: EMBLEM,
    zIndex: 7,
  },
  emblem: { width: EMBLEM, height: EMBLEM },
  landRipple: {
    position: "absolute",
    left: EMBLEM / 2 - 85,
    top: EMBLEM / 2 - 85,
    width: 170,
    height: 170,
    borderRadius: 85,
    borderWidth: 1.5,
  },
  progress: { marginTop: GAP },
  caption: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  captionText: {
    fontSize: 13,
    lineHeight: 18,
    fontVariant: ["tabular-nums"],
  },
  segments: { flexDirection: "row", gap: SEG_GAP, marginTop: 8 },
  segment: { flex: 1 },
  segBar: { height: 6, borderRadius: 3, borderWidth: 1 },
  segLabel: {
    marginTop: 6,
    fontSize: 11,
    lineHeight: 14,
    textAlign: "center",
  },
});
