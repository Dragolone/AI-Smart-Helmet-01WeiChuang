/**
 * 正整数环境变量：未设、非整数、≤ 0 一律回落默认值。
 * 调用时读取而非 import 时读取——测试能在 app 初始化前用环境变量把倒计时/扫描间隔调短。
 */
export const envPositiveInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Node 计时器的上限（2^31−1 ms，约 24.8 天）：超过时 Node 把它当成 1 ms */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * 交给 setTimeout / setInterval 的毫秒数：配错成超大值（如 SOS_SCAN_INTERVAL_MS=3e9、对账秒数 ×1000 溢出）时
 * Node 会改成 1 ms——扫描空转打满 CPU、每条短信「1 ms 超时」却其实发出、重发 5 次（10-17 评审）。封顶到上限
 */
export const timerMs = (ms: number): number => Math.min(ms, MAX_TIMER_MS);

/**
 * 后端 MQTT 服务账号的用户名与保留 clientId：消费者用它们连 EMQX，emqx-hook 用它们认出自己人，
 * 两边必须取到同一个值。同样在调用时读取。
 */
export const mqttBackendUsername = (): string =>
  process.env.MQTT_BACKEND_USERNAME ?? 'backend_ingest';
export const mqttBackendClientId = (): string =>
  process.env.MQTT_BACKEND_CLIENT_ID ?? 'backend_ingest';

/**
 * 开关类环境变量：1 / true / yes / on 为开，0 / false / no / off / 空为关（不分大小写）；其余值启动时报错。
 * 原来只认一个精确写法（`=== '1'`、`=== 'true'`），写成 `true` / `1` / `TRUE` 时开关静默不生效——
 * REQUIRE_REAL_PROVIDERS 失效会让生产回落 Mock 短信，JPUSH_APNS_PRODUCTION 失效会让正式包收不到推送（2026-10-17 评审）
 */
export const envFlag = (name: string): boolean => {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['', '0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(
    `${name}=${JSON.stringify(process.env[name])} 不是开关值（1 / true / yes / on 或 0 / false / no / off）`,
  );
};
