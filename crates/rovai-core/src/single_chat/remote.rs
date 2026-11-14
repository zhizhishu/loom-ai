//! Remote Single Chat admission reuses the existing command transaction.
//! No substitute Run, private-chat policy expansion or B filesystem access.
use super::*;
use crate::{
    remote_bundle_owner::{RemoteBundleCaptureContext, bind_captured_source},
    remote_execution::{FrozenRunTarget, authority_table_available},
    remote_run_bundle::{
        BundleSourceDatabaseStamp, FreezeMemberBundleParams, FrozenBundleSource,
        capture_in_existing_transaction,
    },
};
use std::path::PathBuf;

pub(super) struct SourceCapture {
    member_id: String,
    conversation_id: String,
    data_dir: PathBuf,
    source: FrozenBundleSource,
    stamp: BundleSourceDatabaseStamp,
}

pub(super) struct RemoteAdmission {
    pub target: FrozenRunTarget,
    source: FrozenBundleSource,
    data_dir: PathBuf,
}

pub(super) fn has_remote_selection(
    connection: &rusqlite::Connection,
    member_id: &str,
) -> Result<bool> {
    if !authority_table_available(connection, "member_execution_target")? {
        return Ok(false);
    }
    Ok(
        crate::remote_execution::load_member_target(connection, member_id)?
            .selection
            .is_some(),
    )
}

/// Called only after the command gateway's existing replay check. Capture errors
/// are held until a new Run is actually admitted; queue-only input keeps its
/// original behavior and never consumes a runtime/source snapshot.
pub(super) fn capture(
    database: &Database,
    sources: Option<&RemoteBundleCaptureContext<'_>>,
    conversation_id: &str,
) -> Result<Option<SourceCapture>> {
    let Some(sources) = sources else {
        return Ok(None);
    };
    if !authority_table_available(database.connection(), "member_execution_target")? {
        return Ok(None);
    }
    let stamp = BundleSourceDatabaseStamp::capture(database.connection())?;
    let tx = database.connection().unchecked_transaction()?;
    let member_id: Option<String> = tx.query_row(
        "SELECT agent_id FROM conversation WHERE id=?1 AND kind='single_chat' AND ended_at IS NULL",
        [conversation_id], |row| row.get(0),
    ).optional()?;
    let captured = if let Some(member_id) = member_id {
        let selected = crate::remote_execution::load_member_target(&tx, &member_id)?;
        if let Some(selection) = selected.selection {
            selection.validate()?;
            let catalog = crate::remote_catalog::load_remote_catalog(
                &tx,
                &selection.node_id,
                selection.adapter_kind.as_str(),
            )?;
            let source = capture_in_existing_transaction(
                database,
                sources.data_dir,
                sources.mcp_store,
                &FreezeMemberBundleParams {
                    member_id: member_id.clone(),
                    runtime: selection.adapter_kind.as_str().to_string(),
                    reported_runtime_version: catalog.reported_version,
                },
            )?;
            anyhow::ensure!(
                source.member_id() == member_id && source.adapter_kind() == selection.adapter_kind,
                "remote_bundle_source_scope"
            );
            Some(SourceCapture {
                member_id,
                conversation_id: conversation_id.to_string(),
                data_dir: sources.data_dir.to_path_buf(),
                source,
                stamp,
            })
        } else {
            None
        }
    } else {
        None
    };
    tx.rollback()?;
    stamp.verify(database.connection())?;
    Ok(captured)
}

/// This is reached after Single Chat's identity/queue checks and before its
/// first write. The conservative stamp also fences another connection's writes.
pub(super) fn prepare(
    transaction: &Transaction<'_>,
    target: &ActiveTarget,
    captured: &Result<Option<SourceCapture>>,
    has_attachments: bool,
) -> Result<Option<RemoteAdmission>> {
    if !has_remote_selection(transaction, &target.agent_id)? {
        return Ok(None);
    }
    anyhow::ensure!(!has_attachments, "remote_file_transfer_required");
    let captured = captured
        .as_ref()
        .map_err(|error| anyhow::anyhow!("remote_bundle_source_unavailable: {error:#}"))?
        .as_ref()
        .context("remote_bundle_source_unavailable")?;
    anyhow::ensure!(
        captured.member_id == target.agent_id && captured.conversation_id == target.conversation_id,
        "remote_bundle_source_scope"
    );
    captured.stamp.verify(transaction)?;
    let mut frozen = crate::remote_execution::prepare_member_target(
        transaction,
        &target.conversation_id,
        &target.agent_id,
    )?
    .context("remote_target_selection_changed")?;
    bind_captured_source(&mut frozen, &captured.source)?;
    Ok(Some(RemoteAdmission {
        target: frozen,
        source: captured.source.clone(),
        data_dir: captured.data_dir.clone(),
    }))
}

/// admit_single_chat_message owns the real queued Run. All following rows and
/// its trusted B workspace are committed with that same command or none are.
pub(super) fn freeze(
    transaction: &Transaction<'_>,
    agent_run_id: &str,
    remote: &RemoteAdmission,
) -> Result<()> {
    let workspace = crate::runtime::AgentRunWorkspace::runtime_managed_path(
        remote.target.target.workspace_root.clone(),
    );
    let changed = transaction.execute(
        "UPDATE agent_run SET workspace_json=?2
         WHERE id=?1 AND invocation_kind='single_chat' AND status='queued'
           AND execution_epoch=0 AND workspace_json IS NULL",
        params![agent_run_id, serde_json::to_string(&workspace)?],
    )?;
    anyhow::ensure!(changed == 1, "remote_single_chat_real_run_required");
    crate::remote_execution::freeze_run_target(transaction, agent_run_id, &remote.target)?;
    let bootstrap = crate::context::capture_remote_single_chat_bootstrap(
        transaction,
        &remote.data_dir,
        agent_run_id,
    )?;
    crate::remote_bundle_owner::freeze_run_source_with_bootstrap(
        transaction,
        agent_run_id,
        &remote.target,
        &remote.source,
        Some(&bootstrap),
    )
}
