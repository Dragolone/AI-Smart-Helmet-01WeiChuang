// 底部标签（最终 IA 定案 2026-08-16）：设备 / 地图 / 对讲 / 安全 / 我的（Android 上限 5）
// 图标双轨：iOS 用 SF Symbols（模板 PNG 在 iOS 原生标签条按原始尺寸渲染会撑爆整条栏，
// 2026-08-16 真机实证）；Android 用模板 PNG。
// Android 这五张（2026-10-08 重出）是官方 Material Symbols Rounded 渲染的（Apache-2.0，字重 400），
// 含义和 iOS 一一对应：house / map / dot.radiowaves.left.and.right / shield / person.crop.circle
// → home / map / sensors / shield / account_circle；未选中是线框、选中是实心，也和 iOS 一样
//（电波那张两边都没有实心款）。此前那套是实心头盔 + 麦克风 + 带勾盾牌，粗细和含义都和 iOS 对不上。
// 不用组件自带的 md（运行时拿字体现画）：要多带 1 MB 的字体，图标还会晚一拍才出来。
import { router, usePathname } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useLocale, useT } from "@/i18n";
import { useIntercomStore } from "@/stores/intercom-store";

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme];
  const t = useT();
  const locale = useLocale();
  // 切换 App 语言时（只 iOS）把原生标签栏整个重建：iOS 原生标签项的读屏标签只在创建时取一次，之后改了文字
  // 它不跟着换——界面写「设备」，VoiceOver 读的还是上一种语言的「Devices」（10-16 iPhone 发现，10-17 负责人定：
  // 切语言时重建）。重建会把各标签页卸掉重挂：在对讲房间里时先不重建（对讲页一卸，通话就断了），出了房间再换；
  // 重建完回到原来那一页（在「我的」里切的语言，就还停在「我的」）
  const inRoom = useIntercomStore((s) => s.session !== null);
  const [tabsKey, setTabsKey] = useState(locale);
  if (tabsKey !== locale && !inRoom) setTabsKey(locale);
  const pathname = usePathname();
  const builtWith = useRef(tabsKey);
  useEffect(() => {
    if (Platform.OS !== "ios" || builtWith.current === tabsKey) return;
    builtWith.current = tabsKey;
    // 这一次渲染拿到的 pathname 还是重建之前的那一页
    const back = pathname;
    if (back === "/") return;
    const id = setTimeout(() => router.navigate(back as never), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在重建标签栏的那一下回到原来那一页
  }, [tabsKey]);

  return (
    <NativeTabs
      key={Platform.OS === "ios" ? tabsKey : undefined}
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundSelected}
      // 只有安卓认这个属性：默认只有选中项有字，「对讲」的图标单看不好认（10-31）
      labelVisibilityMode="labeled"
      tintColor={colors.brand}
      labelStyle={{
        default: { color: colors.textSecondary, fontSize: 11 },
        selected: { color: colors.text, fontSize: 11 },
      }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{t("tab.devices")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "house", selected: "house.fill" }}
          src={{
            default: require("@/assets/images/tabIcons/tab-devices.png"),
            selected: require("@/assets/images/tabIcons/tab-devices-selected.png"),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="map">
        <NativeTabs.Trigger.Label>{t("tab.map")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "map", selected: "map.fill" }}
          src={{
            default: require("@/assets/images/tabIcons/tab-map.png"),
            selected: require("@/assets/images/tabIcons/tab-map-selected.png"),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="intercom">
        <NativeTabs.Trigger.Label>{t("tab.intercom")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="dot.radiowaves.left.and.right"
          src={require("@/assets/images/tabIcons/tab-intercom.png")}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="safety">
        <NativeTabs.Trigger.Label>{t("tab.safety")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "shield", selected: "shield.fill" }}
          src={{
            default: require("@/assets/images/tabIcons/tab-safety.png"),
            selected: require("@/assets/images/tabIcons/tab-safety-selected.png"),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label>{t("tab.profile")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: "person.crop.circle",
            selected: "person.crop.circle.fill",
          }}
          src={{
            default: require("@/assets/images/tabIcons/tab-profile.png"),
            selected: require("@/assets/images/tabIcons/tab-profile-selected.png"),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
