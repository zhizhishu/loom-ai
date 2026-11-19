// Supervisor-owned live Host fixture. Shares the same provider/profile preparation
// as the service acceptance, but never creates or starts a Mission on behalf of the UI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { connect } from 'node:net'
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

// Preparation timing exists so one failed round can still answer "where did the
// clock stop". It records monotonic offsets, the Host pid, the isolated database
// path, the product-check request outcome and the bounded Core/extension status
// vocabulary. It never records the environment, raw transport, or any binding.
const PREPARATION_SCHEMA = 'loom-live-pi-host-preparation/1'
const STATUS_TOKEN = /^[a-z][a-z0-9_]{0,47}$/u
const CORE_CHECK_ELAPSED = /finalized with ([a-z][a-z0-9_]{0,47})\s+after (\d{1,9}) ms/u
const CORE_CHECK_KIND = /\bfor ([a-z][a-z0-9_]{0,47})\b/u
const LANE_PORT_FLOOR = 64000
const LANE_PORT_CEILING = 64999
const LIVE_SERVICE_PORTS = Object.freeze([64851, 64852])

export function resolvePinnedWebListen (config) {
  const listen = config?.webListen
  assert.equal(typeof listen, 'string', 'the lane must pin an explicit loopback Web listen address')
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(listen.trim())
  assert.ok(match, 'the pinned Web listen address must be a literal 127.0.0.1:<port>')
  const port = Number(match[1])
  assert.ok(port >= LANE_PORT_FLOOR && port <= LANE_PORT_CEILING, 'the pinned Web port must stay inside the lane range 64000-64999')
  assert.equal(LIVE_SERVICE_PORTS.includes(port), false, 'the pinned Web port must not be a live service port')
  return { listen: '127.0.0.1:' + port, port }
}

async function assertWebListenAvailable ({ port }) {
  const occupied = await new Promise((settle) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value) => { socket.destroy(); settle(value) }
    socket.setTimeout(1500, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
  assert.equal(occupied, false, 'the pinned Web port is already listening; this lane must pick another one')
}

export async function prepareLivePiHost({ configPath, providerKey, readyBudgetMs = 180000, timingsPath = null }) {
  const startedAt = new Date().toISOString()
  const originTick = process.hrtime.bigint()
  const offsetMs = () => Math.round(Number(process.hrtime.bigint() - originTick) / 1e6)
  const timing = {
    schema: PREPARATION_SCHEMA, startedAt, endedAt: null, elapsedMs: null,
    webListen: null, hostPid: null, isolatedDatabasePath: null, fixtureRoot: null, uiDirectory: null,
    phases: [], runtimeProductCheck: null, availability: [], coreCheckLines: [], flushErrors: [],
    recorded: 'monotonic offsets, host pid, isolated database path, product-check outcome, pi availability status',
    omitted: 'environment, raw transport, provider credentials, member/profile bindings'
  }
  const mark = (phase, extra = {}) => { timing.phases.push({ phase, atMs: offsetMs(), ...extra }) }
  const progress = (stage) => { mark(stage); console.log(JSON.stringify({ liveUiPreparation: stage })) }
  const flushTiming = () => {
    timing.endedAt = new Date().toISOString()
    timing.elapsedMs = offsetMs()
    if (!timingsPath) return
    try { writeFileSync(timingsPath, JSON.stringify(timing, null, 2) + '\n') }
    catch (error) { timing.flushErrors.push(String(error?.code ?? error?.message ?? error).slice(0, 120)) }
  }
  assert.equal(process.env.LOOM_ALLOW_LIVE_ACCEPTANCE, '1', 'explicit live acceptance opt-in is required')
  assert.equal(process.platform, 'win32', 'this fixture exercises native Windows Host isolation')
  assert.ok(typeof providerKey === 'string' && providerKey.length > 0, 'provider environment credential is required')
  assert.ok(typeof configPath === 'string' && configPath.length > 0, 'LOOM_UI_PUBLIC_CONFIG is required')
  const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''))
  // A pinned lane address is checked and adopted before any heavy preparation.
  // Configurations that do not pin one keep the previous ephemeral loopback bind.
  const web = config.webListen === undefined
    ? { listen: '127.0.0.1:0', port: null, pinned: false }
    : { ...resolvePinnedWebListen(config), pinned: true }
  if (web.pinned) await assertWebListenAvailable(web)
  timing.webListen = web.listen
  timing.webListenPinned = web.pinned
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
  // Outside the repository on purpose: no ancestor may carry agent instructions.
  timing.fixtureRoot = fixture
  timing.uiDirectory = uiDirectory
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
  // A native product check can take the Core's 90-second manager budget plus
  // its 3-second settlement allowance. The Host caller must outlive that
  // bounded Core result instead of reporting an earlier unknown outcome.
  ], { cwd: fixture, env, requestTimeoutMs: 120000 })
  timing.hostPid = host.child?.pid ?? null
  timing.isolatedDatabasePath = join(dataDir, 'rovai.sqlite')
  const unsubscribe = host.onNotification((message) => {
    if (message?.method !== 'runtime.availability.updated') return
    const { runtimeKind, status } = message.params ?? {}
    if (runtimeKind !== 'pi') return
    if (typeof status !== 'string' || STATUS_TOKEN.test(status) === false) return
    timing.availability.push({ atMs: offsetMs(), runtimeKind, status })
  })
  const captureCoreCheckLines = () => {
    const known = new Set(timing.coreCheckLines.map((row) => JSON.stringify(row)))
    for (const line of String(host.stderr?.() ?? '').split(/\r?\n/u)) {
      if (line.includes('Runtime check') === false) continue
      const elapsed = CORE_CHECK_ELAPSED.exec(line)
      const kind = CORE_CHECK_KIND.exec(line)
      const row = { atMs: offsetMs(), runtimeKind: kind ? kind[1] : null,
        diagnosticCode: elapsed ? elapsed[1] : null, coreElapsedMs: elapsed ? Number(elapsed[2]) : null }
      const key = JSON.stringify(row)
      if (known.has(key)) continue
      known.add(key)
      timing.coreCheckLines.push(row)
    }
  }
  try {
    progress('wait_host_ready')
    await Promise.race([host.ready, new Promise((_, reject) => {
      setTimeout(() => reject(new Error('isolated Host readiness timed out')), readyBudgetMs).unref()
    })])
    const guarded = createHostRequestGuard((method, params) => host.request(method, params))
    progress('verify_running_host_schema')
    const hostSchema = await verifyRunningHostSchema({ request: guarded.request,
      databasePath: join(dataDir, 'rovai.sqlite'), expectedProjectionSchema: config.expectedProjectionSchema,
      expectedMigrationVersion: config.expectedMigrationVersion })
    progress('runtime_product_check')
    // A `deferred` result means the search environment generation moved under the
    // attempt, so Core discarded it on purpose. A client asks again; the retry stays
    // inside the same per-attempt budgets and is never unbounded.
    const PRODUCT_CHECK_ATTEMPTS = 3
    timing.runtimeProductCheck = { attempts: [], settledAtMs: null, elapsedMs: null, outcome: null }
    let productCheck
    for (let attempt = 1; attempt <= PRODUCT_CHECK_ATTEMPTS; attempt += 1) {
      const checkStartedMs = offsetMs()
      let returned = null
      let failure = null
      try {
        returned = await guarded.request('runtime.product.check', { runtimeKind: 'pi' })
      } catch (error) {
        failure = error
      }
      const settledAtMs = offsetMs()
      const record = {
        attempt, startedAtMs: checkStartedMs, settledAtMs, elapsedMs: settledAtMs - checkStartedMs,
        outcome: failure
          ? { kind: 'unconfirmed',
              code: STATUS_TOKEN.test(String(failure?.code ?? '')) ? String(failure.code) : null,
              outcome: STATUS_TOKEN.test(String(failure?.outcome ?? '')) ? String(failure.outcome) : null,
              message: String(failure?.message ?? failure).slice(0, 240) }
          : { kind: 'returned',
              scheduled: returned?.scheduled === true,
              completed: returned?.completed === true,
              ready: returned?.ready === true,
              outcome: STATUS_TOKEN.test(String(returned?.outcome ?? '')) ? String(returned.outcome) : null,
              runtimeKind: STATUS_TOKEN.test(String(returned?.runtimeKind ?? '')) ? String(returned.runtimeKind) : null }
      }
      timing.runtimeProductCheck.attempts.push(record)
      timing.runtimeProductCheck.settledAtMs = settledAtMs
      timing.runtimeProductCheck.outcome = record.outcome
      captureCoreCheckLines()
      // Persist before any Host close, so the last observation survives.
      flushTiming()
      if (failure) throw failure
      productCheck = returned
      if (record.outcome.ready === true && record.outcome.outcome === 'ready') break
      if (record.outcome.outcome !== 'deferred') break
    }
    timing.runtimeProductCheck.elapsedMs = timing.runtimeProductCheck.settledAtMs - timing.runtimeProductCheck.attempts[0].startedAtMs
    timing.runtimeProductCheck.attemptCount = timing.runtimeProductCheck.attempts.length
    flushTiming()
    // The UI fixture used to discard this value. A ready install now has to say so
    // in the same round, or the round is not evidence of a native product check.
    assert.equal(productCheck?.scheduled, true, 'the native product check must be scheduled')
    assert.equal(productCheck?.completed, true, 'the native product check must complete inside its bounded budget')
    assert.equal(productCheck?.ready, true, 'the native product check must report ready')
    assert.equal(productCheck?.outcome, 'ready', 'the native product check outcome must be ready')
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
    const started = await host.request('host.web.start', { listen: web.listen, uiDirectory })
    assert.match(started.origin, /^http:\/\/127\.0\.0\.1:\d+$/u)
    if (web.pinned) {
      assert.equal(started.origin, 'http://' + web.listen, 'the Host must serve the pinned lane address, not an arbitrary one')
    }
    assert.match(started.administratorToken, /^[0-9a-f]{64}$/u)
    timing.webStart = { requested: web.listen, pinned: web.pinned, origin: started.origin,
      matchesPinned: web.pinned ? started.origin === 'http://' + web.listen : null }
    captureCoreCheckLines()
    flushTiming()
    return {
      host, origin: started.origin, adminToken: started.administratorToken, roles,
      facts: (operation, params = {}) => guarded.request(operation, params),
      secrets: [providerKey, started.administratorToken],
      evidence: { sourceCommit: config.sourceCommit, coreSha256: binary.sha256, hostSha256, hostSchema,
        helperSha256: helper.sha256, piVersion: piBundle.piVersion, fixture, dataDir,
        skillRoot, mcpPath, uiDirectory, isolatedProfile: agentDir,
        missionCreatedBySetup: false, modelStartedBySetup: false, nativePiMode: true,
        dailyDatabaseTouched: false, globalSettingsChanged: false,
        preparationTimings: timingsPath }
    }
  } catch (error) {
    timing.error = {
      name: STATUS_TOKEN.test(String(error?.name ?? '')) ? String(error.name) : null,
      code: STATUS_TOKEN.test(String(error?.code ?? '')) ? String(error.code) : null,
      stage: typeof error?.stage === 'string' ? error.stage.slice(0, 40) : null,
      message: String(error?.message ?? error).slice(0, 240)
    }
    captureCoreCheckLines()
    // Write the failure observation first: close() removes the only other witness.
    flushTiming()
    try { unsubscribe() } catch {}
    await host.close().catch(() => {})
    throw error
  }
}
