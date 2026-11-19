//! Frozen per-Run capability bundle for one node dispatch.
//!
//! One row per Run is written next to the attempt-1 dispatch row and never
//! updated: the snapshot SQL installs a `BEFORE UPDATE` trigger, this module has
//! no UPDATE path, and a second freeze of the same run is refused. A later
//! catalog change can therefore only reach the *next* Run.
//!
//! Reads verify the packet before returning it: bounded sizes first, then the
//! packet's own run/attempt/owner/runtime/digest, then the protocol validator,
//! then the dispatch row it was frozen against. Missing means a pre-bundle
//! legacy run; nothing here refreezes, repairs or back-fills one.
//!
//! No credential, argv, token digest or per-run secret lives in this table.
//! `launch_digest` is a one-way hash of the caller's exact `(runtime, cwd, args)`
//! tuple; the tuple itself is never stored. Every failure is a
//! [`RunBundleStoreError`] whose text is a stable code only, so no SQL, JSON or
//! credential can reach a log through an error.

use anyhow::Result;
use loom_protocol::run_bundle::{
    BundleExpectation, MAX_BUNDLE_ENCODED_BYTES, RunBundleV1, bundle_digest,
    canonical_adapter_kind, validate,
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::NodeStore;

/// Serialized manifest cap. The SQL CHECK below repeats this literal; the
/// compile-time assertion keeps the two from drifting.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

/// Serialized packet cap, inherited from the wire limit so a value that was
/// accepted on the channel is always storable.
const MAX_BUNDLE_JSON_BYTES: usize = MAX_BUNDLE_ENCODED_BYTES;

const _: () = assert!(MAX_BUNDLE_JSON_BYTES == 1_572_864);
const _: () = assert!(MAX_MANIFEST_BYTES == 262_144);

/// Migration body for `node_run_bundle`.
///
/// * `first_attempt` is pinned to 1, so a re-dispatched attempt can never write
///   a second packet; the composite key also makes the attempt-1 dispatch row a
///   hard prerequisite.
/// * `PRIMARY KEY (run_id)` plus plain `INSERT` is write-once; there is no
///   `INSERT OR REPLACE` anywhere.
/// * The `BEFORE UPDATE` trigger rejects every mutation. There is deliberately
///   no `BEFORE DELETE` trigger, so `ON DELETE CASCADE` still removes the packet
///   with its dispatch row.
/// * `source_digest` carries the packet's own `sha256:<hex>`; `launch_digest` is
///   bare lowercase hex, the same shape as `node_run_credential.token_digest`.
pub const BUNDLE_SCHEMA_SQL: &str = r#"
CREATE TABLE node_run_bundle (
    run_id TEXT PRIMARY KEY CHECK(length(run_id) BETWEEN 1 AND 80),
    first_attempt INTEGER NOT NULL DEFAULT 1 CHECK(first_attempt = 1),
    node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 80),
    member_id TEXT NOT NULL CHECK(length(member_id) BETWEEN 1 AND 80),
    runtime TEXT NOT NULL CHECK(length(runtime) BETWEEN 1 AND 64),
    bundle_json TEXT NOT NULL CHECK(length(bundle_json) BETWEEN 2 AND 1572864),
    manifest_json TEXT NOT NULL CHECK(length(manifest_json) BETWEEN 2 AND 262144),
    source_digest TEXT NOT NULL CHECK(length(source_digest) = 71 AND source_digest LIKE 'sha256:%' AND substr(source_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    launch_digest TEXT NOT NULL CHECK(length(launch_digest) = 64 AND launch_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 20 AND 40),
    FOREIGN KEY (run_id, first_attempt) REFERENCES node_dispatch(run_id, attempt) ON DELETE CASCADE
);
CREATE TRIGGER node_run_bundle_immutable_update
BEFORE UPDATE ON node_run_bundle
BEGIN
    SELECT RAISE(ABORT, 'node_run_bundle is immutable');
END;
"#;

/// Stable, payload-free failure. `Display` prints the code and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunBundleStoreError {
    code: &'static str,
}

impl RunBundleStoreError {
    /// Stable wire/log code; never carries an id, digest, JSON or SQL text.
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for RunBundleStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.code)
    }
}

impl std::error::Error for RunBundleStoreError {}

/// One frozen packet as the dispatch path needs it.
#[derive(Clone)]
pub struct StoredRunBundle {
    pub bundle: RunBundleV1,
    pub manifest: serde_json::Value,
    pub node_id: String,
    pub member_id: String,
    pub runtime: String,
    pub launch_digest: String,
}

fn store_error(code: &'static str) -> anyhow::Error {
    anyhow::Error::new(RunBundleStoreError { code })
}

/// The launch identity of one `Start`: sha256 over the serialized
/// `[runtime, cwd, args]` tuple, as 64 lowercase hex.
///
/// The caller's exact tuple is hashed, without alias canonicalization, so a
/// retry that changes argv or working directory gets a different digest and is
/// refused by the caller's comparison. The argv itself is never persisted: the
/// packet that is stored is the reviewed, key-free bundle document.
pub fn launch_digest(runtime: &str, cwd: &str, args: &[String]) -> String {
    let payload = serde_json::json!([runtime, cwd, args]);
    // A `json!` array of strings always serializes.
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    format!("{:x}", Sha256::digest(&bytes))
}

/// Admission contract for the snapshot table: name, formats, size caps, the
/// dispatch foreign key, and a real `BEFORE UPDATE` refusal are all checked, not
/// just the table's presence.
pub fn bundle_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let compact = |sql: &str| sql.split_whitespace().collect::<String>();
    let table: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='node_run_bundle'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(table) = table else {
        return Ok(false);
    };
    let table = compact(&table);
    let tokens = [
        "run_id TEXT PRIMARY KEY",
        "first_attempt INTEGER NOT NULL DEFAULT 1",
        "CHECK(first_attempt = 1)",
        "node_id TEXT NOT NULL",
        "member_id TEXT NOT NULL",
        "runtime TEXT NOT NULL",
        "bundle_json TEXT NOT NULL CHECK(length(bundle_json) BETWEEN 2 AND 1572864)",
        "manifest_json TEXT NOT NULL CHECK(length(manifest_json) BETWEEN 2 AND 262144)",
        "length(source_digest) = 71",
        "source_digest LIKE 'sha256:%'",
        "substr(source_digest, 8) NOT GLOB '*[^0-9a-f]*'",
        "length(launch_digest) = 64",
        "launch_digest NOT GLOB '*[^0-9a-f]*'",
        "created_at TEXT NOT NULL",
        "FOREIGN KEY (run_id, first_attempt) REFERENCES node_dispatch(run_id, attempt) ON DELETE CASCADE",
    ];
    if !tokens.iter().all(|token| table.contains(&compact(token))) {
        return Ok(false);
    }
    let trigger: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger'
                 AND name='node_run_bundle_immutable_update'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(trigger) = trigger else {
        return Ok(false);
    };
    // The refusal message is checked before whitespace compaction, which would
    // join its words.
    let names_the_refusal = trigger.contains("node_run_bundle is immutable");
    let trigger = compact(&trigger);
    let refuses_update = names_the_refusal
        && trigger.contains(&compact("BEFORE UPDATE ON node_run_bundle"))
        && trigger.contains(&compact("RAISE(ABORT"));
    // A delete guard would break the FK cascade the snapshot relies on.
    let blocks_delete: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger'
             AND tbl_name='node_run_bundle' AND upper(sql) LIKE '%BEFORE DELETE%')",
        [],
        |row| row.get(0),
    )?;
    Ok(refuses_update && !blocks_delete)
}

struct StoredRow {
    bundle_json: String,
    manifest_json: String,
    node_id: String,
    member_id: String,
    runtime: String,
    source_digest: String,
    launch_digest: String,
    first_attempt: i64,
}

impl NodeStore {
    /// Freeze this Run's capability packet exactly once.
    ///
    /// Everything that could be wrong is checked before the first write: the
    /// caller's metadata must agree with the packet's own identity (run,
    /// attempt 1, owner `agent_id == member_id`, runtime), the packet must pass
    /// the protocol validator and its own digest, the manifest must be a bounded
    /// object, and the attempt-1 dispatch row must name this node and this
    /// runtime. Metadata never overrides the packet: it can only disagree.
    pub fn freeze_run_bundle(
        &self,
        run_id: &str,
        node_id: &str,
        member_id: &str,
        runtime: &str,
        launch_digest: &str,
        bundle: &RunBundleV1,
        manifest: &serde_json::Value,
    ) -> Result<()> {
        if !identifier(run_id, 80) || !identifier(node_id, 80) || !identifier(member_id, 80) {
            return Err(store_error("run_bundle_invalid_identity"));
        }
        if runtime.len() > 64 || runtime.is_empty() || !lower_hex(launch_digest, 64) {
            return Err(store_error("run_bundle_invalid_identity"));
        }
        let Some(canonical_runtime) = canonical_adapter_kind(runtime) else {
            return Err(store_error("run_bundle_invalid_identity"));
        };
        // The packet owns its identity: this attempt, this run, this owner, this
        // runtime. A caller's label cannot rewrite any of them.
        if bundle.run_id != run_id
            || bundle.attempt != 1
            || bundle.agent_id != member_id
            || canonical_adapter_kind(&bundle.adapter_kind) != Some(canonical_runtime)
        {
            return Err(store_error("run_bundle_invalid_identity"));
        }
        validate(
            bundle,
            &BundleExpectation {
                run_id,
                attempt: 1,
                adapter_kind: runtime,
            },
        )
        .map_err(|_| store_error("run_bundle_invalid_payload"))?;
        if bundle_digest(bundle).ok().as_deref() != Some(bundle.digest.as_str()) {
            return Err(store_error("run_bundle_invalid_payload"));
        }
        if manifest.as_object().is_none() {
            return Err(store_error("run_bundle_invalid_payload"));
        }
        let bundle_json =
            serde_json::to_string(bundle).map_err(|_| store_error("run_bundle_invalid_payload"))?;
        let manifest_json = serde_json::to_string(manifest)
            .map_err(|_| store_error("run_bundle_invalid_payload"))?;
        if bundle_json.len() > MAX_BUNDLE_JSON_BYTES || manifest_json.len() > MAX_MANIFEST_BYTES {
            return Err(store_error("run_bundle_invalid_payload"));
        }

        let now = super::now_stamp();
        let mut guard = self.lock()?;
        let connection = guard
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| store_error("run_bundle_store_failed"))?;
        let dispatch = dispatch_for_attempt_one(&connection, run_id)?;
        let Some((dispatch_node, dispatch_runtime)) = dispatch else {
            return Err(store_error("run_bundle_dispatch_mismatch"));
        };
        // The dispatch row, the caller's label and the packet must all
        // canonicalize to the same runtime; the stored value is canonical.
        let dispatch_canonical = canonical_adapter_kind(&dispatch_runtime);
        if dispatch_node != node_id
            || dispatch_canonical != Some(canonical_runtime)
            || canonical_adapter_kind(runtime) != dispatch_canonical
            || canonical_adapter_kind(&bundle.adapter_kind) != dispatch_canonical
        {
            return Err(store_error("run_bundle_dispatch_mismatch"));
        }
        if bundle_exists(&connection, run_id)? {
            return Err(store_error("run_bundle_already_frozen"));
        }
        let inserted = connection.execute(
            "INSERT INTO node_run_bundle(
                run_id, first_attempt, node_id, member_id, runtime,
                bundle_json, manifest_json, source_digest, launch_digest, created_at
             ) VALUES(?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                run_id,
                node_id,
                member_id,
                canonical_runtime,
                bundle_json,
                manifest_json,
                bundle.digest,
                launch_digest,
                now
            ],
        );
        match inserted {
            Ok(1) => connection
                .commit()
                .map_err(|_| store_error("run_bundle_store_failed")),
            // A concurrent freeze won the primary key; the run keeps one packet.
            Ok(_) => Err(store_error("run_bundle_store_failed")),
            Err(_) => Err(if bundle_exists(&connection, run_id)? {
                store_error("run_bundle_already_frozen")
            } else {
                store_error("run_bundle_store_failed")
            }),
        }
    }

    /// The packet this Run froze, or `None` for a pre-bundle legacy run.
    ///
    /// `None` is not a repair instruction: there is no refreeze path and no
    /// synthesised packet. A stored packet is re-verified (sizes, identity,
    /// owner, runtime, digest, protocol contract, dispatch row) before return,
    /// so a tampered row is refused instead of dispatched.
    pub fn run_bundle(&self, run_id: &str) -> Result<Option<StoredRunBundle>> {
        if !identifier(run_id, 80) {
            return Err(store_error("run_bundle_invalid_identity"));
        }
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT bundle_json, manifest_json, node_id, member_id, runtime,
                        source_digest, launch_digest, first_attempt
                   FROM node_run_bundle
                  WHERE run_id = ?1",
                [run_id],
                |row| {
                    Ok(StoredRow {
                        bundle_json: row.get(0)?,
                        manifest_json: row.get(1)?,
                        node_id: row.get(2)?,
                        member_id: row.get(3)?,
                        runtime: row.get(4)?,
                        source_digest: row.get(5)?,
                        launch_digest: row.get(6)?,
                        first_attempt: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(|_| store_error("run_bundle_read_failed"))?;
        let Some(row) = row else {
            return Ok(None);
        };
        // Bounded before parsing, so a damaged row cannot become memory.
        if row.first_attempt != 1
            || row.bundle_json.len() > MAX_BUNDLE_JSON_BYTES
            || row.manifest_json.len() > MAX_MANIFEST_BYTES
            || !lower_hex(&row.launch_digest, 64)
        {
            return Err(store_error("run_bundle_read_failed"));
        }
        let bundle: RunBundleV1 = serde_json::from_str(&row.bundle_json)
            .map_err(|_| store_error("run_bundle_read_failed"))?;
        let manifest: serde_json::Value = serde_json::from_str(&row.manifest_json)
            .map_err(|_| store_error("run_bundle_read_failed"))?;
        if manifest.as_object().is_none() {
            return Err(store_error("run_bundle_read_failed"));
        }
        let Some(canonical_runtime) = canonical_adapter_kind(&row.runtime) else {
            return Err(store_error("run_bundle_read_failed"));
        };
        // Stored identity and the packet's own identity must still agree,
        // including the owner assertion `agent_id == member_id`.
        if bundle.run_id != run_id
            || bundle.attempt != 1
            || bundle.agent_id != row.member_id
            || canonical_adapter_kind(&bundle.adapter_kind) != Some(canonical_runtime)
            || bundle.digest != row.source_digest
            || bundle_digest(&bundle).ok().as_deref() != Some(bundle.digest.as_str())
        {
            return Err(store_error("run_bundle_read_failed"));
        }
        validate(
            &bundle,
            &BundleExpectation {
                run_id,
                attempt: 1,
                adapter_kind: &row.runtime,
            },
        )
        .map_err(|_| store_error("run_bundle_read_failed"))?;
        // The dispatch row this packet was frozen against must still agree. A
        // deleted dispatch row takes the packet with it, so a surviving packet
        // without its dispatch row is corrupt, not legacy.
        let Some((dispatch_node, dispatch_runtime)) =
            dispatch_for_attempt_one(&connection, run_id)?
        else {
            return Err(store_error("run_bundle_dispatch_mismatch"));
        };
        if dispatch_node != row.node_id
            || canonical_adapter_kind(&dispatch_runtime) != Some(canonical_runtime)
        {
            return Err(store_error("run_bundle_dispatch_mismatch"));
        }
        Ok(Some(StoredRunBundle {
            bundle,
            manifest,
            node_id: row.node_id,
            member_id: row.member_id,
            runtime: row.runtime,
            launch_digest: row.launch_digest,
        }))
    }
}

fn dispatch_for_attempt_one(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<(String, String)>> {
    connection
        .query_row(
            "SELECT node_id, runtime FROM node_dispatch WHERE run_id = ?1 AND attempt = 1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| store_error("run_bundle_store_failed"))
}

fn bundle_exists(connection: &Connection, run_id: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM node_run_bundle WHERE run_id = ?1)",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|_| store_error("run_bundle_store_failed"))
}

fn identifier(value: &str, maximum: usize) -> bool {
    (1..=maximum).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    //! Owner: the frozen-packet contract itself (write-once, identity and owner
    //! verification, bounded reads, trigger and cascade semantics) and the
    //! schema admission gate.
    //!
    //! Admission (docs/development/testing.md): the contract owner is this
    //! module; before it existed no packet could be stored or read, so every
    //! case below is an independent failure (freeze-once, owner/identity drift,
    //! digest tampering, immutability, cascade, admission tokens). The existing
    //! `execution_node::tests::*` owners cover dispatch and shim-credential
    //! lifecycle and cannot express a frozen packet; the cheapest owner is an
    //! in-memory SQLite store with no file, process or catalog. The schema is
    //! built here explicitly instead of through `NodeStore::open_ephemeral`, so
    //! this owner neither depends on nor duplicates the supervisor's migration
    //! wiring.

    use super::super::{NodeStore, SCHEMA_SQL, SHIM_SCHEMA_SQL};
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use loom_protocol::run_bundle::{
        BundleArtifact, BundleFile, RUN_BUNDLE_VERSION, bundle_id_for,
    };
    use std::sync::{Arc, Mutex};

    fn store() -> NodeStore {
        let connection = Connection::open_in_memory().expect("in-memory node store");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("foreign keys");
        connection
            .execute_batch(SCHEMA_SQL)
            .expect("dispatch schema");
        connection
            .execute_batch(SHIM_SCHEMA_SQL)
            .expect("shim schema");
        connection
            .execute_batch(BUNDLE_SCHEMA_SQL)
            .expect("bundle schema");
        NodeStore {
            connection: Arc::new(Mutex::new(connection)),
        }
    }

    fn packet(run_id: &str, attempt: u32) -> RunBundleV1 {
        let mut bundle = RunBundleV1 {
            version: RUN_BUNDLE_VERSION,
            bundle_id: bundle_id_for(run_id, attempt),
            run_id: run_id.to_string(),
            attempt,
            agent_id: "agent_1".to_string(),
            adapter_kind: "claude-code".to_string(),
            selection_revision: "rev_1".to_string(),
            source_skill_root: None,
            digest: String::new(),
            files: vec![BundleFile {
                artifact: BundleArtifact::BootstrapPrompt,
                label: "bootstrap".to_string(),
                path: "bootstrap.txt".to_string(),
                bytes: 2,
                content: STANDARD.encode(b"hi"),
            }],
        };
        bundle.digest = bundle_digest(&bundle).expect("digest");
        bundle
    }

    fn error_code(error: anyhow::Error) -> &'static str {
        error
            .downcast_ref::<RunBundleStoreError>()
            .expect("typed store error")
            .code()
    }

    #[test]
    fn frozen_packet_is_write_once_verified_and_cascades_with_its_dispatch() {
        let store = store();
        store
            .insert_remote("node_a", "desk", &"ab".repeat(32))
            .unwrap();
        store
            .begin_dispatch("run_1", 1, "node_a", "claude-code-cli")
            .unwrap();

        let bundle = packet("run_1", 1);
        let manifest = serde_json::json!({"kind": "b7", "files": 1});
        let argv = vec!["exec".to_string(), "--mcp-config".to_string()];
        let digest = launch_digest("claude-code-cli", "/work", &argv);
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, launch_digest("claude-code-cli", "/work", &argv));
        assert_ne!(digest, launch_digest("claude-code-cli", "/other", &argv));
        store
            .freeze_run_bundle(
                "run_1",
                "node_a",
                "agent_1",
                "claude-code-cli",
                &digest,
                &bundle,
                &manifest,
            )
            .expect("freeze");

        let frozen = store.run_bundle("run_1").unwrap().expect("frozen packet");
        assert_eq!(frozen.bundle, bundle);
        assert_eq!(frozen.manifest, manifest);
        assert_eq!(frozen.node_id, "node_a");
        assert_eq!(frozen.member_id, "agent_1");
        // The owner assertion holds on the way out as well as on the way in.
        assert_eq!(frozen.bundle.agent_id, frozen.member_id);
        assert_eq!(frozen.runtime, "claude-code");
        assert_eq!(frozen.launch_digest, digest);

        // A retry attempt reads the same packet; nothing refreezes.
        store.interrupt("run_1", 1).unwrap();
        match store.open_next_attempt("run_1").unwrap() {
            super::super::NextAttempt::Opened { attempt, .. } => assert_eq!(attempt, 2),
            other => panic!("expected a second attempt, got {other:?}"),
        }
        let retried = store.run_bundle("run_1").unwrap().expect("still frozen");
        assert_eq!(retried.bundle, frozen.bundle);
        assert_eq!(retried.manifest, frozen.manifest);
        assert_eq!(retried.launch_digest, frozen.launch_digest);

        // A changed source selection cannot reach a Run that already froze one.
        let mut changed = packet("run_1", 1);
        changed.selection_revision = "rev_2".to_string();
        changed.digest = bundle_digest(&changed).unwrap();
        assert_ne!(changed.digest, bundle.digest);
        let refused = store
            .freeze_run_bundle(
                "run_1",
                "node_a",
                "agent_1",
                "claude-code-cli",
                &digest,
                &changed,
                &manifest,
            )
            .expect_err("a second freeze was accepted");
        assert_eq!(error_code(refused), "run_bundle_already_frozen");
        assert_eq!(
            store.run_bundle("run_1").unwrap().unwrap().bundle,
            frozen.bundle
        );

        // Identity and owner drift is refused before anything is written.
        store
            .begin_dispatch("run_2", 1, "node_a", "claude-code-cli")
            .unwrap();
        store
            .insert_remote("node_b", "desk-b", &"cd".repeat(32))
            .unwrap();
        let base = packet("run_2", 1);
        let mut other_run = packet("run_other", 1);
        other_run.digest = bundle_digest(&other_run).unwrap();
        let attempt_two = packet("run_2", 2);
        let mut owner_drift = base.clone();
        owner_drift.agent_id = "agent_2".to_string();
        owner_drift.digest = bundle_digest(&owner_drift).unwrap();
        let mut tampered = base.clone();
        tampered.digest = format!("sha256:{}", "0".repeat(64));
        let array_manifest = serde_json::json!([1, 2]);
        let cases: Vec<(String, String, String, &str, RunBundleV1, serde_json::Value)> = vec![
            (
                "run_2".to_string(),
                "node_a".to_string(),
                "agent_1".to_string(),
                &digest,
                other_run,
                manifest.clone(),
            ),
            (
                "run_2".to_string(),
                "node_a".to_string(),
                "agent_1".to_string(),
                &digest,
                attempt_two,
                manifest.clone(),
            ),
            (
                "run_2".to_string(),
                "node_a".to_string(),
                "agent_1".to_string(),
                &digest,
                owner_drift,
                manifest.clone(),
            ),
            (
                "run_2".to_string(),
                "node_a".to_string(),
                "agent_1".to_string(),
                &digest,
                tampered,
                manifest.clone(),
            ),
            (
                "run_2".to_string(),
                "node_a".to_string(),
                "agent_1".to_string(),
                "abc",
                base.clone(),
                manifest.clone(),
            ),
            (
                "run_2".to_string(),
                "node_a".to_string(),
                "agent_1".to_string(),
                &digest,
                base.clone(),
                array_manifest,
            ),
            (
                "run_2".to_string(),
                "node_b".to_string(),
                "agent_1".to_string(),
                &digest,
                base.clone(),
                manifest.clone(),
            ),
            (
                "run_2".to_string(),
                "node_a".to_string(),
                "agent_1".to_string(),
                &digest,
                base.clone(),
                manifest.clone(),
            ),
        ];
        let expected = [
            "run_bundle_invalid_identity",
            "run_bundle_invalid_identity",
            "run_bundle_invalid_identity",
            "run_bundle_invalid_payload",
            "run_bundle_invalid_identity",
            "run_bundle_invalid_payload",
            "run_bundle_dispatch_mismatch",
            // The last case is the healthy control and must succeed.
            "",
        ];
        for ((run_id, node_id, member_id, launch, bundle, manifest), expected) in
            cases.into_iter().zip(expected)
        {
            let result = store.freeze_run_bundle(
                &run_id,
                &node_id,
                &member_id,
                "claude-code-cli",
                launch,
                &bundle,
                &manifest,
            );
            if expected.is_empty() {
                result.expect("a valid packet must freeze");
            } else {
                assert_eq!(error_code(result.expect_err("freeze accepted")), expected);
            }
        }
        let stored: i64 = store
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM node_run_bundle", [], |row| row.get(0))
            .unwrap();
        // One packet for run_1 and the healthy control for run_2; every rejected
        // case above wrote nothing.
        assert_eq!(stored, 2);
        assert_eq!(
            store.run_bundle("run_2").unwrap().unwrap().bundle.digest,
            base.digest
        );

        // The primary key refuses a second row even by direct SQL, and the
        // trigger refuses every update.
        let duplicate = store.lock().unwrap().execute(
            "INSERT INTO node_run_bundle(
                run_id, first_attempt, node_id, member_id, runtime,
                bundle_json, manifest_json, source_digest, launch_digest, created_at
             ) VALUES('run_1', 1, 'node_a', 'agent_1', 'claude-code', '{}', '{}', ?1, ?2,
                      '2026-01-01T00:00:00.000Z')",
            params![frozen.bundle.digest, digest],
        );
        assert!(duplicate.is_err(), "a duplicate row was accepted");
        let update = store.lock().unwrap().execute(
            "UPDATE node_run_bundle SET runtime='codex-cli' WHERE run_id='run_1'",
            [],
        );
        let update_error = update.expect_err("the snapshot accepted an update");
        assert!(
            update_error.to_string().contains("immutable"),
            "unexpected update error: {update_error}"
        );
        assert_eq!(
            store.run_bundle("run_1").unwrap().unwrap().runtime,
            "claude-code"
        );

        // Deleting the dispatch row removes the packet: the snapshot never
        // outlives the attempt it belongs to.
        store
            .lock()
            .unwrap()
            .execute("DELETE FROM node_dispatch WHERE run_id='run_1'", [])
            .unwrap();
        assert!(store.run_bundle("run_1").unwrap().is_none());
        let orphan: i64 = store
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM node_run_bundle WHERE run_id='run_1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0);

        // A run that never froze one is legacy, not a repair instruction.
        assert!(store.run_bundle("run_never").unwrap().is_none());
    }

    #[test]
    fn bundle_schema_admission_checks_formats_caps_and_the_update_trigger() {
        let connection = Connection::open_in_memory().unwrap();
        assert!(!bundle_schema_matches(&connection).unwrap());
        connection.execute_batch(BUNDLE_SCHEMA_SQL).unwrap();
        assert!(bundle_schema_matches(&connection).unwrap());

        // Without the trigger the row is mutable, so the contract is absent.
        connection
            .execute_batch("DROP TRIGGER node_run_bundle_immutable_update")
            .unwrap();
        assert!(!bundle_schema_matches(&connection).unwrap());

        // A weakened digest format is refused, not tolerated.
        let weak_digest = Connection::open_in_memory().unwrap();
        weak_digest
            .execute_batch(&BUNDLE_SCHEMA_SQL.replacen(
                "CHECK(length(launch_digest) = 64 AND launch_digest NOT GLOB '*[^0-9a-f]*')",
                "CHECK(1 = 1)",
                1,
            ))
            .unwrap();
        assert!(!bundle_schema_matches(&weak_digest).unwrap());

        // A raised size cap is refused.
        let weak_cap = Connection::open_in_memory().unwrap();
        weak_cap
            .execute_batch(&BUNDLE_SCHEMA_SQL.replacen(
                "BETWEEN 2 AND 1572864",
                "BETWEEN 2 AND 999999999",
                1,
            ))
            .unwrap();
        assert!(!bundle_schema_matches(&weak_cap).unwrap());

        // Without the dispatch foreign key the cascade contract is absent.
        let no_fk = Connection::open_in_memory().unwrap();
        no_fk
            .execute_batch(
                &BUNDLE_SCHEMA_SQL.replacen(
                    "FOREIGN KEY (run_id, first_attempt) REFERENCES node_dispatch(run_id, attempt) ON DELETE CASCADE",
                    "CHECK(1 = 1)",
                    1,
                ),
            )
            .unwrap();
        assert!(!bundle_schema_matches(&no_fk).unwrap());
    }
}
