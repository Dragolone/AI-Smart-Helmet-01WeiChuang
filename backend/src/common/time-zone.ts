/**
 * App 每个请求都带的 X-Client-Timezone（IANA 名，如 Asia/Shanghai、Australia/Sydney；A 线 #366）。
 * 合法就返回 Intl 规范化后的名字，否则 null——不合法、没带、带了多个都不报错，也不清掉已存的值（O13，API.md §1）
 */
export const CLIENT_TIMEZONE_HEADER = 'x-client-timezone';

export function normalizeTimeZone(raw: unknown): string | null {
  // 字符范围与 App 取值时的校验一致（app/src/api/client.ts clientTimeZone）；带了两次时 Node 用逗号拼起来，也在这里挡掉
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(raw)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}
