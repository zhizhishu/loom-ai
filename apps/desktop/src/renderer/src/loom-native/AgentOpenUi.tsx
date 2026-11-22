import { AgentMarkdown } from './AgentMarkdown'
import { AgentOpenUiButton } from './AgentOpenUiButton'
import { inlineMarkdown, isComponent, openUIText, parseOpenUI, splitOpenUI, str, type Value } from './openui-lang'

/**
 * Counterpart of Mikka's native drawing of OpenUI cards (`apps/mobile/components/OpenUI.tsx`, over
 * `lib/openui-lang.ts`). The web app draws the same text with `@openuidev/react-lang`; LOOM has neither that
 * package nor `@/components/motion/*`, so this renders the parse with the shell's own elements.
 *
 * What it draws, per upstream's own split of "the cards it knows" vs "its words":
 * - Stack/BeResponse/BeCard/BeCardGrid/TextContent/InlineText and the three chips, as the mobile app draws them.
 * - BeButton through `AgentOpenUiButton`, whose click continues the conversation.
 * - Everything else — BeQuestions, BeApproval, BeImageCard, BeImage, BeFollowUps, unknown cards — has no drawing
 *   here, so it keeps upstream's text fallback (`openUIText`) and never shows a button the host cannot honour.
 *   Upstream's web library also draws no follow-ups in a chat (R-12), so BeFollowUps draws nothing at all.
 */
export function AgentOpenUi({ text }: { text: string }) {
  const root = parseOpenUI(text)
  // A reply that does not parse keeps its source: the caller shows the code block instead.
  if (root === null) return null
  // Words the bot wrote before its cards stay above them, as upstream keeps the prose.
  const prose = splitOpenUI(text)?.prose
  return <div className="ln-openui">
    {prose ? <div className="ln-openui-prose"><AgentMarkdown text={prose}/></div> : null}
    <Node value={root}/>
  </div>
}

function Node({ value }: { value: Value | undefined }) {
  if (Array.isArray(value)) return <>{value.map((item, index) => <Node key={index} value={item}/>)}</>
  if (typeof value === 'string') return value.trim() ? <div className="ln-openui-text"><AgentMarkdown text={value}/></div> : null
  if (!isComponent(value)) return null
  switch (value.name) {
    case 'Stack': case 'BeResponse':
      return <div className="ln-openui-stack"><Node value={value.props.children}/></div>
    case 'TextContent':
      return str(value.props.text).trim() ? <div className="ln-openui-text"><AgentMarkdown text={str(value.props.text)}/></div> : null
    case 'InlineText':
      return <p className="ln-openui-inline"><Inline value={value.props.parts}/></p>
    case 'TaskChip': case 'RunChip':
      // Upstream's own degradation: the raw id when the conversation cannot show the issue or run (agent-citations.tsx:195).
      return <span className="ln-openui-chip">{str(value.props.id).toLowerCase()}</span>
    case 'SourceChip': {
      const url = str(value.props.url)
      if (!url) return null
      return <a className="ln-openui-chip" href={url} target="_blank" rel="noreferrer noopener">{str(value.props.label) || url}</a>
    }
    case 'BeCard':
      return <section className="ln-openui-card" role="group" aria-label={str(value.props.title)}>
        {str(value.props.title) && <h3>{str(value.props.title)}</h3>}
        {str(value.props.description) && <p className="ln-openui-card-description">{str(value.props.description)}</p>}
        <Items value={value.props.children}/>
      </section>
    case 'BeCardGrid':
      return <div className="ln-openui-grid"><Node value={value.props.children}/></div>
    case 'BeButton':
      return <AgentOpenUiButton props={{ label: str(value.props.label), action: value.props.action, variant: str(value.props.variant) }}/>
    // The web's chat draws saved follow-ups as nothing (R-12); the phone draws them, LOOM follows the chat it lives in.
    case 'BeFollowUps':
      return null
    default: {
      const words = openUIText(value)
      return words.trim() ? <section className="ln-openui-card ln-openui-plain"><AgentMarkdown text={words}/></section> : null
    }
  }
}

/** A card's children, whether the language wrote one node or a list of them. */
function Items({ value }: { value: Value | undefined }) {
  return Array.isArray(value) ? <>{value.map((child, index) => <Node key={index} value={child}/>)}</> : <Node value={value}/>
}

/** Inline parts: words stay in the line, chips become the chip the shell can draw. */
function Inline({ value }: { value: Value | undefined }) {
  if (typeof value === 'string') return <>{value}</>
  if (Array.isArray(value)) return <>{value.map((item, index) => <Inline key={index} value={item}/>)}</>
  if (!isComponent(value)) return null
  if (value.name === 'InlineText') return <Inline value={value.props.parts}/>
  if (value.name === 'TaskChip') return <span className="ln-openui-chip">{str(value.props.id).toLowerCase()}</span>
  if (value.name === 'RunChip') return <span className="ln-openui-chip">{str(value.props.id).toLowerCase()}</span>
  if (value.name === 'SourceChip') {
    const url = str(value.props.url)
    return url ? <a className="ln-openui-chip" href={url} target="_blank" rel="noreferrer noopener">{str(value.props.label) || url}</a> : null
  }
  const words = inlineMarkdown(value)
  return words ? <>{words}</> : null
}
