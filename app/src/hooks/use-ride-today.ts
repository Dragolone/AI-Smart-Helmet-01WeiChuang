// 设备页「今日骑行」那一格的数据：本地零点到现在的里程 / 移动时长，由服务端 summary 累加。
// 没拿到（加载中 / 失败 / 接口未部署 404）≠ 今天没骑：status 分开给，页面上不把前者写成「还没有骑行」。
import { useQuery } from "@tanstack/react-query";

import { devicesApi } from "@/api/devices";
import { durationParts } from "@/services/rides";

/** 里程不到这个数不算骑过（头盔放着不动时的定位漂移） */
const MIN_DISTANCE_M = 50;

function todayWindow(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: new Date().toISOString() };
}

/** 时长写成「35 分钟」或「1:46 小时」两段（数字 + 单位），和地图页一趟的小结同一个写法 */
export function formatRideDuration(seconds: number): {
  value: string;
  unit: "h" | "min";
} {
  const { hours, minutes } = durationParts(seconds);
  return hours > 0
    ? { value: `${hours}:${String(minutes).padStart(2, "0")}`, unit: "h" }
    : { value: String(minutes), unit: "min" };
}

export type RideToday =
  | { status: "unknown" }
  | { status: "none" }
  | { status: "rode"; distanceMeters: number; movingSeconds: number };

export function useRideToday(deviceId: string): RideToday {
  const summary = useQuery({
    queryKey: ["ride-today", deviceId],
    queryFn: () => {
      const { from, to } = todayWindow();
      return devicesApi.locationSummary(deviceId, from, to);
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const s = summary.data;
  if (!s) return { status: "unknown" };
  if (s.distanceMeters < MIN_DISTANCE_M) return { status: "none" };
  return {
    status: "rode",
    distanceMeters: s.distanceMeters,
    movingSeconds: s.movingSeconds,
  };
}
