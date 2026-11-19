//! Core-owned member target selection and immutable real-AgentRun target binding.
//!
//! This module never creates an AgentRun or starts a process. Delivery creates the
//! real Run, then freezes this row in the same transaction. Native claim and
//! authenticated LOOM tools revalidate it; an explicit remote failure is never local.

use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    agent_profile::{AdapterKind, AdapterPermissionConfig, ModelSelection},
    remote_catalog::{RemoteCatalogEntry, load_remote_catalog},
    remote_process::FrozenRemoteTarget,
};

pub use crate::remote_catalog::revalidate_remote_target;

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE remote_runtime_installation (
    installation_id TEXT PRIMARY KEY REFERENCES adapter_installation(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES execution_node(node_id),
    adapter_kind TEXT NOT NULL,
    program TEXT NOT NULL,
    installation_identity TEXT NOT NULL,
    installation_generation INTEGER NOT NULL CHECK(installation_generation BETWEEN 1 AND 9007199254740991),
    reported_version TEXT,
    UNIQUE(node_id, adapter_kind, installation_identity, installation_generation)
);
CREATE TABLE member_execution_target (
    member_id TEXT PRIMARY KEY REFERENCES agent_profile(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    node_id TEXT REFERENCES execution_node(node_id),
    selection_json TEXT CHECK(selection_json IS NULL OR json_valid(selection_json)),
    updated_at TEXT NOT NULL,
    CHECK((node_id IS NULL) = (selection_json IS NULL))
);
CREATE TABLE agent_run_execution_target (
    agent_run_id TEXT PRIMARY KEY REFERENCES agent_run(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES agent_profile(id),
    conversation_id TEXT NOT NULL REFERENCES conversation(id),
    camp_id TEXT NOT NULL REFERENCES camp(id),
    node_id TEXT NOT NULL REFERENCES execution_node(node_id),
    installation_id TEXT NOT NULL REFERENCES remote_runtime_installation(installation_id),
    selection_revision INTEGER NOT NULL CHECK(selection_revision >= 1),
    target_json TEXT NOT NULL CHECK(json_valid(target_json)),
    frozen_at TEXT NOT NULL
);
CREATE TRIGGER agent_run_execution_target_immutable
    BEFORE UPDATE ON agent_run_execution_target
    BEGIN SELECT RAISE(ABORT, 'AgentRun execution target is immutable'); END;
CREATE TRIGGER agent_run_execution_target_no_replace
    BEFORE INSERT ON agent_run_execution_target
    WHEN EXISTS(SELECT 1 FROM agent_run_execution_target WHERE agent_run_id=NEW.agent_run_id)
    BEGIN SELECT RAISE(ABORT, 'AgentRun execution target is immutable'); END;
CREATE TRIGGER agent_run_execution_target_no_direct_delete
    BEFORE DELETE ON agent_run_execution_target
    WHEN EXISTS(SELECT 1 FROM agent_run WHERE id=OLD.agent_run_id)
    BEGIN SELECT RAISE(ABORT, 'AgentRun execution target is immutable'); END;
CREATE TABLE loom_claim_execution_target (
    claim_id TEXT PRIMARY KEY REFERENCES loom_claim(claim_id) ON DELETE CASCADE,
    agent_run_id TEXT NOT NULL REFERENCES agent_run(id),
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 1),
    node_id TEXT NOT NULL REFERENCES execution_node(node_id),
    task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
    configuration_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TRIGGER loom_claim_execution_target_immutable
    BEFORE UPDATE ON loom_claim_execution_target
    BEGIN SELECT RAISE(ABORT, 'LOOM claim execution target is immutable'); END;
CREATE TRIGGER loom_claim_execution_target_no_replace
    BEFORE INSERT ON loom_claim_execution_target
    WHEN EXISTS(SELECT 1 FROM loom_claim_execution_target WHERE claim_id=NEW.claim_id)
    BEGIN SELECT RAISE(ABORT, 'LOOM claim execution target is immutable'); END;
CREATE TRIGGER loom_claim_execution_target_no_direct_delete
    BEFORE DELETE ON loom_claim_execution_target
    WHEN EXISTS(SELECT 1 FROM loom_claim WHERE claim_id=OLD.claim_id)
    BEGIN SELECT RAISE(ABORT, 'LOOM claim execution target is immutable'); END;
"#;

/// The member explicitly selects Node's workspace and native runtime policy.
/// Provider credentials and process environments are not part of this document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteMemberSelection {
    pub node_id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub adapter_kind: AdapterKind,
    pub model: ModelSelection,
    pub permissions: AdapterPermissionConfig,
}

impl RemoteMemberSelection {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            valid_id(&self.node_id, 80) && valid_id(&self.workspace_id, 128),
            "remote_target_identity"
        );
        ensure!(
            !self.workspace_root.trim().is_empty()
                && self.workspace_root.len() <= 32768
                && !self.workspace_root.chars().any(char::is_control),
            "remote_target_workspace"
        );
        ensure!(
            matches!(
                self.adapter_kind,
                AdapterKind::ClaudeCodeCli | AdapterKind::CodexCli
            ),
            "remote_target_adapter_unsupported"
        );
        ensure!(
            self.permissions.adapter_kind == self.adapter_kind
                && self.permissions.schema_version >= 1
                && self.permissions.values.is_object(),
            "remote_target_permissions"
        );
        if let ModelSelection::Explicit {
            model_id, options, ..
        } = &self.model
        {
            ensure!(
                !model_id.trim().is_empty() && model_id.len() <= 512 && options.is_object(),
                "remote_target_model"
            );
        }
        ensure!(
            serde_json::to_vec(self)?.len() <= 64 * 1024,
            "remote_target_size"
        );
        ensure!(
            crate::agent_profile::validate_remote_member_configuration(
                self.adapter_kind,
                &self.model,
                &self.permissions
            )?
            .is_none(),
            "remote_target_runtime_configuration_invalid"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionedMemberTarget {
    pub member_id: String,
    pub revision: i64,
    pub selection: Option<RemoteMemberSelection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenRunTarget {
    pub member_id: String,
    pub conversation_id: String,
    pub camp_id: String,
    pub selection_revision: i64,
    pub workspace_generation: i64,
    pub workspace_token_digest: String,
    pub bundle_source_digest: String,
    pub installation_id: String,
    pub selection: RemoteMemberSelection,
    pub target: FrozenRemoteTarget,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteWorkspaceAuthority {
    pub(crate) mission_id: String,
    pub(crate) camp_id: String,
    pub(crate) generation: i64,
    pub(crate) preparation_token_digest: String,
}

/// Core's ready Mission workspace and active membership are authority. The
/// caller-supplied root is only a stale-selection detector; this never probes A.
pub(crate) fn workspace_authority(
    connection: &Connection,
    member_id: &str,
    selection: &RemoteMemberSelection,
) -> Result<RemoteWorkspaceAuthority> {
    let row: Option<(String, String, String, String, i64, String)> = connection.query_row(
        "SELECT w.mission_id,w.camp_id,w.execution_host_id,w.worktree_path,w.generation,w.preparation_token
         FROM mission_workspace w
         JOIN execution_node n ON n.node_id=w.execution_host_id
         JOIN mission ON mission.id=w.mission_id AND mission.camp_id=w.camp_id
         JOIN camp_member m ON m.camp_id=w.camp_id AND m.agent_id=?2
         WHERE w.id=?1 AND w.state='ready' AND n.role='remote' AND n.revoked_at IS NULL
           AND m.status='active' AND m.leave_requested_at IS NULL",
        params![selection.workspace_id,member_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).optional()?;
    let (mission_id, camp_id, node, root, generation, token) =
        row.context("remote_target_workspace_unavailable")?;
    ensure!(
        node == selection.node_id
            && root == selection.workspace_root
            && generation >= 1
            && !token.is_empty(),
        "remote_target_workspace_changed"
    );
    Ok(RemoteWorkspaceAuthority {
        mission_id,
        camp_id,
        generation,
        preparation_token_digest: digest(&token)?,
    })
}

fn revalidate_frozen_workspace(
    connection: &Connection,
    frozen: &FrozenRunTarget,
) -> Result<RemoteWorkspaceAuthority> {
    let workspace = workspace_authority(connection, &frozen.member_id, &frozen.selection)?;
    ensure!(
        workspace.generation == frozen.workspace_generation
            && workspace.preparation_token_digest == frozen.workspace_token_digest,
        "remote_target_workspace_generation_changed"
    );
    Ok(workspace)
}

#[derive(Debug)]
pub struct RemoteTargetError {
    code: &'static str,
}
impl RemoteTargetError {
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn invalid_input() -> Self {
        Self {
            code: "remote_target_invalid_input",
        }
    }
    pub fn from_error(error: anyhow::Error) -> Self {
        if let Some(error) = error.downcast_ref::<crate::remote_catalog::RemoteCatalogError>() {
            return Self { code: error.code() };
        }
        let code = match error.to_string().as_str() {
            "remote_target_revision_conflict" => "remote_target_revision_conflict",
            "remote_target_workspace_unavailable" => "remote_target_workspace_unavailable",
            "remote_target_workspace_changed" => "remote_target_workspace_changed",
            "remote_target_workspace_generation_changed" => {
                "remote_target_workspace_generation_changed"
            }
            "remote_target_member_unavailable" => "remote_target_member_unavailable",
            "remote_target_identity" => "remote_target_identity",
            "remote_target_workspace" => "remote_target_workspace",
            "remote_target_adapter_unsupported" => "remote_target_adapter_unsupported",
            "remote_target_permissions" => "remote_target_permissions",
            "remote_target_runtime_configuration_invalid" => {
                "remote_target_runtime_configuration_invalid"
            }
            "remote_target_model" => "remote_target_model",
            "remote_target_size" => "remote_target_size",
            "remote_target_revision_overflow" => "remote_target_revision_overflow",
            _ => "remote_target_storage_unavailable",
        };
        Self { code }
    }
}
impl std::fmt::Display for RemoteTargetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for RemoteTargetError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberTargetGetParams {
    pub member_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberTargetSaveParams {
    pub member_id: String,
    pub expected_revision: i64,
    pub selection: Option<RemoteMemberSelection>,
}

/// Pure eligibility probe. Delivery's preparation list may call this before a
/// write transaction; it never manufactures installation rows or local fallback.
pub fn validate_member_remote_selection(connection: &Connection, member_id: &str) -> Result<bool> {
    let selected = load_member_target(connection, member_id)?;
    let Some(selection) = selected.selection else {
        return Ok(false);
    };
    selection.validate()?;
    workspace_authority(connection, member_id, &selection)?;
    load_remote_catalog(
        connection,
        &selection.node_id,
        selection.adapter_kind.as_str(),
    )?;
    Ok(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableRemoteWorkspace {
    pub node_id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub mission_id: String,
    pub mission_title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberTargetView {
    #[serde(flatten)]
    pub target: VersionedMemberTarget,
    pub available_workspaces: Vec<AvailableRemoteWorkspace>,
    pub runtime_descriptors: Vec<serde_json::Value>,
}

pub(crate) fn get_member_target(
    database: &crate::db::Database,
    params: &MemberTargetGetParams,
) -> Result<MemberTargetView> {
    ensure!(valid_id(&params.member_id, 128), "remote_target_identity");
    let exists: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_profile WHERE id=?1)",
        [&params.member_id],
        |row| row.get(0),
    )?;
    ensure!(exists, "remote_target_member_unavailable");
    let target = load_member_target(database.connection(), &params.member_id)?;
    let mut statement = database.connection().prepare(
        "SELECT w.execution_host_id,w.id,w.worktree_path,w.mission_id,mission.title
         FROM mission_workspace w
         JOIN execution_node n ON n.node_id=w.execution_host_id
         JOIN camp_member m ON m.camp_id=w.camp_id AND m.agent_id=?1
         JOIN mission ON mission.id=w.mission_id AND mission.camp_id=w.camp_id
         WHERE w.state='ready' AND n.role='remote' AND n.revoked_at IS NULL
           AND m.status='active' AND m.leave_requested_at IS NULL
           AND w.generation>=1 AND length(w.preparation_token)>0
         ORDER BY mission.title,w.id",
    )?;
    let available_workspaces = statement
        .query_map([&params.member_id], |row| {
            Ok(AvailableRemoteWorkspace {
                node_id: row.get(0)?,
                workspace_id: row.get(1)?,
                workspace_root: row.get(2)?,
                mission_id: row.get(3)?,
                mission_title: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let registry = crate::agent_runtime_adapter::AgentRuntimeAdapterRegistry::default();
    let runtime_descriptors = [AdapterKind::ClaudeCodeCli, AdapterKind::CodexCli]
        .into_iter()
        .map(|adapter| {
            serde_json::json!({
                "adapterKind":adapter,
                "permissionSchemaVersion":1,
                "permissionOptions":registry.permission_options(adapter),
                "memberRuntimeDefaults":crate::agent_profile::member_runtime_defaults(adapter),
                "supportsRuntimeDefaultModel":true
            })
        })
        .collect();
    Ok(MemberTargetView {
        target,
        available_workspaces,
        runtime_descriptors,
    })
}

pub(crate) fn set_member_target(
    database: &mut crate::db::Database,
    params: MemberTargetSaveParams,
) -> Result<VersionedMemberTarget> {
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let selected = save_member_target(
        &transaction,
        &params.member_id,
        params.expected_revision,
        params.selection,
    )?;
    transaction.commit()?;
    Ok(selected)
}

fn valid_id(value: &str, cap: usize) -> bool {
    !value.is_empty()
        && value.len() <= cap
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}

fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}

pub fn load_member_target(
    connection: &Connection,
    member_id: &str,
) -> Result<VersionedMemberTarget> {
    let row: Option<(i64, Option<String>)> = connection
        .query_row(
            "SELECT revision,selection_json FROM member_execution_target WHERE member_id=?1",
            [member_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (revision, json) = row.unwrap_or((0, None));
    let selection = json
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .context("remote_target_stored_selection")?;
    Ok(VersionedMemberTarget {
        member_id: member_id.to_string(),
        revision,
        selection,
    })
}

/// Caller is the existing authenticated member-settings owner and holds this
/// transaction throughout CAS. A clear is an explicit local selection; revisions
/// are retained to prevent a remove/recreate ABA from accepting a stale editor.
pub fn save_member_target(
    transaction: &Transaction<'_>,
    member_id: &str,
    expected_revision: i64,
    selection: Option<RemoteMemberSelection>,
) -> Result<VersionedMemberTarget> {
    ensure!(
        valid_id(member_id, 128) && expected_revision >= 0,
        "remote_target_identity"
    );
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_profile WHERE id=?1 AND profile_status IN ('present','away'))",
        [member_id], |row| row.get(0),
    )?;
    ensure!(exists, "remote_target_member_unavailable");
    let previous = load_member_target(transaction, member_id)?;
    ensure!(
        previous.revision == expected_revision,
        "remote_target_revision_conflict"
    );
    if let Some(selection) = &selection {
        selection.validate()?;
        workspace_authority(transaction, member_id, selection)?;
        load_remote_catalog(
            transaction,
            &selection.node_id,
            selection.adapter_kind.as_str(),
        )?;
    }
    let revision = expected_revision
        .checked_add(1)
        .context("remote_target_revision_overflow")?;
    let node = selection
        .as_ref()
        .map(|selection| selection.node_id.as_str());
    let json = selection.as_ref().map(serde_json::to_string).transpose()?;
    let now = chrono::Utc::now().to_rfc3339();
    let changed = if expected_revision == 0 {
        transaction.execute(
            "INSERT INTO member_execution_target(member_id,revision,node_id,selection_json,updated_at)
             VALUES(?1,?2,?3,?4,?5)", params![member_id,revision,node,json,now],
        )?
    } else {
        transaction.execute(
            "UPDATE member_execution_target SET revision=?2,node_id=?3,selection_json=?4,updated_at=?5
             WHERE member_id=?1 AND revision=?6", params![member_id,revision,node,json,now,expected_revision],
        )?
    };
    ensure!(changed == 1, "remote_target_revision_conflict");
    Ok(VersionedMemberTarget {
        member_id: member_id.to_string(),
        revision,
        selection,
    })
}

/// This row exists solely to satisfy Core's established native-session and Run
/// installation FK. It is disabled for local launch and has a distinct remote
/// namespace. The remote resolver must prove this mapping before using it.
fn ensure_remote_installation(
    transaction: &Transaction<'_>,
    catalog: &RemoteCatalogEntry,
    adapter: AdapterKind,
) -> Result<String> {
    let installation_id = format!(
        "remote_{}",
        digest(&(
            &catalog.node_id,
            adapter.as_str(),
            &catalog.installation_identity,
            catalog.installation_generation,
        ))?
        .trim_start_matches("sha256:")
    );
    let existing: Option<(String, String, String, i64)> = transaction
        .query_row(
            "SELECT node_id,program,installation_identity,installation_generation
         FROM remote_runtime_installation WHERE installation_id=?1",
            [&installation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((node, program, identity, generation)) = existing {
        ensure!(
            node == catalog.node_id
                && program == catalog.program
                && identity == catalog.installation_identity
                && u64::try_from(generation).ok() == Some(catalog.installation_generation),
            "remote_installation_identity_conflict"
        );
        return Ok(installation_id);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let generation =
        i64::try_from(catalog.installation_generation).context("remote_installation_generation")?;
    // A local probe can never execute this URI. The actual Node program remains
    // in remote_runtime_installation and the immutable FrozenRemoteTarget.
    let local_placeholder = format!("rovai-remote://{}/{}", catalog.node_id, adapter.as_str());
    transaction.execute(
        "INSERT INTO adapter_installation(
            id,adapter_kind,executable_path,command_name,installation_class,source,
            auth_scope,enabled,generation,path_state,version,created_at,updated_at)
         VALUES(?1,?2,?3,?2,'custom','custom',?4,0,?5,'path_missing',1,?6,?6)",
        params![
            installation_id,
            adapter.as_str(),
            local_placeholder,
            format!("remote_node:{}", catalog.node_id),
            generation,
            now
        ],
    )?;
    transaction.execute(
        "INSERT INTO remote_runtime_installation(
            installation_id,node_id,adapter_kind,program,installation_identity,
            installation_generation,reported_version)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            installation_id,
            catalog.node_id,
            adapter.as_str(),
            catalog.program,
            catalog.installation_identity,
            generation,
            catalog.reported_version
        ],
    )?;
    Ok(installation_id)
}

/// Called during Delivery's transaction, before building the frozen runtime.
/// No saved selection means the pre-existing local path. A broken selection is
/// an error; it can never be transformed into None or silently run on A.
pub fn prepare_member_target(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    member_id: &str,
) -> Result<Option<FrozenRunTarget>> {
    let selected = load_member_target(transaction, member_id)?;
    let Some(selection) = selected.selection else {
        return Ok(None);
    };
    selection.validate()?;
    let camp: Option<String> = transaction
        .query_row(
            "SELECT c.camp_id FROM conversation c
         JOIN camp_member m ON m.camp_id=c.camp_id AND m.agent_id=c.agent_id
         JOIN agent_profile a ON a.id=c.agent_id
         WHERE c.id=?1 AND c.agent_id=?2 AND m.status='active'
           AND m.leave_requested_at IS NULL AND a.profile_status='present'",
            params![conversation_id, member_id],
            |row| row.get(0),
        )
        .optional()?;
    let camp_id = camp.context("remote_target_membership_unavailable")?;
    let workspace = workspace_authority(transaction, member_id, &selection)?;
    let catalog = load_remote_catalog(
        transaction,
        &selection.node_id,
        selection.adapter_kind.as_str(),
    )?;
    let installation_id =
        ensure_remote_installation(transaction, &catalog, selection.adapter_kind)?;
    let configuration_digest = digest(&(
        member_id,
        conversation_id,
        selected.revision,
        &selection,
        workspace.generation,
        &workspace.preparation_token_digest,
        &catalog.installation_identity,
        catalog.installation_generation,
    ))?;
    let target = FrozenRemoteTarget {
        node_id: selection.node_id.clone(),
        node_generation: catalog.installation_generation,
        workspace_id: selection.workspace_id.clone(),
        workspace_root: selection.workspace_root.clone(),
        adapter_kind: selection.adapter_kind.as_str().to_string(),
        program: catalog.program,
        program_identity: catalog.installation_identity,
        configuration_digest,
    };
    target.validate()?;
    Ok(Some(FrozenRunTarget {
        member_id: member_id.to_string(),
        conversation_id: conversation_id.to_string(),
        camp_id,
        selection_revision: selected.revision,
        workspace_generation: workspace.generation,
        workspace_token_digest: workspace.preparation_token_digest,
        bundle_source_digest: String::new(),
        installation_id,
        selection,
        target,
    }))
}

pub fn freeze_run_target(
    transaction: &Transaction<'_>,
    agent_run_id: &str,
    target: &FrozenRunTarget,
) -> Result<()> {
    ensure!(
        target
            .bundle_source_digest
            .strip_prefix("sha256:")
            .is_some_and(|value| value.len() == 64
                && value
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))),
        "remote_bundle_source_required"
    );
    let run: Option<(String, String, String, i64)> = transaction
        .query_row(
            "SELECT r.conversation_id,c.agent_id,c.camp_id,r.execution_epoch
         FROM agent_run r JOIN conversation c ON c.id=r.conversation_id
         WHERE r.id=?1 AND r.status='queued' AND r.runtime_installation_id=?2",
            params![agent_run_id, target.installation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (conversation, member, camp, epoch) =
        run.context("remote_target_real_queued_run_required")?;
    ensure!(
        conversation == target.conversation_id
            && member == target.member_id
            && camp == target.camp_id
            && epoch == 0,
        "remote_target_run_scope"
    );
    if let Some(existing) = load_run_target(transaction, agent_run_id)? {
        ensure!(existing == *target, "remote_target_frozen_conflict");
        return Ok(());
    }
    revalidate_remote_target(transaction, &target.target)?;
    revalidate_frozen_workspace(transaction, target)?;
    transaction.execute(
        "INSERT INTO agent_run_execution_target(
            agent_run_id,member_id,conversation_id,camp_id,node_id,installation_id,
            selection_revision,target_json,frozen_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            agent_run_id,
            target.member_id,
            target.conversation_id,
            target.camp_id,
            target.target.node_id,
            target.installation_id,
            target.selection_revision,
            serde_json::to_string(target)?,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

pub fn load_run_target(
    connection: &Connection,
    agent_run_id: &str,
) -> Result<Option<FrozenRunTarget>> {
    let json: Option<String> = connection
        .query_row(
            "SELECT target_json FROM agent_run_execution_target WHERE agent_run_id=?1",
            [agent_run_id],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| serde_json::from_str(&json).context("remote_target_stored_run"))
        .transpose()
}

/// Must run inside claim_agent_run's existing transaction before its CAS update.
pub fn revalidate_run_claim(
    connection: &Connection,
    agent_run_id: &str,
) -> Result<Option<FrozenRunTarget>> {
    let Some(target) = load_run_target(connection, agent_run_id)? else {
        return Ok(None);
    };
    revalidate_remote_target(connection, &target.target)?;
    revalidate_frozen_workspace(connection, &target)?;
    let source_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run_remote_bundle_source
         WHERE agent_run_id=?1 AND source_digest=?2)",
        params![agent_run_id, target.bundle_source_digest],
        |row| row.get(0),
    )?;
    ensure!(source_exists, "remote_bundle_source_required");
    let valid: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run r JOIN conversation c ON c.id=r.conversation_id
         JOIN camp_member m ON m.camp_id=c.camp_id AND m.agent_id=c.agent_id
         WHERE r.id=?1 AND c.id=?2 AND c.agent_id=?3 AND c.camp_id=?4
           AND r.runtime_installation_id=?5 AND m.status='active' AND m.leave_requested_at IS NULL)",
        params![agent_run_id,target.conversation_id,target.member_id,target.camp_id,target.installation_id],
        |row| row.get(0),
    )?;
    ensure!(valid, "remote_target_run_scope");
    Ok(Some(target))
}

#[derive(Debug, Clone)]
pub struct RemoteClaimAdmission {
    agent_run_id: String,
    execution_epoch: i64,
    node_id: String,
    task_id: String,
    task_revision: i64,
    needs_task_binding: bool,
    configuration_digest: String,
}

impl RemoteClaimAdmission {
    /// Revision observed by a fresh authority read after the Task was bound.
    /// An admission that still needs first-claim binding cannot prove evidence ownership.
    pub(crate) fn bound_task_revision(&self) -> Option<i64> {
        (!self.needs_task_binding).then_some(self.task_revision)
    }
}

/// Pure admission under loom::claim_acquire's existing write transaction.
/// A real remote Run proves the user-selected, frozen Node/workspace and current
/// Run/Mission/member/task authority. An unbound Task may bind to that exact
/// target only when the claim is successfully recorded in the same transaction.
/// Existing different pins and legacy task-native execution are never inferred.
pub fn validate_loom_claim(
    connection: &Connection,
    agent_run_id: &str,
    mission_id: &str,
    task_id: &str,
    claimant_agent_id: Option<&str>,
) -> Result<Option<RemoteClaimAdmission>> {
    if !authority_table_available(connection, "agent_run_execution_target")? {
        return Ok(None);
    }
    let Some(target) = revalidate_run_claim(connection, agent_run_id)? else {
        // An orphaned remote installation is not permission to claim locally.
        let orphaned_remote: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_run r
             JOIN remote_runtime_installation i ON i.installation_id=r.runtime_installation_id
             WHERE r.id=?1)",
            [agent_run_id],
            |row| row.get(0),
        )?;
        ensure!(!orphaned_remote, "remote_claim_frozen_target_required");
        return Ok(None);
    };
    let epoch: Option<i64> = connection
        .query_row(
            "SELECT r.execution_epoch FROM agent_run r
         JOIN conversation c ON c.id=r.conversation_id
         JOIN mission m ON m.camp_id=c.camp_id
         WHERE r.id=?1 AND c.id=?2 AND c.agent_id=?3 AND c.camp_id=?4
           AND m.id=?5 AND r.status IN ('running','waiting') AND r.execution_epoch>=1
           AND r.cancel_requested_at IS NULL",
            params![
                agent_run_id,
                target.conversation_id,
                target.member_id,
                target.camp_id,
                mission_id
            ],
            |row| row.get(0),
        )
        .optional()?;
    let execution_epoch = epoch.context("remote_claim_real_run_required")?;
    let workspace = revalidate_frozen_workspace(connection, &target)?;
    ensure!(
        workspace.mission_id == mission_id && workspace.camp_id == target.camp_id,
        "remote_claim_workspace_mission_scope"
    );
    ensure!(
        claimant_agent_id == Some(target.member_id.as_str()),
        "remote_claim_member_scope"
    );
    let task: Option<(Option<String>, Option<String>, i64)> = connection
        .query_row(
            "SELECT t.assignee_agent_id,t.execution_host_id,t.revision
         FROM loom_task t JOIN loom_plan p ON p.plan_id=t.plan_id
         WHERE t.task_id=?1 AND p.mission_id=?2",
            params![task_id, mission_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (assignee, node, task_revision) = task.context("remote_claim_task_scope")?;
    ensure!(
        assignee
            .as_deref()
            .is_none_or(|assignee| assignee == target.member_id),
        "remote_claim_assignee"
    );
    ensure!(
        node.as_deref()
            .is_none_or(|node| node == target.target.node_id),
        "remote_claim_task_host_mismatch"
    );
    revalidate_remote_target(connection, &target.target)?;
    revalidate_frozen_workspace(connection, &target)?;
    Ok(Some(RemoteClaimAdmission {
        agent_run_id: agent_run_id.to_string(),
        execution_epoch,
        node_id: target.target.node_id,
        task_id: task_id.to_string(),
        task_revision,
        needs_task_binding: node.is_none(),
        configuration_digest: target.target.configuration_digest,
    }))
}

pub fn record_loom_claim(
    transaction: &Transaction<'_>,
    claim_id: &str,
    admission: &RemoteClaimAdmission,
) -> Result<()> {
    let same: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM loom_claim WHERE claim_id=?1 AND agent_run_id=?2
         AND task_id=?3 AND released_at IS NULL)",
        params![claim_id, admission.agent_run_id, admission.task_id],
        |row| row.get(0),
    )?;
    ensure!(same, "remote_claim_binding_missing");
    let now = chrono::Utc::now().to_rfc3339();
    let recorded_revision = if admission.needs_task_binding {
        let next_revision = admission
            .task_revision
            .checked_add(1)
            .context("remote_claim_task_revision_exhausted")?;
        let changed = transaction.execute(
            "UPDATE loom_task SET execution_host_id=?1,revision=?2,updated_at=?3
             WHERE task_id=?4 AND revision=?5 AND execution_host_id IS NULL
               AND plan_id=(SELECT plan_id FROM loom_claim WHERE claim_id=?6)",
            params![
                admission.node_id,
                next_revision,
                now,
                admission.task_id,
                admission.task_revision,
                claim_id
            ],
        )?;
        ensure!(changed == 1, "remote_claim_task_binding_changed");
        next_revision
    } else {
        let current: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loom_task t JOIN loom_claim c
             ON c.plan_id=t.plan_id AND c.task_id=t.task_id
             WHERE c.claim_id=?1 AND t.task_id=?2
               AND t.execution_host_id=?3 AND t.revision=?4)",
            params![
                claim_id,
                admission.task_id,
                admission.node_id,
                admission.task_revision
            ],
            |row| row.get(0),
        )?;
        ensure!(current, "remote_claim_task_binding_changed");
        admission.task_revision
    };
    transaction.execute(
        "INSERT INTO loom_claim_execution_target(claim_id,agent_run_id,execution_epoch,
            node_id,task_revision,configuration_digest,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            claim_id,
            admission.agent_run_id,
            admission.execution_epoch,
            admission.node_id,
            recorded_revision,
            admission.configuration_digest,
            now
        ],
    )?;
    Ok(())
}

/// Validate a trusted Core launch against the immutable target of the real,
/// currently claimed Run. The workspace is the explicitly frozen member
/// selection; no A-side filesystem lookup can prove a Node path.
pub fn revalidate_remote_launch(
    connection: &Connection,
    launch: &crate::remote_process::ScopedRemoteLaunch,
) -> Result<()> {
    launch.validate()?;
    let frozen = validate_running_owner(connection, &launch.key, &launch.initial_owner)?;
    ensure!(
        frozen.target == launch.target
            && frozen.member_id == launch.host_scope.member_id
            && frozen.conversation_id == launch.host_scope.logical_session_id
            && frozen.target.workspace_id == launch.host_scope.workspace_id,
        "remote_launch_frozen_scope_mismatch"
    );
    Ok(())
}

pub fn validate_running_owner(
    connection: &Connection,
    key: &crate::remote_process::RemoteProcessKey,
    owner: &crate::remote_process::AgentRunOwner,
) -> Result<FrozenRunTarget> {
    key.validate()?;
    owner.validate()?;
    let target =
        load_run_target(connection, &owner.agent_run_id)?.context("remote_owner_target_missing")?;
    ensure!(
        key.node_id == target.target.node_id,
        "remote_owner_node_mismatch"
    );
    let epoch = i64::try_from(owner.execution_epoch).context("remote_owner_epoch")?;
    let active: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run r JOIN conversation c ON c.id=r.conversation_id
         WHERE r.id=?1 AND r.execution_epoch=?2 AND r.status IN ('running','waiting')
           AND r.cancel_requested_at IS NULL AND c.id=?3 AND c.agent_id=?4 AND c.camp_id=?5
           AND r.runtime_installation_id=?6)",
        params![
            owner.agent_run_id,
            epoch,
            target.conversation_id,
            target.member_id,
            target.camp_id,
            target.installation_id
        ],
        |row| row.get(0),
    )?;
    ensure!(active, "remote_owner_run_not_active");
    revalidate_remote_target(connection, &target.target)?;
    revalidate_frozen_workspace(connection, &target)?;
    Ok(target)
}

pub(crate) fn authority_table_available(connection: &Connection, table: &str) -> Result<bool> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(true);
    }
    let contract_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='rovai_data_contract')",
        [], |row| row.get(0),
    )?;
    if contract_exists {
        let schema: Option<i64> = connection
            .query_row(
                "SELECT projection_schema_version FROM rovai_data_contract WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            schema.is_none_or(|schema| schema < 181),
            "remote_required_schema_missing"
        );
    }
    Ok(false)
}

pub fn is_remote_installation(connection: &Connection, installation_id: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM remote_runtime_installation WHERE installation_id=?1)",
            [installation_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

/// Resolve a terminal cleanup path only from the actual Run's local authority.
/// Equal strings on A and B are unrelated paths. Missing runtime/installation or
/// remote authority can never authorize Core filesystem reconciliation.
pub(crate) fn terminal_local_execution_root(
    connection: &Connection,
    agent_run_id: &str,
) -> Result<Option<String>> {
    let row: Option<(Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT workspace_json,runtime_installation_id FROM agent_run WHERE id=?1",
            [agent_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((Some(workspace), Some(installation))) = row else {
        return Ok(None);
    };
    if authority_table_available(connection, "agent_run_execution_target")? {
        let frozen_remote: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_run_execution_target WHERE agent_run_id=?1)",
            [agent_run_id],
            |row| row.get(0),
        )?;
        if frozen_remote {
            return Ok(None);
        }
    }
    if authority_table_available(connection, "remote_runtime_installation")?
        && is_remote_installation(connection, &installation)?
    {
        return Ok(None);
    }
    let local_installation: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM adapter_installation WHERE id=?1)",
        [&installation],
        |row| row.get(0),
    )?;
    if !local_installation {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_str(&workspace)?;
    let root = value
        .get("executionRoot")
        .and_then(serde_json::Value::as_str)
        .context("terminal_run_workspace_unavailable")?;
    ensure!(
        !root.trim().is_empty() && root.len() <= 32768,
        "terminal_run_workspace_invalid"
    );
    Ok(Some(root.to_string()))
}

/// Exact normalized definitions include FK/unique/check/immutability contracts.
/// A same-named empty table, weakened PK or no-op trigger cannot pass admission.
pub fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    for (name, kind) in [
        ("installation_identity", "TEXT"),
        ("installation_generation", "INTEGER"),
    ] {
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('execution_node_cli')
             WHERE name=?1 AND upper(type)=?2 AND \"notnull\"=0)",
            params![name, kind],
            |row| row.get(0),
        )?;
        if !valid {
            return Ok(false);
        }
    }
    fn normalized(sql: &str) -> String {
        let mut out = String::new();
        let mut quote = None;
        let mut chars = sql.chars().peekable();
        while let Some(c) = chars.next() {
            if let Some(end) = quote {
                out.push(c);
                if c == end {
                    if chars.peek() == Some(&end) {
                        out.push(chars.next().unwrap());
                    } else {
                        quote = None;
                    }
                }
            } else if matches!(c, '\'' | '"' | '[') || c as u32 == 96 {
                quote = Some(if c == '[' { ']' } else { c });
                out.push(c);
            } else if !c.is_ascii_whitespace() {
                out.push(c);
            }
        }
        out
    }
    fn objects(
        connection: &Connection,
    ) -> rusqlite::Result<Vec<(String, String, String, Option<String>)>> {
        let mut statement = connection.prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master
             WHERE tbl_name IN ('remote_runtime_installation','member_execution_target',
                                'agent_run_execution_target','loom_claim_execution_target',
                                'agent_run_remote_bundle_source','agent_run_remote_process')
             ORDER BY type,name",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get::<_, Option<String>>(3)?.map(|sql| normalized(&sql)),
                ))
            })?
            .collect()
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA_SQL)?;
    expected.execute_batch(crate::remote_bundle_owner::SCHEMA_SQL)?;
    Ok(objects(connection)? == objects(&expected)?)
}

#[cfg(test)]
mod terminal_path_tests {
    use super::*;

    // A tiny SQL authority fixture owns the cross-host equal-path regression.
    // No real path is created or inspected; a string alone cannot choose A.
    #[test]
    fn terminal_projection_uses_actual_run_authority_for_equal_host_paths() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("
            CREATE TABLE agent_run(id TEXT PRIMARY KEY,workspace_json TEXT,runtime_installation_id TEXT);
            CREATE TABLE adapter_installation(id TEXT PRIMARY KEY);
            CREATE TABLE agent_run_execution_target(agent_run_id TEXT PRIMARY KEY);
            CREATE TABLE remote_runtime_installation(installation_id TEXT PRIMARY KEY);
            INSERT INTO adapter_installation VALUES('local-cli'),('remote-cli');
            INSERT INTO remote_runtime_installation VALUES('remote-cli');
        ").unwrap();
        let workspace=serde_json::json!({"executionRoot":"C:/same/path","access":"write","isolation":"runtime_managed"}).to_string();
        for (run, installation) in [
            ("local", Some("local-cli")),
            ("remote", Some("remote-cli")),
            ("frozen", Some("local-cli")),
            ("unknown", None),
            ("removed", Some("missing-cli")),
        ] {
            connection
                .execute(
                    "INSERT INTO agent_run VALUES(?1,?2,?3)",
                    params![run, workspace, installation],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO agent_run_execution_target VALUES('frozen')",
                [],
            )
            .unwrap();
        assert_eq!(
            terminal_local_execution_root(&connection, "local")
                .unwrap()
                .as_deref(),
            Some("C:/same/path")
        );
        for run in ["remote", "frozen", "unknown", "removed", "absent"] {
            assert_eq!(
                terminal_local_execution_root(&connection, run).unwrap(),
                None,
                "{run}"
            );
        }
        connection
            .execute_batch(
                "
            CREATE TABLE rovai_data_contract(singleton INTEGER,projection_schema_version INTEGER);
            INSERT INTO rovai_data_contract VALUES(1,181);
            DROP TABLE remote_runtime_installation;
        ",
            )
            .unwrap();
        assert!(
            terminal_local_execution_root(&connection, "local").is_err(),
            "current authority damage is not permission to reconcile A"
        );
    }
}
