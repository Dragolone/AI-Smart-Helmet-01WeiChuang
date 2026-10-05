/**
 * 正整数环境变量：未设、非整数、≤ 0 一律回落默认值。
 * 调用时读取而非 import 时读取——测试能在 app 初始化前用环境变量把倒计时/扫描间隔调短。
 */
export const envPositiveInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * 后端 MQTT 服务账号的用户名与保留 clientId：消费者用它们连 EMQX，emqx-hook 用它们认出自己人，
 * 两边必须取到同一个值。同样在调用时读取。
 */
export const mqttBackendUsername = (): string =>
  process.env.MQTT_BACKEND_USERNAME ?? 'backend_ingest';
export const mqttBackendClientId = (): string =>
  process.env.MQTT_BACKEND_CLIENT_ID ?? 'backend_ingest';
