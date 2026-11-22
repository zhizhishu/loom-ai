// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：components/slots/settings-general.tsx、settings-connections.tsx、settings-devices.tsx、components/devices/devices-settings.tsx（逻辑整体搬自原 NativeSetup.tsx）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExecutionNodeList, ExecutionNodePairing, SkillImportInspection, WorkspaceSelection } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { SurfaceDialog, ChoiceMenu, FormMessage } from './Controls'
import { Icon, IconButton } from './icons'
import { createRuntimeSetupPort, type ProductRuntimeKind, type RuntimeSetupRead, type RuntimeSetupState } from './runtime-setup-service'
import { createCapabilityPort } from './capability-service'
import { readMcpConnections } from './mcp-service'
import { McpConnections } from './McpConnections'
import { RuntimeConnectionSettings } from './RuntimeConnectionSettings'
import { sourceStateLabel, sourceExplanation } from './native-source-presentation'
import { hostFeatureError, type NativeCapability, type NativeCatalog, type NativeKind, type NativePreview } from './host-services'
import { WorkspaceManager } from './WorkspaceManager'

/** The four engines LOOM drives, in the order the rail and the wizard list them. */
export const RUNTIMES = [{ value: 'claude-code-cli', label: 'Claude Code', mark: 'C' }, { value: 'codex-cli', label: 'Codex', mark: '▧' }, { value: 'deepseek-harness', label: 'DSH', mark: 'D' }, { value: 'pi', label: 'Pi', mark: 'π' }] as const
const KIND_LABEL: Record<NativeKind, string> = { skill: 'Skills', mcp: 'MCP', rule: '规则', hook: 'Hooks' }
const KIND_ICON: Record<NativeKind, 'bulb' | 'globe' | 'file' | 'branch'> = { skill: 'bulb', mcp: 'globe', rule: 'file', hook: 'branch' }
const STATUS: Record<RuntimeSetupState, string> = { verified: '检查通过', check_pending: '正在检查', found_unverified: '已发现 · 待检查', missing: '尚未发现', authentication_required: '需要登录', incompatible: '版本待处理', needs_attention: '需要处理', disabled: '已停用', policy_disabled: '已禁用', platform_unsupported: '当前平台不支持', unknown: '未确认' }
type ImportReview = { item: NativeCapability; preview?: NativePreview; skill?: SkillImportInspection; configDigest?: string; id: string }

export type SettingsMachineProps = {
  environment: BusinessEnvironment
  theme: 'day' | 'night'
  threadId?: string
  /** Reads changed host state again (capabilities, runtimes) and refreshes the conversation. */
  onChanged(): void
}

/** 工作目录: the existing manager, inline instead of in a dialog
 * (Mikka `components/slots/settings-general.tsx:8` owns the workspace's own settings). */
export function WorkspaceDirectorySection({ environment, theme, onStart }: {
  environment: BusinessEnvironment; theme: 'day' | 'night'; onStart(value: WorkspaceSelection): void
}) {
  return <div className="ln-settings-block"><WorkspaceManager embedded environment={environment} theme={theme} onStart={onStart} onClose={() => undefined}/></div>
}

/** 运行端: the four engine cards with discovery, probing and per-engine connection
 * settings — moved out of the 「连接与设备」 dialog, same reads and same confirmations
 * (`NativeSetup.tsx:132-141,154,155`). Mikka keeps run location on the models page
 * (`components/slots/settings-models.tsx:17-28`). */
export function RuntimeSection({ environment, theme, threadId, onChanged, onConnections, onManageAssistants }: SettingsMachineProps & {
  onConnections(runtime?: ProductRuntimeKind): void; onManageAssistants(): void
}) {
  const runtimePort = useMemo(() => createRuntimeSetupPort(environment.client), [environment.client])
  const [runtime, setRuntime] = useState<RuntimeSetupRead | null>(null)
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [probe, setProbe] = useState<ProductRuntimeKind | 'rescan' | null>(null)
  const [connectionRuntime, setConnectionRuntime] = useState<ProductRuntimeKind | null>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true); setError('')
    const [cards, resources] = await Promise.allSettled([runtimePort.read(), environment.workbench ? environment.workbench.catalog(threadId) : Promise.reject(new Error('当前连接未提供原生能力发现接口。'))])
    if (ticket !== generation.current) return
    if (cards.status === 'fulfilled') setRuntime(cards.value)
    else setRuntime({ status: 'error', code: 'runtime_read_failed', message: hostFeatureError(cards.reason) })
    setCatalog(resources.status === 'fulfilled' ? resources.value : null)
    setLoading(false)
  }, [runtimePort, environment.workbench, threadId])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  const pending = runtime?.status === 'ready' && runtime.cards.some(card => card.setupState === 'check_pending')
  useEffect(() => {
    if (!pending) return
    let ended = false
    const timer = setInterval(() => { void runtimePort.read().then(value => { if (!ended) setRuntime(value) }) }, 1800)
    return () => { ended = true; clearInterval(timer) }
  }, [pending, runtimePort])
  const runProbe = async () => {
    if (!probe || busy) return
    const current = probe
    setBusy(true); setError(''); setNotice('')
    try {
      const result = current === 'rescan' ? await runtimePort.rescan() : await runtimePort.probe(current)
      if (result.status === 'rejected') throw new Error(result.message)
      setProbe(null)
      setNotice(current === 'rescan' ? '已请求主机重新发现程序，下面显示的是实际回读结果。' : '检查已返回；是否就绪以下方状态为准，不自动切换助手或模型。')
      await load()
    } catch (cause) { setError(hostFeatureError(cause)) } finally { setBusy(false) }
  }
  return <div className="ln-settings-block">
    <div className="ln-panel-title"><div><h3>你的 Agent</h3><small>四种执行引擎，同一套协作体验。</small></div><button type="button" className="ln-action" disabled={busy || loading} onClick={() => setProbe('rescan')}><Icon name="refresh" size={14}/>重新发现</button></div>
    {runtime?.status === 'error' && <FormMessage error>{runtime.message}</FormMessage>}
    {error && <FormMessage error>{error}</FormMessage>}
    {notice && <FormMessage>{notice}</FormMessage>}
    <div className="ln-runtime-cards">{RUNTIMES.map(entry => {
      const card = runtime?.status === 'ready' ? runtime.cards.find(row => row.runtimeKind === entry.value) : undefined
      const program = catalog?.programs.find(row => row.kind === entry.value)
      const detected = card?.discovery.status === 'found' || program?.detected
      const ready = card?.setupState === 'verified'
      const resources = catalog?.items.filter(row => row.runtime === entry.value).length
      return <article className={`ln-runtime-card${ready ? ' is-ready' : ''}`} key={entry.value}>
        <div className="ln-runtime-card-top"><span className={`ln-runtime-mark is-${entry.value}`}>{entry.mark}</span><div><h3>{entry.label}</h3><span className="ln-runtime-state">{loading && !card ? '正在读取…' : card ? STATUS[card.setupState] : detected ? '已发现 · 待检查' : '尚未确认'}</span></div>{ready && <Icon name="check" size={17}/>}</div>
        <p>{entry.value === 'pi' ? '可使用内置 Pi，也保留原生 Pi 接入。' : '使用当前主机的原生客户端，不修改全局模型设置。'}</p>
        <div className="ln-runtime-facts"><span>版本 <b>{card?.reportedVersion || '尚未核验'}</b></span><span>模型 <b>{card?.modelCatalog.modelCount ?? '—'}</b></span><span>能力 <b>{resources ?? '—'}</b></span></div>
        <details className="ln-native-source"><summary>安装与检查详情</summary><p>{card?.discovery.executablePath || program?.executablePath || '暂无可确认的程序路径'}</p><p>{card?.check.failure?.summary || card?.discovery.diagnosticCode || '发现到程序并不代表账号、模型和执行权限已经就绪。'}</p></details>
        <div className="ln-runtime-actions">
          <button type="button" className="ln-action" disabled={busy || !detected} onClick={() => setProbe(entry.value)}>检查可用性</button>
          <button type="button" className="ln-action" aria-label={`${entry.label} 连接设置`} disabled={busy} onClick={() => setConnectionRuntime(entry.value)}>连接设置</button>
          <button type="button" className="ln-action" onClick={() => onConnections(entry.value)}>查看能力</button>
        </div>
      </article>
    })}</div>
    <div className="ln-native-next"><div><strong>给助手选择运行端和模型</strong><p>同一位助手可以切换引擎；创建群聊不自动启动任务。</p></div><button type="button" className="ln-action is-primary" onClick={onManageAssistants}>管理助手</button></div>
    <SurfaceDialog open={probe !== null} title={probe === 'rescan' ? '重新发现运行端？' : '检查这个 Agent？'} description="由当前主机进行检查，不会发送工作任务或更换模型。" theme={theme} onClose={() => { if (!busy) setProbe(null) }} className="ln-room-dialog">
      <div className="ln-room-content">
        <p className="ln-native-help">{probe === 'rescan' ? '主机可能读取登录 Shell 的环境来寻找程序。不会修改四个客户端的配置。' : '此检查会启动原生 CLI，可能加载它已有的扩展或 Hook、访问其登录态。检查结果与找到路径分开显示。'}</p>
        {error && <FormMessage error>{error}</FormMessage>}
        <footer className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => setProbe(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={() => { void runProbe() }}>{busy ? '正在检查…' : '开始检查'}</button></footer>
      </div>
    </SurfaceDialog>
    {connectionRuntime && <RuntimeConnectionSettings key={connectionRuntime} environment={environment} runtimeKind={connectionRuntime} theme={theme} onClose={() => { setConnectionRuntime(null); void load(); onChanged() }}/>}
  </div>
}

/** 连接: the client's own capability catalog (Skills / MCP / rules / hooks) plus the
 * MCP connections — one section because Mikka keeps local capability discovery on
 * 「连接」 (`lib/settings-sections.ts:34`) and the personal build has no external SaaS
 * directory (`components/plugins/plugins-view.tsx:55-73`). */
export function ConnectionsSection({ environment, theme, threadId, onChanged, onDirtyChange, initialRuntime }: SettingsMachineProps & {
  onDirtyChange(dirty: boolean): void
  /** Runtime chosen by 运行端's 「查看能力」. */
  initialRuntime?: ProductRuntimeKind | null
}) {
  const capabilityPort = useMemo(() => createCapabilityPort(environment.client), [environment.client])
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null)
  const [discoveryError, setDiscoveryError] = useState('')
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState<NativeKind>('skill')
  const [query, setQuery] = useState('')
  const [runtimeFilter, setRuntimeFilter] = useState<string>(initialRuntime ?? 'all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [review, setReview] = useState<ImportReview | null>(null)
  const [imported, setImported] = useState(new Set<string>())
  const [mcpDirty, setMcpDirty] = useState(false)
  const generation = useRef(0)
  const mutationEpoch = useRef(0)
  const registration = useRef(new Map<string, string>())

  useEffect(() => { setRuntimeFilter(initialRuntime ?? 'all') }, [initialRuntime])
  useEffect(() => { onDirtyChange(mcpDirty) }, [mcpDirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange(false) }, [onDirtyChange])

  const load = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true); setError(''); setDiscoveryError('')
    try {
      const resources = await (environment.workbench ? environment.workbench.catalog(threadId) : Promise.reject<NativeCatalog>(new Error('当前连接未提供原生能力发现接口。')))
      if (ticket !== generation.current) return
      setCatalog(resources)
    } catch (cause) {
      if (ticket !== generation.current) return
      setCatalog(null); setDiscoveryError(hostFeatureError(cause))
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [environment.workbench, threadId])
  useEffect(() => { void load(); return () => { generation.current++; mutationEpoch.current++ } }, [load])

  const inspect = async (item: NativeCapability) => {
    if (busy || !environment.workbench) return
    const ticket = mutationEpoch.current
    setBusy(true); setError(''); setNotice('')
    try {
      let next: ImportReview = { item, id: crypto.randomUUID() }
      if (item.kind === 'skill') {
        const path = item.sourcePath.replace(/[\\/]SKILL\.md$/i, '')
        next = { ...next, skill: await capabilityPort.inspectSkill(path) }
      } else if (item.kind === 'mcp') {
        const config = await readMcpConnections(environment.client)
        if (config.status !== 'ready') throw new Error(config.message)
        next = { ...next, configDigest: config.configDigest }
      } else next = { ...next, preview: await environment.workbench.preview(item.sourceId, item.digest, threadId) }
      if (ticket === mutationEpoch.current) setReview(next)
    } catch (cause) { if (ticket === mutationEpoch.current) setError(hostFeatureError(cause)) } finally { if (ticket === mutationEpoch.current) setBusy(false) }
  }
  const commit = async (candidateName?: string) => {
    if (!review || !environment.workbench || busy) return
    const frozen = review, ticket = mutationEpoch.current
    setBusy(true); setError(''); setNotice('')
    try {
      if (frozen.item.kind === 'skill') {
        if (!frozen.skill || !candidateName) throw new Error('尚未取得精确的导入检查。')
        const candidate = frozen.skill.candidates.find(row => row.name === candidateName)
        if (!candidate) throw new Error('技能检查结果已改变，请重新检查。')
        const key = `${frozen.id}:${candidateName}`
        let skillId = registration.current.get(key)
        if (!skillId) {
          const result = await capabilityPort.commitSkill(frozen.skill, { candidateName, expectedSkillVersion: candidate.existingSkillVersion, confirmUpdate: candidate.importAction === 'update', commandId: frozen.id })
          if (result.status !== 'applied') throw new Error(result.message || '导入结果尚未确认，未重新创建。')
          if (!result.skillId) throw new Error('导入已提交，但未返回技能身份；请重新读取核对。')
          skillId = result.skillId; registration.current.set(key, skillId)
        }
        await capabilityPort.registerSkill(skillId)
      } else if (frozen.item.kind === 'mcp') {
        if (!frozen.configDigest) throw new Error('连接版本未读取。')
        const result = await environment.workbench.importMcp(frozen.item.sourceId, frozen.item.digest, frozen.configDigest, threadId)
        if (result.status !== 'ok' || !result.serverId || result.enabled !== false || result.assignedAgentIds?.length) throw new Error(result.status === 'conflict' ? 'MCP配置已改变，请重新检查再导入。' : '导入未被确认为停用且未分配的连接，请重新读取核对。')
      } else {
        if (!frozen.preview?.available || frozen.preview.truncated || !frozen.preview.content?.text) throw new Error('完整正文不可读取，不能导入一个猜测或截断的定义。')
        const snippet = { id: `native-${frozen.id}`, name: frozen.item.name, body: frozen.preview.content.text, scope: 'cloud' as const, note: `来自 ${RUNTIMES.find(row => row.value === frozen.item.runtime)?.label ?? frozen.item.runtime} · 显式导入` }
        if (frozen.item.kind === 'rule') await capabilityPort.putRule(snippet)
        else await capabilityPort.putHook(snippet)
      }
      if (ticket !== mutationEpoch.current) return
      setImported(current => new Set(current).add(frozen.item.sourceId)); setReview(null); onChanged()
      setNotice(frozen.item.kind === 'mcp' ? '工具连接已登记，未启用、未分配。到“MCP 连接”启用，再为助手勾选。' : '已加入能力目录，未自动启用。到“管理助手 → 能力”选择并保存。')
    } catch (cause) { if (ticket === mutationEpoch.current) setError(hostFeatureError(cause)) } finally { if (ticket === mutationEpoch.current) setBusy(false) }
  }
  const filtered = catalog?.items.filter(item => item.kind === kind && (runtimeFilter === 'all' || item.runtime === runtimeFilter) && `${item.name} ${item.sourcePath}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? []
  return <>
    <section className="ln-settings-block" aria-label="客户端能力">
      <div className="ln-panel-title"><div><h3>客户端已有的能力</h3><small>读取声明的目录与配置，不执行 Hook，不复制账号。</small></div><IconButton icon="refresh" label="重新读取原生能力" disabled={busy || loading} onClick={() => { void load() }}/></div>
      <div className="ln-native-filter"><ChoiceMenu value={runtimeFilter} choices={[{ value: 'all', label: '全部运行端' }, ...RUNTIMES.map(row => ({ value: row.value, label: row.label }))]} label="筛选能力运行端" theme={theme} disabled={busy} onChange={setRuntimeFilter}/><label className="ln-cap-search"><Icon name="search" size={14}/><input value={query} onChange={event => setQuery(event.target.value)} aria-label="查找原生能力" placeholder="搜索名称、来源…"/></label></div>
      <nav className="ln-segment-tabs" aria-label="原生能力类型">{(['skill', 'mcp', 'rule', 'hook'] as const).map(value => <button type="button" key={value} className={kind === value ? 'is-selected' : ''} aria-pressed={kind === value} onClick={() => setKind(value)}>{KIND_LABEL[value]}<small>{catalog?.items.filter(row => row.kind === value && (runtimeFilter === 'all' || row.runtime === runtimeFilter)).length ?? '—'}</small></button>)}</nav>
      {error && <FormMessage error>{error}</FormMessage>}{notice && <FormMessage>{notice}</FormMessage>}
      {discoveryError && <FormMessage error>{discoveryError}</FormMessage>}
      {loading ? <p className="ln-inspector-empty">正在读取主机声明的能力…</p> : <>
        {filtered.map(item => <article className="ln-native-resource" key={item.sourceId}><span className="ln-native-type"><Icon name={KIND_ICON[item.kind]} size={18}/></span><div className="ln-native-resource-copy"><strong>{item.name}</strong><p>{RUNTIMES.find(row => row.value === item.runtime)?.label ?? item.runtime} · {item.sourceScope === 'project' ? '当前项目' : '用户配置'}</p><details className="ln-native-source"><summary>来源与兼容</summary><p>{item.sourcePath}</p><p>{item.import?.reason || '导入后仍需为助手显式选择，不自动执行。'}</p></details></div><button type="button" className="ln-action" disabled={busy || imported.has(item.sourceId) || (item.kind === 'hook' && !item.importable)} onClick={() => { void inspect(item) }}>{imported.has(item.sourceId) ? '已加入' : item.kind === 'hook' && !item.importable ? '保留原生' : '检查并导入'}</button></article>)}
        {!filtered.length && !discoveryError && <div className="ln-native-empty"><Icon name={KIND_ICON[kind]} size={28}/><strong>没有发现这一类能力</strong><p>这里只显示当前主机已声明的配置；不是浏览器电脑的文件。</p></div>}
        {catalog?.sources && <details className="ln-native-source ln-source-diagnostics"><summary>扫描了哪些来源 · {catalog.sources.length} 项</summary>{catalog.sources.filter(item => runtimeFilter === 'all' || item.runtime === runtimeFilter).map((item, index) => <div key={index}><strong>{RUNTIMES.find(row => row.value === item.runtime)?.label || item.runtime} · {sourceStateLabel(item)}</strong><p>{sourceExplanation(item)}</p>{item.path !== '<declared>' && <small>{item.path}</small>}</div>)}</details>}
        {!!catalog?.errors.length && <details className="ln-native-source"><summary>{catalog.errors.length} 项来源读取提示</summary>{catalog.errors.map((row, index) => <p key={index}>{RUNTIMES.find(entry => entry.value === row.runtime)?.label ?? row.runtime} · {row.code}</p>)}</details>}
        {catalog?.truncated.limitHit && <FormMessage>已达到本次扫描边界，结果是部分列表；没有扩大到未声明目录。</FormMessage>}
      </>}
    </section>
    <section className="ln-settings-block" aria-label="MCP 连接">
      <McpConnections client={environment.client} theme={theme} onChanged={onChanged} onDirty={setMcpDirty}/>
    </section>
    <SurfaceDialog open={review !== null} title="确认导入这项能力" description="保留原生来源；只加入 LOOM 目录，不自动启用或授予额外权限。" theme={theme} onClose={() => { if (!busy) setReview(null) }} className="ln-room-dialog">
      <div className="ln-room-content">{review && <>
        <div className="ln-review-card"><h3>{review.item.name}</h3><p>{review.item.sourcePath}</p>{review.item.kind === 'mcp' ? <p>连接正文和账号值保留在主机。导入后默认停用、未分配；不会把密钥传到这个页面。</p> : review.preview?.available ? <pre>{review.preview.content?.text}</pre> : review.preview ? <p>{review.preview.reason?.message || '原生定义不支持直接导入。'}</p> : null}</div>
        {review.skill?.candidates.map(candidate => <div className="ln-native-import-choice" key={candidate.name}><div><strong>{candidate.name}</strong><p>{candidate.description}</p><small>{candidate.fileCount}个文件 · {candidate.totalBytes}字节</small></div><button type="button" className="ln-action is-primary" disabled={busy || candidate.importAction === 'official_conflict'} onClick={() => { void commit(candidate.name) }}>{candidate.importAction === 'update' ? '确认更新版本' : '确认导入'}</button></div>)}
        {review.skill?.rejectedCandidates.map((row, index) => <FormMessage error key={index}>{row.message}</FormMessage>)}
        {review.preview?.truncated && <FormMessage error>正文超过预览范围，不能导入不完整内容。</FormMessage>}
        {error && <FormMessage error>{error}</FormMessage>}
        {review.item.kind !== 'skill' && <footer className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => setReview(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={busy || (review.item.kind !== 'mcp' && (!review.preview?.available || review.preview.truncated))} onClick={() => { void commit() }}>{busy ? '保存中…' : '确认导入，暂不启用'}</button></footer>}
      </>}</div>
    </SurfaceDialog>
  </>
}

/** 设备: this machine plus the paired execution nodes, with pairing and revocation
 * (moved unchanged from `NativeSetup.tsx:165-180`). Mikka `components/devices/devices-settings.tsx:15-27`:
 * only machines the user connected, the bots' cloud computer is never listed. */
export function DeviceSection({ environment, theme }: SettingsMachineProps) {
  const [read, setRead] = useState<ExecutionNodeList | null>(null)
  const [pairing, setPairing] = useState<ExecutionNodePairing | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState<string | null>(null)
  const load = useCallback(async () => { try { setRead(await environment.nodes.list()); setError('') } catch (cause) { setError(hostFeatureError(cause)) } }, [environment.nodes])
  useEffect(() => { void load(); const timer = setInterval(() => { void load() }, 5000); return () => { clearInterval(timer); setPairing(null) } }, [load])
  const pair = async () => { if (busy) return; setBusy(true); setError(''); try { setPairing(await environment.nodes.pair()) } catch (cause) { setError(hostFeatureError(cause)) } finally { setBusy(false) } }
  const revoke = async () => { if (!confirm || busy) return; setBusy(true); setError(''); try { await environment.nodes.revoke(confirm); setConfirm(null); await load() } catch (cause) { setError(hostFeatureError(cause)) } finally { setBusy(false) } }
  return <section className="ln-settings-block" aria-label="执行节点">
    <div className="ln-panel-title"><div><h3>执行节点</h3><small>当前主机统一派工，节点在自己的工作区执行。</small></div><button type="button" className="ln-action" disabled={busy} onClick={() => { void pair() }}><Icon name="plus" size={14}/>连接另一台电脑</button></div>
    {error && <FormMessage error>{error}</FormMessage>}
    <div className="ln-native-current-host"><Icon name="computer" size={28}/><div><strong>当前连接主机</strong><p>本机执行与电脑画面由当前 Host 提供；云端 Host 使用相同接口。</p></div></div>
    {read?.nodes.map(node => <article className="ln-native-resource" key={node.nodeId}><span className="ln-native-type"><Icon name="computer" size={19}/></span><div className="ln-native-resource-copy"><strong>{node.displayName || node.nodeId}</strong><p>{node.os || '系统未确认'} · {node.status} · {node.activeRunCount}项执行中</p><small>{node.clis.filter(cli => cli.pathPresent).map(cli => RUNTIMES.find(row => row.value === cli.adapterKind)?.label || cli.adapterKind).join(' / ') || '未报告可用的运行端'}</small></div><button type="button" className="ln-action" disabled={busy || !!node.revokedAt || !node.revocable} onClick={() => setConfirm(node.nodeId)}>{node.revokedAt ? '已撤销' : '撤销配对'}</button></article>)}
    {read && !read.nodes.length && <div className="ln-native-empty"><Icon name="globe" size={28}/><strong>还没有配对的执行节点</strong><p>在另一台 Windows 或 Linux 上运行 LOOM Node 后使用配对码连接，不复制本机账号。</p></div>}
    <p className="ln-native-help">配对执行节点不自动开放远程屏幕。屏控必须由目标 Host 提供并单独授权；工作位置还需为助手选择已准备的工作区。</p>
    <SurfaceDialog open={pairing !== null} title="连接执行节点" description="此配对码只交给你信任的机器；页面不会替你安装软件或复制账号。" theme={theme} className="ln-room-dialog" onClose={() => setPairing(null)}>
      <div className="ln-room-content">{pairing && <><div className="ln-pair-code">{pairing.pairingCode}</div><p className="ln-native-help">有效期 {pairing.expiresInSeconds} 秒。节点必须能够访问下面的 Host 地址。</p><code className="ln-pair-origin">{pairing.connectUrl}</code>{pairing.reachabilityWarning && <FormMessage>当前地址来自本机监听设置，其他机器可能无法访问。请先配置可到达、受认证的 Host 地址，不要关闭认证。</FormMessage>}</>}</div>
    </SurfaceDialog>
    <SurfaceDialog open={confirm !== null} title="撤销这个节点？" description="节点将不能领取新任务。运行中任务的停止结果由 Core 回执确认。" theme={theme} className="ln-room-dialog" onClose={() => { if (!busy) setConfirm(null) }}>
      <div className="ln-room-content">{error && <FormMessage error>{error}</FormMessage>}<footer className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button type="button" className="ln-action is-danger" disabled={busy} onClick={() => { void revoke() }}>撤销配对</button></footer></div>
    </SurfaceDialog>
  </section>
}
