import { createReviewModel } from '../host-web-parity/model'
import { initial, agents as templates, initialDraft, installations, message } from '../host-web-parity/data'
import { writeClipboardText } from '../../../apps/desktop/src/renderer/src/clipboard'
export { installations }

export const profiles = ['爱丽丝', '奥黛丽', '雾切响子', '药师寺惠'].map((name, i) => ({
  ...structuredClone(templates[i % 2]), agentId: `copy-member-${i}`, displayName: name, avatarRef: null,
  memberOrder: i, teamRole: ['五号街卖花女', '正义小姐 · 观众途径', '超高校级的侦探', '机兵驾驶员'][i],
  runtimeConfiguration: { ...structuredClone(templates[0].runtimeConfiguration), model: { mode: 'runtime_default' } }
}))
export const snippets = {
  short: 'pnpm install\npnpm dev\n',
  ts: 'async function copyCode(code: string) {\n  const copied = await writeClipboardText(code)\n  return copied\n}\n',
  long: 'const result = await workspace.openFile({ path: "apps/desktop/src/renderer/src/MarkdownCodeBlock.tsx", mode: "preview", preserveScrollPosition: true })\n',
  plain: '启动完成\n  工作区：rovai-ai\n  状态：ready\n',
  tall: Array.from({ length: 38 }, (_, i) => `  { id: ${String(i + 1).padStart(2, '0')}, title: "示例 ${i + 1}", enabled: true },`).join('\n') + '\n',
  unknown: 'section preview {\n\ttitle = "中文与缩进"\n\tvalue = "<script> & \\\"引号\\\""\n}\n',
}
const fenced = (code: string, language = '') => '```' + language + '\n' + code + '```'
export const documents: Record<string, string> = {
  'docs/quick-start.md': '# 本地开发\n\n启动前安装依赖，然后打开开发工作区。\n\n## 启动项目\n\n' + fenced(snippets.short, 'bash') + '\n\n## 复制一段代码\n\n代码保留原有缩进和换行。\n\n' + fenced(snippets.ts, 'typescript') + '\n\n更多示例见 [长代码与边界](code-examples.md)。\n\n## 终端输出\n\n' + fenced(snippets.plain),
  'docs/code-examples.md': '# 长代码与边界\n\n## 单行命令\n\n' + fenced(snippets.long, 'typescript') + '\n\n## 长代码\n\n' + fenced('const items = [\n' + snippets.tall + ']\n', 'typescript') + '\n\n## 未知语言\n\n' + fenced(snippets.unknown, 'rovai-demo') + '\n\n## 无语言标记\n\n' + fenced(snippets.plain) + '\n\n返回 [本地开发](quick-start.md)。',
}
const backing = createReviewModel('desktop', 'camp')
const listeners = new Set<() => void>()
const at = (seq: number) => new Date(Date.UTC(2026, 9, 13, 6, 26, seq * 25)).toISOString()
const make = (seq: number, body: string, agent = false): any => ({ ...message(seq, body, agent ? 'agent' : 'user'),
  id: `copy-message-${seq}`, authorId: agent ? profiles[0].agentId : 'local_user', addressedAgentIds: [],
  runtimeModel: agent ? { adapterKind: 'codex-cli', modelId: null, reasoningEffort: null } : null, createdAt: at(seq),
})
const complete = { loadedCount: 0, totalCount: 0, omittedCount: 0, complete: true }
const sampleMessages = [make(1, '把启动命令和复制方法放在消息里，也给我一份 Markdown 文件。'),
  make(2, '先安装依赖，再启动开发版：\n\n' + fenced(snippets.short, 'bash') + '\n\n复制逻辑使用现有的剪贴板方法：\n\n' + fenced(snippets.ts, 'typescript') + '\n\n完整说明见 [本地开发.md](docs/quick-start.md)，更多示例见 [长代码与边界.md](docs/code-examples.md)。', true)]
let state: any = { snapshot: { ...structuredClone(initial),
  thread: { ...initial.thread, title: 'Markdown 代码块复制', projectPath: '/prototype/rovai-ai', defaultLeadAgentId: profiles[0].agentId },
  members: profiles.map((p, i) => ({ agentId: p.agentId, displayName: p.displayName, avatarRef: null,
    teamRole: p.teamRole, accent: p.accent, membershipStatus: 'active', profilePresence: 'present', memberOrder: i,
    isDefaultLead: i === 0, version: 1, leaveRequestedAt: null })),
  messages: sampleMessages, agentRuns: [], agentRunImages: [], memberCreations: [], approvals: [],
  coverage: { tasks: complete, messageDeliveries: complete, turns: complete, agentRuns: complete,
    executionEvidence: complete, approvals: complete,
    messages: { loadedCount: 2, totalCount: 2, omittedCount: 0, complete: true, hasEarlier: false, oldestLoadedSequence: 1, newestLoadedSequence: 2 } },
}, draft: { ...structuredClone(initialDraft), body: '', content: { version: 2, segments: [] } }, note: '', busy: false }
const update = (patch: any) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
const sourceFile = (path: string): any => ({ previewKey: 'copy-' + path, handleId: 'copy-' + path, reopenToken: path,
  displayPath: path, fileName: path.split('/').at(-1), pathPresentation: 'project_relative', size: documents[path].length,
  mime: 'text/markdown', extension: '.md', kind: 'markdown', hasExternalUpdate: false,
  contentVersion: { size: documents[path].length, mtimeMs: 1 }, contentGeneration: 'copy-generation', capabilities: ['read', 'copy_path'], target: {} })
const forbidden = async () => ({ ok: false as const, error: { code: 'source_not_authorized' as const, message: '交互稿只提供两份示例文件。', retryable: false } })
const locate = (request: any) => {
  const key = request.rawReference ?? request.reopenToken ?? request.handleId?.replace(/^copy-/, '')
  if (!key) return null
  return documents[key] ? key : documents['docs/' + key] ? 'docs/' + key : null
}
const open = async (request: any): Promise<any> => {
  const path = locate(request)
  return path ? { ok: true, value: { kind: 'file_preview', file: sourceFile(path) } } : forbidden()
}
export const model = {
  get: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
  note: (note: string) => update({ note }),
  rename: (title: string) => update({ snapshot: { ...state.snapshot, thread: { ...state.snapshot.thread, title } } }),
  async changeLead(agentId: string) { update({ snapshot: { ...state.snapshot, thread: { ...state.snapshot.thread, defaultLeadAgentId: agentId }, members: state.snapshot.members.map((m: any) => ({ ...m, isDefaultLead: m.agentId === agentId })) } }) },
  async send(draft: any) {
    const next = { ...make(state.snapshot.messages.length + 1, draft.body), content: draft.content.segments, quotes: draft.quotes, attachments: draft.attachments }
    update({ snapshot: { ...state.snapshot, messages: [...state.snapshot.messages, next] } })
    return { threadTurnId: null, agentRunIds: [], deliveryIds: [], addressedAgentIds: [profiles[0].agentId] }
  },
  client: { ...backing.client,
    request: async (method: string, input: any = {}): Promise<any> => {
      if (method === 'members.list') return profiles
      if (method === 'skills.candidates') return { schemaVersion: 1, threadId: state.snapshot.thread.id, items: [], candidates: [] }
      if (method === 'thread.messages.anchors') return { schemaVersion: 1, throughGlobalSequence: 2, threadId: state.snapshot.thread.id,
        totalCount: 1, items: state.snapshot.messages.filter((m: any) => m.authorType === 'user').map((m: any) => ({ messageId: m.id, sequence: m.sequence, title: m.body, messageVersion: 1 })) }
      if (method === 'thread.messages.anchorPreview') return { schemaVersion: 1, threadId: state.snapshot.thread.id, messageId: input.messageId, throughGlobalSequence: 2, sourceAvailable: true, firstReply: null }
      if (method === 'thread.messages.around') return { schemaVersion: 1, threadId: state.snapshot.thread.id, anchorMessageId: input.messageId, messages: state.snapshot.messages, hasEarlier: false, hasLater: false }
      return backing.client.request(method as never, input)
    }
  },
  fileApi: { ...backing.fileApi, open, restore: open, reopen: open,
    readText: async (request: any) => {
      const path = locate(request)
      return path ? { ok: true as const, value: { text: documents[path], contentGeneration: 'copy-generation', contentVersion: sourceFile(path).contentVersion } } : forbidden()
    },
    prepareHtml: async (request: any) => {
      const path = locate(request)
      return path ? { ok: true as const, value: { html: documents[path], tabToken: 'copy-markdown', bridgeToken: 'copy-offline', assetBasePath: '', contentGeneration: 'copy-generation', contentVersion: sourceFile(path).contentVersion } } : forbidden()
    },
    copyPath: async (request: any) => {
      const path = locate(request)
      return path && await writeClipboardText('/prototype/rovai-ai/' + path) ? { ok: true as const, value: { copied: true as const } } : forbidden()
    },
  }
}
