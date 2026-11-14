//! Node-side computer device: the only place a physical desktop is touched.
//!
//! Opt-in is a Host-owned fact: both the interpreter and the helper script must
//! be absolute existing files passed as `--computer-python` / `--computer-helper`.
//! Without them nothing is advertised and every request is refused. Nothing in a
//! request can name a program, a path or an environment value.
//!
//! The wire contract is deliberately narrow (see `loom_protocol::computer`): the
//! node has no views, leases or consent state. The Host owns those. What the node
//! owns, and must own alone, is:
//!
//! * **serialization** — one `input` mutex spans admission, the request-identity
//!   commit and the OS call, so two events can never interleave;
//! * **identity before effect** — a request id is consumed *before* the helper
//!   runs, so a duplicate or replayed frame can never be applied twice;
//! * **drain on release** — `Release` takes the same mutex, so it cannot answer
//!   until every input this node accepted has finished;
//! * **bounded kill/reap** — every helper invocation is deadline-bounded and is
//!   killed and reaped on expiry, so a wedged helper cannot outlive the call;
//! * **epoch fencing, enforced not advisory** — a disconnect moves the epoch, and
//!   every call compares it (a) before it starts, (b) after it acquires the input
//!   gate, (c) immediately before it spawns a helper, and (d) on every poll while
//!   the helper runs. A cancelled helper is killed *and reaped* before the call
//!   returns, so a replaced socket can neither start a new injection nor leave an
//!   old one running;
//! * **no optimistic success** — an input whose outcome is unknown (timeout,
//!   cancellation, refusal) leaves the device *unproven*, and all further input is
//!   refused until a release from the current epoch proves cleanup.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use loom_protocol::ClientMessage;
use loom_protocol::computer::{
    COMPUTER_VERSION, ComputerBoundsV1, ComputerCodeV1, ComputerDeviceV1, ComputerFrameChunkV1,
    ComputerFrameHeaderV1, ComputerInputV1, ComputerOpV1, ComputerReplyV1, ComputerRequestV1,
    MAX_CHUNK_BYTES, MAX_FRAME_BYTES, chunk_count, known_platform, platform_accepts_text,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Semaphore, mpsc};

/// One helper invocation, including its own kill/reap deadline.
const HELPER_DEADLINE: Duration = Duration::from_secs(5);
/// How often a live helper is polled against its deadline and its epoch.
const POLL_INTERVAL: Duration = Duration::from_millis(5);
/// Helper stdout bound: one JSON header plus one capture.
const MAX_STDOUT_BYTES: usize = 4 * 1024 + MAX_FRAME_BYTES as usize + 64;
/// Concurrent helper invocations this node will run.
const MAX_JOBS: usize = 4;
/// Request identities remembered for duplicate suppression.
const MAX_SEEN: usize = 64;

/// Absolute interpreter plus absolute script. Owned by the operator's command
/// line; a request can never change either field.
#[derive(Clone, Debug)]
struct HelperLaunch {
    python: PathBuf,
    script: PathBuf,
}

/// One helper invocation. Injectable so the safety invariants — cancellation,
/// kill/reap, single injection — are provable without a display; production
/// always uses [`ProcessHelper`]. Every implementation must honour `cancel`:
/// it is not advisory.
trait HelperRunner: Send + Sync {
    fn run(
        &self,
        request: &Value,
        cancel: &AtomicU64,
        epoch: u64,
        deadline: Duration,
    ) -> Result<(Value, Vec<u8>), ComputerCodeV1>;
}

struct ProcessHelper {
    launch: HelperLaunch,
}

impl HelperRunner for ProcessHelper {
    fn run(
        &self,
        request: &Value,
        cancel: &AtomicU64,
        epoch: u64,
        deadline: Duration,
    ) -> Result<(Value, Vec<u8>), ComputerCodeV1> {
        run_helper(&self.launch, request, cancel, epoch, deadline)
    }
}

pub(crate) struct ComputerHost {
    helper: Option<Arc<dyn HelperRunner>>,
    /// Empty unless the startup metadata probe succeeded on a known backend.
    advertised: Vec<u32>,
    platform: String,
    /// Held across admission, identity commit and the OS call.
    input: StdMutex<()>,
    /// Request ids already applied. Bounded; never persisted.
    seen: StdMutex<VecDeque<String>>,
    /// The current socket generation. Every helper call compares it before it
    /// starts, after it takes the input gate, immediately before it spawns and
    /// on every poll while it runs.
    epoch: AtomicU64,
    /// True while the device may hold physical state from an input whose outcome
    /// was never confirmed. Input stays refused until a release clears it.
    unproven: AtomicBool,
    jobs: Arc<Semaphore>,
}

impl ComputerHost {
    /// Build the host from the operator's flags. The metadata probe runs once
    /// here: a node only advertises the transport after its own device answered,
    /// so a headless Linux box reports no screen instead of inventing one.
    pub(crate) fn open(helper: Option<PathBuf>, python: Option<PathBuf>) -> Arc<Self> {
        let launch = match (helper, python) {
            (Some(script), Some(python))
                if script.is_absolute()
                    && script.is_file()
                    && python.is_absolute()
                    && python.is_file() =>
            {
                Some(HelperLaunch { python, script })
            }
            (None, None) => None,
            _ => {
                eprintln!(
                    "loom-node: computer disabled; --computer-helper and --computer-python must both be absolute existing files"
                );
                None
            }
        };
        let mut platform = String::new();
        let mut advertised = Vec::new();
        let helper: Option<Arc<dyn HelperRunner>> =
            launch.map(|launch| Arc::new(ProcessHelper { launch }) as Arc<dyn HelperRunner>);
        if let Some(runner) = helper.as_ref() {
            // Startup has no socket yet, so the probe runs against a token that
            // never moves; it is still bounded by its own deadline.
            let token = AtomicU64::new(0);
            match probe(runner.as_ref(), &token, 0) {
                Ok(device) => {
                    platform = device.platform;
                    advertised.push(COMPUTER_VERSION);
                }
                Err(code) => {
                    eprintln!("loom-node: computer unavailable ({}); not advertised", code);
                }
            }
        }
        Arc::new(Self {
            helper,
            advertised,
            platform,
            input: StdMutex::new(()),
            seen: StdMutex::new(VecDeque::new()),
            epoch: AtomicU64::new(0),
            unproven: AtomicBool::new(false),
            jobs: Arc::new(Semaphore::new(MAX_JOBS)),
        })
    }

    #[cfg(test)]
    fn with_runner(helper: Arc<dyn HelperRunner>, platform: &str) -> Arc<Self> {
        Arc::new(Self {
            helper: Some(helper),
            advertised: vec![COMPUTER_VERSION],
            platform: platform.to_owned(),
            input: StdMutex::new(()),
            seen: StdMutex::new(VecDeque::new()),
            epoch: AtomicU64::new(0),
            unproven: AtomicBool::new(false),
            jobs: Arc::new(Semaphore::new(MAX_JOBS)),
        })
    }

    /// Announced in `Hello`. Empty means "no computer", never "unknown".
    pub(crate) fn advertised_versions(&self) -> Vec<u32> {
        self.advertised.clone()
    }

    /// A new socket owns a new epoch. Moving it is what cancels: every running
    /// helper polls it, and every queued request re-checks it before starting.
    pub(crate) fn disconnect(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Accept one closed operation. Work runs on the blocking pool so a capture
    /// never stalls the session loop, and no output crosses a replaced socket.
    pub(crate) fn handle(
        self: &Arc<Self>,
        request: ComputerRequestV1,
        output: mpsc::Sender<ClientMessage>,
    ) {
        // The epoch of the socket this request arrived on.
        let epoch = self.epoch.load(Ordering::SeqCst);
        if self.helper.is_none() {
            let reply = ComputerReplyV1::refusal(&request.request_id, ComputerCodeV1::Unsupported);
            let _ = output.try_send(ClientMessage::ComputerReply { reply });
            return;
        }
        if request.validate().is_err() {
            let reply =
                ComputerReplyV1::refusal(&request.request_id, ComputerCodeV1::InvalidRequest);
            let _ = output.try_send(ClientMessage::ComputerReply { reply });
            return;
        }
        let Ok(permit) = self.jobs.clone().try_acquire_owned() else {
            let reply = ComputerReplyV1::refusal(&request.request_id, ComputerCodeV1::Busy);
            let _ = output.try_send(ClientMessage::ComputerReply { reply });
            return;
        };
        let host = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            // Never start work for a socket that was replaced while queued.
            if host.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let (reply, png) = host.execute(&request, epoch);
            // Re-check before every single frame, not once per operation.
            if host.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            if output
                .blocking_send(ClientMessage::ComputerReply { reply })
                .is_err()
            {
                return;
            }
            let Some((request_id, header, png)) = png else {
                return;
            };
            for (index, slice) in png.chunks(header.chunk_bytes as usize).enumerate() {
                if host.epoch.load(Ordering::SeqCst) != epoch {
                    return;
                }
                let chunk = ComputerFrameChunkV1 {
                    version: COMPUTER_VERSION,
                    request_id: request_id.clone(),
                    seq: (index as u32).saturating_add(1),
                    data: STANDARD.encode(slice),
                };
                if output
                    .blocking_send(ClientMessage::ComputerFrameChunk { chunk })
                    .is_err()
                {
                    return;
                }
            }
        });
    }

    /// Returns the reply plus, for a capture, the id, header and pixels.
    #[allow(clippy::type_complexity)]
    fn execute(
        &self,
        request: &ComputerRequestV1,
        epoch: u64,
    ) -> (
        ComputerReplyV1,
        Option<(String, ComputerFrameHeaderV1, Vec<u8>)>,
    ) {
        let request_id = request.request_id.clone();
        match &request.op {
            ComputerOpV1::Info {} => match self.info(epoch) {
                Ok(device) => {
                    let mut reply = ComputerReplyV1::refusal(&request_id, ComputerCodeV1::Ok);
                    reply.device = Some(device);
                    (reply, None)
                }
                Err(code) => (ComputerReplyV1::refusal(&request_id, code), None),
            },
            ComputerOpV1::Frame {
                max_width,
                max_height,
            } => match self.frame(epoch, *max_width, *max_height) {
                Ok((device, header, png)) => {
                    let mut reply = ComputerReplyV1::refusal(&request_id, ComputerCodeV1::Ok);
                    reply.device = Some(device);
                    reply.frame = Some(header);
                    (reply, Some((request_id, header, png)))
                }
                Err(code) => (ComputerReplyV1::refusal(&request_id, code), None),
            },
            ComputerOpV1::Input { input } => match self.apply_input(epoch, &request_id, input) {
                Ok(()) => (ComputerReplyV1::refusal(&request_id, ComputerCodeV1::Ok), None),
                Err(code) => (ComputerReplyV1::refusal(&request_id, code), None),
            },
            ComputerOpV1::Release {} => match self.release(epoch, &request_id) {
                Ok(()) => (ComputerReplyV1::refusal(&request_id, ComputerCodeV1::Ok), None),
                Err(code) => (ComputerReplyV1::refusal(&request_id, code), None),
            },
        }
    }

    fn run(
        &self,
        request: &Value,
        epoch: u64,
        deadline: Duration,
    ) -> Result<(Value, Vec<u8>), ComputerCodeV1> {
        let runner = self.helper.clone().ok_or(ComputerCodeV1::Unsupported)?;
        runner.run(request, &self.epoch, epoch, deadline)
    }

    fn info(&self, epoch: u64) -> Result<ComputerDeviceV1, ComputerCodeV1> {
        let (header, body) = self.run(&json!({"op": "info"}), epoch, HELPER_DEADLINE)?;
        if !body.is_empty() {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        device_from(&header)
    }

    fn frame(
        &self,
        epoch: u64,
        max_width: u32,
        max_height: u32,
    ) -> Result<(ComputerDeviceV1, ComputerFrameHeaderV1, Vec<u8>), ComputerCodeV1> {
        let (header, png) = self.run(
            &json!({"op":"capture","consent":true,"maxWidth":max_width,"maxHeight":max_height}),
            epoch,
            HELPER_DEADLINE,
        )?;
        if png.is_empty() || png.len() > MAX_FRAME_BYTES as usize {
            return Err(ComputerCodeV1::CaptureFailed);
        }
        let device = device_from(&header)?;
        let width = header
            .get("width")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(ComputerCodeV1::CaptureFailed)?;
        let height = header
            .get("height")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(ComputerCodeV1::CaptureFailed)?;
        let scale_millis = header
            .get("scale")
            .and_then(Value::as_f64)
            .map(|scale| (scale * 1000.0).round().clamp(1.0, 16_000.0) as u32)
            .unwrap_or(1000);
        let captured_at = header
            .get("capturedAt")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or_else(now_ms);
        let total_bytes = png.len() as u32;
        let chunk_bytes = MAX_CHUNK_BYTES;
        let count = chunk_count(total_bytes, chunk_bytes)?;
        let frame = ComputerFrameHeaderV1 {
            width,
            height,
            scale_millis,
            captured_at,
            chunk_bytes,
            chunk_count: u32::try_from(count).map_err(|_| ComputerCodeV1::CaptureFailed)?,
            total_bytes,
        };
        frame.validate()?;
        Ok((device, frame, png))
    }

    fn apply_input(
        &self,
        epoch: u64,
        request_id: &str,
        input: &ComputerInputV1,
    ) -> Result<(), ComputerCodeV1> {
        // The mutex spans admission, identity and the OS call: input is
        // serialized and a concurrent `Release` cannot answer in between.
        let _gate = self.input.lock().map_err(|_| ComputerCodeV1::Busy)?;
        // (b) A request that waited here while the socket was replaced must never
        // start an injection on the new socket's device.
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Err(ComputerCodeV1::Cancelled);
        }
        // Prior physical state must be proven clean before new input is admitted.
        if self.unproven.load(Ordering::SeqCst) {
            return Err(ComputerCodeV1::ReleaseUnconfirmed);
        }
        // A text the backend cannot encode is refused before anything is sent.
        if let ComputerInputV1::Text { text } = input {
            platform_accepts_text(&self.platform, text)?;
        }
        // Consume the identity BEFORE the effect: a replay cannot apply twice,
        // even if the reply for the first attempt was lost.
        if !self.consume(request_id) {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        // Pessimistic: from here on the device may hold state, so only a
        // confirmed helper answer clears this flag again.
        self.unproven.store(true, Ordering::SeqCst);
        // (c) `run_helper` re-checks the epoch immediately before spawning, and
        // (d) polls it while the helper runs.
        match self.run(&input_wire(input), epoch, HELPER_DEADLINE) {
            Ok((header, body))
                if body.is_empty() && header.get("ok").and_then(Value::as_bool) == Some(true) =>
            {
                self.unproven.store(false, Ordering::SeqCst);
                Ok(())
            }
            // Any other outcome — refusal, timeout, cancellation — leaves the
            // device unproven, so no later input is admitted on a guess.
            Ok(_) => Err(ComputerCodeV1::InputFailed),
            Err(code) => Err(code),
        }
    }

    fn release(&self, epoch: u64, request_id: &str) -> Result<(), ComputerCodeV1> {
        // Taking the input mutex *is* the drain: no input this node accepted can
        // still be mid-call, so a successful helper release is real evidence.
        let _gate = self.input.lock().map_err(|_| ComputerCodeV1::Busy)?;
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Err(ComputerCodeV1::Cancelled);
        }
        if !self.consume(request_id) {
            return Err(ComputerCodeV1::InvalidRequest);
        }
        let (header, body) = self.run(&json!({"op": "release"}), epoch, HELPER_DEADLINE)?;
        if !body.is_empty() || header.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(ComputerCodeV1::ReleaseUnconfirmed);
        }
        // Only a confirmed release proves the device is clean again.
        self.unproven.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn consume(&self, request_id: &str) -> bool {
        let Ok(mut seen) = self.seen.lock() else {
            return false;
        };
        if seen.iter().any(|id| id == request_id) {
            return false;
        }
        seen.push_back(request_id.to_owned());
        while seen.len() > MAX_SEEN {
            seen.pop_front();
        }
        true
    }
}

fn probe(
    runner: &dyn HelperRunner,
    cancel: &AtomicU64,
    epoch: u64,
) -> Result<ComputerDeviceV1, ComputerCodeV1> {
    let (header, body) = runner.run(&json!({"op": "info"}), cancel, epoch, HELPER_DEADLINE)?;
    if !body.is_empty() {
        return Err(ComputerCodeV1::InvalidRequest);
    }
    device_from(&header)
}

fn device_from(header: &Value) -> Result<ComputerDeviceV1, ComputerCodeV1> {
    let platform = header
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !known_platform(platform) {
        // No backend this contract can reason about: refuse rather than guess.
        return Err(ComputerCodeV1::InputUnsupported);
    }
    let device_id = header
        .get("deviceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or(ComputerCodeV1::DeviceUnavailable)?;
    let bounds = ComputerBoundsV1 {
        x: int_field(header, "originX")?,
        y: int_field(header, "originY")?,
        width: dim_field(header, "screenWidth")?,
        height: dim_field(header, "screenHeight")?,
    };
    if bounds.width == 0 || bounds.height == 0 {
        return Err(ComputerCodeV1::DeviceUnavailable);
    }
    Ok(ComputerDeviceV1 {
        device_id: device_id.to_owned(),
        platform: platform.to_owned(),
        bounds,
    })
}

fn int_field(header: &Value, name: &str) -> Result<i32, ComputerCodeV1> {
    header
        .get(name)
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or(ComputerCodeV1::DeviceUnavailable)
}

fn dim_field(header: &Value, name: &str) -> Result<u32, ComputerCodeV1> {
    header
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ComputerCodeV1::DeviceUnavailable)
}

/// The helper's own closed request shape. No field here is chosen by a caller
/// beyond the already-validated coordinates, key, button and text.
fn input_wire(input: &ComputerInputV1) -> Value {
    match input {
        ComputerInputV1::Pointer {
            x,
            y,
            button,
            action,
        } => json!({
            "op": "pointer",
            "x": x,
            "y": y,
            "button": button.map(|button| match button {
                loom_protocol::computer::ComputerButtonV1::Left => "left",
                loom_protocol::computer::ComputerButtonV1::Right => "right",
                loom_protocol::computer::ComputerButtonV1::Middle => "middle",
            }),
            "action": match action {
                loom_protocol::computer::ComputerActionV1::Click => "click",
                loom_protocol::computer::ComputerActionV1::Move => "move",
            },
        }),
        ComputerInputV1::Wheel { x, y, delta } => {
            json!({"op": "wheel", "x": x, "y": y, "delta": delta})
        }
        ComputerInputV1::Key { key } => json!({"op": "key", "key": key.wire()}),
        ComputerInputV1::Text { text } => json!({"op": "text", "text": text}),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// One bounded helper invocation: request on stdin, one JSON header line plus
/// (for a capture) raw PNG on stdout, and a hard kill/reap deadline.
///
/// `cancel` is checked before the process is created, so a request that was
/// cancelled while it waited never starts; and on every poll, so a disconnect
/// terminates and reaps a helper that is already running. There is no path that
/// returns without reaping the child it created.
fn run_helper(
    launch: &HelperLaunch,
    request: &Value,
    cancel: &AtomicU64,
    epoch: u64,
    deadline: Duration,
) -> Result<(Value, Vec<u8>), ComputerCodeV1> {
    // (c) Immediately before the process is created.
    if cancel.load(Ordering::SeqCst) != epoch {
        return Err(ComputerCodeV1::Cancelled);
    }
    let body = serde_json::to_vec(request).map_err(|_| ComputerCodeV1::InvalidRequest)?;
    let mut child = Command::new(&launch.python)
        .arg(&launch.script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Diagnostics are discarded: a chatty or wedged helper can never grow
        // this process's memory or land in a log.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ComputerCodeV1::BackendUnavailable)?;
    if let Some(mut stdin) = child.stdin.take() {
        // The request is bounded and travels on stdin only, so coordinates and
        // typed text never appear in an OS process list.
        let _ = stdin.write_all(&body);
        let _ = stdin.write_all(b"\n");
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ComputerCodeV1::CaptureFailed);
        }
    };
    let reader = std::thread::spawn(move || read_capped(stdout, MAX_STDOUT_BYTES));
    let started = Instant::now();
    let status = loop {
        // (d) A replaced socket cancels an in-flight helper within one poll.
        if cancel.load(Ordering::SeqCst) != epoch {
            let _ = child.kill();
            let _ = child.wait();
            // The reader ends at EOF once the child is reaped; join it so no
            // thread of this call outlives it.
            let _ = reader.join();
            return Err(ComputerCodeV1::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if started.elapsed() >= deadline {
            // Bounded kill and reap: nothing this call started outlives it.
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(POLL_INTERVAL);
    };
    let bytes = reader.join().unwrap_or_default();
    let Some(status) = status else {
        return Err(ComputerCodeV1::Timeout);
    };
    let (header, png) = parse_helper_output(&bytes)?;
    if !status.success() {
        return Err(helper_code(&header));
    }
    Ok((header, png))
}

/// Drain to EOF but keep at most `cap` bytes, so an oversized or endless writer
/// neither blocks the child nor grows memory.
fn read_capped(mut reader: impl Read, cap: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if kept.len() < cap {
                    let room = cap - kept.len();
                    let take = count.min(room);
                    kept.extend_from_slice(&buffer[..take]);
                }
            }
            Err(_) => break,
        }
    }
    kept
}

fn parse_helper_output(bytes: &[u8]) -> Result<(Value, Vec<u8>), ComputerCodeV1> {
    let split = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or(ComputerCodeV1::CaptureFailed)?;
    let header: Value =
        serde_json::from_slice(&bytes[..split]).map_err(|_| ComputerCodeV1::CaptureFailed)?;
    Ok((header, bytes[split + 1..].to_vec()))
}

fn helper_code(header: &Value) -> ComputerCodeV1 {
    match header.get("error").and_then(Value::as_str) {
        Some("no_display") | Some("unsupported_backend") => ComputerCodeV1::BackendUnavailable,
        Some("session_locked") => ComputerCodeV1::SessionLocked,
        Some("encoder_unavailable") => ComputerCodeV1::EncoderUnavailable,
        Some("unsupported_input") => ComputerCodeV1::InputUnsupported,
        Some("capture_failed") => ComputerCodeV1::CaptureFailed,
        Some("invalid_request") => ComputerCodeV1::InvalidRequest,
        _ => ComputerCodeV1::CaptureFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn pointer() -> ComputerInputV1 {
        ComputerInputV1::Pointer {
            x: 1,
            y: 2,
            button: Some(loom_protocol::computer::ComputerButtonV1::Left),
            action: loom_protocol::computer::ComputerActionV1::Click,
        }
    }

    /// Answers every call successfully and counts them.
    struct OkRunner {
        calls: AtomicU64,
    }

    impl HelperRunner for OkRunner {
        fn run(
            &self,
            _request: &Value,
            _cancel: &AtomicU64,
            _epoch: u64,
            _deadline: Duration,
        ) -> Result<(Value, Vec<u8>), ComputerCodeV1> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok((json!({"ok": true}), Vec::new()))
        }
    }

    /// Holds the device on the first pointer call until the test releases it, so
    /// a second request is provably queued on the input gate.
    struct BarrierRunner {
        calls: AtomicU64,
        entered: StdMutex<Option<mpsc::Sender<()>>>,
        proceed: StdMutex<Option<mpsc::Receiver<()>>>,
    }

    impl HelperRunner for BarrierRunner {
        fn run(
            &self,
            request: &Value,
            cancel: &AtomicU64,
            epoch: u64,
            _deadline: Duration,
        ) -> Result<(Value, Vec<u8>), ComputerCodeV1> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if request.get("op").and_then(Value::as_str) == Some("pointer") {
                if let Some(entered) = self.entered.lock().unwrap().as_ref() {
                    let _ = entered.send(());
                }
                let receiver = self.proceed.lock().unwrap().take();
                if let Some(receiver) = receiver {
                    let _ = receiver.recv();
                }
            }
            if cancel.load(Ordering::SeqCst) != epoch {
                return Err(ComputerCodeV1::Cancelled);
            }
            Ok((json!({"ok": true}), Vec::new()))
        }
    }

    #[test]
    fn a_queued_input_from_a_replaced_socket_never_reaches_the_device() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (proceed_tx, proceed_rx) = mpsc::channel();
        let runner = Arc::new(BarrierRunner {
            calls: AtomicU64::new(0),
            entered: StdMutex::new(Some(entered_tx)),
            proceed: StdMutex::new(Some(proceed_rx)),
        });
        let host = ComputerHost::with_runner(runner.clone(), "linux-x11");
        let epoch = host.epoch.load(Ordering::SeqCst);

        // A holds the physical gate inside the helper.
        let first = {
            let host = Arc::clone(&host);
            std::thread::spawn(move || host.apply_input(epoch, "req_a", &pointer()))
        };
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("first input reached the helper");

        // B queues behind A on the same gate, still carrying the old epoch.
        let second = {
            let host = Arc::clone(&host);
            std::thread::spawn(move || host.apply_input(epoch, "req_b", &pointer()))
        };
        std::thread::sleep(Duration::from_millis(50));

        // The socket is replaced while B is queued.
        host.disconnect();
        proceed_tx.send(()).expect("release the barrier");

        // A was already injecting, so it may finish; B must never start.
        let _ = first.join().expect("first input thread");
        assert_eq!(
            second.join().expect("second input thread"),
            Err(ComputerCodeV1::Cancelled),
            "a queued request from a replaced socket started an injection"
        );
        assert_eq!(
            runner.calls.load(Ordering::SeqCst),
            1,
            "the helper ran for a cancelled request"
        );
    }

    #[test]
    fn an_unconfirmed_input_blocks_new_input_until_a_release_confirms_cleanup() {
        struct FailOnce {
            fail: AtomicBool,
        }
        impl HelperRunner for FailOnce {
            fn run(
                &self,
                request: &Value,
                _cancel: &AtomicU64,
                _epoch: u64,
                _deadline: Duration,
            ) -> Result<(Value, Vec<u8>), ComputerCodeV1> {
                if request.get("op").and_then(Value::as_str) == Some("pointer")
                    && self.fail.swap(false, Ordering::SeqCst)
                {
                    // The OS call timed out: the device may or may not hold state.
                    return Err(ComputerCodeV1::Timeout);
                }
                Ok((json!({"ok": true}), Vec::new()))
            }
        }
        let host = ComputerHost::with_runner(
            Arc::new(FailOnce {
                fail: AtomicBool::new(true),
            }),
            "linux-x11",
        );
        let epoch = host.epoch.load(Ordering::SeqCst);
        assert_eq!(
            host.apply_input(epoch, "req_1", &pointer()),
            Err(ComputerCodeV1::Timeout)
        );
        // No success may be inferred from a timeout.
        assert_eq!(
            host.apply_input(epoch, "req_2", &pointer()),
            Err(ComputerCodeV1::ReleaseUnconfirmed)
        );
        // A release from the current epoch is the only thing that clears it.
        assert_eq!(host.release(epoch, "req_release"), Ok(()));
        assert_eq!(host.apply_input(epoch, "req_3", &pointer()), Ok(()));
    }

    #[test]
    fn a_release_from_a_replaced_socket_is_cancelled_and_never_claims_cleanup() {
        let runner = Arc::new(OkRunner {
            calls: AtomicU64::new(0),
        });
        let host = ComputerHost::with_runner(runner.clone(), "linux-x11");
        let epoch = host.epoch.load(Ordering::SeqCst);
        host.disconnect();
        assert_eq!(
            host.release(epoch, "req_release"),
            Err(ComputerCodeV1::Cancelled)
        );
        assert_eq!(
            runner.calls.load(Ordering::SeqCst),
            0,
            "a stale release invoked the helper"
        );
    }

    #[test]
    fn a_disconnect_kills_and_reaps_an_active_helper_and_nothing_keeps_injecting() {
        // A real child process: it publishes its pid, sleeps far past the test,
        // and only then writes the marker that stands for "injected".
        let Some(python) = test_python() else {
            return;
        };
        let dir = std::env::temp_dir().join(format!(
            "loom-b7-disconnect-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let pid_file = dir.join("pid");
        let marker = dir.join("injected");
        let script = dir.join("slow_helper.py");
        let source = format!(
            "import os, time\nopen({:?}, 'w').write(str(os.getpid()))\ntime.sleep(30)\nopen({:?}, 'w').write('injected')\n",
            pid_file.to_string_lossy(),
            marker.to_string_lossy()
        );
        std::fs::write(&script, source.as_bytes()).expect("write fixture helper");
        let host = Arc::new(ComputerHost {
            helper: Some(Arc::new(ProcessHelper {
                launch: HelperLaunch {
                    python,
                    script: script.clone(),
                },
            })),
            advertised: vec![COMPUTER_VERSION],
            platform: "linux-x11".to_owned(),
            input: StdMutex::new(()),
            seen: StdMutex::new(VecDeque::new()),
            epoch: AtomicU64::new(0),
            unproven: AtomicBool::new(false),
            jobs: Arc::new(Semaphore::new(MAX_JOBS)),
        });
        let epoch = host.epoch.load(Ordering::SeqCst);
        let worker = {
            let host = Arc::clone(&host);
            std::thread::spawn(move || host.apply_input(epoch, "req_slow", &pointer()))
        };
        let pid = wait_for_pid(&pid_file).expect("helper published its pid");

        host.disconnect();

        assert_eq!(
            worker.join().expect("input thread"),
            Err(ComputerCodeV1::Cancelled),
            "a cancelled helper did not report cancellation"
        );
        // Reaped: the child is gone the moment the call returns.
        assert!(!process_running(pid), "helper {pid} was not reaped");
        // And it never reached the injection step.
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !marker.exists(),
            "a cancelled helper kept running and injected input"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_request_identity_is_consumed_once_and_the_memory_is_bounded() {
        let host = ComputerHost::with_runner(
            Arc::new(OkRunner {
                calls: AtomicU64::new(0),
            }),
            "linux-x11",
        );
        assert!(host.consume("req_1"));
        // The same frame can never be applied twice, even after a lost reply.
        assert!(!host.consume("req_1"));
        assert!(host.consume("req_2"));
        for index in 0..(MAX_SEEN + 10) {
            assert!(host.consume(&format!("req_extra_{index}")));
        }
        assert!(host.seen.lock().unwrap().len() <= MAX_SEEN);
        // Bounded memory means the oldest identity is forgotten, not that a
        // recent one is: the most recent id is still refused.
        assert!(!host.consume(&format!("req_extra_{}", MAX_SEEN + 9)));
    }

    #[test]
    fn helper_output_is_split_into_one_header_and_a_bounded_body() {
        let (header, body) =
            parse_helper_output(b"{\"ok\":true,\"platform\":\"linux-x11\"}\nPNG").unwrap();
        assert_eq!(header["platform"], "linux-x11");
        assert_eq!(body, b"PNG");
        assert!(parse_helper_output(b"no newline").is_err());
        assert!(parse_helper_output(b"not json\n").is_err());
        assert_eq!(
            helper_code(&json!({"ok": false, "error": "no_display"})),
            ComputerCodeV1::BackendUnavailable
        );
        assert_eq!(
            helper_code(&json!({"ok": false, "error": "unsupported_input"})),
            ComputerCodeV1::InputUnsupported
        );
        assert_eq!(
            helper_code(&json!({"ok": false, "error": "anything else"})),
            ComputerCodeV1::CaptureFailed
        );
    }

    #[test]
    fn a_wedged_helper_is_killed_and_reaped_at_its_deadline() {
        let Some(python) = test_python() else {
            return;
        };
        let script = std::env::temp_dir().join(format!(
            "loom-computer-sleep-{}.py",
            std::process::id()
        ));
        std::fs::write(&script, b"import time\ntime.sleep(30)\n").unwrap();
        let launch = HelperLaunch {
            python,
            script: script.clone(),
        };
        let token = AtomicU64::new(0);
        let started = Instant::now();
        let result = run_helper(
            &launch,
            &json!({"op": "info"}),
            &token,
            0,
            Duration::from_millis(300),
        );
        assert_eq!(result.err(), Some(ComputerCodeV1::Timeout));
        assert!(started.elapsed() < Duration::from_secs(10));
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn a_missing_interpreter_is_a_backend_refusal_not_a_hang() {
        let launch = HelperLaunch {
            python: PathBuf::from("/nonexistent/python3"),
            script: PathBuf::from("/nonexistent/host_desktop.py"),
        };
        let token = AtomicU64::new(0);
        assert_eq!(
            run_helper(
                &launch,
                &json!({"op": "info"}),
                &token,
                0,
                Duration::from_millis(200)
            )
            .err(),
            Some(ComputerCodeV1::BackendUnavailable)
        );
    }

    #[test]
    fn computer_is_off_until_both_absolute_paths_exist() {
        // Default: disabled. Nothing is advertised, so nothing can be routed.
        assert!(ComputerHost::open(None, None).advertised_versions().is_empty());
        // A relative path is never accepted, even beside a valid interpreter.
        assert!(
            ComputerHost::open(
                Some(PathBuf::from("relative/host_desktop.py")),
                Some(PathBuf::from("/usr/bin/python3")),
            )
            .advertised_versions()
            .is_empty()
        );
        // Both absolute but missing: still disabled, and nothing was spawned.
        assert!(
            ComputerHost::open(
                Some(PathBuf::from("/nonexistent/host_desktop.py")),
                Some(PathBuf::from("/nonexistent/python3")),
            )
            .advertised_versions()
            .is_empty()
        );
        // Only one of the two supplied: disabled rather than half-configured.
        assert!(
            ComputerHost::open(Some(PathBuf::from("/nonexistent/host_desktop.py")), None)
                .advertised_versions()
                .is_empty()
        );
    }

    fn wait_for_pid(path: &std::path::Path) -> Option<u32> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            if let Ok(text) = std::fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse::<u32>()
            {
                return Some(pid);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    #[cfg(unix)]
    fn process_running(pid: u32) -> bool {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some((_, rest)) = text.rsplit_once(')') else {
            return false;
        };
        matches!(rest.split_whitespace().next(), Some("R" | "S" | "D"))
    }

    #[cfg(not(unix))]
    fn process_running(_pid: u32) -> bool {
        false
    }

    fn test_python() -> Option<PathBuf> {
        for candidate in ["/usr/bin/python3", "/usr/local/bin/python3", "python3"] {
            let path = PathBuf::from(candidate);
            if path.is_absolute() {
                if path.is_file() {
                    return Some(path);
                }
                continue;
            }
            if Command::new(candidate)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
            {
                return Some(path);
            }
        }
        None
    }
}
