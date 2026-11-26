import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComputerAgentApprovalCards, ComputerAgentModeControls } from './ComputerAgentAccess'
import { ComputerPanel } from './ComputerPanel'

describe('computer takeover UI', () => {
  it('shows the two assistant operation modes', () => {
    const html = renderToStaticMarkup(createElement(ComputerAgentModeControls, { mode: 'ask', modeReady: true, busy: false, onChoose: () => {} }))
    expect(html).toContain('助手操作模式')
    expect(html).toContain('每步先问我')
    expect(html).toContain('全权限')
  })

  it('shows one approval card per pending assistant computer step', () => {
    const html = renderToStaticMarkup(createElement(ComputerAgentApprovalCards, {
      busy: false,
      onDecide: () => {},
      approvals: [{ approvalId: 'a1', assistantId: 'agent', grantId: 'grant', digest: 'd'.repeat(64), tool: 'computer.input', summary: '点击屏幕中央', createdAt: 1, expiresAt: 2, status: 'pending' }]
    }))
    expect(html).toContain('助手请求操作电脑')
    expect(html).toContain('点击屏幕中央')
    expect(html).toContain('不批准不会落到屏幕')
    expect(html).toContain('允许这一步')
    expect(html).toContain('本任务内都允许')
    expect(html).toContain('拒绝')
  })

  it('explains that one screen click starts takeover', () => {
    const html = renderToStaticMarkup(createElement(ComputerPanel, {}))
    expect(html).toContain('点一下画面立即接管鼠标和键盘')
    expect(html).toContain('所选电脑屏幕；点击接管')
  })
})
