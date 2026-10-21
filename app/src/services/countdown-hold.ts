// 倒计时页在屏、这单还在倒数时，会话被服务端否定（别处改了密码 / 弱网刷新被判复用……）也先不登出
//（负责人 10-21 定，O19-A）：原来直接回登录页，倒计时页和警报一起消失，服务端却照常到点通知联系人，误报也取消不了。
// 倒计时页把「最晚那单倒数到哪一刻」（本机时钟）登记在这里，auth-store 清会话前来问；页面卸载时清掉。
let holdUntil: number | null = null;

export function setCountdownHold(until: number | null): void {
  holdUntil = until;
}

/** 还在倒数就返回倒数结束的那一刻（本机时钟），否则 null */
export function countdownHoldUntil(now: number = Date.now()): number | null {
  return holdUntil !== null && holdUntil > now ? holdUntil : null;
}
