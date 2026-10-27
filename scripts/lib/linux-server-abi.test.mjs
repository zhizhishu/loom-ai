import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectElfOutput } from './linux-server-abi.mjs'

test('Linux release ABI uses imported symbol versions and rejects incompatible ELF requirements', () => {
  const elf = {
    header: 'Class: ELF64\nMachine: Advanced Micro Devices X86-64',
    symbols: '1: 0 0 FUNC GLOBAL DEFAULT UND memcpy@GLIBC_2.14 (3)\n2: 0 0 FUNC GLOBAL DEFAULT UND __libc_start_main@GLIBC_2.34 (2)\n3: 0 0 FUNC GLOBAL DEFAULT 12 example@@GLIBC_2.99',
    dynamic: '0x1 (NEEDED) Shared library: [libc.so.6]',
    programHeaders: '[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]'
  }
  assert.deepEqual(inspectElfOutput(elf), {
    requiredSymbolVersions: { GLIBC: '2.34', GLIBCXX: null, CXXABI: null },
    neededLibraries: ['libc.so.6'], interpreter: '/lib64/ld-linux-x86-64.so.2'
  })
  for (const version of ['2.35', '2.9', '2.2.5']) {
    assert.doesNotThrow(() => inspectElfOutput({ ...elf, symbols: `1: 0 0 FUNC GLOBAL DEFAULT UND f@GLIBC_${version}` }))
  }
  for (const version of ['2.36', '2.39', '2.100', 'PRIVATE']) {
    assert.throws(() => inspectElfOutput({ ...elf, symbols: `1: 0 0 FUNC GLOBAL DEFAULT UND f@GLIBC_${version}` }))
  }
  assert.throws(() => inspectElfOutput({ ...elf, header: 'Class: ELF64\nMachine: AArch64' }), /non-x86_64/)
  assert.throws(() => inspectElfOutput({ ...elf, programHeaders: '[Requesting program interpreter: /lib/ld-musl-x86_64.so.1]' }), /interpreter/)
})
