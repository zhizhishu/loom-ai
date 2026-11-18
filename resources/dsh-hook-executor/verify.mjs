import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export const manifestName = 'hook-executor-bundle.json'
export const dependencyVersion = '0.1.5-rc.2'
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const demand = (value, code) => { if (!value) throw new Error(code) }
export function regularFile(root, name) {
  demand(typeof name === 'string' && name.length && !name.includes('\\')
    && !isAbsolute(name) && !name.split('/').some(p => !p || p === '.' || p === '..'), 'local_hook_bundle_path_invalid')
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    demand(!lstatSync(current).isSymbolicLink(), 'local_hook_bundle_link_refused')
  }
  demand(lstatSync(current).isFile(), 'local_hook_bundle_file_missing')
  const path = realpathSync.native(current), rel = relative(root, path)
  demand(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'local_hook_bundle_path_escape')
  return path
}
export function listFiles(root, prefix = '') {
  const result = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name
    demand(!entry.isSymbolicLink(), 'local_hook_bundle_link_refused')
    if (entry.isDirectory()) result.push(...listFiles(root, name))
    else { demand(entry.isFile(), 'local_hook_bundle_file_type_invalid'); result.push(name) }
  }
  return result.sort()
}
export function verifyBundle(directory, expectedManifestDigest) {
  const root = realpathSync.native(directory)
  const bytes = readFileSync(regularFile(root, manifestName))
  demand(/^[a-f0-9]{64}$/.test(expectedManifestDigest) && sha256(bytes) === expectedManifestDigest,
    'local_hook_bundle_manifest_changed')
  const manifest = JSON.parse(bytes)
  demand(manifest.schemaVersion === 1 && manifest.kind === 'loom-local-hook-executor'
    && manifest.platform === 'win32' && manifest.arch === 'x64'
    && manifest.dshVersion === dependencyVersion && manifest.entry === 'executor.mjs'
    && manifest.closureComplete === true && Array.isArray(manifest.files)
    && manifest.files.length > 10 && manifest.files.length <= 10000, 'local_hook_bundle_manifest_invalid')
  const names = manifest.files.map(row => row.path)
  demand(new Set(names).size === names.length && names.join('\n') === [...names].sort().join('\n'),
    'local_hook_bundle_inventory_invalid')
  demand(JSON.stringify(listFiles(root).filter(name => name !== manifestName)) === JSON.stringify(names),
    'local_hook_bundle_inventory_changed')
  for (const row of manifest.files) {
    const contents = readFileSync(regularFile(root, row.path))
    demand(contents.length === row.size && sha256(contents) === row.sha256, 'local_hook_bundle_file_changed')
  }
  demand(sha256(JSON.stringify(manifest.files)) === manifest.treeSha256, 'local_hook_bundle_tree_changed')
  const lock = JSON.parse(readFileSync(regularFile(root, 'package-lock.json'), 'utf8'))
  demand(sha256(readFileSync(join(root, 'package-lock.json'))) === manifest.lockSha256,
    'local_hook_bundle_lock_changed')
  const installed = listFiles(root).filter(name => /^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(name))
  demand(installed.length === manifest.packages.length && installed.length > 0,
    'local_hook_bundle_closure_incomplete')
  for (const file of installed) {
    const info = JSON.parse(readFileSync(join(root, file), 'utf8'))
    const entry = file.slice(0, -'/package.json'.length), locked = lock.packages[entry]
    demand(locked && locked.version === info.version && typeof locked.integrity === 'string'
      && locked.integrity.startsWith('sha512-'), 'local_hook_dependency_lock_mismatch')
    if (info.name.startsWith('@deepseek-ai/dsh-')) {
      demand(info.version === dependencyVersion, 'local_hook_dependency_version_mismatch')
    }
    const recorded = manifest.packages.find(row => row.path === entry)
    demand(recorded?.name === info.name && recorded?.version === info.version
      && recorded?.integrity === locked.integrity && typeof recorded.license === 'string',
    'local_hook_dependency_manifest_mismatch')
  }
  demand(names.includes('THIRD-PARTY-NOTICES.txt') && names.includes('executor.mjs')
    && names.includes('verify.mjs'), 'local_hook_bundle_resources_missing')
  return { root, manifest, manifestDigest: sha256(bytes) }
}
export function validateLaunch(launch) {
  demand(launch?.schemaVersion === 1 && typeof launch.agentRunId === 'string'
    && Number.isSafeInteger(launch.executionEpoch) && launch.executionEpoch >= 0
    && /^[a-f0-9]{64}$/.test(launch.snapshotDigest) && typeof launch.hookId === 'string'
    && isAbsolute(launch.workspaceRoot) && ['read-only', 'workspace-write'].includes(launch.sandboxMode),
  'local_hook_launch_invalid')
  const events = launch.settings?.hooks
  demand(events && Object.keys(launch.settings).join() === 'hooks'
    && Object.keys(events).join() === 'PostToolUse'
    && Array.isArray(events.PostToolUse) && events.PostToolUse.length === 1, 'local_hook_settings_invalid')
  const group = events.PostToolUse[0], hook = group?.hooks?.[0]
  demand(group && Object.keys(group).sort().join() === 'hooks,matcher'
    && /^\^[A-Za-z0-9_-]{1,128}\$$/.test(group.matcher)
    && group.hooks.length === 1 && hook
    && Object.keys(hook).sort().join() === 'command,timeout,type'
    && hook.type === 'command' && typeof hook.command === 'string'
    && hook.command.trim().length && hook.command.length <= 8000
    && typeof hook.timeout === 'number' && Number.isFinite(hook.timeout)
    && hook.timeout > 0 && hook.timeout <= 5, 'local_hook_command_invalid')
  return { tool: group.matcher.slice(1, -1), command: hook.command, timeoutSec: hook.timeout }
}
