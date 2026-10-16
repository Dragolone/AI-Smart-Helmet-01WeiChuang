import { Space, Tag, Tooltip, Typography } from 'antd'
import { MALFORMED_KEY, summarizeSettings } from './settings-summary'

/** 设备当前生效设置：只列改过的项，其余一句话带过 */
export default function DeviceSettingsView({
  settings,
}: {
  settings: Record<string, unknown> | null | undefined
}) {
  const { changed, unknown, defaultCount } = summarizeSettings(settings)
  if (changed.length === 0 && unknown.length === 0) {
    return <Typography.Text type="secondary">全部为出厂默认</Typography.Text>
  }
  return (
    <Space size={[4, 8]} wrap>
      {changed.map((c) => (
        <Tooltip key={c.key} title={c.defaultText}>
          <Tag color="blue">{c.text}</Tag>
        </Tooltip>
      ))}
      {unknown.map((u) => (
        <Tooltip
          key={u.key}
          title={
            u.key === MALFORMED_KEY ? '设置不是一组键值，无法逐项比对' : '不在设置清单内（旧数据）'
          }
        >
          <Tag>{u.text}</Tag>
        </Tooltip>
      ))}
      {defaultCount > 0 && (
        <Typography.Text type="secondary">其余 {defaultCount} 项为出厂默认</Typography.Text>
      )}
    </Space>
  )
}
