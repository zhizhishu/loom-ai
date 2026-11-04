use crate::CliReport;
use loom_protocol::CLI_CATALOG;
use std::{ffi::OsStr, path::PathBuf, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

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
    match std::env::var_os("PATH") {
        Some(path) => installed_clis_in(&path).await,
        None => Vec::new(),
    }
}

async fn installed_clis_in(path_env: &OsStr) -> Vec<CliReport> {
    let mut found = Vec::new();
    for (adapter_kind, commands) in CLI_CATALOG {
        let Some(path) = which_in(path_env, commands) else {
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

fn which_in(path_env: &OsStr, names: &[&str]) -> Option<PathBuf> {
    for name in names {
        for dir in std::env::split_paths(path_env) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
            }
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

    #[tokio::test]
    async fn discovery_reports_the_rest_of_the_catalog_and_not_a_generic_agent() {
        assert!(CATALOG.iter().any(|(kind, _)| *kind == "claude-code-cli"));
        assert!(
            CATALOG
                .iter()
                .any(|(kind, names)| { *kind == "cursor-agent" && *names == ["cursor-agent"] })
        );
        assert!(!CATALOG.iter().any(|(_, names)| names.contains(&"agent")));
        let root = std::env::temp_dir().join(format!(
            "loom-node-catalog-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["codex", "pi", "cmdc", "agent"] {
            let path = root.join(name);
            std::fs::write(
                &path,
                b"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo b3; exit 0; fi\nexit 0\n",
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let found = installed_clis_in(root.as_os_str()).await;
        let kinds: Vec<_> = found.iter().map(|cli| cli.adapter_kind.as_str()).collect();
        assert!(kinds.contains(&"codex-cli"), "{kinds:?}");
        assert!(kinds.contains(&"pi"), "{kinds:?}");
        assert!(kinds.contains(&"command-code-cli"), "{kinds:?}");
        assert!(!kinds.contains(&"cursor-agent"), "{kinds:?}");
        assert!(!kinds.contains(&"claude-code-cli"), "{kinds:?}");
        assert!(
            found
                .iter()
                .all(|cli| cli.path_present && cli.path != "path_missing")
        );
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
