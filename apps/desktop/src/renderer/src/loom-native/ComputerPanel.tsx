import type { ThreadClient } from '../camp-client'
import type { AgentProfile } from './types'
import { ComputerAgentAccess } from './ComputerAgentAccess'
import { ComputerUnavailableHint } from './ComputerUnavailableHint'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerAgentApproval, ComputerControl, ComputerEvent, ComputerFrame, ComputerPort, ComputerStatus, ComputerView } from './host-services'
import { hostFeatureError, screenPoint } from './host-services'
import { Icon, IconButton } from './icons'
import { FormMessage } from './Controls'

const KEYS: Record<string, string> = { Enter:'enter', Tab:'tab', Backspace:'backspace', Delete:'delete', ArrowLeft:'left', ArrowRight:'right', ArrowUp:'up', ArrowDown:'down', Home:'home', End:'end', PageUp:'pageup', PageDown:'pagedown' }

/** A user-consented live Host view. Capture and input are separate grants.
 * No automatic reacquisition, invisible heartbeat, credential or screenshot storage. */
export function ComputerPanel({ port, client, agent = null, theme = 'day', retryDiscovery, openSettings }: { port?: ComputerPort; client?: ThreadClient; agent?: AgentProfile | null; theme?: 'day' | 'night'; retryDiscovery?: () => void | Promise<void>; openSettings?: () => void }) {
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [view, setView] = useState<ComputerView | null>(null)
  const [control, setControl] = useState<ComputerControl | null>(null)
  const [frame, setFrame] = useState<(Omit<ComputerFrame, 'blob'> & { url: string }) | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [statusCheckFailed, setStatusCheckFailed] = useState(false)
  const [text, setText] = useState('')
  const [agentApprovals, setAgentApprovals] = useState<ComputerAgentApproval[]>([])
  const [tick, setTick] = useState(Date.now())
  const viewRef = useRef<ComputerView | null>(null)
  const controlRef = useRef<ComputerControl | null>(null)
  const epoch = useRef(0)
  const nextSequence = useRef(0)
  const inputQueue = useRef(Promise.resolve())
  const objectUrl = useRef<string | null>(null)
  const screen = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const clockSkew = useRef(0)

  const dropControl = useCallback(async (notify = true) => {
    const previous = controlRef.current
    controlRef.current = null
    setControl(null)
    if (previous && port) {
      try { await port.release({ viewId: previous.viewId, controlId: previous.controlId, generation: previous.generation }) }
      catch (cause) { if (notify) setError(`已停止输入，尚未确认权限已撤销。${hostFeatureError(cause)}`) }
    }
  }, [port])
  const stop = useCallback(async (notify = true) => {
    ++epoch.current
    const previous = viewRef.current
    viewRef.current = null
    controlRef.current = null
    setView(null); setControl(null); setFrame(null)
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null }
    if (previous && port) {
      try { await port.stop(previous.viewId) }
      catch (cause) { if (notify) setError(`画面和输入已停止，尚未确认连接已关闭。${hostFeatureError(cause)}`) }
    }
  }, [port])
  const refreshStatus = useCallback(async () => {
    if (!port) return
    setBusy(true); setError('')
    try { const value = await port.status(); setStatus(value); setStatusCheckFailed(false); clockSkew.current = value.serverTime - Date.now(); if (!value.ready && value.reason) setError(hostFeatureError({ code: value.reason })) }
    catch (cause) { setStatusCheckFailed(true); setError(hostFeatureError(cause)) }
    finally { setBusy(false) }
  }, [port])
  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => {
    const leave = () => { if (document.visibilityState === 'hidden') void stop(false) }
    const unload = () => { void stop(false) }
    document.addEventListener('visibilitychange', leave)
    window.addEventListener('pagehide', unload)
    return () => { document.removeEventListener('visibilitychange', leave); window.removeEventListener('pagehide', unload); void stop(false) }
  }, [stop])
  useEffect(() => {
    if (!view || !port) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    const ticket = epoch.current
    const poll = async () => {
      if (cancelled || ticket !== epoch.current || document.visibilityState === 'hidden') return
      try {
        const value = await port.frame(view.viewId, abort.signal)
        if (cancelled || ticket !== epoch.current) return
        const url = URL.createObjectURL(value.blob)
        const previous = objectUrl.current
        objectUrl.current = url
        const { blob: _blob, ...meta } = value
        setFrame({ ...meta, url })
        if (previous) URL.revokeObjectURL(previous)
      } catch (cause) {
        if (cancelled || abort.signal.aborted || ticket !== epoch.current) return
        setError(hostFeatureError(cause))
        await stop(false)
        return
      }
      if (!cancelled) timer = setTimeout(() => { void poll() }, 650)
    }
    void poll()
    return () => { cancelled = true; abort.abort(); if (timer) clearTimeout(timer) }
  }, [view, port, stop])
  useEffect(() => {
    if (!control || !port) return
    let ended = false
    const identity = { viewId: control.viewId, controlId: control.controlId, generation: control.generation }
    const heartbeat = setInterval(() => {
      if (ended || !controlRef.current || document.visibilityState !== 'visible') return
      void port.heartbeat(identity).then(value => {
        if (ended || controlRef.current?.controlId !== identity.controlId) return
        controlRef.current = { ...controlRef.current, ...value }
        setControl(current => current?.controlId === identity.controlId ? { ...current, ...value } : current)
      }).catch(cause => {
        if (ended) return
        setError(hostFeatureError(cause)); void dropControl(false)
      })
    }, 4500)
    const clock = setInterval(() => {
      const now = Date.now(); setTick(now)
      const lease = controlRef.current
      if (lease && now + clockSkew.current >= Math.min(lease.expiresAt, lease.totalDeadline)) { setError('控制授权已到期，输入已停止。'); void dropControl(false) }
    }, 500)
    return () => { ended = true; clearInterval(heartbeat); clearInterval(clock) }
  }, [control?.controlId, port, dropControl])

  const beginView = async () => {
    if (!port || !status?.device || busy) return
    const ticket = ++epoch.current
    setBusy(true); setError('')
    try {
      const next = await port.startView(status.device.deviceId)
      if (ticket !== epoch.current || document.visibilityState !== 'visible') { await port.stop(next.viewId); return }
      viewRef.current = next; setView(next); clockSkew.current = next.serverTime - Date.now()
    } catch (cause) { setError(hostFeatureError(cause)) }
    finally { setBusy(false) }
  }
  const acquire = async () => {
    if (!port || !viewRef.current || busy) return
    const current = viewRef.current
    const ticket = epoch.current
    setBusy(true); setError('')
    try {
      const next = await port.acquire(current.viewId, current.deviceId)
      if (ticket !== epoch.current || !viewRef.current || document.visibilityState !== 'visible') { await port.release({ viewId: next.viewId, controlId: next.controlId, generation: next.generation }); return }
      nextSequence.current = next.seq ?? 0
      controlRef.current = next; setControl(next); screen.current?.focus()
    } catch (cause) { setError(hostFeatureError(cause)) }
    finally { setBusy(false) }
  }
  const send = useCallback((event: ComputerEvent) => {
    const lease = controlRef.current
    if (!lease || !port || document.visibilityState !== 'visible') return
    const ticket = epoch.current
    const id = lease.controlId
    inputQueue.current = inputQueue.current.then(async () => {
      const latest = controlRef.current
      if (ticket !== epoch.current || !latest || latest.controlId !== id || document.visibilityState !== 'visible') return
      const seq = ++nextSequence.current
      const result = await port.input({ viewId: latest.viewId, controlId: latest.controlId, generation: latest.generation }, seq, event)
      if (!result.applied || result.seq !== seq || result.generation !== latest.generation) throw new Error('未收到输入确认，控制已停止。')
    }).catch(cause => { if (controlRef.current?.controlId === id) { setError(hostFeatureError(cause)); void dropControl(false) } })
  }, [port, dropControl])
  useEffect(() => {
    const target = screen.current
    if (!target || !control) return
    const wheel = (event: WheelEvent) => {
      const current = image.current
      if (!current || !frame) return
      const point = screenPoint(current.getBoundingClientRect(), frame.bounds, event.clientX, event.clientY)
      if (!point) return
      event.preventDefault()
      send({ kind: 'wheel', ...point, delta: event.deltaY > 0 ? -120 : 120 })
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => target.removeEventListener('wheel', wheel)
  }, [control?.controlId, frame?.bounds.x, frame?.bounds.y, frame?.bounds.width, frame?.bounds.height, send])
  useEffect(() => {
    if (!port?.agents?.approvalsList || !agent) { setAgentApprovals([]); return }
    let cancelled = false
    const load = async () => {
      try {
        const result = await port.agents!.approvalsList!(agent.agentId)
        if (!cancelled) setAgentApprovals(result.items.filter(item => item.assistantId === agent.agentId && item.status === 'pending'))
      } catch { if (!cancelled) setAgentApprovals([]) }
    }
    void load()
    const timer = setInterval(() => { void load() }, 1000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [port?.agents, agent?.agentId])
  const seconds = control ? Math.max(0, Math.ceil((control.totalDeadline - tick - clockSkew.current) / 1000)) : 0
  const pendingApproval = agentApprovals[0]
  const rawRect = pendingApproval?.rect ?? (pendingApproval?.x != null && pendingApproval.y != null ? { x: pendingApproval.x - 16, y: pendingApproval.y - 16, w: 32, h: 32 } : null)
  const targetRect = frame && rawRect && frame.bounds.width > 0 && frame.bounds.height > 0 ? {
    x: ((rawRect.x - frame.bounds.x) / frame.bounds.width) * 100,
    y: ((rawRect.y - frame.bounds.y) / frame.bounds.height) * 100,
    w: (rawRect.w / frame.bounds.width) * 100,
    h: (rawRect.h / frame.bounds.height) * 100,
  } : null
  const targetPoint = frame && frame.bounds.width > 0 && frame.bounds.height > 0 && pendingApproval?.x != null && pendingApproval.y != null ? {
    x: ((pendingApproval.x - frame.bounds.x) / frame.bounds.width) * 100,
    y: ((pendingApproval.y - frame.bounds.y) / frame.bounds.height) * 100,
  } : null
  return <section className="ln-computer-panel" aria-label="电脑控制">
    <div className="ln-computer-title"><div><strong>电脑</strong><span>{control ? '由你控制' : view ? '仅查看' : '未连接'}</span></div><IconButton icon="refresh" label="检查电脑连接" disabled={busy || !!view} onClick={() => { void refreshStatus() }}/></div>
    <p className="ln-computer-scope">先允许查看屏幕；点一下画面立即接管鼠标和键盘，最长五分钟，可点“交还助手”停止。</p>
    {error && <FormMessage error>{error}</FormMessage>}
    <ComputerUnavailableHint status={status} viewActive={!!view} busy={busy} hasPort={!!port} statusFailed={statusCheckFailed} refreshStatus={port ? refreshStatus : undefined} retryDiscovery={retryDiscovery} openSettings={openSettings}/>
    <div ref={screen} className={`ln-computer-screen${control ? ' is-controlled' : ''}`} tabIndex={control ? 0 : -1} role={control ? 'application' : undefined} aria-label={control ? '远程桌面输入区域；Escape交还助手' : '所选电脑屏幕；点击接管'} onKeyDown={event => {
      if (!controlRef.current) return
      if (event.key === 'Escape') { event.preventDefault(); void dropControl(); return }
      if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return
      if (KEYS[event.key]) { event.preventDefault(); send({ kind: 'key', key: KEYS[event.key]! }) }
      else if ([...event.key].length === 1) { event.preventDefault(); send({ kind: 'text', text: event.key }) }
    }}>
      {frame ? <div className="ln-computer-picture"><img ref={image} src={frame.url} alt="所选电脑实时屏幕" draggable={false} onClick={event => {
        if (!controlRef.current) { void acquire(); return }
        const point = screenPoint(event.currentTarget.getBoundingClientRect(), frame.bounds, event.clientX, event.clientY)
        if (point) { screen.current?.focus(); send({ kind: 'pointer', action: 'click', button: 'left', ...point }) }
      }} onContextMenu={event => {
        if (!controlRef.current) return
        event.preventDefault()
        const point = screenPoint(event.currentTarget.getBoundingClientRect(), frame.bounds, event.clientX, event.clientY)
        if (point) send({ kind: 'pointer', action: 'click', button: 'right', ...point })
      }}/>{pendingApproval && targetRect && <span aria-hidden="true" className="ln-computer-approval-target" style={{ left: `${targetRect.x}%`, top: `${targetRect.y}%`, width: `${targetRect.w}%`, height: `${targetRect.h}%` }}/>}{pendingApproval && targetPoint && <span aria-hidden="true" className="ln-computer-cursor" style={{ left: `${targetPoint.x}%`, top: `${targetPoint.y}%` }}/>}</div> : <div className="ln-computer-placeholder"><Icon name="computer" size={43}/><strong>{view ? '正在连接屏幕…' : !port ? '此设备暂不支持查看屏幕' : status?.ready ? '查看这台电脑的屏幕' : '电脑连接未就绪'}</strong><span>{view ? '请稍候' : status?.ready ? '点击下方按钮开始查看' : '请检查电脑连接'}</span></div>}
    </div>
    <div className="ln-computer-actions">{!view ? <button type="button" className="ln-action is-primary" disabled={busy || !port || !status?.ready || !status.device} onClick={() => { void beginView() }}>允许本次查看屏幕</button> : <><button type="button" className="ln-action" onClick={() => { void stop() }}>断开画面</button>{control ? <button type="button" className="ln-action is-danger" onClick={() => { void dropControl() }}>交还助手 · {seconds}秒</button> : <button type="button" className="ln-action is-primary" disabled={busy || !frame} onClick={() => { void acquire() }}>接管电脑</button>}</>}</div>
    {control && <div className="ln-computer-inputs"><p>点击画面后可打字。按 Esc 交还助手；离开页面或五分钟后自动停止。</p><div className="ln-computer-keys">{[['Enter','enter'],['Tab','tab'],['Esc','escape'],['⌫','backspace'],['↑','up'],['↓','down']].map(([label,key]) => <button key={key} type="button" className="ln-action" onClick={() => send({ kind: 'key', key: key! })}>{label}</button>)}</div><form onSubmit={event => { event.preventDefault(); if (text.trim()) { send({ kind: 'text', text }); setText('') } }}><input value={text} onChange={event => setText(event.target.value)} maxLength={2048} placeholder="向电脑输入文字…" aria-label="发送到电脑的文字" autoComplete="off"/><button type="submit" className="ln-action" disabled={!text}>输入</button></form></div>}
    {frame && <small className="ln-computer-footnote">{frame.width} × {frame.height} · {view?.platform} · 查看授权仅限本次连接</small>}
    {client && <ComputerAgentAccess key={agent?.agentId} port={port?.agents} client={client} agent={agent} device={status?.device ?? null} theme={theme}/>}
  </section>
}
