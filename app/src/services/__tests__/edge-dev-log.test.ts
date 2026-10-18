// 开发期旁路日志的边界（2026-10-16）：配了 EXPO_PUBLIC_BLE_LOG_URL 时每条日志 POST 到本机接收器。
// 写日志绝不能抛——devLog 被 BLE 链路、中转队列、求救同步到处调用，抛出去就打断了调用方。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

type DevLog = typeof import("../dev-log");

const SINK = "http://192.168.1.2:9999/log";
let fetchMock: jest.Mock<
  (url: string, init: { body: string }) => Promise<unknown>
>;

const load = (sink: string | undefined): DevLog => {
  const prev = process.env.EXPO_PUBLIC_BLE_LOG_URL;
  if (sink === undefined) delete process.env.EXPO_PUBLIC_BLE_LOG_URL;
  else process.env.EXPO_PUBLIC_BLE_LOG_URL = sink;
  let mod!: DevLog;
  jest.isolateModules(() => {
    mod = jest.requireActual<DevLog>("../dev-log");
  });
  if (prev === undefined) delete process.env.EXPO_PUBLIC_BLE_LOG_URL;
  else process.env.EXPO_PUBLIC_BLE_LOG_URL = prev;
  return mod;
};
const sent = () => fetchMock.mock.calls.map(([, init]) => init.body);

beforeEach(() => {
  fetchMock = jest.fn(() => Promise.resolve({}));
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("devLog", () => {
  it("没配接收地址：只打控制台，不发请求", () => {
    load(undefined).devLog("BLE", "hello", { a: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[BLE]", "hello", { a: 1 });
  });

  it("配了：字符串原样、对象转 JSON、错误带堆栈，拼成一行带标签", () => {
    const err = new Error("boom");
    load(SINK).devLog("RELAY", "flush", { n: 3 }, err);
    expect(fetchMock).toHaveBeenCalledWith(
      SINK,
      expect.objectContaining({ method: "POST" }),
    );
    const body = sent()[0];
    expect(body.startsWith('[RELAY] flush {"n":3} ')).toBe(true);
    expect(body).toContain("boom");
  });

  // 原来 JSON.stringify 抛 TypeError，从 devLog 一路抛进调用方
  it("循环引用的对象、BigInt：不抛，照样发出一行", () => {
    const { devLog } = load(SINK);
    const loop: Record<string, unknown> = { id: "helmet_1" };
    loop.self = loop;
    expect(() => devLog("BLE", "device", loop)).not.toThrow();
    expect(() => devLog("BLE", "seq", BigInt(7))).not.toThrow();
    expect(sent()).toEqual(["[BLE] device [object Object]", "[BLE] seq 7"]);
  });

  it("undefined、null、数字、布尔、函数：都有字面写法，不出现空洞", () => {
    load(SINK).devLog("X", undefined, null, 0, false, () => 1);
    expect(sent()[0]).toBe("[X] undefined null 0 false () => 1");
  });

  it("连 String() 都会抛的对象：写成占位，不抛", () => {
    const evil = Object.create(null) as Record<string, unknown>;
    evil.toJSON = () => {
      throw new Error("no json");
    };
    expect(() => load(SINK).devLog("X", evil)).not.toThrow();
    expect(sent()[0]).toBe("[X] [unprintable]");
  });

  it("接收器连不上（fetch 拒绝）：吞掉，不产生未处理的 Promise 拒绝", async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    expect(() => load(SINK).devLog("X", "a")).not.toThrow();
    await Promise.resolve();
  });

  it("接收地址是空串：等于没配", () => {
    load("").devLog("X", "a");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("错误对象没有堆栈（有的运行时不给）：写它的 message", () => {
    const err = new Error("no stack here");
    err.stack = undefined;
    load(SINK).devLog("X", err);
    expect(sent()[0]).toBe("[X] no stack here");
  });
});

describe("installDevErrorTap", () => {
  type Handler = (error: unknown, isFatal?: boolean) => void;
  const g = globalThis as { ErrorUtils?: unknown };
  let saved: unknown;
  /** 替身 ErrorUtils：记下装上去的处理函数，原来的处理是 prev */
  const box: { installed?: Handler; prev: jest.Mock<Handler> } = {
    prev: jest.fn<Handler>(),
  };
  beforeEach(() => {
    saved = g.ErrorUtils;
    box.installed = undefined;
    box.prev = jest.fn<Handler>();
    g.ErrorUtils = {
      getGlobalHandler: () => box.prev,
      setGlobalHandler: (h: Handler) => {
        box.installed = h;
      },
    };
  });
  afterEach(() => {
    g.ErrorUtils = saved;
  });

  it("没配接收地址：不动全局的异常处理", () => {
    load(undefined).installDevErrorTap();
    expect(box.installed).toBeUndefined();
  });

  it("配了：未捕获的异常（致命 / 非致命）也旁路发一行，然后照常交回原来的处理（红屏照出）", () => {
    load(SINK).installDevErrorTap();
    const err = new Error("render crashed");
    box.installed!(err, true);
    box.installed!(err, false);
    expect(sent()[0].startsWith("[UNCAUGHT] fatal ")).toBe(true);
    expect(sent()[0]).toContain("render crashed");
    expect(sent()[1].startsWith("[UNCAUGHT] non-fatal ")).toBe(true);
    expect(box.prev).toHaveBeenNthCalledWith(1, err, true);
    expect(box.prev).toHaveBeenNthCalledWith(2, err, false);
  });
});
