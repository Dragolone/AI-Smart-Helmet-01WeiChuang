// 口径本身只有一份（constants/event-types.ts），这里守住它的内容不被误删。
import { describe, expect, it } from "@jest/globals";

import { SAFETY_EVENT_TYPES, SAFETY_EVENT_TYPE_PARAM } from "../event-types";

describe("安全事件口径", () => {
  it("保命相关的两类必须在列（漏了用户就看不到自己按过求救）", () => {
    expect(SAFETY_EVENT_TYPES).toContain("possible_fall");
    expect(SAFETY_EVENT_TYPES).toContain("manual_sos");
  });

  it("不混入 device_status / location_update 这类噪音（决策 #27）", () => {
    for (const noise of ["device_status", "location_update", "video_ready"]) {
      expect(SAFETY_EVENT_TYPES as readonly string[]).not.toContain(noise);
    }
  });

  it("查询参数是逗号串，且无空格（API.md §6 多值格式）", () => {
    expect(SAFETY_EVENT_TYPE_PARAM).toBe(SAFETY_EVENT_TYPES.join(","));
    expect(SAFETY_EVENT_TYPE_PARAM).not.toMatch(/\s/);
  });
});
