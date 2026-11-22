/**
 * Counterpart of Mikka `lib/agent-images.ts`, cut down to what this round carries.
 *
 * Upstream's picture is a Wikimedia Commons lookup: `agentImageQuery` validates the search words,
 * `parseAgentImage` reads the Commons response, `findAgentImage` calls `/w/api.php`, and
 * `lib/agent-image-loader.ts` + `app/api/agent/images` wrap that for the renderer. LOOM shows the pictures a
 * reply already carries (markdown image URLs / attachment references), so none of that lookup is ported – it
 * would add a backend route this round does not have. What survives is the record the renderer needs, the text
 * sanitiser upstream applies to Commons metadata, and upstream's URL gate (https only, no userinfo) applied to
 * message URLs instead of Wikimedia hosts. `width`/`height` are dropped too: upstream reads them from the
 * Commons response and no message field carries them.
 */
export type AgentImageResult = {
  src: string
  source?: string
  title?: string
  author?: string
  license?: string
}

/**
 * The one gate for a picture inside a reply: an absolute https URL with no credentials. `data:`, `http:`,
 * `javascript:`, protocol-relative or relative paths and an empty src return null, and the caller shows the
 * alt text instead of loading it. Upstream applies the same protocol/credential checks in `parseAgentImage`
 * before it lets a thumbnail through.
 */
export function imageSourceInMessage(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

/** Upstream `plainText` verbatim: strip tags and entities from credit metadata, cap the line at 300 characters. */
export function plainText(value: string | number | undefined) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 300)
}

/**
 * Upstream prints `Wikimedia Commons · title · author · license` under the figure. LOOM has no Commons lookup,
 * so the same parts are joined without the source-site label: only what the message carries is credited, and
 * nothing is invented when it carries nothing.
 */
export function imageCredit(image: { title?: string; author?: string; license?: string }): string | null {
  const parts = [plainText(image.title), plainText(image.author), plainText(image.license)].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
