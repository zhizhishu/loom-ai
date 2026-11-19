//! Immutable capability source ownership for the real Delivery-created Run.
//! Capture happens under the caller's IMMEDIATE transaction. This module never
//! creates a substitute Run and never consults future capability selections.
use crate::{
    db::Database,
    mcp::McpConfigStore,
    remote_execution::{FrozenRunTarget, load_run_target},
    remote_run_bundle::{
        FreezeMemberBundleParams, FrozenBundleSource, capture_in_existing_transaction,
    },
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) const SCHEMA_SQL: &str = r#"
CREATE TABLE agent_run_remote_bundle_source (
    agent_run_id TEXT PRIMARY KEY REFERENCES agent_run_execution_target(agent_run_id) ON DELETE CASCADE,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=71),
    source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(CAST(source_json AS BLOB))<=4194304),
    session_bootstrap_json TEXT CHECK(session_bootstrap_json IS NULL OR
        (json_valid(session_bootstrap_json) AND length(CAST(session_bootstrap_json AS BLOB))<=1048576)),
    captured_at TEXT NOT NULL
);
CREATE TRIGGER agent_run_remote_bundle_source_immutable
    BEFORE UPDATE ON agent_run_remote_bundle_source
    BEGIN SELECT RAISE(ABORT, 'AgentRun bundle source is immutable'); END;
CREATE TRIGGER agent_run_remote_bundle_source_no_replace
    BEFORE INSERT ON agent_run_remote_bundle_source
    WHEN EXISTS(SELECT 1 FROM agent_run_remote_bundle_source WHERE agent_run_id=NEW.agent_run_id)
    BEGIN SELECT RAISE(ABORT, 'AgentRun bundle source is immutable'); END;
CREATE TRIGGER agent_run_remote_bundle_source_no_direct_delete
    BEFORE DELETE ON agent_run_remote_bundle_source
    WHEN EXISTS(SELECT 1 FROM agent_run WHERE id=OLD.agent_run_id)
    BEGIN SELECT RAISE(ABORT, 'AgentRun bundle source is immutable'); END;
CREATE TABLE agent_run_remote_process (
    node_id TEXT NOT NULL REFERENCES execution_node(node_id),
    process_id TEXT NOT NULL,
    process_epoch INTEGER NOT NULL CHECK(process_epoch BETWEEN 1 AND 9007199254740991),
    agent_run_id TEXT NOT NULL REFERENCES agent_run_execution_target(agent_run_id) ON DELETE CASCADE,
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch BETWEEN 1 AND 9007199254740991),
    logical_session_id TEXT NOT NULL,
    bundle_attempt INTEGER NOT NULL CHECK(bundle_attempt BETWEEN 1 AND 4294967295),
    source_digest TEXT NOT NULL,
    bundle_digest TEXT NOT NULL,
    bundle_json TEXT NOT NULL CHECK(json_valid(bundle_json)),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
    configuration_digest TEXT NOT NULL,
    prepared_at TEXT NOT NULL,
    PRIMARY KEY(node_id,process_id,process_epoch,agent_run_id,execution_epoch),
    UNIQUE(agent_run_id,bundle_attempt)
);
CREATE TRIGGER agent_run_remote_process_immutable
    BEFORE UPDATE ON agent_run_remote_process
    BEGIN SELECT RAISE(ABORT, 'AgentRun remote process preparation is immutable'); END;
CREATE TRIGGER agent_run_remote_process_no_replace
    BEFORE INSERT ON agent_run_remote_process
    WHEN EXISTS(SELECT 1 FROM agent_run_remote_process
        WHERE node_id=NEW.node_id AND process_id=NEW.process_id AND process_epoch=NEW.process_epoch
          AND agent_run_id=NEW.agent_run_id AND execution_epoch=NEW.execution_epoch)
    BEGIN SELECT RAISE(ABORT, 'AgentRun remote process preparation is immutable'); END;
CREATE TRIGGER agent_run_remote_process_no_direct_delete
    BEFORE DELETE ON agent_run_remote_process
    WHEN EXISTS(SELECT 1 FROM agent_run WHERE id=OLD.agent_run_id)
    BEGIN SELECT RAISE(ABORT, 'AgentRun remote process preparation is immutable'); END;
"#;

/// Explicit application-owned source roots. These are read only and are never
/// inferred from inherited provider configuration or the selected Node path.
pub struct RemoteBundleCaptureContext<'a> {
    pub data_dir: &'a Path,
    pub mcp_store: &'a McpConfigStore,
}

pub(crate) fn capture_for_target(
    database: &Database,
    context: &RemoteBundleCaptureContext<'_>,
    target: &mut FrozenRunTarget,
) -> Result<FrozenBundleSource> {
    ensure!(
        !database.connection().is_autocommit(),
        "remote_bundle_transaction_required"
    );
    ensure!(
        target.bundle_source_digest.is_empty(),
        "remote_bundle_source_already_bound"
    );
    let catalog = crate::remote_catalog::load_remote_catalog(
        database.connection(),
        &target.target.node_id,
        target.selection.adapter_kind.as_str(),
    )?;
    let source = capture_in_existing_transaction(
        database,
        context.data_dir,
        context.mcp_store,
        &FreezeMemberBundleParams {
            member_id: target.member_id.clone(),
            runtime: target.selection.adapter_kind.as_str().to_string(),
            reported_runtime_version: catalog.reported_version,
        },
    )?;
    bind_captured_source(target, &source)?;
    Ok(source)
}

/// One binding formula serves same-TX Delivery capture and a stamped SingleChat
/// source captured immediately before the command's own write transaction.
pub(crate) fn bind_captured_source(
    target: &mut FrozenRunTarget,
    source: &FrozenBundleSource,
) -> Result<()> {
    ensure!(
        target.bundle_source_digest.is_empty(),
        "remote_bundle_source_already_bound"
    );
    ensure!(
        source.member_id() == target.member_id
            && source.adapter_kind() == target.selection.adapter_kind,
        "remote_bundle_source_scope"
    );
    source.validate_hook_scope(target)?;
    target.bundle_source_digest = source.digest()?;
    target.target.configuration_digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &target.target.configuration_digest,
            &target.bundle_source_digest
        ))?,)
    );
    target.target.validate()?;
    Ok(())
}

pub(crate) fn freeze_run_source(
    transaction: &Transaction<'_>,
    agent_run_id: &str,
    target: &FrozenRunTarget,
    source: &FrozenBundleSource,
) -> Result<()> {
    freeze_run_source_with_bootstrap(transaction, agent_run_id, target, source, None)
}

pub(crate) fn freeze_run_source_with_bootstrap(
    transaction: &Transaction<'_>,
    agent_run_id: &str,
    target: &FrozenRunTarget,
    source: &FrozenBundleSource,
    session_bootstrap_json: Option<&str>,
) -> Result<()> {
    let frozen = load_run_target(transaction, agent_run_id)?
        .context("remote_bundle_real_target_required")?;
    ensure!(frozen == *target, "remote_bundle_target_mismatch");
    verify_source(target, source)?;
    if let Some(value) = session_bootstrap_json {
        ensure!(
            value.len() <= 1024 * 1024,
            "remote_single_chat_bootstrap_size"
        );
        let _: serde_json::Value =
            serde_json::from_str(value).context("remote_single_chat_bootstrap_invalid")?;
    }
    let source_json = serde_json::to_string(source)?;
    if let Some(existing) = load_run_source(transaction, agent_run_id)? {
        let previous: Option<String> = transaction.query_row(
            "SELECT session_bootstrap_json FROM agent_run_remote_bundle_source WHERE agent_run_id=?1",
            [agent_run_id], |row| row.get(0),
        )?;
        ensure!(
            existing.digest()? == source.digest()? && previous.as_deref() == session_bootstrap_json,
            "remote_bundle_frozen_conflict"
        );
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO agent_run_remote_bundle_source(
            agent_run_id,source_digest,source_json,session_bootstrap_json,captured_at)
         VALUES(?1,?2,?3,?4,?5)",
        params![
            agent_run_id,
            target.bundle_source_digest,
            source_json,
            session_bootstrap_json,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

pub(crate) fn load_run_source(
    connection: &Connection,
    agent_run_id: &str,
) -> Result<Option<FrozenBundleSource>> {
    let row: Option<(String,String)> = connection.query_row(
        "SELECT source_digest,source_json FROM agent_run_remote_bundle_source WHERE agent_run_id=?1",
        [agent_run_id], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional()?;
    let Some((digest, json)) = row else {
        return Ok(None);
    };
    ensure!(json.len() <= 4 * 1024 * 1024, "remote_bundle_source_size");
    let source: FrozenBundleSource =
        serde_json::from_str(&json).context("remote_bundle_source_invalid")?;
    let target =
        load_run_target(connection, agent_run_id)?.context("remote_bundle_real_target_required")?;
    ensure!(
        digest == target.bundle_source_digest,
        "remote_bundle_source_digest"
    );
    verify_source(&target, &source)?;
    Ok(Some(source))
}

fn verify_source(target: &FrozenRunTarget, source: &FrozenBundleSource) -> Result<()> {
    source.validate_hook_scope(target)?;
    ensure!(
        source.member_id() == target.member_id
            && source.adapter_kind() == target.selection.adapter_kind
            && source.digest()? == target.bundle_source_digest,
        "remote_bundle_source_scope"
    );
    Ok(())
}
