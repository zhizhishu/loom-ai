//! Migration 238: the persisted wake facts of a Delivery. Upstream keeps `wakeAttempts`,
//! `nextWakeAt` and `wakeLeaseUntil` on the durable event row, so an event whose wakes ran out
//! stops being re-scanned instead of being counted from its age.
//! upstream: Mikka 250d2451 lib/db/schema.ts:coordinatorEvents and
//! drizzle/20261031002604_coordinator_wake_recovery.sql
use super::*;

/// `wake_attempts` is `NOT NULL DEFAULT 0` like upstream; `next_wake_at` is nullable here only
/// because SQLite has no `DEFAULT now()` on `ADD COLUMN` — a NULL is read as "due immediately",
/// which is exactly upstream's default.
pub(super) const SCHEMA_SQL: &str = "
    ALTER TABLE camp_message_delivery ADD COLUMN wake_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE camp_message_delivery ADD COLUMN next_wake_at TEXT;
    ALTER TABLE camp_message_delivery ADD COLUMN wake_lease_until TEXT;
    CREATE INDEX IF NOT EXISTS camp_message_delivery_wake_due_idx
      ON camp_message_delivery (next_wake_at, recipient_agent_id)
      WHERE status = 'waiting' AND wake_attempts < 8;";

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let declared: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('camp_message_delivery') WHERE name IN
             ('wake_attempts','next_wake_at','wake_lease_until')",
        [],
        |row| row.get(0),
    )?;
    let not_null_default: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('camp_message_delivery')
         WHERE name = 'wake_attempts' AND \"notnull\" = 1 AND dflt_value = '0'",
        [],
        |row| row.get(0),
    )?;
    let index: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
           AND name = 'camp_message_delivery_wake_due_idx'",
        [],
        |row| row.get(0),
    )?;
    Ok(declared == 3 && not_null_default == 1 && index == 1)
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Like 236 and 237 this migration adds columns and a receipt without moving the
    // projection schema, so 187 is both the supported source marker and still Current here.
    anyhow::ensure!(
        match classify_database_contract(&tx)? {
            DatabaseContractClassification::Current(ref marker)
            | DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
                marker.projection_schema_version == 187
            }
            DatabaseContractClassification::Unknown(_) => false,
        },
        "Delivery wake migration requires schema 187"
    );
    tx.execute_batch(SCHEMA_SQL)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(238,datetime('now'));")?;
    validate_migration_foreign_keys(&tx, &["camp_message_delivery"])?;
    anyhow::ensure!(
        schema_matches(&tx)?,
        "Delivery wake schema invalid"
    );
    // 187 stays Current after 238 because nothing newer owns the marker; a later migration
    // must keep this receipt admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 187
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "Delivery wake schema admission failed");
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_wake_migration_238_persists_the_upstream_wake_columns_and_keeps_old_rows_due() {
        let root = std::env::temp_dir().join(format!(
            "loom-delivery-wake-migration-{}",
            uuid::Uuid::new_v4()
        ));
        let root = crate::platform::private_storage::prepare_private_directory(&root).unwrap();
        let db = Database::open(&root).unwrap();
        // The migration is already part of the chain; a row written before it keeps upstream's
        // default: zero attempts and an immediately due wake.
        let (attempts, next_wake_at, lease): (i64, Option<String>, Option<String>) = db
            .connection()
            .query_row(
                "SELECT wake_attempts, next_wake_at, wake_lease_until FROM camp_message_delivery LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap_or((0, None, None));
        assert_eq!(attempts, 0);
        assert!(next_wake_at.is_none() && lease.is_none());
        assert!(schema_matches(db.connection()).unwrap());
        // 238 is a receipt-only migration: the projection schema stays at 187, the marker 237
        // left behind, so a current store never claims a schema no migration owns.
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT projection_schema_version FROM rovai_data_contract WHERE singleton=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            187
        );
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT COUNT(*) FROM schema_migration WHERE version=238",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}
