import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

const EXPECTED_CASES = 19

test('production LOOM workspace keeps visited sections mounted and reports honest states', { timeout: 150_000 }, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const root = resolve(import.meta.dirname, '../..')
  const source = join(root, 'scripts/fixtures/loom-workspace')
  const fixture = await mkdtemp(join(tmpdir(), 'rovai-loom-workspace-test-'))
  const userData = join(fixture, 'user-data')
  const screenshots = join(fixture, 'screenshots')
  let child
  let closed
  let passed = false
  try {
    await mkdir(join(userData, 'managed-skill-library'), { recursive: true })
    await build({
      configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      build: { outDir: join(fixture, 'renderer'), minify: false }
    })
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    process.stdout.write(`LOOM workspace acceptance userData: ${userData}; screenshots: ${screenshots}; no Core/SQLite/Skill Library/Runtime\n`)
    child = spawn(electron, [
      join(source, 'main.cjs'), join(fixture, 'renderer/index.html'), userData, screenshots,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timeout) }
    assert.equal(code, 0, `LOOM workspace integration failed:\n${stdout}\n${stderr}`)

    const report = JSON.parse(stdout.split('\n').find(line => line.startsWith('{')))
    assert.equal(report.ok, true)
    assert.equal(report.cases.length, EXPECTED_CASES, `Unexpected LOOM acceptance cases: ${JSON.stringify(report.cases)}`)
    assert.equal(report.counts.activity, 1, `LOOM repeated the activity read: ${JSON.stringify(report.counts)}`)
    assert.equal(report.counts.delivery, 1, `LOOM repeated the delivery read: ${JSON.stringify(report.counts)}`)
    assert.equal(report.counts.changes, 0, `LOOM read workspace changes without user intent: ${JSON.stringify(report.counts)}`)
    assert.ok(report.counts.tasks >= 1, `LOOM never read the task capability snapshot: ${JSON.stringify(report.counts)}`)
    for (const size of ['1440x920', '1040x700']) {
      for (const theme of ['day', 'night']) {
        const sectionShots = report.shots.filter(shot => shot.zoom === 100 && shot.size === size && shot.theme === theme)
        assert.deepEqual(sectionShots.map(shot => shot.section).sort(), ['activity', 'delivery', 'plan'],
          `Missing LOOM section screenshots for ${theme} ${size}: ${JSON.stringify(report.shots)}`)
      }
    }
    const zoomShots = report.shots.filter(shot => shot.zoom === 200)
    assert.deepEqual(zoomShots.map(shot => shot.theme).sort(), ['day', 'night'], 'Missing 200% zoom screenshots')
    for (const shot of report.shots) {
      assert.equal(shot.path.startsWith(screenshots + '/') || shot.path.startsWith(screenshots + '\\'), true,
        `Screenshot escaped this fixture output directory: ${shot.path}`)
      const info = await stat(shot.path)
      assert(info.size > 4000, `${shot.path} is not a real screenshot (${info.size} bytes)`)
      const signature = (await readFile(shot.path)).subarray(1, 4).toString('latin1')
      assert.equal(signature, 'PNG', `${shot.path} is not a PNG image`)
    }
    process.stdout.write(`${JSON.stringify({ shots: report.shots.map(shot => shot.path), counts: report.counts })}\n`)
    passed = true
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await closed
    }
    if (!passed || process.env.ROVAI_KEEP_LOOM_WORKSPACE_FIXTURE === '1') {
      process.stdout.write(`LOOM workspace fixture: ${fixture}\n`)
    } else {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})
