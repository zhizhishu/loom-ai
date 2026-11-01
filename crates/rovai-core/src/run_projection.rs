//! Read-only preview of the Bootstrap text and MCP document a Run would receive.
//!
//! The preview does not create a Run, Bootstrap evidence, or an MCP snapshot file.
//! It renders with [`render_session_bootstrap`] and the same MCP document builders
//! the Codex and Claude Code bundles write.

use std::{collections::BTreeMap, path::Path};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    agent_profile::{AdapterKind, AgentProfileService, AgentProfileView},
    context::{self, render_session_bootstrap},
    db::Database,
    mcp::{McpConfigStore, McpServerDefinition},
    mcp_projection::{McpProjectionRequest, materialize_member_servers},
};

const SECRET_MASK: &str = "********";
const PREVIEW_RUN_ID: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Debug)]
pub(crate) struct MemberRunProjectionError {
    code: &'static str,
    message: String,
}

impl MemberRunProjectionError {
    fn new(code: &'static str, message: impl Into<String>) -> anyhow::Error {
        anyhow::Error::new(Self {
            code,
            message: message.into(),
        })
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for MemberRunProjectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MemberRunProjectionError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberRunProjectionParams {
    pub member: String,
    #[serde(default)]
    pub runtime: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberRunProjection {
    pub agent_id: String,
    pub display_name: String,
    pub runtime: String,
    pub bootstrap: String,
    pub mcp: Value,
    /// Toolbox skills the next Run's additional-skill section will carry.
    pub skills: Vec<crate::member_capability::ProjectedCapability>,
    /// Selected rule snippets. They are not written into the session bootstrap.
    pub rules: Vec<crate::member_capability::ProjectedCapability>,
    /// Selected hooks. They are not written into the session bootstrap.
    pub hooks: Vec<crate::member_capability::ProjectedCapability>,
}

pub(crate) fn preview_member_run_projection(
    database: &Database,
    data_dir: &Path,
    config_store: &McpConfigStore,
    params: &MemberRunProjectionParams,
) -> Result<MemberRunProjection> {
    let member = params.member.trim();
    if member.is_empty() {
        return Err(MemberRunProjectionError::new(
            "member_not_found",
            "member id or display name is required",
        ));
    }
    let profile = resolve_member(database, member)?;
    let adapter = resolve_runtime(params.runtime.as_deref(), &profile)?;
    let parts =
        context::member_projection_bootstrap(database, data_dir, &profile.agent_id, adapter)?;
    let bootstrap = render_session_bootstrap(
        &parts.charter,
        &parts.identity,
        parts.team_guidance.as_deref(),
        parts.platform_skills.as_deref(),
        &parts.memory_entrypoint,
    )?;
    let servers = materialize_member_servers(
        config_store,
        &McpProjectionRequest {
            agent_run_id: PREVIEW_RUN_ID,
            execution_epoch: 1,
            agent_id: &profile.agent_id,
            adapter_kind: adapter,
            reported_runtime_version: None,
            execution_root: data_dir,
        },
        false,
    )?;
    let (skills, rules, hooks) =
        crate::member_capability::projection_additions(database, config_store, &profile.agent_id)?;
    Ok(MemberRunProjection {
        agent_id: profile.agent_id,
        display_name: profile.display_name,
        runtime: runtime_name(adapter)?.to_string(),
        bootstrap,
        mcp: redact_run_mcp_document(&run_bundle_mcp_document(adapter, &servers)?),
        skills,
        rules,
        hooks,
    })
}

/// The JSON a Run bundle writes for this adapter. Codex sends it as session
/// config; Claude Code writes it as the additive `--mcp-config` file.
pub(crate) fn run_bundle_mcp_document(
    adapter: AdapterKind,
    servers: &BTreeMap<String, McpServerDefinition>,
) -> Result<Value> {
    match adapter {
        AdapterKind::CodexCli => crate::codex::codex_mcp_session_config(servers),
        AdapterKind::ClaudeCodeCli => Ok(crate::runtime_mcp::additive_mcp_config_document(servers)),
        other => Err(MemberRunProjectionError::new(
            "runtime_unsupported",
            format!(
                "{other} has no per-run MCP bundle; pass codex-cli or claude-code",
                other = other.as_str()
            ),
        )),
    }
}

pub(crate) fn redact_run_mcp_document(document: &Value) -> Value {
    let mut document = document.clone();
    let Some(root) = document.as_object_mut() else {
        return document;
    };
    for key in ["mcpServers", "mcp_servers"] {
        let Some(servers) = root.get_mut(key).and_then(Value::as_object_mut) else {
            continue;
        };
        for server in servers.values_mut() {
            for field in ["env", "headers", "http_headers"] {
                let Some(entries) = server.get_mut(field).and_then(Value::as_object_mut) else {
                    continue;
                };
                for value in entries.values_mut() {
                    if value.is_string() {
                        *value = json!(SECRET_MASK);
                    }
                }
            }
            if let Some(args) = server.get_mut("args").and_then(Value::as_array_mut) {
                redact_token_like_args(args);
            }
        }
    }
    document
}

fn redact_token_like_args(args: &mut [Value]) {
    let mut mask_next = false;
    for arg in args.iter_mut() {
        let Some(text) = arg.as_str() else {
            mask_next = false;
            continue;
        };
        if mask_next {
            *arg = json!(SECRET_MASK);
            mask_next = false;
            continue;
        }
        if let Some((flag, _)) = text.split_once('=') {
            if token_flag(flag) {
                *arg = json!(format!("{flag}={SECRET_MASK}"));
                continue;
            }
        }
        if token_flag(text) {
            mask_next = true;
            continue;
        }
        if token_like(text) {
            *arg = json!(SECRET_MASK);
        }
    }
}

fn token_flag(arg: &str) -> bool {
    let flag = arg.trim_start_matches('-').to_ascii_lowercase();
    matches!(
        flag.as_str(),
        "token"
            | "api-key"
            | "apikey"
            | "api_key"
            | "password"
            | "secret"
            | "access-token"
            | "auth"
    ) || flag.ends_with("-token")
        || flag.ends_with("-key")
        || flag.ends_with("-secret")
        || flag.ends_with("-password")
}

fn token_like(arg: &str) -> bool {
    let value = arg.trim();
    let lower = value.to_ascii_lowercase();
    lower.starts_with("sk-")
        || lower.starts_with("sk_")
        || lower.starts_with("ghp_")
        || lower.starts_with("github_pat_")
        || lower.starts_with("xox")
        || lower.starts_with("bearer ")
        || lower.starts_with("akia")
        || (value.len() >= 32 && value.chars().all(|character| character.is_ascii_hexdigit()))
}

fn resolve_member(database: &Database, member: &str) -> Result<AgentProfileView> {
    let profiles = AgentProfileService::default().list_profiles(database)?;
    if let Some(profile) = profiles.iter().find(|profile| profile.agent_id == member) {
        return Ok(profile.clone());
    }
    let matches = profiles
        .iter()
        .filter(|profile| profile.display_name == member)
        .cloned()
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches.into_iter().next().expect("length checked")),
        0 => Err(MemberRunProjectionError::new(
            "member_not_found",
            format!("no current member matches {member}"),
        )),
        _ => Err(MemberRunProjectionError::new(
            "member_ambiguous",
            format!("more than one current member is named {member}"),
        )),
    }
}

fn resolve_runtime(requested: Option<&str>, profile: &AgentProfileView) -> Result<AdapterKind> {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    if let Some(requested) = requested {
        return parse_runtime(requested);
    }
    match profile
        .runtime_configuration
        .as_ref()
        .map(|configuration| configuration.adapter_kind)
    {
        Some(adapter @ (AdapterKind::CodexCli | AdapterKind::ClaudeCodeCli)) => Ok(adapter),
        Some(adapter) => Err(MemberRunProjectionError::new(
            "runtime_required",
            format!(
                "member runtime is {}; pass codex-cli or claude-code",
                adapter.as_str()
            ),
        )),
        None => Err(MemberRunProjectionError::new(
            "runtime_required",
            "member has no runtime; pass codex-cli or claude-code",
        )),
    }
}

fn parse_runtime(value: &str) -> Result<AdapterKind> {
    match value {
        "codex-cli" => Ok(AdapterKind::CodexCli),
        "claude-code" | "claude-code-cli" => Ok(AdapterKind::ClaudeCodeCli),
        other => Err(MemberRunProjectionError::new(
            "runtime_unsupported",
            format!("{other} is not codex-cli or claude-code"),
        )),
    }
}

fn runtime_name(adapter: AdapterKind) -> Result<&'static str> {
    match adapter {
        AdapterKind::CodexCli => Ok("codex-cli"),
        AdapterKind::ClaudeCodeCli => Ok("claude-code"),
        other => Err(MemberRunProjectionError::new(
            "runtime_unsupported",
            format!("{} is not codex-cli or claude-code", other.as_str()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::mcp::{
        CreateMcpServerParams, McpConfigView, McpMutationResult, SetMcpMembersParams,
        SetMcpServerEnabledParams,
    };

    fn applied(result: McpMutationResult) -> (String, McpConfigView) {
        match result {
            McpMutationResult::Ok {
                config_digest,
                config,
                ..
            } => (config_digest, *config),
            McpMutationResult::Conflict { .. } => panic!("MCP mutation conflicted"),
            McpMutationResult::Invalid { issues } => panic!("MCP mutation invalid: {issues:?}"),
            McpMutationResult::RiskAcknowledgementRequired { server_id } => {
                panic!("MCP mutation required risk acknowledgement for {server_id}")
            }
        }
    }

    fn server_id(view: &McpConfigView, name: &str) -> String {
        view.servers
            .iter()
            .find(|server| server.name == name)
            .unwrap_or_else(|| panic!("missing MCP server {name}"))
            .server_id
            .clone()
    }

    fn projection_error(error: anyhow::Error) -> &'static str {
        error
            .downcast_ref::<MemberRunProjectionError>()
            .unwrap_or_else(|| panic!("{error:#}"))
            .code()
    }

    #[test]
    fn preview_mcp_keeps_env_keys_and_masks_token_like_args() {
        let document = json!({
            "mcp_servers": {
                "local": {
                    "command": "echo",
                    "args": ["serve", "--token", "sk-live-secret-value", "--api-key=plain-looking", "plain.js"],
                    "env": { "API_KEY": "super-secret", "PLAIN": "visible-env" },
                    "headers": { "Authorization": "Bearer fixture-header-secret" }
                }
            }
        });
        let redacted = redact_run_mcp_document(&document);
        let server = &redacted["mcp_servers"]["local"];
        let env = server["env"].as_object().unwrap();
        assert!(env.contains_key("API_KEY") && env.contains_key("PLAIN"));
        assert_eq!(env["API_KEY"], SECRET_MASK);
        assert_eq!(env["PLAIN"], SECRET_MASK);
        assert_eq!(server["headers"]["Authorization"], SECRET_MASK);
        let args = server["args"].as_array().unwrap();
        assert_eq!(args[0], "serve");
        assert_eq!(args[1], "--token");
        assert_eq!(args[2], SECRET_MASK);
        assert_eq!(args[3], format!("--api-key={SECRET_MASK}"));
        assert_eq!(args[4], "plain.js");
        let rendered = serde_json::to_string(&redacted).unwrap();
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("visible-env"));
        assert!(!rendered.contains("sk-live-secret-value"));
        assert!(!rendered.contains("fixture-header-secret"));
        assert!(!rendered.contains("plain-looking"));
    }

    #[test]
    fn preview_matches_the_run_bundle_for_a_fixture_member() {
        let directory =
            std::env::temp_dir().join(format!("rovai-run-projection-{}", uuid::Uuid::new_v4()));
        let database = Database::open(&directory).unwrap();
        let store = McpConfigStore::new(directory.join("mcp.json"));
        let profiles = AgentProfileService::default()
            .list_profiles(&database)
            .unwrap();
        let member = profiles[0].clone();
        let other = profiles[1].clone();
        let known = profiles
            .iter()
            .map(|profile| profile.agent_id.clone())
            .collect::<BTreeSet<_>>();
        let evidence_before: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM native_session_bootstrap_evidence",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let missing = preview_member_run_projection(
            &database,
            &directory,
            &store,
            &MemberRunProjectionParams {
                member: "nobody".to_string(),
                runtime: Some("codex-cli".to_string()),
            },
        )
        .unwrap_err();
        assert_eq!(projection_error(missing), "member_not_found");
        let needs_runtime = preview_member_run_projection(
            &database,
            &directory,
            &store,
            &MemberRunProjectionParams {
                member: member.agent_id.clone(),
                runtime: None,
            },
        )
        .unwrap_err();
        assert_eq!(projection_error(needs_runtime), "runtime_required");

        let mut digest = store.get(&known).unwrap().config_digest;
        for (name, definition, assign, enable) in [
            (
                "local",
                r#"{"mcpServers":{"local":{"command":"echo","args":["server.js"],"env":{"API_TOKEN":"fixture-env-secret","PLAIN":"visible-env"}}}}"#,
                true,
                true,
            ),
            (
                "remote",
                r#"{"mcpServers":{"remote":{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer fixture-header-secret"}}}}"#,
                true,
                true,
            ),
            (
                "other",
                r#"{"mcpServers":{"other":{"command":"other","args":["skip.js"]}}}"#,
                false,
                true,
            ),
            (
                "off",
                r#"{"mcpServers":{"off":{"command":"off","args":["disabled.js"]}}}"#,
                true,
                false,
            ),
        ] {
            let (next, view) = applied(
                store
                    .create(
                        CreateMcpServerParams {
                            expected_config_digest: digest,
                            definition_json: definition.to_string(),
                        },
                        &known,
                    )
                    .unwrap(),
            );
            digest = next;
            let id = server_id(&view, name);
            if assign {
                let (next, _) = applied(
                    store
                        .set_members(
                            SetMcpMembersParams {
                                expected_config_digest: digest,
                                server_id: id.clone(),
                                agent_ids: vec![member.agent_id.clone()],
                                acknowledge_high_risk: false,
                            },
                            &known,
                        )
                        .unwrap(),
                );
                digest = next;
            }
            // set_members turns the server on. "off" is assigned and then disabled.
            if enable != assign {
                let (next, _) = applied(
                    store
                        .set_enabled(
                            SetMcpServerEnabledParams {
                                expected_config_digest: digest,
                                server_id: id,
                                enabled: enable,
                                acknowledge_high_risk: false,
                            },
                            &known,
                        )
                        .unwrap(),
                );
                digest = next;
            }
        }

        for adapter in [AdapterKind::CodexCli, AdapterKind::ClaudeCodeCli] {
            let runtime = runtime_name(adapter).unwrap();
            let by_id = preview_member_run_projection(
                &database,
                &directory,
                &store,
                &MemberRunProjectionParams {
                    member: member.agent_id.clone(),
                    runtime: Some(runtime.to_string()),
                },
            )
            .unwrap();
            let by_name = preview_member_run_projection(
                &database,
                &directory,
                &store,
                &MemberRunProjectionParams {
                    member: member.display_name.clone(),
                    runtime: Some(runtime.to_string()),
                },
            )
            .unwrap();
            assert_eq!(by_id, by_name);

            let parts = context::member_projection_bootstrap(
                &database,
                &directory,
                &member.agent_id,
                adapter,
            )
            .unwrap();
            let run_bootstrap = render_session_bootstrap(
                &parts.charter,
                &parts.identity,
                parts.team_guidance.as_deref(),
                parts.platform_skills.as_deref(),
                &parts.memory_entrypoint,
            )
            .unwrap();
            assert_eq!(by_id.bootstrap, run_bootstrap);
            assert!(by_id.bootstrap.contains(&member.display_name));
            let completion = "Do not background required finite commands";
            assert_eq!(
                by_id.bootstrap.contains(completion),
                adapter == AdapterKind::ClaudeCodeCli
            );

            let request = McpProjectionRequest {
                agent_run_id: PREVIEW_RUN_ID,
                execution_epoch: 1,
                agent_id: &member.agent_id,
                adapter_kind: adapter,
                reported_runtime_version: None,
                execution_root: &directory,
            };
            let run_servers = materialize_member_servers(&store, &request, true).unwrap();
            let readonly_servers = materialize_member_servers(&store, &request, false).unwrap();
            assert_eq!(run_servers, readonly_servers);
            let run_document = run_bundle_mcp_document(adapter, &run_servers).unwrap();
            assert_eq!(by_id.mcp, redact_run_mcp_document(&run_document));
            let names = by_id.mcp[if adapter == AdapterKind::CodexCli {
                "mcp_servers"
            } else {
                "mcpServers"
            }]
            .as_object()
            .unwrap();
            assert!(names.contains_key("local") && names.contains_key("remote"));
            assert!(!names.contains_key("other") && !names.contains_key("off"));

            if adapter == AdapterKind::ClaudeCodeCli {
                let runtime_dir = directory.join("private-runtime");
                std::fs::create_dir_all(&runtime_dir).unwrap();
                let written = crate::runtime_mcp::write_ephemeral_additive_mcp_config(
                    &runtime_dir,
                    &run_servers,
                )
                .unwrap();
                let parsed: Value =
                    serde_json::from_str(&std::fs::read_to_string(written.path()).unwrap())
                        .unwrap();
                assert_eq!(parsed, run_document);
            }

            let rendered = serde_json::to_string(&by_id).unwrap();
            assert!(!rendered.contains("fixture-env-secret"));
            assert!(!rendered.contains("visible-env"));
            assert!(!rendered.contains("fixture-header-secret"));
            assert!(rendered.contains(SECRET_MASK));
            assert!(rendered.contains("echo"));
            assert!(rendered.contains("https://example.com/mcp"));
        }

        let evidence_after: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM native_session_bootstrap_evidence",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(evidence_before, evidence_after);
        assert!(!directory.join("runtime/mcp").exists());

        database
            .connection()
            .execute(
                "UPDATE agent_profile SET display_name = ?1 WHERE id = ?2",
                rusqlite::params![member.display_name, other.agent_id],
            )
            .unwrap();
        let ambiguous = preview_member_run_projection(
            &database,
            &directory,
            &store,
            &MemberRunProjectionParams {
                member: member.display_name,
                runtime: Some("codex-cli".to_string()),
            },
        )
        .unwrap_err();
        assert_eq!(projection_error(ambiguous), "member_ambiguous");

        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
