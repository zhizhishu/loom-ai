import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemberCatalogBody } from './MemberCatalog'
import {
  conflictPartners,
  conflictTools,
  highRiskToConfirm,
  isCatalogEmpty,
  presentProjectionMcp,
  selectionCounts,
  toggleWouldConflict,
  type CapabilityItem,
  type RunProjectionPreview
} from './member-catalog-model'

function item(overrides: Partial<CapabilityItem> & Pick<CapabilityItem, 'id' | 'kind' | 'name'>): CapabilityItem {
  return {
    note: '',
    source: '工具箱',
    scope: 'cloud',
    selected: false,
    origin: null,
    toolNames: [],
    risk: null,
    ...overrides
  }
}

const skills: CapabilityItem[] = [
  item({ id: 'campfire', kind: 'skill', name: 'campfire', note: '多人讨论，对照方案', selected: true, origin: 'inherited' }),
  item({ id: 'grill-duo', kind: 'skill', name: 'grill-duo', note: '两人质询一份计划', origin: 'explicit' }),
  item({ id: 'member-studio', kind: 'skill', name: 'member-studio', note: '创建队员', selected: true, origin: 'explicit' })
]

const mixed: CapabilityItem[] = [
  ...skills,
  item({ id: 'mcp-git', kind: 'mcp', name: 'git', note: '只读 git', source: '全局定义', selected: true, origin: 'explicit' }),
  item({ id: 'mcp-fs', kind: 'mcp', name: 'filesystem', note: '占用 read_file', source: '全局定义', selected: true, origin: 'explicit', toolNames: ['read_file'] }),
  item({ id: 'rule-ro', kind: 'rule', name: '只读工作区', note: '也要占用 read_file', source: '规则目录', scope: 'project', selected: true, origin: 'inherited', toolNames: ['read_file'] }),
  item({ id: 'hook-fmt', kind: 'hook', name: 'format-on-stop', note: '写进该次 CLI 设置', source: 'hook 目录', selected: true, origin: 'explicit' })
]

const preview: RunProjectionPreview = {
  agentId: 'agent_1',
  displayName: '织',
  runtime: 'codex-cli',
  bootstrap: '[SESSION_CHARTER]\n样例引导',
  mcp: { mcp_servers: { git: { command: 'git' } } },
  skills: [{ id: 'campfire', name: 'campfire', body: '多人讨论', origin: 'inherited' }],
  rules: [{ id: 'rule-ro', name: '只读工作区', body: '不要写工作区。', origin: 'inherited' }],
  hooks: [{ id: 'hook-fmt', name: 'format-on-stop', body: 'stop: format', origin: 'explicit' }]
}

function renderCatalog(overrides: Partial<Parameters<typeof MemberCatalogBody>[0]> = {}): string {
  return renderToStaticMarkup(createElement(MemberCatalogBody, {
    phase: 'ready',
    items: mixed,
    saved: mixed,
    query: '',
    identity: {
      displayName: '织',
      teamRole: '主助手',
      professionalResponsibilities: '把使命拆开',
      personalityTraits: ['短句'],
      workingPrinciples: '先写放置理由',
      growthTopic: '不发明第二套编排'
    },
    identityOpen: false,
    notice: '',
    projection: { status: 'ready', preview, message: '' },
    riskNames: [],
    saving: false,
    onQuery: () => undefined,
    onToggle: () => undefined,
    onRetry: () => undefined,
    onSave: () => undefined,
    onIdentity: () => undefined,
    onOpenProfile: () => undefined,
    onProjectionRetry: () => undefined,
    onRiskConfirm: () => undefined,
    onRiskCancel: () => undefined,
    ...overrides
  }))
}

describe('member capability catalog', () => {
  it('shows inherited and explicit choices, and blocks save while a tool name is shared', () => {
    const markup = renderCatalog()
    expect(markup).toContain('data-catalog-state="conflict"')
    expect(markup).toContain('data-origin="inherited"')
    expect(markup).toContain('data-origin="explicit"')
    expect(markup).toContain('继承')
    expect(markup).toContain('已选')
    expect(markup).toContain('全局定义')
    expect(markup).toContain('规则目录')
    expect(markup).toContain('hook 目录')
    expect(markup).toContain('disabled')
    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('data-projection-state="ready"')
    expect(markup).toContain('[SESSION_CHARTER]')
    expect(markup).toContain('不要写工作区。')
    expect(markup).toContain('下次运行生效：2 项技能，2 个 MCP')
    expect(markup).toContain('尚未接入运行：1 条规则，1 个 hook')
    expect(markup).not.toContain('下次运行生效：2 项技能，2 个 MCP，1 条规则')
    expect(markup).toContain('尚未接入运行')
    expect(markup).toContain('与 只读工作区 的 read_file 冲突')
    expect(markup).toContain('与 filesystem 的 read_file 冲突')
    expect(markup).toContain('1 处冲突')
  })

  it('keeps an unread catalog from looking unchecked', () => {
    const loading = renderCatalog({ phase: 'loading', items: [], saved: [] })
    const failed = renderCatalog({ phase: 'error', items: [], saved: [] })
    expect(loading).toContain('data-catalog-state="loading"')
    expect(loading).toContain('正在读取目录…')
    expect(loading).not.toContain('type="checkbox"')
    expect(failed).toContain('目录读取失败')
    expect(failed).toContain('不把未知画成未选中')
    expect(failed).not.toContain('type="checkbox"')
    expect(failed).toContain('重新读取')
  })

  it('shows the empty catalog without pretending skills were removed', () => {
    const unchecked: CapabilityItem[] = skills.map((entry) => ({ ...entry, selected: false, origin: null }))
    const markup = renderCatalog({
      items: unchecked,
      saved: unchecked,
      projection: { status: 'unsupported', preview: null, message: '' }
    })
    expect(markup).toContain('data-catalog-state="empty"')
    expect(markup).toContain('campfire')
    expect(markup).toContain('这个队员还没有勾选。')
    expect(markup).toContain('还没有 MCP 服务器。')
    expect(markup).toContain('还没有可勾选的规则片段。')
    expect(markup).toContain('还没有可勾选的 hook。')
    expect(markup).toContain('还不能预览运行包')
  })

  it('filters by name and source, and a new conflicting check is refused by the model', () => {
    const markup = renderCatalog({
      query: '规则目录',
      projection: { status: 'ready', preview: { ...preview, skills: [] }, message: '' }
    })
    expect(markup).toContain('只读工作区')
    expect(markup).not.toContain('id="catalog-skill-campfire"')
    expect(markup).toContain('没有匹配的条目。')
    expect(toggleWouldConflict(mixed, 'mcp', 'mcp-fs')).toBe(false)
    const quiet = mixed.map((entry) => entry.id === 'mcp-fs' ? { ...entry, selected: false, origin: null } : entry)
    expect(toggleWouldConflict(quiet, 'mcp', 'mcp-fs')).toBe(true)
    expect(conflictTools(mixed)).toEqual(['read_file'])
    expect(selectionCounts(mixed).conflicts).toBe(1)
    expect(isCatalogEmpty(skills.map((entry) => ({ ...entry, selected: false })))).toBe(true)
    expect(isCatalogEmpty(mixed)).toBe(false)
    expect(highRiskToConfirm(
      [
        item({ id: 'browser', kind: 'mcp', name: 'browser', risk: 'high', selected: true }),
        item({ id: 'hook-shell', kind: 'hook', name: 'run-format', risk: 'high', selected: true })
      ],
      [
        item({ id: 'browser', kind: 'mcp', name: 'browser', risk: 'high', selected: false }),
        item({ id: 'hook-shell', kind: 'hook', name: 'run-format', risk: 'high', selected: false })
      ]
    ).map((entry) => entry.name)).toEqual(['browser', 'run-format'])
    const filesystem = mixed.find((entry) => entry.name === 'filesystem')
    expect(filesystem && conflictPartners(mixed, filesystem)).toEqual([{ names: '只读工作区', tool: 'read_file' }])
    expect(presentProjectionMcp({
      mcp_servers: {
        local: {
          command: 'echo',
          args: ['serve', '--token', 'sk-live-secret-value', 'plain.js'],
          env: { API_KEY: 'super-secret', PLAIN: 'visible-env' }
        }
      }
    })).toEqual({
      mcp_servers: {
        local: {
          command: 'echo',
          args: ['serve', '--token', '•••', 'plain.js'],
          env: { API_KEY: '•••', PLAIN: '•••' }
        }
      }
    })
  })
})
