//! Directory mode is independent of the frozen message-body publication fence.
use super::*;

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('context_manifest')
        WHERE name='live_history_directory' AND type='INTEGER')
        AND (SELECT count(*) FROM pragma_table_info('camp') WHERE name IN ('history_activity_at','history_activity_message_id','history_activity_initialized'))=3
        AND (SELECT count(*) FROM sqlite_master WHERE name IN ('camp_history_uninitialized_idx','camp_history_directory_idx','camp_message_history_activity_idx','camp_history_new','camp_history_publication','camp_history_sequence','camp_history_visibility','camp_history_message_delete','camp_history_publication_delete'))=9
        AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
            'context_directory_mode_insert','context_directory_mode_immutable','context_live_directory_no_snapshot'))=3",
        [], |row| row.get(0))
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==150),
        "Live directory requires schema 150"
    );
    // Widening history_fence_version's old CHECK would rebuild all ContextManifest rows.
    // An independent defaulted flag preserves those rows without any body scan or copy.
    tx.execute_batch("ALTER TABLE context_manifest ADD COLUMN live_history_directory INTEGER NOT NULL DEFAULT 0;
        CREATE TRIGGER context_directory_mode_insert BEFORE INSERT ON context_manifest
            WHEN NEW.live_history_directory NOT IN (0,1)
            BEGIN SELECT RAISE(ABORT, 'invalid history directory mode'); END;
        CREATE TRIGGER context_directory_mode_immutable BEFORE UPDATE OF live_history_directory ON context_manifest
            WHEN NEW.live_history_directory <> OLD.live_history_directory
            BEGIN SELECT RAISE(ABORT, 'history directory mode is fixed at creation'); END;
        CREATE TRIGGER context_live_directory_no_snapshot BEFORE INSERT ON context_manifest_history_camp
            WHEN EXISTS(SELECT 1 FROM context_manifest WHERE id=NEW.context_manifest_id AND live_history_directory=1)
            BEGIN SELECT RAISE(ABORT, 'live history directory cannot persist a snapshot'); END;
        INSERT INTO schema_migration VALUES(201,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=151,updated_at=datetime('now') WHERE singleton=1;")?;
    tx.execute_batch(include_str!("db_live_history_activity.sql"))?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::Current(_)
                | DatabaseContractClassification::SupportedMigrationSource(_)
        ),
        "Live directory admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::unified_activity::downgrade_for_test(connection);
    if !schema_matches(connection).unwrap() {
        return;
    }
    connection
        .execute_batch(
            "DROP TRIGGER camp_history_new;
        DROP TRIGGER camp_history_publication;
        DROP TRIGGER camp_history_sequence;
        DROP TRIGGER camp_history_visibility;
        DROP TRIGGER camp_history_message_delete;
        DROP TRIGGER camp_history_publication_delete;
        DROP INDEX camp_history_uninitialized_idx;
        DROP INDEX camp_history_directory_idx;
        DROP INDEX camp_message_history_activity_idx;
        ALTER TABLE camp DROP COLUMN history_activity_at;
        ALTER TABLE camp DROP COLUMN history_activity_message_id;
        ALTER TABLE camp DROP COLUMN history_activity_initialized;
        DROP TRIGGER context_live_directory_no_snapshot;
        DROP TRIGGER context_directory_mode_immutable;
        DROP TRIGGER context_directory_mode_insert;
        ALTER TABLE context_manifest DROP COLUMN live_history_directory;
        DELETE FROM schema_migration WHERE version=201;
        UPDATE rovai_data_contract SET projection_schema_version=150 WHERE singleton=1;",
        )
        .unwrap();
}

#[cfg(all(test, feature = "slow-tests"))]
pub(super) fn assert_legacy_upgrade(database: &mut Database) {
    downgrade_for_test(database.connection());
    // Only this synthetic old-mode fixture captures a directory, as the pre-upgrade writer did.
    database
        .connection
        .execute_batch(
            "INSERT INTO context_manifest_history_camp
        SELECT manifest.id,camp.id,camp.title,camp.created_at FROM context_manifest AS manifest
        JOIN agent_run AS run ON run.id=manifest.agent_run_id
        LEFT JOIN camp_turn ON camp_turn.id=run.camp_turn_id
        JOIN camp ON camp.id <> COALESCE(run.camp_id,camp_turn.camp_id);",
        )
        .unwrap();
    let before = public_history_claim_preserved_evidence_digest(database.connection()).unwrap();
    let snapshot = |c: &Connection| -> Vec<(String, String, String, String)> {
        c.prepare(
            "SELECT * FROM context_manifest_history_camp ORDER BY context_manifest_id,camp_id",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    };
    let old_directory = snapshot(database.connection());
    database
        .connection
        .execute_batch(
            "CREATE TEMP TRIGGER reject_directory_receipt BEFORE INSERT ON schema_migration
        WHEN NEW.version=201 BEGIN SELECT RAISE(ABORT,'directory receipt rollback'); END;",
        )
        .unwrap();
    assert!(
        migrate(database)
            .unwrap_err()
            .to_string()
            .contains("directory receipt rollback")
    );
    assert!(!schema_matches(database.connection()).unwrap());
    assert_eq!(snapshot(database.connection()), old_directory);
    database
        .connection
        .execute_batch("DROP TRIGGER reject_directory_receipt;")
        .unwrap();
    migrate(database).unwrap();
    super::unified_activity::migrate(database).unwrap();
    super::compact_execution::migrate(database).unwrap();
    database.migrate(false).unwrap();
    assert_eq!(
        public_history_claim_preserved_evidence_digest(database.connection()).unwrap(),
        before
    );
    probe::verify_large_directory();
    let reopened =
        Connection::open_with_flags(&database.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(snapshot(&reopened), old_directory);
    assert_eq!(
        reopened
            .query_row(
                "SELECT count(*) FROM context_manifest WHERE live_history_directory<>0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[cfg(all(test, feature = "slow-tests"))]
#[path = "db_live_directory_probe.rs"]
mod probe;
