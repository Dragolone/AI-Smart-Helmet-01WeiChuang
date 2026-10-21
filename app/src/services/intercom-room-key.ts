// 对讲房间钥匙（TRTC PrivateMapKey，决策 #56）的在房续期，以及「断线重连被拒」的判断。
// 钥匙的到期时间签在钥匙里，签出去就改不了（服务端默认 10 分钟）；TRTC 断网重连时拿手里那把重新进房，
// 控制台开了「高级权限控制」后过期的会被拒。负责人 10-17 定的口径：钥匙有效期跟着「什么时候离开房间」走——
// 在房期间每 5 分钟换一把交给 SDK，离开房间后最多 10 分钟手里那把就作废。
import { ApiRequestError } from "@/api/client";

/**
 * 本机这一次运行的标识（决策 #62）：进房 / 续钥匙时带给服务端，区分同一账号的几台手机——收到 voice_taken_over
 * 时认出是不是自己发起的。每次启动随机生成、不落盘：只要同一账号同时在线的几台不撞就行
 */
export const INTERCOM_CLIENT_ID = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 12)}`;

/** 续钥匙 / 自动重进时服务端说：这个账号已在另一台手机上进了对讲（决策 #62） */
export const isTakenOver = (err: unknown): boolean =>
  err instanceof ApiRequestError &&
  err.status === 409 &&
  err.code === "VOICE_TAKEN_OVER";

/** 换钥匙的间隔：服务端有效期的一半，续失败一次还有余量 */
export const ROOM_KEY_RENEW_MS = 5 * 60_000;
/** 没续上（断网 / 服务端出错）多久再试 */
export const ROOM_KEY_RETRY_MS = 30_000;
/** 自动重进之后这么久内又被拒就不再自动重进：新钥匙也进不去时不能一直进进出出 */
export const AUTO_REJOIN_GAP_MS = 60_000;

/**
 * trtc-react-native 3.3.0 没有桥接 updatePrivateMapKey，两端原生 SDK（13.4）也没有这个公开方法：
 * 官方「高级权限控制」文档的写法是走实验接口，两端原生库里都带着它；桥接的 callExperimentalAPI 调的就是同一个单例
 */
export const updatePrivateMapKeyJson = (privateMapKey: string): string =>
  JSON.stringify({ api: "updatePrivateMapKey", params: { privateMapKey } });

/** TXLiteAVCode：开了高级权限控制后 privateMapKey 校验没过 */
const ERR_TRTC_INVALID_PRIVATE_MAPKEY = -100006;
/** TXLiteAVCode：UserSig 校验没过（过期等） */
const ERR_TRTC_USER_SIG_CHECK_FAILED = -100018;
/** TXLiteAVCode：进房失败，具体原因只在 errMsg 里 */
const ERR_TRTC_ENTER_ROOM_FAILED = -3301;

/**
 * 在房间里收到的 onError 是不是「重连时重新进房被拒」。TRTC 文档没写重连被拒走哪个回调、报哪个码，
 * 两种都接：钥匙 / 签名校验没过的一定是（进房之后只有重新进房才会再校验）；笼统的进房失败只在正在重连时算
 */
export function isRejoinError(
  errCode: unknown,
  reconnecting: boolean,
): boolean {
  if (
    errCode === ERR_TRTC_INVALID_PRIVATE_MAPKEY ||
    errCode === ERR_TRTC_USER_SIG_CHECK_FAILED
  )
    return true;
  return reconnecting && errCode === ERR_TRTC_ENTER_ROOM_FAILED;
}

/**
 * 重连途中被请出房间（onExitRoom 的 reason：1 被服务器移出、3 服务端状态异常；0 是自己退的）。
 * 网络好好的时候被移出，常见是同一账号在另一台手机进了对讲，那不能自动抢回来
 */
export function isRejoinExit(reason: unknown, reconnecting: boolean): boolean {
  return reconnecting && typeof reason === "number" && reason !== 0;
}

interface RenewerIO {
  /** 向服务端换一把（POST /voice/channels/{id}/token），返回 privateMapKey */
  fetchKey(channelId: string): Promise<string>;
  /** 交给 SDK */
  applyKey(privateMapKey: string): Promise<unknown>;
  /** 换钥匙时服务端说已经不是这个频道的成员（404）：页面结束这次通话 */
  onRemoved(channelId: string): void;
  /** 换钥匙时服务端说这个账号已在另一台手机上进了对讲（409，WS 通知漏收时的兜底）：页面结束这次通话 */
  onTakenOver(channelId: string): void;
}

/**
 * 在房续钥匙。定时器只管前台：Android 退到后台 / 锁屏后 RN 的 JS 定时器整个停摆（JavaTimerManager 在
 * onHostPause 后不再派发），所以页面在 TRTC 的每个回调里也调一次 tick——SDK 的回调（音量每 300 ms、统计每 2 s）
 * 锁着屏照样来，到点了就顺带续上（平台限制清单 2026-10-17）
 */
export class RoomKeyRenewer {
  private room: { channelId: string; dueAt: number; busy: boolean } | null =
    null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly io: RenewerIO) {}

  /** 当前在续哪个频道的（没在房间里为 null） */
  get channelId(): string | null {
    return this.room?.channelId ?? null;
  }

  /** 进房成功：从这一刻起每 5 分钟换一把 */
  start(channelId: string): void {
    this.stop();
    this.room = { channelId, dueAt: 0, busy: false };
    this.schedule(ROOM_KEY_RENEW_MS);
  }

  /** 离开房间 / 离开页面：不再续，晚到的钥匙也不再交给 SDK */
  stop(): void {
    this.clearTimer();
    this.room = null;
  }

  /** 到点了就续一把；没到点、正在续、不在房间里都什么也不做 */
  tick(): void {
    const room = this.room;
    if (!room || room.busy || Date.now() < room.dueAt) return;
    room.busy = true;
    this.clearTimer();
    this.io
      .fetchKey(room.channelId)
      .then(
        async (key) => {
          if (this.room !== room) return;
          await this.io.applyKey(key);
          if (this.room === room) this.schedule(ROOM_KEY_RENEW_MS);
        },
        (err: unknown) => {
          if (this.room !== room) return;
          if (err instanceof ApiRequestError && err.status === 404) {
            this.stop();
            this.io.onRemoved(room.channelId);
            return;
          }
          if (isTakenOver(err)) {
            this.stop();
            this.io.onTakenOver(room.channelId);
            return;
          }
          this.schedule(ROOM_KEY_RETRY_MS);
        },
      )
      // 交给 SDK 时原生抛错：和没续上一样过一会儿再试
      .catch(() => {
        if (this.room === room) this.schedule(ROOM_KEY_RETRY_MS);
      })
      .finally(() => {
        room.busy = false;
      });
  }

  private schedule(ms: number): void {
    const room = this.room;
    if (!room) return;
    this.clearTimer();
    room.dueAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
