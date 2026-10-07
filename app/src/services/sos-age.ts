// 补传旧事件的「年龄」文案（决策 #52）：与服务端 sos-trigger.service.ts describeEventAge 同口径——
// 事件时间比现在早不到 5 分钟视为时钟偏差、不提；早于 72 小时不可信、也不提。
import { translate } from "@/i18n";

const CLOCK_SKEW_THRESHOLD_MS = 5 * 60_000;
const MAX_PLAUSIBLE_BACKFILL_MS = 72 * 3_600_000;

export type EventAge = { unit: "minutes" | "hours"; n: number };

/** 事件比 now（服务端时钟）早多少；不在可信区间、缺省或解析不了都返回 null */
export function eventAge(
  triggeredAt: string | undefined,
  now: number,
): EventAge | null {
  if (!triggeredAt) return null;
  const at = new Date(triggeredAt).getTime();
  if (!Number.isFinite(at)) return null;
  const ageMs = now - at;
  if (ageMs < CLOCK_SKEW_THRESHOLD_MS || ageMs > MAX_PLAUSIBLE_BACKFILL_MS) {
    return null;
  }
  const minutes = Math.round(ageMs / 60_000);
  return minutes < 90
    ? { unit: "minutes", n: minutes }
    : { unit: "hours", n: Math.round(minutes / 60) };
}

/** 「约 3 小时前的事件，刚补传到」；不该提时返回 null */
export function lateEventNote(
  triggeredAt: string | undefined,
  now: number,
): string | null {
  const age = eventAge(triggeredAt, now);
  if (!age) return null;
  return translate(
    age.unit === "minutes" ? "sos.lateEventMinutes" : "sos.lateEventHours",
    { n: age.n },
  );
}
