export type CapabilityKind = 'skill' | 'mcp' | 'rule' | 'hook'
export type CapabilityOrigin = 'inherited' | 'explicit' | null

/** Core-owned review scope. It carries ids, never a caller-supplied label or digest. */
export type HookReviewScope = {
  memberId: string
  missionId: string
  campId: string
  workspaceId: string
  nodeId: string
  workspaceRoot: string
  workspaceGeneration: number
  workspaceTokenDigest: string
  adapterKind: string
}

export type HookDefinition = {
  body: string
  definitionDigest: string
  reviewed: boolean
  reviewScope: HookReviewScope
  scopeDigest: string
}

export type CapabilityItem = {
  id: string
  kind: CapabilityKind
  name: string
  note: string
  source: string
  scope: 'project' | 'cloud'
  selected: boolean
  origin: CapabilityOrigin
  toolNames: readonly string[]
  risk: 'high' | null
  /** Present for hooks whose member has a remote run scope. Core owns both digests. */
  hookDefinition?: HookDefinition | null
  /** Read-model stamp failure. It only blocks a new check, never removing an existing one. */
  sourceError?: string | null
}

export type CapabilityIdentity = {
  displayName: string
  teamRole: string
  professionalResponsibilities: string
  personalityTraits: readonly string[]
  workingPrinciples: string
  growthTopic: string
}

export type CapabilityCatalog = {
  agentId: string
  displayName: string
  teamRole: string
  runtime: string | null
  revision: string
  identity: CapabilityIdentity
  items: CapabilityItem[]
}

export type ProjectedCapability = {
  id: string
  name: string
  body: string
  origin: string
}

export type RunProjectionPreview = {
  agentId: string
  displayName: string
  runtime: string
  bootstrap: string
  mcp: unknown
  skills: ProjectedCapability[]
  rules: ProjectedCapability[]
  hooks: ProjectedCapability[]
}

export type CapabilitySelection = {
  kind: CapabilityKind
  id: string
  selected: boolean
}

export function conflictTools(items: readonly CapabilityItem[]): string[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (!item.selected) continue
    for (const tool of item.toolNames) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([tool]) => tool).sort()
}

export function conflictingKeys(items: readonly CapabilityItem[]): Set<string> {
  const tools = new Set(conflictTools(items))
  const keys = new Set<string>()
  for (const item of items) {
    if (item.selected && item.toolNames.some((tool) => tools.has(tool))) keys.add(itemKey(item))
  }
  return keys
}

export function toggleWouldConflict(items: readonly CapabilityItem[], kind: CapabilityKind, id: string): boolean {
  const item = items.find((entry) => entry.kind === kind && entry.id === id)
  if (!item || item.selected) return false
  const used = new Set(items.filter((entry) => entry.selected).flatMap((entry) => entry.toolNames))
  return item.toolNames.some((tool) => used.has(tool))
}

export function selectionCounts(items: readonly CapabilityItem[]): {
  skill: number
  mcp: number
  rule: number
  hook: number
  conflicts: number
} {
  const count = (kind: CapabilityKind) => items.filter((item) => item.kind === kind && item.selected).length
  return {
    skill: count('skill'),
    mcp: count('mcp'),
    rule: count('rule'),
    hook: count('hook'),
    conflicts: conflictTools(items).length
  }
}

export function isCatalogEmpty(items: readonly CapabilityItem[]): boolean {
  const extras = items.filter((item) => item.kind !== 'skill')
  const skills = items.filter((item) => item.kind === 'skill')
  return extras.length === 0 && skills.every((item) => !item.selected)
}

export function matchesQuery(item: CapabilityItem, query: string): boolean {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase('zh-CN')
  if (!needle) return true
  return `${item.name}\n${item.source}\n${item.note}`.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(needle)
}

export function itemKey(item: Pick<CapabilityItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`
}

export function selectionsOf(items: readonly CapabilityItem[]): CapabilitySelection[] {
  return items.map((item) => ({ kind: item.kind, id: item.id, selected: item.selected }))
}

export function sameSelection(left: readonly CapabilityItem[], right: readonly CapabilityItem[]): boolean {
  const signature = (items: readonly CapabilityItem[]) => items
    .map((item) => `${itemKey(item)}=${item.selected ? 1 : 0}`)
    .sort()
    .join('|')
  return signature(left) === signature(right)
}

/**
 * 任何非空的 Core runtime 名称都值得问一次真实预览：能不能给出投影由 Core 裁决
 * （runtime_required / runtime_unsupported），界面不再按品牌自己判死。
 * claude-code-cli 只是同一个运行端的旧持久化别名，请求仍用规范 id。
 */
export function previewRuntime(runtime: string | null): string | null {
  const name = runtime?.trim()
  if (!name) return null
  if (name === 'claude-code-cli') return 'claude-code'
  return name
}

export function highRiskToConfirm(draft: readonly CapabilityItem[], saved: readonly CapabilityItem[]): CapabilityItem[] {
  const savedOn = new Set(saved.filter((item) => item.selected).map(itemKey))
  return draft.filter((item) => item.risk === 'high' && item.selected && !savedOn.has(itemKey(item)))
}

export type HookApproval = { id: string, definitionDigest: string, scopeDigest: string }

export type HookReviewEntry = {
  id: string
  name: string
  body: string
  scope: HookReviewScope
  definitionDigest: string
  scopeDigest: string
}

/** Everything the confirmation sends. It is frozen when the dialog opens. */
export type HookReviewSnapshot = {
  agentId: string
  revision: string
  token: number
  acknowledgeHighRisk: boolean
  selections: CapabilitySelection[]
  approvals: HookApproval[]
  entries: HookReviewEntry[]
}

/** A hook needs exact approval only when it is selected and Core reports it unreviewed. */
export function pendingHookReview(items: readonly CapabilityItem[]): CapabilityItem[] {
  return items.filter((item) => item.kind === 'hook' && item.selected
    && !!item.hookDefinition && !item.hookDefinition.reviewed)
}

/** 只在 off → on 时生效的本地前置拒绝。取消选择永远不被拦。 */
export type SelectionRefusal = '' | 'source' | 'hook-scope'

/** Core 精确审阅范围里真正绑定目标的字段（与 Core 的 matches_target 同一组）。 */
const HOOK_SCOPE_KEYS = ['memberId', 'workspaceId', 'nodeId', 'workspaceRoot', 'workspaceTokenDigest', 'adapterKind'] as const

/**
 * 这条 hook 是否缺 Core 给出的可审阅定义。缺了就既不能审也不能新启用，
 * 但已经勾上的仍要能取消。这里只看 Core 给的定义，不猜品牌、系统或本地路径。
 */
export function hookDefinitionMissing(item: Pick<CapabilityItem, 'kind' | 'hookDefinition'>): boolean {
  if (item.kind !== 'hook') return false
  const definition = item.hookDefinition
  if (!definition) return true
  if (!definition.body.trim()) return true
  if (!definition.definitionDigest.trim() || !definition.scopeDigest.trim()) return true
  const scope = definition.reviewScope
  if (!scope) return true
  if (!Number.isFinite(scope.workspaceGeneration)) return true
  return HOOK_SCOPE_KEYS.some((key) => !String(scope[key] ?? '').trim())
}

/** Off to on only. A broken source never blocks unchecking; Core fails closed on its own. */
export function selectRefusal(item: CapabilityItem): SelectionRefusal {
  if (item.selected) return ''
  if (item.sourceError) return 'source'
  return hookDefinitionMissing(item) ? 'hook-scope' : ''
}

/** Returns null when a pending hook has no readable definition, so nothing can send an empty approval. */
export function hookReviewSnapshot(input: {
  agentId: string
  revision: string
  token: number
  acknowledgeHighRisk: boolean
  selections: readonly CapabilitySelection[]
  pending: readonly CapabilityItem[]
}): HookReviewSnapshot | null {
  const entries: HookReviewEntry[] = []
  for (const item of input.pending) {
    const definition = item.hookDefinition
    if (!definition) return null
    entries.push({
      id: item.id,
      name: item.name,
      body: definition.body,
      scope: definition.reviewScope,
      definitionDigest: definition.definitionDigest,
      scopeDigest: definition.scopeDigest
    })
  }
  entries.sort((left, right) => left.id.localeCompare(right.id))
  return {
    agentId: input.agentId,
    revision: input.revision,
    token: input.token,
    acknowledgeHighRisk: input.acknowledgeHighRisk,
    selections: input.selections.map((selection) => ({ ...selection })),
    approvals: entries.map((entry) => ({ id: entry.id, definitionDigest: entry.definitionDigest, scopeDigest: entry.scopeDigest })),
    entries
  }
}

/** A snapshot dies with its member or its request generation, not just its revision. */
export function snapshotApplies(snapshot: HookReviewSnapshot, agentId: string, token: number): boolean {
  return snapshot.agentId === agentId && snapshot.token === token
}

/** Cancel and stale-dialog recovery: drop only the keys that were never saved. */
export function revertPending(items: readonly CapabilityItem[], keys: ReadonlySet<string>): CapabilityItem[] {
  return items.map((item) => keys.has(itemKey(item)) ? { ...item, selected: false } : item)
}

export function conflictPartners(items: readonly CapabilityItem[], item: CapabilityItem): Array<{ names: string, tool: string }> {
  if (!item.selected) return []
  const hot = new Set(conflictTools(items))
  const lines: Array<{ names: string, tool: string }> = []
  for (const tool of item.toolNames) {
    if (!hot.has(tool)) continue
    const names = items
      .filter((other) => itemKey(other) !== itemKey(item) && other.selected && other.toolNames.includes(tool))
      .map((other) => other.name)
    if (names.length) lines.push({ names: names.join('、'), tool })
  }
  return lines
}

const SECRET_DISPLAY = '•••'
const API_SECRET_MASK = '********'

function tokenFlag(arg: string): boolean {
  const flag = arg.replace(/^-+/u, '').toLowerCase()
  return ['token', 'api-key', 'apikey', 'api_key', 'password', 'secret', 'access-token', 'auth'].includes(flag)
    || flag.endsWith('-token') || flag.endsWith('-key') || flag.endsWith('-secret') || flag.endsWith('-password')
}

function tokenLike(arg: string): boolean {
  const value = arg.trim()
  const lower = value.toLowerCase()
  return value === API_SECRET_MASK
    || lower.startsWith('sk-')
    || lower.startsWith('sk_')
    || lower.startsWith('ghp_')
    || lower.startsWith('github_pat_')
    || lower.startsWith('xox')
    || lower.startsWith('bearer ')
    || lower.startsWith('akia')
    || (value.length >= 32 && /^[0-9a-f]+$/iu.test(value))
}

function maskArgs(args: readonly unknown[]): unknown[] {
  let maskNext = false
  return args.map((arg) => {
    if (typeof arg !== 'string') {
      maskNext = false
      return arg
    }
    if (maskNext) {
      maskNext = false
      return SECRET_DISPLAY
    }
    const equals = arg.indexOf('=')
    if (equals > 0 && tokenFlag(arg.slice(0, equals))) {
      return `${arg.slice(0, equals)}=${SECRET_DISPLAY}`
    }
    if (tokenFlag(arg)) {
      maskNext = true
      return arg
    }
    return tokenLike(arg) ? SECRET_DISPLAY : arg
  })
}

/** Keys stay. Env, header, and token-like argument values are shown as bullets. */
export function presentProjectionMcp(document: unknown): unknown {
  if (!document || typeof document !== 'object') return document
  const copy = structuredClone(document) as Record<string, unknown>
  for (const key of ['mcpServers', 'mcp_servers']) {
    const servers = copy[key]
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue
    for (const server of Object.values(servers as Record<string, unknown>)) {
      if (!server || typeof server !== 'object' || Array.isArray(server)) continue
      const record = server as Record<string, unknown>
      for (const field of ['env', 'headers', 'http_headers']) {
        const entries = record[field]
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
        for (const name of Object.keys(entries as Record<string, unknown>)) {
          (entries as Record<string, unknown>)[name] = SECRET_DISPLAY
        }
      }
      if (Array.isArray(record.args)) record.args = maskArgs(record.args)
    }
  }
  return copy
}
