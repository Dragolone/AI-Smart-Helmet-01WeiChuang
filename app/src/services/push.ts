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
import * as Notifications from "expo-notifications";
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
/** 每次别名操作一个 sequence，结果回调靠它对应是哪一次（单调递增） */
let sequence = 0;
/**
 * 别名确认（2026-10-05 iPhone 实测）：setAlias 是异步请求，极光可能拒绝（操作太频繁、超时），
 * 也可能被紧挨着发出的 deleteAlias 在服务端后发先至盖掉——原来只管发不管结果，一旦失败，
 * 这台手机就静默收不到任何推送直到下次登录。现在：等结果 → 失败按退避重发 → 成功后再查一次
 * 服务端当前别名，对不上就重设。服务端按别名找设备，别名不在 = App 被杀后 SOS 通知不到人。
 */
const ALIAS_RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000] as const;
const ALIAS_VERIFY_DELAY_MS = 2_000;
type AliasOp = { kind: "set" | "query"; userId: string };
const aliasOps = new Map<number, AliasOp>();
let aliasAttempt = 0;
let aliasTimer: ReturnType<typeof setTimeout> | null = null;

function clearAliasTimer(): void {
  if (aliasTimer) clearTimeout(aliasTimer);
  aliasTimer = null;
}

function sendSetAlias(sdk: JPushStatic, userId: string): void {
  sequence += 1;
  aliasOps.set(sequence, { kind: "set", userId });
  sdk.setAlias({ alias: userId, sequence });
  devLog("PUSH", `setAlias ${userId}`);
}

function retrySetAlias(sdk: JPushStatic, userId: string, why: string): void {
  const delay = ALIAS_RETRY_DELAYS_MS[aliasAttempt];
  if (delay === undefined) {
    devLog("PUSH", `别名设置放弃（${why}），下次启动或登录再试`);
    return;
  }
  aliasAttempt += 1;
  devLog(
    "PUSH",
    `别名未生效（${why}），${delay} ms 后重设（第 ${aliasAttempt} 次）`,
  );
  clearAliasTimer();
  aliasTimer = setTimeout(() => {
    aliasTimer = null;
    if (currentAlias === userId) sendSetAlias(sdk, userId);
  }, delay);
}

/** 极光的 tag/alias 结果回调：只处理「当前登录用户」的 set / query，其他（已登出、旧 sequence）一律忽略 */
function onAliasResult(
  sdk: JPushStatic,
  result: { code: number; sequence: number; alias?: string },
): void {
  const op = aliasOps.get(result.sequence);
  if (!op) return;
  aliasOps.delete(result.sequence);
  if (op.userId !== currentAlias) return;
  if (result.code !== 0) {
    retrySetAlias(sdk, op.userId, `${op.kind} code=${result.code}`);
    return;
  }
  if (op.kind === "set") {
    // 设成功不等于最终是它：紧挨着的 deleteAlias 可能在服务端排在后面。隔一会儿查一次
    clearAliasTimer();
    aliasTimer = setTimeout(() => {
      aliasTimer = null;
      if (currentAlias !== op.userId) return;
      sequence += 1;
      aliasOps.set(sequence, { kind: "query", userId: op.userId });
      sdk.queryAlias({ sequence });
    }, ALIAS_VERIFY_DELAY_MS);
    return;
  }
  if (result.alias === op.userId) {
    aliasAttempt = 0;
    devLog("PUSH", "别名已确认");
  } else {
    retrySetAlias(sdk, op.userId, `服务端别名是「${result.alias ?? ""}」`);
  }
}

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
  // navigate 而不是 push：后台收到 WS 时倒计时页多半已经在栈上了（12:07 华为实测），
  // 再 push 一份会叠两页倒计时；navigate 对同一路由只聚焦不新建
  router.navigate(target as never);
  return target;
}

/**
 * 冷启动时「点通知拉起 App」的那一次点击（REGRESSION 4.8，2026-10-05 iPhone 实测）：
 * 进程刚起来时极光还没初始化（要等 JS + 隐私同意），系统把点击交给了当时的 delegate——expo-notifications，
 * 极光的回放队列是空的，JS 永远收不到 notificationOpened。倒计时中的单还能靠冷启动补拉兜住，
 * 已到期的那条「已通知联系人」就只会停在首页。所以启动时从 expo 那里把这次点击取回来，按同一规则落地。
 * 远程推送的自定义字段在 trigger.payload 里（content.data 是给 Expo 推送服务用的，极光的不在那）。
 */
export function extrasFromLaunchResponse(
  response: Notifications.NotificationResponse | null | undefined,
): PushExtras | null {
  const trigger = response?.notification?.request?.trigger as
    { type?: string; payload?: Record<string, unknown> } | null | undefined;
  if (!trigger || trigger.type !== "push") return null;
  const payload = trigger.payload ?? {};
  if (typeof payload.sosId !== "string" || !payload.sosId) return null;
  return {
    sosId: payload.sosId,
    deviceId:
      typeof payload.deviceId === "string" ? payload.deviceId : undefined,
  };
}

let launchResponseHandled = false;
function landFromLaunchResponse(): void {
  if (launchResponseHandled) return;
  launchResponseHandled = true;
  try {
    const extras = extrasFromLaunchResponse(
      Notifications.getLastNotificationResponse(),
    );
    if (!extras) return;
    devLog("PUSH", "冷启动：由通知拉起", extras);
    // 用掉就清：否则下次进程内再读还是它
    Notifications.clearLastNotificationResponse();
    void landFromPush(extras);
  } catch (e) {
    devLog("PUSH", "读取启动通知失败", e as Error);
  }
}

function installListener(sdk: JPushStatic): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  // 必须先挂监听再 init：Android 被杀状态下点通知启动 App，init() 里会把缓存的那次点击立刻回放
  sdk.addNotificationListener((result) => {
    if (result.notificationEventType !== "notificationOpened") {
      // 到达只留痕不动作：真机回归 4.6 要靠这行确认远程推送在前台也送到了
      devLog("PUSH", "通知到达", result.extras);
      return;
    }
    devLog("PUSH", "通知被点开", result.extras);
    void landFromPush((result.extras ?? {}) as PushExtras);
  });
  sdk.addConnectEventListener((result) => {
    devLog("PUSH", `极光连接 ${result.connectEnable ? "上" : "断"}`);
  });
  sdk.addTagAliasListener((result) => {
    onAliasResult(
      sdk,
      result as { code: number; sequence: number; alias?: string },
    );
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
  landFromLaunchResponse();
  sdk.getRegistrationID(({ registerID }) => {
    devLog("PUSH", `registrationID ${registerID || "（尚未注册）"}`);
  });
}

function applyAlias(sdk: JPushStatic, userId: string): void {
  if (currentAlias === userId) return;
  currentAlias = userId;
  aliasAttempt = 0;
  clearAliasTimer();
  sendSetAlias(sdk, userId);
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
  // 冷启动时同意标记可能还没从 SecureStore 读出来（hydrated=false）：那不是「未同意」，别误导看日志的人
  devLog(
    "PUSH",
    useConsentStore.getState().hydrated
      ? "未同意隐私政策，推送 SDK 暂不初始化"
      : "等同意标记读取完再决定是否初始化",
  );
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
  clearAliasTimer(); // 登出后不再重设 / 校验别名
  aliasOps.clear();
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
  launchResponseHandled = false;
  clearAliasTimer();
  aliasOps.clear();
  aliasAttempt = 0;
  currentAlias = null;
  sequence = 0;
  jpush = undefined;
}
