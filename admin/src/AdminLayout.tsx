import { LogoutOutlined, MobileOutlined, UserOutlined } from '@ant-design/icons'
import { Button, Layout, Menu, Typography } from 'antd'
import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { clearSession, getToken, getUsername } from './api/client'

const MENU_ITEMS = [
  { key: '/users', icon: <UserOutlined />, label: '用户' },
  { key: '/devices', icon: <MobileOutlined />, label: '设备' },
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
          selectedKeys={[location.pathname]}
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
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
