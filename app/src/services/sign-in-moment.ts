// 这个进程里最近一次登录（登录页 / 注册页拿到 token）的时刻。冷启动时本来就登录着的不算，一直是 0。
// 刚登录的几秒里 iOS 会弹「保存密码？」卡片，系统授权框要等它弹完再来（services/sos-alert waitSignInQuiet）
let signedInAt = 0;

export function markSignedIn(now: number = Date.now()): void {
  signedInAt = now;
}

export function msSinceSignIn(now: number = Date.now()): number {
  return now - signedInAt;
}
