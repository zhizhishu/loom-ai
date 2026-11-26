import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentMermaid } from './AgentMermaid'
import { AgentCitationContext } from './AgentCitations'

const render = (text: string, isStreaming = false): string => renderToStaticMarkup(createElement(AgentMarkdown, { text, isStreaming }))
const mermaidFence = '```mermaid\ngraph LR\n  A-->B\n```'

describe('agent Markdown in the native conversation', () => {
  it('keeps a Mermaid fence as a labelled source block while no diagram renderer is installed', () => {
    const html = render(mermaidFence)
    expect(html).toContain('role="status"')
    expect(html).toContain('图表暂时无法渲染，已保留源码。')
    expect(html).toContain('graph LR')
    expect(html).not.toContain('ln-mermaid-surface')
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
    expect(html).toContain('const a = 1')
    expect(html).not.toContain('ln-agent-mermaid')
  })
  it('draws the Mikka code-block header, copy action and line numbers', () => {
    const html = render('```ts\nconst a = 1\nconst b = 2\n```')
    expect(html).toContain('ln-agent-code-head')
    expect(html).toContain('ln-agent-code-language')
    expect(html).toContain('aria-label="复制代码"')
    expect(html).toContain('class="ln-agent-code-line-no" aria-hidden="true">1</span>')
    expect(html).toContain('class="ln-agent-code-line-no" aria-hidden="true">2</span>')
  })
  it('marks streaming code as a live writing surface', () => {
    const html = render('```ts\nconst a = 1\n```', true)
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('role="log"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('正在编写')
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
  it('draws issue and run citations as compact chips', () => {
    const issue = '3f6c1a52-8d0e-4b7a-9c3e-1f2a3b4c5d6e'
    const run = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    const html = render(`完成 [[issue:${issue}]]，见 [[run:${run}]]`)
    expect(html).toContain('ln-citation-chip')
    expect(html).toContain(`data-citation-kind="issue" data-citation-id="${issue}"`)
    expect(html).toContain(`data-citation-kind="run" data-citation-id="${run}"`)
    expect(html).toContain('任务 3f6c1a52')
    expect(html).toContain('运行 a1b2c3d4')
  })
  it('uses conversation facts to label a citation and expose its click target', () => {
    const issue = '3f6c1a52-8d0e-4b7a-9c3e-1f2a3b4c5d6e'
    const html = renderToStaticMarkup(createElement(AgentCitationContext.Provider, {
      value: {
        resolve: (id: string, kind: 'issue' | 'run' | 'any') => kind !== 'run' && id === issue ? { kind: 'issue' as const, id, label: '修好登录页' } : null,
        onOpen: () => undefined
      }
    }, createElement(AgentMarkdown, { text: `完成 [[issue:${issue}]]` })))
    expect(html).toContain('<button type="button" class="ln-citation-chip"')
    expect(html).toContain('打开任务引用：修好登录页')
    expect(html).toContain('修好登录页')
  })
  it('keeps an unresolved bare id as words and hides a partial streamed citation', () => {
    const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    expect(render(`处理 ${id}`)).toContain(`处理 ${id}`)
    const streaming = render(`正在看 [[run:${id.slice(0, 12)}`, true)
    expect(streaming).toContain('正在看</p>')
    expect(streaming).not.toContain('[[run:')
  })
  it('does not turn raw HTML in a reply into markup', () => {
    expect(render('<script>alert(1)</script>')).not.toContain('<script')
  })
  it('survives an empty Mermaid fence', () => {
    const html = render('```mermaid\n```')
    expect(html).toContain('ln-agent-mermaid')
  })
})
