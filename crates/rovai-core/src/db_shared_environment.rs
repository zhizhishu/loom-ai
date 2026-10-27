//! New shared configuration starts empty; legacy archives remain inert.
use super::*;

const OBJECTS: &[(&str, &str)] = &[
    (
        "runtime_common_environment",
        "CREATE TABLE runtime_common_environment (
        runtime_kind TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        ciphertext BLOB NOT NULL,
        PRIMARY KEY(runtime_kind,revision)
    )",
    ),
    (
        "member_environment_inheritance",
        "CREATE TABLE member_environment_inheritance (
        member_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        revision INTEGER NOT NULL,
        inherit_common INTEGER NOT NULL CHECK(inherit_common IN (0,1)),
        PRIMARY KEY(member_id,runtime_kind,revision),
        FOREIGN KEY(member_id,runtime_kind,revision)
            REFERENCES member_runtime_environment(member_id,runtime_kind,revision)
    )",
    ),
];

pub(super) fn schema_matches(c: &Connection) -> rusqlite::Result<bool> {
    for (name, expected) in OBJECTS {
        let actual: Option<String> = c
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .optional()?;
        let compact = |s: &str| s.split_whitespace().collect::<String>();
        if actual.as_deref().map(compact) != Some(compact(expected)) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version == 160),
        "Shared environment requires schema 160"
    );
    for (_, sql) in OBJECTS {
        tx.execute_batch(sql)?;
    }
    // No old key or ciphertext is needed for migration. An absent inheritance row
    // means legacy nonempty variables are independent, empty variables inherit.
    tx.execute_batch("INSERT INTO schema_migration VALUES(211,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=161,updated_at=datetime('now') WHERE singleton=1;")?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::Current(_)
                | DatabaseContractClassification::SupportedMigrationSource(_)
        ),
        "Shared environment schema admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(c: &Connection) {
    super::web_pasted_text::downgrade_for_test(c);
    c.execute_batch("DROP TABLE IF EXISTS member_environment_inheritance;
        DROP TABLE IF EXISTS runtime_common_environment;
        DELETE FROM schema_migration WHERE version=211;
        UPDATE rovai_data_contract SET projection_schema_version=160 WHERE projection_schema_version=161;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    // Owns the schema-160 transactional upgrade, which no environment parser or
    // launch test can prove: DDL rollback and key-free migration of private data.
    #[test]
    fn shared_environment_upgrade_is_atomic_and_does_not_read_legacy_credentials() {
        let (mut database, root) = crate::test_support::seeded_runtime_database_fast();
        let c = database.connection();
        downgrade_for_test(c);
        c.execute("INSERT INTO member_runtime_environment(member_id,runtime_kind,revision,ciphertext) VALUES('agent_1','codex-cli',1,x'00')",[]).unwrap();
        c.execute("INSERT INTO runtime_environment_legacy(runtime_kind,identity,ciphertext,variable_count) VALUES('codex-cli','archive',x'00',1)",[]).unwrap();
        c.execute_batch("CREATE TEMP TRIGGER fail_shared_environment BEFORE INSERT ON schema_migration WHEN NEW.version=211 BEGIN SELECT RAISE(ABORT,'shared environment rollback'); END;").unwrap();
        assert!(
            migrate(&mut database)
                .unwrap_err()
                .to_string()
                .contains("shared environment rollback")
        );
        assert!(!schema_matches(database.connection()).unwrap());
        assert!(
            matches!(classify_database_contract(database.connection()).unwrap(), DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==160)
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER fail_shared_environment")
            .unwrap();
        migrate(&mut database).unwrap();
        let c = database.connection();
        assert!(schema_matches(c).unwrap());
        assert_eq!(
            c.query_row("SELECT count(*) FROM runtime_common_environment", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM member_environment_inheritance",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT ciphertext FROM member_runtime_environment WHERE member_id='agent_1'",
                [],
                |r| r.get::<_, Vec<u8>>(0)
            )
            .unwrap(),
            vec![0]
        );
        assert_eq!(
            c.query_row("SELECT identity FROM runtime_environment_legacy", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "archive"
        );
        assert!(!root.join("member-environment/key").exists());
        drop(database);
        let reopened = Database::open(&root).unwrap();
        assert!(matches!(
            classify_database_contract(reopened.connection()).unwrap(),
            DatabaseContractClassification::Current(_)
        ));
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
