// 多顶头盔同时求救的队列（10-16 N10）：从缓存推导、按到期先后排、终态的不算、路由带来的那单也算
import { beforeEach, describe, expect, it } from "@jest/globals";
import { QueryClient } from "@tanstack/react-query";
import type { Sos } from "@helmet/shared";

import { activeSosQueue, MAX_CHIPS, nextSos, sosScreen } from "../sos-queue";

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
    expect(activeSosQueue(qc, newer).map((s) => s.sosId)).toEqual([
      "s2",
      "s9",
    ]);
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
