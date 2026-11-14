import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AvatarOptions } from 'open-bot-avatar/dom'

const mountAvatar = vi.fn((_host: HTMLElement, _options: AvatarOptions) => ({
  update: vi.fn(),
  destroy: vi.fn()
}))

vi.mock('open-bot-avatar/dom', () => ({ mountAvatar }))

const { createOpenBotAvatarHandle } = await import('./OpenBotAvatar')

const definition = {
  version: 1 as const,
  id: 'star',
  name: 'Star',
  body: { path: 'M50 8 L92 92 H8 Z' },
  eyes: { x: 50, y: 58, spacing: 16, scale: 1 }
}

describe('OpenBotAvatar lifecycle', () => {
  beforeEach(() => {
    mountAvatar.mockClear()
  })

  it('mounts once, pushes updates through update, and destroys exactly once', () => {
    const handle = createOpenBotAvatarHandle()
    const host = {} as HTMLElement

    handle.mount(host, { definition, color: '#1f7cf2', label: '' })
    expect(mountAvatar).toHaveBeenCalledTimes(1)
    const mounted = mountAvatar.mock.results[0].value
    expect(mountAvatar.mock.calls[0][1]).toMatchObject({
      definition,
      color: '#1f7cf2',
      mood: 'idle',
      label: '',
      followPointer: false,
      reducedMotion: true
    })

    handle.update({ definition, color: '#f97316', label: '', motion: 'thinking' })
    expect(mountAvatar).toHaveBeenCalledTimes(1)
    expect(mounted.update).toHaveBeenCalledWith(
      expect.objectContaining({ color: '#f97316', mood: 'thinking' })
    )

    handle.destroy()
    handle.destroy()
    expect(mounted.destroy).toHaveBeenCalledTimes(1)
    expect(mountAvatar).toHaveBeenCalledTimes(1)
  })

  it('re-mounts on a new host and leaves no stale avatar behind', () => {
    const handle = createOpenBotAvatarHandle()
    handle.mount({} as HTMLElement, { definition, color: '#1f7cf2', label: 'Star' })
    handle.mount({} as HTMLElement, { definition, color: '#1f7cf2', label: 'Star' })
    expect(mountAvatar.mock.results[0].value.destroy).toHaveBeenCalledTimes(1)
    expect(mountAvatar).toHaveBeenCalledTimes(2)
  })
})
