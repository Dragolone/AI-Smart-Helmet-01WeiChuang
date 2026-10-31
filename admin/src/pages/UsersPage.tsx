import { useQuery } from '@tanstack/react-query'
import { Card, Checkbox, Input, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { formatMinute } from '../utils/format'
import { api } from '../api/client'
import QueryError from '../components/QueryError'
import { useClampPage } from '../utils/use-clamp-page'
import { useListParams } from '../utils/use-list-params'
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
    // 后端不 trim 昵称：空串 / 纯空格与 null 一样显示「—」，否则是一格看不出内容的空白
    render: (v: string | null) => (v?.trim() ? v : '—'),
  },
  {
    title: '注销时间',
    dataIndex: 'deletedAt',
    width: 170,
    render: formatMinute,
  },
  { title: '绑定设备数', dataIndex: 'deviceCount', width: 110 },
  {
    title: '注册时间',
    dataIndex: 'createdAt',
    width: 180,
    render: formatMinute,
  },
]

export default function UsersPage() {
  // 页码 / 每页条数 / 筛选在地址栏里：翻页、筛选后刷新或返回不丢
  const list = useListParams()
  const { page, pageSize, setPage } = list
  const keyword = list.get('keyword')
  const includeDeleted = list.get('includeDeleted') === 'true'

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
  useClampPage(page, pageSize, query.data?.total, setPage)

  return (
    <Card>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        用户列表
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="按手机号 / 昵称搜索"
          allowClear
          // 后端 keyword / deviceId 上限 64 字，超出整页报 400，这里直接限住
          maxLength={64}
          style={{ width: 320 }}
          // 点侧栏同一菜单时 URL 清空、列表回全量，框里的字也要跟着清
          key={keyword}
          defaultValue={keyword}
          onSearch={(value) => list.update({ page: 1, keyword: value.trim() })}
        />
        <Checkbox
          checked={includeDeleted}
          onChange={(e) => list.update({ page: 1, includeDeleted: e.target.checked })}
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
          onChange: (p, ps) =>
            list.update({ page: ps !== pageSize ? 1 : p, pageSize: ps }),
        }}
      />
    </Card>
  )
}
