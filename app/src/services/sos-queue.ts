// 同一账号多顶头盔同时求救（10-16 夜测 N10，负责人 10-16 定稿：一张倒计时页 + 顶部头盔胶囊点切）。
// 原来每单各叠一页倒计时：取消一单只看到「已取消」，另一单在底下继续倒数、到期照常通知，结果页也不写是哪顶。
// 现在倒计时页只开一张，这里从缓存推导「进行中的队列」：["sos-active", deviceId] 由 sos-sync 在 WS 推送 /
// 补拉时写入，本文件不发请求、不碰 React。以后 B 线给了账号级「进行中的求救」接口（上线清单 B 线第 12 项），
// 补拉把结果写进同一份缓存即可，页面不用改。
import type { QueryClient } from "@tanstack/react-query";
import type { ActiveSosResponse, Sos } from "@helmet/shared";

import { isFinal } from "./sos-sync";

/**
 * 倒计时页是否在屏上。在屏上时新到的单只进队列（页面顶部多一个胶囊、提示一句），不再叠一页；
 * use-realtime 的 openCountdown 据此决定要不要 push
 */
export const sosScreen = { mounted: false };

/**
 * 进行中的求救，按到期先后排（同时到期按单号稳定排）。
 * 遍历的是缓存里所有 ["sos-active", *] 条目而不是设备列表：设备列表还没拉到 / 刚绑的头盔不在列表里时，
 * WS 推来的单照样在队列里。`extra` 是页面从路由拿到的那一单（它的设备不一定在缓存里）。
 */
export function activeSosQueue(qc: QueryClient, extra?: Sos | null): Sos[] {
  const byId = new Map<string, Sos>();
  const take = (s: Sos | null | undefined) => {
    if (!s || s.status !== "pending" || isFinal(qc, s.sosId)) return;
    byId.set(s.sosId, s);
  };
  for (const q of qc.getQueryCache().findAll({ queryKey: ["sos-active"] })) {
    take((q.state.data as ActiveSosResponse | undefined)?.sos);
  }
  take(extra);
  return [...byId.values()].sort(
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
