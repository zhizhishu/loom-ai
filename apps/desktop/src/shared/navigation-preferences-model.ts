import { isThreadId } from '@contracts'
import type { NavigationPin, NavigationPreferencesSnapshot, NavigationThreadReadState, RemovedNavigationProject } from '@contracts'
import { normalizeProjectDisplayName, projectDisplayNameError } from './project-display-name'

export const EMPTY_SNAPSHOT: NavigationPreferencesSnapshot = {
  schemaVersion: 6,
  registeredProjects: [],
  legacyProjectsSynced: false,
  pins: [],
  removedProjects: [],
  projectOrder: null,
  projectNames: {},
  threadReadStates: {}
}

export function sanitizeSnapshot(source: unknown): NavigationPreferencesSnapshot {
  if (!isRecord(source)) return structuredClone(EMPTY_SNAPSHOT)
  const pins = sanitizePins(source)
  const removedProjects = source.schemaVersion === 2 || source.schemaVersion === 3 || source.schemaVersion === 4 || source.schemaVersion === 5 || source.schemaVersion === 6
    ? sanitizeRemovedProjects(source.removedProjects)
    : []
  const projectOrder = source.schemaVersion === 3 || source.schemaVersion === 4 || source.schemaVersion === 5 || source.schemaVersion === 6
    ? sanitizeProjectOrder(source.projectOrder)
    : null
  const projectNames = (source.schemaVersion === 4 || source.schemaVersion === 5 || source.schemaVersion === 6) ? sanitizeProjectNames(source.projectNames) : {}
  const threadReadStates = (source.schemaVersion === 5 || source.schemaVersion === 6) ? sanitizeThreadReadStates(source.threadReadStates) : {}
  const registeredProjects = source.schemaVersion === 6 && Array.isArray(source.registeredProjects)
    ? [...new Set(source.registeredProjects.filter(isProjectPath))] : []
  const legacyProjectsSynced = source.schemaVersion === 6 && source.legacyProjectsSynced === true
  return { schemaVersion: 6, registeredProjects, legacyProjectsSynced, pins, removedProjects, projectOrder, projectNames, threadReadStates }
}

export function sanitizePins(source: Record<string, unknown>): NavigationPin[] {
  if (
    (source.schemaVersion !== 1 && source.schemaVersion !== 2 && source.schemaVersion !== 3 && source.schemaVersion !== 4 && source.schemaVersion !== 5 && source.schemaVersion !== 6)
    || !Array.isArray(source.pins)
  ) return []
  const seen = new Set<string>()
  const pins: NavigationPin[] = []
  for (const candidate of source.pins) {
    if (!isRecord(candidate)) continue
    const kind = candidate.kind
    const targetKey = candidate.targetKey
    if (
      (kind !== 'camp' && kind !== 'project')
      || typeof targetKey !== 'string'
      || (kind === 'camp'
        ? !isThreadId(targetKey)
        : !isProjectTargetKey(targetKey))
      || !isTimestamp(candidate.pinnedAt)
    ) continue
    const key = `${kind}:${targetKey}`
    if (seen.has(key)) continue
    seen.add(key)
    pins.push({
      kind,
      targetKey,
      pinnedAt: candidate.pinnedAt
    })
  }
  return pins.sort((left, right) =>
    left.pinnedAt.localeCompare(right.pinnedAt)
      || left.kind.localeCompare(right.kind)
      || left.targetKey.localeCompare(right.targetKey)
  )
}

export function sanitizeProjectOrder(source: unknown): string[] | null {
  if (source === null) return null
  if (!Array.isArray(source)) return null
  const seen = new Set<string>()
  const projectOrder: string[] = []
  for (const projectKey of source) {
    if (!isProjectTargetKey(projectKey) || seen.has(projectKey)) continue
    seen.add(projectKey)
    projectOrder.push(projectKey)
  }
  return projectOrder
}

export function sanitizeProjectNames(source: unknown): Record<string, string> {
  if (!isRecord(source)) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([key, name]) =>
    isProjectTargetKey(key) && typeof name === 'string' && !projectDisplayNameError(name)
      ? [[key, normalizeProjectDisplayName(name)]]
      : []
  ))
}

export function sanitizeRemovedProjects(source: unknown): RemovedNavigationProject[] {
  if (!Array.isArray(source)) return []
  const seen = new Set<string>()
  const projects: RemovedNavigationProject[] = []
  for (const candidate of source) {
    if (
      !isRecord(candidate)
      || !isProjectTargetKey(candidate.targetKey)
      || !isTimestamp(candidate.removedAt)
      || seen.has(candidate.targetKey)
    ) continue
    seen.add(candidate.targetKey)
    projects.push({
      targetKey: candidate.targetKey,
      removedAt: candidate.removedAt
    })
  }
  return projects.sort((left, right) =>
    left.removedAt.localeCompare(right.removedAt)
      || left.targetKey.localeCompare(right.targetKey)
  )
}

export function isProjectTargetKey(value: unknown): value is string {
  return isStableId(value) && value.startsWith('directory:')
}

export function isStableId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 8_192
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isNavigationThreadReadState(value: unknown): value is NavigationThreadReadState {
  return isRecord(value) && typeof value.manualUnread === 'boolean'
    && Number.isSafeInteger(value.readThroughGlobalSequence)
    && (value.readThroughGlobalSequence as number) >= 0
}

export function sanitizeThreadReadStates(source: unknown): Record<string, NavigationThreadReadState> {
  if (!isRecord(source)) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([id, state]) =>
    isThreadId(id) && isNavigationThreadReadState(state)
      ? [[id, { manualUnread: state.manualUnread, readThroughGlobalSequence: state.readThroughGlobalSequence }]]
      : []
  ))
}

export function isProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192
    && !value.includes('\0') && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value))
    && !value.split(/[\\/]/).some(part => part === '.' || part === '..')
}

export function registerNavigationProjects(snapshot: NavigationPreferencesSnapshot, paths: string[], completeLegacy = false): NavigationPreferencesSnapshot {
  if (!Array.isArray(paths) || !paths.every(isProjectPath)) throw new Error('Invalid project directories')
  // A delayed startup result can only fill gaps; it never undoes a user removal.
  if (completeLegacy && snapshot.legacyProjectsSynced) return snapshot
  const removed = new Set(snapshot.removedProjects.map(project => project.targetKey))
  const registered = [...new Set([...snapshot.registeredProjects, ...paths.filter(path => !removed.has(`directory:${path}`))])]
  const order = snapshot.projectOrder ?? []
  return { ...snapshot,
    projectOrder: [...new Set([...order, ...registered.map(path => `directory:${path}`)])],
    registeredProjects: registered,
    legacyProjectsSynced: snapshot.legacyProjectsSynced || completeLegacy }
}

export function sourceMatchesSupportedSnapshot(source: unknown, snapshot: NavigationPreferencesSnapshot): boolean {
  if (!isRecord(source) || ![1, 2, 3, 4, 5, 6].includes(source.schemaVersion as number)) return false
  const version = source.schemaVersion as number
  const expected: Record<string, unknown> = { schemaVersion: version, pins: snapshot.pins }
  if (version >= 2) expected.removedProjects = snapshot.removedProjects
  if (version >= 3) expected.projectOrder = snapshot.projectOrder
  if (version >= 4) expected.projectNames = snapshot.projectNames
  if (version >= 5) expected.threadReadStates = snapshot.threadReadStates
  if (version >= 6) {
    expected.registeredProjects = snapshot.registeredProjects
    expected.legacyProjectsSynced = snapshot.legacyProjectsSynced
  }
  return Object.keys(source).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => JSON.stringify(source[key]) === JSON.stringify(value))
}
