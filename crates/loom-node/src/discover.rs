use crate::CliReport;
use std::{path::PathBuf, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

/// B1 reports the two one-shot CLIs the milestone can dispatch.
/// The rest of the adapter catalog is B3.
const KNOWN: &[(&str, &str)] = &[("codex-cli", "codex"), ("claude-code-cli", "claude")];

pub async fn installed_clis() -> Vec<CliReport> {
    let mut found = Vec::new();
    for (adapter_kind, command) in KNOWN {
        let Some(path) = which(command) else {
            continue;
        };
        let version = version_of(&path).await;
        found.push(CliReport {
            adapter_kind: (*adapter_kind).to_owned(),
            path: path.display().to_string(),
            version,
            path_present: true,
        });
    }
    found
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
        }
    }
    None
}

async fn version_of(path: &PathBuf) -> Option<String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let read = async {
        let mut buf = [0u8; 512];
        let n = stdout.read(&mut buf).await.unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        let line = text.lines().next().unwrap_or("").trim();
        if line.is_empty() {
            None
        } else {
            Some(line.chars().take(200).collect())
        }
    };
    match tokio::time::timeout(Duration::from_secs(5), read).await {
        Ok(version) => {
            let _ = child.kill().await;
            version
        }
        Err(_) => {
            let _ = child.kill().await;
            None
        }
    }
}
