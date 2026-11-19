//! Read-only catalog authority for an explicitly selected remote node.
//!
//! The node tables are owned by the execution-node store (schema migration 225).
//! Migration 231 adds the durable installation facts this module reads on
//! `execution_node_cli`: `installation_identity` and `installation_generation`.
//!
//! This module only performs synchronous, pure SQL reads against facts a paired
//! node already stored. It does not open a network connection, touch the file
//! system, read the process environment, or choose a node. It never falls back to
//! the local node: a missing, non-remote, revoked or fact-less node fails closed.
//!
//! `installation_identity` is `sha256:` plus 64 lowercase hex characters, and
//! `installation_generation` is a durable installation generation in
//! `1..=2^53-1`. It is not the WebSocket/socket generation and not an epoch of a
//! warm Host process; a reconnect that only refreshes `reported_at` keeps both
//! facts, so it keeps the same frozen target.

use std::fmt;

use rusqlite::{Connection, OptionalExtension, params};

use crate::remote_process::FrozenRemoteTarget;

/// Longest stored program path accepted from a node, matching the frozen target.
const MAX_PROGRAM_BYTES: usize = 32768;

/// Largest durable installation generation still exactly representable in JSON.
pub const MAX_INSTALLATION_GENERATION: u64 = (1u64 << 53) - 1;

/// The two names the Claude adapter is stored under by different producers.
const CLAUDE_ADAPTER_ALIASES: [&str; 2] = ["claude-code", "claude-code-cli"];

/// One trusted, launchable installation reported by a remote node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCatalogEntry {
    pub node_id: String,
    pub adapter_kind: String,
    pub program: String,
    pub reported_version: Option<String>,
    pub installation_identity: String,
    pub installation_generation: u64,
}

/// Stable codes only. A value never carries a program path, argv or environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteCatalogError {
    /// No `execution_node` row has this identity.
    NodeNotFound,
    /// The row exists but is the local node, which is never a remote target.
    NodeNotRemote,
    /// The remote node was revoked, so its stored facts are no longer trusted.
    NodeRevoked,
    /// No usable CLI record, or its stored program path is not launchable.
    ProgramUnavailable,
    /// The record carries no installation facts (a node paired before 231).
    InstallationUnavailable,
    /// Facts exist but the identity is not `sha256:` plus 64 lowercase hex.
    IdentityMalformed,
    /// Facts exist but the generation is outside `1..=2^53-1`.
    GenerationOutOfRange,
    /// More than one usable record matches the same adapter family.
    AmbiguousAdapterMatch,
    /// The stored facts differ from the frozen target.
    TargetChanged,
    /// The catalog could not be read (including a schema without migration 231).
    CatalogUnavailable,
}

impl RemoteCatalogError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NodeNotFound => "remote_catalog_node_not_found",
            Self::NodeNotRemote => "remote_catalog_node_not_remote",
            Self::NodeRevoked => "remote_catalog_node_revoked",
            Self::ProgramUnavailable => "remote_catalog_program_unavailable",
            Self::InstallationUnavailable => "remote_catalog_installation_unavailable",
            Self::IdentityMalformed => "remote_catalog_identity_malformed",
            Self::GenerationOutOfRange => "remote_catalog_generation_out_of_range",
            Self::AmbiguousAdapterMatch => "remote_catalog_adapter_ambiguous",
            Self::TargetChanged => "remote_catalog_target_changed",
            Self::CatalogUnavailable => "remote_catalog_unavailable",
        }
    }
}

impl fmt::Display for RemoteCatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for RemoteCatalogError {}

/// Read the single trusted installation a remote node reported for one adapter.
///
/// Both Claude alias names are read together: one stale record never hides a
/// second usable record, and two usable records are ambiguous rather than guessed.
pub fn load_remote_catalog(
    connection: &Connection,
    node_id: &str,
    adapter_kind: &str,
) -> Result<RemoteCatalogEntry, RemoteCatalogError> {
    // A kind that can never name a stored adapter has no launchable program.
    let aliases =
        adapter_query_aliases(adapter_kind).ok_or(RemoteCatalogError::ProgramUnavailable)?;
    let (role, revoked_at): (String, Option<String>) = connection
        .query_row(
            "SELECT role, revoked_at FROM execution_node WHERE node_id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(storage_failure)?
        .ok_or(RemoteCatalogError::NodeNotFound)?;
    if role != "remote" {
        return Err(RemoteCatalogError::NodeNotRemote);
    }
    if revoked_at.is_some() {
        return Err(RemoteCatalogError::NodeRevoked);
    }
    // Bounded read: the primary key prefix selects one node, and the adapter
    // predicate is at most the two names of one alias family. No table scan.
    let mut statement = connection
        .prepare(
            "SELECT adapter_kind, path, version, path_present,
                    installation_identity, installation_generation
               FROM execution_node_cli
              WHERE node_id = ?1 AND adapter_kind IN (?2, ?3)
              ORDER BY adapter_kind",
        )
        .map_err(storage_failure)?;
    let mut rows = statement
        .query(params![node_id, aliases[0], aliases[1]])
        .map_err(storage_failure)?;
    let mut usable: Vec<RemoteCatalogEntry> = Vec::new();
    let mut rejected: Option<RemoteCatalogError> = None;
    while let Some(row) = rows.next().map_err(storage_failure)? {
        let stored_adapter_kind: String = row.get(0).map_err(storage_failure)?;
        let path: String = row.get(1).map_err(storage_failure)?;
        let reported_version: Option<String> = row.get(2).map_err(storage_failure)?;
        let path_present: i64 = row.get(3).map_err(storage_failure)?;
        let installation_identity: Option<String> = row.get(4).map_err(storage_failure)?;
        let installation_generation: Option<i64> = row.get(5).map_err(storage_failure)?;
        match trusted_installation(
            node_id,
            stored_adapter_kind,
            path,
            reported_version,
            path_present,
            installation_identity,
            installation_generation,
        ) {
            Ok(entry) => usable.push(entry),
            Err(error) => rejected = Some(preferred_failure(rejected, error)),
        }
    }
    if usable.len() > 1 {
        return Err(RemoteCatalogError::AmbiguousAdapterMatch);
    }
    match usable.pop() {
        Some(entry) => Ok(entry),
        // A stale alias record is rejected on its own; only the absence of any
        // usable record reaches the caller as an error.
        None => Err(rejected.unwrap_or(RemoteCatalogError::ProgramUnavailable)),
    }
}

/// Re-check a frozen target against the current node catalog.
///
/// `workspace_id`, `workspace_root` and `configuration_digest` belong to the
/// upper layer: this function never claims a workspace or configuration was
/// verified, only that the node still reports the same launchable installation.
pub fn revalidate_remote_target(
    connection: &Connection,
    target: &FrozenRemoteTarget,
) -> Result<(), RemoteCatalogError> {
    let entry = load_remote_catalog(connection, &target.node_id, &target.adapter_kind)?;
    // The read above only returns names from the requested adapter family. This
    // guard keeps the equivalence explicit instead of relying on that lookup.
    if !same_adapter_family(&entry.adapter_kind, &target.adapter_kind) {
        return Err(RemoteCatalogError::TargetChanged);
    }
    if entry.program != target.program {
        return Err(RemoteCatalogError::TargetChanged);
    }
    if entry.installation_identity != target.program_identity {
        return Err(RemoteCatalogError::TargetChanged);
    }
    if entry.installation_generation != target.node_generation {
        return Err(RemoteCatalogError::TargetChanged);
    }
    Ok(())
}

/// Any catalog read failure, including a schema without migration 231, collapses
/// to one code so no SQLite message text reaches a caller.
fn storage_failure<T>(_: T) -> RemoteCatalogError {
    RemoteCatalogError::CatalogUnavailable
}

/// `None` means the requested kind can never name a stored adapter.
fn adapter_query_aliases(adapter_kind: &str) -> Option<[&str; 2]> {
    // The stored column is bounded to 1..=64 characters by the node schema.
    if adapter_kind.is_empty() || adapter_kind.len() > 64 {
        return None;
    }
    match adapter_kind {
        "claude-code" | "claude-code-cli" => Some(CLAUDE_ADAPTER_ALIASES),
        other => Some([other, other]),
    }
}

fn same_adapter_family(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let claude = |value: &str| matches!(value, "claude-code" | "claude-code-cli");
    claude(left) && claude(right)
}

fn valid_installation_identity(value: &str) -> bool {
    match value.strip_prefix("sha256:") {
        Some(hex) => {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }
        None => false,
    }
}

/// Order used when several stored records for one node are unusable.
fn preferred_failure(
    current: Option<RemoteCatalogError>,
    next: RemoteCatalogError,
) -> RemoteCatalogError {
    let rank = |error: RemoteCatalogError| match error {
        RemoteCatalogError::ProgramUnavailable => 0,
        RemoteCatalogError::InstallationUnavailable => 1,
        RemoteCatalogError::IdentityMalformed => 2,
        RemoteCatalogError::GenerationOutOfRange => 3,
        _ => 4,
    };
    match current {
        Some(current) if rank(current) <= rank(next) => current,
        _ => next,
    }
}

fn trusted_installation(
    node_id: &str,
    stored_adapter_kind: String,
    path: String,
    reported_version: Option<String>,
    path_present: i64,
    installation_identity: Option<String>,
    installation_generation: Option<i64>,
) -> Result<RemoteCatalogEntry, RemoteCatalogError> {
    if path_present != 1
        || path.trim().is_empty()
        || path.len() > MAX_PROGRAM_BYTES
        || path.contains('\0')
    {
        return Err(RemoteCatalogError::ProgramUnavailable);
    }
    let Some(installation_identity) = installation_identity else {
        return Err(RemoteCatalogError::InstallationUnavailable);
    };
    if !valid_installation_identity(&installation_identity) {
        return Err(RemoteCatalogError::IdentityMalformed);
    }
    let Some(installation_generation) = installation_generation else {
        return Err(RemoteCatalogError::InstallationUnavailable);
    };
    if installation_generation < 1 || installation_generation > (MAX_INSTALLATION_GENERATION as i64)
    {
        return Err(RemoteCatalogError::GenerationOutOfRange);
    }
    Ok(RemoteCatalogEntry {
        node_id: node_id.to_string(),
        adapter_kind: stored_adapter_kind,
        program: path,
        reported_version,
        installation_identity,
        installation_generation: installation_generation as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE_ID: &str = "node-b";
    const TOKEN_DIGEST: &str = concat!(
        "cccccccc", "cccccccc", "cccccccc", "cccccccc", "cccccccc", "cccccccc", "cccccccc",
        "cccccccc",
    );
    const IDENTITY_A: &str = concat!(
        "sha256:", "aaaaaaaa", "aaaaaaaa", "aaaaaaaa", "aaaaaaaa", "aaaaaaaa", "aaaaaaaa",
        "aaaaaaaa", "aaaaaaaa",
    );
    const IDENTITY_B: &str = concat!(
        "sha256:", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb",
        "bbbbbbbb", "bbbbbbbb",
    );
    const IDENTITY_UPPERCASE: &str = concat!(
        "sha256:", "AAAAAAAA", "AAAAAAAA", "AAAAAAAA", "AAAAAAAA", "AAAAAAAA", "AAAAAAAA",
        "AAAAAAAA", "AAAAAAAA",
    );
    const PROGRAM: &str = "C:/fixture/claude.exe";
    const REPORTED_AT: &str = "2026-10-26T00:00:00Z";

    #[derive(Clone, Copy)]
    struct CliRow {
        adapter_kind: &'static str,
        path: &'static str,
        version: Option<&'static str>,
        path_present: i64,
        installation_identity: Option<&'static str>,
        installation_generation: Option<i64>,
    }

    const fn cli(adapter_kind: &'static str) -> CliRow {
        CliRow {
            adapter_kind,
            path: PROGRAM,
            version: Some("2.1.0"),
            path_present: 1,
            installation_identity: Some(IDENTITY_A),
            installation_generation: Some(1),
        }
    }

    /// Schema-only in-memory fixture. Production DDL comes from the node store;
    /// migration 231 columns are added only when another owner has not added them.
    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        connection
            .execute_batch(crate::execution_node::SCHEMA_SQL)
            .unwrap();
        for (column, ddl) in [
            (
                "installation_identity",
                "ALTER TABLE execution_node_cli ADD COLUMN installation_identity TEXT NULL",
            ),
            (
                "installation_generation",
                "ALTER TABLE execution_node_cli ADD COLUMN installation_generation INTEGER NULL",
            ),
        ] {
            let present: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('execution_node_cli')
                                    WHERE name = ?1)",
                    [column],
                    |row| row.get(0),
                )
                .unwrap();
            if !present {
                connection.execute_batch(ddl).unwrap();
            }
        }
        connection
    }

    fn insert_node(connection: &Connection, role: &str, revoked_at: Option<&str>) {
        connection
            .execute(
                "INSERT INTO execution_node(
                     node_id, display_name, role, os, arch, token_digest, paired_at, revoked_at,
                     last_heartbeat
                 ) VALUES(?1, 'node', ?2, NULL, NULL, ?3, ?4, ?5, NULL)",
                params![
                    NODE_ID,
                    role,
                    if role == "remote" {
                        Some(TOKEN_DIGEST)
                    } else {
                        None
                    },
                    REPORTED_AT,
                    revoked_at
                ],
            )
            .unwrap();
    }

    fn insert_cli_row(connection: &Connection, row: CliRow, corrupted: bool) {
        if corrupted {
            // This fixture deliberately stores facts the production schema may
            // reject (migration 231 owns those CHECKs). Only the write is relaxed;
            // the reader, not the fixture, owns the fail-closed decision.
            connection
                .execute_batch("PRAGMA ignore_check_constraints=ON;")
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO execution_node_cli(
                     node_id, adapter_kind, path, version, path_present, installation_identity,
                     installation_generation, reported_at
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    NODE_ID,
                    row.adapter_kind,
                    row.path,
                    row.version,
                    row.path_present,
                    row.installation_identity,
                    row.installation_generation,
                    REPORTED_AT
                ],
            )
            .unwrap();
        if corrupted {
            connection
                .execute_batch("PRAGMA ignore_check_constraints=OFF;")
                .unwrap();
        }
    }

    #[derive(Clone, Copy)]
    enum Node {
        Absent,
        Remote,
        Local,
        Revoked,
    }

    fn seed(connection: &Connection, node: Node, rows: &[CliRow], corrupted: bool) {
        match node {
            Node::Absent => {}
            Node::Remote => insert_node(connection, "remote", None),
            Node::Local => insert_node(connection, "local", None),
            Node::Revoked => insert_node(connection, "remote", Some(REPORTED_AT)),
        }
        for row in rows {
            insert_cli_row(connection, *row, corrupted);
        }
    }

    enum Expected {
        Entry {
            adapter_kind: &'static str,
            program: &'static str,
            reported_version: Option<&'static str>,
            installation_identity: &'static str,
            installation_generation: u64,
        },
        Error(RemoteCatalogError),
    }

    struct ReadCase {
        name: &'static str,
        node: Node,
        rows: &'static [CliRow],
        corrupted: bool,
        adapter_kind: &'static str,
        expected: Expected,
    }

    const READ_CASES: &[ReadCase] = &[
        ReadCase {
            name: "unknown node has no catalog",
            node: Node::Absent,
            rows: &[],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::NodeNotFound),
        },
        ReadCase {
            name: "local node is never a remote target",
            node: Node::Local,
            rows: &[cli("claude-code-cli")],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::NodeNotRemote),
        },
        ReadCase {
            name: "revoked node facts are rejected whole",
            node: Node::Revoked,
            rows: &[cli("claude-code-cli")],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::NodeRevoked),
        },
        ReadCase {
            name: "node without a cli record",
            node: Node::Remote,
            rows: &[],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::ProgramUnavailable),
        },
        ReadCase {
            name: "legacy row without installation facts",
            node: Node::Remote,
            rows: &[CliRow {
                installation_identity: None,
                installation_generation: None,
                ..cli("claude-code-cli")
            }],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::InstallationUnavailable),
        },
        ReadCase {
            name: "identity is not lowercase sha256 hex",
            node: Node::Remote,
            rows: &[CliRow {
                installation_identity: Some(IDENTITY_UPPERCASE),
                ..cli("claude-code-cli")
            }],
            corrupted: true,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::IdentityMalformed),
        },
        ReadCase {
            name: "generation zero",
            node: Node::Remote,
            rows: &[CliRow {
                installation_generation: Some(0),
                ..cli("claude-code-cli")
            }],
            corrupted: true,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::GenerationOutOfRange),
        },
        ReadCase {
            name: "generation above two to the fifty-third",
            node: Node::Remote,
            rows: &[CliRow {
                installation_generation: Some(9_007_199_254_740_992),
                ..cli("claude-code-cli")
            }],
            corrupted: true,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::GenerationOutOfRange),
        },
        ReadCase {
            name: "generation at the largest exact integer",
            node: Node::Remote,
            rows: &[CliRow {
                installation_generation: Some(9_007_199_254_740_991),
                ..cli("claude-code-cli")
            }],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Entry {
                adapter_kind: "claude-code-cli",
                program: PROGRAM,
                reported_version: Some("2.1.0"),
                installation_identity: IDENTITY_A,
                installation_generation: 9_007_199_254_740_991,
            },
        },
        ReadCase {
            name: "empty program path",
            node: Node::Remote,
            rows: &[CliRow {
                path: "",
                ..cli("claude-code-cli")
            }],
            corrupted: true,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::ProgramUnavailable),
        },
        ReadCase {
            name: "program path with a NUL byte",
            node: Node::Remote,
            rows: &[CliRow {
                path: "C:/fixture/cla\0ude.exe",
                ..cli("claude-code-cli")
            }],
            corrupted: true,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::ProgramUnavailable),
        },
        ReadCase {
            name: "program reported absent",
            node: Node::Remote,
            rows: &[CliRow {
                path_present: 0,
                ..cli("claude-code-cli")
            }],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::ProgramUnavailable),
        },
        ReadCase {
            name: "unique claude alias is accepted",
            node: Node::Remote,
            rows: &[cli("claude-code")],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Entry {
                adapter_kind: "claude-code",
                program: PROGRAM,
                reported_version: Some("2.1.0"),
                installation_identity: IDENTITY_A,
                installation_generation: 1,
            },
        },
        ReadCase {
            name: "both claude aliases usable is ambiguous",
            node: Node::Remote,
            rows: &[cli("claude-code"), cli("claude-code-cli")],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Error(RemoteCatalogError::AmbiguousAdapterMatch),
        },
        ReadCase {
            name: "stale alias never hides the single usable record",
            node: Node::Remote,
            rows: &[
                CliRow {
                    path_present: 0,
                    ..cli("claude-code")
                },
                cli("claude-code-cli"),
            ],
            corrupted: false,
            adapter_kind: "claude-code-cli",
            expected: Expected::Entry {
                adapter_kind: "claude-code-cli",
                program: PROGRAM,
                reported_version: Some("2.1.0"),
                installation_identity: IDENTITY_A,
                installation_generation: 1,
            },
        },
        ReadCase {
            name: "another adapter never leaks into the requested family",
            node: Node::Remote,
            rows: &[
                CliRow {
                    path: "C:/fixture/codex.exe",
                    ..cli("codex-cli")
                },
                cli("claude-code-cli"),
            ],
            corrupted: false,
            adapter_kind: "codex-cli",
            expected: Expected::Entry {
                adapter_kind: "codex-cli",
                program: "C:/fixture/codex.exe",
                reported_version: Some("2.1.0"),
                installation_identity: IDENTITY_A,
                installation_generation: 1,
            },
        },
    ];

    fn assert_entry(
        case: &str,
        expected: &Expected,
        result: Result<RemoteCatalogEntry, RemoteCatalogError>,
    ) {
        match (expected, result) {
            (
                Expected::Entry {
                    adapter_kind,
                    program,
                    reported_version,
                    installation_identity,
                    installation_generation,
                },
                Ok(entry),
            ) => {
                assert_eq!(entry.node_id, NODE_ID, "{case}");
                assert_eq!(entry.adapter_kind, *adapter_kind, "{case}");
                assert_eq!(entry.program, *program, "{case}");
                assert_eq!(
                    entry.reported_version.as_deref(),
                    *reported_version,
                    "{case}"
                );
                assert_eq!(
                    entry.installation_identity, *installation_identity,
                    "{case}"
                );
                assert_eq!(
                    entry.installation_generation, *installation_generation,
                    "{case}"
                );
            }
            (Expected::Error(expected), Err(error)) => assert_eq!(error, *expected, "{case}"),
            (Expected::Error(expected), Ok(entry)) => {
                panic!(
                    "{case}: expected {} but read {}",
                    expected.code(),
                    entry.adapter_kind
                )
            }
            (Expected::Entry { .. }, Err(error)) => panic!("{case}: unexpected {error}"),
        }
    }

    #[test]
    fn catalog_reads_one_trusted_installation_and_rejects_untagged_or_corrupt_facts() {
        for case in READ_CASES {
            let connection = fixture();
            seed(&connection, case.node, case.rows, case.corrupted);
            let before = connection.total_changes();
            let result = load_remote_catalog(&connection, NODE_ID, case.adapter_kind);
            assert_eq!(
                connection.total_changes(),
                before,
                "{}: a catalog read must not write",
                case.name
            );
            assert_entry(case.name, &case.expected, result);
        }
    }

    fn frozen_target() -> FrozenRemoteTarget {
        FrozenRemoteTarget {
            node_id: NODE_ID.to_string(),
            node_generation: 1,
            workspace_id: "work-1".to_string(),
            workspace_root: "C:/fixture/work".to_string(),
            adapter_kind: "claude-code-cli".to_string(),
            program: PROGRAM.to_string(),
            program_identity: IDENTITY_A.to_string(),
            configuration_digest: "sha256:configuration".to_string(),
        }
    }

    struct RevalidateCase {
        name: &'static str,
        node: Node,
        rows: &'static [CliRow],
        adapter_kind: &'static str,
        program: &'static str,
        program_identity: &'static str,
        node_generation: u64,
        expected: Result<(), RemoteCatalogError>,
    }

    const REVALIDATE_CASES: &[RevalidateCase] = &[
        RevalidateCase {
            name: "unchanged installation facts are still valid",
            node: Node::Remote,
            rows: &[cli("claude-code-cli")],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Ok(()),
        },
        RevalidateCase {
            name: "claude alias is the same family as the frozen kind",
            node: Node::Remote,
            rows: &[cli("claude-code")],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Ok(()),
        },
        RevalidateCase {
            name: "program path change invalidates the target",
            node: Node::Remote,
            rows: &[cli("claude-code-cli")],
            adapter_kind: "claude-code-cli",
            program: "C:/fixture/claude-old.exe",
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Err(RemoteCatalogError::TargetChanged),
        },
        RevalidateCase {
            name: "installation identity change invalidates the target",
            node: Node::Remote,
            rows: &[cli("claude-code-cli")],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_B,
            node_generation: 1,
            expected: Err(RemoteCatalogError::TargetChanged),
        },
        RevalidateCase {
            name: "installation generation change invalidates the target",
            node: Node::Remote,
            rows: &[cli("claude-code-cli")],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 2,
            expected: Err(RemoteCatalogError::TargetChanged),
        },
        RevalidateCase {
            name: "adapter change without that cli record",
            node: Node::Remote,
            rows: &[cli("claude-code-cli")],
            adapter_kind: "codex-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Err(RemoteCatalogError::ProgramUnavailable),
        },
        RevalidateCase {
            name: "revoked node invalidates the target",
            node: Node::Revoked,
            rows: &[cli("claude-code-cli")],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Err(RemoteCatalogError::NodeRevoked),
        },
        RevalidateCase {
            name: "unknown node invalidates the target",
            node: Node::Absent,
            rows: &[],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Err(RemoteCatalogError::NodeNotFound),
        },
        RevalidateCase {
            name: "two usable claude aliases are never guessed",
            node: Node::Remote,
            rows: &[cli("claude-code"), cli("claude-code-cli")],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Err(RemoteCatalogError::AmbiguousAdapterMatch),
        },
        RevalidateCase {
            name: "stale alias does not replace the valid frozen target",
            node: Node::Remote,
            rows: &[
                CliRow {
                    path_present: 0,
                    ..cli("claude-code")
                },
                cli("claude-code-cli"),
            ],
            adapter_kind: "claude-code-cli",
            program: PROGRAM,
            program_identity: IDENTITY_A,
            node_generation: 1,
            expected: Ok(()),
        },
    ];

    #[test]
    fn frozen_target_revalidation_rejects_changed_facts_and_survives_a_reconnect() {
        for case in REVALIDATE_CASES {
            let connection = fixture();
            seed(&connection, case.node, case.rows, false);
            let mut target = frozen_target();
            target.adapter_kind = case.adapter_kind.to_string();
            target.program = case.program.to_string();
            target.program_identity = case.program_identity.to_string();
            target.node_generation = case.node_generation;
            let before = connection.total_changes();
            let result = revalidate_remote_target(&connection, &target);
            assert_eq!(
                connection.total_changes(),
                before,
                "{}: revalidation must not write",
                case.name
            );
            assert_eq!(result, case.expected, "{}", case.name);
        }

        // A reconnect refreshes reported_at but keeps the durable installation
        // facts, so the frozen Host target stays valid across it.
        let connection = fixture();
        seed(&connection, Node::Remote, &[cli("claude-code-cli")], false);
        let target = frozen_target();
        let before = connection.total_changes();
        assert_eq!(revalidate_remote_target(&connection, &target), Ok(()));
        assert_eq!(
            connection.total_changes(),
            before,
            "revalidation must not write"
        );
        connection
            .execute(
                "UPDATE execution_node_cli SET reported_at=?1
                  WHERE node_id=?2 AND adapter_kind='claude-code-cli'",
                params!["2026-10-27T00:00:00Z", NODE_ID],
            )
            .unwrap();
        let before = connection.total_changes();
        assert_eq!(revalidate_remote_target(&connection, &target), Ok(()));
        assert_eq!(
            connection.total_changes(),
            before,
            "revalidation must not write"
        );
    }
}
