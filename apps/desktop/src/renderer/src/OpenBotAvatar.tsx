import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { mountAvatar, type AvatarOptions, type MountedAvatar } from 'open-bot-avatar/dom'
import type { AvatarDefinition, AvatarMotion } from 'open-bot-avatar'

/** Only an explicit user choice is stored; nothing is written by default. */
const MOTION_STORAGE_KEY = 'loom.member-avatar.motion'
const MOTION_EVENT = 'loom:member-avatar-motion'
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

function storedPreference(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(MOTION_STORAGE_KEY)
    return value === 'enable' || value === 'disable' ? value : null
  } catch {
    return null
  }
}

function systemPrefersReduced(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia(REDUCED_QUERY).matches
}

function motionSnapshot(): string {
  return `${storedPreference() ?? 'system'}|${systemPrefersReduced() ? 'reduce' : 'no-preference'}`
}

/** Without a window there is no store and no media query: stay still. */
function serverMotionSnapshot(): string {
  return 'system|reduce'
}

function animateFromSnapshot(snapshot: string): boolean {
  const [stored, media] = snapshot.split('|')
  if (stored === 'disable') return false
  if (stored === 'enable') return true
  return media === 'no-preference'
}

function subscribeMotion(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onStorage = (event: StorageEvent): void => {
    if (event.key === MOTION_STORAGE_KEY || event.key === null) listener()
  }
  const media = window.matchMedia?.(REDUCED_QUERY)
  const onMedia = (): void => listener()
  window.addEventListener('storage', onStorage)
  window.addEventListener(MOTION_EVENT, listener)
  media?.addEventListener('change', onMedia)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(MOTION_EVENT, listener)
    media?.removeEventListener('change', onMedia)
  }
}

/**
 * Whether avatars should animate right now: the explicit local choice if the
 * user made one, otherwise the system preference. Both MemberAvatar and the
 * picker read this, so one toggle updates every visible avatar.
 */
export function useAvatarMotionEnabled(): boolean {
  const snapshot = useSyncExternalStore(
    subscribeMotion,
    motionSnapshot,
    serverMotionSnapshot
  )
  return animateFromSnapshot(snapshot)
}

/** Persists an explicit per-browser choice and notifies this tab. */
export function setAvatarMotionEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MOTION_STORAGE_KEY, enabled ? 'enable' : 'disable')
  } catch {
    // Storage refused: still notify, so the current tab reflects the choice.
  }
  window.dispatchEvent(new Event(MOTION_EVENT))
}

export interface OpenBotAvatarOptions {
  definition: AvatarDefinition
  /** Body color, `#rrggbb` or any CSS color. */
  color: string
  /** Known motion state. Idle is the only state the product drives today. */
  motion?: AvatarMotion
  /** Accessible name; empty string marks the avatar decorative. */
  label: string
  /** Eyes and body follow the real pointer. Defaults to on in the component. */
  followPointer?: boolean
  /** Effective motion permission, resolved by the caller from the hook above. */
  reducedMotion?: boolean
}

export interface OpenBotAvatarHandle {
  mount(host: HTMLElement, options: OpenBotAvatarOptions): void
  update(options: OpenBotAvatarOptions): void
  destroy(): void
}

function avatarOptions(options: OpenBotAvatarOptions): AvatarOptions {
  return {
    definition: options.definition,
    color: options.color,
    mood: options.motion ?? 'idle',
    label: options.label,
    followPointer: options.followPointer ?? false,
    // Blinking, the shared frame clock and reduced-motion handling stay upstream.
    reducedMotion: options.reducedMotion ?? true
  }
}

/**
 * The one lifetime the engine allows: `mountAvatar` once per host, option
 * changes through `update`, and exactly one `destroy`. Kept free of React so it
 * can be driven directly in tests.
 */
export function createOpenBotAvatarHandle(): OpenBotAvatarHandle {
  let mounted: MountedAvatar | null = null
  return {
    mount(host, options) {
      mounted?.destroy()
      mounted = mountAvatar(host, avatarOptions(options))
    },
    update(options) {
      mounted?.update(avatarOptions(options))
    },
    destroy() {
      mounted?.destroy()
      mounted = null
    }
  }
}

export interface OpenBotAvatarProps extends OpenBotAvatarOptions {
  className?: string
}

/** Thin React binding of the upstream engine, shared by every bot avatar. */
export function OpenBotAvatar({
  definition,
  color,
  motion = 'idle',
  label,
  followPointer = true,
  className
}: OpenBotAvatarProps): React.JSX.Element {
  const animate = useAvatarMotionEnabled()
  const host = useRef<HTMLSpanElement>(null)
  const handle = useRef<OpenBotAvatarHandle | null>(null)
  const current = useCallback(
    () => (handle.current ??= createOpenBotAvatarHandle()),
    []
  )
  useEffect(() => {
    const element = host.current
    if (!element) return
    const avatar = current()
    avatar.mount(element, { definition, color, motion, label, followPointer, reducedMotion: !animate })
    return () => avatar.destroy()
    // Mount once per host: later option changes go through `update` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    handle.current?.update({
      definition,
      color,
      motion,
      label,
      followPointer,
      reducedMotion: !animate
    })
  }, [definition, color, motion, label, followPointer, animate])
  return (
    <span
      ref={host}
      className={className ? `open-bot-avatar ${className}` : 'open-bot-avatar'}
    />
  )
}
