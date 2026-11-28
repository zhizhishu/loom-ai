import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repository = resolve(import.meta.dirname, '../..')
const read = path => readFileSync(join(repository, path), 'utf8')

test('linux personal workflow ships one linux x64 artifact and verifies the delivered archive', () => {
  const workflow = read('.github/workflows/loom-v2-e3-linux.yml')
  assert.match(workflow, /node scripts\/build-server\.mjs --target-key linux-x64 --debug/)
  assert.match(workflow, /scripts\/runtime\/pi-source\/package\.json scripts\/runtime\/pi-source\/package-lock\.json/)
  assert.match(workflow, /package-computer-runtime-linux\.mjs/)
  assert.match(workflow, /package-linux-personal\.mjs/)
  assert.match(workflow, /loom-personal-preview-linux-\$\{\{ env\.LOOM_SOURCE_COMMIT \}\}/)
  assert.match(workflow, /cmp out\/linux-personal\/loom-personal-linux-x64\.tar\.gz out\/linux-personal-download\/loom-personal-linux-x64\.tar\.gz/)
  assert.match(workflow, /repository: ZiChuanLan\/pi-purge/)
  assert.match(workflow, /ref: d0196ccfd773b0ed342bd2f25372aff65f1a4a53/)
  assert.match(workflow, /983a3c3cc3011928a33805d84414060729fd2aa81822bc7ba94008943a65d71d/)
  assert.match(workflow, /--pi-purge-file _artifacts\/reference-repos\/pi-purge-current\/extensions\/pi-purge\.ts/)
  assert.match(workflow, /LOOM_COMPUTER_AGENT_PI_MCP='1'/)
})

test('linux personal launcher starts server with isolated runtime and five computer defaults', () => {
  const manager = read('scripts/manage-loom-personal.sh')
  for (const snippet of [
    'ROVAI_EMBEDDED_PI_ROOT="$root/runtime/pi"',
    'LOOM_COMPUTER_PYTHON="$computer/python"',
    'LOOM_COMPUTER_HELPER="$computer/host_desktop.py"',
    'LOOM_COMPUTER_AGENT_PYTHON="$computer/python"',
    'LOOM_COMPUTER_AGENT_BRIDGE="$computer/mcp_bridge.py"',
    "LOOM_COMPUTER_AGENT_PI_MCP='1'",
    '--data-dir "$data" --listen "127.0.0.1:$listen_port"'
  ]) assert.ok(manager.includes(snippet), snippet)
  assert.doesNotMatch(manager, /migration|Purge/i)
  for (const script of ['scripts/manage-loom-personal.sh', 'scripts/start-loom-personal.sh', 'scripts/install-loom-personal.sh']) {
    const result = spawnSync('sh', ['-n', join(repository, script)], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})

test('linux computer runtime packages helper bridge and pinned Pillow wheel selection', () => {
  const packager = read('scripts/package-computer-runtime-linux.mjs')
  assert.match(packager, /LINUX_PILLOW_VERSION = '12\.3\.0'/)
  assert.match(packager, /host_desktop\.py/)
  assert.match(packager, /mcp_bridge\.py/)
  assert.match(packager, /manylinux_2_28_x86_64/)
  assert.match(packager, /pillow==\$\{LINUX_PILLOW_VERSION\}/)
})

test('linux package manifest requires web frontend, Pi and computer runtime', () => {
  const packager = read('scripts/package-linux-personal.mjs')
  for (const snippet of ['web-ui/index.html', 'runtime/pi/pi-bundle.json', 'runtime/computer/computer-bundle.json', "target: 'linux-x64'", 'runtime/extensions/pi-purge/upstream/extensions/pi-purge.ts', 'runtime/office/linux-x64/office-bundle.json', 'runtime/office/linux-x64/libreoffice/program/soffice', 'runtime/office/linux-x64/poppler/bin/pdftoppm', '983a3c3cc3011928a33805d84414060729fd2aa81822bc7ba94008943a65d71d']) assert.ok(packager.includes(snippet), snippet)
})

// --- installation-time runtime selection (light edition) -------------------
// Every packaged runtime is still copied; --runtimes only decides the
// LOOM_ENABLED_RUNTIMES list the launcher exports at start.
const manager = join(repository, 'scripts/manage-loom-personal.sh')
const canonicalAll = ['codex-cli', 'pi', 'deepseek-harness', 'claude-code-cli']

function makeFakePackage(root, commit = 'a'.repeat(40)) {
  const dir = join(root, 'package')
  const write = (path, body, executable = false) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
    if (executable) chmodSync(join(dir, path), 0o755)
  }
  for (const name of ['rovai-server', 'rovai-host', 'rovai']) write(name, '#!/bin/sh\necho fake\n', true)
  write('web-ui/index.html', '<html></html>')
  write('skills/cli-operations/SKILL.md', '# skill')
  write('package-info', 'target=linux-x64\n')
  write('candidate-manifest.json', JSON.stringify({ target: 'linux-x64', commit }))
  write('runtime/pi/pi-bundle.json', '{}')
  write('runtime/pi/pi', '#!/bin/sh\n', true)
  write('runtime/pi/node/node', '#!/bin/sh\n', true)
  write('runtime/dsh/dsh-runtime-bundle.json', '{}')
  write('runtime/dsh/dsh', '#!/bin/sh\n', true)
  write('runtime/dsh/node/node', '#!/bin/sh\n', true)
  write('runtime/computer/computer-bundle.json', '{}')
  write('runtime/computer/python', '#!/bin/sh\n', true)
  write('runtime/computer/host_desktop.py', 'x')
  write('runtime/computer/mcp_bridge.py', 'x')
  return dir
}

// A server stand-in that reports the environment the launcher exported.
function recordEnabledRuntimes(packageDir) {
  const server = join(packageDir, 'rovai-server')
  writeFileSync(server, '#!/bin/sh\nprintf "ENABLED=%s\\n" "${LOOM_ENABLED_RUNTIMES-unset}"\n')
  chmodSync(server, 0o755)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'loom-linux-runtimes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    pkg: makeFakePackage(root),
    install: join(root, 'programs'),
    data: join(root, 'personal data'),
    savedFile: join(root, 'programs', '.loom-runtimes')
  }
}

function manage(f, args, options = {}) {
  const result = spawnSync('sh', [manager, ...args, '--install-dir', f.install], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: f.root }, ...options
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

// Same launcher, but the caller expects a refusal: the Windows manager fails
// fast on an unknown runtime, so Linux must not exit 0 here either.
function manageFails(f, args, options = {}) {
  return spawnSync('sh', [manager, ...args, '--install-dir', f.install], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: f.root }, ...options
  })
}

const savedRuntimes = f => readFileSync(f.savedFile, 'utf8').trim()

test('--runtimes accepts short names and canonical adapter ids in any order', t => {
  const f = fixture(t)
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'claude,pi'])
  // Canonical AdapterKind order, not the order the owner typed.
  assert.equal(savedRuntimes(f), 'pi,claude-code-cli')
  assert.match(manage(f, ['status']).stdout, /^runtimes=pi,claude-code-cli$/m)
  rmSync(f.install, { recursive: true, force: true })

  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'pi,dsh,deepseek-harness,pi'])
  assert.equal(savedRuntimes(f), 'pi,deepseek-harness')
  rmSync(f.install, { recursive: true, force: true })

  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes=codex-cli,claude-code-cli'])
  assert.equal(savedRuntimes(f), 'codex-cli,claude-code-cli')
  rmSync(f.install, { recursive: true, force: true })

  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'deepseek-harness'])
  assert.equal(savedRuntimes(f), 'deepseek-harness')
})

test('--runtimes is case-insensitive and accepts semicolons and spaces', t => {
  const f = fixture(t)
  // Windows splits on [,;\s]+ and lowercases every token; Linux must do the
  // same so the same command line means the same installation on both.
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'PI; Claude'])
  assert.equal(savedRuntimes(f), 'pi,claude-code-cli')
  rmSync(f.install, { recursive: true, force: true })

  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'Claude;DSH  CODEX'])
  // Still the canonical lowercase comma list, never the owner's spelling.
  assert.equal(savedRuntimes(f), 'codex-cli,deepseek-harness,claude-code-cli')
  rmSync(f.install, { recursive: true, force: true })

  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', ' DeepSeek-Harness\tPi '])
  assert.equal(savedRuntimes(f), 'pi,deepseek-harness')
})

test('a non-interactive install without --runtimes selects all four and never blocks', t => {
  const f = fixture(t)
  // stdin is not a TTY: the prompt must be skipped instead of hanging in CI.
  const result = manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data], {
    input: '', stdio: ['pipe', 'pipe', 'pipe']
  })
  assert.equal(savedRuntimes(f), canonicalAll.join(','))
  assert.match(result.stdout, new RegExp(`Enabled runtimes: ${canonicalAll.join(',')}`))
  assert.doesNotMatch(result.stdout + result.stderr, /Light edition: choose/)
  // An explicitly empty selection means "not chosen yet", exactly like an
  // omitted flag: it keeps the all-four default instead of installing nothing.
  rmSync(f.install, { recursive: true, force: true })
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', ''])
  assert.equal(savedRuntimes(f), canonicalAll.join(','))
})

test('an unknown runtime is refused instead of silently narrowing', t => {
  const f = fixture(t)
  // Windows throws "Unknown LOOM runtime: turbo"; Linux must fail the same way
  // for an explicit --runtimes instead of dropping the typo and defaulting.
  const install = manageFails(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'pi,turbo'])
  assert.notEqual(install.status, 0, 'an explicit unknown runtime must not install successfully')
  assert.match(install.stderr, /Unknown LOOM runtime: turbo/)
  // Nothing is installed, so no runtime list was recorded.
  assert.equal(existsSync(f.savedFile), false)

  // A partial selection must not be quietly widened to all four either.
  const allBogus = manageFails(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'bogus,nope'])
  assert.notEqual(allBogus.status, 0)
  assert.match(allBogus.stderr, /Unknown LOOM runtime: bogus,nope/)
  assert.equal(existsSync(f.savedFile), false)

  // The same applies to start and portable, so a restart cannot change the set.
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'pi'])
  const start = manageFails(f, ['start', '--runtimes', 'pi,turbo'])
  assert.notEqual(start.status, 0)
  assert.match(start.stderr, /Unknown LOOM runtime: turbo/)
  assert.equal(savedRuntimes(f), 'pi', 'a refused start must not rewrite the saved selection')
  const portable = manageFails(f, ['portable', '--package-dir', f.pkg, '--data-dir', join(f.root, 'portable-x'), '--runtimes', 'turbo'])
  assert.notEqual(portable.status, 0)
  assert.match(portable.stderr, /Unknown LOOM runtime: turbo/)
})

test('a saved selection with an unknown runtime fails closed, not back to all four', t => {
  const f = fixture(t)
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'pi'])
  // Simulate a damaged or hand-edited state file from another manager.
  writeFileSync(f.savedFile, 'pi,turbo\n')
  const start = manageFails(f, ['start'])
  assert.notEqual(start.status, 0, 'a corrupt saved selection must not start LOOM with a different set')
  assert.match(start.stderr, /runtime selection in .*\.loom-runtimes is not usable: turbo/)
  // status reports the damage instead of pretending the default applies.
  const status = manageFails(f, ['status'])
  assert.notEqual(status.status, 0)
  assert.match(status.stderr, /is not usable: turbo/)
  // An upgrade must not silently overwrite the damaged file with all four.
  const upgrade = manageFails(f, ['install', '--package-dir', f.pkg])
  assert.notEqual(upgrade.status, 0)
  assert.match(upgrade.stderr, /is not usable: turbo/)
  assert.equal(savedRuntimes(f), 'pi,turbo')
  // An explicit --runtimes still lets the owner repair the installation.
  manage(f, ['install', '--package-dir', f.pkg, '--runtimes', 'pi,claude'])
  assert.equal(savedRuntimes(f), 'pi,claude-code-cli')
  assert.match(manage(f, ['status']).stdout, /^runtimes=pi,claude-code-cli$/m)
})

test('an upgrade keeps the saved selection unless --runtimes overrides it', t => {
  const f = fixture(t)
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'dsh,claude'])
  assert.equal(savedRuntimes(f), 'deepseek-harness,claude-code-cli')
  manage(f, ['install', '--package-dir', f.pkg], { input: '' })
  assert.equal(savedRuntimes(f), 'deepseek-harness,claude-code-cli')
  manage(f, ['install', '--package-dir', f.pkg, '--runtimes', 'codex'])
  assert.equal(savedRuntimes(f), 'codex-cli')
  assert.match(manage(f, ['status']).stdout, /^runtimes=codex-cli$/m)
})

test('start and portable export LOOM_ENABLED_RUNTIMES from the saved selection', t => {
  const f = fixture(t)
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'pi,claude'])
  recordEnabledRuntimes(f.pkg)
  const release = join(f.install, 'versions', 'a'.repeat(40))
  chmodSync(join(release, 'rovai-server'), 0o644)
  writeFileSync(join(release, 'rovai-server'), '#!/bin/sh\nprintf "ENABLED=%s\\n" "${LOOM_ENABLED_RUNTIMES-unset}"\n')
  chmodSync(join(release, 'rovai-server'), 0o755)
  // start reuses the saved install-time choice.
  assert.match(manage(f, ['start', '--port', '64999']).stdout, /^ENABLED=pi,claude-code-cli$/m)
  // an explicit --runtimes on start replaces it and is persisted.
  assert.match(manage(f, ['start', '--runtimes', 'codex']).stdout, /^ENABLED=codex-cli$/m)
  assert.equal(savedRuntimes(f), 'codex-cli')
  // portable has no saved state: default all four unless --runtimes is given.
  assert.match(manage(f, ['portable', '--package-dir', f.pkg, '--data-dir', join(f.root, 'portable-a')]).stdout,
    /^ENABLED=codex-cli,pi,deepseek-harness,claude-code-cli$/m)
  assert.match(manage(f, ['portable', '--package-dir', f.pkg, '--data-dir', join(f.root, 'portable-b'), '--runtimes', 'pi']).stdout,
    /^ENABLED=pi$/m)
  // A typo on start/portable is refused like on install, never exported widened.
  for (const args of [['start', '--runtimes', 'pi,turbo'],
    ['portable', '--package-dir', f.pkg, '--data-dir', join(f.root, 'portable-c'), '--runtimes', 'turbo']]) {
    const refused = manageFails(f, args)
    assert.notEqual(refused.status, 0, args.join(' '))
    assert.match(refused.stderr, /Unknown LOOM runtime: turbo/, args.join(' '))
  }
  assert.equal(savedRuntimes(f), 'codex-cli')
})

test('the interactive prompt validates the typed answer like --runtimes', { skip: !existsSync('/usr/bin/script') }, t => {
  const f = fixture(t)
  // `script` hands the installer a real tty on stdin, so the first-install
  // prompt runs. The answer uses a semicolon and numeric menu indices. The
  // launcher command is single-quoted because the fixture data directory
  // contains a space that script(1) would otherwise split on.
  const quoted = value => `'${String(value).replaceAll("'", `'\\''`)}'`
  const interact = (answer, install) => spawnSync('sh', ['-c',
    `printf '%s\\n' ${quoted(answer)} | script -qec ${quoted(
      `sh ${quoted(manager)} install --package-dir ${quoted(f.pkg)} --data-dir ${quoted(f.data)} --install-dir ${quoted(install)}`)} /dev/null`],
  { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: f.root } })

  const picked = interact('2;4', join(f.root, 'prompt-picked'))
  assert.equal(picked.status, 0, picked.stderr || picked.stdout)
  assert.equal(readFileSync(join(f.root, 'prompt-picked', '.loom-runtimes'), 'utf8').trim(), 'pi,claude-code-cli')

  // Pressing Enter keeps the all-four default.
  const blank = interact('', join(f.root, 'prompt-empty'))
  assert.equal(blank.status, 0, blank.stderr || blank.stdout)
  assert.equal(readFileSync(join(f.root, 'prompt-empty', '.loom-runtimes'), 'utf8').trim(), canonicalAll.join(','))

  // An unknown typed token fails fast instead of being dropped from the answer.
  const bad = interact('2,turbo', join(f.root, 'prompt-bad'))
  assert.notEqual(bad.status, 0)
  assert.match(bad.stdout + bad.stderr, /Unknown LOOM runtime: turbo/)
  assert.equal(existsSync(join(f.root, 'prompt-bad', '.loom-runtimes')), false)
})

test('installing a runtime subset still copies the whole package', t => {
  const f = fixture(t)
  manage(f, ['install', '--package-dir', f.pkg, '--data-dir', f.data, '--runtimes', 'pi'])
  const release = join(f.install, 'versions', 'a'.repeat(40))
  // "Not selected" never means "not installed": every runtime file is copied.
  for (const path of ['runtime/pi/pi-bundle.json', 'runtime/pi/pi', 'runtime/pi/node/node',
    'runtime/computer/computer-bundle.json', 'runtime/computer/python', 'web-ui/index.html']) {
    assert.ok(existsSync(join(release, path)), path)
  }
})
