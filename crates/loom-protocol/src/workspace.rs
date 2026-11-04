//! Workspace file jail shared by the server and the node.
//!
//! Listing and reading stay inside one worktree root. `..`, an absolute path
//! outside that root, and a symlink that resolves outside it are refused
//! before any bytes are returned. Writes are not part of this module.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
};

pub const MAX_LIST_ENTRIES: usize = 200;
pub const MAX_READ_BYTES: usize = 1024 * 1024;

/// Adapter kinds a node or the server may discover on `PATH`.
/// Cursor's generic `agent` name is absent on purpose.
pub const CLI_CATALOG: &[(&str, &[&str])] = &[
    ("codex-cli", &["codex"]),
    ("pi", &["pi"]),
    ("opencode-cli", &["opencode"]),
    ("copilot-cli", &["copilot"]),
    ("claude-code-cli", &["claude"]),
    ("cline-cli", &["cline"]),
    ("command-code-cli", &["command-code", "cmdc"]),
    ("kiro-cli", &["kiro-cli"]),
    ("qoder-cli", &["qodercli"]),
    ("codebuddy-cli", &["codebuddy"]),
    ("qwen-code", &["qwen"]),
    ("trae-cn-cli", &["traecli"]),
    ("cursor-agent", &["cursor-agent"]),
    ("kimi-code-cli", &["kimi"]),
    ("minimax-code-cli", &["mcode"]),
    ("hermes-cli", &["hermes"]),
    ("grok-build", &["grok"]),
    ("deepseek-harness", &["dsh"]),
    ("zcode-app", &["ZCode"]),
    ("antigravity-app", &["agy"]),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsEntry {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedWorktree {
    pub worktree: String,
    pub source: String,
    pub common_dir: String,
    pub base_sha: String,
    pub branch: String,
}

/// Turn a client path into a relative path under `root`, or refuse it.
/// This check does not touch the filesystem. Symlinks are a second check.
pub fn workspace_relative(root: &str, raw: &str) -> Result<String, &'static str> {
    if raw.contains('\0') || raw.len() > 4096 || root.is_empty() || root.contains('\0') {
        return Err("path_rejected");
    }
    let root_path = Path::new(root);
    if !root_path.is_absolute() {
        return Err("path_rejected");
    }
    let raw_path = Path::new(raw);
    if raw.is_empty() || raw == "." {
        return Ok(String::new());
    }
    if raw_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("path_rejected");
    }
    let relative = if raw_path.is_absolute() {
        raw_path
            .strip_prefix(root_path)
            .map_err(|_| "path_rejected")?
    } else {
        raw_path
    };
    for component in relative.components() {
        match component {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                if name.is_empty() || name == "." || name == ".." || name.contains('/') {
                    return Err("path_rejected");
                }
            }
            Component::CurDir => {}
            _ => return Err("path_rejected"),
        }
    }
    let joined = if relative.as_os_str().is_empty() {
        root_path.to_path_buf()
    } else {
        root_path.join(relative)
    };
    if !joined.starts_with(root_path) {
        return Err("path_rejected");
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// Resolve `raw` under `root`, following symlinks, and refuse anything that
/// lands outside the canonical root.
pub fn resolve_inside(root: &Path, raw: &str) -> Result<PathBuf, &'static str> {
    let root = fs::canonicalize(root).map_err(|_| "not_found")?;
    let relative = workspace_relative(&root.display().to_string(), raw)?;
    let mut current = root.clone();
    if !relative.is_empty() {
        for component in Path::new(&relative).components() {
            let Component::Normal(name) = component else {
                if matches!(component, Component::CurDir) {
                    continue;
                }
                return Err("path_rejected");
            };
            let next = current.join(name);
            let meta = fs::symlink_metadata(&next).map_err(|_| "not_found")?;
            if meta.file_type().is_symlink() {
                let target = fs::canonicalize(&next).map_err(|_| "path_rejected")?;
                if !target.starts_with(&root) {
                    return Err("path_rejected");
                }
                current = target;
            } else {
                current = next;
            }
        }
    }
    if !current.starts_with(&root) {
        return Err("path_rejected");
    }
    Ok(current)
}

pub fn list_directory(root: &Path, raw: &str) -> Result<(Vec<FsEntry>, bool), &'static str> {
    let dir = resolve_inside(root, raw)?;
    let meta = fs::metadata(&dir).map_err(|_| "not_found")?;
    if !meta.is_dir() {
        return Err("not_directory");
    }
    let mut names = fs::read_dir(&dir)
        .map_err(|_| "not_found")?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();
    names.sort_by_key(|entry| entry.file_name());
    let truncated = names.len() > MAX_LIST_ENTRIES;
    let mut entries = Vec::new();
    for entry in names.into_iter().take(MAX_LIST_ENTRIES) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name.contains('\0') || name.contains('/') || name.contains('\\') {
            continue;
        }
        let child = if raw.is_empty() || raw == "." {
            name.clone()
        } else {
            format!("{raw}/{name}")
        };
        let kind = if resolve_inside(root, &child)
            .is_ok_and(|path| fs::metadata(&path).is_ok_and(|meta| meta.is_dir()))
        {
            "dir"
        } else if resolve_inside(root, &child).is_err() {
            // A symlink that leaves the root is not a readable entry.
            continue;
        } else {
            "file"
        };
        entries.push(FsEntry {
            name,
            kind: kind.to_owned(),
        });
    }
    Ok((entries, truncated))
}

pub fn read_file(root: &Path, raw: &str) -> Result<(Vec<u8>, bool), &'static str> {
    let path = resolve_inside(root, raw)?;
    let meta = fs::metadata(&path).map_err(|_| "not_found")?;
    if !meta.is_file() {
        return Err("not_file");
    }
    let mut file = fs::File::open(&path).map_err(|_| "not_found")?;
    let mut buf = vec![0_u8; MAX_READ_BYTES + 1];
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("not_found"),
        }
    }
    let truncated = filled > MAX_READ_BYTES;
    buf.truncate(filled.min(MAX_READ_BYTES));
    Ok((buf, truncated))
}

pub fn safe_branch(mission_id: &str) -> Result<String, &'static str> {
    if (1..=80).contains(&mission_id.len())
        && mission_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Ok(format!("loom-{mission_id}"))
    } else {
        Err("invalid_workspace")
    }
}

pub fn prepare_git_worktree(
    source: &Path,
    worktree: &Path,
    branch: &str,
) -> Result<PreparedWorktree, &'static str> {
    if !source.is_absolute() || !worktree.is_absolute() {
        return Err("invalid_workspace");
    }
    if branch.is_empty()
        || branch.len() > 100
        || branch.contains('\0')
        || branch.contains("..")
        || !branch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'/'))
    {
        return Err("invalid_workspace");
    }
    let source = fs::canonicalize(source).map_err(|_| "invalid_workspace")?;
    if git(&source, &["rev-parse", "--is-inside-work-tree"]).trim() != "true" {
        return Err("invalid_workspace");
    }
    if worktree.exists() {
        let existing = fs::canonicalize(worktree).map_err(|_| "invalid_workspace")?;
        if git(&existing, &["rev-parse", "--is-inside-work-tree"]).trim() != "true" {
            return Err("invalid_workspace");
        }
        return prepared(&source, &existing, branch);
    }
    if let Some(parent) = worktree.parent() {
        fs::create_dir_all(parent).map_err(|_| "invalid_workspace")?;
    }
    let status = Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["worktree", "add", "-b"])
        .arg(branch)
        .arg(worktree)
        .arg("HEAD")
        .output()
        .map_err(|_| "invalid_workspace")?;
    if !status.status.success() {
        return Err("invalid_workspace");
    }
    let existing = fs::canonicalize(worktree).map_err(|_| "invalid_workspace")?;
    prepared(&source, &existing, branch)
}

fn prepared(
    source: &Path,
    worktree: &Path,
    branch: &str,
) -> Result<PreparedWorktree, &'static str> {
    let sha = git(worktree, &["rev-parse", "HEAD"]);
    let sha = sha.trim();
    if sha.len() < 7 {
        return Err("invalid_workspace");
    }
    let common = git(worktree, &["rev-parse", "--git-common-dir"]);
    let common = Path::new(common.trim());
    let common = if common.is_absolute() {
        common.to_path_buf()
    } else {
        worktree.join(common)
    };
    let common = fs::canonicalize(&common).unwrap_or(common);
    Ok(PreparedWorktree {
        worktree: worktree.display().to_string(),
        source: source.display().to_string(),
        common_dir: common.display().to_string(),
        base_sha: sha.to_owned(),
        branch: branch.to_owned(),
    })
}

fn git(cwd: &Path, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "loom-jail-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parent_and_absolute_escape_are_rejected_before_io() {
        let root = "/tmp/loom-root";
        assert_eq!(
            workspace_relative(root, "../etc/passwd"),
            Err("path_rejected")
        );
        assert_eq!(
            workspace_relative(root, "/etc/passwd"),
            Err("path_rejected")
        );
        assert_eq!(
            workspace_relative(root, "/tmp/loom-root/../etc"),
            Err("path_rejected")
        );
        assert_eq!(
            workspace_relative(root, "src/main.rs").unwrap(),
            "src/main.rs"
        );
        assert_eq!(
            workspace_relative(root, "/tmp/loom-root/src/main.rs").unwrap(),
            "src/main.rs"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_leaves_the_root_is_rejected() {
        let root = scratch("root");
        let outside = scratch("out");
        fs::write(root.join("inside.txt"), b"inside").unwrap();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("leak")).unwrap();
        assert_eq!(read_file(&root, "inside.txt").unwrap().0, b"inside");
        assert_eq!(read_file(&root, "leak"), Err("path_rejected"));
        assert_eq!(read_file(&root, "../secret.txt"), Err("path_rejected"));
        let listed = list_directory(&root, "").unwrap().0;
        assert!(listed.iter().any(|entry| entry.name == "inside.txt"));
        assert!(listed.iter().all(|entry| entry.name != "leak"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn directory_listing_stops_at_the_cap() {
        let root = scratch("list");
        for index in 0..(MAX_LIST_ENTRIES + 5) {
            fs::write(root.join(format!("f{index:03}")), b"x").unwrap();
        }
        let (entries, truncated) = list_directory(&root, "").unwrap();
        assert_eq!(entries.len(), MAX_LIST_ENTRIES);
        assert!(truncated);
        let _ = fs::remove_dir_all(&root);
    }
}
