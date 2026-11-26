import { useEffect, useMemo, useState, type JSX } from 'react'
import type { AgentRunFileChangesView, AgentRunView, LoomArtifact, LoomCandidate } from '@contracts'
import { useThreadClient } from './camp-client'
import { uiAttribute } from './interface-language'
import { runAcceptanceBadge, runCompletionFacts, runRegisteredArtifacts } from './run-completion-summary'

/**
 * 完工总结卡：挂在 run_artifacts 时间线卡（以及完工 Run 的最后一条公开回复）下。
 * 只说已有事实——终态摘要（「工作了 X」）、改动数、已登记成果、验收徽标；
 * 成果与验收来自 Mission 投影（loom.artifacts.list / loom.candidates.list），
 * 非使命会话（quick_chat）没有这两份投影，卡就只显示摘要与改动数。
 */

export type RunCompletionLedger = {
  artifactsByRunId: ReadonlyMap<string, LoomArtifact[]>
  candidatesByRunId: ReadonlyMap<string, LoomCandidate[]>
}

const EMPTY_LEDGER: RunCompletionLedger = { artifactsByRunId: new Map(), candidatesByRunId: new Map() }

/**
 * 一次 Mission 范围的只读读取：成果投影与候选投影按 agentRunId 分桶。
 * 读失败降级为空（卡上不显示成果与徽标），不阻塞会话时间线。
 */
export function useRunCompletionLedger(missionId: string | null, runIds: readonly string[]): RunCompletionLedger {
  const client = useThreadClient()
  const [ledger, setLedger] = useState(EMPTY_LEDGER)
  const scope = missionId === null || runIds.length === 0
    ? null
    : `${missionId}|${[...runIds].sort().join(',')}`
  useEffect(() => {
    if (scope === null) {
      setLedger(EMPTY_LEDGER)
      return
    }
    let current = true
    const scopedMissionId = scope.slice(0, scope.indexOf('|'))
    void Promise.all([
      client.request<{ artifacts: LoomArtifact[] | null }>('loom.artifacts.list', { missionId: scopedMissionId }),
      client.request<LoomCandidate[]>('loom.candidates.list', { missionId: scopedMissionId })
    ]).then(([artifacts, candidates]) => {
      if (!current) return
      const artifactsByRunId = new Map<string, LoomArtifact[]>()
      for (const artifact of artifacts.artifacts ?? []) {
        if (!artifact.agentRunId) continue
        const owned = artifactsByRunId.get(artifact.agentRunId)
        if (owned) owned.push(artifact)
        else artifactsByRunId.set(artifact.agentRunId, [artifact])
      }
      const candidatesByRunId = new Map<string, LoomCandidate[]>()
      for (const candidate of candidates) {
        if (!candidate.agentRunId) continue
        const owned = candidatesByRunId.get(candidate.agentRunId)
        if (owned) owned.push(candidate)
        else candidatesByRunId.set(candidate.agentRunId, [candidate])
      }
      setLedger({ artifactsByRunId, candidatesByRunId })
    }).catch(() => {
      if (current) setLedger(EMPTY_LEDGER)
    })
    return () => { current = false }
  }, [client, scope])
  return ledger
}

/** 完工总结卡；终端 Run 才有意义，由调用方决定何时挂载。 */
export function RunCompletionCard({
  run,
  fileChanges,
  artifacts,
  candidates,
  onOpenArtifacts
}: {
  run: Pick<AgentRunView, 'id' | 'status' | 'startedAt' | 'createdAt' | 'endedAt'>
  fileChanges: readonly AgentRunFileChangesView[]
  /** 该 Run 已登记的成果；缺省（非使命会话/未读到）就不显示成果区。 */
  artifacts?: readonly LoomArtifact[]
  /** 该 Run 名下的候选投影；缺省就没有验收徽标。 */
  candidates?: readonly LoomCandidate[]
  /** 打开成果列表的入口（使命活动页）；缺省时成果只显示计数。 */
  onOpenArtifacts?(): void
}): JSX.Element {
  const facts = useMemo(() => runCompletionFacts(run, fileChanges), [run, fileChanges])
  const badge = useMemo(() => runAcceptanceBadge(candidates, run.id), [candidates, run.id])
  const registered = useMemo(() => runRegisteredArtifacts(artifacts, run.id), [artifacts, run.id])
  return (
    <article className="timeline-node run-completion-card" data-run-completion-card-id={run.id}
      aria-label={uiAttribute('完工总结')}>
      <div className="run-completion-headline">
        <span className="run-completion-title">{facts.headline}</span>
        {badge && <span className="run-completion-acceptance" data-acceptance={badge.status}>{badge.label}</span>}
      </div>
      {facts.changes && <p className="run-completion-changes">
        <span>{facts.changes.files === 1 ? uiAttribute('1 个文件') : uiAttribute('{0} 个文件', facts.changes.files)}</span>
        {facts.changes.additions !== null && facts.changes.deletions !== null
          ? <>
              {facts.changes.additions > 0 && <i className="run-file-change-stat addition">+{facts.changes.additions}</i>}
              {facts.changes.deletions > 0 && <i className="run-file-change-stat deletion">−{facts.changes.deletions}</i>}
            </>
          : <span>{facts.changes.operations === 1 ? uiAttribute('1 次修改') : uiAttribute('{0} 次修改', facts.changes.operations)}</span>}
      </p>}
      {registered.length > 0 && (onOpenArtifacts
        ? <button type="button" className="run-completion-artifacts-link" onClick={onOpenArtifacts}
            aria-label={uiAttribute('查看{0}份已登记成果', registered.length)}>
            {uiAttribute('查看成果（{0} 份）', registered.length)}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.25 3.75 4 4.25-4 4.25" /></svg>
          </button>
        : <p className="run-completion-artifacts-count">
            {uiAttribute('已登记成果 {0} 份', registered.length)}
          </p>)}
    </article>
  )
}
