//! Only generated Web paste files need deletion eligibility; ordinary upload receipts are unchanged.
use super::*;
const SCHEMA: &str = "CREATE TABLE web_pasted_text_attachment (
    attachment_id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camp(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES web_editor_identity(client_id),
    source_path TEXT NOT NULL UNIQUE,
    entered_send_flow INTEGER NOT NULL DEFAULT 0 CHECK(entered_send_flow IN (0,1))
)";
pub(super) fn schema_matches(c: &Connection) -> rusqlite::Result<bool> {
    let sql: Option<String> = c.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='web_pasted_text_attachment'", [], |r|r.get(0)).optional()?;
    let compact = |s: &str| s.split_whitespace().collect::<String>();
    Ok(sql.as_deref().map(compact) == Some(compact(SCHEMA)))
}
pub(super) fn migrate(db: &mut Database) -> Result<()> {
    let tx = db
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?, DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==161),
        "Web pasted text requires schema 161"
    );
    tx.execute_batch(SCHEMA)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(212,datetime('now')); UPDATE rovai_data_contract SET projection_schema_version=162,updated_at=datetime('now') WHERE singleton=1;")?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::Current(_)
                | DatabaseContractClassification::SupportedMigrationSource(_)
        ),
        "Web pasted text schema admission failed"
    );
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
pub(super) fn downgrade_for_test(c: &Connection) {
    teams::downgrade_for_test(c);
    c.execute_batch("DROP TABLE IF EXISTS web_pasted_text_attachment; DELETE FROM schema_migration WHERE version=212; UPDATE rovai_data_contract SET projection_schema_version=161 WHERE projection_schema_version=162;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    // The upload HTTP owner cannot prove transactional DDL rollback at upgrade.
    // Reuse the existing schema-only fixture, without Runtime or filesystem data.
    #[test]
    fn web_pasted_text_upgrade_is_atomic_and_reopens() {
        let root = std::env::temp_dir().join(format!("rovai-web-paste-schema-{}", Uuid::new_v4()));
        let mut db = crate::test_support::fresh_schema_database_fast_at(&root);
        downgrade_for_test(db.connection());
        db.connection().execute_batch("CREATE TEMP TRIGGER fail_paste_upgrade BEFORE INSERT ON schema_migration WHEN NEW.version=212 BEGIN SELECT RAISE(ABORT,'paste rollback'); END;").unwrap();
        assert!(
            migrate(&mut db)
                .unwrap_err()
                .to_string()
                .contains("paste rollback")
        );
        assert!(!schema_matches(db.connection()).unwrap());
        assert!(
            matches!(classify_database_contract(db.connection()).unwrap(), DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==161)
        );
        db.connection()
            .execute_batch("DROP TRIGGER fail_paste_upgrade")
            .unwrap();
        migrate(&mut db).unwrap();
        assert!(schema_matches(db.connection()).unwrap());
        drop(db);
        let db = Database::open(&root).unwrap();
        assert!(matches!(
            classify_database_contract(db.connection()).unwrap(),
            DatabaseContractClassification::Current(_)
        ));
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
