import { describe, expect, it } from 'vitest'
import { builtinMemberAvatarRef } from '@contracts'
import {
  BUILTIN_MEMBER_AVATAR_ASSETS,
  BUILTIN_MEMBER_BOT_DEFAULTS,
  builtinMemberAvatarAssets,
  builtinMemberBotAvatar
} from './member-avatar-registry'
import { openBotAvatarShape } from './open-bot-avatar-catalog'

describe('member avatar registry', () => {
  it('resolves every canonical builtin reference to the single current appearance set', () => {
    for (const role of ['luoke', 'muwa', 'mianzhi', 'qilu'] as const) {
      const assets = builtinMemberAvatarAssets(builtinMemberAvatarRef(role))
      expect(assets).toEqual(BUILTIN_MEMBER_AVATAR_ASSETS[role])
      expect(Object.values(assets ?? {})).toHaveLength(1)
      expect(assets?.icon).toBeTruthy()
    }
  })

  it('does not treat managed, malformed, or legacy values as builtin assets', () => {    expect(builtinMemberAvatarAssets(null)).toBeNull()
    expect(builtinMemberAvatarAssets('rovai://member-avatar/builtin/luoke/v2')).toBeNull()
    expect(
      builtinMemberAvatarAssets(
        'rovai://member-avatar/managed/123e4567-e89b-12d3-a456-426614174000'
      )
    ).toBeNull()
    expect(builtinMemberAvatarAssets('https://example.com/avatar.png')).toBeNull()
  })

  it('maps all four builtin roles to four distinct animated defaults', () => {
    const seeds = (['luoke', 'muwa', 'mianzhi', 'qilu'] as const).map(role => {
      const bot = builtinMemberBotAvatar(builtinMemberAvatarRef(role))
      expect(bot, role).not.toBeNull()
      expect(bot?.id).toBe(BUILTIN_MEMBER_BOT_DEFAULTS[role].id)
      expect(bot?.color).toBe(BUILTIN_MEMBER_BOT_DEFAULTS[role].color)
      expect(bot?.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(bot?.definition.id).toBe(bot?.id)
      return `${bot?.id}/${bot?.color}`
    })
    expect(new Set(seeds).size).toBe(4)
    expect(seeds).toEqual([
      'cat/#8b5cf6',
      'ghost/#14b3a5',
      'book/#f97316',
      'bunny/#ec4899'
    ])
  })

  it('falls back to the legacy PNG for non-builtin refs and unknown shapes', () => {
    expect(builtinMemberBotAvatar(null)).toBeNull()
    expect(
      builtinMemberBotAvatar('rovai://member-avatar/builtin/luoke/v2')
    ).toBeNull()
    expect(
      builtinMemberBotAvatar(
        'rovai://member-avatar/managed/123e4567-e89b-12d3-a456-426614174000'
      )
    ).toBeNull()
    expect(
      builtinMemberBotAvatar(
        'rovai://member-avatar/bot/star/f97316/123e4567-e89b-12d3-a456-426614174000/v1'
      )
    ).toBeNull()
    // A defaults entry pointing at a shape the catalog does not ship must
    // report failure instead of a half-applied avatar.
    const original = BUILTIN_MEMBER_BOT_DEFAULTS.luoke
    expect(openBotAvatarShape('definitely-missing')).toBeNull()
    expect(builtinMemberBotAvatar(builtinMemberAvatarRef('luoke'))).toEqual({
      id: 'cat',
      color: '#8b5cf6',
      definition: openBotAvatarShape('cat')?.definition
    })
    expect(original).toEqual({ id: 'cat', color: '#8b5cf6' })
  })
})
