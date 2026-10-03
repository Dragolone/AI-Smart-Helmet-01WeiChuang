// set_config 的「头盔执行」软件版：按 @helmet/shared 的 DEVICE_SETTINGS 逐键校验，
// 越界 / 类型不符回 ERR_PARAM_VALUE:<key>（手册 §3.0），未知键回 UNSUPPORTED_SETTING:<key>（与 App 中转侧同名）。
// 服务端入口已经拦过一遍，这里是模拟真机自身的最后一道校验——两条链路（MQTT / relay）共用。
import { checkDeviceSetting } from '@helmet/shared';

export type SetConfigOutcome =
  | { result: 'success' }
  | { result: 'failed'; errorCode: string };

export function executeSetConfig(params: unknown): SetConfigOutcome {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { result: 'failed', errorCode: 'ERR_LENGTH' };
  }
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length === 0) return { result: 'failed', errorCode: 'EMPTY_PARAMS' };
  for (const [key, value] of entries) {
    const r = checkDeviceSetting(key, value);
    if (r.ok) continue;
    return {
      result: 'failed',
      errorCode: `${r.reason === 'unknown_key' ? 'UNSUPPORTED_SETTING' : 'ERR_PARAM_VALUE'}:${key}`,
    };
  }
  return { result: 'success' };
}

/**
 * 命令的「头盔执行」：目前只有 set_config。其余类型头盔不认识，按手册回 ERR_INSTRUCTION——
 * 没执行过的命令不能回执成功（设置下发铁律），哪怕后端现在只会下发 set_config。
 */
export function executeCommand(type: string, params: unknown): SetConfigOutcome {
  return type === 'set_config'
    ? executeSetConfig(params)
    : { result: 'failed', errorCode: 'ERR_INSTRUCTION' };
}
