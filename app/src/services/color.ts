// 颜色小工具（纯函数）。主题里的实色都是 #RRGGBB，这里只处理这一种写法。

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 给主题色加透明度：#4ADE80, 0.24 → rgba(74, 222, 128, 0.24) */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 把 over 按 t（0–1）盖在 base 上，得到不透明的结果色。
 * 两段半透明的形状叠在一起，重叠处会更深；要拼接的地方（环的端头）用这个先算成实色。
 */
export function mixHex(base: string, over: string, t: number): string {
  const a = channels(base);
  const b = channels(over);
  return `#${a
    .map((v, i) =>
      Math.round(v + (b[i] - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
