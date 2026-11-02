import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useUiText } from './interface-language'
import { appendOutputLines, formatElapsed, type LivePhase, type LivePlacement, type OutputLine } from './loom-live-model'
import type { NodeApi } from './nodes-api'

function phaseLabel(phase: LivePhase, t: (text: string, ...values: Array<string | number>) => string): string {
  switch (phase) {
    case 'queued': return t('排队')
    case 'running': return t('在跑')
    case 'exited': return t('已结束')
    case 'failed': return t('失败')
    case 'offline': return t('离线')
    case 'done': return t('已完成')
  }
}

export function LoomLiveStrip({ placements }: { placements: readonly LivePlacement[] }): JSX.Element {
  const t = useUiText()
  return <div className="loom-live-strip" role="list" aria-label={t('使命进度')}>
    {placements.map(entry => <div key={entry.taskId} role="listitem" className="loom-live-strip-item" data-phase={entry.phase}>
      <span className="loom-live-strip-title">{entry.title}</span>
      <span className="loom-live-strip-meta">
        {entry.nodeName ? `${entry.remote ? t('远端') : t('本机')} · ${entry.nodeName} · ` : ''}
        {phaseLabel(entry.phase, t)}
      </span>
      <span className="loom-live-strip-track" aria-hidden="true"><i data-phase={entry.phase}/></span>
    </div>)}
  </div>
}

export function LoomLiveRow({
  placement,
  now,
  open,
  onOpen
}: {
  placement: LivePlacement
  now: number
  open: boolean
  onOpen(): void
}): JSX.Element | null {
  const t = useUiText()
  if (!placement.runId || !placement.nodeName) return null
  const elapsed = placement.phase === 'running' || placement.phase === 'offline'
    ? formatElapsed(placement.startedAt, now)
    : null
  return <div className="loom-live-row" data-live-phase={placement.phase} data-live-role={placement.remote ? 'remote' : 'local'}>
    <span className={`loom-live-badge${placement.remote ? ' is-remote' : ''}`}>{placement.remote ? t('远端') : t('本机')}</span>
    <span className="loom-live-node">{placement.nodeName}</span>
    {placement.runtime && <span className="loom-live-cli">{placement.runtime}</span>}
    <span className="loom-live-phase">
      <i data-phase={placement.phase} aria-hidden="true"/>
      {phaseLabel(placement.phase, t)}
    </span>
    {elapsed && <span className="loom-live-elapsed">{t('已进行 {0}', elapsed)}</span>}
    <button
      type="button"
      className="loom-live-open"
      aria-pressed={open}
      aria-controls={open ? `loom-live-${placement.runId}` : undefined}
      onClick={onOpen}
    >{t('执行过程')}</button>
  </div>
}

export function LoomLiveProcess({
  placement,
  api,
  onClose
}: {
  placement: LivePlacement
  api: NodeApi
  onClose(): void
}): JSX.Element {
  const t = useUiText()
  const scroller = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<OutputLine[]>([])
  const [follow, setFollow] = useState(true)
  const [error, setError] = useState(false)
  const cursor = useRef(1)
  const runId = placement.runId ?? ''

  useEffect(() => {
    let stopped = false
    let timer = 0
    const pull = async (): Promise<void> => {
      try {
        const page = await api.output(runId, cursor.current)
        if (stopped) return
        setError(false)
        setLines(current => {
          const merged = appendOutputLines(current, page.frames, cursor.current)
          cursor.current = page.nextFrom ?? merged.cursor
          return merged.lines
        })
        if (page.status === 'running' || page.truncated) {
          timer = window.setTimeout(() => { void pull() }, 500)
        }
      } catch {
        if (!stopped) setError(true)
      }
    }
    void pull()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [api, runId])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || !follow) return
    node.scrollTop = node.scrollHeight
  }, [lines, follow])

  const onScroll = (): void => {
    const node = scroller.current
    if (!node) return
    setFollow(node.scrollHeight - node.scrollTop - node.clientHeight <= 8)
  }

  return <section
    id={`loom-live-${runId}`}
    className="loom-live-process"
    aria-label={t('执行过程')}
    onKeyDown={event => { if (event.key === 'Escape') onClose() }}
  >
    <header>
      <strong>{t('执行过程')}</strong>
      <span>{placement.nodeName} · {placement.runtime}</span>
      <button type="button" className="quiet-button compact" aria-pressed={follow} onClick={() => setFollow(true)}>{t('跟随最新')}</button>
      <button type="button" className="quiet-button compact" onClick={onClose}>{t('收起这一路')}</button>
    </header>
    {placement.phase === 'offline' && <p className="loom-live-note">{t('节点已离线。已确认到序号 {0}。不另起进程。', String(placement.ackedSeq))}</p>}
    {error && <p className="loom-live-note" role="alert">{t('执行过程读取失败')}</p>}
    <div
      ref={scroller}
      className="loom-live-output"
      data-follow={follow ? 'true' : 'false'}
      tabIndex={0}
      onScroll={onScroll}
    >
      {lines.length === 0 && !error && <p>{t('还没有这一路的输出。')}</p>}
      {lines.map(line => line.kind === 'gap'
        ? <p key={`gap-${line.seq}`} className="loom-live-gap">{t('漏了 {0} 行，正在补齐', String(line.missed))}</p>
        : <p key={line.seq} className="loom-live-line" data-stream={line.stream}><span>{line.seq}</span>{line.text}</p>)}
    </div>
  </section>
}
