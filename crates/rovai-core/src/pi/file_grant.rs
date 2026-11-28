// LOOM V2 — production Pi file-access grant (typed, per-Run, Core-owned).
//
// Why this module exists:
// - `FrozenAgentRuntimeConfig.permissions` is the only frozen place a member's Pi file policy can be
//   expressed (`AdapterPermissionConfig.values`, agent_profile.rs:450-454). Pi had no permission
//   vocabulary at all (`pi_permission_options()` returned an empty vec), so Pi Runs inherited Pi's
//   native tools with no workspace boundary.
// - This module is the *typed* side of that policy: it turns the frozen `loom_file_access` value into
//   an explicit grant bound to one AgentRun (run/bot/epoch), the canonical cwd Core already chose, and
//   a bounded expiry. It does NOT implement a second path-safety algorithm: every path decision stays
//   in the shared guard (`scripts/loom-v2-runtime-file-guard.ts`, embedded by `pi.rs`), which is the
//   single source of truth for absolute/`..`/UNC/ADS/symlink/junction/hardlink/sensitive-file rules.
//
// Modes:
// - `native` (default / absent): unchanged legacy behaviour. No guard is loaded, no `--tools`
//   allowlist is applied. This is honest: Pi keeps its native tool permissions with NO workspace
//   boundary, and the UI descriptor says exactly that.
// - `workspace_read_only`: conservative, explicitly chosen. The grant allows only the native `read`
//   tool, inside the canonical cwd, and the guard refuses `bash`/`write`/`edit`/every undeclared
//   extension tool (including MCP). Nothing is migrated or enabled implicitly.
// - `workspace_read_write`: the same boundary, widened to Pi's three native file tools
//   `read`/`write`/`edit`. `bash` and every extension/MCP tool stay outside the grant; the tool set is
//   derived here from the frozen mode, never from the caller.
// - `workspace_workflow`: the same three native file tools plus exactly one managed Core business
//   tool (`rovai_loom`) that reaches only the managed operation set Core already ships. The
//   additional tool can never be composed by a caller: the name and the operation set live here (Rust)
//   and in the shared guard / managed Host extension (TypeScript), and a Run without this frozen mode
//   neither loads nor may call it. `bash`, arbitrary CLI, MCP and every other tool stay outside.
//
// Claim binding (P0 step 2): a write authorisation is issued for the exact LOOM claim the Run holds.
// The grant therefore always carries the three claim fields — `claimId`, `fenceGeneration` and
// `leaseExpiresAtEpochMs` — filled from `loom::live_claim_for_run` when the Run is bound to a LOOM
// Task, and left empty (`""`/`0`/`0`) when it is not. An unbound Run (ordinary chat, non-dispatch
// work) keeps exactly today's behaviour; a claim that already lapsed is never presented as live.
// This module only CARRIES that identity: the guard-side refusal of an unclaimable write is a
// separate decision and is not taken here.
//
// Claim requirement (P0 step 3): carrying a claim is not the same as needing one. `requiresClaim`
// states whether this Run must present a LIVE claim before every `write`/`edit`, and it is decided by
// the Run's LOOM *binding*, not by the claim row: in the r9 shape the Run starts first and claims
// seconds later, so the grant Core issues at launch has `requiresClaim:true` and an empty triple and
// the shared guard refuses every write until the claim exists. An ordinary chat Run carries
// `requiresClaim:false` and keeps the unchanged pre-P0 behaviour. A non-empty triple always implies
// the requirement (the flag is derived as an OR), so no caller can switch the gate off while
// presenting a claim.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::loom::LiveClaim;

/// Permission key inside `AdapterPermissionConfig.values`.
pub(crate) const PI_FILE_ACCESS_KEY: &str = "loom_file_access";
pub(crate) const PI_FILE_ACCESS_NATIVE: &str = "native";
pub(crate) const PI_FILE_ACCESS_WORKSPACE_READ_ONLY: &str = "workspace_read_only";
pub(crate) const PI_FILE_ACCESS_WORKSPACE_READ_WRITE: &str = "workspace_read_write";
pub(crate) const PI_FILE_ACCESS_WORKSPACE_WORKFLOW: &str = "workspace_workflow";

/// The one managed Core business tool the workflow policy adds. It is a Core-owned, typed bridge to
/// the managed operation set — never `bash`, never an arbitrary command, never MCP.
pub(crate) const PI_LOOM_TOOL_NAME: &str = "rovai_loom";

/// Must match `RUNTIME_GUARD_SCHEMA` in scripts/loom-v2-runtime-execution.mjs.
pub(crate) const PI_FILE_GRANT_SCHEMA: &str = "loom.runtime.file-guard.v1";
/// The only tool the read-only policy ever grants. `bash`/`write`/`edit` and every extension/MCP tool
/// stay outside the grant by construction.
pub(crate) const PI_FILE_GRANT_READ_ONLY_TOOLS: [&str; 1] = ["read"];
/// The exact tool set of the read-write policy: Pi's three native file tools, in a fixed order. `bash`
/// and every extension/MCP tool stay outside the grant by construction — this is not a tool framework,
/// it is the same closed list the shared guard already validates.
pub(crate) const PI_FILE_GRANT_READ_WRITE_TOOLS: [&str; 3] = ["read", "write", "edit"];
/// The exact tool set of the workflow policy: the same three native file tools plus the one managed
/// Core business tool, in a fixed order. Nothing else is representable — the caller can never widen it.
pub(crate) const PI_FILE_GRANT_WORKFLOW_TOOLS: [&str; 4] =
    ["read", "write", "edit", PI_LOOM_TOOL_NAME];
/// `native` gets no grant at all, so it never has a tool list.
pub(crate) const PI_FILE_GRANT_NO_TOOLS: [&str; 0] = [];
/// A grant is scoped to one Run; twelve hours is far beyond any accepted Run and still bounded.
pub(crate) const PI_FILE_GRANT_TTL_MS: i64 = 12 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PiFileAccessMode {
    Native,
    WorkspaceReadOnly,
    WorkspaceReadWrite,
    WorkspaceWorkflow,
}

impl PiFileAccessMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Native => PI_FILE_ACCESS_NATIVE,
            Self::WorkspaceReadOnly => PI_FILE_ACCESS_WORKSPACE_READ_ONLY,
            Self::WorkspaceReadWrite => PI_FILE_ACCESS_WORKSPACE_READ_WRITE,
            Self::WorkspaceWorkflow => PI_FILE_ACCESS_WORKSPACE_WORKFLOW,
        }
    }

    pub(crate) fn guarded(self) -> bool {
        !matches!(self, Self::Native)
    }

    /// The exact tool set this frozen mode grants. `native` grants nothing here because it gets no grant
    /// at all; the caller can never widen or narrow this list.
    pub(crate) fn granted_tools(self) -> &'static [&'static str] {
        match self {
            Self::Native => &PI_FILE_GRANT_NO_TOOLS,
            Self::WorkspaceReadOnly => &PI_FILE_GRANT_READ_ONLY_TOOLS,
            Self::WorkspaceReadWrite => &PI_FILE_GRANT_READ_WRITE_TOOLS,
            Self::WorkspaceWorkflow => &PI_FILE_GRANT_WORKFLOW_TOOLS,
        }
    }
}

/// Read the frozen permission policy. Absent → `Native` (legacy behaviour, never migrated).
///
/// Strictness: the `loom_file_access` value is either a mode string or an object with exactly one
/// `mode` key. Any unknown key or unknown mode is an error — a typo must never silently fall back to
/// the unguarded legacy behaviour.
pub(crate) fn mode_from_permissions(values: &Value) -> Result<PiFileAccessMode> {
    let Some(raw) = values.get(PI_FILE_ACCESS_KEY) else {
        return Ok(PiFileAccessMode::Native);
    };
    let mode = match raw {
        Value::String(mode) => mode.as_str(),
        Value::Object(map) => {
            if let Some(unknown) = map.keys().find(|key| key.as_str() != "mode") {
                bail!("Pi permission {PI_FILE_ACCESS_KEY} has an unknown key: {unknown}");
            }
            match map.get("mode") {
                Some(Value::String(mode)) => mode.as_str(),
                Some(_) => bail!("Pi permission {PI_FILE_ACCESS_KEY}.mode must be a string"),
                None => bail!("Pi permission {PI_FILE_ACCESS_KEY}.mode is missing"),
            }
        }
        _ => bail!("Pi permission {PI_FILE_ACCESS_KEY} must be a mode string or an object"),
    };
    match mode {
        PI_FILE_ACCESS_NATIVE => Ok(PiFileAccessMode::Native),
        PI_FILE_ACCESS_WORKSPACE_READ_ONLY => Ok(PiFileAccessMode::WorkspaceReadOnly),
        PI_FILE_ACCESS_WORKSPACE_READ_WRITE => Ok(PiFileAccessMode::WorkspaceReadWrite),
        PI_FILE_ACCESS_WORKSPACE_WORKFLOW => Ok(PiFileAccessMode::WorkspaceWorkflow),
        other => bail!("Pi permission {PI_FILE_ACCESS_KEY} has an unsupported mode: {other}"),
    }
}

/// The Core-owned grant document written next to `binding.json` in the private Host root.
///
/// Keys are camelCase and match the guard's `loadGrant()` validation exactly; a mismatch there makes
/// the guard refuse every tool call, which is the intended fail-closed direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PiFileGrant {
    pub schema: String,
    pub run_id: String,
    pub bot_id: String,
    pub execution_epoch: i64,
    pub workspace_real: String,
    pub allowed_tools: Vec<String>,
    pub expires_at_epoch_ms: i64,
    pub log_path: String,
    /// The LOOM claim this Run held when the grant was issued. Empty for a Run that is not bound to
    /// a LOOM Task; never a placeholder for a claim somebody else must have taken.
    pub claim_id: String,
    /// The fence generation of `claim_id`. `0` exactly when `claim_id` is empty.
    pub fence_generation: i64,
    /// The claim lease expiry in epoch milliseconds. `0` exactly when `claim_id` is empty.
    pub lease_expires_at_epoch_ms: i64,
    /// Whether this Run must present a live claim before every `write`/`edit`.
    ///
    /// `true` for a Run bound to a LOOM Task, including the window between the Run starting and its
    /// `loom.claim` (the claim triple above is still empty there); `false` for ordinary chat, which
    /// keeps exactly today's behaviour. `false` with a non-empty triple is not representable: a claim
    /// always implies the requirement.
    pub requires_claim: bool,
}

impl PiFileGrant {
    /// Build the grant for one Run. `Ok(None)` means the member chose the legacy native policy.
    ///
    /// `workspace` is the canonical execution root Core already selected for this AgentRun; a model,
    /// prompt or environment value can never supply it.
    /// `claim` is the live claim `loom::live_claim_for_run` reported for exactly this Run, or `None`
    /// when the Run holds none. It is read by the caller that owns the database connection: this
    /// module never opens one, so the grant can never disagree with the claim it was built from.
    /// `requires_claim` is that same read's LOOM-binding answer (`loom::loom_binding_for_run`): it is
    /// `true` before the claim exists, which is what makes a pre-claim write impossible instead of
    /// merely unlikely. A claim handed in without the flag still yields `requires_claim: true`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn for_run(
        mode: PiFileAccessMode,
        run_id: &str,
        bot_id: &str,
        execution_epoch: i64,
        workspace: &Path,
        log_path: &Path,
        now_ms: i64,
        claim: Option<&LiveClaim>,
        requires_claim: bool,
    ) -> Result<Option<Self>> {
        if !mode.guarded() {
            return Ok(None);
        }
        if run_id.trim().is_empty() {
            bail!("Pi file grant requires a non-empty AgentRun id");
        }
        if bot_id.trim().is_empty() {
            bail!("Pi file grant requires a non-empty Agent id");
        }
        if execution_epoch < 1 {
            bail!("Pi file grant requires a positive execution epoch");
        }
        let workspace_real = dunce::canonicalize(workspace)
            .with_context(|| format!("Pi file grant workspace is unresolvable: {}", workspace.display()))?;
        if !workspace_real.is_absolute() {
            bail!("Pi file grant workspace must be absolute");
        }
        if !workspace_real.is_dir() {
            bail!("Pi file grant workspace must be a directory");
        }
        let expires_at_epoch_ms = now_ms
            .checked_add(PI_FILE_GRANT_TTL_MS)
            .context("Pi file grant expiry overflowed")?;
        let claim = grant_claim_fields(claim, run_id, now_ms)?;
        Ok(Some(Self {
            schema: PI_FILE_GRANT_SCHEMA.to_string(),
            run_id: run_id.to_string(),
            bot_id: bot_id.to_string(),
            execution_epoch,
            workspace_real: workspace_real.to_string_lossy().into_owned(),
            allowed_tools: mode
                .granted_tools()
                .iter()
                .map(|tool| (*tool).to_string())
                .collect(),
            expires_at_epoch_ms,
            log_path: log_path.to_string_lossy().into_owned(),
            claim_id: claim.map_or_else(String::new, |(claim_id, _, _)| claim_id.to_string()),
            fence_generation: claim.map_or(0, |(_, fence_generation, _)| fence_generation),
            lease_expires_at_epoch_ms: claim.map_or(0, |(_, _, lease)| lease),
            requires_claim: requires_claim || claim.is_some(),
        }))
    }

    /// Re-issue this grant for the claim the Run holds *now* (P0 step 3).
    ///
    /// The shared guard re-reads the grant document before every decision, so this is the whole of
    /// "Core re-issues the authorisation after `loom.claim`": only the claim triple and
    /// `requiresClaim` move. The Run/bot/epoch/workspace/tool/log/expiry identity is copied
    /// verbatim, so a re-issue can never re-point the guard at another Run or another workspace.
    ///
    /// A lease that already lapsed is never carried (the triple empties) but the requirement stays
    /// `true` — the fail-closed direction: the guard then refuses a write with `claim_missing`
    /// instead of silently falling back to pre-claim behaviour. `requires_claim` is monotone: it can
    /// be switched on by a binding or by the claim itself, never off.
    pub(crate) fn reissued_for_claim(
        &self,
        claim: Option<&LiveClaim>,
        requires_claim: bool,
        now_ms: i64,
    ) -> Result<Self> {
        let fields = grant_claim_fields(claim, &self.run_id, now_ms)?;
        let mut reissued = self.clone();
        reissued.requires_claim = self.requires_claim || requires_claim || fields.is_some();
        reissued.claim_id = fields.map_or_else(String::new, |(claim_id, _, _)| claim_id.to_string());
        reissued.fence_generation = fields.map_or(0, |(_, fence_generation, _)| fence_generation);
        reissued.lease_expires_at_epoch_ms = fields.map_or(0, |(_, _, lease)| lease);
        Ok(reissued)
    }

    /// Expired grants must never be presented to a Host.
    pub(crate) fn is_expired(&self, now_ms: i64) -> bool {
        now_ms >= self.expires_at_epoch_ms
    }

    /// The claim triple this grant presents, or `None` for a Run that holds no LOOM claim. An empty
    /// `claim_id` is the single source of truth: the fence and the lease are then `0` by construction.
    pub(crate) fn claim(&self) -> Option<(&str, i64, i64)> {
        (!self.claim_id.is_empty()).then(|| {
            (
                self.claim_id.as_str(),
                self.fence_generation,
                self.lease_expires_at_epoch_ms,
            )
        })
    }

    /// Bind the grant to the exact Run/bot/epoch it was issued for.
    pub(crate) fn binds(&self, run_id: &str, bot_id: &str, execution_epoch: i64) -> bool {
        self.run_id == run_id && self.bot_id == bot_id && self.execution_epoch == execution_epoch
    }

    pub(crate) fn to_document(&self) -> Result<Value> {
        serde_json::to_value(self).context("Pi file grant is not serializable")
    }

    pub(crate) fn workspace_real(&self) -> PathBuf {
        PathBuf::from(&self.workspace_real)
    }
}

/// The claim triple a grant may carry, in (claimId, fenceGeneration, leaseExpiresAtEpochMs) form.
///
/// - `None` — this Run is not bound to a LOOM Task — yields an empty triple.
/// - A lease that already lapsed (or cannot be parsed) also yields an empty triple: `loom::lease_expired`
///   already treats such a lease as dead, so presenting it would claim a fence nobody holds.
/// - A claim that belongs to another Run, or has no identity/fence, is a Core wiring bug rather than
///   a timing accident, so the launch fails instead of emitting a half-bound grant.
fn grant_claim_fields<'a>(
    claim: Option<&'a LiveClaim>,
    run_id: &str,
    now_ms: i64,
) -> Result<Option<(&'a str, i64, i64)>> {
    let Some(claim) = claim else { return Ok(None) };
    if claim.agent_run_id != run_id {
        bail!("Pi file grant claim belongs to another AgentRun");
    }
    if claim.claim_id.trim().is_empty() {
        bail!("Pi file grant claim requires a non-empty claim id");
    }
    if claim.fence_generation < 1 {
        bail!("Pi file grant claim requires a positive fence generation");
    }
    let Some(lease_expires_at_epoch_ms) = lease_epoch_ms(&claim.lease_expires_at) else {
        return Ok(None);
    };
    if lease_expires_at_epoch_ms <= now_ms {
        return Ok(None);
    }
    Ok(Some((
        claim.claim_id.as_str(),
        claim.fence_generation,
        lease_expires_at_epoch_ms,
    )))
}

/// A claim lease is written as RFC 3339 by LOOM; the grant presents it as epoch milliseconds so the
/// guard compares one number. An unparsable value is "no live lease", never "0 ms is fine".
fn lease_epoch_ms(lease_expires_at: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(lease_expires_at)
        .ok()
        .map(|expires| expires.timestamp_millis())
}

pub(crate) fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_workspace(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("rovai-pi-file-grant-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// The claim `loom::live_claim_for_run` would report, built directly here because these tests own
    /// the grant document, not the claim storage.
    fn live_claim(run_id: &str, claim_id: &str, fence_generation: i64, lease_expires_at_epoch_ms: i64) -> LiveClaim {
        LiveClaim {
            claim_id: claim_id.to_string(),
            agent_run_id: run_id.to_string(),
            fence_generation,
            lease_expires_at: chrono::DateTime::from_timestamp_millis(lease_expires_at_epoch_ms)
                .unwrap()
                .to_rfc3339(),
        }
    }

    #[test]
    fn absent_policy_stays_native() {
        assert_eq!(mode_from_permissions(&json!({})).unwrap(), PiFileAccessMode::Native);
        assert_eq!(
            mode_from_permissions(&json!({ "loom_file_access": "native" })).unwrap(),
            PiFileAccessMode::Native
        );
        assert_eq!(
            mode_from_permissions(&json!({ "loom_file_access": { "mode": "native" } })).unwrap(),
            PiFileAccessMode::Native
        );
    }

    #[test]
    fn guarded_modes_are_explicit() {
        for (value, expected) in [
            (json!("workspace_read_only"), PiFileAccessMode::WorkspaceReadOnly),
            (json!({ "mode": "workspace_read_only" }), PiFileAccessMode::WorkspaceReadOnly),
            (json!("workspace_read_write"), PiFileAccessMode::WorkspaceReadWrite),
            (json!({ "mode": "workspace_read_write" }), PiFileAccessMode::WorkspaceReadWrite),
            (json!("workspace_workflow"), PiFileAccessMode::WorkspaceWorkflow),
            (json!({ "mode": "workspace_workflow" }), PiFileAccessMode::WorkspaceWorkflow),
        ] {
            assert_eq!(
                mode_from_permissions(&json!({ "loom_file_access": value })).unwrap(),
                expected
            );
        }
        // Every guarded mode loads the guard; only the frozen tool list differs.
        assert!(PiFileAccessMode::WorkspaceReadOnly.guarded());
        assert!(PiFileAccessMode::WorkspaceReadWrite.guarded());
        assert!(PiFileAccessMode::WorkspaceWorkflow.guarded());
        assert!(!PiFileAccessMode::Native.guarded());
        assert!(PiFileAccessMode::Native.granted_tools().is_empty());
        // The legacy tool sets are untouched by the workflow mode.
        assert_eq!(PiFileAccessMode::WorkspaceReadOnly.granted_tools(), ["read"]);
        assert_eq!(
            PiFileAccessMode::WorkspaceReadWrite.granted_tools(),
            ["read", "write", "edit"]
        );
        assert_eq!(
            PiFileAccessMode::WorkspaceWorkflow.granted_tools(),
            ["read", "write", "edit", PI_LOOM_TOOL_NAME]
        );
    }

    #[test]
    fn unknown_key_is_rejected_not_defaulted() {
        let error = mode_from_permissions(&json!({
            "loom_file_access": { "mode": "workspace_read_only", "workspaceRoot": "/tmp" }
        }))
        .unwrap_err()
        .to_string();
        assert!(error.contains("unknown key"), "{error}");
        let error = mode_from_permissions(&json!({
            "loom_file_access": { "mode": "workspace_read_write", "tools": ["read", "write"] }
        }))
        .unwrap_err()
        .to_string();
        assert!(error.contains("unknown key"), "{error}");
    }

    #[test]
    fn invalid_mode_is_rejected_not_defaulted() {
        for value in [
            json!("workspace"),
            json!("read-only"),
            json!("read-write"),
            json!("workspace_read_write "),
            json!("workspace_read_only,workspace_read_write"),
            json!(true),
            json!([1]),
        ] {
            assert!(
                mode_from_permissions(&json!({ "loom_file_access": value })).is_err(),
                "{value} must be rejected"
            );
        }
        assert!(mode_from_permissions(&json!({ "loom_file_access": { "mode": 3 } })).is_err());
        assert!(mode_from_permissions(&json!({ "loom_file_access": {} })).is_err());
    }

    #[test]
    fn native_policy_produces_no_grant() {
        let workspace = temp_workspace("native");
        let grant = PiFileGrant::for_run(
            PiFileAccessMode::Native,
            "run-1",
            "bot-1",
            1,
            &workspace,
            &workspace.join("guard.jsonl"),
            now_epoch_ms(),
            None,
            false,
        )
        .unwrap();
        assert!(grant.is_none());
        std::fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn guarded_grant_is_typed_and_bounded() {
        let now = 1_700_000_000_000;
        // One table over both guarded modes: the document shape, identity binding and expiry are shared,
        // and only the frozen tool list differs.
        for (mode, expected_tools) in [
            (PiFileAccessMode::WorkspaceReadOnly, vec!["read".to_string()]),
            (
                PiFileAccessMode::WorkspaceReadWrite,
                vec!["read".to_string(), "write".to_string(), "edit".to_string()],
            ),
            (
                PiFileAccessMode::WorkspaceWorkflow,
                vec![
                    "read".to_string(),
                    "write".to_string(),
                    "edit".to_string(),
                    PI_LOOM_TOOL_NAME.to_string(),
                ],
            ),
        ] {
            let workspace = temp_workspace(mode.as_str());
            let grant = PiFileGrant::for_run(
                mode,
                "run-1",
                "bot-1",
                7,
                &workspace,
                &workspace.join("guard.jsonl"),
                now,
                None,
                false,
            )
            .unwrap()
            .unwrap();
            assert_eq!(grant.allowed_tools, expected_tools);
            assert_eq!(grant.expires_at_epoch_ms, now + PI_FILE_GRANT_TTL_MS);
            assert!(grant.binds("run-1", "bot-1", 7));
            assert!(!grant.binds("run-2", "bot-1", 7));
            assert!(!grant.binds("run-1", "bot-2", 7));
            assert!(!grant.binds("run-1", "bot-1", 8));
            assert!(!grant.is_expired(now));
            assert!(grant.is_expired(now + PI_FILE_GRANT_TTL_MS));
            // `bash` and every extension/MCP tool are outside both policies by construction.
            for forbidden in ["bash", "mcp__server__tool", "write", "edit"] {
                if !expected_tools.iter().any(|tool| tool == forbidden) {
                    assert!(
                        !grant.allowed_tools.iter().any(|tool| tool == forbidden),
                        "{mode:?} must not grant {forbidden}"
                    );
                }
            }
            // Only the workflow policy carries the managed Core business tool, and only alongside the
            // three native file tools — never on its own.
            if mode == PiFileAccessMode::WorkspaceWorkflow {
                assert!(grant.allowed_tools.iter().any(|tool| tool == PI_LOOM_TOOL_NAME));
            } else {
                assert!(!grant.allowed_tools.iter().any(|tool| tool == PI_LOOM_TOOL_NAME));
            }
            // The document keys are exactly what the shared guard validates: eight identity/policy
            // keys plus the three claim fields and the one requirement flag, never more and never
            // fewer.
            let document = grant.to_document().unwrap();
            for key in [
                "schema",
                "runId",
                "botId",
                "executionEpoch",
                "workspaceReal",
                "allowedTools",
                "expiresAtEpochMs",
                "logPath",
                "claimId",
                "fenceGeneration",
                "leaseExpiresAtEpochMs",
                "requiresClaim",
            ] {
                assert!(document.get(key).is_some(), "grant document is missing {key}");
            }
            assert_eq!(
                document.as_object().unwrap().len(),
                12,
                "the grant schema is eight identity keys plus the claim triple and the claim requirement"
            );
            // An unbound Run carries the empty claim triple and no claim requirement.
            assert_eq!(document["claimId"], json!(""));
            assert_eq!(document["fenceGeneration"], json!(0));
            assert_eq!(document["leaseExpiresAtEpochMs"], json!(0));
            assert_eq!(document["requiresClaim"], json!(false));
            assert!(!grant.requires_claim);
            assert!(grant.claim().is_none());
            assert_eq!(document["schema"], json!(PI_FILE_GRANT_SCHEMA));
            assert_eq!(document["allowedTools"], json!(expected_tools));
            std::fs::remove_dir_all(workspace).ok();
        }
    }

    #[test]
    fn epoch_and_identity_are_required() {
        let workspace = temp_workspace("identity");
        let log = workspace.join("guard.jsonl");
        let build = |run: &str, bot: &str, epoch: i64| {
            PiFileGrant::for_run(
                PiFileAccessMode::WorkspaceReadOnly,
                run,
                bot,
                epoch,
                &workspace,
                &log,
                now_epoch_ms(),
                None,
                false,
            )
        };
        assert!(build("", "bot-1", 1).is_err());
        assert!(build("run-1", "  ", 1).is_err());
        assert!(build("run-1", "bot-1", 0).is_err());
        assert!(build("run-1", "bot-1", -1).is_err());
        assert!(build("run-1", "bot-1", 1).unwrap().is_some());
        std::fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn missing_workspace_is_rejected() {
        let missing = std::env::temp_dir().join(format!("rovai-pi-file-grant-missing-{}", std::process::id()));
        let error = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceReadOnly,
            "run-1",
            "bot-1",
            1,
            &missing,
            &missing.join("guard.jsonl"),
            now_epoch_ms(),
            None,
            false,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("unresolvable"), "{error}");
    }

    /// P0 step 2: a Run that holds a live LOOM claim presents that exact claim/fence/lease, and the
    /// rest of the grant keeps binding the Run/bot/epoch exactly as before.
    #[test]
    fn guarded_grant_carries_the_claim_fence_it_was_issued_under() {
        let workspace = temp_workspace("claim");
        let now = 1_700_000_000_000;
        let lease = now + 90_000;
        let claim = live_claim("run-1", "claim-1", 3, lease);
        let grant = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceWorkflow,
            "run-1",
            "bot-1",
            7,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            Some(&claim),
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(grant.claim_id, "claim-1");
        assert_eq!(grant.fence_generation, 3);
        assert_eq!(grant.lease_expires_at_epoch_ms, lease);
        assert_eq!(grant.claim(), Some(("claim-1", 3, lease)));
        assert!(
            grant.requires_claim,
            "assertion a grant carrying a claim always requires one"
        );
        let document = grant.to_document().unwrap();
        assert_eq!(document.as_object().unwrap().len(), 12);
        assert_eq!(document["claimId"], json!("claim-1"));
        assert_eq!(document["fenceGeneration"], json!(3));
        assert_eq!(document["leaseExpiresAtEpochMs"], json!(lease));
        assert_eq!(document["requiresClaim"], json!(true));
        // The claim never loosens the Run/bot/epoch binding it was issued under.
        assert!(grant.binds("run-1", "bot-1", 7));
        assert!(!grant.binds("run-2", "bot-1", 7));
        assert!(!grant.binds("run-1", "bot-2", 7));
        assert!(!grant.binds("run-1", "bot-1", 8));

        // A claim that is not this Run's, or has no identity/fence, is a wiring bug: refuse to issue a
        // grant rather than emit a half-bound write authorisation.
        let foreign = live_claim("run-2", "claim-1", 3, lease);
        let error = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceWorkflow,
            "run-1",
            "bot-1",
            7,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            Some(&foreign),
            true,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("another AgentRun"), "{error}");
        for (claim_id, fence_generation) in [("", 3), ("   ", 3), ("claim-1", 0), ("claim-1", -1)] {
            let invalid = live_claim("run-1", claim_id, fence_generation, lease);
            let error = PiFileGrant::for_run(
                PiFileAccessMode::WorkspaceWorkflow,
                "run-1",
                "bot-1",
                7,
                &workspace,
                &workspace.join("guard.jsonl"),
                now,
                Some(&invalid),
                true,
            )
            .unwrap_err()
            .to_string();
            assert!(
                error.contains("claim requires"),
                "{claim_id:?}/{fence_generation} must be rejected: {error}"
            );
        }
        std::fs::remove_dir_all(workspace).ok();
    }

    /// P0 step 2: a Run that is not bound to a LOOM Task carries no claim at all, which is what keeps
    /// ordinary chat behaviour unchanged.
    #[test]
    fn unbound_grant_carries_no_claim_fields() {
        let workspace = temp_workspace("unbound");
        let now = 1_700_000_000_000;
        let grant = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceReadWrite,
            "run-1",
            "bot-1",
            1,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            None,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(grant.claim_id, "");
        assert_eq!(grant.fence_generation, 0);
        assert_eq!(grant.lease_expires_at_epoch_ms, 0);
        assert!(
            !grant.requires_claim,
            "assertion an unbound Run (ordinary chat) is never gated on a claim"
        );
        assert!(grant.claim().is_none());
        let document = grant.to_document().unwrap();
        assert_eq!(document["claimId"], json!(""));
        assert_eq!(document["fenceGeneration"], json!(0));
        assert_eq!(document["leaseExpiresAtEpochMs"], json!(0));
        assert_eq!(document["requiresClaim"], json!(false));
        assert_eq!(document.as_object().unwrap().len(), 12);
        std::fs::remove_dir_all(workspace).ok();
    }

    /// P0 step 2: an already-lapsed (or unreadable) lease is never presented to a Host as a live
    /// claim, even if the caller still hands it over.
    #[test]
    fn an_expired_claim_is_never_presented_to_a_host() {
        let workspace = temp_workspace("claim-expired");
        let now = 1_700_000_000_000;
        for claim in [
            live_claim("run-1", "claim-1", 2, now - 1),
            live_claim("run-1", "claim-1", 2, now),
        ] {
            let grant = PiFileGrant::for_run(
                PiFileAccessMode::WorkspaceWorkflow,
                "run-1",
                "bot-1",
                1,
                &workspace,
                &workspace.join("guard.jsonl"),
                now,
                Some(&claim),
                true,
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                grant.claim_id, "",
                "assertion a lapsed claim lease is never carried into a write grant"
            );
            assert_eq!(grant.fence_generation, 0);
            assert_eq!(grant.lease_expires_at_epoch_ms, 0);
            assert!(grant.claim().is_none());
            assert!(
                grant.requires_claim,
                "assertion clearing a lapsed claim never clears the requirement"
            );
        }
        // An unparsable lease is dead too: LOOM's own `lease_expired` says so.
        let unreadable = LiveClaim {
            claim_id: "claim-1".to_string(),
            agent_run_id: "run-1".to_string(),
            fence_generation: 2,
            lease_expires_at: "not a timestamp".to_string(),
        };
        let grant = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceWorkflow,
            "run-1",
            "bot-1",
            1,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            Some(&unreadable),
            true,
        )
        .unwrap()
        .unwrap();
        assert!(
            grant.claim().is_none(),
            "assertion an unreadable claim lease is never reported as live"
        );
        std::fs::remove_dir_all(workspace).ok();
    }

    /// P0 step 3, the r9 shape: the Run is launched first and claims seconds later, so the grant Core
    /// issues carries `requiresClaim:true` with an EMPTY triple. That is what lets the shared guard
    /// refuse the first write instead of trusting a launch-time snapshot.
    #[test]
    fn a_bound_grant_requires_a_claim_before_the_run_claims() {
        let workspace = temp_workspace("pre-claim");
        let now = 1_700_000_000_000;
        let grant = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceWorkflow,
            "run-1",
            "bot-1",
            1,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            None,
            true,
        )
        .unwrap()
        .unwrap();
        assert!(
            grant.requires_claim,
            "assertion a Run bound to a LOOM Task requires a claim before it holds one"
        );
        assert!(grant.claim().is_none());
        assert_eq!(grant.claim_id, "");
        let document = grant.to_document().unwrap();
        assert_eq!(document["requiresClaim"], json!(true));
        assert_eq!(document["claimId"], json!(""));
        assert_eq!(
            document.as_object().unwrap().len(),
            12,
            "an unmet requirement still uses the one 12-key document"
        );
        std::fs::remove_dir_all(workspace).ok();
    }

    /// P0 step 3: the requirement is derived as an OR, so a caller can never present a claim while
    /// telling the shared guard that no claim is needed.
    #[test]
    fn a_claim_alone_switches_the_requirement_on() {
        let workspace = temp_workspace("claim-forces-requirement");
        let now = 1_700_000_000_000;
        let claim = live_claim("run-1", "claim-1", 1, now + 90_000);
        let grant = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceWorkflow,
            "run-1",
            "bot-1",
            1,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            Some(&claim),
            false,
        )
        .unwrap()
        .unwrap();
        assert!(
            grant.requires_claim,
            "assertion presenting a claim always requires one"
        );
        assert_eq!(grant.to_document().unwrap()["requiresClaim"], json!(true));
        std::fs::remove_dir_all(workspace).ok();
    }

    /// P0 step 3: re-issuing the grant for the claim the Run holds now moves ONLY the claim triple
    /// and the requirement flag — never the Run/bot/epoch/workspace/tool/log/expiry identity the
    /// shared guard binds to. A lapsed lease empties the triple and keeps the requirement.
    #[test]
    fn reissuing_a_grant_moves_only_the_claim_it_was_bound_to() {
        let workspace = temp_workspace("reissue");
        let now = 1_700_000_000_000;
        let launched = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceWorkflow,
            "run-1",
            "bot-1",
            4,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            None,
            true,
        )
        .unwrap()
        .unwrap();

        let claim = live_claim("run-1", "claim-1", 3, now + 90_000);
        let reissued = launched.reissued_for_claim(Some(&claim), true, now).unwrap();
        assert_eq!(reissued.claim(), Some(("claim-1", 3, now + 90_000)));
        assert!(reissued.requires_claim);
        // The identity the guard validates is byte-identical: a re-issue can never re-point it.
        assert_eq!(reissued.schema, launched.schema);
        assert_eq!(reissued.run_id, launched.run_id);
        assert_eq!(reissued.bot_id, launched.bot_id);
        assert_eq!(reissued.execution_epoch, launched.execution_epoch);
        assert_eq!(reissued.workspace_real, launched.workspace_real);
        assert_eq!(reissued.allowed_tools, launched.allowed_tools);
        assert_eq!(reissued.log_path, launched.log_path);
        assert_eq!(
            reissued.expires_at_epoch_ms, launched.expires_at_epoch_ms,
            "assertion a claim re-issue never extends the grant expiry"
        );
        assert!(reissued.binds("run-1", "bot-1", 4));

        // A takeover hands the same Run a NEW fence: the re-issued document carries it, not the old one.
        let takeover = live_claim("run-1", "claim-2", 4, now + 120_000);
        let advanced = reissued.reissued_for_claim(Some(&takeover), true, now).unwrap();
        assert_eq!(advanced.claim(), Some(("claim-2", 4, now + 120_000)));
        assert_ne!(advanced.claim_id, reissued.claim_id);

        // A lease that already lapsed is dropped from the document, but the requirement stays: the
        // guard must refuse that write with `claim_missing`, never fall back to pre-claim behaviour.
        let lapsed = advanced
            .reissued_for_claim(Some(&live_claim("run-1", "claim-2", 4, now - 1)), true, now)
            .unwrap();
        assert!(lapsed.claim().is_none());
        assert!(
            lapsed.requires_claim,
            "assertion a lapsed claim never switches the requirement off"
        );

        // An unbound Run stays unbound: re-issuing with no claim and no binding changes nothing.
        let plain = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceReadWrite,
            "run-2",
            "bot-1",
            1,
            &workspace,
            &workspace.join("guard.jsonl"),
            now,
            None,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(plain.reissued_for_claim(None, false, now).unwrap(), plain);
        // A claim that belongs to another Run is still a wiring bug, not a re-issue.
        let error = plain
            .reissued_for_claim(Some(&claim), true, now)
            .unwrap_err()
            .to_string();
        assert!(error.contains("another AgentRun"), "{error}");
        std::fs::remove_dir_all(workspace).ok();
    }
}
