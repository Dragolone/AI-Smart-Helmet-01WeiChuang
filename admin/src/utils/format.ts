import dayjs from 'dayjs'

/** 列表页与详情页共用的时间格式；空值显示「—」 */
export const formatTime = (v: string | null): string =>
  v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '—'

/** 手机号（昵称）；没有昵称时只显示手机号。没有用户时显示什么由调用处决定 */
export const formatUserLabel = (u: {
  phone: string
  nickname: string | null
}): string => `${u.phone}${u.nickname ? `（${u.nickname}）` : ''}`
