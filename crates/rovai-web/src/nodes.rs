//! In-memory execution nodes for milestone B1.
//!
//! The plaintext node token is returned once on the socket and is not stored.
//! Restart survival and the `execution_node` table are B2; this process keeps
//! only the token digest and the in-flight run.

use crate::auth::{Session, Sessions};
use crate::{WebState, error};
use axum::{
    Json,
    extract::{
        Extension, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use loom_protocol::{CONNECT_PATH, ClientMessage, OutputStream, ServerMessage};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, mpsc, oneshot};

pub const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const NODE_WAIT: Duration = Duration::from_secs(30);
const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HELLO_DEADLINE: Duration = Duration::from_secs(10);
const MAX_FRAME: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const NODE_KIND: &[u8] = b"rovai-node-v1\0";
const PAIRING_KIND: &[u8] = b"rovai-node-pairing-v1\0";

enum Outbound {
    Text(String),
    Pong(Vec<u8>),
}

struct Node {
    token_digest: [u8; 32],
    online: bool,
    last_heartbeat: Instant,
    generation: u64,
    clis: Vec<loom_protocol::CliReport>,
    outbound: Option<mpsc::UnboundedSender<Outbound>>,
}

struct Run {
    node_id: String,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    next_seq: u64,
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

struct Inner {
    pairings: HashMap<[u8; 32], Instant>,
    nodes: HashMap<String, Node>,
    runs: HashMap<String, Run>,
}

pub struct Hub {
    sessions: Arc<Sessions>,
    inner: Mutex<Inner>,
}

impl Hub {
    pub fn start(sessions: Arc<Sessions>) -> Arc<Self> {
        let hub = Arc::new(Self::new(sessions));
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

    fn new(sessions: Arc<Sessions>) -> Self {
        Self {
            sessions,
            inner: Mutex::new(Inner {
                pairings: HashMap::new(),
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

    async fn redeem(&self, code: &str) -> Result<Issued, &'static str> {
        if self.sessions.is_administrator(code) {
            return Err("administrator_rejected");
        }
        let digest = keyed_digest(PAIRING_KIND, code);
        let mut inner = self.inner.lock().await;
        let Some(expiry) = inner.pairings.remove(&digest) else {
            return Err("pairing_invalid");
        };
        if expiry <= Instant::now() {
            return Err("pairing_invalid");
        }
        let token = crate::new_token().map_err(|_| "token_unavailable")?;
        let node_id = format!("node_{}", uuid::Uuid::new_v4().simple());
        inner.nodes.insert(
            node_id.clone(),
            Node {
                token_digest: keyed_digest(NODE_KIND, &token),
                online: false,
                last_heartbeat: Instant::now(),
                generation: 0,
                clis: Vec::new(),
                outbound: None,
            },
        );
        Ok(Issued { node_id, token })
    }

    async fn authorize(&self, node_id: &str, token: &str) -> Result<(), &'static str> {
        if self.sessions.is_administrator(token) || !valid_credential(token) {
            return Err("administrator_rejected");
        }
        let digest = keyed_digest(NODE_KIND, token);
        let inner = self.inner.lock().await;
        let Some(node) = inner.nodes.get(node_id) else {
            return Err("token_rejected");
        };
        if !bool::from(node.token_digest.ct_eq(&digest)) {
            return Err("token_rejected");
        }
        Ok(())
    }

    async fn attach(
        &self,
        node_id: &str,
        outbound: mpsc::UnboundedSender<Outbound>,
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
        let mut inner = self.inner.lock().await;
        let Some(node) = inner.nodes.get_mut(node_id) else {
            return Err("token_rejected");
        };
        node.generation = node.generation.saturating_add(1);
        node.online = true;
        node.last_heartbeat = Instant::now();
        node.clis = clis;
        node.outbound = Some(outbound);
        Ok(node.generation)
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
            node.online = false;
            node.outbound = None;
        }
        fail_node_runs(&mut inner, node_id);
    }

    async fn heartbeat(&self, node_id: &str, generation: u64) {
        let mut inner = self.inner.lock().await;
        let Some(node) = inner.nodes.get_mut(node_id) else {
            return;
        };
        if node.generation == generation && node.outbound.is_some() {
            node.last_heartbeat = Instant::now();
            node.online = true;
        }
    }

    async fn expire(&self) {
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        inner.pairings.retain(|_, expiry| *expiry > now);
        for node in inner.nodes.values_mut() {
            if node.online && now.duration_since(node.last_heartbeat) > HEARTBEAT_TIMEOUT {
                node.online = false;
            }
        }
    }

    async fn dispatch(
        &self,
        runtime: &str,
        cwd: &str,
        args: &[String],
    ) -> Result<(String, RunOutcome), &'static str> {
        let deadline = Instant::now() + NODE_WAIT;
        let (run_id, rx) = loop {
            match self.try_dispatch(runtime, cwd, args).await? {
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
    ) -> Result<Option<(String, oneshot::Receiver<Result<RunOutcome, &'static str>>)>, &'static str>
    {
        let mut inner = self.inner.lock().await;
        let Some((node_id, program, outbound)) = inner.nodes.iter().find_map(|(id, node)| {
            if !node.online {
                return None;
            }
            let cli = node.clis.iter().find(|cli| {
                cli.adapter_kind == runtime && cli.path_present && !cli.path.is_empty()
            })?;
            let outbound = node.outbound.clone()?;
            Some((id.clone(), cli.path.clone(), outbound))
        }) else {
            return Ok(None);
        };
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
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
                stdout: Vec::new(),
                stderr: Vec::new(),
                next_seq: 1,
                done: Some(tx),
            },
        );
        if outbound.send(Outbound::Text(start)).is_err() {
            inner.runs.remove(&run_id);
            return Err("node_disconnected");
        }
        Ok(Some((run_id, rx)))
    }

    async fn abandon(&self, run_id: &str) {
        let mut inner = self.inner.lock().await;
        inner.runs.remove(run_id);
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
        let mut inner = self.inner.lock().await;
        let sender = match inner.nodes.get(node_id) {
            Some(node) if node.generation == generation => node.outbound.clone(),
            _ => return,
        };
        let ack = {
            let Some(run) = inner.runs.get_mut(run_id) else {
                return;
            };
            if run.node_id != node_id || run.done.is_none() {
                return;
            }
            if seq != run.next_seq || dest_would_overflow(run, stream, bytes.len()) {
                let code = if seq != run.next_seq {
                    "sequence_gap"
                } else {
                    "output_too_large"
                };
                let done = run.done.take();
                OutputStep::Fail(code, done)
            } else {
                let dest = match stream {
                    OutputStream::Stdout => &mut run.stdout,
                    OutputStream::Stderr => &mut run.stderr,
                };
                dest.extend_from_slice(&bytes);
                run.next_seq = run.next_seq.saturating_add(1);
                OutputStep::Ack
            }
        };
        match ack {
            OutputStep::Ack => {
                if let Some(sender) = sender {
                    let _ = sender.send(Outbound::Text(
                        ServerMessage::Ack {
                            run_id: run_id.to_owned(),
                            seq,
                        }
                        .to_json(),
                    ));
                }
            }
            OutputStep::Fail(code, done) => {
                inner.runs.remove(run_id);
                if let Some(done) = done {
                    let _ = done.send(Err(code));
                }
            }
        }
    }

    async fn apply_exit(&self, node_id: &str, generation: u64, run_id: &str, seq: u64, code: i32) {
        let mut inner = self.inner.lock().await;
        let generation_ok = inner
            .nodes
            .get(node_id)
            .is_some_and(|node| node.generation == generation);
        if !generation_ok {
            return;
        }
        let sender = inner
            .nodes
            .get(node_id)
            .and_then(|node| node.outbound.clone());
        let finished = {
            let Some(run) = inner.runs.get_mut(run_id) else {
                return;
            };
            if run.node_id != node_id || run.done.is_none() {
                return;
            }
            if seq != run.next_seq {
                let done = run.done.take();
                ExitStep::Fail(done)
            } else {
                let outcome = RunOutcome {
                    exit_code: code,
                    stdout: std::mem::take(&mut run.stdout),
                    stderr: std::mem::take(&mut run.stderr),
                };
                let done = run.done.take();
                ExitStep::Done(done, outcome)
            }
        };
        inner.runs.remove(run_id);
        match finished {
            ExitStep::Fail(done) => {
                if let Some(done) = done {
                    let _ = done.send(Err("sequence_gap"));
                }
            }
            ExitStep::Done(done, outcome) => {
                if let Some(done) = done {
                    let _ = done.send(Ok(outcome));
                }
                if let Some(sender) = sender {
                    let _ = sender.send(Outbound::Text(
                        ServerMessage::Ack {
                            run_id: run_id.to_owned(),
                            seq,
                        }
                        .to_json(),
                    ));
                }
            }
        }
    }

    async fn fail_run(&self, run_id: &str, code: &'static str) {
        let mut inner = self.inner.lock().await;
        if let Some(mut run) = inner.runs.remove(run_id)
            && let Some(done) = run.done.take()
        {
            let _ = done.send(Err(code));
        }
    }

    async fn handle(self: Arc<Self>, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (outbound, mut incoming) = mpsc::unbounded_channel();
        let writer = tokio::spawn(async move {
            while let Some(item) = incoming.recv().await {
                let message = match item {
                    Outbound::Text(text) => Message::Text(text.into()),
                    Outbound::Pong(data) => Message::Pong(data.into()),
                };
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });
        let mut attached: Option<(String, u64)> = None;
        let deadline = Instant::now() + HELLO_DEADLINE;
        let mut welcomed = false;
        loop {
            let frame = if welcomed {
                stream.next().await
            } else {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    let _ = outbound.send(Outbound::Text(
                        ServerMessage::Error {
                            code: "hello_timeout".into(),
                        }
                        .to_json(),
                    ));
                    break;
                }
                match tokio::time::timeout(remaining, stream.next()).await {
                    Ok(frame) => frame,
                    Err(_) => {
                        let _ = outbound.send(Outbound::Text(
                            ServerMessage::Error {
                                code: "hello_timeout".into(),
                            }
                            .to_json(),
                        ));
                        break;
                    }
                }
            };
            let Some(frame) = frame else { break };
            let Ok(frame) = frame else { break };
            match frame {
                Message::Ping(data) => {
                    let _ = outbound.send(Outbound::Pong(data.to_vec()));
                }
                Message::Close(_) => break,
                Message::Text(text) => {
                    if text.len() > MAX_FRAME {
                        break;
                    }
                    let message = match serde_json::from_str::<ClientMessage>(text.as_str()) {
                        Ok(message) => message,
                        Err(_) => {
                            let _ = outbound.send(Outbound::Text(
                                ServerMessage::Error {
                                    code: "invalid_frame".into(),
                                }
                                .to_json(),
                            ));
                            break;
                        }
                    };
                    match message {
                        ClientMessage::Pair { pairing_code } => {
                            if welcomed {
                                break;
                            }
                            match self.redeem(&pairing_code).await {
                                Ok(issued) => {
                                    let _ = outbound.send(Outbound::Text(
                                        ServerMessage::Paired {
                                            node_id: issued.node_id,
                                            token: issued.token,
                                        }
                                        .to_json(),
                                    ));
                                }
                                Err(code) => {
                                    let _ = outbound.send(Outbound::Text(
                                        ServerMessage::Error { code: code.into() }.to_json(),
                                    ));
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
                        } => match self.authorize(&node_id, &token).await {
                            Err(code) => {
                                let _ = outbound.send(Outbound::Text(
                                    ServerMessage::Error { code: code.into() }.to_json(),
                                ));
                                break;
                            }
                            Ok(()) => match self
                                .attach(&node_id, outbound.clone(), &os, &arch, clis)
                                .await
                            {
                                Ok(generation) => {
                                    attached = Some((node_id.clone(), generation));
                                    welcomed = true;
                                    let _ = outbound.send(Outbound::Text(
                                        ServerMessage::Welcome { node_id }.to_json(),
                                    ));
                                }
                                Err(code) => {
                                    let _ = outbound.send(Outbound::Text(
                                        ServerMessage::Error { code: code.into() }.to_json(),
                                    ));
                                    break;
                                }
                            },
                        },
                        ClientMessage::Heartbeat { .. } => {
                            if let Some((node_id, generation)) = &attached {
                                self.heartbeat(node_id, *generation).await;
                                let _ = outbound
                                    .send(Outbound::Text(ServerMessage::HeartbeatAck.to_json()));
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
                    }
                }
                Message::Binary(_) | Message::Pong(_) => {}
            }
        }
        if let Some((node_id, generation)) = attached {
            self.detach(&node_id, generation).await;
        }
        drop(outbound);
        let _ = writer.await;
    }
}

fn fail_node_runs(inner: &mut Inner, node_id: &str) {
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

fn valid_credential(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn random_hex(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    getrandom::fill(&mut buf).expect("system random source");
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) async fn connect(
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
    ws.max_frame_size(MAX_FRAME)
        .max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| async move { hub.handle(socket).await })
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecRequest {
    runtime: String,
    cwd: String,
    args: Vec<String>,
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
        .dispatch(&body.runtime, &body.cwd, &body.args)
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
    Ok(())
}

fn exec_error(code: &'static str) -> Response {
    let status = match code {
        "invalid_node_exec" => StatusCode::BAD_REQUEST,
        "node_runtime_unavailable" => StatusCode::CONFLICT,
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

enum OutputStep {
    Ack,
    Fail(
        &'static str,
        Option<oneshot::Sender<Result<RunOutcome, &'static str>>>,
    ),
}

enum ExitStep {
    Fail(Option<oneshot::Sender<Result<RunOutcome, &'static str>>>),
    Done(
        Option<oneshot::Sender<Result<RunOutcome, &'static str>>>,
        RunOutcome,
    ),
}

fn dest_would_overflow(run: &Run, stream: OutputStream, extra: usize) -> bool {
    let len = match stream {
        OutputStream::Stdout => run.stdout.len(),
        OutputStream::Stderr => run.stderr.len(),
    };
    len.saturating_add(extra) > MAX_OUTPUT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pairing_code_is_single_use_and_administrator_token_is_not_a_node() {
        let admin = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&admin).unwrap());
        let hub = Hub::new(sessions.clone());
        let code = hub.issue_pairing().await;
        match hub.redeem(&admin).await {
            Err("administrator_rejected") => {}
            Err(code) => panic!("unexpected pairing error {code}"),
            Ok(_) => panic!("administrator token was accepted as a pairing code"),
        }
        let issued = hub.redeem(&code).await.expect("pairing code");
        match hub.redeem(&code).await {
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
    }
}
