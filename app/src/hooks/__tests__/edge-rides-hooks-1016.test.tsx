// 行程相关几个查询 hook 的边界（2026-10-16）：按月往前翻时跳过空月、翻到头盔登记那个月为止、
// 连着 12 个空月先停；一趟路上的事件分页取满 3 页为止；「今日骑行」的 50 米门槛；轨迹里去掉 (0,0)。
// 用真的 QueryClient 渲染一个只调 hook 的小组件；接口全部替换成假的。
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
import type { RideSummary } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { eventsApi } from "@/api/events";
import { formatRideDuration, useRideToday } from "../use-ride-today";
import {
  useRideAt,
  useRideEvents,
  useRidePages,
  useRideTrack,
} from "../use-rides";

jest.mock("@/api/devices", () => ({
  devicesApi: {
    rides: jest.fn(),
    track: jest.fn(),
    locationSummary: jest.fn(),
  },
}));
jest.mock("@/api/events", () => ({ eventsApi: { list: jest.fn() } }));

// 假接口只关心入参和返回的那几样字段，不按完整的响应类型造数据
type AnyMock = jest.Mock<(...args: any[]) => any>;
const ridesMock = devicesApi.rides as unknown as AnyMock;
const trackMock = devicesApi.track as unknown as AnyMock;
const summaryMock = devicesApi.locationSummary as unknown as AnyMock;
const eventsMock = eventsApi.list as unknown as AnyMock;

const MIN = 60_000;
let qc: QueryClient;
const renderers: ReactTestRenderer[] = [];

async function renderHook<T>(hook: () => T): Promise<{ current: T }> {
  const box = {} as { current: T };
  function Probe() {
    box.current = hook();
    return null;
  }
  await act(async () => {
    renderers.push(
      create(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
  });
  return box;
}

/** 让在途的查询跑完（每轮把排队的微任务和 0 毫秒定时器都清掉） */
async function settle(until: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !until(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const ride = (start: Date): RideSummary => ({
  startAt: start.toISOString(),
  endAt: new Date(start.getTime() + 30 * MIN).toISOString(),
  distanceMeters: 1000,
  movingSeconds: 1500,
  maxSpeed: 5,
  ongoing: false,
});
const monthsAgo = (n: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - n, 15, 12);
};
const monthStartIso = (n: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - n, 1).toISOString();
};

beforeEach(() => {
  qc = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  ridesMock.mockReset();
  trackMock.mockReset();
  summaryMock.mockReset();
  eventsMock.mockReset();
});
const unmountAll = async () => {
  await act(async () => {
    for (const r of renderers.splice(0)) r.unmount();
  });
};
afterEach(async () => {
  await unmountAll();
  qc.clear();
});

describe("useRidePages：按月往前翻", () => {
  it("中间的空月自动跳过：本月和上月没有、上上月有——一次取回上上月，下一页从再往前一个月接着翻", async () => {
    ridesMock.mockImplementation(async (_id: string, from: string) => ({
      rides: from === monthStartIso(2) ? [ride(monthsAgo(2))] : [],
    }));
    const r = await renderHook(() =>
      useRidePages("h1", monthsAgo(24).toISOString(), true),
    );
    await settle(() => r.current.isSuccess);
    expect(ridesMock.mock.calls.map((c) => c[1])).toEqual([
      monthStartIso(0),
      monthStartIso(1),
      monthStartIso(2),
    ]);
    const page = r.current.data!.pages[0];
    expect(page.rides).toHaveLength(1);
    const want = new Date(monthsAgo(3));
    expect(page.next).toEqual({
      year: want.getFullYear(),
      month: want.getMonth(),
    });
    expect(r.current.hasNextPage).toBe(true);
  });

  it("翻到头盔登记的那个月还没有：停在那个月，没有更早的了", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    const r = await renderHook(() =>
      useRidePages("h1", monthsAgo(3).toISOString(), true),
    );
    await settle(() => r.current.isSuccess);
    expect(ridesMock).toHaveBeenCalledTimes(4);
    expect(r.current.data!.pages[0]).toEqual({ rides: [], next: null });
    expect(r.current.hasNextPage).toBe(false);
  });

  it("连着 12 个空月先停（滑雪盔一年只用一季），把「加载更早的」交还给用户，下一页从第 13 个月接着翻", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    const r = await renderHook(() =>
      useRidePages("h1", monthsAgo(60).toISOString(), true),
    );
    await settle(() => r.current.isSuccess);
    expect(ridesMock).toHaveBeenCalledTimes(12);
    const want = monthsAgo(12);
    expect(r.current.data!.pages[0]).toEqual({
      rides: [],
      next: { year: want.getFullYear(), month: want.getMonth() },
    });
    expect(r.current.hasNextPage).toBe(true);
  });

  it("登记时间认不出：从 2000 年 1 月算起（不会少翻）", async () => {
    ridesMock.mockResolvedValue({ rides: [ride(monthsAgo(0))] });
    await renderHook(() => useRidePages("h1", "not-a-date", true));
    await settle(() => ridesMock.mock.calls.length > 0);
    expect(
      qc.getQueryCache().findAll({ queryKey: ["rides", "h1", 2000, 0] }),
    ).toHaveLength(1);
  });

  it("登记时间在将来（服务器时钟错了）：只查本月，没有更早的", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const r = await renderHook(() => useRidePages("h1", future, true));
    await settle(() => r.current.isSuccess);
    expect(ridesMock).toHaveBeenCalledTimes(1);
    expect(r.current.data!.pages[0].next).toBeNull();
  });

  it("没有设备号或没启用：不发请求", async () => {
    await renderHook(() => useRidePages(undefined, undefined, true));
    await renderHook(() => useRidePages("h1", undefined, false));
    await settle(() => false, 5);
    expect(ridesMock).not.toHaveBeenCalled();
  });

  it("这个月的查询截到此刻之后一分钟，过完的月截到下月 1 日零点", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    const before = Date.now();
    const r = await renderHook(() =>
      useRidePages("h1", monthsAgo(1).toISOString(), true),
    );
    await settle(() => r.current.isSuccess);
    const [[, from0, to0], [, from1, to1]] = ridesMock.mock
      .calls as unknown as [string, string, string][];
    expect(from0).toBe(monthStartIso(0));
    expect(Date.parse(to0) - before).toBeGreaterThanOrEqual(MIN - 5);
    expect(Date.parse(to0) - before).toBeLessThan(MIN + 5_000);
    expect(from1).toBe(monthStartIso(1));
    expect(to1).toBe(monthStartIso(0));
  });
});

describe("useRideEvents：一趟路上的事件分页", () => {
  const win = {
    from: "2026-10-16T00:00:00.000Z",
    to: "2026-10-16T01:00:00.000Z",
  };
  const page = (n: number, total: number) => ({
    items: Array.from({ length: n }, (_, i) => ({ id: `e${i}` })),
    total,
    page: 1,
    pageSize: 100,
  });

  it("没有事件：只取一页", async () => {
    eventsMock.mockResolvedValue(page(0, 0));
    const r = await renderHook(() => useRideEvents("h1", win));
    await settle(() => r.current.isSuccess);
    expect(eventsMock).toHaveBeenCalledTimes(1);
    expect(r.current.data).toEqual({ items: [], total: 0 });
  });

  it("250 条：取 3 页拿全；查询的结束时间是这一趟结束后 15 分钟，四类事件", async () => {
    eventsMock
      .mockResolvedValueOnce(page(100, 250))
      .mockResolvedValueOnce(page(100, 250))
      .mockResolvedValueOnce(page(50, 250));
    const r = await renderHook(() => useRideEvents("h1", win));
    await settle(() => r.current.isSuccess);
    expect(eventsMock).toHaveBeenCalledTimes(3);
    expect(r.current.data!.items).toHaveLength(250);
    const opts = eventsMock.mock.calls[0][1] as unknown as Record<
      string,
      unknown
    >;
    expect(opts).toMatchObject({
      type: "collision_risk,obstacle_risk,possible_fall,manual_sos",
      from: win.from,
      to: "2026-10-16T01:15:00.000Z",
      page: 1,
      pageSize: 100,
    });
  });

  it("350 条：最多取 3 页（300 条），总数照实给 350，页面据此写「还有 50 条没标出来」", async () => {
    eventsMock.mockResolvedValue(page(100, 350));
    const r = await renderHook(() => useRideEvents("h1", win));
    await settle(() => r.current.isSuccess);
    expect(eventsMock).toHaveBeenCalledTimes(3);
    expect(r.current.data!.items).toHaveLength(300);
    expect(r.current.data!.total).toBe(350);
  });

  it("某一页不满 100 条（总数和实际对不上）：就此停下，不空转", async () => {
    eventsMock
      .mockResolvedValueOnce(page(100, 999))
      .mockResolvedValueOnce(page(7, 999));
    const r = await renderHook(() => useRideEvents("h1", win));
    await settle(() => r.current.isSuccess);
    expect(eventsMock).toHaveBeenCalledTimes(2);
    expect(r.current.data!.items).toHaveLength(107);
  });

  it("没有范围：不发请求", async () => {
    await renderHook(() => useRideEvents("h1", null));
    await settle(() => false, 5);
    expect(eventsMock).not.toHaveBeenCalled();
  });
});

describe("useRideTrack：轨迹里去掉没定位的点", () => {
  const win = { from: "a", to: "b" };
  it("全是正常点：原样给（同一个对象）", async () => {
    const data = {
      points: [{ latitude: 22.5, longitude: 113.9 }],
      summary: {},
    };
    trackMock.mockResolvedValue(data);
    const r = await renderHook(() => useRideTrack("h1", win));
    await settle(() => r.current.isSuccess);
    expect(r.current.data).toBe(data);
  });

  it("混着 (0,0)、越界、NaN 的点：只去掉这些，统计不动", async () => {
    trackMock.mockResolvedValue({
      points: [
        { latitude: 22.5, longitude: 113.9 },
        { latitude: 0, longitude: 0 },
        { latitude: 91, longitude: 113.9 },
        { latitude: Number.NaN, longitude: 113.9 },
        { latitude: 22.6, longitude: 114 },
      ],
      summary: { distanceMeters: 5 },
    });
    const r = await renderHook(() => useRideTrack("h1", win));
    await settle(() => r.current.isSuccess);
    expect(r.current.data!.points).toEqual([
      { latitude: 22.5, longitude: 113.9 },
      { latitude: 22.6, longitude: 114 },
    ]);
    expect((r.current.data as unknown as { summary: unknown }).summary).toEqual(
      { distanceMeters: 5 },
    );
  });

  it("全是没定位的点：空轨迹，不抛", async () => {
    trackMock.mockResolvedValue({ points: [{ latitude: 0, longitude: 0 }] });
    const r = await renderHook(() => useRideTrack("h1", win));
    await settle(() => r.current.isSuccess);
    expect(r.current.data!.points).toEqual([]);
  });
});

describe("useRideAt", () => {
  it("那一刻在某一趟里：给出那一趟；查的范围往前两天、往后三分钟", async () => {
    const at = Date.now() - 3 * 3_600_000;
    const r1 = ride(new Date(at - 10 * MIN));
    ridesMock.mockResolvedValue({ rides: [r1] });
    const r = await renderHook(() => useRideAt("h1", at));
    await settle(() => r.current.isSuccess);
    expect(r.current.data).toEqual(r1);
    const [, from, to] = ridesMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(at - Date.parse(from)).toBeGreaterThanOrEqual(2 * 86_400_000);
    expect(Date.parse(to)).toBe(at + 3 * MIN);
  });

  it("不在任何一趟里：data 是 null（查到了但没有），不是 undefined", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    // 那一刻要在渲染之外定下来：每次渲染都取 Date.now() 的话查询键一直在变
    const at = Date.now();
    const r = await renderHook(() => useRideAt("h1", at));
    await settle(() => r.current.isSuccess);
    expect(r.current.data).toBeNull();
  });

  it("时间戳 0 也照常查（不是「没有那一刻」）；null 才不查", async () => {
    ridesMock.mockResolvedValue({ rides: [] });
    await renderHook(() => useRideAt("h1", null));
    await settle(() => false, 5);
    expect(ridesMock).not.toHaveBeenCalled();
    const r = await renderHook(() => useRideAt("h1", 0));
    await settle(() => r.current.isSuccess);
    expect(ridesMock).toHaveBeenCalledTimes(1);
  });
});

describe("今日骑行", () => {
  it("50 米是门槛：49.9 米算没骑（定位漂移），50 米算骑过", async () => {
    summaryMock.mockResolvedValueOnce({
      distanceMeters: 49.9,
      movingSeconds: 600,
    });
    const a = await renderHook(() => useRideToday("h1"));
    await settle(() => a.current.status !== "unknown");
    expect(a.current).toEqual({ status: "none" });
    await unmountAll();
    qc.clear();
    summaryMock.mockResolvedValueOnce({
      distanceMeters: 50,
      movingSeconds: 600,
    });
    const b = await renderHook(() => useRideToday("h2"));
    await settle(() => b.current.status !== "unknown");
    expect(b.current).toEqual({
      status: "rode",
      distanceMeters: 50,
      movingSeconds: 600,
    });
  });

  it("还没拿到：unknown（不写成「还没有骑行」）；查的是本地零点到此刻", async () => {
    let resolve!: (v: unknown) => void;
    summaryMock.mockImplementation(() => new Promise((r) => (resolve = r)));
    const r = await renderHook(() => useRideToday("h1"));
    expect(r.current).toEqual({ status: "unknown" });
    const [, from, to] = summaryMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(from).toBe(midnight.toISOString());
    expect(Date.parse(to)).toBeGreaterThanOrEqual(Date.parse(from));
    await act(async () => resolve({ distanceMeters: 0, movingSeconds: 0 }));
  });

  it("时长写法：不足一小时写分钟（0 秒也写 1 分钟），整点进位写「1:00 小时」，23:59 / 24:00", () => {
    expect(formatRideDuration(0)).toEqual({ value: "1", unit: "min" });
    expect(formatRideDuration(59 * 60 + 29)).toEqual({
      value: "59",
      unit: "min",
    });
    expect(formatRideDuration(59 * 60 + 30)).toEqual({
      value: "1:00",
      unit: "h",
    });
    expect(formatRideDuration(65 * 60)).toEqual({ value: "1:05", unit: "h" });
    expect(formatRideDuration(86_340)).toEqual({ value: "23:59", unit: "h" });
    expect(formatRideDuration(86_400)).toEqual({ value: "24:00", unit: "h" });
    expect(formatRideDuration(Number.NaN)).toEqual({ value: "1", unit: "min" });
  });
});
