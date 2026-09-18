/** 命令状态机配置：调用时读取（测试可用短超时跑全路径，与 SOS 同模式） */

const readPositiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** 无回执判定超时（口径 #27④：30s；真机联调若硬件有更准口径再调） */
export const ackTimeoutMs = (): number =>
  readPositiveInt(process.env.COMMAND_ACK_TIMEOUT_SECONDS, 30) * 1000;

export const commandScanIntervalMs = (): number =>
  readPositiveInt(process.env.COMMAND_SCAN_INTERVAL_MS, 5000);

export const COMMAND_STATUS = {
  pending: 'pending',
  delivered: 'delivered',
  success: 'success',
  failed: 'failed',
  offline: 'offline',
} as const;

/** 头盔实际设置上报（决策 #45）：单次最多键数（清单 14 项，留余量挡脏数据） */
export const REPORT_SETTINGS_MAX_KEYS = 32;

/**
 * 上报保护窗口：App 读回的值可能早于一条刚成功的命令（读在写之前、上报在回执之后到达），
 * 窗口内被命令碰过的键以命令为准；真有重启落在窗口里，下次重连再校正。
 */
export const REPORT_RECENT_COMMAND_MS = 30_000;
