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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    FakeWs.instances[2].open();
    expect(states.at(-1)).toBe(true);
    // 退避已清零：再断一次只等 1 s
    FakeWs.instances[2].drop();
    jest.advanceTimersByTime(1000);
    expect(FakeWs.instances).toHaveLength(4);
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
