// 行程查询 hook（2026-10-17 地图页复审）：跨月后列表从新的这个月翻起；重新打开列表不把翻过的页全重拉；
// 「进行中那一趟」的轨迹换范围时留着上一份，但换了头盔就不留（不然画出跨两顶头盔的直线）。
// 用真的 QueryClient 渲染一个只调 hook 的小组件；接口替换成假的。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { devicesApi } from "@/api/devices";
import {
  previousIfSameDevice,
  useRidePages,
  useRideTrack,
} from "../use-rides";

jest.mock("@/api/devices", () => ({
  devicesApi: { rides: jest.fn(), track: jest.fn() },
}));
jest.mock("@/api/events", () => ({ eventsApi: { list: jest.fn() } }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const ridesMock = devicesApi.rides as unknown as AnyMock;
const trackMock = devicesApi.track as unknown as AnyMock;

let qc: QueryClient;
const renderers: ReactTestRenderer[] = [];

/** 渲染一个只调 hook 的组件；rerender 换参数后重渲染（同一个组件，不重挂载） */
async function renderHook<A, T>(
  hook: (args: A) => T,
  initial: NoInfer<A>,
): Promise<{ current: T; rerender: (args: A) => Promise<void> }> {
  let args = initial;
  const box = {} as { current: T; rerender: (a: A) => Promise<void> };
  function Probe() {
    box.current = hook(args);
    return null;
  }
  const el = () => (
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(el());
  });
  renderers.push(renderer);
  box.rerender = async (a: A) => {
    args = a;
    await act(async () => {
      renderer.update(el());
    });
  };
  return box;
}

async function settle(until: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !until(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const unmountAll = async () => {
  await act(async () => {
    for (const r of renderers.splice(0)) r.unmount();
  });
};

beforeEach(() => {
  qc = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  ridesMock.mockReset();
  trackMock.mockReset();
});
afterEach(async () => {
  await unmountAll();
  qc.clear();
  jest.useRealTimers();
});

/** 只假装时间（Date），计时器照常走：查询库和 settle 都靠真的 setTimeout */
const fakeNow = (now: Date) =>
  jest.useFakeTimers({
    now,
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });

describe("useRidePages", () => {
  const since = new Date(2025, 0, 1).toISOString();
  const usePages = (enabled: boolean) => useRidePages("h1", since, enabled);

  it("跨月之后：重新打开列表从新的这个月翻起（不是一直从上个月开始）", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    fakeNow(new Date(2026, 9, 31, 23, 58));
    const r = await renderHook(usePages, true);
    await settle(() => r.current.isSuccess);
    expect(ridesMock.mock.calls[0][1]).toBe(new Date(2026, 9, 1).toISOString());
    await r.rerender(false);
    ridesMock.mockClear();

    jest.setSystemTime(new Date(2026, 10, 1, 0, 5));
    await r.rerender(true);
    await settle(() => ridesMock.mock.calls.length > 0 && r.current.isSuccess);
    expect(ridesMock.mock.calls[0][1]).toBe(
      new Date(2026, 10, 1).toISOString(),
    );
    expect(
      qc
        .getQueryCache()
        .findAll({ queryKey: ["rides", "h1", 2025, 0, 2026, 10] }),
    ).toHaveLength(1);
  });

  it("5 分钟内重新打开列表：翻过的页不重拉（最新几趟另有每 30 秒刷新的那一份）", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    const r = await renderHook(usePages, true);
    await settle(() => r.current.isSuccess);
    const calls = ridesMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await unmountAll();
    const again = await renderHook(usePages, true);
    await settle(() => again.current.isSuccess);
    await settle(() => false, 5);
    expect(ridesMock).toHaveBeenCalledTimes(calls);
  });
});

describe("useRideTrack：换范围时留着上一份，只限同一顶头盔", () => {
  const winA = {
    from: "2026-10-17T01:00:00.000Z",
    to: "2026-10-17T01:30:00.000Z",
  };
  const winB = { ...winA, to: "2026-10-17T01:31:00.000Z" };
  const track = (lat: number) => ({
    points: [{ latitude: lat, longitude: 113.9, timestamp: winA.from }],
    summary: {},
  });
  type Args = { id: string; win: typeof winA; keep: boolean };
  const useTrack = ({ id, win, keep }: Args) => useRideTrack(id, win, keep);

  it("同一顶头盔换了范围：新的到之前先留着上一份；换了头盔：不留", async () => {
    trackMock.mockImplementation(async (id: string, _f: string, to: string) =>
      id === "h1" && to === winA.to ? track(22.5) : new Promise(() => {}),
    );
    const r = await renderHook(useTrack, { id: "h1", win: winA, keep: true });
    await settle(() => r.current.isSuccess);
    expect(r.current.data!.points[0].latitude).toBe(22.5);

    await r.rerender({ id: "h1", win: winB, keep: true });
    expect(r.current.isPlaceholderData).toBe(true);
    expect(r.current.data!.points[0].latitude).toBe(22.5);

    await r.rerender({ id: "h2", win: winA, keep: true });
    expect(r.current.data).toBeUndefined();
    expect(r.current.isPlaceholderData).toBe(false);
  });

  it("不要求留（看历史行程）：换范围就不留", async () => {
    trackMock.mockImplementation(async (_id: string, _f: string, to: string) =>
      to === winA.to ? track(22.5) : new Promise(() => {}),
    );
    const r = await renderHook(useTrack, { id: "h1", win: winA, keep: false });
    await settle(() => r.current.isSuccess);
    await r.rerender({ id: "h1", win: winB, keep: false });
    expect(r.current.data).toBeUndefined();
  });

  it("previousIfSameDevice：上一次查询的设备号（键的第二位）对得上才给上一份", () => {
    const prev = { points: [] };
    const of = (id: string) => ({ queryKey: ["ride-track", id, "a", "b"] });
    expect(previousIfSameDevice(prev, of("h1"), "h1")).toBe(prev);
    expect(previousIfSameDevice(prev, of("h2"), "h1")).toBeUndefined();
    expect(previousIfSameDevice(prev, undefined, "h1")).toBeUndefined();
    expect(previousIfSameDevice(undefined, of("h1"), "h1")).toBeUndefined();
  });
});
