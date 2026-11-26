import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActionApprovalView, AgentRunView, DomainEventView, HostPlatformKey, ThreadMessageView } from '@contracts'
import type { AgentProfile, ArtifactSelection, ConversationItem, ThreadSnapshot, WorkBundle } from './types'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentOpenUiProvider, type AgentOpenUiHost } from './AgentOpenUiButton'
import { PiQuestionCard } from './PiQuestionCard'
import { questionKey, type PiAnswer, type PiQuestion } from './pi-questions'
import { Avatar } from './Avatar'
import { GroupAvatar } from './GroupAvatar'
import { mentionRecipient } from './group-mentions'
import { MentionPopup } from './MentionPopup'
import { completeMention, liveMentionQuery, mentionOptions, mentionQuery, mentionScope, type MentionMember, type MentionQuery } from './mention-completion'
import { useComposerSendPreference } from './ComposerSendPreference'
import { Icon, IconButton } from './icons'
import { MessageAttachments, PendingAttachments, addPickedAttachments, pasteAttachments, type AttachmentPreviewLoader } from './UserAttachments'
import { USER_ATTACHMENT_ACCEPT } from './user-attachments'
import { RunActivityLine, RunningActivity } from './RunningActivity'
import { runtimeFailureMessage } from '../RuntimeFailureNotice'
import { RuntimeInstallationGuide } from '../RuntimeInstallationGuide'
import { runtimeInstallGuide } from '../runtime-install-guide'
import { isNewConversationMemberAvailable, newConversationMemberStatus } from '../new-conversation-availability'
import { agentRunPresentation } from '../../../shared/execution-presentation'
import { shouldSendComposerKey } from '../../../shared/shortcuts'
import { adapterLabel } from '../runtime-products'

/** 群成员系统行（验收 C2）：由 timeline 的群成员变更事件生成，是聊天流条目，不写库、不进「会话记录」。 */
export type MemberSystemLine = {
  key: string
  eventId: string | null
  agentId: string | null
  kind: 'added' | 'removed'
  text: string
  createdAt: string
}

/** 聊天流条目：消息与群成员系统行按时间合并后的统一形状。 */
type ChatFlowEntry =
  | { kind: 'message'; key: string; at: string; message: ThreadMessageView }
  | { kind: 'member-line'; key: string; at: string; line: MemberSystemLine }

/** DomainEventView.payload 是 unknown：只有能在 payload 里归属到 agentId 的事件才出系统行，不做猜测。 */
function memberEventPayloadAgentId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const agentId = (payload as { agentId?: unknown }).agentId
  return typeof agentId === 'string' && agentId !== '' ? agentId : null
}

function memberEventKind(eventType: string): 'added' | 'removed' | null {
  if (eventType === 'camp.member_added' || eventType === 'thread.member_added') return 'added'
  if (eventType === 'camp.member_removed' || eventType === 'thread.member_removed') return 'removed'
  return null
}

/**
 * 验收 C2：`snapshot.timeline` 里的 `camp.member_added` / `camp.member_removed`（`payload.agentId`
 * 归属）生成聊天流系统行，文案固定 `{助手名}已加入群聊` / `{助手名}已移出群聊`。助手名优先
 * agents 的 displayName，其次 snapshot.members，缺失用「助手」。按事件 id 去重（eventId 可空时
 * 退回 globalSequence 兜底），同一条事件重复出现在 timeline 里也只出一行；本文件没有
 * memberCreation 卡片，不会与新助手的 memberCreation 重复出第二行。
 */
export function memberSystemLines(
  timeline: readonly DomainEventView[],
  agents: readonly AgentProfile[],
  members: readonly { agentId: string; displayName: string }[]
): MemberSystemLine[] {
  const seen = new Set<string>()
  const lines: MemberSystemLine[] = []
  for (const event of timeline) {
    const kind = memberEventKind(event.eventType)
    if (!kind) continue
    const dedupeKey = event.eventId ?? `seq:${event.globalSequence}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    const agentId = memberEventPayloadAgentId(event.payload)
    if (!agentId) continue
    const name = agents.find(agent => agent.agentId === agentId)?.displayName
      || members.find(member => member.agentId === agentId)?.displayName
      || '助手'
    lines.push({
      key: `member:${dedupeKey}`,
      eventId: event.eventId,
      agentId,
      kind,
      text: kind === 'added' ? `${name}已加入群聊` : `${name}已移出群聊`,
      createdAt: event.createdAt
    })
  }
  return lines
}

export function ConversationView({ item, snapshot, agents, bundles, loading, sending, draft, files, error, onDraft, onFiles, onSend, onPrompt, onProfile, onArtifact, onShowSidebar, sidebarHidden, onShowWork, inspectorHidden, onAttachment, onPreviewAttachment, onResolveApproval, approvalBusy, onMembers, onWorkspaceManager, onRetryRun, onConfigureRuntime, onOpenRuntimeSetup, hostPlatform = null, questions = [], onAnswerQuestion, onStopRun, stoppingRunIds = [] }: {
  item: ConversationItem | null; snapshot: ThreadSnapshot | null; agents: AgentProfile[]; bundles: WorkBundle[]; loading: boolean; sending: boolean
  draft: string; files: File[]; error: string | null; onDraft(value: string): void; onFiles(files: File[]): void
  onSend(agentId?: string): void; onPrompt?(text: string): Promise<boolean>; onProfile(): void; onArtifact(selection: ArtifactSelection): void
  onShowSidebar(): void; sidebarHidden: boolean; onShowWork(): void; inspectorHidden: boolean
  onAttachment(messageId: string, attachmentId: string): void
  /** Image thumbnails for a sent attachment read back through Core; absent when the connection cannot preview. */
  onPreviewAttachment?: AttachmentPreviewLoader
  onResolveApproval(approvalId: string, optionId: string): void; approvalBusy: boolean; onMembers?(): void; onWorkspaceManager?(): void
  questions?: PiQuestion[]; onAnswerQuestion?(question: PiQuestion, answer: PiAnswer): Promise<void>
  onRetryRun?(): void; onConfigureRuntime?(): void; onOpenRuntimeSetup?(): void; hostPlatform?: HostPlatformKey | null
  onStopRun?(run: AgentRunView): void; stoppingRunIds?: readonly string[]
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const pinned = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // 发送方式（回车 / Ctrl+Enter）：桌面端由 ShortcutProvider 托管，Web 直连走 localStorage。
  const sendPreference = useComposerSendPreference()
  // @ 候选状态带着作用域：换会话/换快照时旧候选同步失效，不可能被显示，也不可能被选中。
  const [mention, setMention] = useState<{ scope: string; query: MentionQuery } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionToken = useRef<string | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const activeAgent = agents.find(agent => agent.agentId === (item?.agentId || snapshot?.thread.defaultLeadAgentId))
  const messages = useMemo(() => snapshot?.messages.filter(message => !message.withdrawn) ?? [], [snapshot?.messages])
  const visibleMessages = useMemo(() => messages.filter(message => message.authorType !== 'system'), [messages])
  const systemMessages = useMemo(() => messages.filter(message => message.authorType === 'system'), [messages])
  const pendingQuestions = questions.filter(question => question.threadId === snapshot?.thread.id)
  const waitingRuns = new Set(pendingQuestions.map(question => question.agentRunId))
  const running = useMemo(() => snapshot?.agentRuns.filter(run => ['running', 'queued', 'waiting'].includes(run.status)) ?? [], [snapshot?.agentRuns])
  // 最近一次运行：只有在它已经终止时才在 transcript 末尾留一条状态行（Mikka 的 activityLine）。
  const latestRun = useMemo(() => {
    const runs = [...(snapshot?.agentRuns ?? [])]
      .sort((left, right) => (left.startedAt ?? left.createdAt).localeCompare(right.startedAt ?? right.createdAt))
    return runs[runs.length - 1] ?? null
  }, [snapshot?.agentRuns])
  const endedRun = latestRun && ['succeeded', 'failed', 'cancelled'].includes(latestRun.status) ? latestRun : null
  // Mikka approval-card `:573-576`：处理完的授权不整块消失，交互区收起后降级成一条结论行。
  // 这里只留最近一次已处理的请求，避免历史授权把输入区顶走。
  const resolvedApproval = useMemo(() => {
    const resolved = (snapshot?.approvals ?? []).filter(approval => approval.status !== 'pending')
      .sort((left, right) => (left.resolvedAt ?? left.requestedAt).localeCompare(right.resolvedAt ?? right.requestedAt))
    return resolved[resolved.length - 1] ?? null
  }, [snapshot?.approvals])
  const activeMembers = useMemo(() => snapshot ? agents.filter(agent => snapshot.members.some(member => member.agentId === agent.agentId && member.membershipStatus === 'active')) : agents, [snapshot?.members,agents])
  // 两位以上在册成员才算群聊。群的称呼挂在群上，不挂在其中某一位助手身上。
  const isGroup = (snapshot?.members.filter(member => member.membershipStatus === 'active').length ?? 0) > 1
  // @ 补全只在群聊、且会话条目与快照同步时开：单聊、快照缺失、两者不同步一律没有候选。
  const scope = mentionScope(item, snapshot, isGroup)
  // 草稿在别处被改写（发送后清空、换会话）时上一轮的区间立刻作废，不留悬空候选。
  const openMention = scope && mention && mention.scope === scope && mention.query.end <= draft.length && draft.startsWith('@', mention.query.start) ? mention.query : null
  // 候选只来自当前会话的在册成员，不造 everyone/别名，最多 10 个。
  const mentionChoices = useMemo(() => openMention ? mentionOptions(activeMembers, openMention.query) : [], [openMention, activeMembers])
  const mentionOpen = openMention && mentionChoices.length > 0 ? openMention : null
  const mentionActiveIndex = Math.min(mentionIndex, Math.max(0, mentionChoices.length - 1))
  // 聊天流（验收 C2）：timeline 的群成员系统行与消息按时间并入同一条流；不写库、不进
  // systemMessages 的「会话记录」折叠区。空态判断和滚动锚点 lastId 都按这条流算，不含它们会漏。
  const memberLines = useMemo(
    () => memberSystemLines(snapshot?.timeline ?? [], agents, snapshot?.members ?? []),
    [snapshot?.timeline, agents, snapshot?.members]
  )
  const flowEntries = useMemo<ChatFlowEntry[]>(() => {
    const entries: ChatFlowEntry[] = visibleMessages.map(message => ({ kind: 'message' as const, key: `message:${message.id}`, at: message.createdAt, message }))
    for (const line of memberLines) entries.push({ kind: 'member-line', key: line.key, at: line.createdAt, line })
    // ISO 时间字符串按字典序即按时间序；等值时 sort 稳定，消息保持原序，系统行排在同刻消息之后。
    return entries.sort((left, right) => left.at.localeCompare(right.at))
  }, [visibleMessages, memberLines])
  const lastId = flowEntries[flowEntries.length - 1]?.key
  // 换会话就是换候选范围：上一轮的候选和光标区间一律丢掉。
  useEffect(() => { mentionToken.current = null; setMention(null); setMentionIndex(0) }, [item?.id, snapshot?.thread.id])
  // 补全后把光标放回正文：受控 textarea 要等新值渲染完再设区间。
  useEffect(() => {
    if (pendingCaret.current === null || !input.current) return
    const caret = pendingCaret.current
    pendingCaret.current = null
    input.current.setSelectionRange(caret, caret)
  }, [draft])
  useEffect(() => { pinned.current = true; setShowLatest(false) }, [item?.id])
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
  // 群里说话是「给群名发消息」（Mikka `group-chat-view.tsx:271` 传的是 group.title）；
  // 只有单聊才写助手名（Mikka `messages/zh-CN.json:212` Nav.messageBot）。
  const speakerName = isGroup ? title : activeAgent?.displayName || title
  const artifacts = useMemo(() => bundles.filter(bundle => bundle.mission.threadId === snapshot?.thread.id).flatMap(bundle => bundle.artifacts.map(artifact => ({ artifact, bundle, candidate: bundle.candidates.find(candidate => candidate.evidenceIds.includes(artifact.artifactId)) ?? null }))), [bundles,snapshot?.thread.id])
  // An OpenUI card's click continues this conversation through the same send path the composer uses.
  const openUiHost = useMemo<AgentOpenUiHost | null>(() => onPrompt ? { send: onPrompt } : null, [onPrompt])
  // 按 textarea 的真实光标重算 @ 查询；只有换了一个 token 才把高亮归零，↑↓ 浏览时不清零。
  const syncMention = (element: HTMLTextAreaElement): void => {
    // 输入法组合中、或当前作用域没有候选（单聊/快照不同步）时不开候选。
    if (composing.current || !scope) { mentionToken.current = null; setMention(null); setMentionIndex(0); return }
    const next = mentionQuery(element.value, element.selectionStart ?? element.value.length, element.selectionEnd ?? element.value.length, activeMembers)
    const token = next ? `${next.start}:${next.end}:${next.query}` : null
    setMention(next ? { scope, query: next } : null)
    if (mentionToken.current !== token) { mentionToken.current = token; setMentionIndex(0) }
  }
  // 选中候选人：只替换 `@查询` 这一段，前后正文原样保留，收件人解析仍由 mentionRecipient 决定。
  // 点选也要按 textarea 的实时正文与选区复核：弹层是上一帧的状态，全选/光标移走/草稿被改写后
  // 旧区间已经作废，不能拿它去替换正文；复核不过就只关弹层，什么都不改。
  const pickMention = (member: MentionMember): void => {
    const element = input.current
    const text = element?.value ?? draft
    const live = liveMentionQuery(mentionOpen, text, element?.selectionStart ?? -1, element?.selectionEnd ?? -1)
    if (!live) { mentionToken.current = null; setMention(null); setMentionIndex(0); return }
    const next = completeMention(text, live, member)
    onDraft(next.text)
    if (next.text === text) element?.setSelectionRange(next.caret, next.caret)
    else pendingCaret.current = next.caret
    mentionToken.current = null
    setMention(null); setMentionIndex(0)
  }
  return <AgentOpenUiProvider value={openUiHost}>
  <main className="ln-conversation" aria-label={`与${title}的对话`}>
    <header className="ln-chat-header">
      {sidebarHidden && <IconButton icon="panel" label="展开会话列表" onClick={onShowSidebar} className="ln-chat-sidebar-toggle"/>}
      <button type="button" className="ln-identity-pill" onClick={onProfile}>{isGroup ? <GroupAvatar title={title} members={activeMembers} size={23}/> : <Avatar agent={activeAgent} name={title} size={23}/>}<strong>{title}</strong></button>
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
      {!loading && !flowEntries.length && <div className="ln-chat-empty">{isGroup ? <GroupAvatar title={title} members={activeMembers} size={52}/> : <Avatar agent={activeAgent} name={title} size={52}/>}<h1>{title}</h1><p>{item?.threadId ? '从一条消息开始。' : '聊聊想法，或交给我一件事。'}</p></div>}
      {flowEntries.map(entry => {
        if (entry.kind === 'member-line') {
          return <p key={entry.key} className="ln-member-system-line" data-member-event-kind={entry.line.kind} data-event-id={entry.line.eventId ?? undefined} data-agent-id={entry.line.agentId ?? undefined}>{entry.line.text}</p>
        }
        const message = entry.message
        const user = message.authorType === 'user' || message.authorType === 'external_principal'
        const author = agents.find(agent => agent.agentId === message.authorId)
        const handoff = !user && /\[LOOM_HANDOFF|"dispatchId"|"tool_call_id"/.test(message.body)
        return <article className={`ln-message ${user ? 'is-user' : 'is-assistant'} ${handoff ? 'is-record' : ''}`} key={message.id} data-message-id={message.id}>
          {!user && snapshot && snapshot.members.length > 1 && <div className="ln-message-author"><Avatar agent={author} name={message.authorDisplayName || ''} size={16}/><span>{author?.displayName || message.authorDisplayName || '助手'}</span></div>}
          {handoff ? <details className="ln-execution-record"><summary><Icon name="branch" size={14}/><span>执行记录</span><Icon name="right" size={12}/></summary><AgentMarkdown text={message.body}/></details>
            : <div className="ln-message-content"><AgentMarkdown text={message.body}/></div>}
          {message.attachments.length > 0 && snapshot && <MessageAttachments attachments={message.attachments} threadId={snapshot.thread.id} messageId={message.id} loadPreview={onPreviewAttachment} onOpen={attachmentId => onAttachment(message.id, attachmentId)}/>}
          <div className="ln-message-actions"><button type="button" aria-label="复制消息" title="复制消息" onClick={() => { void navigator.clipboard.writeText(message.body).then(() => { setCopied(message.id); window.setTimeout(() => setCopied(null), 1500) }) }}><Icon name={copied === message.id ? 'check' : 'copy'} size={13}/></button><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
        </article>
      })}
      {artifacts.length > 0 && <div className="ln-delivered-files">{artifacts.map(selection => <button type="button" className="ln-artifact-card" key={selection.artifact.artifactId} onClick={() => onArtifact(selection)}><span className="ln-document-icon"><Icon name="file" size={22}/></span><span><strong>{selection.artifact.relativePath.split(/[\\/]/).pop()}</strong><small>{selection.candidate?.acceptanceStatus === 'accepted' ? '已接受' : selection.candidate?.acceptanceStatus === 'rejected' ? '已退回' : '等待审阅'}</small></span><Icon name="right" size={15}/></button>)}</div>}
      {pendingQuestions.map(question => onAnswerQuestion && <PiQuestionCard key={questionKey(question)} question={question} name={agents.find(agent => agent.agentId === question.agentId)?.displayName || '助手'} onAnswer={onAnswerQuestion}/>)}
      {running.map(run => waitingRuns.has(run.id)
        ? <p key={run.id} role="status">{agents.find(agent => agent.agentId === run.agentId)?.displayName || '助手'} · 等你回答</p>
        : <RunningActivity key={run.id} label={`${agents.find(agent => agent.agentId === run.agentId)?.displayName || '助手'}正在处理`}
          stopping={stoppingRunIds.includes(run.id) || run.cancelRequestedAt !== null}
          onStop={onStopRun ? () => onStopRun(run) : undefined}/>)}
      {endedRun && <RunActivityLine run={endedRun}/>}
      {endedRun?.status === 'failed' && <RunFailure run={endedRun} agent={agents.find(agent => agent.agentId === endedRun.agentId) ?? null} sending={sending} onRetry={onRetryRun} onConfigure={onConfigureRuntime} onOpenRuntimeSetup={onOpenRuntimeSetup} platform={hostPlatform}/>}
      {systemMessages.length > 0 && <details className="ln-system-records"><summary>会话记录 <span>{systemMessages.length}</span></summary>{systemMessages.map(message => <AgentMarkdown key={message.id} text={message.body}/>)}</details>}
    </div>
    <div className="ln-composer-area">
      {showLatest && <button type="button" className="ln-jump-latest" title="回到最新消息" aria-label="回到最新消息" onClick={jump}><Icon name="down" size={18}/></button>}
      {error && <div className="ln-send-error" role="alert" data-slot="send-error"><strong>请求失败，请稍后重试。</strong>{error.trim() && error.trim() !== '请求失败，请稍后重试。' && <small>{error}</small>}<p>你的输入已保留。</p><button type="button" disabled={sending || (!draft.trim() && !files.length)} onClick={() => onSend(isGroup ? mentionRecipient(draft, activeMembers) : undefined)}>{sending ? '正在重试…' : '重试此回复'}</button></div>}
      {snapshot?.approvals.filter(approval => approval.status === 'pending').map(approval => <section className="ln-approval-request" key={approval.id} aria-label="等待你的授权" data-state={approval.status} aria-busy={approvalBusy}><strong><Icon name="hand" size={16}/>需要你确认<span className="ln-approval-state" data-state={approval.status}>{approvalStatusLabel(approval.status)}</span></strong><p>{approval.actionSummary}</p>{approval.reason && <small>{approval.reason}</small>}<p className="ln-approval-scope">{agents.find(agent => agent.agentId === approval.agentId)?.displayName || '当前助手'} · {approval.options.some(option => option.kind === 'allow_session') ? '持续授权仅限此原生会话，具体范围见选项。' : '本次请求按运行端提供的范围授权。'}</p><div>{approval.options.map(option => <button type="button" disabled={approvalBusy} key={option.optionId} title={option.consequence} className={option.kind === 'allow_once' ? 'is-once' : option.kind === 'allow_session' ? 'is-persistent' : ''} onClick={() => onResolveApproval(approval.id, option.optionId)}>{option.label}</button>)}</div></section>)}
      {resolvedApproval && <p className="ln-approval-result" data-slot="approval-result" data-state={resolvedApproval.status} aria-label={`${approvalStatusLabel(resolvedApproval.status)}的授权`}><Icon name={resolvedApproval.status === 'approved' ? 'check' : 'blocked'} size={14}/><span>{resolvedApproval.actionSummary}</span><em>{approvalStatusLabel(resolvedApproval.status)}</em></p>}
      <form className="ln-composer" onPaste={event => { if (pasteAttachments(event.clipboardData, files, onFiles)) { event.preventDefault(); event.stopPropagation() } }} onSubmit={event => { event.preventDefault(); if (!sending && !composing.current && (draft.trim() || files.length)) onSend(isGroup ? mentionRecipient(draft, activeMembers) : undefined) }}>
        <PendingAttachments files={files} onRemove={onFiles}/>
        {mentionOpen && <MentionPopup id="ln-mention-options" options={mentionChoices} activeIndex={mentionActiveIndex} onPick={pickMention} onHover={setMentionIndex}/>}
        <textarea ref={input} value={draft}
          onChange={event => { onDraft(event.target.value); syncMention(event.target) }}
          aria-label={`给${speakerName}发消息`} placeholder={`给 ${speakerName} 发消息`} rows={1}
          aria-expanded={mentionOpen ? true : undefined} aria-controls={mentionOpen ? 'ln-mention-options' : undefined}
          aria-activedescendant={mentionOpen ? `ln-mention-options-option-${mentionActiveIndex}` : undefined}
          onCompositionStart={() => { composing.current = true; mentionToken.current = null; setMention(null); setMentionIndex(0) }}
          onCompositionEnd={event => { composing.current = false; syncMention(event.currentTarget) }}
          onClick={event => syncMention(event.currentTarget)}
          onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') syncMention(event.currentTarget) }}
          onBlur={() => { mentionToken.current = null; setMention(null); setMentionIndex(0) }}
          onKeyDown={event => {
            // 输入法组合中的按键（含 keyCode 229）一个都不拦：回车/方向键/Tab 交给 IME。
            const composingNow = composing.current || event.nativeEvent.isComposing || event.keyCode === 229
            if (composingNow) return
            // 弹层状态是上一帧的：Ctrl/Cmd+A 全选、光标移走、草稿在别处被改写之后它可能已经过期。
            // 拦键前按 textarea 的实时正文与选区复核，只有折叠光标仍在显示的查询里才算数；
            // 过期就关掉弹层，Tab/Enter 照常走焦点与发送，不拿旧区间替换正文。
            const live = liveMentionQuery(mentionOpen, event.currentTarget.value, event.currentTarget.selectionStart ?? -1, event.currentTarget.selectionEnd ?? -1)
            if (mentionOpen && !live) { mentionToken.current = null; setMention(null); setMentionIndex(0) }
            if (live) {
              if (event.key === 'ArrowDown') { event.preventDefault(); setMentionIndex(index => (index + 1) % mentionChoices.length); return }
              if (event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex(index => (index - 1 + mentionChoices.length) % mentionChoices.length); return }
              if (event.key === 'Escape') { event.preventDefault(); setMention(null); setMentionIndex(0); return }
              // 候选展开时普通回车 / Tab 是「选人」而不是发送；带修饰键的回车仍交给发送方式判定。
              const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
              if (plain && (event.key === 'Enter' || event.key === 'Tab')) { event.preventDefault(); pickMention(mentionChoices[mentionActiveIndex]); return }
            }
            // Shift+Enter 换行；发送键由共享的 shouldSendComposerKey 按偏好判定，不另立规则。
            if (shouldSendComposerKey({ key: event.key, isComposing: composingNow, repeat: event.repeat, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey }, sendPreference.platform, sendPreference.sendMode)) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}/>
        {isGroup && activeMembers.length > 0 && <p className="ln-composer-hint">写 <strong>@名字</strong> 指定谁回复，不 @ 时由服务端挑选。可 @ {activeMembers.map(agent => agent.displayName).join('、')}</p>}
        <footer className="ln-composer-footer"><div className="ln-composer-left"><input ref={fileInput} type="file" multiple accept={USER_ATTACHMENT_ACCEPT} hidden onChange={event => { addPickedAttachments(event.target.files, files, onFiles); event.target.value = '' }}/><IconButton icon="plus" label="添加图片或附件（也可直接粘贴图片）" onClick={() => fileInput.current?.click()}/></div><button className="ln-send-button" type="submit" aria-label={sending ? '正在发送' : '发送消息'} disabled={sending || (!draft.trim() && !files.length)}>{sending ? <span className="ln-spinner"/> : <Icon name="up" size={17}/>}</button></footer>
      </form>
    </div>
  </main>
  </AgentOpenUiProvider>
}

/**
 * 复用 `new-conversation-availability.ts` 的判定与文案：同一个「未配置智能体／智能体不可用」
 * 结论，用在创建入口，也用在**失败的那一刻**（Mikka 的 `agentNoModel`/`agentHarnessMissing`
 * 两边同一个口径，错误里自带修复入口）。AgentProfile 与 ThreadCreationPreflight 的成员投影
 * 字段不同名，这里只做一次形状对齐，判定本身还是调那两个函数。
 */
export function runRuntimeGuidance(agent: AgentProfile | null): { available: boolean; status: string } | null {
  if (!agent) return null
  const candidate = {
    runtimeConfigured: agent.runtimeConfiguration !== null,
    runtimeReadiness: agent.runtimeReadiness.status,
    executionAvailability: agent.executionAvailability
  }
  return { available: isNewConversationMemberAvailable(candidate), status: newConversationMemberStatus(candidate) }
}

/**
 * Mikka `components/agents/approval-card/index.tsx:49-57` 的状态词：`submitting → 正在继续`、
 * `approved → 已同意`、`rejected → 已拒绝`、`answered → 已填写意见`，pending 兜底
 * `awaitingYourChoice`（「等待你的选择」）。LOOM 的授权状态词表与之一一对应。
 */
export function approvalStatusLabel(status: ActionApprovalView['status']): string {
  return ({ pending: '等待你的选择', approved: '已同意', denied: '已拒绝', cancelled: '已取消', expired: '已过期' } as const)[status]
}

/**
 * Mikka `components/workspace/issue-thread-panel.tsx:557-562` 的 `thread-failure`：失败是时间线里的
 * 一个条目，里面是「人话原因 + 错误码折叠 + 修复入口 + 重试」。原因取
 * `RuntimeFailureNotice.tsx` 的 `runtimeFailureMessage()`；没有结构化 failure 时退回共享的
 * `agentRunPresentation()` 短词（如「尚未配置 Runtime」），不自己另编一套。
 */
export function RunFailure({ run, agent, sending, onRetry, onConfigure, onOpenRuntimeSetup, platform = null }: {
  run: AgentRunView; agent: AgentProfile | null; sending: boolean
  onRetry?(): void; onConfigure?(): void; onOpenRuntimeSetup?(): void; platform?: HostPlatformKey | null
}) {
  const reason = run.failure ? runtimeFailureMessage(run.failure) : agentRunPresentation(run).label
  const guidance = runRuntimeGuidance(agent)
  const adapter = agent?.runtimeConfiguration?.adapterKind ?? null
  // Mikka `messages/zh-CN.json:1047-1061`（`未检测到 Agent / 还没装 Agent / 怎么装 / 复制 {command}`）
  // 把「先装再跑」的指南放在卡住的地方，而不是只到「未配置智能体」为止。平台未知时不猜命令，
  // 只给官方安装说明（`runtimeInstallGuide` 在 platform 为 null 时本来就不下发 shell 命令）。
  const guide = adapter ? runtimeInstallGuide(adapter, platform) : null
  const needsLogin = agent?.runtimeReadiness.blockers.some(blocker => /auth|login/.test(blocker.code)) ?? false
  return <section className="ln-run-failure" role="alert" data-run-id={run.id} data-state="failed" aria-label="这次运行没有完成">
    <p className="ln-run-failure-reason">{reason}</p>
    {run.terminalReasonCode && <details className="ln-run-failure-code"><summary>错误码</summary><code>{run.terminalReasonCode}</code></details>}
    {guidance && !guidance.available && <p className="ln-run-failure-state">{agent?.displayName || '当前助手'} · {guidance.status}。先配置好运行端，再重试这次请求。</p>}
    {guide && guidance && !guidance.available && <details className="ln-run-failure-guide" data-slot="run-install-guide">
      <summary>{needsLogin ? '怎么登录' : '还没装 Agent，怎么装'}</summary>
      <RuntimeInstallationGuide id={`ln-run-failure-guide-${run.id}`} label={adapter ? adapterLabel(adapter) : '运行端'} guide={guide}
        mode={needsLogin ? 'login' : 'install'} busy={false} checking={false} feedback={null}
        onCheck={() => onOpenRuntimeSetup?.()}/>
    </details>}
    <div className="ln-run-failure-actions">
      <button type="button" className="ln-action" disabled={sending || !onRetry} onClick={onRetry}>{sending ? '正在重试…' : '重试'}</button>
      <button type="button" className="ln-action is-primary" disabled={!onConfigure} onClick={onConfigure}>去配置运行端</button>
    </div>
  </section>
}
