//! Migration 227: rule snippets, hooks, and the inherited-or-explicit choice of a member.
//! Toolbox skills and MCP assignments stay in the stores they already have.
use super::*;

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 176
        ),
        "member capability migration requires schema 176"
    );
    tx.execute_batch(crate::member_capability::SCHEMA_SQL)?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(227,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=177,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(
        &tx,
        &[
            "member_capability_item",
            "member_capability_choice",
            "member_capability_tool_claim",
        ],
    )?;
    anyhow::ensure!(
        crate::member_capability::schema_matches(&tx)?,
        "member capability migration did not create the required tables"
    );
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 177
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "member capability schema admission failed");
    tx.commit()?;
    Ok(())
}
