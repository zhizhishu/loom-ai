import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The installer and future Rust updater consume this same immutable release layout. */
export function archiveServerPackage(directory, releaseDirectory, { version, target }) {
  if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version) || !/^(macos-(arm64|x64)|linux-x64|windows-x64)$/.test(target)) throw new Error('Invalid release coordinates')
  mkdirSync(releaseDirectory, { recursive: true })
  const staging = mkdtempSync(join(releaseDirectory, '.archive-'))
  const asset = `rovai-server-${version}-${target}.${target === 'windows-x64' ? 'zip' : 'tar.gz'}`
  const archive = join(releaseDirectory, asset)
  try {
    cpSync(directory, join(staging, 'rovai-server'), { recursive: true })
    rmSync(archive, { force: true })
    if (target === 'windows-x64') {
      const quote = value => `'${value.replaceAll("'", "''")}'`
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${quote(join(staging, 'rovai-server'))} -DestinationPath ${quote(archive)}`])
    } else execFileSync('tar', ['-czf', archive, '-C', staging, 'rovai-server'])
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    writeFileSync(join(releaseDirectory, 'SHA256SUMS'), `${digest}  ${asset}\n`)
    return { archive, digest }
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
