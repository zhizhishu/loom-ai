import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

const root = resolve(import.meta.dirname, '../..')
const source = join(root, 'scripts/fixtures/notification-attention')

test('exit reminders acknowledge displayed Threads without querying on execution progress', { timeout: 45_000 }, async (t) => {
  if (!admitElectronIntegrationTest(t)) return
  const fixture = await mkdtemp(join(tmpdir(), 'rovai-interruption-attention-test-'))
  let child
  let closed
  try {
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      build: { outDir: join(fixture, 'renderer'), minify: false, rollupOptions: { input: join(source, 'interruption.html') } } })
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    process.stdout.write(`Isolated interruption userData: ${join(fixture, 'user-data')}; Skill Library: ${join(fixture, 'user-data/managed-skill-library')} (no Core/Runtime)\n`)
    child = spawn(electron, [join(source, 'main-interruption.cjs'), join(fixture, 'renderer/interruption.html'), join(fixture, 'user-data'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 35_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timeout) }
    assert.equal(code, 0, `Interruption attention regression failed:\n${output}`)
    assert.equal(JSON.parse(output.split('\n').find(line => line.startsWith('{'))).ok, true)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    await rm(fixture, { recursive: true, force: true })
  }
})

test('notification cards preserve source identity, quiet current Camps, queues and paused lifetime', { timeout: 90_000 }, async (t) => {
  if (!admitElectronIntegrationTest(t)) return
  const fixture = await mkdtemp(join(tmpdir(), 'rovai-notification-attention-test-'))
  let child
  let closed
  try {
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      build: { outDir: join(fixture, 'renderer'), minify: false } })
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    process.stdout.write(`Isolated notification userData: ${join(fixture, 'user-data')} (no Core/Runtime)\n`)
    child = spawn(electron, [join(source, 'main.cjs'), join(fixture, 'renderer/index.html'), join(fixture, 'user-data'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 75_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timeout) }
    assert.equal(code, 0, `Notification interaction regression failed:\n${output}`)
    assert.equal(JSON.parse(output.split('\n').find(line => line.startsWith('{'))).ok, true)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    if (process.env.ROVAI_KEEP_NOTIFICATION_FIXTURE === '1') process.stdout.write(`Notification screenshots: ${fixture}\n`)
    else await rm(fixture, { recursive: true, force: true })
  }
})

test('AgentRun notifications observe and focus the right-side execution Portal', { timeout: 90_000 }, async (t) => {
  if (!admitElectronIntegrationTest(t)) return
  const source = join(root, 'scripts/fixtures/execution-avatar-rail')
  const fixture = await mkdtemp(join(tmpdir(), 'rovai-notification-agent-run-test-'))
  let child
  let closed
  try {
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      build: { outDir: join(fixture, 'renderer'), minify: false } })
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete environment.ELECTRON_RUN_AS_NODE
    process.stdout.write(`Isolated notification AgentRun userData: ${join(fixture, 'user-data')} (no Core/Runtime)\n`)
    child = spawn(electron, [join(source, 'main-notification.cjs'), join(fixture, 'renderer/index.html'), join(fixture, 'user-data'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 75_000)
    let code
    try { [code] = await closed } finally { clearTimeout(timeout) }
    assert.equal(code, 0, `Notification AgentRun regression failed:\n${output}`)
    assert.equal(JSON.parse(output.split('\n').find(line => line.startsWith('{'))).ok, true)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    if (process.env.ROVAI_KEEP_NOTIFICATION_FIXTURE === '1') process.stdout.write(`Notification AgentRun fixture: ${fixture}\n`)
    else await rm(fixture, { recursive: true, force: true })
  }
})
