//! Core-side SQLite request journal for the Workspace RPC v1 protocol.
//!
//! This module owns the durable, crash-safe side of the contract defined in
//! `loom_protocol::workspace_rpc`. It stores three tables only
//! (`workspace_rpc_requests`, `workspace_rpc_events`, `workspace_rpc_audit`) at
//! schema head [`SCHEMA_MIGRATION_HEAD`]; it never opens files, never changes a
//! database `PRAGMA` and never builds a dispatch from operator-supplied
//! identity.
//!
//! Trust boundary: [`TrustedPrincipal`] and [`WorkspaceGrant`] are created only
//! by the trusted Core adapter. Neither is `Deserialize`, so an inbound request
//! cannot manufacture a caller identity or a grant. The external
//! [`WorkspaceRequest`] stays identity-free; identity lives in the stored
//! [`WorkspaceDispatch`].
//!
//! Every mutation commits its transaction before a dispatch or its success is
//! returned. Errors are a closed [`RpcErrorCode`] set, so no argument, body,
//! path or base64 payload can be carried out in an error string.

use std::collections::BTreeSet;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use loom_protocol::workspace_rpc::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[path = "workspace_rpc_archive.rs"]
mod archive;
pub use archive::{
    VerifiedArchiveSet, WorkspaceArchiveKind, WorkspaceArchiveReceipt, archive_completed_results,
    read_archived_result_bytes,
};

/// Maximum retained events per request. One slot is reserved for the terminal
/// event, so a stream of data events can never squeeze out the final state.
const MAX_RETAINED_EVENTS: u64 = 512;
/// Pending (non-terminal) requests allowed for a single run.
const MAX_PENDING_PER_RUN: i64 = 32;
/// Pending requests allowed for a single owner node.
const MAX_PENDING_PER_NODE: i64 = 128;
/// Smallest accepted replay page.
const REPLAY_MIN_LIMIT: usize = 1;
/// Largest accepted replay page.
const REPLAY_MAX_LIMIT: usize = 256;
/// Schema head this module owns and expects. Reserved, never written to the
/// connection's `user_version`.
#[allow(dead_code)]
const SCHEMA_MIGRATION_HEAD: i32 = 230;
/// Domain separator so an event hash cannot collide with a request or dispatch
/// digest from another protocol surface.
const EVENT_HASH_DOMAIN: &str = "loom.workspace_rpc.event.v1";

// ---------------------------------------------------------------------------
// Trusted types (never deserialized)
// ---------------------------------------------------------------------------

/// Trusted caller identity. Constructed by the trusted Core adapter only. There
/// is deliberately no `Deserialize`: JSON cannot mint a principal.
#[derive(Debug, Clone)]
pub enum TrustedPrincipal {
    /// A single attempt of a run, carrying the authoritative caller scope.
    AgentRun(CallerScope),
    Administrator,
    Node,
}

/// Bounded authority Core grants for one workspace. Built by the trusted
/// adapter; never decoded from a request. `online_generation` is `None` when
/// the owner node is offline.
#[derive(Debug, Clone)]
pub struct WorkspaceGrant {
    pub workspace_id: String,
    pub mission_id: String,
    pub owner_node_id: String,
    pub policy_revision: u64,
    pub allow_list: bool,
    pub allow_read: bool,
    pub allow_write: bool,
    pub allowed_tools: BTreeSet<String>,
    pub online_generation: Option<u64>,
}

impl WorkspaceGrant {
    /// Whether this grant permits the requested filesystem / tool operation.
    fn permits(&self, operation: &WorkspaceOperation) -> bool {
        match operation {
            WorkspaceOperation::List { .. } => self.allow_list,
            WorkspaceOperation::Read { .. } => self.allow_read,
            WorkspaceOperation::Write { .. } => self.allow_write,
            WorkspaceOperation::Run { tool_id, .. } => self.allowed_tools.contains(tool_id),
        }
    }
}

// ---------------------------------------------------------------------------
// Journal value types
// ---------------------------------------------------------------------------

/// Durable request state. The integer encoding below is stable and explicit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestState {
    Queued,
    Dispatched,
    Running,
    CancelRequested,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

impl RequestState {
    fn to_i64(self) -> i64 {
        match self {
            RequestState::Queued => 0,
            RequestState::Dispatched => 1,
            RequestState::Running => 2,
            RequestState::CancelRequested => 3,
            RequestState::Completed => 4,
            RequestState::Failed => 5,
            RequestState::Cancelled => 6,
            RequestState::Unknown => 7,
        }
    }

    fn from_i64(value: i64) -> Result<Self, RpcErrorCode> {
        Ok(match value {
            0 => RequestState::Queued,
            1 => RequestState::Dispatched,
            2 => RequestState::Running,
            3 => RequestState::CancelRequested,
            4 => RequestState::Completed,
            5 => RequestState::Failed,
            6 => RequestState::Cancelled,
            7 => RequestState::Unknown,
            _ => return Err(RpcErrorCode::StorageUnavailable),
        })
    }

    /// Final states accept no further events (except exact duplicates). `Unknown`
    /// is deliberately *not* terminal: a late definitive event may resolve it.
    fn is_terminal(self) -> bool {
        matches!(
            self,
            RequestState::Completed | RequestState::Failed | RequestState::Cancelled
        )
    }
}

/// Status of a stored request. Identity and deadline are the *original* ones,
/// copied from the retained dispatch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestStatus {
    pub request_id: String,
    pub state: RequestState,
    pub dispatch: WorkspaceDispatch,
    pub last_seq: u64,
    pub output_bytes: u64,
    pub omitted_bytes: u64,
    pub archives: Vec<WorkspaceArchiveReceipt>,
}

/// Result of [`WorkspaceRpcStore::admit`].
#[derive(Debug, Clone)]
pub enum Admission {
    /// A fresh request; the dispatch must be sent on an authenticated channel.
    Dispatch(WorkspaceDispatch),
    /// An exact retry of an already-admitted request; replay the original.
    Replay(RequestStatus),
}

/// Result of [`WorkspaceRpcStore::cancel`].
#[derive(Debug, Clone)]
pub enum CancelOutcome {
    /// A queued request was cancelled locally and terminally. No node event is
    /// invented.
    CancelledLocally,
    /// Forward this cancel to the node; the request stays `CancelRequested`
    /// until the node confirms its process tree is empty.
    Forward(WorkspaceCancel),
    /// The request already reached a terminal state; cancel is a stable no-op.
    AlreadyTerminal(RequestState),
}

/// Result of [`WorkspaceRpcStore::replay`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResponse {
    pub status: RequestStatus,
    pub events: Vec<WorkspaceEvent>,
}

/// Delivery controls after an authenticated node reconnects. There is
/// deliberately no Dispatch variant, so this path cannot restart work.
#[derive(Debug, Clone)]
pub struct ResumeControl {
    pub replay: WorkspaceReplay,
    pub cancel: Option<WorkspaceCancel>,
}

/// One request row as loaded from disk.
struct StoredRequest {
    dispatch: WorkspaceDispatch,
    fingerprint: String,
    online_generation: u64,
    state: RequestState,
    last_seq: u64,
    output_bytes: u64,
    omitted_bytes: u64,
    accepted_seen: bool,
    cancel_cause: Option<CancelCause>,
    archives: Vec<WorkspaceArchiveReceipt>,
}

impl StoredRequest {
    fn status(&self) -> RequestStatus {
        RequestStatus {
            request_id: self.dispatch.request.request_id.clone(),
            state: self.state,
            dispatch: self.dispatch.clone(),
            last_seq: self.last_seq,
            output_bytes: self.output_bytes,
            omitted_bytes: self.omitted_bytes,
            archives: self.archives.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

pub const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS workspace_rpc_requests (
    request_id         TEXT PRIMARY KEY,
    run_id             TEXT NOT NULL,
    owner_node_id      TEXT NOT NULL,
    fingerprint        TEXT NOT NULL,
    online_generation  INTEGER NOT NULL,
    dispatch_json      TEXT NOT NULL,
    state              INTEGER NOT NULL,
    last_seq           INTEGER NOT NULL,
    output_bytes       INTEGER NOT NULL,
    omitted_bytes      INTEGER NOT NULL,
    accepted_seen      INTEGER NOT NULL,
    cancel_cause       INTEGER,
    archive_receipts_json TEXT NOT NULL DEFAULT '[]',
    created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_rpc_requests_run_id
    ON workspace_rpc_requests(run_id);
CREATE INDEX IF NOT EXISTS workspace_rpc_requests_owner_node
    ON workspace_rpc_requests(owner_node_id);
CREATE TABLE IF NOT EXISTS workspace_rpc_events (
    request_id     TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    canonical_hash TEXT NOT NULL,
    body_json      TEXT NOT NULL,
    PRIMARY KEY (request_id, seq)
);
CREATE TABLE IF NOT EXISTS workspace_rpc_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    state      INTEGER NOT NULL,
    seq        INTEGER,
    code       TEXT,
    at_unix_ms INTEGER NOT NULL
);
";

/// Compare tables, columns/constraints, and indexes with SQLite's own parsed
/// form of this exact schema. Same-named objects with weakened definitions do
/// not satisfy the migration contract. No pragma or caller database is changed.
pub fn schema_matches(conn: &Connection) -> rusqlite::Result<bool> {
    fn objects(
        conn: &Connection,
    ) -> rusqlite::Result<Vec<(String, String, String, Option<String>)>> {
        let mut statement=conn.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master
            WHERE tbl_name IN ('workspace_rpc_requests','workspace_rpc_events','workspace_rpc_audit')
            ORDER BY type,name")?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get::<_, Option<String>>(3)?
                        .map(|sql| normalize_schema_sql(&sql)),
                ))
            })?
            .collect()
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA)?;
    Ok(objects(conn)? == objects(&expected)?)
}
fn normalize_schema_sql(sql: &str) -> String {
    let mut result = String::new();
    let mut quote = None;
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(end) = quote {
            result.push(c);
            if c == end {
                if chars.peek() == Some(&end) {
                    result.push(chars.next().unwrap());
                } else {
                    quote = None;
                }
            }
        } else if matches!(c, '\'' | '"' | '[') || c as u32 == 96 {
            quote = Some(if c == '[' { ']' } else { c });
            result.push(c);
        } else if !c.is_ascii_whitespace() {
            result.push(c);
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Stateless façade over the journal; every entry point takes the connection.
pub struct WorkspaceRpcStore;

impl WorkspaceRpcStore {
    /// Create the journal tables. Callers (migration, tests) invoke this
    /// explicitly; no method lazily initializes schema.
    pub fn install_schema(conn: &Connection) -> Result<(), RpcErrorCode> {
        conn.execute_batch(SCHEMA)
            .map_err(|_| RpcErrorCode::StorageUnavailable)
    }

    /// Admit a request or replay the original for an exact retry.
    ///
    /// Ordering: identity authorization runs first; a prior record is only
    /// consulted for an authorized caller. An offline grant still replays an
    /// existing request (its fixed deadline is unchanged) and only rejects a
    /// *new* request with `NodeOffline`. The transaction commits before the
    /// dispatch is returned.
    pub fn admit(
        conn: &mut Connection,
        principal: &TrustedPrincipal,
        grant: &WorkspaceGrant,
        request: WorkspaceRequest,
        now: u64,
    ) -> Result<Admission, RpcErrorCode> {
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let conn = &transaction;

        let scope = match principal {
            TrustedPrincipal::AgentRun(scope) => scope.clone(),
            // Administrator and Node are never accepted as an agent caller.
            TrustedPrincipal::Administrator | TrustedPrincipal::Node => {
                return Err(RpcErrorCode::Unauthorized);
            }
        };
        scope.validate()?;
        request.validate()?;
        if request.workspace_id != grant.workspace_id || scope.mission_id != grant.mission_id {
            return Err(RpcErrorCode::Unauthorized);
        }
        if !grant.permits(&request.operation) {
            return Err(RpcErrorCode::ToolDenied);
        }
        let fingerprint = request.fingerprint()?;

        if let Some(row) = load_request(conn, &request.request_id)? {
            if !scope_matches(&row.dispatch, &scope) {
                return Err(RpcErrorCode::Unauthorized);
            }
            if row.fingerprint != fingerprint {
                return Err(RpcErrorCode::RequestConflict);
            }
            // A changed policy revision or owner on a retry is a stale grant, not
            // a silent remap of the original request onto new authority.
            if grant.policy_revision != row.dispatch.policy_revision
                || grant.owner_node_id != row.dispatch.owner_node_id
            {
                return Err(RpcErrorCode::PolicyMismatch);
            }
            return Ok(Admission::Replay(row.status()));
        }

        // New request: online status and pending caps; permission was checked above.
        let online_generation = match grant.online_generation {
            Some(generation) if generation > 0 => generation,
            Some(_) => return Err(RpcErrorCode::InvalidRequest),
            None => return Err(RpcErrorCode::NodeOffline),
        };
        if count_pending_for_run(conn, &scope.run_id)? >= MAX_PENDING_PER_RUN {
            return Err(RpcErrorCode::Busy);
        }
        if count_pending_for_node(conn, &grant.owner_node_id)? >= MAX_PENDING_PER_NODE {
            return Err(RpcErrorCode::Busy);
        }

        let dispatch = WorkspaceDispatch::new(
            request,
            scope,
            grant.owner_node_id.clone(),
            grant.policy_revision,
            now,
        )?;
        let request_id = dispatch.request.request_id.clone();

        insert_request(conn, &dispatch, &fingerprint, online_generation)?;
        audit(conn, &request_id, RequestState::Queued, None, None, now)?;
        transaction
            .commit()
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        Ok(Admission::Dispatch(dispatch))
    }

    /// Mark a `Queued` request as sent. Only `Queued` transitions, the fixed
    /// deadline is never extended, and the generation must match the grant. A
    /// `Queued` request whose deadline already passed is cancelled locally with
    /// `Deadline` and reported as `DeadlineExceeded`; a sent request never
    /// claims cancellation here.
    pub fn mark_dispatched(
        conn: &mut Connection,
        request_id: &str,
        generation: u64,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        Self::mark_dispatched_authorized(conn, request_id, generation, now, |_, _| Ok(()))
    }

    /// Production adapter revalidation is inside the same write transaction as
    /// the dispatch receipt, so a second DB connection cannot revoke the Run
    /// between the authoritative read and the durable delivery decision.
    pub fn mark_dispatched_authorized(
        conn: &mut Connection,
        request_id: &str,
        generation: u64,
        now: u64,
        authorize: impl FnOnce(&Connection, &WorkspaceDispatch) -> Result<(), RpcErrorCode>,
    ) -> Result<(), RpcErrorCode> {
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let conn = &transaction;

        let row = load_request(conn, request_id)?.ok_or(RpcErrorCode::NotFound)?;
        authorize(conn, &row.dispatch)?;
        if row.online_generation != generation {
            return Err(RpcErrorCode::RequestConflict);
        }
        match row.state {
            RequestState::Queued => {
                if now < row.dispatch.deadline_unix_ms {
                    set_state(conn, request_id, RequestState::Dispatched, None)?;
                    audit(conn, request_id, RequestState::Dispatched, None, None, now)?;
                    transaction
                        .commit()
                        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                    Ok(())
                } else {
                    set_state(
                        conn,
                        request_id,
                        RequestState::Cancelled,
                        Some(CancelCause::Deadline),
                    )?;
                    audit(
                        conn,
                        request_id,
                        RequestState::Cancelled,
                        None,
                        Some(RpcErrorCode::DeadlineExceeded.code()),
                        now,
                    )?;
                    transaction
                        .commit()
                        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                    Err(RpcErrorCode::DeadlineExceeded)
                }
            }
            _ => Err(RpcErrorCode::RequestConflict),
        }
    }

    /// Append a node event. The authenticated node and generation must match the
    /// grant; the event must bind to the stored dispatch identity and be
    /// contiguous. Exact duplicates at the same sequence with the same canonical
    /// hash are idempotent; a conflicting hash or a gap is rejected.
    pub fn append_event(
        conn: &mut Connection,
        authenticated_node: &str,
        generation: u64,
        event: &WorkspaceEvent,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let conn = &transaction;

        let row = load_request(conn, &event.request_id)?.ok_or(RpcErrorCode::NotFound)?;
        if authenticated_node != row.dispatch.owner_node_id {
            return Err(RpcErrorCode::WrongNode);
        }
        if row.online_generation != generation {
            return Err(RpcErrorCode::RequestConflict);
        }
        event.validate_for(&row.dispatch)?;
        let hash = canonical_event_hash(event)?;
        let seq = event.seq;

        // Exact duplicates are resolved before any state gating.
        if let Some(existing) = load_event_hash(conn, &event.request_id, seq)? {
            return if existing == hash {
                Ok(())
            } else {
                Err(RpcErrorCode::SequenceConflict)
            };
        }

        let expected = row
            .last_seq
            .checked_add(1)
            .ok_or(RpcErrorCode::SequenceConflict)?;
        if seq != expected {
            return Err(RpcErrorCode::SequenceConflict);
        }
        if row.state == RequestState::Queued {
            return Err(RpcErrorCode::RequestConflict);
        }
        if row.state.is_terminal() {
            return Err(RpcErrorCode::SequenceConflict);
        }

        let is_terminal_body = matches!(
            &event.body,
            WorkspaceEventBody::Completed { .. }
                | WorkspaceEventBody::Failed { .. }
                | WorkspaceEventBody::Cancelled { .. }
        );
        if is_terminal_body {
            if seq > MAX_RETAINED_EVENTS {
                return Err(RpcErrorCode::Busy);
            }
        } else if seq >= MAX_RETAINED_EVENTS {
            // Reserve the final slot for a terminal event; reject the excess data
            // event without touching sequence or state.
            return Err(RpcErrorCode::OutputLimit);
        }

        let is_run = matches!(
            &row.dispatch.request.operation,
            WorkspaceOperation::Run { .. }
        );
        let mut new_output = row.output_bytes;
        let mut new_omitted = row.omitted_bytes;
        let mut new_accepted = row.accepted_seen;
        let keep = |current: RequestState| {
            if current == RequestState::CancelRequested {
                RequestState::CancelRequested
            } else {
                RequestState::Running
            }
        };
        let new_state = match &event.body {
            WorkspaceEventBody::Accepted => {
                if seq != 1 || row.accepted_seen {
                    return Err(RpcErrorCode::SequenceConflict);
                }
                new_accepted = true;
                // Never regress an already-requested cancellation.
                keep(row.state)
            }
            WorkspaceEventBody::Output { data, .. } => {
                if !is_run || !row.accepted_seen {
                    return Err(RpcErrorCode::RequestConflict);
                }
                let decoded = decode_len(data)?;
                if decoded == 0 {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                new_output = row
                    .output_bytes
                    .checked_add(decoded)
                    .ok_or(RpcErrorCode::OutputLimit)?;
                if new_output > MAX_OUTPUT_BYTES {
                    return Err(RpcErrorCode::OutputLimit);
                }
                if new_output.checked_add(new_omitted).is_none() {
                    return Err(RpcErrorCode::OutputLimit);
                }
                keep(row.state)
            }
            WorkspaceEventBody::OutputTruncated { omitted_bytes } => {
                if !is_run || !row.accepted_seen {
                    return Err(RpcErrorCode::RequestConflict);
                }
                if *omitted_bytes == 0 {
                    return Err(RpcErrorCode::InvalidRequest);
                }
                new_omitted = row
                    .omitted_bytes
                    .checked_add(*omitted_bytes)
                    .ok_or(RpcErrorCode::OutputLimit)?;
                if new_output.checked_add(new_omitted).is_none() {
                    return Err(RpcErrorCode::OutputLimit);
                }
                keep(row.state)
            }
            WorkspaceEventBody::Completed { result } => {
                if !row.accepted_seen {
                    return Err(RpcErrorCode::SequenceConflict);
                }
                if let WorkspaceResult::Run {
                    output_bytes,
                    omitted_bytes,
                    ..
                } = result
                {
                    if *output_bytes != row.output_bytes || *omitted_bytes != row.omitted_bytes {
                        return Err(RpcErrorCode::RequestConflict);
                    }
                }
                RequestState::Completed
            }
            WorkspaceEventBody::Failed { .. } => RequestState::Failed,
            WorkspaceEventBody::Cancelled { .. } => RequestState::Cancelled,
            WorkspaceEventBody::Unknown { .. } => RequestState::Unknown,
        };

        let audit_code = match &event.body {
            WorkspaceEventBody::Failed { code } => Some(code.code()),
            WorkspaceEventBody::Cancelled { .. } => Some(RpcErrorCode::Cancelled.code()),
            WorkspaceEventBody::Unknown { code } => Some(code.code()),
            _ => None,
        };
        let body_json =
            serde_json::to_string(&event.body).map_err(|_| RpcErrorCode::InvalidRequest)?;
        let seq_i64 = as_i64(seq)?;

        store_event(conn, &event.request_id, seq_i64, &hash, &body_json)?;
        update_after_event(
            conn,
            &event.request_id,
            new_state,
            seq_i64,
            as_i64(new_output)?,
            as_i64(new_omitted)?,
            new_accepted,
        )?;
        audit(
            conn,
            &event.request_id,
            new_state,
            Some(seq),
            audit_code,
            now,
        )?;
        transaction
            .commit()
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        Ok(())
    }

    /// Cancel a request. Only the exact owning `AgentRun` scope (all five
    /// fields) may cancel, and an unknown id or a foreign scope both return
    /// `Unauthorized` so callers cannot probe for existence. The first cause is
    /// retained so a repeated cancel returns the same [`WorkspaceCancel`].
    pub fn cancel(
        conn: &mut Connection,
        principal: &TrustedPrincipal,
        request_id: &str,
        cause: CancelCause,
        now: u64,
    ) -> Result<CancelOutcome, RpcErrorCode> {
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let conn = &transaction;

        let scope = match principal {
            TrustedPrincipal::AgentRun(scope) => scope,
            TrustedPrincipal::Administrator | TrustedPrincipal::Node => {
                return Err(RpcErrorCode::Unauthorized);
            }
        };
        scope.validate()?;
        let row = load_request(conn, request_id)?.ok_or(RpcErrorCode::Unauthorized)?;
        if !scope_matches(&row.dispatch, scope) {
            return Err(RpcErrorCode::Unauthorized);
        }
        match row.state {
            RequestState::Queued => {
                set_state(conn, request_id, RequestState::Cancelled, Some(cause))?;
                audit(
                    conn,
                    request_id,
                    RequestState::Cancelled,
                    None,
                    Some(RpcErrorCode::Cancelled.code()),
                    now,
                )?;
                transaction
                    .commit()
                    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                Ok(CancelOutcome::CancelledLocally)
            }
            RequestState::Dispatched | RequestState::Running | RequestState::Unknown => {
                let effective = row.cancel_cause.unwrap_or(cause);

                set_state(
                    conn,
                    request_id,
                    RequestState::CancelRequested,
                    Some(effective),
                )?;
                audit(
                    conn,
                    request_id,
                    RequestState::CancelRequested,
                    None,
                    Some(RpcErrorCode::Cancelled.code()),
                    now,
                )?;
                transaction
                    .commit()
                    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                Ok(CancelOutcome::Forward(build_cancel(
                    &row.dispatch,
                    effective,
                )))
            }
            // Repeated cancel: stable, same retained cause.
            RequestState::CancelRequested => {
                let effective = row.cancel_cause.unwrap_or(cause);
                Ok(CancelOutcome::Forward(build_cancel(
                    &row.dispatch,
                    effective,
                )))
            }
            RequestState::Cancelled => Ok(CancelOutcome::CancelledLocally),
            terminal => Ok(CancelOutcome::AlreadyTerminal(terminal)),
        }
    }

    /// Mark every sent/running/cancel-requested request pinned to this node and
    /// generation as `Unknown`. `Queued` requests are never sent and are left
    /// untouched. Returns how many rows moved.
    pub fn mark_disconnected(
        conn: &mut Connection,
        node: &str,
        generation: u64,
        now: u64,
    ) -> Result<usize, RpcErrorCode> {
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let conn = &transaction;

        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT request_id FROM workspace_rpc_requests \
                     WHERE owner_node_id = ?1 AND online_generation = ?2 \
                     AND state IN (1, 2, 3) ORDER BY request_id",
                )
                .map_err(|_| RpcErrorCode::StorageUnavailable)?;
            let rows = stmt
                .query_map(params![node, as_i64(generation)?], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|_| RpcErrorCode::StorageUnavailable)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|_| RpcErrorCode::StorageUnavailable)?);
            }
            out
        };
        let count = transition_to_unknown(conn, &ids, now)?;
        transaction
            .commit()
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        Ok(count)
    }

    /// Startup recovery: turn every in-flight request (`Dispatched`, `Running`,
    /// `CancelRequested`) into `Unknown`. Nothing is ever re-dispatched.
    pub fn recover_inflight(conn: &mut Connection, now: u64) -> Result<usize, RpcErrorCode> {
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let conn = &transaction;

        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT request_id FROM workspace_rpc_requests \
                     WHERE state IN (1, 2, 3) ORDER BY request_id",
                )
                .map_err(|_| RpcErrorCode::StorageUnavailable)?;
            let rows = stmt
                .query_map(params![], |row| row.get::<_, String>(0))
                .map_err(|_| RpcErrorCode::StorageUnavailable)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|_| RpcErrorCode::StorageUnavailable)?);
            }
            out
        };
        let count = transition_to_unknown(conn, &ids, now)?;
        transaction
            .commit()
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        Ok(count)
    }

    /// Internal Core adapter lookup. Never serialize this result before
    /// resolving the current authenticated caller and exact scope.
    pub fn trusted_status(
        conn: &Connection,
        request_id: &str,
    ) -> Result<RequestStatus, RpcErrorCode> {
        Ok(load_request(conn, request_id)?
            .ok_or(RpcErrorCode::Unauthorized)?
            .status())
    }

    /// Reattach delivery to the currently authenticated socket. The caller must
    /// fence this operation with the Hub connection lock. Only Replay/Cancel
    /// controls are returned: reconnect can never mint a second Dispatch.
    pub fn resume_node(
        conn: &mut Connection,
        node: &str,
        generation: u64,
        now: u64,
    ) -> Result<Vec<ResumeControl>, RpcErrorCode> {
        if generation == 0 {
            return Err(RpcErrorCode::InvalidRequest);
        }
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let ids = {
            let mut stmt=tx.prepare("SELECT request_id FROM workspace_rpc_requests WHERE owner_node_id=?1 AND state IN (1,2,3,7) ORDER BY request_id LIMIT 129")
                .map_err(|_|RpcErrorCode::StorageUnavailable)?;
            let rows = stmt
                .query_map([node], |row| row.get::<_, String>(0))
                .map_err(|_| RpcErrorCode::StorageUnavailable)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|_| RpcErrorCode::StorageUnavailable)?
        };
        if ids.len() > MAX_PENDING_PER_NODE as usize {
            return Err(RpcErrorCode::StorageUnavailable);
        }
        let mut controls = Vec::with_capacity(ids.len());
        for id in ids {
            let row = load_request(&tx, &id)?.ok_or(RpcErrorCode::StorageUnavailable)?;
            tx.execute(
                "UPDATE workspace_rpc_requests SET online_generation=?2 WHERE request_id=?1",
                params![id, as_i64(generation)?],
            )
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
            let cause = row.cancel_cause.or_else(|| {
                (now >= row.dispatch.deadline_unix_ms).then_some(CancelCause::Deadline)
            });
            let state = if cause.is_some() {
                RequestState::CancelRequested
            } else {
                RequestState::Unknown
            };
            set_state(&tx, &id, state, cause)?;
            audit(
                &tx,
                &id,
                state,
                None,
                Some(RpcErrorCode::UnknownOutcome.code()),
                now,
            )?;
            controls.push(ResumeControl {
                replay: WorkspaceReplay {
                    version: RPC_VERSION,
                    request_id: id,
                    run_id: row.dispatch.scope.run_id.clone(),
                    attempt: row.dispatch.scope.attempt,
                    request_digest: row.dispatch.request_digest.clone(),
                    after_seq: row.last_seq,
                },
                cancel: cause.map(|cause| build_cancel(&row.dispatch, cause)),
            });
        }
        tx.commit().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        Ok(controls)
    }

    /// A queue/send failure or a negative node reply is not proof that no side
    /// effect occurred. Keep the immutable request reserved and auditable.
    pub fn mark_delivery_unknown(
        conn: &mut Connection,
        node: &str,
        generation: u64,
        request_id: &str,
        code: RpcErrorCode,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let row = load_request(&tx, request_id)?.ok_or(RpcErrorCode::NotFound)?;
        if row.dispatch.owner_node_id != node || row.online_generation != generation {
            return Err(RpcErrorCode::WrongNode);
        }
        if row.state.is_terminal() {
            return Ok(());
        }
        if row.state == RequestState::Queued {
            return Err(RpcErrorCode::RequestConflict);
        }
        set_state(&tx, request_id, RequestState::Unknown, None)?;
        audit(
            &tx,
            request_id,
            RequestState::Unknown,
            None,
            Some(code.code()),
            now,
        )?;
        tx.commit().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        Ok(())
    }

    /// Read a bounded set for Core cancellation maintenance; no payload is
    /// exposed to an untrusted caller by this internal adapter operation.
    pub fn pending_for_node(
        conn: &Connection,
        node: &str,
    ) -> Result<Vec<RequestStatus>, RpcErrorCode> {
        let mut stmt=conn.prepare("SELECT request_id FROM workspace_rpc_requests WHERE owner_node_id=?1 AND state IN (0,1,2,3,7) ORDER BY request_id LIMIT 129")
            .map_err(|_|RpcErrorCode::StorageUnavailable)?;
        let ids = stmt
            .query_map([node], |row| row.get::<_, String>(0))
            .map_err(|_| RpcErrorCode::StorageUnavailable)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        if ids.len() > MAX_PENDING_PER_NODE as usize {
            return Err(RpcErrorCode::StorageUnavailable);
        }
        ids.into_iter()
            .map(|id| Self::trusted_status(conn, &id))
            .collect()
    }
    /// Read the complete bounded terminal journal under the same exact owner.
    /// This is an internal snapshot for Core byte archiving, not a larger wire page.
    pub fn archive_snapshot(
        conn: &mut Connection,
        principal: &TrustedPrincipal,
        request_id: &str,
    ) -> Result<ReplayResponse, RpcErrorCode> {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let scope = match principal {
            TrustedPrincipal::AgentRun(scope) => scope,
            _ => return Err(RpcErrorCode::Unauthorized),
        };
        scope.validate()?;
        let row = load_request(&tx, request_id)?.ok_or(RpcErrorCode::Unauthorized)?;
        if !scope_matches(&row.dispatch, scope) {
            return Err(RpcErrorCode::Unauthorized);
        }
        if row.state != RequestState::Completed {
            return Err(RpcErrorCode::RequestConflict);
        }
        let events = load_events_after(
            &tx,
            request_id,
            0,
            MAX_RETAINED_EVENTS as usize,
            &row.dispatch,
        )?;
        if events.len() as u64 != row.last_seq {
            return Err(RpcErrorCode::StorageUnavailable);
        }
        Ok(ReplayResponse {
            status: row.status(),
            events,
        })
    }

    /// Publish only a physically verified archive set, after file publication.
    /// Existing receipts are immutable; exact repeated publication is idempotent.
    pub fn publish_archives(
        conn: &mut Connection,
        principal: &TrustedPrincipal,
        request_id: &str,
        expected_previous: &[WorkspaceArchiveReceipt],
        verified: &VerifiedArchiveSet,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let scope = match principal {
            TrustedPrincipal::AgentRun(scope) => scope,
            _ => return Err(RpcErrorCode::Unauthorized),
        };
        scope.validate()?;
        let row = load_request(&tx, request_id)?.ok_or(RpcErrorCode::Unauthorized)?;
        if !scope_matches(&row.dispatch, scope) {
            return Err(RpcErrorCode::Unauthorized);
        }
        if row.state != RequestState::Completed
            || verified.request_digest() != row.dispatch.request_digest
        {
            return Err(RpcErrorCode::RequestConflict);
        }
        let events = load_events_after(
            &tx,
            request_id,
            0,
            MAX_RETAINED_EVENTS as usize,
            &row.dispatch,
        )?;
        if events.len() as u64 != row.last_seq {
            return Err(RpcErrorCode::StorageUnavailable);
        }
        let expected = archive::expected_receipts(&row.dispatch, &events)?;
        if expected != verified.receipts() {
            return Err(RpcErrorCode::RequestConflict);
        }
        if row.archives == expected {
            return Ok(());
        }
        if row.archives != expected_previous || !row.archives.is_empty() {
            return Err(RpcErrorCode::RequestConflict);
        }
        let old =
            serde_json::to_string(&row.archives).map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let new = serde_json::to_string(&expected).map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let changed=tx.execute("UPDATE workspace_rpc_requests SET archive_receipts_json=?2 WHERE request_id=?1 AND state=4 AND archive_receipts_json=?3",
            params![request_id,new,old]).map_err(|_|RpcErrorCode::StorageUnavailable)?;
        if changed != 1 {
            return Err(RpcErrorCode::RequestConflict);
        }
        audit(
            &tx,
            request_id,
            row.state,
            None,
            Some("archive_published"),
            now,
        )?;
        tx.commit().map_err(|_| RpcErrorCode::StorageUnavailable)
    }

    /// Replay status and a bounded page of events for the exact owning scope.
    /// An unknown id and a foreign scope both return `Unauthorized`.
    pub fn replay(
        conn: &mut Connection,
        principal: &TrustedPrincipal,
        request_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> Result<ReplayResponse, RpcErrorCode> {
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let conn = &transaction;

        let scope = match principal {
            TrustedPrincipal::AgentRun(scope) => scope,
            TrustedPrincipal::Administrator | TrustedPrincipal::Node => {
                return Err(RpcErrorCode::Unauthorized);
            }
        };
        scope.validate()?;
        if !(REPLAY_MIN_LIMIT..=REPLAY_MAX_LIMIT).contains(&limit) {
            return Err(RpcErrorCode::InvalidRequest);
        }
        let row = load_request(conn, request_id)?.ok_or(RpcErrorCode::Unauthorized)?;
        if !scope_matches(&row.dispatch, scope) {
            return Err(RpcErrorCode::Unauthorized);
        }
        let events = load_events_after(conn, request_id, after_seq, limit, &row.dispatch)?;
        Ok(ReplayResponse {
            status: row.status(),
            events,
        })
    }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn scope_matches(dispatch: &WorkspaceDispatch, scope: &CallerScope) -> bool {
    dispatch.scope.run_id == scope.run_id
        && dispatch.scope.attempt == scope.attempt
        && dispatch.scope.session_id == scope.session_id
        && dispatch.scope.member_id == scope.member_id
        && dispatch.scope.mission_id == scope.mission_id
}

fn load_request(
    conn: &Connection,
    request_id: &str,
) -> Result<Option<StoredRequest>, RpcErrorCode> {
    let raw = conn
        .query_row(
            "SELECT fingerprint, online_generation, dispatch_json, state, last_seq, \
             output_bytes, omitted_bytes, accepted_seen, cancel_cause, archive_receipts_json \
             FROM workspace_rpc_requests WHERE request_id = ?1",
            params![request_id],
            |row| {
                Ok(RawRow {
                    fingerprint: row.get(0)?,
                    online_generation: row.get(1)?,
                    dispatch_json: row.get(2)?,
                    state: row.get(3)?,
                    last_seq: row.get(4)?,
                    output_bytes: row.get(5)?,
                    omitted_bytes: row.get(6)?,
                    accepted_seen: row.get(7)?,
                    cancel_cause: row.get(8)?,
                    archive_receipts_json: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    let raw = match raw {
        Some(raw) => raw,
        None => return Ok(None),
    };
    let dispatch: WorkspaceDispatch =
        serde_json::from_str(&raw.dispatch_json).map_err(|_| RpcErrorCode::StorageUnavailable)?;
    dispatch
        .validate()
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    if dispatch.request.request_id != request_id
        || dispatch.request.fingerprint()? != raw.fingerprint
        || raw.online_generation <= 0
        || !matches!(raw.accepted_seen, 0 | 1)
        || raw.last_seq < 0
        || raw.last_seq > MAX_RETAINED_EVENTS as i64
        || raw.output_bytes < 0
        || raw.output_bytes > MAX_OUTPUT_BYTES as i64
    {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    let archives: Vec<WorkspaceArchiveReceipt> = serde_json::from_str(&raw.archive_receipts_json)
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    if archives.len() > 2 || (!archives.is_empty() && raw.state != RequestState::Completed.to_i64())
    {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    for (index, receipt) in archives.iter().enumerate() {
        receipt.validate_for(&dispatch)?;
        if archives[..index]
            .iter()
            .any(|other| other.kind == receipt.kind)
        {
            return Err(RpcErrorCode::StorageUnavailable);
        }
    }
    Ok(Some(StoredRequest {
        dispatch,
        fingerprint: raw.fingerprint,
        online_generation: as_u64(raw.online_generation)?,
        state: RequestState::from_i64(raw.state)?,
        last_seq: as_u64(raw.last_seq)?,
        output_bytes: as_u64(raw.output_bytes)?,
        omitted_bytes: as_u64(raw.omitted_bytes)?,
        accepted_seen: raw.accepted_seen != 0,
        cancel_cause: match raw.cancel_cause {
            Some(value) => Some(cause_from_i64(value)?),
            None => None,
        },
        archives,
    }))
}

struct RawRow {
    fingerprint: String,
    online_generation: i64,
    dispatch_json: String,
    state: i64,
    last_seq: i64,
    output_bytes: i64,
    omitted_bytes: i64,
    accepted_seen: i64,
    cancel_cause: Option<i64>,
    archive_receipts_json: String,
}

fn insert_request(
    conn: &Connection,
    dispatch: &WorkspaceDispatch,
    fingerprint: &str,
    online_generation: u64,
) -> Result<(), RpcErrorCode> {
    let dispatch_json =
        serde_json::to_string(dispatch).map_err(|_| RpcErrorCode::InvalidRequest)?;
    conn.execute(
        "INSERT INTO workspace_rpc_requests \
         (request_id, run_id, owner_node_id, fingerprint, online_generation, dispatch_json, \
          state, last_seq, output_bytes, omitted_bytes, accepted_seen, cancel_cause, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, 0, NULL, ?8)",
        params![
            dispatch.request.request_id,
            dispatch.scope.run_id,
            dispatch.owner_node_id,
            fingerprint,
            as_i64(online_generation)?,
            dispatch_json,
            RequestState::Queued.to_i64(),
            as_i64(dispatch.accepted_at_unix_ms)?,
        ],
    )
    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    Ok(())
}

fn store_event(
    conn: &Connection,
    request_id: &str,
    seq: i64,
    hash: &str,
    body_json: &str,
) -> Result<(), RpcErrorCode> {
    conn.execute(
        "INSERT INTO workspace_rpc_events (request_id, seq, canonical_hash, body_json) \
         VALUES (?1, ?2, ?3, ?4)",
        params![request_id, seq, hash, body_json],
    )
    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    Ok(())
}

fn load_event_hash(
    conn: &Connection,
    request_id: &str,
    seq: u64,
) -> Result<Option<String>, RpcErrorCode> {
    conn.query_row(
        "SELECT canonical_hash FROM workspace_rpc_events WHERE request_id = ?1 AND seq = ?2",
        params![request_id, as_i64(seq)?],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|_| RpcErrorCode::StorageUnavailable)
}

fn update_after_event(
    conn: &Connection,
    request_id: &str,
    state: RequestState,
    seq: i64,
    output_bytes: i64,
    omitted_bytes: i64,
    accepted_seen: bool,
) -> Result<(), RpcErrorCode> {
    conn.execute(
        "UPDATE workspace_rpc_requests \
         SET state = ?2, last_seq = ?3, output_bytes = ?4, omitted_bytes = ?5, accepted_seen = ?6 \
         WHERE request_id = ?1",
        params![
            request_id,
            state.to_i64(),
            seq,
            output_bytes,
            omitted_bytes,
            if accepted_seen { 1_i64 } else { 0_i64 },
        ],
    )
    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    Ok(())
}

fn set_state(
    conn: &Connection,
    request_id: &str,
    state: RequestState,
    cancel_cause: Option<CancelCause>,
) -> Result<(), RpcErrorCode> {
    match cancel_cause {
        Some(cause) => conn.execute(
            "UPDATE workspace_rpc_requests SET state = ?2, cancel_cause = ?3 WHERE request_id = ?1",
            params![request_id, state.to_i64(), cause_to_i64(cause)],
        ),
        None => conn.execute(
            "UPDATE workspace_rpc_requests SET state = ?2 WHERE request_id = ?1",
            params![request_id, state.to_i64()],
        ),
    }
    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    Ok(())
}

fn transition_to_unknown(
    conn: &Connection,
    ids: &[String],
    now: u64,
) -> Result<usize, RpcErrorCode> {
    for id in ids {
        set_state(conn, id, RequestState::Unknown, None)?;
        audit(
            conn,
            id,
            RequestState::Unknown,
            None,
            Some(RpcErrorCode::UnknownOutcome.code()),
            now,
        )?;
    }
    Ok(ids.len())
}

fn count_pending_for_run(conn: &Connection, run_id: &str) -> Result<i64, RpcErrorCode> {
    conn.query_row(
        "SELECT COUNT(*) FROM workspace_rpc_requests WHERE run_id = ?1 AND state IN (0, 1, 2, 3, 7)",
        params![run_id],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|_| RpcErrorCode::StorageUnavailable)
}

fn count_pending_for_node(conn: &Connection, node: &str) -> Result<i64, RpcErrorCode> {
    conn.query_row(
        "SELECT COUNT(*) FROM workspace_rpc_requests \
         WHERE owner_node_id = ?1 AND state IN (0, 1, 2, 3, 7)",
        params![node],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|_| RpcErrorCode::StorageUnavailable)
}

fn load_events_after(
    conn: &Connection,
    request_id: &str,
    after_seq: u64,
    limit: usize,
    dispatch: &WorkspaceDispatch,
) -> Result<Vec<WorkspaceEvent>, RpcErrorCode> {
    let mut stmt = conn
        .prepare(
            "SELECT seq, body_json FROM workspace_rpc_events \
             WHERE request_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    let rows = stmt
        .query_map(
            params![request_id, as_i64(after_seq)?, as_i64(limit as u64)?],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    let mut events = Vec::new();
    for row in rows {
        let (seq_i64, body_json) = row.map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let body: WorkspaceEventBody =
            serde_json::from_str(&body_json).map_err(|_| RpcErrorCode::StorageUnavailable)?;
        events.push(WorkspaceEvent {
            version: RPC_VERSION,
            request_id: dispatch.request.request_id.clone(),
            run_id: dispatch.scope.run_id.clone(),
            attempt: dispatch.scope.attempt,
            owner_node_id: dispatch.owner_node_id.clone(),
            request_digest: dispatch.request_digest.clone(),
            seq: as_u64(seq_i64)?,
            body,
        });
    }
    Ok(events)
}

fn audit(
    conn: &Connection,
    request_id: &str,
    state: RequestState,
    seq: Option<u64>,
    code: Option<&str>,
    at: u64,
) -> Result<(), RpcErrorCode> {
    let seq_i64 = match seq {
        Some(value) => Some(as_i64(value)?),
        None => None,
    };
    conn.execute(
        "INSERT INTO workspace_rpc_audit (request_id, state, seq, code, at_unix_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![request_id, state.to_i64(), seq_i64, code, as_i64(at)?],
    )
    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    Ok(())
}

fn build_cancel(dispatch: &WorkspaceDispatch, cause: CancelCause) -> WorkspaceCancel {
    WorkspaceCancel {
        version: RPC_VERSION,
        request_id: dispatch.request.request_id.clone(),
        run_id: dispatch.scope.run_id.clone(),
        attempt: dispatch.scope.attempt,
        request_digest: dispatch.request_digest.clone(),
        cause,
    }
}

fn cause_to_i64(cause: CancelCause) -> i64 {
    match cause {
        CancelCause::User => 0,
        CancelCause::Deadline => 1,
    }
}

fn cause_from_i64(value: i64) -> Result<CancelCause, RpcErrorCode> {
    match value {
        0 => Ok(CancelCause::User),
        1 => Ok(CancelCause::Deadline),
        _ => Err(RpcErrorCode::StorageUnavailable),
    }
}

fn as_i64(value: u64) -> Result<i64, RpcErrorCode> {
    if value > i64::MAX as u64 {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    Ok(value as i64)
}

fn as_u64(value: i64) -> Result<u64, RpcErrorCode> {
    if value < 0 {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    Ok(value as u64)
}

fn decode_len(data: &str) -> Result<u64, RpcErrorCode> {
    let decoded = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| RpcErrorCode::InvalidRequest)?;
    Ok(decoded.len() as u64)
}

fn canonical_event_hash(event: &WorkspaceEvent) -> Result<String, RpcErrorCode> {
    #[derive(Serialize)]
    struct EventHashInput<'a> {
        domain: &'static str,
        event: &'a WorkspaceEvent,
    }
    let canonical = serde_json::to_string(&EventHashInput {
        domain: EVENT_HASH_DOMAIN,
        event,
    })
    .map_err(|_| RpcErrorCode::InvalidRequest)?;
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

// ---------------------------------------------------------------------------
// Tests (five owners)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database");
        WorkspaceRpcStore::install_schema(&conn).expect("install schema");
        conn
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

    fn agent() -> TrustedPrincipal {
        TrustedPrincipal::AgentRun(scope())
    }

    fn grant(online_generation: Option<u64>) -> WorkspaceGrant {
        let mut allowed_tools = BTreeSet::new();
        allowed_tools.insert("cargo".to_string());
        WorkspaceGrant {
            workspace_id: "ws_1".to_string(),
            mission_id: "mission_1".to_string(),
            owner_node_id: "node_b".to_string(),
            policy_revision: 7,
            allow_list: true,
            allow_read: true,
            allow_write: false,
            allowed_tools,
            online_generation,
        }
    }

    fn list_request(request_id: &str) -> WorkspaceRequest {
        WorkspaceRequest {
            version: RPC_VERSION,
            request_id: request_id.to_string(),
            workspace_id: "ws_1".to_string(),
            timeout_ms: 30_000,
            operation: WorkspaceOperation::List {
                path: String::new(),
                limit: 10,
            },
        }
    }

    fn run_request(request_id: &str) -> WorkspaceRequest {
        WorkspaceRequest {
            version: RPC_VERSION,
            request_id: request_id.to_string(),
            workspace_id: "ws_1".to_string(),
            timeout_ms: 30_000,
            operation: WorkspaceOperation::Run {
                tool_id: "cargo".to_string(),
                args: vec!["--version".to_string()],
                cwd: String::new(),
            },
        }
    }

    fn admitted_run(conn: &mut Connection, request_id: &str) -> WorkspaceDispatch {
        match WorkspaceRpcStore::admit(
            conn,
            &agent(),
            &grant(Some(5)),
            run_request(request_id),
            1_000,
        )
        .expect("admit")
        {
            Admission::Dispatch(dispatch) => dispatch,
            Admission::Replay(_) => panic!("expected a fresh dispatch"),
        }
    }

    fn sent_run(conn: &mut Connection, id: &str) -> WorkspaceDispatch {
        let d = admitted_run(conn, id);
        WorkspaceRpcStore::mark_dispatched(conn, id, 5, 1_100).unwrap();
        d
    }
    fn event(dispatch: &WorkspaceDispatch, seq: u64, body: WorkspaceEventBody) -> WorkspaceEvent {
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

    fn out_chunk(bytes: usize) -> WorkspaceEventBody {
        WorkspaceEventBody::Output {
            stream: RpcOutputStream::Stdout,
            data: STANDARD.encode(vec![b'x'; bytes]),
        }
    }

    fn state_of(conn: &mut Connection, request_id: &str) -> RequestState {
        WorkspaceRpcStore::replay(conn, &agent(), request_id, 0, 16)
            .expect("replay")
            .status
            .state
    }

    #[test]
    fn owner_auth_rejects_unprivileged_and_offline_new_requests() {
        let mut conn = setup();
        assert!(schema_matches(&conn).unwrap());
        let malformed = setup();
        malformed
            .execute_batch(
                "DROP INDEX workspace_rpc_requests_run_id;
            CREATE INDEX workspace_rpc_requests_run_id ON workspace_rpc_requests(owner_node_id);",
            )
            .unwrap();
        assert!(
            !schema_matches(&malformed).unwrap(),
            "same names cannot hide a different index definition"
        );
        let weakened = setup();
        weakened.execute_batch("DROP TABLE workspace_rpc_events;
            CREATE TABLE workspace_rpc_events(request_id TEXT,seq INTEGER,canonical_hash TEXT,body_json TEXT);").unwrap();
        assert!(
            !schema_matches(&weakened).unwrap(),
            "column names cannot hide missing PK/NOT NULL constraints"
        );

        for principal in [TrustedPrincipal::Administrator, TrustedPrincipal::Node] {
            assert_eq!(
                WorkspaceRpcStore::admit(
                    &mut conn,
                    &principal,
                    &grant(Some(5)),
                    list_request("req_a"),
                    1
                )
                .unwrap_err(),
                RpcErrorCode::Unauthorized
            );
        }
        assert_eq!(state_count(&conn), 0);

        // Wrong mission on the grant.
        let mut wrong = grant(Some(5));
        wrong.mission_id = "mission_2".to_string();
        assert_eq!(
            WorkspaceRpcStore::admit(&mut conn, &agent(), &wrong, list_request("req_m"), 1)
                .unwrap_err(),
            RpcErrorCode::Unauthorized
        );

        // Tool not permitted by the grant.
        assert_eq!(
            WorkspaceRpcStore::admit(
                &mut conn,
                &agent(),
                &grant(Some(5)),
                WorkspaceRequest {
                    operation: WorkspaceOperation::Run {
                        tool_id: "rm".to_string(),
                        args: Vec::new(),
                        cwd: String::new(),
                    },
                    ..run_request("req_t")
                },
                1
            )
            .unwrap_err(),
            RpcErrorCode::ToolDenied
        );

        // New request while offline is rejected and writes nothing.
        assert_eq!(
            WorkspaceRpcStore::admit(
                &mut conn,
                &agent(),
                &grant(None),
                list_request("req_off"),
                1
            )
            .unwrap_err(),
            RpcErrorCode::NodeOffline
        );
        assert_eq!(state_count(&conn), 0);

        assert_eq!(
            WorkspaceRpcStore::admit(
                &mut conn,
                &agent(),
                &grant(Some(0)),
                list_request("req_epoch_zero"),
                1
            )
            .unwrap_err(),
            RpcErrorCode::InvalidRequest
        );
        assert_eq!(state_count(&conn), 0);

        // Unknown id and foreign scope both leak nothing from cancel/replay.
        assert_eq!(
            WorkspaceRpcStore::cancel(&mut conn, &agent(), "nope", CancelCause::User, 1)
                .unwrap_err(),
            RpcErrorCode::Unauthorized
        );
        assert_eq!(
            WorkspaceRpcStore::replay(&mut conn, &agent(), "nope", 0, 16).unwrap_err(),
            RpcErrorCode::Unauthorized
        );
        assert_eq!(
            WorkspaceRpcStore::cancel(
                &mut conn,
                &TrustedPrincipal::Node,
                "nope",
                CancelCause::User,
                1
            )
            .unwrap_err(),
            RpcErrorCode::Unauthorized
        );

        let _ = admitted_run(&mut conn, "req_own");
        let mut foreign = scope();
        foreign.run_id = "run_other".to_string();
        assert_eq!(
            WorkspaceRpcStore::replay(
                &mut conn,
                &TrustedPrincipal::AgentRun(foreign),
                "req_own",
                0,
                16
            )
            .unwrap_err(),
            RpcErrorCode::Unauthorized
        );
    }

    #[test]
    fn owner_idempotency_global_unique_fixed_deadline_and_caps() {
        let mut conn = setup();

        let dispatch = match WorkspaceRpcStore::admit(
            &mut conn,
            &agent(),
            &grant(Some(5)),
            list_request("req_x"),
            1_000,
        )
        .unwrap()
        {
            Admission::Dispatch(dispatch) => dispatch,
            Admission::Replay(_) => panic!("first admit must dispatch"),
        };
        assert_eq!(dispatch.deadline_unix_ms, 31_000);

        // Same scope + fingerprint replays the original fixed deadline.
        match WorkspaceRpcStore::admit(
            &mut conn,
            &agent(),
            &grant(Some(5)),
            list_request("req_x"),
            9_999,
        )
        .unwrap()
        {
            Admission::Replay(status) => {
                assert_eq!(status.dispatch.deadline_unix_ms, dispatch.deadline_unix_ms);
                assert_eq!(status.dispatch.request_digest, dispatch.request_digest);
                assert_eq!(status.state, RequestState::Queued);
            }
            Admission::Dispatch(_) => panic!("retry must replay"),
        }

        // A retry while the grant is offline still replays, never NodeOffline.
        match WorkspaceRpcStore::admit(
            &mut conn,
            &agent(),
            &grant(None),
            list_request("req_x"),
            20_000,
        )
        .unwrap()
        {
            Admission::Replay(status) => {
                assert_eq!(status.dispatch.deadline_unix_ms, dispatch.deadline_unix_ms);
            }
            Admission::Dispatch(_) => panic!("offline retry must replay"),
        }

        // Changed request (timeout) on the same id is a conflict.
        let mut changed = list_request("req_x");
        changed.timeout_ms = 30_001;
        assert_eq!(
            WorkspaceRpcStore::admit(&mut conn, &agent(), &grant(Some(5)), changed, 1).unwrap_err(),
            RpcErrorCode::RequestConflict
        );

        // Different scope, same id is not visible as existing.
        let mut foreign = scope();
        foreign.run_id = "run_other".to_string();
        assert_eq!(
            WorkspaceRpcStore::admit(
                &mut conn,
                &TrustedPrincipal::AgentRun(foreign),
                &grant(Some(5)),
                list_request("req_x"),
                1
            )
            .unwrap_err(),
            RpcErrorCode::Unauthorized
        );

        // A changed policy revision on a retry is a stale-grant mismatch.
        let mut stale = grant(Some(5));
        stale.policy_revision = 8;
        assert_eq!(
            WorkspaceRpcStore::admit(&mut conn, &agent(), &stale, list_request("req_x"), 1)
                .unwrap_err(),
            RpcErrorCode::PolicyMismatch
        );

        // A formerly authorized retry must not expose its result after the
        // trusted adapter revokes this operation, even at the same revision.
        let mut revoked = grant(Some(5));
        revoked.allow_list = false;
        assert_eq!(
            WorkspaceRpcStore::admit(&mut conn, &agent(), &revoked, list_request("req_x"), 2)
                .unwrap_err(),
            RpcErrorCode::ToolDenied
        );

        // Global uniqueness: still exactly one row for req_x.
        assert_eq!(count_for(&conn, "req_x"), 1);

        // Pending cap: 31 more Queued on the same run fill it; the 33rd is Busy.
        for index in 0..31 {
            WorkspaceRpcStore::admit(
                &mut conn,
                &agent(),
                &grant(Some(5)),
                list_request(&format!("req_cap_{index}")),
                1,
            )
            .expect("admit within cap");
        }
        assert_eq!(
            WorkspaceRpcStore::admit(
                &mut conn,
                &agent(),
                &grant(Some(5)),
                list_request("req_over"),
                1
            )
            .unwrap_err(),
            RpcErrorCode::Busy
        );
        // Unknown executions continue consuming admission capacity.
        WorkspaceRpcStore::mark_dispatched(&mut conn, "req_cap_0", 5, 2).unwrap();
        WorkspaceRpcStore::mark_disconnected(&mut conn, "node_b", 5, 3).unwrap();
        assert_eq!(
            WorkspaceRpcStore::admit(
                &mut conn,
                &agent(),
                &grant(Some(5)),
                list_request("unknown_over"),
                4
            )
            .unwrap_err(),
            RpcErrorCode::Busy
        );
        concurrent_admission_cap();
    }

    // Two independent SQLite connections race the last admission slots. The
    // cap read and insert must share one IMMEDIATE transaction; a mutex around
    // one Rust instance alone cannot establish this invariant.
    fn concurrent_admission_cap() {
        // A private temporary root keeps the raced SQLite fixture out of the source
        // tree, so a read-only checkout cannot turn this invariant into a
        // filesystem-permission failure.
        let dir = std::env::temp_dir().join(format!(
            "rovai-workspace-rpc-admission-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("concurrent.sqlite");
        let conn = Connection::open(&path).unwrap();
        WorkspaceRpcStore::install_schema(&conn).unwrap();
        drop(conn);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|worker| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut conn = Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    barrier.wait();
                    let mut accepted = 0;
                    let mut busy = 0;
                    for index in 0..20 {
                        match WorkspaceRpcStore::admit(
                            &mut conn,
                            &agent(),
                            &grant(Some(5)),
                            list_request(&format!("parallel_{worker}_{index}")),
                            1,
                        ) {
                            Ok(Admission::Dispatch(_)) => accepted += 1,
                            Err(RpcErrorCode::Busy) => busy += 1,
                            other => panic!("unexpected concurrent admission: {other:?}"),
                        }
                    }
                    (accepted, busy)
                })
            })
            .collect();
        let totals = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
        assert_eq!(totals, (32, 8));
        let conn = Connection::open(path).unwrap();
        assert_eq!(state_count(&conn), 32);
        drop(conn);
        std::fs::remove_dir_all(&dir).expect("remove the owned workspace RPC fixture");
    }

    #[test]
    fn owner_event_fencing_and_sequence() {
        let mut conn = setup();
        let queued = admitted_run(&mut conn, "req_unsent");
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(&queued, 1, WorkspaceEventBody::Accepted),
                1
            )
            .unwrap_err(),
            RpcErrorCode::RequestConflict
        );
        assert_eq!(state_of(&mut conn, "req_unsent"), RequestState::Queued);
        let dispatch = sent_run(&mut conn, "req_e");

        // Wrong node / wrong generation fence the event out.
        let accepted = event(&dispatch, 1, WorkspaceEventBody::Accepted);
        assert_eq!(
            WorkspaceRpcStore::append_event(&mut conn, "node_c", 5, &accepted, 1).unwrap_err(),
            RpcErrorCode::WrongNode
        );
        assert_eq!(
            WorkspaceRpcStore::append_event(&mut conn, "node_b", 6, &accepted, 1).unwrap_err(),
            RpcErrorCode::RequestConflict
        );

        // Accepted must be seq 1 and land once.
        WorkspaceRpcStore::append_event(&mut conn, "node_b", 5, &accepted, 1).expect("accepted");
        WorkspaceRpcStore::append_event(&mut conn, "node_b", 5, &accepted, 1)
            .expect("exact duplicate is idempotent");
        // A conflicting body at the same seq is rejected.
        let failed_at_1 = event(
            &dispatch,
            1,
            WorkspaceEventBody::Failed {
                code: RpcErrorCode::SpawnFailed,
            },
        );
        assert_eq!(
            WorkspaceRpcStore::append_event(&mut conn, "node_b", 5, &failed_at_1, 1).unwrap_err(),
            RpcErrorCode::SequenceConflict
        );
        // Gap.
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(&dispatch, 3, out_chunk(4)),
                1
            )
            .unwrap_err(),
            RpcErrorCode::SequenceConflict
        );

        // Contiguous output, then a matching Completed.
        WorkspaceRpcStore::append_event(
            &mut conn,
            "node_b",
            5,
            &event(&dispatch, 2, out_chunk(8)),
            1,
        )
        .expect("output");
        let completed = event(
            &dispatch,
            3,
            WorkspaceEventBody::Completed {
                result: WorkspaceResult::Run {
                    exit_code: 0,
                    output_bytes: 8,
                    omitted_bytes: 0,
                },
            },
        );
        WorkspaceRpcStore::append_event(&mut conn, "node_b", 5, &completed, 1).expect("completed");
        assert_eq!(state_of(&mut conn, "req_e"), RequestState::Completed);
        // Nothing after the terminal state but an exact duplicate.
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(&dispatch, 4, out_chunk(1)),
                1
            )
            .unwrap_err(),
            RpcErrorCode::SequenceConflict
        );

        // Accepted on a fresh stream is not allowed below seq 1 or after a first
        // failure, and Completed requires a prior Accepted.
        let fresh = sent_run(&mut conn, "req_f");
        WorkspaceRpcStore::append_event(
            &mut conn,
            "node_b",
            5,
            &event(
                &fresh,
                1,
                WorkspaceEventBody::Failed {
                    code: RpcErrorCode::SpawnFailed,
                },
            ),
            1,
        )
        .expect("a failure may be first");
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(&fresh, 2, WorkspaceEventBody::Accepted),
                1
            )
            .unwrap_err(),
            RpcErrorCode::SequenceConflict
        );
        let fresh2 = sent_run(&mut conn, "req_g");
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(
                    &fresh2,
                    1,
                    WorkspaceEventBody::Completed {
                        result: WorkspaceResult::Run {
                            exit_code: 0,
                            output_bytes: 0,
                            omitted_bytes: 0
                        }
                    }
                ),
                1
            )
            .unwrap_err(),
            RpcErrorCode::SequenceConflict
        );

        // Dispatched -> disconnect -> Unknown still accepts the first Accepted.
        let dispatched = admitted_run(&mut conn, "req_h");
        WorkspaceRpcStore::mark_dispatched(&mut conn, "req_h", 5, 2_000).expect("dispatch");
        WorkspaceRpcStore::mark_disconnected(&mut conn, "node_b", 5, 3_000).expect("disconnect");
        assert_eq!(state_of(&mut conn, "req_h"), RequestState::Unknown);
        WorkspaceRpcStore::append_event(
            &mut conn,
            "node_b",
            5,
            &event(&dispatched, 1, WorkspaceEventBody::Accepted),
            4_000,
        )
        .expect("accepted after Unknown with no prior accepted");
        assert_eq!(state_of(&mut conn, "req_h"), RequestState::Running);

        // Do not regress CancelRequested when the first Accepted arrives.
        let pending = admitted_run(&mut conn, "req_i");
        WorkspaceRpcStore::mark_dispatched(&mut conn, "req_i", 5, 2_000).expect("dispatch");
        WorkspaceRpcStore::cancel(&mut conn, &agent(), "req_i", CancelCause::User, 2_100)
            .expect("cancel");
        WorkspaceRpcStore::append_event(
            &mut conn,
            "node_b",
            5,
            &event(&pending, 1, WorkspaceEventBody::Accepted),
            2_200,
        )
        .expect("accepted while cancel requested");
        assert_eq!(state_of(&mut conn, "req_i"), RequestState::CancelRequested);
    }

    #[test]
    fn owner_cancellation_disconnect_and_recovery() {
        let mut conn = setup();

        // Queued cancel is local and terminal; a repeat stays stable.
        let _ = admitted_run(&mut conn, "req_q");
        assert!(matches!(
            WorkspaceRpcStore::cancel(&mut conn, &agent(), "req_q", CancelCause::User, 1).unwrap(),
            CancelOutcome::CancelledLocally
        ));
        assert_eq!(state_of(&mut conn, "req_q"), RequestState::Cancelled);
        assert!(matches!(
            WorkspaceRpcStore::cancel(&mut conn, &agent(), "req_q", CancelCause::Deadline, 2)
                .unwrap(),
            CancelOutcome::CancelledLocally
        ));

        // Sent cancel forwards and requires node confirmation; first cause wins.
        let _ = admitted_run(&mut conn, "req_s");
        WorkspaceRpcStore::mark_dispatched(&mut conn, "req_s", 5, 1_100).expect("dispatch");
        match WorkspaceRpcStore::cancel(&mut conn, &agent(), "req_s", CancelCause::User, 1_200)
            .unwrap()
        {
            CancelOutcome::Forward(cancel) => assert_eq!(cancel.cause, CancelCause::User),
            other => panic!("expected forward, got {other:?}"),
        }
        assert_eq!(state_of(&mut conn, "req_s"), RequestState::CancelRequested);
        match WorkspaceRpcStore::cancel(&mut conn, &agent(), "req_s", CancelCause::Deadline, 1_300)
            .unwrap()
        {
            CancelOutcome::Forward(cancel) => assert_eq!(cancel.cause, CancelCause::User),
            other => panic!("repeat must forward first cause, got {other:?}"),
        }

        // Deadline-expired queued dispatch cancels locally with Deadline.
        let _ = admitted_run(&mut conn, "req_d");
        assert_eq!(
            WorkspaceRpcStore::mark_dispatched(&mut conn, "req_d", 5, 40_000).unwrap_err(),
            RpcErrorCode::DeadlineExceeded
        );
        assert_eq!(state_of(&mut conn, "req_d"), RequestState::Cancelled);

        // Disconnect moves only sent/running/cancel-requested rows to Unknown;
        // Queued rows are never-sent and stay Queued.
        let mut conn = setup();
        let _ = admitted_run(&mut conn, "req_queued");
        let _ = admitted_run(&mut conn, "req_live");
        WorkspaceRpcStore::mark_dispatched(&mut conn, "req_live", 5, 1_100).expect("dispatch");
        let moved = WorkspaceRpcStore::mark_disconnected(&mut conn, "node_b", 5, 1_200)
            .expect("disconnect");
        assert_eq!(moved, 1);
        assert_eq!(state_of(&mut conn, "req_queued"), RequestState::Queued);
        assert_eq!(state_of(&mut conn, "req_live"), RequestState::Unknown);

        // An Unknown request is never re-dispatched: a retry replays.
        match WorkspaceRpcStore::admit(
            &mut conn,
            &agent(),
            &grant(Some(5)),
            run_request("req_live"),
            2_000,
        )
        .unwrap()
        {
            Admission::Replay(status) => assert_eq!(status.state, RequestState::Unknown),
            Admission::Dispatch(_) => panic!("Unknown must not re-dispatch"),
        }

        // Recovery converts remaining in-flight rows and reports the count.
        let _ = admitted_run(&mut conn, "req_rec");
        WorkspaceRpcStore::mark_dispatched(&mut conn, "req_rec", 5, 1_100).expect("dispatch");
        let recovered = WorkspaceRpcStore::recover_inflight(&mut conn, 1_500).expect("recover");
        assert_eq!(recovered, 1);
        assert_eq!(state_of(&mut conn, "req_rec"), RequestState::Unknown);
        // Unknown still denotes a potentially live process; a cancellation
        // must be forwarded instead of being reported terminal.
        assert!(matches!(
            WorkspaceRpcStore::cancel(&mut conn, &agent(), "req_live", CancelCause::User, 2_000)
                .unwrap(),
            CancelOutcome::Forward(_)
        ));
        assert_eq!(
            state_of(&mut conn, "req_live"),
            RequestState::CancelRequested
        );
    }

    #[test]
    fn owner_bounded_output_and_secret_free_audit() {
        let mut conn = setup();
        let dispatch = sent_run(&mut conn, "req_o");

        // Empty output is rejected.
        WorkspaceRpcStore::append_event(
            &mut conn,
            "node_b",
            5,
            &event(&dispatch, 1, WorkspaceEventBody::Accepted),
            1,
        )
        .expect("accepted");
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(&dispatch, 2, out_chunk(0)),
                1
            )
            .unwrap_err(),
            RpcErrorCode::InvalidRequest
        );
        // Filesystem requests cannot stream process output: only Run may.
        let mut list_conn = setup();
        let list_dispatch = match WorkspaceRpcStore::admit(
            &mut list_conn,
            &agent(),
            &grant(Some(5)),
            list_request("req_l"),
            1_000,
        )
        .unwrap()
        {
            Admission::Dispatch(dispatch) => dispatch,
            Admission::Replay(_) => panic!("expected dispatch"),
        };
        WorkspaceRpcStore::mark_dispatched(&mut list_conn, "req_l", 5, 1_100).unwrap();
        WorkspaceRpcStore::append_event(
            &mut list_conn,
            "node_b",
            5,
            &event(&list_dispatch, 1, WorkspaceEventBody::Accepted),
            1,
        )
        .expect("accepted");
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut list_conn,
                "node_b",
                5,
                &event(&list_dispatch, 2, out_chunk(4)),
                1
            )
            .unwrap_err(),
            RpcErrorCode::RequestConflict
        );

        // Omitted bytes may exceed 1 MiB on a Run: only retained decoded output is capped.
        let mut trunc_conn = setup();
        let trunc = sent_run(&mut trunc_conn, "req_trunc");
        WorkspaceRpcStore::append_event(
            &mut trunc_conn,
            "node_b",
            5,
            &event(&trunc, 1, WorkspaceEventBody::Accepted),
            1,
        )
        .expect("accepted");
        WorkspaceRpcStore::append_event(
            &mut trunc_conn,
            "node_b",
            5,
            &event(
                &trunc,
                2,
                WorkspaceEventBody::OutputTruncated {
                    omitted_bytes: 2_000_000,
                },
            ),
            1,
        )
        .expect("omitted beyond 1 MiB allowed");
        assert_eq!(
            WorkspaceRpcStore::replay(&mut trunc_conn, &agent(), "req_trunc", 0, 16)
                .unwrap()
                .status
                .omitted_bytes,
            2_000_000
        );

        // Cumulative decoded output may reach the cap exactly, then one more chunk
        // is rejected without moving the sequence, leaving room for the terminal.
        let chunk = 16_384usize;
        let mut seq = 2u64;
        let mut emitted = 0u64;
        while emitted + chunk as u64 <= MAX_OUTPUT_BYTES {
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(&dispatch, seq, out_chunk(chunk)),
                1,
            )
            .expect("chunk within cap");
            emitted += chunk as u64;
            seq += 1;
        }
        assert_eq!(emitted, MAX_OUTPUT_BYTES);
        let before = WorkspaceRpcStore::replay(&mut conn, &agent(), "req_o", 0, 1)
            .unwrap()
            .status;
        assert_eq!(
            WorkspaceRpcStore::append_event(
                &mut conn,
                "node_b",
                5,
                &event(&dispatch, seq, out_chunk(chunk)),
                1
            )
            .unwrap_err(),
            RpcErrorCode::OutputLimit
        );
        let after = WorkspaceRpcStore::replay(&mut conn, &agent(), "req_o", 0, 1)
            .unwrap()
            .status;
        assert_eq!(
            after.last_seq, before.last_seq,
            "rejected excess must not advance seq"
        );
        assert_eq!(after.output_bytes, MAX_OUTPUT_BYTES);

        // Terminal still fits; totals must match the journal.
        let completed = event(
            &dispatch,
            seq,
            WorkspaceEventBody::Completed {
                result: WorkspaceResult::Run {
                    exit_code: 0,
                    output_bytes: MAX_OUTPUT_BYTES,
                    omitted_bytes: 0,
                },
            },
        );
        WorkspaceRpcStore::append_event(&mut conn, "node_b", 5, &completed, 1)
            .expect("terminal after cap");
        assert_eq!(state_of(&mut conn, "req_o"), RequestState::Completed);

        // Audit carries only ids/state/seq/code, never request arguments or bodies.
        let mut stmt = conn
            .prepare("SELECT request_id, state, seq, code FROM workspace_rpc_audit")
            .expect("audit query");
        let rows: Vec<(String, i64, Option<i64>, Option<String>)> = stmt
            .query_map(params![], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert!(!rows.is_empty());
        for (request_id, state, _seq, code) in rows {
            assert!(!request_id.contains("--version"));
            assert!((0..=7).contains(&state));
            if let Some(code) = code {
                assert!(!code.contains("--version"));
            }
        }
    }

    #[test]
    fn authenticated_reconnect_replays_without_redispatch_and_fences_old_generation() {
        let mut conn = setup();
        let dispatch = sent_run(&mut conn, "resume");
        WorkspaceRpcStore::append_event(
            &mut conn,
            "node_b",
            5,
            &event(&dispatch, 1, WorkspaceEventBody::Accepted),
            1_200,
        )
        .unwrap();
        WorkspaceRpcStore::mark_disconnected(&mut conn, "node_b", 5, 1_300).unwrap();
        // Hub generations are opaque within one Hub lifetime; a recovered Hub
        // may start at 1. Its authenticated current-connection lock is authority.
        let controls = WorkspaceRpcStore::resume_node(&mut conn, "node_b", 1, 1_400).unwrap();
        assert_eq!(controls.len(), 1);
        assert_eq!(controls[0].replay.after_seq, 1);
        assert!(controls[0].cancel.is_none());
        assert_eq!(controls[0].replay.request_digest, dispatch.request_digest);
        assert_eq!(
            WorkspaceRpcStore::trusted_status(&conn, "resume")
                .unwrap()
                .dispatch,
            dispatch
        );
        let done = event(
            &dispatch,
            2,
            WorkspaceEventBody::Completed {
                result: WorkspaceResult::Run {
                    exit_code: 0,
                    output_bytes: 0,
                    omitted_bytes: 0,
                },
            },
        );
        assert!(WorkspaceRpcStore::append_event(&mut conn, "node_b", 5, &done, 1_500).is_err());
        WorkspaceRpcStore::append_event(&mut conn, "node_b", 1, &done, 1_500).unwrap();
        assert!(matches!(
            WorkspaceRpcStore::admit(
                &mut conn,
                &agent(),
                &grant(Some(1)),
                dispatch.request.clone(),
                1_600
            )
            .unwrap(),
            Admission::Replay(_)
        ));
        assert!(
            WorkspaceRpcStore::resume_node(&mut conn, "node_b", 2, 1_700)
                .unwrap()
                .is_empty()
        );
        let pending = sent_run(&mut conn, "deadline-resume");
        let controls =
            WorkspaceRpcStore::resume_node(&mut conn, "node_b", 2, pending.deadline_unix_ms + 1)
                .unwrap();
        assert_eq!(controls.len(), 1);
        assert_eq!(
            controls[0].cancel.as_ref().unwrap().cause,
            CancelCause::Deadline
        );
        assert_eq!(
            WorkspaceRpcStore::trusted_status(&conn, "deadline-resume")
                .unwrap()
                .dispatch
                .deadline_unix_ms,
            pending.deadline_unix_ms
        );
        assert!(
            WorkspaceRpcStore::mark_delivery_unknown(
                &mut conn,
                "foreign",
                2,
                "deadline-resume",
                RpcErrorCode::UnknownOutcome,
                pending.deadline_unix_ms + 2
            )
            .is_err()
        );
        WorkspaceRpcStore::admit(
            &mut conn,
            &agent(),
            &grant(Some(2)),
            list_request("never-sent"),
            2_000,
        )
        .unwrap();
        assert!(
            !WorkspaceRpcStore::resume_node(&mut conn, "node_b", 3, 2_100)
                .unwrap()
                .iter()
                .any(|item| item.replay.request_id == "never-sent")
        );
        assert_eq!(state_of(&mut conn, "never-sent"), RequestState::Queued);
    }

    fn state_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM workspace_rpc_requests",
            params![],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn count_for(conn: &Connection, request_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM workspace_rpc_requests WHERE request_id = ?1",
            params![request_id],
            |row| row.get(0),
        )
        .unwrap()
    }
}
