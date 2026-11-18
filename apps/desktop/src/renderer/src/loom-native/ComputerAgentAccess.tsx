import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadClient } from '../camp-client'
import type { AgentProfile } from './types'
import type { ComputerAgentGrant, ComputerAgentGrants, ComputerAgentPort, ComputerDevice } from './host-services'
import { hostFeatureError } from './host-services'
import { readMcpConnections } from './mcp-service'
import { Avatar } from './Avatar'
import { FormMessage, SurfaceDialog } from './Controls'

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
  const generation = useRef(0)
  const reload = useCallback(async () => {
    if (!port) return
    const ticket = ++generation.current
    try {
      const result = await port.list()
      if (ticket === generation.current) { setCatalog(result); setError('') }
    } catch (cause) { if (ticket === generation.current) setError(hostFeatureError(cause)) }
  }, [port])
  useEffect(() => {
    setCatalog(null); setReview(null); setNotice('')
    void reload()
    return () => { generation.current++ }
  }, [reload, agent?.agentId])
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(clock)
  }, [])
  const owned = catalog?.grants.filter(grant => grant.assistantId === agent?.agentId) ?? []
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
  if (!agent) return null
  return <div className="ln-computer-agent-access">
    <header><Avatar agent={agent} size={25}/><strong>让 {agent.displayName} 使用电脑</strong><button type="button" className="ln-text-action" disabled={busy || !port} onClick={() => { void reload() }}>刷新</button></header>
    <p>单独授权后，助手才能使用电脑。五分钟后、退出登录或撤销时结束。</p>
    {error && <FormMessage error>{error}</FormMessage>}
    {notice && <FormMessage>{notice}</FormMessage>}
    {!port || catalog?.limits.configured === false ? <p className="ln-muted">这台电脑尚未启用助手操作。</p> : <>
      {owned.map(item => <div key={item.grantId} className="ln-computer-grant-row"><span><strong>{item.scope === 'control' ? '查看与点击、输入' : '仅查看屏幕'}</strong><small>{item.state === 'active' && item.expiresAt > now ? `剩余约 ${Math.ceil((item.expiresAt - now) / 1000)} 秒` : '已失效，可清理'}</small></span><button type="button" className="ln-action is-danger" disabled={busy} onClick={() => { void revoke(item) }}>撤销</button></div>)}
      {!runtime && <p className="ln-muted">先为助手选择运行方式。</p>}
      {!!runtime && !runtimeSupported && <p className="ln-muted">这个助手当前的运行方式暂不支持电脑操作。</p>}
      {needsCleanup && <p className="ln-muted">先撤销上方已过期的授权，再重新授权。</p>}
      <div className="ln-computer-actions"><button type="button" className="ln-action" disabled={busy || !catalog?.limits.configured || !device || active || needsCleanup || !runtimeSupported} onClick={() => { void prepare('view') }}>授权查看</button><button type="button" className="ln-action" disabled={busy || !catalog?.limits.configured || !device || active || needsCleanup || !runtimeSupported} onClick={() => { void prepare('control') }}>授权电脑操作</button></div>
    </>}
    <SurfaceDialog open={review !== null} title={review?.scope === 'control' ? '允许助手操作这台电脑？' : '允许助手查看这台电脑？'} theme={theme} onClose={() => { if (!busy) setReview(null) }} className="ln-room-dialog"><div className="ln-room-content"><p>{agent.displayName} 将可以使用这台电脑的{review?.scope === 'control' ? '截图、点击、按键和文字输入' : '截图'}工具。屏幕内容会随截图发送给这个助手使用的模型。</p><p className="ln-settings-copy">授权最长五分钟，可随时撤销。请先关闭不希望助手看到的内容，再发消息安排任务。</p><div className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => setReview(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={() => { void grant() }}>{busy ? '正在授权…' : '允许本次'}</button></div></div></SurfaceDialog>
  </div>
}
