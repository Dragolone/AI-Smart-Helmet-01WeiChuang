// BLE 中转链路骨架(决策 #29/#31/#35):管理器生命周期 + 双端权限流程。
// GATT 服务/特征值协议是硬件前置(DEVICE_PROTOCOL §10 联调清单第 1 条)——
// 协议到位后在此补:扫描过滤(按广播名/服务 UUID)、连接、订阅事件特征值 →
// 解析 envelope → enqueueRelayEvent(ble-relay-uplink);下行写入接 ble-relay。
// 后台保活(iOS bluetooth-central / 华为杀后台)双端实测记入 DEVELOPMENT.md 平台限制清单。
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';

let manager: BleManager | null = null;

/** 惰性单例:BleManager 构造即拉起原生栈,只在真正用 BLE 时创建 */
export function getBleManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

/** Android 12+ 需要运行时 BLUETOOTH_SCAN/CONNECT;旧版本靠定位权限;iOS 由系统在首次使用时弹窗 */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const r = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  const r = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** 蓝牙就绪(PoweredOn);未开蓝牙时调用方引导用户去系统设置 */
export async function bleReady(): Promise<boolean> {
  return (await getBleManager().state()) === State.PoweredOn;
}
