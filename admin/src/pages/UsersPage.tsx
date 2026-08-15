import { useQuery } from '@tanstack/react-query'
import { Card, Input, Table, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useState } from 'react'
import { api } from '../api/client'
import type { AdminUserRow, Paginated } from '@helmet/shared'

const columns: ColumnsType<AdminUserRow> = [
  { title: '手机号', dataIndex: 'phone' },
  {
    title: '昵称',
    dataIndex: 'nickname',
    render: (v: string | null) => v ?? '—',
  },
  { title: '绑定设备数', dataIndex: 'deviceCount', width: 110 },
  {
    title: '注册时间',
    dataIndex: 'createdAt',
    width: 180,
    render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
  },
]

export default function UsersPage() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')

  const query = useQuery({
    queryKey: ['admin', 'users', page, pageSize, keyword],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      if (keyword) params.set('keyword', keyword)
      return api<Paginated<AdminUserRow>>(`/admin/users?${params}`)
    },
  })

  return (
    <Card>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        用户列表
      </Typography.Title>
      <Input.Search
        placeholder="按手机号 / 昵称搜索"
        allowClear
        style={{ maxWidth: 320, marginBottom: 16 }}
        onSearch={(value) => {
          setPage(1)
          setKeyword(value.trim())
        }}
      />
      <Table<AdminUserRow>
        rowKey="id"
        columns={columns}
        dataSource={query.data?.items}
        loading={query.isLoading}
        pagination={{
          current: page,
          pageSize,
          total: query.data?.total ?? 0,
          showTotal: (t) => `共 ${t} 个用户`,
          onChange: (p, ps) => {
            setPage(ps !== pageSize ? 1 : p)
            setPageSize(ps)
          },
        }}
      />
    </Card>
  )
}
