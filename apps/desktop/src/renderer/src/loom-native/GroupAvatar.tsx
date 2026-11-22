import type { CSSProperties } from 'react'
import type { AgentProfile } from './types'
import { Avatar } from './Avatar'

/** 群头像里最多叠几个成员头像（Mikka `components/nav/group-avatar.tsx:22` `STACKED = 3`）。 */
export const STACKED_MEMBERS = 3

/**
 * 群头像：成员头像横向重叠叠放（Mikka `group-avatar.tsx:29-35`），不是标题首字母。
 * 群还没有成员、或成员名单还没读到时退回标题首字母——所以挂到侧栏某一行
 * 绝不会因此发起请求（Mikka `CachedGroupAvatar`，`group-avatar.tsx:44-47`）。
 */
export function GroupAvatar({ title, members, size = 34 }: {
  title: string
  members?: readonly AgentProfile[] | null
  size?: number
}) {
  const stacked = (members ?? []).slice(0, STACKED_MEMBERS)
  if (!stacked.length) return <Avatar name={title} size={size}/>
  return <span className="ln-group-avatar" aria-hidden="true" style={{ '--ln-avatar-size': `${size}px` } as CSSProperties}>
    {stacked.map(agent => <Avatar key={agent.agentId} agent={agent} size={size}/>)}
  </span>
}
