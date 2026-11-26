import { describe, expect, it } from 'vitest'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { markdownDiff, remarkDiff, stripDiffMarkers } from './artifact-diff'

describe('artifact markdown diff', () => {
  it('marks whole-line and inline changes without exposing private markers', () => {
    const diff = markdownDiff('# 报告\n\n旧的结果。', '# 报告\n\n新的结果。\n\n追加一行。')
    expect(stripDiffMarkers(diff)).not.toBe(diff)
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkDiff] }, diff))
    expect(html).toContain('<del>')
    expect(html).toContain('<ins>')
    expect(html).toContain('旧')
    expect(html).toContain('新')
    expect(html).not.toMatch(/[-]/)
  })

  it('keeps markdown table punctuation outside marks', () => {
    const diff = markdownDiff('| 状态 | 值 |\n| --- | --- |\n| 构建 | 失败 |', '| 状态 | 值 |\n| --- | --- |\n| 构建 | 通过 |')
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkDiff] }, diff))
    expect(html).toContain('<table>')
    expect(html).toContain('<del>失败</del>')
    expect(html).toContain('<ins>通过</ins>')
  })
})
