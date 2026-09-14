import { useQuery } from '@tanstack/react-query'
import { Card, Checkbox, Input, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useState } from 'react'
import { api } from '../api/client'
import QueryError from '../components/QueryError'
import type { AdminUserRow, Paginated } from '@helmet/shared'

const columns: ColumnsType<AdminUserRow> = [
  {
    title: '手机号',
    dataIndex: 'phone',
    // 已注销账号的 phone 已改写为 deleted:<id>（原号已释放），用标记代替显示
    render: (v: string, row) =>
      row.deletedAt ? <Tag color="default">已注销</Tag> : v,
  },
  {
    title: '昵称',
    dataIndex: 'nickname',
    render: (v: string | null) => v ?? '—',
  },
  {
    title: '注销时间',
    dataIndex: 'deletedAt',
    width: 170,
    render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—'),
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
  const [includeDeleted, setIncludeDeleted] = useState(false)

  const query = useQuery({
    queryKey: ['admin', 'users', page, pageSize, keyword, includeDeleted],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      if (keyword) params.set('keyword', keyword)
      if (includeDeleted) params.set('includeDeleted', 'true')
      return api<Paginated<AdminUserRow>>(`/admin/users?${params}`)
    },
  })

  return (
    <Card>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        用户列表
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="按手机号 / 昵称搜索"
          allowClear
          style={{ width: 320 }}
          onSearch={(value) => {
            setPage(1)
            setKeyword(value.trim())
          }}
        />
        <Checkbox
          checked={includeDeleted}
          onChange={(e) => {
            setPage(1)
            setIncludeDeleted(e.target.checked)
          }}
        >
          含已注销
        </Checkbox>
      </Space>
      {query.isError && (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      )}
      <Table<AdminUserRow>
        rowKey="id"
        columns={columns}
        dataSource={query.isError ? [] : query.data?.items}
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
