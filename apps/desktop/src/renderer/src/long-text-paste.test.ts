import { describe, expect, it } from 'vitest'
import { isLongTextPaste, pastedTextFileName } from './long-text-paste'

describe('single long text paste', () => {
  it('counts code points without treating UTF-16 pairs as two characters', () => {
    for (const character of ['a', '中', '😀', '𠮷']) {
      expect(isLongTextPaste(character.repeat(10_000))).toBe(false)
      expect(isLongTextPaste(character.repeat(10_001))).toBe(true)
    }
    expect(isLongTextPaste('👩‍💻'.repeat(3_333) + 'ab')).toBe(true)
    expect(isLongTextPaste(' \t\r\n'.repeat(2_500))).toBe(false)
  })

  it('avoids current ready and reserved names without needing a global counter', () => {
    expect(pastedTextFileName([])).toBe('粘贴内容-1.txt')
    expect(pastedTextFileName(['粘贴内容-1.txt', 'other.txt', '粘贴内容-3.txt'])).toBe('粘贴内容-2.txt')
  })
})
