// 跨头盔合并的列表用什么当 key（2026-10-16 第二轮边界测试）。
// 决策 #54 之后 eventId 只在一顶头盔内唯一：服务端按 (deviceId, eventId) 幂等，两顶头盔可以各有一条同号事件
// （4G / Mock 设备自己生成编号，固件按序号起名时尤其容易撞）。安全记录「全部头盔」原来拿 eventId 当 key、
// 点开详情也只记 eventId，两行同号时 React 复用错行、详情可能是另一顶头盔的。
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "@jest/globals";

import {
  combinePages,
  detailBelongsTo,
  mergeRecords,
  recordKeyOf,
} from "../safety-records";

type Ev = { eventId: string; timestamp: string };
const ev = (eventId: string, minute: number): Ev => ({
  eventId,
  timestamp: new Date(Date.UTC(2026, 9, 16, 8, minute)).toISOString(),
});
const source = (deviceId: string, items: Ev[]) => ({
  deviceId,
  data: { items, total: items.length },
  isError: false,
  error: null,
});

describe("recordKeyOf：带上头盔号", () => {
  it("同一个 eventId 在两顶头盔上得到不同的键", () => {
    expect(recordKeyOf("helmet_a", "evt-1")).not.toBe(
      recordKeyOf("helmet_b", "evt-1"),
    );
  });

  it("写法固定为「头盔号:编号」", () => {
    expect(recordKeyOf("helmet_a", "evt-1")).toBe("helmet_a:evt-1");
  });

  it("头盔号只含字母数字 / 下划线 / 横线，冒号分隔不会把两组拼成同一个键", () => {
    expect(recordKeyOf("a", "b:c")).toBe("a:b:c");
    // 头盔号里不会有冒号（服务端 [A-Za-z0-9_-]），所以 ("a:b", "c") 这种组合不存在
    expect(/^[A-Za-z0-9_-]+$/.test("helmet_night-01")).toBe(true);
  });
});

describe("「全部头盔」合并后的 key 唯一", () => {
  const merged = mergeRecords(
    [
      source("helmet_a", [ev("evt-1", 30), ev("evt-2", 10)]),
      source("helmet_b", [ev("evt-1", 20)]),
    ],
    (e) => e.timestamp,
  );

  it("两顶头盔各有一条 evt-1：只用 eventId 当键会撞（旧写法的问题）", () => {
    const old = merged.rows.map((r) => r.item.eventId);
    expect(new Set(old).size).toBeLessThan(old.length);
  });

  it("用 recordKeyOf 后每行的键都不同", () => {
    const keys = merged.rows.map((r) =>
      recordKeyOf(r.deviceId, r.item.eventId),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "helmet_a:evt-1",
      "helmet_b:evt-1",
      "helmet_a:evt-2",
    ]);
  });

  it("两条同号事件都还在（合并不按 eventId 去重，不会丢掉另一顶头盔的那条）", () => {
    expect(merged.rows.filter((r) => r.item.eventId === "evt-1")).toHaveLength(
      2,
    );
  });
});

describe("combinePages 按 eventId 去重只在一顶头盔内部：分页挤出的重复去掉，不碰别的头盔", () => {
  it("同一顶头盔第 1、2 页都有 evt-3（两次刷新之间来了新记录）：留一条", () => {
    const page = (items: Ev[], total: number) => ({
      data: { items, total },
      isError: false,
      error: null,
    });
    const out = combinePages(
      "helmet_a",
      page([ev("evt-5", 50), ev("evt-4", 40), ev("evt-3", 30)], 6),
      [page([ev("evt-3", 30), ev("evt-2", 20), ev("evt-1", 10)], 6)],
      (e) => e.eventId,
    );
    expect(out.data?.items.map((e) => e.eventId)).toEqual([
      "evt-5",
      "evt-4",
      "evt-3",
      "evt-2",
      "evt-1",
    ]);
  });
});

describe("detailBelongsTo：详情接口拿回来的是不是点的那一顶的", () => {
  it("头盔号一致才算", () => {
    expect(
      detailBelongsTo({ deviceId: "helmet_a" }, { deviceId: "helmet_a" }),
    ).toBe(true);
    expect(
      detailBelongsTo({ deviceId: "helmet_b" }, { deviceId: "helmet_a" }),
    ).toBe(false);
  });

  it("详情还没回来 / 弹层已关：都不算", () => {
    expect(detailBelongsTo(undefined, { deviceId: "helmet_a" })).toBe(false);
    expect(detailBelongsTo(null, { deviceId: "helmet_a" })).toBe(false);
    expect(detailBelongsTo({ deviceId: "helmet_a" }, null)).toBe(false);
  });
});

describe("安全记录页接线", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "app", "safety-records.tsx"),
    "utf8",
  );

  it("风险提醒行的 key 用 recordKeyOf(deviceId, eventId)，不再是 eventId", () => {
    expect(src).toContain("key={recordKeyOf(deviceId, e.eventId)}");
    expect(src).not.toContain("key={e.eventId}");
  });

  it("点开详情记的是「哪一顶的哪一条」，缓存键也带头盔号", () => {
    expect(src).toContain("setDetailOf({ deviceId, eventId: e.eventId })");
    expect(src).toContain(
      'queryKey: ["event-detail", detailOf?.deviceId, detailOf?.eventId]',
    );
    expect(src).not.toMatch(/\bdetailId\b/);
  });

  it("拿回来的详情不是这一顶的：不显示它，写「打不开」", () => {
    expect(src).toContain("detailBelongsTo(detail.data, detailOf)");
    expect(src).toContain('t("records.detail.mismatch")');
  });
});
