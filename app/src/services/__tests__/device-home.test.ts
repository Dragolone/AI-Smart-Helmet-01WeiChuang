// 设备页（首页标签）的推导：大图大小、其他设备的排序、「安全」那一格和状态药丸写什么。
import { describe, expect, it } from "@jest/globals";
import type { DevicePublic } from "@helmet/shared";

import {
  RING_MAX,
  RING_MIN,
  arcSegment,
  heroRingSize,
  linkPillOf,
  otherDevicesOf,
  safetyTileOf,
} from "../device-home";

const dev = (deviceId: string, online: boolean): DevicePublic => ({
  deviceId,
  name: null,
  bindCode: null,
  boundAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  online,
  lastSeenAt: null,
  battery: null,
  charging: null,
  signalLevel: null,
  sleeping: false,
  firmwareVersion: null,
});

describe("heroRingSize：大图随设备数缩小，一屏放不下才滚动", () => {
  // 390 × 844 的手机上，滚动区大约 698 高
  const viewport = 698;

  it("一两台时用足 280", () => {
    expect(heroRingSize(viewport, 0)).toBe(RING_MAX);
    expect(heroRingSize(viewport, 1)).toBe(RING_MAX);
  });

  it("三台开始缩小，四台到下限 200，仍在一屏内", () => {
    const three = heroRingSize(viewport, 2);
    expect(three).toBeLessThan(RING_MAX);
    expect(three).toBeGreaterThan(RING_MIN);
    expect(heroRingSize(viewport, 3)).toBe(RING_MIN);
  });

  it("再多也不小于 200（页面改为滚动）", () => {
    expect(heroRingSize(viewport, 8)).toBe(RING_MIN);
    expect(heroRingSize(480, 0)).toBe(RING_MIN);
  });

  it("屏幕更高时也不超过 280", () => {
    expect(heroRingSize(1200, 0)).toBe(RING_MAX);
  });
});

describe("otherDevicesOf：除当前头盔外的全部，连着的排前面", () => {
  const a = dev("a", false);
  const b = dev("b", true);
  const c = dev("c", false);
  const d = dev("d", true);
  const linked = (x: DevicePublic) => x.online;

  it("不含当前头盔", () => {
    expect(otherDevicesOf([a, b], "b", linked).map((x) => x.deviceId)).toEqual([
      "a",
    ]);
    expect(otherDevicesOf([b], "b", linked)).toEqual([]);
  });

  it("连着的在前，各组内保持原有先后", () => {
    expect(
      otherDevicesOf([a, b, c, d], "b", linked).map((x) => x.deviceId),
    ).toEqual(["d", "a", "c"]);
  });
});

describe("safetyTileOf：与安全页状态卡同一口径", () => {
  it("配置正常", () => {
    expect(safetyTileOf("ready", "connected")).toEqual({
      text: "devices.safety.ready",
      tone: "ok",
    });
  });

  it("没连上是提醒色，并写清是哪一种", () => {
    expect(safetyTileOf("linkDown", "searching")).toEqual({
      text: "devices.safety.linkDown",
      tone: "warn",
    });
    expect(safetyTileOf("linkDown", "offline").tone).toBe("warn");
    expect(safetyTileOf("linkDown", "bluetoothOff")).toEqual({
      text: "safety.link.bluetoothOff",
      tone: "warn",
    });
    expect(safetyTileOf("linkDown", "bluetoothDenied").text).toBe(
      "safety.link.bluetoothDenied",
    );
  });

  it("红色只留给身份不符", () => {
    expect(safetyTileOf("linkDown", "mismatch")).toEqual({
      text: "safety.link.mismatch",
      tone: "fault",
    });
  });

  it("通知关着、没有联系人各写各的", () => {
    expect(safetyTileOf("notifyOff", "connected").text).toBe(
      "safety.state.notifyOff",
    );
    expect(safetyTileOf("noContacts", "connected")).toEqual({
      text: "devices.safety.noContacts",
      tone: "warn",
    });
  });

  it("确认不了的不算正常，也不亮提醒色", () => {
    expect(safetyTileOf("unknown", "unknown")).toEqual({
      text: "devices.safety.unknown",
      tone: "unknown",
    });
  });
});

describe("linkPillOf：大图下面的连接状态", () => {
  it("本机连着 / 另一条通道带着 都算连着", () => {
    expect(linkPillOf("connected")).toMatchObject({
      text: "devices.link.connected",
      linked: true,
    });
    expect(linkPillOf("online")).toMatchObject({
      text: "common.online",
      linked: true,
    });
  });

  it("搜索中单独说明并带呼吸点", () => {
    expect(linkPillOf("searching")).toEqual({
      text: "devices.link.searching",
      linked: false,
      searching: true,
    });
  });

  it("其余没连上的情况只写未连接（原因在「安全」那一格）", () => {
    for (const link of [
      "bluetoothOff",
      "bluetoothDenied",
      "disconnected",
      "mismatch",
      "offline",
    ] as const) {
      expect(linkPillOf(link)).toEqual({
        text: "devices.link.notConnected",
        linked: false,
        searching: false,
      });
    }
  });

  it("状态拿不到时不说未连接", () => {
    expect(linkPillOf("unknown").text).toBe("devices.link.unknown");
  });
});

describe("arcSegment：270° 的电量环分三段画", () => {
  it("每段依次走满", () => {
    expect([0, 1, 2].map((i) => arcSegment(0, i))).toEqual([0, 0, 0]);
    expect([0, 1, 2].map((i) => arcSegment(1, i))).toEqual([1, 1, 1]);
    expect(arcSegment(0.5, 0)).toBe(1);
    expect(arcSegment(0.5, 1)).toBeCloseTo(0.5);
    expect(arcSegment(0.5, 2)).toBe(0);
  });

  it("越界的进度不出格", () => {
    expect(arcSegment(-0.2, 0)).toBe(0);
    expect(arcSegment(1.4, 2)).toBe(1);
  });
});
