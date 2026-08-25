// 高德跳转链接工具(决策 #32:导航一律拉起高德 App,不做 App 内导航)。
// 坐标须为 GCJ-02(dev=0);未安装高德时回落网页版。
import { Linking, Platform } from 'react-native';
import type { LngLat } from './coords';

export async function openAmapNavigation(pos: LngLat, label: string): Promise<void> {
  const { longitude, latitude } = pos;
  const scheme =
    Platform.OS === 'ios'
      ? `iosamap://navi?sourceApplication=helmet&lat=${latitude}&lon=${longitude}&dev=0`
      : `androidamap://navi?sourceApplication=helmet&lat=${latitude}&lon=${longitude}&dev=0`;
  try {
    await Linking.openURL(scheme);
  } catch {
    await Linking.openURL(
      `https://uri.amap.com/navigation?to=${longitude},${latitude},${encodeURIComponent(label)}&mode=car`,
    );
  }
}
