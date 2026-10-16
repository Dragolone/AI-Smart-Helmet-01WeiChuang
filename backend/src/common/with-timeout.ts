import { timerMs } from './env';

/** 超时错误：调用方按失败处理（记日志 / 删记录 / 重试），message 带毫秒数便于排查 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timeout after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * 给第三方调用加应用层超时：SDK 自带的超时往往过长（腾讯云默认 60s），挂起的 Promise 会把
 * HTTP 请求或扫描任务一起拖住（审计 AUTH-11 / SOS-05）。超时只让调用方放弃等待、不能取消底层请求，
 * 调用方必须容忍「超时后其实成功了」（验证码：删记录让用户重发；SOS：按失败重试）。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), timerMs(ms));
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
