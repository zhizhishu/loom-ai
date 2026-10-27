//! New lifecycle rows keep independent input/result previews; legacy bodies stay untouched.
use super::*;

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agent_run_execution_evidence')
            WHERE name='storage_version' AND type='INTEGER')
         AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger'
            AND name='execution_evidence_storage_version_immutable')
         AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger'
            AND name='execution_evidence_storage_version_insert')
         AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_blob'
            AND instr(sql, '''camp_deletion''') > 0)",
        [],
        |row| row.get(0),
    )
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    database
        .connection
        .execute_batch("PRAGMA foreign_keys=OFF;")?;
    let result = (|| -> Result<()> {
        let tx = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        anyhow::ensure!(
            matches!(classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 149),
            "Execution storage requires schema 149"
        );
        // Only Managed Blob metadata is rebuilt to extend its closed GC-owner set.
        // No evidence rows or Blob files are read or rewritten by this migration.
        expand_closed_set(
            &tx,
            "managed_blob",
            "'execution_lifecycle', 'file_change_projection'",
            "'execution_lifecycle', 'file_change_projection', 'camp_deletion'",
        )?;
        // A column CHECK would force SQLite to scan all old evidence; guard new writes instead.
        tx.execute_batch("ALTER TABLE agent_run_execution_evidence ADD COLUMN storage_version INTEGER NOT NULL DEFAULT 1;
            CREATE TRIGGER execution_evidence_storage_version_insert BEFORE INSERT ON agent_run_execution_evidence
                WHEN NEW.storage_version NOT IN (1, 2) OR (NEW.storage_version = 2 AND
                    (NEW.operation_id IS NULL OR NEW.input_preview_json IS NULL OR NEW.payload_preview_json <> '{}'))
                BEGIN SELECT RAISE(ABORT, 'invalid operation storage format'); END;
            CREATE TRIGGER execution_evidence_storage_version_immutable
                BEFORE UPDATE OF storage_version ON agent_run_execution_evidence
                WHEN NEW.storage_version <> OLD.storage_version
                BEGIN SELECT RAISE(ABORT, 'operation storage format is fixed at creation'); END;
            INSERT INTO schema_migration VALUES(200,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=150,updated_at=datetime('now') WHERE singleton=1;")?;
        anyhow::ensure!(
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::Current(_)
                    | DatabaseContractClassification::SupportedMigrationSource(_)
            ),
            "Execution storage admission failed"
        );
        tx.commit()?;
        Ok(())
    })();
    let restored = database.connection.execute_batch("PRAGMA foreign_keys=ON;");
    result?;
    restored?;
    Ok(())
}

// Only synthetic migration fixtures call this; product code never downgrades a row.
#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::live_directory::downgrade_for_test(connection);
    if !schema_matches(connection).unwrap() {
        return;
    }
    connection
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .unwrap();
    let tx = connection.unchecked_transaction().unwrap();
    tx.execute_batch(
        "DROP TRIGGER execution_evidence_storage_version_insert;
        DROP TRIGGER execution_evidence_storage_version_immutable;
        ALTER TABLE agent_run_execution_evidence DROP COLUMN storage_version;
        DELETE FROM schema_migration WHERE version=200;
        UPDATE rovai_data_contract SET projection_schema_version=149 WHERE singleton=1;",
    )
    .unwrap();
    expand_closed_set(
        &tx,
        "managed_blob",
        "'execution_lifecycle', 'file_change_projection', 'camp_deletion'",
        "'execution_lifecycle', 'file_change_projection'",
    )
    .unwrap();
    tx.commit().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
}

#[cfg(test)]
pub(super) fn assert_upgrade(database: &mut Database) {
    // Seed a populated v149 fixture, never production data.
    database.connection.execute_batch("UPDATE agent_run_execution_evidence SET payload_preview_json =
        rovai_execution_preview(storage_version,payload_preview_json,input_preview_json,result_preview_json);").unwrap();
    downgrade_for_test(database.connection());
    let snapshot =
        |connection: &Connection| -> Vec<(String, String, Option<String>, Option<String>)> {
            connection.prepare("SELECT id,payload_preview_json,input_blob_id,result_blob_id FROM agent_run_execution_evidence ORDER BY id")
            .unwrap().query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
    let before = snapshot(database.connection());
    database
        .connection
        .execute_batch(
            "CREATE TEMP TRIGGER reject_storage_receipt BEFORE INSERT ON schema_migration
        WHEN NEW.version=200 BEGIN SELECT RAISE(ABORT,'storage receipt rollback'); END;",
        )
        .unwrap();
    assert!(
        migrate(database)
            .unwrap_err()
            .to_string()
            .contains("storage receipt rollback")
    );
    assert_eq!(snapshot(database.connection()), before);
    assert!(!schema_matches(database.connection()).unwrap());
    database
        .connection
        .execute_batch("DROP TRIGGER reject_storage_receipt;")
        .unwrap();
    migrate(database).unwrap();
    assert_eq!(snapshot(database.connection()), before);
    super::live_directory::migrate(database).unwrap();
    super::unified_activity::migrate(database).unwrap();
    super::compact_execution::migrate(database).unwrap();
    database.migrate(false).unwrap();
    assert!(matches!(
        classify_database_contract(database.connection()).unwrap(),
        DatabaseContractClassification::Current(_)
    ));
    assert_eq!(
        database
            .connection
            .query_row(
                "SELECT count(*) FROM agent_run_execution_evidence WHERE storage_version <> 1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let reopened =
        Connection::open_with_flags(&database.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        snapshot(&reopened),
        before,
        "restart must keep legacy bytes and Blob references"
    );
    let mut old_chain = load_current_migration_state(database.connection()).unwrap();
    old_chain.v200 = false;
    assert!(
        !old_chain.admits("v1.72", 150, V147_CLASSIFIER_VERSION),
        "schema 149 writers cannot admit the new marker"
    );
}
