//! B5: one mission, two tasks. The local node runs through ManagedProcess on A.
//! The other task runs on the outbound node. Moving the local task's
//! execution_host_id onto B moves the process onto B.

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
    if std::env::var("LOOM_B5_ROLE").ok().as_deref() == Some("server") {
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
        eprintln!("B5 acceptance runs on Linux");
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = acceptance() {
        eprintln!("B5 acceptance failed: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn acceptance() -> Result<()> {
    let root = std::env::temp_dir().join(format!(
        "loom-b5-{}-{}",
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
    let a_bin = root.join("a-bin");
    let b_bin = root.join("b-bin");
    let work = root.join("work");
    let ui = root.join("ui");
    let a_spawn = root.join("a-spawn");
    let b_spawn = root.join("b-spawn");
    fs::create_dir_all(&a_bin)?;
    fs::create_dir_all(&b_bin)?;
    fs::create_dir_all(&work)?;
    fs::create_dir_all(&ui)?;
    fs::write(
        ui.join("index.html"),
        "<!doctype html><title>loom-b5</title>\n",
    )?;
    write_cli(&a_bin.join("codex"), &a_spawn, "LOOM_B5_LOCAL")?;
    write_cli(&b_bin.join("codex"), &b_spawn, "LOOM_B5_REMOTE")?;

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
        &a_bin,
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

    let code = pair_code(&a)?;
    let node_err = root.join("node.stderr");
    processes.node = Some(spawn_node(&b, &b_bin, &connect, Some(&code), &node_err)?);
    wait_remote_online(&host, &a, &mut session, Duration::from_secs(30))?;
    let listed = api_json("GET", &host, "/api/v1/nodes", &session, None)?;
    let remote_id = node_with_role(&listed, "remote")?["nodeId"]
        .as_str()
        .context("remote node id")?
        .to_owned();
    assert_local_host_unchanged(&a, &local_id)?;
    seed_tasks(&a, &local_id, &remote_id)?;

    let local_run = run_task(&a, &work, "task_local")?;
    if !local_run.stdout.contains("LOOM_B5_LOCAL") {
        bail!(
            "local task output was {}\n{}",
            local_run.stdout,
            local_run.stderr
        );
    }
    if spawn_count(&a_spawn)? != 1 || spawn_count(&b_spawn)? != 0 {
        bail!(
            "local task did not stay on A (a={}, b={})",
            spawn_count(&a_spawn)?,
            spawn_count(&b_spawn)?
        );
    }
    assert_dispatch_node(&a, &local_run.run_id, &local_id)?;

    let remote_run = run_task(&a, &work, "task_remote")?;
    if !remote_run.stdout.contains("LOOM_B5_REMOTE") {
        bail!(
            "remote task output was {}\n{}",
            remote_run.stdout,
            remote_run.stderr
        );
    }
    if local_run.run_id == remote_run.run_id {
        bail!("the two tasks shared a run id {}", local_run.run_id);
    }
    if spawn_count(&a_spawn)? != 1 || spawn_count(&b_spawn)? != 1 {
        bail!(
            "remote task did not run only on B (a={}, b={})",
            spawn_count(&a_spawn)?,
            spawn_count(&b_spawn)?
        );
    }
    assert_dispatch_node(&a, &remote_run.run_id, &remote_id)?;

    retarget_task(&a, "task_local", &remote_id)?;
    let moved = run_task(&a, &work, "task_local")?;
    if !moved.stdout.contains("LOOM_B5_REMOTE") {
        bail!(
            "retargeted task output was {}\n{}",
            moved.stdout,
            moved.stderr
        );
    }
    if moved.run_id == local_run.run_id || moved.run_id == remote_run.run_id {
        bail!("retargeted task reused run id {}", moved.run_id);
    }
    if spawn_count(&a_spawn)? != 1 || spawn_count(&b_spawn)? != 2 {
        bail!(
            "retargeted task did not move onto B (a={}, b={})",
            spawn_count(&a_spawn)?,
            spawn_count(&b_spawn)?
        );
    }
    assert_dispatch_node(&a, &moved.run_id, &remote_id)?;
    assert_local_host_unchanged(&a, &local_id)?;
    processes.stop();
    Ok(())
}

#[cfg(target_os = "linux")]
fn write_cli(path: &Path, spawn_log: &Path, marker: &str) -> Result<()> {
    fs::write(
        path,
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo {marker}; exit 0; fi\nprintf 'x\\n' >> {log}\nprintf '{marker}\\n'\n",
            log = shell_quote(spawn_log),
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[cfg(target_os = "linux")]
fn seed_tasks(data_dir: &Path, local_id: &str, remote_id: &str) -> Result<()> {
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA busy_timeout=5000")
con.execute("PRAGMA foreign_keys=OFF")
now = "2026-11-01T00:00:00.000Z"
con.execute(
    "INSERT INTO loom_plan(plan_id, mission_id, goal, acceptance_criteria_json, acceptance_criteria_version, created_at, revision) VALUES ('plan_b5', 'mission_b5', 'B5 two hosts', '[]', 'ac-v1', ?, 1)",
    (now,),
)
con.execute(
    "INSERT INTO loom_task(task_id, plan_id, title, description, assignee_agent_id, status, acceptance_criteria_json, created_at, updated_at, revision, execution_host_id) VALUES ('task_local', 'plan_b5', 'local half', '', NULL, 'DRAFT', '[]', ?, ?, 1, ?)",
    (now, now, sys.argv[2]),
)
con.execute(
    "INSERT INTO loom_task(task_id, plan_id, title, description, assignee_agent_id, status, acceptance_criteria_json, created_at, updated_at, revision, execution_host_id) VALUES ('task_remote', 'plan_b5', 'remote half', '', NULL, 'DRAFT', '[]', ?, ?, 1, ?)",
    (now, now, sys.argv[3]),
)
con.commit()
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .arg(local_id)
        .arg(remote_id)
        .output()
        .context("could not seed the mission tasks")?;
    if !output.status.success() {
        bail!(
            "seeding tasks failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn retarget_task(data_dir: &Path, task_id: &str, host_id: &str) -> Result<()> {
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA busy_timeout=5000")
con.execute("UPDATE loom_task SET execution_host_id=? WHERE task_id=?", (sys.argv[3], sys.argv[2]))
con.commit()
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .arg(task_id)
        .arg(host_id)
        .output()
        .context("could not retarget the task")?;
    if !output.status.success() {
        bail!(
            "retarget failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn assert_dispatch_node(data_dir: &Path, run_id: &str, node_id: &str) -> Result<()> {
    let script = r#"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
row = con.execute("SELECT node_id FROM node_dispatch WHERE run_id=?", (sys.argv[2],)).fetchone()
print(row[0] if row else "")
"#;
    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(data_dir.join("rovai.sqlite"))
        .arg(run_id)
        .output()
        .context("could not read the dispatch")?;
    if !output.status.success() {
        bail!(
            "dispatch read failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let got = String::from_utf8(output.stdout)?.trim().to_owned();
    if got != node_id {
        bail!("run {run_id} is on {got}, expected {node_id}");
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
    if !output.status.success() {
        bail!(
            "host read failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let host = String::from_utf8(output.stdout)?.trim().to_owned();
    if host != local_id {
        bail!("mission execution host changed ({host} != {local_id})");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
struct TaskRun {
    run_id: String,
    stdout: String,
    stderr: String,
}

#[cfg(target_os = "linux")]
fn run_task(data_dir: &Path, work: &Path, task_id: &str) -> Result<TaskRun> {
    let output = Command::new(std::env::current_exe()?)
        .env("LOOM_B5_ROLE", "server")
        .args([
            "node-exec",
            "--data-dir",
            data_dir.to_str().unwrap(),
            "--task",
            task_id,
            "--runtime",
            "codex-cli",
            "--cwd",
            work.to_str().unwrap(),
            "--",
            "exec",
            task_id,
        ])
        .output()
        .context("node-exec failed to start")?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        bail!("node-exec {task_id} failed: {stderr}\n{stdout}");
    }
    let run_id = stderr
        .lines()
        .find_map(|line| line.strip_prefix("run "))
        .and_then(|rest| rest.split_whitespace().next())
        .context("node-exec did not print a run id")?
        .to_owned();
    Ok(TaskRun {
        run_id,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "linux")]
fn spawn_count(path: &Path) -> Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    Ok(fs::read_to_string(path)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count())
}

#[cfg(target_os = "linux")]
fn spawn_server(
    a: &Path,
    ui: &Path,
    bin: &Path,
    listen: &str,
    stdout: &Path,
    stderr: &Path,
) -> Result<std::process::Child> {
    Command::new(std::env::current_exe()?)
        .env("LOOM_B5_ROLE", "server")
        .env("PATH", bin)
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
        .env("LOOM_B5_ROLE", "server")
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
