import { useEffect, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useThreadClient } from './camp-client'
import { AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { uiAttribute, useUiText } from './interface-language'
import {
  conflictingKeys,
  conflictTools,
  highRiskToConfirm,
  isCatalogEmpty,
  itemKey,
  matchesQuery,
  previewRuntime,
  sameSelection,
  selectionCounts,
  selectionsOf,
  toggleWouldConflict,
  type CapabilityCatalog,
  type CapabilityItem,
  type CapabilityKind,
  type RunProjectionPreview
} from './member-catalog-model'
import './member-catalog.css'

const GROUPS: readonly CapabilityKind[] = ['skill', 'mcp', 'rule', 'hook']

function groupCopy(kind: CapabilityKind, t: (text: string, ...values: Array<string | number>) => string): { title: string, hint: string, empty: string } {
  if (kind === 'skill') return {
    title: t('技能'),
    hint: t('工具箱五项。设置里的工具箱仍是勾上即存。这一页等保存才写回。'),
    empty: t('五项都在。这个队员还没有勾选。')
  }
  if (kind === 'mcp') return {
    title: t('MCP'),
    hint: t('服务器定义是全局的。这里只决定这个队员用不用。'),
    empty: t('还没有 MCP 服务器。定义仍在设置里的 MCP 页。')
  }
  if (kind === 'rule') return {
    title: t('规则'),
    hint: t('身份里的六段文字不在这里勾选。下面是可复用的规则片段，勾上的才会进入这份投影。'),
    empty: t('还没有可勾选的规则片段。身份里的六段文字仍会随下一次运行包出发。')
  }
  return {
    title: 'hook',
    hint: t('没有条目时就这样写，不放一排永远空着的开关。'),
    empty: t('还没有可勾选的 hook。')
  }
}

type ProjectionState = { status: 'loading' | 'error' | 'ready' | 'unsupported', preview: RunProjectionPreview | null, message: string }

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return ''
}

function CatalogEmpty({ title, detail, action }: { title: string, detail: string, action?: React.ReactNode }): React.JSX.Element {
  return <div className="member-catalog-empty" role="status">
    <span className="member-catalog-empty-mark" aria-hidden="true"><i /><i /><i /></span>
    <h3>{title}</h3>
    <p>{detail}</p>
    {action}
  </div>
}

function originMark(item: CapabilityItem, label: (text: string) => string): ReactNode {
  if (item.origin === 'inherited') return <span className="member-catalog-mark">{label('继承')}</span>
  if (item.origin === 'explicit' && item.selected) return <span className="member-catalog-mark is-explicit">{label('已选')}</span>
  if (item.origin === 'explicit') return <span className="member-catalog-mark">{label('已改')}</span>
  return null
}

export function MemberCatalogBody({
  phase,
  items,
  saved,
  query,
  identity,
  identityOpen,
  notice,
  projection,
  riskNames,
  saving,
  onQuery,
  onToggle,
  onRetry,
  onSave,
  onIdentity,
  onOpenProfile,
  onProjectionRetry,
  onRiskConfirm,
  onRiskCancel
}: {
  phase: 'loading' | 'error' | 'ready'
  items: readonly CapabilityItem[]
  saved: readonly CapabilityItem[]
  query: string
  identity: CapabilityCatalog['identity'] | null
  identityOpen: boolean
  notice: string
  projection: ProjectionState
  riskNames: readonly string[]
  saving: boolean
  onQuery(value: string): void
  onToggle(kind: CapabilityKind, id: string): void
  onRetry(): void
  onSave(): void
  onIdentity(): void
  onOpenProfile(): void
  onProjectionRetry(): void
  onRiskConfirm(): void
  onRiskCancel(): void
}): React.JSX.Element {
  const t = useUiText()
  const conflicts = conflictTools(items)
  const conflicted = conflictingKeys(items)
  const counts = selectionCounts(items)
  const dirty = phase === 'ready' && !sameSelection(items, saved)
  const empty = phase === 'ready' && isCatalogEmpty(items)
  const state = phase === 'loading' ? 'loading' : phase === 'error' ? 'error' : conflicts.length ? 'conflict' : empty ? 'empty' : 'ready'
  return <div className="member-catalog" data-catalog-state={state}>
    <p className="member-catalog-lede">{t('勾选写在这份 Core 上。保存之后，从下一次 Run 的运行包生效。')}</p>
    {phase === 'loading' && <CatalogEmpty title={t('正在读取目录…')} detail={t('技能、MCP、规则片段和 hook 都在这份 Core 上。勾选结果也在这里。')} />}
    {phase === 'error' && <CatalogEmpty
      title={t('目录读取失败')}
      detail={t('勾选状态未知。这一页不把未知画成未选中，避免一次刷新看起来像全部取消。')}
      action={<button className="quiet-button" type="button" onClick={onRetry}>{t('重新读取')}</button>}
    />}
    {phase === 'ready' && <>
      {notice && <p className="member-catalog-banner" role="status">{notice}</p>}
      {conflicts.length > 0 && <p className="member-catalog-banner" role="status">
        <strong>{t('冲突 · {0}。', conflicts.join('、'))}</strong>
        {t('已经同时勾上的条目都标出来。新勾上的一条若会造成冲突，会当场回到原来的勾选。有冲突时不能保存。')}
      </p>}
      <input
        id="catalog-search"
        className="member-catalog-search"
        type="search"
        value={query}
        placeholder={t('搜索名称、来源')}
        aria-label={t('搜索名称、来源')}
        onChange={(event) => onQuery(event.target.value)}
      />
      <div className="member-catalog-layout">
        <div className="member-catalog-groups">
          {GROUPS.map((kind) => {
            const copy = groupCopy(kind, t)
            const rows = items.filter((item) => item.kind === kind && matchesQuery(item, query)).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
            const noneSelected = kind === 'skill' && items.some((item) => item.kind === 'skill') && items.every((item) => item.kind !== 'skill' || !item.selected)
            return <section key={kind} className="member-catalog-group" aria-label={copy.title}>
              <h3>{copy.title}</h3>
              <p className="member-catalog-hint">{copy.hint}</p>
              {kind === 'rule' && identity && <>
                <button className="member-catalog-link" type="button" aria-expanded={identityOpen} onClick={onIdentity}>
                  {identityOpen ? t('收起身份六段') : t('身份六段在队员资料里编辑')}
                </button>
                {identityOpen && <dl className="member-catalog-identity">
                  <dt>{t('显示名')}</dt><dd>{identity.displayName}</dd>
                  <dt>{t('团队角色')}</dt><dd>{identity.teamRole || t('未填写')}</dd>
                  <dt>{t('专业职责')}</dt><dd>{identity.professionalResponsibilities || t('未填写')}</dd>
                  <dt>{t('性格特质')}</dt><dd>{identity.personalityTraits.join('、') || t('未填写')}</dd>
                  <dt>{t('工作准则')}</dt><dd>{identity.workingPrinciples || t('未填写')}</dd>
                  <dt>{t('成长课题')}</dt><dd>{identity.growthTopic || t('未填写')}</dd>
                </dl>}
                <p className="member-catalog-hint">{t('这六段不在这里勾选。它们随下一次运行包出发。')} <button className="member-catalog-link" type="button" onClick={onOpenProfile}>{t('回到资料')}</button></p>
              </>}
              {rows.length === 0 && <p className="member-catalog-hint">{query.trim() ? t('没有匹配的条目。') : copy.empty}</p>}
              {rows.map((item) => {
                const inputId = `catalog-${item.kind}-${item.id}`
                return <label key={itemKey(item)} className={`member-catalog-check${conflicted.has(itemKey(item)) ? ' is-conflict' : ''}`} data-origin={item.origin ?? 'none'} data-kind={item.kind}>
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={item.selected}
                    onChange={() => onToggle(item.kind, item.id)}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    {originMark(item, t)}
                    {item.risk === 'high' && <span className="member-catalog-mark is-warn">{t('高风险')}</span>}
                    {conflicted.has(itemKey(item)) && <span className="member-catalog-mark is-warn">{t('冲突')}</span>}
                    {item.note && <p>{item.note}</p>}
                  </span>
                  <span className="member-catalog-source">{item.source}</span>
                </label>
              })}
              {noneSelected && !query.trim() && <p className="member-catalog-hint">{t('这个队员还没有勾选。')}</p>}
            </section>
          })}
        </div>
        <ProjectionPanel projection={projection} onRetry={onProjectionRetry} />
      </div>
      <footer className="member-catalog-save">
        <p>
          {t('下次运行生效：{0} 项技能，{1} 个 MCP，{2} 条规则，{3} 个 hook', String(counts.skill), String(counts.mcp), String(counts.rule), String(counts.hook))}
          {counts.conflicts > 0 ? ` ${t('· {0} 处冲突', String(counts.conflicts))}` : ''}
        </p>
        <button className="primary-button" type="button" disabled={!dirty || saving || conflicts.length > 0} onClick={onSave}>
          {saving ? t('正在保存…') : t('保存')}
        </button>
      </footer>
    </>}
    <Dialog.Root open={riskNames.length > 0} onOpenChange={(open) => { if (!open) onRiskCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
        <AppDialogContent aria-describedby="catalog-risk-description">
          <AppDialogHeader
            title={t('确认勾选高风险 MCP？')}
            description={t('「{0}」是高风险的。确认之后才会勾上。取消则这次勾选不留下。', riskNames.join('、'))}
            descriptionId="catalog-risk-description"
          />
          <AppDialogFooter>
            <button className="quiet-button" type="button" onClick={onRiskCancel}>{t('取消')}</button>
            <button className="primary-button" type="button" onClick={onRiskConfirm}>{t('确认勾选')}</button>
          </AppDialogFooter>
        </AppDialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  </div>
}

function ProjectionPanel({ projection, onRetry }: { projection: ProjectionState, onRetry(): void }): React.JSX.Element {
  const t = useUiText()
  return <aside className="member-catalog-preview" aria-label={t('运行投影')} data-projection-state={projection.status}>
    <h3>{t('运行投影')}</h3>
    <p>{t('引导和 MCP 是下一次 Run 会拿到的正文。技能与附加技能用的是同一份勾选。规则片段和 hook 列在这份投影里，不改写已经送出的引导。未保存的勾选要等这次保存之后才出现。')}</p>
    {projection.status === 'loading' && <p role="status">{t('正在读取运行投影…')}</p>}
    {projection.status === 'unsupported' && <p role="status">{t('这位队员还没有 Codex 或 Claude Code，还不能预览运行包。')}</p>}
    {projection.status === 'error' && <p className="member-catalog-banner is-error" role="alert">
      {projection.message || t('运行投影读取失败')}
      {' '}
      <button className="quiet-button" type="button" onClick={onRetry}>{t('重新读取')}</button>
    </p>}
    {projection.status === 'ready' && projection.preview && <>
      <section>
        <h3>{t('引导正文')}</h3>
        <pre>{projection.preview.bootstrap}</pre>
      </section>
      <section>
        <h3>{t('技能')}</h3>
        {projection.preview.skills.length === 0
          ? <p>{t('还没有勾选的技能。')}</p>
          : <ul>{projection.preview.skills.map((skill) => <li key={skill.id}>{skill.name} · {skill.origin === 'inherited' ? t('继承') : t('已选')}</li>)}</ul>}
      </section>
      <section>
        <h3>{t('MCP 文件')}</h3>
        <pre>{JSON.stringify(projection.preview.mcp, null, 2)}</pre>
      </section>
      <section>
        <h3>{t('规则片段')}</h3>
        {projection.preview.rules.length === 0
          ? <p>{t('还没有勾选的规则片段。')}</p>
          : <ul>{projection.preview.rules.map((rule) => <li key={rule.id}><strong>{rule.name}</strong> · {rule.origin === 'inherited' ? t('继承') : t('已选')}<p>{rule.body}</p></li>)}</ul>}
      </section>
      <section>
        <h3>hook</h3>
        {projection.preview.hooks.length === 0
          ? <p>{t('还没有勾选的 hook。')}</p>
          : <ul>{projection.preview.hooks.map((hook) => <li key={hook.id}><strong>{hook.name}</strong> · {hook.origin === 'inherited' ? t('继承') : t('已选')}<p>{hook.body}</p></li>)}</ul>}
      </section>
    </>}
  </aside>
}

export function MemberCatalog({
  agentId,
  active,
  onDirtyChange,
  onOpenProfile
}: {
  agentId: string
  active: boolean
  onDirtyChange(dirty: boolean): void
  onOpenProfile(): void
}): React.JSX.Element {
  const client = useThreadClient()
  const t = useUiText()
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading')
  const [saved, setSaved] = useState<CapabilityItem[]>([])
  const [items, setItems] = useState<CapabilityItem[]>([])
  const [revision, setRevision] = useState('')
  const [runtime, setRuntime] = useState<string | null>(null)
  const [identity, setIdentity] = useState<CapabilityCatalog['identity'] | null>(null)
  const [query, setQuery] = useState('')
  const [identityOpen, setIdentityOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [saving, setSaving] = useState(false)
  const [riskNames, setRiskNames] = useState<string[]>([])
  const [projection, setProjection] = useState<ProjectionState>({ status: 'loading', preview: null, message: '' })
  const [projectionReload, setProjectionReload] = useState(0)

  useEffect(() => {
    onDirtyChange(phase === 'ready' && !sameSelection(items, saved))
  }, [items, saved, phase, onDirtyChange])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setPhase('loading')
    setNotice('')
    void client.request<CapabilityCatalog>('members.capabilityCatalog.get', { agentId }).then((catalog) => {
      if (cancelled) return
      setSaved(catalog.items)
      setItems(catalog.items)
      setRevision(catalog.revision)
      setRuntime(catalog.runtime)
      setIdentity(catalog.identity)
      setPhase('ready')
    }).catch(() => {
      if (cancelled) return
      setPhase('error')
      setSaved([])
      setItems([])
    })
    return () => { cancelled = true }
  }, [active, agentId, client, reload])

  useEffect(() => {
    if (!active || phase !== 'ready') return
    const runtimeName = previewRuntime(runtime)
    if (!runtimeName) {
      setProjection({ status: 'unsupported', preview: null, message: '' })
      return
    }
    let cancelled = false
    setProjection((current) => ({ ...current, status: 'loading' }))
    void client.request<RunProjectionPreview>('members.runProjection.preview', { member: agentId, runtime: runtimeName }).then((preview) => {
      if (!cancelled) setProjection({ status: 'ready', preview, message: '' })
    }).catch((error) => {
      if (cancelled) return
      const code = errorCode(error)
      if (code === 'runtime_required') {
        setProjection({ status: 'unsupported', preview: null, message: '' })
        return
      }
      setProjection({ status: 'error', preview: null, message: uiAttribute('运行投影读取失败') })
    })
    return () => { cancelled = true }
  }, [active, agentId, client, phase, projectionReload, runtime])

  function toggle(kind: CapabilityKind, id: string): void {
    if (toggleWouldConflict(items, kind, id)) {
      setNotice(t('这条会和已勾选的条目占用同一个工具名，勾选已回到原来的状态。'))
      return
    }
    setNotice('')
    setItems((current) => current.map((item) => item.kind === kind && item.id === id
      ? { ...item, selected: !item.selected, origin: 'explicit' }
      : item))
  }

  async function save(acknowledgeHighRisk: boolean): Promise<void> {
    const pending = highRiskToConfirm(items, saved)
    if (pending.length && !acknowledgeHighRisk) {
      setRiskNames(pending.map((item) => item.name))
      return
    }
    setSaving(true)
    setNotice('')
    try {
      const catalog = await client.request<CapabilityCatalog>('members.capabilityCatalog.set', {
        agentId,
        expectedRevision: revision,
        acknowledgeHighRisk,
        selections: selectionsOf(items)
      })
      setSaved(catalog.items)
      setItems(catalog.items)
      setRevision(catalog.revision)
      setRuntime(catalog.runtime)
      setIdentity(catalog.identity)
      setRiskNames([])
      setProjectionReload((value) => value + 1)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'capability.risk_acknowledgement_required') {
        setRiskNames(highRiskToConfirm(items, saved).map((item) => item.name))
        return
      }
      if (code === 'capability.revision_conflict') {
        setNotice(t('这些勾选刚被别人改过。已重新读取。'))
        setReload((value) => value + 1)
        return
      }
      setNotice(t('保存没有写成，勾选已回到上次读到的结果。'))
      setItems(saved)
    } finally {
      setSaving(false)
    }
  }

  return <MemberCatalogBody
    phase={phase}
    items={items}
    saved={saved}
    query={query}
    identity={identity}
    identityOpen={identityOpen}
    notice={notice}
    projection={projection}
    riskNames={riskNames}
    saving={saving}
    onQuery={setQuery}
    onToggle={toggle}
    onRetry={() => setReload((value) => value + 1)}
    onSave={() => void save(false)}
    onIdentity={() => setIdentityOpen((open) => !open)}
    onOpenProfile={onOpenProfile}
    onProjectionRetry={() => setProjectionReload((value) => value + 1)}
    onRiskConfirm={() => void save(true)}
    onRiskCancel={() => {
      const pending = new Set(highRiskToConfirm(items, saved).map(itemKey))
      setItems((current) => current.map((item) => pending.has(itemKey(item)) ? { ...item, selected: false } : item))
      setRiskNames([])
    }}
  />
}
