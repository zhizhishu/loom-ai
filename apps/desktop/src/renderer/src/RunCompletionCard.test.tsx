import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LoomArtifact, LoomCandidate } from '@contracts'
import { RunCompletionCard } from './RunCompletionCard'

const startedAt = '2026-09-06T06:00:00Z'
const endedAt = '2026-09-06T06:01:00Z'

const run = {
  id: 'run-1', status: 'succeeded' as const, startedAt, createdAt: startedAt, endedAt
}

const fileChanges = [{
  schemaVersion: 2 as const, agentRunId: 'run-1', executionEpoch: 1,
  files: [], fileCount: 3, operationCount: 5, additions: 12, deletions: 4, completedAt: endedAt
}]

const artifact = (overrides: Partial<LoomArtifact>): LoomArtifact => ({
  artifactId: 'artifact-1', planId: 'plan-1', taskId: null, agentRunId: 'run-1',
  relativePath: 'report.md', sha256: 'hash', sizeBytes: 2048, contentType: 'text/markdown',
  creatorId: 'agent_1', createdAt: startedAt, ...overrides
})

const candidate = (overrides: Partial<LoomCandidate>): LoomCandidate => ({
  candidateId: 'candidate-1', taskId: 'task-1', agentRunId: 'run-1', contentHash: 'hash',
  evidenceIds: ['artifact-1'],
  acceptanceCriteria: { version: 'v1', criteria: [] },
  previousCandidateId: null, verificationStatus: 'unverified', acceptanceStatus: 'pending',
  createdAt: startedAt, ...overrides
})

const render = (props: Partial<Parameters<typeof RunCompletionCard>[0]> = {}): string =>
  renderToStaticMarkup(createElement(RunCompletionCard, {
    run, fileChanges, ...props
  }))

describe('RunCompletionCard', () => {
  it('shows the completion summary and the change count', () => {
    const markup = render()
    expect(markup).toContain('data-run-completion-card-id="run-1"')
    expect(markup).toContain('工作了 1 分 0 秒')
    expect(markup).toContain('3 个文件')
    expect(markup).toContain('class="run-file-change-stat addition">+12<')
    expect(markup).toContain('class="run-file-change-stat deletion">−4<')
  })

  it('shows the acceptance badge from this run\'s candidates', () => {
    expect(render({ candidates: [candidate({ acceptanceStatus: 'accepted' })] }))
      .toContain('data-acceptance="accepted">已验收<')
    expect(render({ candidates: [candidate({ acceptanceStatus: 'rejected' })] }))
      .toContain('data-acceptance="rejected">已驳回<')
    expect(render({ candidates: [candidate({ acceptanceStatus: 'pending' })] }))
      .toContain('data-acceptance="pending">待验收<')
    expect(render({ candidates: [candidate({ agentRunId: 'run-2' })] }))
      .not.toContain('run-completion-acceptance')
  })

  it('links registered artifacts when an opener is available, counts them otherwise', () => {
    const artifacts = [artifact({}), artifact({ artifactId: 'artifact-2', relativePath: 'data.csv' })]
    const linked = render({ artifacts, onOpenArtifacts: () => undefined })
    expect(linked).toContain('查看成果（2 份）')
    expect(linked).toContain('<button type="button" class="run-completion-artifacts-link"')
    expect(render({ artifacts })).toContain('已登记成果 2 份')
    expect(render()).not.toContain('run-completion-artifacts')
  })

  it('keeps failed and stopped runs on the same card wording as the drawer summary', () => {
    expect(render({ run: { ...run, status: 'failed' } })).toContain('运行 1 分 0 秒后失败')
    expect(render({ run: { ...run, status: 'cancelled' } })).toContain('你在 1 分 0 秒后停止了运行')
  })
})
