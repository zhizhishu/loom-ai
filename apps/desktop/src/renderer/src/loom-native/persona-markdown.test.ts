import { describe, expect, it } from 'vitest'
import { parsePersonaMarkdown } from './persona-markdown'

describe('parsePersonaMarkdown', () => {
  it('extracts frontmatter provenance and uses the markdown body as the persona', () => {
    expect(parsePersonaMarkdown('---\nname: reviewer\nversion: 1.2.3\nlicense: MIT\nsource: https://example.invalid/persona\n---\n# Role\nBe exact.\n')).toEqual({
      persona: '# Role\nBe exact.',
      source: { fileName: '', name: 'reviewer', origin: 'https://example.invalid/persona', version: '1.2.3', license: 'MIT' }
    })
  })
  it('keeps plain markdown and rejects empty or oversized bodies', () => {
    expect(parsePersonaMarkdown('# Plain\n').persona).toBe('# Plain')
    expect(() => parsePersonaMarkdown('---\nversion: 1\n---\n')).toThrow('正文为空')
    expect(() => parsePersonaMarkdown(`x${'x'.repeat(16 * 1024)}`)).toThrow('16 KiB')
  })
})
