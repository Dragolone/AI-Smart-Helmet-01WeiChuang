// 安全记录页把几顶头盔的列表合成一份：按时间排、带上是哪一顶、没拿到的不当成「没有」。
import { describe, expect, it } from "@jest/globals";

import { mergeRecords, type RecordSource } from "../safety-records";

type Row = { id: string; at: string };
const at = (r: Row) => r.at;
const ok = (
  deviceId: string,
  items: Row[],
  total = items.length,
): RecordSource<Row> => ({
  deviceId,
  data: { items, total },
  isError: false,
  error: null,
});
const loading = (deviceId: string): RecordSource<Row> => ({
  deviceId,
  isError: false,
  error: null,
});
const failed = (deviceId: string): RecordSource<Row> => ({
  deviceId,
  isError: true,
  error: new Error("boom"),
});

describe("mergeRecords", () => {
  it("几顶头盔的记录按时间合成一份（最新在前），每条带上是哪一顶", () => {
    const m = mergeRecords(
      [
        ok("a", [
          { id: "a2", at: "2026-10-07T08:36:00Z" },
          { id: "a1", at: "2026-10-04T14:44:00Z" },
        ]),
        ok("b", [{ id: "b1", at: "2026-10-06T18:12:00Z" }]),
      ],
      at,
    );
    expect(m.status).toBe("ready");
    expect(m.rows.map((r) => `${r.deviceId}:${r.item.id}`)).toEqual([
      "a:a2",
      "b:b1",
      "a:a1",
    ]);
    expect(m.incomplete).toBe(false);
    expect(m.error).toBeNull();
  });

  it("总条数是各顶之和：比显示的多时页面要说明只显示了最近的一部分", () => {
    const m = mergeRecords(
      [
        ok("a", [{ id: "a1", at: "2026-10-07T08:00:00Z" }], 120),
        ok("b", [{ id: "b1", at: "2026-10-06T08:00:00Z" }], 3),
      ],
      at,
    );
    expect(m.total).toBe(123);
    expect(m.rows).toHaveLength(2);
  });

  it("一份都还没拿到：加载中；其中有失败的：加载失败", () => {
    expect(mergeRecords([loading("a"), loading("b")], at).status).toBe(
      "loading",
    );
    const m = mergeRecords([loading("a"), failed("b")], at);
    expect(m.status).toBe("failed");
    expect(m.error).toBeInstanceOf(Error);
  });

  it("拿到一部分：先显示拿到的，并标明还不全——空的时候不能说成「暂无记录」", () => {
    const partial = mergeRecords([ok("a", []), failed("b")], at);
    expect(partial.status).toBe("ready");
    expect(partial.rows).toEqual([]);
    expect(partial.incomplete).toBe(true);
    expect(partial.error).toBeInstanceOf(Error);

    const waiting = mergeRecords([ok("a", []), loading("b")], at);
    expect(waiting.incomplete).toBe(true);
    expect(waiting.error).toBeNull();
  });

  it("全部拿到且都是空的：才是真的没有", () => {
    const m = mergeRecords([ok("a", []), ok("b", [])], at);
    expect(m).toMatchObject({ status: "ready", rows: [], incomplete: false });
  });

  it("刷新失败但手里还有上次的数据：照常显示，另带失败原因", () => {
    const stale: RecordSource<Row> = {
      ...ok("a", [{ id: "a1", at: "2026-10-07T08:00:00Z" }]),
      isError: true,
      error: new Error("offline"),
    };
    const m = mergeRecords([stale], at);
    expect(m.status).toBe("ready");
    expect(m.rows).toHaveLength(1);
    expect(m.incomplete).toBe(false);
    expect(m.error).toBeInstanceOf(Error);
  });

  it("认不出时间的记录排到最后，不丢", () => {
    const m = mergeRecords(
      [
        ok("a", [
          { id: "bad", at: "not-a-date" },
          { id: "good", at: "2026-10-07T08:00:00Z" },
        ]),
      ],
      at,
    );
    expect(m.rows.map((r) => r.item.id)).toEqual(["good", "bad"]);
  });

  it("一顶头盔都没有：没有要等的东西", () => {
    expect(mergeRecords([], at)).toMatchObject({
      status: "loading",
      incomplete: false,
    });
  });
});
