//! Migration 231: explicit remote member selection and real-AgentRun targets.
//! The previous workspace RPC contract is migration 230 / projection 180.

use super::*;

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&transaction)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 180),
        "remote execution migration requires schema 180"
    );
    // Some newly-created node fixtures already carry the optional report fields.
    // Existing stores add them here; no catalog identity is fabricated for an
    // old node. It must reconnect and publish the actual installation facts.
    for (column, declaration) in [
        ("installation_identity", "installation_identity TEXT"),
        (
            "installation_generation",
            "installation_generation INTEGER CHECK(installation_generation IS NULL OR installation_generation BETWEEN 1 AND 9007199254740991)",
        ),
    ] {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('execution_node_cli') WHERE name=?1)",
            [column],
            |row| row.get(0),
        )?;
        if !exists {
            transaction.execute_batch(&format!(
                "ALTER TABLE execution_node_cli ADD COLUMN {declaration};"
            ))?;
        }
    }
    remote_workspace_scope::migrate(&transaction)?;
    super::loom::migrate_remote_artifact_origin(&transaction)?;
    transaction.execute_batch(crate::remote_execution::SCHEMA_SQL)?;
    transaction.execute_batch(crate::remote_bundle_owner::SCHEMA_SQL)?;
    transaction.execute_batch(
        "INSERT INTO schema_migration VALUES(231,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=181,updated_at=datetime('now') WHERE singleton=1;"
    )?;
    validate_migration_foreign_keys(
        &transaction,
        &[
            "remote_runtime_installation",
            "member_execution_target",
            "agent_run_execution_target",
            "agent_run_remote_bundle_source",
            "agent_run_remote_process",
            "loom_claim_execution_target",
            "loom_artifact_archive",
        ],
    )?;
    anyhow::ensure!(
        crate::remote_execution::schema_matches(&transaction)?,
        "remote execution migration did not create required bindings"
    );
    let admitted = match classify_database_contract(&transaction)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 181
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "remote execution schema admission failed");
    transaction.commit()?;
    Ok(())
}

/// Reuses the existing admission owner's fresh fixture. This recreates the actual
/// historical workspace table and 180 receipt before invoking the real 231 seam.
#[cfg(test)]
pub(super) fn test_replay_180_workspace_scope(database: &mut Database) {
    let connection = database.connection();
    super::loom::downgrade_artifact_versions_for_test(connection);
    assert_eq!(connection.query_row(
        "SELECT (SELECT count(*) FROM loom_artifact_snapshot)
              + (SELECT count(*) FROM loom_stage_review)
              + (SELECT count(*) FROM loom_control_dispatch)
              + (SELECT count(*) FROM loom_control_command)
              + (SELECT count(*) FROM loom_control_policy)", [], |row| row.get::<_, i64>(0)
    ).unwrap(), 0);
    // Undo 233 and 234 first: this fixture only replays up to the 183 hook receipt, so a
    // surviving 234 receipt or member_skill_source table would leave the store claiming a
    // newer projection than the one it is about to be stepped down to.
    connection.execute_batch(
        "DROP TABLE member_hook_review;
         DROP TABLE member_skill_source;
         DELETE FROM schema_migration WHERE version=233;
         DELETE FROM schema_migration WHERE version=234;"
    ).unwrap();
    connection.execute_batch(
        "DROP TABLE loom_artifact_snapshot;
         DROP TABLE loom_stage_review;
         DROP TABLE loom_control_dispatch;
         DROP TABLE loom_control_command;
         DROP TABLE loom_control_policy;
         DELETE FROM schema_migration WHERE version=232;"
    ).unwrap();
    super::loom::restore_local_artifact_contract_for_test(connection);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM mission_workspace", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    connection
        .execute_batch(
            "
        DROP TABLE loom_claim_execution_target;
        DROP TABLE agent_run_remote_process;
        DROP TABLE agent_run_remote_bundle_source;
        DROP TABLE agent_run_execution_target;
        DROP TABLE member_execution_target;
        DROP TABLE remote_runtime_installation;
        DROP TABLE mission_workspace;
    ",
        )
        .unwrap();
    let historical = include_str!("mission_schema.sql");
    let start = historical.find("CREATE TABLE mission_workspace (").unwrap();
    let end = historical[start..]
        .find("ALTER TABLE agent_run ADD COLUMN workspace_preparing_at")
        .unwrap()
        + start;
    connection.execute_batch(&historical[start..end]).unwrap();
    connection.execute_batch("
        DELETE FROM schema_migration WHERE version=231;
        UPDATE rovai_data_contract SET projection_schema_version=180 WHERE singleton=1;
        INSERT INTO mission_workspace(id,mission_id,camp_id,execution_host_id,source_directory,
            repository_root,git_common_dir,worktree_path,working_directory,base_branch,branch,base_sha,
            preparation_token,preparation_kind,generation,state,cleanup_command_id,
            cleanup_expected_branch_oid,cleanup_worktree_removed,cleanup_branch_removed,diagnostic,
            created_at,updated_at)
        VALUES('scope-old-a','mission-fixture-a','camp-fixture-a','host-a','source-a','repo-a','git-a',
            'C:/same/work','C:/same/work','main','branch-a','sha-a','opaque-a','restore',7,'cleanup_failed',
            'cleanup-a','oid-a',1,0,'preserve diagnostic','created-a','updated-a'),
            ('scope-old-b','mission-fixture-b','camp-fixture-b','host-b','source-b','repo-b','git-b',
            'C:/other/work','C:/other/work',NULL,'branch-b','sha-b','opaque-b','create',3,'ready',
            NULL,NULL,0,0,NULL,'created-b','updated-b');
        CREATE TEMP TABLE expected_old_workspaces AS SELECT * FROM mission_workspace;
    ").unwrap();
    assert!(matches!(classify_database_contract(connection).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==180));
    migrate(database).unwrap();
    assert!(matches!(classify_database_contract(database.connection()).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==181));
    super::loom::migrate_control(database).unwrap();
    assert!(matches!(classify_database_contract(database.connection()).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==182));
    super::member_hook_review_migration::migrate(database).unwrap();
    let connection = database.connection();
    // 233 is an exact 183 source state, not Current: 184 owns Current and only the caller's
    // later 234 replay may claim it.
    assert!(matches!(classify_database_contract(connection).unwrap(),
        DatabaseContractClassification::SupportedMigrationSource(ref marker)
            if marker.projection_schema_version == 183));
    for sql in [
        "SELECT COUNT(*) FROM (SELECT * FROM expected_old_workspaces EXCEPT SELECT * FROM mission_workspace)",
        "SELECT COUNT(*) FROM (SELECT * FROM mission_workspace EXCEPT SELECT * FROM expected_old_workspaces)",
        "SELECT COUNT(*) FROM pragma_foreign_key_check",
    ] {
        assert_eq!(
            connection
                .query_row(sql, [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0,
            "{sql}"
        );
    }
    connection.execute(
        "INSERT INTO mission_workspace(id,mission_id,camp_id,execution_host_id,source_directory,
            repository_root,git_common_dir,worktree_path,working_directory,base_branch,branch,base_sha,
            preparation_token,preparation_kind,generation,state,cleanup_command_id,
            cleanup_expected_branch_oid,cleanup_worktree_removed,cleanup_branch_removed,diagnostic,
            created_at,updated_at)
         SELECT 'scope-cross-host',mission_id,camp_id,'host-c',source_directory,repository_root,
            git_common_dir,worktree_path,working_directory,base_branch,branch,base_sha,preparation_token,
            preparation_kind,generation,state,cleanup_command_id,cleanup_expected_branch_oid,
            cleanup_worktree_removed,cleanup_branch_removed,diagnostic,created_at,updated_at
         FROM mission_workspace WHERE id='scope-old-a'", [],
    ).unwrap();
    let duplicate=connection.execute(
        "INSERT INTO mission_workspace(id,mission_id,camp_id,execution_host_id,source_directory,
            repository_root,git_common_dir,worktree_path,working_directory,branch,base_sha,preparation_token,
            state,created_at,updated_at)
         VALUES('scope-same-host','different-mission','different-camp','host-a','s','r','different-git',
            'C:/same/work','C:/same/work','different-branch','sha','token','ready','c','u')", [],
    );
    assert!(duplicate.is_err(), "same-host path uniqueness is retained");
    // These are isolated owner rows, not live user workspaces.
    connection
        .execute_batch("DELETE FROM mission_workspace; DROP TABLE expected_old_workspaces;")
        .unwrap();
}
