import { Navigate, Route, Routes } from 'react-router-dom'
import AdminLayout from './AdminLayout'
import DevicesPage from './pages/DevicesPage'
import LoginPage from './pages/LoginPage'
import UsersPage from './pages/UsersPage'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="/users" replace />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/devices" element={<DevicesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
