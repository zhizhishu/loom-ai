//! A-side private durable bounded output journal for the frozen process_pipe wire.
//!
//! This is a journal, not native input acceptance, not an end-to-end PASS, and
//! not process-tree cleanup. It durably stores bounded pending
//! [`ProcessOutputEvent`] values plus recent consumed `seq`+`digest` receipts in
//! one atomic private JSON document, keyed by the wire [`RemoteProcessKey`].
//!
//! The caller persists each validated contiguous event *before* reporting
//! `Durable`, and only then sends the network ACK. Identical duplicates at a
//! known sequence are accepted without rewriting bytes. A new controller may
//! inspect a retained journal through [`inspect_existing`] /
//! [`inspect_directory`]; it can never open a second writable spool for a key
//! that already has a child directory, and it never inherits native parser
//! continuity.
//!
//! Everything user-visible is bounded: this file never allocates from file size
//! or content, never lists directories, and never deletes them.

use std::{
    fmt, fs,
    path::{Path, PathBuf},
};

use loom_protocol::process_pipe::{
    MAX_SAFE_COUNTER, PipeStream, ProcessOutputBody, ProcessOutputEvent, RemoteProcessKey, digest,
    valid_id,
};
use serde::{Deserialize, Serialize};

pub const SPOOL_VERSION: u32 = 1;
/// Pending stream events kept for replay before the caller must consume.
pub const MAX_PENDING_EVENTS: usize = 128;
/// Encoded bytes of the pending events alone, as one bounded durable window.
pub const MAX_PENDING_BYTES: usize = 2 * 1024 * 1024;
/// Consumed receipts retained for duplicate detection.
pub const MAX_RECEIPTS: usize = 128;
/// Hard file bound; checked before every atomic publication.
pub const MAX_JOURNAL_BYTES: usize = 4 * 1024 * 1024;

const CHILD_PREFIX: &str = "spool-";
const JOURNAL_FILE: &str = "journal.json";

/// Stable, payload-free failure. No variant carries output bytes, codes, ids or
/// native error text, so `Debug`/`Display` can never leak what was refused.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SpoolError {
    /// Event or requested journal identity does not belong to this spool.
    Identity,
    /// Native wire validation of the event failed before any journal work.
    EventInvalid,
    /// Sequence is beyond the next contiguous position.
    SequenceGap,
    /// Sequence is older than the retained receipt window and is not pending.
    SequenceRetired,
    /// Same sequence, different event digest.
    SequenceConflict,
    /// Pending count or pending byte budget is exhausted.
    PendingFull,
    /// A single event exceeds the whole pending byte budget.
    EventTooLarge,
    /// `Exited` is already recorded, so nothing may follow it.
    TerminalRecorded,
    /// Consumption does not name the earliest pending event of that stream.
    ConsumeOrder,
    /// The deterministic child directory for this key already exists.
    JournalExists,
    /// Serialized journal or read file exceeds [`MAX_JOURNAL_BYTES`].
    JournalTooLarge,
    /// Stored journal is invalid, tampered, or not this key's journal.
    JournalCorrupt,
    /// Native private directory creation or admission failed.
    Storage,
    /// Publication failed. The caller must treat the outcome as unknown.
    Persist,
}

impl SpoolError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Identity => "pipe_spool_identity",
            Self::EventInvalid => "pipe_spool_event_invalid",
            Self::SequenceGap => "pipe_spool_gap",
            Self::SequenceRetired => "pipe_spool_retired",
            Self::SequenceConflict => "pipe_spool_conflict",
            Self::PendingFull => "pipe_spool_pending_full",
            Self::EventTooLarge => "pipe_spool_event_limit",
            Self::TerminalRecorded => "pipe_spool_terminal",
            Self::ConsumeOrder => "pipe_spool_consume_order",
            Self::JournalExists => "pipe_spool_exists",
            Self::JournalTooLarge => "pipe_spool_limit",
            Self::JournalCorrupt => "pipe_spool_invalid",
            Self::Storage => "pipe_spool_storage",
            Self::Persist => "pipe_spool_persist",
        }
    }
}

impl fmt::Display for SpoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for SpoolError {}

/// Exact journal identity: wire process key plus the controller generation and
/// the launch digest evidence hex64. No argv, environment, task or program is
/// ever persisted.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalIdentity {
    pub key: RemoteProcessKey,
    pub controller_id: String,
    pub launch_digest: String,
}

impl JournalIdentity {
    pub fn new(
        key: RemoteProcessKey,
        controller_id: String,
        launch_digest: String,
    ) -> Result<Self, SpoolError> {
        let identity = Self {
            key,
            controller_id,
            launch_digest,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn validate(&self) -> Result<(), SpoolError> {
        self.key.validate().map_err(|_| SpoolError::Identity)?;
        if !valid_id(&self.controller_id) || !is_hex64(&self.launch_digest) {
            return Err(SpoolError::Identity);
        }
        Ok(())
    }

    pub fn key(&self) -> &RemoteProcessKey {
        &self.key
    }

    pub fn controller_id(&self) -> &str {
        &self.controller_id
    }

    pub fn launch_digest(&self) -> &str {
        &self.launch_digest
    }
}

/// Terminal summary retained after `Exited`. Its sequence and digest are kept so
/// a duplicate `Exited` stays idempotent and evidence is not lost.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSummary {
    pub event_seq: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub digest: String,
}

/// Result of a durable append or a recognized identical duplicate. The caller
/// ACKs `event_seq` only after this value was returned.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Durable {
    pub event_seq: u64,
    /// Highest contiguous sequence the journal has durably stored.
    pub highest_seq: u64,
    /// True when the identical event was already durable and no bytes changed.
    pub duplicate: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolSnapshot {
    pub identity: JournalIdentity,
    pub highest_received_seq: u64,
    pub pending_events: usize,
    pub pending_bytes: usize,
    pub receipts: usize,
    /// True once A intentionally abandoned further output for this process.
    pub output_abandoned: bool,
    pub terminal: Option<TerminalSummary>,
}

/// Retained-journal state a new controller may act on. It never claims native
/// parser continuity.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OrphanState {
    /// No `Exited` was recorded: the process outcome is unknown.
    Unterminated,
    /// `Exited` was recorded but stream output is still unreconciled.
    ExitedWithPending,
    /// `Exited` was recorded and no stream output remains pending.
    Drained,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingEvent {
    event_seq: u64,
    digest: String,
    event: ProcessOutputEvent,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    event_seq: u64,
    digest: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    identity: JournalIdentity,
    highest_received_seq: u64,
    pending: Vec<PendingEvent>,
    receipts: Vec<Receipt>,
    /// Set only when A explicitly abandons a cancelled native consumer's output.
    /// Older v1 journals without the field decode as `false`.
    #[serde(default)]
    output_abandoned: bool,
    terminal: Option<TerminalSummary>,
}

impl Journal {
    fn empty(identity: JournalIdentity) -> Self {
        Self {
            version: SPOOL_VERSION,
            identity,
            highest_received_seq: 0,
            pending: Vec::new(),
            receipts: Vec::new(),
            output_abandoned: false,
            terminal: None,
        }
    }

    /// Digest evidence for a known sequence, from pending, receipts or terminal.
    fn known_digest(&self, event_seq: u64) -> Option<&str> {
        if let Some(entry) = self.pending.iter().find(|entry| entry.event_seq == event_seq) {
            return Some(&entry.digest);
        }
        if let Some(receipt) = self.receipts.iter().find(|receipt| receipt.event_seq == event_seq) {
            return Some(&receipt.digest);
        }
        self.terminal
            .as_ref()
            .filter(|terminal| terminal.event_seq == event_seq)
            .map(|terminal| terminal.digest.as_str())
    }

    fn pending_bytes(&self) -> Result<usize, SpoolError> {
        self.pending.iter().try_fold(0usize, |total, entry| {
            total
                .checked_add(encoded_len(&entry.event)?)
                .ok_or(SpoolError::PendingFull)
        })
    }
}

/// Counts only. Event bodies are never formatted, even indirectly.
impl fmt::Debug for Journal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Journal")
            .field("version", &self.version)
            .field("identity", &self.identity)
            .field("highestReceivedSeq", &self.highest_received_seq)
            .field("pendingEvents", &self.pending.len())
            .field("pendingBytes", &self.pending_bytes().unwrap_or(0))
            .field("receipts", &self.receipts.len())
            .field("outputAbandoned", &self.output_abandoned)
            .field(
                "terminalSeq",
                &self.terminal.as_ref().map(|terminal| terminal.event_seq),
            )
            .finish_non_exhaustive()
    }
}

/// Publication seam. Production always uses [`persist_private_journal`]; tests
/// inject a pre-publication failure without weakening any native permission.
type Persist = fn(&Path, &Journal) -> Result<(), SpoolError>;

/// One live spool. Single owner, `&mut self`: no interior lock and no shared
/// handle, so the caller can hand bytes to the native driver between calls.
pub struct Spool {
    path: PathBuf,
    journal: Journal,
    persist: Persist,
}

impl Spool {
    /// Creates exactly one fresh deterministic child directory for `key` and
    /// writes the empty journal. An existing child is refused, so a new
    /// controller/launch identity can never open a second live spool for a key
    /// that was already used. Nothing is deleted when creation fails.
    pub fn create(root: &Path, identity: JournalIdentity) -> Result<Self, SpoolError> {
        identity.validate()?;
        let directory = root.join(child_name(&identity.key)?);
        if fs::symlink_metadata(&directory).is_ok() {
            return Err(SpoolError::JournalExists);
        }
        let directory = new_private_child(&directory)?;
        let path = directory.join(JOURNAL_FILE);
        let journal = Journal::empty(identity);
        persist_private_journal(&path, &journal)?;
        Ok(Self {
            path,
            journal,
            persist: persist_private_journal,
        })
    }

    pub fn journal_path(&self) -> &Path {
        &self.path
    }

    pub fn identity(&self) -> &JournalIdentity {
        &self.journal.identity
    }

    pub fn highest_received_seq(&self) -> u64 {
        self.journal.highest_received_seq
    }

    pub fn terminal(&self) -> Option<&TerminalSummary> {
        self.journal.terminal.as_ref()
    }

    pub fn snapshot(&self) -> SpoolSnapshot {
        snapshot_of(&self.journal)
    }

    /// Records that A deliberately abandoned further output for this process
    /// after a cancelled native consumer. The decision is persisted before it is
    /// reflected in memory, is idempotent, and is never cleared. It changes no
    /// cursor, consumes no pending bytes and deletes nothing: it is an
    /// intentional-loss decision only, not tree cleanup or native acceptance.
    pub fn mark_output_abandoned(&mut self) -> Result<(), SpoolError> {
        if self.journal.output_abandoned {
            return Ok(());
        }
        let mut next = self.journal.clone();
        next.output_abandoned = true;
        self.persist_journal(&next)?;
        self.journal = next;
        Ok(())
    }

    /// Validates the native wire event, then journals it durably. The order is:
    /// build the next journal, publish atomically, and only then advance memory.
    /// Any error leaves the in-memory cursor unchanged. A `Persist` error means
    /// the caller must not ACK and must treat the durable outcome as unknown:
    /// native publication may already have happened before the error was seen.
    pub fn record(&mut self, event: ProcessOutputEvent) -> Result<Durable, SpoolError> {
        event.validate().map_err(|_| SpoolError::EventInvalid)?;
        if event.key != self.journal.identity.key {
            return Err(SpoolError::Identity);
        }
        let pending_digest = event_digest(&event)?;
        let event_seq = event.event_seq;
        if let Some(known) = self.journal.known_digest(event_seq).map(str::to_owned) {
            if known != pending_digest {
                return Err(SpoolError::SequenceConflict);
            }
            return Ok(Durable {
                event_seq,
                highest_seq: self.journal.highest_received_seq,
                duplicate: true,
            });
        }
        if event_seq <= self.journal.highest_received_seq {
            // Older than the bounded receipt window: retired evidence must never
            // authorize replay of bytes that are no longer retained.
            return Err(SpoolError::SequenceRetired);
        }
        if event_seq != self.journal.highest_received_seq + 1 {
            return Err(SpoolError::SequenceGap);
        }
        let mut next = self.journal.clone();
        if next.terminal.is_some() {
            // Nothing can follow a recorded `Exited`.
            return Err(SpoolError::TerminalRecorded);
        }
        match &event.body {
            ProcessOutputBody::Exited { exit_code, signal } => {
                next.terminal = Some(TerminalSummary {
                    event_seq,
                    exit_code: *exit_code,
                    signal: *signal,
                    digest: pending_digest,
                });
            }
            ProcessOutputBody::Output { .. } | ProcessOutputBody::OutputFault { .. } => {
                let bytes = encoded_len(&event)?;
                if bytes > MAX_PENDING_BYTES {
                    return Err(SpoolError::EventTooLarge);
                }
                if next.pending.len() >= MAX_PENDING_EVENTS {
                    return Err(SpoolError::PendingFull);
                }
                let total = next
                    .pending_bytes()?
                    .checked_add(bytes)
                    .ok_or(SpoolError::PendingFull)?;
                if total > MAX_PENDING_BYTES {
                    return Err(SpoolError::PendingFull);
                }
                next.pending.push(PendingEvent {
                    event_seq,
                    digest: pending_digest,
                    event,
                });
            }
        }
        next.highest_received_seq = event_seq;
        self.persist_journal(&next)?;
        let highest_seq = next.highest_received_seq;
        self.journal = next;
        Ok(Durable {
            event_seq,
            highest_seq,
            duplicate: false,
        })
    }

    /// Earliest pending `Output`/`OutputFault` of that stream, cloned. Because
    /// pending events stay in sequence order, every earlier byte of the stream
    /// is delivered before a fault can be returned.
    pub fn pending_for_stream(&self, stream: PipeStream) -> Option<ProcessOutputEvent> {
        self.journal
            .pending
            .iter()
            .find(|entry| stream_of(&entry.event) == Some(stream))
            .map(|entry| entry.event.clone())
    }

    /// Records that the reader already returned every byte of `event_seq` to the
    /// native driver. Requires the earliest pending event of that stream.
    pub fn consume_stream_event(
        &mut self,
        event_seq: u64,
        stream: PipeStream,
    ) -> Result<(), SpoolError> {
        let index = self
            .journal
            .pending
            .iter()
            .position(|entry| stream_of(&entry.event) == Some(stream));
        let Some(index) = index else {
            return Err(SpoolError::ConsumeOrder);
        };
        if self.journal.pending[index].event_seq != event_seq {
            return Err(SpoolError::ConsumeOrder);
        }
        let mut next = self.journal.clone();
        let consumed = next.pending.remove(index);
        let position = next
            .receipts
            .partition_point(|receipt| receipt.event_seq < consumed.event_seq);
        next.receipts.insert(
            position,
            Receipt {
                event_seq: consumed.event_seq,
                digest: consumed.digest,
            },
        );
        while next.receipts.len() > MAX_RECEIPTS {
            next.receipts.remove(0);
        }
        self.persist_journal(&next)?;
        self.journal = next;
        Ok(())
    }

    /// Stream EOF is only reported after `Exited` and only when that stream has
    /// no pending event left.
    pub fn stream_finished(&self, stream: PipeStream) -> bool {
        self.journal.terminal.is_some()
            && !self
                .journal
                .pending
                .iter()
                .any(|entry| stream_of(&entry.event) == Some(stream))
    }

    fn persist_journal(&self, journal: &Journal) -> Result<(), SpoolError> {
        (self.persist)(&self.path, journal)
    }

    #[cfg(test)]
    fn use_persistence(&mut self, persist: Persist) {
        self.persist = persist;
    }
}

impl fmt::Debug for Spool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Spool")
            .field("journal", &self.journal)
            .field("pathPresent", &self.path.exists())
            .finish_non_exhaustive()
    }
}

/// Read-only retained journal. It has no mutating method, so a new controller
/// cannot adopt or rewrite it through this type.
pub struct OrphanJournal {
    journal: Journal,
}

impl OrphanJournal {
    pub fn identity(&self) -> &JournalIdentity {
        &self.journal.identity
    }

    pub fn state(&self) -> OrphanState {
        match (&self.journal.terminal, self.journal.pending.is_empty()) {
            (Some(_), true) => OrphanState::Drained,
            (Some(_), false) => OrphanState::ExitedWithPending,
            (None, _) => OrphanState::Unterminated,
        }
    }

    pub fn highest_received_seq(&self) -> u64 {
        self.journal.highest_received_seq
    }

    pub fn pending_count(&self) -> usize {
        self.journal.pending.len()
    }

    pub fn pending_bytes(&self) -> usize {
        self.journal.pending_bytes().unwrap_or(0)
    }

    pub fn receipt_count(&self) -> usize {
        self.journal.receipts.len()
    }

    pub fn output_abandoned(&self) -> bool {
        self.journal.output_abandoned
    }

    pub fn terminal(&self) -> Option<&TerminalSummary> {
        self.journal.terminal.as_ref()
    }

    pub fn earliest_pending(&self) -> Option<&ProcessOutputEvent> {
        self.journal.pending.first().map(|entry| &entry.event)
    }

    pub fn snapshot(&self) -> SpoolSnapshot {
        snapshot_of(&self.journal)
    }
}

impl fmt::Debug for OrphanJournal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OrphanJournal")
            .field("journal", &self.journal)
            .field("state", &self.state())
            .finish_non_exhaustive()
    }
}

/// Inspects the retained journal this exact identity would own. Validates the
/// stored identity, digests, bounds and coverage, and returns only a read-only
/// snapshot; it never creates, writes or deletes anything.
pub fn inspect_existing(root: &Path, identity: &JournalIdentity) -> Result<OrphanJournal, SpoolError> {
    identity.validate()?;
    inspect_child(root, &child_name(&identity.key)?, Some(identity))
}

/// Inspects one retained child of a caller-provided isolated root by name, for a
/// bounded startup listing. `name` must be exactly `spool-<64 lowercase hex>`
/// and the stored journal's own key hash must equal it. This module never
/// lists, scans or deletes directories itself.
pub fn inspect_directory(root: &Path, name: &str) -> Result<OrphanJournal, SpoolError> {
    if !valid_child_name(name) {
        return Err(SpoolError::JournalCorrupt);
    }
    inspect_child(root, name, None)
}

fn inspect_child(
    root: &Path,
    name: &str,
    expected: Option<&JournalIdentity>,
) -> Result<OrphanJournal, SpoolError> {
    let directory = root.join(name);
    admit_private_directory(&directory)?;
    let journal = read_journal(&directory.join(JOURNAL_FILE))?;
    if let Some(expected) = expected
        && journal.identity != *expected
    {
        return Err(SpoolError::Identity);
    }
    if child_name(&journal.identity.key)? != name {
        return Err(SpoolError::JournalCorrupt);
    }
    Ok(OrphanJournal { journal })
}

fn snapshot_of(journal: &Journal) -> SpoolSnapshot {
    SpoolSnapshot {
        identity: journal.identity.clone(),
        highest_received_seq: journal.highest_received_seq,
        pending_events: journal.pending.len(),
        // A validated journal always re-serializes; the fallback only avoids a
        // panic in a reporting path.
        pending_bytes: journal.pending_bytes().unwrap_or(0),
        receipts: journal.receipts.len(),
        output_abandoned: journal.output_abandoned,
        terminal: journal.terminal.clone(),
    }
}

fn stream_of(event: &ProcessOutputEvent) -> Option<PipeStream> {
    match &event.body {
        ProcessOutputBody::Output { stream, .. } | ProcessOutputBody::OutputFault { stream, .. } => {
            Some(*stream)
        }
        ProcessOutputBody::Exited { .. } => None,
    }
}

fn encoded_len(event: &ProcessOutputEvent) -> Result<usize, SpoolError> {
    serde_json::to_vec(event)
        .map(|bytes| bytes.len())
        .map_err(|_| SpoolError::EventInvalid)
}

fn event_digest(event: &ProcessOutputEvent) -> Result<String, SpoolError> {
    serde_json::to_vec(event)
        .map(|bytes| digest(&bytes))
        .map_err(|_| SpoolError::EventInvalid)
}

/// The child directory name hashes the wire `RemoteProcessKey` only. Two launch
/// or controller identities for one used key must map to the same child, so a
/// second live spool cannot exist beside the first.
fn child_name(key: &RemoteProcessKey) -> Result<String, SpoolError> {
    key.validate().map_err(|_| SpoolError::Identity)?;
    let bytes = serde_json::to_vec(key).map_err(|_| SpoolError::Identity)?;
    Ok(format!("{CHILD_PREFIX}{}", digest(&bytes)))
}

fn valid_child_name(name: &str) -> bool {
    name.strip_prefix(CHILD_PREFIX).is_some_and(is_hex64)
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Creates exactly one new private directory. Windows uses the native protected
/// DACL, local-fixed-NTFS, non-reparse creation path; POSIX uses a 0700 leaf and
/// re-verifies it. No permission is faked or widened.
fn new_private_child(path: &Path) -> Result<PathBuf, SpoolError> {
    #[cfg(any(unix, windows))]
    {
        let directory = {
            #[cfg(windows)]
            {
                rovai_private_storage::create_private_directory(path)
                    .map_err(|_| SpoolError::Storage)?
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(path)
                    .map_err(|_| SpoolError::Storage)?;
                path.to_path_buf()
            }
        };
        admit_private_directory(&directory)?;
        directory.canonicalize().map_err(|_| SpoolError::Storage)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(SpoolError::Storage)
    }
}

/// Admits one existing private directory without creating a missing leaf.
fn admit_private_directory(path: &Path) -> Result<(), SpoolError> {
    #[cfg(any(unix, windows))]
    {
        #[cfg(windows)]
        {
            rovai_private_storage::admit_private_directory(path)
                .map(|_| ())
                .map_err(|_| SpoolError::Storage)
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = fs::symlink_metadata(path).map_err(|_| SpoolError::Storage)?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.permissions().mode() & 0o077 != 0
            {
                return Err(SpoolError::Storage);
            }
            Ok(())
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(SpoolError::Storage)
    }
}

/// Publishes the exact bytes that were size-checked, through a private sibling.
fn persist_private_journal(path: &Path, journal: &Journal) -> Result<(), SpoolError> {
    let bytes = serde_json::to_vec(journal).map_err(|_| SpoolError::Persist)?;
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err(SpoolError::JournalTooLarge);
    }
    rovai_private_storage::atomic_write_private_bytes(path, &bytes)
        .map_err(|_| SpoolError::Persist)
}

fn read_journal(path: &Path) -> Result<Journal, SpoolError> {
    #[cfg(any(unix, windows))]
    {
        use std::io::Read;
        let file = rovai_private_storage::open_private_read_file(path)
            .map_err(|_| SpoolError::JournalCorrupt)?;
        let mut bytes = Vec::new();
        Read::take(file, MAX_JOURNAL_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| SpoolError::JournalCorrupt)?;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(SpoolError::JournalTooLarge);
        }
        let journal: Journal =
            serde_json::from_slice(&bytes).map_err(|_| SpoolError::JournalCorrupt)?;
        validate_journal(&journal)?;
        Ok(journal)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(SpoolError::Storage)
    }
}

/// Stored-journal validation: identity shape, bounds, digest reconstruction,
/// strict ordering and no tail gap. Everything fails as `JournalCorrupt`.
fn validate_journal(journal: &Journal) -> Result<(), SpoolError> {
    journal
        .identity
        .validate()
        .map_err(|_| SpoolError::JournalCorrupt)?;
    if journal.version != SPOOL_VERSION
        || journal.highest_received_seq > MAX_SAFE_COUNTER
        || journal.pending.len() > MAX_PENDING_EVENTS
        || journal.receipts.len() > MAX_RECEIPTS
    {
        return Err(SpoolError::JournalCorrupt);
    }
    let mut previous = 0u64;
    for entry in &journal.pending {
        entry
            .event
            .validate()
            .map_err(|_| SpoolError::JournalCorrupt)?;
        if entry.event.key != journal.identity.key
            || entry.event.event_seq != entry.event_seq
            || stream_of(&entry.event).is_none()
            || entry.event_seq <= previous
            || entry.event_seq > journal.highest_received_seq
            || !is_hex64(&entry.digest)
            || event_digest(&entry.event).map_err(|_| SpoolError::JournalCorrupt)? != entry.digest
        {
            return Err(SpoolError::JournalCorrupt);
        }
        previous = entry.event_seq;
    }
    if journal.pending_bytes().map_err(|_| SpoolError::JournalCorrupt)? > MAX_PENDING_BYTES {
        return Err(SpoolError::JournalCorrupt);
    }
    let mut previous = 0u64;
    for receipt in &journal.receipts {
        if !is_hex64(&receipt.digest)
            || receipt.event_seq <= previous
            || receipt.event_seq > journal.highest_received_seq
            || journal
                .pending
                .iter()
                .any(|entry| entry.event_seq == receipt.event_seq)
        {
            return Err(SpoolError::JournalCorrupt);
        }
        previous = receipt.event_seq;
    }
    if let Some(terminal) = &journal.terminal {
        // `Exited` is the last event: nothing may follow it.
        if terminal.event_seq != journal.highest_received_seq
            || terminal.event_seq == 0
            || !is_hex64(&terminal.digest)
            || journal
                .pending
                .iter()
                .any(|entry| entry.event_seq == terminal.event_seq)
            || journal
                .receipts
                .iter()
                .any(|receipt| receipt.event_seq == terminal.event_seq)
        {
            return Err(SpoolError::JournalCorrupt);
        }
        let reconstructed = ProcessOutputEvent {
            key: journal.identity.key.clone(),
            event_seq: terminal.event_seq,
            body: ProcessOutputBody::Exited {
                exit_code: terminal.exit_code,
                signal: terminal.signal,
            },
        };
        if event_digest(&reconstructed).map_err(|_| SpoolError::JournalCorrupt)? != terminal.digest {
            return Err(SpoolError::JournalCorrupt);
        }
    }
    // Coverage: the highest bounded window must be fully covered by pending,
    // receipts or the terminal summary. Older retired receipts cannot be
    // reconstructed and are never required, but a tail gap is rejected.
    let window = journal.highest_received_seq.min(MAX_RECEIPTS as u64);
    if window > 0 {
        let first = journal.highest_received_seq - window + 1;
        for event_seq in first..=journal.highest_received_seq {
            let covered = journal
                .pending
                .iter()
                .any(|entry| entry.event_seq == event_seq)
                || journal
                    .receipts
                    .iter()
                    .any(|receipt| receipt.event_seq == event_seq)
                || journal
                    .terminal
                    .as_ref()
                    .is_some_and(|terminal| terminal.event_seq == event_seq);
            if !covered {
                return Err(SpoolError::JournalCorrupt);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use uuid::Uuid;

    const PAYLOAD: &str = "spool-secret-output-8675309";

    fn key() -> RemoteProcessKey {
        RemoteProcessKey {
            node_id: "node-1".into(),
            process_id: "process-1".into(),
            process_epoch: 3,
        }
    }

    fn identity() -> JournalIdentity {
        JournalIdentity::new(key(), "controller-1".into(), "a".repeat(64)).unwrap()
    }

    fn private_root(name: &str) -> PathBuf {
        // Deliberately not created here: the spool must create its own private
        // child and parent through the native policy.
        std::env::temp_dir().join(format!("loom-spool-{name}-{}", Uuid::new_v4()))
    }

    fn output(event_seq: u64, stream: PipeStream, text: &str) -> ProcessOutputEvent {
        ProcessOutputEvent {
            key: key(),
            event_seq,
            body: ProcessOutputBody::Output {
                stream,
                data: STANDARD.encode(text),
            },
        }
    }

    fn fault(event_seq: u64, stream: PipeStream) -> ProcessOutputEvent {
        ProcessOutputEvent {
            key: key(),
            event_seq,
            body: ProcessOutputBody::OutputFault {
                stream,
                code: "pipe_fixture".into(),
            },
        }
    }

    fn exited(event_seq: u64) -> ProcessOutputEvent {
        ProcessOutputEvent {
            key: key(),
            event_seq,
            body: ProcessOutputBody::Exited {
                exit_code: Some(0),
                signal: None,
            },
        }
    }

    // Independent owner: real native private creation, atomic publication and
    // reopen of a retained journal that is never a live writable spool.
    #[test]
    fn private_journal_round_trips_and_reopens_only_as_retained_orphan() {
        let root = private_root("round-trip");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, "kept")).unwrap();
        let journal_path = spool.journal_path().to_path_buf();
        drop(rovai_private_storage::open_private_read_file(&journal_path).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join(child_name(&key()).unwrap()))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }

        // Retained, not exited: unknown outcome with its earliest pending event.
        let retained = inspect_existing(&root, &identity()).unwrap();
        assert_eq!(retained.state(), OrphanState::Unterminated);
        assert_eq!(retained.pending_count(), 1);
        assert_eq!(retained.earliest_pending().unwrap().event_seq, 1);

        // The same key never opens a second live spool, even with a new
        // controller/launch identity.
        assert_eq!(
            Spool::create(&root, identity()).unwrap_err(),
            SpoolError::JournalExists
        );
        let relaunched = JournalIdentity::new(key(), "controller-2".into(), "b".repeat(64)).unwrap();
        assert_eq!(
            Spool::create(&root, relaunched.clone()).unwrap_err(),
            SpoolError::JournalExists
        );
        assert_eq!(
            inspect_existing(&root, &relaunched).unwrap_err(),
            SpoolError::Identity
        );

        spool.consume_stream_event(1, PipeStream::Stdout).unwrap();
        spool.record(exited(2)).unwrap();
        let drained = inspect_existing(&root, &identity()).unwrap();
        assert_eq!(drained.state(), OrphanState::Drained);
        assert_eq!(drained.highest_received_seq(), 2);
        assert_eq!(drained.receipt_count(), 1);
        assert_eq!(drained.terminal().unwrap().exit_code, Some(0));
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: bounded listing entry point. The child name pattern,
    // the stored key hash and the stored identity are separate checks.
    #[test]
    fn directory_inspection_rejects_unrelated_names_and_foreign_journals() {
        let root = private_root("inspect-directory");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stderr, "note")).unwrap();
        let name = child_name(&key()).unwrap();
        assert!(valid_child_name(&name));

        let found = inspect_directory(&root, &name).unwrap();
        assert_eq!(found.state(), OrphanState::Unterminated);
        assert_eq!(found.identity(), &identity());

        for bad in [
            String::new(),
            "spool-".to_string(),
            format!("spool-{}", "A".repeat(64)),
            format!("spool-{}", "g".repeat(64)),
            format!("../{name}"),
            format!("{name}/x"),
            format!("{name}0"),
        ] {
            assert_eq!(
                inspect_directory(&root, &bad).unwrap_err(),
                SpoolError::JournalCorrupt,
                "accepted {bad}"
            );
        }
        // A missing but well-formed child is refused rather than created.
        assert!(inspect_directory(&root, &format!("spool-{}", "c".repeat(64))).is_err());
        assert!(!root.join(format!("spool-{}", "c".repeat(64))).exists());
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: idempotent duplicate without rewriting bytes, and the
    // conflict/gap/retired separation that must never authorize replay.
    #[test]
    fn duplicate_conflict_gap_and_retired_sequences_are_separated() {
        let root = private_root("sequence");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, "one")).unwrap();
        let before = fs::read(spool.journal_path()).unwrap();
        let duplicate = spool.record(output(1, PipeStream::Stdout, "one")).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.highest_seq, 1);
        assert_eq!(fs::read(spool.journal_path()).unwrap(), before);

        assert_eq!(
            spool
                .record(output(1, PipeStream::Stdout, "different"))
                .unwrap_err(),
            SpoolError::SequenceConflict
        );
        assert_eq!(
            spool.record(output(3, PipeStream::Stdout, "three")).unwrap_err(),
            SpoolError::SequenceGap
        );
        assert_eq!(spool.highest_received_seq(), 1);

        // Consume the already delivered first frame before advancing this stream.
        spool.consume_stream_event(1, PipeStream::Stdout).unwrap();
        // Retire sequence 1 out of the bounded receipt window. The loop is what
        // proves the window: one record plus one consume per retained position.
        for event_seq in 2..=129u64 {
            spool.record(output(event_seq, PipeStream::Stdout, "x")).unwrap();
            spool.consume_stream_event(event_seq, PipeStream::Stdout).unwrap();
        }
        assert_eq!(spool.snapshot().receipts, MAX_RECEIPTS);
        assert_eq!(
            spool.record(output(1, PipeStream::Stdout, "one")).unwrap_err(),
            SpoolError::SequenceRetired
        );
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: a foreign key never reaches the journal, and identity
    // validation happens before any structure is persisted.
    #[test]
    fn foreign_key_or_malformed_identity_never_touches_the_journal() {
        let root = private_root("identity");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, "one")).unwrap();
        let before = fs::read(spool.journal_path()).unwrap();
        let mut foreign = output(2, PipeStream::Stdout, "two");
        foreign.key.process_epoch = 4;
        assert_eq!(spool.record(foreign).unwrap_err(), SpoolError::Identity);
        assert_eq!(fs::read(spool.journal_path()).unwrap(), before);

        let mut invalid = output(2, PipeStream::Stdout, "two");
        invalid.event_seq = 0;
        assert_eq!(spool.record(invalid).unwrap_err(), SpoolError::EventInvalid);
        for (controller, launch_digest) in [
            ("".to_string(), "a".repeat(64)),
            ("controller-2".to_string(), "A".repeat(64)),
            ("controller-2".to_string(), "a".repeat(63)),
        ] {
            assert_eq!(
                JournalIdentity::new(key(), controller, launch_digest).unwrap_err(),
                SpoolError::Identity
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: per-stream reclamation order plus receipt digest
    // binding for consumed sequences.
    #[test]
    fn interleaved_streams_reclaim_independently_and_receipts_bind_replay() {
        let root = private_root("interleaved");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, "out-1")).unwrap();
        spool.record(output(2, PipeStream::Stderr, "err-2")).unwrap();
        spool.record(output(3, PipeStream::Stdout, "out-3")).unwrap();
        assert_eq!(
            spool.pending_for_stream(PipeStream::Stdout).unwrap().event_seq,
            1
        );
        assert_eq!(
            spool.pending_for_stream(PipeStream::Stderr).unwrap().event_seq,
            2
        );

        spool.consume_stream_event(2, PipeStream::Stderr).unwrap();
        assert_eq!(
            spool.consume_stream_event(3, PipeStream::Stdout).unwrap_err(),
            SpoolError::ConsumeOrder
        );
        assert_eq!(
            spool.consume_stream_event(1, PipeStream::Stderr).unwrap_err(),
            SpoolError::ConsumeOrder
        );
        spool.consume_stream_event(1, PipeStream::Stdout).unwrap();
        spool.consume_stream_event(3, PipeStream::Stdout).unwrap();
        assert!(spool.pending_for_stream(PipeStream::Stdout).is_none());

        // Receipts keep ascending sequence order and the consumed digests still
        // identify identical replays as duplicates and different bytes as conflict.
        let receipts = read_journal(spool.journal_path()).unwrap().receipts;
        assert_eq!(
            receipts.iter().map(|r| r.event_seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(
            spool
                .record(output(2, PipeStream::Stderr, "err-2"))
                .unwrap()
                .duplicate
        );
        assert_eq!(
            spool
                .record(output(2, PipeStream::Stderr, "err-other"))
                .unwrap_err(),
            SpoolError::SequenceConflict
        );
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: fault ordering, terminal retention and EOF rule.
    #[test]
    fn fault_and_exit_order_stream_delivery_and_end() {
        let root = private_root("fault-exit");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, "before")).unwrap();
        spool.record(fault(2, PipeStream::Stdout)).unwrap();
        assert!(!spool.stream_finished(PipeStream::Stdout));
        assert_eq!(
            spool.pending_for_stream(PipeStream::Stdout).unwrap().event_seq,
            1
        );
        spool.consume_stream_event(1, PipeStream::Stdout).unwrap();
        assert!(matches!(
            spool.pending_for_stream(PipeStream::Stdout).unwrap().body,
            ProcessOutputBody::OutputFault { .. }
        ));
        // Stderr has nothing pending, but EOF still waits for `Exited`.
        assert!(!spool.stream_finished(PipeStream::Stderr));
        spool.record(exited(3)).unwrap();
        assert_eq!(spool.terminal().unwrap().event_seq, 3);
        assert!(spool.stream_finished(PipeStream::Stderr));
        assert!(!spool.stream_finished(PipeStream::Stdout));
        assert_eq!(
            spool.record(output(4, PipeStream::Stdout, "late")).unwrap_err(),
            SpoolError::TerminalRecorded
        );
        assert_eq!(
            spool.record(exited(4)).unwrap_err(),
            SpoolError::TerminalRecorded
        );
        spool.consume_stream_event(2, PipeStream::Stdout).unwrap();
        assert!(spool.stream_finished(PipeStream::Stdout));
        assert_eq!(spool.snapshot().pending_events, 0);
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: the pending window refuses new events without moving
    // the durable cursor. (`EventTooLarge` cannot be produced from the wire,
    // whose chunk cap is far below the pending byte budget.)
    #[test]
    fn pending_caps_refuse_events_without_changing_durable_state() {
        let root = private_root("caps");
        let mut spool = Spool::create(&root, identity()).unwrap();
        for event_seq in 1..=MAX_PENDING_EVENTS as u64 {
            spool.record(output(event_seq, PipeStream::Stdout, "x")).unwrap();
        }
        let before = fs::read(spool.journal_path()).unwrap();
        assert_eq!(
            spool
                .record(output(MAX_PENDING_EVENTS as u64 + 1, PipeStream::Stdout, "x"))
                .unwrap_err(),
            SpoolError::PendingFull
        );
        assert_eq!(spool.highest_received_seq(), MAX_PENDING_EVENTS as u64);
        assert_eq!(spool.snapshot().pending_events, MAX_PENDING_EVENTS);
        assert_eq!(fs::read(spool.journal_path()).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: a persistence failure must not return `Durable` and must
    // not advance the in-memory cursor. The equal-bytes assertion holds only for
    // this seam's pre-publication failure.
    #[test]
    fn persistence_failure_preserves_memory_cursor_and_prepublication_bytes() {
        let root = private_root("persist-failure");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, "one")).unwrap();
        let before = fs::read(spool.journal_path()).unwrap();

        spool.use_persistence(|_, _| Err(SpoolError::Persist));
        assert_eq!(
            spool.record(output(2, PipeStream::Stdout, "two")).unwrap_err(),
            SpoolError::Persist
        );
        assert_eq!(spool.highest_received_seq(), 1);
        assert_eq!(
            spool.pending_for_stream(PipeStream::Stdout).unwrap().event_seq,
            1
        );
        assert_eq!(fs::read(spool.journal_path()).unwrap(), before);

        assert_eq!(
            spool.consume_stream_event(1, PipeStream::Stdout).unwrap_err(),
            SpoolError::Persist
        );
        assert_eq!(spool.snapshot().pending_events, 1);
        assert_eq!(spool.snapshot().receipts, 0);
        assert_eq!(fs::read(spool.journal_path()).unwrap(), before);
        assert_eq!(
            inspect_existing(&root, &identity()).unwrap().pending_count(),
            1
        );

        spool.use_persistence(persist_private_journal);
        spool.record(output(2, PipeStream::Stdout, "two")).unwrap();
        assert_eq!(spool.highest_received_seq(), 2);
        assert_eq!(
            inspect_existing(&root, &identity())
                .unwrap()
                .highest_received_seq(),
            2
        );
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: no formatted output may carry event bytes.
    #[test]
    fn debug_output_and_errors_never_carry_output_bytes() {
        let root = private_root("debug");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, PAYLOAD)).unwrap();
        assert!(!format!("{spool:?}").contains(PAYLOAD));
        assert!(!format!("{:?}", spool.snapshot()).contains(PAYLOAD));
        let retained = inspect_existing(&root, &identity()).unwrap();
        assert!(!format!("{retained:?}").contains(PAYLOAD));
        assert!(!format!("{:?}", retained.earliest_pending()).contains(PAYLOAD));

        let conflict = spool
            .record(output(1, PipeStream::Stdout, &format!("{PAYLOAD}-changed")))
            .unwrap_err();
        assert!(!format!("{conflict:?}{conflict}").contains(PAYLOAD));
        for error in [
            conflict,
            SpoolError::Persist,
            SpoolError::Identity,
            SpoolError::JournalCorrupt,
        ] {
            assert_eq!(error.to_string(), error.code());
            assert!(!format!("{error:?}").contains(PAYLOAD));
        }
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: stored evidence is re-verified, not trusted: digest
    // reconstruction, terminal tail, bounds and the file cap.
    #[test]
    fn inspection_refuses_tampered_tail_and_oversized_journals() {
        let root = private_root("tamper");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, "keep")).unwrap();
        spool.record(exited(2)).unwrap();
        let path = spool.journal_path().to_path_buf();

        let mut journal = read_journal(&path).unwrap();
        let digest_before = journal.pending[0].digest.clone();
        journal.pending[0].digest = "0".repeat(64);
        persist_private_journal(&path, &journal).unwrap();
        assert_eq!(
            inspect_existing(&root, &identity()).unwrap_err(),
            SpoolError::JournalCorrupt
        );

        journal.pending[0].digest = digest_before;
        journal.terminal.as_mut().unwrap().event_seq = 1;
        persist_private_journal(&path, &journal).unwrap();
        assert_eq!(
            inspect_existing(&root, &identity()).unwrap_err(),
            SpoolError::JournalCorrupt
        );

        journal.terminal.as_mut().unwrap().event_seq = 2;
        journal.terminal.as_mut().unwrap().exit_code = Some(1);
        persist_private_journal(&path, &journal).unwrap();
        assert_eq!(
            inspect_existing(&root, &identity()).unwrap_err(),
            SpoolError::JournalCorrupt
        );

        journal.terminal.as_mut().unwrap().exit_code = Some(0);
        journal.highest_received_seq = 3;
        persist_private_journal(&path, &journal).unwrap();
        assert_eq!(
            inspect_existing(&root, &identity()).unwrap_err(),
            SpoolError::JournalCorrupt
        );

        rovai_private_storage::atomic_write_private_bytes(&path, &vec![b' '; MAX_JOURNAL_BYTES + 1])
            .unwrap();
        assert_eq!(
            inspect_existing(&root, &identity()).unwrap_err(),
            SpoolError::JournalTooLarge
        );
        fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: the abandoned-output decision is durable, reloadable,
    // irreversible, defaults to false for an existing v1 journal, and never
    // consumes pending bytes or deletes the journal. It is a loss decision only,
    // not tree cleanup and not native acceptance.
    #[test]
    fn abandoned_output_marker_is_durable_reloadable_and_irreversible() {
        let root = private_root("abandoned");
        let mut spool = Spool::create(&root, identity()).unwrap();
        spool.record(output(1, PipeStream::Stdout, PAYLOAD)).unwrap();
        assert!(!spool.snapshot().output_abandoned);
        assert!(!inspect_existing(&root, &identity()).unwrap().output_abandoned());

        // A journal written before this field existed decodes as `false`.
        let path = spool.journal_path().to_path_buf();
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("outputAbandoned");
        rovai_private_storage::atomic_write_private_bytes(
            &path,
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let migrated = inspect_existing(&root, &identity()).unwrap();
        assert!(!migrated.output_abandoned());
        assert_eq!(migrated.pending_count(), 1);

        let before = fs::read(&path).unwrap();
        spool.mark_output_abandoned().unwrap();
        assert!(spool.snapshot().output_abandoned);
        assert_ne!(fs::read(&path).unwrap(), before);
        assert_eq!(spool.snapshot().pending_events, 1);
        assert!(spool.journal_path().exists());
        assert!(inspect_existing(&root, &identity()).unwrap().output_abandoned());

        // Marking again rewrites nothing, and later progress never clears it.
        let marked = fs::read(&path).unwrap();
        spool.mark_output_abandoned().unwrap();
        assert_eq!(fs::read(&path).unwrap(), marked);
        spool.consume_stream_event(1, PipeStream::Stdout).unwrap();
        spool.record(exited(2)).unwrap();
        let drained = inspect_existing(&root, &identity()).unwrap();
        assert!(drained.output_abandoned());
        assert_eq!(drained.state(), OrphanState::Drained);
        assert!(!format!("{spool:?}{drained:?}").contains(PAYLOAD));
        fs::remove_dir_all(root).unwrap();
    }
}
