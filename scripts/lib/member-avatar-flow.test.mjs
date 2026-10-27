import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'
import { removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'

const root = resolve(import.meta.dirname, '../..')
const source = join(root, 'scripts/fixtures/member-avatar-flow')
test('GIF avatar survives upload, crop, reopen and reload through the real Core', { timeout: 180_000 }, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const binary = resolve(process.env.ROVAI_CORE_BINARY ?? join(root, 'target/debug', process.platform === 'win32' ? 'rovai-core.exe' : 'rovai-core'))
  await access(binary)
  const suppliedFixture = process.env.ROVAI_MEMBER_AVATAR_FIXTURE_ROOT
  const fixture = await realpath(suppliedFixture ?? await mkdtemp(join(tmpdir(), 'rovai-member-avatar-flow-')))
  const userData = join(fixture, 'user-data')
  let child, closed, passed = false
  try {
    await writeFile(join(fixture, 'wide.gif'), wideGif())
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } }, build: { outDir: join(fixture, 'renderer'), minify: false } })
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    console.log(`Automatic acceptance userData: ${userData}; Skill Library: ${join(userData, 'core/skills')}; MCP: ${join(userData, 'core/mcp.json')}`)
    child = spawn(electron, [join(source, 'main.cjs'), join(fixture, 'renderer/index.html'), userData, binary, join(fixture, 'wide.gif'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timer) }
    assert.equal(code, 0, output)
    const reports = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    assert.equal(reports.length, 1, output)
    assert.equal(reports[0].ok, true, output)
    assert.equal(reports[0].cases.length, 6, output)
    console.log(JSON.stringify(reports[0]))
    passed = true
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    if (suppliedFixture !== undefined || !passed || process.env.ROVAI_KEEP_MEMBER_AVATAR_FIXTURE === '1') console.log(`Member avatar fixture: ${fixture}`)
    else {
      await removeEphemeralRuntimeCampFilesRoot(join(userData, 'core'))
      await rm(fixture, { recursive: true, force: true })
    }
  }
})

// Two full frames with a deliberately very wide canvas. Clearing the LZW table
// before each pixel keeps this small fixture encoder independent of production.
function wideGif() {
  const width = 768, height = 256
  const word = value => [value & 255, value >>> 8]
  const parts = [Buffer.from([...Buffer.from('GIF89a'), ...word(width), ...word(height), 0x81, 0, 0,
    255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0,
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0])]
  for (const color of [0, 1]) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 8, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...word(width), ...word(height), 0, 2]))
    const data = [], emit = code => { bits |= code << count; count += 3; while (count >= 8) { data.push(bits & 255); bits >>>= 8; count -= 8 } }
    let bits = 0, count = 0
    for (let i = 0; i < width * height; i++) { emit(4); emit(color) }
    emit(5)
    if (count) data.push(bits & 255)
    for (let offset = 0; offset < data.length; offset += 255) {
      const block = data.slice(offset, offset + 255)
      parts.push(Buffer.from([block.length, ...block]))
    }
    parts.push(Buffer.from([0]))
  }
  return Buffer.concat([...parts, Buffer.from([0x3b])])
}
