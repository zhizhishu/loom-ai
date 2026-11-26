import { describe, expect, it } from 'vitest'
import { QUOTE_TEXT_MAX, splitQuote, withQuote } from './artifact-quote'

describe('Mikka artifact quote protocol', () => {
  it('round-trips a quote at the head of a message and keeps user text intact', () => {
    const text = withQuote('请接着改', { artifactId: 'a&1', version: 2, kind: 'text', text: '第一段 <必须核对>\n第二行' })
    expect(text).toContain('<quote artifact="a&amp;1" version="2" kind="text">')
    const parsed = splitQuote(text)
    expect(parsed.quote).toEqual({ artifactId: 'a&1', version: 2, kind: 'text', text: '第一段 <必须核对>\n第二行' })
    expect(parsed.text).toBe('请接着改')
  })

  it('caps quoted text and ignores malformed or embedded quote syntax', () => {
    const long = withQuote('正文', { artifactId: 'a', version: 1, kind: 'text', text: 'x'.repeat(QUOTE_TEXT_MAX + 10) })
    expect(splitQuote(long).quote?.text.length).toBe(QUOTE_TEXT_MAX)
    expect(splitQuote('前置<quote artifact="a" version="1" kind="text">x</quote>\n正文').quote).toBeNull()
    expect(splitQuote('<quote artifact="a" version="0" kind="text">x</quote>\n正文').quote).toBeNull()
  })
})
