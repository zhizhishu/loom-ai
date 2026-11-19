//! Migration 230: durable Workspace RPC admission and replay journals.
use super::*;

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&transaction)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 179),
        "workspace RPC migration requires schema 179"
    );
    transaction.execute_batch(crate::workspace_rpc::SCHEMA)?;
    transaction.execute_batch(
        "INSERT INTO schema_migration VALUES(230,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=180,updated_at=datetime('now') WHERE singleton=1;"
    )?;
    validate_migration_foreign_keys(
        &transaction,
        &[
            "workspace_rpc_requests",
            "workspace_rpc_events",
            "workspace_rpc_audit",
        ],
    )?;
    anyhow::ensure!(
        crate::workspace_rpc::schema_matches(&transaction)?,
        "workspace RPC migration schema contract mismatch"
    );
    let admitted = match classify_database_contract(&transaction)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 180
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "workspace RPC schema admission failed");
    transaction.commit()?;
    Ok(())
}
