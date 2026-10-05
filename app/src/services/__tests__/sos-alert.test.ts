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
const mockSchedule = jest.fn(async (_req: unknown) => "id");
const mockCancelScheduled = jest.fn(async (_id: string) => undefined);
const mockDismiss = jest.fn(async (_id: string) => undefined);
const mockSetChannel = jest.fn(async (_id: string, _o: unknown) => undefined);
const mockSetCategory = jest.fn(async (_id: string, _a: unknown) => undefined);
const mockGetPerms = jest.fn(async () => ({ granted: true }));
const mockRequestPerms = jest.fn(async () => ({ granted: true }));
const mockSetHandler = jest.fn((_h: unknown) => undefined);
/** addNotificationResponseReceivedListener 拿到的回调，用来模拟用户点通知按钮 */
let responseHandler: ((r: unknown) => void) | null = null;

jest.mock("@/api/sos", () => ({
  sosApi: { cancel: (id: string) => mockCancel(id) },
}));
jest.mock("expo-router", () => ({
  router: { push: (h: string) => mockPush(h) },
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
const load = (): SosAlert => {
  let mod!: SosAlert;
  jest.isolateModules(() => {
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

    it("已过期的 deadline 不会排出负数延迟", async () => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(-30));
      const r = reqs();
      expect(r).toHaveLength(1);
      expect(r[0].content.body).toBe('sosAlert.bodyCountdown:{"seconds":0}');
    });

    it("Android：带 channelId，且声音用 true 而非 'default'", async () => {
      override(Platform, "OS", "android");
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      const r = reqs();
      expect(r[0].content.channelId).toBe("sos");
      expect(r[0].content.sound).toBe(true);
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
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockCancel).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(mockCancel).toHaveBeenCalledTimes(3);
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
      jest.useRealTimers();
    });

    it("边界：这单已在别处结束（另一台先取消 / 最后一秒到期）→ SOS_ALREADY_FINALIZED 视为成功，不重试", async () => {
      mockCancel.mockRejectedValueOnce(
        Object.assign(new Error("409"), { code: "SOS_ALREADY_FINALIZED" }),
      );
      const m = load();
      expect(await m.cancelFromNotification("s1")).toBe(true);
      expect(mockCancel).toHaveBeenCalledTimes(1);
    });

    it("点横幅/「打开 App」进 SOS 页", async () => {
      const m = load();
      await m.ensureSosAlertPermission();
      responseHandler?.({
        actionIdentifier: "open",
        notification: {
          request: { content: { data: { sosId: "s1", deviceId: "d1" } } },
        },
      });
      expect(mockPush).toHaveBeenCalledWith("/sos-active?sosId=s1&deviceId=d1");
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
});
