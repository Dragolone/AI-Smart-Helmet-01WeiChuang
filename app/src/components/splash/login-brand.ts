// 登录页顶部的商标和「零一唯创」：开屏把商标和这四个字送到这里，所以两边用同一组尺寸。
// 按屏幕宽度等比（设计稿把屏幕宽当 282 个单位），太宽的屏幕封顶。
const UNIT_W = 282;
const unit = (width: number) => Math.min(width, 430) / UNIT_W;

export const LOGIN_BRAND = {
  /** 商标边长：开屏里 196 的商标缩到 0.44 */
  markSize: (width: number) => Math.round(86 * unit(width)),
  titleSize: (width: number) => Math.round(19 * unit(width) * 2) / 2,
  titleSpacing: (width: number) => 1.2 * unit(width),
  /** 商标和标题之间 */
  gap: (width: number) => Math.round(14 * unit(width)),
};
