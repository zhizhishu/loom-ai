import type { CSSProperties } from 'react'
import type { AgentProfile } from './types'
import { MemberAvatar } from '../MemberAvatar'

export function Avatar({ agent, size = 34, name }: { agent?: AgentProfile | null; size?: number; name?: string }) {
  return <span className="ln-avatar" style={{ '--ln-avatar-size': `${size}px` } as CSSProperties}>
    {agent ? <MemberAvatar agentId={agent.agentId} avatarRef={agent.avatarRef} displayName={agent.displayName} size="workspace" decorative/>
      : <span className="ln-avatar-fallback" aria-hidden="true">{name?.slice(0, 1) || 'L'}</span>}
  </span>
}

/** The small embroidered robot has a recognisable face and woven threads even at 16 px. */
export function LoomMark() {
  return <svg className="ln-brand-mark" width="30" height="30" viewBox="0 0 64 64" role="img" aria-label="LOOM 编织机器人">
    <rect x="2" y="2" width="60" height="60" rx="19" fill="#edf2ff"/>
    <path d="M32 13V9" stroke="#8da5ed" strokeWidth="3.5" strokeLinecap="round"/>
    <path d="M32 9C25 5 21 9 25 14c4 3 7-1 7-5Zm0 0c6-7 13-4 10 2-3 4-8 3-10-2" fill="#acbdf5"/>
    <rect x="12" y="17" width="40" height="34" rx="14" fill="#dce7ff" stroke="#9dacdd" strokeWidth="1.4"/>
    <rect x="17" y="22" width="30" height="22" rx="10" fill="#263454"/>
    <path d="M24 31q3-4 6 0m5 0q3-4 6 0" fill="none" stroke="#bdedff" strokeWidth="2.8" strokeLinecap="round"/>
    <path d="M26 38q6 4 12 0" fill="none" stroke="#a5d7f7" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M23 49h18" stroke="#9688db" strokeWidth="3.5" strokeLinecap="round"/>
    <path d="M23 48q5-6 9 0t9 0" fill="none" stroke="#6b91f2" strokeWidth="3" strokeLinecap="round"/>
    <path d="M23 54q5-6 9 0t9 0" fill="none" stroke="#f7b8a6" strokeWidth="3" strokeLinecap="round"/>
  </svg>
}
