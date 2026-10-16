// SOS 倒计时全屏页（API.md §7；决策 #8：服务端权威——App 只按 deadline 渲染，
// 取消/立即求救调 API，最终状态以服务端推送/响应为准，本地绝不判断超时）
// 界面按画板「求救倒计时」（2026-10-08 定稿）：环形倒计时 + 将通知谁 + 立即求救 + 向右滑动取消；
// 最后 10 秒整页转红；结束后是「已取消」，或带每位联系人发送结果的「已通知」。
// 这次换的是界面。服务端权威的状态与轮询、警报音、亮屏、Android 返回键拦截、锁屏提醒的撤销、
// 通知按钮取消在路上的显示、演练模式、补传旧事件的说明都照原样；多出来的只有三处：
// 最后 10 秒的震动改成连着两下、读联系人和通知记录来显示、已取消后的「我还是需要帮助」。
// 演练模式（?drill=1）：同一页面、同样的警报音/振动/倒计时，但**不碰服务端、不通知任何人**——
// 新用户先见过一次求救长什么样，真出事时才敢按、也知道怎么取消。顶部常驻醒目标记避免混淆。
// 多顶头盔同时求救（10-16 N10，负责人定稿）：倒计时页只开一张，顶部按到期先后排一排头盔胶囊、点胶囊切换；
// 两顶时写「XX 也在倒计时」、更多写「还有 N 顶正在报警」；当前这单结束后页内提示一句并自动切到下一单；
// 全部结束才进结果页按头盔逐条列结论；两单以上时多「全部立即求救 / 全部取消」。队列从缓存推导（services/sos-queue）。
import { Ionicons } from "@expo/vector-icons";
import {
  type Query,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  AppState,
  BackHandler,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { devLog } from "@/services/dev-log";
import { serverNow } from "@/services/server-clock";
import {
  countdownPollInterval,
  presentedSos,
  settleSnapshot,
} from "@/services/sos-sync";
import { useSosCancelStore } from "@/stores/sos-cancel-store";
import type {
  AccidentDetail,
  EventEnvelope,
  EventType,
  Sos,
} from "@helmet/shared";

import { ApiRequestError } from "@/api/client";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { clearSosAlert } from "@/services/sos-alert";
import { toUserMessage } from "@/api/error-messages";
import { buildRelayEnvelope, relayApi } from "@/api/relay";
import { sosApi } from "@/api/sos";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { CountdownRing } from "@/components/countdown-ring";
import { SlideToCancel } from "@/components/slide-to-cancel";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useKeepAwakeSafe } from "@/hooks/use-keep-awake-safe";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import {
  enqueueRelayEvent,
  notifyCriticalAccepted,
} from "@/services/ble-relay-uplink";
import { msToNextSecond, shownSeconds } from "@/services/countdown";
import { lateEventNote } from "@/services/sos-age";
import {
  activeSosQueue,
  MAX_CHIPS,
  nextSos,
  sosScreen,
} from "@/services/sos-queue";
import { helmetNameOf } from "@/services/safety-status";
import {
  deliveryPollInterval,
  deliveryStateOf,
  initialOf,
  smsRows,
} from "@/services/sos-delivery";
import { contactNameOf } from "@/services/user-name";
import { showNotice } from "@/services/notice";

/** 读屏（VoiceOver / TalkBack）开没开 */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((v) => {
      if (alive) setOn(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      setOn,
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

function secondsLeft(deadline: string, now: number): number {
  return shownSeconds(Math.ceil((new Date(deadline).getTime() - now) / 1000));
}

/** 环走一圈对应的秒数（服务端的倒计时是 60 秒，决策 #8） */
const TOTAL_SECONDS = 60;
/** 最后这么多秒整页转红、震动改成连着两下 */
const URGENT_SECONDS = 10;
/** 求救的红。白字压在上面对比度 4.8 : 1（设计规范），比主题里的 danger 深一档 */
const SOS_RED = "#D92D25";
const SOS_RED_BEAT = "#B8241D";

/** 这一页的颜色：平时跟着外观走；最后 10 秒整页红底，深浅外观是同一套 */
function paletteOf(
  theme: ReturnType<typeof useTheme>,
  dark: boolean,
  urgent: boolean,
) {
  if (urgent) {
    return {
      text: "#FFFFFF",
      sub: "#FFFFFF",
      alert: "#FFFFFF",
      alertBg: "rgba(0,0,0,0.22)",
      alertBorder: "rgba(255,255,255,0.55)",
      num: "#FFFFFF",
      sosBtn: "#FFFFFF",
      onSosBtn: SOS_RED,
      ring: "#FFFFFF",
      ringTrack: "rgba(0,0,0,0.30)",
      chip: "rgba(0,0,0,0.28)",
      avatarBg: "#FFFFFF",
      avatarText: SOS_RED,
      slide: {
        track: "rgba(0,0,0,0.28)",
        trackBorder: "transparent",
        fill: "rgba(255,255,255,0.22)",
        thumb: "#FFFFFF",
        thumbIcon: SOS_RED,
        text: "#FFFFFF",
        hint: "#FFFFFF",
      },
    };
  }
  // 浅色下的红比主题的 danger 深：这一页的红字是大号数字和提示框，要压得住浅灰底
  const alert = dark ? theme.danger : "#B93229";
  return {
    text: theme.text,
    sub: theme.textSecondary,
    alert,
    alertBg: dark ? theme.dangerBg : "rgba(185,50,41,0.10)",
    alertBorder: dark ? "rgba(242,109,95,0.5)" : "rgba(185,50,41,0.45)",
    num: alert,
    sosBtn: SOS_RED,
    onSosBtn: "#FFFFFF",
    ring: SOS_RED,
    ringTrack: dark ? theme.backgroundSelected : "#E3E6EA",
    chip: theme.backgroundSelected,
    avatarBg: dark ? "rgba(255,255,255,0.14)" : "rgba(17,24,39,0.10)",
    avatarText: theme.text,
    slide: {
      track: theme.backgroundSelected,
      trackBorder: dark ? "transparent" : theme.borderStrong,
      fill: theme.successBg,
      thumb: theme.text,
      thumbIcon: theme.background,
      text: theme.text,
      hint: theme.textSecondary,
    },
  };
}

// 真实的单共用一个实例（多顶同时求救时在页内切换，10-16 N10）；演练单独一个。
// 「我还是需要帮助」的 eventId 按头盔号存，换单不会复用上一单的 eventId 被服务端当重复事件吞掉
export default function SosActiveScreen() {
  const { drill } = useLocalSearchParams<{ drill?: string }>();
  return <SosActiveContent key={drill === "1" ? "drill" : "sos"} />;
}

/** 服务端明确说没有这一单（404） */
const isNotFound = (e: unknown) =>
  e instanceof ApiRequestError && e.status === 404;

function SosActiveContent() {
  const {
    sosId: routeSosId,
    deviceId,
    drill,
  } = useLocalSearchParams<{
    sosId: string;
    deviceId: string;
    drill?: string;
  }>();
  const isDrill = drill === "1";
  // 页内当前看的是哪一单：进来时是路由给的；点另一单的通知（_layout 把参数改写成那一单）、点顶部胶囊、
  // 当前这单结束后自动切下一单，都只换这个
  const [selected, setSelected] = useState(routeSosId);
  const [routeSeen, setRouteSeen] = useState(routeSosId);
  if (routeSosId !== routeSeen) {
    setRouteSeen(routeSosId);
    if (routeSosId) setSelected(routeSosId);
  }
  const sosId = selected ?? routeSosId;
  // 在屏上期间新到的单只进队列，不再叠一页（use-realtime 的 openCountdown 看这个）
  useEffect(() => {
    if (isDrill) return;
    sosScreen.mounted = true;
    return () => {
      sosScreen.mounted = false;
    };
  }, [isDrill]);
  // 从安全页 / 安全记录 / 事故详情用 navigate 打开的倒计时页没登记过：之后 WS 重连、推送到达、中转 duplicate 回调
  // 走 resumePendingSos 会判「没拉起过」再 push 同一单，expo-router 的 singular 逻辑把已有路由移除再以同 key 追加——
  // 倒计时中无谓改栈（10-15 复审 F-2）。真实单挂载即登记，三处入口自然覆盖
  useEffect(() => {
    if (!isDrill && sosId) presentedSos.current.add(sosId);
  }, [isDrill, sosId]);
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"cancel" | "confirm" | null>(null);
  // 通知按钮的取消还在路上（被杀状态下点「我没事，取消」拉起 App，页面要过启动动画才出来）：
  // 按钮显示「取消中…」、不响警报，别让用户对着一个还在倒数的页面以为刚才那一下没算数
  const cancellingFromNotification = useSosCancelStore(
    (s) => !!s.inFlight[sosId],
  );
  const cancelBusy = busy === "cancel" || cancellingFromNotification;
  /** 当前时刻作为被读取的 state：剩余秒数在渲染期由它算出。
   *  不能用"空转 tick（值不读）强制重渲染"——React Compiler 判定无依赖变化会 memo 掉
   *  整个渲染，倒计时数字永远停在首帧（2026-08-17 真机实证）。 */
  // 用服务端时钟：deadline 是服务端给的，手机时钟快 90 秒的话一打开就显示 0（B 线 10-06 评审 F-3）
  const [now, setNow] = useState(() => serverNow());
  /** 演练：本地 60 s deadline + 本地状态；到期在渲染期推导为 notified（真实模式由服务端判定） */
  const [drillState, setDrillState] = useState<{
    deadline: string;
    status: "pending" | "cancelled" | "notified";
  }>(() => ({
    deadline: new Date(serverNow() + 60_000).toISOString(),
    status: "pending",
  }));

  // WS 推送直写 ['sos', sosId] 缓存；进页面时再以 REST 兜底拉一次权威状态
  const sosQuery = useQuery({
    queryKey: ["sos", sosId],
    queryFn: async () => {
      try {
        // 切到别的单时路由里的 deviceId 是第一单的，用缓存里这一单自己的头盔号（没有就不传，直接查事故记录）
        const own =
          queryClient.getQueryData<Sos>(["sos", sosId])?.deviceId ??
          (sosId === routeSosId ? deviceId : undefined);
        return settleSnapshot(
          queryClient,
          sosId,
          await sosApi.snapshot(sosId, own),
        );
      } catch (e) {
        // 服务端明确说没有这一单（404：单号是瞎编的 / 不是你的头盔）——不是「状态未知」，交给页面收掉。
        // 原来一律当未知，一个假链接 lingyizhixing://sos-active?sosId=xxx 就能打开一张永远停在「—」秒的倒计时页（2026-10-15）
        if (e instanceof ApiRequestError && e.status === 404) throw e;
        // 两条 REST 都失败（离线）才信缓存；有网时缓存可能是迟到的 pending（2026-09-24 实测卡死）
        return (
          (queryClient.getQueryData(["sos", sosId]) as Sos | undefined) ?? null
        );
      }
    },
    // WS 断线时的兜底；正常时由推送更新缓存。单子结束后停止轮询——结束态不会再变，
    // 而 snapshot 一次是两个请求（评审 2026-09-26）。状态未知（null）不算结束，见 sos-sync
    refetchInterval: (q) =>
      isNotFound(q.state.error) ? false : countdownPollInterval(q.state.data),
    retry: (n, e) => !isNotFound(e) && n < 1,
    enabled: !isDrill,
  });
  const drillSos: Sos | null = isDrill
    ? {
        sosId: "drill",
        deviceId: deviceId ?? "",
        triggerEventId: "drill",
        triggerType: "manual_sos",
        status:
          drillState.status === "pending" &&
          now >= new Date(drillState.deadline).getTime()
            ? "notified"
            : drillState.status,
        deadline: drillState.deadline,
        createdAt: drillState.deadline,
        updatedAt: drillState.deadline,
      }
    : null;
  const sos = isDrill ? drillSos : (sosQuery.data ?? null);

  // 进行中的队列从缓存推导（["sos-active", *] 由 WS 推送 / 补拉写入）；缓存一变就重算一次
  const [cacheTick, setCacheTick] = useState(0);
  useEffect(() => {
    if (isDrill) return;
    return queryClient.getQueryCache().subscribe((e) => {
      const k = e.query.queryKey[0];
      if ((k === "sos-active" || k === "sos") && e.type === "updated")
        setCacheTick((n) => n + 1);
    });
  }, [isDrill, queryClient]);
  const queue = isDrill ? [] : activeSosQueue(queryClient, sos);
  const others = queue.filter((q) => q.sosId !== sosId);
  // 这一页处理过的单（头盔号 → 单）：全部结束后按头盔逐条列结论。同一顶头盔新来一单（「我还是需要帮助」
  // 之后的那单）顶掉旧的那条
  const [handled, setHandled] = useState<Record<string, Sos>>({});
  if (!isDrill) {
    // 当前这单用详情缓存里的对象（会变成终态）；队列里没看过的也登记，「全部取消」后结果页才列得全
    // 和当前这单同一顶头盔的不登记：当前这单就代表这顶头盔，两单都登记会在同一个键上来回改、渲染死循环（10-16 评审）
    const add = [
      ...(sos && handled[sos.deviceId] !== sos ? [sos] : []),
      ...queue.filter(
        (q) =>
          q.deviceId !== sos?.deviceId &&
          handled[q.deviceId]?.sosId !== q.sosId,
      ),
    ];
    if (add.length > 0)
      setHandled(
        add.reduce((h, x) => ({ ...h, [x.deviceId]: x }), { ...handled }),
      );
  }

  // 同一顶头盔来了新单，而屏上这单本机还是倒计时：服务端每顶头盔至多一单在倒计时，屏上这单其实已结束、只是终态没收到
  //（WS 断着、10 秒轮询还没跑，或是点了它留在锁屏上的旧通知进来）。立刻拉一次它的权威状态，结束了就照常切到新单
  const supersededBy =
    !isDrill && sos?.status === "pending"
      ? queue.find((q) => q.deviceId === sos.deviceId && q.sosId !== sos.sosId)
          ?.sosId
      : undefined;
  useEffect(() => {
    if (!supersededBy) return;
    void queryClient.refetchQueries({ queryKey: ["sos", sosId], exact: true });
  }, [supersededBy, sosId, queryClient]);

  // 推进"当前时刻"，渲染期据此重算剩余秒数（仅展示用途，超时判定在服务端）。
  // 对着「数字该换的那一刻」去读时钟（services/countdown），不是固定每秒一次：固定间隔时定时器每次晚几毫秒，
  // 数字会偶尔跳过一秒。也不用更密的轮询：一秒只重画一次，页面在两次之间是静止的，
  // 读屏和自动化工具（uiautomator）才读得到这一页
  const deadlineMs = sos ? new Date(sos.deadline).getTime() : Number.NaN;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const wait = Number.isNaN(deadlineMs)
        ? 1000
        : msToNextSecond(deadlineMs, serverNow()) + 30;
      timer = setTimeout(() => {
        setNow(serverNow());
        schedule();
      }, wait);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [deadlineMs]);

  // 倒计时期间保持亮屏——摔倒场景手机可能放在口袋/车把,锁屏会错过取消窗口
  useKeepAwakeSafe("sos-active");

  // 警报音 + 振动:倒计时进行中每秒触发,取消/通知后停止
  const alarm = useAudioPlayer(require("@/assets/sos-alarm.wav"));
  const counting =
    sos != null && sos.status === "pending" && !cancellingFromNotification;
  const deadline = sos?.deadline;
  useEffect(() => {
    if (!counting) return;
    // 警报音绝不能把页面打崩：锁屏/后台时 AVAudioSession 激活可能失败（expo-audio 同步抛
    // "Session activation failed"，Release 下未捕获即整 App 崩溃，2026-09-16 真机实证——
    // 摔倒时手机恰恰在口袋里）。播放失败只记日志，倒计时与取消按钮照常。
    devLog("SOS", "倒计时页开始警报", AppState.currentState);
    const safePlay = () => {
      try {
        alarm.play();
        devLog("SOS", "警报音 play() 已调用");
      } catch (e) {
        devLog("SOS", "警报音播放失败（后台/锁屏音频会话不可用）", e as Error);
      }
    };
    // 先把音频会话设成可后台播放 + 静音键下也响：摔倒告警必须在锁屏状态出声
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    })
      .catch((e) => devLog("SOS", "音频模式设置失败", e as Error))
      .then(safePlay);
    // 每秒重播警报段(0.9s 素材)+ 振动;不用 player.loop——
    // React Compiler 禁止修改 hook 返回对象的属性
    // 最后 10 秒震动改成连着两下（设计规范：警示震感每秒一次，最后 10 秒双击）
    let second: ReturnType<typeof setTimeout> | undefined;
    const warn = () =>
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Warning,
      ).catch(() => {});
    const t = setInterval(() => {
      alarm.seekTo(0).catch(() => {});
      safePlay();
      warn();
      if (deadline && secondsLeft(deadline, serverNow()) <= URGENT_SECONDS) {
        second = setTimeout(warn, 160);
      }
    }, 1000);
    return () => {
      clearInterval(t);
      clearTimeout(second);
      try {
        alarm.pause();
      } catch {
        // 会话已失效时 pause 也可能抛，忽略
      }
    };
  }, [counting, alarm, deadline]);

  const act = (kind: "cancel" | "confirm") => {
    if (isDrill) {
      setDrillState((d) => ({
        ...d,
        status: kind === "cancel" ? "cancelled" : "notified",
      }));
      return;
    }
    setBusy(kind);
    (kind === "cancel" ? sosApi.cancel(sosId) : sosApi.confirm(sosId))
      .then((updated) => {
        queryClient.setQueryData(["sos", sosId], updated);
      })
      .catch((e) => {
        // 这单已经在别处结束（锁屏通知按钮 / 另一台手机 / 到期）：不弹错，拉一次权威状态让页面自己切到结束态
        if (
          e instanceof ApiRequestError &&
          e.code === "SOS_ALREADY_FINALIZED"
        ) {
          void sosQuery.refetch();
          return;
        }
        showNotice(t("common.failed"), toUserMessage(e));
      })
      .finally(() => setBusy(null));
  };

  const left = sos ? secondsLeft(sos.deadline, now) : null;
  const finished = sos && sos.status !== "pending";

  // 页内一句话提示（当前单结束已切到下一单 / 又一顶开始倒计时），4 秒自己消失
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4_000);
    return () => clearTimeout(timer);
  }, [toast]);
  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });
  const nameOf = (id: string) =>
    helmetNameOf(
      devices.data?.find((d) => d.deviceId === id) ?? {
        name: null,
        deviceId: id,
      },
    );
  // 当前这单结束（本页取消 / 立即求救、别处取消、到期通知）且还有别的单在倒数：提示一句、切到最早到期的那单。
  // 没有别的单才停在结果页。新单盖上来（「我还是需要帮助」之后那单）也走这里
  const next = finished ? nextSos(queue, sosId) : null;
  const nextId = next?.sosId ?? null;
  if (!isDrill && next && sos && next.sosId !== selected) {
    // 同一顶头盔的新单（已取消页点了「我还是需要帮助」）：直接切回倒计时，不说「已取消，已切到下一单」
    //（10-16 iPhone：切回时提示写成了「测试头盔1：已取消，已切到下一单」）
    if (next.deviceId !== sos.deviceId)
      setToast(
        t(
          sos.status === "cancelled"
            ? "sos.switchedCancelled"
            : "sos.switchedNotified",
          { name: nameOf(sos.deviceId) },
        ),
      );
    setSelected(next.sosId);
  }
  // 倒数中又来一顶：提示一句（不抢当前这单，用户正在处理它）。见过的单号记在 state 里，渲染期比对
  const [seen, setSeen] = useState<readonly string[]>([]);
  const fresh = queue.filter((q) => !seen.includes(q.sosId));
  if (!isDrill && fresh.length > 0) {
    setSeen([...seen, ...fresh.map((q) => q.sosId)]);
    const other = fresh.find(
      (q) => q.sosId !== sosId && q.deviceId !== sos?.deviceId,
    );
    if (other && seen.length > 0 && !finished)
      setToast(t("sos.newAlarm", { name: nameOf(other.deviceId) }));
  }
  // 全部结束、这一页处理过不止一单：结果页按头盔逐条列结论；已通知的那几单各自读发送结果
  const handledList = Object.values(handled);
  const multiDone = !isDrill && !!finished && !nextId && handledList.length > 1;
  const handledStatus = (h: Sos) =>
    queryClient.getQueryData<Sos>(["sos", h.sosId])?.status ?? h.status;
  // 当前这单的发送结果由下面的 detail 查询管，这里只查其余的（同一个 key 挂两个观察者会互相干扰）
  const otherHandled = handledList.filter((h) => h.sosId !== sosId);
  const handledDetails = useQueries({
    queries: otherHandled.map((h) => ({
      queryKey: ["accident", h.sosId],
      queryFn: () => sosApi.accidentDetail(h.sosId),
      enabled: multiDone && handledStatus(h) === "notified",
      refetchInterval: (q: Query<AccidentDetail>) =>
        deliveryPollInterval(q.state.data?.notifications),
    })),
  });
  // 补传的旧事件点明「约 3 小时前的事件，刚补传到」（决策 #52）；一分钟内不会变档，不用跟着 now 刷
  const lateNote = lateEventNote(sos?.triggeredAt, now);

  // Android 实体返回键：倒计时中不能把这页关进「什么都没有」——关掉后警报停、无提示，
  // 而这单仍登记为「已拉起」，WS / 补拉都不会再弹（10-06 不变式评审 F-4）
  useEffect(() => {
    if (!counting) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [counting]);

  // 本页取消 / 确认成功后立刻撤掉锁屏提醒和预排的「还剩 30 / 10 秒」，不等 WS 推终态
  //（WS 没连上时那两条照样会响，10-06 并发评审 F6）
  useEffect(() => {
    if (finished && !isDrill) void clearSosAlert(sosId);
  }, [finished, isDrill, sosId]);
  // 结束即自动切到下一单的那单没经过上面那条（切换发生在同一次渲染里）：按处理过的单逐个撤，每单只撤一次
  const alertsCleared = useRef(new Set<string>());
  useEffect(() => {
    if (isDrill) return;
    for (const h of Object.values(handled)) {
      const status =
        queryClient.getQueryData<Sos>(["sos", h.sosId])?.status ?? h.status;
      if (status === "pending" || alertsCleared.current.has(h.sosId)) continue;
      alertsCleared.current.add(h.sosId);
      void clearSosAlert(h.sosId);
    }
  }, [isDrill, handled, queryClient, cacheTick]);

  // —— 以下只管界面 ——
  const dark = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  // 开着读屏时和「减弱动态效果」同样处理：环一秒跳一格、背景不跳。
  // Android 上一直在变的 transform 会不停发「内容变了」的无障碍事件，读屏等不到界面静止
  const screenReader = useScreenReader();
  const reducedMotion = useReducedMotion() || screenReader;
  // 这一单还在倒数、只剩最后 10 秒：整页转红
  const urgent = !finished && left !== null && left <= URGENT_SECONDS;
  const P = paletteOf(theme, dark, urgent);

  // 将通知谁：倒计时结束后服务端通知的就是这份紧急联系人。没拿到（加载中 / 失败）≠ 一位都没有
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
  });
  // 发出去之后每位联系人的结果：与事故详情页同一份缓存；还有在发的就隔几秒再看一次
  const detail = useQuery({
    queryKey: ["accident", sosId],
    queryFn: () => sosApi.accidentDetail(sosId),
    enabled: !isDrill && sos?.status === "notified",
    refetchInterval: (q) => deliveryPollInterval(q.state.data?.notifications),
  });
  // 哪顶头盔发起的：账号下有两顶以上时写出来，多顶同时求救时才分得清（2026-10-15 边界测试）。
  // 与设备页同一份设备列表缓存；已解绑查不到名字时写设备号
  const sourceId = sos?.deviceId ?? deviceId;
  const sourceName =
    !isDrill && sourceId && (devices.data?.length ?? 0) >= 2
      ? nameOf(sourceId)
      : null;
  const delivery = deliveryStateOf(detail.data?.notifications);
  const sentTo = smsRows(detail.data?.notifications);

  // 环：每秒匀速走到下一格，看起来是连着走的（60 秒线性）；数字每秒轻跳一下（160 ms）。
  // 只是把剩余秒数画出来，到没到期仍由服务端说了算
  // 一开始就按已知的剩余秒数摆好；这一单的状态还没拿到（数字位置写「—」）时环是空的，不画成满圈
  const ring = useSharedValue(
    left === null ? 0 : Math.max(0, Math.min(1, left / TOTAL_SECONDS)),
  );
  const tick = useSharedValue(1);
  const ringStarted = useRef(false);
  useEffect(() => {
    if (left === null) return;
    const at = (seconds: number) =>
      Math.max(0, Math.min(1, seconds / TOTAL_SECONDS));
    if (!ringStarted.current || reducedMotion) {
      // 刚进来（或系统开了「减弱动态效果」）：直接摆到位，不从满圈扫过来
      ringStarted.current = true;
      ring.set(at(left));
      if (reducedMotion) return;
    }
    ring.set(
      withTiming(at(left - 1), { duration: 1000, easing: Easing.linear }),
    );
    tick.set(1.06);
    tick.set(withTiming(1, { duration: 160, easing: Easing.out(Easing.ease) }));
  }, [left, reducedMotion, ring, tick]);
  const tickStyle = useAnimatedStyle(() => ({
    transform: [{ scale: tick.get() }],
  }));

  // 最后 10 秒：红色铺满整页，之后一深一浅地跳（每半秒一换）；开了「减弱动态效果」或读屏就不跳
  const wash = useSharedValue(0);
  const beat = useSharedValue(0);
  useEffect(() => {
    // 字是立刻变白的。深色下底色用 400 ms 渐红；浅色下渐变的中途是白字压在浅灰底上，看不清，改成 120 ms
    wash.set(
      withTiming(urgent ? 1 : 0, {
        duration: dark ? 400 : 120,
        easing: Easing.out(Easing.ease),
      }),
    );
    if (!urgent || reducedMotion) {
      beat.set(0);
      return;
    }
    beat.set(
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400 }),
          withTiming(1, { duration: 100 }),
          withTiming(0, { duration: 400 }),
          withTiming(0, { duration: 100 }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(beat);
  }, [urgent, reducedMotion, dark, wash, beat]);
  const washStyle = useAnimatedStyle(() => ({ opacity: wash.get() }));
  const beatStyle = useAnimatedStyle(() => ({ opacity: beat.get() }));

  // 取消之后又需要帮助：和安全页长按 SOS 走同一条路——经 app-relay 注入 manual_sos，服务端同一套状态机，
  // 重新倒数 60 秒；新的倒计时页由「核对进行中的 SOS」那条路拉起，盖在这一页上面。
  // 这一页里只算一次求救：再点（失败后重试）复用同一个 eventId，服务端按它幂等。换了 eventId 的话，
  // 前一条已经建了单、倒计时中再到一条 manual_sos，会被当成「倒计时中按实体键」直接跳过 60 秒通知联系人
  //（10-06 不变式评审 F-5）
  // 按头盔号各存一份：多顶头盔的结果页上每顶各有一个「我还是需要帮助」（10-16 N10）
  const helpEnvelope = useRef(
    new Map<string, ReturnType<typeof buildRelayEnvelope>>(),
  );
  const helpQueued = useRef(new Set<string>());
  const [helpBusy, setHelpBusy] = useState(false);
  const needHelp = (device?: string) => {
    // 外部深链只带 sosId 时路由里没有 deviceId，用这一单自己的（10-16 C1）
    const helpDevice = device ?? sos?.deviceId ?? deviceId;
    if (!helpDevice) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    let envelope = helpEnvelope.current.get(helpDevice);
    if (!envelope) {
      envelope = buildRelayEnvelope(helpDevice, "manual_sos", {});
      helpEnvelope.current.set(helpDevice, envelope);
    }
    setHelpBusy(true);
    relayApi
      .push({ deviceId: helpDevice, envelopes: [envelope] })
      .then((counts) => {
        // 服务端判 invalid 只留档不建单：不进队列（重发也不会变合法），但要明说，别让骑手以为求救已发出（10-15 复审 F-4）
        if (counts.invalid > 0) {
          showNotice(t("safety.sosSendFailed"), t("safety.sosRejected"));
          return;
        }
        notifyCriticalAccepted(helpDevice);
      })
      .catch((e) => {
        // 没发出去：进持久队列，网络恢复后按原 eventId 自动补发（同一条只入队一次）
        if (!helpQueued.current.has(helpDevice)) {
          helpQueued.current.add(helpDevice);
          enqueueRelayEvent(envelope as EventEnvelope<EventType>);
        }
        showNotice(
          t("safety.sosSendFailed"),
          `${toUserMessage(e)}\n${t("safety.sosQueued")}`,
        );
      })
      .finally(() => setHelpBusy(false));
  };
  // 「我还是需要帮助」之后的新单：进队列 → 上面那条 effect 自动切过去重新倒数，不再另开一页

  // 两单以上：一次处理全部。取消要确认（和单条的滑动取消一样不能误触）；立即求救也确认一下，
  // 这一下是替好几顶头盔的骑手做决定
  const actAll = (kind: "cancel" | "confirm") => {
    const targets = queue;
    Alert.alert(
      t(kind === "cancel" ? "sos.allCancelTitle" : "sos.allSendTitle", {
        n: targets.length,
      }),
      t(kind === "cancel" ? "sos.allCancelBody" : "sos.allSendBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.confirm"),
          style: kind === "cancel" ? "destructive" : "default",
          onPress: () => {
            setBusy(kind);
            void Promise.allSettled(
              targets.map((q) =>
                (kind === "cancel"
                  ? sosApi.cancel(q.sosId)
                  : sosApi.confirm(q.sosId)
                ).then((updated) =>
                  queryClient.setQueryData(["sos", q.sosId], updated),
                ),
              ),
            )
              .then((results) => {
                const failed = results.find(
                  (r): r is PromiseRejectedResult =>
                    r.status === "rejected" &&
                    !(
                      r.reason instanceof ApiRequestError &&
                      r.reason.code === "SOS_ALREADY_FINALIZED"
                    ),
                );
                if (failed)
                  showNotice(t("common.failed"), toUserMessage(failed.reason));
                // 已在别处结束的单：和单条操作一样拉一次它的权威状态（屏上这单不然要等下一轮 10 秒轮询才切走）
                results.forEach((r, i) => {
                  if (
                    r.status === "rejected" &&
                    r.reason instanceof ApiRequestError &&
                    r.reason.code === "SOS_ALREADY_FINALIZED"
                  )
                    void queryClient.invalidateQueries({
                      queryKey: ["sos", targets[i].sosId],
                      exact: true,
                    });
                });
                void queryClient.invalidateQueries({
                  queryKey: ["sos-active"],
                });
              })
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  };

  // 环随屏幕高度缩，两个操作始终留在屏幕里。环以外要放下的东西按 1 倍字体算是 446；
  // 系统字体放大时标题、说明、联系人那几行跟着长高。矮屏（或字体放得很大）放不下时，
  // 先去掉顶上那个警示图标，环再缩，最小 140（2026-10-08 模拟器 360×640 + 1.3 倍字体：不这样联系人那行会被挤掉）。
  // 字体每放大 1 倍按多长 220 算：按 110 算时 2 倍字体下「未添加紧急联系人」那条警告有一半落在按钮后面（2026-10-15 边界测试）
  const room =
    windowHeight -
    insets.top -
    insets.bottom -
    446 -
    Math.max(0, fontScale - 1) * 220 -
    (isDrill ? 44 : 0) -
    (sourceName ? 26 : 0) -
    (lateNote ? 26 : 0) -
    (others.length > 0 ? 44 + 26 + 30 : 0);
  const estimateCompact = room < 200;
  const estimateRing = Math.round(
    Math.max(140, Math.min(252, room + (estimateCompact ? 66 : 0))),
  );
  // 估算只是起点：英文比中文多折一两行、没有联系人时的那条警告、来源头盔那一行，都会让上半截比估算高。
  // 量出上半截实际溢出多少，就把环再缩多少（环是这里唯一能伸缩的东西）；环缩到 140 还放不下才收起顶上的图标，
  // 再放不下（字体放得很大）才靠滚动兜底。2026-10-15 华为 P30 Pro 英文、没有联系人时上半截能上下滑（负责人发现）
  // 量出来的结果连同当时的布局条件一起存：条件一变（转屏、改字体、换语言、联系人加载出来）就当作没量过，从估算重新来
  const layoutKey = `${windowHeight}|${fontScale}|${locale}|${isDrill}|${sourceName ?? ""}|${lateNote ?? ""}|${contacts.data?.length ?? "?"}|${others.length > 0}`;
  const [fitState, setFitState] = useState({
    key: layoutKey,
    shrink: 0,
    compact: false,
  });
  const fit =
    fitState.key === layoutKey
      ? fitState
      : { key: layoutKey, shrink: 0, compact: false };
  const compact = estimateCompact || fit.compact;
  const ringSize = Math.max(140, estimateRing - fit.shrink);
  const numberSize = Math.round((112 * ringSize) / 252);
  const topBox = useRef({ viewport: 0, content: 0 });
  const fitTop = () => {
    const { viewport, content } = topBox.current;
    const over = content - viewport;
    if (!viewport || !content || over <= 1) return;
    if (ringSize > 140) {
      setFitState({
        ...fit,
        shrink: fit.shrink + Math.ceil(Math.min(over, ringSize - 140)),
      });
    } else if (!compact) {
      setFitState({ ...fit, compact: true });
    }
  };

  const notifiedTitleOf = (d: ReturnType<typeof deliveryStateOf>) =>
    d === "sent"
      ? t("sos.notified.sent")
      : d === "none"
        ? t("sos.notified.none")
        : d === "failed"
          ? t("sos.notified.failed")
          : t("sos.notified.sending");
  const notifiedTitle = isDrill
    ? t("sos.drillDoneTitle")
    : notifiedTitleOf(delivery);
  const notifiedBody = isDrill
    ? t("sos.drillNotifiedBody")
    : delivery === "none"
      ? t("sos.notified.noneBody")
      : delivery === "failed"
        ? t("sos.notified.failedBody")
        : delivery === "unknown"
          ? t("sos.notifiedBody")
          : t("sos.notified.body");

  const pop = ZoomIn.duration(320).easing(Easing.out(Easing.back(2)));
  const drillBadge = isDrill ? (
    <View style={[styles.drillBadge, { backgroundColor: theme.brand }]}>
      <Ionicons name="school-outline" size={16} color={theme.onBrand} />
      <ThemedText
        type="smallBold"
        style={{ color: theme.onBrand, fontSize: 13 }}
      >
        {t("sos.drillBadge")}
      </ThemedText>
    </View>
  ) : null;
  const closeButton = (
    <Tappable
      feedback="scale"
      accessibilityRole="button"
      onPress={() => router.back()}
      style={[styles.doneBtn, { backgroundColor: theme.backgroundSelected }]}
    >
      <ThemedText style={styles.doneBtnText}>{t("sos.close")}</ThemedText>
    </Tappable>
  );

  // 没有这一单，但还有别的单在倒数（点了已解绑头盔的推送 / 外部链接把页面切到一个不存在的单号）：切到最早到期的那单，
  // 不能用「这条求救不存在」把正在倒数的单盖住——警报停、胶囊没了，点「关闭」后那单再也不会弹（10-16 评审）
  const notFound = !isDrill && !sos && isNotFound(sosQuery.error);
  const fallback = notFound ? nextSos(queue, sosId) : null;
  if (fallback) setSelected(fallback.sosId);

  // 没有这一单：不画倒计时，说明一句、给关闭（页面是从链接直接打开、栈里没东西时回设备页）
  if (notFound && !fallback)
    return (
      <View style={[styles.goneWrap, { backgroundColor: theme.background }]}>
        <EmptyState
          icon="help-circle-outline"
          title={t("sos.gone.title")}
          body={t("sos.gone.body")}
          actionLabel={t("sos.close")}
          onAction={() =>
            router.canGoBack() ? router.back() : router.navigate("/")
          }
        />
      </View>
    );

  return (
    // 这一页是全屏弹出的。iPhone 上 SafeAreaView 在这里拿到的留白是 0，内容顶到了灵动岛上、
    // 滑块贴着底部横条（2026-10-08 iPhone 截图量出来：上 16、下 12，正好只剩页面自己的边距）；
    // 所以不用它，直接用根上量到的安全区留白。Android 上两种写法结果一样
    <View
      style={[
        styles.flex,
        {
          backgroundColor: theme.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {urgent && <StatusBar style="light" />}
      <Animated.View
        pointerEvents="none"
        style={[styles.wash, { backgroundColor: SOS_RED }, washStyle]}
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.wash, { backgroundColor: SOS_RED_BEAT }, beatStyle]}
      />
      {toast ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[
            styles.toast,
            {
              top: insets.top + 8,
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
            },
          ]}
        >
          <ThemedText numberOfLines={2} style={styles.toastText}>
            {toast}
          </ThemedText>
        </Animated.View>
      ) : null}
      <View style={styles.container}>
        {!finished ? (
          <>
            <ScrollView
              style={styles.top}
              contentContainerStyle={styles.topContent}
              bounces={false}
              onLayout={(e) => {
                topBox.current.viewport = e.nativeEvent.layout.height;
                fitTop();
              }}
              onContentSizeChange={(_, h) => {
                topBox.current.content = h;
                fitTop();
              }}
            >
              <View style={styles.grow} />
              {others.length > 0 ? (
                <View style={styles.multi}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipsRow}
                  >
                    {queue.slice(0, MAX_CHIPS).map((q) => {
                      const on = q.sosId === sosId;
                      const name = nameOf(q.deviceId);
                      const n = secondsLeft(q.deadline, now);
                      return (
                        <Tappable
                          key={q.sosId}
                          feedback="scale"
                          accessibilityRole="button"
                          accessibilityState={{ selected: on }}
                          accessibilityLabel={`${name} · ${t("sos.chipLeft", { n })}`}
                          onPress={() => setSelected(q.sosId)}
                          style={[
                            styles.helmetChip,
                            {
                              backgroundColor: on ? P.sosBtn : P.chip,
                              borderColor: on ? P.sosBtn : theme.border,
                            },
                          ]}
                        >
                          <ThemedText
                            numberOfLines={1}
                            style={[
                              styles.helmetChipText,
                              { color: on ? P.onSosBtn : P.text },
                            ]}
                          >
                            {name}
                          </ThemedText>
                          <ThemedText
                            style={[
                              styles.helmetChipLeft,
                              { color: on ? P.onSosBtn : P.sub },
                            ]}
                          >
                            {t("sos.chipLeft", { n })}
                          </ThemedText>
                        </Tappable>
                      );
                    })}
                    {queue.length > MAX_CHIPS ? (
                      <View
                        style={[
                          styles.helmetChip,
                          {
                            backgroundColor: P.chip,
                            borderColor: theme.border,
                          },
                        ]}
                      >
                        <ThemedText
                          style={[styles.helmetChipText, { color: P.text }]}
                        >
                          +{queue.length - MAX_CHIPS}
                        </ThemedText>
                      </View>
                    ) : null}
                  </ScrollView>
                  <View style={styles.batchRow}>
                    <Tappable
                      feedback="scale"
                      accessibilityRole="button"
                      disabled={busy !== null}
                      onPress={() => actAll("confirm")}
                      style={[styles.batchBtn, { borderColor: P.sosBtn }]}
                    >
                      <ThemedText
                        style={[styles.batchText, { color: P.sosBtn }]}
                      >
                        {t("sos.allSendNow")}
                      </ThemedText>
                    </Tappable>
                    <Tappable
                      feedback="scale"
                      accessibilityRole="button"
                      disabled={busy !== null}
                      onPress={() => actAll("cancel")}
                      style={[styles.batchBtn, { borderColor: theme.border }]}
                    >
                      <ThemedText style={[styles.batchText, { color: P.text }]}>
                        {t("sos.allCancel")}
                      </ThemedText>
                    </Tappable>
                  </View>
                </View>
              ) : null}
              <View style={styles.head}>
                {drillBadge}
                {!compact && (
                  <View
                    style={[styles.headIcon, { backgroundColor: P.alertBg }]}
                  >
                    <Ionicons
                      name="warning-outline"
                      size={30}
                      color={P.alert}
                    />
                  </View>
                )}
                <ThemedText
                  accessibilityRole="header"
                  style={[styles.title, { color: P.text }]}
                >
                  {sos?.triggerType === "manual_sos"
                    ? t("safety.manualSos")
                    : t("sos.fall")}
                </ThemedText>
                {sourceName ? (
                  <ThemedText
                    numberOfLines={1}
                    style={[styles.source, { color: P.text }]}
                  >
                    {t("sos.fromHelmet", { name: sourceName })}
                  </ThemedText>
                ) : null}
                {others.length === 1 ? (
                  <ThemedText
                    numberOfLines={1}
                    style={[styles.others, { color: P.alert }]}
                  >
                    {t("sos.alsoCounting", {
                      name: nameOf(others[0].deviceId),
                    })}
                  </ThemedText>
                ) : others.length > 1 ? (
                  <ThemedText style={[styles.others, { color: P.alert }]}>
                    {t("sos.moreAlarms", { n: others.length })}
                  </ThemedText>
                ) : null}
                <ThemedText style={[styles.subtitle, { color: P.sub }]}>
                  {t("sos.pendingBody")}
                </ThemedText>
                {lateNote ? (
                  <ThemedText style={[styles.subtitle, { color: P.sub }]}>
                    {lateNote}
                  </ThemedText>
                ) : null}
              </View>

              <View style={styles.ring}>
                <CountdownRing
                  size={ringSize}
                  progress={ring}
                  color={P.ring}
                  track={P.ringTrack}
                >
                  <Animated.View style={tickStyle}>
                    <ThemedText
                      allowFontScaling={false}
                      style={[
                        styles.number,
                        {
                          color: P.num,
                          fontSize: numberSize,
                          lineHeight: numberSize,
                        },
                      ]}
                    >
                      {left ?? "—"}
                    </ThemedText>
                  </Animated.View>
                  {/* 环内只显示时间单位，完整说明在上方并跟随系统字号。 */}
                  <ThemedText
                    allowFontScaling={false}
                    style={[
                      styles.suffix,
                      { color: P.sub, fontSize: ringSize >= 220 ? 14 : 12 },
                    ]}
                  >
                    {t("sos.autoSendSuffix")}
                  </ThemedText>
                </CountdownRing>
              </View>

              <View style={styles.who}>
                {contacts.data === undefined ? null : contacts.data.length >
                  0 ? (
                  <>
                    <ThemedText style={[styles.whoLabel, { color: P.sub }]}>
                      {t(isDrill ? "sos.willNotifyDrill" : "sos.willNotify", {
                        n: contacts.data.length,
                      })}
                    </ThemedText>
                    <View style={styles.chips}>
                      {contacts.data.slice(0, 3).map((c) => (
                        <View
                          key={c.id}
                          style={[
                            styles.chip,
                            {
                              backgroundColor: P.chip,
                              borderColor: theme.border,
                            },
                          ]}
                        >
                          <View
                            style={[
                              styles.avatar,
                              { backgroundColor: P.avatarBg },
                            ]}
                          >
                            <ThemedText
                              style={[
                                styles.avatarText,
                                { color: P.avatarText },
                              ]}
                            >
                              {initialOf(contactNameOf(c))}
                            </ThemedText>
                          </View>
                          <ThemedText
                            numberOfLines={1}
                            style={[styles.chipText, { color: P.text }]}
                          >
                            {contactNameOf(c)}
                          </ThemedText>
                        </View>
                      ))}
                      {contacts.data.length > 3 && (
                        <View
                          style={[
                            styles.chip,
                            styles.chipMore,
                            {
                              backgroundColor: P.chip,
                              borderColor: theme.border,
                            },
                          ]}
                        >
                          <ThemedText
                            style={[styles.chipText, { color: P.text }]}
                          >
                            +{contacts.data.length - 3}
                          </ThemedText>
                        </View>
                      )}
                    </View>
                  </>
                ) : (
                  <View
                    style={[
                      styles.noContacts,
                      {
                        backgroundColor: P.alertBg,
                        borderColor: P.alertBorder,
                      },
                    ]}
                  >
                    <Ionicons
                      name="warning-outline"
                      size={18}
                      color={P.alert}
                    />
                    <ThemedText
                      style={[styles.noContactsText, { color: P.text }]}
                    >
                      {t(isDrill ? "sos.noContactsDrill" : "sos.noContacts")}
                    </ThemedText>
                  </View>
                )}
              </View>
              <View style={styles.grow} />
            </ScrollView>

            <View style={styles.actions}>
              <Tappable
                feedback="scale"
                accessibilityRole="button"
                disabled={busy !== null}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
                    () => {},
                  );
                  act("confirm");
                }}
                style={[styles.send, { backgroundColor: P.sosBtn }]}
              >
                <Ionicons name="call" size={22} color={P.onSosBtn} />
                <ThemedText style={[styles.sendText, { color: P.onSosBtn }]}>
                  {busy === "confirm" ? t("auth.sending") : t("sos.sendNow")}
                </ThemedText>
              </Tappable>
              <SlideToCancel
                label={t("sos.slide")}
                busyLabel={t("sos.cancelling")}
                a11yLabel={t("sos.slideA11y")}
                a11yHint={t("sos.slideHint")}
                busy={cancelBusy}
                disabled={busy === "confirm"}
                colors={P.slide}
                onCancel={() => act("cancel")}
              />
            </View>
          </>
        ) : multiDone ? (
          <>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.notified}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <Animated.View
                entering={pop}
                style={[styles.notifiedIcon, { backgroundColor: P.alertBg }]}
              >
                <Ionicons
                  name="shield-checkmark-outline"
                  size={36}
                  color={P.alert}
                />
              </Animated.View>
              <ThemedText accessibilityRole="header" style={styles.doneTitle}>
                {t("sos.multiDoneTitle", { n: handledList.length })}
              </ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.doneText}>
                {t("sos.multiDoneBody")}
              </ThemedText>
              <Animated.View
                entering={FadeIn.duration(220)}
                style={[
                  styles.sentCard,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              >
                {handledList.map((h, i) => {
                  const status = handledStatus(h);
                  const d = deliveryStateOf(
                    (h.sosId === sosId
                      ? detail.data
                      : handledDetails[
                          otherHandled.findIndex((o) => o.sosId === h.sosId)
                        ]?.data
                    )?.notifications,
                  );
                  const outcome =
                    status === "cancelled"
                      ? t("sos.cancelledTitle")
                      : notifiedTitleOf(d);
                  return (
                    <View
                      key={h.sosId}
                      style={[
                        styles.sentRow,
                        i > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: theme.border,
                        },
                      ]}
                    >
                      <View style={styles.sentBody}>
                        <ThemedText numberOfLines={1} style={styles.sentName}>
                          {nameOf(h.deviceId)}
                        </ThemedText>
                        <ThemedText
                          themeColor="textSecondary"
                          numberOfLines={2}
                          style={styles.sentSub}
                        >
                          {outcome}
                        </ThemedText>
                      </View>
                      {status === "cancelled" ? (
                        <Tappable
                          feedback="scale"
                          accessibilityRole="button"
                          disabled={helpBusy}
                          onPress={() => needHelp(h.deviceId)}
                          style={[
                            styles.resultHelp,
                            { borderColor: theme.borderStrong },
                          ]}
                        >
                          <ThemedText style={styles.resultHelpText}>
                            {t("sos.needHelp")}
                          </ThemedText>
                        </Tappable>
                      ) : (
                        <Badge
                          variant={
                            d === "sent"
                              ? "success"
                              : d === "failed" || d === "none"
                                ? "danger"
                                : "neutral"
                          }
                          label={outcome}
                        />
                      )}
                    </View>
                  );
                })}
              </Animated.View>
            </ScrollView>
            <View style={styles.doneActions}>{closeButton}</View>
          </>
        ) : sos.status === "cancelled" ? (
          <>
            <View style={styles.doneCenter}>
              {drillBadge}
              <Animated.View
                entering={pop}
                style={[styles.doneIcon, { backgroundColor: theme.successBg }]}
              >
                <Ionicons name="checkmark" size={44} color={theme.success} />
              </Animated.View>
              <ThemedText accessibilityRole="header" style={styles.doneTitle}>
                {t(isDrill ? "sos.drillDoneTitle" : "sos.cancelledTitle")}
              </ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.doneText}>
                {t(isDrill ? "sos.drillCancelledBody" : "sos.cancelledBody")}
              </ThemedText>
            </View>
            <View style={styles.doneActions}>
              {!isDrill && (
                <Tappable
                  feedback="scale"
                  accessibilityRole="button"
                  disabled={helpBusy}
                  onPress={() => needHelp()}
                  style={[
                    styles.doneBtn,
                    styles.doneBtnOutline,
                    { borderColor: theme.borderStrong },
                  ]}
                >
                  <ThemedText style={styles.doneBtnText}>
                    {t("sos.needHelp")}
                  </ThemedText>
                </Tappable>
              )}
              {closeButton}
            </View>
          </>
        ) : (
          <>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.notified}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              {drillBadge}
              <Animated.View
                entering={pop}
                style={[styles.notifiedIcon, { backgroundColor: P.alertBg }]}
              >
                <Ionicons
                  name="notifications-outline"
                  size={36}
                  color={P.alert}
                />
              </Animated.View>
              <ThemedText accessibilityRole="header" style={styles.doneTitle}>
                {notifiedTitle}
              </ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.doneText}>
                {notifiedBody}
              </ThemedText>
              {sentTo.length > 0 && (
                <Animated.View
                  entering={FadeIn.duration(220)}
                  style={[
                    styles.sentCard,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: theme.border,
                    },
                  ]}
                >
                  {sentTo.map((n, i) => (
                    <View
                      key={n.id}
                      style={[
                        styles.sentRow,
                        i > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: theme.border,
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.sentAvatar,
                          { backgroundColor: theme.backgroundSelected },
                        ]}
                      >
                        <ThemedText style={styles.sentInitial}>
                          {initialOf(n.contactName ?? n.target)}
                        </ThemedText>
                      </View>
                      <View style={styles.sentBody}>
                        <ThemedText numberOfLines={1} style={styles.sentName}>
                          {n.contactName ?? n.target}
                        </ThemedText>
                        <ThemedText
                          themeColor="textSecondary"
                          numberOfLines={1}
                          style={styles.sentSub}
                        >
                          {n.contactName
                            ? `${t("sos.viaSms")} · ${n.target}`
                            : t("sos.viaSms")}
                        </ThemedText>
                      </View>
                      <Badge
                        variant={
                          n.status === "sent"
                            ? "success"
                            : n.status === "failed"
                              ? "danger"
                              : "warning"
                        }
                        label={
                          n.status === "sent"
                            ? t("accident.notif.sent")
                            : n.status === "failed"
                              ? t("accident.notif.failed")
                              : t("accident.notif.sending")
                        }
                      />
                    </View>
                  ))}
                </Animated.View>
              )}
            </ScrollView>
            {closeButton}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  goneWrap: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  flex: { flex: 1 },
  wash: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 12,
  },
  // 上半截（图标到联系人）在顶部和两个操作之间上下居中：高屏上不再全挤在顶上、下面空一大截
  //（负责人 2026-10-08：太上面了）。放不下时两头的留白收成 0，多出来的可以往上滑；两个操作不会被挤出屏幕。
  // 以前是直接裁掉下沿：系统字体 2 倍时「未添加紧急联系人」那条警告被底部按钮盖住半截、又滑不动（2026-10-15 边界测试）
  top: { flex: 1 },
  topContent: { flexGrow: 1, alignItems: "center" },
  grow: { flexGrow: 1 },
  head: { alignSelf: "stretch", alignItems: "center", gap: 10 },
  drillBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radius.pill,
  },
  headIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 600,
    textAlign: "center",
  },
  subtitle: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  source: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: 600,
    textAlign: "center",
  },
  ring: { marginTop: 20 },
  number: {
    fontWeight: 800,
    fontVariant: ["tabular-nums"],
    letterSpacing: -2,
    textAlign: "center",
  },
  suffix: { lineHeight: 20, marginTop: 2 },
  who: {
    alignSelf: "stretch",
    minHeight: 76,
    marginTop: 20,
    alignItems: "center",
    gap: 8,
  },
  whoLabel: { fontSize: 13, lineHeight: 18, textAlign: "center" },
  // 多顶同时求救：顶部胶囊 + 全部按钮
  multi: { alignSelf: "stretch", gap: 8, marginBottom: 8 },
  chipsRow: { gap: 8, paddingHorizontal: 4 },
  helmetChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    maxWidth: 180,
  },
  helmetChipText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: 600,
    flexShrink: 1,
  },
  helmetChipLeft: {
    fontSize: 12,
    lineHeight: 16,
    fontVariant: ["tabular-nums"],
  },
  others: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: 600,
    textAlign: "center",
    marginTop: 2,
  },
  batchRow: { flexDirection: "row", justifyContent: "center", gap: 8 },
  batchBtn: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    borderWidth: 1,
    justifyContent: "center",
  },
  batchText: { fontSize: 13, lineHeight: 18, fontWeight: 600 },
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 2,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: Radius.control,
    borderWidth: 1,
  },
  toastText: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  resultHelp: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
  },
  resultHelpText: { fontSize: 13, lineHeight: 18, fontWeight: 600 },
  // 联系人胶囊：放不下就换到第二排，名字最多约 6 个字再省略（10-16 N20：原来三个挤一行、每个只剩 3 个字）。
  // 多出的一排由上半截的溢出测量把环缩小来让位
  chips: {
    alignSelf: "stretch",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 36,
    paddingLeft: 6,
    paddingRight: 14,
    borderRadius: 18,
    borderWidth: 1,
    maxWidth: "100%",
  },
  chipMore: { paddingLeft: 12, paddingRight: 12, flexShrink: 0 },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 12, lineHeight: 16, fontWeight: 700 },
  chipText: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: 600,
    flexShrink: 1,
    maxWidth: 94,
  },
  noContacts: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  noContactsText: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: 600 },
  actions: { gap: 20, paddingTop: 8 },
  send: {
    height: 72,
    borderRadius: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  sendText: { fontSize: 17, lineHeight: 24, fontWeight: 700 },
  doneCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  doneIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  doneTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 600,
    textAlign: "center",
  },
  doneText: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  doneActions: { gap: 12 },
  doneBtn: {
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  doneBtnOutline: { borderWidth: 1 },
  doneBtnText: { fontSize: 16, lineHeight: 22, fontWeight: 700 },
  notified: {
    alignItems: "center",
    gap: 10,
    paddingTop: 16,
    paddingBottom: 16,
  },
  notifiedIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  sentCard: {
    alignSelf: "stretch",
    marginTop: 14,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  sentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sentAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  sentInitial: { fontSize: 15, lineHeight: 20, fontWeight: 700 },
  sentBody: { flex: 1, minWidth: 0 },
  sentName: { fontSize: 15, lineHeight: 20, fontWeight: 600 },
  sentSub: { fontSize: 13, lineHeight: 18 },
});
