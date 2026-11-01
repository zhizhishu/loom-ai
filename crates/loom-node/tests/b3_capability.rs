//! B3: refuse an unreported CLI before launch, and keep the last CLI report
//! (with its report time) after the node goes offline or stops repeating a path.

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
    if std::env::var("LOOM_B3_ROLE").ok().as_deref() == Some("server") {
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
        eprintln!("B3 acceptance runs on Linux");
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = acceptance() {
        eprintln!("B3 acceptance failed: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn acceptance() -> Result<()> {
    let root = std::env::temp_dir().join(format!(
        "loom-b3-{}-{}",
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
    let bin = root.join("bin");
    let empty_bin = root.join("empty-bin");
    let work = root.join("work");
    let ui = root.join("ui");
    let spawn_log = root.join("spawn.log");
    let claude_marker = root.join("claude-ran");
    fs::create_dir_all(&bin)?;
    fs::create_dir_all(&empty_bin)?;
    fs::write(
        empty_bin.join("pi"),
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo b3-pi; exit 0; fi\nexit 0\n",
    )?;
    fs::create_dir_all(&work)?;
    fs::create_dir_all(&ui)?;
    fs::write(
        ui.join("index.html"),
        "<!doctype html><title>loom-b3</title>\n",
    )?;
    fs::write(
        bin.join("codex"),
        format!(
            "#!/usr/bin/python3\nimport sys\nif \"--version\" in sys.argv:\n    print(\"b3-codex 0\")\n    raise SystemExit(0)\nwith open({path}, \"a\", encoding=\"utf-8\") as handle:\n    handle.write(\"spawn\\n\")\nprint(\"LOOM_B3_OK\")\n",
            path = serde_json::to_string(&spawn_log.display().to_string())?
        ),
    )?;
    fs::write(
        root.join("claude"),
        format!("#!/bin/sh\nprintf ran >> {}\n", shell_quote(&claude_marker)),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(bin.join("codex"), fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(empty_bin.join("pi"), fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(root.join("claude"), fs::Permissions::from_mode(0o755))?;
    }

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
    let connect = origin
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1)
        + "/api/v1/nodes/connect";
    let host = origin
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_owned();
    let mut session = login(&host, &a)?;

    let code = pair_code(&a)?;
    let node_err = root.join("node.stderr");
    processes.node = Some(spawn_node(&b, &bin, &connect, Some(&code), &node_err)?);
    wait_remote_online(&host, &a, &mut session, Duration::from_secs(30))?;

    let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    let remote = node_with_role(&listed, "remote")?;
    let codex = cli_named(remote, "codex-cli")?;
    let reported_at = codex["reportedAt"]
        .as_str()
        .context("reportedAt")?
        .to_owned();
    let reported_path = codex["path"].as_str().context("path")?.to_owned();
    if reported_at.len() < 10 || reported_path.contains("path_missing") {
        bail!("online CLI report is missing its time or path: {codex}");
    }
    if codex["availability"] != "reported" || codex["pathPresent"] != true {
        bail!("online codex report was not a fresh present path: {codex}");
    }
    if remote["clis"].as_array().is_some_and(|clis| {
        clis.iter()
            .any(|cli| cli["adapterKind"] == "claude-code-cli")
    }) {
        bail!("node reported claude-code-cli without the binary on PATH: {remote}");
    }
    let listed_cli = node_list(&a)?;
    if !listed_cli.contains(&reported_at) || !listed_cli.contains(&reported_path) {
        bail!("node-list did not surface the last CLI report: {listed_cli}");
    }
    assert_local_host_unchanged(&a, &listed)?;

    let started = Instant::now();
    let refused = run_exec(
        &a,
        "claude-code-cli",
        &work,
        &["-p", "say hello"],
        &root.join("claude.stdout"),
        &root.join("claude.stderr"),
        Duration::from_secs(8),
    )?;
    if refused.status.success() || started.elapsed() >= Duration::from_secs(8) {
        bail!(
            "unreported claude-code-cli was not refused before NODE_WAIT ({:?}): {}",
            started.elapsed(),
            String::from_utf8_lossy(&refused.stderr)
        );
    }
    let refusal = String::from_utf8_lossy(&refused.stderr);
    if !refusal.contains("node_cli_unreported") {
        bail!("unreported CLI error was {refusal}");
    }
    if claude_marker.exists() || spawn_count(&spawn_log)? != 0 {
        bail!(
            "refused launch still started a process; claude marker {}, spawn log {}",
            claude_marker.exists(),
            fs::read_to_string(&spawn_log).unwrap_or_default()
        );
    }
    let runs = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    if node_with_role(&runs, "remote")?["activeRunCount"] != 0 {
        bail!("refused launch left an active run: {runs}");
    }

    let codex_run = run_exec(
        &a,
        "codex-cli",
        &work,
        &["exec", "--skip-git-repo-check", "ok"],
        &root.join("codex.stdout"),
        &root.join("codex.stderr"),
        Duration::from_secs(30),
    )?;
    if !codex_run.status.success() {
        bail!(
            "reported codex-cli failed: {}\n{}",
            String::from_utf8_lossy(&codex_run.stdout),
            String::from_utf8_lossy(&codex_run.stderr)
        );
    }
    let stdout = String::from_utf8_lossy(&codex_run.stdout);
    if !stdout.contains("LOOM_B3_OK") {
        bail!("reported CLI stdout was {stdout}");
    }
    if spawn_count(&spawn_log)? != 1 {
        bail!(
            "reported CLI did not run exactly once: {}",
            fs::read_to_string(&spawn_log).unwrap_or_default()
        );
    }
    assert_local_host_unchanged(
        &a,
        &api_json("GET", &host, "/api/v1/nodes", &session, None)?,
    )?;

    if let Some(mut node) = processes.node.take() {
        let _ = node.kill();
        let _ = node.wait();
    }
    let node_err_2 = root.join("node-empty.stderr");
    processes.node = Some(spawn_node(&b, &empty_bin, &connect, None, &node_err_2)?);
    wait_remote_reported_pi(&host, &a, &mut session, Duration::from_secs(20))?;
    let relisted = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    let kept = cli_named(node_with_role(&relisted, "remote")?, "codex-cli")?;
    if kept["path"] != reported_path
        || kept["reportedAt"] != reported_at
        || kept["pathPresent"] != true
        || kept["availability"] != "last_seen"
        || kept["path"].as_str().unwrap_or("").contains("path_missing")
    {
        bail!("omitted path was not kept as last-seen: {kept}");
    }
    let started = Instant::now();
    let refused_codex = run_exec(
        &a,
        "codex-cli",
        &work,
        &["exec", "again"],
        &root.join("codex2.stdout"),
        &root.join("codex2.stderr"),
        Duration::from_secs(8),
    )?;
    if refused_codex.status.success() || started.elapsed() >= Duration::from_secs(8) {
        bail!(
            "codex omitted from the latest hello was not refused quickly: {}",
            String::from_utf8_lossy(&refused_codex.stderr)
        );
    }
    if !String::from_utf8_lossy(&refused_codex.stderr).contains("node_cli_unreported") {
        bail!(
            "omitted CLI error was {}",
            String::from_utf8_lossy(&refused_codex.stderr)
        );
    }
    if spawn_count(&spawn_log)? != 1 || claude_marker.exists() {
        bail!("omitted CLI refusal started another process");
    }

    let killed = Instant::now();
    if let Some(mut node) = processes.node.take() {
        let _ = node.kill();
        let _ = node.wait();
    }
    let mut offline = false;
    while killed.elapsed() < Duration::from_secs(45) {
        let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
        let remote = node_with_role(&listed, "remote")?;
        if remote["status"] == "offline" {
            offline = true;
            let cli = cli_named(remote, "codex-cli")?;
            if cli["path"] != reported_path
                || cli["reportedAt"] != reported_at
                || cli["pathPresent"] != true
                || cli["availability"] != "last_seen"
            {
                bail!("offline node rewrote the last CLI report: {cli}");
            }
            let printed = node_list(&a)?;
            if !printed.contains(&reported_at) || !printed.contains("last_seen") {
                bail!("node-list dropped the offline report: {printed}");
            }
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    if !offline {
        bail!("node was still online 45s after the process exited");
    }
    assert_local_host_unchanged(
        &a,
        &api_json("GET", &host, "/api/v1/nodes", &session, None)?,
    )?;
    processes.stop();
    Ok(())
}

#[cfg(target_os = "linux")]
fn assert_local_host_unchanged(data_dir: &Path, listed: &serde_json::Value) -> Result<()> {
    let local_id = node_with_role(listed, "local")?["nodeId"]
        .as_str()
        .context("local node id")?
        .to_owned();
    if node_with_role(listed, "local")?["role"] != "local" {
        bail!("local node role changed: {listed}");
    }
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
host = con.execute("select id from mission_execution_host where singleton=1").fetchone()
rows = con.execute("select node_id, role from execution_node").fetchall()
print(host[0] if host else "")
for node_id, role in rows:
    print(f"{node_id}\t{role}")
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .output()
        .context("could not read the execution host")?;
    if !output.status.success() {
        bail!(
            "sqlite read failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let text = String::from_utf8(output.stdout)?;
    let mut lines = text.lines();
    let host = lines.next().unwrap_or("");
    if host != local_id {
        bail!("remote pairing changed the mission execution host ({host} != {local_id})");
    }
    let mut locals = 0;
    for line in lines {
        let Some((node_id, role)) = line.split_once('\t') else {
            continue;
        };
        if role == "local" {
            locals += 1;
            if node_id != host {
                bail!("local execution node {node_id} is not the mission host {host}");
            }
        } else if role != "remote" {
            bail!("unexpected node role {role}");
        }
    }
    if locals != 1 {
        bail!("expected one local execution node, found {locals}");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
struct ExecOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[cfg(target_os = "linux")]
fn run_exec(
    data_dir: &Path,
    runtime: &str,
    cwd: &Path,
    args: &[&str],
    stdout_path: &Path,
    stderr_path: &Path,
    limit: Duration,
) -> Result<ExecOutput> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .env("LOOM_B3_ROLE", "server")
        .args(["node-exec", "--data-dir"])
        .arg(data_dir)
        .args(["--runtime", runtime, "--cwd"])
        .arg(cwd)
        .arg("--");
    command.args(args);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(fs::File::create(stdout_path)?))
        .stderr(Stdio::from(fs::File::create(stderr_path)?))
        .spawn()
        .context("node-exec failed to start")?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            break Command::new("false").status()?;
        }
        thread::sleep(Duration::from_millis(50));
    };
    Ok(ExecOutput {
        status,
        stdout: fs::read(stdout_path).unwrap_or_default(),
        stderr: fs::read(stderr_path).unwrap_or_default(),
    })
}

#[cfg(target_os = "linux")]
fn node_list(data_dir: &Path) -> Result<String> {
    let output = Command::new(std::env::current_exe()?)
        .env("LOOM_B3_ROLE", "server")
        .args(["node-list", "--data-dir"])
        .arg(data_dir)
        .output()
        .context("node-list failed to start")?;
    if !output.status.success() {
        bail!(
            "node-list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout)?)
}

#[cfg(target_os = "linux")]
fn cli_named<'a>(node: &'a serde_json::Value, kind: &str) -> Result<&'a serde_json::Value> {
    node["clis"]
        .as_array()
        .context("clis")?
        .iter()
        .find(|cli| cli["adapterKind"] == kind)
        .with_context(|| format!("no {kind} in {node}"))
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
        .env("LOOM_B3_ROLE", "server")
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
        .env("PATH", bin)
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
        .env("LOOM_B3_ROLE", "server")
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
    bail!("remote node did not come online with codex-cli")
}

#[cfg(target_os = "linux")]
fn wait_remote_reported_pi(
    host: &str,
    data_dir: &Path,
    session: &mut String,
    limit: Duration,
) -> Result<()> {
    let started = Instant::now();
    let mut last = String::new();
    while started.elapsed() < limit {
        if let Ok(list) = api_json("GET", host, "/api/v1/nodes", session, None) {
            last = list.to_string();
            if let Ok(remote) = node_with_role(&list, "remote")
                && remote["status"] == "online"
                && remote["clis"].as_array().is_some_and(|clis| {
                    let pi = clis
                        .iter()
                        .any(|cli| cli["adapterKind"] == "pi" && cli["availability"] == "reported");
                    let codex = clis.iter().any(|cli| {
                        cli["adapterKind"] == "codex-cli" && cli["availability"] == "last_seen"
                    });
                    pi && codex
                })
            {
                return Ok(());
            }
        } else {
            *session = login(host, data_dir)?;
        }
        thread::sleep(Duration::from_millis(200));
    }
    bail!("remote node did not report pi while keeping codex last-seen; last: {last}")
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
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
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
