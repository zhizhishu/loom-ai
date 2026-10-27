import assert from 'node:assert/strict'

// A terminal database is insufficient evidence: validate ownership and exactly-once delivery.
export function assertSteerRaceOutcome({ target, messageId, runs, deliveries, inputs }) {
  assert.equal(deliveries.length, 1)
  const delivery = deliveries[0]
  const owned = inputs.filter(input => input.source_delivery_id === delivery.id ||
    JSON.parse(input.raw_message_refs_json).some(ref => ref.entityId === messageId))
  const accepted = owned.filter(input => input.status === 'accepted')
  const original = runs.find(run => run.id === target)
  assert.ok(original)
  assert.equal(new Set(runs.map(run => run.id)).size, runs.length)
  if (delivery.requested_mode === 'steer') {
    assert.equal(delivery.claimed_agent_run_id, target)
    assert.equal(runs.length, 1, 'a steered or ambiguous input cannot create a successor')
    assert.equal(owned.length, 1)
    assert.equal(owned[0].agent_run_id, target)
    if (owned[0].status === 'delivery_unknown') {
      assert.equal(delivery.status, 'failed')
      assert.equal(delivery.failure_code, 'input_delivery_unknown')
      assert.equal(accepted.length, 0)
      return 'unknown_no_replay'
    }
    assert.equal(delivery.status, 'settled')
    assert.equal(original.status, 'succeeded')
    assert.equal(accepted.length, 1)
    assert.ok(accepted[0].native_input_id, 'original-run runtime receipt required')
    return 'original_run_received'
  }
  assert.equal(delivery.requested_mode, 'start')
  assert.equal(delivery.status, 'settled')
  assert.equal(runs.length, 2)
  assert.equal(original.status, 'succeeded')
  const successor = runs.find(run => run.id !== target)
  assert.equal(successor.status, 'succeeded')
  assert.equal(delivery.claimed_agent_run_id, successor.id)
  assert.equal(accepted.length, 1, 'ordinary fallback is accepted exactly once')
  assert.equal(accepted[0].agent_run_id, successor.id)
  assert.ok(accepted[0].native_input_id)
  const previous = owned.filter(input => input.agent_run_id === target)
  assert.ok(previous.length <= 1)
  assert.ok(previous.every(input => input.status === 'not_accepted'))
  assert.equal(owned.length, previous.length + 1, 'only one ordinary attempt, with no unexplained input')
  return 'ordinary_once'
}
