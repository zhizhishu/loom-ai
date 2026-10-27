// Original Mission 064 migration 199, retained only to construct historical fixtures.
//! Preserve initial inputs while admitting additional inputs to the same execution.
use super::*;

fn schema(connection: &Connection, kind: &str, name: &str) -> Result<String> {
    Ok(connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
        params![kind, name],
        |row| row.get(0),
    )?)
}

pub(super) fn schema_matches(connection: &Connection) -> bool {
    connection.prepare("SELECT agent_run_id,context_json FROM agent_run_claim_context LIMIT 0").is_ok()
        && connection.prepare("SELECT requested_mode,target_execution_epoch FROM camp_message_delivery LIMIT 0").is_ok()
        && connection.prepare("SELECT source_delivery_id FROM context_manifest LIMIT 0").is_ok()
        && connection.prepare("SELECT input_kind,input_sequence FROM runtime_input_delivery LIMIT 0").is_ok()
        && connection.query_row("SELECT count(*)=6 FROM sqlite_master WHERE type='trigger' AND name IN
            ('agent_run_input_v37_only_insert','context_manifest_v37_only_insert','context_manifest_source_immutable','runtime_input_source_immutable','runtime_input_source_insert','agent_run_claim_context_immutable')",
            [], |row| row.get::<_,bool>(0)).unwrap_or(false)
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
            "Steer inputs require schema 148"
        );
        tx.execute_batch("ALTER TABLE context_manifest ADD COLUMN source_delivery_id TEXT REFERENCES camp_message_delivery(id);
            ALTER TABLE runtime_input_delivery ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'start' CHECK(input_kind IN ('start','steer'));
            ALTER TABLE runtime_input_delivery ADD COLUMN input_sequence INTEGER NOT NULL DEFAULT 0 CHECK(input_sequence>=0);
            ALTER TABLE camp_message_delivery ADD COLUMN requested_mode TEXT NOT NULL DEFAULT 'start' CHECK(requested_mode IN ('start','steer'));
            ALTER TABLE camp_message_delivery ADD COLUMN target_execution_epoch INTEGER CHECK(target_execution_epoch>0);")?;
        let fact = "(context_manifest_version = 36 AND formatter_version = 36 AND run_facts_schema_version = 9 AND";
        let old = schema(&tx, "table", "context_manifest")?;
        anyhow::ensure!(
            old.contains(fact) && old.contains("agent_run_id TEXT NOT NULL UNIQUE"),
            "Steer migration source shape mismatch"
        );
        let start = old.find(fact).unwrap();
        let end = start
            + old[start..]
                .find("\n OR\n")
                .context("Missing v36 facts boundary")?;
        let facts = old[start..end]
            .replace("= 36", "= 37")
            .replace("schema_version = 9", "schema_version = 10");
        let manifest = replacement_table_schema_v171(old.clone(), "context_manifest")
            .replace(
                "agent_run_id TEXT NOT NULL UNIQUE",
                "agent_run_id TEXT NOT NULL",
            )
            .replace(
                "29, 30, 31, 32, 33, 34, 35, 36)",
                "29, 30, 31, 32, 33, 34, 35, 36, 37)",
            )
            .replace(
                "run_facts_schema_version IN (1, 2, 3, 4, 5, 6, 7, 8, 9)",
                "run_facts_schema_version IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)",
            )
            .replace(
                "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12, 13)",
                "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)",
            )
            .replace(
                &old[start..end],
                &format!("{facts}\n OR\n {}", &old[start..end]),
            );
        let old_guard = schema(&tx, "trigger", "context_manifest_v36_only_insert")?;
        let start = old_guard
            .find("(NEW.context_manifest_version = 36")
            .context("Missing v36 admission")?;
        let end = start
            + old_guard[start..]
                .find("\n OR\n")
                .context("Missing v36 admission boundary")?;
        let admission = old_guard[start..end]
            .replace("= 36", "= 37")
            .replace("IS NOT 36", "IS NOT 37")
            .replace("profile_version = 13", "profile_version = 14")
            .replace("schema_version = 9", "schema_version = 10");
        let steer_admission = "(NEW.source_delivery_id IS NOT NULL AND NEW.context_manifest_version=37
            AND NEW.formatter_version=37 AND NEW.run_facts_schema_version=10 AND NEW.context_delivery_profile_version=14
            AND EXISTS(SELECT 1 FROM camp_message_delivery d JOIN camp_message m ON m.id=d.message_id
                JOIN agent_run r ON r.id=d.claimed_agent_run_id WHERE d.id=NEW.source_delivery_id
                AND d.status='claimed' AND d.requested_mode='steer' AND m.author_type='user'
                AND r.id=NEW.agent_run_id AND r.execution_epoch=d.target_execution_epoch AND r.status IN ('running','waiting') AND r.cancel_requested_at IS NULL
                AND json_array_length(NEW.raw_message_refs_json)=1
                AND json_extract(NEW.raw_message_refs_json,'$[0].entityId')=m.id))";
        let guard = old_guard.replace("context_manifest_v36_only_insert", "context_manifest_v37_only_insert")
            .replacen("WHEN NOT (", &format!("WHEN NOT ({steer_admission} OR (NEW.source_delivery_id IS NULL AND ({admission} OR "), 1)
            .replacen("BEGIN SELECT", ")) BEGIN SELECT", 1);
        let profile = schema(&tx, "trigger", "context_manifest_quote_profile_insert")?
            .replacen("WHEN NOT (", "WHEN NOT ((NEW.context_manifest_version=37 AND NEW.context_delivery_profile_version=14) OR ", 1);
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
        tx.execute_batch(&guard)?;
        tx.execute_batch(&profile)?;
        tx.execute_batch("CREATE UNIQUE INDEX context_manifest_initial_run ON context_manifest(agent_run_id) WHERE source_delivery_id IS NULL;
            CREATE UNIQUE INDEX context_manifest_source_delivery ON context_manifest(source_delivery_id) WHERE source_delivery_id IS NOT NULL;
            CREATE TRIGGER context_manifest_source_immutable BEFORE UPDATE OF source_delivery_id ON context_manifest
                BEGIN SELECT RAISE(ABORT,'ContextManifest source is immutable'); END;")?;
        let input = replacement_table_schema_v171(
            schema(&tx, "table", "agent_run_input")?,
            "agent_run_input",
        )
        .replace(
            "29, 30, 31, 32, 33, 34, 36)",
            "29, 30, 31, 32, 33, 34, 36, 37)",
        );
        rebuild_table_v171(
            &tx,
            "agent_run_input",
            &input,
            &[],
            &["agent_run_input_v36_only_insert"],
        )?;
        tx.execute_batch("CREATE TRIGGER agent_run_input_v37_only_insert BEFORE INSERT ON agent_run_input
            WHEN NEW.context_manifest_version IS NOT 37 BEGIN SELECT RAISE(ABORT,'new public Thread AgentRunInput must use ContextManifest v37'); END;")?;
        let old_delivery = schema(&tx, "table", "runtime_input_delivery")?;
        anyhow::ensure!(
            old_delivery.contains("UNIQUE(agent_run_id, execution_epoch)"),
            "Missing Runtime input uniqueness"
        );
        let delivery = replacement_table_schema_v171(old_delivery, "runtime_input_delivery")
            .replace("UNIQUE(agent_run_id, execution_epoch)", "UNIQUE(context_manifest_id, execution_epoch), UNIQUE(agent_run_id, execution_epoch, input_sequence)");
        let attachment = schema(
            &tx,
            "trigger",
            "runtime_input_delivery_attachment_auth_insert",
        )?
        .replace(
            "29, 30, 31, 32, 33, 34, 35, 36)",
            "29, 30, 31, 32, 33, 34, 35, 36, 37)",
        );
        let native_index: String = tx.query_row("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runtime_input_delivery' AND sql LIKE '%UNIQUE%native_binding_id, native_input_id%'", [], |row| row.get(0))?;
        rebuild_table_v171(
            &tx,
            "runtime_input_delivery",
            &delivery,
            &[],
            &[
                "runtime_input_delivery_attachment_auth_insert",
                &native_index,
            ],
        )?;
        tx.execute_batch(&attachment)?;
        tx.execute_batch("CREATE UNIQUE INDEX runtime_input_initial_native_identity ON runtime_input_delivery(native_binding_id,native_input_id) WHERE native_input_id IS NOT NULL AND input_kind='start';
            CREATE TRIGGER runtime_input_source_insert BEFORE INSERT ON runtime_input_delivery
                WHEN NOT EXISTS(SELECT 1 FROM context_manifest m WHERE m.id=NEW.context_manifest_id AND m.agent_run_id=NEW.agent_run_id
                    AND ((m.source_delivery_id IS NULL AND NEW.input_kind='start' AND NEW.input_sequence=0)
                      OR (m.source_delivery_id IS NOT NULL AND NEW.input_kind='steer' AND NEW.input_sequence>0
                        AND EXISTS(SELECT 1 FROM camp_message_delivery d WHERE d.id=m.source_delivery_id
                          AND d.claimed_agent_run_id=NEW.agent_run_id AND d.target_execution_epoch=NEW.execution_epoch AND d.status='claimed'))))
                BEGIN SELECT RAISE(ABORT,'Runtime input source does not match its Manifest'); END;
            CREATE TRIGGER runtime_input_source_immutable BEFORE UPDATE OF input_kind,input_sequence,context_manifest_id ON runtime_input_delivery
                BEGIN SELECT RAISE(ABORT,'Runtime input source is immutable'); END;
            INSERT INTO schema_migration VALUES(199,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=149,updated_at=datetime('now') WHERE singleton=1;")?;
        validate_migration_foreign_keys(
            &tx,
            &[
                "context_manifest",
                "agent_run_input",
                "runtime_input_delivery",
                "camp_message_delivery",
            ],
        )?;
        anyhow::ensure!(
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::Current(_)
                    | DatabaseContractClassification::SupportedMigrationSource(_)
            ),
            "Steer input admission failed"
        );
        tx.commit()?;
        Ok(())
    })();
    database
        .connection
        .execute_batch("PRAGMA foreign_keys=ON;")?;
    result
}

// Test fixtures restore the real preceding schema before exercising older owners.
