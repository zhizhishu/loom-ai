// Build the Windows private Hook executor without changing an installed DSH.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dependencyVersion, listFiles, manifestName, sha256, verifyBundle } from '../resources/dsh-hook-executor/verify.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'resources', 'dsh-hook-executor')
const options = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--verify') options.set(key, true)
  else { if (!['--source', '--destination'].includes(key) || !process.argv[i + 1]) throw new Error('unknown packaging argument'); options.set(key, process.argv[++i]) }
}
const destination = resolve(options.get('--destination') ?? join(root, 'resources', 'runtime', 'dsh-hook-executor'))
function verify() {
  const digest = sha256(readFileSync(join(destination, manifestName)))
  const result = verifyBundle(destination, digest)
  for (const name of ['executor.mjs', 'verify.mjs', 'package.json', 'package-lock.json']) {
    if (sha256(readFileSync(join(source, name))) !== sha256(readFileSync(join(destination, name)))) {
      throw new Error('packaged Hook source differs: ' + name)
    }
  }
  console.log(JSON.stringify({ status: 'verified', root: destination, manifestSha256: digest,
    treeSha256: result.manifest.treeSha256, files: result.manifest.files.length,
    packages: result.manifest.packages.length, dshVersion: dependencyVersion,
    nodeRequirement: '>=22.19.0', testedNode: process.version }))
}
if (options.get('--verify')) { verify() }
else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('build on Windows x64')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('use Node 24 for packaging')
  if (existsSync(destination) && readdirSync(destination).length) throw new Error('destination must be empty')
  mkdirSync(destination, { recursive: true })
  let temporary
  try {
    let installed = options.get('--source') ? resolve(options.get('--source')) : undefined
    if (!installed) {
      temporary = mkdtempSync(join(dirname(destination), '.hook-install-'))
      installed = temporary
      for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(source, file), join(installed, file))
      const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (!existsSync(npmCli)) throw new Error('npm CLI must accompany the selected Node')
      const userConfig = join(temporary, 'user.npmrc'), globalConfig = join(temporary, 'global.npmrc')
      writeFileSync(userConfig, ''); writeFileSync(globalConfig, '')
      const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|programfiles|programfiles\(x86\))$/i
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)))
      Object.assign(env, { npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
        npm_config_cache: join(temporary, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org/' })
      const result = spawnSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
        { cwd: installed, env, encoding: 'utf8', timeout: 180000, windowsHide: true })
      if (result.status !== 0) throw new Error('fixed Hook dependency installation failed: ' + (result.error?.code ?? result.status))
    }
    for (const name of ['package.json', 'package-lock.json']) {
      if (sha256(readFileSync(join(source, name))) !== sha256(readFileSync(join(installed, name)))) {
        throw new Error('reused dependency source is not the exact pinned lock')
      }
      copyFileSync(join(source, name), join(destination, name))
    }
    cpSync(join(installed, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: false })
    for (const name of ['executor.mjs', 'verify.mjs']) copyFileSync(join(source, name), join(destination, name))
    const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'))
    const packages = [], notices = ['LOOM local Hook executor - third-party notices',
      'Official @deepseek-ai/dsh-* packages are fixed at ' + dependencyVersion + '.',
      'Package contents and native resources are preserved; installation scripts are disabled.', '']
    for (const file of listFiles(join(destination, 'node_modules')).filter(name => /^(?:@[^/]+\/)?[^/]+\/package\.json$/.test(name))) {
      const path = 'node_modules/' + file.slice(0, -'/package.json'.length)
      const info = JSON.parse(readFileSync(join(destination, 'node_modules', file), 'utf8'))
      const locked = lock.packages[path]
      if (!locked || info.version !== locked.version || !locked.integrity) throw new Error('unlocked dependency: ' + path)
      const license = typeof info.license === 'string' ? info.license : JSON.stringify(info.license)
      if (!license) throw new Error('missing dependency license: ' + path)
      const row = { path, name: info.name, version: info.version, license, integrity: locked.integrity }
      packages.push(row)
      let licenseRoot = join(destination, path)
      let licenseFiles = readdirSync(licenseRoot).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name))
      // Koffi's platform binary package is distributed under the wrapper's
      // license; require the identical version before using that notice.
      if (!licenseFiles.length && info.name === '@koromix/koffi-win32-x64') {
        const wrapper = JSON.parse(readFileSync(join(destination, 'node_modules/koffi/package.json'), 'utf8'))
        if (wrapper.version !== info.version || wrapper.license !== license) throw new Error('Koffi license version mismatch')
        licenseRoot = join(destination, 'node_modules/koffi')
        licenseFiles = ['LICENSE.txt']
      }
      if (!licenseFiles.length) throw new Error('license text is missing: ' + info.name)
      notices.push('='.repeat(72), info.name + '@' + info.version + ' (' + license + ')', locked.resolved ?? '')
      for (const file of licenseFiles) notices.push(readFileSync(join(licenseRoot, file), 'utf8').trim())
      notices.push('')
    }
    packages.sort((a, b) => a.path.localeCompare(b.path, 'en'))
    writeFileSync(join(destination, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n') + '\n')
    const files = listFiles(destination).map(path => {
      const bytes = readFileSync(join(destination, path))
      return { path, size: bytes.length, sha256: sha256(bytes) }
    })
    const manifest = { schemaVersion: 1, kind: 'loom-local-hook-executor', platform: 'win32', arch: 'x64',
      dshVersion: dependencyVersion, closureComplete: true, entry: 'executor.mjs', packages,
      lockSha256: sha256(readFileSync(join(destination, 'package-lock.json'))),
      treeSha256: sha256(JSON.stringify(files)), files }
    writeFileSync(join(destination, manifestName), JSON.stringify(manifest, null, 2) + '\n')
    verify()
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}
