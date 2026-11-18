// One reviewed Hook invocation, with a fixed private official dependency closure.
// This process receives no provider credentials and never loads native DSH profiles.
import { readFileSync, realpathSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { verifyBundle, validateLaunch, sha256 } from './verify.mjs'

const prefix = 'LOOM_HOOK_EXECUTOR '
const write = value => process.stdout.write(prefix + JSON.stringify(value) + '\n')
const demand = (value, code) => { if (!value) throw new Error(code) }
const identity = path => realpathSync.native(path).toLowerCase()
const args = new Map()
for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at], process.argv[at + 1])
const controller = new AbortController()
let lines, invocation, outcome, fence, running = false, finished = false

async function main() {
  demand(process.platform === 'win32' && process.arch === 'x64', 'local_hook_executor_platform_unsupported')
  const root = dirname(fileURLToPath(import.meta.url))
  const bundle = verifyBundle(root, args.get('--manifest-sha256'))
  const launchPath = args.get('--launch')
  demand(typeof launchPath === 'string' && !lstatSync(launchPath).isSymbolicLink()
    && lstatSync(launchPath).isFile(), 'local_hook_launch_file_invalid')
  const bytes = readFileSync(launchPath)
  demand(sha256(bytes) === args.get('--launch-sha256'), 'local_hook_launch_changed')
  const launch = JSON.parse(bytes), hook = validateLaunch(launch)
  const workspaceRoot = identity(launch.workspaceRoot)
  fence = { schemaVersion: 1, agentRunId: launch.agentRunId, executionEpoch: launch.executionEpoch,
    snapshotDigest: launch.snapshotDigest, manifestDigest: bundle.manifestDigest }
  // Imports happen only after checking the complete packaged tree.
  const [{ Context }, { LocalSubprocessRuntime }, { LocalSandboxProvider }, { SandboxPwshExecutor }, protocol] =
    await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-subprocess-local'),
      import('@deepseek-ai/dsh-sandbox-local'), import('@deepseek-ai/dsh-pwsh-sandbox'),
      import('@deepseek-ai/dsh-hook-protocol')
    ])
  const ctx = new Context()
  const policy = Object.freeze({ mode: launch.sandboxMode, workspaceRoot: launch.workspaceRoot,
    additionalWritableRoots: [], sessionId: launch.agentRunId + ':' + launch.executionEpoch })
  ctx.provide('sandboxPolicy', { defaultMode: launch.sandboxMode, resolve: () => policy })
  const fibers = [ctx.plugin(LocalSubprocessRuntime), ctx.plugin(LocalSandboxProvider, {}),
    ctx.plugin(SandboxPwshExecutor, { cwd: launch.workspaceRoot })]
  let subprocessOwner
  try {
    await Promise.all(fibers.map(fiber => fiber.await()))
    subprocessOwner = ctx.subprocess
    demand(ctx.shell instanceof SandboxPwshExecutor && typeof ctx.sandbox?.confine === 'function',
      'local_hook_clean_executor_unavailable')
    demand(!/dsh-purge|sandbox bypass/iu.test(Function.prototype.toString.call(ctx.sandbox.confine)),
      'local_hook_clean_executor_modified')
    if (args.get('--mode') === 'verify') {
      outcome = { ...fence, status: 'ready', sandboxMode: launch.sandboxMode, chain: 'private-pinned' }
      return
    }
    demand(args.get('--mode') === 'invoke', 'local_hook_executor_mode_invalid')
    invocation = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local_hook_input_timeout')), 8000)
      lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
      lines.on('line', line => {
        try {
          demand(Buffer.byteLength(line) <= 1024 * 1024, 'local_hook_input_budget')
          const value = JSON.parse(line)
          if (value.type === 'cancel') { controller.abort(); return }
          demand(!running && value.type === 'invoke', 'local_hook_duplicate_invocation')
          running = true
          demand(typeof value.sessionId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value.sessionId)
            && Number.isSafeInteger(value.turn) && value.turn >= 0
            && typeof value.handlerId === 'string' && value.handlerId.length <= 160
            && value.payload?.hook_event_name === 'PostToolUse'
            && value.payload.session_id === value.sessionId && value.payload.tool_name === hook.tool
            && value.payload.turn_id === String(value.turn)
            && identity(value.payload.cwd) === workspaceRoot, 'local_hook_invocation_mismatch')
          clearTimeout(timer); resolve(value)
        } catch (error) { controller.abort(); clearTimeout(timer); reject(error) }
      })
      lines.on('close', () => { if (!finished) controller.abort() })
      lines.on('error', reject)
    })
    controller.signal.throwIfAborted()
    demand(identity(launch.workspaceRoot) === workspaceRoot
      && sha256(readFileSync(launchPath)) === args.get('--launch-sha256'), 'local_hook_launch_changed')
    let observed
    const shell = {
      resolve(request) {
        demand(request.command === hook.command && request.env === undefined
          && request.timeoutMs === hook.timeoutSec * 1000
          && identity(request.workdir) === workspaceRoot, 'local_hook_command_scope_mismatch')
        return ctx.shell.resolve(request)
      },
      async run(spec) { observed = await ctx.shell.run(spec); return observed }
    }
    const result = await protocol.runHook(shell, hook, {
      cwd: launch.workspaceRoot, signal: controller.signal, payload: invocation.payload,
      defaultTimeoutMs: hook.timeoutSec * 1000, expectedEventName: 'PostToolUse', trailingNewline: false
    }, () => performance.now())
    const sandbox = observed?.sandbox
    demand(sandbox?.mode === launch.sandboxMode && ['partial', 'full'].includes(sandbox.enforcement),
      'local_hook_clean_receipt_missing')
    const output = { exitCode: result.output.exitCode, stderr: (result.output.stderr ?? '').slice(0, 500) }
    for (const name of ['decision', 'reason', 'continue', 'stopReason', 'additionalContext']) {
      const value = result.output[name]
      if (typeof value === 'boolean') output[name] = value
      else if (typeof value === 'string') output[name] = value.slice(0, name === 'additionalContext' ? 32768 : 2000)
    }
    outcome = { ...fence, status: 'result', sessionId: invocation.sessionId, turn: invocation.turn,
      handlerId: invocation.handlerId, output, durationMs: result.durationMs,
      facts: { sandboxEnforcement: sandbox.enforcement, sandboxDenied: sandbox.denied === true,
        aborted: observed.aborted === true || controller.signal.aborted, timedOut: observed.timedOut === true } }
  } finally {
    // Native command ownership must be drained before a result is emitted.
    controller.abort()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    demand(!subprocessOwner || subprocessOwner.live.size === 0, 'local_hook_process_not_drained')
    if (outcome) outcome.liveManagedHandles = 0
  }
}
try { await main() }
catch (error) {
  const message = String(error?.message ?? error)
  outcome = { ...fence, status: 'failed',
    errorCode: /^local_hook_[a-z_]+$/.test(message) ? message : 'local_hook_executor_failed' }
  process.exitCode = 1
} finally {
  finished = true
  lines?.close()
  process.stdin.destroy()
  write(outcome ?? { status: 'failed', errorCode: 'local_hook_executor_no_result' })
}
