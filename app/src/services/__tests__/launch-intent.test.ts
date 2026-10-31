import { describe, expect, it, jest } from "@jest/globals";

const mockLast = jest.fn((): unknown => null);
jest.mock("expo-notifications", () => ({
  getLastNotificationResponse: () => mockLast(),
}));

import { launchedByNotification } from "../launch-intent";

describe("launchedByNotification", () => {
  it("由通知拉起（点横幅或点按钮）→ true，开屏不播；平常打开 / 读取抛错 → false", () => {
    mockLast.mockReset();
    mockLast.mockReturnValue({
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
    });
    expect(launchedByNotification()).toBe(true);
    mockLast.mockReturnValue({ actionIdentifier: "cancel" });
    expect(launchedByNotification()).toBe(true);
    mockLast.mockReturnValue(null);
    expect(launchedByNotification()).toBe(false);
    mockLast.mockReturnValue(undefined);
    expect(launchedByNotification()).toBe(false);
    mockLast.mockImplementation(() => {
      throw new Error("native");
    });
    expect(launchedByNotification()).toBe(false);
  });
});
