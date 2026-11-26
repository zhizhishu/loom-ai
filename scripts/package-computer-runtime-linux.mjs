#!/usr/bin/env node
// Stage the Linux/WSL LOOM computer helper runtime. The package carries the
// reviewed helper/bridge plus pinned Pillow wheels for common Ubuntu/WSL
// CPython versions; the small python shim selects the matching wheel at launch.
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const LINUX_COMPUTER_TARGET = 'linux-x64'
export const LINUX_PILLOW_VERSION = '12.3.0'
export const LINUX_PYTHON_TAGS = ['cp310', 'cp311', 'cp312', 'cp313', 'cp314']

const repository = resolve(import.meta.dirname, '..')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function portable(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`unsafe relative path: ${path}`)
  return path
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`command failed: ${command} ${args.join(' ')}`)
}
function filesUnder(root, prefix = '') {
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full, `${relative}/`))
    else if (entry.isFile()) out.push({ path: portable(relative), sha256: sha256(full), bytes: statSync(full).size })
    else throw new Error(`computer runtime may contain only files and directories: ${relative}`)
  }
  return out
}
function parseArgs() {
  const out = { destination: resolve(repository, 'resources/runtime/computer-linux'), verify: false }
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--verify') out.verify = true
    else if (args[index] === '--destination') out.destination = resolve(args[++index] ?? '')
    else throw new Error(`unknown argument: ${args[index]}`)
  }
  return out
}
function manifestPath(destination) { return join(destination, 'computer-bundle.json') }
export function verifyLinuxComputerRuntime(destination) {
  const manifest = JSON.parse(readFileSync(manifestPath(destination), 'utf8'))
  if (manifest.schema !== 1 || manifest.target !== LINUX_COMPUTER_TARGET || manifest.pillowVersion !== LINUX_PILLOW_VERSION) throw new Error('unexpected Linux computer runtime manifest')
  const expected = new Map(manifest.files.map(file => [file.path, file.sha256]))
  for (const file of filesUnder(destination)) {
    if (file.path === 'computer-bundle.json') continue
    if (expected.get(file.path) !== file.sha256) throw new Error(`damaged or unexpected computer runtime file: ${file.path}`)
    expected.delete(file.path)
  }
  if (expected.size) throw new Error(`computer runtime files are missing: ${[...expected.keys()][0]}`)
  for (const required of ['python', 'host_desktop.py', 'mcp_bridge.py', 'wheels/INDEX.txt', 'THIRD-PARTY-NOTICES.txt']) {
    if (!manifest.files.some(file => file.path === required)) throw new Error(`computer runtime is incomplete: ${required}`)
  }
  const probe = spawnSync(join(destination, 'python'), ['-B', '-c', 'import PIL;print(PIL.__version__)'], { encoding: 'utf8' })
  if (probe.status !== 0 || probe.stdout.trim() !== LINUX_PILLOW_VERSION) throw new Error(`bundled Pillow probe failed: ${probe.stderr || probe.stdout}`)
  return manifest
}
function stage(destination) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux computer runtime packaging requires linux x64')
  if (existsSync(destination) && readdirSync(destination).length) throw new Error(`refusing to overwrite non-empty destination ${destination}`)
  mkdirSync(destination, { recursive: true })
  const downloads = mkdtempSync(join(tmpdir(), 'loom-linux-computer-'))
  try {
    mkdirSync(join(destination, 'wheels'), { recursive: true })
    const indexRows = []
    for (const tag of LINUX_PYTHON_TAGS) {
      const py = `3.${tag.slice(3)}`
      run('python3', ['-m', 'pip', 'download', '-q', '--no-deps', '--only-binary=:all:', '--python-version', py, '--implementation', 'cp', '--abi', tag, '--platform', 'manylinux_2_28_x86_64', `pillow==${LINUX_PILLOW_VERSION}`, '-d', downloads])
      const wheel = readdirSync(downloads).find(name => name.includes(`-${tag}-`) && name.endsWith('.whl'))
      if (!wheel) throw new Error(`Pillow wheel missing for ${tag}`)
      copyFileSync(join(downloads, wheel), join(destination, 'wheels', wheel))
      indexRows.push(`${tag} ${wheel}`)
      rmSync(join(downloads, wheel))
    }
    writeFileSync(join(destination, 'wheels', 'INDEX.txt'), `${indexRows.join('\n')}\n`)
    for (const name of ['host_desktop.py', 'mcp_bridge.py']) copyFileSync(join(repository, 'resources/computer', name), join(destination, name))
    const shim = `#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nif command -v python3 >/dev/null 2>&1; then system_python=$(command -v python3)\nelse echo 'LOOM computer runtime requires python3 on Linux/WSL.' >&2; exit 1; fi\ntag=$($system_python -c 'import sys;print(f"cp{sys.version_info.major}{sys.version_info.minor}")' 2>/dev/null || true)\nwheel=\nfor candidate in \"$root\"/wheels/pillow-${LINUX_PILLOW_VERSION}-$tag-*.whl; do\n  if [ -f \"$candidate\" ]; then wheel=$candidate; break; fi\ndone\nif [ -z \"$wheel\" ]; then echo \"LOOM computer runtime has no Pillow wheel for $tag.\" >&2; exit 1; fi\nPYTHONPATH="$wheel\${PYTHONPATH:+:\$PYTHONPATH}" PYTHONNOUSERSITE=1 exec $system_python -B \"$@\"\n`
    writeFileSync(join(destination, 'python'), shim)
    chmodSync(join(destination, 'python'), 0o755)
    writeFileSync(join(destination, 'THIRD-PARTY-NOTICES.txt'), `LOOM Computer runtime for Linux x64\n\nPillow ${LINUX_PILLOW_VERSION} wheels (MIT-CMU) are retained unmodified for supported CPython versions.\nLOOM host_desktop.py and mcp_bridge.py use the repository LICENSE.\nThe package uses the system python3 executable available in the Linux/WSL installation.\n`)
    const manifest = {
      schema: 1,
      target: LINUX_COMPUTER_TARGET,
      pillowVersion: LINUX_PILLOW_VERSION,
      python: 'system python3 selected by packaged shim',
      files: filesUnder(destination)
    }
    writeFileSync(manifestPath(destination), `${JSON.stringify(manifest, null, 2)}\n`)
    verifyLinuxComputerRuntime(destination)
    console.log(`Linux computer runtime staged at ${destination}`)
  } finally {
    rmSync(downloads, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs()
  if (options.verify) verifyLinuxComputerRuntime(options.destination)
  else stage(options.destination)
}
