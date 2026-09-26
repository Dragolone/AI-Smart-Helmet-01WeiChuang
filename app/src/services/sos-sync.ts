// SOS 实时同步的判断逻辑（从 hooks/use-realtime.ts 抽出，2026-09-26）。
// 抽出来的原因：这里承载了 SOS-12 / SOS-13 / APP-03 三个真机缺陷的修复，而本仓库的 jest 渲染不了
// 带 hooks 的组件，留在 hook 里就只能靠真机回归。这里不碰 React，副作用（查接口 / 跳页 / 锁屏通知）
// 全部从参数注入，单测直接用真 QueryClient 跑（services/__tests__/sos-sync.test.ts）。
//
// 不变式：
//   ① 服务端是唯一权威，缓存里已是终态（cancelled / notified）的单，不被任何迟到的 pending 覆盖；
//   ② 同一单只拉起一次倒计时页；
//   ③ App 不在前台 && 有进行中的 SOS ⇒ 锁屏上一定有通知（sos-alert 按 sosId 去重）。
import type { QueryClient } from "@tanstack/react-query";
import type { ActiveSosResponse, Sos } from "@helmet/shared";

export type SosSyncDeps = {
  fetchActive: (deviceId: string) => Promise<ActiveSosResponse>;
  openCountdown: (sosId: string, deviceId: string) => void;
  showLockScreenAlert: (
    sosId: string,
    deviceId: string,
    deadline: string,
  ) => void;
  clearLockScreenAlert: (sosId: string) => void;
  log?: (message: string) => void;
};

/** 同一单只拉起一次倒计时页（跨 WS 推送与补拉共享） */
export type PresentedRef = { current: string | null };

const isFinal = (qc: QueryClient, sosId: string): boolean => {
  const cached = qc.getQueryData<Sos>(["sos", sosId]);
  return cached !== undefined && cached !== null && cached.status !== "pending";
};

const present = (
  sos: Pick<Sos, "sosId" | "deviceId">,
  presented: PresentedRef,
  deps: SosSyncDeps,
): boolean => {
  if (presented.current === sos.sosId) return false;
  presented.current = sos.sosId;
  deps.openCountdown(sos.sosId, sos.deviceId);
  return true;
};

/** WS `sos_update`：服务端在创建 / 取消 / 确认 / 到期通知四个时机都推 */
export function applySosUpdate(
  qc: QueryClient,
  sos: Sos,
  presented: PresentedRef,
  deps: SosSyncDeps,
): void {
  qc.setQueryData<ActiveSosResponse>(["sos-active", sos.deviceId], {
    sos: sos.status === "pending" ? sos : null,
  });
  qc.setQueryData(["sos", sos.sosId], sos);
  if (sos.status === "pending") {
    if (present(sos, presented, deps)) {
      deps.showLockScreenAlert(sos.sosId, sos.deviceId, sos.deadline);
    }
    return;
  }
  deps.clearLockScreenAlert(sos.sosId);
}

/**
 * 冷启动 / WS 重连后按 REST 补拉进行中的 SOS（SOS-12：锁屏那一刻 socket 掉线，那几秒内创建的单
 * WS 不会重推）。REST 在路上时 WS 可能已推来这单的终态，迟到的 pending 不能盖掉它（APP-03 同源）。
 * 返回找回的 sosId 列表。
 */
export async function resumePendingSos(
  qc: QueryClient,
  deviceIds: readonly string[],
  presented: PresentedRef,
  deps: SosSyncDeps,
  reason = "冷启动",
): Promise<string[]> {
  const found: string[] = [];
  for (const deviceId of deviceIds) {
    let sos: Sos | null;
    try {
      ({ sos } = await deps.fetchActive(deviceId));
    } catch {
      continue; // 网络失败不阻塞；安全页仍会按常规查询展示
    }
    if (!sos || sos.status !== "pending") continue;
    if (isFinal(qc, sos.sosId)) continue;
    qc.setQueryData<ActiveSosResponse>(["sos-active", deviceId], { sos });
    qc.setQueryData(["sos", sos.sosId], sos);
    deps.showLockScreenAlert(sos.sosId, deviceId, sos.deadline);
    found.push(sos.sosId);
    if (present({ sosId: sos.sosId, deviceId }, presented, deps)) {
      deps.log?.(`${reason}发现进行中 SOS ${sos.sosId}`);
    }
  }
  return found;
}

/**
 * App 离开前台（SOS-13）：倒计时页被压在锁屏底下时锁屏上也要有通知。
 * 只认 background——系统 Alert / 控制中心 / 来电的 inactive 时倒计时页还在屏上，再弹一条会双重报警。
 */
export function alertPendingOnBackground(
  qc: QueryClient,
  appState: string,
  deviceIds: readonly string[],
  deps: Pick<SosSyncDeps, "showLockScreenAlert">,
): number {
  if (appState !== "background") return 0;
  let n = 0;
  for (const deviceId of deviceIds) {
    const active = qc.getQueryData<ActiveSosResponse>([
      "sos-active",
      deviceId,
    ])?.sos;
    if (!active || active.status !== "pending") continue;
    if (isFinal(qc, active.sosId)) continue;
    deps.showLockScreenAlert(active.sosId, deviceId, active.deadline);
    n += 1;
  }
  return n;
}

/**
 * WS 连接状态监听：第一次 connected 是启动连接（冷启动补拉已覆盖），之后每次由断转连都触发一次。
 * 订阅时 realtimeClient 会立即回放当前值，所以「启动时已连上」也算第一次。
 */
export function onReconnect(trigger: () => void): (connected: boolean) => void {
  let everConnected = false;
  return (connected) => {
    if (!connected) return;
    if (!everConnected) {
      everConnected = true;
      return;
    }
    trigger();
  };
}
