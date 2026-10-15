import { useQuery } from '@tanstack/react-query'
import { Card, Input, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { api } from '../api/client'
import QueryError from '../components/QueryError'
import { useClampPage } from '../utils/use-clamp-page'
import { formatTime, formatUserLabel } from '../utils/format'
import type { AdminAccidentRow, Paginated, SosStatus, SosTriggerType } from '@helmet/shared'

const STATUS_TAG: Record<SosStatus, { color: string; label: string }> = {
  pending: { color: 'orange', label: '倒计时中' },
  notified: { color: 'red', label: '已通知' },
  cancelled: { color: 'default', label: '已取消' },
}

const STATUS_OPTIONS = (Object.keys(STATUS_TAG) as SosStatus[]).map(
  (value) => ({ value, label: STATUS_TAG[value].label }),
)

const TRIGGER_TAG: Record<SosTriggerType, { color: string; label: string }> = {
  possible_fall: { color: 'gold', label: '疑似摔倒' },
  manual_sos: { color: 'volcano', label: '手动求救' },
}

/**
 * 库里 status / trigger_type 是自由字符串列：清单外的值照实显示原值——直接下标取会让整页白屏
 *（undefined.color），按「不是手动就是摔倒」兜底又会把新触发方式误标成疑似摔倒。
 * 用自有属性判断，免得 toString 这类原型上的键被当成已知值。
 */
const knownTag = (table: Record<string, { color: string; label: string }>, key: string) =>
  Object.hasOwn(table, key) ? table[key] : undefined

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
    render: (t: string) => {
      const tag = knownTag(TRIGGER_TAG, t)
      return tag ? <Tag color={tag.color}>{tag.label}</Tag> : <Tag>{t}</Tag>
    },
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 100,
    render: (s: string) => {
      const tag = knownTag(STATUS_TAG, s)
      return tag ? <Tag color={tag.color}>{tag.label}</Tag> : <Tag>{s}</Tag>
    },
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
  useClampPage(page, pageSize, query.data?.total, setPage)

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
