import React, { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { MemberAvatar } from './MemberAvatar'
import { DialogControlIcon } from './AppDialog'
import { NavigationIcon } from './NavigationIcon'
import { MissionPropertyChip, TeamGlyph } from './MissionDefinitionEditor'
import { isNewConversationMemberAvailable, newConversationMemberStatus } from './new-conversation-availability'
import { uiAttribute } from './interface-language'
import { memberSearchMatches } from './member-search'
import type { AgentProfile, Team, ThreadCreationPreflight } from '@contracts'
type Member = ThreadCreationPreflight['presentMembers'][number]
type MissionTeamPickerProps = {
  busy: boolean
  members: Member[]
  availableMembers: Member[]
  selectedMemberIds: string[]
  selectedMembers: Member[]
  leadId: string
  profileById: Map<string, AgentProfile>
  triggerRef: RefObject<HTMLButtonElement | null>
  portalContainer: HTMLDivElement | null
  teams: Team[]
  selectedTeam: Team | null
  teamId: string | null
  loading: boolean
  error: string | null
  onRetry?: () => void
  onSelect(id: string | null): void
  onToggle(id: string): void
  onToggleAll(): void
  onLead(id: string): void
}
export function MissionTeamPicker({ busy, members, availableMembers, selectedMemberIds, selectedMembers, leadId, profileById, triggerRef, portalContainer, onToggle, onToggleAll, onLead, teams, selectedTeam, teamId, loading, error, onRetry, onSelect }: MissionTeamPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'detail' | 'source' | 'guidance'>('detail')
  const [query, setQuery] = useState('')
  const [guidance, setGuidance] = useState(false)
  const [guidanceOverflows, setGuidanceOverflows] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const fullTextRef = useRef<HTMLButtonElement>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const lead = profileById.get(leadId)
  const ordered = teamId ? (selectedTeam?.memberAgentIds ?? []).map(id => members.find(m => m.agentId === id) ?? { agentId: id, displayName: uiAttribute("不可用队员") }) : selectedMembers
  const all = availableMembers.length > 0 && selectedMemberIds.length === availableMembers.length && selectedMemberIds.every(id => availableMembers.some(m => m.agentId === id))
  const normalized = query.trim().toLocaleLowerCase()
  const matching = members.filter(m => !normalized || memberSearchMatches(`${m.displayName} ${profileById.get(m.agentId)?.teamRole ?? ''}`, normalized))
  const matchingTeams = teams.filter(team => !normalized || memberSearchMatches(`${team.name} ${team.memberAgentIds.map(id => profileById.get(id)?.displayName ?? '').join(' ')}`, normalized))
  const teamUnavailable = selectedTeam && selectedTeam.memberAgentIds.some(id => !availableMembers.some(m => m.agentId === id))
  const name = teamId ? selectedTeam?.name ?? uiAttribute("团队不可用") : uiAttribute("自定义")
  function moveTo(next: 'detail' | 'source' | 'guidance'): void {
    const from = view
    setView(next)
    setQuery('')
    requestAnimationFrame(() => {
      const target = next === 'guidance' ? readerRef.current
        : next === 'source' || !teamId ? searchRef.current
        : from === 'guidance' ? fullTextRef.current : changeRef.current
      target?.focus({ preventScroll: true })
    })
  }

  function choose(id: string | null): void {
    onSelect(id)
    setGuidance(false)
    setView('detail')
    setQuery('')
    requestAnimationFrame(() => id ? changeRef.current?.focus() : searchRef.current?.focus())
  }

  function changeOpen(value: boolean): void {
    if (busy) return
    setOpen(value)
    if (value) {
      setView('detail')
      setQuery('')
      setGuidance(false)
    }
  }

  useLayoutEffect(() => {
    const node = previewRef.current
    if (!node) return
    const measure = () => setGuidanceOverflows(node.scrollHeight > node.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [guidance, view, open, selectedTeam?.guidance])
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (view === 'guidance') return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.nativeEvent.isComposing)
      return
    if (event.target instanceof HTMLInputElement && !['ArrowDown', 'ArrowUp'].includes(event.key))
      return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-roving]:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (!buttons.length) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus()
    buttons[next].scrollIntoView({ block: 'nearest' })
  }
  return <Popover.Root open={open} onOpenChange={changeOpen}>
  <Popover.Trigger asChild><MissionPropertyChip ref={triggerRef} className="mission-editor-team-property mission-team-trigger" icon={<TeamGlyph />} disabled={busy} aria-label={uiAttribute("团队与队员：{0}，{1} 位队员", name, selectedMemberIds.length)} aria-invalid={Boolean(teamUnavailable || !selectedMemberIds.length)}>
   <span className="mission-editor-team-summary"><span className="mission-team-chip-name">{name}</span>{ordered.length > 0 && <><span className="mission-editor-team-divider" aria-hidden="true"/><span className="compact-avatar-stack">{ordered.slice(0, 2).map(m => <MemberAvatar key={m.agentId} agentId={m.agentId} displayName={m.displayName} avatarRef={profileById.get(m.agentId)?.avatarRef ?? null} size="mention" decorative/>)}{ordered.length > 2 && <span className="mission-editor-team-overflow">+{ordered.length - 2}</span>}</span></>}<DialogControlIcon name="chevron"/></span>
  </MissionPropertyChip></Popover.Trigger>
  <Popover.Portal container={portalContainer}><Popover.Content className={'compact-menu mission-editor-team-popover mission-team-picker' + (view === 'guidance' ? ' mission-team-guidance-reader' : '')} aria-label={view === 'guidance' ? uiAttribute("团队指引") : uiAttribute("团队与队员")} align="start" sideOffset={6} collisionPadding={12} onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => teamId ? changeRef.current?.focus() : searchRef.current?.focus()); }} onEscapeKeyDown={event => {
      event.preventDefault()
      event.stopPropagation()
      if (view !== 'detail') moveTo('detail')
      else setOpen(false)
    }} onKeyDown={navigate}>
   {view === 'guidance' ? <>
    <header className="mission-team-reader-heading"><button type="button" className="mission-team-back" onClick={() => moveTo('detail')} aria-label={uiAttribute("返回队伍")}><NavigationIcon name="arrow-left"/></button><div><strong>{uiAttribute("团队指引")}</strong><small>{selectedTeam?.name}</small></div></header>
    <div ref={readerRef} className="mission-team-reader-body" role="region" tabIndex={0} aria-label={uiAttribute("团队指引全文")}>{selectedTeam?.guidance}</div>
   </> : view === 'source' ? <>
    <div className="mission-team-source-heading"><button type="button" className="mission-team-back" onClick={() => moveTo('detail')} aria-label={uiAttribute("返回队伍")}><NavigationIcon name="arrow-left"/></button><strong>{uiAttribute("选择团队")}</strong></div>
    <label className="mission-picker-search"><NavigationIcon name="search"/><input ref={searchRef} value={query} aria-label={uiAttribute("搜索团队")} placeholder={uiAttribute("搜索团队…")} onChange={e => setQuery(e.target.value)}/></label>
    <div className="mission-team-source-list" role="group" aria-label={uiAttribute("创建来源")}>
     <button type="button" className="compact-option mission-team-source-option" data-team-id="custom" data-roving aria-pressed={!teamId} disabled={busy} onClick={() => choose(null)}><TeamGlyph /><span><strong>{uiAttribute("自定义")}</strong><small>{uiAttribute("选择队员和队长")}</small></span>{!teamId && <DialogControlIcon name="check"/>}</button>
     <div className="compact-separator"/>
     {loading ? <p className="mission-picker-empty" role="status">{uiAttribute("正在载入团队…")}</p> : error ? <div className="mission-team-list-error" role="alert"><p>{uiAttribute("团队暂时无法载入")}</p><button type="button" className="compact-text-button" disabled={busy} onClick={onRetry}>{uiAttribute("重试")}</button></div> : matchingTeams.map(team => {
        const unavailable = team.memberAgentIds.some(id => !availableMembers.some(m => m.agentId === id)), captain = profileById.get(team.defaultLeadAgentId)
        return <button type="button" key={team.id} className="compact-option mission-team-source-option" data-team-id={team.id} data-roving disabled={busy || unavailable} aria-pressed={team.id === teamId} onClick={() => choose(team.id)}>
       <div className="mission-team-avatar"><MemberAvatar agentId={team.defaultLeadAgentId} displayName={captain?.displayName ?? '?'} avatarRef={captain?.avatarRef ?? null} size="mention" decorative/></div><span><strong>{team.name}</strong><small>{uiAttribute('{0} 位队员 · 队长 {1}', team.memberAgentIds.length, captain?.displayName ?? uiAttribute('不可用'))}{unavailable ? ` · ${uiAttribute("不可用")}` : ''}</small></span>{team.id === teamId && <DialogControlIcon name="check"/>}
      </button>
      })}
     {!loading && !error && !matchingTeams.length && <p className="mission-picker-empty" role="status">{teams.length ? uiAttribute("没有匹配的团队") : uiAttribute("暂无团队，可使用自定义队伍")}</p>}
    </div>
   </> : <>
    <div className="mission-team-heading"><div><strong>{name}</strong><small>{uiAttribute('{0} 位队员', selectedMemberIds.length)}</small></div><button ref={changeRef} type="button" className="compact-text-button" data-change-source disabled={busy} onClick={() => moveTo('source')}>{uiAttribute("更换")}<DialogControlIcon name="chevron"/></button></div>
    {teamId ? <>
     {teamUnavailable && <p className="mission-team-error" role="alert">{uiAttribute("团队中有不可用队员，请选择其他团队或自定义。")}</p>}
     {!selectedTeam && <div className="mission-team-list-error" role={loading ? 'status' : 'alert'}><p>{loading ? uiAttribute("正在载入团队…") : uiAttribute("团队暂时无法载入，请重试或更换。")}</p>{!loading && <button type="button" className="compact-text-button" disabled={busy} onClick={onRetry}>{uiAttribute("重试")}</button>}</div>}
     <div className="mission-editor-team-list mission-team-readonly-roster" aria-label={uiAttribute("团队队员")}>
      {ordered.map(m => <div className="mission-team-member-readonly" key={m.agentId}><MemberAvatar agentId={m.agentId} displayName={m.displayName} avatarRef={profileById.get(m.agentId)?.avatarRef ?? null} size="mention" decorative/><span><strong>{m.displayName}</strong><small>{profileById.get(m.agentId)?.teamRole ?? uiAttribute("队员")}</small></span>{m.agentId === leadId && <span className="mission-team-lead-label">{uiAttribute("队长")}</span>}</div>)}
     </div>
     {selectedTeam?.guidance && <div className="mission-team-guidance"><button type="button" className="mission-team-guidance-toggle" aria-expanded={guidance} onClick={() => setGuidance(!guidance)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v11H3zM5.5 5h5M5.5 8h5M5.5 11h3"/></svg><span>{uiAttribute("团队指引")}</span><span className={guidance ? 'is-expanded' : ''}><DialogControlIcon name="chevron"/></span></button>{guidance && <div className="mission-team-guidance-text"><div ref={previewRef} className="mission-team-guidance-preview-text">{selectedTeam.guidance}</div>{guidanceOverflows && <button ref={fullTextRef} type="button" className="mission-team-guidance-full-link" onClick={() => moveTo('guidance')}>{uiAttribute("查看全文")}<NavigationIcon name="arrow-left"/></button>}</div>}</div>}
    </> : <>
     <label className="mission-picker-search"><NavigationIcon name="search"/><input ref={searchRef} value={query} aria-label={uiAttribute("搜索队员")} placeholder={uiAttribute("搜索队员…")} onChange={e => setQuery(e.target.value)}/></label>
     <div className="compact-menu-heading"><span>{uiAttribute("队员与队长")}</span><button type="button" disabled={busy || !availableMembers.length} onClick={onToggleAll}>{all ? uiAttribute("取消全选") : uiAttribute("全选")}</button></div>
     <div className="mission-editor-team-list mission-team-custom-roster">
      {matching.map(m => {
          const available = isNewConversationMemberAvailable(m), selected = selectedMemberIds.includes(m.agentId), isLead = m.agentId === leadId
          return <div className="mission-editor-team-row" key={m.agentId} data-disabled={!available ? '' : undefined}>
        <button type="button" className="mission-editor-team-member" data-member={m.agentId} data-roving role="checkbox" aria-checked={selected} aria-label={m.displayName} disabled={busy || !available} onClick={() => onToggle(m.agentId)}><MemberAvatar agentId={m.agentId} displayName={m.displayName} avatarRef={profileById.get(m.agentId)?.avatarRef ?? null} size="mention" decorative/><span>{m.displayName}<small>{profileById.get(m.agentId)?.teamRole ?? uiAttribute("队员")}{!available ? ' · ' + newConversationMemberStatus(m) : ''}</small></span><span className={'mission-editor-team-check' + (selected ? ' is-checked' : '')} aria-hidden="true">{selected && <DialogControlIcon name="check"/>}</span></button>
        <button type="button" className={'mission-editor-lead-choice' + (isLead ? ' is-selected' : '')} data-lead={m.agentId} aria-label={uiAttribute('设为队长：{0}', m.displayName)} aria-pressed={isLead} disabled={busy || !available || !selected} onClick={() => onLead(m.agentId)}>{isLead ? uiAttribute("队长") : uiAttribute("设为队长")}</button>
       </div>
        })}
      {!matching.length && <p className="mission-picker-empty">{uiAttribute("没有匹配的队员")}</p>}
     </div>
    </>}
    <div className="mission-editor-team-footer mission-team-picker-footer"><span>{!teamId && lead ? uiAttribute('队长 {0}', lead.displayName) : ''}</span><button type="button" className="compact-primary" disabled={busy} onClick={() => setOpen(false)}>{uiAttribute("完成")}</button></div>
   </>}
  </Popover.Content></Popover.Portal>
  </Popover.Root>
}
