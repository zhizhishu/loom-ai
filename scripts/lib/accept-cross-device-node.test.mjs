// Unit tests for the two-machine device acceptance helpers.
//
// Boundary: nothing here starts a host, a node, a Runtime or a model, and
// nothing here simulates a remote answer. Every assertion below is a pure
// decision over explicit inputs plus one local temp directory for the evidence
// writer. A passing suite says the script refuses bad input and refuses to
// over-claim; it says nothing about a real pair of machines.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runStatus } from '../accept-cross-device-node.mjs'
import {
  DEFAULT_TIMEOUT_MS,
  EVIDENCE_FILES,
  EVIDENCE_VERSION,
  EvidenceWriter,
  HOST_WEB_PROTOCOL_VERSION,
  RUNTIME_KINDS,
  UsageError,
  assertNoSecrets,
  assertSafeRelative,
  checkReturnedBytes,
  classifyHostError,
  execAttemptPolicy,
  findSecret,
  formatPlan,
  nodeById,
  normalizeEndpoint,
  normalizeServer,
  pairingVerdict,
  parseArguments,
  parseNodeCredential,
  parseToken,
  remoteNodeIds,
  runtimeAdvertisement,
  sanitizeEvidence,
  sha256Hex,
  workspaceMatches,
  writeSecretFile
} from './accept-cross-device-node.mjs'

const CONNECT = '/api/v1/nodes/connect'
const TOKEN = 'a'.repeat(64)
const CODE = 'deadbeefdeadbeef'

const hostArgs = (extra = []) => [
  'host-prepare',
  '--endpoint', 'http://127.0.0.1:18767',
  '--token-file', '/fixture/server-token',
  '--evidence', '/fixture/evidence',
  '--pair-code-out', '/fixture/evidence/pair-code.secret',
  ...extra
]

const verifyArgs = (extra = []) => [
  'verify',
  '--endpoint', 'http://127.0.0.1:18767',
  '--token-file', '/fixture/server-token',
  '--evidence', '/fixture/evidence',
  '--mission', 'rvm_01a1e45ee315770297306674f2f7df39',
  '--probe-relative', 'docs/readme.md',
  '--expect-node-id', 'node_a',
  ...extra
]

/* --------------------------------------------------------------- arguments */

test('an unknown stage or flag is refused', () => {
  assert.throws(() => parseArguments([]), error => error.code === 'usage')
  assert.throws(() => parseArguments(['pair-node']), error => error.code === 'usage')
  assert.throws(() => parseArguments([...hostArgs(), '--force']), error => error.code === 'usage')
})

test('a host stage needs exactly one token source', () => {
  const args = hostArgs().filter((value, index, all) => value !== '--token-file' && all[index - 1] !== '--token-file')
  assert.throws(() => parseArguments(args), error => error.code === 'usage')
  assert.throws(() => parseArguments([...hostArgs(), '--token-stdin']), error => error.code === 'usage')
  assert.equal(parseArguments(hostArgs()).tokenFile, '/fixture/server-token')
})

test('the pairing code is only written to a private file, never printed', () => {
  const args = hostArgs().filter((value, index, all) => value !== '--pair-code-out' && all[index - 1] !== '--pair-code-out')
  assert.throws(
    () => parseArguments(args),
    error => error.code === 'pairing-code' && /never printed/u.test(error.message)
  )
})

test('node-pair accepts a code from stdin xor an environment variable', () => {
  const base = ['node-pair', '--node-bin', '/fixture/loom-node', '--node-root', '/fixture/node', '--server', `ws://127.0.0.1:18767${CONNECT}`, '--evidence', '/fixture/evidence']
  assert.throws(() => parseArguments(base), error => error.code === 'usage')
  assert.equal(parseArguments([...base, '--pair-code-stdin']).pairCodeStdin, true)
  assert.equal(parseArguments([...base, '--pair-code-env', 'LOOM_PAIR_CODE']).pairCodeEnv, 'LOOM_PAIR_CODE')
  assert.throws(
    () => parseArguments([...base, '--pair-code-stdin', '--pair-code-env', 'LOOM_PAIR_CODE']),
    error => error.code === 'usage'
  )
})

test('the endpoint is a bare origin without credentials, query or fragment', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:18767/'), 'http://127.0.0.1:18767')
  assert.equal(normalizeEndpoint('https://loom.example'), 'https://loom.example')
  for (const value of ['ftp://127.0.0.1', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/?a=1', 'http://127.0.0.1/#x']) {
    assert.throws(() => normalizeEndpoint(value), error => error.code === 'usage')
  }
})

test('plaintext ws is refused off loopback and the connect path is required', () => {
  assert.equal(normalizeServer(`ws://127.0.0.1:18767${CONNECT}`), `ws://127.0.0.1:18767${CONNECT}`)
  assert.equal(normalizeServer(`ws://localhost:1${CONNECT}`), `ws://localhost:1${CONNECT}`)
  assert.equal(normalizeServer(`wss://loom.example${CONNECT}`), `wss://loom.example${CONNECT}`)
  assert.throws(() => normalizeServer(`ws://10.0.0.5:18767${CONNECT}`), error => error.code === 'usage')
  assert.throws(() => normalizeServer('wss://loom.example/api/v1/nodes'), error => error.code === 'usage')
  assert.throws(() => normalizeServer(`http://127.0.0.1:18767${CONNECT}`), error => error.code === 'usage')
})

test('a probe path must stay relative and inside the worktree', () => {
  assert.equal(assertSafeRelative('docs/readme.md'), 'docs/readme.md')
  assert.equal(assertSafeRelative(''), '')
  for (const value of ['../outside', '/etc/passwd', 'C:/Windows', 'docs\\readme.md', 'docs//x', 'docs/./x', 'a\u0000b']) {
    assert.throws(() => assertSafeRelative(value), error => error.code === 'path_rejected', value)
  }
})

test('scope ids and digests are bounded before any request', () => {
  assert.throws(() => parseArguments([...verifyArgs(), '--expect-node-id', 'x'.repeat(81)]), error => error.code === 'usage')
  assert.throws(() => parseArguments([...verifyArgs(), '--expected-sha256', 'A'.repeat(64)]), error => error.code === 'usage')
  assert.throws(() => parseArguments([...verifyArgs(), '--expected-sha256', 'a'.repeat(63)]), error => error.code === 'usage')
  const ok = parseArguments([...verifyArgs(), '--expected-sha256', 'b'.repeat(64)])
  assert.equal(ok.expectedSha256, 'b'.repeat(64))
  assert.equal(ok.stage, 'verify')
  assert.equal(ok.relative, 'docs/readme.md')
  assert.equal(ok.expectNodeId, 'node_a')
})

test('verify requires a mission, a probe path and the expected node', () => {
  const without = (flag) => verifyArgs().filter((value, index, all) => value !== flag && all[index - 1] !== flag)
  assert.throws(() => parseArguments(without('--mission')), error => error.code === 'usage')
  assert.throws(() => parseArguments(without('--probe-relative')), error => error.code === 'usage')
  assert.throws(() => parseArguments(without('--expect-node-id')), error => error.code === 'usage')
})

test('the runtime flag is the closed four-runtime set', () => {
  assert.deepEqual([...RUNTIME_KINDS], ['pi', 'deepseek-harness', 'codex-cli', 'claude-code-cli'])
  for (const kind of RUNTIME_KINDS) {
    assert.deepEqual(parseArguments([...verifyArgs(), '--require-runtime', kind]).requireRuntimes, [kind])
  }
  assert.throws(() => parseArguments([...verifyArgs(), '--require-runtime', 'opencode-cli']), error => error.code === 'usage')
  assert.throws(() => parseArguments([...verifyArgs(), '--exec-runtime', 'pi']), error => error.code === 'usage')
  assert.equal(parseArguments([...verifyArgs(), '--exec-runtime', 'codex-cli', '--exec-cwd', '/fixture']).execCwd, '/fixture')
  const withArgs = parseArguments([
    ...verifyArgs(), '--exec-runtime', 'codex-cli', '--exec-cwd', '/fixture',
    '--exec-arg=--version', '--exec-arg', 'plain'
  ])
  assert.deepEqual(withArgs.execArgs, ['--version', 'plain'])
  assert.deepEqual(parseArguments(verifyArgs()).execArgs, undefined)
  // A space-separated value starting with -- stays refused so a typo cannot eat a flag.
  assert.throws(
    () => parseArguments([...verifyArgs(), '--exec-runtime', 'codex-cli', '--exec-cwd', '/fixture', '--exec-arg', '--version']),
    error => error.code === 'usage' && /--exec-arg=<value>/u.test(error.message)
  )
})

test('the node timeout stays bounded', () => {
  const base = ['node-pair', '--node-bin', '/fixture/loom-node', '--node-root', '/fixture/node', '--server', `ws://127.0.0.1:1${CONNECT}`, '--evidence', '/fixture/evidence', '--pair-code-stdin']
  assert.equal(parseArguments(base).timeoutMs, DEFAULT_TIMEOUT_MS)
  assert.equal(parseArguments([...base, '--timeout-ms', '3000']).timeoutMs, 3000)
  assert.throws(() => parseArguments([...base, '--timeout-ms', '10']), error => error.code === 'usage')
  assert.throws(() => parseArguments([...base, '--timeout-ms', '900001']), error => error.code === 'usage')
})

/* ----------------------------------------------------------------- secrets */

test('evidence redaction removes a secret wherever it appears', () => {
  const secrets = [CODE, TOKEN]
  const input = {
    note: `code ${CODE} leaked`,
    nested: [{ header: `Bearer ${TOKEN}` }],
    [CODE]: 'as a key',
    keep: 'ordinary text'
  }
  const cleaned = sanitizeEvidence(input, secrets)
  assert.equal(findSecret(cleaned, secrets), null)
  assert.equal(cleaned.note, 'code <redacted> leaked')
  assert.equal(cleaned.nested[0].header, 'Bearer <redacted>')
  assert.equal(cleaned.keep, 'ordinary text')
  assert.throws(() => assertNoSecrets(input, secrets), error => error.code === 'secret_leak')
  assert.doesNotThrow(() => assertNoSecrets(cleaned, secrets))
})

test('redaction is not fooled by a secret split across nested values', () => {
  const secrets = [CODE]
  const cleaned = sanitizeEvidence({ a: { b: [{ c: CODE }] } }, secrets)
  assert.equal(findSecret(cleaned, secrets), null)
  assert.equal(findSecret({ a: { b: [{ c: `x${CODE}y` }] } }, secrets), CODE)
})

test('a token is 64 hex, optionally behind token=', () => {
  assert.equal(parseToken(TOKEN), TOKEN)
  assert.equal(parseToken(`token=${TOKEN}\n`), TOKEN)
  assert.throws(() => parseToken('a'.repeat(63)), error => error.code === 'token')
  assert.throws(() => parseToken('not-a-token'), error => error.code === 'token')
})

test('a node credential is validated and never exposes its token', () => {
  const valid = JSON.stringify({ version: 1, nodeId: 'node_abc', token: TOKEN, server: `ws://127.0.0.1:1${CONNECT}` })
  const parsed = parseNodeCredential(valid)
  assert.deepEqual(Object.keys(parsed).sort(), ['nodeId', 'server'])
  assert.equal(parsed.nodeId, 'node_abc')
  assert.equal(JSON.stringify(parsed).includes(TOKEN), false)
  assert.throws(() => parseNodeCredential('{'), error => error.code === 'node_credential')
  assert.throws(() => parseNodeCredential(JSON.stringify({ version: 2, nodeId: 'a', token: TOKEN, server: 'ws://x' })), error => error.code === 'node_credential')
  assert.throws(() => parseNodeCredential(JSON.stringify({ version: 1, nodeId: '', token: TOKEN, server: 'ws://x' })), error => error.code === 'node_credential')
  assert.throws(() => parseNodeCredential(JSON.stringify({ version: 1, nodeId: 'a', token: 'short', server: 'ws://x' })), error => error.code === 'node_credential')
})

test('a private code file is written with owner-only permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-cross-secret-'))
  try {
    const path = join(root, 'nested', 'pair-code.secret')
    writeSecretFile(path, CODE)
    assert.equal(readFileSync(path, 'utf8'), `${CODE}\n`)
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------- host answers */

test('the node list projection finds one node and its remote ids', () => {
  const list = { nodes: [{ nodeId: 'local_1', role: 'local' }, { nodeId: 'node_a', role: 'remote', status: 'online' }] }
  assert.equal(nodeById(list, 'node_a').role, 'remote')
  assert.equal(nodeById(list, 'missing'), null)
  assert.deepEqual(remoteNodeIds(list), ['node_a'])
  assert.deepEqual(remoteNodeIds({}), [])
})

test('a runtime advertisement never claims a load or a call', () => {
  const node = {
    clis: [
      { adapterKind: 'codex-cli', pathPresent: true, availability: 'available', version: '1.2.3' },
      { adapterKind: 'pi', pathPresent: false, availability: 'unreported', version: null }
    ]
  }
  const result = runtimeAdvertisement(node, RUNTIME_KINDS)
  assert.equal(result.length, 4)
  const codex = result.find(entry => entry.adapterKind === 'codex-cli')
  assert.equal(codex.verdict, 'ADVERTISED')
  assert.equal(codex.evidenceKind, 'advertisement-only')
  assert.equal(result.find(entry => entry.adapterKind === 'pi').verdict, 'ADVERTISED')
  assert.equal(result.find(entry => entry.adapterKind === 'deepseek-harness').verdict, 'MISSING')
  assert.equal(JSON.stringify(result).includes('INVOKED'), false)
})

test('a pairing needs a distinct node that is online, not an older row', () => {
  const online = { nodes: [{ nodeId: 'node_a', role: 'remote', status: 'online' }] }
  assert.equal(pairingVerdict({ nodeId: 'node_a', baselineRemoteNodeIds: [], nodeList: online }).status, 'PASS')
  assert.equal(pairingVerdict({ nodeId: 'node_a', baselineRemoteNodeIds: ['node_a'], nodeList: online }).reason, 'node_existed_before_pairing')
  assert.equal(pairingVerdict({ nodeId: 'local_1', baselineRemoteNodeIds: [], nodeList: { nodes: [{ nodeId: 'local_1', role: 'local', status: 'online' }] } }).reason, 'role_is_local')
  assert.equal(pairingVerdict({ nodeId: 'gone', baselineRemoteNodeIds: [], nodeList: online }).reason, 'node_not_listed')
  assert.equal(
    pairingVerdict({ nodeId: 'node_a', baselineRemoteNodeIds: [], nodeList: { nodes: [{ nodeId: 'node_a', role: 'remote', status: 'offline' }] } }).reason,
    'status_is_offline'
  )
  // A re-listed older row is never counted as this run's pairing.
  const relisted = pairingVerdict({ nodeId: 'node_a', baselineRemoteNodeIds: ['node_a', 'node_b'], nodeList: online })
  assert.equal(relisted.status, 'FAIL')
})

test('a workspace is only ours when the host bound it to the requested node', () => {
  const requested = { missionId: 'm1', campId: 'c1', nodeId: 'node_a', source: '/srv/repo' }
  const returned = { missionId: 'm1', campId: 'c1', nodeId: 'node_a', worktree: '/home/n/wt', baseSha: 'c'.repeat(40) }
  assert.equal(workspaceMatches({ requested, returned }).status, 'PASS')
  const adopted = workspaceMatches({ requested, returned: { ...returned, nodeId: 'node_b' } })
  assert.equal(adopted.status, 'FAIL')
  assert.deepEqual(adopted.reasons, ['node_mismatch'])
  assert.deepEqual(workspaceMatches({ requested, returned: { ...returned, baseSha: '' } }).reasons, ['base_sha_empty'])
  assert.deepEqual(workspaceMatches({ requested, returned: { ...returned, missionId: 'other' } }).reasons, ['mission_mismatch'])
})

/* ---------------------------------------------------------------- byte proof */

test('returned bytes only pass against an independent hash', () => {
  const bytes = Buffer.from('hello from the node\n')
  const digest = sha256Hex(bytes)
  const pass = checkReturnedBytes({ bytes, truncated: false, archivedSize: bytes.length, expectedSha256: digest })
  assert.equal(pass.status, 'PASS')
  assert.equal(pass.sha256, digest)
  assert.equal(pass.sizeBytes, bytes.length)

  const noGroundTruth = checkReturnedBytes({ bytes, truncated: false, archivedSize: bytes.length })
  assert.equal(noGroundTruth.status, 'NOT_RUN')
  assert.deepEqual(noGroundTruth.reasons, ['no_independent_ground_truth_on_node'])

  assert.equal(checkReturnedBytes({ bytes, truncated: true, expectedSha256: digest }).status, 'FAIL')
  assert.equal(checkReturnedBytes({ bytes, truncated: false, expectedSha256: 'd'.repeat(64) }).status, 'FAIL')
  assert.equal(checkReturnedBytes({ bytes, truncated: false, archivedSize: 1, expectedSha256: digest }).status, 'FAIL')
  assert.equal(checkReturnedBytes({ bytes, truncated: false, expectedSha256: digest, expectedSizeBytes: 2 }).status, 'FAIL')
})

test('an oversized read is never a whole-file proof', () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1)
  const result = checkReturnedBytes({ bytes, truncated: false, expectedSha256: sha256Hex(bytes) })
  assert.equal(result.status, 'FAIL')
  assert.ok(result.reasons.includes('over_read_cap'))
})

/* --------------------------------------------------------- failure classes */

test('an offline host and a pre-dispatch failure stay distinguishable', () => {
  const offline = classifyHostError({ code: 'node_offline', status: 409 })
  assert.equal(offline.nodeOffline, true)
  assert.equal(offline.unknownOutcome, false)
  assert.ok(offline.remedy.includes('start the same node again'))

  const loopback = classifyHostError({ code: 'node_channel_requires_loopback', status: 403 })
  assert.equal(loopback.loopbackRequired, true)
  assert.ok(loopback.remedy.includes('loopback'))

  assert.equal(classifyHostError({ code: 'host_unreachable', status: 0 }).unknownOutcome, true)
  assert.equal(classifyHostError({ code: 'internal', status: 503 }).unknownOutcome, true)
  assert.equal(classifyHostError({ code: 'path_rejected', status: 400 }).unknownOutcome, false)
  assert.equal(classifyHostError({ code: 'path_rejected', status: 400 }).nodeOffline, false)
})

test('a dispatch is attempted once and an unknown outcome is never repeated', () => {
  assert.deepEqual(execAttemptPolicy({ attempts: 1 }), { attempts: 1, retryAllowed: false })
  assert.throws(() => execAttemptPolicy({ attempts: 2 }), error => error.code === 'no_retry')
})

/* ----------------------------------------------------------------- evidencing */

test('the evidence writer refuses to persist a secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-cross-evidence-'))
  try {
    const writer = new EvidenceWriter(join(root, 'evidence'), [CODE, TOKEN])
    const path = writer.write('probe.json', { stage: 'probe', echo: `code ${CODE}` })
    const written = readFileSync(path, 'utf8')
    assert.equal(written.includes(CODE), false)
    assert.equal(written.includes(TOKEN), false)
    const parsed = JSON.parse(written)
    assert.equal(parsed.version, EVIDENCE_VERSION)
    assert.equal(parsed.script, 'accept-cross-device-node')
    assert.equal(parsed.echo, 'code <redacted>')

    // A secret used as a key is scrubbed too, so the gate never has to fire.
    const keyed = writer.write('keyed.json', { [`${CODE}`]: 1 })
    assert.equal(readFileSync(keyed, 'utf8').includes(CODE), false)
    assert.equal(writer.read('missing.json'), null)
    // `write` redacts first and then asserts; the assertion itself is proven
    // directly above by `assertNoSecrets(input, secrets)` throwing.
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the evidence files are named per stage and phase', () => {
  assert.deepEqual(Object.keys(EVIDENCE_FILES).sort(), [
    'host-prepare', 'node-pair', 'offline', 'online', 'reconnect', 'workspace-prepare'
  ])
  assert.equal(EVIDENCE_FILES.online, 'verify-online.json')
})

test('the plan needs the explicit host data root that it renders', () => {
  const base = [
    'plan',
    '--endpoint', 'http://127.0.0.1:18767',
    '--node-bin', '/fixture/bin/loom-node.exe',
    '--node-root', '/fixture/node-root',
    '--server', `ws://127.0.0.1:18767${CONNECT}`,
    '--evidence', '/fixture/evidence'
  ]
  assert.throws(() => parseArguments(base), error => error.code === 'usage')
  const planned = parseArguments([...base, '--host-data-root', '/fixture/host-root'])
  assert.equal(planned.hostDataRoot, '/fixture/host-root')
})

test('the plan uses the verified command shapes and never a real code', () => {
  const text = formatPlan({
    endpoint: 'http://127.0.0.1:18767',
    nodeBin: '/fixture/bin/loom-node.exe',
    nodeRoot: '/fixture/node-root',
    server: `ws://127.0.0.1:18767${CONNECT}`,
    evidence: '/fixture/evidence',
    hostDataRoot: '/fixture/host-root'
  })
  // The exact flag shapes of `rovai-server` (crates/rovai-host/src/server.rs).
  assert.ok(text.includes('rovai-server node-pair --data-dir /fixture/host-root'))
  assert.ok(text.includes('rovai-server workspace-prepare --data-dir /fixture/host-root --mission'))
  assert.ok(text.includes('workspace-files --data-dir /fixture/host-root --mission <mission> read'))
  assert.ok(text.includes('--token-file /fixture/host-root/server-token'))
  assert.ok(text.includes('--pair-code-stdin'))
  assert.ok(text.includes(`--server ws://127.0.0.1:18767${CONNECT}`))
  assert.ok(text.includes('node_channel_requires_loopback'))
  assert.ok(text.includes('never claimed by this plan'))
  assert.ok(text.includes('R2 archive receipt'))
  assert.equal(text.includes(CODE), false)
  // No stage may promise a Runtime load or a call.
  assert.equal(/Runtime Loaded\/Invoked: PASS/u.test(text), false)
})

test('the host web protocol version matches the current contract', () => {
  assert.equal(HOST_WEB_PROTOCOL_VERSION, 5)
})

test('status is an offline rollup: an empty evidence directory is NOT_RUN, never PASS', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-cross-status-'))
  try {
    const code = runStatus({ evidence: join(root, 'evidence') })
    assert.equal(code, 3, 'required slices unfinished must not exit 0')
    const summary = JSON.parse(readFileSync(join(root, 'evidence', 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'NOT_RUN')
    assert.equal(summary.counts.pass, 0)
    assert.equal(summary.counts.fail, 0)
    assert.ok(summary.slices.every(entry => entry.status === 'NOT_RUN'))
    assert.ok(summary.slices.some(entry => entry.slice.includes('R2 archive receipt')))
    assert.ok(summary.slices.some(entry => entry.slice.includes('Runtime Loaded/Invoked')))
    // Nothing in an empty rollup may read as a real device result.
    assert.ok(summary.counts.requiredUnfinished.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status keeps a recorded FAIL as FAIL instead of smoothing it to NOT_RUN', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-cross-status-fail-'))
  try {
    const directory = join(root, 'evidence')
    const writer = new EvidenceWriter(directory)
    writer.write(EVIDENCE_FILES['node-pair'], { stage: 'node-pair', status: 'FAIL', reason: 'node_exited_before_pairing' })
    writer.write(EVIDENCE_FILES.offline, { stage: 'verify', phase: 'offline', status: 'FAIL', reason: 'answered_without_a_connected_node' })
    const code = runStatus({ evidence: directory })
    assert.equal(code, 2)
    const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'FAIL')
    assert.equal(summary.counts.fail, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every refusal is a typed UsageError so the entry point can report it', () => {
  try {
    parseArguments(['nope'])
    assert.fail('expected a refusal')
  } catch (error) {
    assert.ok(error instanceof UsageError)
    assert.equal(error.name, 'UsageError')
  }
})
