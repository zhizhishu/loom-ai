import { AgentCodeBlock } from './AgentCodeBlock'

/**
 * Counterpart of Mikka `components/workspace/agent-mermaid.tsx`.
 * Upstream renders `<MermaidSurface>` only once sanitised SVG exists; otherwise it keeps the source block
 * with a status line. LOOM declares neither `mermaid` nor `dompurify` in the desktop dependencies and this
 * round adds no packages, so the component stays on upstream's "no SVG yet" branch: status copy plus the
 * source block, never raw diagram HTML. Copy is upstream's verbatim.
 */
export function AgentMermaid({ source, isStreaming = false }: { source: string; isStreaming?: boolean }) {
  return <div className="ln-agent-mermaid">
    <p role="status" className="ln-mermaid-status">{isStreaming ? '图表生成中，完成后显示预览。' : '图表暂时无法渲染，已保留源码。'}</p>
    <AgentCodeBlock code={source} language="text" isStreaming={isStreaming} />
  </div>
}
