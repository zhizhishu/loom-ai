import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import askUserQuestion from '../crates/rovai-core/src/pi/adapted/ask-user-question.mjs'

function tool() {
  let definition
  askUserQuestion({ registerTool(value) { definition = value } })
  assert.equal(definition.name, 'ask_user_question')
  return definition
}
const question = { id: 'scope', prompt: 'Which scope?', options: [
  { value: 'first', label: 'Same', description: 'First choice' }, { value: 'second', label: 'Same' }
] }

test('official question defaults, opaque option values and sequential custom answers work over RPC', async () => {
  const calls = []
  const result = await tool().execute('call', { questions: [question, { ...question, id: 'detail', label: 'Details' }] }, undefined, undefined, {
    mode: 'rpc', hasUI: true, ui: {
      async select(title, options) { calls.push([title, options]); return calls.length === 1 ? options[1] : options.at(-1) },
      async input() { return '  Custom text  ' }
    }
  })
  assert.equal(calls[0][0], 'Q1: Which scope?')
  assert.deepEqual(calls[0][1], ['1. Same — First choice', '2. Same', '3. Type something.'])
  assert.deepEqual(result.details.answers, [
    { id: 'scope', value: 'second', label: 'Same', wasCustom: false, index: 2 },
    { id: 'detail', value: 'Custom text', label: 'Custom text', wasCustom: true }
  ])
  assert.equal(result.details.cancelled, false)
  assert.match(result.content[0].text, /Q1: user selected: 2. Same\nDetails: user wrote: Custom text/)
})

test('cancellation, unavailable UI, empty questions, no options and duplicate ids do not invent answers', async () => {
  for (const [questions, hasUI, select, input] of [
    [[question], true, undefined, 'unused'],
    [[question], true, 'other', undefined],
    [[question], false, undefined, undefined],
    [[], true, undefined, undefined],
    [[{ ...question, options: [], allowOther: false }], true, undefined, undefined],
    [[question, question], true, undefined, undefined]
  ]) {
    const result = await tool().execute('call', { questions }, undefined, undefined, {
      hasUI, ui: { async select(_title, options) { return select === 'other' ? options.at(-1) : select }, async input() { return input } }
    })
    assert.equal(result.details.cancelled, true)
    assert.deepEqual(result.details.answers, [])
  }
})

test('allowOther false, blank custom response, partial cancellation and abort preserve semantics', async () => {
  const definition = tool()
  let prompts = 0
  const result = await definition.execute('call', { questions: [
    { ...question, allowOther: false }, { ...question, id: 'next' }
  ] }, undefined, undefined, { hasUI: true, ui: {
    async select(_title, options) { prompts++; if (prompts === 1) { assert.equal(options.length, 2); return options[0] } return undefined }
  } })
  assert.equal(result.details.cancelled, true)
  assert.equal(result.details.answers.length, 1)
  const blank = await definition.execute('call', { questions: [question] }, undefined, undefined, { hasUI: true, ui: {
    async select(_title, options) { return options.at(-1) }, async input() { return ' ' }
  } })
  assert.equal(blank.details.answers[0].value, '(no response)')
  const signal = AbortSignal.abort()
  const aborted = await definition.execute('call', { questions: [question] }, signal, undefined, { hasUI: true, ui: {} })
  assert.equal(aborted.details.cancelled, true)
})

test('question guard delegates all other tools and preserves original guard failures', async () => {
  const source = await readFile(new URL('../crates/rovai-core/src/pi/question-guard.mjs', import.meta.url), 'utf8')
  const registrations = []
  globalThis.__questionGuardFixture = pi => pi.on('tool_call', call => ({ block: true, reason: call.toolName }))
  try {
    const adapted = source.replace("import fileGuard from './rovai-pi-file-guard.ts'", 'const fileGuard = globalThis.__questionGuardFixture')
    const { default: guard } = await import(`data:text/javascript;base64,${Buffer.from(adapted).toString('base64')}`)
    guard({ on(event, callback) { registrations.push([event, callback]) } })
    const handler = registrations[0][1]
    assert.equal(handler({ toolName: 'ask_user_question' }, {}), undefined)
    for (const toolName of ['read', 'write', 'edit', 'bash', 'rovai_loom', 'unknown']) {
      assert.deepEqual(handler({ toolName }, {}), { block: true, reason: toolName })
    }
  } finally { delete globalThis.__questionGuardFixture }
})
