// Stage the complete official ACP CLI from the committed public npm lock.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { componentVersions, entryName, installedPackages, listFiles, manifestName,
  rootVersion, sha256, verifyBundle } from '../resources/dsh-runtime/verify.mjs'

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
const packagedSources = ['verify.mjs', 'package.json', 'package-lock.json', 'license-sources.json', ...listFiles(source, 'licenses')]
function verify() {
  const digest = sha256(readFileSync(join(destination, manifestName)))
  const result = verifyBundle(destination, digest)
  for (const name of packagedSources) {
    if (sha256(readFileSync(join(source, name))) !== sha256(readFileSync(join(destination, name)))) {
      throw new Error('packaged DSH source differs: ' + name)
    }
  }
  console.log(JSON.stringify({ status: 'verified', root: destination, manifestSha256: digest,
    treeSha256: result.manifest.treeSha256, lockSha256: result.manifest.lockSha256,
    files: result.manifest.files.length, packages: result.manifest.packages.length,
    rootVersion, componentVersions: result.manifest.componentVersions, entry: entryName,
    nodeRequirement: '>=22.19.0', testedNode: process.version }))
}
if (options.get('--verify')) verify()
else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('build on Windows x64')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('use Node 24 for packaging')
  if (existsSync(destination) && readdirSync(destination).length) throw new Error('destination must be empty')
  mkdirSync(destination, { recursive: true })
  const temporary = mkdtempSync(join(tmpdir(), 'loom-dsh-install-'))
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(source, file), join(temporary, file))
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCli)) throw new Error('npm CLI must accompany the selected Node')
    const userConfig = join(temporary, 'user.npmrc'), globalConfig = join(temporary, 'global.npmrc')
    writeFileSync(userConfig, ''); writeFileSync(globalConfig, '')
    const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|programfiles|programfiles\(x86\))$/i
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)))
    Object.assign(env, { npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_cache: join(temporary, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org/' })
    console.log(JSON.stringify({ stage: 'npm-ci', rootVersion, scripts: false, userNpmConfiguration: false }))
    const installed = spawnSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: temporary, env, encoding: 'utf8', timeout: 360000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
    if (installed.status !== 0) throw new Error('fixed official DSH installation failed: ' + (installed.error?.code ?? installed.status))
    for (const name of ['package.json', 'package-lock.json']) {
      if (sha256(readFileSync(join(source, name))) !== sha256(readFileSync(join(temporary, name)))) {
        throw new Error('DSH lock changed during installation')
      }
      copyFileSync(join(source, name), join(destination, name))
    }
    cpSync(join(temporary, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: false })
    for (const name of packagedSources.filter(name => name !== 'package.json' && name !== 'package-lock.json')) {
      mkdirSync(dirname(join(destination, name)), { recursive: true })
      copyFileSync(join(source, name), join(destination, name))
    }
    const supplemental = JSON.parse(readFileSync(join(destination, 'license-sources.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(destination, 'package-lock.json'), 'utf8'))
    const packages = installedPackages(destination, lock), missing = []
    const notices = ['LOOM official DSH ACP runtime - third-party notices',
      'The root CLI version is ' + rootVersion + '; every installed dependency version and registry integrity is recorded.',
      'Original package resources are retained. Installation scripts are disabled. No global DSH is used.', '']
    for (const row of packages) {
      let licenseRoot = join(destination, row.path)
      let texts = readdirSync(licenseRoot).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)
        && lstatSync(join(licenseRoot, name)).isFile())
      if (!texts.length && row.name === '@koromix/koffi-win32-x64') {
        const wrapper = JSON.parse(readFileSync(join(destination, 'node_modules/koffi/package.json'), 'utf8'))
        if (wrapper.version !== row.version || wrapper.license !== row.license) throw new Error('Koffi license version mismatch')
        licenseRoot = join(destination, 'node_modules/koffi'); texts = ['LICENSE.txt']
      }
      notices.push('='.repeat(72), row.name + '@' + row.version + ' (' + row.license + ')',
        lock.packages[row.path].resolved)
      if (!texts.length) {
        const notice = supplemental.entries.find(item => item.package === row.name && item.version === row.version)
        if (notice && notice.license === row.license && notice.file.startsWith('licenses/')
          && sha256(readFileSync(join(destination, notice.file))) === notice.sha256) {
          licenseRoot = destination; texts = [notice.file]
          notices.push('Notice source: ' + JSON.stringify(notice.source))
        } else missing.push({ name: row.name, version: row.version, license: row.license })
      }
      for (const name of texts) notices.push(readFileSync(join(licenseRoot, name), 'utf8').trim())
      notices.push('')
    }
    if (missing.length) throw new Error('Published packages need additional license notices: ' + JSON.stringify(missing))
    writeFileSync(join(destination, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n') + '\n')
    const files = listFiles(destination).map(path => {
      const bytes = readFileSync(join(destination, path))
      return { path, size: bytes.length, sha256: sha256(bytes) }
    })
    const manifest = { schemaVersion: 1, kind: 'loom-dsh-runtime', platform: 'win32', arch: 'x64',
      rootVersion, componentVersions: componentVersions(packages), closureComplete: true,
      installScripts: false, entry: entryName, packages,
      lockSha256: sha256(readFileSync(join(destination, 'package-lock.json'))),
      treeSha256: sha256(JSON.stringify(files)), files }
    writeFileSync(join(destination, manifestName), JSON.stringify(manifest, null, 2) + '\n')
    verify()
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
