import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useThreadClient } from './camp-client'
import { AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { uiAttribute, useUiText } from './interface-language'
import { MemberExecutionTarget } from './MemberExecutionTarget'
import { MemberSkillImport } from './MemberSkillImport'
import type { NodeApi } from './nodes-api'
import {
  conflictingKeys,
  conflictPartners,
  conflictTools,
  hookReviewSnapshot,
  pendingHookReview,
  presentProjectionMcp,
  highRiskToConfirm,
  isCatalogEmpty,
  itemKey,
  matchesQuery,
  previewRuntime,
  revertPending,
  sameSelection,
  selectRefusal,
  selectionCounts,
  selectionsOf,
  snapshotApplies,
  toggleWouldConflict,
  type CapabilityCatalog,
  type CapabilityItem,
  type CapabilityKind,
  type HookReviewSnapshot,
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
    hint: t('身份里的六段文字不在这里勾选。选中的规则片段会随远端成员 Run 的运行包追加；未选中的只保存在目录。'),
    empty: t('还没有可勾选的规则片段。身份里的六段文字仍会随下一次运行包出发。')
  }
  return {
    title: 'hook',
    hint: t('选中的 hook 需先审阅正文与运行范围；批准只适用当前定义和范围。'),
    empty: t('还没有可勾选的 hook。')
  }
}

/** Consent is scoped to one definition and one run range; it is never a blanket trust. */
function hookTrustNote(t: (text: string, ...values: Array<string | number>) => string): string {
  return t('hook 的批准只对当前正文、成员、节点和工作区有效；其中一处变了就要重新审阅。')
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
  reviewSnapshot,
  saving,
  onQuery,
  onToggle,
  onRetry,
  onSave,
  onImport,
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
  reviewSnapshot: HookReviewSnapshot | null
  saving: boolean
  onQuery(value: string): void
  onToggle(kind: CapabilityKind, id: string): void
  onRetry(): void
  onSave(): void
  onImport(): void
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
    <p className="member-catalog-lede">{t('勾选保存在这份 Core。Claude 与 Codex 的远端成员 Run 会冻结当时的选择；保存影响新 Run，重试仍用原快照。')}</p>
    <p className="member-catalog-lede">{t('这里控制 Rovai 追加的可选项。两个必需的平台技能仍保留；节点原生配置中的技能、MCP 和 hooks 独立管理。')}</p>
    <p className="member-catalog-lede">{t('MCP 目前只传递不含凭据的定义，需要凭据的配置会拒绝。规则片段会随运行包追加，Claude 会把选中的 hooks 写进这次 Run 的私有设置。')}</p>
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
        <div className="member-catalog-main">
        <div className="member-catalog-groups">
          {GROUPS.map((kind) => {
            const copy = groupCopy(kind, t)
            const rows = items.filter((item) => item.kind === kind && matchesQuery(item, query)).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
            const noneSelected = kind === 'skill' && items.some((item) => item.kind === 'skill') && items.every((item) => item.kind !== 'skill' || !item.selected)
            return <section key={kind} className="member-catalog-group" aria-label={copy.title}>
              <h3>{copy.title}</h3>
              <p className="member-catalog-hint">{copy.hint}</p>
              {kind === 'skill' && <p className="member-catalog-hint">
                <button className="quiet-button" type="button" onClick={onImport}>{t('导入 Skill')}</button>
                {' '}{t('把这份 Core 上文件夹里的 Skill 导进来，再勾给它用。')}
              </p>}
              {kind === 'hook' && items.some((item) => item.kind === 'hook' && item.selected) && <p className="member-catalog-hint">{hookTrustNote(t)}</p>}
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
                    {conflictPartners(items, item).map((partner) => <p key={partner.tool} className="member-catalog-conflict-line">{t('与 {0} 的 {1} 冲突', partner.names, partner.tool)}</p>)}
                    {item.note && <p>{item.note}</p>}
                  </span>
                  <span className="member-catalog-source">{item.source}</span>
                </label>
              })}
              {noneSelected && !query.trim() && <p className="member-catalog-hint">{t('这个队员还没有勾选。')}</p>}
            </section>
          })}
        </div>
        <footer className="member-catalog-save">
          <p>
            {t('下次运行生效：{0} 项技能，{1} 个 MCP', String(counts.skill), String(counts.mcp))}
            {counts.rule > 0 ? ` ${t('{0} 条规则', String(counts.rule))}` : ''}
            {counts.hook > 0 ? ` ${t('{0} 个 hook', String(counts.hook))}` : ''}
            {counts.conflicts > 0 ? ` ${t('· {0} 处冲突', String(counts.conflicts))}` : ''}
          </p>
          <button className="primary-button" type="button" disabled={!dirty || saving || conflicts.length > 0} onClick={onSave}>
            {saving ? t('正在保存…') : t('保存')}
          </button>
        </footer>
        </div>
        <ProjectionPanel projection={projection} onRetry={onProjectionRetry} />
      </div>
    </>}
    <Dialog.Root open={riskNames.length > 0 || reviewSnapshot !== null} onOpenChange={(open) => { if (!open) onRiskCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
        <AppDialogContent aria-describedby="catalog-risk-description">
          <AppDialogHeader
            title={reviewSnapshot && reviewSnapshot.entries.length > 0 ? t('审阅 hook 正文与运行范围') : t('确认勾选高风险项？')}
            description={reviewSnapshot && reviewSnapshot.entries.length > 0
              ? (riskNames.length > 0
                ? t('「{0}」是高风险 MCP，或会执行命令的 hook；下面这些 hook 的正文和运行范围还没审过。确认之后才会勾上。取消则这次勾选不留下。', riskNames.join('、'))
                : t('下面这些 hook 的正文和运行范围还没审过。确认之后才会勾上。取消则这次勾选不留下。'))
              : t('「{0}」是高风险 MCP，或会执行命令的 hook。确认之后才会勾上。取消则这次勾选不留下。', riskNames.join('、'))}
            descriptionId="catalog-risk-description"
          />
          {reviewSnapshot && reviewSnapshot.entries.length > 0 && <div className="member-catalog-review">
            {reviewSnapshot.entries.map((entry) => <section key={entry.id}>
              <h3>{entry.name}</h3>
              <p className="member-catalog-hint">{t('成员 {0} · 节点 {1} · 工作区 {2} · 运行端 {3}', entry.scope.memberId, entry.scope.nodeId || t('本机'), entry.scope.workspaceRoot, entry.scope.adapterKind)}</p>
              <pre>{entry.body}</pre>
              <details>
                <summary>{t('定义摘要')}</summary>
                <dl className="member-catalog-identity">
                  <dt>{t('定义')}</dt><dd>{entry.definitionDigest}</dd>
                  <dt>{t('范围')}</dt><dd>{entry.scopeDigest}</dd>
                </dl>
              </details>
            </section>)}
            <p className="member-catalog-hint">{t('批准只适用这份正文和这次范围。成员、节点、工作区或正文变了就要重新审阅。')}</p>
          </div>}
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
    <p>{t('引导正文和 MCP 文件是下一次 Run 会拿到的内容。技能与附加技能用的是同一份勾选；规则片段随运行包追加，Claude 的 hooks 写进这次 Run 的私有设置。未保存的勾选要等这次保存之后才出现。')}</p>
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
        <pre>{JSON.stringify(presentProjectionMcp(projection.preview.mcp), null, 2)}</pre>
      </section>
      <section>
        <h3>{t('规则片段')}</h3>
        {projection.preview.rules.length === 0
          ? <p>{t('还没有勾选的规则片段。')}</p>
          : <ul>{projection.preview.rules.map((rule) => <li key={rule.id}><strong>{rule.name}</strong> · {rule.origin === 'inherited' ? t('继承') : t('已选')}<p>{rule.body}</p></li>)}</ul>}
      </section>
      <section>
        <h3>hook</h3>
        <p>{hookTrustNote(t)}</p>
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
  onOpenProfile,
  onExecutionFactsChanged,
  nodes = null
}: {
  agentId: string
  active: boolean
  onDirtyChange(dirty: boolean): void
  onOpenProfile(): void
  onExecutionFactsChanged?(): void
  nodes?: NodeApi | null
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
  const [reviewSnapshot, setReviewSnapshot] = useState<HookReviewSnapshot | null>(null)
  // One generation fences every late reply and every frozen dialog snapshot.
  const generation = useRef(0)
  const [projection, setProjection] = useState<ProjectionState>({ status: 'loading', preview: null, message: '' })
  const [projectionReload, setProjectionReload] = useState(0)
  const [factsReload, setFactsReload] = useState(0)
  // The run target keeps its own draft and save button; only the leave guard merges both.
  const [targetDirty, setTargetDirty] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  useEffect(() => {
    // Another member's page never inherits this dialog or its in-flight replies.
    setImportOpen(false)
  }, [agentId])

  useEffect(() => {
    onDirtyChange((phase === 'ready' && !sameSelection(items, saved)) || targetDirty)
  }, [items, saved, phase, targetDirty, onDirtyChange])

  function retire(): void {
    generation.current += 1
    setRiskNames([])
    setReviewSnapshot(null)
  }

  useEffect(() => {
    // One read owns the whole catalog. Member, reload and target facts all re-read
    // scope and definitions, so a stale draft never masquerades as the new catalog.
    // The generation still bumps when inactive: a late reply must land nowhere.
    const current = ++generation.current
    setRiskNames([])
    setReviewSnapshot(null)
    setSaving(false)
    setPhase('loading')
    setNotice(factsReload > 0 ? uiAttribute('已重新读取目录；未保存的勾选需按新目录重新选择。') : '')
    if (!active) return undefined
    void client.request<CapabilityCatalog>('members.capabilityCatalog.get', { agentId }).then((catalog) => {
      if (generation.current !== current) return
      setSaved(catalog.items)
      setItems(catalog.items)
      setRevision(catalog.revision)
      setRuntime(catalog.runtime)
      setIdentity(catalog.identity)
      setPhase('ready')
    }).catch(() => {
      if (generation.current !== current) return
      setPhase('error')
      setSaved([])
      setItems([])
    })
    return () => { generation.current += 1 }
  }, [active, agentId, client, reload, factsReload])

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
    const item = items.find((entry) => entry.kind === kind && entry.id === id)
    if (!item) return
    if (toggleWouldConflict(items, kind, id)) {
      setNotice(t('这条会和已勾选的条目占用同一个工具名，勾选已回到原来的状态。'))
      return
    }
    const refusal = selectRefusal(item)
    if (refusal) {
      setNotice(t('这条的来源读不到，不能新勾选；已勾选的仍可以取消。'))
      return
    }
    setNotice('')
    setItems((current) => current.map((entry) => entry.kind === kind && entry.id === id
      ? { ...entry, selected: !entry.selected, origin: 'explicit' }
      : entry))
  }

  /** Opens the shared confirmation with a frozen snapshot, or sends a plain save. */
  function requestSave(): void {
    const risky = highRiskToConfirm(items, saved)
    const pendingHooks = pendingHookReview(items)
    if (!risky.length && !pendingHooks.length) {
      void submit(null)
      return
    }
    const snapshot = hookReviewSnapshot({
      agentId,
      revision,
      token: generation.current,
      acknowledgeHighRisk: risky.length > 0,
      selections: selectionsOf(items),
      pending: pendingHooks
    })
    if (!snapshot) {
      setNotice(t('这个 hook 的正文没读到，先重新读取目录再勾选。'))
      return
    }
    setRiskNames(risky.map((item) => item.name))
    setReviewSnapshot(snapshot)
  }

  async function submit(snapshot: HookReviewSnapshot | null): Promise<void> {
    const frozen = snapshot
    // A member, target or reload change retires the snapshot instead of sending it.
    if (frozen && !snapshotApplies(frozen, agentId, generation.current)) {
      retire()
      setNotice(t('运行位置已改变，请重新勾选。'))
      setReload((value) => value + 1)
      return
    }
    const current = generation.current
    setSaving(true)
    setNotice('')
    try {
      const catalog = await client.request<CapabilityCatalog>('members.capabilityCatalog.set', {
        agentId,
        expectedRevision: frozen ? frozen.revision : revision,
        acknowledgeHighRisk: frozen ? frozen.acknowledgeHighRisk : false,
        selections: frozen ? frozen.selections : selectionsOf(items),
        reviewedHooks: frozen ? frozen.approvals : []
      })
      if (generation.current !== current) return
      setSaved(catalog.items)
      setItems(catalog.items)
      setRevision(catalog.revision)
      setRuntime(catalog.runtime)
      setIdentity(catalog.identity)
      setRiskNames([])
      setReviewSnapshot(null)
      setProjectionReload((value) => value + 1)
    } catch (error) {
      if (generation.current !== current) return
      const code = errorCode(error)
      if (code === 'capability.risk_acknowledgement_required') {
        // Reopen from the current read with the acknowledgement on, so a null
        // snapshot confirm can never loop on the same refusal.
        const reopened = hookReviewSnapshot({
          agentId,
          revision,
          token: generation.current,
          acknowledgeHighRisk: true,
          selections: frozen ? frozen.selections : selectionsOf(items),
          pending: pendingHookReview(items)
        })
        setRiskNames(highRiskToConfirm(items, saved).map((item) => item.name))
        if (reopened) {
          setReviewSnapshot(reopened)
          return
        }
        retire()
        setNotice(t('这个 hook 的正文没读到，先重新读取目录再勾选。'))
        setReload((value) => value + 1)
        return
      }
      if (code === 'capability.hook_review_required' || code === 'capability.hook_review_conflict'
        || code === 'capability.hook_review_scope_changed') {
        retire()
        setNotice(t('hook 的正文或运行范围刚变过。已重新读取目录，请重新审阅。'))
        setReload((value) => value + 1)
        return
      }
      if (code === 'capability.revision_conflict') {
        retire()
        setNotice(t('这些勾选刚被别人改过。已重新读取。'))
        setReload((value) => value + 1)
        return
      }
      retire()
      setNotice(t('保存没有写成，勾选已回到上次读到的结果。'))
      setItems(saved)
    } finally {
      // An older request must not unlock a newer one.
      if (generation.current === current) setSaving(false)
    }
  }

  return <div className="member-catalog-page">
    <MemberExecutionTarget
      memberId={agentId}
      active={active}
      nodes={nodes}
      onDirtyChange={setTargetDirty}
      onFactsChanged={() => {
        onExecutionFactsChanged?.()
        // Retire synchronously: a confirm clicked before the effect runs must not send.
        retire()
        setPhase('loading')
        setFactsReload((value) => value + 1)
      }}
    />
    {importOpen && <MemberSkillImport
      items={items}
      onImported={() => setReload((value) => value + 1)}
      onClose={() => setImportOpen(false)}
    />}
    <MemberCatalogBody
      phase={phase}
      items={items}
      saved={saved}
      query={query}
      identity={identity}
      identityOpen={identityOpen}
      notice={notice}
      projection={projection}
      riskNames={riskNames}
      reviewSnapshot={reviewSnapshot}
      saving={saving}
      onQuery={setQuery}
      onToggle={toggle}
      onRetry={() => setReload((value) => value + 1)}
      onSave={requestSave}
      onImport={() => setImportOpen(true)}
      onIdentity={() => setIdentityOpen((open) => !open)}
      onOpenProfile={onOpenProfile}
      onProjectionRetry={() => setProjectionReload((value) => value + 1)}
      onRiskConfirm={() => void submit(reviewSnapshot)}
      onRiskCancel={() => {
        // Only never-saved keys are reverted; a saved selection keeps its check.
        const savedOn = new Set(saved.filter((item) => item.selected).map(itemKey))
        const keys = new Set<string>()
        for (const item of highRiskToConfirm(items, saved)) keys.add(itemKey(item))
        for (const entry of reviewSnapshot?.entries ?? []) keys.add(`hook:${entry.id}`)
        for (const key of [...keys]) if (savedOn.has(key)) keys.delete(key)
        setItems((current) => revertPending(current, keys))
        setRiskNames([])
        setReviewSnapshot(null)
      }}
    />
  </div>
}
