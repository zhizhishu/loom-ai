import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { verifyRunningHostSchema } from './loom-host-schema.mjs'

async function fixture (t, schema = 186, migration = 236, previousReceipts = migration >= 236 ? [235] : []) {
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
  assert.equal(evidence.projectionSchema, 186)
  assert.equal(evidence.latestMigrationVersion, 236)
  assert.equal(evidence.localHookMigrationPresent, true)
  assert.equal(evidence.source, 'running-host-health-and-read-only-database')
  assert.deepEqual(f.methods, ['health.check'])
  assert.deepEqual(await readFile(f.path), before)
  const hook = await fixture(t, 185, 235)
  const hookBefore = await readFile(hook.path)
  const hookEvidence = await verifyRunningHostSchema({ request: hook.request, databasePath: hook.path,
    expectedProjectionSchema: 185, expectedMigrationVersion: 235 })
  assert.equal(hookEvidence.verified, true)
  assert.equal(hookEvidence.projectionSchema, 185)
  assert.equal(hookEvidence.latestMigrationVersion, 235)
  assert.equal(hookEvidence.localHookMigrationPresent, false)
  assert.equal(hookEvidence.artifactVersionMigrationPresent, true)
  assert.deepEqual(await readFile(hook.path), hookBefore)
})

test('an old embedded Core fails even when standalone Core build metadata claims the new version', async t => {
  const f = await fixture(t, 185, 235)
  await assert.rejects(verifyRunningHostSchema({
    request: f.request, databasePath: f.path, standaloneCoreProjectionSchema: 186
  }), error => error.hostSchema.verified === false && error.hostSchema.projectionSchema === 185
    && error.hostSchema.latestMigrationVersion === 235)
})

test('a current schema marker without its immutable-version migration receipt is rejected', async t => {
  const f = await fixture(t, 185, 234)
  await assert.rejects(verifyRunningHostSchema({ request: f.request, databasePath: f.path }),
    error => error.hostSchema.projectionSchema === 185 && error.hostSchema.artifactVersionMigrationPresent === false)
  const missingHistory = await fixture(t, 186, 236, [])
  await assert.rejects(verifyRunningHostSchema({ request: missingHistory.request, databasePath: missingHistory.path,
    expectedProjectionSchema: 186, expectedMigrationVersion: 236 }),
    error => error.hostSchema.latestMigrationVersion === 236 && error.hostSchema.artifactVersionMigrationPresent === false)
  const wrongReceipt = await fixture(t, 186, 235)
  await assert.rejects(verifyRunningHostSchema({ request: wrongReceipt.request, databasePath: wrongReceipt.path,
    expectedProjectionSchema: 186, expectedMigrationVersion: 236 }), /migration history differs/)
})

test('health from a different database cannot validate the selected isolated Host', async t => {
  const expected = await fixture(t), foreign = await fixture(t)
  await assert.rejects(verifyRunningHostSchema({ request: foreign.request, databasePath: expected.path }),
    /different database/)
  for (const [expectedProjectionSchema, expectedMigrationVersion] of [[184, 234], [185, 236], [186, 235], [187, 237]]) {
    await assert.rejects(verifyRunningHostSchema({ request: expected.request, databasePath: expected.path,
      expectedProjectionSchema, expectedMigrationVersion }), /requires a supported projection\/migration pair/)
  }
})
