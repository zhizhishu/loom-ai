import type { LoomArtifact, LoomCandidate } from '@contracts'
import type { ArtifactSelection, WorkBundle } from './types'

/**
 * 一条线程的「成果」段（参照 Mikka `apps/mobile/features/tasks/model/thread-artifacts.ts:4-30`
 * 的四组模型与 `lib/thread-artifacts.ts` 的纯函数分组，上游对照见交付报告）：这条线程的工作
 * 实际产出的一切，分四组、固定顺序——计划 / 改动 / 报告 / 截图。纯函数，组里放什么不依赖
 * React；数据只读既有授权投影（WorkBundle 的 artifacts/candidates），这里只整理、不新读、
 * 不编任何产出。Mikka 的 pullRequests 组在 LOOM 没有对应实体（LOOM 不照搬 accept 合并 PR），
 * 换成「改动」：线程里登记过的代码与补丁类产物。
 */
export const THREAD_RESULT_GROUPS = ['plans', 'changes', 'reports', 'captures'] as const
export type ThreadResultGroup = (typeof THREAD_RESULT_GROUPS)[number]

/** 线程 | 成果（Mikka ThreadSegment）：对话本身，或这段对话产出的一切。 */
export type ThreadSegment = 'chat' | 'results'

/** 组在界面上显示的名字；组键保留英文标识，测试与 data-group 也用它。 */
export const RESULT_GROUP_LABELS: Record<ThreadResultGroup, string> = {
  plans: '计划',
  changes: '改动',
  reports: '报告',
  captures: '截图/录屏'
}

/** 一条成果：既有投影里的已登记产物，selection 原样携带打开既有预览（成果浮层）所需的一切。 */
export type ThreadResultEntry = { group: ThreadResultGroup; selection: ArtifactSelection }

/** 截图/录屏组认这些媒体扩展名；与 artifact-service/Core 的媒体白名单同源。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv'])

/** 报告组认这些文档扩展名；markdown 判定与 artifactPreviewKind 一致，另收网页、纯文本与 PDF。 */
const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt', 'html', 'htm', 'pdf'])

const DOCUMENT_CONTENT_TYPES = ['text/markdown', 'text/html', 'text/plain', 'application/pdf']

/**
 * 一份产物归哪一组，只看登记行自己的事实（relativePath + contentType）：
 * 图片先判（截图可能恰好叫 plan-01.png）；路径里带 plan（目录或文件名，如 plan.md、
 * plans/auth.md）或中文「方案」的算计划；文档算报告；其余（代码、补丁、数据……）都算改动。
 */
export function artifactResultGroup(artifact: Pick<LoomArtifact, 'relativePath' | 'contentType'>): ThreadResultGroup {
  const segments = artifact.relativePath.split(/[\\/]/u).filter(part => part !== '')
  const name = segments.at(-1) ?? artifact.relativePath
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const contentType = (artifact.contentType ?? '').toLowerCase()
  if (contentType.startsWith('image/') || contentType.startsWith('video/') || IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)) return 'captures'
  if (segments.some(segment => segment.toLowerCase().includes('plan')) || name.includes('方案')) return 'plans'
  if (DOCUMENT_EXTENSIONS.has(extension) || DOCUMENT_CONTENT_TYPES.some(type => contentType.startsWith(type))) return 'reports'
  return 'changes'
}

/** captures 里的媒体种类；只按登记路径/内容类型判断，界面不猜测其他文件。 */
export function artifactCaptureKind(artifact: Pick<LoomArtifact, 'relativePath' | 'contentType'>): 'image' | 'video' | null {
  if (artifactResultGroup(artifact) !== 'captures') return null
  const name = artifact.relativePath.split(/[\\/]/u).filter(part => part !== '').pop() ?? artifact.relativePath
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const contentType = (artifact.contentType ?? '').toLowerCase()
  if (contentType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'image'
}

/**
 * 收集这条线程的成果：该线程每个 Mission 已登记的产物，逐份归组。候选归属与现有会话流
 * 产物卡同一套解析（拥有这份证据的候选），selection 形状不变，因此打开路径也是既有那条。
 */
export function threadResultEntries(bundles: readonly WorkBundle[], threadId: string | null | undefined): ThreadResultEntry[] {
  if (!threadId) return []
  const entries: ThreadResultEntry[] = []
  for (const bundle of bundles) {
    if (bundle.mission.threadId !== threadId) continue
    for (const artifact of bundle.artifacts) {
      const candidate = bundle.candidates.find(entry => entry.evidenceIds.includes(artifact.artifactId)) ?? null
      entries.push({ group: artifactResultGroup(artifact), selection: { artifact, candidate, bundle } })
    }
  }
  return entries
}

/** 各组按固定顺序展开、各带数量；空组不出现（Mikka shownGroups 的规矩）。 */
export type ThreadResultGroupView = {
  group: ThreadResultGroup
  label: string
  count: number
  entries: ThreadResultEntry[]
}

export function resultGroupViews(entries: readonly ThreadResultEntry[]): ThreadResultGroupView[] {
  return THREAD_RESULT_GROUPS.flatMap(group => {
    const groupEntries = entries.filter(entry => entry.group === group)
    return groupEntries.length > 0
      ? [{ group, label: RESULT_GROUP_LABELS[group], count: groupEntries.length, entries: groupEntries }]
      : []
  })
}

/** 切换按钮只在线程真的产出过什么时出现（Mikka hasThreadArtifacts）；否则顶栏保持原样。 */
export const hasThreadResults = (entries: readonly ThreadResultEntry[]): boolean => entries.length > 0

/** 成果行主标题：只取路径最后一段，与 Inspector 的成果行同一规矩，不显示整条相对路径。 */
export function resultEntryTitle(relativePath: string): string {
  const name = relativePath.split(/[\\/]/u).filter(part => part !== '').pop() ?? relativePath
  return name === '' ? relativePath : name
}

/** 成果行状态词，与会话流里现有产物卡同一套：候选被接受/退回，其余（含未归属候选）都在等审阅。 */
export function resultStatusLabel(candidate: Pick<LoomCandidate, 'acceptanceStatus'> | null): string {
  return candidate?.acceptanceStatus === 'accepted'
    ? '已接受'
    : candidate?.acceptanceStatus === 'rejected' ? '已退回' : '等待审阅'
}
