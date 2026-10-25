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
  /**
   * 账号级进行中列表（GET /users/me/sos/active，B 线第 12 项）：给了就一次拿全，不再逐台查。
   * 返回 null = 服务端还没有这个接口（旧服务端 404），退回逐台 fetchActive
   */
  fetchAccountActive?: () => Promise<{ items: Sos[]; total: number } | null>;
  openCountdown: (sosId: string, deviceId: string) => void;
  showLockScreenAlert: (
    sosId: string,
    deviceId: string,
    deadline: string,
    triggeredAt?: string,
  ) => void;
  clearLockScreenAlert: (sosId: string) => void;
  log?: (message: string) => void;
};

/**
 * 已拉起过倒计时页的 sosId（跨 WS 推送与补拉共享）。必须是集合：只记「最近一单」时，
 * 两台头盔同时有进行中的单会互相覆盖，每次 WS 重连都把两页重新弹一遍（10-03 评审疑点 1）。
 */
export type PresentedRef = { current: Set<string> };

/**
 * 进程内唯一的一份「已拉起」集合。倒计时页不止 WS / 补拉一个入口——点锁屏通知、点远程推送也会开它；
 * 那两条路径不登记的话，冷启动时「点通知进来」之后补拉又会 push 一份，叠出两页倒计时、两路警报音。
 * 登出时清空（use-realtime 的 effect 清理）。
 */
export const presentedSos: PresentedRef = { current: new Set<string>() };

export const isFinal = (qc: QueryClient, sosId: string): boolean => {
  const cached = qc.getQueryData<Sos>(["sos", sosId]);
  return cached !== undefined && cached !== null && cached.status !== "pending";
};

const present = (
  sos: Pick<Sos, "sosId" | "deviceId">,
  presented: PresentedRef,
  deps: SosSyncDeps,
): boolean => {
  if (presented.current.has(sos.sosId)) return false;
  presented.current.add(sos.sosId);
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
  // 终态不回退：WS 乱序 / 重连补发时，迟到的 pending 不能把已取消、已通知的单盖回「进行中」
  // （10-03 评审疑点 3，与 APP-03 同源——那次是 REST 迟到，这次是 WS 自己乱序）
  if (sos.status === "pending" && isFinal(qc, sos.sosId)) return;
  // 终态只清掉「进行中缓存里正是这一单」：同一台头盔旧单 s1 的 notified 晚于新单 s2 的 pending 到达时，
  // 不能把 s2 从进行中里清掉——否则离开前台也不再补弹锁屏提醒（10-16 A5）
  const active = qc.getQueryData<ActiveSosResponse>([
    "sos-active",
    sos.deviceId,
  ])?.sos;
  const staleFinal =
    sos.status !== "pending" && !!active && active.sosId !== sos.sosId;
  if (!staleFinal) {
    qc.setQueryData<ActiveSosResponse>(["sos-active", sos.deviceId], {
      sos: sos.status === "pending" ? sos : null,
    });
  }
  qc.setQueryData(["sos", sos.sosId], sos);
  if (sos.status === "pending") {
    if (present(sos, presented, deps)) {
      deps.showLockScreenAlert(
        sos.sosId,
        sos.deviceId,
        sos.deadline,
        sos.triggeredAt,
      );
    }
    return;
  }
  deps.clearLockScreenAlert(sos.sosId);
}

/**
 * 账号级列表是全的（total 不大于条数）时：缓存里还算进行中、列表里却没有的单 = 断线期间已在别处结束。
 * 补拉原来只加不减，这些单的缓存一直是 pending、锁屏提醒停在「10 秒后通知… · 我没事，取消」（10-25 审查）。
 * 写回 null、撤锁屏提醒、让倒计时页重拉这一单的权威状态；请求途中 WS 写过的以缓存为准（同 applyAccountActive）
 */
function dropEndedElsewhere(
  qc: QueryClient,
  account: { items: Sos[]; total?: number },
  startedAt: number,
  deps: SosSyncDeps,
  reason: string,
): void {
  if (typeof account.total !== "number" || account.total > account.items.length)
    return;
  const listed = new Set(
    account.items.filter((s): s is Sos => !!s).map((s) => s.sosId),
  );
  for (const q of qc.getQueryCache().findAll({ queryKey: ["sos-active"] })) {
    const held = (q.state.data as ActiveSosResponse | undefined)?.sos;
    if (!held || held.status !== "pending" || listed.has(held.sosId)) continue;
    if (q.state.dataUpdatedAt >= startedAt) continue;
    qc.setQueryData<ActiveSosResponse>(q.queryKey, { sos: null });
    deps.clearLockScreenAlert(held.sosId);
    void qc.invalidateQueries({ queryKey: ["sos", held.sosId] });
    deps.log?.(`${reason}：${held.sosId} 已不在进行中，按已结束处理`);
  }
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
  retryDelaysMs: readonly number[] = [],
): Promise<string[]> {
  const found: string[] = [];
  const take = (deviceId: string, sos: Sos | null) => {
    if (!sos || sos.status !== "pending") return;
    if (isFinal(qc, sos.sosId)) return;
    qc.setQueryData<ActiveSosResponse>(["sos-active", deviceId], { sos });
    qc.setQueryData(["sos", sos.sosId], sos);
    deps.showLockScreenAlert(
      sos.sosId,
      deviceId,
      sos.deadline,
      sos.triggeredAt,
    );
    found.push(sos.sosId);
    if (present({ sosId: sos.sosId, deviceId }, presented, deps)) {
      deps.log?.(`${reason}发现进行中 SOS ${sos.sosId}`);
    }
  };
  // 账号级接口一次拿全：绑了多少顶都只发一个请求（原来逐台查，1 万顶时冷启动 / 重连要串行一万个请求，10-16 F10）；
  // 头盔已解绑、单还是本人的也在里面。deviceIds 只在退回逐台查时用
  if (deps.fetchAccountActive) {
    let account: { items: Sos[]; total?: number } | null = null;
    const startedAt = Date.now();
    // 远程推送到达那次补拉是前台 + WS 没连上时唯一能把倒计时页拉起来的路径：弱网下这一个请求失败就再也没有下一次
    //（10-20 模拟器 30% 丢包实测：通知到了、页面整单没弹到到期）。调用方给了 retryDelaysMs 就按它有限重试几次；
    // 冷启动 / 重连等本来就有后续机会的调用不传，行为不变
    for (let attempt = 0; ; attempt += 1) {
      try {
        account = await deps.fetchAccountActive();
        break;
      } catch {
        if (attempt >= retryDelaysMs.length) {
          return found; // 网络失败不阻塞（离线时不该再退成 N 个注定失败的请求）；安全页仍会按常规查询展示
        }
        deps.log?.(
          `${reason}失败，${retryDelaysMs[attempt]} ms 后重试（第 ${attempt + 1} 次）`,
        );
        await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
      }
    }
    // items 不是数组（服务端出错；apiPage 已拦，这里是注入的取数函数也守住）：不抛，退回逐台查——
    // 冷启动补拉进行中的求救不能因为一个坏应答整个跳过
    if (account && Array.isArray(account.items)) {
      dropEndedElsewhere(qc, account, startedAt, deps, reason);
      for (const sos of account.items) if (sos) take(sos.deviceId, sos);
      return found;
    }
  }
  for (const deviceId of deviceIds) {
    let sos: Sos | null;
    try {
      ({ sos } = await deps.fetchActive(deviceId));
    } catch {
      continue; // 网络失败不阻塞；安全页仍会按常规查询展示
    }
    take(deviceId, sos);
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
  // 设备列表之外，缓存里有进行中单的头盔也算：头盔解绑后单还是本人的，账号级补拉 / 轮询照样写进缓存（B 线第 12 项）
  const cached = qc
    .getQueryCache()
    .findAll({ queryKey: ["sos-active"] })
    .map((q) => q.queryKey[1])
    .filter((id): id is string => typeof id === "string");
  for (const deviceId of new Set([...deviceIds, ...cached])) {
    const active = qc.getQueryData<ActiveSosResponse>([
      "sos-active",
      deviceId,
    ])?.sos;
    if (!active || active.status !== "pending") continue;
    if (isFinal(qc, active.sosId)) continue;
    deps.showLockScreenAlert(
      active.sosId,
      deviceId,
      active.deadline,
      active.triggeredAt,
    );
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

/**
 * 倒计时页的轮询间隔。只有「明确已结束」才停；状态未知（首次拉取失败，data 为 null）必须继续拉——
 * 原来写成 `data?.status === "pending" ? 10_000 : false`，把 null 也当成了结束：弱网下点通知进来，
 * 第一次两条 REST 都失败，页面就永远停在没有数字、没有警报音的空壳上（2026-10-05 评审）。
 */
export const COUNTDOWN_POLL_MS = 10_000;
export function countdownPollInterval(
  data: Sos | null | undefined,
): number | false {
  return data && data.status !== "pending" ? false : COUNTDOWN_POLL_MS;
}

/**
 * 倒计时页自己那次 REST 的结果落缓存前过一遍不变式 ①：请求发出后用户点了「我没事」
 * （或 WS 推来终态），迟到的 pending 应答不能把页面盖回倒计时——刚看到「已取消」又响起来。
 */
export function settleSnapshot(
  qc: QueryClient,
  sosId: string,
  fresh: Sos | null,
): Sos | null {
  if (fresh?.status === "pending" && isFinal(qc, sosId)) {
    return qc.getQueryData<Sos>(["sos", sosId]) ?? fresh;
  }
  return fresh;
}

/**
 * 安全页 30 s 轮询拿到的 `/sos/active` 结果也要过终态守卫：请求在途时用户在倒计时页取消成功，
 * 迟到的 pending 会把「求救进行中」卡片顶回来，和倒计时页（读 ["sos", id]）两处不一致（10-06 并发评审 F9）
 */
export function guardActiveResult<T extends { sos: Pick<Sos, "sosId"> | null }>(
  qc: QueryClient,
  result: T,
): T | { sos: null } {
  return result.sos && isFinal(qc, result.sos.sosId) ? { sos: null } : result;
}
