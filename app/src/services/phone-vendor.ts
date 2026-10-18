// 手机厂商判断。华为 / 荣耀的「应用启动管理」是它们自己的东西：默认「自动管理」时从多任务划掉 App 等于系统强停，
// 之后求救推送到不了（10-18 华为 P30 Pro 实测，DEVELOPMENT 平台限制清单）；别的厂商没有这一项，不提示。
import * as Device from "expo-device";

export function isHuaweiFamily(): boolean {
  const s = `${Device.manufacturer ?? ""} ${Device.brand ?? ""}`.toLowerCase();
  return s.includes("huawei") || s.includes("honor");
}
