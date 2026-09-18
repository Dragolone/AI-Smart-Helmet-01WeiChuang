// PUT settings 入口校验（API.md §8，决策 #43）：清单以 @helmet/shared DEVICE_SETTINGS 为准。
// 这里钉住三类拒绝（未知键 / 类型不符 / 越界）与边界值放行，e2e 只覆盖 HTTP 层一两条。
import { BadRequestException } from '@nestjs/common';
import { DEVICE_SETTINGS, DEVICE_SETTING_KEYS } from '@helmet/shared';
import { validateSettingsParams } from './commands.service';

const reject = (params: unknown): string => {
  try {
    validateSettingsParams(params);
  } catch (err) {
    if (err instanceof BadRequestException) {
      const body = err.getResponse() as { code: string; message: string };
      expect(body.code).toBe('VALIDATION_FAILED');
      return body.message;
    }
    throw err;
  }
  throw new Error('应当被拒绝');
};

describe('validateSettingsParams', () => {
  it('结构：非对象 / 数组 / 空对象一律拒绝', () => {
    expect(reject(null)).toContain('必须是对象');
    expect(reject([{ volume: 1 }])).toContain('必须是对象');
    expect(reject({})).toContain('不能为空');
  });

  it('未知键拒绝，并在消息里列出可用键', () => {
    const msg = reject({ beepVolume: 80 });
    expect(msg).toContain('未知设置项：beepVolume');
    expect(msg).toContain('volume');
  });

  it('bool 键只收 boolean；int 键只收整数（字符串 "80" / 小数 / 1 代替 true 都拒）', () => {
    expect(reject({ buzzer: 1 })).toContain('需要布尔值');
    expect(reject({ buzzer: 'on' })).toContain('需要布尔值');
    expect(reject({ volume: '80' })).toContain('需要整数');
    expect(reject({ volume: 80.5 })).toContain('需要整数');
    expect(reject({ volume: true })).toContain('需要整数');
  });

  it('越界拒绝并给出区间；边界值放行', () => {
    expect(reject({ volume: 0 })).toContain('1–100%');
    expect(reject({ volume: 101 })).toContain('1–100%');
    expect(reject({ radarDistance: 4 })).toContain('5–30m');
    expect(reject({ light: 4 })).toContain('0–3');
    expect(validateSettingsParams({ volume: 1 })).toEqual({ volume: 1 });
    expect(validateSettingsParams({ volume: 100 })).toEqual({ volume: 100 });
    expect(validateSettingsParams({ light: 0, radarDistance: 30 })).toEqual({
      light: 0,
      radarDistance: 30,
    });
  });

  it('一次下发含多个键：任一键不合法整条拒绝，不做部分下发', () => {
    expect(reject({ volume: 50, light: 9 })).toContain('light');
  });

  it('清单里每个键用出厂默认值都能过（清单与默认值自洽）', () => {
    const all = Object.fromEntries(
      DEVICE_SETTING_KEYS.map((k) => [k, DEVICE_SETTINGS[k].default]),
    );
    expect(validateSettingsParams(all)).toEqual(all);
    expect(Object.keys(all)).toHaveLength(14);
  });
});
