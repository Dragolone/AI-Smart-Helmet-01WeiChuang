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

/** 设置参数护栏（清单与取值范围待硬件 ⚠️，先挡结构性脏数据）：扁平键值、标量、数量上限 */
export const SETTINGS_MAX_KEYS = 20;
export const SETTINGS_KEY_MAX_LENGTH = 64;
export const SETTINGS_STRING_MAX_LENGTH = 256;
