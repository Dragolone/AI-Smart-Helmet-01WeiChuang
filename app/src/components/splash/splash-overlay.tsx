// 开屏动画（2026-10-08 定稿的三种）：骑行路线随镜头升起、凝聚成商标，然后按情况接到页面上——
//   没登录        → 商标落到登录页顶部，「零一唯创」成为标题，页面从下方涌上来；
//   已登录、有头盔 → 商标的绿色延展成电量环，滑到电量处，扫描显出头盔，落到设备页；
//   已登录、没头盔 → 引导卡从商标的位置立起来，商标落成卡片上的徽标。
// 这一层盖在整个 App 上面。前半段（路线成标）iOS 画在一块 Skia 画布上，安卓播一段预渲染的视频
// （安卓这一档的显卡逐帧现画跟不上，见 route-video-format.ts）；商标完成之后的东西是普通的原生视图，
// 位置从底下真实的页面量出来，所以最后一帧就是页面本身，收掉这一层时看不出切换。
//
// 规则（负责人 2026-10-08 定）：每次冷启动播完整的；由通知拉起、或者进了求救页，不播 / 立刻收掉；
// 设备列表没回来时按本机记住的上次结果播，没有记录就停在商标上最多 1 秒，然后直接进页面。
import { useImage } from "@shopify/react-native-skia";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";

import { devicesApi } from "@/api/devices";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useT } from "@/i18n";
import { launchedByNotification } from "@/services/launch-intent";
import { useAuthStore } from "@/stores/auth-store";
import { useLaunchMemoryStore } from "@/stores/launch-memory-store";
import { useThemeStore } from "@/stores/theme-store";

import {
  anchorOwned,
  anchorRect,
  arriveFrom,
  guideFrom,
  headerFrom,
  setSplashLanding,
  endSplashStory,
  releaseSplashHold,
  releaseSplashPage,
  splashOn,
  splashStory,
  whenPageReady,
} from "./bus";
import { useHeroSplash } from "./use-hero-splash";
import { DeviceLanding, releaseDeviceLanding } from "./landing-device";
import {
  DEVICE,
  LAND_DEVICE,
  LAND_LOGIN,
  LAND_NONE,
  LAND_PLAIN,
  LAND_UNBOUND,
  LOGIN,
  UNBOUND,
  deviceWipe,
  glowDockAt,
  lockupAt,
  loginBreath,
  loginDock,
  loginReveal,
} from "./landings";
import { planLanding } from "./plan";
import { loadRouteFrames } from "./route-frames";
import {
  MARK_LIFT,
  MARK_SIZE,
  SCENE_BG,
  SCENE_T,
  SCENE_W,
  clamp01,
  lerp,
  rasterOpacityAt,
  smooth,
  smoother,
  type MarkGlow,
} from "./route-scene";
import { RouteSceneView, releaseRouteScene } from "./route-scene-view";
import { VIDEO_HANDOVER, VIDEO_PRE_MS } from "./route-video-format";
import {
  ROUTE_VIDEO,
  RouteVideoLayer,
  type RouteVideoHandle,
} from "./route-video-layer";
import { LOGIN_BRAND } from "./login-brand";
import { steady } from "./steady-style";
import {
  MARK_DONE,
  STORY_TOTAL,
  buildWarp,
  storyAt,
  type SplashLanding,
} from "./timeline";

/** 商标下面的品牌名（中英两行，负责人 2026-10-08 定）。中文环境用登录页标题的写法（简 / 繁） */
const BRAND_EN = "ZERO-ONE INNOVATION";
const BRAND_ZH = "零一唯创";

const LAND_CODE: Record<SplashLanding, number> = {
  login: LAND_LOGIN,
  device: LAND_DEVICE,
  unbound: LAND_UNBOUND,
  plain: LAND_PLAIN,
};
/** 设备列表没回来、也没有上次的记录时，在商标上最多等这么久 */
const HOLD_MS = 1000;
/** 已登录时到这一刻才决定落到哪（品牌名 1580 出现，要在那之前） */
const DECIDE_AT = 1500;
/** 没有可落的页面时：商标和品牌名停到这一刻，然后整层淡出 */
const PLAIN_FADE_FROM = 2000;
/** 开播前最多等预录的路线帧这么久（平时几十毫秒就读完）；没等到就先实时画，读到了再接上 */
const FRAMES_WAIT_MS = 300;
/** 起步前要连续按时到达这么多帧（最多等 LEAD_MAX_MS），见时钟里的说明 */
const LEAD_FRAMES = 3;
const LEAD_MAX_MS = 250;
/** 从这一层出现算起，最迟这么久必须收掉（正常情况下 6 秒以内就播完了） */
const WATCHDOG_MS = 9000;
/** 开播前最多等底下的页面搭好这么久（见 bus.ts 的 markPageReady）。等的时候屏幕和原生启动画面一样是一片深色 */
const PAGE_WAIT_MS = 700;
/** 开播前预热时画的几帧（预录帧的序号）：线少的、线最密的、开始填色的都有 */
const WARM_FRAMES = [8, 30, 55, 75, 95, 118];
/**
 * 安卓：开播前最多等视频备好（读进来、第一帧显示出来）这么久；没等到就退回画布逐帧画。
 * 给得比别的等待宽：已登录时各标签页一起搭，主线程忙，视频的显示表面要排在后面才建得出来
 * （模拟器上未登录十几毫秒就好，已登录要 650–800 毫秒）；而慢的手机退回去逐帧画只会更卡，宁可多等一会儿
 */
const VIDEO_WAIT_MS = 2500;
/** 安卓：播放器还没备好就报错时，最多换几次播放器重试 */
const VIDEO_RETRIES = 2;
/** 安卓：叫视频开始放之后，最多等它真的走起来这么久 */
const VIDEO_START_MS = 700;
/** 安卓：视频走到这么多毫秒才对表。刚起步的那一下播放器报的位置是估的，不准；这时还在正片前垫的那段里 */
const VIDEO_SYNC_AT = 70;
/**
 * 数帧、打几行 [splash] 开头的日志（流不流畅看它）。开发包里总是开；想在接近正式包的打包方式下量
 * （npx expo start --no-dev --minify），起 Metro 时加上 EXPO_PUBLIC_SPLASH_LOG=1。正式包里没有这个变量
 */
const REPORT = __DEV__ || process.env.EXPO_PUBLIC_SPLASH_LOG === "1";
function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
/** 一道门：ready 等到有人 open 才往下走（视频的第一帧出来了没有） */
function makeGate(): { ready: Promise<boolean>; open: (ok: boolean) => void } {
  let open: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((done) => {
    open = done;
  });
  return { ready, open };
}
function twoFrames(): Promise<void> {
  return new Promise((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
}
/** 从这一层排好版到开播，各种等待加起来最多这么久 */
const START_BUDGET_MS = 1500;
/** JS 线程连续这么久没有被占着，才算启动时的那一阵忙完了 */
const JS_QUIET_MS = 160;

/**
 * 等 JS 线程闲下来。已登录时一启动就有一阵忙：各个标签页一起搭（地图的 WebView、手势库都在这时初始化），
 * 一次能占主线程上百毫秒；和路线动画撞上就是明显的一顿（2026-10-08 用系统的慢消息日志查到的）。
 * 这一阵是 JS 线程发起的，所以看它：每帧给自己发一个定时器，按时回来说明它闲着。
 */
function whenJsQuiet(budget: number): Promise<void> {
  return new Promise((done) => {
    const from = performance.now();
    let last = from;
    let quietSince = from;
    const tick = () => {
      const now = performance.now();
      if (now - last > 40) quietSince = now;
      last = now;
      if (now - quietSince >= JS_QUIET_MS || now - from >= budget) done();
      else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
}

export function SplashOverlay() {
  const [done, setDone] = useState(false);
  const onDone = useCallback(() => setDone(true), []);
  return (
    <>
      <LaunchMemory />
      {/* 播完整个卸掉：时钟、画布和那一堆逐帧的样式都跟着停 */}
      {!done && <SplashPlayer onDone={onDone} />}
    </>
  );
}

/** 每次拿到设备列表都记一笔「这个账号有没有头盔」：下次冷启动、列表还没回来时开屏照这个播 */
function LaunchMemory() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const authed = useAuthStore((s) => s.tokens !== null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // 和设备页是同一个查询（同一个 key，结果共用）
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    enabled: hydrated && authed,
  });
  const hydrate = useLaunchMemoryStore((s) => s.hydrate);
  const remember = useLaunchMemoryStore((s) => s.remember);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  const count = devices.data ? devices.data.length : null;
  useEffect(() => {
    if (userId && count !== null) remember(userId, count > 0);
  }, [userId, count, remember]);
  return null;
}

function SplashPlayer({ onDone }: { onDone: () => void }) {
  const { width, height } = useWindowDimensions();
  const t = useT();
  const [phase, setPhase] = useState<"boot" | "play">("boot");
  // 商标成形之后才搭的东西（落位用的画布）：和页面上重的内容一样，等那一刻的空当
  const [released, setReleased] = useState(false);
  const [sceneOn, setSceneOn] = useState(true);
  const [landing, setLanding] = useState<SplashLanding | null>(null);

  const k = width / SCENE_W;
  const cx = width / 2;
  const cy = height / 2 - MARK_LIFT * k;
  const size = MARK_SIZE * k;

  const warp = useMemo(() => buildWarp(), []);
  const real = useSharedValue(0);

  // ------------------------------------------------------------ 安卓：路线段的视频
  // 由通知拉起时不播开屏，播放器也就不用建
  const [videoOn, setVideoOn] = useState(
    () => ROUTE_VIDEO && !launchedByNotification(),
  );
  // 这一层还指望着视频（没放完、也没放弃）
  const videoLive = useRef(videoOn);
  // 路线段最后是怎么播的（只为日志）
  const videoFate = useRef<"" | "played" | "dropped">("");
  const videoRef = useRef<RouteVideoHandle>(null);
  // 1 = 路线段由视频显示，画布这一段空着
  const videoMode = useSharedValue(videoOn ? 1 : 0);
  // 0 还没叫它放 / 1 叫了、等它走起来 / 2 已经对过表
  const videoStage = useSharedValue(0);
  // 视频的第 0 毫秒落在哪一刻（Date.now() 的读数）；0 = 还不知道
  const videoZero = useSharedValue(0);
  const [videoGate] = useState(makeGate);
  // 视频没起来时换一个播放器再试（这是第几次重试）
  const [videoTry, setVideoTry] = useState(0);
  const videoReady = useRef(false);
  const land = useSharedValue(LAND_NONE);
  const total = useSharedValue(Number.POSITIVE_INFINITY);

  // ------------------------------------------------------------ 落到哪种页面
  const dark = useColorScheme() === "dark";
  const themeReady = useThemeStore((s) => s.hydrated);
  const hydrated = useAuthStore((s) => s.hydrated);
  const authed = useAuthStore((s) => s.tokens !== null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // 和设备页是同一个查询（同一个 key，结果共用）：开屏期间就去取，播到收尾时多半已经回来了
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    enabled: hydrated && authed,
  });
  const memory = useLaunchMemoryStore((s) => s.record);
  const memoryReady = useLaunchMemoryStore((s) => s.hydrated);
  const deviceCount = devices.data ? devices.data.length : null;
  // 落到设备页时要画的那块大图：样子和两张图都提前备好，轮到它时不用现算现读
  const hero = useHeroSplash(devices.data, !devices.isError);
  const markImage = useImage(
    require("@/assets/images/company-mark-solid.webp"),
  );
  const helmetImage = useImage(hero?.image);

  const [reduceMotion, setReduceMotion] = useState(false);
  const [waited, setWaited] = useState(false);
  // 已登录的人等到商标快完成时再定：多给设备列表一点时间回来
  const [ready, setReady] = useState(false);
  // 定了就不再改（渲染时就地记下来，不绕一圈 effect）
  if (
    landing === null &&
    phase === "play" &&
    (!(hydrated && authed) || ready)
  ) {
    const kind = planLanding({
      hydrated,
      themeReady,
      dark,
      reduceMotion,
      authed,
      deviceCount,
      remembered: memoryReady
        ? userId && memory?.userId === userId
          ? memory.hasHelmet
          : null
        : undefined,
      waited,
    });
    if (kind) setLanding(kind);
  }
  useEffect(() => {
    if (!landing) return;
    // 页面上要由这一层代画的东西先藏起来，页面内容跟着同一个时钟进场
    if (landing === "login") {
      anchorOwned.loginMark.set(1);
      anchorOwned.loginTitle.set(1);
      arriveFrom.set(LOGIN.arriveFrom);
    } else if (landing === "device") {
      anchorOwned.hero.set(1);
      arriveFrom.set(DEVICE.arriveFrom);
      headerFrom.set(DEVICE.arriveFrom);
    } else if (landing === "unbound") {
      anchorOwned.guideEmblem.set(1);
      guideFrom.set(UNBOUND.start);
      headerFrom.set(UNBOUND.start + UNBOUND.header);
    }
    setSplashLanding(landing);
    total.set(STORY_TOTAL[landing]);
    land.set(LAND_CODE[landing]);
  }, [landing, land, total]);
  useAnimatedReaction(
    () => splashStory.get() >= DECIDE_AT,
    (now, before) => {
      if (now && !before) scheduleOnRN(setReady, true);
    },
  );

  // 商标刚成形、画面静止的那一刻：放行页面上重的内容和落位用的画布。这时卡一下，只是商标多停了几帧
  const release = useCallback(() => {
    releaseSplashHold();
    setReleased(true);
  }, []);
  useAnimatedReaction(
    () => splashStory.get() >= SCENE_T.raster[1],
    (now, before) => {
      if (now && !before) scheduleOnRN(release);
    },
  );

  // 商标已经完成、还不知道落到哪：最多等一会儿
  const onMarkDone = useCallback(() => {
    setTimeout(() => setWaited(true), HOLD_MS);
  }, []);
  useAnimatedReaction(
    () => splashStory.get() >= MARK_DONE,
    (now, before) => {
      if (now && !before) scheduleOnRN(onMarkDone);
    },
  );

  // ------------------------------------------------------------ 时钟
  const pathname = usePathname();
  // 数一下帧（见 REPORT）
  const frames = useSharedValue({
    n: 0,
    late: 0,
    // 安卓播视频时：这一层自己慢了、但屏幕上只有视频在动的那些帧（看不出来，单独数）
    unseen: 0,
    worst: 0,
    where: [] as string[],
  });
  // 置 1 = 已经收场，时钟不再往前走
  const over = useSharedValue(0);
  const finished = useRef(false);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    over.set(1);
    releaseSplashHold();
    if (REPORT) {
      const v = frames.get();
      if (v.n > 0)
        console.log(
          `[splash] ${videoFate.current === "played" ? "路线段播视频，" : videoFate.current === "dropped" ? "视频没放成、路线段逐帧画，" : ""}${v.n} 帧，其中超过 25 毫秒的 ${v.late} 帧，最慢一帧 ${v.worst.toFixed(0)} 毫秒` +
            (v.where.length
              ? `；出现在（故事时间:毫秒）${v.where.join(" ")}`
              : "") +
            (v.unseen
              ? `；另有 ${v.unseen} 帧慢在只有视频在动的时候（看不出来）`
              : ""),
        );
    }
    // 先让页面上被这一层代画的那几样东西露出来，隔两帧再把这一层卸掉：两边画的是同一个位置的同一样东西，
    // 顺序反了才会闪一下空白。这两帧里这一层停在最后一帧不动
    releaseSplashPage();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        scheduleOnUI(releaseRouteScene);
        scheduleOnUI(releaseDeviceLanding);
        onDone();
      }),
    );
  }, [frames, over, onDone]);
  // 卸掉之后故事时间才归位（见 bus.ts 的 releaseSplashPage）
  useEffect(() => endSplashStory, []);
  // 保险：这一层盖着整个 App、还挡着触摸，无论哪一步出了岔子（时钟没走、哪个等待没回来），
  // 到时限都必须让开——求救页和其它页面不能被它挡住
  useEffect(() => {
    const id = setTimeout(finish, WATCHDOG_MS);
    return () => clearTimeout(id);
  }, [finish]);
  const begun = useRef(false);
  const started = useRef(false);
  // 视频放不了（文件读不到、这台手机解不了、迟迟不走）：退回画布逐帧画的那条路
  const dropVideo = useCallback((): Promise<void> => {
    if (!videoLive.current) return Promise.resolve();
    videoLive.current = false;
    videoFate.current = "dropped";
    setVideoOn(false);
    if (REPORT) console.log("[splash] 视频没放成，退回逐帧画");
    return Promise.race([loadRouteFrames(), wait(FRAMES_WAIT_MS)]).then(() =>
      videoMode.set(0),
    );
  }, [videoMode]);
  // 播放器报错。还没备好时出的错多半是一时的：华为 P30 Pro 上四十多次冷启动里遇到两次
  // （「Unexpected runtime error」），换一个播放器马上就好了。所以先换播放器重试，最多两次，还不行才退回逐帧画
  // （退回去能播完，但那一段在华为上只有 30 帧 / 秒）
  const onVideoFail = useCallback(
    (why?: string) => {
      if (!videoLive.current) return;
      if (REPORT) console.log(`[splash] 视频报错：${why ?? "原因不明"}`);
      if (!videoReady.current && !started.current && videoTry < VIDEO_RETRIES) {
        setVideoTry(videoTry + 1);
        return;
      }
      videoGate.open(false);
      void dropVideo();
    },
    [dropVideo, videoGate, videoTry],
  );
  const playVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video || !videoLive.current) {
      void dropVideo();
      return;
    }
    video.play();
    const from = performance.now();
    const poll = () => {
      if (finished.current || !videoLive.current) return;
      const at = video.position();
      if (at >= VIDEO_SYNC_AT) {
        videoZero.set(Date.now() - at);
        if (REPORT)
          console.log(
            `[splash] 视频起步 ${Math.round(performance.now() - from - at)} 毫秒`,
          );
        return;
      }
      if (performance.now() - from > VIDEO_START_MS) void dropVideo();
      else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }, [dropVideo, videoZero]);
  const endVideo = useCallback(() => {
    videoLive.current = false;
    setVideoOn(false);
  }, []);
  // 画布已经接过去了。视频这时自己放完了（片尾只垫了几帧），画面也已经被挪到屏幕外（见 videoStyle）；
  // 这一层留到开屏收场再卸
  const videoDone = useCallback(() => {
    if (!videoLive.current) return;
    videoLive.current = false;
    videoFate.current = "played";
  }, []);
  useAnimatedReaction(
    () =>
      videoMode.get() === 1 &&
      splashStory.get() > MARK_DONE + VIDEO_HANDOVER + 60,
    (now, before) => {
      if (now && !before) scheduleOnRN(videoDone);
    },
  );
  // 起步前的那一小会儿：连续按时到达了几帧、已经等了多久
  const leadGood = useSharedValue(0);
  const leadWaited = useSharedValue(0);
  // 开播之前盖在最上面的那层底色（下面在预热）。由时钟在真正起步的那一帧撤掉：那时画布早已换回第一帧，
  // 撤早了会把预热时画的最后一帧露出来闪一下（2026-10-08 逐帧检查时见到）
  const cover = useSharedValue(1);
  const clock = useFrameCallback((info) => {
    if (over.get()) return;
    if (leadGood.get() < LEAD_FRAMES && leadWaited.get() < LEAD_MAX_MS) {
      // 原生启动画面刚收掉、这一层刚换成播放状态，主线程还要忙一两帧。停在第一帧上等画面稳下来
      // （连续几帧都按时到）再起步，开头就不会卡
      const raw = info.timeSincePreviousFrame ?? 0;
      leadGood.set(raw > 0 && raw < 22 ? leadGood.get() + 1 : 0);
      leadWaited.set(leadWaited.get() + raw);
      return;
    }
    if (videoMode.get()) {
      // 安卓：路线段是视频在放，时钟跟着它走。先叫它开始，等它报回「第 0 毫秒落在哪一刻」，
      // 时钟就从视频此刻的位置起步（正片前垫着 VIDEO_PRE_MS 的底色，这一段里屏幕上没有变化）
      const zero = videoZero.get();
      if (zero === 0) {
        if (videoStage.get() === 0) {
          videoStage.set(1);
          scheduleOnRN(playVideo);
        }
        return;
      }
      if (videoStage.get() < 2) {
        videoStage.set(2);
        real.set(Date.now() - zero - VIDEO_PRE_MS);
        return;
      }
    }
    if (cover.get()) cover.set(0);
    const raw = info.timeSincePreviousFrame ?? 16;
    if (REPORT) {
      // 视频模式下，商标原图开始显出来之前这一层上什么都没有（画面全是下面那层视频，由系统单独合成），
      // 这时这一层慢一帧屏幕上看不出来
      const unseen =
        videoMode.get() === 1 && splashStory.get() < SCENE_T.raster[0];
      frames.modify((v) => {
        "worklet";
        v.n += 1;
        if (raw > 25 && unseen) v.unseen += 1;
        else if (raw > 25) {
          v.late += 1;
          if (v.where.length < 16)
            v.where.push(`${Math.round(splashStory.get())}:${Math.round(raw)}`);
        }
        if (!unseen && raw > v.worst) v.worst = raw;
        return v;
      });
    }
    // 卡了一下（页面在底下挂载）不把动画跳过去：一帧最多走 50 毫秒。
    // 视频里线还在动的那一段例外：它不等人，时钟按实际过去的时间走才对得上。商标成形（原图盖满）之后
    // 视频就停在最后一个画面上了，这时正好放行页面上重的内容、最容易卡，时钟晚一点没关系，照旧不跳
    const free = videoMode.get() === 1 && splashStory.get() < SCENE_T.raster[1];
    let r = real.get() + (free ? raw : Math.min(raw, 50));
    let s = storyAt(warp, r);
    if (land.get() === LAND_NONE && s > MARK_DONE) {
      r = warp[MARK_DONE];
      s = MARK_DONE;
    }
    real.set(r);
    splashStory.set(s);
    if (s >= total.get()) {
      over.set(1);
      scheduleOnRN(finish);
    }
  }, false);

  const warm = useSharedValue(-1);
  const begin = useCallback(() => {
    if (begun.current) return;
    begun.current = true;
    // 由通知拉起（多半是求救 / 摔倒提醒）：不播，直接把页面露出来
    if (launchedByNotification()) {
      SplashScreen.hide();
      finish();
      return;
    }
    // 原生启动画面现在就收掉：它和这一层在开播前的样子一样，都是一片深色。它不收，系统就不让 App
    // 画第一帧，画布的显示表面建不出来，预热也做不了
    SplashScreen.hide();
    const t0 = performance.now();
    const warmUp = async (which: readonly number[]) => {
      for (const i of which) {
        if (started.current) break;
        warm.set(i);
        await twoFrames();
      }
      warm.set(-1);
    };
    const pictures = () => {
      const framesIn = loadRouteFrames();
      void framesIn.then((ok) => {
        if (ok) void warmUp(WARM_FRAMES);
      });
      return Promise.race([framesIn, wait(FRAMES_WAIT_MS)]);
    };
    // 路线段备好：iOS 是预录帧读进来；安卓是视频的第一帧显示出来（没等到就退回预录帧）
    const routeIn = videoLive.current
      ? Promise.race([
          videoGate.ready,
          wait(VIDEO_WAIT_MS).then(() => false),
        ]).then((ok) => {
          if (REPORT)
            console.log(
              `[splash] 视频${ok ? "备好" : "没备好"}，用了 ${Math.round(performance.now() - t0)} 毫秒`,
            );
          // 视频模式下预热的是商标完成之后画布要画的那一帧（见 route-scene-view）
          if (ok) return warmUp([0]);
          return dropVideo().then(pictures);
        })
      : pictures();
    Promise.all([
      AccessibilityInfo.isReduceMotionEnabled().catch(() => false),
      routeIn,
      Promise.race([
        whenPageReady(),
        new Promise((done) => setTimeout(done, PAGE_WAIT_MS)),
      ]).then(() => whenJsQuiet(START_BUDGET_MS - (performance.now() - t0))),
    ]).then(([reduce]) => {
      // 系统开了「减弱动态效果」：不播路线，从完成的商标和品牌名开始，停一下就淡出
      if (reduce) {
        real.set(warp[MARK_DONE]);
        setReduceMotion(true);
        // 不播路线，视频也就用不上
        endVideo();
        videoMode.set(0);
      }
      splashOn.set(1);
      splashStory.set(reduce ? MARK_DONE : 0);
      started.current = true;
      warm.set(-1);
      setPhase("play");
      clock.setActive(true);
    });
  }, [
    clock,
    dropVideo,
    endVideo,
    finish,
    real,
    videoGate,
    videoMode,
    warp,
    warm,
  ]);

  // 播到一半进了求救页（推送 / 实时通道把人带过去的）：立刻收掉
  useEffect(() => {
    if (phase === "play" && pathname.startsWith("/sos-active")) finish();
  }, [phase, pathname, finish]);

  // 画布上已经没有东西了（线收完、商标周围的光也收掉了）：卸掉画布。去登录页时画布还要负责露出页面，留到最后
  useAnimatedReaction(
    () => {
      const l = land.get();
      const t = splashStory.get();
      if (l === LAND_DEVICE) return t > DEVICE.hand + 260;
      if (l === LAND_UNBOUND) return t > UNBOUND.start + 180;
      return false;
    },
    (now, before) => {
      if (now && !before) scheduleOnRN(setSceneOn, false);
    },
  );

  // 屏幕顶上还是开屏的深色画面时，系统状态栏（时间、电量、信号）用浅色字。根布局那一份跟着 App 的外观走，
  // 浅色外观下是深色字，压在这几秒的深色画面上看不清（2026-10-08 华为实测后补的）。这一份后挂载、会盖过它；
  // 页面在顶上露出来的那一刻撤掉，状态栏就回到根布局那一份
  const [darkTop, setDarkTop] = useState(true);
  useAnimatedReaction(
    () => {
      const l = land.get();
      const t = splashStory.get();
      // 深色画面淡到一半的时候换；从这里喊到状态栏真的换过来还要两三帧，所以喊得早一点
      if (l === LAND_DEVICE) return t > DEVICE.hand + 20;
      if (l === LAND_UNBOUND) return t > UNBOUND.start + 20;
      if (l === LAND_PLAIN) return t > PLAIN_FADE_FROM + 90;
      // 登录页是从下往上涌出来的：波浪的边快到屏幕顶才算
      if (l === LAND_LOGIN) return loginReveal(t) > 0.93;
      return false;
    },
    (now, before) => {
      if (now && !before) scheduleOnRN(setDarkTop, false);
    },
  );

  // 设备页：表盘到位后，页面上真的那块大图渐渐接手（之前一直由 DeviceLanding 画着替身）
  const markTaken = useSharedValue(0);
  useAnimatedReaction(
    () =>
      splashOn.get() && land.get() === LAND_DEVICE
        ? 1 - smooth((splashStory.get() - DEVICE.give) / 200)
        : -1,
    (owned) => {
      if (owned >= 0) anchorOwned.hero.set(owned);
    },
  );

  // 引导页：商标落到卡片左上角之后，换成页面上真的那枚徽标
  useAnimatedReaction(
    () =>
      splashOn.get() && land.get() === LAND_UNBOUND
        ? 1 - smooth((splashStory.get() - UNBOUND.start - UNBOUND.swap) / 120)
        : -1,
    (owned) => {
      if (owned >= 0) anchorOwned.guideEmblem.set(owned);
    },
  );

  // ------------------------------------------------------------ 逐帧的样子
  const glow = useDerivedValue<MarkGlow>(() => {
    const t = splashStory.get();
    const l = land.get();
    const dock = glowDockAt(l, t);
    let gx = SCENE_W / 2;
    let gy = height / k / 2 - MARK_LIFT;
    let scale = 1;
    let breath = 0;
    let pulse = -1;
    if (l === LAND_LOGIN) {
      breath = loginBreath(t);
      pulse = (t - LOGIN.pulse[0]) / (LOGIN.pulse[1] - LOGIN.pulse[0]);
      const a = anchorRect.loginMark.get();
      const tx = a ? (a.x + a.w / 2) / k : SCENE_W / 2;
      const ty = a ? (a.y + a.h / 2) / k : height / k / 4 - MARK_LIFT;
      const ts = a ? a.w / size : 0.44;
      gx = lerp(gx, tx, dock) - 9 * Math.sin(Math.PI * dock) * (1 - dock);
      gy = lerp(gy, ty, dock);
      scale = lerp(1, ts, dock) + 0.016 * breath;
    } else if (l === LAND_DEVICE) {
      scale = lerp(
        1,
        DEVICE.tuckScale,
        smoother((t - DEVICE.tuck[0]) / (DEVICE.tuck[1] - DEVICE.tuck[0])),
      );
    }
    return { cx: gx, cy: gy, scale, dock, breath, pulse };
  });
  const reveal = useDerivedValue(() =>
    land.get() === LAND_LOGIN ? loginReveal(splashStory.get()) : 0,
  );

  const coverStyle = useAnimatedStyle(() => ({ opacity: cover.get() }));
  // 安卓：画布接手之后把视频那一层整块挪到屏幕外，而不是卸掉。卸掉它（连同放掉播放器）要在主线程上等解码器
  // 交还显示表面，是几十毫秒的一顿，正落在商标收小、品牌名浮出来的时候（2026-10-08 模拟器上每次都卡 50–80 毫秒）；
  // 挪走不用等。视频的显示表面垫在窗口后面，不挪走的话后面画布淡出时露出来的会是它，不是页面
  const videoStyle = useAnimatedStyle(() =>
    steady("splash.video", {
      transform: [
        {
          translateY:
            splashStory.get() > MARK_DONE + VIDEO_HANDOVER + 60
              ? 2 * height
              : 0,
        },
      ],
    }),
  );
  // 画布出第一帧之前、以及整段路线期间，下面垫一层同色的底，免得露出页面
  const backingStyle = useAnimatedStyle(() => ({
    opacity: splashStory.get() < SCENE_T.raster[0] ? 1 : 0,
  }));
  const sceneStyle = useAnimatedStyle(() => {
    const t = splashStory.get();
    const l = land.get();
    if (l === LAND_DEVICE)
      return { opacity: 1 - smooth((t - DEVICE.hand + 80) / 320) };
    if (l === LAND_UNBOUND)
      return { opacity: 1 - smooth((t - UNBOUND.start) / 160) };
    if (l === LAND_PLAIN)
      return { opacity: 1 - smooth((t - PLAIN_FADE_FROM) / 300) };
    return { opacity: 1 };
  });

  const markStyle = useAnimatedStyle(() => {
    const t = splashStory.get();
    const l = land.get();
    const g = glow.get();
    let opacity = rasterOpacityAt(t);
    let rotate = 0;
    let dx = (g.cx - SCENE_W / 2) * k;
    let dy = g.cy * k - cy;
    let scale = g.scale;
    if (l === LAND_DEVICE) {
      // 扫描一开始，商标就交给表盘那块画布去画（它要从中心把商标擦掉）。画布那边没准备好
      // （头盔的数据或图片还没到）就退一步：随扫描缩一点、淡掉
      const wipe = deviceWipe(t);
      if (markTaken.get()) opacity = wipe > 0 ? 0 : opacity;
      else {
        opacity *= 1 - smooth((wipe - 0.15) / 0.6);
        scale *= 1 - 0.06 * wipe;
      }
    } else if (l === LAND_UNBOUND) {
      // 沿一道弧落到卡片左上角，成为卡片上的徽标
      const u = t - UNBOUND.start;
      const gl = glideTo((u - 70) / 760);
      const a = anchorRect.guideEmblem.get();
      const arc = Math.sin(Math.PI * gl) * -26 * k;
      if (a) {
        dx = lerp(0, a.x + a.w / 2 - cx, gl) + arc * 0.6;
        dy = lerp(0, a.y + a.h / 2 - cy, gl) + arc;
        scale = lerp(1, a.w / size, gl);
      }
      rotate = -8 * Math.sin(Math.PI * gl);
      opacity *= 1 - smooth((u - UNBOUND.swap) / 120);
    } else if (l === LAND_PLAIN) {
      opacity *= 1 - smooth((t - PLAIN_FADE_FROM) / 300);
    }
    return steady("splash.mark", {
      opacity,
      transform: [
        { translateX: dx },
        { translateY: dy },
        { rotate: `${rotate}deg` },
        { scale },
      ],
    });
  });

  // 品牌名：商标下面两行。去登录页时两行一起上移，英文淡掉，中文那一行变大、变亮，成为登录页的标题。
  // 中文那一行按标题的字号排版、缩小着显示，落位时放大到原大，中心对到页面标题的中心
  const pageTitle = t("auth.appName");
  const brandZh = /[\u4e00-\u9fff]/.test(pageTitle) ? pageTitle : BRAND_ZH;
  const wordsTop = cy + (210 - MARK_SIZE / 2) * k;
  const zhRest = wordsTop + 12 * k * 1.25 + 11 * k;
  const titleSize = LOGIN_BRAND.titleSize(width);
  const titleSpacing = LOGIN_BRAND.titleSpacing(width);
  const titleMove = useDerivedValue(() => {
    const dock = land.get() === LAND_LOGIN ? loginDock(splashStory.get()) : 0;
    const a = anchorRect.loginTitle.get();
    const small = (11 * k) / titleSize;
    const rest = zhRest + (11 * k * 1.3) / 2;
    const scale = lerp(small, 1, dock);
    const centre = lerp(rest, a ? a.y + a.h / 2 : rest - 82 * k, dock);
    // 这一行的上沿挪了多少：英文那一行贴着它一起走，两行不会交叉
    return {
      dock,
      scale,
      centre,
      lift: centre - titleSize * 0.65 * scale - zhRest,
    };
  });
  const enStyle = useAnimatedStyle(() => {
    const t = splashStory.get();
    const l = land.get();
    const shown = lockupAt(l, t);
    const m = titleMove.get();
    let opacity = shown * (1 - smooth(m.dock / 0.8));
    if (l === LAND_PLAIN) opacity *= 1 - smooth((t - PLAIN_FADE_FROM) / 300);
    return steady("splash.en", {
      opacity,
      transform: [{ translateY: (1 - shown) * 7 * k + m.lift }],
    });
  });
  const zhStyle = useAnimatedStyle(() => {
    const t = splashStory.get();
    const l = land.get();
    const shown = lockupAt(l, t);
    const m = titleMove.get();
    let opacity = shown;
    if (l === LAND_PLAIN) opacity *= 1 - smooth((t - PLAIN_FADE_FROM) / 300);
    // 页面标题和品牌名写法不一样（非中文界面）：落位途中这一行淡出，标题那一行淡入
    if (brandZh !== pageTitle) opacity *= 1 - smooth((m.dock - 0.2) / 0.5);
    return steady("splash.zh", {
      opacity,
      letterSpacing: lerp(
        (3 * k) / ((11 * k) / titleSize),
        titleSpacing,
        m.dock,
      ),
      color: `rgb(${Math.round(174 + 81 * m.dock)},${Math.round(180 + 75 * m.dock)},${Math.round(192 + 63 * m.dock)})`,
      transform: [
        { translateY: m.centre - titleSize * 0.65 + (1 - shown) * 7 * k },
        { scale: m.scale },
      ],
    });
  });
  const titleStyle = useAnimatedStyle(() => {
    const m = titleMove.get();
    return steady("splash.title", {
      opacity: smooth((m.dock - 0.3) / 0.5),
      transform: [
        { translateY: m.centre - titleSize * 0.65 },
        { scale: m.scale },
      ],
    });
  });

  // 还没开播（boot）时就把整套东西搭好，上面盖一层和原生启动画面同色的底：画布和图片的初始化、
  // 预热都在这时做完，开播后的头几帧就不会被它们拖慢
  return (
    <View
      style={styles.overlay}
      onLayout={begin}
      onStartShouldSetResponder={blockTouches}
    >
      {darkTop && <StatusBar style="light" />}
      <Animated.View
        pointerEvents="none"
        style={[styles.fill, styles.solid, backingStyle]}
      />
      {videoOn && (
        <Animated.View pointerEvents="none" style={[styles.fill, videoStyle]}>
          <RouteVideoLayer
            key={videoTry}
            ref={videoRef}
            onReady={() => {
              videoReady.current = true;
              videoGate.open(true);
            }}
            onFail={onVideoFail}
          />
        </Animated.View>
      )}
      {sceneOn && (
        <Animated.View pointerEvents="none" style={[styles.fill, sceneStyle]}>
          <RouteSceneView
            width={width}
            height={height}
            story={splashStory}
            glow={glow}
            reveal={reveal}
            warm={warm}
            videoMode={videoMode}
          />
        </Animated.View>
      )}
      {landing === "device" && released && (
        <DeviceLanding
          width={width}
          height={height}
          hero={hero}
          mark={markImage}
          helmet={helmetImage}
          markTaken={markTaken}
        />
      )}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.mark,
          {
            left: cx - size / 2,
            top: cy - size / 2,
            width: size,
            height: size,
          },
          markStyle,
        ]}
      >
        <Image
          source={require("@/assets/images/company-mark-solid.webp")}
          style={styles.fill}
          contentFit="contain"
        />
      </Animated.View>
      <Animated.Text
        allowFontScaling={false}
        style={[
          styles.en,
          { top: wordsTop, fontSize: 12 * k, letterSpacing: 1.1 * k },
          enStyle,
        ]}
      >
        {BRAND_EN}
      </Animated.Text>
      <Animated.Text
        allowFontScaling={false}
        style={[
          styles.zh,
          { fontSize: titleSize, lineHeight: titleSize * 1.3 },
          zhStyle,
        ]}
      >
        {brandZh}
      </Animated.Text>
      {landing === "login" && brandZh !== pageTitle && (
        <Animated.Text
          allowFontScaling={false}
          style={[
            styles.zh,
            styles.title,
            {
              fontSize: titleSize,
              lineHeight: titleSize * 1.3,
              letterSpacing: titleSpacing,
            },
            titleStyle,
          ]}
        >
          {pageTitle}
        </Animated.Text>
      )}
      {/* 开播之前盖一层底色：下面在预热，不该被看见 */}
      <Animated.View
        pointerEvents="none"
        style={[styles.fill, styles.solid, coverStyle]}
      />
    </View>
  );
}

function blockTouches(): boolean {
  return true;
}

function glideTo(v: number): number {
  "worklet";
  const p = clamp01(v);
  const end = 1 - Math.exp(-7) * 8;
  return (1 - Math.exp(-7 * p) * (1 + 7 * p)) / end;
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 1000 },
  fill: { ...StyleSheet.absoluteFill },
  solid: { backgroundColor: SCENE_BG },
  mark: { position: "absolute" },
  en: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    color: "#F4F5F7",
    fontWeight: "500",
  },
  zh: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    textAlign: "center",
    fontWeight: "400",
  },
  title: { color: "#FFFFFF" },
});
