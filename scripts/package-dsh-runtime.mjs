// Stage the complete self-contained official DSH CLI from the committed public
// npm lock, then verify the closed bundle manifest.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { archForNode, closureRequirements, demand, entryName, launcherName, listFiles,
  manifestName, nodePath, platformForNode, rootVersion, sha256, treeDigest, verifyBundle } from '../resources/dsh-runtime/verify.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'resources', 'dsh-runtime')
const options = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--verify') options.set(key, true)
  else {
    if (key !== '--destination' || !process.argv[i + 1]) throw new Error('unknown DSH packaging argument')
    options.set(key, process.argv[++i])
  }
}
const destination = resolve(options.get('--destination') ?? join(root, 'resources', 'runtime', 'dsh'))
const packagedSources = ['verify.mjs', 'license-sources.json', 'package.json', 'package-lock.json',
  ...listFiles(source, 'licenses')]
function verify() {
  const digest = sha256(readFileSync(join(destination, manifestName)))
  const result = verifyBundle(destination, digest)
  for (const name of packagedSources) {
    if (sha256(readFileSync(join(source, name))) !== sha256(readFileSync(join(destination, name)))) {
      throw new Error('packaged DSH source differs: ' + name)
    }
  }
  console.log(JSON.stringify({ status: 'verified', root: destination, manifestSha256: digest,
    platform: result.manifest.platform, arch: result.manifest.arch,
    nodeVersion: result.manifest.nodeVersion, rootVersion, launcher: result.manifest.launcher,
    node: result.manifest.node, entry: result.manifest.entry,
    treeSha256: result.manifest.treeSha256, lockSha256: result.manifest.lockSha256,
    files: result.manifest.files.length, installScripts: false, testedNode: process.version }))
}
function npmCli() {
  const candidates = [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) throw new Error('npm CLI must accompany the selected Node')
  return found
}
function launcherText(platform) {
  if (platform === 'windows') {
    return ['@echo off',
      'rem Run the bundled official DSH CLI with the bundled Node runtime.',
      'setlocal',
      'set "DSH_ROOT=%~dp0"',
      '"%DSH_ROOT%node\\node.exe" "%DSH_ROOT%node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
      'exit /b %ERRORLEVEL%', ''].join('\r\n')
  }
  return ['#!/bin/sh',
    '# Run the bundled official DSH CLI with the bundled Node runtime.',
    'set -eu',
    'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    'exec "$root/node/node" "$root/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"', ''].join('\n')
}
function installedPackages(lock) {
  const packages = [], missing = []
  for (const [path, locked] of Object.entries(lock.packages)) {
    if (!path) continue
    demand(path.startsWith('node_modules/') && !locked.link && typeof locked.version === 'string'
      && /^sha512-[A-Za-z0-9+/]+=*$/.test(locked.integrity ?? ''), 'dsh_dependency_lock_invalid')
    const url = new URL(locked.resolved)
    demand(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org'
      && !(url.username + url.password + url.search + url.hash), 'dsh_dependency_source_invalid')
    if (!existsSync(join(destination, path, 'package.json'))) {
      if (locked.optional === true || locked.dev === true) continue
      missing.push(path)
      continue
    }
    const info = JSON.parse(readFileSync(join(destination, path, 'package.json'), 'utf8'))
    demand(info.version === locked.version && typeof info.name === 'string', 'dsh_dependency_version_mismatch')
    const license = typeof info.license === 'string' ? info.license
      : typeof locked.license === 'string' ? locked.license : JSON.stringify(info.license ?? null)
    packages.push({ path, name: info.name, version: info.version, license, resolved: locked.resolved })
  }
  if (missing.length) throw new Error('DSH dependency closure is incomplete: ' + missing[0])
  return packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
function writeNotices() {
  const supplemental = JSON.parse(readFileSync(join(destination, 'license-sources.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(destination, 'package-lock.json'), 'utf8'))
  const packages = installedPackages(lock), withoutText = []
  const notices = ['LOOM self-contained official DSH runtime - third-party notices',
    'The root CLI version is ' + rootVersion + '; every installed dependency version and registry integrity is recorded by the official lockfile.',
    'Installation scripts are disabled. Original package resources are retained. No global DSH is used.', '']
  for (const row of packages) {
    const packageRoot = join(destination, row.path)
    let licenseRoot = packageRoot
    let texts = readdirSync(packageRoot).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)
      && statSync(join(packageRoot, name)).isFile()).sort()
    notices.push('='.repeat(72), row.name + '@' + row.version + ' (' + row.license + ')', row.resolved)
    if (!texts.length) {
      const notice = supplemental.entries.find(item => item.package === row.name && item.version === row.version
        && item.license === row.license && typeof item.file === 'string' && item.file.startsWith('licenses/')
        && sha256(readFileSync(join(destination, item.file))) === item.sha256)
      if (notice) {
        licenseRoot = destination
        texts = [notice.file]
        notices.push('Notice source: ' + JSON.stringify(notice.source))
      }
    }
    if (!texts.length) {
      withoutText.push(row.name + '@' + row.version)
      notices.push('The package does not distribute a license file; the declared license and registry URL above apply.')
    }
    for (const name of texts) notices.push(readFileSync(join(licenseRoot, name), 'utf8').trim())
    notices.push('')
  }
  if (withoutText.length) {
    notices.push('='.repeat(72), 'Packages that declare a license without distributing its text (read from the registry tarball above):',
      ...withoutText.map(name => '  ' + name), '')
  }
  writeFileSync(join(destination, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n') + '\n')
}
if (options.get('--verify')) verify()
else {
  const platform = platformForNode(process.platform)
  demand(platform === 'linux' || platform === 'windows', 'unsupported DSH runtime platform: ' + platform)
  const arch = archForNode(process.arch)
  demand(arch === 'x86_64', 'unsupported DSH runtime architecture: ' + arch)
  const [major, minor] = process.versions.node.split('.').map(Number)
  demand(major > 22 || (major === 22 && minor >= 19), 'use Node 22.19 or newer for packaging')
  if (existsSync(destination) && readdirSync(destination).length) throw new Error('destination must be empty')
  mkdirSync(destination, { recursive: true })
  const temporary = mkdtempSync(join(tmpdir(), 'loom-dsh-install-'))
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(source, file), join(temporary, file))
    const userConfig = join(temporary, 'user.npmrc'), globalConfig = join(temporary, 'global.npmrc')
    writeFileSync(userConfig, ''); writeFileSync(globalConfig, '')
    const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|userprofile|localappdata|appdata|programfiles|programfiles\(x86\)|home|lang|lc_all|lc_ctype|tz|term|shell)$/i
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)))
    Object.assign(env, { npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_cache: join(temporary, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org/' })
    console.log(JSON.stringify({ stage: 'npm-ci', platform, arch, rootVersion, scripts: false,
      userNpmConfiguration: false }))
    const installed = spawnSync(process.execPath,
      [npmCli(), 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-bin-links'],
      { cwd: temporary, env, encoding: 'utf8', timeout: 900000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    if (installed.status !== 0) throw new Error('fixed official DSH installation failed: ' + (installed.error?.code ?? installed.status))
    for (const name of ['package.json', 'package-lock.json']) {
      if (sha256(readFileSync(join(source, name))) !== sha256(readFileSync(join(temporary, name)))) {
        throw new Error('DSH lock changed during installation')
      }
      copyFileSync(join(source, name), join(destination, name))
    }
    rmSync(join(temporary, 'node_modules', '.bin'), { recursive: true, force: true })
    cpSync(join(temporary, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: false })
    rmSync(join(destination, 'node_modules', '.bin'), { recursive: true, force: true })
    for (const name of packagedSources.filter(name => name !== 'package.json' && name !== 'package-lock.json')) {
      mkdirSync(dirname(join(destination, name)), { recursive: true })
      copyFileSync(join(source, name), join(destination, name))
    }
    const bundledNode = join(destination, nodePath(platform))
    mkdirSync(dirname(bundledNode), { recursive: true })
    copyFileSync(realpathSync.native(process.execPath), bundledNode)
    chmodSync(bundledNode, 0o755)
    const nodeProbe = spawnSync(bundledNode, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (nodeProbe.status !== 0 || nodeProbe.stdout.trim() !== process.version) {
      throw new Error('bundled Node did not report the packaging Node version')
    }
    const launcher = join(destination, launcherName(platform))
    writeFileSync(launcher, launcherText(platform))
    chmodSync(launcher, 0o755)
    writeNotices()
    for (const name of closureRequirements(platform, arch)) {
      demand(existsSync(join(destination, name)), 'DSH runtime closure is incomplete: ' + name)
    }
    const dshPackage = JSON.parse(readFileSync(join(destination, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
    demand(dshPackage.version === rootVersion, 'installed DSH version differs from the pinned root version')
    const files = listFiles(destination).filter(name => name !== manifestName).map(path => {
      const bytes = readFileSync(join(destination, path))
      return { path, bytes: bytes.length, sha256: sha256(bytes) }
    })
    const manifest = { schemaVersion: 1, kind: 'loom-dsh-runtime', platform, arch,
      nodeVersion: process.version, rootVersion, closureComplete: true, installScripts: false,
      launcher: launcherName(platform), node: nodePath(platform), entry: entryName,
      lockSha256: sha256(readFileSync(join(destination, 'package-lock.json'))),
      treeSha256: treeDigest(files), files }
    writeFileSync(join(destination, manifestName), JSON.stringify(manifest, null, 2) + '\n')
    verify()
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
