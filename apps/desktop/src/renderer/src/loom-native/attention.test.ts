import { describe, expect, it } from 'vitest'
import type { ActionApprovalView } from '@contracts'
import {
  ATTENTION_BUDGET,
  attentionAgeMinutes,
  attentionFactsFromApprovals,
  attentionScore,
  attentionSeverity,
  rankAttention,
  summarizeAttention,
  type AttentionFact
} from './attention'

const NOW = new Date('2026-11-26T12:00:00Z')

const fact = (over: Partial<AttentionFact>): AttentionFact => ({
  id: 'f1', kind: 'review', title: '实际工作', threadId: 'th-1', missionId: 'm-1', taskId: 't-1',
  createdAt: '2026-11-26T10:00:00Z', ...over
})

// 与 `action.approvals` 投影同形状的夹具，字段照抄合同，不为测试造形状。
const approval = (over: Partial<ActionApprovalView>): ActionApprovalView => ({
  id: 'ap-1', actionId: 'act-1', actionKind: 'tool', actionSummary: '要删除一个目录',
  canonicalInput: null, reason: null, agentRunId: 'run-1', agentId: 'agent-1', adapterKind: 'unknown',
  nativeMethod: null, requestDigest: null, permissionSemantics: 'core_enforced_v1', options: [],
  status: 'pending', requestedForUserId: 'local_user', resolvedByType: null, resolvedById: null,
  resolutionCode: null, version: 1, requestedAt: '2026-11-26T10:00:00Z', resolvedAt: null, ...over
})

describe('attention severity and score', () => {
  it('maps kinds to severity: approvals and questions are high, reviews normal, completions low', () => {
    expect(attentionSeverity('approval')).toBe('high')
    expect(attentionSeverity('question')).toBe('high')
    expect(attentionSeverity('review')).toBe('normal')
    expect(attentionSeverity('completion')).toBe('low')
  })
  it('ages waiting time into the score, so the longer-waiting item ranks first within a severity', () => {
    const older = attentionScore(fact({ createdAt: '2026-11-26T06:00:00Z' }), NOW)
    const newer = attentionScore(fact({ createdAt: '2026-11-26T10:00:00Z' }), NOW)
    expect(older).toBeGreaterThan(newer)
  })
  it('caps the age bonus, so an aged notice never outranks a fresh approval', () => {
    const agedNotice = attentionScore(fact({ kind: 'completion', createdAt: '2025-01-01T00:00:00Z' }), NOW)
    const freshApproval = attentionScore(fact({ kind: 'approval', createdAt: '2026-11-26T11:59:00Z' }), NOW)
    expect(agedNotice).toBeLessThan(freshApproval)
  })
  it('treats a missing or unparseable time as just arrived instead of inventing an age', () => {
    expect(attentionAgeMinutes(null, NOW)).toBe(0)
    expect(attentionAgeMinutes('not-a-date', NOW)).toBe(0)
    expect(attentionScore(fact({ createdAt: null }), NOW)).toBe(attentionScore(fact({ createdAt: 'not-a-date' }), NOW))
  })
})

describe('attention ranking', () => {
  it('puts a high-score approval or question ahead of low-score completion notices', () => {
    const ranked = rankAttention([
      fact({ id: 'done', kind: 'completion' }),
      fact({ id: 'verdict', kind: 'review' }),
      fact({ id: 'ask', kind: 'question', createdAt: '2026-11-26T11:00:00Z' }),
      fact({ id: 'allow', kind: 'approval', createdAt: '2026-11-26T10:30:00Z' })
    ], NOW)
    expect(ranked.map(item => item.kind)).toEqual(['approval', 'question', 'review', 'completion'])
  })
  it('keeps exact ties in input order instead of inventing an order', () => {
    const ranked = rankAttention([fact({ id: 'x' }), fact({ id: 'y' })], NOW)
    expect(ranked.map(item => item.id)).toEqual(['x', 'y'])
  })
})

describe('attention budget', () => {
  it('surfaces only the first N by score and aggregates the rest', () => {
    const facts = Array.from({ length: 8 }, (_, index) => fact({ id: `t-${index}`, taskId: `t-${index}` }))
    const summary = summarizeAttention(facts, NOW)
    expect(summary.surfaced).toHaveLength(ATTENTION_BUDGET)
    expect(summary.surfaced.map(item => item.id)).toEqual(['t-0', 't-1', 't-2', 't-3', 't-4'])
    expect(summary.remainder).toBe(3)
    expect(summary.count).toBe(ATTENTION_BUDGET)
  })
  it('never surfaces a low notice on its own and keeps it out of the count', () => {
    const summary = summarizeAttention([
      fact({ id: 'allow', kind: 'approval' }),
      fact({ id: 'c1', kind: 'completion' }),
      fact({ id: 'c2', kind: 'completion', createdAt: '2025-01-01T00:00:00Z' })
    ], NOW)
    expect(summary.surfaced.map(item => item.id)).toEqual(['allow'])
    expect(summary.count).toBe(1)
    expect(summary.remainder).toBe(2)
  })
  it('attentionCount only counts budgeted, genuinely actionable items', () => {
    const approvals = Array.from({ length: 7 }, (_, index) => fact({ id: `a-${index}`, kind: 'approval', taskId: `t-${index}` }))
    const notices = Array.from({ length: 4 }, (_, index) => fact({ id: `n-${index}`, kind: 'completion' }))
    const capped = summarizeAttention([...notices, ...approvals], NOW)
    expect(capped.count).toBe(ATTENTION_BUDGET)
    expect(capped.remainder).toBe(6)
    expect(capped.surfaced.every(item => item.severity === 'high')).toBe(true)
    const small = summarizeAttention([approvals[0], approvals[1], ...notices], NOW)
    expect(small.count).toBe(2)
    expect(small.remainder).toBe(4)
  })
  it('returns an empty summary when nothing waits', () => {
    expect(summarizeAttention([], NOW)).toEqual({ surfaced: [], remainder: 0, count: 0 })
  })
})

describe('approval facts from the thread snapshot', () => {
  it('reads only pending approvals as high-score facts, never resolved ones', () => {
    const facts = attentionFactsFromApprovals([
      approval({ id: 'ap-1' }),
      approval({ id: 'ap-2', status: 'approved' }),
      approval({ id: 'ap-3', status: 'denied' }),
      approval({ id: 'ap-4', status: 'expired' })
    ], 'th-1', 'm-1')
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      id: 'approval:ap-1', kind: 'approval', title: '要删除一个目录',
      threadId: 'th-1', missionId: 'm-1', taskId: null, createdAt: '2026-11-26T10:00:00Z'
    })
  })
  it('a fresh approval interruption outranks an aged waiting review', () => {
    const summary = summarizeAttention([
      fact({ id: 'aged-review', createdAt: '2025-01-01T00:00:00Z' }),
      fact({ id: 'allow', kind: 'approval', createdAt: '2026-11-26T11:59:00Z' })
    ], NOW)
    expect(summary.surfaced.map(item => item.id)).toEqual(['allow', 'aged-review'])
    expect(summary.count).toBe(2)
  })
})
