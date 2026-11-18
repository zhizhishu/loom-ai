// Supervisor-owned live Host fixture. Shares the same provider/profile preparation
// as the service acceptance, but never creates or starts a Mission on behalf of the UI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { launchHost } from './host-test-client.mjs'
import { verifyRunningHostSchema } from './loom-host-schema.mjs'
import { coreDataDirectoryArguments } from './runtime-camp-files-root.mjs'
import {
  buildIsolatedEnvironment, writeIsolatedPiProfile, createMembers,
  configureRuntime, waitForManagedPiInstallation, resolveGitBash,
  createHostRequestGuard
} from '../accept-loom-live-lead.mjs'
import { verifyCoreBinary, resolveBuiltinToolHelper, readPiBundleManifest } from '../loom-v2-core-native-pi.mjs'

export async function prepareLivePiHost({ configPath, providerKey, readyBudgetMs = 180000 }) {
  const progress = (stage) => console.log(JSON.stringify({ liveUiPreparation: stage }))
  assert.equal(process.env.LOOM_ALLOW_LIVE_ACCEPTANCE, '1', 'explicit live acceptance opt-in is required')
  assert.equal(process.platform, 'win32', 'this fixture exercises native Windows Host isolation')
  assert.ok(typeof providerKey === 'string' && providerKey.length > 0, 'provider environment credential is required')
  assert.ok(typeof configPath === 'string' && configPath.length > 0, 'LOOM_UI_PUBLIC_CONFIG is required')
  const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''))
  progress('verify_candidate_bytes')
  const endpoint = new URL(config.provider.baseUrl)
  assert.equal(`${endpoint.username}${endpoint.password}${endpoint.search}${endpoint.hash}`, '', 'provider origin must not embed credentials')
  assert.match(config.sourceCommit, /^[0-9a-f]{40}$/u, 'source commit must be pinned')
  assert.match(config.hostExpectedSha256, /^[0-9a-f]{64}$/u, 'the same-source Host hash must be explicitly pinned')
  const binary = await verifyCoreBinary({ coreBinaryPath: config.coreBinaryPath, coreExpectedSha256: config.coreExpectedSha256 })
  const helper = await resolveBuiltinToolHelper({ coreBinaryPath: binary.path })
  const hostPath = resolve(config.hostBinaryPath ?? join(dirname(binary.path), 'rovai-host.exe'))
  const hostSha256 = createHash('sha256').update(await readFile(hostPath)).digest('hex')
  assert.equal(hostSha256, config.hostExpectedSha256, 'Host bytes differ from the verified candidate')
  const uiDirectory = resolve(config.uiDirectory ?? join(dirname(hostPath), 'web-ui'))
  assert.ok(existsSync(join(uiDirectory, 'index.html')), 'the same-source production Web bundle is required')
  const piBundle = await readPiBundleManifest(config.piRoot)
  const gitBash = resolveGitBash({ explicitPath: config.gitBash ?? null })
  assert.ok(gitBash.path, 'native Pi requires the explicitly selected Git Bash')
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'loom-live-ui-')))
  for (let path = fixture; ; path = dirname(path)) {
    assert.ok(!existsSync(join(path, '.git')), 'live fixture must not inherit repository instructions')
    if (dirname(path) === path) break
  }
  const agentDir = join(fixture, 'pi-agent')
  const home = join(fixture, 'home')
  for (const path of [home, join(fixture, 'tmp'), agentDir]) await mkdir(path, { recursive: true })
  await writeIsolatedPiProfile({ agentDir, config, gitBash })
  const env = buildIsolatedEnvironment({ fixtureRoot: fixture, agentDir, piBundle, gitBash, providerKey })
  const dataDir = JSON.parse(execFileSync(binary.path,
    ['--prepare-windows-data-root', join(fixture, 'formal')],
    { encoding: 'utf8', env, timeout: 120000 })).core
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  const host = launchHost(hostPath, [
    ...coreDataDirectoryArguments(dataDir, { homeDirectory: home }),
    '--skill-library-root', skillRoot, '--mcp-config-path', mcpPath
  ], { cwd: fixture, env, requestTimeoutMs: 90000 })
  try {
    progress('wait_host_ready')
    await Promise.race([host.ready, new Promise((_, reject) => {
      setTimeout(() => reject(new Error('isolated Host readiness timed out')), readyBudgetMs).unref()
    })])
    const guarded = createHostRequestGuard((method, params) => host.request(method, params))
    progress('verify_running_host_schema')
    const hostSchema = await verifyRunningHostSchema({ request: guarded.request,
      databasePath: join(dataDir, 'rovai.sqlite'), expectedProjectionSchema: config.expectedProjectionSchema })
    progress('runtime_product_check')
    await guarded.request('runtime.product.check', { runtimeKind: 'pi' })
    const installation = await waitForManagedPiInstallation(guarded, piBundle.launcher)
    progress('seed_four_members')
    const existing = await guarded.request('members.list')
    assert.ok(Array.isArray(existing), 'initial member roster must be readable')
    const seeded = await createMembers(guarded, existing.map(member => member.agentId))
    const roles = {}
    for (const [role, seededKey] of Object.entries({ lead: 'lead', workerA: 'worker-a', workerB: 'worker-b', reviewer: 'reviewer' })) {
      const member = seeded[seededKey]
      progress(`configure_${role}`)
      await configureRuntime(guarded, member.agentId, installation)
      const after = await guarded.request('members.get', { agentId: member.agentId })
      assert.ok(typeof after.displayName === 'string' && after.displayName.length > 0)
      roles[role] = { agentId: member.agentId, displayName: after.displayName }
    }
    progress('start_isolated_web')
    const started = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory })
    assert.match(started.origin, /^http:\/\/127\.0\.0\.1:\d+$/u)
    assert.match(started.administratorToken, /^[0-9a-f]{64}$/u)
    return {
      host, origin: started.origin, adminToken: started.administratorToken, roles,
      facts: (operation, params = {}) => guarded.request(operation, params),
      secrets: [providerKey, started.administratorToken],
      evidence: { sourceCommit: config.sourceCommit, coreSha256: binary.sha256, hostSha256, hostSchema,
        helperSha256: helper.sha256, piVersion: piBundle.piVersion, fixture, dataDir,
        skillRoot, mcpPath, uiDirectory, isolatedProfile: agentDir,
        missionCreatedBySetup: false, modelStartedBySetup: false, nativePiMode: true,
        dailyDatabaseTouched: false, globalSettingsChanged: false }
    }
  } catch (error) {
    await host.close().catch(() => {})
    throw error
  }
}
