// 设备当前生效设置的汇总（纯函数）：哪些项和出厂默认不同、哪些是清单外的旧数据。
// 从 DeviceSettingsView.tsx 拆出来：组件文件只导出组件，热更新才能只刷这一个组件。
import {
  DEVICE_SETTINGS,
  DEVICE_SETTING_KEYS,
  isDeviceSettingKey,
  type DeviceSettingKey,
} from '@helmet/shared'

// 键名以 shared 的 DEVICE_SETTINGS 为准；这里只放 Admin 的中文短名与档位名。
// Record<DeviceSettingKey, …> 让 shared 新增设置项时这里编译报错，不会漏显示。
const DISPLAY: Record<DeviceSettingKey, { label: string; choices?: Record<number, string> }> = {
  heartbeatPeriod: { label: '心跳周期' },
  locationPeriodMoving: { label: '运动定位周期' },
  locationPeriodStill: { label: '静止定位周期' },
  buzzer: { label: '蜂鸣提醒' },
  volume: { label: '蜂鸣音量' },
  vibration: { label: '振动', choices: { 0: '关', 1: '弱', 2: '中', 3: '强' } },
  light: { label: '大灯', choices: { 0: '关', 1: '低亮', 2: '高亮', 3: '爆闪' } },
  fallDetect: { label: '跌倒检测' },
  fallSensitivity: { label: '跌倒灵敏度', choices: { 1: '低', 2: '标准', 3: '灵敏' } },
  radar: { label: '后方雷达' },
  radarDistance: { label: '后方预警距离' },
  obstacleWarn: { label: '前方障碍预警' },
  sosButton: { label: 'SOS 按键' },
  disconnectBeep: { label: '断连蜂鸣' },
}

const formatValue = (key: DeviceSettingKey, value: unknown): string => {
  const spec = DEVICE_SETTINGS[key]
  if (typeof value === 'boolean') return value ? '开' : '关'
  const choice = typeof value === 'number' ? DISPLAY[key].choices?.[value] : undefined
  if (choice) return choice
  const unit = 'unit' in spec ? spec.unit : ''
  // 对象 / 数组用 String() 只会得到「[object Object]」，照实列出要按 JSON 显示
  const raw = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  return `${raw}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`
}

export interface SettingsSummary {
  /** 与出厂默认不同的项，按内存表顺序 */
  changed: { key: DeviceSettingKey; text: string; defaultText: string }[]
  /** 不在清单里的旧数据，原样列出 */
  unknown: { key: string; text: string }[]
  /** 等于出厂默认（或从未下发）的项数 */
  defaultCount: number
}

/** 整个设置不是一组键值时，unknown 里那一条的 key */
export const MALFORMED_KEY = '(整体)'

export function summarizeSettings(settings: unknown): SettingsSummary {
  // JSON 列可以存进任何 JSON 值：对字符串 / 数字 / 布尔用 `in` 会抛 TypeError，整个详情页白屏。
  // 整体照实列成一条，且不声称其余项是出厂默认——这时设备上到底是什么并不知道
  // 数组同样不是一组键值（typeof [] === 'object'）：原来 [] 显示「全部为出厂默认」、['x'] 显示「0 = "x"」
  if (Array.isArray(settings) || (settings != null && typeof settings !== 'object')) {
    return {
      changed: [],
      unknown: [{ key: MALFORMED_KEY, text: `设置数据格式异常：${JSON.stringify(settings)}` }],
      defaultCount: 0,
    }
  }
  const s = (settings ?? {}) as Record<string, unknown>
  const changed: SettingsSummary['changed'] = []
  for (const key of DEVICE_SETTING_KEYS) {
    if (!(key in s) || s[key] === DEVICE_SETTINGS[key].default) continue
    changed.push({
      key,
      text: `${DISPLAY[key].label} ${formatValue(key, s[key])}`,
      defaultText: `出厂 ${formatValue(key, DEVICE_SETTINGS[key].default)}`,
    })
  }
  const unknown = Object.entries(s)
    .filter(([k]) => !isDeviceSettingKey(k))
    .map(([key, v]) => ({ key, text: `${key} = ${JSON.stringify(v)}` }))
  return { changed, unknown, defaultCount: DEVICE_SETTING_KEYS.length - changed.length }
}
