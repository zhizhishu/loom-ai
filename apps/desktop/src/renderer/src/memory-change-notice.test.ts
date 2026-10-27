import { describe, expect, it } from 'vitest'
import type { DomainEventView } from '@contracts'
import { collectMemoryChanges, memoryChangeText, resolveMemoryChangeScope } from './memory-change-notice'

const event = (sequence: number, memoryId: string, action = 'revised', scope?: string): DomainEventView => ({
  globalSequence: sequence, eventType: `memory.agent_${action}`, entityType: 'memory', entityId: memoryId,
  actorType: 'agent', actorId: 'member-a', payload: { memoryId, ...(scope ? { scope } : {}) }
} as DomainEventView)

describe('automatic memory change notices', () => {
  it('never guesses shared scope or creation for a legacy revision without scope', () => {
    const changes = collectMemoryChanges([], [event(1, 'companion-memory')])
    expect(changes[0].scope).toBeNull()
    expect(memoryChangeText(changes, '林')).toBe('林 · 记忆已更新')
    expect(memoryChangeText(resolveMemoryChangeScope(changes, 'companion-memory', 1, 'companion'), '林')).toBe('林 · 队员记忆已更新')
  })

  it('counts identities once and preserves creation within the undismissed batch', () => {
    const first = collectMemoryChanges([], [event(1, 'a', 'created', 'hearth'), event(2, 'a')])
    const changes = collectMemoryChanges(first, [event(2, 'a'), event(3, 'b'), event(4, 'b')])
    expect(changes.map(({ memoryId, action, scope }) => ({ memoryId, action, scope }))).toEqual([
      { memoryId: 'a', action: 'created', scope: 'hearth' },
      { memoryId: 'b', action: 'updated', scope: null }
    ])
    expect(memoryChangeText(changes)).toBe('新增 1 条 · 更新 1 条记忆')
  })

  it('does not reuse another identity’s scope or let a late lookup revive a dismissed notice', () => {
    const changes = collectMemoryChanges([], [event(1, 'a', 'created', 'hearth'), event(2, 'b')])
    expect(changes[1].scope).toBeNull()
    expect(resolveMemoryChangeScope([], 'b', 2, 'companion')).toEqual([])
    const newer = collectMemoryChanges(changes, [event(3, 'b', 'revised', 'relationship')])
    expect(resolveMemoryChangeScope(newer, 'b', 2, 'companion')).toEqual(newer)
    expect(memoryChangeText([newer[1]])).toBe('队员间记忆已更新')
  })

  it('ignores unrelated events and supports the event identity when payload has none', () => {
    expect(collectMemoryChanges([], [{ ...event(1, 'a'), eventType: 'memory.retired' }])).toEqual([])
    const changes = collectMemoryChanges([], [{ ...event(1, 'a', 'created', 'companion'), payload: {} }])
    expect(changes[0].memoryId).toBe('a')
    expect(memoryChangeText(changes)).toBe('新增 1 条记忆')
    expect(memoryChangeText([])).toBe('')
  })
})
