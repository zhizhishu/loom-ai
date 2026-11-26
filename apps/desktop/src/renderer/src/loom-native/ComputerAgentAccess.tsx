import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadClient } from '../camp-client'
import type { AgentProfile } from './types'
import type { ComputerAgentApproval, ComputerAgentGrant, ComputerAgentGrants, ComputerAgentMode, ComputerAgentPort, ComputerDevice } from './host-services'
import { hostFeatureError } from './host-services'
import { readMcpConnections } from './mcp-service'
import { Avatar } from './Avatar'
import { FormMessage, SurfaceDialog } from './Controls'
import { Icon } from './icons'

export function ComputerAgentModeControls({ mode, modeReady, busy, onChoose }: { mode: ComputerAgentMode; modeReady: boolean; busy: boolean; onChoose(mode: ComputerAgentMode): void }) {
  return <div className="ln-computer-mode" role="group" aria-label="助手电脑操作模式"><span>助手操作模式</span><button type="button" className={mode === 'ask' ? 'ln-action is-primary' : 'ln-action'} disabled={busy || !modeReady} onClick={() => onChoose('ask')}>每步先问我</button><button type="button" className={mode === 'full' ? 'ln-action is-primary' : 'ln-action'} disabled={busy || !modeReady} onClick={() => onChoose('full')}>全权限</button></div>
}

export function ComputerAgentApprovalCards({ approvals, busy, onDecide }: { approvals: ComputerAgentApproval[]; busy: boolean; onDecide(item: ComputerAgentApproval, decision: 'approve' | 'deny'): void }) {
  return <>{approvals.map(item => <section key={item.approvalId} className="ln-approval-request" aria-label="等待批准电脑操作"><strong><Icon name="hand" size={16}/>助手请求操作电脑</strong><p>{item.summary}</p><small>{item.tool} · 不批准不会落到屏幕</small><div><button type="button" disabled={busy} onClick={() => onDecide(item, 'approve')}>允许这一步</button><button type="button" disabled={busy} onClick={() => onDecide(item, 'deny')}>拒绝</button></div></section>)}</>
}

/** Assistant control is a separate, explicit, revocable permission. Neither
 * looking at this panel nor starting a user screen view grants tools to a model. */
export function ComputerAgentAccess({ port, client, agent, device, theme }: {
  port?: ComputerAgentPort; client: ThreadClient; agent: AgentProfile | null
  device: ComputerDevice | null; theme: 'day' | 'night'
}) {
  const [catalog, setCatalog] = useState<ComputerAgentGrants | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<{ digest: string; scope: 'view' | 'control'; agentId: string; deviceId: string } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<ComputerAgentMode>('ask')
  const [modeReady, setModeReady] = useState(false)
  const [approvals, setApprovals] = useState<ComputerAgentApproval[]>([])
  const generation = useRef(0)
  const reload = useCallback(async () => {
    if (!port) return
    const ticket = ++generation.current
    try {
      const result = await port.list()
      if (ticket === generation.current) { setCatalog(result); setError('') }
    } catch (cause) { if (ticket === generation.current) setError(hostFeatureError(cause)) }
  }, [port])
  const reloadMode = useCallback(async () => {
    if (!port?.modeStatus || !agent) { setModeReady(false); return }
    try {
      const result = await port.modeStatus(agent.agentId)
      if (result.assistantId === agent.agentId && (result.mode === 'ask' || result.mode === 'full')) { setMode(result.mode); setModeReady(true) }
    } catch { setModeReady(false) }
  }, [port, agent])
  const reloadApprovals = useCallback(async () => {
    if (!port?.approvalsList || !agent) { setApprovals([]); return }
    try {
      const result = await port.approvalsList(agent.agentId)
      setApprovals(result.items.filter(item => item.assistantId === agent.agentId && item.status === 'pending'))
    } catch { setApprovals([]) }
  }, [port, agent])
  useEffect(() => {
    setCatalog(null); setReview(null); setNotice(''); setMode('ask'); setModeReady(false); setApprovals([])
    void reload(); void reloadMode(); void reloadApprovals()
    return () => { generation.current++ }
  }, [reload, reloadMode, reloadApprovals, agent?.agentId])
  useEffect(() => {
    if (!port?.approvalsList || !agent) return
    const timer = setInterval(() => { void reloadApprovals() }, 2000)
    return () => clearInterval(timer)
  }, [port, agent?.agentId, reloadApprovals])
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(clock)
  }, [])
  // A standing grant covers exactly one device: one for this computer must not block (or be
  // shown as) authority over another. The device id is the one the panel is currently
  // reviewing, so a remote node's consent never inherits a local screen's grant.
  const owned = catalog?.grants.filter(grant => grant.assistantId === agent?.agentId
    && (device === null || grant.deviceId === device.deviceId)) ?? []
  const active = owned.some(grant => grant.state === 'active' && grant.expiresAt > now)
  const needsCleanup = owned.some(grant => grant.state !== 'revoked' && grant.expiresAt <= now)
  const runtime = agent?.runtimeConfiguration?.adapterKind
  const runtimeSupported = !!runtime && !!catalog?.limits.runtimes.includes(runtime) && (runtime !== 'pi' || catalog.limits.piEnabled)
  const prepare = async (scope: 'view' | 'control') => {
    if (!port || !agent || !device || busy || active || needsCleanup || !runtimeSupported) return
    const ticket = generation.current
    const identity = { agentId: agent.agentId, deviceId: device.deviceId }
    setBusy(true); setError('')
    try {
      const config = await readMcpConnections(client)
      if (config.status !== 'ready') throw new Error(config.message)
      if (ticket === generation.current) setReview({ digest: config.configDigest, scope, ...identity })
    } catch (cause) { if (ticket === generation.current) setError(hostFeatureError(cause)) }
    finally { setBusy(false) }
  }
  const grant = async () => {
    const selected = review
    if (!selected || !port || selected.agentId !== agent?.agentId || selected.deviceId !== device?.deviceId || busy) return
    setBusy(true); setError('')
    try {
      const result = await port.grant({
        assistantId: selected.agentId, deviceId: selected.deviceId, scope: selected.scope,
        expectedConfigDigest: selected.digest, ttlSeconds: Math.min(300, catalog?.limits.maxGrantSeconds ?? 300)
      })
      if (result.assistantId !== selected.agentId || result.deviceId !== selected.deviceId || result.scope !== selected.scope || result.state !== 'active') {
        throw new Error('授权结果与所选助手或电脑不一致，请刷新检查。')
      }
      setReview(null)
      setNotice('已授权。下次发消息时，助手就能使用电脑工具。')
      await reload()
    } catch (cause) {
      setReview(null)
      setError(`暂时无法确认授权结果，请刷新后查看。${hostFeatureError(cause)}`)
      // Reads reconcile unknown outcomes; mutations are never replayed here.
      try { setCatalog(await port.list()) } catch { /* The original error is retained. */ }
    } finally { setBusy(false) }
  }
  const revoke = async (item: ComputerAgentGrant) => {
    if (!port || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await port.revoke(item.grantId)
      if (!result.revoked || result.grantId !== item.grantId) throw new Error('尚未确认权限已撤销，请刷新检查。')
      setNotice('已撤销电脑权限。')
      await reload()
    } catch (cause) { setError(hostFeatureError(cause)) }
    finally { setBusy(false) }
  }
  const chooseMode = async (next: ComputerAgentMode) => {
    if (!port?.setMode || !agent || busy || next === mode) return
    setBusy(true); setError('')
    try {
      const result = await port.setMode(agent.agentId, next)
      if (result.assistantId !== agent.agentId || result.mode !== next) throw new Error('审批模式尚未确认，请刷新检查。')
      setMode(next); setModeReady(true)
    } catch (cause) { setError(hostFeatureError(cause)) }
    finally { setBusy(false) }
  }
  const decide = async (item: ComputerAgentApproval, decision: 'approve' | 'deny') => {
    if (!port?.decideApproval || busy) return
    setBusy(true); setError('')
    try {
      const result = await port.decideApproval(item.approvalId, decision)
      const expected = decision === 'approve' ? 'approved' : 'denied'
      if (result.approvalId !== item.approvalId || result.status !== expected) throw new Error('审批结果尚未确认，请刷新检查。')
      setApprovals(current => current.filter(value => value.approvalId !== item.approvalId))
    } catch (cause) { setError(hostFeatureError(cause)); void reloadApprovals() }
    finally { setBusy(false) }
  }
  if (!agent) return null
  return <div className="ln-computer-agent-access">
    <header><Avatar agent={agent} size={25}/><strong>让 {agent.displayName} 使用电脑</strong><button type="button" className="ln-text-action" disabled={busy || !port} onClick={() => { void reload() }}>刷新</button></header>
    <p>单独授权后，助手才能使用电脑。五分钟后、退出登录或撤销时结束。</p>
    {error && <FormMessage error>{error}</FormMessage>}
    {notice && <FormMessage>{notice}</FormMessage>}
    {!port || catalog?.limits.configured === false ? <p className="ln-muted">这台电脑尚未启用助手操作。</p> : <>
      {owned.map(item => <div key={item.grantId} className="ln-computer-grant-row"><span><strong>{item.scope === 'control' ? '查看与点击、输入' : '仅查看屏幕'}</strong><small>{item.state === 'active' && item.expiresAt > now ? `剩余约 ${Math.ceil((item.expiresAt - now) / 1000)} 秒` : '已失效，可清理'}</small></span><button type="button" className="ln-action is-danger" disabled={busy} onClick={() => { void revoke(item) }}>撤销</button></div>)}
      {port.modeStatus && <ComputerAgentModeControls mode={mode} modeReady={modeReady} busy={busy} onChoose={next => { void chooseMode(next) }}/>}
      <ComputerAgentApprovalCards approvals={approvals} busy={busy} onDecide={(item, decision) => { void decide(item, decision) }}/>
      {!runtime && <p className="ln-muted">先为助手选择运行方式。</p>}
      {!!runtime && !runtimeSupported && <p className="ln-muted">这个助手当前的运行方式暂不支持电脑操作。</p>}
      {needsCleanup && <p className="ln-muted">先撤销上方已过期的授权，再重新授权。</p>}
      <div className="ln-computer-actions"><button type="button" className="ln-action" disabled={busy || !catalog?.limits.configured || !device || active || needsCleanup || !runtimeSupported} onClick={() => { void prepare('view') }}>授权查看</button><button type="button" className="ln-action" disabled={busy || !catalog?.limits.configured || !device || active || needsCleanup || !runtimeSupported} onClick={() => { void prepare('control') }}>授权电脑操作</button></div>
    </>}
    <SurfaceDialog open={review !== null} title={review?.scope === 'control' ? '允许助手操作这台电脑？' : '允许助手查看这台电脑？'} theme={theme} onClose={() => { if (!busy) setReview(null) }} className="ln-room-dialog"><div className="ln-room-content"><p>{agent.displayName} 将可以使用这台电脑的{review?.scope === 'control' ? '截图、点击、按键和文字输入' : '截图'}工具。屏幕内容会随截图发送给这个助手使用的模型。</p><p className="ln-settings-copy">授权最长五分钟，可随时撤销。请先关闭不希望助手看到的内容，再发消息安排任务。</p><div className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => setReview(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={() => { void grant() }}>{busy ? '正在授权…' : '允许本次'}</button></div></div></SurfaceDialog>
  </div>
}
