use crate::discover::resolve_executable;
use crate::{CliReport, shim};
use crate::legacy_run::{Journal, LaunchKey, Phase};
use rovai_process_boundary::{NativeProcess, ProcessSpec, StdinPolicy};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use loom_protocol::{ClientMessage, OutputStream, RunReport, ServerMessage};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Notify, mpsc, watch},
};

const HEARTBEAT: Duration = Duration::from_secs(10);
const CHUNK: usize = 16 * 1024;
const CONTROL_QUEUE: usize = 16;
const OUTPUT_QUEUE: usize = 32;
const UNACKED_WINDOW: usize = 64;

pub(crate) struct Issued {
    pub(crate) node_id: String,
    pub(crate) token: String,
}

enum Wire {
    Text(String),
    Pong(Vec<u8>),
}

struct Pending {
    seq: u64,
    json: String,
}

struct LiveRun {
    attempt: u32,
    key: LaunchKey,
    phase: Phase,
    closed: bool,
    tree_stopped: bool,
    next_seq: u64,
    terminal_seq: Option<u64>,
    acked: u64,
    queued: u64,
    pending: VecDeque<Pending>,
    alive: bool,
}

/// What this node may execute locally. `catalog: None` is the device-only shape:
/// no admitted Agent CLI, therefore no R1 runtime and no process pipe.
pub(crate) struct NodeHands {
    clis: Vec<CliReport>,
    catalog: Option<crate::installation_catalog::InstallationCatalog>,
    builtin: Option<crate::builtin_bridge::BuiltinBridge>,
}

impl NodeHands {
    /// A pure device daemon. It never probes for, admits or launches an Agent CLI.
    pub(crate) fn device_only() -> Self {
        Self {
            clis: Vec::new(),
            catalog: None,
            builtin: None,
        }
    }

    pub(crate) fn with_runtime(
        clis: Vec<CliReport>,
        catalog: crate::installation_catalog::InstallationCatalog,
        builtin: Option<crate::builtin_bridge::BuiltinBridge>,
    ) -> Self {
        Self {
            clis,
            catalog: Some(catalog),
            builtin,
        }
    }
}

struct Shared {
    data_dir: std::path::PathBuf,
    server: String,
    node_token: String,
    clis: Vec<CliReport>,
    /// The physical desktop this node owns, if the operator opted in.
    computer: Arc<crate::computer_provider::ComputerHost>,
    /// `None` on a device-only node: it owns no R1 process boundary at all.
    pipes: Option<Arc<crate::process_wire::NodePipes>>,
    authority: crate::workspace_authority::WorkspaceAuthority,
    workspace_rpc: crate::workspace_rpc::WorkspaceRpcWire,
    client_output: Mutex<Option<mpsc::Sender<ClientMessage>>>,
    fs_jobs: Arc<tokio::sync::Semaphore>,
    runs: Mutex<HashMap<String, LiveRun>>,
    journal: Journal,
    owners: Mutex<tokio::task::JoinSet<Result<()>>>,
    shutdown: watch::Sender<bool>,
    control: Mutex<Option<mpsc::Sender<Wire>>>,
    output: Mutex<Option<mpsc::Sender<Wire>>>,
    wake: Notify,
}

enum Stop {
    /// The socket closed. The caller reconnects and the processes stay up.
    Closed,
    /// The server will not accept this token again.
    Revoked,
}

pub(crate) async fn pair(server: &str, pairing_code: &str) -> Result<Issued> {
    let (control, _output, mut stream) = connect(server).await?;
    send_control(
        &control,
        &ClientMessage::Pair {
            pairing_code: pairing_code.to_owned(),
        },
    )
    .await?;
    let message = next_server(&mut stream).await?;
    match message {
        ServerMessage::Paired { node_id, token } => Ok(Issued { node_id, token }),
        ServerMessage::Error { code } => bail!("pairing rejected ({code})"),
        _ => bail!("pairing response was not a credential"),
    }
}

pub(crate) async fn serve(
    data_dir: &std::path::Path,
    server: &str,
    node_id: &str,
    token: &str,
    hands: NodeHands,
    computer: Arc<crate::computer_provider::ComputerHost>,
) -> Result<()> {
    let authority =
        crate::workspace_authority::WorkspaceAuthority::open(data_dir, node_id.to_owned())
            .map_err(|code| anyhow::anyhow!(code.code()))?;
    // No catalog means no admitted Agent CLI, so no process manager is built and
    // no installation/pipe directory is created or touched on this host.
    let NodeHands {
        clis,
        catalog,
        builtin,
    } = hands;
    let pipes = match catalog {
        Some(catalog) => Some(
            crate::process_wire::NodePipes::new(
                data_dir.to_path_buf(),
                node_id,
                catalog,
                authority.clone(),
                builtin,
            )
            .map_err(|code| anyhow::anyhow!(code))?,
        ),
        None => {
            debug_assert!(
                builtin.is_none(),
                "device-only hands must not own a builtin bridge"
            );
            None
        }
    };
    let rpc = crate::workspace_rpc::WorkspaceRpcExecutor::open(
        node_id.to_owned(),
        data_dir.join("workspace-rpc"),
        Vec::new(),
    )
    .map_err(|code| anyhow::anyhow!(code.code()))?;
    let workspace_rpc =
        crate::workspace_rpc::WorkspaceRpcWire::with_authority(rpc, authority.clone());
    let journal = Journal::open(data_dir, node_id).map_err(|code| anyhow::anyhow!(code))?;
    let (shutdown, _) = watch::channel(false);
    let shared = Arc::new(Shared {
        data_dir: data_dir.to_path_buf(),
        server: server.to_owned(),
        node_token: token.to_owned(),
        clis,
        computer,
        pipes,
        authority,
        workspace_rpc,
        client_output: Mutex::new(None),
        fs_jobs: Arc::new(tokio::sync::Semaphore::new(4)),
        runs: Mutex::new(HashMap::new()),
        journal,
        owners: Mutex::new(tokio::task::JoinSet::new()),
        shutdown,
        control: Mutex::new(None),
        output: Mutex::new(None),
        wake: Notify::new(),
    });
    let flusher = tokio::spawn(flush(Arc::clone(&shared)));
    let mut delay = Duration::from_millis(200);
    let connections = async { loop {
        match connect_once(server, node_id, token, &shared).await {
            Ok(Stop::Revoked) => break Err(anyhow::anyhow!("node token was revoked")),
            Ok(Stop::Closed) => delay = Duration::from_millis(200),
            Err(error) => {
                if fatal(&error) {
                    break Err(error);
                }
                eprintln!("loom-node: {error:#}");
            }
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(10));
    } };
    let mut registry_stop = shared.shutdown.subscribe();
    let result = tokio::select! {
        result = connections => result,
        result = shutdown_signal() => result,
        _ = registry_stop.changed() => Err(anyhow::anyhow!("legacy_registry_poisoned")),
    };
    flusher.abort();
    shared.workspace_rpc.disconnect();
    // A device-only node owns no pipe manager; its shutdown is a no-op rather
    // than a skipped cleanup step.
    let pipes_shutdown = async {
        if let Some(pipes) = shared.pipes.as_ref() {
            pipes.shutdown().await;
        }
    };
    let (legacy_cleanup, ()) =
        tokio::join!(shutdown_legacy(&shared), pipes_shutdown);
    legacy_cleanup?;
    result
}

fn fatal(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}");
    text.contains("token_revoked")
        || text.contains("token_rejected")
        || text.contains("administrator_rejected")
}

async fn connect_once(
    server: &str,
    node_id: &str,
    token: &str,
    shared: &Arc<Shared>,
) -> Result<Stop> {
    let (control, output, mut stream) = connect(server).await?;
    // No replay output is attached before the authenticated Welcome.
    let (client_control, control_messages) = mpsc::channel(CONTROL_QUEUE);
    let (client_output, output_messages) = mpsc::channel(OUTPUT_QUEUE);
    let bridges = vec![
        tokio::spawn(bridge_clients(
            control_messages,
            control.clone(),
            output.clone(),
        )),
        tokio::spawn(bridge_clients(
            output_messages,
            control.clone(),
            output.clone(),
        )),
    ];
    let _guard = ConnectionGuard { shared, bridges };

    let runs = hello_runs(shared);
    let (run_bundle_versions, process_pipe_versions, workspace_rpc_versions) =
        hands_advertisement(shared.pipes.as_deref());
    send_control(
        &control,
        &ClientMessage::Hello {
            node_id: node_id.to_owned(),
            token: token.to_owned(),
            os: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            clis: shared.clis.clone(),
            runs,
            hostname: crate::machine_hostname(),
            run_bundle_versions,
            process_pipe_versions,
            workspace_rpc_versions,
            // Empty unless this node's own metadata probe succeeded. A headless
            // node therefore advertises nothing instead of a fake screen.
            computer_versions: shared.computer.advertised_versions(),
        },
    )
    .await?;
    match next_server(&mut stream).await? {
        ServerMessage::Welcome { .. } => {}
        ServerMessage::Error { code } if token_is_dead(&code) => return Ok(Stop::Revoked),
        ServerMessage::Error { code } => bail!("node hello rejected ({code})"),
        _ => bail!("node hello was not welcomed"),
    }

    *shared.control.lock().expect("node control lock") = Some(control.clone());
    *shared.output.lock().expect("node output lock") = Some(output);
    *shared.client_output.lock().expect("node client output") = Some(client_output.clone());
    match shared.pipes.as_ref() {
        Some(pipes) => pipes.attach(client_control, client_output).await,
        // A device-only node has no pipe consumer, so the pipe control lane is
        // closed instead of being left half-attached.
        None => drop(client_control),
    }
    shared.wake.notify_one();

    let heartbeat_control = control.clone();
    let heartbeat_runs = Arc::clone(shared);
    let heartbeat = tokio::spawn(async move {
        let mut tick = tokio::time::interval(HEARTBEAT);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let run_ids = live_ids(&heartbeat_runs);
            if heartbeat_control
                .try_send(Wire::Text(ClientMessage::Heartbeat { run_ids }.to_json()))
                .is_err()
            {
                break;
            }
        }
    });

    let stop = read_loop(&control, &mut stream, shared).await;
    heartbeat.abort();
    stop
}

async fn bridge_clients(
    mut messages: mpsc::Receiver<ClientMessage>,
    control: mpsc::Sender<Wire>,
    output: mpsc::Sender<Wire>,
) {
    while let Some(message) = messages.recv().await {
        let urgent = matches!(
            message,
            ClientMessage::ProcessPipeControl { .. }
                | ClientMessage::WorkspaceRpcRejected { .. }
                | ClientMessage::BuiltinCall { .. }
        );
        let target = if urgent { &control } else { &output };
        if target.send(Wire::Text(message.to_json())).await.is_err() {
            break;
        }
    }
}

struct ConnectionGuard<'a> {
    shared: &'a Shared,
    bridges: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for ConnectionGuard<'_> {
    fn drop(&mut self) {
        for bridge in &self.bridges {
            bridge.abort();
        }
        if let Some(pipes) = self.shared.pipes.as_ref() {
            pipes.disconnect();
        }
        // A new socket owns a new computer epoch: any in-flight capture or input
        // reply is dropped instead of being delivered on the replacement.
        self.shared.computer.disconnect();
        self.shared.workspace_rpc.disconnect();
        *self
            .shared
            .client_output
            .lock()
            .expect("node client output") = None;
        *self.shared.control.lock().expect("node control lock") = None;
        *self.shared.output.lock().expect("node output lock") = None;
        {
            let mut runs = lock_runs(self.shared);
            for run in runs.values_mut() { run.queued = run.acked; }
        }
        self.shared.wake.notify_waiters();
    }
}

fn hello_runs(shared: &Shared) -> Vec<RunReport> {
    let runs = lock_runs(&shared);
    runs.iter()
        .map(|(run_id, run)| RunReport {
            run_id: run_id.clone(),
            attempt: run.attempt,
            process_alive: run.alive,
            sent_seq: run.next_seq,
        })
        .collect()
}

fn live_ids(shared: &Shared) -> Vec<String> {
    let runs = lock_runs(&shared);
    runs.iter()
        .filter(|(_, run)| run.alive)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Bundle and pipe transport belong to R1. A node that owns no pipe manager
/// advertises neither, so the server refuses those frames before they arrive.
/// `Some` keeps the exact advertisement the node sent before this split.
fn hands_advertisement(
    pipes: Option<&crate::process_wire::NodePipes>,
) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let Some(pipes) = pipes else {
        return (
            Vec::new(),
            Vec::new(),
            vec![loom_protocol::workspace_rpc::RPC_VERSION],
        );
    };
    (
        vec![
            loom_protocol::run_bundle::RUN_BUNDLE_VERSION,
            loom_protocol::run_bundle::RUN_BUNDLE_REFERENCE_VERSION,
        ],
        if pipes.supported() {
            vec![
                loom_protocol::process_pipe::PROCESS_PIPE_VERSION,
                loom_protocol::command_hooks::CODEX_HOOK_PIPE_VERSION,
            ]
        } else {
            Vec::new()
        },
        vec![loom_protocol::workspace_rpc::RPC_VERSION],
    )
}

async fn connect(
    server: &str,
) -> Result<(
    mpsc::Sender<Wire>,
    mpsc::Sender<Wire>,
    futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
)> {
    let (socket, _) = tokio_tungstenite::connect_async(server)
        .await
        .with_context(|| format!("could not dial {server}"))?;
    let (mut sink, stream) = socket.split();
    let (control_tx, mut control_rx) = mpsc::channel(CONTROL_QUEUE);
    let (output_tx, mut output_rx) = mpsc::channel(OUTPUT_QUEUE);
    tokio::spawn(async move {
        loop {
            let item = tokio::select! {
                biased;
                item = control_rx.recv() => item,
                item = output_rx.recv() => item,
            };
            let Some(item) = item else { break };
            let message = match item {
                Wire::Text(text) => tokio_tungstenite::tungstenite::Message::Text(text.into()),
                Wire::Pong(data) => tokio_tungstenite::tungstenite::Message::Pong(data.into()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });
    Ok((control_tx, output_tx, stream))
}

async fn send_control(tx: &mpsc::Sender<Wire>, message: &ClientMessage) -> Result<()> {
    tx.send(Wire::Text(message.to_json()))
        .await
        .map_err(|_| anyhow::anyhow!("node socket closed"))?;
    Ok(())
}

fn try_control(shared: &Shared, message: &ClientMessage) {
    let control = shared.control.lock().expect("node control lock");
    if let Some(tx) = control.as_ref() {
        let _ = tx.try_send(Wire::Text(message.to_json()));
    }
}

/// A node without a process manager still answers the controller instead of
/// leaving the request unanswered. No native process API is reachable here.
fn refuse_pipe(shared: &Shared, command: &loom_protocol::process_pipe::ProcessPipeCommand) {
    try_control(
        shared,
        &ClientMessage::ProcessPipeControl {
            control: crate::process_wire::refusal_for(command, "device_only"),
        },
    );
}

async fn next_server(
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
) -> Result<ServerMessage> {
    let frame = tokio::time::timeout(Duration::from_secs(10), next_text(stream))
        .await
        .context("timed out waiting for the server")??;
    serde_json::from_str(&frame).context("server frame was not JSON")
}

async fn next_text(
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
) -> Result<String> {
    loop {
        let frame = stream
            .next()
            .await
            .context("node socket closed")?
            .context("node socket failed")?;
        match frame {
            tokio_tungstenite::tungstenite::Message::Text(text) => {
                return Ok(text.as_str().to_owned());
            }
            tokio_tungstenite::tungstenite::Message::Ping(_)
            | tokio_tungstenite::tungstenite::Message::Pong(_) => {}
            tokio_tungstenite::tungstenite::Message::Close(_) => {
                bail!("server closed the node socket");
            }
            _ => {}
        }
    }
}

async fn read_loop(
    control: &mpsc::Sender<Wire>,
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    shared: &Arc<Shared>,
) -> Result<Stop> {
    while let Some(frame) = stream.next().await {
        let frame = frame.context("node socket failed")?;
        match frame {
            tokio_tungstenite::tungstenite::Message::Text(text) => {
                let message: ServerMessage =
                    serde_json::from_str(text.as_str()).context("server frame was not JSON")?;
                match message {
                    ServerMessage::ProcessPipe { command } => match shared.pipes.as_ref() {
                        Some(pipes) => pipes.handle(command).await,
                        // No pipe transport was advertised, so this command has
                        // no local owner. Echo a bounded refusal; never spawn.
                        None => refuse_pipe(shared, &command),
                    },
                    ServerMessage::BuiltinReply { reply } => {
                        if let Some(pipes) = shared.pipes.as_ref() {
                            match pipes.complete_builtin(reply) {
                                Ok(()) => {}
                                // No builtin helper was advertised on this
                                // connection, so there is no pending call to
                                // complete. Dropping the authenticated socket
                                // would be a self-inflicted reconnect, not a
                                // safety property.
                                Err("builtin_helper_missing") => {}
                                Err(code) => return Err(anyhow::anyhow!(code)),
                            }
                        }
                    }
                    ServerMessage::WorkspaceRpcDispatch { dispatch } => {
                        let output = shared
                            .client_output
                            .lock()
                            .expect("node client output")
                            .clone();
                        if let Some(output) = output {
                            shared.workspace_rpc.handle_dispatch(dispatch, output).await;
                        }
                    }
                    ServerMessage::WorkspaceRpcCancel { cancel } => {
                        let output = shared
                            .client_output
                            .lock()
                            .expect("node client output")
                            .clone();
                        if let Some(output) = output {
                            shared.workspace_rpc.handle_cancel(cancel, output).await;
                        }
                    }
                    ServerMessage::WorkspaceRpcReplay { replay } => {
                        let output = shared
                            .client_output
                            .lock()
                            .expect("node client output")
                            .clone();
                        if let Some(output) = output {
                            shared.workspace_rpc.handle_replay(replay, output).await;
                        }
                    }
                    ServerMessage::Computer { request } => {
                        // The host bounds its own work and drops a reply whose
                        // connection epoch has already been replaced.
                        let output = shared
                            .client_output
                            .lock()
                            .expect("node client output")
                            .clone();
                        if let Some(output) = output {
                            shared.computer.handle(request, output);
                        }
                    }
                    ServerMessage::Start {
                        run_id,
                        attempt,
                        adapter_kind,
                        program,
                        args,
                        cwd,
                        env,
                        shim_token,
                        bundle,
                    } => {
                        accept_start(
                            shared,
                            run_id,
                            attempt,
                            adapter_kind,
                            program,
                            args,
                            cwd,
                            env,
                            shim_token,
                            bundle,
                        )
                        .await?;
                    }
                    ServerMessage::Resume {
                        run_id,
                        attempt,
                        acked_seq,
                    } => on_resume(shared, &run_id, attempt, acked_seq),
                    ServerMessage::Ack { run_id, seq } => on_ack(shared, &run_id, seq),
                    ServerMessage::ListDir {
                        request_id,
                        root,
                        relative,
                    } => {
                        let identity = request_id.clone();
                        schedule_fs(shared, &identity, move || {
                            workspace_list(&request_id, &root, &relative)
                        });
                    }
                    ServerMessage::ReadFile {
                        request_id,
                        root,
                        relative,
                    } => {
                        let identity = request_id.clone();
                        schedule_fs(shared, &identity, move || {
                            workspace_read(&request_id, &root, &relative)
                        });
                    }
                    ServerMessage::PrepareWorktree {
                        request_id,
                        source,
                        branch,
                        worktree,
                    } => {
                        let identity = request_id.clone();
                        let owner = Arc::clone(shared);
                        schedule_fs(shared, &identity, move || {
                            workspace_prepare(
                                &owner.data_dir,
                                &owner.authority,
                                &request_id,
                                &source,
                                &worktree,
                                &branch,
                            )
                        });
                    }
                    ServerMessage::Error { code } if token_is_dead(&code) => {
                        return Ok(Stop::Revoked);
                    }
                    ServerMessage::Error { code } => bail!("server rejected the node ({code})"),
                    ServerMessage::HeartbeatAck
                    | ServerMessage::Welcome { .. }
                    | ServerMessage::Paired { .. } => {}
                }
            }
            tokio_tungstenite::tungstenite::Message::Ping(data) => {
                let _ = control.try_send(Wire::Pong(data.to_vec()));
            }
            tokio_tungstenite::tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(Stop::Closed)
}

fn reply_fs(shared: &Arc<Shared>, message: ClientMessage) {
    try_control(shared, &message);
}

fn schedule_fs<F>(shared: &Arc<Shared>, request_id: &str, operation: F)
where
    F: FnOnce() -> ClientMessage + Send + 'static,
{
    let Ok(permit) = shared.fs_jobs.clone().try_acquire_owned() else {
        reply_fs(shared, fs_err(request_id, "node_fs_busy"));
        return;
    };
    let shared = Arc::clone(shared);
    let request_id = request_id.to_owned();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            operation()
        })
        .await
        .unwrap_or_else(|_| fs_err(&request_id, "node_fs_unavailable"));
        let control = shared.control.lock().expect("node control lock").clone();
        if let Some(control) = control {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                control.send(Wire::Text(result.to_json())),
            )
            .await;
        }
    });
}

fn workspace_list(request_id: &str, root: &str, relative: &str) -> ClientMessage {
    match loom_protocol::list_directory(std::path::Path::new(root), relative) {
        Ok((entries, truncated)) => fs_ok(request_id, entries, String::new(), truncated),
        Err(code) => fs_err(request_id, code),
    }
}

fn workspace_read(request_id: &str, root: &str, relative: &str) -> ClientMessage {
    match loom_protocol::read_file(std::path::Path::new(root), relative) {
        Ok((bytes, truncated)) => fs_ok(request_id, Vec::new(), STANDARD.encode(bytes), truncated),
        Err(code) => fs_err(request_id, code),
    }
}

fn workspace_prepare(
    data_dir: &std::path::Path,
    authority: &crate::workspace_authority::WorkspaceAuthority,
    request_id: &str,
    source: &str,
    expected_worktree: &str,
    branch: &str,
) -> ClientMessage {
    let worktree = data_dir.join("worktrees").join(branch.replace('/', "_"));
    if !expected_worktree.is_empty() {
        let expected = std::path::Path::new(expected_worktree).canonicalize();
        let current = worktree.canonicalize();
        if !matches!((expected,current),(Ok(expected),Ok(current)) if expected==current) {
            return fs_err(request_id, "workspace_binding_changed");
        }
    }
    match loom_protocol::prepare_git_worktree(std::path::Path::new(source), &worktree, branch) {
        Ok(prepared) => {
            if authority.record_prepared(request_id, &prepared).is_err() {
                return fs_err(request_id, "workspace_authority_refused");
            }
            ClientMessage::FsResult {
                request_id: request_id.to_owned(),
                code: String::new(),
                entries: Vec::new(),
                data: String::new(),
                truncated: false,
                worktree: prepared.worktree,
                source: prepared.source,
                common_dir: prepared.common_dir,
                base_sha: prepared.base_sha,
                branch: prepared.branch,
            }
        }
        Err(code) => fs_err(request_id, code),
    }
}

fn fs_ok(
    request_id: &str,
    entries: Vec<loom_protocol::FsEntry>,
    data: String,
    truncated: bool,
) -> ClientMessage {
    ClientMessage::FsResult {
        request_id: request_id.to_owned(),
        code: String::new(),
        entries,
        data,
        truncated,
        worktree: String::new(),
        source: String::new(),
        common_dir: String::new(),
        base_sha: String::new(),
        branch: String::new(),
    }
}

fn fs_err(request_id: &str, code: &str) -> ClientMessage {
    ClientMessage::FsResult {
        request_id: request_id.to_owned(),
        code: code.to_owned(),
        entries: Vec::new(),
        data: String::new(),
        truncated: false,
        worktree: String::new(),
        source: String::new(),
        common_dir: String::new(),
        base_sha: String::new(),
        branch: String::new(),
    }
}

fn token_is_dead(code: &str) -> bool {
    matches!(
        code,
        "token_revoked" | "token_rejected" | "administrator_rejected"
    )
}

enum StartChoice {
    Prepare,
    Already(u64),
    Reject(&'static str),
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = term.recv() => {},
        }
    }
    // Console CTRL_BREAK must take this same path as CTRL_C; unhandled it kills the
    // node with 0xC000013A before the owned process tree is reaped.
    #[cfg(windows)]
    {
        let mut brk = tokio::signal::windows::ctrl_break()?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = brk.recv() => {},
        }
    }
    #[cfg(not(any(unix, windows)))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

async fn shutdown_legacy(shared: &Shared) -> Result<()> {
    {
        // Same admission lock as the actual spawn call: once this fence is
        // published, no prepared owner may create a new process.
        let _runs = lock_runs(&shared);
        shared.shutdown.send_replace(true);
    }
    shared.wake.notify_waiters();
    let mut owners = std::mem::take(&mut *shared.owners.lock().expect("legacy owners"));
    let joined = tokio::time::timeout(Duration::from_secs(8), async {
        let mut unknown = false;
        while let Some(result) = owners.join_next().await {
            if !matches!(result, Ok(Ok(()))) { unknown = true; }
        }
        // Completed owners may already have been reaped before shutdown.
        // Their live unknown entries still retain the missing cleanup proof.
        if lock_runs(&shared).values()
            .any(|run| !run.tree_stopped) { unknown = true; }
        if unknown { bail!("legacy_cleanup_unknown"); }
        Ok::<_, anyhow::Error>(())
    }).await;
    match joined {
        Ok(result) => result,
        Err(_) => {
            // Dropping each owner still invokes the native boundary's owned kill.
            // This is NOT a positive cleanup receipt or permission to retry.
            owners.abort_all();
            while owners.join_next().await.is_some() {}
            bail!("legacy_cleanup_unknown")
        }
    }
}

fn reject_start(shared: &Shared, key: &LaunchKey, code: &str) {
    try_control(shared, &ClientMessage::Rejected {
        run_id: key.run_id.clone(), attempt: key.attempt, code: code.into(),
    });
}

fn mark_no_process(shared: &Shared, key: &LaunchKey, _reason: &str) {
    // Generic validation errors from old peers are not proof of no spawn.
    // Only this receipt, after durable NoProcess, authorizes an A-side retry.
    let result = {
        let mut runs = lock_runs(&shared);
        match runs.get_mut(&key.run_id) {
            Some(run) if run.key == *key && run.phase == Phase::Prepared => {
                run.tree_stopped = true; // no process-creation API was called
                let result = shared.journal.transition(key, Phase::NoProcess);
                if result.is_ok() { runs.remove(&key.run_id); }
                result
            }
            _ => Err("legacy_start_conflict"),
        }
    };
    if let Err(failure) = result {
        mark_unknown(shared, key);
        reject_start(shared, key, failure);
    } else {
        reject_start(shared, key, "legacy_no_process");
    }
}

fn mark_unknown(shared: &Shared, key: &LaunchKey) {
    mark_owner_unknown(&shared.journal, &shared.runs, key, &shared.shutdown, &shared.wake);
}

fn lock_registry<'a>(
    journal: &Journal, registry: &'a Mutex<HashMap<String, LiveRun>>,
    shutdown: &watch::Sender<bool>, wake: &Notify,
) -> std::sync::MutexGuard<'a, HashMap<String, LiveRun>> {
    match registry.lock() {
        Ok(runs) => runs,
        Err(poisoned) => {
            let mut runs = poisoned.into_inner();
            // An interrupted registry mutation is not a valid process-state
            // observation. Fence every retained owner before allowing control
            // and cleanup code to use the mutex again. Never invent tree proof.
            for run in runs.values_mut() {
                let _ = journal.transition(&run.key, Phase::Unknown);
                run.phase = Phase::Unknown;
                run.closed = true;
            }
            registry.clear_poison();
            shutdown.send_replace(true);
            wake.notify_waiters();
            runs
        }
    }
}

fn lock_runs(shared: &Shared) -> std::sync::MutexGuard<'_, HashMap<String, LiveRun>> {
    lock_registry(&shared.journal, &shared.runs, &shared.shutdown, &shared.wake)
}

fn mark_owner_unknown(
    journal: &Journal, runs: &Mutex<HashMap<String, LiveRun>>,
    key: &LaunchKey, shutdown: &watch::Sender<bool>, wake: &Notify,
) {
    let mut runs = lock_registry(journal, runs, shutdown, wake);
    if let Some(run) = runs.get_mut(&key.run_id) && run.key == *key {
        let _ = journal.transition(key, Phase::Unknown);
        run.phase = Phase::Unknown;
        run.closed = true;
    }
    wake.notify_waiters();
}

struct LegacyOwnerGuard<'a> {
    journal: &'a Journal,
    runs: &'a Mutex<HashMap<String, LiveRun>>,
    key: &'a LaunchKey,
    wake: &'a Notify,
    shutdown: &'a watch::Sender<bool>,
    armed: bool,
}
impl Drop for LegacyOwnerGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            mark_owner_unknown(self.journal, self.runs, self.key, self.shutdown, self.wake);
        }
    }
}

fn mark_phase(shared: &Shared, key: &LaunchKey, phase: Phase, alive: bool) -> Result<()> {
    let mut runs = lock_runs(&shared);
    let run = runs.get_mut(&key.run_id).filter(|run| run.key == *key)
        .context("legacy owner changed")?;
    shared.journal.transition(key, phase).map_err(|code| anyhow::anyhow!(code))?;
    run.phase = phase;
    run.alive = alive;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn accept_start(
    shared: &Arc<Shared>, run_id: String, attempt: u32,
    adapter_kind: String, program: String, args: Vec<String>, cwd: String,
    env: Vec<(String, String)>, shim_token: String,
    bundle: Option<loom_protocol::run_bundle::RunBundleV1>,
) -> Result<()> {
    let key = match LaunchKey::new(&run_id, attempt, &adapter_kind, &program,
        &args, &cwd, &env, &shim_token, bundle.as_ref()) {
        Ok(key) => key,
        Err(code) => {
            try_control(shared, &ClientMessage::Rejected {
                run_id, attempt, code: code.into(),
            });
            return Ok(());
        }
    };
    if shared.pipes.is_none() {
        // This node admits no Agent CLI, so no program could ever match. Refuse
        // before the durable R1 journal or any bundle materialization, and
        // therefore before any possible spawn. The code is a real A-side
        // rejection; it is deliberately not `legacy_no_process`, which asserts a
        // durable no-spawn transition this node never wrote.
        try_control(shared, &ClientMessage::Rejected {
            run_id, attempt, code: "program_not_allowed".into(),
        });
        return Ok(());
    }
    let choice = {
        let mut runs = lock_runs(&shared);
        if let Some(existing) = runs.get(&run_id) {
            if existing.key != key {
                StartChoice::Reject("legacy_start_conflict")
            } else if existing.phase == Phase::Running && existing.alive {
                StartChoice::Already(existing.next_seq)
            } else if existing.phase == Phase::Prepared {
                StartChoice::Reject("legacy_start_pending")
            } else if existing.phase == Phase::Finished {
                StartChoice::Reject("process_gone")
            } else {
                StartChoice::Reject("legacy_outcome_unknown")
            }
        } else if runs.len() >= 32 {
            StartChoice::Reject("legacy_capacity")
        } else {
            match shared.journal.reserve(&key) {
                Ok(()) => {
                    runs.insert(run_id.clone(), fresh_run(key.clone()));
                    StartChoice::Prepare
                }
                Err(code) => StartChoice::Reject(code),
            }
        }
    };
    match choice {
        StartChoice::Already(seq) => try_control(shared, &ClientMessage::AlreadyRunning {
            run_id, attempt, seq,
        }),
        StartChoice::Reject(code) => reject_start(shared, &key, code),
        StartChoice::Prepare => {
            if let Err(code) = crate::legacy_run::validate_environment(&env) {
                mark_no_process(shared, &key, code);
                return Ok(());
            }
            if let Some(packet) = bundle.as_ref() &&
                let Err(code) = crate::run_bundle::admit(packet, &run_id, attempt, &adapter_kind, &args) {
                mark_no_process(shared, &key, code);
                return Ok(());
            }
            let Some(path) = resolve_executable(&shared.clis, &adapter_kind, &program) else {
                mark_no_process(shared, &key, "program_not_allowed");
                return Ok(());
            };
            let prepared = if let Some(packet) = bundle.as_ref() {
                match crate::run_bundle::materialize(&shared.data_dir, packet, &run_id,
                    attempt, &adapter_kind, &args) {
                    Ok(prepared) => Some(prepared),
                    Err(code) => {
                        mark_no_process(shared, &key, code);
                        return Ok(());
                    }
                }
            } else { None };
            let owner = Arc::clone(shared);
            let mut tasks = shared.owners.lock().expect("legacy owners");
            while tasks.try_join_next().is_some() {}
            tasks.spawn(async move {
                // Before first poll this owner remains Prepared (never replayable).
                // After first poll panic/abort must not leave a false Running claim.
                let mut guard = LegacyOwnerGuard { journal: &owner.journal,
                    runs: &owner.runs, key: &key, wake: &owner.wake,
                    shutdown: &owner.shutdown, armed: true };
                let result = drive_process(owner.clone(), key.clone(), adapter_kind, path,
                    args, cwd, env, shim_token, prepared).await;
                if let Err(error) = &result {
                    // Closed stage, attempt and one-way run label only. The wire
                    // code and the durable Unknown transition are unchanged, so
                    // nothing here can authorize another spawn.
                    eprintln!("{}", legacy_diagnostic(legacy_stage(error),
                        key.attempt, &key.run_id));
                    mark_unknown(&owner, &key);
                    reject_start(&owner, &key, LEGACY_UNKNOWN_WIRE);
                }
                // Output loss is not the same as cleanup failure. Only positive
                // tree confirmation permits this owner to finish as cleaned.
                let cleaned = result.is_ok() || lock_runs(&owner)
                    .get(&key.run_id).is_some_and(|run| run.key == key && run.tree_stopped);
                guard.armed = false;
                if cleaned { Ok(()) } else { Err(anyhow::anyhow!("legacy_cleanup_unknown")) }
            });
        }
    }
    Ok(())
}

fn on_resume(shared: &Shared, run_id: &str, attempt: u32, acked_seq: u64) {
    let mut runs = lock_runs(&shared);
    let Some(run) = runs.get_mut(run_id).filter(|run| run.attempt == attempt) else {
        // A missing owner after Node restart is not proof that its process tree
        // stopped. The durable intent remains a no-replay fence.
        try_control(shared, &ClientMessage::Rejected {
            run_id: run_id.into(), attempt,
            code: shared.journal.resume_rejection(run_id, attempt).into(),
        });
        return;
    };
    if acked_seq > run.next_seq { return; }
    run.acked = run.acked.max(acked_seq);
    while run.pending.front().is_some_and(|frame| frame.seq <= run.acked) {
        run.pending.pop_front();
    }
    run.queued = run.acked;
    if run.phase == Phase::Unknown {
        reject_start(shared, &run.key, "legacy_outcome_unknown");
    }
    drop(runs);
    shared.wake.notify_waiters();
}

fn on_ack(shared: &Shared, run_id: &str, seq: u64) {
    let mut runs = lock_runs(&shared);
    let mut finished = false;
    if let Some(run) = runs.get_mut(run_id) {
        if seq > run.next_seq { return; } // Future ACK cannot release an owner.
        if seq > run.acked {
            run.acked = seq;
            while run.pending.front().is_some_and(|frame| frame.seq <= seq) {
                run.pending.pop_front();
            }
            run.queued = run.queued.max(seq);
        }
        finished = run.phase == Phase::Finished && !run.alive &&
            run.pending.is_empty() && run.acked == run.next_seq &&
            run.terminal_seq == Some(run.next_seq);
    }
    if finished {
        // Only the bounded output buffer is retired. Journal is never removed.
        runs.remove(run_id);
    }
    drop(runs);
    shared.wake.notify_waiters();
}

async fn flush(shared: Arc<Shared>) {
    loop {
        let notified = shared.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable(); // notify_waiters cannot be lost before await.
        let item = {
            let mut runs = lock_runs(&shared);
            runs.iter_mut().find_map(|(run_id, run)| {
                let frame = run.pending.iter().find(|frame| frame.seq > run.queued)?;
                let item = (run_id.clone(), run.attempt, frame.seq, frame.json.clone());
                run.queued = frame.seq;
                Some(item)
            })
        };
        let Some((run_id, attempt, seq, json)) = item else {
            notified.await;
            continue;
        };
        let output = shared.output.lock().expect("node output lock").clone();
        let sent = match output {
            Some(tx) => tx.send(Wire::Text(json)).await.is_ok(),
            None => false,
        };
        if !sent {
            {
                let mut runs = lock_runs(&shared);
                if let Some(run) = runs.get_mut(&run_id) &&
                    run.attempt == attempt && run.queued == seq {
                    run.queued = run.acked;
                }
            }
            notified.await;
        }
    }
}

fn fresh_run(key: LaunchKey) -> LiveRun {
    LiveRun { attempt: key.attempt, key, phase: Phase::Prepared, closed: false, tree_stopped: false,
        next_seq: 0, terminal_seq: None, acked: 0, queued: 0, pending: VecDeque::new(), alive: false }
}

/// Closed, static diagnosis for the legacy owner error path.
///
/// `drive_process` can fail after a process may already exist, so every failure
/// stays `legacy_outcome_unknown` on the wire and `Unknown` in the journal: the
/// stages below never authorize a retry and never claim "no process". Each stage
/// is a fixed string so the nine paths stay distinguishable while no raw error
/// text (command line, path, environment value, account or token) is ever
/// promoted into a log line or a wire code.
const LEGACY_STAGE_OWNER_CHANGED: &str = "owner_changed";
const LEGACY_STAGE_SPAWN: &str = "spawn";
const LEGACY_STAGE_PHASE_RUNNING: &str = "phase_running";
const LEGACY_STAGE_PIPE_MISSING: &str = "pipe_missing";
const LEGACY_STAGE_CLEANUP_IO: &str = "cleanup_io";
const LEGACY_STAGE_TREE_NOT_EMPTY: &str = "tree_not_empty";
const LEGACY_STAGE_OUTPUT_LOST: &str = "output_lost";
const LEGACY_STAGE_PHASE_FINISHED: &str = "phase_finished";
const LEGACY_STAGE_TERMINAL_ENQUEUE: &str = "terminal_enqueue";
const LEGACY_STAGES: &[&str] = &[
    LEGACY_STAGE_OWNER_CHANGED, LEGACY_STAGE_SPAWN, LEGACY_STAGE_PHASE_RUNNING,
    LEGACY_STAGE_PIPE_MISSING, LEGACY_STAGE_CLEANUP_IO, LEGACY_STAGE_TREE_NOT_EMPTY,
    LEGACY_STAGE_OUTPUT_LOST, LEGACY_STAGE_PHASE_FINISHED, LEGACY_STAGE_TERMINAL_ENQUEUE,
];
const LEGACY_STAGE_UNKNOWN: &str = "unknown";
/// The only wire code this path may emit. It must never become `legacy_no_process`.
const LEGACY_UNKNOWN_WIRE: &str = "legacy_outcome_unknown";

/// Carries exactly one static stage. `Debug`/`Display` print that stage and
/// nothing else, because the inner error can name commands, paths, environment
/// values or accounts. It stays reachable only through `source()`.
struct LegacyStaged {
    stage: &'static str,
    source: anyhow::Error,
}

impl std::fmt::Display for LegacyStaged {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.stage)
    }
}

impl std::fmt::Debug for LegacyStaged {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LegacyStaged")
            .field("stage", &self.stage)
            .finish()
    }
}

impl std::error::Error for LegacyStaged {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        let source: &(dyn std::error::Error + 'static) = self.source.as_ref();
        Some(source)
    }
}

fn staged(stage: &'static str, source: anyhow::Error) -> anyhow::Error {
    LegacyStaged { stage, source }.into()
}

/// Exact, closed-set match over the error chain: an unrecognized shape is
/// `unknown`, and no arbitrary text is ever turned into a code.
fn legacy_stage(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        if let Some(found) = cause.downcast_ref::<LegacyStaged>() {
            return LEGACY_STAGES
                .iter()
                .copied()
                .find(|known| *known == found.stage)
                .unwrap_or(LEGACY_STAGE_UNKNOWN);
        }
    }
    LEGACY_STAGE_UNKNOWN
}

fn legacy_run_label(run_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(run_id.as_bytes());
    format!("{:x}", hash.finalize()).chars().take(12).collect()
}

/// Stage, attempt and a one-way run label only. Never child output, never a
/// command line, never the inner error text.
fn legacy_diagnostic(stage: &'static str, attempt: u32, run_id: &str) -> String {
    format!(
        "loom-node: legacy owner unknown stage={} attempt={} run={}",
        stage, attempt, legacy_run_label(run_id),
    )
}

#[allow(clippy::too_many_arguments)]
async fn drive_process(
    shared: Arc<Shared>, key: LaunchKey, adapter_kind: String,
    program: std::path::PathBuf, args: Vec<String>, cwd: String,
    env: Vec<(String, String)>, shim_token: String,
    prepared: Option<crate::run_bundle::PreparedRunBundle>,
) -> Result<()> {
    let mut stop = shared.shutdown.subscribe();
    if *stop.borrow() {
        mark_no_process(&shared, &key, "legacy_stopping");
        return Ok(());
    }
    let shim = match shim::install(&shared.data_dir, &key.run_id, key.attempt,
        &shim_token, &shared.server) {
        Ok(shim) => shim,
        Err(_) => {
            mark_no_process(&shared, &key, "legacy_prepare_failed");
            return Ok(());
        }
    };
    let setup = (|| -> Result<ProcessSpec> {
        let mut environment = crate::process_admission::local_environment_for_adapter(
            &adapter_kind, shim.root()).map_err(|code| anyhow::anyhow!(code))?;
        for (name, value) in env { environment.insert(name.into(), value.into()); }
        environment.retain(|_, value| !contains_secret(&value.to_string_lossy(),
            &[&shared.node_token, &shim_token]));
        let base = environment.get(std::ffi::OsStr::new("PATH")).cloned();
        environment.insert("PATH".into(), child_path(&shim.bin_dir, base)?);
        let native_args = prepared.as_ref().map(|packet| packet.args())
            .unwrap_or(args.as_slice()).iter().map(|arg| std::ffi::OsString::from(arg.as_str())).collect();
        ProcessSpec::new(program, native_args, std::path::PathBuf::from(cwd),
            environment, StdinPolicy::Null)
    })();
    let spec = match setup {
        Ok(spec) => spec,
        Err(_) => {
            mark_no_process(&shared, &key, "legacy_prepare_failed");
            return Ok(());
        }
    };
    // From this call forward errors mean UNKNOWN, never NoProcess: native
    // admission itself can fail after creating a process. Serialize this exact
    // call with the global stop fence, not just a preflight flag check.
    let spawned = {
        let runs = lock_runs(&shared);
        if *shared.shutdown.borrow() {
            None
        } else {
            let owned = runs.get(&key.run_id).is_some_and(|run|
                run.key == key && run.phase == Phase::Prepared && !run.closed);
            if !owned {
                return Err(staged(LEGACY_STAGE_OWNER_CHANGED,
                    anyhow::anyhow!("legacy owner changed")));
            }
            Some(spawn_legacy(&spec))
        }
    };
    let Some(spawned) = spawned else {
        mark_no_process(&shared, &key, "legacy_stopping");
        return Ok(());
    };
    let mut process = spawned.map_err(|error| staged(LEGACY_STAGE_SPAWN, error))?;
    if let Err(error) = mark_phase(&shared, &key, Phase::Running, true) {
        if process.terminate_and_wait(Duration::from_secs(5)).await
            .is_ok_and(|receipt| receipt.tree_empty)
        {
            let mut runs = lock_runs(&shared);
            if let Some(run) = runs.get_mut(&key.run_id).filter(|run| run.key == key) {
                run.alive = false;
                run.tree_stopped = true;
            }
        }
        return Err(staged(LEGACY_STAGE_PHASE_RUNNING, error));
    }
    let stdout = process.take_stdout().ok_or_else(|| staged(LEGACY_STAGE_PIPE_MISSING,
        anyhow::anyhow!("legacy stdout pipe missing")))?;
    let stderr = process.take_stderr().ok_or_else(|| staged(LEGACY_STAGE_PIPE_MISSING,
        anyhow::anyhow!("legacy stderr pipe missing")))?;
    let mut readers = tokio::task::JoinSet::new();
    {
        let owner = shared.clone(); let key = key.clone();
        readers.spawn(async move { pump(stdout, owner, key, OutputStream::Stdout).await });
    }
    {
        let owner = shared.clone(); let key = key.clone();
        readers.spawn(async move { pump(stderr, owner, key, OutputStream::Stderr).await });
    }
    let mut ticker = tokio::time::interval(Duration::from_millis(20));
    let mut stopped = false;
    let mut stream_failed = false;
    loop {
        if *stop.borrow() { stopped = true; break; }
        tokio::select! {
            biased;
            _ = stop.changed() => { stopped = true; break; }
            result = readers.join_next(), if !readers.is_empty() => {
                if !matches!(result, Some(Ok(Ok(())))) { stream_failed = true; break; }
            }
            _ = ticker.tick() => match process.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {},
                Err(_) => { stream_failed = true; break; }
            }
        }
    }
    // Leader exit does not imply descendants stopped or stdio EOF. Terminate
    // the exact owned boundary first; this path is independent of ACK capacity.
    let receipt = process.terminate_and_wait(Duration::from_secs(5)).await
        .map_err(|error| staged(LEGACY_STAGE_CLEANUP_IO, error.into()))?;
    if !receipt.tree_empty {
        return Err(staged(LEGACY_STAGE_TREE_NOT_EMPTY,
            anyhow::anyhow!("legacy_cleanup_unknown")));
    }
    {
        let mut runs = lock_runs(&shared);
        if let Some(run) = runs.get_mut(&key.run_id).filter(|run| run.key == key) {
            run.alive = false;
            run.tree_stopped = true;
        }
    }
    if stopped || stream_failed {
        readers.abort_all();
        while readers.join_next().await.is_some() {}
        return Err(staged(LEGACY_STAGE_OUTPUT_LOST,
            anyhow::anyhow!("legacy_output_unknown")));
    }
    while !readers.is_empty() {
        tokio::select! {
            biased;
            _ = stop.changed() => {
                readers.abort_all();
                while readers.join_next().await.is_some() {}
                return Err(staged(LEGACY_STAGE_OUTPUT_LOST,
                    anyhow::anyhow!("legacy_output_unknown")));
            }
            result = readers.join_next() => {
                match result {
                    Some(Ok(Ok(()))) => {},
                    _ => return Err(staged(LEGACY_STAGE_OUTPUT_LOST,
                        anyhow::anyhow!("legacy_output_unknown"))),
                }
            }
        }
    }
    mark_phase(&shared, &key, Phase::Finished, false)
        .map_err(|error| staged(LEGACY_STAGE_PHASE_FINISHED, error))?;
    enqueue_exit(&shared, &key, exit_code(receipt.exit_status)).await
        .map_err(|error| staged(LEGACY_STAGE_TERMINAL_ENQUEUE, error))?;
    drop(prepared);
    drop(shim);
    Ok(())
}

/// Two closed detail phases inside `spawn_legacy`, which reports the single
/// `LEGACY_STAGE_SPAWN` stage upward. They separate "the child could not be
/// created at all" from "the created child was refused by the process
/// boundary" without widening the nine-stage set or the wire contract.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const LEGACY_SPAWN_CHILD_CREATE: &str = "child_create";
#[cfg(any(target_os = "linux", target_os = "macos"))]
const LEGACY_SPAWN_BOUNDARY_ADOPT: &str = "boundary_adopt";

/// Closed vocabulary. Anything unlisted is `unknown`; no OS text is echoed.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn legacy_io_kind(kind: std::io::ErrorKind) -> &'static str {
    use std::io::ErrorKind as Kind;
    match kind {
        Kind::NotFound => "not_found",
        Kind::PermissionDenied => "permission_denied",
        Kind::AlreadyExists => "already_exists",
        Kind::InvalidInput => "invalid_input",
        Kind::InvalidData => "invalid_data",
        Kind::WouldBlock => "would_block",
        Kind::BrokenPipe => "broken_pipe",
        Kind::Interrupted => "interrupted",
        Kind::TimedOut => "timed_out",
        Kind::Unsupported => "unsupported",
        Kind::OutOfMemory => "out_of_memory",
        Kind::WriteZero => "write_zero",
        Kind::UnexpectedEof => "unexpected_eof",
        Kind::ConnectionAborted => "connection_aborted",
        Kind::ConnectionRefused => "connection_refused",
        Kind::ConnectionReset => "connection_reset",
        _ => "unknown",
    }
}

/// Phase, closed kind label and the raw errno only. Never the error text, the
/// program path, argv or any environment value.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn legacy_spawn_detail(phase: &'static str, error: Option<&std::io::Error>) -> String {
    match error {
        Some(error) => format!(
            "loom-node: legacy spawn detail phase={} io={} os={}",
            phase, legacy_io_kind(error.kind()), error.raw_os_error().unwrap_or(-1),
        ),
        None => format!(
            "loom-node: legacy spawn detail phase={} io=unknown os=-1", phase,
        ),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn spawn_legacy(spec: &ProcessSpec) -> Result<NativeProcess> {
    // Keep the already-reported legacy script's real path/$0 and shebang
    // behavior. No /proc/self/fd script fallback is silently introduced.
    let mut command = Command::new(spec.application());
    command.args(spec.arguments()).current_dir(spec.working_directory())
        .env_clear().envs(spec.environment())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true).process_group(0);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            // Nothing was created, but the attempt is still UNKNOWN upward: the
            // boundary never ran, and the journal must not learn "no spawn".
            eprintln!("{}", legacy_spawn_detail(LEGACY_SPAWN_CHILD_CREATE, Some(&error)));
            return Err(error.into());
        }
    };
    NativeProcess::adopt_legacy_process_group(child).map_err(|error| {
        let io = error.chain().find_map(|cause| cause.downcast_ref::<std::io::Error>());
        eprintln!("{}", legacy_spawn_detail(LEGACY_SPAWN_BOUNDARY_ADOPT, io));
        error
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn spawn_legacy(spec: &ProcessSpec) -> Result<NativeProcess> {
    NativeProcess::spawn(spec)
}

async fn pump<R: AsyncRead + Unpin>(
    mut reader: R, shared: Arc<Shared>, key: LaunchKey, stream: OutputStream,
) -> Result<()> {
    let mut buffer = vec![0; CHUNK];
    loop {
        let count = reader.read(&mut buffer).await.context("could not read child output")?;
        if count == 0 { return Ok(()); }
        enqueue_output(&shared, &key, stream.clone(), &buffer[..count]).await?;
    }
}

async fn enqueue_output(
    shared: &Shared, key: &LaunchKey, stream: OutputStream, data: &[u8],
) -> Result<()> {
    enqueue_frame(shared, key, false, |seq| ClientMessage::Output {
        run_id: key.run_id.clone(), stream, seq, data: STANDARD.encode(data),
    }).await
}

async fn enqueue_exit(shared: &Shared, key: &LaunchKey, code: i32) -> Result<()> {
    enqueue_frame(shared, key, true, |seq| ClientMessage::Exit {
        run_id: key.run_id.clone(), seq, exit_code: code,
    }).await
}

async fn enqueue_frame<F>(
    shared: &Shared, key: &LaunchKey, terminal: bool, make: F,
) -> Result<()>
where F: FnOnce(u64) -> ClientMessage + Send {
    let mut make = Some(make);
    loop {
        let notified = shared.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if *shared.shutdown.borrow() { bail!("legacy_stopping"); }
        {
            let mut runs = lock_runs(&shared);
            let run = runs.get_mut(&key.run_id).filter(|run| run.key == *key && !run.closed)
                .context("legacy owner changed")?;
            // Capacity check and insertion share one lock; stdout and stderr
            // cannot each consume the same last slot.
            if run.pending.len() < UNACKED_WINDOW {
                run.next_seq = run.next_seq.checked_add(1).context("legacy sequence exhausted")?;
                let seq = run.next_seq;
                let frame = make.take().expect("legacy frame built once")(seq);
                if terminal { run.terminal_seq = Some(seq); }
                run.pending.push_back(Pending { seq, json: frame.to_json() });
                drop(runs);
                shared.wake.notify_waiters();
                return Ok(());
            }
        }
        notified.await;
    }
}

fn contains_secret(value: &str, secrets: &[&str]) -> bool {
    secrets.iter().any(|secret| !secret.is_empty() && value.contains(secret))
}

fn child_path(
    shim_bin: &std::path::Path, base: Option<std::ffi::OsString>,
) -> Result<std::ffi::OsString> {
    let visible = crate::run_bundle::native_path(shim_bin)
        .map_err(|code| anyhow::anyhow!(code))?;
    let mut paths = vec![std::path::PathBuf::from(visible)];
    if let Some(base) = base { paths.extend(std::env::split_paths(&base)); }
    std::env::join_paths(paths).context("legacy local PATH is invalid")
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use rovai_process_boundary::NativeProcess;
    use std::{
        fs,
        io::Write,
        os::unix::fs::PermissionsExt,
        process::Stdio,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[tokio::test]
    async fn cancelling_the_child_kills_the_grandchild_process_group() {
        let dir = std::env::temp_dir().join(format!(
            "loom-group-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("cli.sh");
        let grandchild = dir.join("grandchild.pid");
        let mut file = fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh\nsleep 40 &\necho $! > \"$1\"\nwait\n").unwrap();
        file.set_permissions(fs::Permissions::from_mode(0o755))
            .unwrap();
        drop(file);
        let mut command = tokio::process::Command::new(&script);
        command
            .arg(&grandchild)
            .process_group(0)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        let mut process = NativeProcess::adopt_legacy_process_group(child).unwrap();
        let started = Instant::now();
        let pid = loop {
            if let Ok(text) = fs::read_to_string(&grandchild)
                && let Ok(pid) = text.trim().parse::<u32>()
                && pid > 1
            {
                break pid;
            }
            if started.elapsed() > Duration::from_secs(3) {
                drop(process);
                panic!("grandchild pid was not written");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(process_running(pid), "grandchild was not running");
        let receipt = process.terminate_and_wait(Duration::from_secs(2)).await.unwrap();
        assert!(receipt.tree_empty);
        drop(process);
        let started = Instant::now();
        while process_running(pid) && started.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            !process_running(pid),
            "grandchild {pid} was still running after the process group was killed"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn process_running(pid: u32) -> bool {
        let Ok(text) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some((_, rest)) = text.rsplit_once(')') else {
            return false;
        };
        matches!(rest.split_whitespace().next(), Some("R" | "S" | "D"))
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

#[cfg(test)]
mod legacy_owner_guard_tests {
    use super::*;
    #[test]
    fn legacy_owner_unwind_fences_running_without_inventing_tree_cleanup() {
        let root = std::env::temp_dir().join(format!("loom-legacy-guard-{}", uuid::Uuid::new_v4()));
        let journal = Journal::open(&root, "node_guard").unwrap();
        let key = LaunchKey::new("run_guard", 1, "codex-cli", "/fixture/cli",
            &[], "/fixture/work", &[], &"a".repeat(64), None).unwrap();
        journal.reserve(&key).unwrap();
        journal.transition(&key, Phase::Running).unwrap();
        let mut run = fresh_run(key.clone());
        run.phase = Phase::Running; run.alive = true;
        let second = LaunchKey::new("run_other", 1, "codex-cli", "/fixture/cli",
            &[], "/fixture/work", &[], &"b".repeat(64), None).unwrap();
        journal.reserve(&second).unwrap();
        journal.transition(&second, Phase::Running).unwrap();
        let mut other = fresh_run(second.clone());
        other.phase = Phase::Running; other.alive = true;
        let runs = Mutex::new(HashMap::from([(key.run_id.clone(), run),
            (second.run_id.clone(), other)]));
        let wake = Notify::new();
        let (shutdown, mut stop) = watch::channel(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = LegacyOwnerGuard { journal: &journal, runs: &runs,
                key: &key, wake: &wake, shutdown: &shutdown, armed: true };
            let _poisoned = runs.lock().unwrap();
            panic!("synthetic legacy owner failure");
        }));
        assert!(result.is_err());
        assert!(!runs.is_poisoned(), "normal control/cleanup locks must be usable");
        assert!(stop.has_changed().unwrap() && *stop.borrow_and_update());
        let rows = runs.lock().unwrap();
        for key in [&key, &second] {
            let run = &rows[&key.run_id];
            assert_eq!(run.phase, Phase::Unknown);
            assert!(run.closed && run.alive && !run.tree_stopped);
            assert_eq!(journal.resume_rejection(&key.run_id, 1), "legacy_outcome_unknown");
        }
        drop(rows); drop(journal);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Owns the closed diagnosis boundary of the legacy owner error path: the nine
/// static stages stay distinguishable, an unrecognized shape stays `unknown`,
/// and no inner error text (command line, path, account, token) can reach the
/// diagnostic line. It also pins the wire code to `legacy_outcome_unknown`,
/// because a post-spawn failure must never become a no-process receipt.
#[cfg(test)]
mod legacy_stage_tests {
    use super::*;

    const SECRET_TOKEN: &str = "sk-live-0123456789abcdef0123456789abcdef";
    const ACCOUNT_PATH: &str = "/home/alice/.codex/auth.json";
    const ACCOUNT_MAIL: &str = "alice@example.com";

    #[test]
    fn every_drive_process_stage_maps_to_its_own_closed_code() {
        assert_eq!(LEGACY_STAGES.len(), 9, "the drive_process error path has nine stages");
        for stage in LEGACY_STAGES {
            let failure = staged(*stage,
                anyhow::anyhow!("boom {} {}", ACCOUNT_PATH, SECRET_TOKEN));
            assert_eq!(legacy_stage(&failure), *stage, "{stage}");
            let line = legacy_diagnostic(legacy_stage(&failure), 3, "run_stage_table");
            assert!(line.contains(&format!("stage={stage}")), "{line}");
            assert!(line.contains("attempt=3"), "{line}");
            for leak in ["boom", "alice", "auth.json", "sk-live"] {
                assert!(!line.contains(leak), "{leak} leaked: {line}");
            }
        }
    }

    #[test]
    fn credentials_paths_and_raw_text_never_reach_the_diagnostic() {
        let failure = staged(LEGACY_STAGE_SPAWN, anyhow::anyhow!(
            "spawn failed token={} path={} account={}", SECRET_TOKEN, ACCOUNT_PATH,
            ACCOUNT_MAIL));
        assert_eq!(legacy_stage(&failure), LEGACY_STAGE_SPAWN);
        let line = legacy_diagnostic(legacy_stage(&failure), 2, "run_secret_identity");
        for leak in [SECRET_TOKEN, ACCOUNT_PATH, ACCOUNT_MAIL, "sk-live", "auth.json",
            "example.com"] {
            assert!(!line.contains(leak), "diagnostic leaked {leak}: {line}");
        }
        assert_eq!(line, format!("loom-node: legacy owner unknown stage=spawn attempt=2 run={}",
            legacy_run_label("run_secret_identity")));
        assert!(!line.contains("run_secret_identity"), "run id stays one-way: {line}");
    }

    #[test]
    fn an_unshaped_or_nested_error_stays_unknown_and_prints_no_text() {
        let raw = anyhow::anyhow!("exec /usr/local/bin/secret-cli --token {}", SECRET_TOKEN);
        assert_eq!(legacy_stage(&raw), LEGACY_STAGE_UNKNOWN);
        let line = legacy_diagnostic(legacy_stage(&raw), 1, "run_plain");
        assert!(line.contains("stage=unknown"), "{line}");
        for leak in ["secret-cli", "sk-live", "/usr/local/bin"] {
            assert!(!line.contains(leak), "{leak} leaked: {line}");
        }
        // A later outer context must not hide the exact stage.
        let nested = Err::<(), anyhow::Error>(staged(LEGACY_STAGE_OUTPUT_LOST,
            anyhow::anyhow!("lost")))
            .context("legacy owner task")
            .expect_err("staged failure");
        assert_eq!(legacy_stage(&nested), LEGACY_STAGE_OUTPUT_LOST);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn spawn_detail_keeps_a_closed_phase_kind_and_errno_without_text() {
        let denied = std::io::Error::from_raw_os_error(13);
        assert_eq!(legacy_spawn_detail(LEGACY_SPAWN_CHILD_CREATE, Some(&denied)),
            "loom-node: legacy spawn detail phase=child_create io=permission_denied os=13");
        // A boundary error whose chain carries a token and a path keeps only the
        // closed fields: no inner text may reach the diagnostic.
        let boundary = Err::<(), anyhow::Error>(anyhow::anyhow!(
            "adopt failed token={} path={}", SECRET_TOKEN, ACCOUNT_PATH))
            .context(std::io::Error::from_raw_os_error(1))
            .expect_err("boundary failure");
        let io = boundary.chain().find_map(|cause| cause.downcast_ref::<std::io::Error>());
        let line = legacy_spawn_detail(LEGACY_SPAWN_BOUNDARY_ADOPT, io);
        for leak in [SECRET_TOKEN, ACCOUNT_PATH, "sk-live", "adopt failed"] {
            assert!(!line.contains(leak), "{leak} leaked: {line}");
        }
        assert!(line.contains("phase=boundary_adopt"), "{line}");
        assert!(line.contains("io=permission_denied") && line.contains("os=1"), "{line}");
        assert_eq!(legacy_spawn_detail(LEGACY_SPAWN_CHILD_CREATE, None),
            "loom-node: legacy spawn detail phase=child_create io=unknown os=-1");
    }

    #[test]
    fn the_only_wire_code_is_outcome_unknown_and_never_no_process() {
        assert_eq!(LEGACY_UNKNOWN_WIRE, "legacy_outcome_unknown");
        assert_ne!(LEGACY_UNKNOWN_WIRE, "legacy_no_process",
            "a post-spawn failure must not authorize another attempt");
        assert!(!LEGACY_STAGES.iter().any(|stage| *stage == LEGACY_STAGE_UNKNOWN),
            "the closed set and the fallback stay disjoint");
    }
}

/// H1 device-only owner: a pure device daemon must advertise no R1 transport and
/// must answer a misdirected Start or pipe command without spawning anything.
#[cfg(test)]
mod device_only_tests {
    use super::*;
    use std::{net::TcpListener, path::Path, time::Duration};

    const NODE: &str = "node_device_only";
    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn fixture_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("loom-device-only-{}", uuid::Uuid::new_v4()))
    }

    /// The same construction `serve` performs, minus the socket loop. A
    /// device-only node builds no pipe manager, so `pipes` stays `None`.
    fn device_only_shared(root: &Path) -> Arc<Shared> {
        let authority =
            match crate::workspace_authority::WorkspaceAuthority::open(root, NODE.into()) {
                Ok(authority) => authority,
                Err(_) => panic!("workspace authority refused the fixture root"),
            };
        let rpc = match crate::workspace_rpc::WorkspaceRpcExecutor::open(
            NODE.into(),
            root.join("workspace-rpc"),
            Vec::new(),
        ) {
            Ok(rpc) => rpc,
            Err(_) => panic!("workspace rpc owner refused the fixture root"),
        };
        let workspace_rpc =
            crate::workspace_rpc::WorkspaceRpcWire::with_authority(rpc, authority.clone());
        let journal = match Journal::open(root, NODE) {
            Ok(journal) => journal,
            Err(code) => panic!("journal refused the fixture root: {code}"),
        };
        let (shutdown, _) = watch::channel(false);
        Arc::new(Shared {
            data_dir: root.to_path_buf(),
            server: "ws://127.0.0.1:1".to_owned(),
            node_token: TOKEN.to_owned(),
            clis: Vec::new(),
            computer: crate::computer_provider::ComputerHost::open(None, None),
            pipes: None,
            authority,
            workspace_rpc,
            client_output: Mutex::new(None),
            fs_jobs: Arc::new(tokio::sync::Semaphore::new(4)),
            runs: Mutex::new(HashMap::new()),
            journal,
            owners: Mutex::new(tokio::task::JoinSet::new()),
            shutdown,
            control: Mutex::new(None),
            output: Mutex::new(None),
            wake: Notify::new(),
        })
    }

    fn start_frame(run_id: &str, program: &Path) -> String {
        serde_json::json!({
            "type": "start",
            "runId": run_id,
            "attempt": 1,
            "adapterKind": "codex-cli",
            "program": program.to_string_lossy().into_owned(),
            "args": ["exec", "hello"],
            "cwd": program.parent().unwrap_or(Path::new("")).to_string_lossy().into_owned(),
            "env": [],
            "shimToken": "b".repeat(64),
        })
        .to_string()
    }

    fn ack_frame() -> String {
        serde_json::json!({
            "type": "processPipe",
            "command": {
                "operation": "ack",
                "key": {"nodeId": NODE, "processId": "proc_absent", "processEpoch": 1},
                "controllerId": "controller_1",
                "eventSeq": 0,
            },
        })
        .to_string()
    }

    fn builtin_reply_frame() -> String {
        serde_json::json!({
            "type": "builtinReply",
            "reply": {
                "version": 1,
                "key": {"nodeId": NODE, "processId": "proc_absent", "processEpoch": 1},
                "bindingSeq": 0,
                "requestId": "request_absent",
                "requestDigest": "c".repeat(64),
                "response": null,
            },
        })
        .to_string()
    }

    fn read_text(
        socket: &mut tungstenite::WebSocket<std::net::TcpStream>,
    ) -> Result<String, String> {
        loop {
            match socket.read() {
                Ok(tungstenite::Message::Text(text)) => return Ok(text.to_string()),
                Ok(tungstenite::Message::Ping(data)) => {
                    let _ = socket.send(tungstenite::Message::Pong(data));
                }
                Ok(tungstenite::Message::Close(_)) => return Err("socket closed".to_owned()),
                Ok(_) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    /// Bounded so a silent node fails the case instead of hanging the suite.
    fn read_until(
        socket: &mut tungstenite::WebSocket<std::net::TcpStream>,
        needle: &str,
    ) -> Result<String, String> {
        let mut seen = String::new();
        for _ in 0..8 {
            seen.push_str(&read_text(socket)?);
            seen.push('\n');
            if seen.contains(needle) {
                return Ok(seen);
            }
        }
        Err(format!("no {needle} frame arrived: {seen}"))
    }

    fn fake_server(
        listener: TcpListener,
        program: std::path::PathBuf,
    ) -> std::thread::JoinHandle<Result<(), String>> {
        std::thread::spawn(move || {
            use tungstenite::Message;
            let (stream, _) = listener.accept().map_err(|error| error.to_string())?;
            stream
                .set_read_timeout(Some(Duration::from_secs(20)))
                .map_err(|error| error.to_string())?;
            let mut socket = tungstenite::accept(stream).map_err(|error| error.to_string())?;

            let hello = read_text(&mut socket)?;
            let parsed: serde_json::Value =
                serde_json::from_str(&hello).map_err(|error| error.to_string())?;
            if parsed["type"] != "hello" {
                return Err(format!("first frame was {hello}"));
            }
            if !parsed["clis"].as_array().is_some_and(|clis| clis.is_empty()) {
                return Err(format!("device-only hello advertised a CLI: {hello}"));
            }
            for field in ["processPipeVersions", "runBundleVersions"] {
                if parsed.get(field).is_some() {
                    return Err(format!("device-only hello advertised {field}: {hello}"));
                }
            }
            if parsed["workspaceRpcVersions"] != serde_json::json!([1]) {
                return Err(format!("workspace rpc was not advertised: {hello}"));
            }
            socket
                .send(Message::Text(
                    serde_json::json!({"type": "welcome", "nodeId": NODE})
                        .to_string()
                        .into(),
                ))
                .map_err(|error| error.to_string())?;

            // A misdirected legacy Start is refused by name and never spawns.
            socket
                .send(Message::Text(
                    start_frame("run_device_only_1", &program).into(),
                ))
                .map_err(|error| error.to_string())?;
            let refused = read_until(&mut socket, "\"type\":\"rejected\"")?;
            if !refused.contains("\"code\":\"program_not_allowed\"") {
                return Err(format!("start refusal was {refused}"));
            }

            // A misdirected pipe command gets a bounded refusal for its own
            // identity instead of silence or a spawn.
            socket
                .send(Message::Text(ack_frame().into()))
                .map_err(|error| error.to_string())?;
            let pipe = read_until(&mut socket, "\"type\":\"processPipeControl\"")?;
            if !pipe.contains("\"reply\":\"refused\"")
                || !pipe.contains("\"code\":\"device_only\"")
                || !pipe.contains("\"processId\":\"proc_absent\"")
            {
                return Err(format!("pipe refusal was {pipe}"));
            }

            // A reply for a builtin call this node never advertised must not
            // tear the authenticated socket down: the next Start still answers.
            socket
                .send(Message::Text(builtin_reply_frame().into()))
                .map_err(|error| error.to_string())?;
            socket
                .send(Message::Text(
                    start_frame("run_device_only_2", &program).into(),
                ))
                .map_err(|error| error.to_string())?;
            let again = read_until(&mut socket, "\"type\":\"rejected\"")?;
            if !again.contains("\"code\":\"program_not_allowed\"") {
                return Err(format!("second start refusal was {again}"));
            }
            let _ = socket.send(Message::Close(None));
            Ok(())
        })
    }

    #[test]
    fn device_only_advertises_no_runtime_bundle_or_pipe() {
        let (bundle, pipe, rpc) = hands_advertisement(None);
        assert!(bundle.is_empty(), "device-only must not advertise an R1 bundle");
        assert!(pipe.is_empty(), "device-only must not advertise a process pipe");
        assert_eq!(rpc, vec![loom_protocol::workspace_rpc::RPC_VERSION]);
    }

    #[test]
    fn pipe_refusal_echoes_the_requested_identity() {
        use loom_protocol::process_pipe::{
            ProcessControlBody, ProcessPipeCommand, RemoteProcessKey,
        };
        let key = RemoteProcessKey {
            node_id: NODE.into(),
            process_id: "proc_absent".into(),
            process_epoch: 1,
        };
        let commands = [
            ProcessPipeCommand::Ack {
                key: key.clone(),
                controller_id: "controller_1".into(),
                event_seq: 7,
            },
            ProcessPipeCommand::Terminate {
                key: key.clone(),
                request_id: "request_1".into(),
                budget_ms: 1000,
            },
            ProcessPipeCommand::Release {
                key: key.clone(),
                controller_id: "controller_1".into(),
                request_id: "request_2".into(),
                acked_event_seq: 0,
                abandon_output: false,
            },
        ];
        for command in commands {
            let reply = crate::process_wire::refusal_for(&command, "device_only");
            assert_eq!(reply.key, key, "refusal must echo the command identity");
            assert!(reply.validate().is_ok(), "refusal must be a valid control frame");
            match &reply.body {
                ProcessControlBody::Refused { request_id, code } => {
                    assert_eq!(code, "device_only");
                    match &command {
                        ProcessPipeCommand::Ack { .. } => assert!(request_id.is_none()),
                        _ => assert!(request_id.is_some()),
                    }
                }
                _ => panic!("a device-only node may only refuse a pipe command"),
            }
        }
    }

    #[tokio::test]
    async fn misrouted_start_and_pipe_commands_are_refused_without_spawning() {
        let root = fixture_root();
        std::fs::create_dir_all(&root).expect("fixture root");
        // The program would leave this marker behind if any path ever ran it.
        let marker = root.join("spawned");
        let program = root.join(if cfg!(windows) { "codex.cmd" } else { "codex" });
        std::fs::write(&program, format!("would write {}\n", marker.display()))
            .expect("fixture program");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700))
                .expect("fixture permissions");
        }

        let shared = device_only_shared(&root);
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let address = listener.local_addr().expect("listener address");
        let server = fake_server(listener, program);
        let stop = connect_once(
            &format!("ws://{address}/api/v1/nodes/connect"),
            NODE,
            TOKEN,
            &shared,
        )
        .await;
        let outcome = server.join().expect("fake server thread panicked");
        assert!(outcome.is_ok(), "fake server reported {outcome:?}");
        match stop {
            Ok(Stop::Closed) => {}
            Ok(Stop::Revoked) => panic!("a device-only node must not be revoked"),
            Err(error) => panic!("socket loop failed: {error:#}"),
        }
        assert!(!marker.exists(), "a refused Start reached a spawn path");
        let mut durable = Vec::new();
        if let Ok(entries) = std::fs::read_dir(root.join("legacy-runs")) {
            for entry in entries.flatten() {
                durable.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        assert!(
            durable.iter().all(|name| !name.ends_with(".json")),
            "a refused Start wrote a durable R1 record: {durable:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
