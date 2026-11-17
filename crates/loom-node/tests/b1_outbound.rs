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
    let outcome = acceptance_at(&root);
    if outcome.is_err() {
        // Opt-in and allowlisted only. The temp root also holds node.json and the
        // per-run shim credentials, so it is never copied wholesale.
        preserve_evidence(&root);
    }
    outcome
}

#[cfg(target_os = "linux")]
fn acceptance_at(root: &Path) -> Result<()> {
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
    // The one-shot body the acceptance reads, plus the identity probe every real
    // CLI answers, so discovery reports a version instead of a bare path.
    fs::write(
        bin.join("codex"),
        "#!/bin/sh\n\
         case \"$1\" in\n\
         --version) printf 'loom-b1-fake 0.0.0\\n'; exit 0 ;;\n\
         esac\n\
         printf 'LOOM_B1_OK\\n'\n\
         exit 0\n",
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

    // B1 used to dispatch before B's Hello, so a node that never came online
    // looked like a run failure. This is a bounded fixture read, not a skip.
    let _node_id = wait_node_online(&origin, &a, Duration::from_secs(30))?;
    // Independent fixture read only: it never decides B1's result.
    record_direct_exec(&bin, root);

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

/// The server's own authenticated view of B, read before dispatch. This is a
/// bounded fixture read (30 s, no skip): it separates "B never came online"
/// from "B refused the run", which both used to surface as a run failure.
#[cfg(target_os = "linux")]
fn wait_node_online(origin: &str, data_dir: &Path, limit: Duration) -> Result<String> {
    let admin =
        rovai_web::stored_administrator_token(data_dir)?.context("administrator token")?;
    let host = origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_owned();
    let login = serde_json::json!({
        "protocolVersion": rovai_web::HOST_WEB_PROTOCOL_VERSION,
        "administratorToken": admin,
    })
    .to_string();
    let started = Instant::now();
    let mut last = String::from("no remote node reported codex-cli");
    while started.elapsed() < limit {
        match online_remote_node(&host, &login) {
            Ok(Some(node_id)) => return Ok(node_id),
            Ok(None) => {}
            Err(error) => last = format!("{error:#}"),
        }
        thread::sleep(Duration::from_millis(200));
    }
    bail!("no online remote node reported codex-cli within {limit:?}: {last}")
}

#[cfg(target_os = "linux")]
fn online_remote_node(host: &str, login_body: &str) -> Result<Option<String>> {
    let (status, text) = http_request(host, "POST", "/api/v1/login", None, Some(login_body))?;
    if status != 200 {
        bail!("administrator login returned {status}");
    }
    let session = serde_json::from_str::<serde_json::Value>(&text)
        .context("login was not JSON")?["token"]
        .as_str()
        .context("login had no session token")?
        .to_owned();
    let (status, text) = http_request(host, "GET", "/api/v1/nodes", Some(&session), None)?;
    if status != 200 {
        bail!("node list returned {status}");
    }
    let listed: serde_json::Value = serde_json::from_str(&text).context("node list was not JSON")?;
    for node in listed["nodes"].as_array().cloned().unwrap_or_default() {
        if node["role"].as_str() != Some("remote") || node["status"].as_str() != Some("online") {
            continue;
        }
        let reports_codex = node["clis"]
            .as_array()
            .is_some_and(|clis| clis.iter().any(|cli| cli["adapterKind"] == "codex-cli"));
        if let Some(node_id) = node["nodeId"]
            .as_str()
            .filter(|id| !id.is_empty() && reports_codex)
        {
            return Ok(Some(node_id.to_owned()));
        }
    }
    Ok(None)
}

/// The three logs B1 already reports plus B's durable legacy journal. The
/// journal names only run identity, attempt and phase; it holds no token. The
/// temp root is never copied because it also holds node.json and the per-run
/// shim credentials, and no profile or environment file is ever collected.
#[cfg(target_os = "linux")]
const EVIDENCE_ALLOWLIST: &[&str] = &["node.stderr", "server.stderr", "exec.stderr"];

#[cfg(target_os = "linux")]
fn preserve_evidence(root: &Path) {
    let Some(directory) = std::env::var_os("LOOM_B1_EVIDENCE_DIR") else {
        return;
    };
    let directory = PathBuf::from(directory);
    if !directory.is_absolute() {
        eprintln!("B1 evidence: LOOM_B1_EVIDENCE_DIR must be absolute; nothing was copied");
        return;
    }
    // The owner directory is never followed: a symlink or a file is refused.
    if let Ok(meta) = fs::symlink_metadata(&directory)
        && (!meta.is_dir() || meta.file_type().is_symlink())
    {
        eprintln!("B1 evidence: LOOM_B1_EVIDENCE_DIR is not a plain directory; nothing was copied");
        return;
    }
    // A fresh run subdirectory: an existing run is never overwritten.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let target = directory.join(format!("run-{stamp}"));
    if fs::create_dir(&target).is_err() {
        eprintln!("B1 evidence: a fresh run directory could not be created; nothing was copied");
        return;
    }
    let mut copied = 0_u32;
    for name in EVIDENCE_ALLOWLIST {
        if copy_new(&root.join(*name), &target.join(*name)) {
            copied += 1;
        }
    }
    let journal = root.join("b").join("legacy-runs");
    let journal_target = target.join("legacy-runs");
    if let Ok(entries) = fs::read_dir(&journal)
        && fs::create_dir(&journal_target).is_ok()
    {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let label = name.to_string_lossy().into_owned();
            // Exactly the journal's own `<64 hex>.json` record name, which also
            // skips owner.lock and every unexpected file.
            if label.len() != 69
                || !label.ends_with(".json")
                || !label.as_bytes()[..64]
                    .iter()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                continue;
            }
            if copy_new(&entry.path(), &journal_target.join(&name)) {
                copied += 1;
            }
        }
    }
    eprintln!("B1 evidence: copied {copied} file(s) to {}", target.display());
}

/// `create_new` refuses an existing file or symlink, so an earlier run is never
/// replaced and no copy is redirected through a link.
#[cfg(target_os = "linux")]
fn copy_new(source: &Path, target: &Path) -> bool {
    let Ok(mut input) = fs::File::open(source) else {
        return false;
    };
    let Ok(mut output) = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
    else {
        return false;
    };
    std::io::copy(&mut input, &mut output).is_ok()
}

/// A second, independent read of the fixture: the same absolute fake CLI, run
/// directly by this test with a cleared environment. It never decides B1's
/// result (the run below and its exact stdout assertion stay authoritative);
/// it only separates "the fixture cannot be executed here" from "the node's
/// own boundary refused it". Only a closed kind label and the raw errno are
/// printed, never the error text and never a path.
#[cfg(target_os = "linux")]
fn record_direct_exec(bin: &Path, root: &Path) {
    let cli = bin.join("codex");
    let outcome = Command::new(&cli)
        .env_clear()
        .env("PATH", bin)
        .args(["exec", "diagnostic"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    match outcome {
        Ok(_) => eprintln!("B1 direct exec: ok"),
        Err(error) => eprintln!(
            "B1 direct exec: failed io={} os={}",
            exec_io_label(error.kind()),
            error.raw_os_error().unwrap_or(-1)
        ),
    }
    eprintln!("B1 temp mount: noexec={}", temp_mount_is_noexec(root));
}

/// Closed vocabulary, matching the node-side spawn diagnostic.
#[cfg(target_os = "linux")]
fn exec_io_label(kind: std::io::ErrorKind) -> &'static str {
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
        _ => "unknown",
    }
}

/// One fixed boolean: whether the mount owning the fixture root carries
/// `noexec`. No path, no option list and no environment detail is printed.
#[cfg(target_os = "linux")]
fn temp_mount_is_noexec(root: &Path) -> bool {
    let Ok(mounts) = fs::read_to_string("/proc/self/mounts") else {
        return false;
    };
    let mut best: Option<(usize, bool)> = None;
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(_device), Some(point), Some(_fstype), Some(options)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let point = PathBuf::from(point.replace("\\040", " "));
        if !root.starts_with(&point) {
            continue;
        }
        let noexec = options.split(',').any(|option| option == "noexec");
        let depth = point.components().count();
        if best.map_or(true, |(current, _)| depth > current) {
            best = Some((depth, noexec));
        }
    }
    best.map_or(false, |(_, noexec)| noexec)
}

#[cfg(target_os = "linux")]
fn http_request(
    host: &str,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, String)> {
    let mut stream = TcpStream::connect(host).with_context(|| format!("dial {host}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_write_timeout(Some(Duration::from_secs(20)))?;
    let body = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(bearer) = bearer {
        request.push_str(&format!("Authorization: Bearer {bearer}\r\n"));
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
    let head = text
        .split_once("\r\n\r\n")
        .map(|(head, _)| head)
        .unwrap_or(&text);
    let raw = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    Ok((status, decode_http_body(head, &raw)))
}

#[cfg(target_os = "linux")]
fn decode_http_body(head: &str, raw: &str) -> String {
    if !head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        return raw.to_owned();
    }
    let mut rest = raw;
    let mut out = String::new();
    loop {
        let Some((size, after)) = rest.split_once("\r\n") else {
            break;
        };
        let size = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16)
            .unwrap_or(0);
        if size == 0 {
            break;
        }
        if after.len() < size {
            out.push_str(after);
            break;
        }
        out.push_str(&after[..size]);
        rest = after.get(size + 2..).unwrap_or("");
    }
    out
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
