//! LOOM embedded Pi launcher.
//!
//! A thin, fixed-path bridge from the packaged Pi runtime root to the pinned Pi
//! entry. It exists because Core's Windows discovery only admits `.exe`
//! entrypoints, while the packaged Pi runtime is a Node program.
//!
//! Hard boundaries (by construction, not by configuration):
//! - The executable and script paths are compile-time constants relative to the
//!   launcher's own canonical root. There is no argument, environment variable,
//!   or configuration key that can redirect them.
//! - CLI arguments are forwarded unchanged; stdio, environment, and the working
//!   directory are inherited. Nothing is written into the package.
//! - Symbolic links that leave the package root are refused.
//! - Non-informational invocations require an explicit `PI_CODING_AGENT_DIR` or
//!   `LOOM_PI_AGENT_DIR`, so a packaged launcher can never silently fall back to
//!   the user's own Pi configuration.
//! - No credentials are read, printed, or copied. No model request is made here.
//!
//! Unix replaces the launcher process with Node (`exec`). Windows spawns Node,
//! waits for it inside the existing Core job tree, and propagates its exit code.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

const NODE_RELATIVE: &str = if cfg!(windows) {
    "node/node.exe"
} else {
    "node/node"
};
const ENTRY_RELATIVE: &str = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

/// Pi reads this environment variable for its agent (config, auth, sessions) root.
const AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
/// LOOM's own spelling; mapped onto `PI_CODING_AGENT_DIR` when the Pi spelling is
/// absent. The value is passed through, never interpreted beyond a path check.
const LOOM_AGENT_DIR_ENV: &str = "LOOM_PI_AGENT_DIR";

const EXIT_USAGE: u8 = 2;
const EXIT_BUNDLE: u8 = 3;

fn main() -> std::process::ExitCode {
    let arguments: Vec<OsString> = env::args_os().skip(1).collect();
    if is_informational(&arguments) {
        // `--version` / `--help` are answered by the packaged Pi itself, so they
        // prove the package runs without requiring an agent directory.
        return run(arguments, None);
    }
    match explicit_agent_directory() {
        Ok(agent_dir) => run(arguments, Some(agent_dir)),
        Err(message) => {
            eprintln!("loom-pi-launcher: {message}");
            std::process::ExitCode::from(EXIT_USAGE)
        }
    }
}

fn is_informational(arguments: &[OsString]) -> bool {
    // Only a standalone information request can bypass the explicit config root.
    // Mixed RPC/run flags never inherit the user's native Pi configuration.
    arguments.len() == 1
        && matches!(arguments[0].to_str(), Some("--version" | "-v" | "--help" | "-h"))
}

/// Require an absolute, existing agent directory from the caller. LOOM's spelling
/// is accepted and mapped onto Pi's, but only when Pi's own value is absent.
fn explicit_agent_directory() -> Result<OsString, String> {
    let pi_value = non_empty_var(AGENT_DIR_ENV);
    let loom_value = non_empty_var(LOOM_AGENT_DIR_ENV);
    let value = match (pi_value, loom_value) {
        (Some(value), _) => value,
        (None, Some(value)) => value,
        (None, None) => {
            return Err(format!(
                "embedded Pi requires {AGENT_DIR_ENV} (or {LOOM_AGENT_DIR_ENV}); refusing to use the user's Pi configuration"
            ));
        }
    };
    let path = PathBuf::from(&value);
    if !path.is_absolute() {
        return Err(format!("{AGENT_DIR_ENV} must be an absolute path"));
    }
    if !path.is_dir() {
        return Err(format!(
            "{AGENT_DIR_ENV} must be an existing directory: {}",
            path.display()
        ));
    }
    Ok(value)
}

fn non_empty_var(key: &str) -> Option<OsString> {
    env::var_os(key).filter(|value| !value.is_empty())
}

fn run(arguments: Vec<OsString>, agent_dir: Option<OsString>) -> std::process::ExitCode {
    let executable = match env::current_exe() {
        Ok(executable) => executable,
        Err(error) => return fail(EXIT_BUNDLE, &format!("cannot resolve launcher path: {error}")),
    };
    let root = match executable.canonicalize() {
        Ok(executable) => match executable.parent().map(Path::to_path_buf) {
            Some(parent) => match parent.canonicalize() {
                Ok(root) => root,
                Err(error) => return fail(EXIT_BUNDLE, &format!("cannot resolve package root: {error}")),
            },
            None => return fail(EXIT_BUNDLE, "launcher has no parent directory"),
        },
        Err(error) => return fail(EXIT_BUNDLE, &format!("cannot resolve launcher path: {error}")),
    };
    let node = match resolve_inside(&root, NODE_RELATIVE) {
        Ok(path) => path,
        Err(message) => return fail(EXIT_BUNDLE, &message),
    };
    let entry = match resolve_inside(&root, ENTRY_RELATIVE) {
        Ok(path) => path,
        Err(message) => return fail(EXIT_BUNDLE, &message),
    };

    let mut command = Command::new(&node);
    command.arg(node_script_argument(&entry)).args(&arguments);
    if let Some(agent_dir) = agent_dir {
        if non_empty_var(AGENT_DIR_ENV).is_none() {
            command.env(AGENT_DIR_ENV, agent_dir);
        }
    }
    launch(command, &node)
}

/// Resolve one fixed relative path inside the canonical package root, refusing
/// symlinks and any canonical target that escapes the root.
fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut candidate = root.to_path_buf();
    for component in relative.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(format!("packaged Pi path is unsafe: {relative}"));
        }
        candidate.push(component);
    }
    let metadata = std::fs::symlink_metadata(&candidate)
        .map_err(|error| format!("packaged Pi file is missing ({relative}): {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("packaged Pi file must not be a symbolic link: {relative}"));
    }
    if !metadata.is_file() {
        return Err(format!("packaged Pi file is not a regular file: {relative}"));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("packaged Pi file is unresolvable ({relative}): {error}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("packaged Pi path escapes its root: {relative}"));
    }
    Ok(canonical)
}

/// Node's Windows main-module loader rejects the Win32 verbatim prefix even
/// though Rust canonicalization returns it. Only translate spelling AFTER the
/// canonical inside-root checks; never change containment or accept device paths.
fn node_script_argument(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
        let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
        if units.starts_with(&unc) {
            let mut normal: Vec<u16> = r"\\".encode_utf16().collect();
            normal.extend_from_slice(&units[unc.len()..]);
            return OsString::from_wide(&normal);
        }
        if units.starts_with(&prefix) && units.get(5) == Some(&(b':' as u16)) {
            return OsString::from_wide(&units[prefix.len()..]);
        }
    }
    path.as_os_str().to_owned()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn only_standalone_help_or_version_is_informational() {
        assert!(is_informational(&[OsString::from("--version")]));
        assert!(is_informational(&[OsString::from("--help")]));
        assert!(!is_informational(&[]));
        assert!(!is_informational(&[OsString::from("--mode"), OsString::from("rpc"), OsString::from("--version")]));
        assert!(!is_informational(&[OsString::from("--help"), OsString::from("unexpected")]));
    }

    #[test]
    fn node_argv_removes_only_known_verbatim_forms() {
        assert_eq!(node_script_argument(Path::new(r"\\?\C:\app\pi\cli.js")), OsString::from(r"C:\app\pi\cli.js"));
        assert_eq!(node_script_argument(Path::new(r"\\?\UNC\host\share\cli.js")), OsString::from(r"\\host\share\cli.js"));
        assert_eq!(node_script_argument(Path::new(r"C:\app\cli.js")), OsString::from(r"C:\app\cli.js"));
        assert_eq!(node_script_argument(Path::new(r"\\.\device")), OsString::from(r"\\.\device"));
    }
}

fn fail(code: u8, message: &str) -> std::process::ExitCode {
    eprintln!("loom-pi-launcher: {message}");
    std::process::ExitCode::from(code)
}

#[cfg(unix)]
fn launch(mut command: Command, _node: &Path) -> std::process::ExitCode {
    use std::os::unix::process::CommandExt;

    // `exec` failure is the only way this returns.
    let error = command.exec();
    fail(EXIT_BUNDLE, &format!("cannot start packaged Node runtime: {error}"))
}

#[cfg(windows)]
fn launch(mut command: Command, _node: &Path) -> std::process::ExitCode {
    // The child inherits the Core job object, so a launcher shutdown still
    // terminates the packaged Pi process tree.
    match command.status() {
        Ok(status) => match status.code() {
            Some(0) => std::process::ExitCode::SUCCESS,
            Some(code) => std::process::ExitCode::from(u8::try_from(code).unwrap_or(1)),
            None => std::process::ExitCode::from(1),
        },
        Err(error) => fail(
            EXIT_BUNDLE,
            &format!("cannot start packaged Node runtime: {error}"),
        ),
    }
}
