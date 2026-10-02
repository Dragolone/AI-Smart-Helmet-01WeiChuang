// 边界补测（2026-10-03）：实时通道客户端。realtime.test.ts 钉了 1s/2s 退避与 kick；
// 这里补退避封顶、4401 换 token、会话被清、畸形消息、stop 之后的迟到回调。
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));

class FakeWs {
  static instances: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
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
  message(data: unknown) {
    this.onmessage?.({ data });
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
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  g.WebSocket = originalWs;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const load = () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require("../realtime") as typeof import("../realtime")).realtimeClient;
const last = () => FakeWs.instances[FakeWs.instances.length - 1];
const count = () => FakeWs.instances.length;
const depsWith = (token: () => string | null, refresh: () => Promise<unknown> = async () => undefined) => ({
  getAccessToken: token,
  triggerTokenRefresh: jest.fn(refresh),
});

describe("退避", () => {
  it("连续失败按 1/2/4/8/16 s 增长后封顶 30 s；失败上千次（2^n 溢出成 Infinity）仍是 30 s", () => {
    const c = load();
    c.start(depsWith(() => "tok"));
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = count();
      last().drop();
      jest.advanceTimersByTime(delay - 1);
      expect(count()).toBe(before);
      jest.advanceTimersByTime(1);
      expect(count()).toBe(before + 1);
    }
    for (let i = 0; i < 1100; i += 1) {
      last().drop();
      jest.advanceTimersByTime(30_000);
    }
    const before = count();
    last().drop();
    jest.advanceTimersByTime(29_999);
    expect(count()).toBe(before);
    jest.advanceTimersByTime(1);
    expect(count()).toBe(before + 1);
    c.stop();
  });

  it("一旦连上退避清零：失败三轮后连上，再掉线只等 1 s", () => {
    const c = load();
    c.start(depsWith(() => "tok"));
    for (const delay of [1000, 2000, 4000]) {
      last().drop();
      jest.advanceTimersByTime(delay);
    }
    last().open();
    const before = count();
    last().drop();
    jest.advanceTimersByTime(1000);
    expect(count()).toBe(before + 1);
    c.stop();
  });
});

describe("4401（access token 过期）", () => {
  it("先换 token 再重连：新连接用的是换来的新 token，且做了 URL 编码", async () => {
    let token = "old+tok/=";
    const c = load();
    const deps = depsWith(
      () => token,
      async () => {
        token = "new+tok/=";
      },
    );
    c.start(deps);
    expect(last().url).toContain(`token=${encodeURIComponent("old+tok/=")}`);
    last().open();
    last().drop(4401);
    expect(deps.triggerTokenRefresh).toHaveBeenCalledTimes(1);
    expect(count()).toBe(1); // 刷新没回来之前不抢着重连
    await jest.advanceTimersByTimeAsync(1000);
    expect(count()).toBe(2);
    expect(last().url).toContain(`token=${encodeURIComponent("new+tok/=")}`);
    c.stop();
  });

  it("换 token 失败（断网）：照常走退避重连，不卡死", async () => {
    const c = load();
    const deps = depsWith(
      () => "tok",
      async () => {
        throw new Error("offline");
      },
    );
    c.start(deps);
    last().drop(4401);
    await jest.advanceTimersByTimeAsync(1000);
    expect(count()).toBe(2);
    c.stop();
  });

  it("换 token 途中用户登出（stop）：刷新回来后不再重连", async () => {
    let finish: () => void = () => undefined;
    const c = load();
    c.start(
      depsWith(
        () => "tok",
        () =>
          new Promise<void>((r) => {
            finish = r;
          }),
      ),
    );
    last().open();
    last().drop(4401);
    c.stop();
    finish();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(1);
  });

  it("刷新结论是会话已失效（token 被清成 null）：停止重连；重新登录后 start 能再连上", async () => {
    let token: string | null = "tok";
    const c = load();
    const states: boolean[] = [];
    c.subscribeState((v) => states.push(v));
    c.start(
      depsWith(
        () => token,
        async () => {
          token = null;
        },
      ),
    );
    last().open();
    last().drop(4401);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(count()).toBe(1);
    expect(states.at(-1)).toBe(false);
    token = "tok-after-login";
    c.start(depsWith(() => token));
    expect(count()).toBe(2);
    expect(last().url).toContain("tok-after-login");
    c.stop();
  });
});

describe("消息分发", () => {
  it("畸形 JSON、非对象、监听器自己抛错：都不影响后面的消息，也不断开连接", () => {
    const c = load();
    const got: unknown[] = [];
    c.subscribe((m) => {
      if ((m as { type?: string })?.type === "boom") throw new Error("listener bug");
      got.push(m);
    });
    c.start(depsWith(() => "tok"));
    last().open();
    expect(() => last().message("{not json")).not.toThrow();
    expect(() => last().message("")).not.toThrow();
    expect(() => last().message(JSON.stringify({ type: "boom" }))).not.toThrow();
    last().message(JSON.stringify({ type: "device_status", data: { deviceId: "d1" } }));
    expect(got).toEqual([{ type: "device_status", data: { deviceId: "d1" } }]);
    expect(last().closed).toBe(false);
    expect(count()).toBe(1);
    c.stop();
  });

  it("退订后不再收到消息；重复退订不抛", () => {
    const c = load();
    const listener = jest.fn();
    const off = c.subscribe(listener);
    c.start(depsWith(() => "tok"));
    last().open();
    last().message(JSON.stringify({ type: "a" }));
    off();
    off();
    last().message(JSON.stringify({ type: "b" }));
    expect(listener).toHaveBeenCalledTimes(1);
    c.stop();
  });
});

describe("start / stop 生命周期", () => {
  it("stop 之后：等待中的重连定时器作废，旧连接迟到的 onclose 也不会拉起新连接", () => {
    const c = load();
    c.start(depsWith(() => "tok"));
    const first = last();
    first.open();
    first.drop(); // 排了 1 s 后重连
    c.stop();
    jest.advanceTimersByTime(60_000);
    expect(count()).toBe(1);
    c.start(depsWith(() => "tok"));
    const second = last();
    c.stop();
    expect(second.closed).toBe(true);
    second.drop(); // close() 之后系统才回调 onclose
    jest.advanceTimersByTime(60_000);
    expect(count()).toBe(2);
  });

  it("运行中重复 start：不建第二条连接，但下次重连用的是新传入的取 token 方法", () => {
    const c = load();
    c.start(depsWith(() => "tok-A"));
    c.start(depsWith(() => "tok-B"));
    expect(count()).toBe(1);
    last().drop();
    jest.advanceTimersByTime(1000);
    expect(count()).toBe(2);
    expect(last().url).toContain("tok-B");
    c.stop();
  });

  it("未登录就 start（token 为空）：不建连接；拿到 token 后再次 start 才连", () => {
    let token: string | null = null;
    const c = load();
    c.start(depsWith(() => token));
    expect(count()).toBe(0);
    token = "tok";
    c.start(depsWith(() => token));
    expect(count()).toBe(1);
    c.stop();
  });

  it("状态订阅：订阅即回放当前值，同一状态不重复通知，退订后不再通知", () => {
    const c = load();
    const states: boolean[] = [];
    const off = c.subscribeState((v) => states.push(v));
    expect(states).toEqual([false]);
    c.start(depsWith(() => "tok"));
    last().open();
    last().open(); // 重复的 open 回调
    expect(states).toEqual([false, true]);
    const late: boolean[] = [];
    c.subscribeState((v) => late.push(v));
    expect(late).toEqual([true]);
    off();
    last().drop();
    expect(states).toEqual([false, true]);
    expect(late).toEqual([true, false]);
    c.stop();
  });
});
