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

/** 后端托管的四份文档（/legal/<doc>）。后两份是 2026-10 备案 / 厂商隐私检测要求的清单（LAUNCH_CHECKLIST A-6） */
export const LEGAL_DOCS = [
  "privacy",
  "terms",
  "collection",
  "sharing",
] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** 路由参数 → 文档；认不出的一律回隐私政策，不让页面打开一个不存在的地址 */
export function parseLegalDoc(param: unknown): LegalDoc {
  return (LEGAL_DOCS as readonly unknown[]).includes(param)
    ? (param as LegalDoc)
    : "privacy";
}

export function legalUrl(doc: LegalDoc, base?: string): string {
  const origin = legalOrigin(base);
  return origin ? `${origin}/legal/${doc}` : "";
}
