//! Format 4 changes only future writes; old operation/body columns are not scanned or rebuilt.
use super::*;

pub(super) fn schema_matches(c: &Connection) -> rusqlite::Result<bool> {
    format_schema_matches(c, true)
}

/// A missing compact format is a complete format-3 layout, not a failed format-4 probe.
pub(super) fn pre_compact_schema_matches(c: &Connection) -> rusqlite::Result<bool> {
    format_schema_matches(c, false)
}

fn format_schema_matches(c: &Connection, compact: bool) -> rusqlite::Result<bool> {
    let digest_column: bool = c.query_row(
        "SELECT CASE WHEN ?1 THEN EXISTS(SELECT 1 FROM pragma_table_info('agent_run_execution_evidence')
            WHERE name='result_digest' AND type='TEXT' AND [notnull]=0)
        ELSE NOT EXISTS(SELECT 1 FROM pragma_table_info('agent_run_execution_evidence')
            WHERE name='result_digest') END",
        [compact],
        |r| r.get(0),
    )?;
    if !digest_column {
        return Ok(false);
    }
    let definitions = c.query_row(
        "SELECT (SELECT sql FROM sqlite_master WHERE type='view' AND name='execution_activity'),
            (SELECT sql FROM sqlite_master WHERE type='trigger' AND name='execution_evidence_storage_version_insert'),
            (SELECT sql FROM sqlite_master WHERE type='trigger' AND name='execution_activity_no_copy')",
        [],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?)),
    )?;
    let (Some(view), Some(insert), Some(no_copy)) = definitions else {
        return Ok(false);
    };
    let normalize = |sql: &str| {
        sql.chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect::<String>()
            .to_ascii_lowercase()
    };
    let view = normalize(&view);
    let insert = normalize(&insert);
    let no_copy = normalize(&no_copy);
    let allowed = if compact { "1,2,3,4" } else { "1,2,3" };
    let unified = if compact {
        "storage_versionin(3,4)"
    } else {
        "storage_version=3"
    };
    let required =
        "(new.operation_idisnullornew.input_preview_jsonisnullornew.payload_preview_json<>'{}')";
    // The original format-3 migration used IN (2,3); the test downgrade uses
    // the equivalent >=2 under the closed 1,2,3 admission set.
    let required_versions = if compact {
        vec!["new.storage_version>=2"]
    } else {
        vec!["new.storage_versionin(2,3)", "new.storage_version>=2"]
    };
    Ok(view.contains(&format!("fromagent_run_execution_evidencewhere{unified}andactivity_meta_jsonisnotnull"))
        && insert.contains(&format!("whennew.storage_versionnotin({allowed})or("))
        && required_versions.iter().any(|versions| insert.contains(&format!("{versions}and{required})beginselectraise(abort,'invalidoperationstorageformat');end")))
        && no_copy.contains(&format!("whenexists(select1fromagent_run_execution_evidencewhereagent_run_id=new.agent_run_idandexecution_epoch=new.execution_epochandoperation_id=new.operation_idand{unified})beginselectraise(abort,'unifiedoperationcannothaveanactivitycopy');end")))
}

fn route_formats(tx: &Connection, compact: bool) -> Result<()> {
    let view: String = tx.query_row(
        "SELECT sql FROM sqlite_master WHERE type='view' AND name='execution_activity'",
        [],
        |r| r.get(0),
    )?;
    let view = if compact {
        view.replace("storage_version=3", "storage_version IN (3,4)")
    } else {
        view.replace("storage_version IN (3,4)", "storage_version=3")
    };
    tx.execute_batch(
        "DROP VIEW execution_activity;
        DROP TRIGGER execution_evidence_storage_version_insert;
        DROP TRIGGER execution_activity_no_copy;",
    )?;
    tx.execute_batch(&view)?;
    let allowed = if compact { "1,2,3,4" } else { "1,2,3" };
    let unified = if compact {
        "storage_version IN (3,4)"
    } else {
        "storage_version=3"
    };
    tx.execute_batch(&format!("CREATE TRIGGER execution_evidence_storage_version_insert BEFORE INSERT ON agent_run_execution_evidence
        WHEN NEW.storage_version NOT IN ({allowed}) OR (NEW.storage_version>=2 AND
            (NEW.operation_id IS NULL OR NEW.input_preview_json IS NULL OR NEW.payload_preview_json <> '{{}}'))
        BEGIN SELECT RAISE(ABORT, 'invalid operation storage format'); END;
        CREATE TRIGGER execution_activity_no_copy BEFORE INSERT ON canonical_runtime_activity
        WHEN EXISTS(SELECT 1 FROM agent_run_execution_evidence WHERE agent_run_id=NEW.agent_run_id
            AND execution_epoch=NEW.execution_epoch AND operation_id=NEW.operation_id AND {unified})
        BEGIN SELECT RAISE(ABORT, 'unified operation cannot have an activity copy'); END;"))?;
    Ok(())
}

pub(super) fn apply_schema(c: &Connection) -> Result<()> {
    anyhow::ensure!(
        pre_compact_schema_matches(c)?,
        "Compact operation storage source is incomplete"
    );
    c.execute_batch("ALTER TABLE agent_run_execution_evidence ADD COLUMN result_digest TEXT;")?;
    route_formats(c, true)
}

pub(super) fn migrate(db: &mut Database) -> Result<()> {
    let tx = db
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,DatabaseContractClassification::SupportedMigrationSource(ref m)
        if m.projection_schema_version==152),
        "Compact operation storage requires schema 152"
    );
    apply_schema(&tx)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(203,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=153,updated_at=datetime('now') WHERE singleton=1;")?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version == 153
        ),
        "Compact storage admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(c: &Connection) {
    super::steer::downgrade_for_test(c);
    remove_compact_for_test(c);
}

#[cfg(test)]
pub(super) fn remove_compact_for_test(c: &Connection) {
    if !schema_matches(c).unwrap() {
        return;
    }
    route_formats(c, false).unwrap();
    c.execute_batch(
        "ALTER TABLE agent_run_execution_evidence DROP COLUMN result_digest;
        DELETE FROM schema_migration WHERE version=203;
        UPDATE rovai_data_contract SET projection_schema_version=152 WHERE singleton=1;",
    )
    .unwrap();
}

#[cfg(test)]
pub(super) fn assert_upgrade(db: &mut Database) {
    downgrade_for_test(db.connection());
    let snapshot = |c: &Connection| -> Vec<String> {
        c.prepare("SELECT json_array(id,payload_preview_json,input_preview_json,result_preview_json,
        input_blob_id,result_blob_id,storage_version,activity_meta_json) FROM agent_run_execution_evidence ORDER BY id").unwrap()
        .query_map([],|r|r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    };
    let before = snapshot(db.connection());
    db.connection()
        .execute_batch(
            "CREATE TEMP TRIGGER reject_compact_receipt BEFORE INSERT ON schema_migration
        WHEN NEW.version=203 BEGIN SELECT RAISE(ABORT,'compact receipt rollback'); END;",
        )
        .unwrap();
    assert!(
        migrate(db)
            .unwrap_err()
            .to_string()
            .contains("compact receipt rollback")
    );
    assert_eq!(snapshot(db.connection()), before);
    assert!(!schema_matches(db.connection()).unwrap());
    db.connection()
        .execute_batch("DROP TRIGGER reject_compact_receipt;")
        .unwrap();
    migrate(db).unwrap();
    db.migrate(false).unwrap();
    assert_eq!(snapshot(db.connection()), before);
    let c = Connection::open_with_flags(&db.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(snapshot(&c), before);
    assert!(matches!(
        classify_database_contract(&c).unwrap(),
        DatabaseContractClassification::Current(_)
    ));
}
