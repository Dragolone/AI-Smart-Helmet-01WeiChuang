// 对讲房间钥匙在房续期（决策 #56 补充，10-17 负责人定「钥匙有效期跟着离开房间走」）与「重连被拒」的判断。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { ApiRequestError } from "@/api/client";
import {
  ROOM_KEY_RENEW_MS,
  ROOM_KEY_RETRY_MS,
  RoomKeyRenewer,
  isRejoinError,
  isRejoinExit,
  updatePrivateMapKeyJson,
} from "@/services/intercom-room-key";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let fetchKey: jest.Mock<(channelId: string) => Promise<string>>;
let applyKey: jest.Mock<(key: string) => Promise<unknown>>;
let onRemoved: jest.Mock<(channelId: string) => void>;
let renewer: RoomKeyRenewer;
beforeEach(() => {
  jest.useFakeTimers();
  let n = 0;
  fetchKey = jest.fn(() => Promise.resolve(`pmk-${++n}`));
  applyKey = jest.fn(() => Promise.resolve());
  onRemoved = jest.fn();
  renewer = new RoomKeyRenewer({ fetchKey, applyKey, onRemoved });
});
afterEach(() => {
  renewer.stop();
  jest.useRealTimers();
});

describe("在房续期", () => {
  it("进房后每 5 分钟换一把交给 SDK，不提前", async () => {
    renewer.start("c1");
    expect(renewer.channelId).toBe("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS - 1);
    expect(fetchKey).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchKey).toHaveBeenCalledWith("c1");
    expect(applyKey).toHaveBeenCalledWith("pmk-1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS - 1);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchKey).toHaveBeenCalledTimes(2);
    expect(applyKey).toHaveBeenLastCalledWith("pmk-2");
  });

  it("没续上（断网等）：30 秒后再试，续上了回到每 5 分钟", async () => {
    fetchKey.mockImplementationOnce(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    renewer.start("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    expect(applyKey).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RETRY_MS - 1);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchKey).toHaveBeenCalledTimes(2);
    expect(applyKey).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS - 1);
    expect(fetchKey).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchKey).toHaveBeenCalledTimes(3);
  });

  it("交给 SDK 时出错：同样 30 秒后再试", async () => {
    applyKey.mockImplementationOnce(() => Promise.reject(new Error("native")));
    renewer.start("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS);
    expect(applyKey).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RETRY_MS);
    expect(applyKey).toHaveBeenCalledTimes(2);
  });

  it("续的时候回 404（已经不是这个频道的成员）：报给页面一次、停掉，之后不再续", async () => {
    fetchKey.mockImplementationOnce(() =>
      Promise.reject(new ApiRequestError(404, { code: "NOT_FOUND" })),
    );
    renewer.start("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith("c1");
    expect(applyKey).not.toHaveBeenCalled();
    expect(renewer.channelId).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS * 3);
    expect(fetchKey).toHaveBeenCalledTimes(1);
  });

  it("别的错误码（如 503 未配置）不当成被移出，照常 30 秒后再试", async () => {
    fetchKey.mockImplementationOnce(() =>
      Promise.reject(new ApiRequestError(503, { code: "TRTC_NOT_CONFIGURED" })),
    );
    renewer.start("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS + ROOM_KEY_RETRY_MS);
    expect(onRemoved).not.toHaveBeenCalled();
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });
});

describe("停掉", () => {
  it("离开房间后不再续，也不留定时器", async () => {
    renewer.start("c1");
    expect(jest.getTimerCount()).toBe(1);
    renewer.stop();
    expect(renewer.channelId).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS * 3);
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it("续到一半离开了房间：晚到的钥匙不再交给 SDK，也不再排下一次", async () => {
    let give!: (k: string) => void;
    fetchKey.mockImplementationOnce(
      () => new Promise<string>((res) => (give = res)),
    );
    renewer.start("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    renewer.stop();
    give("late");
    await flush();
    expect(applyKey).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("续到一半 404 回来时已经离开了：不再报给页面", async () => {
    let fail!: (e: unknown) => void;
    fetchKey.mockImplementationOnce(
      () => new Promise<string>((_res, rej) => (fail = rej)),
    );
    renewer.start("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS);
    renewer.stop();
    fail(new ApiRequestError(404, { code: "NOT_FOUND" }));
    await flush();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("换到另一个房间：旧房间晚到的钥匙不交给 SDK，新房间从头计 5 分钟", async () => {
    let give!: (k: string) => void;
    fetchKey.mockImplementationOnce(
      () => new Promise<string>((res) => (give = res)),
    );
    renewer.start("c1");
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS);
    renewer.start("c2");
    give("old");
    await flush();
    expect(applyKey).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS);
    expect(fetchKey).toHaveBeenLastCalledWith("c2");
    expect(applyKey).toHaveBeenCalledTimes(1);
  });
});

describe("定时器停摆时由 TRTC 回调推着走", () => {
  it("到点前 tick 什么也不做；钟走过了 5 分钟、定时器却没响（Android 锁屏）时 tick 续上；续的途中再 tick 不重复请求", async () => {
    renewer.start("c1");
    renewer.tick();
    expect(fetchKey).not.toHaveBeenCalled();
    let give!: (k: string) => void;
    fetchKey.mockImplementationOnce(
      () => new Promise<string>((res) => (give = res)),
    );
    jest.setSystemTime(Date.now() + ROOM_KEY_RENEW_MS);
    renewer.tick();
    renewer.tick();
    expect(fetchKey).toHaveBeenCalledTimes(1);
    give("pmk-x");
    await flush();
    expect(applyKey).toHaveBeenCalledWith("pmk-x");
    // 原来那个定时器不会在这之后马上再续一次：下一次从这次续上算 5 分钟
    renewer.tick();
    await jest.advanceTimersByTimeAsync(ROOM_KEY_RENEW_MS - 1);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it("不在房间里 tick 不请求", () => {
    jest.setSystemTime(Date.now() + ROOM_KEY_RENEW_MS * 2);
    renewer.tick();
    expect(fetchKey).not.toHaveBeenCalled();
  });
});

describe("重连被拒的判断", () => {
  it("钥匙 / 签名校验没过：在不在重连都算；笼统的进房失败只在重连时算；别的错误不算", () => {
    expect(isRejoinError(-100006, false)).toBe(true);
    expect(isRejoinError(-100018, false)).toBe(true);
    expect(isRejoinError(-3301, true)).toBe(true);
    expect(isRejoinError(-3301, false)).toBe(false);
    expect(isRejoinError(-1302, true)).toBe(false);
    expect(isRejoinError(undefined, true)).toBe(false);
    expect(isRejoinError("-100006", true)).toBe(false);
  });

  it("重连途中被请出房间（不是自己退的）才算；网络好好的被请出（另一台手机进了对讲）不算", () => {
    expect(isRejoinExit(1, true)).toBe(true);
    expect(isRejoinExit(3, true)).toBe(true);
    expect(isRejoinExit(0, true)).toBe(false);
    expect(isRejoinExit(undefined, true)).toBe(false);
    expect(isRejoinExit(1, false)).toBe(false);
  });
});

it("换钥匙走 SDK 的实验接口 updatePrivateMapKey", () => {
  expect(JSON.parse(updatePrivateMapKeyJson("abc"))).toEqual({
    api: "updatePrivateMapKey",
    params: { privateMapKey: "abc" },
  });
});
