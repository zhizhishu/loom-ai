//! Claim snapshots are Run-owned; historical inputs and Native Sessions remain untouched.
use super::*;

fn schema(connection: &Connection, kind: &str, name: &str) -> Result<String> {
    Ok(connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
        params![kind, name],
        |row| row.get(0),
    )?)
}

const FACT34: &str = "(context_manifest_version = 34 AND formatter_version = 34 AND run_facts_schema_version = 9 AND ((camp_attachment_view_receipt_version IS NULL AND camp_attachment_view_receipt_json IS NULL AND camp_attachment_view_receipt_digest IS NULL) OR (camp_attachment_view_receipt_version = 2 AND camp_attachment_view_receipt_json IS NOT NULL AND camp_attachment_view_receipt_digest IS NOT NULL)))";
const PROFILE: &str =
    "(NEW.context_manifest_version = 36 AND NEW.context_delivery_profile_version = 13) OR ";

fn admission(old: &str) -> Result<String> {
    let start = old
        .find("(NEW.context_manifest_version = 34")
        .context("missing v34 admission")?;
    let end = start
        + old[start..]
            .find("\n OR\n")
            .context("missing v34 admission boundary")?;
    let branch = require_fragments(
        old[start..end].to_owned(),
        &[
            "NEW.formatter_version = 34",
            "NEW.context_delivery_profile_version = 11",
            "input.context_manifest_version = 34",
            "input.context_manifest_version IS NOT 34",
        ],
    )?;
    Ok(format!(
        "{}\n OR\n",
        branch
            .replace("= 34", "= 36")
            .replace("IS NOT 34", "IS NOT 36")
            .replace("profile_version = 11", "profile_version = 13")
    ))
}

fn require_fragments(sql: String, fragments: &[&str]) -> Result<String> {
    for fragment in fragments {
        anyhow::ensure!(
            sql.contains(fragment),
            "Claim context migration source shape mismatch: {fragment}"
        );
    }
    Ok(sql)
}

pub(super) fn schema_matches(connection: &Connection) -> bool {
    connection
        .prepare("SELECT agent_run_id,context_json FROM agent_run_claim_context LIMIT 0")
        .is_ok()
        && connection.query_row(
            "SELECT count(*)=2 FROM sqlite_master WHERE type='trigger' AND name IN ('agent_run_claim_context_immutable','agent_run_input_v36_only_insert')",
            [], |row| row.get::<_,bool>(0),
        ).unwrap_or(false)
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
            DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version == 147),
            "Claim context requires schema 147"
        );
        let manifest = replacement_table_schema_v171(
            require_fragments(
                schema(&tx, "table", "context_manifest")?,
                &[
                    "29, 30, 31, 32, 33, 34, 35)",
                    "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12)",
                    FACT34,
                ],
            )?,
            "context_manifest",
        )
        .replace(
            "29, 30, 31, 32, 33, 34, 35)",
            "29, 30, 31, 32, 33, 34, 35, 36)",
        )
        .replace(
            "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12)",
            "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12, 13)",
        )
        .replace(
            FACT34,
            &format!("{}\n OR\n {FACT34}", FACT34.replace("= 34", "= 36")),
        );
        let input = replacement_table_schema_v171(
            require_fragments(
                schema(&tx, "table", "agent_run_input")?,
                &["29, 30, 31, 32, 33, 34)"],
            )?,
            "agent_run_input",
        )
        .replace("29, 30, 31, 32, 33, 34)", "29, 30, 31, 32, 33, 34, 36)");
        let original_guard = require_fragments(
            schema(&tx, "trigger", "context_manifest_v34_only_insert")?,
            &["WHEN NOT ("],
        )?;
        let guard = original_guard
            .replace(
                "context_manifest_v34_only_insert",
                "context_manifest_v36_only_insert",
            )
            .replacen(
                "WHEN NOT (",
                &format!("WHEN NOT ({}", admission(&original_guard)?),
                1,
            );
        let profile = require_fragments(
            schema(&tx, "trigger", "context_manifest_quote_profile_insert")?,
            &["WHEN NOT ("],
        )?
        .replacen("WHEN NOT (", &format!("WHEN NOT ({PROFILE}"), 1);
        let attachment = require_fragments(
            schema(
                &tx,
                "trigger",
                "runtime_input_delivery_attachment_auth_insert",
            )?,
            &["29, 30, 31, 32, 33, 34, 35)"],
        )?
        .replace(
            "29, 30, 31, 32, 33, 34, 35)",
            "29, 30, 31, 32, 33, 34, 35, 36)",
        );
        rebuild_table_v171(
            &tx,
            "context_manifest",
            &manifest,
            &[],
            &[
                "context_manifest_v34_only_insert",
                "context_manifest_quote_profile_insert",
            ],
        )?;
        rebuild_table_v171(
            &tx,
            "agent_run_input",
            &input,
            &[],
            &["agent_run_input_v34_only_insert"],
        )?;
        tx.execute_batch(&guard)?;
        tx.execute_batch(&profile)?;
        tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")?;
        tx.execute_batch(&attachment)?;
        tx.execute_batch("CREATE TRIGGER agent_run_input_v36_only_insert BEFORE INSERT ON agent_run_input
            WHEN NEW.context_manifest_version IS NOT 36 BEGIN SELECT RAISE(ABORT, 'new public Thread AgentRunInput must use ContextManifest v36'); END;
            CREATE TABLE agent_run_claim_context (
                agent_run_id TEXT PRIMARY KEY REFERENCES agent_run(id) ON DELETE CASCADE,
                context_json TEXT NOT NULL CHECK(json_valid(context_json))
            );
            CREATE TRIGGER agent_run_claim_context_immutable BEFORE UPDATE ON agent_run_claim_context
                BEGIN SELECT RAISE(ABORT, 'claimed context is immutable'); END;
            INSERT INTO schema_migration VALUES(198,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=148,updated_at=datetime('now') WHERE singleton=1;")?;
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
            "Claim context admission failed"
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
    super::message_senders::downgrade_for_test(connection);
    let applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=198)",
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
        UPDATE context_manifest SET context_manifest_version=34,formatter_version=34,context_delivery_profile_version=11 WHERE context_manifest_version=36;
        UPDATE agent_run_input SET context_manifest_version=34 WHERE context_manifest_version=36;
        DROP TABLE agent_run_claim_context;").unwrap();
    tx.execute_batch(&immutable).unwrap();
    tx.execute_batch(&input_immutable).unwrap();
    let manifest = replacement_table_schema_v171(
        schema(&tx, "table", "context_manifest").unwrap(),
        "context_manifest",
    )
    .replace(
        "29, 30, 31, 32, 33, 34, 35, 36)",
        "29, 30, 31, 32, 33, 34, 35)",
    )
    .replace(
        "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12, 13)",
        "profile_version IN (4, 5, 6, 7, 8, 9, 10, 11, 12)",
    )
    .replace(&format!("{}\n OR\n ", FACT34.replace("= 34", "= 36")), "");
    let input = replacement_table_schema_v171(
        schema(&tx, "table", "agent_run_input").unwrap(),
        "agent_run_input",
    )
    .replace("29, 30, 31, 32, 33, 34, 36)", "29, 30, 31, 32, 33, 34)");
    let guard = schema(&tx, "trigger", "context_manifest_v36_only_insert").unwrap();
    let guard = guard.replace(&admission(&guard).unwrap(), "").replace(
        "context_manifest_v36_only_insert",
        "context_manifest_v34_only_insert",
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
    .replace(
        "29, 30, 31, 32, 33, 34, 35, 36)",
        "29, 30, 31, 32, 33, 34, 35)",
    );
    rebuild_table_v171(
        &tx,
        "context_manifest",
        &manifest,
        &[],
        &[
            "context_manifest_v36_only_insert",
            "context_manifest_quote_profile_insert",
        ],
    )
    .unwrap();
    rebuild_table_v171(
        &tx,
        "agent_run_input",
        &input,
        &[],
        &["agent_run_input_v36_only_insert"],
    )
    .unwrap();
    tx.execute_batch(&guard).unwrap();
    tx.execute_batch(&profile).unwrap();
    tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")
        .unwrap();
    tx.execute_batch(&attachment).unwrap();
    tx.execute_batch("CREATE TRIGGER agent_run_input_v34_only_insert BEFORE INSERT ON agent_run_input
        WHEN NEW.context_manifest_version IS NOT 34 BEGIN SELECT RAISE(ABORT, 'new public Thread AgentRunInput must use ContextManifest v34'); END;
        DELETE FROM schema_migration WHERE version=198;
        UPDATE rovai_data_contract SET projection_schema_version=147 WHERE singleton=1;").unwrap();
    tx.commit().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
pub(super) fn assert_upgrade(database: &mut Database) {
    let before = public_history_claim_preserved_evidence_digest(database.connection()).unwrap();
    let old_schema = schema(database.connection(), "table", "context_manifest").unwrap();
    // An unsupported source shape must never receive the new receipt/marker.
    database
        .connection()
        .execute_batch("PRAGMA writable_schema=ON;")
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE sqlite_master SET sql=?1 WHERE type='table' AND name='context_manifest'",
            [old_schema.replace(FACT34, &FACT34.replace(" AND ", "  AND "))],
        )
        .unwrap();
    database
        .connection()
        .execute_batch("PRAGMA writable_schema=OFF;")
        .unwrap();
    assert!(
        migrate(database)
            .unwrap_err()
            .to_string()
            .contains("source shape mismatch")
    );
    assert!(!database.schema_migration_applied(198).unwrap());
    database
        .connection()
        .execute_batch("PRAGMA writable_schema=ON;")
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE sqlite_master SET sql=?1 WHERE type='table' AND name='context_manifest'",
            [&old_schema],
        )
        .unwrap();
    database
        .connection()
        .execute_batch("PRAGMA writable_schema=OFF;")
        .unwrap();
    let old_guard = schema(
        database.connection(),
        "trigger",
        "context_manifest_v34_only_insert",
    )
    .unwrap();
    for (from, to) in [
        ("WHEN NOT (", "WHEN NOT("),
        ("NEW.formatter_version = 34", "NEW.formatter_version=34"),
        (
            "NEW.context_delivery_profile_version = 11",
            "NEW.context_delivery_profile_version=11",
        ),
    ] {
        database
            .connection()
            .execute_batch("PRAGMA writable_schema=ON;")
            .unwrap();
        database.connection().execute(
            "UPDATE sqlite_master SET sql=?1 WHERE type='trigger' AND name='context_manifest_v34_only_insert'",
            [old_guard.replacen(from, to, 1)],
        ).unwrap();
        database
            .connection()
            .execute_batch("PRAGMA writable_schema=OFF;")
            .unwrap();
        assert!(migrate(database).is_err(), "unverified source shape: {to}");
        assert!(!database.schema_migration_applied(198).unwrap());
    }
    database
        .connection()
        .execute_batch("PRAGMA writable_schema=ON;")
        .unwrap();
    database.connection().execute(
        "UPDATE sqlite_master SET sql=?1 WHERE type='trigger' AND name='context_manifest_v34_only_insert'", [&old_guard],
    ).unwrap();
    database.connection().execute_batch("PRAGMA writable_schema=OFF;
        CREATE TEMP TRIGGER reject_claim_context BEFORE INSERT ON schema_migration WHEN NEW.version=198 BEGIN SELECT RAISE(ABORT,'claim context rollback fixture'); END;").unwrap();
    assert!(
        migrate(database)
            .unwrap_err()
            .to_string()
            .contains("claim context rollback fixture")
    );
    assert_eq!(
        schema(database.connection(), "table", "context_manifest").unwrap(),
        old_schema
    );
    assert!(!schema_matches(database.connection()));
    database
        .connection()
        .execute_batch("DROP TRIGGER reject_claim_context")
        .unwrap();
    migrate(database).unwrap();
    assert!(matches!(
        classify_database_contract(database.connection()).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref marker)
            if marker.projection_schema_version == 148
    ));
    assert_eq!(
        before,
        public_history_claim_preserved_evidence_digest(database.connection()).unwrap()
    );
    assert_eq!(
        database
            .connection()
            .query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let immutable = schema(
        database.connection(),
        "trigger",
        "agent_run_claim_context_immutable",
    )
    .unwrap();
    database
        .connection()
        .execute_batch("DROP TRIGGER agent_run_claim_context_immutable")
        .unwrap();
    assert!(matches!(
        classify_database_contract(database.connection()).unwrap(),
        DatabaseContractClassification::Unknown(_)
    ));
    database.connection().execute_batch(&immutable).unwrap();
    super::message_senders::assert_upgrade(database);
}
