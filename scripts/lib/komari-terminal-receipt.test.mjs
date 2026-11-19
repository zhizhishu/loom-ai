import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalReceipt } from './komari-terminal-receipt.mjs'

const receipt = (exitCode, ok = true) => ({
  status: 'done', task_id: 'owned_job_42', ok,
  results: [{ ok, exit_code: exitCode, output: 'early output is not completion', error: '' }]
})

test('early output without a terminal exit code only permits polling the same job', () => {
  for (const code of [null, undefined]) {
    assert.deepEqual(terminalReceipt(receipt(code)), { state: 'waiting', taskId: 'owned_job_42' })
  }
  assert.deepEqual(terminalReceipt({ status: 'pending', task_id: 'owned_job_42' }),
    { state: 'waiting', taskId: 'owned_job_42' })
})
test('only a confirmed exit zero and successful row count as completion', () => {
  assert.equal(terminalReceipt(receipt(0)).state, 'succeeded')
  assert.equal(terminalReceipt(receipt(1, false)).state, 'failed')
  assert.equal(terminalReceipt(receipt(0, false)).state, 'failed')
  assert.equal(terminalReceipt(receipt('0')).state, 'unconfirmed')
})
test('a different job, missing identity or ambiguous result cannot be adopted', () => {
  assert.equal(terminalReceipt(receipt(0), 'other_job').reason, 'job_identity_changed')
  assert.equal(terminalReceipt({ ...receipt(0), task_id: null }).state, 'unconfirmed')
  assert.equal(terminalReceipt({ ...receipt(0), results: [] }).state, 'unconfirmed')
  assert.equal(terminalReceipt({ ...receipt(0), results: [...receipt(0).results, ...receipt(0).results] }).state, 'unconfirmed')
})
