// LOOM V2 — tests for the Node-native private Pi RPC Supervisor.
//
// Isolation contract for this file:
// - Every fixture lives under a fresh mkdtemp directory; nothing here reads or
//   writes the real user ~/.pi, a user database, or a deployment target.
// - No real pi.exe is executed and no model is called. The "Pi" process is a
//   tiny fake RPC server written into the tmp sandbox and launched with the
//   current Node binary (child_process.spawn, not a shell). It speaks the same
//   JSONL request/response framing the supervisor parses.
// - Control of fake failure modes is passed through the supervisor's own
//   per-Bot env (FAKE_PI_*), which also proves the supervisor forwards a
//   per-Bot environment rather than the user's global one.
// - Every assertion is about the supervisor's own bookkeeping (loaded vs
//   activated vs providerPromptSeen), never about a real Provider Prompt.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MANAGED_PI_FLAGS,
  ManagedPiRpcSupervisor,
  PINNED_PI,
  activatePurge,
  assertSandboxRoot,
  buildIsolatedEnv,
  buildPiArgv,
  computeTreeSha256,
  sha256Hex,
  verifyExtensionDigest,
  verifyManifestPin
} from './loom-v2-managed-pi-rpc.mjs'

// A fake staged pi-purge extension. Bytes only need to be stable so the manifest
// digest can be checked; this module is never imported or executed.
const EXTENSION_SOURCE = [
  '// fake staged pi-purge extension (test bytes only, never executed)',
  'export default function piPurge() {',
  '  return { name: "purge" }',
  '}',
  ''
].join('\n')

// A fake Pi JSONL RPC server. Reads requests on stdin, writes responses on
// stdout, and emits extension notifications for /purge. Failure modes are
// controlled entirely through FAKE_PI_* env vars.
const FAKE_PI_SOURCE = [
  'let extensionPath = null',
  "const args = process.argv.slice(2)",
  "for (let i = 0; i < args.length; i++) { if (args[i] === '--extension') extensionPath = args[i + 1] }",
  'const control = process.env',
  "let buffer = ''",
  'let enabled = false',
  "let mode = 'off'",
  "const sessionId = 'fake-session-' + Math.random().toString(16).slice(2)",
  "function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n') }",
  "function notify(text, level) { if (control.FAKE_PI_NOTIFY === '0') return; send({ type: 'extension_ui_request', method: 'notify', level: level || 'info', message: text }) }",
  'function handle(line) {',
  '  let req',
  '  try { req = JSON.parse(line) } catch { return }',
  '  const type = req.type',
  '  const id = req.id',
  "  if (control.FAKE_PI_HANG === '1') return",
  "  if (control.FAKE_PI_EXIT_ON && control.FAKE_PI_EXIT_ON === type) { process.exit(1) }",
  "  const wrong = control.FAKE_PI_WRONG_COMMAND && control.FAKE_PI_WRONG_COMMAND === type",
  "  if (type === 'get_commands') { send({ type: 'response', id: id, command: wrong ? 'not_get_commands' : 'get_commands', success: true, data: { commands: [ { name: 'purge', description: 'purge', sourceInfo: { path: extensionPath } } ] } }); return }",
  "  if (type === 'get_state') { send({ type: 'response', id: id, command: wrong ? 'not_get_state' : 'get_state', success: true, data: { sessionId: sessionId, messageCount: 0 } }); return }",
  // Real Pi 0.85.1 has no run_command; a client that sends it is wrong. Echo a
  // rejection so the supervisor's own guard is what a real run would hit.
  "  if (type === 'run_command') { send({ type: 'response', id: id, command: 'run_command', success: false, error: 'unknown_command' }); return }",
  "  if (type === 'prompt') {",
  '    const message = String(req.message == null ? "" : req.message)',
  "    if (message.indexOf('/purge') !== 0) { send({ type: 'response', id: id, command: 'prompt', success: false, error: 'not_a_purge_command' }); return }",
  "    const sub = message.slice('/purge'.length).trim()",
  "    if (sub === 'on') { enabled = true; notify('已开启') }",
  "    else if (sub === 'off') { enabled = false; notify('已关闭') }",
  "    else if (sub === 'status') { notify('状态 ' + (enabled ? '已开启' : '已关闭') + ' 模式 ' + mode) }",
  "    else if (sub.indexOf('mode ') === 0) { mode = sub.slice(5); notify('模式 ' + mode) }",
  "    else { send({ type: 'response', id: id, command: 'prompt', success: false, error: 'unknown_subcommand' }); return }",
  "    send({ type: 'response', id: id, command: wrong ? 'not_prompt' : 'prompt', success: true, data: { enabled: enabled, mode: mode } })",
  '    return',
  '  }',
  "  send({ type: 'response', id: id, command: type, success: false, error: 'unknown_type' })",
  '}',
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let idx; while ((idx = buffer.indexOf('\\n')) !== -1) { const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1); if (line) handle(line) } })",
  "process.stdin.on('end', () => process.exit(0))"
].join('\n')

function createSandbox(t, manifestOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loom-pi-rpc-'))
  // Defensive: on Windows a directory that is a still-running fake Pi's cwd
  // cannot be removed until the supervisor has stopped it; t.after ordering is
  // not guaranteed, so a lingering tmp dir must never fail the test.
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort cleanup; a leftover tmp dir is not a test failure
    }
  })
  const sandboxRoot = join(root, 'sandbox')
  const agentDir = join(sandboxRoot, 'agent')
  const workspace = join(sandboxRoot, 'workspace')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const extensionPath = join(sandboxRoot, 'pi-purge.ts')
  writeFileSync(extensionPath, EXTENSION_SOURCE)
  const fakePath = join(root, 'fake-pi.mjs')
  writeFileSync(fakePath, FAKE_PI_SOURCE)
  const manifest = {
    piVersion: PINNED_PI.version,
    treeSha256: PINNED_PI.treeSha256,
    extensionSha256: sha256Hex(EXTENSION_SOURCE),
    ...manifestOverrides
  }
  return { root, sandboxRoot, agentDir, workspace, extensionPath, fakePath, manifest }
}

function makeSupervisor(sandbox, env = {}, extra = {}) {
  return new ManagedPiRpcSupervisor({
    executable: process.execPath,
    executablePrefixArgs: [sandbox.fakePath],
    extensionPath: sandbox.extensionPath,
    sandboxRoot: sandbox.sandboxRoot,
    agentDir: sandbox.agentDir,
    workspace: sandbox.workspace,
    manifest: sandbox.manifest,
    env,
    instanceLabel: extra.instanceLabel ?? 'bot',
    ...extra
  })
}

function trySymlink(target, linkPath, type) {
  try {
    symlinkSync(target, linkPath, type)
    return true
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP')) return false
    throw error
  }
}

test('verifyManifestPin accepts the pinned bundle and rejects drift', () => {
  const good = { piVersion: PINNED_PI.version, treeSha256: PINNED_PI.treeSha256, extensionSha256: 'a'.repeat(64) }
  assert.deepEqual(verifyManifestPin(good), { ok: true })

  assert.equal(verifyManifestPin({ ...good, piVersion: '1.0.4' }).ok, false)
  assert.equal(verifyManifestPin({ ...good, treeSha256: 'b'.repeat(64) }).ok, false)
  assert.equal(verifyManifestPin({ ...good, extensionSha256: 'not-a-digest' }).ok, false)
  assert.equal(verifyManifestPin(null).ok, false)
})

test('computeTreeSha256 is order-independent and detects tampering', (t) => {
  const a = mkdtempSync(join(tmpdir(), 'loom-tree-a-'))
  const b = mkdtempSync(join(tmpdir(), 'loom-tree-b-'))
  t.after(() => {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })
  mkdirSync(join(a, 'sub'))
  mkdirSync(join(b, 'sub'))
  // Same content, different creation order.
  writeFileSync(join(a, 'one.txt'), 'one\n')
  writeFileSync(join(a, 'sub', 'two.txt'), 'two\n')
  writeFileSync(join(b, 'sub', 'two.txt'), 'two\n')
  writeFileSync(join(b, 'one.txt'), 'one\n')
  assert.equal(computeTreeSha256(a), computeTreeSha256(b))

  writeFileSync(join(a, 'one.txt'), 'tampered\n')
  assert.notEqual(computeTreeSha256(a), computeTreeSha256(b))
})

test('verifyExtensionDigest matches staged bytes and detects a drifted file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-ext-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const extensionPath = join(dir, 'pi-purge.ts')
  writeFileSync(extensionPath, EXTENSION_SOURCE)
  const expected = sha256Hex(EXTENSION_SOURCE)
  assert.equal(verifyExtensionDigest(extensionPath, expected).ok, true)

  writeFileSync(extensionPath, `${EXTENSION_SOURCE}// drift\n`)
  const drifted = verifyExtensionDigest(extensionPath, expected)
  assert.equal(drifted.ok, false)
  assert.equal(drifted.actual !== expected, true)

  assert.equal(verifyExtensionDigest(join(dir, 'missing.ts'), expected).ok, false)
})

test('assertSandboxRoot accepts an isolated sandbox and rejects unsafe roots', (t) => {
  const sandbox = createSandbox(t)
  const ok = assertSandboxRoot({
    sandboxRoot: sandbox.sandboxRoot,
    agentDir: sandbox.agentDir,
    workspace: sandbox.workspace
  })
  assert.equal(ok.ok, true, ok.errors?.join(','))

  // Non-absolute and missing paths.
  assert.equal(assertSandboxRoot({ sandboxRoot: 'rel', agentDir: sandbox.agentDir, workspace: sandbox.workspace }).ok, false)
  const missing = assertSandboxRoot({
    sandboxRoot: sandbox.sandboxRoot,
    agentDir: join(sandbox.sandboxRoot, 'absent'),
    workspace: sandbox.workspace
  })
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.includes('agentDir_missing'))

  // A symlinked agent dir is refused (skipped if the host forbids symlinks).
  const outside = mkdtempSync(join(tmpdir(), 'loom-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const linkAgent = join(sandbox.sandboxRoot, 'linked-agent')
  if (trySymlink(outside, linkAgent, 'dir')) {
    const linked = assertSandboxRoot({
      sandboxRoot: sandbox.sandboxRoot,
      agentDir: linkAgent,
      workspace: sandbox.workspace
    })
    assert.equal(linked.ok, false)
    assert.ok(linked.errors.includes('agentDir_symlink'))
  }
})

test('assertSandboxRoot refuses a sandbox inside the user Pi state', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loom-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const sandboxRoot = join(home, '.pi', 'sandbox')
  const agentDir = join(sandboxRoot, 'agent')
  const workspace = join(sandboxRoot, 'workspace')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })

  const result = assertSandboxRoot({ sandboxRoot, agentDir, workspace, homeDir: home })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('sandboxRoot_forbidden_user_pi'))
})

test('buildPiArgv emits the exact managed flags and requires an absolute extension path', () => {
  const absolute = join(tmpdir(), 'staged', 'pi-purge.ts')
  const argv = buildPiArgv({ extensionPath: absolute })
  assert.deepEqual(argv, [...MANAGED_PI_FLAGS, '--extension', absolute])
  assert.ok(argv.includes('--offline'))
  assert.ok(argv.includes('--no-extensions'))

  assert.throws(() => buildPiArgv({ extensionPath: 'pi-purge.ts' }), (error) => error.code === 'extension_path_must_be_absolute')
})

test('buildIsolatedEnv forces the private agent dir and disables telemetry', () => {
  const agentDir = join(tmpdir(), 'bot-agent')
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/user', PI_CODING_AGENT_DIR: '/home/user/.pi/agent' }
  const env = buildIsolatedEnv({
    agentDir,
    env: { PI_CODING_AGENT_DIR: '/evil/override', FAKE_PI_NOTIFY: '0' },
    baseEnv
  })
  // The user-global Pi dir never survives; the forced value wins last.
  assert.equal(env.PI_CODING_AGENT_DIR, agentDir)
  assert.equal(env.PI_TELEMETRY, '0')
  assert.equal(env.FAKE_PI_NOTIFY, '0')
  assert.equal(env.PATH, '/usr/bin')

  assert.throws(() => buildIsolatedEnv({ agentDir: 'relative', baseEnv }), (error) => error.code === 'agentDir_must_be_absolute')
})

test('start refuses a manifest that does not pin the verified bundle (no process spawned)', async (t) => {
  const sandbox = createSandbox(t, { treeSha256: 'c'.repeat(64) })
  const supervisor = makeSupervisor(sandbox)
  await assert.rejects(supervisor.start(), (error) => error.code === 'manifest_pin_mismatch')
  assert.equal(supervisor.child, null)
})

test('start refuses an extension whose bytes drift from the manifest', async (t) => {
  const sandbox = createSandbox(t, { extensionSha256: 'd'.repeat(64) })
  const supervisor = makeSupervisor(sandbox)
  await assert.rejects(supervisor.start(), (error) => error.code === 'extension_digest_mismatch')
  assert.equal(supervisor.child, null)
})

test('roundtrip: get_commands then /purge on append reports loaded+activated and no prompt', async (t) => {
  const sandbox = createSandbox(t)
  const supervisor = makeSupervisor(sandbox, {}, { instanceLabel: 'bot-a' })
  t.after(() => supervisor.stop())
  await supervisor.start()

  const result = await activatePurge(supervisor, { enable: true, mode: 'append' })
  assert.equal(result.loaded, true)
  assert.equal(result.activated, true)
  assert.equal(result.providerPromptSeen, false)
  assert.equal(result.messageCount, 0)
  assert.equal(result.sourcePath, sandbox.extensionPath)
  assert.ok(result.notifications.some((text) => text.includes('已开启')))
  assert.ok(result.notifications.some((text) => text.includes('append')))

  // Real protocol: /purge is driven through type=prompt with allowlisted
  // messages, never through a run_command, and never a normal model prompt.
  assert.equal(supervisor.sentCommands.includes('run_command'), false)
  assert.ok(supervisor.sentCommands.includes('prompt'))
  assert.ok(supervisor.sentPrompts.includes('/purge on'))
  assert.ok(supervisor.sentPrompts.every((message) => message.startsWith('/purge')))
})

test('activatePurge stays honest when the extension emits no notification', async (t) => {
  const sandbox = createSandbox(t)
  const supervisor = makeSupervisor(sandbox, { FAKE_PI_NOTIFY: '0' })
  t.after(() => supervisor.stop())
  await supervisor.start()

  const result = await activatePurge(supervisor, { enable: true, mode: 'append' })
  // Command responses succeeded, but without the real extension notification
  // this is NOT activation evidence.
  assert.equal(result.loaded, true)
  assert.equal(result.activated, false)
  assert.equal(result.providerPromptSeen, false)
})

test('two Bots stay isolated: A enables append, B stays off, distinct sessions', async (t) => {
  const sandboxA = createSandbox(t)
  const sandboxB = createSandbox(t)
  const supervisorA = makeSupervisor(sandboxA, {}, { instanceLabel: 'bot-a' })
  const supervisorB = makeSupervisor(sandboxB, {}, { instanceLabel: 'bot-b' })
  t.after(() => supervisorA.stop())
  t.after(() => supervisorB.stop())
  await supervisorA.start()
  await supervisorB.start()

  const a = await activatePurge(supervisorA, { enable: true, mode: 'append' })
  const b = await activatePurge(supervisorB, { enable: false, mode: 'strict' })

  assert.equal(a.activated, true)
  assert.equal(b.activated, false)
  assert.equal(a.loaded, true)
  assert.equal(b.loaded, true)
  assert.ok(a.notifications.some((text) => text.includes('已开启')))
  assert.equal(b.notifications.some((text) => text.includes('已开启')), false)
  assert.ok(b.notifications.some((text) => text.includes('已关闭')))

  // Per-Bot isolation: different agent dirs, different native sessions, both 0 messages.
  assert.notEqual(sandboxA.agentDir, sandboxB.agentDir)
  assert.notEqual(a.sessionId, b.sessionId)
  assert.equal(a.messageCount, 0)
  assert.equal(b.messageCount, 0)
  assert.equal(a.providerPromptSeen, false)
  assert.equal(b.providerPromptSeen, false)
})

test('restart starts a fresh disabled session with a new session id', async (t) => {
  const sandbox = createSandbox(t)
  const first = makeSupervisor(sandbox, {}, { instanceLabel: 'bot-r' })
  t.after(() => first.stop())
  await first.start()
  const before = await activatePurge(first, { enable: true, mode: 'append' })
  assert.equal(before.activated, true)
  await first.stop()

  const second = makeSupervisor(sandbox, {}, { instanceLabel: 'bot-r' })
  t.after(() => second.stop())
  await second.start()
  const after = await activatePurge(second, { enable: false })

  assert.equal(after.loaded, true)
  assert.equal(after.activated, false)
  assert.equal(after.messageCount, 0)
  assert.notEqual(after.sessionId, before.sessionId)
  assert.ok(after.notifications.some((text) => text.includes('已关闭')))
})

test('a hung Pi fails closed on timeout and poisons later calls', async (t) => {
  const sandbox = createSandbox(t)
  const supervisor = makeSupervisor(sandbox, { FAKE_PI_HANG: '1' }, { instanceLabel: 'bot-h' })
  t.after(() => supervisor.stop())
  await supervisor.start()

  await assert.rejects(
    supervisor.getCommands({ timeoutMs: 150 }),
    (error) => error.code === 'request_timeout'
  )
  assert.equal(supervisor.failed, true)
  await assert.rejects(supervisor.getState(), (error) => error.code === 'supervisor_failed')
})

test('a mid-request process exit rejects the pending call as pi_process_exited', async (t) => {
  const sandbox = createSandbox(t)
  const supervisor = makeSupervisor(sandbox, { FAKE_PI_EXIT_ON: 'get_commands' }, { instanceLabel: 'bot-e' })
  t.after(() => supervisor.stop())
  await supervisor.start()

  await assert.rejects(supervisor.getCommands(), (error) => error.code === 'pi_process_exited')
})

test('a response carrying the wrong command is rejected and fails closed', async (t) => {
  const sandbox = createSandbox(t)
  const supervisor = makeSupervisor(sandbox, { FAKE_PI_WRONG_COMMAND: 'get_state' }, { instanceLabel: 'bot-m' })
  t.after(() => supervisor.stop())
  await supervisor.start()

  await assert.rejects(supervisor.getState(), (error) => error.code === 'response_command_mismatch')
  assert.equal(supervisor.failed, true)
  await assert.rejects(supervisor.getState(), (error) => error.code === 'supervisor_failed')
})

test('supervisor refuses RPC type=run_command (Pi 0.85.1 has no such command)', async (t) => {
  const sandbox = createSandbox(t)
  const supervisor = makeSupervisor(sandbox, {}, { instanceLabel: 'bot-nc' })
  t.after(() => supervisor.stop())
  await supervisor.start()

  await assert.rejects(
    supervisor.request('run_command', { name: 'purge', args: 'on' }),
    (error) => error.code === 'run_command_not_supported'
  )
  // The refusal is a pure guard: nothing reached the process and it stays healthy.
  assert.equal(supervisor.sentCommands.includes('run_command'), false)
  assert.equal(supervisor.failed, false)
})

test('supervisor refuses a normal model prompt and a non-allowlisted /purge command', async (t) => {
  const sandbox = createSandbox(t)
  const supervisor = makeSupervisor(sandbox, {}, { instanceLabel: 'bot-np' })
  t.after(() => supervisor.stop())
  await supervisor.start()

  await assert.rejects(
    supervisor.request('prompt', { message: 'hello model, please answer 17+25' }),
    (error) => error.code === 'prompt_not_allowlisted'
  )
  await assert.rejects(
    supervisor.runPurgeCommand('/purge mode replace'),
    (error) => error.code === 'purge_command_not_allowlisted'
  )
  // Nothing was written: no prompt of any kind left the supervisor.
  assert.equal(supervisor.sentPrompts.length, 0)
  assert.equal(supervisor.failed, false)
})
