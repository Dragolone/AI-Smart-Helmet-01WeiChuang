import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/** antd 分页器默认给的几档；地址栏里别的值一律按 20 */
const PAGE_SIZES = [10, 20, 50, 100]
const DEFAULT_PAGE_SIZE = 20

const positiveInt = (raw: string | null, fallback: number): number => {
  const n = Number(raw)
  return raw !== null && Number.isInteger(n) && n >= 1 ? n : fallback
}

export type ListParamPatch = Record<string, string | number | boolean | null | undefined>

/**
 * 列表页的页码、每页条数和筛选条件放在地址栏里：进详情再点返回、刷新页面、把链接发给同事都还原。
 * 原来放在组件 state 里，从设备详情返回就回到第 1 页、筛选清空。
 * 改筛选用 replace，不往浏览器历史里一步一步堆；默认值（第 1 页、20 条、空筛选）不写进地址栏。
 */
export function useListParams() {
  const [params, setParams] = useSearchParams()
  const page = positiveInt(params.get('page'), 1)
  const size = positiveInt(params.get('pageSize'), DEFAULT_PAGE_SIZE)
  const pageSize = PAGE_SIZES.includes(size) ? size : DEFAULT_PAGE_SIZE

  const update = useCallback(
    (patch: ListParamPatch) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch)) {
            const isDefault =
              value === undefined ||
              value === null ||
              value === '' ||
              value === false ||
              (key === 'page' && value === 1) ||
              (key === 'pageSize' && value === DEFAULT_PAGE_SIZE)
            if (isDefault) next.delete(key)
            else next.set(key, String(value))
          }
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )
  const setPage = useCallback((p: number) => update({ page: p }), [update])
  /** 地址栏里的字符串值；没有是空串 */
  const get = (key: string): string => params.get(key) ?? ''
  return { page, pageSize, get, update, setPage }
}
