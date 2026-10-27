import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlledMemberBotAvatarSourceResolver } from './member-bot-avatar-source'

const PNG_192 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 192, 0, 0, 0, 192,
  8, 6, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 73, 69, 78, 68,
  0, 0, 0, 0
])

describe('controlled member Bot avatar source resolver', () => {
  it('resolves the exact packaged icon for a built-in member avatar', async () => {
    const managed = { read: vi.fn() }
    const readBuiltin = vi.fn(async () => PNG_192)
    const resolver = new ControlledMemberBotAvatarSourceResolver(managed, readBuiltin)

    await expect(resolver.resolve(
      'rovai://member-avatar/builtin/luoke/v1'
    )).resolves.toEqual({
      pngBytes: PNG_192,
      width: 192,
      height: 192
    })
    expect(readBuiltin).toHaveBeenCalledWith('luoke')
    expect(managed.read).not.toHaveBeenCalled()
  })

  it('reads a managed icon through the existing integrity-checking avatar store', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const managed = {
      read: vi.fn(async () => ({
        mediaType: 'image/png' as const,
        bytes,
        width: 192,
        height: 192,
        crop: { centerX: 96, centerY: 96, size: 192 }
      }))
    }
    const resolver = new ControlledMemberBotAvatarSourceResolver(managed, vi.fn())
    const avatarRef = 'rovai://member-avatar/managed/2b945f3f-4b45-4ae5-92b2-739fce600338'

    await expect(resolver.resolve(avatarRef)).resolves.toEqual({
      pngBytes: bytes,
      width: 192,
      height: 192
    })
    expect(managed.read).toHaveBeenCalledWith(avatarRef, 'icon', 192)
  })

  it('freezes publication bytes across changed profiles, restarts and concurrent retries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rovai-avatar-export-'))
    const ref = 'rovai://member-avatar/managed/2b945f3f-4b45-4ae5-92b2-739fce600338'
    const read = vi.fn(async () => ({ mediaType: 'image/png' as const, bytes: PNG_192,
      width: 192, height: 192, crop: { centerX: .5, centerY: .5, size: 1 } }))
    try {
      const resolver = new ControlledMemberBotAvatarSourceResolver({ read }, vi.fn(), directory)
      const options = { publicationIntentId: 'publication-1' }
      const results = await Promise.all([resolver.resolve(ref, options), resolver.resolve(ref, options)])
      expect(results[0]).toEqual(results[1])
      const restarted = new ControlledMemberBotAvatarSourceResolver({ read: vi.fn(() => { throw new Error('must use frozen file') }) }, vi.fn(), directory)
      expect(await restarted.resolve(null, options)).toEqual(results[0])
      expect(await resolver.resolve(null, { publicationIntentId: 'no-avatar' })).toBeUndefined()
      expect(await restarted.resolve(ref, { publicationIntentId: 'no-avatar' })).toBeUndefined()
      const required = { publicationIntentId: 'image-required', allowDefaultAvatar: false }
      expect(await resolver.resolve(null, required)).toBeUndefined()
      const supplied = await resolver.resolve(ref, required)
      expect(supplied?.pngBytes).toEqual(PNG_192)
      expect(await restarted.resolve(null, required)).toEqual(supplied)
      const linked = join(directory, 'linked')
      await symlink(directory, linked, 'dir')
      const unsafe = new ControlledMemberBotAvatarSourceResolver({ read }, vi.fn(), linked)
      await expect(unsafe.resolve(ref, options)).rejects.toThrow('snapshot_invalid')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('uses the Rovai fallback only when the member has no avatar reference', async () => {
    const resolver = new ControlledMemberBotAvatarSourceResolver(
      { read: vi.fn() },
      vi.fn()
    )

    await expect(resolver.resolve(null)).resolves.toBeUndefined()
    await expect(resolver.resolve('https://example.com/avatar.png'))
      .rejects.toThrow('feishu_member_bot_avatar_ref_invalid')
  })

  it('fails closed when an assigned managed avatar cannot be read', async () => {
    const resolver = new ControlledMemberBotAvatarSourceResolver(
      { read: vi.fn(async () => null) },
      vi.fn()
    )

    await expect(resolver.resolve(
      'rovai://member-avatar/managed/2b945f3f-4b45-4ae5-92b2-739fce600338'
    )).rejects.toThrow('feishu_member_bot_avatar_unavailable')
  })

  it('maps a corrupt packaged icon to the stable unavailable error', async () => {
    const resolver = new ControlledMemberBotAvatarSourceResolver(
      { read: vi.fn() },
      vi.fn(async () => new Uint8Array([1, 2, 3]))
    )

    await expect(resolver.resolve(
      'rovai://member-avatar/builtin/luoke/v1'
    )).rejects.toThrow('feishu_member_bot_avatar_unavailable')
  })
})
