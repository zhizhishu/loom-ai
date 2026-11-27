import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
