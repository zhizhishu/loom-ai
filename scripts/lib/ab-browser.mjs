// Thin, bounded façade over the supervisor's real-Chrome door (`ab.py`, protocol `browser-gate/1`).
//
// Corrected against the real door (scripts/ab.py:120-210, 326-374):
// - `ab.py` is PYTHON: `env.LOOM_AB_PYTHON || 'python'`. `process.execPath` is never used for it.
// - Every call is `ab.py call --budget N --max-bytes M -- <cli args>`; `ready` is the door's own verb
//   and is the only thing that may answer "can I call at all".
// - The reply is `{schema:'browser-gate/1', verdict, reason, data, artifact, tab, warnings}`:
//   the opened tab is `data.opened_tab_id`, and `data.js_return` is a JSON *string* clipped to 400
//   chars. A complete value is only reachable through `--max-bytes 1` -> `artifact.path` (spooled raw
//   CLI stdout), which this module reads under a strict root/size bound.
// - Every mutating verb requires an explicit tab id. There is no "current tab" default, so a stray
//   call can never act on the page the user is using.
// - A timeout is not a licence to replay; callers may only read a postcondition.

import { spawnSync } from 'node:child_process'
import { readFile, stat, lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export const DEFAULT_AB_PY = 'C:/Users/echo/.claude/skills/agent-browser-cli/scripts/ab.py'
export const GATE_SCHEMA = 'browser-gate/1'
export const DEFAULT_BUDGET_MS = 25_000
/** `ab.py` spools oversized raw output here (scripts/ab.py:11). */
export const ARTIFACT_DIR_MARKER = 'abcli-artifacts'
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

export function abPython (env = process.env) {
  const value = env.LOOM_AB_PYTHON
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'python'
}

export function abScript (env = process.env) {
  const value = env.LOOM_AB_PY
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_AB_PY
}

const DOOR_VERBS_WITH_BUDGET = new Set(['ready', 'text', 'snap', 'login'])

/** argv for a door verb (`ready` / `login` / …). Pure. */
export function doorInvocation (verb, args = [], { env = process.env, budgetSec = 20 } = {}) {
  const tail = DOOR_VERBS_WITH_BUDGET.has(verb) ? ['--budget', String(budgetSec)] : []
  return { command: abPython(env), args: [abScript(env), String(verb), ...args.map(String), ...tail] }
}

/** argv for `call -- …`. `--max-bytes` belongs to the wrapper, so it goes before the separator. Pure. */
export function callInvocation (cliArgs, { env = process.env, budgetSec = 15, maxBytes = 4096 } = {}) {
  if (!Array.isArray(cliArgs) || cliArgs.length === 0) throw new Error('ab.py call needs at least one CLI argument')
  return {
    command: abPython(env),
    args: [abScript(env), 'call', '--budget', String(budgetSec), '--max-bytes', String(maxBytes), '--', ...cliArgs.map(String)]
  }
}

/** Parse one door reply; anything that is not `browser-gate/1` is not a result. */
export function parseGateRecord (stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.schema !== GATE_SCHEMA) return null
  return parsed
}

function spawn (invocation, env, budgetMs) {
  const completed = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8', timeout: budgetMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env
  })
  const timedOut = completed.error?.code === 'ETIMEDOUT' || completed.signal === 'SIGTERM'
  return {
    record: timedOut ? null : parseGateRecord(completed.stdout),
    timedOut,
    stderr: String(completed.stderr ?? '').slice(0, 400)
  }
}

/** Normalised view of one door reply. Never carries argv (a `fill` may hold a credential). */
export function summarizeGate (record, timedOut) {
  if (timedOut) return { ok: false, verdict: 'UNKNOWN', reason: 'TIMEOUT_UNCONFIRMED', unconfirmed: true, data: null, artifact: null, tab: null, warnings: [] }
  if (record === null) return { ok: false, verdict: 'UNKNOWN', reason: 'INVALID_CLI_RESPONSE', unconfirmed: true, data: null, artifact: null, tab: null, warnings: [] }
  const verdict = record.verdict ?? 'UNKNOWN'
  return {
    ok: verdict === 'OK',
    verdict,
    reason: record.reason ?? 'UNKNOWN_CLI_ERROR',
    unconfirmed: verdict === 'UNKNOWN',
    data: record.data && typeof record.data === 'object' ? record.data : null,
    artifact: record.artifact && typeof record.artifact === 'object' ? record.artifact : null,
    tab: typeof record.tab === 'string' ? record.tab : null,
    warnings: Array.isArray(record.warnings) ? record.warnings : []
  }
}

export function runDoor (verb, args = [], { env = process.env, budgetMs = DEFAULT_BUDGET_MS, budgetSec = 20 } = {}) {
  const invocation = doorInvocation(verb, args, { env, budgetSec })
  const { record, timedOut } = spawn(invocation, env, budgetMs)
  return summarizeGate(record, timedOut)
}

export function runCall (cliArgs, { env = process.env, budgetMs = DEFAULT_BUDGET_MS, budgetSec = 15, maxBytes = 4096 } = {}) {
  const invocation = callInvocation(cliArgs, { env, budgetSec, maxBytes })
  const { record, timedOut } = spawn(invocation, env, budgetMs)
  return summarizeGate(record, timedOut)
}

/**
 * Read a spooled artifact under a strict bound: absolute path, inside the door's artifact directory,
 * regular non-symlink file, size cap. Returns the parsed JSON (or null) — never the raw text.
 */
export async function readSpooledArtifact (artifact) {
  const path = artifact?.path
  if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, json: null, reason: 'ARTIFACT_PATH_INVALID' }
  const root = resolve(tmpdir(), ARTIFACT_DIR_MARKER)
  const inside = target => {
    const offset = relative(root, target)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
  }
  if (!inside(resolve(path))) return { ok: false, json: null, reason: 'ARTIFACT_OUTSIDE_ROOT' }
  let info
  try {
    info = await lstat(path)
    if (info.isSymbolicLink() || !inside(await realpath(path)) || (await realpath(root)).toLowerCase() !== root.toLowerCase()) {
      return { ok: false, json: null, reason: 'ARTIFACT_OUTSIDE_ROOT' }
    }
  } catch {
    return { ok: false, json: null, reason: 'ARTIFACT_MISSING' }
  }
  if (!info.isFile()) return { ok: false, json: null, reason: 'ARTIFACT_NOT_FILE' }
  if (info.size <= 0) return { ok: false, json: null, reason: 'ARTIFACT_EMPTY' }
  if (info.size > MAX_ARTIFACT_BYTES) return { ok: false, json: null, reason: 'ARTIFACT_TOO_LARGE' }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return { ok: true, json: parsed, reason: null }
  } catch {
    return { ok: false, json: null, reason: 'ARTIFACT_NOT_JSON' }
  }
}

/** Full `result.js_return` of a spooled exec; the clipped `data.js_return` is never trusted. */
export async function fullJsReturn (result) {
  const artifact = await readSpooledArtifact(result.artifact)
  if (!artifact.ok) return { ok: false, value: null, reason: artifact.reason }
  const value = artifact.json?.result?.js_return
  return value === undefined ? { ok: false, value: null, reason: 'JS_RETURN_MISSING' } : { ok: true, value, reason: null }
}

/** `ready` is the only "can I call" answer; UNKNOWN is a cannot-confirm, not a pass. */
export function abReady (options = {}) {
  return runDoor('ready', [], { budgetSec: 20, ...options })
}

/** The only acceptable tab identity: `data.opened_tab_id` of this very call. Never a tab list. */
export function openedTabId (data) {
  const opened = data?.opened_tab_id
  return typeof opened === 'string' && opened !== '' && /^[0-9A-Za-z:_.-]{1,80}$/u.test(opened) ? opened : null
}

/** Open one URL. Without `data.opened_tab_id` the caller must stop — no tab is ever adopted. */
export function abOpen (url, options = {}) {
  const result = runCall(['open', String(url)], options)
  const tabId = openedTabId(result.data)
  return { ...result, openedTabId: tabId, confirmed: tabId !== null }
}

function requireTabId (tabId) {
  if (typeof tabId !== 'string' || tabId.trim() === '') {
    throw new Error('an explicit tab id is required: this door never acts on the current tab')
  }
  return tabId.trim()
}

/** Evaluate one expression and return the COMPLETE value from the spooled artifact. */
export async function abEval (tabId, expression, options = {}) {
  const tab = requireTabId(tabId)
  if (typeof expression !== 'string' || !/\breturn\b/u.test(expression)) throw new Error('abEval needs an expression that returns a value')
  const result = runCall(['exec', '--tab', tab, expression], { maxBytes: 1, ...options })
  if (!result.ok) return { ...result, value: null, valueReason: result.reason }
  const full = await fullJsReturn(result)
  return { ...result, value: full.value, valueReason: full.reason }
}

export function abClick (tabId, selector, options = {}) {
  return runCall(['click', String(selector), '--tab', requireTabId(tabId)], options)
}

export function abFill (tabId, selector, text, options = {}) {
  return runCall(['fill', String(selector), String(text), '--tab', requireTabId(tabId)], options)
}

/** Screenshot through the CLI (`--out`). `verified:false` means the gate did not pass. */
export function robustInvocation (tabId, selector, action, { env = process.env, open, value } = {}) {
  const tab = requireTabId(tabId)
  if (!['click', 'pick'].includes(action)) throw new Error('only trusted click and idempotent pick are supported')
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('an explicit selector is required')
  const args = [join(dirname(abScript(env)), 'robust_action.py'), '--tab', tab,
    '--selector', selector, '--action', action, '--gate-timeout', '4']
  if (open !== undefined) {
    if (action !== 'pick' || typeof open !== 'string' || !open.trim()) throw new Error('pick requires an explicit opener')
    args.push('--open', open)
  }
  if (value !== undefined) {
    if (action !== 'pick' || typeof value !== 'string') throw new Error('pick value must be a string')
    args.push('--value', value)
  }
  return { command: abPython(env), args }
}

function trustedAction (tabId, selector, action, options = {}) {
  const env = options.env ?? process.env
  const invocation = robustInvocation(tabId, selector, action, { ...options, env })
  const completed = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, env
  })
  if (completed.error || completed.signal) return { ok: false, verdict: 'UNKNOWN', reason: 'TRUSTED_ACTION_UNCONFIRMED' }
  let record
  try { record = JSON.parse(completed.stdout.trim()) } catch {
    return { ok: false, verdict: 'UNKNOWN', reason: 'INVALID_TRUSTED_ACTION_RESPONSE' }
  }
  const degraded = record.degraded && (Array.isArray(record.degraded) ? record.degraded.length > 0 : true)
  const ok = completed.status === 0 && record.ok === true && !degraded
  // Never forward argv, values, page content or raw output into evidence.
  const diagnostic = typeof record.error === 'string' ? record.error.match(/^[a-z_]+/u)?.[0] : null
  return { ok, verdict: ok ? 'OK' : 'FAILED', reason: ok ? 'NONE' : diagnostic ?? 'TRUSTED_ACTION_NOT_VERIFIED', action }
}

export function abTrustedClick (tabId, selector, options = {}) {
  return trustedAction(tabId, selector, 'click', options)
}

export function abPick (tabId, selector, options = {}) {
  return trustedAction(tabId, selector, 'pick', options)
}

export async function abScreenshot (tabId, outPath, options = {}) {
  const result = runCall(['screenshot', '--out', String(outPath), '--tab', requireTabId(tabId)], options)
  if (!result.ok) return { ...result, verified: false, bytes: null }
  try {
    const written = await stat(outPath)
    if (!written.isFile() || written.size === 0) return { ...result, verified: false, bytes: null, reason: 'SCREENSHOT_EMPTY' }
    return { ...result, verified: true, bytes: written.size }
  } catch {
    return { ...result, verified: false, bytes: null, reason: 'SCREENSHOT_MISSING' }
  }
}

/** A read-only postcondition after an unconfirmed action. Mutating expressions are refused. */
export async function abPostconditionRead (tabId, expression, options = {}) {
  if (/(\.click\(|dispatchEvent|\.submit\(|fetch\()/u.test(expression)) {
    throw new Error('postcondition reads must not mutate the page')
  }
  return abEval(tabId, expression, options)
}
