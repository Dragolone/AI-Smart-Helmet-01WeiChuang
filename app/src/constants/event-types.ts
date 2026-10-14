// 「风险提醒」在 App 里的统一口径：安全记录页的「风险提醒」列表查的就是这几类。
//
// 2026-10-06 安全页重排后，记录分成两类，各走各的数据源：
// - 风险提醒 = 头盔雷达类提醒及其解除（本文件的类型，查 §6 事件接口）；
// - SOS 记录 = 求救单（查 §7 事故记录接口）。possible_fall / manual_sos 这两类触发事件不再混在
//   提醒列表里——它们各自对应一张求救单，在「SOS 记录」里带着处理结果出现。
// 此前（2026-09-23）两类混在一份「安全事件」里，是因为当时首页只有这一个列表：漏了 manual_sos，
// 用户按实体键求救后在首页找不到那条记录。现在首页那一格放的就是「最近一次 SOS 记录」，
// 风险提醒只在安全记录页里看。
//
// device_status / location_update 这类噪音从来不进这里（决策 #27）。
export const RISK_ALERT_TYPES = [
  "collision_risk",
  "obstacle_risk",
  "risk_cleared",
] as const;

/** 查询参数用的逗号串（API.md §6 type 支持多值） */
export const RISK_ALERT_TYPE_PARAM = RISK_ALERT_TYPES.join(",");
