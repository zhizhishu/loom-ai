import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile, ArtifactSelection, ConversationItem, ThreadSnapshot, WorkBundle } from './types'
import { AgentMarkdown } from './AgentMarkdown'
import { Avatar } from './Avatar'
import { Icon, IconButton } from './icons'

export function ConversationView({ item, snapshot, agents, bundles, loading, sending, draft, files, error, onDraft, onFiles, onSend, onProfile, onArtifact, onShowSidebar, sidebarHidden, onShowWork, inspectorHidden, onAttachment, onResolveApproval, approvalBusy, onMembers, onWorkspaceManager }: {
  item: ConversationItem | null; snapshot: ThreadSnapshot | null; agents: AgentProfile[]; bundles: WorkBundle[]; loading: boolean; sending: boolean
  draft: string; files: File[]; error: string | null; onDraft(value: string): void; onFiles(files: File[]): void
  onSend(agentId?: string): void; onProfile(): void; onArtifact(selection: ArtifactSelection): void
  onShowSidebar(): void; sidebarHidden: boolean; onShowWork(): void; inspectorHidden: boolean
  onAttachment(messageId: string, attachmentId: string): void
  onResolveApproval(approvalId: string, optionId: string): void; approvalBusy: boolean; onMembers?(): void; onWorkspaceManager?(): void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const pinned = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const [recipient, setRecipient] = useState<string>('')
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const activeAgent = agents.find(agent => agent.agentId === (recipient || item?.agentId || snapshot?.thread.defaultLeadAgentId))
  const messages = useMemo(() => snapshot?.messages.filter(message => !message.withdrawn) ?? [], [snapshot?.messages])
  const visibleMessages = useMemo(() => messages.filter(message => message.authorType !== 'system'), [messages])
  const systemMessages = useMemo(() => messages.filter(message => message.authorType === 'system'), [messages])
  const running = useMemo(() => snapshot?.agentRuns.filter(run => ['running', 'queued', 'waiting'].includes(run.status)) ?? [], [snapshot?.agentRuns])
  const availableRecipients = useMemo(() => snapshot ? agents.filter(agent => snapshot.members.some(member => member.agentId === agent.agentId && member.membershipStatus === 'active')) : agents, [snapshot?.members,agents])
  const lastId = visibleMessages[visibleMessages.length - 1]?.id
  useEffect(() => { setRecipient(''); setMenu(false); pinned.current = true; setShowLatest(false) }, [item?.id])
  useEffect(() => {
    if (pinned.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
    else if (lastId) setShowLatest(true)
  }, [lastId, item?.id, snapshot?.throughGlobalSequence])
  useEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = `${Math.min(180, Math.max(36, input.current.scrollHeight))}px`
  }, [draft])
  const jump = () => { pinned.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); setShowLatest(false) }
  const title = item?.title || activeAgent?.displayName || 'LOOM'
  const artifacts = useMemo(() => bundles.filter(bundle => bundle.mission.threadId === snapshot?.thread.id).flatMap(bundle => bundle.artifacts.map(artifact => ({ artifact, bundle, candidate: bundle.candidates.find(candidate => candidate.evidenceIds.includes(artifact.artifactId)) ?? null }))), [bundles,snapshot?.thread.id])
  return <main className="ln-conversation" aria-label={`与${title}的对话`}>
    <header className="ln-chat-header">
      {sidebarHidden && <IconButton icon="panel" label="展开会话列表" onClick={onShowSidebar} className="ln-chat-sidebar-toggle"/>}
      <button type="button" className="ln-identity-pill" onClick={onProfile}><Avatar agent={activeAgent} name={title} size={23}/><strong>{title}</strong></button>
      {snapshot && onWorkspaceManager && <button type="button" className="ln-chat-root"
        title={'当前工作根：'+snapshot.thread.projectPath+'。点击管理其他项目'}
        aria-label="管理工作根目录" onClick={onWorkspaceManager}><Icon name="files" size={13}/>
        <span>{snapshot.thread.projectBindingKind==='directory'
          ? (snapshot.thread.projectPath.split(/[\\/]/).filter(Boolean).pop()||'当前项目')
          : '主机默认根'}</span></button>}
      {onMembers && snapshot && <button type="button" className="ln-chat-members-trigger" aria-label="管理群聊成员" onClick={onMembers}><Icon name="people" size={15}/><span>{snapshot.members.filter(member => member.membershipStatus === 'active').length} 位助手</span></button>}
      {inspectorHidden && <IconButton icon="board" label="打开工作面板" onClick={onShowWork} className="ln-chat-work-toggle"/>}
    </header>
    <div className="ln-transcript" ref={scroll} onScroll={event => {
      const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      if (pinned.current) setShowLatest(false)
    }}>
      {loading && !snapshot && <div className="ln-loading" role="status">正在读取对话…</div>}
      {!loading && !visibleMessages.length && <div className="ln-chat-empty"><Avatar agent={activeAgent} name={title} size={52}/><h1>{title}</h1><p>{item?.threadId ? '从一条消息开始。' : '聊聊想法，或交给我一件事。'}</p></div>}
      {visibleMessages.map(message => {
        const user = message.authorType === 'user' || message.authorType === 'external_principal'
        const author = agents.find(agent => agent.agentId === message.authorId)
        const handoff = !user && /\[LOOM_HANDOFF|"dispatchId"|"tool_call_id"/.test(message.body)
        return <article className={`ln-message ${user ? 'is-user' : 'is-assistant'} ${handoff ? 'is-record' : ''}`} key={message.id} data-message-id={message.id}>
          {!user && snapshot && snapshot.members.length > 1 && <div className="ln-message-author"><Avatar agent={author} name={message.authorDisplayName || ''} size={16}/><span>{author?.displayName || message.authorDisplayName || '助手'}</span></div>}
          {handoff ? <details className="ln-execution-record"><summary><Icon name="branch" size={14}/><span>执行记录</span><Icon name="right" size={12}/></summary><AgentMarkdown text={message.body}/></details>
            : <div className="ln-message-content"><AgentMarkdown text={message.body}/></div>}
          {message.attachments.length > 0 && <div className="ln-message-files">{message.attachments.map(attachment => <button className="ln-file-card" key={attachment.id} type="button" onClick={() => onAttachment(message.id, attachment.id)} disabled={attachment.availability === 'missing' || attachment.availability === 'unreadable'}><Icon name="file" size={22}/><span><strong>{attachment.displayName}</strong><small>{attachment.byteSize === null ? '附件' : `${Math.max(1, Math.round(attachment.byteSize / 1024))} KB`}</small></span><Icon name="right" size={14}/></button>)}</div>}
          <div className="ln-message-actions"><button type="button" aria-label="复制消息" title="复制消息" onClick={() => { void navigator.clipboard.writeText(message.body).then(() => { setCopied(message.id); window.setTimeout(() => setCopied(null), 1500) }) }}><Icon name={copied === message.id ? 'check' : 'copy'} size={13}/></button><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
        </article>
      })}
      {artifacts.length > 0 && <div className="ln-delivered-files">{artifacts.map(selection => <button type="button" className="ln-artifact-card" key={selection.artifact.artifactId} onClick={() => onArtifact(selection)}><span className="ln-document-icon"><Icon name="file" size={22}/></span><span><strong>{selection.artifact.relativePath.split(/[\\/]/).pop()}</strong><small>{selection.candidate?.acceptanceStatus === 'accepted' ? '已接受' : selection.candidate?.acceptanceStatus === 'rejected' ? '已退回' : '等待审阅'}</small></span><Icon name="right" size={15}/></button>)}</div>}
      {running.length > 0 && <div className="ln-running-status" role="status"><span className="ln-working-dots"><i/><i/><i/></span>{running.map(run => agents.find(agent => agent.agentId === run.agentId)?.displayName || '助手').join('、')}正在处理</div>}
      {systemMessages.length > 0 && <details className="ln-system-records"><summary>会话记录 <span>{systemMessages.length}</span></summary>{systemMessages.map(message => <AgentMarkdown key={message.id} text={message.body}/>)}</details>}
    </div>
    <div className="ln-composer-area">
      {showLatest && <button type="button" className="ln-jump-latest" title="回到最新消息" aria-label="回到最新消息" onClick={jump}><Icon name="down" size={18}/></button>}
      {error && <div className="ln-send-error" role="alert">{error}</div>}
      {snapshot?.approvals.filter(approval => approval.status === 'pending').map(approval => <section className="ln-approval-request" key={approval.id} aria-label="等待你的授权"><strong><Icon name="hand" size={16}/>需要你确认</strong><p>{approval.actionSummary}</p>{approval.reason && <small>{approval.reason}</small>}<p className="ln-approval-scope">{agents.find(agent => agent.agentId === approval.agentId)?.displayName || '当前助手'} · {approval.options.some(option => option.kind === 'allow_session') ? '持续授权仅限此原生会话，具体范围见选项。' : '本次请求按运行端提供的范围授权。'}</p><div>{approval.options.map(option => <button type="button" disabled={approvalBusy} key={option.optionId} title={option.consequence} className={option.kind === 'allow_once' ? 'is-once' : option.kind === 'allow_session' ? 'is-persistent' : ''} onClick={() => onResolveApproval(approval.id, option.optionId)}>{option.label}</button>)}</div></section>)}
      <form className="ln-composer" onSubmit={event => { event.preventDefault(); if (!sending && !composing.current && (draft.trim() || files.length)) onSend(recipient || undefined) }}>
        {files.length > 0 && <div className="ln-pending-files">{files.map((file, index) => <span key={`${file.name}-${index}`}><Icon name="file" size={14}/>{file.name}<button type="button" aria-label={`移除${file.name}`} onClick={() => onFiles(files.filter((_, i) => i !== index))}><Icon name="close" size={12}/></button></span>)}</div>}
        <textarea ref={input} value={draft} onChange={event => onDraft(event.target.value)} aria-label={`给${activeAgent?.displayName || title}发消息`} placeholder={`给 ${activeAgent?.displayName || title} 发消息`} rows={1} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
        }}/>
        <footer className="ln-composer-footer"><div className="ln-composer-left"><input ref={fileInput} type="file" multiple hidden onChange={event => { if (event.target.files) onFiles([...files, ...Array.from(event.target.files)]); event.target.value = '' }}/><IconButton icon="plus" label="添加附件" onClick={() => fileInput.current?.click()}/>
          <div className="ln-recipient-control"><button type="button" className="ln-recipient-chip" aria-expanded={menu} onClick={() => setMenu(!menu)}><Avatar agent={activeAgent} size={17}/><span>{activeAgent?.displayName || 'LOOM'} 默认</span><Icon name="down" size={12}/></button>
            {menu && <div className="ln-recipient-menu" role="menu">{availableRecipients.map(agent => <button key={agent.agentId} type="button" role="menuitem" onClick={() => { setRecipient(agent.agentId); setMenu(false) }}><Avatar agent={agent} size={22}/><span>{agent.displayName}</span>{activeAgent?.agentId === agent.agentId && <Icon name="check" size={14}/>}</button>)}</div>}
          </div></div><button className="ln-send-button" type="submit" aria-label={sending ? '正在发送' : '发送消息'} disabled={sending || (!draft.trim() && !files.length)}>{sending ? <span className="ln-spinner"/> : <Icon name="up" size={17}/>}</button></footer>
      </form>
    </div>
  </main>
}
