import { useQuery } from '@tanstack/react-query'
import { Card, Input, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useState } from 'react'
import { api } from '../api/client'
import type { AdminDeviceRow, Paginated } from '@helmet/shared'

const formatTime = (v: string | null): string =>
  v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '—'

const columns: ColumnsType<AdminDeviceRow> = [
  { title: '设备 ID', dataIndex: 'deviceId' },
  {
    title: '绑定用户',
    dataIndex: 'bindUser',
    render: (u: AdminDeviceRow['bindUser']) =>
      u ? `${u.phone}${u.nickname ? `（${u.nickname}）` : ''}` : '未绑定',
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
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [online, setOnline] = useState<'true' | 'false' | undefined>()

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

  return (
    <Card>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        设备列表
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="按设备 ID / 绑定手机号搜索"
          allowClear
          style={{ width: 320 }}
          onSearch={(value) => {
            setPage(1)
            setKeyword(value.trim())
          }}
        />
        <Select
          placeholder="在线状态"
          allowClear
          style={{ width: 120 }}
          options={[
            { value: 'true', label: '在线' },
            { value: 'false', label: '离线' },
          ]}
          onChange={(value: 'true' | 'false' | undefined) => {
            setPage(1)
            setOnline(value)
          }}
        />
      </Space>
      <Table<AdminDeviceRow>
        rowKey="deviceId"
        columns={columns}
        dataSource={query.data?.items}
        loading={query.isLoading}
        pagination={{
          current: page,
          pageSize,
          total: query.data?.total ?? 0,
          showTotal: (t) => `共 ${t} 台设备`,
          onChange: (p, ps) => {
            setPage(ps !== pageSize ? 1 : p)
            setPageSize(ps)
          },
        }}
      />
    </Card>
  )
}
