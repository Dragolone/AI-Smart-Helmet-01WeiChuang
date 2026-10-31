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
  notePersistFailure,
} from "@/services/persist-notice";

const mockToast = jest.fn((_message: string) => undefined);
jest.mock("@/components/toast-bus", () => ({
  showToast: (message: string) => mockToast(message),
}));
jest.mock("@/i18n", () => ({ translate: (key: string) => `t:${key}` }));

describe("本机落盘失败的提示（O37，10-31 存储满实测）", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-31T10:00:00Z"));
    mockToast.mockClear();
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
});
