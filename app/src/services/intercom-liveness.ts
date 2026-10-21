// 对讲里谁「可能已掉线」（O14，负责人 10-21 定）。对方被杀 / 断网时 TRTC 要等约 92 秒的异常退房超时才报他离开，
// 这期间对端一直显示他在线，骑行中以为还连着。办法：房里每台手机每 5 秒经 TRTC 房间自定义消息发一下心跳，
// 15 秒没收到某人的心跳（也没听到他说话）就标「可能已掉线」，等 TRTC 真报离开再移出。
// 心跳挂在 SDK 回调上发和查（音量回调每 300 ms 一次、锁屏照来），不用 JS 定时器：Android 锁屏后定时器停摆，
// 用定时器发的话，揣在兜里锁着屏骑车的人会被对方当成掉线。
// 只看发过心跳的人：没升级的旧版本 App 不发心跳，不能把它们一律标成掉线。

/** 自定义消息的命令号（TRTC 允许 1–10），对讲只用这一个 */
export const HEARTBEAT_CMD_ID = 1;
export const HEARTBEAT_EVERY_MS = 5_000;
/** 三次心跳都没到才算：自定义消息走 UDP、不保证送达，丢一两个不该报 */
export const HEARTBEAT_STALE_MS = 15_000;

export class PeerLiveness {
  private lastSeen = new Map<string, number>();
  private lastSent = Number.NEGATIVE_INFINITY;

  /** 距上次发心跳满 5 秒：该发了（顺带记下这次发的时刻） */
  takeSendTurn(now: number): boolean {
    if (now - this.lastSent < HEARTBEAT_EVERY_MS) return false;
    this.lastSent = now;
    return true;
  }

  /** 收到他的心跳：从此按心跳判断他在不在 */
  heartbeat(userId: string, now: number): void {
    this.lastSeen.set(userId, now);
  }

  /** 听到他在说话：也算活着。只刷新发过心跳的人——旧版本不发心跳，说完话不能被当成掉线 */
  heard(userId: string, now: number): void {
    if (this.lastSeen.has(userId)) this.lastSeen.set(userId, now);
  }

  /** 他真的离开了（TRTC 报了退房） */
  forget(userId: string): void {
    this.lastSeen.delete(userId);
  }

  /** 自己断线重连回来：这段时间收不到是自己的问题，所有人从现在重新计时 */
  graceAll(now: number): void {
    for (const id of this.lastSeen.keys()) this.lastSeen.set(id, now);
  }

  /** 进房 / 退房：从头来；下一次回调立刻发一次心跳 */
  reset(): void {
    this.lastSeen.clear();
    this.lastSent = Number.NEGATIVE_INFINITY;
  }

  /** 在线名单里发过心跳、却 15 秒没动静的人（顺序同 online） */
  stale(online: readonly string[], now: number): string[] {
    return online.filter((id) => {
      const seen = this.lastSeen.get(id);
      return seen !== undefined && now - seen >= HEARTBEAT_STALE_MS;
    });
  }
}
