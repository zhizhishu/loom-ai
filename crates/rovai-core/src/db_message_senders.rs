//! Add sender projection formats without rewriting frozen context or Session identities.
use super::*;

fn schema(connection: &Connection, kind: &str, name: &str) -> Result<String> {
    Ok(connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
        params![kind, name],
        |row| row.get(0),
    )?)
}

const OLD_VERSIONS: &str = "29, 30, 31, 32, 33, 34, 35, 36)";
const NEW_VERSIONS: &str = "29, 30, 31, 32, 33, 34, 35, 36, 37, 38)";
const OLD_INPUT: &str = "29, 30, 31, 32, 33, 34, 36)";
const NEW_INPUT: &str = "29, 30, 31, 32, 33, 34, 36, 38)";
const FACT36: &str = "(context_manifest_version = 36 AND formatter_version = 36 AND run_facts_schema_version = 9 AND ((camp_attachment_view_receipt_version IS NULL AND camp_attachment_view_receipt_json IS NULL AND camp_attachment_view_receipt_digest IS NULL) OR (camp_attachment_view_receipt_version = 2 AND camp_attachment_view_receipt_json IS NOT NULL AND camp_attachment_view_receipt_digest IS NOT NULL)))";
const PROFILE: &str = "(NEW.context_manifest_version = 37 AND NEW.context_delivery_profile_version = 12) OR (NEW.context_manifest_version = 38 AND NEW.context_delivery_profile_version = 13) OR ";

fn replace_required(sql: String, from: &str, to: &str) -> Result<String> {
    anyhow::ensure!(
        sql.contains(from),
        "Sender context migration source shape mismatch: {from}"
    );
    Ok(sql.replace(from, to))
}

fn facts() -> String {
    format!(
        "{}\n OR\n {}\n OR\n ",
        FACT36
            .replace("= 36", "= 37")
            .replace("schema_version = 9", "schema_version = 6"),
        FACT36.replace("= 36", "= 38")
    )
}

fn admissions(old: &str) -> Result<String> {
    let start = old
        .find("(NEW.context_manifest_version = 36")
        .context("missing v36 admission")?;
    let end = start
        + old[start..]
            .find("\n OR\n")
            .context("missing v36 admission boundary")?;
    let mut batch = old[start..end].to_owned();
    for (from, to) in [
        (
            "NEW.context_manifest_version = 36",
            "NEW.context_manifest_version = 38",
        ),
        ("NEW.formatter_version = 36", "NEW.formatter_version = 38"),
        (
            "input.context_manifest_version = 36",
            "input.context_manifest_version = 38",
        ),
        (
            "input.context_manifest_version IS NOT 36",
            "input.context_manifest_version IS NOT 38",
        ),
    ] {
        batch = replace_required(batch, from, to)?;
    }
    Ok(format!(
        "{batch}\n OR\n (NEW.context_manifest_version = 37 AND NEW.formatter_version = 37 AND NEW.run_facts_schema_version = 6 AND NEW.context_delivery_profile_version = 12 AND EXISTS(SELECT 1 FROM agent_run AS run WHERE run.id=NEW.agent_run_id AND run.invocation_kind <> 'batch'))\n OR\n"
    ))
}

pub(super) fn schema_matches(connection: &Connection) -> bool {
    connection.query_row("SELECT count(*)=3 FROM sqlite_master WHERE type='trigger'
        AND name IN ('agent_run_claim_context_immutable','agent_run_input_v38_only_insert','context_manifest_v38_only_insert')",
        [], |row| row.get(0)).unwrap_or(false)
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
            DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version == 148),
            "Sender context requires schema 148"
        );
        let manifest = replace_required(
            replace_required(
                replacement_table_schema_v171(
                    schema(&tx, "table", "context_manifest")?,
                    "context_manifest",
                ),
                OLD_VERSIONS,
                NEW_VERSIONS,
            )?,
            FACT36,
            &format!("{}{FACT36}", facts()),
        )?;
        let input = replace_required(
            replacement_table_schema_v171(
                schema(&tx, "table", "agent_run_input")?,
                "agent_run_input",
            ),
            OLD_INPUT,
            NEW_INPUT,
        )?;
        let old_guard = schema(&tx, "trigger", "context_manifest_v36_only_insert")?;
        let guard = replace_required(
            old_guard.clone(),
            "WHEN NOT (",
            &format!("WHEN NOT ({}", admissions(&old_guard)?),
        )?
        .replace(
            "context_manifest_v36_only_insert",
            "context_manifest_v38_only_insert",
        );
        let profile = replace_required(
            schema(&tx, "trigger", "context_manifest_quote_profile_insert")?,
            "WHEN NOT (",
            &format!("WHEN NOT ({PROFILE}"),
        )?;
        let attachment = replace_required(
            schema(
                &tx,
                "trigger",
                "runtime_input_delivery_attachment_auth_insert",
            )?,
            OLD_VERSIONS,
            NEW_VERSIONS,
        )?;
        rebuild_table_v171(
            &tx,
            "context_manifest",
            &manifest,
            &[],
            &[
                "context_manifest_v36_only_insert",
                "context_manifest_quote_profile_insert",
            ],
        )?;
        rebuild_table_v171(
            &tx,
            "agent_run_input",
            &input,
            &[],
            &["agent_run_input_v36_only_insert"],
        )?;
        tx.execute_batch(&guard)?;
        tx.execute_batch(&profile)?;
        tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")?;
        tx.execute_batch(&attachment)?;
        tx.execute_batch("CREATE TRIGGER agent_run_input_v38_only_insert BEFORE INSERT ON agent_run_input
            WHEN NEW.context_manifest_version IS NOT 38 BEGIN SELECT RAISE(ABORT, 'new public Thread AgentRunInput must use ContextManifest v38'); END;
            INSERT INTO schema_migration VALUES(199,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=149,updated_at=datetime('now') WHERE singleton=1;")?;
        validate_migration_foreign_keys(
            &tx,
            &[
                "context_manifest",
                "agent_run_input",
                "agent_run_claim_context",
            ],
        )?;
        anyhow::ensure!(
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::Current(_)
                    | DatabaseContractClassification::SupportedMigrationSource(_)
            ),
            "Sender context admission failed"
        );
        tx.commit()?;
        Ok(())
    })();
    database
        .connection
        .execute_batch("PRAGMA foreign_keys=ON;")?;
    result
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::execution_storage::downgrade_for_test(connection);
    let applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=199)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    if !applied {
        return;
    }
    connection
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .unwrap();
    let tx = connection.unchecked_transaction().unwrap();
    let immutable = schema(&tx, "trigger", "context_manifest_version_immutable").unwrap();
    let input_immutable = schema(
        &tx,
        "trigger",
        "agent_run_input_context_projection_immutable",
    )
    .unwrap();
    tx.execute_batch("DROP TRIGGER context_manifest_version_immutable; DROP TRIGGER agent_run_input_context_projection_immutable;
        UPDATE context_manifest SET context_manifest_version=36,formatter_version=36 WHERE context_manifest_version=38;
        UPDATE context_manifest SET context_manifest_version=35,formatter_version=35 WHERE context_manifest_version=37;
        UPDATE agent_run_input SET context_manifest_version=36 WHERE context_manifest_version=38;").unwrap();
    tx.execute_batch(&immutable).unwrap();
    tx.execute_batch(&input_immutable).unwrap();
    let manifest = replacement_table_schema_v171(
        schema(&tx, "table", "context_manifest").unwrap(),
        "context_manifest",
    )
    .replace(NEW_VERSIONS, OLD_VERSIONS)
    .replace(&facts(), "");
    let input = replacement_table_schema_v171(
        schema(&tx, "table", "agent_run_input").unwrap(),
        "agent_run_input",
    )
    .replace(NEW_INPUT, OLD_INPUT);
    let guard = schema(&tx, "trigger", "context_manifest_v38_only_insert").unwrap();
    let guard = guard.replace(&admissions(&guard).unwrap(), "").replace(
        "context_manifest_v38_only_insert",
        "context_manifest_v36_only_insert",
    );
    let profile = schema(&tx, "trigger", "context_manifest_quote_profile_insert")
        .unwrap()
        .replace(PROFILE, "");
    let attachment = schema(
        &tx,
        "trigger",
        "runtime_input_delivery_attachment_auth_insert",
    )
    .unwrap()
    .replace(NEW_VERSIONS, OLD_VERSIONS);
    rebuild_table_v171(
        &tx,
        "context_manifest",
        &manifest,
        &[],
        &[
            "context_manifest_v38_only_insert",
            "context_manifest_quote_profile_insert",
        ],
    )
    .unwrap();
    rebuild_table_v171(
        &tx,
        "agent_run_input",
        &input,
        &[],
        &["agent_run_input_v38_only_insert"],
    )
    .unwrap();
    tx.execute_batch(&guard).unwrap();
    tx.execute_batch(&profile).unwrap();
    tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")
        .unwrap();
    tx.execute_batch(&attachment).unwrap();
    tx.execute_batch("CREATE TRIGGER agent_run_input_v36_only_insert BEFORE INSERT ON agent_run_input
        WHEN NEW.context_manifest_version IS NOT 36 BEGIN SELECT RAISE(ABORT, 'new public Thread AgentRunInput must use ContextManifest v36'); END;
        DELETE FROM schema_migration WHERE version=199;
        UPDATE rovai_data_contract SET projection_schema_version=148 WHERE singleton=1;").unwrap();
    tx.commit().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
pub(super) fn assert_upgrade(database: &mut Database) {
    let before = public_history_claim_preserved_evidence_digest(database.connection()).unwrap();
    let old_schema = schema(database.connection(), "table", "context_manifest").unwrap();
    database.connection().execute_batch("CREATE TEMP TRIGGER reject_senders BEFORE INSERT ON schema_migration WHEN NEW.version=199 BEGIN SELECT RAISE(ABORT,'sender context rollback fixture'); END;").unwrap();
    let error = migrate(database).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("sender context rollback fixture"),
        "{error:#}"
    );
    assert_eq!(
        schema(database.connection(), "table", "context_manifest").unwrap(),
        old_schema
    );
    assert_eq!(
        before,
        public_history_claim_preserved_evidence_digest(database.connection()).unwrap()
    );
    assert!(!database.schema_migration_applied(199).unwrap());
    database
        .connection()
        .execute_batch("DROP TRIGGER reject_senders")
        .unwrap();
    migrate(database).unwrap();
    super::execution_storage::migrate(database).unwrap();
    super::live_directory::migrate(database).unwrap();
    super::unified_activity::migrate(database).unwrap();
    super::compact_execution::migrate(database).unwrap();
    super::steer::assert_upgrade(database);
    database.migrate(false).unwrap();
    assert_eq!(
        before,
        public_history_claim_preserved_evidence_digest(database.connection()).unwrap()
    );
    assert!(matches!(
        classify_database_contract(database.connection()).unwrap(),
        DatabaseContractClassification::Current(_)
    ));
    let guard = schema(
        database.connection(),
        "trigger",
        "context_manifest_v40_only_insert",
    )
    .unwrap();
    for version in [33, 34, 36, 38, 39, 40] {
        assert!(guard.contains(&format!("input.context_manifest_version IS NOT {version}")));
    }
    assert!(guard.contains("NEW.context_manifest_version = 37"));
    assert_eq!(
        database
            .connection()
            .query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
