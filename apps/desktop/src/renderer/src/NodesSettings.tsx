import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ExecutionNodePairing, ExecutionNodeRecord } from '@contracts'
import { writeClipboardText } from './clipboard'
import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader
} from './AppDialog'
import { SettingsPageHeader } from './SettingsPageHeader'
import { uiAttribute, useUiText } from './interface-language'
import { NODE_LIST_POLL_MS, nodeErrorCode, type NodeApi } from './nodes-api'
import {
  applyListResult,
  canConfirmRevoke,
  cliPathStatus,
  listFailureDetail,
  nodeMeta,
  offlineRunBanner,
  pairExpiryCopy,
  pairFailure,
  pairingCommand,
  remoteNodes,
  revokeFailure,
  roleLabel,
  runSummary,
  statusLabel,
  type NodeListState
} from './nodes-model'
import './nodes-settings.css'

const EMPTY_LIST: NodeListState = { nodes: null, readError: null, refreshError: null }

function NodesEmpty({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return <div className="nodes-empty" role="status">
    <span className="nodes-empty-mark" aria-hidden="true"><i /><i /><i /></span>
    <h3>{title}</h3>
    <div>{children}</div>
  </div>
}

export function NodesSettings({ api, onOpenRemoteHosts, now }: {
  api: NodeApi
  onOpenRemoteHosts?: () => void
  now?: number
}): React.JSX.Element {
  const [list, setList] = useState<NodeListState>(EMPTY_LIST)
  const [reload, setReload] = useState(0)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [pairOpen, setPairOpen] = useState(false)
  const [ticket, setTicket] = useState<ExecutionNodePairing | null>(null)
  const [pairBusy, setPairBusy] = useState(false)
  const [pairError, setPairError] = useState('')
  const [copied, setCopied] = useState(false)
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState('')
  const listRef = useRef(list)
  listRef.current = list
  const clock = now ?? Date.now()

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const value = await api.list()
        if (!active) return
        setList(applyListResult(listRef.current, { ok: true, nodes: value.nodes }))
      } catch (error) {
        if (!active) return
        setList(applyListResult(listRef.current, { ok: false, code: nodeErrorCode(error) }))
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.hidden) return
      void load()
    }, NODE_LIST_POLL_MS)
    const wake = (): void => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [api, reload])

  async function openPair(): Promise<void> {
    setPairOpen(true)
    setTicket(null)
    setPairError('')
    setCopied(false)
    setPairBusy(true)
    try {
      setTicket(await api.pair())
    } catch (error) {
      setTicket(null)
      setPairError(pairFailure(nodeErrorCode(error)))
    } finally {
      setPairBusy(false)
    }
  }

  async function copyCommand(): Promise<void> {
    if (!ticket) return
    const copiedOk = await writeClipboardText(pairingCommand(ticket))
    if (copiedOk) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
      return
    }
    setPairError(uiAttribute('未能复制命令，请手动选择。'))
  }

  async function confirmRevoke(node: ExecutionNodeRecord): Promise<void> {
    if (revokeBusy || !canConfirmRevoke(node, typed)) return
    setRevokeBusy(true)
    setRevokeError('')
    try {
      await api.revoke(node.nodeId)
      setRevokeId(null)
      setTyped('')
      setReload(value => value + 1)
    } catch (error) {
      setRevokeError(revokeFailure(nodeErrorCode(error)))
    } finally {
      setRevokeBusy(false)
    }
  }

  const revokeNode = list.nodes?.find(node => node.nodeId === revokeId) ?? null

  return <>
    <NodesSettingsBody
      list={list}
      expanded={expanded}
      now={clock}
      onToggle={nodeId => setExpanded(current => ({ ...current, [nodeId]: !current[nodeId] }))}
      onRetry={() => {
        setList(current => current.nodes ? current : { nodes: null, readError: null, refreshError: null })
        setReload(value => value + 1)
      }}
      onAdd={() => void openPair()}
      onRevoke={nodeId => { setRevokeId(nodeId); setTyped(''); setRevokeError('') }}
      onOpenRemoteHosts={onOpenRemoteHosts}
      pairOpen={pairOpen}
      ticket={ticket}
      pairBusy={pairBusy}
      pairError={pairError}
      copied={copied}
      onPairOpenChange={open => {
        setPairOpen(open)
        if (!open) setCopied(false)
      }}
      onCopy={() => void copyCommand()}
      revokeNode={revokeNode}
      typed={typed}
      revokeBusy={revokeBusy}
      revokeError={revokeError}
      onRevokeOpenChange={open => { if (!open && !revokeBusy) { setRevokeId(null); setTyped('') } }}
      onTyped={setTyped}
      onConfirmRevoke={() => { if (revokeNode) void confirmRevoke(revokeNode) }}
    />
  </>
}

export function NodesSettingsBody({
  list,
  expanded,
  now,
  onToggle,
  onRetry,
  onAdd,
  onRevoke,
  onOpenRemoteHosts,
  pairOpen,
  ticket,
  pairBusy,
  pairError,
  copied,
  onPairOpenChange,
  onCopy,
  revokeNode,
  typed,
  revokeBusy,
  revokeError,
  onRevokeOpenChange,
  onTyped,
  onConfirmRevoke
}: {
  list: NodeListState
  expanded: Readonly<Record<string, boolean>>
  now: number
  onToggle(nodeId: string): void
  onRetry(): void
  onAdd(): void
  onRevoke(nodeId: string): void
  onOpenRemoteHosts?: () => void
  pairOpen: boolean
  ticket: ExecutionNodePairing | null
  pairBusy: boolean
  pairError: string
  copied: boolean
  onPairOpenChange(open: boolean): void
  onCopy(): void
  revokeNode: ExecutionNodeRecord | null
  typed: string
  revokeBusy: boolean
  revokeError: string
  onRevokeOpenChange(open: boolean): void
  onTyped(value: string): void
  onConfirmRevoke(): void
}): React.JSX.Element {
  const t = useUiText()
  const loading = list.nodes === null && !list.readError
  const nodes = list.nodes
  const banner = nodes ? offlineRunBanner(nodes) : null
  const empty = nodes !== null && remoteNodes(nodes).length === 0
  return <div className="nodes-settings" data-nodes-state={loading ? 'loading' : list.readError ? 'error' : empty ? 'empty' : banner ? 'offline' : 'ready'}>
    <SettingsPageHeader
      eyebrow="Settings / Nodes"
      title={t('节点')}
      description={t('机器 A 是这份 Core。机器 B 出站拨进来。本机也是一台节点，只是不走网络。')}
      aside={<button className="primary-button" type="button" onClick={onAdd} disabled={loading}>{t('添加节点')}</button>}
    />
    {nodes && <p className="nodes-note">
      {t('节点是这一份 Core 手下的执行机器，没有自己的库。远端主机仍是打开另一台机器上的整套 LOOM。')}
      {onOpenRemoteHosts && <button className="nodes-inline-link" type="button" onClick={onOpenRemoteHosts}>{t('打开远端主机')}</button>}
    </p>}
    {list.refreshError && <p className="nodes-banner is-error" role="alert">{t('节点列表暂时无法刷新，上次读到的列表还留着。')}</p>}
    {banner && <p className="nodes-banner" role="status">{banner}</p>}
    {loading && <NodesEmpty title={t('正在读取节点…')}>
      <p>{t('从这份 Core 读取节点表、心跳和上次上报的 CLI。')}</p>
    </NodesEmpty>}
    {list.readError && <NodesEmpty title={t('节点列表读取失败')}>
      <p>{t('这次没有读到节点。列表不会显示成空，也不会把本机画成离线。')}</p>
      <p>{listFailureDetail(list.readError)}</p>
      <button className="quiet-button" type="button" onClick={onRetry}>{t('重新读取')}</button>
    </NodesEmpty>}
    {nodes && <div className="nodes-list">
      {nodes.map(node => <NodeRow key={node.nodeId} node={node} now={now} open={Boolean(expanded[node.nodeId])} onToggle={() => onToggle(node.nodeId)} onRevoke={() => onRevoke(node.nodeId)} />)}
    </div>}
    {empty && <NodesEmpty title={t('还没有拨入的节点')}>
      <p>{t('本机节点跟这份 Core 一起在，不需要配对。家里的电脑用配对码自己拨进来。')}</p>
    </NodesEmpty>}
    <NodeDialog open={pairOpen} onOpenChange={onPairOpenChange}>
        <AppDialogContent width="wide" aria-labelledby="node-pair-title">
          <AppDialogHeader
            title={<span id="node-pair-title">{t('添加节点')}</span>}
            description={ticket ? pairExpiryCopy(ticket.expiresInSeconds) : t('配对码约 {0} 分钟内有效，用过即废。这里不显示节点令牌。', 10)}
          />
          <AppDialogBody>
            {pairBusy && <p className="nodes-meta" role="status">{t('正在生成配对码…')}</p>}
            {ticket && <>
              <span className="nodes-field-label" id="node-pair-code-label">{t('配对码')}</span>
              <p className="nodes-pair-code" aria-labelledby="node-pair-code-label">{ticket.pairingCode}</p>
              <span className="nodes-field-label" id="node-pair-address-label">{t('B 要拨的地址')}</span>
              <p className="nodes-address" aria-labelledby="node-pair-address-label">{ticket.connectUrl}</p>
              <span className="nodes-field-label" id="node-pair-command-label">{t('在 B 上执行')}</span>
              <pre className="nodes-command" id="node-pair-command" aria-labelledby="node-pair-command-label">{pairingCommand(ticket)}</pre>
            </>}
            {pairError && <p className="nodes-dialog-error" role="alert">{pairError}</p>}
          </AppDialogBody>
          <AppDialogFooter>
            <Dialog.Close asChild><button className="quiet-button" type="button" data-dialog-autofocus>{t('关闭')}</button></Dialog.Close>
            <button className="primary-button" type="button" onClick={onCopy} disabled={!ticket || pairBusy}>{copied ? t('已复制') : t('复制命令')}</button>
          </AppDialogFooter>
        </AppDialogContent>
    </NodeDialog>
    <NodeDialog open={revokeNode !== null} onOpenChange={onRevokeOpenChange}>
        <AppDialogContent tone="danger" aria-labelledby="node-revoke-title">
          {revokeNode && <>
            <AppDialogHeader
              title={<span id="node-revoke-title">{t('作废 {0}？', revokeNode.displayName)}</span>}
              description={revokeNode.activeRunCount > 0
                ? t('这台节点还有在途 Run。输入节点名才能作废。令牌立即失效，在途进程由节点自己杀掉并上报。磁盘上的文件还在，只是不再派新 Run。')
                : t('这台节点现在没有在途 Run。确认后令牌失效，不再派新 Run。磁盘上的文件还在。')}
            />
            <AppDialogBody>
              {revokeNode.activeRunCount > 0 && <label className="field-label app-dialog-confirm-field" htmlFor="node-revoke-name">
                <span>{t('输入 {0} 以确认', revokeNode.displayName)}</span>
                <input id="node-revoke-name" value={typed} autoComplete="off" spellCheck={false} data-dialog-autofocus disabled={revokeBusy} onChange={event => onTyped(event.target.value)} />
              </label>}
              {revokeError && <p className="nodes-dialog-error" role="alert">{revokeError}</p>}
            </AppDialogBody>
            <AppDialogFooter>
              <Dialog.Close asChild><button className="quiet-button" type="button" data-dialog-autofocus={revokeNode.activeRunCount > 0 ? undefined : true} disabled={revokeBusy}>{t('取消')}</button></Dialog.Close>
              <button className="danger-button" type="button" disabled={revokeBusy || !canConfirmRevoke(revokeNode, typed)} onClick={onConfirmRevoke}>
                {revokeBusy ? t('正在作废…') : t('作废')}
              </button>
            </AppDialogFooter>
          </>}
        </AppDialogContent>
    </NodeDialog>
  </div>
}

function NodeDialog({ open, onOpenChange, children }: {
  open: boolean
  onOpenChange(open: boolean): void
  children: ReactNode
}): React.JSX.Element {
  if (typeof document === 'undefined') {
    return <Dialog.Root open={open} onOpenChange={onOpenChange}>{open ? children : null}</Dialog.Root>
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
      {children}
    </Dialog.Portal>
  </Dialog.Root>
}

function NodeRow({ node, now, open, onToggle, onRevoke }: {
  node: ExecutionNodeRecord
  now: number
  open: boolean
  onToggle(): void
  onRevoke(): void
}): React.JSX.Element {
  const t = useUiText()
  const status = statusLabel(node)
  const local = node.role === 'local'
  const revoked = Boolean(node.revokedAt)
  return <article className="nodes-row" data-node-id={node.nodeId} data-node-status={node.status} data-node-role={node.role}>
    <div>
      <div className="nodes-title">
        <i className={`nodes-dot${status.kind === 'ok' ? ' is-on' : ''}`} aria-hidden="true" />
        <strong>{node.displayName}</strong>
        <em className="nodes-role">{roleLabel(node)}</em>
        <span className={`nodes-pill${status.kind === 'ok' ? ' is-ok' : ''}`}>{status.text}</span>
      </div>
      <p className="nodes-meta">{nodeMeta(node, now)}</p>
      {node.clis.length > 0 && <div className="nodes-cli-line">
        {node.clis.map(cli => <span className={`nodes-cli${node.status === 'online' ? '' : ' is-stale'}`} key={`${cli.adapterKind}:${cli.path}`}>
          {cli.adapterKind} <i>{cli.version || t('未知')}</i>
        </span>)}
      </div>}
      <p className="nodes-meta">{runSummary(node)}</p>
    </div>
    <div className="nodes-actions">
      <button className="quiet-button compact" type="button" aria-expanded={open} onClick={onToggle}>{open ? t('收起') : t('CLI 路径')}</button>
      {local || !node.revocable
        ? <button className="quiet-button compact" type="button" disabled title={local ? t('本机节点跟这份 Core 走') : undefined}>{revoked && !local ? t('已作废') : t('不可作废')}</button>
        : <button className="danger-button compact" type="button" onClick={onRevoke}>{t('作废')}</button>}
    </div>
    {open && <div className="nodes-detail">
      {node.clis.length === 0
        ? <p className="nodes-meta">{t('没有上报 CLI')}</p>
        : <table>
          <thead><tr><th>{t('CLI')}</th><th>{t('版本')}</th><th>{t('节点上的路径')}</th><th>{t('状态')}</th></tr></thead>
          <tbody>
            {node.clis.map(cli => <tr key={`${cli.adapterKind}:${cli.path}`}>
              <td className="nodes-mono">{cli.adapterKind}</td>
              <td className="nodes-mono">{cli.version || t('未知')}</td>
              <td className="nodes-path">{cli.path}</td>
              <td>{cliPathStatus(node, cli)}</td>
            </tr>)}
          </tbody>
        </table>}
    </div>}
  </article>
}
