import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repo = new URL('../../', import.meta.url)
const read = relative => readFileSync(fileURLToPath(new URL(relative, repo)), 'utf8').replace(/\r\n/g, '\n')

const workflow = read('.github/workflows/loom-v2-container.yml')
const dockerfile = read('docker/Dockerfile')
const entrypoint = read('docker/entrypoint.sh')
const dockerignore = read('.dockerignore')
const readme = read('docker/README.md')

// This suite is a static contract only: it needs no Docker daemon, no network
// and no Server binary, so it can run before any build work is spent.

test('the container workflow registers only dispatch plus the one candidate branch', () => {
  assert.match(workflow, /^on:\s*$/m)
  assert.match(workflow, /^  workflow_dispatch:\s*$/m)
  assert.match(workflow, /^  push:\s*$/m)
  assert.match(workflow, /^      - rovai\/loom-v2-personal-20261116\s*$/m, 'push must name the exact candidate branch')
  assert.match(workflow, /^    paths:\s*$/m)
  for (const path of ['docker/**', '.github/workflows/loom-v2-container.yml', 'scripts/lib/loom-container-contract.test.mjs']) {
    assert.ok(workflow.includes(`      - ${path}`), `push paths must include ${path}`)
  }
  assert.doesNotMatch(workflow, /^  (?:pull_request|pull_request_target|pull_request_review|merge_group|schedule|release|workflow_run|repository_dispatch|issues):/m)
  assert.match(workflow, /LOOM_ALLOWED_REF: refs\/heads\/rovai\/loom-v2-personal-20261116/)
  assert.match(workflow, /if: github\.ref != env\.LOOM_ALLOWED_REF/)
})

test('the container workflow cannot release, merge or widen repository access', () => {
  assert.match(workflow, /^permissions:\s*\n  contents: read\s*$/m)
  assert.match(workflow, /^    permissions:\s*\n      contents: read\n      packages: write\s*$/m)
  assert.doesNotMatch(workflow, /contents: write/)
  assert.doesNotMatch(workflow, /gh release|--draft|release-tag\.txt|server-channel\.txt|git push|git merge/)
  assert.doesNotMatch(workflow, /secrets\./)
  assert.match(workflow, /GHCR_TOKEN: \$\{\{ github\.token \}\}/)
  assert.match(workflow, /docker login ghcr\.io --username "\$\{\{ github\.actor \}\}" --password-stdin/)
  for (const line of workflow.split(/\r?\n/).filter(line => /\buses:/.test(line))) {
    assert.match(line.trim(), /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+$/, line)
  }
})

test('the container workflow pins the toolchain and builds the debug candidate only', () => {
  assert.match(workflow, /runs-on: ubuntu-22\.04/)
  assert.match(workflow, /LOOM_RUST_VERSION: 1\.97\.1/)
  assert.match(workflow, /LOOM_NODE_VERSION: 24\.14\.1/)
  assert.match(workflow, /LOOM_PNPM_VERSION: 11\.20\.0/)
  assert.match(workflow, /^          version: 11\.20\.0$/m)
  assert.match(workflow, /rustup toolchain install "\$LOOM_RUST_VERSION" --profile minimal/)
  assert.match(workflow, /node-version: \$\{\{ env\.LOOM_NODE_VERSION \}\}/)
  assert.match(workflow, /node scripts\/build-server\.mjs --target-key linux-x64 --debug/)
  assert.doesNotMatch(workflow, /--release/)
  assert.match(workflow, /manifest\.profile !== "debug"/)
  assert.match(workflow, /manifest\.dirty !== false/)
})

test('the candidate tag is commit-addressed, immutable and never latest', () => {
  assert.doesNotMatch(workflow, /:latest/)
  assert.match(workflow, /tag="sha-\$GITHUB_SHA"/)
  assert.match(workflow, /docker manifest inspect "\$LOOM_IMAGE:\$tag"/)
  assert.match(workflow, /candidate tags are immutable and are never overwritten/)
  assert.match(workflow, /if existing=\$\(docker manifest inspect/)
  assert.match(workflow, /manifest\\ unknown\*\|\*no\\ such\\ manifest/)
  assert.match(workflow, /Registry response did not prove tag absence/)
  assert.match(workflow, /LOOM_PUSHED_DIGEST=\$digest/)
})

test('the base image is resolved to a digest and recorded with the source commit', () => {
  assert.match(dockerfile, /^ARG BASE_IMAGE=ubuntu:22\.04$/m)
  assert.match(workflow, /docker inspect --format '\{\{index \.RepoDigests 0\}\}' ubuntu:22\.04/)
  assert.match(workflow, /ubuntu@sha256:\*/)
  assert.match(workflow, /--build-arg BASE_IMAGE="\$LOOM_BASE_IMAGE"/)
  assert.match(workflow, /--build-arg SOURCE_COMMIT="\$GITHUB_SHA"/)
  assert.match(workflow, /baseImage: process\.env\.LOOM_BASE_IMAGE/)
  assert.match(workflow, /sourceCommit: process\.env\.GITHUB_SHA/)
})

test('every gate runs before the push step', () => {
  const order = [
    'node --test scripts/lib/loom-container-contract.test.mjs',
    'node scripts/build-server.mjs --target-key linux-x64 --debug',
    'Refuse a dirty or mismatched package manifest',
    'node --test --test-concurrency=1 scripts/lib/host-lifecycle.test.mjs',
    'scripts/lib/server-install.test.mjs',
    'Run the repository Gate A smoke as uid 10001 inside the image',
    'Assert the runtime image is unprivileged, toolchain-free and Pi-free',
    'SIGTERM stop exited',
    'docker manifest inspect "$LOOM_IMAGE:$tag"',
    'docker push "$LOOM_IMAGE:$tag"'
  ]
  let previous = -1
  for (const marker of order) {
    const index = workflow.indexOf(marker)
    assert.ok(index > previous, `${marker} must appear after the previous gate`)
    previous = index
  }
})

test('the Dockerfile ships an unprivileged Host+Web runtime with no toolchain', () => {
  assert.match(dockerfile, /^FROM \$\{BASE_IMAGE\} AS runtime$/m)
  assert.match(dockerfile, /^FROM runtime AS verify$/m)
  assert.match(dockerfile, /--uid 10001/)
  assert.match(dockerfile, /^USER 10001:10001$/m)
  assert.match(dockerfile, /^EXPOSE 8767$/m)
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m)
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/loom-entrypoint"\]$/m)
  assert.match(dockerfile, /^ENV HOME=\/home\/loom \\$/m)
  assert.match(dockerfile, /^VOLUME \["\/data"\]$/m)
  assert.match(dockerfile, /dev\.loom\.bundle\.pi="absent"/)
  assert.match(dockerfile, /dev\.loom\.build\.profile="\$\{BUILD_PROFILE\}"/)
  assert.match(dockerfile, /! command -v node/)
  assert.doesNotMatch(dockerfile, /apt-get install[^\n]*\bnode(js)?\b/)
  assert.doesNotMatch(dockerfile, /:latest/)
  // python3 exists only in the verification stage.
  const [runtimeStage, verifyStage] = dockerfile.split('FROM runtime AS verify')
  assert.doesNotMatch(runtimeStage, /python3/)
  assert.match(verifyStage, /python3/)
})

test('Dockerfile COPY sources match the workflow staging directory exactly', () => {
  const copies = [...dockerfile.matchAll(/^COPY --chown=root:root (\S+) (\S+)$/gm)].map(match => match[1])
  assert.deepEqual(copies.sort(), ['entrypoint.sh', 'package/', 'smoke-linux-server.py'])
  assert.match(workflow, /cp -a out\/server\/linux-x64 "\$ctx\/package"/)
  assert.match(workflow, /cp docker\/Dockerfile "\$ctx\/Dockerfile"/)
  assert.match(workflow, /cp docker\/entrypoint\.sh "\$ctx\/entrypoint\.sh"/)
  assert.match(workflow, /cp scripts\/smoke-linux-server\.py "\$ctx\/smoke-linux-server\.py"/)
  assert.match(workflow, /-f "\$ctx\/Dockerfile" "\$ctx"/)
  // No checkout, .git or credential may be staged into the build context.
  assert.match(workflow, /staged context contains \$unwanted/)
  assert.doesNotMatch(workflow, /cp -a \. "\$ctx/)
})

test('the entrypoint execs the native Server and refuses implicit credentials', () => {
  assert.match(entrypoint, /^set -eu$/m)
  assert.match(entrypoint, /^umask 077$/m)
  assert.match(entrypoint, /program=\/opt\/rovai\/rovai-server/)
  assert.match(entrypoint, /exec "\$program" "\$@"/)
  assert.match(entrypoint, /refusing \$name: this image has no automatic authentication/)
  assert.match(entrypoint, /ROVAI_TOKEN ROVAI_SERVER_TOKEN ROVAI_WEB_TOKEN ADMIN_TOKEN/)
  assert.match(entrypoint, /--allow-insecure-lan/)
  assert.match(entrypoint, /localhost\|127\.\*\|::1/)
  // The token must never be echoed or defaulted anywhere in the entrypoint.
  assert.doesNotMatch(entrypoint, /echo[^\n]*token/i)
  assert.doesNotMatch(entrypoint, /TOKEN=\S/)
})

test('the container acceptance publishes the same port the Server listens on', () => {
  // rovai-web allows only its own displayed origins (Host + Origin must match the
  // listen port), so a translated host port would fail closed with 403 instead of
  // the 200/401 results this gate asserts.
  assert.match(workflow, /^  LOOM_SMOKE_PORT: '8767'$/m)
  assert.match(workflow, /-p "127\.0\.0\.1:\$\{LOOM_SMOKE_PORT\}:8767"/)
  assert.match(workflow, /origin="http:\/\/127\.0\.0\.1:\$\{LOOM_SMOKE_PORT\}"/)
  assert.match(workflow, /origin_not_allowed/)
})

test('the shipped image declares its non-claims, including Pi', () => {
  assert.match(readme, /NOT bundled/i)
  assert.match(readme, /Pi runtime is NOT bundled/)
  assert.match(readme, /no automatic authentication|No automatic authentication/)
  assert.match(readme, /127\.0\.0\.1:\d+:8767/)
  assert.match(readme, /candidate/i)
})

test('the repository-level dockerignore excludes everything by default', () => {
  const patterns = dockerignore.split(/\r?\n/).filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
  assert.equal(patterns[0], '*', 'the first pattern must exclude everything')
  for (const forbidden of ['.git', '_artifacts', 'root_artifacts', 'node_modules', 'target']) {
    assert.doesNotMatch(dockerignore, new RegExp(`^!${forbidden}`, 'm'), `${forbidden} must never be re-included`)
  }
})


test('native package smoke preserves release default and explicitly labels debug acceptance', () => {
  const smoke = read('scripts/smoke-linux-server.py')
  assert.match(smoke, /--expected-profile.*choices=\('release', 'debug'\), default='release'/)
  assert.match(smoke, /manifest\['profile'\] == args.expected_profile/)
  assert.match(smoke, /'releaseProfileVerified': manifest\['profile'\] == 'release'/)
  assert.match(workflow, /--expected-profile debug/)
})
