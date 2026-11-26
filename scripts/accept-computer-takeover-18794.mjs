// Prepare and run the 18794 Xvfb takeover acceptance against one isolated local Host.
// The script owns every process it starts and refuses to use an already-listening 18794.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  digestOf,
  login as hostLogin,
  pause,
  request as hostRequest,
  startXvfb,
  waitForDisplay,
  workbench
} from './lib/loom-computer-node-live.mjs'

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.LOOM_TAKEOVER_PORT ?? 18_794)
const ORIGIN = `http://127.0.0.1:${PORT}`
const ARTIFACTS = resolve(process.env.LOOM_TAKEOVER_ARTIFACTS ?? '/bundles/out/_artifacts/computer-takeover-18794')
const FULL_EXPIRY = process.env.LOOM_TAKEOVER_FULL_EXPIRY !== '0'
const ACCEPT_LEGACY_REFUSAL = process.env.LOOM_TAKEOVER_ACCEPT_LEGACY_REFUSAL === '1'
const CLICK_X = Number(process.env.LOOM_TAKEOVER_CLICK_X ?? 100)
const CLICK_Y = Number(process.env.LOOM_TAKEOVER_CLICK_Y ?? 100)

const report = {
  scope: 'computer-takeover-xvfb-18794',
  origin: ORIGIN,
  fullExpiry: FULL_EXPIRY,
  steps: {},
  screenshots: {},
  status: 'running'
}
const children = []
let outDir = null

function remember (child) {
  children.push(child)
  return child
}

async function cleanup () {
  while (children.length) {
    const child = children.pop()
    try { await child.stop?.() } catch { /* already stopped */ }
    try { child.kill?.('SIGKILL') } catch { /* already stopped */ }
  }
}

function saveReport () {
  if (!outDir) return
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

function record (name, value) {
  report.steps[name] = value
  saveReport()
}

async function portFree () {
  try {
    await fetch(ORIGIN, { signal: AbortSignal.timeout(1_000) })
    return false
  } catch {
    return true
  }
}

async function waitForHttp (budgetMs = 45_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ORIGIN, { signal: AbortSignal.timeout(2_000) })
      if (response.status === 200) return
    } catch { /* not up yet */ }
    await pause(400)
  }
  throw new Error(`isolated Host did not answer on ${ORIGIN}`)
}

async function waitForFile (path, budgetMs = 8_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim() !== '') return readFileSync(path, 'utf8').trim()
    await pause(150)
  }
  throw new Error(`click receipt did not appear at ${path}`)
}

async function framePng (session, viewId, path) {
  const response = await fetch(`${ORIGIN}/api/v1/computer/frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: JSON.stringify({ viewId, consent: true }),
    signal: AbortSignal.timeout(20_000)
  })
  assert.equal(response.ok, true, `frame failed: ${response.status}`)
  const png = Buffer.from(await response.arrayBuffer())
  writeFileSync(path, png)
  return { bytes: png.length, sha256: digestOf(png) }
}

async function humanInput (session, control, seq, event) {
  return workbench({
    origin: ORIGIN,
    session,
    path: '/computer/input',
    body: {
      viewId: control.viewId,
      controlId: control.controlId,
      generation: control.generation,
      seq,
      consent: true,
      event
    }
  })
}

function readGrantBridge (definitionJson) {
  const definition = JSON.parse(definitionJson)
  const name = Object.keys(definition.mcpServers ?? {})[0]
  const env = definition.mcpServers?.[name]?.env ?? {}
  for (const key of ['LOOM_COMPUTER_AGENT_ENDPOINT', 'LOOM_COMPUTER_AGENT_ORIGIN', 'LOOM_COMPUTER_AGENT_TOKEN_FILE', 'LOOM_COMPUTER_AGENT_DIGEST']) {
    assert.equal(typeof env[key], 'string', `grant bridge is missing ${key}`)
  }
  return env
}

async function workbenchResult (session, path, body = {}) {
  try {
    return { ok: true, payload: await workbench({ origin: ORIGIN, session, path, body }) }
  } catch (error) {
    return { ok: false, error, code: error?.code ?? null, status: error?.status ?? null }
  }
}

async function agentRpc (bridge, requestId, tool, argumentsValue = {}) {
  const token = readFileSync(bridge.LOOM_COMPUTER_AGENT_TOKEN_FILE, 'utf8').trim()
  const response = await fetch(bridge.LOOM_COMPUTER_AGENT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: bridge.LOOM_COMPUTER_AGENT_ORIGIN
    },
    body: JSON.stringify({
      requestId,
      tool,
      expectedConfigDigest: bridge.LOOM_COMPUTER_AGENT_DIGEST,
      arguments: argumentsValue
    }),
    // Backend approval wait can occupy almost the whole five-minute grant.
    signal: AbortSignal.timeout(330_000)
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload, code: payload?.error?.code ?? null, ok: payload?.ok === true }
}

async function ensurePiMember (session) {
  const members = await hostRequest({ origin: ORIGIN, session, operation: 'members.list' })
  const roster = Array.isArray(members) ? members : (members?.members ?? [])
  const member = roster.find(entry => !entry.removedAt)
  assert.ok(member, 'isolated Host has no assistant member')
  const installations = await hostRequest({ origin: ORIGIN, session, operation: 'runtime.installations.list' })
  const piInstallation = (Array.isArray(installations) ? installations : []).find(entry => entry.adapterKind === 'pi')
  assert.ok(piInstallation?.memberRuntimeDefaults, 'Host exposes no Pi installation defaults')
  if ((member.runtimeConfiguration?.adapterKind ?? null) !== 'pi') {
    const before = await hostRequest({ origin: ORIGIN, session, operation: 'members.get', params: { agentId: member.agentId } })
    const applied = await hostRequest({
      origin: ORIGIN,
      session,
      operation: 'members.runtime.set',
      params: {
        commandId: randomUUID(),
        command: {
          agentId: member.agentId,
          expectedVersion: before.version,
          adapterKind: 'pi',
          model: { ...piInstallation.memberRuntimeDefaults.model, options: { thinking_level: 'max' } },
          permissions: piInstallation.memberRuntimeDefaults.permissions
        }
      }
    })
    assert.equal(applied?.status, 'applied', `Pi runtime was not applied: ${JSON.stringify(applied)}`)
  }
  return member
}

async function acquireControl (session, deviceId, viewId) {
  return workbench({
    origin: ORIGIN,
    session,
    path: '/computer/control',
    body: { viewId, deviceId, consent: true, ttlSeconds: 30 }
  })
}

async function run () {
  assert.equal(await portFree(), true, `port ${PORT} is already listening; refusing to borrow another process`)
  mkdirSync(ARTIFACTS, { recursive: true })
  outDir = join(ARTIFACTS, `run-${new Date().toISOString().replaceAll(':', '-')}`)
  mkdirSync(outDir, { recursive: true })
  copyFileSync(fileURLToPath(import.meta.url), join(outDir, 'accept-computer-takeover-18794.mjs'))
  saveReport()

  const serverBinary = process.env.ROVAI_SERVER_BIN ?? join(REPOSITORY, 'target/debug/rovai-server')
  const webUi = process.env.ROVAI_WEB_UI ?? join(REPOSITORY, 'out/web')
  const helper = join(REPOSITORY, 'resources/computer/host_desktop.py')
  const bridgeScript = join(REPOSITORY, 'resources/computer/mcp_bridge.py')
  for (const [label, path] of [['rovai-server', serverBinary], ['WebUI index', join(webUi, 'index.html')], ['desktop helper', helper], ['agent bridge', bridgeScript]]) {
    assert.equal(existsSync(path), true, `${label} missing at ${path}`)
  }
  const base = await mkdtemp(join(tmpdir(), 'loom-takeover-18794-'))
  const serverData = join(base, 'server-data')
  const desktop = join(base, 'desktop')
  mkdirSync(serverData, { recursive: true })
  mkdirSync(desktop, { recursive: true })

  let xvfb = null
  for (let displayNumber = 94; displayNumber <= 99; displayNumber += 1) {
    const candidate = startXvfb({ displayNumber, logPath: join(outDir, 'xvfb.log') })
    try {
      await waitForDisplay({ display: candidate.display, budgetMs: 8_000 })
      xvfb = remember(candidate)
      break
    } catch {
      await candidate.stop()
    }
  }
  assert.ok(xvfb, 'no private Xvfb display started')
  record('xvfb', { display: xvfb.display })

  const mouseScript = join(desktop, 'mouse-listener.py')
  const clickReceipt = join(desktop, 'click-receipt.txt')
  writeFileSync(mouseScript, `import os,sys,termios,tty\nout=sys.argv[1]\nsys.stdout.write('\\x1b[?1000h')\nsys.stdout.flush()\nfd=sys.stdin.fileno()\nold=termios.tcgetattr(fd)\ntty.setraw(fd)\ntry:\n    while True:\n        data=os.read(fd,6)\n        if len(data)>=6 and data[:3]==b'\\x1b[M':\n            open(out,'w').write('button=%d,col=%d,row=%d' % (data[3]-32,data[4]-32,data[5]-32))\n            break\nfinally:\n    termios.tcsetattr(fd,termios.TCSADRAIN,old)\n`)
  const target = remember(spawn('xterm', ['-geometry', '120x40+0+0', '-T', 'LOOM TAKEOVER CLICK TARGET', '-e', '/usr/bin/python3', mouseScript, clickReceipt], {
    env: { ...process.env, DISPLAY: xvfb.display },
    stdio: ['ignore', 'ignore', 'pipe']
  }))
  record('clickTarget', { xtermPid: target.pid, clickX: CLICK_X, clickY: CLICK_Y })
  await pause(1_500)

  const host = remember(spawn(serverBinary, ['--data-dir', serverData, '--listen', `127.0.0.1:${PORT}`, '--web-ui', webUi], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DISPLAY: xvfb.display,
      LOOM_COMPUTER_HELPER: helper,
      LOOM_COMPUTER_PYTHON: '/usr/bin/python3',
      LOOM_COMPUTER_AGENT_PI_MCP: '1',
      LOOM_COMPUTER_AGENT_PYTHON: '/usr/bin/python3',
      LOOM_COMPUTER_AGENT_BRIDGE: bridgeScript
    }
  }))
  let hostLog = ''
  host.stdout.on('data', chunk => { hostLog = `${hostLog}${chunk}`.slice(-20_000) })
  host.stderr.on('data', chunk => { hostLog = `${hostLog}${chunk}`.slice(-20_000) })
  await waitForHttp()
  writeFileSync(join(outDir, 'host.log'), hostLog)
  const administratorToken = execFileSync(serverBinary, ['--data-dir', serverData, 'token'], { encoding: 'utf8' }).trim()
  const session = await hostLogin({ origin: ORIGIN, administratorToken })
  record('host', { origin: ORIGIN, serverData })

  const status = await workbench({ origin: ORIGIN, session, path: '/computer/status', body: {} })
  assert.equal(status.ready, true, `computer provider is not ready: ${status.reason ?? 'unknown'}`)
  const deviceId = status.device.deviceId
  record('device', { deviceIdPrefix: deviceId.slice(0, 20), platform: status.device.platform, bounds: status.device.bounds })

  const view = await workbench({ origin: ORIGIN, session, path: '/computer/view', body: { deviceId, consent: true } })
  await pause(500)
  const before = await framePng(session, view.viewId, join(outDir, 'xvfb-before.png'))
  assert.ok(before.bytes > 1_000, `screenshot is empty or too small: ${before.bytes}`)
  report.screenshots.before = before
  saveReport()

  const member = await ensurePiMember(session)
  const mcpConfig = await hostRequest({ origin: ORIGIN, session, operation: 'mcp.config.get' })
  const grant = await workbench({
    origin: ORIGIN,
    session,
    path: '/computer/agents/grant',
    body: {
      assistantId: member.agentId,
      deviceId,
      scope: 'control',
      expectedConfigDigest: mcpConfig.configDigest,
      ttlSeconds: 300,
      consent: true
    }
  })
  assert.equal(grant.state, 'active', `assistant grant is not active: ${JSON.stringify(grant)}`)
  // Creating the grant itself mutates the MCP config, so reveal must use the post-grant digest.
  const grantedConfig = await hostRequest({ origin: ORIGIN, session, operation: 'mcp.config.get' })
  const reveal = await hostRequest({ origin: ORIGIN, session, operation: 'mcp.servers.reveal', params: { serverId: grant.serverId, expectedConfigDigest: grantedConfig.configDigest } })
  assert.equal(reveal?.status, 'ok', `grant MCP definition was not revealed: ${JSON.stringify(reveal)}`)
  const bridge = readGrantBridge(reveal.definitionJson)
  record('assistantGrant', { grantId: grant.grantId, assistantId: member.agentId, serverId: grant.serverId })

  const modeProbe = await workbenchResult(session, '/computer/agents/mode/status', { assistantId: member.agentId })
  if (modeProbe.ok) {
    const mode = await workbench({ origin: ORIGIN, session, path: '/computer/agents/mode', body: { assistantId: member.agentId, mode: 'ask' } })
    assert.equal(mode.mode, 'ask', `assistant mode was not set to ask: ${JSON.stringify(mode)}`)
    const pendingCall = agentRpc(bridge, `approval-${randomUUID()}`, 'mouse_click', { x: CLICK_X, y: CLICK_Y, button: 'left' })
    let approval = null
    const approvalDeadline = Date.now() + 45_000
    while (Date.now() < approvalDeadline && approval === null) {
      const listed = await workbench({ origin: ORIGIN, session, path: '/computer/agents/approvals/list', body: { assistantId: member.agentId } })
      approval = (listed.items ?? []).find(item => item.assistantId === member.agentId && item.status === 'pending') ?? null
      if (!approval) await pause(500)
    }
    assert.ok(approval, 'ask mode did not queue the assistant mouse click for approval')
    const decided = await workbench({ origin: ORIGIN, session, path: '/computer/agents/approvals/decide', body: { approvalId: approval.approvalId, decision: 'approve' } })
    assert.equal(decided.status, 'approved', `approval decision was not approved: ${JSON.stringify(decided)}`)
    const approvedCall = await pendingCall
    assert.equal(approvedCall.ok, true, `approved assistant input did not execute: ${JSON.stringify(approvedCall.payload)}`)
    record('askApproval', { approvalId: approval.approvalId, tool: approval.tool, status: decided.status })
    rmSync(clickReceipt, { force: true })
  } else {
    record('askApproval', { skipped: true, reason: 'backend mode/approval routes unavailable', status: modeProbe.status, code: modeProbe.code })
  }

  const control = await acquireControl(session, deviceId, view.viewId)
  assert.equal(control.viewId, view.viewId, 'control lease does not belong to the active view')
  assert.ok(control.totalDeadline - control.serverTime <= 300_000, 'takeover total deadline exceeds five minutes')
  assert.ok(control.totalDeadline - control.serverTime > 290_000, 'takeover total deadline is not approximately five minutes')
  record('takeover', { controlId: control.controlId, generation: control.generation, totalDeadlineMs: control.totalDeadline - control.serverTime })

  const clickResult = await humanInput(session, control, 1, { kind: 'pointer', x: CLICK_X, y: CLICK_Y, button: 'left', action: 'click' })
  assert.equal(clickResult.applied, true, `human click was not applied: ${JSON.stringify(clickResult)}`)
  const receipt = await waitForFile(clickReceipt)
  const receiptMatch = /^button=(\d+),col=(\d+),row=(\d+)$/u.exec(receipt)
  assert.ok(receiptMatch, `click receipt has unexpected shape: ${receipt}`)
  assert.equal(Number(receiptMatch[1]), 0, `click receipt is not a left button: ${receipt}`)
  assert.ok(Number(receiptMatch[2]) >= 1 && Number(receiptMatch[2]) <= 80, `click column is outside the xterm: ${receipt}`)
  assert.ok(Number(receiptMatch[3]) >= 1 && Number(receiptMatch[3]) <= 24, `click row is outside the xterm: ${receipt}`)
  record('humanClick', { seq: clickResult.seq, receipt })

  const rejected = await agentRpc(bridge, `reject-${randomUUID()}`, 'mouse_click', { x: CLICK_X, y: CLICK_Y, button: 'left' })
  assert.equal(rejected.ok, false, `assistant input unexpectedly succeeded during human takeover: ${JSON.stringify(rejected.payload)}`)
  const refusalCodes = ACCEPT_LEGACY_REFUSAL ? ['computer_agent_human_control', 'computer_agent_control_held'] : ['computer_agent_human_control']
  assert.ok(refusalCodes.includes(rejected.code), `assistant input refusal code mismatch: ${rejected.code} (${rejected.status})`)
  record('assistantRejectedDuringTakeover', { status: rejected.status, code: rejected.code, legacyAccepted: rejected.code !== 'computer_agent_human_control' })

  const released = await workbench({
    origin: ORIGIN,
    session,
    path: '/computer/control/release',
    body: { viewId: view.viewId, controlId: control.controlId, generation: control.generation }
  })
  assert.equal(released.released, true, `release did not release: ${JSON.stringify(released)}`)
  record('release', { confirmed: released.confirmed === true, generation: released.generation })

  const restored = await agentRpc(bridge, `restore-${randomUUID()}`, 'mouse_click', { x: CLICK_X, y: CLICK_Y, button: 'left' })
  assert.equal(restored.ok, true, `assistant input did not recover after release: ${JSON.stringify(restored.payload)}`)
  record('assistantRestoredAfterRelease', { status: restored.status, ok: restored.ok })

  await workbench({ origin: ORIGIN, session, path: '/computer/view/stop', body: { viewId: view.viewId } })
  const expiryView = await workbench({ origin: ORIGIN, session, path: '/computer/view', body: { deviceId, consent: true } })
  const second = await acquireControl(session, deviceId, expiryView.viewId)
  const expiryStarted = Date.now()
  let expiryError = null
  if (FULL_EXPIRY) {
    for (;;) {
      await pause(4_000)
      try {
        await workbench({
          origin: ORIGIN,
          session,
          path: '/computer/control/heartbeat',
          body: { viewId: expiryView.viewId, controlId: second.controlId, generation: second.generation, consent: true }
        })
      } catch (error) {
        expiryError = error
        break
      }
      if (Date.now() - expiryStarted > 330_000) throw new Error('takeover lease survived past the five-minute deadline')
    }
  } else {
    await pause(16_000)
    try {
      await workbench({
        origin: ORIGIN,
        session,
        path: '/computer/input',
        body: { viewId: expiryView.viewId, controlId: second.controlId, generation: second.generation, seq: 1, consent: true, event: { kind: 'pointer', x: CLICK_X, y: CLICK_Y, button: 'left', action: 'click' } }
      })
    } catch (error) {
      expiryError = error
    }
    assert.ok(expiryError, 'quick expiry probe input unexpectedly succeeded')
  }
  assert.ok(expiryError, 'expiring takeover did not refuse further control')
  record('expiryStop', { mode: FULL_EXPIRY ? 'five-minute-heartbeat' : 'quick-idle-deadman', code: expiryError.code ?? null, waitedMs: Date.now() - expiryStarted })

  const after = await framePng(session, expiryView.viewId, join(outDir, 'xvfb-after.png'))
  assert.ok(after.bytes > 1_000, `post-run screenshot is empty or too small: ${after.bytes}`)
  report.screenshots.after = after
  report.status = 'passed'
  saveReport()
}

try {
  await run()
} catch (error) {
  report.status = 'failed'
  report.failure = { message: error?.message ?? String(error), code: error?.code ?? null, stack: String(error?.stack ?? '').slice(0, 2_000) }
  saveReport()
  throw error
} finally {
  await cleanup()
  saveReport()
}

console.log(JSON.stringify({ status: report.status, outDir, report: join(outDir, 'report.json') }))
