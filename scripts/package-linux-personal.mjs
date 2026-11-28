#!/usr/bin/env node
// Assemble and verify the isolated Linux/WSL personal package.
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { verifyBundle as verifyDshRuntime } from '../resources/dsh-runtime/verify.mjs'

const repository = resolve(import.meta.dirname, '..')
const REQUIRED = [
  'rovai-host', 'rovai-server', 'rovai', 'rovai-core', 'loom-node',
  'web-ui/index.html', 'skills/cli-operations/SKILL.md', 'LICENSE',
  'Manage-Loom.sh', 'Start-Loom.sh', 'Install-Loom.sh', 'README.md',
  'runtime/pi/pi-bundle.json', 'runtime/pi/node/node', 'runtime/pi/pi',
  'runtime/dsh/dsh-runtime-bundle.json', 'runtime/dsh/dsh', 'runtime/dsh/node/node',
  'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'runtime/computer/computer-bundle.json', 'runtime/computer/python',
  'runtime/computer/host_desktop.py', 'runtime/computer/mcp_bridge.py',
  'runtime/extensions/pi-purge/upstream/extensions/pi-purge.ts',
  'runtime/office/linux-x64/office-bundle.json', 'runtime/office/linux-x64/libreoffice/program/soffice',
  'runtime/office/linux-x64/poppler/bin/pdftoppm'
]
const PI_PURGE_SOURCE_SHA256 = '983a3c3cc3011928a33805d84414060729fd2aa81822bc7ba94008943a65d71d'
const EXECUTABLES = ['rovai-host', 'rovai-server', 'rovai', 'rovai-core', 'loom-node', 'Manage-Loom.sh', 'Start-Loom.sh', 'Install-Loom.sh', 'runtime/pi/pi', 'runtime/pi/node/node', 'runtime/dsh/dsh', 'runtime/dsh/node/node', 'runtime/computer/python']

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`command failed: ${command} ${args.join(' ')}`)
}
function filesUnder(root, prefix = '') {
  const rows = []
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name
    if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`unsafe package path: ${relative}`)
    const full = join(root, entry.name)
    if (entry.isDirectory()) rows.push(...filesUnder(full, `${relative}/`))
    else if (entry.isFile()) rows.push({ path: relative, sha256: sha256(full), bytes: statSync(full).size })
    else throw new Error(`personal package may contain only files and directories: ${relative}`)
  }
  return rows
}
function parseArgs() {
  const out = { binaries: [] }
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--verify') out.verify = true
    else if (key === '--binary') out.binaries.push(resolve(args[++index] ?? ''))
    else if (['--server-dir', '--pi-dir', '--dsh-dir', '--computer-dir', '--office-dir', '--pi-purge-file', '--output', '--archive'].includes(key)) out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = resolve(args[++index] ?? '')
    else throw new Error(`unknown argument: ${key}`)
  }
  return out
}
export function verifyLinuxPersonalPackage(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'candidate-manifest.json'), 'utf8'))
  if (manifest.schema !== 1 || manifest.target !== 'linux-x64' || !/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error('invalid Linux personal candidate manifest')
  const files = new Map(manifest.files.map(file => [file.path, file.sha256]))
  for (const required of REQUIRED) if (!files.has(required)) throw new Error(`Linux personal package is incomplete: ${required}`)
  for (const file of filesUnder(root)) {
    if (file.path === 'candidate-manifest.json') continue
    if (files.get(file.path) !== file.sha256) throw new Error(`damaged or unexpected package file: ${file.path}`)
    files.delete(file.path)
  }
  if (files.size) throw new Error(`Linux personal package files are missing: ${[...files.keys()][0]}`)
  const dshRoot = join(root, 'runtime/dsh')
  if (!existsSync(join(dshRoot, 'dsh-runtime-bundle.json'))) throw new Error('Linux personal package is missing the DSH runtime')
  const dsh = verifyDshRuntime(dshRoot, sha256(join(dshRoot, 'dsh-runtime-bundle.json')))
  if (dsh.manifest.platform !== 'linux' || dsh.manifest.arch !== 'x86_64' || dsh.manifest.launcher !== 'dsh') {
    throw new Error('Linux personal package carries a DSH runtime for another target')
  }
  const version = spawnSync(join(root, 'rovai-server'), ['--version'], { encoding: 'utf8' })
  if (version.status !== 0 || !version.stdout.startsWith('rovai-server ')) throw new Error('packaged rovai-server did not start for --version')
  return manifest
}
function stage(options) {
  for (const key of ['serverDir', 'piDir', 'dshDir', 'computerDir', 'officeDir', 'piPurgeFile', 'output']) if (!options[key]) throw new Error(`missing --${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`)
  if (!existsSync(join(options.serverDir, 'rovai-server'))) throw new Error('--server-dir must be a built linux server preview')
  if (existsSync(options.output)) {
    if (readdirSync(options.output).length) throw new Error(`refusing to overwrite non-empty output ${options.output}`)
  } else mkdirSync(options.output, { recursive: true })
  cpSync(options.serverDir, options.output, { recursive: true })
  for (const binary of options.binaries) {
    if (!existsSync(binary)) throw new Error(`missing binary ${binary}`)
    copyFileSync(binary, join(options.output, binary.split('/').pop()))
  }
  rmSync(join(options.output, 'install-server.sh'), { force: true })
  mkdirSync(join(options.output, 'runtime'), { recursive: true })
  cpSync(options.piDir, join(options.output, 'runtime/pi'), { recursive: true })
  cpSync(options.dshDir, join(options.output, 'runtime/dsh'), { recursive: true })
  verifyDshRuntime(join(options.output, 'runtime/dsh'), sha256(join(options.output, 'runtime/dsh/dsh-runtime-bundle.json')))
  cpSync(options.computerDir, join(options.output, 'runtime/computer'), { recursive: true })
  cpSync(options.officeDir, join(options.output, 'runtime/office/linux-x64'), { recursive: true })
  if (!existsSync(options.piPurgeFile) || sha256(options.piPurgeFile) !== PI_PURGE_SOURCE_SHA256) throw new Error('--pi-purge-file must be the pinned pi-purge.ts source bytes')
  const purgeTarget = join(options.output, 'runtime/extensions/pi-purge/upstream/extensions/pi-purge.ts')
  mkdirSync(dirname(purgeTarget), { recursive: true })
  copyFileSync(options.piPurgeFile, purgeTarget)
  copyFileSync(join(repository, 'scripts/manage-loom-personal.sh'), join(options.output, 'Manage-Loom.sh'))
  copyFileSync(join(repository, 'scripts/start-loom-personal.sh'), join(options.output, 'Start-Loom.sh'))
  copyFileSync(join(repository, 'scripts/install-loom-personal.sh'), join(options.output, 'Install-Loom.sh'))
  copyFileSync(join(repository, 'docs/loom/LOOM-PERSONAL-LINUX.md'), join(options.output, 'README.md'))
  for (const file of EXECUTABLES) if (existsSync(join(options.output, file))) chmodSync(join(options.output, file), 0o755)
  const version = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  writeFileSync(join(options.output, 'package-info'), `schema=1\nversion=${version}\ntarget=linux-x64\n`)
  const files = filesUnder(options.output).filter(file => file.path !== 'candidate-manifest.json')
  writeFileSync(join(options.output, 'candidate-manifest.json'), `${JSON.stringify({ schema: 1, version, commit, target: 'linux-x64', qualification: 'development-preview', files }, null, 2)}\n`)
  verifyLinuxPersonalPackage(options.output)
  if (options.archive) {
    mkdirSync(resolve(options.archive, '..'), { recursive: true })
    rmSync(options.archive, { force: true })
    run('tar', ['-C', resolve(options.output, '..'), '-czf', options.archive, options.output.split('/').pop()])
  }
  console.log(`Linux personal package staged at ${options.output}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs()
  if (options.verify) verifyLinuxPersonalPackage(options.output ?? process.cwd())
  else stage(options)
}
