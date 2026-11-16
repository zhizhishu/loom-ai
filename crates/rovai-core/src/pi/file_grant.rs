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

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Permission key inside `AdapterPermissionConfig.values`.
pub(crate) const PI_FILE_ACCESS_KEY: &str = "loom_file_access";
pub(crate) const PI_FILE_ACCESS_NATIVE: &str = "native";
pub(crate) const PI_FILE_ACCESS_WORKSPACE_READ_ONLY: &str = "workspace_read_only";
pub(crate) const PI_FILE_ACCESS_WORKSPACE_READ_WRITE: &str = "workspace_read_write";

/// Must match `RUNTIME_GUARD_SCHEMA` in scripts/loom-v2-runtime-execution.mjs.
pub(crate) const PI_FILE_GRANT_SCHEMA: &str = "loom.runtime.file-guard.v1";
/// The only tool the read-only policy ever grants. `bash`/`write`/`edit` and every extension/MCP tool
/// stay outside the grant by construction.
pub(crate) const PI_FILE_GRANT_READ_ONLY_TOOLS: [&str; 1] = ["read"];
/// The exact tool set of the read-write policy: Pi's three native file tools, in a fixed order. `bash`
/// and every extension/MCP tool stay outside the grant by construction — this is not a tool framework,
/// it is the same closed list the shared guard already validates.
pub(crate) const PI_FILE_GRANT_READ_WRITE_TOOLS: [&str; 3] = ["read", "write", "edit"];
/// `native` gets no grant at all, so it never has a tool list.
pub(crate) const PI_FILE_GRANT_NO_TOOLS: [&str; 0] = [];
/// A grant is scoped to one Run; twelve hours is far beyond any accepted Run and still bounded.
pub(crate) const PI_FILE_GRANT_TTL_MS: i64 = 12 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PiFileAccessMode {
    Native,
    WorkspaceReadOnly,
    WorkspaceReadWrite,
}

impl PiFileAccessMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Native => PI_FILE_ACCESS_NATIVE,
            Self::WorkspaceReadOnly => PI_FILE_ACCESS_WORKSPACE_READ_ONLY,
            Self::WorkspaceReadWrite => PI_FILE_ACCESS_WORKSPACE_READ_WRITE,
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
}

impl PiFileGrant {
    /// Build the grant for one Run. `Ok(None)` means the member chose the legacy native policy.
    ///
    /// `workspace` is the canonical execution root Core already selected for this AgentRun; a model,
    /// prompt or environment value can never supply it.
    pub(crate) fn for_run(
        mode: PiFileAccessMode,
        run_id: &str,
        bot_id: &str,
        execution_epoch: i64,
        workspace: &Path,
        log_path: &Path,
        now_ms: i64,
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
        }))
    }

    /// Expired grants must never be presented to a Host.
    pub(crate) fn is_expired(&self, now_ms: i64) -> bool {
        now_ms >= self.expires_at_epoch_ms
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
        ] {
            assert_eq!(
                mode_from_permissions(&json!({ "loom_file_access": value })).unwrap(),
                expected
            );
        }
        // Every guarded mode loads the guard; only the frozen tool list differs.
        assert!(PiFileAccessMode::WorkspaceReadOnly.guarded());
        assert!(PiFileAccessMode::WorkspaceReadWrite.guarded());
        assert!(!PiFileAccessMode::Native.guarded());
        assert!(PiFileAccessMode::Native.granted_tools().is_empty());
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
            // The document keys are exactly what the shared guard validates: eight, never more.
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
            ] {
                assert!(document.get(key).is_some(), "grant document is missing {key}");
            }
            assert_eq!(document.as_object().unwrap().len(), 8, "the grant schema stays eight keys");
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
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("unresolvable"), "{error}");
    }
}
