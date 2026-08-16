import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Card,
  Descriptions,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ArrowLeftOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { AdminDeviceDetail, AdminEventRow } from '@helmet/shared'

const formatTime = (v: string | null): string =>
  v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '—'

const eventColumns: ColumnsType<AdminEventRow> = [
  { title: '接收时间', dataIndex: 'receivedAt', width: 180, render: formatTime },
  {
    title: '类型',
    dataIndex: 'eventType',
    width: 140,
    render: (t: string) => <Tag>{t}</Tag>,
  },
  { title: '摘要', dataIndex: 'summary' },
  {
    title: '来源',
    dataIndex: 'source',
    width: 100,
    render: (s: string) => <Tag>{s}</Tag>,
  },
]

export default function DeviceDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>()
  const navigate = useNavigate()

  const query = useQuery({
    queryKey: ['admin', 'device', deviceId],
    queryFn: () => api<AdminDeviceDetail>(`/admin/devices/${deviceId}`),
    enabled: Boolean(deviceId),
    refetchInterval: 30_000,
  })
  const d = query.data

  return (
    <Card loading={query.isLoading}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <Typography.Title level={5} style={{ margin: 0 }}>
          设备详情：{deviceId}
        </Typography.Title>
      </Space>
      {d && (
        <>
          <Descriptions bordered size="small" column={3}>
            <Descriptions.Item label="状态">
              {d.online ? <Tag color="green">在线</Tag> : <Tag>离线</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="电量">
              {d.battery === null ? '—' : `${d.battery}%${d.charging ? ' ⚡' : ''}`}
            </Descriptions.Item>
            <Descriptions.Item label="固件版本">
              {d.firmwareVersion ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="绑定用户">
              {d.bindUser
                ? `${d.bindUser.phone}${d.bindUser.nickname ? `（${d.bindUser.nickname}）` : ''}`
                : '未绑定'}
            </Descriptions.Item>
            <Descriptions.Item label="最后在线">
              {formatTime(d.lastSeenAt)}
            </Descriptions.Item>
            <Descriptions.Item label="绑定时间">
              {formatTime(d.boundAt)}
            </Descriptions.Item>
            <Descriptions.Item label="当前生效设置" span={3}>
              <code>{JSON.stringify(d.settings ?? {})}</code>
            </Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5} style={{ marginTop: 24 }}>
            最近事件
          </Typography.Title>
          <Table<AdminEventRow>
            rowKey="eventId"
            columns={eventColumns}
            dataSource={d.recentEvents}
            pagination={false}
            size="small"
            expandable={{
              expandedRowRender: (row) => (
                <pre style={{ margin: 0, fontSize: 12 }}>
                  {JSON.stringify(row.payload, null, 2)}
                </pre>
              ),
            }}
          />
        </>
      )}
    </Card>
  )
}
