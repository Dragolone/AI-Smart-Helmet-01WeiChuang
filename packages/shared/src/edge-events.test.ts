// 事件类型表是四端共用的运行时值（后端白名单 / Admin 筛选项 / App 与 Mock 的中转过滤）。
// 类型层面 `satisfies` 只保证「是子集」，这里钉住数量、去重与保命链路不被误删。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BLE_RELAY_EVENT_TYPES, CURRENT_SCHEMA_VERSION, EVENT_TYPES } from './events.ts';

describe('EVENT_TYPES（EVENTS.md §3）', () => {
  it('MVP 共 11 种、互不重复、全部 snake_case', () => {
    assert.equal(EVENT_TYPES.length, 11);
    assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
    for (const t of EVENT_TYPES) assert.match(t, /^[a-z]+(_[a-z]+)*$/);
  });

  it('不含下划线开头的保留名：`_invalid` 是服务端留档用的内部类型，设备不能上报', () => {
    assert.ok(!(EVENT_TYPES as readonly string[]).some((t) => t.startsWith('_')));
  });
});

describe('BLE_RELAY_EVENT_TYPES（DEVICE_PROTOCOL §1.1，决策 #31）', () => {
  it('恰好 7 种、互不重复、全部在总表内', () => {
    assert.equal(BLE_RELAY_EVENT_TYPES.length, 7);
    assert.equal(new Set(BLE_RELAY_EVENT_TYPES).size, 7);
    for (const t of BLE_RELAY_EVENT_TYPES) assert.ok((EVENT_TYPES as readonly string[]).includes(t), t);
  });

  it('保命链路（摔倒 / 手动 SOS）与其依赖的位置、心跳必须在中转范围内', () => {
    for (const t of ['possible_fall', 'manual_sos', 'location_update', 'device_status']) {
      assert.ok((BLE_RELAY_EVENT_TYPES as readonly string[]).includes(t), t);
    }
  });

  it('范围外恰好是下一版本的 4 种：video_ready、sleep 两种、bluetooth_lost', () => {
    const relay = new Set<string>(BLE_RELAY_EVENT_TYPES);
    assert.deepEqual(
      EVENT_TYPES.filter((t) => !relay.has(t)).sort(),
      ['bluetooth_lost', 'sleep_entered', 'sleep_exited', 'video_ready'],
    );
  });
});

describe('CURRENT_SCHEMA_VERSION（EVENTS.md §1）', () => {
  it('当前固定为 1，且落在 int4 值域内（越界的版本号会被 Ingest 判校验失败）', () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 1);
    assert.ok(Number.isInteger(CURRENT_SCHEMA_VERSION) && CURRENT_SCHEMA_VERSION >= 0 && CURRENT_SCHEMA_VERSION <= 2147483647);
  });
});
