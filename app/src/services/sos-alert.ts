// SOS 锁屏提醒：App 不在前台时收到 pending 的 SOS 推送，用本地通知把「摔倒/求救倒计时」顶到锁屏上。
// 背景：iOS 锁屏下 SOS 页的 expo-audio 警报音激活会失败（AVAudioSession 不允许后台起播，2026-09-17
// 真机实测：事件当秒上云、页面已推、但用户听不到任何声音）；本地通知的声音与横幅不依赖音频会话，
// 是锁屏告警唯一可靠的路径。Android 上同样走这里（前台服务的常驻通知是静音的）。
// 服务端仍是 SOS 权威，这里只做提醒 + 把「误触取消」放到通知按钮上少一次解锁；不做任何判断。
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { sosApi } from "@/api/sos";
import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";
import { presentedSos } from "@/services/sos-sync";

const CHANNEL_ID = "sos";
const CATEGORY_ID = "sos";
const ACTION_CANCEL = "cancel";
const ACTION_OPEN = "open";
/** 剩余多少秒时再静默刷新一次通知正文（同一 identifier 原位替换，不再响铃） */
const REFRESH_AT = [30, 10] as const;

/** 初始化只做一次；并发 / 重复调用拿到同一个 Promise（调用方要等它结束再去要别的权限） */
let permissionReady: Promise<void> | null = null;
/**
 * 每一单各自的通知：sosId → 已投 / 待触发的通知 id。原来只有一个槽位，第二单会把第一单顶掉，
 * 第一单结束时 clear 找不到它，通知永远留在锁屏上（10-03 评审疑点 2）。
 */
const alerts = new Map<string, { ids: string[] }>();
let responseSub: Notifications.EventSubscription | null = null;
/** 通知按钮「取消」被服务端确认后回调（use-realtime 注册：让倒计时页立刻拉一次权威状态） */
let onCancelConfirmed: ((sosId: string) => void) | null = null;
export function setSosCancelConfirmedListener(
  listener: ((sosId: string) => void) | null,
): void {
  onCancelConfirmed = listener;
}

/** 登录后调用一次：申请通知权限、建 Android 高优先级通道、注册通知动作（拒绝也不阻塞链路） */
export function ensureSosAlertPermission(): Promise<void> {
  permissionReady ??= initSosAlert();
  return permissionReady;
}

async function initSosAlert(): Promise<void> {
  installPresentationPolicy();
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: translate("sosAlert.channel"),
        importance: Notifications.AndroidImportance.MAX,
        // 不传 sound：Android 把字符串当成打包进 App 的自定义音频资源名，传 "default"
        // 会在每次启动打一条 ERROR（华为 P30 Pro 实测）然后回落到系统默认铃声——
        // 省掉这层报错，直接要系统默认。
        vibrationPattern: [0, 500, 250, 500],
        lockscreenVisibility:
          Notifications.AndroidNotificationVisibility.PUBLIC,
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
    installResponseHandler();
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) await Notifications.requestPermissionsAsync();
  } catch (e) {
    devLog("SOS-ALERT", "通知权限/通道初始化失败", e as Error);
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

function dispatchResponse(response: Notifications.NotificationResponse): void {
  const data = response?.notification?.request?.content?.data as
    { sosId?: unknown; deviceId?: unknown } | null | undefined;
  if (typeof data?.sosId !== "string" || !data.sosId) return;
  const sosId = data.sosId;
  if (response.actionIdentifier === ACTION_CANCEL) {
    devLog("SOS-ALERT", "通知按钮取消", sosId);
    // 只有服务端确认取消才撤通知（cancelFromNotification 内部做，重试成功也算）；
    // 失败时通知留在锁屏上，用户能看到「还在倒计时」并再点一次
    void cancelFromNotification(sosId);
    return;
  }
  if (typeof data.deviceId !== "string" || !data.deviceId) return;
  // navigate 而不是 push：倒计时页多半已在栈上，push 会叠两页；登记后 WS / 补拉也不再重复拉起
  presentedSos.current.add(sosId);
  router.navigate(
    `/sos-active?sosId=${sosId}&deviceId=${data.deviceId}` as never,
  );
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
    const data = last?.notification?.request?.content?.data as
      { sosId?: unknown } | null | undefined;
    if (!last || typeof data?.sosId !== "string" || !data.sosId) return;
    devLog("SOS-ALERT", "冷启动：由本地通知拉起", last.actionIdentifier);
    Notifications.clearLastNotificationResponse();
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

/** 失败后的重试节奏：请求被挂起中断多半几秒内就能恢复，三次之后放弃（通知仍留在锁屏上） */
const CANCEL_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;
let cancelRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cancelRetrySub: { remove: () => void } | null = null;

function clearCancelRetry(): void {
  if (cancelRetryTimer) clearTimeout(cancelRetryTimer);
  cancelRetryTimer = null;
  cancelRetrySub?.remove();
  cancelRetrySub = null;
}

/**
 * 通知按钮「取消」→ 调服务端。失败（多半是进程在请求途中被挂起）按 2s/5s/10s 重试三次，
 * 期间 App 回到前台也立刻触发一次；服务端幂等，已取消/已到期的单回 SOS_ALREADY_FINALIZED，当成功处理。
 * 注意动作是 opensAppToForeground=true：回调跑起来时 App 通常已经 active，所以不能只等「下一次 active」。
 */
export async function cancelFromNotification(
  sosId: string,
  attempt = 0,
): Promise<boolean> {
  clearCancelRetry();
  // 成功的收尾放在这里而不是调用方的 .then：重试成功时调用方早就拿着第一次的 false 走了，
  // 通知会一直留在锁屏上、预排的「还剩 30 秒」照常弹（2026-10-05 评审）
  const settled = (): true => {
    void clearSosAlert(sosId);
    try {
      onCancelConfirmed?.(sosId);
    } catch (e) {
      devLog("SOS-ALERT", "取消确认回调抛错", e as Error);
    }
    return true;
  };
  try {
    await sosApi.cancel(sosId);
    return settled();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "SOS_ALREADY_FINALIZED") return settled();
    const delay = CANCEL_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      devLog("SOS-ALERT", "通知取消重试用尽，通知保留在锁屏", e as Error);
      return false;
    }
    devLog(
      "SOS-ALERT",
      `通知取消失败，${delay} ms 后重试（第 ${attempt + 1} 次）`,
      e as Error,
    );
    const retry = () => {
      clearCancelRetry();
      void cancelFromNotification(sosId, attempt + 1);
    };
    cancelRetryTimer = setTimeout(retry, delay);
    cancelRetrySub = AppState.addEventListener("change", (state) => {
      if (state === "active") retry();
    });
    return false;
  }
}

/**
 * 通知权限是否被拒：被拒时锁屏上的 SOS 提醒一条都发不出，安全页要明确告诉用户（REGRESSION 8.2）。
 * 「还没问过」不算被拒——新用户首次登录时系统授权框还没弹完，安全页就先查到 undetermined，
 * 原来 `!granted` 会立刻弹「通知权限已关闭」并和系统框叠在一起（2026-10-05 评审）。
 */
export async function isSosAlertPermissionDenied(): Promise<boolean> {
  try {
    const p = await Notifications.getPermissionsAsync();
    if (p.granted) return false;
    return (p as { status?: string }).status !== "undetermined";
  } catch {
    return false; // 查不到权限状态时不吓唬用户
  }
}

/** deadline 认不出来（不是合法时间）时返回 null：提醒照弹，但不显示读秒、不排刷新 */
function remainingSeconds(deadline: string): number | null {
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/** pending SOS 到达且 App 不在前台 → 立即弹本地通知（同一单只弹一次），并按剩余时间预排静默刷新 */
export async function showSosAlertIfBackground(
  sosId: string,
  deviceId: string,
  deadline: string,
): Promise<void> {
  if (AppState.currentState === "active") return;
  if (alerts.has(sosId)) return;
  const entry = { ids: [] as string[] };
  alerts.set(sosId, entry);
  // 排通知要 await 好几次：期间若这单已被取消（clearSosAlert 把它从表里摘掉），
  // 后面的一条都不能再排，刚排上的也要撤——否则会留下一条「还剩 30 秒」的孤儿提醒（疑点 4）
  const alive = () => alerts.get(sosId) === entry;
  const total = remainingSeconds(deadline);
  const content = (seconds: number | null, sound: boolean) => ({
    title: translate("sosAlert.title"),
    body:
      seconds === null
        ? translate("sosAlert.body")
        : translate("sosAlert.bodyCountdown", { seconds }),
    // Android 上 "default" 会被当成自定义音频文件名报错；true = 通道默认铃声
    sound: sound ? (Platform.OS === "ios" ? "default" : true) : false,
    interruptionLevel: "timeSensitive" as const,
    priority: Notifications.AndroidNotificationPriority.MAX,
    categoryIdentifier: CATEGORY_ID,
    data: { sosId, deviceId },
  });
  /** 排一条；排完发现这单已被清掉就立刻撤回，返回是否还该继续 */
  const schedule = async (
    id: string,
    request: Parameters<typeof Notifications.scheduleNotificationAsync>[0],
  ): Promise<boolean> => {
    entry.ids.push(id);
    await Notifications.scheduleNotificationAsync(request);
    if (alive()) return true;
    await removeNotification(id);
    return false;
  };
  try {
    const baseId = `sos-${sosId}`;
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
      const id = at === REFRESH_AT[0] ? baseId : `${baseId}-${at}`;
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
    devLog("SOS-ALERT", `锁屏通知已弹 ${sosId} 剩余 ${total ?? "?"}s`);
  } catch (e) {
    devLog("SOS-ALERT", "本地通知失败", e as Error);
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
  if (!entry) return;
  alerts.delete(sosId); // 先摘表：还在排通知的 show 循环看到后会自己停下并撤回
  for (const id of [...entry.ids]) await removeNotification(id);
}

/** 登出：上一个账号的 SOS 提醒不该留在这台手机上（留着也取消不了——没有 token，重试只会静默用尽） */
export async function resetSosAlerts(): Promise<void> {
  clearCancelRetry();
  for (const sosId of [...alerts.keys()]) await clearSosAlert(sosId);
}
