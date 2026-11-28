// Contract tests for the self-contained DSH runtime packager, its verifier and
// the personal-package wiring. Pure JavaScript: no npm install, no network and
// no real DSH tree, so the contracts stay testable on every runner.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { archForNode, closureRequirements, entryName, launcherName, listFiles,
  manifestName, nodePath, platformForNode, rootVersion, sha256, treeDigest,
  verifyBundle } from '../../resources/dsh-runtime/verify.mjs'

const repository = resolve(import.meta.dirname, '../..')
const read = path => readFileSync(join(repository, path), 'utf8')
const packager = read('scripts/package-dsh-runtime.mjs')
const verifier = read('resources/dsh-runtime/verify.mjs')
const created = []
test.after(() => { for (const root of created) rmSync(root, { recursive: true, force: true }) })

function writeTree(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
}
// A synthetic but structurally complete bundle: closure, launcher, bundled node
// and enough filler files to exercise the inventory bound.
function buildBundle({ platform = 'linux', arch = 'x86_64' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loom-dsh-runtime-test-'))
  created.push(root)
  const launcher = launcherName(platform), node = nodePath(platform)
  const native = closureRequirements(platform, arch)
    .find(name => name.startsWith('node_modules/node-addon-require-builtin-')).split('/')[1]
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@deepseek-ai/dsh': rootVersion } } } }, null, 2) + '\n'
  const tree = {
    'package.json': JSON.stringify({ name: 'loom-dsh-runtime-test', private: true }) + '\n',
    'package-lock.json': lock,
    'verify.mjs': verifier,
    'THIRD-PARTY-NOTICES.txt': 'notices\n',
    [launcher]: 'launcher shim\n',
    [node]: 'bundled node placeholder\n',
    'node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: rootVersion }) + '\n',
    'node_modules/@deepseek-ai/dsh/lib/bin.js': '// dsh bin\n',
    'node_modules/@deepseek-ai/dsh-sandbox-local/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-sandbox-local', version: rootVersion }) + '\n',
    ['node_modules/' + native + '/package.json']: JSON.stringify({ name: native, version: '0.1.9' }) + '\n'
  }
  for (let index = 0; index < 110; index += 1) {
    tree['node_modules/filler/pkg-' + String(index).padStart(3, '0') + '/index.js'] = '// filler ' + index + '\n'
  }
  writeTree(root, tree)
  if (process.platform !== 'win32') {
    chmodSync(join(root, launcher), 0o755)
    chmodSync(join(root, node), 0o755)
  }
  writeManifest(root, { platform, arch, drop: [] })
  return { root, launcher, node, native }
}
function manifestOf(root, overrides = {}) {
  const files = listFiles(root).filter(name => name !== manifestName).map(path => {
    const bytes = readFileSync(join(root, path))
    return { path, bytes: bytes.length, sha256: sha256(bytes) }
  })
  return {
    schemaVersion: 1,
    kind: 'loom-dsh-runtime',
    platform: overrides.platform ?? 'linux',
    arch: overrides.arch ?? 'x86_64',
    nodeVersion: 'v24.14.1',
    rootVersion,
    closureComplete: true,
    installScripts: false,
    launcher: launcherName(overrides.platform ?? 'linux'),
    node: nodePath(overrides.platform ?? 'linux'),
    entry: entryName,
    lockSha256: sha256(readFileSync(join(root, 'package-lock.json'))),
    treeSha256: treeDigest(files),
    files
  }
}
function writeManifest(root, { platform = 'linux', arch = 'x86_64', drop = [], edit = {} } = {}) {
  const manifest = { ...manifestOf(root, { platform, arch }), ...edit }
  if (drop.length) {
    manifest.files = manifest.files.filter(row => !drop.includes(row.path))
    manifest.treeSha256 = treeDigest(manifest.files)
  }
  writeFileSync(join(root, manifestName), JSON.stringify(manifest, null, 2) + '\n')
  return { digest: sha256(readFileSync(join(root, manifestName))), manifest }
}
function bundleFailure(root, expected) {
  const digest = sha256(readFileSync(join(root, manifestName)))
  assert.throws(() => verifyBundle(root, digest), error => {
    assert.match(error.message, expected)
    return true
  })
}

test('platform and architecture use the Rust vocabulary, never win32/x64', () => {
  assert.equal(platformForNode('linux'), 'linux')
  assert.equal(platformForNode('win32'), 'windows')
  assert.equal(platformForNode('darwin'), 'macos')
  assert.equal(archForNode('x64'), 'x86_64')
  assert.equal(archForNode('arm64'), 'aarch64')
  assert.equal(launcherName('linux'), 'dsh')
  assert.equal(launcherName('macos'), 'dsh')
  assert.equal(launcherName('windows'), 'dsh.cmd')
  assert.equal(nodePath('linux'), 'node/node')
  assert.equal(nodePath('windows'), 'node/node.exe')
  assert.throws(() => platformForNode('freebsd'), /unsupported DSH runtime platform/)
  assert.throws(() => archForNode('ia32'), /unsupported DSH runtime architecture/)
  assert.throws(() => launcherName('win32'), /dsh_bundle_platform_unsupported/)
})

test('Linux closure requires the sandbox-local package and the glibc native addon', () => {
  const closure = closureRequirements('linux', 'x86_64')
  assert.ok(closure.includes('node_modules/@deepseek-ai/dsh-sandbox-local/package.json'))
  assert.ok(closure.includes('node_modules/node-addon-require-builtin-linux-x64-gnu/package.json'))
  assert.ok(closure.includes('dsh'))
  assert.ok(closure.includes('node/node'))
  assert.ok(closure.includes(entryName))
  const windows = closureRequirements('windows', 'x86_64')
  assert.ok(windows.includes('dsh.cmd'))
  assert.ok(windows.includes('node/node.exe'))
  assert.ok(windows.includes('node_modules/node-addon-require-builtin-win32-x64-msvc/package.json'))
})

test('treeSha256 is sha256 over path, bytes and sha256 rows sorted by path', () => {
  const files = [
    { path: 'node/node', bytes: 3, sha256: 'c'.repeat(64) },
    { path: 'dsh', bytes: 1, sha256: 'a'.repeat(64) },
    { path: 'node_modules/x/index.js', bytes: 2, sha256: 'b'.repeat(64) }
  ]
  const expected = sha256(['dsh\t1\t' + 'a'.repeat(64) + '\n',
    'node/node\t3\t' + 'c'.repeat(64) + '\n',
    'node_modules/x/index.js\t2\t' + 'b'.repeat(64) + '\n'].join(''))
  assert.equal(treeDigest(files), expected)
  assert.equal(treeDigest([...files].reverse()), expected)
})

test('verifier accepts a complete bundle and its own CLI', () => {
  const { root } = buildBundle()
  const digest = sha256(readFileSync(join(root, manifestName)))
  const result = verifyBundle(root, digest)
  assert.equal(result.manifest.platform, 'linux')
  assert.equal(result.manifest.arch, 'x86_64')
  assert.equal(result.manifest.entry, entryName)
  const cli = spawnSync(process.execPath, [join(root, 'verify.mjs'), digest], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).status, 'verified')
})

test('verifier refuses a changed manifest, extra files and changed bytes', () => {
  const tampered = buildBundle()
  assert.throws(() => verifyBundle(tampered.root, '0'.repeat(64)), /dsh_bundle_manifest_changed/)
  writeFileSync(join(tampered.root, 'node_modules/filler/extra.js'), '// extra\n')
  bundleFailure(tampered.root, /dsh_bundle_inventory_changed/)
  const changed = buildBundle()
  writeFileSync(join(changed.root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '// changed\n')
  bundleFailure(changed.root, /dsh_bundle_file_changed:/)
  const reshaped = buildBundle()
  writeManifest(reshaped.root, { edit: { treeSha256: 'f'.repeat(64) } })
  bundleFailure(reshaped.root, /dsh_bundle_tree_changed/)
})

test('verifier refuses symlinks and missing closure entries', () => {
  const linked = buildBundle()
  symlinkSync('package.json', join(linked.root, 'node_modules/filler/linked.js'))
  bundleFailure(linked.root, /dsh_bundle_link_refused/)
  const missing = buildBundle()
  const dependency = 'node_modules/@deepseek-ai/dsh-sandbox-local/package.json'
  rmSync(join(missing.root, dependency))
  writeManifest(missing.root, { drop: [dependency] })
  bundleFailure(missing.root, /dsh_bundle_closure_missing:/)
  const nativeMissing = buildBundle()
  const nativePath = 'node_modules/node-addon-require-builtin-linux-x64-gnu/package.json'
  rmSync(join(nativeMissing.root, nativePath))
  writeManifest(nativeMissing.root, { drop: [nativePath] })
  bundleFailure(nativeMissing.root, /dsh_bundle_closure_missing:/)
})

test('verifier refuses Node platform spelling and unpinned root versions', () => {
  const nodeNamed = buildBundle()
  writeManifest(nodeNamed.root, { edit: { platform: 'win32', arch: 'x64' } })
  bundleFailure(nodeNamed.root, /dsh_bundle_platform_invalid|dsh_bundle_launcher_invalid/)
  const drifted = buildBundle()
  writeManifest(drifted.root, { edit: { rootVersion: '0.2.0-rc.1' } })
  bundleFailure(drifted.root, /dsh_bundle_manifest_invalid/)
  const unclosed = buildBundle()
  writeManifest(unclosed.root, { edit: { closureComplete: false } })
  bundleFailure(unclosed.root, /dsh_bundle_manifest_invalid/)
})

test('packager supports Linux x64 and Windows x64 and rejects macOS explicitly', () => {
  assert.match(packager, /--ignore-scripts', '--omit=dev'/)
  assert.match(packager, /platformForNode\(process\.platform\)/)
  assert.match(packager, /demand\(platform === 'linux' \|\| platform === 'windows', 'unsupported DSH runtime platform: ' \+ platform\)/)
  assert.match(packager, /unsupported DSH runtime architecture: ' \+ arch/)
  assert.match(packager, /resources', 'dsh-runtime'/)
  assert.match(packager, /entry: entryName/)
  assert.match(packager, /treeSha256: treeDigest\(files\)/)
  assert.match(packager, /\{ path, bytes: bytes\.length, sha256: sha256\(bytes\) \}/)
  assert.match(packager, /closureComplete: true, installScripts: false/)
  assert.match(packager, /chmodSync\(launcher, 0o755\)/)
  assert.match(packager, /copyFileSync\(realpathSync\.native\(process\.execPath\), bundledNode\)/)
})

test('launchers call the bundled Node through a relative path', () => {
  assert.ok(packager.includes('exec "$root/node/node" "$root/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"'))
  assert.ok(packager.includes('"$root/node_modules/@deepseek-ai/dsh/lib/bin.js"'))
  assert.ok(packager.includes('set "DSH_ROOT=%~dp0"'))
  assert.ok(packager.includes(String.raw`"%DSH_ROOT%node\\node.exe" "%DSH_ROOT%node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*`))
  assert.ok(packager.includes("'root=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd -P)'"))
  assert.doesNotMatch(packager, /exec "\/usr|DSH_ROOT=C:/)
})

test('Linux personal package carries runtime/dsh through --dsh-dir', () => {
  const personal = read('scripts/package-linux-personal.mjs')
  assert.match(personal, /'--server-dir', '--pi-dir', '--dsh-dir'/)
  assert.match(personal, /'runtime\/dsh\/dsh-runtime-bundle\.json', 'runtime\/dsh\/dsh', 'runtime\/dsh\/node\/node'/)
  assert.match(personal, /cpSync\(options\.dshDir, join\(options\.output, 'runtime\/dsh'\), \{ recursive: true \}\)/)
  assert.match(personal, /verifyDshRuntime\(join\(options\.output, 'runtime\/dsh'\)/)
  assert.match(personal, /dsh\.manifest\.platform !== 'linux' \|\| dsh\.manifest\.arch !== 'x86_64'/)
  const workflow = read('.github/workflows/loom-v2-e3-linux.yml')
  assert.match(workflow, /node scripts\/package-dsh-runtime\.mjs --destination resources\/runtime\/dsh/)
  assert.match(workflow, /node scripts\/package-dsh-runtime\.mjs --verify --destination resources\/runtime\/dsh/)
  assert.match(workflow, /--dsh-dir resources\/runtime\/dsh/)
  assert.match(workflow, /resources\/runtime\/dsh\/dsh --version/)
  assert.match(workflow, /ROVAI_EMBEDDED_DSH_ROOT/)
})

test('Windows workflow stages, copies and re-verifies the DSH runtime', () => {
  const workflow = read('.github/workflows/loom-v2-e3-windows.yml')
  assert.match(workflow, /node scripts\/package-dsh-runtime\.mjs --destination resources\/runtime\/dsh/)
  assert.match(workflow, /node scripts\/package-dsh-runtime\.mjs --verify --destination resources\/runtime\/dsh/)
  assert.match(workflow, /Copy-Item resources\/runtime\/dsh \(Join-Path \$kit 'runtime\/dsh'\) -Recurse/)
  assert.match(workflow, /node scripts\/package-dsh-runtime\.mjs --verify --destination \(Join-Path \$kit 'runtime\/dsh'\)/)
  assert.match(workflow, /dshRuntime = \[ordered\]@\{ rootVersion = \$dshBundle\.rootVersion/)
})

test('managers default ROVAI_EMBEDDED_DSH_ROOT only when the user did not set it', () => {
  const shell = read('scripts/manage-loom-personal.sh')
  assert.ok(shell.includes('ROVAI_EMBEDDED_DSH_ROOT=${ROVAI_EMBEDDED_DSH_ROOT:-"$root/runtime/dsh"}'))
  assert.ok(shell.includes('export ROVAI_EMBEDDED_DSH_ROOT'))
  assert.ok(shell.includes('require_exec "$root/runtime/dsh/dsh" runtime/dsh/dsh'))
  assert.ok(shell.includes('require_exec "$root/runtime/dsh/node/node" runtime/dsh/node/node'))
  const syntax = spawnSync('sh', ['-n', join(repository, 'scripts/manage-loom-personal.sh')], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  const powershell = read('scripts/manage-loom-personal.ps1')
  assert.ok(powershell.includes("if (-not $env:ROVAI_EMBEDDED_DSH_ROOT) { $env:ROVAI_EMBEDDED_DSH_ROOT = Join-Path $Root 'runtime\\dsh' }"))
  assert.ok(powershell.includes("'runtime/dsh/dsh-runtime-bundle.json', 'runtime/dsh/dsh.cmd'"))
})
