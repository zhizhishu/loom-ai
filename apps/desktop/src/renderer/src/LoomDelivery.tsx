import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentProfile, LoomArtifact, LoomArtifactPreviewResult, LoomCandidate, LoomDependency, LoomPlan, LoomReview, LoomTask, LoomVerification
} from '@contracts'
import { LoomAssetGraph, LoomStageReviewFact } from './LoomControl'
import { LoomArtifactDialog } from './LoomArtifactDialog'
import {
  loomAssetRelations,
  loomCandidateAcceptable,
  loomCandidateVersions,
  loomStageReviewLatest,
  loomVersionLabel,
  type LoomControlPolicy,
  type LoomStageReview
} from './loom-control-model'
import { SafeMarkdown } from './SafeMarkdown'
import { uiAttribute, useUiText } from './interface-language'
import { useThreadClient } from './camp-client'

/**
 * 只读预览（契约 loom.ts 的 LoomArtifactPreviewResult）：不可预览时 Core 给原因，
 * 界面不自己猜原因，也不把「读失败」伪装成 not_archived。
 */

type LoomPreviewUnavailable = 'too_large' | 'binary' | 'not_archived'

/** 一次预览的在途/结果状态：错误独立保留，可单条重试，不污染其他文件。 */
type LoomPreviewState =
  | { status: 'reading' }
  | { status: 'ready'; text: string }
  | { status: 'unavailable'; reason: LoomPreviewUnavailable }
  | { status: 'error'; message: string }

/** 文件名主标题：只取路径最后一段，不显示整条相对路径。 */
export function loomArtifactLabel(relativePath: string): string {
  const name = relativePath.split(/[\\/]/u).filter(part => part !== '').pop() ?? relativePath
  return name === '' ? relativePath : name
}

/** 卡片主标题：任务名优先，其次第一份证据的文件名；都没有返回 null 由界面给中性占位。 */
export function loomDeliveryTitle(
  candidate: Pick<LoomCandidate, 'taskId' | 'evidenceIds'>,
  tasks: readonly LoomTask[],
  artifactById: ReadonlyMap<string, LoomArtifact>
): string | null {
  const task = tasks.find(entry => entry.taskId === candidate.taskId)
  if (task !== undefined && task.title.trim() !== '') return task.title
  const firstEvidenceId = candidate.evidenceIds[0]
  const artifact = firstEvidenceId === undefined ? undefined : artifactById.get(firstEvidenceId)
  if (artifact !== undefined) return loomArtifactLabel(artifact.relativePath)
  return null
}

/** 决定正文渲染方式：Markdown 走 SafeMarkdown，其余一律按纯文本进 pre。 */
export function loomPreviewKind(relativePath: string): 'markdown' | 'text' {
  return /\.(md|markdown|mdx)$/iu.test(relativePath) ? 'markdown' : 'text'
}

/**
 * 产物大小的展示换算：B / KiB / MiB 三档，B 不带小数。
 * 只换单位，不回写、不四舍五入到「看起来更整」的值。
 */
function artifactSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** 一次人工验收的在途表单：勾选集合按 criterionId 记，不依赖数组下标。 */
type DeliveryDraft = {
  candidateId: string
  verdict: 'accepted' | 'rejected'
  reason: string
  satisfied: readonly string[]
}

export function previewFromResult(result: LoomArtifactPreviewResult): LoomPreviewState {
  const reason = result.unavailableReason
  if (reason === 'too_large' || reason === 'binary' || reason === 'not_archived') {
    return { status: 'unavailable', reason }
  }
  // 形状不认识就是读失败，不折算成「没有归档」。
  if (typeof result.text === 'string') return { status: 'ready', text: result.text }
  return { status: 'error', message: '预览没有返回正文' }
}

export function LoomDelivery({ candidates, reviews, verifications, artifacts, plan, missionId, onRefresh, tasks, dependencies, stageReviews, agents, policy }: {
  candidates: LoomCandidate[]
  reviews: LoomReview[]
  verifications: LoomVerification[]
  artifacts: LoomArtifact[] | null
  plan: LoomPlan | null
  missionId: string
  onRefresh: () => void
  tasks: LoomTask[]
  dependencies: LoomDependency[]
  /** null = 控制面读不到，不是「没有审查」 */
  stageReviews: LoomStageReview[] | null
  agents: AgentProfile[]
  /** 当前授权：阶段审查拿它对比 authorizationRevision 判断是否仍有效 */
  policy: LoomControlPolicy | null
}) {
  const t = useUiText()
  // 证据 ID 就是产物登记里的 artifactId：一次建索引，逐条回填，不在渲染里反复扫数组。
  const artifactById = useMemo(
    () => new Map<string, LoomArtifact>((artifacts ?? []).map(entry => [entry.artifactId, entry] as const)),
    [artifacts])
  const client = useThreadClient()
  const [draft, setDraft] = useState<DeliveryDraft | null>(null)
  // 写入是串行的人工动作：在途时禁用全部操作，避免重复 commandId 之外的并发提交。
  const [pending, setPending] = useState('')
  // 错误只挂在出事的候选上：别的卡片不该替它报错。
  const [failure, setFailure] = useState<{ candidateId: string; message: string } | null>(null)
  // 点资产关系行只聚焦到候选卡片，不另存一份选中状态。
  const [focused, setFocused] = useState<string | null>(null)
  // 正文预览：按 artifactId 缓存，点哪个读哪个，不一次拉全部文件。
  const [previews, setPreviews] = useState<Readonly<Record<string, LoomPreviewState>>>({})
  // 正在浮层里查看的产物：只存 artifactId，正文仍来自 previews 缓存，不另存一份文本。
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  const requested = useRef(new Set<string>())
  // 同一文件被连点重试时，只有最后一次请求的结果算数。
  const previewTickets = useRef(new Map<string, number>())
  // scope 用递增代次而不是 missionId：A→B→A 切回来时，A 的迟到响应也不能重新变有效。
  const scopeGeneration = useRef(0)
  const renderMission = useRef<string | null>(null)
  if (renderMission.current !== missionId) {
    renderMission.current = missionId
    scopeGeneration.current += 1
  }
  // 换使命：paint 前丢掉旧预览与旧草稿（同 mission 刷新不清，草稿不丢）；
  // cleanup 递增代次，卸载或换使命后迟到的预览/写入结果一律丢弃。
  useLayoutEffect(() => {
    requested.current = new Set<string>()
    previewTickets.current = new Map<string, number>()
    setPreviews({})
    setDraft(null)
    setPending('')
    setFailure(null)
    setFocused(null)
    return () => { scopeGeneration.current += 1 }
  }, [missionId])

  const readPreview = useCallback((artifactId: string, force = false): void => {
    if (!force && requested.current.has(artifactId)) return
    requested.current.add(artifactId)
    const scopeAtRequest = scopeGeneration.current
    const ticketAtRequest = (previewTickets.current.get(artifactId) ?? 0) + 1
    previewTickets.current.set(artifactId, ticketAtRequest)
    const stillCurrent = (): boolean => scopeGeneration.current === scopeAtRequest
      && previewTickets.current.get(artifactId) === ticketAtRequest
    setPreviews(current => ({ ...current, [artifactId]: { status: 'reading' } }))
    void client.request<LoomArtifactPreviewResult>('loom.artifact.preview', { missionId, artifactId })
      .then(result => {
        if (!stillCurrent()) return
        setPreviews(current => ({ ...current, [artifactId]: previewFromResult(result) }))
      }, (e: unknown) => {
        if (!stillCurrent()) return
        setPreviews(current => ({
          ...current,
          [artifactId]: {
            status: 'error',
            message: e instanceof Error && e.message !== '' ? e.message : '读取正文失败'
          }
        }))
      })
  }, [client, missionId])

  // 枚举值是英文标识，不直接展示；data-state 仍保留原值，两个徽章各看各的状态，不合并。
  const verificationLabel = (state: LoomCandidate['verificationStatus']): string =>
    state === 'verified' ? t('已核验') : state === 'failed' ? t('核验失败') : t('未核验')
  const acceptanceLabel = (state: LoomCandidate['acceptanceStatus']): string =>
    state === 'accepted' ? t('已验收') : state === 'rejected' ? t('已驳回') : t('待验收')
  // 核验方法目前只有人工与自动两种；已知取值翻译，未知值原样显示，不丢信息。
  const methodLabel = (method: string): string =>
    method === 'manual' ? t('人工核验') : method === 'automated' ? t('自动核验') : method
  // 新的返工版本在最前；createdAt 相同就保持后端顺序。
  const ordered = useMemo(() => [...candidates].sort((a, b) =>
    a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1), [candidates])
  // 验收标准版本与逐条标准一律读计划快照：候选快照只照抄，不在这里另立规则。
  const criteria = plan?.acceptanceCriteria.criteria ?? []
  const criteriaVersion = plan?.acceptanceCriteria.version ?? ''
  // 版本链沿 previousCandidateId 回推：v1 是链根，只有链头允许用户接受或核验。
  const versions = useMemo(() => loomCandidateVersions(candidates), [candidates])
  const versionOf = (candidateId: string): number =>
    versions.find(entry => entry.candidateId === candidateId)?.version ?? 1
  const isLatest = (candidateId: string): boolean => loomCandidateAcceptable(versions, candidateId)
  // 资产关系：生产者 → 候选 → 助手审查 → 使用者，全部就地派生自真实投影。
  const assets = useMemo(
    () => loomAssetRelations({ candidates, dependencies, artifacts, stageReviews }),
    [candidates, dependencies, artifacts, stageReviews])
  const focusCandidate = (candidateId: string): void => {
    setFocused(candidateId)
    const card = document.querySelector<HTMLElement>(
      `[data-candidate-id="${candidateId.replace(/"/gu, '')}"]`)
    card?.scrollIntoView({ block: 'nearest' })
  }

  // 首屏只自动读一份：最新候选的第一份已归档文件。其余文件按点击再读。
  const firstPreviewArtifact = useMemo(() => {
    for (const candidate of ordered) {
      if (!isLatest(candidate.candidateId)) continue
      const firstEvidenceId = candidate.evidenceIds[0]
      const artifact = firstEvidenceId === undefined ? undefined : artifactById.get(firstEvidenceId)
      if (artifact !== undefined) return artifact
    }
    return null
    // isLatest 由 versions 派生，versions 又由 candidates 派生，依赖列全即可。
  }, [ordered, artifactById, versions])
  useEffect(() => {
    if (firstPreviewArtifact === null) return
    readPreview(firstPreviewArtifact.artifactId)
  }, [firstPreviewArtifact, readPreview])

  const closeDraft = (): void => { setDraft(null); setPending(''); setFailure(null) }

  const openDraft = (candidate: LoomCandidate, verdict: 'accepted' | 'rejected'): void => {
    setFailure(null)
    setPending('')
    setDraft({ candidateId: candidate.candidateId, verdict, reason: '', satisfied: [] })
  }

  const toggleCriterion = (criterionId: string): void => setDraft(current => current === null ? current : {
    ...current,
    satisfied: current.satisfied.includes(criterionId)
      ? current.satisfied.filter(id => id !== criterionId)
      : [...current.satisfied, criterionId]
  })

  // 接受必须逐条全勾；退回只要求写明理由。reviewerId 由 Core 从可信身份注入，客户端不发。
  const canSubmit = draft !== null && draft.reason.trim() !== ''
    && (draft.verdict === 'rejected' || criteria.every(criterion => draft.satisfied.includes(criterion.criterionId)))

  const recordReview = async (candidate: LoomCandidate): Promise<void> => {
    if (draft === null || draft.candidateId !== candidate.candidateId || !canSubmit || pending !== '') return
    // 提交前再核一次链头：数据旧了就不给「假绿」，让用户刷新后重来。
    if (!loomCandidateAcceptable(versions, candidate.candidateId)) {
      setFailure({ candidateId: candidate.candidateId, message: '这份成果已不是最新版本，请刷新后再决定' })
      return
    }
    const scope = scopeGeneration.current
    setPending(`${candidate.candidateId}:${draft.verdict}`)
    setFailure(null)
    try {
      await client.request<unknown>('loom.review.record', {
        missionId,
        taskId: candidate.taskId,
        candidateId: candidate.candidateId,
        commandId: crypto.randomUUID(),
        acceptanceCriteriaVersion: criteriaVersion,
        verdict: draft.verdict,
        reason: draft.reason.trim(),
        criteriaResults: criteria.map(criterion => ({
          criterionId: criterion.criterionId,
          satisfied: draft.satisfied.includes(criterion.criterionId),
          evidenceIds: [],
          note: null
        }))
      })
      if (scopeGeneration.current !== scope) return
      closeDraft()
      onRefresh()
    } catch (e) {
      if (scopeGeneration.current !== scope) return
      setFailure({ candidateId: candidate.candidateId, message: e instanceof Error ? e.message : '验收写入失败' })
      setPending('')
    }
  }

  // executorId 同样由 Core 注入；客户端只报方法（人工核验）与结论。
  const recordVerification = async (candidate: LoomCandidate, result: 'passed' | 'failed'): Promise<void> => {
    if (pending !== '') return
    // 旧版候选不给核验入口，提交前同样再核一次链头。
    if (!loomCandidateAcceptable(versions, candidate.candidateId)) {
      setFailure({ candidateId: candidate.candidateId, message: '这份成果已不是最新版本，请刷新后再核验' })
      return
    }
    const scope = scopeGeneration.current
    setPending(`${candidate.candidateId}:${result}`)
    setFailure(null)
    try {
      await client.request<unknown>('loom.verification.record', {
        missionId,
        taskId: candidate.taskId,
        candidateId: candidate.candidateId,
        commandId: crypto.randomUUID(),
        method: 'manual',
        result
      })
      if (scopeGeneration.current !== scope) return
      setPending('')
      onRefresh()
    } catch (e) {
      if (scopeGeneration.current !== scope) return
      setFailure({ candidateId: candidate.candidateId, message: e instanceof Error ? e.message : '核验写入失败' })
      setPending('')
    }
  }

  const previewPanel = (artifact: LoomArtifact) => {
    const state = previews[artifact.artifactId]
    // 还没有结果（刚点开、请求在途）与 reading 是同一件事：说正在读，不显示空框。
    if (state === undefined || state.status === 'reading') {
      return <div className="loom-preview-body" data-preview-state="reading">{t('正在读取正文…')}</div>
    }
    if (state.status === 'unavailable') {
      const text = state.reason === 'too_large' ? t('该文件较大，暂不支持正文预览。')
        : state.reason === 'binary' ? t('这是二进制文件，不展示正文。')
          : t('这份成果没有归档正文，只能看登记信息。')
      return <div className="loom-preview-body" data-preview-state="unavailable" data-preview-reason={state.reason}>{text}</div>
    }
    if (state.status === 'error') {
      return <div className="loom-preview-body" data-preview-state="error" role="alert">
        <span>{t('正文读取失败：{0}', state.message)}</span>
        <button type="button" className="loom-preview-retry" onClick={() => readPreview(artifact.artifactId, true)}>
          {t('重试')}
        </button>
      </div>
    }
    return <div className="loom-preview-body" data-preview-state="ready">
      {loomPreviewKind(artifact.relativePath) === 'markdown'
        ? <SafeMarkdown mode="document" rawHtmlPolicy="drop" className="loom-preview-markdown">{state.text}</SafeMarkdown>
        : <pre className="loom-preview-text">{state.text}</pre>}
    </div>
  }

  // 验收表单只写一次：候选卡与浮层上下文共用同一份，语义与门槛不会分叉。
  const reviewForm = (candidate: LoomCandidate, open: DeliveryDraft) => (
    <form className="loom-review-form" onSubmit={event => {
      event.preventDefault()
      void recordReview(candidate)
    }}>
      <div className="loom-review-criteria">
        {criteria.map(criterion => <label key={criterion.criterionId} className="loom-review-criterion">
          <input
            type="checkbox" checked={open.satisfied.includes(criterion.criterionId)}
            onChange={() => toggleCriterion(criterion.criterionId)}/>
          <span className="loom-review-criterion-id">{criterion.criterionId}</span>
          <span className="loom-review-criterion-text">{criterion.text}</span>
        </label>)}
      </div>
      <textarea
        className="loom-review-reason" rows={3} value={open.reason}
        aria-label={t('验收理由')} placeholder={t('验收理由（必填）')}
        onChange={event => {
          const reason = event.target.value
          setDraft(current => current === null ? current : { ...current, reason })
        }}/>
      <div className="loom-delivery-actions">
        <button
          type="submit" className={open.verdict === 'accepted' ? 'loom-btn-accept' : 'loom-btn-reject'}
          disabled={!canSubmit || pending !== ''}>
          {open.verdict === 'accepted' ? t('确认接受') : t('确认退回')}
        </button>
        <button type="button" className="loom-btn-cancel" disabled={pending !== ''} onClick={closeDraft}>
          {t('取消')}
        </button>
      </div>
    </form>
  )
  // 浮层只看一个产物：正文取 previews 缓存，上下文取同一候选的真实投影，不另存状态。
  const openArtifact = openArtifactId === null ? null : artifactById.get(openArtifactId) ?? null
  const openArtifactCandidate = openArtifact === null ? null
    : ordered.find(entry => entry.evidenceIds.includes(openArtifact.artifactId)) ?? null

  return <div className="loom-delivery-context">
    <header className="loom-section-heading">
      <div><span className="loom-eyebrow">LOOM · {t('交付')}</span><h2>{t('成果与验收')}</h2></div>
    </header>
    {ordered.length === 0
      ? <div className="loom-empty">
          <span className="loom-empty-mark" aria-hidden="true"><i/><i/><i/></span>
          <h3>{t('尚无交付')}</h3>
          <div><p>{t('任务提交候选成果后，这里会出现待验收的产物。')}</p></div>
        </div>
      : <>
        <LoomAssetGraph relations={assets} tasks={tasks} agents={agents} candidates={candidates} policy={policy} onFocusCandidate={focusCandidate}/>
        {ordered.map(candidate => {
          const review = reviews.find(entry => entry.candidateId === candidate.candidateId)
          const verification = verifications.find(entry => entry.candidateId === candidate.candidateId)
          const stageReview = stageReviews === null
            ? null
            : loomStageReviewLatest(stageReviews, candidate.candidateId)
          const latest = isLatest(candidate.candidateId)
          // 一个候选只有一份评审、一份核验：已有记录就不再给同类写入口。
          // 并且只有链头可写：旧版留历史，界面不给接受入口（Core 也会拒旧版）。
          const reviewable = latest && review === undefined
          const verifiable = latest && candidate.verificationStatus === 'unverified'
          const open = draft?.candidateId === candidate.candidateId ? draft : null
          const evidenceArtifacts = candidate.evidenceIds
            .map(evidenceId => artifactById.get(evidenceId))
            .filter((entry): entry is LoomArtifact => entry !== undefined)
          const title = loomDeliveryTitle(candidate, tasks, artifactById)
          return <article key={candidate.candidateId} className="loom-candidate"
            data-candidate-id={candidate.candidateId}
            data-chain-version={versionOf(candidate.candidateId)}
            data-latest={latest ? 'true' : 'false'}
            data-focused={focused === candidate.candidateId ? 'true' : 'false'}>
            <div className="loom-candidate-header">
              <h3 className="loom-candidate-title">{title ?? t('交付物')}</h3>
              <span className="loom-candidate-version" data-chain-version={versionOf(candidate.candidateId)}>
                {loomVersionLabel(versionOf(candidate.candidateId))}{latest ? ` · ${t('最新')}` : ''}
              </span>
            </div>
            {!latest && <p className="loom-candidate-locked">
              {t('历史版本不再接受或退回；接受只对最新候选生效。')}
            </p>}
            {/* 已归档正文优先：文件名是按钮，点哪个读哪个；登记信息留在下方详情。 */}
            {candidate.evidenceIds.length > 0 && <div className="loom-preview" aria-label={uiAttribute('成果文件')}>
              {candidate.evidenceIds.map(evidenceId => {
                const artifact = artifactById.get(evidenceId)
                const state = previews[evidenceId]
                return <div key={evidenceId} className="loom-preview-file">
                  {artifact === undefined
                    ? <div className="loom-preview-row" data-artifact-state={artifacts === null ? 'unknown' : 'unregistered'}>
                        <span className="loom-evidence-path">{evidenceId}</span>
                        <span className="loom-evidence-state" data-artifact-state={artifacts === null ? 'unknown' : 'unregistered'}>
                          {artifacts === null ? t('产物信息读取失败') : t('未登记')}
                        </span>
                      </div>
                    : <button type="button" className="loom-preview-row" data-preview-open={state?.status ?? 'idle'}
                        aria-haspopup="dialog" onClick={() => { readPreview(evidenceId); setOpenArtifactId(evidenceId) }}>
                        <span className="loom-evidence-path" title={artifact.relativePath}>{loomArtifactLabel(artifact.relativePath)}</span>
                        <span className="loom-evidence-size">{artifactSizeLabel(artifact.sizeBytes)}</span>
                      </button>}
                  {/* 正文改到浮层里看：行只负责打开，不再把长文挤在卡片里。 */}
                </div>
              })}
            </div>}
            {/* 三条轴分开摆：技术核验、助手审查、用户接受互不代替，也不拼成一个状态。 */}
            <div className="loom-candidate-facts">
              <div className="loom-fact" data-fact="verification">
                <span className="loom-fact-title">{t('技术核验')}</span>
                <span className="loom-badge loom-badge-verification" data-state={candidate.verificationStatus}>
                  {verificationLabel(candidate.verificationStatus)}
                </span>
              </div>
              <div className="loom-fact" data-fact="stage-review">
                <span className="loom-fact-title">{t('助手审查')}</span>
                <LoomStageReviewFact stageReview={stageReview} failed={stageReviews === null} agents={agents} policy={policy}/>
              </div>
              <div className="loom-fact" data-fact="acceptance">
                <span className="loom-fact-title">{t('用户接受')}</span>
                <span className="loom-badge loom-badge-acceptance" data-state={candidate.acceptanceStatus}>
                  {acceptanceLabel(candidate.acceptanceStatus)}
                </span>
              </div>
            </div>
            <div className="loom-delivery-actions">
              {reviewable && <button
                type="button" className="loom-btn-accept" disabled={pending !== ''}
                onClick={() => openDraft(candidate, 'accepted')}>{t('接受')}</button>}
              {reviewable && <button
                type="button" className="loom-btn-reject" disabled={pending !== ''}
                onClick={() => openDraft(candidate, 'rejected')}>{t('退回')}</button>}
            </div>
            {review !== undefined && <details className="loom-summary-details" data-details="review-reason">
              <summary>{t('审查理由')}</summary>
              <div className="loom-candidate-review">
                <div>{t('验收结论')}：{review.verdict === 'accepted' ? t('通过') : t('退回')} · {review.reason}</div>
                {review.criteriaResults.map(result => <div key={result.criterionId}>
                  {result.criterionId} · {result.satisfied ? t('满足') : t('未满足')}
                </div>)}
              </div>
            </details>}
            {failure !== null && failure.candidateId === candidate.candidateId
              && <p className="loom-review-failure">{failure.message}</p>}
            {open !== null && reviewForm(candidate, open)}
            {/* 手动技术核验与全部 ID/hash 细节收进折叠：主界面只留结论与决定。 */}
            <details className="loom-summary-details" data-details="candidate">
              <summary>{t('详情')}</summary>
              <div className="loom-candidate-meta">
                {t('内容哈希')} {candidate.contentHash} · {t('证据')} {candidate.evidenceIds.length} {t('条')}
              </div>
              {evidenceArtifacts.length > 0 && <div className="loom-candidate-evidence">
                {evidenceArtifacts.map(artifact => <div key={artifact.artifactId} className="loom-evidence-row">
                  <span className="loom-evidence-path" title={artifact.relativePath}>{artifact.relativePath}</span>
                  <span className="loom-evidence-hash" title={artifact.sha256}>{artifact.sha256.slice(0, 12)}</span>
                  <span className="loom-evidence-size">{artifactSizeLabel(artifact.sizeBytes)}</span>
                  <span className="loom-evidence-state" data-artifact-state="registered">{t('已登记')}</span>
                </div>)}
              </div>}
              {verification !== undefined && <div className="loom-candidate-verification">
                <div>{t('核验结论')}：{verification.result === 'passed' ? t('通过') : t('失败')} · {methodLabel(verification.method)}</div>
              </div>}
              <div className="loom-candidate-verification">{t('验收标准版本')}：{criteriaVersion === '' ? t('未读到') : criteriaVersion}</div>
              {verifiable && <div className="loom-delivery-actions">
                <button
                  type="button" className="loom-btn-verify" disabled={pending !== ''}
                  onClick={() => void recordVerification(candidate, 'passed')}>{t('通过核验')}</button>
                <button
                  type="button" className="loom-btn-verify" data-result="failed" disabled={pending !== ''}
                  onClick={() => void recordVerification(candidate, 'failed')}>{t('核验失败')}</button>
              </div>}
            </details>
          </article>
        })}
      </>}
      {openArtifact !== null && (() => {
        const candidate = openArtifactCandidate
        const state = previews[openArtifact.artifactId]
        const review = candidate === null ? undefined : reviews.find(entry => entry.candidateId === candidate.candidateId)
        const verification = candidate === null ? undefined : verifications.find(entry => entry.candidateId === candidate.candidateId)
        const latest = candidate === null ? false : isLatest(candidate.candidateId)
        const reviewable = latest && review === undefined
        const openDraftForCandidate = candidate !== null && draft?.candidateId === candidate.candidateId ? draft : null
        return <LoomArtifactDialog
          artifactPath={openArtifact.relativePath}
          fileName={loomArtifactLabel(openArtifact.relativePath)}
          candidateTitle={candidate === null ? null : loomDeliveryTitle(candidate, tasks, artifactById)}
          versionLabel={candidate === null ? null : `${loomVersionLabel(versionOf(candidate.candidateId))}${latest ? ` · ${t('最新')}` : ''}`}
          previewStatus={state?.status ?? 'reading'}
          previewText={state !== undefined && state.status === 'ready' ? state.text : null}
          documentContent={previewPanel(openArtifact)}
          onClose={() => setOpenArtifactId(null)}
          context={<>
            <p className="loom-artifact-side-title">{t('验收上下文')}</p>
            <div className="loom-candidate-meta">
              <div>{t('档案路径')}：{openArtifact.relativePath}</div>
              <div>{t('内容哈希')}：{candidate === null ? openArtifact.sha256.slice(0, 12) : candidate.contentHash.slice(0, 12)} · {artifactSizeLabel(openArtifact.sizeBytes)}</div>
              <div>{t('验收标准版本')}：{criteriaVersion === '' ? t('未读到') : criteriaVersion}</div>
            </div>
            {candidate !== null && <>
              <div className="loom-candidate-facts">
                <div className="loom-fact" data-fact="verification">
                  <span className="loom-fact-title">{t('技术核验')}</span>
                  <span className="loom-badge loom-badge-verification" data-state={candidate.verificationStatus}>
                    {verificationLabel(candidate.verificationStatus)}
                  </span>
                </div>
                <div className="loom-fact" data-fact="acceptance">
                  <span className="loom-fact-title">{t('用户接受')}</span>
                  <span className="loom-badge loom-badge-acceptance" data-state={candidate.acceptanceStatus}>
                    {acceptanceLabel(candidate.acceptanceStatus)}
                  </span>
                </div>
              </div>
              {!latest && <p className="loom-candidate-locked">{t('历史版本不再接受或退回；接受只对最新候选生效。')}</p>}
              {reviewable && openDraftForCandidate === null && <div className="loom-delivery-actions">
                <button type="button" className="loom-btn-accept" disabled={pending !== ''}
                  onClick={() => openDraft(candidate, 'accepted')}>{t('接受')}</button>
                <button type="button" className="loom-btn-reject" disabled={pending !== ''}
                  onClick={() => openDraft(candidate, 'rejected')}>{t('退回')}</button>
              </div>}
              {failure !== null && failure.candidateId === candidate.candidateId && <p className="loom-review-failure">{failure.message}</p>}
              {openDraftForCandidate !== null && reviewForm(candidate, openDraftForCandidate)}
              {review !== undefined && <div className="loom-candidate-review">
                <div>{t('验收结论')}：{review.verdict === 'accepted' ? t('通过') : t('退回')} · {review.reason}</div>
                {review.criteriaResults.map(result => <div key={result.criterionId}>
                  {result.criterionId} · {result.satisfied ? t('满足') : t('未满足')}
                </div>)}
              </div>}
              {verification !== undefined && <div className="loom-candidate-verification">
                <div>{t('核验结论')}：{verification.result === 'passed' ? t('通过') : t('失败')} · {methodLabel(verification.method)}</div>
              </div>}
            </>}
          </>}
        />
      })()}
  </div>
}

/** 旧名保留：现存的调用与测试按 DeliveryReview 引用这份实现。 */
export { LoomDelivery as DeliveryReview }
