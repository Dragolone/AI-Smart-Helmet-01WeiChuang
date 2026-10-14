// 口径本身只有一份（constants/event-types.ts），这里守住它的内容不被误改。
import { describe, expect, it } from "@jest/globals";

import { RISK_ALERT_TYPES, RISK_ALERT_TYPE_PARAM } from "../event-types";

describe("风险提醒口径", () => {
  it("雷达类提醒与解除都在列", () => {
    expect(RISK_ALERT_TYPES).toEqual([
      "collision_risk",
      "obstacle_risk",
      "risk_cleared",
    ]);
  });

  it("求救触发事件不混进提醒列表：它们以求救单的形式进「SOS 记录」，混进来同一件事会出现两次", () => {
    for (const trigger of ["possible_fall", "manual_sos"]) {
      expect(RISK_ALERT_TYPES as readonly string[]).not.toContain(trigger);
    }
  });

  it("不混入 device_status / location_update 这类噪音（决策 #27）", () => {
    for (const noise of ["device_status", "location_update", "video_ready"]) {
      expect(RISK_ALERT_TYPES as readonly string[]).not.toContain(noise);
    }
  });

  it("查询参数是逗号串，且无空格（API.md §6 多值格式）", () => {
    expect(RISK_ALERT_TYPE_PARAM).toBe(RISK_ALERT_TYPES.join(","));
    expect(RISK_ALERT_TYPE_PARAM).not.toMatch(/\s/);
  });
});
