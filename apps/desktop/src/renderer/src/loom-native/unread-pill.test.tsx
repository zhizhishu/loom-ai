import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { bottomUnreadCount, formatUnreadCount, UnreadPill } from './UnreadPill'

describe('Mikka unread pill', () => {
  it('renders jump and dismiss as separate actions', () => {
    const html = renderToStaticMarkup(createElement(UnreadPill, { count: 3, onJump: () => {}, onDismiss: () => {} }))
    expect(html).toContain('data-unread-pill="down"')
    expect(html).toContain('3 条新消息')
    expect(html).toContain('回到最新，3 条新消息')
    expect(html).toContain('关闭新消息提示')
  })

  it('caps the visible count at 99+', () => {
    expect(formatUnreadCount(99)).toBe('99')
    expect(formatUnreadCount(100)).toBe('99+')
  })

  it('counts only other people\'s messages after leaving bottom', () => {
    const entries = [
      { key: 'message:old', kind: 'message', message: { authorType: 'agent' } },
      { key: 'message:mine', kind: 'message', message: { authorType: 'user' } },
      { key: 'run-event:r1', kind: 'run-event' },
      { key: 'message:new', kind: 'message', message: { authorType: 'agent' } }
    ]
    expect(bottomUnreadCount(entries, 'message:old')).toBe(1)
    expect(bottomUnreadCount(entries, 'message:mine')).toBe(1)
    expect(bottomUnreadCount(entries, 'missing')).toBe(0)
    expect(bottomUnreadCount(entries, null)).toBe(0)
  })
})
