// 安卓 8.0 / 8.1（API 26 / 27）默认还是系统旧的 OpenGL 绘制管线（9 起换成 Skia 管线）。倒计时环、电量环的画法是
// 「圆形 View 只给一条边上色、再旋转」，旧管线处理不了圆角裁剪和旋转叠在一起：弧线斜穿过倒计时数字、电量环多出一段往里拐的弧
//（10-22 模拟器：8.0 / 8.1 都错、9 正常；9 上用 debug.hwui.renderer 强制切回旧管线后错得一模一样）。
// 这些机型改用 Skia 画弧（Skia 自己渲染，不走系统的裁剪）；iOS 和安卓 9 起照旧
import { Platform } from "react-native";

export function isLegacyAndroidRenderer(
  os: string,
  version: number | string,
): boolean {
  return os === "android" && typeof version === "number" && version < 28;
}

export const LEGACY_ANDROID_RENDERER = isLegacyAndroidRenderer(
  Platform.OS,
  Platform.Version,
);
