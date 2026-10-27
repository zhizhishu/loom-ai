import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { evaluationBuildPath } from './eval-host-build-path.mjs'
import { runCaptured } from './qualification-common.mjs'

test('GUI PATH locates Cargo and lets the Host launch its build command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rovai-eval-cargo-'))
  try {
    const cargo = join(directory, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
    if (process.platform === 'win32') await copyFile(process.execPath, cargo)
    else {
      await writeFile(cargo, '#!/bin/sh\nprintf "fixture cargo %s\\n" "$1"\n')
      await chmod(cargo, 0o700)
    }
    const systemPath = join(directory, 'missing')
    const resolved = await evaluationBuildPath(systemPath, [directory])
    assert.equal(resolved, `${directory}${delimiter}${dirname(process.execPath)}${delimiter}${systemPath}`)
    const result = await runCaptured('cargo', ['--version'], { env: { ...process.env, PATH: resolved } })
    assert.equal(result.code, 0)
    assert.equal(result.stdout.trim(), process.platform === 'win32' ? process.version : 'fixture cargo --version')
    const node = await runCaptured(process.platform === 'win32' ? 'node.exe' : 'node', ['--version'], { env: { ...process.env, PATH: resolved } })
    assert.equal(node.code, 0)
    assert.equal(node.stdout.trim(), process.version)
    assert.equal(await evaluationBuildPath(resolved, []), resolved)
    await assert.rejects(evaluationBuildPath(systemPath, []), /Cargo executable is unavailable/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
