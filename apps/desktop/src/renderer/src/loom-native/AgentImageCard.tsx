import { AgentImage } from './AgentImage'

/**
 * Counterpart of Mikka `components/workspace/agent-image-card.tsx`.
 *
 * Degradations:
 * - Upstream's `query` is looked up on Wikimedia Commons; LOOM takes the `src` the reply carries (card data
 *   next round, when `BeImageCard` is dispatched).
 * - Upstream wraps everything in `components/motion/card` (`Card`, `CardContent`, `CardHeader`, …). LOOM has no
 *   such component, so the card is a `section[role=group]` with the same order: picture, title, description,
 *   tags, footer.
 * - `useAgentDecision` (send / `sent` → 「已提问」 / error alert / disabled unless pending) has no LOOM
 *   counterpart yet. The button renders when the card carries a `prompt` and stays disabled until a host passes
 *   `onPrompt`; the ask/sent/error states arrive with the OpenUI card round.
 */
export function AgentImageCard({ title, description, src, alt, caption, tags = [], source, author, license, prompt, onPrompt }: {
  title: string
  description: string
  src: string
  alt?: string
  caption?: string
  tags?: string[]
  source?: string
  author?: string
  license?: string
  prompt?: string
  onPrompt?: (prompt: string) => void
}) {
  return <section className="ln-agent-image-card" role="group" aria-label={title}>
    <AgentImage src={src} alt={alt ?? title} caption={caption} source={source} author={author} license={license} compact />
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    {tags.length > 0 && <ul className="ln-agent-image-card-tags">{tags.map((tag, index) => <li key={index}>{tag}</li>)}</ul>}
    {prompt && <div className="ln-agent-image-card-foot">
      <button type="button" className="ln-agent-image-card-ask" disabled={!onPrompt} onClick={() => onPrompt?.(prompt)}>{'继续了解'}</button>
    </div>}
  </section>
}
