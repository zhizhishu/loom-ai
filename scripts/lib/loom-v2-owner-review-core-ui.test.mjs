// Real Core + production renderer review service integration, in a disposable Windows fixture.
// This is an explicit service-level review test, NOT a real UI click, real Pi run, or E4-E7 release.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  defaultCoreBinaryPath, verifyCachedCoreBinary, startIsolatedCore, stopCoreOrFail
} from '../loom-v2-core-pi-integration.mjs'
import { removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'

const repository = resolve(import.meta.dirname, '..', '..')
const hash = text => createHash('sha256').update(text).digest('hex')
const TASKS = ['owner-review-worker-a', 'owner-review-worker-b']
const CRITERION = 'evidence-visible'
const VERSION = 'owner-review-isolated-v1'

test('Mikka production review service with real isolated Core: explicit verdict, unknown retry, second candidate pending', {
  timeout: 240_000,
  skip: process.platform !== 'win32' && 'Windows protected DACL Core root required'
}, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'loom-v2-core-owner-ui-'))
  const home = join(fixture, 'home')
  const temporary = join(fixture, 'tmp')
  const runtime = join(fixture, 'runtime')
  for (const dir of [home, temporary, runtime]) mkdirSync(dir)
  const environment = {
    HOME: home, USERPROFILE: home, TMP: temporary, TEMP: temporary, TMPDIR: temporary,
    XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: runtime, APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata')
  }
  const contained = path => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
  }
  let core = null
  let dataDir = null
  let preserve = false
  try {
    // Compile only the actual renderer data-layer source; no mock service code or UI shell.
    const built = await build({
      entryPoints: [join(repository, 'apps/desktop/src/renderer/src/loom-native/artifact-service.ts')],
      bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false, logLevel: 'silent'
    })
    assert.equal(built.outputFiles.length, 1)
    const bundleFile = join(fixture, 'production-artifact-service.mjs')
    writeFileSync(bundleFile, built.outputFiles[0].contents)
    const ui = await import(pathToFileURL(bundleFile).href)

    const binary = defaultCoreBinaryPath()
    const binaryMeta = await verifyCachedCoreBinary(binary)
    dataDir = JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], {
      encoding: 'utf8', env: { ...process.env, ...environment }
    })).core
    assert.ok(contained(dataDir))
    const skillRoot = join(dataDir, 'managed-skill-library')
    const mcpPath = join(dataDir, 'mcp.json')
    assert.ok(contained(skillRoot) && contained(mcpPath))
    core = startIsolatedCore({
      dataDir, skillRoot, mcpPath, binaryPath: binary, environment
    })
    await core.ready
    await core.settled()
    const member = (await core.request('members.list')).find(row => row.presence === 'present')
    assert.ok(member, 'Core must expose trusted fixture member')
    const missionId = (await core.request('missions.create', {
      commandId: randomUUID(), command: {
        title: 'Owner review isolated integration',
        description: 'Synthetic artifacts, real Core and real Mikka review service; no user actions.',
        projectPath: '', projectBindingKind: 'quick_chat',
        memberAgentIds: [member.agentId], defaultLeadAgentId: member.agentId,
        tags: ['owner-review-sandbox']
      }
    })).payload?.missionId
    assert.ok(typeof missionId === 'string' && missionId)
    const plan = await core.request('loom.plan.import', {
      missionId, goal: 'Two fixture candidates; manually review only first',
      acceptanceCriteriaVersion: VERSION,
      criteria: [{ criterionId: CRITERION, text: 'Inspect archived text' }],
      tasks: TASKS.map(taskId => ({ taskId, title: taskId, description: 'Fixture-only work' })),
      dependencies: []
    })
    assert.ok(plan.planId)
    const workspace = join(dataDir, 'quick-chat')
    mkdirSync(workspace, { recursive: true })
    const candidates = []
    const artifacts = []
    for (const [index, taskId] of TASKS.entries()) {
      await core.request('loom.task.release', { missionId, taskId })
      const agentRunId = randomUUID()
      const claim = await core.request('loom.claim.acquire', {
        missionId, taskId, agentRunId, commandId: randomUUID(), leaseSeconds: 1200
      })
      const contents = '# Fixture worker ' + (index + 1) + '\nIsolated Core review text.\n'
      const relativePath = 'owner-review-fixture-' + (index + 1) + '.md'
      writeFileSync(join(workspace, relativePath), contents)
      const registered = await core.request('loom.artifact.register', {
        missionId, taskId, agentRunId, relativePath
      })
      const artifact = registered.artifact
      assert.equal(artifact.sha256, hash(contents), 'Host must hash fixture bytes')
      const candidate = await core.request('loom.candidate.record', {
        missionId, taskId, agentRunId, claimId: claim.claimId, fenceGeneration: claim.fenceGeneration,
        commandId: randomUUID(), contentHash: artifact.sha256,
        evidenceIds: [artifact.artifactId], acceptanceCriteriaVersion: VERSION
      })
      assert.equal(candidate.acceptanceStatus, 'pending')
      assert.equal(candidate.verificationStatus, 'unverified')
      candidates.push(candidate)
      artifacts.push(artifact)
    }
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }), [],
      'two candidate inserts must never auto-record Owner Review')
    assert.deepEqual((await core.request('loom.tasks.list', { missionId })).map(t => t.status),
      ['in_review', 'in_review'])

    const factsBundle = {
      mission: { missionId },
      tasks: await core.request('loom.tasks.list', { missionId }),
      candidates: await core.request('loom.candidates.list', { missionId }),
      artifacts: (await core.request('loom.artifacts.list', { missionId })).artifacts,
      reviews: await core.request('loom.reviews.list', { missionId }),
      verifications: []
    }
    const preview = await ui.readArtifactPreview(core, missionId, artifacts[0].artifactId)
    assert.deepEqual(preview, {
      status: 'ready', text: readFileSync(join(workspace, artifacts[0].relativePath), 'utf8')
    })
    const secondPreview = await ui.readArtifactPreview(core, missionId, artifacts[1].artifactId)
    assert.equal(secondPreview.status, 'ready')
    const missingPreview = await ui.readArtifactPreview(core, missionId, 'missing-evidence-id')
    assert.equal(missingPreview.status, 'error',
      'a genuinely unknown artifact must show a read error, never fake not_archived')
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }), [],
      'opening valid or invalid previews must never mutate Owner Review')
    const facts = ui.artifactCandidateFacts(factsBundle, artifacts[0], candidates[0])
    assert.equal(facts.reviewable, true)
    assert.equal(facts.latest, true)
    assert.equal(facts.criteriaVersion, VERSION)
    assert.deepEqual(facts.criteria.map(c => c.criterionId), [CRITERION])
    assert.throws(() => ui.prepareArtifactReviewAttempt(missionId, facts, {
      candidateId: candidates[0].candidateId, verdict: 'accepted',
      reason: 'Reviewed', satisfied: []
    }), /验收标准/)
    const draft = {
      candidateId: candidates[0].candidateId, verdict: 'accepted',
      reason: 'Explicit fixture review after reading archive', satisfied: [CRITERION]
    }
    const attempt = ui.prepareArtifactReviewAttempt(missionId, facts, draft)
    assert.ok(Object.isFrozen(attempt.payload.criteriaResults))
    assert.equal(Object.hasOwn(attempt.payload, 'reviewerId'), false)
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }), [],
      'preparing an intent cannot write a review')

    // Core also rejects a forged accepted verdict with false criteria, independent of UI validation.
    await assert.rejects(core.request('loom.review.record', {
      ...attempt.payload, commandId: randomUUID(),
      criteriaResults: [{ criterionId: CRITERION, satisfied: false, evidenceIds: [], note: null }],
      reviewerId: 'fake_reviewer'
    }), err => err?.kind === 'domain_rejection' && err?.code === 'LOOM_REVIEW_CRITERIA_INCOMPLETE')
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }), [])

    // Drop first reply only AFTER real Core has persisted. UI must remain unknown until same-ID retry.
    let lost = false
    const submitted = []
    const rpc = {
      request: async (method, params) => {
        if (method !== 'loom.review.record') return core.request(method, params)
        submitted.push(structuredClone(params))
        const result = await core.request(method, params)
        if (!lost) {
          lost = true
          throw new Error('fixture: response lost after durable Core commit')
        }
        return result
      }
    }
    const first = await ui.sendArtifactReviewAttempt(rpc, attempt)
    assert.equal(first.state, 'unknown', 'connection loss is never UI proof of acceptance')
    assert.equal((await core.request('loom.reviews.list', { missionId })).length, 1)
    const second = await ui.sendArtifactReviewAttempt(rpc, attempt)
    assert.equal(second.state, 'completed', JSON.stringify(second))
    assert.equal(second.receipt.replayed, true)
    assert.equal(second.receipt.review.reviewerId, 'local_user',
      'trusted Host must inject reviewer identity; client must not send it')
    assert.equal(second.receipt.candidateAcceptanceStatus, 'accepted')
    assert.equal(submitted.length, 2)
    assert.deepEqual(submitted[0], submitted[1], 'unknown retry must not mutate frozen command')
    assert.equal(submitted[1].commandId, attempt.commandId)
    assert.equal(Object.hasOwn(submitted[0], 'reviewerId'), false)
    assert.equal((await core.request('loom.reviews.list', { missionId })).length, 1)
    // A new commandId is not a replay: the Core must independently refuse a second verdict.
    await assert.rejects(core.request('loom.review.record', {
      ...attempt.payload, commandId: randomUUID()
    }), err => err?.kind === 'domain_rejection' && err?.code === 'LOOM_REVIEW_EXISTS',
    'a second Owner Review must be rejected at Core even if a UI tries to bypass its read-only state')
    const reviewedBundle = {
      ...factsBundle, candidates: await core.request('loom.candidates.list', { missionId }),
      reviews: await core.request('loom.reviews.list', { missionId })
    }
    assert.equal(ui.artifactCandidateFacts(reviewedBundle, artifacts[0], candidates[0]).reviewable, false,
      'reviewed candidate cannot produce a second acceptance action in Mikka')
    assert.equal((await core.request('loom.reviews.list', { missionId })).length, 1)

    await stopCoreOrFail(core, 'before same-SQLite review recovery')
    core = null
    core = startIsolatedCore({
      dataDir, skillRoot, mcpPath, binaryPath: binary, environment
    })
    await core.ready
    await core.settled()
    const reviews = await core.request('loom.reviews.list', { missionId })
    const restoredCandidates = await core.request('loom.candidates.list', { missionId })
    assert.equal(reviews.length, 1)
    assert.equal(reviews[0].reviewerId, 'local_user')
    assert.equal(restoredCandidates.find(row => row.candidateId === candidates[0].candidateId).acceptanceStatus, 'accepted')
    assert.equal(restoredCandidates.find(row => row.candidateId === candidates[1].candidateId).acceptanceStatus, 'pending',
      'second worker remains unreviewed after restart')
    assert.equal((await core.request('loom.tasks.list', { missionId }))
      .find(row => row.taskId === TASKS[1]).status, 'in_review')
    console.log(JSON.stringify({
      scope: 'E3-isolated-Core-and-production-Mikka-review-service',
      coreSha256: binaryMeta.sha256,
      mockArtifacts: true, realPiExecutedHere: false, humanClickedUI: false,
      HostReviewIdentity: 'local_user', explicitServiceOnly: true,
      recoveredUnknownWithSameCommand: true, replayed: true,
      reviews: 1, acceptedCandidates: 1, pendingCandidates: 1,
      E4: 'NOT_VERIFIED', E5: 'NOT_RUN', E6: 'NOT_VERIFIED', E7: 'NOT_RUN'
    }))
  } finally {
    if (core) {
      try { await stopCoreOrFail(core, 'after isolated review') }
      catch (error) { preserve = true; throw error }
    }
    if (!preserve) {
      if (dataDir) await removeEphemeralRuntimeCampFilesRoot(dataDir, {
        temporaryDirectory: fixture, homeDirectory: home
      })
      await rm(fixture, { recursive: true, force: true })
    }
  }
})
