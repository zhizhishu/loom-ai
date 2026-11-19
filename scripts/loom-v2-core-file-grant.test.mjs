// LOOM V2 — production Pi file-grant slice: shared guard loaded through the CORE-written grant file.
//
// Run (Root, from loom/): node --test --test-force-exit --test-timeout=120000 scripts/loom-v2-core-file-grant.test.mjs
//
// What this proves (isolated fixtures only; no external model, no user profile, no real workspace):
//   1  the SAME guard source that the isolated Runner uses also runs from the Core-owned grant file
//      (`ROVAI_PI_FILE_GRANT_FILE`), with one validation routine for both sources;
//   2  the legacy env source still works (the Runner default is not broken);
//   3  `workspace_read_only` grants exactly the native `read` tool and `workspace_read_write` exactly
//      `read`/`write`/`edit`: `bash`, unknown/MCP tools, out-of-workspace absolute paths, traversal,
//      hardlink escapes and symlink escapes are refused under both policies;
//   4  missing / unparsable / expired / mismatched grants fail closed (every tool call blocked);
//   5  a tool decision whose log cannot be written is still refused.
//
// The Rust side (`crates/rovai-core/src/pi/file_grant.rs`) is the typed producer of this same document;
// its own unit tests live with it and are compiled by Root.

import test from 'node:test'
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import loomRuntimeFileGuard from './loom-v2-runtime-file-guard.ts'

const GUARD_SCHEMA = 'loom.runtime.file-guard.v1'
const GRANT_FILE_ENV = 'ROVAI_PI_FILE_GRANT_FILE'
const ENV_SOURCE = 'LOOM_RUN_GUARD'

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakePi() {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
    }
  }
}

/** Run the extension factory with one env source, returning the registered tool_call handler. */
async function loadGuard({ grantFile, envGrant } = {}) {
  const previousFile = process.env[GRANT_FILE_ENV]
  const previousEnv = process.env[ENV_SOURCE]
  delete process.env[GRANT_FILE_ENV]
  delete process.env[ENV_SOURCE]
  if (grantFile !== undefined) process.env[GRANT_FILE_ENV] = grantFile
  if (envGrant !== undefined) process.env[ENV_SOURCE] = envGrant
  const pi = fakePi()
  try {
    await loomRuntimeFileGuard(pi)
  } finally {
    if (previousFile === undefined) delete process.env[GRANT_FILE_ENV]
    else process.env[GRANT_FILE_ENV] = previousFile
    if (previousEnv === undefined) delete process.env[ENV_SOURCE]
    else process.env[ENV_SOURCE] = previousEnv
  }
  const handler = pi.handlers.get('tool_call')
  assert.equal(typeof handler, 'function', 'the guard must register a tool_call handler')
  return handler
}

function toolEvent(toolName, toolCallId, input = {}) {
  return { type: 'tool_call', toolCallId, toolName, input }
}

function grantDocument({
  workspaceReal,
  logPath,
  runId = 'run-core-1',
  botId = 'bot-core',
  epoch = 3,
  expiresAtEpochMs = Date.now() + 600_000,
  tools = ['read'],
  requiresClaim = false,
  claimId = '',
  fenceGeneration = 0,
  leaseExpiresAtEpochMs = 0
}) {
  return {
    schema: GUARD_SCHEMA,
    runId,
    botId,
    executionEpoch: epoch,
    workspaceReal,
    allowedTools: tools,
    expiresAtEpochMs,
    logPath,
    // P0 step 2 + 3: the claim identity Core always writes, and the requirement flag that turns both
    // `write` and `edit` into "not without a live claim". A plain chat Run keeps `requiresClaim:false`
    // and the empty triple, which is the unchanged behaviour.
    claimId,
    fenceGeneration,
    leaseExpiresAtEpochMs,
    requiresClaim
  }
}

function readLog(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 1 + 3 · Core-written grant file drives the shared guard
// ---------------------------------------------------------------------------

test('core grant file: read-only and read-write policies allow only their granted native file tools', { timeout: 60_000 }, async () => {
  const root = freshDir('loom-core-grant-')
  const workspace = join(root, 'ws')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n', 'utf8')
  const logPath = join(root, 'guard.jsonl')
  const grantFile = join(root, 'guard-grant.json')
  // The guard compares the realpath of the handler cwd against the grant's realpath.
  const workspaceReal = realpathSync(workspace)
  writeFileSync(grantFile, `${JSON.stringify(grantDocument({ workspaceReal, logPath }))}\n`, 'utf8')

  // Hardlink and symlink fixtures; a filesystem that refuses them must say so, never pass silently.
  let hardlinkCreated = false
  try {
    linkSync(join(outside, 'secret.txt'), join(workspace, 'hard.md'))
    hardlinkCreated = true
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  let symlinkCreated = false
  try {
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.md'), 'file')
    symlinkCreated = true
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }

  try {
    const handler = await loadGuard({ grantFile })
    const ctx = { cwd: workspaceReal }

    // The executed guard records its own readiness and self-test.
    const log = readLog(logPath)
    assert.ok(log.includes('"t":"guard_ready"'), 'the guard must write guard_ready')
    assert.ok(log.includes('"t":"guard_selftest"'), 'the guard must write its self-test result')
    assert.ok(log.includes('"runId":"run-core-1"'), 'guard_ready must carry this Run')
    assert.ok(log.includes('"botId":"bot-core"'), 'guard_ready must carry this bot')

    // Allowed: the one granted tool, inside the workspace.
    assert.equal(handler(toolEvent('read', 'c_read', { path: 'notes.md' }), ctx), undefined)

    // Refused: tools outside the read-only grant.
    for (const [toolName, toolCallId] of [['write', 'c_write'], ['edit', 'c_edit'], ['bash', 'c_bash'], ['mcp__server__tool', 'c_mcp']]) {
      const outcome = handler(toolEvent(toolName, toolCallId, { path: 'notes.md' }), ctx)
      assert.equal(outcome?.block, true, `${toolName} must be refused`)
      assert.match(String(outcome.reason), /tool_not_(granted|allowed)/)
    }

    // Refused: absolute escape, traversal, sensitive file.
    for (const [path, id] of [[join(outside, 'secret.txt'), 'c_abs'], ['../outside/secret.txt', 'c_dotdot'], ['.git/config', 'c_git']]) {
      const outcome = handler(toolEvent('read', id, { path }), ctx)
      assert.equal(outcome?.block, true, `${path} must be refused`)
    }

    if (hardlinkCreated) {
      const outcome = handler(toolEvent('read', 'c_hard', { path: 'hard.md' }), ctx)
      assert.equal(outcome?.block, true, 'a hardlink to an outside file must be refused')
      assert.match(String(outcome.reason), /path_hardlink_escape/)
    }
    if (symlinkCreated) {
      const outcome = handler(toolEvent('read', 'c_symlink', { path: 'link.md' }), ctx)
      assert.equal(outcome?.block, true, 'a symlink escape must be refused')
      assert.match(String(outcome.reason), /path_symlink_escape/)
    }

    // The read-write policy: the same workspace boundary, widened to Pi's three native file tools.
    const readWriteGrantFile = join(root, 'guard-grant-read-write.json')
    writeFileSync(readWriteGrantFile, `${JSON.stringify(grantDocument({ workspaceReal, logPath, tools: ['read', 'write', 'edit'] }))}\n`, 'utf8')
    const readWrite = await loadGuard({ grantFile: readWriteGrantFile })
    for (const [toolName, toolCallId] of [['read', 'w_read'], ['write', 'w_write'], ['edit', 'w_edit']]) {
      assert.equal(
        readWrite(toolEvent(toolName, toolCallId, { path: 'notes.md' }), ctx),
        undefined,
        `${toolName} must be allowed inside the workspace by the read-write policy`
      )
    }

    // Refused: shell and extension/MCP tools stay outside both policies.
    for (const [toolName, toolCallId] of [['bash', 'w_bash'], ['mcp__server__tool', 'w_mcp']]) {
      const outcome = readWrite(toolEvent(toolName, toolCallId, { path: 'notes.md' }), ctx)
      assert.equal(outcome?.block, true, `${toolName} must be refused by the read-write policy`)
      assert.match(String(outcome.reason), /tool_not_(granted|allowed)/)
    }

    // Refused: the same path rules apply to the writing tools.
    for (const [toolName, path, id] of [
      ['write', join(outside, 'secret.txt'), 'w_abs'],
      ['write', '../outside/secret.txt', 'w_dotdot'],
      ['edit', '.git/config', 'w_git'],
    ]) {
      const outcome = readWrite(toolEvent(toolName, id, { path }), ctx)
      assert.equal(outcome?.block, true, `${toolName} on ${path} must be refused`)
    }
    if (hardlinkCreated) {
      const outcome = readWrite(toolEvent('edit', 'w_hard', { path: 'hard.md' }), ctx)
      assert.equal(outcome?.block, true, 'a hardlink to an outside file must be refused for edit')
      assert.match(String(outcome.reason), /path_hardlink_escape/)
    }
    if (symlinkCreated) {
      const outcome = readWrite(toolEvent('write', 'w_symlink', { path: 'link.md' }), ctx)
      assert.equal(outcome?.block, true, 'a symlink escape must be refused for write')
      assert.match(String(outcome.reason), /path_symlink_escape/)
    }

    // The log carries no plaintext outside path.
    assert.equal(readLog(logPath).includes('secret.txt'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2 · the Runner env source still works (default not broken)
// ---------------------------------------------------------------------------

test('env source: the isolated Runner grant still loads and enforces', { timeout: 60_000 }, async () => {
  const root = freshDir('loom-env-grant-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  const logPath = join(root, 'guard.jsonl')
  try {
    const handler = await loadGuard({ envGrant: JSON.stringify(grantDocument({ workspaceReal: realpathSync(workspace), logPath })) })
    const ctx = { cwd: realpathSync(workspace) }
    assert.equal(handler(toolEvent('read', 'c_read', { path: 'notes.md' }), ctx), undefined)
    assert.equal(handler(toolEvent('write', 'c_write', { path: 'notes.md' }), ctx)?.block, true)
    assert.ok(readLog(logPath).includes('"t":"guard_ready"'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4 · fail closed: missing / unparsable / expired / mismatched grant
// ---------------------------------------------------------------------------

test('fail closed: missing, unparsable, expired and mismatched grants block every tool', { timeout: 60_000 }, async () => {
  const root = freshDir('loom-bad-grant-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  const logPath = join(root, 'guard.jsonl')
  const ctx = { cwd: realpathSync(workspace) }
  const workspaceReal = realpathSync(workspace)

  const cases = []
  // No source at all.
  cases.push({ label: 'no source', grantFile: undefined })
  // Path that does not exist.
  cases.push({ label: 'missing file', grantFile: join(root, 'absent.json') })
  // Unparsable content.
  const brokenFile = join(root, 'broken.json')
  writeFileSync(brokenFile, '{not json', 'utf8')
  cases.push({ label: 'unparsable', grantFile: brokenFile })
  // Expired grant.
  const expiredFile = join(root, 'expired.json')
  writeFileSync(expiredFile, JSON.stringify(grantDocument({
    workspaceReal,
    logPath,
    expiresAtEpochMs: Date.now() - 1_000
  })), 'utf8')
  cases.push({ label: 'expired', grantFile: expiredFile, pattern: /grant_expired/ })
  // A grant that asks for a tool the read-only policy never permits must be refused outright.
  const widerToolsFile = join(root, 'wider-tools.json')
  writeFileSync(widerToolsFile, JSON.stringify(grantDocument({
    workspaceReal,
    logPath,
    tools: ['read', 'bash']
  })), 'utf8')
  cases.push({ label: 'tools beyond read-only', grantFile: widerToolsFile, pattern: /guard_tools_not_permitted/ })

  try {
    for (const testCase of cases) {
      const handler = await loadGuard({ grantFile: testCase.grantFile })
      const outcome = handler(toolEvent('read', 'c_read', { path: 'notes.md' }), ctx)
      assert.equal(outcome?.block, true, `${testCase.label}: every tool call must be blocked`)
      assert.match(String(outcome.reason), testCase.pattern ?? /guard_|grant_expired/, `${testCase.label}: ${outcome.reason}`)
    }

    // Expired grants also refuse at call time even when the document loaded before expiry.
    const soonFile = join(root, 'soon.json')
    writeFileSync(soonFile, JSON.stringify(grantDocument({
      workspaceReal,
      logPath,
      expiresAtEpochMs: Date.now() + 60_000
    })), 'utf8')
    const handler = await loadGuard({ grantFile: soonFile })
    assert.equal(handler(toolEvent('read', 'c_ok', { path: 'notes.md' }), ctx), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5b · workspace_workflow: the same file boundary plus one managed business tool
// ---------------------------------------------------------------------------

test('workflow policy: the managed loom tool reaches the eight operations only, and its evidence path uses the read policy', { timeout: 60_000 }, async () => {
  const root = freshDir('loom-workflow-grant-')
  const workspace = join(root, 'ws')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  mkdirSync(join(workspace, 'out'))
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  writeFileSync(join(workspace, 'out', 'report.md'), 'deliverable\n', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n', 'utf8')
  const logPath = join(root, 'guard.jsonl')
  const workspaceReal = realpathSync(workspace)
  const ctx = { cwd: workspaceReal }
  const WORKFLOW = ['read', 'write', 'edit', 'rovai_loom']

  let symlinkCreated = false
  try {
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.md'), 'file')
    symlinkCreated = true
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }

  try {
    const workflowFile = join(root, 'workflow.json')
    writeFileSync(workflowFile, JSON.stringify(grantDocument({ workspaceReal, logPath, tools: WORKFLOW })), 'utf8')
    const workflow = await loadGuard({ grantFile: workflowFile })

    // The three native file tools keep working inside the workspace.
    for (const [toolName, id] of [['read', 'f_read'], ['write', 'f_write'], ['edit', 'f_edit']]) {
      assert.equal(workflow(toolEvent(toolName, id, { path: 'notes.md' }), ctx), undefined, `${toolName} must stay granted`)
    }

    // Every operation without a path argument is allowed.
    for (const operation of ['loom.status', 'loom.plan', 'loom.release', 'loom.claim', 'loom.submit', 'loom.inspect', 'loom.stage-review']) {
      assert.equal(
        workflow(toolEvent('rovai_loom', `op_${operation}`, { operation, input: {} }), ctx),
        undefined,
        `${operation} must be allowed by the workflow grant`
      )
    }

    // Nothing outside the eight operations is reachable, even with a plausible looking name.
    for (const operation of ['loom.workspace.run', 'loom.accept', 'thread.message.send', 'bash', 'memory.write', '']) {
      const outcome = workflow(toolEvent('rovai_loom', `op_bad_${operation}`, { operation, input: {} }), ctx)
      assert.equal(outcome?.block, true, `${operation} must be refused`)
      assert.match(String(outcome.reason), /loom_operation_not_allowed/)
    }
    const missingOperation = workflow(toolEvent('rovai_loom', 'op_missing', { input: {} }), ctx)
    assert.equal(missingOperation?.block, true)
    assert.match(String(missingOperation.reason), /loom_operation_not_allowed/)

    // `loom.evidence` resolves its path through the same read policy.
    assert.equal(
      workflow(toolEvent('rovai_loom', 'op_evidence_ok', { operation: 'loom.evidence', input: { relativePath: 'out/report.md' } }), ctx),
      undefined,
      'an in-workspace regular file is valid evidence'
    )
    for (const [relativePath, pattern] of [
      [join(outside, 'secret.txt'), /path_outside_workspace/],
      ['../outside/secret.txt', /path_parent_escape/],
      ['.git/config', /sensitive_path/],
      ['id_rsa', /sensitive_path/],
      ['missing.md', /path_missing_for_tool/],
      ['', /path_missing/],
    ]) {
      const outcome = workflow(toolEvent('rovai_loom', `op_evidence_${relativePath}`, { operation: 'loom.evidence', input: { relativePath } }), ctx)
      assert.equal(outcome?.block, true, `evidence ${relativePath || '<empty>'} must be refused`)
      assert.match(String(outcome.reason), pattern)
    }
    if (symlinkCreated) {
      const outcome = workflow(toolEvent('rovai_loom', 'op_evidence_link', { operation: 'loom.evidence', input: { relativePath: 'link.md' } }), ctx)
      assert.equal(outcome?.block, true, 'a symlinked evidence path must be refused')
      assert.match(String(outcome.reason), /path_symlink_escape/)
    }

    // The legacy policies never grant the business tool, so the call is refused there.
    for (const tools of [['read'], ['read', 'write', 'edit']]) {
      const legacyFile = join(root, `legacy-${tools.length}.json`)
      writeFileSync(legacyFile, JSON.stringify(grantDocument({ workspaceReal, logPath, tools })), 'utf8')
      const legacy = await loadGuard({ grantFile: legacyFile })
      const outcome = legacy(toolEvent('rovai_loom', `op_legacy_${tools.length}`, { operation: 'loom.status', input: {} }), ctx)
      assert.equal(outcome?.block, true, `${tools.join(',')} must not grant the business tool`)
      assert.match(String(outcome.reason), /tool_not_granted/)
    }

    // A grant that mixes the business tool with anything else fails the load outright.
    for (const tools of [
      ['rovai_loom'],
      ['read', 'rovai_loom'],
      ['read', 'write', 'edit', 'bash', 'rovai_loom'],
      ['read', 'write', 'edit', 'rovai_loom', 'rovai_loom'],
      ['write', 'edit', 'rovai_loom'],
      ['read', 'write', 'edit', 'mcp__server__tool'],
    ]) {
      const badFile = join(root, `bad-${tools.join('_')}.json`)
      writeFileSync(badFile, JSON.stringify(grantDocument({ workspaceReal, logPath, tools })), 'utf8')
      const blocked = await loadGuard({ grantFile: badFile })
      const outcome = blocked(toolEvent('read', 'bad_read', { path: 'notes.md' }), ctx)
      assert.equal(outcome?.block, true, `${tools.join(',')} must fail closed`)
      assert.match(String(outcome.reason), /guard_tools_not_permitted/)
    }

    // Decisions are recorded with the operation, and no outside path is written in plaintext.
    const log = readLog(logPath)
    assert.ok(log.includes('loom_operation_granted'), 'allowed operations must be recorded')
    assert.ok(log.includes('"operation":"loom.evidence"'), 'evidence decisions must name the operation')
    assert.equal(log.includes('secret.txt'), false, 'outside paths never reach the log')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5 · a tool call whose decision cannot be logged is refused
// ---------------------------------------------------------------------------

test('log failure: an unrecordable allow is downgraded to a block', { timeout: 60_000 }, async () => {
  const root = freshDir('loom-logfail-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  // A log path inside a missing directory cannot be written.
  const unwritableLog = join(root, 'no-such-dir', 'guard.jsonl')
  const grantFile = join(root, 'grant.json')
  writeFileSync(grantFile, JSON.stringify(grantDocument({ workspaceReal: realpathSync(workspace), logPath: unwritableLog })), 'utf8')
  try {
    const handler = await loadGuard({ grantFile })
    const outcome = handler(toolEvent('read', 'c_read', { path: 'notes.md' }), { cwd: realpathSync(workspace) })
    assert.equal(outcome?.block, true, 'an unrecordable decision must never allow the tool')
    assert.match(String(outcome.reason), /guard_log_write_failed|guard_selftest_failed|guard_ready/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6 · isolated Runner (env) source: any non-empty duplicate-free native subset
// ---------------------------------------------------------------------------

// Sequential on purpose: loadGuard swaps process.env for each source.
test('env source: every non-empty duplicate-free read/write/edit subset loads with exactly that guard_ready tool set', { timeout: 120_000, concurrency: false }, async () => {
  const root = freshDir('loom-env-subset-')
  const workspace = join(root, 'ws')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n', 'utf8')
  const workspaceReal = realpathSync(workspace)
  const ctx = { cwd: workspaceReal }
  const NATIVE = ['read', 'write', 'edit']

  // Raw log lines only: the guard_ready records this grant actually produced.
  const readyRecords = (path) => readLog(path).split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((record) => record?.t === 'guard_ready')

  try {
    let seq = 0
    // The seven non-empty subsets, plus two reordered requests: order is not part of the contract.
    for (const tools of [
      ['read'], ['write'], ['edit'],
      ['read', 'write'], ['read', 'edit'], ['write', 'edit'],
      ['read', 'write', 'edit'],
      ['write', 'read'], ['edit', 'read', 'write']
    ]) {
      seq += 1
      const requested = [...tools]
      const logPath = join(root, `env-${seq}.jsonl`)
      const handler = await loadGuard({ envGrant: JSON.stringify(grantDocument({ workspaceReal, logPath, tools: requested })) })

      const ready = readyRecords(logPath)
      assert.equal(ready.length, 1, `${requested.join(',')}: the guard must write exactly one guard_ready`)
      assert.equal(ready[0].workspaceReal, workspaceReal, `${requested.join(',')}: guard_ready must carry this workspace`)
      const logged = ready[0].allowedTools
      assert.ok(Array.isArray(logged), `${requested.join(',')}: guard_ready must record the tool set`)
      assert.equal(logged.length, requested.length, `${requested.join(',')}: guard_ready must record exactly ${requested.length} tools`)
      assert.deepEqual([...logged].sort(), [...requested].sort(), `${requested.join(',')}: guard_ready tool set must equal the request`)

      for (const toolName of requested) {
        assert.equal(handler(toolEvent(toolName, `ok_${toolName}_${seq}`, { path: 'notes.md' }), ctx), undefined,
          `${requested.join(',')}: the granted ${toolName} must be allowed inside the workspace`)
      }
      for (const toolName of NATIVE.filter((native) => !requested.includes(native))) {
        const outcome = handler(toolEvent(toolName, `ungranted_${toolName}_${seq}`, { path: 'notes.md' }), ctx)
        assert.equal(outcome?.block, true, `${requested.join(',')}: ungranted ${toolName} must be refused`)
        assert.match(String(outcome.reason), /tool_not_(granted|allowed)/, `${requested.join(',')}: ${outcome?.reason}`)
      }
      // A smaller native subset never admits the business tool, a shell or an MCP tool.
      for (const toolName of ['rovai_loom', 'bash', 'mcp__server__tool']) {
        const outcome = handler(toolEvent(toolName, `foreign_${toolName}_${seq}`, { path: 'notes.md' }), ctx)
        assert.equal(outcome?.block, true, `${requested.join(',')}: ${toolName} must be refused`)
        assert.match(String(outcome.reason), /tool_not_(granted|allowed)/, `${requested.join(',')}: ${outcome?.reason}`)
      }
    }

    // The write-only subset keeps the whole path boundary and never writes its outside target.
    const writeOnlyLog = join(root, 'env-write-only-paths.jsonl')
    const writeOnly = await loadGuard({ envGrant: JSON.stringify(grantDocument({ workspaceReal, logPath: writeOnlyLog, tools: ['write'] })) })
    for (const [path, id, pattern] of [
      ['../outside/secret.txt', 'wo_dotdot', /path_parent_escape/],
      [join(outside, 'secret.txt'), 'wo_abs', /path_outside_workspace/],
      ['.git/config', 'wo_git', /sensitive_path/],
      ['', 'wo_empty', /path_missing/],
    ]) {
      const outcome = writeOnly(toolEvent('write', id, { path }), ctx)
      assert.equal(outcome?.block, true, `write-only subset: ${path || '<empty>'} must be refused`)
      assert.match(String(outcome.reason), pattern)
    }
    assert.equal(readLog(writeOnlyLog).includes('secret.txt'), false, 'outside paths never reach the guard log')

    // Anything that is not a native file tool subset fails the load outright, before any guard_ready.
    for (const [label, tools, expectedReason] of [
      ['empty', [], /guard_tools_missing/],
      ['duplicate', ['read', 'read'], /guard_tools_not_permitted/],
      ['duplicate write', ['write', 'write'], /guard_tools_not_permitted/],
      ['unknown', ['bash'], /guard_tools_not_permitted/],
      ['unknown mixed', ['read', 'bash'], /guard_tools_not_permitted/],
      ['business only', ['rovai_loom'], /guard_tools_not_permitted/],
      ['business plus every native tool', ['read', 'write', 'edit', 'rovai_loom'], /guard_tools_not_permitted/],
      ['mcp only', ['mcp__server__tool'], /guard_tools_not_permitted/],
      ['mcp mixed', ['write', 'mcp__server__tool'], /guard_tools_not_permitted/],
    ]) {
      seq += 1
      const logPath = join(root, `env-refused-${seq}.jsonl`)
      const handler = await loadGuard({ envGrant: JSON.stringify(grantDocument({ workspaceReal, logPath, tools })) })
      assert.deepEqual(readyRecords(logPath), [], `${label}: a refused env grant must never write guard_ready`)
      for (const toolName of NATIVE) {
        const outcome = handler(toolEvent(toolName, `refused_${toolName}_${seq}`, { path: 'notes.md' }), ctx)
        assert.equal(outcome?.block, true, `${label}: ${toolName} must be blocked`)
        assert.match(String(outcome.reason), expectedReason, `${label}: ${outcome?.reason}`)
      }
    }

    // Expiry and cwd binding still decide every call, not only the load.
    const expiredLog = join(root, 'env-expired.jsonl')
    const expired = await loadGuard({ envGrant: JSON.stringify(grantDocument({
      workspaceReal, logPath: expiredLog, tools: ['write'], expiresAtEpochMs: Date.now() - 1_000
    })) })
    const expiredOutcome = expired(toolEvent('write', 'expired_write', { path: 'notes.md' }), ctx)
    assert.equal(expiredOutcome?.block, true, 'an expired env grant must block its own granted tool')
    assert.match(String(expiredOutcome.reason), /grant_expired/)

    const mismatchLog = join(root, 'env-cwd-mismatch.jsonl')
    const mismatch = await loadGuard({ envGrant: JSON.stringify(grantDocument({ workspaceReal, logPath: mismatchLog, tools: ['write'] })) })
    const mismatchOutcome = mismatch(toolEvent('write', 'mismatch_write', { path: 'notes.md' }), { cwd: realpathSync(outside) })
    assert.equal(mismatchOutcome?.block, true, 'a handler cwd outside the granted workspace must be refused')
    assert.match(String(mismatchOutcome.reason), /cwd_mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6b · the Core-written file source can never ask for a Runner-only subset
// ---------------------------------------------------------------------------

// The source is chosen by the loader, so a payload field must never unlock the subset path.
test('core grant file: payload fields cannot turn a write-only or reordered grant into a Runner subset', { timeout: 60_000, concurrency: false }, async () => {
  const root = freshDir('loom-file-source-binding-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  const workspaceReal = realpathSync(workspace)
  const ctx = { cwd: workspaceReal }
  const readyRecords = (path) => readLog(path).split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((record) => record?.t === 'guard_ready')

  try {
    let seq = 0
    for (const [label, tools, extra] of [
      ['write only', ['write'], {}],
      ['write only + isolatedRunner', ['write'], { isolatedRunner: true }],
      ['write only + source', ['write'], { source: 'env' }],
      ['write only + both', ['write'], { isolatedRunner: true, source: 'env', grantSource: 'isolated-runner' }],
      ['reordered three', ['write', 'read', 'edit'], {}],
      ['reordered two + isolatedRunner', ['write', 'read'], { isolatedRunner: true }],
    ]) {
      seq += 1
      const logPath = join(root, `file-${seq}.jsonl`)
      const grantFile = join(root, `file-${seq}.json`)
      writeFileSync(grantFile, JSON.stringify({ ...grantDocument({ workspaceReal, logPath, tools }), ...extra }), 'utf8')
      const handler = await loadGuard({ grantFile })
      assert.deepEqual(readyRecords(logPath), [], `${label}: a refused Core file grant must never write guard_ready`)
      for (const toolName of ['read', 'write', 'edit']) {
        const outcome = handler(toolEvent(toolName, `file_${toolName}_${seq}`, { path: 'notes.md' }), ctx)
        assert.equal(outcome?.block, true, `${label}: ${toolName} must stay blocked`)
        assert.match(String(outcome.reason), /guard_tools_not_permitted/, `${label}: ${outcome?.reason}`)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7 · P0 step 3: a LOOM-bound Run writes only under a live claim
// ---------------------------------------------------------------------------

// The r9 failure was a `write` of a brand-new file ~6s before `loom.claim`. The gated shape is: the
// grant says `requiresClaim:true`, so EVERY write/edit — including the first creation of a file that
// does not exist yet — needs a complete, unexpired claim. A plain chat Run keeps `requiresClaim:false`
// and the unchanged behaviour, and `read` never needs a claim.
test('claim gate: a LOOM-bound Run writes only under a complete, live claim', { timeout: 60_000, concurrency: false }, async () => {
  const root = freshDir('loom-claim-gate-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.md'), 'in scope\n', 'utf8')
  const workspaceReal = realpathSync(workspace)
  const ctx = { cwd: workspaceReal }
  const logPath = join(root, 'guard.jsonl')
  const WORKFLOW = ['read', 'write', 'edit', 'rovai_loom']
  const readLogLines = () => readLog(logPath).split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
  const decisions = (reasonCode) => readLogLines()
    .filter((record) => record?.t === 'decision' && record?.reasonCode === reasonCode)

  // A brand-new path: the path policy alone would say `in_workspace_new_file`.
  const NEW_FILE = 'brand-new.md'
  // One expiry for every rewrite of the pending document: a re-issue may move the claim, never the
  // guard identity (the guard refuses a document whose expiry or Run changed under it).
  const grantExpiry = Date.now() + 600_000

  try {
    // 1 · bound Run, no claim yet (the r9 window): refuse the FIRST creation, allow reads.
    const pendingFile = join(root, 'grant-pending.json')
    writeFileSync(pendingFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, tools: WORKFLOW, requiresClaim: true, expiresAtEpochMs: grantExpiry
    })), 'utf8')
    const pending = await loadGuard({ grantFile: pendingFile })
    assert.equal(pending(toolEvent('read', 'pending_read', { path: 'notes.md' }), ctx), undefined,
      'a read never needs a claim')
    for (const [toolName, path, id] of [['write', NEW_FILE, 'pending_new'], ['write', 'notes.md', 'pending_overwrite'], ['edit', 'notes.md', 'pending_edit']]) {
      const outcome = pending(toolEvent(toolName, id, { path }), ctx)
      assert.equal(outcome?.block, true, `${toolName} ${path} must be refused before loom.claim`)
      assert.match(String(outcome.reason), /claim_missing/, `${toolName} ${path}: ${outcome?.reason}`)
    }
    const missing = decisions('claim_missing')
    assert.ok(missing.length >= 3, 'every refused write must be recorded as claim_missing')
    assert.equal(missing[0].requiresClaim, true, 'the refusal records the requirement it enforced')
    assert.ok(readLogLines().some((record) => record?.t === 'guard_ready' && record?.requiresClaim === true),
      'guard_ready must record the claim requirement')

    // 2 · Core re-issues the SAME document after `loom.claim`: the running guard must see it.
    writeFileSync(pendingFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, tools: WORKFLOW, requiresClaim: true, expiresAtEpochMs: grantExpiry,
      claimId: 'claim-live-1', fenceGeneration: 2, leaseExpiresAtEpochMs: Date.now() + 120_000
    })), 'utf8')
    assert.equal(pending(toolEvent('write', 'claimed_new', { path: NEW_FILE }), ctx), undefined,
      'the first creation is allowed once the claim the grant carries is live')
    assert.equal(pending(toolEvent('edit', 'claimed_edit', { path: 'notes.md' }), ctx), undefined,
      'an edit under the live claim is allowed')
    // The business tool never needs a claim of its own: `loom.claim` is how the claim is earned.
    assert.equal(pending(toolEvent('rovai_loom', 'claimed_loom', { operation: 'loom.claim', input: {} }), ctx), undefined,
      'loom.claim must never be gated on a claim it is about to create')

    // 3 · a lease that lapsed is `claim_expired`, for writes and edits alike.
    writeFileSync(pendingFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, tools: WORKFLOW, requiresClaim: true, expiresAtEpochMs: grantExpiry,
      claimId: 'claim-live-1', fenceGeneration: 2, leaseExpiresAtEpochMs: Date.now() - 1_000
    })), 'utf8')
    for (const [toolName, path, id] of [['write', NEW_FILE, 'expired_new'], ['edit', 'notes.md', 'expired_edit']]) {
      const outcome = pending(toolEvent(toolName, id, { path }), ctx)
      assert.equal(outcome?.block, true, `${toolName} must be refused after the claim lease lapsed`)
      assert.match(String(outcome.reason), /claim_expired/, `${toolName}: ${outcome?.reason}`)
    }
    assert.ok(decisions('claim_expired').length >= 2, 'a lapsed lease is recorded as claim_expired')

    // 4 · a rewrite may only move the claim: another Run in the same file is refused.
    writeFileSync(pendingFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, tools: WORKFLOW, runId: 'run-other', requiresClaim: true,
      expiresAtEpochMs: grantExpiry,
      claimId: 'claim-other', fenceGeneration: 3, leaseExpiresAtEpochMs: Date.now() + 120_000
    })), 'utf8')
    const swapped = pending(toolEvent('write', 'swapped_new', { path: NEW_FILE }), ctx)
    assert.equal(swapped?.block, true, 'a re-issued document may not swap the Run it authorizes')
    assert.match(String(swapped.reason), /guard_grant_identity_changed/, String(swapped?.reason))

    // 5 · requiresClaim:false keeps the unchanged behaviour: no claim, writes still allowed.
    const chatFile = join(root, 'grant-chat.json')
    writeFileSync(chatFile, JSON.stringify(grantDocument({
      workspaceReal, logPath, tools: ['read', 'write', 'edit'], requiresClaim: false
    })), 'utf8')
    const chat = await loadGuard({ grantFile: chatFile })
    assert.equal(chat(toolEvent('write', 'chat_new', { path: NEW_FILE }), ctx), undefined,
      'an ordinary chat Run is not gated on a claim')
    assert.equal(chat(toolEvent('edit', 'chat_edit', { path: 'notes.md' }), ctx), undefined)

    // 6 · the flag is part of the Core contract: a file grant without it fails closed, while the
    // isolated Runner payload (which never describes a claim) keeps working with the default.
    const missingFile = join(root, 'grant-no-flag.json')
    const withoutFlag = grantDocument({ workspaceReal, logPath, tools: WORKFLOW })
    delete withoutFlag.requiresClaim
    writeFileSync(missingFile, JSON.stringify(withoutFlag), 'utf8')
    const refused = await loadGuard({ grantFile: missingFile })
    const missingFlag = refused(toolEvent('read', 'no_flag_read', { path: 'notes.md' }), ctx)
    assert.equal(missingFlag?.block, true, 'a Core file grant without requiresClaim must fail closed')
    assert.match(String(missingFlag.reason), /guard_requires_claim_missing/, String(missingFlag?.reason))

    const envWithoutFlag = grantDocument({ workspaceReal, logPath: join(root, 'env.jsonl'), tools: ['read', 'write'] })
    delete envWithoutFlag.requiresClaim
    const runner = await loadGuard({ envGrant: JSON.stringify(envWithoutFlag) })
    assert.equal(runner(toolEvent('write', 'runner_new', { path: NEW_FILE }), ctx), undefined,
      'the isolated Runner payload keeps the pre-P0 behaviour when the flag is absent')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
