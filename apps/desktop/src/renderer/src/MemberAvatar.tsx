import { uiAttribute } from './interface-language'
import { useState, type CSSProperties } from 'react'
import { parseControlledMemberAvatarRef } from '@contracts'
import { builtinMemberAvatarAssets, builtinMemberBotAvatar } from './member-avatar-registry'
import { firstGrapheme } from './member-identity'
import { identityColorToken } from './theme'
import { avatarDisplayStyle } from './member-avatar-crop'
import { useManagedAvatarUrl } from './use-managed-avatar'
import { OpenBotAvatar } from './OpenBotAvatar'
import { openBotAvatarShape } from './open-bot-avatar-catalog'

export type MemberAvatarSize = 'execution' | 'mention' | 'list' | 'workspace' | 'picker' | 'profile'

const MEMBER_AVATAR_PIXEL_SIZE: Readonly<
  Record<MemberAvatarSize, number>
> = {
  execution: 20,
  mention: 28,
  list: 32,
  workspace: 34,
  picker: 44,
  profile: 50
}

export interface MemberAvatarProps {
  agentId: string
  avatarRef: string | null
  displayName: string
  size?: MemberAvatarSize
  decorative?: boolean
  className?: string
}

export function MemberAvatar({
  agentId,
  avatarRef,
  displayName,
  size = 'list',
  decorative = false,
  className
}: MemberAvatarProps): React.JSX.Element {
  const parsed = avatarRef ? parseControlledMemberAvatarRef(avatarRef) : null
  const builtin = builtinMemberAvatarAssets(avatarRef)
  const builtinBot = builtinMemberBotAvatar(avatarRef)
  const managed = useManagedAvatarUrl(avatarRef, 'icon')
  const renditionKey = parsed?.kind === 'builtin'
    ? `${avatarRef}:glyph`
    : parsed?.kind === 'bot'
      ? `${avatarRef}:bot`
      : parsed?.kind === 'managed'
        ? `${avatarRef}:icon`
        : 'fallback'
  const [failedRenditionKey, setFailedRenditionKey] = useState<string | null>(null)
  const failed = failedRenditionKey === renditionKey
  const hasManagedImage = parsed?.kind === 'managed' && managed.url && !failed
  const botShape = parsed?.kind === 'bot' ? openBotAvatarShape(parsed.id) : null
  const hasBuiltinImage = parsed?.kind === 'builtin' && builtin && !failed && !builtinBot
  const hasBotAvatar = Boolean(parsed?.kind === 'bot' && parsed.color && botShape)
  const style = {
    '--member-avatar-accent': identityColorToken(agentId),
    '--member-avatar-size': `${MEMBER_AVATAR_PIXEL_SIZE[size]}px`
  } as CSSProperties
  const semanticProps = decorative
    ? { 'aria-hidden': true }
    : { role: 'img', 'aria-label': uiAttribute("{0}的头像", String(displayName)) }

  return (
    <span
      className={[
        'member-avatar',
        managed.loading ? 'member-avatar--loading' : '',
        className ?? ''
      ].filter(Boolean).join(' ')}
      style={style}
      aria-busy={!decorative && managed.loading ? true : undefined}
      {...semanticProps}
    >
      {hasBuiltinImage && (
        <img
          className="member-avatar-image"
          src={builtin.icon}
          alt=""
          draggable={false}
          onError={() => setFailedRenditionKey(renditionKey)}
        />
      )}
      {builtinBot && (
        <OpenBotAvatar
          definition={builtinBot.definition}
          color={builtinBot.color}
          label=""
          className="member-avatar-bot"
        />
      )}
      {hasBotAvatar && parsed?.kind === 'bot' && botShape && (
        <OpenBotAvatar
          definition={botShape.definition}
          color={parsed.color}
          // The surrounding member-avatar span owns the accessible name.
          label=""
          className="member-avatar-bot"
        />
      )}
      {hasManagedImage && (
        <img
          className="member-avatar-image"
          src={managed.url ?? undefined}
          style={managed.image?.displayCrop ? avatarDisplayStyle(managed.image.displayCrop, managed.image.width, managed.image.height) : undefined}
          alt=""
          draggable={false}
          onError={() => setFailedRenditionKey(renditionKey)}
        />
      )}
      {!hasBuiltinImage && !hasManagedImage && !hasBotAvatar && !builtinBot && (
        <span className="member-avatar-fallback" aria-hidden="true">
          {firstGrapheme(displayName)}
        </span>
      )}
    </span>
  )
}
