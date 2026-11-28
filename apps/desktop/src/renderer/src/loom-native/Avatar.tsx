import type { CSSProperties } from 'react'
import { parseControlledMemberAvatarRef } from '@contracts'
import type { AgentProfile } from './types'
import { MemberAvatar } from '../MemberAvatar'
import { runtimeLogoFor } from './runtime-logo'
import brandImage from './assets/loom-brand-user-approved-256.webp'

export function Avatar({ agent, size = 34, name }: { agent?: AgentProfile | null; size?: number; name?: string }) {
  // A member keeps its own avatar (builtin / bot / managed). Only when there is no
  // controlled avatar does the execution engine's logo stand in for the initial letter.
  const hasPersonalAvatar = Boolean(agent?.avatarRef && parseControlledMemberAvatarRef(agent.avatarRef))
  const runtimeLogo = agent && !hasPersonalAvatar ? runtimeLogoFor(agent.runtimeConfiguration?.adapterKind) : null
  return <span className="ln-avatar" style={{ '--ln-avatar-size': `${size}px` } as CSSProperties}>
    {agent ? <MemberAvatar agentId={agent.agentId} avatarRef={agent.avatarRef} displayName={agent.displayName} size="workspace" decorative/>
      : <span className="ln-avatar-fallback" aria-hidden="true">{name?.slice(0, 1) || 'L'}</span>}
    {runtimeLogo && <img className="ln-avatar-runtime" src={runtimeLogo} alt="" aria-hidden="true" draggable={false}/>}
  </span>
}

/** User-selected LOOM identity. This never changes a member's personal avatar. */
export function LoomMark() {
  return <img className="ln-brand-mark" src={brandImage} width={30} height={30}
    alt="LOOM" draggable={false}
    style={{ display: 'block', objectFit: 'contain', borderRadius: 8 }}/>
}
