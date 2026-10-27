import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSteerRaceOutcome } from './steer-race-outcome.mjs'

test('race acceptance distinguishes legal ownership from merely terminal or duplicate outcomes', () => {
  const input = { agent_run_id: 'original', source_delivery_id: 'delivery', raw_message_refs_json: '[{"entityId":"message"}]', status: 'accepted', native_input_id: 'native-original' }
  const base = { target: 'original', messageId: 'message', runs: [{ id: 'original', status: 'succeeded' }], deliveries: [{ id: 'delivery', claimed_agent_run_id: 'original', requested_mode: 'steer', status: 'settled' }], inputs: [input] }
  assert.equal(assertSteerRaceOutcome(base), 'original_run_received')
  const unknown = structuredClone(base)
  unknown.inputs[0].status = 'delivery_unknown'; unknown.inputs[0].native_input_id = null
  Object.assign(unknown.deliveries[0], { status: 'failed', failure_code: 'input_delivery_unknown' })
  assert.equal(assertSteerRaceOutcome(unknown), 'unknown_no_replay')
  const fallback = structuredClone(base)
  fallback.runs.push({ id: 'successor', status: 'succeeded' })
  Object.assign(fallback.deliveries[0], { requested_mode: 'start', claimed_agent_run_id: 'successor' })
  fallback.inputs[0].agent_run_id = 'successor'
  assert.equal(assertSteerRaceOutcome(fallback), 'ordinary_once')
  const unexplained = structuredClone(fallback)
  unexplained.inputs.push({ ...unexplained.inputs[0], status: 'delivery_unknown' })
  assert.throws(() => assertSteerRaceOutcome(unexplained))
  for (const mutate of [
    value => { value.runs[0].status = 'failed' },
    value => { value.inputs[0].agent_run_id = 'successor' },
    value => { value.inputs.push({ ...input }) },
    value => { value.runs.push({ id: 'unexpected', status: 'succeeded' }) },
    value => { value.inputs[0].native_input_id = null },
  ]) {
    const broken = structuredClone(base); mutate(broken)
    assert.throws(() => assertSteerRaceOutcome(broken))
  }
  unknown.runs.push({ id: 'automatic-retry', status: 'succeeded' })
  assert.throws(() => assertSteerRaceOutcome(unknown))
  fallback.inputs.push(input)
  assert.throws(() => assertSteerRaceOutcome(fallback))
})
