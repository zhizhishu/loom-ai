//! Node-side ownership and durable, at-most-once pipe writes.
//! Agent protocols, input acceptance and business state remain on A.
use std::{
    collections::{HashMap, VecDeque}, io::{Read, Write}, path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, atomic::{AtomicBool, Ordering}}, time::Duration,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use loom_protocol::process_pipe::{
    AgentRunOwner, BindProcessOwner, MAX_INPUT_RECEIPTS, MAX_OUTPUT_CHUNK,
    MAX_PENDING_INPUTS, MAX_SAFE_COUNTER, MAX_UNACKED_EVENTS, PipeResult, PipeStream,
    ProcessControlBody, ProcessControlReply, ProcessInputV1, ProcessOpenV1,
    ProcessOutputBody, ProcessOutputEvent, ProcessSessionOwner, RemoteProcessKey, digest, valid_id,
};
use rovai_process_boundary::{NativeProcess, ProcessSpec, ProcessStdin, StdinPolicy};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch}, task::JoinHandle,
};

const JOURNAL_LIMIT: usize = 96 * 1024;
const INPUT_WRITE_BUDGET: Duration = Duration::from_secs(30);
const MAX_LIVE_PROCESSES: usize = 32;
type Materials = Box<dyn Send>;
type ReplySender = oneshot::Sender<ProcessControlReply>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputReceipt {
    input_seq: u64, request_id: String, envelope_digest: String, written: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingReceipt {
    binding_seq: u64, request_id: String, digest: String,
    owner: Option<AgentRunOwner>, input_seq: u64,
    #[serde(default)]
    builtin_tasks_enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseReceipt {
    request_id: String, acked_event_seq: u64, final_event_seq: u64, output_abandoned: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    version: u32, key: RemoteProcessKey, session: ProcessSessionOwner,
    owner: Option<AgentRunOwner>, launch_digest: String, node_pid: Option<u32>,
    #[serde(default)]
    builtin_tasks_enabled: bool,
    start_identity: Option<u64>, windows_job_name: Option<String>,
    launched: bool, leader_exited: bool, tree_stopped: bool, input_unknown: bool,
    stdin_closed: bool, prepared_input_seq: u64, written_input_seq: u64, binding_seq: u64,
    receipts: VecDeque<InputReceipt>, binding_receipt: Option<BindingReceipt>,
    #[serde(default)]
    stopping: bool,
    #[serde(default)]
    release_receipt: Option<ReleaseReceipt>,
}
impl Ledger {
    fn prepared(launch: &ProcessOpenV1, launch_digest: String) -> Self {
        Self {
            version: 1, key: launch.key.clone(), session: launch.session.clone(),
            owner: Some(launch.owner.clone()), launch_digest, node_pid: None,
            builtin_tasks_enabled: launch.builtin_tasks_enabled,
            start_identity: None, windows_job_name: None, launched: false,
            leader_exited: false, tree_stopped: false, input_unknown: false, stdin_closed: false,
            prepared_input_seq: 0, written_input_seq: 0, binding_seq: 0,
            receipts: VecDeque::new(), binding_receipt: None, stopping: false, release_receipt: None,
        }
    }
    fn check_input(&self, input: &ProcessInputV1, envelope: &str) -> PipeResult<Option<InputReceipt>> {
        if input.key != self.key || input.controller_id != self.session.controller_id {
            return Err("pipe_owner_mismatch");
        }
        if input.input_seq <= self.prepared_input_seq {
            let Some(receipt) = self.receipts.iter().find(|r| r.input_seq == input.input_seq) else {
                return Err("pipe_receipt_retired_or_unknown");
            };
            if receipt.request_id != input.request_id || receipt.envelope_digest != envelope {
                return Err("pipe_replay_conflict");
            }
            return Ok(Some(receipt.clone()));
        }
        if self.owner.as_ref() != Some(&input.owner) { return Err("pipe_owner_mismatch"); }
        if self.input_unknown || self.prepared_input_seq != self.written_input_seq {
            return Err("pipe_input_fenced");
        }
        if self.leader_exited || self.tree_stopped || self.stdin_closed || self.stopping { return Err("pipe_stdin_closed"); }
        if input.input_seq != self.prepared_input_seq.checked_add(1).ok_or("pipe_counter_exhausted")? {
            return Err("pipe_input_sequence_gap");
        }
        Ok(None)
    }
    fn retain_receipt(&mut self, receipt: InputReceipt) {
        self.receipts.push_back(receipt);
        while self.receipts.len() > MAX_INPUT_RECEIPTS { self.receipts.pop_front(); }
    }
}
struct PendingOutput { event: ProcessOutputEvent, _permit: OwnedSemaphorePermit }
#[derive(Default)]
struct OutputState { next_seq: u64, acked_seq: u64, pending: VecDeque<PendingOutput>, closed: bool }
enum WriteRequest { Input(ProcessInputV1, ReplySender), Bind(BindProcessOwner, ReplySender) }
struct LiveProcess {
    key: RemoteProcessKey, path: PathBuf, ledger: Mutex<Ledger>, process: Mutex<NativeProcess>,
    writer: mpsc::Sender<WriteRequest>, output: Mutex<OutputState>, output_slots: Arc<Semaphore>,
    wake: watch::Sender<u64>, shutdown: watch::Sender<bool>, materials: Mutex<Option<Materials>>,
    output_finished: AtomicBool,
}
impl LiveProcess {
    fn reply(&self, body: ProcessControlBody) -> ProcessControlReply {
        ProcessControlReply { key: self.key.clone(), body }
    }
    fn refused(&self, request_id: Option<String>, code: &'static str) -> ProcessControlReply {
        self.reply(ProcessControlBody::Refused { request_id, code: code.into() })
    }
    async fn emit(&self, body: ProcessOutputBody) -> PipeResult<()> {
        let permit = self.output_slots.clone().acquire_owned().await.map_err(|_| "pipe_output_closed")?;
        let mut state = self.output.lock().await;
        if state.closed { return Err("pipe_output_closed"); }
        if state.next_seq >= MAX_SAFE_COUNTER { return Err("pipe_counter_exhausted"); }
        state.next_seq += 1;
        let event = ProcessOutputEvent { key: self.key.clone(), event_seq: state.next_seq, body };
        event.validate()?;
        state.pending.push_back(PendingOutput { event, _permit: permit });
        drop(state);
        self.wake.send_modify(|version| *version = version.wrapping_add(1));
        Ok(())
    }
    async fn snapshot(&self) -> ProcessControlReply {
        let ledger = self.ledger.lock().await;
        let output = self.output.lock().await;
        self.reply(ProcessControlBody::State {
            owner: ledger.owner.clone(), builtin_tasks_enabled: ledger.builtin_tasks_enabled,
            input_seq: ledger.written_input_seq, prepared_input_seq: ledger.prepared_input_seq,
            binding_seq: ledger.binding_seq, output_seq: output.next_seq,
            acked_output_seq: output.acked_seq, leader_exited: ledger.leader_exited,
            tree_stopped: ledger.tree_stopped,
            input_unknown: ledger.input_unknown, stopping: ledger.stopping,
        })
    }
}
struct ManagerInner {
    node_id: String, root: PathBuf,
    live: StdMutex<HashMap<RemoteProcessKey, Arc<LiveProcess>>>, wake: watch::Sender<u64>,
}
impl Drop for ManagerInner {
    fn drop(&mut self) {
        if let Ok(live) = self.live.lock() {
            for live in live.values() {
                live.shutdown.send_replace(true);
                live.output_slots.close();
                if let Ok(mut process) = live.process.try_lock() { let _ = process.terminate_tree(); }
            }
        }
    }
}

/// One manager survives websocket reconnects. Journal-only processes are
/// unknown after a Node restart; they are never automatically respawned.
#[derive(Clone)]
pub(crate) struct PipeManager { inner: Arc<ManagerInner> }
impl PipeManager {
    pub(crate) fn new(data_dir: &Path, node_id: &str) -> PipeResult<Self> {
        if !valid_id(node_id) { return Err("pipe_node_identity"); }
        let root = private_directory(&data_dir.join("process-pipes"))?;
        let (wake, _) = watch::channel(0);
        Ok(Self { inner: Arc::new(ManagerInner {
            node_id: node_id.into(), root, live: StdMutex::new(HashMap::new()), wake,
        }) })
    }
    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> { self.inner.wake.subscribe() }

    /// Reconnect may replay the identical Open while an already admitted CLI
    /// image has since been replaced on disk. This only returns an existing
    /// live process; it never revives a tombstone or admits another executable.
    pub(crate) fn replay_open(&self, launch: &ProcessOpenV1) -> PipeResult<Option<ProcessControlReply>> {
        let launch_digest = launch.digest()?;
        if launch.key.node_id != self.inner.node_id { return Err("pipe_node_identity"); }
        let processes = self.inner.live.lock().map_err(|_| "pipe_manager_unavailable")?;
        let Some(existing) = processes.get(&launch.key) else { return Ok(None); };
        let ledger = existing.ledger.try_lock().map_err(|_| "pipe_process_busy")?;
        if ledger.launch_digest != launch_digest || ledger.session != launch.session {
            return Err("pipe_launch_conflict");
        }
        if !ledger.launched || ledger.leader_exited || ledger.tree_stopped
            || ledger.input_unknown || ledger.stopping || *existing.shutdown.borrow() {
            return Err("pipe_process_not_running");
        }
        Ok(Some(existing.reply(ProcessControlBody::Opened {
            launch_digest, node_pid: ledger.node_pid.ok_or("pipe_launch_unknown")?, materialization:None,
        })))
    }

    /// The spec and material guard must be built by Node-local CLI/workspace
    /// admission, including the frozen catalog generation and file identity.
    /// Durable intent is published before spawn, serialized by the map lock.
    pub(crate) fn open(&self, launch: &ProcessOpenV1, spec: ProcessSpec,
        materials: Option<Materials>) -> PipeResult<ProcessControlReply> {
        let launch_digest = launch.digest()?;
        if launch.key.node_id != self.inner.node_id { return Err("pipe_node_identity"); }
        if spec.stdin_policy() != StdinPolicy::Piped { return Err("pipe_stdin_policy"); }
        if spec.application_identity_digest() != launch.program_identity {
            return Err("pipe_installation_identity_mismatch");
        }
        if std::fs::canonicalize(&launch.cwd).map_err(|_| "pipe_cwd_identity")?
            != std::fs::canonicalize(spec.working_directory()).map_err(|_| "pipe_cwd_identity")? {
            return Err("pipe_cwd_identity");
        }
        let mut processes = self.inner.live.lock().map_err(|_| "pipe_manager_unavailable")?;
        if let Some(existing) = processes.get(&launch.key) {
            let ledger = existing.ledger.try_lock().map_err(|_| "pipe_process_busy")?;
            if ledger.launch_digest != launch_digest || ledger.session != launch.session {
                return Err("pipe_launch_conflict");
            }
            if !ledger.launched || ledger.leader_exited || ledger.tree_stopped || ledger.input_unknown || ledger.stopping
                || *existing.shutdown.borrow() {
                return Err("pipe_process_not_running");
            }
            return Ok(existing.reply(ProcessControlBody::Opened {
                launch_digest, node_pid: ledger.node_pid.ok_or("pipe_launch_unknown")?, materialization:None,
            }));
        }
        // Single-use process ids forbid an epoch bump bypassing a tombstone.
        if processes.keys().any(|key| key.process_id == launch.key.process_id) {
            return Err("pipe_process_generation_conflict");
        }
        if processes.len() >= MAX_LIVE_PROCESSES { return Err("pipe_process_capacity"); }
        let path = ledger_path(&self.inner.root, &launch.key);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                let old = read_ledger(&path)?;
                if old.key != launch.key || old.launch_digest != launch_digest { return Err("pipe_launch_conflict"); }
                return Err(if old.tree_stopped { "pipe_process_completed" } else { "pipe_launch_unknown" });
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("pipe_journal_read"),
        }
        let mut ledger = Ledger::prepared(launch, launch_digest.clone());
        create_ledger(&path, &ledger)?;
        let mut process = NativeProcess::spawn(&spec).map_err(|_| "pipe_spawn_unconfirmed")?;
        let stdin = process.take_stdin().ok_or("pipe_stdin_missing")?;
        let stdout = process.take_stdout().ok_or("pipe_stdout_missing")?;
        let stderr = process.take_stderr().ok_or("pipe_stderr_missing")?;
        let pid = process.id();
        ledger.launched = true;
        ledger.node_pid = Some(pid);
        ledger.start_identity = process.start_identity();
        ledger.windows_job_name = process.windows_job_name().map(str::to_owned);
        // Failed save leaves a prepared tombstone; NativeProcess Drop kills the
        // just-created owned process without claiming a cleanup receipt.
        save_ledger(&path, &ledger)?;
        let (writer, receiver) = mpsc::channel(MAX_PENDING_INPUTS);
        let (shutdown, _) = watch::channel(false);
        let live = Arc::new(LiveProcess {
            key: launch.key.clone(), path, ledger: Mutex::new(ledger), process: Mutex::new(process),
            writer, output: Mutex::new(OutputState::default()),
            output_slots: Arc::new(Semaphore::new(MAX_UNACKED_EVENTS)),
            wake: self.inner.wake.clone(), shutdown, materials: Mutex::new(materials),
            output_finished: AtomicBool::new(false),
        });
        processes.insert(launch.key.clone(), live.clone());
        drop(processes);
        tokio::spawn(write_loop(live.clone(), stdin, receiver));
        let out = tokio::spawn(pump(live.clone(), stdout, PipeStream::Stdout));
        let err = tokio::spawn(pump(live.clone(), stderr, PipeStream::Stderr));
        tokio::spawn(monitor(live.clone(), out, err));
        Ok(live.reply(ProcessControlBody::Opened { launch_digest, node_pid: pid, materialization:None }))
    }
    fn get(&self, key: &RemoteProcessKey) -> PipeResult<Arc<LiveProcess>> {
        key.validate()?;
        if key.node_id != self.inner.node_id { return Err("pipe_node_identity"); }
        self.inner.live.lock().map_err(|_| "pipe_manager_unavailable")?
            .get(key).cloned().ok_or("pipe_process_not_live")
    }
    pub(crate) fn keys(&self) -> Vec<RemoteProcessKey> {
        self.inner.live.lock().map(|m| m.keys().cloned().collect()).unwrap_or_default()
    }
    pub(crate) async fn input(&self, input: ProcessInputV1) -> PipeResult<ProcessControlReply> {
        input.decode()?;
        let live = self.get(&input.key)?;
        {
            let ledger = live.ledger.lock().await;
            if input.input_seq <= ledger.prepared_input_seq {
                match ledger.check_input(&input, &input.envelope_digest()?) {
                    Ok(Some(receipt)) => return Ok(input_receipt(&live, &receipt)),
                    Err("pipe_receipt_retired_or_unknown")
                        if !ledger.input_unknown && input.input_seq == ledger.prepared_input_seq
                            && ledger.prepared_input_seq > ledger.written_input_seq => {
                        // The original writer still owns this sequence. Queue a
                        // duplicate behind it; never perform a second write.
                    }
                    Ok(None) => return Err("pipe_input_outcome_unknown"),
                    Err(code) => return Err(code),
                }
            }
        }
        let (send, receive) = oneshot::channel();
        live.writer.try_send(WriteRequest::Input(input, send)).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => "pipe_input_queue_full",
            mpsc::error::TrySendError::Closed(_) => "pipe_stdin_closed",
        })?;
        receive.await.map_err(|_| "pipe_input_outcome_unknown")
    }
    pub(crate) async fn bind_owner(&self, binding: BindProcessOwner) -> PipeResult<ProcessControlReply> {
        binding.validate()?;
        let live = self.get(&binding.key)?;
        let (send, receive) = oneshot::channel();
        live.writer.try_send(WriteRequest::Bind(binding, send)).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => "pipe_owner_queue_full",
            mpsc::error::TrySendError::Closed(_) => "pipe_stdin_closed",
        })?;
        receive.await.map_err(|_| "pipe_owner_outcome_unknown")
    }
    pub(crate) async fn resume(&self, key: &RemoteProcessKey, controller: &str,
        after_event_seq: u64) -> PipeResult<ProcessControlReply> {
        let live = self.get(key)?;
        if live.ledger.lock().await.session.controller_id != controller { return Err("pipe_controller_mismatch"); }
        let state = live.output.lock().await;
        if after_event_seq < state.acked_seq || after_event_seq > state.next_seq {
            return Err("pipe_resume_cursor_invalid");
        }
        drop(state);
        Ok(live.snapshot().await)
    }
    pub(crate) async fn pending_events(&self, key: &RemoteProcessKey, controller: &str,
        after_event_seq: u64) -> PipeResult<Vec<ProcessOutputEvent>> {
        let live = self.get(key)?;
        if live.ledger.lock().await.session.controller_id != controller { return Err("pipe_controller_mismatch"); }
        let output = live.output.lock().await;
        if after_event_seq < output.acked_seq || after_event_seq > output.next_seq { return Err("pipe_resume_cursor_invalid"); }
        Ok(output.pending.iter().filter(|p| p.event.event_seq > after_event_seq).map(|p| p.event.clone()).collect())
    }
    pub(crate) async fn ack(&self, key: &RemoteProcessKey, controller: &str, event_seq: u64) -> PipeResult<()> {
        let live = self.get(key)?;
        if live.ledger.lock().await.session.controller_id != controller { return Err("pipe_controller_mismatch"); }
        let mut output = live.output.lock().await;
        if event_seq > output.next_seq { return Err("pipe_ack_ahead"); }
        if event_seq <= output.acked_seq { return Ok(()); }
        output.acked_seq = event_seq;
        while output.pending.front().is_some_and(|p| p.event.event_seq <= event_seq) {
            output.pending.pop_front(); // semaphore avoids lost Notify wakeups
        }
        Ok(())
    }
    pub(crate) async fn terminate(&self, key: &RemoteProcessKey, request_id: &str, budget_ms: u32) -> PipeResult<ProcessControlReply> {
        if !valid_id(request_id) || !(1..=5000).contains(&budget_ms) { return Err("pipe_termination_request"); }
        let live = self.get(key)?;
        // A disk error must never prevent an already authorized process stop.
        live.shutdown.send_replace(true);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(budget_ms.into());
        let result = tokio::time::timeout_at(deadline, async {
            let mut process = live.process.lock().await;
            process.terminate_and_wait(deadline.saturating_duration_since(tokio::time::Instant::now())).await
        }).await;
        let confirmed = matches!(result, Ok(Ok(ref receipt)) if receipt.tree_empty);
        let mut ledger = live.ledger.lock().await;
        ledger.stopping = true;
        if confirmed {
            ledger.leader_exited = true;
            ledger.tree_stopped = true;
            save_ledger(&live.path, &ledger)?;
        }
        let leader_exited = ledger.leader_exited;
        let tree_stopped = ledger.tree_stopped;
        drop(ledger);
        if tree_stopped { live.materials.lock().await.take(); }
        Ok(live.reply(ProcessControlBody::Terminated { request_id: request_id.into(), leader_exited, tree_stopped }))
    }
    /// Release is separate from tree cleanup. Normal release requires a
    /// durably ACKed terminal output. Explicit abandonment records incomplete
    /// output before freeing the bounded window and actor resources.
    pub(crate) async fn release(&self, key: &RemoteProcessKey, controller: &str, request_id: &str,
        acked_event_seq: u64, abandon_output: bool) -> PipeResult<ProcessControlReply> {
        key.validate()?;
        if key.node_id != self.inner.node_id || !valid_id(controller) || !valid_id(request_id)
            || acked_event_seq > MAX_SAFE_COUNTER { return Err("pipe_release_identity"); }
        let live = match self.get(key) {
            Ok(live) => live,
            Err("pipe_process_not_live") => {
                let ledger = read_ledger(&ledger_path(&self.inner.root, key))?;
                if ledger.key != *key || ledger.session.controller_id != controller || !ledger.tree_stopped {
                    return Err("pipe_release_unconfirmed");
                }
                let receipt = ledger.release_receipt.ok_or("pipe_release_unconfirmed")?;
                if receipt.request_id != request_id || receipt.acked_event_seq != acked_event_seq
                    || receipt.output_abandoned != abandon_output { return Err("pipe_release_conflict"); }
                return Ok(release_reply(key, &receipt));
            }
            Err(code) => return Err(code),
        };
        let mut ledger = live.ledger.lock().await;
        if ledger.session.controller_id != controller { return Err("pipe_controller_mismatch"); }
        if !ledger.tree_stopped || !ledger.leader_exited { return Err("pipe_release_unconfirmed"); }
        let mut output = live.output.lock().await;
        if acked_event_seq != output.acked_seq { return Err("pipe_release_ack_mismatch"); }
        let receipt = if let Some(receipt) = &ledger.release_receipt {
            if receipt.request_id != request_id || receipt.acked_event_seq != acked_event_seq
                || receipt.output_abandoned != abandon_output { return Err("pipe_release_conflict"); }
            receipt.clone()
        } else {
            if !abandon_output && (!live.output_finished.load(Ordering::Acquire) || !output.pending.is_empty()) {
                return Err("pipe_output_not_settled");
            }
            let receipt = ReleaseReceipt { request_id: request_id.into(), acked_event_seq,
                final_event_seq: output.next_seq, output_abandoned: abandon_output };
            ledger.release_receipt = Some(receipt.clone());
            if save_ledger(&live.path, &ledger).is_err() {
                ledger.release_receipt = None;
                return Err("pipe_journal_unavailable");
            }
            receipt
        };
        live.shutdown.send_replace(true);
        live.output_slots.close();
        output.closed = true;
        output.pending.clear();
        drop(output);
        drop(ledger);
        live.materials.lock().await.take();
        self.inner.live.lock().map_err(|_| "pipe_manager_unavailable")?.remove(key);
        Ok(release_reply(key, &receipt))
    }
    /// Revocation calls this. Ordinary socket reconnect deliberately does not.
    pub(crate) async fn shutdown(&self) {
        for key in self.keys() {
            let _ = self.terminate(&key, "node-shutdown", 5000).await;
            if let Ok(live) = self.get(&key) {
                let controller = live.ledger.lock().await.session.controller_id.clone();
                let acked = live.output.lock().await.acked_seq;
                let _ = self.release(&key, &controller, "node-shutdown", acked, true).await;
            }
        }
    }
}

async fn write_loop(live: Arc<LiveProcess>, stdin: ProcessStdin, mut receiver: mpsc::Receiver<WriteRequest>) {
    let mut stdin = Some(stdin);
    let mut shutdown = live.shutdown.subscribe();
    loop {
        if *shutdown.borrow() { break; }
        let request = tokio::select! {
            changed = shutdown.changed() => { let _ = changed; break; }
            request = receiver.recv() => match request { Some(request) => request, None => break },
        };
        match request {
            WriteRequest::Input(input, respond) => { let _ = respond.send(write_one(&live, &mut stdin, input).await); }
            WriteRequest::Bind(binding, respond) => { let _ = respond.send(bind_one(&live, binding).await); }
        }
    }
    receiver.close();
    while let Ok(request) = receiver.try_recv() {
        let (id, respond) = match request {
            WriteRequest::Input(input, respond) => (input.request_id, respond),
            WriteRequest::Bind(binding, respond) => (binding.request_id, respond),
        };
        let _ = respond.send(live.refused(Some(id), "pipe_stdin_closed"));
    }
}
async fn write_one(live: &Arc<LiveProcess>, stdin: &mut Option<ProcessStdin>, input: ProcessInputV1) -> ProcessControlReply {
    let refused = |code| live.refused(Some(input.request_id.clone()), code);
    if *live.shutdown.borrow() { return refused("pipe_stdin_closed"); }
    let bytes = match input.decode() { Ok(bytes) => bytes, Err(code) => return refused(code) };
    let envelope = match input.envelope_digest() { Ok(value) => value, Err(code) => return refused(code) };
    {
        let mut ledger = live.ledger.lock().await;
        match ledger.check_input(&input, &envelope) {
            Ok(Some(receipt)) => return input_receipt(live, &receipt),
            Err(code) => return refused(code),
            Ok(None) => {}
        }
        ledger.prepared_input_seq = input.input_seq;
        if save_ledger(&live.path, &ledger).is_err() {
            ledger.input_unknown = true;
            return refused("pipe_journal_unavailable");
        }
    }
    let result = tokio::time::timeout(INPUT_WRITE_BUDGET, async {
        let writer = stdin.as_mut().ok_or_else(|| std::io::Error::new(
            std::io::ErrorKind::BrokenPipe, "native stdin is already closed"))?;
        writer.write_all(&bytes).await?;
        writer.flush().await?;
        if input.close { writer.shutdown().await?; }
        Ok::<(), std::io::Error>(())
    }).await;
    if input.close && matches!(result, Ok(Ok(()))) {
        // Windows ProcessStdin is a Tokio File: shutdown flushes but keeps the
        // OS write handle alive. EOF must reach the child before InputWritten
        // is made durable. Keep the actor alive for exact receipt replay.
        drop(stdin.take());
    }
    let mut ledger = live.ledger.lock().await;
    let mut receipt = InputReceipt {
        input_seq: input.input_seq, request_id: input.request_id,
        envelope_digest: envelope, written: matches!(result, Ok(Ok(()))),
    };
    if receipt.written {
        ledger.written_input_seq = receipt.input_seq;
        ledger.stdin_closed |= input.close;
    } else { ledger.input_unknown = true; }
    ledger.retain_receipt(receipt.clone());
    if save_ledger(&live.path, &ledger).is_err() {
        ledger.input_unknown = true;
        receipt.written = false;
        if let Some(last) = ledger.receipts.back_mut() { last.written = false; }
    }
    drop(ledger);
    if !receipt.written {
        live.shutdown.send_replace(true);
        let _ = live.process.lock().await.terminate_tree();
    }
    input_receipt(live, &receipt)
}
fn input_receipt(live: &LiveProcess, receipt: &InputReceipt) -> ProcessControlReply {
    live.reply(if receipt.written {
        ProcessControlBody::InputWritten { input_seq: receipt.input_seq,
            request_id: receipt.request_id.clone(), envelope_digest: receipt.envelope_digest.clone() }
    } else {
        ProcessControlBody::InputUnknown { input_seq: receipt.input_seq,
            request_id: receipt.request_id.clone(), code: "pipe_write_outcome_unknown".into() }
    })
}
async fn bind_one(live: &LiveProcess, binding: BindProcessOwner) -> ProcessControlReply {
    let refused = |code| live.refused(Some(binding.request_id.clone()), code);
    let digest = match binding.digest() { Ok(value) => value, Err(code) => return refused(code) };
    let mut ledger = live.ledger.lock().await;
    if binding.key != ledger.key || binding.controller_id != ledger.session.controller_id { return refused("pipe_owner_mismatch"); }
    if binding.binding_seq <= ledger.binding_seq {
        if let Some(previous) = &ledger.binding_receipt
            && previous.binding_seq == binding.binding_seq && previous.request_id == binding.request_id && previous.digest == digest {
            return live.reply(ProcessControlBody::OwnerBound { request_id: previous.request_id.clone(),
                binding_seq: previous.binding_seq, owner: previous.owner.clone(),
                builtin_tasks_enabled: previous.builtin_tasks_enabled, input_seq: previous.input_seq });
        }
        return refused("pipe_owner_receipt_retired_or_conflict");
    }
    if binding.binding_seq != ledger.binding_seq.saturating_add(1) || binding.previous_owner != ledger.owner
        || ledger.leader_exited || ledger.stopping || ledger.input_unknown || ledger.prepared_input_seq != ledger.written_input_seq
        || binding.after_input_seq != ledger.written_input_seq {
        return refused("pipe_owner_boundary_unconfirmed");
    }
    let previous = ledger.clone();
    ledger.owner = binding.next_owner.clone();
    ledger.builtin_tasks_enabled = binding.builtin_tasks_enabled;
    ledger.binding_seq = binding.binding_seq;
    ledger.binding_receipt = Some(BindingReceipt { binding_seq: binding.binding_seq, request_id: binding.request_id.clone(),
        digest, owner: binding.next_owner.clone(), builtin_tasks_enabled: binding.builtin_tasks_enabled,
        input_seq: binding.after_input_seq });
    if save_ledger(&live.path, &ledger).is_err() {
        *ledger = previous;
        ledger.input_unknown = true;
        return refused("pipe_journal_unavailable");
    }
    live.reply(ProcessControlBody::OwnerBound { request_id: binding.request_id, binding_seq: binding.binding_seq,
        owner: binding.next_owner, builtin_tasks_enabled: binding.builtin_tasks_enabled,
        input_seq: binding.after_input_seq })
}
async fn pump<R: AsyncRead + Send + Unpin>(live: Arc<LiveProcess>, mut reader: R, stream: PipeStream) {
    let mut bytes = vec![0u8; MAX_OUTPUT_CHUNK];
    loop {
        match reader.read(&mut bytes).await {
            Ok(0) => break,
            Ok(length) => {
                if live.emit(ProcessOutputBody::Output { stream, data: STANDARD.encode(&bytes[..length]) }).await.is_err() { break; }
            }
            Err(_) => { let _ = live.emit(ProcessOutputBody::OutputFault { stream, code: "pipe_read_failed".into() }).await; break; }
        }
    }
}
async fn monitor(live: Arc<LiveProcess>, stdout: JoinHandle<()>, stderr: JoinHandle<()>) {
    let mut exit = None;
    let mut cleanup_deadline = None;
    loop {
        let should_stop = *live.shutdown.borrow();
        if should_stop && cleanup_deadline.is_none() {
            cleanup_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(5));
            let mut ledger = live.ledger.lock().await;
            ledger.stopping = true;
            let _ = save_ledger(&live.path, &ledger);
        }
        let mut process = live.process.lock().await;
        if should_stop || exit.is_some() { let _ = process.terminate_tree(); }
        match process.try_wait() {
            Ok(Some(status)) => { exit = Some(status); }
            Ok(None) => {}
            Err(_) => {
                drop(process);
                let mut ledger = live.ledger.lock().await;
                ledger.input_unknown = true;
                let _ = save_ledger(&live.path, &ledger);
                drop(ledger);
                live.shutdown.send_replace(true);
                let deadline = cleanup_deadline.get_or_insert_with(|| tokio::time::Instant::now() + Duration::from_secs(5));
                if tokio::time::Instant::now() >= *deadline { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
        }
        let tree_stopped = exit.is_some() && process.tree_is_empty().unwrap_or(false);
        drop(process);
        if exit.is_some() {
            let mut ledger = live.ledger.lock().await;
            let changed = !ledger.leader_exited || (tree_stopped && !ledger.tree_stopped);
            ledger.leader_exited = true;
            ledger.tree_stopped |= tree_stopped;
            if changed { let _ = save_ledger(&live.path, &ledger); }
            drop(ledger);
            live.shutdown.send_replace(true);
            if tree_stopped { live.materials.lock().await.take(); break; }
            let deadline = cleanup_deadline.get_or_insert_with(|| tokio::time::Instant::now() + Duration::from_secs(5));
            if tokio::time::Instant::now() >= *deadline { break; }
        }
        // Keep ownership of an unconfirmed tree while reducing background
        // polling after the caller's bounded stop request has settled unknown.
        let interval = if cleanup_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            Duration::from_secs(1)
        } else { Duration::from_millis(10) };
        tokio::time::sleep(interval).await;
    }
    // Output drain may wait for ACK. This never delays separate stop receipts.
    finish_pump(&live, stdout, PipeStream::Stdout).await;
    finish_pump(&live, stderr, PipeStream::Stderr).await;
    if let Some(status) = exit {
        #[cfg(unix)]
        let signal = { use std::os::unix::process::ExitStatusExt; status.signal() };
        #[cfg(not(unix))]
        let signal = None;
        let _ = live.emit(ProcessOutputBody::Exited { exit_code: status.code(), signal }).await;
    } else {
        let _ = live.emit(ProcessOutputBody::OutputFault { stream: PipeStream::Stdout, code: "pipe_exit_unconfirmed".into() }).await;
    }
    live.output_finished.store(true, Ordering::Release);
}
async fn finish_pump(live: &LiveProcess, task: JoinHandle<()>, stream: PipeStream) {
    if task.await.is_err() {
        let _ = live.emit(ProcessOutputBody::OutputFault { stream, code: "pipe_pump_failed".into() }).await;
    }
}
fn release_reply(key: &RemoteProcessKey, receipt: &ReleaseReceipt) -> ProcessControlReply {
    ProcessControlReply { key: key.clone(), body: ProcessControlBody::Released {
        request_id: receipt.request_id.clone(), final_event_seq: receipt.final_event_seq,
        acked_event_seq: receipt.acked_event_seq, output_abandoned: receipt.output_abandoned,
    } }
}
fn ledger_path(root: &Path, key: &RemoteProcessKey) -> PathBuf {
    let identifier = serde_json::to_vec(&(&key.node_id, &key.process_id)).expect("string tuple serializes");
    root.join(format!("{}.json", digest(&identifier)))
}
fn private_directory(path: &Path) -> PipeResult<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        match std::fs::symlink_metadata(path) {
            Ok(m) => {
                if !m.is_dir() || m.file_type().is_symlink() || m.mode() & 0o077 != 0 {
                    return Err("pipe_private_directory");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::DirBuilder::new().mode(0o700).create(path).map_err(|_| "pipe_private_directory")?;
            }
            Err(_) => return Err("pipe_private_directory"),
        }
    }
    rovai_private_storage::prepare_private_directory(path).map_err(|_| "pipe_private_directory")
}
fn create_ledger(path: &Path, ledger: &Ledger) -> PipeResult<()> {
    let bytes = serde_json::to_vec(ledger).map_err(|_| "pipe_journal_encoding")?;
    if bytes.len() > JOURNAL_LIMIT { return Err("pipe_journal_limit"); }
    let mut file = rovai_private_storage::create_private_new_file(path).map_err(|_| "pipe_journal_create")?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "pipe_journal_write")?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("pipe_journal_parent")?)
        .and_then(|file| file.sync_all()).map_err(|_| "pipe_journal_sync")?;
    Ok(())
}
fn save_ledger(path: &Path, ledger: &Ledger) -> PipeResult<()> {
    let bytes = serde_json::to_vec(ledger).map_err(|_| "pipe_journal_encoding")?;
    if bytes.len() > JOURNAL_LIMIT { return Err("pipe_journal_limit"); }
    rovai_private_storage::atomic_write_private_bytes(path, &bytes).map_err(|_| "pipe_journal_write")
}
fn read_ledger(path: &Path) -> PipeResult<Ledger> {
    let file = rovai_private_storage::open_private_read_file(path).map_err(|_| "pipe_journal_read")?;
    let mut bytes = Vec::new();
    file.take(JOURNAL_LIMIT as u64 + 1).read_to_end(&mut bytes).map_err(|_| "pipe_journal_read")?;
    if bytes.len() > JOURNAL_LIMIT { return Err("pipe_journal_limit"); }
    let ledger: Ledger = serde_json::from_slice(&bytes).map_err(|_| "pipe_journal_invalid")?;
    if ledger.version != 1 { return Err("pipe_journal_version"); }
    ledger.key.validate()?;
    ledger.session.validate()?;
    Ok(ledger)
}
#[cfg(test)]
#[path = "process_pipe/tests.rs"]
mod tests;
