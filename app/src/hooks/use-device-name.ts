import type { DevicePublic } from "@helmet/shared";
import { useQueryClient } from "@tanstack/react-query";

/**
 * 设备详情页 / 设置页顶部的名字。详情（["device-detail", id]）要等一次请求才有名字，回来之前标题只能写设备号，
 * 回来后又变成名字——第一次进页面就是「先闪设备号再变名字」。设备列表的缓存里早有名字（从列表点进来那一刻就在），
 * 详情没回来时先用它；详情一回来就以详情为准：别处可能已经改名、或清掉了名字，过期的列表名字不能盖过它。
 * 没有名字（含列表缓存没有 / 形状不对）返回 null，由调用方退回设备号。
 */
export function useDeviceNameBeforeDetail(
  deviceId: string,
  detail: Pick<DevicePublic, "name"> | undefined,
): string | null {
  const queryClient = useQueryClient();
  if (detail) return detail.name;
  const list = queryClient.getQueryData<DevicePublic[]>(["devices"]);
  return Array.isArray(list)
    ? (list.find((d) => d.deviceId === deviceId)?.name ?? null)
    : null;
}
