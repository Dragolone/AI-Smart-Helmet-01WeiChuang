// 实时推送 → react-query 缓存：登录期间常驻挂载（(tabs) 布局）。
// WS 只负责"更快"；已有的 REST 轮询保持不变作为可靠性兜底（API.md §11）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type {
  DevicePublic,
  DeviceStatus,
  WsDeviceStatusData,
  WsLocationData,
} from '@helmet/shared';

import { authApi } from '@/api/auth';
import { realtimeClient } from '@/api/realtime';
import { useAuthStore } from '@/stores/auth-store';

export function useRealtimeUpdates(): void {
  const queryClient = useQueryClient();
  const authed = useAuthStore((s) => s.tokens !== null);

  useEffect(() => {
    if (!authed) return;

    realtimeClient.start({
      getAccessToken: () => useAuthStore.getState().tokens?.accessToken ?? null,
      triggerTokenRefresh: () => authApi.me(),
    });

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
        case 'location_update': {
          // 地图页（Week 5–6，等高德 Key）消费；先落缓存备用
          const data = message.data as WsLocationData;
          queryClient.setQueryData(['device-location', data.deviceId], data);
          break;
        }
        default:
          // sos_update / risk_event / device_event：对应功能页接入时再消费
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
    };
  }, [authed, queryClient]);
}
