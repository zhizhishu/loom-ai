// Pure planning/config/verdict helpers for the real-UI acceptance run.
//
// Nothing here touches Chrome, a Host, a model or the network: every decision below is something a
// unit test can pin. The UI selectors are copied from the production sources that render them
// (`loom-native/Controls.tsx` for `SurfaceDialog`/`ChoiceMenu`, `loom-native/RoomDialog.tsx` for the
// room form, `loom-native/ControlPanel.tsx` for the relay scope), not guessed from class names.

export const LIVE_GATE_ENV = 'LOOM_ALLOW_LIVE_ACCEPTANCE'
export const HOST_CONFIG_ENV = 'LOOM_BROWSER_HOST_CONFIG'
export const TOKEN_ENV_REF = 'LOOM_ADMIN_TOKEN_ENV'
export const TOKEN_FILE_ENV = 'LOOM_ADMIN_TOKEN_FILE'
export const HOST_BIN_ENV = 'ROVAI_HOST_BIN'
export const PROVIDER_KEY_ENV = 'LOOM_E4_PROVIDER_KEY'

/** Exactly four roles, in the order the UI must be driven. */
export const ROLE_ORDER = Object.freeze(['lead', 'workerA', 'workerB', 'reviewer'])
export const WORKER_ROLES = Object.freeze(['workerA', 'workerB'])

/** Live acceptance is opt-in; anything but `1` means skip (never a mock pass). */
export function liveGate (env = process.env) {
  if (env[LIVE_GATE_ENV] === '1') return { allowed: true, reason: null }
  return { allowed: false, reason: `${LIVE_GATE_ENV}=1 is required; this run never drives the user's Chrome or a model by default` }
}

export function hostMode (env = process.env) {
  const value = env[HOST_CONFIG_ENV]
  return typeof value === 'string' && value.trim() !== '' ? 'external' : 'self'
}

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/u
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\/)/u

/**
 * Validate the external Host description. It is test input, never a second source of business truth:
 * only a loopback origin, absolute directories, and the four role identities are accepted.
 */
export function parseHostConfig (value) {
  const config = typeof value === 'string' ? JSON.parse(value) : value
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('host config must be a JSON object')
  const { origin, uiDirectory = null, fixtureDirectory = null, memberAgentIds = null, missionId = null } = config
  if (typeof origin !== 'string' || !LOOPBACK_ORIGIN.test(origin)
      || Number(LOOPBACK_ORIGIN.exec(origin)?.[1]) < 1
      || Number(LOOPBACK_ORIGIN.exec(origin)?.[1]) > 65535) {
    throw new Error('host config origin must be an HTTP loopback origin http://127.0.0.1:<port>')
  }
  for (const [label, directory] of [['uiDirectory', uiDirectory], ['fixtureDirectory', fixtureDirectory]]) {
    if (directory === null) continue
    if (typeof directory !== 'string' || !ABSOLUTE_PATH.test(directory)) throw new Error(`host config ${label} must be an absolute path`)
  }
  const roles = normalizeRoles(memberAgentIds)
  if (roles === null) throw new Error('memberAgentIds must name all four roles')
  return { origin, uiDirectory, fixtureDirectory, roles, missionId: typeof missionId === 'string' ? missionId : null }
}

/**
 * All four roles must be named by id and display name: the UI is driven by the visible roster, so an
 * id alone cannot be clicked. Anything less is refused instead of picking a random member.
 */
export function normalizeRoles (value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('memberAgentIds must be an object of {id, displayName}')
  const roles = {}
  for (const role of ROLE_ORDER) {
    const entry = value[role]
    if (entry === undefined) throw new Error(`memberAgentIds.${role} is required`)
    const agentId = typeof entry === 'string' ? entry.trim() : String(entry?.agentId ?? '').trim()
    const displayName = typeof entry === 'string' ? '' : String(entry?.displayName ?? '').trim()
    if (agentId === '') throw new Error(`memberAgentIds.${role}.agentId must be a non-empty string`)
    if (displayName === '') throw new Error(`memberAgentIds.${role}.displayName is required; the roster is clicked by name`)
    roles[role] = { agentId, displayName }
  }
  const seen = new Set()
  const names = new Set()
  for (const role of ROLE_ORDER) {
    if (seen.has(roles[role].agentId)) throw new Error(`memberAgentIds.${role} repeats another role's agent id`)
    seen.add(roles[role].agentId)
    if (names.has(roles[role].displayName)) throw new Error(`memberAgentIds.${role} repeats another role's displayName`)
    names.add(roles[role].displayName)
  }
  return roles
}

export function workerIds (roles) {
  return WORKER_ROLES.map(role => roles[role].agentId)
}

/**
 * Exactly one mission may appear between the baseline read and the post-UI read. Anything else
 * (zero, two, or a mission that predates this run) is refused rather than resolved by recency.
 */
export function pickNewMission (beforeRows, afterRows) {
  const before = new Set((Array.isArray(beforeRows) ? beforeRows : []).map(row => String(row?.missionId ?? '')))
  const fresh = (Array.isArray(afterRows) ? afterRows : []).filter(row => row?.missionId && !before.has(String(row.missionId)))
  if (fresh.length === 1) return { missionId: String(fresh[0].missionId), reason: null }
  return { missionId: null, reason: fresh.length === 0 ? 'no_new_mission' : `ambiguous_new_missions:${fresh.length}` }
}

/** Only the two worker-owned tasks may enter the approved relay scope. */
export function workerTasks (tasks, roles) {
  const ids = new Set(workerIds(roles))
  const rows = (Array.isArray(tasks) ? tasks : []).filter(task => ids.has(String(task?.assigneeAgentId ?? '')))
  const perWorker = WORKER_ROLES.map(role => rows.filter(task => task.assigneeAgentId === roles[role].agentId))
  return {
    tasks: rows,
    complete: rows.length === 2 && perWorker.every(list => list.length === 1),
    reason: rows.length === 2 ? null : `worker_tasks:${rows.length}`
  }
}

/**
 * Post-approval chain gate, derived from persisted Core facts only: dispatches must show EXECUTE and
 * REVIEW (and REWORK when the first round was rejected), every dispatch must be settled, both
 * candidates must be PENDING, and every archived artifact must match its registered digest.
 */
export function chainGate ({ dispatches = [], candidates = [], archiveChecks = [], reworkExpected = true } = {}) {
  const reasons = []
  const kinds = new Set(dispatches.map(row => String(row?.kind ?? '')))
  const statuses = dispatches.map(row => String(row?.status ?? ''))
  if (dispatches.length === 0) reasons.push('no_dispatch')
  if (!kinds.has('execute')) reasons.push('no_execute_dispatch')
  if (!kinds.has('review')) reasons.push('no_review_dispatch')
  if (reworkExpected && !kinds.has('rework')) reasons.push('no_rework_dispatch')
  if (statuses.some(status => status !== 'settled')) reasons.push('dispatch_not_settled')
  if (candidates.length < 2) reasons.push('candidates_missing')
  if (candidates.some(row => String(row?.acceptanceStatus ?? '') !== 'pending')) reasons.push('candidate_not_pending')
  if (archiveChecks.length === 0) reasons.push('archive_unverified')
  for (const check of archiveChecks) {
    if (check?.ok !== true) reasons.push(`archive_failed:${(check?.reasons ?? []).join('|') || 'unknown'}`)
  }
  return { ok: reasons.length === 0, reasons }
}

/** A screenshot that was not written is a gate failure, not a soft skip. */
export function screenshotGate (shot) {
  if (shot?.verified === true && Number(shot?.bytes ?? 0) > 0) return { ok: true, reason: null }
  return { ok: false, reason: shot?.reason ?? 'SCREENSHOT_UNVERIFIED' }
}

/**
 * How the administrator credential reaches this process; neither shape writes it to disk.
 * `env` names another variable that already holds it; `file` points at a file the isolated Host wrote.
 */
export function resolveAdminToken (env = process.env) {
  const reference = env[TOKEN_ENV_REF]
  if (typeof reference === 'string' && reference.trim() !== '') {
    const name = reference.trim()
    const value = env[name]
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${TOKEN_ENV_REF} names ${name}, which is empty`)
    return { kind: 'env', name, value: value.trim() }
  }
  const file = env[TOKEN_FILE_ENV]
  if (typeof file === 'string' && file.trim() !== '') return { kind: 'file', name: TOKEN_FILE_ENV, path: file.trim() }
  return { kind: 'none', name: null }
}

export function findSecretLeak (text, secrets = []) {
  const haystack = String(text ?? '')
  const hits = []
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    if (haystack.includes(secret)) hits.push(`${secret.slice(0, 4)}…`)
  }
  return hits
}

/**
 * Real DOM hooks, copied from the production renderers:
 * - `SurfaceDialog` content is `ln-surface-dialog` + the caller's className (`Controls.tsx:35`).
 * - `RoomDialog` passes `className="ln-room-dialog"` (RoomDialog.tsx:141).
 * - Work fields are `input[aria-label="工作名称"]` / `textarea[aria-label="工作目标"]` (RoomDialog.tsx:143-144).
 * - Members are `label.ln-room-person > input[type=checkbox][name=room-members]` (RoomDialog.tsx:146).
 * - The lead picker is `button.ln-choice[aria-label="选择主助手"]`, items are `.ln-choice-item`
 *   (`Controls.tsx:13-23`), so `[role=menuitem]` would never match a RadioItem.
 * - The relay panel is `ControlPanel.tsx` `.ln-control`, with `.ln-control-task`,
 *   `.ln-control-task-reviewer button.ln-choice`, `.ln-control-budgets input`.
 */
export const UI = Object.freeze({
  loginToken: '#administrator-token',
  loginSubmit: '.web-login button[type=submit]',
  loginOverlay: '.web-login-overlay',
  appRoot: '.ln-app',
  newConversation: '.ln-rail button[aria-label="开始新对话"]',
  runEntry: '.ln-rail button[aria-label="运行与成果"]',
  surfaceDialog: '.ln-surface-dialog',
  roomDialog: '.ln-surface-dialog.ln-room-dialog',
  roomTabs: 'nav.ln-segment-tabs button',
  workName: 'input[aria-label="工作名称"]',
  workGoal: 'textarea[aria-label="工作目标"]',
  memberRow: 'label.ln-room-person',
  memberCheckbox: 'label.ln-room-person input[type="checkbox"]',
  leadTrigger: 'button.ln-choice[aria-label="选择主助手"]',
  choiceItem: '.ln-choice-menu .ln-choice-item',
  startNow: 'label.ln-work-start-choice input[type="checkbox"]',
  roomSubmit: '.ln-room-dialog footer.ln-form-actions button.ln-action.is-primary',
  runDialog: '.ln-run-dialog',
  relay: '.ln-control',
  relayState: '.ln-control[data-control-state]',
  relayTask: '.ln-control-task',
  relayTaskTitle: '.ln-control-task-title',
  relayTaskMeta: '.ln-control-task-meta',
  relayTaskCheckbox: '.ln-control-task input[type="checkbox"]',
  relayReviewer: '.ln-control-task-reviewer button.ln-choice',
  relayBudget: '.ln-control-budgets input',
  relayOpen: '.ln-control .ln-action',
  relayApprove: '.ln-control .ln-form-actions .ln-action.is-primary',
  artifactRow: '.ln-run-panel .ln-run-artifact button.ln-run-file',
  artifactDialog: '.ln-artifact-dialog'
})

export const TEXT = Object.freeze({
  workMode: '共同完成工作',
  startNow: '创建后开始执行',
  createAndStart: '创建并开始',
  runSurface: '运行与成果',
  approveScope: '批准此范围',
  scopeOpen: ['批准接力范围', '修改接力范围', '重新批准范围']
})

/** Select the exact, user-visible task checkbox, not the nth checkbox in a
 * periodically refreshed list. A title alone may be used only when unique.
 * JSON-quoted CSS attribute strings keep quotes in task names from becoming
 * another selector or targeting a different task.
 */
export function relayTaskCheckboxSelector (taskTitle) {
  if (typeof taskTitle !== 'string' || taskTitle.trim() === '' || /[\r\n\0]/u.test(taskTitle)) {
    throw new Error('a nonempty single-line task title is required for exact UI selection')
  }
  return `.ln-control-task input[type="checkbox"][aria-label=${JSON.stringify(`纳入自动接力：${taskTitle}`)}]`
}

/** Page expression that reads the roster rows (name + checked) without mutating anything. */
export function rosterJs () {
  return `(() => [...document.querySelectorAll(${JSON.stringify(UI.memberRow)})].map(row => ({
  name: (row.querySelector('strong')?.textContent ?? '').trim(),
  checked: !!row.querySelector('input[type="checkbox"]')?.checked
})))()`
}

/** Page expression that marks (by attribute only) the roster row whose name matches. */
export function tagMemberJs (tag, displayName) {
  return `(() => {
  const wanted = ${JSON.stringify(displayName)}
  const rows = [...document.querySelectorAll(${JSON.stringify(UI.memberRow)})]
  const hit = rows.find(row => (row.querySelector('strong')?.textContent ?? '').trim() === wanted)
  if (!hit) return false
  hit.setAttribute('data-loom-qa', ${JSON.stringify(tag)})
  return true
})()`
}

export function tagByTextJs (selector, text, tag) {
  return `(() => {
  const wanted = ${JSON.stringify(text)}
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
  const hit = nodes.find(node => (node.textContent ?? '').trim().includes(wanted))
  document.querySelectorAll('[data-loom-qa]').forEach(node => { if (node.getAttribute('data-loom-qa') === ${JSON.stringify(tag)}) node.removeAttribute('data-loom-qa') })
  if (!hit) return false
  hit.setAttribute('data-loom-qa', ${JSON.stringify(tag)})
  return true
})()`
}

/** Mark the nth node of a selector list (used for task cards / budget fields). */
export function tagNthJs (selector, index, tag) {
  return `(() => {
  const node = [...document.querySelectorAll(${JSON.stringify(selector)})][${Number(index)}]
  if (!node) return false
  node.setAttribute('data-loom-qa', ${JSON.stringify(tag)})
  return true
})()`
}

/** Mark the choice item whose `<strong>` label matches exactly (reviewer / lead). */
export function tagChoiceItemJs (tag, label) {
  return `(() => {
  const wanted = ${JSON.stringify(label)}
  const items = [...document.querySelectorAll(${JSON.stringify(UI.choiceItem)})]
  const hit = items.find(item => (item.querySelector('strong')?.textContent ?? '').trim() === wanted)
  if (!hit) return { found: false, labels: items.map(item => (item.querySelector('strong')?.textContent ?? '').trim()) }
  hit.setAttribute('data-loom-qa', ${JSON.stringify(tag)})
  return { found: true, labels: items.map(item => (item.querySelector('strong')?.textContent ?? '').trim()) }
})()`
}

/** Read the relay panel state and facts (no mutation). */
export function relayStateJs () {
  return `(() => {
  const node = document.querySelector(${JSON.stringify(UI.relayState)})
  const facts = [...document.querySelectorAll('.ln-control-fact')].map(row => ({
    label: (row.querySelector('span')?.textContent ?? '').trim(),
    value: (row.querySelector('strong')?.textContent ?? '').trim()
  }))
  const tasks = [...document.querySelectorAll(${JSON.stringify(UI.relayTask)})].map(card => ({
    title: (card.querySelector(${JSON.stringify(UI.relayTaskTitle)})?.textContent ?? '').trim(),
    meta: (card.querySelector(${JSON.stringify(UI.relayTaskMeta)})?.textContent ?? '').trim()
  }))
  return { state: node?.getAttribute('data-control-state') ?? null, text: (node?.textContent ?? '').trim(), facts, tasks, editing: !!document.querySelector('.ln-control-budgets') }
})()`
}
