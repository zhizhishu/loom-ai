//! Admit routing-only context formats without changing any frozen payload or Native Binding.
use super::*;

fn schema(connection: &Connection, kind: &str, name: &str) -> Result<String> {
    Ok(connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
        params![kind, name],
        |row| row.get(0),
    )?)
}

const FACT33: &str = "(context_manifest_version = 33 AND formatter_version = 33 AND run_facts_schema_version = 9 AND ((camp_attachment_view_receipt_version IS NULL AND camp_attachment_view_receipt_json IS NULL AND camp_attachment_view_receipt_digest IS NULL) OR (camp_attachment_view_receipt_version = 2 AND camp_attachment_view_receipt_json IS NOT NULL AND camp_attachment_view_receipt_digest IS NOT NULL)))";
const PROFILE_BRANCHES: &str = "(NEW.context_manifest_version = 34 AND NEW.context_delivery_profile_version = 11) OR (NEW.context_manifest_version = 35 AND NEW.context_delivery_profile_version = 12) OR ";

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row("SELECT
        EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='agent_run_input_v34_only_insert'
          AND instr(sql, 'NEW.context_manifest_version IS NOT 34') > 0)
        AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='context_manifest_v34_only_insert'
          AND instr(sql, 'input.context_manifest_version IS NOT 34') > 0
          AND instr(sql, 'NEW.context_manifest_version = 35') > 0)
        AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_manifest'
          AND instr(sql, '29, 30, 31, 32, 33, 34, 35)') > 0
          AND instr(sql, 'profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12)') > 0)
        AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='context_manifest_quote_profile_insert'
          AND instr(sql, 'NEW.context_delivery_profile_version = 11') > 0
          AND instr(sql, 'NEW.context_delivery_profile_version = 12') > 0)", [], |row| row.get(0))
}

fn new_facts() -> String {
    format!(
        "{}\n OR\n {}\n OR\n ",
        FACT33.replace("= 33", "= 34"),
        FACT33
            .replace("= 33", "= 35")
            .replace("schema_version = 9", "schema_version = 6")
    )
}

fn new_admissions(old: &str) -> Result<String> {
    let start = old
        .find("(NEW.context_manifest_version = 33")
        .context("missing v33 admission")?;
    let end = start
        + old[start..]
            .find("\n OR\n")
            .context("missing v33 admission boundary")?;
    let batch = old[start..end]
        .replace("= 33", "= 34")
        .replace("IS NOT 33", "IS NOT 34")
        .replace("profile_version = 10", "profile_version = 11");
    Ok(format!(
        "{batch}\n OR\n (NEW.context_manifest_version = 35 AND NEW.formatter_version = 35 AND NEW.run_facts_schema_version = 6 AND NEW.context_delivery_profile_version = 12 AND EXISTS(SELECT 1 FROM agent_run AS run WHERE run.id=NEW.agent_run_id AND run.invocation_kind <> 'batch'))\n OR\n"
    ))
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
                if marker.projection_schema_version == 146),
            "Member routing requires schema 146"
        );
        let original = schema(&tx, "table", "context_manifest")?;
        anyhow::ensure!(original.contains(FACT33), "missing frozen v33 constraints");
        let manifest = replacement_table_schema_v171(original, "context_manifest")
            .replace("29, 30, 31, 32, 33)", "29, 30, 31, 32, 33, 34, 35)")
            .replace(
                "profile_version IN (4, 5, 6, 7, 8, 9, 10)",
                "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12)",
            )
            .replace(FACT33, &format!("{}{FACT33}", new_facts()));
        let input = replacement_table_schema_v171(
            schema(&tx, "table", "agent_run_input")?,
            "agent_run_input",
        )
        .replace("29, 30, 31, 32, 33)", "29, 30, 31, 32, 33, 34)");
        let old_guard = schema(&tx, "trigger", "context_manifest_v33_only_insert")?;
        let guard = old_guard
            .replace(
                "context_manifest_v33_only_insert",
                "context_manifest_v34_only_insert",
            )
            .replacen(
                "WHEN NOT (",
                &format!("WHEN NOT ({}", new_admissions(&old_guard)?),
                1,
            );
        let profile = schema(&tx, "trigger", "context_manifest_quote_profile_insert")?.replacen(
            "WHEN NOT (",
            &format!("WHEN NOT ({PROFILE_BRANCHES}"),
            1,
        );
        let attachment = schema(
            &tx,
            "trigger",
            "runtime_input_delivery_attachment_auth_insert",
        )?
        .replace("29, 30, 31, 32, 33)", "29, 30, 31, 32, 33, 34, 35)");
        rebuild_table_v171(
            &tx,
            "context_manifest",
            &manifest,
            &[],
            &[
                "context_manifest_v33_only_insert",
                "context_manifest_quote_profile_insert",
            ],
        )?;
        rebuild_table_v171(
            &tx,
            "agent_run_input",
            &input,
            &[],
            &["agent_run_input_v33_only_insert"],
        )?;
        tx.execute_batch(&guard)?;
        tx.execute_batch(&profile)?;
        tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")?;
        tx.execute_batch(&attachment)?;
        tx.execute_batch("CREATE TRIGGER agent_run_input_v34_only_insert BEFORE INSERT ON agent_run_input
            WHEN NEW.context_manifest_version IS NOT 34 BEGIN SELECT RAISE(ABORT, 'new public Thread AgentRunInput must use ContextManifest v34'); END;
            INSERT INTO schema_migration VALUES(197,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=147,updated_at=datetime('now') WHERE singleton=1;")?;
        validate_migration_foreign_keys(&tx, &["context_manifest", "agent_run_input"])?;
        anyhow::ensure!(
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::Current(_)
                    | DatabaseContractClassification::SupportedMigrationSource(_)
            ),
            "Member routing admission failed"
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
    super::claim_context::downgrade_for_test(connection);
    let applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=197)",
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
        UPDATE context_manifest SET context_manifest_version=33,formatter_version=33,context_delivery_profile_version=10 WHERE context_manifest_version=34;
        UPDATE context_manifest SET context_manifest_version=28,formatter_version=28,context_delivery_profile_version=7 WHERE context_manifest_version=35;
        UPDATE agent_run_input SET context_manifest_version=33 WHERE context_manifest_version=34;").unwrap();
    tx.execute_batch(&immutable).unwrap();
    tx.execute_batch(&input_immutable).unwrap();
    let manifest = replacement_table_schema_v171(
        schema(&tx, "table", "context_manifest").unwrap(),
        "context_manifest",
    )
    .replace("29, 30, 31, 32, 33, 34, 35)", "29, 30, 31, 32, 33)")
    .replace(
        "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12)",
        "profile_version IN (4, 5, 6, 7, 8, 9, 10)",
    )
    .replace(&new_facts(), "");
    let input = replacement_table_schema_v171(
        schema(&tx, "table", "agent_run_input").unwrap(),
        "agent_run_input",
    )
    .replace("29, 30, 31, 32, 33, 34)", "29, 30, 31, 32, 33)");
    let guard = schema(&tx, "trigger", "context_manifest_v34_only_insert").unwrap();
    let guard = guard.replace(&new_admissions(&guard).unwrap(), "").replace(
        "context_manifest_v34_only_insert",
        "context_manifest_v33_only_insert",
    );
    let profile = schema(&tx, "trigger", "context_manifest_quote_profile_insert")
        .unwrap()
        .replace(PROFILE_BRANCHES, "");
    let attachment = schema(
        &tx,
        "trigger",
        "runtime_input_delivery_attachment_auth_insert",
    )
    .unwrap()
    .replace("29, 30, 31, 32, 33, 34, 35)", "29, 30, 31, 32, 33)");
    rebuild_table_v171(
        &tx,
        "context_manifest",
        &manifest,
        &[],
        &[
            "context_manifest_v34_only_insert",
            "context_manifest_quote_profile_insert",
        ],
    )
    .unwrap();
    rebuild_table_v171(
        &tx,
        "agent_run_input",
        &input,
        &[],
        &["agent_run_input_v34_only_insert"],
    )
    .unwrap();
    tx.execute_batch(&guard).unwrap();
    tx.execute_batch(&profile).unwrap();
    tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")
        .unwrap();
    tx.execute_batch(&attachment).unwrap();
    tx.execute_batch("CREATE TRIGGER agent_run_input_v33_only_insert BEFORE INSERT ON agent_run_input
        WHEN NEW.context_manifest_version IS NOT 33 BEGIN SELECT RAISE(ABORT, 'new public Thread AgentRunInput must use ContextManifest v33'); END;
        DELETE FROM schema_migration WHERE version=197;
        UPDATE rovai_data_contract SET projection_schema_version=146 WHERE singleton=1;").unwrap();
    tx.commit().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    // Real DDL is required: owns atomic version admission and preservation across
    // the v33/v34 boundary; scalar validation is covered by cheaper pure tests.
    #[test]
    fn routing_upgrade_preserves_frozen_evidence_and_rolls_back_atomically() {
        let (mut database, directory) = crate::test_support::seeded_runtime_database();
        downgrade_for_test(database.connection());
        let store = crate::managed_blob::ManagedBlobStore::new(&directory);
        let text = format!("old frozen input\n{}", "😀\n\"中".repeat(2_500));
        let blob = store
            .put_bytes(&mut database, text.as_bytes(), "text/plain", "sensitive")
            .unwrap();
        let before = public_history_claim_preserved_evidence_digest(database.connection()).unwrap();
        let old_schema = schema(database.connection(), "table", "context_manifest").unwrap();
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_routing BEFORE INSERT ON schema_migration WHEN NEW.version=197 BEGIN SELECT RAISE(ABORT,'routing rollback fixture'); END;").unwrap();
        assert!(
            migrate(&mut database)
                .unwrap_err()
                .to_string()
                .contains("routing rollback fixture")
        );
        assert_eq!(
            schema(database.connection(), "table", "context_manifest").unwrap(),
            old_schema
        );
        assert_eq!(store.read_text(&database, &blob.id).unwrap(), text);
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_routing;")
            .unwrap();
        migrate(&mut database).unwrap();
        assert_eq!(
            public_history_claim_preserved_evidence_digest(database.connection()).unwrap(),
            before
        );
        assert_eq!(store.read_text(&database, &blob.id).unwrap(), text);
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::Current(_)
                | DatabaseContractClassification::SupportedMigrationSource(_)
        ));
        let guard = schema(
            database.connection(),
            "trigger",
            "context_manifest_v34_only_insert",
        )
        .unwrap();
        assert!(guard.contains("input.context_manifest_version IS NOT 33"));
        assert!(guard.contains("input.context_manifest_version IS NOT 34"));
        let input_guard = schema(
            database.connection(),
            "trigger",
            "agent_run_input_v34_only_insert",
        )
        .unwrap();
        database
            .connection()
            .execute_batch("DROP TRIGGER agent_run_input_v34_only_insert;")
            .unwrap();
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::Unknown(_)
        ));
        database.connection().execute_batch(&input_guard).unwrap();
        super::super::claim_context::assert_upgrade(&mut database);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
