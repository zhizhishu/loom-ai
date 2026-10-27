import { useEffect, useRef, useState } from 'react'

export const STARTUP_LOADING_EXIT_MS = 180

type StartupLoadingPhase = 'hidden' | 'visible' | 'exiting'

export function StartupLoadingCanvas({
  visible,
  route = 'location',
  label = '正在打开会话'
}: {
  visible: boolean
  route?: string
  label?: string
}): React.JSX.Element | null {
  const [phase, setPhase] = useState<StartupLoadingPhase>(visible ? 'visible' : 'hidden')
  const surfaceRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (visible) {
      setPhase('visible')
      return undefined
    }

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (reduceMotion) {
      setPhase('hidden')
      return undefined
    }

    setPhase((current) => current === 'hidden' ? current : 'exiting')
    const timer = window.setTimeout(() => setPhase('hidden'), STARTUP_LOADING_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  useEffect(() => {
    if (phase === 'visible') {
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body && active !== surfaceRef.current) {
        previousFocusRef.current = active
      }
      surfaceRef.current?.focus({ preventScroll: true })
      return
    }
    if (phase !== 'hidden') return
    const previous = previousFocusRef.current
    previousFocusRef.current = null
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }, [phase])

  if (phase === 'hidden') return null

  return (
    <section
      ref={surfaceRef}
      className={`startup-loading-canvas${phase === 'exiting' ? ' is-exiting' : ''}`}
      data-startup-route={route}
      data-startup-status={phase === 'exiting' ? 'exiting' : 'loading'}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        event.preventDefault()
        surfaceRef.current?.focus({ preventScroll: true })
      }}
    >
      <svg
        className="startup-loading-mark"
        data-brand-mark="horizon"
        data-brand-layout="separated"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 2 L13.16 7.3 L17.76 8.84 L13.16 10.38 L12 15.68 L10.84 10.38 L6.24 8.84 L10.84 7.3 Z" fill="currentColor" />
        <path d="M3 20.96 Q12 15.96 21 20.96" fill="none" stroke="currentColor" strokeWidth="2.08" strokeLinecap="round" />
        <circle className="brand-rendezvous-point" data-brand-point="rendezvous" cx="12" cy="18.46" r="1.05" />
      </svg>
      <span className="sr-only">{label}</span>
    </section>
  )
}
