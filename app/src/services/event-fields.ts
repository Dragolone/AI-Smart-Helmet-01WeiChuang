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

/**
 * 只认表里自己的键：载荷里的方向 / 目标叫 constructor / toString / __proto__ 时，普通下标会取到
 * Object.prototype 上的函数或对象，交给翻译后显示成一片空白（同 api/error-messages 的 own）
 */
const own = (table: Record<string, MessageKey>, key: string) =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

export type RiskLevel = "high" | "medium" | "low";
const RISK_LEVELS: Record<string, RiskLevel> = {
  high: "high",
  medium: "medium",
  low: "low",
};

/**
 * 风险档位。EVENTS.md 4.5：App 收到未知档位按 high 兜底——原来未知值（如 "extreme"）详情页
 * 干脆不显示档位（2026-10-16 模拟器实测）；不是字符串（缺省 / 坏数据）时没有档位。
 */
export function riskLevelOf(
  payload: Record<string, unknown>,
): RiskLevel | null {
  const v = payload.riskLevel;
  if (typeof v !== "string") return null;
  return Object.prototype.hasOwnProperty.call(RISK_LEVELS, v)
    ? RISK_LEVELS[v]
    : "high";
}

/**
 * 数值字段在合理范围内才显示：载荷原样落库，坏数据会显示成「-5.0 m」「1e+308 m」
 *（2026-10-16 模拟器实测）。上限取 v0.6 载荷能表示的最大值。
 */
const inRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** 把 payload 里用户看得懂的字段挑出来（原始 JSON 不给用户看）；未知枚举值原样显示，数值越界的不显示 */
export function readableEventFields(
  payload: Record<string, unknown>,
  t: Translate,
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (typeof payload.direction === "string") {
    const key = own(DIRECTION_LABEL, payload.direction);
    out.push({
      label: t("events.field.direction"),
      value: key ? t(key) : payload.direction,
    });
  }
  if (typeof payload.objectType === "string") {
    const key = own(OBJECT_LABEL, payload.objectType);
    out.push({
      label: t("events.field.object"),
      value: key ? t(key) : payload.objectType,
    });
  }
  if (inRange(payload.distance, 0, 6553.5))
    out.push({
      label: t("events.field.distance"),
      value: `${payload.distance.toFixed(1)} m`,
    });
  // v0.6 载荷里由 App 中转附上的硬件原始量（EVENTS.md 4.3–4.5）：有就显示，没有不占位
  if (inRange(payload.ttcSeconds, 0, 6553.5))
    out.push({
      label: t("events.field.ttc"),
      value: `${payload.ttcSeconds.toFixed(1)} s`,
    });
  if (inRange(payload.approachSpeedKmh, 0, 255))
    out.push({
      label: t("events.field.approachSpeed"),
      value: `${Math.round(payload.approachSpeedKmh)} km/h`,
    });
  if (inRange(payload.impactG, 0, 6553.5))
    out.push({
      label: t("events.field.impact"),
      value: `${payload.impactG.toFixed(1)} g`,
    });
  if (inRange(payload.tiltDeg, 0, 360))
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
  if (inRange(payload.pressDurationMs, 0, 600_000))
    out.push({
      label: t("events.field.pressDuration"),
      value: `${(payload.pressDurationMs / 1000).toFixed(1)} s`,
    });
  if (inRange(payload.confidence, 0, 1))
    out.push({
      label: t("events.field.confidence"),
      value: `${Math.round(payload.confidence * 100)}%`,
    });
  return out;
}
