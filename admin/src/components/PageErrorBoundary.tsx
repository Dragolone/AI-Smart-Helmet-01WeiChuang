import { Button, Result } from 'antd'
import { Component, type ReactNode } from 'react'

/**
 * 页面开着时发了版：旧的按页分包已经不在，网关把缺失的 JS 回成 index.html，动态导入失败后整个根节点卸载，
 * 只剩白屏。这里接住，让人刷新一下拿新版本
 */
export default class PageErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <Result
        status="warning"
        title="页面加载失败"
        subTitle="后台可能刚更新过，刷新后再试"
        extra={
          <Button type="primary" onClick={() => window.location.reload()}>
            刷新
          </Button>
        }
      />
    )
  }
}
