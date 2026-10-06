// BLE 下行命令中转（决策 #36,API.md §8/§11）:WS device_command → 写头盔寄存器 → relay-ack。
// 键→寄存器映射在 services/ble/protocol.ts（App 侧是唯一权威，后端不做键白名单）。
// 回执口径（CLAUDE.md「设置下发」）：头盔未连接 → 不回执，服务端 30s 超时判 offline；
// 写入应答错误码非 0 → executed failed + errorCode；只有头盔应答 STATUS_OK 才回 success。
// 模拟器（无 CoreBluetooth）且 __DEV__ 时保留"视为执行成功"的模拟，便于无硬件验证设置页状态流转。
import type { WsDeviceCommandData } from '@helmet/shared';

import { relayApi } from '@/api/relay';
import { settingToRegisterWrite } from '@/services/ble/protocol';
import { isHelmetConnected, writeHelmetRegister } from '@/services/ble-link';
import { devLog } from '@/services/dev-log';
import { useBleStore } from '@/stores/ble-store';

/** 连接建立时服务端会补推 pending/delivered 存量(API.md §11)——按 commandId 去重,
 *  重复收到不重复执行。仅内存去重:回执幂等,App 重启后重复提交无害。 */
const handled = new Set<string>();

type WriteOutcome =
  | { delivered: false }
  | { delivered: true; result: 'success' }
  | { delivered: true; result: 'failed'; errorCode: string };

async function writeToHelmet(cmd: WsDeviceCommandData): Promise<WriteOutcome> {
  const entries = Object.entries(cmd.params ?? {});
  if (entries.length === 0) return { delivered: true, result: 'failed', errorCode: 'EMPTY_PARAMS' };

  const simulate = __DEV__ && useBleStore.getState().adapter === 'unsupported';
  if (!isHelmetConnected(cmd.deviceId)) {
    if (simulate) {
      console.log(`[BLE-RELAY] 模拟器无蓝牙：模拟执行 ${cmd.commandId}`, cmd.params);
      return { delivered: true, result: 'success' };
    }
    return { delivered: false };
  }

  // 逐键单独写（手册例 4 连写 0x26 是笔误；音量 0x24 与大灯 0x26 不相邻）
  for (const [key, value] of entries) {
    const reg = settingToRegisterWrite(key, value);
    if (!reg) return { delivered: true, result: 'failed', errorCode: `UNSUPPORTED_SETTING:${key}` };
    const r = await writeHelmetRegister(cmd.deviceId, reg.addr, reg.data);
    if (!r.delivered) return { delivered: false };
    if (!r.executed) return { delivered: true, result: 'failed', errorCode: `${r.errorCode}:${key}` };
  }
  return { delivered: true, result: 'success' };
}

/** 处理一条 WS device_command;返回 true 表示已完成回执(调用方可刷新设置页缓存) */
export async function handleDeviceCommand(cmd: WsDeviceCommandData): Promise<boolean> {
  if (handled.has(cmd.commandId)) return false;
  handled.add(cmd.commandId);
  try {
    const outcome = await writeToHelmet(cmd);
    if (!outcome.delivered) {
      // 头盔不在身边：留给服务端补推/超时；下次连上若服务端再推会重新处理
      handled.delete(cmd.commandId);
      devLog("BLE-RELAY", `${cmd.commandId} 未送达（头盔未连接）`);
      return false;
    }
    await relayApi.ack(cmd.deviceId, cmd.commandId, { stage: 'delivered' });
    await relayApi.ack(
      cmd.deviceId,
      cmd.commandId,
      outcome.result === 'success'
        ? { stage: 'executed', result: 'success' }
        : { stage: 'executed', result: 'failed', errorCode: outcome.errorCode },
    );
    return true;
  } catch (e) {
    // 回执失败(网络/401 等):移出去重集,等服务端补推或重连时重试
    handled.delete(cmd.commandId);
    devLog("BLE-RELAY", "回执失败,等待补推重试", e as Error);
    return false;
  }
}
