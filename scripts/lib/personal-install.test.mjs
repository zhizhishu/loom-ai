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

const windows = process.platform === 'win32'
const manager = fileURLToPath(new URL('../manage-loom-personal.ps1', import.meta.url))
const required = ['rovai-server.exe', 'rovai-host.exe', 'rovai-core.exe', 'rovai.exe', 'loom-node.exe', 'web-ui/index.html', 'Start-Loom.cmd', 'LICENSE']
const hash = value => createHash('sha256').update(value).digest('hex')

function fixture(t, chosenRoot) {
  const createdRoot = chosenRoot ? resolve(chosenRoot) : mkdtempSync(join(tmpdir(), 'loom-personal-install-'))
  if (chosenRoot) mkdirSync(createdRoot)
  // Windows CI can expose TEMP through an 8.3 alias (RUNNER~1). Match the
  // installer's canonical parent before comparing the chosen data directory.
  const root = realpathSync(createdRoot)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, install: join(root, 'LOOM programs'), data: join(root, 'personal data') }
}

function makePackage(root, letter, contract = { version: 'v1.72', projectionSchema: 184 }) {
  const directory = join(root, 'package-' + letter)
  mkdirSync(directory)
  const files = {}
  const longPath = 'runtime/pi/' + Array.from({ length: 4 }, (_, i) => 'dependency-' + i + '-'.repeat(48)).join('/') + '/index.js'
  for (const path of [...required, 'runtime/pi/.runtime-marker', longPath]) {
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

function run(action, install, extra = []) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', manager,
    '-Action', action, '-InstallDirectory', install, ...extra],
  { encoding: 'utf8', timeout: 240_000, windowsHide: true })
}

function installPackage(pkg, fixture_) {
  const result = run('Install', fixture_.install, ['-PackageDirectory', pkg, '-DataDirectory', fixture_.data])
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function state(install) { return JSON.parse(readFileSync(join(install, 'installation.json'), 'utf8')) }
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

test('installed real candidate starts, persists its data and restarts at the same address', {
  skip: !windows || !process.env.LOOM_INSTALL_TEST_KIT, timeout: 300_000,
}, async t => {
  const f = fixture(t, process.env.LOOM_INSTALL_TEST_ROOT)
  const pkg = resolve(process.env.LOOM_INSTALL_TEST_KIT)
  const port = process.env.LOOM_INSTALL_TEST_PORT ? Number(process.env.LOOM_INSTALL_TEST_PORT) : await freePort()
  assert.notEqual(port, 64851)
  const installed = run('Install', f.install, ['-PackageDirectory', pkg, '-DataDirectory', f.data, '-Port', String(port)])
  assert.equal(installed.status, 0, installed.stderr || installed.stdout)
  assert.equal(existsSync(f.data), false)
  const commits = state(f.install).current
  const managerDigest = hash(readFileSync(manager))
  assert.equal(hash(readFileSync(join(f.install, 'Manage-Loom.ps1'))), managerDigest)
  let firstDatabase
  let initialToken
  let firstPaths
  let savedPreference
  let memberIds
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = attempt === 0
      ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        join(f.install, 'Manage-Loom.ps1'), '-Action', 'Start', '-InstallDirectory', f.install],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : spawn('cmd.exe', ['/d', '/c', 'Start-Loom.cmd'],
        { cwd: f.install, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    // Do not echo Server output: a terminal may contain a management token.
    let bytes = 0
    child.stdout.on('data', part => { bytes += part.length })
    child.stderr.on('data', part => { bytes += part.length })
    try {
      let healthy = false
      for (let i = 0; i < 200; i++) {
        assert.equal(child.exitCode, null, 'test-owned Server exited before health was ready')
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1_000) })
          healthy = response.ok
          if (healthy) break
        } catch {}
        await delay(250)
      }
      assert.equal(healthy, true, 'installed Server did not become healthy')
      const html = await fetch('http://127.0.0.1:' + port + '/')
      assert.equal(html.status, 200)
      assert.match(await html.text(), /<html/i)
      const administratorToken = readFileSync(join(f.data, 'server-token'), 'utf8').trim()
      const login = await fetch('http://127.0.0.1:' + port + '/api/v1/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 5, administratorToken }),
      })
      assert.equal(login.status, 200, 'the installed Core must accept its own management identity')
      const session = await login.json()
      const request = async (operation, params = {}) => {
        const response = await fetch('http://127.0.0.1:' + port + '/api/v1/request', {
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
      assert.equal(state(f.install).current, commits)
      assert.equal(state(f.install).lastStarted, commits)
      const files = readdirSync(f.data)
      assert.ok(files.includes('rovai.sqlite'))
      const tokenFile = files.find(name => /token/.test(name))
      assert.ok(tokenFile, 'Server must persist its management identity')
      const tokenFingerprint = hash(readFileSync(join(f.data, tokenFile)))
      if (attempt === 0) {
        initialToken = tokenFingerprint
        firstPaths = { install: f.install, data: f.data, port, commit: commits }
        writeFileSync(join(f.data, 'installer-restart-sentinel'), randomUUID())
        firstDatabase = readFileSync(join(f.data, 'installer-restart-sentinel'), 'utf8')
        const locked = run('Rollback', f.install)
        assert.notEqual(locked.status, 0, 'active launcher must fence version switches')
      } else {
        assert.equal(tokenFingerprint, initialToken)
        assert.equal(readFileSync(join(f.data, 'installer-restart-sentinel'), 'utf8'), firstDatabase)
      }
      assert.ok(bytes > 0)
    } finally { await stopOwnedTree(child) }
  }
  if (process.env.LOOM_INSTALL_TEST_REPORT) {
    writeFileSync(process.env.LOOM_INSTALL_TEST_REPORT, JSON.stringify({
      status: 'passed', ...firstPaths, installerSha256: managerDigest, starts: 2, productionWebServed: true,
      sameManagementIdentity: true, persistedDataPreserved: true, persistedPreferencePreserved: true,
      stableAssistantIdentities: true, realCoreAuthenticated: true, versionSwitchWhileRunningRejected: true,
      shutdown: 'forced stop of exact test-owned process tree; startup recovery exercised',
      entrypoints: ['PowerShell manager', 'Start-Loom.cmd'], modelRuns: 0,
    }, null, 2))
  }
})
