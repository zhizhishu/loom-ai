import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const manifestName = 'dsh-runtime-bundle.json'
export const entryName = 'node_modules/.bin/dsh.cmd'
export const rootVersion = '0.2.0-rc.2'
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const demand = (condition, code) => { if (!condition) throw new Error(code) }
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
  return result.sort()
}
export function installedPackages(root, lock) {
  const packages = []
  for (const [path, locked] of Object.entries(lock.packages)) {
    if (!path) continue
    demand(path.startsWith('node_modules/') && !locked.link && typeof locked.version === 'string'
      && /^sha512-[A-Za-z0-9+/]+=*$/.test(locked.integrity ?? ''), 'dsh_dependency_lock_invalid')
    const url = new URL(locked.resolved)
    demand(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org'
      && !(url.username + url.password + url.search + url.hash), 'dsh_dependency_source_invalid')
    if (!existsSync(join(root, path, 'package.json'))) {
      demand(locked.optional === true || locked.dev === true, 'dsh_dependency_missing:' + path)
      continue
    }
    const info = JSON.parse(readFileSync(regularFile(root, path + '/package.json'), 'utf8'))
    demand(info.version === locked.version && typeof info.name === 'string', 'dsh_dependency_version_mismatch')
    const license = typeof info.license === 'string' ? info.license
      : typeof locked.license === 'string' ? locked.license : JSON.stringify(info.license ?? null)
    packages.push({ path, name: info.name, version: info.version, license, integrity: locked.integrity })
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
export function componentVersions(packages) {
  const names = ['dsh', 'dsh-acp', 'dsh-sandbox', 'dsh-sandbox-local', 'dsh-sandbox-policy',
    'dsh-pwsh-sandbox', 'dsh-tool-pwsh', 'dsh-user-approval', 'dsh-mcp-client']
  return Object.fromEntries(names.map(name => ['@deepseek-ai/' + name,
    [...new Set(packages.filter(p => p.name === '@deepseek-ai/' + name).map(p => p.version))].sort()]))
}
export function verifyBundle(directory, expectedDigest) {
  const root = realpathSync.native(directory)
  const bytes = readFileSync(regularFile(root, manifestName))
  demand(/^[a-f0-9]{64}$/.test(expectedDigest) && sha256(bytes) === expectedDigest, 'dsh_bundle_manifest_changed')
  const manifest = JSON.parse(bytes)
  demand(manifest.schemaVersion === 1 && manifest.kind === 'loom-dsh-runtime'
    && manifest.platform === 'win32' && manifest.arch === 'x64'
    && manifest.rootVersion === rootVersion && manifest.entry === entryName
    && manifest.closureComplete === true && manifest.installScripts === false
    && Array.isArray(manifest.files) && manifest.files.length > 100
    && manifest.files.length <= 100000, 'dsh_bundle_manifest_invalid')
  const names = manifest.files.map(row => row.path)
  demand(new Set(names).size === names.length
    && names.join('\n') === [...names].sort().join('\n'), 'dsh_bundle_inventory_invalid')
  demand(JSON.stringify(listFiles(root).filter(name => name !== manifestName)) === JSON.stringify(names),
    'dsh_bundle_inventory_changed')
  for (const row of manifest.files) {
    const contents = readFileSync(regularFile(root, row.path))
    demand(contents.length === row.size && sha256(contents) === row.sha256, 'dsh_bundle_file_changed:' + row.path)
  }
  demand(sha256(JSON.stringify(manifest.files)) === manifest.treeSha256, 'dsh_bundle_tree_changed')
  const lockBytes = readFileSync(regularFile(root, 'package-lock.json'))
  demand(sha256(lockBytes) === manifest.lockSha256, 'dsh_bundle_lock_changed')
  const lock = JSON.parse(lockBytes)
  demand(lock.packages[''].dependencies['@deepseek-ai/dsh'] === rootVersion, 'dsh_root_version_changed')
  const packages = installedPackages(root, lock)
  demand(JSON.stringify(packages) === JSON.stringify(manifest.packages), 'dsh_bundle_packages_changed')
  demand(JSON.stringify(componentVersions(packages)) === JSON.stringify(manifest.componentVersions),
    'dsh_bundle_components_changed')
  for (const [name, versions] of Object.entries(manifest.componentVersions)) {
    demand(versions.length === 1 && versions[0] === rootVersion,
      'dsh_bundle_component_version_mismatch:' + name)
  }
  for (const name of [entryName, 'verify.mjs', 'license-sources.json', 'THIRD-PARTY-NOTICES.txt',
    'node_modules/@deepseek-ai/dsh/lib/bin.js']) demand(names.includes(name), 'dsh_bundle_entry_missing')
  demand(!names.some(name => name.includes('dsh-purge')), 'dsh_bundle_unofficial_patch_refused')
  return { root, manifest, manifestDigest: sha256(bytes) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length === 3, 'dsh_bundle_expected_manifest_digest_required')
  const result = verifyBundle(dirname(fileURLToPath(import.meta.url)), process.argv[2])
  console.log(JSON.stringify({ status: 'verified', manifestSha256: result.manifestDigest,
    rootVersion: result.manifest.rootVersion, files: result.manifest.files.length }))
}
