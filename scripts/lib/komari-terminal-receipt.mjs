// Acceptance-only interpretation of the native Komari CLI receipt.
// A row can contain early output before it has an exit code; status=done alone
// is therefore not execution completion. Never resubmit a mutating command.
export function terminalReceipt(receipt, expectedTaskId = null) {
  const taskId = receipt?.task_id
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) {
    return { state: 'unconfirmed', reason: 'missing_job_identity', taskId: null }
  }
  if (expectedTaskId !== null && taskId !== expectedTaskId) {
    return { state: 'unconfirmed', reason: 'job_identity_changed', taskId: expectedTaskId }
  }
  if (receipt.status === 'pending') return { state: 'waiting', taskId }
  if (receipt.status !== 'done' || !Array.isArray(receipt.results) || receipt.results.length !== 1) {
    return { state: 'unconfirmed', reason: 'unexpected_result_shape', taskId }
  }
  const row = receipt.results[0]
  if (row.exit_code === null || row.exit_code === undefined) return { state: 'waiting', taskId }
  if (!Number.isInteger(row.exit_code)) return { state: 'unconfirmed', reason: 'invalid_exit_code', taskId }
  if (row.exit_code !== 0 || row.ok !== true) return { state: 'failed', taskId, exitCode: row.exit_code }
  return { state: 'succeeded', taskId, exitCode: 0 }
}
