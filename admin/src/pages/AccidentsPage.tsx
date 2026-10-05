import { useQuery } from '@tanstack/react-query'
import { Card, Input, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { api } from '../api/client'
import QueryError from '../components/QueryError'
import { formatTime, formatUserLabel } from '../utils/format'
import type { AdminAccidentRow, Paginated, SosStatus } from '@helmet/shared'

const STATUS_TAG: Record<SosStatus, { color: string; label: string }> = {
  pending: { color: 'orange', label: '倒计时中' },
  notified: { color: 'red', label: '已通知' },
  cancelled: { color: 'default', label: '已取消' },
}

const STATUS_OPTIONS = (Object.keys(STATUS_TAG) as SosStatus[]).map(
  (value) => ({ value, label: STATUS_TAG[value].label }),
)

const columns: ColumnsType<AdminAccidentRow> = [
  { title: '时间', dataIndex: 'createdAt', width: 180, render: formatTime },
  { title: '设备', dataIndex: 'deviceId', width: 160 },
  {
    title: '用户',
    dataIndex: 'user',
    render: (u: AdminAccidentRow['user']) =>
      u ? formatUserLabel(u) : '—',
  },
  {
    title: '触发方式',
    dataIndex: 'triggerType',
    width: 110,
    render: (t: string) =>
      t === 'manual_sos' ? (
        <Tag color="volcano">手动求救</Tag>
      ) : (
        <Tag color="gold">疑似摔倒</Tag>
      ),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 100,
    render: (s: SosStatus) => (
      <Tag color={STATUS_TAG[s].color}>{STATUS_TAG[s].label}</Tag>
    ),
  },
  {
    title: '事故位置',
    dataIndex: 'location',
    render: (loc: AdminAccidentRow['location']) =>
      loc
        ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}（${loc.coordinateSystem}${loc.source === 'last_point' ? '·轨迹回落' : ''}）`
        : '无位置',
  },
]

export default function AccidentsPage() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [status, setStatus] = useState<SosStatus | undefined>()
  const [deviceId, setDeviceId] = useState('')

  const query = useQuery({
    queryKey: ['admin', 'accidents', page, pageSize, status, deviceId],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      if (status) params.set('status', status)
      if (deviceId) params.set('deviceId', deviceId)
      return api<Paginated<AdminAccidentRow>>(`/admin/accidents?${params}`)
    },
    // 进行中 SOS 状态会随倒计时/取消变化，停留时保持可信
    refetchInterval: 15_000,
  })

  return (
    <Card>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        事故 / SOS 记录
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="状态"
          allowClear
          style={{ width: 140 }}
          options={STATUS_OPTIONS}
          onChange={(value: SosStatus | undefined) => {
            setPage(1)
            setStatus(value)
          }}
        />
        <Input.Search
          placeholder="按设备 ID 精确筛选"
          allowClear
          style={{ width: 260 }}
          onSearch={(value) => {
            setPage(1)
            setDeviceId(value.trim())
          }}
        />
      </Space>
      {query.isError && (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      )}
      <Table<AdminAccidentRow>
        rowKey="sosId"
        columns={columns}
        dataSource={query.isError ? [] : query.data?.items}
        loading={query.isLoading}
        pagination={{
          current: page,
          pageSize,
          total: query.data?.total ?? 0,
          showTotal: (t) => `共 ${t} 条记录`,
          onChange: (p, ps) => {
            setPage(ps !== pageSize ? 1 : p)
            setPageSize(ps)
          },
        }}
      />
    </Card>
  )
}
