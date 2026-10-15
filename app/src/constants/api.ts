// 后端地址的唯一来源：dev / prod 由 .env 的 EXPO_PUBLIC_API_URL 决定（Metro 构建期内联，必须按字面量引用）。
// 此前 client.ts / realtime.ts / constants/legal.ts 各写了一份兜底（B 线 10-05 指出），三处漂移的风险不值得省这个文件。
// 去掉首尾空白和结尾的斜杠：.env 里写成 …/api/v1/ 时，REST 会拼出 …/api/v1//devices 全部 404，
// 而实时通道（api/realtime.ts）本来就容忍结尾斜杠——两边表现不一致，排查时很难想到是这一个字符
export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000/api/v1"
)
  .trim()
  .replace(/\/+$/, "");
