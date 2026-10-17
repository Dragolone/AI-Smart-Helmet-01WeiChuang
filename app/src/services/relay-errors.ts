// 中转 / 手动求救请求失败时，这个错误再试有没有用。补发队列（ble-relay-uplink）和页面上手动发求救都用它：
// 这类错误进了队列也会被丢掉，页面上不能对人说「已暂存，网络恢复后自动发送」。

/**
 * 客户端规范化错误（api/client.ts）带 HTTP 状态时：404 = 设备不属于当前账号、403 = 无权、400 = 结构性坏体，
 * 重试永远同一个结果（审计 BLE-05）。没有状态的（断网、超时）不算
 */
export const isUnrecoverableRelayError = (e: unknown): boolean => {
  const status = (e as { status?: unknown })?.status;
  return status === 404 || status === 403 || status === 400;
};
