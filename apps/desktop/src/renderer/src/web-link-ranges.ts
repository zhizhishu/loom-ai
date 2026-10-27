import { isWebUrl } from '../../web-url'

export interface WebLinkRange { start: number; end: number; target: string }
const closingPairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

export function bareWebLinks(text: string, offset = 0): WebLinkRange[] {
  const links: WebLinkRange[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\u0000-\u001f\u007f\ufffc]+/giu)) {
    const candidate = match[0]
    const boundary = candidate.search(/[。．，、？！：；（）【】「」『』〈〉《》]/u)
    let end = boundary < 0 ? candidate.length : boundary
    while (end > 0) {
      const last = candidate[end - 1]
      const opening = closingPairs[last]
      if (opening) {
        const prefix = candidate.slice(0, end)
        if (prefix.split(last).length > prefix.split(opening).length) { end--; continue }
      }
      // Query/fragment punctuation can be data. Percent escapes are never trimmed.
      if (/[.,;:!?]/u.test(last) && !/[?#]/u.test(candidate.slice(0, end))) { end--; continue }
      break
    }
    const target = candidate.slice(0, end)
    if (isWebUrl(target)) links.push({ start: offset + match.index, end: offset + match.index + end, target })
  }
  return links
}
