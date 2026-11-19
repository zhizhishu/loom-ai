//! Authenticated, read-only catalog of the four admitted native client programs
//! and the native Skills / MCP servers / Rules / Hooks they declare.
//!
//! Boundaries this module keeps:
//!
//! * It never writes, mutates, links, deletes or copies a native file, and it
//!   creates no second registry. It is a projection of files that already exist.
//! * It never executes a hook, an MCP command, a Runtime or a version probe.
//!   Hook bodies are described, never run; MCP bodies are never returned.
//! * It reads only the discovery home handed to it by the Host
//!   (`LOOM_NATIVE_DISCOVERY_HOME`, read once at start-up) plus the workspace
//!   Core resolves for an explicit `threadId`. A caller cannot supply a path.
//! * No secret value, URL query, userinfo, command argument or environment
//!   value leaves this module.

mod import;
mod parse;
mod scan;
#[cfg(test)]
mod tests;

use crate::auth::Session;
use crate::{WebState, error};
use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Extension,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rovai_core::application::CoreService;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Wire contract for this surface. Bumped only with an incompatible change.
pub(crate) const PROTOCOL_VERSION: u32 = 1;
/// Host configuration read exactly once. When it is absent the surface is
/// unavailable (503) rather than falling back to a guessed directory.
pub(crate) const HOME_ENV: &str = "LOOM_NATIVE_DISCOVERY_HOME";
/// Owner switch for the DSH live source mode. Frozen at start-up, default off.
pub(crate) const DSH_SOURCE_MODE_ENV: &str = "LOOM_NATIVE_DSH_SOURCE_MODE";
/// The one DSH value this build understands: `dsh-claude` `sourceMode: live`.
pub(crate) const DSH_CLAUDE_LIVE: &str = "claude-live";
/// Rule and hook preview budget, in characters.
pub(crate) const PREVIEW_CHARS: usize = 8000;
const MAX_THREAD_ID: usize = 80;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PATH_ENV_ENTRIES: usize = 256;

/// One admitted discovery home. The environment is read once in [`Self::from_env`];
/// per-request admission is a metadata check of that same value, never a re-read
/// of configuration and never a caller-supplied path.
pub(crate) struct NativeDiscovery {
    root: Option<PathBuf>,
    /// `LOOM_NATIVE_DSH_SOURCE_MODE=claude-live`; frozen here at start-up.
    dsh_claude_live: bool,
}

impl NativeDiscovery {
    pub(crate) fn from_env() -> Self {
        let root = std::env::var_os(HOME_ENV).map(PathBuf::from);
        let dsh_claude_live = std::env::var_os(DSH_SOURCE_MODE_ENV)
            .map(|value| value.to_string_lossy().trim().eq_ignore_ascii_case(DSH_CLAUDE_LIVE))
            .unwrap_or(false);
        Self {
            root,
            dsh_claude_live,
        }
    }

    /// Explicit construction for the Host and for tests: the same admission
    /// rules apply, so a supervisor-supplied value is checked identically.
    pub(crate) fn admitted(root: PathBuf) -> Result<Self> {
        Self::admitted_with_dsh_source(root, false)
    }

    pub(crate) fn admitted_with_dsh_source(root: PathBuf, dsh_claude_live: bool) -> Result<Self> {
        let candidate = Self {
            root: Some(root),
            dsh_claude_live,
        };
        candidate.home().map_err(anyhow::Error::msg)?;
        Ok(candidate)
    }

    /// True when the owner declared that DSH consumes the Claude source tree.
    pub(crate) fn dsh_claude_live(&self) -> bool {
        self.dsh_claude_live
    }

    /// The admitted home, or the stable code explaining why it is unavailable.
    pub(crate) fn home(&self) -> std::result::Result<&Path, &'static str> {
        let Some(root) = self.root.as_deref() else {
            return Err("discovery_home_required");
        };
        if !root.is_absolute() {
            return Err("discovery_home_invalid");
        }
        let metadata = std::fs::symlink_metadata(root).map_err(|_| "discovery_home_invalid")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("discovery_home_invalid");
        }
        Ok(root)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogRequest {
    /// Optional thread. Core resolves its workspace; no path is accepted here.
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewRequest {
    pub source_id: String,
    pub expected_digest: String,
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogResponse {
    pub protocol_version: u32,
    /// Unix epoch milliseconds; this crate carries no date library.
    pub generated_at: u64,
    pub home: HomeView,
    pub programs: Vec<ProgramView>,
    pub items: Vec<CatalogItem>,
    pub errors: Vec<DiscoveryError>,
    pub truncated: TruncationView,
    /// Additive: one diagnostic row per admitted source. Clients that predate
    /// it ignore the field; nothing above is renamed or removed.
    pub sources: Vec<SourceView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeView {
    pub root: String,
    pub admitted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgramView {
    pub kind: String,
    pub label: String,
    pub detected: bool,
    /// `installation-record`, `path-metadata` or `absent`. Evidence kinds stay
    /// distinguishable: a PATH hit is not an installed or started Runtime.
    pub evidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogItem {
    pub kind: String,
    pub runtime: String,
    pub name: String,
    /// Bounded SKILL.md `description` frontmatter value, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source_id: String,
    pub source_path: String,
    /// Explicit `SKILL.md` path for Skill items; `sourcePath` is the root folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_path: Option<String>,
    pub digest: String,
    pub source_scope: String,
    /// Kept explicit: every item here is native-only, never a LOOM definition.
    pub compatibility: String,
    /// Set when this runtime consumes another client's file (Pi/DSH live mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_source: Option<String>,
    pub importable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import: Option<ImportView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked: Option<MaskedView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook: Option<HookView>,
    /// Internal re-read target for preview; never serialized.
    #[serde(skip)]
    pub(crate) file: PathBuf,
    #[serde(skip)]
    pub(crate) locate: Locate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportView {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaskedView {
    pub command: String,
    pub args_count: usize,
    pub env_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_origin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookView {
    pub event: String,
    /// Always false: this surface describes a hook, it never runs one.
    pub executed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryError {
    pub scope: String,
    pub runtime: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl DiscoveryError {
    pub(crate) fn new(
        scope: &str,
        runtime: &str,
        code: &str,
        detail: Option<String>,
    ) -> Self {
        Self {
            scope: scope.to_owned(),
            runtime: runtime.to_owned(),
            code: code.to_owned(),
            detail,
        }
    }
}

/// One diagnostic row per admitted source, so a caller can tell an empty
/// runtime apart from a refused, unreadable, truncated or already-visited one.
///
/// A row carries only metadata this scan already admitted: a display path, a
/// stable status word and a stable reason code. It never carries file content,
/// a secret value, a command line or an environment value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceView {
    pub runtime: String,
    pub scope: String,
    pub kind: String,
    pub path: String,
    /// `read`, `absent`, `refused`, `unreadable`, `skipped` or `truncated`.
    pub status: String,
    pub items: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_source: Option<String>,
    /// True for a Pi root taken from `settings.json`, false for its default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

impl SourceView {
    pub(crate) fn new(
        runtime: &str,
        scope: &str,
        kind: &str,
        path: String,
        status: &str,
    ) -> Self {
        Self {
            runtime: runtime.to_owned(),
            scope: scope.to_owned(),
            kind: kind.to_owned(),
            path,
            status: status.to_owned(),
            items: 0,
            reason_code: None,
            alias_source: None,
            declared: None,
            truncated: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TruncationView {
    pub limit_hit: bool,
    /// Total directory entries visited by the shared budget.
    pub visited: usize,
    pub visited_items: usize,
    pub depth: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewResponse {
    pub protocol_version: u32,
    pub source_id: String,
    pub kind: String,
    pub digest: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<PreviewContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Withheld>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewContent {
    /// `markdown` or `json`. MCP never produces either.
    pub format: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Withheld {
    pub code: String,
    pub message: String,
}

/// How an item can be located again during preview and import. Kept off the wire.
///
/// The parent key is part of the identity on purpose: a native file may declare
/// the same server name under both `mcpServers` and `mcp_servers`, and an import
/// must never read the alias it did not select.
#[derive(Debug, Clone)]
pub(crate) enum Locate {
    Skill,
    /// A whole-file item (rule, or an MCP server under an exact parent key).
    Config,
    McpServer {
        key: String,
    },
    Hook {
        event: String,
        index: usize,
        /// False when the command body fails the sensitive-field whitelist; the
        /// body is then withheld at preview and the item is not importable.
        body_allowed: bool,
    },
}

/// Stable, non-registry identity for one discovered item. It never uses the
/// `library:` namespace owned by the imported Skill catalog.
pub(crate) fn source_id(kind: &str, runtime: &str, seed: &str) -> String {
    let digest = parse::identity_digest(&["source", kind, runtime, seed]);
    let short: String = digest.chars().take(32).collect();
    format!("native:{runtime}:{kind}:{short}")
}

/// `POST /api/v1/native-discovery` (Bearer-guarded by the crate's middleware).
pub(crate) async fn catalog(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: std::result::Result<Json<CatalogRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    let Ok(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    };
    if let Some(thread_id) = body.thread_id.as_deref()
        && !valid_thread_id(thread_id)
    {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    }
    let home = match state.native_discovery.home() {
        Ok(home) => home.to_path_buf(),
        Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
    };
    let Ok(_permit) = state.requests.try_acquire() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "request_capacity");
    };
    // An unresolved workspace fails closed: no guessed path is ever scanned.
    let workspace = match body.thread_id.as_deref() {
        Some(thread_id) => match workspace_path(&state.core, thread_id).await {
            Ok(path) => Some(path),
            Err(_) => return error(StatusCode::CONFLICT, "workspace_unresolved"),
        },
        None => None,
    };
    let (programs, mut errors) = programs(&state.core).await;
    let input = scan::ScanInput {
        home: home.clone(),
        workspace,
        limits: scan::Limits::default(),
        dsh_claude_live: state.native_discovery.dsh_claude_live(),
    };
    let outcome = tokio::time::timeout(
        REQUEST_TIMEOUT,
        tokio::task::spawn_blocking(move || scan::scan(&input)),
    )
    .await;
    let outcome = match outcome {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => return error(StatusCode::SERVICE_UNAVAILABLE, "discovery_unavailable"),
        Err(_) => return error(StatusCode::GATEWAY_TIMEOUT, "discovery_timeout"),
    };
    // A session revoked while the scan ran must not receive the result.
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    errors.extend(outcome.errors);
    Json(CatalogResponse {
        protocol_version: PROTOCOL_VERSION,
        generated_at: now_millis(),
        home: HomeView {
            root: home.to_string_lossy().into_owned(),
            admitted: true,
        },
        programs,
        items: outcome.items,
        errors,
        truncated: outcome.truncated,
        sources: outcome.sources,
    })
    .into_response()
}

/// `POST /api/v1/native-discovery/preview` (Bearer-guarded by the same middleware).
///
/// Reading a rule or hook body is an explicit consent to *read*, never a
/// consent to execute: nothing here starts a process, resolves a placeholder
/// or applies a configuration.
pub(crate) async fn preview(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: std::result::Result<Json<PreviewRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    let Ok(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    };
    if !valid_source_id(&body.source_id) || !valid_digest(&body.expected_digest) {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    }
    if let Some(thread_id) = body.thread_id.as_deref()
        && !valid_thread_id(thread_id)
    {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    }
    let home = match state.native_discovery.home() {
        Ok(home) => home.to_path_buf(),
        Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
    };
    let Ok(_permit) = state.requests.try_acquire() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "request_capacity");
    };
    let workspace = match body.thread_id.as_deref() {
        Some(thread_id) => match workspace_path(&state.core, thread_id).await {
            Ok(path) => Some(path),
            Err(_) => return error(StatusCode::CONFLICT, "workspace_unresolved"),
        },
        None => None,
    };
    let input = scan::ScanInput {
        home,
        workspace,
        limits: scan::Limits::default(),
        dsh_claude_live: state.native_discovery.dsh_claude_live(),
    };
    let outcome = tokio::time::timeout(
        REQUEST_TIMEOUT,
        tokio::task::spawn_blocking(move || scan::scan(&input)),
    )
    .await;
    let outcome = match outcome {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => return error(StatusCode::SERVICE_UNAVAILABLE, "discovery_unavailable"),
        Err(_) => return error(StatusCode::GATEWAY_TIMEOUT, "discovery_timeout"),
    };
    // No revoked session sees a preview body.
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    let Some(item) = outcome
        .items
        .into_iter()
        .find(|item| item.source_id == body.source_id)
    else {
        return error(StatusCode::NOT_FOUND, "source_unknown");
    };
    if item.digest != body.expected_digest {
        return error(StatusCode::CONFLICT, "source_changed");
    }
    match render_preview(&item) {
        Ok(response) => Json(response).into_response(),
        Err(PreviewFailure::Unreadable) => error(StatusCode::SERVICE_UNAVAILABLE, "source_unreadable"),
        Err(PreviewFailure::Changed) => error(StatusCode::CONFLICT, "source_changed"),
    }
}

/// `POST /api/v1/native-discovery/import-mcp`.
///
/// Consent is per item: the request names one `sourceId` and the exact digests
/// the browser already saw. The file is re-read once, re-verified, and only the
/// selected server is normalized. The definition is handed to Core's existing
/// `mcp.servers.create` (created disabled, unassigned) and is never returned,
/// logged or attached to an error. No OAuth or credential store is read: the
/// only bytes read are the already-admitted native MCP config.
pub(crate) async fn import_mcp(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: std::result::Result<Json<import::ImportMcpRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    let Ok(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    };
    if !valid_source_id(&body.source_id)
        || !valid_digest(&body.expected_digest)
        || !valid_config_digest(&body.expected_config_digest)
        || !body.consent
    {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    }
    if let Some(thread_id) = body.thread_id.as_deref()
        && !valid_thread_id(thread_id)
    {
        return error(StatusCode::BAD_REQUEST, "discovery_request_invalid");
    }
    let home = match state.native_discovery.home() {
        Ok(home) => home.to_path_buf(),
        Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
    };
    let Ok(_permit) = state.requests.try_acquire() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "request_capacity");
    };
    let workspace = match body.thread_id.as_deref() {
        Some(thread_id) => match workspace_path(&state.core, thread_id).await {
            Ok(path) => Some(path),
            Err(_) => return error(StatusCode::CONFLICT, "workspace_unresolved"),
        },
        None => None,
    };
    let input = scan::ScanInput {
        home,
        workspace,
        limits: scan::Limits::default(),
        dsh_claude_live: state.native_discovery.dsh_claude_live(),
    };
    let outcome = tokio::time::timeout(
        REQUEST_TIMEOUT,
        tokio::task::spawn_blocking(move || scan::scan(&input)),
    )
    .await;
    let outcome = match outcome {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => return error(StatusCode::SERVICE_UNAVAILABLE, "discovery_unavailable"),
        Err(_) => return error(StatusCode::GATEWAY_TIMEOUT, "discovery_timeout"),
    };
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    let Some(item) = outcome
        .items
        .into_iter()
        .find(|item| item.source_id == body.source_id)
    else {
        return error(StatusCode::NOT_FOUND, "source_unknown");
    };
    // Everything below this line is reached only after consent, identity and
    // digest all matched; a refusal here performs zero Core work.
    let prepared = match import::prepare(&item, &body) {
        Ok(prepared) => prepared,
        Err(failure) => return import_failure(failure),
    };
    // Revocation is re-checked immediately before the Core write. Honest limit:
    // the Core call is one atomic mutation and cannot be aborted mid-flight, so a
    // revocation landing inside that window does not undo the write; the response
    // is still withheld by the check after the call.
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    let reply = match state
        .core
        .request(
            scan::MCP_CREATE_OP,
            json!({
                "expectedConfigDigest": body.expected_config_digest,
                "definitionJson": prepared.definition_json,
            }),
        )
        .await
    {
        Ok(reply) => reply,
        Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "core_unavailable"),
    };
    if !state.sessions.is_live(&session) {
        return error(StatusCode::UNAUTHORIZED, "session_required");
    }
    if reply.error.is_some() {
        // Core's own text is not relayed: it may quote a definition.
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"status": "rejected", "code": "mcp_create_rejected"})),
        )
            .into_response();
    }
    let result = reply.result.unwrap_or(Value::Null);
    Json(import::project(&result, &prepared.name)).into_response()
}

fn import_failure(failure: import::ImportFailure) -> Response {
    let status = match failure {
        import::ImportFailure::NotConsented => StatusCode::FORBIDDEN,
        import::ImportFailure::NotMcp | import::ImportFailure::UnsupportedField => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        import::ImportFailure::Changed | import::ImportFailure::AmbiguousAlias => {
            StatusCode::CONFLICT
        }
        import::ImportFailure::Unreadable => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(json!({"code": failure.code()}))).into_response()
}

enum PreviewFailure {
    Unreadable,
    Changed,
}

fn render_preview(item: &CatalogItem) -> std::result::Result<PreviewResponse, PreviewFailure> {
    let base = |available: bool| PreviewResponse {
        protocol_version: PROTOCOL_VERSION,
        source_id: item.source_id.clone(),
        kind: item.kind.clone(),
        digest: item.digest.clone(),
        available,
        content: None,
        reason: None,
        truncated: false,
    };
    match &item.locate {
        // Skill text and rule text are read here only under explicit preview
        // consent, bounded and digest-verified. An MCP body is never returned:
        // it carries the credential material this surface must not echo.
        Locate::McpServer { .. } => Ok(PreviewResponse {
            reason: Some(Withheld {
                code: "mcp_body_not_returned".to_owned(),
                message: "MCP definitions carry credentials and are never returned.".to_owned(),
            }),
            ..base(false)
        }),
        Locate::Skill | Locate::Config => {
            let bytes = parse::read_bounded(&item.file).map_err(|_| PreviewFailure::Unreadable)?;
            if parse::digest(&bytes) != item.digest {
                return Err(PreviewFailure::Changed);
            }
            let text = String::from_utf8(bytes).map_err(|_| PreviewFailure::Unreadable)?;
            let (text, truncated) = parse::truncate_chars(&text, PREVIEW_CHARS);
            Ok(PreviewResponse {
                content: Some(PreviewContent {
                    format: "markdown".to_owned(),
                    text,
                }),
                truncated,
                ..base(true)
            })
        }
        Locate::Hook {
            event,
            index,
            body_allowed,
        } => {
            let bytes = parse::read_bounded(&item.file).map_err(|_| PreviewFailure::Unreadable)?;
            if parse::digest(&bytes) != item.digest {
                return Err(PreviewFailure::Changed);
            }
            let value =
                parse_by_extension(&item.file, &bytes).map_err(|_| PreviewFailure::Unreadable)?;
            let hook = value
                .get("hooks")
                .and_then(|hooks| hooks.get(event.as_str()))
                .and_then(Value::as_array)
                .and_then(|entries| entries.get(*index))
                .cloned()
                .ok_or(PreviewFailure::Changed)?;
            // Two independent nets: the recorded whitelist verdict and a marker
            // scan of the actual body. Either one withholds the body.
            if !*body_allowed || parse::has_secret_marker(&hook) {
                return Ok(PreviewResponse {
                    reason: Some(Withheld {
                        code: "hook_body_sensitive_fields".to_owned(),
                        message: "This hook definition can carry credential material, so its body stays native-only."
                            .to_owned(),
                    }),
                    ..base(false)
                });
            }
            let text = serde_json::to_string_pretty(&hook).map_err(|_| PreviewFailure::Unreadable)?;
            let (text, truncated) = parse::truncate_chars(&text, PREVIEW_CHARS);
            Ok(PreviewResponse {
                content: Some(PreviewContent {
                    format: "json".to_owned(),
                    text,
                }),
                truncated,
                ..base(true)
            })
        }
    }
}

fn parse_by_extension(path: &Path, bytes: &[u8]) -> Result<Value> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("json") => parse::parse_json(bytes),
        Some("toml") => parse::parse_toml(bytes),
        Some("yaml" | "yml") => parse::parse_yaml(bytes),
        _ => bail!("native_config_format_unsupported"),
    }
}

fn valid_thread_id(thread_id: &str) -> bool {
    !thread_id.is_empty()
        && thread_id.len() <= MAX_THREAD_ID
        && !thread_id
            .chars()
            .any(|character| character.is_control() || character == '\0')
}

fn valid_source_id(source_id: &str) -> bool {
    !source_id.is_empty()
        && source_id.len() <= 160
        && source_id.starts_with("native:")
        && !source_id.starts_with("library:")
        && source_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, ':' | '-' | '_' | '.'))
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64 && digest.chars().all(|character| character.is_ascii_hexdigit())
}

/// Core config digests are `sha256:<64 hex>`; a bare 64-hex digest is accepted
/// too so the client can pass through exactly what it read.
fn valid_config_digest(digest: &str) -> bool {
    let bare = digest.strip_prefix("sha256:").unwrap_or(digest);
    valid_digest(bare)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Core is the only path source. An unresolved workspace is an error, never a
/// fallback to a guessed directory.
async fn workspace_path(core: &CoreService, thread_id: &str) -> Result<PathBuf> {
    let value = core_value(
        core,
        "camps.open",
        json!({"traceId": uuid::Uuid::new_v4().to_string(), "threadId": thread_id}),
    )
    .await
    .context("workspace_unresolved")?;
    let path = value
        .pointer("/thread/projectPath")
        .and_then(Value::as_str)
        .context("workspace_unresolved")?;
    let path = PathBuf::from(path);
    ensure!(path.is_absolute(), "workspace_unresolved");
    Ok(path)
}

async fn core_value(core: &CoreService, method: &str, params: Value) -> Result<Value> {
    let reply = core.request(method, params).await.context("core_unavailable")?;
    if reply.error.is_some() {
        bail!("core_error");
    }
    Ok(reply.result.unwrap_or(Value::Null))
}

/// Program presence. A Core installation record is real Host evidence; a PATH
/// hit is only metadata and stays labelled as such. No version probe, no
/// process start, no executable contents.
async fn programs(core: &CoreService) -> (Vec<ProgramView>, Vec<DiscoveryError>) {
    let mut errors = Vec::new();
    let records = match core_value(core, "runtime.installations.list", json!({})).await {
        Ok(value) => value,
        Err(_) => {
            errors.push(DiscoveryError::new(
                "host",
                "runtime",
                "core_unavailable",
                None,
            ));
            Value::Null
        }
    };
    let records = records.as_array().cloned().unwrap_or_default();
    let mut programs = Vec::new();
    for runtime in scan::RUNTIMES {
        let record = records
            .iter()
            .find(|record| {
                record.get("adapterKind").and_then(Value::as_str) == Some(runtime)
                    && record.get("enabled").and_then(Value::as_bool).unwrap_or(true)
            })
            .or_else(|| {
                records.iter().find(|record| {
                    record.get("adapterKind").and_then(Value::as_str) == Some(runtime)
                })
            });
        if let Some(record) = record {
            programs.push(ProgramView {
                kind: runtime.to_owned(),
                label: label(runtime).to_owned(),
                detected: true,
                evidence: "installation-record".to_owned(),
                installation_id: record.get("id").and_then(Value::as_str).map(str::to_owned),
                executable_path: record
                    .get("executablePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                path_state: record
                    .get("pathState")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                enabled: record.get("enabled").and_then(Value::as_bool),
            });
            continue;
        }
        match path_presence(command_name(runtime)) {
            Some(path) => programs.push(ProgramView {
                kind: runtime.to_owned(),
                label: label(runtime).to_owned(),
                detected: true,
                evidence: "path-metadata".to_owned(),
                installation_id: None,
                executable_path: Some(path),
                path_state: None,
                enabled: None,
            }),
            None => programs.push(ProgramView {
                kind: runtime.to_owned(),
                label: label(runtime).to_owned(),
                detected: false,
                evidence: "absent".to_owned(),
                installation_id: None,
                executable_path: None,
                path_state: None,
                enabled: None,
            }),
        }
    }
    (programs, errors)
}

fn label(runtime: &str) -> &'static str {
    match runtime {
        "claude-code-cli" => "Claude Code",
        "codex-cli" => "Codex CLI",
        "deepseek-harness" => "DeepSeek Harness",
        _ => "Pi",
    }
}

fn command_name(runtime: &str) -> &'static str {
    match runtime {
        "claude-code-cli" => "claude",
        "codex-cli" => "codex",
        "deepseek-harness" => "dsh",
        _ => "pi",
    }
}

fn command_suffixes() -> &'static [&'static str] {
    if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    }
}

/// Existence-only PATH scan: bounded entries, metadata only, nothing executed.
fn path_presence(name: &str) -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    let mut seen = 0usize;
    for directory in std::env::split_paths(&paths) {
        seen += 1;
        if seen > MAX_PATH_ENV_ENTRIES {
            break;
        }
        for suffix in command_suffixes() {
            let candidate = directory.join(format!("{name}{suffix}"));
            if std::fs::symlink_metadata(&candidate).is_ok_and(|metadata| metadata.is_file()) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// The Host stores this as `WebState::native_discovery`; the constructors above
/// are the only way it is produced.
pub(crate) type SharedNativeDiscovery = Arc<NativeDiscovery>;
