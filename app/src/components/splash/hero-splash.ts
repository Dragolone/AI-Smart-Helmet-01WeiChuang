// 设备页那块大图（当前头盔：电量环 + 头盔图 + 电量）「长什么样」的一份描述。
// 冷启动的开屏动画会先在屏幕中间画出它的替身、再送到页面上（landing-device.tsx），替身照这份描述画；
// 页面上真的那一份（(tabs)/index.tsx 的 Hero）用的是同一套规则。两边要一起改。
import type { DevicePublic } from "@helmet/shared";

import { helmetImageFor } from "@/constants/helmet-images";
import type { Colors } from "@/constants/theme";
import type { MessageKey } from "@/i18n";
import { mixHex } from "@/services/color";
import { linkPillOf } from "@/services/device-home";
import type { HelmetLink } from "@/services/safety-status";

export type HeroSplash = {
  /** 0–100；null = 没有电量数据，只画底环 */
  battery: number | null;
  /** 头盔此刻连着（环是彩色的、图是亮的） */
  linked: boolean;
  /** 环的颜色（连着：绿 / 电量低：黄；没连：灰） */
  arc: string;
  track: string;
  tick: string;
  /** 头盔背后那块柔光底 */
  spot: string;
  /** 头盔图（require 得到的资源号）和它在大图里的位置（占边长的比例） */
  image: number;
  imageBox: { left: number; top: number; size: number };
  /** 环外的光晕：半径（dp；null = 按大图边长的 1.05 倍）、中心和 46% 处的浓度。没连上时没有光晕 */
  glow: { radius: number | null; alpha: number; mid: number } | null;
  /** 电量那一行：在大图里多高的位置（比例）、小标题、数字 */
  batteryTop: number;
  label: string;
  labelColor: string;
  value: string;
  unit: string;
  valueColor: string;
};

export const LOW_BATTERY = 20;
/** 头盔图占环内 80%、水平居中，整体比环心略高一点（下面要给电量数字让位） */
export const HELMET_BOX = { left: 0.1, top: 0.075, size: 0.8 };
/** 电量那一行在大图里的高度 */
export const BATTERY_TOP = 0.85;

type Theme = (typeof Colors)["dark"] | (typeof Colors)["light"];

export function heroSplashOf(input: {
  device: DevicePublic;
  link: HelmetLink;
  theme: Theme;
  dark: boolean;
  t: (key: MessageKey) => string;
  /** 光晕半径（dp）：页面按上方留白算；还不知道就给 null */
  glowRadius: number | null;
}): HeroSplash {
  const { device, theme, dark, t } = input;
  const linked = linkPillOf(input.link).linked;
  const battery = device.battery;
  const low = battery !== null && battery <= LOW_BATTERY;
  // 连上时环和光晕是绿色，电量低变黄；没连上只剩灰色的环（显示的是上次电量），不发光
  const accent = !linked ? null : low ? theme.warning : theme.success;
  // 光晕的浓度。浅色底上同样的浓度几乎看不出来，所以浅色给得更足、往外也退得更慢
  const alpha = dark ? 0.32 : 0.34;
  const valueColor = !linked
    ? theme.textSecondary
    : low
      ? theme.warning
      : theme.text;
  return {
    battery,
    linked,
    arc: accent ?? theme.textSecondary,
    track: mixHex(theme.background, theme.text, 0.1),
    tick: theme.borderStrong,
    // 头盔图背后的一块柔光底：让深色头盔从近黑的页面底色里分出来
    spot: dark ? theme.backgroundSelected : theme.backgroundElement,
    image: helmetImageFor(device.deviceId),
    imageBox: HELMET_BOX,
    glow: accent
      ? { radius: input.glowRadius, alpha, mid: dark ? alpha / 3 : alpha / 2 }
      : null,
    batteryTop: BATTERY_TOP,
    label: !linked
      ? t("devices.batteryLast")
      : device.charging
        ? t("devices.charging")
        : low
          ? t("devices.batteryLow")
          : t("devices.battery"),
    labelColor: linked && low ? theme.warning : theme.textSecondary,
    value: battery === null ? "—" : String(battery),
    unit: battery === null ? "" : "%",
    valueColor,
  };
}
