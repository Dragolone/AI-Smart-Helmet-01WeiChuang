import { Navigate, Route, Routes } from 'react-router-dom'
import AdminLayout from './AdminLayout'
import AccidentsPage from './pages/AccidentsPage'
import DeviceDetailPage from './pages/DeviceDetailPage'
import DevicesPage from './pages/DevicesPage'
import EventsPage from './pages/EventsPage'
import LoginPage from './pages/LoginPage'
import OverviewPage from './pages/OverviewPage'
import UsersPage from './pages/UsersPage'

export default function App() {
  return (
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
  )
}
