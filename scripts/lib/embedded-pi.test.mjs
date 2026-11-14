// Embedded Pi packager tests. The staged bundle uses the real Node runtime
// (process.execPath) and a fixture Pi entry, so the version probe and the
// documented `get_state` RPC round-trip are exercised without any model call
// and without touching the user's installed Pi or its credentials.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { after, before, describe, test } from 'node:test'

import {
  EMBEDDED_PI_PACKAGE,
  EMBEDDED_PI_VERSION,
  assertNoUserStatePath,
  assertPortableRelativePath,
  assertSupportedNode,
  bundleManifest,
  hostArch,
  hostPlatform,
  stageEmbeddedPi,
  verifyBundledPi
} from '../package-embedded-pi.mjs'

// The fixture never calls process.exit(): stdout to a pipe is asynchronous, so
// an explicit exit could truncate the response the verifier is waiting for.
const FIXTURE_CLI = String.raw`
const fs = require('node:fs')
const readline = require('node:readline')
const REQUEST_LOG = __REQUEST_LOG__
if (process.argv.includes('--version')) {
  process.stdout.write('${EMBEDDED_PI_VERSION}\n')
} else {
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    fs.appendFileSync(REQUEST_LOG, line + '\n')
    const request = JSON.parse(line)
    if (request.type !== 'get_state') {
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: false, command: request.type, error: 'unsupported fixture command' }) + '\n')
      return
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, command: 'get_state', data: {} }) + '\n')
  })
}
`

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Installed-looking Pi package tree: allowlisted `files`, one resolved
 * dependency, one missing optional dependency, and non-runtime directories that
 * must not be packaged.
 */
function makeFixtureSource(root, { requestLog, withDependency = true } = {}) {
  const packageRoot = join(root, 'node_modules', ...EMBEDDED_PI_PACKAGE.split('/'))
  writeJson(join(packageRoot, 'package.json'), {
    name: EMBEDDED_PI_PACKAGE,
    version: EMBEDDED_PI_VERSION,
    license: 'MIT',
    bin: { pi: 'dist/bundle/cli.js' },
    files: ['dist', 'package.json', 'npm-shrinkwrap.json', '!dist/client'],
    dependencies: withDependency
      ? { '@earendil-works/pi-ai': '0.85.1', alpha: '2.0.0', leaf: '1.0.0' }
      : { '@earendil-works/missing': '0.85.1' },
    optionalDependencies: { '@mariozechner/clipboard': '0.3.9' }
  })
  writeJson(join(packageRoot, 'npm-shrinkwrap.json'), { name: EMBEDDED_PI_PACKAGE, lockfileVersion: 3, packages: {} })
  mkdirSync(join(packageRoot, 'dist/bundle'), { recursive: true })
  writeFileSync(
    join(packageRoot, 'dist/bundle/cli.js'),
    FIXTURE_CLI.replace('__REQUEST_LOG__', JSON.stringify(requestLog))
  )
  writeFileSync(join(packageRoot, 'dist/cli.js'), '// bundled entry\n')
  mkdirSync(join(packageRoot, 'dist/client'), { recursive: true })
  writeFileSync(join(packageRoot, 'dist/client/private.js'), '// excluded by files negation\n')
  writeFileSync(join(packageRoot, 'LICENSE'), 'MIT fixture license\n')
  // Non-runtime material that must never reach the bundle.
  writeJson(join(packageRoot, 'test/fixtures/auth.json'), { fixture: true })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true })
  writeFileSync(join(packageRoot, 'dist/leaf-consumer.js'), "module.exports = require('leaf')\n")
  mkdirSync(join(packageRoot, 'docs'), { recursive: true })
  writeFileSync(join(packageRoot, 'docs/guide.md'), '# guide\n')
  if (!withDependency) return packageRoot
  const dependencyRoot = join(root, 'node_modules', '@earendil-works/pi-ai')
  writeJson(join(dependencyRoot, 'package.json'), {
    name: '@earendil-works/pi-ai',
    version: '0.85.1',
    license: 'MIT',
    main: 'dist/index.js'
  })
  mkdirSync(join(dependencyRoot, 'dist'), { recursive: true })
  writeFileSync(join(dependencyRoot, 'dist/index.js'), 'module.exports = {}\n')
  writeFileSync(join(dependencyRoot, 'dist/native.wasm'), 'wasm-bytes\n')
  writeFileSync(join(dependencyRoot, 'LICENSE'), 'MIT fixture license\n')

  // Two installs of one name, exactly as npm produces them: a hoisted sibling
  // for the Pi package and a nested copy for `alpha`.
  const hoistedLeaf = join(packageRoot, 'node_modules/leaf')
  writeJson(join(hoistedLeaf, 'package.json'), { name: 'leaf', version: '1.0.0', main: 'index.js' })
  writeFileSync(join(hoistedLeaf, 'index.js'), "module.exports = { version: '1.0.0' }\n")
  const alpha = join(packageRoot, 'node_modules/alpha')
  writeJson(join(alpha, 'package.json'), {
    name: 'alpha',
    version: '2.0.0',
    main: 'index.js',
    dependencies: { leaf: '2.0.0', beta: '1.0.0' }
  })
  writeFileSync(join(alpha, 'index.js'), "module.exports = require('leaf')\n")
  const nestedLeaf = join(alpha, 'node_modules/leaf')
  writeJson(join(nestedLeaf, 'package.json'), { name: 'leaf', version: '2.0.0', main: 'index.js' })
  writeFileSync(join(nestedLeaf, 'index.js'), "module.exports = { version: '2.0.0' }\n")
  // Cycle: beta depends back on alpha.
  const beta = join(packageRoot, 'node_modules/beta')
  writeJson(join(beta, 'package.json'), {
    name: 'beta',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { alpha: '2.0.0' }
  })
  writeFileSync(join(beta, 'index.js'), "module.exports = { name: 'beta' }\n")
  return packageRoot
}

function workspace() {
  return mkdtempSync(join(tmpdir(), 'loom-embedded-pi-test-'))
}

/**
 * Windows has no runnable shell launcher, so the fixture suite opts into the
 * diagnostic `.cmd` shim. Production staging never receives this flag: the
 * dedicated policy test asserts that it throws without a built launcher.
 */
function platformStagingOptions() {
  return hostPlatform() === 'windows' ? { allowCommandShim: true } : {}
}

function expectedLauncher() {
  return hostPlatform() === 'windows'
    ? { name: 'pi.cmd', kind: 'npm-shim' }
    : { name: 'pi', kind: 'shell' }
}

test('manifest digests are reproducible and independent of input order', () => {
  const launcher = hostPlatform() === 'windows' ? 'pi.exe' : 'pi'
  const files = [
    { path: 'node/node', sha256: 'a'.repeat(64), bytes: 3 },
    { path: launcher, sha256: 'b'.repeat(64), bytes: 5 },
    { path: 'node_modules/x/dist/cli.js', sha256: 'c'.repeat(64), bytes: 7 }
  ]
  const first = bundleManifest({
    files,
    platform: hostPlatform(),
    arch: hostArch(),
    nodeVersion: 'v22.19.0',
    launcher,
    node: 'node/node',
    entry: 'node_modules/x/dist/cli.js'
  })
  const second = bundleManifest({
    files: [...files].reverse(),
    platform: hostPlatform(),
    arch: hostArch(),
    nodeVersion: 'v22.19.0',
    launcher,
    node: 'node/node',
    entry: 'node_modules/x/dist/cli.js'
  })
  assert.equal(first.treeSha256, second.treeSha256)
  assert.match(first.treeSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(first.files.map((file) => file.path), [...files.map((file) => file.path)].sort())
  assert.equal(first.closureComplete, true)
  assert.throws(() => bundleManifest({
    files,
    platform: hostPlatform(),
    arch: hostArch(),
    nodeVersion: 'v22.19.0',
    launcher,
    node: 'node/node',
    entry: 'node_modules/x/dist/cli.js',
    piVersion: '0.84.4'
  }), /pinned to 0\.85\.1/)
})

test('manifest paths reject absolute, parent, backslash and drive forms', () => {
  for (const unsafe of ['/etc/passwd', '../escape', 'a/../b', 'a\\b', 'C:/x', '', 'node//x']) {
    assert.throws(() => assertPortableRelativePath(unsafe), /portable path/, unsafe)
  }
  assert.equal(assertPortableRelativePath('node_modules/@scope/pkg/dist/cli.js'), 'node_modules/@scope/pkg/dist/cli.js')
  const manifest = {
    files: [{ path: '../escape', sha256: 'd'.repeat(64), bytes: 1 }],
    platform: 'linux',
    arch: 'x86_64',
    nodeVersion: 'v22.19.0',
    launcher: 'pi',
    node: 'node/node',
    entry: 'node_modules/x/cli.js'
  }
  assert.throws(() => bundleManifest(manifest), /unsafe segment/)
})

test('user Pi state is rejected only at real config locations', () => {
  for (const state of ['auth.json', 'models.json', 'settings.json', 'sessions/x.jsonl', '.pi/agent/auth.json']) {
    assert.throws(() => assertNoUserStatePath(state), /refusing to package Pi user state/, state)
  }
  for (const state of [
    'node_modules/@earendil-works/pi-coding-agent/auth.json',
    'node_modules/@earendil-works/pi-coding-agent/sessions/x.jsonl'
  ]) {
    assert.throws(() => assertNoUserStatePath(state), /refusing to package Pi user state/, state)
  }
  // Dependency assets keep their legitimate names.
  assert.equal(assertNoUserStatePath('node_modules/x/dist/models.js'), 'node_modules/x/dist/models.js')
  assert.equal(assertNoUserStatePath('node_modules/x/dist/agent/auth.json'), 'node_modules/x/dist/agent/auth.json')
})

test('standalone Node must meet the pinned Pi engine floor', () => {
  assert.equal(assertSupportedNode('v22.19.0'), 'v22.19.0')
  assert.equal(assertSupportedNode('v24.1.0'), 'v24.1.0')
  assert.throws(() => assertSupportedNode('v22.18.9'), /below the required 22\.19\.0/)
  assert.throws(() => assertSupportedNode('v20.19.1'), /below the required 22\.19\.0/)
  assert.throws(() => assertSupportedNode('node development'), /unparsable version/)
})

test('shim launcher shapes stay diagnostic and platform-bound', () => {
  const staged = (...paths) => paths.map((path) => ({ path, sha256: 'd'.repeat(64), bytes: 1 }))
  const base = {
    files: staged('pi', 'node/node', 'node_modules/x/cli.js'),
    platform: 'linux',
    arch: 'x86_64',
    nodeVersion: 'v24.1.0',
    node: 'node/node',
    entry: 'node_modules/x/cli.js'
  }
  assert.throws(
    () => bundleManifest({ ...base, launcher: 'pi.cmd', launchKind: 'npm-shim' }),
    /only meaningful on Windows/
  )
  assert.throws(
    () => bundleManifest({ ...base, launcher: 'pi', launchKind: 'shell', platform: 'windows' }),
    /not accepted on Windows/
  )
  assert.throws(
    () => bundleManifest({ ...base, launcher: 'pi.exe', launchKind: 'native' }),
    /must be named pi/
  )
  assert.equal(bundleManifest({ ...base, launcher: 'pi', launchKind: 'shell' }).launchKind, 'shell')
  assert.equal(
    bundleManifest({ ...base, platform: 'macos', arch: 'aarch64', launcher: 'pi', launchKind: 'native' }).launcher,
    'pi'
  )
})

test('manifest must hash launcher, node and entry', () => {
  const hashed = (paths) => paths.map((path) => ({ path, sha256: 'e'.repeat(64), bytes: 2 }))
  const common = {
    platform: 'linux',
    arch: 'x86_64',
    nodeVersion: 'v24.1.0',
    launcher: 'pi',
    node: 'node/node',
    entry: 'node_modules/x/cli.js',
    launchKind: 'shell'
  }
  const complete = bundleManifest({
    ...common,
    files: hashed(['pi', 'node/node', 'node_modules/x/cli.js'])
  })
  assert.equal(complete.files.length, 3)
  for (const missing of ['pi', 'node/node', 'node_modules/x/cli.js']) {
    assert.throws(
      () => bundleManifest({
        ...common,
        files: hashed(['pi', 'node/node', 'node_modules/x/cli.js'].filter((path) => path !== missing))
      }),
      /does not hash its (launcher|node|entry)/,
      `manifest without ${missing} must be rejected`
    )
  }
})

test('windows staging refuses to fake a runnable launcher', async (t) => {
  if (hostPlatform() !== 'windows') {
    t.skip('Windows-only launcher policy; other platforms use the shell launcher')
    return
  }
  const root = workspace()
  try {
    const source = makeFixtureSource(join(root, 'install'), { requestLog: join(root, 'requests.log') })
    await assert.rejects(
      stageEmbeddedPi({
        source,
        destination: join(root, 'bundle'),
        nodeExecutable: process.execPath,
        launchCheck: false
      }),
      /requires --launcher-built/
    )
    assert.equal(existsSync(join(root, 'bundle')), false)
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('.staging-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('required dependency missing fails hard while optional dependency is reported', async () => {
  const root = workspace()
  try {
    const source = makeFixtureSource(join(root, 'broken'), { requestLog: join(root, 'broken.log'), withDependency: false })
    const destination = join(root, 'broken-bundle')
    await assert.rejects(
      stageEmbeddedPi({
        source,
        destination,
        nodeExecutable: process.execPath,
        ...platformStagingOptions(),
        launchCheck: false
      }),
      /required Pi dependency is not installed: @earendil-works\/missing/
    )
    assert.equal(existsSync(destination), false)
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes('.staging-')),
      []
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stage refuses a non-empty destination and preserves the user files', async () => {
  const root = workspace()
  try {
    const source = makeFixtureSource(join(root, 'install'), { requestLog: join(root, 'requests.log') })
    const destination = join(root, 'bundle')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'user-note.txt'), 'keep me\n')
    await assert.rejects(
      stageEmbeddedPi({
        source,
        destination,
        nodeExecutable: process.execPath,
        ...platformStagingOptions(),
        launchCheck: false
      }),
      /refusing to overwrite non-empty destination/
    )
    assert.equal(readFileSync(join(destination, 'user-note.txt'), 'utf8'), 'keep me\n')
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('.staging-')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('staged bundle', () => {
  const root = workspace()
  const requestLog = join(root, 'requests.log')
  const destination = join(root, 'runtime', 'pi')
  let staged

  before(async () => {
    const source = makeFixtureSource(join(root, 'install'), { requestLog })
    staged = await stageEmbeddedPi({
      source,
      destination,
      nodeExecutable: process.execPath,
      ...platformStagingOptions()
    })
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('writes a portable manifest with relative launcher, node and entry', () => {
    const manifest = JSON.parse(readFileSync(staged.manifestPath, 'utf8'))
    assert.equal(manifest.schema, 1)
    assert.equal(manifest.piVersion, EMBEDDED_PI_VERSION)
    assert.equal(manifest.platform, hostPlatform())
    assert.equal(manifest.arch, hostArch())
    assert.match(manifest.nodeVersion, /^v\d+\./)
    assert.equal(manifest.closureComplete, true)
    assert.equal(manifest.launcher, expectedLauncher().name)
    assert.equal(manifest.launchKind, expectedLauncher().kind)
    assert.equal(manifest.node, hostPlatform() === 'windows' ? 'node/node.exe' : 'node/node')
    assert.equal(manifest.entry, `node_modules/${EMBEDDED_PI_PACKAGE}/dist/bundle/cli.js`)
    for (const file of manifest.files) assertPortableRelativePath(file.path)
    assert.ok(!readFileSync(staged.manifestPath, 'utf8').includes(root), 'manifest must not embed machine paths')
    assert.deepEqual(manifest.optionalMissing, ['@mariozechner/clipboard'])
    assert.ok(existsSync(staged.launcher))
    assert.ok(existsSync(staged.entry))
    assert.ok(existsSync(staged.node))
  })

  test('preserves both installed versions of one package name', () => {
    const packageRoot = join(destination, 'node_modules', ...EMBEDDED_PI_PACKAGE.split('/'))
    // Hoisted sibling and alpha's nested copy must both survive at the exact
    // places Node resolves them from.
    assert.ok(existsSync(join(packageRoot, 'node_modules/leaf/package.json')))
    assert.ok(existsSync(join(packageRoot, 'node_modules/alpha/node_modules/leaf/package.json')))
    assert.equal(
      JSON.parse(readFileSync(join(packageRoot, 'node_modules/leaf/package.json'), 'utf8')).version,
      '1.0.0'
    )
    assert.equal(
      JSON.parse(readFileSync(join(packageRoot, 'node_modules/alpha/node_modules/leaf/package.json'), 'utf8')).version,
      '2.0.0'
    )
    // Real runtime resolution, not path shape: each parent sees its own leaf.
    const requireStaged = createRequire(join(destination, 'package-boundary.cjs'))
    assert.deepEqual(requireStaged(join(packageRoot, 'dist/leaf-consumer.js')), { version: '1.0.0' })
    assert.deepEqual(requireStaged(join(packageRoot, 'node_modules/alpha/index.js')), { version: '2.0.0' })
  })

  test('cyclic dependencies terminate with one placement per install', () => {
    const packageRoot = join(destination, 'node_modules', ...EMBEDDED_PI_PACKAGE.split('/'))
    assert.ok(existsSync(join(packageRoot, 'node_modules/alpha/package.json')))
    assert.ok(existsSync(join(packageRoot, 'node_modules/beta/package.json')))
    const manifest = JSON.parse(readFileSync(staged.manifestPath, 'utf8'))
    const paths = manifest.files.map((file) => file.path)
    assert.equal(new Set(paths).size, paths.length, 'no duplicate manifest entries')
    assert.equal(paths.filter((path) => path.endsWith('/node_modules/alpha/package.json')).length, 1)
    assert.equal(paths.filter((path) => path.endsWith('/node_modules/beta/package.json')).length, 1)
  })

  test('copies the dependency closure, licenses and native assets only', () => {
    const bundleFiles = readdirSync(join(destination, 'node_modules', '@earendil-works/pi-ai', 'dist'))
    assert.deepEqual(bundleFiles.sort(), ['index.js', 'native.wasm'])
    assert.ok(existsSync(join(destination, 'node_modules', '@earendil-works/pi-ai', 'LICENSE')))
    assert.ok(existsSync(join(destination, 'node_modules', ...EMBEDDED_PI_PACKAGE.split('/'), 'npm-shrinkwrap.json')))
    assert.equal(existsSync(join(destination, 'node_modules', ...EMBEDDED_PI_PACKAGE.split('/'), 'dist/client/private.js')), false)
    assert.equal(existsSync(join(destination, 'node_modules', ...EMBEDDED_PI_PACKAGE.split('/'), 'test')), false)
    assert.equal(existsSync(join(destination, 'node_modules', ...EMBEDDED_PI_PACKAGE.split('/'), 'docs')), false)
    const notices = readFileSync(join(destination, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    assert.match(notices, /@earendil-works\/pi-ai \| 0\.85\.1 \| MIT/)
    for (const state of ['auth.json', 'models.json', 'settings.json', 'sessions']) {
      assert.equal(existsSync(join(destination, state)), false, `bundle must not contain ${state}`)
    }
    assert.deepEqual(readdirSync(join(root, 'runtime')).filter((name) => name.includes('.staging-')), [])
  })

  test('verification sends only the documented get_state request', () => {
    const requests = readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(requests.length >= 1, 'the fixture entry must have received a request')
    assert.deepEqual([...new Set(requests.map((request) => request.type))], ['get_state'])
    for (const request of requests) assert.match(request.id, /^rovai-embedded-pi-verify-/)
    assert.ok(!readFileSync(requestLog, 'utf8').includes('prompt'))
  })

  test('re-verifying the staged bundle succeeds and detects payload tampering', async () => {
    const verified = await verifyBundledPi({ root: destination })
    assert.equal(verified.piVersion, EMBEDDED_PI_VERSION)
    const tampered = join(destination, 'node_modules', '@earendil-works/pi-ai', 'dist', 'index.js')
    const original = readFileSync(tampered)
    writeFileSync(tampered, 'module.exports = { tampered: true }\n')
    await assert.rejects(verifyBundledPi({ root: destination, launchCheck: false }), /hash mismatch|size mismatch/)
    writeFileSync(tampered, original)
    await verifyBundledPi({ root: destination, launchCheck: false })
  })

  test('undocumented files and unsafe manifest paths are rejected', async () => {
    const smuggled = join(destination, 'node_modules', '@earendil-works/pi-ai', 'dist', 'smuggled.js')
    writeFileSync(smuggled, '// not in manifest\n')
    await assert.rejects(verifyBundledPi({ root: destination, launchCheck: false }), /undocumented file/)
    rmSync(smuggled)

    const manifestPath = join(destination, 'pi-bundle.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const escaped = { ...manifest, entry: '../outside.js' }
    writeFileSync(manifestPath, `${JSON.stringify(escaped, null, 2)}\n`)
    await assert.rejects(verifyBundledPi({ root: destination, launchCheck: false }), /portable path|unsafe segment/)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await verifyBundledPi({ root: destination, launchCheck: false })
  })

  test('a manifest that skips launcher, node or entry digests is rejected', async () => {
    const manifestPath = join(destination, 'pi-bundle.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const key of ['launcher', 'node', 'entry']) {
      const withoutDigest = {
        ...manifest,
        files: manifest.files.filter((file) => file.path !== manifest[key])
      }
      writeFileSync(manifestPath, `${JSON.stringify(withoutDigest, null, 2)}\n`)
      await assert.rejects(
        verifyBundledPi({ root: destination, launchCheck: false }),
        /does not hash its (launcher|node|entry)/,
        `dropping the ${key} digest must fail verification`
      )
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await verifyBundledPi({ root: destination, launchCheck: false })
  })
})
