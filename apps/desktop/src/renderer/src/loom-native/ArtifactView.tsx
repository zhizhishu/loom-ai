import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { LoomReviewRecordReceipt } from '@contracts'
import { useThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'
import { ArtifactPdfPreview } from './ArtifactPdfPreview'
import { Icon } from './icons'
import { ArtifactXlsxPreview } from './ArtifactXlsxPreview'
import './artifact-ux.css'
import type { ArtifactSelection } from './types'
import {
  acceptanceLabel,
  artifactCandidateFacts,
  artifactFileName,
  artifactPreviewKind,
  artifactReviewLabel,
  artifactSizeLabel,
  artifactVersionLabel,
  newReviewDraft,
  readArtifactPreview,
  reviewDraftComplete,
  stripLeadingHeading,
  prepareArtifactReviewAttempt,
  sendArtifactReviewAttempt,
  rememberUnconfirmedReviewAttempt,
  recallUnconfirmedReviewAttempt,
  discardUnconfirmedReviewAttempt,
  taskStatusLabel,
  verificationLabel,
  type ArtifactMedia,
  type ArtifactPreviewState,
  type ArtifactReviewDraft,
  type ArtifactReviewAttempt,
  type ArtifactReviewKind
} from './artifact-service'

/**
 * 图片预览的 object URL：切换文件、重试、关闭浮层都必须 revoke，否则 Blob 会一直留在内存里。
 * 只负责地址生命周期，字节仍然只来自 Core 的一次预览回执。
 */
function useArtifactImageUrl(media: ArtifactMedia | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (media === null || media.kind !== 'image') {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(new Blob([media.bytes as BlobPart], { type: media.mediaType }))
    setUrl(objectUrl)
    return () => {
      setUrl(null)
      URL.revokeObjectURL(objectUrl)
    }
  }, [media])
  return url
}

/**
 * 成果状态位（M7-C）：只描述这份成果现在在哪一步，不接管验收写入口。
 * 审查还在办、或控制事实还没读到，这里就是「审查中」，不会是「等你」。
 * 导出成纯组件，让状态文案能在静态渲染里被验证。
 */
export function ArtifactReviewStatus({ kind }: { kind: ArtifactReviewKind }): React.JSX.Element | null {
  const label = artifactReviewLabel(kind)
  if (label === '') return null
  return <>
    <div className="ln-artifact-fact" data-fact="review-status">
      <span className="ln-artifact-fact-label">成果状态</span>
      <span className="ln-artifact-badge" data-state={kind}>{label}</span>
    </div>
    {kind === 'reviewing' && <p className="ln-artifact-fact-note">助手审查还没有交回结论。</p>}
    {kind === 'fixing' && <p className="ln-artifact-fact-note">助手正在按审查意见返工。</p>}
    {kind === 'ready' && <p className="ln-artifact-fact-note">这份归档没有可验收的候选。</p>}
  </>
}

/**
 * 成果浮层（原生界面）。焦点陷阱、Escape 关闭、滚动锁由 Radix Dialog 提供；
 * 正文只显示 loom.artifact.preview 真实返回的文本，上下文只显示真实的候选/评审/核验投影。
 * 这里不缓存第二份正文，也不在挂载或刷新时自动写任何验收结论。
 */
// Unsaved review text is scoped to the authenticated client and immutable file /
// candidate identity. Closing a panel is not the same as cancelling its draft.
// This deliberately stays in memory, not browser storage or user files.
type ReviewDraftMemory = { identity: string; draft: ArtifactReviewDraft | null; note: string }
const reviewDrafts = new WeakMap<object, Map<string, ReviewDraftMemory>>()
function savedDrafts(client: object): Map<string, ReviewDraftMemory> {
  let drafts = reviewDrafts.get(client)
  if (!drafts) { drafts = new Map(); reviewDrafts.set(client, drafts) }
  return drafts
}

export function ArtifactView({ selection, onClose, onRefresh, fallbackFocus = null, contextAvailable = true, theme: suppliedTheme }: {
  selection: ArtifactSelection
  fallbackFocus?: HTMLElement | null
  contextAvailable?: boolean
  theme?: 'day' | 'night'
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
  // The app supplies the live theme across this portal; legacy callers use the initial app theme.
  const [initialTheme] = useState(() => document.querySelector('.ln-app')?.getAttribute('data-theme') ?? undefined)
  const theme = suppliedTheme ?? initialTheme

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

  // Keep unknown writes under their original immutable intent. Reopening the same
  // artifact restores that intent instead of creating another acceptance command.
  const candidateId = facts.candidate?.candidateId ?? null
  const draftKey = `${missionId}\0${artifact.artifactId}\0${candidateId ?? 'none'}`
  const draftIdentity = `${artifact.sha256}\0${facts.candidate?.contentHash ?? 'none'}\0${facts.candidate?.acceptanceCriteria.version ?? 'none'}`
  const [draft, setDraft] = useState<ArtifactReviewDraft | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<LoomReviewRecordReceipt | null>(null)
  const [attempt, setAttempt] = useState<ArtifactReviewAttempt | null>(null)
  const [pending, setPending] = useState(false)
  const writeScope = useRef(0)
  const sending = useRef(false)
  useEffect(() => {
    const recovered = candidateId === null ? null : recallUnconfirmedReviewAttempt(client, missionId, candidateId)
    writeScope.current += 1
    sending.current = false
    const saved = savedDrafts(client).get(draftKey)
    const restored: ArtifactReviewDraft | null = recovered !== null ? {
      candidateId: recovered.candidateId, verdict: recovered.payload.verdict,
      reason: recovered.payload.reason,
      satisfied: recovered.payload.criteriaResults.filter(row => row.satisfied).map(row => row.criterionId)
    } : saved?.identity === draftIdentity && saved.draft !== null ? { ...saved.draft, satisfied: [...saved.draft.satisfied] } : null
    setAttempt(recovered)
    setDraft(restored)
    setReviewNote(restored?.reason ?? (saved?.identity === draftIdentity ? saved.note : ''))
    setFailure(recovered === null ? null : '上次验收结果尚未确认，请核对。')
    setReceipt(null)
    setPending(false)
    return () => { writeScope.current += 1 }
  }, [client, missionId, artifact.artifactId, candidateId, draftKey, draftIdentity])

  const saveDraft = (value: ArtifactReviewDraft | null): void => {
    setDraft(value)
    setReviewNote(value?.reason ?? '')
    const store = savedDrafts(client)
    if (value === null) store.delete(draftKey)
    else {
      store.delete(draftKey)
      store.set(draftKey, { identity: draftIdentity, draft: { ...value, satisfied: [...value.satisfied] }, note: value.reason })
      // Bound only unsent convenience drafts; unknown write intents live in the
      // separate non-evicting command recovery store and are never discarded here.
      while (store.size > 32) store.delete(store.keys().next().value!)
    }
  }

  // 下载只对已取到的快照成立：没有正文/字节就没有按钮，避免点了没反应的假动作。
  const download = preview.status === 'ready'
    ? { name: fileName, blob: new Blob([preview.text], { type: 'text/plain;charset=utf-8' }) }
    : preview.status === 'media'
      ? { name: fileName, blob: new Blob([preview.media.bytes as BlobPart], { type: preview.media.mediaType }) }
      : null
  const startDownload = (): void => {
    if (download === null) return
    const url = URL.createObjectURL(download.blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = download.name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // 图片的 object URL 只随当前归档字节变化：切到另一份成果、重试或关闭浮层都会 revoke。
  const imageUrl = useArtifactImageUrl(preview.status === 'media' && preview.media.kind === 'image' ? preview.media : null)
  const imageMedia = preview.status === 'media' && preview.media.kind === 'image' ? preview.media : null
  const [lightboxOpen, setLightboxOpen] = useState(false)
  useEffect(() => { if (imageUrl === null) setLightboxOpen(false) }, [imageUrl])

  const toggleCriterion = (criterionId: string): void => {
    if (draft !== null) saveDraft({ ...draft, satisfied: draft.satisfied.includes(criterionId)
      ? draft.satisfied.filter(id => id !== criterionId) : [...draft.satisfied, criterionId] })
  }

  const record = async (): Promise<void> => {
    // This path is only entered by an explicit user action, never by opening a file.
    if (sending.current || pending || !contextAvailable || facts.candidate === null || receipt !== null) return
    const scope = writeScope.current
    const current = (): boolean => scope === writeScope.current
    let intent = attempt ?? recallUnconfirmedReviewAttempt(client, missionId, facts.candidate.candidateId)
    if (intent === null && (draft === null || draft.candidateId !== facts.candidate.candidateId || !facts.latest || !facts.reviewable)) {
      setFailure('这份成果现在不可提交，请刷新记录后再决定')
      return
    }
    sending.current = true
    setPending(true)
    setFailure(null)
    try {
      if (intent === null) {
        intent = prepareArtifactReviewAttempt(missionId, facts, draft!)
        rememberUnconfirmedReviewAttempt(client, intent)
      }
      setAttempt(intent)
      const outcome = await sendArtifactReviewAttempt(client, intent)
      if (outcome.state === 'completed') {
        discardUnconfirmedReviewAttempt(client, intent, 'confirmed_receipt')
        savedDrafts(client).delete(draftKey)
        if (!current()) return
        setReceipt(outcome.receipt)
        setAttempt(null)
        setDraft(null)
        setReviewNote('')
        try { await onRefresh() } catch (error) {
          if (current()) setFailure('验收已记录，但列表刷新失败：'+readErrorMessage(error, '请稍后刷新'))
        }
      } else if (outcome.state === 'rejected') {
        discardUnconfirmedReviewAttempt(client, intent, 'confirmed_rejection')
        if (!current()) return
        setAttempt(null)
        setFailure('无法保存：'+outcome.message)
      } else if (current()) {
        setFailure(outcome.message+'。请核对上次提交。')
      }
    } catch (error) {
      if (current()) setFailure(readErrorMessage(error, '暂时不能提交验收'))
    } finally {
      if (current()) { sending.current=false; setPending(false) }
    }
  }

  const unavailableText = (reason: 'too_large' | 'binary' | 'not_archived'): string =>
    reason === 'too_large' ? '该文件较大，暂不支持预览。'
      : reason === 'binary' ? '这是二进制文件，不展示正文。'
        : '这份成果没有归档内容，只能看登记信息。'

  const documentBody = preview.status === 'reading'
    ? <div className="ln-artifact-state" data-state="reading" role="status">正在读取正文…</div>
    : preview.status === 'unavailable'
      ? <div className="ln-artifact-state" data-state="unavailable" data-reason={preview.reason}>
          {unavailableText(preview.reason)}
        </div>
      : preview.status === 'error'
        ? <div className="ln-artifact-state" data-state="error" role="alert">
            <span>内容读取失败：{preview.message}</span>
            <button type="button" className="ln-artifact-retry" onClick={() => setRetry(value => value + 1)}>重试</button>
          </div>
        : preview.status === 'media'
          ? preview.media.kind === 'pdf'
            ? <ArtifactPdfPreview bytes={preview.media.bytes} fileName={fileName}/>
            : preview.media.kind === 'spreadsheet'
              ? <ArtifactXlsxPreview bytes={preview.media.bytes} fileName={fileName}/>
              : imageUrl === null
              // 字节已经解码，但 object URL 还没就绪：这是短暂的过渡态，不是「没有图」。
              ? <div className="ln-artifact-state" data-state="reading" role="status">正在准备图片…</div>
              : <div className="ln-artifact-media" data-media={preview.media.mediaType}>
                  <button
                    type="button" className="ln-artifact-image-button"
                    title="放大查看" aria-label={`放大查看 ${fileName} · 按 Esc 关闭`}
                    onClick={() => setLightboxOpen(true)}
                  >
                    <img className="ln-artifact-image" src={imageUrl} alt={fileName}/>
                  </button>
                  <p className="ln-artifact-image-hint">{preview.media.mediaType} · 点击图片放大</p>
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
  const canSubmit = contextAvailable && !pending && receipt === null && (attempt !== null || (draft !== null && facts.reviewable && facts.latest && reviewDraftComplete(draft, facts)))
  const documentTitle = preview.status === 'ready' && markdown ? /^\s*#\s+(.+)$/mu.exec(preview.text)?.[1] ?? fileName : fileName

  return <>
  <Dialog.Root open onOpenChange={next => { if (!next) onClose() }}>
    <Dialog.Portal>
      <div className="ln-portal" data-theme={theme}>
        <Dialog.Overlay className="ln-artifact-overlay"/>
        <Dialog.Content
          className="ln-artifact-dialog"
          aria-busy={pending}
          aria-describedby={undefined}
          onCloseAutoFocus={event => {
            event.preventDefault()
            const target = opener.current?.isConnected ? opener.current : fallbackFocus
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
                type="button" className="ln-artifact-download" title="下载文件" aria-label="下载文件"
                onClick={startDownload}
              ><Icon name="download" size={16}/><span>下载</span></button>}
              <Dialog.Close asChild>
                <button type="button" className="ln-artifact-close" title="关闭" aria-label="关闭成果正文">
                  <Icon name="close" size={16}/>
                </button>
              </Dialog.Close>
            </span>
          </header>

          {!contextAvailable && <div className="ln-artifact-state" role="alert">工作记录已更新，请刷新后再验收。<button type="button" className="ln-artifact-retry" onClick={()=>{void onRefresh().catch(error=>setFailure(readErrorMessage(error, '刷新失败')))}}>刷新记录</button></div>}
          <div className="ln-artifact-body">
            <div className="ln-artifact-document">
              <h2 className="ln-artifact-doc-title">{documentTitle}</h2>
              <p className="ln-artifact-doc-meta">{bundle.mission.title} · {new Date(artifact.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新</p>
              {documentBody}
            </div>

            <aside className="ln-artifact-context" aria-label="验收上下文">
              <h3 className="ln-artifact-context-title">验收</h3>
              {facts.task?.description && <details className="ln-artifact-criteria"><summary className="ln-artifact-criteria-head">任务要求</summary><p className="ln-artifact-fact-note">{facts.task.description}</p></details>}

              <div className="ln-artifact-fact" data-fact="task">
                <span className="ln-artifact-fact-label">相关任务</span>
                <span className="ln-artifact-fact-value">
                  {facts.task === null ? '未关联任务' : facts.task.title}
                </span>
                {facts.task !== null && <span className="ln-artifact-badge" data-state={facts.task.status}>
                  {taskStatusLabel(facts.task.status)}
                </span>}
              </div>

              <ArtifactReviewStatus kind={facts.reviewKind}/>

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
                  <span className="ln-artifact-fact-label">检查结果</span>
                  <span className="ln-artifact-badge" data-state={facts.candidate.verificationStatus}>
                    {verificationLabel(facts.candidate.verificationStatus)}
                  </span>
                </div>
                <div className="ln-artifact-fact" data-fact="acceptance">
                  <span className="ln-artifact-fact-label">你的验收</span>
                  <span className="ln-artifact-badge" data-state={facts.candidate.acceptanceStatus}>
                    {acceptanceLabel(facts.candidate.acceptanceStatus)}
                  </span>
                </div>
              </>}

              <details className="ln-artifact-criteria">
                <summary className="ln-artifact-criteria-head">
                  验收标准
                </summary>
                {facts.criteria.length === 0
                  ? <p className="ln-artifact-fact-note">尚未设置验收标准。</p>
                  : <ul className="ln-artifact-criteria-list">
                      {facts.criteria.map(criterion => <li key={criterion.criterionId} className="ln-artifact-criterion">

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
                ? <p className="ln-artifact-fact-note">这份文件尚未提交审核。</p>
                : !facts.latest
                  ? <p className="ln-artifact-fact-note">这是历史版本，请查看最新版本后再验收。</p>
                  : null}

              {contextAvailable && candidate !== null && facts.latest && facts.review === null && receipt === null && attempt === null && draft === null
                && <div className="ln-artifact-review-composer">
                  <textarea aria-label="审阅意见草稿" placeholder="写下审阅意见…" value={reviewNote} onChange={event => {
                    const note=event.target.value; setReviewNote(note)
                    const store=savedDrafts(client); store.delete(draftKey)
                    store.set(draftKey,{identity:draftIdentity,draft:null,note})
                    while(store.size>32)store.delete(store.keys().next().value!)
                  }} rows={2}/>
                  <div className="ln-artifact-actions">
                  <button
                    type="button" className="ln-artifact-accept" disabled={pending}
                    onClick={() => { setFailure(null); saveDraft({ ...newReviewDraft(candidate.candidateId, 'accepted'), reason: reviewNote }) }}
                  >接受</button>
                  <button
                    type="button" className="ln-artifact-reject" disabled={pending}
                    onClick={() => { setFailure(null); saveDraft({ ...newReviewDraft(candidate.candidateId, 'rejected'), reason: reviewNote }) }}
                  >退回</button>
                  </div>
                </div>}

              {attempt !== null && <p className="ln-artifact-fact-note" role="status">请先核对上次提交，再修改验收意见。</p>}
              {draft !== null && candidate !== null && <form
                className="ln-artifact-review-form"
                data-verdict={draft.verdict}
                onSubmit={event => { event.preventDefault(); void record() }}
              >
                <fieldset className="ln-artifact-review-criteria" disabled={pending || attempt !== null || !contextAvailable}>
                  <legend>逐条确认（接受需全部勾选）</legend>
                  {facts.criteria.length === 0
                    ? <p className="ln-artifact-fact-note">尚无逐条标准，请写明验收理由。</p>
                    : facts.criteria.map(criterion => <label key={criterion.criterionId} className="ln-artifact-criterion">
                        <input
                          type="checkbox"
                          checked={draft.satisfied.includes(criterion.criterionId)}
                          onChange={() => toggleCriterion(criterion.criterionId)}
                        />

                        <span className="ln-artifact-criterion-text">{criterion.text}</span>
                      </label>)}
                </fieldset>
                <label className="ln-artifact-review-reason-label" htmlFor="ln-artifact-reason">验收理由（必填）</label>
                <textarea
                  id="ln-artifact-reason"
                  readOnly={pending || attempt !== null || !contextAvailable}
                  className="ln-artifact-review-reason"
                  rows={3}
                  value={draft.reason}
                  placeholder="说明接受或退回的理由…"
                  onChange={event => { if (draft !== null) saveDraft({ ...draft, reason: event.target.value }) }}
                />
                <div className="ln-artifact-actions">
                  <button type="submit" className="ln-artifact-accept" disabled={!canSubmit}>
                    {pending ? '正在核对…' : attempt !== null ? '核对上次提交' : draft.verdict === 'accepted' ? '确认接受' : '确认退回'}
                  </button>
                  <button
                    type="button" className="ln-artifact-cancel" disabled={pending || attempt !== null}
                    onClick={() => { saveDraft(null); setFailure(null) }}
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
    {/* 图片灯箱：和附件卡同一套 Radix Dialog 手法，但用 ln- 前缀的新样式，不复用旧表面类。 */}
    {imageMedia !== null && imageUrl !== null && <Dialog.Root open={lightboxOpen} onOpenChange={setLightboxOpen}>
      <Dialog.Portal>
        <div className="ln-portal" data-theme={theme}>
          <Dialog.Overlay className="ln-artifact-lightbox-overlay"/>
          <Dialog.Content className="ln-artifact-lightbox" aria-describedby={undefined}>
            <Dialog.Title className="ln-artifact-lightbox-title">{fileName}</Dialog.Title>
            <img className="ln-artifact-lightbox-image" src={imageUrl} alt={fileName}/>
            <Dialog.Close className="ln-artifact-lightbox-close" aria-label="关闭图片预览">
              <Icon name="close" size={16}/>
            </Dialog.Close>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>}
  </>
}
