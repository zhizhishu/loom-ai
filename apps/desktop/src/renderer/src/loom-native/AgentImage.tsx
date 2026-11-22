import { useState } from 'react'
import { imageCredit, imageSourceInMessage, plainText, type AgentImageResult } from './agent-images'

/**
 * Counterpart of Mikka `components/workspace/agent-image.tsx`.
 *
 * Degradations, all because this round adds no dependency and no endpoint:
 * - Upstream's `query` is resolved by `useSWR` against `/api/agent/images` (Wikimedia Commons). LOOM takes the
 *   `src` the reply already carries, so there is no loading skeleton and no "not found for <query>" branch; an
 *   unusable src falls back to the alt text.
 * - `AspectRatio` + `ImageViewer` (motion package, morphing lightbox) are absent, so the picture is upstream's
 *   plain `<img loading="lazy">` instead of a 16/9 thumbnail that opens a viewer. `enlarge`/`illustrationViewer`
 *   copy therefore has nothing to label yet.
 * - `Collapsible` (radix) is absent, so `compact` only tightens the caption; the credit is always visible
 *   instead of folding under 「图片来源与许可」.
 * - Upstream's `<figure>/<figcaption>` become spans: react-markdown emits an image inside a paragraph, and a
 *   block-level figure there is invalid nesting (React warns). CSS renders these spans as blocks.
 * - The failure state keeps upstream's shape: 「配图暂时无法加载。」 plus a 「重试配图」 button that clears the
 *   failure and lets the browser request the picture again.
 *
 * The credit parts (`title`/`source`/`author`/`license`) are upstream's `AgentImageResult` fields, minus the
 * width/height that only the Commons response carries.
 */
export type AgentImageProps = AgentImageResult & {
  alt: string
  caption?: string
  compact?: boolean
}

export function AgentImage({ src, alt, caption, title, source, author, license, compact = false }: AgentImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const imageSrc = imageSourceInMessage(src)
  const credit = imageCredit({ title, author, license })
  const creditHref = imageSourceInMessage(source)
  if (!imageSrc) return <span className="ln-agent-image-missing">{plainText(alt) || '图片'}</span>
  if (failedSrc === imageSrc) return <span className="ln-agent-image-error" role="alert">
    <span>{'配图暂时无法加载。'}</span>
    <button type="button" className="ln-agent-image-retry" onClick={() => setFailedSrc(null)}>{'重试配图'}</button>
  </span>
  return <span className="ln-agent-image" data-compact={compact ? 'true' : undefined}>
    <img className="ln-agent-image-media" src={imageSrc} alt={alt} loading="lazy" onError={() => setFailedSrc(imageSrc)} />
    {(caption || credit) && <span className="ln-agent-image-caption">
      {caption && <span>{plainText(caption)}</span>}
      {credit && (creditHref
        ? <a href={creditHref} target="_blank" rel="noopener noreferrer">{credit}</a>
        : <span>{credit}</span>)}
    </span>}
  </span>
}
