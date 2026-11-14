//! Per-Run capability bundle assembled on A for a node.
//!
//! The builder is pure. It takes an already frozen snapshot of everything this
//! attempt would put in front of the native CLI and returns one immutable,
//! versioned [`RunBundleV1`]. It reads no database, no filesystem and no
//! environment, so the supervisor's glue owns catalog/current-source snapshot
//! and file loading, and a later save can only reach the *next* Run.
//!
//! What this module may and may not reuse:
//!
//! * `render_session_bootstrap` output arrives frozen in the request; the
//!   renderer is not called and no marker is added.
//! * `[ROVAI_ADDITIONAL_SKILLS]` keeps the exact byte format and JSON shape of
//!   `ContextService::prepare_additional_skills`, rendered here from the actual
//!   selected `SkillIndexEntry` values and the frozen A-side skill root.
//! * Selected rule snippets are real additive instructions: their exact bodies
//!   are appended after the bootstrap text. Hook bodies become native hook
//!   settings.
//! * The two mandatory platform skills arrive separately from the optional
//!   selection. Their index already lives in the frozen bootstrap and is only
//!   compared, never rewritten; their file bytes ride in the bundle.
//! * `ProjectedCapability::body` for a skill is a catalog note, never skill
//!   source. Skill bytes come only from `SkillFileSource`.
//!
//! Secrets: the default policy is fail closed. A nonempty MCP `env`/`headers`
//! value, any `${...}` reference, a secret-like argument or URL secret is
//! refused instead of being exported, redacted or silently dropped. Errors name
//! a code and a field, never a value.
//!
//! Digest scope: the bundle owns only the frozen capability payload and this
//! attempt's identity. A user task or Run input never changes it; a launch
//! digest that also covers input belongs to the supervisor's dispatch record.

mod source;
pub(crate) use source::collect_skill_files;
pub(crate) use source::{BundleSourceError, FreezeMemberBundleParams, FrozenMemberBundle, FrozenBundleSource, CapturedMemberBundleSource, BundleSourceDatabaseStamp, freeze_member_bundle, capture_member_bundle_source, capture_in_existing_transaction};

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    agent_profile::AdapterKind,
    codex::codex_remote_mcp_session_config,
    managed_skills::{PLATFORM_SKILLS, SkillIndexEntry},
    mcp::McpServerDefinition,
    member_capability::ProjectedCapability,
    runtime_mcp::additive_mcp_config_document,
};
use loom_protocol::run_bundle::{
    ADAPTER_CLAUDE_CODE, ADAPTER_CODEX_CLI, BundleArtifact, BundleExpectation, BundleFile,
    BundleReject, LABEL_BOOTSTRAP, LABEL_MCP, LABEL_SETTINGS, RUN_BUNDLE_REFERENCE_VERSION,
    RUN_BUNDLE_VERSION, RunBundleV1, bundle_digest, bundle_id_for, canonical_path,
    mcp_environment_references, validate, valid_mcp_reference_name,
};

/// The `********` mask some documents carry. A masked value is not a value.
const SECRET_MASK: &str = "********";

/// Native hook events this bounded package understands. Anything else is
/// refused instead of being dropped.
const SUPPORTED_HOOK_EVENTS: [&str; 5] = [
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionStart",
    "SessionEnd",
];

/// Matcher-group keys that may reach a native settings file.
const HOOK_GROUP_KEYS: [&str; 2] = ["matcher", "hooks"];

/// One file of a selected skill, already read from the managed Skill source.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct SkillFileSource {
    pub name: String,
    /// Path inside `skills/<name>/`, mirroring the managed directory.
    pub relative_path: String,
    pub content: Vec<u8>,
}

/// Frozen inputs of one attempt. Nothing here is looked up again.
pub(crate) struct RunBundleBuildRequest<'a> {
    pub run_id: &'a str,
    pub attempt: u32,
    pub agent_id: &'a str,
    pub adapter_kind: AdapterKind,
    /// Selection snapshot identifier, so a later save is a different bundle.
    pub selection_revision: &'a str,
    /// Root value the existing bootstrap renderer already froze inside its skill
    /// sections (an A-side path). It is never a guessed node path: the node
    /// relocates the known roots itself.
    pub source_skill_root: &'a str,
    /// Exact output of the existing bootstrap renderer, byte for byte.
    pub bootstrap: &'a str,
    pub selected_skills: &'a [SkillFileSource],
    /// The two mandatory platform skills the bootstrap already indexes. Their
    /// file bytes arrive here so they can be frozen alongside the bundle.
    pub platform_skill_index: &'a [SkillIndexEntry],
    /// Optional toolbox skills selected for this Run. Never the platform set.
    pub skill_index: &'a [SkillIndexEntry],
    /// Selected member servers only, with raw (unresolved) values.
    pub mcp_servers: &'a BTreeMap<String, McpServerDefinition>,
    pub rules: &'a [ProjectedCapability],
    pub hooks: &'a [ProjectedCapability],
}

#[derive(Debug)]
pub(crate) enum RemoteRunBundleError {
    UnsupportedRuntime {
        adapter: String,
    },
    MissingBootstrap,
    SkillSelectionMismatch,
    SkillRootMissing,
    /// An optional selection tried to claim a frozen platform skill name.
    ReservedPlatformSkill {
        name: String,
    },
    /// The bootstrap's own `[ROVAI_PLATFORM_SKILLS]` index is not this Run's.
    PlatformIndexMismatch,
    RuleBodyEmpty {
        name: String,
    },
    McpSecretRefused {
        server: String,
        field: &'static str,
    },
    McpCwdNotPortable {
        server: String,
    },
    McpDefinitionInvalid {
        server: String,
        field: &'static str,
    },
    HookInvalid {
        name: String,
        detail: &'static str,
    },
    BundleRejected {
        reject: BundleReject,
    },
    Invalid {
        detail: &'static str,
    },
}

impl RemoteRunBundleError {
    fn unsupported_runtime(adapter: &str) -> anyhow::Error {
        anyhow::Error::new(Self::UnsupportedRuntime {
            adapter: adapter.to_string(),
        })
    }

    fn skill_selection_mismatch() -> anyhow::Error {
        anyhow::Error::new(Self::SkillSelectionMismatch)
    }

    fn skill_root_missing() -> anyhow::Error {
        anyhow::Error::new(Self::SkillRootMissing)
    }

    fn platform_index_mismatch() -> anyhow::Error {
        anyhow::Error::new(Self::PlatformIndexMismatch)
    }

    fn invalid(detail: &'static str) -> anyhow::Error {
        anyhow::Error::new(Self::Invalid { detail })
    }

    fn hook(name: &str, detail: &'static str) -> anyhow::Error {
        anyhow::Error::new(Self::HookInvalid {
            name: name.to_string(),
            detail,
        })
    }

    /// Stable wire code. Never a value.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedRuntime { .. } => "bundle_runtime_unsupported",
            Self::MissingBootstrap => "bundle_missing_bootstrap",
            Self::SkillSelectionMismatch => "bundle_skill_selection_mismatch",
            Self::SkillRootMissing => "bundle_skill_root_missing",
            Self::ReservedPlatformSkill { .. } => "bundle_skill_name_reserved",
            Self::PlatformIndexMismatch => "bundle_platform_skill_mismatch",
            Self::RuleBodyEmpty { .. } => "bundle_rule_body_empty",
            Self::McpSecretRefused { .. } => "bundle_mcp_secret_refused",
            Self::McpCwdNotPortable { .. } => "bundle_mcp_cwd_not_portable",
            Self::McpDefinitionInvalid { .. } => "bundle_mcp_definition_invalid",
            Self::HookInvalid { .. } => "bundle_hook_invalid",
            Self::BundleRejected { reject } => reject.code(),
            Self::Invalid { .. } => "bundle_invalid",
        }
    }
}

impl std::fmt::Display for RemoteRunBundleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedRuntime { adapter } => {
                write!(formatter, "{}: {adapter}", self.code())
            }
            Self::MissingBootstrap => write!(formatter, "{}", self.code()),
            Self::SkillSelectionMismatch => write!(formatter, "{}", self.code()),
            Self::SkillRootMissing => write!(formatter, "{}", self.code()),
            Self::ReservedPlatformSkill { name } => write!(formatter, "{}: {name}", self.code()),
            Self::PlatformIndexMismatch => write!(formatter, "{}", self.code()),
            Self::RuleBodyEmpty { name } => write!(formatter, "{}: {name}", self.code()),
            Self::McpSecretRefused { server, field } => {
                write!(formatter, "{}: {server}.{field}", self.code())
            }
            Self::McpCwdNotPortable { server } => {
                write!(formatter, "{}: {server}.cwd", self.code())
            }
            Self::McpDefinitionInvalid { server, field } => {
                write!(formatter, "{}: {server}.{field}", self.code())
            }
            Self::HookInvalid { name, detail } => {
                write!(formatter, "{}: {name}.{detail}", self.code())
            }
            Self::BundleRejected { reject } => write!(formatter, "{reject}"),
            Self::Invalid { detail } => write!(formatter, "{}: {detail}", self.code()),
        }
    }
}

impl std::error::Error for RemoteRunBundleError {}

/// Mount a selected-skill index exactly like
/// `ContextService::prepare_additional_skills` does.
#[derive(Serialize)]
struct SkillIndex<'a> {
    root: &'a str,
    skills: &'a [SkillIndexEntry],
}

pub(crate) fn build_remote_run_bundle(request: &RunBundleBuildRequest<'_>) -> Result<RunBundleV1> {
    let adapter_kind = match request.adapter_kind {
        AdapterKind::CodexCli => ADAPTER_CODEX_CLI,
        AdapterKind::ClaudeCodeCli => ADAPTER_CLAUDE_CODE,
        other => return Err(RemoteRunBundleError::unsupported_runtime(other.as_str())),
    };

    if request.bootstrap.trim().is_empty() || request.bootstrap.contains('\0') {
        return Err(anyhow::Error::new(RemoteRunBundleError::MissingBootstrap));
    }

    let selection = skill_selection(request)?;
    let rules_text = rules_text(request.rules)?;

    // Additive instructions: the frozen bootstrap, then the established
    // additional-skills section, then the selected rule bodies. No new markers.
    // Only the optional selection adds a section: the two mandatory platform
    // skills already live in the bootstrap's own `[ROVAI_PLATFORM_SKILLS]`
    // block, whose bytes this module never rewrites.
    let mut instructions = request.bootstrap.to_string();
    if !selection.optional.is_empty() {
        let section =
            additional_skills_section(request.source_skill_root.trim(), &selection.optional)?;
        instructions.push_str("\n\n");
        instructions.push_str(&section);
    }
    if let Some(rules) = rules_text.as_deref() {
        instructions.push_str("\n\n");
        instructions.push_str(rules);
    }

    let mut files = vec![text_file(
        BundleArtifact::BootstrapPrompt,
        LABEL_BOOTSTRAP,
        instructions.as_bytes(),
    )?];

    if !request.mcp_servers.is_empty() {
        validate_mcp_servers(request.mcp_servers)?;
        let document = match request.adapter_kind {
            AdapterKind::ClaudeCodeCli => additive_mcp_config_document(request.mcp_servers),
            // Only the remote config uses the reference dialect: Codex resolves
            // `env_vars` and `env_http_headers` from the process environment the
            // node itself prepares, so no value is ever written here.
            AdapterKind::CodexCli => codex_remote_mcp_session_config(request.mcp_servers)?,
            other => return Err(RemoteRunBundleError::unsupported_runtime(other.as_str())),
        };
        let bytes = serde_json::to_vec(&document)
            .map_err(|_| RemoteRunBundleError::invalid("mcp_document"))?;
        files.push(text_file(BundleArtifact::McpConfig, LABEL_MCP, &bytes)?);
    }

    if let Some(settings) = hook_settings(adapter_kind, request.hooks)? {
        files.push(text_file(
            BundleArtifact::RuntimeSettings,
            LABEL_SETTINGS,
            &settings,
        )?);
    }

    // File order is canonical: bootstrap, mcp, settings, then skill files sorted
    // by name and relative path. Union files cover the mandatory platform set and
    // the optional selection; nothing else is shipped.
    for index in &selection.files {
        let file = &request.selected_skills[*index];
        let label = format!("{}/{}", file.name, file.relative_path);
        files.push(BundleFile {
            artifact: BundleArtifact::SkillFile,
            label: label.clone(),
            path: canonical_path(BundleArtifact::SkillFile, &label)
                .ok_or_else(RemoteRunBundleError::skill_selection_mismatch)?,
            bytes: file.content.len(),
            content: STANDARD.encode(&file.content),
        });
    }

    let source_skill_root = if selection.platform.is_empty() && selection.optional.is_empty() {
        None
    } else {
        Some(request.source_skill_root.trim().to_string())
    };
    let mut bundle = RunBundleV1 {
        version: RUN_BUNDLE_VERSION,
        bundle_id: bundle_id_for(request.run_id, request.attempt),
        run_id: request.run_id.to_string(),
        attempt: request.attempt,
        agent_id: request.agent_id.to_string(),
        adapter_kind: adapter_kind.to_string(),
        selection_revision: request.selection_revision.to_string(),
        source_skill_root,
        digest: String::new(),
        files,
    };
    // The version is a property of the frozen document, never a caller choice:
    // only a document that refers to a credential by name moves to v2, and a
    // reference-free document keeps the old version and bytes.
    if !mcp_environment_references(&bundle)
        .map_err(rejected)?
        .is_empty()
    {
        bundle.version = RUN_BUNDLE_REFERENCE_VERSION;
    }
    bundle.digest = bundle_digest(&bundle).map_err(rejected)?;
    validate(
        &bundle,
        &BundleExpectation {
            run_id: request.run_id,
            attempt: request.attempt,
            adapter_kind: request.adapter_kind.as_str(),
        },
    )
    .map_err(rejected)?;
    Ok(bundle)
}

fn rejected(reject: BundleReject) -> anyhow::Error {
    anyhow::Error::new(RemoteRunBundleError::BundleRejected { reject })
}

fn text_file(artifact: BundleArtifact, label: &str, content: &[u8]) -> Result<BundleFile> {
    Ok(BundleFile {
        artifact,
        label: label.to_string(),
        path: canonical_path(artifact, label)
            .ok_or_else(|| RemoteRunBundleError::invalid("canonical_path"))?,
        bytes: content.len(),
        content: STANDARD.encode(content),
    })
}

/// The established section, byte for byte. Only the root differs per host.
pub(crate) fn additional_skills_section(root: &str, entries: &[SkillIndexEntry]) -> Result<String> {
    let json = serde_json::to_string(&SkillIndex {
        root,
        skills: entries,
    })
    .map_err(|_| RemoteRunBundleError::invalid("skills_section"))?;
    Ok(format!(
        "[ROVAI_ADDITIONAL_SKILLS]\nCurrent for this run; replaces any earlier Rovai Additional Skills.\n{json}\n[/ROVAI_ADDITIONAL_SKILLS]"
    ))
}

/// One attempt's skill plan: the two mandatory platform skills, the optional
/// toolbox selection, and the file indexes of their union.
struct SkillSelection {
    optional: Vec<SkillIndexEntry>,
    platform: Vec<SkillIndexEntry>,
    files: Vec<usize>,
}

/// The index and the files must describe the same selection: a skill the model
/// is told about must have its entry file, no unrelated file may ride along, and
/// the mandatory platform set is exactly the one the bootstrap already froze.
fn skill_selection(request: &RunBundleBuildRequest<'_>) -> Result<SkillSelection> {
    let mut platform = request.platform_skill_index.to_vec();
    platform.sort_by(|left, right| left.name.cmp(&right.name));
    for entry in &platform {
        // Only the fixed platform set may be mandatory.
        if !PLATFORM_SKILLS.contains(&entry.name.as_str()) {
            return Err(RemoteRunBundleError::skill_selection_mismatch());
        }
    }
    let mut optional = request.skill_index.to_vec();
    optional.sort_by(|left, right| left.name.cmp(&right.name));
    for entry in &optional {
        // The platform set is frozen by the bootstrap; an optional checkbox can
        // never quietly become a third mandatory skill.
        if PLATFORM_SKILLS.contains(&entry.name.as_str()) {
            return Err(anyhow::Error::new(
                RemoteRunBundleError::ReservedPlatformSkill {
                    name: entry.name.clone(),
                },
            ));
        }
    }
    let mut indexed = platform
        .iter()
        .chain(optional.iter())
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    indexed.sort();
    if indexed.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(RemoteRunBundleError::skill_selection_mismatch());
    }
    let file_names = request
        .selected_skills
        .iter()
        .map(|file| file.name.as_str())
        .collect::<BTreeSet<_>>();
    let index_names = indexed.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if file_names != index_names {
        return Err(RemoteRunBundleError::skill_selection_mismatch());
    }
    for name in &index_names {
        let has_entry = request
            .selected_skills
            .iter()
            .any(|file| file.name == *name && file.relative_path == "SKILL.md");
        if !has_entry {
            return Err(RemoteRunBundleError::skill_selection_mismatch());
        }
    }
    let mut pairs = request
        .selected_skills
        .iter()
        .map(|file| (file.name.as_str(), file.relative_path.as_str()))
        .collect::<Vec<_>>();
    pairs.sort_unstable();
    if pairs.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(RemoteRunBundleError::skill_selection_mismatch());
    }
    if !index_names.is_empty() {
        let root = request.source_skill_root.trim();
        if root.is_empty() || request.source_skill_root.chars().any(char::is_control) {
            return Err(RemoteRunBundleError::skill_root_missing());
        }
    }
    if !platform.is_empty() {
        // The bootstrap's own platform index must be this exact set and root.
        // It is parsed for comparison only; its bytes are never rewritten.
        let frozen = frozen_platform_index(request.bootstrap)?;
        let expected = platform
            .iter()
            .map(|entry| FrozenSkillEntry {
                name: entry.name.clone(),
                desc: entry.desc.clone(),
            })
            .collect::<Vec<_>>();
        if frozen.root != request.source_skill_root.trim() || frozen.skills != expected {
            return Err(RemoteRunBundleError::platform_index_mismatch());
        }
    }
    let mut files = request
        .selected_skills
        .iter()
        .enumerate()
        .collect::<Vec<_>>();
    files.sort_by(|left, right| {
        left.1
            .name
            .cmp(&right.1.name)
            .then(left.1.relative_path.cmp(&right.1.relative_path))
    });
    Ok(SkillSelection {
        optional,
        platform,
        files: files.into_iter().map(|(index, _)| index).collect(),
    })
}

/// The index the existing renderer already wrote into the bootstrap.
#[derive(Deserialize)]
struct FrozenSkillIndex {
    root: String,
    #[serde(default)]
    skills: Vec<FrozenSkillEntry>,
}

#[derive(Deserialize, PartialEq, Eq)]
struct FrozenSkillEntry {
    name: String,
    desc: String,
}

/// Parse the bootstrap's `[ROVAI_PLATFORM_SKILLS]` block. The block stays where
/// the renderer put it and keeps its bytes; this only proves which platform
/// skills it indexes.
fn frozen_platform_index(bootstrap: &str) -> Result<FrozenSkillIndex> {
    const OPEN: &str = "[ROVAI_PLATFORM_SKILLS]\n";
    const CLOSE: &str = "\n[/ROVAI_PLATFORM_SKILLS]";
    let start = bootstrap
        .find(OPEN)
        .map(|index| index + OPEN.len())
        .ok_or_else(RemoteRunBundleError::platform_index_mismatch)?;
    let remainder = &bootstrap[start..];
    let end = remainder
        .find(CLOSE)
        .ok_or_else(RemoteRunBundleError::platform_index_mismatch)?;
    serde_json::from_str(&remainder[..end])
        .map_err(|_| RemoteRunBundleError::platform_index_mismatch())
}

fn rules_text(rules: &[ProjectedCapability]) -> Result<Option<String>> {
    if rules.is_empty() {
        return Ok(None);
    }
    let mut selected = rules.to_vec();
    selected.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    let mut bodies = Vec::with_capacity(selected.len());
    for rule in &selected {
        if rule.body.trim().is_empty() {
            return Err(anyhow::Error::new(RemoteRunBundleError::RuleBodyEmpty {
                name: rule.name.clone(),
            }));
        }
        // Frozen exact bytes: only emptiness is checked, never trimmed.
        bodies.push(rule.body.clone());
    }
    Ok(Some(bodies.join("\n\n")))
}

fn validate_mcp_servers(servers: &BTreeMap<String, McpServerDefinition>) -> Result<()> {
    for (server, definition) in servers {
        if server.trim().is_empty() || server.chars().any(char::is_control) {
            return Err(mcp_invalid(server, "name"));
        }
        match definition {
            McpServerDefinition::Stdio {
                command,
                args,
                cwd,
                env,
            } => {
                if command.trim().is_empty()
                    || command.chars().any(char::is_control)
                    || contains_placeholders(command)
                {
                    return Err(mcp_invalid(server, "command"));
                }
                // A masked or credential-shaped literal is not a command.
                if is_secret_mask(command) || looks_token_like(command) {
                    return Err(mcp_secret(server, "command"));
                }
                // A key/value pair here is where a credential lives. A whole
                // `${NAME}` value is a reference the node resolves from its own
                // private environment; any other non-empty value is refused.
                validate_environment_values(server, "env", env.values())?;
                validate_args(server, args)?;
                if let Some(cwd) = cwd.as_deref() {
                    let cwd = cwd.trim();
                    if cwd.is_empty() || cwd.chars().any(char::is_control) {
                        return Err(mcp_invalid(server, "cwd"));
                    }
                    // A path that is absolute, drive-prefixed, backslash-separated
                    // or walks upwards is not portable to another host.
                    let traversal = cwd.contains('\\')
                        || cwd
                            .split('/')
                            .any(|segment| segment.is_empty() || segment == "." || segment == "..");
                    if traversal || is_absolute_path(cwd) {
                        return Err(anyhow::Error::new(
                            RemoteRunBundleError::McpCwdNotPortable {
                                server: server.clone(),
                            },
                        ));
                    }
                }
            }
            McpServerDefinition::StreamableHttp { url, headers } => {
                validate_url(server, url)?;
                validate_environment_values(server, "headers", headers.values())?;
            }
        }
    }
    Ok(())
}

/// Empty stays a literal empty value. A whole `${NAME}` value is a reference to
/// a name this bundle may carry; anything else is still a credential or a
/// partial interpolation and is refused rather than exported.
fn validate_environment_values<'a>(
    server: &str,
    field: &'static str,
    values: impl Iterator<Item = &'a String>,
) -> Result<()> {
    for value in values {
        if value.is_empty() {
            continue;
        }
        let Some(name) = value.strip_prefix("${").and_then(|rest| rest.strip_suffix('}')) else {
            return Err(mcp_secret(server, field));
        };
        if !valid_mcp_reference_name(name) {
            return Err(mcp_invalid(server, field));
        }
    }
    Ok(())
}

/// True when any selected server refers to a credential by name instead of
/// carrying a value. The capture needs this before it may call the projector,
/// because a projector resolves A's own environment.
pub(crate) fn selected_mcp_has_references(
    servers: &BTreeMap<String, McpServerDefinition>,
) -> bool {
    servers.values().any(|definition| match definition {
        McpServerDefinition::Stdio { env, .. } => env.values().any(|value| !value.is_empty()),
        McpServerDefinition::StreamableHttp { headers, .. } => {
            headers.values().any(|value| !value.is_empty())
        }
    })
}

/// Codex resolves `env_vars`/`env_http_headers` from the process environment, so
/// the reference dialect needs the version this contract was probed against.
pub(crate) fn codex_supports_mcp_references(reported_version: Option<&str>) -> bool {
    reported_version
        .and_then(crate::mcp_projection::parse_reported_version)
        .is_some_and(|version| version >= [0, 166, 0])
}

fn validate_args(server: &str, args: &[String]) -> Result<()> {
for arg in args {
        if arg.chars().any(char::is_control) || contains_placeholders(arg) || is_secret_mask(arg) {
            return Err(mcp_secret(server, "args"));
        }
        if let Some((flag, value)) = arg.split_once('=') {
            // A credential-named flag is refused even when its value looks
            // harmless. A harmless key-free `--flag=value` stays as it is.
            if is_secret_flag(flag) || looks_token_like(value) {
                return Err(mcp_secret(server, "args"));
            }
            continue;
        }
        // A trailing `--token` refuses on its own; this policy never waits to
        // see whether a following argument looks like a credential.
        if is_secret_flag(arg) || looks_token_like(arg) {
            return Err(mcp_secret(server, "args"));
        }
    }
    Ok(())
}

fn validate_url(server: &str, url: &str) -> Result<()> {
    let url = url.trim();
    if url.is_empty() || url.chars().any(char::is_control) || contains_placeholders(url) {
        return Err(mcp_secret(server, "url"));
    }
    let parsed = url::Url::parse(url).map_err(|_| mcp_invalid(server, "url"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(mcp_invalid(server, "url"));
    }
    // Credentials in the authority are never exported.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(mcp_secret(server, "url"));
    }
    // `query_pairs` yields percent-decoded keys, so an encoded `%74oken` cannot
    // slip past the credential check.
    for (key, value) in parsed.query_pairs() {
        if is_secret_flag(key.as_ref())
            || looks_token_like(key.as_ref())
            || looks_token_like(value.as_ref())
            || is_secret_mask(value.as_ref())
        {
            return Err(mcp_secret(server, "query"));
        }
    }
    Ok(())
}

fn mcp_secret(server: &str, field: &'static str) -> anyhow::Error {
    anyhow::Error::new(RemoteRunBundleError::McpSecretRefused {
        server: server.to_string(),
        field,
    })
}

fn mcp_invalid(server: &str, field: &'static str) -> anyhow::Error {
    anyhow::Error::new(RemoteRunBundleError::McpDefinitionInvalid {
        server: server.to_string(),
        field,
    })
}

fn is_absolute_path(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }
    let mut characters = value.chars();
    matches!(characters.next(), Some(letter) if letter.is_ascii_alphabetic())
        && characters.next() == Some(':')
}

/// The existing predicates live in the private redacted preview
/// (`run_projection.rs`) and are shaped for masking. This bounded copy is
/// intentionally stricter: it refuses instead of redacting, and it is the only
/// user of these names, so the preview and this export policy stay independent.
fn is_secret_flag(token: &str) -> bool {
    let flag = token.trim_start_matches('-').to_ascii_lowercase();
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
            | "authorization"
            | "bearer"
            | "key"
            | "sig"
            | "signature"
    ) || flag.ends_with("-token")
        || flag.ends_with("-key")
        || flag.ends_with("-secret")
        || flag.ends_with("-password")
}

fn looks_token_like(value: &str) -> bool {
    let value = value.trim();
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

fn is_secret_mask(value: &str) -> bool {
    value.trim() == SECRET_MASK
}

fn contains_placeholders(value: &str) -> bool {
    // `$${` is the established escape for a literal `${`; both forms are refused
    // here because either one still reaches a native process as a reference.
    value.contains("${")
}

/// Native hook settings: `{"hooks": {<Event>: [group, ...]}}` and nothing else.
///
/// Selected bodies are merged deterministically (sorted by name then id, then
/// their own order) and only command hooks survive. An unknown event, handler
/// type or key is a typed refusal, never a silent skip. An empty selection
/// produces no settings file at all.
fn hook_settings(adapter_kind: &str, hooks: &[ProjectedCapability]) -> Result<Option<Vec<u8>>> {
    if hooks.is_empty() {
        return Ok(None);
    }
    let mut selected = hooks.to_vec();
    selected.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    let mut merged = BTreeMap::<&'static str, Vec<Value>>::new();
    for hook in &selected {
        let parsed: Value = serde_json::from_str(hook.body.trim())
            .map_err(|_| RemoteRunBundleError::hook(&hook.name, "json"))?;
        let object = parsed
            .as_object()
            .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "object"))?;
        if object.len() != 1 || !object.contains_key("hooks") {
            return Err(RemoteRunBundleError::hook(&hook.name, "settings_keys"));
        }
        let events = object["hooks"]
            .as_object()
            .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "hooks_object"))?;
        if events.is_empty() {
            return Err(RemoteRunBundleError::hook(&hook.name, "hooks_empty"));
        }
        for (event, groups) in events {
            let canonical = SUPPORTED_HOOK_EVENTS
                .iter()
                .copied()
                .find(|supported| *supported == event.as_str())
                .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "event"))?;
            let groups = groups
                .as_array()
                .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "event_array"))?;
            if groups.is_empty() {
                return Err(RemoteRunBundleError::hook(&hook.name, "event_empty"));
            }
            for group in groups {
                let group = group
                    .as_object()
                    .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "group_object"))?;
                for key in group.keys() {
                    if !HOOK_GROUP_KEYS.contains(&key.as_str()) {
                        return Err(RemoteRunBundleError::hook(&hook.name, "group_key"));
                    }
                }
                if let Some(matcher) = group.get("matcher") {
                    let matcher = matcher
                        .as_str()
                        .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "matcher"))?;
                    if matcher.chars().any(char::is_control) {
                        return Err(RemoteRunBundleError::hook(&hook.name, "matcher"));
                    }
                }
                let handlers = group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "handlers"))?;
                if handlers.is_empty() {
                    return Err(RemoteRunBundleError::hook(&hook.name, "handlers_empty"));
                }
                for handler in handlers {
                    let handler = handler
                        .as_object()
                        .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "handler_object"))?;
                    for key in handler.keys() {
                        let allowed = matches!(key.as_str(), "type" | "command" | "timeout")
                            || (adapter_kind == ADAPTER_CODEX_CLI && key == "commandWindows");
                        if !allowed {
                            return Err(RemoteRunBundleError::hook(&hook.name, "handler_key"));
                        }
                    }
                    if handler.get("type").and_then(Value::as_str) != Some("command") {
                        return Err(RemoteRunBundleError::hook(&hook.name, "handler_type"));
                    }
                    let command = handler
                        .get("command")
                        .and_then(Value::as_str)
                        .ok_or_else(|| RemoteRunBundleError::hook(&hook.name, "command"))?;
                    if command.trim().is_empty()
                        || command.chars().any(char::is_control)
                        || is_secret_mask(command)
                    {
                        return Err(RemoteRunBundleError::hook(&hook.name, "command"));
                    }
                    if let Some(timeout) = handler.get("timeout") {
                        // Native ceilings this package accepts. Whether the
                        // installed CLI honours them stays the supervisor's
                        // launch-trust check, not this module's policy.
                        let ceiling =
                            if adapter_kind == ADAPTER_CODEX_CLI && canonical == "SessionEnd" {
                                3.0
                            } else {
                                600.0
                            };
                        let accepted = timeout.as_f64().is_some_and(|value| {
                            value.is_finite() && value > 0.0 && value <= ceiling
                        });
                        if !accepted {
                            return Err(RemoteRunBundleError::hook(&hook.name, "timeout"));
                        }
                    }
                    if let Some(windows) = handler.get("commandWindows") {
                        let windows = windows.as_str().ok_or_else(|| {
                            RemoteRunBundleError::hook(&hook.name, "command_windows")
                        })?;
                        if windows.trim().is_empty() || windows.chars().any(char::is_control) {
                            return Err(RemoteRunBundleError::hook(&hook.name, "command_windows"));
                        }
                    }
                }
                merged
                    .entry(canonical)
                    .or_default()
                    .push(Value::Object(group.clone()));
            }
        }
    }
    if merged.is_empty() {
        // Unreachable while every event must carry a group; kept as a guard so a
        // future allowlist change cannot silently produce an empty settings file.
        return Ok(None);
    }
    let mut events = Map::new();
    for (event, groups) in merged {
        events.insert(event.to_string(), Value::Array(groups));
    }
    let mut settings = Map::new();
    settings.insert("hooks".to_string(), Value::Object(events));
    serde_json::to_vec(&Value::Object(settings))
        .map(Some)
        .map_err(|_| RemoteRunBundleError::invalid("hook_settings"))
}

#[cfg(test)]
mod tests {
    //! Owners here are the ones the supervisor's glue cannot cover: which
    //! frozen inputs reach each runtime-native document, and which inputs are
    //! refused instead of exported.
    //!
    //! Admission (docs/development/testing.md): the owner is the pure builder;
    //! before it existed nothing produced a bundle, so each case below is an
    //! independent failure (skills/rules placement, codex vs claude document,
    //! hook merge, secret refusal); the adjacent `run_projection`/
    //! `member_capability` owners require a database and materialized store and
    //! cannot assert bundle bytes or export refusal; the owner is a pure unit
    //! test over synthetic bytes, so no database, process, environment or real
    //! CLI is needed.

    use super::*;

    fn capability(id: &str, name: &str, body: &str) -> ProjectedCapability {
        ProjectedCapability {
            id: id.to_string(),
            name: name.to_string(),
            body: body.to_string(),
            origin: "explicit".to_string(),
        }
    }

    fn stdio(command: &str) -> McpServerDefinition {
        McpServerDefinition::Stdio {
            command: command.to_string(),
            args: vec!["serve".to_string()],
            cwd: None,
            env: BTreeMap::new(),
        }
    }

    fn skill_index(name: &str) -> SkillIndexEntry {
        SkillIndexEntry {
            name: name.to_string(),
            desc: format!("desc of {name}"),
        }
    }

    fn skill_file(name: &str, relative_path: &str, content: &[u8]) -> SkillFileSource {
        SkillFileSource {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            content: content.to_vec(),
        }
    }

    struct Fixture<'a> {
        adapter_kind: AdapterKind,
        bootstrap: &'a str,
        selected_skills: &'a [SkillFileSource],
        platform_skill_index: &'a [SkillIndexEntry],
        skill_index: &'a [SkillIndexEntry],
        mcp_servers: &'a BTreeMap<String, McpServerDefinition>,
        rules: &'a [ProjectedCapability],
        hooks: &'a [ProjectedCapability],
    }

    impl<'a> Fixture<'a> {
        fn request(self) -> RunBundleBuildRequest<'a> {
            RunBundleBuildRequest {
                run_id: "run_ab12cd",
                attempt: 1,
                agent_id: "agent_1",
                adapter_kind: self.adapter_kind,
                selection_revision: "rev_7",
                source_skill_root: "/srv/rovai/skills",
                bootstrap: self.bootstrap,
                selected_skills: self.selected_skills,
                platform_skill_index: self.platform_skill_index,
                skill_index: self.skill_index,
                mcp_servers: self.mcp_servers,
                rules: self.rules,
                hooks: self.hooks,
            }
        }
    }

    fn empty_fixture(adapter_kind: AdapterKind, bootstrap: &str) -> Fixture<'_> {
        Fixture {
            adapter_kind,
            bootstrap,
            selected_skills: &[],
            platform_skill_index: &[],
            skill_index: &[],
            mcp_servers: &EMPTY_SERVERS,
            rules: &[],
            hooks: &[],
        }
    }

    static EMPTY_SERVERS: BTreeMap<String, McpServerDefinition> = BTreeMap::new();

    fn decoded(bundle: &RunBundleV1, artifact: BundleArtifact) -> Vec<u8> {
        let file = bundle
            .files
            .iter()
            .find(|file| file.artifact == artifact)
            .unwrap_or_else(|| panic!("missing artifact {artifact:?}"));
        loom_protocol::run_bundle::decode_file(file).expect("decodable file")
    }

    fn text(bundle: &RunBundleV1, artifact: BundleArtifact) -> String {
        String::from_utf8(decoded(bundle, artifact)).expect("utf-8 file")
    }

    const BOOTSTRAP: &str = "[SESSION_CHARTER]\ncharter\n[/SESSION_CHARTER]\n\n[MEMBER_IDENTITY]\n{}\n[/MEMBER_IDENTITY]";

    /// The two mandatory platform skills, as the existing renderer indexes them.
    fn platform_entries() -> Vec<SkillIndexEntry> {
        vec![
            skill_index("cli-operations"),
            skill_index("memory-stewardship"),
        ]
    }

    fn platform_files() -> Vec<SkillFileSource> {
        vec![
            skill_file("cli-operations", "SKILL.md", b"# cli-operations\n"),
            skill_file("memory-stewardship", "SKILL.md", b"# memory-stewardship\n"),
        ]
    }

    /// A bootstrap that already carries the platform index the renderer writes.
    fn bootstrap_with_platform(entries: &[SkillIndexEntry], root: &str) -> String {
        let json = serde_json::to_string(&SkillIndex {
            root,
            skills: entries,
        })
        .expect("platform index json");
        format!("{BOOTSTRAP}\n\n[ROVAI_PLATFORM_SKILLS]\n{json}\n[/ROVAI_PLATFORM_SKILLS]")
    }

    #[test]
    fn claude_bundle_appends_selected_skills_and_rules_to_the_frozen_bootstrap() {
        let skills = vec![skill_file("campfire", "SKILL.md", b"# campfire\n")];
        let index = vec![skill_index("campfire")];
        let rules = vec![capability("rule_1", "Be brief", "Prefer short answers.")];
        let servers = BTreeMap::from([("docs".to_string(), stdio("docs-mcp"))]);

        let bundle = build_remote_run_bundle(
            &Fixture {
                rules: &rules,
                ..Fixture {
                    selected_skills: &skills,
                    skill_index: &index,
                    mcp_servers: &servers,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
                }
            }
            .request(),
        )
        .expect("bundle");

        assert_eq!(bundle.adapter_kind, "claude-code");
        assert_eq!(bundle.bundle_id, "run_ab12cd-1");
        assert_eq!(
            bundle.source_skill_root.as_deref(),
            Some("/srv/rovai/skills")
        );
        // Canonical order: bootstrap, mcp, skills.
        assert_eq!(
            bundle
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["bootstrap.txt", "mcp.json", "skills/campfire/SKILL.md"]
        );

        let instructions = text(&bundle, BundleArtifact::BootstrapPrompt);
        assert!(instructions.starts_with(BOOTSTRAP));
        assert!(instructions.contains(
            "[ROVAI_ADDITIONAL_SKILLS]\nCurrent for this run; replaces any earlier Rovai Additional Skills.\n\
             {\"root\":\"/srv/rovai/skills\",\"skills\":[{\"name\":\"campfire\",\"desc\":\"desc of campfire\"}]}\n\
             [/ROVAI_ADDITIONAL_SKILLS]"
        ));
        // Rule text reaches the model, outside every marker.
        assert!(instructions.ends_with("[/ROVAI_ADDITIONAL_SKILLS]\n\nPrefer short answers."));
        assert_eq!(instructions.matches("[ROVAI_ADDITIONAL_SKILLS]").count(), 1);

        // The MCP document is the established Claude helper, unchanged.
        let expected = serde_json::to_vec(&additive_mcp_config_document(&servers)).unwrap();
        assert_eq!(decoded(&bundle, BundleArtifact::McpConfig), expected);
        // No hooks selected: no settings file at all.
        assert!(
            !bundle
                .files
                .iter()
                .any(|file| file.artifact == BundleArtifact::RuntimeSettings)
        );

        // Identical frozen inputs produce an identical bundle and digest.
        let again = build_remote_run_bundle(
            &Fixture {
                rules: &rules,
                ..Fixture {
                    selected_skills: &skills,
                    skill_index: &index,
                    mcp_servers: &servers,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
                }
            }
            .request(),
        )
        .expect("bundle");
        assert_eq!(again, bundle);
        assert_eq!(again.digest, bundle.digest);

        // Rule bodies are frozen byte for byte; only emptiness is checked.
        let spaced_rules = vec![capability("rule_2", "Spaced", "  line one\n\nline two  ")];
        let spaced = build_remote_run_bundle(
            &Fixture {
                rules: &spaced_rules,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        )
        .expect("bundle");
        let spaced_text = text(&spaced, BundleArtifact::BootstrapPrompt);
        assert!(spaced_text.ends_with("\n\n  line one\n\nline two  "));
        assert!(!spaced_text.ends_with("line two\n"));
    }

    #[test]
    fn codex_bundle_carries_the_session_config_document() {
        let servers = BTreeMap::from([("docs".to_string(), stdio("docs-mcp"))]);
        let bundle = build_remote_run_bundle(
            &Fixture {
                mcp_servers: &servers,
                ..empty_fixture(AdapterKind::CodexCli, BOOTSTRAP)
            }
            .request(),
        )
        .expect("bundle");
        assert_eq!(bundle.adapter_kind, "codex-cli");
        let document: Value = serde_json::from_slice(&decoded(&bundle, BundleArtifact::McpConfig))
            .expect("json document");
        assert_eq!(
            document.pointer("/mcp_servers/docs/command"),
            Some(&Value::String("docs-mcp".to_string()))
        );
        assert!(document.get("mcpServers").is_none());
        assert!(bundle.source_skill_root.is_none());
    }

    #[test]
    fn a_referencing_server_carries_its_native_names_and_no_value() {
        let mut referencing = stdio("docs-mcp");
        if let McpServerDefinition::Stdio { env, .. } = &mut referencing {
            env.insert("DOCS_TOKEN".to_string(), "${DOCS_TOKEN}".to_string());
        }
        let remote = McpServerDefinition::StreamableHttp {
            url: "https://example.test/mcp".to_string(),
            headers: BTreeMap::from([(
                "Authorization".to_string(),
                "${DOCS_TOKEN}".to_string(),
            )]),
        };
        let servers = BTreeMap::from([
            ("docs".to_string(), referencing),
            ("remote".to_string(), remote),
        ]);
        let bundle = build_remote_run_bundle(
            &Fixture {
                mcp_servers: &servers,
                ..empty_fixture(AdapterKind::CodexCli, BOOTSTRAP)
            }
            .request(),
        )
        .expect("bundle");
        assert_eq!(bundle.version, RUN_BUNDLE_REFERENCE_VERSION);
        let bytes = decoded(&bundle, BundleArtifact::McpConfig);
        let document: Value = serde_json::from_slice(&bytes).expect("json document");
        assert_eq!(
            document.pointer("/mcp_servers/docs/env_vars/0"),
            Some(&Value::String("DOCS_TOKEN".to_string()))
        );
        assert_eq!(
            document.pointer("/mcp_servers/remote/env_http_headers/Authorization"),
            Some(&Value::String("DOCS_TOKEN".to_string()))
        );
        // The value never reaches the document, in any form.
        assert!(document.pointer("/mcp_servers/docs/env").is_none());
        assert!(document.pointer("/mcp_servers/remote/http_headers").is_none());
        assert!(!String::from_utf8_lossy(&bytes).contains("${"));
        let references = mcp_environment_references(&bundle).expect("references");
        assert_eq!(references.len(), 2);
        assert!(references.iter().all(|reference| reference.variable == "DOCS_TOKEN"));
    }

    #[test]
    fn selected_hooks_become_one_native_settings_file_and_bad_hooks_are_refused() {
        let hooks = vec![
            capability(
                "hook_b",
                "stop-check",
                r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"format.sh","timeout":30}]}]}}"#,
            ),
            capability(
                "hook_a",
                "guard",
                r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"guard.sh"}]}]}}"#,
            ),
        ];
        let bundle = build_remote_run_bundle(
            &Fixture {
                hooks: &hooks,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        )
        .expect("bundle");
        let settings: Value =
            serde_json::from_slice(&decoded(&bundle, BundleArtifact::RuntimeSettings))
                .expect("settings json");
        assert_eq!(
            settings
                .as_object()
                .expect("object")
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["hooks"]
        );
        let events = settings["hooks"].as_object().expect("hooks object");
        assert_eq!(
            events.keys().map(String::as_str).collect::<Vec<_>>(),
            ["PreToolUse", "Stop"]
        );
        assert_eq!(events["PreToolUse"][0]["matcher"], "Bash");
        assert_eq!(events["PreToolUse"][0]["hooks"][0]["command"], "guard.sh");
        assert_eq!(events["Stop"][0]["hooks"][0]["timeout"], 30);

        let cases = [
            // Unknown native event.
            r#"{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"x"}]}]}}"#,
            // Handler that is not a command hook.
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"prompt","command":"x"}]}]}}"#,
            // Key outside the allowlist.
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x","env":{"A":"1"}}]}]}}"#,
            // Matcher group key outside the allowlist.
            r#"{"hooks":{"Stop":[{"timeout":5,"hooks":[{"type":"command","command":"x"}]}]}}"#,
            // A settings document may carry nothing but hooks.
            r#"{"hooks":{},"env":{"A":"1"}}"#,
            // No events at all.
            r#"{"hooks":{}}"#,
            // Empty command and empty event array.
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"  "}]}]}}"#,
            r#"{"hooks":{"Stop":[]}}"#,
            // Not JSON, an empty hook group, and a handler without a type.
            "not json",
            r#"{"hooks":{"Stop":[{"hooks":[]}]}}"#,
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"x"}]}]}}"#,
        ];
        for body in cases {
            let hooks = vec![capability("hook_x", "bad-hook", body)];
            let error = build_remote_run_bundle(
                &Fixture {
                    hooks: &hooks,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
                }
                .request(),
            )
            .expect_err("hook body was accepted");
            assert_eq!(
                error
                    .downcast_ref::<RemoteRunBundleError>()
                    .expect("typed error")
                    .code(),
                "bundle_hook_invalid",
                "{body}"
            );
            // The refusal names the code and a field, never the body content.
            let rendered = format!("{error:#}");
            assert!(
                rendered.starts_with("bundle_hook_invalid"),
                "{rendered} for {body}"
            );
            assert!(!rendered.contains("format.sh"), "{rendered}");
        }

        // `commandWindows` is a Codex-only extension.
        let windows_hook = vec![capability(
            "hook_w",
            "windows-hook",
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"format.sh","commandWindows":"format.cmd"}]}]}}"#,
        )];
        let claude = build_remote_run_bundle(
            &Fixture {
                hooks: &windows_hook,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        );
        assert!(claude.is_err());
        let codex = build_remote_run_bundle(
            &Fixture {
                hooks: &windows_hook,
                ..empty_fixture(AdapterKind::CodexCli, BOOTSTRAP)
            }
            .request(),
        )
        .expect("codex accepts commandWindows");
        let settings: Value =
            serde_json::from_slice(&decoded(&codex, BundleArtifact::RuntimeSettings)).unwrap();
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["commandWindows"],
            "format.cmd"
        );

        // Timeout ceilings: 600 generally, 3 for a Codex SessionEnd hook.
        let over_ceiling = vec![capability(
            "hook_t",
            "long-stop",
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x.sh","timeout":601}]}]}}"#,
        )];
        for adapter in [AdapterKind::ClaudeCodeCli, AdapterKind::CodexCli] {
            let refused = build_remote_run_bundle(
                &Fixture {
                    hooks: &over_ceiling,
                    ..empty_fixture(adapter, BOOTSTRAP)
                }
                .request(),
            )
            .expect_err("timeout above the ceiling was accepted");
            assert_eq!(
                refused
                    .downcast_ref::<RemoteRunBundleError>()
                    .expect("typed error")
                    .code(),
                "bundle_hook_invalid"
            );
        }
        let session_end = |seconds: u32| {
            vec![capability(
                "hook_s",
                "session-end",
                &format!(
                    r#"{{"hooks":{{"SessionEnd":[{{"hooks":[{{"type":"command","command":"bye.sh","timeout":{seconds}}}]}}]}}}}"#
                ),
            )]
        };
        let claude_session_end = session_end(10);
        assert!(
            build_remote_run_bundle(
                &Fixture {
                    hooks: &claude_session_end,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
                }
                .request(),
            )
            .is_ok()
        );
        let too_long_session_end = session_end(4);
        assert!(
            build_remote_run_bundle(
                &Fixture {
                    hooks: &too_long_session_end,
                    ..empty_fixture(AdapterKind::CodexCli, BOOTSTRAP)
                }
                .request(),
            )
            .is_err()
        );
        let allowed_session_end = session_end(3);
        assert!(
            build_remote_run_bundle(
                &Fixture {
                    hooks: &allowed_session_end,
                    ..empty_fixture(AdapterKind::CodexCli, BOOTSTRAP)
                }
                .request(),
            )
            .is_ok()
        );
    }

    #[test]
    fn mcp_secrets_placeholders_and_nonportable_cwd_are_refused_without_values() {
        fn http(url: &str, headers: &[(&str, &str)]) -> McpServerDefinition {
            McpServerDefinition::StreamableHttp {
                url: url.to_string(),
                headers: headers
                    .iter()
                    .map(|(name, value)| (name.to_string(), value.to_string()))
                    .collect(),
            }
        }
        let cases: Vec<(McpServerDefinition, &str)> = vec![
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec![],
                    cwd: None,
                    env: BTreeMap::from([("API_TOKEN".into(), "super-secret-value".into())]),
                },
                "bundle_mcp_secret_refused",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec!["--token".into(), "sk-live-value".into()],
                    cwd: None,
                    env: BTreeMap::new(),
                },
                "bundle_mcp_secret_refused",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec!["--api-key=plain-looking-value".into()],
                    cwd: None,
                    env: BTreeMap::new(),
                },
                "bundle_mcp_secret_refused",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec!["${DOCS_TOKEN}".into()],
                    cwd: None,
                    env: BTreeMap::new(),
                },
                "bundle_mcp_secret_refused",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec!["********".into()],
                    cwd: None,
                    env: BTreeMap::new(),
                },
                "bundle_mcp_secret_refused",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec![],
                    cwd: Some("/Users/echo/project".into()),
                    env: BTreeMap::new(),
                },
                "bundle_mcp_cwd_not_portable",
            ),
            (
                http("https://user:pass@example.test/mcp", &[]),
                "bundle_mcp_secret_refused",
            ),
            (
                http("https://example.test/mcp?token=abcdef0123456789", &[]),
                "bundle_mcp_secret_refused",
            ),
            (
                http(
                    "https://example.test/mcp",
                    &[("Authorization", "Bearer fixture-secret")],
                ),
                "bundle_mcp_secret_refused",
            ),
            // A trailing credential flag refuses without a value to inspect.
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec!["serve".into(), "--token".into()],
                    cwd: None,
                    env: BTreeMap::new(),
                },
                "bundle_mcp_secret_refused",
            ),
            // A percent-encoded query key is decoded before the check.
            (
                http("https://example.test/mcp?%74oken=abcdef0123456789", &[]),
                "bundle_mcp_secret_refused",
            ),
            // Masked and credential-shaped commands are not commands.
            (
                McpServerDefinition::Stdio {
                    command: "********".into(),
                    args: vec![],
                    cwd: None,
                    env: BTreeMap::new(),
                },
                "bundle_mcp_secret_refused",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "ghp_fixturefixturefixture".into(),
                    args: vec![],
                    cwd: None,
                    env: BTreeMap::new(),
                },
                "bundle_mcp_secret_refused",
            ),
            // Relative but non-portable working directories.
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec![],
                    cwd: Some("../outside".into()),
                    env: BTreeMap::new(),
                },
                "bundle_mcp_cwd_not_portable",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec![],
                    cwd: Some("./docs".into()),
                    env: BTreeMap::new(),
                },
                "bundle_mcp_cwd_not_portable",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec![],
                    cwd: Some("docs\\win".into()),
                    env: BTreeMap::new(),
                },
                "bundle_mcp_cwd_not_portable",
            ),
            (
                McpServerDefinition::Stdio {
                    command: "docs".into(),
                    args: vec![],
                    cwd: Some("C:docs".into()),
                    env: BTreeMap::new(),
                },
                "bundle_mcp_cwd_not_portable",
            ),
        ];
        for (definition, expected) in cases {
            let servers = BTreeMap::from([("docs".to_string(), definition)]);
            let error = build_remote_run_bundle(
                &Fixture {
                    mcp_servers: &servers,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
                }
                .request(),
            )
            .expect_err("definition was exported");
            let typed = error
                .downcast_ref::<RemoteRunBundleError>()
                .expect("typed error");
            assert_eq!(typed.code(), expected);
            let rendered = format!("{error:#}");
            for secret in [
                "super-secret-value",
                "sk-live-value",
                "plain-looking-value",
                "user:pass",
                "abcdef0123456789",
                "fixture-secret",
                "ghp_fixturefixturefixture",
                "DOCS_TOKEN",
            ] {
                assert!(!rendered.contains(secret), "{rendered} leaked {secret}");
            }
        }

        // Key-free literal definitions stay exactly as they are, including a
        // harmless `--flag=value` argument and a portable relative directory.
        let servers = BTreeMap::from([
            ("docs".to_string(), stdio("docs-mcp")),
            (
                "local".to_string(),
                McpServerDefinition::Stdio {
                    command: "node".to_string(),
                    args: vec!["server.js".to_string(), "--transport=stdio".to_string()],
                    cwd: Some("mcp/docs".to_string()),
                    env: BTreeMap::new(),
                },
            ),
            ("remote".to_string(), http("https://example.test/mcp", &[])),
        ]);
        let bundle = build_remote_run_bundle(
            &Fixture {
                mcp_servers: &servers,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        )
        .expect("bundle");
        let document = text(&bundle, BundleArtifact::McpConfig);
        assert!(document.contains("docs-mcp"));
        assert!(document.contains("https://example.test/mcp"));
        assert!(document.contains("--transport=stdio"));
        assert!(document.contains("mcp/docs"));
        assert!(!document.contains("********"));
    }

    #[test]
    fn fully_empty_optional_selections_emit_only_the_bootstrap() {
        let bundle = build_remote_run_bundle(
            &empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP).request(),
        )
        .expect("bundle");
        assert_eq!(bundle.files.len(), 1);
        assert_eq!(bundle.files[0].artifact, BundleArtifact::BootstrapPrompt);
        assert_eq!(text(&bundle, BundleArtifact::BootstrapPrompt), BOOTSTRAP);
        assert!(bundle.source_skill_root.is_none());
        loom_protocol::run_bundle::validate(
            &bundle,
            &BundleExpectation {
                run_id: "run_ab12cd",
                attempt: 1,
                adapter_kind: "claude-code",
            },
        )
        .expect("valid bundle");

        // The two mandatory platform skills are the only assets a Run gets with
        // no optional selection: their files ride along, their index stays in the
        // bootstrap bytes, and no additional-skills section appears.
        let platform = platform_entries();
        let files = platform_files();
        let bootstrap = bootstrap_with_platform(&platform, "/srv/rovai/skills");
        let mandatory = build_remote_run_bundle(
            &Fixture {
                selected_skills: &files,
                platform_skill_index: &platform,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, &bootstrap)
            }
            .request(),
        )
        .expect("mandatory-only bundle");
        assert_eq!(
            mandatory
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            [
                "bootstrap.txt",
                "skills/cli-operations/SKILL.md",
                "skills/memory-stewardship/SKILL.md"
            ]
        );
        let instructions = text(&mandatory, BundleArtifact::BootstrapPrompt);
        assert_eq!(instructions, bootstrap);
        assert!(!instructions.contains("[ROVAI_ADDITIONAL_SKILLS]"));
        assert!(!mandatory.files.iter().any(|file| matches!(
            file.artifact,
            BundleArtifact::McpConfig | BundleArtifact::RuntimeSettings
        )));
        assert_eq!(
            mandatory.source_skill_root.as_deref(),
            Some("/srv/rovai/skills")
        );
    }

    #[test]
    fn skill_index_and_files_must_describe_the_same_selection() {
        let index = vec![skill_index("campfire")];
        let missing_file = build_remote_run_bundle(
            &Fixture {
                skill_index: &index,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        );
        assert_eq!(
            missing_file
                .expect_err("index without files")
                .downcast_ref::<RemoteRunBundleError>()
                .expect("typed error")
                .code(),
            "bundle_skill_selection_mismatch"
        );

        let stray_file = vec![skill_file("grill-duo", "SKILL.md", b"# grill-duo")];
        let unindexed = build_remote_run_bundle(
            &Fixture {
                selected_skills: &stray_file,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        );
        assert_eq!(
            unindexed
                .expect_err("files without index")
                .downcast_ref::<RemoteRunBundleError>()
                .expect("typed error")
                .code(),
            "bundle_skill_selection_mismatch"
        );

        // A skill the model is told about must carry its entry file.
        let references_only = vec![skill_file("campfire", "references/intro.md", b"x")];
        let no_entry = build_remote_run_bundle(
            &Fixture {
                selected_skills: &references_only,
                skill_index: &index,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        );
        assert_eq!(
            no_entry
                .expect_err("skill without SKILL.md")
                .downcast_ref::<RemoteRunBundleError>()
                .expect("typed error")
                .code(),
            "bundle_skill_selection_mismatch"
        );

        // The mandatory platform set must be exactly the one the bootstrap froze.
        let platform = platform_entries();
        let files = platform_files();
        let bootstrap = bootstrap_with_platform(&platform, "/srv/rovai/skills");
        assert!(
            build_remote_run_bundle(
                &Fixture {
                    selected_skills: &files,
                    platform_skill_index: &platform,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, &bootstrap)
                }
                .request(),
            )
            .is_ok()
        );
        let other_root = bootstrap_with_platform(&platform, "/elsewhere/skills");
        assert_eq!(
            build_remote_run_bundle(
                &Fixture {
                    selected_skills: &files,
                    platform_skill_index: &platform,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, &other_root)
                }
                .request(),
            )
            .expect_err("platform root mismatch")
            .downcast_ref::<RemoteRunBundleError>()
            .expect("typed error")
            .code(),
            "bundle_platform_skill_mismatch"
        );
        assert_eq!(
            build_remote_run_bundle(
                &Fixture {
                    selected_skills: &files,
                    platform_skill_index: &platform,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
                }
                .request(),
            )
            .expect_err("missing platform block")
            .downcast_ref::<RemoteRunBundleError>()
            .expect("typed error")
            .code(),
            "bundle_platform_skill_mismatch"
        );
        // Only the fixed platform set may be mandatory.
        let wrong_platform = vec![skill_index("campfire")];
        let wrong_files = vec![skill_file("campfire", "SKILL.md", b"# campfire")];
        assert_eq!(
            build_remote_run_bundle(
                &Fixture {
                    selected_skills: &wrong_files,
                    platform_skill_index: &wrong_platform,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, &bootstrap)
                }
                .request(),
            )
            .expect_err("non-platform mandatory skill")
            .downcast_ref::<RemoteRunBundleError>()
            .expect("typed error")
            .code(),
            "bundle_skill_selection_mismatch"
        );
        // An optional checkbox can never claim a platform name.
        let reserved = vec![skill_index("cli-operations")];
        let reserved_files = vec![skill_file(
            "cli-operations",
            "SKILL.md",
            b"# cli-operations",
        )];
        assert_eq!(
            build_remote_run_bundle(
                &Fixture {
                    selected_skills: &reserved_files,
                    skill_index: &reserved,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, &bootstrap)
                }
                .request(),
            )
            .expect_err("optional platform name")
            .downcast_ref::<RemoteRunBundleError>()
            .expect("typed error")
            .code(),
            "bundle_skill_name_reserved"
        );
        // An unselected third file that no index describes is still refused.
        let platform_plus_stray = vec![
            skill_file("cli-operations", "SKILL.md", b"# cli-operations"),
            skill_file("memory-stewardship", "SKILL.md", b"# memory-stewardship"),
            skill_file("campfire", "SKILL.md", b"# campfire"),
        ];
        assert_eq!(
            build_remote_run_bundle(
                &Fixture {
                    selected_skills: &platform_plus_stray,
                    platform_skill_index: &platform,
                    ..empty_fixture(AdapterKind::ClaudeCodeCli, &bootstrap)
                }
                .request(),
            )
            .expect_err("unindexed third file")
            .downcast_ref::<RemoteRunBundleError>()
            .expect("typed error")
            .code(),
            "bundle_skill_selection_mismatch"
        );
    }

    #[test]
    fn a_selected_rule_with_an_empty_body_is_refused() {
        let rules = vec![capability("rule_empty", "Empty", "   ")];
        let error = build_remote_run_bundle(
            &Fixture {
                rules: &rules,
                ..empty_fixture(AdapterKind::ClaudeCodeCli, BOOTSTRAP)
            }
            .request(),
        )
        .expect_err("empty rule body was accepted");
        assert_eq!(
            error
                .downcast_ref::<RemoteRunBundleError>()
                .expect("typed error")
                .code(),
            "bundle_rule_body_empty"
        );
    }

    #[test]
    fn an_unsupported_runtime_is_a_typed_refusal() {
        let error = build_remote_run_bundle(&empty_fixture(AdapterKind::Pi, BOOTSTRAP).request())
            .expect_err("runtime without a bundle contract was accepted");
        assert_eq!(
            error
                .downcast_ref::<RemoteRunBundleError>()
                .expect("typed error")
                .code(),
            "bundle_runtime_unsupported"
        );
    }
}
