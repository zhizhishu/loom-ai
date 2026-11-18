import { readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runPrivateExecutor } from './local-hook-executor.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const rootIdentity = value => {
  const root = realpathSync.native(value)
  return process.platform === 'win32' ? root.toLowerCase() : root
}
const fail = code => { throw new Error(code) }

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

export function validatePolicy(policy, launch, root = rootIdentity) {
  if (!policy || policy.mode !== launch.sandboxMode || root(policy.workspaceRoot) !== root(launch.workspaceRoot)
    || (policy.additionalWritableRoots?.length ?? 0) !== 0) fail('local_hook_sandbox_scope_mismatch')
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
    inject: ['loader', 'agents', 'workingDirectory', 'sandboxPolicy'],
    async apply(local) {
      // Native DSH owns the Session event schema. The command itself is run
      // only by the verified private child; local.shell is never invoked.
      const protocol = await local.loader.import('@deepseek-ai/dsh-hook-protocol')
      if (!['appendHookInvoked', 'appendHookResult'].every(key => typeof protocol[key] === 'function')) {
        fail('local_hook_event_protocol_unavailable')
      }
      validatePolicy(local.sandboxPolicy.resolve(), launch)
      const ownedAbort = new AbortController()
      const inflight = new Set(), invocations = new Map()
      let serial = 0, boundSessionId
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
        if (++serial > 128) fail('local_hook_invocation_budget_exceeded')
        const turn = local.agents.turnBoundaryOf(session).lastTurn
        if (!Number.isSafeInteger(turn) || turn < 0) fail('local_hook_native_turn_invalid')
        const signal = AbortSignal.any([exec.signal, ownedAbort.signal])
        signal.throwIfAborted()
        const cwd = await local.workingDirectory.ensure(exec.agent, signal)
        if (rootIdentity(cwd) !== rootIdentity(launch.workspaceRoot)) fail('local_hook_workspace_changed')
        validatePolicy(local.sandboxPolicy.resolve(), launch)
        const handlerId = 'loom:' + launch.snapshotDigest.slice(0, 16) + ':' + serial
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
