import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile } from './types'
import type { ThreadClient } from '../camp-client'
import {
  conflictTools, highRiskToConfirm, hookDefinitionMissing, hookReviewSnapshot, itemKey, matchesQuery,
  pendingHookReview, sameSelection, selectRefusal, selectionCounts, selectionsOf,
  toggleWouldConflict, type CapabilityCatalog, type CapabilityItem, type CapabilityKind,
  type HookReviewSnapshot, type SelectionRefusal
} from '../member-catalog-model'
import { createCapabilityPort } from './capability-service'
import { FormMessage, SurfaceDialog } from './Controls'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'
import { Icon, type IconName } from './icons'
import { HookScopeSummary } from './HookScopeSummary'

const categories: { kind: CapabilityKind; label: string; icon: IconName; help: string }[] = [
  { kind: 'skill', label: 'Skills', icon: 'bulb', help: '选择这个助手可以按需使用的工作方法。' },
  { kind: 'mcp', label: 'MCP', icon: 'globe', help: '选择工具连接。账号授权和连接状态独立管理。' },
  { kind: 'rule', label: '规则', icon: 'file', help: '让助手遵守项目约定，不替代系统权限。' },
  { kind: 'hook', label: 'Hooks', icon: 'branch', help: '在运行的特定时机执行；启用前确认内容和范围。' }
]

const HOOK_SCOPE_MESSAGE = '当前运行范围没有可审阅的 Hook 定义，暂不能启用'

/** 本地拒绝的文案。原因不同，说法就不同，不自称“永不支持”。 */
export function refusalMessage(refusal: SelectionRefusal): string {
  if (refusal === 'source') return '这个能力的来源当前不可用，请先重新读取。'
  if (refusal === 'hook-scope') return HOOK_SCOPE_MESSAGE
  return ''
}

/** 一行 hook 在列表里的真实状态：缺定义时只说明现在不能启用，不宣布永久不支持。 */
export function hookScopeHint(item: Pick<CapabilityItem, 'kind' | 'hookDefinition' | 'selected'>): string {
  if (item.kind !== 'hook' || !hookDefinitionMissing(item)) return ''
  return item.selected
    ? '当前运行范围没有可执行的 Hook 配置；可取消选择'
    : HOOK_SCOPE_MESSAGE
}

/**
 * 一行能力。开关和行文用同一道门禁：只有 off → on 会被拦，已勾上的永远能取消。
 */
export function CapabilityRow({ item, icon, saving, refusal, onToggle }: {
  item: CapabilityItem; icon: IconName; saving: boolean; refusal: SelectionRefusal; onToggle(): void
}) {
  const hint = hookScopeHint(item)
  const blocked = refusal !== ''
  return <article className="ln-cap-item" data-capability-kind={item.kind}>
    <div className="ln-cap-main"><span className="ln-cap-item-icon"><Icon name={icon} size={17}/></span>
      <div className="ln-cap-copy"><strong>{item.name}</strong>{item.note && <p>{item.note}</p>}<p className="ln-cap-source">{item.source}{item.origin === 'inherited' ? ' · 继承' : ''}{item.risk === 'high' ? ' · 需要授权' : ''}</p></div>
      <button type="button" className="ln-toggle" role="switch" aria-checked={item.selected} aria-label={`${item.selected ? '关闭' : '启用'} ${item.name}`}
        disabled={saving || blocked} title={blocked ? refusalMessage(refusal) : undefined} onClick={onToggle}><i/></button>
    </div>
    {item.sourceError && <div className="ln-cap-detail">来源不可用，仍可关闭已有选择。</div>}
    {hint && <div className="ln-cap-detail">{hint}</div>}
    {item.hookDefinition && <details className="ln-cap-detail"><summary>查看 Hook 正文和范围</summary><HookScopeSummary scope={item.hookDefinition.reviewScope}/><pre>{item.hookDefinition.body}</pre></details>}
  </article>
}

export function CapabilityPanel({ client, agent, threadId, theme = 'day', compact = false, onDirtyChange, onSaved, onLibrary }: {
  client: ThreadClient; agent: AgentProfile; threadId?: string; theme?: 'day' | 'night'; compact?: boolean
  onDirtyChange?(dirty: boolean): void; onSaved?(): void; onLibrary?(): void
}) {
  const port = useMemo(() => createCapabilityPort(client,threadId), [client,threadId])
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null)
  const [items, setItems] = useState<CapabilityItem[]>([])
  const [kind, setKind] = useState<CapabilityKind>('skill')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [review, setReview] = useState<HookReviewSnapshot | null>(null)
  const [preview, setPreview] = useState<'idle' | 'reading' | 'ready' | 'unsupported' | 'error'>('idle')
  const generation = useRef(0)
  const callbacks = useRef({ onDirtyChange, onSaved })
  callbacks.current = { onDirtyChange, onSaved }
  const dirty = !!catalog && !sameSelection(catalog.items, items)
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty) }, [dirty])
  const load = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true); setSaving(false); setError(''); setReview(null); setSaved(false); setPreview('idle')
    try {
      const next = await port.read(agent.agentId)
      if (ticket !== generation.current) return
      setCatalog(next); setItems(next.items)
    } catch (cause) {
      if (ticket === generation.current) { setError(cause instanceof Error ? cause.message : '能力暂时读取失败。'); setCatalog(null) }
    } finally { if (ticket === generation.current) setLoading(false) }
  }, [agent.agentId, port])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  const toggle = (item: CapabilityItem) => {
    if (saving) return
    setSaved(false); setError(''); setPreview('idle')
    const refusal = selectRefusal(item)
    if (refusal) { setError(refusalMessage(refusal)); return }
    if (toggleWouldConflict(items, item.kind, item.id)) { setError('这个能力与已选择的工具名称冲突，请先关闭冲突项。'); return }
    setItems(current => current.map(row => itemKey(row) === itemKey(item) ? { ...row, selected: !row.selected } : row))
  }
  const submit = async (snapshot?: HookReviewSnapshot) => {
    if (!catalog || saving) return
    if (snapshot && (snapshot.token !== generation.current || snapshot.agentId !== agent.agentId || snapshot.revision !== catalog.revision)) {
      setReview(null); setError('助手或运行范围已改变，请重新读取后审阅。'); return
    }
    const ticket = generation.current
    setSaving(true); setError('')
    try {
      const next = await port.save(catalog, items, snapshot)
      if (ticket !== generation.current) return
      setCatalog(next); setItems(next.items); setReview(null); setSaved(true); setPreview('idle')
      callbacks.current.onSaved?.()
    } catch (cause) {
      if (ticket === generation.current) setError(cause instanceof Error ? cause.message : '保存未完成，修改仍保留。')
    } finally { if (ticket === generation.current) setSaving(false) }
  }
  const requestSave = () => {
    if (!catalog || saving) return
    if (conflictTools(items).length) { setError('请先解决已选能力之间的工具冲突。'); return }
    const risky = highRiskToConfirm(items, catalog.items)
    const hooks = pendingHookReview(items)
    if (!risky.length && !hooks.length) { void submit(); return }
    const snapshot = hookReviewSnapshot({ agentId: agent.agentId, revision: catalog.revision, token: generation.current,
      acknowledgeHighRisk: risky.length > 0, selections: selectionsOf(items), pending: hooks })
    if (!snapshot) { setError('无法读取 Hook 的确切正文，不能批准。'); return }
    setReview(snapshot)
  }
  const inspectNextRun = async () => {
    if (!catalog || dirty) return
    const ticket = generation.current
    setPreview('reading')
    const result = await port.preview(agent.agentId, catalog.runtime)
    if (ticket !== generation.current) return
    setPreview(result.status)
  }
  // Internal collaboration tooling is not a user-selectable work skill. Keep
  // its exact persisted selections in `items` for save/permission comparisons,
  // but do not expose or count the old platform toolbox in the product surface.
  const userItems = items.filter(item => !(item.kind === 'skill' && item.source === '工具箱'))
  const counts = selectionCounts(userItems)
  const category = categories.find(entry => entry.kind === kind)!
  const rows = userItems.filter(item => item.kind === kind && matchesQuery(item, query))
  const total = counts.skill + counts.mcp + counts.rule + counts.hook
  return <section className={`ln-capability-panel ${compact ? 'is-compact' : ''}`} aria-label={`${agent.displayName}的能力`}>
    <nav className="ln-segment-tabs" aria-label="能力分类">{categories.map(entry => <button type="button" key={entry.kind}
      className={kind === entry.kind ? 'is-selected' : ''} aria-pressed={kind === entry.kind} onClick={() => setKind(entry.kind)}>
      {entry.label}<span className="ln-cap-count">{catalog ? counts[entry.kind] : '—'}</span>
    </button>)}</nav>
    <div className="ln-panel-title"><small>{category.help}</small>{onLibrary && <button type="button" className="ln-icon-button" aria-label="添加能力" onClick={onLibrary}><Icon name="plus" size={17}/></button>}</div>
    <label className="ln-cap-search"><Icon name="search" size={14}/><input placeholder="搜索名称或来源…" aria-label="搜索能力" value={query} onChange={event => setQuery(event.target.value)}/></label>
    {loading ? <p className="ln-inspector-empty" role="status">正在读取能力…</p> : !catalog ? <><FormMessage error>{error || '能力读取失败。'}</FormMessage><button type="button" className="ln-action" onClick={() => { void load() }}>重新读取</button></> : <>
      {error && <FormMessage error>{error}</FormMessage>}
      <div className="ln-cap-list">{rows.map(item => {
        // 同一道门禁：新启用时才拦，已勾上的仍可取消。
        const refusal = selectRefusal(item)
        return <CapabilityRow key={itemKey(item)} item={item} icon={category.icon} saving={saving}
          refusal={refusal} onToggle={() => toggle(item)}/>
      })}</div>
      {!rows.length && <Empty className="ln-empty--inline"><EmptyHeader><EmptyMedia variant="icon"><Icon name={category.icon} size={18}/></EmptyMedia><EmptyTitle>{query ? '没有匹配的能力' : kind === 'skill' ? '尚未添加 Skills' : kind === 'mcp' ? '尚未配置工具连接' : kind === 'rule' ? '尚未添加规则' : '尚未添加 Hooks'}</EmptyTitle><EmptyDescription>{query ? '换一个关键词，或清除搜索查看全部能力。' : category.help}</EmptyDescription></EmptyHeader><EmptyContent>{query ? <button type="button" className="ln-action" onClick={() => setQuery('')}>清除搜索</button> : onLibrary ? <button type="button" className="ln-action" onClick={onLibrary}>打开能力库</button> : null}</EmptyContent></Empty>}
      <div className={`ln-cap-state ${saved && !dirty ? 'is-saved' : ''}`}><Icon name={dirty ? 'clock' : 'check'} size={13}/><span>{dirty ? '修改尚未保存' : saved ? '已保存，下次运行采用新选择' : `已选 ${total} 项`}</span></div>
      {preview === 'ready' && <FormMessage>已生成下次运行的配置。</FormMessage>}
      {preview === 'unsupported' && <FormMessage>当前运行端不支持配置预览，已保存的选择会保留。</FormMessage>}
      {preview === 'error' && <FormMessage error>运行配置预览失败，已保存的选择不受影响。</FormMessage>}
      <footer className="ln-form-actions"><button type="button" className="ln-action" disabled={saving || dirty || preview === 'reading'} onClick={() => { void inspectNextRun() }}>{preview === 'reading' ? '检查中…' : '检查下次配置'}</button>
        <button type="button" className="ln-action is-primary" disabled={!dirty || saving} onClick={requestSave}>{saving ? '保存中…' : '保存选择'}</button></footer>
    </>}
    <SurfaceDialog open={review !== null} title="确认这次能力授权" description="只适用于列出的内容和运行范围，不授予整机或其他助手的权限。" theme={theme} onClose={() => { if (!saving) setReview(null) }} className="ln-room-dialog">
      <div className="ln-room-content">{review && <>
        {highRiskToConfirm(items, catalog?.items ?? []).map(item => <div className="ln-review-card" key={itemKey(item)}><h3>{item.name}</h3><p>{item.note || '此能力可能执行命令或修改外部资源。'}</p></div>)}
        {review.entries.map(entry => <div className="ln-review-card" key={entry.id}><h3>{entry.name}</h3><HookScopeSummary scope={entry.scope}/><pre>{entry.body}</pre></div>)}
        {error && <FormMessage error>{error}</FormMessage>}
        <footer className="ln-form-actions"><button type="button" className="ln-action" disabled={saving} onClick={() => setReview(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={saving} onClick={() => { void submit(review) }}>{saving ? '保存中…' : '确认范围并保存'}</button></footer>
      </>}</div>
    </SurfaceDialog>
  </section>
}
