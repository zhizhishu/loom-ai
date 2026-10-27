import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Keep a clicked summary at its screen coordinate through disclosure and async reflow.
 * Wheel/touch/scroll keys release the anchor before native scrolling. The minimal
 * trailing space lets a row near the end stay put when its result is collapsed.
 */
export function useExecutionDisclosureAnchor(
  viewport: RefObject<HTMLDivElement | null>,
  owner: string,
  stopFollowing: () => void
): void {
  const stopFollowingRef = useRef(stopFollowing)
  stopFollowingRef.current = stopFollowing
  useLayoutEffect(() => {
    const host = viewport.current
    const content = host?.querySelector<HTMLElement>('.execution-process-timeline')
    const space = host?.querySelector<HTMLElement>('.execution-reading-space')
    if (!host || !content || !space) return
    const drawer = host.closest<HTMLElement>('.execution-drawer')
    let anchor: { summary: HTMLElement; offset: number } | null = null
    let frame = 0
    const publish = () => host.dispatchEvent(new Event('execution-disclosure-anchor'))
    const clear = () => {
      anchor = null
      delete host.dataset.executionDisclosureAnchor
      delete host.dataset.executionAnchorKey
      delete host.dataset.executionAnchorRun
      publish()
    }
    const restore = () => {
      frame = 0
      if (!anchor) return
      if (!host.contains(anchor.summary)) {
        const key = host.dataset.executionAnchorKey
        const runId = host.dataset.executionAnchorRun
        const root = runId ? host.querySelector(`[data-execution-run-id="${CSS.escape(runId)}"], [data-agent-run-id="${CSS.escape(runId)}"]`) : host
        const rows = key ? [...(root?.querySelectorAll<HTMLElement>(`[data-execution-item-key="${CSS.escape(key)}"], [data-execution-item-keys~="${CSS.escape(key)}"]`) ?? [])] : []
        const row = rows.find(row => !row.querySelector('[data-execution-item-key]')) ?? rows[0]
        const replacement = row?.querySelector<HTMLElement>(':scope > summary')
        if (!replacement) { clear(); return }
        anchor.summary = replacement
      }
      const delta = anchor.summary.getBoundingClientRect().top - host.getBoundingClientRect().top - anchor.offset
      const nextTop = Math.max(0, host.scrollTop + delta)
      const oldSpace = Number.parseFloat(space.style.height) || 0
      const contentMaximum = host.scrollHeight - oldSpace - host.clientHeight
      const needed = Math.max(0, Math.ceil(nextTop - contentMaximum))
      if (Math.abs(needed - oldSpace) >= 1) space.style.height = `${needed}px`
      if (Math.abs(delta) >= 0.5) host.scrollTop = nextTop
      host.dataset.executionAdjustedTop = String(host.scrollTop)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(restore) }
    const capture = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.button !== 0) return
      if (event.target.closest('a, .tool-file-link')) return
      const summary = event.target.closest<HTMLElement>('summary.tool-call-summary, summary.tool-group-summary, summary.mobile-run-summary')
        ?? event.target.closest('.tool-result-retry')?.closest('details')?.querySelector<HTMLElement>(':scope > summary')
      if (!summary || !host.contains(summary)) return
      // A content-sized bottom drawer would otherwise grow upward on first open.
      // Keep its current shell height; explicit user resizing still wins via inline height.
      if (drawer?.classList.contains('execution-drawer-bottom')) drawer.style.setProperty('--execution-reading-height', `${drawer.getBoundingClientRect().height}px`)
      anchor = { summary, offset: summary.getBoundingClientRect().top - host.getBoundingClientRect().top }
      host.dataset.executionDisclosureAnchor = 'true'
      const item = summary.closest<HTMLElement>('[data-execution-item-key]')
      const run = summary.closest<HTMLElement>('[data-execution-run-id], [data-agent-run-id]')
      if (item?.dataset.executionItemKey) host.dataset.executionAnchorKey = item.dataset.executionItemKey
      if (run) host.dataset.executionAnchorRun = run.dataset.executionRunId ?? run.dataset.agentRunId!
      host.dataset.followingLatest = 'false'
      stopFollowingRef.current()
      publish()
      schedule()
    }
    const release = () => { if (anchor) clear() }
    const keydown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Element)) return
      if ((event.key === ' ' || event.key === 'Enter') && event.target.closest('summary, button')) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) release()
    }
    const pointerdown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.target === host) release()
    }
    const scroll = () => {
      if (anchor) { restore(); return }
      // Remove only space above the current bottom boundary; never clamp a reader.
      const height = Number.parseFloat(space.style.height) || 0
      if (height) {
        const remaining = Math.max(0, Math.ceil(host.scrollTop + host.clientHeight - (host.scrollHeight - height)))
        if (remaining < height) space.style.height = `${remaining}px`
      }
    }
    const latest = () => { clear(); space.style.height = '0px' }
    const resize = new ResizeObserver(restore)
    resize.observe(content)
    resize.observe(host)
    const mutations = new MutationObserver(schedule)
    mutations.observe(content, { childList: true, subtree: true, characterData: true })
    host.addEventListener('click', capture, true)
    host.addEventListener('wheel', release, { passive: true })
    host.addEventListener('touchmove', release, { passive: true })
    host.addEventListener('pointerdown', pointerdown, true)
    host.addEventListener('keydown', keydown, true)
    host.addEventListener('scroll', scroll, { passive: true })
    host.addEventListener('execution-return-latest', latest)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect(); mutations.disconnect()
      host.removeEventListener('click', capture, true)
      host.removeEventListener('wheel', release)
      host.removeEventListener('touchmove', release)
      host.removeEventListener('pointerdown', pointerdown, true)
      host.removeEventListener('keydown', keydown, true)
      host.removeEventListener('scroll', scroll)
      host.removeEventListener('execution-return-latest', latest)
      clear()
      space.style.height = '0px'
      drawer?.style.removeProperty('--execution-reading-height')
    }
  }, [viewport, owner])
}
