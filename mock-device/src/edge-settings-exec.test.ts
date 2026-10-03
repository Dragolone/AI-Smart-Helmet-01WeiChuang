// set_config「头盔执行」的边界：params 的各种非对象形态、原型链键名、键顺序决定的首个错误、
// 回执码与 HELMET_ERROR_CODES 的对应。原则同真机：没执行就不能回 success。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEVICE_SETTINGS, DEVICE_SETTING_KEYS, HELMET_ERROR_CODES } from '@helmet/shared';
import { executeSetConfig } from './settings-exec.ts';

const errorCodeOf = (params: unknown): string | null => {
  const r = executeSetConfig(params);
  return r.result === 'failed' ? r.errorCode : null;
};

describe('settings-exec 边界', () => {
  it('params 不是普通对象（undefined / 数字 / 布尔 / 字符串 / 数组 / 函数）→ ERR_LENGTH', () => {
    for (const params of [undefined, 0, 1, true, '', '{"volume":50}', [], [['volume', 50]], () => ({ volume: 50 })]) {
      assert.equal(errorCodeOf(params), 'ERR_LENGTH', String(params));
    }
  });

  it('没有自有可枚举键的对象（Date / Map / 只有继承属性）→ EMPTY_PARAMS，继承来的键不执行', () => {
    assert.equal(errorCodeOf(new Date()), 'EMPTY_PARAMS');
    assert.equal(errorCodeOf(new Map([['volume', 50]])), 'EMPTY_PARAMS');
    assert.equal(errorCodeOf(Object.create({ volume: 50 })), 'EMPTY_PARAMS');
  });

  it('线上 JSON 里的 __proto__ / constructor / toString 是未知键，不是成功', () => {
    // JSON.parse 会把 "__proto__" 建成自有属性（对象字面量不会），真实命令走的是这条路
    assert.equal(errorCodeOf(JSON.parse('{"__proto__": {"volume": 50}}')), 'UNSUPPORTED_SETTING:__proto__');
    assert.equal(errorCodeOf({ constructor: 1 }), 'UNSUPPORTED_SETTING:constructor');
    assert.equal(errorCodeOf({ toString: true }), 'UNSUPPORTED_SETTING:toString');
  });

  it('JSON 能表达的坏值（null / 数字字符串 / 小数 / 嵌套对象）→ ERR_PARAM_VALUE:<key>', () => {
    assert.equal(errorCodeOf({ volume: null }), 'ERR_PARAM_VALUE:volume');
    assert.equal(errorCodeOf({ volume: '50' }), 'ERR_PARAM_VALUE:volume');
    assert.equal(errorCodeOf({ light: 1.5 }), 'ERR_PARAM_VALUE:light');
    assert.equal(errorCodeOf({ buzzer: null }), 'ERR_PARAM_VALUE:buzzer');
    assert.equal(errorCodeOf({ buzzer: 'true' }), 'ERR_PARAM_VALUE:buzzer');
    assert.equal(errorCodeOf({ radar: { enabled: true } }), 'ERR_PARAM_VALUE:radar');
  });

  it('多个键都不合法：按键的书写顺序报第一个，未知键与坏值谁在前报谁', () => {
    assert.equal(errorCodeOf({ beepVolume: 1, volume: 999 }), 'UNSUPPORTED_SETTING:beepVolume');
    assert.equal(errorCodeOf({ volume: 999, beepVolume: 1 }), 'ERR_PARAM_VALUE:volume');
    // 合法键排在前面不影响后面的键被检出
    assert.equal(errorCodeOf({ buzzer: true, light: 3, fallSensitivity: 0 }), 'ERR_PARAM_VALUE:fallSensitivity');
  });

  it('一次下发全部 14 项（出厂默认 / 各自上下界）→ success，且不带 errorCode 字段', () => {
    const defaults = Object.fromEntries(DEVICE_SETTING_KEYS.map((k) => [k, DEVICE_SETTINGS[k].default]));
    assert.deepEqual(executeSetConfig(defaults), { result: 'success' });
    for (const bound of ['min', 'max'] as const) {
      const params = Object.fromEntries(
        DEVICE_SETTING_KEYS.map((k) => {
          const spec = DEVICE_SETTINGS[k];
          return [k, spec.kind === 'int' ? spec[bound] : bound === 'max'];
        }),
      );
      assert.deepEqual(executeSetConfig(params), { result: 'success' }, bound);
    }
  });

  it('回执码口径（EVENTS.md §6）：冒号前要么是 v0.6 码表里的码，要么是两个自定义码之一；冒号后是原样键名', () => {
    const custom = ['UNSUPPORTED_SETTING', 'EMPTY_PARAMS'];
    const samples: Array<[unknown, string | null]> = [
      [null, null],
      [{}, null],
      [{ volume: 0 }, 'volume'],
      [{ 'a:b': 1 }, 'a:b'],
      [{ '': 1 }, ''],
    ];
    for (const [params, key] of samples) {
      const code = errorCodeOf(params);
      assert.ok(code, JSON.stringify(params));
      const [head, ...rest] = code.split(':');
      assert.ok((HELMET_ERROR_CODES as readonly string[]).includes(head) || custom.includes(head), code);
      assert.equal(rest.length > 0 ? rest.join(':') : null, key, code);
    }
  });
});
