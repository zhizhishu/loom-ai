import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

/**
 * Counterpart of Mikka `components/agents/code-block.tsx`: one rounded shell with a small header
 * (file icon + language + writing state + copy action), then a scrolling line-numbered viewport.
 * LOOM still has no highlighter dependency, so token colouring is deliberately left out; the copy,
 * streaming affordance, line numbers and max-height viewport are copied because they are pure UI.
 */
export const AgentCodeBlock = memo(function AgentCodeBlock({ code, language = 'text', isStreaming = false }: {
  code: string; language?: string; isStreaming?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  const lines = code.split('\n')

  useEffect(() => () => {
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
  }, [])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return <div className="ln-agent-code" data-language={language.toLowerCase()} data-status={isStreaming ? 'streaming' : 'complete'} aria-busy={isStreaming || undefined}>
    <div className="ln-agent-code-head">
      <Icon name="file" size={14}/>
      <span className="ln-agent-code-language">{language}</span>
      {isStreaming && <span className="ln-agent-code-writing" role="status">正在编写</span>}
      <button type="button" className="ln-agent-code-copy" aria-label={copied ? '已复制代码' : '复制代码'} title={copied ? '已复制代码' : '复制代码'} onClick={() => { void copy() }}>
        <Icon name={copied ? 'check' : 'copy'} size={14}/>
      </button>
    </div>
    <div className="ln-agent-code-viewport" role={isStreaming ? 'log' : undefined} aria-live={isStreaming ? 'polite' : undefined}>
      <pre data-agent-code-pre><code>{lines.map((line, index) => <span className="ln-agent-code-line" key={index}><span className="ln-agent-code-line-no" aria-hidden="true">{index + 1}</span><span className="ln-agent-code-line-text">{line || ' '}</span></span>)}</code></pre>
    </div>
  </div>
})
