// 安卓前台服务的 JS 封装（决策 #41）：iOS / 原生没链接上时全部空操作；原生包比 JS 旧（开发包热更）缺新方法时静默跳过、
// 给保守的默认值。别处的测试都把整个模块替身掉了，这些兜底原来没有直接测——这里用假的原生模块逐条钉住
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

type Native = Record<string, jest.Mock<(...a: unknown[]) => unknown>>;

const mockPlatform = { OS: "android" };
let mockNative: Native | null = null;
const mockRequire = jest.fn((name: string) => (name ? mockNative : null));
// 只换 Platform，其余用真的（整个替身掉会把 jest-expo 自己的初始化弄坏）
jest.mock("react-native", () => {
  const actual = jest.requireActual<object>("react-native");
  return new Proxy(actual, {
    get: (target, prop, receiver) =>
      prop === "Platform" ? mockPlatform : Reflect.get(target, prop, receiver),
  });
});
// 同理只换取模块这一个函数：expo 自己的运行时还要用 requireNativeModule
jest.mock("expo-modules-core", () => {
  const actual = jest.requireActual<object>("expo-modules-core");
  return new Proxy(actual, {
    get: (target, prop, receiver) =>
      prop === "requireOptionalNativeModule"
        ? (name: string) => mockRequire(name)
        : Reflect.get(target, prop, receiver),
  });
});

function load() {
  let mod!: typeof import("../index");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../index");
  });
  return mod.HelmetLinkService;
}

/** 早期原生包只有这五个方法（网络锁、麦克风类型、启动管理、闹钟警报都是后来加的） */
const oldNative = (): Native => ({
  start: jest.fn(),
  stop: jest.fn(),
  isRunning: jest.fn(() => true),
  isIgnoringBatteryOptimizations: jest.fn(() => false),
  requestIgnoreBatteryOptimizations: jest.fn(),
});
const fullNative = (): Native => ({
  ...oldNative(),
  holdNetwork: jest.fn(),
  releaseNetwork: jest.fn(),
  setMicrophone: jest.fn(() => true),
  openAppLaunchSettings: jest.fn(() => "launch"),
  startSosAlarm: jest.fn(),
  stopSosAlarm: jest.fn(),
  setSosAlarmUrgent: jest.fn(),
  wakeAfter: jest.fn(),
  cancelWake: jest.fn(),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
});

/** 不可用时：每个方法都能放心调、不抛，查询类给「不用管」的默认值 */
function expectInert(svc: ReturnType<typeof load>) {
  expect(svc.available).toBe(false);
  expect(() => {
    svc.start("t", "x");
    svc.stop();
    svc.requestIgnoreBatteryOptimizations();
    svc.holdNetwork(1000);
    svc.releaseNetwork();
    svc.startSosAlarm(1000);
    svc.stopSosAlarm();
    svc.setSosAlarmUrgent(true);
  }).not.toThrow();
  expect(svc.isRunning()).toBe(false);
  // iOS / 不可用时当作已忽略电池优化：不弹引导
  expect(svc.isIgnoringBatteryOptimizations()).toBe(true);
  expect(svc.setMicrophone(true, "a", "b")).toBe(false);
  // 调用方据此退回 expo-audio + 触感
  expect(svc.sosAlarmAvailable).toBe(false);
  expect(svc.openAppLaunchSettings()).toBe("none");
}

beforeEach(() => {
  mockRequire.mockClear();
});

describe("HelmetLinkService", () => {
  it("iOS：不去取原生模块，所有方法空操作（即使有同名模块也不碰）", () => {
    mockPlatform.OS = "ios";
    mockNative = fullNative();
    const svc = load();
    expect(mockRequire).not.toHaveBeenCalled();
    expectInert(svc);
    for (const fn of Object.values(mockNative))
      expect(fn).not.toHaveBeenCalled();
  });

  it("安卓但原生没链接上（模拟器 / 没 prebuild）：按名字取一次，取不到就全部空操作", () => {
    mockPlatform.OS = "android";
    mockNative = null;
    const svc = load();
    expect(mockRequire).toHaveBeenCalledWith("HelmetLinkService");
    expectInert(svc);
  });

  it("网络锁只延长不缩短（10-25 审查）：持着 90 s 时再要 20 s 不转给原生（原生会按 20 s 重新拿锁）；更长的照转；放锁后重新计", () => {
    jest.useFakeTimers();
    try {
      mockPlatform.OS = "android";
      const n = (mockNative = fullNative());
      const svc = load();
      svc.holdNetwork(90_000);
      svc.holdNetwork(20_000);
      expect(n.holdNetwork).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(80_000);
      svc.holdNetwork(20_000); // 还剩 10 s：延到 20 s 后
      expect(n.holdNetwork).toHaveBeenLastCalledWith(20_000);
      expect(n.holdNetwork).toHaveBeenCalledTimes(2);
      svc.releaseNetwork();
      svc.holdNetwork(5_000);
      expect(n.holdNetwork).toHaveBeenLastCalledWith(5_000);
      expect(n.holdNetwork).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  describe("手机时钟往回拨之后，高危事件的 90 s 持锁不能被跳过", () => {
    const t0 = 1_800_000_000_000;
    const armed = () => {
      jest.useFakeTimers();
      jest.setSystemTime(t0);
      mockPlatform.OS = "android";
      const n = (mockNative = fullNative());
      const svc = load();
      svc.holdNetwork(90_000);
      expect(n.holdNetwork).toHaveBeenCalledTimes(1);
      return { n, svc };
    };
    afterEach(() => {
      jest.useRealTimers();
    });

    it("拨回很久（24 小时）：照转给原生，之后恢复只延长不缩短", () => {
      const { n, svc } = armed();
      jest.setSystemTime(t0 - 24 * 3600_000);
      svc.holdNetwork(90_000);
      expect(n.holdNetwork).toHaveBeenCalledTimes(2);
      svc.holdNetwork(20_000);
      expect(n.holdNetwork).toHaveBeenCalledTimes(2);
    });

    it("拨回得比上次拿锁之后走过的时间还少：不用复位也不会跳过（新的 90 s 总比上次的晚到期）", () => {
      const { n, svc } = armed();
      jest.setSystemTime(t0 + 60_000 - 30_000);
      svc.holdNetwork(90_000);
      expect(n.holdNetwork).toHaveBeenCalledTimes(2);
    });
  });

  it("安卓、原生齐全：逐个转给原生，参数原样（求救警报时长取整、麦克风文案默认空串）", () => {
    mockPlatform.OS = "android";
    const n = (mockNative = fullNative());
    const svc = load();
    expect(svc.available).toBe(true);
    svc.start("头盔链路", "保持连接中");
    expect(n.start).toHaveBeenCalledWith("头盔链路", "保持连接中");
    svc.stop();
    expect(n.stop).toHaveBeenCalledTimes(1);
    expect(svc.isRunning()).toBe(true);
    expect(svc.isIgnoringBatteryOptimizations()).toBe(false);
    svc.requestIgnoreBatteryOptimizations();
    expect(n.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    svc.holdNetwork(5000);
    expect(n.holdNetwork).toHaveBeenCalledWith(5000);
    svc.releaseNetwork();
    expect(n.releaseNetwork).toHaveBeenCalledTimes(1);
    expect(svc.setMicrophone(true, "对讲中", "麦克风开着")).toBe(true);
    expect(n.setMicrophone).toHaveBeenLastCalledWith(
      true,
      "对讲中",
      "麦克风开着",
    );
    svc.setMicrophone(false);
    expect(n.setMicrophone).toHaveBeenLastCalledWith(false, "", "");
    expect(svc.sosAlarmAvailable).toBe(true);
    svc.startSosAlarm(1234.6);
    expect(n.startSosAlarm).toHaveBeenCalledWith(1235);
    n.startSosAlarm.mockClear();
    svc.startSosAlarm(90_000, 49_999.6);
    expect(n.startSosAlarm).toHaveBeenCalledWith(90_000, 50_000);
    svc.setSosAlarmUrgent(true);
    expect(n.setSosAlarmUrgent).toHaveBeenCalledWith(true);
    svc.stopSosAlarm();
    expect(n.stopSosAlarm).toHaveBeenCalledTimes(1);
  });

  it("「应用启动管理」：只认 launch / details，原生回别的都当没打开", () => {
    mockPlatform.OS = "android";
    const n = (mockNative = fullNative());
    const svc = load();
    expect(svc.openAppLaunchSettings()).toBe("launch");
    n.openAppLaunchSettings.mockReturnValue("details");
    expect(svc.openAppLaunchSettings()).toBe("details");
    for (const weird of ["", "settings", null, undefined, 1]) {
      n.openAppLaunchSettings.mockReturnValue(weird);
      expect(svc.openAppLaunchSettings()).toBe("none");
    }
  });

  it("原生包比 JS 旧（缺后加的方法）：老方法照常转，新方法静默跳过、不抛，警报退回 expo-audio", () => {
    mockPlatform.OS = "android";
    const n = (mockNative = oldNative());
    const svc = load();
    expect(svc.available).toBe(true);
    svc.start("t", "x");
    expect(n.start).toHaveBeenCalledWith("t", "x");
    expect(svc.isRunning()).toBe(true);
    expect(() => {
      svc.holdNetwork(1000);
      svc.releaseNetwork();
      svc.startSosAlarm(60_000);
      svc.stopSosAlarm();
      svc.setSosAlarmUrgent(false);
    }).not.toThrow();
    expect(svc.setMicrophone(true)).toBe(false);
    expect(svc.sosAlarmAvailable).toBe(false);
    expect(svc.openAppLaunchSettings()).toBe("none");
  });

  it("backgroundWake：原生到点叫一次；取消后不叫；原生包旧 / iOS 时空操作（调用方还有 setTimeout）", () => {
    const n = fullNative();
    mockNative = n;
    const svc = load();
    const first = jest.fn();
    const second = jest.fn();
    const cancelFirst = svc.backgroundWake(2000.4, first);
    const cancelSecond = svc.backgroundWake(5000, second);
    expect(n.addListener).toHaveBeenCalledTimes(1);
    expect(n.wakeAfter).toHaveBeenNthCalledWith(1, expect.any(Number), 2000);
    const fire = n.addListener.mock.calls[0][1] as (e: { id: number }) => void;
    const firstId = n.wakeAfter.mock.calls[0][0] as number;
    const secondId = n.wakeAfter.mock.calls[1][0] as number;

    fire({ id: firstId });
    fire({ id: firstId }); // 重复的事件不再叫一次
    expect(first).toHaveBeenCalledTimes(1);
    cancelFirst(); // 已经到点的不用再去取消
    expect(n.cancelWake).not.toHaveBeenCalled();

    cancelSecond();
    expect(n.cancelWake).toHaveBeenCalledWith(secondId);
    fire({ id: secondId });
    expect(second).not.toHaveBeenCalled();

    mockNative = oldNative();
    const old = load();
    const cb = jest.fn();
    expect(() => old.backgroundWake(1000, cb)()).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});
