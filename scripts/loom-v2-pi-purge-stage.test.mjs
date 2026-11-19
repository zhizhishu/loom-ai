// LOOM V2 Lane A — tests for the Pi Purge read-only source lock + isolated stager.
//
// Isolation contract for this file:
// - Every fixture lives under a fresh mkdtemp directory; nothing here reads or
//   writes the real user ~/.pi, a user database, or a deployment target.
// - The only non-fixture read is a dry-run plan against the locked read-only
//   mirror _artifacts/reference-repos/pi-purge-current (skipped when absent).
//   That test writes nothing and asserts the target directory is never created.
// - No upstream pi-purge code is imported or executed, no model is called, no
//   network is used, no shell/MCP/device tool is touched.
// - Staging proves copied bytes only; loaded / activated / promptSeen stay false.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PI_PURGE_COPY_SET,
  PI_PURGE_SOURCE_LOCK,
  STAGE_EVIDENCE_CEILING,
  STAGE_MANIFEST_FILE,
  StageError,
  computeTreeSha256,
  planStage,
  readGitHead,
  runCli,
  stagePlugin,
  verifyStage
} from './loom-v2-pi-purge-stage.mjs'

const COMMIT = PI_PURGE_SOURCE_LOCK.sourceCommit
const MIRROR = resolve(fileURLToPath(new URL('..', import.meta.url)), '_artifacts', 'reference-repos', 'pi-purge-current')

const LICENSE_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 ZiChuanLan',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction.',
  ''
].join('\n')

const ENTRY_TEXT = [
  'export default function piPurge(pi) {',
  '\tlet enabled = false;',
  '\tpi.on("session_start", async () => { enabled = false; });',
  '\tpi.on("before_agent_start", async (event) => { return event; });',
  '\tpi.registerCommand("purge", { handler: async () => {} });',
  '}',
  ''
].join('\n')

function packageJsonText(overrides = {}) {
  return `${JSON.stringify({
    name: 'pi-purge',
    version: '0.3.0',
    type: 'module',
    license: 'MIT',
    engines: { node: '>=22.19.0' },
    peerDependencies: { '@earendil-works/pi-coding-agent': '>=0.80.0 <2' },
    pi: { extensions: ['./extensions/pi-purge.ts'] },
    ...overrides
  }, null, 2)}\n`
}

function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** Build a throwaway "locked mirror" with its own git metadata. */
function makeRepo({ files = {}, commit = COMMIT, ref = 'refs/heads/main', packed = false, gitFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loom-pi-purge-src-'))
  const contents = {
    'package.json': packageJsonText(),
    LICENSE: LICENSE_TEXT,
    'extensions/pi-purge.ts': ENTRY_TEXT,
    ...files
  }
  for (const [relPath, text] of Object.entries(contents)) {
    if (text === null) continue
    const target = join(root, ...relPath.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  const gitDir = gitFile ? join(root, 'gitdata') : join(root, '.git')
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(gitDir, 'HEAD'), `ref: ${ref}\n`)
  if (packed) {
    writeFileSync(join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${commit} ${ref}\n`)
  } else {
    writeFileSync(join(gitDir, ...ref.split('/')), `${commit}\n`)
  }
  if (gitFile) writeFileSync(join(root, '.git'), 'gitdir: ./gitdata\n')
  return root
}

function makeIsolatedRoot() {
  return mkdtempSync(join(tmpdir(), 'loom-pi-purge-out-'))
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

function expectStageError(fn, code) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null, `expected StageError ${code}, but the call succeeded`)
  assert.ok(caught instanceof StageError, `expected StageError ${code}, got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.code, code, caught.message)
  return caught
}

test('dry-run plan on a fake locked repo writes nothing and stays at staged_files_only', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'pi-purge-0.3.0')

  const plan = planStage({ sourceDir: source, outputDir: output, outputRoot: root })

  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'dry-run')
  assert.equal(plan.action, 'stage-pi-purge')
  assert.equal(plan.source.commit, COMMIT)
  assert.equal(plan.source.packageVersion, '0.3.0')
  assert.equal(plan.source.license, 'MIT')
  assert.deepEqual(plan.files.map((file) => file.path), [...PI_PURGE_COPY_SET])
  assert.match(plan.treeSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(plan.writes, [])
  assert.deepEqual(plan.evidence, STAGE_EVIDENCE_CEILING)
  assert.equal(plan.evidence.loaded, false)
  assert.equal(plan.evidence.promptSeen, false)
  assert.equal(lstatOrNull(output), null, 'dry-run must not create the output directory')
  assert.deepEqual(readFileSync(join(source, 'package.json'), 'utf8'), packageJsonText())
})

test('per-file static digests match the bytes actually read', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const plan = planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: root })

  const expected = new Map([
    ['package.json', packageJsonText()],
    ['LICENSE', LICENSE_TEXT],
    ['extensions/pi-purge.ts', ENTRY_TEXT]
  ])
  for (const file of plan.files) {
    const text = expected.get(file.path)
    assert.equal(file.bytes, Buffer.byteLength(text, 'utf8'), `${file.path} size`)
    assert.equal(file.sha256, sha256Hex(text), `${file.path} sha256`)
  }
  assert.equal(plan.treeSha256, computeTreeSha256(plan.files))
})

test('computeTreeSha256 is order independent and covers size plus digest', () => {
  const left = { path: 'a.txt', bytes: 3, sha256: 'a'.repeat(64) }
  const right = { path: 'b.txt', bytes: 4, sha256: 'b'.repeat(64) }
  assert.equal(computeTreeSha256([left, right]), computeTreeSha256([right, left]))
  assert.notEqual(computeTreeSha256([left, right]), computeTreeSha256([{ ...left, bytes: 5 }, right]))
  assert.notEqual(computeTreeSha256([left, right]), computeTreeSha256([{ ...left, sha256: 'c'.repeat(64) }, right]))
})

test('readGitHead resolves a loose ref to the pinned commit', () => {
  const source = makeRepo()
  const head = readGitHead(source)
  assert.equal(head.commit, COMMIT)
  assert.equal(head.ref, 'refs/heads/main')
  assert.equal(head.resolvedFrom, 'ref:refs/heads/main')
})

test('readGitHead resolves a packed-refs only checkout', () => {
  const source = makeRepo({ packed: true })
  const head = readGitHead(source)
  assert.equal(head.commit, COMMIT)
  assert.equal(head.resolvedFrom, 'packed-refs:refs/heads/main')
})

test('readGitHead follows a gitdir pointer file', () => {
  const source = makeRepo({ gitFile: true })
  const head = readGitHead(source)
  assert.equal(head.commit, COMMIT)
})

test('commit drift is rejected instead of silently staged', () => {
  const source = makeRepo({ commit: 'f'.repeat(40) })
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: root }), 'source_drift_commit')
})

test('package version drift is rejected', () => {
  const source = makeRepo({ files: { 'package.json': packageJsonText({ version: '0.3.1' }) } })
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: root }), 'source_drift_version')
})

test('non-MIT LICENSE is rejected', () => {
  const source = makeRepo({ files: { LICENSE: 'Apache License\nVersion 2.0, January 2004\n' } })
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: root }), 'source_drift_license')
})

test('peer range drift is rejected', () => {
  const source = makeRepo({
    files: { 'package.json': packageJsonText({ peerDependencies: { '@earendil-works/pi-coding-agent': '>=0.90.0 <2' } }) }
  })
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: root }), 'source_drift_peer')
})

test('missing extension entry is rejected', () => {
  const source = makeRepo({ files: { 'extensions/pi-purge.ts': null } })
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: root }), 'source_file_missing')
})

test('a symlinked source file is rejected', (t) => {
  const source = makeRepo({ files: { 'extensions/pi-purge.ts': null } })
  const outside = mkdtempSync(join(tmpdir(), 'loom-pi-purge-outside-'))
  const outsideEntry = join(outside, 'pi-purge.ts')
  writeFileSync(outsideEntry, ENTRY_TEXT)
  mkdirSync(join(source, 'extensions'), { recursive: true })
  if (!trySymlink(outsideEntry, join(source, 'extensions', 'pi-purge.ts'), 'file')) {
    t.skip('symlinks are not permitted on this host')
    return
  }
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: root }), 'source_symlink')
})

test('a symlinked source directory is rejected', (t) => {
  const source = makeRepo()
  const linkRoot = mkdtempSync(join(tmpdir(), 'loom-pi-purge-link-'))
  const link = join(linkRoot, 'mirror-link')
  if (!trySymlink(source, link, 'dir')) {
    t.skip('symlinks are not permitted on this host')
    return
  }
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ sourceDir: link, outputDir: join(root, 'stage'), outputRoot: root }), 'source_symlink')
})

test('missing and relative source paths are refused (no default source)', () => {
  const root = makeIsolatedRoot()
  expectStageError(() => planStage({ outputDir: join(root, 'stage'), outputRoot: root }), 'source_missing')
  expectStageError(() => planStage({ sourceDir: join(root, 'absent'), outputDir: join(root, 'stage'), outputRoot: root }), 'source_missing')
  expectStageError(() => planStage({ sourceDir: 'relative/mirror', outputDir: join(root, 'stage'), outputRoot: root }), 'source_not_absolute')
})

test('a missing or relative output root is refused', () => {
  const source = makeRepo()
  expectStageError(() => planStage({ sourceDir: source, outputDir: 'stage' }), 'output_missing_root')
  expectStageError(
    () => planStage({ sourceDir: source, outputDir: 'stage', outputRoot: 'relative-root' }),
    'output_not_absolute'
  )
  const root = makeIsolatedRoot()
  expectStageError(
    () => planStage({ sourceDir: source, outputDir: join(root, 'stage'), outputRoot: join(root, 'absent-root') }),
    'output_missing_root'
  )
})

test("'..' segments in the output path are refused", () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const escaping = `${root}${process.platform === 'win32' ? '\\' : '/'}..${process.platform === 'win32' ? '\\' : '/'}escape`
  expectStageError(() => planStage({ sourceDir: source, outputDir: escaping, outputRoot: root }), 'output_traversal')
})

test('an output outside the isolated root is refused', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const elsewhere = mkdtempSync(join(tmpdir(), 'loom-pi-purge-elsewhere-'))
  expectStageError(
    () => planStage({ sourceDir: source, outputDir: join(elsewhere, 'stage'), outputRoot: root }),
    'output_outside_root'
  )
  expectStageError(() => planStage({ sourceDir: source, outputDir: root, outputRoot: root }), 'output_outside_root')
})

test('an output inside the read-only source is refused', () => {
  const source = makeRepo()
  expectStageError(
    () => planStage({ sourceDir: source, outputDir: join(source, 'staging'), outputRoot: source }),
    'output_inside_source'
  )
})

test('an existing non-empty output is refused', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'stage')
  mkdirSync(output)
  writeFileSync(join(output, 'leftover.txt'), 'old run\n')
  expectStageError(() => planStage({ sourceDir: source, outputDir: output, outputRoot: root }), 'output_exists_non_empty')
})

test('a symlinked output target is refused', (t) => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const realDir = join(root, 'real-target')
  mkdirSync(realDir)
  const link = join(root, 'stage')
  if (!trySymlink(realDir, link, 'dir')) {
    t.skip('symlinks are not permitted on this host')
    return
  }
  expectStageError(() => planStage({ sourceDir: source, outputDir: link, outputRoot: root }), 'output_symlink')
})

test('an output inside the real user Pi state is refused', () => {
  const source = makeRepo()
  const home = mkdtempSync(join(tmpdir(), 'loom-pi-purge-home-'))
  const outputRoot = join(home, '.pi', 'sandbox')
  mkdirSync(outputRoot, { recursive: true })
  expectStageError(
    () => planStage({ sourceDir: source, outputDir: join(outputRoot, 'stage'), outputRoot, homeDir: home }),
    'output_forbidden_user_pi'
  )
})

test('--apply stages the exact bytes into the isolated root and verifies them', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'pi-purge-0.3.0')

  const plan = planStage({ sourceDir: source, outputDir: output, outputRoot: root })
  const staged = stagePlugin({ sourceDir: source, outputDir: output, outputRoot: root })

  assert.equal(staged.mode, 'apply')
  assert.equal(staged.treeSha256, plan.treeSha256)
  assert.deepEqual(staged.writes.length, PI_PURGE_COPY_SET.length + 1)
  assert.deepEqual(staged.evidence, STAGE_EVIDENCE_CEILING)
  assert.equal(readFileSync(join(output, 'extensions', 'pi-purge.ts'), 'utf8'), ENTRY_TEXT)
  assert.equal(readFileSync(join(output, 'LICENSE'), 'utf8'), LICENSE_TEXT)

  const manifest = JSON.parse(readFileSync(join(output, STAGE_MANIFEST_FILE), 'utf8'))
  assert.equal(manifest.sourceCommit, COMMIT)
  assert.equal(manifest.packageVersion, '0.3.0')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.isolated, true)
  assert.equal(manifest.evidence.loaded, false)
  assert.equal(manifest.evidence.promptSeen, false)
  assert.deepEqual(manifest.copiedFiles.map((file) => file.path), [...PI_PURGE_COPY_SET])

  const verified = verifyStage({ outputDir: output })
  assert.equal(verified.ok, true)
  assert.equal(verified.treeSha256, plan.treeSha256)
  assert.equal(verified.sourceCommit, COMMIT)
  assert.deepEqual(verified.evidence, STAGE_EVIDENCE_CEILING)
})

test('a second apply into the same directory is refused', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'stage')
  stagePlugin({ sourceDir: source, outputDir: output, outputRoot: root })
  expectStageError(() => stagePlugin({ sourceDir: source, outputDir: output, outputRoot: root }), 'output_exists_non_empty')
})

test('verify detects a tampered file', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'stage')
  stagePlugin({ sourceDir: source, outputDir: output, outputRoot: root })
  writeFileSync(join(output, 'LICENSE'), `${LICENSE_TEXT}tampered\n`)
  expectStageError(() => verifyStage({ outputDir: output }), 'verify_mismatch')
})

test('verify detects an extra file and a missing manifest', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'stage')
  stagePlugin({ sourceDir: source, outputDir: output, outputRoot: root })
  writeFileSync(join(output, 'extra.txt'), 'not part of the stage\n')
  expectStageError(() => verifyStage({ outputDir: output }), 'verify_extra_file')
  rmSync(join(output, 'extra.txt'))
  rmSync(join(output, STAGE_MANIFEST_FILE))
  expectStageError(() => verifyStage({ outputDir: output }), 'manifest_missing')
})

test('verify refuses a manifest that names a different commit', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'stage')
  stagePlugin({ sourceDir: source, outputDir: output, outputRoot: root })
  const manifestPath = join(output, STAGE_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.sourceCommit = 'f'.repeat(40)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  expectStageError(() => verifyStage({ outputDir: output }), 'source_drift_commit')
})

test('CLI defaults to dry-run, applies only with --apply, and verifies afterwards', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'stage')
  const base = ['--source', source, '--output', output, '--output-root', root]

  const planned = runCli(base)
  assert.equal(planned.mode, 'dry-run')
  assert.equal(lstatOrNull(output), null)

  const applied = runCli([...base, '--apply'])
  assert.equal(applied.mode, 'apply')

  const verified = runCli(['--verify', output])
  assert.equal(verified.mode, 'verify')
  assert.equal(verified.treeSha256, applied.treeSha256)

  const help = runCli(['--help'])
  assert.equal(help.mode, 'help')
  assert.match(help.usage, /--output-root/)
})

test('CLI rejects unknown arguments, a foreign --commit and an invalid --tree-sha256', () => {
  const source = makeRepo()
  const root = makeIsolatedRoot()
  const output = join(root, 'stage')
  expectStageError(() => runCli(['--bogus']), 'cli_unknown_argument')
  expectStageError(
    () => runCli(['--source', source, '--output', output, '--output-root', root, '--commit', 'f'.repeat(40)]),
    'source_drift_commit'
  )
  expectStageError(
    () => runCli(['--source', source, '--output', output, '--output-root', root, '--tree-sha256', 'not-a-digest']),
    'cli_invalid_tree_sha256'
  )
})

test('the locked read-only mirror dry-runs to the pinned identity', (t) => {
  if (!lstatOrNull(MIRROR)) {
    t.skip(`locked mirror is absent: ${MIRROR}`)
    return
  }
  const root = makeIsolatedRoot()
  const output = join(root, 'pi-purge-0.3.0')
  const plan = planStage({ sourceDir: MIRROR, outputDir: output, outputRoot: root })

  assert.equal(plan.source.commit, PI_PURGE_SOURCE_LOCK.sourceCommit)
  assert.equal(plan.source.packageVersion, PI_PURGE_SOURCE_LOCK.packageVersion)
  assert.equal(plan.source.license, PI_PURGE_SOURCE_LOCK.license)
  assert.deepEqual(plan.files.map((file) => file.path), [...PI_PURGE_COPY_SET])
  assert.match(plan.treeSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(plan.writes, [])
  assert.equal(plan.evidence.loaded, false)
  assert.equal(lstatOrNull(output), null, 'the mirror dry-run must not create anything')
})
