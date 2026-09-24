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

const CHANNEL_ID = "sos";
const CATEGORY_ID = "sos";
const ACTION_CANCEL = "cancel";
const ACTION_OPEN = "open";
/** 剩余多少秒时再静默刷新一次通知正文（同一 identifier 原位替换，不再响铃） */
const REFRESH_AT = [30, 10] as const;

let permissionAsked = false;
let shownForSosId: string | null = null;
let notificationIds: string[] = [];
let responseSub: Notifications.EventSubscription | null = null;

/** 登录后调用一次：申请通知权限、建 Android 高优先级通道、注册通知动作（拒绝也不阻塞链路） */
export async function ensureSosAlertPermission(): Promise<void> {
  if (permissionAsked) return;
  permissionAsked = true;
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
  categoryIdentifier: string | null | undefined,
  appState: string,
): { show: boolean } {
  return { show: categoryIdentifier === CATEGORY_ID && appState !== "active" };
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

function installResponseHandler(): void {
  if (responseSub) return;
  responseSub = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response.notification.request.content.data as {
        sosId?: string;
        deviceId?: string;
      };
      if (!data?.sosId) return;
      if (response.actionIdentifier === ACTION_CANCEL) {
        devLog("SOS-ALERT", "通知按钮取消", data.sosId);
        void cancelFromNotification(data.sosId);
        void clearSosAlert(data.sosId);
        return;
      }
      router.push(`/sos-active?sosId=${data.sosId}&deviceId=${data.deviceId}`);
    },
  );
}

/** 等 App 回到前台后要补发的取消（后台请求被 iOS 挂起中断时兜底） */
let retryCancelSosId: string | null = null;
let retrySub: { remove: () => void } | null = null;

/**
 * 通知按钮「取消」→ 调服务端。失败（多半是进程在请求途中被挂起）就记下来，
 * 回到前台立刻重试一次；服务端幂等，已取消的单会回 SOS_ALREADY_FINALIZED，当成功处理。
 */
export async function cancelFromNotification(sosId: string): Promise<boolean> {
  try {
    await sosApi.cancel(sosId);
    retryCancelSosId = null;
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "SOS_ALREADY_FINALIZED") return true;
    devLog("SOS-ALERT", "通知取消失败，回前台重试", e as Error);
    retryCancelSosId = sosId;
    if (!retrySub) {
      retrySub = AppState.addEventListener("change", (state) => {
        if (state !== "active" || !retryCancelSosId) return;
        const id = retryCancelSosId;
        retryCancelSosId = null;
        devLog("SOS-ALERT", "前台重试取消", id);
        void cancelFromNotification(id);
      });
    }
    return false;
  }
}

function remainingSeconds(deadline: string): number {
  return Math.max(0, Math.round((Date.parse(deadline) - Date.now()) / 1000));
}

/** pending SOS 到达且 App 不在前台 → 立即弹本地通知（同一单只弹一次），并按剩余时间预排静默刷新 */
export async function showSosAlertIfBackground(
  sosId: string,
  deviceId: string,
  deadline: string,
): Promise<void> {
  if (AppState.currentState === "active") return;
  if (shownForSosId === sosId) return;
  shownForSosId = sosId;
  const total = remainingSeconds(deadline);
  const content = (seconds: number, sound: boolean) => ({
    title: translate("sosAlert.title"),
    body: translate("sosAlert.bodyCountdown", { seconds }),
    // Android 上 "default" 会被当成自定义音频文件名报错；true = 通道默认铃声
    sound: sound ? (Platform.OS === "ios" ? "default" : true) : false,
    interruptionLevel: "timeSensitive" as const,
    priority: Notifications.AndroidNotificationPriority.MAX,
    categoryIdentifier: CATEGORY_ID,
    data: { sosId, deviceId },
    ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
  });
  try {
    const baseId = `sos-${sosId}`;
    notificationIds = [baseId];
    await Notifications.scheduleNotificationAsync({
      identifier: baseId,
      content: content(total, true),
      trigger: null,
    });
    // 倒计时刷新：iOS 本地通知不能原地改字，只能到点再投一次同 id（横幅会再闪一下，但不响铃）；
    // Android 同 id 直接原位更新。只刷两次，避免锁屏被刷屏。
    for (const at of REFRESH_AT) {
      const delay = total - at;
      if (delay < 3) continue;
      // 第二次用另一个 id：同 id 的待触发请求会互相覆盖
      const id = at === REFRESH_AT[0] ? baseId : `${baseId}-${at}`;
      notificationIds.push(id);
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: content(at, false),
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: delay,
          ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
        },
      });
    }
    devLog("SOS-ALERT", `锁屏通知已弹 ${sosId} 剩余 ${total}s`);
  } catch (e) {
    devLog("SOS-ALERT", "本地通知失败", e as Error);
  }
}

/** SOS 不再 pending（取消/确认/已通知）→ 撤掉已投的通知、取消还没到点的刷新 */
export async function clearSosAlert(sosId: string): Promise<void> {
  if (shownForSosId !== sosId) return;
  shownForSosId = null;
  const ids = notificationIds;
  notificationIds = [];
  for (const id of ids) {
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
}
