use crate::CliReport;
use crate::installation_catalog::{Candidate, InstallationCatalog, resolve_native_entrypoint};
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
    let discovered = resolve_native_entrypoint(std::path::Path::new(&cli.path), adapter_kind)?;
    let requested = std::fs::canonicalize(program).ok()?;
    if discovered == requested {
        Some(discovered)
    } else {
        None
    }
}

pub async fn installed_clis(data_dir: &std::path::Path) -> Result<(Vec<CliReport>, InstallationCatalog), &'static str> {
    let mut catalog = InstallationCatalog::open(data_dir)?;
    let candidates = match std::env::var_os("PATH") {
        Some(path) => candidates_in(&path).await,
        None => Vec::new(),
    };
    let reports = catalog.publish(candidates)?;
    Ok((reports, catalog))
}

async fn candidates_in(path_env: &OsStr) -> Vec<Candidate> {
    let mut found = Vec::new();
    for (adapter_kind, commands) in CLI_CATALOG {
        let Some(source_path) = which_in(path_env, commands) else {
            continue;
        };
        let native = resolve_native_entrypoint(&source_path, adapter_kind);
        let version = match native.as_ref() {
            Some(path) => version_of(path).await,
            None => None,
        };
        found.push(Candidate {
            report: CliReport {
                adapter_kind: (*adapter_kind).to_owned(),
                path: native.as_ref().unwrap_or(&source_path).display().to_string(),
                version,
                path_present: native.is_some(),
                installation_identity: None,
                installation_generation: None,
            },
            source_path,
        });
    }
    found
}

#[cfg(test)]
async fn installed_clis_in(path_env: &OsStr) -> Vec<CliReport> {
    candidates_in(path_env).await.into_iter().map(|candidate| candidate.report).collect()
}

fn which_in(path_env: &OsStr, names: &[&str]) -> Option<PathBuf> {
    for name in names {
        for dir in std::env::split_paths(path_env) {
            #[cfg(windows)]
            {
                // Ignore extensionless POSIX npm launchers on Windows. Search
                // bounded native/batch extensions in the declared PATHEXT order.
                let pathext =
                    std::env::var_os("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
                for extension in windows_extensions(&pathext) {
                    let candidate = dir.join(format!("{name}{extension}"));
                    if candidate.is_file() {
                        return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
                    }
                }
            }
            #[cfg(not(windows))]
            {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_extensions(pathext: &OsStr) -> Vec<String> {
    let mut result = Vec::new();
    for suffix in pathext.to_string_lossy().split(';').take(32) {
        let suffix = suffix.trim().to_ascii_lowercase();
        if matches!(suffix.as_str(), ".exe" | ".com" | ".cmd" | ".bat") && !result.contains(&suffix)
        {
            result.push(suffix);
        }
    }
    result
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
        let codex = root.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        let other = root.join(if cfg!(windows) { "other.exe" } else { "other" });
        std::fs::write(&codex, b"codex").unwrap();
        std::fs::write(&other, b"other").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&codex, &other] {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        let clis = vec![CliReport {
            adapter_kind: "codex-cli".into(),
            path: codex.display().to_string(),
            version: None,
            path_present: true,
            installation_identity: None,
            installation_generation: None,
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
        assert!(
            CLI_CATALOG
                .iter()
                .any(|(kind, _)| *kind == "claude-code-cli")
        );
        assert!(
            CLI_CATALOG
                .iter()
                .any(|(kind, names)| { *kind == "cursor-agent" && *names == ["cursor-agent"] })
        );
        assert!(
            !CLI_CATALOG
                .iter()
                .any(|(_, names)| names.contains(&"agent"))
        );
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
            #[cfg(windows)]
            let path = root.join(format!("{name}.cmd"));
            #[cfg(not(windows))]
            let path = root.join(name);
            #[cfg(windows)]
            let body = format!("@echo off\r\necho probed>\"{}\"\r\necho b3\r\n", root.join("version-probed").display());
            #[cfg(not(windows))]
            let body: &[u8] =
                b"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo b3; exit 0; fi\nexit 0\n";
            std::fs::write(&path, body).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        #[cfg(windows)]
        {
            std::fs::write(root.join("codex"), b"#!/bin/sh\nexit 99").unwrap();
            assert_eq!(
                windows_extensions(OsStr::new(".PS1;.CMD;.EXE;.CMD;../bad")),
                vec![".cmd", ".exe"]
            );
        }
        let found = installed_clis_in(root.as_os_str()).await;
        #[cfg(windows)]
        assert!(
            found
                .iter()
                .all(|cli| cli.version.is_none() && !cli.path_present && cli.path.ends_with(".cmd"))
        );
        let kinds: Vec<_> = found.iter().map(|cli| cli.adapter_kind.as_str()).collect();
        assert!(kinds.contains(&"codex-cli"), "{kinds:?}");
        assert!(kinds.contains(&"pi"), "{kinds:?}");
        assert!(kinds.contains(&"command-code-cli"), "{kinds:?}");
        assert!(!kinds.contains(&"cursor-agent"), "{kinds:?}");
        assert!(!kinds.contains(&"claude-code-cli"), "{kinds:?}");
        assert!(found.iter().all(|cli| cli.path != "path_missing"));
        #[cfg(unix)]
        assert!(found.iter().all(|cli| cli.path_present));
        #[cfg(windows)]
        assert!(!root.join("version-probed").exists(), "unknown cmd shims must not be executed for discovery");
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
