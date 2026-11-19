import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile, LoomControlPolicy, LoomDispatch, LoomStageReview, LoomTask } from '@contracts'
import { ControlPanel, ControlSummary, latestStageReviewOf } from './ControlPanel'

const agent = (agentId: string, displayName: string): AgentProfile => ({
  agentId,
  displayName,
  presence: 'present',
  removedAt: null,
  teamRole: 'engineer'
} as unknown as AgentProfile)

const agents = [agent('agent-1', '甲'), agent('agent-2', '乙')]

const task = (taskId: string, title: string, assigneeAgentId: string | null): LoomTask => ({
  taskId,
  planId: 'plan-1',
  title,
  description: '',
  assigneeAgentId,
  status: 'ready',
  acceptanceCriteria: { version: 'v1', criteria: [] },
  blockedReason: null,
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  revision: 1
} as unknown as LoomTask)

const tasks = [task('t1', '写报告', 'agent-1'), task('t2', '校对数据', 'agent-2')]

const policy = (over: Partial<LoomControlPolicy> = {}): LoomControlPolicy => ({
  missionId: 'm1',
  planId: 'plan-1',
  revision: 3,
  authorizationRevision: 2,
  enabled: true,
  paused: false,
  taskIds: ['t1', 't2'],
  reviewers: [{ taskId: 't1', reviewerAgentId: 'agent-2' }, { taskId: 't2', reviewerAgentId: 'agent-1' }],
  maxDispatches: 8,
  maxReworksPerTask: 2,
  expiresAt: null,
  approvedBy: 'local_user',
  approvedAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  ...over
})

const dispatch = (over: Partial<LoomDispatch> = {}): LoomDispatch => ({
  dispatchId: 'd1',
  taskId: 't1',
  kind: 'execute',
  candidateId: null,
  policyRevision: 2,
  recipientAgentId: 'agent-1',
  deliveryId: 'delivery-1',
  status: 'settled',
  reason: null,
  createdAt: '2026-11-16T00:00:00Z',
  ...over
})

const summary = (over: Partial<Parameters<typeof ControlSummary>[0]> = {}): string =>
  renderToStaticMarkup(createElement(ControlSummary, {
    state: 'approved',
    policy: policy(),
    dispatches: [],
    stageReviews: [],
    tasks,
    agents,
    ...over
  }))

describe('automatic relay control surface', () => {
  it('says the read failed instead of claiming the range is unapproved', () => {
    const html = summary({ state: 'unreadable', policy: null })
    expect(html).toContain('自动协作状态读取失败，请重试。')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('尚未批准自动接力')
  })

  it('shows a real reading state without any conclusion', () => {
    const html = summary({ state: 'reading', policy: null })
    expect(html).toContain('正在读取接力范围…')
    expect(html).not.toContain('尚未批准自动接力')
    expect(html).not.toContain('批准接力范围')
  })

  it('shows the approved scope, budgets and per-task independent reviewer from real facts', () => {
    const html = summary({ dispatches: [dispatch()] })
    expect(html).toContain('纳入任务')
    expect(html).toContain('独立审查者')
    expect(html).toContain('1 / 8')
    expect(html).toContain('每任务返工上限')
    expect(html).toContain('乙')
    expect(html).toContain('写报告')
    expect(html).toContain('最近派发记录')
    // 这里是自动化范围，不是用户验收：摘要里既没有按钮也没有接受/验收动作。
    expect(html).not.toContain('<button')
    expect(html).not.toMatch(/接受成果|代你接受|自动接受|验收成果/u)
  })

  it('keeps an unapproved mission honest: nothing is dispatched until the user approves', () => {
    const html = summary({ state: 'unapproved', policy: null })
    expect(html).toContain('设置任务和审核人后')
    expect(html).not.toContain('<button')
  })

  it('renders no write affordance while the snapshot is still being read', () => {
    const port = { request: vi.fn() }
    const html = renderToStaticMarkup(createElement(ControlPanel, {
      missionId: 'm1',
      threadId: 'thread-1',
      thread: null,
      tasks,
      agents,
      attempt: null,
      onAttempt: () => {},
      port: port as unknown as Parameters<typeof ControlPanel>[0]['port']
    }))
    expect(html).toContain('自动接力')
    expect(html).toContain('正在读取接力范围…')
    expect(html).not.toContain('批准此范围')
    expect(html).not.toContain('暂停接力')
    expect(html).not.toContain('继续接力')
    expect(html).not.toMatch(/接受成果|代你接受/u)
    // 静态渲染不执行 effect：一个请求都不该发出去。
    expect(port.request).not.toHaveBeenCalled()
  })

  it('picks the latest assistant stage verdict per task without inventing one', () => {
    const review: LoomStageReview = {
      stageReviewId: 's1',
      taskId: 't1',
      candidateId: 'c1',
      reviewerAgentId: 'agent-2',
      reviewerAgentRunId: 'run-1',
      policyRevision: 2,
      manifestHash: 'a'.repeat(64),
      verdict: 'request_changes',
      reason: '还缺数据',
      criteriaResults: [],
      reviewedAt: '2026-11-16T00:00:00Z'
    }
    expect(latestStageReviewOf([review], 't1')).toBe(review)
    expect(latestStageReviewOf([review], 't2')).toBeNull()
    const html = summary({ stageReviews: [review] })
    expect(html).toContain('要求返工')
  })
})
