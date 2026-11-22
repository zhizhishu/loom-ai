import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentMermaid } from './AgentMermaid'

const render = (text: string, isStreaming = false): string => renderToStaticMarkup(createElement(AgentMarkdown, { text, isStreaming }))
const mermaidFence = '```mermaid\ngraph LR\n  A-->B\n```'

describe('agent Markdown in the native conversation', () => {
  it('keeps a Mermaid fence as a labelled source block while no diagram renderer is installed', () => {
    const html = render(mermaidFence)
    expect(html).toContain('role="status"')
    expect(html).toContain('图表暂时无法渲染，已保留源码。')
    expect(html).toContain('graph LR')
    expect(html).not.toContain('<svg')
  })
  it('says a diagram is still being drawn while the reply streams', () => {
    expect(render(mermaidFence, true)).toContain('图表生成中，完成后显示预览。')
  })
  it('keeps Mermaid source visible when the diagram component is used directly', () => {
    const html = renderToStaticMarkup(createElement(AgentMermaid, { source: 'flowchart TD\n  A-->B' }))
    expect(html).toContain('已保留源码')
    expect(html).toContain('flowchart TD')
  })
  it('keeps the fence language on non-Mermaid code', () => {
    const html = render('```ts\nconst a = 1\n```')
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('<pre><code>const a = 1</code></pre>')
    expect(html).not.toContain('ln-agent-mermaid')
  })
  it('labels a wide table as its own region without flattening it', () => {
    const html = render('| PR | Status |\n|---|---|\n| #1 | Review |')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Markdown 表格"')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>Review</td>')
  })
  it('opens reply links outside the app', () => {
    const html = render('[来源](https://example.test/doc)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })
  it('does not turn raw HTML in a reply into markup', () => {
    expect(render('<script>alert(1)</script>')).not.toContain('<script')
  })
  it('survives an empty Mermaid fence', () => {
    const html = render('```mermaid\n```')
    expect(html).toContain('ln-agent-mermaid')
  })
})
