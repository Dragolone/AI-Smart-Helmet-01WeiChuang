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

import { accidentHref, sosActiveHref } from "@/services/sos-routes";
import { sosApi } from "@/api/sos";
import { devLog } from "@/services/dev-log";
import { presentedSos } from "@/services/sos-sync";
import {
  noteSosStartPush,
  setJPushNotificationClearer,
} from "@/services/sos-start-push";
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
type AliasOp = { kind: "set" | "query"; userId: string } | { kind: "delete" };
const aliasOps = new Map<number, AliasOp>();
let aliasAttempt = 0;
let aliasTimer: ReturnType<typeof setTimeout> | null = null;

function clearAliasTimer(): void {
  if (aliasTimer) clearTimeout(aliasTimer);
  aliasTimer = null;
}

/**
 * 登出解绑同样要等结果（2026-10-05 评审）：断网时退出登录、或刚 setAlias 就被动登出时 deleteAlias
 * 会被极光拒绝（限频 / 超时），原来发一次就不管——这台已登出的手机会继续收到原账号的 SOS 推送。
 * 失败按同一组退避重发，期间有人登录（currentAlias 不再是 null）就作罢：新账号的 setAlias 会覆盖它。
 * 成功后不再 queryAlias 确认：别名不存在时 iOS 桥接层可能拿到 nil（RCTJPushModule.m 未判空），不去碰。
 */
let deleteAttempt = 0;
function sendDeleteAlias(sdk: JPushStatic): void {
  sequence += 1;
  aliasOps.set(sequence, { kind: "delete" });
  sdk.deleteAlias({ sequence });
  devLog("PUSH", "deleteAlias");
}

function onDeleteResult(sdk: JPushStatic, code: number): void {
  if (currentAlias !== null) return; // 已有新账号登录，它的 setAlias 说了算
  if (code === 0) {
    deleteAttempt = 0;
    devLog("PUSH", "别名已解绑");
    return;
  }
  const delay = ALIAS_RETRY_DELAYS_MS[deleteAttempt];
  if (delay === undefined) {
    devLog("PUSH", `别名解绑放弃（code=${code}），下次登录会被新别名覆盖`);
    return;
  }
  deleteAttempt += 1;
  devLog(
    "PUSH",
    `别名解绑失败（code=${code}），${delay} ms 后重试（第 ${deleteAttempt} 次）`,
  );
  clearAliasTimer();
  aliasTimer = setTimeout(() => {
    aliasTimer = null;
    if (currentAlias === null) sendDeleteAlias(sdk);
  }, delay);
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

/** 极光的 tag/alias 结果回调：只处理「当前登录用户」的 set / query 与登出后的 delete，其他（旧 sequence）一律忽略 */
function onAliasResult(
  sdk: JPushStatic,
  result: { code: number; sequence: number; alias?: string },
): void {
  const op = aliasOps.get(result.sequence);
  if (!op) return;
  aliasOps.delete(result.sequence);
  if (op.kind === "delete") {
    onDeleteResult(sdk, result.code);
    return;
  }
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

/** 账号下最先到期的一单进行中求救；查不到或请求失败都当没有（只是落地页的兜底，不能因此进错页） */
async function firstActiveOnAccount(): Promise<{
  sosId: string;
  deviceId: string;
} | null> {
  try {
    const page = await sosApi.activeForAccount();
    const items = [...(page?.items ?? [])].sort((a, b) =>
      a.deadline.localeCompare(b.deadline),
    );
    return items[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 通知被点开 → 落地页。extras 只有 sosId/deviceId，进行中就回倒计时页，否则进事故详情
 * （事故记录 = SOS 单，accidentId 就是 sosId，shared AccidentListItem extends Sos）。
 */
export async function landFromPush(extras: PushExtras): Promise<string | null> {
  const { sosId, deviceId } = extras;
  if (typeof sosId !== "string" || !sosId) return null;
  // 「请求失败」≠「服务端说没有进行中的单」（2026-10-05 评审）：用户点的是「倒计时已开始」那条推送，
  // 刚唤醒的网络第一下常常不通，这时最可能的真实状态恰恰是 pending。原来两种情况都落事故详情，
  // 而详情页没有取消键。查不到就进倒计时页——它自己会拉权威状态，已结束的单会显示结束态。
  // 落到哪一单的倒计时：点的这单本身还在倒数 → 它；同一顶头盔已经有更新的一单在倒数（点的是旧单留在通知中心的
  // 推送，安卓上极光那条撤不掉）→ 直接去新的那一单。原来落旧单的记录页，压在正在响的倒计时上面，
  // 页面写「已取消」、警报照响（REGRESSION 4.27 加测，10-17 华为实测）
  let countdownId: string | null = null;
  let countdownDevice = deviceId;
  if (typeof deviceId === "string" && deviceId) {
    try {
      const active: Sos | null = (await sosApi.active(deviceId)).sos;
      if (active?.status === "pending") countdownId = active.sosId;
      else {
        // 这顶头盔没有在倒数的单，账号下别的头盔有：同样先去倒计时（那张页多半早在栈上、警报在响），
        // 不把这单的记录页压上去；几单同时倒数时页顶有胶囊可切（10-17 负责人交我定）
        const other = await firstActiveOnAccount();
        if (other) {
          countdownId = other.sosId;
          countdownDevice = other.deviceId;
        }
      }
    } catch {
      countdownId = sosId;
    }
  }
  const target = countdownId
    ? sosActiveHref(countdownId, countdownDevice)
    : accidentHref(sosId);
  // navigate 而不是 push：后台收到 WS 时倒计时页多半已经在栈上了（12:07 华为实测），
  // 再 push 一份会叠两页倒计时；navigate 对同一路由只聚焦不新建。登记后 WS / 补拉也不再重复拉起
  if (countdownId) presentedSos.current.add(countdownId);
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

/**
 * 远程 SOS 推送「到达」（不是被点开）时的回调，由 use-realtime 注册成一次补拉。
 * App 在前台时系统横幅被前台策略压掉（倒计时页该自己出现），而倒计时页只由 WS 或补拉拉起——
 * WS 正在退避重连、或半开假死时，前台用户整整 60 秒什么都看不到（2026-10-05 评审）。
 * 推送到了就说明服务端有单，以 /sos/active 为准补拉一次，不依赖 WS。
 */
let arrivalHandler: ((extras: PushExtras) => void) | null = null;
export function setPushArrivalHandler(
  handler: ((extras: PushExtras) => void) | null,
): void {
  arrivalHandler = handler;
}

const DEFAULT_ACTION =
  (Notifications as { DEFAULT_ACTION_IDENTIFIER?: string })
    .DEFAULT_ACTION_IDENTIFIER ?? "expo.modules.notifications.actions.DEFAULT";

/** 点的是横幅本身（不是某个按钮） */
export function isDefaultTap(
  response: { actionIdentifier?: string } | null | undefined,
): boolean {
  const action = response?.actionIdentifier;
  return !action || action === DEFAULT_ACTION;
}

let launchResponseHandled = false;
function landFromLaunchResponse(): void {
  if (launchResponseHandled) return;
  launchResponseHandled = true;
  try {
    const response = Notifications.getLastNotificationResponse();
    const extras = extrasFromLaunchResponse(response);
    if (!extras) return;
    devLog("PUSH", "冷启动：由通知拉起", extras);
    // 用掉就清：否则下次进程内再读还是它。但带按钮动作（「我没事，取消」）的那次点击归 sos-alert 处理，
    // 这里只负责落地，不能替它清掉——否则取消请求从未发出（10-06 并发评审 F1）
    if (isDefaultTap(response)) Notifications.clearLastNotificationResponse();
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
      // 这行日志别删：真机回归 4.6 靠它确认远程推送在前台也送到了
      devLog("PUSH", "通知到达", result.extras);
      const extras = (result.extras ?? {}) as PushExtras;
      if (
        result.notificationEventType === "notificationArrived" &&
        typeof extras.sosId === "string" &&
        extras.sosId
      ) {
        // 安卓：记下极光这条通知的编号，单子结束时精确撤掉（O12；编号靠 patches/jpush-react-native 带上来）
        noteSosStartPush(
          extras.sosId,
          result.title,
          (result as { notificationId?: unknown }).notificationId,
        );
        try {
          arrivalHandler?.(extras);
        } catch (e) {
          devLog("PUSH", "到达回调抛错", e as Error);
        }
      }
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
  // 声明里写的是字符串，原生侧按整数读（JPushModule.clearNotificationById 用 getInt）
  setJPushNotificationClearer((notificationId) =>
    sdk.clearNotificationById({
      notificationId: notificationId as unknown as string,
    }),
  );
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
  deleteAttempt = 0;
  sendDeleteAlias(sdk);
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
  deleteAttempt = 0;
  arrivalHandler = null;
  currentAlias = null;
  sequence = 0;
  jpush = undefined;
}
