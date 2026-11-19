//! Execution nodes for milestones B2, B3, and B4.
//!
//! Node tokens are stored as digests in SQLite, so they survive a server
//! restart. Pairing codes stay in memory. A remote node is only used when
//! `node-exec` targets it; it is not the mission execution host. A CLI the
//! connected node did not report is refused before a process is started.
//! Each dispatched run gets a separate shim credential, scoped to that run
//! and member, which dies when the run ends or the node is revoked.

use crate::auth::{Session, Sessions};
use crate::{WebState, error};
use axum::{
    Json,
    extract::{
        ConnectInfo, Extension, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use loom_protocol::run_bundle::{
    BundleExpectation, RunBundleV1, bundle_digest, bundle_id_for, validate as validate_bundle,
};
use loom_protocol::computer::COMPUTER_VERSION;
use loom_protocol::{
    CONNECT_PATH, CliReport, ClientMessage, OutputStream, RunReport, ServerMessage,
};
use rovai_core::execution_node::launch_digest;
use rovai_core::execution_node::{
    CliRecord, DispatchRecord, NextAttempt, NodeStore, OutputWrite, RevokeResult, TaskHost,
    WorkspaceRecord,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex, OnceLock, RwLock},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, mpsc, oneshot};

pub(crate) mod computer;
mod process_bridge;
pub(crate) mod process_pipe;
mod workspace_rpc;

pub const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
const NODE_WAIT: Duration = Duration::from_secs(30);
const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HELLO_DEADLINE: Duration = Duration::from_secs(10);
const MAX_FRAME: usize = 2 * 1024 * 1024;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const OUTPUT_PAGE: usize = 1000;
const OUTBOUND_QUEUE: usize = 64;
const NODE_KIND: &[u8] = b"rovai-node-v1\0";
const RUN_KIND: &[u8] = b"rovai-node-run-v1\0";
const PAIRING_KIND: &[u8] = b"rovai-node-pairing-v1\0";

/// Failed pairing attempts allowed from one TCP peer inside [`PAIRING_WINDOW`].
const PAIRING_FAILURES_PER_ADDRESS: usize = 8;
/// Failed pairing attempts allowed from every peer combined inside the window.
const PAIRING_FAILURES_GLOBAL: usize = 32;
const PAIRING_WINDOW: Duration = Duration::from_secs(60);

/// The pre-pairing socket has no authenticated identity. Limits use the TCP
/// peer address this process accepted, never `X-Forwarded-For` or any other
/// client-supplied header. Behind a reverse proxy every attempt shares the
/// proxy's address, so the per-address limit collapses onto that one peer and
/// only the global limit still bounds the process. Rate-limit this socket at
/// the proxy as well when one sits in front of it.

enum Outbound {
    Text(String),
    Pong(Vec<u8>),
    FlushAcks,
}

// Closing either sender does not discard receipts already queued on the other
// lane. Pattern matching disables only an exhausted lane; both lanes must be
// closed and drained before the writer may stop.
async fn receive_outbound(
    urgent: &mut mpsc::Receiver<Outbound>,
    regular: &mut mpsc::Receiver<Outbound>,
) -> Option<Outbound> {
    tokio::select! {
        biased;
        Some(item) = urgent.recv() => Some(item),
        Some(item) = regular.recv() => Some(item),
        else => None,
    }
}

#[derive(Clone)]
struct Outbox {
    tx: mpsc::Sender<Outbound>,
    urgent: Option<mpsc::Sender<Outbound>>,
    acks: Arc<StdMutex<HashMap<String, u64>>>,
}

impl Outbox {
    fn try_text(&self, text: String) {
        let _ = self.tx.try_send(Outbound::Text(text));
    }

    fn try_pong(&self, data: Vec<u8>) {
        let _ = self.tx.try_send(Outbound::Pong(data));
    }

    fn try_ack(&self, run_id: &str, seq: u64) {
        {
            let mut acks = self.acks.lock().expect("ack map poisoned");
            let entry = acks.entry(run_id.to_owned()).or_insert(0);
            if seq > *entry {
                *entry = seq;
            }
        }
        let _ = self.tx.try_send(Outbound::FlushAcks);
    }

    async fn send_text(&self, text: String) -> bool {
        self.tx.send(Outbound::Text(text)).await.is_ok()
    }
}

struct Node {
    generation: u64,
    outbound: Option<Outbox>,
    cancel: Option<oneshot::Sender<()>>,
    clis: Vec<loom_protocol::CliReport>,
    run_bundle_versions: Vec<u32>,
    process_pipe_versions: Vec<u32>,
    workspace_rpc_versions: Vec<u32>,
    /// Announced only after this node's own metadata probe succeeded. Empty
    /// means the node has no computer capability and must be refused.
    computer_versions: Vec<u32>,
}

struct Run {
    node_id: String,
    attempt: u32,
    done: Option<oneshot::Sender<Result<RunOutcome, &'static str>>>,
}

struct FsWait {
    node_id: String,
    generation: u64,
    ticket: String,
    deadline: Instant,
    done: oneshot::Sender<ClientMessage>,
}

#[derive(Clone, Default)]
struct RunScope {
    mission_id: Option<String>,
    member_id: Option<String>,
    frozen_bundle: Option<FrozenMemberBundle>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenMemberBundle {
    bundle: RunBundleV1,
    manifest: Value,
}

fn bundle_for_attempt(
    bundle: &RunBundleV1,
    run_id: &str,
    attempt: u32,
    runtime: &str,
) -> Result<RunBundleV1, &'static str> {
    validate_bundle(
        bundle,
        &BundleExpectation {
            run_id: &bundle.run_id,
            attempt: bundle.attempt,
            adapter_kind: runtime,
        },
    )
    .map_err(|error| error.code())?;
    let mut bound = bundle.clone();
    bound.run_id = run_id.to_string();
    bound.attempt = attempt;
    bound.bundle_id = bundle_id_for(run_id, attempt);
    bound.digest = bundle_digest(&bound).map_err(|error| error.code())?;
    validate_bundle(
        &bound,
        &BundleExpectation {
            run_id,
            attempt,
            adapter_kind: runtime,
        },
    )
    .map_err(|error| error.code())?;
    Ok(bound)
}

struct RunOutcome {
    exit_code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct Issued {
    node_id: String,
    token: String,
}

struct PairingLimiter {
    by_address: HashMap<IpAddr, VecDeque<Instant>>,
    global: VecDeque<Instant>,
}

impl PairingLimiter {
    fn prune(&mut self, now: Instant) {
        let keep = |queue: &mut VecDeque<Instant>| {
            while queue
                .front()
                .is_some_and(|at| now.duration_since(*at) > PAIRING_WINDOW)
            {
                queue.pop_front();
            }
        };
        keep(&mut self.global);
        self.by_address.retain(|_, queue| {
            keep(queue);
            !queue.is_empty()
        });
    }

    fn limited(&mut self, peer: IpAddr, now: Instant) -> bool {
        self.prune(now);
        self.global.len() >= PAIRING_FAILURES_GLOBAL
            || self
                .by_address
                .get(&peer)
                .is_some_and(|queue| queue.len() >= PAIRING_FAILURES_PER_ADDRESS)
    }

    fn record(&mut self, peer: IpAddr, now: Instant) {
        self.prune(now);
        self.by_address.entry(peer).or_default().push_back(now);
        self.global.push_back(now);
    }
}

struct OpenPairing {
    code: String,
    digest: [u8; 32],
}

struct Inner {
    pairings: HashMap<[u8; 32], Instant>,
    /// Plaintext of the code an administrator may open again. Redeeming or
    /// expiry drops it from `pairings`; the next issue replaces it.
    open_pairing: Option<OpenPairing>,
    pairing_failures: PairingLimiter,
    nodes: HashMap<String, Node>,
    runs: HashMap<String, Run>,
    fs_waiters: HashMap<String, FsWait>,
    /// In-flight computer request/reply pairs, keyed by request id and fenced to
    /// the connection generation that accepted them.
    computer_waits: HashMap<String, computer::ComputerWait>,
    /// Node ids whose token was revoked in this process. Registration checks
    /// this under the same lock that `revoke` uses to drop a live socket.
    revoked: HashSet<String>,
}

#[cfg(test)]
struct AttachGate {
    reached: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

pub struct Hub {
    sessions: RwLock<Arc<Sessions>>,
    pub(crate) store: NodeStore,
    core: OnceLock<rovai_core::application::CoreService>,
    pipes: OnceLock<Arc<process_pipe::PipeRegistry>>,
    workspace_transport:
        OnceLock<Arc<dyn rovai_core::workspace_rpc_transport::WorkspaceRpcTransport>>,
    runtime_directory: OnceLock<std::path::PathBuf>,
    workspace_prepare: Mutex<()>,
    builtin_jobs: Arc<tokio::sync::Semaphore>,
    inner: Mutex<Inner>,
    /// Test-only pause after a hello is accepted and before the socket is registered.
    #[cfg(test)]
    attach_gate: Mutex<Option<Arc<AttachGate>>>,
}

impl Hub {
    pub fn start(sessions: Arc<Sessions>, store: NodeStore) -> Arc<Self> {
        let hub = Arc::new(Self::new(sessions, store));
        let expiring = Arc::downgrade(&hub);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let Some(hub) = expiring.upgrade() else {
                    break;
                };
                hub.expire().await;
                if hub.workspace_transport.get().is_some() {
                    workspace_rpc::expire(hub.clone()).await;
                }
            }
        });
        hub
    }

    fn new(sessions: Arc<Sessions>, store: NodeStore) -> Self {
        Self {
            sessions: RwLock::new(sessions),
            store,
            core: OnceLock::new(),
            pipes: OnceLock::new(),
            workspace_transport: OnceLock::new(),
            runtime_directory: OnceLock::new(),
            workspace_prepare: Mutex::new(()),
            builtin_jobs: Arc::new(tokio::sync::Semaphore::new(16)),
            inner: Mutex::new(Inner {
                pairings: HashMap::new(),
                open_pairing: None,
                pairing_failures: PairingLimiter {
                    by_address: HashMap::new(),
                    global: VecDeque::new(),
                },
                nodes: HashMap::new(),
                runs: HashMap::new(),
                fs_waiters: HashMap::new(),
                computer_waits: HashMap::new(),
                revoked: HashSet::new(),
            }),
            #[cfg(test)]
            attach_gate: Mutex::new(None),
        }
    }

    /// The same unused, unexpired code is returned until it is redeemed or
    /// expires. A used or expired code is replaced and is not shown again.
    async fn issue_pairing(&self) -> (String, u64) {
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        inner.pairings.retain(|_, expiry| *expiry > now);
        if let Some(open) = &inner.open_pairing {
            if let Some(expiry) = inner.pairings.get(&open.digest).copied() {
                if expiry > now {
                    let remaining = expiry.saturating_duration_since(now).as_secs().max(1);
                    return (open.code.clone(), remaining);
                }
            }
        }
        let code = random_hex(8);
        let digest = keyed_digest(PAIRING_KIND, &code);
        let expiry = now + PAIRING_TTL;
        inner.pairings.insert(digest, expiry);
        inner.open_pairing = Some(OpenPairing {
            code: code.clone(),
            digest,
        });
        (code, PAIRING_TTL.as_secs())
    }

    async fn redeem(&self, code: &str, peer: IpAddr) -> Result<Issued, &'static str> {
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        if inner.pairing_failures.limited(peer, now) {
            return Err("pairing_rate_limited");
        }
        match self.redeem_code(&mut inner, code) {
            Ok(issued) => Ok(issued),
            Err(code) => {
                inner.pairing_failures.record(peer, now);
                Err(code)
            }
        }
    }

    fn redeem_code(&self, inner: &mut Inner, code: &str) -> Result<Issued, &'static str> {
        if self
            .sessions
            .read()
            .map_err(|_| "session_store_unavailable")?
            .is_administrator(code)
        {
            return Err("administrator_rejected");
        }
        let digest = keyed_digest(PAIRING_KIND, code);
        let node_id = format!("node_{}", uuid::Uuid::new_v4().simple());
        let display_name = format!("node-{}", &node_id[5..13]);
        let token = crate::new_token().map_err(|_| "token_unavailable")?;
        let token_digest = digest_hex(&token);
        let Some(expiry) = inner.pairings.remove(&digest) else {
            return Err("pairing_invalid");
        };
        if expiry <= Instant::now() {
            return Err("pairing_invalid");
        }
        self.store
            .insert_remote(&node_id, &display_name, &token_digest)
            .map_err(|_| "token_unavailable")?;
        Ok(Issued { node_id, token })
    }

    async fn authorize(&self, node_id: &str, token: &str) -> Result<(), &'static str> {
        if self
            .sessions
            .read()
            .map_err(|_| "session_store_unavailable")?
            .is_administrator(token)
            || !valid_credential(token)
        {
            return Err("administrator_rejected");
        }
        let state = self
            .store
            .token_state(node_id)
            .map_err(|_| "token_rejected")?;
        let Some(state) = state else {
            return Err("token_rejected");
        };
        if state.revoked {
            return Err("token_revoked");
        }
        let digest = digest_hex(token);
        if digest.len() != state.digest_hex.len()
            || !bool::from(digest.as_bytes().ct_eq(state.digest_hex.as_bytes()))
        {
            return Err("token_rejected");
        }
        Ok(())
    }

    async fn attach(
        &self,
        node_id: &str,
        outbound: Outbox,
        cancel: oneshot::Sender<()>,
        os: &str,
        arch: &str,
        clis: Vec<loom_protocol::CliReport>,
    ) -> Result<u64, &'static str> {
        if os.len() > 32 || arch.len() > 32 || clis.len() > 32 {
            return Err("invalid_hello");
        }
        for cli in &clis {
            if cli.adapter_kind.is_empty()
                || cli.adapter_kind.len() > 64
                || cli.path.len() > 4096
                || cli.path.contains('\0')
                || cli
                    .version
                    .as_ref()
                    .is_some_and(|version| version.is_empty() || version.len() > 200)
                || (cli.path_present && is_path_sentinel(&cli.path))
            {
                return Err("invalid_hello");
            }
        }
        let records: Vec<CliRecord> = clis
            .iter()
            .map(|cli| CliRecord {
                adapter_kind: cli.adapter_kind.clone(),
                path: cli.path.clone(),
                version: cli.version.clone(),
                path_present: cli.path_present,
                reported_at: String::new(),
                installation_identity: cli.installation_identity.clone(),
                installation_generation: cli.installation_generation,
            })
            .collect();
        self.store
            .record_hello(node_id, os, arch, &records)
            .map_err(|_| "token_rejected")?;
        #[cfg(test)]
        self.wait_attach_gate().await;
        let generation = {
            let mut inner = self.inner.lock().await;
            if inner.revoked.contains(node_id) {
                return Err("token_revoked");
            }
            let node = inner.nodes.entry(node_id.to_owned()).or_insert(Node {
                generation: 0,
                outbound: None,
                cancel: None,
                clis: Vec::new(),
                run_bundle_versions: Vec::new(),
                process_pipe_versions: Vec::new(),
                workspace_rpc_versions: Vec::new(),
                computer_versions: Vec::new(),
            });
            if let Some(previous) = node.cancel.take() {
                let _ = previous.send(());
            }
            node.generation = node.generation.saturating_add(1);
            node.clis = clis;
            node.run_bundle_versions.clear();
            node.process_pipe_versions.clear();
            node.workspace_rpc_versions.clear();
            node.computer_versions.clear();
            node.outbound = Some(outbound);
            node.cancel = Some(cancel);
            node.generation
        };
        let still_active = self
            .store
            .token_state(node_id)
            .ok()
            .flatten()
            .is_some_and(|state| !state.revoked);
        if !still_active {
            self.detach(node_id, generation).await;
            return Err("token_revoked");
        }
        Ok(generation)
    }

    async fn set_run_bundle_versions(&self, node_id: &str, generation: u64, versions: Vec<u32>) {
        let mut inner = self.inner.lock().await;
        if let Some(node) = inner.nodes.get_mut(node_id)
            && node.generation == generation
        {
            node.run_bundle_versions = versions;
        }
    }

    /// Capability is a per-connection fact. It is written under the same lock
    /// and the same generation as the socket, so a stale hello can never
    /// enable computer on a replacement connection.
    async fn set_computer_versions(&self, node_id: &str, generation: u64, versions: Vec<u32>) {
        let mut inner = self.inner.lock().await;
        if let Some(node) = inner.nodes.get_mut(node_id)
            && node.generation == generation
        {
            node.computer_versions = versions;
        }
    }

    #[cfg(test)]
    async fn wait_attach_gate(&self) {
        let gate = self.attach_gate.lock().await.clone();
        let Some(gate) = gate else {
            return;
        };
        let release = gate.release.notified();
        tokio::pin!(release);
        gate.reached.notify_one();
        release.await;
    }

    async fn reconcile(&self, node_id: &str, generation: u64, reports: &[RunReport]) -> Vec<ServerMessage> {
        let mut inner = self.inner.lock().await;
        if !inner.nodes.get(node_id).is_some_and(|node|
            node.generation == generation && node.outbound.is_some()) {
            return Vec::new();
        }
        let running = match self.store.running_for_node(node_id) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        let mut messages = Vec::new();
        for dispatch in running {
            let matching_report = reports.iter().find(|report|
                report.run_id == dispatch.run_id && report.attempt == dispatch.attempt);
            let run = inner.runs.entry(dispatch.run_id.clone()).or_insert(Run {
                node_id: node_id.to_owned(), attempt: dispatch.attempt, done: None,
            });
            if run.node_id != node_id || run.attempt != dispatch.attempt { continue; }
            if matching_report.is_none() && let Some(done) = run.done.take() {
                let _ = done.send(Err("legacy_outcome_unknown"));
            }
            // Resume is a query/replay operation, never another spawn. A new Node
            // reports unknown if no live owner exists. The A record remains
            // non-retryable without a positive no-process rejection.
            messages.push(ServerMessage::Resume {
                run_id: dispatch.run_id, attempt: dispatch.attempt,
                acked_seq: dispatch.acked_seq,
            });
        }
        // A terminal ACK can be lost after A durably finishes and retires its
        // waiter. A fresh A must acknowledge that exact finished report again.
        let mut seen = HashSet::new();
        for report in reports.iter().take(32) {
            if report.process_alive || report.sent_seq == 0 || !seen.insert(&report.run_id) {
                continue;
            }
            if inner.runs.get(&report.run_id).is_some_and(|run|
                run.node_id != node_id || run.attempt != report.attempt) { continue; }
            let Ok(Some(dispatch)) = self.store.current_attempt(&report.run_id, report.attempt)
                else { continue; };
            if dispatch.node_id == node_id && dispatch.status == "exited"
                && dispatch.acked_seq == report.sent_seq {
                self.complete_waiter_locked(&mut inner, &report.run_id, node_id, report.attempt);
                messages.push(ServerMessage::Ack { run_id: report.run_id.clone(),
                    seq: dispatch.acked_seq });
            }
        }
        messages
    }

    async fn detach(&self, node_id: &str, generation: u64) {
        let mut inner = self.inner.lock().await;
        {
            let Some(node) = inner.nodes.get_mut(node_id) else {
                return;
            };
            if node.generation != generation {
                return;
            }
            node.outbound = None;
            node.cancel = None;
        }
        fail_node_waiters(&mut inner, node_id);
        // The socket is gone, so every pending computer request it owned is
        // retired: a caller gets an unknown outcome instead of waiting out a
        // deadline, and no stale frame can be delivered to its replacement.
        computer::fail_computer_waiters(&mut inner, node_id);
        drop(inner);
        if let Some(pipes) = self.pipes.get() {
            pipes.node_disconnected(node_id, generation).await;
        }
        workspace_rpc::node_disconnected(self, node_id, generation).await;
    }

    pub(crate) async fn call_fs(
        &self,
        node_id: &str,
        request_id: &str,
        message: ServerMessage,
    ) -> Result<ClientMessage, &'static str> {
        let (tx, rx) = oneshot::channel();
        let ticket = uuid::Uuid::new_v4().simple().to_string();
        let outbound = {
            let mut inner = self.inner.lock().await;
            if inner.fs_waiters.contains_key(request_id) {
                return Err("node_fs_busy");
            }
            if inner.fs_waiters.len() >= 32 {
                return Err("node_fs_capacity");
            }
            let node = inner.nodes.get(node_id).ok_or("node_offline")?;
            let outbound = node.outbound.clone().ok_or("node_offline")?;
            let generation = node.generation;
            inner.fs_waiters.insert(
                request_id.to_owned(),
                FsWait {
                    node_id: node_id.to_owned(),
                    generation,
                    ticket: ticket.clone(),
                    deadline: Instant::now() + Duration::from_secs(30),
                    done: tx,
                },
            );
            outbound
        };
        let sent = tokio::time::timeout(
            Duration::from_secs(2),
            outbound.send_text(message.to_json()),
        )
        .await;
        let result = if !matches!(sent, Ok(true)) {
            Err("node_offline")
        } else {
            match tokio::time::timeout(Duration::from_secs(30), rx).await {
                Ok(Ok(message)) => Ok(message),
                _ => Err("node_offline"),
            }
        };
        let mut inner = self.inner.lock().await;
        if inner
            .fs_waiters
            .get(request_id)
            .is_some_and(|wait| wait.ticket == ticket)
        {
            inner.fs_waiters.remove(request_id);
        }
        result
    }

    async fn heartbeat(&self, node_id: &str, generation: u64) {
        let inner = self.inner.lock().await;
        let Some(node) = inner.nodes.get(node_id) else {
            return;
        };
        if node.generation == generation && node.outbound.is_some() {
            drop(inner);
            let _ = self.store.record_heartbeat(node_id);
        }
    }

    async fn expire(&self) {
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        inner.pairings.retain(|_, expiry| *expiry > now);
        inner.pairing_failures.prune(now);
        inner.fs_waiters.retain(|_, wait| wait.deadline > now);
    }

    async fn dispatch(
        &self,
        runtime: &str,
        cwd: &str,
        args: &[String],
        existing_run: Option<&str>,
        scope: &RunScope,
    ) -> Result<(String, RunOutcome), &'static str> {
        let deadline = Instant::now() + NODE_WAIT;
        let (run_id, rx) = loop {
            match self
                .try_dispatch(runtime, cwd, args, existing_run, scope, None)
                .await?
            {
                Some(started) => break started,
                None if Instant::now() >= deadline => return Err("node_runtime_unavailable"),
                None => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        };
        self.await_legacy_dispatch(run_id, rx, RUN_TIMEOUT).await
    }

    async fn await_legacy_dispatch(
        &self,
        run_id: String,
        rx: oneshot::Receiver<Result<RunOutcome, &'static str>>,
        budget: Duration,
    ) -> Result<(String, RunOutcome), &'static str> {
        let result = tokio::time::timeout(budget, rx).await;
        match result {
            Ok(Ok(Ok(outcome))) => Ok((run_id, outcome)),
            Ok(Ok(Err(code))) => Err(code),
            Ok(Err(_)) => Err("node_disconnected"),
            Err(_) => {
                // Expiring the HTTP caller does not attest that B stopped.
                // Keep the dispatch and output owner; explicit retry stays blocked.
                let mut inner = self.inner.lock().await;
                if let Some(run) = inner.runs.get_mut(&run_id)
                    && run.done.as_ref().is_some_and(|done| done.is_closed())
                {
                    run.done.take();
                }
                Err("node_run_timeout")
            }
        }
    }

    async fn try_dispatch(
        &self,
        runtime: &str,
        cwd: &str,
        args: &[String],
        existing_run: Option<&str>,
        scope: &RunScope,
        only_node: Option<&str>,
    ) -> Result<Option<(String, oneshot::Receiver<Result<RunOutcome, &'static str>>)>, &'static str>
    {
        if let Some(run_id) = existing_run {
            return self
                .try_redispatch(run_id, runtime, cwd, args, scope)
                .await
                .map(Some);
        }
        let mut inner = self.inner.lock().await;
        let mut connected = false;
        let mut unsupported_bundle = false;
        let mut selected = None;
        // Unpinned dispatch never chooses the local node. It has no socket.
        // A remote node is only the target when this call pins it, or when
        // it is a connected remote that reported the CLI. B10 still owns
        // making a remote the default mission host.
        if let Some(only) = only_node {
            let Some(node) = inner.nodes.get(only) else {
                return Err("node_runtime_unavailable");
            };
            let Some(outbound) = node.outbound.clone() else {
                return Err("node_runtime_unavailable");
            };
            let Some(cli) = node.clis.iter().find(|cli| cli_is_runnable(cli, runtime)) else {
                return Err("node_cli_unreported");
            };
            if let Some(frozen) = scope.frozen_bundle.as_ref()
                && !node.run_bundle_versions.contains(&frozen.bundle.version)
            {
                return Err("bundle_version_unsupported");
            }
            selected = Some((only.to_owned(), node.generation, cli.path.clone(), outbound));
        }
        for (id, node) in &inner.nodes {
            if only_node.is_some() {
                break;
            }
            let Some(outbound) = node.outbound.clone() else {
                continue;
            };
            connected = true;
            let Some(cli) = node.clis.iter().find(|cli| cli_is_runnable(cli, runtime)) else {
                continue;
            };
            if let Some(frozen) = scope.frozen_bundle.as_ref()
                && !node.run_bundle_versions.contains(&frozen.bundle.version)
            {
                unsupported_bundle = true;
                continue;
            }
            selected = Some((id.clone(), node.generation, cli.path.clone(), outbound));
            break;
        }
        let Some((node_id, generation, program, outbound)) = selected else {
            if unsupported_bundle {
                return Err("bundle_version_unsupported");
            }
            if connected {
                return Err("node_cli_unreported");
            }
            return Ok(None);
        };
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        let bundle = scope
            .frozen_bundle
            .as_ref()
            .map(|frozen| bundle_for_attempt(&frozen.bundle, &run_id, 1, runtime))
            .transpose()?;
        if let Some(bundle) = bundle.as_ref()
            && scope.member_id.as_deref() != Some(bundle.agent_id.as_str())
        {
            return Err("bundle_member_mismatch");
        }
        self.store
            .begin_dispatch(&run_id, 1, &node_id, runtime)
            .map_err(|_| "node_runtime_unavailable")?;
        if let (Some(bundle), Some(frozen)) = (bundle.as_ref(), scope.frozen_bundle.as_ref()) {
            let mut manifest = frozen.manifest.clone();
            manifest["dispatchScope"] =
                json!({"memberId":scope.member_id,"missionId":scope.mission_id});
            if self
                .store
                .freeze_run_bundle(
                    &run_id,
                    &node_id,
                    &bundle.agent_id,
                    runtime,
                    &launch_digest(runtime, cwd, args),
                    bundle,
                    &manifest,
                )
                .is_err()
            {
                let _ = self.store.interrupt(&run_id, 1);
                return Err("bundle_persistence_failed");
            }
        }
        let shim_token = match self.bind_shim(&run_id, 1, &node_id, scope) {
            Ok(token) => token,
            Err(code) => {
                let _ = self.store.interrupt(&run_id, 1);
                return Err(code);
            }
        };
        let start = ServerMessage::Start {
            run_id: run_id.clone(),
            attempt: 1,
            adapter_kind: runtime.to_owned(),
            program,
            args: args.to_vec(),
            cwd: cwd.to_owned(),
            env: Vec::new(),
            shim_token,
            bundle,
        }
        .to_json();
        if start.len() > MAX_FRAME {
            let _ = self.store.interrupt(&run_id, 1);
            return Err("bundle_transport_size");
        }
        let (tx, rx) = oneshot::channel();
        inner.runs.insert(
            run_id.clone(),
            Run {
                node_id: node_id.clone(),
                attempt: 1,
                done: Some(tx),
            },
        );
        drop(inner);
        if !outbound.send_text(start).await {
            self.abandon_unsent(&node_id, generation, &run_id, 1).await;
            return Err("node_disconnected");
        }
        Ok(Some((run_id, rx)))
    }

    async fn try_redispatch(
        &self,
        run_id: &str,
        runtime: &str,
        cwd: &str,
        args: &[String],
        scope: &RunScope,
    ) -> Result<(String, oneshot::Receiver<Result<RunOutcome, &'static str>>), &'static str> {
        let frozen = self
            .store
            .run_bundle(run_id)
            .map_err(|_| "bundle_persistence_failed")?;
        let mut retry_scope = scope.clone();
        if let Some(frozen) = frozen.as_ref() {
            let saved = frozen
                .manifest
                .get("dispatchScope")
                .ok_or("bundle_scope_mismatch")?;
            let mission_id = match &saved["missionId"] {
                Value::Null => None,
                Value::String(value) if valid_scope_id(value, 200) => Some(value.clone()),
                _ => return Err("bundle_scope_mismatch"),
            };
            if saved["memberId"].as_str() != Some(frozen.member_id.as_str())
                || scope
                    .mission_id
                    .as_ref()
                    .is_some_and(|mission| Some(mission) != mission_id.as_ref())
            {
                return Err("bundle_scope_mismatch");
            }
            retry_scope = RunScope {
                member_id: Some(frozen.member_id.clone()),
                mission_id,
                frozen_bundle: None,
            };
            if frozen.launch_digest != launch_digest(runtime, cwd, args) {
                return Err("bundle_launch_mismatch");
            }
            if scope.frozen_bundle.is_some()
                || scope
                    .member_id
                    .as_ref()
                    .is_some_and(|member| member != &frozen.member_id)
            {
                return Err("bundle_member_mismatch");
            }
        }
        let opened = self
            .store
            .open_next_attempt(run_id)
            .map_err(|_| "node_run_not_found")?;
        let (attempt, node_id, stored_runtime) = match opened {
            NextAttempt::Opened {
                attempt,
                node_id,
                runtime,
            } => (attempt, node_id, runtime),
            NextAttempt::StillRunning { .. } => return Err("node_run_still_active"),
            NextAttempt::NotInterrupted => return Err("node_run_not_interrupted"),
            NextAttempt::Missing => return Err("node_run_not_found"),
        };
        if stored_runtime != runtime {
            let _ = self.store.interrupt(run_id, attempt);
            return Err("invalid_node_exec");
        }
        let mut inner = self.inner.lock().await;
        let Some(node) = inner.nodes.get(&node_id) else {
            drop(inner);
            let _ = self.store.interrupt(run_id, attempt);
            return Err("node_runtime_unavailable");
        };
        if let Some(frozen) = frozen.as_ref()
            && (frozen.node_id != node_id
                || !node.run_bundle_versions.contains(&frozen.bundle.version))
        {
            let _ = self.store.interrupt(run_id, attempt);
            return Err("bundle_version_unsupported");
        }
        let generation = node.generation;
        let connected = node.outbound.is_some();
        let program = node
            .clis
            .iter()
            .find(|cli| cli_is_runnable(cli, runtime))
            .map(|cli| cli.path.clone());
        let outbound = node.outbound.clone();
        if !connected || outbound.is_none() {
            drop(inner);
            let _ = self.store.interrupt(run_id, attempt);
            return Err("node_runtime_unavailable");
        }
        let Some(program) = program else {
            drop(inner);
            let _ = self.store.interrupt(run_id, attempt);
            return Err("node_cli_unreported");
        };
        let Some(outbound) = outbound else {
            drop(inner);
            let _ = self.store.interrupt(run_id, attempt);
            return Err("node_runtime_unavailable");
        };
        let scope = match self.scope_for_attempt(run_id, &retry_scope) {
            Ok(scope) => scope,
            Err(code) => {
                let _ = self.store.interrupt(run_id, attempt);
                return Err(code);
            }
        };
        if let Some(frozen) = frozen.as_ref()
            && scope.member_id.as_deref() != Some(frozen.member_id.as_str())
        {
            let _ = self.store.interrupt(run_id, attempt);
            return Err("bundle_member_mismatch");
        }
        let bundle = match frozen
            .as_ref()
            .map(|frozen| bundle_for_attempt(&frozen.bundle, run_id, attempt, runtime))
            .transpose()
        {
            Ok(bundle) => bundle,
            Err(code) => {
                let _ = self.store.interrupt(run_id, attempt);
                return Err(code);
            }
        };
        let shim_token = match self.bind_shim(run_id, attempt, &node_id, &scope) {
            Ok(token) => token,
            Err(code) => {
                let _ = self.store.interrupt(run_id, attempt);
                return Err(code);
            }
        };
        let start = ServerMessage::Start {
            run_id: run_id.to_owned(),
            attempt,
            adapter_kind: runtime.to_owned(),
            program,
            args: args.to_vec(),
            cwd: cwd.to_owned(),
            env: Vec::new(),
            shim_token,
            bundle,
        }
        .to_json();
        if start.len() > MAX_FRAME {
            let _ = self.store.interrupt(run_id, attempt);
            return Err("bundle_transport_size");
        }
        let (tx, rx) = oneshot::channel();
        inner.runs.insert(
            run_id.to_owned(),
            Run {
                node_id: node_id.clone(),
                attempt,
                done: Some(tx),
            },
        );
        drop(inner);
        if !outbound.send_text(start).await {
            self.abandon_unsent(&node_id, generation, run_id, attempt).await;
            return Err("node_disconnected");
        }
        Ok((run_id.to_owned(), rx))
    }

    async fn dispatch_task(
        &self,
        task_id: &str,
        runtime: &str,
        cwd: &str,
        args: &[String],
    ) -> Result<(String, RunOutcome), &'static str> {
        let host = match self
            .store
            .task_execution_host(task_id)
            .map_err(|_| "node_store_unavailable")?
        {
            TaskHost::Missing => return Err("task_not_found"),
            TaskHost::Unpinned => return Err("task_host_unpinned"),
            TaskHost::Pinned(host) => host,
        };
        self.dispatch_pinned(&host, runtime, cwd, args, &RunScope::default())
            .await
    }

    /// Run on the node named by a task pin. The local node uses
    /// `ManagedProcess::spawn` in this process. A remote node is used only
    /// when the task names it.
    async fn dispatch_pinned(
        &self,
        node_id: &str,
        runtime: &str,
        cwd: &str,
        args: &[String],
        scope: &RunScope,
    ) -> Result<(String, RunOutcome), &'static str> {
        let role = self
            .store
            .node_role(node_id)
            .map_err(|_| "node_store_unavailable")?
            .ok_or("node_not_found")?;
        if role == "local" {
            if scope.frozen_bundle.is_some() {
                return Err("bundle_local_dispatch_unsupported");
            }
            return self.spawn_local(node_id, runtime, cwd, args).await;
        }
        let Some((run_id, rx)) = self
            .try_dispatch(runtime, cwd, args, None, scope, Some(node_id))
            .await?
        else {
            return Err("node_runtime_unavailable");
        };
        self.await_legacy_dispatch(run_id, rx, RUN_TIMEOUT).await
    }

    async fn spawn_local(
        &self,
        node_id: &str,
        runtime: &str,
        cwd: &str,
        args: &[String],
    ) -> Result<(String, RunOutcome), &'static str> {
        let program = discovered_local_program(runtime)?;
        if !std::path::Path::new(cwd).is_dir() {
            return Err("invalid_node_exec");
        }
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        self.store
            .begin_dispatch(&run_id, 1, node_id, runtime)
            .map_err(|_| "node_runtime_unavailable")?;
        let outcome = match tokio::time::timeout(
            RUN_TIMEOUT,
            run_managed(&program, args, cwd, &run_id),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                let _ = self.store.interrupt(&run_id, 1);
                return Err("node_run_timeout");
            }
        };
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(code) => {
                let _ = self.store.interrupt(&run_id, 1);
                return Err(code);
            }
        };
        let mut seq = 0u64;
        if !outcome.stdout.is_empty() {
            seq += 1;
            if self
                .store
                .append_output(&run_id, 1, seq, "stdout", &outcome.stdout, MAX_OUTPUT)
                .is_err()
            {
                let _ = self.store.interrupt(&run_id, 1);
                return Err("node_store_unavailable");
            }
        }
        if !outcome.stderr.is_empty() {
            seq += 1;
            if self
                .store
                .append_output(&run_id, 1, seq, "stderr", &outcome.stderr, MAX_OUTPUT)
                .is_err()
            {
                let _ = self.store.interrupt(&run_id, 1);
                return Err("node_store_unavailable");
            }
        }
        seq += 1;
        if self
            .store
            .finish(&run_id, 1, seq, outcome.exit_code)
            .is_err()
        {
            let _ = self.store.interrupt(&run_id, 1);
            return Err("node_store_unavailable");
        }
        Ok((run_id, outcome))
    }

    fn scope_for_attempt(
        &self,
        run_id: &str,
        requested: &RunScope,
    ) -> Result<RunScope, &'static str> {
        if requested.mission_id.is_some() || requested.member_id.is_some() {
            return Ok(requested.clone());
        }
        match self
            .store
            .latest_run_scope(run_id)
            .map_err(|_| "node_store_unavailable")?
        {
            Some((member_id, mission_id)) => Ok(RunScope {
                member_id,
                mission_id,
                frozen_bundle: None,
            }),
            None => Ok(requested.clone()),
        }
    }

    fn bind_shim(
        &self,
        run_id: &str,
        attempt: u32,
        node_id: &str,
        scope: &RunScope,
    ) -> Result<String, &'static str> {
        let token = random_hex(32);
        let digest = digest_hex_kind(RUN_KIND, &token);
        self.store
            .issue_run_credential(
                &digest,
                run_id,
                attempt,
                node_id,
                scope.member_id.as_deref(),
                scope.mission_id.as_deref(),
            )
            .map_err(|_| "node_runtime_unavailable")?;
        Ok(token)
    }

    async fn abandon_unsent(&self, node_id: &str, generation: u64, run_id: &str, attempt: u32) {
        // Sender::send returned Err with the unqueued Start value. Bind this
        // positive unsent result to its original socket and exact dispatch.
        let mut inner = self.inner.lock().await;
        if !inner.nodes.get(node_id).is_some_and(|node| node.generation == generation)
            || !inner.runs.get(run_id).is_some_and(|run|
                run.node_id == node_id && run.attempt == attempt) { return; }
        if self.store.interrupt_unspawned(run_id, attempt).unwrap_or(false) {
            inner.runs.remove(run_id);
        }
    }

    async fn apply_output(
        &self, node_id: &str, generation: u64, run_id: &str,
        stream: OutputStream, seq: u64, data: &str,
    ) {
        let (attempt, outbound, wrote) = {
            // The socket generation, dispatch owner and DB write share this
            // lock. A reconnect cannot slip between admission and persistence.
            let inner = self.inner.lock().await;
            let Some(node) = inner.nodes.get(node_id).filter(|node|
                node.generation == generation && node.outbound.is_some()) else { return; };
            let Some(run) = inner.runs.get(run_id).filter(|run|
                run.node_id == node_id) else { return; };
            let attempt = run.attempt;
            let outbound = node.outbound.clone();
            let stream_name = match stream {
                OutputStream::Stdout => "stdout", OutputStream::Stderr => "stderr",
            };
            let wrote = match STANDARD.decode(data) {
                Ok(bytes) => self.store.append_output(run_id, attempt, seq,
                    stream_name, &bytes, MAX_OUTPUT).map_err(|_| "node_store_unavailable"),
                Err(_) => Err("invalid_output"),
            };
            (attempt, outbound, wrote)
        };
        match wrote {
            Ok(OutputWrite::Stored | OutputWrite::Duplicate) => {
                if let Some(outbound) = outbound { outbound.try_ack(run_id, seq); }
            }
            Ok(OutputWrite::Gap) =>
                self.fail_run(node_id, generation, run_id, attempt, "sequence_gap").await,
            Ok(OutputWrite::TooLarge) =>
                self.fail_run(node_id, generation, run_id, attempt, "output_too_large").await,
            Ok(OutputWrite::Missing) => {},
            Err(code) =>
                self.fail_run(node_id, generation, run_id, attempt, code).await,
        }
    }

    async fn apply_exit(&self, node_id: &str, generation: u64, run_id: &str, seq: u64, code: i32) {
        let (attempt, outbound, wrote) = {
            let mut inner = self.inner.lock().await;
            let Some(node) = inner.nodes.get(node_id).filter(|node|
                node.generation == generation && node.outbound.is_some()) else { return; };
            let outbound = node.outbound.clone();
            let Some(run) = inner.runs.get(run_id).filter(|run|
                run.node_id == node_id) else { return; };
            let attempt = run.attempt;
            let wrote = self.store.finish(run_id, attempt, seq, code);
            if matches!(&wrote, Ok(OutputWrite::Stored)) {
                // Persistence, exact-attempt snapshot and waiter retirement stay
                // under the same owner lock. No unbound lookup after unlocking.
                self.complete_waiter_locked(&mut inner, run_id, node_id, attempt);
            }
            (attempt, outbound, wrote)
        };
        match wrote {
            Ok(OutputWrite::Stored | OutputWrite::Duplicate) => {
                if let Some(outbound) = outbound { outbound.try_ack(run_id, seq); }
            }
            Ok(OutputWrite::Gap) =>
                self.fail_run(node_id, generation, run_id, attempt, "sequence_gap").await,
            Ok(OutputWrite::Missing | OutputWrite::TooLarge) | Err(_) => {},
        }
    }

    fn complete_waiter_locked(&self, inner: &mut Inner, run_id: &str, node_id: &str, attempt: u32) {
        if !inner.runs.get(run_id).is_some_and(|run|
            run.node_id == node_id && run.attempt == attempt) { return; }
        let outcome = self.store.output_for_attempt(run_id, attempt, 1).ok().flatten();
        let done = inner.runs.remove(run_id).and_then(|mut run| run.done.take());
        let Some(done) = done else { return; };
        let Some((dispatch, frames)) = outcome.filter(|(dispatch, _)|
            dispatch.node_id == node_id && dispatch.status == "exited") else {
            let _ = done.send(Err("node_run_not_found"));
            return;
        };
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        for frame in frames {
            match frame.stream.as_str() {
                "stdout" => stdout.extend_from_slice(&frame.data),
                "stderr" => stderr.extend_from_slice(&frame.data),
                _ => {}
            }
        }
        let _ = done.send(Ok(RunOutcome {
            exit_code: dispatch.exit_code.unwrap_or(1), stdout, stderr,
        }));
    }

    async fn fail_run(
        &self, node_id: &str, generation: u64, run_id: &str,
        attempt: u32, code: &'static str,
    ) {
        let mut inner = self.inner.lock().await;
        if !inner.nodes.get(node_id).is_some_and(|node|
            node.generation == generation && node.outbound.is_some()) { return; }
        if let Some(run) = inner.runs.get_mut(run_id)
            && run.node_id == node_id && run.attempt == attempt
            && let Some(done) = run.done.take()
        {
            let _ = done.send(Err(code));
        }
        // Keep ownership and dispatch status: invalid/lost output is not proof
        // of process-tree termination and must not enable another attempt.
    }

    async fn note_rejection(
        &self, node_id: &str, generation: u64, run_id: &str,
        attempt: u32, code: &'static str,
    ) {
        let mut inner = self.inner.lock().await;
        if !inner.nodes.get(node_id).is_some_and(|node|
            node.generation == generation && node.outbound.is_some())
            || !inner.runs.get(run_id).is_some_and(|run|
                run.node_id == node_id && run.attempt == attempt) { return; }
        if rejection_proves_no_process(code) {
            // Contradictory output/cursor leaves the live owner and waiter intact.
            if self.store.interrupt_unspawned(run_id, attempt).unwrap_or(false)
                && let Some(mut run) = inner.runs.remove(run_id)
                && let Some(done) = run.done.take() {
                let _ = done.send(Err(code));
            }
            return;
        }
        // A conflicting duplicate Start cannot steal the original caller.
        if matches!(code, "legacy_start_conflict" | "legacy_start_pending" |
            "legacy_attempt_conflict") { return; }
        if let Some(run) = inner.runs.get_mut(run_id)
            && let Some(done) = run.done.take() {
            let _ = done.send(Err(code));
        }
        // Generic old-peer errors and unknown outcomes never permit another spawn.
    }

    async fn list_nodes(&self) -> Result<Value, &'static str> {
        let nodes = self
            .store
            .list_nodes()
            .map_err(|_| "node_store_unavailable")?;
        let live = {
            let inner = self.inner.lock().await;
            inner
                .nodes
                .iter()
                .filter_map(|(id, node)| {
                    if node.outbound.is_none() {
                        return None;
                    }
                    let kinds = node
                        .clis
                        .iter()
                        .filter(|cli| cli_is_runnable(cli, &cli.adapter_kind))
                        .map(|cli| cli.adapter_kind.clone())
                        .collect::<HashSet<_>>();
                    let computer = node.computer_versions.contains(&COMPUTER_VERSION);
                    Some((id.clone(), (kinds, computer)))
                })
                .collect::<HashMap<_, _>>()
        };
        let rows: Vec<Value> = nodes
            .into_iter()
            .map(|node| {
                let live_kinds = live.get(&node.node_id);
                json!({                    "nodeId": node.node_id,
                    "displayName": node.display_name,
                    "role": node.role,
                    "revocable": node.revocable,
                    "status": node.status,
                    "os": node.os,
                    "arch": node.arch,
                    "pairedAt": node.paired_at,
                    "revokedAt": node.revoked_at,
                    "lastHeartbeat": node.last_heartbeat,
                    "activeRunCount": node.active_runs.len(),
                    "activeRuns": node.active_runs.iter().map(run_json).collect::<Vec<_>>(),
                    "recentRuns": node.recent_runs.iter().map(run_json).collect::<Vec<_>>(),
                    "clis": node.clis.iter().map(|cli| {
                        let live = live_kinds.is_some_and(|(kinds, _)| kinds.contains(&cli.adapter_kind));
                        json!({
                            "adapterKind": cli.adapter_kind,
                            "path": cli.path,
                            "version": cli.version,
                            "pathPresent": cli.path_present,
                            "reportedAt": cli.reported_at,
                            "availability": cli_availability(node.status == "online", cli.path_present, live),
                        })
                    }).collect::<Vec<_>>(),
                    // Additive: whether this node currently advertises the
                    // computer transport. A node without a desktop reports
                    // false and is never offered as a screen target.
                    "computer": {
                        "advertised": live_kinds.is_some_and(|(_, computer)| *computer),
                        "version": COMPUTER_VERSION,
                    },
                })
            })
            .collect();
        Ok(json!({ "nodes": rows }))
    }

    fn output_from(&self, run_id: &str, from_seq: u64) -> Result<Value, &'static str> {
        let Some((dispatch, mut frames)) = self
            .store
            .output_from(run_id, from_seq)
            .map_err(|_| "node_store_unavailable")?
        else {
            return Err("node_run_not_found");
        };
        let truncated = frames.len() > OUTPUT_PAGE;
        if truncated {
            frames.truncate(OUTPUT_PAGE);
        }
        let next_from = frames.last().map(|frame| frame.seq.saturating_add(1));
        Ok(json!({
            "runId": dispatch.run_id,
            "attempt": dispatch.attempt,
            "nodeId": dispatch.node_id,
            "runtime": dispatch.runtime,
            "status": dispatch.status,
            "ackedSeq": dispatch.acked_seq,
            "exitCode": dispatch.exit_code,
            "frames": frames.iter().map(|frame| json!({
                "seq": frame.seq,
                "stream": frame.stream,
                "data": STANDARD.encode(&frame.data),
            })).collect::<Vec<_>>(),
            "truncated": truncated,
            "nextFrom": next_from,
        }))
    }

    async fn revoke(&self, node_id: &str) -> Result<Value, &'static str> {
        let result = self
            .store
            .revoke(node_id)
            .map_err(|_| "node_store_unavailable")?;
        let revoked_at = match result {
            RevokeResult::Local => return Err("node_not_revocable"),
            RevokeResult::Missing => return Err("node_not_found"),
            RevokeResult::Revoked { revoked_at } | RevokeResult::Already { revoked_at } => {
                revoked_at
            }
        };
        let running = self
            .store
            .running_for_node(node_id)
            .map_err(|_| "node_store_unavailable")?;
        for run in running {
            let _ = self.store.interrupt(&run.run_id, run.attempt);
        }
        let mut inner = self.inner.lock().await;
        inner.revoked.insert(node_id.to_owned());
        if let Some(node) = inner.nodes.get_mut(node_id) {
            if let Some(outbound) = &node.outbound {
                outbound.try_text(
                    ServerMessage::Error {
                        code: "token_revoked".into(),
                    }
                    .to_json(),
                );
            }
            if let Some(cancel) = node.cancel.take() {
                let _ = cancel.send(());
            }
            node.outbound = None;
            node.generation = node.generation.saturating_add(1);
        }
        fail_node_waiters(&mut inner, node_id);
        computer::fail_computer_waiters(&mut inner, node_id);
        Ok(json!({
            "nodeId": node_id,
            "revokedAt": revoked_at,
            "status": "offline",
        }))
    }

    async fn handle(self: Arc<Self>, socket: WebSocket, peer: IpAddr) {
        let (mut sink, mut stream) = socket.split();
        let acks = Arc::new(StdMutex::new(HashMap::new()));
        let (tx, mut incoming) = mpsc::channel(OUTBOUND_QUEUE);
        let (urgent_tx, mut urgent_incoming) = mpsc::channel(16);
        let writer_acks = Arc::clone(&acks);
        let mut writer = tokio::spawn(async move {
            loop {
                let Some(item) = receive_outbound(&mut urgent_incoming, &mut incoming).await else {
                    break;
                };
                if flush_acks(&mut sink, &writer_acks).await.is_err() {
                    break;
                }
                let message = match item {
                    Outbound::Text(text) => Message::Text(text.into()),
                    Outbound::Pong(data) => Message::Pong(data.into()),
                    Outbound::FlushAcks => continue,
                };
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
        });
        let outbound = Outbox {
            tx: tx.clone(),
            urgent: Some(urgent_tx.clone()),
            acks,
        };
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        let mut stored_cancel = Some(cancel_tx);
        let mut attached: Option<(String, u64)> = None;
        let deadline = Instant::now() + HELLO_DEADLINE;
        let mut welcomed = false;
        loop {
            let frame = if welcomed {
                tokio::select! {
                    _ = &mut cancel_rx => break,
                    frame = stream.next() => frame,
                }
            } else {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    outbound.try_text(
                        ServerMessage::Error {
                            code: "hello_timeout".into(),
                        }
                        .to_json(),
                    );
                    break;
                }
                tokio::select! {
                    _ = &mut cancel_rx => break,
                    frame = tokio::time::timeout(remaining, stream.next()) => match frame {
                        Ok(frame) => frame,
                        Err(_) => {
                            outbound.try_text(
                                ServerMessage::Error {
                                    code: "hello_timeout".into(),
                                }
                                .to_json(),
                            );
                            break;
                        }
                    },
                }
            };
            let Some(frame) = frame else { break };
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(data) => outbound.try_pong(data.to_vec()),
                Message::Close(_) => break,
                Message::Text(text) => {
                    if text.len() > MAX_FRAME {
                        break;
                    }
                    let message = match serde_json::from_str::<ClientMessage>(text.as_str()) {
                        Ok(message) => message,
                        Err(_) => {
                            outbound.try_text(
                                ServerMessage::Error {
                                    code: "invalid_frame".into(),
                                }
                                .to_json(),
                            );
                            break;
                        }
                    };
                    match message {
                        ClientMessage::Pair { pairing_code } => {
                            if welcomed {
                                break;
                            }
                            match self.redeem(&pairing_code, peer).await {
                                Ok(issued) => {
                                    outbound.try_text(
                                        ServerMessage::Paired {
                                            node_id: issued.node_id,
                                            token: issued.token,
                                        }
                                        .to_json(),
                                    );
                                }
                                Err(code) => {
                                    outbound.try_text(
                                        ServerMessage::Error { code: code.into() }.to_json(),
                                    );
                                    break;
                                }
                            }
                        }
                        ClientMessage::Hello {
                            node_id,
                            token,
                            os,
                            arch,
                            clis,
                            runs,
                            hostname,
                            run_bundle_versions,
                            process_pipe_versions,
                            workspace_rpc_versions,
                            computer_versions,
                        } => {
                            if run_bundle_versions.len() > 8
                                || process_pipe_versions.len() > 8
                                || workspace_rpc_versions.len() > 8
                                || computer_versions.len() > 8
                                || runs.len() > 32
                                || runs.iter().any(|run| {
                                    run.run_id.len() > 80
                                        || run.run_id.is_empty()
                                        || run.attempt == 0
                                })
                            {
                                outbound.try_text(
                                    ServerMessage::Error {
                                        code: "invalid_hello".into(),
                                    }
                                    .to_json(),
                                );
                                break;
                            }
                            if welcomed {
                                break;
                            }
                            let Some(cancel_tx) = stored_cancel.take() else {
                                break;
                            };
                            match self.authorize(&node_id, &token).await {
                                Err(code) => {
                                    outbound.try_text(
                                        ServerMessage::Error { code: code.into() }.to_json(),
                                    );
                                    break;
                                }
                                Ok(()) => {
                                    match self
                                        .attach(
                                            &node_id,
                                            outbound.clone(),
                                            cancel_tx,
                                            &os,
                                            &arch,
                                            clis,
                                        )
                                        .await
                                    {
                                        Ok(generation) => {
                                            self.set_run_bundle_versions(
                                                &node_id,
                                                generation,
                                                run_bundle_versions,
                                            )
                                            .await;
                                            self.set_process_versions(
                                                &node_id,
                                                generation,
                                                process_pipe_versions,
                                                workspace_rpc_versions,
                                            )
                                            .await;
                                            self.set_computer_versions(
                                                &node_id,
                                                generation,
                                                computer_versions,
                                            )
                                            .await;
                                            let _ = self
                                                .store
                                                .adopt_reported_hostname(&node_id, &hostname);
                                            attached = Some((node_id.clone(), generation));
                                            let resumes = self.reconcile(&node_id, generation, &runs).await;
                                            welcomed = true;
                                            if !outbound
                                                .send_text(
                                                    ServerMessage::Welcome {
                                                        node_id: node_id.clone(),
                                                    }
                                                    .to_json(),
                                                )
                                                .await
                                            {
                                                break;
                                            }
                                            let connected_hub = Arc::clone(&self);
                                            let connected_node = node_id.clone();
                                            tokio::spawn(async move {
                                                if !connected_hub
                                                    .current_connection(&connected_node, generation)
                                                    .await
                                                {
                                                    return;
                                                }
                                                if let Some(pipes) = connected_hub.pipes.get() {
                                                    pipes
                                                        .node_connected(
                                                            &connected_node,
                                                            &generation,
                                                        )
                                                        .await;
                                                }
                                                workspace_rpc::node_connected(
                                                    connected_hub,
                                                    connected_node,
                                                    generation,
                                                )
                                                .await;
                                            });
                                            for resume in resumes {
                                                if !outbound.send_text(resume.to_json()).await {
                                                    break;
                                                }
                                            }
                                        }
                                        Err(code) => {
                                            outbound.try_text(
                                                ServerMessage::Error { code: code.into() }
                                                    .to_json(),
                                            );
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        ClientMessage::ProcessPipeOutput { output } => {
                            if let Some((node_id, generation)) = &attached
                                && self.current_connection(node_id, *generation).await
                                && let Some(pipes) = self.pipes.get()
                            {
                                pipes.on_output(node_id, *generation, output).await;
                            }
                        }
                        ClientMessage::ProcessPipeControl { control } => {
                            if let Some((node_id, generation)) = &attached
                                && self.current_connection(node_id, *generation).await
                                && let Some(pipes) = self.pipes.get()
                            {
                                pipes.on_reply(node_id, *generation, control).await;
                            }
                        }
                        ClientMessage::WorkspaceRpcEvent { event } => {
                            if let Some((node_id, generation)) = &attached
                                && self.current_connection(node_id, *generation).await
                            {
                                workspace_rpc::handle_event(
                                    Arc::clone(&self),
                                    node_id,
                                    *generation,
                                    event,
                                )
                                .await;
                            }
                        }
                        ClientMessage::WorkspaceRpcRejected { rejection } => {
                            if let Some((node_id, generation)) = &attached
                                && self.current_connection(node_id, *generation).await
                            {
                                workspace_rpc::handle_rejection(
                                    Arc::clone(&self),
                                    node_id,
                                    *generation,
                                    rejection,
                                )
                                .await;
                            }
                        }
                        ClientMessage::ComputerReply { reply } => {
                            // The waiter itself re-checks the node id and the
                            // connection generation; a reply from a replaced
                            // socket is discarded, never delivered.
                            if let Some((node_id, generation)) = &attached {
                                self.handle_computer_reply(node_id, *generation, reply).await;
                            }
                        }
                        ClientMessage::ComputerFrameChunk { chunk } => {
                            if let Some((node_id, generation)) = &attached {
                                self.handle_computer_chunk(node_id, *generation, chunk).await;
                            }
                        }
                        ClientMessage::BuiltinCall { call } => {
                            if let Some((node_id, generation)) = &attached {
                                self.handle_builtin_call(node_id, *generation, call).await;
                            }
                        }
                        ClientMessage::Heartbeat { .. } => {
                            if let Some((node_id, generation)) = &attached {
                                self.heartbeat(node_id, *generation).await;
                                outbound.try_text(ServerMessage::HeartbeatAck.to_json());
                            }
                        }
                        ClientMessage::Output {
                            run_id,
                            stream,
                            seq,
                            data,
                        } => {
                            if let Some((node_id, generation)) = &attached {
                                self.apply_output(
                                    node_id,
                                    *generation,
                                    &run_id,
                                    stream,
                                    seq,
                                    &data,
                                )
                                .await;
                            }
                        }
                        ClientMessage::Exit {
                            run_id,
                            seq,
                            exit_code,
                        } => {
                            if let Some((node_id, generation)) = &attached {
                                self.apply_exit(node_id, *generation, &run_id, seq, exit_code)
                                    .await;
                            }
                        }
                        message @ ClientMessage::FsResult { .. } => {
                            let ClientMessage::FsResult { request_id, .. } = &message else {
                                continue;
                            };
                            let request_id = request_id.clone();
                            let Some((node_id, generation)) = &attached else {
                                continue;
                            };
                            let mut inner = self.inner.lock().await;
                            let current = inner.nodes.get(node_id).is_some_and(|node| {
                                node.generation == *generation && node.outbound.is_some()
                            });
                            let expected = inner.fs_waiters.get(&request_id).is_some_and(|wait| {
                                wait.node_id == *node_id && wait.generation == *generation
                            });
                            if current
                                && expected
                                && let Some(wait) = inner.fs_waiters.remove(&request_id)
                            {
                                let _ = wait.done.send(message);
                            }
                        }
                        ClientMessage::AlreadyRunning { .. } => {}
                        ClientMessage::Rejected {
                            run_id,
                            attempt,
                            code,
                        } => {
                            if let Some((node_id, generation)) = &attached {
                                let failure = node_rejection_code(&code);
                                self.note_rejection(
                                    node_id,
                                    *generation,
                                    &run_id,
                                    attempt,
                                    failure,
                                )
                                .await;
                            }
                        }
                    }
                }
                Message::Binary(_) | Message::Pong(_) => {}
            }
        }
        if let Some((node_id, generation)) = attached {
            self.detach(&node_id, generation).await;
        }
        drop(outbound);
        drop(stored_cancel);
        drop(tx);
        drop(urgent_tx);
        if tokio::time::timeout(Duration::from_secs(2), &mut writer).await.is_err() {
            // An unresponsive peer cannot keep a detached writer alive forever.
            // No successful delivery or process completion is inferred here.
            writer.abort();
            let _ = writer.await;
        }
    }
}

async fn flush_acks(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    acks: &StdMutex<HashMap<String, u64>>,
) -> Result<(), ()> {
    let pending: Vec<(String, u64)> = {
        let mut acks = acks.lock().map_err(|_| ())?;
        acks.drain().collect()
    };
    for (run_id, seq) in pending {
        let text = ServerMessage::Ack { run_id, seq }.to_json();
        sink.send(Message::Text(text.into()))
            .await
            .map_err(|_| ())?;
    }
    Ok(())
}

fn run_json(run: &DispatchRecord) -> Value {
    json!({
        "runId": run.run_id,
        "attempt": run.attempt,
        "runtime": run.runtime,
        "status": run.status,
        "ackedSeq": run.acked_seq,
        "exitCode": run.exit_code,
        "startedAt": run.started_at,
    })
}

fn fail_node_waiters(inner: &mut Inner, node_id: &str) {
    let ids: Vec<String> = inner
        .runs
        .iter()
        .filter(|(_, run)| run.node_id == node_id && run.done.is_some())
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(run) = inner.runs.get_mut(&id)
            && let Some(done) = run.done.take()
        {
            let _ = done.send(Err("node_disconnected"));
        }
    }
    let fs_ids: Vec<String> = inner
        .fs_waiters
        .iter()
        .filter(|(_, wait)| wait.node_id == node_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in fs_ids {
        inner.fs_waiters.remove(&id);
    }
}

fn keyed_digest(kind: &[u8], token: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(kind);
    hash.update(token.as_bytes());
    hash.finalize().into()
}

fn digest_hex(token: &str) -> String {
    digest_hex_kind(NODE_KIND, token)
}

fn digest_hex_kind(kind: &[u8], token: &str) -> String {
    keyed_digest(kind, token)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_credential(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Public origin wins, as `wss://` or `ws://` plus the connect path.
/// Without one, the listen address is the only target and the caller must
/// warn that machine B has to be able to reach it.
pub(crate) fn connect_target(listen: SocketAddr, public_origin: Option<&str>) -> (String, bool) {
    if let Some(origin) = public_origin
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
    {
        let base = if let Some(rest) = origin.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = origin.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            origin.to_owned()
        };
        let base = base.trim_end_matches('/');
        return (format!("{base}{CONNECT_PATH}"), false);
    }
    (format!("ws://{listen}{CONNECT_PATH}"), true)
}

fn random_hex(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    getrandom::fill(&mut buf).expect("system random source");
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) async fn connect(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<WebState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !state.network.listen.ip().is_loopback() {
        return error(StatusCode::FORBIDDEN, "node_channel_requires_loopback");
    }
    if let Some(token) = bearer(&headers)
        && (state.sessions.is_administrator(token) || state.sessions.authenticate(token).is_some())
    {
        return error(StatusCode::FORBIDDEN, "node_channel_rejects_administrator");
    }
    let hub = Arc::clone(&state.nodes);
    let peer = peer.ip();
    ws.max_frame_size(MAX_FRAME)
        .max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| async move { hub.handle(socket, peer).await })
        .into_response()
}

pub(crate) async fn pair(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
) -> Response {
    if !state.network.listen.ip().is_loopback() {
        return error(StatusCode::FORBIDDEN, "node_channel_requires_loopback");
    }
    let (code, expires_in_seconds) = state.nodes.issue_pairing().await;
    let (connect_url, reachability_warning) =
        connect_target(state.network.listen, state.network.public_origin());
    Json(json!({
        "pairingCode": code,
        "expiresInSeconds": expires_in_seconds,
        "connectUrl": connect_url,
        "reachabilityWarning": reachability_warning,
    }))
    .into_response()
}

pub(crate) async fn list(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
) -> Response {
    match state.nodes.list_nodes().await {
        Ok(body) => Json(body).into_response(),
        Err(code) => error(StatusCode::SERVICE_UNAVAILABLE, code),
    }
}

pub(crate) async fn output(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
    Path((run_id, from)): Path<(String, u64)>,
) -> Response {
    if run_id.is_empty() || run_id.len() > 80 {
        return error(StatusCode::NOT_FOUND, "node_run_not_found");
    }
    match state.nodes.output_from(&run_id, from) {
        Ok(body) => Json(body).into_response(),
        Err("node_run_not_found") => error(StatusCode::NOT_FOUND, "node_run_not_found"),
        Err(code) => error(StatusCode::SERVICE_UNAVAILABLE, code),
    }
}

pub(crate) async fn revoke(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
    Path(node_id): Path<String>,
) -> Response {
    if node_id.is_empty() || node_id.len() > 80 {
        return error(StatusCode::NOT_FOUND, "node_not_found");
    }
    match state.nodes.revoke(&node_id).await {
        Ok(body) => Json(body).into_response(),
        Err("node_not_found") => error(StatusCode::NOT_FOUND, "node_not_found"),
        Err("node_not_revocable") => error(StatusCode::CONFLICT, "node_not_revocable"),
        Err(code) => error(StatusCode::SERVICE_UNAVAILABLE, code),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecRequest {
    runtime: String,
    cwd: String,
    args: Vec<String>,
    #[serde(default)]
    run_id: Option<String>,
    /// Mission the shim's `rovai loom status` reads on A. Absent means no mission.
    #[serde(default)]
    mission_id: Option<String>,
    /// Member the shim credential acts as. The child cannot choose another one.
    #[serde(default)]
    member_id: Option<String>,
}

pub(crate) async fn exec(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
    body: Result<Json<ExecRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "invalid_node_exec");
    };
    if let Err(code) = validate_exec(&body) {
        return error(StatusCode::BAD_REQUEST, code);
    }
    let frozen_bundle = if body.run_id.is_none() {
        if let Some(member_id) = body.member_id.as_ref() {
            let reply = match tokio::time::timeout(
                Duration::from_secs(30),
                state.core.request(
                    "members.runBundle.freeze",
                    json!({"memberId":member_id,"runtime":body.runtime}),
                ),
            )
            .await
            {
                Ok(Ok(reply)) => reply,
                _ => return error(StatusCode::SERVICE_UNAVAILABLE, "bundle_source_unavailable"),
            };
            if let Some(failure) = reply.error {
                if failure["code"]
                    .as_str()
                    .is_some_and(|code| code.starts_with("bundle_"))
                {
                    return (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(json!({"error":failure})),
                    )
                        .into_response();
                }
                return error(StatusCode::SERVICE_UNAVAILABLE, "bundle_source_unavailable");
            }
            match serde_json::from_value::<FrozenMemberBundle>(reply.result.unwrap_or(Value::Null))
            {
                Ok(frozen) => Some(frozen),
                Err(_) => {
                    return error(StatusCode::SERVICE_UNAVAILABLE, "bundle_source_unavailable");
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    let scope = RunScope {
        mission_id: body.mission_id.clone(),
        member_id: body.member_id.clone(),
        frozen_bundle,
    };
    match state
        .nodes
        .dispatch(
            &body.runtime,
            &body.cwd,
            &body.args,
            body.run_id.as_deref(),
            &scope,
        )
        .await
    {
        Ok((run_id, outcome)) => Json(json!({
            "runId": run_id,
            "exitCode": outcome.exit_code,
            "stdout": STANDARD.encode(outcome.stdout),
            "stderr": STANDARD.encode(outcome.stderr),
        }))
        .into_response(),
        Err(code) => exec_error(code),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskExecRequest {
    task_id: String,
    runtime: String,
    cwd: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareWorkspaceRequest {
    mission_id: String,
    camp_id: String,
    node_id: String,
    source: String,
}

// A remote source is an executor-local path. Only that executor can apply its
// platform's absolute-path rules; prepare_git_worktree rechecks it before Git I/O.
fn valid_workspace_source(source: &str, local: bool) -> bool {
    !source.is_empty()
        && source.len() <= 4096
        && !source.contains('\0')
        && (!local || std::path::Path::new(source).is_absolute())
}

pub(crate) async fn prepare_workspace(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
    body: Result<Json<PrepareWorkspaceRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
    };
    if !valid_scope_id(&body.mission_id, 80)
        || !valid_scope_id(&body.camp_id, 80)
        || !valid_scope_id(&body.node_id, 80)
    {
        return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
    }
    let role = match state.nodes.store.node_role(&body.node_id) {
        Ok(Some(role)) => role,
        Ok(None) => return workspace_error(StatusCode::NOT_FOUND, "node_not_found"),
        Err(_) => {
            return workspace_error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable");
        }
    };
    if !valid_workspace_source(&body.source, role == "local") {
        return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
    }
    if let Ok(Some(existing)) = state.nodes.store.workspace_by_mission(&body.mission_id) {
        return Json(workspace_json(&existing)).into_response();
    }
    let branch = match loom_protocol::safe_branch(&body.mission_id) {
        Ok(branch) => branch,
        Err(code) => return workspace_error(StatusCode::BAD_REQUEST, code),
    };
    let workspace_id = format!("ws_{}", uuid::Uuid::new_v4().simple());
    let prepared = if role == "local" {
        let directory = match state.nodes.store.sqlite_directory() {
            Ok(directory) => directory,
            Err(_) => {
                return workspace_error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable");
            }
        };
        let worktree = directory.join("worktrees").join(branch.replace('/', "_"));
        match loom_protocol::prepare_git_worktree(
            std::path::Path::new(&body.source),
            &worktree,
            &branch,
        ) {
            Ok(prepared) => prepared,
            Err(code) => return workspace_error(StatusCode::CONFLICT, code),
        }
    } else {
        let request_id = workspace_id.clone();
        let message = match state
            .nodes
            .call_fs(
                &body.node_id,
                &request_id,
                ServerMessage::PrepareWorktree {
                    request_id: request_id.clone(),
                    source: body.source.clone(),
                    worktree: String::new(),
                    branch: branch.clone(),
                },
            )
            .await
        {
            Ok(message) => message,
            Err(code) => return workspace_error(StatusCode::CONFLICT, code),
        };
        let ClientMessage::FsResult {
            code,
            worktree,
            source,
            common_dir,
            base_sha,
            branch,
            ..
        } = message
        else {
            return workspace_error(StatusCode::CONFLICT, "node_offline");
        };
        if !code.is_empty() {
            return workspace_error(StatusCode::CONFLICT, leak_code(&code));
        }
        loom_protocol::PreparedWorktree {
            worktree,
            source,
            common_dir,
            base_sha,
            branch,
        }
    };
    let record = WorkspaceRecord {
        id: workspace_id,
        mission_id: body.mission_id,
        camp_id: body.camp_id,
        execution_host_id: body.node_id,
        source_directory: prepared.source.clone(),
        repository_root: prepared.source,
        git_common_dir: prepared.common_dir,
        worktree_path: prepared.worktree,
        branch: prepared.branch,
        base_sha: prepared.base_sha,
        owner_name: String::new(),
        owner_role: role,
        last_heartbeat: None,
    };
    if state.nodes.store.save_workspace(&record).is_err() {
        return workspace_error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable");
    }
    let Some(saved) = state
        .nodes
        .store
        .workspace_by_mission(&record.mission_id)
        .ok()
        .flatten()
    else {
        return workspace_error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable");
    };
    Json(workspace_json(&saved)).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFilesQuery {
    mission_id: Option<String>,
    thread_id: Option<String>,
    #[serde(default)]
    relative: String,
    #[serde(default)]
    op: String,
}

// A remote workspace root is opaque to this Host. In particular a Windows
// drive path is not an absolute Linux Path. Only the execution node can
// resolve its root and enforce the canonical/symlink jail. The Host still
// rejects every non-portable or parent-relative request before dispatch.
pub(crate) fn workspace_query_relative(role: &str, root: &str, raw: &str) -> Result<String, &'static str> {
    if role == "local" {
        return loom_protocol::workspace_relative(root, raw);
    }
    if role != "remote" || raw.len() > 4096 || raw.contains('\0') || raw.contains(':')
        || raw.starts_with('/') || raw.starts_with('\\')
    {
        return Err("path_rejected");
    }
    let portable = raw.replace('\\', "/");
    let mut parts = Vec::new();
    for part in portable.split('/') {
        if part == ".." || (part != "." && (part.ends_with('.') || part.ends_with(' '))) {
            return Err("path_rejected");
        }
        if !part.is_empty() && part != "." { parts.push(part); }
    }
    Ok(parts.join("/"))
}

pub(crate) async fn workspace_files(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
    body: Result<Json<WorkspaceFilesQuery>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(query)) = body else {
        return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
    };
    let record = if let Some(mission_id) = query.mission_id.as_deref() {
        if !valid_scope_id(mission_id, 80) {
            return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
        }
        state.nodes.store.workspace_by_mission(mission_id)
    } else if let Some(thread_id) = query.thread_id.as_deref() {
        if !valid_scope_id(thread_id, 80) {
            return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
        }
        state.nodes.store.workspace_by_camp(thread_id)
    } else {
        return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
    };
    let record = match record {
        Ok(Some(record)) => record,
        Ok(None) => return workspace_error(StatusCode::NOT_FOUND, "workspace_not_found"),
        Err(_) => {
            return workspace_error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable");
        }
    };
    let relative = match workspace_query_relative(&record.owner_role, &record.worktree_path, &query.relative) {
        Ok(relative) => relative,
        Err(code) => return workspace_error(StatusCode::BAD_REQUEST, code),
    };
    let read = query.op == "read";
    if record.owner_role == "local" {
        let root = std::path::Path::new(&record.worktree_path);
        return if read {
            match loom_protocol::read_file(root, &query.relative) {
                Ok((bytes, truncated)) => {
                    let size = bytes.len();
                    Json(json!({
                        "ownerName": record.owner_name,
                        "lastHeartbeat": record.last_heartbeat,
                        "relative": query.relative,
                        "data": STANDARD.encode(bytes),
                        "size": size,
                        "truncated": truncated,
                    }))
                    .into_response()
                }
                Err(code) => workspace_failure(StatusCode::BAD_REQUEST, code, Some(&record)),
            }
        } else {
            match loom_protocol::list_directory(root, &query.relative) {
                Ok((entries, truncated)) => Json(json!({
                    "ownerName": record.owner_name,
                    "ownerRole": record.owner_role,
                    "lastHeartbeat": record.last_heartbeat,
                    "online": true,
                    "relative": query.relative,
                    "entries": entries,
                    "truncated": truncated,
                }))
                .into_response(),
                Err(code) => workspace_failure(StatusCode::BAD_REQUEST, code, Some(&record)),
            }
        };
    }
    let request_id = format!("fs_{}", uuid::Uuid::new_v4().simple());
    let message = if read {
        ServerMessage::ReadFile {
            request_id: request_id.clone(),
            root: record.worktree_path.clone(),
            relative: relative.clone(),
        }
    } else {
        ServerMessage::ListDir {
            request_id: request_id.clone(),
            root: record.worktree_path.clone(),
            relative: relative.clone(),
        }
    };
    let reply = match state
        .nodes
        .call_fs(&record.execution_host_id, &request_id, message)
        .await
    {
        Ok(reply) => reply,
        Err(code) => return workspace_failure(StatusCode::CONFLICT, code, Some(&record)),
    };
    let ClientMessage::FsResult {
        code,
        entries,
        data,
        truncated,
        ..
    } = reply
    else {
        return workspace_failure(StatusCode::CONFLICT, "node_offline", Some(&record));
    };
    if !code.is_empty() {
        return workspace_failure(StatusCode::BAD_REQUEST, leak_code(&code), Some(&record));
    }
    if read {
        let size = STANDARD.decode(&data).map(|bytes| bytes.len()).unwrap_or(0);
        Json(json!({
            "ownerName": record.owner_name,
            "lastHeartbeat": record.last_heartbeat,
            "relative": query.relative,
            "data": data,
            "size": size,
            "truncated": truncated,
        }))
        .into_response()
    } else {
        Json(json!({
            "ownerName": record.owner_name,
            "ownerRole": record.owner_role,
            "lastHeartbeat": record.last_heartbeat,
            "online": true,
            "relative": query.relative,
            "entries": entries,
            "truncated": truncated,
        }))
        .into_response()
    }
}

fn workspace_json(record: &WorkspaceRecord) -> Value {
    json!({
        "missionId": record.mission_id,
        "campId": record.camp_id,
        "nodeId": record.execution_host_id,
        "ownerName": record.owner_name,
        "ownerRole": record.owner_role,
        "worktree": record.worktree_path,
        "source": record.source_directory,
        "branch": record.branch,
        "baseSha": record.base_sha,
    })
}

fn workspace_error(status: StatusCode, code: &'static str) -> Response {
    workspace_failure(status, code, None)
}

fn workspace_failure(
    status: StatusCode,
    code: &'static str,
    record: Option<&WorkspaceRecord>,
) -> Response {
    let message = match code {
        "node_offline" => "这台机器不在线",
        "path_rejected" => "路径超出工作区",
        "not_found" | "not_file" => "文件读取失败",
        _ => "",
    };
    let mut body = json!({"error":{"code":code,"message":message}});
    if let Some(record) = record {
        body["error"]["ownerName"] = json!(record.owner_name);
        if let Some(heartbeat) = &record.last_heartbeat {
            body["error"]["lastHeartbeat"] = json!(heartbeat);
        }
    }
    (status, Json(body)).into_response()
}

fn leak_code(code: &str) -> &'static str {
    match code {
        "path_rejected" => "path_rejected",
        "not_found" => "not_found",
        "not_directory" => "not_directory",
        "not_file" => "not_file",
        "invalid_workspace" => "invalid_workspace",
        "node_offline" => "node_offline",
        _ => "node_rejected",
    }
}

pub(crate) async fn task_exec(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
    body: Result<Json<TaskExecRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "invalid_node_exec");
    };
    if !valid_scope_id(&body.task_id, 200) {
        return error(StatusCode::BAD_REQUEST, "invalid_node_exec");
    }
    let probe = ExecRequest {
        runtime: body.runtime.clone(),
        cwd: body.cwd.clone(),
        args: body.args.clone(),
        run_id: None,
        mission_id: None,
        member_id: None,
    };
    if let Err(code) = validate_exec(&probe) {
        return error(StatusCode::BAD_REQUEST, code);
    }
    match state
        .nodes
        .dispatch_task(&body.task_id, &body.runtime, &body.cwd, &body.args)
        .await
    {
        Ok((run_id, outcome)) => Json(json!({
            "runId": run_id,
            "exitCode": outcome.exit_code,
            "stdout": STANDARD.encode(outcome.stdout),
            "stderr": STANDARD.encode(outcome.stderr),
        }))
        .into_response(),
        Err(code) => exec_error(code),
    }
}

fn validate_exec(body: &ExecRequest) -> Result<(), &'static str> {
    if body.runtime.is_empty()
        || body.runtime.len() > 64
        || !body
            .runtime
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid_node_exec");
    }
    if body.cwd.is_empty() || body.cwd.len() > 4096 || body.cwd.contains('\0') {
        return Err("invalid_node_exec");
    }
    if body.args.len() > 64
        || body
            .args
            .iter()
            .any(|arg| arg.len() > 32_768 || arg.contains('\0'))
    {
        return Err("invalid_node_exec");
    }
    if let Some(run_id) = &body.run_id
        && (run_id.is_empty()
            || run_id.len() > 80
            || !run_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'))
    {
        return Err("invalid_node_exec");
    }
    if let Some(mission_id) = &body.mission_id
        && !valid_scope_id(mission_id, 200)
    {
        return Err("invalid_node_exec");
    }
    if let Some(member_id) = &body.member_id
        && !valid_scope_id(member_id, 80)
    {
        return Err("invalid_node_exec");
    }
    Ok(())
}

fn valid_scope_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

fn node_rejection_code(code: &str) -> &'static str {
    // Never echo an arbitrary node-supplied string through the trusted error API.
    const KNOWN: &[&str] = &[
        "program_not_allowed",
        "invalid_run_id",
        "process_gone",
        "legacy_environment",
        "legacy_prepare_failed",
        "legacy_no_process",
        "legacy_start_pending",
        "legacy_start_conflict",
        "legacy_attempt_conflict",
        "legacy_outcome_unknown",
        "legacy_history_unknown",
        "legacy_journal_storage",
        "legacy_journal_busy",
        "legacy_journal_identity",
        "legacy_launch_identity",
        "legacy_phase_conflict",
        "legacy_platform_unsupported",
        "legacy_capacity",
        "legacy_stopping",
        "bundle_version",
        "bundle_identity",
        "bundle_run_identity",
        "bundle_adapter",
        "bundle_digest",
        "bundle_path",
        "bundle_duplicate",
        "bundle_order",
        "bundle_count",
        "bundle_size",
        "bundle_content",
        "bundle_artifact",
        "bundle_missing_bootstrap",
        "bundle_skill_root",
        "bundle_skill_index",
        "bundle_native_config",
        "bundle_native_arg_conflict",
        "bundle_hooks_trust_required",
        "bundle_private_storage",
        "bundle_native_args_too_large",
        "bundle_platform_unsupported",
    ];
    KNOWN
        .iter()
        .copied()
        .find(|known| *known == code)
        .unwrap_or("node_rejected")
}

fn rejection_proves_no_process(code: &str) -> bool {
    // Only new Nodes emit this after an exact durable NoProcess transition.
    // Old peers may validate a conflicting Start before looking up its live owner.
    code == "legacy_no_process"
}

fn exec_error(code: &'static str) -> Response {
    let status = match code {
        "invalid_node_exec" => StatusCode::BAD_REQUEST,
        code if code.starts_with("bundle_") => StatusCode::UNPROCESSABLE_ENTITY,
        "node_runtime_unavailable"
        | "node_run_still_active"
        | "node_run_not_interrupted"
        | "node_cli_unreported"
        | "task_host_unpinned" => StatusCode::CONFLICT,
        "node_run_not_found" | "task_not_found" | "node_not_found" => StatusCode::NOT_FOUND,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    };
    error(status, code)
}

fn discovered_local_program(runtime: &str) -> Result<std::path::PathBuf, &'static str> {
    let path = std::env::var_os("PATH").ok_or("node_cli_unreported")?;
    let Some((_, names)) = loom_protocol::CLI_CATALOG
        .iter()
        .find(|(kind, _)| *kind == runtime)
    else {
        return Err("node_cli_unreported");
    };
    for dir in std::env::split_paths(&path) {
        for name in *names {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            let canonical = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            let report = CliReport {
                adapter_kind: (*runtime).to_owned(),
                path: canonical.display().to_string(),
                version: None,
                path_present: true,
                installation_identity: None,
                installation_generation: None,
            };
            if cli_is_runnable(&report, runtime) {
                return Ok(canonical);
            }
        }
    }
    Err("node_cli_unreported")
}

async fn read_capped(pipe: Option<impl tokio::io::AsyncRead + Unpin>, cap: usize) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let Some(mut pipe) = pipe else {
        return Vec::new();
    };
    let mut kept = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let count = match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let room = cap.saturating_sub(kept.len());
        if room > 0 {
            kept.extend_from_slice(&chunk[..count.min(room)]);
        }
    }
    kept
}

async fn run_managed(
    program: &std::path::Path,
    args: &[String],
    cwd: &str,
    run_id: &str,
) -> Result<RunOutcome, &'static str> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null());
    let spec = rovai_core::managed_process::ManagedProcessLaunchSpec::capture(
        &command,
        rovai_core::managed_process::ManagedProcessPurpose::RuntimeOneShot,
        rovai_core::managed_process::ManagedStdinPolicy::Null,
        rovai_core::managed_process::ManagedWindowsArgvDialect::MicrosoftCrt,
        format!("node-run:{run_id}"),
    )
    .map_err(|_| "node_runtime_unavailable")?;
    let mut child = rovai_core::managed_process::ManagedProcess::spawn(spec)
        .map_err(|_| "node_runtime_unavailable")?;
    let stdout_pipe = child.take_stdout();
    let stderr_pipe = child.take_stderr();
    let stdout_task = tokio::spawn(async move { read_capped(stdout_pipe, MAX_OUTPUT).await });
    let stderr_task = tokio::spawn(async move { read_capped(stderr_pipe, MAX_OUTPUT).await });
    let status = child.wait().await.map_err(|_| "node_runtime_unavailable")?;
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    Ok(RunOutcome {
        exit_code: status.code().unwrap_or(1),
        stdout,
        stderr,
    })
}

fn cli_is_runnable(cli: &CliReport, runtime: &str) -> bool {
    cli.adapter_kind == runtime && cli.path_present && !is_path_sentinel(&cli.path)
}

fn is_path_sentinel(path: &str) -> bool {
    path.is_empty() || path == "path_missing"
}

/// `path_missing` only when the node itself said the path was gone.
/// Offline, or a path the latest hello did not repeat, stays `last_seen`.
fn cli_availability(online: bool, path_present: bool, live: bool) -> &'static str {
    if !path_present {
        "path_missing"
    } else if online && live {
        "reported"
    } else {
        "last_seen"
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShimRequest {
    args: Vec<String>,
}

/// The `rovai` shim on a node calls this with its per-run token. Administrator
/// tokens and node tokens are rejected. The mission and member come from the
/// credential, not from the request.
pub(crate) async fn shim(
    State(state): State<WebState>,
    headers: HeaderMap,
    body: Result<Json<ShimRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return error(StatusCode::UNAUTHORIZED, "shim_token_invalid");
    };
    if state.sessions.is_administrator(token) {
        return error(StatusCode::FORBIDDEN, "administrator_rejected");
    }
    if !valid_credential(token) {
        return error(StatusCode::UNAUTHORIZED, "shim_token_invalid");
    }
    match state.nodes.store.remote_digest_exists(&digest_hex(token)) {
        Ok(true) => return error(StatusCode::FORBIDDEN, "node_token_rejected"),
        Ok(false) => {}
        Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable"),
    }
    let grant = match state
        .nodes
        .store
        .run_grant(&digest_hex_kind(RUN_KIND, token))
    {
        Ok(grant) => grant,
        Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable"),
    };
    let Some(grant) = grant.filter(|grant| grant.usable) else {
        return error(StatusCode::UNAUTHORIZED, "shim_token_invalid");
    };
    let Ok(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "invalid_shim_request");
    };
    if body.args.len() > 8
        || body
            .args
            .iter()
            .any(|arg| arg.len() > 256 || arg.contains('\0'))
    {
        return error(StatusCode::BAD_REQUEST, "invalid_shim_request");
    }
    if body.args != ["loom".to_owned(), "status".to_owned()] {
        return error(StatusCode::FORBIDDEN, "shim_operation_denied");
    }
    // `grant.member_id` is the caller. The request cannot name a different one.
    let Some(mission_id) = grant
        .mission_id
        .filter(|mission_id| !mission_id.trim().is_empty())
    else {
        return Json(json!({
            "exitCode": 1,
            "stdout": "{\"error\":{\"code\":\"loom.current_unavailable\",\"message\":\"The current Thread has no Mission; LOOM works inside a Mission Thread\",\"recovery\":\"stop\"}}\n",
            "stderr": "",
        }))
        .into_response();
    };
    match read_loom_status(&state.core, &mission_id).await {
        Ok(stdout) => Json(json!({
            "exitCode": 0,
            "stdout": stdout,
            "stderr": "",
        }))
        .into_response(),
        Err(code) => error(StatusCode::SERVICE_UNAVAILABLE, code),
    }
}

async fn read_loom_status(
    core: &rovai_core::application::CoreService,
    mission_id: &str,
) -> Result<String, &'static str> {
    let plan = core_value(core, "loom.plan.get", mission_id).await?;
    let tasks = core_value(core, "loom.tasks.list", mission_id).await?;
    let dependencies = core_value(core, "loom.dependencies.list", mission_id).await?;
    let claims = core_value(core, "loom.claims.list", mission_id).await?;
    let evaluated_at = claims.get("evaluatedAt").cloned().unwrap_or(Value::Null);
    let claim_rows = claims.get("claims").cloned().unwrap_or_else(|| json!([]));
    let document = json!({
        "missionId": mission_id,
        "plan": plan,
        "tasks": tasks,
        "dependencies": dependencies,
        "claims": claim_rows,
        "evaluatedAt": evaluated_at,
    });
    let mut text = serde_json::to_string(&document).map_err(|_| "shim_unavailable")?;
    text.push('\n');
    Ok(text)
}

async fn core_value(
    core: &rovai_core::application::CoreService,
    method: &str,
    mission_id: &str,
) -> Result<Value, &'static str> {
    let reply = core
        .request(method, json!({"missionId": mission_id}))
        .await
        .map_err(|_| "shim_unavailable")?;
    if reply.error.is_some() {
        return Err("shim_unavailable");
    }
    Ok(reply.result.unwrap_or(Value::Null))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use loom_protocol::run_bundle::RUN_BUNDLE_VERSION;
    use std::net::Ipv4Addr;

    #[test]
    fn remote_file_query_preserves_foreign_root_but_rejects_escape_before_dispatch() {
        for root in [r"C:\Users\fixture\worktree", "/srv/fixture/worktree"] {
            assert_eq!(workspace_query_relative("remote", root, ""), Ok(String::new()));
            assert_eq!(workspace_query_relative("remote", root, "probe.txt"), Ok("probe.txt".into()));
            assert_eq!(workspace_query_relative("remote", root, r"folder\proof.md"), Ok("folder/proof.md".into()));
            for raw in ["../secret", r"..\secret", "a/../../secret", "/etc/passwd",
                r"C:\secret", r"C:secret", r"\\server\share", r"\secret", "file:stream",
                "a/.. /secret", "a/.../secret", "a\0b"] {
                assert_eq!(workspace_query_relative("remote", root, raw), Err("path_rejected"), "{raw:?}");
            }
        }
        let root = std::env::temp_dir().join("loom-query-local");
        let root = root.to_str().unwrap();
        assert_eq!(workspace_query_relative("local", root, "probe.txt"),
            loom_protocol::workspace_relative(root, "probe.txt"));
        assert_eq!(workspace_query_relative("remote", "opaque", &"a".repeat(4097)), Err("path_rejected"));
        assert_eq!(workspace_query_relative("unknown", "opaque", "probe.txt"), Err("path_rejected"));
    }

    #[tokio::test]
    async fn closing_one_outbound_lane_never_discards_the_other_lanes_receipt() {
        let (urgent_tx, mut urgent_rx) = mpsc::channel(2);
        let (regular_tx, mut regular_rx) = mpsc::channel(2);
        urgent_tx.send(Outbound::Text("urgent_receipt".into())).await.unwrap();
        regular_tx.send(Outbound::Text("administrator_rejected".into())).await.unwrap();
        drop(urgent_tx);
        drop(regular_tx);
        assert!(matches!(receive_outbound(&mut urgent_rx, &mut regular_rx).await,
            Some(Outbound::Text(text)) if text == "urgent_receipt"));
        assert!(matches!(receive_outbound(&mut urgent_rx, &mut regular_rx).await,
            Some(Outbound::Text(text)) if text == "administrator_rejected"));
        assert!(receive_outbound(&mut urgent_rx, &mut regular_rx).await.is_none());

        let (urgent_tx, mut urgent_rx) = mpsc::channel(1);
        let (regular_tx, mut regular_rx) = mpsc::channel(1);
        drop(regular_tx);
        // A closed regular lane must not end a still-live urgent lane.
        assert!(tokio::time::timeout(Duration::from_millis(10),
            receive_outbound(&mut urgent_rx, &mut regular_rx)).await.is_err());
        urgent_tx.send(Outbound::Pong(vec![7])).await.unwrap();
        assert!(matches!(receive_outbound(&mut urgent_rx, &mut regular_rx).await,
            Some(Outbound::Pong(bytes)) if bytes == vec![7]));
        drop(urgent_tx);
        assert!(receive_outbound(&mut urgent_rx, &mut regular_rx).await.is_none());
    }

    fn test_hub() -> Hub {
        let admin = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&admin).unwrap());
        Hub::new(sessions, NodeStore::open_ephemeral().unwrap())
    }

    #[tokio::test]
    async fn pairing_code_is_single_use_and_administrator_token_is_not_a_node() {
        let admin = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&admin).unwrap());
        let hub = Hub::new(sessions.clone(), NodeStore::open_ephemeral().unwrap());
        let peer = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let (code, _) = hub.issue_pairing().await;
        match hub.redeem(&admin, peer).await {
            Err("administrator_rejected") => {}
            Err(code) => panic!("unexpected pairing error {code}"),
            Ok(_) => panic!("administrator token was accepted as a pairing code"),
        }
        let issued = hub.redeem(&code, peer).await.expect("pairing code");
        match hub.redeem(&code, peer).await {
            Err("pairing_invalid") => {}
            Err(code) => panic!("unexpected pairing error {code}"),
            Ok(_) => panic!("pairing code was accepted twice"),
        }
        assert!(sessions.is_administrator(&admin));
        assert!(!sessions.is_administrator(&issued.token));
        assert!(hub.authorize(&issued.node_id, &issued.token).await.is_ok());
        assert_eq!(
            hub.authorize(&issued.node_id, &admin).await,
            Err("administrator_rejected")
        );
        assert!(matches!(
            sessions.authorize_login(&issued.token),
            Err(crate::auth::LoginFailure::Unauthorized)
        ));
        let reopened = Hub::new(sessions, hub.store.clone());
        assert!(
            reopened
                .authorize(&issued.node_id, &issued.token)
                .await
                .is_ok(),
            "node token must survive a new hub on the same store"
        );
    }

    #[tokio::test]
    async fn failed_pairing_is_limited_per_address_and_globally() {
        let hub = test_hub();
        let local = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
        let other = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
        for _ in 0..PAIRING_FAILURES_PER_ADDRESS {
            assert!(matches!(
                hub.redeem("not-a-code", local).await,
                Err("pairing_invalid")
            ));
        }
        let (kept, _) = hub.issue_pairing().await;
        assert!(matches!(
            hub.redeem(&kept, local).await,
            Err("pairing_rate_limited")
        ));
        assert!(
            hub.redeem(&kept, other).await.is_ok(),
            "a different peer can still redeem the code the limited peer did not consume"
        );

        let global = test_hub();
        for index in 0..PAIRING_FAILURES_GLOBAL {
            let peer = IpAddr::V4(Ipv4Addr::new(
                10,
                (index / 256) as u8,
                (index % 256) as u8,
                1,
            ));
            assert!(matches!(
                global.redeem("not-a-code", peer).await,
                Err("pairing_invalid")
            ));
        }
        let fresh = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
        assert!(matches!(
            global.redeem("not-a-code", fresh).await,
            Err("pairing_rate_limited")
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_pairing_failures_cannot_exceed_the_limit() {
        let hub = Arc::new(test_hub());
        let peer = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 5));
        let burst = PAIRING_FAILURES_PER_ADDRESS + 16;
        let mut tasks = Vec::with_capacity(burst);
        for _ in 0..burst {
            let hub = Arc::clone(&hub);
            tasks.push(tokio::spawn(
                async move { hub.redeem("not-a-code", peer).await },
            ));
        }
        let mut invalid = 0;
        let mut limited = 0;
        for task in tasks {
            match task.await.expect("pairing task") {
                Err("pairing_invalid") => invalid += 1,
                Err("pairing_rate_limited") => limited += 1,
                Ok(_) => panic!("invalid pairing code was accepted"),
                Err(code) => panic!("unexpected pairing result {code}"),
            }
        }
        assert_eq!(invalid, PAIRING_FAILURES_PER_ADDRESS);
        assert_eq!(limited, burst - PAIRING_FAILURES_PER_ADDRESS);
    }

    #[test]
    fn availability_keeps_a_present_path_as_last_seen_when_offline() {
        assert_eq!(cli_availability(false, true, false), "last_seen");
        assert_eq!(cli_availability(false, true, true), "last_seen");
        assert_eq!(cli_availability(true, true, false), "last_seen");
        assert_eq!(cli_availability(true, true, true), "reported");
        assert_eq!(cli_availability(true, false, true), "path_missing");
        assert_eq!(cli_availability(false, false, false), "path_missing");
    }

    #[tokio::test]
    async fn a_missing_node_is_still_waited_for() {
        let hub = test_hub();
        let started = Instant::now();
        let pending = hub
            .try_dispatch("codex-cli", "/work", &[], None, &RunScope::default(), None)
            .await
            .unwrap();
        assert!(pending.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn unreported_cli_is_refused_before_node_wait() {
        let hub = test_hub();
        let (node_id, mut frames) =
            attach_reports(&hub, vec![cli_report("codex-cli", "/opt/codex", true)]).await;
        let started = Instant::now();
        let err = match hub
            .dispatch(
                "claude-code-cli",
                "/work",
                &["-p".into()],
                None,
                &RunScope::default(),
            )
            .await
        {
            Err(code) => code,
            Ok(_) => panic!("unreported CLI was launched"),
        };
        assert_eq!(err, "node_cli_unreported");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "refusing an unreported CLI waited {:?}",
            started.elapsed()
        );
        assert!(
            frames.try_recv().is_err(),
            "refused launch still queued a frame"
        );
        let listed = hub.list_nodes().await.unwrap();
        let node = remote_node(&listed, &node_id);
        assert_eq!(node["activeRunCount"], 0);
        assert_eq!(node["clis"][0]["adapterKind"], "codex-cli");
        assert_eq!(node["clis"][0]["path"], "/opt/codex");
        assert_eq!(node["clis"][0]["availability"], "reported");
        assert!(node["clis"][0]["reportedAt"].as_str().unwrap().len() > 10);
    }

    #[tokio::test]
    async fn omitted_cli_stays_last_seen_with_its_report_time() {
        let hub = test_hub();
        let (node_id, _frames) =
            attach_reports(&hub, vec![cli_report("codex-cli", "/opt/codex", true)]).await;
        let listed = hub.list_nodes().await.unwrap();
        let reported_at = remote_node(&listed, &node_id)["clis"][0]["reportedAt"]
            .as_str()
            .unwrap()
            .to_owned();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let (tx, _rx) = mpsc::channel(2);
        let (cancel_tx, _cancel_rx) = oneshot::channel();
        hub.attach(
            &node_id,
            Outbox {
                tx,
                urgent: None,
                acks: Arc::new(StdMutex::new(HashMap::new())),
            },
            cancel_tx,
            "linux",
            "x86_64",
            Vec::new(),
        )
        .await
        .unwrap();
        let listed = hub.list_nodes().await.unwrap();
        let cli = &remote_node(&listed, &node_id)["clis"][0];
        assert_eq!(cli["adapterKind"], "codex-cli");
        assert_eq!(cli["path"], "/opt/codex");
        assert_eq!(cli["pathPresent"], true);
        assert_eq!(cli["reportedAt"], reported_at);
        assert_eq!(cli["availability"], "last_seen");
        assert_ne!(cli["path"], "path_missing");
        let started = Instant::now();
        match hub
            .dispatch(
                "codex-cli",
                "/work",
                &["exec".into()],
                None,
                &RunScope::default(),
            )
            .await
        {
            Err(code) => assert_eq!(code, "node_cli_unreported"),
            Ok(_) => panic!("omitted CLI was launched"),
        }
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn node_saying_the_path_is_gone_keeps_the_path_string() {
        let hub = test_hub();
        let (node_id, _frames) =
            attach_reports(&hub, vec![cli_report("codex-cli", "/opt/codex", false)]).await;
        let listed = hub.list_nodes().await.unwrap();
        let cli = &remote_node(&listed, &node_id)["clis"][0];
        assert_eq!(cli["path"], "/opt/codex");
        assert_eq!(cli["pathPresent"], false);
        assert_eq!(cli["availability"], "path_missing");
        assert_ne!(cli["path"], "path_missing");
        assert!(cli["reportedAt"].as_str().unwrap().len() > 10);
        match hub
            .dispatch(
                "codex-cli",
                "/work",
                &["exec".into()],
                None,
                &RunScope::default(),
            )
            .await
        {
            Err(code) => assert_eq!(code, "node_cli_unreported"),
            Ok(_) => panic!("missing path was launched"),
        }
    }

    #[tokio::test]
    async fn revoke_between_hello_and_register_does_not_leave_the_socket() {
        let hub = Arc::new(test_hub());
        let (code, _) = hub.issue_pairing().await;
        let issued = hub
            .redeem(&code, IpAddr::V4(Ipv4Addr::LOCALHOST))
            .await
            .unwrap();
        let gate = Arc::new(AttachGate {
            reached: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        *hub.attach_gate.lock().await = Some(Arc::clone(&gate));
        let node_id = issued.node_id.clone();
        let attaching = Arc::clone(&hub);
        let reached = gate.reached.notified();
        tokio::pin!(reached);
        let join = tokio::spawn(async move {
            let (tx, _rx) = mpsc::channel(2);
            let (cancel_tx, _cancel_rx) = oneshot::channel();
            attaching
                .attach(
                    &node_id,
                    Outbox {
                        tx,
                        urgent: None,
                        acks: Arc::new(StdMutex::new(HashMap::new())),
                    },
                    cancel_tx,
                    "linux",
                    "x86_64",
                    vec![cli_report("codex-cli", "/opt/codex", true)],
                )
                .await
        });
        reached.await;
        hub.revoke(&issued.node_id).await.unwrap();
        gate.release.notify_one();
        assert_eq!(join.await.unwrap(), Err("token_revoked"));
        let inner = hub.inner.lock().await;
        assert!(
            inner
                .nodes
                .get(&issued.node_id)
                .and_then(|node| node.outbound.as_ref())
                .is_none(),
            "revoked hello stayed registered"
        );
    }

    // This owner crosses capability negotiation, dispatch persistence and retry.
    // A pure packet/store owner cannot catch a Start that silently drops a
    // bundle or rereads a later catalog. No process/network/provider is started.
    // Smallest command: cargo test -p rovai-web --lib bundle_dispatch
    #[tokio::test]
    async fn bundle_dispatch_requires_capability_and_retries_the_original_snapshot() {
        use loom_protocol::run_bundle::{BundleArtifact, BundleFile};
        let hub = test_hub();
        let (node_id, mut frames) =
            attach_reports(&hub, vec![cli_report("codex-cli", "/fixture/codex", true)]).await;
        let prompt = b"frozen selected rule";
        let mut bundle = RunBundleV1 {
            version: RUN_BUNDLE_VERSION,
            bundle_id: bundle_id_for("run_snapshot", 1),
            run_id: "run_snapshot".into(),
            attempt: 1,
            agent_id: "member_fixture".into(),
            adapter_kind: "codex-cli".into(),
            selection_revision: "selection1".into(),
            source_skill_root: None,
            digest: String::new(),
            files: vec![BundleFile {
                artifact: BundleArtifact::BootstrapPrompt,
                label: "bootstrap".into(),
                path: "bootstrap.txt".into(),
                bytes: prompt.len(),
                content: STANDARD.encode(prompt),
            }],
        };
        bundle.digest = bundle_digest(&bundle).unwrap();
        let mut scope = RunScope {
            member_id: Some("member_fixture".into()),
            mission_id: Some("mission_fixture".into()),
            frozen_bundle: Some(FrozenMemberBundle {
                bundle,
                manifest: json!({"assets":[]}),
            }),
        };
        let args = vec!["exec".to_string(), "fixture task".to_string()];
        assert!(matches!(
            hub.try_dispatch("codex-cli", "/work", &args, None, &scope, Some(&node_id))
                .await,
            Err("bundle_version_unsupported")
        ));
        assert!(frames.try_recv().is_err());
        let generation = hub.inner.lock().await.nodes[&node_id].generation;
        hub.set_run_bundle_versions(&node_id, generation, vec![RUN_BUNDLE_VERSION])
            .await;
        let (run_id, _result) = hub
            .try_dispatch("codex-cli", "/work", &args, None, &scope, Some(&node_id))
            .await
            .unwrap()
            .unwrap();
        let first = match frames.recv().await.unwrap() {
            Outbound::Text(text) => match serde_json::from_str::<ServerMessage>(&text).unwrap() {
                ServerMessage::Start {
                    bundle: Some(bundle),
                    attempt: 1,
                    ..
                } => bundle,
                _ => panic!("member dispatch lost its frozen bundle"),
            },
            _ => panic!("expected Start"),
        };
        assert_eq!(first.run_id, run_id);
        assert_eq!(first.files[0].content, STANDARD.encode(prompt));
        let persisted = hub.store.run_bundle(&run_id).unwrap().unwrap();
        assert_eq!(
            persisted.manifest["dispatchScope"]["missionId"],
            "mission_fixture"
        );
        hub.note_rejection(&node_id, generation, &run_id, 1, "legacy_no_process").await;

        // A new catalog value held by the caller never replaces the stored one.
        scope
            .frozen_bundle
            .as_mut()
            .unwrap()
            .bundle
            .selection_revision = "changed".into();
        assert!(matches!(
            hub.try_redispatch(&run_id, "codex-cli", "/work", &args, &scope)
                .await,
            Err("bundle_member_mismatch")
        ));
        let changed_args = vec!["exec".to_string(), "changed task".to_string()];
        assert!(matches!(
            hub.try_redispatch(
                &run_id,
                "codex-cli",
                "/work",
                &changed_args,
                &RunScope::default()
            )
            .await,
            Err("bundle_launch_mismatch")
        ));
        let changed_scope = RunScope {
            mission_id: Some("different_mission".into()),
            ..RunScope::default()
        };
        assert!(matches!(
            hub.try_redispatch(&run_id, "codex-cli", "/work", &args, &changed_scope)
                .await,
            Err("bundle_scope_mismatch")
        ));
        let (_run, _result) = hub
            .try_redispatch(&run_id, "codex-cli", "/work", &args, &RunScope::default())
            .await
            .unwrap();
        let retry = match frames.recv().await.unwrap() {
            Outbound::Text(text) => match serde_json::from_str::<ServerMessage>(&text).unwrap() {
                ServerMessage::Start {
                    bundle: Some(bundle),
                    attempt: 2,
                    ..
                } => bundle,
                _ => panic!("retry did not carry the original bundle"),
            },
            _ => panic!("expected retry Start"),
        };
        assert_eq!(retry.files, first.files);
        assert_eq!(retry.selection_revision, first.selection_revision);
        assert_ne!(retry.digest, first.digest); // attempt envelope is distinct
        assert_eq!(
            hub.store.run_bundle(&run_id).unwrap().unwrap().bundle,
            first
        );
        let inherited = hub.store.latest_run_scope(&run_id).unwrap().unwrap();
        assert_eq!(
            inherited,
            (
                Some("member_fixture".into()),
                Some("mission_fixture".into())
            )
        );
        hub.note_rejection(&node_id, generation, &run_id, 2, "legacy_no_process").await;
    }

    // No process or network is started. Exercise the real timeout/store/owner
    // seam, not a replacement fake state machine.
    #[tokio::test]
    async fn legacy_waiter_loss_and_unmatched_rejection_preserve_the_attempt() {
        let hub = test_hub();
        let (node_id, mut frames) = attach_reports(&hub,
            vec![cli_report("codex-cli", "/fixture/codex", true)]).await;
        let generation = hub.inner.lock().await.nodes[&node_id].generation;
        let (run_id, rx) = hub.try_dispatch("codex-cli", "/work", &[],
            None, &RunScope::default(), Some(&node_id)).await.unwrap().unwrap();
        frames.recv().await.unwrap();
        assert!(matches!(hub.await_legacy_dispatch(run_id.clone(), rx,
            Duration::from_millis(1)).await, Err("node_run_timeout")));
        assert!(hub.inner.lock().await.runs.contains_key(&run_id));
        assert!(matches!(hub.store.open_next_attempt(&run_id).unwrap(),
            NextAttempt::StillRunning { attempt: 1 }));

        let (foreign, _frames) = attach_reports(&hub, Vec::new()).await;
        let foreign_generation = hub.inner.lock().await.nodes[&foreign].generation;
        hub.note_rejection(&foreign, foreign_generation, &run_id, 1,
            "legacy_no_process").await;
        hub.note_rejection(&node_id, generation, &run_id, 2,
            "legacy_no_process").await;
        hub.note_rejection(&node_id, generation.saturating_sub(1), &run_id, 1,
            "legacy_no_process").await;
        hub.note_rejection(&node_id, generation, &run_id, 1,
            "legacy_start_conflict").await;
        hub.note_rejection(&node_id, generation, &run_id, 1,
            "legacy_outcome_unknown").await;
        assert!(matches!(hub.store.open_next_attempt(&run_id).unwrap(),
            NextAttempt::StillRunning { attempt: 1 }));

        // Only an exact, positive no-spawn receipt opens the explicit next try.
        hub.note_rejection(&node_id, generation, &run_id, 1,
            "legacy_no_process").await;
        let (_id, _rx) = hub.try_redispatch(&run_id, "codex-cli", "/work", &[],
            &RunScope::default()).await.unwrap();
        frames.recv().await.unwrap();
        hub.note_rejection(&node_id, generation, &run_id, 1,
            "legacy_no_process").await;
        assert!(matches!(hub.store.open_next_attempt(&run_id).unwrap(),
            NextAttempt::StillRunning { attempt: 2 }));
        {
            let mut inner = hub.inner.lock().await;
            fail_node_waiters(&mut inner, &node_id);
            assert_eq!(inner.runs[&run_id].attempt, 2);
        }
        let resumes = hub.reconcile(&node_id, generation, &[]).await;
        assert!(resumes.iter().any(|message| matches!(message,
            ServerMessage::Resume { run_id: id, attempt: 2, .. } if id == &run_id)));
        assert!(matches!(hub.store.open_next_attempt(&run_id).unwrap(),
            NextAttempt::StillRunning { attempt: 2 }));
    }

    #[tokio::test]
    async fn legacy_no_process_receipt_cannot_override_output_or_a_conflicting_duplicate() {
        let hub = test_hub();
        let (node_id, mut frames) = attach_reports(&hub,
            vec![cli_report("codex-cli", "/fixture/codex", true)]).await;
        let generation = hub.inner.lock().await.nodes[&node_id].generation;
        let (run_id, mut rx) = hub.try_dispatch("codex-cli", "/work", &[], None,
            &RunScope::default(), Some(&node_id)).await.unwrap().unwrap();
        frames.recv().await.unwrap();
        for code in ["legacy_start_conflict", "legacy_start_pending", "legacy_attempt_conflict"] {
            hub.note_rejection(&node_id, generation, &run_id, 1, code).await;
            assert!(matches!(rx.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
        }
        hub.apply_output(&node_id, generation, &run_id, OutputStream::Stdout, 1,
            &STANDARD.encode(b"owned")).await;
        hub.note_rejection(&node_id, generation, &run_id, 1, "legacy_no_process").await;
        assert!(matches!(rx.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
        assert!(matches!(hub.store.open_next_attempt(&run_id).unwrap(),
            NextAttempt::StillRunning { attempt: 1 }));
        hub.apply_exit(&node_id, generation, &run_id, 2, 0).await;
        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(outcome.stdout, b"owned");
        assert_eq!(outcome.exit_code, 0);
        assert!(!hub.inner.lock().await.runs.contains_key(&run_id));
    }

    #[tokio::test]
    async fn legacy_generic_rejection_and_unmatched_unsent_result_never_open_retry() {
        let hub = test_hub();
        let (node_id, mut frames) = attach_reports(&hub,
            vec![cli_report("codex-cli", "/fixture/codex", true)]).await;
        let generation = hub.inner.lock().await.nodes[&node_id].generation;
        let (run_id, _rx) = hub.try_dispatch("codex-cli", "/work", &[], None,
            &RunScope::default(), Some(&node_id)).await.unwrap().unwrap();
        frames.recv().await.unwrap();
        for code in ["bundle_digest", "program_not_allowed", "legacy_prepare_failed"] {
            hub.note_rejection(&node_id, generation, &run_id, 1, code).await;
        }
        hub.abandon_unsent(&node_id, generation + 1, &run_id, 1).await;
        hub.abandon_unsent(&node_id, generation, &run_id, 2).await;
        assert!(matches!(hub.store.open_next_attempt(&run_id).unwrap(),
            NextAttempt::StillRunning { attempt: 1 }));
        // Exercise Sender::send's actual closed-channel, unqueued-value path.
        drop(frames);
        let failed = hub.try_dispatch("codex-cli", "/work", &[], None,
            &RunScope::default(), Some(&node_id)).await;
        assert!(matches!(failed, Err("node_disconnected")));
        assert_eq!(hub.store.running_for_node(&node_id).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn legacy_terminal_ack_is_replayed_from_durable_store_after_a_reopen() {
        let hub = test_hub();
        let (node_id, mut frames) = attach_reports(&hub,
            vec![cli_report("codex-cli", "/fixture/codex", true)]).await;
        let generation = hub.inner.lock().await.nodes[&node_id].generation;
        let (run_id, rx) = hub.try_dispatch("codex-cli", "/work", &[], None,
            &RunScope::default(), Some(&node_id)).await.unwrap().unwrap();
        frames.recv().await.unwrap();
        hub.apply_exit(&node_id, generation, &run_id, 1, 0).await;
        assert_eq!(rx.await.unwrap().unwrap().exit_code, 0);
        assert!(!hub.inner.lock().await.runs.contains_key(&run_id));
        let reopened = Hub::new(Arc::new(Sessions::new(&crate::new_token().unwrap()).unwrap()),
            hub.store.clone());
        let (tx, _frames) = mpsc::channel(4);
        let (cancel, _) = oneshot::channel();
        let generation = reopened.attach(&node_id, Outbox { tx, urgent: None,
            acks: Arc::new(StdMutex::new(HashMap::new())) }, cancel, "windows", "x86_64",
            Vec::new()).await.unwrap();
        for (attempt, alive, sent_seq) in [(2, false, 1), (1, true, 1), (1, false, 2)] {
            let messages = reopened.reconcile(&node_id, generation,
                &[RunReport { run_id: run_id.clone(), attempt,
                    process_alive: alive, sent_seq }]).await;
            assert!(messages.is_empty());
        }
        let messages = reopened.reconcile(&node_id, generation,
            &[RunReport { run_id: run_id.clone(), attempt: 1,
                process_alive: false, sent_seq: 1 }]).await;
        assert!(matches!(messages.as_slice(),
            [ServerMessage::Ack { run_id: id, seq: 1 }] if id == &run_id));
        assert!(matches!(reopened.store.open_next_attempt(&run_id).unwrap(),
            NextAttempt::NotInterrupted));
    }

    async fn attach_reports(hub: &Hub, clis: Vec<CliReport>) -> (String, mpsc::Receiver<Outbound>) {
        let (code, _) = hub.issue_pairing().await;
        let issued = hub
            .redeem(&code, IpAddr::V4(Ipv4Addr::LOCALHOST))
            .await
            .expect("pair");
        let (tx, rx) = mpsc::channel(4);
        let (cancel_tx, _cancel_rx) = oneshot::channel();
        hub.attach(
            &issued.node_id,
            Outbox {
                tx,
                urgent: None,
                acks: Arc::new(StdMutex::new(HashMap::new())),
            },
            cancel_tx,
            "linux",
            "x86_64",
            clis,
        )
        .await
        .expect("attach");
        (issued.node_id, rx)
    }

    /// The computer transport is routed by capability *and* by the current
    /// connection generation, on the way out and on the way back in.
    #[tokio::test]
    async fn computer_requests_need_an_advertised_capability_and_the_current_generation() {
        use loom_protocol::computer::{
            ComputerCodeV1, ComputerOpV1, ComputerReplyV1, ComputerRequestV1,
        };
        let hub = Arc::new(test_hub());
        let (node_id, mut frames) = attach_reports(&hub, Vec::new()).await;
        let generation = hub.inner.lock().await.nodes[&node_id].generation;
        let info = |id: &str| ComputerRequestV1 {
            version: COMPUTER_VERSION,
            request_id: id.to_owned(),
            op: ComputerOpV1::Info {},
        };

        // Not advertised: refused before a single byte reaches the socket.
        assert_eq!(hub.computer_generation(&node_id).await, None);
        assert_eq!(
            hub.computer_request(&node_id, generation, info("req_1"), Duration::from_millis(50))
                .await
                .err(),
            Some("computer_version_unsupported")
        );
        assert!(frames.try_recv().is_err());

        hub.set_computer_versions(&node_id, generation, vec![COMPUTER_VERSION])
            .await;
        assert_eq!(hub.computer_generation(&node_id).await, Some(generation));

        // A stale generation is refused at the sender, not silently sent.
        assert_eq!(
            hub.send_node_message_generation(
                &node_id,
                generation + 9,
                ServerMessage::Computer {
                    request: info("req_2")
                },
                false,
            )
            .await,
            Err("node_connection_changed")
        );
        assert!(frames.try_recv().is_err());

        // Current generation: the request goes out, a reply from a replaced
        // generation is discarded, and the matching one completes the waiter.
        let call = tokio::spawn({
            let hub = Arc::clone(&hub);
            let node_id = node_id.clone();
            async move {
                hub.computer_request(&node_id, generation, info("req_3"), Duration::from_secs(5))
                    .await
            }
        });
        let Some(Outbound::Text(text)) = frames.recv().await else {
            panic!("no computer frame was sent")
        };
        let Ok(ServerMessage::Computer { request: sent }) =
            serde_json::from_str::<ServerMessage>(&text)
        else {
            panic!("the frame was not a computer request")
        };
        assert_eq!(sent.request_id, "req_3");
        assert_eq!(sent.op, ComputerOpV1::Info {});

        hub.handle_computer_reply(
            &node_id,
            generation + 1,
            ComputerReplyV1::refusal("req_3", ComputerCodeV1::Ok),
        )
        .await;
        assert!(
            !call.is_finished(),
            "a reply from a replaced generation completed the waiter"
        );
        hub.handle_computer_reply(
            &node_id,
            generation,
            ComputerReplyV1::refusal("req_3", ComputerCodeV1::Ok),
        )
        .await;
        assert!(call.await.expect("join").is_ok());
        assert!(hub.inner.lock().await.computer_waits.is_empty());
    }

    /// The rework's exact interleaving: a caller's connection pre-check passes on
    /// generation `g`, the node then reconnects (and re-advertises computer on the
    /// replacement socket) *before* the request is registered, and the request
    /// still names `g`.
    ///
    /// Registration is the fence. Because the expected generation is compared in
    /// the same critical section that inserts the waiter — and that same value is
    /// what the frame is sent under — the stale request is refused instead of being
    /// re-read as "whatever is current now" and delivered on the replacement
    /// socket. The positive control then proves that same socket still carries a
    /// fresh input, so the zero below cannot pass by delivering nothing at all.
    #[tokio::test]
    async fn an_input_admitted_before_a_reconnect_never_reaches_the_new_socket() {
        use loom_protocol::computer::{
            ComputerCodeV1, ComputerInputV1, ComputerOpV1, ComputerReplyV1, ComputerRequestV1,
        };
        let hub = Arc::new(test_hub());
        let (node_id, mut first_frames) = attach_reports(&hub, Vec::new()).await;
        let first_generation = hub.inner.lock().await.nodes[&node_id].generation;
        hub.set_computer_versions(&node_id, first_generation, vec![COMPUTER_VERSION])
            .await;
        // Step 1 of the race: the provider's own pre-check passes, because the
        // connection it was built for is still the current one right now.
        assert_eq!(
            hub.computer_generation(&node_id).await,
            Some(first_generation)
        );
        // Step 2: the same node reconnects and re-advertises computer on the
        // replacement socket. The request below was admitted for the old one.
        let (tx, mut second_frames) = mpsc::channel(4);
        let (cancel, _cancel_rx) = oneshot::channel();
        let second_generation = hub
            .attach(
                &node_id,
                Outbox {
                    tx,
                    urgent: None,
                    acks: Arc::new(StdMutex::new(HashMap::new())),
                },
                cancel,
                "linux",
                "x86_64",
                Vec::new(),
            )
            .await
            .expect("reconnect");
        assert!(second_generation > first_generation);
        hub.set_computer_versions(&node_id, second_generation, vec![COMPUTER_VERSION])
            .await;
        let input = |id: &str| ComputerRequestV1 {
            version: COMPUTER_VERSION,
            request_id: id.to_owned(),
            op: ComputerOpV1::Input {
                input: ComputerInputV1::Text {
                    text: "a".to_owned(),
                },
            },
        };
        // Step 3: registered under the old generation, after the reconnect.
        assert_eq!(
            hub.computer_request(
                &node_id,
                first_generation,
                input("req_stale"),
                Duration::from_millis(500)
            )
            .await
            .err(),
            Some("node_connection_changed"),
            "an input admitted for the replaced socket was registered instead of refused"
        );
        // The refusal is total: the replacement receives nothing, the dead socket
        // receives nothing, and no waiter survives to be completed by a later reply.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), second_frames.recv())
                .await
                .is_err(),
            "the replaced connection's input reached the new socket"
        );
        assert!(first_frames.try_recv().is_err());
        assert!(
            hub.inner.lock().await.computer_waits.is_empty(),
            "a refused request left a waiter behind"
        );
        // Positive control: the replacement socket does carry a fresh input, and
        // its own reply completes the call.
        let call = tokio::spawn({
            let hub = Arc::clone(&hub);
            let node_id = node_id.clone();
            async move {
                hub.computer_request(
                    &node_id,
                    second_generation,
                    input("req_fresh"),
                    Duration::from_secs(5),
                )
                .await
            }
        });
        let Some(Outbound::Text(text)) = second_frames.recv().await else {
            panic!("the fresh input was not sent on the new connection")
        };
        let Ok(ServerMessage::Computer { request: sent }) =
            serde_json::from_str::<ServerMessage>(&text)
        else {
            panic!("the frame was not a computer request")
        };
        assert_eq!(sent.request_id, "req_fresh");
        assert!(matches!(sent.op, ComputerOpV1::Input { .. }));
        hub.handle_computer_reply(
            &node_id,
            second_generation,
            ComputerReplyV1::refusal("req_fresh", ComputerCodeV1::Ok),
        )
        .await;
        assert!(
            call.await.expect("join").is_ok(),
            "a fresh input on the current connection must still be delivered"
        );
        assert!(hub.inner.lock().await.computer_waits.is_empty());
    }

    /// A disconnect retires pending computer calls instead of leaving a caller
    /// to wait out a deadline for a socket that is already gone.
    #[tokio::test]
    async fn detach_fails_pending_computer_requests_instead_of_waiting_out_the_deadline() {
        use loom_protocol::computer::{ComputerOpV1, ComputerRequestV1};
        let hub = Arc::new(test_hub());
        let (node_id, mut frames) = attach_reports(&hub, Vec::new()).await;
        let generation = hub.inner.lock().await.nodes[&node_id].generation;
        hub.set_computer_versions(&node_id, generation, vec![COMPUTER_VERSION])
            .await;
        let call = tokio::spawn({
            let hub = Arc::clone(&hub);
            let node_id = node_id.clone();
            async move {
                hub.computer_request(
                    &node_id,
                    generation,
                    ComputerRequestV1 {
                        version: COMPUTER_VERSION,
                        request_id: "req_pending".to_owned(),
                        op: ComputerOpV1::Info {},
                    },
                    Duration::from_secs(30),
                )
                .await
            }
        });
        assert!(frames.recv().await.is_some(), "the request was not sent");
        hub.detach(&node_id, generation).await;
        assert_eq!(
            call.await.expect("join").err(),
            Some("node_offline"),
            "a detached node left the caller waiting instead of failing it"
        );
        assert!(hub.inner.lock().await.computer_waits.is_empty());
    }

    fn cli_report(kind: &str, path: &str, path_present: bool) -> CliReport {
        CliReport {
            adapter_kind: kind.to_owned(),
            path: path.to_owned(),
            version: Some("b3".into()),
            path_present,
            installation_identity: None,
            installation_generation: None,
        }
    }

    fn remote_node<'a>(listed: &'a Value, node_id: &str) -> &'a Value {
        listed["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["nodeId"] == node_id)
            .unwrap_or_else(|| panic!("missing {node_id} in {listed}"))
    }

    #[tokio::test]
    async fn unused_pairing_code_is_shown_again_until_it_is_redeemed() {
        let hub = test_hub();
        let (first, first_ttl) = hub.issue_pairing().await;
        assert_eq!(first_ttl, PAIRING_TTL.as_secs());
        let (second, second_ttl) = hub.issue_pairing().await;
        assert_eq!(first, second);
        assert!(second_ttl <= first_ttl);
        let peer = IpAddr::V4(Ipv4Addr::LOCALHOST);
        hub.redeem(&first, peer).await.expect("pairing code");
        let (third, _) = hub.issue_pairing().await;
        assert_ne!(third, first);
        assert!(hub.redeem(&first, peer).await.is_err());
        assert!(hub.redeem(&third, peer).await.is_ok());
    }

    #[test]
    fn prepare_workspace_remote_sources_keep_executor_path_syntax() {
        for source in [
            "/home/loom/fixture/source",
            r"C:\fixture\source",
            r"\\server\share\source",
            r"\\?\C:\fixture\source",
        ] {
            assert!(valid_workspace_source(source, false), "{source}");
        }
        // Deferring host-specific syntax does not remove the executor's gate.
        let worktree = std::env::temp_dir().join("loom-relative-source-rejected");
        assert_eq!(
            loom_protocol::prepare_git_worktree(
                std::path::Path::new("relative-source"),
                &worktree,
                "loom-fixture",
            ),
            Err("invalid_workspace")
        );
    }

    #[test]
    fn prepare_workspace_local_source_keeps_absolute_and_bounded_contract() {
        let source = std::env::temp_dir().join("loom-local-source");
        assert!(valid_workspace_source(&source.to_string_lossy(), true));
        for relative in ["source", ".", "../source"] {
            assert!(!valid_workspace_source(relative, true), "{relative}");
        }
        for local in [false, true] {
            assert!(!valid_workspace_source("", local));
            assert!(!valid_workspace_source("/source\0suffix", local));
            assert!(!valid_workspace_source(&"x".repeat(4097), local));
        }
        #[cfg(windows)]
        assert!(!valid_workspace_source("/home/loom/fixture/source", true));
        #[cfg(unix)]
        assert!(!valid_workspace_source(r"C:\fixture\source", true));
    }

    #[test]
    fn connect_target_uses_public_origin_and_otherwise_warns() {
        let listen: SocketAddr = "127.0.0.1:8767".parse().unwrap();
        let (tunnel, warn) = connect_target(listen, Some("https://loom.trycloudflare.com"));
        assert_eq!(tunnel, "wss://loom.trycloudflare.com/api/v1/nodes/connect");
        assert!(!warn);
        let (lan, warn) = connect_target(listen, Some("http://10.1.2.3:8443"));
        assert_eq!(lan, "ws://10.1.2.3:8443/api/v1/nodes/connect");
        assert!(!warn);
        let (fallback, warn) = connect_target(listen, None);
        assert_eq!(fallback, "ws://127.0.0.1:8767/api/v1/nodes/connect");
        assert!(warn);
        let v6: SocketAddr = "[::1]:8767".parse().unwrap();
        let (loopback, warn) = connect_target(v6, Some("  "));
        assert_eq!(loopback, "ws://[::1]:8767/api/v1/nodes/connect");
        assert!(warn);
    }
}
