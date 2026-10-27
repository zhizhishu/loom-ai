import * as Popover from '@radix-ui/react-popover'
import type { AgentProfile, MissionRecord } from '@contracts'
import { MemberAvatar } from './MemberAvatar'
import { useMissionPeople } from './MissionControls'
import { missionDescriptionContent } from './mission-description'
import { uiAttribute } from './interface-language'
import { FileReferenceText } from './FileReferenceLink'

function MissionMemberReference({ agentId, member, active }: { agentId: string; member?: AgentProfile; active: boolean }) {
  const available = active && member && member.presence !== 'removed'
  const label = `@${member?.displayName ?? uiAttribute('不可用队员')}`
  if (!available) return <span className="message-mention-token is-unavailable" data-agent-id={agentId} title={uiAttribute('该队员已不可用')}>{label}</span>
  return <Popover.Root><Popover.Trigger asChild><span role="button" tabIndex={0} className="message-mention-token is-interactive" data-agent-id={agentId}
    aria-label={uiAttribute('查看{0}的基础信息', member.displayName)} onClick={event => { if (window.getSelection()?.toString()) event.preventDefault() }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click() } }}>{label}</span></Popover.Trigger>
    <Popover.Portal><Popover.Content className="compact-menu mission-member-profile" sideOffset={8} collisionPadding={12} aria-label={member.displayName}>
      <article className="identity-card">
        <header className="identity-card-header">
          <MemberAvatar agentId={agentId} avatarRef={member.avatarRef} displayName={member.displayName} size="profile" decorative className="identity-card-avatar"/>
          <div className="identity-card-heading"><div className="identity-card-title"><h2>{member.displayName}</h2></div>{member.teamRole && <p>{member.teamRole}</p>}</div>
          <Popover.Close className="identity-card-close" aria-label={uiAttribute('关闭身份卡')}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></Popover.Close>
        </header>
        {member.professionalResponsibilities && <section className="identity-card-responsibilities"><h3>{uiAttribute('专业职责')}</h3><p>{member.professionalResponsibilities}</p></section>}
      </article>
    </Popover.Content></Popover.Portal></Popover.Root>
}

export function MissionDescription({ mission }: { mission: MissionRecord }) {
  const agents = useMissionPeople()
  return <>{missionDescriptionContent(mission.description, mission.descriptionContent).map((segment, index) => segment.kind === 'text'
    ? <FileReferenceText key={index} text={segment.text}/>
    : <MissionMemberReference key={index} agentId={segment.agentId} member={agents.find(agent => agent.agentId === segment.agentId)} active={mission.memberAgentIds.includes(segment.agentId)}/>)}</>
}
