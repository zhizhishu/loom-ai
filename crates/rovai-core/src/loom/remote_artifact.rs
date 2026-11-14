//! Remote evidence is a Core-owned archive reference, never an A filesystem path.
//! Capture and verification use the same immutable Workspace RPC journal receipt.
use super::*;
use crate::{
    remote_execution::{FrozenRunTarget, load_run_target, revalidate_run_claim},
    team_tool::AuthenticatedTeamToolRun,
    workspace_rpc::{
        RequestState, WorkspaceArchiveKind, WorkspaceArchiveReceipt, WorkspaceRpcStore,
        read_archived_result_bytes,
    },
};
use loom_protocol::workspace_rpc::{WorkspaceDispatch, WorkspaceOperation};
use rusqlite::Connection;
use sha2::Digest;
use std::path::Path;

pub(crate) const ORIGIN_MIGRATION_SQL: &str = r#"
ALTER TABLE loom_artifact ADD COLUMN origin_key TEXT NOT NULL DEFAULT 'local'
    CHECK(origin_key='local' OR (length(origin_key)=71 AND substr(origin_key,1,7)='remote:'
      AND substr(origin_key,8) NOT GLOB '*[^0-9a-f]*'));
DROP INDEX loom_artifact_plan_path_idx;
CREATE UNIQUE INDEX loom_artifact_plan_path_idx ON loom_artifact(plan_id,origin_key,relative_path);
DROP TRIGGER loom_artifact_no_replace;
CREATE TRIGGER loom_artifact_no_replace
    BEFORE INSERT ON loom_artifact
    WHEN EXISTS(
        SELECT 1 FROM loom_artifact
        WHERE artifact_id=NEW.artifact_id
          OR (plan_id=NEW.plan_id AND origin_key=NEW.origin_key AND relative_path=NEW.relative_path)
          OR rowid=NEW.rowid
    )
    BEGIN SELECT RAISE(ABORT, 'a recorded LOOM artifact is immutable'); END;
CREATE TABLE loom_artifact_archive (
    artifact_id TEXT PRIMARY KEY REFERENCES loom_artifact(artifact_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL REFERENCES workspace_rpc_requests(request_id),
    archive_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64
      AND request_digest NOT GLOB '*[^0-9a-f]*'),
    agent_run_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch BETWEEN 1 AND 4294967295),
    claim_id TEXT,
    fence_generation INTEGER CHECK(fence_generation IS NULL OR fence_generation>=1),
    created_at TEXT NOT NULL,
    CHECK((claim_id IS NULL)=(fence_generation IS NULL))
);
CREATE TRIGGER loom_artifact_archive_immutable
    BEFORE UPDATE ON loom_artifact_archive
    BEGIN SELECT RAISE(ABORT, 'a LOOM archive locator is immutable'); END;
CREATE TRIGGER loom_artifact_archive_no_replace
    BEFORE INSERT ON loom_artifact_archive
    WHEN EXISTS(SELECT 1 FROM loom_artifact_archive
      WHERE artifact_id=NEW.artifact_id OR rowid=NEW.rowid)
    BEGIN SELECT RAISE(ABORT, 'a LOOM archive locator is immutable'); END;
CREATE TRIGGER loom_artifact_archive_parent_scope
    BEFORE INSERT ON loom_artifact_archive
    WHEN NOT EXISTS(SELECT 1 FROM loom_artifact WHERE artifact_id=NEW.artifact_id
      AND origin_key<>'local' AND agent_run_id=NEW.agent_run_id)
    BEGIN SELECT RAISE(ABORT, 'a LOOM archive locator requires its remote producer'); END;
CREATE TRIGGER loom_artifact_archive_no_direct_delete
    BEFORE DELETE ON loom_artifact_archive
    WHEN EXISTS(SELECT 1 FROM loom_artifact WHERE artifact_id=OLD.artifact_id)
    BEGIN SELECT RAISE(ABORT, 'a LOOM archive locator is immutable'); END;
"#;

fn normalized_sql(sql: &str) -> String {
    let mut result = String::new();
    let mut quote = None;
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(end) = quote {
            result.push(ch);
            if ch == end {
                if chars.peek() == Some(&end) {
                    result.push(chars.next().unwrap());
                } else {
                    quote = None;
                }
            }
        } else if matches!(ch, '\'' | '"' | '[') || ch as u32 == 96 {
            quote = Some(if ch == '[' { ']' } else { ch });
            result.push(ch);
        } else if !ch.is_ascii_whitespace() {
            result.push(ch);
        }
    }
    result
}

fn schema_objects(
    connection: &Connection,
) -> rusqlite::Result<Vec<(String, String, String, Option<String>)>> {
    let mut stmt = connection.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master
         WHERE tbl_name IN ('loom_artifact','loom_artifact_archive') ORDER BY type,name",
    )?;
    stmt.query_map([], |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get::<_, Option<String>>(3)?
                .map(|sql| normalized_sql(&sql)),
        ))
    })?
    .collect()
}

/// The historical schema string remains owned by db_loom. Comparing the actual
/// executed SQLite contract preserves every old check, index and write guard.
pub(crate) fn schema_matches(connection: &Connection, legacy_sql: &str) -> rusqlite::Result<bool> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(legacy_sql)?;
    expected.execute_batch(ORIGIN_MIGRATION_SQL)?;
    Ok(schema_objects(connection)? == schema_objects(&expected)?)
}

pub(crate) fn migrate(connection: &Connection, legacy_sql: &str) -> Result<()> {
    anyhow::ensure!(
        !connection.is_autocommit(),
        "LOOM archive migration requires its owner transaction"
    );
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(legacy_sql)?;
    anyhow::ensure!(
        schema_objects(connection)? == schema_objects(&expected)?,
        "LOOM archive migration requires the exact historical artifact contract"
    );
    let before: i64 =
        connection.query_row("SELECT COUNT(*) FROM loom_artifact", [], |r| r.get(0))?;
    connection.execute_batch(ORIGIN_MIGRATION_SQL)?;
    let after: (i64, i64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(origin_key='local'),0) FROM loom_artifact",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    anyhow::ensure!(
        after == (before, before) && schema_matches(connection, legacy_sql)?,
        "LOOM archive migration did not preserve the historical artifacts"
    );
    Ok(())
}

fn unreadable(message: impl Into<String>) -> anyhow::Error {
    LoomCommandError::rejection(LOOM_EVIDENCE_UNREADABLE, message)
}
fn path_rejected(message: impl Into<String>) -> anyhow::Error {
    LoomCommandError::rejection(LOOM_ARTIFACT_PATH_REJECTED, message)
}
fn origin_key(target: &FrozenRunTarget) -> Result<String> {
    let identity = serde_json::to_vec(&(
        "loom.remote-artifact.origin.v1",
        &target.target.node_id,
        &target.target.workspace_id,
        target.workspace_generation,
        &target.workspace_token_digest,
    ))?;
    Ok(format!("remote:{:x}", sha2::Sha256::digest(identity)))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ClaimFence {
    claim_id: String,
    generation: i64,
}

/// Owned authority captured before the async read. It has no Deserialize and no
/// public fields; the model cannot select its origin, Run, epoch or claim.
pub(crate) struct PreparedRemoteArtifact {
    target: FrozenRunTarget,
    mission_id: String,
    plan_id: String,
    relative_path: String,
    task_id: Option<String>,
    content_type: Option<String>,
    execution_epoch: i64,
    claim: Option<ClaimFence>,
}
impl PreparedRemoteArtifact {
    pub(crate) fn workspace_id(&self) -> &str {
        &self.target.target.workspace_id
    }
    pub(crate) fn relative_path(&self) -> &str {
        &self.relative_path
    }
}

fn current_target(
    connection: &Connection,
    auth: &AuthenticatedTeamToolRun,
) -> Result<(FrozenRunTarget, String, String)> {
    let target = revalidate_run_claim(connection, &auth.agent_run_id)
        .map_err(|_| {
            LoomCommandError::rejection(
                LOOM_REMOTE_TARGET_UNAVAILABLE,
                "The frozen remote target no longer authorizes this evidence producer",
            )
        })?
        .ok_or_else(|| path_rejected("remote evidence requires the real Run's frozen target"))?;
    if target.member_id != auth.agent_id || target.camp_id != auth.camp_id {
        return Err(path_rejected(
            "remote evidence producer scope does not match",
        ));
    }
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT m.id,p.plan_id FROM agent_run r JOIN conversation c ON c.id=r.conversation_id
         JOIN mission m ON m.camp_id=c.camp_id JOIN loom_plan p ON p.mission_id=m.id
         JOIN camp_member cm ON cm.camp_id=c.camp_id AND cm.agent_id=c.agent_id
         JOIN mission_workspace w ON w.mission_id=m.id AND w.camp_id=c.camp_id
         WHERE r.id=?1 AND r.execution_epoch=?2 AND r.status IN ('running','waiting')
           AND r.cancel_requested_at IS NULL AND c.id=?3 AND c.agent_id=?4 AND c.camp_id=?5
           AND cm.status='active' AND cm.leave_requested_at IS NULL
           AND w.id=?6 AND w.execution_host_id=?7 AND w.state='ready'",
            params![
                auth.agent_run_id,
                auth.execution_epoch,
                target.conversation_id,
                auth.agent_id,
                auth.camp_id,
                target.target.workspace_id,
                target.target.node_id
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (mission, plan) =
        row.ok_or_else(|| path_rejected("remote evidence requires the active Mission producer"))?;
    Ok((target, mission, plan))
}

fn current_claim(
    connection: &Connection,
    auth: &AuthenticatedTeamToolRun,
    target: &FrozenRunTarget,
    mission_id: &str,
    plan_id: &str,
    task_id: Option<&str>,
) -> Result<Option<ClaimFence>> {
    let Some(task_id) = task_id else {
        return Ok(None);
    };
    let admission = crate::remote_execution::validate_loom_claim(
        connection,
        &auth.agent_run_id,
        mission_id,
        task_id,
        Some(&auth.agent_id),
    )
    .map_err(|_| {
        LoomCommandError::rejection(
            LOOM_REMOTE_TARGET_UNAVAILABLE,
            "The current Run, Task and frozen remote target no longer authorize this evidence",
        )
    })?
    .ok_or_else(|| path_rejected("remote evidence requires a remote Task claim"))?;
    let task_revision = admission.bound_task_revision().ok_or_else(|| {
        LoomCommandError::rejection(
            LOOM_CLAIM_ABSENT,
            "This Run must bind and claim the remote Task before registering its evidence",
        )
    })?;
    let claim: Option<(String, i64, String)> = connection
        .query_row(
            "SELECT c.claim_id,c.fence_generation,c.lease_expires_at FROM loom_claim c
         JOIN loom_claim_execution_target x ON x.claim_id=c.claim_id
         WHERE c.plan_id=?1 AND c.task_id=?2 AND c.agent_run_id=?3 AND c.released_at IS NULL
           AND x.agent_run_id=c.agent_run_id AND x.execution_epoch=?4 AND x.node_id=?5
           AND x.configuration_digest=?6 AND x.task_revision=?7",
            params![
                plan_id,
                task_id,
                auth.agent_run_id,
                auth.execution_epoch,
                target.target.node_id,
                target.target.configuration_digest,
                task_revision
            ],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (claim_id, generation, expires) = claim.ok_or_else(|| {
        LoomCommandError::rejection(
            LOOM_CLAIM_ABSENT,
            "This Run must claim the remote Task before registering its evidence",
        )
    })?;
    if lease_expired(&expires, chrono::Utc::now()) {
        return Err(LoomCommandError::rejection(
            LOOM_CLAIM_EXPIRED,
            "The remote evidence claim expired",
        ));
    }
    Ok(Some(ClaimFence {
        claim_id,
        generation,
    }))
}

pub(crate) fn prepare(
    connection: &Connection,
    auth: &AuthenticatedTeamToolRun,
    input: &serde_json::Value,
) -> Result<PreparedRemoteArtifact> {
    crate::team_tool_catalog::validate_builtin_tool_input("loom.evidence", input)
        .map_err(|_| path_rejected("remote evidence input does not match the closed schema"))?;
    let input: crate::loom_tool::LoomEvidenceToolInput = serde_json::from_value(input.clone())?;
    let relative_path = required_field("artifact register", "relativePath", &input.relative_path)?;
    let task_id = input
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let content_type = input
        .content_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let (target, mission_id, plan_id) = current_target(connection, auth)?;
    let claim = current_claim(
        connection,
        auth,
        &target,
        &mission_id,
        &plan_id,
        task_id.as_deref(),
    )?;
    Ok(PreparedRemoteArtifact {
        target,
        mission_id,
        plan_id,
        relative_path,
        task_id,
        content_type,
        execution_epoch: auth.execution_epoch,
        claim,
    })
}

fn revalidate_prepared(
    connection: &Connection,
    auth: &AuthenticatedTeamToolRun,
    prepared: &PreparedRemoteArtifact,
) -> Result<()> {
    let (target, mission, plan) = current_target(connection, auth)?;
    let claim = current_claim(
        connection,
        auth,
        &target,
        &mission,
        &plan,
        prepared.task_id.as_deref(),
    )?;
    if target != prepared.target
        || mission != prepared.mission_id
        || plan != prepared.plan_id
        || auth.execution_epoch != prepared.execution_epoch
        || claim != prepared.claim
    {
        return Err(LoomCommandError::rejection(
            LOOM_CLAIM_FENCE_STALE,
            "The evidence producer or claim changed while the archive was being read",
        ));
    }
    Ok(())
}

fn authoritative_receipt(
    connection: &Connection,
    dispatch: &WorkspaceDispatch,
    receipt: &WorkspaceArchiveReceipt,
) -> Result<()> {
    let stored = WorkspaceRpcStore::trusted_status(connection, &receipt.request_id)
        .map_err(|_| unreadable("The archive request is not retained by Core"))?;
    if stored.state != RequestState::Completed
        || stored.dispatch != *dispatch
        || !stored.archives.contains(receipt)
        || receipt.kind != WorkspaceArchiveKind::Read
        || receipt.truncated
    {
        return Err(unreadable(
            "The archive receipt is not the completed full read retained by Core",
        ));
    }
    Ok(())
}

fn dispatch_matches(prepared: &PreparedRemoteArtifact, dispatch: &WorkspaceDispatch) -> bool {
    dispatch.owner_node_id == prepared.target.target.node_id
        && dispatch.request.workspace_id == prepared.target.target.workspace_id
        && Some(dispatch.policy_revision)
            == u64::try_from(prepared.target.workspace_generation).ok()
        && dispatch.scope.session_id == prepared.target.conversation_id
        && dispatch.scope.member_id == prepared.target.member_id
        && dispatch.scope.mission_id == prepared.mission_id
        && i64::from(dispatch.scope.attempt) == prepared.execution_epoch
        && matches!(&dispatch.request.operation, WorkspaceOperation::Read { path,offset:0,.. }
            if path == &prepared.relative_path)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArchiveLocator {
    artifact_id: String,
    dispatch: WorkspaceDispatch,
    receipt: WorkspaceArchiveReceipt,
}

/// Capture only retained metadata under the database lock. The model cannot
/// provide a locator, and the later publishing transaction compares it again.
pub(crate) fn registration_snapshot(
    connection: &Connection,
    prepared: &PreparedRemoteArtifact,
) -> Result<Option<ArchiveLocator>> {
    let origin = origin_key(&prepared.target)?;
    let id: Option<String> = connection.query_row(
        "SELECT artifact_id FROM loom_artifact WHERE plan_id=?1 AND origin_key=?2 AND relative_path=?3",
        params![prepared.plan_id,origin,prepared.relative_path],|r| r.get(0),
    ).optional()?;
    id.map(|id| {
        read_archive_locator(connection, &prepared.plan_id, &id)?.ok_or_else(|| {
            unreadable("A remote artifact cannot replay a local filesystem artifact")
        })
    })
    .transpose()
}

/// A private proof built only by bounded physical reads outside Core's DB lock.
/// It is not a wire type and cannot be deserialized by a caller.
pub(crate) struct VerifiedRegistration {
    dispatch: WorkspaceDispatch,
    receipt: WorkspaceArchiveReceipt,
    sha256: String,
    size_bytes: i64,
    existing: Option<ArchiveLocator>,
}

pub(crate) fn verify_registration(
    data_dir: &Path,
    dispatch: WorkspaceDispatch,
    receipt: WorkspaceArchiveReceipt,
    existing: Option<ArchiveLocator>,
) -> Result<VerifiedRegistration> {
    let bytes = read_archived_result_bytes(data_dir, &dispatch, &receipt).map_err(|_| {
        unreadable("The private evidence archive could not be re-read and verified")
    })?;
    let sha256 = format!("{:x}", sha2::Sha256::digest(&bytes));
    let size_bytes = i64::try_from(bytes.len())?;
    if sha256 != receipt.sha256 || u64::try_from(size_bytes).ok() != Some(receipt.size_bytes) {
        return Err(unreadable(
            "The archived evidence bytes differ from the retained receipt",
        ));
    }
    if let Some(previous) = &existing {
        read_archived_result_bytes(data_dir, &previous.dispatch, &previous.receipt).map_err(
            |_| unreadable("The recorded evidence archive could not be re-read and verified"),
        )?;
    }
    Ok(VerifiedRegistration {
        dispatch,
        receipt,
        sha256,
        size_bytes,
        existing,
    })
}

/// Filesystem verification is complete before this short publishing transaction.
/// Its opaque snapshot is revalidated against the current producer and journal.
pub(crate) fn register(
    database: &mut Database,
    auth: &AuthenticatedTeamToolRun,
    prepared: PreparedRemoteArtifact,
    verified: VerifiedRegistration,
) -> Result<LoomArtifactRegisterResult> {
    let VerifiedRegistration {
        dispatch,
        receipt,
        sha256: actual_sha,
        size_bytes: actual_size,
        existing: verified_existing,
    } = verified;
    if dispatch.scope.run_id != auth.agent_run_id || !dispatch_matches(&prepared, &dispatch) {
        return Err(path_rejected(
            "The archive belongs to a different evidence producer",
        ));
    }
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    revalidate_prepared(&tx, auth, &prepared)?;
    authoritative_receipt(&tx, &dispatch, &receipt)?;
    crate::workspace_rpc_authority::revalidate_dispatch(&tx, &dispatch)
        .map_err(|_| path_rejected("The archive producer is no longer authorized"))?;
    let origin = origin_key(&prepared.target)?;
    let existing: Option<String> = tx.query_row(
        "SELECT artifact_id FROM loom_artifact WHERE plan_id=?1 AND origin_key=?2 AND relative_path=?3",
        params![prepared.plan_id,origin,prepared.relative_path],|r| r.get(0),
    ).optional()?;
    if let Some(id) = existing {
        let stored = read_stored_artifact(&tx, &id)?;
        if stored.sha256 != actual_sha || stored.size_bytes != actual_size {
            return Err(LoomCommandError::rejection(
                LOOM_ARTIFACT_CONTENT_CHANGED,
                "This origin and path already names different evidence bytes; use a new artifact path",
            ));
        }
        if stored.task_id != prepared.task_id {
            return Err(path_rejected(
                "This artifact path is already registered for a different Task",
            ));
        }
        let current_locator = read_archive_locator(&tx, &prepared.plan_id, &id)?;
        if current_locator.is_none() || current_locator != verified_existing {
            return Err(unreadable(
                "The recorded evidence changed during archive verification; retry registration",
            ));
        }
        tx.commit()?;
        return Ok(LoomArtifactRegisterResult {
            artifact: stored,
            replayed: true,
        });
    }
    if verified_existing.is_some() {
        return Err(unreadable(
            "The recorded evidence changed during archive verification; retry registration",
        ));
    }
    let artifact = LoomArtifact {
        artifact_id: format!("artifact_{}", uuid::Uuid::new_v4().simple()),
        plan_id: prepared.plan_id,
        task_id: prepared.task_id,
        agent_run_id: Some(auth.agent_run_id.clone()),
        relative_path: prepared.relative_path,
        sha256: actual_sha,
        size_bytes: actual_size,
        content_type: prepared.content_type,
        creator_id: auth.agent_id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    tx.execute(
        "INSERT INTO loom_artifact(artifact_id,plan_id,task_id,agent_run_id,relative_path,sha256,
         size_bytes,content_type,creator_id,created_at,origin_key)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            artifact.artifact_id,
            artifact.plan_id,
            artifact.task_id,
            artifact.agent_run_id,
            artifact.relative_path,
            artifact.sha256,
            artifact.size_bytes,
            artifact.content_type,
            artifact.creator_id,
            artifact.created_at,
            origin
        ],
    )?;
    tx.execute(
        "INSERT INTO loom_artifact_archive(artifact_id,request_id,archive_id,request_digest,
         agent_run_id,execution_epoch,claim_id,fence_generation,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            artifact.artifact_id,
            receipt.request_id,
            receipt.archive_id,
            dispatch.request_digest,
            auth.agent_run_id,
            auth.execution_epoch,
            prepared.claim.as_ref().map(|c| &c.claim_id),
            prepared.claim.as_ref().map(|c| c.generation),
            artifact.created_at
        ],
    )?;
    tx.commit()?;
    Ok(LoomArtifactRegisterResult {
        artifact,
        replayed: false,
    })
}

/// Returns None only for an explicitly local artifact with no remote locator.
/// This historical read does not require an old Run or claim to remain active.
fn read_archive_locator(
    connection: &Connection,
    plan_id: &str,
    artifact_id: &str,
) -> Result<Option<ArchiveLocator>> {
    let row: Option<(String, Option<String>, String, String, i64, Option<String>)> = connection
        .query_row(
            "SELECT a.origin_key,a.agent_run_id,p.mission_id,a.sha256,a.size_bytes,a.task_id
         FROM loom_artifact a JOIN loom_plan p ON p.plan_id=a.plan_id
         WHERE a.plan_id=?1 AND a.artifact_id=?2",
            params![plan_id, artifact_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;
    let (origin, producer, mission, sha, size, task_id) =
        row.ok_or_else(|| unreadable("The evidence artifact is not in this plan"))?;
    type Locator = (
        String,
        String,
        String,
        String,
        i64,
        Option<String>,
        Option<i64>,
    );
    let locator: Option<Locator> = connection.query_row(
        "SELECT request_id,archive_id,request_digest,agent_run_id,execution_epoch,claim_id,fence_generation
         FROM loom_artifact_archive WHERE artifact_id=?1",[artifact_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
    ).optional()?;
    if origin == "local" {
        if locator.is_some() {
            return Err(unreadable(
                "Local evidence cannot carry a remote archive locator",
            ));
        }
        return Ok(None);
    }
    let (request_id, archive_id, digest, run_id, epoch, claim_id, fence) =
        locator.ok_or_else(|| unreadable("The remote evidence archive locator is missing"))?;
    let target = load_run_target(connection, &run_id)?
        .ok_or_else(|| unreadable("The remote producer target is missing"))?;
    if origin != origin_key(&target)? || producer.as_deref() != Some(run_id.as_str()) {
        return Err(unreadable(
            "The remote evidence origin does not match its immutable producer",
        ));
    }
    let status = WorkspaceRpcStore::trusted_status(connection, &request_id)
        .map_err(|_| unreadable("The archived request is missing"))?;
    let receipt = status
        .archives
        .iter()
        .find(|r| r.archive_id == archive_id)
        .ok_or_else(|| unreadable("The archive receipt is not retained"))?;
    let dispatch = &status.dispatch;
    if dispatch.request_digest != digest
        || dispatch.scope.run_id != run_id
        || i64::from(dispatch.scope.attempt) != epoch
        || dispatch.scope.member_id != target.member_id
        || dispatch.scope.session_id != target.conversation_id
        || dispatch.scope.mission_id != mission
        || dispatch.owner_node_id != target.target.node_id
        || dispatch.request.workspace_id != target.target.workspace_id
        || Some(dispatch.policy_revision) != u64::try_from(target.workspace_generation).ok()
        || receipt.sha256 != sha
        || i64::try_from(receipt.size_bytes).ok() != Some(size)
    {
        return Err(unreadable(
            "The evidence locator and retained request scope do not match",
        ));
    }
    authoritative_receipt(connection, dispatch, receipt)?;
    let artifact = read_stored_artifact(connection, artifact_id)?;
    if artifact.creator_id != target.member_id
        || !matches!(&dispatch.request.operation,WorkspaceOperation::Read {path,offset:0,..}
            if path == &artifact.relative_path)
    {
        return Err(unreadable(
            "The archived path or creator differs from the artifact",
        ));
    }
    match (task_id.as_deref(), claim_id.as_deref(), fence) {
        (None, None, None) => {}
        (Some(task), Some(claim), Some(generation)) => {
            let historical: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM loom_claim c JOIN loom_claim_execution_target x ON x.claim_id=c.claim_id
                 WHERE c.claim_id=?1 AND c.plan_id=?2 AND c.task_id=?3 AND c.agent_run_id=?4
                   AND c.fence_generation=?5 AND x.agent_run_id=c.agent_run_id
                   AND x.execution_epoch=?6 AND x.node_id=?7 AND x.configuration_digest=?8)",
                params![claim,plan_id,task,run_id,generation,epoch,target.target.node_id,
                    target.target.configuration_digest], |r| r.get(0),
            )?;
            if !historical {
                return Err(unreadable(
                    "The archived Task claim does not match its producer",
                ));
            }
        }
        _ => return Err(unreadable("The archived Task claim is incomplete")),
    }
    Ok(Some(ArchiveLocator {
        artifact_id: artifact_id.into(),
        dispatch: dispatch.clone(),
        receipt: receipt.clone(),
    }))
}

/// The historical verifier owns its existing database transaction. Registration
/// instead uses registration_snapshot + verify_registration before publication.
pub(crate) fn read_verified_bytes(
    connection: &Connection,
    data_dir: &Path,
    plan_id: &str,
    artifact_id: &str,
) -> Result<Option<Vec<u8>>> {
    let Some(locator) = read_archive_locator(connection, plan_id, artifact_id)? else {
        return Ok(None);
    };
    let bytes = read_archived_result_bytes(data_dir, &locator.dispatch, &locator.receipt)
        .map_err(|_| unreadable("The private archive bytes could not be verified"))?;
    Ok(Some(bytes))
}

#[cfg(test)]
fn register_from_receipt(
    database: &mut Database,
    data_dir: &Path,
    auth: &AuthenticatedTeamToolRun,
    prepared: PreparedRemoteArtifact,
    dispatch: WorkspaceDispatch,
    receipt: WorkspaceArchiveReceipt,
) -> Result<LoomArtifactRegisterResult> {
    let existing = registration_snapshot(database.connection(), &prepared)?;
    let verified = verify_registration(data_dir, dispatch, receipt, existing)?;
    register(database, auth, prepared, verified)
}

/// Extends the existing real Delivery/claim owner; it does not create a Run or
/// grant from wire input. Transport events here are isolated deterministic fixtures.
#[cfg(test)]
pub(crate) fn test_archive_contract_on(
    database: &mut Database,
    data_dir: &Path,
    auth: &AuthenticatedTeamToolRun,
) {
    use crate::workspace_rpc::{Admission, archive_completed_results};
    use crate::workspace_rpc_authority::resolve_workspace_authority;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use loom_protocol::workspace_rpc::{
        RPC_VERSION, WorkspaceEvent, WorkspaceEventBody, WorkspaceRequest, WorkspaceResult,
    };

    fn completed_read(
        database: &mut Database,
        data_dir: &Path,
        auth: &AuthenticatedTeamToolRun,
        workspace: &str,
        relative_path: &str,
        bytes: &[u8],
    ) -> (WorkspaceDispatch, WorkspaceArchiveReceipt) {
        let (principal, grant) =
            resolve_workspace_authority(database.connection(), auth, workspace, Some(7)).unwrap();
        let request_id = format!(
            "wrpc_{:x}",
            sha2::Sha256::digest(format!("{}:{relative_path}", uuid::Uuid::new_v4()).as_bytes())
        );
        let request = WorkspaceRequest {
            version: RPC_VERSION,
            request_id,
            workspace_id: workspace.into(),
            timeout_ms: 10_000,
            operation: WorkspaceOperation::Read {
                path: relative_path.into(),
                offset: 0,
                max_bytes: 1_048_576,
            },
        };
        let Admission::Dispatch(dispatch) =
            WorkspaceRpcStore::admit(database.connection_mut(), &principal, &grant, request, 100)
                .unwrap()
        else {
            panic!("new owner request must dispatch")
        };
        WorkspaceRpcStore::mark_dispatched(
            database.connection_mut(),
            &dispatch.request.request_id,
            7,
            101,
        )
        .unwrap();
        for (seq, body) in [
            (1, WorkspaceEventBody::Accepted),
            (
                2,
                WorkspaceEventBody::Completed {
                    result: WorkspaceResult::Read {
                        data: STANDARD.encode(bytes),
                        offset: 0,
                        truncated: false,
                    },
                },
            ),
        ] {
            let event = WorkspaceEvent {
                version: RPC_VERSION,
                request_id: dispatch.request.request_id.clone(),
                run_id: dispatch.scope.run_id.clone(),
                attempt: dispatch.scope.attempt,
                owner_node_id: dispatch.owner_node_id.clone(),
                request_digest: dispatch.request_digest.clone(),
                seq,
                body,
            };
            WorkspaceRpcStore::append_event(
                database.connection_mut(),
                &grant.owner_node_id,
                7,
                &event,
                102 + seq,
            )
            .unwrap();
        }
        let snapshot = WorkspaceRpcStore::archive_snapshot(
            database.connection_mut(),
            &principal,
            &dispatch.request.request_id,
        )
        .unwrap();
        let verified =
            archive_completed_results(data_dir, &snapshot.status.dispatch, &snapshot.events)
                .unwrap();
        WorkspaceRpcStore::publish_archives(
            database.connection_mut(),
            &principal,
            &dispatch.request.request_id,
            &snapshot.status.archives,
            &verified,
            106,
        )
        .unwrap();
        let receipt = verified.receipts()[0].clone();
        assert_eq!(
            read_archived_result_bytes(data_dir, &dispatch, &receipt).unwrap(),
            bytes
        );
        (dispatch, receipt)
    }

    let input = serde_json::json!({"relativePath":"out/report.md","taskId":"r1-task","contentType":"text/plain"});
    let mut forged_input = input.clone();
    forged_input["originKey"] = serde_json::json!("local");
    assert!(
        prepare(database.connection(), auth, &forged_input).is_err(),
        "the caller cannot select an archive origin"
    );
    let prepared = prepare(database.connection(), auth, &input).unwrap();
    let workspace = prepared.workspace_id().to_owned();
    let plan = prepared.plan_id.clone();
    let bytes = b"remote archive actual bytes";
    let (dispatch, receipt) =
        completed_read(database, data_dir, auth, &workspace, "out/report.md", bytes);

    // A typed receipt still has to be the exact completed receipt retained by Core.
    let mut forged = receipt.clone();
    forged.sha256 = "0".repeat(64);
    assert!(
        register_from_receipt(database, data_dir, auth, prepared, dispatch.clone(), forged)
            .is_err()
    );
    assert_eq!(
        database
            .connection()
            .query_row("SELECT COUNT(*) FROM loom_artifact", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let mut old_epoch = auth.clone();
    old_epoch.execution_epoch += 1;
    assert!(prepare(database.connection(), &old_epoch, &input).is_err());
    let mut cross = dispatch.clone();
    cross.scope.run_id = "another-run".into();
    let prepared = prepare(database.connection(), auth, &input).unwrap();
    assert!(
        register_from_receipt(database, data_dir, auth, prepared, cross, receipt.clone()).is_err()
    );

    let stale_prepared = prepare(database.connection(), auth, &input).unwrap();
    let stale_existing = registration_snapshot(database.connection(), &stale_prepared).unwrap();
    assert!(stale_existing.is_none());
    let stale_verified =
        verify_registration(data_dir, dispatch.clone(), receipt.clone(), stale_existing).unwrap();
    let prepared = prepare(database.connection(), auth, &input).unwrap();
    let result = register_from_receipt(
        database,
        data_dir,
        auth,
        prepared,
        dispatch.clone(),
        receipt.clone(),
    )
    .unwrap();
    assert!(!result.replayed);
    assert!(
        register(database, auth, stale_prepared, stale_verified).is_err(),
        "a racing artifact needs its own verified existing locator before replay"
    );
    assert_eq!(result.artifact.sha256, receipt.sha256);
    assert_eq!(result.artifact.size_bytes, bytes.len() as i64);
    assert_eq!(
        read_verified_bytes(
            database.connection(),
            data_dir,
            &plan,
            &result.artifact.artifact_id
        )
        .unwrap()
        .as_deref(),
        Some(bytes.as_slice())
    );
    let prepared = prepare(database.connection(), auth, &input).unwrap();
    let replay = register_from_receipt(
        database,
        data_dir,
        auth,
        prepared,
        dispatch.clone(),
        receipt.clone(),
    )
    .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.artifact.artifact_id, result.artifact.artifact_id);
    let no_task = serde_json::json!({"relativePath":"out/report.md"});
    let no_task = prepare(database.connection(), auth, &no_task).unwrap();
    assert!(
        register_from_receipt(
            database,
            data_dir,
            auth,
            no_task,
            dispatch.clone(),
            receipt.clone()
        )
        .is_err(),
        "Task-bound replay must cite and prove the same Task"
    );

    let artifact_id = &result.artifact.artifact_id;
    for sql in [
        "UPDATE loom_artifact SET origin_key='local' WHERE artifact_id=?1",
        "UPDATE loom_artifact_archive SET request_digest=printf('%064d',0) WHERE artifact_id=?1",
        "DELETE FROM loom_artifact_archive WHERE artifact_id=?1",
        "INSERT OR REPLACE INTO loom_artifact_archive SELECT * FROM loom_artifact_archive WHERE artifact_id=?1",
    ] {
        assert!(
            database.connection().execute(sql, [artifact_id]).is_err(),
            "{sql}"
        );
    }

    // Database uniqueness is scoped by host origin; authority is still checked
    // when reading a locator, so a forged origin is never treated as a receipt.
    database
        .connection()
        .execute_batch("SAVEPOINT artifact_origins;")
        .unwrap();
    let copy = |new_id: &str, origin: &str| {
        database.connection().execute(
            "INSERT INTO loom_artifact(artifact_id,plan_id,task_id,agent_run_id,relative_path,
          sha256,size_bytes,content_type,creator_id,created_at,origin_key)
         SELECT ?1,plan_id,task_id,agent_run_id,relative_path,sha256,size_bytes,content_type,
          creator_id,created_at,?2 FROM loom_artifact WHERE artifact_id=?3",
            params![new_id, origin, artifact_id],
        )
    };
    let other_origin = format!("remote:{}", "a".repeat(64));
    copy("fixture-other-origin", &other_origin).unwrap();
    copy("fixture-local-origin", "local").unwrap();
    assert!(copy("fixture-repeat-origin", &other_origin).is_err());
    assert!(copy("fixture-repeat-local", "local").is_err());
    assert_eq!(database.connection().query_row(
        "SELECT COUNT(*) FROM loom_artifact WHERE plan_id=?1 AND relative_path='out/report.md'",
        [&plan],|r|r.get::<_,i64>(0)).unwrap(),3);
    database
        .connection()
        .execute(
            "INSERT INTO loom_artifact_archive(artifact_id,request_id,archive_id,request_digest,
          agent_run_id,execution_epoch,claim_id,fence_generation,created_at)
         SELECT 'fixture-other-origin',request_id,archive_id,request_digest,agent_run_id,
          execution_epoch,claim_id,fence_generation,created_at
         FROM loom_artifact_archive WHERE artifact_id=?1",
            [artifact_id],
        )
        .unwrap();
    assert!(
        read_verified_bytes(
            database.connection(),
            data_dir,
            &plan,
            "fixture-other-origin"
        )
        .is_err()
    );
    assert_eq!(
        read_verified_bytes(
            database.connection(),
            data_dir,
            &plan,
            "fixture-local-origin"
        )
        .unwrap(),
        None
    );
    database
        .connection()
        .execute_batch("ROLLBACK TO artifact_origins; RELEASE artifact_origins;")
        .unwrap();

    // Archive+artifact publication is atomic even when the locator insert fails.
    let rollback_input = serde_json::json!({"relativePath":"out/rollback.md","taskId":"r1-task"});
    let rollback_prepared = prepare(database.connection(), auth, &rollback_input).unwrap();
    let (rollback_dispatch, rollback_receipt) = completed_read(
        database,
        data_dir,
        auth,
        &workspace,
        "out/rollback.md",
        b"rollback bytes",
    );
    database.connection().execute_batch(
        "CREATE TEMP TRIGGER fixture_archive_locator_failure BEFORE INSERT ON loom_artifact_archive
         BEGIN SELECT RAISE(ABORT,'fixture locator publication failure'); END;",
    ).unwrap();
    assert!(
        register_from_receipt(
            database,
            data_dir,
            auth,
            rollback_prepared,
            rollback_dispatch,
            rollback_receipt
        )
        .is_err()
    );
    assert_eq!(
        database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM loom_artifact WHERE relative_path='out/rollback.md'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    database
        .connection()
        .execute_batch("DROP TRIGGER fixture_archive_locator_failure;")
        .unwrap();

    // Historical verification uses the archive even after the producing Run ends.
    database
        .connection()
        .execute_batch("SAVEPOINT artifact_after_completion;")
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE agent_run SET status='succeeded',ended_at=?2 WHERE id=?1",
            params![&auth.agent_run_id, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    assert!(prepare(database.connection(), auth, &input).is_err());
    assert_eq!(
        read_verified_bytes(database.connection(), data_dir, &plan, artifact_id)
            .unwrap()
            .as_deref(),
        Some(bytes.as_slice())
    );
    database
        .connection()
        .execute_batch("ROLLBACK TO artifact_after_completion; RELEASE artifact_after_completion;")
        .unwrap();
    let restored_run: (String, Option<String>) = database
        .connection()
        .query_row(
            "SELECT status,ended_at FROM agent_run WHERE id=?1",
            [&auth.agent_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(restored_run, ("running".into(), None));

    // No A workspace fallback can rescue corrupt private archive bytes.
    let archive_path = data_dir
        .join("workspace-rpc-archives")
        .join("v1")
        .join(format!("{}.bin", receipt.archive_id));
    std::fs::write(&archive_path, b"corrupt fixture").unwrap();
    assert!(read_verified_bytes(database.connection(), data_dir, &plan, artifact_id).is_err());
    std::fs::write(&archive_path, bytes).unwrap();
    assert_eq!(
        read_verified_bytes(database.connection(), data_dir, &plan, artifact_id)
            .unwrap()
            .as_deref(),
        Some(bytes.as_slice())
    );
    let (claim_id,fence_generation):(String,i64)=database.connection().query_row(
        "SELECT claim_id,fence_generation FROM loom_claim WHERE agent_run_id=?1 AND task_id='r1-task' AND released_at IS NULL",
        [&auth.agent_run_id],|r|Ok((r.get(0)?,r.get(1)?)),
    ).unwrap();
    let candidate = candidate_record(
        database,
        LoomCandidateRecordInput {
            mission_id: "delivery-queue-mission".into(),
            task_id: "r1-task".into(),
            agent_run_id: auth.agent_run_id.clone(),
            claim_id,
            fence_generation,
            command_id: "archive-candidate-fixture".into(),
            content_hash: receipt.sha256.clone(),
            evidence_ids: vec![artifact_id.clone()],
            acceptance_criteria_version: "1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    review_record(
        database,
        LoomReviewRecordInput {
            mission_id: "delivery-queue-mission".into(),
            task_id: "r1-task".into(),
            candidate_id: candidate.candidate_id.clone(),
            command_id: "archive-review-fixture".into(),
            acceptance_criteria_version: "1".into(),
            verdict: LoomReviewVerdict::Accepted,
            reason: "verify the actual archived bytes".into(),
            reviewer_id: "local_user".into(),
            criteria_results: vec![LoomAcceptanceCriterionResult {
                criterion_id: "c".into(),
                satisfied: true,
                evidence_ids: vec![artifact_id.clone()],
                note: None,
            }],
        },
    )
    .unwrap();
    let verification = LoomVerificationRecordInput {
        mission_id: "delivery-queue-mission".into(),
        task_id: "r1-task".into(),
        candidate_id: candidate.candidate_id,
        command_id: "archive-verification-fixture".into(),
        method: "reopen the Core archive and hash its bytes".into(),
        executor_id: "local_user".into(),
        result: LoomVerificationResult::Passed,
        evidence_ids: vec![artifact_id.clone()],
    };
    let legacy = verification_record(database, verification.clone()).unwrap_err();
    assert_eq!(
        legacy.downcast_ref::<LoomCommandError>().unwrap().code(),
        LOOM_EVIDENCE_UNREADABLE,
        "an entry point without Core archive authority must never fall back to a Node path"
    );
    let verified = verification_record_with_archives(database, data_dir, verification).unwrap();
    assert_eq!(verified.verification.result, LoomVerificationResult::Passed);
    assert_eq!(
        verified.verification.evidence_ids,
        vec![artifact_id.clone()]
    );
}
