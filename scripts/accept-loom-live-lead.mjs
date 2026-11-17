#!/usr/bin/env node
// LOOM live Lead acceptance: one real commercial model plans a Mission with the `rovai` LOOM CLI,
// two other real model Runs deliver their own files/evidence/candidates, and a fourth, separate
// reviewer Run records the authorized stage review — including one real rework round.
//
// Honesty envelope (never relaxed at runtime, mirrored into the evidence file):
// - Trigger is the Core stdio RPC service path (`missions.start`, `loom.control.configure`). The
//   packaged UI path is NOT exercised: `uiObserved:false`, `finalFullChainClaim:false`.
// - The Host only builds the fixture (members, Mission, one bounded approval). It never calls
//   `loom.plan.import`, `loom.task.release`, `loom.claim.acquire`, `loom.artifact.register`,
//   `loom.candidate.record` or `loom.review.record`; `createHostRequestGuard` refuses them.
// - The runtime is Pi *native* (member permission defaults preserved: no `loom_file_access` write,
//   no `piPurge` selection). No file guard is installed, so no `guard.jsonl` is expected or claimed.
// - `loom.reviews.list` is the *Owner* review axis. The model stage review is read from
//   `loom.control.get` → `stageReviews`. Success requires OwnerReview === 0.
// - First-draft / reworked text is read from `loom.artifact.preview`, i.e. the immutable archive,
//   and re-hashed there. The mutable workspace is reported only as separate drift and can never
//   re-judge an archived candidate.
// - After the Owner approval, Core itself must start the Workers (`EXECUTE` dispatch); the Host
//   never releases a task, claims, registers evidence or submits a candidate.
// - A hanging receipt or a timeout keeps the fixture and the evidence and closes only this Core.
//   Nothing is retried with a second request, and no model output is ever simulated.

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import {
  readPiBundleManifest,
  redactDiagnosticText,
  resolveBuiltinToolHelper,
  startIsolatedCore,
  verifyCoreBinary
} from './loom-v2-core-native-pi.mjs'

const REPOSITORY = resolve(import.meta.dirname, '..')
const DEFAULT_CONFIG = join(
  REPOSITORY, '_artifacts', 'loom-personal-delivery-20261116', 'live-dual.public-config.json'
)
const DEFAULT_GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const GIT_BASH_CANDIDATES = [
  DEFAULT_GIT_BASH,
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe'
]
const ACCEPTANCE_MARKER = 'LIVE-LEAD-ACCEPTANCE'
const REVISION_MARKER = 'REVIEW-REVISION-2'
const PROVIDER_KEY_ENV = 'LOOM_E4_PROVIDER_KEY'
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const LEAD_START_BUDGET_MS = 180_000
const READY_BUDGET_MS = 180_000
const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled']
const PENDING_DISPATCH_STATUSES = ['waiting', 'dispatched']

/** Methods only a model may call. A Host that calls one of these fabricates a model result. */
export const FORBIDDEN_HOST_METHODS = Object.freeze([
  'loom.plan.import',
  'loom.task.release',
  'loom.claim.acquire',
  'loom.artifact.register',
  'loom.candidate.record',
  'loom.review.record'
])

/** The only OS keys this harness ever inherits; every credential-shaped key is refused. */
const OS_ENV_ALLOWLIST = Object.freeze([
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'USERNAME',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'CommonProgramW6432', 'PUBLIC', 'ALLUSERSPROFILE'
])
const CREDENTIAL_SHAPED_ENV = /(API_?KEY|_TOKEN|TOKEN_|SECRET|PASSWORD|OAUTH|CREDENTIAL|AUTH_)/i

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested by scripts/lib/accept-loom-live-lead.test.mjs)
// ---------------------------------------------------------------------------

/** Parse and validate this script's CLI. Unknown flags and bad numbers are refused, never guessed. */
export function parseCliArgs (argv = []) {
  const options = {
    configPath: DEFAULT_CONFIG,
    evidenceRoot: null,
    gitBash: null,
    keepFixture: false,
    pollMs: 1500,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false
  }
  const positiveInt = (flag, raw) => {
    const value = Number.parseInt(raw ?? '', 10)
    if (!Number.isFinite(value) || value <= 0 || String(value) !== String(raw).trim()) {
      throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(raw ?? null)}`)
    }
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index])
    const next = argv[index + 1]
    if (argument === '--keep-fixture') { options.keepFixture = true; continue }
    if (argument === '--json') { options.json = true; continue }
    if (argument === '--help' || argument === '-h') { options.help = true; continue }
    const takesValue = ['--config', '--evidence-root', '--git-bash', '--timeout-ms', '--poll-ms']
    if (takesValue.includes(argument)) {
      if (typeof next !== 'string' || next.length === 0 || next.startsWith('--')) {
        throw new Error(`${argument} needs a value`)
      }
      if (argument === '--config') options.configPath = resolve(next)
      else if (argument === '--evidence-root') options.evidenceRoot = resolve(next)
      else if (argument === '--git-bash') options.gitBash = resolve(next)
      else if (argument === '--timeout-ms') options.timeoutMs = positiveInt(argument, next)
      else options.pollMs = positiveInt(argument, next)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

/** Deep secret redaction. Returns a copy; the input (and its Buffers) are never mutated. */
export function redactDeep (value, secrets = []) {
  const list = (Array.isArray(secrets) ? secrets : [secrets])
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
  const walk = (input) => {
    if (typeof input === 'string') {
      let out = input
      for (const secret of list) out = out.split(secret).join('[redacted]')
      return out.replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    }
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === 'object') {
      const out = {}
      for (const [key, nested] of Object.entries(input)) out[key] = walk(nested)
      return out
    }
    return input
  }
  return walk(value)
}

/**
 * Wrap `core.request` so the Host can only read state, create the fixture and approve one policy.
 * Every attempted method is counted (including a refused one) so the evidence can show exactly
 * which RPCs the Host used and which ones it was denied.
 */
export function createHostRequestGuard (request, { forbidden = FORBIDDEN_HOST_METHODS } = {}) {
  const counts = new Map()
  const rejected = []
  const guarded = async (method, params = {}, timeoutMs) => {
    const name = String(method)
    if (forbidden.includes(name)) {
      rejected.push({ method: name, at: new Date().toISOString() })
      throw Object.assign(
        new Error(`the Host may not call ${name}: a model must produce this result`),
        { code: 'HOST_METHOD_FORBIDDEN', method: name }
      )
    }
    counts.set(name, (counts.get(name) ?? 0) + 1)
    return timeoutMs === undefined ? request(name, params) : request(name, params, timeoutMs)
  }
  return {
    request: guarded,
    rejected,
    forbidden: [...forbidden],
    callCounts: () => Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    methodNames: () => [...counts.keys()].sort()
  }
}

/** Isolated PATH kept in one place: OS dirs, the Pi bundle node dir, then the Git Bash dirs. */
export function isolatedPathEntries ({ systemRoot, bundleNodeDir, gitDirs = [] } = {}) {
  if (typeof systemRoot !== 'string' || systemRoot.length === 0) {
    throw new Error('isolatedPathEntries needs the Windows SystemRoot')
  }
  const entries = [join(systemRoot, 'System32'), systemRoot, bundleNodeDir, ...gitDirs]
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
  const seen = new Set()
  const out = []
  for (const entry of entries) {
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/** Resolve the bash Pi will run `rovai loom ...` in. Absent → the run cannot start (exit 2). */
export function resolveGitBash ({ explicitPath = null, exists = existsSync, candidates = GIT_BASH_CANDIDATES } = {}) {
  const tried = []
  const ordered = explicitPath ? [explicitPath] : candidates
  for (const candidate of ordered) {
    tried.push(candidate)
    if (exists(candidate)) {
      return {
        path: candidate,
        source: explicitPath ? 'explicit' : 'well-known',
        tried,
        // `bin` carries bash.exe/git.exe, `usr/bin` carries the coreutils a bash -c needs.
        pathEntries: [dirname(candidate), join(dirname(dirname(candidate)), 'usr', 'bin')]
      }
    }
  }
  return { path: null, source: explicitPath ? 'explicit' : 'well-known', tried, pathEntries: [] }
}

/**
 * The Mission description is the *user goal*, not a plan: it names no task id, no criterion list
 * and no file path, so the Lead still has to author the whole plan itself.
 */
export function buildMissionDescription ({ workers, acceptanceMarker = ACCEPTANCE_MARKER, revisionMarker = REVISION_MARKER } = {}) {
  if (!Array.isArray(workers) || workers.length !== 2) throw new Error('exactly two worker agent ids are required')
  const [first, second] = workers
  if (typeof first !== 'string' || typeof second !== 'string' || first === second) {
    throw new Error('two distinct worker agent ids are required')
  }
  return [
    '用户目标：让两名执行成员各自交付 1 个真实文件，并让一名独立评审成员按下列用户提出的验收规则判定。',
    `执行成员 ${first} 与 ${second} 各交付 1 个 Markdown 文件；文件名、目录与任务划分由计划的作者决定，`,
    '本描述不指定。',
    '本轮的边界（用户要求）：你只建包含两个交付任务的计划；本轮不要 release，不要 agent.send，',
    '阶段评审与返工由 Core 接力完成，因此不要为它们建独立任务；完成 plan 后停下来等待用户批准。',
    `每个交付文件的正文必须包含一行 ${acceptanceMarker}，并且必须由产出它的执行成员自己完成证据登记与提交。`,
    `评审规则（用户要求）：评审第一轮必须提出 1 个明确改进要求——交付文件必须新增一行 ${revisionMarker}；`,
    `首版不得包含 ${revisionMarker}。评审收到修改后的新交付时，必须实际读取文件、确认 ${revisionMarker} 存在，`,
    '才可以给出 pass。',
    '任何成员都不得替代用户接受交付，也不得声称用户已经验收。'
  ].join('')
}

/**
 * Verify one archived artifact against what Core persisted.
 *
 * `loom.artifact.preview` (Core `loom.rs:2793`; input `{missionId, artifactId}`; result
 * `{artifactId, relativePath, contentType, sizeBytes, sha256, text, unavailableReason}`) reads the
 * *immutable archive*, never the mutable workspace. The digest is recomputed over the exact UTF-8
 * bytes the preview returned, so a lossy decode cannot pass. Every mismatch fails closed.
 */
export function verifyArchivedArtifact ({ registered, preview } = {}) {
  const artifactId = registered?.artifactId ?? null
  if (typeof artifactId !== 'string' || artifactId === '') {
    return { artifactId: null, ok: false, reasons: ['archive_registration_missing'], text: null }
  }
  const base = {
    artifactId,
    relativePath: registered.relativePath ?? null,
    taskId: registered.taskId ?? null,
    agentRunId: registered.agentRunId ?? null
  }
  if (!preview || typeof preview !== 'object') {
    return { ...base, ok: false, reasons: ['archive_preview_missing'], text: null }
  }
  const reasons = []
  if (preview.artifactId !== artifactId) reasons.push('archive_artifact_id_mismatch')
  const unavailable = preview.unavailableReason ?? null
  if (unavailable !== null) {
    if (['too_large', 'binary', 'not_archived'].includes(unavailable)) {
      reasons.push(`archive_unavailable:${unavailable}`)
    } else {
      reasons.push('archive_unavailable_unknown')
    }
  }
  if (preview.sha256 !== registered.sha256) reasons.push('archive_sha256_mismatch')
  if (preview.sizeBytes !== registered.sizeBytes) reasons.push('archive_size_mismatch')
  if (preview.relativePath !== registered.relativePath) reasons.push('archive_path_mismatch')
  let text = null
  if (typeof preview.text === 'string') {
    text = preview.text
    if (text.includes('\u0000')) reasons.push('archive_text_holds_nul')
    const body = Buffer.from(text, 'utf8')
    if (body.length !== registered.sizeBytes) reasons.push('archive_body_size_mismatch')
    if (sha256(body) !== registered.sha256) reasons.push('archive_body_sha256_mismatch')
  } else if (unavailable === null) {
    reasons.push('archive_text_missing')
  }
  return {
    ...base,
    ok: reasons.length === 0,
    reasons,
    text,
    archiveSha256: preview.sha256 ?? null,
    archiveSizeBytes: preview.sizeBytes ?? null,
    unavailableReason: unavailable
  }
}

/**
 * Derive every success condition from persisted Core facts only. Nothing here reads a model
 * message, and nothing is inferred from a receipt that was not persisted by Core.
 *
 * `fileTexts` must come from archived previews, never from the workspace: a later legitimate
 * workspace edit must not be able to re-judge an older candidate.
 */
export function summarizeLeadChain ({
  plan = null,
  tasks = [],
  candidates = [],
  artifacts = [],
  claims = [],
  control = null,
  runs = [],
  ownerReviews = [],
  workerAgentIds = [],
  acceptanceMarker = ACCEPTANCE_MARKER,
  revisionMarker = REVISION_MARKER,
  fileTexts = {},
  archiveChecks = {},
  policyApprovedAt = null
} = {}) {
  const reasons = []
  const stageReviews = Array.isArray(control?.stageReviews) ? control.stageReviews : []
  const dispatches = Array.isArray(control?.dispatches) ? control.dispatches : []
  const runById = new Map((runs ?? []).map((run) => [run.id, run]))
  const candidatesByTask = new Map()
  for (const candidate of candidates ?? []) {
    if (!candidatesByTask.has(candidate.taskId)) candidatesByTask.set(candidate.taskId, [])
    candidatesByTask.get(candidate.taskId).push(candidate)
  }

  const leadRuns = (runs ?? []).filter((run) => !workerAgentIds.includes(run.agentId))
  const leadRunSucceeded = leadRuns.some((run) => run.status === 'succeeded')
  if (!leadRunSucceeded) reasons.push('lead_run_not_succeeded')

  const planAuthoredByModel = Boolean(plan && plan.planId)
  if (!planAuthoredByModel) reasons.push('plan_not_authored')

  const workerReports = (workerAgentIds ?? []).map((agentId) => {
    const workerRuns = (runs ?? []).filter((run) => run.agentId === agentId)
    const ownCandidates = (candidates ?? []).filter((candidate) =>
      workerRuns.some((run) => run.id === candidate.agentRunId))
    const ownArtifacts = (artifacts ?? []).filter((artifact) => artifact.creatorId === agentId)
    const latest = ownCandidates
      .slice()
      .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))
      .at(-1) ?? null
    return {
      agentId,
      runIds: workerRuns.map((run) => run.id),
      candidateIds: ownCandidates.map((candidate) => candidate.candidateId),
      artifactIds: ownArtifacts.map((artifact) => artifact.artifactId),
      latestCandidateId: latest?.candidateId ?? null,
      candidatesOwnedByRun: ownCandidates.length > 0
        && ownCandidates.every((candidate) => runById.get(candidate.agentRunId)?.agentId === agentId)
    }
  })
  const bothWorkersSubmitted = workerReports.length === 2
    && workerReports.every((report) => report.candidatesOwnedByRun && report.latestCandidateId)
  if (!bothWorkersSubmitted) reasons.push('workers_did_not_submit_their_own_candidates')

  const claimsAreCoreOwned = (claims ?? []).every((claim) =>
    (workerAgentIds ?? []).includes(claim.claimantAgentId)
      && runById.has(claim.agentRunId))
  if (!(claims ?? []).length) reasons.push('no_claim_recorded')

  // One task must show: request_changes on v1 → a chained v2 candidate → pass on v2.
  const reworkedTasks = []
  for (const [taskId, taskCandidates] of candidatesByTask) {
    const ordered = taskCandidates
      .slice()
      .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))
    if (ordered.length < 2) continue
    const chained = ordered.some((candidate) => ordered.some((other) => other.candidateId === candidate.previousCandidateId))
    const reviews = stageReviews
      .filter((review) => review.taskId === taskId)
      .sort((left, right) => String(left.reviewedAt ?? '').localeCompare(String(right.reviewedAt ?? '')))
    const firstChange = reviews.find((review) => review.verdict === 'request_changes') ?? null
    const laterPass = reviews.find((review) =>
      review.verdict === 'pass'
        && firstChange
        && String(review.reviewedAt ?? '') >= String(firstChange.reviewedAt ?? '')) ?? null
    if (!firstChange || !laterPass || !chained) continue
    const firstCandidate = ordered[0]
    const secondCandidate = ordered.find((candidate) => candidate.previousCandidateId === firstCandidate.candidateId)
    if (!secondCandidate) continue
    const firstText = fileTexts[firstCandidate.candidateId] ?? null
    const secondText = fileTexts[secondCandidate.candidateId] ?? null
    const producerAgentId = runById.get(firstCandidate.agentRunId)?.agentId ?? null
    const reviewerRunAgentId = runById.get(firstChange.reviewerAgentRunId)?.agentId ?? null
    reworkedTasks.push({
      taskId,
      firstCandidateId: firstCandidate.candidateId,
      secondCandidateId: secondCandidate.candidateId,
      firstReviewVerdict: firstChange.verdict,
      secondReviewVerdict: laterPass.verdict,
      firstReviewerAgentId: firstChange.reviewerAgentId ?? null,
      secondReviewerAgentId: laterPass.reviewerAgentId ?? null,
      producerAgentId,
      reviewerRunAgentId,
      // A reviewer must be a different member, in a different Run, from the producer.
      reviewerIsSeparate: Boolean(firstChange.reviewerAgentId)
        && reviewerRunAgentId !== null
        && firstChange.reviewerAgentId !== producerAgentId
        && reviewerRunAgentId !== producerAgentId,
      firstCandidateLackedRevisionMarker: firstText === null ? null : !String(firstText).includes(revisionMarker),
      secondCandidateHasRevisionMarker: secondText === null ? null : String(secondText).includes(revisionMarker),
      firstCandidateHasAcceptanceMarker: firstText === null ? null : String(firstText).includes(acceptanceMarker),
      secondCandidateHasAcceptanceMarker: secondText === null ? null : String(secondText).includes(acceptanceMarker)
    })
  }
  const reworkObserved = reworkedTasks.length > 0
    && reworkedTasks.some((entry) => entry.firstCandidateLackedRevisionMarker === true
      && entry.secondCandidateHasRevisionMarker === true)
  if (!reworkObserved) reasons.push('rework_not_observed')
  if (reworkedTasks.some((entry) => entry.reviewerIsSeparate === false)) reasons.push('reviewer_not_separate')

  // Archived bytes that no longer verify make the review unverifiable. The workspace is never
  // consulted here: it may legitimately drift after the archive row was written.
  const archiveFailures = Object.values(archiveChecks ?? {}).filter((check) => check?.ok !== true)
  for (const failure of archiveFailures) {
    for (const reason of failure?.reasons ?? []) if (typeof reason === 'string') reasons.push(reason)
  }
  if (archiveFailures.length > 0) reasons.push('archive_verification_failed')

  // Core must be the one that starts the Workers after the Owner approval (`EXECUTE` dispatch).
  const executeDispatches = dispatches.filter((entry) => String(entry.kind ?? '') === 'execute')
  if (executeDispatches.length === 0) reasons.push('core_execute_dispatch_missing')
  const approvedAtMs = typeof policyApprovedAt === 'string' && policyApprovedAt !== ''
    ? Date.parse(policyApprovedAt)
    : Number.NaN
  const workersStartedBeforeApproval = Number.isNaN(approvedAtMs)
    ? null
    : (runs ?? []).some((run) => workerAgentIds.includes(run.agentId)
      && typeof run.startedAt === 'string'
      && !Number.isNaN(Date.parse(run.startedAt))
      && Date.parse(run.startedAt) < approvedAtMs)
  if (workersStartedBeforeApproval === true) reasons.push('workers_started_before_approval')

  const ownerReviewCount = Array.isArray(ownerReviews) ? ownerReviews.length : -1
  if (ownerReviewCount !== 0) reasons.push('owner_review_not_zero')

  const dispatchKinds = [...new Set(dispatches.map((entry) => String(entry.kind ?? '')))]
  // `execute` is judged above with its own reason, so it is not repeated here.
  for (const required of ['review', 'rework']) {
    if (!dispatchKinds.includes(required)) reasons.push(`dispatch_kind_missing:${required}`)
  }

  const tasksInReview = (tasks ?? [])
    .filter((task) => workerReports.some((report) =>
      (candidatesByTask.get(task.taskId) ?? []).some((candidate) => report.runIds.includes(candidate.agentRunId))))
    .map((task) => ({ taskId: task.taskId, status: task.status }))
  const passesNeverAccepted = tasksInReview.every((task) => task.status !== 'done')
  if (!passesNeverAccepted) reasons.push('host_or_model_accepted_a_delivery')

  const failedRuns = (runs ?? []).filter((run) => ['failed', 'cancelled'].includes(run.status))
  if (failedRuns.length > 0) reasons.push('a_run_failed')

  const pendingDispatches = dispatches.filter((entry) =>
    PENDING_DISPATCH_STATUSES.includes(String(entry.status ?? '').toLowerCase()))
  if (pendingDispatches.length > 0) reasons.push('a_dispatch_is_still_pending')

  return {
    planAuthoredByModel,
    leadAuthoredPlanRunIds: leadRuns.map((run) => run.id),
    workers: workerReports,
    bothWorkersSubmitted,
    claimsAreCoreOwned,
    reworkObserved,
    reworkedTasks,
    ownerReviewCount,
    dispatchKinds,
    tasksInReview,
    passesNeverAccepted,
    failedRuns: failedRuns.map((run) => ({ id: run.id, agentId: run.agentId, status: run.status })),
    pendingDispatches: pendingDispatches.map((entry) => ({ kind: entry.kind, status: entry.status })),
    executeDispatchCount: executeDispatches.length,
    workersStartedBeforeApproval,
    archiveFailures: archiveFailures.map((failure) => ({
      artifactId: failure?.artifactId ?? null,
      relativePath: failure?.relativePath ?? null,
      reasons: failure?.reasons ?? []
    })),
    reasons: [...new Set(reasons)]
  }
}

/** 0 = every required fact including a real rework; 3 = chain fine but rework not observed. */
export function exitCodeFor (summary) {
  if (!summary) return 1
  const structural = (summary.reasons ?? []).filter((reason) =>
    reason !== 'rework_not_observed'
    && reason !== 'dispatch_kind_missing:rework')
  if (structural.length === 0 && summary.reworkObserved === true) return 0
  if (structural.length === 0) return 3
  return 1
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

function assertInside (root, target, label) {
  const normalizedRoot = resolve(root).toLowerCase()
  const normalizedTarget = resolve(target).toLowerCase()
  if (normalizedTarget === normalizedRoot) return
  if (!normalizedTarget.startsWith(normalizedRoot + sep.toLowerCase())) {
    throw Object.assign(new Error(`${label} escapes the confirmed fixture: ${target}`), { code: 'FIXTURE_ESCAPE' })
  }
}

function piFileAccessMode (permissions) {
  const values = permissions?.values ?? {}
  const raw = values.loom_file_access
  if (raw === undefined || raw === null) return 'native'
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof raw.mode === 'string') return raw.mode
  return 'invalid'
}

export function buildIsolatedEnvironment ({ fixtureRoot, agentDir, piBundle, gitBash, providerKey }) {
  const env = {}
  for (const key of OS_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  const systemRoot = env.SystemRoot ?? env.windir
  assert.ok(systemRoot, 'BLOCKED_SYSTEM_ROOT_UNAVAILABLE')
  const home = join(fixtureRoot, 'home')
  const temporary = join(fixtureRoot, 'tmp')
  Object.assign(env, {
    PATH: isolatedPathEntries({
      systemRoot,
      bundleNodeDir: dirname(piBundle.node),
      gitDirs: gitBash.pathEntries
    }).join(delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMP: temporary,
    TEMP: temporary,
    TMPDIR: temporary,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    PI_CODING_AGENT_DIR: agentDir,
    ROVAI_EMBEDDED_PI_ROOT: piBundle.root,
    PI_TELEMETRY: '0',
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DSH_HOME: join(home, '.dsh'),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    [PROVIDER_KEY_ENV]: providerKey
  })
  for (const key of Object.keys(env)) {
    if (key === PROVIDER_KEY_ENV) continue
    if (CREDENTIAL_SHAPED_ENV.test(key)) {
      throw new Error(`refusing to pass a credential-shaped environment key into Core: ${key}`)
    }
  }
  return env
}

export async function writeIsolatedPiProfile ({ agentDir, config, gitBash }) {
  await mkdir(agentDir, { recursive: true })
  const models = {
    providers: {
      'loom-live': {
        baseUrl: config.provider.baseUrl,
        api: config.provider.api,
        // Env reference only: the key value never lands in a file.
        apiKey: `$${PROVIDER_KEY_ENV}`,
        models: [{ ...config.model, maxTokens: 16384 }]
      }
    }
  }
  const settings = {
    defaultProvider: 'loom-live',
    defaultModel: config.model.id,
    defaultThinkingLevel: 'max',
    // Pi resolves the bash tool as: settings.shellPath → well-known Git Bash → PATH. The isolated
    // settings carry the explicit path so the LOOM CLI is reachable from a deterministic shell.
    shellPath: gitBash.path
  }
  const modelsPath = join(agentDir, 'models.json')
  const settingsPath = join(agentDir, 'settings.json')
  await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, 'utf8')
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return { modelsPath, settingsPath, apiKeyReference: `$${PROVIDER_KEY_ENV}`, authFileWritten: false, shellPath: gitBash.path }
}

const MEMBER_ROLES = [
  {
    role: 'lead',
    displayName: 'LOOM Lead (live)',
    teamRole: 'Default Lead',
    professionalResponsibilities: '读取用户目标，用 rovai loom 自己制定并导入本 Mission 的计划（任务、验收标准、依赖、指派），不代替成员交付，不代替用户验收。',
    personalityTraits: ['克制', '严谨'],
    workingPrinciples: '只在当前 Mission 内规划；任务粒度是可交接的；指派给真实成员；不声称任何交付已被验收。'
  },
  {
    role: 'worker-a',
    displayName: 'LOOM Worker A (live)',
    teamRole: '执行成员 A',
    professionalResponsibilities: '只完成指派给自己的那个任务：在工作目录写真实文件，用 rovai loom 登记证据并提交候选。',
    personalityTraits: ['务实'],
    workingPrinciples: '只改自己的文件；不代他人提交；不声称用户已验收。'
  },
  {
    role: 'worker-b',
    displayName: 'LOOM Worker B (live)',
    teamRole: '执行成员 B',
    professionalResponsibilities: '只完成指派给自己的那个任务：在工作目录写真实文件，用 rovai loom 登记证据并提交候选。',
    personalityTraits: ['务实'],
    workingPrinciples: '只改自己的文件；不代他人提交；不声称用户已验收。'
  },
  {
    role: 'reviewer',
    displayName: 'LOOM Reviewer (live)',
    teamRole: '独立评审成员',
    professionalResponsibilities: '读取待评审候选的真实文件，用 rovai loom inspect 与 rovai loom stage-review 记录评审；首轮提出明确改进要求，复审确认改进后才给 pass。',
    personalityTraits: ['挑剔', '有据'],
    workingPrinciples: '不评审自己的产出；不改候选文件；pass 只是内部阶段通过，不等于用户验收。'
  }
]

export async function createMembers (host, existingAgentIds) {
  const members = {}
  for (const definition of MEMBER_ROLES) {
    const created = await host.request('members.create', {
      commandId: randomUUID(),
      command: {
        displayName: definition.displayName,
        teamRole: definition.teamRole,
        professionalResponsibilities: definition.professionalResponsibilities,
        personalityTraits: definition.personalityTraits,
        workingPrinciples: definition.workingPrinciples,
        growthTopic: ''
      }
    })
    assert.equal(created?.status, 'applied', `members.create ${definition.role}: ${JSON.stringify(created)}`)
    const agentId = created?.resultEntity?.entityId ?? created?.payload?.agentId ?? null
    assert.ok(typeof agentId === 'string' && agentId.length > 0, `members.create ${definition.role} returned no agent id`)
    assert.ok(!existingAgentIds.includes(agentId), `members.create ${definition.role} collided with a seeded member`)
    members[definition.role] = { agentId, role: definition.role, teamRole: definition.teamRole }
  }
  return members
}

export async function configureRuntime (host, agentId, installation) {
  const defaults = installation.memberRuntimeDefaults
  assert.ok(defaults?.model && defaults?.permissions, 'the managed Pi installation exposes no member runtime defaults')
  const mode = piFileAccessMode(defaults.permissions)
  assert.equal(
    mode, 'native',
    `BLOCKED_PI_DEFAULTS_ARE_GUARDED: installation default loom_file_access is ${mode}; this acceptance runs Pi native only`
  )
  const before = await host.request('members.get', { agentId })
  const applied = await host.request('members.runtime.set', {
    commandId: randomUUID(),
    command: {
      agentId,
      expectedVersion: before.version,
      adapterKind: 'pi',
      model: {
        ...defaults.model,
        options: { ...(defaults.model.options ?? {}), thinking_level: 'max' }
      },
      // Permission defaults are passed through untouched: no `loom_file_access`, no `piPurge`.
      permissions: defaults.permissions
    }
  })
  assert.equal(applied?.status, 'applied', `members.runtime.set ${agentId}: ${JSON.stringify(applied)}`)
  const after = await host.request('members.get', { agentId })
  const afterMode = piFileAccessMode(after?.runtimeConfiguration?.permissions)
  assert.equal(afterMode, 'native', `member ${agentId} must stay on Pi native, got ${afterMode}`)
  assert.equal(after?.runtimeConfiguration?.piPurge ?? null, null, `member ${agentId} must carry no Pi Purge selection`)
  return {
    agentId,
    adapterKind: after?.runtimeConfiguration?.adapterKind ?? null,
    fileAccessMode: afterMode,
    readiness: after?.runtimeReadiness?.status ?? null,
    modelId: after?.runtimeConfiguration?.model?.modelId ?? after?.runtimeConfiguration?.model?.id ?? null
  }
}

export async function waitForManagedPiInstallation (host, launcherPath) {
  const expected = resolve(launcherPath).toLowerCase()
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const installations = await host.request('runtime.installations.list')
    const found = (Array.isArray(installations) ? installations : []).find((entry) =>
      entry.adapterKind === 'pi'
        && typeof entry.executablePath === 'string'
        && resolve(entry.executablePath).toLowerCase() === expected)
    if (found?.memberRuntimeDefaults) return found
    await sleep(500)
  }
  throw Object.assign(new Error('the managed Pi installation never published member runtime defaults'), { stage: 'installation' })
}

async function readChainState (host, ctx) {
  const [snapshot, plan, tasks, dependencies, candidates, artifacts, claims, control, ownerReviews] = await Promise.all([
    host.request('threads.snapshot', { threadId: ctx.threadId }),
    host.request('loom.plan.get', { missionId: ctx.missionId }),
    host.request('loom.tasks.list', { missionId: ctx.missionId }),
    host.request('loom.dependencies.list', { missionId: ctx.missionId }),
    host.request('loom.candidates.list', { missionId: ctx.missionId }),
    host.request('loom.artifacts.list', { missionId: ctx.missionId }),
    host.request('loom.claims.list', { missionId: ctx.missionId }),
    host.request('loom.control.get', { missionId: ctx.missionId }),
    host.request('loom.reviews.list', { missionId: ctx.missionId })
  ])
  const artifactList = Array.isArray(artifacts) ? artifacts : (artifacts?.artifacts ?? [])
  return {
    runs: snapshot?.agentRuns ?? [],
    approvals: snapshot?.approvals ?? [],
    plan: plan ?? null,
    tasks: Array.isArray(tasks) ? tasks : [],
    dependencies: Array.isArray(dependencies) ? dependencies : [],
    candidates: Array.isArray(candidates) ? candidates : [],
    artifacts: Array.isArray(artifactList) ? artifactList : [],
    claims: Array.isArray(claims?.claims) ? claims.claims : (Array.isArray(claims) ? claims : []),
    control: control ?? null,
    ownerReviews: Array.isArray(ownerReviews) ? ownerReviews : []
  }
}

function chainIsSettled (state) {
  const activeRuns = state.runs.filter((run) => !TERMINAL_RUN_STATUSES.includes(run.status))
  const dispatches = Array.isArray(state.control?.dispatches) ? state.control.dispatches : []
  const activeDispatches = dispatches.filter((entry) =>
    PENDING_DISPATCH_STATUSES.includes(String(entry.status ?? '').toLowerCase()))
  return activeRuns.length === 0 && activeDispatches.length === 0
}

/**
 * Read every registered artifact back through `loom.artifact.preview`, i.e. the immutable archive.
 * A read error is recorded as a failed check instead of aborting: the reason must reach the
 * evidence, and nothing falls back to the mutable workspace.
 */
async function readArchivedArtifacts ({ host, missionId, artifactList }) {
  const checks = {}
  for (const artifact of artifactList) {
    let preview = null
    let error = null
    try {
      preview = await host.request('loom.artifact.preview', { missionId, artifactId: artifact.artifactId })
    } catch (failure) {
      error = failure
    }
    if (error) {
      checks[artifact.artifactId] = {
        artifactId: artifact.artifactId,
        relativePath: artifact.relativePath ?? null,
        taskId: artifact.taskId ?? null,
        agentRunId: artifact.agentRunId ?? null,
        ok: false,
        reasons: [`archive_preview_error:${redactDiagnosticText(error?.coreError?.code ?? error?.message ?? 'error')}`],
        text: null
      }
      continue
    }
    checks[artifact.artifactId] = verifyArchivedArtifact({ registered: artifact, preview })
  }
  return checks
}

/** Candidate text comes from the archive of every evidence id it cites; any failure → null. */
function archiveTextsForCandidates ({ candidateList, archiveChecks }) {
  const texts = {}
  for (const candidate of candidateList) {
    const evidenceIds = candidate.evidenceIds ?? []
    if (evidenceIds.length === 0) { texts[candidate.candidateId] = null; continue }
    const checks = evidenceIds.map((id) => archiveChecks[id])
    if (checks.some((check) => !check || check.ok !== true || typeof check.text !== 'string')) {
      texts[candidate.candidateId] = null
      continue
    }
    texts[candidate.candidateId] = checks.map((check) => check.text).join('\n\n')
  }
  return texts
}

/**
 * Workspace drift is a *separate, informational* axis: the workspace may legitimately change
 * after an artifact was archived. It never re-judges an archived candidate.
 */
async function readWorkspaceDrift ({ artifactList, workspace, fixtureRoot }) {
  const drift = {}
  for (const artifact of artifactList) {
    if (typeof artifact.relativePath !== 'string' || artifact.relativePath === '') continue
    const absolute = join(workspace, artifact.relativePath)
    assertInside(fixtureRoot, absolute, 'workspace drift check')
    let workspaceSha256 = null
    let present = false
    try {
      const bytes = await readFile(absolute)
      present = true
      workspaceSha256 = sha256(bytes)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    drift[artifact.artifactId] = {
      relativePath: artifact.relativePath,
      registeredSha256: artifact.sha256,
      workspaceSha256,
      present,
      matchesRegistered: present && workspaceSha256 === artifact.sha256
    }
  }
  return drift
}

// ---------------------------------------------------------------------------
// Acceptance run
// ---------------------------------------------------------------------------

async function runAcceptance (options, { log = () => {} } = {}) {
  const startedAt = new Date().toISOString()
  const providerKey = process.env[PROVIDER_KEY_ENV] ?? ''
  const report = {
    schema: 'loom.accept-loom-live-lead.v1',
    status: 'in_progress',
    startedAt,
    finishedAt: null,
    trigger: {
      kind: 'service',
      transport: 'core-stdio-rpc',
      commands: ['members.create', 'members.runtime.set', 'missions.create', 'missions.start', 'loom.control.configure', 'loom.control.pause'],
      uIObserved: false,
      note: 'the packaged UI path was not exercised; this is the same Core command a UI Start button emits'
    },
    scope: 'real-commercial-model-lead-plan + two real worker submissions + one independent model stage review with one real rework',
    finalFullChainClaim: false,
    realCommercialModel: true,
    scriptedProvider: false,
    hostWroteModelResults: false,
    runtimeMode: 'pi-native-no-file-grant',
    piPurgeUsed: false,
    guardReceiptsExpected: false,
    realOwnerAcceptance: false,
    forbiddenHostMethods: [...FORBIDDEN_HOST_METHODS],
    rejectedHostCalls: [],
    methodCallCounts: {},
    workers: [],
    reviewer: null,
    plan: null,
    lead: null,
    dispatches: [],
    stageReviews: [],
    ownerReviewCount: null,
    reworkObserved: false,
    summary: null,
    runs: [],
    isolation: null,
    error: null,
    notes: []
  }

  const finish = async (coreRef, { preserveFixture, exitCode }) => {
    report.finishedAt = new Date().toISOString()
    report.exitCode = exitCode
    report.status = exitCode === 0
      ? 'passed-real-lead-plan-two-worker-submissions-and-rework'
      : (exitCode === 3 ? 'chain-ok-rework-not-observed' : (exitCode === 2 ? 'blocked-preflight' : 'failed'))
    if (coreRef?.fixture) report.fixture = coreRef.fixture
    let serialized = `${JSON.stringify(redactDeep(report, [providerKey]), null, 2)}\n`
    if (providerKey !== '' && serialized.includes(providerKey)) {
      // Never write the key, and never lose the evidence because of it.
      serialized = serialized.split(providerKey).join('[redacted]')
      report.evidenceLeakRepaired = true
    }
    const evidencePath = coreRef?.evidencePath ?? join(tmpdir(), 'loom-live-lead-evidence.json')
    await mkdir(dirname(evidencePath), { recursive: true })
    await writeFile(evidencePath, serialized, 'utf8')
    return { report, evidencePath, exitCode, preserveFixture }
  }

  // ---- preflight: never start without an explicit allowance, a key and a shell ----
  const blockedPath = options.evidenceRoot
    ? join(options.evidenceRoot, 'lead-live-evidence.json')
    : join(tmpdir(), 'loom-live-lead-evidence.json')
  const blocked = async (code, message) => {
    report.error = { code, message }
    const written = await finish({ evidencePath: blockedPath }, { preserveFixture: false, exitCode: 2 })
    return { exitCode: 2, report, evidencePath: written.evidencePath, preserveFixture: false }
  }
  if (!providerKey) {
    return await blocked('BLOCKED_PROVIDER_KEY_MISSING', `${PROVIDER_KEY_ENV} must be provided by the authorized environment`)
  }
  if (process.env.LOOM_ALLOW_LIVE_ACCEPTANCE !== '1') {
    return await blocked('BLOCKED_ALLOWANCE_MISSING', 'LOOM_ALLOW_LIVE_ACCEPTANCE=1 is required')
  }
  if (process.platform !== 'win32') {
    return await blocked('BLOCKED_PLATFORM', `Pi native LOOM acceptance is Windows-only; host is ${process.platform}`)
  }
  const config = JSON.parse(await readFile(options.configPath, 'utf8'))
  const endpoint = new URL(config.provider.baseUrl)
  assert.equal(`${endpoint.username}${endpoint.password}${endpoint.search}${endpoint.hash}`, '',
    'the provider base URL must carry no credentials, query or fragment')

  const gitBash = resolveGitBash({ explicitPath: options.gitBash })
  report.gitBash = { path: gitBash.path, source: gitBash.source, tried: gitBash.tried, pathEntries: gitBash.pathEntries }
  if (!gitBash.path) {
    return await blocked(
      'BLOCKED_GIT_BASH_MISSING',
      `no bash.exe found (tried ${gitBash.tried.join(', ')}); pass --git-bash <path>. Pi native needs a shell to run the rovai LOOM CLI, and this harness will not pretend otherwise`
    )
  }

  const binary = await verifyCoreBinary({
    coreBinaryPath: config.coreBinaryPath,
    coreExpectedSha256: config.coreExpectedSha256
  })
  const helper = await resolveBuiltinToolHelper({ coreBinaryPath: binary.path })
  const piBundle = await readPiBundleManifest(config.piRoot)
  Object.assign(report, {
    sourceCommit: config.sourceCommit ?? null,
    coreSha256: binary.sha256,
    coreBinaryPath: binary.path,
    helperSha256: helper.sha256,
    piVersion: piBundle.piVersion,
    piRoot: piBundle.root,
    modelId: config.model.id,
    providerBaseUrl: config.provider.baseUrl,
    providerApi: config.provider.api
  })

  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'loom-live-lead-')))
  for (let path = fixture; ; path = dirname(path)) {
    assert.ok(!existsSync(join(path, '.git')), `the fixture must not live inside a git checkout: ${path}`)
    if (dirname(path) === path) break
  }
  const evidencePath = options.evidenceRoot
    ? join(options.evidenceRoot, 'lead-live-evidence.json')
    : join(fixture, 'lead-live-evidence.json')
  const ctx = { fixture, evidencePath }
  const home = join(fixture, 'home')
  const temporary = join(fixture, 'tmp')
  const agentDir = join(fixture, 'pi-agent')
  for (const path of [home, temporary, agentDir]) await mkdir(path, { recursive: true })

  let core = null
  let guard = null
  let preserveFixture = true
  let exitCode = 1
  let finalResult = null
  try {
    const profile = await writeIsolatedPiProfile({ agentDir, config, gitBash })
    report.piProfile = { authFileWritten: profile.authFileWritten, apiKeyReference: profile.apiKeyReference, shellPath: profile.shellPath }
    const env = buildIsolatedEnvironment({ fixtureRoot: fixture, agentDir, piBundle, gitBash, providerKey })

    const dataDir = JSON.parse(
      execFileSync(binary.path, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8', env })
    ).core
    assertInside(fixture, dataDir, 'Core data directory')
    report.dataDir = dataDir
    const skillRoot = join(dataDir, 'managed-skill-library')
    const mcpPath = join(dataDir, 'mcp.json')
    const workspace = join(dataDir, 'quick-chat')
    Object.assign(report, {
      credentialWrittenToFile: false,
      isolation: {
        fixture,
        dataDirInsideFixture: true,
        skillRoot,
        mcpPath,
        workspace,
        isolatedRoots: ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
          'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
          'PI_CODING_AGENT_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME'],
        inheritedEnvKeys: Object.keys(env).filter((key) => OS_ENV_ALLOWLIST.includes(key)).sort(),
        pathEntries: String(env.PATH).split(delimiter),
        userPiProfileRead: false,
        userDatabaseTouched: false,
        dailyServiceTouched: false,
        globalMcpConfigTouched: false
      }
    })

    core = startIsolatedCore({
      binaryPath: binary.path,
      dataDir,
      skillRoot,
      mcpPath,
      env,
      cwd: fixture,
      readyBudgetMs: READY_BUDGET_MS
    })
    await core.ready
    guard = createHostRequestGuard(core.request)
    const host = guard

    const productCheck = await host.request('runtime.product.check', { runtimeKind: 'pi' })
    report.productCheck = { outcome: productCheck?.outcome ?? null, ready: productCheck?.ready === true }
    const installation = await waitForManagedPiInstallation(host, piBundle.launcher)
    report.piInstallation = {
      id: installation.id ?? null,
      installationClass: installation.installationClass ?? null,
      executablePath: installation.executablePath ?? null,
      probeStatus: installation.snapshot?.probeStatus ?? null,
      memberDefaultFileAccess: piFileAccessMode(installation.memberRuntimeDefaults?.permissions)
    }

    const seeded = await host.request('members.list')
    const existingAgentIds = (Array.isArray(seeded) ? seeded : []).map((member) => member.agentId)
    const members = await createMembers(host, existingAgentIds)
    report.members = Object.values(members).map(({ role, agentId, teamRole }) => ({ role, agentId, teamRole }))
    for (const member of Object.values(members)) {
      const configured = await configureRuntime(host, member.agentId, installation)
      member.runtime = configured
    }
    report.workers = [members['worker-a'], members['worker-b']].map((member) => ({
      agentId: member.agentId,
      role: member.role,
      runtime: member.runtime
    }))
    report.reviewer = { agentId: members.reviewer.agentId, role: 'reviewer', runtime: members.reviewer.runtime }
    report.lead = { agentId: members.lead.agentId, role: 'lead', runtime: members.lead.runtime }

    // ---- fixture: one Mission whose description is the user goal, never a plan ----
    const description = buildMissionDescription({
      workers: [members['worker-a'].agentId, members['worker-b'].agentId],
      acceptanceMarker: ACCEPTANCE_MARKER,
      revisionMarker: REVISION_MARKER
    })
    report.missionGoal = { acceptanceMarker: ACCEPTANCE_MARKER, revisionMarker: REVISION_MARKER, descriptionSha256: sha256(description) }
    const mission = await host.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'LOOM live Lead acceptance',
        description,
        projectPath: '',
        projectBindingKind: 'quick_chat',
        memberAgentIds: [members.lead.agentId, members['worker-a'].agentId, members['worker-b'].agentId, members.reviewer.agentId],
        defaultLeadAgentId: members.lead.agentId,
        tags: ['accept-loom-live-lead']
      }
    })
    assert.equal(mission?.status, 'applied', `missions.create: ${JSON.stringify(mission)}`)
    const missionId = mission?.payload?.missionId
    const threadId = mission?.payload?.threadId
    assert.ok(typeof missionId === 'string' && typeof threadId === 'string', 'missions.create must answer with missionId and threadId')
    Object.assign(ctx, { missionId, threadId })

    // ---- the one and only Lead start: the same User command a UI Start button emits ----
    const leadStart = await host.request('missions.start', {
      commandId: randomUUID(),
      command: { missionId }
    })
    const leadStartStatus = leadStart?.status ?? null
    assert.ok(['applied', 'accepted'].includes(leadStartStatus),
      `missions.start must be accepted, got ${JSON.stringify(leadStart)}`)
    if (leadStart?.payload?.alreadyRunning === true) {
      throw Object.assign(new Error('missions.start reported alreadyRunning on a fresh Mission'), { stage: 'lead-start' })
    }
    report.leadStart = { status: leadStartStatus, payloadKeys: Object.keys(leadStart?.payload ?? {}) }

    // Wait for the Lead Run itself (created by the delivery lane, not by this harness).
    const leadDeadline = Date.now() + LEAD_START_BUDGET_MS
    let leadRun = null
    while (Date.now() < leadDeadline) {
      const snapshot = await host.request('threads.snapshot', { threadId })
      leadRun = (snapshot?.agentRuns ?? []).find((run) => run.agentId === members.lead.agentId) ?? null
      if (leadRun) break
      await sleep(500)
    }
    assert.ok(leadRun, 'the Mission start must create the Default Lead Run')
    report.lead.runId = leadRun.id

    // ---- poll until the whole chain settles; every command id is minted once, never re-sent ----
    const deadline = Date.now() + options.timeoutMs
    let state = await readChainState(host, ctx)
    let approvalsSeen = []
    while (Date.now() < deadline) {
      state = await readChainState(host, ctx)
      approvalsSeen = state.approvals
      if (approvalsSeen.length > 0) break
      if (chainIsSettled(state)) break
      log(`runs=${state.runs.length} candidates=${state.candidates.length} stageReviews=${(state.control?.stageReviews ?? []).length}`)
      await sleep(options.pollMs)
    }
    report.timedOut = Date.now() >= deadline && !chainIsSettled(state)
    report.approvals = approvalsSeen

    const leadRunFinal = state.runs.find((run) => run.id === report.lead.runId) ?? null
    report.lead.run = leadRunFinal
      ? { id: leadRunFinal.id, status: leadRunFinal.status, startedAt: leadRunFinal.startedAt, endedAt: leadRunFinal.endedAt }
      : null
    if (state.plan) {
      report.plan = {
        planId: state.plan.planId ?? null,
        goal: state.plan.goal ?? null,
        acceptanceCriteriaVersion: state.plan.acceptanceCriteriaVersion ?? null,
        taskIds: (state.tasks ?? []).map((task) => task.taskId),
        assignees: (state.tasks ?? []).map((task) => ({ taskId: task.taskId, assigneeAgentId: task.assigneeAgentId ?? null })),
        criterionIds: (state.tasks ?? []).flatMap((task) =>
          (task.acceptanceCriteria?.criteria ?? []).map((criterion) => criterion.criterionId))
      }
    }

    // ---- one bounded Owner approval, minted once, never re-approved ----
    const planTaskIds = (state.tasks ?? []).map((task) => task.taskId)
    const workerAgentIds = [members['worker-a'].agentId, members['worker-b'].agentId]
    const reviewerAgentId = members.reviewer.agentId
    const inScope = (state.tasks ?? [])
      .filter((task) => workerAgentIds.includes(task.assigneeAgentId))
      .map((task) => task.taskId)
    const distinctAssignees = [...new Set((state.tasks ?? [])
      .filter((task) => inScope.includes(task.taskId))
      .map((task) => task.assigneeAgentId))]
    report.planScope = { planTaskIds, approvedTaskIds: inScope, distinctAssignees }
    // The approval is only worth granting when the model plan itself assigned work to BOTH workers,
    // read from real read-only state before any policy exists.
    if (inScope.length === 0 || distinctAssignees.length !== 2) {
      throw Object.assign(
        new Error(`the model plan did not assign a task to each of the two workers (assignees: ${JSON.stringify(distinctAssignees)}); the Host will not author or repair a plan`),
        { stage: 'plan', code: 'PLAN_DID_NOT_ASSIGN_BOTH_WORKERS' }
      )
    }
    const approval = await host.request('loom.control.configure', {
      commandId: randomUUID(),
      missionId,
      expectedRevision: 0,
      enabled: true,
      taskIds: inScope,
      reviewers: inScope.map((taskId) => ({ taskId, reviewerAgentId })),
      // EXECUTE + REVIEW + REWORK + REVIEW + HANDOFF per task must all fit.
      maxDispatches: 12,
      maxReworksPerTask: 1,
      expiresAt: new Date(Date.now() + Math.max(options.timeoutMs, 10 * 60_000)).toISOString()
    })
    report.ownerApproval = {
      trigger: 'service',
      uIObserved: false,
      policyRevision: approval?.policy?.revision ?? null,
      authorizationRevision: approval?.policy?.authorizationRevision ?? null,
      approvedBy: approval?.policy?.approvedBy ?? null,
      approvedAt: approval?.policy?.approvedAt ?? null,
      taskIds: approval?.policy?.taskIds ?? null,
      maxDispatches: approval?.policy?.maxDispatches ?? null,
      maxReworksPerTask: approval?.policy?.maxReworksPerTask ?? null,
      reviewers: approval?.policy?.reviewers ?? null
    }

    // Poll the dispatch chain until it settles again (the approval just woke the scheduler).
    const dispatchDeadline = Date.now() + options.timeoutMs
    while (Date.now() < dispatchDeadline) {
      state = await readChainState(host, ctx)
      if (state.approvals.length > 0) break
      if (chainIsSettled(state) && (state.control?.stageReviews ?? []).length > 0) break
      if (chainIsSettled(state) && Date.now() > dispatchDeadline - options.timeoutMs + 60_000 && (state.control?.dispatches ?? []).length === 0) {
        // Nothing was dispatched at all: stop instead of waiting out the whole budget.
        break
      }
      log(`dispatches=${(state.control?.dispatches ?? []).length} reviews=${(state.control?.stageReviews ?? []).length}`)
      await sleep(options.pollMs)
    }
    report.timedOut = report.timedOut || Date.now() >= dispatchDeadline

    const archiveChecks = await readArchivedArtifacts({ host, missionId: ctx.missionId, artifactList: state.artifacts })
    const fileTexts = archiveTextsForCandidates({ candidateList: state.candidates, archiveChecks })
    const workspaceDrift = await readWorkspaceDrift({ artifactList: state.artifacts, workspace, fixtureRoot: fixture })

    const summary = summarizeLeadChain({
      plan: state.plan,
      tasks: state.tasks,
      candidates: state.candidates,
      artifacts: state.artifacts,
      claims: state.claims,
      control: state.control,
      runs: state.runs,
      ownerReviews: state.ownerReviews,
      workerAgentIds,
      acceptanceMarker: ACCEPTANCE_MARKER,
      revisionMarker: REVISION_MARKER,
      fileTexts,
      archiveChecks,
      policyApprovedAt: report.ownerApproval?.approvedAt ?? null
    })
    Object.assign(report, {
      summary,
      reworkObserved: summary.reworkObserved,
      ownerReviewCount: summary.ownerReviewCount,
      ownerReviewNote: 'loom.reviews.list is the Owner axis; 0 is required. The model stage review is read from loom.control.get.stageReviews.',
      stageReviews: (state.control?.stageReviews ?? []).map((review) => ({
        stageReviewId: review.stageReviewId,
        taskId: review.taskId,
        candidateId: review.candidateId,
        reviewerAgentId: review.reviewerAgentId,
        reviewerAgentRunId: review.reviewerAgentRunId,
        policyRevision: review.policyRevision,
        manifestHash: review.manifestHash,
        verdict: review.verdict,
        criteriaResultCount: Array.isArray(review.criteriaResults) ? review.criteriaResults.length : null
      })),
      dispatches: (state.control?.dispatches ?? []).map((entry) => ({
        kind: entry.kind, status: entry.status, taskId: entry.taskId, recipientAgentId: entry.recipientAgentId
      })),
      candidates: state.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        taskId: candidate.taskId,
        agentRunId: candidate.agentRunId,
        previousCandidateId: candidate.previousCandidateId ?? null,
        evidenceIds: candidate.evidenceIds ?? [],
        verificationStatus: candidate.verificationStatus,
        acceptanceStatus: candidate.acceptanceStatus,
        contentHash: candidate.contentHash
      })),
      artifacts: state.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        taskId: artifact.taskId ?? null,
        agentRunId: artifact.agentRunId ?? null,
        creatorId: artifact.creatorId,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes
      })),
      claims: state.claims.map((claim) => ({
        claimId: claim.claimId, taskId: claim.taskId, agentRunId: claim.agentRunId,
        claimantAgentId: claim.claimantAgentId, fenceGeneration: claim.fenceGeneration,
        releasedAt: claim.releasedAt ?? null
      })),
      runs: state.runs.map((run) => ({
        id: run.id, agentId: run.agentId, status: run.status,
        startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null,
        failureCode: run.failure?.code ?? null
      })),
      fileChecks: Object.fromEntries(Object.entries(fileTexts).map(([candidateId, text]) => [candidateId, {
        source: 'loom.artifact.preview (immutable archive)',
        present: text !== null,
        bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
        hasAcceptanceMarker: text === null ? null : text.includes(ACCEPTANCE_MARKER),
        hasRevisionMarker: text === null ? null : text.includes(REVISION_MARKER),
        sha256: text === null ? null : sha256(Buffer.from(text, 'utf8'))
      }])),
      // Informational only: the mutable workspace may legitimately drift after archiving.
      workspaceDrift,
      workspaceDriftAffectsJudgement: false,
      archiveChecks: Object.fromEntries(Object.entries(archiveChecks).map(([artifactId, check]) => [artifactId, {
        ok: check.ok,
        reasons: check.reasons,
        relativePath: check.relativePath,
        taskId: check.taskId,
        agentRunId: check.agentRunId,
        archiveSha256: check.archiveSha256 ?? null,
        archiveSizeBytes: check.archiveSizeBytes ?? null,
        unavailableReason: check.unavailableReason ?? null
      }])),
    })
    if (approvalsSeen.length > 0) summary.reasons.push('unexpected_approval_state')

    exitCode = report.timedOut ? 1 : exitCodeFor(summary)
    if (report.timedOut) report.error = { code: 'TIMEOUT', message: 'the chain did not settle inside the budget; the fixture is kept and no request is re-sent' }
    preserveFixture = exitCode !== 0 || options.keepFixture
  } catch (error) {
    report.error = {
      code: error?.code ?? error?.coreError?.code ?? error?.stage ?? 'FAILED',
      message: redactDiagnosticText(error?.message ?? String(error)),
      stage: error?.stage ?? null,
      method: error?.method ?? null
    }
    if (core) report.coreDiagnostics = core.diagnosticsSnapshot?.() ?? null
    exitCode = 1
    preserveFixture = true
  } finally {
    if (guard) {
      report.rejectedHostCalls = guard.rejected
      report.methodCallCounts = guard.callCounts()
      report.hostMethods = guard.methodNames()
    }
    if (core && guard) {
      try {
        // Best effort pause so a kept fixture cannot keep dispatching after this run.
        if (ctx.missionId && report.ownerApproval) {
          const control = await guard.request('loom.control.get', { missionId: ctx.missionId })
          const revision = control?.policy?.revision
          if (Number.isInteger(revision)) {
            await guard.request('loom.control.pause', {
              missionId: ctx.missionId,
              commandId: randomUUID(),
              expectedRevision: revision,
              paused: true
            })
            report.paused = true
          }
        }
      } catch (error) {
        report.pauseError = redactDiagnosticText(error?.message ?? String(error))
      }
    }
    if (core) {
      try {
        report.shutdown = await core.close()
      } catch (error) {
        report.shutdownError = redactDiagnosticText(error?.message ?? String(error))
      }
      core = null
      if (guard) report.methodCallCounts = guard.callCounts()
    }
    report.fixtureRemoved = !preserveFixture
    try {
      finalResult = await finish({ fixture, evidencePath }, { preserveFixture, exitCode })
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        code: 'EVIDENCE_WRITE_FAILED',
        message: redactDiagnosticText(error?.message ?? String(error)),
        fixture
      }))
      finalResult = { exitCode: 1, report, evidencePath: null, preserveFixture: true, fixtureRemoved: false }
      preserveFixture = true
    }
    if (finalResult && !preserveFixture) {
      // The fixture is disposable only on a fully green run; an unresolved outcome keeps it.
      await rm(fixture, { recursive: true, force: true }).catch(() => {})
      finalResult.fixtureRemoved = true
    }
    if (finalResult) finalResult.preserveFixture = preserveFixture
  }
  return finalResult
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  let options
  try {
    options = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: 'BAD_ARGUMENTS', message: error.message }))
    process.exitCode = 2
    options = null
  }
  if (options?.help) {
    console.log('node scripts/accept-loom-live-lead.mjs [--config <public-config.json>] [--evidence-root <dir>] [--git-bash <bash.exe>] [--timeout-ms <n>] [--poll-ms <n>] [--keep-fixture] [--json]')
    process.exitCode = 0
  } else if (options) {
    const keepFixture = options.keepFixture
    runAcceptance(options, { log: (line) => { if (!process.env.LOOM_LIVE_LEAD_QUIET) console.error(`[lead] ${line}`) } })
      .then(({ report, evidencePath, exitCode, preserveFixture }) => {
        const summary = {
          ok: exitCode === 0,
          exitCode,
          status: report.status,
          evidence: evidencePath,
          fixture: preserveFixture || keepFixture ? report.fixture ?? null : null,
          planAuthoredByModel: report.summary?.planAuthoredByModel ?? false,
          workersSubmitted: report.summary?.bothWorkersSubmitted ?? false,
          reworkObserved: report.reworkObserved ?? false,
          ownerReviewCount: report.ownerReviewCount ?? null,
          stageReviewCount: Array.isArray(report.stageReviews) ? report.stageReviews.length : 0,
          reasons: report.summary?.reasons ?? [],
          error: report.error ?? null
        }
        if (options.json) console.log(JSON.stringify(summary, null, 2))
        else console.log(JSON.stringify(summary))
        process.exitCode = exitCode
      })
      .catch((error) => {
        console.error(JSON.stringify({ ok: false, code: error?.code ?? 'FAILED', message: redactDiagnosticText(error?.message ?? String(error)) }))
        process.exitCode = 1
      })
  }
}
