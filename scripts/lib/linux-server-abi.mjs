import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const linuxServerGlibcBaseline = '2.35'

function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  }
  return 0
}

// Only undefined dynamic symbols impose a requirement on the target machine.
// Definitions and arbitrary strings in an executable are not ABI requirements.
export function inspectElfOutput({ header, symbols, dynamic, programHeaders }) {
  if (!/Class:\s+ELF64/.test(header) || !/Machine:\s+Advanced Micro Devices X86-64/.test(header)) {
    throw new Error('Linux Server package contains a non-x86_64 ELF file')
  }
  const required = { GLIBC: [], GLIBCXX: [], CXXABI: [] }
  for (const line of symbols.split('\n').filter(line => /\bUND\b/.test(line))) {
    for (const match of line.matchAll(/@(?:@)?(GLIBCXX|GLIBC|CXXABI)_([\d.]+|PRIVATE)\b/g)) {
      if (match[2] === 'PRIVATE') throw new Error('Linux Server must not depend on private libc ABI')
      required[match[1]].push(match[2])
    }
  }
  const maximum = Object.fromEntries(Object.entries(required).map(([name, versions]) =>
    [name, versions.sort(compareVersions).at(-1) ?? null]))
  if (maximum.GLIBC && compareVersions(maximum.GLIBC, linuxServerGlibcBaseline) > 0) {
    throw new Error(`Linux Server requires GLIBC_${maximum.GLIBC}; maximum allowed is ${linuxServerGlibcBaseline}`)
  }
  const interpreter = /Requesting program interpreter:\s*([^\]]+)/.exec(programHeaders)?.[1] ?? null
  if (interpreter && interpreter !== '/lib64/ld-linux-x86-64.so.2') {
    throw new Error(`Linux Server requires an unexpected ELF interpreter: ${interpreter}`)
  }
  return {
    requiredSymbolVersions: maximum,
    neededLibraries: [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1]).sort(),
    interpreter
  }
}

export function inspectLinuxServerAbi(directory) {
  const files = {}
  function visit(path, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`, absolute = join(path, entry.name)
      if (entry.isDirectory()) visit(absolute, `${relative}/`)
      else if (entry.isFile()) {
        const fd = openSync(absolute, 'r'), magic = Buffer.alloc(4)
        try { readSync(fd, magic, 0, 4, 0) } finally { closeSync(fd) }
        if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue
        const readelf = option => execFileSync('readelf', ['--wide', option, absolute], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        files[relative] = inspectElfOutput({ header: readelf('--file-header'), symbols: readelf('--dyn-syms'), dynamic: readelf('--dynamic'), programHeaders: readelf('--program-headers') })
      } else throw new Error(`Unexpected Linux Server package member: ${relative}`)
    }
  }
  visit(directory)
  for (const executable of ['rovai-server', 'rovai-host', 'rovai']) {
    if (!files[executable]) throw new Error(`Linux Server package is missing ELF executable ${executable}`)
  }
  return { schemaVersion: 1, target: 'linux-x64', maximumRequiredGlibc: linuxServerGlibcBaseline, files }
}
