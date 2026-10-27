//! Add naming preferences without rewriting existing Thread titles or occurrences.
use super::*;

pub(super) fn schema_matches(c: &Connection) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('automation')
         WHERE name='thread_naming_json' AND type='TEXT' AND [notnull]=1)",
        [],
        |row| row.get(0),
    )
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?, DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version == 164),
        "Automation naming requires schema 164"
    );
    tx.execute_batch(r#"
        ALTER TABLE automation ADD COLUMN thread_naming_json TEXT NOT NULL
            DEFAULT '{"includeDate":true,"includeTime":true,"dateFormat":"iso","timeFormat":"24","position":"suffix"}'
            CHECK(json_valid(thread_naming_json) AND json_type(thread_naming_json)='object');
        INSERT INTO schema_migration VALUES(215,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=165,updated_at=datetime('now') WHERE singleton=1;
    "#)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version == 165
        ),
        "Automation naming schema admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(c: &Connection) {
    super::hermes::downgrade_for_test(c);
    if !schema_matches(c).unwrap() {
        return;
    }
    c.execute_batch(
        "ALTER TABLE automation DROP COLUMN thread_naming_json;
        DELETE FROM schema_migration WHERE version=215;
        UPDATE rovai_data_contract SET projection_schema_version=164 WHERE singleton=1;",
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    // Owns schema 164→165 DDL/receipt atomicity, which formatter and service tests
    // cannot prove. Reuse the schema-only fixture: no member or Runtime startup.
    #[test]
    fn naming_migration_rolls_back_and_preserves_existing_threads() {
        let root = std::env::temp_dir().join(format!("rovai-automation-naming-{}", Uuid::new_v4()));
        let mut db = crate::test_support::fresh_schema_database_fast_at(&root);
        downgrade_for_test(db.connection());
        db.connection().execute_batch(r#"
            INSERT INTO automation(id,name,prompt,member_id,project_ref_json,schedule_json,created_at,updated_at)
              VALUES('kept','Weekly report','Summarize','member','{"kind":"quick_chat"}','{"kind":"manual"}','kept-created','kept-updated');
            INSERT INTO camp(id,title,project_binding_kind,project_path,created_at,updated_at)
              VALUES('kept-thread','User renamed 🌸','directory','/tmp','kept-created','kept-updated');
            CREATE TEMP TRIGGER fail_naming_receipt BEFORE INSERT ON schema_migration WHEN NEW.version=215
              BEGIN SELECT RAISE(ABORT,'naming rollback'); END;
        "#).unwrap();
        assert!(
            migrate(&mut db)
                .unwrap_err()
                .to_string()
                .contains("naming rollback")
        );
        assert!(!schema_matches(db.connection()).unwrap());
        assert!(!db.schema_migration_applied(215).unwrap());
        assert!(
            matches!(classify_database_contract(db.connection()).unwrap(), DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version == 164)
        );
        db.connection()
            .execute_batch("DROP TRIGGER fail_naming_receipt")
            .unwrap();
        drop(db);
        // Production open upgrades the old definition, without rewriting titles or timestamps.
        let db = Database::open(&root).unwrap();
        assert!(connection_has_current_data_contract(db.connection()).unwrap());
        let (naming, version, updated): (String, i64, String) = db
            .connection()
            .query_row(
                "SELECT thread_naming_json,version,updated_at FROM automation WHERE id='kept'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<crate::automation_naming::AutomationThreadNaming>(&naming)
                .unwrap(),
            Default::default()
        );
        assert_eq!((version, updated.as_str()), (1, "kept-updated"));
        let title: String = db
            .connection()
            .query_row("SELECT title FROM camp WHERE id='kept-thread'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "User renamed 🌸");
        for invalid in ["null", "[]", "invalid"] {
            assert!(
                db.connection()
                    .execute("UPDATE automation SET thread_naming_json=?1", [invalid])
                    .is_err()
            );
        }
        drop(db);
        let reopened = Database::open(&root).unwrap();
        assert!(connection_has_current_data_contract(reopened.connection()).unwrap());
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
