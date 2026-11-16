import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowFile = fileURLToPath(new URL('../../.github/workflows/loom-v2-e3-windows.yml', import.meta.url))
const workflow = readFileSync(workflowFile, 'utf8')
const sourcePackage = JSON.parse(readFileSync(new URL('../runtime/pi-source/package.json', import.meta.url), 'utf8'))
const sourceLock = JSON.parse(readFileSync(new URL('../runtime/pi-source/package-lock.json', import.meta.url), 'utf8'))

test('V2 E3 Windows CI is opt-in/PR only with read-only repository access', () => {
  assert.match(workflow, /^on:\s*$/m)
  assert.match(workflow, /^  workflow_dispatch:\s*$/m)
  assert.match(workflow, /^  pull_request:\s*$/m)
  assert.doesNotMatch(workflow, /^  (?:push|schedule|release|workflow_run):/m)
  assert.match(workflow, /^permissions:\s*\r?\n  contents: read\s*$/m)
  assert.match(workflow, /persist-credentials: false/)
  assert.doesNotMatch(workflow, /secrets\./)
  assert.match(workflow, /runs-on: windows-2022/)
})

test('V2 E3 CI pins versions and isolates both native Host and managed Pi', () => {
  assert.match(workflow, /node-version: 24\.14\.1/)
  assert.match(workflow, /pnpm@11\.20\.0/)
  assert.match(workflow, /rustup toolchain install 1\.97\.1/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /cargo build --locked -p rovai-host -p rovai-core -p loom-pi-launcher -p loom-node --bins --jobs 2/)
  assert.match(workflow, /pnpm build:web/)
  assert.equal(sourcePackage.dependencies['@earendil-works/pi-coding-agent'], '0.85.1')
  assert.match(workflow, /npm ci --prefix \$sourceRoot --ignore-scripts --no-audit --no-fund/)
  assert.match(workflow, /Pi source lock changed during installation/)
  assert.match(workflow, /package-embedded-pi\.mjs --source/)
  assert.match(workflow, /package-embedded-pi\.mjs --verify/)
  for (const line of workflow.split(/\r?\n/).filter(line => /\buses:/.test(line))) {
    assert.match(line.trim(), /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+$/, line)
  }
})

test('V2 E3 CI fails on skip and cannot silently promote E3 to E4-E7', () => {
  assert.match(workflow, /loom-v2-official-host-electron-review\.test\.mjs/)
  assert.match(workflow, /--test-reporter=tap/)
  assert.match(workflow, /# tests 1/)
  assert.match(workflow, /# pass 1/)
  assert.match(workflow, /# fail 0/)
  assert.match(workflow, /# skipped 0/)
  assert.match(workflow, /humanClickedUI = \$false/)
  assert.match(workflow, /mockProvider = \$true/)
  assert.match(workflow, /realExternalProvider = \$false/)
  for (const gate of ['E4', 'E5', 'E6', 'E7']) assert.match(workflow, new RegExp(`\\b${gate} = 'NOT_RUN'`))
  assert.match(workflow, /dependencyTreeSourceLock = 'committed npm lockfile with registry integrity; npm ci --ignore-scripts'/)
  assert.match(workflow, /piManifestTreeSha256 = \$piManifest\.treeSha256/)
  assert.match(workflow, /piDependencyClosureSha256 = \$closureSha/)
  assert.match(workflow, /piSourceLockSha256 = \$sourceLockSha/)
})

test('Pi source dependency lock pins every package to public registry bytes', () => {
  assert.equal(sourceLock.lockfileVersion, 3)
  assert.equal(sourceLock.packages[''].dependencies['@earendil-works/pi-coding-agent'], '0.85.1')
  const packages = Object.entries(sourceLock.packages).filter(([path]) => path !== '')
  assert.ok(packages.length > 0)
  for (const [path, entry] of packages) {
    assert.ok(path.startsWith('node_modules/'), `unexpected lock path: ${path}`)
    assert.match(entry.version, /^\d+\.\d+\.\d+(?:[-+].*)?$/, path)
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, path)
    const source = new URL(entry.resolved)
    assert.equal(source.protocol, 'https:', path)
    assert.equal(source.hostname, 'registry.npmjs.org', path)
    assert.equal(source.username + source.password + source.search + source.hash, '', path)
    assert.equal(entry.link, undefined, path)
  }
})

test('V2 E3 CI uploads only validated, short-lived text evidence', () => {
  assert.match(workflow, /if: success\(\)/)
  assert.doesNotMatch(workflow, /if: always\(\)/)
  assert.match(workflow, /retention-days: 3/)
  assert.match(workflow, /if-no-files-found: error/)
  assert.match(workflow, /e3-tap\.txt/)
  assert.match(workflow, /e3-manifest\.json/)
  assert.match(workflow, /Potential credential-shaped output in TAP/)
  assert.doesNotMatch(workflow, /^\s+(?:docker\s+(?:push|login)|gh\s+release|git\s+push)/m)
})

test('compiler outputs stay explicitly unaccepted and omit runtime state', () => {
  assert.match(workflow, /qualification = 'compile-only-development-candidate'/)
  assert.match(workflow, /embeddedPiIncluded = \$false/)
  assert.match(workflow, /E3 = 'NOT_RUN'/)
  assert.match(workflow, /Same-source Core\/helper binaries missing/)
  const upload = workflow.split('name: loom-v2-compile-only-windows-')[1]?.split('      - name:')[0]
  assert.ok(upload)
  for (const path of ['rovai-host.exe', 'rovai-core.exe', 'rovai.exe', 'compile-only-manifest.json', 'out/web/']) assert.ok(upload.includes(path))
  assert.doesNotMatch(upload, /(?:auth\.json|models\.json|\.env|_artifacts|userData|\.sqlite|\.db|sessions\/)/)
  assert.ok(workflow.indexOf('compile-only-development-candidate') < workflow.indexOf('Test real guarded Pi + official Host'))
})

test('complete preview is assembled after E3 without claiming real-provider or Owner acceptance', () => {
  const assembly = workflow.indexOf('name: Assemble isolated personal preview only after E3 passes')
  const acceptance = workflow.indexOf('name: Test real guarded Pi + official Host')
  assert.ok(assembly > acceptance && acceptance > 0)
  const section = workflow.slice(assembly, workflow.indexOf('name: Upload only validated candidate E3 evidence'))
  assert.match(section, /if: success\(\)/)
  assert.match(section, /package-embedded-pi\.mjs --verify --destination/)
  assert.match(section, /realProviderVerified = \$false/)
  assert.match(section, /ownerAccepted = \$false/)
  assert.match(section, /dailyDataIncluded = \$false/)
  assert.match(section, /Get-ChildItem -LiteralPath \$kit -File -Recurse -Force/)
  const launcher = readFileSync(new URL('../start-loom-personal.cmd', import.meta.url), 'utf8')
  assert.match(launcher, /setlocal EnableExtensions/)
  assert.match(launcher, /LOCALAPPDATA%\\LOOM\\personal-preview-20261116/)
  assert.match(launcher, /--data-dir "%LOOM_PREVIEW_DATA%"/)
  assert.match(launcher, /ROVAI_EMBEDDED_PI_ROOT=%~dp0runtime\\pi/)
  assert.doesNotMatch(launcher, /(?:taskkill|setx|schtasks|sc\.exe|--allow-insecure-lan)/i)
})

// The static public icon must pass the real authenticated Host boundary, not only Vite.
test('candidate CI validates real Host brand routes and retains the same-source device Node', () => {
  assert.match(workflow, /name: Test exact public brand routes over real Host HTTP/)
  assert.match(workflow, /--test-name-pattern="Desktop and Web share one Core" scripts\/lib\/host-web\.test\.mjs/)
  assert.match(workflow, /Same-source device Node missing/)
  assert.match(workflow, /target\/debug\/loom-node\.exe/)
  const assembly = workflow.slice(workflow.indexOf('name: Assemble isolated personal preview only after E3 passes'))
  assert.match(assembly, /'rovai', 'loom-node'/)
})
