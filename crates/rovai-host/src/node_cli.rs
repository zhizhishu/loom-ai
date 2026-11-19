//! `node-pair`, `node-list`, and `node-exec` talk to the already running server.
//! They do not start a second Core.

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use loom_protocol::CONNECT_PATH;
use rovai_web::HOST_WEB_PROTOCOL_VERSION;
use serde::Deserialize;
use serde_json::json;
use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenerFile {
    origin: String,
    pid: u32,
}

#[derive(Deserialize)]
struct LoginResponse {
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    pairing_code: String,
    connect_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecResponse {
    run_id: String,
    exit_code: i32,
    stdout: String,
    stderr: String,
}

pub(crate) fn listener_path(data_dir: &Path) -> PathBuf {
    data_dir.join("loom-node-listener.json")
}

pub(crate) fn publish_listener(data_dir: &Path, listen: &str) -> Result<()> {
    let body = serde_json::to_vec_pretty(&json!({
        "origin": format!("http://{listen}"),
        "pid": std::process::id(),
    }))?;
    rovai_core::platform::atomic_write_private_bytes(&listener_path(data_dir), &body)
}

pub(crate) fn remove_listener(data_dir: &Path) {
    let _ = std::fs::remove_file(listener_path(data_dir));
}

pub(crate) fn pair(data_dir: &Path) -> Result<()> {
    let runtime = command_runtime()?;
    let (code, connect_url) = runtime.block_on(pair_async(data_dir))?;
    println!("{code}");
    eprintln!("connect: {connect_url}");
    eprintln!("pairing code expires in 10 minutes and works once");
    Ok(())
}

pub(crate) fn list(data_dir: &Path) -> Result<()> {
    let runtime = command_runtime()?;
    let body = runtime.block_on(list_async(data_dir))?;
    println!("{body}");
    Ok(())
}

pub(crate) fn workspace_prepare(
    data_dir: &Path,
    mission_id: &str,
    camp_id: &str,
    node_id: &str,
    source: &str,
) -> Result<()> {
    let runtime = command_runtime()?;
    let body = runtime.block_on(async {
        let (origin, client, session) = connect_admin(data_dir).await?;
        let response = client
            .post(format!("{origin}/api/v1/nodes/workspaces"))
            .bearer_auth(session)
            .json(&json!({
                "missionId": mission_id,
                "campId": camp_id,
                "nodeId": node_id,
                "source": source,
            }))
            .send()
            .await
            .context("workspace prepare failed")?;
        expect_json::<serde_json::Value>(response).await
    })?;
    println!(
        "{}",
        serde_json::to_string_pretty(&body).context("workspace prepare")?
    );
    Ok(())
}

pub(crate) fn workspace_files(
    data_dir: &Path,
    mission_id: &str,
    op: &str,
    relative: &str,
) -> Result<()> {
    if !matches!(op, "list" | "read") {
        bail!("{}", node_command_rejection("invalid_workspace"));
    }
    let runtime = command_runtime()?;
    let body = runtime.block_on(async {
        let (origin, client, session) = connect_admin(data_dir).await?;
        let response = client
            .post(format!("{origin}/api/v1/nodes/workspaces/files"))
            .bearer_auth(session)
            .json(&json!({
                "missionId": mission_id,
                "op": op,
                "relative": relative,
            }))
            .send()
            .await
            .context("workspace files failed")?;
        expect_json::<serde_json::Value>(response).await
    })?;
    if op == "read" {
        let encoded = body["data"]
            .as_str()
            .context("workspace read had no data")?;
        let bytes = STANDARD
            .decode(encoded)
            .context("workspace read was not base64")?;
        io::stdout().write_all(&bytes)?;
        if body["truncated"] == true {
            eprintln!("truncated");
        }
        return Ok(());
    }
    let entries = body["entries"]
        .as_array()
        .context("workspace list had no entries")?;
    for entry in entries {
        let name = entry["name"].as_str().unwrap_or("");
        if entry["kind"] == "dir" {
            println!("{name}/");
        } else {
            println!("{name}");
        }
    }
    if body["truncated"] == true {
        eprintln!("truncated");
    }
    Ok(())
}

pub(crate) fn exec(
    data_dir: &Path,
    runtime_kind: &str,
    cwd: &str,
    args: &[String],
    mission_id: Option<&str>,
    member_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<()> {
    if task_id.is_some() && (mission_id.is_some() || member_id.is_some()) {
        bail!("{}", node_command_rejection("task_scope_conflict"));
    }
    let runtime = command_runtime()?;
    let outcome = runtime.block_on(exec_async(
        data_dir,
        runtime_kind,
        cwd,
        args,
        mission_id,
        member_id,
        task_id,
    ))?;
    io::stdout().write_all(&outcome.stdout)?;
    io::stdout().flush()?;
    io::stderr().write_all(&outcome.stderr)?;
    let _ = writeln!(
        io::stderr(),
        "run {} exit {}",
        outcome.run_id,
        outcome.exit_code
    );
    if outcome.exit_code == 0 {
        return Ok(());
    }
    let code = u8::try_from(outcome.exit_code).unwrap_or(1);
    std::process::exit(i32::from(code));
}

struct ExecOutcome {
    run_id: String,
    exit_code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn command_runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to start node command runtime")
}

async fn pair_async(data_dir: &Path) -> Result<(String, String)> {
    let (origin, client, session) = connect_admin(data_dir).await?;
    let response = client
        .post(format!("{origin}/api/v1/nodes/pair"))
        .bearer_auth(session)
        .send()
        .await
        .context("pairing request failed")?;
    let body = expect_json::<PairResponse>(response).await?;
    let connect_url = if body.connect_url.is_empty() {
        ws_url(&origin)
    } else {
        body.connect_url
    };
    Ok((body.pairing_code, connect_url))
}

async fn list_async(data_dir: &Path) -> Result<String> {
    let (origin, client, session) = connect_admin(data_dir).await?;
    let response = client
        .get(format!("{origin}/api/v1/nodes"))
        .bearer_auth(session)
        .send()
        .await
        .context("node list request failed")?;
    let status = response.status();
    let bytes = response.bytes().await.context("empty server response")?;
    if !status.is_success() {
        let code = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| value["error"]["code"].as_str().map(str::to_owned))
            .unwrap_or_else(|| status.to_string());
        bail!("{}", node_command_rejection(&code));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).context("node list was not JSON")?;
    serde_json::to_string_pretty(&value).context("node list")
}

async fn exec_async(
    data_dir: &Path,
    runtime_kind: &str,
    cwd: &str,
    args: &[String],
    mission_id: Option<&str>,
    member_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<ExecOutcome> {
    let (origin, client, session) = connect_admin(data_dir).await?;
    let (path, mut body) = if let Some(task_id) = task_id {
        (
            format!("{origin}/api/v1/nodes/tasks/exec"),
            json!({
                "taskId": task_id,
                "runtime": runtime_kind,
                "cwd": cwd,
                "args": args,
            }),
        )
    } else {
        (
            format!("{origin}/api/v1/nodes/exec"),
            json!({
                "runtime": runtime_kind,
                "cwd": cwd,
                "args": args,
            }),
        )
    };
    if task_id.is_none() {
        if let Some(mission_id) = mission_id {
            body["missionId"] = json!(mission_id);
        }
        if let Some(member_id) = member_id {
            body["memberId"] = json!(member_id);
        }
    }
    let response = client
        .post(path)
        .bearer_auth(session)
        .json(&body)
        .send()
        .await
        .context("dispatch request failed")?;
    let body = expect_json::<ExecResponse>(response).await?;
    Ok(ExecOutcome {
        run_id: body.run_id,
        exit_code: body.exit_code,
        stdout: STANDARD
            .decode(body.stdout)
            .context("run stdout was not base64")?,
        stderr: STANDARD
            .decode(body.stderr)
            .context("run stderr was not base64")?,
    })
}

async fn connect_admin(data_dir: &Path) -> Result<(String, reqwest::Client, String)> {
    let listener = read_listener(data_dir)?;
    let token = administrator_token(data_dir)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .context("HTTP client")?;
    let response = client
        .post(format!("{}/api/v1/login", listener.origin))
        .json(&json!({
            "protocolVersion": HOST_WEB_PROTOCOL_VERSION,
            "administratorToken": token,
        }))
        .send()
        .await
        .context("could not reach the running Rovai Server")?;
    let login = expect_json::<LoginResponse>(response).await?;
    Ok((listener.origin, client, login.token))
}

fn read_listener(data_dir: &Path) -> Result<ListenerFile> {
    let path = listener_path(data_dir);
    let bytes = std::fs::read(&path).with_context(|| {
        format!(
            "Rovai Server is not running for {}; start it before node-pair or node-exec",
            data_dir.display()
        )
    })?;
    let listener: ListenerFile =
        serde_json::from_slice(&bytes).context("node listener file is invalid")?;
    if !process_alive(listener.pid) {
        bail!("Rovai Server is not running for {}", data_dir.display());
    }
    if !(listener.origin.starts_with("http://") || listener.origin.starts_with("https://")) {
        bail!("node listener origin is invalid");
    }
    Ok(listener)
}

fn administrator_token(data_dir: &Path) -> Result<String> {
    if let Some(token) = rovai_web::stored_administrator_token(data_dir)? {
        return Ok(token);
    }
    let path = data_dir.join("server-token");
    let token = std::fs::read_to_string(&path)
        .with_context(|| format!("no administrator token in {}", data_dir.display()))?;
    let token = token.trim().to_owned();
    if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(token)
    } else {
        bail!("stored administrator token is invalid")
    }
}

async fn expect_json<T: for<'de> Deserialize<'de>>(response: reqwest::Response) -> Result<T> {
    let status = response.status();
    let bytes = response.bytes().await.context("empty server response")?;
    if !status.is_success() {
        let code = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| value["error"]["code"].as_str().map(str::to_owned))
            .unwrap_or_else(|| status.to_string());
        bail!("{}", node_command_rejection(&code));
    }
    serde_json::from_slice(&bytes).context("server response was not the expected JSON")
}

fn node_command_rejection(code: &str) -> String {
    match code {
        "node_cli_unreported" => {
            "这台节点没有上报这个 CLI，或只留下上次见到的路径。没有启动进程。（node_cli_unreported）"
                .into()
        }
        "task_scope_conflict" => {
            "指定了任务就不能再写使命或队员。（task_scope_conflict）".into()
        }
        "node_offline" => "这台机器不在线（node_offline）".into(),
        "path_rejected" => "路径超出工作区（path_rejected）".into(),
        other => format!("server rejected the node command ({other})"),
    }
}

#[cfg(test)]
mod tests {
    use super::node_command_rejection;

    #[test]
    fn unreported_cli_explains_the_refusal_and_keeps_the_code() {
        let text = node_command_rejection("node_cli_unreported");
        assert!(text.contains("没有上报这个 CLI"));
        assert!(text.contains("（node_cli_unreported）"));
        assert!(node_command_rejection("node_not_found").contains("node_not_found"));
        assert!(node_command_rejection("task_scope_conflict").contains("（task_scope_conflict）"));
        assert!(node_command_rejection("node_offline").contains("不在线"));
    }
}

fn ws_url(origin: &str) -> String {
    let base = if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_owned()
    };
    format!("{}{CONNECT_PATH}", base.trim_end_matches('/'))
}

fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(pid as i32, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}
