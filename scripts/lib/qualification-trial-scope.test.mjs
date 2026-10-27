import assert from 'node:assert/strict'
import test from 'node:test'
import {
  trialAgentDeliveries,
  trialDeliveries,
  trialRootRun,
  trialRuns
} from './qualification-trial-scope.mjs'

test('current batch Trial binds the root message to its claimed Run and excludes fixture history', () => {
  const boundary = { scope: 'isolated_camp_message_batch', rootCampMessageId: 'root' }
  const snapshot = {
    messages: [
      { id: 'fixture', sequence: 1, authorType: 'user' },
      { id: 'root', sequence: 2, authorType: 'user' },
      { id: 'call', sequence: 3, authorType: 'agent' }
    ],
    agentRuns: [
      { id: 'lead', inputMessageIds: ['root'], campTurnId: null },
      { id: 'recipient', inputMessageIds: ['call'], campTurnId: null }
    ],
    messageDeliveries: [
      { id: 'fixture-delivery', messageId: 'fixture', targetAgentRunId: null },
      { id: 'root-delivery', messageId: 'root', targetAgentRunId: 'lead' },
      { id: 'call-delivery', messageId: 'call', targetAgentRunId: 'recipient', deliveryKind: 'public_a2a', dispatchDisposition: 'dispatch' }
    ]
  }

  assert.deepEqual(trialRuns(snapshot, boundary).map(run => run.id), ['lead', 'recipient'])
  assert.deepEqual(trialDeliveries(snapshot, boundary).map(delivery => delivery.id), ['root-delivery', 'call-delivery'])
  assert.deepEqual(trialAgentDeliveries(snapshot, boundary).map(delivery => delivery.id), ['call-delivery'])
  assert.equal(trialRootRun(snapshot, boundary)?.id, 'lead')
  assert.equal(trialRootRun({ ...snapshot, agentRuns: [] }, boundary), null)
})
