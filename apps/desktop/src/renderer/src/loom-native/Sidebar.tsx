import { useState } from 'react'
import type { HiddenThreadItem, AgentProfile, ConversationItem } from './types'
import { Avatar, LoomMark } from './Avatar'
import { GroupAvatar } from './GroupAvatar'
import { Icon, IconButton } from './icons'
import { sortConversationItems } from './conversation-order'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'

export function Sidebar({ agents, items, selectedId, onSelect, onCreate, onCollapse, onEditAssistant, loading, groupRosters, hidden = [], onRestoreHidden }: {
  agents: AgentProfile[]; items: ConversationItem[]; selectedId: string | null; loading: boolean
  onSelect(item: ConversationItem): void
  /** 列表头的 ＋ 只开新群聊；新单聊是左侧 rail 那一个 ＋。 */
  onCreate(): void; onCollapse(): void; onEditAssistant?(agentId: string): void
  /** 已经读过的群成员名单（threadId → agentId）。只读缓存，挂一行不会发请求。 */
  groupRosters?: Readonly<Record<string, readonly string[]>>
  /** 隐藏列表（`threads.hiddenList`）：这些群不进主列表，只在底部「已隐藏」里。 */
  hidden?: readonly HiddenThreadItem[]
  /** 恢复：把群放回会话列表，群本身不动。 */
  onRestoreHidden?(threadId: string): void
}) {
  const [showHidden, setShowHidden] = useState(false)
  // 隐藏 = 从我的列表拿出去（Mikka 群行的 hidden，bot-list.tsx:54-55）：群还在，
  // 只是主列表不再列它，恢复后重新出现。
  const hiddenIds = new Set(hidden.map(row => row.id))
  const visible = items.filter(item => item.threadId === null || !hiddenIds.has(item.threadId))
  // 置顶 → 时间 → 名字；没有置顶事实时就是「最新在上，同一时间按名字」。
  const rows = sortConversationItems(visible)
  const groupMembers = (item: ConversationItem): AgentProfile[] | null => {
    const roster = item.threadId === null ? undefined : groupRosters?.[item.threadId]
    if (!roster || roster.length < 2) return null
    const found = roster
      .map(agentId => agents.find(agent => agent.agentId === agentId))
      .filter((agent): agent is AgentProfile => agent !== undefined)
    return found.length >= 2 ? found : null
  }
  return <aside className="ln-sidebar" aria-label="会话列表">
    <header className="ln-sidebar-head"><LoomMark/><div className="ln-sidebar-tools"><IconButton icon="panel" label="收起会话列表" onClick={onCollapse}/><IconButton icon="plus" label="新建群聊" onClick={onCreate}/></div></header>
    <div className="ln-conversations">
      {loading && items.length === 0 && <div className="ln-loading" role="status">正在读取会话…</div>}
      {rows.map(item => {
        const members = groupMembers(item)
        return <div className={`ln-conversation-row ${selectedId === item.id ? 'is-selected' : ''}`} key={item.id}>
          <button type="button" className="ln-conversation-main" onClick={() => onSelect(item)}
            aria-current={selectedId === item.id ? 'page' : undefined} title={item.title}>
            {members ? <GroupAvatar title={item.title} members={members}/> : <Avatar agent={agents.find(agent => agent.agentId === item.agentId)} name={item.title}/>}
            <span className="ln-row-copy"><strong>{item.title}</strong><span>{item.subtitle || '开始对话'}</span></span>
          </button>
          {onEditAssistant && item.agentId && agents.some(agent => agent.agentId === item.agentId) && <button type="button"
            className="ln-conversation-edit" aria-label={`编辑助手：${agents.find(agent => agent.agentId === item.agentId)?.displayName || item.title}`}
            title="编辑这个助手的资料、能力和运行配置" onClick={() => onEditAssistant(item.agentId!)}>
            <Icon name="settings" size={14}/></button>}
          {item.unread && <i className="ln-unread-dot" aria-label="有未读消息"/>}
        </div>
      })}
      {!loading && rows.length === 0 && <Empty className="ln-sidebar-empty"><EmptyHeader><EmptyMedia variant="icon"><Icon name="chat" size={18}/></EmptyMedia><EmptyTitle>还没有对话</EmptyTitle><EmptyDescription>先建一个群聊，或从左侧 ＋ 开始单聊。</EmptyDescription></EmptyHeader><EmptyContent><button type="button" onClick={onCreate}>新建群聊</button></EmptyContent></Empty>}
    </div>
    {hidden.length > 0 && <div className="ln-hidden">
      <button type="button" className="ln-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden(value => !value)}>
        <Icon name="panel" size={14}/><span>已隐藏</span><small>{hidden.length}</small>
      </button>
      {showHidden && <div className="ln-hidden-list" role="list" aria-label="已隐藏的群">
        {hidden.map(row => <div className="ln-hidden-row" role="listitem" key={row.id}>
          <span title={row.title}>{row.title}</span>
          <button type="button" className="ln-text-action" disabled={!onRestoreHidden} aria-label={`恢复：${row.title}`} onClick={() => onRestoreHidden?.(row.id)}>恢复</button>
        </div>)}
      </div>}
    </div>}
  </aside>
}
