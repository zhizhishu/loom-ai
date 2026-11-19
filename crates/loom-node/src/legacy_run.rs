//! Durable identity for the legacy Start wire. This is deliberately not the
//! R1 AgentRun protocol. No raw launch input or credential is written here.
use std::{fs::File, io::{Read, Write}, path::{Path, PathBuf}};
use rovai_private_storage::{atomic_write_private_json, create_private_new_file,
    open_private_read_file, open_private_read_write_file, prepare_private_directory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, &'static str>;
const MAX_RECORD_BYTES: u64 = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchKey {
    pub run_id: String,
    pub attempt: u32,
    pub digest: String,
}

impl LaunchKey {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        run_id: &str, attempt: u32, adapter: &str, program: &str,
        args: &[String], cwd: &str, env: &[(String, String)], shim_token: &str,
        bundle: Option<&loom_protocol::run_bundle::RunBundleV1>,
    ) -> Result<Self> {
        crate::shim::check_run_identity(run_id, attempt).map_err(|_| "invalid_run_id")?;
        if attempt == 0 { return Err("invalid_run_id"); }
        // Includes the credential only inside a domain-separated one-way digest.
        let bytes = serde_json::to_vec(&(run_id, attempt, adapter, program, args,
            cwd, env, shim_token, bundle.map(|packet| packet.digest.as_str())))
            .map_err(|_| "legacy_launch_identity")?;
        let mut hash = Sha256::new();
        hash.update(b"loom-legacy-start-v1\0");
        hash.update(bytes);
        Ok(Self { run_id: run_id.into(), attempt, digest: format!("{:x}", hash.finalize()) })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Prepared,
    Running,
    /// Only code paths that have not called a process-creation API may set this.
    NoProcess,
    /// Positive tree-empty receipt AND all output readers reached EOF.
    Finished,
    /// Spawn, cleanup or output outcome is not known. Never permits a retry.
    Unknown,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    node_id: String,
    key: LaunchKey,
    phase: Phase,
}

pub(crate) struct Journal {
    root: PathBuf,
    node_id: String,
    _owner: File,
}

impl Journal {
    pub fn open(data_dir: &Path, node_id: &str) -> Result<Self> {
        if node_id.is_empty() || node_id.len() > 128 || node_id.chars().any(char::is_control) {
            return Err("legacy_journal_identity");
        }
        let root = prepare_private_directory(&data_dir.join("legacy-runs"))
            .map_err(|_| "legacy_journal_storage")?;
        let owner = open_private_read_write_file(&root.join("owner.lock"))
            .map_err(|_| "legacy_journal_storage")?;
        lock(&owner)?;
        Ok(Self { root, node_id: node_id.into(), _owner: owner })
    }

    fn path(&self, run_id: &str) -> PathBuf {
        self.root.join(format!("{:x}.json", Sha256::digest(run_id.as_bytes())))
    }

    fn read(&self, run_id: &str) -> Result<Option<Record>> {
        let path = self.path(run_id);
        if !path.try_exists().map_err(|_| "legacy_journal_storage")? { return Ok(None); }
        let mut bytes = Vec::new();
        open_private_read_file(&path).map_err(|_| "legacy_journal_storage")?
            .take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes)
            .map_err(|_| "legacy_journal_storage")?;
        if bytes.len() as u64 > MAX_RECORD_BYTES { return Err("legacy_journal_storage"); }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| "legacy_journal_storage")?;
        if record.version != 1 || record.node_id != self.node_id ||
            record.key.run_id != run_id || record.key.attempt == 0 ||
            record.key.digest.len() != 64 ||
            !record.key.digest.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("legacy_journal_storage");
        }
        Ok(Some(record))
    }

    /// Caller also holds the in-process run registry lock. The lifetime OS file
    /// lock excludes another Node process from advancing the same journal.
    pub fn reserve(&self, key: &LaunchKey) -> Result<()> {
        let path = self.path(&key.run_id);
        let record = Record { version: 1, node_id: self.node_id.clone(),
            key: key.clone(), phase: Phase::Prepared };
        match self.read(&key.run_id)? {
            None => {
                // An absent ledger cannot attest what happened in an older attempt.
                if key.attempt != 1 { return Err("legacy_history_unknown"); }
                let mut file = create_private_new_file(&path).map_err(|_| "legacy_journal_storage")?;
                let bytes = serde_json::to_vec(&record).map_err(|_| "legacy_journal_storage")?;
                file.write_all(&bytes).and_then(|_| file.sync_all())
                    .map_err(|_| "legacy_journal_storage")?;
                #[cfg(unix)]
                File::open(&self.root).and_then(|directory| directory.sync_all())
                    .map_err(|_| "legacy_journal_storage")?;
                Ok(())
            }
            Some(previous) => {
                if previous.key.attempt == key.attempt {
                    if previous.key.digest != key.digest { return Err("legacy_start_conflict"); }
                    return Err(match previous.phase {
                        Phase::NoProcess => "legacy_no_process",
                        Phase::Finished => "process_gone",
                        _ => "legacy_outcome_unknown",
                    });
                }
                // The legacy Output/Exit/Ack frames have no attempt field. Never
                // advance after any possible spawn or unacknowledged output.
                if previous.phase != Phase::NoProcess ||
                    previous.key.attempt.checked_add(1) != Some(key.attempt) {
                    return Err("legacy_attempt_conflict");
                }
                atomic_write_private_json(&path, &record).map_err(|_| "legacy_journal_storage")
            }
        }
    }

    pub fn resume_rejection(&self, run_id: &str, attempt: u32) -> &'static str {
        match self.read(run_id) {
            Ok(Some(record)) if record.key.attempt == attempt => match record.phase {
                Phase::NoProcess => "legacy_no_process",
                Phase::Finished => "process_gone",
                _ => "legacy_outcome_unknown",
            },
            _ => "legacy_outcome_unknown",
        }
    }

    pub fn transition(&self, key: &LaunchKey, phase: Phase) -> Result<()> {
        let mut record = self.read(&key.run_id)?.ok_or("legacy_journal_storage")?;
        if record.key != *key { return Err("legacy_start_conflict"); }
        let allowed = record.phase == phase || matches!((record.phase, phase),
            (Phase::Prepared, Phase::NoProcess | Phase::Running | Phase::Unknown) |
            (Phase::Running, Phase::Finished | Phase::Unknown) |
            (Phase::Unknown, Phase::Finished));
        if !allowed { return Err("legacy_phase_conflict"); }
        record.phase = phase;
        atomic_write_private_json(&self.path(&key.run_id), &record)
            .map_err(|_| "legacy_journal_storage")
    }
}

#[cfg(unix)]
fn lock(file: &File) -> Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("legacy_journal_busy");
    }
    Ok(())
}
#[cfg(windows)]
fn lock(file: &File) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY},
        System::IO::OVERLAPPED};
    let mut overlapped = OVERLAPPED::default();
    if unsafe { LockFileEx(file.as_raw_handle(), LOCKFILE_EXCLUSIVE_LOCK |
        LOCKFILE_FAIL_IMMEDIATELY, 0, u32::MAX, u32::MAX, &mut overlapped) } == 0 {
        return Err("legacy_journal_busy");
    }
    Ok(())
}
#[cfg(not(any(unix, windows)))]
fn lock(_: &File) -> Result<()> { Err("legacy_platform_unsupported") }

/// Matches the bounded, non-secret launch policy used by the typed process wire.
/// No ambient A HOME/PATH/provider token may become a Node environment override.
pub(crate) fn validate_environment(values: &[(String, String)]) -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    if values.len() > 16 { return Err("legacy_environment"); }
    for (name, value) in values {
        let allowed = match name.as_str() {
            "NO_COLOR" | "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS" |
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY" | "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" =>
                matches!(value.as_str(), "0" | "1"),
            "PYTHONIOENCODING" => matches!(value.as_str(), "utf-8" | "utf-8:strict"),
            _ => false,
        };
        if !allowed || !seen.insert(name.to_ascii_uppercase()) {
            return Err("legacy_environment");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(attempt: u32) -> LaunchKey {
        LaunchKey::new("run_owned", attempt, "codex-cli", "/owned/codex",
            &["fixture".into()], "/owned/work", &[], &"a".repeat(64), None).unwrap()
    }
    #[test]
    fn legacy_journal_reopen_rejects_consumed_identity_and_only_no_process_can_retry() {
        let root = std::env::temp_dir().join(format!("loom-legacy-journal-{}", uuid::Uuid::new_v4()));
        let journal = Journal::open(&root, "node_owned").unwrap();
        assert!(Journal::open(&root, "node_owned").is_err(), "two journal owners");
        let first = key(1);
        journal.reserve(&first).unwrap();
        assert_eq!(journal.reserve(&first), Err("legacy_outcome_unknown"));
        let mut conflict = first.clone(); conflict.digest = "b".repeat(64);
        assert_eq!(journal.reserve(&conflict), Err("legacy_start_conflict"));
        assert_eq!(journal.reserve(&key(2)), Err("legacy_attempt_conflict"));
        journal.transition(&first, Phase::NoProcess).unwrap();
        assert_eq!(journal.resume_rejection("run_owned", 1), "legacy_no_process");
        let second = key(2);
        journal.reserve(&second).unwrap();
        journal.transition(&second, Phase::Running).unwrap();
        assert!(journal.transition(&second, Phase::NoProcess).is_err());
        journal.transition(&second, Phase::Finished).unwrap();
        // Disk persistence owner only; the actual ACK/replay seam needs the planned native wire owner.
        drop(journal);
        let reopened = Journal::open(&root, "node_owned").unwrap();
        assert_eq!(reopened.reserve(&second), Err("process_gone"));
        assert_eq!(reopened.reserve(&key(3)), Err("legacy_attempt_conflict"));
        let bytes = std::fs::read(reopened.path(&first.run_id)).unwrap();
        assert!(!String::from_utf8(bytes).unwrap().contains(&"a".repeat(64)));
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_environment_is_closed_before_materialization() {
        for name in ["HOME", "PATH", "USERPROFILE", "CODEX_HOME",
            "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "no_color"] {
            assert_eq!(validate_environment(&[(name.into(), "1".into())]),
                Err("legacy_environment"));
        }
        assert!(validate_environment(&[("NO_COLOR".into(), "1".into())]).is_ok());
        assert!(validate_environment(&[("NO_COLOR".into(), "1".into()),
            ("NO_COLOR".into(), "0".into())]).is_err());
    }
}
