// 边界补测（2026-10-03）：SOS 实时同步在乱序 / 重复 / 畸形响应下的表现。
// sos-sync.test.ts 钉的是 09-24 三个真机缺陷的主路径；这里补消息顺序与服务端响应不守规矩的情况。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClient } from "@tanstack/react-query";
import type { ActiveSosResponse, Sos } from "@helmet/shared";

import {
  alertPendingOnBackground,
  applySosUpdate,
  onReconnect,
  resumePendingSos,
  type PresentedRef,
  type SosSyncDeps,
} from "../sos-sync";

const sos = (over: Partial<Sos> = {}): Sos => ({
  sosId: "s1",
  deviceId: "d1",
  triggerEventId: "e1",
  triggerType: "possible_fall",
  status: "pending",
  deadline: "2026-10-03T10:01:00.000Z",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
  ...over,
});

let qc: QueryClient;
let presented: PresentedRef;
let deps: {
  [K in keyof SosSyncDeps]-?: jest.Mock<NonNullable<SosSyncDeps[K]>>;
};
const active = (deviceId: string) =>
  qc.getQueryData<ActiveSosResponse>(["sos-active", deviceId])?.sos;

beforeEach(() => {
  qc = new QueryClient();
  presented = { current: new Set<string>() };
  deps = {
    fetchActive: jest.fn<SosSyncDeps["fetchActive"]>(async () => ({
      sos: null,
    })),
    openCountdown: jest.fn<SosSyncDeps["openCountdown"]>(),
    showLockScreenAlert: jest.fn<SosSyncDeps["showLockScreenAlert"]>(),
    clearLockScreenAlert: jest.fn<SosSyncDeps["clearLockScreenAlert"]>(),
    log: jest.fn<NonNullable<SosSyncDeps["log"]>>(),
  };
});
afterEach(() => {
  qc.clear();
});

describe("applySosUpdate：重复与乱序", () => {
  it("终态重复推（取消后服务端又推一次 cancelled / 两台手机各收一份）：幂等，不拉页、不重新报警", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    expect(deps.openCountdown).toHaveBeenCalledTimes(1);
    expect(deps.showLockScreenAlert).toHaveBeenCalledTimes(1);
    expect(deps.clearLockScreenAlert).toHaveBeenCalledTimes(2);
    expect(active("d1")).toBeNull();
  });

  it("这单从没在本机弹过（倒计时期间 App 没开），只收到终态：只撤通知，不拉倒计时页", () => {
    applySosUpdate(qc, sos({ status: "notified" }), presented, deps);
    expect(deps.openCountdown).not.toHaveBeenCalled();
    expect(deps.showLockScreenAlert).not.toHaveBeenCalled();
    expect(deps.clearLockScreenAlert).toHaveBeenCalledWith("s1");
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("notified");
    expect(presented.current.size).toBe(0);
  });

  it("已弹过页的单，终态之后又来一条迟到的 pending：不再拉页、不再弹锁屏通知", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    deps.openCountdown.mockClear();
    deps.showLockScreenAlert.mockClear();
    applySosUpdate(qc, sos(), presented, deps);
    expect(deps.openCountdown).not.toHaveBeenCalled();
    expect(deps.showLockScreenAlert).not.toHaveBeenCalled();
  });

  it("两台设备的缓存互不干扰：d2 的单结束不会清掉 d1 进行中的单", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ sosId: "s2", deviceId: "d2" }), presented, deps);
    applySosUpdate(
      qc,
      sos({ sosId: "s2", deviceId: "d2", status: "cancelled" }),
      presented,
      deps,
    );
    expect(active("d1")?.sosId).toBe("s1");
    expect(active("d2")).toBeNull();
    expect(deps.clearLockScreenAlert).toHaveBeenCalledTimes(1);
    expect(deps.clearLockScreenAlert).toHaveBeenCalledWith("s2");
  });

  it("同一台设备上一单已通知、紧接着新的一单：进行中缓存指向新单，旧单详情仍是终态", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "notified" }), presented, deps);
    applySosUpdate(
      qc,
      sos({ sosId: "s2", deadline: "2026-10-03T10:05:00.000Z" }),
      presented,
      deps,
    );
    expect(active("d1")?.sosId).toBe("s2");
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("notified");
    expect(deps.showLockScreenAlert).toHaveBeenLastCalledWith(
      "s2",
      "d1",
      "2026-10-03T10:05:00.000Z",
    );
  });
});

describe("resumePendingSos：空列表与畸形响应", () => {
  it("还没绑定任何设备：不发请求，返回空", async () => {
    expect(await resumePendingSos(qc, [], presented, deps)).toEqual([]);
    expect(deps.fetchActive).not.toHaveBeenCalled();
  });

  it.each([
    ["空对象", {}],
    ["null", null],
    ["sos 字段是 undefined", { sos: undefined }],
  ])(
    "服务端回了%s：当作没有进行中的单，不抛、不影响后面的设备",
    async (_label, body) => {
      deps.fetchActive
        .mockResolvedValueOnce(body as unknown as ActiveSosResponse)
        .mockResolvedValueOnce({ sos: sos({ sosId: "s2", deviceId: "d2" }) });
      expect(await resumePendingSos(qc, ["d1", "d2"], presented, deps)).toEqual(
        ["s2"],
      );
      expect(active("d1")).toBeUndefined();
    },
  );

  it("按设备列表顺序逐台查，找回顺序与列表一致；缓存与通知用的是列表里的 deviceId", async () => {
    deps.fetchActive.mockImplementation(async (id) => ({
      sos: id === "d2" ? null : sos({ sosId: `s-${id}`, deviceId: id }),
    }));
    expect(
      await resumePendingSos(qc, ["d3", "d2", "d1"], presented, deps),
    ).toEqual(["s-d3", "s-d1"]);
    expect(deps.fetchActive.mock.calls.map((c) => c[0])).toEqual([
      "d3",
      "d2",
      "d1",
    ]);
    expect(deps.showLockScreenAlert.mock.calls.map((c) => c[1])).toEqual([
      "d3",
      "d1",
    ]);
  });

  it("补拉在路上时这单被确认（notified）：与 cancelled 同样不被迟到的 pending 盖回去", async () => {
    let release!: (v: ActiveSosResponse) => void;
    deps.fetchActive.mockReturnValueOnce(new Promise((r) => (release = r)));
    const pending = resumePendingSos(qc, ["d1"], presented, deps);
    applySosUpdate(qc, sos({ status: "notified" }), presented, deps);
    release({ sos: sos() });
    expect(await pending).toEqual([]);
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("notified");
    expect(active("d1")).toBeNull();
    expect(deps.openCountdown).not.toHaveBeenCalled();
  });
});

describe("alertPendingOnBackground：缓存两份不一致时以终态为准", () => {
  it("REST 轮询把过期的 pending 写回了「进行中」缓存，但这单的详情缓存已是终态：不补弹", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    // 模拟安全页的常规轮询拿到取消前的快照
    qc.setQueryData<ActiveSosResponse>(["sos-active", "d1"], { sos: sos() });
    deps.showLockScreenAlert.mockClear();
    expect(alertPendingOnBackground(qc, "background", ["d1"], deps)).toBe(0);
    expect(deps.showLockScreenAlert).not.toHaveBeenCalled();
  });

  it("只有「进行中」缓存、还没有详情缓存（轮询先于 WS 拿到）：照常补弹", () => {
    qc.setQueryData<ActiveSosResponse>(["sos-active", "d1"], { sos: sos() });
    expect(alertPendingOnBackground(qc, "background", ["d1"], deps)).toBe(1);
  });

  it.each(["unknown", "extension", "", "BACKGROUND"])(
    "appState=%j 不是严格的 background：不补弹",
    (state) => {
      applySosUpdate(qc, sos(), presented, deps);
      deps.showLockScreenAlert.mockClear();
      expect(alertPendingOnBackground(qc, state, ["d1"], deps)).toBe(0);
    },
  );
});

describe("onReconnect：连接抖动", () => {
  it("连续多次 false（退避重连一直失败）不触发；每次恢复只触发一次", () => {
    const trigger = jest.fn();
    const listener = onReconnect(trigger);
    listener(true);
    for (let i = 0; i < 5; i += 1) listener(false);
    expect(trigger).not.toHaveBeenCalled();
    listener(true);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("两个监听各自记账：一个已连过不影响另一个的「首次连接不触发」", () => {
    const t1 = jest.fn();
    const t2 = jest.fn();
    const l1 = onReconnect(t1);
    l1(true);
    l1(false);
    const l2 = onReconnect(t2);
    l1(true);
    l2(true);
    expect(t1).toHaveBeenCalledTimes(1);
    expect(t2).not.toHaveBeenCalled();
  });
});
