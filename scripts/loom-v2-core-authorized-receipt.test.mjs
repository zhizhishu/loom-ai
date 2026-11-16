// Contract-only tests for the Core <-> genuinely guarded Pi receipt admission seam.
// Mock Core and synthetic receipt fixtures are NOT a production E4 or real-Provider test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CORE_AUTHORIZED_RECEIPT_SCHEMA,
  submitGuardedCandidateToCore,
  validateAuthorizedCoreReceipt
} from './loom-v2-core-authorized-receipt.mjs'
import { RUNTIME_EXECUTION_SCHEMA } from './loom-v2-runtime-execution.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'loom-guarded-core-bridge-'))
  const path = 'out.txt'
  const data = 'a mock Pi tool output, never a user document\n'
  writeFileSync(join(root, path), data)
  const id = 'run_a_123'
  const botId = 'bot_worker_a'
  const claim = { claimId: 'claim-1', fenceGeneration: 3, taskId: 'task-a', agentRunId: id,
    leaseExpiresAt: new Date(Date.now()+3600_000).toISOString(), expired:false, releasedAt: null }
  const grant = { runId: id, botId, workspaceRoot: root, allowedTools: ['write', 'read'],
    isolatedSelfOwnedWorkspace: true, expiresAt: Date.now() + 300_000 }
  const execution = { toolCallId: 'tool-1', toolName: 'write', finished: true, isError: false,
    toolResultLinked: true, toolResultIsError: false }
  const receipt = {
    schema: RUNTIME_EXECUTION_SCHEMA, runId: id, botId, status: 'settled',
    replayable: false, promptAttempted: true, promptAccepted: true,
    promptDeliveryKnown: true, settledObserved: true, budgetExceeded: false,
    cancel: { observed: false }, assistant: { providerError: false, assistantMessageObserved: true },
    providerConnection: 'loopback-mock', mockProvider: true, actualBackendVerified: false,
    userCredentialsUsed: false, realCommercialModelClaimed: false,
    ownerReviewRecorded: false, coreIntegrated: false, osSandbox: false,
    guard: { loaded: true, runId: id, botId, selfTestFailures: 0, selfTestCases: 11,
      unguardedExecutions: 0, executedCount: 1, allowedCount: 1,
      decisions: [{toolCallId:'tool-1', toolName:'write', decision:'allow', relPath:'out.txt'}] },
    pathGuard: { prePromptVerified: true, guardPidMatchesSpawned: true },
    isolation: { workspaceReal: root }, tools: {
      allowlist: ['write', 'read'], executedCount: 1, unfinishedCount: 0,
      deniedAttempts: [], executions: [execution]
    },
    artifacts: [{ relativePath: path, sha256: digest(data), sizeBytes: Buffer.byteLength(data) }]
  }
  const input = { missionId: 'mission-one', taskId: 'task-a', agentRunId: id, botId, claim, grant,
    receipt, workspaceRoot: root, artifactRelativePath: path,
    acceptanceCriteriaVersion: 'criteria-v1', commandId: 'candidate-command-1' }
  const calls = []
  const core = { async request(method, params) {
    calls.push({ method, params })
    if (method === 'loom.claims.list') return { evaluatedAt:new Date().toISOString(), claims: [{ ...claim }] }
    if (method === 'loom.artifact.register') return { artifact: {
      artifactId: 'artifact-1', taskId: input.taskId, relativePath: input.artifactRelativePath,
      sha256: receipt.artifacts[0].sha256, sizeBytes: receipt.artifacts[0].sizeBytes
    } }
    if (method === 'loom.candidate.record') return {
      candidateId: 'candidate-1', taskId: input.taskId, agentRunId: id,
      contentHash: receipt.artifacts[0].sha256, evidenceIds: ['artifact-1'],
      verificationStatus: 'unverified', acceptanceStatus: 'pending'
    }
    throw new Error('unexpected_method:' + method)
  } }
  return { root, input, core, calls }
}
function withFixture(fn) {
  return async () => {
    const f = fixture()
    try { await fn(f) } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
}

test('approved E3-only guarded receipt -> Core claim re-read -> host hash -> pending candidate, no review', withFixture(async ({input,core,calls}) => {
  const result = await submitGuardedCandidateToCore({ ...input, core })
  assert.equal(result.schema, CORE_AUTHORIZED_RECEIPT_SCHEMA)
  assert.equal(result.coreIntegrated, true)
  assert.equal(result.scope, 'E3-sandbox-only')
  assert.equal(result.mockProvider, true)
  assert.equal(result.ownerReviewRecorded, false)
  assert.equal(result.technicalVerificationRecorded, false)
  assert.equal(result.artifactAuthorshipLinkedToToolCall, true)
  assert.equal(result.candidatePending, true)
  assert.equal(result.artifactId, 'artifact-1')
  assert.equal(result.candidateCommandId, input.commandId)
  assert.deepEqual(calls.map(c => c.method), ['loom.claims.list', 'loom.artifact.register', 'loom.candidate.record'])
  assert.equal(calls[2].params.claimId, input.claim.claimId)
  assert.equal(calls[2].params.fenceGeneration, input.claim.fenceGeneration)
  assert.deepEqual(calls[2].params.evidenceIds, ['artifact-1'])
  assert.equal(calls.some(c=>c.method === 'loom.review.record' || c.method === 'loom.verification.record'),false)
}))

for(const [label, mutate, expected] of [
  ['wrong Bot identity', f => { f.input.receipt.botId='other-bot' }, 'runtime_identity'],
  ['grant points at another Run', f => { f.input.grant.runId='different-run' }, 'grant_claim_mismatch'],
  ['Core claim fence changed in caller', f => { f.input.claim.fenceGeneration=0 }, 'claim_identity'],
  ['unknown outcome even with a disk file', f => { f.input.receipt.status='unknown_outcome' }, 'runtime_not_settled'],
  ['prompt did not reach Pi', f => { f.input.receipt.promptDeliveryKnown=false }, 'runtime_not_settled'],
  ['cancel after prompt before settle', f => { f.input.receipt.cancel.observed=true }, 'runtime_not_settled'],
  ['external model is NOT E3 qualified', f => { f.input.receipt.providerConnection='external'; f.input.receipt.mockProvider=false }, 'provider_scope'],
  ['spoofed user review', f => { f.input.receipt.ownerReviewRecorded=true }, 'provider_scope'],
  ['guard not proven before model', f => { f.input.receipt.pathGuard.prePromptVerified=false }, 'guard_not_verified'],
  ['missing guard self test', f => { f.input.receipt.guard.selfTestFailures=1 }, 'guard_not_verified'],
  ['denied tools do not count as completed work', f => { f.input.receipt.tools.deniedAttempts=[{toolCallId:'tool-1'}] }, 'tool_evidence'],
  ['model emitted tool intent only', f => { f.input.receipt.tools.executedCount=0 }, 'tool_evidence'],
  ['tool end is error', f => { f.input.receipt.tools.executions[0].isError=true }, 'tool_execution_unverified'],
  ['only read tool was executed', f => { f.input.receipt.tools.executions[0].toolName='read'; f.input.receipt.guard.decisions[0].toolName='read' }, 'artifact_not_linked_to_mutating_tool'],
  ['guard decision for unrelated output file', f => { f.input.receipt.guard.decisions[0].relPath='other.txt' }, 'artifact_not_linked_to_mutating_tool'],
  ['guard allowed no tool call', f => { f.input.receipt.guard.decisions=[]; f.input.receipt.guard.allowedCount=0 }, 'guard_execution_count_mismatch'],
  ['guard wrong tool id', f => { f.input.receipt.guard.decisions[0].toolCallId='tool-other' }, 'guard_execution_not_linked'],
  ['guard selftest count missing', f => { delete f.input.receipt.guard.selfTestCases }, 'guard_not_verified'],
  ['receipt digest differs from local bytes', f => { f.input.receipt.artifacts[0].sha256='a'.repeat(64) }, 'artifact_changed'],
  ['path parent escape', f => { f.input.artifactRelativePath='../outside.txt' }, 'artifact_path'],
  ['artifact points to mismatched filename', f => { f.input.receipt.artifacts[0].relativePath='another.txt' }, 'artifact_receipt'],
  ['grant not for isolated owned workspace', f => { f.input.grant.isolatedSelfOwnedWorkspace=false }, 'grant_write_requires_isolated_self_owned_workspace']
]) {
  test('fail closed before ANY Core RPC: ' + label, withFixture(async f => {
    mutate(f)
    await assert.rejects(() => submitGuardedCandidateToCore({ ...f.input, core:f.core }), new RegExp(expected))
    assert.equal(f.calls.length, 0, 'Core must not be invoked on bad receipt')
  }))
}

test('stale Core-held fence refuses before artifact registration', withFixture(async ({input,calls}) => {
  const core = { async request(method) {
    calls.push({method})
    if(method==='loom.claims.list') return {evaluatedAt:new Date().toISOString(),claims:[{...input.claim,fenceGeneration:4}]}
    throw new Error('must_not_write')
  }}
  await assert.rejects(() => submitGuardedCandidateToCore({...input,core}), /core_claim_lost_or_stale/)
  assert.deepEqual(calls.map(c=>c.method), ['loom.claims.list'])
}))
test('released claim refuses before artifact registration', withFixture(async ({input,calls}) => {
  const core = { async request(method) {
    calls.push({method})
    if(method==='loom.claims.list') return {evaluatedAt:new Date().toISOString(),claims:[{...input.claim,releasedAt:'2026-11-15T00:00:00Z'}]}
    throw new Error('must_not_write')
  }}
  await assert.rejects(() => submitGuardedCandidateToCore({...input,core}), /core_claim_lost_or_stale/)
  assert.deepEqual(calls.map(c=>c.method), ['loom.claims.list'])
}))
for (const [label, alterClaim, alterEnvelope] of [
  ['past lease expiration', claim => { claim.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString() }],
  ['Core reports expired lease', claim => { claim.expired = true }],
  ['invalid expiration format', claim => { claim.leaseExpiresAt = 'not-a-date' }],
  ['Core reports an unparseable evaluation time', () => {}, response => { response.evaluatedAt = 'unknown' }]
]) {
  test('Core verified lease fails closed before artifact: ' + label, withFixture(async ({ input, calls }) => {
    const result = { evaluatedAt: new Date().toISOString(), claims: [{ ...input.claim }] }
    alterClaim(result.claims[0])
    if (alterEnvelope) alterEnvelope(result)
    const core = { async request(method) {
      calls.push({ method })
      if (method === 'loom.claims.list') return result
      throw new Error('unexpected mutation')
    } }
    await assert.rejects(() => submitGuardedCandidateToCore({ ...input, core }), /core_claim_expired_or_unverifiable/)
    assert.deepEqual(calls.map(call => call.method), ['loom.claims.list'])
  }))
}

test('Core artifact digest mismatch prevents candidate submission', withFixture(async ({input,calls}) => {
  const core = { async request(method) {
    calls.push({method})
    if (method==='loom.claims.list') return {evaluatedAt:new Date().toISOString(),claims:[{...input.claim}]}
    if (method==='loom.artifact.register') return {artifact:{artifactId:'id',taskId:input.taskId,relativePath:'out.txt',
      sha256:'b'.repeat(64),sizeBytes:input.receipt.artifacts[0].sizeBytes}}
    throw new Error('candidate_must_not_be_called')
  }}
  await assert.rejects(()=>submitGuardedCandidateToCore({...input,core}),/core_artifact_mismatch/)
  assert.deepEqual(calls.map(c=>c.method), ['loom.claims.list','loom.artifact.register'])
}))
test('unknown Core candidate response is NOT retried, outcome not certified',withFixture(async ({input,calls})=>{
  const core={async request(method){
    calls.push({method})
    if(method==='loom.claims.list')return {evaluatedAt:new Date().toISOString(),claims:[{...input.claim}]}
    if(method==='loom.artifact.register')return {artifact:{artifactId:'artifact-1',taskId:input.taskId,
      relativePath:'out.txt',sha256:input.receipt.artifacts[0].sha256,sizeBytes:input.receipt.artifacts[0].sizeBytes}}
    if(method==='loom.candidate.record')throw new Error('wire_ack_lost')
  }}
  await assert.rejects(()=>submitGuardedCandidateToCore({...input,core}), /wire_ack_lost/)
  assert.deepEqual(calls.map(c=>c.method),['loom.claims.list','loom.artifact.register','loom.candidate.record'])
}))
