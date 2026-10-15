// 添加紧急联系人时号码的两条检查（纯函数）。服务端只限 5 个、不查重复，也不拦本人号码。
import { normalizePhone } from "@/hooks/use-sms-code";

/**
 * duplicate = 已经是联系人了：求救时同一个号码收两条短信，还白占 5 个名额中的一个；
 * self = 本人手机号：求救短信发到摔倒的人自己手机上，等于没人收到，而安全页照样显示「已设置联系人」。
 * 号码都按 normalizePhone 规整后比（「+86 138…」和「138…」是同一个号）。
 */
export function contactPhoneProblem(
  phone: string,
  existing: readonly { phone: string }[],
  selfPhone: string | null | undefined,
): "duplicate" | "self" | null {
  const p = normalizePhone(phone);
  if (existing.some((c) => normalizePhone(c.phone) === p)) return "duplicate";
  if (selfPhone && normalizePhone(selfPhone) === p) return "self";
  return null;
}
