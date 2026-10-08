// 对讲提示音是程序合成的 WAV：这里守住文件头写得对（写错了 TRTC 直接放不出来）、长度算得对、
// 起止不爆音、音量不过载。
import { describe, expect, it } from "@jest/globals";

import { synthWav } from "../cue-synth";

const ascii = (b: Uint8Array, from: number, len: number) =>
  String.fromCharCode(...b.slice(from, from + len));
const view = (b: Uint8Array) => new DataView(b.buffer);
const samples = (b: Uint8Array) => {
  const v = view(b);
  const out: number[] = [];
  for (let at = 44; at < b.length; at += 2) out.push(v.getInt16(at, true));
  return out;
};

describe("synthWav", () => {
  const RATE = 22_050;
  const wav = synthWav(
    [
      { hz: 660, ms: 100, gapMs: 50 },
      { hz: 880, ms: 100 },
    ],
    RATE,
  );

  it("是合法的 16 位单声道 PCM WAV", () => {
    const v = view(wav);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // 单声道
    expect(v.getUint32(24, true)).toBe(RATE);
    expect(v.getUint32(28, true)).toBe(RATE * 2);
    expect(v.getUint16(34, true)).toBe(16);
  });

  it("长度 = 各段音与停顿之和；头里写的大小与实际一致", () => {
    const n = Math.round(0.1 * RATE) * 2 + Math.round(0.05 * RATE);
    expect(wav.length).toBe(44 + n * 2);
    expect(view(wav).getUint32(40, true)).toBe(n * 2);
    expect(view(wav).getUint32(4, true)).toBe(wav.length - 8);
  });

  it("每段音从静音起、到静音止（不爆音），停顿处是静音", () => {
    const s = samples(wav);
    const tone = Math.round(0.1 * RATE);
    const gap = Math.round(0.05 * RATE);
    expect(s[0]).toBe(0);
    expect(Math.abs(s[tone - 1])).toBeLessThan(40);
    expect(s.slice(tone, tone + gap).every((x) => x === 0)).toBe(true);
    expect(s[tone + gap]).toBe(0);
    expect(Math.abs(s[s.length - 1])).toBeLessThan(40);
  });

  it("有声音，且峰值留了余量（提示音垫在通话声音下面）", () => {
    const peak = Math.max(...samples(wav).map(Math.abs));
    expect(peak).toBeGreaterThan(8_000);
    expect(peak).toBeLessThan(13_000);
  });

  it("很短的音也不出错", () => {
    const tiny = synthWav([{ hz: 1000, ms: 1 }], RATE);
    expect(tiny.length).toBe(44 + Math.round(0.001 * RATE) * 2);
  });
});
