// 实时通道客户端：退避与「回前台立刻重连」（kick）。用假的 WebSocket 全局对象，不碰网络。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));

type Handler = ((e: { code: number; reason: string }) => void) | null;
class FakeWs {
  static instances: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onclose: Handler = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  dropped = false;
  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  drop(code = 1006) {
    this.dropped = true;
    this.onclose?.({ code, reason: "" });
  }
}

const g = globalThis as unknown as { WebSocket: unknown };
let originalWs: unknown;
beforeEach(() => {
  jest.useFakeTimers();
  originalWs = g.WebSocket;
  g.WebSocket = FakeWs;
  FakeWs.instances = [];
  jest.resetModules();
});
afterEach(() => {
  g.WebSocket = originalWs;
  jest.useRealTimers();
});

// resetModules 后重新加载单例（动态 import 在本仓库 jest 里不可用，沿用 sos-alert 测试的 require 写法）
const load = async () =>
  (require("../realtime") as typeof import("../realtime")).realtimeClient;
const deps = {
  getAccessToken: () => "tok",
  triggerTokenRefresh: async () => undefined,
};

describe("realtimeClient 退避与 kick", () => {
  it("断线后按 1s/2s/4s 指数退避重连", async () => {
    const c = await load();
    c.start(deps);
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop();
    expect(FakeWs.instances).toHaveLength(1);
    jest.advanceTimersByTime(999);
    expect(FakeWs.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(2);
    FakeWs.instances[1].drop();
    jest.advanceTimersByTime(1999);
    expect(FakeWs.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(3);
    c.stop();
  });

  it("kick：断线等待退避期间立刻重连并清零退避（飞行模式关掉后提示条不再干等）", async () => {
    const c = await load();
    const states: boolean[] = [];
    c.subscribeState((v) => states.push(v));
    c.start(deps);
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop();
    FakeWs.instances[1] && FakeWs.instances[1].drop();
    jest.advanceTimersByTime(1000); // 第 1 次重连
    FakeWs.instances[1].drop(); // 又失败 → 下一次要等 2 s
    jest.advanceTimersByTime(500);
    expect(FakeWs.instances).toHaveLength(2);
    c.kick(); // 回前台
    expect(FakeWs.instances).toHaveLength(3); // 不等那 2 s
    // 退避已清零：这条没连上（不 open——onopen 自己也会清零，会把 kick 的清零盖住测不出来）就断，只等 1 s
    FakeWs.instances[2].drop();
    jest.advanceTimersByTime(999);
    expect(FakeWs.instances).toHaveLength(3);
    jest.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(4);
    FakeWs.instances[3].open();
    expect(states.at(-1)).toBe(true);
    c.stop();
  });

  it("4401 换 token 途中回前台 kick：只留一条连接，刷新回来不再另起一条（原来两路各建一条，先建的成了没人关的孤儿）", async () => {
    const c = await load();
    let finishRefresh!: () => void;
    const refreshing = new Promise<void>((r) => (finishRefresh = r));
    c.start({
      getAccessToken: () => "tok",
      triggerTokenRefresh: () => refreshing,
    });
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop(4401); // 服务端：token 过期
    c.kick(); // 刷新还没回来，用户切回前台
    expect(FakeWs.instances).toHaveLength(2);
    FakeWs.instances[1].open();
    finishRefresh();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(2); // 没有第三条
    expect(FakeWs.instances[1].closed).toBe(false);
    c.stop();
  });

  it("kick 出来的新连接又被 4401（用的还是旧 token）：两轮刷新先后回来，最终只剩一条活连接", async () => {
    const c = await load();
    const refreshes: (() => void)[] = [];
    c.start({
      getAccessToken: () => "tok",
      triggerTokenRefresh: () => new Promise<void>((r) => refreshes.push(r)),
    });
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop(4401);
    c.kick(); // #1
    FakeWs.instances[1].drop(4401); // 新连接用的还是旧 token，又被 4401
    for (const r of refreshes) r();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    const alive = FakeWs.instances.filter((w) => !w.closed && !w.dropped);
    expect(alive).toHaveLength(1); // 只剩最后一条，其余要么被 close 要么已断
    c.stop();
  });

  it("kick：已连上或未启动时什么都不做；握手中卡住的旧连接被放弃", async () => {
    const c = await load();
    c.kick(); // 未启动
    expect(FakeWs.instances).toHaveLength(0);
    c.start(deps);
    FakeWs.instances[0].open();
    c.kick(); // 已连上
    expect(FakeWs.instances).toHaveLength(1);
    FakeWs.instances[0].drop();
    jest.advanceTimersByTime(1000); // 第 2 条连接卡在握手（不 open 也不 close）
    c.kick();
    expect(FakeWs.instances[1].closed).toBe(true);
    expect(FakeWs.instances).toHaveLength(3);
    // 卡住那条迟到的 onclose 不能再触发一轮重连
    FakeWs.instances[1].drop();
    jest.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(3);
    c.stop();
  });
});
