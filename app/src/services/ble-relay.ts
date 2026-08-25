// BLE 下行命令中转（决策 #36,API.md §8/§11）:WS device_command → 写头盔 → relay-ack。
// BLE GATT 协议是硬件前置(DEVICE_PROTOCOL §10 联调清单),就绪前 writeToHelmet 为占位:
// __DEV__ 视为写入成功并模拟头盔执行(B 线交接口径,便于无硬件联调设置下发全链路);
// 生产构建在协议就绪前只记日志、不回执——设置页如实显示 offline,不假装成功。
import type { WsDeviceCommandData } from '@helmet/shared';

import { relayApi } from '@/api/relay';

/** 连接建立时服务端会补推 pending/delivered 存量(API.md §11)——按 commandId 去重,
 *  重复收到不重复执行。仅内存去重:回执幂等,App 重启后重复提交无害。 */
const handled = new Set<string>();

async function writeToHelmet(cmd: WsDeviceCommandData): Promise<boolean> {
  // TODO(硬件 BLE 协议): 经 GATT 将命令写入头盔,回执由头盔经 BLE 返回后提交 executed
  console.log(
    `[BLE-RELAY] device_command ${cmd.commandId} (${cmd.type}) → ${cmd.deviceId}`,
    cmd.params,
  );
  return __DEV__;
}

/** 处理一条 WS device_command;返回 true 表示已完成回执(调用方可刷新设置页缓存) */
export async function handleDeviceCommand(
  cmd: WsDeviceCommandData,
): Promise<boolean> {
  if (handled.has(cmd.commandId)) return false;
  handled.add(cmd.commandId);
  try {
    const written = await writeToHelmet(cmd);
    if (!written) return false;
    await relayApi.ack(cmd.deviceId, cmd.commandId, { stage: 'delivered' });
    // __DEV__ 模拟头盔执行成功;真机时这一步改为等 BLE 回执再提交
    await relayApi.ack(cmd.deviceId, cmd.commandId, {
      stage: 'executed',
      result: 'success',
    });
    return true;
  } catch (e) {
    // 回执失败(网络/401 等):移出去重集,等服务端补推或重连时重试
    handled.delete(cmd.commandId);
    console.warn('[BLE-RELAY] 回执失败,等待补推重试', e);
    return false;
  }
}
