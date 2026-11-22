import { createContext, useContext, useState } from 'react'

/**
 * Counterpart of Mikka `components/workspace/agent-openui-button.tsx`.
 *
 * A click does what OpenUI's does in the web app: the button hands its action to the conversation, which continues
 * the chat. LOOM has no `@openuidev/react-lang` (no `useTriggerAction`, no form, no `useIsStreaming`) and adds no
 * packages, so this copy keeps the props, the variant mapping and the one algorithm that matters — resolve the
 * action into words the conversation can carry — and refuses everything else instead of pretending:
 *
 * - Upstream asks the surrounding form to validate before a `primary` button acts (agent-openui-button.tsx:24-30).
 *   LOOM draws no OpenUI forms, so there is nothing to validate and the step check only decides what a click sends.
 * - Upstream disables the button while the reply streams (`useIsStreaming`). LOOM has no streaming context here,
 *   so the button is disabled while its own send is in flight instead.
 * - Only a step that carries words for the assistant can be carried: LOOM's conversation can send a message. A
 *   `run`/`custom_action` step, or an action that names no words, has no capability behind it, so the button stays
 *   disabled and prints why underneath.
 */

/** OpenUI's action step types as the language writes them (`ACTION_STEPS` in `@openuidev/react-lang`). */
const TO_ASSISTANT = 'to_assistant'

export type OpenUiActionStep = {
  type?: string
  text?: string
  prompt?: string
  message?: string
  refType?: string
  params?: Record<string, unknown>
}

/** An OpenUI action as `BeButton(label, action, variant)` carries it: words, a step plan, or a named action. */
export type OpenUiAction = string | null | {
  type?: string
  text?: string
  prompt?: string
  message?: string
  steps?: OpenUiActionStep[]
  params?: Record<string, unknown>
}

/** What a click can do here: send these words, or the reason this button cannot act. */
export type ResolvedOpenUiAction = { text: string } | { reason: string }

/** The words an action carries for the assistant, if it carries any. */
function words(value: { text?: string; prompt?: string; message?: string; params?: Record<string, unknown> }): string | null {
  for (const key of ['text', 'prompt', 'message'] as const) {
    const found = (value as Record<string, unknown>)[key]
    if (typeof found === 'string' && found.trim()) return found
  }
  const params = value.params
  if (params) for (const key of ['text', 'prompt', 'message'] as const) {
    const found = params[key]
    if (typeof found === 'string' && found.trim()) return found
  }
  return null
}

/**
 * The click's algorithm (upstream hands the action to `useTriggerAction`): words the conversation can send become a
 * message; anything else is refused with the reason, so the card never looks like it did something.
 */
export function resolveOpenUiAction(action: OpenUiAction | undefined, label: string): ResolvedOpenUiAction {
  if (action === undefined || action === null) {
    const fallback = label.trim()
    return fallback ? { text: fallback } : { reason: '这个按钮没有可执行的动作。' }
  }
  if (typeof action === 'string') return action.trim() ? { text: action } : { reason: '这个按钮没有可发送的内容。' }
  const steps = action.steps
  if (steps && steps.length) {
    if (steps.length > 1) return { reason: '这个按钮要依次执行多个动作，当前会话只能发送一条消息。' }
    const [step] = steps
    // A run step (or a custom action) leaves the conversation: LOOM's native chat has no such capability.
    if (step.refType || (step.type && step.type !== TO_ASSISTANT)) {
      return { reason: `这个按钮要执行的动作（${step.type ?? step.refType}）在当前会话没有对应能力。` }
    }
    const text = words(step)
    return text ? { text } : { reason: '这个按钮没有可发送的内容。' }
  }
  if (action.type && action.type !== TO_ASSISTANT) return { reason: `这个按钮要执行的动作（${action.type}）在当前会话没有对应能力。` }
  const text = words(action)
  return text ? { text } : { reason: '这个按钮没有可执行的动作。' }
}

/** What a card can do in its conversation: send the person's words as their next message, resolving true when it went out. */
export type AgentOpenUiHost = { send(text: string): Promise<boolean> }

const AgentOpenUiContext = createContext<AgentOpenUiHost | null>(null)

/** The host a conversation gives its OpenUI cards. Without one every card button is disabled and says why. */
export const AgentOpenUiProvider = AgentOpenUiContext.Provider

export const useAgentOpenUiHost = () => useContext(AgentOpenUiContext)

const VARIANTS = { primary: 'is-primary', secondary: 'is-secondary', tertiary: 'is-tertiary' } as const

export function AgentOpenUiButton({ props }: { props: Record<string, unknown> }) {
  const host = useAgentOpenUiHost()
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle')
  const label = typeof props.label === 'string' ? props.label : ''
  const resolved = resolveOpenUiAction(props.action as OpenUiAction | undefined, label)
  const variant = typeof props.variant === 'string' && props.variant in VARIANTS ? props.variant as keyof typeof VARIANTS : 'primary'
  const tone = props.type === 'destructive' ? 'is-destructive' : VARIANTS[variant]
  const missing = 'reason' in resolved ? resolved.reason : host ? null : '当前会话没有可发送消息的宿主。'
  const send = async () => {
    if (missing || !host || 'reason' in resolved) return
    setState('sending')
    try { const sent = await host.send(resolved.text); setState(sent ? 'idle' : 'failed') } catch { setState('failed') }
  }
  return <div className="ln-openui-button">
    <button type="button" className={`ln-openui-button-face ${tone}`} disabled={Boolean(missing) || state === 'sending'} title={missing ?? undefined} onClick={() => { void send() }}>{label}</button>
    {missing && <small className="ln-openui-button-reason">{missing}</small>}
    {state === 'failed' && <small className="ln-openui-button-reason" role="alert">没发出去，再试一次。</small>}
  </div>
}
