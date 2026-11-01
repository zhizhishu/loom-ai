//! B2: persisted node identity, output resume across a server restart, heartbeat
//! offline, revoke, pairing rate limit, and rejection of a program the node did
//! not discover.

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn main() {
    if std::env::var("LOOM_B2_ROLE").ok().as_deref() == Some("server") {
        let code = match rovai_host::run_server() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error:#}");
                1
            }
        };
        std::process::exit(code);
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("B2 acceptance runs on Linux");
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = acceptance() {
        eprintln!("B2 acceptance failed: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn acceptance() -> Result<()> {
    let root = std::env::temp_dir().join(format!(
        "loom-b2-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let _cleanup = RemoveDir(root.clone());
    fs::create_dir_all(&root)?;
    disallowed_program(&root)?;

    let a = root.join("a");
    let b = root.join("b");
    let bin = root.join("bin");
    let work = root.join("work");
    let ui = root.join("ui");
    let spawn_log = root.join("spawn.log");
    fs::create_dir_all(&bin)?;
    fs::create_dir_all(&work)?;
    fs::create_dir_all(&ui)?;
    fs::write(
        ui.join("index.html"),
        "<!doctype html><title>loom-b2</title>\n",
    )?;
    fs::write(
        bin.join("codex"),
        format!(
            "#!/usr/bin/python3\nimport sys, time\nif \"--version\" in sys.argv:\n    print(\"b2-codex 0\")\n    raise SystemExit(0)\nwith open({path}, \"a\", encoding=\"utf-8\") as handle:\n    handle.write(str(__import__(\"os\").getpid()) + \"\\n\")\nfor index in range(1, 361):\n    print(f\"SEQ {{index}}\", flush=True)\n    time.sleep(0.5)\n",
            path = serde_json::to_string(&spawn_log.display().to_string())?
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o755))?;
    }

    let listen = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = probe.local_addr()?.port();
        drop(probe);
        format!("127.0.0.1:{port}")
    };
    let server_out = root.join("server.stdout");
    let server_err = root.join("server.stderr");
    let mut processes = Processes::default();
    processes.server = Some(spawn_server(&a, &ui, &listen, &server_out, &server_err)?);
    let origin = wait_listener(&a, &mut processes, &server_err, Duration::from_secs(180))?;
    let connect = origin
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1)
        + "/api/v1/nodes/connect";
    let host = origin
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_owned();

    let mut session = login(&host, &a)?;
    let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    let local = node_with_role(&listed, "local")?;
    if local["revocable"] != false || local["status"] != "online" || local["role"] != "local" {
        bail!("local node is not a non-revocable online entry: {local}");
    }

    let code = pair_code(&a)?;
    let node_err = root.join("node.stderr");
    processes.node = Some(spawn_node(&b, &bin, &connect, Some(&code), &node_err)?);
    wait_remote_online(&host, &a, &mut session, Duration::from_secs(30))?;

    let exec_out = root.join("exec.stdout");
    let exec_err = root.join("exec.stderr");
    processes.exec = Some(
        Command::new(std::env::current_exe()?)
            .env("LOOM_B2_ROLE", "server")
            .args([
                "node-exec",
                "--data-dir",
                a.to_str().unwrap(),
                "--runtime",
                "codex-cli",
                "--cwd",
                work.to_str().unwrap(),
                "--",
                "exec",
                "--skip-git-repo-check",
                "slow",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::from(fs::File::create(&exec_out)?))
            .stderr(Stdio::from(fs::File::create(&exec_err)?))
            .spawn()
            .context("node-exec failed to start")?,
    );

    let run_id = match wait_run(&host, &a, &mut session, Duration::from_secs(40)) {
        Ok(run_id) => run_id,
        Err(error) => bail!(
            "{error:#}\nserver:\n{}\nnode:\n{}\nexec stdout:\n{}\nexec stderr:\n{}",
            fs::read_to_string(&server_err).unwrap_or_default(),
            fs::read_to_string(&node_err).unwrap_or_default(),
            fs::read_to_string(&exec_out).unwrap_or_default(),
            fs::read_to_string(&exec_err).unwrap_or_default()
        ),
    };
    let before = wait_frames(&host, &session, &run_id, 2, Duration::from_secs(20))?;
    assert_contiguous(&before)?;
    let before_frames = before["frames"].as_array().context("frames")?.len();

    let server_out_2 = root.join("server2.stdout");
    let server_err_2 = root.join("server2.stderr");
    restart_server(
        &mut processes,
        &a,
        &ui,
        &listen,
        &server_out_2,
        &server_err_2,
    )?;
    let origin = wait_listener(&a, &mut processes, &server_err_2, Duration::from_secs(180))?;
    let host = origin
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_owned();
    session = login(&host, &a)?;
    let after = wait_frames(
        &host,
        &session,
        &run_id,
        before_frames + 1,
        Duration::from_secs(40),
    )?;
    assert_contiguous(&after)?;
    let after_frames = after["frames"].as_array().context("frames")?;
    let before_saved = before["frames"].as_array().context("frames")?;
    if after_frames.get(..before_saved.len()) != Some(before_saved.as_slice()) {
        bail!(
            "resumed output did not keep the acknowledged prefix\nbefore: {before}\nafter: {after}"
        );
    }
    let text = stdout_text(&after)?;
    assert_seq_text(&text)?;
    let spawns = spawn_count(&spawn_log)?;
    if spawns != 1 {
        bail!(
            "expected one process, spawn log has {spawns}: {}",
            fs::read_to_string(&spawn_log).unwrap_or_default()
        );
    }

    let killed = Instant::now();
    if let Some(mut node) = processes.node.take() {
        let _ = node.kill();
        let _ = node.wait();
    }
    thread::sleep(Duration::from_secs(5));
    session = login(&host, &a)?;
    let mid = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    let remote = node_with_role(&mid, "remote")?;
    if remote["status"] != "online" {
        bail!("node was marked offline before the heartbeat grace: {remote}");
    }
    let remote_id = remote["nodeId"].as_str().context("node id")?.to_owned();
    let mut offline = false;
    while killed.elapsed() < Duration::from_secs(45) {
        let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
        let remote = node_with_role(&listed, "remote")?;
        if remote["status"] == "offline" {
            offline = true;
            if remote["clis"].as_array().is_none_or(|clis| clis.is_empty()) {
                bail!("offline node dropped its last CLI report: {remote}");
            }
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    if !offline {
        bail!("node was still online 45s after the process exited");
    }

    let node_err_2 = root.join("node2.stderr");
    processes.node = Some(spawn_node(&b, &bin, &connect, None, &node_err_2)?);
    wait_remote_online(&host, &a, &mut session, Duration::from_secs(20))?;
    if spawn_count(&spawn_log)? != 1 {
        bail!("reconnecting spawned another process");
    }

    rate_limit(&connect)?;

    let (status, body) = request(
        "POST",
        &host,
        &format!("/api/v1/nodes/{remote_id}/revoke"),
        Some(&session),
        Some("{}"),
    )?;
    if status != 200 || !body.contains("token") && !body.contains("revokedAt") {
        bail!("revoke failed ({status}): {body}");
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if processes
            .node
            .as_mut()
            .and_then(|node| node.try_wait().ok())
            .flatten()
            .is_some()
        {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if processes
        .node
        .as_mut()
        .and_then(|node| node.try_wait().ok())
        .flatten()
        .is_none()
    {
        bail!(
            "revoked node kept running\n{}",
            fs::read_to_string(&node_err_2).unwrap_or_default()
        );
    }
    let token = node_token(&b)?;
    let rejection = dial_hello(&connect, &remote_id, &token)?;
    if !rejection.contains("token_revoked") && !rejection.contains("token_rejected") {
        bail!("revoked token was accepted: {rejection}");
    }
    let local_id = {
        let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
        node_with_role(&listed, "local")?["nodeId"]
            .as_str()
            .context("local id")?
            .to_owned()
    };
    let (status, body) = request(
        "POST",
        &host,
        &format!("/api/v1/nodes/{local_id}/revoke"),
        Some(&session),
        Some("{}"),
    )?;
    if status != 409 || !body.contains("node_not_revocable") {
        bail!("local node revoke was not rejected ({status}): {body}");
    }

    processes.stop();
    Ok(())
}

#[cfg(target_os = "linux")]
fn disallowed_program(root: &Path) -> Result<()> {
    let bin = root.join("allow-bin");
    let data = root.join("allow-b");
    let cwd = root.join("allow-work");
    fs::create_dir_all(&bin)?;
    fs::create_dir_all(&cwd)?;
    let evil = root.join("evil.sh");
    let evil_marker = root.join("evil-ran");
    let ok_marker = root.join("ok-ran");
    fs::write(
        &evil,
        format!("#!/bin/sh\nprintf evil > {}\n", shell_quote(&evil_marker)),
    )?;
    fs::write(
        bin.join("codex"),
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'b2-codex 0\\n'; exit 0; fi\nprintf ok > {}\n",
            shell_quote(&ok_marker)
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&evil, fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o755))?;
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let evil_for_server = evil.clone();
    let cwd_for_server = cwd.clone();
    let server = thread::spawn(move || fake_dispatch(listener, evil_for_server, cwd_for_server));
    let node_err = root.join("allow-node.stderr");
    let mut node = Command::new(env!("CARGO_BIN_EXE_loom-node"))
        .env("PATH", &bin)
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--server",
            &format!("ws://127.0.0.1:{port}/api/v1/nodes/connect"),
            "--pair-code",
            "b2-allow",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(fs::File::create(&node_err)?))
        .spawn()
        .context("failed to start loom-node for the allowlist check")?;
    let result = match server.join() {
        Ok(result) => result,
        Err(_) => bail!("fake server panicked"),
    };
    let _ = node.kill();
    let _ = node.wait();
    if evil_marker.exists() {
        bail!("disallowed program ran");
    }
    result.with_context(|| fs::read_to_string(&node_err).unwrap_or_default())?;
    if !ok_marker.exists() {
        bail!(
            "discovered program did not run\n{}",
            fs::read_to_string(&node_err).unwrap_or_default()
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn fake_dispatch(listener: std::net::TcpListener, evil: PathBuf, cwd: PathBuf) -> Result<()> {
    use tungstenite::{Message, accept};
    let (sock, _) = listener.accept().context("pair accept")?;
    sock.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut socket = accept(sock).context("pair handshake")?;
    let pair = read_ws(&mut socket)?;
    if !pair.contains("\"type\":\"pair\"") {
        bail!("expected a pair frame, got {pair}");
    }
    let token = "ab".repeat(32);
    socket.send(Message::Text(
        format!(r#"{{"type":"paired","nodeId":"node_fake","token":"{token}"}}"#).into(),
    ))?;
    drop(socket);

    let (sock, _) = listener.accept().context("hello accept")?;
    sock.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut socket = accept(sock).context("hello handshake")?;
    let hello = read_ws(&mut socket)?;
    let hello: serde_json::Value = serde_json::from_str(&hello).context("hello json")?;
    if hello["type"] != "hello" {
        bail!("expected hello, got {hello}");
    }
    let discovered = hello["clis"]
        .as_array()
        .and_then(|clis| clis.iter().find(|cli| cli["adapterKind"] == "codex-cli"))
        .and_then(|cli| cli["path"].as_str())
        .context("node did not report codex-cli")?
        .to_owned();
    socket.send(Message::Text(
        r#"{"type":"welcome","nodeId":"node_fake"}"#.into(),
    ))?;
    socket.send(Message::Text(
        serde_json::json!({
            "type": "start",
            "runId": "run_evil",
            "attempt": 1,
            "adapterKind": "codex-cli",
            "program": evil,
            "args": [],
            "cwd": cwd,
            "env": [],
            "shimToken": "cd".repeat(32),
        })
        .to_string()
        .into(),
    ))?;
    let rejected = read_until(&mut socket, "program_not_allowed", Duration::from_secs(10))?;
    if !rejected.contains("program_not_allowed") {
        bail!("disallowed program was not rejected: {rejected}");
    }
    socket.send(Message::Text(
        serde_json::json!({
            "type": "start",
            "runId": "run_ok",
            "attempt": 1,
            "adapterKind": "codex-cli",
            "program": discovered,
            "args": [],
            "cwd": cwd,
            "env": [],
            "shimToken": "cd".repeat(32),
        })
        .to_string()
        .into(),
    ))?;
    let _ = read_until(&mut socket, "\"type\":\"output\"", Duration::from_secs(10));
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_ws<S>(socket: &mut tungstenite::WebSocket<S>) -> Result<String>
where
    S: std::io::Read + std::io::Write,
{
    loop {
        match socket.read().context("websocket read")? {
            tungstenite::Message::Text(text) => return Ok(text.to_string()),
            tungstenite::Message::Ping(data) => {
                socket.send(tungstenite::Message::Pong(data))?;
            }
            tungstenite::Message::Close(_) => bail!("socket closed"),
            _ => {}
        }
    }
}

#[cfg(target_os = "linux")]
fn read_until(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    needle: &str,
    limit: Duration,
) -> Result<String> {
    let started = Instant::now();
    let mut seen = String::new();
    while started.elapsed() < limit {
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                seen.push_str(&text);
                seen.push('\n');
                if seen.contains(needle) {
                    return Ok(seen);
                }
            }
            Ok(tungstenite::Message::Ping(data)) => {
                socket.send(tungstenite::Message::Pong(data))?;
            }
            Ok(tungstenite::Message::Close(_)) => break,
            Ok(_) => {}
            Err(error) => {
                if started.elapsed() >= limit {
                    break;
                }
                if format!("{error}").contains("timed out")
                    || format!("{error}").contains("WouldBlock")
                {
                    continue;
                }
                return Err(error).context(seen);
            }
        }
    }
    Ok(seen)
}

#[cfg(target_os = "linux")]
fn rate_limit(connect: &str) -> Result<()> {
    use tungstenite::Message;
    let mut limited = false;
    for _ in 0..9 {
        let (mut socket, _) = tungstenite::connect(connect).context("pairing dial")?;
        socket.send(Message::Text(
            r#"{"type":"pair","pairingCode":"not-a-real-code"}"#.into(),
        ))?;
        let reply = read_ws(&mut socket).unwrap_or_default();
        if reply.contains("pairing_rate_limited") {
            limited = true;
            break;
        }
        if !reply.contains("pairing_invalid") && !reply.contains("administrator_rejected") {
            bail!("unexpected pairing reply: {reply}");
        }
    }
    if !limited {
        bail!("pairing failures were not rate limited");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn dial_hello(connect: &str, node_id: &str, token: &str) -> Result<String> {
    let (mut socket, _) = tungstenite::connect(connect).context("revoked dial")?;
    let hello = serde_json::json!({
        "type": "hello",
        "nodeId": node_id,
        "token": token,
        "os": "linux",
        "arch": "x86_64",
        "clis": []
    });
    socket.send(tungstenite::Message::Text(hello.to_string().into()))?;
    read_ws(&mut socket)
}

#[cfg(target_os = "linux")]
fn spawn_server(
    a: &Path,
    ui: &Path,
    listen: &str,
    stdout: &Path,
    stderr: &Path,
) -> Result<std::process::Child> {
    Command::new(std::env::current_exe()?)
        .env("LOOM_B2_ROLE", "server")
        .args([
            "--data-dir",
            a.to_str().context("data dir")?,
            "--listen",
            listen,
            "--web-ui",
            ui.to_str().context("web ui")?,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(fs::File::create(stdout)?))
        .stderr(Stdio::from(fs::File::create(stderr)?))
        .spawn()
        .context("failed to start rovai-server")
}

#[cfg(target_os = "linux")]
fn spawn_node(
    data: &Path,
    bin: &Path,
    connect: &str,
    pair_code: Option<&str>,
    stderr: &Path,
) -> Result<std::process::Child> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_loom-node"));
    command
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .arg("--data-dir")
        .arg(data)
        .arg("--server")
        .arg(connect);
    if let Some(code) = pair_code {
        command.arg("--pair-code").arg(code);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(fs::File::create(stderr)?))
        .spawn()
        .context("failed to start loom-node")
}

#[cfg(target_os = "linux")]
fn restart_server(
    processes: &mut Processes,
    a: &Path,
    ui: &Path,
    listen: &str,
    stdout: &Path,
    stderr: &Path,
) -> Result<()> {
    let Some(mut server) = processes.server.take() else {
        bail!("server is not running");
    };
    let _ = Command::new("kill")
        .args(["-TERM", &server.id().to_string()])
        .status();
    let started = Instant::now();
    loop {
        if server.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = server.kill();
            let _ = server.wait();
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let listener = a.join("loom-node-listener.json");
    let started = Instant::now();
    while listener.exists() && started.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(50));
    }
    let _ = fs::remove_file(&listener);
    processes.server = Some(spawn_server(a, ui, listen, stdout, stderr)?);
    Ok(())
}

#[cfg(target_os = "linux")]
fn wait_listener(
    a: &Path,
    processes: &mut Processes,
    server_err: &Path,
    limit: Duration,
) -> Result<String> {
    let listener = a.join("loom-node-listener.json");
    let started = Instant::now();
    while !listener.exists() {
        if processes
            .server
            .as_mut()
            .and_then(|server| server.try_wait().ok())
            .flatten()
            .is_some()
        {
            bail!(
                "rovai-server exited before listening\n{}",
                fs::read_to_string(server_err).unwrap_or_default()
            );
        }
        if started.elapsed() > limit {
            bail!(
                "rovai-server did not publish a listener\n{}",
                fs::read_to_string(server_err).unwrap_or_default()
            );
        }
        thread::sleep(Duration::from_millis(200));
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&listener)?)?;
    value["origin"]
        .as_str()
        .map(str::to_owned)
        .context("listener file has no origin")
}

#[cfg(target_os = "linux")]
fn pair_code(a: &Path) -> Result<String> {
    let pair = Command::new(std::env::current_exe()?)
        .env("LOOM_B2_ROLE", "server")
        .args(["node-pair", "--data-dir", a.to_str().unwrap()])
        .output()
        .context("node-pair failed to start")?;
    if !pair.status.success() {
        bail!(
            "node-pair failed: {}",
            String::from_utf8_lossy(&pair.stderr)
        );
    }
    let code = String::from_utf8(pair.stdout)?.trim().to_owned();
    if code.is_empty() {
        bail!("node-pair printed an empty code");
    }
    Ok(code)
}

#[cfg(target_os = "linux")]
fn login(host: &str, data_dir: &Path) -> Result<String> {
    let admin = rovai_web::stored_administrator_token(data_dir)?
        .context("administrator token was not stored")?;
    let body = serde_json::json!({
        "protocolVersion": rovai_web::HOST_WEB_PROTOCOL_VERSION,
        "administratorToken": admin,
    })
    .to_string();
    let (status, text) = request("POST", host, "/api/v1/login", None, Some(&body))?;
    if status != 200 {
        bail!("login failed ({status}): {text}");
    }
    let value: serde_json::Value = serde_json::from_str(&text).context("login json")?;
    value["token"]
        .as_str()
        .map(str::to_owned)
        .context("login has no token")
}

#[cfg(target_os = "linux")]
fn api_json(
    method: &str,
    host: &str,
    path: &str,
    session: &str,
    body: Option<&str>,
) -> Result<serde_json::Value> {
    let (status, text) = request(method, host, path, Some(session), body)?;
    if status != 200 {
        bail!("{method} {path} failed ({status}): {text}");
    }
    serde_json::from_str(&text).with_context(|| format!("{method} {path} was not JSON: {text}"))
}

#[cfg(target_os = "linux")]
fn request(
    method: &str,
    host: &str,
    path: &str,
    session: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, String)> {
    let mut stream = TcpStream::connect(host).with_context(|| format!("dial {host}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    let body = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(session) = session {
        request.push_str(&format!("Authorization: Bearer {session}\r\n"));
    }
    if !body.is_empty() || method == "POST" {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse::<u16>()
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    Ok((status, body))
}

#[cfg(target_os = "linux")]
fn node_with_role<'a>(list: &'a serde_json::Value, role: &str) -> Result<&'a serde_json::Value> {
    list["nodes"]
        .as_array()
        .context("nodes")?
        .iter()
        .find(|node| node["role"] == role)
        .with_context(|| format!("no {role} node in {list}"))
}

#[cfg(target_os = "linux")]
fn wait_remote_online(
    host: &str,
    data_dir: &Path,
    session: &mut String,
    limit: Duration,
) -> Result<()> {
    let started = Instant::now();
    while started.elapsed() < limit {
        if let Ok(list) = api_json("GET", host, "/api/v1/nodes", session, None) {
            if let Ok(remote) = node_with_role(&list, "remote")
                && remote["status"] == "online"
                && remote["clis"]
                    .as_array()
                    .is_some_and(|clis| clis.iter().any(|cli| cli["adapterKind"] == "codex-cli"))
            {
                return Ok(());
            }
        } else {
            *session = login(host, data_dir)?;
        }
        thread::sleep(Duration::from_millis(200));
    }
    bail!("remote node did not come online")
}

#[cfg(target_os = "linux")]
fn wait_run(host: &str, data_dir: &Path, session: &mut String, limit: Duration) -> Result<String> {
    let started = Instant::now();
    while started.elapsed() < limit {
        if let Ok(list) = api_json("GET", host, "/api/v1/nodes", session, None) {
            if let Ok(remote) = node_with_role(&list, "remote")
                && let Some(run_id) = remote["activeRuns"]
                    .as_array()
                    .and_then(|runs| runs.first())
                    .and_then(|run| run["runId"].as_str())
            {
                return Ok(run_id.to_owned());
            }
        } else {
            *session = login(host, data_dir)?;
        }
        thread::sleep(Duration::from_millis(200));
    }
    bail!("dispatch did not appear on the node")
}

#[cfg(target_os = "linux")]
fn wait_frames(
    host: &str,
    session: &str,
    run_id: &str,
    min_frames: usize,
    limit: Duration,
) -> Result<serde_json::Value> {
    let started = Instant::now();
    let path = format!("/api/v1/nodes/runs/{run_id}/output/1");
    let mut last = String::new();
    while started.elapsed() < limit {
        match api_json("GET", host, &path, session, None) {
            Ok(body) => {
                last = body.to_string();
                let count = body["frames"]
                    .as_array()
                    .map(|frames| frames.len())
                    .unwrap_or(0);
                if count >= min_frames && body["status"] == "running" {
                    return Ok(body);
                }
                if body["status"] == "exited" || body["status"] == "interrupted" {
                    bail!("run ended before enough output: {body}");
                }
            }
            Err(error) => last = format!("{error:#}"),
        }
        thread::sleep(Duration::from_millis(200));
    }
    bail!("timed out waiting for {min_frames} output frames; last: {last}")
}

#[cfg(target_os = "linux")]
fn assert_contiguous(body: &serde_json::Value) -> Result<()> {
    let frames = body["frames"].as_array().context("frames")?;
    for (index, frame) in frames.iter().enumerate() {
        let seq = frame["seq"].as_u64().context("seq")?;
        if seq != index as u64 + 1 {
            bail!("output sequence is not contiguous at {seq}: {body}");
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn stdout_text(body: &serde_json::Value) -> Result<String> {
    let mut text = String::new();
    for frame in body["frames"].as_array().context("frames")? {
        if frame["stream"] == "stdout" {
            let data = frame["data"].as_str().context("data")?;
            let bytes = STANDARD.decode(data).context("stdout base64")?;
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    Ok(text)
}

#[cfg(target_os = "linux")]
fn assert_seq_text(text: &str) -> Result<()> {
    let mut expected = 1u64;
    let mut saw = 0u64;
    for line in text.lines() {
        let Some(number) = line.strip_prefix("SEQ ") else {
            continue;
        };
        let number: u64 = number
            .trim()
            .parse()
            .with_context(|| format!("bad line {line}"))?;
        if number != expected {
            bail!("stdout sequence jumped to {number}, expected {expected}\n{text}");
        }
        expected += 1;
        saw += 1;
    }
    if saw < 2 {
        bail!("stdout did not contain a growing SEQ stream:\n{text}");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn spawn_count(path: &Path) -> Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    let text = fs::read_to_string(path)?;
    Ok(text.lines().filter(|line| !line.trim().is_empty()).count())
}

#[cfg(target_os = "linux")]
fn node_token(data_dir: &Path) -> Result<String> {
    let value: serde_json::Value = serde_json::from_slice(&fs::read(data_dir.join("node.json"))?)?;
    value["token"]
        .as_str()
        .map(str::to_owned)
        .context("node credential has no token")
}

#[cfg(target_os = "linux")]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct Processes {
    server: Option<std::process::Child>,
    node: Option<std::process::Child>,
    exec: Option<std::process::Child>,
}

#[cfg(target_os = "linux")]
impl Processes {
    fn stop(&mut self) {
        for child in [&mut self.exec, &mut self.node] {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let Some(mut server) = self.server.take() else {
            return;
        };
        let _ = Command::new("kill")
            .args(["-TERM", &server.id().to_string()])
            .status();
        let started = Instant::now();
        loop {
            if server.try_wait().ok().flatten().is_some() {
                break;
            }
            if started.elapsed() > Duration::from_secs(15) {
                let _ = server.kill();
                let _ = server.wait();
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for Processes {
    fn drop(&mut self) {
        self.stop();
    }
}

struct RemoveDir(PathBuf);

impl Drop for RemoveDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
