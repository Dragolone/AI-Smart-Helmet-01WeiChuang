import { render, screen } from '@testing-library/react'
import { lazy, Suspense } from 'react'
import { describe, expect, it, vi } from 'vitest'
import PageErrorBoundary from './PageErrorBoundary'

describe('PageErrorBoundary', () => {
  it('按页分包加载失败（发版后旧标签页）：提示刷新，不是白屏', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const Broken = lazy(() => Promise.reject(new Error('chunk gone')))
    render(
      <PageErrorBoundary>
        <Suspense fallback="加载中">
          <Broken />
        </Suspense>
      </PageErrorBoundary>,
    )
    expect(await screen.findByText('页面加载失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /刷\s*新/ })).toBeInTheDocument()
    quiet.mockRestore()
  })

  it('没出错时原样渲染', () => {
    render(
      <PageErrorBoundary>
        <div>内容</div>
      </PageErrorBoundary>,
    )
    expect(screen.getByText('内容')).toBeInTheDocument()
  })
})
