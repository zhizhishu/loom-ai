import { DialogControlIcon } from './AppDialog'
import { UiText, uiAttribute } from './interface-language'

export interface MemoryContentDraft {
  body: string
  retrievalKeys: string
  keyInput: string
}

export function splitRetrievalKeys(value: string): string[] {
  return value.split(/[,，\n]/).map((key) => key.trim()).filter(Boolean)
}

export function validateMemoryContent(draft: MemoryContentDraft): {
  keys: string[]
  bodyBytes: number
  keysError: string | null
  valid: boolean
} {
  const bytes = (value: string): number => new TextEncoder().encode(value).length
  const keys = splitRetrievalKeys([draft.retrievalKeys, draft.keyInput].join(','))
  const bodyBytes = bytes(draft.body)
  const keysValid = keys.length >= 1 && keys.length <= 3
    && keys.every((key) => bytes(key) >= 2 && bytes(key) <= 24)
    && keys.reduce((total, key) => total + bytes(key), 0) <= 48
    && new Set(keys).size === keys.length
  return {
    keys,
    bodyBytes,
    keysError: !keysValid && keys.length > 0
      ? uiAttribute('请保留 1–3 个不重复的检索词，每项 2–24 字节，合计不超过 48 字节。')
      : null,
    valid: Boolean(draft.body.trim()) && bodyBytes <= 2048 && keysValid
  }
}

/** The same content limits and chip keyboard behavior apply to edits and review. */
export function MemoryContentFields({ draft, disabled, onChange, idPrefix = 'memory', autoFocus = true }: {
  draft: MemoryContentDraft
  disabled: boolean
  onChange(value: MemoryContentDraft): void
  idPrefix?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const { keys, bodyBytes, keysError } = validateMemoryContent(draft)
  const committedKeys = splitRetrievalKeys(draft.retrievalKeys)
  const bodyId = `${idPrefix}-body-input`
  const keyId = `${idPrefix}-key-input`
  const errorId = `${idPrefix}-keys-error`
  const commitKeys = (): void => onChange({ ...draft, retrievalKeys: keys.join(', '), keyInput: '' })
  return <>
    <label className="field-label memory-body-field" htmlFor={bodyId}>
      <span><UiText zh="正文" />{bodyBytes > 1800 && <small>{bodyBytes}/2048 bytes</small>}</span>
      <textarea id={bodyId} aria-label={uiAttribute('记忆正文')} aria-invalid={bodyBytes > 2048 || undefined}
        autoFocus={autoFocus} data-dialog-autofocus={autoFocus || undefined}
        value={draft.body} rows={7} disabled={disabled} onChange={(event) => onChange({ ...draft, body: event.target.value })} />
      {bodyBytes > 2048 && <small className="memory-field-error" role="alert"><UiText zh="正文过长，请精简到 2,048 字节以内。" /></small>}
    </label>
    <div className="field-label memory-body-field">
      <label htmlFor={keyId}><UiText zh="检索词" /></label>
      <div className="memory-key-editor">
        {committedKeys.map((key, index) => <span key={index}>{key}<button type="button" disabled={disabled}
          aria-label={uiAttribute('移除检索词 {0}', key)}
          onClick={() => onChange({ ...draft, retrievalKeys: committedKeys.filter((_, keyIndex) => keyIndex !== index).join(', ') })}>
          <DialogControlIcon name="close" />
        </button></span>)}
        <input id={keyId} value={draft.keyInput} disabled={disabled}
          placeholder={committedKeys.length ? '' : uiAttribute('输入后按回车添加')}
          aria-invalid={Boolean(keysError) || undefined} aria-describedby={keysError ? errorId : undefined}
          onChange={(event) => onChange({ ...draft, keyInput: event.target.value })}
          onKeyDown={(event) => {
            if (!event.nativeEvent.isComposing && ['Enter', ',', '，'].includes(event.key)) {
              event.preventDefault()
              commitKeys()
            }
          }}
          onBlur={() => { if (draft.keyInput.trim()) commitKeys() }} />
      </div>
      {keysError && <small id={errorId} className="memory-field-error" role="alert">{keysError}</small>}
    </div>
  </>
}
