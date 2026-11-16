// Unit tests for the pure parts of scripts/accept-loom-live-lead.mjs.
//
// Nothing here starts Core, touches a provider, or reads a credential: the acceptance script's
// side effects all live behind its `invokedDirectly` guard, so importing it is inert.
//
//   node --test scripts/lib/accept-loom-live-lead.test.mjs

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  FORBIDDEN_HOST_METHODS,
  buildMissionDescription,
  createHostRequestGuard,
  exitCodeFor,
  isolatedPathEntries,
  parseCliArgs,
  redactDeep,
  resolveGitBash,
  summarizeLeadChain,
  verifyArchivedArtifact
} from '../accept-loom-live-lead.mjs'

const MARKER = 'LIVE-LEAD-ACCEPTANCE'
const REVISION = 'REVIEW-REVISION-2'

// ---------------------------------------------------------------------------
// CLI parameters
// ---------------------------------------------------------------------------

test('cli defaults point at the reviewed public config and a bounded run', () => {
  const options = parseCliArgs([])
  assert.match(options.configPath, /live-dual\.public-config\.json$/)
  assert.equal(options.evidenceRoot, null)
  assert.equal(options.gitBash, null)
  assert.equal(options.keepFixture, false)
  assert.equal(options.pollMs, 1500)
  assert.equal(options.timeoutMs, 30 * 60_000)
})

test('cli accepts every documented flag', () => {
  const options = parseCliArgs([
    '--config', 'F:\\cfg\\public.json',
    '--evidence-root', 'F:\\out',
    '--git-bash', 'C:\\tools\\bash.exe',
    '--timeout-ms', '90000',
    '--poll-ms', '250',
    '--keep-fixture',
    '--json'
  ])
  assert.equal(options.configPath, resolve('F:\\cfg\\public.json'))
  assert.equal(options.evidenceRoot, resolve('F:\\out'))
  assert.equal(options.gitBash, resolve('C:\\tools\\bash.exe'))
  assert.equal(options.timeoutMs, 90_000)
  assert.equal(options.pollMs, 250)
  assert.equal(options.keepFixture, true)
  assert.equal(options.json, true)
})

test('cli refuses unknown flags, missing values and non-positive numbers', () => {
  assert.throws(() => parseCliArgs(['--nope']), /unknown argument: --nope/)
  assert.throws(() => parseCliArgs(['--config']), /--config needs a value/)
  assert.throws(() => parseCliArgs(['--config', '--json']), /--config needs a value/)
  assert.throws(() => parseCliArgs(['--timeout-ms', 'abc']), /positive integer/)
  assert.throws(() => parseCliArgs(['--timeout-ms', '0']), /positive integer/)
  assert.throws(() => parseCliArgs(['--poll-ms', '-5']), /positive integer/)
})

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

test('redaction removes the key from strings, nested objects and arrays without mutating input', () => {
  const key = 'sk-live-abcdef0123456789'
  const input = {
    providerKey: `prefix ${key} suffix`,
    nested: { list: [key, { deep: `Bearer ${key}` }], count: 3, ok: true, nothing: null },
    untouched: 'no secret here'
  }
  const snapshot = structuredClone(input)
  const redacted = redactDeep(input, [key])
  assert.deepEqual(input, snapshot, 'the input object must not be mutated')
  const serialized = JSON.stringify(redacted)
  assert.ok(!serialized.includes(key), 'the key must not survive redaction')
  assert.match(redacted.providerKey, /^prefix \[redacted\] suffix$/)
  assert.equal(redacted.nested.list[1].deep, 'Bearer [redacted]')
  assert.equal(redacted.nested.count, 3)
  assert.equal(redacted.nested.ok, true)
  assert.equal(redacted.untouched, 'no secret here')
})

test('redaction tolerates empty secret lists and returns a copy', () => {
  const input = { a: 'Bearer xyz', b: ['plain'] }
  const redacted = redactDeep(input, [])
  assert.notEqual(redacted, input)
  assert.equal(redacted.a, 'Bearer [redacted]')
  assert.deepEqual(redacted.b, ['plain'])
})

// ---------------------------------------------------------------------------
// Host request guard: the forbidden method list is the contract
// ---------------------------------------------------------------------------

test('the forbidden list is exactly the model-only LOOM write surface', () => {
  assert.deepEqual([...FORBIDDEN_HOST_METHODS].sort(), [
    'loom.artifact.register',
    'loom.candidate.record',
    'loom.claim.acquire',
    'loom.plan.import',
    'loom.review.record',
    'loom.task.release'
  ])
})

test('the host guard refuses every forbidden method and never reaches Core', async () => {
  const forwarded = []
  const guard = createHostRequestGuard(async (method, params) => {
    forwarded.push(method)
    return { method, params }
  })

  for (const method of FORBIDDEN_HOST_METHODS) {
    await assert.rejects(
      () => guard.request(method, { missionId: 'm1' }),
      (error) => error.code === 'HOST_METHOD_FORBIDDEN' && error.method === method
    )
  }
  assert.deepEqual(forwarded, [], 'a forbidden method must not be forwarded to Core')
  assert.equal(guard.rejected.length, FORBIDDEN_HOST_METHODS.length)
  assert.deepEqual(guard.rejected.map((entry) => entry.method), [...FORBIDDEN_HOST_METHODS])
  assert.deepEqual(guard.callCounts(), {})
})

test('the host guard counts allowed methods and keeps stable sorted counts', async () => {
  const guard = createHostRequestGuard(async (method) => ({ method }))
  await guard.request('missions.create', { commandId: 'c1' })
  await guard.request('missions.start', { commandId: 'c2' })
  await guard.request('missions.create', { commandId: 'c3' })
  await guard.request('loom.control.get', { missionId: 'm1' })
  assert.deepEqual(guard.callCounts(), {
    'loom.control.get': 1,
    'missions.create': 2,
    'missions.start': 1
  })
  assert.deepEqual(guard.methodNames(), ['loom.control.get', 'missions.create', 'missions.start'])
  assert.deepEqual(guard.rejected, [])
})

test('the host guard forwards the per-call timeout when one is given', async () => {
  const seen = []
  const guard = createHostRequestGuard(async (method, params, timeoutMs) => {
    seen.push({ method, timeoutMs })
    return {}
  })
  await guard.request('threads.snapshot', { threadId: 't1' }, 60_000)
  await guard.request('threads.snapshot', { threadId: 't1' })
  assert.deepEqual(seen, [
    { method: 'threads.snapshot', timeoutMs: 60_000 },
    { method: 'threads.snapshot', timeoutMs: undefined }
  ])
})

// ---------------------------------------------------------------------------
// Isolated environment parameters
// ---------------------------------------------------------------------------

test('isolated PATH keeps OS dirs first, then the bundle node dir, then Git dirs', () => {
  const entries = isolatedPathEntries({
    systemRoot: 'C:\\Windows',
    bundleNodeDir: 'F:\\bundle\\node',
    gitDirs: ['C:\\Program Files\\Git\\bin', 'C:\\Program Files\\Git\\usr\\bin']
  })
  assert.deepEqual(entries, [
    join('C:\\Windows', 'System32'),
    'C:\\Windows',
    'F:\\bundle\\node',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files\\Git\\usr\\bin'
  ])
})

test('isolated PATH drops duplicates case-insensitively and needs SystemRoot', () => {
  const entries = isolatedPathEntries({
    systemRoot: 'C:\\Windows',
    bundleNodeDir: 'c:\\windows',
    gitDirs: []
  })
  assert.deepEqual(entries, [join('C:\\Windows', 'System32'), 'C:\\Windows'])
  assert.throws(() => isolatedPathEntries({ bundleNodeDir: 'F:\\bundle\\node' }), /SystemRoot/)
})

test('git bash resolution prefers the explicit path and reports what it tried', { skip: process.platform !== 'win32' }, () => {
  const found = resolveGitBash({ explicitPath: 'D:\\Git\\bin\\bash.exe', exists: () => true })
  assert.equal(found.path, 'D:\\Git\\bin\\bash.exe')
  assert.equal(found.source, 'explicit')
  assert.deepEqual(found.tried, ['D:\\Git\\bin\\bash.exe'])
  assert.equal(found.pathEntries.length, 2)
  assert.equal(found.pathEntries[0], dirname('D:\\Git\\bin\\bash.exe'))
  assert.match(found.pathEntries[1], /usr[\\/]bin$/)

  const missing = resolveGitBash({ explicitPath: 'D:\\nope\\bash.exe', exists: () => false })
  assert.equal(missing.path, null)
  assert.deepEqual(missing.pathEntries, [])
  assert.equal(missing.tried.length, 1)
})

test('git bash resolution falls back to well-known locations', { skip: process.platform !== 'win32' }, () => {
  const found = resolveGitBash({
    exists: (candidate) => candidate === 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  })
  assert.equal(found.source, 'well-known')
  assert.equal(found.path, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe')
  assert.equal(found.pathEntries.length, 2)
  assert.equal(found.pathEntries[0], 'C:\\Program Files\\Git\\usr\\bin')
})

test('git bash resolution is testable without the Windows path dialect', () => {
  const found = resolveGitBash({ explicitPath: '/opt/git/bin/bash', exists: () => true })
  assert.equal(found.path, '/opt/git/bin/bash')
  assert.equal(found.pathEntries.length, 2)
  assert.equal(found.pathEntries[0], dirname('/opt/git/bin/bash'))
  assert.match(found.pathEntries[1], /[\\/]usr[\\/]bin$/)
})

// ---------------------------------------------------------------------------
// The Mission description is a user goal, never a plan template
// ---------------------------------------------------------------------------

test('the mission description carries the user requirement and both markers', () => {
  const description = buildMissionDescription({ workers: ['agent_a', 'agent_b'] })
  assert.ok(description.includes('agent_a'))
  assert.ok(description.includes('agent_b'))
  assert.ok(description.includes(MARKER))
  assert.ok(description.includes(REVISION))
  assert.match(description, /首轮|第一轮/)
  assert.match(description, /不得替代用户接受交付/)
})

test('the mission description contains no plan structure the Lead would only have to copy', () => {
  const description = buildMissionDescription({ workers: ['agent_a', 'agent_b'] })
  for (const forbidden of ['taskId', 'criterionId', '"criteria"', 'dependencies', 'upstreamTaskId', 'assigneeAgentId', '```json']) {
    assert.ok(!description.includes(forbidden), `the user goal must not embed a plan template: ${forbidden}`)
  }
})

test('the mission description states the round boundary without embedding a plan', () => {
  const description = buildMissionDescription({ workers: ['agent_a', 'agent_b'] })
  assert.ok(description.includes('只建包含两个交付任务的计划'))
  assert.ok(description.includes('不要 release'))
  assert.ok(description.includes('不要 agent.send'))
  assert.ok(description.includes('阶段评审与返工由 Core 接力完成'))
  assert.ok(description.includes('等待用户批准'))
})

test('the mission description refuses anything but two distinct workers', () => {
  assert.throws(() => buildMissionDescription({ workers: ['agent_a'] }), /exactly two/)
  assert.throws(() => buildMissionDescription({ workers: ['agent_a', 'agent_a'] }), /two distinct/)
  assert.throws(() => buildMissionDescription({}), /exactly two/)
})

// ---------------------------------------------------------------------------
// Chain summary: plan by the model, both workers submitting, one real rework, zero Owner review
// ---------------------------------------------------------------------------

function happyChain () {
  return {
    plan: { planId: 'plan_1' },
    tasks: [
      { taskId: 'task-a', status: 'in_review', assigneeAgentId: 'agent_a' },
      { taskId: 'task-b', status: 'in_review', assigneeAgentId: 'agent_b' }
    ],
    candidates: [
      { candidateId: 'c1', taskId: 'task-a', agentRunId: 'run-a', createdAt: '2026-01-01T00:00:01Z', previousCandidateId: null, evidenceIds: ['art1'], acceptanceStatus: 'pending', verificationStatus: 'unverified' },
      { candidateId: 'c2', taskId: 'task-a', agentRunId: 'run-a2', createdAt: '2026-01-01T00:00:04Z', previousCandidateId: 'c1', evidenceIds: ['art2'], acceptanceStatus: 'pending', verificationStatus: 'unverified' },
      { candidateId: 'c3', taskId: 'task-b', agentRunId: 'run-b', createdAt: '2026-01-01T00:00:02Z', previousCandidateId: null, evidenceIds: ['art3'], acceptanceStatus: 'pending', verificationStatus: 'unverified' }
    ],
    artifacts: [
      { artifactId: 'art1', taskId: 'task-a', agentRunId: 'run-a', creatorId: 'agent_a', relativePath: 'a.md', sha256: 'x1' },
      { artifactId: 'art2', taskId: 'task-a', agentRunId: 'run-a2', creatorId: 'agent_a', relativePath: 'a-v2.md', sha256: 'x2' },
      { artifactId: 'art3', taskId: 'task-b', agentRunId: 'run-b', creatorId: 'agent_b', relativePath: 'b.md', sha256: 'x3' }
    ],
    claims: [
      { claimId: 'cl1', taskId: 'task-a', agentRunId: 'run-a', claimantAgentId: 'agent_a' },
      { claimId: 'cl2', taskId: 'task-a', agentRunId: 'run-a2', claimantAgentId: 'agent_a' },
      { claimId: 'cl3', taskId: 'task-b', agentRunId: 'run-b', claimantAgentId: 'agent_b' }
    ],
    control: {
      stageReviews: [
        { taskId: 'task-a', candidateId: 'c1', verdict: 'request_changes', reviewerAgentId: 'agent_r', reviewerAgentRunId: 'run-r1', reviewedAt: '2026-01-01T00:00:03Z' },
        { taskId: 'task-a', candidateId: 'c2', verdict: 'pass', reviewerAgentId: 'agent_r', reviewerAgentRunId: 'run-r2', reviewedAt: '2026-01-01T00:00:05Z' },
        { taskId: 'task-b', candidateId: 'c3', verdict: 'pass', reviewerAgentId: 'agent_r', reviewerAgentRunId: 'run-r3', reviewedAt: '2026-01-01T00:00:03Z' }
      ],
      dispatches: [
        { kind: 'execute', status: 'settled', taskId: 'task-a' },
        { kind: 'execute', status: 'settled', taskId: 'task-b' },
        { kind: 'review', status: 'settled', taskId: 'task-a' },
        { kind: 'rework', status: 'settled', taskId: 'task-a' },
        { kind: 'review', status: 'settled', taskId: 'task-a' },
        { kind: 'handoff', status: 'settled', taskId: 'task-a' }
      ]
    },
    runs: [
      { id: 'run-lead', agentId: 'agent_lead', status: 'succeeded' },
      { id: 'run-a', agentId: 'agent_a', status: 'succeeded' },
      { id: 'run-a2', agentId: 'agent_a', status: 'succeeded' },
      { id: 'run-b', agentId: 'agent_b', status: 'succeeded' },
      { id: 'run-r1', agentId: 'agent_r', status: 'succeeded' },
      { id: 'run-r2', agentId: 'agent_r', status: 'succeeded' },
      { id: 'run-r3', agentId: 'agent_r', status: 'succeeded' }
    ],
    ownerReviews: [],
    workerAgentIds: ['agent_a', 'agent_b'],
    fileTexts: {
      c1: `# worker a\n${MARKER}\nDRAFT\n`,
      c2: `# worker a\n${MARKER}\n${REVISION}\n`,
      c3: `# worker b\n${MARKER}\n`
    }
  }
}

test('the happy chain proves model plan, two worker submissions, one rework and zero Owner reviews', () => {
  const summary = summarizeLeadChain(happyChain())
  assert.deepEqual(summary.reasons, [])
  assert.equal(summary.planAuthoredByModel, true)
  assert.equal(summary.bothWorkersSubmitted, true)
  assert.equal(summary.claimsAreCoreOwned, true)
  assert.equal(summary.reworkObserved, true)
  assert.equal(summary.ownerReviewCount, 0)
  assert.equal(summary.passesNeverAccepted, true)
  assert.equal(summary.reworkedTasks.length, 1)
  assert.equal(summary.reworkedTasks[0].firstCandidateLackedRevisionMarker, true)
  assert.equal(summary.reworkedTasks[0].secondCandidateHasRevisionMarker, true)
  assert.equal(summary.reworkedTasks[0].reviewerIsSeparate, true)
  assert.equal(exitCodeFor(summary), 0)
})

test('an Owner review on the reviews axis fails the run', () => {
  const chain = happyChain()
  chain.ownerReviews = [{ reviewId: 'r1', verdict: 'accepted' }]
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.ownerReviewCount, 1)
  assert.ok(summary.reasons.includes('owner_review_not_zero'))
  assert.equal(exitCodeFor(summary), 1)
})

test('a pass without a rework is reported as unobserved, not as success', () => {
  const chain = happyChain()
  chain.candidates = chain.candidates.filter((candidate) => candidate.candidateId !== 'c2')
  chain.artifacts = chain.artifacts.filter((artifact) => artifact.artifactId !== 'art2')
  chain.control.stageReviews = chain.control.stageReviews.filter((review) => review.candidateId !== 'c2')
  chain.control.dispatches = chain.control.dispatches.filter((dispatch) => dispatch.kind !== 'rework')
  delete chain.fileTexts.c2
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.reworkObserved, false)
  assert.ok(summary.reasons.includes('rework_not_observed'))
  assert.ok(summary.reasons.includes('dispatch_kind_missing:rework'))
  assert.equal(exitCodeFor(summary), 3)
})

test('a planned task the Host had to write, an accepted task or a failed run fails the run', () => {
  const noPlan = happyChain()
  noPlan.plan = null
  assert.ok(summarizeLeadChain(noPlan).reasons.includes('plan_not_authored'))

  const accepted = happyChain()
  accepted.tasks[0].status = 'done'
  assert.ok(summarizeLeadChain(accepted).reasons.includes('host_or_model_accepted_a_delivery'))

  const failed = happyChain()
  failed.runs[3].status = 'failed'
  assert.ok(summarizeLeadChain(failed).reasons.includes('a_run_failed'))

  const pending = happyChain()
  pending.control.dispatches[5].status = 'dispatched'
  assert.ok(summarizeLeadChain(pending).reasons.includes('a_dispatch_is_still_pending'))
})

test('a candidate produced by another agent Run does not count as a worker submission', () => {
  const chain = happyChain()
  chain.candidates[0].agentRunId = 'run-lead'
  chain.candidates[1].agentRunId = 'run-lead'
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.bothWorkersSubmitted, false)
  assert.ok(summary.reasons.includes('workers_did_not_submit_their_own_candidates'))
  assert.equal(exitCodeFor(summary), 1)
})

test('a first candidate that already carries the revision marker weakens the rework proof', () => {
  const chain = happyChain()
  chain.fileTexts.c1 = `# worker a\n${MARKER}\n${REVISION}\n`
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.reworkedTasks[0].firstCandidateLackedRevisionMarker, false)
  assert.equal(summary.reworkObserved, false)
  assert.equal(exitCodeFor(summary), 3)
})

test('a reviewer that is also the producer is visible in the summary', () => {
  const chain = happyChain()
  chain.control.stageReviews[0].reviewerAgentRunId = 'run-a'
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.reworkedTasks[0].reviewerIsSeparate, false)
})

// ---------------------------------------------------------------------------
// Archive verification: loom.artifact.preview, never the mutable workspace
// ---------------------------------------------------------------------------

function artifactFixture (overrides = {}) {
  const text = `# worker a\n${MARKER}\n`
  const bytes = Buffer.from(text, 'utf8')
  return {
    text,
    registered: {
      artifactId: 'art1',
      relativePath: 'a.md',
      taskId: 'task-a',
      agentRunId: 'run-a',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      ...overrides.registered
    },
    preview: {
      artifactId: 'art1',
      relativePath: 'a.md',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      text,
      unavailableReason: null,
      ...overrides.preview
    }
  }
}

test('a matching archived preview verifies id, sha256 and size from the archive only', () => {
  const fixture = artifactFixture()
  const check = verifyArchivedArtifact({ registered: fixture.registered, preview: fixture.preview })
  assert.equal(check.ok, true)
  assert.deepEqual(check.reasons, [])
  assert.equal(check.text, fixture.text)
  assert.equal(check.archiveSha256, fixture.registered.sha256)
})

test('a preview that answers for another artifact id fails closed', () => {
  const fixture = artifactFixture({ preview: { artifactId: 'art-other' } })
  const check = verifyArchivedArtifact({ registered: fixture.registered, preview: fixture.preview })
  assert.equal(check.ok, false)
  assert.ok(check.reasons.includes('archive_artifact_id_mismatch'))
})

test('a preview whose sha256 disagrees with the registered row fails closed', () => {
  const fixture = artifactFixture({ preview: { sha256: 'f'.repeat(64) } })
  const check = verifyArchivedArtifact({ registered: fixture.registered, preview: fixture.preview })
  assert.equal(check.ok, false)
  assert.ok(check.reasons.includes('archive_sha256_mismatch'))
})

test('a preview whose size disagrees with the registered row fails closed', () => {
  const fixture = artifactFixture({ preview: { sizeBytes: 1 } })
  const check = verifyArchivedArtifact({ registered: fixture.registered, preview: fixture.preview })
  assert.equal(check.ok, false)
  assert.ok(check.reasons.includes('archive_size_mismatch'))
  // The body still matches the original registration; only the receipt lied.
  assert.equal(check.reasons.includes('archive_body_size_mismatch'), false)
  // Even two matching but false metadata sizes cannot overrule actual bytes.
  const jointlyWrong = verifyArchivedArtifact({
    registered: { ...fixture.registered, sizeBytes: 1 }, preview: fixture.preview
  })
  assert.equal(jointlyWrong.ok, false)
  assert.ok(jointlyWrong.reasons.includes('archive_body_size_mismatch'))
})

test('text whose UTF-8 bytes do not rehash to the registered digest fails closed', () => {
  const fixture = artifactFixture({ preview: { text: `# worker a\n${MARKER}\nTAMPERED\n` } })
  const check = verifyArchivedArtifact({ registered: fixture.registered, preview: fixture.preview })
  assert.equal(check.ok, false)
  assert.ok(check.reasons.includes('archive_body_sha256_mismatch'))
  assert.ok(check.reasons.includes('archive_body_size_mismatch'))
})

test('an unavailable archive is reported by reason instead of passing', () => {
  const fixture = artifactFixture({ preview: { text: null, unavailableReason: 'binary' } })
  const check = verifyArchivedArtifact({ registered: fixture.registered, preview: fixture.preview })
  assert.equal(check.ok, false)
  assert.ok(check.reasons.includes('archive_unavailable:binary'))
  assert.equal(check.text, null)
})

test('a missing preview payload fails closed', () => {
  const fixture = artifactFixture()
  assert.deepEqual(verifyArchivedArtifact({ registered: fixture.registered }).reasons, ['archive_preview_missing'])
  assert.deepEqual(verifyArchivedArtifact({}).reasons, ['archive_registration_missing'])
})

test('archived bytes decide the markers even when the workspace copy has drifted', () => {
  const chain = happyChain()
  // First draft came from the archive; the workspace copy was legitimately edited afterwards.
  chain.workspaceDrift = { art1: { relativePath: 'a.md', registeredSha256: 'x1', workspaceSha256: 'drifted', present: true, matchesRegistered: false } }
  chain.archiveChecks = {
    art1: { artifactId: 'art1', ok: true, reasons: [], text: chain.fileTexts.c1 },
    art2: { artifactId: 'art2', ok: true, reasons: [], text: chain.fileTexts.c2 },
    art3: { artifactId: 'art3', ok: true, reasons: [], text: chain.fileTexts.c3 }
  }
  const summary = summarizeLeadChain(chain)
  assert.deepEqual(summary.reasons, [], 'workspace drift must never re-judge an archived candidate')
  assert.equal(summary.reworkObserved, true)
  assert.equal(summary.reworkedTasks[0].firstCandidateLackedRevisionMarker, true)
  assert.equal(exitCodeFor(summary), 0)
})

test('a failed archive check fails the run and cannot prove the rework marker', () => {
  const chain = happyChain()
  chain.fileTexts = {}
  chain.archiveChecks = {
    art1: { artifactId: 'art1', ok: false, reasons: ['archive_body_sha256_mismatch'], text: null },
    art2: { artifactId: 'art2', ok: true, reasons: [], text: 'x' },
    art3: { artifactId: 'art3', ok: true, reasons: [], text: 'y' }
  }
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.reworkObserved, false)
  assert.ok(summary.reasons.includes('archive_body_sha256_mismatch'))
  assert.ok(summary.reasons.includes('archive_verification_failed'))
  assert.deepEqual(summary.archiveFailures.map((entry) => entry.artifactId), ['art1'])
  assert.equal(exitCodeFor(summary), 1)
})

test('Core must have dispatched EXECUTE after the approval', () => {
  const noExecute = happyChain()
  noExecute.control.dispatches = noExecute.control.dispatches.filter((dispatch) => dispatch.kind !== 'execute')
  const summary = summarizeLeadChain(noExecute)
  assert.ok(summary.reasons.includes('core_execute_dispatch_missing'))
  assert.equal(exitCodeFor(summary), 1)
})

test('a worker started before the Owner approval is reported, not hidden', () => {
  const chain = happyChain()
  chain.policyApprovedAt = '2026-01-01T00:00:10Z'
  chain.runs = chain.runs.map((run) => run.agentId === 'agent_a'
    ? { ...run, startedAt: '2026-01-01T00:00:01Z' }
    : run)
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.workersStartedBeforeApproval, true)
  assert.ok(summary.reasons.includes('workers_started_before_approval'))
  assert.equal(exitCodeFor(summary), 1)
})

test('workers started after the approval raise nothing', () => {
  const chain = happyChain()
  chain.policyApprovedAt = '2026-01-01T00:00:00Z'
  chain.runs = chain.runs.map((run) => ({ ...run, startedAt: '2026-01-01T00:00:01Z' }))
  const summary = summarizeLeadChain(chain)
  assert.equal(summary.workersStartedBeforeApproval, false)
  assert.deepEqual(summary.reasons, [])
  assert.equal(exitCodeFor(summary), 0)
})

test('exit codes cover the missing-summary and structural cases', () => {
  assert.equal(exitCodeFor(null), 1)
  assert.equal(exitCodeFor({ reworkObserved: true, reasons: [] }), 0)
  assert.equal(exitCodeFor({ reworkObserved: false, reasons: ['rework_not_observed'] }), 3)
  assert.equal(exitCodeFor({ reworkObserved: true, reasons: ['a_run_failed'] }), 1)
})
