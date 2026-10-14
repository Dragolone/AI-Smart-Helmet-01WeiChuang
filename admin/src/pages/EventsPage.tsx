import { useQuery } from '@tanstack/react-query'
import {
  Card,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useState } from 'react'
import { api } from '../api/client'
import QueryError from '../components/QueryError'
import { EVENT_TYPES } from '@helmet/shared'
import type { AdminEventRow, Paginated } from '@helmet/shared'

const formatTime = (v: string): string => dayjs(v).format('YYYY-MM-DD HH:mm:ss')

const EVENT_TYPE_OPTIONS = EVENT_TYPES.map((t) => ({ value: t, label: t }))

/** 危险/求救类标红，休眠蓝牙类灰，其余默认 */
const typeColor = (t: string): string | undefined => {
  if (['collision_risk', 'obstacle_risk'].includes(t)) return 'red'
  if (['possible_fall', 'manual_sos'].includes(t)) return 'volcano'
  if (t === 'risk_cleared') return 'green'
  if (t === '_invalid') return 'magenta'
  return undefined
}

const columns: ColumnsType<AdminEventRow> = [
  { title: '接收时间', dataIndex: 'receivedAt', width: 180, render: formatTime },
  { title: '设备', dataIndex: 'deviceId', width: 160 },
  {
    title: '类型',
    dataIndex: 'eventType',
    width: 140,
    render: (t: string) => <Tag color={typeColor(t)}>{t}</Tag>,
  },
  { title: '摘要', dataIndex: 'summary' },
  {
    title: '来源',
    dataIndex: 'source',
    width: 90,
    render: (s: string) => <Tag>{s}</Tag>,
  },
  {
    title: '时钟偏移',
    dataIndex: 'clockSkew',
    width: 90,
    render: (v: boolean) => (v ? <Tag color="orange">偏移</Tag> : '—'),
  },
]

export default function EventsPage() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [types, setTypes] = useState<string[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [invalidOnly, setInvalidOnly] = useState(false)

  const query = useQuery({
    queryKey: [
      'admin',
      'events',
      page,
      pageSize,
      types.join(','),
      deviceId,
      invalidOnly,
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      if (types.length > 0) params.set('type', types.join(','))
      if (deviceId) params.set('deviceId', deviceId)
      if (invalidOnly) params.set('invalid', 'true')
      return api<Paginated<AdminEventRow>>(`/admin/events?${params}`)
    },
    refetchInterval: 30_000,
  })

  return (
    <Card>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        事件历史
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          mode="multiple"
          placeholder="事件类型（可多选）"
          allowClear
          disabled={invalidOnly}
          style={{ minWidth: 260 }}
          options={EVENT_TYPE_OPTIONS}
          onChange={(value: string[]) => {
            setPage(1)
            setTypes(value)
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
        <Space>
          <Switch
            checked={invalidOnly}
            onChange={(checked) => {
              setPage(1)
              setInvalidOnly(checked)
            }}
          />
          <Typography.Text>只看校验失败留档</Typography.Text>
        </Space>
      </Space>
      {query.isError && (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      )}
      {/* eventId 只在设备内唯一（决策 #54）：跨设备的列表要带 deviceId，否则两台设备同号时 key 冲突、行渲染错乱 */}
      <Table<AdminEventRow>
        rowKey={(r) => `${r.deviceId}:${r.eventId}`}
        columns={columns}
        dataSource={query.isError ? [] : query.data?.items}
        loading={query.isLoading}
        expandable={{
          expandedRowRender: (row) => (
            <pre style={{ margin: 0, fontSize: 12 }}>
              {JSON.stringify(row.payload, null, 2)}
            </pre>
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total: query.data?.total ?? 0,
          showTotal: (t) => `共 ${t} 条事件`,
          onChange: (p, ps) => {
            setPage(ps !== pageSize ? 1 : p)
            setPageSize(ps)
          },
        }}
      />
    </Card>
  )
}
