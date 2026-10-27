// Deterministic, isolated startup comparison. Both arguments are built Host
// binaries: the main baseline first, this implementation second. No Runtime.
// Run: node scripts/smoke-thread-interruption-startup.mjs BASELINE_HOST CURRENT_HOST REPORT.json
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launchHost, within } from './lib/host-test-client.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot, runtimeCampFilesRootForDataDirectory } from './lib/runtime-camp-files-root.mjs'

const [baseline, implementation, output] = process.argv.slice(2)
assert.ok([baseline, implementation, output].every(path => path && isAbsolute(path)), 'three absolute paths required')
assert.equal(process.platform, 'darwin', 'this startup measurement currently owns macOS only')
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-interruption-startup-')))
const repository = resolve(import.meta.dirname, '..')
const report = { channel: 'automatic_acceptance', complete: false, runtime: false, baseline, implementation,
  seededRunningRunsPerCrash: 3, startupCrashes: 0, samples: [], crash: null }
const threadId = n => {
  // Canonical UUIDv7 payload, encoded like camp_id.rs; deterministic fixture IDs.
  let value = 0x01980000000070008000000000000000n + BigInt(n), encoded = ''
  for (let digit = 0; digit < 26; digit++) {
    encoded = '0123456789abcdefghjkmnpqrstvwxyz'[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return `rvcamp_${encoded}`
}
const activeIds = [20001, 20002, 20003].map(threadId)
const now = new Date().toISOString()
const past = '2026-08-01T00:00:00.000Z'
async function ready(host) {
  let timeout
  try {
    await Promise.race([host.ready, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Startup exceeded 60 seconds')), 60_000)
    })])
  } catch (error) {
    throw new Error(`${error.message}\n${host.stderr()}`, { cause: error })
  } finally { clearTimeout(timeout) }
}

function seed(database, dataDir, history) {
  const identity = database.prepare('SELECT root_identity_digest AS digest FROM camp_attachment_view LIMIT 1').get()?.digest
  assert.ok(identity, 'bootstrap must establish the isolated Runtime Files Root identity')
  database.function('rovai_runtime_camp_files_root_identity_digest', { deterministic: true }, () => identity)
  const campsRoot = join(runtimeCampFilesRootForDataDirectory(dataDir), 'camps')
  chmodSync(campsRoot, 0o700)
  const camp = database.prepare(`INSERT INTO camp(id,title,name_origin,collaboration_mode,project_binding_kind,
    project_path,last_message_sequence,version,created_at,updated_at)
    VALUES (?,'Startup fixture','user','peer','quick_chat',?,0,1,?,?)`)
  const conversation = database.prepare(`INSERT INTO conversation(id,camp_id,agent_id,kind,
    summary_through_message_sequence,last_message_sequence,version,created_at,updated_at)
    VALUES (?,?,'agent_1','single_chat',0,0,1,?,?)`)
  const turn = database.prepare(`INSERT INTO camp_turn(id,camp_id,trigger_type,trigger_id,kind,status,version,created_at,updated_at)
    VALUES (?,?,'conversation_message',?,'single_chat','running',1,?,?)`)
  const run = database.prepare(`INSERT INTO agent_run(id,camp_turn_id,conversation_id,
    initial_camp_context_through_sequence,initial_conversation_context_through_sequence,
    responsibility_key,responsibility_generation,start_reason,purpose,completion_role,
    effective_config_json,workspace_json,permission_semantics,invocation_kind,
    response_delivery,operation_policy,operation_policy_version,destination_conversation_id,
    status,idempotency_key,version,created_at,updated_at)
    VALUES (?,?,?,0,0,?,0,'initial','Synthetic startup recovery','required','{}',NULL,'runtime_managed_v2',
      'single_chat','conversation_message','single_chat_v1',2,?,'queued',?,1,?,?)`)
  const insert = (id, timestamp, terminal) => {
    // Match Core's empty published-view layout. Missing directories would
    // benchmark attachment repair/error writes instead of ordinary startup.
    const attachmentRoot = join(campsRoot, id, 'attachments')
    mkdirSync(attachmentRoot, { recursive: true, mode: 0o700 })
    chmodSync(attachmentRoot, 0o500)
    chmodSync(join(campsRoot, id), 0o100)
    camp.run(id, join(dataDir, 'quick-chat'), timestamp, timestamp)
    if (!terminal && !activeIds.includes(id)) return
    const conversationId = `conversation-${id}`, runId = `run-${id}`, turnId = `turn-${id}`
    conversation.run(conversationId, id, timestamp, timestamp)
    turn.run(turnId, id, `message-${id}`, timestamp, timestamp)
    run.run(runId, turnId, conversationId, runId, conversationId, runId, timestamp, timestamp)
    if (terminal) {
      database.prepare(`UPDATE agent_run SET status='failed',last_error_code='runtime_error',
        ended_at=?,updated_at=? WHERE id=?`).run(timestamp, timestamp, runId)
      database.prepare(`UPDATE camp_turn SET status='failed',ended_at=?,updated_at=? WHERE id=?`).run(timestamp, timestamp, turnId)
    } else {
      database.prepare(`UPDATE agent_run SET status='running',execution_epoch=1,started_at=? WHERE id=?`).run(timestamp, runId)
    }
  }
  database.exec('BEGIN')
  for (let n = 1; n <= history; n++) insert(threadId(n), past, n % 10 === 0)
  for (const id of activeIds) insert(id, now, false)
  chmodSync(campsRoot, 0o100)
  database.exec('COMMIT')
  assert.equal(database.prepare(`SELECT count(*) AS n FROM agent_run WHERE status IN ('queued','running','waiting')`).get().n, 3)
}

function startupStages(stderr) {
  const stages = Object.fromEntries([...stderr.matchAll(/\[startup\] stage=(\w+)[^\n]*elapsed_ms=(\d+)/g)]
    .map(match => [match[1], Number(match[2])]))
  assert.ok(Number.isFinite(stages.database_ready) && Number.isFinite(stages.core_ready), stderr)
  assert.ok(!stderr.includes('integrity incident'), 'synthetic fixture must have valid attachment views')
  return { databaseReadyMs: stages.database_ready, coreReadyMs: stages.core_ready,
    recoveryAndServicesMs: stages.core_ready - stages.database_ready }
}

try {
  for (const history of [100, 1000, 10000]) {
    for (const [variant, binary] of [['baseline', baseline], ['implementation', implementation]]) {
      const dataDir = join(root, `${variant}-${history}`, 'data')
      const skillLibraryRoot = join(dataDir, 'skills'), mcpConfigPath = join(dataDir, 'mcp.json')
      await mkdir(skillLibraryRoot, { recursive: true })
      console.log(JSON.stringify({ channel: 'automatic_acceptance', dataDir, skillLibraryRoot, mcpConfigPath, runtime: false }))
      const launch = () => launchHost(binary, [...coreDataDirectoryArguments(dataDir),
        '--skill-library-root', skillLibraryRoot, '--mcp-config-path', mcpConfigPath], { cwd: repository })
      const file = join(dataDir, 'rovai.sqlite'), source = join(dataDir, 'source.sqlite')
      const initial = launch()
      try {
        await ready(initial)
        // Ask Core to establish a real empty attachment root before offline
        // synthetic seeding. Reuse its identity; never manufacture an authority.
        const [member] = await initial.request('members.list')
        const bootstrap = await initial.request('threads.create', { commandId: crypto.randomUUID(),
          name: 'Isolated startup bootstrap', workspace: null, memberAgentIds: [member.agentId],
          defaultLeadAgentId: member.agentId, collaborationMode: 'peer' })
        assert.equal(bootstrap.status, 'applied')
        const db = new DatabaseSync(file)
        try {
          // Inject synthetic durable execution facts, without a Runtime or a
          // scheduling wake, then kill this owned Host before orderly shutdown.
          seed(db, dataDir, history)
          assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
        } finally { db.close() }
        initial.child.kill('SIGKILL')
        await within(initial.closed)
        report.startupCrashes++
      } finally { await initial.close() }
      const db = new DatabaseSync(file)
      try {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM agent_run WHERE status='running'`).get().n, 3)
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally { db.close() }
      await copyFile(file, source)
      // Three independent starts from the same post-crash source expose jitter.
      // Ready includes existing recovery and service setup; it is not pure recovery.
      for (let sample = 0; sample < 3; sample++) {
        if (sample) await copyFile(source, file)
        const startedAt = performance.now(), host = launch()
        try {
          await ready(host)
          const readyMs = performance.now() - startedAt
          const navigationAt = performance.now()
          const navigation = await host.request('navigation.snapshot', { groupKeys: ['quick-chat'] })
          const navigationMs = performance.now() - navigationAt
          const ids = navigation.quickChat.recentThreads.map(thread => thread.id)
          assert.equal(ids.length, 5)
          assert.ok(activeIds.every(id => ids.includes(id)))
          const projectionAt = performance.now()
          const projection = variant === 'implementation'
            ? await host.request('notifications.threadInterruptions', { threadIds: ids }) : null
          const projectionMs = variant === 'implementation' ? performance.now() - projectionAt : 0
          const firstReliableSidebarMs = performance.now() - startedAt
          if (projection) assert.deepEqual(projection.threads.filter(thread => thread.hasUnreadInterruption).map(thread => thread.threadId).sort(), activeIds)
          const verify = new DatabaseSync(file, { readOnly: true })
          try {
            assert.equal(verify.prepare(`SELECT count(*) AS n FROM agent_run WHERE status IN ('queued','running','waiting')`).get().n, 0)
            assert.equal(verify.prepare(`SELECT count(*) AS n FROM agent_run WHERE cancel_reason_code='core_restarted'`).get().n, 3)
          } finally { verify.close() }
          report.samples.push({ variant, history, historicalNotifications: history / 10,
            recoveryCandidates: 3, sample, returnedThreads: ids.length,
            readyMs, navigationMs, projectionMs, firstReliableSidebarMs,
            sidebarRpcCount: projection ? 2 : 1, ...startupStages(host.stderr()) })
          await writeFile(output, JSON.stringify(report, null, 2) + '\n')
          if (variant === 'implementation' && history === 100 && sample === 2) {
            const intent = { commandId: crypto.randomUUID(), command: {
              threadId: activeIds[0], observedThroughChangeSequence: projection.throughChangeSequence } }
            const receipt = await host.request('notifications.acknowledgeThreadInterruptions', intent)
            assert.equal(receipt.status, 'applied')
            // Crash only this owned Core after the ACK commit; restart must not
            // resurrect it or re-admit the other recovered interruption facts.
            host.child.kill('SIGKILL')
            await within(host.closed)
            const reopened = launch()
            try {
              await ready(reopened)
              const after = await reopened.request('notifications.threadInterruptions', { threadIds: activeIds })
              assert.deepEqual(after.threads.map(thread => thread.hasUnreadInterruption), [false, true, true])
              const check = new DatabaseSync(file, { readOnly: true })
              try {
                assert.equal(check.prepare(`SELECT count(*) AS n FROM notification_occurrence WHERE interruption_kind='execution_lost'`).get().n, 3)
              } finally { check.close() }
              report.crash = { acknowledgedStayedRead: true, unacknowledgedStayedUnread: 2, interruptionFacts: 3 }
            } finally { await reopened.close() }
          }
        } catch (error) {
          throw new Error(`${variant}/${history}/${sample}: ${error.message}\n${host.stderr()}`, { cause: error })
        } finally { await host.close() }
      }
      await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: root })
    }
  }
  report.complete = true
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, report: output, samples: report.samples.length, crash: report.crash }))
} finally {
  // Files under this unique root are synthetic. Instance roots are validated by
  // the existing ownership helper, including on failed fixture admission.
  for (const history of [100, 1000, 10000]) for (const variant of ['baseline', 'implementation']) {
    await removeEphemeralRuntimeCampFilesRoot(join(root, `${variant}-${history}`, 'data'), { temporaryDirectory: root })
  }
  await rm(root, { recursive: true, force: true })
}
