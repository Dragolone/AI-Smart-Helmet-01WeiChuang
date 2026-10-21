// 对讲心跳（O14）：15 秒没心跳 / 没说话才标「可能已掉线」；旧版本不发心跳的不标；自己断线回来重新计时。
import { describe, expect, it } from "@jest/globals";

import {
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_STALE_MS,
  PeerLiveness,
} from "../intercom-liveness";

describe("PeerLiveness", () => {
  it("发心跳：第一次立刻发，之后每满 5 秒一次", () => {
    const p = new PeerLiveness();
    expect(p.takeSendTurn(1_000)).toBe(true);
    expect(p.takeSendTurn(1_000 + HEARTBEAT_EVERY_MS - 1)).toBe(false);
    expect(p.takeSendTurn(1_000 + HEARTBEAT_EVERY_MS)).toBe(true);
    p.reset();
    expect(p.takeSendTurn(1_000 + HEARTBEAT_EVERY_MS + 1)).toBe(true);
  });

  it("15 秒没收到心跳才算可能掉线；中间来一次就重新计时", () => {
    const p = new PeerLiveness();
    p.heartbeat("a", 0);
    p.heartbeat("b", 0);
    expect(p.stale(["a", "b"], HEARTBEAT_STALE_MS - 1)).toEqual([]);
    p.heartbeat("b", 10_000);
    expect(p.stale(["a", "b"], HEARTBEAT_STALE_MS)).toEqual(["a"]);
    expect(p.stale(["a", "b"], 10_000 + HEARTBEAT_STALE_MS)).toEqual([
      "a",
      "b",
    ]);
  });

  it("从没发过心跳的人（没升级的旧版本）不标；说话也不会把他拉进来", () => {
    const p = new PeerLiveness();
    p.heard("old", 0);
    expect(p.stale(["old"], 60_000)).toEqual([]);
  });

  it("发过心跳的人在说话：算活着", () => {
    const p = new PeerLiveness();
    p.heartbeat("a", 0);
    p.heard("a", 12_000);
    expect(p.stale(["a"], 20_000)).toEqual([]);
    expect(p.stale(["a"], 12_000 + HEARTBEAT_STALE_MS)).toEqual(["a"]);
  });

  it("不在在线名单里的不报（TRTC 已报离开）；forget 之后再回来要重新发心跳才算", () => {
    const p = new PeerLiveness();
    p.heartbeat("a", 0);
    expect(p.stale([], 60_000)).toEqual([]);
    p.forget("a");
    expect(p.stale(["a"], 60_000)).toEqual([]);
  });

  it("自己断线重连回来：所有人从现在重新计时，不会一回来就全标掉线", () => {
    const p = new PeerLiveness();
    p.heartbeat("a", 0);
    p.heartbeat("b", 0);
    p.graceAll(40_000);
    expect(p.stale(["a", "b"], 40_000 + HEARTBEAT_STALE_MS - 1)).toEqual([]);
  });

  it("reset：退房 / 重新进房后从头来", () => {
    const p = new PeerLiveness();
    p.heartbeat("a", 0);
    p.reset();
    expect(p.stale(["a"], 60_000)).toEqual([]);
  });
});
