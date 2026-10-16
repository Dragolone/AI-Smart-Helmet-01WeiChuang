// 安全首页 / 安全记录页 / 安全设置页共用的几份数据。都是读取与推导，不发起任何连接或求救动作。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { DevicePublic, Sos } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { sosApi } from "@/api/sos";
import {
  activeSosStore,
  pollAccountActive,
  SOS_ACTIVE_ACCOUNT_KEY,
} from "@/services/sos-queue";
import { readNotifyPermissionAfterAsk } from "@/services/notify-permission";
import {
  helmetLinkOf,
  type HelmetLink,
  type NotifyPermission,
} from "@/services/safety-status";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore, type BleLinkPhase } from "@/stores/ble-store";
import { useCurrentHelmetStore } from "@/stores/current-helmet-store";
import { useDrillStore } from "@/stores/drill-store";

/**
 * 设备页「设为当前」的选择（按账号存，见 current-helmet-store）。
 * chosenId 在读到存储之前是 null，按没选过走默认规则；ready 给设备页用——
 * 冷启动时等读到了再画大图，免得先显示一台再跳到另一台。
 */
export function useCurrentHelmetChoice(): {
  chosenId: string | null;
  ready: boolean;
  choose: (deviceId: string) => void;
} {
  const userId = useAuthStore((s) => s.user?.id);
  const stored = useCurrentHelmetStore((s) =>
    userId ? s.chosen[userId] : undefined,
  );
  const load = useCurrentHelmetStore((s) => s.load);
  const chooseFor = useCurrentHelmetStore((s) => s.choose);
  useEffect(() => {
    if (userId) void load(userId);
  }, [userId, load]);
  return {
    chosenId: stored ?? null,
    // 没有登录用户时没有可读的选择，不让页面一直等
    ready: !userId || stored !== undefined,
    choose: (deviceId) => {
      if (userId) chooseFor(userId, deviceId);
    },
  };
}

/** 绑定的头盔（安全页 / 安全记录页共用；看哪一顶由设备页的「当前头盔」决定，这里不再另存一份） */
export function useHelmets() {
  // 与设备页同一份缓存、同样的 30 秒轮询兜底：WS 断着的时候，这里的「在线」不至于一直停在旧值，
  // 拉取失败时 isError 也会如实翻过来
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    refetchInterval: 30_000,
  });
  const list = devices.data ?? [];
  const { chosenId } = useCurrentHelmetChoice();
  return {
    list,
    /** 设备页「设为当前」的选择，求救关联（sosTargetOf）要用 */
    chosenId,
    /** 列表拿到过没有：没拿到（还在拉 / 拉失败）≠ 一台都没绑 */
    known: devices.data !== undefined,
    /** 最近一次拉取失败：缓存里的状态可能是旧的 */
    stale: devices.isError,
    error: devices.error,
    refetch: devices.refetch,
  };
}

/**
 * 各头盔的连接结论。BLE store 里整条 link 每来一帧都会变（lastFrameAt / eventsReceived），
 * 这里只订阅各台的 phase 拼成的字符串，帧到达不会让页面重画。
 */
export function useHelmetLinks(
  devices: readonly DevicePublic[],
  serverFresh: boolean,
): Record<string, HelmetLink> {
  const adapter = useBleStore((s) => s.adapter);
  const phases = useBleStore((s) =>
    devices.map((d) => s.links[d.deviceId]?.phase ?? "").join("|"),
  ).split("|");
  const out: Record<string, HelmetLink> = {};
  devices.forEach((d, i) => {
    out[d.deviceId] = helmetLinkOf(
      d,
      { phase: (phases[i] || undefined) as BleLinkPhase | undefined, adapter },
      serverFresh,
    );
  });
  return out;
}

/**
 * 本账号所有仍在倒计时的求救（不按「正在查看的头盔」筛）：进行中的求救在哪一页都不能被筛掉，头盔已解绑、单还是本人的也在。
 * 读的是按头盔的进行中缓存 ["sos-active", *]（WS 推送 / 补拉直写），按到期先后、每顶头盔一单（同倒计时页的队列）。
 * 30 秒一轮的兜底轮询走账号级接口一次拿全（B 线第 12 项）：原来每顶头盔各一个查询，绑得多时把 App 拖死（10-16 F10）。
 * 写回时过终态守卫和在途守卫（sos-queue 的 applyAccountActive）。没绑头盔时不轮询
 */
export function usePendingSos(deviceIds: readonly string[]): Sos[] {
  const queryClient = useQueryClient();
  useQuery({
    queryKey: SOS_ACTIVE_ACCOUNT_KEY,
    queryFn: () =>
      pollAccountActive(queryClient, deviceIds, () =>
        sosApi.activeForAccount(),
      ),
    refetchInterval: 30_000,
    enabled: deviceIds.length > 0,
  });
  return useActiveSosQueue();
}

/** 进行中队列（缓存推导，缓存一变就重算）；不发请求 */
export function useActiveSosQueue(): Sos[] {
  const queryClient = useQueryClient();
  const store = useMemo(() => activeSosStore(queryClient), [queryClient]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * 通知权限；null = 还没查到（包括系统的授权框还开着、用户还没点的时候）。
 * 回前台再查一次：用户多半是刚从系统设置改完权限回来
 */
export function useNotifyPermission(): NotifyPermission | null {
  const [state, setState] = useState<NotifyPermission | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void readNotifyPermissionAfterAsk().then((p) => {
        if (alive) setState(p);
      });
    check();
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return state;
}

/**
 * SOS 演练入口（首页那一行和安全设置里的那一项共用）。
 * 首页只在「确定没打开过」时显示入口：还没读到存储时不显示，免得闪一下。
 * 从哪个入口点开都记为打开过。演练页本身（/sos-active?drill=1）没有改动。
 */
export function useSosDrill(): { unseen: boolean; open: () => void } {
  const userId = useAuthStore((s) => s.user?.id);
  const seen = useDrillStore((s) => (userId ? s.seen[userId] : undefined));
  const load = useDrillStore((s) => s.load);
  const markSeen = useDrillStore((s) => s.markSeen);
  useEffect(() => {
    if (userId) void load(userId);
  }, [userId, load]);
  return {
    unseen: seen === false,
    open: () => {
      if (userId) markSeen(userId);
      router.navigate("/sos-active?drill=1");
    },
  };
}
