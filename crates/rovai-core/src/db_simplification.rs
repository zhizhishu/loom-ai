use super::*;

// Kept nullable for historical readers. New snapshots store the final input and
// the material actually used for delivery, not copies proving its construction.
pub(super) const RETIRED_CONTEXT_COLUMNS: &[&str] = &[
    "context_delivery_profile_json",
    "context_delivery_profile_digest",
    "shared_message_evidence_digest",
    "run_fact_payload_json",
    "run_fact_digest",
    "attachment_digest",
    "skill_exposure_digest",
    "current_input_skill_resolution_digest",
    "mcp_exposure_digest",
    "mcp_projection_digest",
    "self_active_task_evidence_json",
    "self_active_task_evidence_digest",
    "a2a_guidance_evidence_json",
    "a2a_guidance_evidence_digest",
    "rendered_payload_digest",
];

pub(super) fn current_structure_matches(connection: &Connection) -> rusqlite::Result<bool> {
    // Preparing these queries checks the structures Core actually needs without
    // binding admission to a spelling of CREATE TABLE or to optional Usage data.
    for query in [
        "SELECT id,version FROM camp LIMIT 0",
        "SELECT id FROM agent_profile LIMIT 0",
        "SELECT id FROM message_delivery LIMIT 0",
        "SELECT id FROM task LIMIT 0",
        "SELECT id FROM mission LIMIT 0",
        "SELECT id,camp_id,agent_id,native_session_id,native_binding_id,native_binding_generation FROM conversation LIMIT 0",
        "SELECT id,status,execution_epoch,camp_id,conversation_id,cancel_requested_at,cancel_acknowledged_at FROM agent_run LIMIT 0",
        "SELECT id,camp_id,sequence,body FROM camp_message LIMIT 0",
        "SELECT event_id,event_type,command_id,command_type,result_status,result_code,result_payload_json,actor_type,actor_id,camp_id,source_agent_run_id FROM event_log LIMIT 0",
        "SELECT id,agent_run_id,rendered_payload_blob_id,bootstrap_evidence_id,collaboration_state_digest FROM context_manifest LIMIT 0",
        "SELECT id,status,agent_run_id,context_manifest_id,accepted_at FROM runtime_input_delivery LIMIT 0",
        "SELECT id,sha256,storage_relative_path FROM managed_blob LIMIT 0",
        "SELECT client_id,owner_id,proof_digest FROM web_editor_identity LIMIT 0",
    ] {
        if connection.prepare(query).is_err() {
            return Ok(false);
        }
    }
    if !run_bootstrap_schema_matches(connection)? {
        return Ok(false);
    }
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_index_list('event_log') AS indexes
            WHERE indexes.[unique]=1
              AND (SELECT count(*) FROM pragma_index_info(indexes.name))=1
              AND EXISTS(SELECT 1 FROM pragma_index_info(indexes.name) WHERE name='command_id'))",
        [],
        |row| row.get(0),
    )
}

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    if connection
        .prepare("SELECT command_client_id FROM event_log LIMIT 0")
        .is_err()
    {
        return Ok(false);
    }
    for column in RETIRED_CONTEXT_COLUMNS {
        let nullable: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('context_manifest') WHERE name=?1 AND [notnull]=0)",
            [column], |row| row.get(0),
        )?;
        if !nullable {
            return Ok(false);
        }
    }
    Ok(true)
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
                if marker.projection_schema_version == 145),
            "Internal simplification requires schema 145"
        );
        for (table, columns) in [
            ("context_manifest", RETIRED_CONTEXT_COLUMNS),
            (
                "context_additional_skills_evidence",
                &["section_text", "section_digest"][..],
            ),
        ] {
            let mut schema: String = tx.query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )?;
            for column in columns {
                remove_sql_words(&mut schema, &[column, "TEXT", "NOT", "NULL"], 2);
            }
            rebuild_table_v171(
                &tx,
                table,
                &replacement_table_schema_v171(schema, table),
                &[],
                &[],
            )?;
        }
        let table = "event_log";
        let mut schema: String = tx.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get(0),
        )?;
        for column in ["request_digest", "request_digest_version"] {
            remove_sql_words(&mut schema, &["AND", column, "IS", "NOT", "NULL"], 0);
        }
        rebuild_table_v171(
            &tx,
            table,
            &replacement_table_schema_v171(schema, table),
            &[],
            &[],
        )?;
        let has_client: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('event_log') WHERE name='command_client_id')",
            [], |row| row.get(0),
        )?;
        if !has_client {
            tx.execute_batch("ALTER TABLE event_log ADD COLUMN command_client_id TEXT;")?;
        }
        // Derived statistics must not execute inside a business status update.
        tx.execute_batch("DROP TRIGGER IF EXISTS runtime_usage_agent_run_terminal;
            INSERT INTO schema_migration VALUES(196,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=146,updated_at=datetime('now') WHERE singleton=1;")?;
        validate_migration_foreign_keys(
            &tx,
            &[
                "context_manifest",
                "context_additional_skills_evidence",
                "event_log",
            ],
        )?;
        anyhow::ensure!(
            schema_matches(&tx)? && current_structure_matches(&tx)?,
            "Internal simplification structure is incomplete"
        );
        tx.commit()?;
        Ok(())
    })();
    database
        .connection
        .execute_batch("PRAGMA foreign_keys=ON;")?;
    result
}

// Migration-only transformation: accept capitalization, whitespace and quoted
// column identifiers, preserving the rest of the original table definition.
fn remove_sql_words(sql: &mut String, pattern: &[&str], first_removed: usize) {
    let mut spans = Vec::new();
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            spans.push((start, i));
        } else {
            i += 1;
        }
    }
    let removals = spans
        .windows(pattern.len())
        .filter_map(|window| {
            window
                .iter()
                .zip(pattern)
                .all(|(&(start, end), word)| sql[start..end].eq_ignore_ascii_case(word))
                .then(|| (window[first_removed].0, window.last().unwrap().1))
        })
        .collect::<Vec<_>>();
    for (start, end) in removals.into_iter().rev() {
        sql.replace_range(start..end, "");
    }
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    // This owner needs real DDL/transactions: it covers nullable-column migration,
    // rollback, retained legacy results/Blob bytes and production reopen together.
    #[test]
    fn upgrade_preserves_legacy_results_and_blob_bytes_and_rolls_back_atomically() {
        let directory =
            std::env::temp_dir().join(format!("rovai-simplification-{}", Uuid::new_v4()));
        let mut database = crate::test_support::fresh_schema_database_fast_at(&directory);
        member_routing::downgrade_for_test(database.connection());
        let store = crate::managed_blob::ManagedBlobStore::new(&directory);
        let blob = store
            .put_bytes(&mut database, b"frozen input\n", "text/plain", "sensitive")
            .unwrap();
        database
            .connection()
            .execute_batch("PRAGMA foreign_keys=OFF")
            .unwrap();
        let tx = database.connection().unchecked_transaction().unwrap();
        tx.execute_batch("ALTER TABLE event_log DROP COLUMN command_client_id;")
            .unwrap();
        for (table, columns) in [
            ("context_manifest", RETIRED_CONTEXT_COLUMNS),
            (
                "context_additional_skills_evidence",
                &["section_text", "section_digest"][..],
            ),
        ] {
            let mut schema: String = tx
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            for column in columns {
                schema = schema.replacen(
                    &format!("{column} TEXT"),
                    &format!("{column} TEXT NOT NULL"),
                    1,
                );
            }
            rebuild_table_v171(
                &tx,
                table,
                &replacement_table_schema_v171(schema, table),
                &[],
                &[],
            )
            .unwrap();
        }
        let mut schema: String = tx
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='event_log'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        schema.insert_str(schema.rfind(')').unwrap(), ", CHECK(event_type != 'command.result' OR (command_id IS NOT NULL AND request_digest IS NOT NULL AND request_digest_version IS NOT NULL))");
        rebuild_table_v171(
            &tx,
            "event_log",
            &replacement_table_schema_v171(schema, "event_log"),
            &[],
            &[],
        )
        .unwrap();
        tx.execute_batch("DELETE FROM schema_migration WHERE version=196;
            UPDATE rovai_data_contract SET projection_schema_version=145;
            INSERT INTO event_log(event_id,event_type,command_id,command_type,actor_type,actor_id,request_digest,request_digest_version,result_status,result_code,result_payload_json,payload_json,created_at)
            VALUES('legacy-result','command.result','legacy-command','legacy.operation','user','test-user','old-digest',1,'rejected','legacy.code','{\"reason\":\"original\"}','{}','2026-10-01');").unwrap();
        tx.commit().unwrap();
        database.connection().execute_batch("PRAGMA foreign_keys=ON;
            CREATE TEMP TRIGGER reject_simplification BEFORE INSERT ON schema_migration WHEN NEW.version=196 BEGIN SELECT RAISE(ABORT,'migration rollback fixture'); END;").unwrap();
        assert!(!schema_matches(database.connection()).unwrap());
        assert!(
            migrate(&mut database)
                .unwrap_err()
                .to_string()
                .contains("migration rollback fixture")
        );
        assert!(!schema_matches(database.connection()).unwrap());
        assert!(!database.schema_migration_applied(196).unwrap());
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_simplification")
            .unwrap();
        migrate(&mut database).unwrap();
        let legacy: (String, String) = database.connection().query_row("SELECT request_digest,result_payload_json FROM event_log WHERE event_id='legacy-result'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(
            legacy,
            ("old-digest".into(), "{\"reason\":\"original\"}".into())
        );
        assert!(schema_matches(database.connection()).unwrap());
        assert_eq!(
            store.read_text(&database, &blob.id).unwrap(),
            "frozen input\n"
        );
        drop(database);
        let reopened = Database::open(&directory).unwrap();
        assert!(connection_has_current_data_contract(reopened.connection()).unwrap());
        assert_eq!(
            store.read_text(&reopened, &blob.id).unwrap(),
            "frozen input\n"
        );
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
