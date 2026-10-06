// 锁屏 SOS 提醒（2026-09-17）：前台不弹、同一单只弹一次、按剩余时间预排两次静默刷新、
// 通知按钮「我没事」直接调服务端取消、结束后撤掉所有待触发刷新。
// 不整模块 mock react-native（见 map/__tests__/audit-nav-links.test.ts 顶部注释）——
// Platform.OS / AppState.currentState 按属性覆盖并还原。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";
import { AppState, Platform } from "react-native";

type SosAlert = typeof import("../sos-alert");

const mockCancel = jest.fn(async (_id: string) => ({}) as never);
const mockPush = jest.fn((_href: string) => undefined);
const mockNavigate = jest.fn((_href: string) => undefined);
const mockGetLastResponse = jest.fn((): unknown => null);
/** 通知中心里此刻挂着的通知（getPresentedNotificationsAsync） */
const mockPresented = jest.fn(async (): Promise<unknown[]> => []);
const mockClearLastResponse = jest.fn(() => undefined);
const mockSchedule = jest.fn(async (_req: unknown) => "id");
const mockCancelScheduled = jest.fn(async (_id: string) => undefined);
const mockDismiss = jest.fn(async (_id: string) => undefined);
const mockSetChannel = jest.fn(async (_id: string, _o: unknown) => undefined);
const mockSetCategory = jest.fn(async (_id: string, _a: unknown) => undefined);
const mockGetPerms = jest.fn(
  async (): Promise<{ granted: boolean; status?: string }> => ({
    granted: true,
  }),
);
const mockRequestPerms = jest.fn(async () => ({ granted: true }));
const mockSetHandler = jest.fn((_h: unknown) => undefined);
/** addNotificationResponseReceivedListener 拿到的回调，用来模拟用户点通知按钮 */
let responseHandler: ((r: unknown) => void) | null = null;

jest.mock("@/api/sos", () => ({
  sosApi: { cancel: (id: string) => mockCancel(id) },
}));
jest.mock("expo-router", () => ({
  router: {
    push: (h: string) => mockPush(h),
    navigate: (h: string) => mockNavigate(h),
  },
}));
jest.mock("@/i18n", () => ({
  translate: (k: string, p?: Record<string, unknown>) =>
    p ? `${k}:${JSON.stringify(p)}` : k,
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (req: unknown) => mockSchedule(req),
  cancelScheduledNotificationAsync: (id: string) => mockCancelScheduled(id),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  setNotificationChannelAsync: (id: string, o: unknown) =>
    mockSetChannel(id, o),
  setNotificationCategoryAsync: (id: string, a: unknown) =>
    mockSetCategory(id, a),
  getPermissionsAsync: () => mockGetPerms(),
  requestPermissionsAsync: () => mockRequestPerms(),
  addNotificationResponseReceivedListener: (cb: (r: unknown) => void) => {
    responseHandler = cb;
    return { remove: jest.fn() };
  },
  setNotificationHandler: (h: unknown) => {
    mockSetHandler(h);
  },
  getLastNotificationResponse: () => mockGetLastResponse(),
  getPresentedNotificationsAsync: () => mockPresented(),
  clearLastNotificationResponse: () => mockClearLastResponse(),
  AndroidImportance: { MAX: 5 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  AndroidNotificationPriority: { MAX: "max" },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
}));

const originalOS = Platform.OS;
const originalState = AppState.currentState;
const override = (obj: object, key: string, value: unknown): void => {
  Object.defineProperty(obj, key, {
    value,
    configurable: true,
    writable: true,
  });
};
const deadlineIn = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();

/** 模块有模块级状态（shownForSosId / notificationIds / permissionAsked），每个用例拿一份新的 */
type ServerClock = typeof import("@/services/server-clock");
/** 与被测模块同一份隔离注册表里的 server-clock（isolateModules 让顶层 import 的那份与它不是同一个实例） */
let clock!: ServerClock;
const load = (): SosAlert => {
  let mod!: SosAlert;
  jest.isolateModules(() => {
    clock = require("@/services/server-clock") as ServerClock;
    mod = require("../sos-alert") as SosAlert;
  });
  return mod;
};

type Req = {
  identifier: string;
  content: Record<string, unknown>;
  trigger: unknown;
};
const reqs = (): Req[] => mockSchedule.mock.calls.map((c) => c[0] as Req);

describe("sos-alert", () => {
  beforeEach(() => {
    responseHandler = null;
    for (const m of [
      mockCancel,
      mockPush,
      mockNavigate,
      mockClearLastResponse,
      mockSchedule,
      mockCancelScheduled,
      mockDismiss,
      mockSetChannel,
      mockSetCategory,
      mockGetPerms,
      mockRequestPerms,
    ]) {
      (m as unknown as Mock<() => unknown>).mockClear();
    }
    mockGetPerms.mockResolvedValue({ granted: true });
    mockGetLastResponse.mockReset();
    mockGetLastResponse.mockReturnValue(null);
    mockPresented.mockReset();
    mockPresented.mockResolvedValue([]);
    mockCancel.mockReset();
    mockCancel.mockImplementation(async () => ({}) as never);
    override(Platform, "OS", "ios");
    override(AppState, "currentState", "background");
  });
  afterEach(() => {
    override(Platform, "OS", originalOS);
    override(AppState, "currentState", originalState);
  });

  describe("showSosAlertIfBackground", () => {
    it("在前台时不弹（SOS 页已经在用户眼前）", async () => {
      override(AppState, "currentState", "active");
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it("60s 倒计时：立即一条带声，30s/10s 各一条静默刷新", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      const r = reqs();
      expect(r).toHaveLength(3);
      // 首条：立即触发、带声、正文是剩余 60
      expect(r[0].identifier).toBe("sos-s1");
      expect(r[0].trigger).toBeNull();
      expect(r[0].content.sound).toBe("default");
      expect(r[0].content.body).toBe('sosAlert.bodyCountdown:{"seconds":60}');
      expect(r[0].content.data).toEqual({ sosId: "s1", deviceId: "d1" });
      expect(r[0].content.categoryIdentifier).toBe("sos");
      // 刷新：不响铃，延迟 = 剩余 - 档位，第二条换 id 免得互相覆盖
      expect(r[1].content.sound).toBe(false);
      expect(r[1].trigger).toMatchObject({ seconds: 30 });
      expect(r[2].identifier).toBe("sos-s1-10");
      expect(r[2].trigger).toMatchObject({ seconds: 50 });
    });

    it("同一单重复推送只弹一次", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      const first = mockSchedule.mock.calls.length;
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      expect(mockSchedule.mock.calls.length).toBe(first);
    });

    it("剩余时间不足时跳过来不及的刷新档", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(12));
      // 30s 档已过（delay 为负），10s 档 delay=2 <3 也跳过 → 只有首条
      expect(reqs()).toHaveLength(1);
    });

    it("手机快 90 秒：读秒按服务端时钟算，不会一弹出来就是 0（F-3）", async () => {
      const m = load();
      clock.noteServerDate(
        new Date(Date.now() - 90_000).toUTCString(),
        Date.now(),
      );
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(-30)); // 按手机时钟已过期 30 s，服务端看还剩 60 s
      const r = reqs();
      // Date 头只有秒级精度，偏移最多差 1 s
      expect(r[0].content.body).toMatch(
        /sosAlert\.bodyCountdown:\{"seconds":6[01]\}/,
      );
      expect(r).toHaveLength(3); // 30 s / 10 s 两档刷新也排上了
    });

    it("已过期的 deadline 不会排出负数延迟", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(-30));
      const r = reqs();
      expect(r).toHaveLength(1);
      expect(r[0].content.body).toBe('sosAlert.bodyCountdown:{"seconds":0}');
    });

    it("Android：通道写在 trigger 里（content.channelId 原生侧不读，写了等于落到兜底通道），声音用 true 而非 'default'", async () => {
      override(Platform, "OS", "android");
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      const r = reqs();
      // 首条是唯一响铃的那条：trigger 为 null 时 expo 用 Miscellaneous 兜底通道，「SOS」通道的勿扰例外管不到它
      expect(r[0].trigger).toEqual({ channelId: "sos" });
      expect(r[0].content.channelId).toBeUndefined();
      expect(r[0].content.sound).toBe(true);
      // 两条刷新也都在 sos 通道
      expect(
        r.slice(1).map((x) => (x.trigger as { channelId?: string }).channelId),
      ).toEqual(["sos", "sos"]);
    });

    it("iOS：首条 trigger 为 null（立即投递）", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      expect(reqs()[0].trigger).toBeNull();
    });

    it("调度失败不抛给调用方（保命链路不能被通知拖垮）", async () => {
      mockSchedule.mockRejectedValueOnce(new Error("denied"));
      const m = load();
      await expect(
        m.showSosAlertIfBackground("s1", "d1", deadlineIn(60)),
      ).resolves.toBeUndefined();
    });
  });

  describe("clearSosAlert", () => {
    it("撤掉首条与所有待触发刷新", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await m.clearSosAlert("s1");
      expect(mockCancelScheduled.mock.calls.map((c) => c[0])).toEqual([
        "sos-s1",
        "sos-s1",
        "sos-s1-10",
      ]);
      expect(mockDismiss).toHaveBeenCalledTimes(3);
    });

    it("别的单的 id 不动已弹的通知", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await m.clearSosAlert("other");
      expect(mockCancelScheduled).not.toHaveBeenCalled();
    });

    it("撤销接口抛错也不影响（通知可能已被划掉）", async () => {
      mockCancelScheduled.mockRejectedValue(new Error("gone"));
      mockDismiss.mockRejectedValue(new Error("gone"));
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await expect(m.clearSosAlert("s1")).resolves.toBeUndefined();
      mockCancelScheduled.mockResolvedValue(undefined);
      mockDismiss.mockResolvedValue(undefined);
    });

    it("清完之后同一单可以再次弹（服务端又建了单）", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await m.clearSosAlert("s1");
      mockSchedule.mockClear();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      expect(mockSchedule).toHaveBeenCalled();
    });
  });

  describe("ensureSosAlertPermission", () => {
    it("iOS：注册两个通知动作，不建 Android 通道；已授权则不再申请", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      expect(mockSetChannel).not.toHaveBeenCalled();
      const actions = mockSetCategory.mock.calls[0][1] as {
        identifier: string;
      }[];
      expect(actions.map((a) => a.identifier)).toEqual(["cancel", "open"]);
      expect(mockRequestPerms).not.toHaveBeenCalled();
    });

    it("未授权时才弹系统权限框，且只初始化一次", async () => {
      mockGetPerms.mockResolvedValue({ granted: false });
      const m = load();
      await m.ensureSosAlertPermission();
      await m.ensureSosAlertPermission();
      expect(mockRequestPerms).toHaveBeenCalledTimes(1);
      expect(mockSetCategory).toHaveBeenCalledTimes(1);
    });

    it("并发调用拿到同一次初始化：调用方（蓝牙链路）要等系统权限框有结果才能去要别的权限", async () => {
      mockGetPerms.mockResolvedValue({ granted: false });
      let answer!: () => void;
      mockRequestPerms.mockImplementationOnce(
        () =>
          new Promise<{ granted: boolean }>(
            (r) => (answer = () => r({ granted: true })),
          ),
      );
      const m = load();
      const first = m.ensureSosAlertPermission();
      const second = m.ensureSosAlertPermission();
      let secondDone = false;
      void second.then(() => (secondDone = true));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(mockRequestPerms).toHaveBeenCalledTimes(1);
      expect(secondDone).toBe(false); // 系统框还开着，第二个调用方不能先走
      answer();
      await first;
      await second;
      expect(secondDone).toBe(true);
      expect(mockSetCategory).toHaveBeenCalledTimes(1);
    });

    it("Android：建高优先级通道", async () => {
      override(Platform, "OS", "android");
      const m = load();
      await m.ensureSosAlertPermission();
      expect(mockSetChannel.mock.calls[0][0]).toBe("sos");
    });

    it("初始化失败不抛（权限拒绝不阻塞 BLE 链路）", async () => {
      mockSetCategory.mockRejectedValueOnce(new Error("no"));
      const m = load();
      await expect(m.ensureSosAlertPermission()).resolves.toBeUndefined();
    });
  });

  describe("前台展示策略（SOS-11：锁屏瞬间 inactive 到达的通知不能被吞）", () => {
    it("初始化时安装策略；App 不在前台时所有通知都弹横幅+响，active 不弹", async () => {
      mockSetHandler.mockClear(); // 不在 beforeEach 的清零列表里，手动清
      const m = load();
      await m.ensureSosAlertPermission();
      expect(mockSetHandler).toHaveBeenCalledTimes(1);
      const handler = (
        mockSetHandler.mock.calls[0][0] as {
          handleNotification: (
            n: unknown,
          ) => Promise<{ shouldShowBanner: boolean; shouldPlaySound: boolean }>;
        }
      ).handleNotification;
      const sos = { request: { content: { categoryIdentifier: "sos" } } };
      override(AppState, "currentState", "inactive");
      expect((await handler(sos)).shouldShowBanner).toBe(true);
      override(AppState, "currentState", "background");
      expect((await handler(sos)).shouldPlaySound).toBe(true);
      override(AppState, "currentState", "active");
      expect((await handler(sos)).shouldShowBanner).toBe(false);
      // 极光远程推送没有 category：非 active 时同样要显示（评审 2026-09-26）
      override(AppState, "currentState", "inactive");
      expect(
        (
          await handler({
            request: { content: { categoryIdentifier: undefined } },
          })
        ).shouldShowBanner,
      ).toBe(true);
      expect(m.sosPresentation(undefined, "background").show).toBe(true);
      expect(m.sosPresentation("device", "active").show).toBe(false);
    });
  });

  describe("isSosAlertPermissionDenied（8.2：权限被拒要有提示）", () => {
    it("未授权 → true；已授权 → false；查询抛错 → false（不吓唬用户）", async () => {
      const m = load();
      mockGetPerms.mockResolvedValueOnce({ granted: false });
      expect(await m.isSosAlertPermissionDenied()).toBe(true);
      mockGetPerms.mockResolvedValueOnce({ granted: true });
      expect(await m.isSosAlertPermissionDenied()).toBe(false);
      mockGetPerms.mockRejectedValueOnce(new Error("x"));
      expect(await m.isSosAlertPermissionDenied()).toBe(false);
    });

    it("还没问过（undetermined）不算被拒：新用户首次登录时系统授权框还没点，不能先弹「通知权限已关闭」", async () => {
      const m = load();
      mockGetPerms.mockResolvedValueOnce({
        granted: false,
        status: "undetermined",
      });
      expect(await m.isSosAlertPermissionDenied()).toBe(false);
      mockGetPerms.mockResolvedValueOnce({ granted: false, status: "denied" });
      expect(await m.isSosAlertPermissionDenied()).toBe(true);
    });
  });

  describe("10-03 评审疑点 2 / 4：多单槽位与排通知竞态", () => {
    it("两单各有各的通知：第二单不顶掉第一单，各自结束时各自清干净", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await m.showSosAlertIfBackground("s2", "d2", deadlineIn(60));
      mockDismiss.mockClear();
      await m.clearSosAlert("s1"); // 单槽位时这里直接 return，s1 的通知永远留在锁屏
      const dismissed = mockDismiss.mock.calls.map((c) => c[0]);
      expect(dismissed).toContain("sos-s1");
      expect(dismissed.some((id) => id.startsWith("sos-s2"))).toBe(false);
      mockDismiss.mockClear();
      await m.clearSosAlert("s2");
      expect(mockDismiss.mock.calls.map((c) => c[0])).toContain("sos-s2");
    });

    it("排通知途中这单被取消：后面的刷新一条都不再排，刚排上的撤回，不留孤儿提醒", async () => {
      const m = load();
      mockSchedule.mockClear();
      mockCancelScheduled.mockClear();
      // 第一条（立即弹的那条）卡在原生调用里
      let release!: () => void;
      mockSchedule.mockImplementationOnce(
        () => new Promise<string>((r) => (release = () => r("id"))),
      );
      const showing = m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await Promise.resolve();
      await m.clearSosAlert("s1"); // 用户在这个瞬间取消了
      // clearSosAlert 自己那次撤回发生在原生排通知完成之前，是空操作；要钉的是排完之后的那一次
      mockCancelScheduled.mockClear();
      release();
      await showing;
      // 只排过那一条，30 s / 10 s 的刷新没有再排
      expect(mockSchedule).toHaveBeenCalledTimes(1);
      // 那一条在排完后被撤回
      expect(mockCancelScheduled.mock.calls.map((c) => c[0])).toContain(
        "sos-s1",
      );
      // 同一单之后还能重新弹（没有残留状态）
      mockSchedule.mockClear();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      expect(mockSchedule).toHaveBeenCalled();
    });
  });

  describe("通知按钮响应", () => {
    it("「我没事」调服务端取消并撤掉通知；动作必须把 App 拉到前台（后台请求会被 iOS 挂起中断）", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      const actions = mockSetCategory.mock.calls[0][1] as {
        identifier: string;
        options: { opensAppToForeground: boolean };
      }[];
      // 2026-09-24 iPhone 实测：opensAppToForeground=false 时取消请求 FetchRequestCanceledException，
      // 60 s 后照样通知联系人——按了却没生效的取消键比没有更危险
      expect(
        actions.find((a) => a.identifier === "cancel")?.options
          .opensAppToForeground,
      ).toBe(true);
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      mockCancel.mockClear();
      responseHandler?.({
        actionIdentifier: "cancel",
        notification: {
          request: { content: { data: { sosId: "s1", deviceId: "d1" } } },
        },
      });
      expect(mockCancel).toHaveBeenCalledWith("s1");
      expect(mockPush).not.toHaveBeenCalled();
      // 撤通知在服务端确认取消之后（异步一拍）
      await new Promise((r) => setTimeout(r, 0));
      expect(mockCancelScheduled).toHaveBeenCalled();
    });

    it("取消失败：通知不撤（用户能看到还在倒计时）、按 2s/5s/10s 重试、成功后才撤", async () => {
      jest.useFakeTimers();
      mockCancel
        .mockRejectedValueOnce(new Error("Fetch request has been canceled"))
        .mockRejectedValueOnce(new Error("still offline"))
        .mockResolvedValueOnce({} as never);
      override(AppState, "addEventListener", () => ({
        remove: () => undefined,
      }));
      const m = load();
      const confirmed: string[] = [];
      m.setSosCancelConfirmedListener((id) => confirmed.push(id));
      await m.ensureSosAlertPermission();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      mockCancelScheduled.mockClear();
      mockDismiss.mockClear();
      responseHandler?.({
        actionIdentifier: "cancel",
        notification: { request: { content: { data: { sosId: "s1" } } } },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockCancel).toHaveBeenCalledTimes(1);
      expect(mockDismiss).not.toHaveBeenCalled(); // 失败 → 通知留着
      expect(confirmed).toEqual([]);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockCancel).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(mockCancel).toHaveBeenCalledTimes(3);
      // 第三次才成功：通知这时才撤，并通知页面去拉权威状态（原来重试的结果没人接，通知永远留着）
      expect(mockDismiss.mock.calls.map((c) => c[0])).toContain("sos-s1");
      expect(confirmed).toEqual(["s1"]);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(mockCancel).toHaveBeenCalledTimes(3); // 成功后不再重试
      jest.useRealTimers();
    });

    it("取消失败时 App 回到前台立刻重试（不等定时器）", async () => {
      jest.useFakeTimers();
      mockCancel
        .mockRejectedValueOnce(new Error("canceled"))
        .mockResolvedValueOnce({} as never);
      const listener: { cb: ((s: string) => void) | null } = { cb: null };
      override(
        AppState,
        "addEventListener",
        (_: string, cb: (s: string) => void) => {
          listener.cb = cb;
          return { remove: () => undefined };
        },
      );
      const m = load();
      expect(await m.cancelFromNotification("s1")).toBe(false);
      listener.cb?.("active");
      await jest.advanceTimersByTimeAsync(0);
      expect(mockCancel).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mockCancel).toHaveBeenCalledTimes(2);
    });

    it("回前台触发的重试不消耗机会：飞行模式下点取消再拉起 App，三次机会不会在同一秒内打光，网络回来后定时重试成功", async () => {
      jest.useFakeTimers();
      const listener: { cb: ((s: string) => void) | null } = { cb: null };
      override(
        AppState,
        "addEventListener",
        (_: string, cb: (s: string) => void) => {
          listener.cb = cb;
          return { remove: () => undefined };
        },
      );
      let online = false;
      mockCancel.mockImplementation(async () => {
        if (!online)
          throw new Error("The Internet connection appears to be offline.");
        return {} as never;
      });
      const m = load();
      expect(await m.cancelFromNotification("s1")).toBe(false);
      // 拉起 App：inactive → active 来回几次，每次都立刻重试一遍（仍离线），但不算用掉机会
      for (let i = 0; i < 3; i += 1) {
        listener.cb?.("active");
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(mockCancel.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(mockNavigate).not.toHaveBeenCalled(); // 没有「用尽」
      // 2 s 定时重试仍离线 → 第 2 档 5 s；期间网络回来 → 成功，不弹失败
      await jest.advanceTimersByTimeAsync(2_000);
      online = true;
      await jest.advanceTimersByTimeAsync(5_000);
      expect(
        await Promise.resolve(mockCancel.mock.results.at(-1)?.value),
      ).toEqual({});
      expect(mockNavigate).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(60_000);
      jest.useRealTimers();
    });

    it("边界：这单已在别处结束（另一台先取消 / 最后一秒到期）→ SOS_ALREADY_FINALIZED 视为成功，不重试", async () => {
      mockCancel.mockRejectedValueOnce(
        Object.assign(new Error("409"), { code: "SOS_ALREADY_FINALIZED" }),
      );
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      mockDismiss.mockClear();
      expect(await m.cancelFromNotification("s1")).toBe(true);
      expect(mockCancel).toHaveBeenCalledTimes(1);
      // 已在别处结束也要把锁屏通知撤掉
      await new Promise((r) => setTimeout(r, 0));
      expect(mockDismiss.mock.calls.map((c) => c[0])).toContain("sos-s1");
    });

    it("确认回调抛错不影响取消结果（页面刷新失败不能让取消看起来没成功）", async () => {
      const m = load();
      m.setSosCancelConfirmedListener(() => {
        throw new Error("boom");
      });
      expect(await m.cancelFromNotification("s1")).toBe(true);
    });

    it("点横幅/「打开 App」进 SOS 页：用 navigate（页面多半已在栈上，push 会叠两页）并登记为已拉起", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.({
        actionIdentifier: "open",
        notification: {
          request: { content: { data: { sosId: "s1", deviceId: "d1" } } },
        },
      });
      expect(mockNavigate).toHaveBeenCalledWith(
        "/sos-active?sosId=s1&deviceId=d1",
      );
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("通知里没有 deviceId：不跳转（不把 undefined 拼进路由）", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.({
        actionIdentifier: "open",
        notification: { request: { content: { data: { sosId: "s1" } } } },
      });
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("没有 sosId 的通知忽略（别的通知走同一监听）", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.({
        actionIdentifier: "default",
        notification: { request: { content: { data: {} } } },
      });
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
    });
  });

  describe("冷启动：进程被杀后点锁屏通知拉起（监听不回放那次点击，只能从 getLastNotificationResponse 取）", () => {
    const launch = (
      actionIdentifier: string,
      data: unknown = { sosId: "s1", deviceId: "d1" },
    ) => ({
      actionIdentifier,
      notification: {
        date: 1_700_000_000,
        request: { identifier: "sos-s1", trigger: null, content: { data } },
      },
    });

    it("点的是「取消」：取消请求必须发出去（原来这次点击被丢掉，60 s 后照样通知联系人）", async () => {
      mockGetLastResponse.mockReturnValue(launch("cancel"));
      const m = load();
      await m.ensureSosAlertPermission();
      expect(mockCancel).toHaveBeenCalledWith("s1");
      expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it("通道 / 类别注册还挂着没返回时，启动点击已经同步读走：取消请求照样发出（根布局紧接着会同步跑 push.ts，它读的是同一条）", async () => {
      mockGetLastResponse.mockReturnValue(launch("cancel"));
      mockSetCategory.mockImplementation(
        () => new Promise<undefined>(() => undefined),
      );
      const m = load();
      void m.ensureSosAlertPermission(); // 不 await：模拟同一个 effect 里紧接着的同步代码
      expect(mockCancel).toHaveBeenCalledWith("s1");
      mockSetCategory.mockImplementation(async () => undefined);
    });

    it("点的是横幅 / 「打开 App」：进倒计时页", async () => {
      mockGetLastResponse.mockReturnValue(launch("open"));
      const m = load();
      await m.ensureSosAlertPermission();
      expect(mockNavigate).toHaveBeenCalledWith(
        "/sos-active?sosId=s1&deviceId=d1",
      );
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it("监听随后又把同一次点击送来一遍：只处理一次", async () => {
      mockGetLastResponse.mockReturnValue(launch("cancel"));
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.(launch("cancel"));
      expect(mockCancel).toHaveBeenCalledTimes(1);
    });

    it("但用户之后在同一条通知上再点一次「取消」必须照常处理（第一次失败、通知还留在锁屏上）", async () => {
      mockGetLastResponse.mockReturnValue(launch("cancel"));
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.(launch("cancel")); // 回放，跳过
      responseHandler?.(launch("cancel")); // 用户真的又点了一次
      expect(mockCancel).toHaveBeenCalledTimes(2);
    });

    it("远程推送的启动点击（content.data 里没有 sosId）不碰、不清——留给 push.ts 落地", async () => {
      mockGetLastResponse.mockReturnValue({
        actionIdentifier: "default",
        notification: {
          date: 1,
          request: {
            identifier: "x",
            trigger: { type: "push", payload: { sosId: "s1" } },
            content: { data: null },
          },
        },
      });
      const m = load();
      await m.ensureSosAlertPermission();
      expect(mockClearLastResponse).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it("没有启动点击 / 读取抛错：初始化照常完成", async () => {
      mockGetLastResponse.mockImplementation(() => {
        throw new Error("native missing");
      });
      const m = load();
      await expect(m.ensureSosAlertPermission()).resolves.toBeUndefined();
      expect(responseHandler).not.toBeNull();
    });
  });

  describe("取消在途标记（2026-10-07 iPhone：被杀后点通知按钮，倒计时页要显示「取消中」而不是继续倒数）", () => {
    const loadWithStore = () => {
      let mod!: SosAlert;
      let store!: typeof import("@/stores/sos-cancel-store");
      jest.isolateModules(() => {
        store = require("@/stores/sos-cancel-store");
        mod = require("../sos-alert") as SosAlert;
      });
      return { m: mod, store: store.useSosCancelStore };
    };

    it("请求发出即标记在途，服务端确认后清掉", async () => {
      let finish!: () => void;
      mockCancel.mockImplementationOnce(
        () => new Promise<never>((r) => (finish = () => r({} as never))),
      );
      const { m, store } = loadWithStore();
      const p = m.cancelFromNotification("s1");
      expect(store.getState().inFlight.s1).toBe(true);
      finish();
      expect(await p).toBe(true);
      expect(store.getState().inFlight.s1).toBeUndefined();
    });

    it("重试期间一直在途；重试用尽后清掉（页面上的按钮要能再按）", async () => {
      jest.useFakeTimers();
      override(AppState, "addEventListener", () => ({
        remove: () => undefined,
      }));
      mockCancel.mockRejectedValue(new Error("offline"));
      const { m, store } = loadWithStore();
      expect(await m.cancelFromNotification("s1")).toBe(false);
      expect(store.getState().inFlight.s1).toBe(true);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(store.getState().inFlight.s1).toBe(true);
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(store.getState().inFlight.s1).toBeUndefined();
      jest.useRealTimers();
    });
  });

  describe("resetSosAlerts（登出）", () => {
    it("撤掉所有还挂着的 SOS 通知并停掉取消重试：上一个账号的提醒不留在这台手机上", async () => {
      jest.useFakeTimers();
      override(AppState, "addEventListener", () => ({
        remove: () => undefined,
      }));
      mockCancel.mockRejectedValue(new Error("401"));
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await m.showSosAlertIfBackground("s2", "d2", deadlineIn(60));
      expect(await m.cancelFromNotification("s1")).toBe(false); // 排了 2 s 后的重试
      mockDismiss.mockClear();
      await m.resetSosAlerts();
      const dismissed = mockDismiss.mock.calls.map((c) => c[0]);
      expect(dismissed).toContain("sos-s1");
      expect(dismissed).toContain("sos-s2");
      mockCancel.mockClear();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mockCancel).not.toHaveBeenCalled(); // 重试已停
      jest.useRealTimers();
    });
  });

  describe("同一单的两条通知（2026-10-06 iPhone：叠成一摞，长按到的是没有按钮的远程推送）", () => {
    const remote = (id: string, sosId: string) => ({
      request: {
        identifier: id,
        trigger: { type: "push", payload: { sosId, deviceId: "d1" } },
        content: { data: null },
      },
    });
    const local = (sosId: string) => ({
      request: {
        identifier: `sos-${sosId}`,
        trigger: null,
        content: { data: { sosId, deviceId: "d1" } },
      },
    });

    it("本地通知弹出后撤掉同一单的远程推送：只留带「取消」按钮的那条；别的单的、本地的都不动", async () => {
      mockPresented.mockResolvedValue([
        remote("apns-1", "s1"),
        remote("apns-2", "s9"),
        local("s1"),
      ]);
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await new Promise((r) => setTimeout(r, 0));
      expect(mockDismiss.mock.calls.map((c) => c[0])).toEqual(["apns-1"]);
      await m.clearSosAlert("s1");
    });

    it("远程推送晚到：3 秒、10 秒各再扫一遍；这单结束后不再扫", async () => {
      jest.useFakeTimers();
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      await jest.advanceTimersByTimeAsync(0);
      expect(mockDismiss).not.toHaveBeenCalled();
      mockPresented.mockResolvedValue([remote("apns-late", "s1")]);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(mockDismiss.mock.calls.map((c) => c[0])).toEqual(["apns-late"]);
      mockDismiss.mockClear();
      mockPresented.mockResolvedValue([remote("apns-later", "s1")]);
      await jest.advanceTimersByTimeAsync(7_000);
      expect(mockDismiss.mock.calls.map((c) => c[0])).toEqual(["apns-later"]);
      // 结束后：定时器已清，不再碰通知中心
      await m.showSosAlertIfBackground("s2", "d1", deadlineIn(60));
      await m.clearSosAlert("s2");
      mockPresented.mockClear();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(mockPresented).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it("查通知中心抛错不影响提醒本身", async () => {
      mockPresented.mockRejectedValue(new Error("native"));
      const m = load();
      await expect(
        m.showSosAlertIfBackground("s1", "d1", deadlineIn(60)),
      ).resolves.toBeUndefined();
      expect(mockSchedule).toHaveBeenCalled();
      await m.clearSosAlert("s1");
    });

    it("远程推送上的「取消」按钮（服务端给推送带上通知类别之后才会有）：照样调服务端取消", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.({
        actionIdentifier: "cancel",
        notification: { date: 1, ...remote("apns-1", "s1") },
      });
      expect(mockCancel).toHaveBeenCalledWith("s1");
    });

    it("远程推送上的普通点击不归这里管（push.ts 落地），不重复跳转", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.({
        actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
        notification: { date: 1, ...remote("apns-1", "s1") },
      });
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it("冷启动由远程推送的「取消」按钮拉起：发取消；不清这条启动点击（落地跳转仍归 push.ts）", async () => {
      mockGetLastResponse.mockReturnValue({
        actionIdentifier: "cancel",
        notification: { date: 1, ...remote("apns-1", "s1") },
      });
      const m = load();
      await m.ensureSosAlertPermission();
      expect(mockCancel).toHaveBeenCalledWith("s1");
      expect(mockClearLastResponse).not.toHaveBeenCalled();
    });
  });
});
