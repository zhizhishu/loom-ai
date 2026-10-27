import assert from 'node:assert/strict'
import test from 'node:test'
import { materializeRegressionFixture } from './context-regression-fixture.mjs'

test('regression history fixture publishes structured messages through current Core send', async () => {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'camp.messages.send') {
      return { commandResult: { status: 'accepted', payload: { messageId: 'message-1' } } }
    }
    if (method === 'memory.create') {
      return { status: 'applied', payload: { memoryId: 'memory-1', revisionId: 'revision-1' } }
    }
    throw new Error(`Unexpected Core method: ${method}`)
  }
  const fixture = {
    campMessages: ['Historical context'],
    memories: [{ body: 'Durable context' }]
  }

  const result = await materializeRegressionFixture(request, fixture, 'camp-1')

  assert.deepEqual(calls.map(call => call.method), ['camp.messages.send', 'memory.create'])
  assert.deepEqual(calls[0].params, {
    commandId: calls[0].params.commandId,
    campId: 'camp-1',
    content: { version: 2, segments: [{ kind: 'text', text: 'Historical context' }] },
    sourceAttachments: [],
    quotes: [],
    replyToCampMessageId: null,
    execution: null
  })
  assert.equal(Object.hasOwn(calls[0].params, 'draftRevision'), false)
  assert.deepEqual(result.entities.map(entity => [entity.kind, entity.id]), [
    ['camp_message', 'message-1'],
    ['memory', 'memory-1']
  ])
})
