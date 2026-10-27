import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

test('production automation splitter preserves drafts and fences delayed saves through native input', { timeout: 60_000 }, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const root = resolve(import.meta.dirname, '../..')
  const source = join(root, 'scripts/fixtures/automation-workspace')
  const fixture = await mkdtemp(join(tmpdir(), 'rovai-automation-splitter-'))
  const userData = join(fixture, 'user-data')
  let child, closed, passed = false
  try {
    await mkdir(join(userData, 'managed-skill-library'), { recursive: true })
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      build: { outDir: join(fixture, 'renderer'), minify: false } })
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    process.stdout.write(`Isolated automation userData: ${userData}; Skill Library: ${join(userData, 'managed-skill-library')} (no Core/Runtime)\n`)
    child = spawn(electron, [join(source, 'splitter-main.cjs'), join(fixture, 'renderer/index.html'), userData,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timer) }
    assert.equal(code, 0, output)
    assert.equal(JSON.parse(output.split('\n').find(line => line.startsWith('{'))).ok, true)
    passed = true
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    if (!passed || process.env.ROVAI_KEEP_AUTOMATION_SPLITTER_FIXTURE === '1') {
      process.stdout.write(`Automation splitter fixture: ${fixture}\n`)
    } else await rm(fixture, { recursive: true, force: true })
  }
})
