import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { LoomReviewRecordReceipt } from '@contracts'
import { useThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'
import { Icon } from './icons'
import type { ArtifactSelection } from './types'
import {
  acceptanceLabel,
  artifactCandidateFacts,
  artifactFileName,
  artifactPreviewKind,
  artifactSizeLabel,
  artifactVersionLabel,
  newReviewDraft,
  readArtifactPreview,
  reviewDraftComplete,
  stripLeadingHeading,
  submitArtifactReview,
  taskStatusLabel,
  verificationLabel,
  type ArtifactPreviewState,
  type ArtifactReviewDraft
} from './artifact-service'

/**
 * 成果浮层（原生界面）。焦点陷阱、Escape 关闭、滚动锁由 Radix Dialog 提供；
 * 正文只显示 loom.artifact.preview 真实返回的文本，上下文只显示真实的候选/评审/核验投影。
 * 这里不缓存第二份正文，也不在挂载或刷新时自动写任何验收结论。
 */
export function ArtifactView({ selection, onClose, onRefresh }: {
  selection: ArtifactSelection
  onClose(): void
  onRefresh(): Promise<void>
}): React.JSX.Element {
  const client = useThreadClient()
  const { artifact, bundle } = selection
  const missionId = bundle.mission.missionId
  const fileName = artifactFileName(artifact.relativePath)
  const markdown = artifactPreviewKind(artifact.relativePath) === 'markdown'

  // 触发浮层的那个元素：关闭后焦点必须回到它，找不到就交给浏览器默认处理。
  const opener = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  // 主题只读一次：浮层挂在 portal 里，取 .ln-app 上已经生效的那一个值。
  const [theme] = useState(() => document.querySelector('.ln-app')?.getAttribute('data-theme') ?? undefined)

  const facts = useMemo(
    () => artifactCandidateFacts(bundle, artifact, selection.candidate),
    [bundle, artifact, selection.candidate])

  const [preview, setPreview] = useState<ArtifactPreviewState>({ status: 'reading' })
  // 重试只递增票号：旧请求迟到时票号已变，结果直接丢弃。
  const [retry, setRetry] = useState(0)
  const tickets = useRef(new Map<string, number>())
  useEffect(() => {
    const ticket = (tickets.current.get(artifact.artifactId) ?? 0) + 1
    tickets.current.set(artifact.artifactId, ticket)
    let live = true
    setPreview({ status: 'reading' })
    void readArtifactPreview(client, missionId, artifact.artifactId).then(state => {
      if (!live || tickets.current.get(artifact.artifactId) !== ticket) return
      setPreview(state)
    })
    return () => { live = false }
  }, [client, missionId, artifact.artifactId, retry])

  // 换一份产物就丢掉上一份的草稿/回执/错误：不能把 A 的理由提交到 B 上。
  const [draft, setDraft] = useState<ArtifactReviewDraft | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  // 写入回执：一旦拿到就锁住入口，即使父级投影还没刷新（selection 仍旧）也不会重复验收。
  const [receipt, setReceipt] = useState<LoomReviewRecordReceipt | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setDraft(null)
    setReviewNote('')
    setFailure(null)
    setReceipt(null)
    setPending(false)
  }, [artifact.artifactId])

  // 下载只对已取到的正文快照成立：没有正文就没有按钮，避免点了没反应的假动作。
  const download = preview.status === 'ready' ? { text: preview.text, name: fileName } : null
  const startDownload = (): void => {
    if (download === null) return
    const url = URL.createObjectURL(new Blob([download.text], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = download.name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const toggleCriterion = (criterionId: string): void => setDraft(current => current === null ? current : {
    ...current,
    satisfied: current.satisfied.includes(criterionId)
      ? current.satisfied.filter(id => id !== criterionId)
      : [...current.satisfied, criterionId]
  })

  const record = async (): Promise<void> => {
    // 只有用户按下提交才会走到这里；没有自动接受路径。
    if (draft === null || pending || facts.candidate === null) return
    if (draft.candidateId !== facts.candidate.candidateId) return
    if (!reviewDraftComplete(draft, facts)) return
    // 提交前再用当前投影核一次链头：数据旧了就不给「假绿」，让用户刷新后重来。
    if (!facts.latest) {
      setFailure('这份成果已不是最新版本，请刷新后再决定')
      return
    }
    setPending(true)
    setFailure(null)
    try {
      const result = await submitArtifactReview(client, missionId, facts, draft)
      // 回执即本地事实：表单立刻收起并保持锁住，父级刷新失败也不会重复提交。
      setReceipt(result)
      setDraft(null)
      setPending(false)
      await onRefresh()
    } catch (error) {
      // 失败保留草稿（含理由与勾选），用户改完再提交，不用重写一遍。
      setFailure(readErrorMessage(error, '验收写入失败'))
      setPending(false)
    }
  }

  const unavailableText = (reason: 'too_large' | 'binary' | 'not_archived'): string =>
    reason === 'too_large' ? '该文件较大，暂不支持正文预览。'
      : reason === 'binary' ? '这是二进制文件，不展示正文。'
        : '这份成果没有归档正文，只能看登记信息。'

  const documentBody = preview.status === 'reading'
    ? <div className="ln-artifact-state" data-state="reading" role="status">正在读取正文…</div>
    : preview.status === 'unavailable'
      ? <div className="ln-artifact-state" data-state="unavailable" data-reason={preview.reason}>
          {unavailableText(preview.reason)}
        </div>
      : preview.status === 'error'
        ? <div className="ln-artifact-state" data-state="error" role="alert">
            <span>正文读取失败：{preview.message}</span>
            <button type="button" className="ln-artifact-retry" onClick={() => setRetry(value => value + 1)}>重试</button>
          </div>
        : markdown
          ? <div className="ln-markdown">
              <ReactMarkdown
                remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
                skipHtml
                disallowedElements={['img', 'iframe', 'object', 'embed', 'script', 'style']}
                unwrapDisallowed
                urlTransform={defaultUrlTransform}
              >{stripLeadingHeading(preview.text)}</ReactMarkdown>
            </div>
          : <pre className="ln-artifact-text">{preview.text}</pre>

  // 可写入口只有一种条件：候选是链头且尚无评审；已有回执则一律锁住。
  const candidate = facts.candidate
  const versionLabel = artifactVersionLabel(facts)
  const canSubmit = draft !== null && !pending && facts.reviewable && receipt === null && reviewDraftComplete(draft, facts)
  const documentTitle = preview.status === 'ready' && markdown ? /^\s*#\s+(.+)$/mu.exec(preview.text)?.[1] ?? fileName : fileName

  return <Dialog.Root open onOpenChange={next => { if (!next) onClose() }}>
    <Dialog.Portal>
      <div className="ln-portal" data-theme={theme}>
        <Dialog.Overlay className="ln-artifact-overlay"/>
        <Dialog.Content
          className="ln-artifact-dialog"
          aria-busy={pending}
          aria-describedby={undefined}
          onCloseAutoFocus={event => {
            event.preventDefault()
            const target = opener.current
            if (target !== null && target.isConnected) target.focus({ preventScroll: true })
          }}
        >
          <header className="ln-artifact-head">
            <Icon name="file" size={16}/>
            <Dialog.Title className="ln-artifact-title" title={artifact.relativePath}>{fileName}</Dialog.Title>
            {versionLabel !== null
              && <span className="ln-artifact-version" data-latest={facts.latest ? 'true' : 'false'}>
                {versionLabel}
              </span>}
            <span className="ln-artifact-head-actions">
              {download !== null && <button
                type="button" className="ln-artifact-download" title="下载正文" aria-label="下载正文"
                onClick={startDownload}
              ><Icon name="download" size={16}/><span>下载</span></button>}
              <Dialog.Close asChild>
                <button type="button" className="ln-artifact-close" title="关闭" aria-label="关闭成果正文">
                  <Icon name="close" size={16}/>
                </button>
              </Dialog.Close>
            </span>
          </header>

          <div className="ln-artifact-body">
            <div className="ln-artifact-document">
              <h2 className="ln-artifact-doc-title">{documentTitle}</h2>
              <p className="ln-artifact-doc-meta">{bundle.mission.title} · {new Date(artifact.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新</p>
              {documentBody}
            </div>

            <aside className="ln-artifact-context" aria-label="验收上下文">
              <h3 className="ln-artifact-context-title">{facts.task?.title || bundle.mission.title}</h3>
              {facts.task?.description && <p className="ln-artifact-request">{facts.task.description}</p>}

              <div className="ln-artifact-fact" data-fact="task">
                <span className="ln-artifact-fact-label">相关任务</span>
                <span className="ln-artifact-fact-value">
                  {facts.task === null ? '未关联任务' : facts.task.title}
                </span>
                {facts.task !== null && <span className="ln-artifact-badge" data-state={facts.task.status}>
                  {taskStatusLabel(facts.task.status)}
                </span>}
              </div>

              <details className="ln-artifact-metadata"><summary>文件信息</summary>              <div className="ln-artifact-fact" data-fact="artifact">
                <span className="ln-artifact-fact-label">档案</span>
                <span className="ln-artifact-fact-value" title={artifact.relativePath}>{artifact.relativePath}</span>
                <span className="ln-artifact-fact-note">
                  {artifactSizeLabel(artifact.sizeBytes)} · {artifact.sha256.slice(0, 12)}
                </span>
              </div>
</details>

              {facts.candidate !== null && <>
                <div className="ln-artifact-fact" data-fact="verification">
                  <span className="ln-artifact-fact-label">技术核验</span>
                  <span className="ln-artifact-badge" data-state={facts.candidate.verificationStatus}>
                    {verificationLabel(facts.candidate.verificationStatus)}
                  </span>
                </div>
                <div className="ln-artifact-fact" data-fact="acceptance">
                  <span className="ln-artifact-fact-label">用户接受</span>
                  <span className="ln-artifact-badge" data-state={facts.candidate.acceptanceStatus}>
                    {acceptanceLabel(facts.candidate.acceptanceStatus)}
                  </span>
                </div>
              </>}

              <details className="ln-artifact-criteria">
                <summary className="ln-artifact-criteria-head">
                  验收标准{facts.criteriaVersion === '' ? '' : ` · ${facts.criteriaVersion}`}
                </summary>
                {facts.criteria.length === 0
                  ? <p className="ln-artifact-fact-note">这份候选没有钉住验收标准。</p>
                  : <ul className="ln-artifact-criteria-list">
                      {facts.criteria.map(criterion => <li key={criterion.criterionId} className="ln-artifact-criterion">
                        <span className="ln-artifact-criterion-id">{criterion.criterionId}</span>
                        <span className="ln-artifact-criterion-text">{criterion.text}</span>
                      </li>)}
                    </ul>}
              </details>

              {receipt !== null
                ? <div className="ln-artifact-review-record" data-verdict={receipt.review.verdict} role="status">
                    <p>验收已记录：{receipt.review.verdict === 'accepted' ? '通过' : '退回'} · {receipt.review.reason}</p>
                    <p className="ln-artifact-fact-note">
                      任务状态：{taskStatusLabel(receipt.taskStatus)} · 候选：
                      {acceptanceLabel(receipt.candidateAcceptanceStatus)}
                    </p>
                  </div>
                : facts.review !== null
                  ? <div className="ln-artifact-review-record" data-verdict={facts.review.verdict}>
                      <p>验收结论：{facts.review.verdict === 'accepted' ? '通过' : '退回'} · {facts.review.reason}</p>
                      {facts.review.criteriaResults.map(result => <p key={result.criterionId} className="ln-artifact-fact-note">
                        {result.criterionId} · {result.satisfied ? '满足' : '未满足'}
                      </p>)}
                    </div>
                  : null}

              {facts.candidate === null
                ? <p className="ln-artifact-fact-note">这份产物还没有候选引用，没有可验收的对象。</p>
                : !facts.latest
                  ? <p className="ln-artifact-fact-note">历史版本不再接受或退回；接受只对最新候选生效。</p>
                  : null}

              {candidate !== null && facts.latest && facts.review === null && receipt === null && draft === null
                && <div className="ln-artifact-review-composer">
                  <textarea aria-label="审阅意见草稿" placeholder="写下审阅意见…" value={reviewNote} onChange={event => setReviewNote(event.target.value)} rows={2}/>
                  <div className="ln-artifact-actions">
                  <button
                    type="button" className="ln-artifact-accept" disabled={pending}
                    onClick={() => { setFailure(null); setDraft({ ...newReviewDraft(candidate.candidateId, 'accepted'), reason: reviewNote }) }}
                  >接受</button>
                  <button
                    type="button" className="ln-artifact-reject" disabled={pending}
                    onClick={() => { setFailure(null); setDraft({ ...newReviewDraft(candidate.candidateId, 'rejected'), reason: reviewNote }) }}
                  >退回</button>
                  </div>
                </div>}

              {draft !== null && candidate !== null && <form
                className="ln-artifact-review-form"
                data-verdict={draft.verdict}
                onSubmit={event => { event.preventDefault(); void record() }}
              >
                <fieldset className="ln-artifact-review-criteria">
                  <legend>逐条确认（接受需全部勾选）</legend>
                  {facts.criteria.length === 0
                    ? <p className="ln-artifact-fact-note">这份候选的快照没有逐条标准，只需要写明理由。</p>
                    : facts.criteria.map(criterion => <label key={criterion.criterionId} className="ln-artifact-criterion">
                        <input
                          type="checkbox"
                          checked={draft.satisfied.includes(criterion.criterionId)}
                          onChange={() => toggleCriterion(criterion.criterionId)}
                        />
                        <span className="ln-artifact-criterion-id">{criterion.criterionId}</span>
                        <span className="ln-artifact-criterion-text">{criterion.text}</span>
                      </label>)}
                </fieldset>
                <label className="ln-artifact-review-reason-label" htmlFor="ln-artifact-reason">验收理由（必填）</label>
                <textarea
                  id="ln-artifact-reason"
                  className="ln-artifact-review-reason"
                  rows={3}
                  value={draft.reason}
                  placeholder="说明依据；接受会按上面的逐条结论写入。"
                  onChange={event => {
                    const reason = event.target.value
                    setDraft(current => current === null ? current : { ...current, reason })
                  }}
                />
                <div className="ln-artifact-actions">
                  <button type="submit" className="ln-artifact-accept" disabled={!canSubmit}>
                    {draft.verdict === 'accepted' ? '确认接受' : '确认退回'}
                  </button>
                  <button
                    type="button" className="ln-artifact-cancel" disabled={pending}
                    onClick={() => { setDraft(null); setFailure(null) }}
                  >取消</button>
                </div>
              </form>}

              {failure !== null && <p className="ln-artifact-error" role="alert">{failure}</p>}
            </aside>
          </div>
        </Dialog.Content>
      </div>
    </Dialog.Portal>
  </Dialog.Root>
}
