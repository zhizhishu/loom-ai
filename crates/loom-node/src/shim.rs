//! The `rovai` command placed first on one Run's PATH.
//!
//! It is a launcher for this same binary. The per-run token lives in a 0600
//! file next to the launcher, never in the child environment, and the node
//! token is not written there either. The launcher dials A; it does not listen.

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialFile {
    version: u32,
    token: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShimResponse {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

pub(crate) struct Installed {
    root: PathBuf,
    pub(crate) bin_dir: PathBuf,
}

impl Drop for Installed {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(crate) fn http_url(server: &str) -> Result<String> {
    let (scheme, rest) = if let Some(rest) = server.strip_prefix("wss://") {
        ("https", rest)
    } else if let Some(rest) = server.strip_prefix("ws://") {
        ("http", rest)
    } else {
        bail!("node server URL is not a websocket");
    };
    let authority = rest.split('/').next().unwrap_or("");
    ensure!(!authority.is_empty(), "node server URL has no host");
    Ok(format!("{scheme}://{authority}/api/v1/nodes/shim"))
}

/// Write `bin/rovai` and a sibling credential file. The launcher script names
/// the credential path; it does not contain the token.
pub(crate) fn install(
    data_dir: &Path,
    run_id: &str,
    attempt: u32,
    token: &str,
    server: &str,
) -> Result<Installed> {
    ensure!(token.len() == 64, "shim token is invalid");
    let root = data_dir.join("runs").join(format!("{run_id}-{attempt}"));
    let bin_dir = root.join("bin");
    fs::create_dir_all(&bin_dir)
        .with_context(|| format!("could not create {}", bin_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(
            root.parent().unwrap_or(&root),
            fs::Permissions::from_mode(0o700),
        )?;
        fs::set_permissions(&bin_dir, fs::Permissions::from_mode(0o700))?;
    }
    let credential = root.join("credential");
    let body = serde_json::to_vec(&CredentialFile {
        version: 1,
        token: token.to_owned(),
        url: http_url(server)?,
    })?;
    write_private(&credential, &body)?;
    let exe = std::env::current_exe().context("could not resolve loom-node")?;
    let script = format!(
        "#!/bin/sh\nexec {} --shim {} \"$@\"\n",
        shell_single(&exe),
        shell_single(&credential),
    );
    ensure!(
        !script.contains(token),
        "shim launcher must not embed the run token"
    );
    let launcher = bin_dir.join("rovai");
    write_private(&launcher, script.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700))?;
    }
    Ok(Installed { root, bin_dir })
}

pub(crate) fn forward(credential_path: &Path, args: &[String]) -> Result<()> {
    let bytes = fs::read(credential_path)
        .with_context(|| format!("could not read {}", credential_path.display()))?;
    let credential: CredentialFile =
        serde_json::from_slice(&bytes).context("shim credential is invalid")?;
    ensure!(credential.version == 1, "unsupported shim credential");
    ensure!(
        credential.url.starts_with("https://") || credential.url.starts_with("http://"),
        "shim credential URL is invalid"
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .context("shim HTTP client")?;
    let response = client
        .post(&credential.url)
        .bearer_auth(&credential.token)
        .json(&serde_json::json!({ "args": args }))
        .send()
        .context("shim call to A failed")?;
    let status = response.status();
    let body = response.text().context("shim response was empty")?;
    if !status.is_success() {
        let _ = writeln!(io::stderr(), "{body}");
        std::process::exit(1);
    }
    let parsed: ShimResponse = serde_json::from_str(&body).context("shim response was not JSON")?;
    io::stdout().write_all(parsed.stdout.as_bytes())?;
    io::stderr().write_all(parsed.stderr.as_bytes())?;
    std::process::exit(parsed.exit_code);
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("could not write {}", path.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes).with_context(|| format!("could not write {}", path.display()))?;
    }
    Ok(())
}

fn shell_single(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_url_follows_the_websocket_the_node_already_dialed() {
        assert_eq!(
            http_url("ws://127.0.0.1:8767/api/v1/nodes/connect").unwrap(),
            "http://127.0.0.1:8767/api/v1/nodes/shim"
        );
        assert_eq!(
            http_url("wss://loom.example/api/v1/nodes/connect").unwrap(),
            "https://loom.example/api/v1/nodes/shim"
        );
        assert!(http_url("http://127.0.0.1:8767/api/v1/nodes/connect").is_err());
    }

    #[test]
    fn launcher_does_not_contain_the_run_token() {
        let root = std::env::temp_dir().join(format!("loom-shim-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let token = "ab".repeat(32);
        let installed = install(
            &root,
            "run_1",
            1,
            &token,
            "ws://127.0.0.1:8767/api/v1/nodes/connect",
        )
        .unwrap();
        let script = fs::read_to_string(installed.bin_dir.join("rovai")).unwrap();
        assert!(!script.contains(&token));
        assert!(script.contains("--shim"));
        let credential: serde_json::Value =
            serde_json::from_slice(&fs::read(installed.root.join("credential")).unwrap()).unwrap();
        assert_eq!(credential["token"], token);
        assert_eq!(credential["url"], "http://127.0.0.1:8767/api/v1/nodes/shim");
        drop(installed);
        assert!(!root.join("runs").join("run_1-1").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
