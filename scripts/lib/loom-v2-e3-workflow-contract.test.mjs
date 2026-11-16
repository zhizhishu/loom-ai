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
  assert.match(workflow, /cargo build --locked -p rovai-host -p loom-pi-launcher --bins --jobs 2/)
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
