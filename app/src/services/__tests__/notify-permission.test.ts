// 通知权限四态：「还没问过」和「查不到」都不能被当成已开启，也不能被当成被拒。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetPermissions = jest.fn<() => Promise<unknown>>();
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: () => mockGetPermissions(),
}));
/** 登录后那一次系统通知授权申请（services/sos-alert.ts 的 ensureSosAlertPermission） */
const mockEnsure = jest.fn<() => Promise<void>>();
jest.mock("@/services/sos-alert", () => ({
  ensureSosAlertPermission: () => mockEnsure(),
}));

import {
  readNotifyPermission,
  readNotifyPermissionAfterAsk,
} from "../notify-permission";

beforeEach(() => {
  mockGetPermissions.mockReset();
  mockEnsure.mockReset();
});

describe("readNotifyPermission", () => {
  it("已授权", async () => {
    mockGetPermissions.mockResolvedValue({ granted: true, status: "granted" });
    expect(await readNotifyPermission()).toBe("granted");
  });

  it("被拒", async () => {
    mockGetPermissions.mockResolvedValue({ granted: false, status: "denied" });
    expect(await readNotifyPermission()).toBe("denied");
  });

  it("系统还没问过用户：不是被拒，也不是已开启", async () => {
    mockGetPermissions.mockResolvedValue({
      granted: false,
      status: "undetermined",
    });
    expect(await readNotifyPermission()).toBe("undetermined");
  });

  it("查询本身失败：未知，不替用户下结论", async () => {
    mockGetPermissions.mockRejectedValue(new Error("boom"));
    expect(await readNotifyPermission()).toBe("unknown");
  });
});

// Android 13+ 全新安装第一次登录：系统的通知授权框还开着时，库里查到的已经是 denied（分不出「还没问过」）。
// 界面这时去读，会在系统框下面先弹好「通知未开启」，用户点了「允许」它也还在（2026-10-08 模拟器实测）。
describe("readNotifyPermissionAfterAsk", () => {
  it("系统的授权框还没有结果：先不读；有结果后读到的是用户选的", async () => {
    let answered: () => void = () => undefined;
    mockEnsure.mockReturnValue(
      new Promise<void>((resolve) => {
        answered = resolve;
      }),
    );
    // 框还开着：这时查是 denied；用户点「允许」之后是 granted
    mockGetPermissions.mockResolvedValue({ granted: false, status: "denied" });
    const reading = readNotifyPermissionAfterAsk();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockGetPermissions).not.toHaveBeenCalled();

    mockGetPermissions.mockResolvedValue({ granted: true, status: "granted" });
    answered();
    expect(await reading).toBe("granted");
    expect(mockGetPermissions).toHaveBeenCalledTimes(1);
  });

  it("用户在系统框里点了不允许：读到被拒", async () => {
    mockEnsure.mockResolvedValue(undefined);
    mockGetPermissions.mockResolvedValue({ granted: false, status: "denied" });
    expect(await readNotifyPermissionAfterAsk()).toBe("denied");
  });

  it("申请本身出错：不拦着读", async () => {
    mockEnsure.mockRejectedValue(new Error("boom"));
    mockGetPermissions.mockResolvedValue({ granted: true, status: "granted" });
    expect(await readNotifyPermissionAfterAsk()).toBe("granted");
  });
});
