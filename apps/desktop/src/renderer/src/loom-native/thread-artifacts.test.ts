import { describe, expect, it } from 'vitest'
import type { LoomArtifact, LoomCandidate, MissionRecord } from '@contracts'
import type { WorkBundle } from './types'
import {
  THREAD_RESULT_GROUPS,
  RESULT_GROUP_LABELS,
  artifactResultGroup,
  hasThreadResults,
  resultEntryTitle,
  resultGroupViews,
  resultStatusLabel,
  threadResultEntries
} from './thread-artifacts'

const artifact = (over: Partial<LoomArtifact>): LoomArtifact => ({
  artifactId: 'a1', planId: 'p1', taskId: 't1', agentRunId: 'r1',
  relativePath: 'out/report.md', sha256: 's', sizeBytes: 2048, contentType: null,
  creatorId: 'host', createdAt: '2026-11-26T10:00:00.000Z', ...over
})

const candidate = (over: Partial<LoomCandidate>): LoomCandidate => ({
  candidateId: 'c1', taskId: 't1', agentRunId: 'r1', contentHash: 'h', evidenceIds: ['a1'],
  acceptanceCriteria: { version: 'v1', criteria: [] }, previousCandidateId: null,
  verificationStatus: 'unverified', acceptanceStatus: 'pending',
  createdAt: '2026-11-26T10:00:00.000Z', ...over
})

const bundle = (threadId: string, artifacts: LoomArtifact[], candidates: LoomCandidate[] = []): WorkBundle => ({
  mission: {
    missionId: 'm1', title: '发版', threadId
  } as unknown as MissionRecord,
  plan: null, tasks: [], candidates, artifacts, reviews: [], verifications: []
})

describe('artifactResultGroup', () => {
  it('puts images in captures by extension or content type, before any name hint', () => {
    expect(artifactResultGroup(artifact({ relativePath: 'shots/run-01.png' }))).toBe('captures')
    expect(artifactResultGroup(artifact({ relativePath: 'out/chart', contentType: 'image/png' }))).toBe('captures')
    expect(artifactResultGroup(artifact({ relativePath: 'photo.jpeg' }))).toBe('captures')
  })

  it('puts plan documents in plans by path segment or Chinese title', () => {
    expect(artifactResultGroup(artifact({ relativePath: 'plan.md' }))).toBe('plans')
    expect(artifactResultGroup(artifact({ relativePath: 'docs/plans/auth-v1.md' }))).toBe('plans')
    expect(artifactResultGroup(artifact({ relativePath: 'docs/方案设计.md' }))).toBe('plans')
  })

  it('puts documents in reports', () => {
    expect(artifactResultGroup(artifact({ relativePath: 'out/report.md' }))).toBe('reports')
    expect(artifactResultGroup(artifact({ relativePath: 'out/index.html' }))).toBe('reports')
    expect(artifactResultGroup(artifact({ relativePath: 'notes.txt' }))).toBe('reports')
    expect(artifactResultGroup(artifact({ relativePath: 'out/summary', contentType: 'text/markdown' }))).toBe('reports')
  })

  it('puts everything else (code, patches, data) in changes', () => {
    expect(artifactResultGroup(artifact({ relativePath: 'src/app.ts' }))).toBe('changes')
    expect(artifactResultGroup(artifact({ relativePath: 'out/fix.patch' }))).toBe('changes')
    expect(artifactResultGroup(artifact({ relativePath: 'data/export.json' }))).toBe('changes')
  })

  it('never invents a fifth group', () => {
    const group = artifactResultGroup(artifact({ relativePath: 'weird/file.unknownext' }))
    expect(THREAD_RESULT_GROUPS).toContain(group)
  })
})

describe('threadResultEntries', () => {
  it('collects only the thread\'s bundles and keeps the same candidate resolution as the chat card', () => {
    const own = bundle('th-1', [artifact({ artifactId: 'a-code', relativePath: 'src/app.ts' })], [candidate({ candidateId: 'c-code', evidenceIds: ['a-code'], acceptanceStatus: 'accepted' })])
    const other = bundle('th-2', [artifact({ artifactId: 'a-other', relativePath: 'src/other.ts' })])
    const entries = threadResultEntries([own, other], 'th-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.selection.artifact.artifactId).toBe('a-code')
    expect(entries[0]?.selection.candidate?.candidateId).toBe('c-code')
    expect(entries[0]?.selection.bundle).toBe(own)
  })

  it('returns nothing without a thread', () => {
    expect(threadResultEntries([bundle('th-1', [artifact({})])], null)).toEqual([])
  })

  it('classifies each entry into one of the four groups', () => {
    const entries = threadResultEntries([bundle('th-1', [
      artifact({ artifactId: 'a-plan', relativePath: 'plan.md' }),
      artifact({ artifactId: 'a-code', relativePath: 'src/app.ts' }),
      artifact({ artifactId: 'a-report', relativePath: 'out/report.md' }),
      artifact({ artifactId: 'a-shot', relativePath: 'shots/run.png' })
    ])], 'th-1')
    expect(resultGroupViews(entries).map(view => view.group)).toEqual(THREAD_RESULT_GROUPS)
  })
})

describe('resultGroupViews', () => {
  it('shows groups in the fixed 计划/改动/报告/截图 order, each with its count', () => {
    const entries = threadResultEntries([bundle('th-1', [
      artifact({ artifactId: 'a-report', relativePath: 'out/report.md' }),
      artifact({ artifactId: 'a-shot', relativePath: 'shots/run.png' }),
      artifact({ artifactId: 'a-shot-2', relativePath: 'shots/run-2.png' }),
      artifact({ artifactId: 'a-code', relativePath: 'src/app.ts' })
    ])], 'th-1')
    const views = resultGroupViews(entries)
    expect(views.map(view => [view.label, view.count])).toEqual([['改动', 1], ['报告', 1], ['截图', 2]])
    expect(RESULT_GROUP_LABELS).toEqual({ plans: '计划', changes: '改动', reports: '报告', captures: '截图' })
  })

  it('leaves empty groups out', () => {
    const entries = threadResultEntries([bundle('th-1', [artifact({ artifactId: 'a-shot', relativePath: 'shots/run.png' })])], 'th-1')
    expect(resultGroupViews(entries).map(view => view.group)).toEqual(['captures'])
    expect(resultGroupViews([])).toEqual([])
  })
})

describe('result helpers', () => {
  it('hasThreadResults mirrors Mikka hasThreadArtifacts', () => {
    const entries = threadResultEntries([bundle('th-1', [artifact({})])], 'th-1')
    expect(hasThreadResults(entries)).toBe(true)
    expect(hasThreadResults([])).toBe(false)
    expect(hasThreadResults(threadResultEntries([bundle('th-1', [artifact({})])], 'th-2'))).toBe(false)
  })

  it('titles take the last path segment only', () => {
    expect(resultEntryTitle('docs/plans/auth-v1.md')).toBe('auth-v1.md')
    expect(resultEntryTitle('report.md')).toBe('report.md')
    expect(resultEntryTitle('a\\b\\win-file.ts')).toBe('win-file.ts')
  })

  it('status words match the existing chat artifact card', () => {
    expect(resultStatusLabel(candidate({ acceptanceStatus: 'accepted' }))).toBe('已接受')
    expect(resultStatusLabel(candidate({ acceptanceStatus: 'rejected' }))).toBe('已退回')
    expect(resultStatusLabel(candidate({ acceptanceStatus: 'pending' }))).toBe('等待审阅')
    expect(resultStatusLabel(null)).toBe('等待审阅')
  })
})
