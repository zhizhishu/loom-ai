import { describe, expect, it } from 'vitest'
import { pastedTextPreview } from './pasted-text-preview'

describe('pasted text card preview', () => {
  it.each([
    ['line breaks and spaces', ' \t\r\n# Rovai：Claude Code\n\n next  line ', '# Rovai：Claude Code next line'],
    ['Unicode limit', '😀中'.repeat(200), '😀中'.repeat(80)],
    ['UTF-8 chunk boundary', ' '.repeat(4095) + '😀内容', '😀内容'],
    ['whitespace only', ' \t\r\n'.repeat(10_001), ''],
    ['display controls', 'a\u202eb\0c', 'a b c'],
    ['literal markup', '<script>alert(1)</script>', '<script>alert(1)</script>']
  ])('keeps a bounded Unicode prefix: %s', (_name, text, expected) => {
    expect(pastedTextPreview(new TextEncoder().encode(text))).toBe(expected)
  })
})
