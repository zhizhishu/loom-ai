//! Local Computer Provider: explicit-consent desktop capture plus fenced input.
//!
//! Invariants owned by this module:
//! * Disabled unless the Host process sets `LOOM_COMPUTER_HELPER` (absolute script)
//!   and `LOOM_COMPUTER_PYTHON` (absolute interpreter). No request field ever
//!   selects a program, a path or an environment value.
//! * Every pixel-producing call requires an explicit `consent: true` in its body.
//!   `status` never captures and never runs input. A failed capture is an error;
//!   no frame is ever synthesised, cached or logged.
//! * One physical device has at most one controller across every view and every
//!   session. A view only authorises capture; control is a separate lease with a
//!   bounded TTL, an idle deadman and an absolute maximum that no heartbeat can
//!   extend.
//! * Input admission, the final liveness/lease/generation recheck and the OS input
//!   call all happen while one gate mutex is held. `release`/`view/stop` take the
//!   same gate, so their return is a barrier: after it, no queued input belonging
//!   to an older lease generation can still execute.
//! * The boundary between a person and the agent is one exclusive lease per
//!   physical device. Taking it is a takeover: it is refused while another
//!   client holds a live lease, it advances the epoch (the generation every
//!   input is fenced against) exactly once, and it stays bounded by the same
//!   five-minute control ceiling that no refresh can extend. Handing the device
//!   back clears the holder and advances the epoch exactly once too, so an input
//!   admitted for the outgoing holder can never execute after the handback.
//! * A device reached over a paired node keeps its epoch across reconnects even
//!   though every lease, view and sequence is dropped with the replaced socket:
//!   the replaced instance is retired first, so a caller that still holds it
//!   fails closed instead of reaching the new connection, and the epoch never
//!   runs backwards, so an epoch issued before a reconnect can never be issued
//!   again after it. The epoch is not copied into the replacement: both devices
//!   allocate from the *same* counter, so a takeover that already held the old
//!   gate when the reconnect happened still cannot hand out a number the
//!   replacement will hand out again.
//! * Reading the epoch and retiring a device never wait for the input gate: the
//!   epoch is a shared atomic allocator, so a reconnect cannot stall on an input
//!   that is still running.
//! * Nothing about a session, a frame or an input event is persisted or logged.

use crate::auth::{Session, Sessions};
use crate::{WebState, error};
use axum::{
    Extension, Json,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

mod helper;
mod node_provider;
use helper::{HelperLaunch, HelperReply};
pub(crate) use node_provider::NodeComputers;

/// A view (capture consent) lives this long, measured from its creation.
pub(crate) const VIEW_LIFETIME_MS: u64 = 300_000;
/// Control TTL requested at acquisition when the client asks for nothing else.
pub(crate) const CONTROL_TTL_DEFAULT_MS: u64 = 30_000;
/// Longest single control TTL a client may request.
pub(crate) const CONTROL_TTL_MAX_MS: u64 = 60_000;
/// Absolute control ceiling. Heartbeats refresh the TTL, never this deadline.
///
/// This is the five-minute lease a takeover is bounded by: the upstream takeover
/// branch grants five minutes and lets a refresh reset it to another five, while
/// this Host grants at most `CONTROL_TTL_MAX_MS` per request and refuses to pass
/// `CONTROL_TOTAL_MAX_MS` from the takeover itself. The takeover lease is
/// therefore never longer than upstream's and can be shorter, which is the
/// deliberate, stricter half of that branch.
pub(crate) const CONTROL_TOTAL_MAX_MS: u64 = 300_000;
/// A controller that neither heartbeats nor inputs for this long loses control.
pub(crate) const INPUT_IDLE_DEADMAN_MS: u64 = 15_000;
/// Minimum spacing between two captures for the whole device.
pub(crate) const MIN_FRAME_INTERVAL_MS: u64 = 200;
pub(crate) const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_DIMENSION: u32 = 4096;
pub(crate) const MAX_TEXT_CODEPOINTS: usize = 2048;
pub(crate) const MAX_VIEWS: usize = 4;
/// How long a caller waits for the input gate before reporting `computer_busy`.
const GATE_DEADLINE_MS: u64 = 7_000;
/// One helper invocation, including its own kill/reap deadline.
const HELPER_DEADLINE: Duration = Duration::from_secs(5);
/// Outer bound for a whole blocking section; the helper bounds itself first.
const BLOCKING_DEADLINE: Duration = Duration::from_secs(14);
/// Blocking sections allowed to run at once, per Host.
const MAX_JOBS: usize = 4;
/// How long a failed metadata probe is remembered before it is retried.
const DEVICE_RETRY_MS: u64 = 5_000;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Static capability projection for `/api/v1/capabilities` and the login reply.
pub(crate) fn capabilities(state: &WebState) -> Value {
    state.computer.report()
}

fn wall_clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn http_status(code: &'static str) -> StatusCode {
    match code {
        "session_required" => StatusCode::UNAUTHORIZED,
        "computer_invalid_request" | "computer_input_invalid" => StatusCode::BAD_REQUEST,
        "computer_consent_required" => StatusCode::FORBIDDEN,
        "computer_view_unknown" => StatusCode::NOT_FOUND,
        "node_not_found" => StatusCode::NOT_FOUND,
        "computer_node_unsupported" => StatusCode::CONFLICT,
        "computer_device_mismatch"
        | "computer_control_held"
        | "computer_human_control"
        | "computer_control_required"
        | "computer_lease_expired"
        | "computer_input_stale"
        | "computer_input_out_of_order" => StatusCode::CONFLICT,
        "computer_throttled" | "computer_view_limit" => StatusCode::TOO_MANY_REQUESTS,
        "computer_capture_failed" | "computer_capture_invalid" | "computer_input_failed" => {
            StatusCode::BAD_GATEWAY
        }
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

fn reject(code: &'static str) -> Response {
    error(http_status(code), code)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Bounds {
    /// Signed screen origin. Multi-monitor layouts legitimately use negative
    /// values, so client coordinates are checked against this rectangle rather
    /// than assumed to start at (0, 0).
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Bounds {
    fn contains(&self, x: i32, y: i32) -> bool {
        let dx = i64::from(x) - i64::from(self.x);
        let dy = i64::from(y) - i64::from(self.y);
        dx >= 0 && dy >= 0 && dx < i64::from(self.width) && dy < i64::from(self.height)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeviceInfo {
    pub id: String,
    pub platform: String,
    pub bounds: Bounds,
}

pub(crate) struct Frame {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub bounds: Bounds,
    pub scale: f64,
    pub captured_at: u64,
}

/// Test-only and deliberately metadata-only: a `Debug` impl that printed `png` would put
/// captured screen bytes into panic messages and test logs. Production builds never contain
/// this impl.
#[cfg(test)]
impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Frame")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("png_len", &self.png.len())
            .field("scale", &self.scale)
            .field("captured_at", &self.captured_at)
            .finish_non_exhaustive()
    }
}

/// A backend refusal. Each variant keeps its own public code so "Pillow missing",
/// "no X11 display" and "session locked" are distinguishable facts instead of one
/// generic failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// No helper configured, or the configured helper is not runnable.
    Unavailable,
    EncoderUnavailable,
    BackendUnavailable,
    SessionLocked,
    Timeout,
    InputFailed,
    Invalid,
    Failed,
    /// The device cannot perform this operation at all (for example text the
    /// backend cannot encode). It refused before any side effect.
    Unsupported,
    /// A remote device did not confirm that it drained and released physical
    /// input. This is never a success, and the Host never retries it silently.
    Unconfirmed,
}

impl Failure {
    fn capture_code(&self) -> &'static str {
        match self {
            Self::Unavailable => "computer_unsupported",
            Self::EncoderUnavailable => "computer_encoder_unavailable",
            Self::BackendUnavailable => "computer_backend_unavailable",
            Self::SessionLocked => "computer_session_locked",
            Self::Timeout => "computer_helper_timeout",
            Self::Invalid => "computer_capture_invalid",
            Self::InputFailed => "computer_input_failed",
            Self::Failed => "computer_capture_failed",
            Self::Unsupported => "computer_unsupported",
            Self::Unconfirmed => "computer_release_unconfirmed",
        }
    }

    fn input_code(&self) -> &'static str {
        match self {
            Self::Unavailable => "computer_unsupported",
            // Refused before injecting: nothing reached the OS.
            Self::Unsupported => "computer_input_unsupported",
            // Any attempted input may already have reached the OS. One code, so
            // the client can never mistake a partial send for a clean refusal.
            Self::EncoderUnavailable
            | Self::BackendUnavailable
            | Self::SessionLocked
            | Self::Timeout
            | Self::InputFailed
            | Self::Invalid
            | Self::Failed
            | Self::Unconfirmed => "computer_input_unknown",
        }
    }

    /// A release that could not be confirmed is reported as unconfirmed; it is
    /// never folded into a generic failure the caller could read as success.
    fn release_code(&self) -> &'static str {
        match self {
            Self::Unavailable => "computer_unsupported",
            _ => "computer_release_unconfirmed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PointerButton {
    Left,
    Right,
    Middle,
}

impl PointerButton {
    fn wire(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PointerAction {
    Click,
    Move,
}

impl PointerAction {
    fn wire(self) -> &'static str {
        match self {
            Self::Click => "click",
            Self::Move => "move",
        }
    }
}

/// Closed key whitelist. Every key is a tap (down+up in one atomic backend call),
/// so a key can never be left in the down state by a dropped client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyName {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Shift,
    Ctrl,
    Alt,
    Meta,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
}

impl KeyName {
    fn wire(self) -> &'static str {
        match self {
            Self::Enter => "enter",
            Self::Tab => "tab",
            Self::Escape => "escape",
            Self::Backspace => "backspace",
            Self::Delete => "delete",
            Self::Space => "space",
            Self::Left => "left",
            Self::Right => "right",
            Self::Up => "up",
            Self::Down => "down",
            Self::Home => "home",
            Self::End => "end",
            Self::PageUp => "pageup",
            Self::PageDown => "pagedown",
            Self::Shift => "shift",
            Self::Ctrl => "ctrl",
            Self::Alt => "alt",
            Self::Meta => "meta",
            Self::F1 => "f1",
            Self::F2 => "f2",
            Self::F3 => "f3",
            Self::F4 => "f4",
            Self::F5 => "f5",
            Self::F6 => "f6",
            Self::F7 => "f7",
            Self::F8 => "f8",
            Self::F9 => "f9",
            Self::F10 => "f10",
            Self::F11 => "f11",
            Self::F12 => "f12",
        }
    }
}

/// What the backend may be asked to do. There is deliberately no command string,
/// no argv and no shell: only these four closed shapes exist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InputCommand {
    Pointer {
        x: i32,
        y: i32,
        button: Option<PointerButton>,
        action: PointerAction,
    },
    Wheel {
        x: i32,
        y: i32,
        delta: i32,
    },
    Key {
        key: KeyName,
    },
    Text {
        text: String,
    },
}

impl InputCommand {
    fn wire(&self) -> Value {
        match self {
            Self::Pointer {
                x,
                y,
                button,
                action,
            } => json!({"op":"pointer","x":x,"y":y,
                "button":button.map(PointerButton::wire),"action":action.wire()}),
            Self::Wheel { x, y, delta } => json!({"op":"wheel","x":x,"y":y,"delta":delta}),
            Self::Key { key } => json!({"op":"key","key":key.wire()}),
            Self::Text { text } => json!({"op":"text","text":text}),
        }
    }
}

pub(crate) trait Provider: Send + Sync + 'static {
    /// Screen geometry and device identity only. This is metadata: it returns no
    /// pixels and never injects input.
    fn info(&self) -> Result<DeviceInfo, Failure>;
    fn capture(&self, max_width: u32, max_height: u32) -> Result<Frame, Failure>;
    fn input(&self, command: &InputCommand) -> Result<(), Failure>;
    /// Physical release fence. `Ok` asserts that the device released every
    /// button and finished every input it had accepted. A provider that cannot
    /// prove that — a lost remote connection, an unknown outcome — must return
    /// `Err`, and the caller then reports the release as unconfirmed instead of
    /// claiming a release it cannot see.
    ///
    /// There is deliberately no default implementation: only a provider that
    /// really owns the device may answer, so a remote provider can never inherit
    /// a success it did not observe.
    fn release(&self) -> Result<(), Failure>;
}

struct HelperProvider {
    launch: HelperLaunch,
}

fn validate_frame(reply: &HelperReply, body: Vec<u8>) -> Result<Frame, Failure> {
    let width = reply.width.ok_or(Failure::Invalid)?;
    let height = reply.height.ok_or(Failure::Invalid)?;
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || body.len() < PNG_SIGNATURE.len()
        || body.len() > MAX_FRAME_BYTES
        || !body.starts_with(&PNG_SIGNATURE)
    {
        return Err(Failure::Invalid);
    }
    let bounds = Bounds {
        x: reply.origin_x.unwrap_or(0),
        y: reply.origin_y.unwrap_or(0),
        width: reply.screen_width.unwrap_or(width),
        height: reply.screen_height.unwrap_or(height),
    };
    if bounds.width == 0 || bounds.height == 0 {
        return Err(Failure::Invalid);
    }
    Ok(Frame {
        png: body,
        width,
        height,
        bounds,
        scale: reply.scale.unwrap_or(1.0),
        captured_at: reply.captured_at.unwrap_or(0),
    })
}

/// The authoritative payload contract for every frame that leaves a provider.
///
/// The local helper and the remote node each check their own reply shape, but those are
/// per-transport parse checks: they cannot vouch for a provider that was replaced, wrapped
/// or faked, and they are not re-run once the value is built. This predicate is the single
/// gate every returned frame passes through before a browser or an agent can reach it, and
/// it is exactly the union of the two provider checks: a real dimension inside the limit, a
/// bounded body that starts with the PNG signature, and a non-degenerate screen rectangle.
fn validate_frame_payload(frame: &Frame) -> Result<(), Failure> {
    if frame.width == 0
        || frame.height == 0
        || frame.width > MAX_DIMENSION
        || frame.height > MAX_DIMENSION
        || frame.png.len() < PNG_SIGNATURE.len()
        || frame.png.len() > MAX_FRAME_BYTES
        || !frame.png.starts_with(&PNG_SIGNATURE)
        || frame.bounds.width == 0
        || frame.bounds.height == 0
    {
        return Err(Failure::Invalid);
    }
    Ok(())
}

impl Provider for HelperProvider {
    fn info(&self) -> Result<DeviceInfo, Failure> {
        let (reply, body) = helper::run(&self.launch, &json!({"op": "info"}), HELPER_DEADLINE)?;
        if !body.is_empty() {
            return Err(Failure::Invalid);
        }
        let platform = reply.platform.ok_or(Failure::Invalid)?;
        let id = reply.device_id.ok_or(Failure::Invalid)?;
        if id.is_empty() || platform.is_empty() {
            return Err(Failure::Invalid);
        }
        let bounds = Bounds {
            x: reply.origin_x.unwrap_or(0),
            y: reply.origin_y.unwrap_or(0),
            width: reply.screen_width.ok_or(Failure::Invalid)?,
            height: reply.screen_height.ok_or(Failure::Invalid)?,
        };
        if bounds.width == 0
            || bounds.height == 0
            || bounds.width > MAX_DIMENSION * 4
            || bounds.height > MAX_DIMENSION * 4
        {
            return Err(Failure::Invalid);
        }
        Ok(DeviceInfo {
            id,
            platform,
            bounds,
        })
    }

    fn capture(&self, max_width: u32, max_height: u32) -> Result<Frame, Failure> {
        // `consent` is hard-coded here: the HTTP layer only reaches this code
        // after the caller supplied its own explicit consent.
        let (reply, body) = helper::run(
            &self.launch,
            &json!({"op":"capture","consent":true,"maxWidth":max_width,"maxHeight":max_height}),
            HELPER_DEADLINE,
        )?;
        validate_frame(&reply, body)
    }

    fn input(&self, command: &InputCommand) -> Result<(), Failure> {
        match helper::run(&self.launch, &command.wire(), HELPER_DEADLINE) {
            Ok((_, body)) if body.is_empty() => Ok(()),
            Ok(_) => {
                self.release_best_effort();
                Err(Failure::InputFailed)
            }
            Err(failure) => {
                // A partial native send can leave a key or button held. Release what may
                // have been pressed before reporting the failure; never press again.
                self.release_best_effort();
                Err(failure)
            }
        }
    }

    fn release(&self) -> Result<(), Failure> {
        self.confirmed_release()
    }
}

impl HelperProvider {
    /// Best effort, bounded, and used only after a failed or partial input. It never
    /// presses: the helper's `release` op emits up-only events.
    fn release_best_effort(&self) {
        let _ = helper::run(&self.launch, &json!({"op": "release"}), HELPER_DEADLINE);
    }

    /// The helper is a child of this process, so a completed one-shot release is
    /// the strongest proof this backend can offer. It stays bounded and it never
    /// presses.
    fn confirmed_release(&self) -> Result<(), Failure> {
        helper::run(&self.launch, &json!({"op": "release"}), HELPER_DEADLINE).map(|_| ())
    }
}

/// The disabled provider keeps the "no helper configured" state honest: every
/// call fails closed instead of returning an empty or placeholder desktop.
struct UnavailableProvider;

impl Provider for UnavailableProvider {
    fn info(&self) -> Result<DeviceInfo, Failure> {
        Err(Failure::Unavailable)
    }
    fn capture(&self, _max_width: u32, _max_height: u32) -> Result<Frame, Failure> {
        Err(Failure::Unavailable)
    }
    fn input(&self, _command: &InputCommand) -> Result<(), Failure> {
        Err(Failure::Unavailable)
    }
    fn release(&self) -> Result<(), Failure> {
        Err(Failure::Unavailable)
    }
}

#[derive(Clone)]
struct Config {
    helper: HelperLaunch,
}

impl Config {
    /// Explicit Host-owned opt-in only. Both paths must be absolute existing
    /// files; nothing is discovered from PATH or from a request.
    fn from_env() -> Option<Self> {
        let script = std::env::var_os("LOOM_COMPUTER_HELPER")?;
        let script = std::path::PathBuf::from(script);
        let python = std::env::var_os("LOOM_COMPUTER_PYTHON")?;
        let python = std::path::PathBuf::from(python);
        (script.is_absolute()
            && script.is_file()
            && python.is_absolute()
            && python.is_file())
        .then_some(Self {
            helper: HelperLaunch { python, script },
        })
    }
}

struct View {
    client_id: String,
    created_at: u64,
    bounds: Bounds,
}

struct Control {
    id: String,
    client_id: String,
    view_id: String,
    generation: u64,
    ttl_ms: u64,
    expires_at: u64,
    total_deadline: u64,
    seq_high: u64,
    last_input_at: u64,
    agent: bool,
}

impl Control {
    fn alive(&self, now: u64) -> bool {
        now <= self.expires_at
            && now <= self.total_deadline
            && now.saturating_sub(self.last_input_at) <= INPUT_IDLE_DEADMAN_MS
    }
}

/// A live lease also requires its bound view to still exist: a removed or expired view
/// must not keep the physical device reserved until the idle deadman fires.
fn control_alive(gate: &Gate, control: &Control, now: u64) -> bool {
    control.alive(now) && gate.views.contains_key(&control.view_id)
}

#[derive(Default)]
struct Gate {
    views: HashMap<String, View>,
    /// One controller for the whole physical device.
    control: Option<Control>,
    generation: u64,
    frames: u64,
    last_capture_at: u64,
    device: Option<DeviceInfo>,
    /// Short negative cache for the metadata probe so a broken backend is not
    /// re-spawned on every status poll.
    device_error: Option<(&'static str, u64)>,
}

pub(crate) struct Computer {
    config: Option<Config>,
    provider: Arc<dyn Provider>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    gate: Mutex<Gate>,
    /// The epoch allocator, shared with every replacement of this physical device.
    /// It is read by whichever device is being replaced — which must never wait for
    /// an input that still holds a gate — and advanced with `fetch_add`, so two
    /// devices that both reach an advance allocate distinct values even while they
    /// hold two different gates. It only ever moves forward.
    epoch: Arc<AtomicU64>,
    /// Set when a replacement connection took over this physical device. Every
    /// operation on a retired instance fails closed, so no request that still
    /// holds it can reach the provider of a newer connection.
    retired: AtomicBool,
    captures: Arc<Semaphore>,
    /// True when the device belongs to a paired node rather than this process.
    /// `supported()` is then a fact about the node's advertised capability, not
    /// about a local helper path.
    remote: bool,
    /// Bounds how many blocking sections may run at once, so an authenticated burst
    /// cannot flood the blocking pool. It never changes OS linearization.
    jobs: Arc<Semaphore>,
    /// Test-only parking point inside the takeover gate, so a retirement can be
    /// made to land in the exact window between "this takeover has the gate" and
    /// "this takeover allocates its epoch".
    #[cfg(test)]
    acquire_hold: Mutex<Option<AcquireHold>>,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcquirePark {
    /// Inside the gate, before the retirement re-check.
    BeforeRetirementCheck,
    /// After the retirement re-check, immediately before the epoch allocation.
    BeforeAllocation,
}

#[cfg(test)]
pub(crate) struct AcquireHold {
    stage: AcquirePark,
    pub(crate) entered: std::sync::mpsc::Sender<()>,
    pub(crate) proceed: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl Computer {
    pub(crate) fn from_env() -> Self {
        let config = Config::from_env();
        let provider: Arc<dyn Provider> = match &config {
            Some(config) => Arc::new(HelperProvider {
                launch: config.helper.clone(),
            }),
            None => Arc::new(UnavailableProvider),
        };
        Self {
            config,
            provider,
            clock: Arc::new(wall_clock),
            gate: Mutex::new(Gate::default()),
            epoch: Arc::new(AtomicU64::new(0)),
            retired: AtomicBool::new(false),
            captures: Arc::new(Semaphore::new(1)),
            remote: false,
            jobs: Arc::new(Semaphore::new(MAX_JOBS)),
            #[cfg(test)]
            acquire_hold: Mutex::new(None),
        }
    }

    /// A device this process does not own: a paired node's desktop. There is no
    /// local helper, so `config` stays `None` and `supported()` rests on the
    /// node's advertised capability alone. The caller only reaches this after
    /// the node proved it with a successful metadata probe.
    ///
    /// `epoch` is the counter of the device this one replaces, and the replacement
    /// keeps using it rather than copying a value out of it: a first install starts
    /// at zero, a reconnect shares the allocator of the device it replaces. No
    /// lease, view or input sequence is inherited — a lease held against a replaced
    /// socket must be refused, not remembered — but the counter never runs
    /// backwards and never hands the same number to two devices, so an epoch the
    /// previous device already issued is never issued again.
    pub(crate) fn with_provider(provider: Arc<dyn Provider>, epoch: Arc<AtomicU64>) -> Self {
        Self {
            config: None,
            provider,
            clock: Arc::new(wall_clock),
            gate: Mutex::new(Gate {
                generation: epoch.load(Ordering::SeqCst),
                ..Gate::default()
            }),
            epoch,
            retired: AtomicBool::new(false),
            captures: Arc::new(Semaphore::new(1)),
            remote: true,
            jobs: Arc::new(Semaphore::new(MAX_JOBS)),
            #[cfg(test)]
            acquire_hold: Mutex::new(None),
        }
    }

    /// The epoch this device has reached: the value of the allocator shared with
    /// every replacement of this physical device. It is a counter load, never a gate
    /// read, because a reconnect must not wait for an input that is still holding the
    /// gate.
    ///
    /// Test-only observability: production only hands the allocator to a replacement
    /// (`retire`) and never samples this device's value, precisely so a sampled value
    /// can never go stale.
    #[cfg(test)]
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Allocate the next epoch. `fetch_add` on the shared counter is what makes the
    /// allocator, not the gate, the single issuer: two devices of the same physical
    /// machine can hold two different gates at the same time (the replaced one was
    /// already inside its gate when the reconnect arrived), and each allocated value
    /// is still unique and strictly increasing.
    fn next_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
    }

    /// Retire this device because a newer connection now owns the same physical
    /// machine, and hand the replacement its epoch allocator.
    ///
    /// Retirement is the fence, not the replacement: every later operation fails
    /// closed through [`Computer::gate`], so a caller that still holds this `Arc`
    /// can never reach the provider — and therefore never reach the socket of the
    /// connection that replaced it. The lease, the views and the input sequence
    /// are dropped with the old connection; only the allocator is carried forward.
    /// Nothing here waits for the gate: an input that already holds it finishes
    /// against the device it was admitted for, which the retirement has already
    /// fenced off from every new admission.
    ///
    /// The allocator itself is handed over rather than a sampled value: retirement
    /// cannot always take the gate (an input, or a takeover, may be inside it), and
    /// a value sampled here would be stale the moment that takeover advances the
    /// epoch. Sharing it keeps both devices on one strictly increasing sequence.
    pub(crate) fn retire(&self) -> Arc<AtomicU64> {
        self.retired.store(true, Ordering::SeqCst);
        // Best effort, and deliberately `try_lock`: revoking the lease and
        // advancing the epoch are worth doing, but an input still running must not
        // delay the replacement. Nothing depends on this branch succeeding: the
        // retirement flag already fences every later operation, a takeover that is
        // parked inside the gate re-checks it before allocating, and the allocator
        // is shared, so a miss cannot produce a duplicate epoch.
        if let Ok(mut gate) = self.gate.try_lock() {
            gate.views.clear();
            self.expire_control(&mut gate);
        }
        self.epoch.clone()
    }

    fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    /// Queues the next [`Computer::acquire`] inside its gate at `stage`. Tests use
    /// it to place a reconnect in the exact windows the review called out;
    /// production code never parks.
    #[cfg(test)]
    pub(crate) fn park_next_acquire(
        &self,
        stage: AcquirePark,
        entered: std::sync::mpsc::Sender<()>,
        proceed: std::sync::mpsc::Receiver<()>,
    ) {
        *self.acquire_hold.lock().unwrap() = Some(AcquireHold {
            stage,
            entered,
            proceed: Mutex::new(proceed),
        });
    }

    #[cfg(test)]
    fn park_acquire(&self, stage: AcquirePark) {
        {
            let armed = self.acquire_hold.lock().unwrap();
            if armed.as_ref().map(|hold| hold.stage) != Some(stage) {
                return;
            }
        }
        let hold = self
            .acquire_hold
            .lock()
            .unwrap()
            .take()
            .expect("the stage was armed under the same lock");
        let _ = hold.entered.send(());
        let _ = hold.proceed.lock().unwrap().recv();
    }

    #[cfg(test)]
    pub(crate) fn with_test_provider(
        provider: Arc<dyn Provider>,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self::with_parts(provider, clock)
    }

    #[cfg(test)]
    fn with_parts(
        provider: Arc<dyn Provider>,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            config: Some(Config {
                helper: HelperLaunch {
                    python: std::path::PathBuf::from("/nonexistent/python"),
                    script: std::path::PathBuf::from("/nonexistent/host_desktop.py"),
                },
            }),
            provider,
            clock,
            gate: Mutex::new(Gate::default()),
            epoch: Arc::new(AtomicU64::new(0)),
            retired: AtomicBool::new(false),
            captures: Arc::new(Semaphore::new(1)),
            remote: false,
            jobs: Arc::new(Semaphore::new(MAX_JOBS)),
            #[cfg(test)]
            acquire_hold: Mutex::new(None),
        }
    }

    /// Non-blocking admission for one blocking section.
    pub(crate) fn try_job(&self) -> Result<tokio::sync::OwnedSemaphorePermit, &'static str> {
        self.jobs
            .clone()
            .try_acquire_owned()
            .map_err(|_| "computer_busy")
    }

    pub(crate) fn supported(&self) -> bool {
        self.remote || self.config.is_some()
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    /// Static, side-effect free capability report. `configured` is a fact about
    /// the Host environment; it is not evidence that a screen is capturable. That
    /// evidence is `status.ready`, which comes from an actual metadata probe.
    pub(crate) fn report(&self) -> Value {
        json!({
            "configured": self.supported(),
            "ready": Value::Null,
            "reason": if self.supported() { Value::Null } else { json!("computer_helper_not_configured") },
            "capture": self.supported(),
            "input": self.supported(),
            "consentRequired": true,
            "viewLifetimeSeconds": VIEW_LIFETIME_MS / 1000,
            "controlTtlSeconds": {"default": CONTROL_TTL_DEFAULT_MS / 1000, "max": CONTROL_TTL_MAX_MS / 1000},
            "controlTotalSeconds": CONTROL_TOTAL_MAX_MS / 1000,
            "inputIdleSeconds": INPUT_IDLE_DEADMAN_MS / 1000,
            "maxFrameBytes": MAX_FRAME_BYTES,
            "maxDimension": MAX_DIMENSION,
            "maxTextCodepoints": MAX_TEXT_CODEPOINTS,
            "minFrameIntervalMs": MIN_FRAME_INTERVAL_MS,
            "maxViews": MAX_VIEWS,
        })
    }

    fn gate(&self) -> Result<MutexGuard<'_, Gate>, &'static str> {
        // A retired device is fenced before anyone waits for the gate, and again
        // after the wait: a retirement that happened while this caller queued must
        // still refuse the operation.
        if self.is_retired() {
            return Err("computer_unavailable");
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(GATE_DEADLINE_MS);
        loop {
            // A retirement that happened while this caller queued refuses it here
            // instead of making it wait out the gate deadline for a device that is
            // already fenced.
            if self.is_retired() {
                return Err("computer_unavailable");
            }
            match self.gate.try_lock() {
                Ok(guard) => {
                    return if self.is_retired() {
                        Err("computer_unavailable")
                    } else {
                        Ok(guard)
                    };
                }
                // A poisoned gate means the in-memory lease state is untrustworthy.
                // Fail closed instead of adopting unknown state.
                Err(TryLockError::Poisoned(_)) => return Err("computer_unavailable"),
                Err(TryLockError::WouldBlock) => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err("computer_busy");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn supported_or(&self, code: &'static str) -> Result<(), &'static str> {
        if self.supported() {
            Ok(())
        } else {
            Err(code)
        }
    }

    fn sweep_views(gate: &mut Gate, now: u64) {
        gate.views
            .retain(|_, view| now.saturating_sub(view.created_at) <= VIEW_LIFETIME_MS);
    }

    /// Drop the controller and invalidate its generation so any input still
    /// queued behind the gate is rejected. Every path that revokes a lease
    /// without granting a new one (handback, view stop, expiry, a failed input)
    /// goes through here, so a revocation always advances the epoch — and the
    /// advance is published while the gate is held, so the counter a replacement
    /// reads can never lag the epoch that was issued.
    fn expire_control(&self, gate: &mut Gate) {
        if gate.control.take().is_some() {
            gate.generation = self.next_epoch();
        }
    }

    /// Metadata probe: screen geometry and device identity only.
    fn device(&self) -> Result<DeviceInfo, &'static str> {
        {
            let gate = self.gate()?;
            if let Some(device) = &gate.device {
                return Ok(device.clone());
            }
            if let Some((code, at)) = gate.device_error {
                if self.now().saturating_sub(at) < DEVICE_RETRY_MS {
                    return Err(code);
                }
            }
        }
        // The probe runs without the gate so capture/input are not stalled
        // behind a helper start-up. It returns no pixels.
        let probed = self.provider.info();
        let mut gate = self.gate()?;
        match probed {
            Ok(device) => {
                gate.device = Some(device.clone());
                gate.device_error = None;
                Ok(device)
            }
            Err(failure) => {
                let code = failure.capture_code();
                gate.device_error = Some((code, self.now()));
                Err(code)
            }
        }
    }

    fn capture(&self, max_width: u32, max_height: u32) -> Result<(Frame, u64), &'static str> {
        let permit = self
            .captures
            .clone()
            .try_acquire_owned()
            .map_err(|_| "computer_busy")?;
        let frame = self
            .provider
            .capture(max_width.min(MAX_DIMENSION), max_height.min(MAX_DIMENSION))
            .map_err(|failure| failure.capture_code())?;
        // The authoritative payload boundary. Every provider — local helper, remote
        // node, or a test double — returns through here, and both the browser view and
        // the agent capture tool receive exactly this value. A provider that hands back
        // an empty, forged, oversized or zero-dimension body is a failed capture, never
        // a blank or truncated screen presented as a real one.
        validate_frame_payload(&frame).map_err(|failure| failure.capture_code())?;
        let mut gate = self.gate()?;
        gate.frames = gate.frames.wrapping_add(1);
        let seq = gate.frames;
        drop(gate);
        drop(permit);
        Ok((frame, seq))
    }

    fn throttle(&self, gate: &Gate, now: u64) -> Result<(), &'static str> {
        if gate.last_capture_at != 0
            && now.saturating_sub(gate.last_capture_at) < MIN_FRAME_INTERVAL_MS
        {
            return Err("computer_throttled");
        }
        Ok(())
    }

    pub(crate) fn status(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
    ) -> Result<Value, &'static str> {
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        // Bounded metadata probe: screen geometry and device identity, so the UI
        // can name the exact device before any capture consent exists. It returns
        // no pixels and injects no input.
        let readiness = if self.supported() {
            self.device()
        } else {
            Err("computer_helper_not_configured")
        };
        let gate = self.gate()?;
        // Clock sampled after the gate: no stale timestamp decides a window.
        let now = self.now();
        let view = gate
            .views
            .iter()
            .find(|(_, view)| view.client_id == session.client_id)
            .map(|(id, view)| {
                json!({"viewId": id, "bounds": bounds_json(view.bounds),
                    "expiresAt": view.created_at + VIEW_LIFETIME_MS})
            });
        let control = gate
            .control
            .as_ref()
            .filter(|control| control.client_id == session.client_id)
            .map(|control| {
                json!({"controlId": control.id, "viewId": control.view_id,
                    "generation": control.generation, "expiresAt": control.expires_at,
                    "totalDeadline": control.total_deadline, "seq": control.seq_high})
            });
        Ok(json!({
            // `configured` is the static fact; `ready` reflects an actual probe.
            "configured": self.supported(),
            "ready": readiness.is_ok(),
            // Only a public code, never an internal error chain.
            "reason": readiness.as_ref().err().copied(),
            "device": readiness.as_ref().ok().map(|device| json!({
                "deviceId": device.id, "platform": device.platform,
                "bounds": bounds_json(device.bounds)})),
            "view": view,
            "control": control,
            "serverTime": now,
            "limits": self.report(),
        }))
    }

    pub(crate) fn start_view(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: ViewBody,
    ) -> Result<Value, &'static str> {
        self.supported_or("computer_unsupported")?;
        if !body.consent {
            return Err("computer_consent_required");
        }
        let device = self.device()?;
        let mut gate = self.gate()?;
        // Clock sampled after the gate, so a queued request cannot carry a stale
        // window into this admission decision.
        let now = self.now();
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        if body.device_id != device.id {
            return Err("computer_device_mismatch");
        }
        Self::sweep_views(&mut gate, now);
        // One view per client: replacing it clears the previous capture consent.
        gate.views.retain(|_, view| view.client_id != session.client_id);
        if gate.views.len() >= MAX_VIEWS {
            return Err("computer_view_limit");
        }
        let id = crate::new_token().map_err(|_| "computer_busy")?;
        gate.views.insert(
            id.clone(),
            View {
                client_id: session.client_id.clone(),
                created_at: now,
                bounds: device.bounds,
            },
        );
        Ok(json!({
            "viewId": id,
            "deviceId": device.id,
            "platform": device.platform,
            "bounds": bounds_json(device.bounds),
            "expiresAt": now + VIEW_LIFETIME_MS,
            "serverTime": now,
        }))
    }

    pub(crate) fn preview(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: PreviewBody,
    ) -> Result<(Frame, u64), &'static str> {
        self.supported_or("computer_unsupported")?;
        if !body.consent {
            return Err("computer_consent_required");
        }
        {
            let mut gate = self.gate()?;
            let now = self.now();
            if !sessions.is_live(session) {
                return Err("session_required");
            }
            self.throttle(&gate, now)?;
            // Same reservation rule as `frame_guarded`.
            gate.last_capture_at = now;
        }
        // Read-only preview: capture consent only, never a control lease.
        let captured = self.capture(MAX_DIMENSION, MAX_DIMENSION)?;
        // A capture may take seconds; discard the pixels if the session was
        // revoked while it ran.
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        Ok(captured)
    }

    pub(crate) fn frame(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: FrameBody,
    ) -> Result<(Frame, u64), &'static str> {
        self.frame_guarded(sessions, session, body, &|| Ok(()))
    }

    /// Same capture contract as [`Self::frame`], plus a trusted admission closure
    /// that runs while the physical gate is held — once before the capture and once
    /// after it, immediately before any bytes are returned. `guard` is how a caller
    /// with a *narrower* authorization than the session registry (an agent grant)
    /// revalidates its own state at the exact moment that matters.
    pub(crate) fn frame_guarded(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: FrameBody,
        guard: &dyn Fn() -> Result<(), &'static str>,
    ) -> Result<(Frame, u64), &'static str> {
        self.supported_or("computer_unsupported")?;
        if !body.consent {
            return Err("computer_consent_required");
        }
        {
            let mut gate = self.gate()?;
            let now = self.now();
            if !sessions.is_live(session) {
                return Err("session_required");
            }
            let Some(view) = gate.views.get(&body.view_id) else {
                return Err("computer_view_unknown");
            };
            if view.client_id != session.client_id
                || now.saturating_sub(view.created_at) > VIEW_LIFETIME_MS
            {
                return Err("computer_view_unknown");
            }
            self.throttle(&gate, now)?;
            guard()?;
            // Reserved inside the same gate hold, so two concurrent captures can no
            // longer both pass the interval check and record afterwards.
            gate.last_capture_at = now;
        }
        let captured = self.capture(MAX_DIMENSION, MAX_DIMENSION)?;
        // Recheck after the capture: a revoked session or an expired view
        // discards the pixels instead of handing them out.
        {
            let gate = self.gate()?;
            let now = self.now();
            if !sessions.is_live(session) {
                return Err("session_required");
            }
            match gate.views.get(&body.view_id) {
                Some(view)
                    if view.client_id == session.client_id
                        && now.saturating_sub(view.created_at) <= VIEW_LIFETIME_MS => {}
                _ => return Err("computer_view_unknown"),
            }
            guard()?;
        }
        Ok(captured)
    }

    /// Take control of the physical device: the takeover boundary.
    ///
    /// * Exclusive. A live lease held by any other client is refused with
    ///   `computer_control_held`; a second session never displaces the holder.
    ///   Taking over again while holding is a fresh takeover by the same holder
    ///   and replaces the lease, exactly as the upstream takeover branch does.
    /// * Epoch-bearing. The grant allocates the next epoch, whether the previous
    ///   lease had lapsed, been handed back or never existed. Every input is
    ///   fenced against that value, so an input admitted for an earlier holder
    ///   can never execute after this one.
    /// * Bounded by the five-minute ceiling (`CONTROL_TOTAL_MAX_MS`), which a
    ///   heartbeat or input can refresh the TTL toward but never extend.
    pub(crate) fn acquire(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: ControlBody,
    ) -> Result<Value, &'static str> {
        self.acquire_kind(sessions, session, body, false)
    }

    pub(crate) fn acquire_agent(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: ControlBody,
    ) -> Result<Value, &'static str> {
        self.acquire_kind(sessions, session, body, true)
    }

    fn acquire_kind(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: ControlBody,
        agent_control: bool,
    ) -> Result<Value, &'static str> {
        self.supported_or("computer_unsupported")?;
        if !body.consent {
            return Err("computer_consent_required");
        }
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        let device = self.device()?;
        let mut gate = self.gate()?;
        #[cfg(test)]
        self.park_acquire(AcquirePark::BeforeRetirementCheck);
        // The gate was acquired before any retirement could be observed from the
        // outside; a retirement that happened while this takeover waited for it
        // (`retire` uses `try_lock`, so it never overtakes this caller) must still
        // refuse the takeover rather than issue an epoch for a replaced device.
        if self.is_retired() {
            return Err("computer_unavailable");
        }
        // Clock sampled after the gate, immediately before the admission test.
        let now = self.now();
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        if body.device_id != device.id {
            return Err("computer_device_mismatch");
        }
        Self::sweep_views(&mut gate, now);
        let dead = gate
            .control
            .as_ref()
            .is_some_and(|control| !control_alive(&gate, control, now));
        if dead {
            // Not `expire_control`: the grant below is the one and only epoch
            // advance this transition performs, so a takeover of a lapsed lease
            // moves the epoch by exactly one and the value the client reads is
            // the value that fences it.
            gate.control = None;
        }
        if let Some(control) = &gate.control {
            if control.client_id != session.client_id {
                // A human click preempts an assistant-held lease, but never another
                // human. An assistant never displaces a human holder.
                if control.agent && !agent_control {
                    // Replacing the lease below allocates a fresh epoch.
                } else if !control.agent && agent_control {
                    return Err("computer_human_control");
                } else {
                    return Err("computer_control_held");
                }
            }
        }
        let Some(view) = gate.views.get(&body.view_id) else {
            return Err("computer_view_unknown");
        };
        if view.client_id != session.client_id {
            return Err("computer_view_unknown");
        }
        let requested = u64::from(body.ttl_seconds).saturating_mul(1000);
        let ttl_ms = if requested == 0 {
            CONTROL_TTL_DEFAULT_MS
        } else {
            requested.clamp(1000, CONTROL_TTL_MAX_MS)
        };
        let id = crate::new_token().map_err(|_| "computer_busy")?;
        #[cfg(test)]
        self.park_acquire(AcquirePark::BeforeAllocation);
        let generation = self.next_epoch();
        gate.generation = generation;
        // A retirement that landed between the re-check above and this allocation
        // consumed a number instead of issuing a lease: the shared allocator keeps
        // it from being handed out again, and the caller is refused because this
        // device is already fenced.
        if self.is_retired() {
            return Err("computer_unavailable");
        }
        gate.control = Some(Control {
            id: id.clone(),
            client_id: session.client_id.clone(),
            view_id: body.view_id.clone(),
            generation,
            ttl_ms,
            expires_at: now + ttl_ms,
            total_deadline: now + CONTROL_TOTAL_MAX_MS,
            seq_high: 0,
            last_input_at: now,
            agent: agent_control,
        });
        Ok(json!({
            "controlId": id,
            "viewId": body.view_id,
            "generation": generation,
            "expiresAt": now + ttl_ms,
            "totalDeadline": now + CONTROL_TOTAL_MAX_MS,
            "serverTime": now,
        }))
    }

    pub(crate) fn heartbeat(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: HeartbeatBody,
    ) -> Result<Value, &'static str> {
        self.supported_or("computer_unsupported")?;
        if !body.consent {
            return Err("computer_consent_required");
        }
        let mut gate = self.gate()?;
        // Clock sampled after the gate, never from before the request waited.
        let now = self.now();
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        let current = gate.generation;
        let Some(control) = gate.control.as_ref() else {
            return Err(if body.generation < current {
                "computer_input_stale"
            } else {
                "computer_control_required"
            });
        };
        if control.id != body.control_id
            || control.client_id != session.client_id
            || control.view_id != body.view_id
        {
            return Err("computer_control_required");
        }
        if control.generation != body.generation {
            return Err("computer_input_stale");
        }
        let expired = !control_alive(&gate, control, now);
        if expired {
            self.expire_control(&mut gate);
            // A heartbeat never revives a dead lease; the client must acquire
            // again, which is a new explicit consent and a new generation.
            return Err("computer_lease_expired");
        }
        let Some(control) = gate.control.as_mut() else {
            return Err("computer_lease_expired");
        };
        control.expires_at = (now + control.ttl_ms).min(control.total_deadline);
        control.last_input_at = now;
        Ok(json!({
            "controlId": control.id,
            "generation": control.generation,
            "expiresAt": control.expires_at,
            "totalDeadline": control.total_deadline,
            "seq": control.seq_high,
            "serverTime": now,
        }))
    }

    /// Hand the device back: the handback boundary.
    ///
    /// Only the holder can hand back, and only with the lease identity it was
    /// given. The handback clears the holder and advances the epoch once, so the
    /// barrier it returns from rejects every input that was admitted for the
    /// outgoing holder. Releasing the lease is not the same claim as releasing
    /// the physical device: that second claim is reported only when the device
    /// confirmed it drained (see the body below).
    pub(crate) fn release_control(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: ReleaseBody,
    ) -> Result<Value, &'static str> {
        let mut gate = self.gate()?;
        // Clock sampled after the gate.
        let now = self.now();
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        let Some(control) = gate.control.as_ref() else {
            return Err("computer_control_required");
        };
        if control.id != body.control_id
            || control.client_id != session.client_id
            || control.view_id != body.view_id
        {
            return Err("computer_control_required");
        }
        if control.generation != body.generation {
            return Err("computer_input_stale");
        }
        self.expire_control(&mut gate);
        let generation = gate.generation;
        // Releasing the lease is the barrier this call promises: any input still
        // queued behind the gate now sees a newer generation and is rejected.
        // Physical release is a second, separate claim. It is reported only when
        // the device confirmed it drained; otherwise the answer is
        // `released: false` with an unconfirmed reason, and nothing is replayed.
        if let Err(failure) = self.provider.release() {
            return Ok(json!({"released": false, "confirmed": false,
                "reason": failure.release_code(),
                "generation": generation, "serverTime": now}));
        }
        Ok(json!({"released": true, "confirmed": true,
            "generation": generation, "serverTime": now}))
    }

    pub(crate) fn stop_view(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: StopBody,
    ) -> Result<Value, &'static str> {
        let mut gate = self.gate()?;
        // Clock sampled after the gate.
        let now = self.now();
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        let Some(view) = gate.views.get(&body.view_id) else {
            return Err("computer_view_unknown");
        };
        if view.client_id != session.client_id {
            return Err("computer_view_unknown");
        }
        gate.views.remove(&body.view_id);
        let detached = gate
            .control
            .as_ref()
            .is_some_and(|control| control.view_id == body.view_id);
        if detached {
            self.expire_control(&mut gate);
            // The local generation is fenced either way, so no further input can
            // be admitted. Physical release is a separate claim: it is reported
            // only when the device proved it drained, never assumed.
            if let Err(failure) = self.provider.release() {
                let generation = gate.generation;
                return Ok(json!({"stopped": true, "controlRevoked": true,
                    "confirmed": false, "reason": failure.release_code(),
                    "generation": generation, "serverTime": now}));
            }
        }
        let generation = gate.generation;
        Ok(json!({"stopped": true, "controlRevoked": detached, "confirmed": true,
            "generation": generation, "serverTime": now}))
    }

    /// The single input gate. Held across the live-session check, the lease and
    /// generation fence, the OS input call and the sequence commit, so `release`
    /// and `view/stop` are real barriers against already-queued input.
    pub(crate) fn input(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: InputBody,
    ) -> Result<Value, &'static str> {
        self.input_guarded(sessions, session, body, &|| Ok(()))
    }

    /// The single input gate with a trusted admission closure. `guard` runs while
    /// the gate is held, after every provider-side check and immediately before the
    /// OS call, so a caller cannot admit on a state that has since changed. A refusal
    /// also leaves the sequence unconsumed, because nothing was sent.
    pub(crate) fn input_guarded(
        &self,
        sessions: &Sessions,
        session: &Arc<Session>,
        body: InputBody,
        guard: &dyn Fn() -> Result<(), &'static str>,
    ) -> Result<Value, &'static str> {
        self.supported_or("computer_unsupported")?;
        if !body.consent {
            return Err("computer_consent_required");
        }
        let mut gate = self.gate()?;
        // Sampled after the gate: the lease window that governs this call is the
        // one in force now, not the one in force when the request was queued.
        let now = self.now();
        if !sessions.is_live(session) {
            return Err("session_required");
        }
        Self::sweep_views(&mut gate, now);
        let generation = gate.generation;
        let Some(control) = gate.control.as_ref() else {
            return Err(if body.generation < generation {
                "computer_input_stale"
            } else {
                "computer_control_required"
            });
        };
        if control.generation != body.generation {
            // The epoch is decided before the lease identity: an input admitted for
            // a superseded epoch is stale whoever holds the device now, so a holder
            // that took over after a handback never inherits the old client's
            // queued input as if it were its own missing lease.
            return Err("computer_input_stale");
        }
        if control.client_id != session.client_id || control.id != body.control_id {
            return Err("computer_control_required");
        }
        let expired = !control_alive(&gate, control, now);
        if expired {
            self.expire_control(&mut gate);
            return Err("computer_lease_expired");
        }
        let bounds = match gate.views.get(&body.view_id) {
            Some(view) if view.client_id == session.client_id => view.bounds,
            _ => return Err("computer_view_unknown"),
        };
        let Some(control) = gate.control.as_mut() else {
            return Err("computer_control_required");
        };
        if control.view_id != body.view_id {
            return Err("computer_input_stale");
        }
        if body.seq <= control.seq_high {
            return Err("computer_input_out_of_order");
        }
        let command = body.event.command(bounds)?;
        // Last admission point before the OS call, still under the physical gate.
        guard()?;
        // Consume the sequence BEFORE the OS call. A helper that times out may
        // still have typed something, so this exact seq can never be replayed.
        control.seq_high = body.seq;
        control.last_input_at = now;
        // The OS call runs while the gate is still held, so a concurrent
        // release/stop cannot return before this input has finished.
        if let Err(failure) = self.provider.input(&command) {
            // Unknown side effect: revoke the lease now. Never auto resend.
            self.expire_control(&mut gate);
            return Err(failure.input_code());
        }
        Ok(json!({
            "applied": true,
            "seq": body.seq,
            "generation": body.generation,
            "serverTime": now,
        }))
    }
}

fn bounds_json(bounds: Bounds) -> Value {
    json!({"x": bounds.x, "y": bounds.y, "width": bounds.width, "height": bounds.height})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewBody {
    pub consent: bool,
    pub device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewBody {
    pub consent: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrameBody {
    pub view_id: String,
    pub consent: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlBody {
    pub view_id: String,
    pub device_id: String,
    pub consent: bool,
    #[serde(default)]
    pub ttl_seconds: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HeartbeatBody {
    pub view_id: String,
    pub control_id: String,
    pub generation: u64,
    pub consent: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReleaseBody {
    pub view_id: String,
    pub control_id: String,
    pub generation: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StopBody {
    pub view_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputBody {
    pub view_id: String,
    pub control_id: String,
    pub generation: u64,
    pub seq: u64,
    pub consent: bool,
    pub event: EventBody,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EventBody {
    pub kind: EventKind,
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub button: Option<WireButton>,
    #[serde(default)]
    pub action: Option<WireAction>,
    #[serde(default)]
    pub delta: Option<i32>,
    #[serde(default)]
    pub key: Option<WireKey>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum EventKind {
    Pointer,
    Wheel,
    Key,
    Text,
}

#[derive(Clone, Copy, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WireButton {
    Left,
    Right,
    Middle,
}

impl From<WireButton> for PointerButton {
    fn from(button: WireButton) -> Self {
        match button {
            WireButton::Left => Self::Left,
            WireButton::Right => Self::Right,
            WireButton::Middle => Self::Middle,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WireAction {
    Click,
    Move,
}

impl From<WireAction> for PointerAction {
    fn from(action: WireAction) -> Self {
        match action {
            WireAction::Click => Self::Click,
            WireAction::Move => Self::Move,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WireKey {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    Pageup,
    Pagedown,
    Shift,
    Ctrl,
    Alt,
    Meta,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
}

impl From<WireKey> for KeyName {
    fn from(key: WireKey) -> Self {
        match key {
            WireKey::Enter => Self::Enter,
            WireKey::Tab => Self::Tab,
            WireKey::Escape => Self::Escape,
            WireKey::Backspace => Self::Backspace,
            WireKey::Delete => Self::Delete,
            WireKey::Space => Self::Space,
            WireKey::Left => Self::Left,
            WireKey::Right => Self::Right,
            WireKey::Up => Self::Up,
            WireKey::Down => Self::Down,
            WireKey::Home => Self::Home,
            WireKey::End => Self::End,
            WireKey::Pageup => Self::PageUp,
            WireKey::Pagedown => Self::PageDown,
            WireKey::Shift => Self::Shift,
            WireKey::Ctrl => Self::Ctrl,
            WireKey::Alt => Self::Alt,
            WireKey::Meta => Self::Meta,
            WireKey::F1 => Self::F1,
            WireKey::F2 => Self::F2,
            WireKey::F3 => Self::F3,
            WireKey::F4 => Self::F4,
            WireKey::F5 => Self::F5,
            WireKey::F6 => Self::F6,
            WireKey::F7 => Self::F7,
            WireKey::F8 => Self::F8,
            WireKey::F9 => Self::F9,
            WireKey::F10 => Self::F10,
            WireKey::F11 => Self::F11,
            WireKey::F12 => Self::F12,
        }
    }
}

impl EventBody {
    /// Closed whitelist: one shape per kind, no field from another kind, one
    /// bounded event per request.
    fn command(&self, bounds: Bounds) -> Result<InputCommand, &'static str> {
        const INVALID: &'static str = "computer_input_invalid";
        match self.kind {
            EventKind::Pointer => {
                if self.delta.is_some() || self.key.is_some() || self.text.is_some() {
                    return Err(INVALID);
                }
                let (x, y) = (self.x.ok_or(INVALID)?, self.y.ok_or(INVALID)?);
                if !bounds.contains(x, y) {
                    return Err(INVALID);
                }
                let action: PointerAction = self.action.ok_or(INVALID)?.into();
                let button = match (action, self.button) {
                    (PointerAction::Move, None) => None,
                    (PointerAction::Move, Some(_)) => return Err(INVALID),
                    (_, Some(button)) => Some(PointerButton::from(button)),
                    (_, None) => return Err(INVALID),
                };
                Ok(InputCommand::Pointer {
                    x,
                    y,
                    button,
                    action,
                })
            }
            EventKind::Wheel => {
                if self.button.is_some()
                    || self.action.is_some()
                    || self.key.is_some()
                    || self.text.is_some()
                {
                    return Err(INVALID);
                }
                let (x, y) = (self.x.ok_or(INVALID)?, self.y.ok_or(INVALID)?);
                if !bounds.contains(x, y) {
                    return Err(INVALID);
                }
                let delta = self.delta.ok_or(INVALID)?;
                if delta == 0 || delta.unsigned_abs() > 1000 {
                    return Err(INVALID);
                }
                Ok(InputCommand::Wheel { x, y, delta })
            }
            EventKind::Key => {
                if self.x.is_some()
                    || self.y.is_some()
                    || self.button.is_some()
                    || self.action.is_some()
                    || self.delta.is_some()
                    || self.text.is_some()
                {
                    return Err(INVALID);
                }
                Ok(InputCommand::Key {
                    key: self.key.ok_or(INVALID)?.into(),
                })
            }
            EventKind::Text => {
                if self.x.is_some()
                    || self.y.is_some()
                    || self.button.is_some()
                    || self.action.is_some()
                    || self.delta.is_some()
                    || self.key.is_some()
                {
                    return Err(INVALID);
                }
                let text = self.text.clone().ok_or(INVALID)?;
                validate_text(&text)?;
                Ok(InputCommand::Text { text })
            }
        }
    }
}

/// Typed text stays inside a bound the Host can reason about: at most
/// [`MAX_TEXT_CODEPOINTS`] codepoints, no control characters, no lone surrogate
/// (impossible in Rust but rejected defensively at the JSON boundary) and no
/// character outside the basic plane, because the Windows unicode key path would
/// have to synthesise surrogates for those.
fn validate_text(text: &str) -> Result<(), &'static str> {
    if text.is_empty() {
        return Err("computer_input_invalid");
    }
    let mut count = 0;
    for character in text.chars() {
        count += 1;
        if count > MAX_TEXT_CODEPOINTS
            || character.is_control()
            || character == '\u{fffd}'
            || u32::from(character) > 0xffff
        {
            return Err("computer_input_invalid");
        }
    }
    Ok(())
}

fn insert_header(headers: &mut HeaderMap, name: &'static str, value: String) {
    if let Ok(value) = HeaderValue::from_str(&value) {
        headers.insert(HeaderName::from_static(name), value);
    }
}

fn frame_response(frame: Frame, seq: u64, view_id: Option<&str>) -> Response {
    let length = frame.png.len();
    let mut response =
        ([(header::CONTENT_TYPE, "image/png")], Body::from(frame.png)).into_response();
    let headers = response.headers_mut();
    // The boundary layer already forces `no-store`; repeat it here so a direct
    // router test cannot observe a cacheable screenshot, and never add CORS.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    insert_header(
        headers,
        "x-loom-computer-bounds",
        format!(
            "{},{},{},{}",
            frame.bounds.x, frame.bounds.y, frame.bounds.width, frame.bounds.height
        ),
    );
    insert_header(headers, "x-loom-computer-width", frame.width.to_string());
    insert_header(headers, "x-loom-computer-height", frame.height.to_string());
    insert_header(
        headers,
        "x-loom-computer-scale",
        format!("{:.4}", frame.scale),
    );
    insert_header(headers, "x-loom-computer-frame-seq", seq.to_string());
    insert_header(
        headers,
        "x-loom-computer-captured-at",
        frame.captured_at.to_string(),
    );
    insert_header(headers, "x-loom-computer-bytes", length.to_string());
    if let Some(view_id) = view_id {
        insert_header(headers, "x-loom-computer-view", view_id.to_owned());
    }
    response
}

pub(crate) async fn blocking<T, F>(computer: &Computer, work: F) -> Result<T, &'static str>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, &'static str> + Send + 'static,
{
    // Refuse instead of queueing into the blocking pool; the permit is released when the
    // section ends, including after a timeout.
    let permit = computer.try_job()?;
    match tokio::time::timeout(
        BLOCKING_DEADLINE,
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        }),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("computer_busy"),
        Err(_) => Err("computer_helper_timeout"),
    }
}

fn json_or_bad<T>(body: Result<Json<T>, axum::extract::rejection::JsonRejection>) -> Result<T, Response> {
    body.map(|Json(value)| value)
        .map_err(|_| reject("computer_invalid_request"))
}

macro_rules! body {
    ($body:expr) => {
        match json_or_bad($body) {
            Ok(body) => body,
            Err(response) => return response,
        }
    };
}

pub(crate) async fn status(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
) -> Response {
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.status(&sessions, &session)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn preview(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<PreviewBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.preview(&sessions, &session, body)).await {
        Ok((frame, seq)) => frame_response(frame, seq, None),
        Err(code) => reject(code),
    }
}

pub(crate) async fn view(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<ViewBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.start_view(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn frame(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<FrameBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let view_id = body.view_id.clone();
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.frame(&sessions, &session, body)).await {
        Ok((frame, seq)) => frame_response(frame, seq, Some(&view_id)),
        Err(code) => reject(code),
    }
}

pub(crate) async fn control(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<ControlBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.acquire(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn heartbeat(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<HeartbeatBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.heartbeat(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn release(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<ReleaseBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.release_control(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn stop(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<StopBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.stop_view(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn input(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    body: Result<Json<InputBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let (computer, sessions) = (state.computer.clone(), state.sessions.clone());
    match blocking(&state.computer, move || computer.input(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

/// Resolve the device a request targets. A caller supplies only a node id; the
/// Host resolves it to a paired, online node that advertised the computer
/// transport on its *current* connection generation. No URL, host or port is
/// ever taken from a request, and a stale generation is discarded instead of
/// reused.
async fn node_computer(state: &WebState, node_id: &str) -> Result<Arc<Computer>, &'static str> {
    if node_id.is_empty() || node_id.len() > 80 {
        return Err("node_not_found");
    }
    state.node_computers.for_node(&state.nodes, node_id).await
}

/// Per-node port of `status`. Metadata only: it probes the device and never
/// captures, so a node selector can name a screen without consent.
pub(crate) async fn node_status(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
) -> Response {
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.status(&sessions, &session)).await {
        Ok(mut value) => {
            value["nodeId"] = json!(node_id);
            value["target"] = json!("node");
            Json(value).into_response()
        }
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_preview(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<PreviewBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.preview(&sessions, &session, body)).await {
        Ok((frame, seq)) => frame_response(frame, seq, None),
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_view(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<ViewBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.start_view(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_frame(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<FrameBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let view_id = body.view_id.clone();
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.frame(&sessions, &session, body)).await {
        Ok((frame, seq)) => frame_response(frame, seq, Some(&view_id)),
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_control(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<ControlBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.acquire(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_heartbeat(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<HeartbeatBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.heartbeat(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_release(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<ReleaseBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.release_control(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_stop(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<StopBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.stop_view(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

pub(crate) async fn node_input(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
    body: Result<Json<InputBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let body = body!(body);
    let computer = match node_computer(&state, &node_id).await {
        Ok(computer) => computer,
        Err(code) => return reject(code),
    };
    let job = Arc::clone(&computer);
    let sessions = state.sessions.clone();
    match blocking(&job, move || computer.input(&sessions, &session, body)).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => reject(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    };

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend(std::iter::repeat_n(0x5a, 64));
        bytes
    }

    struct Mock {
        device: DeviceInfo,
        frame: Mutex<Vec<u8>>,
        failure: Mutex<Option<Failure>>,
        capture_failure: Mutex<Option<Failure>>,
        input_failure: Mutex<Option<Failure>>,
        release_failure: Mutex<Option<Failure>>,
        inputs: Mutex<Vec<InputCommand>>,
        infos: AtomicU64,
        captures: AtomicU64,
        releases: AtomicU64,
        gate_entered: Option<Mutex<mpsc::Sender<()>>>,
        gate_proceed: Option<Mutex<mpsc::Receiver<()>>>,
    }

    impl Mock {
        fn new() -> Self {
            Self {
                device: DeviceInfo {
                    id: "sha256:test-device".to_owned(),
                    platform: "windows-gdi".to_owned(),
                    bounds: Bounds {
                        x: -1920,
                        y: 0,
                        width: 3840,
                        height: 1080,
                    },
                },
                frame: Mutex::new(png(1920, 1080)),
                failure: Mutex::new(None),
                capture_failure: Mutex::new(None),
                input_failure: Mutex::new(None),
                release_failure: Mutex::new(None),
                inputs: Mutex::new(Vec::new()),
                infos: AtomicU64::new(0),
                captures: AtomicU64::new(0),
                releases: AtomicU64::new(0),
                gate_entered: None,
                gate_proceed: None,
            }
        }

        fn blocking_input() -> (Self, mpsc::Receiver<()>, mpsc::Sender<()>) {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (proceed_tx, proceed_rx) = mpsc::channel();
            let mut mock = Self::new();
            mock.gate_entered = Some(Mutex::new(entered_tx));
            mock.gate_proceed = Some(Mutex::new(proceed_rx));
            (mock, entered_rx, proceed_tx)
        }
    }

    impl Provider for Mock {
        fn info(&self) -> Result<DeviceInfo, Failure> {
            self.infos.fetch_add(1, Ordering::SeqCst);
            self.failure
                .lock()
                .unwrap()
                .clone()
                .map_or_else(|| Ok(self.device.clone()), Err)
        }
        fn capture(&self, _max_width: u32, _max_height: u32) -> Result<Frame, Failure> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            if let Some(failure) = self.capture_failure.lock().unwrap().clone() {
                return Err(failure);
            }
            Ok(Frame {
                png: self.frame.lock().unwrap().clone(),
                width: 1920,
                height: 1080,
                bounds: self.device.bounds,
                scale: 0.5,
                captured_at: 7,
            })
        }
        fn input(&self, command: &InputCommand) -> Result<(), Failure> {
            if let Some(failure) = self.input_failure.lock().unwrap().clone() {
                return Err(failure);
            }
            if let Some(sender) = &self.gate_entered {
                // mpsc::Sender is Send but not Sync, so it is guarded here.
                let _ = sender.lock().unwrap().send(());
            }
            if let Some(receiver) = &self.gate_proceed {
                let _ = receiver.lock().unwrap().recv();
            }
            self.inputs.lock().unwrap().push(command.clone());
            Ok(())
        }
        fn release(&self) -> Result<(), Failure> {
            self.releases.fetch_add(1, Ordering::SeqCst);
            // A device that cannot prove it drained reports exactly that; the
            // mock never invents a confirmation it was not told to give.
            self.release_failure
                .lock()
                .unwrap()
                .clone()
                .map_or(Ok(()), Err)
        }
    }

    struct Fixture {
        computer: Arc<Computer>,
        sessions: Arc<Sessions>,
        session: Arc<Session>,
        mock: Arc<Mock>,
        now: Arc<AtomicU64>,
        token: String,
    }

    fn fixture_with(mock: Arc<Mock>) -> Fixture {
        let token = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&token).unwrap());
        let (_, session) = sessions
            .login(&token)
            .ok()
            .expect("browser session must be issued");
        let now = Arc::new(AtomicU64::new(1_800_000_000_000));
        let computer = Arc::new(Computer::with_parts(mock.clone(), {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        }));
        Fixture {
            computer,
            sessions,
            session,
            mock,
            now,
            token,
        }
    }

    fn fixture() -> Fixture {
        fixture_with(Arc::new(Mock::new()))
    }

    impl Fixture {
        fn tick(&self, milliseconds: u64) {
            self.now.fetch_add(milliseconds, Ordering::SeqCst);
        }
        fn view(&self) -> String {
            self.view_as(&self.session)
        }
        fn view_as(&self, session: &Arc<Session>) -> String {
            self.computer
                .start_view(
                    &self.sessions,
                    session,
                    ViewBody {
                        consent: true,
                        device_id: self.mock.device.id.clone(),
                    },
                )
                .unwrap()["viewId"]
                .as_str()
                .unwrap()
                .to_owned()
        }
        fn control(&self, view: &str) -> (String, u64) {
            let value = self.acquire_as(&self.session, view, 30).unwrap();
            (
                value["controlId"].as_str().unwrap().to_owned(),
                value["generation"].as_u64().unwrap(),
            )
        }
        /// One takeover attempt by a named session, so exclusivity and the epoch
        /// are observable without a second fixture.
        fn acquire_as(
            &self,
            session: &Arc<Session>,
            view: &str,
            ttl_seconds: u32,
        ) -> Result<Value, &'static str> {
            self.computer.acquire(
                &self.sessions,
                session,
                ControlBody {
                    view_id: view.to_owned(),
                    device_id: self.mock.device.id.clone(),
                    consent: true,
                    ttl_seconds,
                },
            )
        }
        fn handback(&self, session: &Arc<Session>, view: &str, control: &str, epoch: u64) -> Result<Value, &'static str> {
            self.computer.release_control(
                &self.sessions,
                session,
                ReleaseBody {
                    view_id: view.to_owned(),
                    control_id: control.to_owned(),
                    generation: epoch,
                },
            )
        }
        fn second_session(&self) -> Arc<Session> {
            self.sessions
                .login(&self.token)
                .ok()
                .expect("second browser session must be issued")
                .1
        }
        fn click(&self, view: &str, control: &str, generation: u64, seq: u64) -> InputBody {
            InputBody {
                view_id: view.to_owned(),
                control_id: control.to_owned(),
                generation,
                seq,
                consent: true,
                event: EventBody {
                    kind: EventKind::Pointer,
                    x: Some(-100),
                    y: Some(10),
                    button: Some(WireButton::Left),
                    action: Some(WireAction::Click),
                    delta: None,
                    key: None,
                    text: None,
                },
            }
        }
    }

    fn event(kind: EventKind) -> EventBody {
        EventBody {
            kind,
            x: None,
            y: None,
            button: None,
            action: None,
            delta: None,
            key: None,
            text: None,
        }
    }

    #[test]
    fn human_takeover_preempts_agent_and_handback_restores_agent_control() {
        let fixture = fixture();
        let human_view = fixture.view();
        let agent_session = fixture.second_session();
        let agent_view = fixture.view_as(&agent_session);
        let body_for = |view: &str| ControlBody {
            view_id: view.to_owned(),
            device_id: fixture.mock.device.id.clone(),
            consent: true,
            ttl_seconds: 30,
        };
        let agent = fixture
            .computer
            .acquire_agent(&fixture.sessions, &agent_session, body_for(&agent_view))
            .unwrap();
        let agent_epoch = agent["generation"].as_u64().unwrap();
        let human = fixture
            .acquire_as(&fixture.session, &human_view, 30)
            .unwrap();
        assert!(human["generation"].as_u64().unwrap() > agent_epoch);
        assert_eq!(
            fixture.computer.acquire_agent(
                &fixture.sessions,
                &agent_session,
                body_for(&agent_view),
            ),
            Err("computer_human_control")
        );
        fixture
            .handback(
                &fixture.session,
                &human_view,
                human["controlId"].as_str().unwrap(),
                human["generation"].as_u64().unwrap(),
            )
            .unwrap();
        assert!(fixture
            .computer
            .acquire_agent(&fixture.sessions, &agent_session, body_for(&agent_view))
            .is_ok());
    }

    #[test]
    fn view_consent_control_and_generation_are_the_only_input_admission() {
        let fixture = fixture();
        let bounds = fixture.mock.device.bounds;
        assert!(bounds.contains(-1920, 0) && bounds.contains(1919, 1079));
        assert!(!bounds.contains(-1921, 0) && !bounds.contains(1920, 0));
        // Nothing is captured or controlled without explicit consent.
        assert_eq!(
            fixture
                .computer
                .start_view(
                    &fixture.sessions,
                    &fixture.session,
                    ViewBody {
                        consent: false,
                        device_id: fixture.mock.device.id.clone()
                    }
                )
                .unwrap_err(),
            "computer_consent_required"
        );
        assert_eq!(
            fixture
                .computer
                .preview(
                    &fixture.sessions,
                    &fixture.session,
                    PreviewBody { consent: false }
                )
                .unwrap_err(),
            "computer_consent_required"
        );
        assert_eq!(fixture.mock.captures.load(Ordering::SeqCst), 0);
        let view = fixture.view();
        // The device is the Host's, never the caller's choice.
        assert_eq!(
            fixture
                .computer
                .acquire(
                    &fixture.sessions,
                    &fixture.session,
                    ControlBody {
                        view_id: view.clone(),
                        device_id: "sha256:someone-else".to_owned(),
                        consent: true,
                        ttl_seconds: 30
                    }
                )
                .unwrap_err(),
            "computer_device_mismatch"
        );
        let (control, generation) = fixture.control(&view);
        // A second session never displaces the holder of the physical device.
        let (_, other) = fixture
            .sessions
            .login(&fixture.token)
            .ok()
            .expect("second browser session must be issued");
        let other_view = fixture
            .computer
            .start_view(
                &fixture.sessions,
                &other,
                ViewBody {
                    consent: true,
                    device_id: fixture.mock.device.id.clone(),
                },
            )
            .unwrap()["viewId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            fixture
                .computer
                .acquire(
                    &fixture.sessions,
                    &other,
                    ControlBody {
                        view_id: other_view.clone(),
                        device_id: fixture.mock.device.id.clone(),
                        consent: true,
                        ttl_seconds: 30
                    }
                )
                .unwrap_err(),
            "computer_control_held"
        );
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &other, fixture.click(&other_view, &control, generation, 1))
                .unwrap_err(),
            "computer_control_required"
        );
        // Accepted once, then replayed sequences and old generations are refused.
        assert!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 1))
                .is_ok()
        );
        assert_eq!(fixture.mock.inputs.lock().unwrap().len(), 1);
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 1))
                .unwrap_err(),
            "computer_input_out_of_order"
        );
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation + 9, 2))
                .unwrap_err(),
            "computer_input_stale"
        );
        // Release is a barrier for the old generation.
        fixture
            .computer
            .release_control(
                &fixture.sessions,
                &fixture.session,
                ReleaseBody {
                    view_id: view.clone(),
                    control_id: control.clone(),
                    generation,
                },
            )
            .unwrap();
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 2))
                .unwrap_err(),
            "computer_input_stale"
        );
        assert_eq!(fixture.mock.inputs.lock().unwrap().len(), 1);
        // Stopping the view kills capture consent and any attached lease.
        let (control, generation) = fixture.control(&view);
        fixture
            .computer
            .stop_view(
                &fixture.sessions,
                &fixture.session,
                StopBody {
                    view_id: view.clone(),
                },
            )
            .unwrap();
        assert_eq!(
            fixture
                .computer
                .frame(
                    &fixture.sessions,
                    &fixture.session,
                    FrameBody {
                        view_id: view.clone(),
                        consent: true
                    }
                )
                .unwrap_err(),
            "computer_view_unknown"
        );
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 3))
                .unwrap_err(),
            // Stopping the view revoked the lease first, so the stale generation
            // is reported before the missing view.
            "computer_input_stale"
        );
    }

    #[test]
    fn lease_ttl_deadman_and_view_expiry_fence_input_without_process_help() {
        let fixture = fixture();
        let view = fixture.view();
        let (control, generation) = fixture.control(&view);
        // A controller that goes silent loses control at the idle deadman.
        fixture.tick(INPUT_IDLE_DEADMAN_MS + 1);
        assert_eq!(
            fixture
                .computer
                .heartbeat(
                    &fixture.sessions,
                    &fixture.session,
                    HeartbeatBody {
                        view_id: view.clone(),
                        control_id: control.clone(),
                        generation,
                        consent: true
                    }
                )
                .unwrap_err(),
            // Never reacquired by a heartbeat; only a fresh acquire works.
            "computer_lease_expired"
        );
        // Once the lease was dropped, the old generation is fenced off.
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 1))
                .unwrap_err(),
            "computer_input_stale"
        );
        // Watching alone stays allowed: capture consent is separate.
        assert!(
            fixture
                .computer
                .frame(
                    &fixture.sessions,
                    &fixture.session,
                    FrameBody {
                        view_id: view.clone(),
                        consent: true
                    }
                )
                .is_ok()
        );
        // The absolute ceiling survives TTL refreshes.
        let view = fixture.view();
        let (control, generation) = fixture.control(&view);
        for _ in 0..18 {
            fixture.tick(INPUT_IDLE_DEADMAN_MS - 1_000);
            let value = fixture
                .computer
                .heartbeat(
                    &fixture.sessions,
                    &fixture.session,
                    HeartbeatBody {
                        view_id: view.clone(),
                        control_id: control.clone(),
                        generation,
                        consent: true,
                    },
                )
                .unwrap();
            assert!(
                value["expiresAt"].as_u64().unwrap() <= value["totalDeadline"].as_u64().unwrap()
            );
        }
        // Past the absolute ceiling a recent TTL refresh still cannot extend it.
        fixture.tick(CONTROL_TOTAL_MAX_MS);
        assert_eq!(
            fixture
                .computer
                .heartbeat(
                    &fixture.sessions,
                    &fixture.session,
                    HeartbeatBody {
                        view_id: view.clone(),
                        control_id: control.clone(),
                        generation,
                        consent: true
                    }
                )
                .unwrap_err(),
            "computer_lease_expired"
        );
        // A heartbeat is also consent-bearing.
        let view = fixture.view();
        let (control, generation) = fixture.control(&view);
        assert_eq!(
            fixture
                .computer
                .heartbeat(
                    &fixture.sessions,
                    &fixture.session,
                    HeartbeatBody {
                        view_id: view.clone(),
                        control_id: control,
                        generation,
                        consent: false
                    }
                )
                .unwrap_err(),
            "computer_consent_required"
        );
        // The view itself expires and takes its consent with it.
        fixture.tick(VIEW_LIFETIME_MS + 1);
        assert_eq!(
            fixture
                .computer
                .frame(
                    &fixture.sessions,
                    &fixture.session,
                    FrameBody {
                        view_id: view,
                        consent: true
                    }
                )
                .unwrap_err(),
            "computer_view_unknown"
        );
    }

    #[test]
    fn a_takeover_is_exclusive_and_advances_the_epoch_exactly_once() {
        let fixture = fixture();
        let view = fixture.view();
        // A takeover of a free device is the first transition: epoch 1.
        let (holder, epoch) = fixture.control(&view);
        assert_eq!(epoch, 1, "a takeover of a free device advances the epoch once");
        let other = fixture.second_session();
        let other_view = fixture.view_as(&other);
        // Exclusivity: a live lease is never displaced, and the loser gains
        // nothing by holding a view of the same physical device.
        assert_eq!(
            fixture.acquire_as(&other, &other_view, 30).unwrap_err(),
            "computer_control_held"
        );
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &other, fixture.click(&other_view, &holder, epoch, 1))
                .unwrap_err(),
            "computer_control_required"
        );
        // A heartbeat is the renewal that does *not* open a new epoch: the lease
        // and its generation are kept.
        let renewed = fixture
            .computer
            .heartbeat(
                &fixture.sessions,
                &fixture.session,
                HeartbeatBody {
                    view_id: view.clone(),
                    control_id: holder.clone(),
                    generation: epoch,
                    consent: true,
                },
            )
            .unwrap();
        assert_eq!(renewed["generation"].as_u64().unwrap(), epoch);
        assert_eq!(renewed["controlId"].as_str().unwrap(), holder);
        // The lease lapses at the idle deadman. The takeover that follows is one
        // transition, so it advances the epoch by exactly one, not two.
        fixture.tick(INPUT_IDLE_DEADMAN_MS + 1);
        let taken = fixture.acquire_as(&other, &other_view, 30).unwrap();
        let next_epoch = taken["generation"].as_u64().unwrap();
        assert_eq!(
            next_epoch,
            epoch + 1,
            "a takeover of a lapsed lease advances the epoch exactly once"
        );
        let next_holder = taken["controlId"].as_str().unwrap().to_owned();
        // The lapsed holder can no longer execute, and cannot hand back a lease
        // it no longer holds.
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &holder, epoch, 2))
                .unwrap_err(),
            "computer_input_stale"
        );
        assert_eq!(
            fixture.handback(&fixture.session, &view, &holder, epoch).unwrap_err(),
            "computer_control_required"
        );
        assert_eq!(fixture.mock.inputs.lock().unwrap().len(), 0);
        // Handback advances the epoch once and fences the outgoing holder.
        let handed = fixture
            .handback(&other, &other_view, &next_holder, next_epoch)
            .unwrap();
        assert_eq!(handed["released"], json!(true));
        let after_handback = handed["generation"].as_u64().unwrap();
        assert_eq!(after_handback, next_epoch + 1);
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &other, fixture.click(&other_view, &next_holder, next_epoch, 1))
                .unwrap_err(),
            "computer_input_stale"
        );
        // Only after the handback may the original session take the device again,
        // and that takeover continues the same epoch sequence.
        let retaken = fixture.acquire_as(&fixture.session, &view, 600).unwrap();
        assert_eq!(retaken["generation"].as_u64().unwrap(), after_handback + 1);
        // The takeover lease is bounded by the five-minute ceiling: a longer
        // request is clamped per call and the total deadline never moves.
        let server_time = retaken["serverTime"].as_u64().unwrap();
        assert_eq!(
            retaken["expiresAt"].as_u64().unwrap() - server_time,
            CONTROL_TTL_MAX_MS
        );
        assert_eq!(
            retaken["totalDeadline"].as_u64().unwrap() - server_time,
            CONTROL_TOTAL_MAX_MS
        );
        assert_eq!(CONTROL_TOTAL_MAX_MS, 5 * 60_000);
        // Even repeated heartbeats cannot pass the ceiling that lease promises:
        // each is clamped per call and, near the deadline, clamped to it.
        let mut value = retaken.clone();
        for _ in 0..21 {
            fixture.tick(INPUT_IDLE_DEADMAN_MS - 1_000);
            value = fixture
                .computer
                .heartbeat(
                    &fixture.sessions,
                    &fixture.session,
                    HeartbeatBody {
                        view_id: view.clone(),
                        control_id: retaken["controlId"].as_str().unwrap().to_owned(),
                        generation: retaken["generation"].as_u64().unwrap(),
                        consent: true,
                    },
                )
                .unwrap();
            assert!(
                value["expiresAt"].as_u64().unwrap() <= value["totalDeadline"].as_u64().unwrap()
            );
            // The five-minute deadline is a property of the takeover and never
            // moves with a refresh.
            assert_eq!(
                value["totalDeadline"].as_u64().unwrap(),
                retaken["totalDeadline"].as_u64().unwrap()
            );
        }
        assert_eq!(
            value["expiresAt"].as_u64().unwrap(),
            value["totalDeadline"].as_u64().unwrap()
        );
    }

    #[test]
    fn a_release_the_device_does_not_confirm_is_never_reported_as_a_release() {
        let fixture = fixture();
        let view = fixture.view();
        let (control, epoch) = fixture.control(&view);
        *fixture.mock.release_failure.lock().unwrap() = Some(Failure::Unconfirmed);
        let value = fixture
            .handback(&fixture.session, &view, &control, epoch)
            .unwrap();
        // The two claims stay separate: the lease is gone, the physical release
        // is not claimed.
        assert_eq!(value["released"], json!(false));
        assert_eq!(value["confirmed"], json!(false));
        assert_eq!(value["reason"], json!("computer_release_unconfirmed"));
        assert_eq!(fixture.mock.releases.load(Ordering::SeqCst), 1);
        // The fence is still the barrier: the handback consumed the epoch, so the
        // outgoing holder cannot execute anything while the device's real state
        // is unknown.
        assert_eq!(value["generation"].as_u64().unwrap(), epoch + 1);
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, epoch, 1))
                .unwrap_err(),
            "computer_input_stale"
        );
        assert_eq!(fixture.mock.inputs.lock().unwrap().len(), 0);
        // A takeover may follow, but it is a new epoch and never a retroactive
        // confirmation of the release that was not observed.
        let taken = fixture.acquire_as(&fixture.session, &view, 30).unwrap();
        assert_eq!(taken["generation"].as_u64().unwrap(), epoch + 2);
        // Stopping the view reports the same unconfirmed release instead of
        // folding it into a clean stop.
        let (control, epoch) = (
            taken["controlId"].as_str().unwrap().to_owned(),
            taken["generation"].as_u64().unwrap(),
        );
        let stopped = fixture
            .computer
            .stop_view(
                &fixture.sessions,
                &fixture.session,
                StopBody {
                    view_id: view.clone(),
                },
            )
            .unwrap();
        assert_eq!(stopped["controlRevoked"], json!(true));
        assert_eq!(stopped["confirmed"], json!(false));
        assert_eq!(stopped["reason"], json!("computer_release_unconfirmed"));
        assert_eq!(stopped["generation"].as_u64().unwrap(), epoch + 1);
        assert_eq!(fixture.mock.releases.load(Ordering::SeqCst), 2);
        assert_ne!(control, String::new());
        // A device that is simply unavailable says so: the reason is its own code.
        *fixture.mock.release_failure.lock().unwrap() = Some(Failure::Unavailable);
        let view = fixture.view();
        let (control, epoch) = fixture.control(&view);
        let value = fixture
            .handback(&fixture.session, &view, &control, epoch)
            .unwrap();
        assert_eq!(value["released"], json!(false));
        assert_eq!(value["confirmed"], json!(false));
        assert_eq!(value["reason"], json!("computer_unsupported"));
    }

    #[test]
    fn capture_failures_and_limits_never_produce_a_frame() {
        let fixture = fixture();
        let view = fixture.view();
        for (failure, code) in [
            (Failure::EncoderUnavailable, "computer_encoder_unavailable"),
            (Failure::BackendUnavailable, "computer_backend_unavailable"),
            (Failure::SessionLocked, "computer_session_locked"),
            (Failure::Timeout, "computer_helper_timeout"),
            (Failure::Failed, "computer_capture_failed"),
            (Failure::Invalid, "computer_capture_invalid"),
        ] {
            *fixture.mock.capture_failure.lock().unwrap() = Some(failure);
            let error = fixture
                .computer
                .frame(
                    &fixture.sessions,
                    &fixture.session,
                    FrameBody {
                        view_id: view.clone(),
                        consent: true,
                    },
                )
                .unwrap_err();
            assert_eq!(error, code);
            fixture.tick(MIN_FRAME_INTERVAL_MS);
        }
        *fixture.mock.capture_failure.lock().unwrap() = None;
        // A malformed or oversized backend reply is an error, not a blank frame.
        for broken in [
            Vec::new(),
            vec![0u8; 32],
            vec![0x5au8; MAX_FRAME_BYTES + 1],
            // Truncated signature: below the PNG signature floor.
            vec![0x89, b'P', b'N', b'G'],
            // Long enough, but the signature itself is forged.
            {
                let mut forged = png(1920, 1080);
                forged[0] = 0x88;
                forged
            },
            // Exactly at the byte ceiling and still not a PNG.
            vec![0x5au8; MAX_FRAME_BYTES],
        ] {
            *fixture.mock.frame.lock().unwrap() = broken;
            fixture.tick(MIN_FRAME_INTERVAL_MS);
            assert_eq!(
                fixture
                    .computer
                    .frame(
                        &fixture.sessions,
                        &fixture.session,
                        FrameBody {
                            view_id: view.clone(),
                            consent: true,
                        },
                    )
                    .unwrap_err(),
                "computer_capture_invalid"
            );
        }
        // The same contract owns the dimension and geometry limits. The mock provider
        // always reports 1920x1080, so those cases exercise the boundary predicate
        // directly instead of growing a second provider fixture.
        let payload = |width: u32, height: u32, bounds: Bounds| Frame {
            png: png(1920, 1080),
            width,
            height,
            bounds,
            scale: 0.5,
            captured_at: 7,
        };
        let screen = fixture.mock.device.bounds;
        assert!(validate_frame_payload(&payload(1920, 1080, screen)).is_ok());
        for (width, height) in [
            (0, 1080),
            (1920, 0),
            (MAX_DIMENSION + 1, 1080),
            (1920, MAX_DIMENSION + 1),
        ] {
            assert_eq!(
                validate_frame_payload(&payload(width, height, screen))
                    .unwrap_err()
                    .capture_code(),
                "computer_capture_invalid"
            );
        }
        for bounds in [
            Bounds {
                x: 0,
                y: 0,
                width: 0,
                height: 1080,
            },
            Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 0,
            },
        ] {
            assert_eq!(
                validate_frame_payload(&payload(1920, 1080, bounds))
                    .unwrap_err()
                    .capture_code(),
                "computer_capture_invalid"
            );
        }
        // A well formed reply is the only thing that produces a frame.
        *fixture.mock.frame.lock().unwrap() = png(1920, 1080);
        fixture.tick(MIN_FRAME_INTERVAL_MS);
        assert!(
            fixture
                .computer
                .frame(
                    &fixture.sessions,
                    &fixture.session,
                    FrameBody {
                        view_id: view,
                        consent: true,
                    },
                )
                .is_ok()
        );
    }

    #[test]
    fn status_bootstraps_the_device_and_frame_bounds_are_enforced() {
        let fixture = fixture();
        // Bootstrap: status names the exact device before any capture consent
        // exists, so the UI has a deviceId to echo back to `/view`.
        let status = fixture
            .computer
            .status(&fixture.sessions, &fixture.session)
            .unwrap();
        assert_eq!(status["configured"], json!(true));
        assert_eq!(status["ready"], json!(true));
        assert_eq!(status["reason"], Value::Null);
        assert_eq!(status["device"]["deviceId"], json!(fixture.mock.device.id));
        assert_eq!(status["view"], Value::Null);
        assert_eq!(status["control"], Value::Null);
        assert_eq!(status["limits"]["consentRequired"], json!(true));
        // Metadata only: no pixels were produced and no input was sent.
        assert_eq!(fixture.mock.captures.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.mock.infos.load(Ordering::SeqCst), 1);
        // The probe is cached, so polling does not spawn a helper per request.
        fixture
            .computer
            .status(&fixture.sessions, &fixture.session)
            .unwrap();
        assert_eq!(fixture.mock.infos.load(Ordering::SeqCst), 1);
        let view = fixture.view();
        assert_eq!(
            fixture
                .computer
                .status(&fixture.sessions, &fixture.session)
                .unwrap()["view"]["viewId"],
            json!(view)
        );
        // Frame throttling is per device, not per view.
        let (frame, seq) = fixture
            .computer
            .frame(
                &fixture.sessions,
                &fixture.session,
                FrameBody {
                    view_id: view.clone(),
                    consent: true,
                },
            )
            .unwrap();
        assert!(frame.png.starts_with(&PNG_SIGNATURE));
        assert_eq!(seq, 1);
        assert_eq!(
            fixture
                .computer
                .frame(
                    &fixture.sessions,
                    &fixture.session,
                    FrameBody {
                        view_id: view.clone(),
                        consent: true
                    }
                )
                .unwrap_err(),
            "computer_throttled"
        );
        fixture.tick(MIN_FRAME_INTERVAL_MS);
        assert!(
            fixture
                .computer
                .preview(
                    &fixture.sessions,
                    &fixture.session,
                    PreviewBody { consent: true }
                )
                .is_ok()
        );
        // Closed event whitelist and bounded text.
        let bounds = fixture.mock.device.bounds;
        let outside = EventBody {
            kind: EventKind::Pointer,
            x: Some(bounds.x + bounds.width as i32),
            y: Some(0),
            button: Some(WireButton::Left),
            action: Some(WireAction::Click),
            delta: None,
            key: None,
            text: None,
        };
        assert_eq!(outside.command(bounds).unwrap_err(), "computer_input_invalid");
        let mut stray = event(EventKind::Key);
        stray.key = Some(WireKey::Enter);
        stray.delta = Some(1);
        assert_eq!(stray.command(bounds).unwrap_err(), "computer_input_invalid");
        let mut text = event(EventKind::Text);
        text.text = Some("a".repeat(MAX_TEXT_CODEPOINTS));
        assert!(text.command(bounds).is_ok());
        text.text = Some("a".repeat(MAX_TEXT_CODEPOINTS + 1));
        assert_eq!(text.command(bounds).unwrap_err(), "computer_input_invalid");
        text.text = Some("line\nbreak".to_owned());
        assert_eq!(text.command(bounds).unwrap_err(), "computer_input_invalid");
        text.text = Some("astral \u{1f600}".to_owned());
        assert_eq!(text.command(bounds).unwrap_err(), "computer_input_invalid");
        text.text = Some(String::new());
        assert_eq!(text.command(bounds).unwrap_err(), "computer_input_invalid");
        // A lone surrogate cannot even be decoded, so it never becomes an event.
        assert!(
            serde_json::from_str::<EventBody>(r#"{"kind":"text","text":"\ud800"}"#).is_err(),
            "lone surrogate must be rejected at the JSON boundary"
        );
        assert!(
            serde_json::from_str::<InputBody>(
                r#"{"viewId":"v","controlId":"c","generation":1,"seq":1,"consent":true,
                    "event":{"kind":"key","key":"enter"}}"#
            )
            .is_ok()
        );
        assert!(
            serde_json::from_str::<InputBody>(
                r#"{"viewId":"v","controlId":"c","generation":1,"seq":1,"consent":true,
                    "event":{"kind":"key","key":"enter"},"command":"calc.exe"}"#
            )
            .is_err(),
            "there is no command field to smuggle a shell through"
        );
    }

    #[test]
    fn revoked_and_expired_sessions_never_reach_the_os() {
        let fixture = fixture();
        let view = fixture.view();
        let (control, generation) = fixture.control(&view);
        // Session renewal keeps the client identity, so the lease survives it.
        assert!(fixture.sessions.renew(&fixture.session).is_ok());
        assert!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 1))
                .is_ok()
        );
        // Rotation protects nothing here: the revoked session must fail closed.
        fixture
            .sessions
            .rotate(&crate::new_token().unwrap())
            .unwrap();
        let before = fixture.mock.inputs.lock().unwrap().len();
        for body in [
            fixture.click(&view, &control, generation, 2),
            fixture.click(&view, &control, generation, 3),
        ] {
            assert_eq!(
                fixture
                    .computer
                    .input(&fixture.sessions, &fixture.session, body)
                    .unwrap_err(),
                "session_required"
            );
        }
        assert_eq!(fixture.mock.inputs.lock().unwrap().len(), before);
        assert_eq!(
            fixture
                .computer
                .status(&fixture.sessions, &fixture.session)
                .unwrap_err(),
            "session_required"
        );
        assert_eq!(
            fixture
                .computer
                .preview(
                    &fixture.sessions,
                    &fixture.session,
                    PreviewBody { consent: true }
                )
                .unwrap_err(),
            "session_required"
        );
    }

    #[test]
    fn release_synchronises_with_an_input_already_holding_the_gate() {
        let (mock, entered, proceed) = Mock::blocking_input();
        let fixture = fixture_with(Arc::new(mock));
        let view = fixture.view();
        let (control, generation) = fixture.control(&view);
        let worker = {
            let computer = fixture.computer.clone();
            let sessions = fixture.sessions.clone();
            let session = fixture.session.clone();
            let body = fixture.click(&view, &control, generation, 1);
            std::thread::spawn(move || computer.input(&sessions, &session, body))
        };
        // Wait until the input owns the gate and is inside the OS call.
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("input never entered the backend");
        let released = Arc::new(AtomicBool::new(false));
        let releaser = {
            let computer = fixture.computer.clone();
            let sessions = fixture.sessions.clone();
            let session = fixture.session.clone();
            let released = released.clone();
            let (view, control) = (view.clone(), control.clone());
            std::thread::spawn(move || {
                let result = computer.release_control(
                    &sessions,
                    &session,
                    ReleaseBody {
                        view_id: view,
                        control_id: control,
                        generation,
                    },
                );
                released.store(true, Ordering::SeqCst);
                result
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !released.load(Ordering::SeqCst),
            "release must not return while a queued input is inside the gate"
        );
        proceed.send(()).unwrap();
        worker.join().unwrap().unwrap();
        releaser.join().unwrap().unwrap();
        assert!(released.load(Ordering::SeqCst));
        // After the barrier the very same queued shape is stale.
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 2))
                .unwrap_err(),
            "computer_input_stale"
        );
    }

    #[test]
    fn disabled_provider_fails_closed_without_touching_a_desktop() {
        let token = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&token).unwrap());
        let (_, session) = sessions
            .login(&token)
            .ok()
            .expect("browser session must be issued");
        let computer = Computer {
            config: None,
            remote: false,
            provider: Arc::new(UnavailableProvider),
            clock: Arc::new(wall_clock),
            gate: Mutex::new(Gate::default()),
            epoch: Arc::new(AtomicU64::new(0)),
            retired: AtomicBool::new(false),
            captures: Arc::new(Semaphore::new(1)),
            jobs: Arc::new(Semaphore::new(MAX_JOBS)),
            acquire_hold: Mutex::new(None),
        };
        assert!(!computer.supported());
        assert_eq!(computer.report()["configured"], json!(false));
        assert_eq!(computer.report()["ready"], Value::Null);
        assert_eq!(
            computer
                .start_view(
                    &sessions,
                    &session,
                    ViewBody {
                        consent: true,
                        device_id: "sha256:x".to_owned()
                    }
                )
                .unwrap_err(),
            "computer_unsupported"
        );
        assert_eq!(
            computer
                .preview(&sessions, &session, PreviewBody { consent: true })
                .unwrap_err(),
            "computer_unsupported"
        );
        assert_eq!(
            computer
                .status(&sessions, &session)
                .unwrap()["reason"],
            json!("computer_helper_not_configured")
        );
        assert_eq!(
            http_status("computer_unsupported"),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(http_status("computer_consent_required"), StatusCode::FORBIDDEN);
        assert_eq!(http_status("person_unknown"), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn status_readiness_surfaces_a_metadata_failure() {
        let mock = Arc::new(Mock::new());
        *mock.failure.lock().unwrap() = Some(Failure::BackendUnavailable);
        let fixture = fixture_with(mock);
        let status = fixture
            .computer
            .status(&fixture.sessions, &fixture.session)
            .unwrap();
        // Configured is static; ready is the observed fact, reported as a public
        // code rather than an internal error chain.
        assert_eq!(status["configured"], json!(true));
        assert_eq!(status["ready"], json!(false));
        assert_eq!(status["reason"], json!("computer_backend_unavailable"));
        assert_eq!(status["device"], Value::Null);
        // The negative cache stops a broken backend from being re-spawned by
        // every UI poll.
        fixture
            .computer
            .status(&fixture.sessions, &fixture.session)
            .unwrap();
        assert_eq!(fixture.mock.infos.load(Ordering::SeqCst), 1);
        // Starting a view reports the same code instead of inventing a device.
        assert_eq!(
            fixture
                .computer
                .start_view(
                    &fixture.sessions,
                    &fixture.session,
                    ViewBody {
                        consent: true,
                        device_id: "sha256:x".to_owned()
                    }
                )
                .unwrap_err(),
            "computer_backend_unavailable"
        );
        assert_eq!(fixture.mock.captures.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn no_wire_shape_can_hold_a_button_or_a_key() {
        let bounds = Bounds {
            x: -1920,
            y: 0,
            width: 3840,
            height: 1080,
        };
        for body in [
            r#"{"viewId":"v","controlId":"c","generation":1,"seq":1,"consent":true,
                "event":{"kind":"pointer","x":1,"y":1,"button":"left","action":"down"}}"#,
            r#"{"viewId":"v","controlId":"c","generation":1,"seq":1,"consent":true,
                "event":{"kind":"pointer","x":1,"y":1,"button":"left","action":"up"}}"#,
        ] {
            assert!(
                serde_json::from_str::<InputBody>(body).is_err(),
                "a held button must not be expressible: {body}"
            );
        }
        // A click is the only gesture that presses a button, and it is one
        // atomic down+up pair inside a single request.
        let click = serde_json::from_str::<InputBody>(
            r#"{"viewId":"v","controlId":"c","generation":1,"seq":1,"consent":true,
                "event":{"kind":"pointer","x":1,"y":1,"button":"left","action":"click"}}"#,
        )
        .unwrap();
        assert_eq!(
            click.event.command(bounds).unwrap(),
            InputCommand::Pointer {
                x: 1,
                y: 1,
                button: Some(PointerButton::Left),
                action: PointerAction::Click,
            }
        );
        // Keys are taps only: no key-state field exists to hold anything down.
        assert!(
            serde_json::from_str::<InputBody>(
                r#"{"viewId":"v","controlId":"c","generation":1,"seq":1,"consent":true,
                    "event":{"kind":"key","key":"enter","state":"down"}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn provider_failure_consumes_the_sequence_and_revokes_the_lease() {
        let fixture = fixture();
        let view = fixture.view();
        let (control, generation) = fixture.control(&view);
        *fixture.mock.input_failure.lock().unwrap() = Some(Failure::Timeout);
        // A helper that times out may still have typed something, so the outcome
        // is unknown and the lease is revoked at once.
        assert_eq!(
            fixture
                .computer
                .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, 1))
                .unwrap_err(),
            "computer_input_unknown"
        );
        assert_eq!(fixture.mock.inputs.lock().unwrap().len(), 0);
        *fixture.mock.input_failure.lock().unwrap() = None;
        // Neither the same seq nor a later one may be resent on that lease.
        for seq in [1, 2] {
            assert_eq!(
                fixture
                    .computer
                    .input(&fixture.sessions, &fixture.session, fixture.click(&view, &control, generation, seq))
                    .unwrap_err(),
                "computer_input_stale"
            );
        }
        assert_eq!(fixture.mock.inputs.lock().unwrap().len(), 0);
    }

    #[test]
    fn a_poisoned_gate_fails_closed() {
        let fixture = fixture();
        let poisoned = fixture.computer.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.gate.lock().expect("gate");
            panic!("poison the input gate on purpose");
        })
        .join();
        // Unknown in-memory lease state is never adopted as trustworthy.
        assert_eq!(
            fixture
                .computer
                .status(&fixture.sessions, &fixture.session)
                .unwrap_err(),
            "computer_unavailable"
        );
        assert_eq!(
            fixture
                .computer
                .preview(&fixture.sessions, &fixture.session, PreviewBody { consent: true })
                .unwrap_err(),
            "computer_unavailable"
        );
        assert_eq!(
            http_status("computer_unavailable"),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
