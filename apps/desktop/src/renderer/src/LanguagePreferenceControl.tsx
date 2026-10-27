import { useState } from 'react'
import type { InterfaceLanguagePreference } from '@contracts'
import { refreshInterfaceLanguage, useInterfaceLanguageSnapshot, useUiText } from './interface-language'

export function LanguagePreferenceOptions({ name, className, disabled = false, onChange }: {
  name: string
  className: string
  disabled?: boolean
  onChange(preference: InterfaceLanguagePreference): void
}): React.JSX.Element {
  const snapshot = useInterfaceLanguageSnapshot()
  const t = useUiText()
  return <div className={className} role="radiogroup" aria-label={t('界面语言')}>
    {(['system', 'zh-CN', 'en'] as const).map(preference => <label key={preference} className={snapshot.interfaceLanguagePreference === preference ? 'selected' : ''}>
      <input type="radio" name={name} value={preference} checked={snapshot.interfaceLanguagePreference === preference}
        disabled={disabled || snapshot.readError !== null} onChange={() => onChange(preference)} />
      <span lang={preference === 'system' ? undefined : preference}>{preference === 'system' ? t('跟随系统') : preference === 'zh-CN' ? '简体中文' : 'English'}</span>
    </label>)}
  </div>
}

/** Visible even when Core or authentication is unavailable. */
export function LanguagePreferenceReadNotice(): React.JSX.Element | null {
  const snapshot = useInterfaceLanguageSnapshot()
  const t = useUiText()
  const [busy, setBusy] = useState(false)
  if (!snapshot.readError) return null
  return <aside className="language-preference-notice" role="alert">
    <span>{t('语言偏好暂时无法读取，原记录已保留。')}</span>
    <button type="button" className="quiet-button compact" disabled={busy} onClick={() => {
      setBusy(true)
      void refreshInterfaceLanguage().finally(() => setBusy(false))
    }}>{t('重新读取')}</button>
  </aside>
}
