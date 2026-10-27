import {
  parseControlledMemberAvatarRef,
  type BuiltinMemberAvatarRole
} from '@contracts'
import luokeIcon from './assets/characters/luoke/icon-192.png'
import mianzhiIcon from './assets/characters/mianzhi/icon-192.png'
import muwaIcon from './assets/characters/muwa/icon-192.png'
import qiluIcon from './assets/characters/qilu/icon-192.png'

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
