// LOOM V2 Lane A — Pi Purge read-only source lock + isolated private stager.
//
// Invariants (docs/loom/LOOM-V2-P1B-PI-RUNTIME-INTEGRATION-2026-11-15.md, Lane A):
// - The upstream mirror is read-only input. This module never writes to it, never
//   executes its code, never installs it into a Pi runtime, and never touches the
//   real user Pi state (~/.pi), a user database, or a deployment target.
// - The locked mirror lives at loom/_artifacts/reference-repos/pi-purge-current.
//   --source has NO default: guessing a parent path would silently stage the wrong
//   tree, so the operator must pass the mirror explicitly.
// - Only package.json, LICENSE and extensions/pi-purge.ts are copied. `.git`,
//   `test/` and the READMEs stay out of the staged tree.
// - Pinned identity: commit d0196ccfd773b0ed342bd2f25372aff65f1a4a53, package
//   0.3.0, MIT. Any drift fails closed with a StageError code.
// - Static digests are computed from the bytes actually read (size + sha256 per
//   file plus a `path\tbytes\tsha256` tree digest, same convention as
//   scripts/package-embedded-pi.mjs:192-207). No digest is hard-coded here, so a
//   stale constant can never rubber-stamp a changed file.
// - Output guards fail closed: explicit --output-root, output strictly inside it,
//   no '..' segments, no symlinked target or ancestor, never inside the real user
//   ~/.pi, never inside the source, and an existing non-empty target is refused.
// - Dry-run is the default. Real copying requires --apply and only ever writes
//   below the operator-supplied isolated root (e.g. .../p1b-sandbox).
// - Copying bytes is NOT loading a Pi extension. The evidence ceiling is
//   'staged_files_only': loaded / activated / promptSeen stay false. Real extension
//   loading and hook activation belong to the Lane D worker.
// - Deleting this file and its test fully reverts the feature; no other file,
//   including scripts/package-embedded-pi.mjs, is modified or depended on.

import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PI_PURGE_SOURCE_LOCK = Object.freeze({
  extensionId: 'pi-purge',
  sourceCommit: 'd0196ccfd773b0ed342bd2f25372aff65f1a4a53',
  sourceRepo: 'https://github.com/ZiChuanLan/pi-purge',
  packageName: 'pi-purge',
  packageVersion: '0.3.0',
  license: 'MIT',
  licenseCopyright: 'ZiChuanLan',
  nodeEngine: '>=22.19.0',
  peerName: '@earendil-works/pi-coding-agent',
  peerRange: '>=0.80.0 <2',
  entry: 'extensions/pi-purge.ts'
})

// Exactly the upstream runtime closure we are willing to copy. Anything else
// (.git, test/, README*.md) is intentionally excluded.
export const PI_PURGE_COPY_SET = Object.freeze(['package.json', 'LICENSE', 'extensions/pi-purge.ts'])

export const STAGE_MANIFEST_FILE = 'stage-manifest.json'
export const STAGE_MANIFEST_SCHEMA = 'loom.v2alpha1/pi-purge-stage-manifest'
export const MAX_STATIC_FILE_BYTES = 1024 * 1024

// Hard ceiling for what a successful stage may claim. Copying files can never
// prove that Pi loaded the extension or that a provider saw a prompt.
export const STAGE_EVIDENCE_CEILING = Object.freeze({
  status: 'staged_files_only',
  loaded: false,
  activated: false,
  promptSeen: false,
  providerRequest: false,
  note: 'copied plugin files are not a loaded Pi extension and never prove a provider prompt'
})

export const USAGE = [
  'usage:',
  '  node scripts/loom-v2-pi-purge-stage.mjs --source <locked mirror dir> --output <dir> --output-root <isolated root> [--apply] [--commit <sha40>] [--tree-sha256 <hex64>]',
  '  node scripts/loom-v2-pi-purge-stage.mjs --verify <staged dir>',
  '',
  '--source has no default: the locked mirror is loom/_artifacts/reference-repos/pi-purge-current and must be passed explicitly.',
  'Without --apply the run is a dry-run plan and writes nothing.',
  '--output must be a child of --output-root; the root must be an isolated sandbox such as skill-cli/_artifacts/loom-v2-20261115/p1b-sandbox.',
  'Only package.json, LICENSE and extensions/pi-purge.ts are copied. No upstream code is executed.'
].join('\n')

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/

export class StageError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`)
    this.name = 'StageError'
    this.code = code
    this.detail = detail
  }
}

function fail(code, detail) {
  throw new StageError(code, detail)
}

function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

function realpathOf(target) {
  const native = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
  return native(target)
}

function isWithin(parent, child) {
  if (parent === child) return true
  const prefix = parent.endsWith('\\') || parent.endsWith('/') ? parent : `${parent}${process.platform === 'win32' ? '\\' : '/'}`
  return child.startsWith(prefix)
}

/** Real path of the deepest existing ancestor, plus the not-yet-existing tail. */
function realpathDeepestExisting(target) {
  let current = resolve(target)
  const tail = []
  for (;;) {
    if (lstatOrNull(current)) {
      const base = realpathOf(current)
      if (tail.length === 0) return base
      return join(base, ...tail.reverse())
    }
    const parent = dirname(current)
    if (parent === current) fail('path_unresolvable', target)
    tail.push(basename(current))
    current = parent
  }
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Tree digest over sorted `path\tbytes\tsha256\n` rows (package-embedded-pi convention). */
export function computeTreeSha256(entries) {
  const digest = createHash('sha256')
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  for (const entry of sorted) digest.update(`${entry.path}\t${entry.bytes}\t${entry.sha256}\n`)
  return digest.digest('hex')
}

/** Fail closed on any path that could escape its root once joined. */
export function assertPlainRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) fail('path_unsafe', `not a non-empty string: ${String(value)}`)
  if (value.includes('\0')) fail('path_unsafe', 'NUL byte in path')
  if (value.includes('\\')) fail('path_unsafe', `backslash not allowed: ${value}`)
  if (isAbsolute(value)) fail('path_unsafe', `absolute path not allowed: ${value}`)
  if (/^[A-Za-z]:/.test(value)) fail('path_unsafe', `drive letter not allowed: ${value}`)
  if (value.startsWith('~')) fail('path_unsafe', `home reference not allowed: ${value}`)
  for (const segment of value.split('/')) {
    if (segment === '') fail('path_unsafe', `empty segment in ${value}`)
    if (segment === '.' || segment === '..') fail('path_unsafe', `traversal segment in ${value}`)
  }
  return value
}

function assertNoTraversalSegments(label, value) {
  if (typeof value !== 'string' || value.length === 0) fail('output_invalid', `${label} must be a non-empty string`)
  if (value.includes('\0')) fail('output_invalid', `${label} contains a NUL byte`)
  for (const segment of value.split(/[\\/]+/)) {
    if (segment === '..') fail('output_traversal', `${label} contains '..': ${value}`)
  }
  return value
}

/** Resolve the git metadata directory of a plain checkout or a gitdir pointer. */
function resolveGitDir(sourceRoot) {
  const gitPath = join(sourceRoot, '.git')
  const stats = lstatOrNull(gitPath)
  if (!stats) fail('git_metadata_missing', `${gitPath} not found`)
  if (stats.isSymbolicLink()) fail('git_metadata_symlink', gitPath)
  if (stats.isDirectory()) return gitPath
  if (!stats.isFile()) fail('git_metadata_missing', `${gitPath} is neither a file nor a directory`)
  const text = readFileSync(gitPath, 'utf8')
  const match = /^gitdir:\s*(.+)$/m.exec(text)
  if (!match) fail('git_metadata_missing', `${gitPath} has no gitdir pointer`)
  const resolved = realpathDeepestExisting(resolve(sourceRoot, match[1].trim()))
  if (!isWithin(sourceRoot, resolved)) fail('git_metadata_escape', `${resolved} is outside ${sourceRoot}`)
  return resolved
}

/**
 * Read the commit recorded by the source repository's git metadata without
 * invoking git or a shell. Only a 40-hex commit is ever returned.
 */
export function readGitHead(sourceDir) {
  const sourceRoot = realpathOf(sourceDir)
  const gitDir = resolveGitDir(sourceRoot)
  const headPath = join(gitDir, 'HEAD')
  const headStats = lstatOrNull(headPath)
  if (!headStats) fail('git_metadata_missing', `${headPath} not found`)
  if (headStats.isSymbolicLink() || !headStats.isFile()) fail('git_metadata_missing', `${headPath} is not a regular file`)
  const headText = readFileSync(headPath, 'utf8').trim()
  const refMatch = /^ref:\s*(\S+)$/.exec(headText)
  let commit = null
  let ref = null
  let resolvedFrom = null
  if (refMatch) {
    ref = refMatch[1]
    const loosePath = join(gitDir, ...ref.split('/'))
    const looseStats = lstatOrNull(loosePath)
    if (looseStats && looseStats.isFile() && !looseStats.isSymbolicLink()) {
      const looseText = readFileSync(loosePath, 'utf8').trim()
      if (HEX40.test(looseText)) {
        commit = looseText
        resolvedFrom = `ref:${ref}`
      }
    }
    if (commit === null) {
      const packedPath = join(gitDir, 'packed-refs')
      const packedStats = lstatOrNull(packedPath)
      if (!packedStats || !packedStats.isFile() || packedStats.isSymbolicLink()) {
        fail('git_metadata_missing', `${ref} is not in loose refs and packed-refs is unavailable`)
      }
      for (const line of readFileSync(packedPath, 'utf8').split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 2 && HEX40.test(parts[0]) && parts[1] === ref) {
          commit = parts[0]
          resolvedFrom = `packed-refs:${ref}`
          break
        }
      }
      if (commit === null) fail('git_metadata_missing', `${ref} not found in packed-refs`)
    }
  } else if (HEX40.test(headText)) {
    commit = headText
    resolvedFrom = 'detached'
  } else {
    fail('git_metadata_missing', `unparsable HEAD: ${headText}`)
  }
  if (!HEX40.test(commit)) fail('git_metadata_missing', `invalid commit: ${commit}`)
  return { commit, ref, resolvedFrom, gitDir }
}

function parseJson(buffer, label, code) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(code, `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Read one pinned source file: no symlink in any segment, size bounded, bytes hashed. */
function readSourceFile(sourceRoot, relPath) {
  assertPlainRelativePath(relPath)
  let current = sourceRoot
  for (const segment of relPath.split('/')) {
    current = join(current, segment)
    const stats = lstatOrNull(current)
    if (!stats) fail('source_file_missing', `${relPath} (missing segment ${segment})`)
    if (stats.isSymbolicLink()) fail('source_symlink', `${relPath} (symlinked segment ${segment})`)
  }
  const absolute = join(sourceRoot, ...relPath.split('/'))
  const stats = lstatSync(absolute)
  if (!stats.isFile()) fail('source_not_regular_file', relPath)
  if (stats.size === 0) fail('source_file_empty', relPath)
  if (stats.size > MAX_STATIC_FILE_BYTES) fail('source_file_too_large', `${relPath} is ${stats.size} bytes`)
  const buffer = readFileSync(absolute)
  if (buffer.length !== stats.size) fail('source_size_drift', `${relPath} lstat ${stats.size} != read ${buffer.length}`)
  return { path: relPath, absolute, size: buffer.length, sha256: sha256Hex(buffer), buffer }
}

function assertLockedPackage(packageJson) {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) fail('source_invalid_package', 'package.json is not an object')
  if (packageJson.name !== PI_PURGE_SOURCE_LOCK.packageName) fail('source_drift_package', `name ${String(packageJson.name)}`)
  if (packageJson.version !== PI_PURGE_SOURCE_LOCK.packageVersion) fail('source_drift_version', `${String(packageJson.version)} != ${PI_PURGE_SOURCE_LOCK.packageVersion}`)
  if (packageJson.license !== PI_PURGE_SOURCE_LOCK.license) fail('source_drift_license', `package license ${String(packageJson.license)}`)
  const engine = packageJson.engines && packageJson.engines.node
  if (engine !== PI_PURGE_SOURCE_LOCK.nodeEngine) fail('source_drift_engine', `${String(engine)} != ${PI_PURGE_SOURCE_LOCK.nodeEngine}`)
  const peer = packageJson.peerDependencies && packageJson.peerDependencies[PI_PURGE_SOURCE_LOCK.peerName]
  if (peer !== PI_PURGE_SOURCE_LOCK.peerRange) fail('source_drift_peer', `${String(peer)} != ${PI_PURGE_SOURCE_LOCK.peerRange}`)
  const declared = packageJson.pi && packageJson.pi.extensions
  if (!Array.isArray(declared)) fail('source_drift_entry', 'pi.extensions is not an array')
  const normalized = declared.map((value) => String(value).replace(/^\.\//, ''))
  if (!normalized.includes(PI_PURGE_SOURCE_LOCK.entry)) fail('source_drift_entry', `pi.extensions ${JSON.stringify(declared)}`)
}

function assertLockedLicense(text) {
  if (!/^MIT License\s*$/m.test(text)) fail('source_drift_license', 'LICENSE does not start with "MIT License"')
  if (!text.includes(PI_PURGE_SOURCE_LOCK.licenseCopyright)) fail('source_drift_license', `LICENSE does not credit ${PI_PURGE_SOURCE_LOCK.licenseCopyright}`)
  if (!text.includes('Permission is hereby granted')) fail('source_drift_license', 'LICENSE lacks the MIT grant paragraph')
}

function assertLockedEntry(text) {
  if (!/export default function/.test(text)) fail('source_drift_entry_content', 'extension does not export a default function')
  if (!/session_start/.test(text)) fail('source_drift_entry_content', 'extension does not register session_start')
  if (!/before_agent_start/.test(text)) fail('source_drift_entry_content', 'extension does not register before_agent_start')
  if (!/registerCommand\(\s*["']purge["']/.test(text)) fail('source_drift_entry_content', 'extension does not register the purge command')
}

/**
 * Read-only inspection of the locked mirror: git commit, package identity,
 * LICENSE and entry contents, plus per-file size/sha256 and a tree digest.
 * Returns internal `entries` (with buffers) so a stage can write the exact bytes
 * that were hashed instead of re-reading the source.
 */
export function inspectSource({ sourceDir, expectedTreeSha256 } = {}) {
  if (typeof sourceDir !== 'string' || sourceDir.trim() === '') {
    fail('source_missing', '--source is required; this stager has no default source path')
  }
  assertNoTraversalSegments('sourceDir', sourceDir)
  if (!isAbsolute(sourceDir)) fail('source_not_absolute', sourceDir)
  const rootStats = lstatOrNull(sourceDir)
  if (!rootStats) fail('source_missing', sourceDir)
  if (rootStats.isSymbolicLink()) fail('source_symlink', `sourceDir ${sourceDir}`)
  if (!rootStats.isDirectory()) fail('source_not_directory', sourceDir)
  const sourceRoot = realpathOf(sourceDir)

  const git = readGitHead(sourceRoot)
  if (git.commit !== PI_PURGE_SOURCE_LOCK.sourceCommit) {
    fail('source_drift_commit', `${git.commit} != ${PI_PURGE_SOURCE_LOCK.sourceCommit}`)
  }

  const entries = PI_PURGE_COPY_SET.map((relPath) => readSourceFile(sourceRoot, relPath))
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  assertLockedPackage(parseJson(byPath.get('package.json').buffer, 'package.json', 'source_invalid_package'))
  assertLockedLicense(byPath.get('LICENSE').buffer.toString('utf8'))
  assertLockedEntry(byPath.get(PI_PURGE_SOURCE_LOCK.entry).buffer.toString('utf8'))

  const files = entries.map((entry) => ({ path: entry.path, bytes: entry.size, sha256: entry.sha256 }))
  const treeSha256 = computeTreeSha256(files)
  if (expectedTreeSha256 !== undefined) {
    if (typeof expectedTreeSha256 !== 'string' || !HEX64.test(expectedTreeSha256)) fail('source_drift_tree', `expected tree is not a sha256 hex digest: ${String(expectedTreeSha256)}`)
    if (treeSha256 !== expectedTreeSha256) fail('source_drift_tree', `${treeSha256} != ${expectedTreeSha256}`)
  }

  return {
    ok: true,
    sourceDir: sourceRoot,
    commit: git.commit,
    ref: git.ref,
    resolvedFrom: git.resolvedFrom,
    packageVersion: PI_PURGE_SOURCE_LOCK.packageVersion,
    license: PI_PURGE_SOURCE_LOCK.license,
    files,
    treeSha256,
    evidence: STAGE_EVIDENCE_CEILING,
    entries
  }
}

/**
 * Fail-closed output guard. The operator must name the isolated root explicitly;
 * the target must be a fresh child directory of that root.
 */
export function assertOutputTarget({ outputDir, outputRoot, sourceDir, homeDir } = {}) {
  if (typeof outputRoot !== 'string' || outputRoot.trim() === '') {
    fail('output_missing_root', '--output-root is required and must be supplied explicitly by the operator')
  }
  assertNoTraversalSegments('outputRoot', outputRoot)
  if (!isAbsolute(outputRoot)) fail('output_not_absolute', `outputRoot ${outputRoot}`)
  if (typeof outputDir !== 'string' || outputDir.trim() === '') fail('output_invalid', '--output is required')
  assertNoTraversalSegments('outputDir', outputDir)
  if (!isAbsolute(outputDir)) fail('output_not_absolute', `outputDir ${outputDir}`)

  const rootStats = lstatOrNull(outputRoot)
  if (!rootStats) fail('output_missing_root', `${outputRoot} does not exist`)
  if (rootStats.isSymbolicLink()) fail('output_symlink', `outputRoot ${outputRoot} is a symbolic link`)
  if (!rootStats.isDirectory()) fail('output_missing_root', `outputRoot ${outputRoot} is not a directory`)
  const rootReal = realpathOf(outputRoot)

  const outputResolved = resolve(outputDir)
  const outputReal = realpathDeepestExisting(outputResolved)
  if (!isWithin(rootReal, outputReal)) fail('output_outside_root', `${outputReal} is not inside ${rootReal}`)
  if (outputReal === rootReal) fail('output_outside_root', 'output must be a child directory of outputRoot, not the root itself')

  if (typeof sourceDir === 'string' && sourceDir.trim() !== '' && lstatOrNull(sourceDir)) {
    const sourceReal = realpathOf(sourceDir)
    if (isWithin(sourceReal, outputReal) || isWithin(outputReal, sourceReal)) {
      fail('output_inside_source', `${outputReal} overlaps the read-only source ${sourceReal}`)
    }
  }

  const home = typeof homeDir === 'string' && homeDir.trim() !== '' ? resolve(homeDir) : homedir()
  const userPi = resolve(home, '.pi')
  const userPiReal = lstatOrNull(userPi) ? realpathOf(userPi) : userPi
  if (isWithin(userPiReal, outputReal)) fail('output_forbidden_user_pi', `${outputReal} is inside the real user Pi state ${userPiReal}`)

  const outputStats = lstatOrNull(outputResolved)
  let exists = false
  let empty = true
  if (outputStats) {
    if (outputStats.isSymbolicLink()) fail('output_symlink', `${outputResolved} is a symbolic link`)
    if (!outputStats.isDirectory()) fail('output_not_directory', `${outputResolved} is not a directory`)
    const children = readdirSync(outputResolved)
    exists = true
    empty = children.length === 0
    if (!empty) fail('output_exists_non_empty', `${outputResolved} already contains ${children.length} entries`)
  } else {
    // Walk the real-cased target so an existing symlinked ancestor is caught even
    // when the operator typed the path with different case.
    let current = outputReal
    while (current !== rootReal && isWithin(rootReal, current)) {
      const stats = lstatOrNull(current)
      if (stats && stats.isSymbolicLink()) fail('output_symlink', `${current} is a symbolic link`)
      if (stats && !stats.isDirectory()) fail('output_not_directory', `${current} is not a directory`)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  return { outputDir: outputResolved, outputReal, outputRoot: rootReal, exists, empty }
}

function publicSource(source) {
  return {
    dir: source.sourceDir,
    commit: source.commit,
    ref: source.ref,
    resolvedFrom: source.resolvedFrom,
    packageVersion: source.packageVersion,
    license: source.license
  }
}

function prepare(options = {}) {
  const source = inspectSource(options)
  const output = assertOutputTarget({
    outputDir: options.outputDir,
    outputRoot: options.outputRoot,
    sourceDir: source.sourceDir,
    homeDir: options.homeDir
  })
  return { source, output }
}

/** Dry-run plan: reads and guards everything, writes nothing. */
export function planStage(options = {}) {
  const { source, output } = prepare(options)
  return {
    ok: true,
    mode: 'dry-run',
    action: 'stage-pi-purge',
    source: publicSource(source),
    output: {
      dir: output.outputDir,
      root: output.outputRoot,
      exists: output.exists,
      empty: output.empty,
      manifest: join(output.outputDir, STAGE_MANIFEST_FILE)
    },
    files: source.files,
    treeSha256: source.treeSha256,
    writes: [],
    evidence: STAGE_EVIDENCE_CEILING
  }
}

function rollback(outputDir, createdFiles, createdDir) {
  for (const file of createdFiles) {
    try {
      rmSync(file, { force: true })
    } catch {
      // bounded cleanup: only files this run created under its own output dir
    }
  }
  if (createdDir) {
    try {
      rmdirSync(outputDir)
    } catch {
      // leave any nested directory the run created; nothing outside outputDir is touched
    }
  }
}

/** Real copy into the isolated target. Requires an explicit --apply. */
export function stagePlugin(options = {}) {
  const { source, output } = prepare(options)
  const createdFiles = []
  let createdDir = false
  try {
    if (!output.exists) {
      mkdirSync(output.outputDir, { recursive: true })
      createdDir = true
    }
    for (const entry of source.entries) {
      const target = join(output.outputDir, ...entry.path.split('/'))
      const parent = dirname(target)
      mkdirSync(parent, { recursive: true })
      const parentStats = lstatOrNull(parent)
      if (!parentStats || parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
        fail('output_symlink', `${parent} is not a plain directory`)
      }
      writeFileSync(target, entry.buffer, { flag: 'wx' })
      createdFiles.push(target)
      const written = readFileSync(target)
      const writtenSha256 = sha256Hex(written)
      if (written.length !== entry.size || writtenSha256 !== entry.sha256) {
        fail('stage_write_mismatch', `${entry.path} wrote ${written.length}/${writtenSha256}`)
      }
    }
    const manifest = {
      schema: STAGE_MANIFEST_SCHEMA,
      extensionId: PI_PURGE_SOURCE_LOCK.extensionId,
      sourceCommit: source.commit,
      sourceRef: source.ref,
      sourceResolvedFrom: source.resolvedFrom,
      sourceDir: source.sourceDir,
      packageVersion: source.packageVersion,
      license: source.license,
      copiedFiles: source.files,
      treeSha256: source.treeSha256,
      isolated: true,
      evidence: STAGE_EVIDENCE_CEILING,
      stagedAt: new Date().toISOString()
    }
    const manifestPath = join(output.outputDir, STAGE_MANIFEST_FILE)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    createdFiles.push(manifestPath)
    const verified = verifyStage({ outputDir: output.outputDir })
    return {
      ok: true,
      mode: 'apply',
      action: 'stage-pi-purge',
      source: publicSource(source),
      output: { dir: output.outputDir, root: output.outputRoot, manifest: manifestPath },
      files: source.files,
      treeSha256: source.treeSha256,
      manifestPath,
      writes: createdFiles,
      evidence: STAGE_EVIDENCE_CEILING,
      verified
    }
  } catch (error) {
    rollback(output.outputDir, createdFiles, createdDir)
    throw error
  }
}

function listStagedFiles(root, prefix = '') {
  const results = []
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relPath = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
    if (dirent.isSymbolicLink()) fail('verify_symlink', relPath)
    if (dirent.isDirectory()) {
      results.push(...listStagedFiles(root, relPath))
      continue
    }
    if (!dirent.isFile()) fail('verify_unexpected_entry', relPath)
    results.push(relPath)
  }
  return results.sort()
}

/** Recompute and compare a staged tree against its own manifest. */
export function verifyStage({ outputDir } = {}) {
  if (typeof outputDir !== 'string' || outputDir.trim() === '') fail('verify_output_missing', '--verify requires a staged directory')
  const rootStats = lstatOrNull(outputDir)
  if (!rootStats) fail('verify_output_missing', outputDir)
  if (rootStats.isSymbolicLink()) fail('verify_symlink', `outputDir ${outputDir}`)
  if (!rootStats.isDirectory()) fail('verify_output_missing', `${outputDir} is not a directory`)
  const root = realpathOf(outputDir)

  const manifestPath = join(root, STAGE_MANIFEST_FILE)
  const manifestStats = lstatOrNull(manifestPath)
  if (!manifestStats) fail('manifest_missing', manifestPath)
  if (manifestStats.isSymbolicLink()) fail('verify_symlink', manifestPath)
  if (!manifestStats.isFile()) fail('manifest_invalid', `${manifestPath} is not a regular file`)
  if (manifestStats.size === 0 || manifestStats.size > MAX_STATIC_FILE_BYTES) fail('manifest_invalid', `unexpected manifest size ${manifestStats.size}`)

  const manifest = parseJson(readFileSync(manifestPath), STAGE_MANIFEST_FILE, 'manifest_invalid')
  if (!manifest || typeof manifest !== 'object') fail('manifest_invalid', 'manifest is not an object')
  if (manifest.schema !== STAGE_MANIFEST_SCHEMA) fail('manifest_invalid', `schema ${String(manifest.schema)}`)
  if (manifest.sourceCommit !== PI_PURGE_SOURCE_LOCK.sourceCommit) fail('source_drift_commit', `manifest commit ${String(manifest.sourceCommit)}`)
  if (manifest.packageVersion !== PI_PURGE_SOURCE_LOCK.packageVersion) fail('source_drift_version', `manifest version ${String(manifest.packageVersion)}`)
  if (manifest.license !== PI_PURGE_SOURCE_LOCK.license) fail('source_drift_license', `manifest license ${String(manifest.license)}`)
  if (!Array.isArray(manifest.copiedFiles) || manifest.copiedFiles.length === 0) fail('manifest_invalid', 'copiedFiles must be a non-empty array')

  const declared = new Map()
  for (const entry of manifest.copiedFiles) {
    const relPath = assertPlainRelativePath(entry && entry.path)
    if (declared.has(relPath)) fail('manifest_invalid', `duplicate path ${relPath}`)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail('manifest_invalid', `invalid size for ${relPath}`)
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) fail('manifest_invalid', `invalid sha256 for ${relPath}`)
    declared.set(relPath, { path: relPath, bytes: entry.bytes, sha256: entry.sha256 })
  }
  if (typeof manifest.treeSha256 !== 'string' || !HEX64.test(manifest.treeSha256)) fail('manifest_invalid', 'invalid treeSha256')
  const recomputedTree = computeTreeSha256([...declared.values()])
  if (recomputedTree !== manifest.treeSha256) fail('verify_mismatch', `tree ${recomputedTree} != manifest ${manifest.treeSha256}`)

  for (const entry of declared.values()) {
    const absolute = join(root, ...entry.path.split('/'))
    const fileStats = lstatOrNull(absolute)
    if (!fileStats) fail('verify_missing_file', entry.path)
    if (fileStats.isSymbolicLink()) fail('verify_symlink', entry.path)
    if (!fileStats.isFile()) fail('verify_missing_file', `${entry.path} is not a regular file`)
    const buffer = readFileSync(absolute)
    if (buffer.length !== entry.bytes) fail('verify_mismatch', `${entry.path} bytes ${buffer.length} != ${entry.bytes}`)
    const actualSha256 = sha256Hex(buffer)
    if (actualSha256 !== entry.sha256) fail('verify_mismatch', `${entry.path} sha256 ${actualSha256} != ${entry.sha256}`)
  }

  const present = listStagedFiles(root)
  const expected = new Set([...declared.keys(), STAGE_MANIFEST_FILE])
  for (const relPath of present) if (!expected.has(relPath)) fail('verify_extra_file', relPath)
  for (const relPath of expected) if (!present.includes(relPath)) fail('verify_missing_file', relPath)

  return {
    ok: true,
    mode: 'verify',
    action: 'verify-pi-purge-stage',
    outputDir: root,
    sourceCommit: manifest.sourceCommit,
    packageVersion: manifest.packageVersion,
    license: manifest.license,
    files: [...declared.values()],
    treeSha256: recomputedTree,
    evidence: STAGE_EVIDENCE_CEILING
  }
}

export function parseArguments(argv = []) {
  const options = { apply: false, help: false }
  const takeValue = (index, argument) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail('cli_missing_value', `${argument} requires a value`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--apply') options.apply = true
    else if (argument === '--source') {
      options.source = takeValue(index, argument)
      index += 1
    } else if (argument === '--output') {
      options.output = takeValue(index, argument)
      index += 1
    } else if (argument === '--output-root') {
      options.outputRoot = takeValue(index, argument)
      index += 1
    } else if (argument === '--commit') {
      options.commit = takeValue(index, argument)
      index += 1
    } else if (argument === '--tree-sha256') {
      options.treeSha256 = takeValue(index, argument)
      index += 1
    } else if (argument === '--verify') {
      options.verify = takeValue(index, argument)
      index += 1
    } else if (argument === '--help' || argument === '-h') options.help = true
    else fail('cli_unknown_argument', argument)
  }
  return options
}

export function runCli(argv = []) {
  const options = parseArguments(argv)
  if (options.help) return { ok: true, mode: 'help', usage: USAGE }
  if (options.commit !== undefined) {
    if (!HEX40.test(options.commit)) fail('cli_invalid_commit', options.commit)
    if (options.commit !== PI_PURGE_SOURCE_LOCK.sourceCommit) fail('source_drift_commit', `${options.commit} != ${PI_PURGE_SOURCE_LOCK.sourceCommit}`)
  }
  if (options.treeSha256 !== undefined && !HEX64.test(options.treeSha256)) fail('cli_invalid_tree_sha256', options.treeSha256)
  if (options.verify !== undefined) return verifyStage({ outputDir: options.verify })
  const shared = {
    sourceDir: options.source,
    outputDir: options.output,
    outputRoot: options.outputRoot,
    expectedTreeSha256: options.treeSha256
  }
  return options.apply ? stagePlugin(shared) : planStage(shared)
}

function main(argv) {
  const result = runCli(argv)
  if (result.mode === 'help') {
    console.log(result.usage)
    return
  }
  console.log(JSON.stringify(result, null, 2))
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
