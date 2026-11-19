import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile, LoomCandidate, LoomTask } from '@contracts'
import { LoomAssetGraph, LoomControl, loomControlWritable, LoomStageReviewFact } from './LoomControl'
import type {
  LoomAssetRelation,
  LoomControlPolicy,
  LoomControlSnapshot,
  LoomStageReview
} from './loom-control-model'

// 控制区只读一个客户端入口：测试不碰真实桥，也不假装请求成功。
vi.mock('./camp-client', () => ({
  useThreadClient: () => ({
    request: async () => {
      throw new Error('no bridge in test')
    }
  })
}))

const at = '2026-09-27T08:00:00.000Z'
const criteria = { version: 'v1', criteria: [{ criterionId: 'c1', text: '可恢复' }] }

function agent(agentId: string, displayName: string): AgentProfile {
  return { agentId, displayName } as unknown as AgentProfile
}

function task(taskId: string, title: string, assigneeAgentId: string | null = null): LoomTask {
  return { taskId, title, assigneeAgentId } as unknown as LoomTask
}

function candidate(
  candidateId: string,
  taskId: string,
  previousCandidateId: string | null,
  acceptanceStatus: LoomCandidate['acceptanceStatus']
): LoomCandidate {
  return {
    candidateId,
    taskId,
    agentRunId: `run-${candidateId}`,
    contentHash: `sha256:${candidateId}`,
    evidenceIds: [`evidence-${candidateId}`],
    acceptanceCriteria: criteria,
    previousCandidateId,
    verificationStatus: 'unverified',
    acceptanceStatus,
    createdAt: at
  }
}

function policy(overrides: Partial<LoomControlPolicy> = {}): LoomControlPolicy {
  return {
    missionId: 'mission-1',
    planId: 'plan-1',
    revision: 2,
    authorizationRevision: 1,
    enabled: true,
    paused: false,
    taskIds: ['task-1', 'task-3'],
    reviewers: [{ taskId: 'task-1', reviewerAgentId: 'agent-lead' }],
    maxDispatches: 3,
    maxReworksPerTask: 1,
    expiresAt: null,
    approvedBy: 'agent-owner',
    approvedAt: at,
    updatedAt: at,
    ...overrides
  }
}

function snapshot(overrides: Partial<LoomControlSnapshot> = {}): LoomControlSnapshot {
  return { missionId: 'mission-1', policy: null, stageReviews: [], dispatches: [], evaluatedAt: at, ...overrides }
}

function renderControl(value: LoomControlSnapshot | null, readError = ''): string {
  return renderToStaticMarkup(<LoomControl
    missionId="mission-1"
    tasks={[task('task-1', '写报告', 'agent-dev')]}
    agents={[agent('agent-dev', '开发'), agent('agent-lead', '审查者'), agent('agent-owner', '主管')]}
    snapshot={value}
    readError={readError}
    onReload={() => {}}/>)
}

describe('loom control panel', () => {
  // 未批准只放一个明确入口：读到状态不等于替用户展开表单。
  it('keeps the form closed until settings is clicked on an unapproved mission', () => {
    const html = renderControl(snapshot())
    expect(html).toContain('尚未批准接力范围')
    expect(html).toContain('loom-control-edit')
    expect(html).toContain('设置接力')
    expect(html).not.toContain('loom-control-form')
    expect(html).not.toContain('loom-control-task-input')
    expect(html).not.toContain('loom-control-approve')
  })

  // 读不到策略时不得出现「未批准」这种业务结论，也不给设置入口。
  it('never renders an unapproved verdict when the policy read failed', () => {
    const html = renderControl(null, 'core 读取超时')
    expect(html).toContain('core 读取超时')
    expect(html).toContain('接力状态暂时读不到，请重试。')
    expect(html).not.toContain('尚未批准接力范围')
    expect(html).not.toContain('设置接力')
  })

  it('keeps only state and budget in the header and folds scope plus dispatches into one details', () => {
    const html = renderControl(snapshot({ policy: policy() }))
    const [header] = html.split('</header>')
    expect(header).toContain('自动接力')
    expect(html).not.toContain('LOOM · 接力')
    expect(header).toContain('loom-control-state')
    expect(header).toContain('已使用 0 / 上限 3')
    // 常驻说明与常显事实都收掉了。
    expect(html).not.toContain('不会终止正在运行的任务')
    expect(header).not.toContain('loom-control-facts')
    expect(html).toContain('范围与记录')
    expect(html.match(/<details/gu)?.length).toBe(1)
    const [, details] = html.split('<details')
    expect(details).toContain('纳入任务')
    expect(details).toContain('独立审查者')
    expect(details).toContain('每任务返工上限')
    expect(details).toContain('修订')
    expect(details).toContain('到期')
    expect(details).toContain('批准人')
  })

  it('gates pause with a short title and offers no resume after expiry', () => {
    const approved = renderControl(snapshot({ policy: policy() }))
    expect(approved).toContain('仅暂停后续任务')
    expect(approved).toContain('暂停接力')
    expect(approved).toContain('loom-control-pause')

    const expired = renderControl(snapshot({
      policy: policy({ expiresAt: '2026-09-26T00:00:00.000Z', paused: true })
    }))
    expect(expired).toContain('已到期，请重新确认接力范围。')
    expect(expired).not.toContain('继续接力')
    expect(expired).not.toContain('loom-control-pause')
    expect(expired).toContain('重新批准')
  })
})

function relation(overrides: Partial<LoomAssetRelation> = {}): LoomAssetRelation {  return {
    key: 'c2:evidence-c2',
    evidenceId: 'evidence-c2',
    relativePath: 'artifacts/reports/report.md',
    producerAgentRunId: 'run-c2',
    producerCreatorId: null,
    registration: 'registered',
    candidateId: 'c2',
    taskId: 'task-1',
    stageReview: null,
    consumers: [],
    ...overrides
  }
}

function stageReview(overrides: Partial<LoomStageReview> = {}): LoomStageReview {
  return {
    stageReviewId: 's1',
    taskId: 'task-1',
    candidateId: 'c2',
    reviewerAgentId: 'agent-lead',
    reviewerAgentRunId: 'run-r1',
    policyRevision: 1,
    manifestHash: 'm1',
    verdict: 'pass',
    reason: '确实满足全部标准',
    criteriaResults: [{ criterionId: 'c1', satisfied: true, evidenceIds: [], note: null }],
    reviewedAt: at,
    ...overrides
  }
}

function renderGraph(
  relations: LoomAssetRelation[],
  candidates: LoomCandidate[] = [],
  currentPolicy: LoomControlPolicy | null = null
): string {
  return renderToStaticMarkup(<LoomAssetGraph
    relations={relations}
    tasks={[task('task-2', '部署')]}
    agents={[agent('agent-dev', '开发'), agent('agent-lead', '审查者')]}
    candidates={candidates}
    policy={currentPolicy}
    onFocusCandidate={() => {}}/>)
}

describe('loom asset graph steps', () => {
  it('reads version and acceptance from the candidate projection', () => {
    const html = renderGraph([relation()], [
      candidate('c1', 'task-1', null, 'accepted'),
      candidate('c2', 'task-1', 'c1', 'pending')
    ])
    expect(html).toContain('report.md v2')
    expect(html).toContain('等待你确认')
    expect(html).not.toContain('已接受')
    expect(html).toContain('data-acceptance="pending"')
  })

  // 没有候选投影就不许把缺失当成「待确认」。
  it('says acceptance is unknown rather than pending when candidates are missing', () => {
    const html = renderGraph([relation()])
    expect(html).toContain('接受状态未知')
    expect(html).not.toContain('等待你确认')
    expect(html).toContain('report.md')
    expect(html).not.toContain('report.md v')
    expect(html).toContain('data-acceptance="unknown"')
  })

  it('names the producer from the registry and keeps raw ids in details only', () => {
    const html = renderGraph([relation({ producerCreatorId: 'agent-dev', producerAgentRunId: 'run-raw-9' })])
    const [main] = html.split('<details')
    expect(main).toContain('开发')
    expect(main).not.toContain('run-raw-9')
    expect(main).not.toContain('artifacts/reports')
    expect(html).toContain('loom-asset-details')
    expect(html).toContain('run-raw-9')
  })

  it('says 执行记录 when only a run id is known instead of guessing the assignee', () => {
    const html = renderGraph([relation({ producerCreatorId: null, producerAgentRunId: 'run-c2' })])
    const [main] = html.split('<details')
    expect(main).toContain('执行记录')
    expect(main).not.toContain('开发')
  })

  it('adds the downstream step only for real consumers', () => {
    const linked = renderGraph([relation({ consumers: [{ dependencyId: 'dep-1', downstreamTaskId: 'task-2' }] })])
    expect(linked).toContain('data-has-consumer="true"')
    expect(linked).toContain('data-step="consumer"')
    expect(linked).toContain('部署')

    const unlinked = renderGraph([relation()])
    expect(unlinked).toContain('data-has-consumer="false"')
    expect(unlinked).not.toContain('data-step="consumer"')
  })

  it('titles the graph as 成果流转 and offers 查看成果', () => {
    const html = renderGraph([relation()])
    expect(html).toContain('成果流转')
    expect(html).toContain('查看成果')
    expect(html).not.toContain('查看候选')
    expect(html).not.toContain('依赖未冻结时不标使用者')
  })

  it('shows the reviewer name and current verdict in the review step', () => {
    const html = renderGraph([relation({ stageReview: stageReview({ verdict: 'request_changes' }) })], [], policy())
    expect(html).toContain('审查者 · ')
    expect(html).toContain('要求返工')
    expect(html).toContain('data-freshness="current"')
    expect(html).toContain('data-verdict="request_changes"')
  })

  // 与 StageReviewFact 同一套 freshness：旧授权的 pass 不许被当成当前通过。
  it('never shows a stale pass as a current verdict', () => {
    const stale = renderGraph([relation({ stageReview: stageReview({ policyRevision: 0 }) })], [], policy())
    expect(stale).toContain('旧授权已失效')
    expect(stale).toContain('data-freshness="stale"')
    expect(stale).toContain('data-verdict="not-current"')

    const unknown = renderGraph([relation({ stageReview: stageReview() })])
    expect(unknown).toContain('授权未知')
    expect(unknown).toContain('data-freshness="unknown"')
    expect(unknown).not.toContain('data-verdict="pass"')
  })
})

function renderFact(stageReview2: LoomStageReview | null, failed: boolean, currentPolicy: LoomControlPolicy | null): string {
  return renderToStaticMarkup(<LoomStageReviewFact
    stageReview={stageReview2}
    failed={failed}
    agents={[agent('agent-lead', '审查者')]}
    policy={currentPolicy}/>)
}

describe('loom stage review fact', () => {
  it('puts the reviewer and badge on the main line and folds reason and criteria into details', () => {
    const html = renderFact(stageReview(), false, policy())
    const [main, rest] = html.split('<details')
    expect(main).toContain('审查者')
    expect(main).toContain('loom-stage-badge')
    expect(main).toContain('通过')
    expect(main).not.toContain('确实满足全部标准')
    expect(rest).toContain('确实满足全部标准')
    expect(rest).toContain('c1')
  })

  it('keeps stale and failed reviews honest', () => {
    const stale = renderFact(stageReview({ policyRevision: 0 }), false, policy({ authorizationRevision: 1 }))
    expect(stale).toContain('旧授权已失效')
    expect(stale).toContain('data-freshness="stale"')

    const failed = renderFact(null, true, null)
    expect(failed).toContain('审查读取失败')
    expect(failed).toContain('data-verdict="unknown"')
    expect(failed).not.toContain('<details')
  })
})
