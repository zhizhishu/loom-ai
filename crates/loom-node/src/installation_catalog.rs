//! Persistent installation facts for a node's own CLI catalog.
//! Generations change only with the admitted native path or executable identity.
//! Socket reconnects never invent an installation generation.
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};
use loom_protocol::CliReport;
use serde::{Deserialize, Serialize};

const MAX_LEDGER_BYTES: usize = 1024 * 1024;
const MAX_INSTALLATIONS: usize = 64;
const MAX_GENERATION: u64 = (1_u64 << 53) - 1;
type CatalogResult<T> = Result<T, &'static str>;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    source_path: String,
    native_path: String,
    identity: String,
    generation: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    version: u32,
    installations: BTreeMap<String, Installation>,
}
pub(crate) struct Candidate {
    pub(crate) report: CliReport,
    pub(crate) source_path: PathBuf,
}
pub(crate) struct InstallationCatalog {
    journal_path: PathBuf,
    ledger: Ledger,
    _lease: File,
}
impl std::fmt::Debug for InstallationCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstallationCatalog")
            .field("installation_count", &self.ledger.installations.len())
            .finish_non_exhaustive()
    }
}
impl InstallationCatalog {
    pub(crate) fn open(data_dir: &Path) -> CatalogResult<Self> {
        let root = private_directory(&data_dir.join("installation-catalog"))?;
        let lease = open_lease(&root.join("catalog.lock"))?;
        lease.try_lock().map_err(|_| "pipe_catalog_in_use")?;
        let journal_path = root.join("installations.json");
        let ledger = if journal_path.exists() {
            read_ledger(&journal_path)?
        } else {
            let empty = Ledger { version: 1, installations: BTreeMap::new() };
            persist(&journal_path, &empty)?;
            empty
        };
        Ok(Self { journal_path, ledger, _lease: lease })
    }

    pub(crate) fn publish(&mut self, candidates: Vec<Candidate>) -> CatalogResult<Vec<CliReport>> {
        if candidates.len() > MAX_INSTALLATIONS {
            return Err("pipe_catalog_limit");
        }
        let mut next = self.ledger.clone();
        let mut reports = Vec::with_capacity(candidates.len());
        let mut seen = std::collections::BTreeSet::new();
        for candidate in candidates {
            let mut report = candidate.report;
            report.installation_identity = None;
            report.installation_generation = None;
            if !loom_protocol::process_pipe::valid_id(&report.adapter_kind)
                || !seen.insert(report.adapter_kind.clone()) {
                return Err("pipe_catalog_invalid");
            }
            let Some(native) = resolve_native_entrypoint(&candidate.source_path, &report.adapter_kind) else {
                report.path_present = false;
                report.version = None;
                reports.push(report);
                continue;
            };
            let identity = match rovai_process_boundary::inspect_application_identity(&native) {
                Ok(identity) if valid_identity(&identity) => identity,
                _ => {
                    report.path_present = false;
                    report.version = None;
                    reports.push(report);
                    continue;
                }
            };
            let generation = match next.installations.get(&report.adapter_kind) {
                Some(previous) if previous.identity == identity
                    && previous.native_path == native.to_string_lossy() => previous.generation,
                Some(previous) => previous.generation.checked_add(1)
                    .filter(|value| *value <= MAX_GENERATION).ok_or("pipe_catalog_generation")?,
                None => 1,
            };
            let source = candidate.source_path.canonicalize().map_err(|_| "pipe_catalog_source")?;
            let installation = Installation {
                source_path: source.to_string_lossy().into_owned(),
                native_path: native.to_string_lossy().into_owned(),
                identity: identity.clone(),
                generation,
            };
            if installation.source_path.len() > 32768 || installation.native_path.len() > 32768 {
                return Err("pipe_catalog_path");
            }
            report.path = installation.native_path.clone();
            report.path_present = true;
            report.installation_identity = Some(identity);
            report.installation_generation = Some(generation);
            next.installations.insert(report.adapter_kind.clone(), installation);
            reports.push(report);
        }
        if next.installations.len() > MAX_INSTALLATIONS { return Err("pipe_catalog_limit"); }
        if next != self.ledger {
            persist(&self.journal_path, &next)?;
            self.ledger = next;
        }
        Ok(reports)
    }

    /// Re-check source wrapper layout and the exact native image on every Open.
    /// ProcessSpec then captures that same identity and checks it again at spawn.
    pub(crate) fn admit(
        &self, adapter_kind: &str, program: &str, identity: &str, generation: u64,
    ) -> CatalogResult<PathBuf> {
        let entry = self.ledger.installations.get(adapter_kind).ok_or("pipe_cli_unreported")?;
        if !valid_identity(identity) || identity != entry.identity || generation != entry.generation {
            return Err("pipe_installation_changed");
        }
        let native = resolve_native_entrypoint(Path::new(&entry.source_path), adapter_kind)
            .ok_or("pipe_entrypoint_changed")?;
        let expected = Path::new(&entry.native_path).canonicalize().map_err(|_| "pipe_installation_changed")?;
        let requested = Path::new(program).canonicalize().map_err(|_| "pipe_installation_changed")?;
        if native != expected || requested != expected {
            return Err("pipe_installation_changed");
        }
        let current = rovai_process_boundary::inspect_application_identity(&native)
            .map_err(|_| "pipe_installation_changed")?;
        if current != identity { return Err("pipe_installation_changed"); }
        Ok(native)
    }
}

/// An unknown Windows batch file is metadata only; it is never executed to probe
/// a version or to launch an R1 process. Only the existing closed official
/// Codex layout and the explicit native Claude npm layout are recognized.
pub(crate) fn resolve_native_entrypoint(path: &Path, adapter_kind: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if path.extension().is_some_and(|suffix| suffix.eq_ignore_ascii_case("exe")) {
            return path.is_file().then(|| path.canonicalize().ok()).flatten();
        }
        if path.extension().is_some_and(|suffix| suffix.eq_ignore_ascii_case("cmd")) {
            return match adapter_kind {
                "codex-cli" => rovai_runtime_entrypoint::inspect_codex_cmd_shim(path).map(|resolved| resolved.executable),
                "claude-code" | "claude-code-cli" => rovai_runtime_entrypoint::inspect_claude_cmd_shim(path),
                _ => None,
            };
        }
        None
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = adapter_kind;
        let native = path.canonicalize().ok()?;
        let metadata = native.metadata().ok()?;
        (metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).then_some(native)
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = (path, adapter_kind); None }
}
pub(crate) fn valid_identity(identity: &str) -> bool {
    identity.strip_prefix("sha256:").is_some_and(|hex| hex.len() == 64
        && hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}
fn validate_ledger(ledger: &Ledger) -> CatalogResult<()> {
    if ledger.version != 1 || ledger.installations.len() > MAX_INSTALLATIONS {
        return Err("pipe_catalog_invalid");
    }
    for (kind, item) in &ledger.installations {
        if !loom_protocol::process_pipe::valid_id(kind)
            || !valid_identity(&item.identity)
            || !(1..=MAX_GENERATION).contains(&item.generation)
            || [&item.source_path, &item.native_path].into_iter().any(|path|
                path.len() > 32768 || !Path::new(path).is_absolute() || path.contains('\0')) {
            return Err("pipe_catalog_invalid");
        }
    }
    Ok(())
}
fn persist(path: &Path, ledger: &Ledger) -> CatalogResult<()> {
    validate_ledger(ledger)?;
    let bytes = serde_json::to_vec(ledger).map_err(|_| "pipe_catalog_encoding")?;
    if bytes.len() > MAX_LEDGER_BYTES { return Err("pipe_catalog_limit"); }
    rovai_private_storage::atomic_write_private_bytes(path, &bytes)
        .map_err(|_| "pipe_catalog_persist")
}
fn read_ledger(path: &Path) -> CatalogResult<Ledger> {
    let file = rovai_private_storage::open_private_read_file(path).map_err(|_| "pipe_catalog_storage")?;
    let mut bytes = Vec::new();
    file.take(MAX_LEDGER_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| "pipe_catalog_storage")?;
    if bytes.len() > MAX_LEDGER_BYTES { return Err("pipe_catalog_limit"); }
    let ledger = serde_json::from_slice(&bytes).map_err(|_| "pipe_catalog_invalid")?;
    validate_ledger(&ledger)?;
    Ok(ledger)
}
fn private_directory(path: &Path) -> CatalogResult<PathBuf> {
    #[cfg(windows)]
    {
        if path.exists() {
            rovai_private_storage::admit_private_directory(path).map_err(|_| "pipe_catalog_storage")
        } else {
            rovai_private_storage::create_private_directory(path).map_err(|_| "pipe_catalog_storage")
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if !path.exists() {
            fs::DirBuilder::new().mode(0o700).create(path).map_err(|_| "pipe_catalog_storage")?;
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| "pipe_catalog_storage")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.permissions().mode() & 0o077 != 0 {
            return Err("pipe_catalog_storage");
        }
        path.canonicalize().map_err(|_| "pipe_catalog_storage")
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = path; Err("pipe_catalog_storage") }
}
fn open_lease(path: &Path) -> CatalogResult<File> {
    #[cfg(windows)]
    { rovai_private_storage::open_private_read_write_file(path).map_err(|_| "pipe_catalog_storage") }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)
            .map_err(|_| "pipe_catalog_storage")
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = path; Err("pipe_catalog_storage") }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(path: &Path) -> Candidate {
        Candidate { source_path: path.to_path_buf(), report: CliReport {
            adapter_kind: "codex-cli".into(), path: path.to_string_lossy().into_owned(),
            version: None, path_present: true, installation_identity: None, installation_generation: None,
        }}
    }
    #[test]
    fn installation_generation_survives_reopen_and_changes_with_native_binding() {
        let root = std::env::temp_dir().join(format!("loom-catalog-owner-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("native.exe");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut catalog = InstallationCatalog::open(&root).unwrap();
        assert!(InstallationCatalog::open(&root).is_err(), "second catalog owner must not reset generation");
        let first = catalog.publish(vec![candidate(&executable)]).unwrap().remove(0);
        let again = catalog.publish(vec![candidate(&executable)]).unwrap().remove(0);
        assert_eq!(first.installation_generation, Some(1));
        assert_eq!(first.installation_identity, again.installation_identity);
        assert_eq!(first.installation_generation, again.installation_generation);
        catalog.admit("codex-cli", &first.path, first.installation_identity.as_deref().unwrap(), 1).unwrap();
        drop(catalog);
        let mut catalog = InstallationCatalog::open(&root).unwrap();
        let reopened = catalog.publish(vec![candidate(&executable)]).unwrap().remove(0);
        assert_eq!(reopened.installation_generation, Some(1));
        let mut bytes = fs::read(&executable).unwrap();
        bytes.push(1); // identity-only fixture; never executed
        fs::write(&executable, bytes).unwrap();
        assert_eq!(catalog.admit("codex-cli", &first.path, first.installation_identity.as_deref().unwrap(), 1).unwrap_err(), "pipe_installation_changed");
        let replaced = catalog.publish(vec![candidate(&executable)]).unwrap().remove(0);
        assert_eq!(replaced.installation_generation, Some(2));
        assert_ne!(replaced.installation_identity, first.installation_identity);
        let moved = root.join("moved.exe");
        fs::rename(&executable, &moved).unwrap();
        let relocated = catalog.publish(vec![candidate(&moved)]).unwrap().remove(0);
        assert_eq!(relocated.installation_generation, Some(3));
        assert_ne!(relocated.path, replaced.path);
        assert_eq!(catalog.admit("codex-cli", &replaced.path, replaced.installation_identity.as_deref().unwrap(), 2).unwrap_err(), "pipe_installation_changed");
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }
}
