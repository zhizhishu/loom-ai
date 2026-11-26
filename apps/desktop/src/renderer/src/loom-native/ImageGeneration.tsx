import type { CSSProperties, ReactNode } from 'react'

export type ImageGenerationStatus = 'queued' | 'generating' | 'refining' | 'complete' | 'error'

const STATUS_TEXT: Record<ImageGenerationStatus, string> = {
  queued: '等待生成',
  generating: '正在生成图片',
  refining: '正在细化细节',
  complete: '图片已就绪',
  error: '生成失败',
}

export function ImageGeneration({
  children,
  status = 'complete',
  aspectRatio = '16 / 9',
  prompt,
  resolution,
  statusText,
  onRetry,
}: {
  children?: ReactNode
  status?: ImageGenerationStatus
  aspectRatio?: CSSProperties['aspectRatio']
  prompt?: string
  resolution?: string
  statusText?: string
  onRetry?: () => void
}) {
  const ready = status === 'complete' && children
  return <span className="ln-image-generation" data-status={status}>
    <span className="ln-image-generation-media" style={ready ? undefined : { aspectRatio }}>
      {children}
      {!ready && <span className="ln-image-generation-overlay" role={status === 'error' ? 'alert' : 'status'}>
        <span className="ln-image-generation-mark" aria-hidden="true" />
        <span>{statusText ?? STATUS_TEXT[status]}</span>
        {resolution && <span className="ln-image-generation-detail">{resolution}</span>}
        {status === 'error' && onRetry && <button type="button" className="ln-image-generation-retry" onClick={onRetry}>重试</button>}
      </span>}
    </span>
    {prompt && <span className="ln-image-generation-prompt">{prompt}</span>}
  </span>
}
