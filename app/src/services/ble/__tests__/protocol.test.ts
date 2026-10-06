// 协议层单测：以手册 v0.6 原文示例帧为夹具，钉住字节级契约。
// 注意：手册示例的十六进制与其标注的十进制不一致（0x6AA27988 = 1789032840 而非 1788856200；
// ED 4E CD 01 = 30.232301 而非 30.256877）——字节流才是契约，本文件以字节为准（已列入 v0.6 勘误）。
import { describe, expect, it } from "@jest/globals";
import { DEVICE_SETTING_KEYS } from "@helmet/shared";

import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  sha1,
  uuidV5,
} from "../bytes";
import {
  buildAck,
  buildRead,
  buildResendData,
  buildTimeSync,
  buildWrite,
  deviceIdFromBytes,
  eventIdFor,
  firmwareFromBytes,
  parseInbound,
  SETTINGS_READ_ADDR,
  SETTINGS_READ_LEN,
  SETTING_REGISTER,
  registersToSettings,
  settingToRegisterWrite,
  translateEvent,
} from "../protocol";

const ctx = {
  deviceId: "helmet_94173f",
  firmwareVersion: "1.0.3",
  receivedAt: new Date("2026-09-16T00:00:00Z"),
};

describe("bytes", () => {
  it("base64 往返（含非 3 倍长度）", () => {
    for (const n of [0, 1, 2, 3, 4, 20]) {
      const src = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(Array.from(base64ToBytes(bytesToBase64(src)))).toEqual(
        Array.from(src),
      );
    }
  });
  it('sha1("abc") = a9993e36…（RFC 3174 向量）', () => {
    const h = sha1(Uint8Array.from(Array.from("abc", (c) => c.charCodeAt(0))));
    expect(bytesToHex(h).replace(/ /g, "")).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });
  it("uuidV5 确定性且符合版本/变体位", () => {
    const a = uuidV5(
      "6f1a4c0e-2b7d-5e3a-9c48-0a2b3c4d5e6f",
      "helmet_94173f:101",
    );
    const b = uuidV5(
      "6f1a4c0e-2b7d-5e3a-9c48-0a2b3c4d5e6f",
      "helmet_94173f:101",
    );
    expect(a).toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      uuidV5("6f1a4c0e-2b7d-5e3a-9c48-0a2b3c4d5e6f", "helmet_94173f:102"),
    ).not.toBe(a);
  });
});

describe("下行指令构造（手册示例）", () => {
  it("例 2 读电量/GPS：02 02 10 0A", () => {
    expect(bytesToHex(buildRead(2, 0x10, 10))).toBe("02 02 10 0a");
  });
  it("例 3 写定位周期：03 03 21 03", () => {
    expect(bytesToHex(buildWrite(3, 0x21, [3]))).toBe("03 03 21 03");
  });
  it("例 5 对时 0x6AA27988 → 04 05 88 79 A2 6A（小端）", () => {
    expect(bytesToHex(buildTimeSync(5, 0x6aa27988))).toBe("04 05 88 79 a2 6a");
    expect(bytesToHex(buildTimeSync(5, 1788856200))).toBe("04 05 88 c7 9f 6a");
  });
  it("例 8 ACK 跌倒 Seq=101：06 01 65 00 00 00 00", () => {
    expect(bytesToHex(buildAck(0x01, 101))).toBe("06 01 65 00 00 00 00");
  });
  it("补传读取：08 07 00 00 03", () => {
    expect(bytesToHex(buildResendData(7, 0, 3))).toBe("08 07 00 00 03");
  });
});

describe("上行解析", () => {
  it("例 2 应答帧：电量 85%、未充电、附带经纬度", () => {
    const r = parseInbound(
      hexToBytes("02 02 00 55 00 ED 4E CD 01 17 7C 29 07"),
    );
    expect(r?.kind).toBe("response");
    if (r?.kind !== "response") return;
    expect([r.ins, r.seq, r.error]).toEqual([2, 2, 0]);
    expect(r.data[0]).toBe(0x55);
  });
  it("例 6 跌倒事件帧 → possible_fall envelope", () => {
    const ev = parseInbound(
      hexToBytes(
        "05 01 65 00 00 00 88 79 A2 6A 5F 2D 55 ED 4E CD 01 17 7C 29 07",
      ),
    );
    expect(ev?.kind).toBe("event");
    if (ev?.kind !== "event") return;
    expect(ev.eventSeq).toBe(101);
    expect(ev.timestamp).toBe(0x6aa27988);
    const env = translateEvent(ev, ctx)!;
    expect(env.eventType).toBe("possible_fall");
    expect(env.eventId).toBe(eventIdFor("helmet_94173f", 101));
    expect(env.timestamp).toBe("2026-09-10T09:34:00.000Z");
    const p = env.payload as Record<string, unknown>;
    expect(p.confidence).toBeCloseTo(0.95);
    expect(p.impactG).toBeCloseTo(4.5);
    expect(p.tiltDeg).toBe(85);
    expect(p.location).toEqual({
      latitude: 30.232301,
      longitude: 120.159255,
      coordinateSystem: "wgs84",
    });
  });
  it("例 7 后方来车碰撞 → collision_risk（high / vehicle / rear / 12.5m / TTC 1.8s / 55km/h）", () => {
    const ev = parseInbound(
      hexToBytes(
        "05 03 66 00 00 00 88 79 A2 6A 03 01 02 7D 00 12 37 ED 4E CD 01 17 7C 29 07",
      ),
    );
    if (ev?.kind !== "event") throw new Error("not event");
    const env = translateEvent(ev, ctx)!;
    expect(env.eventType).toBe("collision_risk");
    const p = env.payload as Record<string, unknown>;
    expect(p).toMatchObject({
      riskLevel: "high",
      objectType: "vehicle",
      direction: "rear",
      distance: 12.5,
      ttcSeconds: 1.8,
      approachSpeedKmh: 55,
    });
  });
  it("未校时（timestamp=0）用接收时刻兜底", () => {
    const ev = parseInbound(hexToBytes("05 07 01 00 00 00 00 00 00 00 55 01"));
    if (ev?.kind !== "event") throw new Error("not event");
    const env = translateEvent(ev, ctx)!;
    expect(env.eventType).toBe("device_status");
    expect(env.timestamp).toBe("2026-09-16T00:00:00.000Z");
    expect(env.payload).toEqual({ battery: 85, charging: true });
  });
  it("位置包：0xFF 精度（无定位）丢弃；0x7FFF 海拔省略；航向 0xFFFF 置 0", () => {
    const noFix = parseInbound(
      hexToBytes(
        "05 06 05 00 00 00 00 00 00 00 ED 4E CD 01 17 7C 29 07 44 00 FF FF FF FF 7F",
      ),
    );
    if (noFix?.kind !== "event") throw new Error("not event");
    expect(translateEvent(noFix, ctx)).toBeNull();
    const ok = parseInbound(
      hexToBytes(
        "05 06 05 00 00 00 00 00 00 00 ED 4E CD 01 17 7C 29 07 44 00 FF FF 05 FF 7F",
      ),
    );
    if (ok?.kind !== "event") throw new Error("not event");
    const env = translateEvent(ok, ctx)!;
    expect(env.payload).toEqual({
      latitude: 30.232301,
      longitude: 120.159255,
      coordinateSystem: "wgs84",
      speed: 6.8,
      heading: 0,
      accuracy: 5,
    });
  });
  it("risk_cleared：全 0 = 清除全部；否则映射到被解除事件的 eventId", () => {
    const all = parseInbound(
      hexToBytes("05 05 09 00 00 00 00 00 00 00 00 00 00 00"),
    );
    const one = parseInbound(
      hexToBytes("05 05 09 00 00 00 00 00 00 00 66 00 00 00"),
    );
    if (all?.kind !== "event" || one?.kind !== "event")
      throw new Error("not event");
    expect(translateEvent(all, ctx)!.payload).toEqual({});
    expect(translateEvent(one, ctx)!.payload).toEqual({
      clearedEventId: eventIdFor("helmet_94173f", 102),
    });
  });
  it("未知事件码 / 周期事件载荷过短 → null；帧过短 → null", () => {
    const unknown = parseInbound(hexToBytes("05 09 01 00 00 00 00 00 00 00"));
    if (unknown?.kind !== "event") throw new Error("not event");
    expect(translateEvent(unknown, ctx)).toBeNull();
    const short = parseInbound(hexToBytes("05 07 01 00 00 00 00 00 00 00 5F"));
    if (short?.kind !== "event") throw new Error("not event");
    expect(translateEvent(short, ctx)).toBeNull();
    expect(parseInbound(hexToBytes("05"))).toBeNull();
  });
  it("摔倒 / 求救的载荷不全也要上云：能解的字段照填、缺的省略——App 已 ACK、头盔已擦除，丢了就没人知道这次摔倒", () => {
    // 21 字节的摔倒帧被 20 字节的 Notify 截掉最后 1 字节（MTU 没协商上去）：位置少一截，其余还在
    const cut = parseInbound(
      hexToBytes("05 01 65 00 00 00 00 00 00 00 5F 2D 55 ED 4E CD 01 17 7C 29"),
    );
    if (cut?.kind !== "event") throw new Error("not event");
    const fall = translateEvent(cut, ctx);
    expect(fall?.eventType).toBe("possible_fall");
    expect(fall?.eventId).toBe(eventIdFor("helmet_94173f", 0x65));
    expect(fall?.payload).toEqual({
      confidence: 0.95,
      impactG: 4.5,
      tiltDeg: 85,
    });
    // 一个字节的载荷都没有：仍然是一条摔倒
    const bare = parseInbound(hexToBytes("05 01 66 00 00 00 00 00 00 00"));
    if (bare?.kind !== "event") throw new Error("not event");
    expect(translateEvent(bare, ctx)?.payload).toEqual({});
    // 求救：按压时长只收到一半 → 不拼出错的数
    const sos = parseInbound(hexToBytes("05 02 67 00 00 00 00 00 00 00 02 10"));
    if (sos?.kind !== "event") throw new Error("not event");
    const env = translateEvent(sos, ctx);
    expect(env?.eventType).toBe("manual_sos");
    expect(env?.payload).toEqual({ triggerMode: "double_click" });
  });
  it("固件与 deviceId 解码", () => {
    expect(firmwareFromBytes(Uint8Array.from([1, 0, 3]))).toBe("1.0.3");
    const id = Array.from("helmet_94173f", (c) => c.charCodeAt(0));
    expect(deviceIdFromBytes(Uint8Array.from([...id, 0, 0, 0]))).toBe(
      "helmet_94173f",
    );
  });
});

describe("设置键 → 寄存器", () => {
  // 类型与取值范围以 shared DEVICE_SETTINGS 为准（决策 #43），与服务端 PUT settings 同一张表
  it("合法值按清单落到对应寄存器", () => {
    expect(settingToRegisterWrite("volume", 90)).toEqual({
      addr: 0x24,
      data: [0x5a],
    });
    expect(settingToRegisterWrite("light", 0)).toEqual({
      addr: 0x26,
      data: [0],
    });
    expect(settingToRegisterWrite("light", 3)).toEqual({
      addr: 0x26,
      data: [3],
    });
    expect(settingToRegisterWrite("radarDistance", 15)).toEqual({
      addr: 0x2a,
      data: [15],
    });
    expect(settingToRegisterWrite("fallDetect", true)).toEqual({
      addr: 0x27,
      data: [1],
    });
    expect(settingToRegisterWrite("fallDetect", false)).toEqual({
      addr: 0x27,
      data: [0],
    });
  });

  it("14 项清单每一项都有寄存器，且地址两两不同", () => {
    const addrs = DEVICE_SETTING_KEYS.map((k) => SETTING_REGISTER[k]);
    expect(addrs).toHaveLength(14);
    expect(new Set(addrs).size).toBe(14);
    expect(Math.min(...addrs)).toBe(0x20);
    expect(Math.max(...addrs)).toBe(0x2d);
  });

  it("类型不符 / 越界 / 未知键 → null（与服务端同口径，不猜用户意图）", () => {
    // light 是 0–3 档不是开关：布尔会被服务端 400，App 侧也必须拒，否则两端解释不一致
    expect(settingToRegisterWrite("light", true)).toBeNull();
    expect(settingToRegisterWrite("volume", 0)).toBeNull();
    expect(settingToRegisterWrite("volume", 101)).toBeNull();
    expect(settingToRegisterWrite("volume", "80")).toBeNull();
    expect(settingToRegisterWrite("volume", 80.5)).toBeNull();
    expect(settingToRegisterWrite("fallDetect", 1)).toBeNull();
    expect(settingToRegisterWrite("nope", 1)).toBeNull();
  });
});

describe("读回 0x20–0x2D → 设置键值（决策 #45）", () => {
  it("连续 14 字节按清单翻成键值，布尔寄存器 0/1 → false/true", () => {
    expect(SETTINGS_READ_ADDR).toBe(0x20);
    expect(SETTINGS_READ_LEN).toBe(14);
    // 顺序即 0x20…0x2D：心跳60 / 运动5 / 静止300→255 内取 30 / 蜂鸣开 / 音量60 / 振动2 / 大灯0 /
    // 跌倒开 / 灵敏度2 / 雷达开 / 距离15 / 障碍开 / SOS 键开 / 断连蜂鸣关
    const bytes = [60, 5, 30, 1, 60, 2, 0, 1, 2, 1, 15, 1, 1, 0];
    expect(registersToSettings(0x20, bytes)).toEqual({
      heartbeatPeriod: 60,
      locationPeriodMoving: 5,
      locationPeriodStill: 30,
      buzzer: true,
      volume: 60,
      vibration: 2,
      light: 0,
      fallDetect: true,
      fallSensitivity: 2,
      radar: true,
      radarDistance: 15,
      obstacleWarn: true,
      sosButton: true,
      disconnectBeep: false,
    });
  });

  it("大灯掉电不保存：头盔重启后读回 0 → 上报 light: 0（云端据此纠正显示）", () => {
    const bytes = [60, 5, 30, 1, 60, 2, 0, 1, 2, 1, 15, 1, 1, 0];
    expect(registersToSettings(0x20, bytes).light).toBe(0);
  });

  it("越界字节与清单外地址丢弃，不让固件差异炸掉整次上报", () => {
    // volume 读回 0（清单 1–100 之外，疑似固件未初始化）→ 该键不上报，其余照常
    const bytes = [60, 5, 30, 1, 0, 2, 1, 1, 2, 1, 15, 1, 1, 0];
    const out = registersToSettings(0x20, bytes);
    expect(out.volume).toBeUndefined();
    expect(out.light).toBe(1);
    // 多读 2 字节（0x2E/0x2F 不在清单）→ 忽略
    expect(registersToSettings(0x20, [...bytes, 9, 9])).toEqual(out);
  });
});
