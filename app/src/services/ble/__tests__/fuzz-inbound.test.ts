// 头盔 → App 的 BLE 帧是不可信输入：一帧坏数据把解析抛崩，链路就断了，后面的摔倒也收不到。
// 固定种子的随机字节喂解析 → 翻译 → 日志描述 / 设置回读，断言都不抛，翻译出的信封能过服务端的基本校验
// （backend/src/ingest/envelope.ts：时间戳年份 1970–9999、payload 是对象）。2026-10-20 临时跑过 20 万帧 0 异常，这里留 2 万帧常驻
import { describe, expect, it } from "@jest/globals";

import { describeInbound, describeOutbound } from "../describe";
import {
  Ins,
  parseInbound,
  registersToSettings,
  SETTINGS_READ_ADDR,
  SETTINGS_READ_LEN,
  translateEvent,
} from "../protocol";

/** 线性同余：固定种子，失败可复现 */
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe("BLE 入站帧模糊（固定种子）", () => {
  it("2 万帧随机字节（1/3 伪装成事件帧）：解析 / 翻译 / 描述都不抛；信封字段齐全、时间戳合法、数值有限", () => {
    const rnd = rng(20261020);
    const bytes = (n: number) =>
      Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
    const ctx = {
      deviceId: "helmet_fuzz",
      firmwareVersion: "1.0.3",
      receivedAt: new Date("2026-10-20T00:00:00Z"),
    };
    let events = 0;
    let envelopes = 0;
    for (let i = 0; i < 20_000; i++) {
      const b = bytes(Math.floor(rnd() * 40));
      if (i % 3 === 0 && b.length > 1) {
        b[0] = Ins.EVENT;
        b[1] = 1 + Math.floor(rnd() * 8);
      }
      const frame = parseInbound(b);
      expect(() => describeInbound(b)).not.toThrow();
      expect(() => describeOutbound(b)).not.toThrow();
      if (frame?.kind !== "event") continue;
      events++;
      const env = translateEvent(frame, ctx) as unknown as Record<
        string,
        unknown
      > | null;
      if (!env) continue;
      envelopes++;
      expect(typeof env.eventId).toBe("string");
      expect(env.deviceId).toBe("helmet_fuzz");
      const ts = String(env.timestamp);
      expect(ts).toMatch(ISO);
      const year = new Date(ts).getUTCFullYear();
      expect(year).toBeGreaterThanOrEqual(1970);
      expect(year).toBeLessThanOrEqual(9999);
      const p = env.payload as Record<string, unknown>;
      expect(typeof p).toBe("object");
      for (const v of Object.values(p))
        if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    }
    expect(events).toBeGreaterThan(1_000);
    expect(envelopes).toBeGreaterThan(100);
  });

  it("设置回读：随机起始地址 + 随机长度都不抛，输出只有有限数或布尔", () => {
    const rnd = rng(4510);
    for (let i = 0; i < 5_000; i++) {
      const b = Array.from(
        { length: Math.floor(rnd() * (SETTINGS_READ_LEN + 6)) },
        () => Math.floor(rnd() * 256),
      );
      const base = i % 2 ? SETTINGS_READ_ADDR : Math.floor(rnd() * 256);
      const out = registersToSettings(base, b) as Record<string, unknown>;
      for (const v of Object.values(out))
        expect(
          typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean",
        ).toBe(true);
    }
  });
});
