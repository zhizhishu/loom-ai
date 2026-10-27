//! Small display facts live on the operation. The compatibility view stores no rows.
use super::*;

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row("SELECT (SELECT count(*) FROM pragma_table_info('agent_run_execution_evidence')
        WHERE name IN ('activity_meta_json','activity_started_at','activity_terminal_at'))=3
        AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='execution_activity')
        AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='execution_activity_no_copy')",
        [], |r| r.get(0))
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==151),
        "Unified operation activity requires schema 151"
    );
    tx.execute_batch("ALTER TABLE agent_run_execution_evidence ADD COLUMN activity_meta_json TEXT;
        ALTER TABLE agent_run_execution_evidence ADD COLUMN activity_started_at TEXT;
        ALTER TABLE agent_run_execution_evidence ADD COLUMN activity_terminal_at TEXT;
        DROP TRIGGER execution_evidence_storage_version_insert;
        CREATE TRIGGER execution_evidence_storage_version_insert BEFORE INSERT ON agent_run_execution_evidence
            WHEN NEW.storage_version NOT IN (1,2,3) OR (NEW.storage_version IN (2,3) AND
                (NEW.operation_id IS NULL OR NEW.input_preview_json IS NULL OR NEW.payload_preview_json <> '{}'))
            BEGIN SELECT RAISE(ABORT, 'invalid operation storage format'); END;
        CREATE TRIGGER execution_activity_no_copy BEFORE INSERT ON canonical_runtime_activity
            WHEN EXISTS(SELECT 1 FROM agent_run_execution_evidence
                WHERE agent_run_id=NEW.agent_run_id AND execution_epoch=NEW.execution_epoch
                AND operation_id=NEW.operation_id AND storage_version=3)
            BEGIN SELECT RAISE(ABORT, 'unified operation cannot have an activity copy'); END;
        CREATE VIEW execution_activity AS
        SELECT agent_run_id, execution_epoch, operation_id, classifier_version,
            activity_domain, semantic_kind, tool_name, presentation_hint, diff_projection_json,
            phase, outcome, credibility, coverage_level, source_authority, source_evidence_ids_json,
            first_evidence_sequence, last_evidence_sequence, revision, created_at, updated_at,
            started_at, terminal_at FROM canonical_runtime_activity
        UNION ALL
        SELECT agent_run_id, execution_epoch, operation_id,
            json_extract(activity_meta_json,'$.classifierVersion'),
            json_extract(activity_meta_json,'$.activityDomain'),
            json_extract(activity_meta_json,'$.semanticKind'),
            json_extract(activity_meta_json,'$.toolName'),
            json_extract(activity_meta_json,'$.presentationHint'),
            json_extract(activity_meta_json,'$.diffProjection'),
            json_extract(activity_meta_json,'$.phase'),
            json_extract(activity_meta_json,'$.outcome'),
            json_extract(activity_meta_json,'$.credibility'),
            json_extract(activity_meta_json,'$.coverageLevel'),
            json_extract(activity_meta_json,'$.sourceAuthority'),
            json_array(id), sequence, sequence, revision, occurred_at, COALESCE(updated_at,occurred_at),
            activity_started_at, activity_terminal_at
        FROM agent_run_execution_evidence WHERE storage_version=3 AND activity_meta_json IS NOT NULL;
        INSERT INTO schema_migration VALUES(202,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=152,updated_at=datetime('now') WHERE singleton=1;")?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::Current(_)
                | DatabaseContractClassification::SupportedMigrationSource(_)
        ),
        "Unified operation activity admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::compact_execution::downgrade_for_test(connection);
    if !schema_matches(connection).unwrap() {
        return;
    }
    connection.execute_batch("DROP VIEW execution_activity;
        DROP TRIGGER execution_activity_no_copy;
        ALTER TABLE agent_run_execution_evidence DROP COLUMN activity_meta_json;
        ALTER TABLE agent_run_execution_evidence DROP COLUMN activity_started_at;
        ALTER TABLE agent_run_execution_evidence DROP COLUMN activity_terminal_at;
        DROP TRIGGER execution_evidence_storage_version_insert;
        CREATE TRIGGER execution_evidence_storage_version_insert BEFORE INSERT ON agent_run_execution_evidence
            WHEN NEW.storage_version NOT IN (1,2) OR (NEW.storage_version=2 AND
                (NEW.operation_id IS NULL OR NEW.input_preview_json IS NULL OR NEW.payload_preview_json <> '{}'))
            BEGIN SELECT RAISE(ABORT, 'invalid operation storage format'); END;
        DELETE FROM schema_migration WHERE version=202;
        UPDATE rovai_data_contract SET projection_schema_version=151 WHERE singleton=1;").unwrap();
}

#[cfg(test)]
pub(super) fn assert_upgrade(database: &mut Database) {
    downgrade_for_test(database.connection());
    let snapshot = |c: &Connection| -> Vec<String> {
        c.prepare("SELECT json_array(e.id,e.payload_preview_json,e.input_preview_json,e.input_blob_id,
            e.result_preview_json,e.result_blob_id,e.storage_version,a.diff_projection_json,a.phase,a.outcome,a.started_at)
            FROM agent_run_execution_evidence e LEFT JOIN canonical_runtime_activity a
              ON a.agent_run_id=e.agent_run_id AND a.operation_id=e.operation_id
            ORDER BY e.id,a.classifier_version").unwrap().query_map([],|r|r.get(0)).unwrap()
            .collect::<rusqlite::Result<_>>().unwrap()
    };
    let before = snapshot(database.connection());
    database
        .connection
        .execute_batch(
            "CREATE TEMP TRIGGER reject_activity_receipt BEFORE INSERT ON schema_migration
        WHEN NEW.version=202 BEGIN SELECT RAISE(ABORT,'activity receipt rollback'); END;",
        )
        .unwrap();
    let error = migrate(database).unwrap_err();
    assert!(
        error.to_string().contains("activity receipt rollback"),
        "{error:#}; {:?}",
        classify_database_contract(database.connection()).unwrap()
    );
    assert!(!schema_matches(database.connection()).unwrap());
    assert_eq!(snapshot(database.connection()), before);
    database
        .connection
        .execute_batch("DROP TRIGGER reject_activity_receipt;")
        .unwrap();
    migrate(database).unwrap();
    super::compact_execution::migrate(database).unwrap();
    database.migrate(false).unwrap();
    assert_eq!(snapshot(database.connection()), before);
    let reopened =
        Connection::open_with_flags(&database.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(snapshot(&reopened), before);
    assert!(matches!(
        classify_database_contract(&reopened).unwrap(),
        DatabaseContractClassification::Current(_)
    ));
}
