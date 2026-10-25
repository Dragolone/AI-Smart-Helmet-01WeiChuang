// 优化清单 8：设备状态 / 频道字段在入口规整——越界、错类型的不往页面上送，合法的原样保留
import { describe, expect, it } from "@jest/globals";
import type { VoiceChannel } from "@helmet/shared";

import {
  normalizeChannel,
  normalizeDevice,
  normalizeStatus,
} from "../device-shape";

const good = {
  online: true,
  lastSeenAt: "2026-10-25T01:00:00.000Z",
  battery: 0,
  charging: false,
  signalLevel: 4,
  sleeping: false,
  firmwareVersion: "1.2.0",
};

describe("normalizeStatus", () => {
  it("合法的值原样保留（电量 0、不在充电 false 也是合法值）", () => {
    expect(normalizeStatus(good)).toEqual(good);
    expect(normalizeStatus({ ...good, battery: 100, charging: null })).toEqual({
      ...good,
      battery: 100,
      charging: null,
    });
  });

  it("10-22 改写应答见过的：电量 -50 / 150 / 'x' → 没有；在线 'yes'、休眠 1 → false；充电 'no' → 不知道（不再当成充电中）", () => {
    for (const battery of [-50, 150, "x", Number.NaN, null, undefined]) {
      expect(normalizeStatus({ ...good, battery }).battery).toBeNull();
    }
    const s = normalizeStatus({
      online: "yes",
      sleeping: 1,
      charging: "no",
      signalLevel: {},
      lastSeenAt: "nope",
      firmwareVersion: 5,
    });
    expect(s).toMatchObject({
      online: false,
      sleeping: false,
      charging: null,
      signalLevel: null,
      lastSeenAt: null,
      firmwareVersion: null,
      battery: null,
    });
  });

  it("别的字段（设备号等）原样带着", () => {
    expect(normalizeStatus({ ...good, deviceId: "h1" }).deviceId).toBe("h1");
  });
});

describe("normalizeDevice", () => {
  it("没有字符串设备号的不是头盔：返回 null 由调用方丢掉", () => {
    for (const bad of [
      null,
      "x",
      42,
      [],
      {},
      { deviceId: 7 },
      { deviceId: "" },
    ]) {
      expect(normalizeDevice(bad)).toBeNull();
    }
  });

  it("名字 / 绑定码不是字符串时当没有，状态字段同 normalizeStatus", () => {
    const d = normalizeDevice({
      ...good,
      deviceId: "h1",
      name: 12345,
      bindCode: { x: 1 },
      boundAt: "bad",
      createdAt: "2026-10-01T00:00:00.000Z",
      battery: "x",
    });
    expect(d).toMatchObject({
      deviceId: "h1",
      name: null,
      bindCode: null,
      boundAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      battery: null,
      online: true,
    });
  });
});

describe("normalizeChannel", () => {
  const ch = (memberCount: unknown) =>
    ({ channelId: "c1", name: "车队", memberCount }) as unknown as VoiceChannel;
  it("成员数是非负整数原样；undefined / 字符串 / 负数 / 小数按 0（不再写「undefined 位成员」）", () => {
    expect(normalizeChannel(ch(20)).memberCount).toBe(20);
    expect(normalizeChannel(ch(0)).memberCount).toBe(0);
    for (const bad of [undefined, null, "3", -1, 2.5, Number.NaN]) {
      expect(normalizeChannel(ch(bad)).memberCount).toBe(0);
    }
  });
});
