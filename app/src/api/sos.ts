// SOS / 事故记录接口（docs/API.md §7；backend/src/sos 已实现并核对）
// 状态机服务端权威（决策 #8）：App 只按 deadline 渲染倒计时，绝不自行判断超时
import type {
  AccidentDetail,
  AccidentListItem,
  ActiveSosItem,
  ActiveSosResponse,
  Paginated,
  Sos,
} from "@helmet/shared";
import { api, ApiRequestError } from "./client";
import { isSosFor } from "./sos-shape";

/**
 * 倒计时页「取消 / 立即求救」的单次超时，比全局的 15 s 短（O7，10-20 模拟器实测）：
 * 单向 20 s 延迟下滑动取消，「取消中…」转了约 25 s 才报错，而整个倒计时只有 60 s——
 * 用户等一次失败就去掉了小半个窗口。8 s 报错后页面会提示倒计时仍在继续并给「重试」，
 * 再来一次比干等更有用。请求只是在本机放弃等结果：服务端若已收到并处理了，
 * WS 推送 / 轮询会把页面切到终态，再点重试拿到 SOS_ALREADY_FINALIZED 也按已结束处理
 */
export const SOS_ACTION_TIMEOUT_MS = 8_000;

/** 应答不像预期的结构：按服务端出错处理（INTERNAL_ERROR →「服务暂时不可用」），调用方当这次没拉到 */
const badShape = (path: string) =>
  new ApiRequestError(
    200,
    { code: "INTERNAL_ERROR", message: `${path}: unexpected shape` },
    undefined,
    true,
  );

export const sosApi = {
  /** 无进行中 SOS 时返回 { sos: null } */
  active: (deviceId: string) =>
    api<ActiveSosResponse>(
      `/devices/${encodeURIComponent(deviceId)}/sos/active`,
    ),

  /**
   * 本账号所有进行中的 SOS（API.md §7，上线清单 B 线第 12 项）：按到期先后，统一分页；头盔已解绑、单还是本人的也在。
   * 默认取最早到期的 100 单——多于 100 单时 total 会大于 items.length，调用方据此知道列表不全
   */
  activeForAccount: (page = 1, pageSize = 100) =>
    api<Paginated<ActiveSosItem>>(
      `/users/me/sos/active?page=${page}&pageSize=${pageSize}`,
    ),

  /** 默认按 SOS_ACTION_TIMEOUT_MS；锁屏通知按钮那条后台重试链路显式传回全局超时（见 services/sos-alert） */
  cancel: (sosId: string, opts: { timeoutMs?: number } = {}) =>
    api<Sos>(`/sos/${encodeURIComponent(sosId)}/cancel`, {
      method: "POST",
      timeoutMs: opts.timeoutMs ?? SOS_ACTION_TIMEOUT_MS,
    }),

  /** "立即求救"：跳过剩余倒计时立即通知 */
  confirm: (sosId: string) =>
    api<Sos>(`/sos/${encodeURIComponent(sosId)}/confirm`, {
      method: "POST",
      timeoutMs: SOS_ACTION_TIMEOUT_MS,
    }),

  accidents: (deviceId: string, page = 1, pageSize = 20) =>
    api<Paginated<AccidentListItem>>(
      `/devices/${encodeURIComponent(deviceId)}/accidents?page=${page}&pageSize=${pageSize}`,
    ),

  accidentDetail: (accidentId: string) =>
    api<AccidentDetail>(`/accidents/${encodeURIComponent(accidentId)}`),

  /**
   * 某一单 SOS 此刻的权威状态：进行中 → /sos/active；不在进行中 → 事故记录（= 同一条 SOS 单，
   * accidentId 就是 sosId）。**不回退到本地缓存**——2026-09-24 iPhone 实测：慢网下迟到的 pending
   * 覆盖了 WS 推的 cancelled，之后 active 查不到这单、旧代码却信缓存，倒计时页永远停在 pending，
   * 点取消一直报 SOS_ALREADY_FINALIZED。事故记录也拿不到（网络失败）才返回 null，由调用方决定兜底。
   */
  snapshot: async (
    sosId: string,
    deviceId?: string | null,
  ): Promise<Sos | null> => {
    // 只带 sosId 的外部深链没有 deviceId：直接按单号查，别去请求 /devices/undefined/sos/active 然后把一单
    // 还在倒数的求救当成「不存在」收掉（10-16 C1）
    if (deviceId) {
      try {
        const path = `/devices/${encodeURIComponent(deviceId)}/sos/active`;
        const res = await api<ActiveSosResponse | null>(path);
        if (typeof res !== "object" || res === null) throw badShape(path);
        const { sos } = res;
        if (sos && sos.sosId === sosId) {
          if (!isSosFor(sos, sosId)) throw badShape(path);
          return sos;
        }
      } catch (e) {
        // 倒计时中头盔被解绑：设备接口 404，但这单的处置权还在本人（解绑不影响进行中的求救，事故记录按本人查）。
        // 原来 404 直接抛给页面：轮询停掉，数字停在 0、警报一直响、点取消 409 再拉还是 404（10-16 评审）
        if (!(e instanceof ApiRequestError && e.status === 404)) throw e;
      }
    }
    const path = `/accidents/${encodeURIComponent(sosId)}`;
    const detail = await api<AccidentDetail>(path);
    if (!isSosFor(detail, sosId)) throw badShape(path);
    return detail;
  },
};
