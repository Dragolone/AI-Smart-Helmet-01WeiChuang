// 事件字段的边界补测（2026-10-16）：枚举值撞上 Object.prototype 的成员名、数值的 0 / 负数 / 越界 / 四舍五入、
// 字段顺序、三种语言下的真实文案。载荷来自服务端 JSON（硬件经 App 中转），不会出现 NaN / Infinity。
import { describe, expect, it } from "@jest/globals";

import { translate, type MessageKey, type Params } from "@/i18n";
import { readableEventFields } from "../event-fields";

const keyT = (key: string) => key;
const labels = (payload: Record<string, unknown>) =>
  readableEventFields(payload, keyT as never).map(
    (f) => `${f.label}=${f.value}`,
  );

describe("枚举值是 Object.prototype 的成员名", () => {
  // 原来 DIRECTION_LABEL["constructor"] 取到 Object 函数，当成文案 key 交给翻译，显示出来是空白
  it.each([
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
  ])("方向 / 目标是「%s」：按认不出的值原样显示，不是空白", (name) => {
    expect(labels({ direction: name })).toEqual([
      `events.field.direction=${name}`,
    ]);
    expect(labels({ objectType: name })).toEqual([
      `events.field.object=${name}`,
    ]);
  });

  it("用真的翻译跑一遍：值始终是字符串，不会是 undefined", () => {
    const t = (key: MessageKey, params?: Params) =>
      translate(key, params, "zh-CN");
    for (const name of ["constructor", "__proto__", "toString"]) {
      const fields = readableEventFields(
        { direction: name, objectType: name },
        t,
      );
      for (const f of fields) {
        expect(typeof f.value).toBe("string");
        expect(f.value).toBe(name);
      }
    }
  });
});

describe("数值的边", () => {
  it("0 照常显示（不当成没有）", () => {
    expect(
      labels({
        distance: 0,
        ttcSeconds: 0,
        approachSpeedKmh: 0,
        impactG: 0,
        tiltDeg: 0,
        pressDurationMs: 0,
        confidence: 0,
      }),
    ).toEqual([
      "events.field.distance=0.0 m",
      "events.field.ttc=0.0 s",
      "events.field.approachSpeed=0 km/h",
      "events.field.impact=0.0 g",
      "events.field.tilt=0°",
      "events.field.pressDuration=0.0 s",
      "events.field.confidence=0%",
    ]);
  });

  it("四舍五入的边：置信度 0.005 进到 1%、0.004 是 0%", () => {
    expect(labels({ confidence: 0.005 })).toEqual([
      "events.field.confidence=1%",
    ]);
    expect(labels({ confidence: 0.004 })).toEqual([
      "events.field.confidence=0%",
    ]);
    expect(labels({ tiltDeg: 89.5 })).toEqual(["events.field.tilt=90°"]);
    expect(labels({ approachSpeedKmh: 54.49 })).toEqual([
      "events.field.approachSpeed=54 km/h",
    ]);
    expect(labels({ pressDurationMs: 1949 })).toEqual([
      "events.field.pressDuration=1.9 s",
    ]);
  });

  it("越界的值原样显示，不夹到范围里（现状：置信度 1.5 写 150%，距离 -1 写 -1.0 m）", () => {
    expect(labels({ confidence: 1.5 })).toEqual([
      "events.field.confidence=150%",
    ]);
    expect(labels({ distance: -1 })).toEqual(["events.field.distance=-1.0 m"]);
    expect(labels({ tiltDeg: 359.6 })).toEqual(["events.field.tilt=360°"]);
  });

  it("负零不显示成「-0」", () => {
    expect(labels({ tiltDeg: -0.4, approachSpeedKmh: -0 })).toEqual([
      "events.field.approachSpeed=0 km/h",
      "events.field.tilt=0°",
    ]);
  });

  it("布尔、数组、对象、数字字符串这些类型不对的都跳过", () => {
    expect(
      labels({
        direction: 1,
        objectType: ["vehicle"],
        distance: true,
        ttcSeconds: { v: 1 },
        impactG: "4.5",
        triggerMode: 1,
        pressDurationMs: "2300",
      }),
    ).toEqual([]);
  });
});

describe("触发方式与顺序", () => {
  it("双击写成双击；大小写不同的写法不认（协议里就是小写下划线）", () => {
    expect(labels({ triggerMode: "double_click" })).toEqual([
      "events.field.triggerMode=events.trigger.doubleClick",
    ]);
    expect(labels({ triggerMode: "LONG_PRESS" })).toEqual([]);
  });

  it("字段一律按固定顺序出（方向、目标、距离、碰撞时间、逼近速度、冲击力、倾角、触发方式、按键时长、置信度），和载荷里的先后无关", () => {
    const out = readableEventFields(
      {
        confidence: 0.9,
        pressDurationMs: 1000,
        triggerMode: "long_press",
        tiltDeg: 10,
        impactG: 2,
        approachSpeedKmh: 10,
        ttcSeconds: 1,
        distance: 1,
        objectType: "vehicle",
        direction: "front",
      },
      keyT as never,
    ).map((f) => f.label);
    expect(out).toEqual([
      "events.field.direction",
      "events.field.object",
      "events.field.distance",
      "events.field.ttc",
      "events.field.approachSpeed",
      "events.field.impact",
      "events.field.tilt",
      "events.field.triggerMode",
      "events.field.pressDuration",
      "events.field.confidence",
    ]);
  });

  it("三种语言下方向、目标都有译文，且互不相同", () => {
    const values = (["zh-CN", "zh-TW", "en"] as const).map((loc) =>
      readableEventFields(
        { direction: "left", objectType: "pedestrian" },
        (key, params) => translate(key, params, loc),
      )
        .map((f) => f.value)
        .join("|"),
    );
    expect(new Set(values).size).toBe(3);
    for (const v of values) expect(v).not.toMatch(/events\./);
  });
});
