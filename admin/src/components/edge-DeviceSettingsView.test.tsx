import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEVICE_SETTINGS, DEVICE_SETTING_KEYS } from '@helmet/shared'
import DeviceSettingsView from './DeviceSettingsView'
import { summarizeSettings } from './settings-summary'

// settings 来自库里的 JSON 列：清单定稿（决策 #43）前写入的旧数据、头盔上报的异常值都可能出现，
// 展示层的底线是「照实列出、不白屏」
describe('DeviceSettingsView：边界', () => {
  it('undefined / null / 空对象都当「全部为出厂默认」', () => {
    for (const settings of [undefined, null, {}]) {
      expect(summarizeSettings(settings)).toEqual({ changed: [], unknown: [], defaultCount: 14 })
    }
  })

  it('14 项全部改过 → 不再出现「其余 N 项为出厂默认」', () => {
    const all = Object.fromEntries(
      DEVICE_SETTING_KEYS.map((k) => {
        const spec = DEVICE_SETTINGS[k]
        return [k, spec.kind === 'bool' ? !spec.default : spec.default === spec.max ? spec.min : spec.max]
      }),
    )
    const s = summarizeSettings(all)
    expect(s.changed.map((c) => c.key)).toEqual(DEVICE_SETTING_KEYS)
    expect(s.defaultCount).toBe(0)
    render(<DeviceSettingsView settings={all} />)
    expect(screen.queryByText(/其余/)).not.toBeInTheDocument()
    expect(screen.queryByText('全部为出厂默认')).not.toBeInTheDocument()
  })

  it('悬停「格式异常」那一条：说明无法逐项比对，不是「不在设置清单内（旧数据）」', async () => {
    render(<DeviceSettingsView settings={42 as unknown as Record<string, unknown>} />)
    fireEvent.mouseEnter(screen.getByText('设置数据格式异常：42'))
    expect(await screen.findByText('设置不是一组键值，无法逐项比对')).toBeInTheDocument()
    expect(screen.queryByText('不在设置清单内（旧数据）')).not.toBeInTheDocument()
  })

  it('只有清单外的键 → 原样列出，并说明其余 14 项为默认（不能显示成「全部为出厂默认」）', () => {
    render(<DeviceSettingsView settings={{ beepVolume: 70 }} />)
    expect(screen.getByText('beepVolume = 70')).toBeInTheDocument()
    expect(screen.getByText('其余 14 项为出厂默认')).toBeInTheDocument()
    expect(screen.queryByText('全部为出厂默认')).not.toBeInTheDocument()
  })

  it('单位：秒带空格（30 s）、百分号紧贴（1%）、无单位的档位超出已知范围时显示原始数字', () => {
    const s = summarizeSettings({ heartbeatPeriod: 30, volume: 1, light: 9, fallSensitivity: 0 })
    expect(s.changed.map((c) => [c.text, c.defaultText])).toEqual([
      ['心跳周期 30 s', '出厂 60 s'],
      ['蜂鸣音量 1%', '出厂 80%'],
      ['大灯 9', '出厂 关'],
      ['跌倒灵敏度 0', '出厂 标准'],
    ])
  })

  it('布尔项：改成与默认相反才列出，悬停文案是另一个取值', () => {
    const s = summarizeSettings({ disconnectBeep: true, sosButton: false, buzzer: true, radar: true })
    expect(s.changed.map((c) => [c.text, c.defaultText])).toEqual([
      ['SOS 按键 关', '出厂 开'],
      ['断连蜂鸣 开', '出厂 关'],
    ])
    expect(s.defaultCount).toBe(12)
  })

  it('旧数据类型不符（布尔项存了 1、数值项存了字符串或 null）→ 当作改动照实显示，不抛异常', () => {
    const s = summarizeSettings({ buzzer: 1, volume: '80', radarDistance: null })
    expect(s.changed.map((c) => c.key)).toEqual(['buzzer', 'volume', 'radarDistance'])
    expect(s.changed[0].text).toBe('蜂鸣提醒 1')
    // 字符串 "80" 与默认值 80 不严格相等：算改动，提醒运维这条数据类型不对
    expect(s.changed[1].text).toBe('蜂鸣音量 80%')
    expect(() => render(<DeviceSettingsView settings={{ buzzer: 1, volume: '80', radarDistance: null }} />)).not.toThrow()
  })

  it('清单外的键名撞上原型链（__proto__ / constructor / toString）→ 归到未知项，值按 JSON 显示', () => {
    // JSON.parse 会把 "__proto__" 建成自有属性——接口返回的对象就是这么来的
    const settings = JSON.parse('{"__proto__": {"volume": 5}, "constructor": null, "toString": "x", "nested": {"a": [1, 2]}}') as Record<string, unknown>
    const s = summarizeSettings(settings)
    expect(s.changed).toEqual([])
    expect(s.unknown).toEqual([
      { key: '__proto__', text: '__proto__ = {"volume":5}' },
      { key: 'constructor', text: 'constructor = null' },
      { key: 'toString', text: 'toString = "x"' },
      { key: 'nested', text: 'nested = {"a":[1,2]}' },
    ])
    expect(s.defaultCount).toBe(14)
  })

  it('已知项与未知项混在一起：已知项按内存表顺序在前，未知项按原顺序在后', () => {
    render(<DeviceSettingsView settings={{ zzz: 1, light: 2, aaa: 2, heartbeatPeriod: 10 }} />)
    const tags = Array.from(document.querySelectorAll('.ant-tag')).map((el) => el.textContent)
    expect(tags).toEqual(['心跳周期 10 s', '大灯 高亮', 'zzz = 1', 'aaa = 2'])
    expect(screen.getByText('其余 12 项为出厂默认')).toBeInTheDocument()
  })

  it('数值项存了布尔（旧数据）→ 按布尔显示开 / 关；负数、小数照实带单位', () => {
    const s = summarizeSettings({ volume: true, heartbeatPeriod: -1, light: 1.5 })
    expect(s.changed.map((c) => c.text)).toEqual(['心跳周期 -1 s', '蜂鸣音量 开', '大灯 1.5'])
  })

  it('档位项的每个已知档位都翻成中文：振动 0–3、大灯 0–3、灵敏度 1–3', () => {
    const texts = (key: 'vibration' | 'light' | 'fallSensitivity', values: number[]) =>
      values.map((v) => summarizeSettings({ [key]: v }).changed[0]?.text ?? `（${v} 是默认值）`)
    expect(texts('vibration', [0, 1, 2, 3])).toEqual(['振动 关', '振动 弱', '（2 是默认值）', '振动 强'])
    expect(texts('light', [0, 1, 2, 3])).toEqual(['（0 是默认值）', '大灯 低亮', '大灯 高亮', '大灯 爆闪'])
    expect(texts('fallSensitivity', [1, 2, 3])).toEqual(['跌倒灵敏度 低', '（2 是默认值）', '跌倒灵敏度 灵敏'])
  })

  it('悬停改动项看到出厂值；悬停未知项看到「不在设置清单内（旧数据）」', async () => {
    render(<DeviceSettingsView settings={{ volume: 30, beepVolume: 70 }} />)
    fireEvent.mouseEnter(screen.getByText('蜂鸣音量 30%'))
    expect(await screen.findByText('出厂 80%')).toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByText('beepVolume = 70'))
    expect(await screen.findByText('不在设置清单内（旧数据）')).toBeInTheDocument()
  })

  it('只改了一项 → 「其余 13 项为出厂默认」', () => {
    render(<DeviceSettingsView settings={{ radar: false }} />)
    expect(screen.getByText('后方雷达 关')).toBeInTheDocument()
    expect(screen.getByText('其余 13 项为出厂默认')).toBeInTheDocument()
  })

  it.each([
    ['被二次编码成字符串的 JSON', '{"volume":70}'],
    ['数字', 42],
    ['布尔 true', true],
    ['布尔 false', false],
    // typeof [] === 'object'：原来 [] 显示「全部为出厂默认」、['x'] 显示「0 = "x"」再加「其余 14 项为出厂默认」
    ['空数组', []],
    ['数组', ['x']],
  ])('settings 整体不是对象（%s）→ 照实列一条「格式异常」，不白屏、也不声称其余为出厂默认', (_name, settings) => {
    const s = summarizeSettings(settings)
    expect(s).toEqual({
      changed: [],
      unknown: [{ key: '(整体)', text: `设置数据格式异常：${JSON.stringify(settings)}` }],
      defaultCount: 0,
    })
    render(<DeviceSettingsView settings={settings as unknown as Record<string, unknown>} />)
    expect(screen.getByText(`设置数据格式异常：${JSON.stringify(settings)}`)).toBeInTheDocument()
    expect(screen.queryByText(/其余/)).not.toBeInTheDocument()
    expect(screen.queryByText('全部为出厂默认')).not.toBeInTheDocument()
  })

  it('已知项的值是对象 / 数组（异常上报）→ 按 JSON 显示，不是「[object Object]」', () => {
    const s = summarizeSettings({ light: { level: 2 }, volume: [70] })
    expect(s.changed.map((c) => c.text)).toEqual(['蜂鸣音量 [70]%', '大灯 {"level":2}'])
    expect(s.changed.some((c) => c.text.includes('[object Object]'))).toBe(false)
  })
})
