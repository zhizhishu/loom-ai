import { describe, expect, it } from 'vitest'
import type { ConversationItem } from './types'
import { sortConversationItems } from './conversation-order'

// 排序照抄 Mikka 侧栏比较器（`components/nav/bot-list.tsx:46-52`）：
// 置顶 → 置顶顺序 → 最新活动时间倒序 → 名字字典序。
const row = (id: string, over: Partial<ConversationItem> = {}): ConversationItem => ({
  id, title: id, subtitle: '', agentId: null, threadId: id, missionId: null,
  unread: false, updatedAt: '2026-11-22T00:00:00Z', ...over
})

describe('conversation list order', () => {
  it('puts the newest activity first', () => {
    const rows = sortConversationItems([
      row('old', { updatedAt: '2026-11-20T00:00:00Z' }),
      row('new', { updatedAt: '2026-11-22T00:00:00Z' }),
      row('mid', { updatedAt: '2026-11-21T00:00:00Z' })
    ])
    expect(rows.map(item => item.id)).toEqual(['new', 'mid', 'old'])
  })

  it('keeps pinned rows above newer unpinned ones, in their pin order', () => {
    const rows = sortConversationItems([
      row('fresh', { updatedAt: '2026-11-22T00:00:00Z' }),
      row('second-pin', { pinned: true, pinOrder: 2, updatedAt: '2026-11-01T00:00:00Z' }),
      row('first-pin', { pinned: true, pinOrder: 1, updatedAt: '2026-10-01T00:00:00Z' })
    ])
    expect(rows.map(item => item.id)).toEqual(['first-pin', 'second-pin', 'fresh'])
  })

  it('breaks a tie on the same time by the title, so two readers see one order', () => {
    const rows = sortConversationItems([
      row('second', { title: 'beta', updatedAt: '2026-11-22T00:00:00Z' }),
      row('first', { title: 'alpha', updatedAt: '2026-11-22T00:00:00Z' })
    ])
    expect(rows.map(item => item.id)).toEqual(['first', 'second'])
  })

  it('keeps rows without any activity after the dated ones', () => {
    const rows = sortConversationItems([
      row('agent:not-yet-used', { threadId: null, updatedAt: null }),
      row('chat', { updatedAt: '2026-11-20T00:00:00Z' })
    ])
    expect(rows.map(item => item.id)).toEqual(['chat', 'agent:not-yet-used'])
  })

  it('never mutates the caller list', () => {
    const items = [row('a', { updatedAt: '2026-11-20T00:00:00Z' }), row('b', { updatedAt: '2026-11-22T00:00:00Z' })]
    const sorted = sortConversationItems(items)
    expect(items.map(item => item.id)).toEqual(['a', 'b'])
    expect(sorted.map(item => item.id)).toEqual(['b', 'a'])
  })
})
