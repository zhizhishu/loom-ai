// Acceptance-only verification of the Core embedded in the running Host.
// No standalone Core executable or user configuration is changed here.
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const ARTIFACT_VERSION_SCHEMA = 185
export const ARTIFACT_VERSION_MIGRATION = 235

export async function verifyRunningHostSchema ({ request, databasePath,
  expectedProjectionSchema = ARTIFACT_VERSION_SCHEMA, expectedMigrationVersion = ARTIFACT_VERSION_MIGRATION }) {
  const evidence = { source: 'running-host-health-and-read-only-database', readOnly: true,
    expectedProjectionSchema, expectedMigrationVersion, verified: false }
  try {
    assert.ok((expectedProjectionSchema === 185 && expectedMigrationVersion === 235)
      || (expectedProjectionSchema === 186 && expectedMigrationVersion === 236),
      'this acceptance requires a supported projection/migration pair (185/235 or 186/236)')
    assert.ok(typeof databasePath === 'string' && isAbsolute(databasePath),
      'the isolated Host database path must be explicitly selected')
    const health = await request('health.check', {})
    assert.equal(health?.core?.ok, true, 'the running Host Core must be healthy')
    assert.equal(health?.database?.ok, true, 'the running Host database must be healthy')
    assert.ok(typeof health.database.path === 'string' && isAbsolute(health.database.path),
      'the running Host must report its actual database')
    const expectedPath = await realpath(databasePath)
    const actualPath = await realpath(health.database.path)
    evidence.databasePath = actualPath
    evidence.coreVersion = health.core.version ?? null
    assert.equal(actualPath, expectedPath, 'the running Host opened a different database')
    const database = new DatabaseSync(actualPath, { readOnly: true })
    try {
      database.exec('PRAGMA query_only = ON; BEGIN')
      const marker = database.prepare(
        'SELECT contract_version, projection_schema_version, classifier_version FROM rovai_data_contract WHERE singleton = 1'
      ).get()
      const receipt = database.prepare('SELECT MAX(version) AS latest FROM schema_migration').get()
      const migration = database.prepare('SELECT version FROM schema_migration WHERE version = ?').get(ARTIFACT_VERSION_MIGRATION)
      evidence.contractVersion = marker?.contract_version ?? null
      evidence.projectionSchema = marker?.projection_schema_version ?? null
      evidence.classifierVersion = marker?.classifier_version ?? null
      evidence.latestMigrationVersion = receipt?.latest ?? null
      evidence.artifactVersionMigrationPresent = migration?.version === ARTIFACT_VERSION_MIGRATION
      assert.equal(evidence.contractVersion, 'v1.72', 'the running Host data contract differs from the current source')
      assert.equal(evidence.projectionSchema, expectedProjectionSchema,
        'the running Host uses an old or unexpected projection schema')
      assert.equal(evidence.latestMigrationVersion, expectedMigrationVersion,
        'the running Host migration history differs from the current source')
      assert.equal(evidence.artifactVersionMigrationPresent, true, 'the artifact-version migration is absent')
      evidence.verified = true
      database.exec('COMMIT')
    } finally { database.close() }
    return evidence
  } catch (error) {
    error.hostSchema = evidence
    throw error
  }
}
