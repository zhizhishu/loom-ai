use crate::CliReport;
use crate::discover::resolve_executable;
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
    sync::{Notify, mpsc},
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
    next_seq: u64,
    acked: u64,
    queued: u64,
    pending: VecDeque<Pending>,
    alive: bool,
}

struct Shared {
    clis: Vec<CliReport>,
    runs: Mutex<HashMap<String, LiveRun>>,
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
    server: &str,
    node_id: &str,
    token: &str,
    clis: Vec<CliReport>,
) -> Result<()> {
    let shared = Arc::new(Shared {
        clis,
        runs: Mutex::new(HashMap::new()),
        control: Mutex::new(None),
        output: Mutex::new(None),
        wake: Notify::new(),
    });
    let flusher = tokio::spawn(flush(Arc::clone(&shared)));
    let mut delay = Duration::from_millis(200);
    let result = loop {
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
    };
    flusher.abort();
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
    *shared.control.lock().expect("node control lock") = Some(control.clone());
    *shared.output.lock().expect("node output lock") = Some(output);
    let _guard = ConnectionGuard { shared };
    shared.wake.notify_waiters();

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
        },
    )
    .await?;
    match next_server(&mut stream).await? {
        ServerMessage::Welcome { .. } => {}
        ServerMessage::Error { code } if token_is_dead(&code) => return Ok(Stop::Revoked),
        ServerMessage::Error { code } => bail!("node hello rejected ({code})"),
        _ => bail!("node hello was not welcomed"),
    }

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

struct ConnectionGuard<'a> {
    shared: &'a Shared,
}

impl Drop for ConnectionGuard<'_> {
    fn drop(&mut self) {
        *self.shared.control.lock().expect("node control lock") = None;
        *self.shared.output.lock().expect("node output lock") = None;
        if let Ok(mut runs) = self.shared.runs.lock() {
            for run in runs.values_mut() {
                run.queued = run.acked;
            }
        }
        self.shared.wake.notify_waiters();
    }
}

fn hello_runs(shared: &Shared) -> Vec<RunReport> {
    let runs = shared.runs.lock().expect("node runs lock");
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
    let runs = shared.runs.lock().expect("node runs lock");
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
                    ServerMessage::Start {
                        run_id,
                        attempt,
                        adapter_kind,
                        program,
                        args,
                        cwd,
                        env,
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
                        )
                        .await?;
                    }
                    ServerMessage::Resume {
                        run_id,
                        attempt,
                        acked_seq,
                    } => on_resume(shared, &run_id, attempt, acked_seq),
                    ServerMessage::Ack { run_id, seq } => on_ack(shared, &run_id, seq),
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

fn token_is_dead(code: &str) -> bool {
    matches!(
        code,
        "token_revoked" | "token_rejected" | "administrator_rejected"
    )
}

enum StartChoice {
    Spawn(std::path::PathBuf),
    Already(u64),
    Reject(&'static str),
}

async fn accept_start(
    shared: &Arc<Shared>,
    run_id: String,
    attempt: u32,
    adapter_kind: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
) -> Result<()> {
    let choice = {
        let resolved = resolve_executable(&shared.clis, &adapter_kind, &program);
        let mut runs = shared.runs.lock().expect("node runs lock");
        if let Some(existing) = runs.get(&run_id) {
            if existing.alive {
                StartChoice::Already(existing.next_seq)
            } else if existing.attempt == attempt {
                StartChoice::Reject("process_gone")
            } else if let Some(path) = resolved {
                runs.insert(run_id.clone(), fresh_run(attempt));
                StartChoice::Spawn(path)
            } else {
                StartChoice::Reject("program_not_allowed")
            }
        } else if let Some(path) = resolved {
            runs.insert(run_id.clone(), fresh_run(attempt));
            StartChoice::Spawn(path)
        } else {
            StartChoice::Reject("program_not_allowed")
        }
    };
    match choice {
        StartChoice::Already(seq) => {
            try_control(
                shared,
                &ClientMessage::AlreadyRunning {
                    run_id,
                    attempt,
                    seq,
                },
            );
        }
        StartChoice::Reject(code) => {
            try_control(
                shared,
                &ClientMessage::Rejected {
                    run_id,
                    attempt,
                    code: code.to_owned(),
                },
            );
        }
        StartChoice::Spawn(path) => {
            let shared = Arc::clone(shared);
            tokio::spawn(async move {
                if let Err(error) =
                    drive_process(shared.clone(), run_id.clone(), path, args, cwd, env).await
                {
                    let _ = send_failure(&shared, &run_id, &error).await;
                }
            });
        }
    }
    Ok(())
}

fn fresh_run(attempt: u32) -> LiveRun {
    LiveRun {
        attempt,
        next_seq: 0,
        acked: 0,
        queued: 0,
        pending: VecDeque::new(),
        alive: true,
    }
}

fn on_resume(shared: &Shared, run_id: &str, attempt: u32, acked_seq: u64) {
    let mut runs = shared.runs.lock().expect("node runs lock");
    let Some(run) = runs.get_mut(run_id) else {
        return;
    };
    if run.attempt != attempt {
        return;
    }
    if acked_seq > run.acked {
        run.acked = acked_seq;
        while run
            .pending
            .front()
            .is_some_and(|frame| frame.seq <= acked_seq)
        {
            run.pending.pop_front();
        }
    }
    run.queued = run.acked;
    drop(runs);
    shared.wake.notify_waiters();
}

fn on_ack(shared: &Shared, run_id: &str, seq: u64) {
    let mut runs = shared.runs.lock().expect("node runs lock");
    let Some(run) = runs.get_mut(run_id) else {
        return;
    };
    if seq > run.acked {
        run.acked = seq;
        while run.pending.front().is_some_and(|frame| frame.seq <= seq) {
            run.pending.pop_front();
        }
        if run.queued < run.acked {
            run.queued = run.acked;
        }
    }
    let finished =
        !run.alive && run.pending.is_empty() && run.acked >= run.next_seq && run.next_seq > 0;
    if finished {
        runs.remove(run_id);
    }
    drop(runs);
    shared.wake.notify_waiters();
}

async fn flush(shared: Arc<Shared>) {
    loop {
        let notified = shared.wake.notified();
        let next = {
            let mut runs = shared.runs.lock().expect("node runs lock");
            let mut picked = None;
            for (run_id, run) in runs.iter_mut() {
                if let Some(frame) = run.pending.iter().find(|frame| frame.seq > run.queued) {
                    picked = Some((run_id.clone(), frame.seq, frame.json.clone()));
                    break;
                }
            }
            if let Some((run_id, seq, _)) = &picked
                && let Some(run) = runs.get_mut(run_id)
            {
                run.queued = *seq;
            }
            picked
        };
        let Some((_, _, json)) = next else {
            notified.await;
            continue;
        };
        let sender = shared.output.lock().expect("node output lock").clone();
        let Some(sender) = sender else {
            rewind_queued(&shared);
            notified.await;
            continue;
        };
        if sender.send(Wire::Text(json)).await.is_err() {
            rewind_queued(&shared);
            notified.await;
        }
    }
}

fn rewind_queued(shared: &Shared) {
    if let Ok(mut runs) = shared.runs.lock() {
        for run in runs.values_mut() {
            run.queued = run.acked;
        }
    }
}

async fn drive_process(
    shared: Arc<Shared>,
    run_id: String,
    program: std::path::PathBuf,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
) -> Result<()> {
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in &env {
        command.env(key, value);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("failed to start {}: {error}\n", program.display());
            enqueue(&shared, &run_id, OutputStream::Stderr, message.as_bytes()).await?;
            enqueue_exit(&shared, &run_id, 127).await?;
            mark_dead(&shared, &run_id);
            return Ok(());
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_shared = Arc::clone(&shared);
    let out_id = run_id.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(pipe) = stdout {
            let _ = pump(out_shared, out_id, OutputStream::Stdout, pipe).await;
        }
    });
    let err_shared = Arc::clone(&shared);
    let err_id = run_id.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(pipe) = stderr {
            let _ = pump(err_shared, err_id, OutputStream::Stderr, pipe).await;
        }
    });
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let status = child.wait().await.context("failed to wait for the CLI")?;
    enqueue_exit(&shared, &run_id, exit_code(status)).await?;
    mark_dead(&shared, &run_id);
    Ok(())
}

fn mark_dead(shared: &Shared, run_id: &str) {
    if let Ok(mut runs) = shared.runs.lock()
        && let Some(run) = runs.get_mut(run_id)
    {
        run.alive = false;
    }
    shared.wake.notify_waiters();
}

async fn pump<R>(
    shared: Arc<Shared>,
    run_id: String,
    stream: OutputStream,
    mut pipe: R,
) -> Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = pipe.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        enqueue(&shared, &run_id, stream, &buf[..n]).await?;
    }
    Ok(())
}

async fn enqueue(shared: &Shared, run_id: &str, stream: OutputStream, bytes: &[u8]) -> Result<()> {
    wait_for_room(shared, run_id).await;
    {
        let mut runs = shared.runs.lock().expect("node runs lock");
        let Some(run) = runs.get_mut(run_id) else {
            return Ok(());
        };
        run.next_seq += 1;
        let seq = run.next_seq;
        let json = ClientMessage::Output {
            run_id: run_id.to_owned(),
            stream,
            seq,
            data: STANDARD.encode(bytes),
        }
        .to_json();
        run.pending.push_back(Pending { seq, json });
    }
    shared.wake.notify_waiters();
    Ok(())
}

async fn enqueue_exit(shared: &Shared, run_id: &str, exit_code: i32) -> Result<()> {
    wait_for_room(shared, run_id).await;
    {
        let mut runs = shared.runs.lock().expect("node runs lock");
        let Some(run) = runs.get_mut(run_id) else {
            return Ok(());
        };
        run.next_seq += 1;
        let seq = run.next_seq;
        let json = ClientMessage::Exit {
            run_id: run_id.to_owned(),
            seq,
            exit_code,
        }
        .to_json();
        run.pending.push_back(Pending { seq, json });
    }
    shared.wake.notify_waiters();
    Ok(())
}

async fn wait_for_room(shared: &Shared, run_id: &str) {
    loop {
        let notified = shared.wake.notified();
        let full = shared
            .runs
            .lock()
            .expect("node runs lock")
            .get(run_id)
            .is_some_and(|run| run.pending.len() >= UNACKED_WINDOW);
        if !full {
            return;
        }
        notified.await;
    }
}

async fn send_failure(shared: &Shared, run_id: &str, error: &anyhow::Error) -> Result<()> {
    let message = format!("{error:#}\n");
    enqueue(shared, run_id, OutputStream::Stderr, message.as_bytes()).await?;
    enqueue_exit(shared, run_id, 1).await?;
    mark_dead(shared, run_id);
    Ok(())
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
