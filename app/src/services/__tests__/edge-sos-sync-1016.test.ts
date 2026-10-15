// SOS 实时同步的边界补测（2026-10-16）。保命链路：只断言现状，不改行为。
// 「同一台头盔旧单的终态晚于新单的 pending 到达」会把新单从进行中缓存里清掉——记在 EDGE_FINDINGS_1016.md A5。
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
  COUNTDOWN_POLL_MS,
  alertPendingOnBackground,
  applySosUpdate,
  countdownPollInterval,
  guardActiveResult,
  isFinal,
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
  deadline: "2026-10-16T10:01:00.000Z",
  createdAt: "2026-10-16T10:00:00.000Z",
  updatedAt: "2026-10-16T10:00:00.000Z",
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

describe("同一台头盔前后两单的消息乱序", () => {
  it("改后（10-16 A5）：新单 s2 的 pending 先到、旧单 s1 的 notified 后到——别的单的终态不碰进行中缓存，s2 仍在，离开前台照样补弹锁屏通知", () => {
    applySosUpdate(qc, sos({ sosId: "s2" }), presented, deps);
    expect(active("d1")?.sosId).toBe("s2");
    applySosUpdate(
      qc,
      sos({ sosId: "s1", status: "notified" }),
      presented,
      deps,
    );
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("notified");
    expect(qc.getQueryData<Sos>(["sos", "s2"])?.status).toBe("pending");
    expect(active("d1")?.sosId).toBe("s2");
    expect(alertPendingOnBackground(qc, "background", ["d1"], deps)).toBe(1);
    expect(deps.openCountdown).toHaveBeenCalledWith("s2", "d1");
  });

  it("同一单自己的终态仍然把进行中缓存清掉", () => {
    applySosUpdate(qc, sos({ sosId: "s2" }), presented, deps);
    applySosUpdate(
      qc,
      sos({ sosId: "s2", status: "cancelled" }),
      presented,
      deps,
    );
    expect(active("d1")).toBeNull();
    expect(alertPendingOnBackground(qc, "background", ["d1"], deps)).toBe(0);
  });

  it("按正常顺序（旧单终态在前、新单 pending 在后）：进行中缓存指向新单", () => {
    applySosUpdate(
      qc,
      sos({ sosId: "s1", status: "notified" }),
      presented,
      deps,
    );
    applySosUpdate(qc, sos({ sosId: "s2" }), presented, deps);
    expect(active("d1")?.sosId).toBe("s2");
    expect(alertPendingOnBackground(qc, "background", ["d1"], deps)).toBe(1);
  });
});

describe("resumePendingSos 的边", () => {
  it("设备列表里同一台出现两次：查两次、锁屏通知请求两次（sos-alert 自己按 sosId 去重），倒计时页只拉一次", async () => {
    deps.fetchActive.mockResolvedValue({ sos: sos() });
    const found = await resumePendingSos(qc, ["d1", "d1"], presented, deps);
    expect(found).toEqual(["s1", "s1"]);
    expect(deps.fetchActive).toHaveBeenCalledTimes(2);
    expect(deps.showLockScreenAlert).toHaveBeenCalledTimes(2);
    expect(deps.openCountdown).toHaveBeenCalledTimes(1);
  });

  it("接口回来的 sos 属于别的设备（服务端串号）：缓存按请求的设备记、倒计时页也用请求的设备号（现状）", async () => {
    deps.fetchActive.mockResolvedValue({ sos: sos({ deviceId: "other" }) });
    await resumePendingSos(qc, ["d1"], presented, deps);
    expect(active("d1")?.sosId).toBe("s1");
    expect(deps.openCountdown).toHaveBeenCalledWith("s1", "d1");
  });

  it("补拉原因写进日志；没传原因按「冷启动」", async () => {
    deps.fetchActive.mockResolvedValue({ sos: sos() });
    await resumePendingSos(qc, ["d1"], presented, deps);
    expect(deps.log).toHaveBeenCalledWith("冷启动发现进行中 SOS s1");
    presented.current.clear();
    await resumePendingSos(qc, ["d1"], presented, deps, "重连");
    expect(deps.log).toHaveBeenLastCalledWith("重连发现进行中 SOS s1");
  });

  it("没注入日志函数：照常工作，不抛", async () => {
    deps.fetchActive.mockResolvedValue({ sos: sos() });
    const { log: _log, ...noLog } = deps;
    void _log;
    await expect(
      resumePendingSos(qc, ["d1"], presented, noLog),
    ).resolves.toEqual(["s1"]);
  });
});

describe("终态判断与轮询", () => {
  it("isFinal：没有缓存、缓存是 null、仍 pending 都不算终态", () => {
    expect(isFinal(qc, "s1")).toBe(false);
    qc.setQueryData(["sos", "s1"], null);
    expect(isFinal(qc, "s1")).toBe(false);
    qc.setQueryData(["sos", "s1"], sos());
    expect(isFinal(qc, "s1")).toBe(false);
    qc.setQueryData(["sos", "s1"], sos({ status: "cancelled" }));
    expect(isFinal(qc, "s1")).toBe(true);
  });

  it("倒计时页轮询：没拿到（undefined / null）和 pending 都继续 10 秒；任何终态都停", () => {
    expect(countdownPollInterval(undefined)).toBe(COUNTDOWN_POLL_MS);
    expect(countdownPollInterval(null)).toBe(COUNTDOWN_POLL_MS);
    expect(countdownPollInterval(sos())).toBe(COUNTDOWN_POLL_MS);
    expect(countdownPollInterval(sos({ status: "cancelled" }))).toBe(false);
    expect(countdownPollInterval(sos({ status: "notified" }))).toBe(false);
  });

  it("settleSnapshot：自己那次请求回来是 null（没有这单 / 失败）时原样给 null，不拿缓存顶上", () => {
    qc.setQueryData(["sos", "s1"], sos({ status: "cancelled" }));
    expect(settleSnapshot(qc, "s1", null)).toBeNull();
  });

  it("settleSnapshot：回来的是终态、缓存却是 pending——用回来的（更新的那份）", () => {
    qc.setQueryData(["sos", "s1"], sos());
    const fresh = sos({ status: "notified" });
    expect(settleSnapshot(qc, "s1", fresh)).toBe(fresh);
  });

  it("guardActiveResult：缓存里是终态但回来的是另一单 pending：原样返回（守卫按 sosId 对）", () => {
    qc.setQueryData(["sos", "s1"], sos({ status: "cancelled" }));
    const result = { sos: sos({ sosId: "s2" }) };
    expect(guardActiveResult(qc, result)).toBe(result);
  });
});
