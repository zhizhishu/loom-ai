// Verify the self-contained official DSH runtime tree and its closed manifest.
// Platform and architecture names follow the Rust target vocabulary
// (linux|windows|macos and x86_64|aarch64), never Node's win32/x64 spelling.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const manifestName = 'dsh-runtime-bundle.json'
export const entryName = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
export const rootVersion = '0.2.0-rc.2'
export const platformNames = ['linux', 'windows', 'macos']
export const archNames = ['x86_64', 'aarch64']
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const demand = (condition, code) => { if (!condition) throw new Error(code) }
export const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
export function platformForNode(value) {
  const known = { linux: 'linux', win32: 'windows', darwin: 'macos' }
  demand(Object.hasOwn(known, value), 'unsupported DSH runtime platform: ' + value)
  return known[value]
}
export function archForNode(value) {
  const known = { x64: 'x86_64', arm64: 'aarch64' }
  demand(Object.hasOwn(known, value), 'unsupported DSH runtime architecture: ' + value)
  return known[value]
}
export function launcherName(platform) {
  demand(platformNames.includes(platform), 'dsh_bundle_platform_unsupported')
  return platform === 'windows' ? 'dsh.cmd' : 'dsh'
}
export function nodePath(platform) {
  demand(platformNames.includes(platform), 'dsh_bundle_platform_unsupported')
  return platform === 'windows' ? 'node/node.exe' : 'node/node'
}
const nativePackages = {
  linux: { x86_64: 'node-addon-require-builtin-linux-x64-gnu', aarch64: 'node-addon-require-builtin-linux-arm64-gnu' },
  windows: { x86_64: 'node-addon-require-builtin-win32-x64-msvc', aarch64: 'node-addon-require-builtin-win32-arm64-msvc' },
  macos: { x86_64: 'node-addon-require-builtin-darwin-x64', aarch64: 'node-addon-require-builtin-darwin-arm64' }
}
// The closure the runtime cannot start or sandbox without on this target.
export function closureRequirements(platform, arch) {
  const launcher = launcherName(platform)
  const native = nativePackages[platform]
  demand(native && Object.hasOwn(native, arch), 'dsh_bundle_platform_unsupported')
  return [launcher, nodePath(platform), entryName, 'package.json', 'package-lock.json',
    'node_modules/@deepseek-ai/dsh-sandbox-local/package.json',
    'node_modules/' + native[arch] + '/package.json']
}
// treeSha256 is sha256(path + "\t" + bytes + "\t" + sha256 + "\n") over the rows
// sorted by path, so the digest is reproducible outside Node.
export function treeDigest(files) {
  const rows = files.map(row => row.path + '\t' + row.bytes + '\t' + row.sha256 + '\n')
  rows.sort(ordinal)
  return sha256(rows.join(''))
}
export function regularFile(root, name) {
  demand(typeof name === 'string' && name.length && !/[:\\]/.test(name)
    && !isAbsolute(name) && !name.split('/').some(p => !p || p === '.' || p === '..'), 'dsh_bundle_path_invalid')
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    demand(!lstatSync(current).isSymbolicLink(), 'dsh_bundle_link_refused')
  }
  demand(lstatSync(current).isFile(), 'dsh_bundle_file_missing')
  const path = realpathSync.native(current), rel = relative(root, path)
  demand(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'dsh_bundle_path_escape')
  return path
}
export function listFiles(root, prefix = '') {
  const result = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name
    demand(!entry.isSymbolicLink(), 'dsh_bundle_link_refused')
    if (entry.isDirectory()) result.push(...listFiles(root, name))
    else { demand(entry.isFile(), 'dsh_bundle_file_type_invalid'); result.push(name) }
  }
  return result.sort(ordinal)
}
export function verifyBundle(directory, expectedDigest) {
  const root = realpathSync.native(directory)
  const bytes = readFileSync(regularFile(root, manifestName))
  demand(/^[a-f0-9]{64}$/.test(expectedDigest ?? '') && sha256(bytes) === expectedDigest,
    'dsh_bundle_manifest_changed')
  const manifest = JSON.parse(bytes)
  demand(manifest.schemaVersion === 1 && manifest.kind === 'loom-dsh-runtime', 'dsh_bundle_manifest_invalid')
  demand(platformNames.includes(manifest.platform) && archNames.includes(manifest.arch),
    'dsh_bundle_platform_invalid')
  demand(manifest.rootVersion === rootVersion && manifest.entry === entryName, 'dsh_bundle_manifest_invalid')
  demand(manifest.launcher === launcherName(manifest.platform) && manifest.node === nodePath(manifest.platform),
    'dsh_bundle_launcher_invalid')
  demand(manifest.closureComplete === true && manifest.installScripts === false, 'dsh_bundle_manifest_invalid')
  demand(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(manifest.nodeVersion ?? ''),
    'dsh_bundle_node_version_invalid')
  demand(Array.isArray(manifest.files) && manifest.files.length > 100 && manifest.files.length <= 200000,
    'dsh_bundle_manifest_invalid')
  const names = manifest.files.map(row => row.path)
  demand(!names.includes(manifestName) && new Set(names).size === names.length
    && names.join('\n') === [...names].sort(ordinal).join('\n'), 'dsh_bundle_inventory_invalid')
  demand(JSON.stringify(listFiles(root).filter(name => name !== manifestName)) === JSON.stringify(names),
    'dsh_bundle_inventory_changed')
  for (const row of manifest.files) {
    demand(Number.isInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? ''),
      'dsh_bundle_manifest_invalid')
    const contents = readFileSync(regularFile(root, row.path))
    demand(contents.length === row.bytes && sha256(contents) === row.sha256,
      'dsh_bundle_file_changed:' + row.path)
  }
  demand(treeDigest(manifest.files) === manifest.treeSha256, 'dsh_bundle_tree_changed')
  const lockBytes = readFileSync(regularFile(root, 'package-lock.json'))
  demand(/^[a-f0-9]{64}$/.test(manifest.lockSha256 ?? '') && sha256(lockBytes) === manifest.lockSha256,
    'dsh_bundle_lock_changed')
  const lock = JSON.parse(lockBytes)
  demand(lock.packages?.['']?.dependencies?.['@deepseek-ai/dsh'] === rootVersion, 'dsh_root_version_changed')
  for (const name of closureRequirements(manifest.platform, manifest.arch)) {
    demand(names.includes(name), 'dsh_bundle_closure_missing:' + name)
  }
  const dshPackage = JSON.parse(readFileSync(regularFile(root, 'node_modules/@deepseek-ai/dsh/package.json')))
  demand(dshPackage.name === '@deepseek-ai/dsh' && dshPackage.version === rootVersion,
    'dsh_bundle_root_version_mismatch')
  if (process.platform !== 'win32' && manifest.platform !== 'windows') {
    for (const name of [manifest.launcher, manifest.node]) {
      demand((statSync(regularFile(root, name)).mode & 0o111) !== 0, 'dsh_bundle_not_executable:' + name)
    }
  }
  demand(!names.some(name => name.includes('dsh-purge')), 'dsh_bundle_unofficial_patch_refused')
  return { root, manifest, manifestDigest: sha256(bytes) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length === 3, 'dsh_bundle_expected_manifest_digest_required')
  const result = verifyBundle(dirname(fileURLToPath(import.meta.url)), process.argv[2])
  console.log(JSON.stringify({ status: 'verified', manifestSha256: result.manifestDigest,
    platform: result.manifest.platform, arch: result.manifest.arch,
    nodeVersion: result.manifest.nodeVersion, rootVersion: result.manifest.rootVersion,
    files: result.manifest.files.length }))
}
