import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { NavigationIcon } from './NavigationIcon'
import { MissionIcon } from './MissionIcon'
import { MentionRuntimeButton } from './MentionRuntimeButton'
import { referenceProject } from './thread-reference'
import type { StructuredMentionOption } from './StructuredMentionComposer'
import type { useReferencePicker } from './useReferencePicker'
import { uiAttribute } from './interface-language'

export function ThreadReferenceMenu({ menuId, picker, inviteLayer, pendingInviteIds, selectedIndex, setHighlightedIndex, selectIndex, onFilter,
  renderAvatar }: {
  menuId: string; picker: ReturnType<typeof useReferencePicker>; inviteLayer: boolean; pendingInviteIds: readonly string[]
  selectedIndex: number; setHighlightedIndex(index: number): void; selectIndex(index: number): void
  onFilter(filter: 'members' | 'thread' | 'mission'): void; renderAvatar(option: StructuredMentionOption): ReactNode
}) {
  const { options, filter, loading } = picker
  const list = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const directory = filter !== 'members' && !inviteLayer
  const virtualized = directory && options.length > 40
  useLayoutEffect(() => {
    const element = list.current
    if (!element || !directory || loading) return
    const top = selectedIndex * 32, bottom = top + 32
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
    setScrollTop(element.scrollTop)
  }, [selectedIndex, directory, filter, picker.query, loading])
  useLayoutEffect(() => { if (list.current) list.current.scrollTop = 0; setScrollTop(0) }, [filter, picker.query])
  const start = Math.max(0, Math.floor(scrollTop / 32) - 3)
  const indices = virtualized
    ? [...new Set([...Array.from({ length: Math.min(22, options.length - start) }, (_, offset) => start + offset),
      ...(selectedIndex >= 0 && selectedIndex < options.length ? [selectedIndex] : [])])].sort((a, b) => a - b)
    : options.map((_, index) => index)
  const visible = indices.map(index => ({ option: options[index]!, index }))
  return <div className="mention-menu structured-mention-menu ref-menu">
    <div className="ref-menu-heading"><div className="ref-filters" role="tablist" aria-label={uiAttribute('提及类型')}>
      {(['members', 'thread', 'mission'] as const).map(value => <button type="button" role="tab" key={value}
        aria-selected={filter === value} tabIndex={filter === value ? 0 : -1}
        onMouseDown={event => event.preventDefault()} onClick={() => onFilter(value)}
        onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const tabs = ['members', 'thread', 'mission'] as const; const next = (tabs.indexOf(value) + (event.key === 'ArrowRight' ? 1 : 2)) % 3; onFilter(tabs[next]!); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus(); } }}>
        {uiAttribute(value === 'members' ? '队员' : value === 'thread' ? '对话' : '使命')}
      </button>)}
    </div></div>
    {loading && <div className="ref-search-state" role="status"><NavigationIcon name="search" /><span>{uiAttribute('搜索中…')}</span></div>}
    <div className="ref-options" ref={list} id={menuId} role="listbox" aria-label={uiAttribute('选择引用或队员')}
      aria-busy={loading || picker.status === 'more'} data-managed-scroll={directory} data-virtualized={virtualized}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {!loading && !options.length && <p className="structured-mention-empty">{uiAttribute(picker.status === 'error' ? '暂时无法读取' : '无匹配结果')}</p>}
      {!loading && <div className={virtualized ? 'ref-option-window' : undefined} style={virtualized ? { height: options.length * 32 } : undefined}>
        {visible.map(({ option, index }) => {
          const member = option.kind === 'member' ? option.member : null
          const item = option.kind === 'reference' ? option.item : null
          const label = item?.title ?? member?.displayName ?? uiAttribute(option.kind === 'all_members' ? '所有队员' : option.kind === 'invite_other' ? '邀请其他队员' : '返回本会话')
          const subtitle = item ? referenceProject(item) : member?.teamRole ?? uiAttribute(option.kind === 'all_members' ? '广播给当前全部队员' : option.kind === 'invite_other' ? '浏览其他可用队员' : '查看当前会话队员')
          return <div key={item?.id ?? member?.agentId ?? option.kind} className="ref-option-wrap"
            style={virtualized ? { position: 'absolute', top: index * 32, left: 0, right: 0, height: 32 } : undefined}>
            <button type="button" role="option" tabIndex={-1} id={`${menuId}-option-${index}`}
              aria-posinset={index + 1} aria-setsize={picker.hasMore ? -1 : options.length} aria-selected={selectedIndex === index}
              data-reference-id={item?.id} data-agent-id={member?.agentId} data-option-kind={option.kind}
              aria-label={`${label}，${subtitle}`} title={item ? `${label}\n${subtitle}\n${item.id}` : undefined}
              className={[selectedIndex === index ? 'active' : '', item ? 'ref-thread-option' : '', member?.runtimeLabel ? 'has-runtime' : '', member?.inThread === false ? 'is-invitable' : '', option.kind === 'invite_other' || option.kind === 'back_to_camp' ? 'is-mention-action' : ''].join(' ')}
              onMouseMove={() => setHighlightedIndex(index)} onMouseDown={event => event.preventDefault()} onClick={() => selectIndex(index)}>
              {item ? <><span className="ref-candidate-icon">{item.kind === 'mission' ? <MissionIcon /> : <NavigationIcon name="messages" />}</span>
                <strong className="ref-candidate-title">{label}</strong><small className="ref-candidate-project">{subtitle}</small></>
                : <>{option.kind !== 'reference' && renderAvatar(option)}<span><strong>{label}</strong><small>{subtitle}</small></span></>}
              {member?.inThread === false && <span className="mention-option-state">{uiAttribute(pendingInviteIds.includes(member.agentId) ? '待邀请' : '邀请')}</span>}
              {option.kind === 'invite_other' && <svg className="mention-action-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2.5 3.5 3.5L4 9.5" /></svg>}
            </button>
            {member?.runtimeLabel && <div className="ref-runtime"><MentionRuntimeButton kind={member.runtimeKind} label={member.runtimeLabel}
              model={member.modelLabel} memberName={member.displayName} onHighlight={() => setHighlightedIndex(index)} onSelect={() => selectIndex(index)} /></div>}
          </div>
        })}
      </div>}
    </div>
    {!loading && picker.status === 'error' && <button type="button" className="ref-load-more" onMouseDown={event => event.preventDefault()} onClick={picker.retry}>{uiAttribute('重试')}</button>}
    {directory && !loading && picker.hasMore && picker.status !== 'error' && <button type="button" className="ref-load-more" disabled={picker.status === 'more'}
      onMouseDown={event => event.preventDefault()} onClick={() => { void picker.more() }}>{uiAttribute(picker.status === 'more' ? '加载中…' : '加载更多')}</button>}
  </div>
}
