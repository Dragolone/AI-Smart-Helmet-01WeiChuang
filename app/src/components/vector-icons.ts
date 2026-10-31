// metro.config.js 把 "@expo/vector-icons" 这个裸包名指到本文件（TS 类型仍走原包）。
// 原包入口一次引 19 套图标，每套一个 .ttf 全打进包（实测只用 Ionicons / MaterialIcons，其余约 4 MB 白占）；
// 要用新图标集，先在这里加导出并更新 audit-vector-icons 测试，不要绕过。
export { default as Ionicons } from "@expo/vector-icons/Ionicons";
export { default as MaterialIcons } from "@expo/vector-icons/MaterialIcons";
