import type { AgentRunFileChangesView, AgentRunView, LoomArtifact, LoomCandidate } from '@contracts'
import { uiAttribute } from './interface-language'
import { executionRunSummary } from './execution-run-summary'
import { acceptanceLabel } from './loom-native/artifact-service'

/**
 * 完工总结卡（run_artifacts 卡）的数据层：把 Run 终态、文件改动汇总、
 * 已登记成果与验收结论拼成一张卡的事实，全部来自已有投影，不发明数据。
 *
 * - 摘要与时长：复用 execution-run-summary 的「工作了 X」一行口径。
 * - 改动数：跨执行轮次（executionEpoch）聚合 run 的 Files Changed 卡，文案与
 *   file-changes-presentation 的 `agentRunFileChangesSummaryLabel` 保持一致。
 * - 验收徽标：候选（LoomCandidate）直接登记了产出它的 agentRunId，取该 Run
 *   最新一条候选的 acceptanceStatus；没有候选就没有徽标，不猜测「待验收」。
 */

/** 跨轮次聚合后的改动汇总；与单张 Files Changed 卡的字段口径一致。 */
export type RunCompletionChangeTotals = {
  files: number
  /** 任一轮次缺 ± 统计时为 null，此时改用 operations 计数 */
  additions: number | null
  deletions: number | null
  operations: number
}

type FileChangesSummary = Pick<
  AgentRunFileChangesView,
  'fileCount' | 'operationCount' | 'additions' | 'deletions'
>

/** 聚合一个 Run 的全部 Files Changed 卡；没有文件改动时为 null。 */
export function runCompletionChangeTotals(fileChanges: readonly FileChangesSummary[]): RunCompletionChangeTotals | null {
  if (fileChanges.length === 0) return null
  const files = fileChanges.reduce((sum, changes) => sum + changes.fileCount, 0)
  if (files <= 0) return null
  const additions = fileChanges.every((changes) => typeof changes.additions === 'number')
    ? fileChanges.reduce((sum, changes) => sum + (changes.additions ?? 0), 0)
    : null
  const deletions = fileChanges.every((changes) => typeof changes.deletions === 'number')
    ? fileChanges.reduce((sum, changes) => sum + (changes.deletions ?? 0), 0)
    : null
  const operations = fileChanges.reduce((sum, changes) => sum + changes.operationCount, 0)
  return { files, additions, deletions, operations }
}

/** 纯文本版改动汇总（组件里用结构化版本给 ± 上色）；文案对齐 Files Changed 卡。 */
export function runCompletionChangeText(totals: RunCompletionChangeTotals): string {
  const files = totals.files === 1 ? uiAttribute('1 个文件') : uiAttribute('{0} 个文件', totals.files)
  if (totals.additions !== null && totals.deletions !== null) {
    return `${files} · +${totals.additions} −${totals.deletions}`
  }
  const operations = totals.operations === 1 ? uiAttribute('1 次修改') : uiAttribute('{0} 次修改', totals.operations)
  return `${files} · ${operations}`
}

/** 完工总结卡的一行摘要：终态口径复用 executionRunSummary。 */
export type RunCompletionFacts = {
  headline: string
  changes: RunCompletionChangeTotals | null
}

export function runCompletionFacts(
  run: Pick<AgentRunView, 'status' | 'startedAt' | 'createdAt' | 'endedAt'>,
  fileChanges: readonly FileChangesSummary[]
): RunCompletionFacts {
  return {
    headline: executionRunSummary(run, run.endedAt ?? run.createdAt),
    changes: runCompletionChangeTotals(fileChanges)
  }
}

/** 验收徽标：Run 最新候选的验收结论；没有候选就没有徽标。 */
export type RunAcceptanceBadge = {
  status: LoomCandidate['acceptanceStatus']
  label: string
}

export function runAcceptanceBadge(
  candidates: readonly Pick<LoomCandidate, 'candidateId' | 'agentRunId' | 'acceptanceStatus' | 'createdAt'>[] | undefined,
  runId: string
): RunAcceptanceBadge | null {
  const owned = (candidates ?? []).filter((candidate) => candidate.agentRunId === runId)
  // 返工链上同 Run 可能有多条候选：后登记的候选代表当下结论。
  const latest = owned.reduce<LoomCandidate | null>((newest, candidate) =>
    newest === null || candidate.createdAt >= newest.createdAt ? candidate as LoomCandidate : newest, null)
  return latest === null ? null : { status: latest.acceptanceStatus, label: acceptanceLabel(latest.acceptanceStatus) }
}

/** 该 Run 已登记的成果（loom.artifacts.list 按 agentRunId 过滤）。 */
export function runRegisteredArtifacts(
  artifacts: readonly LoomArtifact[] | null | undefined,
  runId: string
): LoomArtifact[] {
  return (artifacts ?? []).filter((artifact) => artifact.agentRunId === runId)
}
