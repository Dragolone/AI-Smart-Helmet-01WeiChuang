// BLE 链路的目标设备从哪来（2026-10-05 评审后抽出）。
// 目标 = 当前账号已绑定的 deviceId。原来只认内存里的 ['devices'] 查询缓存：冷启动那一下拉列表失败
// （地下车库、电梯里开 App），链路就以空目标启动——不扫描、不连头盔；之后只有 App 在前台时才会再拉列表，
// 用户随手锁屏放口袋骑出去，整段路的摔倒都留在头盔 Flash 里。同一个空列表还让 WS 重连后的 SOS 补拉无单可查。
// 现在：每次拿到列表就按账号存一份；冷启动先用上次那份把链路拉起来，列表拉到后再同步；拉失败退避重试。
import type { QueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import type { DevicePublic } from "@helmet/shared";

import { bleTargetsKeyOf } from "@/services/secure-keys";

/** 首次解锁后即可读写：BLE 事件在锁屏下把进程拉起来时也要读得到（同 auth-store） */
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
/** 钥匙串单值有 2KB 上限；一个账号绑不了这么多台，超出的截掉 */
const MAX_CACHED = 20;
/** 注销账号、重装后清理时一并删掉（services/secure-keys 的 accountSecureKeysOf） */
const keyOf = bleTargetsKeyOf;

/**
 * 查询缓存里的已绑定设备。**没有数据（还没拉到 / 拉失败）返回 null，不是空数组**——
 * 「不知道」和「一台都没绑」必须分开，否则一次失败的拉取会把正在连着的头盔当成已解绑断开。
 */
export function liveTargets(qc: QueryClient): string[] | null {
  const devices = qc.getQueryData<DevicePublic[]>(["devices"]);
  return Array.isArray(devices) ? devices.map((d) => d.deviceId) : null;
}

/** 上次存下的目标；没有、读不出来、内容不对都返回空数组 */
export async function loadCachedTargets(
  userId: string | undefined,
): Promise<string[]> {
  if (!userId) return [];
  try {
    const raw = await SecureStore.getItemAsync(keyOf(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string" && v !== "")
      .slice(0, MAX_CACHED);
  } catch {
    return [];
  }
}

const lastSaved = new Map<string, string>();

/** 存一份（内容没变不重复写）；写失败不影响链路，下次再存 */
export async function saveCachedTargets(
  userId: string | undefined,
  ids: readonly string[],
): Promise<void> {
  if (!userId) return;
  const value = JSON.stringify(Array.from(new Set(ids)).slice(0, MAX_CACHED));
  if (lastSaved.get(userId) === value) return;
  lastSaved.set(userId, value);
  try {
    await SecureStore.setItemAsync(keyOf(userId), value, KEYCHAIN);
  } catch {
    lastSaved.delete(userId);
  }
}

/** 拉设备列表失败后的重试间隔；用完之后一直按最后一档 */
export const DEVICES_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

/**
 * 反复执行 load 直到成功一次。`firstAttempt` 在第一次尝试结束时兑现（不论成败），
 * 调用方据此做「不管有没有网都要做」的后续动作；`cancel` 停止后续重试。
 */
export function loadWithRetry(
  load: () => Promise<unknown>,
  delays: readonly number[] = DEVICES_RETRY_DELAYS_MS,
): { firstAttempt: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = (n: number): Promise<void> =>
    load().then(
      () => undefined,
      () => {
        if (cancelled) return;
        const delay = delays[Math.min(n, delays.length - 1)];
        timer = setTimeout(() => {
          timer = null;
          void attempt(n + 1); // cancel 会清掉这个定时器，走到这里就是没取消
        }, delay);
      },
    );
  return {
    firstAttempt: attempt(0),
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** 仅测试用 */
export function __resetBleTargetsForTests(): void {
  lastSaved.clear();
}
