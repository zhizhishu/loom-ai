//! The immutable local bytes behind one registered LOOM artifact.
//!
//! Registration copies the exact bytes it hashed into the Managed Blob store before it commits
//! the artifact row, and this module owns the mapping between the two. A verification therefore
//! re-reads the bytes that were registered instead of whatever the workspace file holds now, so a
//! file rewritten after the fact cannot rewrite the evidence an earlier verdict was based on.
//!
//! The Blob is not held by an explicit release call: `managed_blob` discovers reference columns
//! from the schema, so `blob_id` here keeps the Blob out of GC and `ON DELETE CASCADE` releases
//! this row together with its artifact.
//!
//! This module owns its schema statement and hands it to Core's migration; it never runs a
//! migration of its own.
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::db::Database;
use crate::managed_blob::{MAX_BLOB_BYTES, ManagedBlobStore};

/// Applied by Core's unpublished schema 232 (`schema 182`) next to `db_loom`'s own LOOM
/// statements. `parent_scope` is what makes this table evidence rather than a pointer: a row may
/// only exist for a local artifact whose recorded digest and size it repeats.
pub(crate) const MIGRATION_SQL: &str = r#"
CREATE TABLE loom_artifact_snapshot (
    artifact_id TEXT PRIMARY KEY REFERENCES loom_artifact(artifact_id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL REFERENCES managed_blob(id),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    created_at TEXT NOT NULL
);
CREATE TRIGGER loom_artifact_snapshot_immutable
    BEFORE UPDATE ON loom_artifact_snapshot
    BEGIN SELECT RAISE(ABORT, 'a LOOM artifact snapshot is immutable'); END;
CREATE TRIGGER loom_artifact_snapshot_no_replace
    BEFORE INSERT ON loom_artifact_snapshot
    WHEN EXISTS(SELECT 1 FROM loom_artifact_snapshot
      WHERE artifact_id=NEW.artifact_id OR rowid=NEW.rowid)
    BEGIN SELECT RAISE(ABORT, 'a LOOM artifact snapshot is immutable'); END;
CREATE TRIGGER loom_artifact_snapshot_no_direct_delete
    BEFORE DELETE ON loom_artifact_snapshot
    WHEN EXISTS(SELECT 1 FROM loom_artifact WHERE artifact_id=OLD.artifact_id)
    BEGIN SELECT RAISE(ABORT, 'a LOOM artifact snapshot is immutable'); END;
CREATE TRIGGER loom_artifact_snapshot_parent_scope
    BEFORE INSERT ON loom_artifact_snapshot
    WHEN NOT EXISTS(SELECT 1 FROM loom_artifact WHERE artifact_id=NEW.artifact_id
      AND origin_key='local' AND sha256=NEW.sha256 AND size_bytes=NEW.size_bytes)
    BEGIN SELECT RAISE(ABORT, 'a LOOM artifact snapshot requires its local artifact'); END;
"#;

/// Core's data directory, the root the Managed Blob store lives under.
///
/// `artifact_register` and the verification path only ever hold the open database, and the data
/// directory is the directory that database sits in. A database with no directory on disk has no
/// Blob root either, so this is refused rather than defaulted to the process working directory.
pub(crate) fn data_directory(database: &Database) -> Result<PathBuf> {
    database
        .path()
        .parent()
        .map(Path::to_path_buf)
        .context(
            "LOOM artifact snapshots live under Core's data directory and this database has none",
        )
}

/// Read the bytes to archive from an already resolved path.
///
/// The handle refuses to follow a link at any component, and the read is bounded so a file that is
/// being appended to cannot grow without limit while it is copied. The length the same handle
/// reports afterwards must be the length that was read: a file that was truncated or appended to
/// mid-read is refused instead of being archived with a digest over bytes nobody saw.
pub(crate) fn read_artifact_bytes(path: &Path) -> Result<(Vec<u8>, String, i64)> {
    let mut file = crate::local_attachment_snapshot::open_resolved_file_without_following(path)
        .with_context(|| format!("LOOM artifact {} is not readable", path.to_string_lossy()))?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BLOB_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("LOOM artifact {} is not readable", path.to_string_lossy()))?;
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        anyhow::bail!(
            "LOOM artifact {} exceeds the {MAX_BLOB_BYTES} byte Managed Blob limit",
            path.to_string_lossy()
        );
    }
    let size_bytes = bytes.len() as i64;
    let declared_len = file
        .metadata()
        .with_context(|| format!("LOOM artifact {} cannot be sized", path.to_string_lossy()))?
        .len();
    if declared_len != bytes.len() as u64 {
        anyhow::bail!(
            "LOOM artifact {} changed while it was being read ({} of {declared_len} bytes)",
            path.to_string_lossy(),
            bytes.len()
        );
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok((bytes, sha256, size_bytes))
}

/// Record the archived bytes of an artifact, inside the transaction that owns its artifact row.
///
/// Recording is idempotent for the same digest — a replay registers the same content-addressed
/// Blob — and a row that already points somewhere else is left alone rather than rewritten.
pub(crate) fn record(
    connection: &Connection,
    artifact_id: &str,
    blob_id: &str,
    sha256: &str,
    size_bytes: i64,
) -> Result<()> {
    let existing: Option<(String, String, i64)> = connection
        .query_row(
            "SELECT blob_id, sha256, size_bytes FROM loom_artifact_snapshot WHERE artifact_id=?1",
            [artifact_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((stored_blob_id, stored_sha256, stored_size)) = existing {
        anyhow::ensure!(
            stored_blob_id == blob_id && stored_sha256 == sha256 && stored_size == size_bytes,
            "LOOM artifact {artifact_id} already archived different bytes"
        );
        return Ok(());
    }
    connection.execute(
        "INSERT INTO loom_artifact_snapshot(artifact_id,blob_id,sha256,size_bytes,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        params![
            artifact_id,
            blob_id,
            sha256,
            size_bytes,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

/// The bytes a verification judges, when this artifact's registration archived them.
///
/// `Ok(None)` means this artifact predates archiving and the caller keeps its historical read of
/// the workspace file. Anything else is a hard failure: a row that names a missing or unreadable
/// Blob, or one whose digest, size or parent artifact no longer agree, must never be answered by
/// silently falling back to whatever the workspace holds now.
pub(crate) fn read_verified_bytes(
    connection: &Connection,
    data_dir: &Path,
    plan_id: &str,
    artifact_id: &str,
) -> Result<Option<Vec<u8>>> {
    let stored: Option<(String, String, i64)> = connection
        .query_row(
            "SELECT blob_id, sha256, size_bytes FROM loom_artifact_snapshot WHERE artifact_id=?1",
            [artifact_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)?)),
        )
        .optional()?;
    let Some((blob_id, sha256, size_bytes)) = stored else {
        return Ok(None);
    };
    let parent: Option<(String, String, String, i64)> = connection
        .query_row(
            "SELECT plan_id, origin_key, sha256, size_bytes FROM loom_artifact WHERE artifact_id=?1",
            [artifact_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((artifact_plan_id, origin_key, artifact_sha256, artifact_size)) = parent else {
        anyhow::bail!("LOOM artifact snapshot {artifact_id} has no artifact");
    };
    if artifact_plan_id != plan_id {
        anyhow::bail!("LOOM artifact snapshot {artifact_id} does not belong to this plan");
    }
    if origin_key != "local" {
        anyhow::bail!("LOOM artifact snapshot {artifact_id} is not local evidence");
    }
    if artifact_sha256 != sha256 || artifact_size != size_bytes {
        anyhow::bail!("LOOM artifact snapshot {artifact_id} does not match its artifact");
    }
    let bytes = ManagedBlobStore::new(data_dir)
        .read_bytes_connection(connection, &blob_id)
        .with_context(|| format!("LOOM artifact snapshot {artifact_id} bytes cannot be read"))?;
    if bytes.len() as i64 != size_bytes
        || format!("{:x}", Sha256::digest(&bytes)) != sha256
    {
        anyhow::bail!("LOOM artifact snapshot {artifact_id} content does not match its record");
    }
    Ok(Some(bytes))
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    /// The schema statement is what Core's migration will execute; the triggers are the part that
    /// makes the table evidence, so each of them is exercised here instead of being trusted.
    fn schema() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE loom_artifact (
                     artifact_id TEXT PRIMARY KEY,
                     plan_id TEXT NOT NULL,
                     origin_key TEXT NOT NULL DEFAULT 'local',
                     relative_path TEXT NOT NULL,
                     sha256 TEXT NOT NULL,
                     size_bytes INTEGER NOT NULL
                 );
                 CREATE TABLE managed_blob (id TEXT PRIMARY KEY);",
            )
            .unwrap();
        connection.execute_batch(MIGRATION_SQL).unwrap();
        connection
            .execute_batch(
                "INSERT INTO managed_blob(id) VALUES('blob-a');
                 INSERT INTO loom_artifact(artifact_id,plan_id,relative_path,sha256,size_bytes)
                 VALUES('artifact-a','plan-a','a.md',printf('%064d',0),4);",
            )
            .unwrap();
        connection
    }

    #[test]
    fn a_snapshot_requires_its_local_artifact_digest_and_size() {
        let connection = schema();
        let rejected = connection.execute(
            "INSERT INTO loom_artifact_snapshot(artifact_id,blob_id,sha256,size_bytes,created_at)
             VALUES('artifact-a','blob-a',printf('%064d',1),4,'2026-01-01')",
            [],
        );
        assert!(
            rejected.is_err(),
            "assertion a snapshot cannot record a digest its artifact does not carry"
        );
        connection
            .execute(
                "INSERT INTO loom_artifact_snapshot(artifact_id,blob_id,sha256,size_bytes,created_at)
                 VALUES('artifact-a','blob-a',printf('%064d',0),4,'2026-01-01')",
                [],
            )
            .unwrap();
        let rewrote = connection.execute(
            "UPDATE loom_artifact_snapshot SET sha256=printf('%064d',2) WHERE artifact_id='artifact-a'",
            [],
        );
        assert!(rewrote.is_err(), "assertion a snapshot stays immutable");
        let replaced = connection.execute(
            "INSERT INTO loom_artifact_snapshot(artifact_id,blob_id,sha256,size_bytes,created_at)
             VALUES('artifact-a','blob-a',printf('%064d',0),4,'2026-01-02')",
            [],
        );
        assert!(
            replaced.is_err(),
            "assertion a snapshot cannot be replaced by a second insert"
        );
        connection.execute_batch(
            "INSERT INTO managed_blob(id) VALUES('blob-b');
             INSERT INTO loom_artifact(artifact_id,plan_id,relative_path,sha256,size_bytes)
             VALUES('artifact-b','plan-a','b.md',printf('%064d',0),4);"
        ).unwrap();
        let original: (i64, String, String) = connection.query_row(
            "SELECT rowid,blob_id,created_at FROM loom_artifact_snapshot WHERE artifact_id='artifact-a'",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        for sql in [
            "INSERT OR REPLACE INTO loom_artifact_snapshot(artifact_id,blob_id,sha256,size_bytes,created_at)
             VALUES('artifact-a','blob-b',printf('%064d',0),4,'replacement')",
            "INSERT OR REPLACE INTO loom_artifact_snapshot(rowid,artifact_id,blob_id,sha256,size_bytes,created_at)
             SELECT rowid,'artifact-b','blob-b',printf('%064d',0),4,'replacement'
             FROM loom_artifact_snapshot WHERE artifact_id='artifact-a'",
            "UPDATE OR REPLACE loom_artifact_snapshot SET blob_id='blob-b' WHERE artifact_id='artifact-a'",
        ] {
            assert!(connection.execute(sql, []).is_err(), "replacement must fail: {sql}");
            assert_eq!(connection.query_row(
                "SELECT rowid,blob_id,created_at FROM loom_artifact_snapshot WHERE artifact_id='artifact-a'",
                [], |row| Ok((row.get::<_, i64>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?)),
            ).unwrap(), original, "a refused replacement must leave the original snapshot intact");
            assert_eq!(connection.query_row(
                "SELECT count(*) FROM loom_artifact_snapshot", [], |row| row.get::<_, i64>(0),
            ).unwrap(), 1);
        }
        let deleted = connection.execute(
            "DELETE FROM loom_artifact_snapshot WHERE artifact_id='artifact-a'",
            [],
        );
        assert!(
            deleted.is_err(),
            "assertion a snapshot cannot be deleted while its artifact exists"
        );
    }
}
