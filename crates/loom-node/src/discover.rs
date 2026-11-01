use crate::CliReport;
use std::{path::PathBuf, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

/// B1 reports the two one-shot CLIs the milestone can dispatch.
/// The rest of the adapter catalog is B3.
const KNOWN: &[(&str, &str)] = &[("codex-cli", "codex"), ("claude-code-cli", "claude")];

/// The program A asked to run must be the binary this node discovered for that
/// runtime. The returned path is the one to execute; a server-supplied path that
/// does not canonicalize to it is refused.
pub fn resolve_executable(
    clis: &[CliReport],
    adapter_kind: &str,
    program: &str,
) -> Option<std::path::PathBuf> {
    let cli = clis
        .iter()
        .find(|cli| cli.adapter_kind == adapter_kind && cli.path_present && !cli.path.is_empty())?;
    let discovered = std::fs::canonicalize(&cli.path).ok()?;
    let requested = std::fs::canonicalize(program).ok()?;
    if discovered == requested {
        Some(discovered)
    } else {
        None
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_outside_local_discovery_is_rejected() {
        let root = std::env::temp_dir().join(format!(
            "loom-node-allow-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let codex = root.join("codex");
        let other = root.join("other");
        std::fs::write(&codex, b"codex").unwrap();
        std::fs::write(&other, b"other").unwrap();
        let clis = vec![CliReport {
            adapter_kind: "codex-cli".into(),
            path: codex.display().to_string(),
            version: None,
            path_present: true,
        }];
        let resolved = resolve_executable(&clis, "codex-cli", &codex.display().to_string())
            .expect("discovered binary");
        assert_eq!(resolved, std::fs::canonicalize(&codex).unwrap());
        assert!(resolve_executable(&clis, "codex-cli", &other.display().to_string()).is_none());
        assert!(
            resolve_executable(&clis, "claude-code-cli", &codex.display().to_string()).is_none()
        );
        assert!(resolve_executable(&clis, "codex-cli", "/bin/sh").is_none());
        let _ = std::fs::remove_dir_all(root);
    }
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
