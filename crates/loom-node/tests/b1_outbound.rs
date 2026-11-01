//! Two processes, two data directories: `rovai-server` dispatches `codex-cli`
//! to an outbound `loom-node`, and the node never listens.

use anyhow::{Context, Result, bail};
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
    if std::env::var("LOOM_B1_ROLE").ok().as_deref() == Some("server") {
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
        eprintln!("B1 acceptance runs on Linux");
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = acceptance() {
        eprintln!("B1 acceptance failed: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn acceptance() -> Result<()> {
    let root = std::env::temp_dir().join(format!(
        "loom-b1-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let _cleanup = RemoveDir(root.clone());
    let a = root.join("a");
    let b = root.join("b");
    let bin = root.join("bin");
    let work = root.join("work");
    let ui = root.join("ui");
    fs::create_dir_all(&bin)?;
    fs::create_dir_all(&work)?;
    fs::create_dir_all(&ui)?;
    fs::write(
        ui.join("index.html"),
        "<!doctype html><title>loom-b1</title>\n",
    )?;
    fs::write(
        bin.join("codex"),
        "#!/bin/sh\nprintf 'LOOM_B1_OK\\n'\nexit 0\n",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o755))?;
    }

    let server_out = root.join("server.stdout");
    let server_err = root.join("server.stderr");
    let mut processes = Processes::default();
    processes.server = Some(
        Command::new(std::env::current_exe()?)
            .env("LOOM_B1_ROLE", "server")
            .args([
                "--data-dir",
                a.to_str().context("data dir")?,
                "--listen",
                "127.0.0.1:0",
                "--web-ui",
                ui.to_str().context("web ui")?,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::from(fs::File::create(&server_out)?))
            .stderr(Stdio::from(fs::File::create(&server_err)?))
            .spawn()
            .context("failed to start rovai-server")?,
    );
    let server_pid = processes.server.as_ref().unwrap().id();

    let listener = a.join("loom-node-listener.json");
    let ready = Instant::now();
    while !listener.exists() {
        if processes.server.as_mut().unwrap().try_wait()?.is_some() {
            bail!(
                "rovai-server exited before listening\n{}",
                fs::read_to_string(&server_err).unwrap_or_default()
            );
        }
        if ready.elapsed() > Duration::from_secs(180) {
            bail!(
                "rovai-server did not publish a listener\n{}",
                fs::read_to_string(&server_err).unwrap_or_default()
            );
        }
        thread::sleep(Duration::from_millis(200));
    }
    let origin = listener_origin(&listener)?;
    let connect = origin
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1)
        + "/api/v1/nodes/connect";

    let pair = Command::new(std::env::current_exe()?)
        .env("LOOM_B1_ROLE", "server")
        .args(["node-pair", "--data-dir", a.to_str().unwrap()])
        .output()
        .context("node-pair failed to start")?;
    if !pair.status.success() {
        bail!(
            "node-pair failed: {}\n{}",
            String::from_utf8_lossy(&pair.stderr),
            fs::read_to_string(&server_err).unwrap_or_default()
        );
    }
    let code = String::from_utf8(pair.stdout)?.trim().to_owned();
    if code.is_empty() {
        bail!("node-pair printed an empty code");
    }

    let node_err = root.join("node.stderr");
    processes.node = Some(
        Command::new(env!("CARGO_BIN_EXE_loom-node"))
            .env("PATH", &bin)
            .args([
                "--data-dir",
                b.to_str().unwrap(),
                "--server",
                &connect,
                "--pair-code",
                &code,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(fs::File::create(&node_err)?))
            .spawn()
            .context("failed to start loom-node")?,
    );
    let node_pid = processes.node.as_ref().unwrap().id();

    let exec = Command::new(std::env::current_exe()?)
        .env("LOOM_B1_ROLE", "server")
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
            "ignored by the fake cli",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("node-exec failed to start")?;
    let exec_out = root.join("exec.stdout");
    let exec_err = root.join("exec.stderr");
    let finished = wait_child(exec, &exec_out, &exec_err, Duration::from_secs(60))?;
    if !finished.success() {
        bail!(
            "node-exec failed\nstdout:\n{}\nstderr:\n{}\nnode:\n{}",
            fs::read_to_string(&exec_out).unwrap_or_default(),
            fs::read_to_string(&exec_err).unwrap_or_default(),
            fs::read_to_string(&node_err).unwrap_or_default()
        );
    }
    let stdout = fs::read_to_string(&exec_out)?;
    if stdout != "LOOM_B1_OK\n" {
        bail!("unexpected run stdout: {stdout:?}");
    }

    if processes.node.as_mut().unwrap().try_wait()?.is_some() {
        bail!(
            "loom-node exited before the listening check\n{}",
            fs::read_to_string(&node_err).unwrap_or_default()
        );
    }
    if is_listening(node_pid) {
        bail!("loom-node is listening: {}", describe_sockets(node_pid));
    }
    let server_listen = listen_addresses(server_pid);
    if !server_listen
        .iter()
        .any(|addr| addr.starts_with("0100007F:"))
    {
        bail!(
            "rovai-server is not listening on 127.0.0.1: {}",
            describe_sockets(server_pid)
        );
    }

    reject_administrator_on_node_socket(&a, &connect)?;
    reject_node_token_as_login(&a, &b, &origin)?;
    if contains_sqlite(&b) {
        bail!("loom-node data dir contains a SQLite product database");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(b.join("node.json"))?.permissions().mode() & 0o777;
        if mode != 0o600 {
            bail!("node credential mode is {mode:o}, expected 600");
        }
    }
    let node_bin = fs::read(env!("CARGO_BIN_EXE_loom-node"))?;
    if node_bin
        .windows(b"mission_execution_host".len())
        .any(|window| window == b"mission_execution_host")
    {
        bail!("loom-node binary contains the product database schema");
    }

    processes.stop();
    Ok(())
}

#[cfg(target_os = "linux")]
fn listener_origin(path: &Path) -> Result<String> {
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    value["origin"]
        .as_str()
        .map(str::to_owned)
        .context("listener file has no origin")
}

#[cfg(target_os = "linux")]
fn wait_child(
    mut child: std::process::Child,
    stdout_path: &Path,
    stderr_path: &Path,
    limit: Duration,
) -> Result<std::process::ExitStatus> {
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            bail!("timed out waiting for node-exec");
        }
        thread::sleep(Duration::from_millis(50));
    };
    if let Some(mut pipe) = child.stdout.take() {
        let mut buf = Vec::new();
        pipe.read_to_end(&mut buf)?;
        fs::write(stdout_path, buf)?;
    }
    if let Some(mut pipe) = child.stderr.take() {
        let mut buf = Vec::new();
        pipe.read_to_end(&mut buf)?;
        fs::write(stderr_path, buf)?;
    }
    Ok(status)
}

#[cfg(target_os = "linux")]
fn reject_administrator_on_node_socket(data_dir: &Path, connect: &str) -> Result<()> {
    let admin = rovai_web::stored_administrator_token(data_dir)?
        .context("administrator token was not stored")?;
    let (mut socket, _) = tungstenite::connect(connect).context("administrator dial failed")?;
    let hello = serde_json::json!({
        "type": "hello",
        "nodeId": "node_admin",
        "token": admin,
        "os": "linux",
        "arch": "x86_64",
        "clis": []
    });
    socket
        .send(tungstenite::Message::Text(hello.to_string().into()))
        .context("administrator hello send failed")?;
    let reply = socket
        .read()
        .context("administrator hello produced no reply")?;
    let text = match reply {
        tungstenite::Message::Text(text) => text.to_string(),
        other => bail!("administrator hello reply was {other:?}"),
    };
    if !text.contains("administrator_rejected") && !text.contains("token_rejected") {
        bail!("administrator token was accepted on the node socket: {text}");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn reject_node_token_as_login(data_dir: &Path, node_dir: &Path, origin: &str) -> Result<()> {
    let credentials: serde_json::Value =
        serde_json::from_slice(&fs::read(node_dir.join("node.json"))?)?;
    let token = credentials["token"]
        .as_str()
        .context("node credential has no token")?;
    let body = serde_json::json!({
        "protocolVersion": rovai_web::HOST_WEB_PROTOCOL_VERSION,
        "administratorToken": token,
    })
    .to_string();
    let host = origin
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let mut stream = TcpStream::connect(host).context("login dial failed")?;
    let request = format!(
        "POST /api/v1/login HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes())?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    if !response.contains("401") || !response.contains("invalid_administrator_token") {
        bail!("node token was accepted as an administrator login");
    }
    let _ = data_dir;
    Ok(())
}

#[cfg(target_os = "linux")]
fn contains_sqlite(dir: &Path) -> bool {
    let mut pending = vec![dir.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.contains("sqlite") {
                return true;
            }
            if entry.path().is_dir() {
                pending.push(entry.path());
            }
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn is_listening(pid: u32) -> bool {
    !listen_addresses(pid).is_empty()
}

#[cfg(target_os = "linux")]
fn listen_addresses(pid: u32) -> Vec<String> {
    let inodes = process_socket_inodes(pid);
    let mut addresses = Vec::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() > 9 && cols[3] == "0A" && inodes.iter().any(|inode| inode == cols[9]) {
                addresses.push(cols[1].to_owned());
            }
        }
    }
    addresses
}

#[cfg(target_os = "linux")]
fn process_socket_inodes(pid: u32) -> Vec<String> {
    let mut inodes = Vec::new();
    let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return inodes;
    };
    for entry in entries.flatten() {
        if let Ok(target) = fs::read_link(entry.path()) {
            let text = target.to_string_lossy();
            if let Some(rest) = text.strip_prefix("socket:[")
                && let Some(inode) = rest.strip_suffix(']')
            {
                inodes.push(inode.to_owned());
            }
        }
    }
    inodes
}

#[cfg(target_os = "linux")]
fn describe_sockets(pid: u32) -> String {
    let mut lines = Vec::new();
    if let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) {
        for entry in entries.flatten() {
            if let Ok(target) = fs::read_link(entry.path()) {
                lines.push(target.display().to_string());
            }
        }
    }
    lines.join(", ")
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct Processes {
    server: Option<std::process::Child>,
    node: Option<std::process::Child>,
}

#[cfg(target_os = "linux")]
impl Processes {
    fn stop(&mut self) {
        if let Some(mut node) = self.node.take() {
            let _ = node.kill();
            let _ = node.wait();
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
