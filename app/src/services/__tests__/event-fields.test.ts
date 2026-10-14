// 事件字段挑选：风险提醒详情和 SOS 记录详情共用这一份，守住两类记录各自该看到的量（REGRESSION 5.7）。
import { describe, expect, it } from "@jest/globals";

import { readableEventFields } from "../event-fields";

// 测试里不关心翻译，文案 key 原样返回
const t = (key: string) => key;
const labels = (payload: Record<string, unknown>) =>
  readableEventFields(payload, t as never).map((f) => `${f.label}=${f.value}`);

describe("readableEventFields", () => {
  it("碰撞风险：方向 / 目标 / 距离 / 碰撞时间 / 逼近速度 / 置信度，带单位", () => {
    expect(
      labels({
        riskLevel: "high",
        direction: "rear",
        objectType: "vehicle",
        distance: 9,
        ttcSeconds: 1.84,
        approachSpeedKmh: 54.6,
        confidence: 0.92,
      }),
    ).toEqual([
      "events.field.direction=events.dir.rear",
      "events.field.object=events.obj.vehicle",
      "events.field.distance=9.0 m",
      "events.field.ttc=1.8 s",
      "events.field.approachSpeed=55 km/h",
      "events.field.confidence=92%",
    ]);
  });

  it("疑似摔倒：冲击力与倾角——SOS 记录详情靠它显示", () => {
    expect(labels({ impactG: 4.5, tiltDeg: 85, confidence: 0.95 })).toEqual([
      "events.field.impact=4.5 g",
      "events.field.tilt=85°",
      "events.field.confidence=95%",
    ]);
  });

  it("手动求救：触发方式与按键时长", () => {
    expect(
      labels({ triggerMode: "long_press", pressDurationMs: 2300 }),
    ).toEqual([
      "events.field.triggerMode=events.trigger.longPress",
      "events.field.pressDuration=2.3 s",
    ]);
  });

  it("认不出的枚举值原样显示，不吞掉；没有可显示的字段时返回空（页面不占位）", () => {
    expect(labels({ direction: "above" })).toEqual([
      "events.field.direction=above",
    ]);
    expect(labels({ triggerMode: "shake" })).toEqual([]);
    expect(labels({})).toEqual([]);
  });

  it("类型不对的字段跳过，不显示成 NaN", () => {
    expect(labels({ distance: "9", confidence: null, impactG: "x" })).toEqual(
      [],
    );
  });
});
