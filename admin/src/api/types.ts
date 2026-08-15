// docs/API.md §10 的响应类型；字段变更须先改 API.md 再同步这里

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface AdminInfo {
  id: string
  username: string
}

export interface AdminLoginResponse {
  admin: AdminInfo
  accessToken: string
}

export interface AdminUserRow {
  id: string
  phone: string
  nickname: string | null
  avatarUrl: string | null
  createdAt: string
  deviceCount: number
}

export interface AdminDeviceRow {
  deviceId: string
  online: boolean
  lastSeenAt: string | null
  battery: number | null
  charging: boolean | null
  signalLevel: number | null
  sleeping: boolean
  firmwareVersion: string | null
  boundAt: string | null
  createdAt: string
  bindUser: { id: string; phone: string; nickname: string | null } | null
}
