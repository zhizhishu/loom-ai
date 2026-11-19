//! Migration 236: local Hook snapshots and native invocation receipts. No inherited grants.
use super::*;
pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==185),
        "local Hook migration requires schema 185"
    );
    tx.execute_batch(crate::local_hook::SCHEMA_SQL)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(236,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=186,updated_at=datetime('now') WHERE singleton=1;")?;
    validate_migration_foreign_keys(&tx, &["agent_run_local_hook", "agent_run_local_hook_event"])?;
    anyhow::ensure!(
        crate::local_hook::schema_matches(&tx)?,
        "local Hook schema invalid"
    );
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::Current(ref marker) if marker.projection_schema_version==186),
        "local Hook schema admission failed"
    );
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    let applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=236)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    if !applied {
        return;
    }
    connection
        .execute_batch(
            "DROP TABLE agent_run_local_hook_event; DROP TABLE agent_run_local_hook;
        DELETE FROM schema_migration WHERE version=236;
        UPDATE rovai_data_contract SET projection_schema_version=185
        WHERE singleton=1 AND projection_schema_version=186;",
        )
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_hook_migration_236_is_atomic_and_does_not_grant_execution() {
        let root = std::env::temp_dir().join(format!(
            "loom-local-hook-migration-{}",
            uuid::Uuid::new_v4()
        ));
        let root = crate::platform::private_storage::prepare_private_directory(&root).unwrap();
        let mut db = Database::open(&root).unwrap();
        downgrade_for_test(db.connection());
        db.connection()
            .execute_batch(
                "CREATE TEMP TRIGGER refuse_local_hook_receipt BEFORE INSERT ON schema_migration
            WHEN NEW.version=236 BEGIN SELECT RAISE(ABORT,'receipt fixture'); END;",
            )
            .unwrap();
        assert!(migrate(&mut db).is_err());
        assert!(!crate::local_hook::schema_matches(db.connection()).unwrap());
        assert!(
            matches!(classify_database_contract(db.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==185)
        );
        db.connection()
            .execute_batch("DROP TRIGGER refuse_local_hook_receipt;")
            .unwrap();
        migrate(&mut db).unwrap();
        assert_eq!(
            db.connection()
                .query_row("SELECT COUNT(*) FROM agent_run_local_hook", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.connection()
                .query_row("SELECT COUNT(*) FROM agent_run_local_hook_event", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(matches!(
            classify_database_contract(db.connection()).unwrap(),
            DatabaseContractClassification::Current(_)
        ));
        assert_eq!(
            db.connection()
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }
}
