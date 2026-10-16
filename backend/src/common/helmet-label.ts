import { cleanDisplayName } from './display-name';

/**
 * 给用户看的文字（推送等）里怎么称呼一顶头盔：用户起过名就用名字，没有才用设备编号。
 * 负责人 2026-10-15：有重命名一定先显示重命名，不然绑了几顶时分不清是哪一顶。App 端同一规则见 helmetNameOf。
 * 名字入库前已整理，这里再整理一遍是给整理规则上线前存下的旧名字（只含零宽字符 / 带换行）。
 */
export function helmetLabel(device: {
  name?: string | null;
  deviceId: string;
}): string {
  const name = device.name ? cleanDisplayName(device.name) : '';
  return name || device.deviceId;
}

const CLOCK = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * 推送正文里的时刻：北京时间 HH:mm（中国大陆市场优先）。原来直接写 toISOString()，
 * 用户看到的是「2026-10-15T09:48:24.506Z」这样的 UTC 原文（同 10-07 A 线对建单推送的反馈）。
 */
export function pushClock(at: Date | null | undefined): string {
  return at ? CLOCK.format(at) : '';
}
