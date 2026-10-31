// https://docs.expo.dev/guides/customizing-metro/
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// 开屏预录的路线帧（assets/splash/route-frames.skpack）按资源文件打包
config.resolver.assetExts.push("skpack");

// "@expo/vector-icons" 裸包名只给 Ionicons / MaterialIcons：原包入口把 19 套图标字体全打进包（约 4 MB）。
// 只拦这个精确名，@expo/vector-icons/Ionicons 这类子路径和其它模块走默认解析；类型仍来自原包（见 vector-icons.ts）。
const VECTOR_ICONS_SHIM = path.join(
  __dirname,
  "src/components/vector-icons.ts",
);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@expo/vector-icons") {
    return { type: "sourceFile", filePath: VECTOR_ICONS_SHIM };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
