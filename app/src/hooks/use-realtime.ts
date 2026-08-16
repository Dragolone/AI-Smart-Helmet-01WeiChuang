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
  WsDeviceStatusData,
  WsLocationData,
  WsSosData,
} from '@helmet/shared';

import { authApi } from '@/api/auth';
import { realtimeClient } from '@/api/realtime';
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
        default:
          // risk_event / device_event：对应功能页（Week 9–10）接入时再消费
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
