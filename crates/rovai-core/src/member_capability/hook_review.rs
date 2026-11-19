//! Exact member consent is separate from inherited selection and generic risk acknowledgement.
use super::{CatalogPiece, MemberCapabilityError, ProjectedCapability};
use crate::command::canonical_json_digest;
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const SCHEMA_SQL: &str = r#"
CREATE TABLE member_hook_review (
    agent_id TEXT NOT NULL REFERENCES agent_profile(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES member_capability_item(item_id) ON DELETE CASCADE,
    scope_digest TEXT NOT NULL CHECK(length(scope_digest)=71 AND substr(scope_digest,1,7)='sha256:' AND substr(scope_digest,8) NOT GLOB '*[^0-9a-f]*'),
    definition_digest TEXT NOT NULL CHECK(length(definition_digest)=71 AND substr(definition_digest,1,7)='sha256:' AND substr(definition_digest,8) NOT GLOB '*[^0-9a-f]*'),
    reviewed_revision TEXT NOT NULL CHECK(length(reviewed_revision)=64 AND reviewed_revision NOT GLOB '*[^0-9a-f]*'),
    reviewed_at TEXT NOT NULL CHECK(length(reviewed_at) BETWEEN 1 AND 80),
    PRIMARY KEY (agent_id,item_id,scope_digest)
);
"#;

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let actual: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='member_hook_review'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let compact = |sql: &str| {
        sql.chars()
            .filter(|c| !c.is_whitespace() && *c != ';')
            .collect::<String>()
    };
    Ok(actual.is_some_and(|sql| compact(&sql) == compact(SCHEMA_SQL)))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHookReviewScope {
    pub member_id: String,
    pub mission_id: String,
    pub camp_id: String,
    pub workspace_id: String,
    pub node_id: String,
    pub workspace_root: String,
    pub workspace_generation: i64,
    pub workspace_token_digest: String,
    pub adapter_kind: crate::agent_profile::AdapterKind,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum HookReviewScope {
    Remote(RemoteHookReviewScope),
    Local(crate::local_hook::LocalHookScope),
}
impl HookReviewScope {
    pub(super) fn digest(&self) -> Result<String> {
        Ok(format!(
            "sha256:{}",
            canonical_json_digest(&serde_json::to_value(self)?)?
        ))
    }
    pub(super) fn is_local(&self) -> bool {
        matches!(self, Self::Local(_))
    }
    fn matches_target(&self, target: &crate::remote_execution::FrozenRunTarget) -> bool {
        matches!(self,Self::Remote(scope) if scope.matches_target(target))
    }
}
impl RemoteHookReviewScope {
    fn matches_target(&self, target: &crate::remote_execution::FrozenRunTarget) -> bool {
        self.member_id == target.member_id
            && self.workspace_id == target.selection.workspace_id
            && self.workspace_id == target.target.workspace_id
            && self.node_id == target.selection.node_id
            && self.node_id == target.target.node_id
            && self.workspace_root == target.selection.workspace_root
            && self.workspace_generation == target.workspace_generation
            && self.workspace_token_digest == target.workspace_token_digest
            && self.adapter_kind == target.selection.adapter_kind
    }
}

/// A project label or a path supplied by the caller is never approval authority.
/// Local selection has no remote consent scope and keeps its existing behavior.
pub(super) fn current_scope(
    connection: &Connection,
    member_id: &str,
) -> Result<Option<HookReviewScope>> {
    let Some(selection) =
        crate::remote_execution::load_member_target(connection, member_id)?.selection
    else {
        return Ok(None);
    };
    let authority =
        crate::remote_execution::workspace_authority(connection, member_id, &selection)?;
    Ok(Some(HookReviewScope::Remote(RemoteHookReviewScope {
        member_id: member_id.to_owned(),
        mission_id: authority.mission_id,
        camp_id: authority.camp_id,
        workspace_id: selection.workspace_id,
        node_id: selection.node_id,
        workspace_root: selection.workspace_root,
        workspace_generation: authority.generation,
        workspace_token_digest: authority.preparation_token_digest,
        adapter_kind: selection.adapter_kind,
    })))
}

/// Local Camp is only a selector for Core authority; no caller-supplied path.
pub(super) fn current_scope_for_camp(
    connection: &Connection,
    member_id: &str,
    local_camp_id: Option<&str>,
) -> Result<Option<HookReviewScope>> {
    if let Some(remote) = current_scope(connection, member_id)? {
        return Ok(Some(remote));
    }
    let Some(camp_id) = local_camp_id else {
        return Ok(None);
    };
    let adapter: Option<String> = connection.query_row(
        "SELECT selected_runtime_adapter_kind FROM agent_profile WHERE id=?1",
        [member_id],
        |r| r.get(0),
    )?;
    if adapter.as_deref() != Some("deepseek-harness") {
        return Ok(None);
    }
    match crate::local_hook::current_scope(connection, member_id, camp_id) {
        Ok(scope) => Ok(Some(HookReviewScope::Local(scope))),
        // A missing/changed local workspace disables Hook review without hiding
        // the rest of this member's catalog. SQL failures remain visible.
        Err(error) if error.downcast_ref::<rusqlite::Error>().is_none() => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Clone, Debug)]
pub(super) struct StoredReview {
    pub scope_digest: String,
    pub definition_digest: String,
    pub reviewed_revision: String,
    pub reviewed_at: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HookReviewApproval {
    pub id: String,
    pub definition_digest: String,
    pub scope_digest: String,
}
impl std::fmt::Debug for HookReviewApproval {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookReviewApproval")
            .field("id", &self.id)
            .field("definition_digest", &self.definition_digest)
            .field("scope_digest", &self.scope_digest)
            .finish()
    }
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookDefinitionView {
    pub body: String,
    pub definition_digest: String,
    pub reviewed: bool,
    pub review_scope: HookReviewScope,
    pub scope_digest: String,
}
impl std::fmt::Debug for HookDefinitionView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookDefinitionView")
            .field("definition_digest", &self.definition_digest)
            .field("reviewed", &self.reviewed)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenHookReview {
    version: u32,
    id: String,
    name: String,
    note: String,
    source: String,
    scope: String,
    tool_names: Vec<String>,
    risk: Option<String>,
    definition_digest: String,
    body_digest: String,
    review_scope: HookReviewScope,
    scope_digest: String,
    reviewed_revision: String,
    reviewed_at: String,
}
impl std::fmt::Debug for FrozenHookReview {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrozenHookReview")
            .field("id", &self.id)
            .field("definition_digest", &self.definition_digest)
            .finish_non_exhaustive()
    }
}

fn definition_value(piece: &CatalogPiece) -> Value {
    json!({
        "schemaVersion":1, "id":piece.id, "name":piece.name, "note":piece.note,
        "source":piece.source, "scope":piece.scope, "toolNames":piece.tool_names,
        "risk":piece.risk, "body":piece.body,
    })
}
pub(super) fn definition_digest(piece: &CatalogPiece) -> Result<String> {
    Ok(format!(
        "sha256:{}",
        canonical_json_digest(&definition_value(piece))?
    ))
}
pub(super) fn matches(piece: &CatalogPiece) -> Result<bool> {
    let Some(review) = &piece.hook_review else {
        return Ok(false);
    };
    let Some(scope) = &piece.hook_scope else {
        return Ok(false);
    };
    Ok(piece.kind == "hook"
        && review.definition_digest == definition_digest(piece)?
        && review.scope_digest == scope.digest()?)
}
pub(super) fn view(piece: &CatalogPiece) -> Result<Option<HookDefinitionView>> {
    if piece.kind != "hook" {
        return Ok(None);
    }
    let Some(scope) = &piece.hook_scope else {
        return Ok(None);
    };
    Ok(Some(HookDefinitionView {
        body: piece.body.clone(),
        definition_digest: definition_digest(piece)?,
        reviewed: matches(piece)?,
        review_scope: scope.clone(),
        scope_digest: scope.digest()?,
    }))
}
pub(super) fn load(
    connection: &Connection,
    agent_id: &str,
    scope: Option<&HookReviewScope>,
) -> Result<BTreeMap<String, StoredReview>> {
    let Some(scope) = scope else {
        return Ok(BTreeMap::new());
    };
    let mut statement = connection.prepare(
        "SELECT item_id,definition_digest,reviewed_revision,reviewed_at,scope_digest
         FROM member_hook_review WHERE agent_id=?1 AND scope_digest=?2 ORDER BY item_id",
    )?;
    let rows = statement.query_map(params![agent_id, scope.digest()?], |row| {
        Ok((
            row.get(0)?,
            StoredReview {
                definition_digest: row.get(1)?,
                reviewed_revision: row.get(2)?,
                reviewed_at: row.get(3)?,
                scope_digest: row.get(4)?,
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Called before external Skill/MCP writes. The Core DB mutex owns this entire setter.
pub(super) fn validate_request(
    next: &[CatalogPiece],
    approvals: &[HookReviewApproval],
) -> Result<BTreeSet<String>> {
    let mut ids = BTreeSet::new();
    for approval in approvals {
        let Some(piece) = next.iter().find(|p| {
            p.kind == "hook" && p.id == approval.id && p.selected && p.hook_scope.is_some()
        }) else {
            return Err(review_error("capability.hook_review_invalid", &approval.id));
        };
        if !ids.insert(approval.id.clone())
            || approval.definition_digest != definition_digest(piece)?
            || approval.scope_digest != piece.hook_scope.as_ref().expect("scoped hook").digest()?
        {
            return Err(review_error(
                "capability.hook_review_conflict",
                &approval.id,
            ));
        }
    }
    for piece in next
        .iter()
        .filter(|p| p.kind == "hook" && p.selected && p.hook_scope.is_some())
    {
        if !matches(piece)? && !ids.contains(&piece.id) {
            return Err(review_error("capability.hook_review_required", &piece.id));
        }
    }
    Ok(ids)
}

/// The SQL writer rechecks exact definitions and current review state under its transaction.
pub(super) fn revalidate_before_write(
    connection: &Connection,
    agent_id: &str,
    next: &[CatalogPiece],
    approvals: &[HookReviewApproval],
    local_camp_id: Option<&str>,
) -> Result<()> {
    ensure!(
        !connection.is_autocommit(),
        "hook_review_transaction_required"
    );
    if !next.iter().any(|p| p.kind == "hook") {
        return Ok(());
    }
    let scope = current_scope_for_camp(connection, agent_id, local_camp_id)?;
    let reviews = load(connection, agent_id, scope.as_ref())?;
    let claims = super::load_claims(connection)?;
    let mut fresh = Vec::new();
    for piece in next.iter().filter(|p| p.kind == "hook") {
        let row = connection.query_row(
            "SELECT kind,name,note,source_label,scope,body FROM member_capability_item WHERE item_id=?1",
            [&piece.id], |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            )),
        ).optional()?.ok_or_else(|| review_error("capability.hook_review_conflict", &piece.id))?;
        let mut current = piece.clone();
        current.kind = row.0;
        current.name = row.1;
        current.note = row.2;
        current.source = row.3;
        current.scope = row.4;
        current.body = row.5;
        current.tool_names = claims
            .get(&("hook".to_owned(), piece.id.clone()))
            .cloned()
            .unwrap_or_default();
        current.hook_review = reviews.get(&piece.id).cloned();
        current.hook_scope = scope.clone();
        if current.hook_scope != piece.hook_scope {
            return Err(review_error(
                "capability.hook_review_scope_changed",
                &piece.id,
            ));
        }
        if current.kind != "hook" || definition_digest(&current)? != definition_digest(piece)? {
            return Err(review_error("capability.hook_review_conflict", &piece.id));
        }
        fresh.push(current);
    }
    validate_request(&fresh, approvals)?;
    Ok(())
}

pub(super) fn persist(
    connection: &Connection,
    agent_id: &str,
    next: &[CatalogPiece],
    approvals: &BTreeSet<String>,
    revision: &str,
    now: &str,
) -> Result<()> {
    ensure!(
        !connection.is_autocommit(),
        "hook_review_transaction_required"
    );
    for piece in next.iter().filter(|p| p.kind == "hook") {
        // Selection only controls inclusion in the next Run. Exact scoped
        // consent remains stored; definition/scope drift still makes it unusable.
        if !piece.selected {
            continue;
        }
        let Some(scope) = &piece.hook_scope else {
            continue;
        };
        if approvals.contains(&piece.id) && !matches(piece)? {
            connection.execute(
                "INSERT INTO member_hook_review(agent_id,item_id,definition_digest,reviewed_revision,reviewed_at,scope_digest)
                 VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(agent_id,item_id,scope_digest) DO UPDATE SET
                 definition_digest=excluded.definition_digest,
                 reviewed_revision=excluded.reviewed_revision,reviewed_at=excluded.reviewed_at",
                params![agent_id, piece.id, definition_digest(piece)?, revision, now, scope.digest()?],
            )?;
        }
    }
    Ok(())
}

pub(super) fn freeze(pieces: &[CatalogPiece]) -> Result<Vec<FrozenHookReview>> {
    let mut result = Vec::new();
    for piece in pieces.iter().filter(|p| p.kind == "hook" && p.selected) {
        if !matches(piece)? {
            return Err(review_error("capability.hook_review_required", &piece.id));
        }
        let review = piece.hook_review.as_ref().expect("matching review");
        result.push(FrozenHookReview {
            version: 1,
            id: piece.id.clone(),
            name: piece.name.clone(),
            note: piece.note.clone(),
            source: piece.source.clone(),
            scope: piece.scope.clone(),
            tool_names: piece.tool_names.clone(),
            risk: piece.risk.clone(),
            definition_digest: review.definition_digest.clone(),
            body_digest: loom_protocol::command_hooks::digest(piece.body.as_bytes()),
            review_scope: piece
                .hook_scope
                .as_ref()
                .expect("matching scoped review")
                .clone(),
            scope_digest: review.scope_digest.clone(),
            reviewed_revision: review.reviewed_revision.clone(),
            reviewed_at: review.reviewed_at.clone(),
        });
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

/// Only immutable stored Run evidence is consulted here; no current catalog lookup.
pub(crate) fn validate_frozen(
    reviews: &[FrozenHookReview],
    hooks: &[ProjectedCapability],
) -> Result<()> {
    ensure!(reviews.len() == hooks.len(), "bundle_hook_review_required");
    let mut ids = BTreeSet::new();
    for review in reviews {
        ensure!(
            review.version == 1
                && ids.insert(&review.id)
                && review.review_scope.digest()? == review.scope_digest,
            "bundle_hook_review_invalid"
        );
        let hook = hooks
            .iter()
            .find(|h| h.id == review.id)
            .ok_or_else(|| anyhow::anyhow!("bundle_hook_review_invalid"))?;
        ensure!(
            hook.name == review.name
                && !review.reviewed_at.is_empty()
                && review.reviewed_revision.len() == 64
                && review
                    .reviewed_revision
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "bundle_hook_review_invalid"
        );
        let frozen = CatalogPiece {
            id: hook.id.clone(),
            kind: "hook".to_owned(),
            name: hook.name.clone(),
            note: review.note.clone(),
            source: review.source.clone(),
            scope: review.scope.clone(),
            body: hook.body.clone(),
            tool_names: review.tool_names.clone(),
            risk: review.risk.clone(),
            selected: true,
            stored_origin: None,
            hook_review: None,
            hook_scope: Some(review.review_scope.clone()),
        };
        ensure!(
            definition_digest(&frozen)? == review.definition_digest
                && loom_protocol::command_hooks::digest(hook.body.as_bytes()) == review.body_digest,
            "bundle_hook_review_mismatch"
        );
    }
    Ok(())
}
pub(crate) fn validate_frozen_scope(
    reviews: &[FrozenHookReview],
    target: &crate::remote_execution::FrozenRunTarget,
) -> Result<()> {
    for review in reviews {
        ensure!(
            review.review_scope.digest()? == review.scope_digest
                && review.review_scope.matches_target(target),
            "bundle_hook_review_scope"
        );
    }
    Ok(())
}

pub(crate) fn validate_frozen_local_scope(
    reviews: &[FrozenHookReview],
    scope: &crate::local_hook::LocalHookScope,
) -> Result<()> {
    for review in reviews {
        ensure!(
            review.review_scope == HookReviewScope::Local(scope.clone())
                && review.scope_digest == review.review_scope.digest()?,
            "local_hook_review_scope_mismatch"
        );
    }
    Ok(())
}

pub(crate) fn frozen_review_digest(reviews: &[FrozenHookReview]) -> Result<String> {
    Ok(format!(
        "sha256:{}",
        canonical_json_digest(&serde_json::to_value(reviews)?)?
    ))
}
fn review_error(code: &'static str, id: &str) -> anyhow::Error {
    MemberCapabilityError::with_details(
        code,
        "命令 hook 需要审核这份完整定义后再保存。",
        json!({"kind":"hook","id":id}),
    )
}

#[cfg(test)]
pub(crate) fn test_remote_scope(
    database: &mut crate::db::Database,
    member: &str,
    directory: &std::path::Path,
) -> RemoteHookReviewScope {
    let command = serde_json::from_value::<crate::mission::CreateMissionCommand>(json!({
        "title":"Hook scope fixture", "description":"", "projectPath":directory,
        "projectBindingKind":"directory", "memberAgentIds":[member],
        "defaultLeadAgentId":member, "tags":[],
    }))
    .unwrap();
    let created = crate::mission::MissionService::default()
        .create(database, &super::user_envelope(command))
        .unwrap();
    let mission = created.result.payload["missionId"].as_str().unwrap();
    let camp: String = database
        .connection()
        .query_row("SELECT camp_id FROM mission WHERE id=?1", [mission], |r| {
            r.get(0)
        })
        .unwrap();
    let node = format!("hook-node-{}", uuid::Uuid::new_v4().simple());
    let workspace = format!("hook-workspace-{}", uuid::Uuid::new_v4().simple());
    let root = format!("B:/fixture/{workspace}");
    database
        .connection()
        .execute(
            "INSERT INTO execution_node(node_id,display_name,role,os,arch,token_digest,paired_at)
         VALUES(?1,?1,'remote','windows','x86_64',lower(hex(randomblob(32))),datetime('now'))",
            [&node],
        )
        .unwrap();
    database.connection().execute(
        "INSERT INTO mission_workspace(id,mission_id,camp_id,execution_host_id,source_directory,
            repository_root,git_common_dir,worktree_path,working_directory,branch,base_sha,
            preparation_token,generation,state,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?5,?5,?5,?5,?1,'fixture-sha','fixture-preparation',1,'ready',datetime('now'),datetime('now'))",
        params![workspace,mission,camp,node,root],
    ).unwrap();
    let selection = json!({
        "nodeId":node,"workspaceId":workspace,"workspaceRoot":root,"adapterKind":"codex-cli",
        "model":{"mode":"runtime_default"},
        "permissions":{"adapterKind":"codex-cli","schemaVersion":1,"values":{}},
    });
    database.connection().execute(
        "INSERT INTO member_execution_target(member_id,revision,node_id,selection_json,updated_at)
         VALUES(?1,1,?2,?3,datetime('now'))
         ON CONFLICT(member_id) DO UPDATE SET revision=revision+1,node_id=excluded.node_id,
             selection_json=excluded.selection_json,updated_at=excluded.updated_at",
        params![member,node,selection.to_string()],
    ).unwrap();
    let HookReviewScope::Remote(scope) = current_scope(database.connection(), member)
        .unwrap()
        .unwrap()
    else {
        panic!("remote fixture scope");
    };
    scope
}
