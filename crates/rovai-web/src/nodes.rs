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
use loom_protocol::{
    CONNECT_PATH, CliReport, ClientMessage, OutputStream, RunReport, ServerMessage,
};
use rovai_core::execution_node::{
    CliRecord, NextAttempt, NodeStore, OutputWrite, RevokeResult, TaskHost, WorkspaceRecord,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, mpsc, oneshot};

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

#[derive(Clone)]
struct Outbox {
    tx: mpsc::Sender<Outbound>,
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
}

struct Run {
    node_id: String,
    attempt: u32,
    done: Option<oneshot::Sender<Result<RunOutcome, &'static str>>>,
}

struct FsWait {
    node_id: String,
    done: oneshot::Sender<ClientMessage>,
}

#[derive(Clone, Default)]
struct RunScope {
    mission_id: Option<String>,
    member_id: Option<String>,
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
    sessions: Arc<Sessions>,
    pub(crate) store: NodeStore,
    inner: Mutex<Inner>,
    /// Test-only pause after a hello is accepted and before the socket is registered.
    #[cfg(test)]
    attach_gate: Mutex<Option<Arc<AttachGate>>>,
}

impl Hub {
    pub fn start(sessions: Arc<Sessions>, store: NodeStore) -> Arc<Self> {
        let hub = Arc::new(Self::new(sessions, store));
        let expiring = Arc::clone(&hub);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                expiring.expire().await;
            }
        });
        hub
    }

    fn new(sessions: Arc<Sessions>, store: NodeStore) -> Self {
        Self {
            sessions,
            store,
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
        if self.sessions.is_administrator(code) {
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
        if self.sessions.is_administrator(token) || !valid_credential(token) {
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
            });
            if let Some(previous) = node.cancel.take() {
                let _ = previous.send(());
            }
            node.generation = node.generation.saturating_add(1);
            node.clis = clis;
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

    async fn reconcile(&self, node_id: &str, reports: &[RunReport]) -> Vec<ServerMessage> {
        let running = match self.store.running_for_node(node_id) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        let mut messages = Vec::new();
        for dispatch in running {
            let report = reports.iter().find(|report| {
                report.run_id == dispatch.run_id && report.attempt == dispatch.attempt
            });
            let resume = match report {
                Some(report) if report.process_alive || report.sent_seq > dispatch.acked_seq => {
                    true
                }
                _ => false,
            };
            if resume {
                let mut inner = self.inner.lock().await;
                inner.runs.entry(dispatch.run_id.clone()).or_insert(Run {
                    node_id: node_id.to_owned(),
                    attempt: dispatch.attempt,
                    done: None,
                });
                messages.push(ServerMessage::Resume {
                    run_id: dispatch.run_id,
                    attempt: dispatch.attempt,
                    acked_seq: dispatch.acked_seq,
                });
            } else if self
                .store
                .interrupt(&dispatch.run_id, dispatch.attempt)
                .is_ok()
            {
                let mut inner = self.inner.lock().await;
                inner.runs.remove(&dispatch.run_id);
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
    }

    pub(crate) async fn call_fs(
        &self,
        node_id: &str,
        request_id: &str,
        message: ServerMessage,
    ) -> Result<ClientMessage, &'static str> {
        let (tx, rx) = oneshot::channel();
        let outbound = {
            let mut inner = self.inner.lock().await;
            let Some(node) = inner.nodes.get(node_id) else {
                return Err("node_offline");
            };
            let Some(outbound) = node.outbound.clone() else {
                return Err("node_offline");
            };
            inner.fs_waiters.insert(
                request_id.to_owned(),
                FsWait {
                    node_id: node_id.to_owned(),
                    done: tx,
                },
            );
            outbound
        };
        if !outbound.send_text(message.to_json()).await {
            let mut inner = self.inner.lock().await;
            inner.fs_waiters.remove(request_id);
            return Err("node_offline");
        }
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(message)) => Ok(message),
            _ => {
                let mut inner = self.inner.lock().await;
                inner.fs_waiters.remove(request_id);
                Err("node_offline")
            }
        }
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
        match tokio::time::timeout(RUN_TIMEOUT, rx).await {
            Ok(Ok(Ok(outcome))) => Ok((run_id, outcome)),
            Ok(Ok(Err(code))) => Err(code),
            Ok(Err(_)) => Err("node_disconnected"),
            Err(_) => {
                self.abandon(&run_id).await;
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
            selected = Some((only.to_owned(), cli.path.clone(), outbound));
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
            selected = Some((id.clone(), cli.path.clone(), outbound));
            break;
        }
        let Some((node_id, program, outbound)) = selected else {
            if connected {
                return Err("node_cli_unreported");
            }
            return Ok(None);
        };
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        self.store
            .begin_dispatch(&run_id, 1, &node_id, runtime)
            .map_err(|_| "node_runtime_unavailable")?;
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
        }
        .to_json();
        let (tx, rx) = oneshot::channel();
        inner.runs.insert(
            run_id.clone(),
            Run {
                node_id,
                attempt: 1,
                done: Some(tx),
            },
        );
        drop(inner);
        if !outbound.send_text(start).await {
            self.abandon(&run_id).await;
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
        let scope = self.scope_for_attempt(run_id, scope)?;
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
        }
        .to_json();
        let (tx, rx) = oneshot::channel();
        inner.runs.insert(
            run_id.to_owned(),
            Run {
                node_id,
                attempt,
                done: Some(tx),
            },
        );
        drop(inner);
        if !outbound.send_text(start).await {
            self.abandon(run_id).await;
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
            return self.spawn_local(node_id, runtime, cwd, args).await;
        }
        let Some((run_id, rx)) = self
            .try_dispatch(runtime, cwd, args, None, scope, Some(node_id))
            .await?
        else {
            return Err("node_runtime_unavailable");
        };
        match tokio::time::timeout(RUN_TIMEOUT, rx).await {
            Ok(Ok(Ok(outcome))) => Ok((run_id, outcome)),
            Ok(Ok(Err(code))) => Err(code),
            Ok(Err(_)) => Err("node_disconnected"),
            Err(_) => {
                self.abandon(&run_id).await;
                Err("node_run_timeout")
            }
        }
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

    async fn abandon(&self, run_id: &str) {
        let mut inner = self.inner.lock().await;
        if let Some(run) = inner.runs.remove(run_id) {
            let _ = self.store.interrupt(run_id, run.attempt);
        }
    }

    async fn apply_output(
        &self,
        node_id: &str,
        generation: u64,
        run_id: &str,
        stream: OutputStream,
        seq: u64,
        data: &str,
    ) {
        let Ok(bytes) = STANDARD.decode(data) else {
            self.fail_run(run_id, "invalid_output").await;
            return;
        };
        let (attempt, outbound) = {
            let inner = self.inner.lock().await;
            let Some(node) = inner.nodes.get(node_id) else {
                return;
            };
            if node.generation != generation {
                return;
            }
            let Some(run) = inner.runs.get(run_id) else {
                return;
            };
            if run.node_id != node_id {
                return;
            }
            (run.attempt, node.outbound.clone())
        };
        let stream_name = match stream {
            OutputStream::Stdout => "stdout",
            OutputStream::Stderr => "stderr",
        };
        let wrote = self
            .store
            .append_output(run_id, attempt, seq, stream_name, &bytes, MAX_OUTPUT);
        match wrote {
            Ok(OutputWrite::Stored | OutputWrite::Duplicate) => {
                if let Some(outbound) = outbound {
                    outbound.try_ack(run_id, seq);
                }
            }
            Ok(OutputWrite::Gap) => self.fail_run(run_id, "sequence_gap").await,
            Ok(OutputWrite::TooLarge) => self.fail_run(run_id, "output_too_large").await,
            Ok(OutputWrite::Missing) | Err(_) => {}
        }
    }

    async fn apply_exit(&self, node_id: &str, generation: u64, run_id: &str, seq: u64, code: i32) {
        let (attempt, outbound) = {
            let inner = self.inner.lock().await;
            let generation_ok = inner
                .nodes
                .get(node_id)
                .is_some_and(|node| node.generation == generation);
            if !generation_ok {
                return;
            }
            let Some(run) = inner.runs.get(run_id) else {
                return;
            };
            if run.node_id != node_id {
                return;
            }
            (
                run.attempt,
                inner
                    .nodes
                    .get(node_id)
                    .and_then(|node| node.outbound.clone()),
            )
        };
        match self.store.finish(run_id, attempt, seq, code) {
            Ok(OutputWrite::Stored) => {
                if let Some(outbound) = outbound {
                    outbound.try_ack(run_id, seq);
                }
                self.complete_waiter(run_id).await;
            }
            Ok(OutputWrite::Duplicate) => {
                if let Some(outbound) = outbound {
                    outbound.try_ack(run_id, seq);
                }
            }
            Ok(OutputWrite::Gap) => self.fail_run(run_id, "sequence_gap").await,
            Ok(OutputWrite::Missing | OutputWrite::TooLarge) | Err(_) => {}
        }
    }

    async fn complete_waiter(&self, run_id: &str) {
        let done = {
            let mut inner = self.inner.lock().await;
            inner
                .runs
                .remove(run_id)
                .and_then(|mut run| run.done.take())
        };
        let Some(done) = done else {
            return;
        };
        let outcome = self.store.output_from(run_id, 1).ok().flatten();
        let Some((dispatch, frames)) = outcome else {
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
            exit_code: dispatch.exit_code.unwrap_or(1),
            stdout,
            stderr,
        }));
    }

    async fn fail_run(&self, run_id: &str, code: &'static str) {
        let mut inner = self.inner.lock().await;
        if let Some(mut run) = inner.runs.remove(run_id) {
            let _ = self.store.interrupt(run_id, run.attempt);
            if let Some(done) = run.done.take() {
                let _ = done.send(Err(code));
            }
        }
    }

    async fn note_rejection(
        &self,
        node_id: &str,
        generation: u64,
        run_id: &str,
        attempt: u32,
        code: &'static str,
    ) {
        let inner = self.inner.lock().await;
        let generation_ok = inner
            .nodes
            .get(node_id)
            .is_some_and(|node| node.generation == generation);
        if !generation_ok {
            return;
        }
        drop(inner);
        let _ = self.store.interrupt(run_id, attempt);
        self.fail_run(run_id, code).await;
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
                    Some((id.clone(), kinds))
                })
                .collect::<HashMap<_, _>>()
        };
        let rows: Vec<Value> = nodes
            .into_iter()
            .map(|node| {
                let live_kinds = live.get(&node.node_id);
                json!({
                    "nodeId": node.node_id,
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
                    "activeRuns": node.active_runs.iter().map(|run| json!({
                        "runId": run.run_id,
                        "attempt": run.attempt,
                        "runtime": run.runtime,
                        "status": run.status,
                        "ackedSeq": run.acked_seq,
                    })).collect::<Vec<_>>(),
                    "clis": node.clis.iter().map(|cli| {
                        let live = live_kinds.is_some_and(|kinds| kinds.contains(&cli.adapter_kind));
                        json!({
                            "adapterKind": cli.adapter_kind,
                            "path": cli.path,
                            "version": cli.version,
                            "pathPresent": cli.path_present,
                            "reportedAt": cli.reported_at,
                            "availability": cli_availability(node.status == "online", cli.path_present, live),
                        })
                    }).collect::<Vec<_>>(),
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
        let writer_acks = Arc::clone(&acks);
        let writer = tokio::spawn(async move {
            while let Some(item) = incoming.recv().await {
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
        });
        let outbound = Outbox {
            tx: tx.clone(),
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
                        } => {
                            if runs.len() > 32
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
                                            Outbox {
                                                tx: tx.clone(),
                                                acks: Arc::clone(&outbound.acks),
                                            },
                                            cancel_tx,
                                            &os,
                                            &arch,
                                            clis,
                                        )
                                        .await
                                    {
                                        Ok(generation) => {
                                            let _ = self
                                                .store
                                                .adopt_reported_hostname(&node_id, &hostname);
                                            attached = Some((node_id.clone(), generation));
                                            let resumes = self.reconcile(&node_id, &runs).await;
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
                            let mut inner = self.inner.lock().await;
                            if let Some(wait) = inner.fs_waiters.remove(&request_id) {
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
                                let failure = if code == "program_not_allowed" {
                                    "program_not_allowed"
                                } else {
                                    "node_rejected"
                                };
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
        let _ = writer.await;
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

fn fail_node_waiters(inner: &mut Inner, node_id: &str) {
    let ids: Vec<String> = inner
        .runs
        .iter()
        .filter(|(_, run)| run.node_id == node_id && run.done.is_some())
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(mut run) = inner.runs.remove(&id)
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
    let scope = RunScope {
        mission_id: body.mission_id.clone(),
        member_id: body.member_id.clone(),
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
        || body.source.len() > 4096
        || body.source.contains('\0')
        || !std::path::Path::new(&body.source).is_absolute()
    {
        return workspace_error(StatusCode::BAD_REQUEST, "invalid_workspace");
    }
    if let Ok(Some(existing)) = state.nodes.store.workspace_by_mission(&body.mission_id) {
        return Json(workspace_json(&existing)).into_response();
    }
    let role = match state.nodes.store.node_role(&body.node_id) {
        Ok(Some(role)) => role,
        Ok(None) => return workspace_error(StatusCode::NOT_FOUND, "node_not_found"),
        Err(_) => {
            return workspace_error(StatusCode::SERVICE_UNAVAILABLE, "node_store_unavailable");
        }
    };
    let branch = match loom_protocol::safe_branch(&body.mission_id) {
        Ok(branch) => branch,
        Err(code) => return workspace_error(StatusCode::BAD_REQUEST, code),
    };
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
        let request_id = format!("fs_{}", uuid::Uuid::new_v4().simple());
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
        id: format!("ws_{}", uuid::Uuid::new_v4().simple()),
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
    if loom_protocol::workspace_relative(&record.worktree_path, &query.relative).is_err() {
        return workspace_error(StatusCode::BAD_REQUEST, "path_rejected");
    }
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
            relative: query.relative.clone(),
        }
    } else {
        ServerMessage::ListDir {
            request_id: request_id.clone(),
            root: record.worktree_path.clone(),
            relative: query.relative.clone(),
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

fn exec_error(code: &'static str) -> Response {
    let status = match code {
        "invalid_node_exec" => StatusCode::BAD_REQUEST,
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
    use std::net::Ipv4Addr;

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

    fn cli_report(kind: &str, path: &str, path_present: bool) -> CliReport {
        CliReport {
            adapter_kind: kind.to_owned(),
            path: path.to_owned(),
            version: Some("b3".into()),
            path_present,
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
