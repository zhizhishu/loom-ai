import { uiAttribute } from './interface-language'

export function MessageAuthorProfileTrigger({ agentId, displayName, variant, onActivate, children }: {
  agentId: string
  displayName: string
  variant: 'avatar' | 'name'
  onActivate(agentId: string, trigger: HTMLElement, focusPanel: boolean): void
  children: React.ReactNode
}): React.JSX.Element {
  const label = uiAttribute('查看{0}的基础信息', displayName)
  return <button
    className={`message-author-trigger message-author-${variant}-trigger`}
    type="button" data-agent-id={agentId}
    aria-label={label} aria-haspopup="dialog" aria-expanded={false} title={label}
    onClick={event => onActivate(agentId, event.currentTarget, event.detail === 0)}
    onKeyDown={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      onActivate(agentId, event.currentTarget, true)
    }}>
    {children}
  </button>
}
