// 底部标签（最终 IA 定案 2026-08-16）：设备 / 地图 / 对讲 / 安全 / 我的（Android 上限 5）
// 图标双轨：iOS 用 SF Symbols（模板 PNG 在 iOS 原生标签条按原始尺寸渲染会撑爆整条栏，
// 2026-08-16 真机实证）；Android 用模板 PNG。
// Android 这五张（2026-10-08 重出）是官方 Material Symbols Rounded 渲染的（Apache-2.0，字重 400），
// 含义和 iOS 一一对应：house / map / dot.radiowaves.left.and.right / shield / person.crop.circle
// → home / map / sensors / shield / account_circle；未选中是线框、选中是实心，也和 iOS 一样
//（电波那张两边都没有实心款）。此前那套是实心头盔 + 麦克风 + 带勾盾牌，粗细和含义都和 iOS 对不上。
// 不用组件自带的 md（运行时拿字体现画）：要多带 1 MB 的字体，图标还会晚一拍才出来。
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useT } from '@/i18n';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme];
  const t = useT();

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundSelected}
      tintColor={colors.brand}
      labelStyle={{
        default: { color: colors.textSecondary, fontSize: 11 },
        selected: { color: colors.text, fontSize: 11 },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{t('tab.devices')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          src={{
            default: require('@/assets/images/tabIcons/tab-devices.png'),
            selected: require('@/assets/images/tabIcons/tab-devices-selected.png'),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="map">
        <NativeTabs.Trigger.Label>{t('tab.map')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'map', selected: 'map.fill' }}
          src={{
            default: require('@/assets/images/tabIcons/tab-map.png'),
            selected: require('@/assets/images/tabIcons/tab-map-selected.png'),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="intercom">
        <NativeTabs.Trigger.Label>{t('tab.intercom')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="dot.radiowaves.left.and.right"
          src={require('@/assets/images/tabIcons/tab-intercom.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="safety">
        <NativeTabs.Trigger.Label>{t('tab.safety')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'shield', selected: 'shield.fill' }}
          src={{
            default: require('@/assets/images/tabIcons/tab-safety.png'),
            selected: require('@/assets/images/tabIcons/tab-safety-selected.png'),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label>{t('tab.profile')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'person.crop.circle',
            selected: 'person.crop.circle.fill',
          }}
          src={{
            default: require('@/assets/images/tabIcons/tab-profile.png'),
            selected: require('@/assets/images/tabIcons/tab-profile-selected.png'),
          }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
