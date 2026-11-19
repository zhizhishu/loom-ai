import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CapabilityItem, HookReviewScope } from '../member-catalog-model'
import { selectRefusal } from '../member-catalog-model'
import { CapabilityRow, hookScopeHint, refusalMessage } from './CapabilityPanel'

const scope: HookReviewScope = {
  memberId: 'agent_1',
  missionId: 'mission_1',
  campId: 'camp_1',
  workspaceId: 'ws_1',
  nodeId: 'node_1',
  workspaceRoot: '/srv/repo',
  workspaceGeneration: 3,
  workspaceTokenDigest: 'sha256:token',
  adapterKind: 'pi'
}

function hook(over: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    id: 'guard',
    kind: 'hook',
    name: 'guard',
    note: '',
    source: 'hook 目录',
    scope: 'project',
    selected: false,
    origin: 'explicit',
    toolNames: [],
    risk: 'high',
    hookDefinition: {
      body: 'stop: npm run lint',
      definitionDigest: 'sha256:def-guard',
      reviewed: true,
      reviewScope: scope,
      scopeDigest: 'sha256:scope-guard'
    },
    ...over
  }
}

function row(item: CapabilityItem): string {
  return renderToStaticMarkup(createElement(CapabilityRow, {
    item,
    icon: 'branch',
    saving: false,
    refusal: selectRefusal(item),
    onToggle: () => {}
  }))
}

describe('hook rows without a Core-owned definition', () => {
  it('says it cannot be enabled now, without claiming it is never supported', () => {
    const html = row(hook({ hookDefinition: null }))
    expect(html).toContain('当前运行范围没有可审阅的 Hook 定义，暂不能启用')
    expect(html).toContain('disabled=""')
    expect(html).toContain('title="当前运行范围没有可审阅的 Hook 定义，暂不能启用"')
    expect(html).not.toMatch(/永不支持|永远不支持/)
  })

  it('keeps an already selected hook cancellable and explains the real state', () => {
    const html = row(hook({ hookDefinition: null, selected: true }))
    expect(html).toContain('当前运行范围没有可执行的 Hook 配置；可取消选择')
    expect(html).toContain('aria-checked="true"')
    expect(html).not.toContain('disabled=""')
    expect(selectRefusal(hook({ hookDefinition: null, selected: true }))).toBe('')
  })

  it('leaves a hook with the complete Core definition enabled and inspectable', () => {
    const html = row(hook())
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('暂不能启用')
    expect(html).toContain('查看 Hook 正文和范围')
    expect(html).toContain('stop: npm run lint')
    expect(html).toContain('/srv/repo')
  })

  it('still keeps the existing source failure wording and its own gate', () => {
    const html = row(hook({ hookDefinition: null, sourceError: '来源已删除' }))
    expect(html).toContain('来源不可用')
    expect(html).toContain('disabled=""')
    expect(html).toContain('title="这个能力的来源当前不可用，请先重新读取。"')
  })

  it('never puts the hook-scope wording on a non-hook row', () => {
    const skill: CapabilityItem = { ...hook({ hookDefinition: null }), kind: 'skill', id: 'lint-skill' }
    expect(hookScopeHint(skill)).toBe('')
    expect(selectRefusal(skill)).toBe('')
    expect(row(skill)).not.toContain('暂不能启用')
    expect(row(skill)).not.toContain('disabled=""')
  })

  it('maps each refusal to its own sentence', () => {
    expect(refusalMessage('')).toBe('')
    expect(refusalMessage('source')).toBe('这个能力的来源当前不可用，请先重新读取。')
    expect(refusalMessage('hook-scope')).toBe('当前运行范围没有可审阅的 Hook 定义，暂不能启用')
  })
})
