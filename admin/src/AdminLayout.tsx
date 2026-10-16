import {
  AlertOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MobileOutlined,
  ProfileOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Button, Layout, Menu, Spin, Typography } from 'antd'
import { Suspense } from 'react'
import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { clearSession, getToken, getUsername } from './api/client'

const MENU_ITEMS = [
  { key: '/overview', icon: <DashboardOutlined />, label: '概览' },
  { key: '/users', icon: <UserOutlined />, label: '用户' },
  { key: '/devices', icon: <MobileOutlined />, label: '设备' },
  { key: '/accidents', icon: <AlertOutlined />, label: '事故 / SOS' },
  { key: '/events', icon: <ProfileOutlined />, label: '事件历史' },
]

export default function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()

  if (!getToken()) return <Navigate to="/login" replace />

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider theme="dark">
        <div
          style={{
            color: '#fff',
            textAlign: 'center',
            padding: '16px 8px',
            fontSize: 16,
          }}
        >
          智能头盔管理后台
        </div>
        <Menu
          theme="dark"
          mode="inline"
          // 按一级路径高亮：设备详情 /devices/:id 也属于「设备」
          selectedKeys={[`/${location.pathname.split('/')[1]}`]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 12,
            paddingInline: 24,
          }}
        >
          <Typography.Text>{getUsername()}</Typography.Text>
          <Button
            icon={<LogoutOutlined />}
            onClick={() => {
              clearSession()
              navigate('/login', { replace: true })
            }}
          >
            退出
          </Button>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          {/* 各页按需加载（App.tsx）：切页时只有内容区转圈，菜单和顶栏不跟着闪 */}
          <Suspense
            fallback={
              <div style={{ padding: 48, textAlign: 'center' }}>
                <Spin />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
