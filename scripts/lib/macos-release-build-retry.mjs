import { spawn } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { MACOS_TICKET_RETRY, isAppleTicketNetworkFailure } from './macos-ticket-retry.mjs'

function executeBuild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8')
      stream.on('data', text => {
        destination.write(text)
        output = (output + text).slice(-256_000)
      })
    }
    child.once('error', reject)
    child.once('close', (status, signal) => resolve({ status, signal, output }))
  })
}

export async function runMacosReleaseBuild(arch, {
  cwd,
  execute = executeBuild,
  wait = pause,
  onRetry = console.warn
} = {}) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Expected architecture arm64|x64')

  for (let attempt = 1; attempt <= MACOS_TICKET_RETRY.attempts; attempt++) {
    const result = await execute('pnpm', ['dist:mac:release:' + arch], { cwd })
    if (result.error) throw result.error
    if (result.status === 0) return
    const output = (result.output ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    const retryable = /Failed to staple your application\b/.test(output)
      && isAppleTicketNetworkFailure(result, output)
    if (!retryable || attempt === MACOS_TICKET_RETRY.attempts) {
      const reason = result.signal ? 'signal ' + result.signal : result.status
      throw new Error('macOS ' + arch + ' release build failed (' + reason + ')')
    }
    const delay = Math.min(attempt * MACOS_TICKET_RETRY.baseDelayMs, MACOS_TICKET_RETRY.maxDelayMs)
    onRetry('electron-builder App stapling: transient Apple network error; retry ' +
      (attempt + 1) + '/' + MACOS_TICKET_RETRY.attempts + ' in ' + delay / 1000 + 's')
    await wait(delay)
  }
}
