// Stage the pinned, portable Pi Coding Agent runtime into a LOOM resource tree.
//
// The output is a self-contained directory:
//   resources/runtime/pi/
//     pi.cmd | pi                     portable launcher (relative paths only)
//     node/node(.exe)                 standalone Node runtime
//     node_modules/@earendil-works/pi-coding-agent/**   entry + dependency closure
//     pi-bundle.json                  schema 1 manifest (relative paths + hashes)
//     THIRD_PARTY_NOTICES.md          license inventory
//
// Invariants:
// - The destination is never deleted. A non-empty destination is refused unless
//   --verify is used; a successful stage is renamed atomically into place.
// - The manifest records only portable relative paths, never machine paths.
// - No Pi user state (auth.json / models.json / settings.json / sessions / .pi)
//   is ever copied. The verify run uses a throwaway private home.
// - Verification runs the real entry with Node directly (no cmd shell), sends one
//   documented `get_state` RPC request, and never sends a prompt.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const EMBEDDED_PI_VERSION = '0.85.1'
export const EMBEDDED_PI_PACKAGE = '@earendil-works/pi-coding-agent'
export const EMBEDDED_PI_SCHEMA = 1
export const EMBEDDED_PI_ENTRY = 'dist/bundle/cli.js'
export const EMBEDDED_PI_MANIFEST_FILE = 'pi-bundle.json'
export const EMBEDDED_PI_NOTICES_FILE = 'THIRD_PARTY_NOTICES.md'

const NODE_DIRECTORY = 'node'
const USER_STATE_FILES = new Set(['auth.json', 'models.json', 'settings.json'])
const USER_STATE_DIRECTORIES = new Set(['sessions', '.pi'])
const NON_RUNTIME_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'examples',
  'example',
  'docs',
  'doc',
  'coverage',
  '.github'
])
const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.node', '.exe', '.dll',
  '.cmd', '.bat', '.ps1', '.sh', '.so', '.dylib', '.wasm', '.jar', '.py'
])
const ALWAYS_INCLUDED_ROOTS = [
  /^package\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^LICEN[CS]E(\.|$)/i,
  /^COPYING(\.|$)/i,
  /^NOTICE(\.|$)/i,
  /^README(\.|$)/i,
  /^CHANGELOG(\.|$)/i
]
const MANIFEST_KEYS = [
  'schema', 'piVersion', 'platform', 'arch', 'nodeVersion', 'closureComplete',
  'launchKind', 'launcher', 'node', 'entry', 'files', 'treeSha256'
]
const LAUNCH_KINDS = new Set(['native', 'shell', 'npm-shim'])
const MINIMUM_NODE = [22, 19, 0]
const MINIMUM_NODE_LABEL = '22.19.0'

const VERSION_TIMEOUT_MS = 60_000
const RPC_TIMEOUT_MS = 120_000
const MAX_CAPTURE_BYTES = 64 * 1024
const RPC_REQUEST_TIMEOUT_MS = 60_000

export function hostPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return platform
}

export function hostArch(arch = process.arch) {
  if (arch === 'x64') return 'x86_64'
  if (arch === 'arm64') return 'aarch64'
  return arch
}

/** Portable relative path: posix separators, no drive, no parent, no empty part. */
export function assertPortableRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('portable path must be a non-empty string')
  if (value.includes('\\')) throw new Error(`portable path must use forward slashes: ${value}`)
  if (value.startsWith('/')) throw new Error(`portable path must be relative: ${value}`)
  const parts = value.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new Error(`portable path has an unsafe segment: ${value}`)
    if (part.includes(':')) throw new Error(`portable path must not carry a drive or stream prefix: ${value}`)
  }
  if (value !== parts.join('/')) throw new Error(`portable path is not normalized: ${value}`)
  return value
}

/**
 * Reject user Pi state. Only real config locations are refused: the bundle root
 * or a dependency package root. Files nested under a package's own fixtures are
 * not rejected blindly.
 */
export function assertNoUserStatePath(portablePath) {
  assertPortableRelativePath(portablePath)
  const parts = portablePath.split('/')
  const packageRelative = packageRelativeSegments(parts)
  if (packageRelative.length === 0) return portablePath
  if (USER_STATE_DIRECTORIES.has(packageRelative[0])) {
    throw new Error(`refusing to package Pi user state directory: ${portablePath}`)
  }
  if (packageRelative.length === 1 && USER_STATE_FILES.has(packageRelative[0])) {
    throw new Error(`refusing to package Pi user state file: ${portablePath}`)
  }
  return portablePath
}

/**
 * Path segments below the package root. A scoped package occupies two segments
 * (`node_modules/@scope/name/...`); treating it as one would hide a package-level
 * `auth.json` from the user-state check.
 */
function packageRelativeSegments(parts) {
  if (parts[0] !== 'node_modules') return parts
  const inside = parts.slice(1)
  if (inside.length > 0 && inside[0].startsWith('@')) return inside.slice(2)
  return inside.slice(1)
}

export function fileSha256(path) {
  const digest = createHash('sha256')
  digest.update(readFileSync(path))
  return digest.digest('hex')
}

/** Standalone Node must satisfy Pi's own engine floor before we package it. */
export function assertSupportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim())
  if (!match) throw new Error(`standalone Node reported an unparsable version: ${version}`)
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (actual[index] > MINIMUM_NODE[index]) return version
    if (actual[index] < MINIMUM_NODE[index]) {
      throw new Error(`standalone Node ${actual.join('.')} is below the required ${MINIMUM_NODE_LABEL} for Pi`)
    }
  }
  return version
}

export function bundleManifest({
  files,
  platform,
  arch,
  nodeVersion,
  launcher,
  node,
  entry,
  piVersion = EMBEDDED_PI_VERSION,
  closureComplete = true,
  launchKind = 'native',
  optionalMissing = []
}) {
  if (piVersion !== EMBEDDED_PI_VERSION) throw new Error(`embedded Pi must be pinned to ${EMBEDDED_PI_VERSION}`)
  for (const key of [launcher, node, entry]) assertPortableRelativePath(key)
  assertLaunchShape({ platform, launcher, launchKind })
  const seen = new Set()
  const entries = files.map((file) => {
    assertPortableRelativePath(file.path)
    if (seen.has(file.path)) throw new Error(`duplicate manifest path: ${file.path}`)
    seen.add(file.path)
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`invalid sha256 for ${file.path}`)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`invalid size for ${file.path}`)
    return { path: file.path, sha256: file.sha256, bytes: file.bytes }
  })
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  assertMandatoryHashes(new Set(entries.map((entry) => entry.path)), { launcher, node, entry })
  const digest = createHash('sha256')
  for (const entry of entries) digest.update(`${entry.path}\t${entry.bytes}\t${entry.sha256}\n`)
  return {
    schema: EMBEDDED_PI_SCHEMA,
    piVersion,
    platform,
    arch,
    nodeVersion,
    closureComplete: closureComplete === true,
    launchKind,
    launcher,
    node,
    entry,
    optionalMissing: [...optionalMissing].sort(),
    files: entries,
    treeSha256: digest.digest('hex')
  }
}

function readPackageJson(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
}

/**
 * The launcher, Node runtime, and Pi entry must each carry their own digest. A
 * manifest that names them but never hashes them would let verification pass
 * while those exact bytes change at runtime.
 */
function assertMandatoryHashes(paths, { launcher, node, entry }) {
  for (const [label, portable] of [
    ['launcher', launcher],
    ['node', node],
    ['entry', entry]
  ]) {
    if (!paths.has(portable)) {
      throw new Error(`embedded Pi manifest does not hash its ${label}: ${portable}`)
    }
  }
}

/**
 * Node-style nearest lookup, bounded by the installed store: never ascends above
 * `boundary`, so resolution matches what the packaged tree can satisfy.
 */
function packageDirectoryFor(name, fromDirectory, boundary) {
  let current = resolve(fromDirectory)
  for (;;) {
    // At an admitted store boundary the package is a direct child, not a
    // fictitious nested node_modules/node_modules directory.
    const candidate = basename(current).toLowerCase() === 'node_modules' ? join(current, name) : join(current, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return resolve(candidate)
    const parent = dirname(current)
    if (parent === current) return null
    if (boundary && (current === boundary || !isEqualOrInside(boundary, parent))) return null
    current = parent
  }
}

function isEqualOrInside(parent, candidate) {
  return resolve(candidate) === resolve(parent) || isContained(resolve(parent), resolve(candidate))
}

function normalizeAllowList(files) {
  const include = []
  const exclude = []
  for (const raw of files) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const negated = raw.startsWith('!')
    const value = (negated ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/+$/, '')
    if (value.length === 0) continue
    ;(negated ? exclude : include).push(value)
  }
  return { include, exclude }
}

function matchesAllowEntry(portablePath, entry) {
  return portablePath === entry || portablePath.startsWith(`${entry}/`)
}

function keepPackageFile(portablePath, allowList) {
  for (const entry of ALWAYS_INCLUDED_ROOTS) if (entry.test(portablePath)) return true
  const firstSegment = portablePath.split('/')[0]
  if (firstSegment === 'node_modules' || firstSegment === '.bin') return false
  // Tests, docs and examples are never needed at runtime, even when the upstream
  // package lists them, so they are dropped before the allowlist is consulted.
  if (NON_RUNTIME_DIRECTORIES.has(firstSegment)) return false
  if (allowList) {
    if (allowList.exclude.some((entry) => matchesAllowEntry(portablePath, entry))) return false
    return allowList.include.some((entry) => matchesAllowEntry(portablePath, entry))
  }
  return true
}

function walkFiles(root, { skipDirectories = new Set() } = {}) {
  const result = []
  const pending = ['']
  while (pending.length > 0) {
    const current = pending.pop()
    const absolute = current.length === 0 ? root : join(root, current)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const portable = current.length === 0 ? entry.name : `${current}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`refusing to package a symbolic link: ${portable}`)
      if (entry.isDirectory()) {
        if (skipDirectories.has(entry.name)) continue
        pending.push(portable)
        continue
      }
      if (entry.isFile()) result.push(portable)
    }
  }
  result.sort()
  return result
}

function copyFileRecording(file, destinationRoot, stats) {
  assertNoUserStatePath(file.portable)
  const destination = join(destinationRoot, ...file.portable.split('/'))
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, readFileSync(file.absolute))
  if (file.mode) chmodSync(destination, file.mode)
  stats.push({ path: file.portable, sha256: fileSha256(destination), bytes: statSync(destination).size })
}

/**
 * Copy the installed, pinned Pi package and its full transitive dependency
 * closure into `<destination>/node_modules`.
 *
 * Placement mirrors the physical install so Node's own nearest-`node_modules`
 * lookup resolves exactly as it does in the source tree. A package is placed at
 * `node_modules/<path below the installed Node module store>`; that single rule
 * reproduces hoisted siblings, per-package nested stores, and therefore multiple
 * versions of the same package name coexisting. Version selection is never
 * performed here, and a required dependency that cannot be resolved is a hard
 * failure (optional ones are only reported).
 */
export async function copyDependencyClosure(source, nodeModulesDestination) {
  const sourceDirectory = realpathSync(resolve(source))
  const store = installedModuleStore(sourceDirectory)
  const stats = []
  const packages = []
  const optionalMissing = []
  // target relative path -> canonical source directory
  const placements = new Map()
  // `${target}\u0000${canonical}` pairs already copied (bounds cycles and aliases)
  const copiedPlacements = new Set()
  // The root package IS `--source`; it is seeded by directory and never
  // re-resolved, so the store boundary it defines cannot exclude it.
  const pending = [{ directory: sourceDirectory, name: EMBEDDED_PI_PACKAGE, optional: false }]
  // Everything physically present in the root package's own store belongs to Pi,
  // so it is packaged even when no declared edge reaches it. The shared store of
  // an unrelated global install is never scanned.
  for (const seed of rootPackageStoreSeed(sourceDirectory)) {
    pending.push({ directory: seed, optional: false })
  }
  while (pending.length > 0) {
    const request = pending.shift()
    const directory = request.directory ?? packageDirectoryFor(request.name, request.from, store)
    if (!directory) {
      if (request.optional) {
        optionalMissing.push(request.name)
        continue
      }
      throw new Error(`required Pi dependency is not installed: ${request.name} (resolved from ${request.from})`)
    }
    const canonical = realpathSync(directory)
    if (!isContained(store, canonical)) {
      throw new Error(
        `resolved dependency is outside the installed Node module store (${store}): ${canonical}`
      )
    }
    const target = placementFor(store, canonical)
    const occupant = placements.get(target)
    if (occupant !== undefined && occupant !== canonical) {
      throw new Error(`two installs would land on one destination ${target}: ${occupant} and ${canonical}`)
    }
    placements.set(target, canonical)
    const placementKey = `${target}\u0000${canonical}`
    if (copiedPlacements.has(placementKey)) continue
    copiedPlacements.add(placementKey)
    const manifest = readPackageJson(canonical)
    const allowList = Array.isArray(manifest.files) ? normalizeAllowList(manifest.files) : null
    // Nested stores are copied as their own placements, never inline.
    const files = walkFiles(canonical, { skipDirectories: new Set(['node_modules', '.bin']) })
    let copied = 0
    for (const portable of files) {
      if (!keepPackageFile(portable, allowList)) continue
      copyFileRecording(
        { portable: `${target}/${portable}`, absolute: join(canonical, ...portable.split('/')) },
        nodeModulesDestination,
        stats
      )
      copied += 1
    }
    packages.push({
      name: manifest.name ?? request.name ?? basename(canonical),
      version: manifest.version ?? 'unknown',
      license: typeof manifest.license === 'string' ? manifest.license : 'see package LICENSE',
      repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? '',
      placement: target,
      files: copied
    })
    if (process.env.LOOM_PACKAGE_VERBOSE === '1' && packages.length % 20 === 0) {
      console.error(`packaging ${packages.length} packages / ${stats.length} files`)
    }
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const optionalDependencies = Object.keys(manifest.optionalDependencies ?? {})
    for (const name of dependencies) pending.push({ name, from: canonical, optional: false })
    for (const name of optionalDependencies) {
      if (dependencies.includes(name)) continue
      pending.push({ name, from: canonical, optional: true })
    }
  }
  return { packages, files: stats, optionalMissing }
}

/**
 * Package directories physically installed inside the root package's own
 * `node_modules`. Scoped packages are expanded one level. `.bin` is skipped.
 */
function rootPackageStoreSeed(packageDirectory) {
  const store = join(packageDirectory, 'node_modules')
  if (!existsSync(store)) return []
  const seeds = []
  const pushIfPackage = (candidate) => {
    if (existsSync(join(candidate, 'package.json'))) seeds.push(candidate)
  }
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.bin') continue
    const child = join(store, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(child, { withFileTypes: true })) {
        if (!scoped.isDirectory() || scoped.isSymbolicLink()) continue
        pushIfPackage(join(child, scoped.name))
      }
      continue
    }
    pushIfPackage(child)
  }
  return seeds
}

/**
 * Shallowest `node_modules` directory above the supplied installed package. This
 * is the only filesystem region dependency resolution may read from, so a global
 * npm install (scoped root package plus hoisted siblings) works without granting
 * arbitrary filesystem access.
 */
function installedModuleStore(packageDirectory) {
  const canonical = realpathSync(packageDirectory)
  const parts = canonical.split(sep)
  const index = parts.findIndex((part) => part.toLowerCase() === 'node_modules')
  if (index <= 0) {
    throw new Error(`source is not inside an installed node_modules tree: ${canonical}`)
  }
  const store = parts.slice(0, index + 1).join(sep) || sep
  if (realpathSync(store) === canonical) {
    throw new Error(`source must be a package directory, not a node_modules store: ${canonical}`)
  }
  return realpathSync(store)
}

function isContained(parent, child) {
  const relativePath = relative(parent, child)
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

/**
 * Destination placement: mirror the path below the installed store. Hoisted
 * packages become top-level `node_modules/<name>`; a package's private nested
 * store becomes `node_modules/<name>/node_modules/<dep>`, so several versions of
 * one package name coexist exactly where Node would look for them.
 */
function placementFor(store, canonical) {
  const relativePath = relative(store, canonical)
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`dependency placement is outside the installed store: ${canonical}`)
  }
  return ['node_modules', ...relativePath.split(sep)].join('/')
}

function thirdPartyNotices(packages) {
  const lines = [
    '# Embedded Pi third-party notices',
    '',
    `This directory redistributes ${EMBEDDED_PI_PACKAGE}@${EMBEDDED_PI_VERSION} and its dependency closure.`,
    'Each dependency keeps its own license files inside `node_modules/<package>/`.',
    'Copied from an explicitly supplied local install; nothing was downloaded here.',
    '',
    '| package | version | license | files | placement |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const entry of [...packages].sort((left, right) => {
    const byName = left.name.localeCompare(right.name)
    return byName === 0 ? left.version.localeCompare(right.version) : byName
  })) {
    lines.push(`| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.files} | ${entry.placement ?? ''} |`)
  }
  return `${lines.join('\n')}\n`
}

function assertAbsolute(label, value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} requires an absolute path`)
  return value
}

function destinationIsEmpty(destination) {
  return readdirSync(destination).length === 0
}

/**
 * Launcher shape rules. `npm-shim` is a Windows diagnostic build only: Core's
 * Windows discovery admits `.exe` entrypoints, so a shim is never a runnable
 * product launcher and staging refuses to produce one silently.
 */
function assertLaunchShape({ platform, launcher, launchKind }) {
  if (!LAUNCH_KINDS.has(launchKind)) throw new Error(`unknown embedded Pi launch kind: ${launchKind}`)
  if (launchKind === 'native') {
    const expected = platform === 'windows' ? 'pi.exe' : 'pi'
    if (launcher !== expected) throw new Error(`native launcher for ${platform} must be named ${expected}`)
    return
  }
  if (launchKind === 'shell') {
    if (platform === 'windows') throw new Error('a shell launcher is not accepted on Windows')
    if (launcher !== 'pi') throw new Error('shell launcher must be named pi')
    return
  }
  if (platform !== 'windows') throw new Error('an npm command shim is only meaningful on Windows')
  if (launcher !== 'pi.cmd') throw new Error('npm command shim must be named pi.cmd')
}

/**
 * Decide how this platform gets a launcher.
 *
 * Windows production staging MUST supply a native launcher (the built
 * `loom-pi-launcher`); a `.cmd` shim is available only when the caller opts in
 * for diagnostics, and the manifest then records `launchKind: npm-shim` so Core
 * rejects it.
 */
function launcherPlan({ platform, launcherBuilt, allowCommandShim }) {
  if (launcherBuilt) {
    const source = assertAbsolute('launcherBuilt', resolve(launcherBuilt))
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`built launcher is missing: ${source}`)
    }
    if (platform === 'windows' && !source.toLowerCase().endsWith('.exe')) {
      throw new Error('a Windows packaged launcher must be a native .exe')
    }
    return {
      name: platform === 'windows' ? 'pi.exe' : 'pi',
      kind: 'native',
      source,
      mode: platform === 'windows' ? undefined : 0o755
    }
  }
  if (platform === 'windows') {
    if (allowCommandShim !== true) {
      throw new Error(
        'Windows staging requires --launcher-built <native launcher>; a .cmd shim is diagnostic only (pass allowCommandShim in tests)'
      )
    }
    return { name: 'pi.cmd', kind: 'npm-shim', contents: launcherContents(platform), mode: 0o644 }
  }
  return { name: 'pi', kind: 'shell', contents: launcherContents(platform), mode: 0o755 }
}

function launcherContents(platform) {
  const entry = `node_modules/${EMBEDDED_PI_PACKAGE}/${EMBEDDED_PI_ENTRY}`
  const node = platform === 'windows' ? 'node/node.exe' : 'node/node'
  if (platform === 'windows') {
    const windowsEntry = entry.split('/').join('\\')
    const windowsNode = node.split('/').join('\\')
    return `@echo off\r\n"%~dp0${windowsNode}" "%~dp0${windowsEntry}" %*\r\n`
  }
  return `#!/bin/sh\nexec "$(dirname "$0")/${node}" "$(dirname "$0")/${entry}" "$@"\n`
}

function nodeVersionOf(nodeExecutable) {
  return new Promise((resolveVersion, rejectVersion) => {
    const child = spawn(nodeExecutable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), VERSION_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectVersion(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const version = output.trim()
      if (code !== 0 || version.length === 0) {
        rejectVersion(new Error(`standalone Node did not report a version (exit ${code})`))
        return
      }
      resolveVersion(version)
    })
  })
}

function runBounded(command, args, { env, timeoutMs, stdinLines = [], cwd, windowsVerbatimArguments = false }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectRun(error)
      else resolveRun(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`timed out after ${timeoutMs}ms: ${basename(command)} ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += String(chunk) })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => finish(null, { code, signal, stdout, stderr }))
    for (const line of stdinLines) child.stdin.write(`${line}\n`)
    child.stdin.end()
  })
}

function privateVerifyHome() {
  const root = join(tmpdir(), `loom-embedded-pi-verify-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const agent = join(root, 'pi-agent')
  mkdirSync(agent, { recursive: true, mode: 0o700 })
  return { root, home, agent }
}

function verifyEnvironment(privateHome) {
  const env = {
    PATH: process.env.PATH ?? '',
    PI_CODING_AGENT_DIR: privateHome.agent,
    PI_TELEMETRY: '0',
    HOME: privateHome.home,
    USERPROFILE: privateHome.home,
    APPDATA: privateHome.home,
    LOCALAPPDATA: privateHome.home,
    XDG_CONFIG_HOME: privateHome.home,
    TMPDIR: privateHome.root,
    TEMP: privateHome.root,
    TMP: privateHome.root
  }
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT
  return env
}

function assertPinnedVersion(label, stdout) {
  const trimmed = stdout.trim()
  if (!/^(?:pi\s+)?v?0\.85\.1$/.test(trimmed)) {
    throw new Error(`${label} did not report the pinned Pi version 0.85.1 (got ${JSON.stringify(trimmed.slice(0, 200))})`)
  }
  return '0.85.1'
}

async function verifyEntry({ nodeExecutable, entryPath, privateHome }) {
  const nodeVersion = assertPinnedVersion(
    'standalone Node entry --version',
    (await runBounded(nodeExecutable, [entryPath, '--version'], {
      cwd: dirname(entryPath),
      env: verifyEnvironment(privateHome),
      timeoutMs: VERSION_TIMEOUT_MS
    })).stdout
  )
  const requestId = `rovai-embedded-pi-verify-${process.pid}`
  const rpc = await runBounded(
    nodeExecutable,
    [entryPath, '--mode', 'rpc', '--no-themes', '--approve'],
    {
      cwd: dirname(entryPath),
      env: verifyEnvironment(privateHome),
      timeoutMs: RPC_TIMEOUT_MS + RPC_REQUEST_TIMEOUT_MS,
      stdinLines: [JSON.stringify({ id: requestId, type: 'get_state' })]
    }
  )
  const response = rpc.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((message) => message && message.type === 'response' && message.id === requestId)
  if (!response) {
    throw new Error(`Pi RPC did not answer the documented get_state request (exit ${rpc.code}); stderr ${JSON.stringify(rpc.stderr.slice(0, 400))}`)
  }
  if (response.success !== true || response.command !== 'get_state') {
    throw new Error(`Pi RPC rejected get_state: ${JSON.stringify(response).slice(0, 400)}`)
  }
  if (rpc.code !== 0) {
    throw new Error(`Pi RPC exited with ${rpc.code} after stdin close; stderr ${JSON.stringify(rpc.stderr.slice(0, 400))}`)
  }
  return { nodeVersion, responseCommand: response.command }
}

/**
 * Prove the packaged launcher works. A native launcher is executed directly and
 * must reach Pi's own `--version`; the diagnostic Windows `.cmd` shim (test-only,
 * never the product path) is driven through ComSpec because cmd has no exec.
 */
async function verifyLauncher({ root, privateHome, platform, manifest }) {
  const launcher = absoluteFromRoot(root, manifest.launcher)
  if (!existsSync(launcher) || !statSync(launcher).isFile()) {
    throw new Error(`missing packaged launcher: ${manifest.launcher}`)
  }
  if (manifest.launchKind === 'npm-shim') {
    const comSpec = process.env.ComSpec ?? 'cmd.exe'
    const result = await runBounded(comSpec, ['/d', '/s', '/c', `""${launcher}" --version"`], {
      cwd: root,
      windowsVerbatimArguments: true,
      env: verifyEnvironment(privateHome),
      timeoutMs: VERSION_TIMEOUT_MS
    })
    return assertPinnedVersion('diagnostic .cmd launcher --version', result.stdout)
  }
  const result = await runBounded(launcher, ['--version'], {
    cwd: root,
    env: verifyEnvironment(privateHome),
    timeoutMs: VERSION_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new Error(`embedded launcher version probe failed (exit ${result.code}); stderr ${JSON.stringify(result.stderr.slice(0, 1200))}`)
  }
  return assertPinnedVersion(`${manifest.launchKind} launcher --version`, result.stdout)
}

function readManifest(root) {
  const manifestPath = join(root, EMBEDDED_PI_MANIFEST_FILE)
  if (!existsSync(manifestPath)) throw new Error(`missing embedded Pi manifest: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const missingKeys = MANIFEST_KEYS.filter((key) => !(key in manifest))
  if (missingKeys.length > 0) throw new Error(`embedded Pi manifest is missing keys: ${missingKeys.join(', ')}`)
  if (manifest.schema !== EMBEDDED_PI_SCHEMA) throw new Error(`unsupported embedded Pi manifest schema: ${manifest.schema}`)
  if (manifest.piVersion !== EMBEDDED_PI_VERSION) {
    throw new Error(`embedded Pi manifest is not pinned to ${EMBEDDED_PI_VERSION}: ${manifest.piVersion}`)
  }
  for (const key of ['launcher', 'node', 'entry']) assertPortableRelativePath(manifest[key])
  assertLaunchShape(manifest)
  if (!Array.isArray(manifest.files)) throw new Error('embedded Pi manifest has no file list')
  assertMandatoryHashes(new Set(manifest.files.map((file) => file?.path).filter(Boolean)), {
    launcher: manifest.launcher,
    node: manifest.node,
    entry: manifest.entry
  })
  return manifest
}

function absoluteFromRoot(root, portablePath) {
  return join(root, ...portablePath.split('/'))
}

/**
 * Verify an already-staged bundle: hashes every manifest file, re-runs the
 * pinned version check and one documented RPC readiness request.
 */
export async function verifyBundledPi({ root, launchCheck = true }) {
  const bundleRoot = assertAbsolute('verify root', resolve(root))
  if (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory()) {
    throw new Error(`embedded Pi root is not a directory: ${bundleRoot}`)
  }
  const manifest = readManifest(bundleRoot)
  const digests = new Map()
  const recorded = new Set()
  for (const file of manifest.files) {
    assertNoUserStatePath(file.path)
    const absolute = absoluteFromRoot(bundleRoot, file.path)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`embedded Pi manifest file is missing: ${file.path}`)
    }
    const size = statSync(absolute).size
    if (size !== file.bytes) throw new Error(`embedded Pi size mismatch: ${file.path}`)
    const digest = fileSha256(absolute)
    if (digest !== file.sha256) throw new Error(`embedded Pi hash mismatch: ${file.path}`)
    digests.set(file.path, { sha256: digest, bytes: size })
    recorded.add(file.path)
  }
  for (const required of [manifest.launcher, manifest.node, manifest.entry]) {
    if (!recorded.has(required)) throw new Error(`critical launcher file is not integrity-covered: ${required}`)
  }
  const actual = walkFiles(bundleRoot).filter((portable) => portable !== EMBEDDED_PI_MANIFEST_FILE)
  for (const portable of actual) {
    if (recorded.has(portable)) continue
    const name = portable.slice(portable.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 ? name.slice(dot).toLowerCase() : ''
    if (manifest.closureComplete === true || CODE_EXTENSIONS.has(extension)) {
      throw new Error(`undocumented file in embedded Pi bundle: ${portable}`)
    }
  }
  const entries = [...digests.entries()]
    .map(([path, value]) => ({ path, ...value }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const recomputed = bundleManifest({
    files: entries,
    platform: manifest.platform,
    arch: manifest.arch,
    nodeVersion: manifest.nodeVersion,
    launcher: manifest.launcher,
    node: manifest.node,
    entry: manifest.entry,
    piVersion: manifest.piVersion,
    closureComplete: manifest.closureComplete === true,
    launchKind: manifest.launchKind,
    optionalMissing: manifest.optionalMissing ?? []
  })
  if (recomputed.treeSha256 !== manifest.treeSha256) {
    throw new Error(`embedded Pi tree digest mismatch: ${recomputed.treeSha256} != ${manifest.treeSha256}`)
  }
  const nodeExecutable = absoluteFromRoot(bundleRoot, manifest.node)
  const entryPath = absoluteFromRoot(bundleRoot, manifest.entry)
  if (!existsSync(nodeExecutable) || !statSync(nodeExecutable).isFile()) {
    throw new Error(`embedded Pi Node runtime is missing: ${manifest.node}`)
  }
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    throw new Error(`embedded Pi entry is missing: ${manifest.entry}`)
  }
  if (!launchCheck) {
    return { root: bundleRoot, manifest, piVersion: manifest.piVersion, treeSha256: manifest.treeSha256, launch: null }
  }
  const privateHome = privateVerifyHome()
  try {
    const runtime = await verifyEntry({ nodeExecutable, entryPath, privateHome })
    const launcherVersion = await verifyLauncher({
      root: bundleRoot,
      privateHome,
      platform: manifest.platform,
      manifest
    })
    return {
      root: bundleRoot,
      manifest,
      piVersion: manifest.piVersion,
      treeSha256: manifest.treeSha256,
      launch: { ...runtime, launcherVersion }
    }
  } finally {
    rmSync(privateHome.root, { recursive: true, force: true })
  }
}

/**
 * Stage the pinned bundle. Never deletes an existing non-empty destination:
 * the tree is built in a sibling temp directory and renamed into place.
 */
export async function stageEmbeddedPi({
  source,
  destination,
  platform = hostPlatform(),
  arch = hostArch(),
  nodeExecutable,
  launcherBuilt,
  allowCommandShim = false,
  launchCheck = true
}) {
  const sourceDirectory = assertAbsolute('source', resolve(source))
  const destinationRoot = assertAbsolute('destination', resolve(destination))
  const nodePath = assertAbsolute('nodeExecutable', resolve(nodeExecutable))
  if (!existsSync(join(sourceDirectory, 'package.json'))) {
    throw new Error(`source is not an installed package directory: ${sourceDirectory}`)
  }
  const sourceManifest = readPackageJson(sourceDirectory)
  if (sourceManifest.name !== EMBEDDED_PI_PACKAGE) {
    throw new Error(`source must be ${EMBEDDED_PI_PACKAGE}, found ${sourceManifest.name}`)
  }
  if (sourceManifest.version !== EMBEDDED_PI_VERSION) {
    throw new Error(`source version ${sourceManifest.version} is not the pinned ${EMBEDDED_PI_VERSION}`)
  }
  if (!existsSync(nodePath) || !statSync(nodePath).isFile()) {
    throw new Error(`standalone Node runtime is missing: ${nodePath}`)
  }
  const relativeToSource = relative(sourceDirectory, destinationRoot)
  if (relativeToSource === '' || (!relativeToSource.startsWith('..') && !isAbsolute(relativeToSource))) {
    throw new Error('destination must not be inside the source install')
  }
  // Resolve the launcher shape before any temporary directory exists.
  const launcher = launcherPlan({ platform, launcherBuilt, allowCommandShim })
  if (existsSync(destinationRoot)) {
    if (!statSync(destinationRoot).isDirectory()) throw new Error(`destination is not a directory: ${destinationRoot}`)
    if (!destinationIsEmpty(destinationRoot)) {
      throw new Error(`refusing to overwrite non-empty destination ${destinationRoot}; delete it explicitly or use --verify`)
    }
  }
  mkdirSync(dirname(destinationRoot), { recursive: true })
  const staging = `${destinationRoot}.staging-${process.pid}-${Math.random().toString(16).slice(2)}`
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    const closure = await copyDependencyClosure(sourceDirectory, staging)
    const stats = closure.files
    mkdirSync(join(staging, NODE_DIRECTORY), { recursive: true })
    const nodePortable = `${NODE_DIRECTORY}/${platform === 'windows' ? 'node.exe' : 'node'}`
    copyFileRecording(
      { portable: nodePortable, absolute: nodePath, mode: platform === 'windows' ? 0o644 : 0o755 },
      staging,
      stats
    )
    const launcherPath = join(staging, launcher.name)
    if (launcher.source) {
      copyFileRecording(
        { portable: launcher.name, absolute: launcher.source, mode: launcher.mode },
        staging,
        stats
      )
    } else {
      assertNoUserStatePath(launcher.name)
      writeFileSync(launcherPath, launcher.contents)
      chmodSync(launcherPath, launcher.mode)
      stats.push({ path: launcher.name, sha256: fileSha256(launcherPath), bytes: statSync(launcherPath).size })
    }
    const noticesPath = join(staging, EMBEDDED_PI_NOTICES_FILE)
    writeFileSync(noticesPath, thirdPartyNotices(closure.packages))
    stats.push({ path: EMBEDDED_PI_NOTICES_FILE, sha256: fileSha256(noticesPath), bytes: statSync(noticesPath).size })
    const nodeVersion = assertSupportedNode(await nodeVersionOf(nodePath))
    const manifest = bundleManifest({
      files: stats,
      platform,
      arch,
      nodeVersion,
      launchKind: launcher.kind,
      launcher: launcher.name,
      node: nodePortable,
      entry: `node_modules/${EMBEDDED_PI_PACKAGE}/${EMBEDDED_PI_ENTRY}`,
      optionalMissing: closure.optionalMissing
    })
    writeFileSync(join(staging, EMBEDDED_PI_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
    if (launchCheck) await verifyBundledPi({ root: staging })
    // Only an empty destination directory is cleared, and never recursively.
    if (existsSync(destinationRoot)) rmdirSync(destinationRoot)
    renameSync(staging, destinationRoot)
    return {
      destination: destinationRoot,
      manifestPath: join(destinationRoot, EMBEDDED_PI_MANIFEST_FILE),
      fileCount: manifest.files.length,
      bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
      treeSha256: manifest.treeSha256,
      launcher: join(destinationRoot, ...launcher.name.split('/')),
      node: join(destinationRoot, ...nodePortable.split('/')),
      entry: join(destinationRoot, ...manifest.entry.split('/')),
      launchKind: manifest.launchKind,
      optionalMissing: manifest.optionalMissing,
      packages: closure.packages
    }
  } finally {
    // Cleanup is limited to the staging directory this run created.
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  const options = { launchCheck: true }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      index += 1
      return value
    }
    if (argument === '--verify') options.verifyOnly = true
    else if (argument === '--source') options.source = takeValue()
    else if (argument === '--node') options.node = takeValue()
    else if (argument === '--launcher-built') options.launcherBuilt = takeValue()
    else if (argument === '--allow-command-shim') options.allowCommandShim = true
    else if (argument === '--destination') options.destination = takeValue()
    else if (argument === '--platform') options.platform = takeValue()
    else if (argument === '--arch') options.arch = takeValue()
    else if (argument === '--no-launch-check') options.launchCheck = false
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

async function main(argv) {
  const options = parseArguments(argv)
  if (options.help) {
    console.log('usage: node scripts/package-embedded-pi.mjs --source <installed package dir> --node <standalone node> [--launcher-built <native launcher>] [--destination resources/runtime/pi] [--platform macos] [--arch arm64]\n       node scripts/package-embedded-pi.mjs --verify [--destination resources/runtime/pi]\n\nWindows staging requires --launcher-built (cargo build -p loom-pi-launcher). --allow-command-shim is diagnostic only: Core rejects such a bundle.')
    return
  }
  const destination = options.destination ?? resolve(import.meta.dirname, '..', 'resources', 'runtime', 'pi')
  if (options.verifyOnly) {
    const result = await verifyBundledPi({ root: destination })
    console.log(`verified embedded Pi ${result.piVersion} at ${result.root} (tree ${result.treeSha256})`)
    return
  }
  if (!options.source || !options.node) {
    throw new Error('staging requires --source <installed package dir> and --node <standalone node>; use --verify to check an existing bundle')
  }
  const result = await stageEmbeddedPi({
    source: options.source,
    destination,
    nodeExecutable: options.node,
    launcherBuilt: options.launcherBuilt,
    allowCommandShim: options.allowCommandShim === true,
    platform: options.platform ?? hostPlatform(),
    arch: options.arch ?? hostArch(),
    launchCheck: options.launchCheck
  })
  console.log(`staged embedded Pi ${EMBEDDED_PI_VERSION} into ${result.destination} (${result.fileCount} files, tree ${result.treeSha256}, launch ${result.launchKind})`)
  if (result.launchKind === 'npm-shim') {
    console.log('warning: this bundle uses a diagnostic .cmd shim; Core will reject it. Build crates/loom-pi-launcher and re-stage with --launcher-built')
  }
  if (result.optionalMissing.length > 0) console.log(`optional dependencies not installed: ${result.optionalMissing.join(', ')}`)
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
