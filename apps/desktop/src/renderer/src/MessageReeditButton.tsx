import { useCallback, useSyncExternalStore } from 'react'
import type { MessageReeditStore } from './message-reedit-store'
import { UiText, uiAttribute } from './interface-language'

export function MessageReeditButton({ store, threadId, messageId, disabled, onSelect }: {
  store: MessageReeditStore; threadId: string; messageId: string; disabled: boolean; onSelect(): void
}): React.JSX.Element | null {
  const subscribe = useCallback((listener: () => void) => store.subscribe(threadId, messageId, listener), [store, threadId, messageId])
  const available = useSyncExternalStore(subscribe, () => Boolean(store.readReady(threadId, messageId)), () => false)
  if (!available) return null
  return <button type="button" className="message-reedit-action" disabled={disabled}
    title={uiAttribute('两分钟内可重新编辑')} onClick={onSelect}><UiText zh="重新编辑" /></button>
}
