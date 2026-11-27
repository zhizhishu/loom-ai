import { useEffect, useId, useRef, useState } from 'react'
import type { PiModelProviderSettings } from '@contracts'
import { useThreadClient, type ThreadClient } from './camp-client'
import { readErrorMessage } from './error-message'
import { UiText, uiAttribute } from './interface-language'

export type PiModelProviderDraft = {
  baseUrl: string
  modelId: string
  /** Empty keeps the key already stored in the shared runtime environment. */
  apiKey: string
  keyRevision: number
}

/**
 * Saves the one Pi provider section with its shared environment key, then asks the existing
 * runtime check to revalidate Pi. The key never comes back: only its name and last four
 * characters are read, so this form cannot show or re-send a stored key.
 */
export async function savePiModelProvider(client: Pick<ThreadClient, 'request'>, draft: PiModelProviderDraft): Promise<PiModelProviderSettings> {
  const baseUrl = draft.baseUrl.trim(), modelId = draft.modelId.trim(), apiKey = draft.apiKey.trim()
  if (!baseUrl) throw new Error(uiAttribute('请填写网关地址。'))
  if (!modelId) throw new Error(uiAttribute('请填写模型 ID。'))
  const saved = await client.request<PiModelProviderSettings>('pi.modelProvider.save', {
    baseUrl, modelId, keyRevision: draft.keyRevision, ...(apiKey ? { apiKey } : {})
  })
  await client.request('runtime.product.check', { runtimeKind: 'pi' })
  return saved
}

export function PiModelProviderSection({ disabled }: { disabled: boolean }): React.JSX.Element {
  const client = useThreadClient()
  const id = useId()
  const [saved, setSaved] = useState<PiModelProviderSettings | null>(null)
  const [baseUrl, setBaseUrl] = useState(''), [modelId, setModelId] = useState(''), [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'load' | 'save' | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const sequence = useRef(0)
  const state = useRef({ saved, baseUrl, modelId, apiKey, busy })
  state.current = { saved, baseUrl, modelId, apiKey, busy }
  const accept = (next: PiModelProviderSettings): void => {
    setSaved(next); setBaseUrl(next.baseUrl); setModelId(next.modelId); setApiKey(''); setError(null)
  }

  useEffect(() => {
    let active = true
    const request = ++sequence.current
    setBusy('load'); setError(null)
    void client.request<PiModelProviderSettings>('pi.modelProvider.get', {}).then((next) => {
      if (active && sequence.current === request) accept(next)
    }).catch((nextError) => {
      if (active && sequence.current === request) setError(readErrorMessage(nextError))
    }).finally(() => {
      if (active && sequence.current === request) setBusy(null)
    })
    return () => { active = false }
  }, [client])

  const save = async (): Promise<void> => {
    const current = state.current
    if (current.busy || !current.saved) return
    const request = ++sequence.current
    setBusy('save'); setCompleted(false); setError(null)
    try {
      const next = await savePiModelProvider(client, {
        baseUrl: current.baseUrl, modelId: current.modelId, apiKey: current.apiKey, keyRevision: current.saved.keyRevision
      })
      if (sequence.current === request) { accept(next); setCompleted(true) }
    } catch (nextError) {
      if (sequence.current === request) setError(readErrorMessage(nextError))
    } finally {
      if (sequence.current === request) setBusy(null)
    }
  }

  const locked = disabled || busy !== null
  const hint = saved?.keyConfigured
    ? saved.keyLast4 ? uiAttribute('已保存 Key（末尾 {0}）；留空表示不修改。', saved.keyLast4) : uiAttribute('已保存 Key；留空表示不修改。')
    : uiAttribute('Key 只以环境变量引用写入 models.json，明文保存在本机加密存储中。')
  return <section className="runtime-startup-section">
    <div className="runtime-startup-section-heading"><label htmlFor={`${id}-base-url`}><UiText zh={"Pi 连接"}/></label></div>
    <div className="runtime-startup-path">
      <input id={`${id}-base-url`} value={baseUrl} disabled={locked} spellCheck={false} autoComplete="off"
        aria-label={uiAttribute('网关地址')} placeholder="https://gateway.example/v1" onChange={(event) => { setCompleted(false); setBaseUrl(event.target.value) }}/>
    </div>
    <div className="runtime-startup-path">
      <input id={`${id}-model`} value={modelId} disabled={locked} spellCheck={false} autoComplete="off"
        aria-label={uiAttribute('模型 ID')} placeholder={uiAttribute('模型 ID')} onChange={(event) => { setCompleted(false); setModelId(event.target.value) }}/>
    </div>
    <div className="runtime-startup-path">
      <input id={`${id}-key`} type="password" value={apiKey} disabled={locked} spellCheck={false} autoComplete="off"
        aria-label={uiAttribute('Key')} placeholder={uiAttribute('Key')} onChange={(event) => { setCompleted(false); setApiKey(event.target.value) }}/>
    </div>
    <p className="common-environment-hint">{hint}</p>
    <div className="runtime-startup-inspection">
      <span role="status" className="runtime-startup-result">{completed ? <UiText zh={"已保存"}/> : saved?.apiKeyEnv ?? ''}</span>
      <button className="quiet-button" type="button" disabled={locked || !saved} onClick={() => void save()}>{busy === 'save' ? uiAttribute('正在保存…') : uiAttribute('保存连接')}</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}
