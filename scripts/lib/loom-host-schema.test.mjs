import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { verifyRunningHostSchema } from './loom-host-schema.mjs'

// Migration 240 (the LOOM watchdog state on the durable recovery ledger) is the current receipt,
// so a current database also carries 235, 236, 237 and 238 (the Delivery wake persistence).
// 238 and 240 add columns only, so the projection schema stays 187.
const priorReceipts = migration => migration >= 240 ? [235, 236, 237, 238]
  : migration >= 238 ? [235, 236, 237]
  : migration >= 237 ? [235, 236] : migration >= 236 ? [235] : []

async function fixture (t, schema = 187, migration = 240, previousReceipts = priorReceipts(migration)) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-host-schema-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'rovai.sqlite')
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE rovai_data_contract(singleton INTEGER, contract_version TEXT, projection_schema_version INTEGER, classifier_version INTEGER); CREATE TABLE schema_migration(version INTEGER PRIMARY KEY)')
  database.prepare('INSERT INTO rovai_data_contract VALUES(1, ?, ?, 1)').run('v1.72', schema)
  for (const previous of previousReceipts) database.prepare('INSERT INTO schema_migration VALUES(?)').run(previous)
  database.prepare('INSERT INTO schema_migration VALUES(?)').run(migration)
  database.close()
  const methods = []
  return { path, methods, request: async method => {
    methods.push(method)
    return { core: { ok: true, version: 'test-embedded' }, database: { ok: true, path } }
  } }
}

test('the running Host actual schema is verified read-only, with no runtime or standalone Core calls', async t => {
  const f = await fixture(t)
  const before = await readFile(f.path)
  const evidence = await verifyRunningHostSchema({ request: f.request, databasePath: f.path })
  assert.equal(evidence.verified, true)
  assert.equal(evidence.projectionSchema, 187)
  assert.equal(evidence.latestMigrationVersion, 240)
  assert.equal(evidence.localHookMigrationPresent, true)
  assert.equal(evidence.recoveryLedgerMigrationPresent, true)
  assert.equal(evidence.watchdogStateMigrationPresent, true)
  assert.equal(evidence.deliveryWakeMigrationPresent, true)
  assert.equal(evidence.source, 'running-host-health-and-read-only-database')
  assert.deepEqual(f.methods, ['health.check'])
  assert.deepEqual(await readFile(f.path), before)
  // The previous pair stays a supported source: its ledger receipt is simply absent.
  const hook = await fixture(t, 186, 236)
  const hookBefore = await readFile(hook.path)
  const hookEvidence = await verifyRunningHostSchema({ request: hook.request, databasePath: hook.path,
    expectedProjectionSchema: 186, expectedMigrationVersion: 236 })
  assert.equal(hookEvidence.verified, true)
  assert.equal(hookEvidence.projectionSchema, 186)
  assert.equal(hookEvidence.latestMigrationVersion, 236)
  assert.equal(hookEvidence.localHookMigrationPresent, true)
  assert.equal(hookEvidence.recoveryLedgerMigrationPresent, false)
  assert.equal(hookEvidence.watchdogStateMigrationPresent, false)
  assert.equal(hookEvidence.artifactVersionMigrationPresent, true)
  assert.deepEqual(await readFile(hook.path), hookBefore)
})

test('an old embedded Core fails even when standalone Core build metadata claims the new version', async t => {
  const f = await fixture(t, 186, 236)
  await assert.rejects(verifyRunningHostSchema({
    request: f.request, databasePath: f.path, standaloneCoreProjectionSchema: 187
  }), error => error.hostSchema.verified === false && error.hostSchema.projectionSchema === 186
    && error.hostSchema.latestMigrationVersion === 236)
})

test('a current schema marker without its immutable-version migration receipt is rejected', async t => {
  // 186/236 is a supported pair, but this fixture kept only its own receipt.
  const f = await fixture(t, 186, 236, [])
  await assert.rejects(verifyRunningHostSchema({ request: f.request, databasePath: f.path,
    expectedProjectionSchema: 186, expectedMigrationVersion: 236 }),
    error => error.hostSchema.projectionSchema === 186 && error.hostSchema.artifactVersionMigrationPresent === false)
  const missingHistory = await fixture(t, 187, 238, [])
  await assert.rejects(verifyRunningHostSchema({ request: missingHistory.request, databasePath: missingHistory.path,
    expectedProjectionSchema: 187, expectedMigrationVersion: 238 }),
    error => error.hostSchema.latestMigrationVersion === 238 && error.hostSchema.artifactVersionMigrationPresent === false)
  // A current marker whose history stops at the local Hook migration is an old Core.
  const wrongReceipt = await fixture(t, 187, 236, [235])
  await assert.rejects(verifyRunningHostSchema({ request: wrongReceipt.request, databasePath: wrongReceipt.path,
    expectedProjectionSchema: 187, expectedMigrationVersion: 238 }), /migration history differs/)
  // The local Hook receipt is required even when the newest receipt is present.
  const missingLocalHook = await fixture(t, 187, 238, [235, 237])
  await assert.rejects(verifyRunningHostSchema({ request: missingLocalHook.request, databasePath: missingLocalHook.path,
    expectedProjectionSchema: 187, expectedMigrationVersion: 238 }), /local Hook migration is absent/)
})

test('health from a different database cannot validate the selected isolated Host', async t => {
  const expected = await fixture(t), foreign = await fixture(t)
  await assert.rejects(verifyRunningHostSchema({ request: foreign.request, databasePath: expected.path }),
    /different database/)
  for (const [expectedProjectionSchema, expectedMigrationVersion] of [[185, 235], [186, 237], [187, 236], [188, 240], [189, 239]]) {
    await assert.rejects(verifyRunningHostSchema({ request: expected.request, databasePath: expected.path,
      expectedProjectionSchema, expectedMigrationVersion }), /requires a supported projection\/migration pair/)
  }
})
