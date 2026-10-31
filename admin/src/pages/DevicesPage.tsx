import { useQuery } from '@tanstack/react-query'
import { Card, Input, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import QueryError from '../components/QueryError'
import { useClampPage } from '../utils/use-clamp-page'
import { useListParams } from '../utils/use-list-params'
import { formatTime, formatUserLabel } from '../utils/format'
import type { AdminDeviceRow, Paginated } from '@helmet/shared'

const columns: ColumnsType<AdminDeviceRow> = [
  {
    title: '设备 ID',
    dataIndex: 'deviceId',
    render: (id: string) => <Link to={`/devices/${encodeURIComponent(id)}`}>{id}</Link>,
  },
  {
    title: '绑定用户',
    dataIndex: 'bindUser',
    render: (u: AdminDeviceRow['bindUser']) =>
      u ? formatUserLabel(u) : '未绑定',
  },
  {
    title: '状态',
    dataIndex: 'online',
    width: 90,
    render: (online: boolean) =>
      online ? <Tag color="green">在线</Tag> : <Tag>离线</Tag>,
  },
  {
    title: '电量',
    dataIndex: 'battery',
    width: 90,
    render: (v: number | null, row) =>
      v === null ? '—' : `${v}%${row.charging ? ' ⚡' : ''}`,
  },
  {
    title: '固件版本',
    dataIndex: 'firmwareVersion',
    width: 110,
    render: (v: string | null) => v ?? '—',
  },
  {
    title: '最后在线',
    dataIndex: 'lastSeenAt',
    width: 190,
    render: formatTime,
  },
]

export default function DevicesPage() {
  // 页码 / 每页条数 / 筛选在地址栏里：进设备详情再返回不丢
  const list = useListParams()
  const { page, pageSize, setPage } = list
  const keyword = list.get('keyword')
  const onlineRaw = list.get('online')
  const online = onlineRaw === 'true' || onlineRaw === 'false' ? onlineRaw : undefined

  const query = useQuery({
    queryKey: ['admin', 'devices', page, pageSize, keyword, online],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      if (keyword) params.set('keyword', keyword)
      if (online !== undefined) params.set('online', online)
      return api<Paginated<AdminDeviceRow>>(`/admin/devices?${params}`)
    },
    // 在线状态基于 90s 心跳窗口，页面停留时定期刷新保持可信
    refetchInterval: 30_000,
  })
  useClampPage(page, pageSize, query.data?.total, setPage)

  return (
    <Card>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        设备列表
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="按设备 ID / 绑定手机号搜索"
          allowClear
          // 后端 keyword / deviceId 上限 64 字，超出整页报 400，这里直接限住
          maxLength={64}
          style={{ width: 320 }}
          // 点侧栏同一菜单时 URL 清空、列表回全量，框里的字也要跟着清
          key={keyword}
          defaultValue={keyword}
          onSearch={(value) => list.update({ page: 1, keyword: value.trim() })}
        />
        <Select
          placeholder="在线状态"
          allowClear
          style={{ width: 120 }}
          options={[
            { value: 'true', label: '在线' },
            { value: 'false', label: '离线' },
          ]}
          value={online}
          onChange={(value: 'true' | 'false' | undefined) =>
            list.update({ page: 1, online: value })
          }
        />
      </Space>
      {query.isError && (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      )}
      <Table<AdminDeviceRow>
        rowKey="deviceId"
        columns={columns}
        dataSource={query.isError ? [] : query.data?.items}
        loading={query.isLoading}
        pagination={{
          current: page,
          pageSize,
          total: query.data?.total ?? 0,
          showTotal: (t) => `共 ${t} 台设备`,
          onChange: (p, ps) =>
            list.update({ page: ps !== pageSize ? 1 : p, pageSize: ps }),
        }}
      />
    </Card>
  )
}
