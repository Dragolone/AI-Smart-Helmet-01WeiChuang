import { fireEvent, screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import AdminLayout from './AdminLayout'
import { getToken } from './api/client'
import { renderWithProviders } from './test/render'

const renderApp = (route: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/login" element={<div>登录页</div>} />
      <Route element={<AdminLayout />}>
        <Route path="/overview" element={<div>概览内容</div>} />
        <Route path="/devices/:deviceId" element={<div>设备详情内容</div>} />
      </Route>
    </Routes>,
    route,
  )

describe('AdminLayout 登录门控', () => {
  it('未登录直接打开 /overview → 回登录页', () => {
    renderApp('/overview')
    expect(screen.getByText('登录页')).toBeInTheDocument()
    expect(screen.queryByText('概览内容')).not.toBeInTheDocument()
  })

  it('已登录 → 渲染菜单、用户名与页面；点退出清会话回登录页', () => {
    localStorage.setItem('admin_token', 'tok')
    localStorage.setItem('admin_username', 'ops')
    renderApp('/overview')
    expect(screen.getByText('概览内容')).toBeInTheDocument()
    expect(screen.getByText('ops')).toBeInTheDocument()
    for (const label of ['概览', '用户', '设备', '事故 / SOS', '事件历史']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: /退 出|退出/ }))
    expect(getToken()).toBeNull()
    expect(screen.getByText('登录页')).toBeInTheDocument()
  })

  it('在设备详情页（/devices/:id）侧栏仍高亮「设备」', () => {
    localStorage.setItem('admin_token', 'tok')
    renderApp('/devices/helmet_001')
    expect(screen.getByText('设备详情内容')).toBeInTheDocument()
    const selected = Array.from(document.querySelectorAll('.ant-menu-item-selected')).map((el) => el.textContent)
    expect(selected).toEqual(['设备'])
  })

  it('在概览页高亮「概览」，且只高亮一项', () => {
    localStorage.setItem('admin_token', 'tok')
    renderApp('/overview')
    const selected = Array.from(document.querySelectorAll('.ant-menu-item-selected')).map((el) => el.textContent)
    expect(selected).toEqual(['概览'])
  })
})
