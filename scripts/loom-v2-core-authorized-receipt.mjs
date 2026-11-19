// LOOM V2 E3-only seam: validate one REAL guarded Pi tool execution before Core candidate submission.
// The caller supplies a Core-issued Claim/Fence, an explicit per-run grant and the settled Pi receipt.
// The same authoritative Core SQLite must re-confirm the claim and compute the artifact's disk hash.
// NO Owner Review, technical verification, external provider qualification, or retry happens here.
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  RUNTIME_EXECUTION_SCHEMA,
  assertPerRunGrant,
  hashExpectedArtifacts
} from './loom-v2-runtime-execution.mjs'

export const CORE_AUTHORIZED_RECEIPT_SCHEMA = 'loom.core-authorized-pi-bridge.v1'

const fail = (code) => { throw new Error(`core_authorized_receipt:${code}`) }
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256
const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const samePath = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !isAbsolute(a) || !isAbsolute(b)) return false
  try {
    const left = realpathSync(a)
    const right = realpathSync(b)
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  } catch { return false }
}
const normalPath = (value) => typeof value === 'string'
  && value.length > 0 && !isAbsolute(value)
  && !value.split(/[\\/]+/).some((part) => part === '.' || part === '..' || part === '')
  && !value.includes('\0')

/**
 * Fail closed BEFORE the first Core mutation. "settled" alone is not completion:
 * a real guarded, tool-linked Pi execution plus a freshly rehashed local file are required.
 * Tool evidence proves a tool ran, but without a full tool-argument receipt it does not
 * prove that the particular artifact was authored by that tool: report this limit.
 */
export function validateAuthorizedCoreReceipt({
  missionId, taskId, agentRunId, botId, claim, grant, receipt,
  workspaceRoot, artifactRelativePath, acceptanceCriteriaVersion, commandId
}) {
  if (![missionId, taskId, agentRunId, botId, acceptanceCriteriaVersion, commandId].every(id)) fail('identity_missing')
  if (!object(claim) || !id(claim.claimId) || !Number.isSafeInteger(claim.fenceGeneration)
    || claim.fenceGeneration < 1 || claim.taskId !== taskId || claim.agentRunId !== agentRunId) fail('claim_identity')
  const authorized = assertPerRunGrant(grant)
  if (authorized.runId !== agentRunId || authorized.botId !== botId || !authorized.isolatedSelfOwnedWorkspace) {
    fail('grant_claim_mismatch')
  }
  if (!samePath(authorized.workspaceRoot, workspaceRoot)) fail('grant_workspace_mismatch')
  if (!object(receipt) || receipt.schema !== RUNTIME_EXECUTION_SCHEMA
    || receipt.runId !== agentRunId || receipt.botId !== botId) fail('runtime_identity')
  if (receipt.status !== 'settled' || receipt.replayable !== false
    || receipt.promptAttempted !== true || receipt.promptAccepted !== true
    || receipt.promptDeliveryKnown !== true || receipt.settledObserved !== true
    || receipt.budgetExceeded === true || receipt.cancel?.observed === true
    || receipt.assistant?.providerError === true) fail('runtime_not_settled')
  // This gate is ONLY the local mock-provider E3 qualification. Do not silently upgrade to E4.
  if (receipt.providerConnection !== 'loopback-mock' || receipt.mockProvider !== true
    || receipt.actualBackendVerified !== false || receipt.userCredentialsUsed !== false
    || receipt.realCommercialModelClaimed !== false || receipt.ownerReviewRecorded !== false
    || receipt.coreIntegrated !== false || receipt.osSandbox !== false) fail('provider_scope')
  if (!object(receipt.guard) || receipt.guard.loaded !== true
    || receipt.guard.runId !== agentRunId || receipt.guard.botId !== botId
    || receipt.guard.selfTestFailures !== 0 || !Number.isSafeInteger(receipt.guard.selfTestCases)
    || receipt.guard.selfTestCases < 11 || receipt.guard.unguardedExecutions !== 0
    || !object(receipt.pathGuard) || receipt.pathGuard.prePromptVerified !== true
    || receipt.pathGuard.guardPidMatchesSpawned !== true
    || !samePath(receipt.isolation?.workspaceReal, workspaceRoot)) fail('guard_not_verified')
  if (!object(receipt.tools) || !Array.isArray(receipt.tools.executions)
    || receipt.tools.unfinishedCount !== 0
    || !Number.isSafeInteger(receipt.tools.executedCount) || receipt.tools.executedCount < 1
    || receipt.tools.executedCount !== receipt.guard.executedCount
    || !Array.isArray(receipt.tools.deniedAttempts)
    || receipt.tools.deniedAttempts.length > 0
    || !Array.isArray(receipt.tools.allowlist)
    || receipt.tools.allowlist.length !== authorized.allowedTools.length
    || !authorized.allowedTools.every((tool) => receipt.tools.allowlist.includes(tool))) fail('tool_evidence')
  for (const execution of receipt.tools.executions) {
    if (!object(execution) || !authorized.allowedTools.includes(execution.toolName)
      || execution.finished !== true || execution.isError !== false
      || execution.toolResultLinked !== true || execution.toolResultIsError !== false
      || !id(execution.toolCallId)) fail('tool_execution_unverified')
  }
  if (!Array.isArray(receipt.guard.decisions)
    || receipt.guard.decisions.some((decision) => !object(decision)
      || !id(decision.toolCallId) || !authorized.allowedTools.includes(decision.toolName))) fail('guard_decisions_invalid')
  const allowedDecisions = receipt.guard.decisions.filter((decision) => decision.decision === 'allow')
  if (allowedDecisions.length !== receipt.guard.allowedCount
    || allowedDecisions.length !== receipt.tools.executedCount
    || new Set(allowedDecisions.map((decision) => decision.toolCallId)).size !== allowedDecisions.length) {
    fail('guard_execution_count_mismatch')
  }
  for (const execution of receipt.tools.executions) {
    if (!allowedDecisions.some((decision) => decision.toolCallId === execution.toolCallId
      && decision.toolName === execution.toolName)) fail('guard_execution_not_linked')
  }
  if (!normalPath(artifactRelativePath) || !Array.isArray(receipt.artifacts)
    || receipt.artifacts.length !== 1) fail('artifact_path')
  // A successful write/edit ToolCall with a matching allowed guard path binds the specific
  // artifact to a real execution, rather than merely observing an unrelated write tool.
  const artifactToolLinked = allowedDecisions.some((decision) =>
    (decision.toolName === 'write' || decision.toolName === 'edit')
    && typeof decision.relPath === 'string'
    && decision.relPath.replace(/\\\\/g, '/') === artifactRelativePath.replace(/\\\\/g, '/')
    && receipt.tools.executions.some((execution) => execution.toolCallId === decision.toolCallId))
  if (!artifactToolLinked) fail('artifact_not_linked_to_mutating_tool')
  const observed = receipt.artifacts[0]
  if (!object(observed) || observed.relativePath.replace(/\\/g, '/') !== artifactRelativePath.replace(/\\/g, '/')
    || !hex(observed.sha256) || !Number.isSafeInteger(observed.sizeBytes)
    || observed.sizeBytes < 1) fail('artifact_receipt')
  // The file MUST still be in the same isolated workspace, not a symlink or hardlink;
  // runtime receipt SHA must match a fresh read, and Core itself hashes again on registration.
  const fresh = hashExpectedArtifacts({ workspaceRoot, expectedArtifactPaths: [artifactRelativePath] })[0]
  if (observed.sha256 !== fresh.sha256 || observed.sizeBytes !== fresh.sizeBytes) fail('artifact_changed')
  return Object.freeze({
    missionId, taskId, agentRunId, botId, claimId: claim.claimId,
    fenceGeneration: claim.fenceGeneration, acceptanceCriteriaVersion, commandId,
    artifactRelativePath, artifactSha256: fresh.sha256, artifactBytes: fresh.sizeBytes,
    mockProvider: true, scope: 'E3-sandbox-only', realExternalProvider: false,
    ownerReviewRecorded: false, technicalVerificationRecorded: false,
    artifactAuthorshipLinkedToToolCall: true
  })
}

/**
 * Only the passed authenticated Core client is used. Caller owns commandId for recovery.
 * On lost RPC acknowledgment this function DOES NOT retry or guess success.
 */
export async function submitGuardedCandidateToCore({
  core, missionId, taskId, agentRunId, botId, claim, grant, receipt,
  workspaceRoot, artifactRelativePath, acceptanceCriteriaVersion, commandId
}) {
  if (typeof core?.request !== 'function') fail('core_client_missing')
  const vetted = validateAuthorizedCoreReceipt({
    missionId, taskId, agentRunId, botId, claim, grant, receipt,
    workspaceRoot, artifactRelativePath, acceptanceCriteriaVersion, commandId
  })
  const result = await core.request('loom.claims.list', { missionId })
  const rows = result?.claims
  if (!Array.isArray(rows)) fail('core_claim_list_unavailable')
  const held = rows.find((r) => r.claimId === claim.claimId)
  if (!held || held.taskId !== taskId || held.agentRunId !== agentRunId
    || held.fenceGeneration !== claim.fenceGeneration || held.releasedAt !== null) {
    fail('core_claim_lost_or_stale')
  }
  const leaseExpiresAt = Date.parse(held.leaseExpiresAt)
  const coreEvaluatedAt = Date.parse(result.evaluatedAt)
  if (!Number.isFinite(leaseExpiresAt) || !Number.isFinite(coreEvaluatedAt)
    || held.expired !== false || leaseExpiresAt <= coreEvaluatedAt
    || leaseExpiresAt <= Date.now() + 5_000) fail('core_claim_expired_or_unverifiable')
  const registration = await core.request('loom.artifact.register', {
    missionId, taskId, agentRunId, relativePath: artifactRelativePath
  })
  const artifact = registration?.artifact
  if (!object(artifact) || !id(artifact.artifactId)
    || artifact.taskId !== taskId || artifact.sha256 !== vetted.artifactSha256
    || artifact.sizeBytes !== vetted.artifactBytes || artifact.relativePath !== artifactRelativePath) {
    fail('core_artifact_mismatch')
  }
  const candidate = await core.request('loom.candidate.record', {
    missionId, taskId, agentRunId, claimId: held.claimId,
    fenceGeneration: held.fenceGeneration, commandId,
    contentHash: artifact.sha256, evidenceIds: [artifact.artifactId],
    acceptanceCriteriaVersion
  })
  if (!object(candidate) || candidate.taskId !== taskId
    || candidate.agentRunId !== agentRunId || candidate.contentHash !== artifact.sha256
    || candidate.verificationStatus !== 'unverified'
    || candidate.acceptanceStatus !== 'pending'
    || !Array.isArray(candidate.evidenceIds)
    || candidate.evidenceIds.length !== 1 || candidate.evidenceIds[0] !== artifact.artifactId) {
    fail('core_candidate_mismatch')
  }
  return Object.freeze({
    schema: CORE_AUTHORIZED_RECEIPT_SCHEMA, ...vetted,
    artifactId: artifact.artifactId, candidateId: candidate.candidateId,
    candidateCommandId: commandId, coreIntegrated: true,
    coreArtifactHashVerified: true, candidatePending: true,
    ownerReviewRecorded: false, technicalVerificationRecorded: false
  })
}
