import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import DeviceSettingsView, { summarizeSettings } from './DeviceSettingsView'

describe('DeviceSettingsView', () => {
  it('没有设置 → 一句「全部为出厂默认」', () => {
    render(<DeviceSettingsView settings={null} />)
    expect(screen.getByText('全部为出厂默认')).toBeInTheDocument()
  })

  it('只列与出厂默认不同的项，档位与单位翻成人话，其余一句带过', () => {
    render(
      <DeviceSettingsView
        settings={{ volume: 70, light: 1, fallDetect: false, radarDistance: 20, heartbeatPeriod: 60 }}
      />,
    )
    expect(screen.getByText('蜂鸣音量 70%')).toBeInTheDocument()
    expect(screen.getByText('大灯 低亮')).toBeInTheDocument()
    expect(screen.getByText('跌倒检测 关')).toBeInTheDocument()
    expect(screen.getByText('后方预警距离 20 m')).toBeInTheDocument()
    // heartbeatPeriod=60 等于出厂默认，不单独列
    expect(screen.queryByText(/心跳周期/)).not.toBeInTheDocument()
    expect(screen.getByText('其余 10 项为出厂默认')).toBeInTheDocument()
  })

  it('等于默认的值不算改动；清单外的旧键原样列出', () => {
    const s = summarizeSettings({ volume: 80, beepVolume: 70 })
    expect(s.changed).toEqual([])
    expect(s.unknown).toEqual([{ key: 'beepVolume', text: 'beepVolume = 70' }])
    expect(s.defaultCount).toBe(14)
  })

  it('每项带出厂默认供悬停查看，顺序跟内存表一致', () => {
    const s = summarizeSettings({ light: 3, volume: 30, vibration: 0 })
    expect(s.changed.map((c) => [c.text, c.defaultText])).toEqual([
      ['蜂鸣音量 30%', '出厂 80%'],
      ['振动 关', '出厂 中'],
      ['大灯 爆闪', '出厂 关'],
    ])
  })
})
