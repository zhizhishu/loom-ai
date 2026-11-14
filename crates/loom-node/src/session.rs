use crate::discover::resolve_executable;
use crate::{CliReport, shim};
use crate::legacy_run::{Journal, LaunchKey, Phase};
use rovai_process_boundary::{NativeProcess, ProcessSpec, StdinPolicy};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use loom_protocol::{ClientMessage, OutputStream, RunReport, ServerMessage};
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

struct Shared {
    data_dir: std::path::PathBuf,
    server: String,
    node_token: String,
    clis: Vec<CliReport>,
    /// The physical desktop this node owns, if the operator opted in.
    computer: Arc<crate::computer_provider::ComputerHost>,
    pipes: Arc<crate::process_wire::NodePipes>,
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
    clis: Vec<CliReport>,
    catalog: crate::installation_catalog::InstallationCatalog,
    computer: Arc<crate::computer_provider::ComputerHost>,
    builtin: Option<crate::builtin_bridge::BuiltinBridge>,
) -> Result<()> {
    let authority =
        crate::workspace_authority::WorkspaceAuthority::open(data_dir, node_id.to_owned())
            .map_err(|code| anyhow::anyhow!(code.code()))?;
    let pipes = crate::process_wire::NodePipes::new(
        data_dir.to_path_buf(),
        node_id,
        catalog,
        authority.clone(),
        builtin,
    )
    .map_err(|code| anyhow::anyhow!(code))?;
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
    let (legacy_cleanup, ()) = tokio::join!(shutdown_legacy(&shared), shared.pipes.shutdown());
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
            run_bundle_versions: vec![
                loom_protocol::run_bundle::RUN_BUNDLE_VERSION,
                loom_protocol::run_bundle::RUN_BUNDLE_REFERENCE_VERSION,
            ],
            process_pipe_versions: if shared.pipes.supported() {
                vec![
                    loom_protocol::process_pipe::PROCESS_PIPE_VERSION,
                    loom_protocol::command_hooks::CODEX_HOOK_PIPE_VERSION,
                ]
            } else {
                Vec::new()
            },
            workspace_rpc_versions: vec![loom_protocol::workspace_rpc::RPC_VERSION],
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
    shared.pipes.attach(client_control, client_output).await;
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
        self.shared.pipes.disconnect();
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
                    ServerMessage::ProcessPipe { command } => shared.pipes.handle(command).await,
                    ServerMessage::BuiltinReply { reply } => {
                        shared
                            .pipes
                            .complete_builtin(reply)
                            .map_err(|code| anyhow::anyhow!(code))?;
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
                if result.is_err() {
                    mark_unknown(&owner, &key);
                    reject_start(&owner, &key, "legacy_outcome_unknown");
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
            if !owned { bail!("legacy owner changed"); }
            Some(spawn_legacy(&spec))
        }
    };
    let Some(spawned) = spawned else {
        mark_no_process(&shared, &key, "legacy_stopping");
        return Ok(());
    };
    let mut process = spawned?;
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
        return Err(error);
    }
    let stdout = process.take_stdout().context("legacy stdout pipe missing")?;
    let stderr = process.take_stderr().context("legacy stderr pipe missing")?;
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
    let receipt = process.terminate_and_wait(Duration::from_secs(5)).await?;
    if !receipt.tree_empty { bail!("legacy_cleanup_unknown"); }
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
        bail!("legacy_output_unknown");
    }
    while !readers.is_empty() {
        tokio::select! {
            biased;
            _ = stop.changed() => {
                readers.abort_all();
                while readers.join_next().await.is_some() {}
                bail!("legacy_output_unknown");
            }
            result = readers.join_next() => {
                match result {
                    Some(Ok(Ok(()))) => {},
                    _ => bail!("legacy_output_unknown"),
                }
            }
        }
    }
    mark_phase(&shared, &key, Phase::Finished, false)?;
    enqueue_exit(&shared, &key, exit_code(receipt.exit_status)).await?;
    drop(prepared);
    drop(shim);
    Ok(())
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
    NativeProcess::adopt_legacy_process_group(command.spawn()?)
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
