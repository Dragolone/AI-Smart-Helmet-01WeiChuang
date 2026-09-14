import { useQuery } from '@tanstack/react-query'
import { Card, Col, Row, Statistic, Typography } from 'antd'
import {
  AlertOutlined,
  MobileOutlined,
  ThunderboltOutlined,
  UserOutlined,
  WifiOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { api } from '../api/client'
import QueryError from '../components/QueryError'
import type { AdminStatsOverview } from '@helmet/shared'

export default function OverviewPage() {
  const query = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api<AdminStatsOverview>('/admin/stats/overview'),
    // 进行中 SOS 是保命指标，盯紧一点
    refetchInterval: 15_000,
  })
  // 接口失败时指标显示「—」而不是 0：0 是合法的业务值，故障不能伪装成它（审计 ADMIN-01）
  const s = query.isError ? undefined : query.data

  return (
    <Card loading={query.isLoading}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        概览
      </Typography.Title>
      {query.isError && (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title="设备总数"
            value={s?.deviceTotal ?? '—'}
            prefix={<MobileOutlined />}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title="在线设备"
            value={s?.deviceOnline ?? '—'}
            prefix={<WifiOutlined />}
            valueStyle={{ color: '#3f8600' }}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title="用户总数"
            value={s?.userTotal ?? '—'}
            prefix={<UserOutlined />}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title="今日事件"
            value={s?.todayEvents ?? '—'}
            prefix={<ThunderboltOutlined />}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Statistic
            title="进行中 SOS"
            value={s?.activeSos ?? '—'}
            prefix={<AlertOutlined />}
            valueStyle={
              s && s.activeSos > 0 ? { color: '#cf1322' } : undefined
            }
          />
        </Col>
      </Row>
      {s && (
        <Typography.Text
          type="secondary"
          style={{ display: 'block', marginTop: 16 }}
        >
          统计时间：{dayjs(s.generatedAt).format('YYYY-MM-DD HH:mm:ss')}
          （「今日」按北京时间自然日计）
        </Typography.Text>
      )}
    </Card>
  )
}
