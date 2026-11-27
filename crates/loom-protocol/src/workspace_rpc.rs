//! Workspace RPC v1: typed protocol for `A` driving `list` / `read` /
//! `write` / `run` on the node that owns workspace `B`.
//!
//! Scope of this module is the wire contract only: types, closed schema,
//! validation and digests. There is no filesystem access, no process spawn and
//! no authorization decision here. The approved local `WorkspacePolicy`
//! (root, allowed operations, `tool_id` -> program mapping) and the tool
//! admission live in a later module. Nothing in these types is an
//! operating-system sandbox: a bounded `argv` and a relative `cwd` are not file
//! access isolation.
//!
//! Identity rules:
//!
//! * An external [`WorkspaceRequest`] carries no identity at all. It has no
//!   member, mission, run, session, node, root, program or environment field,
//!   and every wire type rejects unknown fields.
//! * [`CallerScope`] is authoritative only because Core resolves it from an
//!   authenticated per-run credential or trusted context. Deserializing a
//!   `CallerScope` proves the bytes are *shaped* like a scope; it does not
//!   authenticate the caller. Serde success is never authorization.
//! * [`WorkspaceDispatch`] is the only place a scope travels, and it must be
//!   used on an already authenticated `A` -> `B` channel. `request_digest` is
//!   an unkeyed SHA-256 binding of request, identity, policy revision and
//!   deadline. It is an idempotency and integrity anchor, **not a MAC**:
//!   anyone who can reach this code can recompute it, so channel
//!   authentication is what makes a dispatch trustworthy.
//! * Wire structs keep public fields so they stay usable as plain data.
//!   Public fields are mutable, so `validate()` recomputes the digest rather
//!   than claiming the Rust type makes a dispatch immutable.
//!
//! Paths are validated as strings over a closed cross-platform grammar and
//! never through `std::path`, so a Windows-shaped path is rejected on Linux
//! exactly as it is rejected on Windows.
//!
//! This module owns its own versioned limits. Its
//! `MAX_LIST_ENTRIES` / `MAX_READ_BYTES` deliberately shadow (do not replace)
//! the `usize` constants exported by the existing `workspace` module, so it
//! must not be re-exported from the crate root under the same names.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Wire version this module implements. A dispatch before anything else.
pub const RPC_VERSION: u32 = 1;

/// Absolute upper bound on `timeout_ms`. Core fixes the deadline from it.
pub const MAX_TIMEOUT_MS: u64 = 300_000;

/// Maximum `limit` a list operation may request.
pub const MAX_LIST_ENTRIES: u32 = 200;

/// Maximum `max_bytes` a read operation may request.
pub const MAX_READ_BYTES: u32 = 1_048_576;

/// Maximum raw bytes a write operation may carry, counted after base64 decode.
pub const MAX_WRITE_BYTES: u32 = 1_048_576;

/// Maximum raw output bytes one request may produce in total.
pub const MAX_OUTPUT_BYTES: u64 = 1_048_576;

/// Maximum raw bytes of one `Output` chunk. stdout and stderr share the bound.
pub const MAX_CHUNK_BYTES: u32 = 16_384;

/// Longest request/workspace/scope/tool id, counted in bytes.
pub const MAX_ID_BYTES: usize = 128;

/// Longest relative path, counted in UTF-8 bytes.
pub const MAX_PATH_BYTES: usize = 4096;

/// Maximum number of `argv` entries.
pub const MAX_ARGV: usize = 128;

/// Maximum bytes of a single `argv` entry.
pub const MAX_ARG_BYTES: usize = 8192;

/// Maximum bytes of all `argv` entries together.
pub const MAX_ARGV_BYTES: usize = 32_768;

/// Domain separator so a request fingerprint can never be confused with a
/// dispatch digest or with a digest from another protocol version.
const REQUEST_DIGEST_DOMAIN: &str = "loom.workspace_rpc.request.v1";

/// Domain separator for the dispatch digest.
const DISPATCH_DIGEST_DOMAIN: &str = "loom.workspace_rpc.dispatch.v1";

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

/// Which stream an output chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RpcOutputStream {
    Stdout,
    Stderr,
}

/// Directory entry kind. Closed by type: an unknown kind cannot be decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
}

/// Why a request was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelCause {
    User,
    Deadline,
}

/// The closed error set. No variant carries a value, so nothing here can echo a
/// path, an argument, file content or any other raw input into a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RpcErrorCode {
    UnsupportedVersion,
    InvalidRequest,
    PathRejected,
    Unauthorized,
    WrongNode,
    PolicyMismatch,
    ToolDenied,
    DeadlineExceeded,
    RequestConflict,
    NotFound,
    NotDirectory,
    NotFile,
    NodeOffline,
    Busy,
    OutputLimit,
    SequenceConflict,
    UnknownOutcome,
    SpawnFailed,
    Cancelled,
    StorageUnavailable,
    UnsupportedPlatform,
}

impl RpcErrorCode {
    /// Stable diagnostic spelling. Contains no caller-supplied text.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedVersion => "unsupported_version",
            Self::InvalidRequest => "invalid_request",
            Self::PathRejected => "path_rejected",
            Self::Unauthorized => "unauthorized",
            Self::WrongNode => "wrong_node",
            Self::PolicyMismatch => "policy_mismatch",
            Self::ToolDenied => "tool_denied",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::RequestConflict => "request_conflict",
            Self::NotFound => "not_found",
            Self::NotDirectory => "not_directory",
            Self::NotFile => "not_file",
            Self::NodeOffline => "node_offline",
            Self::Busy => "busy",
            Self::OutputLimit => "output_limit",
            Self::SequenceConflict => "sequence_conflict",
            Self::UnknownOutcome => "unknown_outcome",
            Self::SpawnFailed => "spawn_failed",
            Self::Cancelled => "cancelled",
            Self::StorageUnavailable => "storage_unavailable",
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

impl std::fmt::Display for RpcErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for RpcErrorCode {}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/// A tagged operation. Tag key is `kind`, variant fields are camelCase.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceOperation {
    /// `path` is relative and may be empty for the workspace root.
    List { path: String, limit: u32 },
    /// `path` is relative and must be non-empty.
    Read {
        path: String,
        offset: u64,
        max_bytes: u32,
    },
    /// `path` is relative and must be non-empty; `data` is standard padded
    /// base64 of the complete new file bytes, at most `MAX_WRITE_BYTES`. The
    /// node replaces the file in place: no directory is created, nothing is
    /// deleted, and no other target than a contained regular file is written.
    Write { path: String, data: String },
    /// `tool_id` is a key into the approved local policy; `args` are kept
    /// verbatim (never shell-interpreted) but bounded; `cwd` is relative and
    /// may be empty for the root. This is not an OS sandbox.
    Run {
        tool_id: String,
        args: Vec<String>,
        cwd: String,
    },
}

/// The external, identity-free request. Dispatch and CallerScope are the only
/// places identity exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRequest {
    pub version: u32,
    pub request_id: String,
    pub workspace_id: String,
    pub timeout_ms: u64,
    pub operation: WorkspaceOperation,
}

impl WorkspaceRequest {
    /// Validate version, ids, timeout and the per-operation limits.
    ///
    /// Codes: unsupported version -> `UnsupportedVersion`; any id/limit/argv
    /// violation -> `InvalidRequest`; any path violation -> `PathRejected`.
    pub fn validate(&self) -> Result<(), RpcErrorCode> {
        if self.version != RPC_VERSION {
            return Err(RpcErrorCode::UnsupportedVersion);
        }
        validate_id(&self.request_id)?;
        validate_id(&self.workspace_id)?;
        if !(1..=MAX_TIMEOUT_MS).contains(&self.timeout_ms) {
            return Err(RpcErrorCode::InvalidRequest);
        }
        match &self.operation {
            WorkspaceOperation::List { path, limit } => {
                validate_relative_path(path, true)?;
                if !(1..=MAX_LIST_ENTRIES).contains(limit) {
                    return Err(RpcErrorCode::InvalidRequest);
                }
            }
            WorkspaceOperation::Read {
                path,
                offset,
                max_bytes,
            } => {
                validate_relative_path(path, false)?;
                if !(1..=MAX_READ_BYTES).contains(max_bytes) {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                offset
                    .checked_add(u64::from(*max_bytes))
                    .ok_or(RpcErrorCode::InvalidRequest)?;
            }
            WorkspaceOperation::Write { path, data } => {
                validate_write_path(path)?;
                decode_base64_bounded(data, u64::from(MAX_WRITE_BYTES))?;
            }
            WorkspaceOperation::Run {
                tool_id,
                args,
                cwd,
            } => {
                validate_id(tool_id)?;
                validate_relative_path(cwd, true)?;
                if args.len() > MAX_ARGV {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                let mut total = 0_usize;
                for arg in args {
                    if arg.contains('\0') || arg.len() > MAX_ARG_BYTES {
                        return Err(RpcErrorCode::InvalidRequest);
                    }
                    total = total
                        .checked_add(arg.len())
                        .ok_or(RpcErrorCode::InvalidRequest)?;
                }
                if total > MAX_ARGV_BYTES {
                    return Err(RpcErrorCode::InvalidRequest);
                }
            }
        }
        Ok(())
    }

    /// Canonical identity of this request alone, for journal keys and dedup.
    /// Validates first so a rejected request can never produce a fingerprint.
    pub fn fingerprint(&self) -> Result<String, RpcErrorCode> {
        self.validate()?;
        digest_hex(&RequestDigestInput {
            domain: REQUEST_DIGEST_DOMAIN,
            request: self,
        })
    }
}

#[derive(Serialize)]
struct RequestDigestInput<'a> {
    domain: &'static str,
    request: &'a WorkspaceRequest,
}

// ---------------------------------------------------------------------------
// Trusted scope
// ---------------------------------------------------------------------------

/// Trusted caller identity. Core creates this from the authenticated per-run
/// credential; it is never accepted from an external request. Decoding it from
/// JSON does not authenticate anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallerScope {
    pub run_id: String,
    pub attempt: u32,
    pub session_id: String,
    pub member_id: String,
    pub mission_id: String,
}

impl CallerScope {
    /// Validate every id and require `attempt >= 1` (attempt 0 is not a run).
    pub fn validate(&self) -> Result<(), RpcErrorCode> {
        validate_id(&self.run_id)?;
        validate_id(&self.session_id)?;
        validate_id(&self.member_id)?;
        validate_id(&self.mission_id)?;
        if self.attempt < 1 {
            return Err(RpcErrorCode::InvalidRequest);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// The only carrier of a scope. Built by Core after it matched the caller to
/// the workspace owner and its policy revision; consumed by the node on an
/// authenticated channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDispatch {
    pub version: u32,
    pub request: WorkspaceRequest,
    pub scope: CallerScope,
    pub owner_node_id: String,
    pub policy_revision: u64,
    pub accepted_at_unix_ms: u64,
    pub deadline_unix_ms: u64,
    pub request_digest: String,
}

impl WorkspaceDispatch {
    /// Build a dispatch. The deadline is computed here from
    /// `accepted_at_unix_ms + request.timeout_ms`; there is no deadline
    /// parameter, so a caller cannot extend one.
    ///
    /// Codes: `UnsupportedVersion` / `InvalidRequest` / `PathRejected` from the
    /// request and scope; `InvalidRequest` for a bad owner node, a policy
    /// revision below 1 or a `checked_add` overflow of the deadline.
    pub fn new(
        request: WorkspaceRequest,
        scope: CallerScope,
        owner_node_id: String,
        policy_revision: u64,
        accepted_at_unix_ms: u64,
    ) -> Result<Self, RpcErrorCode> {
        request.validate()?;
        scope.validate()?;
        validate_id(&owner_node_id)?;
        validate_policy_revision(policy_revision)?;
        let deadline_unix_ms = accepted_at_unix_ms
            .checked_add(request.timeout_ms)
            .ok_or(RpcErrorCode::InvalidRequest)?;
        let request_digest = dispatch_digest_hex(
            &request,
            &scope,
            &owner_node_id,
            policy_revision,
            accepted_at_unix_ms,
            deadline_unix_ms,
        )?;
        let dispatch = Self {
            version: RPC_VERSION,
            request,
            scope,
            owner_node_id,
            policy_revision,
            accepted_at_unix_ms,
            deadline_unix_ms,
            request_digest,
        };
        dispatch.validate()?;
        Ok(dispatch)
    }

    /// Re-verify a dispatch that may have been decoded or mutated in memory.
    ///
    /// Codes: `UnsupportedVersion`; request/scope/owner/policy violations as in
    /// `new`; `RequestConflict` when the deadline span no longer equals
    /// `timeout_ms` (a fixed deadline was edited) or when the recomputed digest
    /// differs from `request_digest` (any identity, policy or deadline edit).
    ///
    /// There is deliberately no `now` parameter: this function cannot decide
    /// expiry or cancellation. Core and the node compare
    /// `deadline_unix_ms` against their own clock.
    pub fn validate(&self) -> Result<(), RpcErrorCode> {
        if self.version != RPC_VERSION {
            return Err(RpcErrorCode::UnsupportedVersion);
        }
        self.request.validate()?;
        self.scope.validate()?;
        validate_id(&self.owner_node_id)?;
        validate_policy_revision(self.policy_revision)?;
        let span = self
            .deadline_unix_ms
            .checked_sub(self.accepted_at_unix_ms)
            .ok_or(RpcErrorCode::RequestConflict)?;
        if span != self.request.timeout_ms || span > MAX_TIMEOUT_MS {
            return Err(RpcErrorCode::RequestConflict);
        }
        let expected = dispatch_digest_hex(
            &self.request,
            &self.scope,
            &self.owner_node_id,
            self.policy_revision,
            self.accepted_at_unix_ms,
            self.deadline_unix_ms,
        )?;
        if expected != self.request_digest {
            return Err(RpcErrorCode::RequestConflict);
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct DispatchDigestInput<'a> {
    domain: &'static str,
    request: &'a WorkspaceRequest,
    scope: &'a CallerScope,
    owner_node_id: &'a str,
    policy_revision: u64,
    accepted_at_unix_ms: u64,
    deadline_unix_ms: u64,
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// One directory entry. `name` is a single path component, never a path.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceEntry {
    pub name: String,
    pub kind: EntryKind,
}

/// A completed operation result. Tag key is `kind`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceResult {
    List {
        entries: Vec<WorkspaceEntry>,
        truncated: bool,
    },
    /// `data` is standard padded base64 of the raw file bytes.
    Read {
        data: String,
        offset: u64,
        truncated: bool,
    },
    /// `bytes_written` is the count of bytes actually stored, never a path.
    Write {
        bytes_written: u64,
        created: bool,
    },
    Run {
        exit_code: i32,
        output_bytes: u64,
        omitted_bytes: u64,
    },
}

impl WorkspaceResult {
    /// Check the result against the request that asked for it.
    ///
    /// The variant must match the request's operation. Codes: `InvalidRequest`
    /// for a wrong variant, too many entries, an offset mismatch, an oversized
    /// `output_bytes`, an overflowing output accounting, malformed base64 or
    /// decoded bytes beyond `max_bytes`; `PathRejected` for an entry name that
    /// is not a single legal path component. No base64 payload is ever copied
    /// into an error.
    pub fn validate_for(&self, request: &WorkspaceRequest) -> Result<(), RpcErrorCode> {
        match (self, &request.operation) {
            (
                Self::List {
                    entries,
                    truncated: _,
                },
                WorkspaceOperation::List { limit, .. },
            ) => {
                if entries.len() as u64 > u64::from(*limit) {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                for entry in entries {
                    if entry.name.contains('/') {
                        return Err(RpcErrorCode::PathRejected);
                    }
                    validate_relative_path(&entry.name, false)?;
                }
                Ok(())
            }
            (
                Self::Read {
                    data,
                    offset,
                    truncated: _,
                },
                WorkspaceOperation::Read {
                    offset: requested_offset,
                    max_bytes,
                    ..
                },
            ) => {
                if offset != requested_offset {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                decode_base64_bounded(data, u64::from(*max_bytes)).map(|_| ())
            }
            (
                Self::Write {
                    bytes_written,
                    created: _,
                },
                WorkspaceOperation::Write { .. },
            ) => {
                if *bytes_written > u64::from(MAX_WRITE_BYTES) {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                Ok(())
            }
            (
                Self::Run {
                    exit_code: _,
                    output_bytes,
                    omitted_bytes,
                },
                WorkspaceOperation::Run { .. },
            ) => {
                if *output_bytes > MAX_OUTPUT_BYTES {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                if output_bytes.checked_add(*omitted_bytes).is_none() {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                Ok(())
            }
            _ => Err(RpcErrorCode::InvalidRequest),
        }
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// A tagged event body. Tag key is `kind`, matching the other tagged enums.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceEventBody {
    Accepted,
    /// `data` is standard padded base64 of at most `MAX_CHUNK_BYTES` raw bytes.
    Output {
        stream: RpcOutputStream,
        data: String,
    },
    /// The producer dropped `omitted_bytes` raw bytes. Truncation is explicit.
    OutputTruncated { omitted_bytes: u64 },
    Completed { result: WorkspaceResult },
    Failed { code: RpcErrorCode },
    Cancelled { cause: CancelCause },
    /// The outcome is not known; the request identity is retained so a late
    /// definitive terminal state can still be accepted.
    Unknown { code: RpcErrorCode },
}

/// One event on the per-request, sequence-numbered stream. Data fields may
/// contain base64 file or process output and must not be logged verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceEvent {
    pub version: u32,
    pub request_id: String,
    pub run_id: String,
    pub attempt: u32,
    pub owner_node_id: String,
    pub request_digest: String,
    pub seq: u64,
    pub body: WorkspaceEventBody,
}

impl WorkspaceEvent {
    /// Check the event against the dispatch that produced it, so Core does not
    /// repeat the identity comparison.
    ///
    /// Codes: `UnsupportedVersion`; `RequestConflict` when request id, run id,
    /// attempt, owner node or digest differ from the dispatch; `InvalidRequest`
    /// for `seq == 0`, a chunk over `MAX_CHUNK_BYTES`, base64 that does not
    /// decode, `omitted_bytes == 0`, or an invalid embedded result.
    pub fn validate_for(&self, dispatch: &WorkspaceDispatch) -> Result<(), RpcErrorCode> {
        if self.version != RPC_VERSION {
            return Err(RpcErrorCode::UnsupportedVersion);
        }
        if self.seq < 1 {
            return Err(RpcErrorCode::InvalidRequest);
        }
        if self.request_id != dispatch.request.request_id
            || self.run_id != dispatch.scope.run_id
            || self.attempt != dispatch.scope.attempt
            || self.owner_node_id != dispatch.owner_node_id
            || self.request_digest != dispatch.request_digest
        {
            return Err(RpcErrorCode::RequestConflict);
        }
        match &self.body {
            WorkspaceEventBody::Accepted => Ok(()),
            WorkspaceEventBody::Output { stream: _, data } => {
                decode_base64_bounded(data, u64::from(MAX_CHUNK_BYTES)).map(|_| ())
            }
            WorkspaceEventBody::OutputTruncated { omitted_bytes } => {
                if *omitted_bytes == 0 {
                    Err(RpcErrorCode::InvalidRequest)
                } else {
                    Ok(())
                }
            }
            WorkspaceEventBody::Completed { result } => {
                result.validate_for(&dispatch.request)
            }
            WorkspaceEventBody::Failed { code: _ }
            | WorkspaceEventBody::Cancelled { cause: _ }
            | WorkspaceEventBody::Unknown { code: _ } => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Cancel and replay
// ---------------------------------------------------------------------------

/// Cancel exactly one request. Identity is the request, not the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCancel {
    pub version: u32,
    pub request_id: String,
    pub run_id: String,
    pub attempt: u32,
    pub request_digest: String,
    pub cause: CancelCause,
}

impl WorkspaceCancel {
    /// Codes: `UnsupportedVersion`; `RequestConflict` on any identity mismatch.
    pub fn validate_for(&self, dispatch: &WorkspaceDispatch) -> Result<(), RpcErrorCode> {
        validate_identity(
            self.version,
            &self.request_id,
            &self.run_id,
            self.attempt,
            &self.request_digest,
            dispatch,
        )
    }
}

/// Ask for buffered events after `after_seq`. `after_seq == 0` means from the
/// beginning of the stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReplay {
    pub version: u32,
    pub request_id: String,
    pub run_id: String,
    pub attempt: u32,
    pub request_digest: String,
    pub after_seq: u64,
}

impl WorkspaceReplay {
    /// Codes: `UnsupportedVersion`; `RequestConflict` on any identity mismatch.
    pub fn validate_for(&self, dispatch: &WorkspaceDispatch) -> Result<(), RpcErrorCode> {
        validate_identity(
            self.version,
            &self.request_id,
            &self.run_id,
            self.attempt,
            &self.request_digest,
            dispatch,
        )
    }
}

fn validate_identity(
    version: u32,
    request_id: &str,
    run_id: &str,
    attempt: u32,
    request_digest: &str,
    dispatch: &WorkspaceDispatch,
) -> Result<(), RpcErrorCode> {
    if version != RPC_VERSION {
        return Err(RpcErrorCode::UnsupportedVersion);
    }
    if request_id != dispatch.request.request_id
        || run_id != dispatch.scope.run_id
        || attempt != dispatch.scope.attempt
        || request_digest != dispatch.request_digest
    {
        return Err(RpcErrorCode::RequestConflict);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Paths, ids and digests
// ---------------------------------------------------------------------------

/// Validate a relative path from the cross-platform closed grammar.
///
/// Rules are pure string rules, never `std::path`, so Linux and Windows reach
/// the same verdict:
///
/// * `allow_root` is the only way an empty string passes (list root, run cwd).
/// * Reject byte length over `MAX_PATH_BYTES` (4096 UTF-8 bytes) and any NUL.
/// * Reject a leading `/` (absolute, and `//host` UNC) and every `\`.
/// * Split on `/`; an empty component (`a//b`, trailing `/`) is rejected.
/// * Reject `.` and `..` components.
/// * Per component: reject `:` (drive letter and NTFS alternate data streams),
///   ASCII control bytes (`0x00..=0x1f`) and DEL (`0x7f`), a trailing `.` or
///   space (Windows strips them), and the DOS device basenames `CON`, `PRN`,
///   `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9` case-insensitively and with
///   any extension.
///
/// Ordinary Unicode names are allowed. This is a protocol grammar, not a full
/// Windows filename legality check.
pub fn validate_relative_path(raw: &str, allow_root: bool) -> Result<(), RpcErrorCode> {
    if raw.len() > MAX_PATH_BYTES {
        return Err(RpcErrorCode::PathRejected);
    }
    if raw.is_empty() {
        return if allow_root {
            Ok(())
        } else {
            Err(RpcErrorCode::PathRejected)
        };
    }
    if raw.contains('\0') || raw.starts_with('/') || raw.contains('\\') {
        return Err(RpcErrorCode::PathRejected);
    }
    for component in raw.split('/') {
        validate_path_component(component)?;
    }
    Ok(())
}

/// A write target uses the same relative grammar with one extra rule: no
/// component may name Git metadata. The prepared workspace is a Git worktree
/// and `.git` is what binds it, so a write there could invalidate the local
/// authority facts later operations are checked against.
pub fn validate_write_path(raw: &str) -> Result<(), RpcErrorCode> {
    validate_relative_path(raw, false)?;
    if raw
        .split('/')
        .any(|component| component.eq_ignore_ascii_case(".git"))
    {
        return Err(RpcErrorCode::PathRejected);
    }
    Ok(())
}

fn validate_path_component(component: &str) -> Result<(), RpcErrorCode> {
    if component.is_empty() || component == "." || component == ".." {
        return Err(RpcErrorCode::PathRejected);
    }
    if component.contains(':') {
        return Err(RpcErrorCode::PathRejected);
    }
    if component
        .bytes()
        .any(|byte| byte < 0x20 || byte == 0x7f)
    {
        return Err(RpcErrorCode::PathRejected);
    }
    if component.ends_with('.') || component.ends_with(' ') {
        return Err(RpcErrorCode::PathRejected);
    }
    if is_windows_device_name(component) {
        return Err(RpcErrorCode::PathRejected);
    }
    Ok(())
}

fn is_windows_device_name(component: &str) -> bool {
    let base = component.split('.').next().unwrap_or(component);
    if !base.is_ascii() {
        return false;
    }
    let upper = base.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => {
            // `COM1`..`COM9` and `LPT1`..`LPT9`; `bytes` is ASCII here because
            // the caller rejected every non-ASCII basename.
            let bytes = upper.as_bytes();
            bytes.len() == 4
                && bytes[3].is_ascii_digit()
                && bytes[3] != b'0'
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
        }
    }
}

fn validate_id(value: &str) -> Result<(), RpcErrorCode> {
    if value.is_empty() || value.len() > MAX_ID_BYTES {
        return Err(RpcErrorCode::InvalidRequest);
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(RpcErrorCode::InvalidRequest);
    }
    Ok(())
}

fn validate_policy_revision(policy_revision: u64) -> Result<(), RpcErrorCode> {
    if policy_revision < 1 {
        return Err(RpcErrorCode::InvalidRequest);
    }
    Ok(())
}

fn dispatch_digest_hex(
    request: &WorkspaceRequest,
    scope: &CallerScope,
    owner_node_id: &str,
    policy_revision: u64,
    accepted_at_unix_ms: u64,
    deadline_unix_ms: u64,
) -> Result<String, RpcErrorCode> {
    digest_hex(&DispatchDigestInput {
        domain: DISPATCH_DIGEST_DOMAIN,
        request,
        scope,
        owner_node_id,
        policy_revision,
        accepted_at_unix_ms,
        deadline_unix_ms,
    })
}

/// Deterministic canonical serialization into SHA-256. Field order is the
/// declaration order of the digest input struct and no map is involved, so the
/// bytes do not depend on hashing, iteration or the current platform.
fn digest_hex<T: Serialize>(input: &T) -> Result<String, RpcErrorCode> {
    let canonical =
        serde_json::to_string(input).map_err(|_| RpcErrorCode::InvalidRequest)?;
    Ok(sha256_hex(canonical.as_bytes()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest.iter() {
        hex.push(DIGITS[usize::from(byte >> 4)] as char);
        hex.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    hex
}

/// Upper bound of the encoded length for `raw_max` raw bytes, so an oversized
/// payload is rejected before it is decoded.
fn max_base64_len(raw_max: u64) -> Option<u64> {
    raw_max.checked_add(2)?.checked_div(3)?.checked_mul(4)
}

/// Bounded decode. Standard padded base64; the raw length is checked both from
/// the encoded length bound and from the actual decoded length.
fn decode_base64_bounded(data: &str, raw_max: u64) -> Result<usize, RpcErrorCode> {
    let encoded_max = max_base64_len(raw_max).ok_or(RpcErrorCode::InvalidRequest)?;
    if data.len() as u64 > encoded_max {
        return Err(RpcErrorCode::InvalidRequest);
    }
    let decoded = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| RpcErrorCode::InvalidRequest)?;
    if decoded.len() as u64 > raw_max {
        return Err(RpcErrorCode::InvalidRequest);
    }
    Ok(decoded.len())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


/// Correlated admission refusal. The authenticated node connection supplies the
/// responder identity; this object cannot select a different owner or caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct WorkspaceRejection {
    pub version:u32,
    pub request_id:String,
    pub run_id:String,
    pub attempt:u32,
    pub request_digest:String,
    pub code:RpcErrorCode,
}
impl WorkspaceRejection {
    pub fn validate_for(&self,dispatch:&WorkspaceDispatch)->Result<(),RpcErrorCode> {
        validate_identity(self.version,&self.request_id,&self.run_id,self.attempt,&self.request_digest,dispatch)
    }
}
// Wire payloads can contain private files and arguments. Debug is metadata only.
impl std::fmt::Debug for WorkspaceOperation {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {match self {
        Self::List{path,limit}=>f.debug_struct("List").field("path_bytes",&path.len()).field("limit",limit).finish(),
        Self::Read{path,offset,max_bytes}=>f.debug_struct("Read").field("path_bytes",&path.len()).field("offset",offset).field("max_bytes",max_bytes).finish(),
        Self::Write{path,data}=>f.debug_struct("Write").field("path_bytes",&path.len()).field("encoded_bytes",&data.len()).finish(),
        Self::Run{tool_id,args,cwd}=>f.debug_struct("Run").field("tool_id",tool_id).field("argument_count",&args.len()).field("cwd_bytes",&cwd.len()).finish(),
    }}
}
impl std::fmt::Debug for WorkspaceEntry {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        f.debug_struct("WorkspaceEntry").field("name_bytes",&self.name.len()).field("kind",&self.kind).finish()
    }
}
impl std::fmt::Debug for WorkspaceResult {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {match self {
        Self::List{entries,truncated}=>f.debug_struct("ListResult").field("entry_count",&entries.len()).field("truncated",truncated).finish(),
        Self::Read{data,offset,truncated}=>f.debug_struct("ReadResult").field("encoded_bytes",&data.len()).field("offset",offset).field("truncated",truncated).finish(),
        Self::Write{bytes_written,created}=>f.debug_struct("WriteResult").field("bytes_written",bytes_written).field("created",created).finish(),
        Self::Run{exit_code,output_bytes,omitted_bytes}=>f.debug_struct("RunResult").field("exit_code",exit_code).field("output_bytes",output_bytes).field("omitted_bytes",omitted_bytes).finish(),
    }}
}
impl std::fmt::Debug for WorkspaceEventBody {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {match self {
        Self::Accepted=>f.write_str("Accepted"),
        Self::Output{stream,data}=>f.debug_struct("Output").field("stream",stream).field("encoded_bytes",&data.len()).finish(),
        Self::OutputTruncated{omitted_bytes}=>f.debug_struct("OutputTruncated").field("omitted_bytes",omitted_bytes).finish(),
        Self::Completed{result}=>f.debug_struct("Completed").field("result",result).finish(),
        Self::Failed{code}=>f.debug_struct("Failed").field("code",code).finish(),
        Self::Cancelled{cause}=>f.debug_struct("Cancelled").field("cause",cause).finish(),
        Self::Unknown{code}=>f.debug_struct("Unknown").field("code",code).finish(),
    }}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list_request() -> WorkspaceRequest {
        WorkspaceRequest {
            version: RPC_VERSION,
            request_id: "req_1".to_string(),
            workspace_id: "ws_1".to_string(),
            timeout_ms: 30_000,
            operation: WorkspaceOperation::List {
                path: String::new(),
                limit: 10,
            },
        }
    }

    fn read_operation(path: &str, offset: u64, max_bytes: u32) -> WorkspaceOperation {
        WorkspaceOperation::Read {
            path: path.to_string(),
            offset,
            max_bytes,
        }
    }

    fn run_request(args: Vec<String>) -> WorkspaceRequest {
        WorkspaceRequest {
            version: RPC_VERSION,
            request_id: "req_2".to_string(),
            workspace_id: "ws_1".to_string(),
            timeout_ms: 30_000,
            operation: WorkspaceOperation::Run {
                tool_id: "cargo".to_string(),
                args,
                cwd: String::new(),
            },
        }
    }

    fn run_with_tool(tool_id: &str) -> WorkspaceRequest {
        let mut request = run_request(Vec::new());
        if let WorkspaceOperation::Run {
            tool_id: slot, ..
        } = &mut request.operation
        {
            *slot = tool_id.to_string();
        }
        request
    }

    fn scope() -> CallerScope {
        CallerScope {
            run_id: "run_1".to_string(),
            attempt: 1,
            session_id: "sess_1".to_string(),
            member_id: "member_1".to_string(),
            mission_id: "mission_1".to_string(),
        }
    }

    fn dispatch() -> WorkspaceDispatch {
        WorkspaceDispatch::new(
            list_request(),
            scope(),
            "node_b".to_string(),
            7,
            1_700_000_000_000,
        )
        .expect("the fixture dispatch is valid")
    }

    fn event(
        dispatch: &WorkspaceDispatch,
        seq: u64,
        body: WorkspaceEventBody,
    ) -> WorkspaceEvent {
        WorkspaceEvent {
            version: RPC_VERSION,
            request_id: dispatch.request.request_id.clone(),
            run_id: dispatch.scope.run_id.clone(),
            attempt: dispatch.scope.attempt,
            owner_node_id: dispatch.owner_node_id.clone(),
            request_digest: dispatch.request_digest.clone(),
            seq,
            body,
        }
    }

    fn b64(raw: &[u8]) -> String {
        STANDARD.encode(raw)
    }

    /// Append an unknown field to an already well-shaped JSON object.
    fn with_unknown_field(json: &str) -> String {
        let mut text = json.to_string();
        assert_eq!(text.pop(), Some('}'), "expected a JSON object: {json}");
        text.push_str(",\"unexpected\":1}");
        text
    }

    #[test]
    fn unknown_fields_and_versions_are_rejected_by_the_closed_wire_schema() {
        // Single golden owner for the wire key shape: camelCase fields, `kind`
        // tags. Later assertions only re-read these keys.
        let baseline = dispatch();
        let json = serde_json::to_string(&baseline).expect("dispatch serializes");
        for key in [
            "\"requestDigest\":",
            "\"acceptedAtUnixMs\":",
            "\"deadlineUnixMs\":",
            "\"policyRevision\":",
            "\"ownerNodeId\":",
            "\"timeoutMs\":",
            "\"requestId\":",
            "\"workspaceId\":",
            "\"kind\":\"list\"",
            "\"limit\":10",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        assert_eq!(
            serde_json::from_str::<WorkspaceDispatch>(&json).expect("round trip"),
            baseline
        );

        // Every wire struct rejects an unknown field.
        let request_json = serde_json::to_string(&baseline.request).expect("request");
        let scope_json = serde_json::to_string(&baseline.scope).expect("scope");
        let event_json =
            serde_json::to_string(&event(&baseline, 1, WorkspaceEventBody::Accepted))
                .expect("event");
        let entry_json = serde_json::to_string(&WorkspaceEntry {
            name: "src".to_string(),
            kind: EntryKind::Directory,
        })
        .expect("entry");
        let cancel_json = serde_json::to_string(&WorkspaceCancel {
            version: RPC_VERSION,
            request_id: baseline.request.request_id.clone(),
            run_id: baseline.scope.run_id.clone(),
            attempt: baseline.scope.attempt,
            request_digest: baseline.request_digest.clone(),
            cause: CancelCause::User,
        })
        .expect("cancel");
        let replay_json = serde_json::to_string(&WorkspaceReplay {
            version: RPC_VERSION,
            request_id: baseline.request.request_id.clone(),
            run_id: baseline.scope.run_id.clone(),
            attempt: baseline.scope.attempt,
            request_digest: baseline.request_digest.clone(),
            after_seq: 0,
        })
        .expect("replay");

        assert!(serde_json::from_str::<WorkspaceRequest>(&with_unknown_field(&request_json))
            .is_err());
        assert!(serde_json::from_str::<CallerScope>(&with_unknown_field(&scope_json)).is_err());
        assert!(
            serde_json::from_str::<WorkspaceDispatch>(&with_unknown_field(&json)).is_err()
        );
        assert!(serde_json::from_str::<WorkspaceEvent>(&with_unknown_field(&event_json))
            .is_err());
        assert!(serde_json::from_str::<WorkspaceEntry>(&with_unknown_field(&entry_json))
            .is_err());
        assert!(serde_json::from_str::<WorkspaceCancel>(&with_unknown_field(&cancel_json))
            .is_err());
        assert!(serde_json::from_str::<WorkspaceReplay>(&with_unknown_field(&replay_json))
            .is_err());

        // Nested tagged enums are closed too.
        let nested_operation = concat!(
            r#"{"version":1,"requestId":"req_1","workspaceId":"ws_1","timeoutMs":1,"#,
            r#""operation":{"kind":"list","path":"","limit":1,"zz":1}}"#
        );
        assert!(serde_json::from_str::<WorkspaceRequest>(nested_operation).is_err());
        assert!(serde_json::from_str::<WorkspaceOperation>(
            r#"{"kind":"delete","path":"","limit":1}"#
        )
        .is_err());
        assert!(serde_json::from_str::<WorkspaceResult>(r#"{"kind":"prepare"}"#).is_err());
        assert!(
            serde_json::from_str::<WorkspaceEventBody>(r#"{"kind":"rewound"}"#).is_err()
        );
        assert!(serde_json::from_str::<RpcErrorCode>(r#""bogus""#).is_err());
        assert!(serde_json::from_str::<EntryKind>(r#""symlink""#).is_err());
        assert!(serde_json::from_str::<CancelCause>(r#""timeout""#).is_err());

        // snake_case keys are not part of the wire schema.
        let snake = request_json.replace("\"requestId\"", "\"request_id\"");
        assert!(serde_json::from_str::<WorkspaceRequest>(&snake).is_err());

        // Any version other than 1 is refused before anything else.
        for version in [0_u32, 2, u32::MAX] {
            let mut request = list_request();
            request.version = version;
            assert_eq!(request.validate(), Err(RpcErrorCode::UnsupportedVersion));

            let mut tampered = baseline.clone();
            tampered.version = version;
            assert_eq!(tampered.validate(), Err(RpcErrorCode::UnsupportedVersion));

            let mut tampered = event(&baseline, 1, WorkspaceEventBody::Accepted);
            tampered.version = version;
            assert_eq!(
                tampered.validate_for(&baseline),
                Err(RpcErrorCode::UnsupportedVersion)
            );
        }

        // The error type is closed by type: no variant carries caller data, so
        // Display can only ever print a fixed code.
        fn assert_error<T: std::error::Error>() {}
        assert_error::<RpcErrorCode>();
        let codes = [
            RpcErrorCode::UnsupportedVersion,
            RpcErrorCode::InvalidRequest,
            RpcErrorCode::PathRejected,
            RpcErrorCode::Unauthorized,
            RpcErrorCode::WrongNode,
            RpcErrorCode::PolicyMismatch,
            RpcErrorCode::ToolDenied,
            RpcErrorCode::DeadlineExceeded,
            RpcErrorCode::RequestConflict,
            RpcErrorCode::NotFound,
            RpcErrorCode::NotDirectory,
            RpcErrorCode::NotFile,
            RpcErrorCode::NodeOffline,
            RpcErrorCode::Busy,
            RpcErrorCode::OutputLimit,
            RpcErrorCode::SequenceConflict,
            RpcErrorCode::UnknownOutcome,
            RpcErrorCode::SpawnFailed,
            RpcErrorCode::Cancelled,
            RpcErrorCode::StorageUnavailable,
            RpcErrorCode::UnsupportedPlatform,
        ];
        let mut seen: Vec<&'static str> = Vec::new();
        for code in codes {
            assert_eq!(code.to_string(), code.code());
            assert!(!code.code().is_empty());
            assert!(!seen.contains(&code.code()), "duplicate code {}", code.code());
            seen.push(code.code());
        }
        assert_eq!(seen.len(), 21);
    }

    #[test]
    fn relative_path_rules_reject_foreign_absolute_and_ambiguous_forms_on_every_host() {
        // One expectation table for every host: no `cfg!` branch, because the
        // grammar is checked as a string and never through `std::path`.
        let mut cases: Vec<(&str, bool, bool)> = vec![
            // allow_root only widens the empty case.
            ("", true, true),
            ("", false, false),
            ("src/main.rs", true, true),
            ("src", false, true),
            ("日本語/файл.txt", false, true),
            ("a b/c", true, true),
            // POSIX absolute and UNC.
            ("/etc/passwd", false, false),
            ("/", false, false),
            ("//host/share", false, false),
            // Windows drive, and backslashes anywhere.
            ("C:/x", false, false),
            ("C:x", false, false),
            ("c:\\x", false, false),
            ("\\\\host\\share", false, false),
            ("dir\\file", false, false),
            // Traversal and ambiguity.
            ("..", false, false),
            (".", false, false),
            ("a/../b", false, false),
            ("./src", false, false),
            ("a//b", false, false),
            ("a/", false, false),
            ("a/./b", false, false),
            // NUL, ADS, control characters.
            ("a\0b", false, false),
            ("file.txt:stream", false, false),
            ("dir/a:b", false, false),
            ("a\tb", false, false),
            ("a\u{7f}", false, false),
            // Windows strips a trailing dot or space.
            ("a/b.", false, false),
            ("a b ", false, false),
            // DOS device basenames, case-insensitive and with an extension.
            ("CON", false, false),
            ("con.txt", false, false),
            ("a/NUL", false, false),
            ("Com1.log", false, false),
            ("lpt9", false, false),
            ("ok/CON.txt", false, false),
            ("COM0", false, true),
            ("LPT10", false, true),
            ("console.txt", false, true),
            ("auxiliary", false, true),
        ];
        let bytes_ok = "a".repeat(MAX_PATH_BYTES);
        let bytes_too_long = "a".repeat(MAX_PATH_BYTES + 1);
        cases.push((bytes_ok.as_str(), false, true));
        cases.push((bytes_too_long.as_str(), false, false));
        // 2048 two-byte characters are exactly 4096 bytes; one more is over.
        let multibyte_ok = "é".repeat(MAX_PATH_BYTES / 2);
        let multibyte_too_long = "é".repeat(MAX_PATH_BYTES / 2 + 1);
        cases.push((multibyte_ok.as_str(), false, true));
        cases.push((multibyte_too_long.as_str(), false, false));

        for (raw, allow_root, expected_ok) in cases {
            let result = validate_relative_path(raw, allow_root);
            assert_eq!(
                result.is_ok(),
                expected_ok,
                "raw {raw:?} allow_root {allow_root}"
            );
            if !expected_ok {
                assert_eq!(result, Err(RpcErrorCode::PathRejected), "raw {raw:?}");
            }
        }
    }

    #[test]
    fn request_limits_bound_timeout_listing_reads_argv_and_result_bounds() {
        for (timeout_ms, expected_ok) in [
            (0_u64, false),
            (1, true),
            (MAX_TIMEOUT_MS, true),
            (MAX_TIMEOUT_MS + 1, false),
            (u64::MAX, false),
        ] {
            let mut request = list_request();
            request.timeout_ms = timeout_ms;
            assert_eq!(
                request.validate().is_ok(),
                expected_ok,
                "timeoutMs {timeout_ms}"
            );
        }

        for (limit, expected_ok) in [
            (0_u32, false),
            (1, true),
            (MAX_LIST_ENTRIES, true),
            (MAX_LIST_ENTRIES + 1, false),
        ] {
            let mut request = list_request();
            request.operation = WorkspaceOperation::List {
                path: String::new(),
                limit,
            };
            assert_eq!(request.validate().is_ok(), expected_ok, "limit {limit}");
        }

        for (offset, max_bytes, expected_ok) in [
            (0_u64, 1_u32, true),
            (0, MAX_READ_BYTES, true),
            (7, MAX_READ_BYTES, true),
            (0, 0, false),
            (0, MAX_READ_BYTES + 1, false),
            (u64::MAX - MAX_READ_BYTES as u64 + 1, MAX_READ_BYTES, false),
        ] {
            let mut request = list_request();
            request.operation = read_operation("file.bin", offset, max_bytes);
            assert_eq!(
                request.validate().is_ok(),
                expected_ok,
                "offset {offset} maxBytes {max_bytes}"
            );
        }
        // A read path must be a non-empty relative path.
        let mut request = list_request();
        request.operation = read_operation("", 0, 1);
        assert_eq!(request.validate(), Err(RpcErrorCode::PathRejected));
        let mut request = list_request();
        request.operation = read_operation("/etc/passwd", 0, 1);
        assert_eq!(request.validate(), Err(RpcErrorCode::PathRejected));

        // argv count, single entry size (in bytes, not characters) and total.
        assert!(run_request(vec!["a".to_string(); MAX_ARGV]).validate().is_ok());
        assert_eq!(
            run_request(vec!["a".to_string(); MAX_ARGV + 1]).validate(),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert!(run_request(vec!["a".repeat(MAX_ARG_BYTES)]).validate().is_ok());
        assert_eq!(
            run_request(vec!["a".repeat(MAX_ARG_BYTES + 1)]).validate(),
            Err(RpcErrorCode::InvalidRequest)
        );
        let per_entry = MAX_ARGV_BYTES / MAX_ARG_BYTES;
        assert!(
            run_request(vec!["a".repeat(MAX_ARG_BYTES); per_entry])
                .validate()
                .is_ok()
        );
        let mut total_over = vec!["a".repeat(MAX_ARG_BYTES); per_entry];
        total_over[0].push('a');
        assert_eq!(
            run_request(total_over).validate(),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            run_request(vec!["a\0b".to_string()]).validate(),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert!(
            run_request(vec!["é".repeat(MAX_ARG_BYTES / 2)])
                .validate()
                .is_ok()
        );
        assert_eq!(
            run_request(vec!["é".repeat(MAX_ARG_BYTES / 2 + 1)]).validate(),
            Err(RpcErrorCode::InvalidRequest)
        );
        // argv keeps its original text; only NUL and size are constrained.
        assert!(run_request(vec!["--flag=$HOME; rm -rf /".to_string()])
            .validate()
            .is_ok());

        // Ids: request, workspace, tool and every scope field.
        let long_id = "a".repeat(MAX_ID_BYTES + 1);
        for (value, expected_ok) in [
            ("", false),
            ("a", true),
            ("a.b-c_9", true),
            ("a b", false),
            ("日本語", false),
            ("../x", false),
            (long_id.as_str(), false),
        ] {
            let mut request = list_request();
            request.request_id = value.to_string();
            assert_eq!(request.validate().is_ok(), expected_ok, "requestId {value:?}");

            let mut request = list_request();
            request.workspace_id = value.to_string();
            assert_eq!(
                request.validate().is_ok(),
                expected_ok,
                "workspaceId {value:?}"
            );

            let request = run_with_tool(value);
            assert_eq!(request.validate().is_ok(), expected_ok, "toolId {value:?}");

            for field in 0..4 {
                let mut scope = scope();
                match field {
                    0 => scope.run_id = value.to_string(),
                    1 => scope.session_id = value.to_string(),
                    2 => scope.member_id = value.to_string(),
                    _ => scope.mission_id = value.to_string(),
                }
                assert_eq!(
                    scope.validate().is_ok(),
                    expected_ok,
                    "scope field {field} {value:?}"
                );
            }
        }
        for (attempt, expected_ok) in [(0_u32, false), (1, true), (u32::MAX, true)] {
            let mut scope = scope();
            scope.attempt = attempt;
            assert_eq!(scope.validate().is_ok(), expected_ok, "attempt {attempt}");
        }

        // Event chunk bounds: pre-bounded base64, then decoded size.
        let baseline = dispatch();
        let chunk_ok = b64(&vec![b'x'; MAX_CHUNK_BYTES as usize]);
        assert!(
            event(
                &baseline,
                1,
                WorkspaceEventBody::Output {
                    stream: RpcOutputStream::Stdout,
                    data: chunk_ok,
                }
            )
            .validate_for(&baseline)
            .is_ok()
        );
        let chunk_over = b64(&vec![b'x'; MAX_CHUNK_BYTES as usize + 1]);
        assert_eq!(
            event(
                &baseline,
                1,
                WorkspaceEventBody::Output {
                    stream: RpcOutputStream::Stderr,
                    data: chunk_over,
                }
            )
            .validate_for(&baseline),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            event(
                &baseline,
                1,
                WorkspaceEventBody::Output {
                    stream: RpcOutputStream::Stdout,
                    data: "not base64!".to_string(),
                }
            )
            .validate_for(&baseline),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            event(
                &baseline,
                1,
                WorkspaceEventBody::OutputTruncated { omitted_bytes: 0 }
            )
            .validate_for(&baseline),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert!(
            event(
                &baseline,
                1,
                WorkspaceEventBody::OutputTruncated { omitted_bytes: 1 }
            )
            .validate_for(&baseline)
            .is_ok()
        );

        // Read result bounds and offset identity.
        let mut read_request = list_request();
        read_request.operation = read_operation("file.bin", 5, 8);
        let read_dispatch = WorkspaceDispatch::new(
            read_request,
            scope(),
            "node_b".to_string(),
            7,
            1_700_000_000_000,
        )
        .expect("valid read dispatch");
        let read_request = &read_dispatch.request;
        assert!(WorkspaceResult::Read {
            data: b64(b"12345678"),
            offset: 5,
            truncated: false,
        }
        .validate_for(read_request)
        .is_ok());
        assert_eq!(
            WorkspaceResult::Read {
                data: b64(b"123456789"),
                offset: 5,
                truncated: false,
            }
            .validate_for(read_request),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            WorkspaceResult::Read {
                data: b64(b"1234"),
                offset: 4,
                truncated: false,
            }
            .validate_for(read_request),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            WorkspaceResult::List {
                entries: Vec::new(),
                truncated: false,
            }
            .validate_for(read_request),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert!(
            event(
                &read_dispatch,
                2,
                WorkspaceEventBody::Completed {
                    result: WorkspaceResult::Read {
                        data: b64(b"12345678"),
                        offset: 5,
                        truncated: true,
                    },
                }
            )
            .validate_for(&read_dispatch)
            .is_ok()
        );

        // List result: at most `limit` entries, each a single legal component.
        let list_dispatch = dispatch();
        let list_request = &list_dispatch.request;
        let mut entries = vec![
            WorkspaceEntry {
                name: "src".to_string(),
                kind: EntryKind::Directory,
            };
            10
        ];
        entries[9].kind = EntryKind::File;
        assert!(WorkspaceResult::List {
            entries,
            truncated: true,
        }
        .validate_for(list_request)
        .is_ok());
        assert_eq!(
            WorkspaceResult::List {
                entries: vec![
                    WorkspaceEntry {
                        name: "src".to_string(),
                        kind: EntryKind::File,
                    };
                    11
                ],
                truncated: false,
            }
            .validate_for(list_request),
            Err(RpcErrorCode::InvalidRequest)
        );
        for bad_name in ["a/b", "CON", "", "..", "a:b", "name.", "a\\b", "a\0b"] {
            assert_eq!(
                WorkspaceResult::List {
                    entries: vec![WorkspaceEntry {
                        name: bad_name.to_string(),
                        kind: EntryKind::File,
                    }],
                    truncated: false,
                }
                .validate_for(list_request),
                Err(RpcErrorCode::PathRejected),
                "entry name {bad_name:?}"
            );
        }

        // Run result: total raw output bound, exit code unconstrained, and no
        // overflow in the output accounting.
        let run_dispatch = WorkspaceDispatch::new(
            run_request(vec!["--version".to_string()]),
            scope(),
            "node_b".to_string(),
            7,
            1_700_000_000_000,
        )
        .expect("valid run dispatch");
        let run_request_ref = &run_dispatch.request;
        assert!(WorkspaceResult::Run {
            exit_code: -1,
            output_bytes: MAX_OUTPUT_BYTES,
            omitted_bytes: 0,
        }
        .validate_for(run_request_ref)
        .is_ok());
        assert_eq!(
            WorkspaceResult::Run {
                exit_code: 0,
                output_bytes: MAX_OUTPUT_BYTES + 1,
                omitted_bytes: 0,
            }
            .validate_for(run_request_ref),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            WorkspaceResult::Run {
                exit_code: 0,
                output_bytes: u64::MAX,
                omitted_bytes: 1,
            }
            .validate_for(run_request_ref),
            Err(RpcErrorCode::InvalidRequest)
        );
        // Wrong method again, from the other direction.
        assert_eq!(
            WorkspaceResult::List {
                entries: Vec::new(),
                truncated: false,
            }
            .validate_for(run_request_ref),
            Err(RpcErrorCode::InvalidRequest)
        );
    }

    #[test]
    fn write_operation_carries_only_a_contained_relative_path_and_bounded_complete_bytes() {
        fn write_request(path: &str, data: String) -> WorkspaceRequest {
            WorkspaceRequest {
                version: RPC_VERSION,
                request_id: "req_write".to_string(),
                workspace_id: "ws_1".to_string(),
                timeout_ms: 30_000,
                operation: WorkspaceOperation::Write {
                    path: path.to_string(),
                    data,
                },
            }
        }

        // A well-formed write round-trips as the tagged `write` operation and is
        // closed against an unknown field exactly like every other variant.
        let request = write_request("out/report.md", b64(b"# report\n"));
        assert_eq!(request.validate(), Ok(()));
        let json = serde_json::to_string(&request.operation).expect("operation serializes");
        assert!(json.contains(r#""kind":"write""#), "{json}");
        assert!(json.contains(r#""data":""#), "{json}");
        assert_eq!(
            serde_json::from_str::<WorkspaceOperation>(&json).expect("write round trip"),
            request.operation
        );
        let unknown = json.replace("}", r#","mode":"append"}"#);
        assert!(serde_json::from_str::<WorkspaceOperation>(&unknown).is_err());
        assert!(serde_json::from_str::<WorkspaceOperation>(
            r#"{"kind":"write","path":"a","data":"","delete":true}"#
        )
        .is_err());

        // The target must be a non-empty relative path with no traversal, no
        // foreign absolute form and no Git metadata component.
        for path in [
            "out/report.md",
            "report.md",
            "日本語/файл.txt",
            "out/deep/file.bin",
        ] {
            assert_eq!(write_request(path, b64(b"x")).validate(), Ok(()), "{path}");
        }
        for path in [
            "",
            "/x.txt",
            "../x.txt",
            "./x.txt",
            "a/../../x.txt",
            "a//b",
            "a/",
            "C:/x.txt",
            "C:x.txt",
            "dir\\file",
            "\\\\host\\share",
            "a\0b",
            "a:b",
            "CON.txt",
            ".git/config",
            ".git",
            "sub/.git/HEAD",
            "sub/.GIT/HEAD",
        ] {
            assert_eq!(
                write_request(path, b64(b"x")).validate(),
                Err(RpcErrorCode::PathRejected),
                "{path:?}"
            );
        }

        // Exactly 1 MiB of decoded bytes is admitted; one byte more is not.
        let exact = b64(&vec![b'x'; MAX_WRITE_BYTES as usize]);
        assert_eq!(write_request("big.bin", exact.clone()).validate(), Ok(()));
        let over = b64(&vec![b'x'; MAX_WRITE_BYTES as usize + 1]);
        assert_eq!(
            write_request("big.bin", over).validate(),
            Err(RpcErrorCode::InvalidRequest)
        );
        // An empty payload is an empty file, not a deletion.
        assert_eq!(write_request("empty.txt", String::new()).validate(), Ok(()));
        assert_eq!(
            write_request("bad.bin", "not base64!".to_string()).validate(),
            Err(RpcErrorCode::InvalidRequest)
        );
        // Padding-free input is not part of the standard padded grammar.
        assert_eq!(
            write_request("bad.bin", STANDARD.encode(b"xy").trim_end_matches('=').to_string())
                .validate(),
            Err(RpcErrorCode::InvalidRequest)
        );

        // The result reports counts only, bounded by the same 1 MiB ceiling, and
        // cannot stand in for another operation's result.
        let write_dispatch = WorkspaceDispatch::new(
            write_request("out/report.md", b64(b"# report\n")),
            scope(),
            "node_b".to_string(),
            7,
            1_700_000_000_000,
        )
        .expect("valid write dispatch");
        let write_request_ref = &write_dispatch.request;
        assert!(WorkspaceResult::Write {
            bytes_written: 9,
            created: true,
        }
        .validate_for(write_request_ref)
        .is_ok());
        assert_eq!(
            WorkspaceResult::Write {
                bytes_written: u64::from(MAX_WRITE_BYTES) + 1,
                created: false,
            }
            .validate_for(write_request_ref),
            Err(RpcErrorCode::InvalidRequest)
        );
        for wrong in [
            WorkspaceResult::List {
                entries: Vec::new(),
                truncated: false,
            },
            WorkspaceResult::Read {
                data: b64(b"x"),
                offset: 0,
                truncated: false,
            },
            WorkspaceResult::Run {
                exit_code: 0,
                output_bytes: 0,
                omitted_bytes: 0,
            },
        ] {
            assert_eq!(
                wrong.validate_for(write_request_ref),
                Err(RpcErrorCode::InvalidRequest)
            );
        }
        assert!(
            event(
                &write_dispatch,
                2,
                WorkspaceEventBody::Completed {
                    result: WorkspaceResult::Write {
                        bytes_written: 9,
                        created: true,
                    },
                }
            )
            .validate_for(&write_dispatch)
            .is_ok()
        );

        // Debug stays metadata only: the path text and the payload bytes are
        // never rendered.
        let operation = WorkspaceOperation::Write {
            path: "out/report.md".to_string(),
            data: b64(b"# report\n"),
        };
        let result = WorkspaceResult::Write {
            bytes_written: 9,
            created: true,
        };
        let rendered = format!("{operation:?}{result:?}");
        assert!(!rendered.contains("report"), "{rendered}");
        assert!(!rendered.contains("IyByZXBvcnQ"), "{rendered}");
        assert!(rendered.contains("path_bytes"), "{rendered}");
        assert!(rendered.contains("bytes_written"), "{rendered}");
    }

    #[test]
    fn dispatch_digest_freezes_identity_policy_and_deadline() {
        let baseline = dispatch();
        assert_eq!(baseline.deadline_unix_ms, 1_700_000_000_000 + 30_000);
        assert_eq!(baseline.request_digest.len(), 64);
        assert!(baseline
            .request_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_eq!(baseline.validate(), Ok(()));

        // Deterministic: same inputs, same digest.
        let again = WorkspaceDispatch::new(
            list_request(),
            scope(),
            "node_b".to_string(),
            7,
            1_700_000_000_000,
        )
        .expect("valid dispatch");
        assert_eq!(again.request_digest, baseline.request_digest);
        assert_eq!(again, baseline);

        // Request fingerprint is a separate, also deterministic identity.
        let fingerprint = baseline.request.fingerprint().expect("fingerprint");
        assert_eq!(fingerprint.len(), 64);
        assert_eq!(
            fingerprint,
            list_request().fingerprint().expect("fingerprint")
        );
        assert_ne!(fingerprint, baseline.request_digest);
        let mut changed = list_request();
        changed.timeout_ms = 30_001;
        assert_ne!(changed.fingerprint().expect("fingerprint"), fingerprint);
        let mut invalid = list_request();
        invalid.request_id = String::new();
        assert_eq!(invalid.fingerprint(), Err(RpcErrorCode::InvalidRequest));

        // Any edit to request, scope, owner, policy, accepted time or deadline
        // makes validate() fail, even though the fields are public.
        fn assert_conflict(label: &str, tampered: WorkspaceDispatch) {
            assert_eq!(
                tampered.validate(),
                Err(RpcErrorCode::RequestConflict),
                "{label}"
            );
        }

        let mut tampered = baseline.clone();
        tampered.request.timeout_ms = 30_001;
        assert_conflict("request timeout edited", tampered);

        let mut tampered = baseline.clone();
        tampered.request.operation = WorkspaceOperation::List {
            path: "src".to_string(),
            limit: 10,
        };
        assert_conflict("request operation edited", tampered);

        let mut tampered = baseline.clone();
        tampered.request.request_id = "req_other".to_string();
        assert_conflict("request id edited", tampered);

        let mut tampered = baseline.clone();
        tampered.scope.run_id = "run_other".to_string();
        assert_conflict("scope run edited", tampered);

        let mut tampered = baseline.clone();
        tampered.scope.attempt = 2;
        assert_conflict("scope attempt edited", tampered);

        let mut tampered = baseline.clone();
        tampered.scope.mission_id = "mission_other".to_string();
        assert_conflict("scope mission edited", tampered);

        let mut tampered = baseline.clone();
        tampered.owner_node_id = "node_c".to_string();
        assert_conflict("owner node edited", tampered);

        let mut tampered = baseline.clone();
        tampered.policy_revision = 8;
        assert_conflict("policy revision edited", tampered);

        let mut tampered = baseline.clone();
        tampered.accepted_at_unix_ms += 1;
        assert_conflict("accepted time edited", tampered);

        // The deadline is fixed at construction and cannot be extended.
        let mut tampered = baseline.clone();
        tampered.deadline_unix_ms += 1;
        assert_conflict("deadline extended", tampered);

        let mut tampered = baseline.clone();
        tampered.deadline_unix_ms -= 1;
        assert_conflict("deadline shortened", tampered);

        let mut tampered = baseline.clone();
        tampered.request_digest = "a".repeat(64);
        assert_conflict("digest replaced", tampered);

        assert_eq!(
            WorkspaceDispatch::new(list_request(), scope(), "node_b".to_string(), 0, 1),
            Err(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            WorkspaceDispatch::new(list_request(), scope(), String::new(), 1, 1),
            Err(RpcErrorCode::InvalidRequest)
        );
        // Unix epoch zero is valid; only deadline overflow is rejected.
        assert!(WorkspaceDispatch::new(list_request(), scope(), "node_b".to_string(), 1, 0).is_ok());
        assert_eq!(
            WorkspaceDispatch::new(list_request(), scope(), "node_b".to_string(), 1, u64::MAX),
            Err(RpcErrorCode::InvalidRequest)
        );
        let mut tiny = list_request();
        tiny.timeout_ms = 1;
        assert!(WorkspaceDispatch::new(
            tiny.clone(),
            scope(),
            "node_b".to_string(),
            1,
            u64::MAX - 1
        )
        .is_ok());
        assert_eq!(
            WorkspaceDispatch::new(tiny, scope(), "node_b".to_string(), 1, u64::MAX),
            Err(RpcErrorCode::InvalidRequest)
        );

        // validate() is read-only: it cannot move the fixed deadline.
        let deadline_before = baseline.deadline_unix_ms;
        assert_eq!(baseline.validate(), Ok(()));
        assert_eq!(baseline.deadline_unix_ms, deadline_before);

        // Cancel and replay bind to the same identity.
        let cancel = WorkspaceCancel {
            version: RPC_VERSION,
            request_id: baseline.request.request_id.clone(),
            run_id: baseline.scope.run_id.clone(),
            attempt: baseline.scope.attempt,
            request_digest: baseline.request_digest.clone(),
            cause: CancelCause::User,
        };
        assert_eq!(cancel.validate_for(&baseline), Ok(()));
        let mut tampered = cancel.clone();
        tampered.request_id = "req_other".to_string();
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = cancel.clone();
        tampered.run_id = "run_other".to_string();
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = cancel.clone();
        tampered.attempt = 2;
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = cancel.clone();
        tampered.request_digest = "b".repeat(64);
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = cancel;
        tampered.version = 2;
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::UnsupportedVersion)
        );

        let replay = WorkspaceReplay {
            version: RPC_VERSION,
            request_id: baseline.request.request_id.clone(),
            run_id: baseline.scope.run_id.clone(),
            attempt: baseline.scope.attempt,
            request_digest: baseline.request_digest.clone(),
            after_seq: 0,
        };
        assert_eq!(replay.validate_for(&baseline), Ok(()));
        let mut tampered = replay.clone();
        tampered.attempt = 3;
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = replay;
        tampered.version = 0;
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::UnsupportedVersion)
        );

        // Events must carry the dispatch identity, not an echoed one.
        let accepted = event(&baseline, 1, WorkspaceEventBody::Accepted);
        assert_eq!(accepted.validate_for(&baseline), Ok(()));
        let mut tampered = accepted.clone();
        tampered.seq = 0;
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::InvalidRequest)
        );
        let mut tampered = accepted.clone();
        tampered.request_id = "req_other".to_string();
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = accepted.clone();
        tampered.run_id = "run_other".to_string();
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = accepted.clone();
        tampered.attempt = 9;
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = accepted.clone();
        tampered.owner_node_id = "node_c".to_string();
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
        let mut tampered = accepted;
        tampered.request_digest = "c".repeat(64);
        assert_eq!(
            tampered.validate_for(&baseline),
            Err(RpcErrorCode::RequestConflict)
        );
    }
}
