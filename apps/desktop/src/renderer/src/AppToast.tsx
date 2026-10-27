import { uiAttribute } from './interface-language'

export type AppToastValue = {
  message: string
  tone: 'neutral' | 'danger'
  action?: { label: string; onSelect(): void }
  persistent?: boolean
}

export function AppToast({
  toast,
  onClose
}: {
  toast: AppToastValue
  onClose(): void
}): React.JSX.Element {
  return (
    <div
      className={`app-toast${toast.tone === 'danger' ? ' is-danger' : ''}`}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
    >
      <span>{toast.message}</span>
      {toast.action && <button className="app-toast-action" type="button" onClick={() => { onClose(); toast.action?.onSelect() }}>{toast.action.label}</button>}
      <button className="icon-button" type="button" aria-label={uiAttribute("关闭提示")} onClick={onClose}>×</button>
    </div>
  )
}
