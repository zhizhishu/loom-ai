// Acceptance-only model substitute. It asks the real DSH ToolRuntime to call
// exactly the named MCP tools, then returns only their actual results. This
// proves native protocol/safety seams without spending provider credits;
// it is not model/provider qualification evidence and never ships in a Host.
import { randomUUID } from 'node:crypto'

export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    const start = options.messages.findLastIndex(message => message.source?.kind === 'user')
    const turn = options.messages.slice(start)
    const results = turn.flatMap(message => message.content ?? []).filter(block => block.type === 'tool-result')
    if (results.length) {
      const text = results.flatMap(result => result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const input = (turn[0]?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    const currentInput = input.match(/\[CURRENT_INPUT\]\s*([\s\S]*?)\s*\[\/CURRENT_INPUT\]/)?.[1]
    const request = currentInput ? JSON.parse(currentInput).message : input
    const calls = [...request.matchAll(/named\s+`?([A-Za-z0-9_-]+)`?[^\n]*?\btext\s+`?([A-Za-z0-9_-]+)/g)]
    if (!calls.length) throw new Error('scripted MCP provider received an unsupported request')
    for (const [index, match] of calls.entries()) {
      const name = `mcp__${match[1]}__echo`
      if (!options.tools.some(tool => tool.name === name)) {
        throw new Error(`scripted MCP provider cannot see requested tool ${name}; visible tools: ${options.tools.map(tool => tool.name).sort().join(', ')}`)
      }
      const id = randomUUID(), args = JSON.stringify({ text: match[2] })
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })
}
