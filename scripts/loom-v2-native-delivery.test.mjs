// LOOM V2 · 原生派发 / Run 身份观察门面的测试。
//
// 两类：
// A. 纯函数测试（不启动 Core）：身份门、派发解析、policy 校验、未知结果纪律。
// B. 真实隔离 Core 集成（使用仓库既有 target/debug/rovai-core，不编译、不配置 Runtime）：
//    证明"计划 → 已批准 policy → Core 自己派发 → 派发行真的带 Delivery"，
//    并如实报告 Run 是否被物化；没有 Runtime 时必须是 BLOCKED/queued，不是完成。
//
// Run (from loom/):
//   node --test --test-force-exit --test-timeout=600000 scripts/loom-v2-native-delivery.test.mjs
//
// 只跑纯函数部分（不碰 Core）：
//   node --test --test-name-pattern='^(?!.*isolated Core)' scripts/loom-v2-native-delivery.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NATIVE_DELIVERY_EVIDENCE_ENVELOPE,
  NativeDeliveryError,
  assertRunIdentity,
  buildDispatchPolicy,
  classifyDeliveryWait,
  defaultIsUnknownTransportError,
  ownershipFromThreadSnapshot,
  readNativeRunFacts,
  resolveDispatchRun,
  runNativeDeliveryEvidence,
  stableCommandId,
  startNativeDispatch,
  writeOnce
} from './loom-v2-native-delivery.mjs'

const MISSION = 'mission_native_delivery'
// 群聊 Thread = camp.id；AgentConversation 是另一个 id 空间（r2 实测：
// Run.conversationId = ba79fb20… vs Mission.threadId = rvcamp_01…）。
const THREAD = 'rvcamp_01thread'
const WORKER_CONVERSATION = 'conv_ba79fb20a1'
const WORKER = 'agent_worker_a'
const OTHER_WORKER = 'agent_worker_b'
const TASK = 'task_native_delivery'

/** Core 自己算的归属三元组（`agentRuns.diagnostic.get`）。 */
const ownershipFor = (overrides = {}) => ({
  threadId: THREAD,
  conversationId: WORKER_CONVERSATION,
  agentId: WORKER,
  source: 'agentRuns.diagnostic.get',
  ...overrides
})

const rejectedCode = (code) => (error) => {
  assert.ok(error instanceof NativeDeliveryError, `expected a NativeDeliveryError, got ${error}`)
  assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`)
  return true
}

// ---------------------------------------------------------------------------
// A. 纯函数
// ---------------------------------------------------------------------------

test('stableCommandId is deterministic per intent and never collides across kinds', () => {
  const first = stableCommandId('control-configure', [MISSION, 'task_a'])
  const again = stableCommandId('control-configure', [MISSION, 'task_a'])
  const otherTask = stableCommandId('control-configure', [MISSION, 'task_b'])
  const otherKind = stableCommandId('mission-create', [MISSION, 'task_a'])

  assert.equal(first, again, 'the same intent must always produce the same commandId')
  assert.notEqual(first, otherTask, 'a different Task is a different intent')
  assert.notEqual(first, otherKind, 'a different command kind is a different intent')
  assert.match(first, /^loom-v2-control-configure-[0-9a-f]{32}$/)
  assert.throws(() => stableCommandId('', ['x']), rejectedCode('invalid_input'))
  assert.throws(() => stableCommandId('kind', []), rejectedCode('invalid_input'))
  assert.throws(() => stableCommandId('kind', [{ nested: true }]), rejectedCode('invalid_input'))
})

test('buildDispatchPolicy accepts an approved explicit-assignee plan and derives a stable commandId', () => {
  const tasks = [{ taskId: TASK, status: 'draft', assigneeAgentId: WORKER }]
  const policy = buildDispatchPolicy({
    missionId: MISSION,
    taskIds: [TASK],
    approvedWorkerAgentIds: [WORKER, OTHER_WORKER],
    tasks,
    reviewers: [{ taskId: TASK, reviewerAgentId: OTHER_WORKER }],
    maxDispatches: 2,
    maxReworksPerTask: 0,
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  })

  assert.equal(policy.enabled, true, 'the facade only ever asks for an enabled policy')
  assert.deepEqual(policy.taskIds, [TASK])
  assert.deepEqual(policy.reviewers, [{ taskId: TASK, reviewerAgentId: OTHER_WORKER }])
  assert.equal(policy.expectedRevision, 0, 'a first approval must expect revision 0')
  assert.ok(Date.parse(policy.expiresAt) > Date.now(), 'an enabled policy needs a future expiry')
  assert.equal(
    policy.commandId,
    stableCommandId('control-configure', [MISSION, TASK, [OTHER_WORKER, WORKER].sort().join(',')]),
    'the default commandId must be derived from the approved scope, not random'
  )
})

test('buildDispatchPolicy refuses plans Core itself would never dispatch', () => {
  const base = {
    missionId: MISSION,
    taskIds: [TASK],
    approvedWorkerAgentIds: [WORKER],
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  }

  assert.throws(
    () => buildDispatchPolicy({ ...base, tasks: [] }),
    rejectedCode('task_not_found')
  )
  assert.throws(
    () => buildDispatchPolicy({ ...base, tasks: [{ taskId: TASK, status: 'in_review', assigneeAgentId: WORKER }] }),
    rejectedCode('task_not_dispatchable'),
    'only draft/ready Tasks can be dispatched'
  )
  assert.throws(
    () => buildDispatchPolicy({ ...base, tasks: [{ taskId: TASK, status: 'ready', assigneeAgentId: null }] }),
    rejectedCode('assignee_not_approved'),
    'Core never falls back to the Lead for an unassigned Task'
  )
  assert.throws(
    () => buildDispatchPolicy({ ...base, tasks: [{ taskId: TASK, status: 'ready', assigneeAgentId: OTHER_WORKER }] }),
    rejectedCode('assignee_not_approved'),
    'work may never be dispatched to an agent the caller did not approve'
  )
  assert.throws(
    () => buildDispatchPolicy({
      ...base,
      tasks: [{ taskId: TASK, status: 'ready', assigneeAgentId: WORKER }],
      reviewers: [{ taskId: TASK, reviewerAgentId: WORKER }]
    }),
    rejectedCode('reviewer_invalid'),
    'the assignee may not review its own Task'
  )
  assert.throws(
    () => buildDispatchPolicy({
      ...base,
      tasks: [{ taskId: TASK, status: 'ready', assigneeAgentId: WORKER }],
      reviewers: [{ taskId: TASK, reviewerAgentId: 'agent_not_approved' }]
    }),
    rejectedCode('reviewer_invalid')
  )
  assert.throws(
    () => buildDispatchPolicy({
      ...base,
      tasks: [{ taskId: TASK, status: 'ready', assigneeAgentId: WORKER }],
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }),
    rejectedCode('invalid_input'),
    'an enabled policy with a past expiry is refused before Core sees it'
  )
})

test('assertRunIdentity accepts exactly the Run the delivery materialised for an approved worker', () => {
  const delivery = { id: 'delivery_1', recipientAgentId: WORKER, targetAgentRunId: 'run_1' }
  const run = {
    id: 'run_1',
    agentId: WORKER,
    // 关键：Run 跑在 AgentConversation 里，不是群聊 Thread 里。
    conversationId: WORKER_CONVERSATION,
    status: 'running',
    cancelRequestedAt: null,
    terminalReasonCode: null,
    hasUnsettledExternalEffects: false
  }
  const identity = assertRunIdentity({
    run,
    delivery,
    threadId: THREAD,
    ownership: ownershipFor(),
    approvedWorkerAgentIds: [WORKER]
  })
  assert.deepEqual(identity, {
    runId: 'run_1',
    agentId: WORKER,
    status: 'running',
    terminal: false,
    fenceUsable: true,
    cancelRequestedAt: null,
    terminalReasonCode: null,
    hasUnsettledExternalEffects: false
  })
})

test('assertRunIdentity rejects a fabricated Run id and a Run with no Core-declared ownership', () => {
  const delivery = { id: 'delivery_1', recipientAgentId: WORKER, targetAgentRunId: 'run_1' }
  const fabricated = {
    id: 'run_fabricated',
    agentId: WORKER,
    conversationId: WORKER_CONVERSATION,
    status: 'running',
    cancelRequestedAt: null
  }
  assert.throws(
    () => assertRunIdentity({
      run: fabricated,
      delivery,
      threadId: THREAD,
      ownership: ownershipFor(),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_agent_mismatch'),
    'a client-invented run id can never stand in for the Run the delivery materialised'
  )
  assert.throws(
    () => assertRunIdentity({
      run: null,
      delivery,
      threadId: THREAD,
      ownership: ownershipFor(),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_absent')
  )
  // 没有 Core 声明的归属就不接受：不按前缀猜、不拿 conversationId 当 thread id。
  assert.throws(
    () => assertRunIdentity({
      run: { ...fabricated, id: 'run_1' },
      delivery,
      threadId: THREAD,
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_ownership_missing')
  )
  assert.throws(
    () => assertRunIdentity({
      run: { ...fabricated, id: 'run_1' },
      delivery,
      threadId: THREAD,
      ownership: ownershipFor({ source: '' }),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_ownership_missing'),
    'ownership without provenance is not trusted'
  )
})

test('assertRunIdentity rejects another thread, another conversation, another agent, cancelled and terminal Runs', () => {
  const delivery = { id: 'delivery_1', recipientAgentId: WORKER, targetAgentRunId: 'run_1' }
  const runFor = (overrides) => ({
    id: 'run_1',
    agentId: WORKER,
    conversationId: WORKER_CONVERSATION,
    status: 'running',
    cancelRequestedAt: null,
    ...overrides
  })

  // (1) Run 属于**另一个群聊 Thread** —— 即使它的 conversation 看起来正常，也必须拒。
  assert.throws(
    () => assertRunIdentity({
      run: runFor(),
      delivery,
      threadId: THREAD,
      ownership: ownershipFor({ threadId: 'rvcamp_01other' }),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_thread_mismatch'),
    'a Run owned by another thread is never this Mission\'s Run'
  )
  // (2) Run 的 conversation 与 Core 声明的归属不一致（未知/另一个 AgentConversation）。
  assert.throws(
    () => assertRunIdentity({
      run: runFor(),
      delivery,
      threadId: THREAD,
      ownership: ownershipFor({ conversationId: 'conv_someone_else' }),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_conversation_mismatch')
  )
  // (3) 归属里的 agent 与 Run 的 agent 不一致。
  assert.throws(
    () => assertRunIdentity({
      run: runFor(),
      delivery,
      threadId: THREAD,
      ownership: ownershipFor({ agentId: OTHER_WORKER }),
      approvedWorkerAgentIds: [WORKER, OTHER_WORKER]
    }),
    rejectedCode('run_agent_mismatch')
  )
  // (4) Run 的 agent 不是 Delivery 的 recipient（另一个助手跑出来的 Run）。
  assert.throws(
    () => assertRunIdentity({
      run: runFor({ agentId: OTHER_WORKER }),
      delivery,
      threadId: THREAD,
      ownership: ownershipFor({ agentId: OTHER_WORKER }),
      approvedWorkerAgentIds: [WORKER, OTHER_WORKER]
    }),
    rejectedCode('run_agent_mismatch'),
    'a Run for another assistant is never this delivery'
  )
  // (5) Run 的 agent 不在已批准集合内。
  assert.throws(
    () => assertRunIdentity({
      run: runFor({ agentId: OTHER_WORKER }),
      delivery: { ...delivery, recipientAgentId: OTHER_WORKER },
      threadId: THREAD,
      ownership: ownershipFor({ agentId: OTHER_WORKER }),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_agent_not_approved')
  )
  assert.throws(
    () => assertRunIdentity({
      run: runFor({ cancelRequestedAt: '2026-11-16T00:00:00Z' }),
      delivery,
      threadId: THREAD,
      ownership: ownershipFor(),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_cancelled')
  )
  assert.throws(
    () => assertRunIdentity({
      run: runFor({ status: 'cancelled' }),
      delivery,
      threadId: THREAD,
      ownership: ownershipFor(),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_cancelled')
  )
  assert.throws(
    () => assertRunIdentity({
      run: runFor({ status: 'failed', terminalReasonCode: 'runtime_not_configured' }),
      delivery,
      threadId: THREAD,
      ownership: ownershipFor(),
      approvedWorkerAgentIds: [WORKER]
    }),
    rejectedCode('run_terminal')
  )

  // Observation may report a terminal Run as a fact, but never as a usable fence.
  const observed = assertRunIdentity({
    run: runFor({ status: 'failed', terminalReasonCode: 'runtime_not_configured' }),
    delivery,
    threadId: THREAD,
    ownership: ownershipFor(),
    approvedWorkerAgentIds: [WORKER],
    allowTerminal: true
  })
  assert.equal(observed.terminal, true)
  assert.equal(observed.fenceUsable, false)
  assert.equal(observed.terminalReasonCode, 'runtime_not_configured')
})

test('ownershipFromThreadSnapshot only trusts this thread\'s authenticated snapshot and the exact Run id', () => {
  const snapshot = {
    schemaVersion: 9,
    thread: { id: THREAD, missionId: MISSION },
    messageDeliveries: [],
    agentRuns: [
      { id: 'run_1', agentId: WORKER, conversationId: WORKER_CONVERSATION, status: 'running' },
      { id: 'run_other', agentId: OTHER_WORKER, conversationId: 'conv_other', status: 'running' }
    ]
  }
  assert.deepEqual(
    ownershipFromThreadSnapshot({ snapshot, threadId: THREAD, missionId: MISSION, runId: 'run_1' }),
    {
      threadId: THREAD,
      conversationId: WORKER_CONVERSATION,
      agentId: WORKER,
      source: 'core_thread_snapshot_transaction'
    }
  )
  // 只按精确 run.id 取，不串味。
  assert.equal(
    ownershipFromThreadSnapshot({ snapshot, threadId: THREAD, missionId: MISSION, runId: 'run_other' }).agentId,
    OTHER_WORKER
  )
  // 错误快照（另一个 Thread / 另一个 Mission）一律不参与归属。
  assert.equal(ownershipFromThreadSnapshot({ snapshot, threadId: 'rvcamp_01other', missionId: MISSION, runId: 'run_1' }), null)
  assert.equal(ownershipFromThreadSnapshot({ snapshot, threadId: THREAD, missionId: 'mission_other', runId: 'run_1' }), null)
  // 伪造或别的 Thread 的 Run 不在本快照里 → 不接受。
  assert.equal(ownershipFromThreadSnapshot({ snapshot, threadId: THREAD, missionId: MISSION, runId: 'run_fabricated' }), null)
  // schema 不对或字段缺失 → 不接受。
  assert.equal(
    ownershipFromThreadSnapshot({ snapshot: { ...snapshot, schemaVersion: 8 }, threadId: THREAD, missionId: MISSION, runId: 'run_1' }),
    null
  )
  assert.equal(ownershipFromThreadSnapshot({
    snapshot: { ...snapshot, agentRuns: [{ id: 'run_1', agentId: WORKER }] },
    threadId: THREAD,
    missionId: MISSION,
    runId: 'run_1'
  }), null)
})

test('classifyDeliveryWait copies Core persisted wait conditions instead of inventing a state', () => {
  assert.deepEqual(
    classifyDeliveryWait({
      status: 'pending',
      dispatchPhase: 'attempted_waiting',
      waitCondition: 'runtime_unavailable',
      failureCode: null
    }),
    { state: 'waiting_for_runtime', blocked: true, waitCondition: 'runtime_unavailable', detail: null }
  )
  assert.equal(classifyDeliveryWait({ status: 'pending', dispatchPhase: 'never_attempted' }).state,
    'queued_never_attempted')
  assert.equal(classifyDeliveryWait({ status: 'pending', dispatchPhase: 'attempted_waiting', waitCondition: 'target_busy' }).state,
    'waiting_for_target_run')
  assert.equal(classifyDeliveryWait({ status: 'pending', dispatchPhase: 'attempted_waiting', waitCondition: 'capacity_unavailable' }).state,
    'waiting_for_capacity')
  assert.deepEqual(
    classifyDeliveryWait({ status: 'failed', dispatchPhase: 'terminal', waitCondition: null, failureCode: 'runtime_interrupted' }),
    { state: 'delivery_failed', blocked: true, waitCondition: null, detail: 'runtime_interrupted' }
  )
  assert.equal(classifyDeliveryWait({ status: 'settled', dispatchPhase: 'materialized' }).state, 'delivery_settled')
})

test('resolveDispatchRun walks policy → dispatch → delivery → run and refuses to guess', () => {
  const control = {
    missionId: MISSION,
    policy: { revision: 1, authorizationRevision: 1, enabled: true, taskIds: [TASK] },
    dispatches: [{
      dispatchId: 'dispatch_1',
      taskId: TASK,
      kind: 'execute',
      policyRevision: 1,
      recipientAgentId: WORKER,
      deliveryId: 'delivery_1',
      status: 'waiting',
      reason: null,
      createdAt: '2026-11-16T00:00:00Z'
    }]
  }
  const snapshotFor = (delivery, runs, coverage = { messageDeliveries: { complete: true }, agentRuns: { complete: true } }) => ({
    schemaVersion: 9,
    thread: { id: THREAD, missionId: MISSION },
    messageDeliveries: delivery ? [delivery] : [],
    agentRuns: runs,
    coverage
  })
  const waitingDelivery = {
    id: 'delivery_1',
    recipientAgentId: WORKER,
    status: 'pending',
    dispatchPhase: 'attempted_waiting',
    waitCondition: 'runtime_unavailable',
    targetAgentRunId: null
  }
  const boundDelivery = { ...waitingDelivery, dispatchPhase: 'materialized', waitCondition: null, targetAgentRunId: 'run_1' }
  const liveRun = {
    id: 'run_1',
    agentId: WORKER,
    // Run 跑在 AgentConversation 里，**不是**群聊 Thread id。
    conversationId: WORKER_CONVERSATION,
    status: 'running',
    cancelRequestedAt: null
  }

  const resolve = (controlRead, snapshot, runOwnership = (runId) => (
    runId === 'run_1' ? ownershipFor() : null
  )) => resolveDispatchRun({
    control: controlRead,
    snapshot,
    taskId: TASK,
    approvedWorkerAgentIds: [WORKER],
    runOwnership
  })

  assert.equal(resolve({ missionId: MISSION, policy: null, dispatches: [] }, snapshotFor(null, [])).state,
    'policy_not_configured')
  assert.equal(resolve({ ...control, dispatches: [] }, snapshotFor(null, [])).state, 'dispatch_not_observed')
  assert.equal(
    resolve({ ...control, dispatches: [{ ...control.dispatches[0], deliveryId: null }] }, snapshotFor(null, [])).state,
    'dispatch_without_delivery'
  )
  assert.equal(resolve(control, snapshotFor(null, [])).state, 'delivery_not_in_snapshot')
  assert.equal(
    resolve(control, snapshotFor(null, [], {
      messageDeliveries: { complete: false },
      agentRuns: { complete: true }
    })).state,
    'delivery_coverage_incomplete',
    'an incomplete read is never reported as absence'
  )

  const queued = resolve(control, snapshotFor(waitingDelivery, []))
  assert.equal(queued.state, 'waiting_for_runtime', 'no Runtime means no Run, and Core says so')
  assert.equal(queued.agentRunId, null)
  assert.equal(queued.blocked, true)
  assert.equal(queued.dispatchId, 'dispatch_1')
  assert.equal(queued.deliveryId, 'delivery_1')

  assert.equal(
    resolve(control, snapshotFor(boundDelivery, [], {
      messageDeliveries: { complete: true },
      agentRuns: { complete: false }
    })).state,
    'run_coverage_incomplete',
    'a bound delivery with an incomplete Run read is never treated as a missing Run'
  )
  assert.equal(resolve(control, snapshotFor(boundDelivery, [])).state, 'run_missing_from_snapshot')

  // 没有 Core 声明的归属 → 拒绝（不拿 conversationId 当 thread id，也不跳过）。
  assert.equal(
    resolve(control, snapshotFor(boundDelivery, [liveRun]), () => null).state,
    'run_ownership_unknown',
    'a Run without Core-declared ownership is never accepted'
  )
  // 归属指向另一个 Thread → 拒绝。
  assert.throws(
    () => resolve(
      control,
      snapshotFor(boundDelivery, [liveRun]),
      () => ownershipFor({ threadId: 'rvcamp_01other' })
    ),
    rejectedCode('run_thread_mismatch')
  )

  const bound = resolve(control, snapshotFor(boundDelivery, [liveRun]))
  assert.equal(bound.state, 'run_bound')
  assert.equal(bound.agentRunId, 'run_1')
  assert.equal(bound.run.fenceUsable, true)
  assert.equal(bound.run.agentId, WORKER)
  // 归属与 Run 自己的 conversation 一致，但与 Thread id 不同空间。
  assert.deepEqual(bound.ownership, ownershipFor())
  assert.equal(bound.run.conversationId, WORKER_CONVERSATION)
  assert.notEqual(bound.run.conversationId, THREAD,
    'AgentConversation and the group Thread are two id spaces')

  const terminal = resolve(control, snapshotFor(boundDelivery, [{ ...liveRun, status: 'failed' }]))
  assert.equal(terminal.state, 'run_bound_terminal')
  assert.equal(terminal.run.fenceUsable, false)
})

test('readNativeRunFacts refuses a snapshot that is not this thread or this Mission', async () => {
  const respond = (method) => {
    if (method === 'camps.open') {
      return Promise.resolve({ schemaVersion: 9, thread: { id: 'thread_elsewhere', missionId: MISSION } })
    }
    return Promise.resolve(method === 'loom.control.get' ? { missionId: MISSION, policy: null, dispatches: [] } : [])
  }
  await assert.rejects(
    readNativeRunFacts({ request: respond, missionId: MISSION, threadId: THREAD, approvedWorkerAgentIds: [WORKER] }),
    (error) => error?.message?.includes('schema-9 projection') === true
  )

  const wrongMission = (method) => {
    if (method === 'camps.open') {
      return Promise.resolve({ schemaVersion: 9, thread: { id: THREAD, missionId: 'mission_other' } })
    }
    return Promise.resolve(method === 'loom.control.get' ? { missionId: MISSION, policy: null, dispatches: [] } : [])
  }
  await assert.rejects(
    readNativeRunFacts({ request: wrongMission, missionId: MISSION, threadId: THREAD, approvedWorkerAgentIds: [WORKER] }),
    rejectedCode('run_thread_mismatch')
  )
})

test('defaultIsUnknownTransportError is fail-closed: only explicit transport markers may be retried', () => {
  // 确定结果：绝不重发。
  assert.equal(defaultIsUnknownTransportError(Object.assign(new Error('nope'), { kind: 'domain_rejection' })), false)
  assert.equal(
    defaultIsUnknownTransportError(Object.assign(new Error('bad'), {
      kind: 'infrastructure_failure',
      code: 'LOOM_CONTROL_REVIEWER_INVALID'
    })),
    false
  )
  // 一个不带任何传输标记的普通错误也算确定结果（无法证明是未知 → 不重发）。
  assert.equal(defaultIsUnknownTransportError(new Error('boom')), false,
    'an unprovable error must never trigger a resend')
  assert.equal(defaultIsUnknownTransportError('boom'), false)
  // 只有明确的传输层标记才算未知。
  assert.equal(defaultIsUnknownTransportError(Object.assign(new Error('t'), { kind: 'transport_unknown' })), true)
  assert.equal(defaultIsUnknownTransportError(Object.assign(new Error('t'), { code: 'request_timeout' })), true)
  assert.equal(defaultIsUnknownTransportError(Object.assign(new Error('t'), { code: 'ECONNRESET' })), true)
  assert.equal(defaultIsUnknownTransportError(Object.assign(new Error('t'), { code: 'EPIPE' })), true)
})

test('writeOnce resends only the same commandId and never mints a new one', async () => {
  const commandId = stableCommandId('control-configure', [MISSION, TASK])
  const params = { missionId: MISSION, commandId, taskIds: [TASK] }

  // 1. plain success
  let seen = []
  const applied = await writeOnce({
    request: async (method, sent) => { seen.push(sent.commandId); return { ok: true } },
    method: 'loom.control.configure',
    params,
    commandId,
    readBack: async () => false
  })
  assert.equal(applied.outcome, 'applied')
  assert.deepEqual(seen, [commandId])

  // 2. unknown transport, read-back proves it landed: no resend at all
  seen = []
  const recovered = await writeOnce({
    request: async () => {
      seen.push('sent')
      throw Object.assign(new Error('timeout'), { code: 'request_timeout' })
    },
    method: 'loom.control.configure',
    params,
    commandId,
    readBack: async () => true
  })
  assert.equal(recovered.outcome, 'recovered_after_unknown')
  assert.deepEqual(seen, ['sent'], 'a read-back that proves the intent must prevent any resend')

  // 3. unknown transport, read-back false: exactly one same-id resend
  const ids = []
  let attempt = 0
  const resent = await writeOnce({
    request: async (method, sent) => {
      ids.push(sent.commandId)
      attempt += 1
      if (attempt === 1) throw Object.assign(new Error('timeout'), { code: 'request_timeout' })
      return { ok: true }
    },
    method: 'loom.control.configure',
    params,
    commandId,
    readBack: async () => false
  })
  assert.equal(resent.outcome, 'applied')
  assert.equal(resent.resent, true)
  assert.deepEqual(ids, [commandId, commandId], 'the resend must reuse the identical commandId')

  // 4. still unknown: refuse, and never invent an id
  const unresolvedIds = []
  await assert.rejects(
    writeOnce({
      request: async (method, sent) => {
        unresolvedIds.push(sent.commandId)
        throw Object.assign(new Error('timeout'), { code: 'request_timeout' })
      },
      method: 'loom.control.configure',
      params,
      commandId,
      readBack: async () => false
    }),
    rejectedCode('unknown_result_unresolved')
  )
  assert.deepEqual(unresolvedIds, [commandId, commandId])

  // 5. a domain rejection is a committed result: rethrow, never retry
  const rejectionIds = []
  await assert.rejects(
    writeOnce({
      request: async (method, sent) => {
        rejectionIds.push(sent.commandId)
        throw Object.assign(new Error('revision conflict'), {
          kind: 'domain_rejection',
          code: 'LOOM_CONTROL_REVISION_CONFLICT'
        })
      },
      method: 'loom.control.configure',
      params,
      commandId,
      readBack: async () => false
    }),
    (error) => error?.code === 'LOOM_CONTROL_REVISION_CONFLICT'
  )
  assert.deepEqual(rejectionIds, [commandId], 'a domain rejection must never be resent')

  // 6. a definite rejection that carries no `kind` (e.g. a bare Core error body) is also
  //    never resent: only provable transport failures may be retried.
  const bareIds = []
  await assert.rejects(
    writeOnce({
      request: async (method, sent) => {
        bareIds.push(sent.commandId)
        throw Object.assign(new Error('every Task needs exactly one reviewer'), {
          code: 'LOOM_CONTROL_REVIEWER_INVALID'
        })
      },
      method: 'loom.control.configure',
      params,
      commandId,
      readBack: async () => false
    }),
    (error) => error?.code === 'LOOM_CONTROL_REVIEWER_INVALID'
  )
  assert.deepEqual(bareIds, [commandId], 'a definite rejection without a transport marker must not be resent')

  // 7. an unclassifiable error is not a transport unknown either.
  const unclassifiedIds = []
  await assert.rejects(
    writeOnce({
      request: async (method, sent) => {
        unclassifiedIds.push(sent.commandId)
        throw new Error('pipe closed')
      },
      method: 'loom.control.configure',
      params,
      commandId,
      readBack: async () => true
    }),
    (error) => error?.message === 'pipe closed'
  )
  assert.deepEqual(unclassifiedIds, [commandId], 'an unprovable error must never be retried, even with a read-back')
})

test('startNativeDispatch reports dispatch_not_observed instead of inventing a dispatch', async () => {
  const policy = buildDispatchPolicy({
    missionId: MISSION,
    taskIds: [TASK],
    approvedWorkerAgentIds: [WORKER],
    tasks: [{ taskId: TASK, status: 'ready', assigneeAgentId: WORKER }],
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  })
  const facts = {
    control: { missionId: MISSION, policy: { revision: 1, enabled: true, taskIds: [TASK] }, dispatches: [] },
    snapshot: {
      schemaVersion: 9,
      thread: { id: THREAD, missionId: MISSION },
      messageDeliveries: [],
      agentRuns: [],
      coverage: { messageDeliveries: { complete: true }, agentRuns: { complete: true } }
    },
    reviews: [],
    candidates: []
  }
  const outcome = await startNativeDispatch({
    request: async () => ({ missionId: MISSION }),
    policy,
    readFacts: async () => facts,
    taskId: TASK,
    approvedWorkerAgentIds: [WORKER],
    dispatchBudgetMs: 150,
    pollIntervalMs: 50
  })
  assert.equal(outcome.dispatchObserved, false)
  assert.equal(outcome.outcome, 'dispatch_not_observed')
  assert.equal(outcome.completed, false)
  assert.equal(outcome.ownerReviewRecorded, false)
})

// ---------------------------------------------------------------------------
// B. 真实隔离 Core 集成
// ---------------------------------------------------------------------------

test('a real isolated Core turns an approved plan into a traceable dispatch and the facade never invents the Run', {
  timeout: 600_000
}, async () => {
  const evidence = await runNativeDeliveryEvidence({ dispatchBudgetMs: 30_000 })

  // 范围声明必须逐条为真，而不是文案。
  for (const [key, value] of Object.entries(NATIVE_DELIVERY_EVIDENCE_ENVELOPE)) {
    assert.deepEqual(evidence[key], value, `the evidence must keep its standing declaration ${key}`)
  }
  assert.equal(evidence.ok, true)
  assert.equal(evidence.isolation.dataRootInsideFixture, true)
  assert.equal(evidence.isolation.userDatabaseTouched, false)
  assert.equal(evidence.isolation.port64851Touched, false)
  // fixture 隔离必须完整：其他 Agent 的宿主目录也指向 fixture，认证变量不继承，PATH 仅系统目录。
  assert.equal(evidence.isolation.agentHomesInsideFixture, true)
  assert.equal(evidence.isolation.hostCredentialEnvStripped, true)
  assert.equal(evidence.isolation.pathSystemOnly, true)
  // 未配置 Runtime 时只能是诚实的 QUEUED/BLOCKED，不得声称有冻结 Runtime 或真实模型执行。
  assert.equal(evidence.hasFrozenRuntime, false)
  assert.equal(evidence.realModelExecution, false)

  // 派发是 Core 自己写的，且真的带了一条 Delivery。
  assert.equal(typeof evidence.dispatch.dispatchId, 'string')
  assert.equal(typeof evidence.dispatch.deliveryId, 'string')
  assert.equal(evidence.dispatch.kind, 'execute')
  assert.equal(evidence.policy.approvedBy, 'local_user',
    'the approver is the Host-injected local_user, never a claimed UI approval')

  // 缓存二进制必须被准确声明：本文件从不编译，运行版可能与源码有差异。
  assert.equal(evidence.cargoBuildInvoked, false)
  assert.equal(evidence.binarySource, 'cached-prebuild')
  assert.equal(evidence.binaryIsCachedPrebuild, true)
  assert.equal(evidence.cachedBinaryMayDifferFromSource, true)
  assert.match(evidence.coreBinarySha256, /^[0-9a-f]{64}$/)

  // 生产者与独立审查者必须是两个不同的 present 成员，且 reviewer 不是 assignee。
  assert.equal(evidence.members.distinct, true)
  assert.notEqual(evidence.members.workerAgentId, evidence.members.reviewerAgentId)
  assert.equal(evidence.members.reviewerIsAssignee, false)
  assert.equal(evidence.members.workerPresence, 'present')
  assert.equal(evidence.members.reviewerPresence, 'present')
  assert.deepEqual(
    evidence.policy.reviewers.map((reviewer) => reviewer.taskId),
    evidence.policy.taskIds,
    'the cached Core requires exactly one reviewer per Task in scope'
  )
  assert.equal(evidence.policy.reviewersCoverEveryTask, true)
  assert.notEqual(
    evidence.policy.reviewers[0].reviewerAgentId,
    evidence.tasks[0].assigneeAgentId,
    'the reviewer must never be the Task assignee'
  )

  // 受限范围：只开 EXECUTE 派发；独立 review 不是 Owner Accepted。
  assert.equal(evidence.executeDispatchOnly, true)
  assert.equal(evidence.reviewerVerdictIsNotOwnerAcceptance, true)
  assert.equal(evidence.assigneeNeverReviewsOwnTask, true)

  // Run 是否被物化必须与读回一致，并且永远不是"完成"。
  assert.equal(typeof evidence.runMaterialized, 'boolean')
  if (evidence.runMaterialized) {
    assert.equal(evidence.runFenceUsable, true)
    assert.equal(evidence.blockedOrQueued, false)
    assert.equal(evidence.link.run.agentId, evidence.tasks[0].assigneeAgentId)
    // 归属必须来自本次已认证的 Core 事务快照；conversationId 与 threadId 是两个 id 空间。
    assert.equal(evidence.runOwnership.source, 'core_thread_snapshot_transaction')
    assert.equal(evidence.runOwnership.threadId, evidence.mission.threadId)
    assert.equal(evidence.runOwnership.conversationId, evidence.link.run.conversationId)
    assert.equal(evidence.runOwnership.agentId, evidence.members.workerAgentId)
    assert.equal(typeof evidence.conversationEqualsThread, 'boolean')
  } else {
    assert.equal(evidence.blockedOrQueued, true)
    assert.equal(evidence.runFenceUsable, false)
    assert.equal(evidence.link.agentRunId, null)
    assert.equal(evidence.runOwnership, null)
    assert.ok(
      ['waiting_for_runtime', 'waiting_for_target_run', 'waiting_for_capacity',
        'queued_never_attempted', 'dispatching', 'delivery_settled'].includes(evidence.link.state),
      `a missing Run must be an explicit Core wait/queue fact: ${JSON.stringify(evidence.link)}`
    )
    if (evidence.link.state.startsWith('waiting_for_')) {
      assert.ok(evidence.link.waitCondition !== null,
        `a waiting delivery must carry Core's wait condition: ${JSON.stringify(evidence.link)}`)
    }
  }

  // 本门面从不替用户 Review，也从不接受候选。
  assert.equal(evidence.ownerReviewRecorded, false)
  assert.equal(evidence.reviewsCount, 0)
})
