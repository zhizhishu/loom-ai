import { describe, expect, it } from 'vitest'
import {
  botMemberAvatarRef,
  builtinMemberAvatarRef,
  clampControlledMemberAvatarCrop,
  managedMemberAvatarRef,
  parseControlledMemberAvatarRef
} from './member-avatar'

describe('controlled member avatar references', () => {
  it('parses canonical builtin and managed references', () => {
    expect(parseControlledMemberAvatarRef(builtinMemberAvatarRef('luoke'))).toEqual({
      kind: 'builtin',
      role: 'luoke',
      version: 1,
      value: 'rovai://member-avatar/builtin/luoke/v1'
    })
    const managed =
      'rovai://member-avatar/managed/2b945f3f-4b45-4ae5-92b2-739fce600338'
    expect(parseControlledMemberAvatarRef(managed)).toEqual({
      kind: 'managed',
      assetId: '2b945f3f-4b45-4ae5-92b2-739fce600338',
      value: managed
    })
  })

  it('rejects unsafe and non-canonical references', () => {
    for (const value of [
      '',
      'builtin://camp-companions/luoke/v1',
      'managed://member-avatars/2b945f3f-4b45-4ae5-92b2-739fce600338',
      'file:///tmp/avatar.png',
      'https://example.com/avatar.png',
      'data:image/png;base64,AAAA',
      '/tmp/avatar.png',
      'rovai://member-avatar/builtin/unknown/v1',
      'rovai://member-avatar/builtin/luoke/v2',
      'rovai://member-avatar/builtin/luoke/v1/',
      'rovai://member-avatar/builtin/luoke/v1?size=32',
      'rovai://member-avatar/builtin/luoke/v1#preview',
      'rovai://member-avatar/managed/------------------------------------',
      'rovai://member-avatar/managed/2B945F3F-4B45-4AE5-92B2-739FCE600338',
      'ROVAI://MEMBER-AVATAR/builtin/luoke/v1',
      'rovai://member-avatar/managed/2b945f3f-4b45-4ae5-92b2-739fce600338/extra',
      'rovai://member-avatar/managed/2b945f3f-4b45-4ae5-92b2-739fce600338%2Fextra'
    ]) {
      expect(parseControlledMemberAvatarRef(value), value).toBeNull()
    }
  })

  it('does not construct a managed ref from an invalid id', () => {
    expect(() => managedMemberAvatarRef('------------------------------------')).toThrow(
      'canonical lowercase UUID'
    )
  })

  it('round-trips a bot reference with its managed still asset', () => {
    const assetId = '2b945f3f-4b45-4ae5-92b2-739fce600338'
    const value = botMemberAvatarRef('witch-hat', '#F97316', assetId)
    expect(value).toBe(
      `rovai://member-avatar/bot/witch-hat/f97316/${assetId}/v1`
    )
    expect(parseControlledMemberAvatarRef(value)).toEqual({
      kind: 'bot',
      id: 'witch-hat',
      color: '#f97316',
      assetId,
      value
    })
  })

  it('rejects non-canonical bot references', () => {
    const assetId = '2b945f3f-4b45-4ae5-92b2-739fce600338'
    for (const value of [
      `rovai://member-avatar/bot/Witch/f97316/${assetId}/v1`,
      `rovai://member-avatar/bot/-witch/f97316/${assetId}/v1`,
      `rovai://member-avatar/bot/witch_hat/f97316/${assetId}/v1`,
      `rovai://member-avatar/bot/${'a'.repeat(49)}/f97316/${assetId}/v1`,
      `rovai://member-avatar/bot/witch-hat/F97316/${assetId}/v1`,
      `rovai://member-avatar/bot/witch-hat/f9731/${assetId}/v1`,
      `rovai://member-avatar/bot/witch-hat/f97316/${assetId.toUpperCase()}/v1`,
      `rovai://member-avatar/bot/witch-hat/f97316/${assetId}/v2`,
      `rovai://member-avatar/bot/witch-hat/f97316/${assetId}`,
      `rovai://member-avatar/bot//f97316/${assetId}/v1`
    ]) {
      expect(parseControlledMemberAvatarRef(value), value).toBeNull()
    }
  })

  it('refuses to build a bot ref from an unsafe shape, color or asset', () => {
    const assetId = '2b945f3f-4b45-4ae5-92b2-739fce600338'
    expect(() => botMemberAvatarRef('Witch', '#f97316', assetId)).toThrow('slug')
    expect(() => botMemberAvatarRef('witch-hat', '#F9731', assetId)).toThrow(
      '#rrggbb'
    )
    expect(() => botMemberAvatarRef('witch-hat', '#f97316', 'nope')).toThrow(
      'canonical lowercase UUID'
    )
  })

  it('clamps shared crop values without allowing an out-of-bounds square', () => {
    const crop = clampControlledMemberAvatarCrop(
      { centerX: -1, centerY: 2, size: 2 },
      1600,
      1000
    )
    expect(crop).toEqual({ centerX: 0.3125, centerY: 0.5, size: 1 })
    expect(() =>
      clampControlledMemberAvatarCrop(
        { centerX: Number.NaN, centerY: 0.5, size: 0.5 },
        1000,
        1000
      )
    ).toThrow('finite')
  })
})
