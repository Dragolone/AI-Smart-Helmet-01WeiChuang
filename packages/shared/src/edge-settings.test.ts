// node:test + Node 24 原生类型剥离：零依赖跑 TS 单测（npm test -w @helmet/shared）。
// 本包不能声明 "type": "module"（dist 必须是 CJS），Node 靠语法探测把 .ts 当 ESM 并告警，test 脚本里已静音该告警。
// checkDeviceSetting 是后端入口 / Mock 回执 / App 设置页共用的唯一校验，常规拒绝路径已由
// backend settings-validation.spec 覆盖；这里只钉它们碰不到的边界：原型链键名、特殊数值、包装对象、逐键上下界。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEVICE_SETTINGS,
  DEVICE_SETTING_KEYS,
  HELMET_ERROR_CODES,
  checkDeviceSetting,
  isDeviceSettingKey,
  type DeviceSettingSpec,
} from './settings.ts';

const specOf = (key: string): DeviceSettingSpec =>
  (DEVICE_SETTINGS as Record<string, DeviceSettingSpec>)[key];
const INT_KEYS = DEVICE_SETTING_KEYS.filter((k) => specOf(k).kind === 'int');
const BOOL_KEYS = DEVICE_SETTING_KEYS.filter((k) => specOf(k).kind === 'bool');

const reasonOf = (key: string, value: unknown): string => {
  const r = checkDeviceSetting(key, value);
  return r.ok ? 'ok' : r.reason;
};

describe('checkDeviceSetting：键名边界', () => {
  it('原型链上的名字不算设置项（__proto__ / constructor / toString / hasOwnProperty）', () => {
    // 用 `key in DEVICE_SETTINGS` 判断的实现会把这些当成合法键，再拿 undefined 的 spec 崩掉
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(isDeviceSettingKey(key), false, key);
      assert.equal(reasonOf(key, 1), 'unknown_key', key);
    }
  });

  it('键名严格匹配：大小写、首尾空格、空串、snake_case 写法都是未知键', () => {
    for (const key of ['Volume', 'VOLUME', ' volume', 'volume ', '', 'radar_distance', 'fall-detect']) {
      assert.equal(reasonOf(key, 50), 'unknown_key', JSON.stringify(key));
    }
  });

  it('未知键的提示列出全部可用键，且只判键不看值（值合法也拒）', () => {
    const r = checkDeviceSetting('beepVolume', 80);
    assert.equal(r.ok, false);
    if (r.ok) return;
    for (const key of DEVICE_SETTING_KEYS) assert.ok(r.message.includes(key), key);
  });
});

describe('checkDeviceSetting：int 项的数值边界', () => {
  it('NaN / ±Infinity 是 number 但不是整数 → type（不是 range）', () => {
    for (const key of INT_KEYS) {
      for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.equal(reasonOf(key, v), 'type', `${key}=${v}`);
      }
    }
  });

  it('小数一律 type：贴着上下界的 0.5 / 极小偏差也不放行', () => {
    assert.equal(reasonOf('volume', 99.5), 'type');
    assert.equal(reasonOf('volume', 0.5), 'type');
    assert.equal(reasonOf('light', 3.0000001), 'type');
    assert.equal(reasonOf('radarDistance', 5 + Number.EPSILON * 4), 'type');
  });

  it('数值上等于整数的写法放行：80.0 / 8e1', () => {
    assert.deepEqual(checkDeviceSetting('volume', 80.0), { ok: true, key: 'volume', value: 80 });
    assert.deepEqual(checkDeviceSetting('volume', 8e1), { ok: true, key: 'volume', value: 80 });
  });

  it('-0 按 0 处理：下界为 0 的项放行、下界为 1 的项越界；序列化后就是 0', () => {
    // JSON.parse('-0') 得到 -0，线上确实可能出现
    const light = checkDeviceSetting('light', JSON.parse('-0'));
    assert.equal(light.ok, true);
    assert.equal(JSON.stringify(light.ok ? light.value : null), '0');
    assert.equal(reasonOf('vibration', -0), 'ok');
    assert.equal(reasonOf('volume', -0), 'range');
  });

  it('超大整数 / 负数是 range 而不是 type（类型对、值不对）', () => {
    assert.equal(reasonOf('volume', Number.MAX_SAFE_INTEGER), 'range');
    assert.equal(reasonOf('volume', 2 ** 53), 'range');
    assert.equal(reasonOf('volume', 1e21), 'range');
    assert.equal(reasonOf('light', -1), 'range');
    assert.equal(reasonOf('heartbeatPeriod', 256), 'range');
  });

  it('不是原始 number 的一律 type：数字字符串、布尔、null/undefined、数组、对象、包装对象、BigInt', () => {
    const bad: unknown[] = ['80', '', ' ', '0x50', true, false, null, undefined, [80], [], {}, { value: 80 }, new Number(80), 80n];
    for (const v of bad) {
      assert.equal(reasonOf('volume', v), 'type', `volume=${typeof v === 'bigint' ? '80n' : JSON.stringify(v)}`);
    }
  });

  it('每个 int 项：min / max 放行，min-1 / max+1 越界，提示带区间与单位', () => {
    for (const key of INT_KEYS) {
      const { min, max, unit } = specOf(key);
      assert.ok(min !== undefined && max !== undefined, `${key} 必须声明上下界`);
      assert.deepEqual(checkDeviceSetting(key, min), { ok: true, key, value: min });
      assert.deepEqual(checkDeviceSetting(key, max), { ok: true, key, value: max });
      for (const v of [min - 1, max + 1]) {
        const r = checkDeviceSetting(key, v);
        assert.equal(r.ok, false, `${key}=${v}`);
        if (r.ok) continue;
        assert.equal(r.reason, 'range', `${key}=${v}`);
        assert.ok(r.message.includes(`${min}–${max}${unit ?? ''}`), r.message);
      }
    }
  });
});

describe('checkDeviceSetting：bool 项的类型边界', () => {
  it('只收原始 boolean：0/1、"true"/"false"、null、包装对象都拒（不做真值转换）', () => {
    const bad: unknown[] = [0, 1, 'true', 'false', 'on', '', null, undefined, [], {}, new Boolean(true), Number.NaN];
    for (const key of BOOL_KEYS) {
      for (const v of bad) {
        assert.equal(reasonOf(key, v), 'type', `${key}=${JSON.stringify(v)}`);
      }
      assert.deepEqual(checkDeviceSetting(key, true), { ok: true, key, value: true });
      assert.deepEqual(checkDeviceSetting(key, false), { ok: true, key, value: false });
    }
  });
});

describe('DEVICE_SETTINGS 清单自洽（v0.6 内存控制表 0x20–0x2D）', () => {
  it('14 项，按内存表地址 0x20…0x2D 连续排列（App 一次 READ 0x20 长度 0x0E 读回，Admin 按此顺序展示）', () => {
    const addrs = DEVICE_SETTING_KEYS.map((k) => {
      const m = /0x([0-9A-F]{2})/.exec(specOf(k).description);
      assert.ok(m, `${k} 的说明里要带寄存器地址`);
      return Number.parseInt(m[1], 16);
    });
    assert.deepEqual(addrs, Array.from({ length: 14 }, (_, i) => 0x20 + i));
  });

  it('int 项：上下界与默认值都是 uint8 范围内的整数、min ≤ default ≤ max；bool 项：默认值是 boolean 且不带 min/max/unit', () => {
    for (const key of INT_KEYS) {
      const { min, max, default: def } = specOf(key);
      for (const n of [min, max, def]) {
        assert.ok(typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255, `${key}: ${String(n)}`);
      }
      assert.ok((min as number) <= (def as number) && (def as number) <= (max as number), key);
    }
    for (const key of BOOL_KEYS) {
      const spec = specOf(key);
      assert.equal(typeof spec.default, 'boolean', key);
      assert.equal(spec.min, undefined, key);
      assert.equal(spec.max, undefined, key);
      assert.equal(spec.unit, undefined, key);
    }
    assert.equal(INT_KEYS.length + BOOL_KEYS.length, DEVICE_SETTING_KEYS.length);
  });

  it('键名是不含分隔符的 camelCase：回执 errorCode 用 `<码>:<key>` 拼接，键里不能有冒号', () => {
    for (const key of DEVICE_SETTING_KEYS) assert.match(key, /^[a-z][A-Za-z]*$/);
  });
});

describe('HELMET_ERROR_CODES（BLE 协议 v0.6 §3.0）', () => {
  it('7 个码互不重复、全大写 ERR_ 前缀、不含冒号（冒号留给 `:<key>` 后缀）', () => {
    assert.equal(HELMET_ERROR_CODES.length, 7);
    assert.equal(new Set(HELMET_ERROR_CODES).size, HELMET_ERROR_CODES.length);
    for (const code of HELMET_ERROR_CODES) assert.match(code, /^ERR_[A-Z_]+$/);
  });
});
