import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

// Keep machine lookup variables; provider credentials and Node injection
// variables are never inherited by the reviewed Hook command.
export function hookExecutorEnvironment(environment = process.env) {
  const allowed = /^(path|pathext|systemroot|windir|systemdrive|comspec|temp|tmp|userprofile|localappdata|appdata|programfiles|programfiles\(x86\))$/i
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.test(key)))
}
const fail = code => { throw new Error(code) }
export function validateExecutor(config) {
  if (config?.schemaVersion !== 1 || ![config.node, config.root, config.launchPath].every(value =>
    typeof value === 'string' && isAbsolute(value)) || ![config.manifestDigest, config.launchDigest]
    .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail('local_hook_executor_configuration_invalid')
}
const fenceMatches = (reply, config, launch) => reply?.schemaVersion === 1
  && reply.agentRunId === launch.agentRunId && reply.executionEpoch === launch.executionEpoch
  && reply.snapshotDigest === launch.snapshotDigest && reply.manifestDigest === config.manifestDigest

export async function runPrivateExecutor(config, launch, mode, invocation, signal = new AbortController().signal) {
  validateExecutor(config)
  if (!['verify', 'invoke'].includes(mode)) fail('local_hook_executor_mode_invalid')
  signal.throwIfAborted()
  const args = [join(config.root, 'executor.mjs'), '--launch', config.launchPath,
    '--launch-sha256', config.launchDigest, '--manifest-sha256', config.manifestDigest, '--mode', mode]
  const env = hookExecutorEnvironment()
  return new Promise((resolve, reject) => {
    const child = spawn(config.node, args, { cwd: launch.workspaceRoot, env,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let stdout = '', total = 0, failure, killTimer, closed = false, cancelling = false
    const cancel = code => {
      failure ??= code
      if (closed || cancelling) return
      cancelling = true
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n')
      // Give the official subprocess owner time to cancel and drain. Only this
      // owned helper PID/tree is terminated if that cooperative path stalls.
      killTimer = setTimeout(() => {
        if (closed) return
        if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
          const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
          const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore', shell: false })
          killer.once('error', () => child.kill())
        } else child.kill('SIGKILL')
      }, 6000)
    }
    const onAbort = () => cancel('local_hook_cancelled')
    const timer = setTimeout(() => cancel('local_hook_executor_timed_out'), 25000)
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdin.on('error', () => {}) // close/error below owns the outcome
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      total += Buffer.byteLength(chunk)
      if (total > 128 * 1024) cancel('local_hook_executor_output_budget')
      else stdout += chunk
    })
    child.stderr.on('data', chunk => {
      total += chunk.length
      if (total > 128 * 1024) cancel('local_hook_executor_output_budget')
    })
    const cleanup = () => {
      closed = true; clearTimeout(timer); clearTimeout(killTimer)
      signal.removeEventListener('abort', onAbort)
    }
    child.once('error', () => { cleanup(); reject(new Error('local_hook_executor_spawn_failed')) })
    child.once('close', code => {
      cleanup()
      try {
        const records = stdout.split(/\r?\n/).filter(line => line.startsWith('LOOM_HOOK_EXECUTOR '))
        if (records.length !== 1) fail(failure ?? 'local_hook_executor_result_missing')
        const reply = JSON.parse(records[0].slice('LOOM_HOOK_EXECUTOR '.length))
        if (reply.status === 'failed') fail(/^local_hook_[a-z_]+$/.test(reply.errorCode)
          ? reply.errorCode : 'local_hook_executor_failed')
        if (code !== 0 || reply.liveManagedHandles !== 0 || !fenceMatches(reply, config, launch)) fail('local_hook_executor_result_mismatch')
        if (mode === 'verify') {
          if (reply.status !== 'ready' || reply.chain !== 'private-pinned'
            || reply.sandboxMode !== launch.sandboxMode) fail('local_hook_executor_not_ready')
        } else if (reply.status !== 'result' || reply.sessionId !== invocation.sessionId
          || reply.turn !== invocation.turn || reply.handlerId !== invocation.handlerId
          || !['full', 'partial'].includes(reply.facts?.sandboxEnforcement)
          || typeof reply.facts?.aborted !== 'boolean' || typeof reply.facts?.timedOut !== 'boolean'
          || typeof reply.facts?.sandboxDenied !== 'boolean' || !Number.isFinite(reply.durationMs)
          || reply.durationMs < 0 || reply.durationMs > 60000) fail('local_hook_executor_result_mismatch')
        if (failure && failure !== 'local_hook_cancelled') fail(failure)
        resolve(reply)
      } catch (error) { reject(error) }
    })
    if (mode === 'invoke') child.stdin.write(JSON.stringify({ type: 'invoke', ...invocation }) + '\n')
    else child.stdin.end()
    if (signal.aborted) onAbort()
  })
}
