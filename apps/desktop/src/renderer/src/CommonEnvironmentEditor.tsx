import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { AdapterKind } from '@contracts'
import { useThreadClient } from './camp-client'
import { uiAttribute as t, useInterfaceLanguage } from './interface-language'
import { readErrorMessage } from './error-message'
import { COMMON_ENVIRONMENT_CHANGED, ENVIRONMENT_PLACEHOLDER, environmentText, parseMemberEnvironment, type EnvironmentSnapshot } from './member-environment'
import './member-environment.css'

export function EnvironmentJson({ value, onChange, id, label, disabled, readOnly = false, error, placeholder = ENVIRONMENT_PLACEHOLDER }: {
  value: string; onChange(value: string): void; id: string; label: string; disabled: boolean; readOnly?: boolean; error?: string; placeholder?: string
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = (): void => {
      if (!el.clientWidth) return
      el.style.height = 'auto'
      const style = getComputedStyle(el)
      el.style.height = `${el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`
    }
    fit()
    let width = el.clientWidth
    const observer = new ResizeObserver(() => { if (width !== el.clientWidth) { width = el.clientWidth; fit() } })
    observer.observe(el)
    return () => observer.disconnect()
  }, [value])
  return <textarea ref={ref} id={id} className="member-environment-json" value={value} onChange={e => onChange(e.target.value)}
    aria-label={label} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} readOnly={readOnly} disabled={disabled}
    placeholder={placeholder} rows={4} spellCheck={false} autoComplete="off"/>
}

export function useCommonEnvironment(kind: AdapterKind, windows: boolean) {
  const client = useThreadClient()
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot | null>(null)
  const [text, setText] = useState(''), [error, setError] = useState('')
  const sequence = useRef(0)
  let parsed: Record<string,string> = {}, parseError = ''
  try { parsed = parseMemberEnvironment(text, windows, kind, undefined) } catch (e) { parseError = readErrorMessage(e) }
  const accept = (next: EnvironmentSnapshot): void => {
    sequence.current++; setSnapshot(next); setText(environmentText(next.environment)); setError('')
  }
  const edit = (): { expectedRevision: number; json: string } => {
    const problem = parseError
    if (problem || !snapshot) { setError(problem || t('正在读取…')); throw new Error(problem) }
    return { expectedRevision: snapshot.revision, json: JSON.stringify(parsed) }
  }
  return {
    text, error, values: parsed, parseProblem: parseError, loading: snapshot === null, dirty: snapshot !== null && text !== environmentText(snapshot.environment),
    accept, edit, fail: setError,
    async reload() {
      const request = ++sequence.current
      try { const next = await client.request<EnvironmentSnapshot>('runtime.environment.get', { runtimeKind: kind }); if (request === sequence.current) accept(next) }
      catch (e) { if (request === sequence.current) setError(readErrorMessage(e)) }
    },
    update(value: string) { sequence.current++; setText(value); setError('') },
    discard() { if (snapshot) accept(snapshot) },
    saved(next: EnvironmentSnapshot) { accept(next); window.dispatchEvent(new CustomEvent(COMMON_ENVIRONMENT_CHANGED, { detail: kind })) },
  }
}

type EnvironmentField = { id: number; name: string; value: string; visible: boolean }

function EnvironmentFields({ environment: env, disabled, onChange, id }: {
  environment: ReturnType<typeof useCommonEnvironment>; disabled: boolean; onChange(): void; id: string
}): React.JSX.Element {
  const nextId = useRef(0)
  const readFields = (): EnvironmentField[] => Object.entries(env.values).map(([name, value]) => ({ id: nextId.current++, name, value, visible: false }))
  const [rows, setRows] = useState<EnvironmentField[]>(readFields)
  const [advanced, setAdvanced] = useState(Boolean(env.parseProblem))
  const written = useRef(env.text)
  useLayoutEffect(() => {
    if (written.current === env.text) return
    written.current = env.text
    if (env.parseProblem) { setAdvanced(true); return }
    setRows(readFields())
  }, [env.text])

  const update = (next: EnvironmentField[]): void => {
    setRows(next)
    // Keep duplicate and incomplete names in the draft. The existing parser
    // rejects them on save instead of Object.fromEntries silently dropping one.
    const value = next.length ? `{\n${next.map(row => `  ${JSON.stringify(row.name)}: ${JSON.stringify(row.value)}`).join(',\n')}\n}` : ''
    written.current = value
    env.update(value)
    onChange()
  }
  const edit = (rowId: number, patch: Partial<Pick<EnvironmentField, 'name' | 'value'>>): void => {
    update(rows.map(row => row.id === rowId ? { ...row, ...patch } : row))
  }
  const showFields = (): void => {
    if (env.parseProblem) { env.fail(env.parseProblem); return }
    setRows(readFields())
    setAdvanced(false)
  }
  return <div className="common-environment-fields">
    <p className="common-environment-hint">{t('按服务提供的名称填写密钥、地址等设置。保存后从下次运行开始使用。')}</p>
    {advanced ? <EnvironmentJson id={id} value={env.text} onChange={value => { written.current = value; env.update(value); onChange() }} disabled={disabled} error={env.error} label={t('通用环境变量 JSON')}/> : <div className="common-environment-rows">
      {rows.map((row, index) => <div className="common-environment-row" key={row.id}>
        <label className="common-environment-name"><span>{t('设置名称')}</span><input id={index === 0 ? id : `${id}-${row.id}-name`} aria-label={t('设置名称 {0}', String(index + 1))} value={row.name} disabled={disabled} spellCheck={false} autoComplete="off" placeholder="OPENAI_API_KEY" onChange={event => edit(row.id, { name: event.target.value })}/></label>
        <label className="common-environment-value"><span>{t('设置值')}</span><span className="common-environment-value-input"><input aria-label={t('设置值 {0}', String(index + 1))} type={row.visible ? 'text' : 'password'} value={row.value} disabled={disabled} spellCheck={false} autoComplete="off" onChange={event => edit(row.id, { value: event.target.value })}/><button className="quiet-button" type="button" disabled={disabled} aria-label={t(row.visible ? '隐藏设置值 {0}' : '显示设置值 {0}', String(index + 1))} onClick={() => setRows(current => current.map(item => item.id === row.id ? { ...item, visible: !item.visible } : item))}>{t(row.visible ? '隐藏' : '显示')}</button></span></label>
        <button className="quiet-button common-environment-remove" type="button" disabled={disabled} aria-label={t('删除设置 {0}', String(index + 1))} onClick={() => update(rows.filter(item => item.id !== row.id))}>{t('删除')}</button>
      </div>)}
      {!rows.length && <p className="common-environment-empty">{t('尚未添加连接信息。')}</p>}
    </div>}
    <div className="common-environment-field-actions">
      {!advanced && <button className="quiet-button" type="button" disabled={disabled} onClick={() => update([...rows, { id: nextId.current++, name: '', value: '', visible: false }])}>{t('添加设置')}</button>}
      <button className="quiet-button" type="button" disabled={disabled} onClick={() => advanced ? showFields() : setAdvanced(true)}>{t(advanced ? '返回输入框' : '高级编辑（显示原文）')}</button>
    </div>
  </div>
}

export function CommonEnvironmentEditor({ environment: env, disabled, onChange, fields = false }: {
  environment: ReturnType<typeof useCommonEnvironment>; disabled: boolean; onChange(): void; fields?: boolean
}): React.JSX.Element {
  useInterfaceLanguage()
  const id = useId(), [help, setHelp] = useState(false)
  return <section className="runtime-startup-section common-environment-section">
    <div className="runtime-startup-section-heading"><div className="common-environment-heading">
      <label htmlFor={id}>{t(fields ? '连接信息' : '通用环境变量')}</label>
      <button className="common-environment-help" type="button" aria-label={t('通用环境变量说明')} aria-describedby={help ? `${id}-help` : undefined}
        onMouseEnter={() => setHelp(true)} onMouseLeave={e => { if (document.activeElement !== e.currentTarget) setHelp(false) }} onFocus={() => setHelp(true)} onBlur={() => setHelp(false)} onClick={() => setHelp(true)}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setHelp(false) } }}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M7.8 7.2a2.2 2.2 0 0 1 4.4.2c0 1.6-2.2 1.8-2.2 3.3M10 13.7v.1"/></svg>
      </button>
      {help && <span id={`${id}-help`} role="tooltip" className="common-environment-tooltip">{t(fields ? '使用这个运行端的助手会共用这些连接设置。' : '用于在不同队员之间共享一些配置变量。')}</span>}
    </div></div>
    {fields ? <EnvironmentFields id={id} environment={env} onChange={onChange} disabled={disabled || env.loading}/> : <EnvironmentJson id={id} value={env.text} onChange={value => { env.update(value); onChange() }} disabled={disabled || env.loading} error={env.error} label={t('通用环境变量 JSON')}/>}
    {env.error && <p id={`${id}-error`} className="environment-error" role="alert">{env.error}<button type="button" className="quiet-button" disabled={disabled} onClick={() => { onChange(); void env.reload() }}>{t('重新读取')}</button></p>}
  </section>
}
