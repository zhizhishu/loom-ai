// LOOM V2 — per-run Pi 0.85.1 tool PATH GUARD (native extension, loaded with an explicit
// `--extension <this file>`; never auto-discovered).
//
// Why this file exists (Root contract, 2026-11-16 review):
// - `--tools read,write,edit` only allowlists tool NAMES. The native read/write/edit tools accept
//   absolute paths, so the cwd / allowlist is NOT a path sandbox. This extension is the actual
//   per-call path gate: it intercepts `tool_call` BEFORE execution (Pi types:
//   dist/core/extensions/types.d.ts:679 `type:"tool_call"`, :818 `ToolCallEventResult.block`,
//   :939 `on("tool_call", ...)`) and returns `{block:true, reason}` for anything outside the
//   granted workspace.
// - It is fail-closed: a missing/invalid grant, a failed load-time self-test, an expired grant, a
//   cwd that is not the granted workspace, an internal error, or an unknown tool all BLOCK.
// - It never mutates `event.input` and never executes anything itself.
//
// Evidence: every decision is appended as one JSON line to the run's private log file
// (`LOOM_RUN_GUARD.logPath`, inside the run's mkdtemp root). Lines carry the toolCallId, the tool
// name, the decision, a stable reason code, the workspace-relative path (only when the path is
// inside the workspace) and sha256 of the raw path string. Out-of-scope paths are NEVER written in
// plaintext, so the log cannot leak user directories.
//
// Boundaries: no network, no child processes, no global config, no writes outside the log file and
// the paths Pi itself would have written (which this guard only permits inside the workspace).
// OS-level sandboxing is explicitly NOT claimed: this is a tool-call path policy, not an OS jail.

import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const CONFIG_ENV = 'LOOM_RUN_GUARD'
const GUARD_SCHEMA = 'loom.runtime.file-guard.v1'
const GUARD_TOOLS = Object.freeze(['read', 'write', 'edit'])

// Deny-listed path segments (lowercased, compared per segment) and suffixes. A grant never grants
// VCS internals, credentials, auth/models config, or private keys, even inside the workspace.
const SENSITIVE_SEGMENTS = Object.freeze([
  '.git', '.ssh', '.gnupg', '.aws', '.env', '.npmrc', '.netrc', '.pgpass',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'auth.json', 'models.json', 'trust.json', 'credentials', 'credentials.json'
])
const SENSITIVE_SUFFIXES = Object.freeze(['.pem', '.key', '.pfx', '.p12', '.kdbx', '.keystore', '.jks'])
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const IS_WIN = process.platform === 'win32'

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizeSeparators(value) {
  return value.split(sep).join('/')
}

function compareKey(value) {
  const unified = normalizeSeparators(value)
  return IS_WIN ? unified.toLowerCase() : unified
}

function inside(child, parent) {
  const c = compareKey(child)
  const p = compareKey(parent)
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch {
    return null
  }
}

function realpathOrNull(target) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

/**
 * Reject path syntax that must never reach a tool, before any filesystem access.
 * Returns a stable reason code, or null when the syntax is acceptable.
 */
function rejectSyntax(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return 'path_missing'
  if (rawPath.includes('\0')) return 'path_nul_byte'
  if (rawPath === '.') return 'path_is_workspace_root'
  // Reject traversal before Windows trailing-dot checks: ".." must have the stable
  // parent-escape refusal reason on every platform, including Windows.
  if (rawPath.split(/[\\/]+/).some((segment) => segment === '..')) return 'path_parent_escape'
  if (IS_WIN) {
    if (/^\\\\[?.]\\/.test(rawPath)) return 'path_device_namespace'
    if (/^\\\\/.test(rawPath)) return 'path_unc'
    if (/^[A-Za-z]:(?![\\/])/.test(rawPath)) return 'path_drive_relative'
    // The drive prefix itself carries a colon; only the path BODY is checked for stream/device forms.
    const body = /^[A-Za-z]:/.test(rawPath) ? rawPath.slice(2) : rawPath
    const segments = body.split(/[\\/]+/).filter((segment) => segment.length > 0)
    for (const segment of segments) {
      if (segment.includes(':')) return 'path_alternate_data_stream'
      if (/[. ]$/.test(segment)) return 'path_trailing_dot_or_space'
      if (RESERVED_DEVICE.test(segment)) return 'path_reserved_device_name'
    }
  }
  return null
}

function sensitiveReason(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0)
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    if (lower.startsWith('.env')) return 'sensitive_env_file'
    if (SENSITIVE_SEGMENTS.includes(lower)) return `sensitive_path:${lower}`
    if (SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return 'sensitive_path_suffix'
  }
  return null
}

/** Walk every existing segment below the workspace root; any symlink/junction is a refusal. */
function symlinkSegmentReason(workspaceReal, target) {
  const offset = relative(workspaceReal, target)
  if (offset === '') return null
  if (offset.startsWith('..') || isAbsolute(offset)) return 'path_outside_workspace'
  let current = workspaceReal
  for (const segment of offset.split(sep)) {
    current = resolve(current, segment)
    const stat = lstatOrNull(current)
    if (!stat) return null
    if (stat.isSymbolicLink()) return 'path_symlink_escape'
  }
  return null
}

/**
 * Decide one tool path.
 *
 * @param {unknown} rawPath the tool argument `path`
 * @param {{cwd: string, workspaceReal: string, toolName: string, fsMode?: boolean}} options
 *   `fsMode:false` skips every filesystem probe and is used only by the load-time self-test.
 * @returns {{decision: 'allow'|'block', reasonCode: string, resolved: string|null}}
 */
export function evaluatePath(rawPath, options) {
  const { cwd, workspaceReal, toolName, fsMode = true } = options
  const syntax = rejectSyntax(rawPath)
  if (syntax) return { decision: 'block', reasonCode: syntax, resolved: null }

  const absolute = resolve(cwd, rawPath)
  if (!inside(absolute, workspaceReal)) {
    return { decision: 'block', reasonCode: 'path_outside_workspace', resolved: null }
  }
  const offset = relative(workspaceReal, absolute)
  if (offset === '') return { decision: 'block', reasonCode: 'path_is_workspace_root', resolved: null }
  const sensitive = sensitiveReason(offset)
  if (sensitive) return { decision: 'block', reasonCode: sensitive, resolved: null }

  if (!fsMode) return { decision: 'allow', reasonCode: 'in_workspace', resolved: absolute }

  const stat = lstatOrNull(absolute)
  if (stat && stat.isSymbolicLink()) return { decision: 'block', reasonCode: 'path_symlink_escape', resolved: null }
  if (toolName === 'read' || toolName === 'edit') {
    if (!stat) return { decision: 'block', reasonCode: 'path_missing_for_tool', resolved: null }
    if (!stat.isFile()) return { decision: 'block', reasonCode: 'path_not_regular_file', resolved: null }
    // A hardlink shares one inode with a file outside the workspace: lstat/realpath both report an
    // ordinary in-workspace file, so the link count is the only local signal. Reading or editing it
    // would hand outside content to the model (or rewrite it), so it is refused outright.
    if (stat.nlink > 1) return { decision: 'block', reasonCode: 'path_hardlink_escape', resolved: null }
  } else if (toolName === 'write') {
    if (stat && !stat.isFile()) return { decision: 'block', reasonCode: 'path_not_regular_file', resolved: null }
    // Overwriting a multiply-linked file would mutate the outside copy too. Creating a NEW file is
    // unaffected (stat is null there).
    if (stat && stat.nlink > 1) return { decision: 'block', reasonCode: 'path_hardlink_escape', resolved: null }
  } else {
    return { decision: 'block', reasonCode: 'tool_not_guarded', resolved: null }
  }

  const symlink = symlinkSegmentReason(workspaceReal, absolute)
  if (symlink) return { decision: 'block', reasonCode: symlink, resolved: null }

  const real = realpathOrNull(absolute)
  if (real !== null) {
    if (!inside(real, workspaceReal)) return { decision: 'block', reasonCode: 'path_realpath_outside_workspace', resolved: null }
    return { decision: 'allow', reasonCode: 'in_workspace', resolved: real }
  }

  // The target (or part of it) does not exist yet — only `write` may create it. Verify the nearest
  // existing ancestor: it must not be a symlink and its real path must stay inside the workspace.
  let probe = absolute
  for (;;) {
    const parent = resolve(probe, '..')
    if (parent === probe) return { decision: 'block', reasonCode: 'path_no_existing_ancestor', resolved: null }
    probe = parent
    const ancestor = lstatOrNull(probe)
    if (!ancestor) continue
    if (ancestor.isSymbolicLink()) return { decision: 'block', reasonCode: 'path_symlink_escape', resolved: null }
    const ancestorReal = realpathOrNull(probe)
    if (ancestorReal === null) return { decision: 'block', reasonCode: 'path_realpath_failed', resolved: null }
    if (!inside(ancestorReal, workspaceReal)) {
      return { decision: 'block', reasonCode: 'path_ancestor_outside_workspace', resolved: null }
    }
    return { decision: 'allow', reasonCode: 'in_workspace_new_file', resolved: absolute }
  }
}

// ---------------------------------------------------------------------------
// Load-time self-test (pure path policy; no filesystem, no side effects)
// ---------------------------------------------------------------------------

function selfTestWorkspace() {
  return IS_WIN ? 'C:\\loom-guard-selftest\\ws' : '/loom-guard-selftest/ws'
}

function selfTestCases() {
  const workspace = selfTestWorkspace()
  const outside = IS_WIN ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd'
  const sepChar = IS_WIN ? '\\' : '/'
  const cases = [
    { path: 'notes.md', expect: 'allow' },
    { path: 'sub/notes.md', expect: 'allow' },
    // Positive: an ABSOLUTE path inside the workspace is legitimate and must be allowed. This is the
    // case that proves the Windows drive prefix is skipped for the ADS/device checks only.
    { path: `${workspace}${sepChar}sub${sepChar}notes.md`, expect: 'allow' },
    { path: 'sub/../notes.md', expect: 'block', reason: 'path_parent_escape' },
    { path: outside, expect: 'block', reason: 'path_outside_workspace' },
    { path: '.git/config', expect: 'block', reason: 'sensitive_path:.git' },
    { path: '.env', expect: 'block', reason: 'sensitive_env_file' },
    { path: 'id_rsa', expect: 'block', reason: 'sensitive_path:id_rsa' },
    { path: 'certs/key.pem', expect: 'block', reason: 'sensitive_path_suffix' },
    { path: '', expect: 'block', reason: 'path_missing' },
    // Built with fromCharCode so the NUL byte survives any source serialization.
    { path: `nul${String.fromCharCode(0)}byte.txt`, expect: 'block', reason: 'path_nul_byte' }
  ]
  if (IS_WIN) {
    cases.push(
      { path: '\\\\server\\share\\x.txt', expect: 'block', reason: 'path_unc' },
      { path: '\\\\?\\C:\\Windows\\win.ini', expect: 'block', reason: 'path_device_namespace' },
      { path: 'C:relative.txt', expect: 'block', reason: 'path_drive_relative' },
      { path: 'sub\\file.txt:stream', expect: 'block', reason: 'path_alternate_data_stream' },
      // An absolute in-workspace path carrying an ADS is still refused.
      { path: `${workspace}\\notes.txt:stream`, expect: 'block', reason: 'path_alternate_data_stream' },
      { path: 'CON', expect: 'block', reason: 'path_reserved_device_name' },
      { path: 'sub\\notes.txt ', expect: 'block', reason: 'path_trailing_dot_or_space' }
    )
  }
  return { workspace, cases }
}

export function runSelfTest() {
  const { workspace, cases } = selfTestCases()
  const failures = []
  for (const testCase of cases) {
    let outcome
    try {
      outcome = evaluatePath(testCase.path, { cwd: workspace, workspaceReal: workspace, toolName: 'read', fsMode: false })
    } catch (error) {
      failures.push({ path: testCase.path, expected: testCase.expect, actual: 'threw', reasonCode: String(error?.message ?? error) })
      continue
    }
    if (outcome.decision !== testCase.expect) {
      failures.push({ path: testCase.path, expected: testCase.expect, actual: outcome.decision, reasonCode: outcome.reasonCode })
      continue
    }
    if (testCase.reason && outcome.reasonCode !== testCase.reason) {
      failures.push({ path: testCase.path, expected: testCase.reason, actual: outcome.reasonCode, reasonCode: outcome.reasonCode })
    }
  }
  return { cases: cases.length, failures }
}

// ---------------------------------------------------------------------------
// Grant loading
// ---------------------------------------------------------------------------

// Production source: Core writes this file into the private Host root (one file per Host, rewritten
// on every binding generation). The isolated Runner keeps using `LOOM_RUN_GUARD`, so both paths share
// exactly one validation routine and one path policy.
const GRANT_FILE_ENV = 'ROVAI_PI_FILE_GRANT_FILE'

/** Validate a parsed grant object. Shared by the env source and the Core-written file source. */
function validateGrantObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'guard_config_not_object' }
  if (parsed.schema !== GUARD_SCHEMA) return { ok: false, reason: 'guard_schema_mismatch' }
  if (typeof parsed.runId !== 'string' || parsed.runId.length === 0) return { ok: false, reason: 'guard_run_id_missing' }
  if (typeof parsed.botId !== 'string' || parsed.botId.length === 0) return { ok: false, reason: 'guard_bot_id_missing' }
  if (typeof parsed.logPath !== 'string' || parsed.logPath.length === 0) return { ok: false, reason: 'guard_log_path_missing' }
  if (typeof parsed.workspaceReal !== 'string' || !isAbsolute(parsed.workspaceReal)) return { ok: false, reason: 'guard_workspace_missing' }
  if (!Array.isArray(parsed.allowedTools) || parsed.allowedTools.length === 0) return { ok: false, reason: 'guard_tools_missing' }
  if (!parsed.allowedTools.every((tool) => GUARD_TOOLS.includes(tool))) return { ok: false, reason: 'guard_tools_not_permitted' }
  if (!Number.isInteger(parsed.expiresAtEpochMs) || parsed.expiresAtEpochMs <= 0) return { ok: false, reason: 'guard_expiry_missing' }
  return { ok: true, grant: parsed }
}

/** Read the Core-written grant file. Refuses symlinks, non-files and oversized content. */
function loadGrantFromFile(pathValue) {
  if (typeof pathValue !== 'string' || !isAbsolute(pathValue)) return { ok: false, reason: 'guard_grant_file_path_invalid' }
  let stat
  try {
    stat = lstatSync(pathValue)
  } catch {
    return { ok: false, reason: 'guard_grant_file_missing' }
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'guard_grant_file_not_regular' }
  if (stat.size > 64 * 1024) return { ok: false, reason: 'guard_grant_file_too_large' }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(pathValue, 'utf8'))
  } catch {
    return { ok: false, reason: 'guard_grant_file_unparsable' }
  }
  return validateGrantObject(parsed)
}

function loadGrant() {
  const raw = process.env[CONFIG_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    const fromFile = process.env[GRANT_FILE_ENV]
    if (typeof fromFile === 'string' && fromFile.trim().length > 0) return loadGrantFromFile(fromFile)
    return { ok: false, reason: 'guard_config_missing' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'guard_config_unparsable' }
  }
  return validateGrantObject(parsed)
}

function toWorkspaceRelative(target, workspaceReal) {
  const offset = relative(workspaceReal, target)
  if (offset === '' || offset.startsWith('..') || isAbsolute(offset)) return null
  return normalizeSeparators(offset)
}

// ---------------------------------------------------------------------------
// Extension factory (Pi calls this with the ExtensionAPI)
// ---------------------------------------------------------------------------

export default async function loomRuntimeFileGuard(pi) {
  const loaded = loadGrant()
  if (!loaded.ok) {
    // No usable grant: refuse every tool call. stderr is safe (stdout is the RPC channel).
    try {
      process.stderr.write(`[loom-guard] ${loaded.reason}\n`)
    } catch {}
    pi.on('tool_call', (event) => ({
      block: true,
      reason: `LOOM guard blocked ${String(event?.toolName ?? 'tool')}: ${loaded.reason}`
    }))
    return
  }

  const grant = loaded.grant
  // A log write is part of the decision: if we cannot record what happened, we cannot allow it.
  const log = (record) => {
    try {
      appendFileSync(grant.logPath, `${JSON.stringify(record)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  const selfTest = runSelfTest()
  const selfTestFailed = selfTest.failures.length > 0
  const cwdReal = realpathOrNull(process.cwd())

  const selfTestLogged = log({
    t: 'guard_selftest',
    at: Date.now(),
    cases: selfTest.cases,
    failures: selfTest.failures.length,
    failureDetail: selfTest.failures.slice(0, 8)
  })
  const readyLogged = log({
    t: 'guard_ready',
    at: Date.now(),
    pid: process.pid,
    ppid: process.ppid,
    runId: grant.runId ?? null,
    botId: grant.botId ?? null,
    schema: GUARD_SCHEMA,
    workspaceReal: grant.workspaceReal,
    allowedTools: grant.allowedTools,
    expiresAtEpochMs: grant.expiresAtEpochMs,
    cwdReal,
    selfTestFailures: selfTest.failures.length
  })
  // Without a durable guard_ready the runner cannot prove this run is guarded, so nothing may run.
  const startupFailure = selfTestFailed
    ? 'guard_selftest_failed'
    : !selfTestLogged || !readyLogged
      ? 'guard_log_write_failed'
      : null

  pi.on('tool_call', (event, ctx) => {
    const at = Date.now()
    const toolName = typeof event?.toolName === 'string' ? event.toolName : ''
    const toolCallId = typeof event?.toolCallId === 'string' ? event.toolCallId : null
    const rawPath = event?.input?.path

    // A block whose own record cannot be written is still a block: the tool never runs.
    const block = (reasonCode, extra = {}) => {
      log({ t: 'decision', at, toolCallId, toolName, decision: 'block', reasonCode, ...extra })
      return { block: true, reason: `LOOM guard blocked ${toolName || 'tool'}: ${reasonCode}` }
    }

    try {
      if (startupFailure) return block(startupFailure)
      if (at > grant.expiresAtEpochMs) return block('grant_expired')
      if (!GUARD_TOOLS.includes(toolName)) return block('tool_not_allowed')
      if (!grant.allowedTools.includes(toolName)) return block('tool_not_granted')

      const handlerCwd = typeof ctx?.cwd === 'string' && ctx.cwd.length > 0 ? realpathOrNull(ctx.cwd) : null
      if (handlerCwd === null) return block('cwd_unresolvable')
      if (compareKey(handlerCwd) !== compareKey(grant.workspaceReal)) return block('cwd_mismatch')

      const outcome = evaluatePath(rawPath, { cwd: handlerCwd, workspaceReal: grant.workspaceReal, toolName, fsMode: true })
      const pathSha256 = sha256(typeof rawPath === 'string' ? rawPath : '')
      const relPath = outcome.resolved ? toWorkspaceRelative(outcome.resolved, grant.workspaceReal) : null
      const decisionLogged = log({
        t: 'decision',
        at,
        toolCallId,
        toolName,
        decision: outcome.decision,
        reasonCode: outcome.reasonCode,
        relPath,
        pathSha256
      })
      // Unrecordable decision => refuse, even when the path itself was acceptable.
      if (!decisionLogged) return block('guard_log_write_failed', { supersededDecision: outcome.decision })
      if (outcome.decision === 'block') {
        return { block: true, reason: `LOOM guard blocked ${toolName}: ${outcome.reasonCode}` }
      }
      return undefined
    } catch (error) {
      log({
        t: 'decision',
        at,
        toolCallId,
        toolName,
        decision: 'block',
        reasonCode: 'guard_internal_error',
        errorName: error?.name ?? 'Error'
      })
      return { block: true, reason: `LOOM guard blocked ${toolName || 'tool'}: guard_internal_error` }
    }
  })
}
