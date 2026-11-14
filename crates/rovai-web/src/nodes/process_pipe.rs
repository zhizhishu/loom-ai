//! A-side managed process pipe: private durable journal, ordered input, bounded
//! output with ACK-after-durable, explicit owner binding, explicit stop/release.
//!
//! Invariants enforced here (no caller may weaken them):
//!
//! * A pipe receipt is never a native-input acceptance receipt. `InputWritten`
//!   proves only that the frame reached the node's pipe; the field is named
//!   `input_boundary_written`, and nothing here claims native acceptance.
//! * The private journal is durable *before* `Open` is sent, and one
//!   `RemoteProcessKey` can never own two journals or two starts.
//! * Output is journalled (fsynced) before the ACK is queued. A journal failure
//!   fails closed: no cursor advance, no ACK, no invented success.
//! * Abandoning output is a loss decision that must be durable before the wire
//!   `Release` and only after a positive `Terminated` tree receipt. Retained,
//!   unread bytes stay on disk and remain readable as evidence.
//! * `State`, `Exited` and `Refused` never authorize cleanup, an owner change or
//!   a parser restore. Only a matching explicit receipt does.
//! * No control command is dropped silently: `send_node_message(.., true)`
//!   reports an error instead, and the command stays queued for replay.
//! * The registry never holds a strong `Hub`: an upgrade failure is reported.

use std::{
    collections::{HashMap, VecDeque},
    fmt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as StdMutex, Weak,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use loom_protocol::ServerMessage;
use loom_protocol::builtin_pipe::BuiltinCallV1;
use loom_protocol::process_pipe::{
    AgentRunOwner as WireOwner, BindProcessOwner, BundleMaterializationV1, MAX_INPUT_BYTES,
    MAX_OUTPUT_CHUNK, MAX_PENDING_INPUTS, MAX_SAFE_COUNTER, PROCESS_PIPE_VERSION, PipeStream,
    ProcessArgument, ProcessControlBody, ProcessControlReply, ProcessInputV1, ProcessOpenV1,
    ProcessOutputBody, ProcessOutputEvent, ProcessPipeCommand, ProcessSessionOwner,
    RemoteProcessKey as WireKey, decode_bounded,
};
use rovai_core::builtin_tool_transport::BuiltinToolIpcRequestBody;
use rovai_core::remote_process::{
    AgentRunOwner, RemoteArgument, RemoteBundleMaterialization, RemoteExitReceipt, RemoteFuture,
    RemoteHostScope, RemoteOwnerReceipt, RemoteProcess, RemoteProcessControl, RemoteProcessError,
    RemoteProcessKey, RemoteProcessLauncher, RemoteProcessState, RemoteTerminationMode,
    RemoteTerminationReceipt, ScopedRemoteLaunch,
};
use rovai_core::remote_runtime_services::RemoteBuiltinInvocation;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, watch};

use super::Hub;

use io::{PipeReader, PipeStdin};
use spool::{JournalIdentity, OrphanState, Spool, SpoolError, TerminalSummary};

mod io;
mod spool;
#[cfg(test)]
mod tests;

/// Private child of the Web data directory; scanned once, bounded, at startup.
const PIPE_ROOT: &str = "process-pipe";
/// Separate bounded control-receipt journal (orphan decisions and normal
/// releases). Payload free, no second database, same narrow private-file policy
/// as the spool. A restart can see an already released key honestly.
const CONTROL_RECEIPTS: &str = "control-receipts.json";
const CONTROL_RECEIPTS_VERSION: u32 = 1;
const MAX_CONTROL_RECEIPTS: usize = 64;
const MAX_CONTROL_RECEIPT_BYTES: usize = 256 * 1024;

const MAX_LIVE_PIPES: usize = 32;
const MAX_ORPHAN_RECORDS: usize = 128;
const MAX_ORPHAN_SCAN: usize = 256;
/// Bounded hand-off between the socket reader and the single ordered spool
/// writer. Full means "no ACK, replay later", never fatal and never a deletion.
const INBOUND_OUTPUT_QUEUE: usize = 32;
/// Unique, bounded stop queue: `Graceful` and `Force` each queue at most once.
const STOP_QUEUE: usize = 4;
/// Bounded dedupe window for input receipts already confirmed.
const RECENT_INPUT_RECEIPTS: usize = 32;

const OPEN_WAIT: Duration = Duration::from_secs(30);
const INPUT_WRITE_WAIT: Duration = Duration::from_secs(30);
const BIND_WAIT: Duration = Duration::from_secs(15);
const RELEASE_WAIT: Duration = Duration::from_secs(10);
const STOP_REAP_WAIT: Duration = Duration::from_secs(15);
const ORPHAN_STOP_BUDGET_MS: u32 = 1_000;
const STOP_BUDGET_GRACEFUL_MS: u32 = 1_500;
const STOP_BUDGET_FORCE_MS: u32 = 500;
/// The wire carries one bounded tree stop; both modes use it honestly.
const MAX_TERMINATE_BUDGET_MS: u32 = 5_000;

const STREAM_STDOUT: u8 = 1 << 0;
const STREAM_STDERR: u8 = 1 << 1;

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    // Critical sections here are a few field reads/collects. A poisoned lock must
    // not panic a socket or an owner task, so recover the data.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn default_stop_budget(mode: RemoteTerminationMode) -> u32 {
    match mode {
        RemoteTerminationMode::Graceful => STOP_BUDGET_GRACEFUL_MS,
        RemoteTerminationMode::Force => STOP_BUDGET_FORCE_MS,
    }
}

// ---------------------------------------------------------------------------
// Identity conversion. Core and wire types stay distinct; both validate.
// ---------------------------------------------------------------------------

fn wire_key(key: &RemoteProcessKey) -> WireKey {
    WireKey {
        node_id: key.node_id.clone(),
        process_id: key.process_id.clone(),
        process_epoch: key.process_epoch,
    }
}

fn core_key(key: &WireKey) -> Result<RemoteProcessKey, RemoteProcessError> {
    key.validate()
        .map_err(|_| RemoteProcessError::IdentityMismatch)?;
    let key = RemoteProcessKey {
        node_id: key.node_id.clone(),
        process_id: key.process_id.clone(),
        process_epoch: key.process_epoch,
    };
    key.validate()?;
    Ok(key)
}

fn wire_owner(owner: &AgentRunOwner) -> WireOwner {
    WireOwner {
        agent_run_id: owner.agent_run_id.clone(),
        execution_epoch: owner.execution_epoch,
    }
}

fn core_owner(owner: &WireOwner) -> AgentRunOwner {
    AgentRunOwner {
        agent_run_id: owner.agent_run_id.clone(),
        execution_epoch: owner.execution_epoch,
    }
}

fn stream_bit(stream: PipeStream) -> u8 {
    match stream {
        PipeStream::Stdout => STREAM_STDOUT,
        PipeStream::Stderr => STREAM_STDERR,
    }
}

/// Pure conversion from the frozen Core target to the closed wire request. No
/// inherited environment, no local path and no caller-supplied executable can
/// enter: every field is copied from a validated frozen target.
fn open_from_launch(
    launch: &ScopedRemoteLaunch,
    controller_id: &str,
) -> Result<ProcessOpenV1, RemoteProcessError> {
    let target = &launch.target;
    // Same identity rule as the frozen Core target: a node and workspace must
    // agree before a closed request may be built.
    if launch.key.node_id != target.node_id || launch.host_scope.workspace_id != target.workspace_id
    {
        return Err(RemoteProcessError::IdentityMismatch);
    }
    let arguments: Vec<ProcessArgument> = launch
        .arguments
        .iter()
        .map(|argument| match argument {
            RemoteArgument::Literal { value } => ProcessArgument::Literal {
                value: value.clone(),
            },
            RemoteArgument::MaterializedFile { path } => {
                ProcessArgument::MaterializedFile { path: path.clone() }
            }
        })
        .collect();
    let environment: Vec<(String, String)> = launch
        .environment
        .entries()
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let open = ProcessOpenV1 {
        version: if launch.codex_hook_grant.is_some() {
            loom_protocol::command_hooks::CODEX_HOOK_PIPE_VERSION
        } else { PROCESS_PIPE_VERSION },
        key: wire_key(&launch.key),
        session: ProcessSessionOwner {
            member_id: launch.host_scope.member_id.clone(),
            logical_session_id: launch.host_scope.logical_session_id.clone(),
            workspace_id: launch.host_scope.workspace_id.clone(),
            controller_id: controller_id.to_owned(),
        },
        owner: wire_owner(&launch.initial_owner),
        // Copied from the frozen Core launch, never defaulted to `true`.
        builtin_tasks_enabled: launch.builtin_tasks_enabled,
        adapter_kind: target.adapter_kind.clone(),
        catalog_generation: target.node_generation,
        program_identity: target.program_identity.clone(),
        program: target.program.clone(),
        cwd: target.workspace_root.clone(),
        args: arguments,
        environment,
        // The bundle identity is preserved byte for byte: it is part of the
        // canonical Open digest the journal and both sides bind to.
        bundle: launch.bundle.clone(),
        codex_hook_grant: launch.codex_hook_grant.clone(),
    };
    open.validate()
        .map_err(|_| RemoteProcessError::LaunchRejected)?;
    open.digest()
        .map_err(|_| RemoteProcessError::LaunchRejected)?;
    Ok(open)
}

// ---------------------------------------------------------------------------
// Live pipe state
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PipeFault {
    Spool(&'static str),
    SequenceConflict,
    OpenDigest,
    ControlIdentity,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum InputState {
    Sent,
    Written,
    Unknown,
}

struct PendingInput {
    envelope: ProcessInputV1,
    digest: String,
    count: usize,
    state: InputState,
}

/// Sequence, shape and state only; never payload bytes.
impl fmt::Debug for PendingInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingInput")
            .field("input_seq", &self.envelope.input_seq)
            .field("encoded_bytes", &self.envelope.data.len())
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

struct PendingBinding {
    binding: BindProcessOwner,
}

/// The accepted `OwnerBound` in wire form. Used only to recognise an exact
/// duplicate replay as idempotent.
struct LastBinding {
    request_id: String,
    binding_seq: u64,
    owner: Option<WireOwner>,
    builtin_tasks: bool,
    input_seq: u64,
}

struct QueuedStop {
    request_id: String,
    budget_ms: u32,
    mode: RemoteTerminationMode,
    sent: bool,
}

struct QueuedRelease {
    request_id: String,
    abandon_output: bool,
    acked_event_seq: u64,
}

struct TerminateEvidence {
    request_id: String,
    leader_exited: bool,
    tree_stopped: bool,
}

struct ReleaseEvidence {
    request_id: String,
    final_event_seq: u64,
    acked_event_seq: u64,
    output_abandoned: bool,
}

struct PipeState {
    ws_generation: u64,
    connected: bool,
    /// Verified `Opened` for this exact launch digest; the only source of the
    /// initial owner sequence zero.
    opened_pid: Option<u32>,
    owner: Option<AgentRunOwner>,
    binding_seq: u64,
    /// Owner-binding tasks flag. Immutable `Open` owns sequence zero; only an
    /// explicit owner bind may change it, and never implicitly.
    builtin_tasks: bool,
    next_input_seq: u64,
    written_input_seq: u64,
    /// Set while an original write has no unambiguous receipt.
    ambiguous_input_seq: Option<u64>,
    pending_inputs: HashMap<u64, PendingInput>,
    recent_inputs: VecDeque<(u64, String, String)>,
    pending_binding: Option<PendingBinding>,
    last_binding: Option<RemoteOwnerReceipt>,
    /// Exact wire form of the last accepted `OwnerBound`, for idempotent replay.
    last_binding_wire: Option<LastBinding>,
    /// Verified `Opened.materialization` receipt. Only node-side identity and a
    /// stable root; a node never supplies prompt text here.
    materialization: Option<BundleMaterializationV1>,
    stop_counter: u64,
    stop_queue: VecDeque<QueuedStop>,
    terminate_evidence: Option<TerminateEvidence>,
    release_counter: u64,
    pending_release: Option<QueuedRelease>,
    release_evidence: Option<ReleaseEvidence>,
    released: bool,
    closed_stdin: bool,
    output_abandoned: bool,
    /// A tail event was dropped before it could be journalled.
    capture_incomplete: bool,
    dropped_upto: Option<u64>,
    acked_seq: u64,
    resume_requested: bool,
    resume_in_flight: bool,
    /// Set by a dropped start future: this pipe may never replay `Open`.
    replay_disabled: bool,
    fault: Option<PipeFault>,
}

struct Inbound {
    queue: VecDeque<(u64, ProcessOutputEvent)>,
    worker_running: bool,
}

struct LivePipe {
    key: RemoteProcessKey,
    host_scope: RemoteHostScope,
    /// Exactly the original command; replayed verbatim on reconnect.
    open: ProcessOpenV1,
    open_digest: String,
    /// Durable installation generation evidence (`catalog_generation` on wire).
    install_generation: u64,
    node_id: String,
    controller_id: String,
    hub: Weak<Hub>,
    spool: Arc<AsyncMutex<Spool>>,
    inbound: StdMutex<Inbound>,
    state: StdMutex<PipeState>,
    /// Serializes stdin writes with owner binding. Never held across socket I/O.
    write_gate: AsyncMutex<()>,
    tick: watch::Sender<u64>,
    consumer_gone: AtomicU8,
}

/// Sequence numbers and counts only.
impl fmt::Debug for LivePipe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self.state();
        f.debug_struct("LivePipe")
            .field("key", &self.key)
            .field("open_digest", &self.open_digest)
            .field("install_generation", &self.install_generation)
            .field("opened_pid", &state.opened_pid)
            .field("binding_seq", &state.binding_seq)
            .field("next_input_seq", &state.next_input_seq)
            .field("pending_inputs", &state.pending_inputs.len())
            .field("ws_generation", &state.ws_generation)
            .field("released", &state.released)
            .field("fault", &state.fault)
            .finish_non_exhaustive()
    }
}

impl LivePipe {
    fn state(&self) -> std::sync::MutexGuard<'_, PipeState> {
        lock(&self.state)
    }

    fn bump(&self) {
        self.tick.send_modify(|tick| *tick = tick.wrapping_add(1));
    }

    fn fault(&self, fault: PipeFault) {
        {
            let mut state = self.state();
            if state.fault.is_none() {
                state.fault = Some(fault);
            }
        }
        self.bump();
    }

    fn accepts_generation(&self, generation: u64) -> bool {
        if generation == 0 {
            return false;
        }
        let state = self.state();
        state.connected && state.ws_generation == generation
    }

    fn attach_generation(&self, generation: u64) -> bool {
        {
            let mut state = self.state();
            if generation == 0 || generation < state.ws_generation {
                return false;
            }
            state.ws_generation = generation;
            state.connected = true;
        }
        self.bump();
        true
    }

    fn detach_generation(&self, generation: u64) {
        {
            let mut state = self.state();
            if state.ws_generation != generation {
                return;
            }
            state.connected = false;
            // Keep the high-water mark so delayed attach callbacks cannot
            // rewind the controller after a newer socket has disconnected.
        }
        self.bump();
    }

    fn disable_replay(&self) {
        {
            let mut state = self.state();
            state.replay_disabled = true;
        }
        self.bump();
    }

    fn mark_consumer_dropped(&self, stream: PipeStream) {
        self.consumer_gone
            .fetch_or(stream_bit(stream), Ordering::AcqRel);
        self.bump();
    }

    /// Evidence for the parent: a cancelled native consumer never looks like a
    /// drained stream. The abandon decision itself stays with the owner.
    #[allow(dead_code)]
    fn consumer_dropped(&self, stream: PipeStream) -> bool {
        self.consumer_gone.load(Ordering::Acquire) & stream_bit(stream) != 0
    }

    // -- transport ---------------------------------------------------------
    async fn send_command(
        &self,
        command: ProcessPipeCommand,
        urgent: bool,
    ) -> Result<(), &'static str> {
        let generation = {
            let state = self.state();
            if !state.connected || state.ws_generation == 0 {
                return Err("node_offline");
            }
            state.ws_generation
        };
        self.send_at(Some(generation), command, urgent).await
    }

    /// Exact-generation send. Used where the pipe's own recorded socket
    /// generation is authoritative (new launch, reconnect replay) so an attach
    /// or disconnect race can never deliver into a replacement socket.
    async fn send_command_generation(
        &self,
        generation: u64,
        command: ProcessPipeCommand,
        urgent: bool,
    ) -> Result<(), &'static str> {
        self.send_at(Some(generation), command, urgent).await
    }

    async fn send_at(
        &self,
        generation: Option<u64>,
        command: ProcessPipeCommand,
        urgent: bool,
    ) -> Result<(), &'static str> {
        let hub = self.hub.upgrade().ok_or("pipe_hub_unavailable")?;
        let message = ServerMessage::ProcessPipe { command };
        match generation {
            Some(generation) => {
                hub.send_node_message_generation(&self.node_id, generation, message, urgent)
                    .await
            }
            None => hub.send_node_message(&self.node_id, message, urgent).await,
        }
    }

    async fn is_current_socket(&self, generation: u64) -> bool {
        let Some(hub) = self.hub.upgrade() else {
            return false;
        };
        hub.current_connection(&self.node_id, generation).await
    }

    // -- spool -------------------------------------------------------------

    async fn journal_highest(&self) -> u64 {
        self.spool.lock().await.highest_received_seq()
    }

    async fn journal_terminal(&self) -> Option<TerminalSummary> {
        self.spool.lock().await.terminal().cloned()
    }

    async fn record_output(self: &Arc<Self>, event: ProcessOutputEvent) -> Result<(), SpoolError> {
        let spool = Arc::clone(&self.spool);
        match tokio::task::spawn_blocking(move || {
            let mut guard = spool.blocking_lock();
            guard.record(event)
        })
        .await
        {
            Ok(result) => result.map(|_| ()),
            Err(_) => Err(SpoolError::Persist),
        }
    }

    async fn consume_output(
        self: &Arc<Self>,
        seq: u64,
        stream: PipeStream,
    ) -> Result<(), RemoteProcessError> {
        let spool = Arc::clone(&self.spool);
        let result = tokio::task::spawn_blocking(move || {
            let mut guard = spool.blocking_lock();
            guard.consume_stream_event(seq, stream)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                self.bump();
                self.request_resume_if_blocked();
                Ok(())
            }
            Ok(Err(error)) => {
                self.fault(PipeFault::Spool(error.code()));
                Err(RemoteProcessError::UnknownOutcome)
            }
            Err(_) => {
                self.fault(PipeFault::Spool("pipe_spool_persist"));
                Err(RemoteProcessError::UnknownOutcome)
            }
        }
    }

    async fn mark_output_abandoned(self: &Arc<Self>) -> Result<(), RemoteProcessError> {
        let spool = Arc::clone(&self.spool);
        let result = tokio::task::spawn_blocking(move || {
            let mut guard = spool.blocking_lock();
            guard.mark_output_abandoned()
        })
        .await;
        match result {
            Ok(Ok(())) => {
                self.state().output_abandoned = true;
                self.bump();
                Ok(())
            }
            _ => {
                // The loss decision is not durable, so no release may follow.
                self.fault(PipeFault::Spool("pipe_spool_persist"));
                Err(RemoteProcessError::UnknownOutcome)
            }
        }
    }

    // -- output path -------------------------------------------------------

    /// Prompt, bounded hand-off. Never blocks the authenticated socket reader on
    /// an fsync; a single background writer preserves the global event order.
    /// Returns `true` when the caller must spawn the worker.
    fn enqueue_output(self: &Arc<Self>, generation: u64, event: ProcessOutputEvent) -> bool {
        let mut inbound = lock(&self.inbound);
        if inbound.queue.len() >= INBOUND_OUTPUT_QUEUE {
            drop(inbound);
            self.lose_tail(event.event_seq);
            self.request_resume();
            return false;
        }
        inbound.queue.push_back((generation, event));
        let spawn = !inbound.worker_running;
        if spawn {
            inbound.worker_running = true;
        }
        drop(inbound);
        self.bump();
        spawn
    }

    fn lose_tail(&self, seq: u64) {
        let mut state = self.state();
        state.capture_incomplete = true;
        state.dropped_upto = Some(match state.dropped_upto {
            Some(previous) => previous.max(seq),
            None => seq,
        });
    }

    fn request_resume(&self) {
        {
            let mut state = self.state();
            state.resume_requested = true;
        }
        self.bump();
    }

    fn request_resume_if_blocked(self: &Arc<Self>) {
        let blocked = {
            let state = self.state();
            state.resume_requested || state.capture_incomplete
        };
        if blocked {
            self.request_resume();
            self.spawn_resume();
        }
    }

    fn spawn_resume(self: &Arc<Self>) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let pipe = Arc::clone(self);
            handle.spawn(async move { pipe.drive_resume().await });
        }
    }

    /// `Resume` says "replay from this durable cursor". It is sent after a
    /// bounded window was full or a socket changed, never as "output complete".
    async fn drive_resume(self: Arc<Self>) {
        {
            let mut state = self.state();
            if !state.resume_requested || state.resume_in_flight || state.released {
                return;
            }
            state.resume_requested = false;
            state.resume_in_flight = true;
        }
        let generation = self.state().ws_generation;
        if generation != 0 && self.is_current_socket(generation).await {
            let after_event_seq = self.journal_highest().await;
            let _ = self
                .send_command_generation(
                    generation,
                    ProcessPipeCommand::Resume {
                        key: wire_key(&self.key),
                        controller_id: self.controller_id.clone(),
                        after_event_seq,
                    },
                    false,
                )
                .await;
        }
        {
            let mut state = self.state();
            state.resume_in_flight = false;
        }
        self.bump();
    }

    async fn ack(self: &Arc<Self>, generation: u64, event_seq: u64) -> bool {
        let sent = self
            .send_command_generation(
                generation,
                ProcessPipeCommand::Ack {
                    key: wire_key(&self.key),
                    controller_id: self.controller_id.clone(),
                    event_seq,
                },
                false,
            )
            .await;
        if sent.is_ok() {
            let mut state = self.state();
            if state.ws_generation == generation && event_seq > state.acked_seq {
                state.acked_seq = event_seq;
            }
        }
        // A failed ACK is safe: the node keeps the event and replays it.
        sent.is_ok() && self.state().ws_generation == generation
    }

    /// The single ordered journal writer for this pipe.
    async fn output_worker(self: Arc<Self>) {
        loop {
            let next = {
                let mut inbound = lock(&self.inbound);
                match inbound.queue.pop_front() {
                    Some(event) => Some(event),
                    None => {
                        // Clearing the flag under the same lock as the pop means a
                        // concurrent enqueue either saw `worker_running` or wakes
                        // this loop before it can exit.
                        inbound.worker_running = false;
                        None
                    }
                }
            };
            let Some((generation, event)) = next else {
                break;
            };
            if !self.accepts_generation(generation) || !self.is_current_socket(generation).await {
                // Retired socket: the node replays from the durable cursor.
                self.request_resume();
                continue;
            }
            match self.record_output(event.clone()).await {
                Ok(()) => {
                    let gap_filled = {
                        let state = self.state();
                        state
                            .dropped_upto
                            .is_some_and(|dropped| event.event_seq >= dropped)
                    };
                    if gap_filled {
                        let mut state = self.state();
                        state.capture_incomplete = false;
                        state.dropped_upto = None;
                    }
                    // Re-check the socket before the ACK so a stale generation is
                    // never acknowledged.
                    if self.is_current_socket(generation).await {
                        self.ack(generation, event.event_seq).await;
                    }
                    self.bump();
                }
                Err(SpoolError::PendingFull) => {
                    // Bounded window full: no advance, no ACK, no deletion.
                    self.lose_tail(event.event_seq);
                    self.request_resume();
                }
                Err(SpoolError::SequenceGap) | Err(SpoolError::SequenceRetired) => {
                    // Honest overflow/replay window, not corruption.
                    self.request_resume();
                }
                Err(SpoolError::SequenceConflict) | Err(SpoolError::Identity) => {
                    self.fault(PipeFault::SequenceConflict);
                }
                Err(error) => {
                    // Disk failure: fail closed. No advance, no ACK.
                    self.fault(PipeFault::Spool(error.code()));
                    self.request_resume();
                }
            }
        }
        self.bump();
        self.spawn_resume();
    }

    // -- reads -------------------------------------------------------------

    async fn next_stream_item(
        self: &Arc<Self>,
        stream: PipeStream,
    ) -> Result<io::StreamItem, RemoteProcessError> {
        loop {
            let mut changed = self.tick.subscribe();
            let pending = { self.spool.lock().await.pending_for_stream(stream) };
            if let Some(event) = pending {
                match &event.body {
                    ProcessOutputBody::Output { data, .. } => {
                        let bytes = decode_bounded(data, MAX_OUTPUT_CHUNK)
                            .map_err(|_| RemoteProcessError::Unavailable)?;
                        return Ok(io::StreamItem::Chunk {
                            seq: event.event_seq,
                            bytes,
                        });
                    }
                    ProcessOutputBody::OutputFault { code, .. } => {
                        return Ok(io::StreamItem::Fault {
                            seq: event.event_seq,
                            code: code.clone(),
                        });
                    }
                    ProcessOutputBody::Exited { .. } => {}
                }
            }
            let finished = { self.spool.lock().await.stream_finished(stream) };
            if finished {
                return Ok(io::StreamItem::Eof);
            }
            {
                let state = self.state();
                if state.output_abandoned {
                    // Only an intentional abandon is a terminal loss. A full
                    // window leaves `capture_incomplete` set while the replay is
                    // pending, so that case waits for the tick/Resume instead.
                    return Ok(io::StreamItem::Incomplete);
                }
                if state.fault.is_some() {
                    return Err(RemoteProcessError::UnknownOutcome);
                }
            }
            if changed.changed().await.is_err() {
                return Err(RemoteProcessError::Unavailable);
            }
        }
    }

    // -- stop --------------------------------------------------------------

    fn queue_stop(
        &self,
        mode: RemoteTerminationMode,
        budget_ms: u32,
    ) -> Result<String, RemoteProcessError> {
        let mut state = self.state();
        if state.fault.is_some() {
            return Err(RemoteProcessError::UnknownOutcome);
        }
        if let Some(existing) = state.stop_queue.iter().find(|entry| entry.mode == mode) {
            // Unique and stable: one command per mode, replayed verbatim.
            return Ok(existing.request_id.clone());
        }
        if state.stop_queue.len() >= STOP_QUEUE {
            return Err(RemoteProcessError::Unavailable);
        }
        let counter = state
            .stop_counter
            .checked_add(1)
            .ok_or(RemoteProcessError::IdentityMismatch)?;
        state.stop_counter = counter;
        let request_id = format!("stop.{counter}");
        state.stop_queue.push_back(QueuedStop {
            request_id: request_id.clone(),
            budget_ms: budget_ms.clamp(1, MAX_TERMINATE_BUDGET_MS),
            mode,
            sent: false,
        });
        drop(state);
        self.bump();
        Ok(request_id)
    }

    async fn flush_stop(self: &Arc<Self>) {
        loop {
            let next = {
                let mut state = self.state();
                let Some(entry) = state.stop_queue.iter_mut().find(|entry| !entry.sent) else {
                    return;
                };
                entry.sent = true;
                let key = wire_key(&self.key);
                (
                    entry.request_id.clone(),
                    ProcessPipeCommand::Terminate {
                        key,
                        request_id: entry.request_id.clone(),
                        budget_ms: entry.budget_ms,
                    },
                )
            };
            if self.send_command(next.1, true).await.is_err() {
                // Keep it queued: the next connect replays the same command.
                let mut state = self.state();
                if let Some(entry) = state
                    .stop_queue
                    .iter_mut()
                    .find(|entry| entry.request_id == next.0)
                {
                    entry.sent = false;
                }
                return;
            }
        }
    }

    async fn await_stop(
        self: &Arc<Self>,
        request_id: &str,
        budget: Duration,
    ) -> Result<RemoteTerminationReceipt, RemoteProcessError> {
        let deadline = tokio::time::Instant::now() + budget.max(Duration::from_millis(1));
        loop {
            let mut changed = self.tick.subscribe();
            {
                let state = self.state();
                if let Some(evidence) = &state.terminate_evidence {
                    if evidence.request_id == request_id {
                        return Ok(RemoteTerminationReceipt {
                            key: self.key.clone(),
                            leader_exited: evidence.leader_exited,
                            tree_stopped: evidence.tree_stopped,
                        });
                    }
                }
                if state.fault.is_some() {
                    return Err(RemoteProcessError::UnknownOutcome);
                }
            }
            match tokio::time::timeout_at(deadline, changed.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(RemoteProcessError::Unavailable),
                Err(_) => return Err(RemoteProcessError::DeadlineExceeded),
            }
        }
    }

    async fn terminate(
        self: &Arc<Self>,
        mode: RemoteTerminationMode,
        budget: Duration,
    ) -> Result<RemoteTerminationReceipt, RemoteProcessError> {
        let requested = u32::try_from(budget.as_millis()).unwrap_or(MAX_TERMINATE_BUDGET_MS);
        // Honest bounded tree stop: never more than the wire cap, never more than
        // the caller asked for.
        let budget_ms = requested
            .min(default_stop_budget(mode))
            .clamp(1, MAX_TERMINATE_BUDGET_MS);
        let request_id = self.queue_stop(mode, budget_ms)?;
        self.flush_stop().await;
        self.await_stop(&request_id, budget.max(Duration::from_millis(1)))
            .await
    }

    // -- owner binding -----------------------------------------------------

    async fn bind(
        self: &Arc<Self>,
        owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool,
    ) -> Result<RemoteOwnerReceipt, RemoteProcessError> {
        if let Some(owner) = &owner {
            owner.validate()?;
        }
        if owner.is_none() && builtin_tasks_enabled {
            // An unbound pipe can never carry the tasks capability.
            return Err(RemoteProcessError::IdentityMismatch);
        }
        let _gate = self.write_gate.lock().await;
        let (previous, after_input_seq, binding_seq) = {
            let state = self.state();
            if state.opened_pid.is_none() {
                // Sequence zero comes only from a verified `Opened`.
                return Err(RemoteProcessError::InputBoundaryUnconfirmed);
            }
            if state.fault.is_some() {
                return Err(RemoteProcessError::UnknownOutcome);
            }
            if state.ambiguous_input_seq.is_some() || state.pending_binding.is_some() {
                return Err(RemoteProcessError::InputBoundaryUnconfirmed);
            }
            if state.owner == owner && state.builtin_tasks == builtin_tasks_enabled {
                // Open owns sequence zero; the same owner and the same flag keep
                // the sequence unchanged. Changing either advances exactly once.
                return Ok(RemoteOwnerReceipt {
                    key: self.key.clone(),
                    binding_seq: state.binding_seq,
                    owner,
                    builtin_tasks_enabled,
                    input_boundary_written: true,
                });
            }
            let binding_seq = state
                .binding_seq
                .checked_add(1)
                .ok_or(RemoteProcessError::IdentityMismatch)?;
            if binding_seq > MAX_SAFE_COUNTER {
                return Err(RemoteProcessError::IdentityMismatch);
            }
            (state.owner.clone(), state.written_input_seq, binding_seq)
        };
        let binding = BindProcessOwner {
            key: wire_key(&self.key),
            controller_id: self.controller_id.clone(),
            request_id: format!("bind.{binding_seq}"),
            binding_seq,
            previous_owner: previous.as_ref().map(wire_owner),
            next_owner: owner.as_ref().map(wire_owner),
            builtin_tasks_enabled,
            after_input_seq,
        };
        binding
            .validate()
            .map_err(|_| RemoteProcessError::IdentityMismatch)?;
        {
            let mut state = self.state();
            state.pending_binding = Some(PendingBinding {
                binding: binding.clone(),
            });
        }
        self.bump();
        if self
            .send_command(
                ProcessPipeCommand::BindOwner {
                    binding: binding.clone(),
                },
                true,
            )
            .await
            .is_err()
        {
            return Err(RemoteProcessError::UnknownOutcome);
        }
        let deadline = tokio::time::Instant::now() + BIND_WAIT;
        loop {
            let mut changed = self.tick.subscribe();
            {
                let state = self.state();
                if let Some(receipt) = &state.last_binding {
                    if receipt.binding_seq == binding.binding_seq
                        && receipt.owner == owner
                        && receipt.builtin_tasks_enabled == builtin_tasks_enabled
                    {
                        return Ok(receipt.clone());
                    }
                }
                if state.fault.is_some() {
                    return Err(RemoteProcessError::UnknownOutcome);
                }
            }
            match tokio::time::timeout_at(deadline, changed.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(RemoteProcessError::Unavailable),
                Err(_) => return Err(RemoteProcessError::UnknownOutcome),
            }
        }
    }

    // -- stdin -------------------------------------------------------------

    async fn send_input(self: &Arc<Self>, bytes: Vec<u8>) -> Result<usize, RemoteProcessError> {
        if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
            return Err(RemoteProcessError::LaunchRejected);
        }
        let _gate = self.write_gate.lock().await;
        let (owner, seq, generation) = self.reserve_input_seq(false)?;
        if !self.is_current_socket(generation).await {
            return Err(RemoteProcessError::Unavailable);
        }
        let envelope = ProcessInputV1::new(
            wire_key(&self.key),
            wire_owner(&owner),
            self.controller_id.clone(),
            seq,
            &bytes,
            false,
        )
        .map_err(|_| RemoteProcessError::LaunchRejected)?;
        let count = self.track_input(envelope.clone(), seq)?;
        self.bump();
        if self
            .send_command(ProcessPipeCommand::Input { input: envelope }, true)
            .await
            .is_err()
        {
            // Ambiguous: the node may or may not have the frame. Never a new seq.
            return Err(RemoteProcessError::UnknownOutcome);
        }
        self.await_input(seq, count, INPUT_WRITE_WAIT).await
    }

    async fn send_close(self: &Arc<Self>) -> Result<(), RemoteProcessError> {
        let _gate = self.write_gate.lock().await;
        if self.state().closed_stdin {
            return Ok(());
        }
        let (owner, seq, generation) = self.reserve_input_seq(true)?;
        if !self.is_current_socket(generation).await {
            return Err(RemoteProcessError::Unavailable);
        }
        let envelope = ProcessInputV1::new(
            wire_key(&self.key),
            wire_owner(&owner),
            self.controller_id.clone(),
            seq,
            &[],
            true,
        )
        .map_err(|_| RemoteProcessError::LaunchRejected)?;
        self.track_input(envelope.clone(), seq)?;
        self.state().closed_stdin = true;
        self.bump();
        self.send_command(ProcessPipeCommand::Input { input: envelope }, true)
            .await
            .map_err(|_| RemoteProcessError::UnknownOutcome)?;
        self.await_input(seq, 0, INPUT_WRITE_WAIT).await.map(|_| ())
    }

    /// Allocates the strictly next sequence, or refuses without any side effect.
    fn reserve_input_seq(
        &self,
        closing: bool,
    ) -> Result<(AgentRunOwner, u64, u64), RemoteProcessError> {
        let state = self.state();
        if state.fault.is_some() {
            return Err(RemoteProcessError::UnknownOutcome);
        }
        if state.closed_stdin && !closing {
            return Err(RemoteProcessError::Unavailable);
        }
        if state.ambiguous_input_seq.is_some() || state.pending_binding.is_some() {
            // No new sequence while an original write or bind is unresolved.
            return Err(RemoteProcessError::UnknownOutcome);
        }
        let live_inputs = state
            .pending_inputs
            .values()
            .filter(|entry| entry.state != InputState::Written)
            .count();
        if live_inputs >= MAX_PENDING_INPUTS {
            return Err(RemoteProcessError::Unavailable);
        }
        let Some(owner) = state.owner.clone() else {
            return Err(RemoteProcessError::Unavailable);
        };
        if !state.connected || state.ws_generation == 0 {
            return Err(RemoteProcessError::Unavailable);
        }
        let seq = state
            .next_input_seq
            .checked_add(1)
            .ok_or(RemoteProcessError::IdentityMismatch)?;
        if seq > MAX_SAFE_COUNTER {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        Ok((owner, seq, state.ws_generation))
    }

    fn track_input(
        self: &Arc<Self>,
        envelope: ProcessInputV1,
        seq: u64,
    ) -> Result<usize, RemoteProcessError> {
        let digest = envelope
            .envelope_digest()
            .map_err(|_| RemoteProcessError::LaunchRejected)?;
        let count = envelope
            .decode()
            .map_err(|_| RemoteProcessError::LaunchRejected)?
            .len();
        {
            let mut state = self.state();
            if state.ambiguous_input_seq.is_some() {
                return Err(RemoteProcessError::UnknownOutcome);
            }
            // Drop any stale leftover a cancelled waiter never collected.
            state
                .pending_inputs
                .retain(|_, entry| entry.state != InputState::Written);
            state.next_input_seq = seq;
            state.ambiguous_input_seq = Some(seq);
            state.pending_inputs.insert(
                seq,
                PendingInput {
                    envelope,
                    digest,
                    count,
                    state: InputState::Sent,
                },
            );
        }
        Ok(count)
    }

    async fn await_input(
        self: &Arc<Self>,
        seq: u64,
        count: usize,
        budget: Duration,
    ) -> Result<usize, RemoteProcessError> {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let mut changed = self.tick.subscribe();
            {
                let mut state = self.state();
                let observed = state
                    .pending_inputs
                    .get(&seq)
                    .map(|entry| (entry.state, entry.count));
                match observed {
                    Some((InputState::Written, observed_count)) => {
                        state.pending_inputs.remove(&seq);
                        drop(state);
                        self.bump();
                        // The receipt count is the number of pipe-written bytes.
                        // It is not a native-input acceptance receipt.
                        return Ok(observed_count);
                    }
                    Some((InputState::Unknown, _)) => {
                        return Err(RemoteProcessError::UnknownOutcome);
                    }
                    Some((InputState::Sent, _)) => {}
                    None => {
                        if state.written_input_seq >= seq {
                            return Ok(count);
                        }
                        return Err(RemoteProcessError::UnknownOutcome);
                    }
                }
                if state.fault.is_some() {
                    return Err(RemoteProcessError::UnknownOutcome);
                }
            }
            match tokio::time::timeout_at(deadline, changed.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(RemoteProcessError::Unavailable),
                Err(_) => {
                    // The original envelope stays pending and is replayed as-is.
                    return Err(RemoteProcessError::UnknownOutcome);
                }
            }
        }
    }

    // -- reconnect ---------------------------------------------------------

    /// Reconnect replay at the *new* socket generation. The controller, the
    /// original `Open` digest and the cached installation generation are kept
    /// exactly: a reconnect never re-admits a mutated CLI into a live Host.
    async fn replay(self: &Arc<Self>, generation: u64) {
        let (replay_open, open, inputs, binding) = {
            let state = self.state();
            let mut inputs: Vec<ProcessInputV1> = state
                .pending_inputs
                .values()
                .filter(|entry| entry.state != InputState::Written)
                .map(|entry| entry.envelope.clone())
                .collect();
            inputs.sort_by_key(|input| input.input_seq);
            (
                !state.replay_disabled,
                self.open.clone(),
                inputs,
                state
                    .pending_binding
                    .as_ref()
                    .map(|entry| entry.binding.clone()),
            )
        };
        if replay_open {
            let _ = self
                .send_command_generation(
                    generation,
                    ProcessPipeCommand::Open { launch: open },
                    true,
                )
                .await;
        }
        for input in inputs {
            let _ = self
                .send_command_generation(generation, ProcessPipeCommand::Input { input }, true)
                .await;
        }
        if let Some(binding) = binding {
            let _ = self
                .send_command_generation(
                    generation,
                    ProcessPipeCommand::BindOwner { binding },
                    true,
                )
                .await;
        }
        self.flush_stop().await;
        let after_event_seq = self.journal_highest().await;
        let _ = self
            .send_command_generation(
                generation,
                ProcessPipeCommand::Resume {
                    key: wire_key(&self.key),
                    controller_id: self.controller_id.clone(),
                    after_event_seq,
                },
                false,
            )
            .await;
        self.bump();
    }

    // -- control replies ---------------------------------------------------

    /// Returns `true` only for a matching `Released` receipt.
    async fn handle_reply(self: &Arc<Self>, reply: ProcessControlReply) -> bool {
        if reply.validate().is_err() {
            self.fault(PipeFault::ControlIdentity);
            return false;
        }
        match reply.body {
            ProcessControlBody::Opened {
                launch_digest,
                node_pid,
                materialization,
            } => {
                if launch_digest != self.open_digest || node_pid == 0 {
                    self.fault(PipeFault::OpenDigest);
                    return false;
                }
                // A bundled launch must prove the exact materialization it was
                // given. Only identity and a stable root are accepted: a node can
                // never inject prompt or argv text through this receipt.
                let expected = self
                    .open
                    .bundle
                    .as_ref()
                    .map(|bundle| (bundle.bundle_id.clone(), bundle.digest.clone()));
                match (&expected, &materialization) {
                    (None, None) => {}
                    (Some((bundle_id, bundle_digest)), Some(receipt)) => {
                        if &receipt.bundle_id != bundle_id
                            || &receipt.bundle_digest != bundle_digest
                            || receipt.skill_root.is_empty()
                        {
                            self.fault(PipeFault::OpenDigest);
                            return false;
                        }
                    }
                    // Missing materialization for a bundle, or materialization
                    // for an unbundled launch, is not a matching receipt.
                    _ => {
                        self.fault(PipeFault::OpenDigest);
                        return false;
                    }
                }
                // Plain copies first: no state guard is held while a fault or a
                // mutation runs below.
                let (previous_pid, retained) = {
                    let state = self.state();
                    (state.opened_pid, state.materialization.clone())
                };
                match previous_pid {
                    Some(previous) if previous != node_pid => {
                        self.fault(PipeFault::OpenDigest);
                        return false;
                    }
                    Some(_) => {
                        // Duplicate replay: the retained materialization root
                        // must be identical, never silently replaced.
                        if retained != materialization {
                            self.fault(PipeFault::OpenDigest);
                            return false;
                        }
                    }
                    None => {
                        let mut state = self.state();
                        state.opened_pid = Some(node_pid);
                        state.materialization = materialization;
                    }
                }
                self.bump();
                false
            }
            ProcessControlBody::InputWritten {
                input_seq,
                request_id,
                envelope_digest,
            } => {
                {
                    let mut state = self.state();
                    let mismatch = match state.pending_inputs.get(&input_seq) {
                        Some(entry) => {
                            entry.envelope.request_id != request_id
                                || entry.digest != envelope_digest
                        }
                        None => false,
                    };
                    if mismatch {
                        drop(state);
                        self.fault(PipeFault::ControlIdentity);
                        return false;
                    }
                    if let Some(entry) = state.pending_inputs.get_mut(&input_seq) {
                        entry.state = InputState::Written;
                        if input_seq > state.written_input_seq {
                            state.written_input_seq = input_seq;
                        }
                        if state.ambiguous_input_seq == Some(input_seq) {
                            // Confirmed: no longer an ambiguous original write.
                            state.ambiguous_input_seq = None;
                        }
                        state
                            .recent_inputs
                            .push_back((input_seq, request_id, envelope_digest));
                        while state.recent_inputs.len() > RECENT_INPUT_RECEIPTS {
                            state.recent_inputs.pop_front();
                        }
                    } else {
                        // A replayed receipt for an already-confirmed write is a
                        // duplicate: no advance, no fault, no owner change.
                        let duplicate = state.recent_inputs.iter().any(|entry| {
                            entry.0 == input_seq
                                && entry.1 == request_id
                                && entry.2 == envelope_digest
                        });
                        if !duplicate {
                            drop(state);
                            self.fault(PipeFault::ControlIdentity);
                            return false;
                        }
                    }
                }
                self.bump();
                false
            }
            ProcessControlBody::InputUnknown {
                input_seq,
                request_id,
                code: _,
            } => {
                {
                    let mut state = self.state();
                    if let Some(entry) = state.pending_inputs.get_mut(&input_seq) {
                        if entry.envelope.request_id == request_id {
                            entry.state = InputState::Unknown;
                        }
                    }
                }
                self.bump();
                false
            }
            ProcessControlBody::OwnerBound {
                request_id,
                binding_seq,
                owner,
                builtin_tasks_enabled,
                input_seq,
            } => {
                let mut accepted = false;
                {
                    let mut state = self.state();
                    // Wire-to-wire comparison only: no Core/wire owner mixup.
                    let pending_matches = match state.pending_binding.as_ref() {
                        Some(pending) => {
                            pending.binding.request_id == request_id
                                && pending.binding.binding_seq == binding_seq
                                && pending.binding.next_owner == owner
                                && pending.binding.builtin_tasks_enabled == builtin_tasks_enabled
                                && pending.binding.after_input_seq == input_seq
                        }
                        None => false,
                    };
                    if pending_matches {
                        let receipt = RemoteOwnerReceipt {
                            key: self.key.clone(),
                            binding_seq,
                            owner: owner.as_ref().map(core_owner),
                            builtin_tasks_enabled,
                            input_boundary_written: true,
                        };
                        // Keep the raw wire fields so an exact duplicate replay is
                        // idempotent instead of looking invented.
                        state.last_binding_wire = Some(LastBinding {
                            request_id: request_id.clone(),
                            binding_seq,
                            owner: owner.clone(),
                            builtin_tasks: builtin_tasks_enabled,
                            input_seq,
                        });
                        state.owner = receipt.owner.clone();
                        state.binding_seq = binding_seq;
                        state.builtin_tasks = builtin_tasks_enabled;
                        state.pending_binding = None;
                        state.last_binding = Some(receipt);
                        accepted = true;
                    } else if state.last_binding_wire.as_ref().is_some_and(|entry| {
                        entry.request_id == request_id
                            && entry.binding_seq == binding_seq
                            && entry.owner == owner
                            && entry.builtin_tasks == builtin_tasks_enabled
                            && entry.input_seq == input_seq
                    }) {
                        // Exact duplicate of an already accepted receipt: no
                        // advance, no owner change, no fault. A differing tasks
                        // flag is *not* this branch and cannot authorize.
                        accepted = true;
                    }
                }
                if !accepted {
                    // A stale receipt or the same sequence with a different owner
                    // never changes the authoritative owner.
                    self.fault(PipeFault::ControlIdentity);
                    return false;
                }
                self.bump();
                false
            }
            ProcessControlBody::Terminated {
                request_id,
                leader_exited,
                tree_stopped,
            } => {
                let queued = {
                    let state = self.state();
                    state
                        .stop_queue
                        .iter()
                        .any(|entry| entry.request_id == request_id)
                };
                if !queued {
                    self.fault(PipeFault::ControlIdentity);
                    return false;
                }
                {
                    let mut state = self.state();
                    if leader_exited && tree_stopped {
                        state.terminate_evidence = Some(TerminateEvidence {
                            request_id,
                            leader_exited,
                            tree_stopped,
                        });
                    } else {
                        // Never claim cleanup from a partial receipt.
                        state.terminate_evidence = None;
                    }
                }
                self.bump();
                false
            }
            ProcessControlBody::Released {
                request_id,
                final_event_seq,
                acked_event_seq,
                output_abandoned,
            } => {
                let expected = {
                    let state = self.state();
                    state
                        .pending_release
                        .as_ref()
                        .filter(|entry| entry.request_id == request_id)
                        .map(|entry| (entry.abandon_output, entry.acked_event_seq))
                };
                let Some((expected_abandon, expected_ack)) = expected else {
                    self.fault(PipeFault::ControlIdentity);
                    return false;
                };
                if expected_abandon != output_abandoned
                    || expected_ack != acked_event_seq
                    || (!expected_abandon && final_event_seq != expected_ack)
                {
                    self.fault(PipeFault::ControlIdentity);
                    return false;
                }
                let highest = self.journal_highest().await;
                if final_event_seq < highest {
                    // Releasing past the durable tail would drop evidence.
                    self.fault(PipeFault::ControlIdentity);
                    return false;
                }
                {
                    let mut state = self.state();
                    // The intent stays pending until the completion receipt is
                    // durable; `released` is set by the registry afterwards.
                    state.release_evidence = Some(ReleaseEvidence {
                        request_id,
                        final_event_seq,
                        acked_event_seq,
                        output_abandoned,
                    });
                }
                self.bump();
                true
            }
            ProcessControlBody::State { .. } => {
                // Informational only: never advances a cursor, never changes the
                // owner or the tasks flag, never authorizes cleanup and never
                // restores a parser.
                false
            }
            ProcessControlBody::Refused {
                request_id,
                code: _,
            } => {
                {
                    // Stable code only; no payload is kept or formatted. A refusal
                    // of an original write leaves it unresolved and fenced.
                    let mut state = self.state();
                    for entry in state.pending_inputs.values_mut() {
                        if request_id.as_ref() == Some(&entry.envelope.request_id) {
                            entry.state = InputState::Unknown;
                        }
                    }
                }
                self.bump();
                false
            }
        }
    }

    // -- evidence ----------------------------------------------------------

    fn cached_state(&self) -> RemoteProcessState {
        let terminal = self.journal_terminal_hint();
        if let Some(terminal) = terminal {
            return RemoteProcessState::Exited(RemoteExitReceipt {
                key: self.key.clone(),
                exit_code: terminal.exit_code,
                signal: terminal.signal,
            });
        }
        let state = self.state();
        if state.released || state.fault.is_some() {
            return RemoteProcessState::Unknown;
        }
        match (state.opened_pid.is_some(), state.connected) {
            (true, false) => RemoteProcessState::Unreachable,
            (true, true) => RemoteProcessState::Running,
            _ => RemoteProcessState::Starting,
        }
    }

    /// Non-blocking, best-effort read of the in-memory terminal summary.
    fn journal_terminal_hint(&self) -> Option<TerminalSummary> {
        match self.spool.try_lock() {
            Ok(spool) => spool.terminal().cloned(),
            Err(_) => None,
        }
    }

    /// Exit evidence comes from the durable `Exited` record only. It resolves
    /// whether or not a consumer ever read stdout/stderr: unread retained bytes
    /// are evidence, not a precondition.
    async fn wait_exit(self: &Arc<Self>) -> Result<RemoteExitReceipt, RemoteProcessError> {
        loop {
            let mut changed = self.tick.subscribe();
            let terminal = self.journal_terminal().await;
            match terminal {
                Some(terminal) => {
                    return Ok(RemoteExitReceipt {
                        key: self.key.clone(),
                        exit_code: terminal.exit_code,
                        signal: terminal.signal,
                    });
                }
                None => {
                    let state = self.state();
                    if state.released || state.fault.is_some() {
                        return Err(RemoteProcessError::UnknownOutcome);
                    }
                }
            }
            if changed.changed().await.is_err() {
                return Err(RemoteProcessError::Unavailable);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

struct OrphanRecord {
    key: RemoteProcessKey,
    identity: JournalIdentity,
    state: OrphanState,
    highest_received_seq: u64,
    journal_output_abandoned: bool,
    terminal: Option<TerminalSummary>,
    stop_request_id: String,
    release_request_id: String,
    stop_sent: StdMutex<bool>,
    release_sent: StdMutex<bool>,
    released: StdMutex<bool>,
}

impl fmt::Debug for OrphanRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OrphanRecord")
            .field("key", &self.key)
            .field("state", &self.state)
            .field("highest_received_seq", &self.highest_received_seq)
            .field("journal_output_abandoned", &self.journal_output_abandoned)
            .field("terminal", &self.terminal.is_some())
            .finish_non_exhaustive()
    }
}

/// Bounded, payload-free control receipt. The retained spool journal is
/// read-only for anything this module did not create, so this is the only
/// durable place an abandon decision or a released key can be recorded.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlReceipt {
    /// `orphan` or `release`.
    kind: String,
    key: WireKey,
    controller_id: String,
    launch_digest: String,
    abandon_output: bool,
    /// `intent` before the wire command, `released` after the matching receipt.
    phase: String,
    request_id: String,
    final_event_seq: u64,
    acked_event_seq: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlLog {
    version: u32,
    receipts: Vec<ControlReceipt>,
}

impl ControlLog {
    fn empty() -> Self {
        Self {
            version: CONTROL_RECEIPTS_VERSION,
            receipts: Vec::new(),
        }
    }

    /// A key whose release completion is durable was already handed back.
    fn release_completed(&self, key: &WireKey, launch_digest: &str) -> bool {
        self.receipts.iter().any(|receipt| {
            receipt.phase == "released"
                && &receipt.key == key
                && receipt.launch_digest == launch_digest
        })
    }
}

/// Payload-free orphan evidence for the parent. No bytes, no argv, no env.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OrphanReport {
    pub key: RemoteProcessKey,
    pub controller_id: String,
    pub launch_digest: String,
    pub state: OrphanState,
    pub highest_received_seq: u64,
    pub journal_output_abandoned: bool,
    pub wire_abandon_recorded: bool,
    pub released: bool,
    pub note: &'static str,
}

pub(crate) struct PipeRegistry {
    hub: Weak<Hub>,
    root: PathBuf,
    controller_id: String,
    live: StdMutex<HashMap<RemoteProcessKey, Arc<LivePipe>>>,
    orphans: StdMutex<HashMap<RemoteProcessKey, Arc<OrphanRecord>>>,
    receipts: StdMutex<ControlLog>,
}

impl fmt::Debug for PipeRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PipeRegistry")
            .field("controller_id", &self.controller_id)
            .field("live", &lock(&self.live).len())
            .field("orphans", &lock(&self.orphans).len())
            .finish_non_exhaustive()
    }
}

/// Armed by the launcher before `Open` can leave this process: a dropped start
/// future marks the pipe non-replayable and queues a stop, once.
pub(crate) struct StartGuard {
    registry: Arc<PipeRegistry>,
    key: RemoteProcessKey,
    digest: String,
    armed: bool,
}

impl StartGuard {
    fn new(registry: Arc<PipeRegistry>, key: RemoteProcessKey, digest: String) -> Self {
        Self {
            registry,
            key,
            digest,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // No await: disable `Open` replay immediately and queue the stop.
        Arc::clone(&self.registry).abort_start(&self.key, &self.digest);
    }
}

impl PipeRegistry {
    /// Synchronous, bounded private journal scan. Nothing is created, deleted or
    /// adopted; a corrupt child is preserved and simply not reported.
    pub(crate) fn new(hub: Weak<Hub>, data_dir: &Path) -> Result<Arc<Self>, &'static str> {
        let root = data_dir.join(PIPE_ROOT);
        rovai_private_storage::prepare_private_directory(&root).map_err(|_| "pipe_storage")?;
        let controller_id = format!("ctl{}", uuid::Uuid::new_v4().simple());
        let receipts = read_control_log(&root);
        let mut orphans: HashMap<RemoteProcessKey, Arc<OrphanRecord>> = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&root) {
            let mut scanned = 0usize;
            for entry in entries.flatten() {
                scanned += 1;
                if scanned > MAX_ORPHAN_SCAN || orphans.len() >= MAX_ORPHAN_RECORDS {
                    break;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if !name.starts_with("spool-") {
                    continue;
                }
                let Ok(journal) = spool::inspect_directory(&root, &name) else {
                    continue;
                };
                let Ok(key) = core_key(journal.identity().key()) else {
                    continue;
                };
                let short: String = journal
                    .identity()
                    .launch_digest()
                    .chars()
                    .take(16)
                    .collect();
                // A durable release completion means this key was already handed
                // back. Report that honestly and never adopt it.
                let already_released = receipts.release_completed(
                    journal.identity().key(),
                    journal.identity().launch_digest(),
                );
                let record = Arc::new(OrphanRecord {
                    key: key.clone(),
                    identity: journal.identity().clone(),
                    state: journal.state(),
                    highest_received_seq: journal.highest_received_seq(),
                    journal_output_abandoned: journal.output_abandoned(),
                    terminal: journal.terminal().cloned(),
                    stop_request_id: format!("orphan-stop.{short}"),
                    release_request_id: format!("orphan-rel.{short}"),
                    stop_sent: StdMutex::new(false),
                    release_sent: StdMutex::new(false),
                    released: StdMutex::new(already_released),
                });
                orphans.insert(key, record);
            }
        }
        Ok(Arc::new(Self {
            hub,
            root,
            controller_id,
            live: StdMutex::new(HashMap::new()),
            orphans: StdMutex::new(orphans),
            receipts: StdMutex::new(receipts),
        }))
    }

    /// Stable per Web process; preserved across a socket reconnect, never
    /// reused by a new controller. Parent seam.
    #[allow(dead_code)]
    pub(crate) fn controller_id(&self) -> &str {
        &self.controller_id
    }

    /// Private journal root; exposed for diagnostics and tests only.
    #[allow(dead_code)]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn get(&self, key: &RemoteProcessKey) -> Option<Arc<LivePipe>> {
        lock(&self.live).get(key).cloned()
    }

    fn pipes_for(&self, node_id: &str) -> Vec<Arc<LivePipe>> {
        lock(&self.live)
            .values()
            .filter(|pipe| pipe.key.node_id == node_id)
            .cloned()
            .collect()
    }

    fn orphans_for(&self, node_id: &str) -> Vec<Arc<OrphanRecord>> {
        lock(&self.orphans)
            .values()
            .filter(|orphan| orphan.key.node_id == node_id)
            .cloned()
            .collect()
    }

    pub(crate) fn orphan_reports(&self) -> Vec<OrphanReport> {
        let wired = lock(&self.receipts).receipts.clone();
        lock(&self.orphans)
            .values()
            .map(|orphan| {
                let released = *lock(&orphan.released);
                let wire_abandon_recorded = wired.iter().any(|receipt| {
                    receipt.kind == "orphan"
                        && receipt.key == wire_key(&orphan.key)
                        && receipt.abandon_output
                        && receipt.launch_digest == orphan.identity.launch_digest()
                        && receipt.phase == "intent"
                });
                OrphanReport {
                    key: orphan.key.clone(),
                    controller_id: orphan.identity.controller_id().to_owned(),
                    launch_digest: orphan.identity.launch_digest().to_owned(),
                    state: orphan.state,
                    highest_received_seq: orphan.highest_received_seq,
                    journal_output_abandoned: orphan.journal_output_abandoned,
                    wire_abandon_recorded,
                    released,
                    // The retained journal cannot be mutated by a new controller:
                    // report the limitation instead of faking a marker.
                    note: "orphan_journal_read_only_no_marker",
                }
            })
            .collect()
    }

    /// Core's typed builtin relay: B owns local IPC credentials, A receives only
    /// a typed operation scoped to a currently bound process lease.
    ///
    /// Rejections are stable codes only. Nothing from the wire is treated as Core
    /// authority, and the tasks flag is deliberately not re-judged here: Core's
    /// operation-specific policy owns that meaning.
    pub(crate) fn authorize_builtin(
        &self,
        node_id: &str,
        generation: u64,
        call: &BuiltinCallV1,
    ) -> Result<RemoteBuiltinInvocation, &'static str> {
        call.validate().map_err(|_| "builtin_pipe_invalid")?;
        if call.key.node_id != node_id {
            return Err("builtin_pipe_node");
        }
        let key = core_key(&call.key).map_err(|_| "builtin_pipe_identity")?;
        let pipe = self.get(&key).ok_or("builtin_pipe_unknown")?;
        if pipe.key.node_id != node_id {
            return Err("builtin_pipe_node");
        }
        let state = pipe.state();
        if state.released {
            return Err("builtin_pipe_released");
        }
        if state.fault.is_some() {
            return Err("builtin_pipe_faulted");
        }
        if state.replay_disabled {
            // A dropped start never becomes a caller.
            return Err("builtin_pipe_aborted");
        }
        if generation == 0 || !state.connected || state.ws_generation != generation {
            return Err("builtin_pipe_generation");
        }
        if state.opened_pid.is_none() {
            return Err("builtin_pipe_not_open");
        }
        if state.pending_binding.is_some() {
            return Err("builtin_pipe_binding");
        }
        let Some(owner) = state.owner.clone() else {
            return Err("builtin_pipe_unbound");
        };
        if owner != core_owner(&call.owner) || state.binding_seq != call.binding_seq {
            return Err("builtin_pipe_owner");
        }
        let body = BuiltinToolIpcRequestBody::Invoke {
            request_id: call.request_id.clone(),
            operation: call.operation.clone(),
            input: call.input.clone(),
            send_input_file_path: call.send_input_file_path.clone(),
        };
        Ok(RemoteBuiltinInvocation {
            process: key,
            owner,
            binding_seq: state.binding_seq,
            body,
        })
    }

    // -- socket entry points -----------------------------------------------
    pub(crate) async fn on_output(
        self: &Arc<Self>,
        node_id: &str,
        generation: u64,
        event: ProcessOutputEvent,
    ) {
        let Ok(key) = core_key(&event.key) else {
            return;
        };
        let Some(pipe) = self.get(&key) else {
            return;
        };
        if pipe.key.node_id != node_id
            || !pipe.accepts_generation(generation)
            || event.key != wire_key(&pipe.key)
        {
            return;
        }
        if !pipe.is_current_socket(generation).await {
            // Fence a retired socket before any durable work or ACK.
            return;
        }
        if pipe.enqueue_output(generation, event) {
            let worker = Arc::clone(&pipe);
            tokio::spawn(async move { worker.output_worker().await });
        }
    }

    pub(crate) async fn on_reply(
        self: &Arc<Self>,
        node_id: &str,
        generation: u64,
        reply: ProcessControlReply,
    ) {
        let Ok(key) = core_key(&reply.key) else {
            return;
        };
        let Some(pipe) = self.get(&key) else {
            self.on_orphan_reply(node_id, reply).await;
            return;
        };
        if pipe.key.node_id != node_id || !pipe.accepts_generation(generation) {
            return;
        }
        let released = pipe.handle_reply(reply).await;
        if released {
            // Persist the completion *before* treating the key as released: a
            // restart must see real evidence, not a memory-only claim.
            let evidence = {
                let state = pipe.state();
                state.release_evidence.as_ref().map(|evidence| {
                    (
                        evidence.request_id.clone(),
                        evidence.final_event_seq,
                        evidence.acked_event_seq,
                        evidence.output_abandoned,
                    )
                })
            };
            let Some((request_id, final_event_seq, acked_event_seq, output_abandoned)) = evidence
            else {
                return;
            };
            let completion = ControlReceipt {
                kind: "release".into(),
                key: wire_key(&pipe.key),
                controller_id: pipe.controller_id.clone(),
                launch_digest: pipe.open_digest.clone(),
                abandon_output: output_abandoned,
                phase: "released".into(),
                request_id,
                final_event_seq,
                acked_event_seq,
            };
            if self.record_control_receipt(completion).await.is_err() {
                // Keep the entry live: an unpersisted completion is not evidence.
                return;
            }
            {
                let mut state = pipe.state();
                state.pending_release = None;
                state.released = true;
            }
            pipe.bump();
            // Only a durable matching receipt frees the bounded live slot; the
            // journal directory stays on disk as retained evidence.
            lock(&self.live).remove(&key);
        }
    }

    pub(crate) async fn node_connected(self: &Arc<Self>, node_id: &str, generation: &u64) {
        let generation = *generation;
        if generation == 0 {
            return;
        }
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        if !hub.current_connection(node_id, generation).await {
            return;
        }
        for pipe in self.pipes_for(node_id) {
            if pipe.attach_generation(generation) {
                pipe.replay(generation).await;
            }
        }
        self.drive_orphans(node_id).await;
    }

    pub(crate) async fn node_disconnected(self: &Arc<Self>, node_id: &str, generation: u64) {
        for pipe in self.pipes_for(node_id) {
            pipe.detach_generation(generation);
        }
    }

    // -- lifecycle ---------------------------------------------------------

    /// Starts one pipe: journal first (durable), then exactly one `Open`.
    async fn begin_pipe(
        self: &Arc<Self>,
        open: ProcessOpenV1,
        host_scope: RemoteHostScope,
        guard: &mut StartGuard,
    ) -> Result<Arc<LivePipe>, RemoteProcessError> {
        open.validate()
            .map_err(|_| RemoteProcessError::LaunchRejected)?;
        let key = core_key(&open.key)?;
        let digest = open
            .digest()
            .map_err(|_| RemoteProcessError::LaunchRejected)?;
        if open.session.controller_id != self.controller_id {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        if guard.digest != digest || guard.key != key {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        {
            let live = lock(&self.live);
            if live.contains_key(&key) {
                // One pipe, one process, one reader set: never a second start.
                return Err(RemoteProcessError::Unavailable);
            }
            if live.len() >= MAX_LIVE_PIPES {
                return Err(RemoteProcessError::Unavailable);
            }
            if lock(&self.orphans).contains_key(&key) {
                // Retained evidence: no second journal, no adoption.
                return Err(RemoteProcessError::UnknownOutcome);
            }
        }
        // The *socket* generation of a live, pipe-capable node with the exact
        // native path/image identity and installation generation, resolved
        // before the journal exists and before `Open` can be sent. It is a
        // connection fence only: the installation generation stays in the
        // immutable `Open` and is never substituted by this number.
        let socket_generation = {
            let hub = self.hub.upgrade().ok_or(RemoteProcessError::Unavailable)?;
            hub.process_connection_generation(&open)
                .await
                .map_err(|_| RemoteProcessError::Unavailable)?
        };
        let identity =
            JournalIdentity::new(wire_key(&key), self.controller_id.clone(), digest.clone())
                .map_err(|_| RemoteProcessError::Unavailable)?;
        let root = self.root.clone();
        let created = tokio::task::spawn_blocking(move || Spool::create(&root, identity)).await;
        let spool = match created {
            Ok(Ok(spool)) => Arc::new(AsyncMutex::new(spool)),
            Ok(Err(SpoolError::JournalExists)) => {
                return Err(RemoteProcessError::UnknownOutcome);
            }
            _ => return Err(RemoteProcessError::Unavailable),
        };
        let pipe = Arc::new(LivePipe {
            key: key.clone(),
            host_scope,
            install_generation: open.catalog_generation,
            open: open.clone(),
            open_digest: digest,
            node_id: key.node_id.clone(),
            controller_id: self.controller_id.clone(),
            hub: self.hub.clone(),
            spool,
            inbound: StdMutex::new(Inbound {
                queue: VecDeque::new(),
                worker_running: false,
            }),
            state: StdMutex::new(PipeState {
                // Already attached to the actual current socket, so the first
                // `Opened` receipt is accepted instead of being fenced out.
                ws_generation: socket_generation,
                connected: true,
                opened_pid: None,
                // Open owns owner sequence zero: the launch owner is the
                // authoritative initial owner, not an inferred one.
                owner: Some(core_owner(&open.owner)),
                binding_seq: 0,
                builtin_tasks: open.builtin_tasks_enabled,
                next_input_seq: 0,
                written_input_seq: 0,
                ambiguous_input_seq: None,
                pending_inputs: HashMap::new(),
                recent_inputs: VecDeque::new(),
                pending_binding: None,
                last_binding: None,
                last_binding_wire: None,
                materialization: None,
                stop_counter: 0,
                stop_queue: VecDeque::new(),
                terminate_evidence: None,
                release_counter: 0,
                pending_release: None,
                release_evidence: None,
                released: false,
                closed_stdin: false,
                output_abandoned: false,
                capture_incomplete: false,
                dropped_upto: None,
                acked_seq: 0,
                resume_requested: false,
                resume_in_flight: false,
                replay_disabled: false,
                fault: None,
            }),
            write_gate: AsyncMutex::new(()),
            tick: watch::channel(0u64).0,
            consumer_gone: AtomicU8::new(0),
        });
        {
            let mut live = lock(&self.live);
            if live.len() >= MAX_LIVE_PIPES || live.contains_key(&key) {
                return Err(RemoteProcessError::Unavailable);
            }
            // Registered before `Open`, so a dropped start future can find it.
            live.insert(key.clone(), Arc::clone(&pipe));
        }
        if pipe
            .send_command_generation(
                socket_generation,
                ProcessPipeCommand::Open {
                    launch: open.clone(),
                },
                true,
            )
            .await
            .is_err()
        {
            pipe.fault(PipeFault::ControlIdentity);
            return Err(RemoteProcessError::UnknownOutcome);
        }
        Self::wait_opened(&pipe, OPEN_WAIT).await?;
        Ok(pipe)
    }

    async fn wait_opened(pipe: &Arc<LivePipe>, budget: Duration) -> Result<(), RemoteProcessError> {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let mut changed = pipe.tick.subscribe();
            {
                let state = pipe.state();
                if state.opened_pid.is_some() {
                    return Ok(());
                }
                if state.fault.is_some() {
                    return Err(RemoteProcessError::UnknownOutcome);
                }
            }
            match tokio::time::timeout_at(deadline, changed.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(RemoteProcessError::Unavailable),
                Err(_) => return Err(RemoteProcessError::UnknownOutcome),
            }
        }
    }

    /// A dropped start future may never respawn: disable `Open` replay at once
    /// and queue a stop. No await, no claim of success.
    fn abort_start(self: Arc<Self>, key: &RemoteProcessKey, digest: &str) {
        let Some(pipe) = self.get(key) else {
            return;
        };
        if pipe.open_digest != digest {
            return;
        }
        pipe.disable_replay();
        if pipe
            .queue_stop(RemoteTerminationMode::Force, STOP_BUDGET_FORCE_MS)
            .is_ok()
        {
            self.clone().spawn_drive_stop(&pipe);
        }
    }

    fn spawn_drive_stop(self: Arc<Self>, pipe: &Arc<LivePipe>) {
        let pipe = Arc::clone(pipe);
        let registry = self;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                pipe.flush_stop().await;
                let request_id = {
                    let state = pipe.state();
                    state
                        .stop_queue
                        .iter()
                        .find(|entry| entry.mode == RemoteTerminationMode::Force)
                        .map(|entry| entry.request_id.clone())
                };
                let Some(request_id) = request_id else {
                    return;
                };
                // Bounded; an unconfirmed stop stays recorded and replayable.
                if pipe.await_stop(&request_id, STOP_REAP_WAIT).await.is_ok() {
                    registry.release_after_stop(&pipe).await;
                }
            });
        }
    }

    /// Frees a bounded live slot only after a positive tree receipt. A normal
    /// release is refused when the tail is incomplete; in that case the loss is
    /// recorded durably first and only then released as an abandon.
    async fn release_after_stop(self: Arc<Self>, pipe: &Arc<LivePipe>) {
        let complete = pipe.journal_terminal().await.is_some() && !pipe.state().capture_incomplete;
        let _ = self.release_pipe(Arc::clone(pipe), !complete).await;
    }

    pub(crate) async fn release(
        self: &Arc<Self>,
        key: &RemoteProcessKey,
        abandon: bool,
    ) -> Result<(), RemoteProcessError> {
        let Some(pipe) = self.get(key) else {
            return Err(RemoteProcessError::Unavailable);
        };
        self.release_pipe(pipe, abandon).await
    }

    /// A normal release needs a durable terminal whose highest sequence was
    /// ACKed; unread retained bytes stay on disk and never block it. Abandoning
    /// needs an explicit request plus a positive tree receipt, and the durable
    /// incomplete marker is written *before* the wire `Release`.
    async fn release_pipe(
        self: &Arc<Self>,
        pipe: Arc<LivePipe>,
        abandon: bool,
    ) -> Result<(), RemoteProcessError> {
        {
            let state = pipe.state();
            if state.released {
                return Ok(());
            }
        }
        let stop_confirmed = pipe.state().terminate_evidence.is_some();
        let terminal = pipe.journal_terminal().await;
        let highest = pipe.journal_highest().await;
        if abandon {
            if !stop_confirmed {
                // Only a positive `Terminated` may precede an abandon release.
                return Err(RemoteProcessError::CleanupUnconfirmed);
            }
            pipe.mark_output_abandoned().await?;
        } else {
            if terminal.is_none() {
                // No durable exit evidence: this is not a normal release.
                return Err(RemoteProcessError::CleanupUnconfirmed);
            }
            if pipe.state().capture_incomplete {
                // A tail event was lost before it could be journalled. That is
                // never a complete output stream: the caller must request an
                // explicit abandon instead of a normal release.
                return Err(RemoteProcessError::UnknownOutcome);
            }
        }
        // An ACK queued on a previous socket may have been lost. Replay the
        // durable cursor on the exact socket used for Release, in normal FIFO
        // order, for both complete capture and explicit output abandonment.
        let generation = pipe.state().ws_generation;
        if !pipe.ack(generation, highest).await {
            return Err(RemoteProcessError::Unavailable);
        }
        let request_id = {
            let mut state = pipe.state();
            let counter = state
                .release_counter
                .checked_add(1)
                .ok_or(RemoteProcessError::IdentityMismatch)?;
            state.release_counter = counter;
            let request_id = format!("rel.{counter}");
            state.pending_release = Some(QueuedRelease {
                request_id: request_id.clone(),
                abandon_output: abandon,
                acked_event_seq: highest,
            });
            request_id
        };
        pipe.bump();
        // Durable release intent *before* the wire command: a restart must be
        // able to see that this key was already released, and never adopt it.
        let intent = ControlReceipt {
            kind: "release".into(),
            key: wire_key(&pipe.key),
            controller_id: pipe.controller_id.clone(),
            launch_digest: pipe.open_digest.clone(),
            abandon_output: abandon,
            phase: "intent".into(),
            request_id: request_id.clone(),
            final_event_seq: highest,
            acked_event_seq: highest,
        };
        if self.record_control_receipt(intent).await.is_err() {
            // No durable intent: do not send a Release we cannot account for.
            return Err(RemoteProcessError::UnknownOutcome);
        }
        if pipe
            .send_command_generation(
                generation,
                ProcessPipeCommand::Release {
                    key: wire_key(&pipe.key),
                    controller_id: pipe.controller_id.clone(),
                    request_id: request_id.clone(),
                    acked_event_seq: highest,
                    abandon_output: abandon,
                },
                true,
            )
            .await
            .is_err()
        {
            return Err(RemoteProcessError::UnknownOutcome);
        }
        let deadline = tokio::time::Instant::now() + RELEASE_WAIT;
        loop {
            let mut changed = pipe.tick.subscribe();
            {
                let state = pipe.state();
                // `released` is set only after the completion receipt is durable
                // and the live entry is removed (`on_reply`).
                if state.released {
                    return Ok(());
                }
                if state.fault.is_some() {
                    return Err(RemoteProcessError::UnknownOutcome);
                }
            }
            match tokio::time::timeout_at(deadline, changed.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(RemoteProcessError::Unavailable),
                Err(_) => return Err(RemoteProcessError::DeadlineExceeded),
            }
        }
    }

    // -- orphans -----------------------------------------------------------

    /// Always requests a bounded terminate, even for a drained journal: an
    /// `Exited` record never proves the descendants are gone.
    async fn drive_orphans(self: &Arc<Self>, node_id: &str) {
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        for orphan in self.orphans_for(node_id) {
            if *lock(&orphan.released) {
                continue;
            }
            {
                let mut sent = lock(&orphan.stop_sent);
                if *sent {
                    continue;
                }
                *sent = true;
            }
            let command = ProcessPipeCommand::Terminate {
                key: wire_key(&orphan.key),
                request_id: orphan.stop_request_id.clone(),
                budget_ms: ORPHAN_STOP_BUDGET_MS,
            };
            if hub
                .send_node_message(node_id, ServerMessage::ProcessPipe { command }, true)
                .await
                .is_err()
            {
                // Not delivered: allow a replay on the next connect.
                *lock(&orphan.stop_sent) = false;
            }
        }
    }

    async fn on_orphan_reply(self: &Arc<Self>, node_id: &str, reply: ProcessControlReply) {
        if reply.validate().is_err() {
            return;
        }
        let Ok(key) = core_key(&reply.key) else {
            return;
        };
        let orphan = { lock(&self.orphans).get(&key).cloned() };
        let Some(orphan) = orphan else {
            return;
        };
        if orphan.key.node_id != node_id || *lock(&orphan.released) {
            return;
        }
        let ProcessControlBody::Terminated {
            request_id,
            leader_exited,
            tree_stopped,
        } = &reply.body
        else {
            return;
        };
        if *request_id != orphan.stop_request_id || !*leader_exited || !*tree_stopped {
            // No positive tree receipt: never release, never claim cleanup.
            return;
        }
        {
            let mut sent = lock(&orphan.release_sent);
            if *sent {
                return;
            }
            *sent = true;
        }
        let highest = orphan.highest_received_seq;
        // The retained orphan journal is read-only, so the abandon decision is
        // recorded durably in the separate bounded receipt journal first.
        let decision = ControlReceipt {
            kind: "orphan".into(),
            key: wire_key(&orphan.key),
            controller_id: orphan.identity.controller_id().to_owned(),
            launch_digest: orphan.identity.launch_digest().to_owned(),
            abandon_output: true,
            phase: "intent".into(),
            request_id: orphan.release_request_id.clone(),
            final_event_seq: highest,
            acked_event_seq: highest,
        };
        if self.record_control_receipt(decision).await.is_err() {
            // Cannot persist: stop only, leave the key unknown, never release.
            *lock(&orphan.release_sent) = false;
            return;
        }
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        let command = ProcessPipeCommand::Release {
            key: wire_key(&orphan.key),
            // The retired owner is the controller recorded in the journal.
            controller_id: orphan.identity.controller_id().to_owned(),
            request_id: orphan.release_request_id.clone(),
            acked_event_seq: highest,
            abandon_output: true,
        };
        if hub
            .send_node_message(node_id, ServerMessage::ProcessPipe { command }, true)
            .await
            .is_err()
        {
            *lock(&orphan.release_sent) = false;
        }
    }

    async fn record_control_receipt(&self, receipt: ControlReceipt) -> Result<(), ()> {
        let path = self.root.join(CONTROL_RECEIPTS);
        let log = {
            let mut log = lock(&self.receipts).clone();
            log.receipts.push(receipt);
            while log.receipts.len() > MAX_CONTROL_RECEIPTS {
                log.receipts.remove(0);
            }
            log
        };
        let bytes = serde_json::to_vec(&log).map_err(|_| ())?;
        if bytes.len() > MAX_CONTROL_RECEIPT_BYTES {
            return Err(());
        }
        let written = tokio::task::spawn_blocking(move || {
            rovai_private_storage::atomic_write_private_bytes(&path, &bytes)
        })
        .await
        .map_err(|_| ())?;
        written.map_err(|_| ())?;
        *lock(&self.receipts) = log;
        Ok(())
    }
}

fn read_control_log(root: &Path) -> ControlLog {
    #[cfg(any(unix, windows))]
    {
        use std::io::Read;
        let path = root.join(CONTROL_RECEIPTS);
        let Ok(file) = rovai_private_storage::open_private_read_file(&path) else {
            return ControlLog::empty();
        };
        let mut bytes = Vec::new();
        if Read::take(file, MAX_CONTROL_RECEIPT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() > MAX_CONTROL_RECEIPT_BYTES
        {
            return ControlLog::empty();
        }
        match serde_json::from_slice::<ControlLog>(&bytes) {
            Ok(log) if log.version == CONTROL_RECEIPTS_VERSION => log,
            _ => ControlLog::empty(),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = root;
        ControlLog::empty()
    }
}

// ---------------------------------------------------------------------------
// Launcher + control
// ---------------------------------------------------------------------------

pub struct HubLauncher {
    hub: Arc<Hub>,
    registry: Arc<PipeRegistry>,
}

impl HubLauncher {
    pub fn new(hub: Arc<Hub>, registry: Arc<PipeRegistry>) -> Self {
        Self { hub, registry }
    }

    pub fn hub(&self) -> Arc<Hub> {
        Arc::clone(&self.hub)
    }
}

pub(crate) struct HubControl {
    pipe: Arc<LivePipe>,
    registry: Arc<PipeRegistry>,
}

impl fmt::Debug for HubControl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HubControl")
            .field("pipe", &self.pipe)
            .finish()
    }
}

/// Verified open receipt evidence, built from existing wire types only and free
/// of argv, environment, bundle bodies and prompt text.
#[allow(dead_code)] // Consumed by the parent/Core typed receipt API once it lands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpenedReceipt {
    pub node_pid: u32,
    pub materialization: Option<BundleMaterializationV1>,
}

#[allow(dead_code)] // Integration seam; see the TODO below.
impl HubControl {
    /// Verified `Opened` evidence for this key, if any.
    ///
    /// The bundle materialization itself is delivered to Core through
    /// `RemoteProcess::set_bundle_materialization` during `start`; this accessor
    /// keeps the verified `node_pid` and the retained root available as
    /// payload-free evidence. No Core module is edited for it.
    pub(crate) fn opened_receipt(&self) -> Option<OpenedReceipt> {
        let state = self.pipe.state();
        Some(OpenedReceipt {
            node_pid: state.opened_pid?,
            materialization: state.materialization.clone(),
        })
    }
}

impl RemoteProcessLauncher for HubLauncher {
    fn start(&self, launch: ScopedRemoteLaunch) -> RemoteFuture<'_, RemoteProcess> {
        Box::pin(async move {
            launch.validate()?;
            let open = open_from_launch(&launch, self.registry.controller_id())?;
            // Frozen Core authority first: a live pipe-capable node with the exact
            // native identity/installation generation, then the persisted
            // idempotent workspace preparation. No bypass or local substitute.
            self.hub
                .store
                .revalidate_remote_launch(&launch)
                .map_err(|_| RemoteProcessError::Unavailable)?;
            self.hub
                .ensure_remote_workspace(&launch)
                .await
                .map_err(|_| RemoteProcessError::Unavailable)?;
            let digest = open
                .digest()
                .map_err(|_| RemoteProcessError::LaunchRejected)?;
            // Armed before `Open` can leave this process.
            let mut guard = StartGuard::new(Arc::clone(&self.registry), launch.key.clone(), digest);
            let pipe = self
                .registry
                .begin_pipe(open, launch.host_scope.clone(), &mut guard)
                .await?;
            let mut process = RemoteProcess::new(
                launch.key.clone(),
                launch.host_scope.clone(),
                Box::new(PipeStdin::new(Arc::clone(&pipe))),
                Box::new(PipeReader::new(Arc::clone(&pipe), PipeStream::Stdout)),
                Box::new(PipeReader::new(Arc::clone(&pipe), PipeStream::Stderr)),
                Arc::new(HubControl {
                    pipe: Arc::clone(&pipe),
                    registry: Arc::clone(&self.registry),
                }),
            )?;
            // A bundled launch hands Core the exact verified materialization
            // (identity + stable root only; a Node never supplies prompt text).
            // Core validates it against its own frozen bundle, and the start
            // guard is disarmed only after that succeeds.
            if let Some(bundle) = launch.bundle.as_ref() {
                let verified = pipe
                    .state()
                    .materialization
                    .clone()
                    .ok_or(RemoteProcessError::MaterializationRejected)?;
                process.set_bundle_materialization(
                    RemoteBundleMaterialization {
                        bundle_id: verified.bundle_id,
                        bundle_digest: verified.bundle_digest,
                        skill_root: verified.skill_root,
                    },
                    bundle,
                )?;
            }
            guard.disarm();
            Ok(process)
        })
    }
}

impl RemoteProcessControl for HubControl {
    fn key(&self) -> &RemoteProcessKey {
        &self.pipe.key
    }

    fn host_scope(&self) -> &RemoteHostScope {
        &self.pipe.host_scope
    }

    fn cached_state(&self) -> RemoteProcessState {
        self.pipe.cached_state()
    }

    fn cached_termination(&self) -> Option<RemoteTerminationReceipt> {
        // Only a verified explicit `Terminated` receipt populates this.
        let state = self.pipe.state();
        let evidence = state.terminate_evidence.as_ref()?;
        if !evidence.leader_exited || !evidence.tree_stopped {
            return None;
        }
        Some(RemoteTerminationReceipt {
            key: self.pipe.key.clone(),
            leader_exited: true,
            tree_stopped: true,
        })
    }

    fn wait_exit(&self) -> RemoteFuture<'_, RemoteExitReceipt> {
        let pipe = Arc::clone(&self.pipe);
        Box::pin(async move { pipe.wait_exit().await })
    }

    fn bind_owner(
        &self,
        owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool,
    ) -> RemoteFuture<'_, RemoteOwnerReceipt> {
        let pipe = Arc::clone(&self.pipe);
        Box::pin(async move { pipe.bind(owner, builtin_tasks_enabled).await })
    }

    fn request_stop(&self, mode: RemoteTerminationMode) -> Result<(), RemoteProcessError> {
        // Sync and non-blocking: the durable, replayable command is queued now.
        self.pipe.queue_stop(mode, default_stop_budget(mode))?;
        self.registry.clone().spawn_drive_stop(&self.pipe);
        Ok(())
    }

    fn terminate(
        &self,
        mode: RemoteTerminationMode,
        budget: Duration,
    ) -> RemoteFuture<'_, RemoteTerminationReceipt> {
        let pipe = Arc::clone(&self.pipe);
        Box::pin(async move { pipe.terminate(mode, budget).await })
    }
}
