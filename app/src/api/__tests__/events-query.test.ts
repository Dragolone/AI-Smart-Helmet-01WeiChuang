// 事件列表查询配置：缓存键必须把条数算进去。安全页（每台 5 条）和事件页（每台 50 条）
// 曾共用同一个键，两页各自轮询时互相覆盖，事件页的列表在 5 条和 50 条之间来回跳。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { eventsListPrefix, eventsListQuery } from "../events";

// jest.mock 会被提升到 import 之前；工厂里的箭头函数到真正发请求时才读 mockApi
const mockApi = jest.fn(async (_path: string) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 0,
}));
// 事件列表走 apiPage（分页应答校验在 client.ts，这里只看键和路径）
jest.mock("../client", () => ({ apiPage: (path: string) => mockApi(path) }));

const TYPE = "collision_risk,obstacle_risk";

beforeEach(() => {
  mockApi.mockClear();
});

describe("eventsListQuery", () => {
  it("同一设备、同一类型、条数不同：是两份缓存", () => {
    const safety = eventsListQuery("helmet_001", { type: TYPE, pageSize: 5 });
    const events = eventsListQuery("helmet_001", { type: TYPE, pageSize: 50 });
    expect(safety.queryKey).not.toEqual(events.queryKey);
  });

  it("参数完全相同：键相同（同一页重渲染不会换缓存）；设备或类型不同：键不同", () => {
    const a = eventsListQuery("helmet_001", { type: TYPE, pageSize: 50 });
    const b = eventsListQuery("helmet_001", { type: TYPE, pageSize: 50 });
    expect(a.queryKey).toEqual(b.queryKey);
    expect(
      eventsListQuery("helmet_002", { type: TYPE, pageSize: 50 }).queryKey,
    ).not.toEqual(a.queryKey);
    expect(
      eventsListQuery("helmet_001", { type: "possible_fall", pageSize: 50 })
        .queryKey,
    ).not.toEqual(a.queryKey);
  });

  it('键以 "events" 开头：实时通道按 ["events"] 前缀失效时两份缓存都会刷新', () => {
    expect(
      eventsListQuery("helmet_001", { type: TYPE, pageSize: 5 }).queryKey[0],
    ).toBe("events");
  });

  it("请求用的就是键里的那组参数（键和请求不会各说各话）", async () => {
    await eventsListQuery("helmet 001", { type: TYPE, pageSize: 5 }).queryFn();
    await eventsListQuery("helmet 001", { type: TYPE, pageSize: 50 }).queryFn();
    const [first, second] = mockApi.mock.calls.map((c) => c[0]);
    expect(first).toBe(
      "/devices/helmet%20001/events?type=collision_risk%2Cobstacle_risk&page=1&pageSize=5",
    );
    expect(second).toBe(
      "/devices/helmet%20001/events?type=collision_risk%2Cobstacle_risk&page=1&pageSize=50",
    );
  });
});

// 下拉刷新 / 第 1 页总数变了时按前缀把整份列表的每一页一起重取（安全记录页，2026-10-17）
describe("eventsListPrefix", () => {
  it("就是第 1 页的键，也是后面每一页键的开头；别的头盔 / 类型 / 页大小不在这个前缀下", () => {
    const prefix = eventsListPrefix("helmet_001", { type: TYPE, pageSize: 50 });
    expect(
      eventsListQuery("helmet_001", { type: TYPE, pageSize: 50 }).queryKey,
    ).toEqual(prefix);
    for (const page of [2, 3, 7]) {
      const key = eventsListQuery("helmet_001", {
        type: TYPE,
        pageSize: 50,
        page,
      }).queryKey;
      expect(key.slice(0, prefix.length)).toEqual([...prefix]);
      expect(key).toHaveLength(prefix.length + 1);
    }
    for (const other of [
      eventsListQuery("helmet_002", { type: TYPE, pageSize: 50, page: 2 }),
      eventsListQuery("helmet_001", { type: TYPE, pageSize: 5, page: 2 }),
      eventsListQuery("helmet_001", { type: "possible_fall", pageSize: 50 }),
    ])
      expect(other.queryKey.slice(0, prefix.length)).not.toEqual([...prefix]);
  });
});
