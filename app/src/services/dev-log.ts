// 开发期旁路日志：真机 Metro 日志通道不稳时，把关键日志同时 POST 到本机 HTTP 接收器
// （`EXPO_PUBLIC_BLE_LOG_URL`，DEVELOPMENT.md 仿真器一节）。未设该变量时整段为空操作。
// 只看环境变量不看 __DEV__：Release 构建测后台链路时也要能看到日志；正式环境的 .env 不设该变量即为空操作
const SINK = process.env.EXPO_PUBLIC_BLE_LOG_URL || undefined;

export function devLog(tag: string, ...args: unknown[]): void {
  console.log(`[${tag}]`, ...args);
  if (!SINK) return;
  const line = args
    .map((a) =>
      typeof a === "string"
        ? a
        : a instanceof Error
          ? (a.stack ?? a.message)
          : JSON.stringify(a),
    )
    .join(" ");
  fetch(SINK, { method: "POST", body: `[${tag}] ${line}` }).catch(
    () => undefined,
  );
}

/** 未捕获 JS 异常也旁路上报（红屏时 Metro 通道往往已断） */
export function installDevErrorTap(): void {
  if (!SINK) return;
  const prev = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    devLog("UNCAUGHT", isFatal ? "fatal" : "non-fatal", error as Error);
    prev?.(error, isFatal);
  });
}
