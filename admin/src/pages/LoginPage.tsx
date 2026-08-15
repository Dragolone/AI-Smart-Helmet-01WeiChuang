import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { useMutation } from '@tanstack/react-query'
import { App, Button, Card, Form, Input, Typography } from 'antd'
import { Navigate, useNavigate } from 'react-router-dom'
import { api, getToken, saveSession } from '../api/client'
import type { AdminLoginResponse } from '@helmet/shared'

interface LoginForm {
  username: string
  password: string
}

export default function LoginPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()

  const login = useMutation({
    mutationFn: (values: LoginForm) =>
      api<AdminLoginResponse>('/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: (data) => {
      saveSession(data.accessToken, data.admin.username)
      navigate('/users', { replace: true })
    },
    onError: () => {
      // 登录失败统一提示，不区分账号不存在与密码错误（与后端口径一致）
      void message.error('用户名或密码错误')
    },
  })

  if (getToken()) return <Navigate to="/users" replace />

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f5',
      }}
    >
      <Card style={{ width: 360 }}>
        <Typography.Title level={4} style={{ textAlign: 'center' }}>
          智能头盔管理后台
        </Typography.Title>
        <Form<LoginForm>
          onFinish={(values) => login.mutate(values)}
          requiredMark={false}
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="用户名"
              autoComplete="username"
            />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={login.isPending}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
