import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { verifyRunningHostSchema } from './loom-host-schema.mjs'

async function fixture (t, schema = 185, migration = 235) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-host-schema-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'rovai.sqlite')
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE rovai_data_contract(singleton INTEGER, contract_version TEXT, projection_schema_version INTEGER, classifier_version INTEGER); CREATE TABLE schema_migration(version INTEGER PRIMARY KEY)')
  database.prepare('INSERT INTO rovai_data_contract VALUES(1, ?, ?, 1)').run('v1.72', schema)
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
  assert.equal(evidence.projectionSchema, 185)
  assert.equal(evidence.latestMigrationVersion, 235)
  assert.equal(evidence.source, 'running-host-health-and-read-only-database')
  assert.deepEqual(f.methods, ['health.check'])
  assert.deepEqual(await readFile(f.path), before)
})

test('an old embedded Core fails even when standalone Core build metadata claims the new version', async t => {
  const f = await fixture(t, 184, 234)
  await assert.rejects(verifyRunningHostSchema({
    request: f.request, databasePath: f.path, standaloneCoreProjectionSchema: 185
  }), error => error.hostSchema.verified === false && error.hostSchema.projectionSchema === 184
    && error.hostSchema.latestMigrationVersion === 234)
})

test('a current schema marker without its immutable-version migration receipt is rejected', async t => {
  const f = await fixture(t, 185, 234)
  await assert.rejects(verifyRunningHostSchema({ request: f.request, databasePath: f.path }),
    error => error.hostSchema.projectionSchema === 185 && error.hostSchema.artifactVersionMigrationPresent === false)
})

test('health from a different database cannot validate the selected isolated Host', async t => {
  const expected = await fixture(t), foreign = await fixture(t)
  await assert.rejects(verifyRunningHostSchema({ request: foreign.request, databasePath: expected.path }),
    /different database/)
  await assert.rejects(verifyRunningHostSchema({
    request: expected.request, databasePath: expected.path, expectedProjectionSchema: 184
  }), /requires the artifact-version schema/)
})
