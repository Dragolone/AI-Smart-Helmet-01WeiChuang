// 求救单应答的结构检查（纯函数，不依赖网络层；单独成文件是为了测试替身换掉 api/sos 时它照常可用）
import type { Sos } from "@helmet/shared";

/**
 * 接口应答确实是这一单的求救单（10-22 夜测）。网关回 200 + 别的东西（字符串、{}）时原样写进缓存：
 * 取消 / 立即求救之后结果页把它当成另一单（「2 条求救已处理」、一行里既「已取消」又「正在通知」）；
 * 倒计时页 10 秒一次的状态快照拿到它，倒计时直接变成结果页，滑块和「立即求救」都没了——服务端这单其实还在倒数。
 * 写缓存前过一下：不是就别写（取消 / 立即求救改为拉一次权威状态，快照按「这次没拉到」处理）
 */
export function isSosFor(v: unknown, sosId: string): v is Sos {
  const s = v as Partial<Sos> | null | undefined;
  return (
    typeof s === "object" &&
    s !== null &&
    s.sosId === sosId &&
    typeof s.status === "string" &&
    typeof s.deadline === "string"
  );
}
