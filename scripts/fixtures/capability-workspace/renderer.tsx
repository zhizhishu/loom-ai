import { Activity, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeSkillsSettings, ToolboxSettings } from '../../../apps/desktop/src/renderer/src/RebuiltSkillsSettings'
import { WindowDragStrip } from '../../../apps/desktop/src/renderer/src/App'
import { maskMcpJson } from '../../../apps/desktop/src/renderer/src/McpJsonEditor'
import { McpSettings } from '../../../apps/desktop/src/renderer/src/McpSettings'
import { MemberCatalog } from '../../../apps/desktop/src/renderer/src/MemberCatalog'
import { agent, server } from './data'
import '../../../apps/desktop/src/renderer/src/styles.css'

const members = Array.from({ length: 12 }, (_, i) => agent(i))
const requests: { method: string; params: any }[] = []
let conflict = false
let configReadFailure = false
let remountMcp: () => void = () => {}
let revealWait: Promise<void> | null = null
let releaseReveal: (() => void) | undefined
const privateDefinition = JSON.stringify({
  mcpServers: {
    docs: {
      command: 'node',
      env: {
        API_TOKEN: 'fixture-env-credential',
        EMPTY: '',
        PADDED: '  info  '
      }
    }
  }
})
const privateHeader = JSON.stringify({
  mcpServers: {
    Playwright: {
      url: 'https://example.invalid/mcp',
      headers: {
        Authorization: 'Bearer fixture-header-credential',
        'X-Region': '  cn  '
      }
    }
  }
})
let failToolboxSave = false
let deleteWait: Promise<void> | null = null
let releaseDelete: (() => void) | undefined
let failDelete = false
let contentHold: { path: string; wait: Promise<void>; release: () => void } | null = null
let contentFailure: string | null = null
const longPreviewPath = 'references/project-specific-workflows/acceptance-and-review/long-file-name-long-file-name-long-file-name-checklist.md'
const previewPaths = [
  'SKILL.md', 'LICENSE', 'agents/openai.yaml', 'assets/icon.png', 'references/guide.md',
  'references/large.md', 'notes/guide.md', longPreviewPath,
  ...Array.from({ length: 4 }, (_, index) => `references/check-${index + 1}.md`)
]
const nativeSkills = ['ui-ux-pro-max', 'design-review'].map((name, index) => ({
  id: `native-${index + 1}`, name, description: '本机原生 Skill',
  entryPath: `/fixture/native/${name}/SKILL.md`, canonicalPath: `/fixture/native/${name}/SKILL.md`,
  sourceScope: 'user' as const, adapterKind: 'codex-cli' as const
}))
let toolbox = [{ name: 'member-studio', description: '创建队员', memberIds: ['agent_0'], version: '1', sourceError: null }]
let config = {
  configDigest: 'digest-1',
  servers: [
    server(),
    server({
      serverId: 'browser',
      name: 'Playwright',
      transport: 'streamable_http',
      definitionJson: maskMcpJson(privateHeader)!,
      enabled: false,
      assignedAgentIds: []
    })
  ]
}
const text =
  '---\nname: ui-ux-pro-max\ndescription: UI design guidance\n---\n\n# 界面设计与实现\n\n从已有界面出发，让每个操作清晰、直接。\n\n## 使用方式\n\n1. 理解当前页面的主要任务。\n2. 保留熟悉的视觉风格和交互。\n3. 检查键盘操作、窄窗口和深色模式。\n\n## 设计原则\n\n- 主要内容优先，低频信息按需展开。\n- 原生 Skills 保持只读。\n- 工具箱按队员配置。'
let hookReviewed = false
let hookSelected = false
let hookRevision = 'rev-1'
let catalogHold: { wait: Promise<void>; release: () => void } | null = null
let setCatalogTarget: (patch: { agentId?: string; active?: boolean; remount?: boolean }) => void = () => {}
let skillLibrary = [
  { id: 'skill-unchanged', name: 'unchanged-pack', origin: 'imported', enabled: true, lifecycleStatus: 'active', version: 1 },
  { id: 'skill-design', name: 'design-review', origin: 'imported', enabled: true, lifecycleStatus: 'active', version: 3 },
  { id: 'skill-orphan', name: 'orphan-skill', origin: 'imported', enabled: true, lifecycleStatus: 'active', version: 2 },
  { id: 'skill-official', name: 'official-thing', origin: 'official', enabled: true, lifecycleStatus: 'active', version: 1 }
]
let registeredLibraryItems: { itemId: string; name: string }[] = []
let registerFailure = false
let importCommitFailure = false
let importInspectWait: Promise<void> | null = null
let releaseImportInspect: (() => void) | undefined
function importCandidate(name: string, existing: { id: string; version: number; origin: string } | null, importAction: string) {
  return {
    name,
    description: name + ' 的说明',
    contentDigest: 'sha256:' + name,
    riskSummary: {},
    fileCount: 3,
    totalBytes: 1200,
    sourcePath: '/fixture/imports/' + name,
    existingSkillId: existing?.id ?? null,
    existingSkillVersion: existing?.version ?? null,
    existingOrigin: existing?.origin ?? null,
    importAction
  }
}
const importCandidates: Record<string, ReturnType<typeof importCandidate>[]> = {
  '/fixture/imports/skill-pack': [
    importCandidate('review-helper', null, 'create'),
    importCandidate('design-review', { id: 'skill-design', version: 3, origin: 'imported' }, 'update'),
    importCandidate('unchanged-pack', { id: 'skill-unchanged', version: 1, origin: 'imported' }, 'unchanged'),
    importCandidate('official-thing', { id: 'skill-official', version: 1, origin: 'official' }, 'official_conflict')
  ],
  '/fixture/imports/second-pack': [importCandidate('pack-two', null, 'create')],
  '/fixture/imports/third-pack': [importCandidate('pack-three', null, 'create'), importCandidate('pack-four', null, 'create')]
}
const hookBody = `hooks:
  stop:
    - command: ./scripts/format.sh
`
function hookCatalog(agentId: string) {
  return {
    agentId,
    displayName: agentId,
    teamRole: '',
    runtime: 'claude-code',
    revision: hookRevision,
    identity: { displayName: agentId, teamRole: '', professionalResponsibilities: '', personalityTraits: [], workingPrinciples: '', growthTopic: '' },
    items: [
      { id: 'member-studio', kind: 'skill', name: 'member-studio', note: '', source: '工具箱', scope: 'cloud', selected: true, origin: 'explicit', toolNames: [], risk: null },
      ...registeredLibraryItems.map(item => ({ id: item.itemId, kind: 'skill', name: item.name, note: '导入', source: '库', scope: 'cloud', selected: false, origin: null, toolNames: [], risk: null })),
      {
        id: 'guard-' + agentId,
        kind: 'hook',
        name: 'guard-' + agentId,
        note: '停止前格式化',
        source: 'hook 目录',
        scope: 'project',
        selected: hookSelected,
        origin: hookSelected ? 'explicit' : null,
        toolNames: [],
        risk: 'high',
        hookDefinition: {
          body: hookBody,
          definitionDigest: 'sha256:fixture-definition',
          reviewed: hookReviewed,
          reviewScope: {
            memberId: agentId, missionId: 'mission_1', campId: 'camp_1',
            workspaceId: 'ws_1', nodeId: 'node_1', workspaceRoot: '/fixture/repo',
            workspaceGeneration: 1, workspaceTokenDigest: 'sha256:fixture-token',
            adapterKind: 'claude-code'
          },
          scopeDigest: 'sha256:fixture-scope'
        }
      }
    ]
  }
}
Object.assign(window, {
  rovai: {
    onEvent: () => () => {},
    request: async (method: string, params: any = {}) => {
      requests.push({ method, params })
      if (method === 'mcp.servers.delete') {
        if (deleteWait) {
          await deleteWait
          deleteWait = null
        }
        if (failDelete) {
          failDelete = false
          throw new Error('删除失败，请重试。')
        }
      }
      if (method === 'nativeSkills.list') return { skills: structuredClone(nativeSkills), errors: [] }
      if (method === 'nativeSkills.read') {
        const paths = params.skillId === 'native-2' ? ['SKILL.md'] : previewPaths
        const status = params.path === 'assets/icon.png' ? 'binary'
          : params.path === 'references/large.md' ? 'too_large' : 'text'
        const result = {
          path: params.path,
          status,
          content: status !== 'text' ? null : params.skillId === 'native-2' ? '# 单文件 Skill\n\n独立的说明内容。' :
            params.path === 'SKILL.md'
              ? text +
                '\n\n' +
                Array.from(
                  { length: 24 },
                  (_, i) => '## 参考段落 ' + (i + 1) + '\n\n内容与操作位于同一工作区。'
                ).join('\n\n')
              : params.path === 'agents/openai.yaml' ? 'interface:\n  display_name: "Fixture Skill"\n' : '参考内容。',
          files: paths.map(path => ({ path, bytes: 500 }))
        }
        if (contentHold?.path === params.path) await contentHold.wait
        if (contentFailure === params.path) {
          contentFailure = null
          throw new Error('暂时无法读取该文件，请重试。')
        }
        return result
      }
      if (method === 'toolbox.list') return structuredClone(toolbox)
      if (method === 'toolbox.read') return { content: '# 创建队员\n\n先确认身份卡，再创建队员。' }
      if (method === 'toolbox.setMembers') {
        if (failToolboxSave) { failToolboxSave = false; throw new Error('暂时无法保存队员配置。') }
        const skill = toolbox.find(item => item.name === params.command.skillName)!
        if (skill.version !== params.command.expectedVersion) return { status: 'rejected', code: 'toolbox.members.conflict', payload: {} }
        skill.memberIds = params.command.memberIds
        skill.version = String(Number(skill.version) + 1)
        return { status: 'applied', payload: { version: skill.version } }
      }
      if (method === 'mcp.servers.reveal') {
        if (revealWait) {
          await revealWait
          revealWait = null
        }
        if (params.expectedConfigDigest !== config.configDigest)
          return {
            status: 'conflict',
            actualConfigDigest: config.configDigest
          }
        return {
          status: 'ok',
          serverId: params.serverId,
          configDigest: config.configDigest,
          definitionJson: params.serverId === 'browser' ? privateHeader : privateDefinition
        }
      }
      if (method === 'mcp.servers.setMembers') {
        config.servers = config.servers.map((s) =>
          s.serverId === params.serverId
            ? {
                ...s,
                enabled: params.agentIds.length > 0,
                assignedAgentIds: params.agentIds
              }
            : s
        )
      }
      if (method === 'mcp.config.get') {
        if (configReadFailure) throw new Error('暂时无法读取 MCP 配置。')
        return structuredClone(config)
      }
      if (method === 'mcp.import.scan')
        return {
          configDigest: config.configDigest,
          sources: [{ sourceKind: 'cursor', sourcePath: '/fixture/unreadable.json', status: 'invalid', candidateCount: 0, issue: null }],
          candidates: [
            ...[
            ['local-tools', 'codex'],
            ['playwright', 'claude_code'],
            ['docs', 'cursor'],
            ['research-and-documentation-server-with-a-long-name', 'opencode'],
            ['github', 'copilot'],
            ['team-search', 'antigravity']
          ].map(([name, sourceKind], index) => ({
            candidateId: `import-${index + 1}`,
            proposedName: name,
            sourceKind,
            sourcePath: '/fixture/' + sourceKind + '/mcp.json',
            compatibility: 'portable',
            conflict: name === 'docs' ? 'name_conflict' : 'none',
            normalizedDefinitionJson: JSON.stringify({
              mcpServers: { [name]: { command: 'node' } }
            }),
            issues: []
            })),
            {
              candidateId: 'local-tools-second', proposedName: 'local-tools', sourceKind: 'claude_code',
              sourcePath: '/fixture/claude/mcp.json', compatibility: 'portable', conflict: 'none',
              normalizedDefinitionJson: JSON.stringify({ mcpServers: { 'local-tools': { command: 'different-node' } } }), issues: []
            },
            {
              candidateId: 'blocked-codex', proposedName: 'botmux', sourceKind: 'codex',
              sourcePath: '/fixture/codex/config.toml', compatibility: 'unsupported', conflict: 'none',
              normalizedDefinitionJson: null,
              issues: [{ code: 'mcp.import_unknown_field', kind: 'blocker', blocking: true, field: 'env_vars', message: 'Unrecognized field env_vars blocks automatic import' }]
            },
            {
              candidateId: 'blocked-claude', proposedName: 'botmux', sourceKind: 'claude_code',
              sourcePath: '/fixture/claude.json', compatibility: 'unsupported', conflict: 'none',
              normalizedDefinitionJson: null,
              issues: ['REQUIRED', 'SOCKET'].map(suffix => ({ code: 'mcp.import_reference_unsupported', kind: 'blocker', blocking: true,
                field: 'env.BOTMUX_MCP_GATEWAY_' + suffix,
                message: '待配置：此字段使用了无法无损迁移的来源引用语法。' }))
            }
          ]
        }
      if (method === 'mcp.servers.update' && conflict) {
        conflict = false
        config.configDigest = 'external-digest'
        return { status: 'conflict', actualConfigDigest: config.configDigest }
      }
      if (method === 'mcp.servers.update' && params.expectedConfigDigest !== config.configDigest)
        return { status: 'conflict', actualConfigDigest: config.configDigest }
      if (method === 'mcp.servers.update')
        config.servers = config.servers.map((s) =>
          s.serverId === params.serverId
            ? {
                ...s,
                definitionJson: maskMcpJson(params.definitionJson) ?? params.definitionJson
              }
            : s
        )
      if (method === 'mcp.servers.setEnabled')
        config.servers = config.servers.map((s) =>
          s.serverId === params.serverId ? { ...s, enabled: params.enabled } : s
        )
      if (method === 'mcp.assignments.set')
        config.servers = config.servers.map((s) =>
          s.serverId === params.serverId
            ? {
                ...s,
                assignedAgentIds: params.assigned
                  ? [...s.assignedAgentIds, params.agentId]
                  : s.assignedAgentIds.filter((id) => id !== params.agentId)
              }
            : s
        )
      if (method === 'mcp.servers.create' || method === 'mcp.import.commit') {
        const json = params.definitionJson ?? params.selections[0].definitionJson
        config.servers.push(
          server({
            serverId: 'added-' + config.servers.length,
            name: Object.keys(JSON.parse(json).mcpServers)[0],
            definitionJson: json,
            enabled: false,
            assignedAgentIds: []
          })
        )
      }
      if (method === 'mcp.servers.delete' && params.expectedConfigDigest !== config.configDigest)
        return { status: 'conflict', actualConfigDigest: config.configDigest }
      if (method === 'mcp.servers.delete')
        config.servers = config.servers.filter((s) => s.serverId !== params.serverId)
      if (method.startsWith('mcp.')) {
        config.configDigest += '-next'
        return { status: 'ok', config: structuredClone(config) }
      }
      if (method === 'members.capabilityCatalog.get') {
        if (catalogHold) await catalogHold.wait
        return structuredClone(hookCatalog(params.agentId))
      }
      if (method === 'skills.list') return structuredClone(skillLibrary)
      if (method === 'skills.import.inspect') {
        const hold = importInspectWait
        if (hold) await hold
        return {
          stagingToken: 'staging-1',
          sourcePath: params.path,
          candidates: structuredClone(importCandidates[params.path] ?? []),
          rejectedCandidates: [{ sourcePath: params.path + '/broken', code: 'skill_missing_entry', message: '缺少 SKILL.md' }],
          expiresAt: new Date(Date.now() + 600000).toISOString()
        }
      }
      if (method === 'skills.import.commit') {
        if (importCommitFailure) { importCommitFailure = false; throw new Error('桥接中断，结果未知。') }
        const name = params.command.candidateName
        const existing = skillLibrary.find(skill => skill.name === name)
        const id = existing?.id ?? 'skill-' + name
        if (!existing) skillLibrary.push({ id, name, origin: 'imported', enabled: true, lifecycleStatus: 'active', version: 1 })
        return {
          commandId: params.commandId,
          commandType: 'skill.import.commit',
          status: 'applied',
          code: existing ? 'skill_import_updated' : 'skill_imported',
          payload: { skillId: id, revisionId: 'revision-' + id },
          resultEntity: { entityType: 'skill', entityId: id }
        }
      }
      if (method === 'members.capabilityCatalog.putItem') {
        if (registerFailure) { registerFailure = false; throw new Error('目录写入失败') }
        const skillId = String(params.itemId).replace('library:', '')
        const name = skillLibrary.find(skill => skill.id === skillId)?.name ?? skillId
        registeredLibraryItems.push({ itemId: params.itemId, name })
        return { id: params.itemId, kind: 'skill', name, toolNames: [] }
      }
      if (method === 'members.capabilityCatalog.set') {
        if (catalogHold) await catalogHold.wait
        const hook = params.selections.find((s: any) => s.kind === 'hook')
        if (hook) hookSelected = hook.selected
        if (hook?.selected && (params.reviewedHooks ?? []).length > 0) hookReviewed = true
        hookRevision = 'rev-' + (Number(hookRevision.slice(4)) + 1)
        return structuredClone(hookCatalog(params.agentId))
      }
      if (method === 'members.executionTarget.get')
        return { memberId: params.memberId, revision: 1, selection: null, availableWorkspaces: [], runtimeDescriptors: [] }
      if (method === 'members.runProjection.preview')
        return { agentId: params.member, displayName: params.member, runtime: params.runtime, bootstrap: '', mcp: {}, skills: [], rules: [], hooks: [] }
      throw new Error('Unhandled fixture method: ' + method)
    }
  }
})
function HookPage() {
  const [target, setTarget] = useState({ agentId: 'agent_0', active: true, epoch: 0 })
  setCatalogTarget = (patch) => setTarget((current) => ({
    ...current,
    ...patch,
    epoch: patch.remount ? current.epoch + 1 : current.epoch
  }))
  return <MemberCatalog key={target.epoch} agentId={target.agentId} active={target.active} onDirtyChange={() => {}} onOpenProfile={() => {}} nodes={null} />
}
function Fixture() {
  const [page, setPage] = useState<'mcp' | 'skills' | 'toolbox' | 'hook'>('skills')
  const [mcpEpoch, setMcpEpoch] = useState(0)
  remountMcp = () => setMcpEpoch(value => value + 1)
  return (
    <div className="app-shell">
      <WindowDragStrip page="settings" />
      <aside
        style={{
          gridColumn: 1,
          gridRow: '1 / -1',
          padding: '28px 18px',
          background: 'var(--rail)'
        }}
      >
        <strong>设置</strong>
        <div style={{ display: 'grid', gap: 8, marginTop: 24 }}>
          <button className="quiet-button" id="nav-skills" onClick={() => setPage('skills')}>
            Skills
          </button>
          <button className="quiet-button" id="nav-toolbox" onClick={() => setPage('toolbox')}>工具箱</button>
          <button className="quiet-button" id="nav-mcp" onClick={() => setPage('mcp')}>
            MCP
          </button>
          <button className="quiet-button" id="nav-hook" onClick={() => setPage('hook')}>hook 目录</button>
          <button className="quiet-button" id="nav-switch" onClick={() => setCatalogTarget({ agentId: 'agent_1' })}>切换队员</button>
          <button className="quiet-button" id="nav-inactive" onClick={() => setCatalogTarget({ active: false })}>切到后台</button>
        </div>
      </aside>
      <main className="content settings-content" style={{ flex: 1, minWidth: 0 }}>
        {page === 'hook' && <HookPage />}
        <div className="settings-workbench" style={page === 'hook' ? { display: 'none' } : undefined}>
          <div className={`settings-panel settings-panel-${page}`}>
            <Activity mode={page === 'skills' ? 'visible' : 'hidden'}>
              <NativeSkillsSettings />
            </Activity>
            <Activity mode={page === 'toolbox' ? 'visible' : 'hidden'}><ToolboxSettings agents={members} /></Activity>
            <Activity mode={page === 'mcp' ? 'visible' : 'hidden'}>
              <McpSettings key={mcpEpoch} agents={members} />
            </Activity>
          </div>
        </div>
      </main>
    </div>
  )
}
Object.assign(window, {
  capabilityTest: {
    // Hidden Electron windows pause rAF on Windows; settle must still finish.
    settle: () =>
      new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          setTimeout(resolve, 60)
        }
        requestAnimationFrame(() => requestAnimationFrame(finish))
        setTimeout(finish, 150)
      }),
    requests,
    resetMcp: (fail = false) => { config.servers = []; configReadFailure = fail; remountMcp() },
    restoreConfigRead: () => { configReadFailure = false },
    longPreviewPath,
    holdContent: (path: string) => {
      let release!: () => void
      const wait = new Promise<void>(resolve => { release = resolve })
      contentHold = { path, wait, release }
    },
    releaseContent: () => {
      contentHold?.release()
      contentHold = null
    },
    failContent: (path: string) => { contentFailure = path },
    holdReveal: () => {
      revealWait = new Promise((resolve) => {
        releaseReveal = resolve
      })
    },
    releaseReveal: () => releaseReveal?.(),
    failToolboxSave: () => { failToolboxSave = true },
    holdDelete: (fail = false) => {
      failDelete = fail
      deleteWait = new Promise(resolve => { releaseDelete = resolve })
    },
    releaseDelete: () => releaseDelete?.(),
    setCatalogTarget: (patch: any) => setCatalogTarget(patch),
    resetHook: (options: { reviewed?: boolean; selected?: boolean } = {}) => {
      hookReviewed = !!options.reviewed
      hookSelected = !!options.selected
      hookRevision = 'rev-1'
    },
    holdCatalog: () => {
      let release!: () => void
      const wait = new Promise<void>((resolve) => { release = resolve })
      catalogHold = { wait, release }
    },
    releaseCatalog: () => { catalogHold?.release(); catalogHold = null },
    failNextRegister: () => { registerFailure = true },
    failNextImportCommit: () => { importCommitFailure = true },
    holdImportInspect: () => {
      importInspectWait = new Promise((resolve) => { releaseImportInspect = resolve })
    },
    releaseImportInspect: () => { releaseImportInspect?.(); releaseImportInspect = undefined; importInspectWait = null },
    registeredItems: () => registeredLibraryItems.map(item => item.itemId),
    resetImport: () => {
      registeredLibraryItems = []
      registerFailure = false
      importCommitFailure = false
      importInspectWait = null
    },
    hookGetCount: () => requests.filter((request) => request.method === 'members.capabilityCatalog.get').length,
    hookSetRequests: () => requests.filter((request) => request.method === 'members.capabilityCatalog.set'),
    catalogDialogText: () => document.querySelector('[role="dialog"]')?.textContent ?? '',
    changeMcpWhileDeleting: () => {
      config.servers = config.servers.map(s => s.name === 'new-connection' ? { ...s, name: 'updated-connection' } : s)
      config.configDigest += '-external'
      window.dispatchEvent(new Event('focus'))
    },
    conflict: () => {
      conflict = true
    },
    snapshot: () => {
      const root = Array.from(document.querySelectorAll<HTMLElement>('.capability-workspace,.rebuilt-skills-columns,.member-catalog-page')).find(
        (n) => n.getBoundingClientRect().width > 0
      )!
      const rect = (selector: string) => {
        const r = root.querySelector(selector)?.getBoundingClientRect() ?? { x: 0, y: 0, width: 0, height: 0 }
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      return {
        width: root.getBoundingClientRect().width,
        list: rect('.capability-library,.rebuilt-skills-list'),
        detail: rect('.capability-detail,.rebuilt-skills-detail'),
        compact: root.dataset.compact,
        text: root.innerText,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        checkboxes: root.querySelectorAll('[type="checkbox"]').length,
        background: getComputedStyle(root).backgroundColor
      }
    }
  }
})
createRoot(document.getElementById('root')!).render(<Fixture />)
