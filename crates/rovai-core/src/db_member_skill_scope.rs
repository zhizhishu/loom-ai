//! PiBot@6741737 center-server/data/index.js:33-34 (VISIBILITY_SCOPES, isVisibleToBot), 结构对照。
//! LOOM keeps SQLite facts in Core; no learning producer is introduced.
use super::*;
const SCHEMA_SQL: &str = r#"ALTER TABLE member_skill_source ADD COLUMN owner_agent_id TEXT;
ALTER TABLE member_skill_source ADD COLUMN visibility_scope TEXT NOT NULL DEFAULT 'private' CHECK (visibility_scope IN ('private','assigned','global'));"#;
pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('member_skill_source') WHERE name IN ('owner_agent_id','visibility_scope')",
        [], |r| r.get(0))?;
    let defaults: i64 = connection.query_row(
        r#"SELECT COUNT(*) FROM pragma_table_info('member_skill_source') WHERE
          (name='owner_agent_id' AND type='TEXT' AND "notnull"=0) OR
          (name='visibility_scope' AND type='TEXT' AND "notnull"=1 AND dflt_value="'private'")"#,
        [], |r| r.get(0))?;
    Ok(columns == 2 && defaults == 2)
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
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('member_skill_source') WHERE name=?1)",
            [column], |r| r.get(0))?;
        if !exists { tx.execute_batch(statement)?; }
    }
    anyhow::ensure!(schema_matches(&tx)?, "metadata schema invalid");
    tx.execute_batch("INSERT INTO schema_migration VALUES(242,datetime('now'));")?;
    validate_migration_foreign_keys(&tx, &["member_skill_source"])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_migration_242_upgrades_existing_rows_and_preserves_projection() {
        let root = std::env::temp_dir().join(format!("loom-meta-242-{}",uuid::Uuid::new_v4()));
        let mut db = Database::open(&root).unwrap();
        assert!(db.schema_migration_applied(242).unwrap());
        assert!(schema_matches(db.connection()).unwrap());
        let version: i64 = db.connection().query_row(
            "SELECT projection_schema_version FROM rovai_data_contract WHERE singleton=1",[],|r|r.get(0)).unwrap();
        assert_eq!(version,187);
        db.connection().execute("DELETE FROM schema_migration WHERE version=242",[]).unwrap();
        migrate(&mut db).unwrap();
        assert!(db.schema_migration_applied(242).unwrap());
        assert!(migrate(&mut db).is_err());
        let connection=Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE member_skill_source (id TEXT PRIMARY KEY); INSERT INTO member_skill_source VALUES ('old');").unwrap();
        connection.execute_batch(SCHEMA_SQL).unwrap();
        let default:String=connection.query_row("SELECT visibility_scope FROM member_skill_source WHERE id='old'",[],|r|r.get(0)).unwrap();
        assert_eq!(default,"private");
        assert!(connection.execute("UPDATE member_skill_source SET visibility_scope='invalid'",[]).is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
