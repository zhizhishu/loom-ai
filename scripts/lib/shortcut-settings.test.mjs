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

test('production shortcut settings record, persist and trigger across platforms and reading surfaces', { timeout: 180_000 }, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const root = resolve(import.meta.dirname, '../..'), source = join(root, 'scripts/fixtures/shortcut-settings')
  const temporaryRoot = await realpath(tmpdir()), fixture = await mkdtemp(join(temporaryRoot, 'rovai-shortcut-settings-'))
  let child, closed
  try {
    const resolveOptions = { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } }
    await build({ configFile: false, root: source, base: './', logLevel: 'error', plugins: [react()], resolve: resolveOptions, build: { outDir: join(fixture, 'renderer'), minify: false } })
    await build({ configFile: false, root: source, logLevel: 'error', resolve: resolveOptions, ssr: { noExternal: ['parse5', 'entities'] }, build: { ssr: join(source, 'native.ts'), outDir: join(fixture, 'native'), minify: false, rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'native.cjs' } } } })
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }; delete env.ELECTRON_RUN_AS_NODE
    process.stdout.write(`Shortcut fixture: ${fixture}; isolated userData and Skill Library, no Core/Runtime\n`)
    child = spawn(electron, [join(source, 'main.cjs'), join(fixture, 'renderer/index.html'), join(fixture, 'user-data'), join(fixture, 'native/native.cjs'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = once(child, 'close'); let output = ''
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) }); child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    let code; try { [code] = await closed } finally { clearTimeout(timer) }
    assert.equal(code, 0, output)
    assert.equal(JSON.parse(output.split('\n').find(line => line.startsWith('{'))).ok, true)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    if (process.env.ROVAI_KEEP_SHORTCUT_FIXTURE === '1') process.stdout.write(`Shortcut screenshots: ${fixture}\n`)
    else {
      const path = await realpath(fixture); assert.equal(dirname(path), temporaryRoot); assert(basename(path).startsWith('rovai-shortcut-settings-'))
      await rm(path, { recursive: true, force: true })
    }
  }
})
