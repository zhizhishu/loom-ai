import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

test('LOOM runtime connection settings retain real editor behavior and fit both themes', { timeout: 120_000 }, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const root = resolve(import.meta.dirname, '../..')
  const source = join(root, 'scripts/fixtures/loom-runtime-settings')
  const base = join(root, '_artifacts/delivery-20261117/resume-05/runtime-settings-ui')
  await mkdir(base, { recursive: true })
  const fixture = await mkdtemp(join(base, 'run-'))
  const userData = join(fixture, 'user-data'), output = join(fixture, 'screenshots')
  let child, closed, passed = false
  try {
    await mkdir(join(userData, 'managed-skill-library'), { recursive: true })
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      build: { outDir: join(fixture, 'renderer'), minify: false } })
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron, [join(source, 'main.cjs'), join(fixture, 'renderer/index.html'), userData, output,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 90_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timer) }
    assert.equal(code, 0, stdout + '\n' + stderr)
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    assert.equal(report.ok, true)
    assert.equal(report.realCore, false)
    assert.equal(report.visibleWindow, false)
    assert.equal(report.shots.length, 4)
    assert.ok(report.cases.includes('four production runtime cards open their own saved settings'))
    assert.ok(report.cases.includes('ordinary fields save through runtime.startup.save and reopen without editing JSON'))
    assert.ok(report.cases.includes('values are hidden by default and revealing them neither saves nor dirties settings'))
    assert.ok(report.cases.includes('duplicate and incomplete field names cannot save or discard a draft value; removing a new row restores the saved state'))
    assert.ok(report.cases.includes('cancel leaving preserves unsaved JSON without a write'))
    console.log(JSON.stringify({ output, ...report }))
    passed = true
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await closed }
    if (passed) await rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    console.log('Isolated runtime-settings evidence: ' + fixture)
  }
})
