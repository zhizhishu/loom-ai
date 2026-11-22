//! Additive metadata adapted from PiBot center-server/data/index.js and BotSkillsPage.tsx.
//! LOOM keeps SQLite facts in Core; no learning producer is introduced.
use super::*;
const SCHEMA_SQL: &str = r#"ALTER TABLE skill ADD COLUMN learned_by_agent_id TEXT;
ALTER TABLE skill ADD COLUMN learned_state TEXT NOT NULL DEFAULT 'active' CHECK (learned_state IN ('active','stale','archived'));
ALTER TABLE skill ADD COLUMN learned_pinned INTEGER NOT NULL DEFAULT 0 CHECK (learned_pinned IN (0,1));
ALTER TABLE skill ADD COLUMN learned_locked INTEGER NOT NULL DEFAULT 0 CHECK (learned_locked IN (0,1));"#;
pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('skill') WHERE name IN ('learned_by_agent_id','learned_state','learned_pinned','learned_locked')",
        [], |r| r.get(0))?;
    Ok(columns == 4)
}
pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::Current(ref m) |
        DatabaseContractClassification::SupportedMigrationSource(ref m)
        if m.projection_schema_version == 187), "metadata migration requires schema 187");
    for statement in SCHEMA_SQL.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let column = statement.split_whitespace().nth(5).unwrap();
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('skill') WHERE name=?1)",
            [column], |r| r.get(0))?;
        if !exists { tx.execute_batch(statement)?; }
    }
    anyhow::ensure!(schema_matches(&tx)?, "metadata schema invalid");
    tx.execute_batch("INSERT INTO schema_migration VALUES(243,datetime('now'));")?;
    validate_migration_foreign_keys(&tx, &["skill"])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_migration_243_upgrades_existing_rows_and_preserves_projection() {
        let root = std::env::temp_dir().join(format!("loom-meta-243-{}",uuid::Uuid::new_v4()));
        let mut db = Database::open(&root).unwrap();
        assert!(db.schema_migration_applied(243).unwrap());
        assert!(schema_matches(db.connection()).unwrap());
        let version: i64 = db.connection().query_row(
            "SELECT projection_schema_version FROM rovai_data_contract WHERE singleton=1",[],|r|r.get(0)).unwrap();
        assert_eq!(version,187);
        db.connection().execute("DELETE FROM schema_migration WHERE version=243",[]).unwrap();
        migrate(&mut db).unwrap();
        assert!(db.schema_migration_applied(243).unwrap());
        assert!(migrate(&mut db).is_err());
        let connection=Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE skill (id TEXT PRIMARY KEY); INSERT INTO skill VALUES ('old');").unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        let default:String=connection.query_row("SELECT learned_state FROM skill WHERE id='old'",[],|r|r.get(0)).unwrap();
        assert_eq!(default,"active");
        assert!(connection.execute("UPDATE skill SET learned_state='invalid'",[]).is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
