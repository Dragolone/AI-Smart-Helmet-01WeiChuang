// 错误横幅的取值分支：ApiError 优先于普通 Error（它也是 Error）、空 message、长得像 Error 的普通对象
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import QueryError from './QueryError'

describe('QueryError：边界', () => {
  it('ApiError 也是 Error：显示 code 与状态码，而不是它的 message', () => {
    render(<QueryError error={new ApiError('NOT_FOUND', '设备不存在', 404)} onRetry={() => undefined} />)
    expect(screen.getByText('NOT_FOUND（HTTP 404）')).toBeInTheDocument()
    expect(screen.queryByText('设备不存在')).not.toBeInTheDocument()
  })

  it('有 message 字段的普通对象不是 Error → 「未知错误」；null / 字符串同样', () => {
    for (const error of [{ message: 'looks like error' }, null, 'boom']) {
      const { unmount } = render(<QueryError error={error} onRetry={() => undefined} />)
      expect(screen.getByText('未知错误')).toBeInTheDocument()
      unmount()
    }
  })

  it('message 为空的 Error → 横幅照常出现（标题仍提示不是真实数据）', () => {
    render(<QueryError error={new Error('')} onRetry={() => undefined} />)
    expect(screen.getByText('加载失败，当前显示的不是真实数据')).toBeInTheDocument()
  })
})
