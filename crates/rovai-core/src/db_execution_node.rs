//! Migration 225: execution nodes, the CLIs they last reported, and the runs
//! dispatched to them. The local node is the existing mission execution host.
//! Remote nodes are not the default execution host.
use super::*;

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 174
        ),
        "execution node migration requires schema 174"
    );
    tx.execute_batch(crate::execution_node::SCHEMA_SQL)?;
    let host_id: String = tx
        .query_row(
            "SELECT id FROM mission_execution_host WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .context("execution node migration requires the local mission host")?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    tx.execute(
        "INSERT INTO execution_node(
            node_id, display_name, role, os, arch, token_digest,
            paired_at, revoked_at, last_heartbeat
         ) VALUES(?1, '本机', 'local', ?2, ?3, NULL, ?4, NULL, ?4)",
        params![host_id, std::env::consts::OS, std::env::consts::ARCH, now],
    )?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(225,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=175,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(
        &tx,
        &[
            "execution_node",
            "execution_node_cli",
            "node_dispatch",
            "node_dispatch_output",
        ],
    )?;
    anyhow::ensure!(
        crate::execution_node::schema_matches(&tx)?,
        "execution node migration did not create the required tables"
    );
    let local: i64 = tx.query_row(
        "SELECT COUNT(*) FROM execution_node WHERE role='local' AND revoked_at IS NULL AND token_digest IS NULL",
        [],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        local == 1,
        "execution node migration did not record the local node"
    );
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 175
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "execution node schema admission failed");
    tx.commit()?;
    Ok(())
}
