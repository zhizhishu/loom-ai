import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

test('Runtime selectors preserve defaults and support native search, keyboard, IME and async catalog updates', { timeout: 180000 }, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const root = resolve(import.meta.dirname, '../..'), source = join(root, 'scripts/fixtures/runtime-model-picker')
  const temporaryRoot = await realpath(tmpdir())
  const fixture = process.env.ROVAI_RUNTIME_PICKER_FIXTURE
    ? await realpath(process.env.ROVAI_RUNTIME_PICKER_FIXTURE)
    : await mkdtemp(join(temporaryRoot, 'rovai-runtime-picker-'))
  assert.equal(dirname(fixture), temporaryRoot)
  assert(basename(fixture).startsWith('rovai-runtime-picker-'))
  let child, closed
  try {
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()], resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } }, build: { outDir: join(fixture, 'renderer'), minify: false } })
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }; delete env.ELECTRON_RUN_AS_NODE
    process.stdout.write(`Isolated Runtime picker userData: ${join(fixture, 'user-data')} (no Core/Skill Library/Runtime)\n`)
    child = spawn(electron, [join(source, 'main.cjs'), join(fixture, 'renderer/index.html'), join(fixture, 'user-data'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close'); let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 160000)
    let code; try { [code] = await closed } finally { clearTimeout(timer) }
    assert.equal(code, 0, output)
    assert.equal(JSON.parse(output.split('\n').find(line => line.startsWith('{'))).ok, true)
    process.stdout.write(output.split('\n').filter(line => line.startsWith('{')).join('\n') + '\n')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    if (process.env.ROVAI_KEEP_RUNTIME_PICKER_FIXTURE === '1') process.stdout.write(`Runtime picker fixture: ${fixture}\n`)
    else {
      const target = await realpath(fixture)
      assert.equal(dirname(target), temporaryRoot); assert(basename(target).startsWith('rovai-runtime-picker-'))
      await rm(target, { recursive: true, force: true })
    }
  }
})
