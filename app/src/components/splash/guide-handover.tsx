// 引导页（三步都处理完）变成设备页的那一段衔接：最后那张卡的边收成电量环，徽标划一道低弧回到环中间，
// 然后和冷启动落到设备页是同一套动作——光点沿环滑到电量处，一圈扫描显出头盔、擦掉徽标，
// 名字、连接状态、下面两格依次出现。用的就是开屏那套零件（bus.ts 的共享值 + DeviceLanding），
// 只是时钟从这里起、表盘一开始就在页面上大图的位置。
// 这一层盖在整个 App 上面（和开屏一样挂在根布局），位置都按窗口坐标。播完就卸掉。
import { useImage } from "@shopify/react-native-skia";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  makeMutable,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";

import { devicesApi } from "@/api/devices";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { useGuideStore, type GuideHandoverFrom } from "@/stores/guide-store";

import {
  anchorOwned,
  anchorRect,
  arriveFrom,
  endSplashStory,
  pillFrom,
  releaseSplashPage,
  splashOn,
  splashStory,
} from "./bus";
import { useHeroSplash } from "./use-hero-splash";
import { DeviceLanding, releaseDeviceLanding } from "./landing-device";
import { DEVICE, deviceWipe } from "./landings";
import { clamp01, lerp, smooth } from "./route-scene";

/**
 * 这一段自己的时间表（毫秒，从接手那一刻算起）。表盘那一套动作照开屏的故事时间走，
 * 所以故事时间 = STORY0 + 这里的时间：徽标飞到位（820）时故事时间是 1720，正好接上环亮起来（1660 起）。
 */
const HAND = {
  story0: 900,
  /** 卡片的边收成环、徽标飞回环中间 */
  morph: [60, 780] as const,
  /** 卡片的底色淡掉 */
  fillOut: 520,
  /** 壳收成环之后淡掉（这时页面替身的底环已经亮起来了） */
  shellOut: [760, 1060] as const,
  /** 下面两格、其他设备开始进场（故事时间） */
  arrive: 2300,
  /** 表盘交还给页面（故事时间）：光点落到连接状态上之后 */
  give: 2800,
  /** 整段多长 */
  total: 2300,
  /** 页面上的大图最多等多久量到位置；等不到就不播，直接露出页面 */
  waitHero: 600,
};

/** 起步快、中段稳、收得很长：卡片的边、徽标的大小用这条 */
function settle(v: number): number {
  "worklet";
  const p = clamp01(v);
  return 1 - Math.pow(1 - p, 3.2);
}
/** 两头都缓：徽标横着走用这条 */
function ease(v: number): number {
  "worklet";
  const p = clamp01(v);
  return p * p * p * (p * (p * 6 - 15) + 10);
}

/**
 * 最后那张卡和徽标在窗口里的位置；null = 还没接手，壳和徽标不显示。
 * 放在共享值里、而不是当参数传给这一层：共享值在页面换成设备页的那次提交**之前**就到了动画线程，
 * 壳先盖上去，引导页才卸掉，中间不会空一帧（当参数传的话要等这一层重画，晚一两帧）。
 */
const handFrom: SharedValue<GuideHandoverFrom | null> =
  makeMutable<GuideHandoverFrom | null>(null);

/**
 * 接手之前先把页面上的东西安排好：设备页的大图由这一层代画（真的那一份先藏着），下面的内容跟着这里的
 * 时钟进场，标题栏不动（它一直在）。必须在页面换成设备页**之前**调用——等这一层搭好了再设就晚了，
 * 设备页会先原样闪出来一帧。
 */
export function prepareGuideHandover(from: GuideHandoverFrom): void {
  handFrom.set(from);
  // 以前量到过的位置不算数（可能是上一次进设备页时的）：等这一次搭好的大图重新量
  anchorRect.hero.set(null);
  splashStory.set(HAND.story0);
  anchorOwned.hero.set(1);
  arriveFrom.set(HAND.arrive);
  // 名字和连接状态等光点落上去才出现；那一刻由 DeviceLanding 算出来，在那之前先藏着
  pillFrom.set(HAND.story0 + HAND.total * 4);
  splashOn.set(1);
}

export function GuideHandover() {
  const from = useGuideStore((s) => s.handover);
  const armed = useGuideStore((s) => s.armed);
  if (!from && !armed) return null;
  return <Handover from={from} />;
}

/** from 还是 null 时只是先搭着（把图读好、画布建好），什么都不显示；from 一到就接手 */
function Handover({ from }: { from: GuideHandoverFrom | null }) {
  const { width, height } = useWindowDimensions();
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const endHandover = useGuideStore((s) => s.endHandover);

  // 和设备页是同一个查询：头盔刚绑上，列表已经在缓存里
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
  });
  const hero = useHeroSplash(devices.data, !devices.isError);
  const markImage = useImage(
    require("@/assets/images/company-mark-solid.webp"),
  );
  const helmetImage = useImage(hero?.image);

  const markTaken = useSharedValue(0);
  /** 接手之后过了多久；页面上的大图量到位置之前不走 */
  const local = useSharedValue(0);
  const waited = useSharedValue(0);
  const over = useSharedValue(0);

  const finished = useRef(false);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    over.set(1);
    handFrom.set(null);
    releaseSplashPage();
    // 页面上真的那一份已经露出来了，隔两帧再把这一层卸掉（和开屏收场同一个顺序）
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        scheduleOnUI(releaseDeviceLanding);
        endHandover();
      }),
    );
  }, [endHandover, over]);

  const clock = useFrameCallback((info) => {
    if (over.get()) return;
    const dt = Math.min(info.timeSincePreviousFrame ?? 16, 50);
    if (!anchorRect.hero.get()) {
      // 设备页刚换上来，大图还没排好版：壳和徽标先原地等着
      waited.set(waited.get() + dt);
      if (waited.get() > HAND.waitHero) {
        over.set(1);
        scheduleOnRN(finish);
      }
      return;
    }
    const u = local.get() + dt;
    local.set(u);
    splashStory.set(HAND.story0 + u);
    if (u >= HAND.total) {
      over.set(1);
      scheduleOnRN(finish);
    }
  }, false);

  const going = from !== null;
  useEffect(() => {
    if (!going) return;
    clock.setActive(true);
    return () => {
      handFrom.set(null);
      releaseSplashPage();
      endSplashStory();
    };
  }, [going, clock]);
  // 保险：这一层挡着整个页面，出了岔子也必须让开（先搭着的那一会儿不挡触摸，但也不能一直留着）
  useEffect(() => {
    const id = setTimeout(
      going ? finish : endHandover,
      HAND.total + HAND.waitHero + 1500,
    );
    return () => clearTimeout(id);
  }, [going, finish, endHandover]);

  // 表盘交还给页面
  useAnimatedReaction(
    () =>
      splashOn.get() ? 1 - smooth((splashStory.get() - HAND.give) / 200) : -1,
    (owned) => {
      if (owned >= 0) anchorOwned.hero.set(owned);
    },
  );

  // 卡片的壳：从卡片的位置和形状，收成页面上电量环的那个圆
  const ringColor = hero?.track ?? theme.border;
  const shell = useAnimatedStyle(() => {
    const from = handFrom.get();
    const u = local.get();
    const a = anchorRect.hero.get();
    const p = a
      ? settle((u - HAND.morph[0]) / (HAND.morph[1] - HAND.morph[0]))
      : 0;
    // 环的外沿：240 的画布上半径 104、线宽 6
    const d = a ? (a.w * 214) / 240 : 0;
    const x = a ? a.x + a.w / 2 - d / 2 : 0;
    const y = a ? a.y + a.h / 2 - d / 2 : 0;
    if (!from) return { opacity: 0 };
    return {
      left: lerp(from.card.x, x, p),
      top: lerp(from.card.y, y, p),
      width: lerp(from.card.w, d, p),
      height: lerp(from.card.h, d, p),
      borderRadius: lerp(26, d / 2, p),
      borderWidth: lerp(1, a ? (a.w * 6) / 240 : 1, p),
      opacity:
        1 -
        smooth((u - HAND.shellOut[0]) / (HAND.shellOut[1] - HAND.shellOut[0])),
    };
  });
  const shellFill = useAnimatedStyle(() => ({
    opacity: 1 - smooth((local.get() - HAND.morph[0]) / HAND.fillOut),
  }));

  // 徽标：从卡片左上角划一道低弧回到环的中间，同时长到「收了一点的商标」那么大；扫描一开始交给表盘去擦
  const emblem = useAnimatedStyle(() => {
    const from = handFrom.get();
    // 还没接手时也占着一块地方（看不见）：图要有大小才会去读
    if (!from) return { opacity: 0, width: 40, height: 40 };
    const u = local.get();
    const a = anchorRect.hero.get();
    const span = HAND.morph[1] - HAND.morph[0] + 40;
    const px = a ? ease((u - HAND.morph[0]) / span) : 0;
    const ps = a ? settle((u - HAND.morph[0]) / span) : 0;
    const cx0 = from.emblem.x + from.emblem.w / 2;
    const cy0 = from.emblem.y + from.emblem.h / 2;
    const cx1 = a ? a.x + a.w / 2 : cx0;
    const cy1 = a ? a.y + a.h / 2 : cy0;
    const size1 = a ? (DEVICE.markInDial * a.w) / 240 : from.emblem.w;
    const size = lerp(from.emblem.w, size1, ps);
    // 表盘那块画布准备好了就从扫描开始那一刻整个交给它；没准备好（头盔的图还没读出来）就随扫描淡掉
    const wipe = deviceWipe(HAND.story0 + u);
    return {
      opacity: markTaken.get()
        ? wipe > 0
          ? 0
          : 1
        : 1 - smooth((wipe - 0.15) / 0.6),
      width: size,
      height: size,
      transform: [
        { translateX: lerp(cx0, cx1, px) - size / 2 },
        // 先抬起来一点再落下去：一道低弧
        {
          translateY:
            lerp(cy0, cy1, px) - 30 * Math.sin(Math.PI * px) - size / 2,
        },
      ],
    };
  });

  return (
    <View
      style={styles.overlay}
      pointerEvents={going ? "box-only" : "none"}
      onStartShouldSetResponder={blockTouches}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.shell, { borderColor: ringColor }, shell]}
      >
        <Animated.View
          style={[
            styles.fill,
            dark
              ? styles.cardFillDark
              : { backgroundColor: theme.backgroundElement },
            shellFill,
          ]}
        />
      </Animated.View>
      <DeviceLanding
        width={width}
        height={height}
        hero={hero}
        mark={markImage}
        helmet={helmetImage}
        markTaken={markTaken}
        inPlace
        giveAt={HAND.give}
      />
      <Animated.View pointerEvents="none" style={[styles.emblem, emblem]}>
        {/* 这张图途中要从 36 长到一百多：按原图读一次，免得变大时再读一遍、空一下 */}
        <Image
          source={require("@/assets/images/company-mark-solid.webp")}
          style={styles.fill}
          contentFit="contain"
          allowDownscaling={false}
        />
      </Animated.View>
    </View>
  );
}

function blockTouches(): boolean {
  return true;
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 900 },
  fill: { ...StyleSheet.absoluteFill },
  shell: { position: "absolute", overflow: "hidden" },
  cardFillDark: {
    experimental_backgroundImage:
      "linear-gradient(180deg, #1D2024 0%, #141518 100%)",
  },
  emblem: { position: "absolute", left: 0, top: 0 },
});
