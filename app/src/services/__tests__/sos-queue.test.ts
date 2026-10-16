// 多顶头盔同时求救的队列（10-16 N10）：从缓存推导、按到期先后排、终态的不算、路由带来的那单也算
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { QueryClient } from "@tanstack/react-query";
import type { Sos } from "@helmet/shared";

import {
  activeSosQueue,
  activeSosStore,
  applyAccountActive,
  MAX_CHIPS,
  nextSos,
  pollAccountActive,
  refreshActiveSos,
  SOS_ACTIVE_ACCOUNT_KEY,
  sosScreen,
} from "../sos-queue";

const sos = (over: Partial<Sos> = {}): Sos => ({
  sosId: "s1",
  deviceId: "d1",
  triggerEventId: "e1",
  triggerType: "possible_fall",
  status: "pending",
  deadline: "2026-10-16T10:01:00.000Z",
  createdAt: "2026-10-16T10:00:00.000Z",
  updatedAt: "2026-10-16T10:00:00.000Z",
  ...over,
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
  sosScreen.mounted = false;
});
// 不清的话每条缓存都挂着 5 分钟的回收定时器，Jest 进程最后要被强杀
afterEach(() => {
  qc.clear();
});

describe("activeSosQueue", () => {
  it("按到期先后排；同时到期按单号；遍历的是缓存里所有 sos-active 条目，不靠设备列表", () => {
    qc.setQueryData(["sos-active", "d3"], {
      sos: sos({
        sosId: "s3",
        deviceId: "d3",
        deadline: "2026-10-16T10:01:00.000Z",
      }),
    });
    qc.setQueryData(["sos-active", "d1"], {
      sos: sos({
        sosId: "s1",
        deviceId: "d1",
        deadline: "2026-10-16T10:00:30.000Z",
      }),
    });
    qc.setQueryData(["sos-active", "d2"], {
      sos: sos({
        sosId: "s2",
        deviceId: "d2",
        deadline: "2026-10-16T10:01:00.000Z",
      }),
    });
    expect(activeSosQueue(qc).map((s) => s.sosId)).toEqual(["s1", "s2", "s3"]);
  });

  it("进行中缓存为空 / 不是 pending / 详情缓存里已是终态（本页刚取消、WS 还没推）：不进队列", () => {
    qc.setQueryData(["sos-active", "d1"], { sos: null });
    qc.setQueryData(["sos-active", "d2"], {
      sos: sos({ sosId: "s2", deviceId: "d2" }),
    });
    qc.setQueryData(
      ["sos", "s2"],
      sos({ sosId: "s2", deviceId: "d2", status: "cancelled" }),
    );
    qc.setQueryData(["sos-active", "d3"], {
      sos: sos({ sosId: "s3", deviceId: "d3", status: "notified" }),
    });
    expect(activeSosQueue(qc)).toEqual([]);
  });

  it("路由带来的那单（它的头盔不在缓存里）也算；和缓存里同一单不重复", () => {
    const extra = sos({
      sosId: "s9",
      deviceId: "d9",
      deadline: "2026-10-16T10:00:10.000Z",
    });
    qc.setQueryData(["sos-active", "d1"], { sos: sos() });
    expect(activeSosQueue(qc, extra).map((s) => s.sosId)).toEqual(["s9", "s1"]);
    qc.setQueryData(["sos-active", "d9"], { sos: extra });
    expect(activeSosQueue(qc, extra).map((s) => s.sosId)).toEqual(["s9", "s1"]);
    expect(activeSosQueue(qc, null).map((s) => s.sosId)).toEqual(["s9", "s1"]);
  });

  it("同一顶头盔两单（旧单本机没收到终态）：只留晚建的那单，不管哪份在缓存、哪份是路由带来的（10-16 评审：两单都留会让倒计时页渲染死循环）", () => {
    const old = sos({ sosId: "s1", createdAt: "2026-10-16T10:00:00.000Z" });
    const newer = sos({
      sosId: "s9",
      createdAt: "2026-10-16T10:00:20.000Z",
      deadline: "2026-10-16T10:01:20.000Z",
    });
    qc.setQueryData(["sos-active", "d1"], { sos: newer });
    expect(activeSosQueue(qc, old).map((s) => s.sosId)).toEqual(["s9"]);
    qc.setQueryData(["sos-active", "d1"], { sos: old });
    expect(activeSosQueue(qc, newer).map((s) => s.sosId)).toEqual(["s9"]);
    // 别的头盔不受影响
    qc.setQueryData(["sos-active", "d2"], {
      sos: sos({ sosId: "s2", deviceId: "d2" }),
    });
    expect(activeSosQueue(qc, newer).map((s) => s.sosId)).toEqual(["s2", "s9"]);
  });

  it("同一单缓存一份、路由带来一份：用路由那份（页面手上的是详情缓存里的对象，较新）", () => {
    qc.setQueryData(["sos-active", "d1"], { sos: sos() });
    const fromPage = sos({ updatedAt: "2026-10-16T10:00:05.000Z" });
    expect(activeSosQueue(qc, fromPage)[0]).toBe(fromPage);
  });

  it("一万顶同时报警：队列照样算得出来（页面只画前 20 个胶囊）", () => {
    for (let i = 0; i < 10_000; i += 1) {
      qc.setQueryData(["sos-active", `d${i}`], {
        sos: sos({
          sosId: `s${String(i).padStart(5, "0")}`,
          deviceId: `d${i}`,
          deadline: new Date(
            Date.UTC(2026, 9, 16, 10, 0, 0) + (i % 60) * 1000,
          ).toISOString(),
        }),
      });
    }
    const q = activeSosQueue(qc);
    expect(q).toHaveLength(10_000);
    expect(q[0].sosId).toBe("s00000");
    expect(q[1].sosId).toBe("s00060");
    expect(MAX_CHIPS).toBe(20);
  });
});

describe("nextSos", () => {
  it("当前这单之后看最早到期的那一单；只剩自己时没有下一单", () => {
    const q = [sos({ sosId: "a" }), sos({ sosId: "b" }), sos({ sosId: "c" })];
    expect(nextSos(q, "a")?.sosId).toBe("b");
    expect(nextSos(q, "b")?.sosId).toBe("a");
    expect(nextSos([sos({ sosId: "a" })], "a")).toBeNull();
    expect(nextSos([], "a")).toBeNull();
  });
});

describe("applyAccountActive（账号级列表写回按头盔的缓存，B 线第 12 项）", () => {
  const T0 = Date.parse("2026-10-16T10:00:10.000Z");
  const active = (id: string) =>
    qc.getQueryData<{ sos: Sos | null }>(["sos-active", id])?.sos ?? null;

  it("列表里的单写进各自头盔；设备列表里有、列表里没有的写 null；缓存里有过、这回没有的也清掉", () => {
    qc.setQueryData(["sos-active", "old"], {
      sos: sos({ sosId: "s0", deviceId: "old" }),
    });
    applyAccountActive(
      qc,
      { items: [sos({ sosId: "s1", deviceId: "d1" })], total: 1 },
      ["d1", "d2"],
      Date.now() + 1,
    );
    expect(active("d1")?.sosId).toBe("s1");
    expect(qc.getQueryData(["sos-active", "d2"])).toEqual({ sos: null });
    expect(active("old")).toBeNull();
  });

  it("在途守卫：请求发出后 WS 写过的头盔以缓存为准，迟到的「没有」不把刚推来的单冲掉（#213 同一问题）", () => {
    const startedAt = Date.now();
    qc.setQueryData(["sos-active", "d2"], {
      sos: sos({ sosId: "s2", deviceId: "d2" }),
    });
    applyAccountActive(qc, { items: [], total: 0 }, ["d2"], startedAt);
    expect(active("d2")?.sosId).toBe("s2");
  });

  it("终态守卫：本机已知结束的单（倒计时页刚取消）不回潮", () => {
    qc.setQueryData(["sos", "s1"], sos({ status: "cancelled" }));
    applyAccountActive(qc, { items: [sos()], total: 1 }, ["d1"], T0);
    expect(active("d1")).toBeNull();
  });

  it("列表不全（total 多于这一页）：没出现在列表里的头盔不清，它们可能在下一页", () => {
    qc.setQueryData(["sos-active", "d2"], {
      sos: sos({ sosId: "s2", deviceId: "d2" }),
    });
    applyAccountActive(
      qc,
      { items: [sos({ sosId: "s1", deviceId: "d1" })], total: 150 },
      ["d1", "d2"],
      Date.now() + 1,
    );
    expect(active("d1")?.sosId).toBe("s1");
    expect(active("d2")?.sosId).toBe("s2");
  });

  it("没变就不写（不产生缓存更新、不顶 dataUpdatedAt）", () => {
    const s1 = sos();
    qc.setQueryData(["sos-active", "d1"], { sos: s1 });
    const before = qc.getQueryState(["sos-active", "d1"])?.dataUpdatedAt;
    applyAccountActive(
      qc,
      { items: [{ ...s1 }], total: 1 },
      ["d1"],
      (before ?? 0) + 1,
    );
    expect(qc.getQueryState(["sos-active", "d1"])?.dataUpdatedAt).toBe(before);
  });

  it("pollAccountActive：拉一次、按发请求那一刻做在途判断、返回总数", async () => {
    const fetch = jest.fn(async () => ({
      items: [sos({ sosId: "s1", deviceId: "d1" })],
      total: 1,
    }));
    await expect(pollAccountActive(qc, ["d1"], fetch)).resolves.toBe(1);
    expect(active("d1")?.sosId).toBe("s1");
  });
});

describe("activeSosStore（useSyncExternalStore 用）", () => {
  it("缓存里 sos-active / sos 更新就通知；内容没变时快照还是同一个数组", () => {
    const store = activeSosStore(qc);
    const onChange = jest.fn();
    const off = store.subscribe(onChange);
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);
    qc.setQueryData(["sos-active", "d1"], { sos: sos() });
    expect(onChange).toHaveBeenCalled();
    const one = store.getSnapshot();
    expect(one.map((s) => s.sosId)).toEqual(["s1"]);
    expect(store.getSnapshot()).toBe(one);
    qc.setQueryData(["sos", "s1"], sos({ status: "notified" }));
    expect(store.getSnapshot()).toEqual([]);
    off();
  });
});

describe("refreshActiveSos", () => {
  it("按头盔的缓存和账号级轮询一起失效", async () => {
    const spy = jest.spyOn(qc, "invalidateQueries");
    await refreshActiveSos(qc);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { queryKey: ["sos-active"] },
      { queryKey: SOS_ACTIVE_ACCOUNT_KEY },
    ]);
  });
});
