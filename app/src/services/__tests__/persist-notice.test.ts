import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import {
  __resetPersistNoticeForTests,
  LOW_DISK_BYTES,
  notePersistFailure,
  warnIfDiskLow,
} from "@/services/persist-notice";

const mockToast = jest.fn((_message: string) => undefined);
jest.mock("@/components/toast-bus", () => ({
  showToast: (message: string) => mockToast(message),
}));
jest.mock("@/i18n", () => ({
  translate: (key: string, params?: Record<string, unknown>) =>
    params ? `t:${key}:${JSON.stringify(params)}` : `t:${key}`,
}));
const mockDisk = { free: 10 * 1024 * 1024 * 1024 };
jest.mock("expo-file-system", () => ({
  Paths: {
    get availableDiskSpace() {
      return mockDisk.free;
    },
  },
}));

describe("本机落盘失败的提示（O37，10-31 存储满实测）", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-31T10:00:00Z"));
    mockToast.mockClear();
    mockDisk.free = 10 * 1024 * 1024 * 1024;
    __resetPersistNoticeForTests();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("三类失败各有自己的文案：登录没存上 / 退出没清掉 / 设置没存上", () => {
    notePersistFailure("login", new Error("ENOSPC"));
    notePersistFailure("logout", new Error("ENOSPC"));
    notePersistFailure("setting", new Error("ENOSPC"));
    expect(mockToast.mock.calls.map((c) => c[0])).toEqual([
      "t:persist.loginNotSaved",
      "t:persist.logoutIncomplete",
      "t:persist.settingNotSaved",
    ]);
  });

  it("同一类 10 秒内只提示一次（存储满时连改几项设置不刷屏），过了再提示；不同类互不影响", () => {
    notePersistFailure("setting", new Error("ENOSPC"));
    jest.setSystemTime(new Date("2026-10-31T10:00:05Z"));
    notePersistFailure("setting", new Error("ENOSPC"));
    notePersistFailure("login", new Error("ENOSPC"));
    expect(mockToast).toHaveBeenCalledTimes(2);
    jest.setSystemTime(new Date("2026-10-31T10:00:11Z"));
    notePersistFailure("setting", new Error("ENOSPC"));
    expect(mockToast).toHaveBeenCalledTimes(3);
    expect(mockToast.mock.calls[2][0]).toBe("t:persist.settingNotSaved");
  });

  // 安卓 expo-secure-store 写失败不抛，只能写完看剩余空间
  it("写成功后看剩余空间：少于 64 MB 提示「可能没存上」并带 MB 数；够用不提示；同类 10 秒内只一次", () => {
    warnIfDiskLow("login");
    expect(mockToast).not.toHaveBeenCalled();
    mockDisk.free = LOW_DISK_BYTES - 1;
    warnIfDiskLow("login");
    expect(mockToast).toHaveBeenCalledWith('t:persist.lowSpaceLogin:{"mb":64}');
    mockDisk.free = 16 * 1024 * 1024;
    warnIfDiskLow("setting");
    warnIfDiskLow("login");
    expect(mockToast.mock.calls.map((c) => c[0])).toEqual([
      't:persist.lowSpaceLogin:{"mb":64}',
      't:persist.lowSpaceSetting:{"mb":16}',
    ]);
  });

  it("查不到剩余空间（不是数字）不提示也不抛", () => {
    mockDisk.free = Number.NaN;
    warnIfDiskLow("setting");
    expect(mockToast).not.toHaveBeenCalled();
  });
});
