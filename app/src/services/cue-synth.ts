// 把几段正弦音合成一小段 WAV（纯函数）。对讲提示音用：正式音效到位之前，声音由程序生成，
// 不往仓库里放音频文件。16 位单声道 PCM；每段音有几毫秒的淡入淡出，免得起止处「啪」一声。

export type Tone = {
  /** 频率（Hz） */
  hz: number;
  /** 这段音多长（ms） */
  ms: number;
  /** 这段音之后静多久（ms），默认不停顿 */
  gapMs?: number;
};

const ATTACK_MS = 5;
const RELEASE_MS = 18;
/** 峰值不拉满：提示音是垫在通话声音下面的 */
const PEAK = 0.35;

export function synthWav(
  tones: readonly Tone[],
  sampleRate = 22_050,
): Uint8Array {
  const count = (ms: number) => Math.round((ms / 1000) * sampleRate);
  const total = tones.reduce(
    (n, t) => n + count(t.ms) + count(t.gapMs ?? 0),
    0,
  );
  const bytes = new Uint8Array(44 + total * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1)
      view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 每秒字节数
  view.setUint16(32, 2, true); // 每个采样 2 字节
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, total * 2, true);

  let at = 44;
  for (const tone of tones) {
    const n = count(tone.ms);
    const attack = Math.min(count(ATTACK_MS), Math.floor(n / 2));
    const release = Math.min(count(RELEASE_MS), Math.floor(n / 2));
    for (let i = 0; i < n; i += 1) {
      const fade =
        i < attack ? i / attack : i >= n - release ? (n - 1 - i) / release : 1;
      // 余弦形的淡入淡出比直线更不容易听出边缘
      const gain = PEAK * (0.5 - 0.5 * Math.cos(Math.PI * fade));
      const sample = Math.sin((2 * Math.PI * tone.hz * i) / sampleRate) * gain;
      view.setInt16(at, Math.round(sample * 32_767), true);
      at += 2;
    }
    at += count(tone.gapMs ?? 0) * 2; // 静音：数组本来就是 0
  }
  return bytes;
}
