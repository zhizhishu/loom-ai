import { memo } from 'react'

/**
 * Counterpart of Mikka `components/workspace/agent-code-block.tsx` (→ `components/agents/code-block`).
 * LOOM has no highlighter dependency (no shiki / highlight.js in the desktop package), so this keeps the
 * upstream shell only: the language label as a data attribute and the pre/code pair that native.css
 * already styles under `.ln-markdown pre`. Styling and copy stay in loom-native.
 */
export const AgentCodeBlock = memo(function AgentCodeBlock({ code, language = 'text', isStreaming = false }: {
  code: string; language?: string; isStreaming?: boolean
}) {
  return <div className="ln-agent-code" data-language={language.toLowerCase()} data-status={isStreaming ? 'streaming' : 'complete'}>
    <pre><code>{code}</code></pre>
  </div>
})
