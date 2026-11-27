import type { PiPurgePersonaSource } from '@contracts'

const MAX_PERSONA_BYTES = 16 * 1024

export interface PersonaMarkdownImport {
  persona: string
  source: Omit<PiPurgePersonaSource, 'sha256' | 'importedAt'>
}

function valueOf(line: string) {
  const index = line.indexOf(':')
  if (index <= 0) return null
  return { key: line.slice(0, index).trim().toLowerCase(), value: line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '') }
}

export function parsePersonaMarkdown(markdown: string): PersonaMarkdownImport {
  const normalized = markdown.replace(/\r\n?/g, '\n')
  let body = normalized
  const meta: Record<string, string> = {}
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 4)
    if (end > 0) {
      for (const line of normalized.slice(4, end).split('\n')) {
        const row = valueOf(line)
        if (row) meta[row.key] = row.value
      }
      body = normalized.slice(end + 5)
    }
  }
  body = body.replace(/^\n+|\n+$/g, '')
  if (!body.trim()) throw new Error('人格 Markdown 正文为空。')
  if (new TextEncoder().encode(body).byteLength > MAX_PERSONA_BYTES) throw new Error('人格正文超过 16 KiB，Pi Purge 不能接受。')
  return {
    persona: body,
    source: {
      fileName: '',
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.source || meta.sourceurl || meta['source-url'] ? { origin: meta.source || meta.sourceurl || meta['source-url'] } : {}),
      ...(meta.version ? { version: meta.version } : {}),
      ...(meta.license ? { license: meta.license } : {})
    }
  }
}

export async function importPersonaMarkdownFile(file: File): Promise<{ persona: string; source: PiPurgePersonaSource }> {
  const bytes = await file.arrayBuffer()
  const markdown = new TextDecoder().decode(bytes)
  const parsed = parsePersonaMarkdown(markdown)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return {
    persona: parsed.persona,
    source: {
      fileName: file.name || 'persona.md',
      sha256,
      ...(parsed.source.name ? { name: parsed.source.name } : {}),
      ...(parsed.source.origin ? { origin: parsed.source.origin } : {}),
      ...(parsed.source.version ? { version: parsed.source.version } : {}),
      ...(parsed.source.license ? { license: parsed.source.license } : {}),
      importedAt: new Date().toISOString()
    }
  }
}
