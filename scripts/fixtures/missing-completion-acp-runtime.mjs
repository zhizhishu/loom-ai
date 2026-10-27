// Synthetic ACP peer: first prompt produces output but never a completion;
// cancellation is deliberately ignored so Core must clean up the owned process.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('GitHub Copilot CLI 1.0.88.\n')
  process.exit(0)
}
const journal = process.argv[process.argv.indexOf('--fixture-journal') + 1]
const textArgument = process.argv.indexOf('--fixture-text')
const unfinishedText = textArgument === -1 ? null : readFileSync(process.argv[textArgument + 1], 'utf8')
const sessionId = `missing-completion-${process.pid}`
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  } else if (['session/new', 'session/load', 'session/resume'].includes(message.method)) {
    send({ id: message.id, result: { sessionId, models: {
      currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture' }]
    }, configOptions: [] } })
  } else if (message.method === 'session/prompt') {
    let previous = []
    try { previous = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    appendFileSync(journal, JSON.stringify({ pid: process.pid, sessionId, prompt: message.params }) + '\n')
    send({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: unfinishedText ?? (previous.length
        ? 'Continuation finished successfully.' : 'Work performed; completion response deliberately missing.') }
    } } })
    if (previous.length && unfinishedText === null) send({ id: message.id, result: { stopReason: 'end_turn' } })
  } else if (message.method !== 'session/cancel' && message.id != null) {
    send({ id: message.id, result: {} })
  }
}
