// Week 2 BLE Spike（临时页面，定案后删除）：验证 react-native-ble-plx——扫描、连接、断开检测
// 对应 BLE 防丢链路的基础能力；iOS 后台行为是另一半重点，在 iPhone 真机上测
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

type Found = { id: string; name: string; rssi: number };

export default function SpikeBleScreen() {
  const managerRef = useRef<BleManager | null>(null);
  const disconnectSub = useRef<Subscription | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [devices, setDevices] = useState<Map<string, Found>>(new Map());
  const [connected, setConnected] = useState<Device | null>(null);

  const log = (msg: string) => {
    console.log(`[spike-ble] ${msg}`);
    setLines((prev) => [...prev.slice(-6), `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  useEffect(() => {
    managerRef.current = new BleManager();
    return () => {
      disconnectSub.current?.remove();
      managerRef.current?.destroy();
    };
  }, []);

  const scan = () => {
    const manager = managerRef.current;
    if (!manager) return;
    setDevices(new Map());
    manager.stopDeviceScan();
    log('开始扫描 10 秒…（BLE 外设才会出现，经典蓝牙耳机可能扫不到）');
    manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        log(`扫描错误：${error.message}`);
        return;
      }
      if (device) {
        setDevices((prev) => {
          const next = new Map(prev);
          next.set(device.id, {
            id: device.id,
            name: device.name ?? device.localName ?? '(无名)',
            rssi: device.rssi ?? 0,
          });
          return next;
        });
      }
    });
    setTimeout(() => {
      manager.stopDeviceScan();
      log('扫描结束');
    }, 10_000);
  };

  const connect = async (id: string, name: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.stopDeviceScan();
    log(`连接 ${name}…`);
    try {
      const device = await manager.connectToDevice(id, { timeout: 10_000 });
      setConnected(device);
      log(`已连接：${name}`);
      // 防丢核心：断连事件必须能被感知
      disconnectSub.current = manager.onDeviceDisconnected(id, (_err, dev) => {
        log(`⚡ 断开检测触发：${dev?.name ?? id}`);
        setConnected(null);
      });
    } catch (e) {
      log(`连接失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const disconnect = async () => {
    if (connected) {
      await connected.cancelConnection();
      log('主动断开（应随后触发断开检测回调）');
    }
  };

  const list = [...devices.values()].sort((a, b) => b.rssi - a.rssi);

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">BLE Spike</ThemedText>
        <ThemedView style={styles.row}>
          <Pressable style={styles.button} onPress={scan}>
            <ThemedText type="smallBold" style={styles.buttonText}>
              扫描
            </ThemedText>
          </Pressable>
          {connected && (
            <Pressable style={[styles.button, styles.buttonDanger]} onPress={disconnect}>
              <ThemedText type="smallBold" style={styles.buttonText}>
                断开 {connected.name ?? ''}
              </ThemedText>
            </Pressable>
          )}
        </ThemedView>

        {lines.map((l, i) => (
          <ThemedText key={i} type="small">
            {l}
          </ThemedText>
        ))}

        <FlatList
          style={styles.flex}
          data={list}
          keyExtractor={(d) => d.id}
          renderItem={({ item }) => (
            <Pressable onPress={() => connect(item.id, item.name)} style={styles.deviceRow}>
              <ThemedText type="smallBold">{item.name}</ThemedText>
              <ThemedText type="small">
                {item.rssi} dBm · {item.id.slice(0, 17)} · 点击连接
              </ThemedText>
            </Pressable>
          )}
        />
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 24, gap: 12 },
  row: { flexDirection: 'row', gap: 12 },
  deviceRow: { paddingVertical: 8, gap: 2 },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  buttonDanger: { backgroundColor: '#D9534F' },
  buttonText: { color: '#fff' },
});
