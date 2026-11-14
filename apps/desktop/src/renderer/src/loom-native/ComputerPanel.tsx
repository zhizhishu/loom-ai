import type { ThreadClient } from '../camp-client'
import type { AgentProfile } from './types'
import { ComputerAgentAccess } from './ComputerAgentAccess'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerControl, ComputerEvent, ComputerFrame, ComputerPort, ComputerStatus, ComputerView } from './host-services'
import { hostFeatureError, screenPoint } from './host-services'
import { Icon, IconButton } from './icons'
import { FormMessage, SurfaceDialog } from './Controls'

const KEYS: Record<string, string> = { Enter:'enter', Tab:'tab', Backspace:'backspace', Delete:'delete', ArrowLeft:'left', ArrowRight:'right', ArrowUp:'up', ArrowDown:'down', Home:'home', End:'end', PageUp:'pageup', PageDown:'pagedown' }

/** A user-consented live Host view. Capture and input are separate grants.
 * No automatic reacquisition, invisible heartbeat, credential or screenshot storage. */
export function ComputerPanel({ port, client, agent = null, theme = 'day' }: { port?: ComputerPort; client?: ThreadClient; agent?: AgentProfile | null; theme?: 'day' | 'night' }) {
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [view, setView] = useState<ComputerView | null>(null)
  const [control, setControl] = useState<ComputerControl | null>(null)
  const [frame, setFrame] = useState<(Omit<ComputerFrame, 'blob'> & { url: string }) | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const [text, setText] = useState('')
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
      catch (cause) { if (notify) setError(`已停止发送输入；主机撤销回执未确认。${hostFeatureError(cause)}`) }
    }
  }, [port])
  const stop = useCallback(async (notify = true) => {
    ++epoch.current
    const previous = viewRef.current
    viewRef.current = null
    controlRef.current = null
    setView(null); setControl(null); setFrame(null); setConsentOpen(false)
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null }
    if (previous && port) {
      try { await port.stop(previous.viewId) }
      catch (cause) { if (notify) setError(`本页已停止看屏和输入；主机断开回执未确认。${hostFeatureError(cause)}`) }
    }
  }, [port])
  const refreshStatus = useCallback(async () => {
    if (!port) return
    setBusy(true); setError('')
    try { const value = await port.status(); setStatus(value); clockSkew.current = value.serverTime - Date.now(); if (!value.ready && value.reason) setError(hostFeatureError({ code: value.reason })) }
    catch (cause) { setError(hostFeatureError(cause)) }
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
      controlRef.current = next; setControl(next); setConsentOpen(false); screen.current?.focus()
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
      if (!result.applied || result.seq !== seq || result.generation !== latest.generation) throw new Error('主机未确认输入，已停止控制，未重放。')
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
  const seconds = control ? Math.max(0, Math.ceil((control.totalDeadline - tick - clockSkew.current) / 1000)) : 0
  return <section className="ln-computer-panel" aria-label="当前主机的电脑">
    <div className="ln-computer-title"><div><strong>电脑</strong><span>{control ? '由你控制' : view ? '仅查看' : '尚未看屏'}</span></div><IconButton icon="refresh" label="检查电脑连接" disabled={busy || !!view} onClick={() => { void refreshStatus() }}/></div>
    <p className="ln-computer-scope">当前连接主机的真实桌面。查看和控制分别授权；不会因此开放命令或文件权限。</p>
    {error && <FormMessage error>{error}</FormMessage>}
    <div ref={screen} className={`ln-computer-screen${control ? ' is-controlled' : ''}`} tabIndex={control ? 0 : -1} role={control ? 'application' : undefined} aria-label={control ? '远程桌面输入区域；Escape归还控制' : '当前主机屏幕'} onKeyDown={event => {
      if (!controlRef.current) return
      if (event.key === 'Escape') { event.preventDefault(); void dropControl(); return }
      if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return
      if (KEYS[event.key]) { event.preventDefault(); send({ kind: 'key', key: KEYS[event.key]! }) }
      else if ([...event.key].length === 1) { event.preventDefault(); send({ kind: 'text', text: event.key }) }
    }}>
      {frame ? <img ref={image} src={frame.url} alt="当前主机实时屏幕" draggable={false} onClick={event => {
        if (!controlRef.current) return
        const point = screenPoint(event.currentTarget.getBoundingClientRect(), frame.bounds, event.clientX, event.clientY)
        if (point) { screen.current?.focus(); send({ kind: 'pointer', action: 'click', button: 'left', ...point }) }
      }} onContextMenu={event => {
        if (!controlRef.current) return
        event.preventDefault()
        const point = screenPoint(event.currentTarget.getBoundingClientRect(), frame.bounds, event.clientX, event.clientY)
        if (point) send({ kind: 'pointer', action: 'click', button: 'right', ...point })
      }}/> : <div className="ln-computer-placeholder"><Icon name="computer" size={43}/><strong>{view ? '正在获取真实画面…' : !port ? '当前连接未提供电脑接口' : status?.ready ? '按需查看这台电脑' : '电脑服务尚未启用'}</strong><span>{view ? '画面只保存在当前页面内存中' : '不会在你打开页面时自动截图'}</span></div>}
    </div>
    <div className="ln-computer-actions">{!view ? <button type="button" className="ln-action is-primary" disabled={busy || !port || !status?.ready || !status.device} onClick={() => { void beginView() }}>允许本次查看屏幕</button> : <><button type="button" className="ln-action" onClick={() => { void stop() }}>断开画面</button>{control ? <button type="button" className="ln-action is-danger" onClick={() => { void dropControl() }}>归还控制 · {seconds}秒</button> : <button type="button" className="ln-action is-primary" disabled={busy || !frame} onClick={() => setConsentOpen(true)}>接管电脑</button>}</>}</div>
    {control && <div className="ln-computer-inputs"><p>点击画面后可打字。按 Esc 立即归还控制；无操作或离开页面会自动停止。</p><div className="ln-computer-keys">{[['Enter','enter'],['Tab','tab'],['Esc','escape'],['⌫','backspace'],['↑','up'],['↓','down']].map(([label,key]) => <button key={key} type="button" className="ln-action" onClick={() => send({ kind: 'key', key: key! })}>{label}</button>)}</div><form onSubmit={event => { event.preventDefault(); if (text.trim()) { send({ kind: 'text', text }); setText('') } }}><input value={text} onChange={event => setText(event.target.value)} maxLength={2048} placeholder="向电脑输入文字…" aria-label="发送到电脑的文字" autoComplete="off"/><button type="submit" className="ln-action" disabled={!text}>输入</button></form></div>}
    {frame && <small className="ln-computer-footnote">{frame.width} × {frame.height} · {view?.platform} · 查看授权仅限本次连接</small>}
    {client && <ComputerAgentAccess key={agent?.agentId} port={port?.agents} client={client} agent={agent} device={status?.device ?? null} theme={theme}/>}
    <SurfaceDialog open={consentOpen} title="接管这台电脑？" description="你在此画面上的点击和键盘输入将发送到当前连接的主机。" theme={theme} onClose={() => setConsentOpen(false)} className="ln-room-dialog"><div className="ln-room-content"><p className="ln-settings-copy">授权最长五分钟，离开页面或点击“归还控制”即停止。本次控制不授予任何助手永久电脑权限；不会自动输入、执行命令或复制剪贴板。</p><div className="ln-form-actions"><button type="button" className="ln-action" onClick={() => setConsentOpen(false)}>取消</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={() => { void acquire() }}>允许本次控制</button></div></div></SurfaceDialog>
  </section>
}
