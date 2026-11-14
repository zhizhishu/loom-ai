import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ExecutionNodeRecord } from '@contracts'
import { NODE_LIST_POLL_MS, nodeErrorCode, type NodeApi } from './nodes-api'
import { useThreadClient } from './camp-client'
import { uiAttribute, useUiText } from './interface-language'
import { adapterLabel } from './runtime-products'
import { PermissionSelectField } from './MemberRuntimeParameters'
import {
  ExecutionTargetController,
  descriptorFor,
  executionTargetBlock,
  executionTargetDirty,
  executionTargetPayload,
  memberTargetState,
  remoteNodeChoices,
  setTargetAdapter,
  setTargetMode,
  setTargetModelInput,
  setTargetNode,
  setTargetPermission,
  setTargetWorkspace,
  workspaceChoices,
  type ExecutionTargetAdapterKind,
  type ExecutionTargetBlock,
  type ExecutionTargetDraft,
  type ExecutionTargetReceipt,
  type ExecutionTargetState,
  type ExecutionTargetView,
  type NodeTargetState,
  type TargetNotice
} from './member-execution-target-model'
import './member-catalog.css'

/** Product terms already used by the local member Runtime form; keys are descriptor-native. */
const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'codex-cli:sandbox_mode': '文件系统访问',
  'codex-cli:approval_policy': '审批策略',
  'claude-code-cli:permission_mode': '权限模式'
}

type Translate = (text: string, ...values: Array<string | number>) => string

function permissionLabel(t: Translate, adapterKind: ExecutionTargetAdapterKind, key: string, fallback: string): string {
  return t(PERMISSION_LABELS[`${adapterKind}:${key}`] ?? fallback)
}

function saveRejectionCopy(t: Translate, code: string): string {
  if (code === 'remote_target_workspace_unavailable') return t('这个工作区不在准备就绪状态，Core 拒绝了这次保存。')
  if (code === 'remote_target_workspace_changed') return t('这个工作区准备之后又被改过，已不能直接用。')
  if (code === 'remote_catalog_program_unavailable') return t('这台节点现在没有可启动的这个智能体 CLI。')
  if (code === 'remote_catalog_node_revoked') return t('这台节点已作废。')
  if (code === 'remote_catalog_target_changed') return t('这台节点上报的 CLI 记录变了，请重新读取后再选。')
  if (code.startsWith('remote_catalog_')) return t('这台节点上报的 CLI 记录还不能用来启动。')
  if (code === 'remote_target_member_unavailable') return t('这位队员现在不能保存运行位置。')
  if (code === 'remote_target_permissions'
    || code === 'remote_target_model'
    || code === 'remote_target_runtime_configuration_invalid') {
    return t('所选模型或权限不被这个智能体类型接受。')
  }
  if (code === 'renderer_core_method_unsupported') return t('这份 App 还没有开放运行位置的读写接口。')
  return t('运行位置没有保存。草稿留着，可以直接再存一次。')
}

function noticeCopy(t: Translate, notice: TargetNotice): string {
  if (notice.kind === 'saved') return t('运行位置已保存。')
  if (notice.kind === 'read-failed') return t('这次没有读到最新的运行位置，显示的是上次读到的结果。')
  if (notice.kind === 'conflict') return t('别人刚改过这位队员的运行位置。这里的草稿留着，先重新读取，再决定要不要保存。')
  if (notice.kind === 'unknown') return t('上次保存的结果不明。先重新读取，再决定要不要重存；这里不会自动重发。')
  if (notice.kind === 'rejected') return saveRejectionCopy(t, notice.code)
  return ''
}

export function MemberExecutionTargetPanel({
  phase,
  view,
  draft,
  nodeRecords,
  nodesError,
  nodesAvailable,
  notice,
  saving,
  unknown,
  onMode,
  onNode,
  onWorkspace,
  onAdapter,
  onModelInput,
  onPermission,
  onReload,
  onUseServer,
  onSave
}: {
  phase: 'loading' | 'error' | 'ready'
  view: ExecutionTargetView | null
  draft: ExecutionTargetDraft | null
  nodeRecords: readonly ExecutionNodeRecord[] | null
  nodesError: string
  /** The host exposed the node channel at all. Absence is not "offline". */
  nodesAvailable: boolean
  notice: TargetNotice
  saving: boolean
  /** A conflict or an unknown outcome: only a fresh read unlocks saving. */
  unknown: boolean
  onMode(mode: 'local' | 'remote'): void
  onNode(nodeId: string): void
  onWorkspace(workspaceId: string): void
  onAdapter(adapterKind: ExecutionTargetAdapterKind): void
  onModelInput(text: string): void
  onPermission(key: string, value: string): void
  onReload(): void
  onUseServer(): void
  onSave(): void
}): React.JSX.Element {
  const t = useUiText()
  const ids = useId()
  const remote = draft?.remote ?? null
  const descriptor = remote ? descriptorFor(view, remote.adapterKind) : null
  const choices = remote ? remoteNodeChoices(nodeRecords ?? [], remote.adapterKind, remote.nodeId) : []
  const selectedNode = choices.find((choice) => choice.node.nodeId === remote?.nodeId) ?? null
  const selectedNodeState: NodeTargetState | null = selectedNode?.state ?? null
  const workspaces = remote ? workspaceChoices(view, remote.nodeId) : []
  const draftWorkspaceListed = Boolean(remote && workspaces.some((workspace) => workspace.workspaceId === remote.workspaceId))
  const block: ExecutionTargetBlock = draft ? executionTargetBlock(draft, view, nodeRecords) : 'read-error'
  const dirty = Boolean(draft && view && executionTargetDirty(draft, view.selection))
  const payload = draft ? executionTargetPayload(draft) : null
  const canSave = phase === 'ready' && !saving && !unknown && dirty && block === '' && payload !== null
  const savedSelection = view?.selection ?? null
  const savedNodeName = savedSelection
    ? nodeRecords?.find((node) => node.nodeId === savedSelection.nodeId)?.displayName ?? savedSelection.nodeId
    : ''
  const summary = view
    ? savedSelection
      ? t('当前：{0} · {1} · {2}', savedNodeName, adapterLabel(savedSelection.adapterKind), savedSelection.workspaceId)
      : t('当前：本地运行')
    : ''
  const message = noticeCopy(t, notice)

  return <section className="member-execution-target" aria-label={uiAttribute('运行位置')} data-target-state={phase}>
    <header className="member-execution-target-heading">
      <h3>{t('运行位置')}</h3>
      {phase === 'ready' && summary && <p className="member-target-summary">{summary}</p>}
    </header>
    <p className="member-catalog-hint">{t('这位队员在哪台机器上跑。它和下面的勾选分开保存。')}</p>

    {phase === 'loading' && <p className="member-target-hint" role="status">{t('正在读取运行位置…')}</p>}

    {phase === 'error' && <div className="member-catalog-banner is-error" role="alert">
      <strong>{t('运行位置读取失败')}</strong>
      {' '}{t('读不到的时候不会把这位队员画成本地运行。')}
      {' '}
      <button className="quiet-button" type="button" disabled={saving} onClick={onReload}>{t('重新读取')}</button>
    </div>}

    {phase === 'ready' && draft && <>
      <div className="member-target-modes" role="radiogroup" aria-label={uiAttribute('运行位置')}>
        <label className="member-target-mode">
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={draft.mode === 'local'}
            disabled={saving}
            onChange={() => onMode('local')}
          />
          <span>
            <strong>{t('本地')}</strong>
            <small>{t('在这份 Core 所在的机器上跑。')}</small>
          </span>
        </label>
        <label className="member-target-mode">
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={draft.mode === 'remote'}
            disabled={saving || !draft.remote}
            onChange={() => onMode('remote')}
          />
          <span>
            <strong>{t('远端节点')}</strong>
            <small>{t('用那台机器上已准备的工作区和它自己上报的 CLI。')}</small>
          </span>
        </label>
      </div>

      {draft.mode === 'remote' && remote && <div className="member-target-fields">
        <label className="member-target-field">
          <span>{t('选择节点')}</span>
          <select
            value={remote.nodeId}
            disabled={saving || nodeRecords === null}
            onChange={(event) => onNode(event.target.value)}
          >
            {remote.nodeId && !choices.some((choice) => choice.node.nodeId === remote.nodeId)
              && <option value={remote.nodeId}>{remote.nodeId}</option>}
            {choices.map((choice) => <option key={choice.node.nodeId} value={choice.node.nodeId} disabled={!choice.selectable}>
              {choice.node.displayName}
            </option>)}
          </select>
        </label>
        {!nodesAvailable && <p className="member-target-hint" role="status">
          {t('这份 App 没有节点通道，读不到节点列表。')}
        </p>}
        {nodesAvailable && nodeRecords === null && <p className="member-target-hint" role="status">
          {nodesError
            ? t('节点列表读不到，先重新读取。')
            : t('正在读取节点…')}
        </p>}
        {nodesError && nodeRecords !== null && <p className="member-target-hint" role="status">
          {t('节点列表这次没读到，下面是上次成功的结果。')}
        </p>}
        {selectedNode && selectedNodeState === 'offline' && <p className="member-target-hint">
          {t('节点离线，暂不能启动；上线后可启动。')}
        </p>}
        {selectedNode && selectedNodeState === 'revoked' && <p className="member-catalog-banner is-error" role="status">
          {t('这台节点已作废，不会再启动。')}
        </p>}
        {selectedNode && selectedNodeState === 'missing-cli' && <p className="member-catalog-banner is-error" role="status">
          {t('这台节点还没有上报 {0}。', adapterLabel(remote.adapterKind))}
        </p>}

        {workspaces.length === 0
          ? <p className="member-catalog-banner" role="status">
            <strong>{t('先准备使命工作区')}</strong>
            {' '}{t('这台节点还没有已准备好的使命工作区。工作区准备好之后再回来选，这里不填工作区 ID 或路径。')}
          </p>
          : <label className="member-target-field">
            <span>{t('工作区')}</span>
            <select value={remote.workspaceId} disabled={saving} onChange={(event) => onWorkspace(event.target.value)}>
              {remote.workspaceId === '' && <option value="">{t('请选择')}</option>}
              {remote.workspaceId !== '' && !draftWorkspaceListed
                && <option value={remote.workspaceId}>{remote.workspaceId}</option>}
              {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.missionTitle}
              </option>)}
            </select>
          </label>}
        {remote.workspaceId && <p className="member-target-hint member-target-mono">{remote.workspaceRoot}</p>}
        {remote.workspaceId && !draftWorkspaceListed && workspaces.length > 0 && <p className="member-catalog-banner" role="status">
          {t('这个工作区已不在就绪列表。')}
        </p>}

        <label className="member-target-field">
          <span>{t('智能体类型')}</span>
          <select value={remote.adapterKind} disabled={saving} onChange={(event) => onAdapter(event.target.value as ExecutionTargetAdapterKind)}>
            {(view?.runtimeDescriptors ?? []).map((entry) => <option key={entry.adapterKind} value={entry.adapterKind}>
              {adapterLabel(entry.adapterKind)}
            </option>)}
          </select>
        </label>

        <label className="member-target-field">
          <span>{t('模型')}</span>
          <input
            type="text"
            value={remote.modelInput}
            placeholder={t('默认')}
            disabled={saving}
            onChange={(event) => onModelInput(event.target.value)}
          />
        </label>
        <p className="member-target-hint">
          {remote.modelInput.trim() === ''
            ? t('留空使用默认模型。')
            : t('使用输入的模型 ID。')}
        </p>

        {descriptor && descriptor.permissionOptions.filter((option) => option.supported && option.choices.length > 0).map((option) => (
          <PermissionSelectField
            key={option.key}
            permissionOptions={descriptor.permissionOptions}
            values={remote.permissions.values}
            recommendedValues={descriptor.memberRuntimeDefaults.permissions.values}
            disabled={saving}
            fieldKey={option.key}
            label={permissionLabel(t, remote.adapterKind, option.key, option.label)}
            onChange={onPermission}
          />
        ))}
      </div>}

      {message && <p className={notice.kind === 'saved' ? 'member-catalog-banner' : 'member-catalog-banner is-error'} role="status">
        {message}
      </p>}
      <footer className="member-target-actions">
        <p>
          {block === 'no-workspace' && t('先准备使命工作区，再来这里选节点。')}
          {block === 'workspace-required' && t('选一个已准备的使命工作区。')}
          {block === 'adapter-required' && t('这份 Core 没有给这个智能体类型的原生权限定义。')}
          {block === 'node-unknown' && t('节点列表读不到，不能确认新选的节点。')}
          {block === 'read-error' && t('先读到运行位置，才能保存。')}
          {unknown && t('先重新读取，再决定要不要保存。')}
        </p>
        <button className="quiet-button" type="button" disabled={saving} onClick={onReload}>{t('重新读取')}</button>
        {dirty && <button
          className="quiet-button"
          type="button"
          disabled={saving || unknown}
          onClick={onUseServer}
        >{t('使用服务器配置')}</button>}
        {dirty && <span className="member-target-hint">{t('「使用服务器配置」会丢掉这里未保存的草稿。')}</span>}
        <button
          className="primary-button"
          type="button"
          disabled={!canSave}
          onClick={onSave}
        >{saving ? t('正在保存…') : t('保存运行位置')}</button>
      </footer>
    </>}
  </section>
}

export function MemberExecutionTarget({
  memberId,
  active,
  nodes,
  onDirtyChange,
  onFactsChanged
}: {
  memberId: string
  active: boolean
  nodes: NodeApi | null
  onDirtyChange(dirty: boolean): void
  onFactsChanged?(): void
}): React.JSX.Element {
  const client = useThreadClient()
  const controller = useMemo(() => new ExecutionTargetController({
    get: (id) => client.request<ExecutionTargetView>('members.executionTarget.get', { memberId: id }),
    save: (input) => client.request<ExecutionTargetReceipt>('members.executionTarget.save', {
      memberId: input.memberId,
      expectedRevision: input.expectedRevision,
      selection: input.selection
    })
  }), [client])
  const state: ExecutionTargetState = useSyncExternalStore(
    controller.subscribe, controller.getState, controller.getState
  )
  const [reload, setReload] = useState(0)
  const [nodeRecords, setNodeRecords] = useState<ExecutionNodeRecord[] | null>(null)
  const [nodesError, setNodesError] = useState('')
  const observedFacts = useRef<string | null>(null)

  // Selecting first keeps every later transition owned by one member.
  useEffect(() => {
    controller.select(memberId)
  }, [controller, memberId])

  useEffect(() => {
    if (!active) return
    controller.load()
  }, [controller, active, memberId, reload])

  const member = state.memberId === memberId ? memberTargetState(state, memberId) : null
  const dirty = member?.dirty ?? false
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!active || !nodes) {
      setNodeRecords(null)
      setNodesError('')
      return
    }
    let alive = true
    const read = (): void => {
      void nodes.list().then((result) => {
        if (!alive) return
        setNodeRecords(result.nodes)
        setNodesError('')
      }).catch((error: unknown) => {
        if (alive) setNodesError(nodeErrorCode(error))
      })
    }
    read()
    const timer = window.setInterval(read, NODE_LIST_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [active, nodes])

  const view = member?.view ?? null
  const draft = member?.draft ?? null
  const selectedNodeStatus = view?.selection
    ? nodeRecords?.find(node => node.nodeId === view.selection!.nodeId)?.status ?? 'unknown'
    : 'local'
  useEffect(() => {
    if (!view || member?.phase !== 'ready') return
    const key = JSON.stringify([memberId, view.revision, selectedNodeStatus])
    if (observedFacts.current === key) return
    observedFacts.current = key
    onFactsChanged?.()
  }, [memberId, view, member?.phase, selectedNodeStatus, onFactsChanged])

  return <MemberExecutionTargetPanel
    phase={member?.phase ?? 'loading'}
    view={view}
    draft={draft}
    nodeRecords={nodeRecords}
    nodesError={nodesError}
    nodesAvailable={nodes !== null}
    notice={member?.notice ?? { kind: 'none' }}
    saving={member?.saving ?? false}
    unknown={member?.unknown ?? false}
    onMode={(mode) => { if (view && draft) controller.edit(setTargetMode(draft, mode, view)) }}
    onNode={(nodeId) => { if (view && draft) controller.edit(setTargetNode(draft, nodeId, view)) }}
    onWorkspace={(workspaceId) => { if (view && draft) controller.edit(setTargetWorkspace(draft, workspaceId, view)) }}
    onAdapter={(adapterKind) => { if (view && draft) controller.edit(setTargetAdapter(draft, adapterKind, view)) }}
    onModelInput={(text) => { if (draft) controller.edit(setTargetModelInput(draft, text)) }}
    onPermission={(key, value) => { if (draft) controller.edit(setTargetPermission(draft, key, value)) }}
    onReload={() => setReload((value) => value + 1)}
    onUseServer={() => { controller.useServer() }}
    onSave={() => { void controller.save() }}
  />
}
