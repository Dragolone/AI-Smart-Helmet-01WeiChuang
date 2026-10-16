import { Spin } from 'antd'
import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AdminLayout from './AdminLayout'

// 按页拆包：原来七页打成一个 1.1 MB 的文件，打开登录页也要先下完整个后台。
// 布局（菜单、登录态守卫）留在首包，各页用到时再取
const AccidentsPage = lazy(() => import('./pages/AccidentsPage'))
const DeviceDetailPage = lazy(() => import('./pages/DeviceDetailPage'))
const DevicesPage = lazy(() => import('./pages/DevicesPage'))
const EventsPage = lazy(() => import('./pages/EventsPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const OverviewPage = lazy(() => import('./pages/OverviewPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))

const pageFallback = (
  <div style={{ padding: 48, textAlign: 'center' }}>
    <Spin />
  </div>
)

export default function App() {
  return (
    <Suspense fallback={pageFallback}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AdminLayout />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
          <Route path="/accidents" element={<AccidentsPage />} />
          <Route path="/events" element={<EventsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
