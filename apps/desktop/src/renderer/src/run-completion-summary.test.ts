import { describe, expect, it } from 'vitest'
import type { LoomArtifact, LoomCandidate } from '@contracts'
import {
  runAcceptanceBadge,
  runCompletionChangeText,
  runCompletionChangeTotals,
  runCompletionFacts,
  runRegisteredArtifacts
} from './run-completion-summary'

const startedAt = '2026-09-06T06:00:00Z'
const endedAt = '2026-09-06T06:01:00Z'

const run = (overrides: Partial<Parameters<typeof runCompletionFacts>[0]> = {}) => ({
  status: 'succeeded' as const,
  startedAt,
  createdAt: startedAt,
  endedAt,
  ...overrides
})

const changes = (overrides: Partial<{ fileCount: number; operationCount: number; additions?: number; deletions?: number }> = {}) => ({
  fileCount: 1,
  operationCount: 1,
  ...overrides
})

describe('runCompletionChangeTotals', () => {
  it('returns null without file-change cards or without files', () => {
    expect(runCompletionChangeTotals([])).toBeNull()
    expect(runCompletionChangeTotals([changes({ fileCount: 0, operationCount: 0 })])).toBeNull()
  })

  it('sums files and ± across epochs when every epoch reports them', () => {
    const totals = runCompletionChangeTotals([
      changes({ fileCount: 2, operationCount: 3, additions: 5, deletions: 1 }),
      changes({ fileCount: 1, operationCount: 2, additions: 7, deletions: 3 })
    ])
    expect(totals).toEqual({ files: 3, additions: 12, deletions: 4, operations: 5 })
    expect(runCompletionChangeText(totals!)).toBe('3 个文件 · +12 −4')
  })

  it('falls back to operation counts when an epoch lacks ± stats', () => {
    const totals = runCompletionChangeTotals([
      changes({ fileCount: 2, operationCount: 3, additions: 5, deletions: 1 }),
      changes({ fileCount: 1, operationCount: 2 })
    ])
    expect(totals).toEqual({ files: 3, additions: null, deletions: null, operations: 5 })
    expect(runCompletionChangeText(totals!)).toBe('3 个文件 · 5 次修改')
  })

  it('uses the singular wording for one file and one operation', () => {
    expect(runCompletionChangeText(runCompletionChangeTotals([changes()])!)).toBe('1 个文件 · 1 次修改')
  })

  it('hides zero ± sides but keeps the signed wording', () => {
    const totals = runCompletionChangeTotals([changes({ fileCount: 1, operationCount: 1, additions: 0, deletions: 0 })])
    expect(runCompletionChangeText(totals!)).toBe('1 个文件 · +0 −0')
  })
})

describe('runCompletionFacts', () => {
  it('keeps the existing run summary wording as the headline', () => {
    expect(runCompletionFacts(run(), [changes()])).toEqual({
      headline: '工作了 1 分 0 秒',
      changes: { files: 1, additions: null, deletions: null, operations: 1 }
    })
    expect(runCompletionFacts(run({ status: 'failed' }), []).headline).toBe('运行 1 分 0 秒后失败')
    expect(runCompletionFacts(run({ status: 'cancelled' }), []).headline).toBe('你在 1 分 0 秒后停止了运行')
  })

  it('reports no changes without file-change cards', () => {
    expect(runCompletionFacts(run(), []).changes).toBeNull()
  })
})

describe('runAcceptanceBadge', () => {
  const candidate = (overrides: Partial<LoomCandidate>): LoomCandidate => ({
    candidateId: 'candidate-1', taskId: 'task-1', agentRunId: 'run-1', contentHash: 'hash',
    evidenceIds: ['artifact-1'],
    acceptanceCriteria: { version: 'v1', criteria: [] },
    previousCandidateId: null, verificationStatus: 'unverified', acceptanceStatus: 'pending',
    createdAt: startedAt, ...overrides
  })

  it('labels the latest candidate of this run and ignores other runs', () => {
    const badge = runAcceptanceBadge([
      candidate({ acceptanceStatus: 'pending' }),
      candidate({ candidateId: 'candidate-2', createdAt: '2026-09-06T06:02:00Z', acceptanceStatus: 'accepted' }),
      candidate({ candidateId: 'candidate-3', agentRunId: 'run-2', acceptanceStatus: 'rejected' })
    ], 'run-1')
    expect(badge).toEqual({ status: 'accepted', label: '已验收' })
  })

  it('labels rejections and pending candidates', () => {
    expect(runAcceptanceBadge([candidate({ acceptanceStatus: 'rejected' })], 'run-1')?.label).toBe('已驳回')
    expect(runAcceptanceBadge([candidate({ acceptanceStatus: 'pending' })], 'run-1')?.label).toBe('待验收')
  })

  it('returns null without candidates or without one for this run', () => {
    expect(runAcceptanceBadge(undefined, 'run-1')).toBeNull()
    expect(runAcceptanceBadge([], 'run-1')).toBeNull()
    expect(runAcceptanceBadge([candidate({ agentRunId: 'run-2' })], 'run-1')).toBeNull()
  })
})

describe('runRegisteredArtifacts', () => {
  const artifact = (overrides: Partial<LoomArtifact>): LoomArtifact => ({
    artifactId: 'artifact-1', planId: 'plan-1', taskId: null, agentRunId: 'run-1',
    relativePath: 'report.md', sha256: 'hash', sizeBytes: 12, contentType: 'text/markdown',
    creatorId: 'agent_1', createdAt: startedAt, ...overrides
  })

  it('keeps only this run\'s artifacts and tolerates a missing projection', () => {
    const artifacts = [
      artifact({}),
      artifact({ artifactId: 'artifact-2', agentRunId: 'run-2', relativePath: 'other.md' }),
      artifact({ artifactId: 'artifact-3', agentRunId: null, relativePath: 'loose.md' })
    ]
    expect(runRegisteredArtifacts(artifacts, 'run-1').map((row) => row.artifactId)).toEqual(['artifact-1'])
    expect(runRegisteredArtifacts(null, 'run-1')).toEqual([])
    expect(runRegisteredArtifacts(undefined, 'run-1')).toEqual([])
  })
})
