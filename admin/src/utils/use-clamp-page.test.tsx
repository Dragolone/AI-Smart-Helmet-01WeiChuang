// 页码夹回末页：只在拿到 total 且当前页超出末页时动，loading / 出错（total 未知）时不乱跳
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useClampPage } from './use-clamp-page'

const run = (page: number, pageSize: number, total: number | undefined) => {
  const setPage = vi.fn()
  renderHook(() => useClampPage(page, pageSize, total, setPage))
  return setPage
}

describe('useClampPage', () => {
  it('total 未知（加载中 / 出错）→ 不动页码', () => {
    expect(run(5, 20, undefined)).not.toHaveBeenCalled()
  })

  it('当前页在范围内、恰好是末页 → 不动', () => {
    expect(run(2, 20, 45)).not.toHaveBeenCalled()
    expect(run(2, 20, 40)).not.toHaveBeenCalled()
    expect(run(3, 20, 41)).not.toHaveBeenCalled()
  })

  it('当前页超出末页 → 拉回末页（25 条 / 20 每页 → 第 2 页）', () => {
    expect(run(3, 20, 25)).toHaveBeenCalledWith(2)
    expect(run(9, 50, 120)).toHaveBeenCalledWith(3)
  })

  it('total 变成 0 → 回第 1 页；本来就在第 1 页则不动（末页至少是 1）', () => {
    expect(run(4, 20, 0)).toHaveBeenCalledWith(1)
    expect(run(1, 20, 0)).not.toHaveBeenCalled()
  })

  it('同一组件里 total 由大变小 → 变小那一刻才夹', () => {
    const setPage = vi.fn()
    const { rerender } = renderHook(({ total }: { total: number | undefined }) => useClampPage(3, 20, total, setPage), {
      initialProps: { total: 45 as number | undefined },
    })
    expect(setPage).not.toHaveBeenCalled()
    rerender({ total: undefined })
    expect(setPage).not.toHaveBeenCalled()
    rerender({ total: 5 })
    expect(setPage).toHaveBeenCalledExactlyOnceWith(1)
  })
})
