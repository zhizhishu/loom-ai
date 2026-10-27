import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function launchHost(binary, args, options = {}) {
  const child = spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const unmatchedResponses = []
  const notifications = new Set()
  let nextId = 1
  let stderr = ''
  let resolveReady; let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { rejectReady(error); resolve({ code: null, error: error.message }) })
    child.once('close', (code) => {
      rejectReady(new Error(`Host stopped (${code}): ${stderr}`))
      for (const request of pending.values()) request.reject(new Error('Host stopped'))
      resolve({ code })
    })
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.kind === 'core_startup' && message.status === 'ready') resolveReady(message)
    if (message.kind === 'core_startup' && ['failed', 'blocked'].includes(message.status)) rejectReady(new Error(message.error?.code ?? 'Core refused'))
    if (message.method) for (const listener of notifications) listener(message)
    if (message.id !== undefined) {
      const request = pending.get(message.id)
      if (!request) { unmatchedResponses.push(message.id); return }
      pending.delete(message.id)
      if (message.error) request.reject(message.error)
      else request.resolve(message.result)
    }
  })
  return {
    onNotification(listener) { notifications.add(listener); return () => notifications.delete(listener) },
    child, ready, closed, unmatchedResponses, stderr: () => stderr,
    async request(method, params = {}) {
      await within(ready)
      const id = nextId++
      try {
        return await within(new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
        }))
      } finally { pending.delete(id) }
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      try { await closed } finally { clearTimeout(timer); lines.close() }
    }
  }
}

export async function within(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Host Web step exceeded 15 seconds')), 15_000)
    })])
  } finally { clearTimeout(timer) }
}
