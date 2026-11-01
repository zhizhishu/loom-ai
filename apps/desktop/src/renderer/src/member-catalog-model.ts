export type CapabilityKind = 'skill' | 'mcp' | 'rule' | 'hook'
export type CapabilityOrigin = 'inherited' | 'explicit' | null

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

export function previewRuntime(runtime: string | null): string | null {
  if (runtime === 'codex-cli' || runtime === 'claude-code') return runtime
  if (runtime === 'claude-code-cli') return 'claude-code'
  return null
}

export function highRiskToConfirm(draft: readonly CapabilityItem[], saved: readonly CapabilityItem[]): CapabilityItem[] {
  const savedOn = new Set(saved.filter((item) => item.selected).map(itemKey))
  return draft.filter((item) => item.risk === 'high' && item.selected && !savedOn.has(itemKey(item)))
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
