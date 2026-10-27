import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AdapterKind, ModelSelection } from '@contracts'
import { useThreadClient } from './camp-client'
import { DialogControlIcon } from './AppDialog'
import { uiAttribute as t, useInterfaceLanguage } from './interface-language'
import { readErrorMessage } from './error-message'
import { ENVIRONMENT_PLACEHOLDER, environmentText, parseMemberEnvironment, type MemberEnvironmentEdit, type MemberEnvironmentSnapshot } from './member-environment'
import { EnvironmentJson } from './CommonEnvironmentEditor'
import { COMMON_ENVIRONMENT_CHANGED, mergeEnvironment, type EnvironmentSnapshot } from './member-environment'
import './member-environment.css'

type Draft = { snapshot: MemberEnvironmentSnapshot; text: string; error: string; loading: boolean; inherit: boolean }
const empty = (): Draft => ({ snapshot: { revision: 0, environment: {} }, text: '', error: '', loading: true, inherit: true })

export function useMemberEnvironment(memberId: string, kind: AdapterKind | '', memberVersion: number, model: ModelSelection | undefined, windows: boolean, active = true) {
  const client = useThreadClient()
  const key = `${memberId}:${kind}`
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const current = drafts[key] ?? empty()
  const sequence = useRef(0)
  const savedReadKey = useRef<string | null>(null)
  const patch = useCallback((change: Partial<Draft>): void => setDrafts(all => ({ ...all, [key]: { ...(all[key] ?? empty()), ...change } })), [key])
  const load = useCallback(async (force = false): Promise<void> => {
    if (!kind) return
    const request = ++sequence.current
    try {
      const snapshot = await client.request<MemberEnvironmentSnapshot>('member.runtimeEnvironment.get', { memberId, adapterKind: kind })
      if (request !== sequence.current) return
      // A profile-version refresh may supersede the read started by Save. It must
      // still accept that saved revision instead of treating our own write as a conflict.
      const saved = savedReadKey.current === key
      if (saved) savedReadKey.current = null
      setDrafts(all => {
        const previous = all[key]
        if ((previous?.snapshot.common?.revision ?? -1) > (snapshot.common?.revision ?? -1)) snapshot.common = previous?.snapshot.common
        if (!force && !saved && previous && (previous.text !== environmentText(previous.snapshot.environment) || previous.inherit !== (previous.snapshot.inheritCommon ?? true))) {
          return { ...all, [key]: { ...previous, loading: false, error: snapshot.revision !== previous.snapshot.revision ? t('运行环境已在其他位置更新，请重新读取。') : previous.error } }
        }
        return { ...all, [key]: { ...empty(), snapshot, text: environmentText(snapshot.environment), loading: false, inherit: snapshot.inheritCommon ?? true } }
      })
    } catch (error) { if (request === sequence.current) patch({ error: readErrorMessage(error), loading: true }) }
  }, [client, key, kind, memberId, patch])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, memberVersion])
  useEffect(() => {
    if (!kind || !active) return
    let cancelled = false
    const refresh = (): void => {
      void client.request<EnvironmentSnapshot>('runtime.environment.get', { runtimeKind: kind }).then(common => {
        if (!cancelled) setDrafts(all => !all[key] || (all[key].snapshot.common?.revision ?? -1) > common.revision ? all : ({ ...all, [key]: { ...all[key], snapshot: { ...all[key].snapshot, common } } }))
      }).catch(() => { /* The member read/save remains authoritative; don't replace a usable draft. */ })
    }
    const changed = (event: Event): void => { if ((event as CustomEvent).detail === kind) refresh() }
    refresh()
    window.addEventListener(COMMON_ENVIRONMENT_CHANGED, changed)
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.removeEventListener(COMMON_ENVIRONMENT_CHANGED, changed); window.removeEventListener('focus', refresh) }
  }, [client, kind, key, active])
  const common = current.snapshot.common ?? { revision: 0, environment: {} }
  let parsed: Record<string, string> = {}, parseError = ''
  try {
    parsed = parseMemberEnvironment(current.text, windows, kind, model)
    parseMemberEnvironment(JSON.stringify(mergeEnvironment(common.environment, parsed, current.inherit)), windows, kind, model)
  } catch (error) { parseError = readErrorMessage(error) }
  const dirty = current.text !== environmentText(current.snapshot.environment) || current.inherit !== (current.snapshot.inheritCommon ?? true)
  return {
    ...current, dirty, kind, memberId, common, parsed, parseError,
    setInherit(inherit: boolean) { patch({ inherit, error: '' }) },
    count: Object.keys(current.snapshot.environment).length,
    update(text: string) { patch({ text, error: '' }) },
    reset() { setDrafts({}); void load(true) },
    async savedSuccessfully() { savedReadKey.current = key; await load(true) },
    edit(): MemberEnvironmentEdit | undefined {
      if (parseError) { patch({ error: parseError }); throw new Error(parseError) }
      if (!dirty) return undefined
      return { expectedRevision: current.snapshot.revision, json: JSON.stringify(parsed), inheritCommon: current.inherit }
    },
  }
}

export function MemberEnvironmentEditor({ environment: env, disabled, onEditCommon }: {
  environment: ReturnType<typeof useMemberEnvironment>; disabled: boolean; onEditCommon?(): void
}): React.JSX.Element {
  useInterfaceLanguage()
  const id = useId(), [open, setOpen] = useState(false), [preview, setPreview] = useState(false)
  const hasCommon = Object.keys(env.common.environment).length > 0
  const viewing = hasCommon && preview
  const merged = mergeEnvironment(env.common.environment, env.parsed, env.inherit)
  const result = JSON.stringify(merged, null, 2)
  useEffect(() => { setPreview(false) }, [env.memberId, env.kind, hasCommon])
  useEffect(() => { if (env.error) setOpen(true) }, [env.error])
  const togglePreview = (): void => {
    if (viewing) { setPreview(false); return }
    try { env.edit(); setPreview(true) } catch { /* Validation is displayed beside this editor. */ }
  }
  const error = env.error
  return <details className="member-environment-disclosure" open={open} onToggle={event => { setOpen(event.currentTarget.open) }}>
    <summary className="member-environment-entry"><DialogControlIcon name="chevron"/><span>{t('环境变量')}</span></summary>
    <div className="member-environment-body">
      {hasCommon && <div className="environment-inherit-row">
        <label><input type="checkbox" checked={env.inherit} disabled={disabled || env.loading} onChange={e => env.setInherit(e.target.checked)}/><span>{t('继承通用配置')}</span></label>
        {onEditCommon && <button className="quiet-button environment-text-link" type="button" disabled={disabled} onClick={onEditCommon}>{t('编辑通用配置')}<DialogControlIcon name="chevron"/></button>}
      </div>}
      {hasCommon && <div className="environment-own-label"><label htmlFor={id}>{viewing ? t('合并结果（只读）') : env.inherit ? t('队员变量') : t('独立变量')}</label></div>}
      <EnvironmentJson id={id} value={viewing ? result : env.text} onChange={env.update} disabled={disabled || env.loading} readOnly={viewing} error={error}
        label={viewing ? t('合并结果 JSON，只读') : t('环境变量 JSON')} placeholder={ENVIRONMENT_PLACEHOLDER}/>
      {error && <p id={`${id}-error`} className="environment-error" role="alert">{error}{env.loading && <button type="button" className="quiet-button" onClick={env.reset}>{t('重试')}</button>}</p>}
      {hasCommon && <div className="environment-caption environment-member-caption">
        <button className="quiet-button environment-text-link" type="button" disabled={disabled || env.loading} onClick={togglePreview}>{viewing ? t('编辑') : t('查看合并结果')}</button>
      </div>}
    </div>
  </details>
}
