// Pure tests only: door schema/parser, explicit-tab discipline, artifact bounds, role picking,
// mission diffing and the post-approval chain gate. Nothing here starts Chrome, a Host or a model.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AB_PY,
  abClick,
  abFill,
  abPython,
  abScreenshot,
  abScript,
  callInvocation,
  doorInvocation,
  openedTabId,
  parseGateRecord,
  readSpooledArtifact,
  summarizeGate
} from './ab-browser.mjs'
import { insideRoot, resolveRequestPath } from './host-web-loopback.mjs'
import { launchHost, within } from './host-test-client.mjs'
import { robustInvocation } from './ab-browser.mjs'
import {
  HOST_CONFIG_ENV,
  LIVE_GATE_ENV,
  chainGate,
  findSecretLeak,
  hostMode,
  liveGate,
  normalizeRoles,
  parseHostConfig,
  pickNewMission,
  resolveAdminToken,
  rosterJs,
  screenshotGate,
  tagChoiceItemJs,
  workerTasks,
  workerIds
} from './loom-browser-live-mode.mjs'

const TOKEN = 'b'.repeat(64)
const okRecord = (data = {}) => JSON.stringify({ schema: 'browser-gate/1', operation: 'call', verdict: 'OK', reason: 'NONE', tab: '1', data, artifact: null, warnings: [] })
const roles = () => normalizeRoles({
  lead: { agentId: 'agent_lead', displayName: 'LOOM UI lead' },
  workerA: { agentId: 'agent_wa', displayName: 'LOOM UI workerA' },
  workerB: { agentId: 'agent_wb', displayName: 'LOOM UI workerB' },
  reviewer: { agentId: 'agent_rev', displayName: 'LOOM UI reviewer' }
})

test('Host fixture timeouts are bounded, explicit and never replay a request', async () => {
  assert.equal(await within(Promise.resolve('receipt'), 100), 'receipt')
  let writes = 0
  const pending = new Promise(() => { writes++ })
  await assert.rejects(within(pending, 10, 'Host request fixture.write'), error =>
    error.code === 'HOST_FIXTURE_TIMEOUT' && error.outcome === 'unconfirmed'
      && error.message.includes('fixture.write'))
  assert.equal(writes, 1)
  for (const invalid of [0, -1, Infinity, 120001, 1.5]) {
    await assert.rejects(within(Promise.resolve(), invalid), RangeError)
    assert.throws(() => launchHost('must-not-spawn', [], { requestTimeoutMs: invalid }), RangeError)
  }
})

test('reactive choices use the installed trusted idempotent pick with an explicit tab', () => {
  const call = robustInvocation('owned-tab', '.choice', 'pick', { env: {}, open: '#trigger', value: 'Reviewer' })
  assert.equal(call.command, 'python')
  assert.match(call.args[0], /agent-browser-cli[\\/]scripts[\\/]robust_action\.py$/u)
  assert.equal(call.args[call.args.indexOf('--tab') + 1], 'owned-tab')
  assert.equal(call.args[call.args.indexOf('--action') + 1], 'pick')
  assert.equal(call.args[call.args.indexOf('--open') + 1], '#trigger')
  for (const forbidden of ['--force', '--js-fallback']) assert.equal(call.args.includes(forbidden), false)
  assert.throws(() => robustInvocation('', '.choice', 'pick'), /explicit tab/u)
  assert.throws(() => robustInvocation('owned', '.choice', 'fill'), /only trusted/u)
})

test('the door replies as browser-gate/1 and nothing else parses', () => {
  assert.equal(parseGateRecord(okRecord()).schema, 'browser-gate/1')
  assert.equal(parseGateRecord('{"schema":"something/2"}'), null)
  assert.equal(parseGateRecord(''), null)
  assert.equal(parseGateRecord('not json'), null)
  assert.equal(parseGateRecord('[]'), null)
})

test('ab.py is python, and every call carries its wrapper budget/max-bytes before the separator', () => {
  const door = doorInvocation('ready', [], { env: {}, budgetSec: 20 })
  assert.equal(door.command, 'python')
  assert.equal(door.command === process.execPath, false)
  assert.deepEqual(door.args, [DEFAULT_AB_PY, 'ready', '--budget', '20'])

  const call = callInvocation(['exec', '--tab', '9', 'return 1'], { env: {}, budgetSec: 15, maxBytes: 1 })
  assert.equal(call.command, 'python')
  assert.deepEqual(call.args.slice(0, 2), [DEFAULT_AB_PY, 'call'])
  assert.ok(call.args.indexOf('--max-bytes') < call.args.indexOf('--'))
  assert.equal(call.args[call.args.indexOf('--max-bytes') + 1], '1')
  assert.deepEqual(call.args.slice(call.args.indexOf('--') + 1), ['exec', '--tab', '9', 'return 1'])

  assert.equal(abPython({ LOOM_AB_PYTHON: 'C:/py/python.exe' }), 'C:/py/python.exe')
  assert.equal(abPython({}), 'python')
  assert.equal(abScript({ LOOM_AB_PY: 'D:/ab.py' }), 'D:/ab.py')
  assert.match(DEFAULT_AB_PY, /agent-browser-cli[\\/]scripts[\\/]ab\.py$/u)
})

test('verdict mapping keeps "unknown" honest and never exposes argv', () => {
  const ok = summarizeGate(JSON.parse(okRecord({ opened_tab_id: '123' })), false)
  assert.equal(ok.ok, true)
  assert.equal(ok.reason, 'NONE')
  const failed = summarizeGate(JSON.parse('{"schema":"browser-gate/1","verdict":"FAILED","reason":"ELEMENT_NOT_FOUND","data":{}}'), false)
  assert.equal(failed.ok, false)
  assert.equal(failed.unconfirmed, false)
  const unknown = summarizeGate(JSON.parse('{"schema":"browser-gate/1","verdict":"UNKNOWN","reason":"DEBUGGER_BUSY","data":{}}'), false)
  assert.equal(unknown.unconfirmed, true)
  assert.equal(summarizeGate(null, true).reason, 'TIMEOUT_UNCONFIRMED')
  assert.equal(summarizeGate(null, true).unconfirmed, true)
  assert.equal(summarizeGate(null, false).reason, 'INVALID_CLI_RESPONSE')
  for (const key of ['args', 'argv', 'cliArgs', 'command']) assert.equal(key in ok, false)
  assert.equal(JSON.stringify(summarizeGate(JSON.parse(okRecord()), false)).includes(TOKEN), false)
})

test('a missing opened tab id is never replaced by adopting another tab', () => {
  assert.equal(openedTabId({ opened_tab_id: '123456' }), '123456')
  assert.equal(openedTabId({}), null)
  assert.equal(openedTabId({ tab_id: '123' }), null)
  assert.equal(openedTabId({ tab_list: [{ id: '123', url: 'http://127.0.0.1:1/' }] }), null)
  assert.equal(openedTabId({ opened_tab_id: 'not a tab id / x' }), null)
})

test('every mutating verb refuses to run without an explicit tab id', async () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => abClick(bad, '.ln-control'), /explicit tab id is required/u)
    assert.throws(() => abFill(bad, '#administrator-token', TOKEN), /explicit tab id is required/u)
    await assert.rejects(() => abScreenshot(bad, 'C:/tmp/x.png'), /explicit tab id is required/u)
  }
})

test('a spooled artifact is read only inside the door artifact root and only as small JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ab-artifacts-'))
  const sharedRoot = join(tmpdir(), 'abcli-artifacts')
  await mkdir(sharedRoot, { recursive: true })
  const inside = await mkdtemp(join(sharedRoot, 'loom-accept-test-'))
  t.after(async () => {
    await rm(inside, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
  const file = join(inside, 'ok.json')
  await writeFile(file, JSON.stringify({ ok: true, result: { js_return: { tasks: 2 } } }))
  assert.equal((await readSpooledArtifact({ path: file })).ok, true)
  assert.deepEqual((await readSpooledArtifact({ path: file })).json.result.js_return, { tasks: 2 })
  assert.equal((await readSpooledArtifact({ path: join(root, 'outside.json') })).reason, 'ARTIFACT_OUTSIDE_ROOT')
  const lookalike = join(root, 'abcli-artifacts', 'forged.json')
  await mkdir(join(root, 'abcli-artifacts'))
  await writeFile(lookalike, JSON.stringify({ ok: true, result: { js_return: 'untrusted' } }))
  assert.equal((await readSpooledArtifact({ path: lookalike })).reason, 'ARTIFACT_OUTSIDE_ROOT')
  assert.equal((await readSpooledArtifact({ path: inside })).reason, 'ARTIFACT_NOT_FILE')
  assert.equal((await readSpooledArtifact({ path: join(inside, 'missing.json') })).reason, 'ARTIFACT_MISSING')
  assert.equal((await readSpooledArtifact({ path: 'relative.json' })).reason, 'ARTIFACT_PATH_INVALID')
})

test('static server refuses traversal, dot segments and NUL bytes', () => {
  const root = process.platform === 'win32' ? 'C:\\fixture\\renderer' : '/fixture/renderer'
  assert.equal(resolveRequestPath(root, '/index.html').status, 'file')
  assert.equal(resolveRequestPath(root, '/../../secret.txt').status, 'rejected')
  assert.equal(resolveRequestPath(root, '/.git/config').status, 'rejected')
  assert.equal(resolveRequestPath(root, '/a%00b').status, 'rejected')
  assert.equal(resolveRequestPath(root, 'relative.js').status, 'rejected')
  assert.equal(resolveRequestPath(root, '/%2e%2e/b').status, 'rejected')
  assert.equal(resolveRequestPath(root, '/a..b.js').status, 'file')
  assert.equal(insideRoot(root, join(root, 'a', 'b.js')), true)
  assert.equal(insideRoot(root, join(root, '..', 'outside.js')), false)
})

test('live acceptance stays off and the host config must name all four roles', () => {
  assert.equal(liveGate({}).allowed, false)
  assert.equal(liveGate({ [LIVE_GATE_ENV]: '1' }).allowed, true)
  assert.equal(hostMode({}), 'self')
  assert.equal(hostMode({ [HOST_CONFIG_ENV]: '{"origin":"http://127.0.0.1:9"}' }), 'external')
  assert.throws(() => normalizeRoles({ lead: { agentId: 'a', displayName: 'A' } }), /workerA is required/u)
  assert.throws(() => normalizeRoles({ lead: 'agent_x', workerA: 'agent_a', workerB: 'agent_b', reviewer: 'agent_c' }), /displayName is required/u)
  assert.throws(() => parseHostConfig({ origin: 'http://example.com/' }), /loopback/u)
  assert.throws(() => parseHostConfig({ origin: 'http://127.0.0.1:0', memberAgentIds: roles() }), /loopback/u)
  assert.throws(() => parseHostConfig({ origin: 'http://127.0.0.1:65536', memberAgentIds: roles() }), /loopback/u)
  assert.throws(() => parseHostConfig({ origin: 'http://127.0.0.1:1' }), /all four roles/u)
  assert.throws(() => parseHostConfig({ origin: 'http://127.0.0.1:1', uiDirectory: 'rel/ui' }), /absolute path/u)
  const parsed = parseHostConfig({ origin: 'http://127.0.0.1:1', memberAgentIds: roles() })
  assert.deepEqual(workerIds(parsed.roles), ['agent_wa', 'agent_wb'])
})

test('the new mission is identified by a one-row diff, never by recency', () => {
  assert.deepEqual(pickNewMission([{ missionId: 'old' }], [{ missionId: 'old' }, { missionId: 'new' }]).missionId, 'new')
  assert.equal(pickNewMission([], []).reason, 'no_new_mission')
  assert.equal(pickNewMission([], [{ missionId: 'a' }, { missionId: 'b' }]).missionId, null)
  assert.equal(pickNewMission([], [{ missionId: 'a' }, { missionId: 'b' }]).reason, 'ambiguous_new_missions:2')
})

test('only the two worker-owned tasks may enter the scope', () => {
  const r = roles()
  const tasks = [
    { taskId: 't-lead', assigneeAgentId: r.lead.agentId },
    { taskId: 't-a', assigneeAgentId: r.workerA.agentId },
    { taskId: 't-b', assigneeAgentId: r.workerB.agentId }
  ]
  const picked = workerTasks(tasks, r)
  assert.equal(picked.complete, true)
  assert.deepEqual(picked.tasks.map(task => task.taskId), ['t-a', 't-b'])
  assert.equal(workerTasks([tasks[1]], r).complete, false)
  assert.match(workerTasks([tasks[1]], r).reason, /worker_tasks:1/u)
})

test('the post-approval chain gate fails closed on every missing fact', () => {
  assert.equal(chainGate({}).ok, false)
  assert.ok(chainGate({}).reasons.includes('no_execute_dispatch'))
  const settled = [
    { kind: 'execute', status: 'settled' }, { kind: 'review', status: 'settled' }, { kind: 'rework', status: 'settled' }
  ]
  const pending = [{ acceptanceStatus: 'pending' }, { acceptanceStatus: 'pending' }]
  const archiveOk = [{ ok: true, reasons: [] }]
  assert.equal(chainGate({ dispatches: settled, candidates: pending, archiveChecks: archiveOk }).ok, true)
  assert.ok(chainGate({ dispatches: [{ kind: 'execute', status: 'dispatched' }], candidates: pending }).reasons.includes('dispatch_not_settled'))
  assert.ok(chainGate({ dispatches: settled, candidates: [{ acceptanceStatus: 'accepted' }] }).reasons.includes('candidate_not_pending'))
  assert.ok(chainGate({ dispatches: settled, candidates: pending, archiveChecks: [{ ok: false, reasons: ['archive_sha256_mismatch'] }] }).reasons.some(reason => reason.startsWith('archive_failed')))
})

test('a missing screenshot is a gate failure, and page helpers never synthesise clicks', () => {
  assert.equal(screenshotGate({ verified: false, reason: 'SCREENSHOT_MISSING' }).ok, false)
  assert.equal(screenshotGate({ verified: true, bytes: 0 }).ok, false)
  assert.equal(screenshotGate({ verified: true, bytes: 12 }).ok, true)
  for (const expression of [rosterJs(), tagChoiceItemJs('reviewer-choice', 'LOOM UI reviewer')]) {
    assert.equal(/\.click\(/u.test(expression), false)
    assert.equal(/dispatchEvent/u.test(expression), false)
  }
})

test('the administrator token only arrives by process reference or Host-written file', () => {
  assert.deepEqual(resolveAdminToken({}), { kind: 'none', name: null })
  assert.deepEqual(resolveAdminToken({ LOOM_ADMIN_TOKEN_ENV: 'ISOLATED_ADMIN_TOKEN', ISOLATED_ADMIN_TOKEN: TOKEN }),
    { kind: 'env', name: 'ISOLATED_ADMIN_TOKEN', value: TOKEN })
  assert.throws(() => resolveAdminToken({ LOOM_ADMIN_TOKEN_ENV: 'ISOLATED_ADMIN_TOKEN' }), /which is empty/u)
  assert.deepEqual(resolveAdminToken({ LOOM_ADMIN_TOKEN_FILE: 'C:/isolated/admin.token' }).kind, 'file')
  assert.equal(findSecretLeak(`report {"token":"${TOKEN}"}`, [TOKEN]).length, 1)
  assert.deepEqual(findSecretLeak('{"state":"approved"}', [TOKEN]), [])
})
