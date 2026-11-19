import { readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { runPrivateExecutor } from './local-hook-executor.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(code) }
// A relative path would be resolved against this Host's own process directory,
// which is exactly the inference this adapter must never make. Missing or
// non-absolute input is a refusal, not a fallback.
const rootIdentity = value => {
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) fail('local_hook_workspace_unavailable')
  let root
  try {
    root = realpathSync.native(value)
  } catch {
    fail('local_hook_workspace_unavailable')
  }
  return process.platform === 'win32' ? root.toLowerCase() : root
}

// Cordis resolves a service the plugin did not inject only through
// `ctx.reflect.get`; a bare property read on an inactive context throws. Plain
// fixture objects expose the same names directly.
const service = (local, name) => typeof local?.reflect?.get === 'function'
  ? local.reflect.get(name, false)
  : local?.[name]

// The main Host owns the Session schema. 0.2 dropped `workingDirectory` and the
// `agents` turn-boundary helper: the Session projection registry now carries the
// open turn and the frozen Session header carries the absolute boundary, while
// `sandboxPolicy.resolve` only computes a Session's effective mode when the
// Session is passed in. Both contracts are supported; neither fact is ever
// inferred, and a Host exposing neither is refused.
function sessionContract(local) {
  const projections = service(local, 'sessionProjections')
  if (typeof projections?.stateOf === 'function') return 'projection'
  if (typeof service(local, 'agents')?.turnBoundaryOf === 'function') return 'legacy'
  fail('local_hook_session_contract_unavailable')
}

const turnOf = (local, contract, session) => contract === 'projection'
  ? service(local, 'sessionProjections').stateOf(session, 'turnBoundary')?.lastTurn
  : service(local, 'agents').turnBoundaryOf(session).lastTurn

const policyOf = (local, contract, session) => contract === 'projection'
  ? local.sandboxPolicy.resolve({ session })
  : local.sandboxPolicy.resolve()

// 0.2 binds the writable boundary to the immutable Session header. The legacy
// `workingDirectory` seam is only consulted for a Host that carries no header
// cwd at all; a 0.2 Host without one is refused rather than guessed.
async function workspaceOf(local, contract, exec, signal) {
  const headerCwd = exec?.agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  if (contract === 'projection') fail('local_hook_workspace_missing')
  const ensure = service(local, 'workingDirectory')?.ensure
  if (typeof ensure !== 'function') fail('local_hook_workspace_missing')
  return await ensure(exec.agent, signal)
}

// This adapter uses DSH's official Hook runner and durable event helpers.
// It adds the Core Run/epoch/root-session fence that a process-global bridge
// cannot supply. It never registers a native Skill or mutates a Profile.
export function validateLaunch(launch) {
  if (!launch || launch.schemaVersion !== 1 || typeof launch.agentRunId !== 'string'
    || !Number.isSafeInteger(launch.executionEpoch) || launch.executionEpoch < 0
    || !/^[a-f0-9]{64}$/.test(launch.snapshotDigest) || typeof launch.hookId !== 'string'
    || !['read-only', 'workspace-write'].includes(launch.sandboxMode)) fail('local_hook_launch_invalid')
  const events = launch.settings?.hooks
  if (!events || Object.keys(launch.settings).join() !== 'hooks'
    || Object.keys(events).join() !== 'PostToolUse'
    || !Array.isArray(events.PostToolUse) || events.PostToolUse.length !== 1) fail('local_hook_settings_invalid')
  const group = events.PostToolUse[0]
  if (!group || Object.keys(group).sort().join() !== 'hooks,matcher'
    || typeof group.matcher !== 'string' || !/^\^[A-Za-z0-9_-]{1,128}\$$/.test(group.matcher)
    || !Array.isArray(group.hooks) || group.hooks.length !== 1) fail('local_hook_matcher_invalid')
  const hook = group.hooks[0]
  if (!hook || Object.keys(hook).sort().join() !== 'command,timeout,type' || hook.type !== 'command'
    || typeof hook.command !== 'string' || !hook.command.trim() || hook.command.length > 8000
    || typeof hook.timeout !== 'number' || !Number.isFinite(hook.timeout)
    || hook.timeout <= 0 || hook.timeout > 5) fail('local_hook_command_invalid')
  return { tool: group.matcher.slice(1, -1), command: hook.command, timeoutSec: hook.timeout }
}

export function validatePolicy(policy, launch, root = rootIdentity, sessionId) {
  if (!policy || policy.mode !== launch.sandboxMode || root(policy.workspaceRoot) !== root(launch.workspaceRoot)
    || (policy.additionalWritableRoots?.length ?? 0) !== 0) fail('local_hook_sandbox_scope_mismatch')
  // 0.2 reports the Session whose mode it resolved; a policy resolved for any
  // other Session would be the wrong fence and is refused.
  if (sessionId !== undefined && policy.sessionId !== undefined && policy.sessionId !== sessionId) {
    fail('local_hook_sandbox_session_mismatch')
  }
}

export function rootBinding(config, session, read = readFileSync) {
  if (!session || session.header.parentSession != null) return false
  if (typeof session.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(session.id)) fail('local_hook_session_invalid')
  const binding = JSON.parse(read(join(config.bindingRoot, session.id + '.json'), 'utf8'))
  if (binding.schemaVersion !== 1 || binding.sessionId !== session.id
    || typeof binding.bootstrap !== 'string' || !binding.bootstrap.trim()
    || hash(binding.bootstrap) !== binding.sha256) fail('local_hook_binding_invalid')
  return true
}

// A local installation can retain official class names while replacing its
// confinement with a purge patch. Never treat its self-reported 'full' flag
// as evidence. This explicit rejection is separate from the clean executor's
// pinned source verification and the actual confinement acceptance.
export function rejectKnownSandboxBypass(sandbox) {
  if (typeof sandbox?.confine !== 'function') fail('local_hook_sandbox_provider_unavailable')
  if (/dsh-purge|sandbox bypass/iu.test(Function.prototype.toString.call(sandbox.confine))) {
    fail('local_hook_native_sandbox_modified')
  }
}

export async function installLocalHooks(ctx, config, execute = runPrivateExecutor) {
  const launch = config.localHook
  const hook = validateLaunch(launch)
  if (!config.localHookExecutor) fail('local_hook_clean_executor_missing')
  const verified = await execute(config.localHookExecutor, launch, 'verify')
  const owner = ctx.plugin({
    name: 'loom-local-post-tool-hook',
    // Only services every supported Host provides are hard dependencies. A 0.2
    // Host has no `workingDirectory`, and requiring it would leave this plugin
    // permanently inactive instead of failing loudly on a missing fact.
    inject: ['loader', 'agents', 'sandboxPolicy'],
    async apply(local) {
      // Native DSH owns the Session event schema. The command itself is run
      // only by the verified private child; local.shell is never invoked.
      const protocol = await local.loader.import('@deepseek-ai/dsh-hook-protocol')
      if (!['appendHookInvoked', 'appendHookResult'].every(key => typeof protocol[key] === 'function')) {
        fail('local_hook_event_protocol_unavailable')
      }
      // Startup can only check the deployment default: no Session exists yet.
      validatePolicy(local.sandboxPolicy.resolve(), launch)
      const ownedAbort = new AbortController()
      const inflight = new Set(), invocations = new Map()
      let serial = 0, boundSessionId, contract
      local.effect(() => async () => {
        ownedAbort.abort()
        await Promise.allSettled([...inflight])
      }, 'loom-local-hook: abort and drain owned command')

      local.on('session/event', (session, event) => {
        if (session.header.parentSession != null || !['hook/invoked', 'hook/result'].includes(event.type)) return
        const invocation = invocations.get(event.data?.handlerId)
        if (!invocation || invocation.sessionId !== session.id || invocation.turn !== event.data?.turn) return
        if (!Number.isSafeInteger(event.seq) || event.seq < 0) fail('local_hook_native_sequence_invalid')
        const result = event.type === 'hook/result'
        const observation = {
          schemaVersion: 1, agentRunId: launch.agentRunId, executionEpoch: launch.executionEpoch,
          snapshotDigest: launch.snapshotDigest, hookId: launch.hookId,
          sessionId: session.id, seq: event.seq, turn: invocation.turn,
          handlerId: event.data.handlerId, point: 'PostToolUse', kind: result ? 'result' : 'invoked',
          ...(result ? {
            ...(Number.isSafeInteger(event.data.exitCode) ? { exitCode: event.data.exitCode } : {}),
            decision: event.data.decision, durationMs: event.data.durationMs,
            ...(typeof event.data.stderrSummary === 'string'
              ? { stderrDigest: 'sha256:' + hash(event.data.stderrSummary) } : {}),
            ...(invocation.facts ?? {})
          } : {})
        }
        const target = join(config.observationRoot, hash(session.id) + '.hook-' + event.seq + '.json')
        writeFileSync(target + '.tmp', JSON.stringify(observation), { mode: 0o600 })
        renameSync(target + '.tmp', target)
      })

      local.on('tools/post-execute', async (exec, result, next) => {
        if (exec.parent || exec.agent?.session.header.parentSession != null || exec.name !== hook.tool) return next()
        const session = exec.agent?.session
        if (!rootBinding(config, session)) return next()
        if (boundSessionId !== undefined && boundSessionId !== session.id) fail('local_hook_second_root_session')
        boundSessionId = session.id
        // One Host, one contract: a Host that changes shape mid-Run would give
        // two different meanings to the same receipt.
        const resolved = sessionContract(local)
        if (contract !== undefined && contract !== resolved) fail('local_hook_session_contract_changed')
        contract = resolved
        const invocationSerial = ++serial
        if (invocationSerial > 128) fail('local_hook_invocation_budget_exceeded')
        const turn = turnOf(local, contract, session)
        if (!Number.isSafeInteger(turn) || turn < 0) fail('local_hook_native_turn_invalid')
        const signal = AbortSignal.any([exec.signal, ownedAbort.signal])
        signal.throwIfAborted()
        const cwd = await workspaceOf(local, contract, exec, signal)
        if (rootIdentity(cwd) !== rootIdentity(launch.workspaceRoot)) fail('local_hook_workspace_changed')
        validatePolicy(policyOf(local, contract, session), launch, rootIdentity, session.id)
        const handlerId = 'loom:' + launch.snapshotDigest.slice(0, 16) + ':' + invocationSerial
        const invocation = { sessionId: session.id, turn }
        invocations.set(handlerId, invocation)
        const input = { sessionId: session.id, turn, handlerId, payload: {
          session_id: session.id, transcript_path: null, hook_event_name: 'PostToolUse',
          model: launch.model, permission_mode: 'default', turn_id: String(turn), cwd,
          tool_name: exec.name, tool_use_id: exec.callId,
          tool_input: { command: typeof exec.arguments?.command === 'string' ? exec.arguments.command : '' },
          tool_response: result.content.filter(block => block.type === 'text').map(block => block.text).join('')
        } }
        if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) fail('local_hook_input_budget')
        protocol.appendHookInvoked(session, { turn, point: 'PostToolUse', dialect: 'codex', handlerId, matcher: hook.tool })
        const run = (async () => {
          const started = performance.now()
          let outcome
          try {
            const reply = await execute(config.localHookExecutor, launch, 'invoke', input, signal)
            invocation.facts = reply.facts
            outcome = { output: reply.output, durationMs: reply.durationMs }
          } catch (error) {
            protocol.appendHookResult(session, { turn, point: 'PostToolUse', handlerId,
              output: { stderr: 'The reviewed Hook executor failed before a verified result.' },
              stderrSummaryMaxChars: 500, durationMs: performance.now() - started })
            throw error
          }
          protocol.appendHookResult(session, { turn, point: 'PostToolUse', handlerId,
            output: outcome.output, stderrSummaryMaxChars: 500, durationMs: outcome.durationMs })
          return outcome
        })()
        inflight.add(run)
        let outcome
        try { outcome = await run } finally { inflight.delete(run) }
        signal.throwIfAborted()
        if (outcome.output.exitCode === undefined || !invocation.facts
          || invocation.facts.timedOut || invocation.facts.aborted) fail('local_hook_execution_failed')
        if (outcome.output.continue === false) fail('local_hook_stop_output_unsupported')
        if (outcome.output.decision === 'ask') fail('local_hook_post_tool_ask_unsupported')
        let context
        if (typeof outcome.output.additionalContext === 'string' && outcome.output.additionalContext) {
          const llm = await local.loader.import('@deepseek-ai/dsh-llm')
          context = llm.createUserMessage({ content: [{ type: 'text', text: outcome.output.additionalContext }],
            source: { kind: 'hooks-codex' } })
        }
        if (['block', 'deny'].includes(outcome.output.decision)) return {
          kind: 'block', feedback: [{ type: 'text', text: outcome.output.reason ?? 'Blocked by the selected PostToolUse Hook' }],
          ...(context ? { additionalContexts: [context] } : {})
        }
        if (outcome.output.exitCode !== 0) fail('local_hook_command_failed')
        const downstream = await next()
        return context ? { ...downstream, additionalContexts: [context, ...(downstream.additionalContexts ?? [])] } : downstream
      })
    }
  })
  await owner.await()
  const ready = join(config.observationRoot, 'local-hook-ready.json')
  writeFileSync(ready + '.tmp', JSON.stringify({ schemaVersion: 1, status: 'ready',
    agentRunId: launch.agentRunId, executionEpoch: launch.executionEpoch,
    snapshotDigest: launch.snapshotDigest, sandboxMode: launch.sandboxMode,
    chain: 'private-pinned', manifestDigest: verified.manifestDigest }), { mode: 0o600 })
  renameSync(ready + '.tmp', ready)
}
