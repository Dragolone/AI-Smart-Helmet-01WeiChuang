import { useEffect } from 'react'

/**
 * 数据变少后当前页可能已不存在（在线筛选下设备掉线、账号注销……轮询 / 聚焦刷新拿回更小的 total）：
 * antd 只把页码「显示」夹到末页、不回调 onChange，查询仍停在旧页——表格空白、总数却不为 0，
 * 高亮的那个页码点了也没反应（它以为已经在那一页）。拿到 total 后把页码拉回末页。
 */
export function useClampPage(
  page: number,
  pageSize: number,
  total: number | undefined,
  setPage: (page: number) => void,
): void {
  useEffect(() => {
    if (total === undefined) return
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    if (page > lastPage) setPage(lastPage)
  }, [page, pageSize, total, setPage])
}
