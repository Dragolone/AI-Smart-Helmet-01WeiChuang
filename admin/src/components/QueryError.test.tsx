import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import QueryError from './QueryError'

describe('QueryError（审计 ADMIN-01：接口故障不能伪装成「没有数据」）', () => {
  it('ApiError 显示 code 与 HTTP 状态；点重试回调', () => {
    const onRetry = vi.fn()
    render(<QueryError error={new ApiError('INTERNAL_ERROR', 'boom', 500)} onRetry={onRetry} />)
    expect(screen.getByText('加载失败，当前显示的不是真实数据')).toBeInTheDocument()
    expect(screen.getByText('INTERNAL_ERROR（HTTP 500）')).toBeInTheDocument()
    // antd 给两字按钮自动加空格（「重 试」）
    fireEvent.click(screen.getByRole('button', { name: /重\s?试/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('普通 Error 显示 message；未知值显示「未知错误」', () => {
    const { rerender } = render(<QueryError error={new Error('Failed to fetch')} onRetry={() => undefined} />)
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    rerender(<QueryError error={42} onRetry={() => undefined} />)
    expect(screen.getByText('未知错误')).toBeInTheDocument()
  })
})
