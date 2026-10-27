import { useId } from 'react'
import type { AutomationThreadNaming } from '@contracts'
import { AutomationGlyph } from './AutomationControls'
import { automationTitlePreview } from './automation-thread-naming'
import { UiText, uiAttribute } from './interface-language'
import './automation-naming.css'

export function AutomationNamingControls({ name, prompt, value, disabled, onChange }: {
  name: string
  prompt: string
  value: AutomationThreadNaming
  disabled: boolean
  onChange(value: AutomationThreadNaming): void
}): React.JSX.Element {
  const id = useId()
  const hasTimestamp = value.includeDate || value.includeTime
  const summary = value.includeDate ? value.includeTime ? uiAttribute('日期和时间') : uiAttribute('仅日期') : value.includeTime ? uiAttribute('仅时间') : uiAttribute('任务名称')
  const preview = automationTitlePreview(name || (!prompt.trim() ? uiAttribute('定时任务名称') : ''), prompt, value, new Date())
  return <details className="automation-channel-disclosure automation-naming">
    <summary><span className="automation-channel-symbol"><AutomationGlyph name="text" /></span><span><strong><UiText zh="对话命名" /></strong></span><span className="automation-channel-count">{summary}</span><AutomationGlyph name="chevron" /></summary>
    <div className="automation-naming-panel">
      <fieldset className="automation-naming-row" disabled={disabled}>
        <legend><UiText zh="添加内容" /></legend>
        <div className="automation-naming-options">
          <label><input type="checkbox" checked={value.includeDate} onChange={(event) => onChange({ ...value, includeDate: event.target.checked })} /><UiText zh="日期" /></label>
          <label><input type="checkbox" checked={value.includeTime} onChange={(event) => onChange({ ...value, includeTime: event.target.checked })} /><UiText zh="时间" /></label>
        </div>
      </fieldset>
      <fieldset className="automation-naming-row automation-naming-position" disabled={disabled || !hasTimestamp}>
        <legend><UiText zh="显示位置" /></legend>
        <div className="automation-naming-segments">{(['prefix', 'suffix'] as const).map((position) => <label key={position}>
          <input type="radio" name={`${id}-position`} value={position} checked={value.position === position} onChange={() => onChange({ ...value, position })} /><span>{position === 'prefix' ? uiAttribute('名称前') : uiAttribute('名称后')}</span>
        </label>)}</div>
      </fieldset>
      <div className="automation-naming-preview"><span id={`${id}-preview`}><UiText zh="标题预览" /></span><output aria-labelledby={`${id}-preview`} aria-live="polite">{preview}</output></div>
    </div>
  </details>
}
