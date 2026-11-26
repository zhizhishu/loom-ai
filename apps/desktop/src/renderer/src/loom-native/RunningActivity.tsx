import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentRunView } from '@contracts'
import { formatExecutionDuration } from '../execution-run-summary'
import { runtimeFailureMessage } from '../RuntimeFailureNotice'
import { agentRunPresentation } from '../../../shared/execution-presentation'
import { uiAttribute } from '../interface-language'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'
import { Icon } from './icons'
import { manualRetryUx } from './retry-ux'

/*
 * 搬运自 Mikka `components/ui/thinking-loader-clean.tsx`（affectUI thinking loader，
 * https://www.affectui.com/components/thinking-loader，MIT）。算法、时序、内联样式与无障碍属性不改；
 * 只有三处搬运适配：
 * 1. 词表由调用方传入（Mikka 的英文 DEFAULT_PHASES 在本壳换成 LOOM 自己的「正在处理」）。
 * 2. useLayoutEffect 换成 isomorphic 版本：本仓 loom-native 测试用 renderToStaticMarkup
 *    服务端渲染，没有布局阶段；客户端仍走 useLayoutEffect，量宽行为不变。
 * 3. 样式照旧内联注入，React 19 会把同一个 <style> 提到 <head> 一次，不新增 CSS 文件。
 *
 * MIT License. Copyright (c) 2026 Florian Höller (adfects).
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice
 * and this permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */

export type ThinkingLoaderProps = {
  /** Labels to walk through, one after another */
  phases?: string[]
  /** Time per phase, in ms */
  interval?: number
  /** Show a specific phase instead of advancing on a timer – e.g. from your stream events */
  phase?: number
  /** Start over after the last phase instead of holding it */
  loop?: boolean
  /** Finished: the spinner turns into a check and the label into doneLabel */
  done?: boolean
  /** Label once done – a string, or a function that gets the seconds since the loader started */
  doneLabel?: string | ((seconds: number) => string)
  size?: 'sm' | 'md'
  /** "pill" = bordered capsule, "plain" = just the spinner and the label, e.g. inside a chat bubble */
  variant?: 'pill' | 'plain'
  className?: string
}

const DEFAULT_PHASES = ['正在处理']
const RAYS = Array.from({ length: 8 }, (_, i) => i)
// 75s reads "1m 15s", a long run "2h 05m" or "3d 4h"
const took = (s: number) => {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function ThinkingLoader({
  phases: phasesProp = DEFAULT_PHASES,
  interval: intervalProp = 2200,
  phase,
  loop = false,
  done = false,
  doneLabel = (s) => `Thought for ${took(s)}`,
  size = 'md',
  variant = 'pill',
  className
}: ThinkingLoaderProps) {
  // An empty or missing list still says something; 0 or NaN never spins the timer every frame
  const given = Array.isArray(phasesProp) ? phasesProp.map((p) => String(p ?? '')) : []
  const phases = given.length ? given : DEFAULT_PHASES.slice(0, 1)
  const interval = Number.isFinite(intervalProp) && intervalProp > 0 ? Math.max(intervalProp, 200) : 2200
  const [step, setStep] = useState(0)
  const [started, setStarted] = useState(() => Date.now())
  const [seconds, setSeconds] = useState<number | null>(null)

  // Read the clock in the same render that turns done on – and restart it when work starts again
  const elapsed = seconds ?? Math.max(1, Math.round((Date.now() - started) / 1000))
  if (done && seconds === null) setSeconds(elapsed)
  if (!done && seconds !== null) {
    setSeconds(null)
    setStarted(Date.now())
    setStep(0)
  }

  // Advance through the phases on a timer – unless the phase is controlled
  useEffect(() => {
    if (done || (phase !== undefined && Number.isFinite(phase)) || phases.length < 2) return
    const id = window.setInterval(() => {
      setStep((s) => (s + 1 < phases.length ? s + 1 : loop ? 0 : s))
    }, interval)
    return () => window.clearInterval(id)
  }, [done, phase, phases.length, interval, loop])

  const wanted = phase !== undefined && Number.isFinite(phase) ? Math.floor(phase) : step
  const index = Math.min(Math.max(wanted, 0), Math.max(phases.length - 1, 0))
  const label = String((done ? (typeof doneLabel === 'function' ? doneLabel(elapsed) : doneLabel) : phases[index]) ?? '')

  // The label on screen and the one rolling out – swapped during render so both animate in the same frame
  const [shown, setShown] = useState({ key: 0, text: label })
  const [leaving, setLeaving] = useState<{ key: number; text: string } | null>(null)
  if (label !== shown.text) {
    setLeaving(shown)
    setShown({ key: shown.key + 1, text: label })
  }

  // The text box takes the width of the incoming label, so the pill glides to its new size
  const root = useRef<HTMLSpanElement>(null)
  const box = useRef<HTMLSpanElement>(null)
  const current = useRef<HTMLSpanElement>(null)
  const measured = useRef(false)
  // Width of the label, capped by the room next to the spinner – a label that doesn't fit ends in "…"
  const fit = useRef(() => {})
  fit.current = () => {
    const r = root.current
    const b = box.current
    const c = current.current
    if (!r || !b || !c) return
    // Layout pixels (offset/scroll/client), so it stays right inside a CSS zoom or transform (+1 covers rounding)
    const full = c.scrollWidth + 1
    const parent = r.parentElement
    // Measured with the box at the label's full width – a parent that wraps around the pill grows with it, so only a
    // container that's really too narrow cuts the label. Without a transition, so the pill still glides from where it was.
    const was = { width: b.style.width, transition: b.style.transition }
    b.style.transition = 'none'
    b.style.width = `${full}px`
    const pad = parent ? getComputedStyle(parent) : null
    const inner = parent && pad ? parent.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) : 0
    const room = parent ? Math.floor(inner - (r.offsetWidth - b.offsetWidth)) : full
    b.style.width = was.width
    b.getBoundingClientRect()
    b.style.transition = was.transition
    const cut = room > 0 && full > room
    r.toggleAttribute('data-cut', cut)
    b.style.width = `${cut ? room : full}px`
  }
  useBrowserLayoutEffect(() => {
    const b = box.current
    if (!b) return
    if (!measured.current) b.style.transition = 'none'
    fit.current()
    if (!measured.current) {
      b.getBoundingClientRect()
      b.style.transition = ''
      measured.current = true
    }
  }, [shown.key])
  // A container that narrows or widens gets the label fitted again
  useEffect(() => {
    const parent = root.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fit.current())
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  return (
    <span
      ref={root}
      className={['ui-tlc', className].filter(Boolean).join(' ')}
      data-size={size}
      data-variant={variant}
      data-done={done || undefined}
      role="status"
      aria-live="polite"
    >
      {/* React 19 hoists this into <head> once, no matter how many loaders render */}
      <style href="ui-thinking-loader-clean" precedence="default">
        {css}
      </style>

      <span className="ui-tlc__icon" aria-hidden="true">
        <svg className="ui-tlc__spinner" viewBox="0 0 16 16">
          {RAYS.map((i) => (
            <line
              key={i}
              x1="8"
              y1="1.75"
              x2="8"
              y2="4.75"
              transform={`rotate(${i * 45} 8 8)`}
              style={{ animationDelay: `${(i - 8) * 100}ms` }}
            />
          ))}
        </svg>
        <svg className="ui-tlc__check" viewBox="0 0 16 16">
          <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
        </svg>
      </span>

      <span ref={box} className="ui-tlc__text">
        {leaving && (
          <span
            key={leaving.key}
            className="ui-tlc__label ui-tlc__label--out"
            aria-hidden="true"
            dir="auto"
            onAnimationEnd={() => setLeaving(null)}
          >
            {leaving.text}
          </span>
        )}
        <span
          key={shown.key}
          ref={current}
          className={['ui-tlc__label', shown.key > 0 && 'ui-tlc__label--in', !done && 'ui-tlc__shine'].filter(Boolean).join(' ')}
          data-text={shown.text}
          title={shown.text}
          dir="auto"
        >
          {shown.text}
        </span>
      </span>
    </span>
  )
}

/**
 * Mikka `components/agents/agent-activity/index.tsx:198-212` 的 working 行：固定 28px 高、
 * `role="status"` 的一行，内容是 `ThinkingLoader size="sm" phases={[liveLabel]}`。
 * 位置沿用本壳既有的 `ln-running-status`（ConversationView 里 run 正在跑的那一格）。
 */
export function RunningActivity({ label, className, stopping = false, onStop }: {
  label: string
  className?: string
  stopping?: boolean
  onStop?(): void
}) {
  return (
    <div
      className={['ln-running-status', className].filter(Boolean).join(' ')}
      data-state={stopping ? 'stopping' : 'working'}
      aria-busy="true"
    >
      <ThinkingLoader size="sm" phases={[label]}/>
      {onStop && <button
        type="button"
        className="ln-action is-danger"
        aria-label="停止本次运行"
        disabled={stopping}
        onClick={onStop}
      >{stopping ? '正在停止…' : '停止'}</button>}
    </div>
  )
}

/**
 * Mikka `components/workspace/issue-thread-panel.tsx:507-518` 的 activityLine：
 * 「工作了 2 分 3 秒」/「工作了 2 分 3 秒 · 失败」/「工作了 2 分 3 秒 · 已停止」
 * （文案表 `messages/zh-CN.json:4974-4982`）。时长口径与 zh-CN 的
 * `activityLine.seconds/minutes/minutesOnly/hours` 一致，因此直接复用本仓已有的
 * `formatExecutionDuration`，不再抄一份 `took()`。
 */
export function runActivitySummary(
  run: Pick<AgentRunView, 'status' | 'startedAt' | 'createdAt' | 'endedAt'>,
  now: string = new Date().toISOString()
): string {
  const worked = uiAttribute('工作了 {0}', formatExecutionDuration(run.startedAt ?? run.createdAt, run.endedAt ?? now))
  if (run.status === 'failed') return [worked, uiAttribute('失败')].join(' · ')
  if (run.status === 'cancelled') return [worked, uiAttribute('已停止')].join(' · ')
  return worked
}

/** 终止之后的 run 在 transcript 末尾留的一行状态（不是弹窗、不是活动列表里的两个字）。 */
export function RunActivityLine({ run, now }: {
  run: Pick<AgentRunView, 'id' | 'status' | 'startedAt' | 'createdAt' | 'endedAt'>
  now?: string
}) {
  return (
    <div className="ln-run-activity" data-state={run.status} data-run-id={run.id}>
      <span role="status">{runActivitySummary(run, now)}</span>
    </div>
  )
}

/**
 * 「会话活动」弹窗搬 Mikka `messages/zh-CN.json:4974-4982`：不是「名字 + 两个字」，
 * 而是「工作了 2 分 3 秒 · 失败」+ 人话原因 + 重试入口（弹窗只列当前对话的 run，
 * 所以「点进对话」就是它本来的位置）。状态短词取共享的 `agentRunPresentation()`，
 * 不再在弹窗里另维护一张 status→中文 的表。
 */
export function RunActivityHistory({ runs, agents, sending = false, onRetry }: {
  runs: readonly AgentRunView[]
  agents: readonly { agentId: string; displayName: string }[]
  sending?: boolean
  onRetry?(): void
}) {
  if (!runs.length) return <Empty className="ln-empty--inline">
    <EmptyHeader><EmptyMedia variant="icon"><Icon name="clock" size={18}/></EmptyMedia><EmptyTitle>当前对话暂无执行活动</EmptyTitle><EmptyDescription>发出消息后，这里会留下去过的运行和它们结束在哪一步。</EmptyDescription></EmptyHeader>
  </Empty>
  return <>{runs.slice().reverse().map(run => {
    const presentation = agentRunPresentation(run)
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status)
    const reason = run.status === 'failed' && run.failure ? runtimeFailureMessage(run.failure) : null
    return <div className="ln-settings-row ln-activity-row" key={run.id} data-state={run.status} data-run-id={run.id}>
      <span className="ln-activity-who"><strong>{agents.find(agent => agent.agentId === run.agentId)?.displayName || '助手'}</strong>{reason && <small>{reason}</small>}</span>
      <span className="ln-activity-state">{terminal ? runActivitySummary(run) : presentation.label}</span>
      {run.status === 'failed' && onRetry && (() => { const ux = manualRetryUx(run, runs); return ux !== 'hidden' && <button type="button" className="ln-action" disabled={sending || ux === 'automatic'} title={ux === 'automatic' ? '自动重试最多 3 次，全部失败后才需要手动重试。' : '重试前先检查已有成果，不重复外部操作。'} onClick={onRetry}>{sending ? '正在重试…' : ux === 'automatic' ? '自动重试中' : '重试'}</button> })()}
    </div>
  })}</>
}

const css = /* css */ `
.ui-tlc {
  --ui-tlc-ink: rgba(0, 0, 0, 0.88);
  --ui-tlc-text: rgba(0, 0, 0, 0.61);
  --ui-tlc-accent: rgba(0, 96, 226, 0.765);
  --ui-tlc-bg: #ffffff;
  --ui-tlc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-tlc-shine: rgba(255, 255, 255, 0.82);
  --ui-tlc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ui-tlc-h: 32px;
  --ui-tlc-font: 13px;
  --ui-tlc-lh: 20px;
  --ui-tlc-icon: 16px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: var(--ui-tlc-h);
  padding: 0 10px 0 8px;
  border-radius: 8px;
  background: var(--ui-tlc-bg);
  box-shadow: var(--ui-tlc-shadow);
  color: var(--ui-tlc-text);
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: var(--ui-tlc-font);
  font-weight: 500;
  line-height: var(--ui-tlc-lh);
  letter-spacing: -0.003em;
  max-width: 100%;
  vertical-align: middle;
  -webkit-font-smoothing: antialiased;
}
.ui-tlc[data-size="sm"] {
  --ui-tlc-h: 26px;
  --ui-tlc-font: 12px;
  --ui-tlc-lh: 16px;
  --ui-tlc-icon: 14px;
  gap: 5px;
  padding: 0 8px 0 6px;
  border-radius: 6px;
}
.ui-tlc[data-variant="plain"] {
  height: auto;
  padding: 0;
  background: none;
  box-shadow: none;
}

/* Spinner and check share one square and swap with a little scale */
.ui-tlc__icon {
  position: relative;
  flex: none;
  width: var(--ui-tlc-icon);
  height: var(--ui-tlc-icon);
}
.ui-tlc__icon svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  transition: opacity 240ms ease, transform 420ms var(--ui-tlc-ease);
}
/* Thin rays in the accent blue – they fade one after another, so the spinner turns without rotating */
.ui-tlc__spinner line {
  stroke: var(--ui-tlc-accent);
  stroke-width: 1.1;
  stroke-linecap: round;
  opacity: 0.2;
  animation: ui-tlc-ray 800ms linear infinite;
}
.ui-tlc__check {
  opacity: 0;
  transform: scale(0.6);
  fill: none;
  stroke: var(--ui-tlc-accent);
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ui-tlc__check path {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
}
.ui-tlc[data-done] .ui-tlc__spinner {
  opacity: 0;
  transform: scale(0.6) rotate(-45deg);
}
.ui-tlc[data-done] .ui-tlc__check {
  opacity: 1;
  transform: none;
}
.ui-tlc[data-done] .ui-tlc__check path {
  animation: ui-tlc-draw 360ms var(--ui-tlc-ease) 120ms forwards;
}

/* The text box glides to the width of the incoming label; labels roll through it */
/* min-width 0: in a narrow container the box gives way and the label ends in "…" */
.ui-tlc__text {
  position: relative;
  display: block;
  min-width: 0;
  height: var(--ui-tlc-lh);
  overflow: hidden;
  transition: width 460ms var(--ui-tlc-ease);
}
.ui-tlc__label {
  position: absolute;
  top: 0;
  left: 0;
  line-height: var(--ui-tlc-lh);
  white-space: nowrap;
}
.ui-tlc[data-cut] .ui-tlc__label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ui-tlc[data-done] .ui-tlc__label {
  color: var(--ui-tlc-ink);
}
.ui-tlc__label--in {
  animation: ui-tlc-in 460ms var(--ui-tlc-ease) both;
}
.ui-tlc__label--out {
  animation: ui-tlc-out 320ms var(--ui-tlc-ease) both;
}

/* A darker band sweeping through the gray label while it works */
.ui-tlc__shine::after {
  content: attr(data-text);
  content: attr(data-text) / "";
  position: absolute;
  inset: 0;
  white-space: nowrap;
  color: transparent;
  background: linear-gradient(90deg, transparent 38%, var(--ui-tlc-shine) 50%, transparent 62%) 100% 0 / 300% 100% no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  animation: ui-tlc-sweep 1.6s linear infinite;
  pointer-events: none;
}

@keyframes ui-tlc-ray {
  0% { opacity: 1; }
  100% { opacity: 0.2; }
}
@keyframes ui-tlc-in {
  from { opacity: 0; transform: translateY(70%); filter: blur(3px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes ui-tlc-out {
  from { opacity: 1; transform: none; filter: none; }
  to { opacity: 0; transform: translateY(-70%); filter: blur(3px); }
}
@keyframes ui-tlc-draw {
  to { stroke-dashoffset: 0; }
}
@keyframes ui-tlc-sweep {
  from { background-position: 100% 0; }
  to { background-position: 0% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-tlc *,
  .ui-tlc *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
  .ui-tlc__spinner line { opacity: 0.6; }
  .ui-tlc__shine::after { display: none; }
  .ui-tlc__check path { stroke-dashoffset: 0; }
}

/* Dark mode: Mikka 认 .dark 或 data-theme="dark"；本壳的主题值是 day/night，选择器跟着换。 */
:where(.dark, [data-theme="dark"], [data-theme="night"]) .ui-tlc {
  --ui-tlc-ink: rgba(255, 255, 255, 0.9);
  --ui-tlc-text: rgba(255, 255, 255, 0.62);
  --ui-tlc-accent: #4d8dff;
  --ui-tlc-bg: #1c1c1e;
  --ui-tlc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px rgba(0, 0, 0, 0.4);
  --ui-tlc-shine: #ffffff;
}
`
