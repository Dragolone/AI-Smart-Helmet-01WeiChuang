import { sleep } from './sleep';

/**
 * 固定间隔重试：fn 抛错就等 delayMs 再来，共最多 retries 次重试；全部失败抛最后一次的错。
 * 给 MQTT 消费这类「数据库瞬断一次就会把这条消息签收掉」的路径用（事件入库与 cmd_ack 同一套节奏）。
 */
export async function retrying<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  onRetry?: (err: unknown, attempt: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        onRetry?.(err, attempt + 1);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}
