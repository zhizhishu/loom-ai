// Acceptance-only verification of the Core embedded in the running Host.
// No standalone Core executable or user configuration is changed here.
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const CURRENT_HOST_SCHEMA = 187
export const CURRENT_HOST_MIGRATION = 240
const ARTIFACT_VERSION_MIGRATION = 235
const LOCAL_HOOK_MIGRATION = 236
const RECOVERY_LEDGER_MIGRATION = 237
const DELIVERY_WAKE_MIGRATION = 238
const DEVICE_SESSION_MIGRATION = 239
const WATCHDOG_STATE_MIGRATION = 240

export async function verifyRunningHostSchema ({ request, databasePath,
  expectedProjectionSchema = CURRENT_HOST_SCHEMA, expectedMigrationVersion = CURRENT_HOST_MIGRATION }) {
  const evidence = { source: 'running-host-health-and-read-only-database', readOnly: true,
    expectedProjectionSchema, expectedMigrationVersion, verified: false }
  try {
    assert.ok((expectedProjectionSchema === 186 && expectedMigrationVersion === 236)
      || (expectedProjectionSchema === 187 && expectedMigrationVersion === 237)
      || (expectedProjectionSchema === 187 && expectedMigrationVersion === 238)
      || (expectedProjectionSchema === 187 && expectedMigrationVersion === DEVICE_SESSION_MIGRATION)
      || (expectedProjectionSchema === 187 && expectedMigrationVersion === 240),
      'this acceptance requires a supported projection/migration pair (186/236, 187/237, 187/238, 187/239 or 187/240)')
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
      const localHook = database.prepare('SELECT version FROM schema_migration WHERE version = ?').get(LOCAL_HOOK_MIGRATION)
      const recoveryLedger = database.prepare('SELECT version FROM schema_migration WHERE version = ?').get(RECOVERY_LEDGER_MIGRATION)
      const deliveryWake = database.prepare('SELECT version FROM schema_migration WHERE version = ?').get(DELIVERY_WAKE_MIGRATION)
      const watchdogState = database.prepare('SELECT version FROM schema_migration WHERE version = ?').get(WATCHDOG_STATE_MIGRATION)
      evidence.localHookMigrationPresent = localHook?.version === LOCAL_HOOK_MIGRATION
      evidence.recoveryLedgerMigrationPresent = recoveryLedger?.version === RECOVERY_LEDGER_MIGRATION
      evidence.watchdogStateMigrationPresent = watchdogState?.version === WATCHDOG_STATE_MIGRATION
      const deviceSession = database.prepare('SELECT version FROM schema_migration WHERE version = ?').get(DEVICE_SESSION_MIGRATION)
      evidence.deviceSessionMigrationPresent = deviceSession?.version === DEVICE_SESSION_MIGRATION
      evidence.deliveryWakeMigrationPresent = deliveryWake?.version === DELIVERY_WAKE_MIGRATION
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
      assert.equal(evidence.localHookMigrationPresent, true, 'the local Hook migration is absent')
      if (expectedProjectionSchema === CURRENT_HOST_SCHEMA) {
        assert.equal(evidence.recoveryLedgerMigrationPresent, true,
          'the LOOM recovery ledger migration is absent')
        if (expectedMigrationVersion >= DELIVERY_WAKE_MIGRATION) {
          assert.equal(evidence.deliveryWakeMigrationPresent, true,
            'the Delivery wake migration is absent')
        }
        if (expectedMigrationVersion === WATCHDOG_STATE_MIGRATION) {
          assert.equal(evidence.watchdogStateMigrationPresent, true,
            'the LOOM watchdog state migration is absent')
        }
      }
      if (expectedMigrationVersion >= DEVICE_SESSION_MIGRATION) {
        assert.equal(evidence.deviceSessionMigrationPresent, true,
          'the device session migration is absent')
      }
      evidence.verified = true
      database.exec('COMMIT')
    } finally { database.close() }
    return evidence
  } catch (error) {
    error.hostSchema = evidence
    throw error
  }
}
