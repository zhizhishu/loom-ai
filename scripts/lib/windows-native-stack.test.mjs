import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Exercise the real Cargo build scripts without compiling the application.
// The Windows E3 workflow additionally checks each emitted executable's PE
// stack reserve, then starts a fresh protected authority with that exact file.
test('native main-stack budget is emitted for Windows MSVC and GNU application binaries', { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'loom-native-stack-'))
  try {
    for (const crate of ['rovai-host', 'rovai-core']) {
      const executable = join(temporary, `${crate}${process.platform === 'win32' ? '.exe' : ''}`)
      execFileSync('rustc', ['--edition=2024', resolve('crates', crate, 'build.rs'), '-o', executable], { timeout: 30000, stdio: 'pipe' })
      for (const [os, environment, expected] of [
        ['windows', 'msvc', 'cargo:rustc-link-arg-bins=/STACK:8388608'],
        ['windows', 'gnu', 'cargo:rustc-link-arg-bins=-Wl,--stack,8388608'],
        ['linux', 'gnu', null], ['macos', '', null]
      ]) {
        const output = execFileSync(executable, [], { encoding: 'utf8', timeout: 5000, env: { ...process.env, CARGO_CFG_TARGET_OS: os, CARGO_CFG_TARGET_ENV: environment } })
        assert.match(output, /cargo:rerun-if-changed=build\.rs/)
        const linkerArguments = output.split(/\r?\n/u).filter(line => line.startsWith('cargo:rustc-link-arg'))
        assert.deepEqual(linkerArguments, expected ? [expected] : [], `${crate}: ${os}/${environment}`)
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
