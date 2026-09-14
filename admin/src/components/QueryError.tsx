import { Alert, Button } from 'antd'
import { ApiError } from '../api/client'

interface Props {
  error: unknown
  onRetry: () => void
}

/**
 * 查询失败的统一呈现：后台是运维判断系统状态的窗口，把接口 5xx 渲染成空列表/全 0
 * 会让真实故障被当成"没有数据"（2026-09-13 审计 ADMIN-01）。
 */
export default function QueryError({ error, onRetry }: Props) {
  const detail =
    error instanceof ApiError
      ? `${error.code}（HTTP ${error.status}）`
      : error instanceof Error
        ? error.message
        : '未知错误'
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16 }}
      message="加载失败，当前显示的不是真实数据"
      description={detail}
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
    />
  )
}
