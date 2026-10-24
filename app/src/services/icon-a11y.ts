// 图标一律不进读屏（优化清单 13，回归 7.12）：图标是图标字体里的一个私用区字符，按钮没单独写读屏名字时，
// RN 把按钮里的文字拼成名字，图标也被拼进去（VoiceOver 拿到的是「, 安全记录」）。
// iOS 新架构拼名字时跳过 accessibilityElementsHidden 的子视图，安卓读屏跳过 importantForAccessibility="no" 的。
// 纯图标按钮都在按钮上写了读屏名字（7.12 双端巡检 0 个没名字），不靠图标字符；也没有把图标本身当按钮用的地方。
import { Ionicons, MaterialIcons } from "@expo/vector-icons";

const HIDDEN = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no",
} as const;

/** 根布局加载时调一次：改的是图标组件共用的默认属性，之后渲染的每个图标都带上 */
export function hideIconsFromScreenReader(): void {
  for (const Icon of [Ionicons, MaterialIcons]) {
    // 外层（等字体加载）和内层图标组件共用同一个 defaultProps 对象，原地改两层都生效；测试替身没有就跳过
    const defaults = (Icon as { defaultProps?: object } | undefined)
      ?.defaultProps;
    if (defaults) Object.assign(defaults, HIDDEN);
  }
}
