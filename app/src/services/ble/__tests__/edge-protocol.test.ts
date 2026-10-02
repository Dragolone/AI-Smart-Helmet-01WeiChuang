// 边界补测（2026-10-03）：BLE 字节层 / 协议翻译层。protocol.test.ts 用手册示例帧钉住了正常路径，
// 这里补它没碰到的：外部基准（Node crypto / Buffer / RFC 向量）对照、符号位与 2038 年、
// 帧长临界、枚举越界、14 项设置的上下界，以及随机帧不抛。
import { createHash } from "node:crypto";

import { describe, expect, it } from "@jest/globals";
import { DEVICE_SETTINGS, DEVICE_SETTING_KEYS } from "@helmet/shared";

import {
  asciiZ,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  readI16,
  readI32,
  readU16,
  readU32,
  sha1,
  uuidV5,
  writeU32,
} from "../bytes";
import { describeInbound, parseHexInput } from "../describe";
import {
  buildAck,
  buildPing,
  buildResendData,
  buildTimeSync,
  buildWrite,
  eventIdFor,
  parseInbound,
  registersToSettings,
  SETTING_REGISTER,
  settingToRegisterWrite,
  translateEvent,
} from "../protocol";
import type { InboundEvent } from "../protocol";

const ctx = {
  deviceId: "helmet_94173f",
  firmwareVersion: "1.0.3",
  receivedAt: new Date("2026-10-03T00:00:00Z"),
};

// 测试自己的小端编码器：不借被测代码的 writeU16/writeU32 来造夹具
const le = (v: number, bytes: 2 | 4, signed = false): number[] => {
  const dv = new DataView(new ArrayBuffer(4));
  if (bytes === 2) {
    if (signed) dv.setInt16(0, v, true);
    else dv.setUint16(0, v, true);
  } else if (signed) dv.setInt32(0, v, true);
  else dv.setUint32(0, v, true);
  return Array.from(new Uint8Array(dv.buffer).subarray(0, bytes));
};
const deg = (v: number) => le(Math.round(v * 1e6), 4, true);

const eventFrame = (
  code: number,
  eventSeq: number,
  timestamp: number,
  payload: number[],
): Uint8Array =>
  Uint8Array.from([0x05, code, ...le(eventSeq, 4), ...le(timestamp, 4), ...payload]);

const parseEvent = (frame: Uint8Array): InboundEvent => {
  const ev = parseInbound(frame);
  if (ev?.kind !== "event") throw new Error("not event");
  return ev;
};
const translate = (code: number, payload: number[], seq = 7, ts = 0) =>
  translateEvent(parseEvent(eventFrame(code, seq, ts, payload)), ctx);
const payloadOf = (code: number, payload: number[]) =>
  translate(code, payload)?.payload as Record<string, unknown> | undefined;

/** 各事件码的规定载荷长度（手册 §1.3） */
const PAYLOAD_LEN: Record<number, number> = {
  0x01: 11,
  0x02: 11,
  0x03: 15,
  0x04: 15,
  0x05: 4,
  0x06: 15,
  0x07: 2,
};

/** 确定性伪随机（mulberry32）：随机帧用例可复现 */
const prng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const refUuid5 = (ns: string, name: string): string => {
  const h = createHash("sha1")
    .update(Buffer.from(ns.replace(/-/g, ""), "hex"))
    .update(Buffer.from(name, "utf8"))
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

describe("bytes：与 Node 内置实现对照", () => {
  it("base64 编解码在 0–130 字节上与 Buffer 完全一致（自己往返一致不等于正确）", () => {
    for (let n = 0; n <= 130; n += 1) {
      const src = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n * 7) & 255);
      const ref = Buffer.from(src).toString("base64");
      expect(bytesToBase64(src)).toBe(ref);
      expect(Array.from(base64ToBytes(ref))).toEqual(Array.from(src));
    }
  });

  it("base64 解码容忍换行/空格与缺失的 = 填充", () => {
    expect(Array.from(base64ToBytes("BQ EA\nAAA=\r\n"))).toEqual([5, 1, 0, 0, 0]);
    expect(Array.from(base64ToBytes("QQ"))).toEqual([0x41]);
    expect(Array.from(base64ToBytes("QUI"))).toEqual([0x41, 0x42]);
    expect(Array.from(base64ToBytes(""))).toEqual([]);
  });

  it("SHA-1 在填充临界长度（55/56/63/64/65/119/120 字节）与 Node crypto 一致", () => {
    for (let n = 0; n <= 130; n += 1) {
      const src = Uint8Array.from({ length: n }, (_, i) => (i * 29 + n) & 255);
      const mine = bytesToHex(sha1(src)).replace(/ /g, "");
      expect(mine).toBe(createHash("sha1").update(src).digest("hex"));
    }
  });

  it("uuidV5 符合 RFC 4122 公开向量（DNS 命名空间）", () => {
    const dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(uuidV5(dns, "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
    expect(uuidV5(dns, "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("eventId：deviceId 长到跨 SHA-1 分块（16+name ≥ 56 字节）时仍与标准实现一致", () => {
    const ns = "6f1a4c0e-2b7d-5e3a-9c48-0a2b3c4d5e6f";
    for (const idLen of [4, 28, 29, 36, 37, 38, 53, 64]) {
      const deviceId = "h".repeat(idLen);
      for (const seq of [0, 1, 4294967295]) {
        expect(eventIdFor(deviceId, seq)).toBe(
          refUuid5(ns, `${deviceId}:${seq}`),
        );
      }
    }
    // 非 ASCII（BMP 内）按 UTF-8 三字节编码
    expect(uuidV5(ns, "头盔:1")).toBe(refUuid5(ns, "头盔:1"));
  });

  it("小端读数的符号位：U32 不变负数，I32 / I16 还原负数", () => {
    const b = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x80]);
    expect(readU32(b, 0)).toBe(4294967295);
    expect(readI32(b, 0)).toBe(-1);
    expect(readU32(b, 4)).toBe(2147483648);
    expect(readI32(b, 4)).toBe(-2147483648);
    expect(readU16(b, 0)).toBe(65535);
    expect(readI16(b, 0)).toBe(-1);
    expect(readI16(b, 6)).toBe(-32768);
  });

  it("writeU32 对 ≥ 2^31 的值不丢最高字节", () => {
    expect(writeU32(2147483648)).toEqual([0, 0, 0, 0x80]);
    expect(writeU32(4294967295)).toEqual([255, 255, 255, 255]);
    expect(readU32(Uint8Array.from(writeU32(3000000000)), 0)).toBe(3000000000);
  });

  it("asciiZ：16 字节写满没有结尾 0 也能读全；全 0 得空串", () => {
    const full = Uint8Array.from(Array.from("helmet_0123456789".slice(0, 16), (c) => c.charCodeAt(0)));
    expect(asciiZ(full)).toBe("helmet_012345678");
    expect(asciiZ(new Uint8Array(16))).toBe("");
    expect(asciiZ(new Uint8Array(0))).toBe("");
  });
});

describe("下行帧构造的数值上界", () => {
  it("对时：2038-01-19 之后（≥ 2^31 秒）与 uint32 上限都按无符号小端写出", () => {
    expect(bytesToHex(buildTimeSync(1, 2147483648))).toBe("04 01 00 00 00 80");
    expect(bytesToHex(buildTimeSync(1, 4294967295))).toBe("04 01 ff ff ff ff");
  });

  it("ACK 的 Event_Seq 取 uint32 上限；补传偏移取 uint16 上限", () => {
    expect(bytesToHex(buildAck(0x02, 4294967295))).toBe("06 02 ff ff ff ff 00");
    expect(bytesToHex(buildResendData(9, 65535, 20))).toBe("08 09 ff ff 14");
  });

  it("流水号只占 1 字节：256 回绕成 0，不会把高位溢进下一个字段", () => {
    expect(Array.from(buildPing(256))).toEqual([0x01, 0x00]);
    expect(Array.from(buildWrite(511, 0x24, [80]))).toEqual([0x03, 0xff, 0x24, 80]);
  });
});

describe("parseInbound 帧长临界", () => {
  it("空帧 / 1 字节 / 2 字节应答 → null；3 字节应答 = 无数据段", () => {
    expect(parseInbound(new Uint8Array(0))).toBeNull();
    expect(parseInbound(Uint8Array.from([0x02]))).toBeNull();
    expect(parseInbound(Uint8Array.from([0x02, 0x01]))).toBeNull();
    const r = parseInbound(Uint8Array.from([0x03, 0x09, 0x05]));
    expect(r).toMatchObject({ kind: "response", ins: 3, seq: 9, error: 5 });
    if (r?.kind === "response") expect(r.data).toHaveLength(0);
  });

  it("事件帧头 10 字节：9 字节 → null；刚好 10 字节 = 空载荷（翻译阶段再按长度拒）", () => {
    expect(parseInbound(eventFrame(0x07, 1, 0, []).subarray(0, 9))).toBeNull();
    const ev = parseInbound(eventFrame(0x07, 1, 0, []));
    expect(ev).toMatchObject({ kind: "event", code: 7, eventSeq: 1 });
    if (ev?.kind === "event") {
      expect(ev.payload).toHaveLength(0);
      expect(translateEvent(ev, ctx)).toBeNull();
    }
  });

  it("帧位于更大缓冲区的中间（byteOffset ≠ 0）时字段偏移不串位", () => {
    const frame = eventFrame(0x07, 0x01020304, 0, [55, 1]);
    const padded = new Uint8Array(frame.length + 8);
    padded.set(frame, 5);
    const ev = parseEvent(padded.subarray(5, 5 + frame.length));
    expect(ev.eventSeq).toBe(0x01020304);
    expect(translateEvent(ev, ctx)?.payload).toEqual({ battery: 55, charging: true });
  });
});

describe("Event_Seq 与时间戳的 uint32 边界", () => {
  it("Event_Seq ≥ 2^31 按无符号解析；risk_cleared 指向它时得到同一个 eventId", () => {
    const seq = 0xfffffffe;
    const risk = translate(0x03, [3, 1, 2, ...le(125, 2), 18, 55, ...deg(30), ...deg(120)], seq);
    expect(risk?.eventId).toBe(eventIdFor(ctx.deviceId, 4294967294));
    const cleared = translate(0x05, le(seq, 4), 9);
    expect(cleared?.payload).toEqual({ clearedEventId: risk?.eventId });
  });

  it("eventId 只由 deviceId + Event_Seq 决定：事件码、时间戳变了也不变（重发/补传幂等的前提）", () => {
    const a = translate(0x07, [50, 0], 42, 0);
    const b = translate(0x07, [49, 1], 42, 1_790_000_000);
    const c = translate(0x02, [1, ...le(3000, 2), ...deg(30), ...deg(120)], 42);
    expect(new Set([a?.eventId, b?.eventId, c?.eventId]).size).toBe(1);
    expect(
      translateEvent(parseEvent(eventFrame(0x07, 42, 0, [50, 0])), {
        ...ctx,
        deviceId: "helmet_other1",
      })?.eventId,
    ).not.toBe(a?.eventId);
  });

  it("只有 Timestamp 恰好为 0 才用接收时刻兜底；1 秒与 uint32 上限都如实换算且满足服务端 ISO 口径", () => {
    // backend/src/ingest/envelope.ts 的 ISO8601_WITH_TZ + 年份 ≥ 1970
    const serverIso =
      /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
    expect(translate(0x07, [50, 0], 1, 0)?.timestamp).toBe("2026-10-03T00:00:00.000Z");
    expect(translate(0x07, [50, 0], 1, 1)?.timestamp).toBe("1970-01-01T00:00:01.000Z");
    expect(translate(0x07, [50, 0], 1, 2147483648)?.timestamp).toBe("2038-01-19T03:14:08.000Z");
    const max = translate(0x07, [50, 0], 1, 4294967295)?.timestamp ?? "";
    expect(max).toBe("2106-02-07T06:28:15.000Z");
    for (const ts of ["1970-01-01T00:00:01.000Z", max]) {
      expect(serverIso.exec(ts)).not.toBeNull();
      expect(Number(ts.slice(0, 4))).toBeGreaterThanOrEqual(1970);
    }
  });
});

describe("translateEvent 载荷边界", () => {
  it.each(Object.entries(PAYLOAD_LEN))(
    "事件码 %s：载荷少 1 字节 → null；多出的尾部字节（固件加字段）不影响翻译",
    (codeStr, len) => {
      const code = Number(codeStr);
      const exact = new Array<number>(len).fill(1);
      expect(translate(code, exact.slice(0, len - 1))).toBeNull();
      const base = translate(code, exact);
      expect(base).not.toBeNull();
      expect(translate(code, [...exact, 0xaa, 0xbb, 0xcc])?.payload).toEqual(base?.payload);
    },
  );

  it("南半球 / 西半球坐标按有符号 int32 还原为负数（摔倒快照与位置包同口径）", () => {
    const fall = payloadOf(0x01, [95, 45, 85, ...deg(-33.8688), ...deg(-122.4194)]);
    expect(fall?.location).toEqual({
      latitude: -33.8688,
      longitude: -122.4194,
      coordinateSystem: "wgs84",
    });
    const loc = payloadOf(0x06, [
      ...deg(-33.8688),
      ...deg(151.2093),
      ...le(68, 2),
      ...le(900, 2),
      5,
      ...le(30, 2, true),
    ]);
    expect(loc).toMatchObject({ latitude: -33.8688, longitude: 151.2093 });
  });

  it("位置包：海拔为负照常上报、0 不当无效；航向 359.9°、精度 0 与 254 都保留", () => {
    const frame = (heading: number, accuracy: number, altitude: number) =>
      payloadOf(0x06, [
        ...deg(30),
        ...deg(120),
        ...le(0, 2),
        ...le(heading, 2),
        accuracy,
        ...le(altitude, 2, true),
      ]);
    expect(frame(3599, 0, -50)).toMatchObject({
      heading: 359.9,
      accuracy: 0,
      altitude: -50,
      speed: 0,
    });
    expect(frame(0, 254, 0)).toMatchObject({ heading: 0, accuracy: 254, altitude: 0 });
    expect(frame(0, 5, -32768)).toMatchObject({ altitude: -32768 });
    expect(frame(0, 5, 32767)).not.toHaveProperty("altitude");
  });

  it("危险事件枚举越界：等级未知一律按 high（宁重勿轻），目标未知 → unknown，方向未知 → 序列化后不带该键", () => {
    const risk = (level: number, object: number, direction: number) =>
      payloadOf(0x04, [level, object, direction, ...le(65535, 2), 255, 255, ...deg(30), ...deg(120)]);
    for (const level of [0, 4, 255]) expect(risk(level, 1, 1)?.riskLevel).toBe("high");
    expect(risk(1, 1, 1)?.riskLevel).toBe("low");
    expect(risk(2, 9, 1)?.objectType).toBe("unknown");
    for (const direction of [0, 5, 255]) {
      const p = risk(3, 1, direction);
      expect(JSON.parse(JSON.stringify(p))).not.toHaveProperty("direction");
    }
    // 原始量的上限值按单位换算，不截断
    expect(risk(3, 1, 4)).toMatchObject({
      direction: "right",
      distance: 6553.5,
      ttcSeconds: 25.5,
      approachSpeedKmh: 255,
    });
  });

  it("手动求救触发方式：只有 2 是双击，其余值（含 0 / 未知）都按长按", () => {
    const sos = (mode: number) =>
      payloadOf(0x02, [mode, ...le(65535, 2), ...deg(30), ...deg(120)]);
    expect(sos(2)?.triggerMode).toBe("double_click");
    for (const mode of [0, 1, 3, 255]) expect(sos(mode)?.triggerMode).toBe("long_press");
    expect(sos(1)?.pressDurationMs).toBe(65535);
  });

  it("心跳充电标志：只有 1 算充电中，其余非零值不算", () => {
    expect(payloadOf(0x07, [100, 1])).toEqual({ battery: 100, charging: true });
    expect(payloadOf(0x07, [0, 0])).toEqual({ battery: 0, charging: false });
    expect(payloadOf(0x07, [50, 2])).toEqual({ battery: 50, charging: false });
  });
});

describe("14 项设置的上下界（与 shared DEVICE_SETTINGS 同一张表）", () => {
  it.each(DEVICE_SETTING_KEYS)("%s：边界值可写且读回一致，越界/错类型拒绝", (key) => {
    const spec = DEVICE_SETTINGS[key];
    const addr = SETTING_REGISTER[key];
    if (spec.kind === "bool") {
      for (const v of [true, false]) {
        const w = settingToRegisterWrite(key, v);
        expect(w).toEqual({ addr, data: [v ? 1 : 0] });
        expect(registersToSettings(addr, w?.data ?? [])).toEqual({ [key]: v });
      }
      for (const bad of [0, 1, "true", null, undefined]) {
        expect(settingToRegisterWrite(key, bad)).toBeNull();
      }
      return;
    }
    for (const v of [spec.min, spec.max]) {
      const w = settingToRegisterWrite(key, v);
      expect(w).toEqual({ addr, data: [v] });
      expect(registersToSettings(addr, w?.data ?? [])).toEqual({ [key]: v });
    }
    for (const bad of [spec.min - 1, spec.max + 1, spec.min + 0.5, NaN, Infinity, `${spec.min}`, true, null]) {
      expect(settingToRegisterWrite(key, bad)).toBeNull();
    }
    // 单字节寄存器：清单里任何整数项的上限都不得超过 255
    expect(spec.max).toBeLessThanOrEqual(255);
  });

  it("原型链上的键名（__proto__ / constructor / toString）不被当成设置项", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", ""]) {
      expect(settingToRegisterWrite(key, 1)).toBeNull();
      expect(settingToRegisterWrite(key, true)).toBeNull();
    }
  });

  it("读回：从表中间起读、起点早于设置表、空数据都只翻译落在 0x20–0x2D 内的字节", () => {
    expect(registersToSettings(0x24, [80, 2])).toEqual({ volume: 80, vibration: 2 });
    expect(registersToSettings(0x1e, [9, 9, 60])).toEqual({ heartbeatPeriod: 60 });
    expect(registersToSettings(0x20, [])).toEqual({});
    expect(registersToSettings(0x2d, [1, 9, 9])).toEqual({ disconnectBeep: true });
  });

  it("读回：布尔寄存器的非 0/1 值按「非零即开」，整数寄存器越界值丢弃", () => {
    expect(registersToSettings(0x23, [2])).toEqual({ buzzer: true });
    expect(registersToSettings(0x23, [255])).toEqual({ buzzer: true });
    expect(registersToSettings(0x28, [0])).toEqual({});
    expect(registersToSettings(0x2a, [31])).toEqual({});
    expect(registersToSettings(0x20, [0])).toEqual({});
  });
});

describe("随机帧（头盔侧输入不可信）", () => {
  it("3000 条随机字节过 解析 → 翻译 → 工程模式描述 全程不抛；翻译成功的 envelope 可序列化且时间合法", () => {
    const rand = prng(20261003);
    let translated = 0;
    for (let i = 0; i < 3000; i += 1) {
      const len = Math.floor(rand() * 40);
      const bytes = Uint8Array.from({ length: len }, () => Math.floor(rand() * 256));
      // 一半样本强制成事件帧 + 合法事件码，才打得到翻译分支
      if (i % 2 === 0 && len >= 2) {
        bytes[0] = 0x05;
        bytes[1] = 1 + Math.floor(rand() * 7);
      }
      const frame = parseInbound(bytes);
      expect(() => describeInbound(bytes)).not.toThrow();
      if (frame?.kind !== "event") continue;
      const envelope = translateEvent(frame, ctx);
      if (!envelope) continue;
      translated += 1;
      expect(Number.isNaN(Date.parse(envelope.timestamp))).toBe(false);
      expect(() => JSON.stringify(envelope)).not.toThrow();
      expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(translated).toBeGreaterThan(100);
  });
});

describe("工程模式描述的边角", () => {
  it("应答帧：未知指令码与未知错误码都有可读兜底", () => {
    const d = describeInbound(Uint8Array.from([0x7f, 0x01, 0x99]));
    expect(d).toMatchObject({ kind: "response", error: 0x99 });
    expect(d.text).toBe("应答 未知指令 0x7f seq=1 · ERR_0x99");
  });

  it("READ 0x10 应答不足 10 字节（固件少回了）：退回逐寄存器列出，不越界读经纬度", () => {
    const d = describeInbound(
      Uint8Array.from([0x02, 0x02, 0x00, 0x55, 0x00]),
      Uint8Array.from([0x02, 0x02, 0x10, 0x0a]),
    );
    expect(d.text).toBe("应答 READ seq=2 · STATUS_OK · battery=85 charging=0");
  });

  it("事件帧载荷长度不符：照样给出事件名与序号，载荷按 hex 原样列出", () => {
    const d = describeInbound(eventFrame(0x01, 5, 0, [0x5f, 0x2d]));
    expect(d).toMatchObject({ kind: "event", eventCode: 1, eventSeq: 5, highRisk: true });
    expect(d.text).toBe("事件 possible_fall seq=5 · 未校时 · 载荷 5f 2d（未翻译：长度不符或无定位）");
  });

  it("parseHexInput：大写 0X 前缀、连写无分隔、混合分隔符都认；空串与纯分隔符拒绝", () => {
    expect(Array.from(parseHexInput("0X03 0X07") ?? [])).toEqual([3, 7]);
    expect(Array.from(parseHexInput("03072432") ?? [])).toEqual([3, 7, 0x24, 0x32]);
    expect(Array.from(parseHexInput("03-07:24;32\n") ?? [])).toEqual([3, 7, 0x24, 0x32]);
    expect(parseHexInput("")).toBeNull();
    expect(parseHexInput(" , ")).toBeNull();
  });
});
