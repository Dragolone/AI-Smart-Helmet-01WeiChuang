// 设备页还没绑定头盔时的三步指引：绑定头盔 → 允许通知 → 添加紧急联系人，一件一件来。
// 一张卡走到底（改版原型「设备页 · 未绑定：一张卡走到底」，负责人 2026-10-08 定稿）：卡片不换，只换卡片上
// 写的内容；徽标一直在这张卡的左上角；后面压着的是还没做的事，轮到谁谁就并进前面这张，做完一件少一张。
// 一件事做完：勾是画出来的（先一圈、再把勾钩上），然后一道光沿卡片的边走回徽标、徽标应一下，下一件的
// 内容浮上来，光再从徽标出去、停在按钮下面，把按钮点亮。点了「稍后」的不画勾，光也不往回走。
// 三件都处理完（做了或点了「稍后」）页面变成平常的设备页。逻辑在 services/device-guide（2026-10-08 负责人确认）。
// 绑过头盔又解绑的账号只有绑定那一张（bindOnly），没有后两张和进度条，绑上就变成设备页。
//
// 这一页上会动的东西只动位移、缩放、透明度。改位置、宽高这类属性每一帧都要把卡片里的字和按钮重新排一遍
// ——上一版是三张卡轮换，换位置时位置、大小、圆角一起改（负责人 2026-10-08：「卡片切换动画太不流畅」）。
//
// 自己打勾换下一件、收尾变成设备页，都只在人看着这一页的时候走（onStage）：切到别的标签页、进了别的页面、
// App 退到后台都先停着，回来再继续——否则人在别的页面时这里已经走完，衔接动画会盖在那个页面上
// （负责人 2026-10-08：「绑定了后切到其他界面，衔接动画还在跑、穿模」）。
//
// 冷启动、账号下没有头盔时，开屏动画落在这一页上：最前面那张卡从商标的位置立起来，商标落成卡片左上角的
// 徽标，一道光沿卡片的边走到按钮、把按钮点亮（components/splash）。平时换下一件时出去的那道光和它是同一道。
import { Ionicons } from "@expo/vector-icons";
import {
  BlurStyle,
  Canvas,
  Group,
  PaintStyle,
  Path,
  Picture,
  Skia,
  StrokeCap,
  createPicture,
  type SkPicture,
} from "@shopify/react-native-skia";
import { Image } from "expo-image";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import type { DevicePublic } from "@helmet/shared";

import { useBleOnboardingSteps } from "@/components/ble-onboarding";
import { PulseRing } from "@/components/pulse-ring";
import { anchorRect, guideFrom, splashStory } from "@/components/splash/bus";
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
  guideAutoDone,
  bodyPhase,
  guideBeat,
  guideCards,
  guideCurrent,
  guideDoneCount,
  guideSegments,
  guideTickMs,
  type GuideAction,
  type GuideCard,
  type GuideFacts,
  type GuideSegment,
} from "@/services/device-guide";
import {
  helmetNameOf,
  type HelmetLink,
  type NotifyPermission,
} from "@/services/safety-status";
import { useBleStore } from "@/stores/ble-store";
import { useGuideStore, type GuideHandoverFrom } from "@/stores/guide-store";

/** 最前面那张卡的高；后面压着的两张各往上错开 STEP、两边各收进 INSET */
const CARD_H = 252;
const STEP = 28;
const INSET = 16;
const RADIUS = 26;
const STACK_H = CARD_H + STEP * 2;
/** 卡片和进度之间 */
const GAP = 20;
const SEG_GAP = 8;
const EMBLEM = 36;
/** 卡片内边距（含 1 的描边） */
const PAD = 20;
/** 后面压着的卡往前挪一位，或者并进最前面那张 */
const MOVE = { duration: 420, easing: Easing.bezier(0.3, 0.9, 0.25, 1) };

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

/** 一件事处理完、换到下一件的那一段（毫秒，从处理完那一刻算起；数字照原型） */
const BEAT = {
  /** 这件事的内容往上淡走 */
  leave: 220,
  /** 做完的：光从按钮下面沿卡片的边走回徽标，走多久 */
  home: 400,
  /** 光到了，徽标应一下：放大再回来，同时往外泛一圈 */
  answer: 340,
  /** 下一件事的四行内容（标签、标题和说明、按钮、链接）依次浮上来 */
  rise: [340, 400, 470, 540],
  /** 下一件还要人去做：光再从徽标出去，停在按钮下面。[从什么时候, 走多久] */
  out: [640, 560],
  /** 光到了，按钮被点亮 */
  ignite: 1100,
  /** 新内容基本到位：已经具备的那件事从这时才开始画勾，不然勾画的时候按钮那一行还没出来 */
  settled: 700,
  end: 1700,
} as const;

/** 画勾（毫秒，从开始画那一刻算起）：先一圈，再把勾钩上；勾落下时顿一下，那一行亮一下。[从什么时候, 多久] */
const TICK = {
  ring: [60, 440],
  stroke: [460, 320],
  pop: [740, 300],
  glow: [700, 620],
  end: 1320,
} as const;

/** 换到下一件那一段用的几个共享值：放在一起往下传 */
type Motion = {
  /** 这一段走到哪了（毫秒）；平时停在 BEAT.end */
  beat: SharedValue<number>;
  /** 这一段里正在让位 / 正在上来的是第几件；0 = 没有 */
  past: SharedValue<number>;
  enter: SharedValue<number>;
  /** 1 = 上一件是做完的：光走回徽标 */
  home: SharedValue<number>;
  /** 1 = 下一件还要人去做：光再出去点亮按钮 */
  out: SharedValue<number>;
};

/** 上一件事处理完到现在，下一件的内容还差多久到位（毫秒）；到位之后才开始画勾。只在副作用里用 */
function untilSettled(): number {
  const since = Date.now() - useGuideStore.getState().markedAt;
  return since < BEAT.settled ? BEAT.settled - since : 0;
}

/** 先起后落：p 走到 peak 时最大 */
function bump(v: number, peak: number): number {
  "worklet";
  const p = clamp01(v);
  return p < peak ? smooth(p / peak) : 1 - smooth((p - peak) / (1 - peak));
}

/** 卡片上的一行内容属于第几件事、这件事现在是轮到的还是刚让位的、它是第几行（越大浮上来得越晚） */
type RowOf = {
  motion: Motion;
  step: number;
  role: "cur" | "past";
  order: 0 | 1 | 2 | 3;
};

/**
 * 一块会自己进场的内容。开屏落在这一页时原地浮上来；写了 of 的（卡片上的一行）还有两种时候会动：
 * 这件事处理完了，往上淡走；轮到这件事了，从下面浮上来。其余时候就是普通容器。
 */
function Row({
  of,
  at,
  dur = 480,
  dy = 10,
  style,
  children,
}: {
  of?: RowOf;
  /** 开屏落位时晚多少出发 */
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
    if (from >= 0) {
      const p = clamp01((splashStory.get() - from - at) / dur);
      return steady(id, {
        opacity: easeOut(p / 0.7),
        transform: [{ translateY: dy * (1 - spring(p)) }],
      });
    }
    if (of) {
      const b = of.motion.beat.get();
      const phase = bodyPhase(
        of.role,
        of.step,
        of.motion.past.get(),
        of.motion.enter.get(),
      );
      if (phase === "leave") {
        const q = clamp01(b / BEAT.leave);
        return steady(id, {
          opacity: 1 - smooth(b / 180),
          transform: [{ translateY: -10 * q * q }],
        });
      }
      if (phase === "gone")
        return steady(id, { opacity: 0, transform: [{ translateY: 0 }] });
      if (phase === "enter") {
        const p = b - BEAT.rise[of.order];
        return steady(id, {
          opacity: smooth(p / 300),
          transform: [{ translateY: 12 * (1 - easeOut(p / 460)) }],
        });
      }
    }
    return steady(id, { opacity: 1, transform: [{ translateY: 0 }] });
  });
  return <Animated.View style={[style, st]}>{children}</Animated.View>;
}

/** 画出来的勾：一圈从正上方顺时针画满，再把勾钩上。at 是画到哪了（毫秒） */
function Tick({ at, color }: { at: SharedValue<number>; color: string }) {
  const paths = useMemo(
    () => ({
      ring: Skia.Path.MakeFromSVGString("M12 2.5A9.5 9.5 0 1 1 11.99 2.5"),
      stroke: Skia.Path.MakeFromSVGString("M7.6 12.5l3 3 5.9-6.2"),
    }),
    [],
  );
  const ringEnd = useDerivedValue(() =>
    smooth((at.get() - TICK.ring[0]) / TICK.ring[1]),
  );
  const strokeEnd = useDerivedValue(() =>
    easeOut((at.get() - TICK.stroke[0]) / TICK.stroke[1]),
  );
  const id = useSteadyId();
  const pop = useAnimatedStyle(() =>
    steady(id, {
      transform: [
        {
          scale: 1 + 0.16 * bump((at.get() - TICK.pop[0]) / TICK.pop[1], 0.45),
        },
      ],
    }),
  );
  if (!paths.ring || !paths.stroke)
    return <Ionicons name="checkmark" size={18} color={color} />;
  return (
    <Animated.View style={pop}>
      <Canvas pointerEvents="none" style={styles.tick}>
        <Group transform={[{ scale: 22 / 24 }]}>
          <Path
            path={paths.ring}
            style="stroke"
            strokeWidth={2.2}
            strokeCap="round"
            color={color}
            opacity={0.5}
            end={ringEnd}
          />
          <Path
            path={paths.stroke}
            style="stroke"
            strokeWidth={2.2}
            strokeCap="round"
            strokeJoin="round"
            color={color}
            end={strokeEnd}
          />
        </Group>
      </Canvas>
    </Animated.View>
  );
}

/** 卡片上写的一件事 */
function StepBody({
  card,
  width,
  motion,
  role,
  live,
  done,
  onAction,
}: {
  card: GuideCard;
  width: number;
  motion: Motion;
  /** cur：轮到的这件；past：刚处理完、正在让位的那件（让完就看不见，也点不到） */
  role: "cur" | "past";
  /** 人正看着这一页 */
  live: boolean;
  /** 这件事已经打过勾了 */
  done: boolean;
  onAction: (a: GuideAction) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const step = card.step;
  const chip =
    card.chip.tone === "good"
      ? { bg: theme.successBg, fg: theme.success }
      : card.chip.tone === "amber"
        ? { bg: theme.warningBg, fg: theme.warning }
        : { bg: theme.backgroundSelected, fg: theme.textSecondary };
  const ok = card.status?.tone === "ok";
  const tone = ok ? theme.success : theme.brand;

  // 这件事具备了：把勾画出来。已经打过勾的留着不动；人不在这一页时擦掉，回来重新画一遍——
  // 这个过程一个账号只看得到一次，要让人看见（负责人 2026-10-08：「打钩慢慢钩上」）。
  // 内容刚浮上来的话等它到位再画（DeviceGuide 里换下一件的定时器是同一个算法）
  const tick = useSharedValue<number>(done ? TICK.end : 0);
  useEffect(() => {
    if (done) return;
    if (!ok || !live) {
      tick.set(0);
      return;
    }
    tick.set(0);
    tick.set(
      withDelay(
        untilSettled(),
        withTiming(TICK.end, { duration: TICK.end, easing: Easing.linear }),
      ),
    );
  }, [ok, live, done, tick]);
  const glow = useAnimatedStyle(() => ({
    opacity: bump((tick.get() - TICK.glow[0]) / TICK.glow[1], 0.4),
  }));

  // 按钮「没点亮」的样子：品牌色描边、淡淡一层底。盖在点亮的按钮上面，随那道光淡掉
  const unlit = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from >= 0)
      return {
        opacity: 1 - smooth((splashStory.get() - from - LAND.ignite) / 380),
      };
    if (motion.enter.get() === step && motion.out.get() === 1)
      return { opacity: 1 - smooth((motion.beat.get() - BEAT.ignite) / 320) };
    return { opacity: 0 };
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
  const row = (order: 0 | 1 | 2 | 3): RowOf => ({ motion, step, role, order });

  return (
    <View
      pointerEvents={role === "cur" ? "auto" : "none"}
      accessibilityElementsHidden={role !== "cur"}
      importantForAccessibility={
        role === "cur" ? "auto" : "no-hide-descendants"
      }
      style={[styles.body, { width }]}
    >
      <View style={styles.row}>
        <View style={styles.emblemSlot} />
        <Row of={row(0)} at={LAND.content}>
          <View style={[styles.chip, { backgroundColor: chip.bg }]}>
            <ThemedText style={[styles.chipText, { color: chip.fg }]}>
              {t(card.chip.text.key, card.chip.text.params)}
            </ThemedText>
          </View>
        </Row>
      </View>

      {/* 这件事里换了一种情况（比如从「打开蓝牙」到「打开头盔电源」）时，标题和说明淡入换上来 */}
      <Animated.View
        key={`${card.title}/${card.body.key}`}
        entering={FadeIn.duration(260)}
      >
        <Row of={row(1)} at={LAND.content + 60}>
          <ThemedText numberOfLines={1} style={styles.title}>
            {t(card.title)}
          </ThemedText>
        </Row>
        <Row of={row(1)} at={LAND.content + 110}>
          <ThemedText
            numberOfLines={1}
            themeColor="textSecondary"
            style={styles.text}
          >
            {t(card.body.key, card.body.params)}
          </ThemedText>
        </Row>
      </Animated.View>

      <Row of={row(2)} at={LAND.content + 170} style={styles.action}>
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
                <ThemedText style={[styles.buttonText, { color: theme.brand }]}>
                  {t(card.primary.label)}
                </ThemedText>
              </Animated.View>
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
            {ok && (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.okGlow,
                  {
                    borderColor: withAlpha(theme.success, 0.85),
                    boxShadow: `0 0 20px 2px ${withAlpha(theme.success, 0.32)}`,
                  },
                  glow,
                ]}
              />
            )}
            {ok ? (
              <Tick at={tick} color={tone} />
            ) : (
              <ActivityIndicator size="small" color={tone} />
            )}
            <ThemedText style={[styles.buttonText, { color: tone }]}>
              {t(card.status.text.key, card.status.text.params)}
            </ThemedText>
          </Animated.View>
        ) : null}
      </Row>

      <Row of={row(3)} at={LAND.content + 240} style={styles.linkRow}>
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
      </Row>
    </View>
  );
}

/** 最前面那张卡：从头到尾就是这一张，位置和大小不变。开屏落在这一页时它从商标的位置立起来 */
function FrontCard({
  width,
  leaving,
  children,
}: {
  width: number;
  /** 0..1：三件都处理完之后，卡片上的字淡掉的程度 */
  leaving: SharedValue<number>;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const { height: screenH, width: screenW } = useWindowDimensions();
  // 开屏里商标的中心在屏幕上的高度：卡片从那里立起来
  const markY = screenH / 2 - MARK_LIFT * (screenW / SCENE_W);
  const frame = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from < 0)
      return steady("guide.front", {
        opacity: 1,
        transform: [
          { perspective: 900 },
          { translateY: 0 },
          { rotateX: "0deg" },
          { scale: 1 },
        ],
      });
    const u = splashStory.get() - from;
    const a = anchorRect.guideCard.get();
    const g = glide((u - LAND.stand) / 760);
    const up = easeOut((u - LAND.stand) / 620);
    const dy0 = a ? markY - (a.y + a.h / 2) + 40 : 0;
    return steady("guide.front", {
      opacity: smooth((u - LAND.stand) / 200),
      transform: [
        { perspective: 900 },
        { translateY: lerp(dy0, 0, g) },
        { rotateX: `${62 * (1 - up)}deg` },
        { scale: lerp(0.56, 1, g) },
      ],
    });
  });
  const inner = useAnimatedStyle(() => ({ opacity: 1 - leaving.get() }));
  return (
    <Animated.View
      style={[
        styles.card,
        styles.front,
        {
          width,
          borderColor: dark ? "rgba(255,255,255,0.11)" : theme.border,
        },
        frame,
      ]}
    >
      <View
        style={[
          styles.fill,
          dark
            ? styles.cardFillDark
            : { backgroundColor: theme.backgroundElement },
        ]}
      />
      <Animated.View style={[styles.fill, inner]}>{children}</Animated.View>
    </Animated.View>
  );
}

/**
 * 压在后面的一张：一件还没轮到的事，只露出左上角它的名字。前面少一件，它就往前挪一位；
 * 轮到它时并进最前面那张的背后、淡掉（它的内容这时从最前面那张卡上浮出来）。
 * 挪位只用位移和横向缩放：按「紧挨着最前面那张」时的宽度排版，那个位置上不缩放。
 */
function BackCard({
  card,
  slot,
  width,
}: {
  card: GuideCard;
  /** 1 / 2 压在后面；0 = 已经轮到，并进最前面那张了 */
  slot: 0 | 1 | 2;
  width: number;
}) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const t = useT();
  const pos = useSharedValue<number>(slot);
  useEffect(() => {
    pos.set(withTiming(slot, MOVE));
  }, [slot, pos]);
  const natural = width - INSET * 2;
  // 开屏落在这一页时：后面两张比最前面那张晚一点从下面跟上，第二张再晚一点
  const late = card.step === 2 ? 0 : 1;
  const id = useSteadyId();
  const shell = useAnimatedStyle(() => {
    const q = pos.get();
    const sx = (width - INSET * 2 * q) / natural;
    // 并到最前面那张背后的最后一小段才淡掉
    const opacity = smooth(q / 0.3);
    const from = guideFrom.get();
    if (from < 0)
      return steady(id, {
        opacity,
        transform: [
          { translateY: -STEP * q },
          { rotate: "0deg" },
          { scaleX: sx },
          { scaleY: 1 },
        ],
      });
    const p = clamp01(
      (splashStory.get() - from - LAND.backs - 110 * late) / 620,
    );
    const sp = spring(p);
    const s = lerp(0.92, 1, easeOut(p));
    return steady(id, {
      opacity: opacity * easeOut(p / 0.6),
      transform: [
        { translateY: -STEP * q + (34 + 26 * late) * (1 - sp) },
        { rotate: `${(late ? 3 : -3) * (1 - sp)}deg` },
        { scaleX: sx * s },
        { scaleY: s },
      ],
    });
  });
  // 底色越往后越淡
  const fill = useAnimatedStyle(() => {
    const q = pos.get();
    return { opacity: q <= 1 ? lerp(1, 0.72, q) : lerp(0.72, 0.42, q - 1) };
  });
  // 名字那一行不跟着卡片横向缩放（字会被压扁）：反着缩回去，左边仍然离卡片的边 18
  const strip = useAnimatedStyle(() => {
    const q = pos.get();
    const sx = (width - INSET * 2 * q) / natural;
    return {
      opacity: smooth((q - 0.45) / 0.45),
      transform: [{ translateX: 18 / sx }, { scaleX: 1 / sx }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.card,
        styles.back,
        {
          width: natural,
          borderColor: dark
            ? `rgba(255,255,255,${slot === 2 ? 0.05 : 0.08})`
            : theme.border,
          zIndex: slot === 2 ? 2 : 3,
        },
        shell,
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
    </Animated.View>
  );
}

type LightGlobals = { __guideEmpty?: SkPicture };

/**
 * 沿最前面那张卡的边走的那道光，和按钮被点亮那一下往外泛的光。三处用到：开屏落在这一页时，光从徽标走到
 * 按钮；一件事做完，光从按钮下面走回徽标；下一件还要人去做，光再从徽标出去。没有光在走时什么都不画。
 */
function EdgeLight({ width, motion }: { width: number; motion: Motion }) {
  const theme = useTheme();
  const brand = theme.brand;
  const margin = 30;
  // 头一回画这道光，显卡要现编程序（虚线、模糊），会卡一下。这一页一搭好就先几乎全透明地画几帧，
  // 卡的那一下落在什么都没动的时候（开屏那边同样的做法，见 splash/route-scene-view.tsx）
  const warm = useSharedValue(1);
  useEffect(() => {
    const id = setTimeout(() => warm.set(0), 200);
    return () => clearTimeout(id);
  }, [warm]);
  const picture = useDerivedValue(() => {
    const from = guideFrom.get();
    const u = from < 0 ? -1 : splashStory.get() - from;
    const b = motion.beat.get();
    const warming = warm.get() === 1;
    // 光出去 / 回来各走到哪了、按钮亮到哪了；不在 0..1 之间就是这一刻没有
    let outP = -1;
    let homeP = -1;
    let ig = -1;
    if (u >= 0) {
      outP = (u - LAND.edge) / 700;
      ig = (u - LAND.ignite) / 380;
    } else if (b < BEAT.end) {
      if (motion.home.get() === 1) homeP = b / BEAT.home;
      if (motion.out.get() === 1) {
        outP = (b - BEAT.out[0]) / BEAT.out[1];
        ig = (b - BEAT.ignite) / 560;
      }
    }
    const outOn = outP > 0 && outP < 1;
    const homeOn = homeP > 0 && homeP < 1;
    const igOn = ig > 0 && ig < 1;
    if (!outOn && !homeOn && !igOn && !warming) {
      // 每次交回同一张空图，画布就不会重画
      const g = globalThis as unknown as LightGlobals;
      let empty = g.__guideEmpty;
      if (!empty) {
        const recorder = Skia.PictureRecorder();
        recorder.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
        empty = recorder.finishRecordingAsPicture();
        g.__guideEmpty = empty;
      }
      return empty;
    }
    return createPicture(
      (canvas) => {
        const x0 = margin + 0.8;
        const y0 = margin + STEP * 2 + 0.8;
        const w = width - 1.6;
        const h = CARD_H - 1.6;
        const c = Skia.Color(brand);
        // 每道光两个数：光头走到全长的千分之几、这一刻有多亮
        const lights: number[] = [];
        if (warming) lights.push(300, 1 / 255);
        // 出去：从徽标走到全长的 64%（按钮下面）
        if (outOn)
          lights.push(
            lerp(20, 640, smooth(outP)),
            Math.min(1, Math.sin(Math.PI * outP) * 1.6),
          );
        // 回来：从那里走完剩下的一段，回到起点（徽标上方）
        if (homeOn)
          lights.push(
            lerp(640, 1000, smooth(homeP)),
            Math.min(1, Math.sin(Math.PI * homeP) * 1.6),
          );
        if (lights.length > 0) {
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
          const paint = Skia.Paint();
          paint.setAntiAlias(true);
          paint.setStyle(PaintStyle.Stroke);
          paint.setStrokeCap(StrokeCap.Round);
          for (let i = 0; i < lights.length; i += 2) {
            // 光头后面拖着最长 15% 的一段
            const head = (lights[i] / 1000) * total;
            const tail = Math.min((150 / 1000) * total, head);
            const on = lights[i + 1];
            paint.setPathEffect(
              Skia.PathEffect.MakeDash([tail, total * 2], tail - head),
            );
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
        }
        // 按钮点亮的那一下
        if (igOn || warming) {
          const glow = igOn ? Math.sin(Math.PI * ig) : 1 / 255;
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

/** 进度条的一格。做完的那一格从左往右填满 */
function SegBar({ tone }: { tone: GuideSegment["tone"] }) {
  const theme = useTheme();
  const done = tone === "done";
  const fill = useSharedValue(done ? 1 : 0);
  useEffect(() => {
    fill.set(
      withDelay(
        80,
        withTiming(done ? 1 : 0, {
          duration: 420,
          easing: Easing.bezier(0.3, 0.8, 0.3, 1),
        }),
      ),
    );
  }, [done, fill]);
  const st = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.get() }] }));
  return (
    <View
      style={[
        styles.segBar,
        {
          backgroundColor:
            tone === "current"
              ? withAlpha(theme.brand, 0.5)
              : tone === "skipped"
                ? "transparent"
                : theme.backgroundSelected,
          borderColor:
            tone === "skipped" ? withAlpha(theme.warning, 0.7) : "transparent",
        },
      ]}
    >
      <Animated.View
        style={[styles.segFill, { backgroundColor: theme.success }, st]}
      />
    </View>
  );
}

export function DeviceGuide({
  helmet,
  link,
  notify,
  contacts,
  bindOnly,
  onStage,
  onFinished,
}: {
  /** 已经绑定的那顶（当前头盔）；还没绑定是 undefined */
  helmet: DevicePublic | undefined;
  link: HelmetLink | undefined;
  notify: NotifyPermission | null;
  contacts: number | null;
  /** 这个账号以前绑过头盔：只有绑定那一张，没有后两张和进度条 */
  bindOnly: boolean;
  /** 人正看着这一页（设备页在最前面、App 在前台）。不在时自己打勾、收尾都先停着 */
  onStage: boolean;
  /** 都处理完了：页面该变成设备页了。带上最前面那张卡和徽标此刻的位置，衔接动画从那里接手 */
  onFinished: (from: GuideHandoverFrom | null) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const state = useGuideStore((s) => s.state);
  const mark = useGuideStore((s) => s.mark);
  const [width, setWidth] = useState(0);

  const phase = useBleStore((s) =>
    helmet ? s.links[helmet.deviceId]?.phase : undefined,
  );
  // 刚点完「允许通知」：系统弹窗的结果先用上，不等回到前台那次重查。只用到重查的结果变了为止
  // （over = 点的时候查到的权限）：之后以系统为准——弹窗里拒了、后来去设置里打开，卡片要能打勾
  const [asked, setAsked] = useState<{
    answer: NotifyPermission;
    over: NotifyPermission | null;
  } | null>(null);
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
    notify: asked && asked.over === notify ? asked.answer : notify,
    contacts,
    slow: searching && slowFor === helmetId,
  };
  const cards = guideCards(facts);
  const cur = guideCurrent(state, bindOnly);
  // 都处理完之后、页面变过去之前，最后一件还留在卡片上
  const front = cur === 0 ? (bindOnly ? 1 : 3) : cur;
  const results = [state.r1, state.r2, state.r3];
  // 卡片上同时搭着的最多两件：轮到的这件，和刚让位的上一件（它淡走之后看不见，下一次换的时候卸掉）
  const bodies = cur !== 0 && front > 1 ? [front - 1, front] : [front];

  const beat = useSharedValue<number>(BEAT.end);
  const past = useSharedValue(0);
  const enter = useSharedValue(0);
  const home = useSharedValue(0);
  const out = useSharedValue(0);
  const motion = useMemo<Motion>(
    () => ({ beat, past, enter, home, out }),
    [beat, past, enter, home, out],
  );

  // 一件事处理完：先把「换到下一件」那一段起起来，再记结果。共享值比页面重画早到动画线程，
  // 所以新内容搭上来的那一帧已经是「还没浮上来」的样子，不会先整个闪出来一下
  const advance = (step: 1 | 2 | 3, result: "done" | "skipped") => {
    const now = useGuideStore.getState();
    const key = step === 1 ? "r1" : step === 2 ? "r2" : "r3";
    // 一件事只记一次：自己打勾和手点「稍后」可能前后脚到
    if (!now.active || now.state[key]) return;
    const b = guideBeat(now.state, step, result, cards, bindOnly);
    past.set(b.next === 0 ? 0 : step);
    enter.set(b.next);
    home.set(b.home ? 1 : 0);
    out.set(b.out ? 1 : 0);
    beat.set(0);
    beat.set(
      withTiming(BEAT.end, { duration: BEAT.end, easing: Easing.linear }),
    );
    mark(step, result);
  };
  // 页面每次重画都会给一个新的 advance / onFinished；定时器不该因此重来，所以只记着最新的那个
  const advanceWith = useRef(advance);
  const finishWith = useRef(onFinished);
  useEffect(() => {
    advanceWith.current = advance;
    finishWith.current = onFinished;
  });

  // 轮到的那件事已经具备了：画个勾，停一下，换到下一件。人不在这一页时不走：回来之后重新画、重新停满，
  // 打勾和换下一件都让人看见。这件事的内容刚浮上来的话，等它到位再开始算（StepBody 里画勾是同一个算法）
  const auto = guideAutoDone(state, facts, bindOnly);
  useEffect(() => {
    if (!auto || !onStage) return;
    const id = setTimeout(
      () => advanceWith.current(auto, "done"),
      untilSettled() + guideTickMs(auto, bindOnly),
    );
    return () => clearTimeout(id);
  }, [auto, onStage, bindOnly]);
  // 都处理完：卡片上的字和下面的进度先淡掉，只留下卡片的壳和徽标，然后交给衔接动画。
  // 同样只在人看着的时候走；中途离开就撤回去（字恢复、先搭着的衔接层撤掉），回来从头来一遍
  const leaving = useSharedValue(0);
  const arm = useGuideStore((s) => s.arm);
  const disarm = useGuideStore((s) => s.disarm);
  useEffect(() => {
    if (cur !== 0 || !onStage) return;
    let handed = false;
    arm();
    const fade = setTimeout(
      () => leaving.set(withTiming(1, { duration: LEAVE_MS })),
      FINISH_MS - LEAVE_MS,
    );
    const id = setTimeout(() => {
      handed = true;
      const card = anchorRect.guideCard.get();
      const emblem = anchorRect.guideEmblem.get();
      finishWith.current(card && emblem ? { card, emblem } : null);
    }, FINISH_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(id);
      if (!handed) {
        leaving.set(0);
        disarm();
      }
    };
  }, [cur, onStage, leaving, arm, disarm]);
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
        .then((p) =>
          setAsked({ answer: p.granted ? "granted" : "denied", over: notify }),
        )
        .catch(() => undefined);
    else if (cur !== 0) advance(cur, "skipped");
  };

  const segments = guideSegments(state);
  const done = guideDoneCount(state);
  // 徽标应一下：先大一点再回到原大，同时往外泛一圈。开屏的商标落成徽标时、一件事做完光走回来时都是这一下
  const emblemPop = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from >= 0) {
      const u = splashStory.get() - from;
      return steady("guide.emblem", {
        transform: [
          { scale: 1 + 0.22 * (1 - spring((u - LAND.emblem) / 520)) },
        ],
      });
    }
    const b = beat.get();
    if (home.get() !== 1 || b >= BEAT.end)
      return steady("guide.emblem", { transform: [{ scale: 1 }] });
    return steady("guide.emblem", {
      transform: [{ scale: 1 + 0.2 * bump((b - BEAT.answer) / 460, 0.4) }],
    });
  });
  const ripple = useAnimatedStyle(() => {
    const from = guideFrom.get();
    if (from >= 0) {
      const p = clamp01((splashStory.get() - from - LAND.ripple) / 620);
      return steady("guide.ripple", {
        opacity: p > 0 && p < 1 ? 0.55 * (1 - p) : 0,
        transform: [{ scale: easeOut(p) }],
      });
    }
    const p = home.get() === 1 ? clamp01((beat.get() - BEAT.answer) / 620) : 0;
    if (p <= 0 || p >= 1)
      return steady("guide.ripple", { opacity: 0, transform: [{ scale: 0 }] });
    return steady("guide.ripple", {
      opacity: p < 0.15 ? (0.6 * p) / 0.15 : (0.6 * (1 - p)) / 0.85,
      transform: [{ scale: lerp(0.18, 0.88, easeOut(p)) }],
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
          {/* 最前面那张卡所在的位置：开屏要知道卡片从哪里立起来，收尾的衔接要知道从哪里接手 */}
          <SplashAnchor name="guideCard" style={styles.frontSlot} />
          {width > 0 &&
            !bindOnly &&
            [cards[1], cards[2]].map((card) => (
              <BackCard
                key={card.step}
                card={card}
                slot={Math.max(0, card.step - front) as 0 | 1 | 2}
                width={width}
              />
            ))}
          {width > 0 && (
            <FrontCard width={width} leaving={leaving}>
              {bodies.map((n) => (
                <StepBody
                  key={n}
                  card={cards[n - 1]}
                  width={width - 2}
                  motion={motion}
                  role={n === front ? "cur" : "past"}
                  live={onStage}
                  done={results[n - 1] === "done"}
                  onAction={act}
                />
              ))}
            </FrontCard>
          )}
          {width > 0 && <EdgeLight width={width} motion={motion} />}
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

        {!bindOnly && (
          <Row at={LAND.progress} dur={560} dy={16} style={styles.progress}>
            <Animated.View style={leave}>
              <View style={styles.caption}>
                <ThemedText
                  themeColor="textSecondary"
                  style={styles.captionText}
                >
                  {t(done === 3 ? "guide.captionDone" : "guide.caption")}
                </ThemedText>
                <ThemedText
                  themeColor="textSecondary"
                  style={styles.captionText}
                >
                  {done} / 3
                </ThemedText>
              </View>
              <View style={styles.segments}>
                {segments.map((g) => (
                  <View key={g.label} style={styles.segment}>
                    <SegBar tone={g.tone} />
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
          </Row>
        )}
        <View style={styles.below} />
      </View>
    </LayoutAnimationConfig>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1 },
  // 一屏放得下时，余下的高度按 3 : 4 分在上面和下面：卡片和进度落在页面中间略偏上
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
    top: STEP * 2,
    borderWidth: 1,
    borderRadius: RADIUS,
    overflow: "hidden",
    transformOrigin: "50% 100%",
  },
  front: {
    left: 0,
    height: CARD_H,
    zIndex: 4,
    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.45)",
  },
  back: { left: INSET, height: CARD_H - 2 },
  fill: { ...StyleSheet.absoluteFill },
  cardFillDark: {
    experimental_backgroundImage:
      "linear-gradient(180deg, #1D2024 0%, #141518 100%)",
  },
  strip: {
    position: "absolute",
    left: 0,
    top: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    transformOrigin: "0% 50%",
  },
  stripNo: {
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: 700,
    fontVariant: ["tabular-nums"],
  },
  stripText: { fontSize: 12.5, lineHeight: 17, letterSpacing: 0.2 },
  body: {
    position: "absolute",
    left: 0,
    top: 0,
    height: CARD_H - 2,
    paddingTop: 19,
    paddingHorizontal: 19,
  },
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
  okGlow: { ...StyleSheet.absoluteFill, borderWidth: 1, borderRadius: 24 },
  tick: { width: 22, height: 22 },
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
  segBar: { height: 6, borderRadius: 3, borderWidth: 1, overflow: "hidden" },
  // 填满整格（连描边那一圈）：往外各撑 1
  segFill: {
    position: "absolute",
    left: -1,
    right: -1,
    top: -1,
    bottom: -1,
    transformOrigin: "0% 50%",
  },
  segLabel: {
    marginTop: 6,
    fontSize: 11,
    lineHeight: 14,
    textAlign: "center",
  },
});
