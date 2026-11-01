//! Execution nodes for milestone B2.
//!
//! Node tokens are stored as digests in SQLite, so they survive a server
//! restart. Pairing codes stay in memory. A remote node is only used when
//! `node-exec` targets it; it is not the mission execution host.

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
use loom_protocol::{CONNECT_PATH, ClientMessage, OutputStream, RunReport, ServerMessage};
use rovai_core::execution_node::{CliRecord, NextAttempt, NodeStore, OutputWrite, RevokeResult};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
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
const MAX_FRAME: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const OUTPUT_PAGE: usize = 1000;
const OUTBOUND_QUEUE: usize = 64;
const NODE_KIND: &[u8] = b"rovai-node-v1\0";
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

struct Inner {
    pairings: HashMap<[u8; 32], Instant>,
    pairing_failures: PairingLimiter,
    nodes: HashMap<String, Node>,
    runs: HashMap<String, Run>,
}

pub struct Hub {
    sessions: Arc<Sessions>,
    store: NodeStore,
    inner: Mutex<Inner>,
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
                pairing_failures: PairingLimiter {
                    by_address: HashMap::new(),
                    global: VecDeque::new(),
                },
                nodes: HashMap::new(),
                runs: HashMap::new(),
            }),
        }
    }

    async fn issue_pairing(&self) -> String {
        let code = random_hex(8);
        let digest = keyed_digest(PAIRING_KIND, &code);
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        inner.pairings.retain(|_, expiry| *expiry > now);
        inner.pairings.insert(digest, now + PAIRING_TTL);
        code
    }

    async fn redeem(&self, code: &str, peer: IpAddr) -> Result<Issued, &'static str> {
        {
            let mut inner = self.inner.lock().await;
            if inner.pairing_failures.limited(peer, Instant::now()) {
                return Err("pairing_rate_limited");
            }
        }
        let failed = self.redeem_code(code).await;
        if let Err(code) = &failed {
            if *code != "pairing_rate_limited" {
                let mut inner = self.inner.lock().await;
                inner.pairing_failures.record(peer, Instant::now());
            }
        }
        failed
    }

    async fn redeem_code(&self, code: &str) -> Result<Issued, &'static str> {
        if self.sessions.is_administrator(code) {
            return Err("administrator_rejected");
        }
        let digest = keyed_digest(PAIRING_KIND, code);
        let node_id = format!("node_{}", uuid::Uuid::new_v4().simple());
        let display_name = format!("node-{}", &node_id[5..13]);
        let token = crate::new_token().map_err(|_| "token_unavailable")?;
        let token_digest = digest_hex(&token);
        {
            let mut inner = self.inner.lock().await;
            let Some(expiry) = inner.pairings.remove(&digest) else {
                return Err("pairing_invalid");
            };
            if expiry <= Instant::now() {
                return Err("pairing_invalid");
            }
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
            if cli.adapter_kind.len() > 64
                || cli.path.len() > 4096
                || cli.path.contains('\0')
                || cli
                    .version
                    .as_ref()
                    .is_some_and(|version| version.len() > 200)
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
        let mut inner = self.inner.lock().await;
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
        Ok(node.generation)
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
    ) -> Result<(String, RunOutcome), &'static str> {
        let deadline = Instant::now() + NODE_WAIT;
        let (run_id, rx) = loop {
            match self.try_dispatch(runtime, cwd, args, existing_run).await? {
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
    ) -> Result<Option<(String, oneshot::Receiver<Result<RunOutcome, &'static str>>)>, &'static str>
    {
        if let Some(run_id) = existing_run {
            return self
                .try_redispatch(run_id, runtime, cwd, args)
                .await
                .map(Some);
        }
        let mut inner = self.inner.lock().await;
        let Some((node_id, program, outbound)) = inner.nodes.iter().find_map(|(id, node)| {
            let cli = node.clis.iter().find(|cli| {
                cli.adapter_kind == runtime && cli.path_present && !cli.path.is_empty()
            })?;
            let outbound = node.outbound.clone();
            let outbound = outbound?;
            Some((id.clone(), cli.path.clone(), outbound))
        }) else {
            return Ok(None);
        };
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        self.store
            .begin_dispatch(&run_id, 1, &node_id, runtime)
            .map_err(|_| "node_runtime_unavailable")?;
        let start = ServerMessage::Start {
            run_id: run_id.clone(),
            attempt: 1,
            adapter_kind: runtime.to_owned(),
            program,
            args: args.to_vec(),
            cwd: cwd.to_owned(),
            env: Vec::new(),
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
        let Some(program) = node
            .clis
            .iter()
            .find(|cli| cli.adapter_kind == runtime && cli.path_present)
            .map(|cli| cli.path.clone())
        else {
            drop(inner);
            let _ = self.store.interrupt(run_id, attempt);
            return Err("node_runtime_unavailable");
        };
        let Some(outbound) = node.outbound.clone() else {
            drop(inner);
            let _ = self.store.interrupt(run_id, attempt);
            return Err("node_runtime_unavailable");
        };
        let start = ServerMessage::Start {
            run_id: run_id.to_owned(),
            attempt,
            adapter_kind: runtime.to_owned(),
            program,
            args: args.to_vec(),
            cwd: cwd.to_owned(),
            env: Vec::new(),
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

    fn list_nodes(&self) -> Result<Value, &'static str> {
        let nodes = self
            .store
            .list_nodes()
            .map_err(|_| "node_store_unavailable")?;
        let rows: Vec<Value> = nodes
            .into_iter()
            .map(|node| {
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
                    "clis": node.clis.iter().map(|cli| json!({
                        "adapterKind": cli.adapter_kind,
                        "path": cli.path,
                        "version": cli.version,
                        "pathPresent": cli.path_present,
                        "reportedAt": cli.reported_at,
                    })).collect::<Vec<_>>(),
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
}

fn keyed_digest(kind: &[u8], token: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(kind);
    hash.update(token.as_bytes());
    hash.finalize().into()
}

fn digest_hex(token: &str) -> String {
    keyed_digest(NODE_KIND, token)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_credential(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
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
    let code = state.nodes.issue_pairing().await;
    Json(json!({
        "pairingCode": code,
        "expiresInSeconds": PAIRING_TTL.as_secs(),
        "connectUrl": format!("ws://{}{CONNECT_PATH}", state.network.listen),
    }))
    .into_response()
}

pub(crate) async fn list(
    State(state): State<WebState>,
    Extension(_session): Extension<Arc<Session>>,
) -> Response {
    match state.nodes.list_nodes() {
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
    match state
        .nodes
        .dispatch(&body.runtime, &body.cwd, &body.args, body.run_id.as_deref())
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
    Ok(())
}

fn exec_error(code: &'static str) -> Response {
    let status = match code {
        "invalid_node_exec" => StatusCode::BAD_REQUEST,
        "node_runtime_unavailable" | "node_run_still_active" | "node_run_not_interrupted" => {
            StatusCode::CONFLICT
        }
        "node_run_not_found" => StatusCode::NOT_FOUND,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    };
    error(status, code)
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
        let code = hub.issue_pairing().await;
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
        let kept = hub.issue_pairing().await;
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
}
