// 后端地址的唯一来源：dev / prod 由 .env 的 EXPO_PUBLIC_API_URL 决定（Metro 构建期内联，必须按字面量引用）。
// 此前 client.ts / realtime.ts / constants/legal.ts 各写了一份兜底（B 线 10-05 指出），三处漂移的风险不值得省这个文件。
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";
