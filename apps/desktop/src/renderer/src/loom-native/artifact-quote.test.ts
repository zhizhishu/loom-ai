import { describe, expect, it } from 'vitest'
import { QUOTE_TEXT_MAX, splitQuote, withQuote, type ArtifactQuote } from './artifact-quote'

const quote: ArtifactQuote = {
  artifactId: 'artifact-1',
  version: 1,
  kind: 'element',
  text: '第一段 <重要>\n第二行',
  label: '元素 · 报告',
  selector: 'div>p:nth-of-type(2)'
}

describe('artifact quote header', () => {
  it('serializes text and element metadata at the message head', () => {
    const wire = withQuote('请按这里改', quote)
    expect(wire.startsWith('<quote artifact="artifact-1" version="1" kind="element"')).toBe(true)
    expect(wire).toContain('label="元素 · 报告"')
    expect(wire).toContain('selector="div>p:nth-of-type(2)"')
    expect(splitQuote(wire)).toEqual({ quote, text: '请按这里改' })
  })

  it('escapes markup and caps quoted text', () => {
    const long = { artifactId: 'a&"<', version: 2, kind: 'text' as const, text: `<${'x'.repeat(QUOTE_TEXT_MAX + 20)}` }
    const round = splitQuote(withQuote('', long))
    expect(round.quote?.artifactId).toBe('a&"<')
    expect(round.quote?.text.length).toBe(QUOTE_TEXT_MAX)
    expect(round.text).toBe('')
  })

  it('ignores malformed headers instead of eating user text', () => {
    expect(splitQuote('<quote artifact="a" version="0" kind="text">x</quote>\nhello').text).toContain('hello')
    expect(splitQuote('ordinary').quote).toBeNull()
  })
})
