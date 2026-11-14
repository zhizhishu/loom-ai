//! Migration 234: explicit member catalog sources for already imported Skill Library entries.
//! The Library keeps the text; this registry only records which imported Skill a member may pick.
use super::*;

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 183),
        "member Skill source migration requires schema 183"
    );
    tx.execute_batch(crate::member_capability::SKILL_SOURCE_SCHEMA_SQL)?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(234,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=184,updated_at=datetime('now') WHERE singleton=1;"
    )?;
    validate_migration_foreign_keys(&tx, &["member_skill_source"])?;
    anyhow::ensure!(
        crate::member_capability::skill_source_schema_matches(&tx)?,
        "member Skill source schema invalid"
    );
    // 184 is only Current while nothing newer exists; a later migration must leave this
    // receipt admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 184
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "member Skill source schema admission failed");
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn test_replay_183(database: &mut Database) {
    let c = database.connection();
    assert!(matches!(classify_database_contract(c).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==183));
    c.execute_batch(
        "CREATE TEMP TABLE prior_skill_rows AS SELECT * FROM skill;
         CREATE TEMP TRIGGER fail_skill_source_receipt BEFORE INSERT ON schema_migration
         WHEN NEW.version=234 BEGIN SELECT RAISE(ABORT,'fixture skill source receipt failure'); END;",
    )
    .unwrap();
    assert!(migrate(database).is_err());
    let c = database.connection();
    assert!(!crate::member_capability::skill_source_schema_matches(c).unwrap());
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM schema_migration WHERE version=234",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(matches!(classify_database_contract(c).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==183));
    c.execute_batch("DROP TRIGGER fail_skill_source_receipt;")
        .unwrap();
    migrate(database).unwrap();
    let c = database.connection();
    assert!(connection_has_current_data_contract(c).unwrap());
    for sql in [
        "SELECT COUNT(*) FROM (SELECT * FROM prior_skill_rows EXCEPT SELECT * FROM skill)",
        "SELECT COUNT(*) FROM (SELECT * FROM skill EXCEPT SELECT * FROM prior_skill_rows)",
        "SELECT COUNT(*) FROM member_skill_source",
        "SELECT COUNT(*) FROM pragma_foreign_key_check",
    ] {
        assert_eq!(
            c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap(),
            0,
            "{sql}"
        );
    }
    c.execute_batch("DROP TABLE prior_skill_rows;").unwrap();
}
