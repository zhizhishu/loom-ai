//! Explicit local command Hooks. Only Core authority and immutable Run snapshots grant execution.
//! This does not register native Skills or change a user's global Runtime configuration.
use crate::{
    agent_profile::{AdapterKind, FrozenAgentRuntimeConfig},
    command::canonical_json_digest,
    member_capability::{FrozenHookReview, ProjectedCapability},
    runtime::AgentRunWorkspace,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) const SCHEMA_SQL: &str = r#"
CREATE TABLE agent_run_local_hook (
    agent_run_id TEXT PRIMARY KEY REFERENCES agent_run(id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
    snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest)=64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL
);
CREATE TABLE agent_run_local_hook_event (
    agent_run_id TEXT NOT NULL REFERENCES agent_run_local_hook(agent_run_id) ON DELETE CASCADE,
    execution_epoch INTEGER NOT NULL CHECK(execution_epoch>=0),
    native_session_id TEXT NOT NULL,
    native_turn INTEGER NOT NULL CHECK(native_turn>=0),
    sequence INTEGER NOT NULL CHECK(sequence>=0),
    hook_id TEXT NOT NULL,
    handler_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK(event_kind IN ('invoked','result')),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
    created_at TEXT NOT NULL,
    PRIMARY KEY(agent_run_id,execution_epoch,native_session_id,sequence)
);
"#;

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let compact = |sql: &str| {
        sql.chars()
            .filter(|c| !c.is_whitespace() && *c != ';')
            .collect::<String>()
    };
    for expected in SCHEMA_SQL
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let name = expected
            .split_whitespace()
            .nth(2)
            .expect("static table name");
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .optional()?;
        if !actual.is_some_and(|sql| compact(&sql) == compact(expected)) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum LocalWorkspaceAuthority {
    Camp {
        #[serde(rename = "campId")]
        camp_id: String,
    },
    Mission {
        #[serde(rename = "missionId")]
        mission_id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "workspaceGeneration")]
        workspace_generation: i64,
        #[serde(rename = "workspaceTokenDigest")]
        workspace_token_digest: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalHookScope {
    pub scope_kind: LocalScopeKind,
    pub member_id: String,
    pub camp_id: String,
    pub execution_host_id: String,
    pub workspace_root: String,
    pub workspace_authority: LocalWorkspaceAuthority,
    pub adapter_kind: AdapterKind,
    pub permissions_digest: String,
    pub permissions: crate::agent_profile::AdapterPermissionConfig,
}
// AdapterPermissionConfig contains only an enum, integer and serde_json::Value,
// whose equality is reflexive; its upstream public derive currently omits Eq.
impl Eq for LocalHookScope {}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LocalScopeKind {
    Local,
}

fn canonical_root(value: &str) -> Result<String> {
    let path = std::path::Path::new(value);
    ensure!(
        path.is_absolute() && path.is_dir(),
        "local_hook_workspace_unavailable"
    );
    let canonical = crate::runtime_discovery::runtime_visible_path(path.canonicalize()?);
    Ok(canonical.to_string_lossy().into_owned())
}
fn permission_digest(value: &Value) -> Result<String> {
    Ok(format!("sha256:{}", canonical_json_digest(value)?))
}

/// The caller supplies only a real Camp identity. Paths, Host identity, workspace
/// generation and permission bytes come from existing Core authority.
pub(crate) fn current_scope(
    connection: &Connection,
    member_id: &str,
    camp_id: &str,
) -> Result<LocalHookScope> {
    ensure!(
        !camp_id.trim().is_empty() && camp_id.len() <= 128,
        "local_hook_camp_required"
    );
    ensure!(
        crate::remote_execution::load_member_target(connection, member_id)?
            .selection
            .is_none(),
        "local_hook_remote_target_selected"
    );
    let (project_path, host_id): (String, String) = connection
        .query_row(
            "SELECT c.project_path,h.id FROM camp c
         JOIN camp_member m ON m.camp_id=c.id AND m.agent_id=?2
         JOIN mission_execution_host h ON h.singleton=1
         WHERE c.id=?1 AND m.status='active' AND m.leave_requested_at IS NULL",
            params![camp_id, member_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .context("local_hook_camp_membership_required")?;
    let (adapter, permissions): (Option<String>, Option<String>) = connection.query_row(
        "SELECT selected_runtime_adapter_kind,default_permission_config_json
         FROM agent_profile WHERE id=?1 AND removed_at IS NULL",
        [member_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    ensure!(
        adapter.as_deref() == Some("deepseek-harness"),
        "local_hook_runtime_unsupported"
    );
    let permissions: Value =
        serde_json::from_str(&permissions.context("local_hook_permissions_required")?)?;
    ensure!(
        permissions["adapterKind"] == "deepseek-harness" && permissions["schemaVersion"] == 1,
        "local_hook_permissions_invalid"
    );
    ensure!(
        matches!(
            permissions["values"]["sandbox_mode"].as_str(),
            Some("read-only" | "workspace-write")
        ),
        "local_hook_sandbox_required"
    );
    ensure!(
        matches!(
            permissions["values"]["approval_policy"].as_str(),
            Some("ask" | "never")
        ),
        "local_hook_permissions_invalid"
    );
    let mission: Option<String> = connection
        .query_row("SELECT id FROM mission WHERE camp_id=?1", [camp_id], |r| {
            r.get(0)
        })
        .optional()?;
    let (root, workspace_authority) =
        if let Some(mission_id) = mission {
            let (id,root,generation,token): (String,String,i64,String) = connection.query_row(
            "SELECT id,working_directory,generation,preparation_token FROM mission_workspace
             WHERE mission_id=?1 AND camp_id=?2 AND execution_host_id=?3 AND state='ready'
             ORDER BY created_at,id LIMIT 1",
            params![mission_id,camp_id,host_id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional()?.context("local_hook_workspace_not_ready")?;
            (
                root,
                LocalWorkspaceAuthority::Mission {
                    mission_id,
                    workspace_id: id,
                    workspace_generation: generation,
                    workspace_token_digest: loom_protocol::command_hooks::digest(token.as_bytes()),
                },
            )
        } else {
            (
                project_path,
                LocalWorkspaceAuthority::Camp {
                    camp_id: camp_id.to_owned(),
                },
            )
        };
    Ok(LocalHookScope {
        scope_kind: LocalScopeKind::Local,
        member_id: member_id.to_owned(),
        camp_id: camp_id.to_owned(),
        execution_host_id: host_id,
        workspace_root: canonical_root(&root)?,
        workspace_authority,
        adapter_kind: AdapterKind::DeepseekHarness,
        permissions_digest: permission_digest(&permissions)?,
        permissions: serde_json::from_value(permissions)?,
    })
}

/// The first local contract is one synchronous PostToolUse command. Unknown or
/// silently-skipped native fields are errors, never a successful empty Hook.
pub(crate) fn settings(hooks: &[ProjectedCapability]) -> Result<Value> {
    ensure!(hooks.len() == 1, "local_hook_exactly_one_required");
    let value: Value = serde_json::from_str(&hooks[0].body).context("local_hook_settings_json")?;
    let commands =
        loom_protocol::command_hooks::parse(&value, true).map_err(|code| anyhow::anyhow!(code))?;
    ensure!(
        commands.len() == 1 && commands[0].event == "PostToolUse",
        "local_hook_event_unsupported"
    );
    let hook = &commands[0];
    let seconds = hook
        .timeout
        .as_ref()
        .and_then(|n| n.as_f64())
        .context("local_hook_timeout_required")?;
    ensure!(
        seconds > 0.0 && seconds <= 5.0,
        "local_hook_timeout_exceeded"
    );
    // Native matchers are regexes. Keep the first contract exact and bounded:
    // one native tool name; no wildcard, backtracking or unreviewed expansion.
    let matcher = hook
        .matcher
        .as_deref()
        .context("local_hook_matcher_required")?;
    ensure!(
        !matcher.is_empty()
            && matcher.len() <= 128
            && matcher
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')),
        "local_hook_matcher_invalid"
    );
    let command = hook.effective_command(cfg!(windows));
    // The public body stays the reviewed Codex dialect; native config selects
    // only the platform's reviewed command and makes exact matching explicit.
    Ok(
        json!({"hooks":{"PostToolUse":[{"matcher":format!("^{matcher}$"),
        "hooks":[{"type":"command","command":command,"timeout":seconds}]}]}}),
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenLocalHooks {
    pub version: u32,
    pub agent_run_id: String,
    pub scope: LocalHookScope,
    pub hooks: Vec<ProjectedCapability>,
    pub reviews: Vec<FrozenHookReview>,
}
impl FrozenLocalHooks {
    pub(crate) fn digest(&self) -> Result<String> {
        canonical_json_digest(&serde_json::to_value(self)?)
    }
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1 && !self.agent_run_id.is_empty(),
            "local_hook_snapshot_invalid"
        );
        crate::member_capability::validate_frozen_hook_reviews(&self.reviews, &self.hooks)?;
        crate::member_capability::validate_frozen_local_hook_scope(&self.reviews, &self.scope)?;
        settings(&self.hooks)?;
        Ok(())
    }
}

pub(crate) fn capture(
    connection: &Connection,
    run_id: &str,
    camp_id: &str,
    member_id: &str,
    workspace: &AgentRunWorkspace,
    runtime: &FrozenAgentRuntimeConfig,
) -> Result<Option<FrozenLocalHooks>> {
    ensure!(
        !connection.is_autocommit(),
        "local_hook_transaction_required"
    );
    let selected: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM member_capability_choice c
         JOIN member_capability_item i ON i.item_id=c.item_key AND i.kind='hook'
         WHERE c.agent_id=?1 AND c.kind='hook' AND c.selected=1)",
        [member_id],
        |r| r.get(0),
    )?;
    if !selected {
        return Ok(None);
    }
    let scope = current_scope(connection, member_id, camp_id)?;
    ensure!(
        runtime.adapter_kind == scope.adapter_kind
            && canonical_root(&workspace.execution_root)? == scope.workspace_root
            && permission_digest(&serde_json::to_value(&runtime.permissions)?)?
                == scope.permissions_digest,
        "local_hook_scope_changed"
    );
    let (hooks, reviews) =
        crate::member_capability::freeze_local_hooks(connection, member_id, &scope)?;
    let frozen = FrozenLocalHooks {
        version: 1,
        agent_run_id: run_id.to_owned(),
        scope,
        hooks,
        reviews,
    };
    frozen.validate()?;
    Ok(Some(frozen))
}
pub(crate) fn persist(connection: &Connection, frozen: &FrozenLocalHooks, now: &str) -> Result<()> {
    ensure!(
        !connection.is_autocommit(),
        "local_hook_transaction_required"
    );
    frozen.validate()?;
    connection.execute(
        "INSERT INTO agent_run_local_hook(agent_run_id,snapshot_json,snapshot_digest,created_at)
        VALUES(?1,?2,?3,?4)",
        params![
            frozen.agent_run_id,
            serde_json::to_string(frozen)?,
            frozen.digest()?,
            now
        ],
    )?;
    Ok(())
}
/// No current selection/definition lookup: queued Runs keep their reviewed bytes.
pub(crate) fn load(connection: &Connection, run_id: &str) -> Result<Option<FrozenLocalHooks>> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT snapshot_json,snapshot_digest FROM agent_run_local_hook WHERE agent_run_id=?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((body, digest)) = row else {
        return Ok(None);
    };
    let frozen: FrozenLocalHooks = serde_json::from_str(&body)?;
    ensure!(
        frozen.agent_run_id == run_id && frozen.digest()? == digest,
        "local_hook_snapshot_mismatch"
    );
    frozen.validate()?;
    Ok(Some(frozen))
}
pub(crate) fn revalidate_launch(
    connection: &Connection,
    frozen: &FrozenLocalHooks,
    workspace: &AgentRunWorkspace,
    runtime: &FrozenAgentRuntimeConfig,
) -> Result<()> {
    frozen.validate()?;
    ensure!(
        current_scope(connection, &frozen.scope.member_id, &frozen.scope.camp_id)? == frozen.scope
            && canonical_root(&workspace.execution_root)? == frozen.scope.workspace_root
            && permission_digest(&serde_json::to_value(&runtime.permissions)?)?
                == frozen.scope.permissions_digest,
        "local_hook_scope_changed"
    );
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalHookLaunch {
    pub schema_version: u32,
    pub agent_run_id: String,
    pub execution_epoch: i64,
    pub snapshot_digest: String,
    pub hook_id: String,
    pub workspace_root: String,
    pub sandbox_mode: String,
    pub model: String,
    pub settings: Value,
}
pub(crate) fn prepare_launch(
    connection: &Connection,
    run_id: &str,
    epoch: i64,
    workspace: &AgentRunWorkspace,
    runtime: &FrozenAgentRuntimeConfig,
) -> Result<Option<LocalHookLaunch>> {
    let Some(frozen) = load(connection, run_id)? else {
        return Ok(None);
    };
    revalidate_launch(connection, &frozen, workspace, runtime)?;
    ensure!(epoch >= 0, "local_hook_epoch_invalid");
    Ok(Some(LocalHookLaunch {
        schema_version: 1,
        agent_run_id: run_id.to_owned(),
        execution_epoch: epoch,
        snapshot_digest: frozen.digest()?,
        hook_id: frozen.hooks[0].id.clone(),
        workspace_root: frozen.scope.workspace_root,
        sandbox_mode: runtime.permissions.values["sandbox_mode"]
            .as_str()
            .context("local_hook_sandbox_required")?
            .to_owned(),
        model: runtime.model.model_id.clone(),
        settings: settings(&frozen.hooks)?,
    }))
}
pub(crate) fn compatibility(
    digest: Option<String>,
    launch: Option<&LocalHookLaunch>,
) -> Result<Option<String>> {
    let Some(launch) = launch else {
        return Ok(digest);
    };
    Ok(Some(canonical_json_digest(
        &json!({"runtime":digest.context("local_hook_host_digest_missing")?,
        "localHook":launch.snapshot_digest,"runId":launch.agent_run_id,"executionEpoch":launch.execution_epoch}),
    )?))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HookObservation {
    pub schema_version: u32,
    pub agent_run_id: String,
    pub execution_epoch: i64,
    pub snapshot_digest: String,
    pub hook_id: String,
    pub session_id: String,
    pub seq: i64,
    pub turn: i64,
    pub handler_id: String,
    pub point: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_enforcement: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_denied: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aborted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}
pub(crate) fn record_observations(
    connection: &Connection,
    run_id: &str,
    epoch: i64,
    session_id: &str,
    items: &Value,
) -> Result<()> {
    let values = items.as_array().context("local_hook_events_invalid")?;
    ensure!(values.len() <= 256, "local_hook_events_budget");
    if values.is_empty() {
        return Ok(());
    }
    let frozen = load(connection, run_id)?.context("local_hook_unselected_event")?;
    let current: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run r JOIN conversation c ON c.id=r.conversation_id
        WHERE r.id=?1 AND r.execution_epoch=?2 AND r.status IN ('running','waiting')
        AND r.runtime_adapter_kind='deepseek-harness' AND c.native_session_id=?3)",
        params![run_id, epoch, session_id],
        |r| r.get(0),
    )?;
    ensure!(current, "local_hook_stale_event");
    let tx = connection.unchecked_transaction()?;
    for value in values {
        let event: HookObservation = serde_json::from_value(value.clone())?;
        ensure!(
            event.schema_version == 1
                && event.agent_run_id == run_id
                && event.execution_epoch == epoch
                && event.session_id == session_id
                && event.snapshot_digest == frozen.digest()?
                && event.hook_id == frozen.hooks[0].id
                && event.point == "PostToolUse"
                && event.seq >= 0
                && event.turn >= 0
                && !event.handler_id.is_empty()
                && event.handler_id.len() <= 160
                && matches!(event.kind.as_str(), "invoked" | "result"),
            "local_hook_event_scope_mismatch"
        );
        ensure!(
            event
                .duration_ms
                .is_none_or(|ms| ms.is_finite() && ms >= 0.0 && ms <= 60000.0)
                && event.decision.as_ref().is_none_or(|s| matches!(
                    s.as_str(),
                    "pass" | "approve" | "allow" | "block" | "deny" | "ask" | "stop"
                ))
                && event
                    .sandbox_enforcement
                    .as_ref()
                    .is_none_or(|s| matches!(s.as_str(), "full" | "partial"))
                && event
                    .stderr_digest
                    .as_ref()
                    .is_none_or(|s| loom_protocol::command_hooks::valid_digest(s)),
            "local_hook_event_payload_invalid"
        );
        let canonical = serde_json::to_string(&event)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM agent_run_local_hook_event
            WHERE agent_run_id=?1 AND execution_epoch=?2 AND native_session_id=?3 AND sequence=?4",
                params![run_id, epoch, session_id, event.seq],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            ensure!(prior == canonical, "local_hook_event_replay_mismatch");
            continue;
        }
        if event.kind == "result" {
            let (invoked, completed): (i64, i64) = tx.query_row(
                "SELECT COUNT(CASE WHEN event_kind='invoked' AND sequence<?7 THEN 1 END),
                    COUNT(CASE WHEN event_kind='result' THEN 1 END)
                 FROM agent_run_local_hook_event WHERE agent_run_id=?1 AND execution_epoch=?2
                 AND native_session_id=?3 AND native_turn=?4 AND handler_id=?5 AND hook_id=?6",
                params![
                    run_id,
                    epoch,
                    session_id,
                    event.turn,
                    event.handler_id,
                    event.hook_id,
                    event.seq
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            ensure!(
                invoked == 1 && completed == 0,
                "local_hook_result_without_unpaired_invocation"
            );
            ensure!(
                event.decision.is_some() && event.duration_ms.is_some(),
                "local_hook_result_incomplete"
            );
        } else {
            let used: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_run_local_hook_event
                 WHERE agent_run_id=?1 AND execution_epoch=?2 AND native_session_id=?3
                 AND native_turn=?4 AND handler_id=?5 AND hook_id=?6)",
                params![
                    run_id,
                    epoch,
                    session_id,
                    event.turn,
                    event.handler_id,
                    event.hook_id
                ],
                |r| r.get(0),
            )?;
            ensure!(!used, "local_hook_invocation_reused");
            ensure!(
                event.exit_code.is_none()
                    && event.decision.is_none()
                    && event.duration_ms.is_none()
                    && event.sandbox_enforcement.is_none()
                    && event.stderr_digest.is_none()
                    && event.sandbox_denied.is_none()
                    && event.aborted.is_none()
                    && event.timed_out.is_none(),
                "local_hook_invocation_payload_invalid"
            );
        }
        tx.execute("INSERT INTO agent_run_local_hook_event(agent_run_id,execution_epoch,native_session_id,native_turn,
            sequence,hook_id,handler_id,event_kind,payload_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,datetime('now'))",
            params![run_id,epoch,session_id,event.turn,event.seq,event.hook_id,event.handler_id,event.kind,canonical])?;
    }
    tx.commit()?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HookRunParams {
    pub agent_run_id: String,
}
pub(crate) fn run_view(connection: &Connection, run_id: &str) -> Result<Value> {
    let frozen = load(connection, run_id)?;
    let (epoch, session): (i64, Option<String>) = connection.query_row(
        "SELECT r.execution_epoch,c.native_session_id FROM agent_run r
         LEFT JOIN conversation c ON c.id=r.conversation_id WHERE r.id=?1",
        [run_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // A retried Run must not inherit successful evidence from its earlier
    // execution epoch or a replaced native Session.
    let mut statement = connection.prepare(
        "SELECT payload_json FROM agent_run_local_hook_event
        WHERE agent_run_id=?1 AND execution_epoch=?2 AND native_session_id=?3 ORDER BY sequence",
    )?;
    let rows = statement.query_map(params![run_id, epoch, session], |r| r.get::<_, String>(0))?;
    let events = rows
        .map(|r| Ok(serde_json::from_str::<HookObservation>(&r?)?))
        .collect::<Result<Vec<_>>>()?;
    let results: Vec<_> = events.iter().filter(|e| e.kind == "result").collect();
    let status = if frozen.is_none() {
        "not_selected"
    } else if results.iter().any(|e| {
        e.exit_code != Some(0)
            || e.sandbox_enforcement.is_none()
            || e.sandbox_denied != Some(false)
            || e.aborted != Some(false)
            || e.timed_out != Some(false)
            || !matches!(e.decision.as_deref(), Some("pass" | "approve" | "allow"))
    }) {
        "failed"
    } else if !results.is_empty()
        && events.iter().filter(|e| e.kind == "invoked").count() == results.len()
    {
        "observed"
    } else {
        "not_observed"
    };
    Ok(
        json!({"agentRunId":run_id,"executionEpoch":epoch,"nativeSessionId":session,"status":status,"snapshotDigest":frozen.as_ref().map(FrozenLocalHooks::digest).transpose()?,
        "scope":frozen.as_ref().map(|f|&f.scope),
        "hooks":frozen.as_ref().map(|f|f.hooks.iter().map(|h|json!({"id":h.id,"name":h.name})).collect::<Vec<_>>()).unwrap_or_default(),
        "events":events}),
    )
}

// Reused by the existing exact-review owner. The frozen selection comes from
// real Core review/scope construction; only the native Run transport is seeded.
#[cfg(test)]
pub(crate) fn assert_receipt_pairing_and_run_fence(frozen: &FrozenLocalHooks) {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
        CREATE TABLE conversation(id TEXT PRIMARY KEY,native_session_id TEXT);
        CREATE TABLE agent_run(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversation(id),
            execution_epoch INTEGER,status TEXT,runtime_adapter_kind TEXT);
        INSERT INTO conversation VALUES('conversation','native-one');",
    )
    .unwrap();
    db.execute(
        "INSERT INTO agent_run VALUES(?1,'conversation',0,'running','deepseek-harness')",
        [&frozen.agent_run_id],
    )
    .unwrap();
    db.execute("INSERT INTO agent_run VALUES('unselected-run','conversation',0,'running','deepseek-harness')", []).unwrap();
    db.execute_batch(SCHEMA_SQL).unwrap();
    let tx = db.unchecked_transaction().unwrap();
    persist(&tx, frozen, "fixture").unwrap();
    tx.commit().unwrap();
    let run = &frozen.agent_run_id;
    let event = |kind: &str, seq: i64, handler: &str| {
        let mut value = json!({"schemaVersion":1,"agentRunId":run,"executionEpoch":0,
            "snapshotDigest":frozen.digest().unwrap(),"hookId":frozen.hooks[0].id,
            "sessionId":"native-one","seq":seq,"turn":1,"handlerId":handler,
            "point":"PostToolUse","kind":kind});
        if kind == "result" {
            value["exitCode"] = json!(0);
            value["decision"] = json!("pass");
            value["durationMs"] = json!(1);
            value["sandboxEnforcement"] = json!("partial");
            value["sandboxDenied"] = json!(false);
            value["aborted"] = json!(false);
            value["timedOut"] = json!(false);
        }
        value
    };
    let good = json!([event("invoked", 1, "a"), event("result", 2, "a")]);
    record_observations(&db, run, 0, "native-one", &good).unwrap();
    record_observations(&db, run, 0, "native-one", &good).unwrap();
    assert_eq!(run_view(&db, run).unwrap()["status"], "observed");
    let before = db.total_changes();
    // Two results cannot spend the same invocation and then borrow a later
    // unrelated invocation merely to make the total event counts match.
    assert!(
        record_observations(
            &db,
            run,
            0,
            "native-one",
            &json!([event("result", 3, "a"), event("invoked", 4, "b")])
        )
        .is_err()
    );
    assert_eq!(db.total_changes(), before);
    assert_eq!(
        run_view(&db, run).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        record_observations(
            &db,
            run,
            0,
            "native-one",
            &json!([event("invoked", 3, "a")])
        )
        .is_err()
    );
    let mut changed = good.clone();
    changed[1]["decision"] = json!("block");
    assert!(record_observations(&db, run, 0, "native-one", &changed).is_err());
    assert!(record_observations(&db, "unselected-run", 0, "native-one", &good).is_err());
    assert_eq!(
        run_view(&db, "unselected-run").unwrap()["status"],
        "not_selected"
    );
    assert!(record_observations(&db, run, 0, "native-other", &good).is_err());
    db.execute("UPDATE agent_run SET execution_epoch=1 WHERE id=?1", [run])
        .unwrap();
    assert_eq!(run_view(&db, run).unwrap()["status"], "not_observed");
    assert!(record_observations(&db, run, 0, "native-one", &good).is_err());
    let mut current = good.clone();
    for row in current.as_array_mut().unwrap() {
        row["executionEpoch"] = json!(1);
    }
    record_observations(&db, run, 1, "native-one", &current).unwrap();
    assert_eq!(run_view(&db, run).unwrap()["status"], "observed");
    db.execute(
        "UPDATE conversation SET native_session_id='native-two' WHERE id='conversation'",
        [],
    )
    .unwrap();
    assert_eq!(run_view(&db, run).unwrap()["status"], "not_observed");
    assert!(record_observations(&db, run, 1, "native-one", &current).is_err());
}
