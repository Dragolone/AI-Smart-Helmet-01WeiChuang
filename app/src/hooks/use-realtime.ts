// 实时推送 → react-query 缓存：登录期间常驻挂载（(tabs) 布局）。
// WS 只负责"更快"；已有的 REST 轮询保持不变作为可靠性兜底（API.md §11）。
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type {
  ActiveSosResponse,
  DevicePublic,
  DeviceStatus,
  WsDeviceCommandData,
  WsDeviceStatusData,
  WsLocationData,
  WsSosData,
} from '@helmet/shared';

import { authApi } from '@/api/auth';
import { realtimeClient } from '@/api/realtime';
import { handleDeviceCommand } from '@/services/ble-relay';
import { startRelayUplink, stopRelayUplink } from '@/services/ble-relay-uplink';
import { useAuthStore } from '@/stores/auth-store';

export function useRealtimeUpdates(): void {
  const queryClient = useQueryClient();
  const authed = useAuthStore((s) => s.tokens !== null);
  // 防止同一单的多次 pending 推送（重连补拉等）重复弹全屏页
  const presentedSosId = useRef<string | null>(null);

  useEffect(() => {
    if (!authed) return;

    realtimeClient.start({
      getAccessToken: () => useAuthStore.getState().tokens?.accessToken ?? null,
      triggerTokenRefresh: () => authApi.me(),
    });
    // BLE 上行中转队列与登录态同生命周期(决策 #35:BLE 是唯一真机数据链路)；按账号分区，换账号不混用
    startRelayUplink(useAuthStore.getState().user?.id ?? undefined);

    const unsubscribe = realtimeClient.subscribe((message) => {
      switch (message.type) {
        case 'device_status': {
          const { deviceId, ...status } = message.data as WsDeviceStatusData;
          // 详情页缓存：整体替换
          queryClient.setQueryData<DeviceStatus>(
            ['device-status', deviceId],
            status,
          );
          // 列表缓存：合并进对应设备行
          queryClient.setQueryData<DevicePublic[]>(['devices'], (prev) =>
            prev?.map((d) =>
              d.deviceId === deviceId ? { ...d, ...status } : d,
            ),
          );
          break;
        }
        case 'risk_event':
        case 'device_event': {
          // 危险/设备事件推送 → 事件页缓存失效即时刷新(§6)
          void queryClient.invalidateQueries({ queryKey: ['events'] });
          break;
        }
        case 'location_update': {
          // 地图页（等高德 Key 接 SDK）消费；先落缓存供实时数据卡使用
          const data = message.data as WsLocationData;
          queryClient.setQueryData(['device-location', data.deviceId], data);
          break;
        }
        case 'sos_update': {
          // 服务端权威：创建/取消/确认/超时通知四个时机都推（shared WsSosData）
          const sos = message.data as WsSosData;
          queryClient.setQueryData<ActiveSosResponse>(['sos-active', sos.deviceId], {
            sos: sos.status === 'pending' ? sos : null,
          });
          queryClient.setQueryData(['sos', sos.sosId], sos);
          void queryClient.invalidateQueries({ queryKey: ['accidents'] });
          if (sos.status === 'pending' && presentedSosId.current !== sos.sosId) {
            presentedSosId.current = sos.sosId;
            router.push(`/sos-active?sosId=${sos.sosId}&deviceId=${sos.deviceId}`);
          }
          break;
        }
        case 'device_command': {
          // BLE 下行通道(决策 #36):写头盔+回执由 ble-relay 处理,完成后刷新设置页状态
          const cmd = message.data as WsDeviceCommandData;
          void handleDeviceCommand(cmd).then((acked) => {
            if (acked) {
              void queryClient.invalidateQueries({
                queryKey: ['device-settings', cmd.deviceId],
              });
            }
          });
          break;
        }
        default:
          break;
      }
    });

    // 回前台立即触发一次兜底刷新（WS 断线期间可能漏消息）
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void queryClient.invalidateQueries({ queryKey: ['devices'] });
      }
    });

    return () => {
      unsubscribe();
      appState.remove();
      realtimeClient.stop();
      stopRelayUplink();
    };
  }, [authed, queryClient]);
}
