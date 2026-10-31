// SOS 锁屏提醒：App 不在前台时收到 pending 的 SOS 推送，用本地通知把「摔倒/求救倒计时」顶到锁屏上。
// 背景：iOS 锁屏下 SOS 页的 expo-audio 警报音激活会失败（AVAudioSession 不允许后台起播，2026-09-17
// 真机实测：事件当秒上云、页面已推、但用户听不到任何声音）；本地通知的声音与横幅不依赖音频会话，
// 是锁屏告警唯一可靠的路径。Android 上同样走这里（前台服务的常驻通知是静音的）。
// 服务端仍是 SOS 权威，这里只做提醒 + 把「误触取消」放到通知按钮上少一次解锁；不做任何判断。
import { HelmetLinkService } from "helmet-link-service";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { sosActiveHref } from "@/services/sos-routes";
import { REQUEST_TIMEOUT_MS } from "@/api/client";
import { sosApi } from "@/api/sos";
import { translate } from "@/i18n";
import type { Sos } from "@helmet/shared";
import { devLog } from "@/services/dev-log";
import { shownSeconds } from "@/services/countdown";
import { serverNow } from "@/services/server-clock";
import { lateEventNote } from "@/services/sos-age";
import { isSosFor } from "@/api/sos-shape";
import { presentedSos } from "@/services/sos-sync";
import { sosScreen } from "@/services/sos-queue";
import { useSosCancelStore } from "@/stores/sos-cancel-store";
import { showNotice } from "@/services/notice";
import {
  clearSosStartPush,
  setSosStartPushArrivalHook,
  SOS_START_PUSH_TITLE,
} from "@/services/sos-start-push";
import {
  PROMPT_AFTER_SPLASH_MAX_MS,
  splashGoneWithin,
} from "@/components/splash/covering";
import { whenSignInQuiet } from "@/services/sign-in-moment";

/** 锁屏求救提醒走的 Android 通知通道；安全页判断「通知有没有开」也要看它有没有被单独关掉 */
export const SOS_CHANNEL_ID = "sos";
const CHANNEL_ID = SOS_CHANNEL_ID;
const CATEGORY_ID = "sos";
const ACTION_CANCEL = "cancel";
const ACTION_OPEN = "open";
/** 剩余多少秒时再静默刷新一次通知正文（同一 identifier 原位替换，不再响铃） */
const REFRESH_AT = [30, 10] as const;
/** 一单的本地通知编号：首条与第一次刷新共用（同 id 原位更新），之后的刷新各用一个 */
const refreshIdOf = (sosId: string, at: (typeof REFRESH_AT)[number]): string =>
  at === REFRESH_AT[0] ? `sos-${sosId}` : `sos-${sosId}-${at}`;
/** 这一单可能排过的全部本地通知编号（撤的时候按它撤，不依赖进程里的登记表） */
const alertIdsOf = (sosId: string): string[] => [
  ...new Set(REFRESH_AT.map((at) => refreshIdOf(sosId, at))),
];

/** 初始化只做一次；并发 / 重复调用拿到同一个 Promise（调用方要等它结束再去要别的权限） */
let permissionReady: Promise<void> | null = null;
/** 被推迟到倒计时页关掉之后的那次系统授权申请（O10）；null = 没推迟（申请已做完或不用申请） */
let deferredAsk: Promise<void> | null = null;
/** 冷启动补拉结束才放行系统授权框（use-realtime 装上）；null = 没人拦，照原样立刻申请 */
let promptGate: Promise<unknown> | null = null;
/** 补拉迟迟不回（弱网）最多等这么久：之后照常申请，最坏退回改动前的样子（框可能盖在倒计时页上） */
const PROMPT_GATE_MAX_MS = 5_000;
/** 推迟期间多久看一眼倒计时页还在不在；第一眼也给刚 push、还没挂上的页面留出时间 */
const DEFERRED_ASK_POLL_MS = 1_000;
/**
 * 每一单各自的通知：sosId → 已投 / 待触发的通知 id。原来只有一个槽位，第二单会把第一单顶掉，
 * 第一单结束时 clear 找不到它，通知永远留在锁屏上（10-03 评审疑点 2）。
 */
const alerts = new Map<
  string,
  { ids: string[]; timers: ReturnType<typeof setTimeout>[] }
>();
let responseSub: Notifications.EventSubscription | null = null;
// 极光那条比本地提醒晚到（安卓）：本地这条已在通知栏上就当场撤掉它（见 sos-start-push 的说明）
setSosStartPushArrivalHook((sosId) => {
  if (alerts.has(sosId)) clearStartPushIfLocalVisible(sosId);
});

/**
 * 撤极光那条「倒计时已开始」之前，确认本地这条真的看得见（安卓）：求救通道被关 / 调成静默（华为总开关的那个坑，
 * isSosChannelBlocked）时本地这条排上了也不显示，再撤极光那条锁屏上就一条都不剩（10-25 审查）。
 * 查询出错按看不见算，宁可多一条。iOS 上这一步本来就是空操作，照旧直接调
 */
function clearStartPushIfLocalVisible(sosId: string): void {
  if (Platform.OS !== "android") {
    clearSosStartPush(sosId);
    return;
  }
  void (async () => {
    try {
      if (await isSosChannelBlocked()) return;
      const ids = new Set(alertIdsOf(sosId));
      const shown = await Notifications.getPresentedNotificationsAsync();
      if (shown.some((n) => ids.has(n.request.identifier)))
        clearSosStartPush(sosId);
    } catch {
      /* 看不见就不撤 */
    }
  })();
}
/** 通知按钮「取消」被服务端确认后回调（use-realtime 注册：让倒计时页立刻拉一次权威状态） */
let onCancelConfirmed: ((sosId: string, sos?: Sos) => void) | null = null;
export function setSosCancelConfirmedListener(
  listener: ((sosId: string, sos?: Sos) => void) | null,
): void {
  onCancelConfirmed = listener;
}

/**
 * 登录后调用一次：建 Android 高优先级通道、注册通知动作、申请通知权限（拒绝也不阻塞链路）。
 * 兑现时机 = 系统授权框有了结果，或这次申请被推迟到倒计时页关掉之后（见 askPermission）——
 * 不会因为推迟而一直挂着：蓝牙链路在等它。界面要读授权结果用 whenSosAlertPermissionAsked
 */
export function ensureSosAlertPermission(): Promise<void> {
  permissionReady ??= initSosAlert();
  return permissionReady;
}

/** 冷启动补拉结束前先别弹系统授权框：use-realtime 在调 ensure 之前装上，补拉结束（不论成败）时兑现 */
export function holdPermissionPromptUntil(gate: Promise<unknown>): void {
  promptGate = gate;
}

/**
 * 系统授权框真正有了结果再兑现——包括被推迟到倒计时页关掉之后才弹的那次。
 * 界面读权限状态前等它（services/notify-permission.ts）：推迟期间 Android 13+ 读到的是 denied，
 * 不等的话关页后系统框会弹在已经画好的「通知未开启」上面（与 10-08 同一个坑）
 */
export function whenSosAlertPermissionAsked(): Promise<void> {
  return ensureSosAlertPermission().then(() => deferredAsk ?? undefined);
}

/** 求救通道名和通知上两个按钮的文字：交给系统那一刻按当时的语言写死，切语言后要再交一次（refreshSosAlertTexts） */
async function registerAlertTexts(): Promise<void> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: translate("sosAlert.channel"),
      importance: Notifications.AndroidImportance.MAX,
      // 不传 sound：Android 把字符串当成打包进 App 的自定义音频资源名，传 "default"
      // 会在每次启动打一条 ERROR（华为 P30 Pro 实测）然后回落到系统默认铃声——
      // 省掉这层报错，直接要系统默认。
      vibrationPattern: [0, 500, 250, 500],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
  }
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    {
      identifier: ACTION_CANCEL,
      buttonTitle: translate("sosAlert.cancelAction"),
      // 必须拉起 App：不拉起时取消请求在后台发出，iOS 随即挂起进程，请求被中断
      // （2026-09-24 iPhone 实测 FetchRequestCanceledException），60 s 后照样通知联系人——
      // 一个「按了却没生效」的取消键比没有更危险。拉起后页面会显示已取消。
      options: { opensAppToForeground: true, isDestructive: false },
    },
    {
      identifier: ACTION_OPEN,
      buttonTitle: translate("sosAlert.openAction"),
      options: { opensAppToForeground: true },
    },
  ]);
}

/**
 * 切语言后把通道名和按钮文字按新语言再交一次（10-25 安卓模拟器：切成简体后，求救通知标题是中文、
 * 按钮还是「I'm OK, cancel」，要重开 App 才换）。还没初始化过就不动：初始化时本来就按当时的语言写
 */
export async function refreshSosAlertTexts(): Promise<void> {
  if (!permissionReady) return;
  await permissionReady;
  try {
    await registerAlertTexts();
    if (resultChannelReady) await createResultChannel();
  } catch (e) {
    devLog("SOS-ALERT", "切语言后更新通知文字失败", e as Error);
  }
}

async function initSosAlert(): Promise<void> {
  installPresentationPolicy();
  // 先于任何 await：根布局同一个 effect 里紧接着就会同步跑 push.ts 的初始化，它读的是同一条启动点击。
  // 这里一让出（建通道 / 注册类别），push.ts 就先读先清，远程推送上「我没事，取消」那次点击就丢了，
  // 取消请求从未发出（10-06 并发评审 F1）
  installResponseHandler();
  try {
    await registerAlertTexts();
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) await askPermission(current.canAskAgain !== false);
  } catch (e) {
    devLog("SOS-ALERT", "通知权限/通道初始化失败", e as Error);
  }
}

/**
 * 申请通知权限，但不把系统授权框弹在求救倒计时页上（O10，2026-10-20 Android 16 模拟器 REGRESSION 4.41：
 * 倒计时中撤回通知权限 → 系统杀进程 → 重新打开，「允许发送通知？」盖在倒计时页上，要先点掉才能滑动取消，
 * 倒计时却在走）。通道 / 类别已在前面建好，这里只管「弹框」这一步。
 * 冷启动时倒计时页要等补拉回来才拉起，比走到这里晚得多（只看 sosScreen.mounted 拦不住），所以先等补拉
 * （promptGate，最多 5 s），再看：页面在屏或正要拉起（presentedSos 已登记，补拉 / 点通知拉起都会先登记）
 * 就推迟到页面关掉再弹，这里立刻返回——ensure 照常兑现，蓝牙链路不被这一单拖住。
 * 代价：这一单倒计时期间没有通知权限，锁屏提醒出不来；用户本来就在前台看着倒计时页。
 * 系统根本不会弹框时（iOS 已答过、Android 已被永久拒绝：canAskAgain=false）不等也不推迟、照原样调一次，
 * 免得这部分用户每次冷启动都晚起蓝牙链路。iOS 的授权框同样是模态、同样会盖住页面，两端同一套。
 * 开屏还在播也先别弹（O27）：和等补拉同时计时，开屏让开或满 5 s 就往下走，两样加起来不会多等。
 */
async function askPermission(willPrompt: boolean): Promise<void> {
  const splashGone = willPrompt
    ? splashGoneWithin(PROMPT_AFTER_SPLASH_MAX_MS)
    : undefined;
  const signInQuiet = willPrompt ? whenSignInQuiet() : undefined;
  if (willPrompt && promptGate) {
    await settledOrTimeout(promptGate, PROMPT_GATE_MAX_MS);
  }
  await splashGone;
  await signInQuiet;
  if (willPrompt && (sosScreen.mounted || presentedSos.current.size > 0)) {
    devLog(
      "SOS-ALERT",
      "倒计时页在屏 / 正要拉起，系统通知授权框推迟到页面关掉后再弹",
    );
    deferredAsk = askAfterCountdown();
    return;
  }
  await Notifications.requestPermissionsAsync();
}

/** 轮询而不是挂页面卸载回调：不用改倒计时页；同一次提交里先卸后挂（切单）的那一瞬间定时器插不进来 */
async function waitCountdownClosed(): Promise<void> {
  do {
    await new Promise((r) => setTimeout(r, DEFERRED_ASK_POLL_MS));
  } while (sosScreen.mounted);
}

/**
 * 别的系统授权框（蓝牙「附近设备」、安卓 11 及以下的定位）弹之前也过同一道门（O10，10-21 代码审查）：
 * 等冷启动补拉（最多 5 s），倒计时页在屏或正要拉起就等它关掉。原来只有通知那次会推迟——通知早就授权了
 * （安卓 12 及以下根本没有通知授权框，华为 P30 就是）或已被永久拒绝时，起蓝牙链路那一下的框照样盖在倒计时页上
 */
export async function whenCountdownClearForPrompt(): Promise<void> {
  if (promptGate) await settledOrTimeout(promptGate, PROMPT_GATE_MAX_MS);
  await whenSignInQuiet();
  if (!sosScreen.mounted && presentedSos.current.size === 0) return;
  devLog(
    "SOS-ALERT",
    "倒计时页在屏 / 正要拉起，系统授权框推迟到页面关掉后再弹",
  );
  await waitCountdownClosed();
}

async function askAfterCountdown(): Promise<void> {
  await waitCountdownClosed();
  try {
    await Notifications.requestPermissionsAsync();
  } catch (e) {
    devLog("SOS-ALERT", "推迟的通知权限申请失败", e as Error);
  }
}

/** gate 兑现（成败都算）或超时，先到先走；定时器用完就撤，不留着拖住进程 */
async function settledOrTimeout(
  gate: Promise<unknown>,
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 通知按钮/点击：取消 → 直接调服务端取消（App 不必到前台）；打开/点横幅 → 进 SOS 页 */
/**
 * 前台展示策略：SOS 到达时 App 若处于 inactive（正在锁屏 / 拉下控制中心的瞬间），iOS 把它算作
 * 前台投递、要问 App 要不要显示——不设策略默认是「不显示」，锁屏上就什么都没有
 * （2026-09-24 iPhone 实测：WS 在 appState=inactive 时到达，通知已排但锁屏没弹）。
 * 口径：SOS 类通知在非 active 状态一律弹横幅 + 响；active 时倒计时页本来就在屏上，不重复弹。
 * 其他类别（低电量等）保持系统默认。
 */
export function sosPresentation(
  _categoryIdentifier: string | null | undefined,
  appState: string,
): { show: boolean } {
  // 不按类别过滤：极光远程推送到 iOS 时没有 category，若只放行 sos 类，锁屏瞬间（inactive）到达的
  // 远程 SOS 推送会被吞——评审 2026-09-26 指出的同一个 SOS-11 洞。App 不在前台就一律显示；
  // 在前台时页面/Toast 自己负责，不弹系统横幅。
  return { show: appState !== "active" };
}

let presentationInstalled = false;
function installPresentationPolicy(): void {
  if (presentationInstalled) return;
  presentationInstalled = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (n) => {
        const { show } = sosPresentation(
          n.request.content.categoryIdentifier,
          AppState.currentState,
        );
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: show,
          shouldSetBadge: false,
        };
      },
    });
  } catch (e) {
    devLog("SOS-ALERT", "前台展示策略安装失败", e as Error);
  }
}

/**
 * 冷启动那次点击既从 getLastNotificationResponse 取到，也可能稍后再由监听送来一遍（平台 / 版本不一）：
 * 记下它，几秒内监听送来同一条就跳过一次。不能做成「处理过的永久去重」——取消失败、通知还留在锁屏上时，
 * 用户再点一次「取消」是同一条通知的同一个动作，必须照常处理。
 */
const LAUNCH_REPLAY_WINDOW_MS = 5_000;
let launchReplay: { key: string; at: number } | null = null;
const responseKey = (r: Notifications.NotificationResponse): string =>
  `${r.notification?.request?.identifier}|${r.actionIdentifier}|${r.notification?.date}`;

function handleResponse(response: Notifications.NotificationResponse): void {
  const replay = launchReplay;
  if (replay && responseKey(response) === replay.key) {
    launchReplay = null;
    if (Date.now() - replay.at < LAUNCH_REPLAY_WINDOW_MS) return;
  }
  dispatchResponse(response);
}

type SosRef = { sosId: string; deviceId?: string; remote: boolean };

/**
 * 通知指的是哪一单。本地通知的 sosId 在 content.data；极光远程推送的在 trigger.payload
 * （content.data 是给 Expo 推送服务用的，极光的自定义字段不在那）。
 */
function sosRefOf(
  n: Notifications.Notification | null | undefined,
): SosRef | null {
  const request = n?.request;
  const data = request?.content?.data as
    { sosId?: unknown; deviceId?: unknown } | null | undefined;
  if (typeof data?.sosId === "string" && data.sosId) {
    return {
      sosId: data.sosId,
      deviceId: typeof data.deviceId === "string" ? data.deviceId : undefined,
      remote: false,
    };
  }
  const trigger = request?.trigger as
    { type?: string; payload?: Record<string, unknown> } | null | undefined;
  const payload = trigger?.type === "push" ? trigger.payload : undefined;
  if (typeof payload?.sosId === "string" && payload.sosId) {
    return {
      sosId: payload.sosId,
      deviceId:
        typeof payload.deviceId === "string" ? payload.deviceId : undefined,
      remote: true,
    };
  }
  return null;
}

function dispatchResponse(response: Notifications.NotificationResponse): void {
  const ref = sosRefOf(response?.notification);
  if (!ref) return;
  // 远程推送上的普通点击由 push.ts 落地（极光自己有「被点开」事件）；这里只接它的「取消」按钮——
  // 服务端给推送带上同一个通知类别之后，被杀状态下那条推送也有按钮（2026-10-06 iPhone 实测：
  // 两条通知叠在一起，长按到的是没有按钮的远程推送）
  if (ref.remote && response.actionIdentifier !== ACTION_CANCEL) return;
  const sosId = ref.sosId;
  if (response.actionIdentifier === ACTION_CANCEL) {
    devLog("SOS-ALERT", "通知按钮取消", sosId);
    // 只有服务端确认取消才撤通知（cancelFromNotification 内部做，重试成功也算）；
    // 失败时通知留在锁屏上，用户能看到「还在倒计时」并再点一次
    void cancelFromNotification(sosId, 0, ref.deviceId);
    // 按钮会拉起 App：落到这一单的页面（取消中 → 已取消，还能点「我还是需要帮助」）。进程活着时倒计时页本来就在栈上，
    // navigate 不再叠一页；进程被杀后冷启动原来只落在设备页——看不到取消成没成，误点了也找不到「我还是需要帮助」（10-22 夜测）
    if (ref.deviceId) {
      presentedSos.current.add(sosId);
      router.navigate(sosActiveHref(sosId, ref.deviceId) as never);
    }
    return;
  }
  if (!ref.deviceId) return;
  // navigate 而不是 push：倒计时页多半已在栈上，push 会叠两页；登记后 WS / 补拉也不再重复拉起
  presentedSos.current.add(sosId);
  router.navigate(sosActiveHref(sosId, ref.deviceId) as never);
}

/**
 * 进程被杀后点锁屏通知（包括「取消」按钮）拉起 App：那次点击在 JS 监听挂上之前就送达了，
 * 监听不会回放，只能从 getLastNotificationResponse 取。PUSH-03 只取回了远程推送那一类；
 * 本地 SOS 通知的不取回，「取消」就成了按了却没生效的键——60 s 后照样通知联系人（2026-10-05 评审）。
 * 远程推送的 content.data 里没有 sosId（极光的自定义字段在 trigger.payload），留给 push.ts。
 */
function consumeLaunchResponse(): void {
  try {
    const last = Notifications.getLastNotificationResponse();
    const ref = sosRefOf(last?.notification);
    if (!last || !ref) return;
    if (ref.remote) {
      // 远程推送：只接「取消」按钮；不清——落地跳转仍归 push.ts（它读的是同一条）
      if (last.actionIdentifier !== ACTION_CANCEL) return;
      devLog("SOS-ALERT", "冷启动：由远程推送的取消按钮拉起");
    } else {
      devLog("SOS-ALERT", "冷启动：由本地通知拉起", last.actionIdentifier);
      Notifications.clearLastNotificationResponse();
    }
    launchReplay = { key: responseKey(last), at: Date.now() };
    dispatchResponse(last);
  } catch (e) {
    devLog("SOS-ALERT", "读取启动通知失败", e as Error);
  }
}

function installResponseHandler(): void {
  if (responseSub) return;
  responseSub =
    Notifications.addNotificationResponseReceivedListener(handleResponse);
  consumeLaunchResponse();
}

/** O34：取消成功、App 却没被拉到前台时补的那条「已取消」通知 */
const RESULT_CHANNEL_ID = "sos-result";
const confirmIdOf = (sosId: string) => `sos-cancelled-${sosId}`;
let resultChannelReady = false;

async function ensureResultChannel(): Promise<void> {
  if (resultChannelReady) return;
  resultChannelReady = true;
  await createResultChannel();
}

function createResultChannel(): Promise<unknown> {
  // 安静的通道：取消是用户自己点的，结果只要看得到，不必再响一声、弹一次横幅
  return Notifications.setNotificationChannelAsync(RESULT_CHANNEL_ID, {
    name: translate("sosAlert.resultChannel"),
    importance: Notifications.AndroidImportance.LOW,
  }).catch(() => undefined);
}

/**
 * 华为等手机默认不许 App 从后台弹页面：点通知上的「我没事，取消」后取消成功了，App 却没被拉到前台、通知栏也不收，
 * 用户看不到「已取消」（10-22 华为实测）。这时补一条安静的通知说明结果，点开进这一单的结果页；App 回到前台
 * （页面已经看得到）就撤掉（负责人 10-22 定 O34 = B）。不用定时器等：安卓上 App 在后台时 JS 定时器不走。
 * iOS 点按钮一定会拉起 App，只做安卓
 */
function confirmCancelledIfHidden(sosId: string, deviceId?: string): void {
  if (Platform.OS !== "android" || AppState.currentState === "active") return;
  const id = confirmIdOf(sosId);
  const sub = AppState.addEventListener("change", (state) => {
    if (state !== "active") return;
    sub.remove();
    void Notifications.dismissNotificationAsync(id).catch(() => undefined);
  });
  void ensureResultChannel()
    .then(() =>
      Notifications.scheduleNotificationAsync({
        identifier: id,
        content: {
          title: translate("sosAlert.cancelledTitle"),
          body: translate("sos.cancelledBody"),
          data: {
            sosId,
            ...(deviceId ? { deviceId } : {}),
            kind: "sos-cancelled",
          },
        },
        trigger: { channelId: RESULT_CHANNEL_ID },
      }),
    )
    .catch((e: Error) => devLog("SOS-ALERT", "补发「已取消」通知失败", e));
}

/** 失败后的重试节奏：请求被挂起中断多半几秒内就能恢复，三次之后放弃（通知仍留在锁屏上） */
const CANCEL_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;
/** 按单分槽：两台头盔两单并存时，点第二单的「取消」不能把第一单的重试清掉（10-06 并发评审 F2） */
const cancelRetries = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    cancelWake: () => void;
    sub: { remove: () => void };
  }
>();

function clearCancelRetry(sosId: string): void {
  const entry = cancelRetries.get(sosId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.cancelWake();
  entry.sub.remove();
  cancelRetries.delete(sosId);
}

/**
 * 通知按钮「取消」→ 调服务端。失败（多半是进程在请求途中被挂起）按 2s/5s/10s 重试三次，
 * 期间 App 回到前台也立刻触发一次；服务端幂等，已取消/已到期的单回 SOS_ALREADY_FINALIZED，当成功处理。
 * 注意动作是 opensAppToForeground=true：回调跑起来时 App 通常已经 active，所以不能只等「下一次 active」。
 */
export async function cancelFromNotification(
  sosId: string,
  attempt = 0,
  deviceId?: string,
): Promise<boolean> {
  clearCancelRetry(sosId);
  // 在途标记：倒计时页据此显示「取消中…」、不响警报（被杀状态下点通知按钮，页面要过启动动画才出来）
  useSosCancelStore.getState().begin(sosId);
  // 成功的收尾放在这里而不是调用方的 .then：重试成功时调用方早就拿着第一次的 false 走了，
  // 通知会一直留在锁屏上、预排的「还剩 30 秒」照常弹（2026-10-05 评审）
  // 取消成功的返回值（已是 cancelled 的单）要交给页面直接写进缓存：弱网下紧接着的两次快照都失败时，
  // 页面会回落到缓存里的 pending，从「取消中…」变回倒计时并重新响警报，而服务端其实已取消（10-14 代码审查）
  const settled = (sos?: Sos): true => {
    useSosCancelStore.getState().end(sosId);
    void clearSosAlert(sosId);
    // 远程推送那条也撤掉：被杀状态下它是通知中心里唯一的一条，取消完还留着，用户会再去长按（10-07 实测）
    void dismissRemoteTwins(sosId);
    try {
      onCancelConfirmed?.(sosId, sos);
    } catch (e) {
      devLog("SOS-ALERT", "取消确认回调抛错", e as Error);
    }
    return true;
  };
  try {
    // 超时显式用全局的 15 s，不跟倒计时页的 8 s（O7，10-20）：这条链路前三次重试没有人在看，
    // 每一次都该给足时间——慢但通的网络（一次要 9–14 s）下 15 s 能一次成功，8 s 会四次全超时、
    // 最后把人带到页面上说「取消没送达」。节奏（2 / 5 / 10 s）是 10-07 iPhone 实测调过的，O7 不动它
    const sos = await sosApi.cancel(sosId, { timeoutMs: REQUEST_TIMEOUT_MS });
    // 应答不像这一单（网关改写过）：照样算取消成功（200 说明服务端收到了），但别把它交给页面写进缓存，
    // 页面拿不到就按「已在别处结束」拉一次权威状态（10-22 夜测）
    const ok = isSosFor(sos, sosId) ? sos : undefined;
    // 只在确知是「已取消」时补确认通知：已在别处结束（可能已通知）、应答看不懂时都不说「已取消」
    if (ok?.status === "cancelled") confirmCancelledIfHidden(sosId, deviceId);
    return settled(ok);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "SOS_ALREADY_FINALIZED") return settled();
    // 会话已失效（O19-A：倒计时走完才登出）：请求根本没发出去，重试 17 秒也是同一个结果。
    // 原来按网络失败重试，最后才说「没送达」，用户不知道要重新登录
    if (code === "SESSION_ENDED") {
      devLog("SOS-ALERT", "通知取消：会话已失效，不再重试");
      useSosCancelStore.getState().end(sosId);
      showNotice(
        translate("sosAlert.cancelFailedTitle"),
        translate("error.sessionEnded"),
      );
      return false;
    }
    const status = (e as { status?: unknown }).status;
    if (status === 404 || status === 403) {
      // 服务端明确说这单不在你名下（别的手机解绑了、换了账号）：重试永远同一个结果，别让人白等 17 秒；
      // 撤掉通知并说明（与上行队列 isUnrecoverable 同口径，10-16 A10）
      devLog(
        "SOS-ALERT",
        `通知取消被服务端拒绝（${status}），不再重试`,
        e as Error,
      );
      useSosCancelStore.getState().end(sosId);
      void clearSosAlert(sosId);
      void dismissRemoteTwins(sosId);
      showNotice(
        translate("sosAlert.cancelGoneTitle"),
        translate("sosAlert.cancelGoneBody"),
      );
      return false;
    }
    const delay = CANCEL_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      // 用尽后用户多半正盯着首页（动作是拉起 App 的），什么提示都没有就等于「按了没反应」。
      // 把人带到倒计时页并说明取消没送达，让他在页上再按一次（10-06 不变式评审 F-11）
      devLog("SOS-ALERT", "通知取消重试用尽，带用户到倒计时页重试", e as Error);
      useSosCancelStore.getState().end(sosId); // 页面上的按钮恢复可点，让他再按一次
      if (deviceId) {
        presentedSos.current.add(sosId);
        router.navigate(sosActiveHref(sosId, deviceId) as never);
      }
      showNotice(
        translate("sosAlert.cancelFailedTitle"),
        translate("sosAlert.cancelFailedBody"),
      );
      return false;
    }
    devLog(
      "SOS-ALERT",
      `通知取消失败，${delay} ms 后重试（第 ${attempt + 1} 次）`,
      e as Error,
    );
    // 定时器到点才算用掉一次机会；回前台触发的那次不计数——否则飞行模式下点「取消」，
    // 拉起 App 的 inactive → active 过渡会在同一秒内把三次机会全部打光，网络还没回来就弹「失败，请再点一次」
    //（2026-10-07 iPhone 实测）。按 2 / 5 / 10 s 的节奏等下去，飞行模式一关自然就成了
    const retry = (advance: boolean) => {
      clearCancelRetry(sosId);
      void cancelFromNotification(
        sosId,
        advance ? attempt + 1 : attempt,
        deviceId,
      );
    };
    cancelRetries.set(sosId, {
      timer: setTimeout(() => retry(true), delay),
      // 点完取消马上回桌面 / 锁屏：安卓后台 JS 定时器不跑，只靠上面那个定时器的话重试一次都发不出去，
      // 单子到期照样通知联系人，用户还以为取消了（11-01 模拟器实测）。原生到点叫醒，谁先到谁算
      cancelWake: HelmetLinkService.backgroundWake(delay, () => retry(true)),
      sub: AppState.addEventListener("change", (state) => {
        if (state === "active") retry(false);
      }),
    });
    return false;
  }
}

/**
 * Android：App 的通知总开关开着，但求救那条通道被单独关了，锁屏提醒照样一条都出不来，
 * 而 getPermissionsAsync 仍报 granted。华为 P30 实测（2026-10-19）：通知总开关关着的时候
 * App 首次启动建的通道会被记成「关闭」，之后把总开关打开，通道还是关的——界面得把这种也算成未开启，
 * 把人带到系统的通知设置页（通道开关就在那一页上）。通道还没建、查不到都按没关处理，不吓唬用户。
 * 被调成「静默」（LOW / MIN）同样算：通知只进通知栏，不响、不震、不弹横幅，求救倒计时等于没提醒，
 * 原来照样写「已开启」（10-21 模拟器：通道改成 Silent 后来单，桌面上什么都没有）。「默认」（会响、不弹横幅）不算。
 */
export async function isSosChannelBlocked(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    const ch = await Notifications.getNotificationChannelAsync(SOS_CHANNEL_ID);
    return (
      ch !== null &&
      ch.importance >= Notifications.AndroidImportance.NONE &&
      ch.importance <= Notifications.AndroidImportance.LOW
    );
  } catch {
    return false;
  }
}

/**
 * Android：求救通道在勿扰模式下能不能照常提醒。建通道时申请的 bypassDnd 系统不认（没有勿扰权限的 App
 * 申请了也记成 false，模拟器 / 华为 dumpsys 都是 mBypassDnd=false），只有用户在这条通道的设置里打开
 * 「允许打扰 / Override Do Not Disturb」才是 true。不是 true 时开着勿扰锁屏来单，通知被系统拦下：
 * 没有横幅、没有声音和震动，误报也来不及取消（2026-10-21 模拟器 dumpsys mIntercept=true）。
 * iOS（本地和远程求救通知都是 time-sensitive，专注模式默认放行）、通道还没建、查不到都返回 null，不显示这一项。
 */
export async function sosChannelBypassesDnd(): Promise<boolean | null> {
  if (Platform.OS !== "android") return null;
  try {
    const ch = await Notifications.getNotificationChannelAsync(SOS_CHANNEL_ID);
    if (ch === null) return null;
    return ch.bypassDnd === true;
  } catch {
    return null;
  }
}

/** deadline 认不出来（不是合法时间）时返回 null：提醒照弹，但不显示读秒、不排刷新 */
function remainingSeconds(deadline: string): number | null {
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - serverNow()) / 1000)); // deadline 是服务端时间（F-3）
}

/** pending SOS 到达且 App 不在前台 → 立即弹本地通知（同一单只弹一次），并按剩余时间预排静默刷新 */
export async function showSosAlertIfBackground(
  sosId: string,
  deviceId: string,
  deadline: string,
  triggeredAt?: string,
  /** 头盔显示名（用户改过名用改过的名字）；不知道时只写类型 */
  helmetName?: string,
): Promise<void> {
  if (AppState.currentState === "active") return;
  if (alerts.has(sosId)) return;
  const entry = {
    ids: [] as string[],
    timers: [] as ReturnType<typeof setTimeout>[],
  };
  alerts.set(sosId, entry);
  // 排通知要 await 好几次：期间若这单已被取消（clearSosAlert 把它从表里摘掉），
  // 后面的一条都不能再排，刚排上的也要撤——否则会留下一条「还剩 30 秒」的孤儿提醒（疑点 4）
  const alive = () => alerts.get(sosId) === entry;
  const total = remainingSeconds(deadline);
  // 补传的旧事件：正文点明「约 3 小时前的事件，刚补传到」（决策 #52；此前只在远程推送里，iOS 上那条会被撤掉）
  const late = lateEventNote(triggeredAt, serverNow());
  const content = (seconds: number | null, sound: boolean) => ({
    // 带上是哪顶头盔：iPhone 上远程推送会被这条替换掉，绑了几顶时只看标题分不清是谁（负责人 10-15）
    title: helmetName
      ? translate("sosAlert.titleWithHelmet", { name: helmetName })
      : translate("sosAlert.title"),
    body:
      (seconds === null
        ? translate("sosAlert.body")
        : // 正文里的秒数封顶 60：时钟偏移估计偏小时刚到会算出 61（10-16 iPhone）；预排刷新仍按真实剩余时间
          translate("sosAlert.bodyCountdown", {
            seconds: shownSeconds(seconds),
          })) + (late ? translate("sosAlert.lateSuffix", { note: late }) : ""),
    // Android 上 "default" 会被当成自定义音频文件名报错；true = 通道默认铃声
    sound: sound ? (Platform.OS === "ios" ? "default" : true) : false,
    interruptionLevel: "timeSensitive" as const,
    priority: Notifications.AndroidNotificationPriority.MAX,
    categoryIdentifier: CATEGORY_ID,
    // lockscreenVisibility：系统开了「隐藏敏感内容」时锁屏上也照常显示（O31；安卓靠 patches/expo-notifications，iOS 不认这个键）
    data: { sosId, deviceId, lockscreenVisibility: "public" },
  });
  /** 排一条；排完发现这单已被清掉就立刻撤回，返回是否还该继续 */
  let armed = false;
  const schedule = async (
    id: string,
    request: Parameters<typeof Notifications.scheduleNotificationAsync>[0],
  ): Promise<boolean> => {
    entry.ids.push(id);
    await Notifications.scheduleNotificationAsync(request);
    armed = true;
    if (alive()) return true;
    await removeNotification(id);
    return false;
  };
  try {
    const baseId = alertIdsOf(sosId)[0];
    // 同一单的远程推送「倒计时已开始」没有按钮，和本地通知叠成一摞时用户长按到的常常是它
    // （2026-10-06 iPhone 实测）。本地这条内容更全、带按钮，弹出后把那条远程的撤掉；
    // 远程推送可能晚到，JS 醒着的话隔几秒再扫两遍
    const sweep = () => {
      if (!alive()) return;
      void dismissRemoteTwins(sosId);
      // 安卓同理：极光那条没有按钮，锁屏「隐藏通知内容」时还会被打码成「零一智行 · 1 个通知」；
      // 本地这条锁屏照常显示（O31），弹出后把极光那条按编号撤掉（O12 / O31，10-21 晚）——前提是本地这条看得见
      clearStartPushIfLocalVisible(sosId);
    };
    entry.timers.push(setTimeout(sweep, 3_000), setTimeout(sweep, 10_000));
    if (
      !(await schedule(baseId, {
        identifier: baseId,
        content: content(total, true),
        // Android 的通道只从 trigger 里读（content.channelId 原生侧根本不看）：trigger 传 null 时
        // 这条唯一响铃的通知落在 expo 的兜底通道 Miscellaneous，用户给「SOS」通道开的勿扰例外、
        // 铃声都作用不到它（2026-10-05 评审，expo-notifications BaseNotificationBuilder.kt）
        trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
      }))
    )
      return;
    // 倒计时刷新：iOS 本地通知不能原地改字，只能到点再投一次同 id（横幅会再闪一下，但不响铃）；
    // Android 同 id 直接原位更新。只刷两次，避免锁屏被刷屏。
    for (const at of REFRESH_AT) {
      if (total === null) break;
      const delay = total - at;
      if (delay < 3) continue;
      // 第二次用另一个 id：同 id 的待触发请求会互相覆盖
      const id = refreshIdOf(sosId, at);
      if (
        !(await schedule(id, {
          identifier: id,
          content: content(at, false),
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: delay,
            ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
          },
        }))
      )
        return;
    }
    sweep();
    devLog("SOS-ALERT", `锁屏通知已弹 ${sosId} 剩余 ${total ?? "?"}s`);
  } catch (e) {
    devLog("SOS-ALERT", "本地通知失败", e as Error);
    // 一条都没排上（第一条就抛错）：把这一单从去重表里撤掉，离开前台 / 补拉时还能再试——
    // 原来留在表里，之后再叫也不再排，这一单就再没有锁屏提醒了（10-16 A9）
    if (!armed && alive()) {
      for (const t of entry.timers) clearTimeout(t);
      alerts.delete(sosId);
    }
  }
}

/**
 * 撤掉通知中心里这一单的远程推送「倒计时已开始」（iOS：它在 expo 的已送达列表里、自定义字段在 trigger.payload）。
 * 只认带类别 sos 的那条——结果通知（已通知联系人 / 发送失败）不带类别，要留给用户看（O12，负责人 10-21 定）。
 * 安卓上极光的通知 expo 列得出来但读不到单号，走 sos-start-push 记下的极光编号
 */
async function dismissRemoteTwins(sosId: string): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    for (const n of shown) {
      const ref = sosRefOf(n);
      if (
        ref?.remote &&
        ref.sosId === sosId &&
        n.request.content.categoryIdentifier === CATEGORY_ID
      )
        await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch (e) {
    devLog("SOS-ALERT", "清理重复的远程通知失败", e as Error);
  }
}

/** 账号下除了这一单还有别的单在倒数吗（use-realtime 按查询缓存注册）；没注册时当作还有，不乱撤 */
let otherSosPending: (sosId: string) => boolean = () => true;
export function setOtherSosPendingCheck(
  check: ((sosId: string) => boolean) | null,
): void {
  otherSosPending = check ?? (() => true);
}

/** expo 给别的 SDK 贴的通知起的标识（ExpoPresentationDelegate.getInternalIdentifierKey） */
const FOREIGN_NOTIFICATION_PREFIX =
  "expo-notifications://foreign_notifications";

/**
 * 安卓兜底：App 被杀时到达的极光「倒计时已开始」没记到编号（到达事件那时 JS 没在跑），单子结束后撤不掉。
 * 账号下已经没有别的单在倒数时，按标题把通知栏里剩下的这类通知都撤掉——它们指的单肯定都结束了。
 * 还有别的单在倒数就不碰（认不出哪条是哪单的）
 */
async function dismissOrphanStartPushes(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    for (const n of shown) {
      if (
        n.request.identifier.startsWith(FOREIGN_NOTIFICATION_PREFIX) &&
        n.request.content.title === SOS_START_PUSH_TITLE
      )
        await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch (e) {
    devLog("SOS-ALERT", "清理极光遗留通知失败", e as Error);
  }
}

async function removeNotification(id: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // 已触发的没有待取消项
  }
  try {
    await Notifications.dismissNotificationAsync(id);
  } catch {
    // 通知可能已被用户划掉
  }
}

/** SOS 不再 pending（取消/确认/已通知）→ 撤掉已投的通知、取消还没到点的刷新 */
export async function clearSosAlert(sosId: string): Promise<void> {
  const entry = alerts.get(sosId);
  alerts.delete(sosId); // 先摘表：还在排通知的 show 循环看到后会自己停下并撤回
  if (entry) for (const t of entry.timers) clearTimeout(t);
  // 表里没有这单时也按固定的编号撤一遍：进程被杀后点通知按钮取消、冷启动的这个进程表是空的，
  // 通知和预排的「还剩 N 秒」是上一个进程排的。不撤的话已取消的单一直挂在通知栏，App 退到后台后
  // 「还剩 10 秒」照样会弹（10-17 夜模拟器实测）
  const ids = [...(entry?.ids ?? [])];
  for (const id of alertIdsOf(sosId)) if (!ids.includes(id)) ids.push(id);
  // 极光那条「倒计时已开始」也撤（O12）：别处取消、到点通知时原来没人撤，一直挂着让人以为还在倒数
  clearSosStartPush(sosId);
  void dismissRemoteTwins(sosId);
  if (!otherSosPending(sosId)) void dismissOrphanStartPushes();
  for (const id of ids) await removeNotification(id);
}

/** 这个进程扫过一次了：残留只可能来自上一个进程，本进程排的都在 alerts 表里 */
let staleSwept = false;

/**
 * 进程被杀期间单子结束：通知和预排的「还剩 N 秒」是上一个进程排的，这个进程的 alerts 是空的，缓存也是空的，
 * 补拉发现不了它们，通知一直挂着、还带「我没事，取消」（11-01 模拟器实测，重开 App 42 秒后还在）。
 * 第一次拿到全量的进行中列表时按它扫一遍；本进程登记过的单不碰（可能比这份列表新）
 */
export async function sweepStaleAlerts(
  activeIds: ReadonlySet<string>,
): Promise<void> {
  if (staleSwept) return;
  staleSwept = true;
  try {
    const [shown, scheduled] = await Promise.all([
      Notifications.getPresentedNotificationsAsync(),
      Notifications.getAllScheduledNotificationsAsync(),
    ]);
    const found = new Set<string>();
    for (const n of shown) {
      const ref = sosRefOf(n);
      if (ref && !ref.remote) found.add(ref.sosId);
    }
    for (const req of scheduled) {
      const id = (req.content?.data as { sosId?: unknown } | null | undefined)
        ?.sosId;
      if (typeof id === "string" && id) found.add(id);
    }
    for (const sosId of found) {
      if (activeIds.has(sosId) || alerts.has(sosId)) continue;
      devLog("SOS-ALERT", "撤掉上一个进程留下的提醒", sosId);
      await clearSosAlert(sosId);
    }
  } catch (e) {
    devLog("SOS-ALERT", "扫残留提醒失败", e as Error);
  }
}

/** 登出：上一个账号的 SOS 提醒不该留在这台手机上（留着也取消不了——没有 token，重试只会静默用尽） */
export async function resetSosAlerts(): Promise<void> {
  staleSwept = false;
  for (const sosId of [...cancelRetries.keys()]) clearCancelRetry(sosId);
  // 在途标记一并清：重试停了标记还在，重新登录后同一单的倒计时页会一直「取消中…」、按钮点不了、警报静音
  const cancelStore = useSosCancelStore.getState();
  for (const sosId of Object.keys(cancelStore.inFlight)) cancelStore.end(sosId);
  for (const sosId of [...alerts.keys()]) await clearSosAlert(sosId);
}
