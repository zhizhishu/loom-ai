//! B6: a workspace owner gets the worktree, and A reads that disk.
//! `../`, an absolute path outside the root, and a symlink that leaves the
//! root are refused. An offline owner lists as 「不在线」, not an empty directory.

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
    if std::env::var("LOOM_B6_ROLE").ok().as_deref() == Some("server") {
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
        eprintln!("B6 acceptance runs on Linux");
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = acceptance() {
        eprintln!("B6 acceptance failed: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn acceptance() -> Result<()> {
    let root = std::env::temp_dir().join(format!(
        "loom-b6-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let _cleanup = RemoveDir(root.clone());
    fs::create_dir_all(&root)?;
    let a = root.join("a");
    let b = root.join("b");
    let repo = b.join("repo");
    let node_dir = b.join("node");
    let outside = root.join("outside");
    let ui = root.join("ui");
    fs::create_dir_all(&repo)?;
    fs::create_dir_all(&node_dir)?;
    fs::create_dir_all(&outside)?;
    fs::create_dir_all(&ui)?;
    fs::write(
        ui.join("index.html"),
        "<!doctype html><title>loom-b6</title>\n",
    )?;
    fs::write(outside.join("secret.txt"), b"secret-outside\n")?;
    fs::write(repo.join("hello.txt"), b"from-b\n")?;
    git(&repo, &["init"])?;
    git(&repo, &["config", "user.email", "b6@example.com"])?;
    git(&repo, &["config", "user.name", "b6"])?;
    git(&repo, &["add", "hello.txt"])?;
    git(&repo, &["commit", "-m", "init"])?;

    let listen = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = probe.local_addr()?.port();
        drop(probe);
        format!("127.0.0.1:{port}")
    };
    let server_err = root.join("server.stderr");
    let mut processes = Processes::default();
    processes.server = Some(spawn_server(
        &a,
        &ui,
        &listen,
        &root.join("server.stdout"),
        &server_err,
    )?);
    let origin = wait_listener(&a, &mut processes, &server_err, Duration::from_secs(180))?;
    let connect = origin.replacen("http://", "ws://", 1) + "/api/v1/nodes/connect";
    let host = origin.trim_start_matches("http://").to_owned();
    let mut session = login(&host, &a)?;
    let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    let local_id = node_with_role(&listed, "local")?["nodeId"]
        .as_str()
        .context("local node id")?
        .to_owned();

    let conflict = Command::new(std::env::current_exe()?)
        .env("LOOM_B6_ROLE", "server")
        .args([
            "node-exec",
            "--data-dir",
            a.to_str().unwrap(),
            "--task",
            "task_b6",
            "--mission",
            "mission_b6",
            "--runtime",
            "codex-cli",
            "--cwd",
            "/tmp",
            "--",
            "exec",
        ])
        .output()
        .context("node-exec conflict failed to start")?;
    let conflict_text = format!(
        "{}{}",
        String::from_utf8_lossy(&conflict.stdout),
        String::from_utf8_lossy(&conflict.stderr)
    );
    if conflict.status.success() || !conflict_text.contains("（task_scope_conflict）") {
        bail!("node-exec --task ignored --mission: {conflict_text}");
    }

    let code = pair_code(&a)?;
    let node_err = root.join("node.stderr");
    processes.node = Some(spawn_node(&node_dir, &connect, Some(&code), &node_err)?);
    wait_remote_online(&host, &a, &mut session, Duration::from_secs(30))?;
    let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    let remote_id = node_with_role(&listed, "remote")?["nodeId"]
        .as_str()
        .context("remote node id")?
        .to_owned();

    let prepared = workspace_prepare(&a, &repo, &remote_id)?;
    let worktree = PathBuf::from(prepared["worktree"].as_str().context("worktree")?);
    if !worktree.starts_with(&node_dir) {
        bail!("worktree {} was not created on B", worktree.display());
    }
    if !worktree.join("hello.txt").is_file() {
        bail!("worktree is missing the file from B's repository");
    }
    fs::write(worktree.join("extra.txt"), b"extra-on-b\n")?;
    std::os::unix::fs::symlink(outside.join("secret.txt"), worktree.join("leak")).unwrap();
    assert_workspace_owner(&a, &remote_id, &worktree)?;
    assert_local_host_unchanged(&a, &local_id)?;

    let listed_files = workspace_files(&a, "list", "")?;
    if !listed_files.status.success() {
        bail!(
            "list failed: {}",
            String::from_utf8_lossy(&listed_files.stderr)
        );
    }
    let list_text = String::from_utf8(listed_files.stdout)?;
    if !list_text.contains("hello.txt") || !list_text.contains("extra.txt") {
        bail!("list did not see B's files: {list_text}");
    }
    if list_text.contains("leak") || list_text.contains("secret") {
        bail!("list included a symlink that leaves the root: {list_text}");
    }
    let read = workspace_files(&a, "read", "extra.txt")?;
    if String::from_utf8(read.stdout.clone())? != "extra-on-b\n" || !read.status.success() {
        bail!(
            "read did not match B's disk: {} {}",
            String::from_utf8_lossy(&read.stdout),
            String::from_utf8_lossy(&read.stderr)
        );
    }

    let mut big = vec![b'x'; 1024 * 1024 + 8];
    big.extend_from_slice(b"TAIL");
    fs::write(worktree.join("big.bin"), &big)?;
    let big_read = workspace_files(&a, "read", "big.bin")?;
    if big_read.stdout.len() != 1024 * 1024
        || big_read.stdout.windows(4).any(|window| window == b"TAIL")
        || !String::from_utf8_lossy(&big_read.stderr).contains("truncated")
    {
        bail!(
            "read was not capped at 1 MiB ({} bytes, stderr {})",
            big_read.stdout.len(),
            String::from_utf8_lossy(&big_read.stderr)
        );
    }

    for relative in ["../outside/secret.txt", "/etc/passwd", "leak"] {
        let refused = workspace_files(&a, "read", relative)?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&refused.stdout),
            String::from_utf8_lossy(&refused.stderr)
        );
        if refused.status.success()
            || !text.contains("（path_rejected）")
            || text.contains("secret-outside")
        {
            bail!("path {relative} was not rejected: {text}");
        }
    }

    if let Some(mut node) = processes.node.take() {
        let _ = node.kill();
        let _ = node.wait();
    }
    thread::sleep(Duration::from_millis(300));
    let escaped = workspace_files(&a, "read", "../outside/secret.txt")?;
    let escaped_text = format!(
        "{}{}",
        String::from_utf8_lossy(&escaped.stdout),
        String::from_utf8_lossy(&escaped.stderr)
    );
    if !escaped_text.contains("（path_rejected）") || escaped_text.contains("不在线") {
        bail!("A accepted or mislabeled an offline escape: {escaped_text}");
    }
    let offline = workspace_files(&a, "list", "")?;
    let offline_text = format!(
        "{}{}",
        String::from_utf8_lossy(&offline.stdout),
        String::from_utf8_lossy(&offline.stderr)
    );
    if offline.status.success() || !offline_text.contains("不在线") {
        bail!("offline list was not 「不在线」: {offline_text}");
    }
    if offline.stdout.iter().any(|byte| *byte == b'h') {
        bail!(
            "offline list returned names: {}",
            String::from_utf8_lossy(&offline.stdout)
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn git(repo: &Path, args: &[&str]) -> Result<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .context("git failed to start")?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn workspace_prepare(data_dir: &Path, source: &Path, node_id: &str) -> Result<serde_json::Value> {
    let output = Command::new(std::env::current_exe()?)
        .env("LOOM_B6_ROLE", "server")
        .args([
            "workspace-prepare",
            "--data-dir",
            data_dir.to_str().unwrap(),
            "--mission",
            "mission_b6",
            "--camp",
            "camp_b6",
            "--node",
            node_id,
            "--source",
            source.to_str().unwrap(),
        ])
        .output()
        .context("workspace-prepare failed to start")?;
    if !output.status.success() {
        bail!(
            "workspace-prepare failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    serde_json::from_slice(&output.stdout).context("workspace-prepare was not JSON")
}

#[cfg(target_os = "linux")]
fn workspace_files(data_dir: &Path, op: &str, relative: &str) -> Result<std::process::Output> {
    Command::new(std::env::current_exe()?)
        .env("LOOM_B6_ROLE", "server")
        .args([
            "workspace-files",
            "--data-dir",
            data_dir.to_str().unwrap(),
            "--mission",
            "mission_b6",
            op,
            relative,
        ])
        .output()
        .context("workspace-files failed to start")
}

#[cfg(target_os = "linux")]
fn assert_workspace_owner(data_dir: &Path, node_id: &str, worktree: &Path) -> Result<()> {
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
row = con.execute("SELECT execution_host_id, worktree_path FROM mission_workspace WHERE mission_id=?", (sys.argv[2],)).fetchone()
print("" if row is None else row[0] + "\n" + row[1])
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .arg("mission_b6")
        .output()
        .context("could not read the workspace")?;
    let text = String::from_utf8(output.stdout)?;
    let mut lines = text.lines();
    let host = lines.next().unwrap_or("");
    let path = lines.next().unwrap_or("");
    if host != node_id || path != worktree.to_str().unwrap_or("") {
        bail!("workspace owner row was {text}");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn assert_local_host_unchanged(data_dir: &Path, local_id: &str) -> Result<()> {
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
host = con.execute("select id from mission_execution_host where singleton=1").fetchone()
print(host[0] if host else "")
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .output()
        .context("could not read the execution host")?;
    let host = String::from_utf8(output.stdout)?.trim().to_owned();
    if host != local_id {
        bail!("mission execution host changed ({host} != {local_id})");
    }
    Ok(())
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
        .env("LOOM_B6_ROLE", "server")
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
    connect: &str,
    pair_code: Option<&str>,
    stderr: &Path,
) -> Result<std::process::Child> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_loom-node"));
    command
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
        .env("LOOM_B6_ROLE", "server")
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
    let admin = rovai_web::stored_administrator_token(data_dir)?.context("administrator token")?;
    let body = serde_json::json!({
        "protocolVersion": rovai_web::HOST_WEB_PROTOCOL_VERSION,
        "administratorToken": admin,
    })
    .to_string();
    let (status, text) = request("POST", host, "/api/v1/login", None, Some(&body))?;
    if status != 200 {
        bail!("login failed ({status}): {text}");
    }
    let value: serde_json::Value = serde_json::from_str(&text)?;
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
    bearer: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, String)> {
    let mut stream = TcpStream::connect(host)?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
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
    let _ = stream.read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse::<u16>()
        .unwrap_or(0);
    let raw = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    Ok((status, raw))
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
#[derive(Default)]
struct Processes {
    server: Option<std::process::Child>,
    node: Option<std::process::Child>,
}

#[cfg(target_os = "linux")]
impl Drop for Processes {
    fn drop(&mut self) {
        if let Some(mut node) = self.node.take() {
            let _ = node.kill();
            let _ = node.wait();
        }
        if let Some(mut server) = self.server.take() {
            let _ = server.kill();
            let _ = server.wait();
        }
    }
}

struct RemoveDir(PathBuf);

impl Drop for RemoveDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
