//! Migration 233: explicit exact-definition member hook consent. No inherited approvals.
use super::*;

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 182),
        "member hook review migration requires schema 182"
    );
    tx.execute_batch(crate::member_capability::HOOK_REVIEW_SCHEMA_SQL)?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(233,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=183,updated_at=datetime('now') WHERE singleton=1;"
    )?;
    validate_migration_foreign_keys(&tx, &["member_hook_review"])?;
    anyhow::ensure!(
        crate::member_capability::hook_review_schema_matches(&tx)?,
        "member hook review schema invalid"
    );
    // 183 is only Current while nothing newer exists; the next migration must leave this
    // receipt admissible as an exact supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(ref marker) => {
            marker.projection_schema_version == 183
        }
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 183
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "member hook review schema admission failed");
    tx.commit()?;
    Ok(())
}

// Only synthetic migration fixtures reverse this projection; product code never drops it.
// A missing receipt means a fixture already pre-downgraded this step, so the drop is skipped
// instead of being hidden behind IF EXISTS for a table that should still be there.
#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    if connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=233)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap()
    {
        // The consent child table goes first so the older member catalog can still be dropped.
        connection
            .execute_batch(
                "DROP TABLE member_hook_review;
                 DELETE FROM schema_migration WHERE version=233;
                 UPDATE rovai_data_contract SET projection_schema_version=182
                   WHERE singleton=1 AND projection_schema_version IN (183);",
            )
            .unwrap();
    }
    super::loom::downgrade_for_test(connection);
}

#[cfg(test)]
pub(super) fn test_replay_182(database: &mut Database) {
    let c = database.connection();
    assert!(matches!(classify_database_contract(c).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==182));
    c.execute_batch(
        "CREATE TEMP TABLE prior_hook_items AS SELECT * FROM member_capability_item;
         CREATE TEMP TABLE prior_hook_choices AS SELECT * FROM member_capability_choice;
         CREATE TEMP TRIGGER fail_hook_review_receipt BEFORE INSERT ON schema_migration
         WHEN NEW.version=233 BEGIN SELECT RAISE(ABORT,'fixture hook receipt failure'); END;",
    )
    .unwrap();
    assert!(migrate(database).is_err());
    let c = database.connection();
    assert!(!crate::member_capability::hook_review_schema_matches(c).unwrap());
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM schema_migration WHERE version=233",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(matches!(classify_database_contract(c).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==182));
    c.execute_batch("DROP TRIGGER fail_hook_review_receipt;")
        .unwrap();
    migrate(database).unwrap();
    let c = database.connection();
    // 233 is an exact intermediate state: Current at 183 before 234, a supported source after.
    let admitted = match classify_database_contract(c).unwrap() {
        DatabaseContractClassification::Current(ref marker) => {
            marker.projection_schema_version == 183
        }
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 183
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    assert!(admitted, "233 must stay an exact 183 state");
    for sql in [
        "SELECT COUNT(*) FROM (SELECT * FROM prior_hook_items EXCEPT SELECT * FROM member_capability_item)",
        "SELECT COUNT(*) FROM (SELECT * FROM member_capability_item EXCEPT SELECT * FROM prior_hook_items)",
        "SELECT COUNT(*) FROM (SELECT * FROM prior_hook_choices EXCEPT SELECT * FROM member_capability_choice)",
        "SELECT COUNT(*) FROM (SELECT * FROM member_capability_choice EXCEPT SELECT * FROM prior_hook_choices)",
        "SELECT COUNT(*) FROM member_hook_review",
        "SELECT COUNT(*) FROM pragma_foreign_key_check",
    ] {
        assert_eq!(
            c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap(),
            0,
            "{sql}"
        );
    }
    c.execute_batch("DROP TABLE prior_hook_items; DROP TABLE prior_hook_choices;")
        .unwrap();
}
