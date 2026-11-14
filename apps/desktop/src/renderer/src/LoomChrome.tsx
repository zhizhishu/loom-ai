import { uiAttribute } from './interface-language'

/** Window-wide chrome. Search itself is portaled here by ThreadNavigation so its
 * existing navigation palette, shortcuts and permissions remain the authority. */
export function LoomChrome({ unreadCount, disabled, onWork, onNewConversation }: {
  unreadCount: number
  disabled: boolean
  onWork(): void
  onNewConversation(): void
}): React.JSX.Element {
  return <header className="loom-app-toolbar" aria-label={uiAttribute('LOOM 工作室')}>
    <div id="loom-global-search-slot" className="loom-global-search-slot" />
    <div className="loom-toolbar-actions">
      <button type="button" className="loom-toolbar-button" disabled={disabled}
        aria-label={unreadCount > 0 ? uiAttribute('使命板，{0} 个使命有未读回复', String(unreadCount)) : uiAttribute('使命板')}
        title={uiAttribute('使命板')} onClick={onWork}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 3.5h11a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H8l-4.5 3V5A1.5 1.5 0 0 1 5 3.5"/><path d="M7 7h6M7 10h4"/></svg>
        {unreadCount > 0 && <span className="loom-toolbar-count">{unreadCount}</span>}
      </button>
      <button type="button" className="loom-toolbar-button" disabled={disabled}
        aria-label={uiAttribute('新对话')} title={uiAttribute('新对话')} onClick={onNewConversation}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>
      </button>
    </div>
  </header>
}
