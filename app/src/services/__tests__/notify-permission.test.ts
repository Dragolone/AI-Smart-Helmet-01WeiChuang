// 通知权限四态：「还没问过」和「查不到」都不能被当成已开启，也不能被当成被拒。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetPermissions = jest.fn<() => Promise<unknown>>();
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: () => mockGetPermissions(),
}));

// eslint-disable-next-line import/first
import { readNotifyPermission } from "../notify-permission";

beforeEach(() => {
  mockGetPermissions.mockReset();
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
