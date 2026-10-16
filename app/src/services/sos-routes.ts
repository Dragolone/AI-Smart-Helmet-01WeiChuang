// 求救相关页面的链接：编号一律编码后再拼进路径 / 查询参数（10-16 A4）。
// 今天的编号字符集是安全的，这里是纵深防御——以后编号格式变了，各处入口不用一个个改。
// 返回类型写成模板字面量，expo-router 的 typed routes 才认。
const enc = encodeURIComponent;

/** 倒计时页；deviceId 可省（外部深链只带 sosId 时页面自己按 sosId 查） */
export function sosActiveHref(
  sosId: string,
  deviceId?: string | null,
): `/sos-active?${string}` {
  return `/sos-active?sosId=${enc(sosId)}${deviceId ? `&deviceId=${enc(deviceId)}` : ""}`;
}

/** 求救记录详情 */
export function accidentHref(sosId: string): `/accident/${string}` {
  return `/accident/${enc(sosId)}`;
}
