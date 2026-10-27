import { isThreadId, type CoreEvent, type ThreadReadInvalidation } from '@contracts'
import { model as base, profiles, installations } from '../markdown-code-copy/model'
import { fuzzyContains } from '../../../apps/desktop/src/renderer/src/thread-reference'
import { composerDocumentToStructuredContent } from '../../../apps/desktop/src/renderer/src/composer-document'
import { message } from '../host-web-parity/data'
export { profiles, installations }
const snapshot = base.get().snapshot
snapshot.thread.title = '登录改造 · 引用验收'
snapshot.members = snapshot.members.slice(0, 3)
snapshot.messages = [{ ...message(1, '参考已有对话和使命，检查登录流程。', 'user'), addressedAgentIds: [profiles[0].agentId] }]
const id = (i: number) => { let suffix = ''; for (let n = 0; n < 4; n++) { suffix = '0123456789abcdefghjkmnpqrstvwxyz'[i & 31] + suffix; i >>>= 5 } return 'rvcamp_01k87hrb9yfay8vvr14d2p' + suffix }
// Canonical UUIDv7 bits stay in the prefix; only the final random bits vary.
const catalog = [
  ...Array.from({ length: 104 }, (_, i) => ({ kind: 'thread', id: id(i), title: i < 3 ? '登录改造' : `登录重试检查 ${i + 1}`, projectBindingKind: 'directory', projectPath: i % 2 ? '/projects/rovai-ai' : '/projects/console-web' })),
  ...Array.from({ length: 98 }, (_, i) => ({ kind: 'mission', id: 'rvm_019abcde123470008000000000' + i.toString(16).padStart(6, '0'), title: `发布验收 ${i + 1}`, projectBindingKind: 'directory', projectPath: '/projects/rovai-ai' }))
]
if (!catalog.every(item => item.kind === 'thread' ? isThreadId(item.id) : /^rvm_[a-f0-9]{32}$/.test(item.id))) throw new Error('Fixture IDs must be canonical')
const skills = ['ui-ux-pro-max', 'code-review', 'worktree', 'analyze-agent-codebase'].map((name, i) => ({
  id: `native:${i}`, name, description: ['还原界面并完善交互', '审查实现与合同', '隔离开发环境', '分析模块边界'][i],
  source: i < 2 ? 'toolbox' : 'native', sourceScope: i % 2 ? 'project' : 'user', entryPath: `/fixture/${name}/SKILL.md`, memberIds: profiles.slice(0, 2).map(p => p.agentId)
}))
const referenceEvents = new Set<(event: CoreEvent) => void>()
const referenceInvalidations = new Set<(change: ThreadReadInvalidation) => void>()
export const model = {
  ...base, opened: [] as unknown[], requests: [] as unknown[], sent: [] as unknown[], delay: 250,
  resolveDelay: 0, failResolve: false, activeResolves: 0, maxActiveResolves: 0,
  emitReferenceEvent(event: CoreEvent) { referenceEvents.forEach(listener => listener(event)) },
  invalidateReferences(change: ThreadReadInvalidation) { referenceInvalidations.forEach(listener => listener(change)) },
  client: { ...base.client,
    onEvent(listener: (event: CoreEvent) => void) {
      referenceEvents.add(listener)
      const stop = base.client.onEvent?.(listener)
      return () => { referenceEvents.delete(listener); stop?.() }
    },
    onInvalidated(listener: (change: ThreadReadInvalidation) => void) {
      referenceInvalidations.add(listener)
      return () => { referenceInvalidations.delete(listener) }
    },
    request: async (method: string, input: any = {}): Promise<any> => {
    model.requests.push({ method, input: structuredClone(input) })
    if (method === 'threadReferences.list') {
      await new Promise(resolve => setTimeout(resolve, model.delay))
      const items = catalog.filter(item => item.kind === input.kind && fuzzyContains(item.title, input.query ?? ''))
      const offset = Number(input.cursor ?? 0)
      return { items: items.slice(offset, offset + 8), nextCursor: items.length > offset + 8 ? String(offset + 8) : null }
    }
    if (method === 'threadReferences.resolve') {
      model.activeResolves++
      model.maxActiveResolves = Math.max(model.maxActiveResolves, model.activeResolves)
      try {
        const result = structuredClone(input.references.map((ref: any) => catalog.find(item => item.id === ref.id) ?? null))
        await new Promise(resolve => setTimeout(resolve, model.resolveDelay))
        if (model.failResolve) throw new Error('fixture transport unavailable')
        return result
      } finally { model.activeResolves-- }
    }
    if (method === 'skills.candidates') return { skills, errors: [] }
    return base.client.request(method, input)
  } },
  async send(draft: any) {
    model.sent.push(structuredClone(draft))
    const result = await base.send(draft)
    base.get().snapshot.messages.at(-1).content = composerDocumentToStructuredContent(draft.content)
    return result
  }
}
if (new URLSearchParams(location.search).get('recover') === 'mission') {
  const item = catalog.find(item => item.kind === 'mission')!
  model.client.editingRecovery?.set(`${snapshot.thread.id}:composer`, {
    base: { version: 2, segments: [] },
    document: { version: 2, segments: [{ kind: 'atom', atom: { type: 'mission_reference', missionId: item.id, labelFallback: '旧恢复标题' } }] }
  })
}
Object.assign(window, { __references: { model, catalog, snapshot, profiles, skills } })
