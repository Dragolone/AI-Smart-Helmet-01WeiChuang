// 隐私政策 / 用户服务协议的唯一来源（2026-09-23）。
// 正文由后端托管（V1.0，深圳零一唯创科技有限公司），App 只负责展示——
// 曾经在 messages/legal.ts 里维护过一份 09-11 的草案，与托管版内容已不一致；
// 一个包里出现两份口径不同的隐私政策是上架审核的硬伤，故改为单一来源。
// 地址跟着 EXPO_PUBLIC_API_URL 走：dev/prod 换后端时不用改代码。
const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

/** 从 API base 取站点根：https://host/api/v1 → https://host */
export function legalOrigin(base: string = API_BASE): string {
  try {
    return new URL(base).origin;
  } catch {
    // base 配错时不让 App 崩在启动路径上：返回空串，页面会显示打不开
    return "";
  }
}

export type LegalDoc = "privacy" | "terms";

export function legalUrl(doc: LegalDoc, base?: string): string {
  const origin = legalOrigin(base);
  return origin ? `${origin}/legal/${doc}` : "";
}
