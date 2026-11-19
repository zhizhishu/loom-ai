// LOOM V2 — r9 rerun: "write before claim" must happen ZERO times.
//
// Run (Root, from the repository root; nothing here starts a model, a Core binary or a CLI):
//
//   node scripts/loom-r9-write-before-claim-rerun.mjs
//   ROVAI_R9_RERUN_ITERATIONS=10 node scripts/loom-r9-write-before-claim-rerun.mjs
//
// Acceptance it serves (LOOM-ACCEPTANCE.md T34 / LOOM-HANDOFF.md:107): the r9 scenario rerun ten
// times with "write earlier than claim" = 0, and the raw receipt kept under
// `_artifacts/delivery-20261118/L12-*`.
//
// WHAT THIS REPLAYS, AND WHAT IT DOES NOT
// - It replays the exact ordering r9 recorded against the SAME guard source the Run loads
//   (`scripts/loom-v2-runtime-file-guard.ts`), driven by the SAME Core-written grant document
//   (`guard-grant.json` + `ROVAI_PI_FILE_GRANT_FILE`) that `pi::host` publishes and re-issues:
//     1. the Run is bound to a LOOM Task, so its grant says `requiresClaim:true` with an EMPTY
//        claim triple (the launch-time document, exactly the r9 window);
//     2. the model's first tool call is `write` of a file that does not exist yet — the r9 shape,
//        ~6s before `loom.claim`; it must be refused with `claim_missing` BEFORE any filesystem
//        probe, so `in_workspace_new_file` is unreachable while the claim is missing;
//     3. Core re-issues the same document after `loom.claim` (P0 step 3) — the same write must then
//        be allowed, or the gate is a wall rather than a gate;
//     4. Core re-issues it again after `loom.claim_heartbeat` (P0 step 6) with the renewed lease —
//        a Run that is still beating must still be able to write.
// - It does NOT drive a real model over a real Core session: the ordering is the thing under test,
//   and every decision, log line and grant document is produced by the production guard reading a
//   production-shaped grant file. A model-in-the-loop rerun is a separate acceptance run and its
//   receipt belongs beside this one.
//
// Exit status: 0 when every iteration recorded zero violations, 1 otherwise (each violation is
// printed and kept in the receipt).

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import loomRuntimeFileGuard from './loom-v2-runtime-file-guard.ts'

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GRANT_FILE_ENV = 'ROVAI_PI_FILE_GRANT_FILE'
const GUARD_SCHEMA = 'loom.runtime.file-guard.v1'
const WORKFLOW_TOOLS = ['read', 'write', 'edit', 'rovai_loom']
const ITERATIONS = Number.parseInt(process.env.ROVAI_R9_RERUN_ITERATIONS ?? '10', 10)
const EVIDENCE_ROOT = process.env.LOOM_R9_EVIDENCE_ROOT ?? join(REPOSITORY, '_artifacts', 'delivery-20261118')

if (!Number.isInteger(ITERATIONS) || ITERATIONS < 1) {
  throw new Error(`ROVAI_R9_RERUN_ITERATIONS must be a positive integer, got ${process.env.ROVAI_R9_RERUN_ITERATIONS}`)
}

function fakePi() {
  const handlers = new Map()
  return { handlers, on(event, handler) { handlers.set(event, handler) } }
}

/** Load the production guard against one Core-written grant file. */
async function loadGuard(grantFile) {
  const previous = process.env[GRANT_FILE_ENV]
  delete process.env.LOOM_RUN_GUARD
  process.env[GRANT_FILE_ENV] = grantFile
  const pi = fakePi()
  try {
    await loomRuntimeFileGuard(pi)
  } finally {
    if (previous === undefined) delete process.env[GRANT_FILE_ENV]
    else process.env[GRANT_FILE_ENV] = previous
  }
  const handler = pi.handlers.get('tool_call')
  if (typeof handler !== 'function') throw new Error('the guard registered no tool_call handler')
  return handler
}

function toolEvent(toolName, toolCallId, input) {
  return { type: 'tool_call', toolCallId, toolName, input }
}

/** The document `pi::PiFileGrant` writes: eight identity keys plus the claim triple and the flag. */
function grantDocument({ workspaceReal, logPath, expiresAtEpochMs, requiresClaim, claimId = '', fenceGeneration = 0, leaseExpiresAtEpochMs = 0 }) {
  return {
    schema: GUARD_SCHEMA,
    runId: 'run-r9',
    botId: 'bot-r9',
    executionEpoch: 1,
    workspaceReal,
    allowedTools: WORKFLOW_TOOLS,
    expiresAtEpochMs,
    logPath,
    claimId,
    fenceGeneration,
    leaseExpiresAtEpochMs,
    requiresClaim
  }
}

function readRecords(logPath) {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/** One r9 repetition: pre-claim write, claim re-issue, heartbeat re-issue. */
async function runIteration(iteration) {
  const root = mkdtempSync(join(tmpdir(), `loom-r9-rerun-${iteration}-`))
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  // The r9 file was brand-new: nothing of it existed when the model called `write`.
  const NEW_FILE = `r9-new-${iteration}.md`
  const existing = join(workspace, 'notes.md')
  writeFileSync(existing, 'in scope\n', 'utf8')
  const workspaceReal = realpathSync(workspace)
  const ctx = { cwd: workspaceReal }
  const logPath = join(root, 'guard.jsonl')
  const grantFile = join(root, 'guard-grant.json')
  // One expiry for every rewrite: the guard refuses a document whose Run/expiry moved under it, and
  // a re-issue is only ever allowed to move the claim triple and the requirement flag.
  const grantExpiry = Date.now() + 600_000
  const violations = []
  const steps = []

  try {
    // 1 · the launch-time document: LOOM Task bound, claim not earned yet.
    writeFileSync(grantFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, expiresAtEpochMs: grantExpiry, requiresClaim: true
    })), 'utf8')
    const guard = await loadGuard(grantFile)

    // 2 · the r9 write, before any claim.
    const newFileWrite = guard(toolEvent('write', `r9-new-${iteration}`, { path: NEW_FILE }), ctx)
    const editBefore = guard(toolEvent('edit', `r9-edit-${iteration}`, { path: 'notes.md' }), ctx)
    if (newFileWrite?.block !== true) violations.push('write-before-claim: a first creation was allowed before loom.claim')
    else if (!/claim_missing/.test(String(newFileWrite.reason))) violations.push(`write-before-claim: refused with ${newFileWrite.reason}`)
    if (editBefore?.block !== true) violations.push('edit-before-claim: an edit was allowed before loom.claim')
    if (readRecords(logPath).some((record) => record?.t === 'decision' && record?.decision === 'allow'
      && (record?.toolName === 'write' || record?.toolName === 'edit') && record?.reasonCode !== 'loom_operation_granted')) {
      violations.push('write-before-claim: the guard log records an allowed write/edit decision before the claim')
    }
    steps.push({ step: 'pre-claim write/edit refused', reasonCodes: readRecords(logPath).filter((r) => r?.t === 'decision').map((r) => r.reasonCode) })

    // 3 · Core re-issues the document after `loom.claim`.
    const claimedLease = Date.now() + 300_000
    writeFileSync(grantFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, expiresAtEpochMs: grantExpiry, requiresClaim: true,
      claimId: 'claim-r9', fenceGeneration: 1, leaseExpiresAtEpochMs: claimedLease
    })), 'utf8')
    if (guard(toolEvent('write', `r9-claimed-${iteration}`, { path: NEW_FILE }), ctx)?.block === true) {
      violations.push('claim-then-write: the write stayed refused after the claim was re-issued')
    }
    steps.push({ step: 'write allowed under the claim' })

    // 4 · Core re-issues the document again after `loom.claim_heartbeat` (P0 step 6).
    const renewedLease = claimedLease + 300_000
    writeFileSync(grantFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, expiresAtEpochMs: grantExpiry, requiresClaim: true,
      claimId: 'claim-r9', fenceGeneration: 1, leaseExpiresAtEpochMs: renewedLease
    })), 'utf8')
    if (guard(toolEvent('write', `r9-heartbeat-${iteration}`, { path: NEW_FILE }), ctx)?.block === true) {
      violations.push('heartbeat-then-write: the write was refused under the renewed lease')
    }
    steps.push({ step: 'write allowed under the renewed lease' })

    return {
      iteration,
      violations,
      steps,
      decisions: readRecords(logPath).filter((record) => record?.t === 'decision').length
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const startedAt = new Date().toISOString()
const iterations = []
for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
  iterations.push(await runIteration(iteration))
}
const violations = iterations.flatMap((result) => result.violations)

const receipt = {
  schema: 'loom.r9.write-before-claim.v1',
  generatedAt: new Date().toISOString(),
  startedAt,
  iterations: ITERATIONS,
  guardSource: 'scripts/loom-v2-runtime-file-guard.ts',
  grantSource: 'pi::PiFileGrant document (crates/rovai-core/src/pi/file_grant.rs), re-issued by pi::host exactly as it does after loom.claim and loom.claim_heartbeat',
  writeBeforeClaim: violations.length,
  results: iterations
}
mkdirSync(EVIDENCE_ROOT, { recursive: true })
const receiptPath = join(EVIDENCE_ROOT, `L12-r9-write-before-claim-${startedAt.replace(/[:.]/g, '-')}.json`)
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')

console.log(`r9 rerun: ${ITERATIONS} iterations, "write before claim" = ${violations.length}`)
for (const violation of violations) console.error(`  violation: ${violation}`)
console.log(`receipt: ${receiptPath}`)

if (violations.length > 0) process.exitCode = 1
