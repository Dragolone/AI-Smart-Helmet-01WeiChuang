/** 日志用：未知类型的异常取可读文本 */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** 日志用：需要定位到代码行的异常（保命链路的失败）取堆栈 */
export const errorStack = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);
