import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

test('Pi fixture semantic pick targets match real ChoiceMenu portals and controlled values', { timeout: 90_000 }, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const root = resolve(import.meta.dirname, '../..')
  const source = join(root, 'scripts/fixtures/loom-choice-pick')
  const base = join(root, '_artifacts/delivery-20261117/resume-05/choice-pick-ui')
  await mkdir(base, { recursive: true })
  const fixture = await mkdtemp(join(base, 'run-')), userData = join(fixture, 'user-data')
  let child, closed, passed = false
  try {
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      build: { outDir: join(fixture, 'renderer'), minify: false } })
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron, [join(source, 'main.cjs'), join(fixture, 'renderer/index.html'), userData,
      join(fixture, 'report.json'), join(root, 'scripts/lib/loom-owned-page.mjs'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: ['ignore','pipe','pipe'] })
    closed = once(child, 'close')
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 45_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timer) }
    await writeFile(join(fixture, 'process.log'), stdout + '\n' + stderr)
    assert.equal(code, 0, stdout + '\n' + stderr)
    const report = JSON.parse(await readFile(join(fixture, 'report.json'), 'utf8'))
    assert.equal(code, 0, JSON.stringify(report) + '\n' + stdout + '\n' + stderr)
    assert.equal(report.ok, true)
    assert.equal(report.realCore, false); assert.equal(report.realModel, false); assert.equal(report.realBrowserDoor, false)
    assert.equal(report.visibleWindow, false); assert.equal(report.cases.length, 2)
    console.log(JSON.stringify({ fixture, ...report }))
    passed = true
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await closed }
    if (passed) await rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

