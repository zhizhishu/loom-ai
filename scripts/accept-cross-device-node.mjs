#!/usr/bin/env node
// Two-machine device acceptance for one paired node.
//
//   node scripts/accept-cross-device-node.mjs plan
//   node scripts/accept-cross-device-node.mjs host-prepare      --endpoint <origin> (--token-file <p>|--token-stdin) --evidence <dir> --pair-code-out <p>
//   node scripts/accept-cross-device-node.mjs node-pair         --node-bin <p> --node-root <dir> --server <ws(s) url> (--pair-code-stdin|--pair-code-env VAR) --evidence <dir>
//   node scripts/accept-cross-device-node.mjs node-serve        --node-bin <p> --node-root <dir> --server <ws(s) url>
//   node scripts/accept-cross-device-node.mjs workspace-prepare --endpoint <origin> (--token-file <p>|--token-stdin) --mission <id> --camp <id> --source <git repo on the node> --expect-node-id <id> --evidence <dir>
//   node scripts/accept-cross-device-node.mjs verify            --endpoint <origin> (--token-file <p>|--token-stdin) --mission <id> --probe-relative <path> [--expected-sha256 <hex>] [--expect-node-id <id>] [--phase online|offline|reconnect] [--require-runtime <kind,...>] [--exec-runtime <kind> --exec-cwd <dir>] --evidence <dir>
//   node scripts/accept-cross-device-node.mjs status            --evidence <dir>
//
// This script never starts a Core, a Runtime or a model, never touches the daily
// instance, and never assumes it can reach the other machine. Run the host
// stages where the server listens and the node stages where the node runs.
// Every stage is resumable and only reads the evidence files it names.
//
// What each stage may claim:
//   host-prepare      the running host issued a one-time pairing code
//   node-pair         `loom-node` redeemed it and persisted a node credential
//   workspace-prepare the host bound a fresh mission workspace to that node and
//                     recorded the node's own git base sha
//   verify online     the same node answered a real read; with --expected-sha256
//                     the returned bytes must also match a node-side hash
//   verify offline    a stopped node fails closed and nothing is retried
//   verify reconnect  the same node identity answers with the same bytes
// It never claims a Runtime load or call, a Workspace RPC archive receipt, a
// loom_artifact, a Candidate or an Owner Review: those are reported NOT_RUN with
// the reason and are never inferred from a successful read.
//
// Secrets: a pairing code or token is only read from stdin, an environment
// variable or a private file. It is never an argv value, never printed, and
// every evidence document passes a hard no-secret gate before it is written.
//
// These stages import only Node builtins, so a copy of `scripts/` is enough on
// the node machine.
//
// Exit codes: 0 the stage did what it claims, 1 the stage refused or failed,
// 2 `status` saw a failing slice, 3 `status` has required slices still NOT_RUN.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EVIDENCE_FILES,
  EvidenceWriter,
  HOST_WEB_PROTOCOL_VERSION,
  HostClient,
  HostError,
  RUNTIME_KINDS,
  UsageError,
  checkReturnedBytes,
  classifyHostError,
  execAttemptPolicy,
  formatPlan,
  nodeById,
  normalizeServer,
  pairingVerdict,
  parseArguments,
  parseNodeCredential,
  parseToken,
  remoteNodeIds,
  runtimeAdvertisement,
  sha256Hex,
  workspaceMatches,
  writeSecretFile
} from './lib/accept-cross-device-node.mjs'

async function main () {
  const options = parseArguments(process.argv.slice(2))
  switch (options.stage) {
    case 'plan': return runPlan(options)
    case 'host-prepare': return runHostPrepare(options)
    case 'node-pair': return runNodePair(options)
    case 'node-serve': return runNodeServe(options)
    case 'workspace-prepare': return runWorkspacePrepare(options)
    case 'verify': return runVerify(options)
    case 'status': return runStatus(options)
    default: throw new UsageError('usage', `unknown stage ${options.stage}`)
  }
}

/* -------------------------------------------------------------------- plan */

/** Recorded in every document so a reader knows which host instance answered. */
function hostRootNote (options) {
  return options.hostDataRoot === undefined ? {} : { hostDataRoot: options.hostDataRoot }
}

function runPlan (options) {
  process.stdout.write(`${formatPlan(options)}\n`)
  return 0
}

/* ------------------------------------------------------------ host-prepare */

function readToken (options) {
  if (options.tokenFile !== undefined) {
    return parseToken(readFileSync(options.tokenFile, 'utf8'), `--token-file ${options.tokenFile}`)
  }
  return parseToken(readFileSync(0, 'utf8'), 'stdin token')
}

async function runHostPrepare (options) {
  const token = readToken(options)
  const client = new HostClient(options.endpoint)
  await client.login(token)

  const before = await client.listNodes()
  const baselineRemoteNodeIds = remoteNodeIds(before)

  // Source-verified: the host returns the same unused, unexpired code until it
  // is redeemed (crates/rovai-web/src/nodes.rs::issue_pairing), so a second
  // issue cannot consume the first one and proves the code is not rotated.
  const first = await client.issuePairing()
  if (typeof first?.pairingCode !== 'string' || first.pairingCode.length === 0) {
    throw new HostError('pairing_code_missing', 'the host returned no pairing code', 200)
  }
  const second = await client.issuePairing()
  const code = first.pairingCode
  // Registered as a secret before any document exists, so the code can never
  // reach an evidence file even through a future field.
  const writer = new EvidenceWriter(options.evidence, [code])
  writeSecretFile(options.pairCodeOut, code)

  const document = {
    stage: 'host-prepare',
    status: 'PASS',
    endpoint: options.endpoint,
    ...hostRootNote(options),
    hostWebProtocolVersion: HOST_WEB_PROTOCOL_VERSION,
    baselineRemoteNodeIds,
    baselineNodeCount: Array.isArray(before?.nodes) ? before.nodes.length : 0,
    pairingCodeIssued: true,
    pairingCodeFile: options.pairCodeOut,
    pairingCodeRedacted: true,
    pairingCodeStableAcrossIssue: second?.pairingCode === code,
    expiresInSeconds: first?.expiresInSeconds ?? null,
    connectUrl: second?.connectUrl ?? first?.connectUrl ?? null,
    reachabilityWarning: first?.reachabilityWarning ?? null,
    notes: [
      'the code file is 0600 on POSIX; feed it to node-pair on stdin',
      'POST /api/v1/nodes/pair answers node_channel_requires_loopback off loopback'
    ]
  }
  const file = writer.write(EVIDENCE_FILES['host-prepare'], document)
  process.stdout.write(`host-prepare: code issued, redacted -> ${options.pairCodeOut}\n`)
  process.stdout.write(`host-prepare: baseline remote nodes ${baselineRemoteNodeIds.length}, stable across issue ${document.pairingCodeStableAcrossIssue}\n`)
  process.stdout.write(`host-prepare: evidence ${file}\n`)
  return 0
}

/* --------------------------------------------------------------- node-pair */

function readPairCode (options) {
  if (options.pairCodeStdin) return parsePairCode(readFileSync(0, 'utf8'), 'stdin pairing code')
  const value = process.env[options.pairCodeEnv]
  if (value === undefined) throw new UsageError('usage', `environment variable ${options.pairCodeEnv} is not set`)
  return parsePairCode(value, `environment ${options.pairCodeEnv}`)
}

/** The host issues 8 random bytes as hex; a longer hex value is still accepted. */
function parsePairCode (text, label) {
  const line = String(text).split(/\r?\n/u).map(value => value.trim()).find(Boolean)
  if (!line) throw new UsageError('pairing_code', `${label} was empty`)
  if (!/^[0-9a-f]{8,64}$/u.test(line)) throw new UsageError('pairing_code', `${label} is not a hex pairing code`)
  return line
}

function nodeCredentialPath (nodeRoot) { return join(nodeRoot, 'node.json') }

function runNodePair (options) {
  const credentialPath = nodeCredentialPath(options.nodeRoot)
  if (existsSync(credentialPath)) {
    throw new UsageError(
      'node_credential_present',
      `${credentialPath} already exists: pair into a fresh node root, or run node-serve for the stored identity`
    )
  }
  const code = readPairCode(options)
  // The code is a registered secret here too: a node log is written to evidence
  // on failure, so it can never carry the code even if a future node echoes it.
  const writer = new EvidenceWriter(options.evidence, [code])
  const startedAt = Date.now()
  const child = spawn(options.nodeBin, [
    '--data-dir', options.nodeRoot,
    '--server', options.server,
    '--pair-code-stdin'
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  try { child.stdin.end(`${code}\n`) } catch { /* the node exited early; exit handler reports it */ }

  return new Promise(resolve => {
    let settled = false
    const finish = (payload, exitCode) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      writer.write(EVIDENCE_FILES['node-pair'], { stage: 'node-pair', durationMs: Date.now() - startedAt, ...payload })
      resolve(exitCode)
    }
    const poll = setInterval(() => {
      if (!existsSync(credentialPath)) return
      let parsed
      try { parsed = parseNodeCredential(readFileSync(credentialPath, 'utf8')) } catch { return }
      stopChild(child)
      let serverMatches = null
      try { serverMatches = normalizeServer(parsed.server) === options.server } catch { serverMatches = false }
      finish({
        status: serverMatches === false ? 'FAIL' : 'PASS',
        ...(serverMatches === false ? { failureKind: 'result', reason: 'credential_server_mismatch' } : {}),
        nodeId: parsed.nodeId,
        credentialFile: credentialPath,
        credentialTokenRedacted: true,
        credentialServerMatches: serverMatches,
        requestAttempts: 1,
        notes: ['the node was stopped after pairing; the credential stays on disk for node-serve']
      }, serverMatches === false ? 1 : 0)
    }, 250)
    const deadline = setTimeout(() => {
      stopChild(child)
      finish({
        status: 'NOT_RUN',
        reason: 'credential_file_did_not_appear',
        nodeStderrTail: tail(stderr),
        nodeStdoutTail: tail(stdout),
        notes: ['no node.json was written; check the server url, the code lifetime and the node log']
      }, 1)
    }, options.timeoutMs)
    child.on('error', error => {
      finish({
        status: 'FAIL',
        reason: 'node_binary_unavailable',
        nodeError: error.code ?? error.message
      }, 1)
    })
    child.on('exit', (code2, signal) => {
      if (existsSync(credentialPath)) return
      finish({
        status: 'FAIL',
        reason: 'node_exited_before_pairing',
        exitCode: code2,
        signal,
        nodeStderrTail: tail(stderr),
        nodeStdoutTail: tail(stdout)
      }, 1)
    })
  })
}

function stopChild (child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  const killer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 5_000)
  killer.unref()
  child.once('exit', () => clearTimeout(killer))
}

function tail (text, limit = 2_000) {
  const trimmed = String(text).trim()
  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit)
}

/* -------------------------------------------------------------- node-serve */

function runNodeServe (options) {
  const credentialPath = nodeCredentialPath(options.nodeRoot)
  if (!existsSync(credentialPath)) {
    throw new UsageError('node_credential', `${credentialPath} is missing: run node-pair first`)
  }
  const credential = parseNodeCredential(readFileSync(credentialPath, 'utf8'))
  process.stdout.write(`node-serve: node ${credential.nodeId} with the stored credential; Ctrl-C stops only this node\n`)
  const child = spawn(options.nodeBin, [
    '--data-dir', options.nodeRoot,
    '--server', options.server
  ], { stdio: 'inherit', windowsHide: true })
  const forward = () => { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  return new Promise(resolve => {
    child.on('error', error => {
      process.stderr.write(`node-serve: could not start the node (${error.code ?? error.message})\n`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      process.stdout.write(`node-serve: node ${credential.nodeId} exited (code ${code}${signal ? `, signal ${signal}` : ''})\n`)
      resolve(code ?? 0)
    })
  })
}

/* ------------------------------------------------------ workspace-prepare */

async function runWorkspacePrepare (options) {
  const writer = new EvidenceWriter(options.evidence)
  const token = readToken(options)
  const client = new HostClient(options.endpoint)
  await client.login(token)

  const requested = {
    missionId: options.mission,
    campId: options.camp,
    nodeId: options.expectNodeId,
    source: options.source
  }
  const listed = await client.listNodes()
  const node = nodeById(listed, options.expectNodeId)
  if (!node) {
    writer.write(EVIDENCE_FILES['workspace-prepare'], {
      stage: 'workspace-prepare', status: 'FAIL', failureKind: 'precondition',
      reason: 'node_not_listed', requested
    })
    process.stderr.write('workspace-prepare: the node is not listed on this host\n')
    return 1
  }
  if (node.status !== 'online') {
    writer.write(EVIDENCE_FILES['workspace-prepare'], {
      stage: 'workspace-prepare', status: 'FAIL', failureKind: 'precondition',
      reason: 'node_not_online', requested, nodeStatus: node.status
    })
    process.stderr.write(`workspace-prepare: node ${node.nodeId} is ${node.status}; run node-serve first\n`)
    return 1
  }

  let returned
  try {
    returned = await client.prepareWorkspace(requested)
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    const classified = classifyHostError(error)
    writer.write(EVIDENCE_FILES['workspace-prepare'], {
      stage: 'workspace-prepare', status: 'FAIL', failureKind: 'result',
      reason: classified.code, requested, remedy: classified.remedy, httpStatus: classified.status
    })
    process.stderr.write(`workspace-prepare: host rejected it (${classified.code})${classified.remedy ? `: ${classified.remedy}` : ''}\n`)
    return 1
  }

  const verdict = workspaceMatches({ requested, returned })
  const document = {
    stage: 'workspace-prepare',
    status: verdict.status,
    ...hostRootNote(options),
    ...(verdict.status === 'FAIL' ? { failureKind: 'result', reason: verdict.reasons.join('+') } : {}),
    requested,
    returned: {
      missionId: returned?.missionId ?? null,
      campId: returned?.campId ?? null,
      nodeId: returned?.nodeId ?? null,
      ownerRole: returned?.ownerRole ?? null,
      worktree: returned?.worktree ?? null,
      source: returned?.source ?? null,
      branch: returned?.branch ?? null,
      baseSha: returned?.baseSha ?? null
    },
    provenBy: ['remote PrepareWorktree answer', 'durable mission workspace record'],
    notes: [
      'the worktree path and baseSha are the node own answer; this host never opened that path',
      'POST /api/v1/nodes/workspaces is idempotent per mission, so a fresh mission id is required'
    ]
  }
  const file = writer.write(EVIDENCE_FILES['workspace-prepare'], document)
  process.stdout.write(`workspace-prepare: ${verdict.status} nodeId=${document.returned.nodeId} ownerRole=${document.returned.ownerRole}\n`)
  process.stdout.write(`workspace-prepare: baseSha=${document.returned.baseSha} worktree=<path on the node>\n`)
  process.stdout.write(`workspace-prepare: evidence ${file}\n`)
  return verdict.status === 'PASS' ? 0 : 1
}

/* ------------------------------------------------------------------ verify */

async function runVerify (options) {
  const phase = options.phase ?? 'online'
  const writer = new EvidenceWriter(options.evidence)
  const token = readToken(options)
  const client = new HostClient(options.endpoint)
  await client.login(token)
  if (phase === 'online') return verifyOnline(options, client, writer)
  if (phase === 'offline') return verifyOffline(options, client, writer)
  return verifyReconnect(options, client, writer)
}

/** A list answer is the only one that carries `ownerRole`/`online`. */
async function listVerdict (client, mission) {
  try {
    const body = await client.workspaceFiles({ missionId: mission, op: 'list', relative: '' })
    return {
      status: body?.ownerRole === 'remote' && body?.online === true ? 'PASS' : 'FAIL',
      ownerRole: body?.ownerRole ?? null,
      online: body?.online ?? null,
      lastHeartbeat: body?.lastHeartbeat ?? null,
      entryCount: Array.isArray(body?.entries) ? body.entries.length : null,
      entryNames: Array.isArray(body?.entries) ? body.entries.map(entry => entry?.name).slice(0, 200) : []
    }
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    return { status: 'NO_ANSWER', error: classifyHostError(error) }
  }
}

async function verifyOnline (options, client, writer) {
  const listed = await client.listNodes()
  const node = nodeById(listed, options.expectNodeId)
  if (!node) {
    writer.write(EVIDENCE_FILES.online, {
      stage: 'verify', phase: 'online', status: 'FAIL', failureKind: 'precondition',
      reason: 'node_not_listed', expectNodeId: options.expectNodeId, mission: options.mission
    })
    process.stderr.write('verify/online: the expected node is not listed\n')
    return 1
  }
  if (node.status !== 'online') {
    writer.write(EVIDENCE_FILES.online, {
      stage: 'verify', phase: 'online', status: 'FAIL', failureKind: 'precondition',
      reason: 'node_not_online', expectNodeId: options.expectNodeId,
      nodeStatus: node.status, mission: options.mission
    })
    process.stderr.write(`verify/online: node ${node.nodeId} is ${node.status}; run node-serve first\n`)
    return 1
  }

  const baseline = writer.read(EVIDENCE_FILES['host-prepare'])
  const pairing = baseline === null
    ? { status: 'NOT_RUN', reason: 'host_prepare_evidence_missing', distinctIdentity: 'NOT_RUN' }
    : (() => {
        const verdict = pairingVerdict({
          nodeId: options.expectNodeId,
          baselineRemoteNodeIds: baseline.baselineRemoteNodeIds ?? [],
          nodeList: listed
        })
        return {
          status: verdict.status,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          distinctIdentity: verdict.status === 'PASS' ? 'PASS' : 'NOT_RUN'
        }
      })()

  const kinds = options.requireRuntimes ?? [...RUNTIME_KINDS]
  const advertisement = runtimeAdvertisement(node, kinds)
  const missingRequired = options.requireRuntimes === undefined
    ? []
    : advertisement.filter(entry => entry.verdict !== 'ADVERTISED').map(entry => entry.adapterKind)

  const listing = await listVerdict(client, options.mission)
  let read = null
  let readError = null
  try {
    read = await client.workspaceFiles({ missionId: options.mission, op: 'read', relative: options.relative })
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    readError = classifyHostError(error)
  }

  let bytesCheck = null
  if (read !== null) {
    const bytes = Buffer.from(String(read.data ?? ''), 'base64')
    bytesCheck = checkReturnedBytes({
      bytes,
      truncated: read.truncated === true,
      archivedSize: read.size,
      expectedSha256: options.expectedSha256
    })
  }

  const exec = await maybeExec(options, client)

  const reasons = []
  if (pairing.status === 'FAIL') reasons.push(`pairing:${pairing.reason}`)
  if (listing.status === 'FAIL') reasons.push(`workspace_owner_is_${listing.ownerRole}`)
  if (listing.status === 'NO_ANSWER') reasons.push(listing.error.code)
  if (readError !== null) reasons.push(readError.code)
  if (bytesCheck !== null && bytesCheck.status === 'FAIL') reasons.push(...bytesCheck.reasons)
  reasons.push(...missingRequired.map(kind => `runtime_not_advertised:${kind}`))
  const failed = reasons.length > 0
  // PASS means the node really served this read; byte identity is reported in
  // `bytes` and only becomes PASS with an independent node-side hash.
  const status = failed ? 'FAIL' : (read !== null ? 'PASS' : 'NOT_RUN')

  const document = {
    stage: 'verify',
    phase: 'online',
    status,
    ...hostRootNote(options),
    ...(failed ? { failureKind: 'result', reason: reasons.join('+') } : {}),
    byteIdentity: bytesCheck?.status ?? 'NOT_RUN',
    expectNodeId: options.expectNodeId,
    nodeStatus: node.status,
    remoteNodeIds: remoteNodeIds(listed),
    pairing,
    mission: options.mission,
    relative: options.relative,
    listing,
    returns: {
      dataBase64: read?.data ?? null,
      sizeField: read?.size ?? null,
      truncated: read?.truncated ?? null,
      lastHeartbeat: read?.lastHeartbeat ?? null
    },
    bytes: bytesCheck,
    expectedSha256: options.expectedSha256 ?? null,
    runtimeAdvertisement: advertisement,
    runtimeAdvertisementKind: 'advertisement-only',
    workspaceRpcArchiveReceipt: {
      status: 'NOT_RUN',
      reason: 'no node CLI or HTTP entry creates an R2 archive receipt; only an agent Builtin workspace call does'
    },
    loomArtifact: {
      status: 'NOT_RUN',
      reason: 'returned bytes are not a loom_artifact; register_remote_loom_evidence is only reachable from an authenticated Run'
    },
    requestIdentity: {
      status: 'NOT_RUN',
      reason: 'this route mints its own fs_<uuid> request id inside the host and never returns it, so a stable request id across retries cannot be observed from this surface'
    },
    exec,
    notes: [
      'a read above 1 MiB is truncated and never counts as a full-file byte proof',
      'the returned base64 is kept so the supervisor can re-hash it independently'
    ]
  }
  const file = writer.write(EVIDENCE_FILES.online, document)
  process.stdout.write(`verify/online: ${status} byteIdentity=${document.byteIdentity} sha256=${bytesCheck?.sha256 ?? 'n/a'} size=${bytesCheck?.sizeBytes ?? 'n/a'}\n`)
  process.stdout.write(`verify/online: pairing ${pairing.status}${pairing.reason ? ` (${pairing.reason})` : ''}, workspace ${listing.ownerRole}/${listing.online}\n`)
  for (const entry of advertisement) {
    process.stdout.write(`verify/online: runtime ${entry.adapterKind} ${entry.verdict} availability=${entry.availability}\n`)
  }
  if (exec !== null) process.stdout.write(`verify/online: exec ${exec.status}${exec.runId ? ` runId=${exec.runId}` : ''}\n`)
  process.stdout.write(`verify/online: evidence ${file}\n`)
  return status === 'FAIL' ? 1 : 0
}

async function maybeExec (options, client) {
  if (options.execRuntime === undefined) return null
  execAttemptPolicy({ attempts: 1 })
  try {
    const result = await client.exec({
      runtime: options.execRuntime,
      cwd: options.execCwd,
      args: options.execArgs ?? [],
      missionId: options.mission
    })
    const stdout = Buffer.from(String(result?.stdout ?? ''), 'base64')
    const stderr = Buffer.from(String(result?.stderr ?? ''), 'base64')
    return {
      status: 'DISPATCHED_ONCE',
      runId: result?.runId ?? null,
      exitCode: result?.exitCode ?? null,
      stdoutSha256: sha256Hex(stdout),
      stdoutBytes: stdout.length,
      stderrSha256: sha256Hex(stderr),
      stderrBytes: stderr.length,
      attempts: 1
    }
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    const classified = classifyHostError(error)
    return {
      status: classified.unknownOutcome ? 'UNKNOWN' : 'REJECTED',
      code: classified.code,
      httpStatus: classified.status,
      attempts: 1,
      retryAllowed: false,
      notes: ['an unknown dispatch outcome is never repeated; inspect the node run list before anything else']
    }
  }
}

async function verifyOffline (options, client, writer) {
  const listed = await client.listNodes()
  const node = nodeById(listed, options.expectNodeId)
  const listing = await listVerdict(client, options.mission)
  let readError = null
  let answered = false
  let body = null
  try {
    body = await client.workspaceFiles({ missionId: options.mission, op: 'read', relative: options.relative })
    answered = true
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    readError = classifyHostError(error)
  }
  const offline = readError !== null && readError.nodeOffline
  const status = answered ? 'FAIL' : (offline ? 'PASS' : 'NOT_RUN')
  const document = {
    stage: 'verify',
    phase: 'offline',
    status,
    ...hostRootNote(options),
    ...(answered ? { failureKind: 'result', reason: 'answered_without_a_connected_node' } : {}),
    ...(!answered && !offline ? { reason: readError?.code ?? 'no_answer_and_no_offline_error' } : {}),
    expectNodeId: options.expectNodeId,
    nodeStatus: node?.status ?? null,
    mission: options.mission,
    relative: options.relative,
    listing,
    requestAttempts: 1,
    retriedAfterFailure: false,
    error: readError,
    answeredSize: answered ? body?.size ?? null : null,
    notes: ['one read attempt only; a failed dispatch is never retried by this script']
  }
  const file = writer.write(EVIDENCE_FILES.offline, document)
  process.stdout.write(`verify/offline: ${status} nodeStatus=${document.nodeStatus} error=${readError?.code ?? 'none'}\n`)
  process.stdout.write(`verify/offline: evidence ${file}\n`)
  return status === 'FAIL' ? 1 : 0
}

async function verifyReconnect (options, client, writer) {
  const online = writer.read(EVIDENCE_FILES.online)
  const listed = await client.listNodes()
  const node = nodeById(listed, options.expectNodeId)
  const currentRemoteIds = remoteNodeIds(listed)
  const reasons = []
  if (!node) reasons.push('node_not_listed')
  else if (node.status !== 'online') reasons.push('node_not_online')
  const duplicates = currentRemoteIds.filter((id, index) => currentRemoteIds.indexOf(id) !== index)
  if (duplicates.length > 0) reasons.push('duplicate_remote_identity')
  const onlineRemoteIds = Array.isArray(online?.remoteNodeIds) ? online.remoteNodeIds : null
  const extraRemoteIds = onlineRemoteIds === null
    ? []
    : currentRemoteIds.filter(id => !onlineRemoteIds.includes(id))
  if (extraRemoteIds.length > 0) reasons.push('extra_remote_node_appeared')

  const listing = await listVerdict(client, options.mission)
  let read = null
  let readError = null
  try {
    read = await client.workspaceFiles({ missionId: options.mission, op: 'read', relative: options.relative })
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    readError = classifyHostError(error)
  }
  if (listing.status === 'FAIL') reasons.push(`workspace_owner_is_${listing.ownerRole}`)
  if (readError !== null) reasons.push(readError.code)

  const expected = options.expectedSha256 ?? online?.bytes?.sha256 ?? undefined
  let bytesCheck = null
  if (read !== null) {
    bytesCheck = checkReturnedBytes({
      bytes: Buffer.from(String(read.data ?? ''), 'base64'),
      truncated: read.truncated === true,
      archivedSize: read.size,
      expectedSha256: expected
    })
    if (bytesCheck.status === 'FAIL') reasons.push(...bytesCheck.reasons)
  }
  const sameNodeId = online?.expectNodeId !== undefined && online?.expectNodeId === options.expectNodeId
  if (online === null) reasons.push('online_phase_evidence_missing')
  else if (!sameNodeId) reasons.push('node_id_changed')
  const missingBaseline = expected === undefined
  const failed = reasons.length > 0
  const precondition = online === null
  const status = failed ? 'FAIL' : (missingBaseline || bytesCheck?.status === 'NOT_RUN' ? 'NOT_RUN' : 'PASS')
  const document = {
    stage: 'verify',
    phase: 'reconnect',
    status,
    ...hostRootNote(options),
    ...(failed ? { failureKind: precondition ? 'precondition' : 'result', reason: reasons.join('+') } : {}),
    ...(!failed && missingBaseline ? { reason: 'no_online_sha_to_compare' } : {}),
    expectNodeId: options.expectNodeId,
    onlineExpectNodeId: online?.expectNodeId ?? null,
    sameNodeId,
    nodeStatus: node?.status ?? null,
    remoteNodeIds: currentRemoteIds,
    onlineRemoteNodeIds: onlineRemoteIds,
    extraRemoteIds,
    mission: options.mission,
    relative: options.relative,
    listing,
    bytes: bytesCheck,
    onlineSha256: online?.bytes?.sha256 ?? null,
    requestAttempts: 1,
    newRunCreated: false,
    requestIdentity: {
      status: 'NOT_RUN',
      reason: 'no request id is returned by this route; stability is asserted only through the same node id and the same sha256'
    },
    notes: ['a read creates no Run, so repeating it cannot duplicate a side effect']
  }
  const file = writer.write(EVIDENCE_FILES.reconnect, document)
  process.stdout.write(`verify/reconnect: ${status} sameNodeId=${sameNodeId} sha256=${bytesCheck?.sha256 ?? 'n/a'}\n`)
  process.stdout.write(`verify/reconnect: evidence ${file}\n`)
  return status === 'FAIL' ? 1 : 0
}

/* ------------------------------------------------------------------ status */

function runStatus (options) {
  const writer = new EvidenceWriter(options.evidence)
  const files = {
    hostPrepare: writer.read(EVIDENCE_FILES['host-prepare']),
    nodePair: writer.read(EVIDENCE_FILES['node-pair']),
    workspace: writer.read(EVIDENCE_FILES['workspace-prepare']),
    online: writer.read(EVIDENCE_FILES.online),
    offline: writer.read(EVIDENCE_FILES.offline),
    reconnect: writer.read(EVIDENCE_FILES.reconnect)
  }
  const pick = (document, extra = {}) => {
    if (document === null) return { status: 'NOT_RUN', reason: 'evidence_missing' }
    const reason = document.reason ?? (Array.isArray(document.reasons) ? document.reasons.join('+') : undefined)
    return { status: document.status ?? 'NOT_RUN', ...(reason ? { reason } : {}), ...extra }
  }
  const slices = [
    { slice: 'pairing: host issued a one-time code', ...pick(files.hostPrepare) },
    { slice: 'pairing: node redeemed it and persisted a credential', required: true, ...pick(files.nodePair) },
    {
      slice: 'pairing: distinct remote identity online',
      required: true,
      ...(files.online?.pairing?.status !== undefined
        ? { status: files.online.pairing.status, ...(files.online.pairing.reason ? { reason: files.online.pairing.reason } : {}) }
        : { status: 'NOT_RUN', reason: 'evidence_missing' })
    },
    { slice: 'Grant: mission workspace bound to the node', required: true, ...pick(files.workspace) },
    {
      slice: 'tool call: the remote node served a real read',
      required: true,
      ...(files.online?.listing?.status === 'PASS'
        ? { status: files.online.returns?.dataBase64 === null || files.online.returns?.dataBase64 === undefined ? 'NOT_RUN' : 'PASS' }
        : { status: 'NOT_RUN', reason: files.online?.listing?.reason ?? 'evidence_missing' })
    },
    {
      slice: 'byte identity vs a hash computed on the node',
      status: files.online?.bytes?.status ?? 'NOT_RUN',
      ...((files.online?.bytes?.reasons ?? []).length > 0 ? { reason: files.online.bytes.reasons.join('+') } : {})
    },
    { slice: 'offline fails closed, no retry', required: true, ...pick(files.offline) },
    { slice: 'reconnect: same identity, same bytes, no new Run', required: true, ...pick(files.reconnect) },
    {
      slice: 'exec dispatch (single attempt)',
      ...(files.online?.exec === null || files.online?.exec === undefined
        ? { status: 'NOT_RUN', reason: 'not_requested' }
        : { status: files.online.exec.status === 'DISPATCHED_ONCE' ? 'PASS' : (files.online.exec.status === 'REJECTED' ? 'NOT_RUN' : 'FAIL'), reason: files.online.exec.code ?? undefined })
    },
    { slice: 'R2 archive receipt / loom_artifact', status: 'NOT_RUN', reason: 'not reachable from the node CLI or the HTTP surface' },
    { slice: 'Runtime Loaded/Invoked', status: 'NOT_RUN', reason: 'the node list only advertises installations' },
    { slice: 'Candidate / Owner Review', status: 'NOT_RUN', reason: 'needs a real Run and a human owner' }
  ]
  const failed = slices.filter(entry => entry.status === 'FAIL')
  const unfinished = slices.filter(entry => entry.required === true && entry.status !== 'PASS')
  const summary = {
    stage: 'status',
    status: failed.length > 0 ? 'FAIL' : (unfinished.length > 0 ? 'NOT_RUN' : 'PASS'),
    evidenceDirectory: options.evidence,
    slices,
    counts: {
      pass: slices.filter(entry => entry.status === 'PASS').length,
      fail: failed.length,
      notRun: slices.filter(entry => entry.status === 'NOT_RUN').length,
      requiredUnfinished: unfinished.map(entry => entry.slice)
    },
    notes: [
      'NOT_RUN is a real result here and is never promoted to PASS',
      'request identity across retries is not observable on this route; see requestIdentity in verify-online.json',
      'a runtime advertisement is never a Loaded/Invoked proof'
    ]
  }
  writer.write('summary.json', summary)
  process.stdout.write(`status: ${summary.status} (pass ${summary.counts.pass} / fail ${summary.counts.fail} / not_run ${summary.counts.notRun})\n`)
  for (const entry of slices) {
    process.stdout.write(`  ${entry.status.padEnd(7)} ${entry.slice}${entry.reason ? ` — ${entry.reason}` : ''}\n`)
  }
  process.stdout.write(`status: evidence ${join(options.evidence, 'summary.json')}\n`)
  return failed.length > 0 ? 2 : (unfinished.length > 0 ? 3 : 0)
}

/* -------------------------------------------------------------------- main */

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().then(
    code => { process.exitCode = code },
    error => {
      process.exitCode = 1
      if (error instanceof UsageError) {
        process.stderr.write(`accept-cross-device-node: ${error.code}: ${error.message}\n`)
        return
      }
      if (error instanceof HostError) {
        const hint = classifyHostError(error).remedy
        process.stderr.write(`accept-cross-device-node: host ${error.code}: ${error.message}${hint ? ` — ${hint}` : ''}\n`)
        return
      }
      process.stderr.write(`accept-cross-device-node: ${error?.stack ?? error}\n`)
    }
  )
}

export { main, runStatus }
