// 「安全事件」在 App 里的统一口径：安全页的卡片与「全部安全事件」页用同一份。
// 2026-09-23 负责人真机发现两处各写一份导致跑偏：一级页漏了 manual_sos，
// 用户按实体键求救后在首页永远看不到那条记录，只能进全部列表才找得到。
// 这里是唯一真相，两个页面都引用它。
//
// 「全部」≠ 原始事件流：device_status / location_update 这类噪音不进本页（决策 #27）。
export const SAFETY_EVENT_TYPES = [
  "collision_risk",
  "obstacle_risk",
  "possible_fall",
  "manual_sos",
  "risk_cleared",
] as const;

/** 查询参数用的逗号串（API.md §6 type 支持多值） */
export const SAFETY_EVENT_TYPE_PARAM = SAFETY_EVENT_TYPES.join(",");
