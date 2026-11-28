import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyRunningHostSchema } from './loom-host-schema.mjs'

const windows = process.platform === 'win32'
const manager = fileURLToPath(new URL('../manage-loom-personal.ps1', import.meta.url))
const required = ['rovai-server.exe', 'rovai-host.exe', 'rovai-core.exe', 'rovai.exe', 'loom-node.exe', 'web-ui/index.html', 'Start-Loom.cmd', 'LICENSE']
const hash = value => createHash('sha256').update(value).digest('hex')

function fixture(t, chosenRoot) {
  const createdRoot = chosenRoot ? resolve(chosenRoot) : mkdtempSync(join(tmpdir(), 'loom-personal-install-'))
  if (chosenRoot) mkdirSync(createdRoot)
  // Windows CI can expose TEMP through an 8.3 alias (RUNNER~1). Match the
  // installer's canonical parent before comparing the chosen data directory.
  const root = realpathSync.native(createdRoot)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, install: join(root, 'LOOM programs'), data: join(root, 'personal data') }
}

test('fixture expands a real Windows 8.3 parent before comparing data directories', { skip: !windows }, t => {
  const parent = fixture(t)
  const script = `Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices;
public static class LoomFixtureShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern uint GetShortPathName(string path, StringBuilder output, uint size); }';
$buffer = New-Object System.Text.StringBuilder 32768;
$size = [LoomFixtureShortPath]::GetShortPathName($env:LOOM_FIXTURE_LONG_PATH, $buffer, 32768);
if ($size -eq 0 -or $size -ge 32768) { throw 'GetShortPathNameW failed'; }
$buffer.ToString()`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, LOOM_FIXTURE_LONG_PATH: parent.root }
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const alias = result.stdout.trim()
  if (!alias.includes('~')) return t.skip('This Windows volume does not provide an 8.3 alias')
  assert.notEqual(alias.toLowerCase(), parent.root.toLowerCase())
  assert.equal(realpathSync.native(alias).toLowerCase(), parent.root.toLowerCase())
  const child = fixture(t, join(alias, 'nested fixture'))
  assert.equal(child.root, join(parent.root, 'nested fixture'))
  assert.equal(child.data, join(parent.root, 'nested fixture', 'personal data'))
})

function makePackage(root, letter, contract = { version: 'v1.72', projectionSchema: 184 }) {
  const directory = join(root, 'package-' + letter)
  mkdirSync(directory)
  const files = {}
  const longPath = 'runtime/pi/' + Array.from({ length: 4 }, (_, i) => 'dependency-' + i + '-'.repeat(48)).join('/') + '/index.js'
  for (const path of [...required, 'runtime/pi/.runtime-marker', 'runtime/pi/node/node.exe', longPath]) {
    const value = Buffer.from(letter + ':' + path)
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), value)
    files[path] = hash(value)
  }
  const manifest = { qualification: 'isolated-personal-development-preview', target: 'windows-x64',
    commit: letter.repeat(40), dailyDataIncluded: false, files }
  if (contract) manifest.dataContract = contract
  writeFileSync(join(directory, 'candidate-manifest.json'), JSON.stringify(manifest))
  return directory
}

function run(action, install, extra = [], options = {}) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', manager,
    '-Action', action, '-InstallDirectory', install, ...extra],
  // Real personal packages contain tens of thousands of pinned runtime files.
  // Keep every byte/manifest check; give the full install enough time to
  // inspect that closure. Small synthetic fixtures retain the tighter budget.
  { encoding: 'utf8', timeout: process.env.LOOM_INSTALL_TEST_KIT ? 600_000 : 240_000, windowsHide: true,
    env: options.env })
}

function installPackage(pkg, fixture_) {
  const result = run('Install', fixture_.install, ['-PackageDirectory', pkg, '-DataDirectory', fixture_.data])
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function state(install) { return JSON.parse(readFileSync(join(install, 'installation.json'), 'utf8')) }
// Rewrite the recorded selection without touching anything else, so a test can
// exercise the upgrade/start rules even when this host cannot launch a Server.
function savedRuntimes(install, runtimes) {
  const current = state(install)
  if (runtimes === null) delete current.runtimes
  else current.runtimes = runtimes
  writeFileSync(join(install, 'installation.json'), JSON.stringify(current))
}
const ALL_RUNTIMES = ['codex-cli', 'pi', 'deepseek-harness', 'claude-code-cli']
function markStarted(install) {
  const current = state(install)
  current.lastStarted = current.current
  writeFileSync(join(install, 'installation.json'), JSON.stringify(current))
}

test('portable launcher rejects a missing manager before attempting to start any Server', { skip: !windows }, t => {
  const f = fixture(t)
  const launcher = fileURLToPath(new URL('../start-loom-personal.cmd', import.meta.url))
  copyFileSync(launcher, join(f.root, 'Start-Loom.cmd'))
  // Deliberately no Server or manager: the current entry point must diagnose the
  // incomplete package, not reach the old direct-Server branch (cmd exit 9009).
  const result = spawnSync('cmd.exe', ['/d', '/c', 'Start-Loom.cmd'], {
    cwd: f.root, encoding: 'utf8', input: '\r\n', windowsHide: true, timeout: 10000,
    env: { ...process.env, LOCALAPPDATA: join(f.root, 'isolated-local-data') }
  })
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.match(result.stdout, /LOOM is incomplete: Manage-Loom\.ps1 is missing/)
  assert.match(result.stdout, /Extract the full ZIP again/)
  assert.equal(existsSync(join(f.root, 'isolated-local-data')), false)
})

// The shipped .cmd wrappers must forward the owner's extra arguments to the
// manager: -Runtimes is unusable from the documented entry point otherwise.
// A stand-in manager records the argv it received, so the assertion is about
// real cmd.exe expansion, not just the wrapper's text. The recording location
// comes from the environment because the test owns the wrapper copy's folder.
const wrapperManager = `$argv = [Environment]::GetCommandLineArgs() | Select-Object -Skip 1
$argv | Set-Content -LiteralPath $env:LOOM_WRAPPER_ARGV -Encoding UTF8
`
const wrapperCases = [
  { name: 'install', cmd: 'install-loom-personal.cmd', copy: 'Install-Loom.cmd', action: 'Install' },
  { name: 'start', cmd: 'start-loom-personal.cmd', copy: 'Start-Loom.cmd', action: 'Portable' },
]

function runWrapper(t, { cmd, copy }, args) {
  const f = fixture(t)
  const source = fileURLToPath(new URL('../' + cmd, import.meta.url))
  copyFileSync(source, join(f.root, copy))
  writeFileSync(join(f.root, 'Manage-Loom.ps1'), wrapperManager)
  const receivedPath = join(f.root, 'received-argv.txt')
  // Keep the pass-through observable without changing either wrapper's own
  // error handling: a silent stdin satisfies `pause` on both branches.
  const result = spawnSync('cmd.exe', ['/d', '/c', copy, ...args], {
    cwd: f.root, encoding: 'utf8', input: '\r\n', windowsHide: true, timeout: 120_000,
    env: { ...process.env, LOCALAPPDATA: join(f.root, 'isolated-local-data'), LOOM_WRAPPER_ARGV: receivedPath }
  })
  assert.equal(existsSync(receivedPath), true, result.stderr || result.stdout)
  return readFileSync(receivedPath, 'utf8').split(/\r?\n/).filter(Boolean)
}

for (const wrapper of wrapperCases) {
  test(`${wrapper.cmd} forwards extra arguments such as -Runtimes to the manager`, { skip: !windows }, t => {
    const received = runWrapper(t, wrapper, ['-Runtimes', 'pi'])
    // The fixed wrapper prefix is still there, so the action is unchanged.
    assert.deepEqual(received.slice(0, 3), ['-NoLogo', '-NoProfile', '-File'])
    assert.ok(received.includes('-Action'), received.join(' '))
    assert.equal(received[received.indexOf('-Action') + 1], wrapper.action)
    // The user-supplied switch reaches PowerShell as its own token and value.
    const index = received.indexOf('-Runtimes')
    assert.notEqual(index, -1, 'the wrapper dropped -Runtimes: ' + received.join(' '))
    assert.equal(received[index + 1], 'pi')
    // The forwarded arguments come after the wrapper's own fixed parameters.
    assert.ok(index > received.indexOf('-PackageDirectory'), received.join(' '))
  })

  test(`${wrapper.cmd} still rejects an unknown runtime through the forwarded switch`, { skip: !windows }, t => {
    // The real fail-fast path is the manager's ValidateSet-free parser, so a
    // bogus -Runtimes value must reach it instead of being silently ignored.
    const received = runWrapper(t, wrapper, ['-Runtimes', 'pi,turbo'])
    assert.equal(received[received.indexOf('-Runtimes') + 1], 'pi,turbo')
  })
}

test('both cmd wrappers forward %* and keep their existing error handling', () => {
  for (const wrapper of wrapperCases) {
    const text = readFileSync(fileURLToPath(new URL('../' + wrapper.cmd, import.meta.url)), 'utf8')
    const call = text.split(/\r?\n/).find(line => line.startsWith('powershell.exe '))
    assert.ok(call, wrapper.cmd + ' has no powershell.exe call')
    assert.ok(call.endsWith('-PackageDirectory "%~dp0\\" %*'), wrapper.cmd + ' must end with %*: ' + call)
    assert.match(call, new RegExp('-Action ' + wrapper.action + '\\b'))
    // The pause/exit contract the owner relies on is untouched.
    assert.match(text, /if errorlevel 1 \(/)
    assert.match(text, /\bpause\b/)
  }
  // The start wrapper still refuses an incomplete package before PowerShell.
  const start = readFileSync(fileURLToPath(new URL('../start-loom-personal.cmd', import.meta.url)), 'utf8')
  assert.match(start, /if not exist "%~dp0Manage-Loom\.ps1" \(/)
  assert.match(start, /exit \/b 1/)
})

test('declared Hook runtime is complete, bound to its manifest, and checked before startup', { skip: !windows }, t => {
  const f = fixture(t)
  const pkg = makePackage(f.root, 'a')
  const manifestPath = join(pkg, 'candidate-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dshHookExecutor = { dshVersion: '0.1.5-rc.2', manifestSha256: '0'.repeat(64) }
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest))
  save()
  const incomplete = run('Install', f.install, ['-PackageDirectory', pkg])
  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /DSH Hook runtime is incomplete/)
  assert.equal(existsSync(f.install), false)
  for (const name of ['hook-executor-bundle.json', 'executor.mjs', 'verify.mjs', 'package.json', 'package-lock.json', 'THIRD-PARTY-NOTICES.txt']) {
    const relative = 'runtime/dsh-hook-executor/' + name
    const value = name.endsWith('.json') ? '{}\n' : 'owned installer fixture: ' + name
    mkdirSync(dirname(join(pkg, relative)), { recursive: true })
    writeFileSync(join(pkg, relative), value)
    manifest.files[relative] = hash(value)
  }
  save()
  const unbound = run('Install', f.install, ['-PackageDirectory', pkg])
  assert.notEqual(unbound.status, 0)
  assert.match(unbound.stderr, /DSH Hook manifest does not match/)
  assert.equal(existsSync(f.install), false)
  manifest.dshHookExecutor.manifestSha256 = manifest.files['runtime/dsh-hook-executor/hook-executor-bundle.json']
  save()
  installPackage(pkg, f)
  const installed = join(f.install, 'versions', 'a'.repeat(40))
  assert.equal(readFileSync(join(installed, 'runtime/dsh-hook-executor/THIRD-PARTY-NOTICES.txt'), 'utf8'), 'owned installer fixture: THIRD-PARTY-NOTICES.txt')
  writeFileSync(join(installed, 'runtime/dsh-hook-executor/executor.mjs'), 'changed after installation')
  const damaged = run('Start', f.install)
  assert.notEqual(damaged.status, 0)
  assert.match(damaged.stderr, /Damaged program file: runtime\/dsh-hook-executor\/executor\.mjs/)
  assert.equal(existsSync(f.data), false, 'a rejected package must not start its Server or create data')
})

test('install, upgrade and compatible rollback keep data and both program versions', { skip: !windows }, t => {
  const f = fixture(t)
  const a = makePackage(f.root, 'a')
  const b = makePackage(f.root, 'b')
  installPackage(a, f)
  assert.equal(existsSync(f.data), false, 'installer must leave private data-root creation to native Server')
  mkdirSync(f.data)
  writeFileSync(join(f.data, 'preserved.txt'), 'existing personal data')
  installPackage(b, f)
  assert.equal(state(f.install).current, 'b'.repeat(40))
  assert.equal(state(f.install).previous, 'a'.repeat(40))
  markStarted(f.install)
  assert.equal(run('Rollback', f.install).status, 0)
  assert.equal(state(f.install).current, 'a'.repeat(40))
  assert.equal(readFileSync(join(f.data, 'preserved.txt'), 'utf8'), 'existing personal data')
  assert.deepEqual(readdirSync(join(f.install, 'versions')).sort(), ['a'.repeat(40), 'b'.repeat(40)])
  assert.equal(existsSync(join(f.install, 'versions', 'a'.repeat(40), 'runtime/pi/.runtime-marker')), true)
  assert.equal(existsSync(join(f.install, 'Start-Loom.cmd')), true)
  installPackage(a, f)
  assert.equal(state(f.install).previous, 'b'.repeat(40), 'same-version repair keeps rollback target')
})

test('install without -Runtimes records all four runtimes and schema stays 1', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a'), f)
  const recorded = state(f.install)
  // The default light build enables every packaged runtime, in the canonical
  // AdapterKind order the launcher exports as LOOM_ENABLED_RUNTIMES.
  assert.deepEqual(recorded.runtimes, ALL_RUNTIMES)
  assert.equal(recorded.schema, 1)
  // The selection is launcher metadata only; every runtime file stays copied.
  assert.equal(existsSync(join(f.install, 'versions', 'a'.repeat(40), 'runtime/pi/.runtime-marker')), true)
  assert.equal(existsSync(join(f.install, 'versions', 'a'.repeat(40), 'runtime/pi/node/node.exe')), true)
})

test('installing only pi writes just pi to installation.json and keeps every packaged file', { skip: !windows }, t => {
  const f = fixture(t)
  const pkg = makePackage(f.root, 'a')
  const result = run('Install', f.install, ['-PackageDirectory', pkg, '-DataDirectory', f.data, '-Runtimes', 'pi'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const recorded = state(f.install)
  assert.deepEqual(recorded.runtimes, ['pi'])
  assert.equal(recorded.schema, 1, 'the runtime selection is an added JSON property, not a schema change')
  assert.equal(recorded.current, 'a'.repeat(40))
  // "pi only" is an enable list, not a copy list: the whole closure is installed.
  const version = join(f.install, 'versions', 'a'.repeat(40))
  for (const relative of ['runtime/pi/.runtime-marker', 'runtime/pi/node/node.exe', 'rovai-server.exe', 'web-ui/index.html']) {
    assert.equal(existsSync(join(version, relative)), true, relative)
  }
  assert.match(result.stdout, /Enabled runtimes: pi/)
})

test('short runtime names expand to the canonical adapter ids', { skip: !windows }, t => {
  // Each case is one flat triple: the package/fixture letter, the -Runtimes
  // value typed by the owner, and the canonical list that must be recorded.
  const cases = [
    { letter: 'a', value: 'codex, dsh , claude', runtimes: ['codex-cli', 'deepseek-harness', 'claude-code-cli'] },
    { letter: 'b', value: 'Pi', runtimes: ['pi'] },
    { letter: 'c', value: 'claude,pi', runtimes: ['pi', 'claude-code-cli'] },
    { letter: 'd', value: 'codex,pi,dsh,claude', runtimes: ALL_RUNTIMES },
  ]
  for (const { letter, value, runtimes } of cases) {
    assert.equal(typeof letter, 'string')
    assert.equal(typeof value, 'string')
    assert.ok(Array.isArray(runtimes) && runtimes.every(item => typeof item === 'string'))
    const f = fixture(t)
    const install = join(f.root, 'programs-' + letter)
    // spawnSync only accepts strings in argv; check before handing it to Windows.
    const args = ['-PackageDirectory', makePackage(f.root, letter),
      '-DataDirectory', join(f.root, 'data-' + letter), '-Runtimes', value]
    assert.ok(args.every(arg => typeof arg === 'string'), 'launcher argv must be strings: ' + JSON.stringify(args))
    const result = run('Install', install, args)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    // The stored list is always canonical AdapterKind order, never the input order.
    assert.deepEqual(state(install).runtimes, runtimes, value)
  }
})

test('canonical adapter ids select the same runtimes as the short names', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a'), f)
  const saved = readFileSync(join(f.install, 'installation.json'), 'utf8')
  const upgrade = run('Install', f.install, ['-PackageDirectory', makePackage(f.root, 'b'),
    '-Runtimes', 'claude-code-cli,codex-cli'])
  assert.equal(upgrade.status, 0, upgrade.stderr || upgrade.stdout)
  assert.deepEqual(state(f.install).runtimes, ['codex-cli', 'claude-code-cli'])
  assert.equal(state(f.install).schema, 1)
  assert.notEqual(readFileSync(join(f.install, 'installation.json'), 'utf8'), saved)
})

test('an upgrade and a start without -Runtimes keep the saved selection', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a'), f)
  const pkg = makePackage(f.root, 'b')
  const first = run('Install', f.install, ['-PackageDirectory', pkg, '-Runtimes', 'pi'])
  assert.equal(first.status, 0, first.stderr || first.stdout)
  assert.deepEqual(state(f.install).runtimes, ['pi'])
  installPackage(makePackage(f.root, 'c'), f)
  assert.deepEqual(state(f.install).runtimes, ['pi'], 'an upgrade must keep the owner selection')
  // The synthetic package has no runnable Server, so Start itself cannot be
  // observed here. Exercise the other state-rewriting path instead: rollback
  // must not drop the owner selection.
  markStarted(f.install)
  assert.equal(run('Rollback', f.install).status, 0)
  assert.deepEqual(state(f.install).runtimes, ['pi'], 'a version switch must keep the owner selection')
})

test('an installation without a saved selection reports the default instead of failing', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a'), f)
  savedRuntimes(f.install, null)
  const status = run('Status', f.install)
  assert.equal(status.status, 0, status.stderr || status.stdout)
  assert.deepEqual(JSON.parse(status.stdout).runtimes, ALL_RUNTIMES)
  // Status reports the default; it must not rewrite the file it just read.
  assert.equal(Object.hasOwn(state(f.install), 'runtimes'), false)
})

// A pre-selection installation.json has no "runtimes" property at all. On
// Windows PowerShell 5.1 Read-Json returns a JavaScriptSerializer dictionary, so
// the shipped `$State.runtimes = ...` / `$State.lastStarted = ...` property sets
// fail there and Status/Start abort on a legacy install. Exercise the real
// manager against such a file instead of trusting the helpers in isolation.
test('a legacy state without a runtimes property still answers Status and Start', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a'), f)
  // Remove the added property entirely, exactly like a state file written by a
  // manager that predates the light-edition runtime selection.
  const legacy = state(f.install)
  delete legacy.runtimes
  writeFileSync(join(f.install, 'installation.json'), JSON.stringify(legacy))
  const status = run('Status', f.install)
  assert.equal(status.status, 0, 'Status must not fail on a missing runtimes property: ' + (status.stderr || status.stdout))
  assert.deepEqual(JSON.parse(status.stdout).runtimes, ALL_RUNTIMES, 'a missing selection falls back to all four')
  assert.equal(Object.hasOwn(state(f.install), 'runtimes'), false, 'Status must not rewrite installation.json')
  // Start reaches the same state-rewriting path (lastStarted + saved runtimes)
  // before handing control to the Server. The synthetic package has no runnable
  // Server, so only the pre-launch failure is expected: never a property-set
  // error, and the state file must gain the default selection, not an empty one.
  const started = run('Start', f.install)
  assert.doesNotMatch(started.stderr, /The property 'runtimes' cannot be found|SetValueInvocationException/,
    'Start must not fail while writing a missing runtimes property')
  assert.deepEqual(state(f.install).runtimes, ALL_RUNTIMES,
    'Start records the default selection instead of an empty one')
})

test('an unknown runtime name is rejected instead of silently narrowing', { skip: !windows }, t => {
  const f = fixture(t)
  const result = run('Install', f.install, ['-PackageDirectory', makePackage(f.root, 'a'), '-Runtimes', 'pi,turbo'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown LOOM runtime: turbo/)
})

test('launcher exports LOOM_ENABLED_RUNTIMES as the canonical comma list', () => {
  const managerText = readFileSync(manager, 'utf8')
  assert.match(managerText, /\$env:LOOM_ENABLED_RUNTIMES = Format-RuntimeSelection \$EnabledRuntimes/)
  assert.match(managerText, /\$defaultRuntimes = @\('codex-cli', 'pi', 'deepseek-harness', 'claude-code-cli'\)/)
  // Start passes the saved selection, so an installed launch exports it.
  assert.match(managerText, /Run-Loom \$release \$state\.dataDirectory \$state\.port \$selected \(Format-RuntimeSelection \(Get-SavedRuntimes \$state\)\)/)
  // An unattended first install never prompts: the prompt is fenced by an
  // interactive console check and falls back to all four.
  assert.match(managerText, /elseif \(\[Environment\]::UserInteractive -and -not \[Console\]::IsInputRedirected\)/)
})

test('Start persists a normalized runtimes selection even without -Runtimes', () => {
  // The Windows-only legacy-state test covers the behaviour; this mirrors the
  // shipped source so a regression is caught on every host. A state file from
  // before the light edition has no runtimes property, so Start must always
  // write one: an explicit -Runtimes wins, otherwise the saved/default value is
  // normalized and stored before the Server starts.
  const managerText = readFileSync(manager, 'utf8')
  const start = managerText.slice(managerText.indexOf("$Action -eq 'Start'"))
  const explicit = start.indexOf('if ($startRuntimes) { Set-SavedRuntimes $state $startRuntimes }')
  const fallback = start.indexOf('else { Set-SavedRuntimes $state (Get-SavedRuntimes $state) }')
  assert.notEqual(explicit, -1, 'Start must persist an explicit -Runtimes selection')
  assert.notEqual(fallback, -1, 'Start must persist a normalized selection without -Runtimes')
  assert.ok(fallback > explicit, 'the default branch must follow the explicit one')
  assert.ok(start.indexOf('Write-AtomicJson $statePath $state') > fallback,
    'the selection must be normalized before the state file is written')
})

// Run an expression against the manager's real selection helpers without
// executing the installer body. The helper block is extracted from the shipped
// script so the test can never drift onto a copy of the code.
function runSelectionHelpers(expression) {
  const managerText = readFileSync(manager, 'utf8')
  // Split on the first statement of the installer instead of matching the
  // helper body: the helpers must be exercised exactly as shipped.
  const start = managerText.indexOf('$runtimeAliases = [ordered]@{')
  const end = managerText.indexOf('function Resolve-Directory')
  assert.ok(start > 0 && end > start, 'the runtime selection helper block moved; update this test')
  const helpers = managerText.slice(start, end)
  const script = helpers + '\n' + expression
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true })
}

test('selection helpers always produce a canonical string array, never a comma string', { skip: !windows }, () => {
  const result = runSelectionHelpers(`
$cases = @(
  @{ in = @('pi', 'deepseek-harness'); want = @('pi', 'deepseek-harness') },
  @{ in = 'pi,dsh'; want = @('pi', 'deepseek-harness') },
  @{ in = @('codex-cli,pi'); want = @('codex-cli', 'pi') },
  @{ in = @('pi', 'codex-cli, dsh'); want = @('codex-cli', 'pi', 'deepseek-harness') },
  @{ in = @('claude', 'PI'); want = @('pi', 'claude-code-cli') },
  @{ in = $null; want = $defaultRuntimes }
)
foreach ($case in $cases) {
  $got = @(Get-CanonicalRuntimes $case.in)
  if (($got -join ',') -ne ($case.want -join ',')) { throw "canonical mismatch: $($got -join ',') vs $($case.want -join ',')" }
  foreach ($name in $got) { if ($name -isnot [string]) { throw 'canonical item is not a string' } }
}
# Format-RuntimeSelection stays a single comma string for the environment export.
$csv = Format-RuntimeSelection @('pi', 'dsh')
if ($csv -ne 'pi,deepseek-harness') { throw "export mismatch: $csv" }
if (@($csv).Count -ne 1) { throw 'the export must stay one scalar string' }
# A state object written through the setter must serialize as a JSON array.
$state = [ordered]@{ schema = 1; runtimes = @($csv) }
Set-SavedRuntimes $state $csv
$json = $state | ConvertTo-Json -Compress
if ($json -notmatch '"runtimes":\["pi","deepseek-harness"\]') { throw "json mismatch: $json" }
# The setter must also work when the state object predates the property: both
# the PSCustomObject (ConvertFrom-Json) and dictionary (Read-Json) shapes.
$legacyObject = '{"schema":1}' | ConvertFrom-Json
Set-SavedRuntimes $legacyObject 'pi'
if (($legacyObject.runtimes -join ',') -ne 'pi') { throw "legacy object mismatch: $($legacyObject.runtimes -join ',')" }
$legacyDict = New-Object 'Collections.Generic.Dictionary[string,object]'
Set-SavedRuntimes $legacyDict 'pi'
if (($legacyDict['runtimes'] -join ',') -ne 'pi') { throw "legacy dictionary mismatch: $($legacyDict['runtimes'] -join ',')" }
if (((Get-SavedRuntimes $legacyObject) -join ',') -ne 'pi') { throw 'legacy object read-back failed' }
if (((Get-SavedRuntimes $legacyDict) -join ',') -ne 'pi') { throw 'legacy dictionary read-back failed' }
'pi,deepseek-harness,codex-cli,claude-code-cli'`)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('an unknown runtime token still fails fast in the shared helpers', { skip: !windows }, () => {
  const result = runSelectionHelpers(`
try { ConvertFrom-RuntimeSelection 'pi,turbo' | Out-Null; throw 'accepted an unknown runtime' }
catch { if ($_.Exception.Message -notmatch 'Unknown LOOM runtime: turbo') { throw $_ } }
'ok'`)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('a multi-select install keeps both entries in installation.json across an upgrade', { skip: !windows }, t => {
  const f = fixture(t)
  const first = run('Install', f.install, ['-PackageDirectory', makePackage(f.root, 'a'),
    '-DataDirectory', f.data, '-Runtimes', 'pi,dsh'])
  assert.equal(first.status, 0, first.stderr || first.stdout)
  // The shipped defect stored @('pi,deepseek-harness') as one element.
  assert.deepEqual(state(f.install).runtimes, ['pi', 'deepseek-harness'])
  assert.match(first.stdout, /Enabled runtimes: pi,deepseek-harness/)
  // Replacing the program version must preserve the owner selection verbatim.
  installPackage(makePackage(f.root, 'b'), f)
  const upgraded = state(f.install)
  assert.equal(upgraded.current, 'b'.repeat(40))
  assert.deepEqual(upgraded.runtimes, ['pi', 'deepseek-harness'],
    'an upgrade must not collapse the selection back to all four')
  assert.ok(!upgraded.runtimes.some(entry => entry.includes(',')),
    'installation.json must not contain a comma-joined runtime string')
  // Rollback and Status read the same array back as two runtimes.
  markStarted(f.install)
  assert.equal(run('Rollback', f.install).status, 0)
  assert.deepEqual(state(f.install).runtimes, ['pi', 'deepseek-harness'])
  const status = run('Status', f.install)
  assert.equal(status.status, 0, status.stderr || status.stdout)
  assert.deepEqual(JSON.parse(status.stdout).runtimes, ['pi', 'deepseek-harness'])
})

test('a legacy comma-string selection is still read as its individual runtimes', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a'), f)
  // Reproduce a state file written by the previous manager, then upgrade.
  savedRuntimes(f.install, 'pi,deepseek-harness')
  installPackage(makePackage(f.root, 'b'), f)
  assert.deepEqual(state(f.install).runtimes, ['pi', 'deepseek-harness'])
  savedRuntimes(f.install, ['pi,deepseek-harness'])
  const status = run('Status', f.install)
  assert.equal(status.status, 0, status.stderr || status.stdout)
  assert.deepEqual(JSON.parse(status.stdout).runtimes, ['pi', 'deepseek-harness'])
})

test('damaged upgrade and reused commit cannot replace the active installation', { skip: !windows }, t => {
  const f = fixture(t)
  const a = makePackage(f.root, 'a')
  const b = makePackage(f.root, 'b')
  installPackage(a, f)
  const before = readFileSync(join(f.install, 'installation.json'), 'utf8')
  writeFileSync(join(b, 'web-ui/index.html'), 'changed after manifest')
  const damaged = run('Install', f.install, ['-PackageDirectory', b])
  assert.notEqual(damaged.status, 0)
  assert.match(damaged.stderr, /Damaged package file/)
  assert.equal(readFileSync(join(f.install, 'installation.json'), 'utf8'), before)
  const sourceManifest = JSON.parse(readFileSync(join(a, 'candidate-manifest.json'), 'utf8'))
  sourceManifest.extra = 'same commit, different package'
  writeFileSync(join(a, 'candidate-manifest.json'), JSON.stringify(sourceManifest))
  const reused = run('Install', f.install, ['-PackageDirectory', a])
  assert.notEqual(reused.status, 0)
  assert.match(reused.stderr, /different package contents/)
  assert.equal(readFileSync(join(f.install, 'installation.json'), 'utf8'), before)
})

test('rollback after first start rejects changed or unknown data contracts', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a'), f)
  installPackage(makePackage(f.root, 'b', { version: 'v2', projectionSchema: 185 }), f)
  markStarted(f.install)
  const before = readFileSync(join(f.install, 'installation.json'), 'utf8')
  const denied = run('Rollback', f.install)
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /same data format/)
  assert.equal(readFileSync(join(f.install, 'installation.json'), 'utf8'), before)
})

test('an unstarted upgrade can be rolled back without opening personal data', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a', null), f)
  markStarted(f.install)
  installPackage(makePackage(f.root, 'b', null), f)
  assert.equal(run('Rollback', f.install).status, 0)
  assert.equal(state(f.install).current, 'a'.repeat(40))
  assert.equal(existsSync(f.data), false)
})

test('package traversal, missing files and junctions fail before installation', { skip: !windows }, t => {
  const f = fixture(t)
  const a = makePackage(f.root, 'a')
  const manifestPath = join(a, 'candidate-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files['../escape'] = '0'.repeat(64)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.notEqual(run('Install', f.install, ['-PackageDirectory', a]).status, 0)
  assert.equal(existsSync(f.install), false)
  delete manifest.files['../escape']
  writeFileSync(manifestPath, JSON.stringify(manifest))
  rmSync(join(a, 'rovai.exe'))
  assert.notEqual(run('Install', f.install, ['-PackageDirectory', a]).status, 0)
  assert.equal(existsSync(f.install), false)
  const b = makePackage(f.root, 'b')
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'untouched')
  symlinkSync(outside, join(b, 'redirect'), 'junction')
  const linked = run('Install', f.install, ['-PackageDirectory', b])
  assert.notEqual(linked.status, 0)
  assert.match(linked.stderr, /linked path/)
  assert.equal(existsSync(f.install), false)
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'untouched')
})

test('installer refuses unknown folders and changing the selected data directory', { skip: !windows }, t => {
  const f = fixture(t)
  const a = makePackage(f.root, 'a')
  mkdirSync(f.install)
  writeFileSync(join(f.install, 'keep'), 'unrelated app')
  assert.notEqual(run('Install', f.install, ['-PackageDirectory', a]).status, 0)
  assert.equal(readFileSync(join(f.install, 'keep'), 'utf8'), 'unrelated app')
  f.install = join(f.root, 'owned installation')
  installPackage(a, f)
  const result = run('Install', f.install, ['-PackageDirectory', a, '-DataDirectory', join(f.root, 'different data')])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /keeps the existing personal data/)
  assert.equal(state(f.install).dataDirectory, f.data)
})

test('installing an older package cannot bypass the startup data-format guard', { skip: !windows }, t => {
  const f = fixture(t)
  installPackage(makePackage(f.root, 'a', { version: 'v2', projectionSchema: 200 }), f)
  markStarted(f.install)
  installPackage(makePackage(f.root, 'b'), f)
  const denied = run('Start', f.install)
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /cannot safely open data/)
  assert.equal(state(f.install).lastStarted, 'a'.repeat(40))
  assert.equal(existsSync(f.data), false)
})


test('declared computer runtime must be complete and damaged helpers cannot start', { skip: !windows }, t => {
  const f = fixture(t)
  const pkg = makePackage(f.root, 'a')
  const manifestPath = join(pkg, 'candidate-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.computerRuntime = { python: '3.14.10', pillow: '13.0.0' }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const missing = run('Install', f.install, ['-PackageDirectory', pkg])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /Computer runtime is incomplete/)
  assert.equal(existsSync(f.install), false)
  for (const relative of ['computer-bundle.json', 'python/python.exe', 'python/python314._pth',
    'host_desktop.py', 'mcp_bridge.py', 'THIRD-PARTY-NOTICES.txt']) {
    const path = 'runtime/computer/' + relative
    mkdirSync(dirname(join(pkg, path)), { recursive: true })
    writeFileSync(join(pkg, path), path)
    manifest.files[path] = hash(Buffer.from(path))
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  installPackage(pkg, f)
  const helper = join(f.install, 'versions', 'a'.repeat(40), 'runtime/computer/host_desktop.py')
  writeFileSync(helper, 'changed after installation')
  const damaged = run('Start', f.install)
  assert.notEqual(damaged.status, 0)
  assert.match(damaged.stderr, /Damaged program file: runtime\/computer\/host_desktop\.py/)
  assert.equal(existsSync(f.data), false)
})

async function freePort() {
  const server = createServer()
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const port = server.address().port
  await new Promise(yes => server.close(yes))
  return port
}

async function stopOwnedTree(child) {
  if (child.exitCode !== null) return
  const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  assert.equal(stopped.status, 0, 'could not stop the test-owned launcher')
  await new Promise(resolve_ => { if (child.exitCode !== null) resolve_(); else child.once('exit', resolve_) })
}

// ---------------------------------------------------------------------------
// Real candidate helpers. The owner's profile, temp directory, installed app
// data and any inherited LOOM runtime override must never reach the child that
// installs or starts the package under acceptance.
// ---------------------------------------------------------------------------
const OVERRIDES = ['ROVAI_EMBEDDED_PI_ROOT', 'PI_CODING_AGENT_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME',
  'ROVAI_DEEPSEEK_HARNESS_BIN', 'NODE_OPTIONS', 'NODE_PATH', 'LOOM_COMPUTER_PYTHON', 'LOOM_COMPUTER_HELPER',
  'LOOM_COMPUTER_AGENT_PYTHON', 'LOOM_COMPUTER_AGENT_BRIDGE', 'LOOM_COMPUTER_AGENT_PI_MCP']

function isolatedEnv(root) {
  const env = { ...process.env }
  for (const name of OVERRIDES) delete env[name]
  const directories = { HOME: join(root, 'isolated-user'), USERPROFILE: join(root, 'isolated-user'),
    APPDATA: join(root, 'isolated-appdata'), LOCALAPPDATA: join(root, 'isolated-local-data'),
    TEMP: join(root, 'isolated-temp'), TMP: join(root, 'isolated-temp') }
  for (const directory of new Set(Object.values(directories))) mkdirSync(directory, { recursive: true })
  return Object.assign(env, directories)
}

function tracer(tracePath) {
  return (stage, detail = {}) => {
    const entry = { at: new Date().toISOString(), stage, ...detail }
    if (tracePath) writeFileSync(tracePath, JSON.stringify(entry) + '\n', { flag: 'a' })
    return entry.at
  }
}

// Every stage of the long install is timed, so a later timeout names the step
// that ran out of budget instead of leaving a removed fixture behind.
function installReal({ pkg, f, port, env, limitMs, trace }) {
  return new Promise((settle, fail) => {
    const startedAt = new Date().toISOString()
    trace('install-start', { package: pkg, install: f.install, data: f.data, port })
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', manager,
      '-Action', 'Install', '-InstallDirectory', f.install, '-PackageDirectory', pkg,
      '-DataDirectory', f.data, '-Port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', part => { stdout += part })
    child.stderr.on('data', part => { stderr += part })
    const timeline = { installStartedAt: startedAt }
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      trace('install-deadline-exceeded', { limitMs, ...timeline })
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }, limitMs)
    const poll = setInterval(() => {
      try {
        if (!timeline.installDirectoryCreatedAt && existsSync(join(f.install, 'INSTALLER-V1'))) {
          timeline.installDirectoryCreatedAt = new Date().toISOString()
          trace('isolated-install-directory-created', { install: f.install })
        }
        if (!timeline.incomingCopyAt) {
          const incoming = readdirSync(f.install).find(name => name.startsWith('.incoming-'))
          if (incoming) {
            timeline.incomingCopyAt = new Date().toISOString()
            trace('incoming-copy-created', { incoming })
          }
        }
        if (!timeline.versionActivatedAt) {
          const versions = readdirSync(join(f.install, 'versions'))
          if (versions.length) {
            timeline.versionActivatedAt = new Date().toISOString()
            trace('version-directory-activated', { versions })
          }
        }
      } catch { /* the install directory may not exist yet */ }
    }, 1_000)
    child.once('error', error => { clearInterval(poll); clearTimeout(deadline); fail(error) })
    child.once('close', code => {
      clearInterval(poll)
      clearTimeout(deadline)
      timeline.installFinishedAt = new Date().toISOString()
      timeline.installExitCode = code
      timeline.installTimedOut = timedOut
      trace('install-exit', { code, timedOut, ...timeline })
      settle({ code, timedOut, stdout, stderr, timeline })
    })
  })
}

function listenerFor(port) {
  // Bind the endpoint under test to the process that really owns it before any
  // authenticated request is made from this test.
  const script = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $c) { 'none|'; exit }
$p = Get-Process -Id $c.OwningProcess -ErrorAction Stop
"$($p.Id)|$($p.Path)"`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, 'could not identify the listener on the isolated port: ' + (result.stderr || ''))
  const [pid, program] = result.stdout.trim().split('|')
  assert.notEqual(pid, 'none', 'no process listens on the isolated port')
  return { pid: Number(pid), programPath: program || '' }
}

test('installed real candidate starts, persists its data and restarts at the same address', {
  skip: !windows || !process.env.LOOM_INSTALL_TEST_KIT, timeout: 900_000,
}, async t => {
  const f = fixture(t, process.env.LOOM_INSTALL_TEST_ROOT)
  const pkg = resolve(process.env.LOOM_INSTALL_TEST_KIT)
  const port = process.env.LOOM_INSTALL_TEST_PORT ? Number(process.env.LOOM_INSTALL_TEST_PORT) : await freePort()
  const origin = 'http://127.0.0.1:' + port
  // 64851/64852 belong to the owner's running instances and are never probed.
  assert.notEqual(port, 64851)
  assert.notEqual(port, 64852)
  const manifest = JSON.parse(readFileSync(join(pkg, 'candidate-manifest.json'), 'utf8'))
  const env = isolatedEnv(f.root)
  const trace = tracer(process.env.LOOM_INSTALL_TEST_TRACE)
  const installed = await installReal({
    // run-01 stopped at this boundary: it showed the serial closure check used
    // 384 s of the 600 s budget for the source package alone. Verify-Package now
    // hashes the closure in parallel (measured: 8 s for 33,845 files / 1.79 GB),
    // so the plan's own budget is kept rather than enlarged.
    pkg, f, port, env, limitMs: 600_000, trace
  })
  assert.equal(installed.timedOut, false, 'the installer exceeded its 600 s budget: ' +
    JSON.stringify(installed.timeline))
  assert.equal(installed.code, 0, (installed.stderr || installed.stdout).slice(-4000))
  assert.equal(existsSync(f.data), false, 'the installer must leave personal-data creation to the Server')
  const commit = state(f.install).current
  assert.equal(commit, manifest.commit)
  assert.equal(state(f.install).port, port)
  // The data directory does not exist yet (the installer must not create it),
  // so compare the recorded absolute path instead of resolving a missing path.
  assert.equal(state(f.install).dataDirectory.toLowerCase(), f.data.toLowerCase(),
    'the installer kept a different personal-data directory')
  const managerDigest = hash(readFileSync(manager))
  const installedManagerDigest = hash(readFileSync(join(f.install, 'Manage-Loom.ps1')))
  // The installer copies the manager that is executing ($PSCommandPath), so the
  // installed entry point must be the reviewed manager of this tree.
  assert.equal(installedManagerDigest, managerDigest, 'the installed manager is not the executing manager')
  // The packaged closure must still be the one the candidate manifest describes,
  // including the manager shipped inside the version directory.
  const packagedManagerDigest = hash(readFileSync(join(f.install, 'versions', commit, 'Manage-Loom.ps1')))
  assert.equal(packagedManagerDigest, manifest.files['Manage-Loom.ps1'],
    'the packaged manager differs from the candidate manifest entry')
  assert.equal(existsSync(join(f.install, 'versions', commit, 'candidate-manifest.json')), true)
  assert.equal(existsSync(join(f.install, 'Start-Loom.cmd')), true)
  assert.equal(readdirSync(f.install).some(name => name.startsWith('.incoming-')), false,
    'an incomplete copy was left behind')
  trace('installed', { commit, port, install: f.install, data: f.data })
  const launchDirectory = realpathSync.native(join(f.install, 'versions', commit)).toLowerCase()
  let initialToken
  let firstSentinel
  let savedPreference
  let memberIds
  const attempts = []
  for (let attempt = 0; attempt < 2; attempt++) {
    // Both starts use the installed entry point only: the first start must not
    // bypass Start-Loom.cmd through the repository manager.
    const child = spawn('cmd.exe', ['/d', '/c', 'Start-Loom.cmd'],
      { cwd: f.install, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
    // Do not echo Server output: it may contain a management token.
    let bytes = 0
    child.stdout.on('data', part => { bytes += part.length })
    child.stderr.on('data', part => { bytes += part.length })
    const readyStart = Date.now()
    trace('launch', { attempt: attempt + 1, entrypoint: 'Start-Loom.cmd', cwd: f.install })
    try {
      let ready = false
      while (Date.now() - readyStart < 120_000) {
        assert.equal(child.exitCode, null, 'test-owned launcher exited before the Host was ready')
        try {
          const probe = await fetch(origin + '/', { signal: AbortSignal.timeout(1_000) })
          if (probe.ok) { ready = true; break }
        } catch {}
        await delay(250)
      }
      assert.equal(ready, true, 'installed Server did not become healthy within 120 s')
      const readyMs = Date.now() - readyStart
      trace('healthy', { attempt: attempt + 1, readyMs })
      const html = await fetch(origin + '/')
      const httpStatus = html.status
      assert.equal(httpStatus, 200)
      assert.match(await html.text(), /<html/i)
      const listener = listenerFor(port)
      assert.ok(listener.programPath.toLowerCase().startsWith(launchDirectory + '\\'),
        'the listener on the isolated port is not the installed version: ' + listener.programPath)
      const administratorToken = readFileSync(join(f.data, 'server-token'), 'utf8').trim()
      const login = await fetch(origin + '/api/v1/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 5, administratorToken }),
      })
      assert.equal(login.status, 200, 'the installed Core must accept its own management identity')
      const session = await login.json()
      const request = async (operation, params = {}) => {
        const response = await fetch(origin + '/api/v1/request', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
          body: JSON.stringify({ operation, params }),
        })
        assert.equal(response.status, 200, operation)
        const value = await response.json()
        assert.equal(value.error, null, operation)
        return value.result
      }
      assert.equal(typeof (await request('app.info')).name, 'string')
      const ids = (await request('members.list')).map(member => member.agentId).sort()
      assert.ok(ids.length > 0, 'the real Core must provide assistants')
      const preferences = await request('preferences.newConversation.get')
      if (attempt === 0) {
        memberIds = ids
        savedPreference = { memberAgentIds: [ids[0]], defaultLeadAgentId: ids[0] }
        const saved = await request('preferences.newConversation.setDefaults', { defaults: savedPreference, enableOneClick: true })
        assert.equal(saved.oneClickNewConversationEnabled, true)
        assert.deepEqual(saved.newConversationDefaults, savedPreference)
      } else {
        assert.deepEqual(ids, memberIds)
        assert.equal(preferences.oneClickNewConversationEnabled, true)
        assert.deepEqual(preferences.newConversationDefaults, savedPreference)
      }
      // The database the running Host reports must be this isolated one, at
      // projection schema 186 with migration 236 already applied.
      const hostSchema = await verifyRunningHostSchema({
        request, databasePath: join(f.data, 'rovai.sqlite')
      })
      assert.equal(state(f.install).current, commit)
      assert.equal(state(f.install).lastStarted, commit)
      const files = readdirSync(f.data)
      assert.ok(files.includes('rovai.sqlite'))
      const tokenFile = files.find(name => /token/.test(name))
      assert.ok(tokenFile, 'Server must persist its management identity')
      const tokenFingerprint = hash(readFileSync(join(f.data, tokenFile)))
      if (attempt === 0) {
        initialToken = tokenFingerprint
        writeFileSync(join(f.data, 'installer-restart-sentinel'), randomUUID())
        firstSentinel = readFileSync(join(f.data, 'installer-restart-sentinel'), 'utf8')
        const locked = run('Rollback', f.install, [], { env })
        assert.notEqual(locked.status, 0, 'active launcher must fence version switches')
      } else {
        assert.equal(tokenFingerprint, initialToken)
        assert.equal(readFileSync(join(f.data, 'installer-restart-sentinel'), 'utf8'), firstSentinel)
      }
      assert.ok(bytes > 0)
      attempts.push({ attempt: attempt + 1, entrypoint: 'Start-Loom.cmd', readyMs, httpStatus,
        loginStatus: login.status, listener, hostSchema })
      trace('attempt-verified', { attempt: attempt + 1, httpStatus, loginStatus: login.status,
        projectionSchema: hostSchema.projectionSchema, latestMigrationVersion: hostSchema.latestMigrationVersion })
    } finally { await stopOwnedTree(child) }
  }
  trace('passed', { attempts: attempts.length, commit })
  if (process.env.LOOM_INSTALL_TEST_REPORT) {
    writeFileSync(process.env.LOOM_INSTALL_TEST_REPORT, JSON.stringify({
      status: 'passed', commit, install: f.install, data: f.data, port,
      installerSha256: managerDigest, candidateManifestManagerSha256: manifest.files['Manage-Loom.ps1'],
      installedManagerSha256: installedManagerDigest, packagedManagerSha256: packagedManagerDigest,
      installedManagerMatchesCandidate: installedManagerDigest === manifest.files['Manage-Loom.ps1'],
      starts: 2, entrypoint: 'Start-Loom.cmd', attempts,
      timeline: installed.timeline, productionWebServed: true, sameManagementIdentity: true,
      persistedDataPreserved: true, persistedPreferencePreserved: true,
      stableAssistantIdentities: true, realCoreAuthenticated: true,
      hostSchemaVerified: true, versionSwitchWhileRunningRejected: true,
      shutdown: 'forced stop of exact test-owned process tree; startup recovery exercised',
      entrypoints: ['Start-Loom.cmd', 'Start-Loom.cmd'], modelRuns: 0,
    }, null, 2))
  }
})
