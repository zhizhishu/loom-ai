import { Fragment, useEffect, useRef, useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import type { AgentProfile, NewConversationDefaults, Team } from '@contracts'
import { NewConversationPicker } from './NewConversationPicker'
import { MemberAvatar } from './MemberAvatar'
import { DialogControlIcon } from './AppDialog'
import { TeamGlyph } from './MissionDefinitionEditor'
import { useMobileLayout } from './MobileLayout'
import { uiAttribute } from './interface-language'
import './Teams.css'

export function TeamPicker({ teams, selectedTeam, agents, value, onChange, busy = false }: {
  teams: Team[]; selectedTeam?: Team | null; agents: AgentProfile[]; value: string | null; onChange(id: string | null): void; busy?: boolean
}): React.JSX.Element {
  const mobile = useMobileLayout()
  const [open, setOpen] = useState(false)
  const chosen = selectedTeam?.id === value ? selectedTeam : teams.find(team => team.id === value)
  const rows = [{ id: '', name: uiAttribute('自定义'), team: null }, ...teams.map(team => ({ id: team.id, name: team.name, team }))]
  const choose = (id: string): void => { onChange(id || null); setOpen(false) }
  const content = (row: typeof rows[number]): React.JSX.Element => <><TeamGlyph/><span>{row.name}{row.team && <small>{uiAttribute('{0} 位队员 · 队长 {1}', String(row.team.memberAgentIds.length), agents.find(agent => agent.agentId === row.team?.defaultLeadAgentId)?.displayName ?? uiAttribute('不可用'))}</small>}</span></>
  return <NewConversationPicker backLabel={uiAttribute('返回')} mobile={mobile} open={open} onOpenChange={setOpen} busy={busy} title={uiAttribute('选择团队')}
    trigger={<button type="button" className="compact-picker team-picker-trigger" disabled={busy} aria-label={uiAttribute('选择团队')}><TeamGlyph/><span>{chosen?.name ?? (value ? uiAttribute('团队不可用') : uiAttribute('自定义'))}</span><DialogControlIcon name="chevron"/></button>}
    menu={<Menu.Content className="compact-menu team-choice-menu" align="end" sideOffset={6} collisionPadding={12} loop>
      <Menu.RadioGroup value={value ?? ''}>{rows.map((row, index) => <Fragment key={row.id}>{index === 1 && <Menu.Separator className="compact-separator"/>}<Menu.RadioItem className="compact-option" value={row.id} onSelect={() => choose(row.id)}>{content(row)}<Menu.ItemIndicator><DialogControlIcon name="check"/></Menu.ItemIndicator></Menu.RadioItem></Fragment>)}</Menu.RadioGroup>
    </Menu.Content>}>
    {rows.map(row => <button type="button" className="compact-option" key={row.id} aria-pressed={(value ?? '') === row.id} disabled={busy} onClick={() => choose(row.id)}>{content(row)}{(value ?? '') === row.id && <DialogControlIcon name="check"/>}</button>)}
  </NewConversationPicker>
}

export function TeamAvatarSummary({ ids, agents, limit = 3 }: { ids: string[]; agents: AgentProfile[]; limit?: number }): React.JSX.Element {
  return <span className="hub-selected-avatars" aria-hidden="true">{ids.slice(0, limit).map(id => {
    const agent = agents.find(agent => agent.agentId === id)
    return <MemberAvatar key={id} agentId={id} avatarRef={agent?.avatarRef ?? null} displayName={agent?.displayName ?? '?'} size="mention" decorative/>
  })}{ids.length > limit && <span className="avatar-overflow">+{ids.length - limit}</span>}</span>
}

export function TeamMemberPicker({ agents, roster, onChange, compact = false, busy = false }: {
  agents: AgentProfile[]; roster: NewConversationDefaults; onChange(roster: NewConversationDefaults): void; compact?: boolean; busy?: boolean
}): React.JSX.Element {
  const mobile = useMobileLayout()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!open) return; const frame = requestAnimationFrame(() => search.current?.focus()); return () => cancelAnimationFrame(frame) }, [open])
  const available = agents.filter(agent => agent.presence === 'present' && agent.removedAt === null)
  const members = agents.filter(agent => available.includes(agent) || roster.memberAgentIds.includes(agent.agentId))
  const matching = members.filter(agent => `${agent.displayName} ${agent.teamRole}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const update = (ids: string[]): void => onChange({ memberAgentIds: ids, defaultLeadAgentId: ids.includes(roster.defaultLeadAgentId) ? roster.defaultLeadAgentId : ids[0] ?? '' })
  const toggle = (id: string): void => update(roster.memberAgentIds.includes(id) ? roster.memberAgentIds.filter(member => member !== id) : [...roster.memberAgentIds, id])
  const all = available.length > 0 && available.every(agent => roster.memberAgentIds.includes(agent.agentId))
  const allLabel = all ? uiAttribute('取消全选') : uiAttribute('全选')
  const content = (agent: AgentProfile): React.JSX.Element => <><MemberAvatar agentId={agent.agentId} avatarRef={agent.avatarRef} displayName={agent.displayName} size="mention" decorative/><span><strong>{agent.displayName}</strong><small>{available.includes(agent) ? agent.teamRole : uiAttribute('当前不可用')}</small></span><span className="compact-checkbox team-member-checkbox" aria-hidden="true">{roster.memberAgentIds.includes(agent.agentId) && <DialogControlIcon name="check"/>}</span></>
  const searchField = members.length > 8 && <label className="team-member-search"><input ref={search} value={query} placeholder={uiAttribute('搜索队员')} aria-label={uiAttribute('搜索队员')} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (!['Escape', 'Tab', 'ArrowDown'].includes(event.key)) event.stopPropagation() }}/></label>
  return <NewConversationPicker backLabel={uiAttribute('返回')} mobile={mobile} open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery('') }} busy={busy} title={uiAttribute('选择队员')} multiple
    trigger={<button type="button" disabled={busy} className={compact ? 'team-roster-add' : 'compact-picker hub-member-trigger'} aria-label={uiAttribute('选择队员')}>
      {compact ? <><DialogControlIcon name="plus"/><span>{uiAttribute('添加')}</span></> : <><TeamAvatarSummary ids={roster.memberAgentIds} agents={agents}/><span>{uiAttribute('{0} 位队员', String(roster.memberAgentIds.length))}</span></>}<DialogControlIcon name="chevron"/>
    </button>}
    menu={<Menu.Content className="compact-menu roster-menu hub-member-menu" align="start" sideOffset={6} collisionPadding={12} loop>
      <div className="compact-menu-heading"><span>{uiAttribute('已选 {0} 位', String(roster.memberAgentIds.length))}</span><Menu.Item onSelect={event => { event.preventDefault(); update(all ? [] : available.map(agent => agent.agentId)) }}>{allLabel}</Menu.Item></div>
      {searchField}<div className="hub-member-options">{matching.map(agent => <Menu.CheckboxItem key={agent.agentId} className="compact-option" checked={roster.memberAgentIds.includes(agent.agentId)} disabled={busy || (!available.includes(agent) && !roster.memberAgentIds.includes(agent.agentId))} onSelect={event => { event.preventDefault(); toggle(agent.agentId) }}>{content(agent)}</Menu.CheckboxItem>)}</div>
    </Menu.Content>}>
    <div className="compact-menu-heading"><span>{uiAttribute('队员')}</span><button type="button" disabled={busy} onClick={() => update(all ? [] : available.map(agent => agent.agentId))}>{allLabel}</button></div>{searchField}
    {matching.map(agent => <button type="button" className="compact-option" key={agent.agentId} aria-pressed={roster.memberAgentIds.includes(agent.agentId)} disabled={busy || (!available.includes(agent) && !roster.memberAgentIds.includes(agent.agentId))} onClick={() => toggle(agent.agentId)}>{content(agent)}</button>)}
  </NewConversationPicker>
}
