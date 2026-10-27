import assert from 'node:assert/strict'
import test from 'node:test'
import { createEvidenceCamp } from './camp-import.mjs'
import { parseProtocolProjectArguments } from './project-pipeline.mjs'

test('Thread import consumes current Core results and publishes evidence without execution', async () => {
  const calls = []
  const core = {
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'threads.create') return { status: 'applied', payload: { threadId: 'thread-1' } }
      if (method === 'thread.messages.send') return { commandResult: { status: 'applied' } }
      if (method === 'threads.snapshot') return {
        thread: { title: 'Review' }, messages: [{}], turns: [], agentRuns: []
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  const result = await createEvidenceCamp({
    core,
    commandPrefix: 'fixture',
    name: 'Review',
    body: 'review',
    projectPath: '/tmp/project',
    members: ['agent_1'],
    defaultLead: 'agent_1'
  })
  assert.deepEqual(result, { threadId: 'thread-1', title: 'Review' })
  assert.deepEqual(calls.map(({ method }) => method), ['threads.create', 'thread.messages.send', 'threads.snapshot'])
  const send = calls.find((entry) => entry.method === 'thread.messages.send')
  assert.equal(send.params.threadId, 'thread-1')
  assert.equal(Object.hasOwn(send.params, 'campId'), false)
  assert.equal(send.params.execution, null)
  assert.equal(calls.some((entry) => entry.method === 'agent.message.send'), false)
})

test('Thread evidence import rejects creation and publication failures and unexpected execution', async () => {
  for (const stage of ['create', 'send', 'execution']) {
    const calls = []
    const core = { async request(method) {
      calls.push(method)
      if (method === 'threads.create') return stage === 'create'
        ? { status: 'rejected', payload: {} }
        : { status: 'applied', payload: { threadId: 'thread-1' } }
      if (method === 'thread.messages.send') return { commandResult: { status: stage === 'send' ? 'rejected' : 'applied' } }
      if (method === 'threads.snapshot') return {
        thread: { title: 'Review' }, messages: [{}], turns: [], agentRuns: [{ id: 'unexpected-run' }]
      }
      throw new Error(`unexpected ${method}`)
    } }
    await assert.rejects(createEvidenceCamp({
      core, commandPrefix: 'fixture', name: 'Review', body: 'review',
      projectPath: '/tmp/project', members: ['agent_1'], defaultLead: 'agent_1'
    }), stage === 'create' ? /creation failed/ : stage === 'send' ? /message failed/ : /unexpectedly created execution/)
    assert.equal(calls.length, stage === 'create' ? 1 : stage === 'send' ? 2 : 3)
  }
})

test('Protocol project defaults to one Review Thread and preserves the legacy trial option', () => {
  const options = parseProtocolProjectArguments(['--run', 'run.json', '--project-path', 'project', '--no-import'])
  assert.equal(options.legacyTrialCamps, false)
})
