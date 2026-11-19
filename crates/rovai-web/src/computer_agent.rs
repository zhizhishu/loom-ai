//! Agent computer use: a browser-granted, TTL-bounded bridge onto the ONE computer
//! provider.
//!
//! Nothing here captures a screen or injects input. Every capture and every synthetic
//! event runs through [`computer::Computer`] with a *trusted admission closure*
//! (`frame_guarded`/`input_guarded`), so the browser session, the grant expiry and the
//! grant revocation are rechecked at the last possible instant — while the physical
//! gate is held, immediately before the OS call and immediately before capture bytes
//! are returned. A tool request that waited behind the gate can therefore never execute
//! after the owner logged out, the grant expired, or the user revoked it.
//!
//! Ownership boundaries:
//! * The grant token lives only in a private `0600`/DACL file and in this process. The
//!   browser, the MCP definition, argv and every log stay free of it.
//! * Each grant has its own in-memory [`Sessions`] registry, so its token is invalid on
//!   every general Core route.
//! * The Core MCP configuration is wired by digest: the browser must pass the digest it
//!   showed the user, every write uses the digest the previous step reported, and an
//!   unexpected value fails the grant closed without a retry.
//! * A created-but-not-yet-assigned server id is remembered immediately, so a later
//!   failure can clean up the exact server. An ambiguous create is reported as unknown
//!   and never replayed.
//!
//! Authority identity and the finite tool map are ported from Mikka
//! (`lib/computer/local-authority.ts` and `packages/daemon/src/computer/driver.mjs`
//! at `d59c85cb`):
//! * Identity is [`Authority`], derived once from reviewed Host state — the browser
//!   session that consented, the member the reviewed MCP server is assigned to, its
//!   runtime, the one local device, the granted scope and the reviewed configuration
//!   revision. A request body can never supply any of it (`GrantBody` denies unknown
//!   fields), and every tool call re-reads the live Core state instead of trusting the
//!   stored stamp. That re-read includes the member itself, so the grant stops serving as
//!   soon as the reviewed member is removed, moved off this Host, or switched to another
//!   runtime — including `pi` before its explicit opt-in.
//! * The tool surface is the same closed five Mikka's driver exposes, mapped one to one:
//!   `get_desktop_state`→[`Tool::Screenshot`], `click`→[`Tool::MouseClick`],
//!   `type_text`→[`Tool::Text`], `press_key`→[`Tool::Key`], `scroll`→[`Tool::Wheel`].
//!   Mikka's recording-only tools (`capture_screenshot`, `start_screen_recording`,
//!   `stop_screen_recording`, `mark_recording_step`) and its `step` description have no
//!   LOOM counterpart and are deliberately not exposed.
//! * Captures and synthetic input keep **independent** authorization: [`Scope::View`]
//!   authorizes a frame and nothing else, [`Scope::Control`] additionally authorizes the
//!   four input tools. Mikka's single workspace policy (`permission: "allow"`, no
//!   per-step review) is *not* copied: every grant here is per-grant, consented, TTL
//!   bounded and revocable, and a tool call is re-authorized while the physical gate is
//!   held.
//! * Runtimes are the Pi toolchain family only ([`runtime_supported`]). `pi` stays closed
//!   until the instance opts in through `LOOM_COMPUTER_AGENT_PI_MCP=1`;
//!   `claude-code-cli` is refused by product policy and the Claude runtime opt-in
//!   (`LOOM_CLAUDE_RUNTIME_ENABLED`) never opens a desktop grant.

use crate::auth::{Session, Sessions};
use crate::computer::{
    self, Computer, ControlBody, EventBody, EventKind, FrameBody, InputBody, ReleaseBody,
    StopBody, ViewBody, WireButton, WireKey,
};
use crate::{WebState, error};
use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine as _;
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::task::spawn_blocking;

/// Most grants a Host holds at once, across every browser session.
pub(crate) const MAX_GRANTS: usize = 64;
/// Hard ceiling for one grant: "valid for up to N minutes until revoke or logout".
pub(crate) const MAX_GRANT_MS: u64 = 300_000;
const DEFAULT_GRANT_MS: u64 = 300_000;
/// Single-use tool request ids per grant. At the bound the grant refuses new requests;
/// nothing is evicted, so no id can be replayed.
pub(crate) const MAX_RECEIPTS: usize = 512;
const MAX_REQUEST_ID: usize = 64;
const MAX_TOKEN_HEADER: usize = 128;
const RPC_DEADLINE: Duration = Duration::from_secs(15);
const RETIRE_DEADLINE: Duration = Duration::from_secs(12);
const CORE_DEADLINE: Duration = Duration::from_secs(20);
const GRANT_GATE_MS: u64 = 10_000;
const TOOL_CONTROL_TTL_SECONDS: u32 = 30;
const TOKEN_PREFIX: &str = "grant-";
const RPC_PATH: &str = "/api/v1/computer-agent/rpc";

/// The only adapter kinds this bridge will wire. These are the *wire* values of
/// `rovai_core::agent_profile::AdapterKind`, which is `#[serde(rename_all = "kebab-case")]`
/// (`agent_profile.rs:35-37`): `CodexCli`, `DeepseekHarness`, `Pi`.
/// `pi` stays closed until the instance opts in through [`PI_COMPUTER_MCP_ENV`].
/// `claude-code-cli` is absent on purpose: it is refused by product policy, not only
/// gated, so the reported allowlist can never offer a Claude computer grant.
const RUNTIMES: [&str; 3] = ["codex-cli", "deepseek-harness", "pi"];
/// Tool names are a closed set. No generic HTTP, shell, file or URL tool exists.
///
/// The same five tools Mikka's driver exposes, in LOOM's wire spelling:
/// `get_desktop_state`→`screenshot`, `click`→`mouse_click`, `press_key`→`key`,
/// `type_text`→`text`, `scroll`→`wheel`.
const TOOLS: [&str; 5] = ["screenshot", "mouse_click", "key", "text", "wheel"];

/// The existing explicit-enable path for the Pi toolchain. Only `1` (surrounding
/// whitespace tolerated) counts, the same shape `runtime_platform_admission` uses for the
/// Claude switch, so a stray value can never widen the surface.
pub(crate) const PI_COMPUTER_MCP_ENV: &str = "LOOM_COMPUTER_AGENT_PI_MCP";

fn wall_clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn http_status(code: &'static str) -> StatusCode {
    match code {
        "session_required"
        | "computer_agent_grant_unknown"
        | "computer_agent_grant_expired"
        | "computer_agent_grant_revoked"
        | "computer_agent_owner_session_required" => StatusCode::UNAUTHORIZED,
        "computer_agent_consent_required"
        | "computer_agent_scope_denied"
        | "computer_agent_origin_denied"
        | "computer_agent_runtime_unsupported"
        | "computer_agent_target_unsupported" => StatusCode::FORBIDDEN,
        "computer_agent_grant_unknown_for_owner" | "computer_agent_assistant_unknown" => {
            StatusCode::NOT_FOUND
        }
        "computer_agent_invalid_request" | "computer_agent_assistant_removed" => {
            StatusCode::BAD_REQUEST
        }
        "computer_agent_control_held"
        | "computer_agent_device_mismatch"
        | "computer_agent_view_unavailable"
        | "computer_agent_request_replayed"
        | "computer_agent_grant_conflict"
        | "computer_agent_digest_mismatch" => StatusCode::CONFLICT,
        "computer_agent_limit" | "computer_agent_request_capacity" => StatusCode::TOO_MANY_REQUESTS,
        "computer_agent_mcp_unavailable"
        | "computer_agent_capture_failed"
        | "computer_agent_input_unknown"
        | "computer_agent_cleanup_unconfirmed" => StatusCode::BAD_GATEWAY,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

fn reject(code: &'static str) -> Response {
    error(http_status(code), code)
}

fn rpc_error(request_id: &str, code: &'static str) -> Response {
    // The same envelope for transport and tool errors. No Core detail is echoed.
    (
        http_status(code),
        Json(json!({"ok": false, "requestId": request_id, "error": {"code": code}})),
    )
        .into_response()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
    View,
    Control,
}

impl Scope {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "view" => Some(Self::View),
            "control" => Some(Self::Control),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Control => "control",
        }
    }

    /// Independent authorization. A view grant authorizes a capture and nothing else; the
    /// control scope is the only one that can reach a synthetic input.
    fn allows(self, required: Scope) -> bool {
        match required {
            Self::View => matches!(self, Self::View | Self::Control),
            Self::Control => self == Self::Control,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tool {
    Screenshot,
    MouseClick,
    Key,
    Text,
    Wheel,
}

impl Tool {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "screenshot" => Some(Self::Screenshot),
            "mouse_click" => Some(Self::MouseClick),
            "key" => Some(Self::Key),
            "text" => Some(Self::Text),
            "wheel" => Some(Self::Wheel),
            _ => None,
        }
    }

    /// The narrowest scope that can use this tool. A capture needs the view scope and
    /// nothing more; every synthetic input needs the control scope.
    fn required_scope(self) -> Scope {
        match self {
            Self::Screenshot => Scope::View,
            Self::MouseClick | Self::Key | Self::Text | Self::Wheel => Scope::Control,
        }
    }
}

/// The authority a computer grant carries, derived once from reviewed Host state.
///
/// Ported from Mikka's `localComputerAuthority` (`lib/computer/local-authority.ts`):
/// authority is read from persisted ownership, never from a task, a model field or the
/// tool call. Mikka carries `{botId, ownerId, workspaceId, permission, policyVersion}`;
/// LOOM keeps two independent permissions instead of one `allow` and uses the reviewed
/// Core MCP configuration digest as the policy version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Authority {
    /// The browser session that consented (`ownerId`).
    owner_id: String,
    /// The member the reviewed MCP server is assigned to (`botId`).
    bot_id: String,
    /// The member's own runtime wire value. Reported and recorded, so the definition a
    /// grant minted can be told apart from one minted for another runtime.
    runtime: String,
    /// The one local device this grant covers (`workspaceId`/`deviceId`).
    device_id: String,
    /// What the user allowed: captures only, or captures plus synthetic input.
    permission: Scope,
    /// The reviewed Core configuration revision (`policyVersion`). A newer revision never
    /// silently inherits an older grant.
    policy_version: String,
}

impl Authority {
    /// The single authorization decision for one tool call.
    fn authorizes(&self, tool: Tool) -> Result<(), &'static str> {
        if self.permission.allows(tool.required_scope()) {
            Ok(())
        } else {
            Err("computer_agent_scope_denied")
        }
    }
}

/// Runtime kinds accepted by [`runtime_supported`], read from the member's own runtime
/// configuration (never inferred from a model name).
fn runtime_supported(adapter: &str) -> bool {
    runtime_supported_with(
        adapter,
        pi_mcp_opt_in(std::env::var(PI_COMPUTER_MCP_ENV).ok().as_deref()),
    )
}

/// Pure form of the Pi opt-in, so a test can assert both sides without mutating this
/// process's environment (which parallel tests would observe).
fn pi_mcp_opt_in(raw: Option<&str>) -> bool {
    raw.map(str::trim) == Some("1")
}

/// The accepted runtimes, with the Pi opt-in passed in.
///
/// `claude-code-cli` is refused unconditionally. LOOM disabled the Claude runtime by
/// product policy (`rovai_core::runtime_platform_admission::CLAUDE_RUNTIME_ENABLED_ENV`),
/// and that switch only re-enables channel-endpoint Claude runs for manual testing. It is
/// deliberately not accepted here: a desktop grant must never be a way around it, so this
/// function takes no Claude opt-in at all.
fn runtime_supported_with(adapter: &str, pi_opt_in: bool) -> bool {
    match adapter {
        "pi" => pi_opt_in,
        "codex-cli" | "deepseek-harness" => true,
        _ => false,
    }
}

/// What the Host must know about the chosen assistant before it may receive a grant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AssistantInfo {
    pub adapter: String,
    pub removed: bool,
    /// True only when the member's own execution target is this local Host.
    pub target_local: bool,
}

fn assistant_admissible(info: &AssistantInfo) -> Result<(), &'static str> {
    assistant_admissible_with(
        info,
        pi_mcp_opt_in(std::env::var(PI_COMPUTER_MCP_ENV).ok().as_deref()),
    )
}

/// Admission with the Pi opt-in passed in, so a test can assert both sides without
/// mutating this process's environment.
fn assistant_admissible_with(info: &AssistantInfo, pi_opt_in: bool) -> Result<(), &'static str> {
    if info.removed {
        return Err("computer_agent_assistant_removed");
    }
    if !runtime_supported_with(&info.adapter, pi_opt_in) {
        return Err("computer_agent_runtime_unsupported");
    }
    if !info.target_local {
        // A remote target would run the bridge on another machine and point its loopback
        // endpoint back at this Host; that route does not exist, so refuse.
        return Err("computer_agent_target_unsupported");
    }
    Ok(())
}

/// Is the grant still backed by the member it was minted for?
///
/// Mikka reads the current authority from persisted ownership before every driver
/// invocation (`lib/computer/local-authority.ts`); nothing in a run or a tool call may
/// stand in for that read. LOOM therefore re-reads the member on every call and requires
/// the same decision the grant was minted under: still admitted, and still the exact
/// runtime recorded in the authority. A member switched to another runtime — in
/// particular to `pi` while the instance has not opted in through
/// [`PI_COMPUTER_MCP_ENV`] — is refused with the live admission code, so a grant created
/// before the switch can never outlive it.
fn authority_holds(recorded: &Authority, current: &AssistantInfo) -> Result<(), &'static str> {
    authority_holds_with(
        recorded,
        current,
        pi_mcp_opt_in(std::env::var(PI_COMPUTER_MCP_ENV).ok().as_deref()),
    )
}

/// The same decision with the Pi opt-in passed in, so the switch to `pi` can be asserted
/// from both sides without touching this process's environment.
fn authority_holds_with(
    recorded: &Authority,
    current: &AssistantInfo,
    pi_opt_in: bool,
) -> Result<(), &'static str> {
    assistant_admissible_with(current, pi_opt_in)?;
    if current.adapter != recorded.runtime {
        // The identity moved: this grant's definition, scope and consent were reviewed for
        // the old runtime, so it is not this grant any more — even when the new runtime is
        // admitted (for example `deepseek-harness`), and even when Pi has opted in.
        return Err("computer_agent_runtime_unsupported");
    }
    Ok(())
}

/// The live member gate `rpc` runs before anything else touches Core or the device.
///
/// The read itself may fail (`computer_agent_assistant_unknown` and friends); that is a
/// fail-closed refusal, not proof the grant is gone, so the caller distinguishes it from an
/// actual [`authority_holds`] refusal before deciding to retire the grant.
async fn admit_live_authority(mcp: &dyn McpOps, grant: &Grant) -> Result<(), &'static str> {
    let current = mcp
        .assistant(grant.owner_id().to_owned(), grant.authority.bot_id.clone())
        .await?;
    authority_holds(&grant.authority, &current)
}

/// Host-owned configuration. Both paths are absolute and come from the Host process
/// environment; the origin is this exact server's loopback authority.
#[derive(Clone, Debug)]
pub(crate) struct Config {
    python: PathBuf,
    bridge: PathBuf,
    origin: String,
    root: PathBuf,
}

impl Config {
    fn from_env(data_dir: &Path, port: u16) -> Option<Self> {
        let python = PathBuf::from(std::env::var_os("LOOM_COMPUTER_AGENT_PYTHON")?);
        let bridge = PathBuf::from(std::env::var_os("LOOM_COMPUTER_AGENT_BRIDGE")?);
        if !python.is_absolute() || !python.is_file() || !bridge.is_absolute() || !bridge.is_file() {
            return None;
        }
        let origin = match std::env::var("LOOM_COMPUTER_AGENT_ORIGIN") {
            Ok(origin) => loopback_origin(&origin, port)?,
            Err(_) => format!("http://127.0.0.1:{port}"),
        };
        Some(Self {
            python,
            bridge,
            origin,
            root: data_dir.join("computer-grants"),
        })
    }
}

/// A trusted agent origin must be a literal `http://` loopback URL on this exact port.
///
/// An `https://` value is **refused**, never rewritten to `http://`: this Host serves plain
/// HTTP on the bound port, so an https origin would either be a downgrade the client did
/// not ask for or a different listener. It is also not authentication in either case — the
/// `0600` token file is the only real boundary, and `Origin` is supplementary.
fn loopback_origin(origin: &str, port: u16) -> Option<String> {
    let rest = origin.strip_prefix("http://")?;
    if rest.contains(['/', '?', '#', '@', '\\']) {
        return None;
    }
    let (host, raw_port) = rest.rsplit_once(':')?;
    if raw_port.parse::<u16>().ok()? != port {
        return None;
    }
    match host {
        "127.0.0.1" => Some(format!("http://127.0.0.1:{port}")),
        "localhost" => Some(format!("http://localhost:{port}")),
        "[::1]" => Some(format!("http://[::1]:{port}")),
        _ => None,
    }
}

fn authority(origin: &str) -> Option<&str> {
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GrantBody {
    pub consent: bool,
    pub assistant_id: String,
    pub scope: String,
    pub device_id: String,
    /// The digest the UI showed the user before this click. Required: the Host never
    /// silently adopts a newer configuration than the one that was reviewed.
    pub expected_config_digest: String,
    #[serde(default)]
    pub ttl_seconds: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RevokeBody {
    pub grant_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RpcBody {
    pub request_id: String,
    pub tool: String,
    /// The configuration the user reviewed. A tool may never run against a different
    /// one, and the bridge forwards it on every call.
    pub expected_config_digest: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClickArgs {
    x: i32,
    y: i32,
    button: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WheelArgs {
    x: i32,
    y: i32,
    delta: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyArgs {
    key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextArgs {
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

/// Browser-facing grant metadata. The token, the private session and the token file are
/// never part of it; the server id is the real (non-secret) id so the UI can diagnose
/// leftover MCP entries.
pub(crate) fn public_grant(grant: &Grant, now: u64) -> Value {
    json!({
        "grantId": grant.id,
        "assistantId": grant.authority.bot_id,
        "deviceId": grant.authority.device_id,
        "runtime": grant.authority.runtime,
        "scope": grant.authority.permission.label(),
        "serverId": grant.server_id(),
        "expiresAt": grant.expires_at,
        "validForSeconds": grant.expires_at.saturating_sub(now) / 1000,
        "transportOrigin": grant.transport_origin,
        "state": grant.state_label(now),
        // Visible rather than silent: a revocation whose device fence or MCP cleanup could
        // not be proven keeps its row here (and is retried) instead of reporting success.
        "cleanupPending": !grant.cleaned.load(Ordering::Acquire),
    })
}

struct Receipts {
    seen: HashSet<String>,
}

struct RunState {
    view_id: Option<String>,
    control_id: Option<String>,
    generation: u64,
    seq_high: u64,
}

impl Default for RunState {
    fn default() -> Self {
        Self {
            view_id: None,
            control_id: None,
            generation: 0,
            seq_high: 0,
        }
    }
}

pub(crate) struct Grant {
    id: String,
    owner: Arc<Session>,
    owner_sessions: Arc<Sessions>,
    /// The identity this grant was minted for. Every tool call is re-authorized against
    /// it, and nothing in a request body can supply or widen it.
    authority: Authority,
    /// Empty until `create` confirms a server id; set immediately when it does, so a
    /// later failure can clean up the exact server instead of leaking it.
    created_server_id: Mutex<String>,
    transport_origin: String,
    bridge_origin: String,
    digest: [u8; 32],
    sessions: Arc<Sessions>,
    session: Arc<Session>,
    token_path: Option<PathBuf>,
    expires_at: u64,
    /// True until the creation attempt finishes. Reserved grants are never swept away,
    /// so `MAX_GRANTS` cannot be under-counted by an in-flight attempt.
    pending: AtomicBool,
    revoked: AtomicBool,
    closed: AtomicBool,
    /// Set only once *both* the device fence and the Core MCP cleanup were confirmed. A
    /// revocation that cannot prove cleanup keeps this `false` so a later sweep retries.
    cleaned: AtomicBool,
    /// The request-id ledger. Deliberately **not** part of `RunState`: `run` is held across
    /// the OS input call, so a ledger behind it could not be read while a request was in
    /// flight, which is exactly the ordering this ledger exists to prove (an id is burnt
    /// *before* anything reaches the OS). Its own lock also keeps replay detection from
    /// depending on the physical-input serialization.
    receipts: Mutex<Receipts>,
    /// The exact MCP definition this grant created, captured before the registry write.
    /// Authorization compares the *current* registry definition against this value
    /// structurally, so a replaced definition can never inherit the grant by preserving a
    /// substring. `None` never authorizes: a grant without a recorded definition is not
    /// proof of anything. The value holds paths and ids only, never the token body.
    expected_definition: Mutex<Option<Value>>,
    run: Mutex<RunState>,
}

impl Grant {
    /// The browser session that consented. Kept as a named accessor because the registry,
    /// the cleanup path and the private transport all filter on exactly this identity.
    fn owner_id(&self) -> &str {
        &self.authority.owner_id
    }

    fn server_id(&self) -> String {
        self.created_server_id
            .lock()
            .map(|id| id.clone())
            .unwrap_or_default()
    }

    fn record_server(&self, server_id: &str) {
        if let Ok(mut slot) = self.created_server_id.lock() {
            if slot.is_empty() {
                *slot = server_id.to_owned();
            }
        }
    }

    fn state_label(&self, now: u64) -> &'static str {
        if self.revoked.load(Ordering::Acquire) {
            "revoked"
        } else if now >= self.expires_at {
            "expired"
        } else if !self.owner_sessions.is_live(&self.owner) {
            "owner_session_closed"
        } else {
            "active"
        }
    }

    /// Held across one whole tool call: tool requests of one grant are serialized.
    fn gate(&self) -> Result<MutexGuard<'_, RunState>, &'static str> {
        let deadline = Instant::now() + Duration::from_millis(GRANT_GATE_MS);
        loop {
            match self.run.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => return Err("computer_agent_endpoint_busy"),
                Err(TryLockError::WouldBlock) => {}
            }
            if Instant::now() >= deadline {
                return Err("computer_agent_endpoint_busy");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

impl Drop for Grant {
    fn drop(&mut self) {
        if let Some(path) = &self.token_path {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The admission test used at every boundary: after the grant gate, inside the computer
/// guard, before each Core write, and before returning a result.
fn admit(grant: &Grant, browser: &Sessions) -> Result<(), &'static str> {
    if grant.revoked.load(Ordering::Acquire) {
        return Err("computer_agent_grant_revoked");
    }
    admit_pending(grant, browser)
}

/// Admission for a grant that has not been published yet.
///
/// A pending reservation is created with `revoked` already set, because the browser has not
/// received a grant id and must not be able to steer anything. That flag only becomes the
/// public fence once the grant is live, so the creation path must not consult it.
fn admit_pending(grant: &Grant, browser: &Sessions) -> Result<(), &'static str> {
    if grant.closed.load(Ordering::Acquire) {
        return Err("computer_agent_grant_revoked");
    }
    if wall_clock() >= grant.expires_at {
        return Err("computer_agent_grant_expired");
    }
    if !browser.is_live(&grant.owner) {
        return Err("computer_agent_owner_session_required");
    }
    if !grant.sessions.is_live(&grant.session) {
        return Err("computer_agent_grant_revoked");
    }
    Ok(())
}

/// Is the grant still backed by the exact Core configuration it was minted from?
///
/// This is a *current* check, not a stored stamp. Every call re-reads the registry entry
/// for this grant's own server id and requires all four facts at once: the same server
/// identity, still enabled, still assigned to exactly this one assistant, and still
/// carrying the canonical definition recorded at creation. Disabling the server,
/// unassigning the assistant, or replacing the definition in Core stops an active grant on
/// its next tool call instead of waiting for the grant TTL.
fn server_authorizes(current: &ServerState, grant: &Grant) -> Result<(), &'static str> {
    if !current.enabled {
        return Err("computer_agent_grant_revoked");
    }
    // Exactly the one assistant the grant was created for, and no other.
    if current.assigned.len() != 1 || current.assigned[0] != grant.authority.bot_id {
        return Err("computer_agent_grant_revoked");
    }
    if !definition_matches(&current.definition, grant) {
        return Err("computer_agent_grant_revoked");
    }
    Ok(())
}

/// The stored definition must still be *structurally* this grant's own definition.
///
/// Substring checks are not enough: a definition replacement that keeps the grant id and
/// the token-file basename could otherwise point `command`/`args`/`env` at an arbitrary
/// program and inherit an active grant. Both sides are parsed and compared as JSON values,
/// so object key order is immaterial while array order (for example `args`) still matters.
/// A grant with no recorded expectation, or a definition that does not decode, authorizes
/// nothing.
fn definition_matches(definition: &str, grant: &Grant) -> bool {
    let Ok(expected) = grant.expected_definition.lock() else {
        return false;
    };
    let Some(expected) = expected.as_ref() else {
        return false;
    };
    let Ok(current) = serde_json::from_str::<Value>(definition) else {
        return false;
    };
    &current == expected
}

/// The agent side of the Core MCP configuration, behind a trait so the exact call
/// sequence, its digests and the assistant gate can be tested without a database.
pub(crate) trait McpOps: Send + Sync + 'static {
    fn digest(&self, owner: String) -> BoxFuture<'static, Result<String, &'static str>>;
    fn assistant(
        &self,
        owner: String,
        agent_id: String,
    ) -> BoxFuture<'static, Result<AssistantInfo, &'static str>>;
    fn create(
        &self,
        owner: String,
        digest: String,
        definition: String,
    ) -> BoxFuture<'static, Result<(String, String), &'static str>>;
    fn set_members(
        &self,
        owner: String,
        digest: String,
        server_id: String,
        agent_id: String,
    ) -> BoxFuture<'static, Result<String, &'static str>>;
    fn set_enabled(
        &self,
        owner: String,
        digest: String,
        server_id: String,
        enabled: bool,
    ) -> BoxFuture<'static, Result<String, &'static str>>;
    fn delete(
        &self,
        owner: String,
        digest: String,
        server_id: String,
    ) -> BoxFuture<'static, Result<(), &'static str>>;
    /// The server's *current* Core state: `Ok(None)` means it is no longer in the
    /// configuration, `Err` means the read itself failed (unknown, therefore untrusted).
    fn server(
        &self,
        owner: String,
        server_id: String,
    ) -> BoxFuture<'static, Result<Option<ServerState>, &'static str>>;
}

/// A snapshot of one MCP server as Core currently reports it.
///
/// `definition` is the *unmasked* definition `mcp.servers.reveal` returned for exactly this
/// server id at the same digest. It exists only for the duration of one authorization check:
/// it is never logged, persisted, projected or returned.
struct ServerState {
    enabled: bool,
    assigned: Vec<String>,
    definition: String,
}

/// The public metadata of one entry of the flat `mcp.config.get` view, or `None` when that
/// exact id is absent. The entry's `definitionJson` is the redacted public projection
/// (`mcp.rs:1219,1226`), so it is deliberately not read here: only a matching `reveal` at the
/// same digest may supply a definition that authorizes anything.
struct ServerEntry {
    enabled: bool,
    assigned: Vec<String>,
}

fn server_entry(servers: &[Value], server_id: &str) -> Option<ServerEntry> {
    let server = servers
        .iter()
        .find(|server| server.get("serverId").and_then(Value::as_str) == Some(server_id))?;
    let assigned = server
        .get("assignedAgentIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Some(ServerEntry {
        enabled: server
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        assigned,
    })
}

struct CoreMcp {
    core: rovai_core::application::CoreService,
}

impl CoreMcp {
    fn clone_inner(&self) -> Self {
        Self {
            core: self.core.clone(),
        }
    }

    async fn call(
        &self,
        method: &'static str,
        params: Value,
        owner: &str,
    ) -> Result<Value, &'static str> {
        let client = rovai_core::draft_client::DraftClient::verified_web(owner)
            .map_err(|_| "computer_agent_core_unavailable")?;
        let reply = tokio::time::timeout(
            CORE_DEADLINE,
            self.core.request_for_editor(method, params, client),
        )
        .await
        .map_err(|_| "computer_agent_core_unavailable")?
        .map_err(|_| "computer_agent_core_unavailable")?;
        if reply.error.is_some() {
            return Err("computer_agent_mcp_unavailable");
        }
        Ok(reply.result.unwrap_or(Value::Null))
    }

    async fn current_digest(&self, owner: &str) -> Result<String, &'static str> {
        let value = self.call("mcp.config.get", json!({}), owner).await?;
        config_digest(&value).ok_or("computer_agent_mcp_unavailable")
    }

    /// Read the *flat* `mcp.config.get` view (`McpConfigView`, `mcp.rs:213-225`), and only
    /// when that exact server id is present, ask Core for its unmasked definition through
    /// `mcp.servers.reveal` at the same digest. The public `definitionJson` of that view is
    /// masked, so it is never used to authorize a tool call.
    async fn current_server(
        &self,
        owner: &str,
        server_id: &str,
    ) -> Result<Option<ServerState>, &'static str> {
        let value = self.call("mcp.config.get", json!({}), owner).await?;
        let digest = config_digest(&value).ok_or("computer_agent_mcp_unavailable")?;
        let Some(entry) = server_entry(public_servers(&value)?, server_id) else {
            // That exact server is gone; no neighbour in the configuration substitutes it.
            return Ok(None);
        };
        let revealed = self
            .call(
                "mcp.servers.reveal",
                json!({"expectedConfigDigest": digest.clone(), "serverId": server_id}),
                owner,
            )
            .await?;
        Ok(Some(ServerState {
            enabled: entry.enabled,
            assigned: entry.assigned,
            definition: revealed_definition(&revealed, server_id, &digest)?,
        }))
    }
}

/// Accepts only the shapes Core actually returns; an unknown or missing digest fails
/// the grant closed instead of guessing.
fn config_digest(value: &Value) -> Option<String> {
    let candidate = value
        .get("configDigest")
        .or_else(|| value.get("config").and_then(|inner| inner.get("configDigest")))?;
    canonical_digest(candidate.as_str()?)
}

/// Core reports its configuration revision as `sha256:` plus 64 lowercase hex characters
/// (`mcp.rs:1909`), and the value is kept byte for byte. The `sha256:`-prefixed sentinels for
/// a missing, non-regular or oversized file (`mcp.rs:1114,1129,1142`) name no readable
/// configuration, so they are refused instead of being accepted as a reviewed revision.
fn canonical_digest(digest: &str) -> Option<String> {
    let hex = digest.strip_prefix("sha256:")?;
    (hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then(|| digest.to_owned())
}

/// The `servers` array of the flat `mcp.config.get` view (`McpConfigView.servers`).
///
/// A missing or non-array value is a **wire-shape failure**, never an empty configuration:
/// reading it as "no servers" would let `cleanup_mcp` report a cleanup it never observed and
/// would turn a broken read into `Ok(None)` ("the server is gone"). Only a genuine list that
/// does not contain the requested id means the server is absent.
fn public_servers(value: &Value) -> Result<&[Value], &'static str> {
    value
        .get("servers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or("computer_agent_mcp_unavailable")
}

/// Reads `members.get` (`AgentProfileView`, camelCase) and
/// `members.executionTarget.get` (`MemberTargetView` = flattened `VersionedMemberTarget`
/// plus workspace/descriptor lists). A member with **no persisted selection**
/// (`selection: null`) runs on this local Host; a persisted `selection` names a remote
/// `nodeId`, and that route does not exist for this bridge.
fn assistant_from_member(member: &Value, target: Result<Value, &'static str>) -> AssistantInfo {
    let removed = member
        .get("removedAt")
        .map(|value| !value.is_null())
        .unwrap_or(false);
    let adapter = member
        .get("runtimeConfiguration")
        .and_then(|runtime| runtime.get("adapterKind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let target_local = target
        .ok()
        .is_some_and(|view| view.get("selection").map(Value::is_null).unwrap_or(true));
    AssistantInfo {
        adapter,
        removed,
        target_local,
    }
}

/// `McpMutationResult` is a tagged enum (`mcp.rs:223-249`):
/// `{"status":"ok","configDigest":…,"config":{…McpConfigView…}}`,
/// `{"status":"conflict","actualConfigDigest":…}`,
/// `{"status":"invalid","issues":[…]}`,
/// `{"status":"risk_acknowledgement_required","serverId":…}`.
/// There is no flat `serverId`/`configDigest` on a mutation reply.
struct MutationView {
    digest: String,
    servers: Vec<Value>,
}

/// Test-only, and only the digest and server count: the snapshot itself is a whole Core
/// configuration and must not end up in a panic message. Production builds never contain
/// this impl.
#[cfg(test)]
impl std::fmt::Debug for MutationView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MutationView")
            .field("digest", &self.digest)
            .field("servers", &self.servers.len())
            .finish_non_exhaustive()
    }
}

fn mutation(value: &Value) -> Result<MutationView, &'static str> {
    match value.get("status").and_then(Value::as_str) {
        Some("ok") => Ok(MutationView {
            // The same canonical digest `mcp.config.get` reports, never a free-form token.
            digest: canonical_digest(
                value
                    .get("configDigest")
                    .and_then(Value::as_str)
                    .ok_or("computer_agent_mcp_unavailable")?,
            )
            .ok_or("computer_agent_mcp_unavailable")?,
            servers: value
                .get("config")
                .and_then(|config| config.get("servers"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }),
        // Core's configuration moved past the reviewed digest: never retry blindly.
        Some("conflict") => Err("computer_agent_digest_mismatch"),
        Some("invalid" | "risk_acknowledgement_required") => {
            Err("computer_agent_mcp_unavailable")
        }
        _ => Err("computer_agent_mcp_unavailable"),
    }
}

/// `McpRevealResult` (`mcp.rs:255-272`) is
/// `{"status":"ok","serverId":…,"configDigest":…,"definitionJson":…}`,
/// `{"status":"conflict","actualConfigDigest":…}` or `{"status":"invalid","issues":[…]}`.
///
/// Only an `ok` reply that names *exactly* the requested server id at the same digest may
/// carry a definition, and that definition must be strict JSON. Conflict, invalid, a wrong
/// id, a wrong digest, missing data and undecodable JSON all fail closed: there is no
/// fallback to the masked public `definitionJson`, which would otherwise let a replaced
/// server inherit the grant. The body is returned as the caller's transient value only;
/// nothing here logs, stores or echoes it.
fn revealed_definition(
    value: &Value,
    server_id: &str,
    digest: &str,
) -> Result<String, &'static str> {
    match value.get("status").and_then(Value::as_str) {
        Some("ok") => {}
        // Core moved past the digest this grant just read: never retry blindly.
        Some("conflict") => return Err("computer_agent_digest_mismatch"),
        _ => return Err("computer_agent_mcp_unavailable"),
    }
    if value.get("serverId").and_then(Value::as_str) != Some(server_id)
        || value.get("configDigest").and_then(Value::as_str) != Some(digest)
    {
        return Err("computer_agent_mcp_unavailable");
    }
    let definition = value
        .get("definitionJson")
        .and_then(Value::as_str)
        .ok_or("computer_agent_mcp_unavailable")?;
    serde_json::from_str::<Value>(definition).map_err(|_| "computer_agent_mcp_unavailable")?;
    Ok(definition.to_owned())
}

/// The MCP server name is the single key of our own definition object.
fn definition_name(definition: &str) -> Option<String> {
    serde_json::from_str::<Value>(definition)
        .ok()?
        .get("mcpServers")?
        .as_object()?
        .keys()
        .next()
        .cloned()
}

fn server_id_by_name(servers: &[Value], name: &str) -> Option<String> {
    servers
        .iter()
        .find(|server| server.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|server| server.get("serverId").and_then(Value::as_str))
        .map(str::to_owned)
}

impl McpOps for CoreMcp {
    fn digest(&self, owner: String) -> BoxFuture<'static, Result<String, &'static str>> {
        let core = self.clone_inner();
        Box::pin(async move { core.current_digest(&owner).await })
    }

    fn server(
        &self,
        owner: String,
        server_id: String,
    ) -> BoxFuture<'static, Result<Option<ServerState>, &'static str>> {
        let core = self.clone_inner();
        Box::pin(async move { core.current_server(&owner, &server_id).await })
    }

    fn assistant(
        &self,
        owner: String,
        agent_id: String,
    ) -> BoxFuture<'static, Result<AssistantInfo, &'static str>> {
        let core = self.clone_inner();
        Box::pin(async move {
            let member = core
                .call("members.get", json!({"agentId": agent_id.clone()}), &owner)
                .await
                .map_err(|_| "computer_agent_assistant_unknown")?;
            // `MemberTargetGetParams` is `{ memberId }` with `deny_unknown_fields`.
            let target = core
                .call(
                    "members.executionTarget.get",
                    json!({"memberId": agent_id}),
                    &owner,
                )
                .await;
            Ok(assistant_from_member(&member, target))
        })
    }

    fn create(
        &self,
        owner: String,
        digest: String,
        definition: String,
    ) -> BoxFuture<'static, Result<(String, String), &'static str>> {
        let core = self.clone_inner();
        Box::pin(async move {
            let name = definition_name(&definition).ok_or("computer_agent_cleanup_unconfirmed")?;
            let value = core
                .call(
                    "mcp.servers.create",
                    json!({"expectedConfigDigest": digest, "definitionJson": definition}),
                    &owner,
                )
                .await?;
            let view = mutation(&value)?;
            // The created id must come from the mutation's own config snapshot: guessing
            // it would make later cleanup target the wrong server.
            let server_id = server_id_by_name(&view.servers, &name)
                .ok_or("computer_agent_cleanup_unconfirmed")?;
            Ok((server_id, view.digest))
        })
    }

    fn set_members(
        &self,
        owner: String,
        digest: String,
        server_id: String,
        agent_id: String,
    ) -> BoxFuture<'static, Result<String, &'static str>> {
        let core = self.clone_inner();
        Box::pin(async move {
            let value = core
                .call(
                    "mcp.servers.setMembers",
                    json!({"expectedConfigDigest": digest, "serverId": server_id,
                        "agentIds": [agent_id], "acknowledgeHighRisk": false}),
                    &owner,
                )
                .await?;
            // The mutation reply carries the new digest; no second read is needed.
            Ok(mutation(&value)?.digest)
        })
    }

    fn set_enabled(
        &self,
        owner: String,
        digest: String,
        server_id: String,
        enabled: bool,
    ) -> BoxFuture<'static, Result<String, &'static str>> {
        let core = self.clone_inner();
        Box::pin(async move {
            let value = core
                .call(
                    "mcp.servers.setEnabled",
                    json!({"expectedConfigDigest": digest, "serverId": server_id, "enabled": enabled}),
                    &owner,
                )
                .await?;
            Ok(mutation(&value)?.digest)
        })
    }

    fn delete(
        &self,
        owner: String,
        digest: String,
        server_id: String,
    ) -> BoxFuture<'static, Result<(), &'static str>> {
        let core = self.clone_inner();
        Box::pin(async move {
            let value = core
                .call(
                    "mcp.servers.delete",
                    json!({"expectedConfigDigest": digest, "serverId": server_id}),
                    &owner,
                )
                .await?;
            mutation(&value)?;
            Ok(())
        })
    }
}

/// Used when the Host has not enabled the feature; every call fails closed.
struct DisabledMcp;

fn disabled_code() -> &'static str {
    "computer_agent_unsupported"
}

impl McpOps for DisabledMcp {
    fn digest(&self, _owner: String) -> BoxFuture<'static, Result<String, &'static str>> {
        Box::pin(async { Err(disabled_code()) })
    }
    fn assistant(
        &self,
        _owner: String,
        _agent_id: String,
    ) -> BoxFuture<'static, Result<AssistantInfo, &'static str>> {
        Box::pin(async { Err(disabled_code()) })
    }
    fn create(
        &self,
        _owner: String,
        _digest: String,
        _definition: String,
    ) -> BoxFuture<'static, Result<(String, String), &'static str>> {
        Box::pin(async { Err(disabled_code()) })
    }
    fn set_members(
        &self,
        _owner: String,
        _digest: String,
        _server_id: String,
        _agent_id: String,
    ) -> BoxFuture<'static, Result<String, &'static str>> {
        Box::pin(async { Err(disabled_code()) })
    }
    fn set_enabled(
        &self,
        _owner: String,
        _digest: String,
        _server_id: String,
        _enabled: bool,
    ) -> BoxFuture<'static, Result<String, &'static str>> {
        Box::pin(async { Err(disabled_code()) })
    }
    fn delete(
        &self,
        _owner: String,
        _digest: String,
        _server_id: String,
    ) -> BoxFuture<'static, Result<(), &'static str>> {
        Box::pin(async { Err(disabled_code()) })
    }
    fn server(
        &self,
        _owner: String,
        _server_id: String,
    ) -> BoxFuture<'static, Result<Option<ServerState>, &'static str>> {
        Box::pin(async { Err(disabled_code()) })
    }
}

pub(crate) struct AgentGrants {
    config: Option<Config>,
    mcp: Arc<dyn McpOps>,
    grants: Mutex<HashMap<[u8; 32], Arc<Grant>>>,
}

impl AgentGrants {
    /// Production factory. `data_dir` is the Host-owned private data directory, so no
    /// client can choose where grant tokens live.
    pub(crate) fn from_env(data_dir: &Path, port: u16) -> Arc<Self> {
        Self::with_config(Config::from_env(data_dir, port), Arc::new(DisabledMcp))
    }

    /// Core-backed production instance.
    pub(crate) fn with_core(
        data_dir: &Path,
        port: u16,
        core: rovai_core::application::CoreService,
    ) -> Arc<Self> {
        Self::with_config(Config::from_env(data_dir, port), Arc::new(CoreMcp { core }))
    }

    fn with_config(config: Option<Config>, mcp: Arc<dyn McpOps>) -> Arc<Self> {
        if let Some(config) = &config {
            // Startup discards our own prior token files: sessions are in memory, so a
            // token from a previous process can never be valid again.
            if rovai_core::platform::prepare_private_directory(&config.root).is_ok() {
                if let Ok(entries) = std::fs::read_dir(&config.root) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file()
                            && path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| name.starts_with(TOKEN_PREFIX))
                        {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                }
            }
        }
        Arc::new(Self {
            config,
            mcp,
            grants: Mutex::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    fn for_test(mcp: Arc<dyn McpOps>) -> Arc<Self> {
        let root = std::env::temp_dir().join(format!("loom-grants-{}", crate::new_token().unwrap()));
        Self::with_config(
            Some(Config {
                python: PathBuf::from("/nonexistent/python"),
                bridge: PathBuf::from("/nonexistent/mcp_bridge.py"),
                origin: "http://127.0.0.1:8443".to_owned(),
                root,
            }),
            mcp,
        )
    }

    pub(crate) fn report(&self) -> Value {
        json!({
            "configured": self.config.is_some(),
            "reason": if self.config.is_some() { Value::Null } else { json!("computer_agent_unsupported") },
            "maxGrants": MAX_GRANTS,
            "maxGrantSeconds": MAX_GRANT_MS / 1000,
            "maxRequestIds": MAX_RECEIPTS,
            "runtimes": RUNTIMES,
            "piEnabled": runtime_supported("pi"),
            "tools": TOOLS,
        })
    }

    fn supported(&self) -> Result<&Config, &'static str> {
        self.config.as_ref().ok_or("computer_agent_unsupported")
    }

    /// Reserve a slot before any Core write. Pending grants are never swept, so the cap
    /// counts in-flight attempts too.
    fn reserve(&self, grant: Arc<Grant>) -> Result<(), &'static str> {
        let mut grants = self.grants.lock().map_err(|_| "computer_agent_limit")?;
        if grants.len() >= MAX_GRANTS {
            return Err("computer_agent_limit");
        }
        for existing in grants.values() {
            // `closed` is the liveness marker for the conflict test, not `revoked`: a
            // reservation is created with `revoked` already set (it has no browser token
            // yet), so keying on `revoked` would let two concurrent creations for the same
            // assistant+device+scope both pass and publish duplicate servers.
            let same = existing.authority.bot_id == grant.authority.bot_id
                && existing.authority.device_id == grant.authority.device_id
                && existing.authority.permission == grant.authority.permission
                && !existing.closed.load(Ordering::Acquire)
                && wall_clock() < existing.expires_at;
            if same {
                // One active grant per assistant+device+scope. Replacing it is an
                // explicit revoke by the user, never an implicit overwrite.
                return Err("computer_agent_grant_conflict");
            }
        }
        grants.insert(grant.digest, grant);
        Ok(())
    }

    fn publish(&self, grant: Arc<Grant>) {
        if let Ok(mut grants) = self.grants.lock() {
            grants.insert(grant.digest, grant);
        }
    }

    fn forget(&self, digest: &[u8; 32]) {
        if let Ok(mut grants) = self.grants.lock() {
            grants.remove(digest);
        }
    }

    fn find(&self, digest: &[u8; 32]) -> Option<Arc<Grant>> {
        self.grants.lock().ok()?.get(digest).cloned()
    }

    /// Grants belonging to one browser session. Expired grants stay visible so the UI can
    /// report `expired` and the user can still revoke (and fence) them; the owner filter is
    /// what keeps one tab from touching another tab's grant.
    fn owned(&self, client_id: &str, _now: u64) -> Vec<Arc<Grant>> {
        let Ok(grants) = self.grants.lock() else {
            return Vec::new();
        };
        grants
            .values()
            .filter(|grant| grant.owner_id() == client_id)
            .filter(|grant| !grant.pending.load(Ordering::Acquire))
            .cloned()
            .collect()
    }

    /// Retire every grant that is revoked or expired. The map lock is released before any
    /// fence or Core call, so this can never deadlock against a tool call.
    async fn retire_due(&self, computer: &Arc<Computer>, now: u64) {
        let due: Vec<Arc<Grant>> = {
            let Ok(grants) = self.grants.lock() else {
                return;
            };
            grants
                .values()
                .filter(|grant| !grant.pending.load(Ordering::Acquire))
                .filter(|grant| {
                    grant.revoked.load(Ordering::Acquire)
                        || now >= grant.expires_at
                        // A logged-out or rotated browser session must retire the MCP
                        // entry too, not only block tool calls, or it stays enabled
                        // until the TTL.
                        || !grant.owner_sessions.is_live(&grant.owner)
                })
                .cloned()
                .collect()
        };
        for grant in due {
            // Retained while the cleanup is unconfirmed, so the next sweep retries it.
            if retire(computer, &self.mcp, &grant).await.is_ok() {
                self.forget(&grant.digest);
            }
        }
    }
}

fn token_file_path(config: &Config) -> Result<PathBuf, &'static str> {
    let leaf = format!(
        "{TOKEN_PREFIX}{}",
        crate::new_token().map_err(|_| "computer_agent_unsupported")?
    );
    Ok(config.root.join(leaf))
}

fn write_token(path: &Path, token: &str) -> Result<(), &'static str> {
    rovai_core::platform::atomic_write_private_bytes(path, token.as_bytes())
        .map_err(|_| "computer_agent_unsupported")
}

fn definition_json(
    config: &Config,
    grant_id: &str,
    token_path: &Path,
    bridge_authority: &str,
    authority: &Authority,
) -> String {
    let mut servers = serde_json::Map::new();
    servers.insert(
        format!(
            "loom-computer-agent-{}",
            &grant_id[..grant_id.len().min(8)]
        ),
        json!({
            "command": config.python.display().to_string(),
            "args": [config.bridge.display().to_string()],
            "env": {
                "LOOM_COMPUTER_AGENT_GRANT": grant_id,
                "LOOM_COMPUTER_AGENT_ENDPOINT": format!("http://{bridge_authority}{RPC_PATH}"),
                "LOOM_COMPUTER_AGENT_ORIGIN": config.origin,
                // Non-secret identity, in the shape Mikka's lease guard checks
                // (`driver.mjs`): who the reviewed member is, which runtime it runs and
                // which permission the user granted. The bridge refuses to start when the
                // runtime is not the Pi family or the identity is malformed, so a
                // definition minted for another runtime can never serve tool calls. The
                // Host still re-derives all of this from its own state on every call.
                "LOOM_COMPUTER_AGENT_RUNTIME": authority.runtime,
                "LOOM_COMPUTER_AGENT_SUBJECT": authority.bot_id,
                "LOOM_COMPUTER_AGENT_SCOPE": authority.permission.label(),
                // Non-secret: the reviewed configuration revision (the authority's
                // `policyVersion`), which the bridge echoes on every tool call.
                "LOOM_COMPUTER_AGENT_DIGEST": authority.policy_version,
                // Path only. The secret never enters a Core-stored configuration.
                "LOOM_COMPUTER_AGENT_TOKEN_FILE": token_path.display().to_string(),
            },
        }),
    );
    json!({"mcpServers": servers}).to_string()
}

/// Tear a grant down. Order matters:
/// 1. **invalidate physical input first**: `revoked` is set before anything else, so the
///    computer guard refuses every queued or later OS call from this instant — including
///    the case where steps 2-4 fail;
/// 2. fence the physical device while the private session is still registered (the
///    provider refuses `release`/`stop` from a dead session), bounded, and record whether
///    that fence could actually be proven;
/// 3. remove the token file, so the bridge fails closed immediately. The private session is
///    only revoked once the device is provably free: a failed fence keeps it alive so a
///    later retry can still release the lease;
/// 4. clean up the exact MCP server id, retryably.
///
/// Returns `Err(computer_agent_cleanup_unconfirmed)` when the fence or the MCP cleanup
/// could not be confirmed. `cleaned` stays `false` in that case, callers keep the row
/// visible, and a later sweep retries — nothing ever claims a completed cleanup it did not
/// observe.
async fn retire(
    computer: &Arc<Computer>,
    mcp: &Arc<dyn McpOps>,
    grant: &Arc<Grant>,
) -> Result<(), &'static str> {
    // Step 1: physical input dies here, before any fallible step below.
    grant.revoked.store(true, Ordering::Release);
    grant.closed.store(true, Ordering::Release);
    if grant.cleaned.load(Ordering::Acquire) {
        return Ok(());
    }
    // Step 2: bounded, because a wedged physical gate must not hold a revocation open.
    let worker = (computer.clone(), grant.clone());
    let fenced = match tokio::time::timeout(
        RETIRE_DEADLINE,
        tokio::task::spawn_blocking(move || fence(&worker.0, &worker.1)),
    )
    .await
    {
        Ok(Ok(fenced)) => fenced,
        // An unobserved, panicking or timed-out fence is unproven, never success.
        _ => false,
    };
    // Step 3: the token file always goes, whether or not the fence was proven.
    if let Some(path) = &grant.token_path {
        let _ = std::fs::remove_file(path);
    }
    if fenced {
        let _ = grant.sessions.revoke(&grant.session);
        grant.session.expires_at.send_replace(0);
    }
    // Step 4: retryable MCP cleanup of the exact server id.
    let provisioned = cleanup_mcp(mcp, grant).await;
    if fenced && provisioned.is_ok() {
        grant.cleaned.store(true, Ordering::Release);
        Ok(())
    } else {
        // Never report completion; the row stays and `retire_due` tries again.
        Err("computer_agent_cleanup_unconfirmed")
    }
}

/// Disable then delete the exact server this grant created.
///
/// Nothing here is best-effort-by-assumption: the disable is re-read before the delete, and
/// a server that is still enabled after being disabled is reported as unconfirmed.
async fn cleanup_mcp(mcp: &Arc<dyn McpOps>, grant: &Grant) -> Result<(), &'static str> {
    let server_id = grant.server_id();
    if server_id.is_empty() {
        // Nothing was ever provisioned (the creation failed before `create` returned).
        return Ok(());
    }
    let owner = grant.owner_id().to_owned();
    // Read first: a server deleted by another path must not turn a retry into an error.
    let Some(current) = mcp.server(owner.clone(), server_id.clone()).await? else {
        return Ok(());
    };
    let digest = mcp.digest(owner.clone()).await?;
    let next = if current.enabled {
        mcp.set_enabled(owner.clone(), digest, server_id.clone(), false)
            .await?
    } else {
        digest
    };
    // Re-read, because a disable that did not take effect is not progress.
    match mcp.server(owner.clone(), server_id.clone()).await? {
        Some(server) if server.enabled => Err("computer_agent_mcp_unavailable"),
        Some(_) => mcp.delete(owner, next, server_id).await,
        // Removed in the meantime: equally gone, and no delete to fail on.
        None => Ok(()),
    }
}

/// Retire, and drop the row only when the cleanup was confirmed.
///
/// A grant whose fence or MCP cleanup could not be proven stays in the registry: `list`
/// keeps showing it and `retire_due` retries it. Forgetting it would erase the only record
/// of a server that may still exist.
async fn try_retire(state: &WebState, grant: &Arc<Grant>) -> Result<(), &'static str> {
    match retire(&state.computer, &state.agents.mcp, grant).await {
        Ok(()) => {
            state.agents.forget(&grant.digest);
            Ok(())
        }
        Err(code) => Err(code),
    }
}

fn run_view(grant: &Grant) -> Option<String> {
    grant.run.lock().ok().and_then(|run| run.view_id.clone())
}

fn run_control(grant: &Grant) -> Option<String> {
    grant.run.lock().ok().and_then(|run| run.control_id.clone())
}

fn run_generation(grant: &Grant) -> u64 {
    grant.run.lock().map(|run| run.generation).unwrap_or(0)
}

/// Release the physical device and report whether that is *proven*. Runs on a blocking
/// thread while the private session is still live, which the provider requires.
fn fence(computer: &Computer, grant: &Grant) -> bool {
    let view = run_view(grant);
    let control = run_control(grant);
    let generation = run_generation(grant);
    let mut fenced = true;
    if let (Some(view), Some(control)) = (view.clone(), control) {
        fenced = matches!(
            computer.release_control(
                &grant.sessions,
                &grant.session,
                ReleaseBody {
                    view_id: view,
                    control_id: control,
                    generation,
                },
            ),
            Ok(_)
                | Err("computer_control_required")
                | Err("computer_input_stale")
                | Err("computer_lease_expired")
                | Err("computer_view_unknown")
        );
    }
    if let Some(view) = view {
        fenced &= matches!(
            computer.stop_view(&grant.sessions, &grant.session, StopBody { view_id: view }),
            Ok(_) | Err("computer_view_unknown")
        );
    }
    fenced
}

// ------------------------------------------------------------------ handlers

pub(crate) async fn grant(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<GrantBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return reject("computer_agent_invalid_request");
    };
    let agents = state.agents.clone();
    let config = match agents.supported() {
        Ok(config) => config.clone(),
        Err(code) => return reject(code),
    };
    if !body.consent {
        return reject("computer_agent_consent_required");
    }
    let Some(scope) = Scope::parse(&body.scope) else {
        return reject("computer_agent_invalid_request");
    };
    if !state.sessions.is_live(&session) {
        return reject("session_required");
    }
    agents.retire_due(&state.computer, wall_clock()).await;
    let status = match state.computer.status(&state.sessions, &session) {
        Ok(status) => status,
        Err(code) => return reject(agent_computer_code(code)),
    };
    let device_id = status["device"]["deviceId"].as_str().unwrap_or_default();
    if device_id.is_empty() {
        return reject("computer_agent_view_unavailable");
    }
    if body.device_id != device_id {
        return reject("computer_agent_device_mismatch");
    }
    let transport_origin = match state.network.public_origin() {
        Some(origin) => origin.to_owned(),
        None => match state.network.addresses() {
            Ok(addresses) => addresses
                .first()
                .map(|address| address.origin.clone())
                .unwrap_or_default(),
            Err(_) => String::new(),
        },
    };
    if transport_origin.is_empty() {
        return reject("computer_agent_origin_denied");
    }
    let bridge_authority = match authority(&config.origin) {
        Some(authority) => authority.to_owned(),
        None => return reject("computer_agent_origin_denied"),
    };
    if !state
        .network
        .allows(Some(&bridge_authority), Some(&config.origin))
    {
        return reject("computer_agent_origin_denied");
    }

    // The reviewed digest is compared exactly. A newer configuration is never adopted
    // silently: the user must look at it again.
    let owner = session.client_id.clone();
    let current = match agents.mcp.digest(owner.clone()).await {
        Ok(digest) => digest,
        Err(code) => return reject(code),
    };
    if current != body.expected_config_digest {
        return reject("computer_agent_digest_mismatch");
    }

    // The assistant must exist, must not be removed, must run an accepted adapter and
    // must execute on this local Host.
    let assistant = match agents
        .mcp
        .assistant(owner.clone(), body.assistant_id.clone())
        .await
    {
        Ok(assistant) => assistant,
        Err(code) => return reject(code),
    };
    if let Err(code) = assistant_admissible(&assistant) {
        return reject(code);
    }
    if !state.sessions.is_live(&session) {
        return reject("session_required");
    }

    let ttl = u64::from(body.ttl_seconds).saturating_mul(1000);
    let lifetime = if ttl == 0 {
        DEFAULT_GRANT_MS
    } else {
        ttl.min(MAX_GRANT_MS)
    };
    let expires_at = wall_clock() + lifetime;

    // Private registry: a fresh random administrator that exists only in memory, and a
    // private session whose client id can never collide with the browser's.
    let mut prepared = None;
    for _ in 0..4 {
        let administrator = match crate::new_token() {
            Ok(token) => token,
            Err(_) => return reject("computer_agent_unsupported"),
        };
        let candidate = match crate::new_token() {
            Ok(token) => token,
            Err(_) => return reject("computer_agent_unsupported"),
        };
        if candidate == session.client_id {
            continue;
        }
        let Ok(opened) = Sessions::new(&administrator) else {
            return reject("computer_agent_unsupported");
        };
        let Ok(generation) = opened.authorize_login(&administrator) else {
            return reject("computer_agent_unsupported");
        };
        let Ok((token, private_session)) = opened.issue(generation, candidate) else {
            return reject("computer_agent_unsupported");
        };
        prepared = Some((Arc::new(opened), token, private_session));
        break;
    }
    let Some((registry, token, private_session)) = prepared else {
        return reject("computer_agent_unsupported");
    };

    let token_path = match token_file_path(&config) {
        Ok(path) => path,
        Err(code) => return reject(code),
    };
    if rovai_core::platform::prepare_private_directory(&config.root).is_err() {
        return reject("computer_agent_unsupported");
    }
    if let Err(code) = write_token(&token_path, &token) {
        let _ = std::fs::remove_file(&token_path);
        return reject(code);
    }
    let grant_id = match crate::new_token() {
        Ok(id) => id,
        Err(_) => {
            let _ = std::fs::remove_file(&token_path);
            return reject("computer_agent_unsupported");
        }
    };
    let mut hasher = Sha256::new();
    hasher.update(b"rovai-computer-agent-v1\0");
    hasher.update(token.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    // The authority identity is fixed here, once, from reviewed Host state: the browser
    // session that consented, the admitted member, its own runtime and device, the granted
    // scope and the reviewed configuration revision. Nothing later can supply or widen it.
    let authority = Authority {
        owner_id: owner.clone(),
        bot_id: body.assistant_id.clone(),
        runtime: assistant.adapter.clone(),
        device_id: device_id.to_owned(),
        permission: scope,
        policy_version: body.expected_config_digest.clone(),
    };
    let definition = definition_json(
        &config,
        &grant_id,
        &token_path,
        &bridge_authority,
        &authority,
    );
    // Recorded before the registry write, so the value that authorizes later tool calls is
    // the one this Host minted, not whatever Core happens to hold afterwards.
    let Ok(expected_definition) = serde_json::from_str::<Value>(&definition) else {
        let _ = std::fs::remove_file(&token_path);
        return reject("computer_agent_unsupported");
    };

    let pending = Arc::new(Grant {
        id: grant_id.clone(),
        owner: session.clone(),
        owner_sessions: state.sessions.clone(),
        authority,
        created_server_id: Mutex::new(String::new()),
        transport_origin,
        bridge_origin: config.origin.clone(),
        digest,
        sessions: registry,
        session: private_session,
        // The pending record never owns the token file; only the live grant does.
        token_path: None,
        expires_at,
        pending: AtomicBool::new(true),
        revoked: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        cleaned: AtomicBool::new(false),
        receipts: Mutex::new(Receipts {
            seen: HashSet::new(),
        }),
        expected_definition: Mutex::new(Some(expected_definition.clone())),
        run: Mutex::new(RunState::default()),
    });
    if let Err(code) = agents.reserve(pending.clone()) {
        let _ = std::fs::remove_file(&token_path);
        return reject(code);
    }

    // Digest-chained wiring. Every write revalidates the browser session first, and each
    // write uses the digest the previous step actually reported.
    let outcome = run_creation(&agents, &state.sessions, &pending, &owner, definition).await;

    match outcome {
        Ok(server_id) => {
            if let Err(code) = admit_pending(&pending, &state.sessions) {
                // The user logged out or the grant expired while Core was working: the
                // server that already exists must be cleaned up, not published.
                let cleanup = retire(&state.computer, &agents.mcp, &pending).await;
                agents.forget(&pending.digest);
                let _ = std::fs::remove_file(&token_path);
                if cleanup.is_err() {
                    return reject("computer_agent_cleanup_unconfirmed");
                }
                return reject(code);
            }
            let live = Arc::new(Grant {
                id: pending.id.clone(),
                owner: pending.owner.clone(),
                owner_sessions: pending.owner_sessions.clone(),
                authority: pending.authority.clone(),
                created_server_id: Mutex::new(server_id),
                transport_origin: pending.transport_origin.clone(),
                bridge_origin: pending.bridge_origin.clone(),
                digest: pending.digest,
                sessions: pending.sessions.clone(),
                session: pending.session.clone(),
                token_path: Some(token_path.clone()),
                expires_at: pending.expires_at,
                pending: AtomicBool::new(false),
                revoked: AtomicBool::new(false),
                closed: AtomicBool::new(false),
                cleaned: AtomicBool::new(false),
                receipts: Mutex::new(Receipts {
                    seen: HashSet::new(),
                }),
                expected_definition: Mutex::new(Some(expected_definition)),
                run: Mutex::new(RunState::default()),
            });
            agents.publish(live.clone());
            Json(public_grant(&live, wall_clock())).into_response()
        }
        Err(code) => {
            // Fail closed: fence and invalidate first, then the best-effort MCP cleanup
            // of whatever server id is actually known.
            // This reservation was never published, so no browser ever held its id: it is
            // dropped either way, because a stuck reservation would occupy a slot and
            // block the user's retry with `grant_conflict`.
            let cleanup = retire(&state.computer, &agents.mcp, &pending).await;
            agents.forget(&pending.digest);
            let _ = std::fs::remove_file(&token_path);
            if code == "computer_agent_cleanup_unconfirmed" || cleanup.is_err() {
                return reject("computer_agent_cleanup_unconfirmed");
            }
            reject(code)
        }
    }
}

async fn run_creation(
    agents: &Arc<AgentGrants>,
    sessions: &Sessions,
    pending: &Arc<Grant>,
    owner: &str,
    definition: String,
) -> Result<String, &'static str> {
    let mut digest = agents.mcp.digest(owner.to_owned()).await?;
    // Pending admission: this grant has no browser token yet, so `revoked` is still set.
    admit_pending(pending, sessions)?;
    let (server_id, next) = agents
        .mcp
        .create(owner.to_owned(), digest, definition)
        .await?;
    // Recorded immediately: a later failure must be able to delete this exact server.
    pending.record_server(&server_id);
    digest = next;
    admit_pending(pending, sessions)?;
    digest = agents
        .mcp
        .set_members(
            owner.to_owned(),
            digest,
            server_id.clone(),
            pending.authority.bot_id.clone(),
        )
        .await?;
    admit_pending(pending, sessions)?;
    let final_digest = agents
        .mcp
        .set_enabled(owner.to_owned(), digest, server_id.clone(), true)
        .await?;
    if final_digest.is_empty() {
        return Err("computer_agent_mcp_unavailable");
    }
    admit_pending(pending, sessions)?;
    Ok(server_id)
}

fn agent_computer_code(code: &'static str) -> &'static str {
    match code {
        "computer_unsupported" | "computer_unavailable" => "computer_agent_unsupported",
        "computer_busy" | "computer_throttled" => "computer_agent_endpoint_busy",
        "computer_backend_unavailable"
        | "computer_encoder_unavailable"
        | "computer_session_locked" => "computer_agent_view_unavailable",
        _ => "computer_agent_capture_failed",
    }
}

pub(crate) async fn list(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
) -> Response {
    let now = wall_clock();
    state.agents.retire_due(&state.computer, now).await;
    let owned: Vec<Value> = state
        .agents
        .owned(&session.client_id, now)
        .iter()
        .map(|grant| public_grant(grant, now))
        .collect();
    Json(json!({"grants": owned, "limits": state.agents.report()})).into_response()
}

pub(crate) async fn revoke(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<RevokeBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return reject("computer_agent_invalid_request");
    };
    let found = state
        .agents
        .owned(&session.client_id, wall_clock())
        .into_iter()
        .find(|grant| grant.id == body.grant_id);
    let Some(grant) = found else {
        // Another tab's grant is not even acknowledged.
        return reject("computer_agent_grant_unknown_for_owner");
    };
    let grant_id = grant.id.clone();
    match retire(&state.computer, &state.agents.mcp, &grant).await {
        Ok(()) => {
            state.agents.forget(&grant.digest);
            Json(json!({"revoked": true, "grantId": grant_id})).into_response()
        }
        // The fence or the MCP cleanup could not be proven: never claim a clean revoke,
        // and keep the row so `list` shows it and the next attempt can retry.
        Err(_) => reject("computer_agent_cleanup_unconfirmed"),
    }
}

/// The private transport. It is deliberately **outside** the browser `authenticate`
/// middleware: the token is not a browser session and no general route accepts it. The
/// route still sits inside the existing Origin/Host boundary.
pub(crate) async fn rpc(
    State(state): State<WebState>,
    headers: HeaderMap,
    body: Result<Json<RpcBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return reject("computer_agent_invalid_request");
    };
    if body.request_id.is_empty()
        || body.request_id.len() > MAX_REQUEST_ID
        || !body
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return rpc_error(&body.request_id, "computer_agent_invalid_request");
    }
    let Some(tool) = Tool::parse(&body.tool) else {
        return rpc_error(&body.request_id, "computer_agent_invalid_request");
    };
    let Some(token) = bearer(&headers) else {
        return rpc_error(&body.request_id, "computer_agent_grant_unknown");
    };
    let mut hasher = Sha256::new();
    hasher.update(b"rovai-computer-agent-v1\0");
    hasher.update(token.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    let now = wall_clock();
    let Some(grant) = state.agents.find(&digest) else {
        return rpc_error(&body.request_id, "computer_agent_grant_unknown");
    };
    if let Err(code) = admit(&grant, &state.sessions) {
        // Owner logged out, grant expired or revoked: retire it now, before answering.
        let _ = try_retire(&state, &grant).await;
        return rpc_error(&body.request_id, code);
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin != Some(grant.bridge_origin.as_str()) {
        return rpc_error(&body.request_id, "computer_agent_origin_denied");
    }
    if body.expected_config_digest != grant.authority.policy_version {
        // The bridge must echo the configuration the user reviewed. A newer Core
        // configuration never silently inherits an older grant.
        return rpc_error(&body.request_id, "computer_agent_digest_mismatch");
    }
    if let Err(code) = grant.authority.authorizes(tool) {
        return rpc_error(&body.request_id, code);
    }
    // Housekeeping is cheap because it only walks already-due grants.
    state.agents.retire_due(&state.computer, now).await;

    // Current member state, not the stamp recorded at grant time: a runtime switch, a
    // removed member or a new execution target revokes this grant before any OS call. This
    // is the gate that keeps a grant minted for Codex/DSH from serving after the member is
    // switched to Pi without the explicit opt-in.
    match admit_live_authority(state.agents.mcp.as_ref(), &grant).await {
        Ok(()) => {}
        // The member could not be read at all: fail closed without claiming a revocation.
        Err(code) if code == "computer_agent_assistant_unknown" => {
            return rpc_error(&body.request_id, code);
        }
        Err(code) => {
            let _ = try_retire(&state, &grant).await;
            return rpc_error(&body.request_id, code);
        }
    }

    // Current Core state, not the stored stamp: a Core-side disable, unassign or definition
    // replacement revokes an active grant before any OS call is admitted.
    match state
        .agents
        .mcp
        .server(grant.owner_id().to_owned(), grant.server_id())
        .await
    {
        Ok(Some(current)) => {
            if let Err(code) = server_authorizes(&current, &grant) {
                let _ = try_retire(&state, &grant).await;
                return rpc_error(&body.request_id, code);
            }
        }
        // The server is gone from the configuration, so the assistant no longer has this
        // tool at all.
        Ok(None) => {
            let _ = try_retire(&state, &grant).await;
            return rpc_error(&body.request_id, "computer_agent_grant_revoked");
        }
        // Unreadable configuration: fail closed without inventing a state.
        Err(code) => return rpc_error(&body.request_id, code),
    }

    let computer = state.computer.clone();
    let browser = state.sessions.clone();
    let task = grant.clone();
    let request_id = body.request_id.clone();
    let call_id = request_id.clone();
    let arguments = body.arguments.clone();
    let permit = match state.computer.try_job() {
        Ok(permit) => permit,
        Err(code) => return rpc_error(&request_id, code),
    };
    let outcome = tokio::time::timeout(
        RPC_DEADLINE,
        spawn_blocking(move || {
            // Bounded admission: a burst is refused instead of flooding the pool.
            let _permit = permit;
            run_tool(&computer, &browser, &task, tool, &call_id, arguments)
        }),
    )
    .await;
    let failure = match outcome {
        Ok(Ok(Ok(value))) => {
            if let Err(code) = admit(&grant, &state.sessions) {
                // The owner left while the bytes were being produced: discard them and
                // fence the grant rather than returning a result nobody authorized.
                let _ = try_retire(&state, &grant).await;
                return rpc_error(&request_id, code);
            }
            return Json(json!({"ok": true, "requestId": request_id, "result": value}))
                .into_response();
        }
        Ok(Ok(Err(failure))) => failure,
        // A timeout or a panicking worker leaves an OS call we cannot account for.
        Ok(Err(_)) | Err(_) => Failure::fatal("computer_agent_input_unknown"),
    };
    if failure.revoke {
        // Fence and forget BEFORE answering, so a queued worker cannot survive this
        // response: the admission closure now refuses it and the session is invalidated.
        // An unconfirmed cleanup keeps the row, and the caller is told so.
        if try_retire(&state, &grant).await.is_err() {
            return rpc_error(&request_id, "computer_agent_cleanup_unconfirmed");
        }
    }
    rpc_error(&request_id, failure.code)
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?;
    if value.len() > MAX_TOKEN_HEADER {
        return None;
    }
    let token = value.to_str().ok()?.strip_prefix("Bearer ")?;
    (token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| token.to_owned())
}

struct Failure {
    code: &'static str,
    revoke: bool,
}

/// Test-only: the code and the revoke flag, never the tool arguments.
#[cfg(test)]
impl std::fmt::Debug for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Failure")
            .field("code", &self.code)
            .field("revoke", &self.revoke)
            .finish_non_exhaustive()
    }
}

impl Failure {
    fn code(code: &'static str) -> Self {
        Self { code, revoke: false }
    }
    fn fatal(code: &'static str) -> Self {
        Self { code, revoke: true }
    }
}

fn map_computer(code: &'static str) -> Failure {
    if code.starts_with("computer_agent_") {
        return Failure::code(code);
    }
    match code {
        "computer_control_held" | "computer_control_required" => {
            Failure::code("computer_agent_control_held")
        }
        "computer_lease_expired" | "computer_input_stale" | "computer_view_unknown"
        | "computer_view_limit" => Failure::code("computer_agent_view_unavailable"),
        "computer_device_mismatch" => Failure::code("computer_agent_device_mismatch"),
        "computer_input_unknown" => Failure::fatal("computer_agent_input_unknown"),
        "computer_busy" | "computer_throttled" => Failure::code("computer_agent_endpoint_busy"),
        "session_required" => Failure::code("computer_agent_owner_session_required"),
        "computer_consent_required" => Failure::code("computer_agent_consent_required"),
        _ => Failure::code("computer_agent_capture_failed"),
    }
}

fn run_tool(
    computer: &Computer,
    browser: &Sessions,
    grant: &Grant,
    tool: Tool,
    request_id: &str,
    arguments: Value,
) -> Result<Value, Failure> {
    // Independent authorization first: a view grant reaches no synthetic input even when
    // the rest of the grant is healthy.
    grant.authority.authorizes(tool).map_err(Failure::code)?;
    // First check: refuse early instead of taking the grant gate for nothing.
    admit(grant, browser).map_err(Failure::code)?;
    let mut run = grant.gate().map_err(Failure::code)?;
    // Second check under the grant gate: the first one may be arbitrarily old.
    admit(grant, browser).map_err(Failure::code)?;
    // Consumed before anything reaches the OS: a repeated id can never replay a
    // keystroke, and an ambiguous failure still burns the id. The ledger has its own lock
    // and this guard is scoped, so it is never held across the OS call below and never
    // taken while waiting for the run gate; lock order is always run gate -> receipts.
    {
        let mut receipts = grant
            .receipts
            .lock()
            .map_err(|_| Failure::code("computer_agent_endpoint_busy"))?;
        if receipts.seen.len() >= MAX_RECEIPTS {
            return Err(Failure::code("computer_agent_request_capacity"));
        }
        if !receipts.seen.insert(request_id.to_owned()) {
            return Err(Failure::code("computer_agent_request_replayed"));
        }
    }
    let view_id = ensure_view(computer, grant, browser, &mut run)?;
    match tool {
        Tool::Screenshot => {
            let frame = capture(computer, grant, browser, &view_id, &mut run)?;
            let png = base64::engine::general_purpose::STANDARD.encode(&frame.png);
            Ok(json!({
                "pngBase64": png,
                "width": frame.width,
                "height": frame.height,
                "originX": frame.bounds.x,
                "originY": frame.bounds.y,
                "screenWidth": frame.bounds.width,
                "screenHeight": frame.bounds.height,
                "scale": frame.scale,
                "capturedAt": frame.captured_at,
            }))
        }
        Tool::MouseClick | Tool::Wheel | Tool::Key | Tool::Text => {
            let event = event_for(tool, arguments)?;
            send(computer, grant, browser, &mut run, &view_id, event)
        }
    }
}

fn ensure_view(
    computer: &Computer,
    grant: &Grant,
    browser: &Sessions,
    run: &mut RunState,
) -> Result<String, Failure> {
    if let Some(view) = &run.view_id {
        return Ok(view.clone());
    }
    admit(grant, browser).map_err(Failure::code)?;
    let value = computer
        .start_view(
            &grant.sessions,
            &grant.session,
            ViewBody {
                consent: true,
                device_id: grant.authority.device_id.clone(),
            },
        )
        .map_err(map_computer)?;
    let view = value["viewId"]
        .as_str()
        .ok_or_else(|| Failure::code("computer_agent_view_unavailable"))?
        .to_owned();
    run.view_id = Some(view.clone());
    Ok(view)
}

fn capture(
    computer: &Computer,
    grant: &Grant,
    browser: &Sessions,
    view_id: &str,
    run: &mut RunState,
) -> Result<computer::Frame, Failure> {
    let guard = || admit(grant, browser);
    let attempt = computer.frame_guarded(
        &grant.sessions,
        &grant.session,
        FrameBody {
            view_id: view_id.to_owned(),
            consent: true,
        },
        &guard,
    );
    match attempt {
        Ok((frame, _seq)) => Ok(frame),
        Err("computer_view_unknown") => {
            // A capture has no side effect, so re-creating the view is safe.
            run.view_id = None;
            let fresh = ensure_view(computer, grant, browser, run)?;
            computer
                .frame_guarded(
                    &grant.sessions,
                    &grant.session,
                    FrameBody {
                        view_id: fresh,
                        consent: true,
                    },
                    &guard,
                )
                .map(|(frame, _seq)| frame)
                .map_err(map_computer)
        }
        Err(code) => Err(map_computer(code)),
    }
}

fn ensure_control(
    computer: &Computer,
    grant: &Grant,
    browser: &Sessions,
    run: &mut RunState,
    view_id: &str,
) -> Result<(), Failure> {
    if run.control_id.is_some() {
        return Ok(());
    }
    admit(grant, browser).map_err(Failure::code)?;
    let value = computer
        .acquire(
            &grant.sessions,
            &grant.session,
            ControlBody {
                view_id: view_id.to_owned(),
                device_id: grant.authority.device_id.clone(),
                consent: true,
                ttl_seconds: TOOL_CONTROL_TTL_SECONDS,
            },
        )
        .map_err(map_computer)?;
    run.control_id = value["controlId"].as_str().map(str::to_owned);
    run.generation = value["generation"].as_u64().unwrap_or(0);
    if run.control_id.is_none() || run.generation == 0 {
        return Err(Failure::code("computer_agent_control_held"));
    }
    Ok(())
}

fn send(
    computer: &Computer,
    grant: &Grant,
    browser: &Sessions,
    run: &mut RunState,
    view_id: &str,
    event: EventBody,
) -> Result<Value, Failure> {
    ensure_control(computer, grant, browser, run, view_id)?;
    let guard = || admit(grant, browser);
    let retry_event = clone_event(&event);
    let send_once = |run: &mut RunState, event: EventBody| -> Result<Value, &'static str> {
        let seq = run.seq_high.wrapping_add(1);
        run.seq_high = seq;
        let input = InputBody {
            view_id: view_id.to_owned(),
            control_id: run.control_id.clone().unwrap_or_default(),
            generation: run.generation,
            seq,
            consent: true,
            event,
        };
        computer
            .input_guarded(&grant.sessions, &grant.session, input, &guard)
            .map(|_| json!({"seq": seq}))
    };
    match send_once(run, event) {
        Ok(value) => Ok(value),
        Err("computer_control_required")
        | Err("computer_lease_expired")
        | Err("computer_input_stale") => {
            // These refusals are proven pre-OS: nothing was typed, and the sequence was
            // not consumed. Reacquiring is allowed only while the device is free; a human
            // holder is never stolen.
            run.control_id = None;
            ensure_control(computer, grant, browser, run, view_id)?;
            send_once(run, retry_event).map_err(map_computer)
        }
        Err(code) => Err(map_computer(code)),
    }
}

fn clone_event(event: &EventBody) -> EventBody {
    EventBody {
        kind: event.kind,
        x: event.x,
        y: event.y,
        button: event.button,
        action: event.action,
        delta: event.delta,
        key: event.key,
        text: event.text.clone(),
    }
}

fn event_for(tool: Tool, arguments: Value) -> Result<EventBody, Failure> {
    let invalid = || Failure::code("computer_agent_invalid_request");
    let empty = |kind: EventKind| EventBody {
        kind,
        x: None,
        y: None,
        button: None,
        action: None,
        delta: None,
        key: None,
        text: None,
    };
    match tool {
        Tool::MouseClick => {
            let args: ClickArgs = serde_json::from_value(arguments).map_err(|_| invalid())?;
            let button: WireButton =
                serde_json::from_value(json!(args.button)).map_err(|_| invalid())?;
            Ok(EventBody {
                x: Some(args.x),
                y: Some(args.y),
                button: Some(button),
                action: Some(computer::WireAction::Click),
                ..empty(EventKind::Pointer)
            })
        }
        Tool::Wheel => {
            let args: WheelArgs = serde_json::from_value(arguments).map_err(|_| invalid())?;
            Ok(EventBody {
                x: Some(args.x),
                y: Some(args.y),
                delta: Some(args.delta),
                ..empty(EventKind::Wheel)
            })
        }
        Tool::Key => {
            let args: KeyArgs = serde_json::from_value(arguments).map_err(|_| invalid())?;
            let key: WireKey = serde_json::from_value(json!(args.key)).map_err(|_| invalid())?;
            Ok(EventBody {
                key: Some(key),
                ..empty(EventKind::Key)
            })
        }
        Tool::Text => {
            let args: TextArgs = serde_json::from_value(arguments).map_err(|_| invalid())?;
            Ok(EventBody {
                text: Some(args.text),
                ..empty(EventKind::Text)
            })
        }
        Tool::Screenshot => {
            let _: EmptyArgs = serde_json::from_value(arguments).map_err(|_| invalid())?;
            Err(invalid())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::{Bounds, DeviceInfo, Frame, InputCommand};
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;

    struct FakeMcp {
        digests: Mutex<Vec<String>>,
        calls: Mutex<Vec<(&'static str, Value)>>,
        /// What `assistant()` reports, i.e. the member as Core currently holds it.
        assistant: Mutex<AssistantInfo>,
        fail_enable: AtomicBool,
        fail_delete: AtomicBool,
        /// What `server()` reports. `None` means "absent from the configuration".
        current: Mutex<Option<ServerState>>,
    }

    impl FakeMcp {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                digests: Mutex::new((1..=16).map(|n| format!("{:064x}", n)).collect()),
                calls: Mutex::new(Vec::new()),
                assistant: Mutex::new(AssistantInfo {
                    // The real wire value of `AdapterKind::ClaudeCodeCli`.
                    adapter: "claude-code-cli".to_owned(),
                    removed: false,
                    target_local: true,
                }),
                fail_enable: AtomicBool::new(false),
                fail_delete: AtomicBool::new(false),
                current: Mutex::new(None),
            })
        }
        /// Publish what a later `server()` read sees, i.e. Core's current state.
        fn present(&self, enabled: bool, assigned: &[&str], definition: &str) {
            *self.current.lock().unwrap() = Some(ServerState {
                enabled,
                assigned: assigned.iter().map(|id| (*id).to_owned()).collect(),
                definition: definition.to_owned(),
            });
        }
        /// Publish what a later `assistant()` read sees: the reviewed member after the user
        /// changed its runtime, its execution target, or removed it.
        fn see_member(&self, adapter: &str, target_local: bool, removed: bool) {
            *self.assistant.lock().unwrap() = AssistantInfo {
                adapter: adapter.to_owned(),
                removed,
                target_local,
            };
        }
        fn next_digest(&self) -> String {
            let mut digests = self.digests.lock().unwrap();
            if digests.len() > 1 {
                digests.remove(0)
            } else {
                digests[0].clone()
            }
        }
        fn record(&self, name: &'static str, value: Value) {
            self.calls.lock().unwrap().push((name, value));
        }
        fn names(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().iter().map(|(n, _)| *n).collect()
        }
        fn serialized(&self) -> String {
            serde_json::to_string(&self.calls.lock().unwrap().clone()).unwrap()
        }
    }

    impl McpOps for FakeMcp {
        fn digest(&self, _owner: String) -> BoxFuture<'static, Result<String, &'static str>> {
            let value = self.next_digest();
            Box::pin(async move { Ok(value) })
        }
        fn assistant(
            &self,
            _owner: String,
            _agent_id: String,
        ) -> BoxFuture<'static, Result<AssistantInfo, &'static str>> {
            self.record("assistant", json!({}));
            let info = self.assistant.lock().unwrap().clone();
            Box::pin(async move { Ok(info) })
        }
        fn create(
            &self,
            _owner: String,
            digest: String,
            definition: String,
        ) -> BoxFuture<'static, Result<(String, String), &'static str>> {
            self.record("create", json!({"digest": digest, "definition": definition}));
            let next = self.next_digest();
            Box::pin(async move { Ok(("server-abc12345".to_owned(), next)) })
        }
        fn set_members(
            &self,
            _owner: String,
            digest: String,
            server_id: String,
            agent_id: String,
        ) -> BoxFuture<'static, Result<String, &'static str>> {
            self.record(
                "set_members",
                json!({"digest": digest, "serverId": server_id, "agentIds": [agent_id]}),
            );
            let next = self.next_digest();
            Box::pin(async move { Ok(next) })
        }
        fn set_enabled(
            &self,
            _owner: String,
            digest: String,
            server_id: String,
            enabled: bool,
        ) -> BoxFuture<'static, Result<String, &'static str>> {
            self.record(
                "set_enabled",
                json!({"digest": digest, "serverId": server_id, "enabled": enabled}),
            );
            let fail = self.fail_enable.load(Ordering::SeqCst);
            if !fail {
                // Core applies the write, so a later `server()` read must observe it.
                // `cleanup_mcp` re-reads after disabling and would otherwise see a still
                // enabled server and never reach `delete`.
                if let Some(state) = self.current.lock().unwrap().as_mut() {
                    state.enabled = enabled;
                }
            }
            let next = self.next_digest();
            Box::pin(async move {
                if fail {
                    return Err("computer_agent_mcp_unavailable");
                }
                Ok(next)
            })
        }
        fn delete(
            &self,
            _owner: String,
            digest: String,
            server_id: String,
        ) -> BoxFuture<'static, Result<(), &'static str>> {
            self.record("delete", json!({"digest": digest, "serverId": server_id}));
            let fail = self.fail_delete.load(Ordering::SeqCst);
            if !fail {
                // A confirmed delete removes the server from Core's configuration.
                *self.current.lock().unwrap() = None;
            }
            Box::pin(async move {
                if fail {
                    return Err("computer_agent_mcp_unavailable");
                }
                Ok(())
            })
        }
        fn server(
            &self,
            _owner: String,
            _server_id: String,
        ) -> BoxFuture<'static, Result<Option<ServerState>, &'static str>> {
            self.record("server", json!({}));
            let state = self.current.lock().unwrap().as_ref().map(|state| ServerState {
                enabled: state.enabled,
                assigned: state.assigned.clone(),
                definition: state.definition.clone(),
            });
            Box::pin(async move { Ok(state) })
        }
    }

    /// A provider that blocks inside `input` until the test releases it, so a second
    /// request really queues behind the physical gate.
    struct BlockingProvider {
        device: DeviceInfo,
        entered: Mutex<mpsc::Sender<()>>,
        proceed: Mutex<mpsc::Receiver<()>>,
        inputs: AtomicU64,
        captures: AtomicU64,
    }

    impl BlockingProvider {
        fn new(entered: mpsc::Sender<()>, proceed: mpsc::Receiver<()>) -> Arc<Self> {
            Arc::new(Self {
                device: DeviceInfo {
                    id: "sha256:blocking".to_owned(),
                    platform: "windows-gdi".to_owned(),
                    bounds: Bounds {
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                    },
                },
                entered: Mutex::new(entered),
                proceed: Mutex::new(proceed),
                inputs: AtomicU64::new(0),
                captures: AtomicU64::new(0),
            })
        }
    }

    impl computer::Provider for BlockingProvider {
        fn info(&self) -> Result<DeviceInfo, computer::Failure> {
            Ok(self.device.clone())
        }
        fn capture(&self, _max_width: u32, _max_height: u32) -> Result<Frame, computer::Failure> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            Ok(Frame {
                png: {
                    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
                    bytes.extend(std::iter::repeat_n(0x5a, 32));
                    bytes
                },
                width: 640,
                height: 480,
                bounds: self.device.bounds,
                scale: 0.33,
                captured_at: 1,
            })
        }
        fn input(&self, _command: &InputCommand) -> Result<(), computer::Failure> {
            let _ = self.entered.lock().unwrap().send(());
            let _ = self.proceed.lock().unwrap().recv();
            self.inputs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn release(&self) -> Result<(), computer::Failure> {
            // This fixture has no OS-held keys. The enclosing Computer input
            // gate still proves every deliberately blocked input has settled.
            Ok(())
        }
    }

    /// The authority every fixture grant is minted for: the Pi runtime, the one local
    /// device and the reviewed configuration digest.
    fn fixture_authority(owner: &Arc<Session>, permission: Scope) -> Authority {
        Authority {
            owner_id: owner.client_id.clone(),
            bot_id: "assistant-1".to_owned(),
            runtime: "pi".to_owned(),
            device_id: "sha256:blocking".to_owned(),
            permission,
            policy_version: "a".repeat(64),
        }
    }

    fn grant_for(
        browser: &Arc<Sessions>,
        owner: &Arc<Session>,
        expires_at: u64,
        revoked: bool,
    ) -> Arc<Grant> {
        let administrator = crate::new_token().unwrap();
        let registry = Arc::new(Sessions::new(&administrator).unwrap());
        // `LoginFailure` deliberately has no `Debug`, so these cannot be `unwrap`ped.
        let generation = registry
            .authorize_login(&administrator)
            .ok()
            .expect("administrator login must be authorized");
        let (_, session) = registry
            .issue(generation, crate::new_token().unwrap())
            .ok()
            .expect("session must be issued");
        Arc::new(Grant {
            id: "g".repeat(64),
            owner: owner.clone(),
            owner_sessions: browser.clone(),
            authority: fixture_authority(owner, Scope::Control),
            created_server_id: Mutex::new("server-abc12345".to_owned()),
            transport_origin: "http://127.0.0.1:8443".to_owned(),
            bridge_origin: "http://127.0.0.1:8443".to_owned(),
            digest: [7; 32],
            sessions: registry,
            session,
            token_path: None,
            expires_at,
            pending: AtomicBool::new(false),
            revoked: AtomicBool::new(revoked),
            closed: AtomicBool::new(false),
            cleaned: AtomicBool::new(false),
            receipts: Mutex::new(Receipts {
                seen: HashSet::new(),
            }),
            expected_definition: Mutex::new(Some(fixture_definition(&"g".repeat(64)))),
            run: Mutex::new(RunState::default()),
        })
    }

    fn browser() -> (Arc<Sessions>, Arc<Session>, String) {
        let token = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&token).unwrap());
        let (_, session) = sessions
            .login(&token)
            .ok()
            .expect("browser session must be issued");
        (sessions, session, token)
    }

    /// A computer whose provider never blocks; used by tests that only exercise
    /// revocation and cleanup bookkeeping.
    fn idle_computer() -> Arc<Computer> {
        let (entered, _entered_rx) = mpsc::channel();
        let (_proceed_tx, proceed) = mpsc::channel::<()>();
        let clock: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(|| 1_800_000_000_000u64);
        Arc::new(Computer::with_test_provider(
            BlockingProvider::new(entered, proceed),
            clock,
        ))
    }

    #[test]
    fn trusted_origins_are_literal_loopback_on_this_port() {
        assert_eq!(
            loopback_origin("http://127.0.0.1:8443", 8443).as_deref(),
            Some("http://127.0.0.1:8443")
        );
        for rejected in [
            "http://127.0.0.1:9999",
            "http://example.com:8443",
            "http://user@127.0.0.1:8443",
            "http://127.0.0.1:8443/path",
            "http://127.0.0.1:8443?a=1",
            "http://127.0.0.1:8443#frag",
            "ftp://127.0.0.1:8443",
        ] {
            assert!(loopback_origin(rejected, 8443).is_none(), "{rejected}");
        }
    }

    #[test]
    fn digests_are_read_from_core_views_or_rejected() {
        // The only digest Core reports is `sha256:` plus 64 lowercase hex characters
        // (`mcp.rs:1909`), and the string is kept byte for byte.
        let canonical = format!("sha256:{}", "0f".repeat(32));
        for accepted in [
            // The flat `McpConfigView` that `mcp.config.get` returns.
            json!({"configDigest": canonical.clone()}),
            json!({"configDigest": canonical.clone(), "servers": []}),
            // The wrapped `McpMutationResult` shape keeps the same value reachable.
            json!({"config": {"configDigest": canonical.clone()}}),
        ] {
            assert_eq!(
                config_digest(&accepted).as_deref(),
                Some(canonical.as_str()),
                "{accepted}"
            );
        }
        assert_eq!(
            canonical_digest(&canonical).as_deref(),
            Some(canonical.as_str())
        );
        for rejected in [
            json!({}),
            json!({"configDigest": ""}),
            json!({"configDigest": "sha256:"}),
            // short, long, uppercase, non-hex and a wrong prefix are not Core digests.
            json!({"configDigest": format!("sha256:{}", "0f".repeat(31))}),
            json!({"configDigest": format!("sha256:{}", "0f".repeat(33))}),
            json!({"configDigest": format!("sha256:{}", "0F".repeat(32))}),
            json!({"configDigest": format!("sha256:{}", "zz".repeat(32))}),
            json!({"configDigest": format!("md5:{}", "0f".repeat(32))}),
            json!({"configDigest": format!("sha256-{}", "0f".repeat(32))}),
            // Core's unreadable-configuration sentinels name no reviewed revision.
            json!({"configDigest": "sha256:missing-mcp-config"}),
            json!({"configDigest": "sha256:invalid-file-type"}),
            json!({"configDigest": "sha256:oversize-1048577"}),
            json!({"configDigest": "not-hex"}),
            json!({"configDigest": 7}),
        ] {
            assert!(config_digest(&rejected).is_none(), "{rejected}");
        }
    }

    #[test]
    fn assistant_admission_requires_a_known_local_runtime() {
        let local = |adapter: &str| AssistantInfo {
            adapter: adapter.to_owned(),
            removed: false,
            target_local: true,
        };
        // The real `AdapterKind` wire values (kebab-case). The Pi family is accepted;
        // `claude-code-cli` is refused by product policy (see the next test).
        for adapter in ["codex-cli", "deepseek-harness"] {
            assert!(assistant_admissible(&local(adapter)).is_ok(), "{adapter}");
            assert!(runtime_supported(adapter), "{adapter}");
        }
        // Pi stays closed until the instance opts in.
        assert_eq!(
            assistant_admissible(&local("pi")).unwrap_err(),
            "computer_agent_runtime_unsupported"
        );
        // Snake_case spellings are *not* wire values and must not be accepted.
        for adapter in [
            "claude-code-cli",
            "claude_code_cli",
            "codex_cli",
            "deepseek_harness",
            "dsh",
            "gemini-cli",
            "opencode-cli",
            "",
        ] {
            assert!(!runtime_supported(adapter), "{adapter}");
            assert_eq!(
                assistant_admissible(&local(adapter)).unwrap_err(),
                "computer_agent_runtime_unsupported",
                "{adapter}"
            );
        }
        assert_eq!(
            assistant_admissible(&AssistantInfo {
                adapter: "codex-cli".to_owned(),
                removed: true,
                target_local: true,
            })
            .unwrap_err(),
            "computer_agent_assistant_removed"
        );
        assert_eq!(
            assistant_admissible(&AssistantInfo {
                adapter: "codex-cli".to_owned(),
                removed: false,
                target_local: false,
            })
            .unwrap_err(),
            "computer_agent_target_unsupported"
        );
        // An unknown member shape (no adapter, no target) is never assumed local.
        let info = assistant_from_member(&json!({"agentId": "a"}), Err("computer_agent_mcp_unavailable"));
        assert_eq!(
            assistant_admissible(&info).unwrap_err(),
            "computer_agent_runtime_unsupported"
        );
    }

    /// The Pi toolchain is opened only by the existing explicit opt-in, and Claude computer
    /// use stays refused: the Claude runtime switch re-enables channel-endpoint Claude runs
    /// for manual testing, never a desktop grant.
    #[test]
    fn pi_needs_the_explicit_opt_in_and_claude_computer_use_stays_refused() {
        // Only `1`, surrounding whitespace tolerated, is an opt-in.
        for (raw, expected) in [
            (None, false),
            (Some(""), false),
            (Some("0"), false),
            (Some("true"), false),
            (Some("yes"), false),
            (Some("2"), false),
            (Some("1"), true),
            (Some(" 1 "), true),
            (Some("\t1\n"), true),
        ] {
            assert_eq!(pi_mcp_opt_in(raw), expected, "{raw:?}");
            assert_eq!(
                runtime_supported_with("pi", expected),
                expected,
                "the Pi runtime follows the opt-in exactly"
            );
        }
        // Claude is refused with and without every other switch we know of.
        assert!(!runtime_supported_with("claude-code-cli", false));
        assert!(!runtime_supported_with("claude-code-cli", true));
        assert!(!RUNTIMES.contains(&"claude-code-cli"));
        // The Pi family is exactly the codex/deepseek runtimes plus the gated Pi one.
        assert_eq!(RUNTIMES, ["codex-cli", "deepseek-harness", "pi"]);
        for adapter in RUNTIMES {
            assert!(
                runtime_supported_with(adapter, true),
                "{adapter} must be supported once Pi opts in"
            );
        }
    }

    #[test]
    fn wire_shapes_match_the_core_contracts() {
        // `members.get` -> `AgentProfileView` (camelCase, `agent_profile.rs:855-876`).
        let member = json!({
            "agentId": "member-1",
            "displayName": "Ada",
            "runtimeConfiguration": {
                "adapterKind": "claude-code-cli",
                "model": {"mode": "runtime_default"},
                "permissions": {"schemaVersion": 1, "values": {}}
            },
            "runtimeReadiness": {"status": "ready", "blockers": []},
            "executionAvailability": {},
            "memberOrder": 0,
            "version": 1,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "removedAt": null
        });
        // `members.executionTarget.get` -> `MemberTargetView` with a flattened
        // `VersionedMemberTarget`: `selection: null` means the default local Host.
        let local_target = Ok(json!({
            "memberId": "member-1",
            "revision": 0,
            "selection": null,
            "availableWorkspaces": [],
            "runtimeDescriptors": []
        }));
        let info = assistant_from_member(&member, local_target.clone());
        assert_eq!(info.adapter, "claude-code-cli");
        assert!(info.target_local);
        // The member shape is parsed faithfully, but Claude computer use is refused by
        // product policy even when the member is local and ready.
        assert_eq!(
            assistant_admissible(&info).unwrap_err(),
            "computer_agent_runtime_unsupported"
        );
        // The same member on an accepted runtime is admissible.
        let mut accepted = member.clone();
        accepted["runtimeConfiguration"]["adapterKind"] = json!("codex-cli");
        assert!(
            assistant_admissible(&assistant_from_member(&accepted, local_target.clone())).is_ok()
        );

        // A persisted selection names a remote node: that route does not exist here.
        let remote_target = Ok(json!({
            "memberId": "member-1",
            "revision": 3,
            "selection": {"nodeId": "node-1", "workspaceId": "w-1",
                "workspaceRoot": "/srv/work", "adapterKind": "codex-cli",
                "model": {"mode": "runtime_default"},
                "permissions": {"schemaVersion": 1, "values": {}}}
        }));
        // The runtime must be admitted first, so this uses an accepted one.
        let remote = assistant_from_member(&accepted, remote_target);
        assert!(!remote.target_local);
        assert_eq!(
            assistant_admissible(&remote).unwrap_err(),
            "computer_agent_target_unsupported"
        );
        // A member whose target could not be read is never assumed local.
        assert!(!assistant_from_member(&member, Err("computer_agent_mcp_unavailable")).target_local);
        // Removed members are refused even with a perfectly good runtime.
        let mut removed = member.clone();
        removed["removedAt"] = json!("2026-02-02T00:00:00Z");
        assert_eq!(
            assistant_admissible(&assistant_from_member(&removed, local_target)).unwrap_err(),
            "computer_agent_assistant_removed"
        );

        // `McpMutationResult` (tagged) and `McpConfigView.servers` (`mcp.rs:213-249`).
        let name = "loom-computer-agent-0123abcd";
        let digest = format!("sha256:{}", "1a".repeat(32));
        let stale = format!("sha256:{}", "2b".repeat(32));
        let definition = json!({"mcpServers": {name: {"command": "python", "args": []}}}).to_string();
        assert_eq!(definition_name(&definition).as_deref(), Some(name));
        let ok = json!({
            "status": "ok",
            "configDigest": digest.clone(),
            "config": {"path": "/p", "exists": true, "configDigest": digest.clone(),
                "publicConfigJson": "{}", "servers": [
                    {"serverId": "srv-1", "name": name, "transport": "stdio",
                     "endpoint": "python", "enabled": false, "assignedAgentIds": [],
                     "source": "user", "riskLevel": "standard"}
                ], "permissionIssue": false}
        });
        // `MutationView` holds no `Debug` (it can carry a whole config), so the helpers
        // below are asserted through `ok()`/`err()` instead of `unwrap()`.
        let view = mutation(&ok).ok().expect("an ok reply must parse");
        assert_eq!(view.digest, digest);
        assert_eq!(server_id_by_name(&view.servers, name).as_deref(), Some("srv-1"));
        assert!(server_id_by_name(&view.servers, "other").is_none());
        assert_eq!(
            mutation(&json!({"status": "conflict", "actualConfigDigest": stale.clone()}))
                .err()
                .expect("a conflict must be refused"),
            "computer_agent_digest_mismatch"
        );
        for refused in [
            json!({"status": "invalid", "issues": []}),
            json!({"status": "risk_acknowledgement_required", "serverId": "srv-1"}),
            json!({"ok": {"configDigest": digest.clone()}}),
            json!({}),
            // A free-form digest is not a Core revision, so an otherwise ok reply is refused.
            json!({"status": "ok", "configDigest": "d1", "config": {"servers": []}}),
        ] {
            assert_eq!(
                mutation(&refused).err().expect("a malformed reply must be refused"),
                "computer_agent_mcp_unavailable"
            );
        }
        // A reply without the created server must not be guessed at.
        let unauthored = json!({"status": "ok", "configDigest": digest.clone(), "config": {"servers": []}});
        assert!(server_id_by_name(
            &mutation(&unauthored).ok().expect("an ok reply must parse").servers,
            name
        )
        .is_none());

        // `mcp.config.get` returns the *flat* `McpConfigView` (`mcp.rs:213-225`). This value
        // is the real Core type serialized, not a hand-written guess: the digest and the
        // server list are top-level, and there is no `config` wrapper to read.
        //
        // `definitionJson` here is Core's public projection of the same definition: every
        // sensitive env value is replaced by `READ_ONLY_MASK` (`mcp.rs:33,1801`), so the
        // token-file path is absent from it. That is exactly why the public view alone can
        // never authorize a tool call.
        let masked = json!({"mcpServers": {name: {
            "command": "python", "args": [],
            "env": {"LOOM_COMPUTER_AGENT_TOKEN_FILE": "********"}
        }}})
        .to_string();
        let flat = serde_json::to_value(rovai_core::mcp::McpConfigView {
            path: "/p".to_owned(),
            exists: true,
            config_digest: digest.clone(),
            public_config_json: "{}".to_owned(),
            servers: vec![rovai_core::mcp::McpServerView {
                server_id: "srv-1".to_owned(),
                name: name.to_owned(),
                transport: "stdio".to_owned(),
                endpoint: "python".to_owned(),
                enabled: true,
                assigned_agent_ids: vec!["assistant-1".to_owned()],
                source: rovai_core::mcp::McpServerSource::User,
                risk_level: rovai_core::mcp::McpRiskLevel::Standard,
                risk_acknowledged: false,
                definition_json: masked.clone(),
                configuration_issues: Vec::new(),
            }],
            file_issue: None,
            permission_issue: false,
        })
        .unwrap();
        assert!(flat.get("config").is_none(), "the public view is flat");
        assert_eq!(config_digest(&flat).as_deref(), Some(digest.as_str()));
        let servers = public_servers(&flat).expect("the real view carries a servers list");
        let entry = server_entry(servers, "srv-1").expect("the exact server entry must be found");
        assert!(entry.enabled);
        assert_eq!(entry.assigned, vec!["assistant-1".to_owned()]);
        // A different id is never substituted by a neighbour in the same configuration.
        assert!(server_entry(servers, "srv-2").is_none());

        // A missing or non-array `servers` is a wire-shape failure, not an empty
        // configuration. Reading it as "no servers" would turn a broken read into "the
        // server is gone", which lets `cleanup_mcp` claim a cleanup it never observed.
        for malformed in [
            json!({"configDigest": digest.clone()}),
            json!({"servers": {}}),
            json!({"servers": "none"}),
            json!({"servers": 7}),
            json!({}),
        ] {
            assert_eq!(
                public_servers(&malformed).err(),
                Some("computer_agent_mcp_unavailable"),
                "{malformed}"
            );
        }
        // Only a genuine list without that id means the server is really absent.
        let empty = json!({"servers": []});
        assert_eq!(public_servers(&empty).map(<[Value]>::len), Ok(0));
        assert!(
            server_entry(public_servers(&empty).expect("a genuine empty list"), "srv-1").is_none()
        );

        // `McpRevealResult` (`mcp.rs:255-272`), again the real Core type serialized: only an
        // `ok` reply for exactly the requested id at the same digest carries a definition.
        let revealed = serde_json::to_value(rovai_core::mcp::McpRevealResult::Ok {
            server_id: "srv-1".to_owned(),
            config_digest: digest.clone(),
            definition_json: definition.clone(),
        })
        .unwrap();
        assert_eq!(
            revealed_definition(&revealed, "srv-1", &digest).ok().as_deref(),
            Some(definition.as_str()),
            "the exact reveal must hand back the definition verbatim"
        );
        let wrong_id = serde_json::to_value(rovai_core::mcp::McpRevealResult::Ok {
            server_id: "srv-2".to_owned(),
            config_digest: digest.clone(),
            definition_json: definition.clone(),
        })
        .unwrap();
        assert_eq!(
            revealed_definition(&wrong_id, "srv-1", &digest).err(),
            Some("computer_agent_mcp_unavailable"),
            "another server's definition must never be adopted"
        );
        let wrong_digest = serde_json::to_value(rovai_core::mcp::McpRevealResult::Ok {
            server_id: "srv-1".to_owned(),
            config_digest: stale.clone(),
            definition_json: definition.clone(),
        })
        .unwrap();
        assert_eq!(
            revealed_definition(&wrong_digest, "srv-1", &digest).err(),
            Some("computer_agent_mcp_unavailable"),
            "a reveal from a different revision is not this configuration"
        );
        let conflict = serde_json::to_value(rovai_core::mcp::McpRevealResult::Conflict {
            actual_config_digest: stale.clone(),
        })
        .unwrap();
        assert_eq!(
            revealed_definition(&conflict, "srv-1", &digest).err(),
            Some("computer_agent_digest_mismatch"),
            "a conflict must never fall back to another definition"
        );
        let invalid = serde_json::to_value(rovai_core::mcp::McpRevealResult::Invalid {
            issues: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            revealed_definition(&invalid, "srv-1", &digest).err(),
            Some("computer_agent_mcp_unavailable")
        );
        // Wire shapes the typed serializer cannot produce still fail closed: no definition,
        // a non-string definition and undecodable JSON.
        for (case, refused) in [
            ("empty", json!({})),
            ("missing-status", json!({"serverId": "srv-1", "configDigest": digest.clone()})),
            (
                "missing-definition",
                json!({"status": "ok", "serverId": "srv-1", "configDigest": digest.clone()}),
            ),
            (
                "non-string-definition",
                json!({"status": "ok", "serverId": "srv-1", "configDigest": digest.clone(),
                    "definitionJson": {"mcpServers": {}}}),
            ),
            (
                "malformed-json",
                json!({"status": "ok", "serverId": "srv-1", "configDigest": digest.clone(),
                    "definitionJson": "{\"mcpServers\":"}),
            ),
        ] {
            assert_eq!(
                revealed_definition(&refused, "srv-1", &digest).err(),
                Some("computer_agent_mcp_unavailable"),
                "a reveal that is not exactly this server must fail closed ({case})"
            );
        }
    }

    #[test]
    fn closed_tool_set_and_argument_shapes() {
        assert_eq!(TOOLS.len(), 5);
        for (tool, arguments) in [
            (Tool::MouseClick, json!({"x": 1, "y": 2, "button": "left", "command": "calc"})),
            (Tool::Key, json!({"key": "enter", "path": "/etc/passwd"})),
            (Tool::Text, json!({"text": "hi", "url": "http://example.com"})),
            (Tool::Wheel, json!({"x": 1, "y": 2, "delta": 3, "tool": "shell"})),
            (Tool::Screenshot, json!({"path": "/tmp/x.png"})),
        ] {
            let failure = event_for(tool, arguments).err().expect("must refuse");
            assert_eq!(failure.code, "computer_agent_invalid_request");
        }
        let click = event_for(Tool::MouseClick, json!({"x": -5, "y": 5, "button": "left"}))
            .ok()
            .expect("a valid click must parse");
        assert_eq!(click.action, Some(computer::WireAction::Click));
    }

    #[test]
    fn request_ids_are_single_use_without_eviction() {
        let mut receipts = Receipts {
            seen: HashSet::new(),
        };
        assert!(receipts.seen.insert("a".repeat(32)));
        assert!(!receipts.seen.insert("a".repeat(32)));
        for index in 0..MAX_RECEIPTS {
            receipts.seen.insert(format!("{index:032x}"));
        }
        assert!(receipts.seen.len() >= MAX_RECEIPTS);
        assert!(receipts.seen.contains(&"a".repeat(32)));
    }

    #[test]
    fn grant_payloads_never_carry_the_token_or_the_private_session() {
        let mask_free = json!({"serverId": "server-abc12345"});
        assert_eq!(mask_free["serverId"], json!("server-abc12345"));
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let public = public_grant(&grant, wall_clock()).to_string();
        assert!(public.contains("server-abc12345"));
        assert!(!public.contains("Bearer"));
        assert!(!public.contains("grant-"));
        assert!(!public.contains(&grant.session.client_id));
    }

    /// The identity on a grant is the reviewed one, and a request body has no field that
    /// could supply, replace or widen it (Mikka: never a task or model field).
    #[test]
    fn a_grant_request_cannot_supply_its_own_authority() {
        let valid = json!({
            "consent": true,
            "assistantId": "assistant-1",
            "scope": "view",
            "deviceId": "sha256:blocking",
            "expectedConfigDigest": "a".repeat(64),
            "ttlSeconds": 60,
        });
        let body: GrantBody = serde_json::from_value(valid.clone()).expect("the real shape parses");
        assert_eq!(body.assistant_id, "assistant-1");
        assert_eq!(body.scope, "view");
        // Every identity/authority field is refused as an unknown field instead of being
        // silently ignored, so a caller cannot claim to be another member or runtime.
        for field in [
            "ownerId",
            "ownerClientId",
            "clientId",
            "botId",
            "runtime",
            "adapter",
            "adapterKind",
            "permission",
            "policyVersion",
            "token",
            "tokenFile",
            "serverId",
            "grantId",
        ] {
            let mut claimed = valid.clone();
            claimed[field] = json!("attacker");
            assert!(
                serde_json::from_value::<GrantBody>(claimed).is_err(),
                "{field} must never come from a request body"
            );
        }

        // The public payload reports the granted identity it was minted for.
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let public = public_grant(&grant, wall_clock());
        assert_eq!(public["assistantId"], json!("assistant-1"));
        assert_eq!(public["deviceId"], json!("sha256:blocking"));
        assert_eq!(public["runtime"], json!("pi"));
        assert_eq!(public["scope"], json!("control"));
    }

    #[test]
    fn definition_carries_a_token_path_but_never_a_token() {
        let grants = AgentGrants::for_test(FakeMcp::new());
        let config = grants.supported().unwrap().clone();
        let (_sessions, owner, _token) = browser();
        let definition = definition_json(
            &config,
            "0123456789abcdef",
            Path::new("/tmp/grant-x"),
            "127.0.0.1:8443",
            &fixture_authority(&owner, Scope::View),
        );
        let parsed: Value = serde_json::from_str(&definition).unwrap();
        let server = parsed["mcpServers"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        let env = &server["env"];
        assert!(env["LOOM_COMPUTER_AGENT_TOKEN_FILE"]
            .as_str()
            .unwrap()
            .ends_with("grant-x"));
        assert_eq!(env["LOOM_COMPUTER_AGENT_GRANT"], json!("0123456789abcdef"));
        // The non-secret authority identity reaches the Pi toolchain; the token never does.
        assert_eq!(env["LOOM_COMPUTER_AGENT_RUNTIME"], json!("pi"));
        assert_eq!(env["LOOM_COMPUTER_AGENT_SUBJECT"], json!("assistant-1"));
        assert_eq!(env["LOOM_COMPUTER_AGENT_SCOPE"], json!("view"));
        // The digest the bridge echoes is the authority's reviewed revision, not a
        // separately supplied value.
        assert_eq!(
            env["LOOM_COMPUTER_AGENT_DIGEST"],
            json!(fixture_authority(&owner, Scope::View).policy_version)
        );
        let mut keys: Vec<&str> = env
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "LOOM_COMPUTER_AGENT_DIGEST",
                "LOOM_COMPUTER_AGENT_ENDPOINT",
                "LOOM_COMPUTER_AGENT_GRANT",
                "LOOM_COMPUTER_AGENT_ORIGIN",
                "LOOM_COMPUTER_AGENT_RUNTIME",
                "LOOM_COMPUTER_AGENT_SCOPE",
                "LOOM_COMPUTER_AGENT_SUBJECT",
                "LOOM_COMPUTER_AGENT_TOKEN_FILE",
            ],
            "the toolchain environment is a closed set"
        );
        assert!(!definition.contains(&"ab".repeat(32)));
    }

    #[test]
    fn a_failing_enable_reports_mcp_failure_and_keeps_the_created_server_id() {
        let fake = FakeMcp::new();
        fake.fail_enable.store(true, Ordering::SeqCst);
        let grants = AgentGrants::for_test(fake.clone());
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, true);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(async {
            run_creation(
                &grants,
                &sessions,
                &grant,
                &owner.client_id,
                "{\"mcpServers\":{}}".to_owned(),
            )
            .await
        });
        assert_eq!(outcome.unwrap_err(), "computer_agent_mcp_unavailable");
        // The server that Core did create is remembered, so cleanup can name it.
        assert_eq!(grant.server_id(), "server-abc12345");
        assert_eq!(
            fake.names(),
            vec!["create", "set_members", "set_enabled"],
            "no write may be attempted after a failed enable"
        );
    }

    #[test]
    fn duplicate_grant_for_the_same_scope_is_a_conflict() {
        let fake = FakeMcp::new();
        let grants = AgentGrants::for_test(fake);
        let (sessions, owner, _token) = browser();
        let first = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        grants.reserve(first.clone()).unwrap();
        let mut second = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        Arc::get_mut(&mut second).unwrap().digest = [9; 32];
        assert_eq!(grants.reserve(second).unwrap_err(), "computer_agent_grant_conflict");
        // An explicit revoke frees the slot. Model the state the real path leaves behind:
        // `retire` is what a user's revoke and every sweep run, and it closes the grant.
        // Marking only `revoked` would not free the slot, because a reservation is created
        // with `revoked` already set and `closed` is the liveness marker.
        let computer = idle_computer();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime
            .block_on(async { retire(&computer, &grants.mcp, &first).await })
            .unwrap();
        assert!(first.revoked.load(Ordering::Acquire));
        assert!(first.closed.load(Ordering::Acquire));
        let mut third = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        Arc::get_mut(&mut third).unwrap().digest = [11; 32];
        assert!(grants.reserve(third).is_ok());
    }

    #[test]
    fn retire_proves_the_fence_and_reports_unconfirmed_cleanup() {
        let fake = FakeMcp::new();
        // The server this grant created is still present and enabled in Core.
        fake.present(true, &["assistant-1"], "");
        let grants = AgentGrants::for_test(fake.clone());
        let (entered, _entered_rx) = mpsc::channel();
        let (_proceed_tx, proceed_rx) = mpsc::channel::<()>();
        let provider = BlockingProvider::new(entered, proceed_rx);
        let clock = Arc::new(AtomicU64::new(1_800_000_000_000));
        let computer = Arc::new(Computer::with_test_provider(provider, {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        }));
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        // No view and no control were ever created: nothing to fence, and that is
        // provable, so a revoke may claim success.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(async { retire(&computer, &grants.mcp, &grant).await });
        assert!(outcome.is_ok());
        assert!(grant.revoked.load(Ordering::Acquire));
        assert!(!grant.sessions.is_live(&grant.session));
        // The MCP cleanup names the created server id.
        assert_eq!(
            fake.names(),
            vec!["server", "set_enabled", "server", "delete"],
            "cleanup must read, disable, re-read and delete exactly once each"
        );
        let serialized = fake.serialized();
        assert!(serialized.contains("server-abc12345"));
    }

    #[test]
    fn a_queued_input_is_refused_after_the_owner_session_is_revoked() {
        let fake = FakeMcp::new();
        let (sessions, owner, token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (proceed_tx, proceed_rx) = mpsc::channel::<()>();
        let provider = BlockingProvider::new(entered_tx, proceed_rx);
        let clock = Arc::new(AtomicU64::new(1_800_000_000_000));
        let computer = Arc::new(Computer::with_test_provider(provider.clone(), {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        }));
        // Establish a view and a control for the grant.
        let view = computer
            .start_view(
                &grant.sessions,
                &grant.session,
                ViewBody {
                    consent: true,
                    device_id: grant.authority.device_id.clone(),
                },
            )
            .unwrap()["viewId"]
            .as_str()
            .unwrap()
            .to_owned();
        let control = computer
            .acquire(
                &grant.sessions,
                &grant.session,
                ControlBody {
                    view_id: view.clone(),
                    device_id: grant.authority.device_id.clone(),
                    consent: true,
                    ttl_seconds: 30,
                },
            )
            .unwrap();
        let control_id = control["controlId"].as_str().unwrap().to_owned();
        let generation = control["generation"].as_u64().unwrap();
        {
            let mut run = grant.run.lock().unwrap();
            run.view_id = Some(view.clone());
            run.control_id = Some(control_id.clone());
            run.generation = generation;
            run.seq_high = 0;
        }
        // A first input from the test thread enters the provider, which blocks while
        // still holding the physical gate.
        let holder = {
            let computer = computer.clone();
            let grant = grant.clone();
            std::thread::spawn(move || {
                computer.input_guarded(
                    &grant.sessions,
                    &grant.session,
                    InputBody {
                        view_id: view,
                        control_id,
                        generation,
                        seq: 1,
                        consent: true,
                        event: EventBody {
                            kind: EventKind::Key,
                            x: None,
                            y: None,
                            button: None,
                            action: None,
                            delta: None,
                            key: Some(WireKey::Enter),
                            text: None,
                        },
                    },
                    &|| Ok(()),
                )
            })
        };
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the first input must reach the provider");
        // The agent's second request now queues behind the physical gate.
        let queued = {
            let computer = computer.clone();
            let grant = grant.clone();
            let sessions = sessions.clone();
            let owner = owner.clone();
            let _ = &fake;
            std::thread::spawn(move || {
                run_tool(
                    &computer,
                    &sessions,
                    &grant,
                    Tool::Key,
                    "req-queued",
                    json!({"key": "enter"}),
                )
                .map(|_| ())
            })
        };
        // The user logs out while the request is still queued.
        sessions.rotate(&crate::new_token().unwrap()).unwrap();
        proceed_tx.send(()).unwrap();
        holder
            .join()
            .expect("the worker must not panic")
            .ok()
            .expect("the first input must succeed");
        let queued = queued.join().unwrap();
        assert_eq!(
            queued.err().map(|failure| failure.code),
            Some("computer_agent_owner_session_required"),
            "the queued tool must be refused by the admission closure"
        );
        // Exactly the first, non-agent input reached the operating system.
        assert_eq!(provider.inputs.load(Ordering::SeqCst), 1);
        let _ = token;
    }

    #[test]
    fn capture_bytes_are_discarded_when_the_owner_leaves_mid_capture() {
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let (entered_tx, _entered_rx) = mpsc::channel();
        let (_proceed_tx, proceed_rx) = mpsc::channel::<()>();
        let provider = BlockingProvider::new(entered_tx, proceed_rx);
        let clock = Arc::new(AtomicU64::new(1_800_000_000_000));
        let computer = Computer::with_test_provider(provider, {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        });
        let view = computer
            .start_view(
                &grant.sessions,
                &grant.session,
                ViewBody {
                    consent: true,
                    device_id: grant.authority.device_id.clone(),
                },
            )
            .unwrap()["viewId"]
            .as_str()
            .unwrap()
            .to_owned();
        sessions.rotate(&crate::new_token().unwrap()).unwrap();
        // The guard runs after the capture too, so no bytes escape.
        let failure = computer
            .frame_guarded(
                &grant.sessions,
                &grant.session,
                FrameBody {
                    view_id: view,
                    consent: true,
                },
                &|| admit(&grant, &sessions),
            )
            // The Ok side is a captured frame, which holds screen bytes and no `Debug`.
            .err()
            .expect("a frame must not escape a dead browser session");
        assert_eq!(failure, "computer_agent_owner_session_required");
    }

    #[test]
    fn request_ids_are_consumed_before_the_os_call() {
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (proceed_tx, proceed_rx) = mpsc::channel::<()>();
        let provider = BlockingProvider::new(entered_tx, proceed_rx);
        let clock = Arc::new(AtomicU64::new(1_800_000_000_000));
        let computer = Arc::new(Computer::with_test_provider(provider.clone(), {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        }));
        let view = computer
            .start_view(
                &grant.sessions,
                &grant.session,
                ViewBody {
                    consent: true,
                    device_id: grant.authority.device_id.clone(),
                },
            )
            .unwrap()["viewId"]
            .as_str()
            .unwrap()
            .to_owned();
        let control = computer
            .acquire(
                &grant.sessions,
                &grant.session,
                ControlBody {
                    view_id: view.clone(),
                    device_id: grant.authority.device_id.clone(),
                    consent: true,
                    ttl_seconds: 30,
                },
            )
            .unwrap();
        {
            let mut run = grant.run.lock().unwrap();
            run.view_id = Some(view);
            run.control_id = control["controlId"].as_str().map(str::to_owned);
            run.generation = control["generation"].as_u64().unwrap();
        }
        let computer_thread = {
            let computer = computer.clone();
            let grant = grant.clone();
            let sessions = sessions.clone();
            std::thread::spawn(move || {
                run_tool(
                    &computer,
                    &sessions,
                    &grant,
                    Tool::Key,
                    "req-once",
                    json!({"key": "enter"}),
                )
            })
        };
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the first attempt must reach the provider");
        // While the OS call is still blocked, the id is already burnt and the physical
        // gate is provably still held by that call. Both checks are bounded: a regression
        // that put the ledger back behind the run gate would block a reader forever, so the
        // read runs on its own thread with a timeout instead of hanging the test binary.
        assert!(
            grant.run.try_lock().is_err(),
            "the blocked OS call must still hold the physical gate"
        );
        let (burnt_tx, burnt_rx) = mpsc::channel();
        {
            let ledger = grant.clone();
            std::thread::spawn(move || {
                let burnt = ledger
                    .receipts
                    .lock()
                    .map(|receipts| receipts.seen.contains("req-once"))
                    .unwrap_or(false);
                let _ = burnt_tx.send(burnt);
            });
        }
        assert_eq!(
            burnt_rx.recv_timeout(Duration::from_secs(5)),
            Ok(true),
            "the request id must be consumed before the OS call, without waiting on the gate"
        );
        proceed_tx.send(()).unwrap();
        assert!(computer_thread.join().unwrap().is_ok());
        // A replay of the same id is refused even though the grant is still valid.
        let replay = run_tool(
            &computer,
            &sessions,
            &grant,
            Tool::Key,
            "req-once",
            json!({"key": "enter"}),
        )
        .err()
        .expect("replay must fail");
        assert_eq!(replay.code, "computer_agent_request_replayed");
        assert_eq!(provider.inputs.load(Ordering::SeqCst), 1);
    }

    /// The Pi toolchain's authorization lifecycle at the one boundary that can reach an
    /// operating system: the capture scope alone may not type, a request id is burnt before
    /// the OS call, and a revoked or expired grant is refused without a further OS call.
    #[test]
    fn pi_toolchain_covers_scope_replay_revocation_and_expiry() {
        // Every phase gets its own device, so a control lease from an earlier grant can
        // never be mistaken for this one.
        fn fresh() -> (Arc<Computer>, Arc<BlockingProvider>) {
            let (entered_tx, _entered_rx) = mpsc::channel();
            let (_proceed_tx, proceed) = mpsc::channel::<()>();
            let provider = BlockingProvider::new(entered_tx, proceed);
            let clock = Arc::new(AtomicU64::new(1_800_000_000_000));
            let computer = Arc::new(Computer::with_test_provider(provider.clone(), {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::SeqCst))
            }));
            (computer, provider)
        }

        let (sessions, owner, _token) = browser();

        // 1. Independent authorization: a view grant captures, and cannot type.
        let (computer, provider) = fresh();
        let mut view_grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        Arc::get_mut(&mut view_grant).unwrap().authority.permission = Scope::View;
        let shot = run_tool(
            &computer,
            &sessions,
            &view_grant,
            Tool::Screenshot,
            "pi-shot-1",
            json!({}),
        )
        .ok()
        .expect("a view grant must capture");
        assert!(shot["pngBase64"].as_str().is_some_and(|png| !png.is_empty()));
        let refused = run_tool(
            &computer,
            &sessions,
            &view_grant,
            Tool::Key,
            "pi-key-view",
            json!({"key": "enter"}),
        )
        .err()
        .expect("a view grant must not type");
        assert_eq!(refused.code, "computer_agent_scope_denied");
        assert!(!refused.revoke, "a scope refusal is not a revocation");
        assert_eq!(
            provider.inputs.load(Ordering::SeqCst),
            0,
            "no synthetic input may reach the device"
        );

        // 2. Replay: the same request id is refused before the second OS call.
        let (computer, provider) = fresh();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let first = run_tool(
            &computer,
            &sessions,
            &grant,
            Tool::Key,
            "pi-key-1",
            json!({"key": "enter"}),
        )
        .ok()
        .expect("the first input must be admitted");
        assert_eq!(first["seq"], json!(1));
        assert_eq!(provider.inputs.load(Ordering::SeqCst), 1);
        let replay = run_tool(
            &computer,
            &sessions,
            &grant,
            Tool::Key,
            "pi-key-1",
            json!({"key": "enter"}),
        )
        .err()
        .expect("a replay must be refused");
        assert_eq!(replay.code, "computer_agent_request_replayed");
        assert_eq!(provider.inputs.load(Ordering::SeqCst), 1);

        // 3. Revocation: refused before the OS call, even with a fresh request id.
        grant.revoked.store(true, Ordering::Release);
        let revoked = run_tool(
            &computer,
            &sessions,
            &grant,
            Tool::Key,
            "pi-key-2",
            json!({"key": "enter"}),
        )
        .err()
        .expect("a revoked grant must not type");
        assert_eq!(revoked.code, "computer_agent_grant_revoked");
        assert_eq!(provider.inputs.load(Ordering::SeqCst), 1);

        // 4. Expiry: the same refusal, with its own code, and again no OS call.
        let (computer, provider) = fresh();
        let expired = grant_for(&sessions, &owner, 1, false);
        let late = run_tool(
            &computer,
            &sessions,
            &expired,
            Tool::Key,
            "pi-key-3",
            json!({"key": "enter"}),
        )
        .err()
        .expect("an expired grant must not type");
        assert_eq!(late.code, "computer_agent_grant_expired");
        assert_eq!(provider.inputs.load(Ordering::SeqCst), 0);
    }

    /// The grant's authority is re-read from the live member on every call (upstream reads
    /// current ownership before each driver invocation). A grant minted for Codex/DSH
    /// therefore cannot keep serving after the member is switched to Pi without
    /// `LOOM_COMPUTER_AGENT_PI_MCP=1`: the call is refused and neither a capture nor a
    /// synthetic input reaches the device.
    #[test]
    fn a_runtime_switch_after_the_grant_is_refused_before_any_os_call() {
        fn fresh() -> (Arc<Computer>, Arc<BlockingProvider>) {
            let (entered, _entered_rx) = mpsc::channel();
            let (_proceed_tx, proceed) = mpsc::channel::<()>();
            let provider = BlockingProvider::new(entered, proceed);
            let clock = Arc::new(AtomicU64::new(1_800_000_000_000));
            let computer = Arc::new(Computer::with_test_provider(provider.clone(), {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::SeqCst))
            }));
            (computer, provider)
        }

        let (sessions, owner, _token) = browser();
        let mut grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        // Minted for the runtime the member actually ran; both are admitted without the Pi
        // opt-in, so this fixture never depends on the process environment.
        Arc::get_mut(&mut grant).unwrap().authority.runtime = "codex-cli".to_owned();
        let (computer, provider) = fresh();
        let fake = FakeMcp::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let counters = || {
            (
                provider.captures.load(Ordering::SeqCst),
                provider.inputs.load(Ordering::SeqCst),
            )
        };
        // The same order `rpc` uses: the live member gate first, then `run_tool`.
        let attempt = |tool: Tool, request_id: &str| -> Result<Value, &'static str> {
            runtime.block_on(admit_live_authority(fake.as_ref(), &grant))?;
            let arguments = match tool {
                Tool::Screenshot => json!({}),
                _ => json!({"key": "enter"}),
            };
            run_tool(&computer, &sessions, &grant, tool, request_id, arguments)
                .map_err(|failure| failure.code)
        };

        // 1. The member is unchanged, so the grant still captures and types.
        fake.see_member("codex-cli", true, false);
        assert!(attempt(Tool::Screenshot, "live-shot-1").is_ok());
        assert!(attempt(Tool::Key, "live-key-1").is_ok());
        assert_eq!(
            counters(),
            (1, 1),
            "a healthy grant really reaches the device"
        );
        let healthy = counters();

        // 2. Switched to Pi: refused on the real read-then-decide path, whether or not the
        //    instance opted Pi in, and nothing reaches the device.
        fake.see_member("pi", true, false);
        for (tool, request_id) in [(Tool::Screenshot, "live-shot-2"), (Tool::Key, "live-key-2")] {
            assert_eq!(
                attempt(tool, request_id).err(),
                Some("computer_agent_runtime_unsupported"),
                "{tool:?}"
            );
        }
        assert_eq!(
            counters(),
            healthy,
            "a refused grant must not reach the device"
        );

        // 3. With the opt-in passed in explicitly, both sides are still refused: the
        //    identity moved, so this definition/scope/consent is not this grant any more.
        let pi_member = AssistantInfo {
            adapter: "pi".to_owned(),
            removed: false,
            target_local: true,
        };
        for pi_opt_in in [false, true] {
            assert_eq!(
                authority_holds_with(&grant.authority, &pi_member, pi_opt_in).err(),
                Some("computer_agent_runtime_unsupported"),
                "pi_opt_in={pi_opt_in}"
            );
        }
        // Another admitted runtime is not this grant either.
        fake.see_member("deepseek-harness", true, false);
        assert_eq!(
            attempt(Tool::Key, "live-key-3").err(),
            Some("computer_agent_runtime_unsupported")
        );

        // 4. A removed member and one moved off this Host are refused the same way.
        fake.see_member("codex-cli", true, true);
        assert_eq!(
            attempt(Tool::Key, "live-key-4").err(),
            Some("computer_agent_assistant_removed")
        );
        fake.see_member("codex-cli", false, false);
        assert_eq!(
            attempt(Tool::Key, "live-key-5").err(),
            Some("computer_agent_target_unsupported")
        );
        // 5. Every refusal happened before the device.
        assert_eq!(counters(), healthy, "no refused call may reach the device");
    }

    #[test]
    fn logout_retires_the_mcp_entry_as_well_as_the_tool_path() {
        let fake = FakeMcp::new();
        // The server exists and is enabled, so the sweep must disable and delete it.
        fake.present(true, &["assistant-1"], "");
        let grants = AgentGrants::for_test(fake.clone());
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 300_000, false);
        grants.reserve(grant.clone()).unwrap();
        let computer = idle_computer();
        // Nothing is expired or explicitly revoked; only the browser session goes away.
        sessions.rotate(&crate::new_token().unwrap()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async { grants.retire_due(&computer, wall_clock()).await });
        assert!(fake.names().contains(&"set_enabled"));
        assert!(fake.names().contains(&"delete"));
        assert!(!grant.sessions.is_live(&grant.session));
        assert!(
            grants.owned(&owner.client_id, wall_clock()).is_empty(),
            "a retired grant is forgotten, not left behind"
        );
    }

    #[test]
    fn expired_grants_stay_visible_for_the_ui_and_remain_revocable() {
        let grants = AgentGrants::for_test(FakeMcp::new());
        let (sessions, owner, _token) = browser();
        let expired = grant_for(&sessions, &owner, 1, false);
        grants.reserve(expired.clone()).unwrap();
        let owned = grants.owned(&owner.client_id, wall_clock());
        assert_eq!(owned.len(), 1);
        assert_eq!(public_grant(&owned[0], wall_clock())["state"], json!("expired"));
        assert_eq!(owned[0].id, expired.id);
    }

    #[test]
    fn an_unprovable_fence_is_reported_as_unconfirmed_cleanup() {
        let fake = FakeMcp::new();
        // The server exists and is enabled: the MCP half of the cleanup can still run.
        fake.present(true, &["assistant-1"], "");
        let grants = AgentGrants::for_test(fake.clone());
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        {
            let mut run = grant.run.lock().unwrap();
            run.view_id = Some("dead".repeat(16));
        }
        // The private session is already inert, so the provider refuses to fence. The
        // caller must not mistake that for a clean revoke.
        let _ = grant.sessions.revoke(&grant.session);
        let computer = idle_computer();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(async { retire(&computer, &grants.mcp, &grant).await });
        assert_eq!(outcome.unwrap_err(), "computer_agent_cleanup_unconfirmed");
        assert!(grant.revoked.load(Ordering::Acquire));
        // MCP cleanup still runs, so the server cannot stay enabled.
        assert!(fake.names().contains(&"set_enabled"));
        assert!(fake.names().contains(&"delete"));
    }

    #[test]
    fn unsupported_hosts_fail_closed_without_touching_core() {
        let grants = AgentGrants::with_config(None, FakeMcp::new());
        assert!(grants.supported().is_err());
        let report = grants.report();
        assert_eq!(report["configured"], json!(false));
        assert_eq!(report["reason"], json!("computer_agent_unsupported"));
        assert_eq!(report["maxGrantSeconds"], json!(300));
        assert_eq!(report["piEnabled"], json!(false));
    }

    #[test]
    fn mcp_parameter_payloads_carry_no_secret_material() {
        let fake = FakeMcp::new();
        let grants = AgentGrants::for_test(fake.clone());
        let owner = "o".repeat(64);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let digest = grants.mcp.digest(owner.clone()).await.unwrap();
            let (server_id, digest) = grants
                .mcp
                .create(owner.clone(), digest, "{\"mcpServers\":{}}".to_owned())
                .await
                .unwrap();
            let digest = grants
                .mcp
                .set_members(owner.clone(), digest, server_id.clone(), "assistant-1".to_owned())
                .await
                .unwrap();
            grants
                .mcp
                .set_enabled(owner.clone(), digest, server_id, true)
                .await
                .unwrap();
        });
        let serialized = fake.serialized();
        assert!(!serialized.contains("Bearer"));
        assert!(!serialized.contains("LOOM_COMPUTER_AGENT_TOKEN"));
        assert!(serialized.contains("server-abc12345"));
    }

    // ---- finding 1/4: pending admission and pending conflicts -------------------------

    /// A reservation exists before the browser has a token, so it is created `revoked`.
    /// Creation must therefore use pending admission, or no grant can ever be minted.
    #[test]
    fn pending_grant_can_still_be_created() {
        let (sessions, owner, _token) = browser();
        let fake = FakeMcp::new();
        let grants = AgentGrants::for_test(fake.clone());
        let pending = grant_for(&sessions, &owner, wall_clock() + 60_000, true);
        assert!(pending.revoked.load(Ordering::Acquire), "pending starts revoked");
        assert!(!pending.closed.load(Ordering::Acquire));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(async {
            run_creation(
                &grants,
                &sessions,
                &pending,
                &pending.authority.owner_id,
                "{\"mcpServers\":{\"loom-computer-agent-1\":{}}}".to_owned(),
            )
            .await
        });
        assert_eq!(outcome.ok(), Some("server-abc12345".to_owned()));
        assert_eq!(fake.names(), vec!["create", "set_members", "set_enabled"]);
        // The token is still fenced off until the grant is published as live.
        assert_eq!(
            admit(&pending, &sessions).err(),
            Some("computer_agent_grant_revoked")
        );
    }

    /// The same grant, once a retirement has started, must never create anything.
    #[test]
    fn closed_pending_grant_creates_nothing() {
        let (sessions, owner, _token) = browser();
        let fake = FakeMcp::new();
        let grants = AgentGrants::for_test(fake.clone());
        let pending = grant_for(&sessions, &owner, wall_clock() + 60_000, true);
        pending.closed.store(true, Ordering::Release);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(async {
            run_creation(&grants, &sessions, &pending, &pending.authority.owner_id, "{}".to_owned()).await
        });
        assert_eq!(outcome.err(), Some("computer_agent_grant_revoked"));
        assert!(fake.names().is_empty(), "no Core write may happen");
    }

    /// Two parallel creations for the same assistant+device+scope must not both publish.
    /// A pending reservation counts as the conflict, because it is not `revoked`-live yet.
    #[test]
    fn two_pending_reservations_conflict() {
        let (sessions, owner, _token) = browser();
        let grants = AgentGrants::for_test(FakeMcp::new());
        let first = grant_for(&sessions, &owner, wall_clock() + 60_000, true);
        grants.reserve(first.clone()).unwrap();
        let mut second = grant_for(&sessions, &owner, wall_clock() + 60_000, true);
        Arc::get_mut(&mut second).unwrap().digest = [7; 32];
        assert_eq!(
            grants.reserve(second).err(),
            Some("computer_agent_grant_conflict")
        );
        // A retired reservation frees the slot again.
        first.closed.store(true, Ordering::Release);
        let mut third = grant_for(&sessions, &owner, wall_clock() + 60_000, true);
        Arc::get_mut(&mut third).unwrap().digest = [8; 32];
        assert!(grants.reserve(third).is_ok());
    }

    // ---- finding 5: the live server state, not the stored stamp ------------------------

    /// The canonical definition the fixture grants were created from. Tests must supply it
    /// explicitly: there is no path where a missing expectation authorizes a tool call.
    fn fixture_definition(grant_id: &str) -> Value {
        let digest_text = "a".repeat(64);
        let mut servers = serde_json::Map::new();
        servers.insert(
            format!("loom-computer-agent-{}", &grant_id[..grant_id.len().min(8)]),
            json!({
                "command": "/opt/python3",
                "args": ["/opt/mcp_bridge.py"],
                "env": {
                    "LOOM_COMPUTER_AGENT_GRANT": grant_id,
                    "LOOM_COMPUTER_AGENT_ENDPOINT": "http://127.0.0.1:8443/api/v1/computer-agent/rpc",
                    "LOOM_COMPUTER_AGENT_ORIGIN": "http://127.0.0.1:8443",
                    "LOOM_COMPUTER_AGENT_RUNTIME": "pi",
                    "LOOM_COMPUTER_AGENT_SUBJECT": "assistant-1",
                    "LOOM_COMPUTER_AGENT_SCOPE": "control",
                    "LOOM_COMPUTER_AGENT_DIGEST": digest_text,
                    "LOOM_COMPUTER_AGENT_TOKEN_FILE": "/tmp/grants/token-abc",
                },
            }),
        );
        json!({ "mcpServers": servers })
    }

    #[test]
    fn a_disabled_unassigned_or_replaced_server_revokes_the_grant() {
        let (sessions, owner, _token) = browser();
        // No token file, so this test isolates the enabled/assignment checks.
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        assert!(grant.token_path.is_none());
        let assistant = grant.authority.bot_id.clone();
        let definition = fixture_definition(&grant.id).to_string();
        let state = |enabled: bool, assigned: Vec<String>| ServerState {
            enabled,
            assigned,
            definition: definition.clone(),
        };
        assert!(server_authorizes(&state(true, vec![assistant.clone()]), &grant).is_ok());
        for refused in [
            state(false, vec![assistant.clone()]),
            state(true, Vec::new()),
            state(true, vec!["other".to_owned()]),
            state(true, vec![assistant.clone(), "other".to_owned()]),
        ] {
            assert_eq!(
                server_authorizes(&refused, &grant).err(),
                Some("computer_agent_grant_revoked"),
                "enabled={} assigned={:?}",
                refused.enabled,
                refused.assigned
            );
        }
    }

    /// The definition comparison is what stops a re-pointed server from inheriting a grant.
    /// Every negative case keeps the grant id and the token-file basename intact, so only a
    /// structural comparison can refuse them.
    #[test]
    fn a_definition_that_is_not_this_grant_is_refused() {
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let id = grant.id.clone();
        let assistant = grant.authority.bot_id.clone();
        let expected = fixture_definition(&id);
        let name = format!("loom-computer-agent-{}", &id[..id.len().min(8)]);
        let digest_text = "a".repeat(64);
        let state = |definition: String| ServerState {
            enabled: true,
            assigned: vec![assistant.clone()],
            definition,
        };
        assert!(server_authorizes(&state(expected.to_string()), &grant).is_ok());

        // Object key order is immaterial: Core may re-serialize the same definition. The
        // text is written by hand because `serde_json::Map` would sort the keys anyway.
        let reordered = format!(
            concat!(
                r#"{{"mcpServers":{{"{name}":{{"env":{{"LOOM_COMPUTER_AGENT_TOKEN_FILE":"/tmp/grants/token-abc","#,
                r#""LOOM_COMPUTER_AGENT_SCOPE":"control","#,
                r#""LOOM_COMPUTER_AGENT_SUBJECT":"assistant-1","#,
                r#""LOOM_COMPUTER_AGENT_RUNTIME":"pi","#,
                r#""LOOM_COMPUTER_AGENT_DIGEST":"{digest}","#,
                r#""LOOM_COMPUTER_AGENT_ORIGIN":"http://127.0.0.1:8443","#,
                r#""LOOM_COMPUTER_AGENT_ENDPOINT":"http://127.0.0.1:8443/api/v1/computer-agent/rpc","#,
                r#""LOOM_COMPUTER_AGENT_GRANT":"{id}"}},"#,
                r#""args":["/opt/mcp_bridge.py"],"command":"/opt/python3"}}}}}}"#,
            ),
            name = name,
            id = id,
            digest = digest_text,
        );
        assert!(
            server_authorizes(&state(reordered), &grant).is_ok(),
            "a re-serialized definition must still authorize"
        );

        let mut command_changed = expected.clone();
        command_changed["mcpServers"][name.as_str()]["command"] = json!("/opt/other-python");
        let mut args_changed = expected.clone();
        args_changed["mcpServers"][name.as_str()]["args"] = json!(["/opt/mcp_bridge.py", "--extra"]);
        let mut args_duplicated = expected.clone();
        args_duplicated["mcpServers"][name.as_str()]["args"] =
            json!(["/opt/mcp_bridge.py", "/opt/mcp_bridge.py"]);
        let mut endpoint_changed = expected.clone();
        endpoint_changed["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_ENDPOINT"] =
            json!("http://127.0.0.1:9999/api/v1/computer-agent/rpc");
        let mut origin_changed = expected.clone();
        origin_changed["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_ORIGIN"] =
            json!("http://127.0.0.1:9999");
        let mut token_path_changed = expected.clone();
        token_path_changed["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_TOKEN_FILE"] =
            json!("/tmp/grants/other/token-abc");
        let mut extra_server = expected.clone();
        extra_server["mcpServers"]["someone-else"] = json!({
            "command": "/opt/python3",
            "args": ["/opt/mcp_bridge.py"],
            "env": {}
        });
        let mut extra_env = expected.clone();
        extra_env["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_TIMEOUT_SECONDS"] = json!("60");
        // The authority is inside the definition, so a definition re-pointed at another
        // runtime, member or scope is not this grant either.
        let mut runtime_changed = expected.clone();
        runtime_changed["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_RUNTIME"] =
            json!("claude-code-cli");
        let mut subject_changed = expected.clone();
        subject_changed["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_SUBJECT"] =
            json!("assistant-2");
        let mut scope_changed = expected.clone();
        scope_changed["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_SCOPE"] =
            json!("view");

        for (case, foreign) in [
            ("command", command_changed),
            ("args", args_changed),
            ("args-duplicated", args_duplicated),
            ("endpoint", endpoint_changed),
            ("origin", origin_changed),
            ("token-path", token_path_changed),
            ("extra-server", extra_server),
            ("extra-env", extra_env),
            ("runtime", runtime_changed),
            ("subject", subject_changed),
            ("scope", scope_changed),
        ] {
            assert_eq!(
                server_authorizes(&state(foreign.to_string()), &grant).err(),
                Some("computer_agent_grant_revoked"),
                "a replaced definition ({case}) must not inherit the grant"
            );
        }

        // A duplicate key decodes to the last value, so a payload that first repeats the
        // canonical definition and then overrides it must still be refused.
        let duplicate_keys = format!(
            concat!(
                r#"{{"mcpServers":{{"{name}":{first},"{name}":"#,
                r#"{{"command":"/opt/other-python","args":["/opt/mcp_bridge.py"],"#,
                r#""env":{{"LOOM_COMPUTER_AGENT_TOKEN_FILE":"/tmp/grants/token-abc","#,
                r#""LOOM_COMPUTER_AGENT_GRANT":"{id}"}}}}}}}}"#,
            ),
            name = name,
            id = id,
            first = expected["mcpServers"][name.as_str()].to_string(),
        );
        assert_eq!(
            server_authorizes(&state(duplicate_keys), &grant).err(),
            Some("computer_agent_grant_revoked"),
            "a duplicate key that overrides the definition must not inherit the grant"
        );

        // Undecodable or absent expectations authorize nothing.
        for foreign in [String::new(), "not json".to_owned(), "{}".to_owned()] {
            assert_eq!(
                server_authorizes(&state(foreign), &grant).err(),
                Some("computer_agent_grant_revoked")
            );
        }
        let mut unrecorded = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        *Arc::get_mut(&mut unrecorded).unwrap().expected_definition.lock().unwrap() = None;
        assert_eq!(
            server_authorizes(&state(expected.to_string()), &unrecorded).err(),
            Some("computer_agent_grant_revoked"),
            "a grant with no recorded definition must never authorize"
        );
    }

    /// The real Core store is the only fixture that can prove all three halves at once: the
    /// configuration digest is Core's own `sha256:` value, the public view masks the
    /// token-file path (so that text can never authorize), and `mcp.servers.reveal` at the
    /// same digest hands back exactly the definition this Host minted.
    ///
    /// Before this fix the read used the wrapped `config.servers` shape (empty on the flat
    /// view, so every tool call saw "server gone") and compared the *masked* public
    /// `definitionJson`, so no real grant could ever authorize its own server.
    #[test]
    fn the_masked_public_view_cannot_grant_but_the_exact_reveal_does() {
        use rovai_core::mcp::{
            CreateMcpServerParams, McpConfigStore, McpMutationResult, RevealMcpServerParams,
            SetMcpMembersParams, SetMcpServerEnabledParams,
        };
        let (sessions, owner, _token) = browser();
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        let assistant = grant.authority.bot_id.clone();
        let known: std::collections::BTreeSet<String> = [assistant.clone()].into_iter().collect();
        let root = std::env::temp_dir().join(format!("loom-mcp-{}", crate::new_token().unwrap()));
        let store = McpConfigStore::new(root.join(".rovai/mcp.json"));

        // Mint through the real store exactly what this grant recorded.
        let definition = fixture_definition(&grant.id).to_string();
        let created = store
            .create(
                CreateMcpServerParams {
                    expected_config_digest: store.get(&known).unwrap().config_digest,
                    definition_json: definition.clone(),
                },
                &known,
            )
            .unwrap();
        let McpMutationResult::Ok {
            config_digest: created_digest,
            config,
            ..
        } = created
        else {
            panic!("the real store must accept the minted definition");
        };
        let server_id = config.servers[0].server_id.clone();
        let members = store
            .set_members(
                SetMcpMembersParams {
                    expected_config_digest: created_digest,
                    server_id: server_id.clone(),
                    agent_ids: vec![assistant.clone()],
                    acknowledge_high_risk: false,
                },
                &known,
            )
            .unwrap();
        assert!(
            matches!(members, McpMutationResult::Ok { .. }),
            "the created server must be assigned to this assistant"
        );
        // `create` always stores `enabled: false` (`mcp.rs:713`), so the real sequence needs
        // the same explicit enable the production path performs.
        let McpMutationResult::Ok {
            config_digest: members_digest,
            ..
        } = members
        else {
            panic!("the assignment must succeed");
        };
        let enabled = store
            .set_enabled(
                SetMcpServerEnabledParams {
                    expected_config_digest: members_digest,
                    server_id: server_id.clone(),
                    enabled: true,
                    acknowledge_high_risk: false,
                },
                &known,
            )
            .unwrap();
        assert!(
            matches!(enabled, McpMutationResult::Ok { .. }),
            "the created server must be enabled"
        );

        // The flat public view, exactly as `mcp.config.get` serializes it.
        let public = serde_json::to_value(store.get(&known).unwrap()).unwrap();
        let digest = config_digest(&public).expect("the real digest is a canonical sha256");
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), "sha256:".len() + 64);
        assert!(
            digest["sha256:".len()..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "the digest suffix is lowercase hex"
        );
        assert_eq!(public["configDigest"].as_str(), Some(digest.as_str()));
        let entry = server_entry(
            public_servers(&public).expect("the real view carries a servers list"),
            &server_id,
        )
        .expect("the exact server entry must be present");
        assert!(entry.enabled);
        assert_eq!(entry.assigned, vec![assistant.clone()]);
        // Core masks the token-file path, so the public text is not this grant's definition.
        let masked = public["servers"][0]["definitionJson"].as_str().unwrap();
        assert!(
            !masked.contains("token-abc"),
            "the public view must not carry the token-file path"
        );
        assert!(
            !definition_matches(masked, &grant),
            "a masked definition can never authorize"
        );

        // The reveal at the same digest returns the exact unmasked definition.
        let revealed = serde_json::to_value(
            store
                .reveal(RevealMcpServerParams {
                    expected_config_digest: digest.clone(),
                    server_id: server_id.clone(),
                })
                .unwrap(),
        )
        .unwrap();
        let definition = revealed_definition(&revealed, &server_id, &digest)
            .expect("the exact reveal must be admitted");
        assert!(
            definition_matches(&definition, &grant),
            "the exact revealed definition authorizes"
        );
        assert!(
            server_authorizes(
                &ServerState {
                    enabled: entry.enabled,
                    assigned: entry.assigned.clone(),
                    definition: definition.clone(),
                },
                &grant
            )
            .is_ok()
        );
        // A reveal that moved the token file is not this grant, even though every other
        // field is byte-identical.
        let mut foreign: Value = serde_json::from_str(&definition).unwrap();
        let name = format!("loom-computer-agent-{}", &grant.id[..grant.id.len().min(8)]);
        foreign["mcpServers"][name.as_str()]["env"]["LOOM_COMPUTER_AGENT_TOKEN_FILE"] =
            json!("/tmp/grants/other/token-abc");
        assert_eq!(
            server_authorizes(
                &ServerState {
                    enabled: entry.enabled,
                    assigned: entry.assigned.clone(),
                    definition: foreign.to_string(),
                },
                &grant
            )
            .err(),
            Some("computer_agent_grant_revoked"),
            "a re-pointed token file must not inherit the grant"
        );
    }

    // ---- finding 6: an unconfirmed cleanup stays visible and retryable ----------------

    #[test]
    fn failed_cleanup_keeps_the_grant_visible_and_can_be_retried() {
        let (sessions, owner, _token) = browser();
        let fake = FakeMcp::new();
        // The server still exists and is disabled, so cleanup reaches `delete`.
        fake.present(false, &[], "");
        fake.fail_delete.store(true, Ordering::SeqCst);
        let grants = AgentGrants::for_test(fake.clone());
        let grant = grant_for(&sessions, &owner, wall_clock() + 60_000, false);
        grant.record_server("server-abc12345");
        grants.publish(grant.clone());
        let computer = idle_computer();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let first = runtime.block_on(async { retire(&computer, &grants.mcp, &grant).await });
        // Physical input dies first, whatever the MCP outcome is.
        assert!(grant.revoked.load(Ordering::Acquire));
        assert_eq!(first.err(), Some("computer_agent_cleanup_unconfirmed"));
        assert!(!grant.cleaned.load(Ordering::Acquire), "cleanup is not confirmed");
        // Still listed for its owner: the failure is visible, not hidden.
        assert_eq!(grants.owned(&owner.client_id, wall_clock()).len(), 1);
        let shown = public_grant(&grant, wall_clock());
        assert_eq!(shown["state"], json!("revoked"));
        assert_eq!(shown["cleanupPending"], json!(true));
        // A retry after the Core failure clears is allowed and then reports success.
        fake.fail_delete.store(false, Ordering::SeqCst);
        let second = runtime.block_on(async { retire(&computer, &grants.mcp, &grant).await });
        assert!(second.is_ok(), "a proven retry must succeed");
        assert!(grant.cleaned.load(Ordering::Acquire));
        assert_eq!(
            public_grant(&grant, wall_clock())["cleanupPending"],
            json!(false)
        );
    }

    // ---- finding 8: the origin is never downgraded ----------------------------------

    #[test]
    fn an_https_origin_is_refused_instead_of_downgraded() {
        assert_eq!(
            loopback_origin("http://127.0.0.1:8443", 8443).as_deref(),
            Some("http://127.0.0.1:8443")
        );
        // No silent downgrade to `http://`, and no substitution of the scheme.
        assert!(loopback_origin("https://127.0.0.1:8443", 8443).is_none());
        assert!(loopback_origin("https://localhost:8443", 8443).is_none());
        // Everything else that used to be filtered is still filtered.
        assert!(loopback_origin("http://127.0.0.1:8444", 8443).is_none());
        assert!(loopback_origin("http://example.com:8443", 8443).is_none());
        assert!(loopback_origin("http://user@127.0.0.1:8443", 8443).is_none());
        assert!(loopback_origin("http://127.0.0.1:8443/x", 8443).is_none());
    }
}
