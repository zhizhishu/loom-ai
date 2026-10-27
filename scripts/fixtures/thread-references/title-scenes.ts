import type { ComposerDocument, ReferenceCandidate } from '@contracts'
import { model, profiles } from './model'
import { message } from '../host-web-parity/data'
import { composerDocumentToPlainText, composerDocumentToStructuredContent } from '../../../apps/desktop/src/renderer/src/composer-document'
import { referenceAtom, projectReference } from '../../../apps/desktop/src/renderer/src/thread-reference'

// Renderer-only scenes. The default directory/availability acceptance stays unchanged.
const scene = new URLSearchParams(location.search).get('scene')
if (scene) {
  const catalog = (window as any).__references.catalog as ReferenceCandidate[]
  const thread = catalog[0]
  const mission = catalog.find(item => item.kind === 'mission')!
  const titles = {
    thread: '关于整个项目运行恢复、任务调度、文件权限与跨平台兼容问题的长期讨论',
    mission: '登录流程与会话恢复的联合验收：覆盖超时重试、权限变化、多端草稿以及长标题引用的完整交互',
    renamed: '登录与会话恢复｜更新后的设计讨论与验收记录'
  }
  thread.title = titles.thread
  mission.title = titles.mission
  const text = (text: string) => ({ kind: 'text' as const, text })
  const atom = (item: ReferenceCandidate) => ({ kind: 'atom' as const, atom: referenceAtom(item) })
  const document: ComposerDocument = { version: 2, segments: [
    text('参考 '), atom(thread), text('，结合 '), atom(mission), text(' 检查重试逻辑。')
  ] }
  const content = composerDocumentToStructuredContent(document)
  const body = content.map(segment => segment.kind === 'text' ? segment.text
    : segment.kind === 'thread_reference' || segment.kind === 'mission_reference' ? projectReference(segment) : '').join('')
  const state = model.get()
  state.snapshot.messages = [{ ...message(1, body, 'user'), content, addressedAgentIds: [profiles[0].agentId] }]
  const draft: ComposerDocument = scene === 'tabs' ? { version: 2, segments: [text('@')] }
    : scene === 'skills' ? { version: 2, segments: [text('/')] }
    : scene === 'short' ? { version: 2, segments: [text('参考 '), atom(catalog[1]), text('，继续检查。')] }
    : document
  state.draft = { ...state.draft, body: composerDocumentToPlainText(draft), content: draft }
  model.client.editingRecovery?.set(`${state.snapshot.thread.id}:composer`, {
    base: { version: 2, segments: [] }, document: draft
  })
  if (scene === 'renamed') thread.title = titles.renamed
  if (scene === 'unavailable') catalog.splice(catalog.indexOf(thread), 1)
  Object.assign(window, { __referenceLayout: { titles, document, scene } })
}
