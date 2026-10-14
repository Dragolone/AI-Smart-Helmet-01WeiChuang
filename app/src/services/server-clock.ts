// 服务端时钟（B 线 10-06 不变式评审 F-3）。
// 倒计时的 deadline 是服务端时间，而页面原来用手机时钟减它：手机快 90 秒的话倒计时页一打开就显示 0，
// 用户以为已经通知了；慢的话到期后还在倒数。头盔对时（BLE TIME SYNC）用的也是手机时钟。
// 这里从每个 HTTP 响应的 `Date` 头学一个偏移量（秒级精度，够用），需要「服务端此刻几点」的地方都用 serverNow()。
// 没学到之前就是手机时钟，不会更差。
let offsetMs = 0;
let samples = 0;

/** 收到一个响应时调用：header 是 `Date` 头原文，receivedAt 是本机收到的时刻 */
export function noteServerDate(
  header: string | null | undefined,
  receivedAt: number = Date.now(),
): void {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isNaN(serverMs)) return;
  const sample = serverMs - receivedAt;
  // 第一次直接采信；之后平滑一下，单个慢响应（Date 是发送时刻，网络慢时偏早）别把偏移带偏
  offsetMs = samples === 0 ? sample : Math.round(offsetMs * 0.7 + sample * 0.3);
  samples += 1;
}

/** 按服务端时钟估计的「此刻」（毫秒时间戳） */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** 当前学到的偏移（服务端 − 本机，毫秒）；排查用 */
export function serverClockOffsetMs(): number {
  return offsetMs;
}

/** 仅测试用 */
export function __resetServerClockForTests(): void {
  offsetMs = 0;
  samples = 0;
}
