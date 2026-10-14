import dayjs from 'dayjs'

/** 列表页与详情页共用的时间格式；空值显示「—」 */
export const formatTime = (v: string | null): string =>
  v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '—'

/**
 * 手机号（昵称）；没有昵称时只显示手机号。没有用户时显示什么由调用处决定。
 * 已注销账号的 phone 被改写成 deleted:<id>（原号已释放）：事故记录按 userId 留档，会带出这种行，显示「已注销」
 */
export const formatUserLabel = (u: {
  phone: string
  nickname: string | null
}): string =>
  `${u.phone.startsWith('deleted:') ? '已注销' : u.phone}${u.nickname ? `（${u.nickname}）` : ''}`
