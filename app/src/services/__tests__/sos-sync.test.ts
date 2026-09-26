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
  presented = { current: null };
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
