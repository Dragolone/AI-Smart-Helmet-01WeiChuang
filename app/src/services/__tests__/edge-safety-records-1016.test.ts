// 安全记录合并 / 分页拼接的边界（2026-10-16）：偏移分页在两页刷新之间被新记录挤动时的重复、截断线遇到认不出的时间、
// 总数与条数对不上、错误的取法。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import {
  combinePages,
  mergeRecords,
  type PageResult,
  type RecordSource,
} from "../safety-records";

type Row = { id: string; at: string };
const at = (r: Row) => r.at;
const row = (id: string, hour: number, minute = 0): Row => ({
  id,
  at: new Date(Date.UTC(2026, 9, 16, hour, minute)).toISOString(),
});
const page = (items: Row[], total: number): PageResult<Row> => ({
  data: { items, total },
  isError: false,
  error: null,
});
const src = (
  deviceId: string,
  items: Row[],
  total = items.length,
): RecordSource<Row> => ({
  deviceId,
  data: { items, total },
  isError: false,
  error: null,
});
const ids = (rows: { item: Row }[]) => rows.map((r) => r.item.id);

describe("combinePages：偏移分页被新记录挤动", () => {
  // 第 1 页刷新时多了一条新的，第 2 页还是刷新前取的：r20 两页都有
  const first = page(
    [
      row("new", 23),
      ...Array.from({ length: 19 }, (_, i) => row(`r${i + 1}`, 22, 59 - i)),
    ],
    41,
  );
  const second = page([row("r20", 22, 40), row("r21", 22, 39)], 41);
  const firstStale = page(
    [
      ...Array.from({ length: 19 }, (_, i) => row(`r${i + 1}`, 22, 59 - i)),
      row("r20", 22, 40),
    ],
    40,
  );

  // 原来两页直接拼：r20 出现两次，列表 key 撞车
  it("给了唯一键：去重，留先出现的那条；条数与顺序正确", () => {
    const merged = combinePages(
      "h1",
      {
        ...first,
        data: {
          ...first.data!,
          items: [...first.data!.items, row("r20", 22, 40)],
        },
      },
      [second],
      (r) => r.id,
    );
    expect(merged.data!.items.filter((r) => r.id === "r20")).toHaveLength(1);
    expect(merged.data!.items.map((r) => r.id).slice(-2)).toEqual([
      "r20",
      "r21",
    ]);
  });

  it("第 1 页还是旧的、第 2 页先刷新：同样不重复", () => {
    const secondFresh = page([row("r20", 22, 40), row("r21", 22, 39)], 41);
    const merged = combinePages("h1", firstStale, [secondFresh], (r) => r.id);
    expect(merged.data!.items.filter((r) => r.id === "r20")).toHaveLength(1);
    expect(merged.data!.items).toHaveLength(21);
  });

  it("后面几页之间互相重复也去掉；同一页里的重复（服务端的事）原样保留", () => {
    const p2 = page([row("a", 1), row("b", 2)], 10);
    const p3 = page([row("b", 2), row("c", 3)], 10);
    const merged = combinePages(
      "h1",
      page([row("x", 9), row("x", 9)], 10),
      [p2, p3],
      (r) => r.id,
    );
    expect(merged.data!.items.map((r) => r.id)).toEqual([
      "x",
      "x",
      "a",
      "b",
      "c",
    ]);
  });

  it("不给唯一键：按原来那样直接拼（兼容旧调用）", () => {
    const merged = combinePages("h1", page([row("a", 2)], 2), [
      page([row("a", 2)], 2),
    ]);
    expect(merged.data!.items.map((r) => r.id)).toEqual(["a", "a"]);
  });

  it("总数取第 1 页的；后面某页报的总数不同也不改", () => {
    const merged = combinePages(
      "h1",
      page([row("a", 3)], 5),
      [page([row("b", 2)], 99)],
      (r) => r.id,
    );
    expect(merged.data!.total).toBe(5);
  });

  it("第 1 页失败但手里有旧数据：照常拼，带出第 1 页的错误", () => {
    const err = new Error("first");
    const merged = combinePages(
      "h1",
      { data: { items: [row("a", 3)], total: 2 }, isError: true, error: err },
      [page([row("b", 2)], 2)],
      (r) => r.id,
    );
    expect(merged).toMatchObject({
      isError: true,
      error: err,
      loadingMore: false,
    });
    expect(merged.data!.items).toHaveLength(2);
  });

  it("第 1 页还没到：后面几页拿到了也不显示（不跳着显示）", () => {
    const merged = combinePages(
      "h1",
      { isError: false, error: null },
      [page([row("b", 2)], 2)],
      (r) => r.id,
    );
    expect(merged.data).toBeUndefined();
    expect(merged.loadingMore).toBe(false);
  });
});

describe("页面接线：两种记录都按编号去重（源码不变式）", () => {
  it("风险提醒按 eventId、求救记录按 sosId", () => {
    const s = readFileSync(
      join(__dirname, "..", "..", "app", "safety-records.tsx"),
      "utf8",
    );
    expect(s).toMatch(/\(e: EventListItem\) => e\.eventId,/);
    expect(s).toMatch(/\(a: AccidentListItem\) => a\.sosId,/);
  });
});

describe("mergeRecords：截断线的边", () => {
  it("取了一部分的那顶，最早一条时间认不出（按 0 算）：截断线退到最早，全部显示", () => {
    const merged = mergeRecords(
      [
        src("a", [row("a1", 10), { id: "bad", at: "garbage" }], 5),
        src("b", [row("b1", 8)], 1),
      ],
      at,
    );
    expect(ids(merged.rows)).toEqual(["a1", "b1", "bad"]);
    expect(merged.hasMore).toBe(true);
  });

  it("两顶都只取了一部分：截断线取两者最早一条里更晚的那个，更早的先不显示", () => {
    const merged = mergeRecords(
      [
        src("a", [row("a1", 12), row("a2", 10)], 9),
        src("b", [row("b1", 11), row("b2", 9)], 9),
      ],
      at,
    );
    expect(ids(merged.rows)).toEqual(["a1", "b1", "a2"]);
    expect(merged.total).toBe(18);
  });

  it("某顶头盔条数为 0 但总数不为 0（翻过了头）：不算「还有更早的」", () => {
    const merged = mergeRecords(
      [src("a", [], 3), src("b", [row("b1", 8)], 1)],
      at,
    );
    expect(merged.hasMore).toBe(false);
    expect(ids(merged.rows)).toEqual(["b1"]);
    expect(merged.total).toBe(4);
  });

  it("同一时刻的几条：排序稳定，保持各自在原列表里的先后", () => {
    const t = 10;
    const merged = mergeRecords(
      [src("a", [row("a1", t), row("a2", t)]), src("b", [row("b1", t)])],
      at,
    );
    expect(ids(merged.rows)).toEqual(["a1", "a2", "b1"]);
  });

  it("一顶失败、一顶还在拉、一顶拿到：ready + 不全，错误是失败那顶的", () => {
    const err = new Error("x");
    const merged = mergeRecords(
      [
        { deviceId: "a", isError: true, error: err },
        { deviceId: "b", isError: false, error: null },
        src("c", [row("c1", 1)]),
      ],
      at,
    );
    expect(merged).toMatchObject({
      status: "ready",
      incomplete: true,
      error: err,
    });
    expect(ids(merged.rows)).toEqual(["c1"]);
  });
});
