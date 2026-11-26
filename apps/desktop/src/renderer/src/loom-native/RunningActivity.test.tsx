import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ActionApprovalView, AgentRunView, RuntimeFailureView, ThreadSnapshot } from '@contracts'
import type { AgentProfile, ConversationItem } from './types'
import { RunActivityHistory, RunActivityLine, RunningActivity, runActivitySummary } from './RunningActivity'
import { approvalStatusLabel, ConversationView, RunFailure, runRuntimeGuidance } from './ConversationView'

// 夹具直接照着 Core 的投影字段写，不另造中间态：失败块与状态行只读这些字段。
const failure = (over: Partial<RuntimeFailureView> = {}): RuntimeFailureView => ({
  runtimeKind: 'claude-code-cli', origin: 'runtime', phase: 'execution',
  code: 'runtime_not_configured', summary: 'Claude Code 还没有可用的模型连接。',
  detail: null, retryable: true, ...over })

const run = (over: Partial<AgentRunView> = {}): AgentRunView => ({
  id: 'r1', threadTurnId: null, conversationId: 'th', agentId: 'a', taskId: null,
  responsibilityKey: 'k', responsibilityGeneration: 0, purpose: '', completionRole: 'required',
  status: 'failed', waitReason: null, cancelRequestedAt: null, cancelReasonCode: null, cancelAcknowledgedAt: null,
  terminalResolutionSource: null, terminalReasonCode: null, failure: null,
  runtimeModel: null, executionEpoch: 0, permissionSemantics: 'core_enforced_v1', invocationKind: 'direct',
  triggerDeliveryGeneration: 0, a2aParentAgentRunId: null, a2aRootAgentRunId: null, a2aDepth: 0,
  executionEvidenceCount: 0, executionEvidenceChangeSequence: 0, hasUnsettledExternalEffects: false,
  workspace: null, startingGitObservation: null, endingGitObservation: null, version: 1,
  createdAt: '2026-11-22T00:00:00.000Z', startedAt: '2026-11-22T00:00:00.000Z',
  endedAt: '2026-11-22T00:39:17.000Z', updatedAt: '2026-11-22T00:39:17.000Z', ...over })

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  agentId: 'a', displayName: 'Hanzi', avatarRef: null, accent: null, teamRole: '开发',
  professionalResponsibilities: '', personalityTraits: [], workingPrinciples: '', growthTopic: '',
  defaultCapabilities: [], presence: 'present', runtimeConfiguration: null,
  runtimeReadiness: { status: 'runtime_not_configured', blockers: [] },
  memberOrder: 0, version: 1, createdAt: '', updatedAt: '', removedAt: null, ...over })

const snapshot = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({
  thread: {
    id: 'th', title: 'Actual thread', projectPath: 'C:/work', projectBindingKind: 'directory',
    defaultLeadAgentId: 'a', createdAt: '2026-11-22T00:00:00.000Z'
  },
  messages: [{
    id: 'm1', sequence: 1, authorType: 'user', authorId: 'local_user', authorDisplayName: null,
    body: '你好', withdrawn: false, attachments: [], agentRunId: null, createdAt: '2026-11-22T00:00:00.000Z'
  }],
  members: [{ agentId: 'a', displayName: 'Hanzi', avatarRef: null, teamRole: '开发', accent: '#000',
    membershipStatus: 'active', leaveRequestedAt: null, profilePresence: 'present', memberOrder: 0,
    isDefaultLead: true, version: 1 }],
  membershipReconciliations: [], tasksEnabled: false, approvals: [], agentRuns: [],
  schemaVersion: 9, throughGlobalSequence: 1, ...over
} as unknown as ThreadSnapshot)

const item: ConversationItem = { id: 'th', title: 'Actual thread', subtitle: '', agentId: 'a',
  threadId: 'th', missionId: null, unread: false, updatedAt: null }

// 授权夹具照着 `ActionApprovalView` 的投影字段写：状态词与结论行只读这些字段。
const approval = (over: Partial<ActionApprovalView> = {}): ActionApprovalView => ({
  id: 'ap1', actionId: 'ac1', actionKind: 'shell.command', actionSummary: '运行 npm test', canonicalInput: {},
  reason: '这条命令会写入工作目录', agentRunId: 'r1', agentId: 'a', adapterKind: 'claude-code-cli',
  nativeMethod: null, requestDigest: null, permissionSemantics: 'core_enforced_v1',
  options: [{ optionId: 'o1', kind: 'allow_once', label: '允许一次', consequence: '只运行这一条命令', nativeResponseDigest: 'd1' }],
  status: 'pending', requestedForUserId: 'local_user', resolvedByType: null, resolvedById: null,
  resolutionCode: null, version: 1, requestedAt: '2026-11-22T00:00:00.000Z', resolvedAt: null, ...over
})

function conversation(over: {
  snapshot?: Partial<ThreadSnapshot>; agents?: AgentProfile[]; error?: string | null
  draft?: string; sending?: boolean; questions?: import('./pi-questions').PiQuestion[]
  onStopRun?(run: AgentRunView): void; stoppingRunIds?: readonly string[]
} = {}) {
  return renderToStaticMarkup(createElement(ConversationView, {
    item, snapshot: snapshot(over.snapshot ?? {}), agents: over.agents ?? [profile()], bundles: [],
    loading: false, sending: over.sending ?? false, draft: over.draft ?? '', files: [],
    error: over.error ?? null, onDraft: () => {}, onFiles: () => {}, onSend: () => {}, onProfile: () => {},
    onArtifact: () => {}, onShowSidebar: () => {}, sidebarHidden: false, onShowWork: () => {},
    inspectorHidden: false, onAttachment: () => {}, onResolveApproval: () => {}, approvalBusy: false,
    onRetryRun: () => {}, onConfigureRuntime: () => {}, questions: over.questions, onAnswerQuestion: async () => {},
    onStopRun: over.onStopRun, stoppingRunIds: over.stoppingRunIds
  }))
}

describe('run activity line (Mikka activityLine)', () => {
  it('states how long the run worked and how it ended', () => {
    expect(runActivitySummary(run({ status: 'succeeded' }))).toBe('工作了 39 分 17 秒')
    expect(runActivitySummary(run({ status: 'failed' }))).toBe('工作了 39 分 17 秒 · 失败')
    expect(runActivitySummary(run({ status: 'cancelled' }))).toBe('工作了 39 分 17 秒 · 已停止')
  })
  it('reports the line on screen instead of only in the activity dialog', () => {
    const html = renderToStaticMarkup(createElement(RunActivityLine, { run: run({ status: 'failed' }) }))
    expect(html).toContain('ln-run-activity')
    expect(html).toContain('data-state="failed"')
    expect(html).toContain('role="status"')
    expect(html).toContain('工作了 39 分 17 秒 · 失败')
  })
})

describe('running row (Mikka agent-activity working row)', () => {
  it('shows a live loader row with the assistant name while a run is active', () => {
    const html = renderToStaticMarkup(createElement(RunningActivity, { label: 'Hanzi正在处理' }))
    expect(html).toContain('ln-running-status')
    expect(html).toContain('data-state="working"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('data-size="sm"')
    expect(html).toContain('Hanzi正在处理')
  })
  it('offers stop for a running row, then leaves the stopped conclusion line', () => {
    const active = conversation({
      snapshot: { agentRuns: [run({ status: 'running', endedAt: null })] },
      onStopRun: () => {}
    })
    expect(active).toContain('aria-label="停止本次运行"')
    expect(active).toContain('>停止</button>')
    const stopping = conversation({
      snapshot: { agentRuns: [run({ status: 'running', endedAt: null })] },
      onStopRun: () => {}, stoppingRunIds: ['r1']
    })
    expect(stopping).toContain('data-state="stopping"')
    expect(stopping).toContain('正在停止…')
    const stopped = conversation({ snapshot: { agentRuns: [run({ status: 'cancelled' })] } })
    expect(stopped).not.toContain('aria-label="停止本次运行"')
    expect(stopped).toContain('工作了 39 分 17 秒 · 已停止')
  })
  it('keeps the working row in the transcript and drops it once the run failed', () => {
    expect(conversation({ snapshot: { agentRuns: [run({ status: 'running', endedAt: null })] } }))
      .toContain('Hanzi正在处理')
    const failed = conversation({ snapshot: { agentRuns: [run()] } })
    expect(failed).not.toContain('Hanzi正在处理')
    expect(failed).toContain('工作了 39 分 17 秒 · 失败')
    const questions: import('./pi-questions').PiQuestion[] = [{
      threadId: 'th', agentRunId: 'r1', executionEpoch: 1, hostInstanceId: 'host', agentId: 'a',
      status: 'waiting_for_user', request: { id: 'question', method: 'select', title: '选哪一个？', options: ['A', 'B'] }
    }]
    const waiting = conversation({ snapshot: { agentRuns: [run({ status: 'running', endedAt: null })] }, questions })
    expect(waiting).toContain('等你回答')
    expect(waiting).toContain('选哪一个？')
    expect(waiting).not.toContain('Hanzi正在处理')
    const otherThread = conversation({ questions: [{ ...questions[0], threadId: 'other' }] })
    expect(otherThread).not.toContain('选哪一个？')
  })
})

describe('run failure block (Mikka thread-failure)', () => {
  it('leaves the reason, the code, retry and the runtime settings entry after a failed run', () => {
    const html = conversation({ snapshot: { agentRuns: [run({
      failure: failure(), terminalReasonCode: 'runtime_not_configured'
    })] } })
    expect(html).toContain('ln-run-failure')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Claude Code 还没有可用的模型连接。')
    expect(html).toContain('runtime_not_configured')
    expect(html).toContain('重试')
    expect(html).toContain('去配置运行端')
  })
  it('falls back to the shared run label when Core sent no structured failure', () => {
    const html = renderToStaticMarkup(createElement(RunFailure, {
      run: run({ failure: null, terminalReasonCode: 'runtime_not_configured' }),
      agent: profile({ runtimeConfiguration: null }), sending: false,
      onRetry: () => {}, onConfigure: () => {}
    }))
    expect(html).toContain('尚未配置运行端')
  })
  it('says the runtime is not configured where the user got stuck', () => {
    expect(runRuntimeGuidance(profile())).toEqual({ available: false, status: '未配置智能体' })
    expect(conversation({ snapshot: { agentRuns: [run({ failure: failure() })] } }))
      .toContain('Hanzi · 未配置智能体。先配置好运行端，再重试这次请求。')
  })
  it('keeps the settings entry without blaming a runtime that is ready', () => {
    const ready = profile({
      runtimeConfiguration: { adapterKind: 'claude-code-cli', model: { mode: 'runtime_default' },
        permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: {} } },
      runtimeReadiness: { status: 'ready', blockers: [] }
    })
    expect(runRuntimeGuidance(ready)).toEqual({ available: true, status: '可用' })
    const html = conversation({ agents: [ready], snapshot: { agentRuns: [run({ failure: failure() })] } })
    expect(html).not.toContain('未配置智能体')
    expect(html).toContain('去配置运行端')
  })
  it('treats a configured runtime that cannot launch as unavailable, not as missing', () => {
    expect(runRuntimeGuidance(profile({
      runtimeConfiguration: { adapterKind: 'claude-code-cli', model: { mode: 'runtime_default' },
        permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: {} } },
      runtimeReadiness: { status: 'needs_attention', blockers: [{ code: 'runtime_not_installed', detail: null }] }
    }))).toEqual({ available: false, status: '智能体不可用' })
  })
})

describe('send error copy (Mikka request failed / input preserved / retry)', () => {
  it('says what happened, that the input survived and where to retry', () => {
    const html = conversation({ error: '连接中断', draft: '你好' })
    expect(html).toContain('ln-send-error')
    expect(html).toContain('请求失败，请稍后重试。')
    expect(html).toContain('连接中断')
    expect(html).toContain('你的输入已保留。')
    expect(html).toContain('重试此回复')
  })
  it('does not repeat the same sentence twice when the transport already said it', () => {
    const html = conversation({ error: '请求失败，请稍后重试。' })
    expect(html.match(/请求失败，请稍后重试。/gu)).toHaveLength(1)
    expect(html).toContain('你的输入已保留。')
  })
  it('does not offer a retry that would send nothing', () => {
    expect(conversation({ error: '连接中断' })).toMatch(/<button[^>]*disabled=""[^>]*>重试此回复<\/button>/u)
    expect(conversation({ error: '连接中断', draft: '你好' })).toMatch(/<button(?![^>]*disabled)[^>]*>重试此回复<\/button>/u)
  })
})

describe('approval request (Mikka approval-card)', () => {
  it('names the state instead of leaving the request without one', () => {
    expect(approvalStatusLabel('pending')).toBe('等待你的选择')
    expect(approvalStatusLabel('approved')).toBe('已同意')
    const html = conversation({ snapshot: { approvals: [approval()] } })
    expect(html).toContain('ln-approval-request')
    expect(html).toContain('data-state="pending"')
    expect(html).toContain('等待你的选择')
    expect(html).toContain('允许一次')
  })
  it('keeps a resolved request as a conclusion line instead of dropping the whole block', () => {
    const html = conversation({ snapshot: { approvals: [approval({
      status: 'approved', resolvedByType: 'user', resolvedById: 'local_user', resolvedAt: '2026-11-22T00:01:00.000Z'
    })] } })
    expect(html).toContain('ln-approval-result')
    expect(html).toContain('运行 npm test')
    expect(html).toContain('已同意')
    expect(html).not.toContain('ln-approval-request')
  })
})

describe('install guide in the failure block (Mikka device copy)', () => {
  const configured = profile({
    runtimeConfiguration: { adapterKind: 'claude-code-cli', model: { mode: 'runtime_default' },
      permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: {} } }
  })
  it('offers the install guide where the run stopped, not only the word unavailable', () => {
    const html = renderToStaticMarkup(createElement(RunFailure, {
      run: run({ failure: failure({ code: 'adapter_installation_missing' }), terminalReasonCode: 'adapter_installation_missing' }),
      agent: configured, sending: false, onRetry: () => {}, onConfigure: () => {},
      onOpenRuntimeSetup: () => {}, platform: 'macos-arm64'
    }))
    expect(html).toContain('ln-run-failure-guide')
    expect(html).toContain('还没装 Agent，怎么装')
    expect(html).toContain('runtime-install-guide')
    expect(html).toContain('curl -fsSL https://claude.ai/install.sh | bash')
  })
  it('does not offer a guide without an adapter to name', () => {
    const html = renderToStaticMarkup(createElement(RunFailure, {
      run: run({ failure: failure() }), agent: profile({ runtimeConfiguration: null }), sending: false,
      onRetry: () => {}, onConfigure: () => {}, onOpenRuntimeSetup: () => {}
    }))
    expect(html).not.toContain('ln-run-failure-guide')
    expect(html).toContain('未配置智能体')
  })
})

describe('activity dialog rows (Mikka activityLine)', () => {
  it('prints how long each run worked, why it failed and how to retry', () => {
    const html = renderToStaticMarkup(createElement(RunActivityHistory, {
      runs: [run({ failure: failure() }), run({ id: 'r2', status: 'running', endedAt: null })],
      agents: [{ agentId: 'a', displayName: 'Hanzi' }], sending: false, onRetry: () => {}
    }))
    expect(html).toContain('ln-activity-row')
    expect(html).toContain('工作了 39 分 17 秒 · 失败')
    expect(html).toContain('Claude Code 还没有可用的模型连接。')
    expect(html).toContain('自动重试中')
    expect(html).toContain('执行中')
  })
  it('says there is no activity instead of showing an empty list', () => {
    const html = renderToStaticMarkup(createElement(RunActivityHistory, { runs: [], agents: [], onRetry: () => {} }))
    expect(html).toContain('data-slot="empty"')
    expect(html).toContain('当前对话暂无执行活动')
  })
})
