//! v156 admits mutable Agent path references without legacy attachment evidence.
use super::*;

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    for (name, fragments) in [
        (
            "context_manifest",
            &[
                "context_manifest_version IN (19, 20, 21, 22, 23, 24)",
                "run_facts_schema_version IN (1, 2, 3)",
                "context_manifest_version = 24 AND formatter_version = 24",
            ][..],
        ),
        (
            "context_manifest_v24_only_insert",
            &[
                "NEW.context_manifest_version <> 24",
                "NEW.rendered_payload_digest",
            ][..],
        ),
        (
            "context_manifest_quote_profile_insert",
            &[
                "NEW.context_manifest_version>=23",
                "NEW.context_delivery_profile_version<>5",
            ][..],
        ),
        (
            "runtime_input_delivery_attachment_auth_insert",
            &[
                "NEW.runtime_request_digest IS NULL",
                "context_manifest_version=24 AND camp_attachment_view_receipt_version IS NULL",
            ][..],
        ),
    ] {
        let sql: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name=?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        if !sql.is_some_and(|sql| fragments.iter().all(|fragment| sql.contains(fragment))) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) const GUARDS: &str = r#"
        DROP TRIGGER IF EXISTS runtime_input_delivery_attachment_auth_insert;
        CREATE TRIGGER context_manifest_v24_only_insert BEFORE INSERT ON context_manifest
        WHEN NEW.context_manifest_version <> 24 AND NOT (
            NEW.context_manifest_version IN (22,23) AND NEW.formatter_version=NEW.context_manifest_version
            AND EXISTS(SELECT 1 FROM agent_run r JOIN message_delivery d ON d.id=r.trigger_message_delivery_id
                WHERE r.id=NEW.agent_run_id
                AND json_extract(d.frozen_snapshot_json,'$.frozenContext.manifestSelection.contextManifestVersion')=NEW.context_manifest_version
                AND json_extract(d.frozen_snapshot_json,'$.frozenContext.renderedPayloadDigest')=NEW.rendered_payload_digest))
        BEGIN SELECT RAISE(ABORT, 'new ContextManifest must use v24 or exact frozen legacy evidence'); END;
        CREATE TRIGGER context_manifest_quote_profile_insert BEFORE INSERT ON context_manifest
        WHEN (NEW.context_manifest_version>=23 AND NEW.context_delivery_profile_version<>5)
          OR (NEW.context_manifest_version<23 AND NEW.context_delivery_profile_version<>4)
        BEGIN SELECT RAISE(ABORT, 'ContextManifest quote profile pairing is invalid'); END;
        CREATE TRIGGER runtime_input_delivery_attachment_auth_insert BEFORE INSERT ON runtime_input_delivery
        WHEN NEW.runtime_request_digest IS NULL OR NOT (
            (NEW.runtime_attachment_auth_receipt_version IS 1 AND NEW.runtime_attachment_auth_receipt_json IS NOT NULL AND NEW.runtime_attachment_auth_receipt_digest IS NOT NULL)
            OR (NEW.runtime_attachment_auth_receipt_version IS NULL AND NEW.runtime_attachment_auth_receipt_json IS NULL AND NEW.runtime_attachment_auth_receipt_digest IS NULL
                AND EXISTS(SELECT 1 FROM context_manifest WHERE id=NEW.context_manifest_id AND context_manifest_version=24 AND camp_attachment_view_receipt_version IS NULL)))
        BEGIN SELECT RAISE(ABORT, 'Runtime Input Delivery attachment evidence does not match its manifest'); END;
    "#;

pub(super) fn apply(tx: &Transaction<'_>) -> Result<()> {
    let schema: String = tx.query_row(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='context_manifest'",
        [],
        |row| row.get(0),
    )?;
    let next = schema
        .replace("CREATE TABLE \"context_manifest\"", "CREATE TABLE context_manifest_v156")
        .replace("CREATE TABLE context_manifest (", "CREATE TABLE context_manifest_v156 (")
        .replace("formatter_version IN (20, 21, 22, 23)", "formatter_version IN (20, 21, 22, 23, 24)")
        .replace("context_manifest_version IN (19, 20, 21, 22, 23)", "context_manifest_version IN (19, 20, 21, 22, 23, 24)")
        .replace("run_facts_schema_version IN (1, 2)", "run_facts_schema_version IN (1, 2, 3)")
        .replace("(context_manifest_version = 19", "(context_manifest_version = 24 AND formatter_version = 24 AND run_facts_schema_version = 3 AND ((camp_attachment_view_receipt_version IS NULL AND camp_attachment_view_receipt_json IS NULL AND camp_attachment_view_receipt_digest IS NULL) OR (camp_attachment_view_receipt_version = 2 AND camp_attachment_view_receipt_json IS NOT NULL AND camp_attachment_view_receipt_digest IS NOT NULL)))\n                        OR\n                        (context_manifest_version = 19");
    anyhow::ensure!(
        next.contains("CREATE TABLE context_manifest_v156")
            && next.contains("context_manifest_version = 24"),
        "Attachment path ContextManifest source schema is invalid"
    );
    let dependent = migration_schema_objects(tx, "context_manifest", true)?;
    tx.execute_batch(&next)?;
    drop_rebuild_triggers(tx, &dependent)?;
    tx.execute_batch("INSERT INTO context_manifest_v156 SELECT * FROM context_manifest; DROP TABLE context_manifest; ALTER TABLE context_manifest_v156 RENAME TO context_manifest;")?;
    restore_rebuild_schema_objects(
        tx,
        "context_manifest",
        dependent
            .into_iter()
            .filter(|(_, name, _)| {
                !matches!(
                    name.as_str(),
                    "context_manifest_v23_only_insert"
                        | "context_manifest_quote_profile_insert"
                        | "runtime_input_delivery_attachment_auth_insert"
                )
            })
            .collect(),
    )?;
    tx.execute_batch(GUARDS)?;
    validate_migration_foreign_keys(tx, &["context_manifest"])?;
    Ok(())
}

impl Database {
    pub(super) fn migrate_attachment_paths_v156(&mut self) -> Result<()> {
        self.connection.execute_batch("PRAGMA foreign_keys=OFF;")?;
        let result = (|| -> Result<()> {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            anyhow::ensure!(
                matches!(classify_database_contract(&tx)?, DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.contract_version == "v1.59" && marker.projection_schema_version == 105),
                "Attachment path migration requires v1.59/schema 105"
            );
            apply(&tx)?;
            tx.execute(
                "INSERT INTO schema_migration VALUES(156, datetime('now'))",
                [],
            )?;
            tx.execute("UPDATE rovai_data_contract SET projection_schema_version=106,updated_at=datetime('now') WHERE singleton=1", [])?;
            anyhow::ensure!(
                matches!(
                    classify_database_contract(&tx)?,
                    DatabaseContractClassification::SupportedMigrationSource(ref marker)
                        if marker.contract_version == "v1.59"
                            && marker.projection_schema_version == 106
                ),
                "Attachment path schema admission failed"
            );
            tx.commit()?;
            Ok(())
        })();
        let foreign_keys = self.connection.execute_batch("PRAGMA foreign_keys=ON;");
        result?;
        foreign_keys?;
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::downgrade_current_schema_to_v156_source_for_test(connection);
    if !connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=156)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap()
    {
        return;
    }
    connection.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    let tx = connection.unchecked_transaction().unwrap();
    // Older migration owners synthesize pre-v156 input from a current fixture.
    // Preserve real legacy receipt structure only inside this test downgrade.
    let version_guard: String = tx
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='context_manifest_version_immutable'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    tx.execute_batch("DROP TRIGGER context_manifest_version_immutable")
        .unwrap();
    let rows = tx.prepare("SELECT m.id,t.camp_id FROM context_manifest m JOIN agent_run r ON r.id=m.agent_run_id JOIN camp_turn t ON t.id=r.camp_turn_id WHERE m.context_manifest_version=24").unwrap()
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    for (id, camp_id) in rows {
        let (receipt, digest) = crate::camp_attachment_view::load_camp_attachment_view_receipt(
            &tx,
            &camp_id,
            Vec::<String>::new(),
        )
        .unwrap();
        tx.execute("UPDATE context_manifest SET context_manifest_version=23,formatter_version=23,run_facts_schema_version=2,camp_attachment_view_receipt_version=2,camp_attachment_view_receipt_json=?2,camp_attachment_view_receipt_digest=?3 WHERE id=?1", params![id, serde_json::to_string(&receipt).unwrap(), digest]).unwrap();
    }
    tx.execute_batch(&version_guard).unwrap();
    let schema: String = tx
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='context_manifest'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let start = schema.find("(context_manifest_version = 24 AND").unwrap();
    let end = schema[start..]
        .find("(context_manifest_version = 19")
        .unwrap()
        + start;
    let mut previous = schema.clone();
    previous.replace_range(start..end, "");
    previous = previous
        .replace(
            "formatter_version IN (20, 21, 22, 23, 24)",
            "formatter_version IN (20, 21, 22, 23)",
        )
        .replace(
            "context_manifest_version IN (19, 20, 21, 22, 23, 24)",
            "context_manifest_version IN (19, 20, 21, 22, 23)",
        )
        .replace(
            "run_facts_schema_version IN (1, 2, 3)",
            "run_facts_schema_version IN (1, 2)",
        );
    previous = previous.replace(
        "CREATE TABLE \"context_manifest\"",
        "CREATE TABLE context_manifest_pre_paths",
    );
    tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert")
        .unwrap();
    rebuild_table_to_v135_source_for_test(
        &tx,
        "context_manifest",
        "context_manifest_pre_paths",
        &previous,
        &[
            "context_manifest_v24_only_insert",
            "context_manifest_quote_profile_insert",
            "runtime_input_delivery_attachment_auth_insert",
        ],
    );
    tx.execute_batch(r#"
        CREATE TRIGGER context_manifest_v23_only_insert BEFORE INSERT ON context_manifest
        WHEN NEW.context_manifest_version <> 23 AND NOT (
            NEW.context_manifest_version=22 AND NEW.formatter_version=22
            AND EXISTS(SELECT 1 FROM agent_run r JOIN message_delivery d ON d.id=r.trigger_message_delivery_id
                WHERE r.id=NEW.agent_run_id
                AND json_extract(d.frozen_snapshot_json,'$.frozenContext.manifestSelection.contextManifestVersion')=22
                AND json_extract(d.frozen_snapshot_json,'$.frozenContext.renderedPayloadDigest')=NEW.rendered_payload_digest))
        BEGIN SELECT RAISE(ABORT, 'new ContextManifest must use v23 or an exact frozen v22 delivery'); END;
        CREATE TRIGGER context_manifest_quote_profile_insert BEFORE INSERT ON context_manifest
        WHEN (NEW.context_manifest_version=23 AND NEW.context_delivery_profile_version<>5)
          OR (NEW.context_manifest_version<23 AND NEW.context_delivery_profile_version<>4)
        BEGIN SELECT RAISE(ABORT, 'ContextManifest quote profile pairing is invalid'); END;
        CREATE TRIGGER runtime_input_delivery_attachment_auth_insert BEFORE INSERT ON runtime_input_delivery
        WHEN NEW.runtime_attachment_auth_receipt_version IS NOT 1 OR NEW.runtime_attachment_auth_receipt_json IS NULL
          OR NEW.runtime_attachment_auth_receipt_digest IS NULL OR NEW.runtime_request_digest IS NULL
        BEGIN SELECT RAISE(ABORT, 'new Runtime Input Delivery requires Attachment Auth Receipt v1'); END;
        DELETE FROM schema_migration WHERE version=156;
        UPDATE rovai_data_contract SET projection_schema_version=105 WHERE singleton=1;
    "#).unwrap();
    tx.commit().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    #[test]
    fn attachment_path_schema_and_receipt_commit_atomically() {
        let directory = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "rovai-attachment-path-migration-{}",
                Uuid::new_v4()
            ));
        let mut database = crate::test_support::fresh_schema_database_fast_at(&directory);
        super::super::downgrade_current_schema_to_v161_source_for_test(database.connection());
        super::super::mission_context::downgrade_for_test(database.connection());
        downgrade_for_test(database.connection());
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_attachment_path_receipt BEFORE INSERT ON schema_migration WHEN NEW.version=156 BEGIN SELECT RAISE(ABORT,'attachment path receipt failure'); END;").unwrap();
        assert!(
            database
                .migrate_attachment_paths_v156()
                .unwrap_err()
                .to_string()
                .contains("attachment path receipt failure")
        );
        assert!(!schema_matches(database.connection()).unwrap());
        assert!(!database.schema_migration_applied(156).unwrap());
        assert!(
            matches!(classify_database_contract(database.connection()).unwrap(), DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==105)
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_attachment_path_receipt")
            .unwrap();
        database.migrate_attachment_paths_v156().unwrap();
        assert!(schema_matches(database.connection()).unwrap());
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.contract_version == "v1.59"
                    && marker.projection_schema_version == 106
        ));
        // A lookalike trigger name must not admit a partial schema.
        database.connection().execute_batch("DROP TRIGGER context_manifest_v24_only_insert; CREATE TRIGGER context_manifest_v24_only_insert BEFORE INSERT ON context_manifest BEGIN SELECT 1; END;").unwrap();
        assert!(!schema_matches(database.connection()).unwrap());
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
