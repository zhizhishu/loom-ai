import { useEffect, useRef, useState } from 'react'
import type { ArtifactSelection } from './types'
import { artifactSizeLabel, readArtifactPreview, type ArtifactMedia, type ArtifactPreviewState } from './artifact-service'
import { Icon } from './icons'
import { artifactCaptureKind, resultGroupViews, resultEntryTitle, resultStatusLabel } from './thread-artifacts'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'
import { SurfaceDialog } from './Controls'
import { useThreadClient } from '../camp-client'
import type { ThreadResultEntry } from './thread-artifacts'

function mediaObjectUrl(media: ArtifactMedia): string {
  return URL.createObjectURL(new Blob([media.bytes as BlobPart], { type: media.mediaType }))
}

type CaptureMediaState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; url: string; kind: 'image' | 'video' }
  | { status: 'failed'; message: string }

function mediaFailure(preview: ArtifactPreviewState): string {
  if (preview.status === 'unavailable') {
    return preview.reason === 'too_large' ? '这份媒体超过当前 8 MiB 预览上限。'
      : preview.reason === 'not_archived' ? '这份媒体没有归档内容。' : '这份媒体不能按文本预览。'
  }
  return preview.status === 'error' ? preview.message : '这份媒体没有可预览字节。'
}

/** 读取一份 captures 成果的归档字节；object URL 随条目切换/卸载释放。 */
function useArtifactMediaUrl(selection: ArtifactSelection, enabled: boolean): CaptureMediaState {
  const client = useThreadClient()
  const artifact = selection.artifact
  const captureKind = artifactCaptureKind(artifact)
  const missionId = selection.bundle.mission.missionId
  const [media, setMedia] = useState<CaptureMediaState>({ status: 'idle' })
  useEffect(() => {
    if (!enabled || (captureKind !== 'image' && captureKind !== 'video')) {
      setMedia({ status: 'idle' })
      return
    }
    let current = true
    let objectUrl: string | null = null
    setMedia({ status: 'loading' })
    void readArtifactPreview(client, missionId, artifact.artifactId).then(preview => {
      if (!current) return
      if (preview.status === 'media' && (preview.media.kind === 'image' || preview.media.kind === 'video')) {
        objectUrl = mediaObjectUrl(preview.media)
        setMedia({ status: 'ready', url: objectUrl, kind: preview.media.kind })
      } else {
        setMedia({ status: 'failed', message: mediaFailure(preview) })
      }
    }, () => undefined)
    return () => {
      current = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [artifact.artifactId, captureKind, client, enabled, missionId])
  return media
}

function CaptureThumb({ entry, selected = false, onOpen }: { entry: ThreadResultEntry; selected?: boolean; onOpen(): void }) {
  const artifact = entry.selection.artifact
  const kind = artifactCaptureKind(artifact)
  const media = useArtifactMediaUrl(entry.selection, kind === 'image')
  const title = resultEntryTitle(artifact.relativePath)
  return <button type="button" className="ln-capture-tile" data-artifact-id={artifact.artifactId}
    data-artifact-group="captures" data-capture-kind={kind ?? 'image'} aria-label={`打开成果：${title}`} aria-current={selected || undefined} onClick={onOpen}>
    {kind === 'image' && media.status === 'ready'
      ? <img src={media.url} alt="" loading="lazy" draggable={false}/>
      : <span className="ln-capture-placeholder"><Icon name="image" size={22}/></span>}
    {kind === 'video' && <span className="ln-capture-play" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m5 3.5 7 4.5-7 4.5z"/></svg></span>}
  </button>
}

function EvidenceViewer({ entries, index, onIndex, onClose }: {
  entries: readonly ThreadResultEntry[]
  index: number
  onIndex(index: number): void
  onClose(): void
}) {
  const entry = entries[index]
  const artifact = entry.selection.artifact
  const kind = artifactCaptureKind(artifact)
  const media = useArtifactMediaUrl(entry.selection, true)
  const strip = useRef<HTMLDivElement>(null)
  const title = resultEntryTitle(artifact.relativePath)
  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [index])
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLVideoElement) return
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); onIndex(index - 1) }
      if (event.key === 'ArrowRight' && index < entries.length - 1) { event.preventDefault(); onIndex(index + 1) }
      if (event.key === 'Home') { event.preventDefault(); onIndex(0) }
      if (event.key === 'End') { event.preventDefault(); onIndex(entries.length - 1) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [entries.length, index, onIndex])
  return <SurfaceDialog open title={title} description={`${index + 1} / ${entries.length}`} onClose={onClose} className="ln-evidence-viewer-dialog">
    <div className="ln-evidence-viewer">
      <div className="ln-evidence-stage">
        <button type="button" className="ln-evidence-step" aria-label="上一条" disabled={index === 0} onClick={() => onIndex(index - 1)}><Icon name="left" size={17}/></button>
        <div className="ln-evidence-media">
          {media.status !== 'ready'
            ? media.status === 'failed'
              ? <div className="ln-evidence-loading" role="alert">{media.message}</div>
              : <div className="ln-evidence-loading" role="status">正在读取归档媒体…</div>
            : kind === 'video' || media.kind === 'video'
              ? <video src={media.url} controls autoPlay playsInline preload="metadata" aria-label={title}/>
              : <img src={media.url} alt={title}/>}
        </div>
        <button type="button" className="ln-evidence-step" aria-label="下一条" disabled={index >= entries.length - 1} onClick={() => onIndex(index + 1)}><Icon name="right" size={17}/></button>
      </div>
      <div ref={strip} className="ln-evidence-strip" role="group" aria-label="全部截图录屏">
        {entries.map((item, position) => <CaptureThumb entry={item} key={item.selection.artifact.artifactId} selected={position === index} onOpen={() => onIndex(position)}/>)}
      </div>
    </div>
  </SurfaceDialog>
}

/**
 * 「成果」段（参照 Mikka `thread-artifacts.tsx` 的 ThreadArtifactsList）：计划 / 改动 / 报告 / 截图录屏
 * 各一组、各带数量，空组不出现。captures 照上游用缩略网格和 EvidenceViewer 式媒体查看器；
 * 其他行仍只打开既有预览入口，不造第二种阅读面。
 */
export function ThreadResults({ entries, onArtifact }: {
  entries: readonly ThreadResultEntry[]
  onArtifact: (selection: ArtifactSelection) => void
}) {
  const groups = resultGroupViews(entries)
  const captures = entries.filter(entry => entry.group === 'captures')
  const [viewing, setViewing] = useState<number | null>(null)
  return <div className="ln-results" role="tabpanel" aria-label="成果">
    {groups.length === 0 && <Empty className="ln-empty--inline"><EmptyHeader><EmptyMedia variant="icon"><Icon name="file" size={18}/></EmptyMedia><EmptyTitle>这场对话还没有成果</EmptyTitle><EmptyDescription>助手交付的文件会归档在这里。</EmptyDescription></EmptyHeader></Empty>}
    {groups.map(({ group, label, count, entries: groupEntries }) => <section className="ln-result-group" data-group={group} key={group}>
      <h3>{label}<span className="ln-result-count">{count}</span></h3>
      {group === 'captures' ? <div className="ln-capture-grid">
        {groupEntries.map((entry, captureIndex) => <CaptureThumb entry={entry} key={entry.selection.artifact.artifactId} onOpen={() => setViewing(captureIndex)}/>)}
      </div> : <div className="ln-result-list">
        {groupEntries.map(({ selection }) => <button className="ln-artifact-card" data-artifact-id={selection.artifact.artifactId}
          data-artifact-group={group} key={selection.artifact.artifactId} type="button"
          aria-label={`打开成果：${resultEntryTitle(selection.artifact.relativePath)}`}
          onClick={() => onArtifact(selection)}>
          <span className="ln-document-icon"><Icon name="file" size={22}/></span>
          <span>
            <strong>{resultEntryTitle(selection.artifact.relativePath)}</strong>
            <small>{resultStatusLabel(selection.candidate)} · {artifactSizeLabel(selection.artifact.sizeBytes)}</small>
          </span>
          <Icon name="right" size={15}/>
        </button>)}
      </div>}
    </section>)}
    {viewing !== null && captures[viewing] && <EvidenceViewer entries={captures} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)}/>}
  </div>
}
