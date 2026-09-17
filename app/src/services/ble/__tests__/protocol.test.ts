// 协议层单测：以手册 v0.6 原文示例帧为夹具，钉住字节级契约。
// 注意：手册示例的十六进制与其标注的十进制不一致（0x6AA27988 = 1789032840 而非 1788856200；
// ED 4E CD 01 = 30.232301 而非 30.256877）——字节流才是契约，本文件以字节为准（已列入 v0.6 勘误）。
import { describe, expect, it } from '@jest/globals';

import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  sha1,
  uuidV5,
} from '../bytes';
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
  settingToRegisterWrite,
  translateEvent,
} from '../protocol';

const ctx = {
  deviceId: 'helmet_94173f',
  firmwareVersion: '1.0.3',
  receivedAt: new Date('2026-09-16T00:00:00Z'),
};

describe('bytes', () => {
  it('base64 往返（含非 3 倍长度）', () => {
    for (const n of [0, 1, 2, 3, 4, 20]) {
      const src = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(Array.from(base64ToBytes(bytesToBase64(src)))).toEqual(Array.from(src));
    }
  });
  it('sha1("abc") = a9993e36…（RFC 3174 向量）', () => {
    const h = sha1(Uint8Array.from(Array.from('abc', (c) => c.charCodeAt(0))));
    expect(bytesToHex(h).replace(/ /g, '')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
  it('uuidV5 确定性且符合版本/变体位', () => {
    const a = uuidV5('6f1a4c0e-2b7d-5e3a-9c48-0a2b3c4d5e6f', 'helmet_94173f:101');
    const b = uuidV5('6f1a4c0e-2b7d-5e3a-9c48-0a2b3c4d5e6f', 'helmet_94173f:101');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV5('6f1a4c0e-2b7d-5e3a-9c48-0a2b3c4d5e6f', 'helmet_94173f:102')).not.toBe(a);
  });
});

describe('下行指令构造（手册示例）', () => {
  it('例 2 读电量/GPS：02 02 10 0A', () => {
    expect(bytesToHex(buildRead(2, 0x10, 10))).toBe('02 02 10 0a');
  });
  it('例 3 写定位周期：03 03 21 03', () => {
    expect(bytesToHex(buildWrite(3, 0x21, [3]))).toBe('03 03 21 03');
  });
  it('例 5 对时 0x6AA27988 → 04 05 88 79 A2 6A（小端）', () => {
    expect(bytesToHex(buildTimeSync(5, 0x6aa27988))).toBe('04 05 88 79 a2 6a');
    expect(bytesToHex(buildTimeSync(5, 1788856200))).toBe('04 05 88 c7 9f 6a');
  });
  it('例 8 ACK 跌倒 Seq=101：06 01 65 00 00 00 00', () => {
    expect(bytesToHex(buildAck(0x01, 101))).toBe('06 01 65 00 00 00 00');
  });
  it('补传读取：08 07 00 00 03', () => {
    expect(bytesToHex(buildResendData(7, 0, 3))).toBe('08 07 00 00 03');
  });
});

describe('上行解析', () => {
  it('例 2 应答帧：电量 85%、未充电、附带经纬度', () => {
    const r = parseInbound(hexToBytes('02 02 00 55 00 ED 4E CD 01 17 7C 29 07'));
    expect(r?.kind).toBe('response');
    if (r?.kind !== 'response') return;
    expect([r.ins, r.seq, r.error]).toEqual([2, 2, 0]);
    expect(r.data[0]).toBe(0x55);
  });
  it('例 6 跌倒事件帧 → possible_fall envelope', () => {
    const ev = parseInbound(
      hexToBytes('05 01 65 00 00 00 88 79 A2 6A 5F 2D 55 ED 4E CD 01 17 7C 29 07'),
    );
    expect(ev?.kind).toBe('event');
    if (ev?.kind !== 'event') return;
    expect(ev.eventSeq).toBe(101);
    expect(ev.timestamp).toBe(0x6aa27988);
    const env = translateEvent(ev, ctx)!;
    expect(env.eventType).toBe('possible_fall');
    expect(env.eventId).toBe(eventIdFor('helmet_94173f', 101));
    expect(env.timestamp).toBe('2026-09-10T09:34:00.000Z');
    const p = env.payload as Record<string, unknown>;
    expect(p.confidence).toBeCloseTo(0.95);
    expect(p.impactG).toBeCloseTo(4.5);
    expect(p.tiltDeg).toBe(85);
    expect(p.location).toEqual({
      latitude: 30.232301,
      longitude: 120.159255,
      coordinateSystem: 'wgs84',
    });
  });
  it('例 7 后方来车碰撞 → collision_risk（high / vehicle / rear / 12.5m / TTC 1.8s / 55km/h）', () => {
    const ev = parseInbound(
      hexToBytes('05 03 66 00 00 00 88 79 A2 6A 03 01 02 7D 00 12 37 ED 4E CD 01 17 7C 29 07'),
    );
    if (ev?.kind !== 'event') throw new Error('not event');
    const env = translateEvent(ev, ctx)!;
    expect(env.eventType).toBe('collision_risk');
    const p = env.payload as Record<string, unknown>;
    expect(p).toMatchObject({
      riskLevel: 'high',
      objectType: 'vehicle',
      direction: 'rear',
      distance: 12.5,
      ttcSeconds: 1.8,
      approachSpeedKmh: 55,
    });
  });
  it('未校时（timestamp=0）用接收时刻兜底', () => {
    const ev = parseInbound(hexToBytes('05 07 01 00 00 00 00 00 00 00 55 01'));
    if (ev?.kind !== 'event') throw new Error('not event');
    const env = translateEvent(ev, ctx)!;
    expect(env.eventType).toBe('device_status');
    expect(env.timestamp).toBe('2026-09-16T00:00:00.000Z');
    expect(env.payload).toEqual({ battery: 85, charging: true });
  });
  it('位置包：0xFF 精度（无定位）丢弃；0x7FFF 海拔省略；航向 0xFFFF 置 0', () => {
    const noFix = parseInbound(
      hexToBytes('05 06 05 00 00 00 00 00 00 00 ED 4E CD 01 17 7C 29 07 44 00 FF FF FF FF 7F'),
    );
    if (noFix?.kind !== 'event') throw new Error('not event');
    expect(translateEvent(noFix, ctx)).toBeNull();
    const ok = parseInbound(
      hexToBytes('05 06 05 00 00 00 00 00 00 00 ED 4E CD 01 17 7C 29 07 44 00 FF FF 05 FF 7F'),
    );
    if (ok?.kind !== 'event') throw new Error('not event');
    const env = translateEvent(ok, ctx)!;
    expect(env.payload).toEqual({
      latitude: 30.232301,
      longitude: 120.159255,
      coordinateSystem: 'wgs84',
      speed: 6.8,
      heading: 0,
      accuracy: 5,
    });
  });
  it('risk_cleared：全 0 = 清除全部；否则映射到被解除事件的 eventId', () => {
    const all = parseInbound(hexToBytes('05 05 09 00 00 00 00 00 00 00 00 00 00 00'));
    const one = parseInbound(hexToBytes('05 05 09 00 00 00 00 00 00 00 66 00 00 00'));
    if (all?.kind !== 'event' || one?.kind !== 'event') throw new Error('not event');
    expect(translateEvent(all, ctx)!.payload).toEqual({});
    expect(translateEvent(one, ctx)!.payload).toEqual({
      clearedEventId: eventIdFor('helmet_94173f', 102),
    });
  });
  it('未知事件码 / 载荷过短 → null；帧过短 → null', () => {
    const unknown = parseInbound(hexToBytes('05 09 01 00 00 00 00 00 00 00'));
    if (unknown?.kind !== 'event') throw new Error('not event');
    expect(translateEvent(unknown, ctx)).toBeNull();
    const short = parseInbound(hexToBytes('05 01 01 00 00 00 00 00 00 00 5F'));
    if (short?.kind !== 'event') throw new Error('not event');
    expect(translateEvent(short, ctx)).toBeNull();
    expect(parseInbound(hexToBytes('05'))).toBeNull();
  });
  it('固件与 deviceId 解码', () => {
    expect(firmwareFromBytes(Uint8Array.from([1, 0, 3]))).toBe('1.0.3');
    const id = Array.from('helmet_94173f', (c) => c.charCodeAt(0));
    expect(deviceIdFromBytes(Uint8Array.from([...id, 0, 0, 0]))).toBe('helmet_94173f');
  });
});

describe('设置键 → 寄存器', () => {
  it('volume 90 → 0x24=0x5A；light true → 0x26=1；越界/未知 → null', () => {
    expect(settingToRegisterWrite('volume', 90)).toEqual({ addr: 0x24, data: [0x5a] });
    expect(settingToRegisterWrite('light', true)).toEqual({ addr: 0x26, data: [1] });
    expect(settingToRegisterWrite('light', false)).toEqual({ addr: 0x26, data: [0] });
    expect(settingToRegisterWrite('volume', 0)).toBeNull();
    expect(settingToRegisterWrite('volume', 101)).toBeNull();
    expect(settingToRegisterWrite('radarDistance', 15)).toEqual({ addr: 0x2a, data: [15] });
    expect(settingToRegisterWrite('nope', 1)).toBeNull();
  });
});
