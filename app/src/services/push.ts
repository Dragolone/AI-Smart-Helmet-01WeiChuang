// 远程推送（极光，决策 #10 / THIRD_PARTY §6）：App 被杀后 SOS 还能通知到本人的唯一路径。
// 服务端只认 alias = 用户 ID（backend/src/providers/jpush.provider.ts），不存 token、不建表：
// 登录后 setAlias(userId)，退出 deleteAlias；换手机、多设备由极光按 alias 分发。
//
// 合规硬约束：**用户没同意隐私政策前绝不初始化 SDK**（consent-store），登录成功也不例外。
// 老用户在新手机上直接登录 → 登录页会先要一次勾选，勾了才走到这里。
//
// 与 expo-notifications（SOS 锁屏本地通知）的关系：两者都要当 iOS 的 UNUserNotificationCenter delegate，
// 后到的极光会把 expo 的顶掉——原生侧 plugins/with-jpush.js 在 AppDelegate 里把事件转发回 expo，
// 这里 JS 侧只消费极光自己的「通知被点开」事件做落地跳转。
import { router } from "expo-router";
import type { Sos } from "@helmet/shared";

import { sosApi } from "@/api/sos";
import { devLog } from "@/services/dev-log";
import { useConsentStore } from "@/stores/consent-store";
// 直接读 app.json 而不是 expo-constants：dev-client 下 Constants.expoConfig.extra 在 iPhone 上实测为空
// （2026-09-24 00:07 真机日志「未配置 extra.jpush.appKey」），构建期常量没必要绕运行时 manifest 一圈
import appJson from "../../app.json";

// 原生模块没打进包（Expo Go / 旧 dev-client）时 require 会抛，惰性加载 + 兜底为 null，别让整个 App 起不来
type JPushStatic = typeof import("jpush-react-native").default;
let jpush: JPushStatic | null | undefined;
function loadJPush(): JPushStatic | null {
  if (jpush !== undefined) return jpush;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jpush = (require("jpush-react-native") as { default: JPushStatic }).default;
  } catch (e) {
    devLog("PUSH", "极光原生模块不可用（需要重建原生包）", e as Error);
    jpush = null;
  }
  return jpush;
}

/** 服务端推送时塞进 extras 的键（sos-trigger / sos-notifier 两处都是这两个） */
export type PushExtras = { sosId?: string; deviceId?: string };

type PushConfig = { appKey: string; channel: string };

/** AppKey 是公开值，放 app.json `extra.jpush`；原生插件（plugins/with-jpush.js）读的是同一份 */
export function readPushConfig(
  extra: { jpush?: Partial<PushConfig> } | undefined = (
    appJson.expo as { extra?: { jpush?: Partial<PushConfig> } }
  ).extra,
): PushConfig | null {
  const appKey = extra?.jpush?.appKey;
  if (!appKey) return null;
  return { appKey, channel: extra?.jpush?.channel ?? "official" };
}

let initialized = false;
let listenerInstalled = false;
let currentAlias: string | null = null;
let unsubscribeConsent: (() => void) | null = null;
/** setAlias / deleteAlias 的 sequence 只用来对应回调，单调递增即可 */
let sequence = 0;

/**
 * 通知被点开 → 落地页。extras 只有 sosId/deviceId，进行中就回倒计时页，否则进事故详情
 * （事故记录 = SOS 单，accidentId 就是 sosId，shared AccidentListItem extends Sos）。
 */
export async function landFromPush(extras: PushExtras): Promise<string | null> {
  const { sosId, deviceId } = extras;
  if (!sosId) return null;
  let active: Sos | null = null;
  if (deviceId) {
    try {
      active = (await sosApi.active(deviceId)).sos;
    } catch {
      // 查不到就按已结束处理，进详情页也能看到状态
    }
  }
  const target =
    active && active.status === "pending" && active.sosId === sosId
      ? `/sos-active?sosId=${sosId}&deviceId=${deviceId}`
      : `/accident/${sosId}`;
  router.push(target as never);
  return target;
}

function installListener(sdk: JPushStatic): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  // 必须先挂监听再 init：Android 被杀状态下点通知启动 App，init() 里会把缓存的那次点击立刻回放
  sdk.addNotificationListener((result) => {
    if (result.notificationEventType !== "notificationOpened") return;
    devLog("PUSH", "通知被点开", result.extras);
    void landFromPush((result.extras ?? {}) as PushExtras);
  });
  sdk.addConnectEventListener((result) => {
    devLog("PUSH", `极光连接 ${result.connectEnable ? "上" : "断"}`);
  });
}

function initOnce(sdk: JPushStatic, cfg: PushConfig): void {
  if (initialized) return;
  initialized = true;
  installListener(sdk);
  sdk.setLoggerEnable(__DEV__);
  // production 对应 iOS APNs 环境：Debug 包签 development、Release/TestFlight 签 production，
  // 与 __DEV__ 一致；服务端 JPUSH_APNS_PRODUCTION 要与装机包一致（THIRD_PARTY §6）
  sdk.init({ appKey: cfg.appKey, channel: cfg.channel, production: !__DEV__ });
  sdk.getRegistrationID(({ registerID }) => {
    devLog("PUSH", `registrationID ${registerID || "（尚未注册）"}`);
  });
}

function applyAlias(sdk: JPushStatic, userId: string): void {
  if (currentAlias === userId) return;
  currentAlias = userId;
  sequence += 1;
  sdk.setAlias({ alias: userId, sequence });
  devLog("PUSH", `setAlias ${userId}`);
}

/**
 * 登录后调用：同意过隐私政策 → 初始化 SDK 并把 alias 设成用户 ID；
 * 没同意 → 挂起，等 consent-store 变为已同意时再做（登录页勾选的那一刻）。
 */
export function startPush(
  userId: string,
  cfg: PushConfig | null = readPushConfig(),
): void {
  if (!cfg) {
    devLog("PUSH", "未配置 extra.jpush.appKey，跳过");
    return;
  }
  const run = () => {
    const sdk = loadJPush();
    if (!sdk) return;
    initOnce(sdk, cfg);
    applyAlias(sdk, userId);
  };
  unsubscribeConsent?.();
  unsubscribeConsent = null;
  if (useConsentStore.getState().privacyAccepted) {
    run();
    return;
  }
  devLog("PUSH", "未同意隐私政策，推送 SDK 暂不初始化");
  unsubscribeConsent = useConsentStore.subscribe((s) => {
    if (!s.privacyAccepted) return;
    unsubscribeConsent?.();
    unsubscribeConsent = null;
    run();
  });
}

/** 登出：解绑 alias，之后这台手机不再收到该用户的推送。SDK 本身不能反初始化，留着 */
export function stopPush(): void {
  unsubscribeConsent?.();
  unsubscribeConsent = null;
  if (!initialized || currentAlias === null) return;
  currentAlias = null;
  const sdk = loadJPush();
  if (!sdk) return;
  sequence += 1;
  sdk.deleteAlias({ sequence });
  devLog("PUSH", "deleteAlias");
}

/** 仅测试用：还原模块级状态 */
export function __resetPushForTests(): void {
  unsubscribeConsent?.();
  unsubscribeConsent = null;
  initialized = false;
  listenerInstalled = false;
  currentAlias = null;
  sequence = 0;
  jpush = undefined;
}
