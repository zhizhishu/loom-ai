//! B4: a run on B calls `rovai loom status` through a shim, and the answer is
//! read from A's database. The shim credential is not an administrator token
//! or the node token, and it stops working when the run ends or the node is
//! revoked.

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
    if std::env::var("LOOM_B4_ROLE").ok().as_deref() == Some("server") {
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
        eprintln!("B4 acceptance runs on Linux");
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = acceptance() {
        eprintln!("B4 acceptance failed: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn acceptance() -> Result<()> {
    let root = std::env::temp_dir().join(format!(
        "loom-b4-{}-{}",
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
    let work = root.join("work");
    let ui = root.join("ui");
    let capture = root.join("token.txt");
    let env_dump = root.join("env.txt");
    let which_dump = root.join("which.txt");
    fs::create_dir_all(&bin)?;
    fs::create_dir_all(&work)?;
    fs::create_dir_all(&ui)?;
    fs::write(
        ui.join("index.html"),
        "<!doctype html><title>loom-b4</title>\n",
    )?;
    fs::write(
        bin.join("codex"),
        r#"#!/usr/bin/python3
import json, os, pathlib, shutil, sys, time
if "--version" in sys.argv:
    print("b4-codex 0")
    raise SystemExit(0)
rovai = shutil.which("rovai")
if not rovai:
    sys.stderr.write("NO_SHIM\n")
    raise SystemExit(9)
cred = json.loads(pathlib.Path(rovai).resolve().parent.parent.joinpath("credential").read_text())
token = cred["token"]
capture = os.environ.get("B4_CAPTURE")
if capture:
    pathlib.Path(capture).write_text(token)
env_path = os.environ.get("B4_ENV")
if env_path:
    lines = [f"{key}={value}" for key, value in sorted(os.environ.items())]
    pathlib.Path(env_path).write_text("\n".join(lines))
which_path = os.environ.get("B4_WHICH")
if which_path:
    pathlib.Path(which_path).write_text(rovai + "\n" + os.environ.get("PATH", ""))
if "sleep" in sys.argv:
    time.sleep(45)
    raise SystemExit(0)
os.execvp(rovai, ["rovai", "loom", "status"])
"#,
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
    seed_plan(&a)?;
    let mut session = login(&host, &a)?;
    let admin = rovai_web::stored_administrator_token(&a)?.context("administrator token")?;

    let code = pair_code(&a)?;
    let node_err = root.join("node.stderr");
    processes.node = Some(spawn_node(
        &b,
        &bin,
        &connect,
        Some(&code),
        &node_err,
        &capture,
        &env_dump,
        &which_dump,
    )?);
    let node_pid = processes
        .node
        .as_ref()
        .map(|child| child.id())
        .context("node pid")?;
    wait_remote_online(&host, &a, &mut session, Duration::from_secs(30))?;
    let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    assert_local_host_unchanged(&a, &listed)?;
    let node_id = node_with_role(&listed, "remote")?["nodeId"]
        .as_str()
        .context("remote node id")?
        .to_owned();
    let node_token = node_token(&b)?;

    let admin_call = shim_call(&host, &admin, &["loom", "status"])?;
    if admin_call.status != 403 || !admin_call.body.contains("administrator_rejected") {
        bail!(
            "administrator token was not rejected: {} {}",
            admin_call.status,
            admin_call.body
        );
    }
    let node_call = shim_call(&host, &node_token, &["loom", "status"])?;
    if node_call.status != 403 || !node_call.body.contains("node_token_rejected") {
        bail!(
            "node token was not rejected by the shim path: {} {}",
            node_call.status,
            node_call.body
        );
    }

    let status_body = serde_json::json!({
        "runtime": "codex-cli",
        "cwd": work.display().to_string(),
        "args": ["exec", "status"],
        "missionId": "mission_b4",
        "memberId": "member_b4",
    })
    .to_string();
    let status = api_json_timeout(
        "POST",
        &host,
        "/api/v1/nodes/exec",
        &session,
        Some(&status_body),
        Duration::from_secs(40),
    )?;
    if status["exitCode"] != 0 {
        bail!(
            "shimmed status run failed: {}",
            decode_b64(status["stderr"].as_str().unwrap_or(""))?
        );
    }
    let stdout = decode_b64(status["stdout"].as_str().context("stdout")?)?;
    if !stdout.contains("LOOM_B4_GOAL_FROM_A") || !stdout.contains("mission_b4") {
        bail!("rovai loom status did not read A's plan: {stdout}");
    }
    let run_token = fs::read_to_string(&capture).context("status run did not capture a token")?;
    let env_text =
        fs::read_to_string(&env_dump).context("status run did not dump its environment")?;
    if env_text.contains(node_token.trim()) || env_text.contains(run_token.trim()) {
        bail!("child environment contained the node token or the run token");
    }
    let which = fs::read_to_string(&which_dump)?;
    let shim_path = which.lines().next().unwrap_or("");
    if !shim_path.contains(&b.display().to_string()) || !shim_path.ends_with("/rovai") {
        bail!("rovai on the child PATH was not the shim: {which}");
    }
    let path_line = which.lines().nth(1).unwrap_or("");
    let shim_dir = Path::new(shim_path)
        .parent()
        .context("shim dir")?
        .display()
        .to_string();
    if !path_line.starts_with(&shim_dir) {
        bail!("shim directory was not first on PATH: {path_line}");
    }
    if is_listening(node_pid) {
        bail!("loom-node is listening: {}", describe_sockets(node_pid));
    }
    let expired = shim_call(&host, run_token.trim(), &["loom", "status"])?;
    if expired.status != 401 || !expired.body.contains("shim_token_invalid") {
        bail!(
            "run token still worked after the run ended: {} {}",
            expired.status,
            expired.body
        );
    }
    assert_credential_row(&a, "member_b4", "mission_b4", &run_token)?;
    if contains_sqlite(&b) {
        bail!("node data directory contains a product database");
    }

    let _ = fs::remove_file(&capture);
    let sleep_body = serde_json::json!({
        "runtime": "codex-cli",
        "cwd": work.display().to_string(),
        "args": ["exec", "sleep"],
        "missionId": "mission_b4",
        "memberId": "member_b4",
    })
    .to_string();
    let host_for_sleep = host.clone();
    let session_for_sleep = session.clone();
    let sleeper = thread::spawn(move || {
        api_json_timeout(
            "POST",
            &host_for_sleep,
            "/api/v1/nodes/exec",
            &session_for_sleep,
            Some(&sleep_body),
            Duration::from_secs(50),
        )
    });
    let started = Instant::now();
    let mut live_token = String::new();
    while started.elapsed() < Duration::from_secs(20) {
        if let Ok(text) = fs::read_to_string(&capture)
            && text.trim() != run_token.trim()
            && text.trim().len() == 64
        {
            live_token = text.trim().to_owned();
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if live_token.is_empty() {
        bail!(
            "sleeping run did not publish a shim token\n{}",
            fs::read_to_string(&node_err).unwrap_or_default()
        );
    }
    let live = shim_call(&host, &live_token, &["loom", "status"])?;
    if live.status != 200 || !live.body.contains("LOOM_B4_GOAL_FROM_A") {
        bail!(
            "live shim token did not read A's plan: {} {}",
            live.status,
            live.body
        );
    }
    let denied = shim_call(&host, &live_token, &["loom", "plan"])?;
    if denied.status != 403 || !denied.body.contains("shim_operation_denied") {
        bail!(
            "shim accepted a command outside loom status: {} {}",
            denied.status,
            denied.body
        );
    }
    if is_listening(node_pid) {
        bail!("loom-node listened while the shim was in use");
    }
    let revoke = api_json(
        "POST",
        &host,
        &format!("/api/v1/nodes/{node_id}/revoke"),
        &session,
        Some("{}"),
    )?;
    if revoke["status"] != "offline" {
        bail!("revoke did not mark the node offline: {revoke}");
    }
    let revoked = shim_call(&host, &live_token, &["loom", "status"])?;
    if revoked.status != 401 || !revoked.body.contains("shim_token_invalid") {
        bail!(
            "run token still worked after the node was revoked: {} {}",
            revoked.status,
            revoked.body
        );
    }
    let _ = sleeper.join();
    assert_local_host_unchanged(
        &a,
        &api_json("GET", &host, "/api/v1/nodes", &session, None)?,
    )?;
    if contains_sqlite(&b) {
        bail!("node data directory contains a product database after revoke");
    }
    processes.stop();
    Ok(())
}

#[cfg(target_os = "linux")]
fn seed_plan(data_dir: &Path) -> Result<()> {
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA busy_timeout=5000")
con.execute("PRAGMA foreign_keys=OFF")
con.execute(
    "INSERT INTO loom_plan(plan_id, mission_id, goal, acceptance_criteria_json, acceptance_criteria_version, created_at, revision) VALUES ('plan_b4', 'mission_b4', 'LOOM_B4_GOAL_FROM_A', '[]', 'ac-v1', '2026-11-01T00:00:00.000Z', 1)"
)
con.commit()
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .output()
        .context("could not seed A's plan")?;
    if !output.status.success() {
        bail!(
            "seeding A's plan failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn assert_credential_row(data_dir: &Path, member: &str, mission: &str, token: &str) -> Result<()> {
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
rows = con.execute(
    "SELECT member_id, mission_id, revoked_at IS NOT NULL, token_digest FROM node_run_credential"
).fetchall()
for member_id, mission_id, revoked, digest in rows:
    print(f"{member_id}\t{mission_id}\t{int(revoked)}\t{digest}")
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .output()
        .context("could not read shim credentials")?;
    if !output.status.success() {
        bail!(
            "credential read failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let text = String::from_utf8(output.stdout)?;
    let wanted = text.lines().find(|line| line.starts_with(member));
    let Some(line) = wanted else {
        bail!("no shim credential for {member}: {text}");
    };
    let mut parts = line.split('\t');
    let got_member = parts.next().unwrap_or("");
    let got_mission = parts.next().unwrap_or("");
    let revoked = parts.next().unwrap_or("");
    let digest = parts.next().unwrap_or("");
    if got_member != member || got_mission != mission || revoked != "1" || digest.len() != 64 {
        bail!("shim credential was not scoped and revoked: {line}");
    }
    let bytes = fs::read(data_dir.join("rovai.sqlite"))?;
    if bytes
        .windows(token.trim().len())
        .any(|window| window == token.trim().as_bytes())
    {
        bail!("A's database stored the shim token in plaintext");
    }
    Ok(())
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
fn decode_b64(value: &str) -> Result<String> {
    let bytes = STANDARD
        .decode(value)
        .context("run output was not base64")?;
    Ok(String::from_utf8(bytes)?)
}

#[cfg(target_os = "linux")]
struct HttpReply {
    status: u16,
    body: String,
}

#[cfg(target_os = "linux")]
fn shim_call(host: &str, token: &str, args: &[&str]) -> Result<HttpReply> {
    let body = serde_json::json!({ "args": args }).to_string();
    let (status, text) = request(
        "POST",
        host,
        "/api/v1/nodes/shim",
        Some(token),
        Some(&body),
        Duration::from_secs(20),
    )?;
    Ok(HttpReply { status, body: text })
}

#[cfg(target_os = "linux")]
fn assert_local_host_unchanged(data_dir: &Path, listed: &serde_json::Value) -> Result<()> {
    let local_id = node_with_role(listed, "local")?["nodeId"]
        .as_str()
        .context("local node id")?
        .to_owned();
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
host = con.execute("select id from mission_execution_host where singleton=1").fetchone()
print(host[0] if host else "")
for node_id, role in con.execute("select node_id, role from execution_node"):
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
        }
    }
    if locals != 1 {
        bail!("expected one local execution node, found {locals}");
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
        .env("LOOM_B4_ROLE", "server")
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
    capture: &Path,
    env_dump: &Path,
    which_dump: &Path,
) -> Result<std::process::Child> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_loom-node"));
    command
        .env("PATH", bin)
        .env("B4_CAPTURE", capture)
        .env("B4_ENV", env_dump)
        .env("B4_WHICH", which_dump)
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
        .env("LOOM_B4_ROLE", "server")
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
    let (status, text) = request(
        "POST",
        host,
        "/api/v1/login",
        None,
        Some(&body),
        Duration::from_secs(20),
    )?;
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
    api_json_timeout(method, host, path, session, body, Duration::from_secs(20))
}

#[cfg(target_os = "linux")]
fn api_json_timeout(
    method: &str,
    host: &str,
    path: &str,
    session: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<serde_json::Value> {
    let (status, text) = request(method, host, path, Some(session), body, timeout)?;
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
    timeout: Duration,
) -> Result<(u16, String)> {
    let mut stream = TcpStream::connect(host).with_context(|| format!("dial {host}"))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
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
    Ok((status, decode_body(&text, &raw)))
}

#[cfg(target_os = "linux")]
fn decode_body(headers: &str, raw: &str) -> String {
    let head = headers
        .split_once("\r\n\r\n")
        .map(|(head, _)| head)
        .unwrap_or(headers);
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    if !chunked {
        return raw.to_owned();
    }
    let mut rest = raw;
    let mut out = String::new();
    loop {
        let Some((size, after)) = rest.split_once("\r\n") else {
            break;
        };
        let size =
            usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
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
