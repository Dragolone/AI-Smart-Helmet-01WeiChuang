/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

/**
 * 设计令牌（2026-08-16 风格迭代）：深色优先的"硬件监控台"风格——
 * 近黑底 + 深灰描边卡片 + 荧光柠檬品牌色 + 半透明底语义药丸。
 * 参考基准见 PR 描述截图；语义色只用于状态，品牌色只用于主操作。
 */
export const Colors = {
  light: {
    text: '#16181D',
    background: '#F4F5F7',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#EEF0F3',
    textSecondary: '#60646C',
    border: 'rgba(17, 24, 39, 0.08)',
    borderStrong: 'rgba(17, 24, 39, 0.16)',
    // 浅色荧光柠檬三次真机迭代：#C7E62E 偏暗沉、#D6F536 白底上太淡看不清（2026-09-11 反馈）
    // → 去掉白混、拉满饱和度、亮度压一档：白底上更醒目，仍是荧光感，深色字 onBrand 对比充足
    brand: '#B9E600',
    onBrand: '#151804',
    success: '#1F9D55',
    successBg: 'rgba(31, 157, 85, 0.12)',
    warning: '#B97D10',
    warningBg: 'rgba(185, 125, 16, 0.12)',
    danger: '#D9534F',
    dangerBg: 'rgba(217, 83, 79, 0.12)',
    /** 大面积红底 + 白字的唯一场景（SOS 按钮）：比 danger 深一档保证 ≥ 4.5:1 对比 */
    sos: '#E0332A',
  },
  dark: {
    text: '#FFFFFF',
    background: '#0B0C0E',
    backgroundElement: '#151619',
    backgroundSelected: '#1F2126',
    textSecondary: '#9BA1AA',
    border: 'rgba(255, 255, 255, 0.08)',
    borderStrong: 'rgba(255, 255, 255, 0.24)',
    brand: '#D9F24A',
    onBrand: '#131503',
    success: '#4ADE80',
    successBg: 'rgba(74, 222, 128, 0.14)',
    warning: '#F5B84A',
    warningBg: 'rgba(245, 184, 74, 0.14)',
    danger: '#F26D5F',
    dangerBg: 'rgba(242, 109, 95, 0.16)',
    sos: '#E8433B',
  },
} as const;

/** 组件形状与阴影基准（参考风格：大圆角卡片 + 全药丸按钮） */
export const Radius = {
  card: 16,
  control: 14,
  pill: 999,
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
