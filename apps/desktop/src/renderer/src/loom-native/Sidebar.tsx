import type { AgentProfile, ConversationItem } from './types'
import { Avatar, LoomMark } from './Avatar'
import { Icon, IconButton } from './icons'

export function Sidebar({ agents, items, selectedId, onSelect, onCreate, onCollapse, onEditAssistant, loading }: {
  agents: AgentProfile[]; items: ConversationItem[]; selectedId: string | null; loading: boolean
  onSelect(item: ConversationItem): void; onCreate(): void; onCollapse(): void; onEditAssistant?(agentId: string): void
}) {
  return <aside className="ln-sidebar" aria-label="会话列表">
    <header className="ln-sidebar-head"><LoomMark/><div className="ln-sidebar-tools"><IconButton icon="panel" label="收起会话列表" onClick={onCollapse}/><IconButton icon="plus" label="新建对话" onClick={onCreate}/></div></header>
    <div className="ln-conversations">
      {loading && items.length === 0 && <div className="ln-loading" role="status">正在读取会话…</div>}
      {items.map(item => <div className={`ln-conversation-row ${selectedId === item.id ? 'is-selected' : ''}`} key={item.id}>
        <button type="button" className="ln-conversation-main" onClick={() => onSelect(item)}
          aria-current={selectedId === item.id ? 'page' : undefined} title={item.title}>
          <Avatar agent={agents.find(agent => agent.agentId === item.agentId)} name={item.title}/>
          <span className="ln-row-copy"><strong>{item.title}</strong><span>{item.subtitle || '开始对话'}</span></span>
        </button>
        {onEditAssistant && item.agentId && agents.some(agent => agent.agentId === item.agentId) && <button type="button"
          className="ln-conversation-edit" aria-label={`编辑助手：${agents.find(agent => agent.agentId === item.agentId)?.displayName || item.title}`}
          title="编辑这个助手的资料、能力和运行配置" onClick={() => onEditAssistant(item.agentId!)}>
          <Icon name="settings" size={14}/></button>}
        {item.unread && <i className="ln-unread-dot" aria-label="有未读消息"/>}
      </div>)}
      {!loading && items.length === 0 && <div className="ln-sidebar-empty">还没有对话<button type="button" onClick={onCreate}>新建对话</button></div>}
    </div>
  </aside>
}
