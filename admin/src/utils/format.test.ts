// 列表页 / 详情页共用的两个格式化函数：时间按北京时间展示、空值显示「—」；
// 用户标签对已注销账号（phone 被改写成 deleted:<id>）不露出内部 id。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatMinute, formatTime, formatUserLabel } from './format'

beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('formatMinute', () => {
  it('只到分钟；空值「—」；解析不了的原样显示（不是「Invalid Date」）', () => {
    expect(formatMinute('2026-09-30T16:00:59.999Z')).toBe('2026-10-01 00:00')
    expect(formatMinute(null)).toBe('—')
    expect(formatMinute('')).toBe('—')
    expect(formatMinute('not-a-date')).toBe('not-a-date')
  })
})

describe('formatTime', () => {
  it('null 与空串都显示「—」（从未上线 / 从未绑定）', () => {
    expect(formatTime(null)).toBe('—')
    expect(formatTime('')).toBe('—')
  })

  it('UTC 时间转北京时间：16:00Z 跨到次日 00:00；跨年、闰日照常', () => {
    expect(formatTime('2026-09-30T16:00:00.000Z')).toBe('2026-10-01 00:00:00')
    expect(formatTime('2026-12-31T16:00:00Z')).toBe('2027-01-01 00:00:00')
    expect(formatTime('2028-02-28T16:30:15Z')).toBe('2028-02-29 00:30:15')
  })

  it('带时区偏移的写法按偏移换算，不当成本地时间', () => {
    expect(formatTime('2026-10-16T08:00:00+08:00')).toBe('2026-10-16 08:00:00')
    expect(formatTime('2026-10-16T00:00:00-05:00')).toBe('2026-10-16 13:00:00')
  })

  it('毫秒被截掉而不是四舍五入：23:59:59.999 仍是当天', () => {
    expect(formatTime('2026-10-16T15:59:59.999Z')).toBe('2026-10-16 23:59:59')
  })

  it('解析不了的字符串原样显示，不显示成「Invalid Date」', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date')
    expect(formatTime('Invalid Date')).toBe('Invalid Date')
  })

  it('1970 纪元零点（设备未对时的时间戳）照实显示，不当空值', () => {
    expect(formatTime('1970-01-01T00:00:00.000Z')).toBe('1970-01-01 08:00:00')
  })
})

describe('formatUserLabel', () => {
  it('有昵称：手机号（昵称）；昵称为 null 或空串只显示手机号', () => {
    expect(formatUserLabel({ phone: '13800001111', nickname: '小李' })).toBe('13800001111（小李）')
    expect(formatUserLabel({ phone: '13800001111', nickname: null })).toBe('13800001111')
    expect(formatUserLabel({ phone: '13800001111', nickname: '' })).toBe('13800001111')
  })

  it('昵称是纯空格（后端不 trim）→ 当作没有昵称，不出现「（  ）」', () => {
    expect(formatUserLabel({ phone: '13800001111', nickname: '   ' })).toBe('13800001111')
    expect(formatUserLabel({ phone: 'deleted:u_1', nickname: '\t' })).toBe('已注销')
    // 前后带空格但有内容的昵称原样保留
    expect(formatUserLabel({ phone: '13800001111', nickname: ' 小李 ' })).toBe('13800001111（ 小李 ）')
  })

  it('已注销账号（deleted:<id>）显示「已注销」，昵称照带，内部 id 不露出', () => {
    expect(formatUserLabel({ phone: 'deleted:u_42', nickname: '老王' })).toBe('已注销（老王）')
    expect(formatUserLabel({ phone: 'deleted:u_42', nickname: null })).toBe('已注销')
    // 前缀后面什么都没有也按已注销处理
    expect(formatUserLabel({ phone: 'deleted:', nickname: null })).toBe('已注销')
  })

  it('只有以 deleted: 开头才算注销：大小写不同、出现在中间都照原样显示', () => {
    expect(formatUserLabel({ phone: 'Deleted:u_1', nickname: null })).toBe('Deleted:u_1')
    expect(formatUserLabel({ phone: '+86deleted:1', nickname: null })).toBe('+86deleted:1')
  })

  it('超长昵称（后端上限 30 字）与特殊字符原样拼接，不截断不转义', () => {
    const nick = '骑'.repeat(30)
    expect(formatUserLabel({ phone: '13800001111', nickname: nick })).toBe(`13800001111（${nick}）`)
    expect(formatUserLabel({ phone: '13800001111', nickname: '<b>&"\'' })).toBe('13800001111（<b>&"\'）')
  })
})
