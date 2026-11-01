mod discover;
mod session;

use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
use loom_protocol::CliReport;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    name = "loom-node",
    version,
    about = "Outbound execution node. Dials a Rovai Server and never listens."
)]
struct Cli {
    /// Private directory for this node's credential file. Not a product database.
    #[arg(long)]
    data_dir: PathBuf,
    /// WebSocket URL of the server node channel.
    #[arg(long)]
    server: String,
    /// One-time pairing code from `rovai-server node-pair`.
    #[arg(long)]
    pair_code: Option<String>,
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
    let cli = Cli::parse();
    ensure_transport(&cli.server)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start loom-node runtime")?;
    runtime.block_on(run_async(cli))
}

async fn run_async(cli: Cli) -> Result<()> {
    prepare_data_dir(&cli.data_dir)?;
    let clis = discover::installed_clis().await;
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
    session::serve(&cli.server, &credentials.node_id, &credentials.token, clis).await
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
        assert!(ensure_transport("http://127.0.0.1:8767/api/v1/nodes/connect").is_err());
    }
}
