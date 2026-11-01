use crate::CliReport;
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use loom_protocol::{ClientMessage, OutputStream, ServerMessage};
use std::{collections::HashMap, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Mutex, mpsc},
};

const HEARTBEAT: Duration = Duration::from_secs(10);
const CHUNK: usize = 16 * 1024;

pub(crate) struct Issued {
    pub(crate) node_id: String,
    pub(crate) token: String,
}

enum Wire {
    Text(String),
    Pong(Vec<u8>),
}

struct LiveRun {
    attempt: u32,
    /// Last sequence number sent for this run. The next frame uses last + 1.
    seq: Arc<Mutex<u64>>,
}

type SocketStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

pub(crate) async fn pair(server: &str, pairing_code: &str) -> Result<Issued> {
    let (tx, mut stream) = connect(server).await?;
    send_text(
        &tx,
        &ClientMessage::Pair {
            pairing_code: pairing_code.to_owned(),
        },
    )?;
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
    let (tx, mut stream) = connect(server).await?;
    send_text(
        &tx,
        &ClientMessage::Hello {
            node_id: node_id.to_owned(),
            token: token.to_owned(),
            os: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            clis,
        },
    )?;
    match next_server(&mut stream).await? {
        ServerMessage::Welcome { .. } => {}
        ServerMessage::Error { code } => bail!("node hello rejected ({code})"),
        _ => bail!("node hello was not welcomed"),
    }

    let runs = Arc::new(Mutex::new(HashMap::<String, LiveRun>::new()));
    let heartbeat_tx = tx.clone();
    let heartbeat_runs = Arc::clone(&runs);
    let heartbeat = tokio::spawn(async move {
        let mut tick = tokio::time::interval(HEARTBEAT);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let run_ids: Vec<String> = heartbeat_runs.lock().await.keys().cloned().collect();
            if send_text(&heartbeat_tx, &ClientMessage::Heartbeat { run_ids }).is_err() {
                break;
            }
        }
    });

    let result = read_loop(&tx, &mut stream, runs).await;
    heartbeat.abort();
    result
}

async fn connect(server: &str) -> Result<(mpsc::UnboundedSender<Wire>, SocketStream)> {
    let (socket, _) = tokio_tungstenite::connect_async(server)
        .await
        .with_context(|| format!("could not dial {server}"))?;
    let (mut sink, stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(item) = rx.recv().await {
            let message = match item {
                Wire::Text(text) => tokio_tungstenite::tungstenite::Message::Text(text.into()),
                Wire::Pong(data) => tokio_tungstenite::tungstenite::Message::Pong(data.into()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
            if sink.flush().await.is_err() {
                break;
            }
        }
    });
    Ok((tx, stream))
}

fn send_text(tx: &mpsc::UnboundedSender<Wire>, message: &ClientMessage) -> Result<()> {
    tx.send(Wire::Text(message.to_json()))
        .map_err(|_| anyhow::anyhow!("node socket closed"))?;
    Ok(())
}

async fn next_server(stream: &mut SocketStream) -> Result<ServerMessage> {
    let frame = tokio::time::timeout(Duration::from_secs(10), next_text(stream))
        .await
        .context("timed out waiting for the server")??;
    serde_json::from_str(&frame).context("server frame was not JSON")
}

async fn next_text(stream: &mut SocketStream) -> Result<String> {
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
    tx: &mpsc::UnboundedSender<Wire>,
    stream: &mut SocketStream,
    runs: Arc<Mutex<HashMap<String, LiveRun>>>,
) -> Result<()> {
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
                        program,
                        args,
                        cwd,
                        env,
                        ..
                    } => {
                        if !begin_run(tx, &runs, &run_id, attempt).await? {
                            continue;
                        }
                        let tx = tx.clone();
                        let runs = Arc::clone(&runs);
                        tokio::spawn(async move {
                            if let Err(error) = drive_process(
                                tx.clone(),
                                Arc::clone(&runs),
                                run_id.clone(),
                                program,
                                args,
                                cwd,
                                env,
                            )
                            .await
                            {
                                let _ = send_failure(&tx, &runs, &run_id, &error).await;
                            }
                        });
                    }
                    ServerMessage::Error { code } => bail!("server rejected the node ({code})"),
                    ServerMessage::Ack { .. }
                    | ServerMessage::HeartbeatAck
                    | ServerMessage::Welcome { .. }
                    | ServerMessage::Paired { .. } => {}
                }
            }
            tokio_tungstenite::tungstenite::Message::Ping(data) => {
                let _ = tx.send(Wire::Pong(data.to_vec()));
            }
            tokio_tungstenite::tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

/// Returns false when this run id and attempt are already driving a process.
async fn begin_run(
    tx: &mpsc::UnboundedSender<Wire>,
    runs: &Mutex<HashMap<String, LiveRun>>,
    run_id: &str,
    attempt: u32,
) -> Result<bool> {
    let mut guard = runs.lock().await;
    if let Some(live) = guard.get(run_id)
        && live.attempt == attempt
    {
        let seq = *live.seq.lock().await;
        drop(guard);
        send_text(
            tx,
            &ClientMessage::AlreadyRunning {
                run_id: run_id.to_owned(),
                attempt,
                seq,
            },
        )?;
        return Ok(false);
    }
    guard.insert(
        run_id.to_owned(),
        LiveRun {
            attempt,
            seq: Arc::new(Mutex::new(0)),
        },
    );
    Ok(true)
}

async fn drive_process(
    tx: mpsc::UnboundedSender<Wire>,
    runs: Arc<Mutex<HashMap<String, LiveRun>>>,
    run_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
) -> Result<()> {
    let seq = {
        let guard = runs.lock().await;
        guard
            .get(&run_id)
            .context("run disappeared before start")?
            .seq
            .clone()
    };
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
            let message = format!("failed to start {program}: {error}\n");
            emit(&tx, &seq, &run_id, OutputStream::Stderr, message.as_bytes()).await?;
            emit_exit(&tx, &seq, &run_id, 127).await?;
            runs.lock().await.remove(&run_id);
            return Ok(());
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_tx = tx.clone();
    let out_seq = Arc::clone(&seq);
    let out_id = run_id.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(pipe) = stdout {
            let _ = pump(out_tx, out_seq, out_id, OutputStream::Stdout, pipe).await;
        }
    });
    let err_tx = tx.clone();
    let err_seq = Arc::clone(&seq);
    let err_id = run_id.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(pipe) = stderr {
            let _ = pump(err_tx, err_seq, err_id, OutputStream::Stderr, pipe).await;
        }
    });
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let status = child.wait().await.context("failed to wait for the CLI")?;
    emit_exit(&tx, &seq, &run_id, exit_code(status)).await?;
    runs.lock().await.remove(&run_id);
    Ok(())
}

async fn pump<R>(
    tx: mpsc::UnboundedSender<Wire>,
    seq: Arc<Mutex<u64>>,
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
        emit(&tx, &seq, &run_id, stream, &buf[..n]).await?;
    }
    Ok(())
}

async fn emit(
    tx: &mpsc::UnboundedSender<Wire>,
    seq: &Mutex<u64>,
    run_id: &str,
    stream: OutputStream,
    bytes: &[u8],
) -> Result<()> {
    // Hold the sequence lock across the send so stdout and stderr cannot reorder.
    let mut guard = seq.lock().await;
    *guard += 1;
    let next = *guard;
    send_text(
        tx,
        &ClientMessage::Output {
            run_id: run_id.to_owned(),
            stream,
            seq: next,
            data: STANDARD.encode(bytes),
        },
    )?;
    Ok(())
}

async fn emit_exit(
    tx: &mpsc::UnboundedSender<Wire>,
    seq: &Mutex<u64>,
    run_id: &str,
    exit_code: i32,
) -> Result<()> {
    let mut guard = seq.lock().await;
    *guard += 1;
    let next = *guard;
    send_text(
        tx,
        &ClientMessage::Exit {
            run_id: run_id.to_owned(),
            seq: next,
            exit_code,
        },
    )?;
    Ok(())
}

async fn send_failure(
    tx: &mpsc::UnboundedSender<Wire>,
    runs: &Mutex<HashMap<String, LiveRun>>,
    run_id: &str,
    error: &anyhow::Error,
) -> Result<()> {
    let seq = {
        let guard = runs.lock().await;
        match guard.get(run_id) {
            Some(live) => live.seq.clone(),
            None => return Ok(()),
        }
    };
    let message = format!("{error:#}\n");
    emit(tx, &seq, run_id, OutputStream::Stderr, message.as_bytes()).await?;
    emit_exit(tx, &seq, run_id, 1).await?;
    runs.lock().await.remove(run_id);
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
