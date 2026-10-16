// 同一账号多顶头盔同时求救（10-16 夜测 N10，负责人 10-16 定稿：一张倒计时页 + 顶部头盔胶囊点切）。
// 原来每单各叠一页倒计时：取消一单只看到「已取消」，另一单在底下继续倒数、到期照常通知，结果页也不写是哪顶。
// 现在倒计时页只开一张，这里从缓存推导「进行中的队列」：["sos-active", deviceId] 由 sos-sync 在 WS 推送 /
// 补拉时写入，本文件不发请求、不碰 React。以后 B 线给了账号级「进行中的求救」接口（上线清单 B 线第 12 项），
// 补拉把结果写进同一份缓存即可，页面不用改。
import type { QueryClient } from "@tanstack/react-query";
import type { ActiveSosResponse, Sos } from "@helmet/shared";

import { guardActiveResult, isFinal } from "./sos-sync";

/**
 * 倒计时页是否在屏上。在屏上时新到的单只进队列（页面顶部多一个胶囊、提示一句），不再叠一页；
 * use-realtime 的 openCountdown 据此决定要不要 push
 */
export const sosScreen = { mounted: false };

/** a 是不是比 b 晚建的单（同一时刻按单号定，结果稳定） */
const createdLater = (a: Sos, b: Sos) =>
  (Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    a.sosId.localeCompare(b.sosId)) > 0;

/**
 * 进行中的求救，按到期先后排（同时到期按单号稳定排）。
 * 遍历的是缓存里所有 ["sos-active", *] 条目而不是设备列表：设备列表还没拉到 / 刚绑的头盔不在列表里时，
 * WS 推来的单照样在队列里。`extra` 是页面从路由拿到的那一单（它的设备不一定在缓存里）。
 * **每顶头盔只留一单（晚建的那单）**：服务端同一账号每顶头盔至多一单在倒计时（partial unique index），
 * 同一顶出现两单说明旧的那单已结束、只是本机还没收到终态（WS 断着、10 秒轮询还没跑）。两单都留的话倒计时页的
 * 「处理过的单」按头盔号登记会在两单间来回改，整页「Too many re-renders」崩掉（10-16 评审）。
 */
export function activeSosQueue(qc: QueryClient, extra?: Sos | null): Sos[] {
  const byDevice = new Map<string, Sos>();
  const take = (s: Sos | null | undefined) => {
    if (!s || s.status !== "pending" || isFinal(qc, s.sosId)) return;
    const held = byDevice.get(s.deviceId);
    // 同一单后来的那份留下（页面手上的是详情缓存里的对象，比进行中缓存新）
    if (held && held.sosId !== s.sosId && !createdLater(s, held)) return;
    byDevice.set(s.deviceId, s);
  };
  for (const q of qc.getQueryCache().findAll({ queryKey: ["sos-active"] })) {
    take((q.state.data as ActiveSosResponse | undefined)?.sos);
  }
  take(extra);
  return [...byDevice.values()].sort(
    (a, b) =>
      Date.parse(a.deadline) - Date.parse(b.deadline) ||
      a.sosId.localeCompare(b.sosId),
  );
}

/** 当前这单之后该看哪一单：队列里（按到期先后）第一个不是它的 */
export function nextSos(queue: readonly Sos[], currentId: string): Sos | null {
  return queue.find((s) => s.sosId !== currentId) ?? null;
}

/** 顶部胶囊最多画这么多个（一万顶同时报警也只画最前面的，其余写「还有 N 顶」） */
export const MAX_CHIPS = 20;

/** 安全页 / 安全记录页 30 秒一轮的账号级轮询（GET /users/me/sos/active）的查询键 */
export const SOS_ACTIVE_ACCOUNT_KEY = ["sos-active-account"] as const;

/** 「进行中」要立刻重新核对时（全部取消 / 锁屏通知取消成功后）：按头盔的缓存和账号级轮询一起刷新 */
export const refreshActiveSos = (qc: QueryClient): Promise<unknown> =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ["sos-active"] }),
    qc.invalidateQueries({ queryKey: SOS_ACTIVE_ACCOUNT_KEY }),
  ]);

/**
 * 账号级进行中列表写回按头盔的进行中缓存 ["sos-active", deviceId]（倒计时页队列、离开前台补弹锁屏、安全页都读它）：
 * - 列表里的单：写成那顶头盔的进行中单；本机已知结束的不回潮（终态守卫，同逐台轮询）。
 * - 列表里没有的头盔（设备列表里的 + 缓存里有过的）：服务端说它没有进行中的单 → 写 null。
 *   列表不全（total 多于这一页）时不清——它们可能在下一页。
 * - 在途守卫：请求发出后 WS / 补拉写过的头盔以缓存为准——那次写入比这次应答新。原来逐台轮询迟到的 { sos: null }
 *   会把刚推来的进行中单冲掉，倒计时页的胶囊没了、结果页把还在倒数的单写成「正在通知」（10-16 评审，#213）。
 */
export function applyAccountActive(
  qc: QueryClient,
  result: { items: Sos[]; total: number },
  knownDeviceIds: readonly string[],
  startedAt: number,
): void {
  const complete = result.total <= result.items.length;
  const byDevice = new Map<string, Sos>();
  for (const s of result.items) {
    const kept = guardActiveResult(qc, { sos: s }).sos;
    if (!kept || kept.status !== "pending") continue;
    const held = byDevice.get(kept.deviceId);
    if (!held || createdLater(kept, held)) byDevice.set(kept.deviceId, kept);
  }
  const cached = qc
    .getQueryCache()
    .findAll({ queryKey: ["sos-active"] })
    .map((q) => q.queryKey[1])
    .filter((id): id is string => typeof id === "string");
  for (const deviceId of new Set([
    ...knownDeviceIds,
    ...cached,
    ...byDevice.keys(),
  ])) {
    const key = ["sos-active", deviceId];
    const state = qc.getQueryState<ActiveSosResponse>(key);
    // 同一毫秒算「在途期间」：宁可多信一次 WS 写入（30 秒后下一轮就纠正），不能让旧应答盖掉推送
    if (state?.data !== undefined && state.dataUpdatedAt >= startedAt) continue;
    const sos = byDevice.get(deviceId) ?? null;
    if (!sos && !complete) continue;
    const now = state?.data?.sos ?? null;
    // 没变就不写：写一次就是一轮缓存更新事件，倒计时页会跟着重算
    if (
      state?.data !== undefined &&
      now?.sosId === sos?.sosId &&
      now?.status === sos?.status &&
      now?.updatedAt === sos?.updatedAt
    )
      continue;
    qc.setQueryData<ActiveSosResponse>(key, { sos });
  }
}

/** 安全页的账号级轮询：拉一次、写回按头盔的缓存；返回这一轮拿到的单数（只给调试看） */
export async function pollAccountActive(
  qc: QueryClient,
  knownDeviceIds: readonly string[],
  fetchAccount: () => Promise<{ items: Sos[]; total: number }>,
): Promise<number> {
  const startedAt = Date.now();
  const result = await fetchAccount();
  applyAccountActive(qc, result, knownDeviceIds, startedAt);
  return result.total;
}

/**
 * 进行中队列做成外部 store（给 useSyncExternalStore）：缓存里 sos-active / sos 有更新就通知重读；
 * 每次读都按缓存现算，内容没变时沿用旧数组（useSyncExternalStore 要求没变时返回同一个值）。
 * 不用「空转 tick 强制重渲染」——React Compiler 判定输入没变会把 activeSosQueue(qc) 的结果 memo 住（见倒计时页 now 的注释）
 */
export function activeSosStore(qc: QueryClient): {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => Sos[];
} {
  let snapshot: Sos[] = [];
  return {
    subscribe: (onChange) =>
      qc.getQueryCache().subscribe((e) => {
        const k = e.query.queryKey[0];
        if ((k === "sos-active" || k === "sos") && e.type === "updated")
          onChange();
      }),
    getSnapshot: () => {
      const next = activeSosQueue(qc);
      const same =
        next.length === snapshot.length &&
        next.every((s, i) => s === snapshot[i]);
      if (!same) snapshot = next;
      return snapshot;
    },
  };
}
