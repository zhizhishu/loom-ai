// Pure tests for the Node-only device fixture.
//
// Nothing here starts a Host, a display, a container or a model: these are the decisions the
// live computer acceptance depends on, and a wrong one must fail here instead of turning into
// a green live run that proved something else.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
  buildNodeOnlyRoot,
  CHROOT_BINARY,
  clickReceipt,
  computerNode,
  digestOf,
  evidencePaths,
  fixtureRoots,
  grantServer,
  HELPER_INFO_REQUEST,
  listNodes,
  login,
  nodeOnlyRootPlan,
  parsePairOutput,
  runInRoot,
  typedReceipt
} from './loom-computer-node-live.mjs'

const live = process.env.LOOM_ALLOW_LIVE_ACCEPTANCE === '1'

test('the pairing output is read as a one-time code plus the loopback connect URL', () => {
  const parsed = parsePairOutput({ stdout: 'aba308cc12d58831\n', stderr: 'connect: ws://127.0.0.1:64701/api/v1/nodes/connect\npairing code expires in 10 minutes and works once\n' })
  assert.deepEqual(parsed, { code: 'aba308cc12d58831', connect: 'ws://127.0.0.1:64701/api/v1/nodes/connect' })
  // A missing or malformed answer is never repaired into a code.
  assert.deepEqual(parsePairOutput({ stdout: '', stderr: 'connect: ws://127.0.0.1:1/x\n' }), { code: null, connect: 'ws://127.0.0.1:1/x' })
  assert.equal(parsePairOutput({ stdout: 'no code here\n', stderr: '' }).code, null)
})

test('the click receipt is the dialog label, not any text containing it', () => {
  assert.equal(clickReceipt('CONFIRM\n'), true)
  assert.equal(clickReceipt(' CONFIRM '), true)
  assert.equal(clickReceipt('RETRY'), false)
  assert.equal(clickReceipt('CONFIRMED'), false)
  assert.equal(clickReceipt('CONFIRM CONFIRM'), false)
  assert.equal(clickReceipt(null), false)
})

test('the typed receipt must be exactly the code this run asked for', () => {
  assert.equal(typedReceipt('LOOM-NODE-ABCDEF\n', 'LOOM-NODE-ABCDEF'), true)
  assert.equal(typedReceipt('LOOM-NODE-ABCDEF', 'LOOM-NODE-abcdef'), false)
  assert.equal(typedReceipt('prefix LOOM-NODE-ABCDEF', 'LOOM-NODE-ABCDEF'), false)
  assert.equal(typedReceipt('LOOM-NODE-ABCDEF\nLOOM-NODE-ABCDEF', 'LOOM-NODE-ABCDEF'), false)
  assert.equal(typedReceipt('', 'LOOM-NODE-ABCDEF'), false)
  assert.equal(typedReceipt('anything', ''), false)
  assert.equal(typedReceipt(null, 'LOOM-NODE-ABCDEF'), false)
})

test('only one online node that advertises a desktop is accepted', () => {
  const local = { nodeId: 'local', revocable: false, status: 'online', computer: { advertised: false } }
  const remote = { nodeId: 'node_a', revocable: true, status: 'online', computer: { advertised: true } }
  assert.deepEqual(computerNode([local, remote]), { node: remote, reason: null })
  assert.equal(computerNode([local]).node, null)
  assert.equal(computerNode([local, remote, { ...remote, nodeId: 'node_b' }]).reason, 'computer_nodes:2')
  // A node that is paired but offline is never offered as the device.
  assert.equal(computerNode([{ ...remote, status: 'offline' }]).node, null)
})

test('the stored grant definition and its config entry must agree', () => {
  const definitionJson = JSON.stringify({ mcpServers: { 'loom-computer-agent-abc12345': { env: { LOOM_COMPUTER_AGENT_RUNTIME: 'pi', LOOM_COMPUTER_AGENT_SCOPE: 'control' } } } })
  const config = { servers: [{ name: 'loom-computer-agent-abc12345', serverId: 'server-1' }] }
  assert.deepEqual(grantServer({ config, definitionJson }), {
    serverId: 'server-1',
    name: 'loom-computer-agent-abc12345',
    env: { LOOM_COMPUTER_AGENT_RUNTIME: 'pi', LOOM_COMPUTER_AGENT_SCOPE: 'control' }
  })
  assert.throws(() => grantServer({ config: { servers: [] }, definitionJson }), /not in the configuration/u)
  assert.throws(() => grantServer({ config, definitionJson: '{"mcpServers":{}}' }), /no MCP server/u)
})

test('the Node-only root declares only what the device needs', () => {
  const plan = nodeOnlyRootPlan('/root')
  const targets = plan.binaries.map(binary => binary.to)
  for (const target of ['usr/local/bin/node', 'usr/local/bin/loom-node', 'usr/local/bin/host_desktop.py', 'usr/bin/python3']) {
    assert.equal(targets.includes(target), true, target)
  }
  // No shell, no package manager, no compiler, no host credential copy.
  for (const forbidden of ['bin/sh', 'bin/bash', 'usr/bin/git', 'usr/bin/env']) {
    assert.equal(targets.includes(forbidden), false, forbidden)
  }
  // libXtst carries synthetic input: without it a capture still works and every click fails.
  assert.equal(plan.runtimeLibraries.some(path => path.includes('libXtst')), true)
  assert.equal(plan.devices.map(device => device.name).includes('null'), true)
  assert.equal(plan.devices.map(device => device.name).includes('urandom'), true)
})

test('the helper request carries only the closed capture contract', () => {
  assert.deepEqual({ ...HELPER_INFO_REQUEST }, { op: 'info' })
})

test('evidence and fixture paths stay inside the caller-provided root', () => {
  const roots = fixtureRoots('/base')
  assert.equal(roots.nodeRoot, '/base/node-only-root')
  assert.equal(roots.nodeData, '/base/node-data')
  // The node's own data directory is NOT inside the root it runs in: it is created and mounted
  // separately, so a stopped fixture cannot leave a paired device behind inside the root.
  assert.equal(roots.nodeData.startsWith(roots.nodeRoot), false)
})

test('fixed-route helpers are exported for the live case', () => {
  assert.equal(typeof login, 'function')
  assert.equal(typeof listNodes, 'function')
  assert.equal(typeof runInRoot, 'function')
  assert.equal(typeof CHROOT_BINARY, 'string')
  assert.equal(existsSync('/proc/self'), true)
})

test('the digest helper is stable over the same bytes', () => {
  assert.equal(digestOf(Buffer.from('png')), digestOf(Buffer.from('png')))
  assert.notEqual(digestOf(Buffer.from('png')), digestOf(Buffer.from('png ')))
})

test('the private root really runs only the device, with its own display', { skip: live ? false : 'LOOM_ALLOW_LIVE_ACCEPTANCE=1 is required for the real root build' }, async () => {
  const base = await (await import('node:fs/promises')).mkdtemp('/tmp/loom-node-only-test-')
  const root = `${base}/root`
  const displayNumber = 89
  const { startXvfb, waitForDisplay } = await import('./loom-computer-node-live.mjs')
  const xvfb = startXvfb({ displayNumber })
  try {
    await waitForDisplay({ display: xvfb.display, budgetMs: 15_000 })
    const client = process.env.LOOM_NODE_BIN ?? `${process.env.CARGO_TARGET_DIR ?? new URL('../..', import.meta.url).pathname.replace(/\/(scripts\/lib\/)$/u, '')}/debug/loom-node`
    const plan = await buildNodeOnlyRoot({
      root,
      display: xvfb.display,
      sources: { client, helper: new URL('../../resources/computer/host_desktop.py', import.meta.url).pathname }
    })
    assert.equal(plan.verification.helperPlatform, 'linux-x11')
    assert.ok(plan.verification.bounds.width > 0)
    // The device binary runs inside the root, and the host's own filesystem is not there.
    assert.match(runInRoot({ root, argv: ['/usr/local/bin/loom-node', '--version'] }), /loom-node/u)
    assert.equal(existsSync(`${root}/wt/pc-d`), false)
  } finally {
    await xvfb.stop()
    await (await import('node:fs/promises')).rm(base, { recursive: true, force: true })
  }
})

test('the evidence writer creates its directory', async () => {
  const paths = evidencePaths('/tmp/loom-evidence-test/run-1')
  assert.equal(existsSync('/tmp/loom-evidence-test/run-1'), true)
  assert.equal(paths.report, '/tmp/loom-evidence-test/run-1/report.json')
  await (await import('node:fs/promises')).rm('/tmp/loom-evidence-test', { recursive: true, force: true })
})
