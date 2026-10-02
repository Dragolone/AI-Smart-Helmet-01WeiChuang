/**
 * 正整数环境变量：未设、非整数、≤ 0 一律回落默认值。
 * 调用时读取而非 import 时读取——测试能在 app 初始化前用环境变量把倒计时/扫描间隔调短。
 */
export const envPositiveInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
