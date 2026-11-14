import {
  MEMBER_AVATAR_BOT_COLOR_PATTERN,
  parseControlledMemberAvatarRef,
  type BuiltinMemberAvatarRole
} from '@contracts'
import type { AvatarDefinition } from 'open-bot-avatar'
import luokeIcon from './assets/characters/luoke/icon-192.png'
import mianzhiIcon from './assets/characters/mianzhi/icon-192.png'
import muwaIcon from './assets/characters/muwa/icon-192.png'
import qiluIcon from './assets/characters/qilu/icon-192.png'
import defaults from './assets/open-bot-avatar/defaults.json'
import { openBotAvatarShape } from './open-bot-avatar-catalog'

export interface BuiltinMemberAvatarAssets {
  icon: string
}

export const BUILTIN_MEMBER_AVATAR_ASSETS: Readonly<
  Record<BuiltinMemberAvatarRole, BuiltinMemberAvatarAssets>
> = {
  luoke: {
    icon: luokeIcon,
  },
  muwa: {
    icon: muwaIcon,
  },
  mianzhi: {
    icon: mianzhiIcon,
  },
  qilu: {
    icon: qiluIcon,
  }
}

export function builtinMemberAvatarAssets(
  avatarRef: string | null
): BuiltinMemberAvatarAssets | null {
  if (!avatarRef) return null
  const parsed = parseControlledMemberAvatarRef(avatarRef)
  return parsed?.kind === 'builtin'
    ? BUILTIN_MEMBER_AVATAR_ASSETS[parsed.role]
    : null
}

export interface BuiltinMemberBotAvatar {
  /** Catalog shape id from the defaults map. */
  id: string
  /** Body color, `#rrggbb`. */
  color: string
  definition: AvatarDefinition
}

/** The seed library: which upstream shape and color each builtin role shows. */
export const BUILTIN_MEMBER_BOT_DEFAULTS: Readonly<
  Record<BuiltinMemberAvatarRole, { id: string; color: string }>
> = defaults

/**
 * The animated appearance for a builtin role. Builtin refs stay exactly as they
 * are, so existing members get the new look with no data migration; only a
 * missing shape or an off-spec color falls back (null) to the old PNG.
 */
export function builtinMemberBotAvatar(
  avatarRef: string | null
): BuiltinMemberBotAvatar | null {
  if (!avatarRef) return null
  const parsed = parseControlledMemberAvatarRef(avatarRef)
  if (parsed?.kind !== 'builtin') return null
  const entry = BUILTIN_MEMBER_BOT_DEFAULTS[parsed.role]
  if (!entry || !MEMBER_AVATAR_BOT_COLOR_PATTERN.test(entry.color)) return null
  const shape = openBotAvatarShape(entry.id)
  if (!shape) return null
  return { id: shape.id, color: entry.color, definition: shape.definition }
}
