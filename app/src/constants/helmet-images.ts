// 头盔演示图池：设备暂无型号字段（待硬件定稿），按 deviceId 稳定散列分配。
// 设备页的大图 / 列表缩略图、地图页选头盔的面板共用，同一顶头盔在各处是同一张图。
const HELMET_IMAGES = [
  require("@/assets/images/helmet-aero-v1.webp"),
  require("@/assets/images/helmet-ski-v5.webp"),
] as const;

export function helmetImageFor(deviceId: string) {
  let x = 0;
  for (const c of deviceId) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return HELMET_IMAGES[x % HELMET_IMAGES.length];
}
