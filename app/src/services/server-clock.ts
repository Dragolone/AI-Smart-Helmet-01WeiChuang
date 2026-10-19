// 服务端时钟（B 线 10-06 不变式评审 F-3）。
// 倒计时的 deadline 是服务端时间，而页面原来用手机时钟减它：手机快 90 秒的话倒计时页一打开就显示 0，
// 用户以为已经通知了；慢的话到期后还在倒数。头盔对时（BLE TIME SYNC）用的也是手机时钟。
// 这里从每个 HTTP 响应的 `Date` 头学一个偏移量（秒级精度，够用），需要「服务端此刻几点」的地方都用 serverNow()。
// 没学到之前就是手机时钟，不会更差。
let offsetMs = 0;
let samples = 0;
/** 最近几个样本：Date 头是服务端发出时刻，网络越慢样本越小，所以取最近几个里最大的那个最接近真值 */
let recent: number[] = [];
const WINDOW = 5;
/**
 * 样本和当前偏移差得超过它就当手机时钟跳变（手动改时间、长时间离线后系统校时）——直接采信新样本。
 * 网络再慢也慢不过请求超时（15 s），所以 30 s 以上不可能是网络造成的（10-16 A1）
 */
const JUMP_MS = 30_000;
/** 比这早的 Date 头不是真实时间（V8 把「0」解析成 2000 年；服务器时钟没对上） */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2024, 0, 1);

/**
 * 上次学到偏移时「墙钟（Date.now）− 单调钟（performance.now）」的值。墙钟被改（手动改时间、飞行模式后系统校时）
 * 这个差会跳，单调钟不会——于是不用等下一个响应的 Date 头、没网也能立刻把偏移反向补上。
 * 只靠响应学的话，跳变后倒计时页要错画 3–10 秒：快 90 秒整屏红「0 秒」、慢 120 秒顶格「60」（10-20 模拟器实测）
 */
let anchorMs: number | null = null;
const monotonicNow = (): number | null =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : null;
/** 墙钟自上次锚定以来跳了 30 s 以上：偏移反向补上（服务端时钟没动），窗口里的样本同样平移，下一个真样本不会再被当成跳变 */
function absorbWallClockJump(): void {
  const mono = monotonicNow();
  if (mono === null || anchorMs === null) return;
  const jump = Date.now() - mono - anchorMs;
  if (Math.abs(jump) < JUMP_MS) return;
  offsetMs -= jump;
  recent = recent.map((s) => s - jump);
  anchorMs += jump;
}

/** 收到一个响应时调用：header 是 `Date` 头原文，receivedAt 是本机收到的时刻 */
export function noteServerDate(
  header: string | null | undefined,
  receivedAt: number = Date.now(),
): void {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isNaN(serverMs) || serverMs < EARLIEST_PLAUSIBLE_MS) return;
  absorbWallClockJump();
  const sample = serverMs - receivedAt;
  if (samples === 0 || Math.abs(sample - offsetMs) > JUMP_MS) {
    // 第一次直接采信；时钟跳变也直接采信，不然要二十多个响应才追得上（10-16 A1）
    recent = [sample];
  } else {
    recent = [...recent.slice(-(WINDOW - 1)), sample];
  }
  // 慢响应只会让样本偏小，取窗口里最大的：冷启动第一个慢响应不再把偏移压低几秒（10-16 8.10 实测 52→55 跳）
  offsetMs = Math.max(...recent);
  samples += 1;
  const mono = monotonicNow();
  anchorMs = mono === null ? null : Date.now() - mono;
}

/** 按服务端时钟估计的「此刻」（毫秒时间戳） */
export function serverNow(): number {
  absorbWallClockJump();
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
  recent = [];
  anchorMs = null;
}
