// https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// 开屏预录的路线帧（assets/splash/route-frames.skpack）按资源文件打包
config.resolver.assetExts.push("skpack");

module.exports = config;
