import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@contracts'
import { setupChecklistItemState, setupChecklistRemaining } from './setup-checklist'
import { SetupChecklist } from './SetupChecklist'

const agent = (over: object = {}) => ({
  presence: 'present', removedAt: null, runtimeConfiguration: null,
  runtimeReadiness: { status: 'runtime_not_configured', blockers: [] }, ...over
} as unknown as AgentProfile)

describe('setup checklist', () => {
  it('derives assistant/runtime/workspace states from existing facts', () => {
    const empty = { agents: [], hasWorkspaceDefault: false }
    expect(setupChecklistRemaining(empty)).toBe(3)
    const ready = agent({ runtimeConfiguration: { adapterKind: 'pi' }, runtimeReadiness: { status: 'ready', blockers: [] } })
    const input = { agents: [ready], hasWorkspaceDefault: true }
    expect(setupChecklistItemState('assistant', input)).toBe('done')
    expect(setupChecklistItemState('runtime', input)).toBe('done')
    expect(setupChecklistItemState('workspace', input)).toBe('done')
    expect(setupChecklistRemaining(input)).toBe(0)
  })
  it('does not count removed assistants or unready runtimes as done', () => {
    const removed = agent({ removedAt: '2026-01-01T00:00:00Z', presence: 'removed' })
    expect(setupChecklistItemState('assistant', { agents: [removed], hasWorkspaceDefault: false })).toBe('todo')
    expect(setupChecklistItemState('runtime', { agents: [agent({ runtimeConfiguration: { adapterKind: 'pi' } })], hasWorkspaceDefault: false })).toBe('todo')
  })
  it('renders remaining count and real settings deep-link targets', () => {
    const html = renderToStaticMarkup(createElement(SetupChecklist, {
      agents: [], hasWorkspaceDefault: false,
      onOpenSettings: () => {}, onCreateAssistant: () => {}
    }))
    expect(html).toContain('还剩 3 项')
    expect(html).toContain('建立一位助手')
    expect(html).toContain('data-section="runtime"')
    expect(html).toContain('data-section="workspace"')
    expect(html).toContain('新建助手')
  })
})
