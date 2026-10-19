// SOS 实时同步：钉住 09-24 真机日暴露的三个缺陷的修复（SOS-12 / SOS-13 / APP-03）与三条不变式。
// 用真 QueryClient，副作用全部是 jest.fn——不渲染组件（本仓库 jest 渲染不了带 hooks 的屏幕）。
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
  COUNTDOWN_POLL_MS,
  countdownPollInterval,
  onReconnect,
  resumePendingSos,
  settleSnapshot,
  type PresentedRef,
  type SosSyncDeps,
} from "../sos-sync";

const sos = (over: Partial<Sos> = {}): Sos => ({
  sosId: "s1",
  deviceId: "d1",
  triggerEventId: "e1",
  triggerType: "possible_fall",
  status: "pending",
  deadline: "2026-09-26T10:00:60.000Z",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
  ...over,
});

let qc: QueryClient;
let presented: PresentedRef;
let deps: {
  [K in keyof SosSyncDeps]-?: jest.Mock<NonNullable<SosSyncDeps[K]>>;
};

beforeEach(() => {
  qc = new QueryClient();
  presented = { current: new Set<string>() };
  deps = {
    fetchActive: jest.fn<SosSyncDeps["fetchActive"]>(async () => ({
      sos: null,
    })),
    // null = 服务端没有账号级接口：这里的用例测的是逐台查那条路（账号级的用例见 sos-sync.test 末尾）
    fetchAccountActive: jest.fn<NonNullable<SosSyncDeps["fetchAccountActive"]>>(
      async () => null,
    ),
    openCountdown: jest.fn<SosSyncDeps["openCountdown"]>(),
    showLockScreenAlert: jest.fn<SosSyncDeps["showLockScreenAlert"]>(),
    clearLockScreenAlert: jest.fn<SosSyncDeps["clearLockScreenAlert"]>(),
    log: jest.fn<NonNullable<SosSyncDeps["log"]>>(),
  };
});
afterEach(() => {
  qc.clear();
});

describe("applySosUpdate（WS sos_update）", () => {
  it("pending：写两份缓存、拉起倒计时页、弹锁屏通知（后台时由 sos-alert 决定是否真弹）", () => {
    applySosUpdate(qc, sos(), presented, deps);
    expect(
      qc.getQueryData<ActiveSosResponse>(["sos-active", "d1"])?.sos?.sosId,
    ).toBe("s1");
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("pending");
    expect(deps.openCountdown).toHaveBeenCalledWith("s1", "d1");
    expect(deps.showLockScreenAlert).toHaveBeenCalledWith(
      "s1",
      "d1",
      sos().deadline,
      undefined, // triggeredAt：测试样本没带；带了要原样透传（见下）
    );
  });

  it("triggeredAt（补传旧事件的事件时间）原样透传给锁屏通知，由它决定要不要点明「刚补传到」", () => {
    applySosUpdate(
      qc,
      sos({ triggeredAt: "2026-10-06T22:00:00.000Z" }),
      presented,
      deps,
    );
    expect(deps.showLockScreenAlert).toHaveBeenCalledWith(
      "s1",
      "d1",
      sos().deadline,
      "2026-10-06T22:00:00.000Z",
    );
  });

  it("同一单重复推 pending（重连补发 / 两台设备）：只拉起一次倒计时页", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos(), presented, deps);
    expect(deps.openCountdown).toHaveBeenCalledTimes(1);
  });

  it("终态：清掉进行中缓存、撤锁屏通知，不再拉起页面", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    expect(
      qc.getQueryData<ActiveSosResponse>(["sos-active", "d1"])?.sos,
    ).toBeNull();
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("cancelled");
    expect(deps.clearLockScreenAlert).toHaveBeenCalledWith("s1");
    expect(deps.openCountdown).toHaveBeenCalledTimes(1);
  });

  it("新的一单（上一单结束后又摔）照常拉起", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "notified" }), presented, deps);
    applySosUpdate(qc, sos({ sosId: "s2" }), presented, deps);
    expect(deps.openCountdown).toHaveBeenLastCalledWith("s2", "d1");
  });
});

describe("10-03 评审疑点 1 / 3：多设备并发与乱序", () => {
  it("两台头盔同时有进行中的单：各拉起一次；之后每次重连补拉都不再重弹", async () => {
    const a = sos({ sosId: "sA", deviceId: "dA" });
    const b = sos({ sosId: "sB", deviceId: "dB" });
    deps.fetchActive.mockImplementation(async (id) => ({
      sos: id === "dA" ? a : b,
    }));
    await resumePendingSos(qc, ["dA", "dB"], presented, deps);
    expect(deps.openCountdown).toHaveBeenCalledTimes(2);
    // 重连三次：只记「最近一单」时，这里每次都会把两页来回重弹
    for (let i = 0; i < 3; i++) {
      await resumePendingSos(qc, ["dA", "dB"], presented, deps, "重连补拉");
    }
    expect(deps.openCountdown).toHaveBeenCalledTimes(2);
  });

  it("WS 乱序：cancelled 之后又来一条迟到的 pending → 忽略，不回退、不重弹、不再排通知", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    deps.showLockScreenAlert.mockClear();
    deps.openCountdown.mockClear();
    applySosUpdate(qc, sos(), presented, deps); // 迟到的 pending
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("cancelled");
    expect(
      qc.getQueryData<ActiveSosResponse>(["sos-active", "d1"])?.sos,
    ).toBeNull();
    expect(deps.showLockScreenAlert).not.toHaveBeenCalled();
    expect(deps.openCountdown).not.toHaveBeenCalled();
  });

  it("notified 之后迟到的 pending 同样忽略；但同设备的新一单照常处理", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "notified" }), presented, deps);
    applySosUpdate(qc, sos(), presented, deps);
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("notified");
    applySosUpdate(qc, sos({ sosId: "s2" }), presented, deps);
    expect(
      qc.getQueryData<ActiveSosResponse>(["sos-active", "d1"])?.sos?.sosId,
    ).toBe("s2");
  });
});

describe("resumePendingSos（冷启动 / 重连补拉，SOS-12）", () => {
  it("找回断线期间创建的单：写缓存、弹锁屏通知、拉起倒计时页", async () => {
    deps.fetchActive.mockResolvedValueOnce({ sos: sos() });
    expect(
      await resumePendingSos(qc, ["d1"], presented, deps, "重连补拉"),
    ).toEqual(["s1"]);
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("pending");
    expect(deps.showLockScreenAlert).toHaveBeenCalledWith(
      "s1",
      "d1",
      sos().deadline,
      undefined, // triggeredAt：测试样本没带；带了要原样透传（见下）
    );
    expect(deps.openCountdown).toHaveBeenCalledWith("s1", "d1");
    expect(deps.log).toHaveBeenCalledWith("重连补拉发现进行中 SOS s1");
  });

  it("APP-03 同源：REST 在路上时 WS 已推来 cancelled，迟到的 pending 不覆盖、不弹通知、不拉页", async () => {
    let release!: (v: ActiveSosResponse) => void;
    deps.fetchActive.mockReturnValueOnce(new Promise((r) => (release = r)));
    const pending = resumePendingSos(qc, ["d1"], presented, deps);
    // REST 还没回来，WS 先到了终态
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    release({ sos: sos() }); // 迟到的 pending（服务端取消前的快照）
    expect(await pending).toEqual([]);
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("cancelled");
    expect(
      qc.getQueryData<ActiveSosResponse>(["sos-active", "d1"])?.sos,
    ).toBeNull();
    expect(deps.showLockScreenAlert).not.toHaveBeenCalled();
    expect(deps.openCountdown).not.toHaveBeenCalled();
  });

  it("已经拉起过的单：补拉仍会确保锁屏通知（sos-alert 自己去重），但不重复拉页", async () => {
    applySosUpdate(qc, sos(), presented, deps);
    deps.fetchActive.mockResolvedValueOnce({ sos: sos() });
    await resumePendingSos(qc, ["d1"], presented, deps);
    expect(deps.openCountdown).toHaveBeenCalledTimes(1);
    expect(deps.showLockScreenAlert).toHaveBeenCalledTimes(2);
  });

  it("一台设备网络失败不影响另一台", async () => {
    deps.fetchActive
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ sos: sos({ sosId: "s2", deviceId: "d2" }) });
    expect(await resumePendingSos(qc, ["d1", "d2"], presented, deps)).toEqual([
      "s2",
    ]);
  });

  it("没有进行中的单 / 返回的是终态：什么都不做", async () => {
    deps.fetchActive
      .mockResolvedValueOnce({ sos: null })
      .mockResolvedValueOnce({ sos: sos({ status: "notified" }) });
    expect(await resumePendingSos(qc, ["d1", "d2"], presented, deps)).toEqual(
      [],
    );
    expect(deps.showLockScreenAlert).not.toHaveBeenCalled();
  });
});

describe("alertPendingOnBackground（离开前台补弹，SOS-13）", () => {
  it("SOS 比锁屏早到一秒：倒计时页已在前台弹出，随后锁屏（background）→ 补弹锁屏通知", () => {
    applySosUpdate(qc, sos(), presented, deps);
    deps.showLockScreenAlert.mockClear();
    expect(alertPendingOnBackground(qc, "background", ["d1"], deps)).toBe(1);
    expect(deps.showLockScreenAlert).toHaveBeenCalledWith(
      "s1",
      "d1",
      sos().deadline,
      undefined, // triggeredAt：测试样本没带；带了要原样透传（见下）
    );
  });

  it("inactive（系统 Alert / 控制中心 / 来电）：倒计时页还在屏上，不补弹，避免双重报警", () => {
    applySosUpdate(qc, sos(), presented, deps);
    deps.showLockScreenAlert.mockClear();
    expect(alertPendingOnBackground(qc, "inactive", ["d1"], deps)).toBe(0);
    expect(alertPendingOnBackground(qc, "active", ["d1"], deps)).toBe(0);
    expect(deps.showLockScreenAlert).not.toHaveBeenCalled();
  });

  it("单子已结束 / 没有单：不弹", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ status: "cancelled" }), presented, deps);
    deps.showLockScreenAlert.mockClear();
    expect(alertPendingOnBackground(qc, "background", ["d1", "d9"], deps)).toBe(
      0,
    );
  });

  it("多台设备各有进行中的单：逐台补弹", () => {
    applySosUpdate(qc, sos(), presented, deps);
    applySosUpdate(qc, sos({ sosId: "s2", deviceId: "d2" }), presented, deps);
    deps.showLockScreenAlert.mockClear();
    expect(alertPendingOnBackground(qc, "background", ["d1", "d2"], deps)).toBe(
      2,
    );
  });
});

describe("onReconnect（WS 由断转连才补拉）", () => {
  it("订阅回放的第一次 connected 不触发；断开再连上才触发；断开本身不触发", () => {
    const trigger = jest.fn();
    const listener = onReconnect(trigger);
    listener(true); // 订阅时回放：启动连接，冷启动补拉已覆盖
    expect(trigger).not.toHaveBeenCalled();
    listener(false);
    expect(trigger).not.toHaveBeenCalled();
    listener(true);
    expect(trigger).toHaveBeenCalledTimes(1);
    listener(false);
    listener(true);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("启动时还没连上（回放 false）：第一次真正连上不触发（冷启动补拉负责）", () => {
    const trigger = jest.fn();
    const listener = onReconnect(trigger);
    listener(false);
    listener(true);
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("倒计时页自己的轮询（2026-10-05 评审）", () => {
  it("状态未知（首次拉取失败 → null / 还没数据）必须继续拉；只有明确结束才停", () => {
    // 原来 `data?.status === "pending" ? 10_000 : false` 把 null 也当成结束：弱网点通知进来，
    // 第一次失败后页面永远停在没有数字、没有警报音的空壳上
    expect(countdownPollInterval(null)).toBe(COUNTDOWN_POLL_MS);
    expect(countdownPollInterval(undefined)).toBe(COUNTDOWN_POLL_MS);
    expect(countdownPollInterval(sos())).toBe(COUNTDOWN_POLL_MS);
    expect(countdownPollInterval(sos({ status: "cancelled" }))).toBe(false);
    expect(countdownPollInterval(sos({ status: "notified" }))).toBe(false);
    // sos-queue、倒计时页、use-realtime 的注释都按「10 秒轮询」推算 WS 断着时多久能对上终态；改值要一并改
    expect(COUNTDOWN_POLL_MS).toBe(10_000);
  });

  it("迟到的 pending 应答不把已取消盖回倒计时（用户刚点完「我没事」，轮询的旧应答才回来）", () => {
    const cancelled = sos({ status: "cancelled" });
    qc.setQueryData(["sos", "s1"], cancelled); // act() 成功后写的
    expect(settleSnapshot(qc, "s1", sos())).toEqual(cancelled);
  });

  it("其余情况原样采用服务端结果：缓存是 pending / 没缓存 / 应答本身是终态 / 应答为空", () => {
    expect(settleSnapshot(qc, "s1", sos())?.status).toBe("pending");
    qc.setQueryData(["sos", "s1"], sos());
    expect(settleSnapshot(qc, "s1", sos())?.status).toBe("pending");
    // APP-03 的方向：缓存里是迟到的 pending，服务端说已结束 → 信服务端
    expect(settleSnapshot(qc, "s1", sos({ status: "notified" }))?.status).toBe(
      "notified",
    );
    expect(settleSnapshot(qc, "s1", null)).toBeNull();
  });
});

describe("resumePendingSos：账号级接口一次拿全（B 线第 12 项）", () => {
  it("给了 fetchAccountActive 就只发这一个请求，不逐台查；列表里每顶头盔的进行中单都写缓存、拉起、补锁屏提醒（解绑后的头盔也在）", async () => {
    deps.fetchAccountActive.mockResolvedValue({
      items: [
        sos({ sosId: "s1", deviceId: "d1" }),
        sos({ sosId: "s9", deviceId: "d-unbound" }),
      ],
      total: 2,
    });
    const found = await resumePendingSos(
      qc,
      ["d1", "d2", "d3"],
      presented,
      deps,
    );
    expect(found).toEqual(["s1", "s9"]);
    expect(deps.fetchActive).not.toHaveBeenCalled();
    expect(deps.fetchAccountActive).toHaveBeenCalledTimes(1);
    expect(
      qc.getQueryData<ActiveSosResponse>(["sos-active", "d-unbound"])?.sos
        ?.sosId,
    ).toBe("s9");
    expect(deps.openCountdown.mock.calls).toEqual([
      ["s1", "d1"],
      ["s9", "d-unbound"],
    ]);
    expect(deps.showLockScreenAlert).toHaveBeenCalledTimes(2);
  });

  it("本机已知结束的单（迟到的 pending）不拉起；已拉起过的不重复拉", async () => {
    qc.setQueryData(["sos", "s1"], sos({ status: "cancelled" }));
    presented.current.add("s2");
    deps.fetchAccountActive.mockResolvedValue({
      items: [sos(), sos({ sosId: "s2", deviceId: "d2" })],
      total: 2,
    });
    expect(await resumePendingSos(qc, [], presented, deps)).toEqual(["s2"]);
    expect(deps.openCountdown).not.toHaveBeenCalled();
  });

  it("服务端没有账号级接口（返回 null）：退回逐台查", async () => {
    deps.fetchActive.mockImplementation(async (id) => ({
      sos: id === "d2" ? sos({ sosId: "s2", deviceId: "d2" }) : null,
    }));
    expect(await resumePendingSos(qc, ["d1", "d2"], presented, deps)).toEqual([
      "s2",
    ]);
    expect(deps.fetchActive).toHaveBeenCalledTimes(2);
  });

  it("账号级接口回空列表：就是一单都没有，不再退成逐台查（绑得多时那是 N 个白发的请求，10-16 F10）", async () => {
    deps.fetchAccountActive.mockResolvedValue({ items: [], total: 0 });
    expect(await resumePendingSos(qc, ["d1", "d2"], presented, deps)).toEqual(
      [],
    );
    expect(deps.fetchActive).not.toHaveBeenCalled();
  });

  it("账号级请求失败（断网）：什么都不做，也不退成 N 个注定失败的逐台请求", async () => {
    deps.fetchAccountActive.mockRejectedValue(new Error("offline"));
    expect(await resumePendingSos(qc, ["d1", "d2"], presented, deps)).toEqual(
      [],
    );
    expect(deps.fetchActive).not.toHaveBeenCalled();
  });
});

describe("alertPendingOnBackground：设备列表之外的头盔（B 线第 12 项）", () => {
  it("头盔已解绑、单还是本人的（账号级补拉写进了缓存）：离开前台照样补弹锁屏", () => {
    qc.setQueryData<ActiveSosResponse>(["sos-active", "d-unbound"], {
      sos: sos({ sosId: "s9", deviceId: "d-unbound" }),
    });
    expect(alertPendingOnBackground(qc, "background", ["d1"], deps)).toBe(1);
    expect(deps.showLockScreenAlert).toHaveBeenCalledWith(
      "s9",
      "d-unbound",
      sos().deadline,
      undefined,
    );
  });
});
