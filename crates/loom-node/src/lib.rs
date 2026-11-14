mod builtin_bridge;
mod computer_provider;
mod discover;
mod installation_catalog;
mod legacy_run;
mod mcp_environment;
mod process_admission;
mod process_pipe;
mod process_wire;
mod run_bundle;
mod session;
mod shim;
pub mod workspace_authority;
pub mod workspace_rpc;

use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
use loom_protocol::CliReport;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    name = "loom-node",
    version,
    about = "Outbound execution node. Dials Rovai Server without an inbound network listener."
)]
struct Cli {
    /// Private directory for this node's credential file. Not a product database.
    #[arg(long)]
    data_dir: PathBuf,
    /// WebSocket URL of the server node channel.
    #[arg(long)]
    server: String,
    /// One-time pairing code from `rovai-server node-pair`.
    #[arg(long, conflicts_with = "pair_code_stdin")]
    pair_code: Option<String>,
    /// Read one pairing code from stdin, keeping it out of process arguments.
    #[arg(long, conflicts_with = "pair_code")]
    pair_code_stdin: bool,
    /// Local Rovai CLI helper; defaults to rovai beside loom-node.
    #[arg(long)]
    agent_cli: Option<PathBuf>,
    /// Absolute path to the desktop helper script. Computer support stays off
    /// unless this and `--computer-python` are both absolute existing files.
    #[arg(long)]
    computer_helper: Option<PathBuf>,
    /// Absolute path to the interpreter that runs the desktop helper.
    #[arg(long)]
    computer_python: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    version: u32,
    node_id: String,
    token: String,
    server: String,
}

pub fn run() -> Result<()> {
    let mut args = std::env::args();
    let _argv0 = args.next();
    if args.next().as_deref() == Some("--shim") {
        let path = args.next().context("shim credential path")?;
        let forwarded: Vec<String> = args.collect();
        return shim::forward(std::path::Path::new(&path), &forwarded);
    }
    let mut cli = Cli::parse();
    ensure_transport(&cli.server)?;
    if cli.pair_code_stdin {
        cli.pair_code = Some(read_pair_code(std::io::stdin().lock())?);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start loom-node runtime")?;
    runtime.block_on(run_async(cli))
}

fn read_pair_code(reader: impl Read) -> Result<String> {
    let mut limited = std::io::BufReader::new(reader.take(4097));
    let mut line = String::new();
    limited.read_line(&mut line).context("failed to read pairing code")?;
    ensure!(line.len() <= 4096, "pairing code exceeds size limit");
    let code = line.trim_end_matches(['\r', '\n']);
    ensure!(!code.is_empty() && !code.chars().any(char::is_control), "invalid pairing code input");
    Ok(code.to_owned())
}

async fn run_async(cli: Cli) -> Result<()> {
    prepare_data_dir(&cli.data_dir)?;
    let (clis, catalog) = discover::installed_clis(&cli.data_dir)
        .await
        .map_err(|code| anyhow::anyhow!(code))?;
    let mut credentials = if let Some(code) = cli.pair_code.as_deref() {
        let issued = session::pair(&cli.server, code).await?;
        let credentials = Credentials {
            version: 1,
            node_id: issued.node_id,
            token: issued.token,
            server: cli.server.clone(),
        };
        write_credentials(&cli.data_dir, &credentials)?;
        credentials
    } else {
        read_credentials(&cli.data_dir)?
    };
    if credentials.server != cli.server {
        credentials.server = cli.server.clone();
        write_credentials(&cli.data_dir, &credentials)?;
    }
    let computer = computer_provider::ComputerHost::open(
        cli.computer_helper.clone(),
        cli.computer_python.clone(),
    );
    session::serve(
        &cli.data_dir,
        &cli.server,
        &credentials.node_id,
        &credentials.token,
        clis,
        catalog,
        computer,
        load_builtin_bridge(&cli.data_dir, cli.agent_cli.as_deref()).await?,
    )
    .await
}

async fn load_builtin_bridge(
    data_dir: &Path,
    requested: Option<&Path>,
) -> Result<Option<builtin_bridge::BuiltinBridge>> {
    let helper = match requested {
        Some(path) => {
            ensure!(
                path.is_absolute(),
                "--agent-cli must be an absolute local path"
            );
            path.to_path_buf()
        }
        None => std::env::current_exe()?
            .parent()
            .context("node executable directory")?
            .join(format!("rovai{}", std::env::consts::EXE_SUFFIX)),
    };
    match builtin_bridge::BuiltinBridge::new(data_dir, &helper).await {
        Ok(bridge) => Ok(Some(bridge)),
        Err(code) if requested.is_some() => bail!("local Rovai CLI helper rejected ({code})"),
        Err(code) => {
            eprintln!(
                "loom-node: persistent native sessions unavailable ({code}); install the matching Rovai CLI beside loom-node or set --agent-cli"
            );
            Ok(None)
        }
    }
}

fn prepare_data_dir(path: &Path) -> Result<()> {
    if path.exists() {
        ensure!(path.is_dir(), "data dir is not a directory");
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(path)
                .with_context(|| format!("could not create {}", path.display()))?;
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(path)
                .with_context(|| format!("could not create {}", path.display()))?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn credential_path(data_dir: &Path) -> PathBuf {
    data_dir.join("node.json")
}

fn write_credentials(data_dir: &Path, credentials: &Credentials) -> Result<()> {
    let path = credential_path(data_dir);
    let bytes = serde_json::to_vec_pretty(credentials)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .with_context(|| format!("could not write {}", path.display()))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&path, &bytes).with_context(|| format!("could not write {}", path.display()))?;
    }
    Ok(())
}

fn read_credentials(data_dir: &Path) -> Result<Credentials> {
    let path = credential_path(data_dir);
    let bytes = fs::read(&path).with_context(|| {
        format!(
            "no node credential at {}; pass --pair-code for the first connection",
            path.display()
        )
    })?;
    let credentials: Credentials =
        serde_json::from_slice(&bytes).context("node credential file is invalid")?;
    ensure!(
        credentials.version == 1,
        "unsupported node credential version"
    );
    ensure!(
        !credentials.node_id.is_empty(),
        "node credential is missing nodeId"
    );
    ensure!(
        credentials.token.len() == 64,
        "node credential token is invalid"
    );
    Ok(credentials)
}

/// Host name reported in Hello. Empty when it is missing or not a plain host label.
pub fn machine_hostname() -> String {
    let raw = raw_hostname();
    let name = raw.trim();
    if name.is_empty()
        || name.len() > 64
        || name.starts_with(['-', '.'])
        || name.ends_with(['-', '.'])
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
    {
        return String::new();
    }
    name.to_owned()
}

fn raw_hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast::<libc::c_char>(), buf.len()) };
        if rc != 0 {
            return String::new();
        }
        let end = buf.iter().position(|byte| *byte == 0).unwrap_or(buf.len());
        return String::from_utf8_lossy(&buf[..end]).into_owned();
    }
    #[cfg(windows)]
    {
        return std::env::var("COMPUTERNAME").unwrap_or_default();
    }
    #[cfg(not(any(unix, windows)))]
    String::new()
}

/// Plain WebSocket is only for a loopback B1. Anywhere else the URL must be `wss`.
pub fn ensure_transport(server: &str) -> Result<()> {
    let Some(rest) = server
        .strip_prefix("wss://")
        .or_else(|| server.strip_prefix("ws://"))
    else {
        bail!("--server must be a ws:// or wss:// URL");
    };
    if server.starts_with("wss://") {
        ensure!(rest.contains('/'), "--server is missing a path");
        return Ok(());
    }
    let authority = rest.split('/').next().unwrap_or("");
    ensure!(
        is_loopback_authority(authority),
        "plaintext WebSocket is only allowed to a loopback host; use wss://"
    );
    Ok(())
}

fn is_loopback_authority(authority: &str) -> bool {
    let host = if let Some(host) = authority.strip_prefix('[') {
        host.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_websocket_is_only_dialed_on_loopback() {
        assert!(ensure_transport("ws://127.0.0.1:8767/api/v1/nodes/connect").is_ok());
        assert!(ensure_transport("ws://localhost:8767/api/v1/nodes/connect").is_ok());
        assert!(ensure_transport("ws://[::1]:8767/api/v1/nodes/connect").is_ok());
        assert!(ensure_transport("ws://10.1.2.3:8767/api/v1/nodes/connect").is_err());
        assert!(ensure_transport("ws://example.com/api/v1/nodes/connect").is_err());
        assert!(ensure_transport("wss://example.com/api/v1/nodes/connect").is_ok());
        assert!(ensure_transport("wss://loom.trycloudflare.com/api/v1/nodes/connect").is_ok());
        assert!(ensure_transport("http://127.0.0.1:8767/api/v1/nodes/connect").is_err());
    }

    #[test]
    fn reported_hostname_is_a_plain_label_or_empty() {
        let name = machine_hostname();
        assert!(name.len() <= 64);
        assert!(
            name.is_empty()
                || name.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_')
                })
        );
    }
}

#[cfg(test)]
mod pairing_stdin_tests {
    use super::*;
    #[test]
    fn accepts_a_single_bounded_line_without_echoing_it() {
        assert_eq!(read_pair_code(&b"owned-pair-code\r\n"[..]).unwrap(), "owned-pair-code");
    }
    #[test]
    fn rejects_missing_oversized_or_control_content() {
        assert!(read_pair_code(&b"\n"[..]).is_err());
        assert!(read_pair_code(vec![b'x'; 4097].as_slice()).is_err());
        assert!(read_pair_code(&b"a\0b\n"[..]).is_err());
    }
    #[test]
    fn code_sources_are_mutually_exclusive() {
        assert!(Cli::try_parse_from(["loom-node", "--data-dir", "/owned/node", "--server", "ws://127.0.0.1:1", "--pair-code", "sample", "--pair-code-stdin"]).is_err());
    }
}
