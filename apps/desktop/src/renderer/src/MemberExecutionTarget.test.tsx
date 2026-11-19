import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExecutionNodeRecord, PermissionOptionDescriptor } from '@contracts'
import { MemberExecutionTargetPanel } from './MemberExecutionTarget'
import {
  ExecutionTargetController,
  committedModel,
  executionTargetBlock,
  executionTargetDirty,
  executionTargetDraftFromView,
  executionTargetPayload,
  executionTargetSaveFailure,
  memberTargetState,
  nodeTargetState,
  remoteNodeChoices,
  remoteDraftFromSelection,
  setTargetAdapter,
  setTargetMode,
  setTargetModelInput,
  setTargetNode,
  type ExecutionTargetReceipt,
  type ExecutionTargetSelection,
  type ExecutionTargetView
} from './member-execution-target-model'

function permission(key: string, choices: string[]): PermissionOptionDescriptor {
  return {
    key,
    label: key,
    description: '',
    valueType: 'enum',
    choices: choices.map((value) => ({ value, label: value })),
    recommendedValue: choices[0] ?? null,
    scope: 'session',
    risk: 'elevated',
    supported: true,
    required: true,
    unsupportedReason: null
  }
}

const view: ExecutionTargetView = {
  memberId: 'agent_1',
  revision: 7,
  selection: null,
  availableWorkspaces: [
    {
      nodeId: 'node_b',
      workspaceId: 'workspace_b1',
      workspaceRoot: '/srv/rovia/mission-14',
      missionId: 'mission_14',
      missionTitle: '节点通道'
    }
  ],
  runtimeDescriptors: [
    {
      adapterKind: 'claude-code-cli',
      permissionSchemaVersion: 1,
      permissionOptions: [permission('permission_mode', ['default', 'bypassPermissions'])],
      memberRuntimeDefaults: {
        adapterKind: 'claude-code-cli',
        model: { mode: 'runtime_default' },
        permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: { permission_mode: 'bypassPermissions' } }
      },
      supportsRuntimeDefaultModel: true
    },
    {
      adapterKind: 'codex-cli',
      permissionSchemaVersion: 1,
      permissionOptions: [
        permission('sandbox_mode', ['read-only', 'danger-full-access']),
        permission('approval_policy', ['untrusted', 'never'])
      ],
      memberRuntimeDefaults: {
        adapterKind: 'codex-cli',
        model: { mode: 'runtime_default' },
        permissions: {
          adapterKind: 'codex-cli',
          schemaVersion: 1,
          values: { sandbox_mode: 'danger-full-access', approval_policy: 'never' }
        }
      },
      supportsRuntimeDefaultModel: true
    }
  ]
}

const explicitSaved: ExecutionTargetSelection = {
  nodeId: 'node_b',
  workspaceId: 'workspace_b1',
  workspaceRoot: '/srv/rovia/mission-14',
  adapterKind: 'claude-code-cli',
  model: { mode: 'explicit', modelId: 'claude-sonnet-4-6', options: { effort: 'high' } },
  permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: { permission_mode: 'default' } }
}

const savedView: ExecutionTargetView = { ...view, revision: 9, selection: explicitSaved }

/** A remote-mode draft, built the way the panel's radio does it. */
function remoteDraft(source: ExecutionTargetView = view) {
  return setTargetMode(executionTargetDraftFromView(source), 'remote', source)
}

function node(overrides: Partial<ExecutionNodeRecord> & Pick<ExecutionNodeRecord, 'nodeId'>): ExecutionNodeRecord {
  return {
    displayName: overrides.nodeId,
    role: 'remote',
    revocable: true,
    status: 'online',
    os: 'linux',
    arch: 'x64',
    pairedAt: '2026-11-01T00:00:00.000Z',
    revokedAt: null,
    lastHeartbeat: '2026-11-02T00:00:00.000Z',
    activeRunCount: 0,
    activeRuns: [],
    clis: [{
      adapterKind: 'claude-code',
      path: '/usr/local/bin/claude',
      version: '2.1.241',
      pathPresent: true,
      reportedAt: '2026-11-02T00:00:00.000Z',
      availability: 'reported'
    }],
    ...overrides
  }
}

const onlineNode = node({ nodeId: 'node_b', displayName: 'desk-b' })
const offlineNode = node({ nodeId: 'node_b', displayName: 'desk-b', status: 'offline' })

function renderPanel(overrides: Partial<Parameters<typeof MemberExecutionTargetPanel>[0]> = {}): string {
  return renderToStaticMarkup(createElement(MemberExecutionTargetPanel, {
    phase: 'ready',
    view: savedView,
    draft: executionTargetDraftFromView(savedView),
    nodeRecords: [onlineNode],
    nodesError: '',
    nodesAvailable: true,
    notice: { kind: 'none' },
    saving: false,
    unknown: false,
    onMode: () => undefined,
    onNode: () => undefined,
    onWorkspace: () => undefined,
    onAdapter: () => undefined,
    onModelInput: () => undefined,
    onPermission: () => undefined,
    onReload: () => undefined,
    onUseServer: () => undefined,
    onSave: () => undefined,
    ...overrides
  }))
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

/** Lets the controller observe a settled promise. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function harness() {
  const gets: Array<{ memberId: string; answer: ReturnType<typeof deferred<ExecutionTargetView>> }> = []
  const saves: Array<{
    input: { memberId: string; expectedRevision: number; selection: ExecutionTargetSelection | null }
    answer: ReturnType<typeof deferred<ExecutionTargetReceipt>>
  }> = []
  const controller = new ExecutionTargetController({
    get: (memberId) => {
      const answer = deferred<ExecutionTargetView>()
      gets.push({ memberId, answer })
      return answer.promise
    },
    save: (input) => {
      const answer = deferred<ExecutionTargetReceipt>()
      saves.push({ input, answer })
      return answer.promise
    }
  })
  const state = () => controller.getState()
  const member = (memberId: string) => memberTargetState(controller.getState(), memberId)
  return { controller, gets, saves, state, member }
}

describe('run target draft', () => {
  it('keeps the server explicit options until the model ID itself changes', () => {
    const draft = executionTargetDraftFromView(savedView)
    expect(executionTargetDirty(draft, savedView.selection)).toBe(false)
    // Opening and saving an untouched target must not rewrite the options.
    expect(executionTargetPayload(draft)).toEqual({ selection: explicitSaved })
    expect(draft.remote && committedModel(draft.remote)).toEqual(explicitSaved.model)

    const retyped = setTargetModelInput(draft, ' claude-sonnet-4-6 ')
    expect(executionTargetPayload(retyped)).toEqual({ selection: explicitSaved })
    expect(executionTargetDirty(retyped, savedView.selection)).toBe(false)

    const changed = setTargetModelInput(draft, 'claude-opus-4-6')
    expect(executionTargetDirty(changed, savedView.selection)).toBe(true)
    expect(executionTargetPayload(changed)?.selection?.model).toEqual({
      mode: 'explicit',
      modelId: 'claude-opus-4-6',
      options: {}
    })
  })

  it('drops a legacy dshSource from the closed remote selection', () => {
    const legacy = {
      ...explicitSaved,
      model: { mode: 'explicit', modelId: 'claude-sonnet-4-6', options: { effort: 'high' }, dshSource: 'native' }
    } as ExecutionTargetSelection
    const legacyView: ExecutionTargetView = { ...view, selection: legacy }
    const draft = executionTargetDraftFromView(legacyView)
    const payload = executionTargetPayload(draft)
    expect(payload).toEqual({ selection: explicitSaved })
    expect(JSON.stringify(payload)).not.toContain('dshSource')
    // The stripped field is not treated as an unsaved edit.
    expect(executionTargetDirty(draft, legacy)).toBe(false)
  })

  it('treats unsaved targets as dirty and only sends the target fields', () => {
    expect(executionTargetDirty(executionTargetDraftFromView(view), null)).toBe(false)
    const remote = remoteDraft(view)
    expect(executionTargetDirty(remote, null)).toBe(true)
    expect(executionTargetDirty(setTargetModelInput(remote, 'typed-but-not-saved'), null)).toBe(true)
    // Applying a Runtime selection is independent of the saved capability catalog.
    expect(Object.keys(executionTargetPayload(remote)!.selection!).sort()).toEqual([
      'adapterKind', 'model', 'nodeId', 'permissions', 'workspaceId', 'workspaceRoot'
    ])
    expect(executionTargetPayload(executionTargetDraftFromView(view))).toEqual({ selection: null })
  })

  it('keeps a same-adapter choice and starts another adapter from Core defaults', () => {
    const draft = executionTargetDraftFromView(savedView)
    const codex = setTargetAdapter(draft, 'codex-cli', savedView)
    expect(codex.remote?.adapterKind).toBe('codex-cli')
    expect(codex.remote?.modelInput).toBe('')
    expect(codex.remote?.permissions.values).toEqual({
      sandbox_mode: 'danger-full-access',
      approval_policy: 'never'
    })
    expect(executionTargetDirty(codex, savedView.selection)).toBe(true)

    const back = setTargetAdapter(codex, 'claude-code-cli', savedView)
    expect(back.remote?.model).toEqual(explicitSaved.model)
    expect(back.remote?.permissions.values).toEqual(explicitSaved.permissions.values)
    expect(executionTargetDirty(back, savedView.selection)).toBe(false)
  })
})

describe('remote node and workspace facts', () => {
  it('reports online, offline, revoked and CLI-less nodes without inventing installs', () => {
    expect(nodeTargetState(onlineNode, 'claude-code-cli')).toBe('ready')
    expect(nodeTargetState(offlineNode, 'claude-code-cli')).toBe('offline')
    expect(nodeTargetState(node({ nodeId: 'node_c', revokedAt: '2026-11-02T00:00:00.000Z' }), 'claude-code-cli')).toBe('revoked')
    expect(nodeTargetState(node({ nodeId: 'node_d', clis: [] }), 'codex-cli')).toBe('missing-cli')
    expect(nodeTargetState(node({
      nodeId: 'node_e',
      clis: [{
        adapterKind: 'codex-cli', path: '/usr/bin/codex', version: null, pathPresent: false,
        reportedAt: '2026-11-02T00:00:00.000Z', availability: 'path_missing'
      }]
    }), 'codex-cli')).toBe('missing-cli')
  })

  it('lets an offline node hold a configured target while keeping revoked and CLI-less rows unselectable', () => {
    const choices = remoteNodeChoices([offlineNode, node({
      nodeId: 'node_c', displayName: 'old', revokedAt: '2026-11-02T00:00:00.000Z'
    })], 'claude-code-cli', 'node_b')
    expect(choices.map((choice) => [choice.node.nodeId, choice.state, choice.selectable])).toEqual([
      ['node_b', 'offline', true],
      ['node_c', 'revoked', false]
    ])
    // The local node is never a remote target.
    expect(remoteNodeChoices([node({ nodeId: 'node_a', role: 'local' })], 'claude-code-cli', 'node_a')).toEqual([])

    const draft = setTargetNode(remoteDraft(view), 'node_b', view)
    expect(executionTargetBlock(draft, view, [offlineNode])).toBe('')
  })

  it('asks for a prepared mission workspace instead of accepting a hand-written path', () => {
    const empty: ExecutionTargetView = { ...view, availableWorkspaces: [] }
    const draft = executionTargetDraftFromView(empty)
    expect(draft.mode).toBe('local')
    expect(draft.remote?.workspaceId).toBe('')
    expect(draft.remote?.workspaceRoot).toBe('')
    expect(executionTargetBlock(setTargetMode(draft, 'remote', empty), empty, [onlineNode])).toBe('no-workspace')
    expect(executionTargetBlock(remoteDraft(view), view, [onlineNode])).toBe('')

    const markup = renderPanel({
      view: { ...empty, selection: null },
      draft: setTargetMode(draft, 'remote', empty),
      nodeRecords: [onlineNode]
    })
    expect(markup).toContain('先准备使命工作区')
    expect(markup).toContain('这里不填工作区 ID 或路径')
    expect(markup).not.toContain('工作区</span>')
  })

  it('cannot confirm a brand-new node while the node list is unreadable', () => {
    expect(executionTargetBlock(remoteDraft(view), view, null)).toBe('node-unknown')
    expect(executionTargetBlock(executionTargetDraftFromView(savedView), savedView, null)).toBe('')
  })
})

describe('run target save outcomes', () => {
  it('keeps a draft on conflict and never infers success from an unknown outcome', () => {
    expect(executionTargetSaveFailure({ code: 'remote_target_revision_conflict' })).toEqual({
      kind: 'conflict', code: 'remote_target_revision_conflict'
    })
    expect(executionTargetSaveFailure({ code: 'remote_target_storage_unavailable' })).toEqual({
      kind: 'unknown', code: 'remote_target_storage_unavailable'
    })
    expect(executionTargetSaveFailure(new Error('socket hang up'))).toEqual({ kind: 'unknown', code: '' })
    expect(executionTargetSaveFailure({ code: 'remote_catalog_program_unavailable' })).toEqual({
      kind: 'rejected', code: 'remote_catalog_program_unavailable'
    })
    expect(executionTargetSaveFailure({ code: 'remote_target_workspace_unavailable' }).kind).toBe('rejected')
  })
})

describe('run target controller', () => {
  it('keeps a draft edited while a read is still in flight', async () => {
    const h = harness()
    h.controller.select('agent_1')
    h.controller.load()
    h.gets[0].answer.resolve(view)
    await flush()
    expect(h.member('agent_1')?.draft?.mode).toBe('local')

    // A refresh starts, then the user edits before the answer arrives.
    h.controller.load()
    const edited = setTargetModelInput(remoteDraft(view), 'typed-during-refresh')
    h.controller.edit(edited)
    h.gets[1].answer.resolve(view)
    await flush()

    const member = h.member('agent_1')
    expect(member?.draft).toEqual(edited)
    expect(member?.dirty).toBe(true)
    expect(member?.phase).toBe('ready')
  })

  it('accepts a changed server target when there are no unsaved edits', async () => {
    const h = harness()
    h.controller.select('agent_1')
    h.controller.load()
    h.gets[0].answer.resolve(view)
    await flush()
    expect(h.member('agent_1')?.dirty).toBe(false)

    h.controller.load()
    h.gets[1].answer.resolve(savedView)
    await flush()

    const member = h.member('agent_1')
    expect(member?.view?.selection).toEqual(explicitSaved)
    expect(member?.draft?.mode).toBe('remote')
    expect(member?.dirty).toBe(false)
  })

  it('keeps pending edits dirty and protected when the read fails', async () => {
    const h = harness()
    h.controller.select('agent_1')
    h.controller.load()
    h.gets[0].answer.reject({ code: 'nodes_unavailable' })
    await flush()
    // A first read that never succeeded has no view to show at all.
    expect(h.member('agent_1')?.phase).toBe('error')
    expect(h.member('agent_1')?.view).toBeNull()
    expect(h.member('agent_1')?.draft).toBeNull()

    h.controller.load()
    h.gets[1].answer.resolve(view)
    await flush()
    const edited = setTargetModelInput(remoteDraft(view), 'typed')
    h.controller.edit(edited)

    h.controller.load()
    h.gets[2].answer.reject({ code: 'nodes_unavailable' })
    await flush()

    const member = h.member('agent_1')
    // The last good view stays editable and the edit keeps protecting the leave guard.
    expect(member?.phase).toBe('ready')
    expect(member?.notice).toEqual({ kind: 'read-failed' })
    expect(member?.dirty).toBe(true)
    expect(member?.draft).toEqual(edited)
  })

  it('applies a save result to the member that issued it, not to the member shown now', async () => {
    const h = harness()
    h.controller.select('agent_1')
    h.controller.load()
    h.gets[0].answer.resolve(view)
    await flush()
    h.controller.edit(setTargetModelInput(remoteDraft(view), 'typed'))
    const pending = h.controller.save()
    expect(h.saves).toHaveLength(1)
    expect(h.saves[0].input.expectedRevision).toBe(7)

    const otherView: ExecutionTargetView = { ...view, memberId: 'agent_2', revision: 2 }
    h.controller.select('agent_2')
    h.controller.load()
    h.gets[1].answer.resolve(otherView)
    await flush()

    h.saves[0].answer.resolve({
      memberId: 'agent_1',
      revision: 8,
      selection: executionTargetPayload(h.member('agent_1')!.draft!)!.selection
    })
    await pending

    expect(h.state().memberId).toBe('agent_2')
    expect(h.member('agent_1')?.view?.revision).toBe(8)
    expect(h.member('agent_1')?.notice.kind).toBe('saved')
    expect(h.member('agent_1')?.dirty).toBe(false)
    expect(h.member('agent_2')?.notice.kind).toBe('none')
    expect(h.member('agent_2')?.view?.revision).toBe(2)
    expect(h.member('agent_2')?.saving).toBe(false)
  })

  it('does not unlock a conflict or unknown outcome without a fresh read', async () => {
    const h = harness()
    h.controller.select('agent_1')
    h.controller.load()
    h.gets[0].answer.resolve(view)
    await flush()
    const edited = setTargetModelInput(remoteDraft(view), 'typed')
    h.controller.edit(edited)

    // This read began BEFORE saving, so its delayed response must not count as
    // the mandatory fresh read after an unknown save outcome.
    h.controller.load()
    const pending = h.controller.save()
    h.saves[0].answer.reject(new Error('socket hang up'))
    await pending

    expect(h.member('agent_1')?.unknown).toBe(true)
    expect(h.member('agent_1')?.draft).toEqual(edited)
    expect(h.controller.useServer()).toBe(false)
    expect(h.controller.beginSave()).toBeNull()
    expect(h.member('agent_1')?.draft).toEqual(edited)
    expect(h.saves).toHaveLength(1)

    h.gets[1].answer.resolve(view)
    await flush()
    expect(h.member('agent_1')?.unknown).toBe(true)
    expect(h.member('agent_1')?.draft).toEqual(edited)
    expect(h.controller.beginSave()).toBeNull()

    h.controller.load()
    h.gets[2].answer.resolve(savedView)
    await flush()
    expect(h.member('agent_1')?.unknown).toBe(false)
    // Still not submitted automatically; the typed draft is compared to the new truth.
    expect(h.saves).toHaveLength(1)
    expect(h.member('agent_1')?.draft).toEqual(edited)
    expect(h.member('agent_1')?.dirty).toBe(true)
  })

  it('sends one request when save is submitted twice in the same tick', async () => {
    const h = harness()
    h.controller.select('agent_1')
    h.controller.load()
    h.gets[0].answer.resolve(view)
    await flush()
    h.controller.edit(setTargetModelInput(remoteDraft(view), 'typed'))

    void h.controller.save()
    void h.controller.save()
    void h.controller.save()
    await flush()

    expect(h.saves).toHaveLength(1)
    expect(h.member('agent_1')?.saving).toBe(true)
    // A read cannot race a save that is already in flight.
    expect(h.controller.load()).toBe(false)
  })

  it('refuses a reset while a save is in flight and keeps clean state after reload', async () => {
    const h = harness()
    h.controller.select('agent_1')
    h.controller.load()
    h.gets[0].answer.resolve(savedView)
    await flush()
    expect(h.member('agent_1')?.dirty).toBe(false)

    // A clean member re-reads to the newest truth instead of keeping an old draft.
    h.controller.load()
    h.gets[1].answer.resolve({ ...savedView, revision: 10 })
    await flush()
    expect(h.member('agent_1')?.dirty).toBe(false)
    expect(h.member('agent_1')?.view?.revision).toBe(10)

    h.controller.edit(setTargetModelInput(executionTargetDraftFromView(savedView), 'typed'))
    void h.controller.save()
    expect(h.controller.useServer()).toBe(false)
    expect(h.member('agent_1')?.draft).not.toBeNull()
  })
})

describe('run target panel', () => {
  it('never draws a failed read as the local target', () => {
    const markup = renderPanel({ phase: 'error', view: null, draft: null })
    expect(markup).toContain('data-target-state="error"')
    expect(markup).toContain('运行位置读取失败')
    expect(markup).not.toContain('type="radio"')
    expect(markup).not.toContain('保存运行位置')
  })

  it('disables the target save while a re-read is required', () => {
    const dirty = setTargetModelInput(executionTargetDraftFromView(savedView), 'claude-opus-4-6')
    const ready = renderPanel({ draft: dirty })
    expect(ready).toContain('保存运行位置')
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>保存运行位置/)

    const fenced = renderPanel({ draft: dirty, unknown: true, notice: { kind: 'unknown' } })
    expect(fenced).toContain('先重新读取，再决定要不要保存。')
    expect(fenced).toMatch(/<button[^>]*disabled=""[^>]*>保存运行位置/)
    // The reset action is fenced too, so it cannot unlock saving on its own.
    expect(fenced).toMatch(/<button[^>]*disabled=""[^>]*>使用服务器配置/)
  })

  it('shows offline and CLI-less facts and offers the server configuration', () => {
    const dirty = setTargetModelInput(executionTargetDraftFromView(savedView), 'claude-opus-4-6')
    const offline = renderPanel({ draft: dirty, nodeRecords: [offlineNode] })
    expect(offline).toContain('节点离线，暂不能启动；上线后可启动。')
    expect(offline).toContain('使用服务器配置')
    expect(offline).toContain('会丢掉这里未保存的草稿')

    const noCli = renderPanel({ nodeRecords: [node({ nodeId: 'node_b', displayName: 'desk-b', clis: [] })] })
    expect(noCli).toContain('这台节点还没有上报')
    expect(noCli).not.toContain('已安装')
  })

  it('offers only runtime_default and an explicit model ID, with native permission descriptors', () => {
    const markup = renderPanel()
    expect(markup).toContain('claude-sonnet-4-6')
    expect(markup).toContain('权限模式')
    expect(markup).toContain('当前：desk-b')
    expect(markup).toContain('远端节点')
    expect(markup).toContain('本地')
    expect(markup).not.toContain('已安装')
    expect(markup).not.toContain('已探测')
    const defaults = executionTargetDraftFromView(view)
    expect(defaults.remote && committedModel(defaults.remote)).toEqual({ mode: 'runtime_default' })
  })
})

describe('saved target round trip', () => {
  it('rebuilds a draft from any stored selection without dropping values', () => {
    const remote = remoteDraftFromSelection(explicitSaved)
    expect(remote.modelInput).toBe('claude-sonnet-4-6')
    expect(remote.workspaceRoot).toBe('/srv/rovia/mission-14')
    expect(executionTargetPayload({ mode: 'remote', remote })?.selection).toEqual(explicitSaved)
  })
})
