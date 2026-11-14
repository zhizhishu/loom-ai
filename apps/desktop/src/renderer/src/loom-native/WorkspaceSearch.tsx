import type { AgentProfile, ArtifactSelection, ConversationItem, WorkItem } from './types'
import type { WorkspaceSearchResults } from './workspace-search'
import { Avatar } from './Avatar'
import { Icon } from './icons'

export function WorkspaceSearch({ results, query, onConversation, onAssistant, onWork, onArtifact }: {
  results: WorkspaceSearchResults; query: string
  onConversation(item: ConversationItem): void; onAssistant(agentId: string): void
  onWork(item: WorkItem): void; onArtifact(selection: ArtifactSelection): void
}) {
  const { conversations, assistants, work, artifacts } = results
  return <div className="ln-global-search-results">
    <p className="ln-search-summary" role="status">{query.trim() ? results.total ? `找到 ${results.total} 项相关内容` : '没有找到匹配的内容' : '最近的对话、助手和工作'}</p>
    {!!conversations.length && <section className="ln-global-search-group" aria-label="对话搜索结果"><h3>对话</h3>{conversations.map(item =>
      <button type="button" key={item.id} className="ln-global-search-hit" onClick={() => onConversation(item)}>
        <span className="ln-search-kind"><Icon name="chat" size={18}/></span><span><strong>{item.title}</strong><small>{item.subtitle || '打开这段对话'}</small></span><Icon name="right" size={14}/>
      </button>)}</section>}
    {!!assistants.length && <section className="ln-global-search-group" aria-label="助手搜索结果"><h3>助手</h3>{assistants.map(agent =>
      <button type="button" key={agent.agentId} className="ln-global-search-hit" onClick={() => onAssistant(agent.agentId)}>
        <Avatar agent={agent} size={32}/><span><strong>{agent.displayName}</strong><small>查看资料、运行方式和能力</small></span><Icon name="right" size={14}/>
      </button>)}</section>}
    {!!work.length && <section className="ln-global-search-group" aria-label="工作搜索结果"><h3>工作</h3>{work.map(item =>
      <button type="button" key={item.task.taskId} className="ln-global-search-hit" onClick={() => onWork(item)}>
        <span className="ln-search-kind"><Icon name="board" size={18}/></span><span><strong>{item.task.title}</strong><small>{item.mission.title}</small></span><Icon name="right" size={14}/>
      </button>)}</section>}
    {!!artifacts.length && <section className="ln-global-search-group" aria-label="成果搜索结果"><h3>成果</h3>{artifacts.map(selection =>
      <button type="button" key={selection.artifact.artifactId} className="ln-global-search-hit" onClick={() => onArtifact(selection)}>
        <span className="ln-search-kind"><Icon name="file" size={18}/></span><span><strong>{selection.artifact.relativePath.split(/[\\/]/).pop()}</strong><small>{selection.bundle.mission.title} · {selection.artifact.relativePath}</small></span><Icon name="right" size={14}/>
      </button>)}</section>}
    {!results.total && <div className="ln-search-empty"><Icon name="search" size={28}/><p>试试助手名字、工作标题或文件名。</p></div>}
  </div>
}
