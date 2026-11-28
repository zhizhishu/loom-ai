//! Persisted execution nodes and the runs A has dispatched to them.
//!
//! The node tables are created by schema migration 225. Migration 226 adds the
//! per-run shim credential. This module only reads and writes them. It does not
//! choose the mission execution host: a remote node is never the default place
//! a mission runs.

use anyhow::{Context, Result, bail};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

mod run_bundle;
mod workspace_rpc;
pub use run_bundle::{
    BUNDLE_SCHEMA_SQL, MAX_MANIFEST_BYTES, RunBundleStoreError, StoredRunBundle,
    bundle_schema_matches, launch_digest,
};

pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE execution_node (
    node_id TEXT PRIMARY KEY CHECK(length(node_id) BETWEEN 1 AND 80),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
    role TEXT NOT NULL CHECK(role IN ('local','remote')),
    os TEXT CHECK(os IS NULL OR length(os) BETWEEN 1 AND 32),
    arch TEXT CHECK(arch IS NULL OR length(arch) BETWEEN 1 AND 32),
    token_digest TEXT CHECK(token_digest IS NULL OR (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*')),
    paired_at TEXT NOT NULL,
    revoked_at TEXT,
    last_heartbeat TEXT,
    CHECK(role = 'local' OR token_digest IS NOT NULL),
    CHECK(role <> 'local' OR token_digest IS NULL),
    CHECK(role <> 'local' OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX execution_node_one_local ON execution_node(role) WHERE role = 'local';
CREATE TABLE execution_node_cli (
    node_id TEXT NOT NULL REFERENCES execution_node(node_id) ON DELETE CASCADE,
    adapter_kind TEXT NOT NULL CHECK(length(adapter_kind) BETWEEN 1 AND 64),
    path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 4096),
    version TEXT CHECK(version IS NULL OR length(version) BETWEEN 1 AND 200),
    path_present INTEGER NOT NULL CHECK(path_present IN (0,1)),
    reported_at TEXT NOT NULL,
    PRIMARY KEY (node_id, adapter_kind)
);
CREATE TABLE node_dispatch (
    run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 80),
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    node_id TEXT NOT NULL REFERENCES execution_node(node_id),
    runtime TEXT NOT NULL CHECK(length(runtime) BETWEEN 1 AND 64),
    status TEXT NOT NULL CHECK(status IN ('running','exited','interrupted')),
    acked_seq INTEGER NOT NULL CHECK(acked_seq >= 0),
    exit_code INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (run_id, attempt)
);
CREATE INDEX node_dispatch_node_status_idx ON node_dispatch(node_id, status);
CREATE TABLE node_dispatch_output (
    run_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK(seq >= 1),
    stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')),
    data BLOB NOT NULL,
    PRIMARY KEY (run_id, attempt, seq),
    FOREIGN KEY (run_id, attempt) REFERENCES node_dispatch(run_id, attempt) ON DELETE CASCADE
);
"#;

/// Migration 226. A digest of a per-run shim token. The plaintext is not stored.
pub const SHIM_SCHEMA_SQL: &str = r#"
CREATE TABLE node_run_credential (
    token_digest TEXT PRIMARY KEY CHECK(length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
    run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 80),
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 80),
    member_id TEXT CHECK(member_id IS NULL OR length(member_id) BETWEEN 1 AND 80),
    mission_id TEXT CHECK(mission_id IS NULL OR length(mission_id) BETWEEN 1 AND 200),
    revoked_at TEXT,
    FOREIGN KEY (run_id, attempt) REFERENCES node_dispatch(run_id, attempt) ON DELETE CASCADE
);
CREATE INDEX node_run_credential_run_idx ON node_run_credential(run_id, attempt);
CREATE INDEX node_run_credential_node_idx ON node_run_credential(node_id);
"#;

pub fn shim_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let compact = |sql: &str| sql.split_whitespace().collect::<String>();
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='node_run_credential'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(sql) = sql else {
        return Ok(false);
    };
    let sql = compact(&sql);
    Ok([
        "token_digest TEXT PRIMARY KEY",
        "member_id TEXT",
        "mission_id TEXT",
        "revoked_at TEXT",
        "REFERENCES node_dispatch(run_id, attempt)",
    ]
    .iter()
    .all(|token| sql.contains(&compact(token))))
}

/// Migration 239. The device session pair the gateway reports when a socket opens and
/// closes, ported from the Mikka `devices` session columns (`2026-11-17-2215`). The node
/// is online while the session it opened last is not closed; `last_heartbeat` stays a
/// display-only last-seen for people.
pub fn session_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare("SELECT name, type FROM pragma_table_info('execution_node')")?;
    let columns = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(["session_opened_at", "session_closed_at", "session_socket_id"]
        .iter()
        .all(|wanted| columns.iter().any(|(name, kind)| name == wanted && kind == "TEXT")))
}

/// One gateway session report. The socket that opened last owns the session, so a late
/// report from a replaced socket changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionReportState {
    Connected,
    Disconnected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceSessionReport {
    pub state: SessionReportState,
    pub at: DateTime<Utc>,
    pub socket_id: String,
}

fn report_stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let compact = |sql: &str| sql.split_whitespace().collect::<String>();
    let holds = |table: &str, tokens: &[&str]| -> rusqlite::Result<bool> {
        let sql: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .optional()?;
        Ok(sql.is_some_and(|sql| {
            let sql = compact(&sql);
            tokens.iter().all(|token| sql.contains(&compact(token)))
        }))
    };
    let local_index: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index'
             AND name='execution_node_one_local' AND sql LIKE '%role = ''local''%')",
        [],
        |row| row.get(0),
    )?;
    Ok(holds(
        "execution_node",
        &[
            "CHECK(role IN ('local','remote'))",
            "CHECK(role = 'local' OR token_digest IS NOT NULL)",
            "CHECK(role <> 'local' OR token_digest IS NULL)",
            "CHECK(role <> 'local' OR revoked_at IS NULL)",
        ],
    )? && holds(
        "execution_node_cli",
        &[
            "PRIMARY KEY (node_id, adapter_kind)",
            "REFERENCES execution_node(node_id) ON DELETE CASCADE",
        ],
    )? && holds(
        "node_dispatch",
        &[
            "CHECK(status IN ('running','exited','interrupted'))",
            "PRIMARY KEY (run_id, attempt)",
            "acked_seq INTEGER NOT NULL",
        ],
    )? && holds(
        "node_dispatch_output",
        &[
            "CHECK(stream IN ('stdout','stderr'))",
            "PRIMARY KEY (run_id, attempt, seq)",
            "FOREIGN KEY (run_id, attempt) REFERENCES node_dispatch(run_id, attempt)",
        ],
    )? && local_index)
}

fn generated_remote_name(node_id: &str) -> Option<String> {
    let tail = node_id.get(5..13)?;
    if tail.len() == 8 && tail.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(format!("node-{tail}"))
    } else {
        None
    }
}

fn usable_hostname(hostname: &str) -> Option<&str> {
    let hostname = hostname.trim();
    if hostname.is_empty()
        || hostname.len() > 64
        || hostname.starts_with(['-', '.'])
        || hostname.ends_with(['-', '.'])
        || !hostname
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
    {
        return None;
    }
    Some(hostname)
}

fn now_stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// An empty path, or the words `path_missing`, is not a location the node saw.
fn is_path_sentinel(path: &str) -> bool {
    path.is_empty() || path == "path_missing"
}

pub(crate) fn fresh_heartbeat(stamp: Option<&str>, now: DateTime<Utc>) -> bool {
    let Some(stamp) = stamp else {
        return false;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(stamp) else {
        return false;
    };
    let age = now.signed_duration_since(parsed.with_timezone(&Utc));
    age <= chrono::Duration::from_std(HEARTBEAT_TIMEOUT).unwrap_or(chrono::Duration::seconds(30))
}

#[derive(Clone)]
pub struct NodeStore {
    connection: Arc<Mutex<Connection>>,
}

pub struct TokenState {
    pub digest_hex: String,
    pub revoked: bool,
}

pub struct CliRecord {
    pub adapter_kind: String,
    pub path: String,
    pub version: Option<String>,
    pub path_present: bool,
    pub reported_at: String,
    pub installation_identity: Option<String>,
    pub installation_generation: Option<u64>,
}

pub struct DispatchRecord {
    pub run_id: String,
    pub attempt: u32,
    pub node_id: String,
    pub runtime: String,
    pub status: String,
    pub acked_seq: u64,
    pub exit_code: Option<i32>,
    pub started_at: String,
}

pub struct NodeRecord {
    pub node_id: String,
    pub display_name: String,
    pub role: String,
    pub revocable: bool,
    pub status: String,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub paired_at: String,
    pub revoked_at: Option<String>,
    pub last_heartbeat: Option<String>,
    pub clis: Vec<CliRecord>,
    pub active_runs: Vec<DispatchRecord>,
    /// Latest dispatches, including ones that already finished. The live view
    /// reads these. `active_runs` stays the running set the node list counts.
    pub recent_runs: Vec<DispatchRecord>,
}

pub struct OutputFrame {
    pub seq: u64,
    pub stream: String,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub enum OutputWrite {
    Stored,
    Duplicate,
    Gap,
    TooLarge,
    Missing,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRecord {
    pub id: String,
    pub mission_id: String,
    pub camp_id: String,
    pub execution_host_id: String,
    pub source_directory: String,
    pub repository_root: String,
    pub git_common_dir: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_sha: String,
    pub owner_name: String,
    pub owner_role: String,
    pub last_heartbeat: Option<String>,
}

#[derive(Debug)]
pub enum TaskHost {
    Missing,
    Unpinned,
    Pinned(String),
}

#[derive(Debug)]
pub struct RunGrant {
    pub member_id: Option<String>,
    pub mission_id: Option<String>,
    pub usable: bool,
}

#[derive(Debug)]
pub enum RevokeResult {
    Revoked { revoked_at: String },
    Already { revoked_at: String },
    Local,
    Missing,
}

#[derive(Debug)]
pub enum NextAttempt {
    Opened {
        attempt: u32,
        node_id: String,
        runtime: String,
    },
    StillRunning {
        attempt: u32,
    },
    NotInterrupted,
    Missing,
}

/// SQL INTEGER is signed. Convert only the advertised safe positive counter
/// range; malformed retained rows are errors rather than a wrapped generation.
fn read_installation_generation(row:&rusqlite::Row<'_>, index:usize)
    ->rusqlite::Result<Option<u64>> {
    row.get::<_,Option<i64>>(index)?.map(|value|{
        u64::try_from(value).ok()
            .filter(|generation|(1..=(1_u64<<53)-1).contains(generation))
            .ok_or(rusqlite::Error::IntegralValueOutOfRange(index,value))
    }).transpose()
}

fn valid_installation_identity(identity: &str) -> bool {
    identity.strip_prefix("sha256:").is_some_and(|hex| hex.len() == 64
        && hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

impl NodeStore {
    pub fn open(path: &Path) -> Result<Self> {
        let connection =
            Connection::open(path).with_context(|| format!("could not open {}", path.display()))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .context("could not set the node store busy timeout")?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .context("could not configure the node store")?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    /// Schema-only database for tests of the store. Production tables come from migration 225.
    pub fn open_ephemeral() -> Result<Self> {
        let connection = Connection::open_in_memory().context("ephemeral node store")?;
        connection.execute_batch("PRAGMA foreign_keys=ON;")?;
        connection.execute_batch(SCHEMA_SQL)?;
        connection.execute_batch(SHIM_SCHEMA_SQL)?;
        connection.execute_batch(BUNDLE_SCHEMA_SQL)?;
        // The production columns arrive through migration 231; this is a schema-only fixture.
        connection.execute_batch("ALTER TABLE execution_node_cli ADD COLUMN installation_identity TEXT; ALTER TABLE execution_node_cli ADD COLUMN installation_generation INTEGER CHECK(installation_generation IS NULL OR installation_generation>=1);")?;
        // Migration 239 adds the device session pair. The fixture applies the same step instead of
        // 225 alone, so a store test reads the columns a migrated database has.
        connection.execute_batch("ALTER TABLE execution_node ADD COLUMN session_opened_at TEXT; ALTER TABLE execution_node ADD COLUMN session_closed_at TEXT; ALTER TABLE execution_node ADD COLUMN session_socket_id TEXT;")?;
        debug_assert!(session_schema_matches(&connection)?, "the fixture must match migration 239");
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow::anyhow!("node store lock poisoned"))
    }

    pub fn insert_remote(
        &self,
        node_id: &str,
        display_name: &str,
        token_digest_hex: &str,
    ) -> Result<()> {
        let now = now_stamp();
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO execution_node(
                node_id, display_name, role, os, arch, token_digest, paired_at, revoked_at, last_heartbeat
             ) VALUES(?1, ?2, 'remote', NULL, NULL, ?3, ?4, NULL, NULL)",
            params![node_id, display_name, token_digest_hex, now],
        )?;
        Ok(())
    }

    pub fn token_state(&self, node_id: &str) -> Result<Option<TokenState>> {
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT token_digest, revoked_at FROM execution_node WHERE node_id=?1 AND role='remote'",
                [node_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(row.map(|(digest, revoked)| TokenState {
            digest_hex: digest.unwrap_or_default(),
            revoked: revoked.is_some(),
        }))
    }

    pub fn record_hello(
        &self,
        node_id: &str,
        os: &str,
        arch: &str,
        clis: &[CliRecord],
    ) -> Result<()> {
        let now = now_stamp();
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let updated = tx.execute(
            "UPDATE execution_node
                SET os=?2, arch=?3, last_heartbeat=?4
              WHERE node_id=?1 AND role='remote' AND revoked_at IS NULL",
            params![node_id, os, arch, now],
        )?;
        if updated != 1 {
            bail!("node is not an active remote");
        }
        // Kinds omitted from this hello stay as last seen. Going offline does not
        // write a row either. `path_missing` is only stored when the node names a
        // real path and says it is gone; the sentinel string is never written.
        for cli in clis {
            if cli.adapter_kind.is_empty()
                || cli.adapter_kind.len() > 64
                || cli.path.len() > 4096
                || cli.path.contains('\0')
                || cli
                    .version
                    .as_ref()
                    .is_some_and(|version| version.is_empty() || version.len() > 200)
            {
                bail!("invalid cli report");
            }
            match (&cli.installation_identity, cli.installation_generation) {
                (None, None) => {}
                (Some(identity), Some(generation))
                    if valid_installation_identity(identity) && (1..=(1_u64 << 53) - 1).contains(&generation) => {}
                _ => bail!("invalid cli installation report"),
            }
            if let (Some(identity), Some(generation)) = (&cli.installation_identity, cli.installation_generation) {
                let previous: Option<(String, Option<String>, Option<u64>)> = tx.query_row(
                    "SELECT path,installation_identity,installation_generation FROM execution_node_cli WHERE node_id=?1 AND adapter_kind=?2",
                    params![node_id,cli.adapter_kind], |row| Ok((row.get(0)?,row.get(1)?,read_installation_generation(row,2)?))
                ).optional()?;
                if let Some((previous_path, Some(previous_identity), Some(previous_generation))) = previous {
                    let same_binding = previous_identity == *identity && previous_path == cli.path;
                    if (same_binding && previous_generation != generation)
                        || (!same_binding && previous_generation >= generation) {
                        bail!("cli installation generation regressed");
                    }
                }
            }
            if is_path_sentinel(&cli.path) {
                if cli.path_present {
                    bail!("invalid cli report");
                }
                continue;
            }
            tx.execute(
                "INSERT INTO execution_node_cli(
                    node_id, adapter_kind, path, version, path_present, reported_at, installation_identity, installation_generation
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(node_id, adapter_kind) DO UPDATE SET
                    path=excluded.path,
                    version=excluded.version,
                    path_present=excluded.path_present,
                    reported_at=excluded.reported_at,
                    installation_identity=excluded.installation_identity,
                    installation_generation=excluded.installation_generation",
                params![
                    node_id,
                    cli.adapter_kind,
                    cli.path,
                    cli.version,
                    if cli.path_present { 1 } else { 0 },
                    now,
                    cli.installation_identity,
                    cli.installation_generation.map(i64::try_from).transpose()
                        .map_err(|_|anyhow::anyhow!("invalid cli installation report"))?
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Replace the generated `node-xxxxxxxx` name with the host name from Hello.
    /// A name that is no longer that generated label is left alone.
    pub fn adopt_reported_hostname(&self, node_id: &str, hostname: &str) -> Result<bool> {
        let Some(hostname) = usable_hostname(hostname) else {
            return Ok(false);
        };
        let Some(generated) = generated_remote_name(node_id) else {
            return Ok(false);
        };
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE execution_node SET display_name=?3
              WHERE node_id=?1 AND role='remote' AND revoked_at IS NULL AND display_name=?2",
            params![node_id, generated, hostname],
        )?;
        Ok(updated == 1)
    }

    pub fn record_heartbeat(&self, node_id: &str) -> Result<bool> {
        let now = now_stamp();
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE execution_node SET last_heartbeat=?2
              WHERE node_id=?1 AND role='remote' AND revoked_at IS NULL",
            params![node_id, now],
        )?;
        Ok(updated == 1)
    }

    pub fn revoke(&self, node_id: &str) -> Result<RevokeResult> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let row = tx
            .query_row(
                "SELECT role, revoked_at FROM execution_node WHERE node_id=?1",
                [node_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((role, revoked_at)) = row else {
            return Ok(RevokeResult::Missing);
        };
        if role == "local" {
            return Ok(RevokeResult::Local);
        }
        if let Some(revoked_at) = revoked_at {
            return Ok(RevokeResult::Already { revoked_at });
        }
        let now = now_stamp();
        tx.execute(
            "UPDATE execution_node SET revoked_at=?2 WHERE node_id=?1 AND role='remote' AND revoked_at IS NULL",
            params![node_id, now],
        )?;
        tx.execute(
            "UPDATE node_run_credential SET revoked_at=?2
              WHERE node_id=?1 AND revoked_at IS NULL",
            params![node_id, now],
        )?;
        tx.commit()?;
        Ok(RevokeResult::Revoked { revoked_at: now })
    }

    /// Remember a digest for one attempt. The plaintext token never enters this store.
    pub fn issue_run_credential(
        &self,
        digest_hex: &str,
        run_id: &str,
        attempt: u32,
        node_id: &str,
        member_id: Option<&str>,
        mission_id: Option<&str>,
    ) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO node_run_credential(
                token_digest, run_id, attempt, node_id, member_id, mission_id, revoked_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL)",
            params![digest_hex, run_id, attempt, node_id, member_id, mission_id],
        )?;
        Ok(())
    }

    pub fn remote_digest_exists(&self, digest_hex: &str) -> Result<bool> {
        let connection = self.lock()?;
        let found: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_node WHERE role='remote' AND token_digest=?1)",
            [digest_hex],
            |row| row.get(0),
        )?;
        Ok(found)
    }

    /// Scope bound to a shim digest. `usable` is false once the attempt has
    /// ended or the node has been revoked.
    pub fn run_grant(&self, digest_hex: &str) -> Result<Option<RunGrant>> {
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT c.member_id, c.mission_id, c.revoked_at, n.revoked_at, d.status
                   FROM node_run_credential AS c
                   JOIN execution_node AS n ON n.node_id = c.node_id
                   JOIN node_dispatch AS d ON d.run_id = c.run_id AND d.attempt = c.attempt
                  WHERE c.token_digest = ?1",
                [digest_hex],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(
            |(member_id, mission_id, credential_revoked, node_revoked, status)| RunGrant {
                usable: credential_revoked.is_none()
                    && node_revoked.is_none()
                    && status == "running",
                member_id,
                mission_id,
            },
        ))
    }

    pub fn latest_run_scope(
        &self,
        run_id: &str,
    ) -> Result<Option<(Option<String>, Option<String>)>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT member_id, mission_id FROM node_run_credential
                  WHERE run_id=?1 ORDER BY attempt DESC LIMIT 1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn node_role(&self, node_id: &str) -> Result<Option<String>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT role FROM execution_node WHERE node_id=?1",
                [node_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// The role of a node this Host paired and still trusts. A node it never
    /// paired and a node it revoked both answer `None`, so a workspace prepare
    /// can neither create nor revive a row on it.
    pub fn active_node_role(&self, node_id: &str) -> Result<Option<String>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT role FROM execution_node WHERE node_id=?1 AND revoked_at IS NULL",
                [node_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn sqlite_directory(&self) -> Result<PathBuf> {
        let connection = self.lock()?;
        let path = connection
            .path()
            .context("node store has no file path")?
            .to_owned();
        Ok(Path::new(&path)
            .parent()
            .context("node store path has no parent")?
            .to_path_buf())
    }

    pub fn save_workspace(&self, record: &WorkspaceRecord) -> Result<()> {
        let now = now_stamp();
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO mission_workspace(
                id, mission_id, camp_id, execution_host_id, source_directory,
                repository_root, git_common_dir, worktree_path, working_directory,
                base_branch, branch, base_sha, preparation_token, preparation_kind,
                generation, state, created_at, updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,NULL,?9,?10,?11,'create',1,'ready',?12,?12)",
            params![
                record.id,
                record.mission_id,
                record.camp_id,
                record.execution_host_id,
                record.source_directory,
                record.repository_root,
                record.git_common_dir,
                record.worktree_path,
                record.branch,
                record.base_sha,
                record.id,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn revalidate_remote_launch(&self, launch: &crate::remote_process::ScopedRemoteLaunch) -> Result<()> {
        let connection = self.lock()?;
        crate::remote_execution::revalidate_remote_launch(&connection, launch)
    }

    pub fn workspace_by_id(&self, workspace_id: &str) -> Result<Option<WorkspaceRecord>> {
        self.workspace_where("w.id=?1", &[workspace_id])
    }

    pub fn workspace_by_mission(&self, mission_id: &str) -> Result<Option<WorkspaceRecord>> {
        self.workspace_where("w.mission_id=?1", &[mission_id])
    }

    /// The one ready row this Mission already has on one execution host. A row on
    /// any other host is a different execution root and never substitutes for it.
    pub fn workspace_by_mission_and_host(
        &self,
        mission_id: &str,
        execution_host_id: &str,
    ) -> Result<Option<WorkspaceRecord>> {
        self.workspace_where(
            "w.mission_id=?1 AND w.execution_host_id=?2",
            &[mission_id, execution_host_id],
        )
    }

    pub fn workspace_by_camp(&self, camp_id: &str) -> Result<Option<WorkspaceRecord>> {
        self.workspace_where("w.camp_id=?1", &[camp_id])
    }

    fn workspace_where(&self, clause: &str, values: &[&str]) -> Result<Option<WorkspaceRecord>> {
        let connection = self.lock()?;
        let sql = format!(
            "SELECT w.id, w.mission_id, w.camp_id, w.execution_host_id, w.source_directory,
                    w.repository_root, w.git_common_dir, w.worktree_path, w.branch, w.base_sha,
                    n.display_name, n.role, n.last_heartbeat
             FROM mission_workspace w
             JOIN execution_node n ON n.node_id = w.execution_host_id
             WHERE {clause} AND w.state='ready' AND n.revoked_at IS NULL
             ORDER BY CASE WHEN n.role='remote' THEN 0 ELSE 1 END, w.created_at DESC LIMIT 1"
        );
        connection
            .query_row(
                &sql,
                rusqlite::params_from_iter(values.iter().copied()),
                |row| {
                    Ok(WorkspaceRecord {
                        id: row.get(0)?,
                        mission_id: row.get(1)?,
                        camp_id: row.get(2)?,
                        execution_host_id: row.get(3)?,
                        source_directory: row.get(4)?,
                        repository_root: row.get(5)?,
                        git_common_dir: row.get(6)?,
                        worktree_path: row.get(7)?,
                        branch: row.get(8)?,
                        base_sha: row.get(9)?,
                        owner_name: row.get(10)?,
                        owner_role: row.get(11)?,
                        last_heartbeat: row.get(12)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// The host pin on one LOOM task. NULL is unpinned and must not fall
    /// through to a remote node.
    pub fn task_execution_host(&self, task_id: &str) -> Result<TaskHost> {
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT execution_host_id FROM loom_task WHERE task_id=?1",
                [task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        Ok(match row {
            None => TaskHost::Missing,
            Some(None) => TaskHost::Unpinned,
            Some(Some(host)) if host.is_empty() => TaskHost::Unpinned,
            Some(Some(host)) => TaskHost::Pinned(host),
        })
    }

    /// Presence of every node. A remote node is online while the session its own socket
    /// opened last is not closed (decision 2026-11-17-2215); `last_heartbeat` is kept as a
    /// display-only last-seen and no longer decides status. The local node has no socket of
    /// its own to open a session, and it is at most the Host this process runs in.
    pub fn list_nodes(&self) -> Result<Vec<NodeRecord>> {
        let stamp = now_stamp();
        let connection = self.lock()?;
        connection.execute(
            "UPDATE execution_node SET last_heartbeat=?1 WHERE role='local' AND revoked_at IS NULL",
            [stamp],
        )?;
        let mut nodes = Vec::new();
        let mut statement = connection.prepare(
            "SELECT node_id, display_name, role, os, arch, paired_at, revoked_at, last_heartbeat,
                    session_opened_at, session_closed_at
               FROM execution_node
              ORDER BY CASE role WHEN 'local' THEN 0 ELSE 1 END, paired_at, node_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
            ))
        })?;
        for row in rows {
            let (
                node_id,
                display_name,
                role,
                os,
                arch,
                paired_at,
                revoked_at,
                last_heartbeat,
                session_opened_at,
                session_closed_at,
            ) = row?;
            let online = revoked_at.is_none()
                && (role == "local"
                    || crate::device_presence::is_device_online(
                        &crate::device_presence::device_session_state(
                            session_opened_at.as_deref(),
                            session_closed_at.as_deref(),
                        ),
                    ));
            nodes.push(NodeRecord {
                node_id,
                display_name,
                revocable: role != "local" && revoked_at.is_none(),
                status: if online { "online" } else { "offline" }.to_owned(),
                role,
                os,
                arch,
                paired_at,
                revoked_at,
                last_heartbeat,
                clis: Vec::new(),
                active_runs: Vec::new(),
                recent_runs: Vec::new(),
            });
        }
        drop(statement);
        for node in &mut nodes {
            let mut clis = connection.prepare(
                "SELECT adapter_kind, path, version, path_present, reported_at, installation_identity, installation_generation
                   FROM execution_node_cli WHERE node_id=?1 ORDER BY adapter_kind",
            )?;
            node.clis = clis
                .query_map([&node.node_id], |row| {
                    Ok(CliRecord {
                        adapter_kind: row.get(0)?,
                        path: row.get(1)?,
                        version: row.get(2)?,
                        path_present: row.get::<_, i64>(3)? != 0,
                        reported_at: row.get(4)?,
                        installation_identity: row.get(5)?,
                        installation_generation: read_installation_generation(row,6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut runs = connection.prepare(
                "SELECT run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at
                   FROM node_dispatch
                  WHERE node_id=?1 AND status='running'
                  ORDER BY started_at, run_id",
            )?;
            node.active_runs = runs
                .query_map([&node.node_id], read_dispatch)?
                .collect::<Result<Vec<_>, _>>()?;
            let mut recent = connection.prepare(
                "SELECT run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at
                   FROM node_dispatch
                  WHERE node_id=?1
                  ORDER BY started_at DESC, run_id
                  LIMIT 8",
            )?;
            node.recent_runs = recent
                .query_map([&node.node_id], read_dispatch)?
                .collect::<Result<Vec<_>, _>>()?;
        }
        Ok(nodes)
    }

    /// One gateway session report, the only writer of the session columns on
    /// `execution_node`. Connected opens the session of the reporting socket; a report for an
    /// older socket, and a retried connect of a socket whose close is recorded, change
    /// nothing. Disconnected closes only the session its own socket opened, so a late close
    /// of a replaced socket is ignored. Returns whether the report was applied.
    pub fn apply_device_session_report(
        &self,
        node_id: &str,
        report: &DeviceSessionReport,
    ) -> Result<bool> {
        let at = report_stamp(report.at);
        let connection = self.lock()?;
        let applied = match report.state {
            SessionReportState::Connected => connection.execute(
                "UPDATE execution_node
                    SET session_opened_at=?2, session_socket_id=?3, session_closed_at=NULL,
                        last_heartbeat=CASE WHEN last_heartbeat IS NULL OR last_heartbeat < ?2
                                            THEN ?2 ELSE last_heartbeat END
                  WHERE node_id=?1 AND revoked_at IS NULL
                    AND (session_opened_at IS NULL OR session_opened_at < ?2
                         OR (session_opened_at=?2 AND session_closed_at IS NULL))",
                params![node_id, at, report.socket_id],
            )?,
            SessionReportState::Disconnected => connection.execute(
                "UPDATE execution_node
                    SET session_closed_at=CASE WHEN session_opened_at IS NOT NULL
                                                    AND session_opened_at > ?2
                                               THEN session_opened_at ELSE ?2 END,
                        last_heartbeat=CASE WHEN last_heartbeat IS NULL OR last_heartbeat < ?2
                                            THEN ?2 ELSE last_heartbeat END
                  WHERE node_id=?1 AND session_socket_id=?3
                    AND session_opened_at IS NOT NULL AND session_closed_at IS NULL",
                params![node_id, at, report.socket_id],
            )?,
        };
        Ok(applied == 1)
    }

    /// Open this socket's session now. One Host clock stamps every report.
    pub fn open_device_session(&self, node_id: &str, socket_id: &str) -> Result<bool> {
        self.apply_device_session_report(
            node_id,
            &DeviceSessionReport {
                state: SessionReportState::Connected,
                at: Utc::now(),
                socket_id: socket_id.to_owned(),
            },
        )
    }

    /// Close the session this socket opened, and only that one.
    pub fn close_device_session(&self, node_id: &str, socket_id: &str) -> Result<bool> {
        self.apply_device_session_report(
            node_id,
            &DeviceSessionReport {
                state: SessionReportState::Disconnected,
                at: Utc::now(),
                socket_id: socket_id.to_owned(),
            },
        )
    }

    /// Whether this node's session is open, read from the session pair alone. A dispatch or a
    /// claim that needs a present node asks this, never a heartbeat window.
    pub fn device_session_held(&self, node_id: &str) -> Result<bool> {
        let connection = self.lock()?;
        let predicate = crate::device_presence::device_session_open_sql("n");
        let held: bool = connection.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM execution_node n WHERE n.node_id=?1 AND {predicate})"),
            [node_id],
            |row| row.get(0),
        )?;
        Ok(held)
    }

    pub fn begin_dispatch(
        &self,
        run_id: &str,
        attempt: u32,
        node_id: &str,
        runtime: &str,
    ) -> Result<()> {
        let now = now_stamp();
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO node_dispatch(
                run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at, finished_at
             ) VALUES(?1, ?2, ?3, ?4, 'running', 0, NULL, ?5, NULL)",
            params![run_id, attempt, node_id, runtime, now],
        )?;
        Ok(())
    }

    pub fn running_for_node(&self, node_id: &str) -> Result<Vec<DispatchRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at
               FROM node_dispatch
              WHERE node_id=?1 AND status='running'
              ORDER BY started_at, run_id",
        )?;
        let rows = statement
            .query_map([node_id], read_dispatch)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Read one exact current attempt without loading its output body.
    pub fn current_attempt(&self, run_id: &str, attempt: u32) -> Result<Option<DispatchRecord>> {
        let connection = self.lock()?;
        Ok(connection.query_row(
            "SELECT run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at
             FROM node_dispatch WHERE run_id=?1 AND attempt=?2
             AND NOT EXISTS (SELECT 1 FROM node_dispatch newer
                             WHERE newer.run_id=?1 AND newer.attempt>?2)",
            params![run_id, attempt], read_dispatch).optional()?)
    }

    pub fn append_output(
        &self,
        run_id: &str,
        attempt: u32,
        seq: u64,
        stream: &str,
        data: &[u8],
        max_bytes: usize,
    ) -> Result<OutputWrite> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let Some((status, acked)) = dispatch_cursor(&tx, run_id, attempt)? else {
            return Ok(OutputWrite::Missing);
        };
        if status != "running" {
            return Ok(if seq <= acked {
                OutputWrite::Duplicate
            } else {
                OutputWrite::Gap
            });
        }
        if seq == 0 || seq <= acked {
            return Ok(OutputWrite::Duplicate);
        }
        if seq != acked + 1 {
            return Ok(OutputWrite::Gap);
        }
        let used: i64 = tx.query_row(
            "SELECT COALESCE(SUM(length(data)), 0) FROM node_dispatch_output
              WHERE run_id=?1 AND attempt=?2",
            params![run_id, attempt],
            |row| row.get(0),
        )?;
        if used as usize + data.len() > max_bytes {
            return Ok(OutputWrite::TooLarge);
        }
        tx.execute(
            "INSERT INTO node_dispatch_output(run_id, attempt, seq, stream, data)
             VALUES(?1, ?2, ?3, ?4, ?5)",
            params![run_id, attempt, seq as i64, stream, data],
        )?;
        tx.execute(
            "UPDATE node_dispatch SET acked_seq=?3 WHERE run_id=?1 AND attempt=?2",
            params![run_id, attempt, seq as i64],
        )?;
        tx.commit()?;
        Ok(OutputWrite::Stored)
    }

    pub fn finish(
        &self,
        run_id: &str,
        attempt: u32,
        seq: u64,
        exit_code: i32,
    ) -> Result<OutputWrite> {
        let now = now_stamp();
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let Some((status, acked)) = dispatch_cursor(&tx, run_id, attempt)? else {
            return Ok(OutputWrite::Missing);
        };
        if seq == 0 || seq <= acked {
            return Ok(OutputWrite::Duplicate);
        }
        if status != "running" || seq != acked + 1 {
            return Ok(OutputWrite::Gap);
        }
        tx.execute(
            "UPDATE node_dispatch
                SET status='exited', acked_seq=?3, exit_code=?4, finished_at=?5
              WHERE run_id=?1 AND attempt=?2",
            params![run_id, attempt, seq as i64, exit_code, now],
        )?;
        revoke_run_credential(&tx, run_id, attempt, &now)?;
        tx.commit()?;
        Ok(OutputWrite::Stored)
    }

    pub fn interrupt(&self, run_id: &str, attempt: u32) -> Result<bool> {
        let now = now_stamp();
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let updated = tx.execute(
            "UPDATE node_dispatch
                SET status='interrupted', finished_at=?3
              WHERE run_id=?1 AND attempt=?2 AND status='running'",
            params![run_id, attempt, now],
        )?;
        if updated == 1 {
            revoke_run_credential(&tx, run_id, attempt, &now)?;
        }
        tx.commit()?;
        Ok(updated == 1)
    }

    /// A durable Node NoProcess receipt is usable only before any output.
    /// The cursor and output existence check share the write transaction.
    pub fn interrupt_unspawned(&self, run_id: &str, attempt: u32) -> Result<bool> {
        let now = now_stamp();
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let updated = tx.execute(
            "UPDATE node_dispatch SET status='interrupted', finished_at=?3
             WHERE run_id=?1 AND attempt=?2 AND status='running' AND acked_seq=0
             AND NOT EXISTS (SELECT 1 FROM node_dispatch_output
                             WHERE run_id=?1 AND attempt=?2)",
            params![run_id, attempt, now])?;
        if updated == 1 { revoke_run_credential(&tx, run_id, attempt, &now)?; }
        tx.commit()?;
        Ok(updated == 1)
    }

    /// Completion must read the attempt it admitted, never the latest attempt.
    pub fn output_for_attempt(
        &self, run_id: &str, attempt: u32, from_seq: u64,
    ) -> Result<Option<(DispatchRecord, Vec<OutputFrame>)>> {
        let connection = self.lock()?;
        let dispatch = connection.query_row(
            "SELECT run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at
             FROM node_dispatch WHERE run_id=?1 AND attempt=?2",
            params![run_id, attempt], read_dispatch).optional()?;
        let Some(dispatch) = dispatch else { return Ok(None); };
        let mut statement = connection.prepare(
            "SELECT seq, stream, data FROM node_dispatch_output
             WHERE run_id=?1 AND attempt=?2 AND seq>=?3 ORDER BY seq")?;
        let frames = statement.query_map(params![run_id, attempt, from_seq.max(1) as i64],
            |row| Ok(OutputFrame { seq: row.get::<_, i64>(0)? as u64,
                stream: row.get(1)?, data: row.get(2)? }))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some((dispatch, frames)))
    }

    pub fn output_from(
        &self,
        run_id: &str,
        from_seq: u64,
    ) -> Result<Option<(DispatchRecord, Vec<OutputFrame>)>> {
        let connection = self.lock()?;
        let dispatch = connection
            .query_row(
                "SELECT run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at
                   FROM node_dispatch
                  WHERE run_id=?1
                  ORDER BY attempt DESC
                  LIMIT 1",
                [run_id],
                read_dispatch,
            )
            .optional()?;
        let Some(dispatch) = dispatch else {
            return Ok(None);
        };
        let mut statement = connection.prepare(
            "SELECT seq, stream, data FROM node_dispatch_output
              WHERE run_id=?1 AND attempt=?2 AND seq>=?3
              ORDER BY seq",
        )?;
        let frames = statement
            .query_map(
                params![dispatch.run_id, dispatch.attempt, from_seq.max(1) as i64],
                |row| {
                    Ok(OutputFrame {
                        seq: row.get::<_, i64>(0)? as u64,
                        stream: row.get(1)?,
                        data: row.get(2)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some((dispatch, frames)))
    }

    /// A new attempt is recorded only after the previous one is interrupted.
    /// A running attempt is left alone so a second process is not started.
    pub fn open_next_attempt(&self, run_id: &str) -> Result<NextAttempt> {
        let connection = self.lock()?;
        let latest = connection
            .query_row(
                "SELECT attempt, node_id, runtime, status FROM node_dispatch
                  WHERE run_id=?1 ORDER BY attempt DESC LIMIT 1",
                [run_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u32,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((attempt, node_id, runtime, status)) = latest else {
            return Ok(NextAttempt::Missing);
        };
        if status == "running" {
            return Ok(NextAttempt::StillRunning { attempt });
        }
        if status != "interrupted" {
            return Ok(NextAttempt::NotInterrupted);
        }
        let next = attempt.saturating_add(1);
        let now = now_stamp();
        connection.execute(
            "INSERT INTO node_dispatch(
                run_id, attempt, node_id, runtime, status, acked_seq, exit_code, started_at, finished_at
             ) VALUES(?1, ?2, ?3, ?4, 'running', 0, NULL, ?5, NULL)",
            params![run_id, next, node_id, runtime, now],
        )?;
        Ok(NextAttempt::Opened {
            attempt: next,
            node_id,
            runtime,
        })
    }
}

fn revoke_run_credential(
    connection: &Connection,
    run_id: &str,
    attempt: u32,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE node_run_credential SET revoked_at=?3
          WHERE run_id=?1 AND attempt=?2 AND revoked_at IS NULL",
        params![run_id, attempt, now],
    )?;
    Ok(())
}

fn dispatch_cursor(
    connection: &Connection,
    run_id: &str,
    attempt: u32,
) -> rusqlite::Result<Option<(String, u64)>> {
    connection
        .query_row(
            "SELECT status, acked_seq FROM node_dispatch WHERE run_id=?1 AND attempt=?2",
            params![run_id, attempt],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)),
        )
        .optional()
}

fn read_dispatch(row: &rusqlite::Row<'_>) -> rusqlite::Result<DispatchRecord> {
    Ok(DispatchRecord {
        run_id: row.get(0)?,
        attempt: row.get::<_, i64>(1)? as u32,
        node_id: row.get(2)?,
        runtime: row.get(3)?,
        status: row.get(4)?,
        acked_seq: row.get::<_, i64>(5)? as u64,
        exit_code: row.get(6)?,
        started_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("a legal RFC 3339 instant")
            .with_timezone(&Utc)
    }

    fn report(state: SessionReportState, text: &str, socket_id: &str) -> DeviceSessionReport {
        DeviceSessionReport {
            state,
            at: at(text),
            socket_id: socket_id.to_owned(),
        }
    }

    /// Ported from the upstream `device session reports` database test: the socket that opened
    /// last owns the session, reports are idempotent, and only the owning socket closes it.
    #[test]
    fn the_newest_socket_owns_the_session_and_reports_are_idempotent() {
        let store = NodeStore::open_ephemeral().unwrap();
        store.insert_remote("node_a", "desk", &"ab".repeat(32)).unwrap();
        let t0 = "2026-11-17T10:00:00.000Z";
        let t1 = "2026-11-17T10:00:10.000Z";
        let t2 = "2026-11-17T10:00:20.000Z";
        assert!(!store.device_session_held("node_a").unwrap(), "never connected");

        assert!(store
            .apply_device_session_report(
                "node_a",
                &report(SessionReportState::Connected, t0, "socket-aaaaaaaa")
            )
            .unwrap());
        assert!(store.device_session_held("node_a").unwrap());
        assert!(
            store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Connected, t0, "socket-aaaaaaaa")
                )
                .unwrap(),
            "a retried report is idempotent"
        );

        assert!(
            store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Connected, t1, "socket-bbbbbbbb")
                )
                .unwrap(),
            "a newer socket replaces it"
        );
        assert!(
            !store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Connected, t0, "socket-aaaaaaaa")
                )
                .unwrap(),
            "a late connect of the old socket is ignored"
        );
        assert!(
            !store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Disconnected, t2, "socket-aaaaaaaa")
                )
                .unwrap(),
            "a late close of the replaced socket is ignored"
        );
        assert!(store.device_session_held("node_a").unwrap());
        let listed = store.list_nodes().unwrap();
        let node = listed.iter().find(|node| node.node_id == "node_a").unwrap();
        assert_eq!(node.status, "online", "an open session is presence");

        assert!(
            store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Disconnected, t2, "socket-bbbbbbbb")
                )
                .unwrap()
        );
        assert!(
            !store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Disconnected, t2, "socket-bbbbbbbb")
                )
                .unwrap(),
            "idempotent"
        );
        assert!(
            !store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Connected, t1, "socket-bbbbbbbb")
                )
                .unwrap(),
            "a retried connect cannot reopen a closed socket"
        );
        assert!(!store.device_session_held("node_a").unwrap());
        let listed = store.list_nodes().unwrap();
        let node = listed.iter().find(|node| node.node_id == "node_a").unwrap();
        assert_eq!(node.status, "offline");
        assert_eq!(
            node.last_heartbeat.as_deref(),
            Some(t2),
            "last seen is the session time, for people only"
        );
    }

    /// A node whose socket never opened a session is offline, and a report for an unknown or
    /// revoked node is never applied.
    #[test]
    fn a_session_is_opened_only_for_a_live_paired_node() {
        let store = NodeStore::open_ephemeral().unwrap();
        store.insert_remote("node_a", "desk", &"ab".repeat(32)).unwrap();
        assert!(
            !store
                .apply_device_session_report(
                    "node_missing",
                    &report(SessionReportState::Connected, "2026-11-17T10:00:00.000Z", "socket-aaaaaaaa")
                )
                .unwrap(),
            "an unknown node gains no session"
        );
        assert!(matches!(
            store.revoke("node_a").unwrap(),
            RevokeResult::Revoked { .. }
        ));
        assert!(
            !store
                .apply_device_session_report(
                    "node_a",
                    &report(SessionReportState::Connected, "2026-11-17T10:00:00.000Z", "socket-aaaaaaaa")
                )
                .unwrap(),
            "a revoked node gains no session"
        );
        assert!(!store.device_session_held("node_a").unwrap());
    }

    #[test]
    fn legacy_no_process_requires_zero_cursor_and_no_output_and_reads_exact_attempt() {
        let store = NodeStore::open_ephemeral().unwrap();
        store.insert_remote("node_a", "desk", &"ab".repeat(32)).unwrap();
        store.begin_dispatch("run_zero", 1, "node_a", "codex-cli").unwrap();
        assert!(store.interrupt_unspawned("run_zero", 1).unwrap());
        assert!(!store.interrupt_unspawned("run_zero", 1).unwrap());
        assert!(matches!(store.open_next_attempt("run_zero").unwrap(),
            NextAttempt::Opened { attempt: 2, .. }));
        assert!(store.current_attempt("run_zero", 1).unwrap().is_none());
        assert_eq!(store.output_for_attempt("run_zero", 1, 1).unwrap().unwrap().0.status,
            "interrupted");
        assert_eq!(store.output_for_attempt("run_zero", 2, 1).unwrap().unwrap().0.status,
            "running");
        store.append_output("run_zero", 2, 1, "stdout", b"owned", 100).unwrap();
        assert!(!store.interrupt_unspawned("run_zero", 2).unwrap());
        // A corrupted zero cursor still cannot erase evidence of process output.
        store.lock().unwrap().execute(
            "UPDATE node_dispatch SET acked_seq=0 WHERE run_id='run_zero' AND attempt=2", [])
            .unwrap();
        assert!(!store.interrupt_unspawned("run_zero", 2).unwrap());
        assert!(matches!(store.open_next_attempt("run_zero").unwrap(),
            NextAttempt::StillRunning { attempt: 2 }));
    }

    #[test]
    fn interrupted_run_opens_a_new_attempt_and_a_live_one_does_not() {
        let store = NodeStore::open_ephemeral().unwrap();
        store
            .insert_remote("node_a", "desk", &"ab".repeat(32))
            .unwrap();
        store
            .begin_dispatch("run_1", 1, "node_a", "codex-cli")
            .unwrap();
        assert!(matches!(
            store.open_next_attempt("run_1").unwrap(),
            NextAttempt::StillRunning { attempt: 1 }
        ));
        assert!(store.interrupt("run_1", 1).unwrap());
        match store.open_next_attempt("run_1").unwrap() {
            NextAttempt::Opened {
                attempt,
                node_id,
                runtime,
            } => {
                assert_eq!(attempt, 2);
                assert_eq!(node_id, "node_a");
                assert_eq!(runtime, "codex-cli");
            }
            other => panic!("expected a new attempt, got {other:?}"),
        }
        let (dispatch, frames) = store.output_from("run_1", 1).unwrap().unwrap();
        assert_eq!(dispatch.attempt, 2);
        assert_eq!(dispatch.status, "running");
        assert!(frames.is_empty());
        assert!(matches!(
            store
                .append_output("run_1", 2, 1, "stdout", b"hi", 100)
                .unwrap(),
            OutputWrite::Stored
        ));
        assert!(matches!(
            store
                .append_output("run_1", 2, 1, "stdout", b"hi", 100)
                .unwrap(),
            OutputWrite::Duplicate
        ));
        assert!(matches!(
            store.finish("run_1", 2, 2, 0).unwrap(),
            OutputWrite::Stored
        ));
        assert!(matches!(
            store.open_next_attempt("run_1").unwrap(),
            NextAttempt::NotInterrupted
        ));
    }

    #[test]
    fn local_node_cannot_be_revoked_and_a_remote_token_can() {
        let store = NodeStore::open_ephemeral().unwrap();
        let now = now_stamp();
        store
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO execution_node(
                    node_id, display_name, role, os, arch, token_digest, paired_at, revoked_at, last_heartbeat
                 ) VALUES('host', '本机', 'local', 'linux', 'x86_64', NULL, ?1, NULL, ?1)",
                [now],
            )
            .unwrap();
        store
            .insert_remote("node_b", "desk-b", &"cd".repeat(32))
            .unwrap();
        assert!(matches!(store.revoke("host").unwrap(), RevokeResult::Local));
        assert!(matches!(
            store.revoke("node_b").unwrap(),
            RevokeResult::Revoked { .. }
        ));
        assert!(matches!(
            store.revoke("node_b").unwrap(),
            RevokeResult::Already { .. }
        ));
        let listed = store.list_nodes().unwrap();
        let local = listed.iter().find(|node| node.node_id == "host").unwrap();
        assert_eq!(local.role, "local");
        assert!(!local.revocable);
        assert_eq!(local.status, "online");
        let remote = listed.iter().find(|node| node.node_id == "node_b").unwrap();
        assert!(!remote.revocable);
        assert_eq!(remote.status, "offline");
        assert!(remote.revoked_at.is_some());
        let locals: Vec<_> = listed.iter().filter(|node| node.role == "local").collect();
        assert_eq!(locals.len(), 1);
        assert_eq!(locals[0].node_id, "host");
        assert!(
            listed
                .iter()
                .any(|node| node.node_id == "node_b" && node.role == "remote")
        );
    }

    /// A mission row on one host is not the answer for another host. The lookup
    /// the shared prepare uses therefore never lets a local row stand in for a
    /// remote one, and a non-ready or revoked row is not "already prepared".
    #[test]
    fn mission_workspace_lookup_is_host_scoped_and_ready_only() {
        let store = NodeStore::open_ephemeral().unwrap();
        let now = now_stamp();
        store
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO execution_node(
                    node_id, display_name, role, os, arch, token_digest, paired_at, revoked_at, last_heartbeat
                 ) VALUES('host', '本机', 'local', NULL, NULL, NULL, ?1, NULL, NULL)",
                [&now],
            )
            .unwrap();
        store
            .insert_remote("node_b", "desk-b", &"ab".repeat(32))
            .unwrap();
        // The production table arrives with migration 231; this fixture is schema only.
        store
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TABLE mission_workspace (
                    id TEXT PRIMARY KEY NOT NULL, mission_id TEXT NOT NULL, camp_id TEXT NOT NULL,
                    execution_host_id TEXT NOT NULL, source_directory TEXT NOT NULL,
                    repository_root TEXT NOT NULL, git_common_dir TEXT NOT NULL,
                    worktree_path TEXT NOT NULL, working_directory TEXT NOT NULL, base_branch TEXT,
                    branch TEXT NOT NULL, base_sha TEXT NOT NULL, preparation_token TEXT NOT NULL,
                    preparation_kind TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(mission_id,execution_host_id,git_common_dir))",
            )
            .unwrap();
        let row = |id: &str, host: &str, worktree: &str| WorkspaceRecord {
            id: id.into(),
            mission_id: "mission_a".into(),
            camp_id: "camp_a".into(),
            execution_host_id: host.into(),
            source_directory: "/srv/source".into(),
            repository_root: "/srv/source".into(),
            git_common_dir: "/srv/source/.git".into(),
            worktree_path: worktree.into(),
            branch: "loom/mission_a".into(),
            base_sha: "sha".into(),
            owner_name: String::new(),
            owner_role: String::new(),
            last_heartbeat: None,
        };
        // The local row is written last, so a mission-only lookup would answer it.
        store
            .save_workspace(&row("ws_remote", "node_b", "/srv/worktree-remote"))
            .unwrap();
        store
            .save_workspace(&row("ws_local", "host", "/srv/worktree-local"))
            .unwrap();
        // Pin the ordering instead of trusting two timestamps to differ: the newest
        // row is the remote one, which is exactly what a mission-only lookup returns.
        for (id, created_at) in [
            ("ws_remote", "2026-01-01T00:00:02Z"),
            ("ws_local", "2026-01-01T00:00:01Z"),
        ] {
            store
                .lock()
                .unwrap()
                .execute(
                    "UPDATE mission_workspace SET created_at=?1 WHERE id=?2",
                    rusqlite::params![created_at, id],
                )
                .unwrap();
        }
        assert_eq!(
            store.workspace_by_mission("mission_a").unwrap().unwrap().id,
            "ws_remote"
        );
        let remote = store
            .workspace_by_mission_and_host("mission_a", "node_b")
            .unwrap()
            .expect("the remote row answers for its own host");
        assert_eq!(remote.id, "ws_remote");
        assert_eq!(remote.owner_role, "remote");
        assert_eq!(
            store
                .workspace_by_mission_and_host("mission_a", "host")
                .unwrap()
                .unwrap()
                .id,
            "ws_local"
        );
        // A third host has nothing prepared even though the mission has two rows.
        store
            .insert_remote("node_c", "desk-c", &"cd".repeat(32))
            .unwrap();
        assert!(
            store
                .workspace_by_mission_and_host("mission_a", "node_c")
                .unwrap()
                .is_none()
        );
        // Only a ready row on a live node is already prepared.
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE mission_workspace SET state='cleanup_pending' WHERE id='ws_remote'",
                [],
            )
            .unwrap();
        assert!(
            store
                .workspace_by_mission_and_host("mission_a", "node_b")
                .unwrap()
                .is_none()
        );
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE mission_workspace SET state='ready' WHERE id='ws_remote'",
                [],
            )
            .unwrap();
        store.revoke("node_b").unwrap();
        assert!(
            store
                .workspace_by_mission_and_host("mission_a", "node_b")
                .unwrap()
                .is_none()
        );
    }

    /// One Mission with a ready row on the local node and one on a remote node
    /// must answer the remote row even when the local row is newer: a scoped
    /// lookup reads through whichever execution root actually holds the work.
    #[test]
    fn a_ready_remote_row_outranks_a_newer_local_row() {
        let store = NodeStore::open_ephemeral().unwrap();
        let now = now_stamp();
        store
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO execution_node(
                    node_id, display_name, role, os, arch, token_digest, paired_at, revoked_at, last_heartbeat
                 ) VALUES('host', '本机', 'local', NULL, NULL, NULL, ?1, NULL, NULL)",
                [&now],
            )
            .unwrap();
        store
            .insert_remote("node_b", "desk-b", &"ab".repeat(32))
            .unwrap();
        store
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TABLE mission_workspace (
                    id TEXT PRIMARY KEY NOT NULL, mission_id TEXT NOT NULL, camp_id TEXT NOT NULL,
                    execution_host_id TEXT NOT NULL, source_directory TEXT NOT NULL,
                    repository_root TEXT NOT NULL, git_common_dir TEXT NOT NULL,
                    worktree_path TEXT NOT NULL, working_directory TEXT NOT NULL, base_branch TEXT,
                    branch TEXT NOT NULL, base_sha TEXT NOT NULL, preparation_token TEXT NOT NULL,
                    preparation_kind TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(mission_id,execution_host_id,git_common_dir))",
            )
            .unwrap();
        let row = |id: &str, host: &str, sha: &str| WorkspaceRecord {
            id: id.into(),
            mission_id: "mission_a".into(),
            camp_id: "camp_a".into(),
            execution_host_id: host.into(),
            source_directory: "/srv/source".into(),
            repository_root: "/srv/source".into(),
            git_common_dir: format!("/srv/source/{id}"),
            worktree_path: format!("/srv/worktree-{id}"),
            branch: "loom/mission_a".into(),
            base_sha: sha.into(),
            owner_name: String::new(),
            owner_role: String::new(),
            last_heartbeat: None,
        };
        store
            .save_workspace(&row("ws_remote", "node_b", "remote"))
            .unwrap();
        store.save_workspace(&row("ws_local", "host", "local")).unwrap();
        // The local row is the newest, so only the remote preference can pick it.
        for (id, created_at) in [
            ("ws_remote", "2026-01-01T00:00:01Z"),
            ("ws_local", "2026-01-01T00:00:02Z"),
        ] {
            store
                .lock()
                .unwrap()
                .execute(
                    "UPDATE mission_workspace SET created_at=?1 WHERE id=?2",
                    rusqlite::params![created_at, id],
                )
                .unwrap();
        }
        let mission = store.workspace_by_mission("mission_a").unwrap().unwrap();
        assert_eq!(mission.id, "ws_remote");
        assert_eq!(mission.owner_role, "remote");
        assert_eq!(mission.base_sha, "remote");
        assert_eq!(
            store.workspace_by_camp("camp_a").unwrap().unwrap().id,
            "ws_remote"
        );
        // With no remote row left the local one answers exactly as before.
        store
            .lock()
            .unwrap()
            .execute("UPDATE mission_workspace SET state='cleanup_pending' WHERE id='ws_remote'", [])
            .unwrap();
        assert_eq!(
            store.workspace_by_mission("mission_a").unwrap().unwrap().id,
            "ws_local"
        );
        assert_eq!(
            store.workspace_by_camp("camp_a").unwrap().unwrap().id,
            "ws_local"
        );
    }

    #[test]
    fn installation_generation_roundtrips_without_signed_wrap_or_catalog_regression() {
        let store=NodeStore::open_ephemeral().unwrap();
        store.insert_remote("node_a","desk",&"ab".repeat(32)).unwrap();
        let report=|path:&str,generation:u64|CliRecord {
            adapter_kind:"codex-cli".into(),path:path.into(),version:None,path_present:true,
            reported_at:String::new(),installation_identity:Some(format!("sha256:{}","a".repeat(64))),
            installation_generation:Some(generation),
        };
        store.record_hello("node_a","linux","x86_64",&[report("/opt/codex",1)]).unwrap();
        assert_eq!(listed_cli(&store,"codex-cli").installation_generation,Some(1));
        store.record_hello("node_a","linux","x86_64",&[report("/opt/codex",1)]).unwrap();
        assert!(store.record_hello("node_a","linux","x86_64",&[report("/moved/codex",1)]).is_err());
        store.record_hello("node_a","linux","x86_64",&[report("/moved/codex",2)]).unwrap();
        assert_eq!(listed_cli(&store,"codex-cli").installation_generation,Some(2));
        assert!(store.record_hello("node_a","linux","x86_64",&[report("/moved/codex",3)]).is_err());
        for invalid in [0,1_u64<<53,u64::MAX] {
            assert!(store.record_hello("node_a","linux","x86_64",&[report("/moved/codex",invalid)]).is_err());
        }
        assert_eq!(listed_cli(&store,"codex-cli").installation_generation,Some(2));
        store.lock().unwrap().execute(
            "UPDATE execution_node_cli SET installation_generation=?1 WHERE node_id='node_a'",
            [1_i64<<53]).unwrap();
        assert!(store.list_nodes().is_err(),"out-of-wire-range retained SQL rows must fail closed");
    }

    #[test]
    fn a_missing_path_stays_last_seen_and_is_not_rewritten_to_path_missing() {
        let store = NodeStore::open_ephemeral().unwrap();
        store
            .insert_remote("node_a", "desk", &"ab".repeat(32))
            .unwrap();
        store
            .record_hello(
                "node_a",
                "linux",
                "x86_64",
                &[CliRecord {
                    adapter_kind: "codex-cli".into(),
                    path: "/opt/codex".into(),
                    version: Some("b3".into()),
                    path_present: true,
                    reported_at: String::new(),
                    installation_identity: None,
                    installation_generation: None,
                }],
            )
            .unwrap();
        let reported_at = listed_cli(&store, "codex-cli").reported_at;
        assert!(!reported_at.is_empty());
        std::thread::sleep(std::time::Duration::from_millis(20));

        store
            .record_hello("node_a", "linux", "x86_64", &[])
            .unwrap();
        let kept = listed_cli(&store, "codex-cli");
        assert_eq!(kept.path, "/opt/codex");
        assert!(kept.path_present);
        assert_ne!(kept.path, "path_missing");
        assert_eq!(kept.reported_at, reported_at);

        std::thread::sleep(std::time::Duration::from_millis(20));
        store
            .record_hello(
                "node_a",
                "linux",
                "x86_64",
                &[CliRecord {
                    adapter_kind: "codex-cli".into(),
                    path: "path_missing".into(),
                    version: None,
                    path_present: false,
                    reported_at: String::new(),
                    installation_identity: None,
                    installation_generation: None,
                }],
            )
            .unwrap();
        let kept = listed_cli(&store, "codex-cli");
        assert_eq!(kept.path, "/opt/codex");
        assert!(kept.path_present);
        assert_eq!(kept.reported_at, reported_at);

        store
            .record_hello(
                "node_a",
                "linux",
                "x86_64",
                &[CliRecord {
                    adapter_kind: "codex-cli".into(),
                    path: "/opt/codex".into(),
                    version: Some("b3".into()),
                    path_present: false,
                    reported_at: String::new(),
                    installation_identity: None,
                    installation_generation: None,
                }],
            )
            .unwrap();
        let missing = listed_cli(&store, "codex-cli");
        assert_eq!(missing.path, "/opt/codex");
        assert!(!missing.path_present);
        assert_ne!(missing.path, "path_missing");
    }

    #[test]
    fn offline_listing_keeps_the_last_cli_report_and_its_time() {
        let store = NodeStore::open_ephemeral().unwrap();
        store
            .insert_remote("node_a", "desk", &"ab".repeat(32))
            .unwrap();
        store
            .record_hello(
                "node_a",
                "linux",
                "x86_64",
                &[CliRecord {
                    adapter_kind: "codex-cli".into(),
                    path: "/node/bin/codex".into(),
                    version: Some("b3-codex 0".into()),
                    path_present: true,
                    reported_at: String::new(),
                    installation_identity: None,
                    installation_generation: None,
                }],
            )
            .unwrap();
        let before = listed_cli(&store, "codex-cli");
        let stale = (Utc::now() - chrono::Duration::seconds(120))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE execution_node SET last_heartbeat=?1 WHERE node_id='node_a'",
                [stale],
            )
            .unwrap();
        let listed = store.list_nodes().unwrap();
        let node = listed.iter().find(|node| node.node_id == "node_a").unwrap();
        assert_eq!(node.status, "offline");
        assert_eq!(node.clis.len(), 1);
        assert_eq!(node.clis[0].path, before.path);
        assert_eq!(node.clis[0].reported_at, before.reported_at);
        assert!(node.clis[0].path_present);
        assert_ne!(node.clis[0].path, "path_missing");
        let again = store.list_nodes().unwrap();
        let cli = &again
            .iter()
            .find(|node| node.node_id == "node_a")
            .unwrap()
            .clis[0];
        assert_eq!(cli.path, before.path);
        assert_eq!(cli.reported_at, before.reported_at);
        assert!(cli.path_present);
    }

    #[test]
    fn shim_credential_is_scoped_and_dies_with_the_attempt_or_the_node() {
        let store = NodeStore::open_ephemeral().unwrap();
        store
            .insert_remote("node_a", "desk", &"ab".repeat(32))
            .unwrap();
        store
            .begin_dispatch("run_1", 1, "node_a", "codex-cli")
            .unwrap();
        store
            .issue_run_credential(
                &"12".repeat(32),
                "run_1",
                1,
                "node_a",
                Some("member_b4"),
                Some("mission_b4"),
            )
            .unwrap();
        let grant = store.run_grant(&"12".repeat(32)).unwrap().unwrap();
        assert!(grant.usable);
        assert_eq!(grant.member_id.as_deref(), Some("member_b4"));
        assert_eq!(grant.mission_id.as_deref(), Some("mission_b4"));
        assert!(store.remote_digest_exists(&"ab".repeat(32)).unwrap());
        assert!(!store.remote_digest_exists(&"12".repeat(32)).unwrap());
        store.finish("run_1", 1, 1, 0).unwrap();
        assert!(!store.run_grant(&"12".repeat(32)).unwrap().unwrap().usable);

        store
            .begin_dispatch("run_2", 1, "node_a", "codex-cli")
            .unwrap();
        store
            .issue_run_credential(&"34".repeat(32), "run_2", 1, "node_a", None, None)
            .unwrap();
        assert!(store.run_grant(&"34".repeat(32)).unwrap().unwrap().usable);
        store.revoke("node_a").unwrap();
        assert!(!store.run_grant(&"34".repeat(32)).unwrap().unwrap().usable);
    }

    fn listed_cli(store: &NodeStore, kind: &str) -> CliRecord {
        store
            .list_nodes()
            .unwrap()
            .into_iter()
            .find_map(|node| node.clis.into_iter().find(|cli| cli.adapter_kind == kind))
            .unwrap_or_else(|| panic!("missing {kind}"))
    }

    #[test]
    fn reported_hostname_replaces_only_the_generated_name() {
        let store = NodeStore::open_ephemeral().unwrap();
        let node_id = "node_abcdef0123456789abcdef012345";
        store
            .insert_remote(node_id, "node-abcdef01", &"ab".repeat(32))
            .unwrap();
        assert!(
            store
                .adopt_reported_hostname(node_id, " desk-b.local ")
                .unwrap()
        );
        let named = store
            .list_nodes()
            .unwrap()
            .into_iter()
            .find(|node| node.node_id == node_id)
            .unwrap();
        assert_eq!(named.display_name, "desk-b.local");
        assert!(
            !store
                .adopt_reported_hostname(node_id, "other-host")
                .unwrap()
        );
        assert!(!store.adopt_reported_hostname(node_id, "bad host").unwrap());
        assert!(!store.adopt_reported_hostname(node_id, "").unwrap());
        assert_eq!(
            store
                .list_nodes()
                .unwrap()
                .into_iter()
                .find(|node| node.node_id == node_id)
                .unwrap()
                .display_name,
            "desk-b.local"
        );
    }
}
