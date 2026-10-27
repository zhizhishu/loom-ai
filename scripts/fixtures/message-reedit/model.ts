import { createReviewModel } from '../host-web-parity/model'
import { initial, initialDraft, agents as templates, installations } from '../host-web-parity/data'
import { composerDocumentFromText, composerDocumentToPlainText, composerDocumentToStructuredContent } from '../../../apps/desktop/src/renderer/src/composer-document'
import { MessageReeditStore, messageReeditDocument } from '../../../apps/desktop/src/renderer/src/message-reedit-store'
import { MessageWithdrawal } from '../../../apps/desktop/src/renderer/src/message-withdrawal'
import type { StoredCommandResult, ThreadMessageView } from '@contracts'
export { installations }

// Only the transport is simulated. Recovery storage, expiry, dialogs and composer are production code.
const backing = createReviewModel('desktop', 'camp')
const clone = <T,>(value: T): T => structuredClone(value)
export const currentId = 'rvcamp_01m5kph2p7e40bbftscc7jy7ap'
export const secondaryId = 'rvcamp_01m5kph2p7e40bbftscc7jy7aq'
const stateKey = 'rovai.withdraw-reedit-review.v4.state'
const draftPrefix = 'rovai.withdraw-reedit-review.v4.draft:'
const listeners = new Set<() => void>(), editingRecovery = new Map<string, unknown>()
const agents = ['爱丽丝', '奥黛丽', '雾切响子', '药师寺惠'].map((displayName, i) => ({
  ...clone(templates[i % templates.length]), agentId: `reedit-review-member-${i}`, displayName,
  teamRole: ['五号街卖花女', '正义小姐 · 观众途径', '超高校级的侦探', '机兵驾驶员 · 咲良高校学生'][i],
  avatarRef: null, memberOrder: i, version: 1, presence: 'present', removedAt: null
}))
export const originalText = '把重新编辑入口放在撤回提示旁。\n输入框已有内容时，先确认替换，取消保留草稿。'
export const existingDraft = '还有一点：历史撤回消息没有原文时，不显示重新编辑入口。'
const plain = (document: any) => composerDocumentToPlainText(document, agents)
function message(sequence: number, body: string, agent = false, content?: any[]) {
  const explicit = [...new Set((content ?? []).filter(s => s.kind === 'member_mention').map(s => s.agentId))]
  const broadcast = content?.some(s => s.kind === 'all_members_mention')
  return { id: `reedit-message-${sequence}`, sequence, timelineGlobalSequence: sequence,
    authorType: agent ? 'agent' : 'user', authorId: agent ? agents[0].agentId : 'local_user',
    sourceAgentRunId: null, body, content: content ?? [{ kind: 'text', text: body }], attachments: [], quotes: [],
    addressMode: broadcast ? 'broadcast' : explicit.length ? 'explicit' : 'default',
    addressedAgentIds: content ? broadcast ? agents.map(a => a.agentId) : explicit.length ? explicit : [agents[0].agentId] : [],
    replyToThreadMessageId: null, threadTurnId: null, presentation: null, withdrawn: false, canWithdraw: false,
    version: 1, runtimeModel: null, createdAt: `2026-10-23T06:${String(22 + sequence * 2).padStart(2, '0')}:00Z` }
}
function erased(m: any) { return { ...m, body: '', content: [], attachments: [], quotes: [], addressedAgentIds: [],
  replyToThreadMessageId: null, presentation: null, withdrawn: true, canWithdraw: false, version: m.version + 1 } }
const scenarios = [
  ['withdrawn', '默认接收 · 已有草稿'], ['pending', '从撤回开始'], ['empty', '默认接收 · 空输入框'],
  ['explicit', '显式 @ · 重新编辑'], ['expired', '两分钟已过期'], ['legacy', '历史撤回 · 无副本'],
  ['failure', '撤回明确失败'], ['unknown', '撤回回执丢失'], ['storage-failure', '副本保存失败'],
  ['ready-storage-failure', '成功后副本保存失败'], ['refresh-failure', '撤回成功 · 刷新失败']
]
function sourceMessage(explicit: boolean) {
  const content = explicit ? [{ kind: 'member_mention', agentId: agents[0].agentId }, { kind: 'text', text: ' ' + originalText }]
    : [{ kind: 'text', text: originalText }]
  return { ...message(4, (explicit ? '@爱丽丝 ' : '') + originalText, false, content), canWithdraw: true }
}
function seed(scenario = 'withdrawn') {
  const withdrawn = ['withdrawn', 'empty', 'explicit', 'expired', 'legacy'].includes(scenario)
  const source = sourceMessage(scenario === 'explicit')
  return { generation: 1, scenario, currentId, messages: [
    message(1, '撤回以后，我希望能接着修改消息，输入框里正在写的内容也要保留。'),
    message(2, '撤回成功后两分钟内可点击「重新编辑」。已有输入时先确认替换，取消会保留原草稿。', true),
    erased(message(3, '')), withdrawn ? erased(source) : source
  ], busy: false, note: '', latestSentId: null as string | null, timeOffset: 0,
  failure: ['failure', 'unknown', 'storage-failure', 'ready-storage-failure', 'refresh-failure'].includes(scenario) ? scenario : null as string | null }
}
let state = seed(), restored = false, failReadyWrite = false
try {
  const saved = JSON.parse(localStorage.getItem(stateKey) || 'null')
  if (saved?.schema === 4) { state = { ...state, ...saved, busy: false, note: '' }; restored = true }
} catch {}
function change(patch: any, persist = true) {
  state = { ...state, ...patch }
  if (persist) localStorage.setItem(stateKey, JSON.stringify({ ...state, schema: 4, busy: false, note: '' }))
  listeners.forEach(fn => fn())
}
const reeditStore = new MessageReeditStore('review-v4:local-user', {
  get length() { return localStorage.length }, key: i => localStorage.key(i), getItem: key => localStorage.getItem(key),
  removeItem: key => localStorage.removeItem(key), setItem(key, value) {
    if (state.failure === 'storage-failure' || failReadyWrite) throw new Error('模拟恢复副本写入失败')
    localStorage.setItem(key, value)
  }
}, () => Date.now() + state.timeOffset)
function seedRecovery() {
  reeditStore.deleteThread(currentId)
  if (['withdrawn', 'empty', 'explicit', 'expired'].includes(state.scenario)) {
    const source = sourceMessage(state.scenario === 'explicit')
    const request = { commandId: 'review-seed', command: { threadId: currentId, messageId: source.id, expectedVersion: 1 } }
    reeditStore.stage(request, messageReeditDocument(source as ThreadMessageView)!)
    reeditStore.confirm(request)
    if (state.scenario === 'expired') { state.timeOffset += 120_000; reeditStore.sweep() }
  }
}
if (!restored) { seedRecovery(); change({}) }
function snapshot() {
  return { ...clone(initial), thread: { ...clone(initial.thread), id: state.currentId,
    title: state.currentId === currentId ? '撤回消息重新编辑' : '输入框历史浏览', projectPath: '/review/rovai-ai',
    defaultLeadAgentId: agents[0].agentId, activationState: 'active', version: 1 },
    throughGlobalSequence: state.messages.length,
    members: agents.map((a, i) => ({ agentId: a.agentId, displayName: a.displayName, avatarRef: null, teamRole: a.teamRole,
      accent: a.accent ?? '', membershipStatus: 'active', profilePresence: 'present', leaveRequestedAt: null,
      memberOrder: i, isDefaultLead: i === 0, version: 1 })),
    messages: state.currentId === currentId ? state.messages : [message(1, '输入框支持上下键浏览历史，当前草稿需要保留。')],
    tasks: [], agentRuns: [], messageDeliveries: [], turns: [], approvals: [], executionEvidence: [],
    agentRunFileChanges: [], contextManifests: [], actions: [], timeline: [] }
}
const receipts = new Map<string, StoredCommandResult>()
const withdrawal = new MessageWithdrawal({
  store: reeditStore,
  async request(request) {
    if (receipts.has(request.commandId)) return { result: receipts.get(request.commandId)!, source: 'recovery' }
    await new Promise(resolve => setTimeout(resolve, 300))
    if (state.failure === 'failure') {
      change({ failure: null })
      const result = { status: 'rejected' } as StoredCommandResult
      receipts.set(request.commandId, result); return { result, source: 'direct' }
    }
    const failure = state.failure
    change({ messages: state.messages.map(m => m.id === request.command.messageId ? erased(m) : m), failure: null })
    const result = { status: 'applied' } as StoredCommandResult
    receipts.set(request.commandId, result)
    if (failure === 'ready-storage-failure') failReadyWrite = true
    if (failure === 'unknown') throw new Error('模拟回执丢失')
    return { result, source: 'direct' }
  },
  accepted() {},
  async refresh() { if (state.scenario === 'refresh-failure') throw new Error('模拟列表刷新失败') },
  notify: note => change({ note }, false), rejectionMessage: () => '撤回失败，消息和当前输入均已保留，请重试。'
})
const request = async (method: string, input: any = {}) => {
  const snap = snapshot()
  if (method === 'thread.messages.anchors') return { schemaVersion: 1, threadId: snap.thread.id, throughGlobalSequence: snap.throughGlobalSequence,
    totalCount: snap.messages.filter(m => m.authorType === 'user' && !m.withdrawn).length,
    items: snap.messages.filter(m => m.authorType === 'user' && !m.withdrawn).map(m => ({ messageId: m.id, sequence: m.sequence, title: m.body.slice(0, 80), messageVersion: m.version })) }
  if (method === 'thread.messages.anchorPreview') return { schemaVersion: 1, threadId: snap.thread.id, messageId: input.messageId, sourceAvailable: true, firstReply: null, throughGlobalSequence: snap.throughGlobalSequence }
  if (method === 'thread.messages.around' || method === 'threads.messages.around') return { schemaVersion: 1, threadId: snap.thread.id, anchorMessageId: input.messageId, sourceAvailable: true, messages: snap.messages, hasEarlier: false, hasLater: false }
  if (method === 'skills.candidates') return { skills: [], errors: [] }
  if (method === 'members.list') return clone(agents)
  if (method === 'tasks.list') return { tasks: [], nextCursor: null, truncated: false }
  if (method === 'monitoring.execution') return { schemaVersion: 1, runs: [], sessions: [] }
  if (method === 'references.availability') return { threads: [], missions: [] }
  return backing.client.request(method as any, input)
}
export const review = {
  editorRef: null as any, navigation: null as any, reeditStore, agents, scenarios, plain,
  get: () => state, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }, snapshot,
  client: { ...backing.client, request, editingRecovery: { get: (id: string) => editingRecovery.get(id), set: (id: string, value: unknown) => { editingRecovery.set(id, value) } },
    memberAvatars: { ...backing.client.memberAvatars, read: async () => null } }, fileApi: backing.fileApi,
  draft: () => ({ ...clone(initialDraft), threadId: state.currentId,
    body: state.scenario === 'empty' || state.currentId !== currentId ? '' : existingDraft,
    content: composerDocumentFromText(state.scenario === 'empty' || state.currentId !== currentId ? '' : existingDraft) }),
  note: (note: string) => change({ note }, false),
  advance(ms: number) { change({ timeOffset: state.timeOffset + ms }); reeditStore.sweep() },
  recover: withdrawal.recoverPending,
  withdraw: (message: any) => withdrawal.withdraw(state.currentId, message),
  async openThread(id: string, fromHistory = false) {
    if (![currentId, secondaryId].includes(id)) return
    if (review.navigation && !fromHistory) { await review.navigation.push({ kind: 'camp', threadId: id }); return }
    await review.editorRef?.current?.flush()
    change({ currentId: id, generation: state.generation + 1 })
  },
  async scenario(scenario: string) {
    await review.editorRef?.current?.flush()
    for (const id of [currentId, secondaryId]) localStorage.removeItem(draftPrefix + id)
    editingRecovery.clear(); receipts.clear(); failReadyWrite = false
    state = { ...seed(scenario), generation: state.generation + 1 }
    seedRecovery(); change({})
    review.navigation?.reset({ kind: 'camp', threadId: currentId })
  },
  async send(draft: any) {
    change({ busy: true }, false)
    await new Promise(resolve => setTimeout(resolve, 150))
    const content = composerDocumentToStructuredContent(draft.content)
    const item = { ...message(state.messages.length + 1, plain(draft.content), false, content), canWithdraw: true, createdAt: new Date().toISOString() }
    change({ busy: false, messages: [...state.messages, item], latestSentId: item.id })
    return { threadMessageId: item.id, threadTurnId: null, agentRunIds: [], deliveryIds: [], addressedAgentIds: item.addressedAgentIds }
  }
}
