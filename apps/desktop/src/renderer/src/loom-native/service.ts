import { enqueueOutbox, updateOutbox, type PendingRecord } from './pending-outbox-store'
import { observeUnconfirmedThreadSend } from '../camp-client'
import type {
  AgentProfile,
  ComposerDocument,
  ComposerSegment,
  LocalAttachmentSourceView,
  LoomArtifactsListResult,
  LoomCandidate,
  LoomPlan,
  LoomReview,
  LoomStageReview,
  LoomTask,
  LoomVerification,
  MissionRecord,
  NavigationSnapshot,
  NavigationThreadItem,
  SendThreadMessageResult,
  StoredCommandResult,
  ThreadComposerDraftView,
  ThreadOpenProjection,
  ThreadSnapshot
} from '@contracts'
import { THREAD_SNAPSHOT_SCHEMA_VERSION } from '@contracts'
import { newCommandId } from '../../../shared/command-id'
import { readErrorMessage } from '../error-message'
import { uiAttribute } from '../interface-language'
import {
  clearLocalThreadComposerDraft,
  emptyLocalThreadComposerDraft,
  loadLocalThreadComposerDraft,
  saveLocalThreadComposerDraft,
  MAX_LOCAL_COMPOSER_ATTACHMENTS
} from '../camp-composer-local-store'
import type { ThreadClient } from '../camp-client'
import { classifyControlSnapshot, LOOM_CONTROL_GET } from './control-service'
import type {
  ConversationItem,
  WorkBundle,
  WorkControlFacts,
  WorkControlUnknown,
  WorkControlUnknownReason,
  WorkStageReviewFacts
} from './types'

/** Bounded fan-out for the right pane's all-work projection. */
export const LOOM_BUNDLE_CONCURRENCY = 4
/** One navigation read covers every conversation the unified sidebar can show. */
export const LOOM_NAVIGATION_SCHEMA_VERSION = 3

type Reader = Pick<ThreadClient, 'request'>

/** A rejected Core command. Carries the deterministic result so callers can re-render authors. */
export class LoomCommandRejected extends Error {
  constructor(readonly result: StoredCommandResult) {
    super(loomCommandMessage(result))
    this.name = 'LoomCommandRejected'
  }
}

/** An unsent local draft already owns this Thread's composer. Never overwrite it unseen. */
export class LoomDraftConflict extends Error {
  constructor(readonly draftText: string) {
    super(uiAttribute('这个会话里有一份尚未发送的草稿，已原样保留。请先在输入框中确认它的内容后再发送。'))
    this.name = 'LoomDraftConflict'
  }
}

export function loomCommandMessage(result: StoredCommandResult): string {
  const code = typeof result.code === 'string' && result.code !== '' ? result.code : 'command.rejected'
  return uiAttribute('操作未完成（{0}），请重试。', code)
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | null {
  if (!payload) return null
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function requireArray<T>(value: T[] | null | undefined, message: string): T[] {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

// ---------------------------------------------------------------- roster

export async function readAgents(client: Reader): Promise<AgentProfile[]> {
  return requireArray(await client.request<AgentProfile[]>('members.list'),
    uiAttribute('队员名单读取结果不可用，请重试。'))
}

// ----------------------------------------------------------- conversation list

/** Complete snapshot: the native sidebar has no project sections to window. */
export async function readNavigation(client: Reader): Promise<NavigationSnapshot> {
  const snapshot = await client.request<NavigationSnapshot | null>('navigation.snapshot', {})
  if (!snapshot || (snapshot as { schemaVersion: number }).schemaVersion !== LOOM_NAVIGATION_SCHEMA_VERSION
    || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.quickChat?.recentThreads)) {
    throw new Error(uiAttribute('会话列表数据版本不兼容，请重试。'))
  }
  return snapshot
}

export async function readMissions(client: Reader): Promise<MissionRecord[]> {
  return requireArray(await client.request<MissionRecord[]>('missions.list'),
    uiAttribute('使命列表读取结果不可用，请重试。'))
}

/** Every thread exactly once, newest activity first. */
export function navigationThreads(navigation: NavigationSnapshot): NavigationThreadItem[] {
  const seen = new Set<string>()
  const rows: NavigationThreadItem[] = []
  for (const thread of [
    ...navigation.quickChat.recentThreads,
    ...navigation.projects.flatMap(group => group.recentThreads)
  ]) {
    if (seen.has(thread.id)) continue
    seen.add(thread.id)
    rows.push(thread)
  }
  return rows.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
}

function projectLabel(thread: NavigationThreadItem): string {
  const parts = thread.projectPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? uiAttribute('对话')
}

/**
 * One row per existing Thread; then one row per member that owns no Thread at all.
 * A member row has no Thread, so selecting it stays read-only until an explicit send.
 */
export function conversationItems(
  agents: AgentProfile[],
  navigation: NavigationSnapshot,
  missions: MissionRecord[]
): ConversationItem[] {
  const missionByThreadId = new Map(missions.map(mission => [mission.threadId, mission]))
  const rows = navigationThreads(navigation)
  const items: ConversationItem[] = rows.map(thread => {
    const mission = missionByThreadId.get(thread.id) ?? null
    return {
      id: thread.id,
      title: thread.title,
      subtitle: mission?.title ?? thread.defaultLead?.displayName ?? projectLabel(thread),
      agentId: thread.defaultLead?.agentId ?? mission?.defaultLeadAgentId ?? null,
      threadId: thread.id,
      missionId: mission?.missionId ?? null,
      unread: thread.marker === 'unread_completed',
      updatedAt: thread.lastActivityAt
    }
  })
  // Mission threads may be deliberately absent from ordinary navigation groups.
  // They are still actual conversations and must appear in the unified list.
  const listed = new Set(items.map(item => item.threadId))
  for (const mission of missions) {
    if (listed.has(mission.threadId)) continue
    items.unshift({ id: mission.threadId, title: mission.title,
      subtitle: mission.description || '工作对话', agentId: mission.defaultLeadAgentId,
      threadId: mission.threadId, missionId: mission.missionId,
      unread: mission.hasUnread, updatedAt: mission.updatedAt })
    listed.add(mission.threadId)
  }
  const dedicated = new Set(rows.filter(thread => !missionByThreadId.has(thread.id)).flatMap(thread => thread.defaultLead ? [thread.defaultLead.agentId] : []))
  const orphans: ConversationItem[] = agents
    .filter(agent => agent.presence !== 'removed' && agent.removedAt === null && !dedicated.has(agent.agentId))
    .sort((left, right) => left.memberOrder - right.memberOrder || left.agentId.localeCompare(right.agentId))
    .map(agent => ({
      id: `agent:${agent.agentId}`,
      title: agent.displayName,
      subtitle: agent.teamRole || uiAttribute('助手'),
      agentId: agent.agentId,
      threadId: null,
      missionId: null,
      unread: false,
      updatedAt: null
    }))
  return [...items, ...orphans]
}

/** Read-only bootstrap: prefer Missions that are executing, then any Mission, then any Thread. */
export function bootstrapSelection(
  items: ConversationItem[],
  missions: MissionRecord[]
): ConversationItem | null {
  const byId = new Map(missions.map(mission => [mission.missionId, mission]))
  const missionItems = items.filter(item => item.missionId !== null)
  const running = missionItems.find(item => (byId.get(item.missionId as string)?.runningAgentIds.length ?? 0) > 0)
  return running
    ?? missionItems[0]
    ?? items.find(item => item.threadId !== null)
    ?? items[0]
    ?? null
}

// ------------------------------------------------------------- thread reads

export async function readThreadSnapshot(client: Reader, threadId: string): Promise<ThreadSnapshot> {
  const projection = await client.request<ThreadOpenProjection>('threads.open', { threadId, traceId: newCommandId() })
  if (!projection || projection.schemaVersion !== 9 || projection.thread.id !== threadId) {
    throw new Error('会话打开数据版本不兼容，请重试。')
  }
  // The Web-approved open projection is the conversation's authoritative surface.
  // Unprojected audit collections are not rendered by this frontend.
  return {
    schemaVersion: THREAD_SNAPSHOT_SCHEMA_VERSION,
    throughGlobalSequence: projection.throughGlobalSequence,
    thread: projection.thread, members: projection.members,
    membershipReconciliations: projection.membershipReconciliations,
    tasksEnabled: projection.tasksEnabled, tasks: projection.tasks,
    memberCreations: projection.memberCreations,
    messages: projection.messages, messageDeliveries: projection.messageDeliveries,
    turns: projection.turns, agentRuns: projection.agentRuns,
    executionEvidence: projection.executionEvidence,
    agentRunFileChanges: projection.agentRunFileChanges,
    agentRunImages: projection.agentRunImages,
    approvals: projection.approvals,
    contextManifests: [], actions: [], timeline: []
  }
}

// ------------------------------------------------------------------ work

// -------------------------------------------------- control / stage review

/** 一次 `unknown` 控制事实：只是「还没读到」，不带任何「没有批准／在等你」的含义。 */
export function unknownWorkControl(
  reason: WorkControlUnknownReason,
  message: string
): WorkControlUnknown {
  return { status: 'unknown', reason, message }
}

/**
 * 回执 → 事实：只有属于本 Mission 且阶段审查回执完整的快照才算 `observed`。
 * 判定复用 `control-service` 的 `classifyControlSnapshot`（错 Mission 与缺字段都在那里），
 * 这里只把结果翻译成右栏用的三态事实，不另立第二套规则。
 *
 * 畸形回执只让控制事实变成 `unknown/invalid`：六源数据照常保留，绝不因一份坏投影
 * 丢掉整份 bundle，也绝不让分类器异常穿透到调用方。
 */
export function classifyWorkControl(raw: unknown, missionId: string): WorkControlFacts {
  const invalid = (message: string): WorkControlFacts => unknownWorkControl('invalid', message)
  // 缺 `policy` 字段的快照会让完整性检查读到 undefined：先按缺失字段收成 invalid。
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('policy' in raw)) {
    return invalid(uiAttribute('控制快照缺少必需字段：policy，阶段审查事实尚未确认。'))
  }
  try {
    const read = classifyControlSnapshot(raw, missionId)
    if (read.status === 'observed') return { status: 'observed', snapshot: read.snapshot }
    return invalid(read.message)
  } catch {
    return invalid(uiAttribute('控制回执无法识别，阶段审查事实尚未确认。'))
  }
}

/**
 * 读一个 Mission 的真实控制／阶段审查投影。
 * 失败不抛：右栏要保留「未知」，而不是把缺读取当成没有策略或等你拍板。
 */
async function readWorkControl(client: Reader, mission: MissionRecord): Promise<WorkControlFacts> {
  const missionId = mission.missionId.trim()
  if (missionId === '') {
    return unknownWorkControl('invalid',
      uiAttribute('「{0}」缺少工作标识，阶段审查事实尚未确认。', mission.title))
  }
  let raw: unknown
  try {
    raw = await client.request<unknown>(LOOM_CONTROL_GET, { missionId })
  } catch (error) {
    return unknownWorkControl('read_failed', readErrorMessage(error,
      uiAttribute('「{0}」的阶段审查事实读取失败，请重试。', mission.title)))
  }
  return classifyWorkControl(raw, missionId)
}

/** 有界并发：批量读取补齐控制事实时，逐 Mission 的请求数不超过 `LOOM_BUNDLE_CONCURRENCY`。 */
async function mapBounded<T, R>(
  items: readonly T[], limit: number, run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let index = cursor++; index < items.length; index = cursor++) results[index] = await run(items[index])
  })
  await Promise.all(workers)
  return results
}

/** Bundle 上的控制事实；缺省字段同样是「尚未读取」，不是「没有批准」。 */
export function workControl(bundle: WorkBundle): WorkControlFacts {
  return bundle.control
    ?? unknownWorkControl('not_read',
      uiAttribute('「{0}」的阶段审查事实尚未读取。', bundle.mission.title))
}

/** 阶段审查回执：控制事实未知时一律未知，绝不退化成空列表。 */
export function stageReviewFacts(bundle: WorkBundle): WorkStageReviewFacts {
  const control = workControl(bundle)
  if (control.status === 'unknown') return control
  const stageReviews = control.snapshot.stageReviews
  if (!Array.isArray(stageReviews)) {
    return unknownWorkControl('invalid',
      uiAttribute('「{0}」缺少阶段审查回执，审查结论尚未确认。', bundle.mission.title))
  }
  return { status: 'observed', stageReviews }
}

/**
 * 同一候选的最新阶段审查：按 `reviewedAt` 取最新，平手按回执顺序后写的为准
 * （与 `acceptance-state` 的 createdAt + 下标规则一致）。没有回执才是 null。
 */
export function latestStageReview(
  stageReviews: readonly LoomStageReview[],
  candidateId: string
): LoomStageReview | null {
  const time = (review: LoomStageReview): number => {
    const value = Date.parse(review.reviewedAt)
    return Number.isNaN(value) ? -Infinity : value
  }
  return stageReviews
    .filter(review => review.candidateId === candidateId)
    .reduce<LoomStageReview | null>((latest, review) =>
      latest === null || time(review) >= time(latest) ? review : latest, null)
}

/** Every projection this bundle needs is required; a failed read is an error, never an empty list.
 * The control projection is the exception: a failed control read keeps the bundle and records an
 * explicit unknown, because a missing read is not a "no policy" / "waiting for you" answer. */
export async function readWorkBundle(client: Reader, mission: MissionRecord): Promise<WorkBundle> {
  const { missionId } = mission
  const [plan, tasks, candidates, reviews, verifications, artifacts, control] = await Promise.all([
    client.request<LoomPlan | null>('loom.plan.get', { missionId }),
    client.request<LoomTask[]>('loom.tasks.list', { missionId }),
    client.request<LoomCandidate[]>('loom.candidates.list', { missionId }),
    client.request<LoomReview[]>('loom.reviews.list', { missionId }),
    client.request<LoomVerification[]>('loom.verifications.list', { missionId }),
    client.request<LoomArtifactsListResult | null>('loom.artifacts.list', { missionId }),
    readWorkControl(client, mission)
  ])
  const unavailable = uiAttribute('「{0}」的工作数据读取失败，请重试。', mission.title)
  return {
    mission,
    plan: plan ?? null,
    tasks: requireArray(tasks, unavailable),
    candidates: requireArray(candidates, unavailable),
    reviews: requireArray(reviews, unavailable),
    verifications: requireArray(verifications, unavailable),
    artifacts: requireArray(artifacts?.artifacts, unavailable),
    control
  }
}

/** All actual Missions, at most `LOOM_BUNDLE_CONCURRENCY` reads in flight. */
export async function readWorkBundles(
  client: Reader,
  missions: readonly MissionRecord[],
  concurrency = LOOM_BUNDLE_CONCURRENCY
): Promise<{ bundles: WorkBundle[]; errors: string[] }> {
  const queue = [...missions]
  const bundles: WorkBundle[] = []
  const errors: string[] = []
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (let mission = queue.shift(); mission; mission = queue.shift()) {
      try {
        bundles.push(await readWorkBundle(client, mission))
      } catch (error) {
        errors.push(readErrorMessage(error, uiAttribute('「{0}」的工作数据读取失败，请重试。', mission.title)))
      }
    }
  })
  await Promise.all(workers)
  bundles.sort((left, right) => right.mission.updatedAt.localeCompare(left.mission.updatedAt))
  return { bundles, errors }
}

/** One bounded read-only Core operation per 8 Missions. Older Hosts and
 * partially unavailable Missions use the existing six-source reconciliation,
 * so an unknown contract or broken projection never pretends to be empty.
 * The batch row carries the control projection when the Host includes it; when it does
 * not, the same `loom.control.get` read the ordinary path uses fills it in with bounded
 * concurrency, so both paths answer with the same facts instead of one guessing. */
export async function readWorkBundlesFast(
  client: Reader, missions: readonly MissionRecord[]
): Promise<{ bundles: WorkBundle[]; errors: string[] }> {
  const bundles: WorkBundle[] = [], errors: string[] = []
  for (let index=0; index<missions.length; index+=8) {
    const group=missions.slice(index,index+8)
    try {
      const value=await client.request<{bundles: Array<{
        missionId:string; plan:LoomPlan|null; tasks:LoomTask[]; candidates:LoomCandidate[];
        reviews:LoomReview[]; verifications:LoomVerification[]; artifacts:LoomArtifactsListResult|null;
        /** 旧 Host 不返回；返回了就按与普通读取同一套判定收敛。 */
        control?: unknown
      }>}>('loom.bundles.getMany',{missionIds:group.map(row=>row.missionId)})
      if (!value || !Array.isArray(value.bundles) || value.bundles.length!==group.length) throw Error('LOOM batch projection shape mismatch')
      const verified: WorkBundle[]=[]
      for(let i=0;i<group.length;i++){
        const row=value.bundles[i], mission=group[i]
        if(!row || row.missionId!==mission.missionId) throw Error('LOOM batch Mission identity mismatch')
        const error=uiAttribute('「{0}」的工作数据读取失败，请重试。',mission.title)
        verified.push({mission,plan:row.plan??null,tasks:requireArray(row.tasks,error),
          candidates:requireArray(row.candidates,error),reviews:requireArray(row.reviews,error),
          verifications:requireArray(row.verifications,error),artifacts:requireArray(row.artifacts?.artifacts,error),
          ...(row.control===undefined?{}:{control:classifyWorkControl(row.control,mission.missionId)})})
      }
      // 旧 Host 的批次行不带控制投影：用与普通读取同一个读取器补齐，且不放开并发。
      const withoutControl=verified.filter(bundle=>bundle.control===undefined)
      if(withoutControl.length>0){
        const facts=await mapBounded(withoutControl,LOOM_BUNDLE_CONCURRENCY,bundle=>readWorkControl(client,bundle.mission))
        withoutControl.forEach((bundle,index)=>{bundle.control=facts[index]})
      }
      bundles.push(...verified)
    }catch{
      // Compatible recovery: preserve the exact six-read truth and surface its
      // own errors. Never label a failed aggregate a successful blank board.
      const recover=await readWorkBundles(client,group)
      bundles.push(...recover.bundles);errors.push(...recover.errors)
    }
  }
  bundles.sort((a,b)=>b.mission.updatedAt.localeCompare(a.mission.updatedAt))
  return {bundles,errors}
}

// --------------------------------------------------------------- composing

function composerDocument(text: string, recipientAgentId?: string): ComposerDocument {
  const segments: ComposerSegment[] = []
  if (recipientAgentId) segments.push({ kind: 'atom', atom: { type: 'member', agentId: recipientAgentId } })
  if (text !== '') segments.push({ kind: 'text', text })
  return { version: 2, segments }
}

/**
 * The revisioned draft protocol: an existing local draft keeps its revision, quotes,
 * attachments and reply/continuation routing. The body passed to an explicit send is
 * the visible composer's confirmed content, so it replaces the preserved body instead
 * of trapping the user in a draft-conflict loop.
 */
export function prepareSendDraft(
  threadId: string,
  text: string,
  recipientAgentId?: string
): ThreadComposerDraftView {
  const stored = loadLocalThreadComposerDraft(threadId)
  if (stored && stored.body === text) return stored
  const base = stored ?? emptyLocalThreadComposerDraft(threadId)
  return { ...base, body: text, content: composerDocument(text, recipientAgentId) }
}

// File identity is retained by the composer across a failed send. Name/size alone
// never prove equal bytes and must not silently collapse different attachments.
const preparedFiles = new WeakMap<File, Map<string, LocalAttachmentSourceView>>()
export async function stageDraftAttachments(
  client: ThreadClient, draft: ThreadComposerDraftView, files: readonly File[]
): Promise<ThreadComposerDraftView> {
  if (!files.length) return draft
  const composer = client.composerAttachments
  if (!composer || typeof composer.prepare !== 'function') throw new Error('当前连接不支持添加附件，请只发送文字。')
  let next = draft
  for (const file of files) {
    const previous = preparedFiles.get(file)?.get(draft.threadId)
    if (previous && next.attachments.some(item => item.id === previous.id)) continue
    if (next.attachments.length >= MAX_LOCAL_COMPOSER_ATTACHMENTS) throw new Error(`一次最多添加 ${MAX_LOCAL_COMPOSER_ATTACHMENTS} 个附件。`)
    const attachment = previous ?? await composer.prepare(draft.threadId, next.revision, file)
    const entries = preparedFiles.get(file) ?? new Map<string, LocalAttachmentSourceView>()
    entries.set(draft.threadId, attachment); preparedFiles.set(file, entries)
    next = { ...next, attachments: [...next.attachments, attachment] }
    saveLocalThreadComposerDraft(next)
  }
  return next
}

const sendAttempts = new WeakMap<ThreadClient, Map<string, { fingerprint: string; commandId: string }>>()
function sendAttempt(client: ThreadClient, threadId: string, fingerprint: string): string {
  const entries = sendAttempts.get(client) ?? new Map<string, { fingerprint: string; commandId: string }>()
  const key = `loom-native-send:${threadId}`
  const recovered = client.editingRecovery?.get(key)
  const saved = recovered && typeof recovered === 'object' ? recovered as { fingerprint?: unknown; commandId?: unknown } : null
  const prior = entries.get(threadId) ?? (saved && typeof saved.fingerprint === 'string' && typeof saved.commandId === 'string' ? { fingerprint: saved.fingerprint, commandId: saved.commandId } : undefined)
  if (prior && prior.fingerprint !== fingerprint) throw new Error('上一条消息的提交结果还未确认。请先用原内容重试，避免重复发送。')
  const attempt = prior ?? { fingerprint, commandId: newCommandId() }
  entries.set(threadId, attempt); sendAttempts.set(client, entries)
  client.editingRecovery?.set(key, attempt)
  return attempt.commandId
}
function settleSendAttempt(client: ThreadClient, threadId: string): void {
  sendAttempts.get(client)?.delete(threadId)
  client.editingRecovery?.set(`loom-native-send:${threadId}`, null)
}

/** Exact production request body for `thread.messages.send`. */
export function threadMessageSendParams(commandId: string, draft: ThreadComposerDraftView) {
  const sourceAttachments = draft.attachments.map(attachment => {
    if (!attachment.sourcePath) {
      throw new Error(uiAttribute('本地附件来源已不可用，请移除后重新添加。'))
    }
    return {
      id: attachment.id,
      sourcePath: attachment.sourcePath,
      displayName: attachment.displayName,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      observedByteSize: attachment.byteSize,
      ...(attachment.pastedTextPreview !== undefined ? { pastedTextPreview: attachment.pastedTextPreview } : {})
    }
  })
  return {
    commandId,
    threadId: draft.threadId,
    content: draft.content,
    sourceAttachments,
    quotes: draft.quotes,
    replyToThreadMessageId: draft.replyIntent?.replyToThreadMessageId ?? null,
    execution: {
      taskId: null,
      purpose: draft.body.trim() || 'Thread attachment-only message',
      completionRole: 'required' as const
    }
  }
}

export type SendOutcome = { threadMessageId: string | null }

/**
 * Submits one message through the revisioned draft protocol. Nothing is cleared and
 * no state is committed unless Core accepted the command (`applied`/`accepted`).
 */
export async function sendThreadMessage(
  client: ThreadClient,
  input: { threadId: string; text: string; files: readonly File[]; recipientAgentId?: string },
  enqueue: (record: PendingRecord) => void = enqueueOutbox
): Promise<SendOutcome> {
  const prepared = prepareSendDraft(input.threadId, input.text, input.recipientAgentId)
  if (!Number.isInteger(prepared.revision) || prepared.revision < 1) {
    throw new Error(uiAttribute('草稿版本无效，请重新打开会话后再试。'))
  }
  const staged = await stageDraftAttachments(client, prepared, input.files)
  if (staged.body.trim() === '' && staged.attachments.length === 0) {
    throw new Error(uiAttribute('请输入内容或添加附件。'))
  }
  const unsigned = threadMessageSendParams('', staged)
  const params = { ...unsigned, commandId: sendAttempt(client, input.threadId, JSON.stringify(unsigned)) }
  // Persist first: if the command is rejected or the transport drops, the same
  // draft revision and attachment refs are reused by the retry.
  saveLocalThreadComposerDraft(staged)
  const request = { ...params, deliveryMode: 'start', steerTargets: [] }
  let queued = false
  const stopObserving = observeUnconfirmedThreadSend(params, () => {
    if (queued || staged.attachments.length) return
    enqueue({ id:params.commandId,threadId:input.threadId,text:input.text,fingerprint:JSON.stringify(unsigned),
      commandId:params.commandId,params:request,state:'unconfirmed',createdAt:new Date().toISOString() })
    queued = true
  })
  let result: SendThreadMessageResult | null
  try { result = await client.request<SendThreadMessageResult | null>('thread.messages.send', request) }
  catch (cause) {
    // Only transport failures are eligible; Core and validation failures never become queued work.
    const code = cause instanceof Error ? String((cause as Error & {code?:string}).code) : ''
    if (!(cause instanceof LoomCommandRejected) && (cause instanceof TypeError || /^(transport\.unavailable|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT)$/.test(code))) {
      if (staged.attachments.length) throw new Error('附件不能稍后自动重发，请重新选择文件。')
      if (!queued) enqueue({ id:params.commandId,threadId:input.threadId,text:input.text,fingerprint:JSON.stringify(unsigned),
        commandId:params.commandId,params:request,state:code==='transport.unavailable'?'pending':'unconfirmed',createdAt:new Date().toISOString() })
    }
    throw cause
  } finally {
    stopObserving()
  }
  const command = result?.commandResult ?? null
  if (!command) throw new Error(uiAttribute('消息提交结果暂时不可用，消息与附件已保留。'))
  if (command.status === 'rejected') { settleSendAttempt(client, input.threadId); throw new LoomCommandRejected(command) }
  if (command.status !== 'applied' && command.status !== 'accepted') throw new Error('消息提交状态未知，草稿已保留。')
  if (queued) updateOutbox({ id: params.commandId, threadId: input.threadId } as PendingRecord, 'accepted')
  settleSendAttempt(client, input.threadId)
  clearLocalThreadComposerDraft(input.threadId)
  return { threadMessageId: stringField(command.payload, 'threadMessageId') }
}

// -------------------------------------------------------------- new threads

/** Exact production dialog shape: quick-chat, one member, Lead = that member. */
export async function createThreadForAgent(client: Reader, agentId: string): Promise<string> {
  if (!agentId) throw new Error(uiAttribute('请选择一位助手。'))
  const result = await client.request<StoredCommandResult | null>('threads.create', {
    commandId: newCommandId(),
    name: null,
    workspace: null,
    memberAgentIds: [agentId],
    defaultLeadAgentId: agentId,
    collaborationMode: 'peer',
    activationState: 'pending'
  })
  if (!result || typeof result.status !== 'string') throw new Error(uiAttribute('会话创建结果暂时不可用，请重试。'))
  if (result.status === 'rejected') throw new LoomCommandRejected(result)
  const threadId = stringField(result.payload, 'threadId')
  if (!threadId) throw new Error(uiAttribute('会话已创建，但暂时无法打开。请刷新会话列表后重试。'))
  return threadId
}

export function settleOutboxAttempt(client: ThreadClient, threadId: string, commandId: string): void {
  const saved = client.editingRecovery?.get(`loom-native-send:${threadId}`) as {commandId?:string}|null
  if (sendAttempts.get(client)?.get(threadId)?.commandId === commandId || saved?.commandId === commandId)
    settleSendAttempt(client,threadId)
}
