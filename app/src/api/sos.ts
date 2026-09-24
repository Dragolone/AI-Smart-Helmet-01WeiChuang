// SOS / 事故记录接口（docs/API.md §7；backend/src/sos 已实现并核对）
// 状态机服务端权威（决策 #8）：App 只按 deadline 渲染倒计时，绝不自行判断超时
import type {
  AccidentDetail,
  AccidentListItem,
  ActiveSosResponse,
  Paginated,
  Sos,
} from '@helmet/shared';
import { api } from './client';

export const sosApi = {
  /** 无进行中 SOS 时返回 { sos: null } */
  active: (deviceId: string) =>
    api<ActiveSosResponse>(
      `/devices/${encodeURIComponent(deviceId)}/sos/active`,
    ),

  cancel: (sosId: string) =>
    api<Sos>(`/sos/${encodeURIComponent(sosId)}/cancel`, { method: 'POST' }),

  /** "立即求救"：跳过剩余倒计时立即通知 */
  confirm: (sosId: string) =>
    api<Sos>(`/sos/${encodeURIComponent(sosId)}/confirm`, { method: 'POST' }),

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
  snapshot: async (sosId: string, deviceId: string): Promise<Sos | null> => {
    const { sos } = await api<ActiveSosResponse>(
      `/devices/${encodeURIComponent(deviceId)}/sos/active`,
    );
    if (sos && sos.sosId === sosId) return sos;
    return api<AccidentDetail>(`/accidents/${encodeURIComponent(sosId)}`);
  },
};
