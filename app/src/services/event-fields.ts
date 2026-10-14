// 事件 payload 里用户看得懂的字段（方向、目标、距离、冲击力、触发方式…）。
// 两处共用：安全记录页的风险提醒详情，以及 SOS 记录详情里的触发事件——摔倒 / 手动求救归到
// 「SOS 记录」之后，它们的冲击力、倾角、触发方式要在那一页继续看得到（REGRESSION 5.7）。
import type { MessageKey, Params } from "@/i18n";

type Translate = (key: MessageKey, params?: Params) => string;

const DIRECTION_LABEL: Record<string, MessageKey> = {
  front: "events.dir.front",
  rear: "events.dir.rear",
  left: "events.dir.left",
  right: "events.dir.right",
};
const OBJECT_LABEL: Record<string, MessageKey> = {
  vehicle: "events.obj.vehicle",
  pedestrian: "events.obj.pedestrian",
  obstacle: "events.obj.obstacle",
  unknown: "events.obj.unknown",
};

/** 把 payload 里用户看得懂的字段挑出来（原始 JSON 不给用户看）；未知枚举值原样显示 */
export function readableEventFields(
  payload: Record<string, unknown>,
  t: Translate,
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (typeof payload.direction === "string") {
    const key = DIRECTION_LABEL[payload.direction];
    out.push({
      label: t("events.field.direction"),
      value: key ? t(key) : payload.direction,
    });
  }
  if (typeof payload.objectType === "string") {
    const key = OBJECT_LABEL[payload.objectType];
    out.push({
      label: t("events.field.object"),
      value: key ? t(key) : payload.objectType,
    });
  }
  if (typeof payload.distance === "number")
    out.push({
      label: t("events.field.distance"),
      value: `${payload.distance.toFixed(1)} m`,
    });
  // v0.6 载荷里由 App 中转附上的硬件原始量（EVENTS.md 4.3–4.5）：有就显示，没有不占位
  if (typeof payload.ttcSeconds === "number")
    out.push({
      label: t("events.field.ttc"),
      value: `${payload.ttcSeconds.toFixed(1)} s`,
    });
  if (typeof payload.approachSpeedKmh === "number")
    out.push({
      label: t("events.field.approachSpeed"),
      value: `${Math.round(payload.approachSpeedKmh)} km/h`,
    });
  if (typeof payload.impactG === "number")
    out.push({
      label: t("events.field.impact"),
      value: `${payload.impactG.toFixed(1)} g`,
    });
  if (typeof payload.tiltDeg === "number")
    out.push({
      label: t("events.field.tilt"),
      value: `${Math.round(payload.tiltDeg)}°`,
    });
  if (
    payload.triggerMode === "long_press" ||
    payload.triggerMode === "double_click"
  )
    out.push({
      label: t("events.field.triggerMode"),
      value: t(
        payload.triggerMode === "long_press"
          ? "events.trigger.longPress"
          : "events.trigger.doubleClick",
      ),
    });
  if (typeof payload.pressDurationMs === "number")
    out.push({
      label: t("events.field.pressDuration"),
      value: `${(payload.pressDurationMs / 1000).toFixed(1)} s`,
    });
  if (typeof payload.confidence === "number")
    out.push({
      label: t("events.field.confidence"),
      value: `${Math.round(payload.confidence * 100)}%`,
    });
  return out;
}
