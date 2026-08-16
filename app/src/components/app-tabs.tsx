// 底部标签（最终 IA 定案 2026-08-16）：设备 / 地图 / 对讲 / 安全 / 我的（Android 上限 5）
// spike-* 页面文件保留（统一清 legacy 时删除），不再占标签位。
// 图标双轨：iOS 用 SF Symbols（模板 PNG 在 iOS 原生标签条按原始尺寸渲染会撑爆整条栏，
// 2026-08-16 真机实证）；Android 继续用模板 PNG（正式设计资产出图后统一替换）。
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundSelected}
      tintColor={colors.brand}
      labelStyle={{ selected: { color: colors.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>设备</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          src={require('@/assets/images/tabIcons/tab-devices.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="map">
        <NativeTabs.Trigger.Label>地图</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'map', selected: 'map.fill' }}
          src={require('@/assets/images/tabIcons/tab-map.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="intercom">
        <NativeTabs.Trigger.Label>对讲</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="dot.radiowaves.left.and.right"
          src={require('@/assets/images/tabIcons/tab-intercom.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="safety">
        <NativeTabs.Trigger.Label>安全</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'shield', selected: 'shield.fill' }}
          src={require('@/assets/images/tabIcons/tab-safety.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label>我的</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'person.crop.circle',
            selected: 'person.crop.circle.fill',
          }}
          src={require('@/assets/images/tabIcons/tab-profile.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
