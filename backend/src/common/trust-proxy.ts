/**
 * express `trust proxy` 取值由环境变量决定（审计 AUTH-07）：
 * - 未设 / 0 / false → 不信任任何 X-Forwarded-For（直连部署、本地联调）：伪造 XFF 绕不过按 IP 的限频；
 * - 1、2… → 信任最近 N 跳（compose 里 backend 只经 Caddy 一跳，deploy 固定为 1）；
 * - true → 全信（仅内网多层代理时用）；其余字符串（如 `loopback`、`10.0.0.0/8`）原样交给 express。
 * 默认必须是"不信任"：信任默认值一旦被直连暴露就是限频失效。
 */
export function resolveTrustProxy(
  raw: string | undefined,
): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
