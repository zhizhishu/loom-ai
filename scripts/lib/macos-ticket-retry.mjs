import { spawnSync } from 'node:child_process'

export const MACOS_TICKET_RETRY = Object.freeze({
  attempts: 6,
  baseDelayMs: 20_000,
  maxDelayMs: 60_000
})

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function isAppleTicketNetworkFailure(result, output) {
  return result.status !== 0 && !result.error && !result.signal
    && /(?:NSURLErrorDomain|kCFErrorDomainCFNetwork)\s+Code=-100[134569]\b/.test(output)
}

export function runMacosTicket(action, target, {
  cwd,
  execute = spawnSync,
  pause = pauseSync,
  onRetry = console.warn
} = {}) {
  if (!['staple', 'validate'].includes(action) || typeof target !== 'string' || !target) {
    throw new Error('Expected stapler action staple|validate and a target path')
  }

  for (let attempt = 1; attempt <= MACOS_TICKET_RETRY.attempts; attempt++) {
    const result = execute('/usr/bin/xcrun', ['stapler', action, target], {
      cwd,
      encoding: 'utf8'
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    if (result.error) throw result.error
    if (result.status === 0) return output
    if (attempt === MACOS_TICKET_RETRY.attempts || !isAppleTicketNetworkFailure(result, output)) {
      const reason = result.signal ? `signal ${result.signal}` : result.status
      throw new Error(`xcrun stapler ${action} failed (${reason}): ${output}`)
    }

    const delay = Math.min(
      attempt * MACOS_TICKET_RETRY.baseDelayMs,
      MACOS_TICKET_RETRY.maxDelayMs
    )
    onRetry(`stapler ${action}: transient Apple network error; retry ${attempt + 1}/${MACOS_TICKET_RETRY.attempts} in ${delay / 1000}s`)
    pause(delay)
  }
}
