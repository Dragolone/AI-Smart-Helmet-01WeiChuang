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

const BEIJING_CLOCK = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 按时区缓存的格式器：IANA 时区就几百个，上限有数 */
const localClocks = new Map<string, Intl.DateTimeFormat>();

function localClock(at: Date, timeZone: string): string | null {
  try {
    let format = localClocks.get(timeZone);
    if (!format) {
      format = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      localClocks.set(timeZone, format);
    }
    return format.format(at);
  } catch {
    // 存进来时校验过（common/time-zone）；运行环境的时区库不认时退回北京时间
    return null;
  }
}

/**
 * 推送正文里「已于 HH:mm 」这一段（O13，负责人 10-21）：按用户手机上报的时区写当地时间；没报上来时按北京时间、
 * 并写明「北京时间」——海外用户看到不加说明的北京时间会和自己的表对不上。原来一律北京时间、不标注（负责人 10-15；
 * 更早是 toISOString 的 UTC 原文，10-07 A 线反馈）。没有时刻返回空串。
 */
export function pushAtPhrase(
  at: Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!at) return '';
  const local = timeZone ? localClock(at, timeZone) : null;
  return local ? `已于 ${local} ` : `已于北京时间 ${BEIJING_CLOCK.format(at)} `;
}
