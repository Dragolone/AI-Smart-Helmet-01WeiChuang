// 「要不要更换当前头盔」的判断（纯函数，2026-10-07 负责人提的需求）：
// 当前头盔停着、另一台在线的头盔在动时，问一次要不要把当前头盔换成那一台——
// 免得用户忘了换，App 内的求救记到没在用的那顶名下。
// 只看服务端推来的定位点里的速度；不连接、不断开、也不自动更换任何头盔。

/** 当前头盔多久没有在动，才算「停着」 */
export const STILL_MS = 2 * 60_000;
/** 另一台要连续动多久，才算「在动」（路口起步、挪一下车不算） */
export const MOVING_MS = 30_000;
/** 「在动」的那台最近一次在动的上报不能太旧：运动时 5 秒一报，超过这个数没有新的就不算还在动 */
export const FRESH_MS = 20_000;
/** 速度超过这个数算在动（m/s，与设备固件运动态口径一致，BLE 协议 v0.6 §4.0） */
export const MOVING_MPS = 1;

/** 一顶头盔的运动记录。时间都是手机收到上报的时刻（不用头盔时钟） */
export type Motion = {
  /** 这一段连续运动从什么时候开始；null = 最近一次上报是静止 */
  movingSince: number | null;
  /** 最近一次在动的上报；null = 开始观察以来没见它动过 */
  lastMovingAt: number | null;
};

/** 收到一个定位点后更新这顶头盔的运动记录 */
export function nextMotion(
  prev: Motion | undefined,
  speedMps: number,
  now: number,
): Motion {
  if (speedMps > MOVING_MPS)
    return { movingSince: prev?.movingSince ?? now, lastMovingAt: now };
  return { movingSince: null, lastMovingAt: prev?.lastMovingAt ?? null };
}

/**
 * 该问的话，返回建议换成的那顶头盔的 deviceId；否则 null。
 * @param onlineIds 此刻在线的头盔（含当前头盔），按设备列表的先后
 * @param watchingSince 从什么时候开始观察当前头盔：没见它动过时，要观察满 STILL_MS 才算停着
 */
export function switchCandidateOf(input: {
  currentId: string;
  onlineIds: readonly string[];
  motions: Readonly<Record<string, Motion | undefined>>;
  watchingSince: number;
  now: number;
}): string | null {
  const { currentId, onlineIds, motions, watchingSince, now } = input;
  if (!onlineIds.includes(currentId)) return null;
  const current = motions[currentId];
  const idleSince = current?.lastMovingAt ?? watchingSince;
  if (current?.movingSince != null || now - idleSince < STILL_MS) return null;
  return (
    onlineIds.find((id) => {
      if (id === currentId) return false;
      const m = motions[id];
      return (
        m != null &&
        m.movingSince !== null &&
        m.lastMovingAt !== null &&
        now - m.movingSince >= MOVING_MS &&
        now - m.lastMovingAt <= FRESH_MS
      );
    }) ?? null
  );
}
