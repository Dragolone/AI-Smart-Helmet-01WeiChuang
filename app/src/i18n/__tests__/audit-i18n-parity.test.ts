// 审计 2026-09-13 §8：三语字典一致性——每个 messages/*.ts 的 zh-CN / zh-TW / en key 集合必须一致，
// 且无空串（缺译会静默回落简体，用户看到中英混排而不报错，因此必须在测试里钉死）。
import { describe, expect, it } from '@jest/globals';
import { accident } from '../messages/accident';
import { auth } from '../messages/auth';
import { common } from '../messages/common';
import { device } from '../messages/device';
import { devices } from '../messages/devices';
import { errors } from '../messages/errors';
import { events } from '../messages/events';
import { help } from '../messages/help';
import { intercom } from '../messages/intercom';
import { legal } from '../messages/legal';
import { map } from '../messages/map';
import { profile } from '../messages/profile';
import { safety } from '../messages/safety';

type Dict = Record<string, Record<string, string>>;
const FILES: Record<string, Dict> = {
  accident: accident as unknown as Dict,
  auth: auth as unknown as Dict,
  common: common as unknown as Dict,
  device: device as unknown as Dict,
  devices: devices as unknown as Dict,
  errors: errors as unknown as Dict,
  events: events as unknown as Dict,
  help: help as unknown as Dict,
  intercom: intercom as unknown as Dict,
  legal: legal as unknown as Dict,
  map: map as unknown as Dict,
  profile: profile as unknown as Dict,
  safety: safety as unknown as Dict,
};
const LOCALES = ['zh-CN', 'zh-TW', 'en'];

describe('i18n 三语一致性', () => {
  it.each(Object.keys(FILES))('%s：三语 key 集合一致', (name) => {
    const d = FILES[name];
    const base = Object.keys(d['zh-CN']).sort();
    for (const loc of LOCALES.slice(1)) {
      const keys = Object.keys(d[loc] ?? {}).sort();
      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));
      expect({ file: name, locale: loc, missing, extra }).toEqual({
        file: name,
        locale: loc,
        missing: [],
        extra: [],
      });
    }
  });

  it.each(Object.keys(FILES))('%s：无空串/纯空白文案', (name) => {
    const d = FILES[name];
    const blanks: string[] = [];
    for (const loc of LOCALES) {
      for (const [k, v] of Object.entries(d[loc] ?? {})) {
        if (typeof v !== 'string' || v.trim() === '') blanks.push(`${loc}.${k}`);
      }
    }
    expect(blanks).toEqual([]);
  });

  it.each(Object.keys(FILES))('%s：插值占位符三语一致（{n} 之类不得漏译）', (name) => {
    const d = FILES[name];
    const ph = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');
    const mismatch: string[] = [];
    for (const [k, zh] of Object.entries(d['zh-CN'])) {
      for (const loc of LOCALES.slice(1)) {
        const v = d[loc]?.[k];
        if (v !== undefined && ph(v) !== ph(zh)) {
          mismatch.push(`${name}.${k} ${loc}: [${ph(v)}] vs zh-CN [${ph(zh)}]`);
        }
      }
    }
    expect(mismatch).toEqual([]);
  });
});
