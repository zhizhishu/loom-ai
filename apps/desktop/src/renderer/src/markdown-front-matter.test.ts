import { describe, expect, it } from 'vitest'
import { parseMarkdownFrontMatter } from './markdown-front-matter'

describe('Markdown file front matter', () => {
  it('separates a leading YAML mapping from the exact Markdown body', () => {
    const source = [
      '---',
      'document_type: contracts-index',
      'authority: renderer-file-preview',
      'last_updated: 2026-09-19',
      '---',
      '',
      '# Contract index'
    ].join('\n')

    expect(parseMarkdownFrontMatter(source)).toEqual({
      body: '\n# Contract index',
      frontMatter: {
        kind: 'metadata',
        fields: [
          { key: 'document_type', value: 'contracts-index' },
          { key: 'authority', value: 'renderer-file-preview' },
          { key: 'last_updated', value: '2026-09-19' }
        ]
      }
    })
  })

  it('keeps arrays, nested mappings, long scalars, and large integers structured', () => {
    const source = [
      '---',
      'tags: [markdown, file-preview]',
      'owners:',
      '  renderer: desktop-team',
      '  review: design-team',
      'description: >-',
      '  A long description that remains readable',
      '  in a narrow preview.',
      'sequence: 12345678901234567890',
      '---',
      'Body'
    ].join('\n')
    const parsed = parseMarkdownFrontMatter(source)

    expect(parsed.frontMatter).toEqual({
      kind: 'metadata',
      fields: [
        { key: 'tags', value: '- markdown\n- file-preview' },
        { key: 'owners', value: 'renderer: desktop-team\nreview: design-team' },
        { key: 'description', value: 'A long description that remains readable in a narrow preview.' },
        { key: 'sequence', value: '12345678901234567890' }
      ]
    })
    expect(parsed.body).toBe('Body')
  })

  it('preserves a closed malformed header verbatim while continuing with the body', () => {
    const source = '---\r\ndocument_type: contract\r\nauthority: [renderer\r\n---\r\n\r\n# Body still renders'
    const parsed = parseMarkdownFrontMatter(source)

    expect(parsed).toEqual({
      body: '\r\n# Body still renders',
      frontMatter: {
        kind: 'error',
        raw: '---\r\ndocument_type: contract\r\nauthority: [renderer\r\n---\r\n'
      }
    })
  })

  it.each([
    ['duplicate keys', 'document_type: first\ndocument_type: second'],
    ['an unknown tag', 'document_type: !application/type contract'],
    ['an unsupported set value', 'document_type: !!set\n  contract:']
  ])('fails closed for %s without hiding the Markdown body', (_label, header) => {
    const raw = `---\n${header}\n---\n`
    expect(parseMarkdownFrontMatter(`${raw}# Body`)).toEqual({
      body: '# Body',
      frontMatter: { kind: 'error', raw }
    })
  })

  it('removes an explicitly empty header without creating metadata', () => {
    expect(parseMarkdownFrontMatter('---\n---\n\n# Body')).toEqual({
      body: '\n# Body',
      frontMatter: null
    })
    expect(parseMarkdownFrontMatter('---\n{}\n---\n# Body')).toEqual({
      body: '# Body',
      frontMatter: null
    })
  })

  it.each([
    ['ordinary Markdown', '# Body\n\n---\n\nAfter'],
    ['a fenced YAML example', '```yaml\n---\ndocument_type: contract\n---\n```'],
    ['an unclosed header', '---\ndocument_type: contract\n\n# Body'],
    ['body separators at the file edges', '---\n\n# Body heading\n\n---\nAfter'],
    ['a non-mapping YAML document', '---\n- first\n- second\n---\nAfter']
  ])('leaves %s completely unchanged', (_label, source) => {
    expect(parseMarkdownFrontMatter(source)).toEqual({ body: source, frontMatter: null })
  })

  it('accepts a byte-order mark without changing the visible body', () => {
    const source = '\ufeff---\nname: example\n---\n# Body'
    expect(parseMarkdownFrontMatter(source)).toEqual({
      body: '# Body',
      frontMatter: { kind: 'metadata', fields: [{ key: 'name', value: 'example' }] }
    })
  })
})
