//! Private Core archive of complete, bounded Workspace RPC results.
//! The request journal is the only receipt registry. No caller-supplied path,
//! Node hash, or remote absolute filename is used as local filesystem authority.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use loom_protocol::workspace_rpc::*;
use rovai_private_storage::{
    create_private_new_file, open_private_read_file, prepare_private_directory,
    publish_private_new_temporary_file,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::Path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceArchiveKind {
    Read,
    Stdout,
    Stderr,
}
impl WorkspaceArchiveKind {
    fn label(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

/// This is a result archive receipt, not a loom_artifact or task-evidence row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceArchiveReceipt {
    pub version: u32,
    pub archive_id: String,
    pub request_id: String,
    pub kind: WorkspaceArchiveKind,
    pub sha256: String,
    pub size_bytes: u64,
    /// For a run, this says the original output was truncated. The archived
    /// bytes themselves are exactly the retained, ordered stream bytes.
    pub truncated: bool,
}

/// Only successful private-file publication and re-read can construct this.
/// It is intentionally neither Deserialize nor publicly constructible.
pub struct VerifiedArchiveSet {
    receipts: Vec<WorkspaceArchiveReceipt>,
    request_digest: String,
}
impl VerifiedArchiveSet {
    pub fn receipts(&self) -> &[WorkspaceArchiveReceipt] {
        &self.receipts
    }
    pub(super) fn request_digest(&self) -> &str {
        &self.request_digest
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn archive_id(
    dispatch: &WorkspaceDispatch,
    kind: WorkspaceArchiveKind,
    sha: &str,
    size: u64,
    truncated: bool,
) -> Result<String, RpcErrorCode> {
    let identity = serde_json::to_vec(&(
        "loom.workspace.archive.v1",
        &dispatch.request_digest,
        kind.label(),
        sha,
        size,
        truncated,
    ))
    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    Ok(format!("wrpc_archive_{}", digest(&identity)))
}
impl WorkspaceArchiveReceipt {
    pub(super) fn validate_for(&self, dispatch: &WorkspaceDispatch) -> Result<(), RpcErrorCode> {
        if self.version != 1
            || self.request_id != dispatch.request.request_id
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| matches!(b,b'0'..=b'9'|b'a'..=b'f'))
            || self.size_bytes > MAX_OUTPUT_BYTES
            || self.archive_id
                != archive_id(
                    dispatch,
                    self.kind,
                    &self.sha256,
                    self.size_bytes,
                    self.truncated,
                )?
        {
            return Err(RpcErrorCode::StorageUnavailable);
        }
        match (&dispatch.request.operation, self.kind) {
            (WorkspaceOperation::Read { offset: 0, .. }, WorkspaceArchiveKind::Read)
                if !self.truncated =>
            {
                Ok(())
            }
            (
                WorkspaceOperation::Run { .. },
                WorkspaceArchiveKind::Stdout | WorkspaceArchiveKind::Stderr,
            ) => Ok(()),
            _ => Err(RpcErrorCode::StorageUnavailable),
        }
    }
}
fn material(
    dispatch: &WorkspaceDispatch,
    kind: WorkspaceArchiveKind,
    bytes: Vec<u8>,
    truncated: bool,
) -> Result<(WorkspaceArchiveReceipt, Vec<u8>), RpcErrorCode> {
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(RpcErrorCode::OutputLimit);
    }
    let sha = digest(&bytes);
    let receipt = WorkspaceArchiveReceipt {
        version: 1,
        archive_id: archive_id(dispatch, kind, &sha, bytes.len() as u64, truncated)?,
        request_id: dispatch.request.request_id.clone(),
        kind,
        sha256: sha,
        size_bytes: bytes.len() as u64,
        truncated,
    };
    receipt.validate_for(dispatch)?;
    Ok((receipt, bytes))
}

/// Reconstruct only a complete journal snapshot. Partial file reads are not
/// snapshots and never receive a complete-file archive receipt.
fn expected_material(
    dispatch: &WorkspaceDispatch,
    events: &[WorkspaceEvent],
) -> Result<Vec<(WorkspaceArchiveReceipt, Vec<u8>)>, RpcErrorCode> {
    dispatch.validate()?;
    if events.is_empty() || events.len() > 512 {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut omitted = 0u64;
    for (index, event) in events.iter().enumerate() {
        event.validate_for(dispatch)?;
        if event.seq != index as u64 + 1 {
            return Err(RpcErrorCode::SequenceConflict);
        }
        match &event.body {
            WorkspaceEventBody::Accepted if index == 0 => {}
            WorkspaceEventBody::Accepted => return Err(RpcErrorCode::SequenceConflict),
            WorkspaceEventBody::Output { stream, data } => {
                if !matches!(dispatch.request.operation, WorkspaceOperation::Run { .. }) {
                    return Err(RpcErrorCode::StorageUnavailable);
                }
                let bytes = STANDARD
                    .decode(data)
                    .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                if stdout.len() + stderr.len() + bytes.len() > MAX_OUTPUT_BYTES as usize {
                    return Err(RpcErrorCode::OutputLimit);
                }
                match stream {
                    RpcOutputStream::Stdout => stdout.extend(bytes),
                    RpcOutputStream::Stderr => stderr.extend(bytes),
                }
            }
            WorkspaceEventBody::OutputTruncated { omitted_bytes } => {
                omitted = omitted
                    .checked_add(*omitted_bytes)
                    .ok_or(RpcErrorCode::StorageUnavailable)?;
            }
            WorkspaceEventBody::Completed { .. } if index + 1 == events.len() => {}
            WorkspaceEventBody::Unknown { .. } => {}
            _ => return Err(RpcErrorCode::StorageUnavailable),
        }
    }
    match &events.last().ok_or(RpcErrorCode::StorageUnavailable)?.body {
        WorkspaceEventBody::Completed {
            result:
                WorkspaceResult::Read {
                    data,
                    offset: 0,
                    truncated: false,
                },
        } => {
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| RpcErrorCode::StorageUnavailable)?;
            Ok(vec![material(
                dispatch,
                WorkspaceArchiveKind::Read,
                bytes,
                false,
            )?])
        }
        WorkspaceEventBody::Completed {
            result:
                WorkspaceResult::Run {
                    output_bytes,
                    omitted_bytes,
                    ..
                },
        } => {
            if *output_bytes != (stdout.len() + stderr.len()) as u64 || *omitted_bytes != omitted {
                return Err(RpcErrorCode::StorageUnavailable);
            }
            Ok(vec![
                material(dispatch, WorkspaceArchiveKind::Stdout, stdout, omitted > 0)?,
                material(dispatch, WorkspaceArchiveKind::Stderr, stderr, omitted > 0)?,
            ])
        }
        WorkspaceEventBody::Completed {
            result:
                WorkspaceResult::Read { .. }
                | WorkspaceResult::List { .. }
                | WorkspaceResult::Write { .. },
        } => Ok(Vec::new()),
        _ => Err(RpcErrorCode::StorageUnavailable),
    }
}
pub(super) fn expected_receipts(
    dispatch: &WorkspaceDispatch,
    events: &[WorkspaceEvent],
) -> Result<Vec<WorkspaceArchiveReceipt>, RpcErrorCode> {
    Ok(expected_material(dispatch, events)?
        .into_iter()
        .map(|(r, _)| r)
        .collect())
}
fn read_verified_file(
    path: &Path,
    receipt: &WorkspaceArchiveReceipt,
) -> Result<Vec<u8>, RpcErrorCode> {
    let mut file = open_private_read_file(path).map_err(|_| RpcErrorCode::StorageUnavailable)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    if bytes.len() as u64 != receipt.size_bytes || digest(&bytes) != receipt.sha256 {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    Ok(bytes)
}
fn verify_file(path: &Path, receipt: &WorkspaceArchiveReceipt) -> Result<(), RpcErrorCode> {
    read_verified_file(path, receipt).map(|_| ())
}

/// Trusted Core/LOOM read adapter. Callers first authorize the journal and
/// artifact owner, then supply its retained dispatch and receipt. No path is
/// accepted from an RPC payload, and missing/corrupt storage fails closed.
pub fn read_archived_result_bytes(
    trusted_data_dir: &Path,
    dispatch: &WorkspaceDispatch,
    receipt: &WorkspaceArchiveReceipt,
) -> Result<Vec<u8>, RpcErrorCode> {
    if !trusted_data_dir.is_absolute() {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    dispatch.validate()?;
    receipt.validate_for(dispatch)?;
    let path = trusted_data_dir
        .join("workspace-rpc-archives")
        .join("v1")
        .join(format!("{}.bin", receipt.archive_id));
    read_verified_file(&path, receipt)
}

/// Receives only Core's trusted data directory and an authorized journal
/// snapshot. A repeated poll re-opens and hashes the physical bytes. Existing
/// corruption is refused, never silently repaired into a success receipt.
pub fn archive_completed_results(
    trusted_data_dir: &Path,
    dispatch: &WorkspaceDispatch,
    events: &[WorkspaceEvent],
) -> Result<VerifiedArchiveSet, RpcErrorCode> {
    if !trusted_data_dir.is_absolute() {
        return Err(RpcErrorCode::StorageUnavailable);
    }
    let materials = expected_material(dispatch, events)?;
    if materials.is_empty() {
        return Ok(VerifiedArchiveSet {
            receipts: Vec::new(),
            request_digest: dispatch.request_digest.clone(),
        });
    }
    let directory =
        prepare_private_directory(&trusted_data_dir.join("workspace-rpc-archives").join("v1"))
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    for (receipt, bytes) in &materials {
        let destination = directory.join(format!("{}.bin", receipt.archive_id));
        match std::fs::symlink_metadata(&destination) {
            Ok(_) => verify_file(&destination, receipt)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let temporary = directory.join(format!(".archive-{}.tmp", uuid::Uuid::new_v4()));
                let publication = (|| {
                    let mut file = create_private_new_file(&temporary)
                        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                    file.write_all(bytes)
                        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                    file.sync_all()
                        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                    drop(file);
                    if publish_private_new_temporary_file(&temporary, &destination).is_err() {
                        // A concurrent poll may have published the same content.
                        // The same independent byte check is mandatory.
                        verify_file(&destination, receipt)?;
                    }
                    #[cfg(unix)]
                    std::fs::File::open(&directory)
                        .and_then(|d| d.sync_all())
                        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
                    verify_file(&destination, receipt)
                })();
                // This invocation owns this unique temporary name only.
                if temporary.exists() {
                    let _ = std::fs::remove_file(&temporary);
                }
                publication?;
            }
            Err(_) => return Err(RpcErrorCode::StorageUnavailable),
        }
    }
    Ok(VerifiedArchiveSet {
        receipts: materials.into_iter().map(|(r, _)| r).collect(),
        request_digest: dispatch.request_digest.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::{
        Admission, RequestState, TrustedPrincipal, WorkspaceGrant, WorkspaceRpcStore,
    };
    use super::*;
    use rusqlite::Connection;
    use std::collections::BTreeSet;

    fn fixture(operation: WorkspaceOperation) -> (Connection, TrustedPrincipal, WorkspaceDispatch) {
        let mut conn = Connection::open_in_memory().unwrap();
        WorkspaceRpcStore::install_schema(&conn).unwrap();
        let principal = TrustedPrincipal::AgentRun(CallerScope {
            run_id: "run".into(),
            attempt: 1,
            session_id: "session".into(),
            member_id: "member".into(),
            mission_id: "mission".into(),
        });
        let grant = WorkspaceGrant {
            workspace_id: "workspace".into(),
            mission_id: "mission".into(),
            owner_node_id: "node".into(),
            policy_revision: 1,
            allow_list: true,
            allow_read: true,
            allow_write: false,
            allowed_tools: BTreeSet::from(["git.status".into()]),
            online_generation: Some(1),
        };
        let request = WorkspaceRequest {
            version: RPC_VERSION,
            request_id: "archive-request".into(),
            workspace_id: "workspace".into(),
            timeout_ms: 10_000,
            operation,
        };
        let Admission::Dispatch(dispatch) =
            WorkspaceRpcStore::admit(&mut conn, &principal, &grant, request, 100).unwrap()
        else {
            panic!("new fixture")
        };
        WorkspaceRpcStore::mark_dispatched(&mut conn, &dispatch.request.request_id, 1, 101)
            .unwrap();
        (conn, principal, dispatch)
    }
    fn event(d: &WorkspaceDispatch, seq: u64, body: WorkspaceEventBody) -> WorkspaceEvent {
        WorkspaceEvent {
            version: RPC_VERSION,
            request_id: d.request.request_id.clone(),
            run_id: d.scope.run_id.clone(),
            attempt: d.scope.attempt,
            owner_node_id: d.owner_node_id.clone(),
            request_digest: d.request_digest.clone(),
            seq,
            body,
        }
    }
    fn append(conn: &mut Connection, _d: &WorkspaceDispatch, events: &[WorkspaceEvent]) {
        for event in events {
            WorkspaceRpcStore::append_event(conn, "node", 1, event, 102 + event.seq).unwrap();
        }
    }
    fn directory() -> std::path::PathBuf {
        let base = std::env::var_os("R2_ARCHIVE_TEST_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = base.join(format!("r2-archive-{}", uuid::Uuid::new_v4()));
        prepare_private_directory(&path).unwrap()
    }
    fn read_events(
        d: &WorkspaceDispatch,
        bytes: &[u8],
        offset: u64,
        truncated: bool,
    ) -> Vec<WorkspaceEvent> {
        vec![
            event(d, 1, WorkspaceEventBody::Accepted),
            event(
                d,
                2,
                WorkspaceEventBody::Completed {
                    result: WorkspaceResult::Read {
                        data: STANDARD.encode(bytes),
                        offset,
                        truncated,
                    },
                },
            ),
        ]
    }
    #[test]
    fn archive_whole_bytes_private_file_and_receipt_cas_are_idempotent() {
        let (mut conn, principal, d) = fixture(WorkspaceOperation::Read {
            path: "r2-fixture.txt".into(),
            offset: 0,
            max_bytes: 1_048_576,
        });
        let events = read_events(&d, b"remote bytes\n", 0, false);
        append(&mut conn, &d, &events);
        let snapshot =
            WorkspaceRpcStore::archive_snapshot(&mut conn, &principal, &d.request.request_id)
                .unwrap();
        let root = directory();
        let first =
            archive_completed_results(&root, &snapshot.status.dispatch, &snapshot.events).unwrap();
        assert_eq!(first.receipts()[0].sha256, digest(b"remote bytes\n"));
        WorkspaceRpcStore::publish_archives(
            &mut conn,
            &principal,
            &d.request.request_id,
            &[],
            &first,
            200,
        )
        .unwrap();
        let second = archive_completed_results(&root, &d, &events).unwrap();
        WorkspaceRpcStore::publish_archives(
            &mut conn,
            &principal,
            &d.request.request_id,
            &[],
            &second,
            201,
        )
        .unwrap();
        let stored = WorkspaceRpcStore::trusted_status(&conn, &d.request.request_id).unwrap();
        assert_eq!(stored.state, RequestState::Completed);
        assert_eq!(stored.archives, first.receipts());
        let path = root
            .join("workspace-rpc-archives/v1")
            .join(format!("{}.bin", stored.archives[0].archive_id));
        assert_eq!(std::fs::read(&path).unwrap(), b"remote bytes\n");
        assert_eq!(
            read_archived_result_bytes(&root, &d, &stored.archives[0]).unwrap(),
            b"remote bytes\n"
        );
        let mut foreign_receipt = stored.archives[0].clone();
        foreign_receipt.archive_id = "../escape".into();
        assert_eq!(
            read_archived_result_bytes(&root, &d, &foreign_receipt).err(),
            Some(RpcErrorCode::StorageUnavailable)
        );
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        let mut foreign = principal.clone();
        if let TrustedPrincipal::AgentRun(ref mut scope) = foreign {
            scope.attempt = 2;
        }
        assert_eq!(
            WorkspaceRpcStore::archive_snapshot(&mut conn, &foreign, &d.request.request_id).err(),
            Some(RpcErrorCode::Unauthorized)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn archive_refuses_corruption_and_never_publishes_a_success_receipt_on_failure() {
        let (mut conn, principal, d) = fixture(WorkspaceOperation::Read {
            path: "r2-fixture.txt".into(),
            offset: 0,
            max_bytes: 100,
        });
        let events = read_events(&d, b"original", 0, false);
        append(&mut conn, &d, &events);
        let root = directory();
        let first = archive_completed_results(&root, &d, &events).unwrap();
        let path = root
            .join("workspace-rpc-archives/v1")
            .join(format!("{}.bin", first.receipts()[0].archive_id));
        std::fs::write(path, b"corrupt").unwrap();
        assert!(matches!(
            archive_completed_results(&root, &d, &events),
            Err(RpcErrorCode::StorageUnavailable)
        ));
        assert!(
            WorkspaceRpcStore::trusted_status(&conn, &d.request.request_id)
                .unwrap()
                .archives
                .is_empty()
        );
        let blocker = root.join("blocked");
        std::fs::write(&blocker, b"not a directory").unwrap();
        assert!(matches!(
            archive_completed_results(&blocker, &d, &events),
            Err(RpcErrorCode::StorageUnavailable)
        ));
        assert!(
            WorkspaceRpcStore::archive_snapshot(&mut conn, &principal, &d.request.request_id)
                .unwrap()
                .status
                .archives
                .is_empty()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn partial_read_has_no_snapshot_receipt_and_run_streams_are_ordered_and_honestly_truncated() {
        let (_, _, partial) = fixture(WorkspaceOperation::Read {
            path: "data".into(),
            offset: 5,
            max_bytes: 100,
        });
        assert!(
            expected_receipts(&partial, &read_events(&partial, b"part", 5, false))
                .unwrap()
                .is_empty()
        );
        let (_, _, truncated) = fixture(WorkspaceOperation::Read {
            path: "data".into(),
            offset: 0,
            max_bytes: 100,
        });
        assert!(
            expected_receipts(&truncated, &read_events(&truncated, b"part", 0, true))
                .unwrap()
                .is_empty()
        );
        let (mut conn, principal, d) = fixture(WorkspaceOperation::Run {
            tool_id: "git.status".into(),
            args: vec![],
            cwd: String::new(),
        });
        let events = vec![
            event(&d, 1, WorkspaceEventBody::Accepted),
            event(
                &d,
                2,
                WorkspaceEventBody::Output {
                    stream: RpcOutputStream::Stdout,
                    data: STANDARD.encode(b"a"),
                },
            ),
            event(
                &d,
                3,
                WorkspaceEventBody::Output {
                    stream: RpcOutputStream::Stderr,
                    data: STANDARD.encode(b"err"),
                },
            ),
            event(
                &d,
                4,
                WorkspaceEventBody::Output {
                    stream: RpcOutputStream::Stdout,
                    data: STANDARD.encode(b"b"),
                },
            ),
            event(
                &d,
                5,
                WorkspaceEventBody::OutputTruncated { omitted_bytes: 9 },
            ),
            event(
                &d,
                6,
                WorkspaceEventBody::Completed {
                    result: WorkspaceResult::Run {
                        exit_code: 0,
                        output_bytes: 5,
                        omitted_bytes: 9,
                    },
                },
            ),
        ];
        append(&mut conn, &d, &events);
        let root = directory();
        let result = archive_completed_results(&root, &d, &events).unwrap();
        assert_eq!(result.receipts()[0].sha256, digest(b"ab"));
        assert_eq!(result.receipts()[1].sha256, digest(b"err"));
        assert!(result.receipts().iter().all(|r| r.truncated));
        WorkspaceRpcStore::publish_archives(
            &mut conn,
            &principal,
            &d.request.request_id,
            &[],
            &result,
            200,
        )
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn schema_requires_receipt_column_and_forged_or_cross_request_publication_is_rejected() {
        let old = Connection::open_in_memory().unwrap();
        old.execute_batch(&super::super::SCHEMA.replace(
            "    archive_receipts_json TEXT NOT NULL DEFAULT '[]',\n",
            "",
        ))
        .unwrap();
        assert!(!super::super::schema_matches(&old).unwrap());
        let (mut conn, principal, d) = fixture(WorkspaceOperation::Read {
            path: "data".into(),
            offset: 0,
            max_bytes: 100,
        });
        let events = read_events(&d, b"bytes", 0, false);
        append(&mut conn, &d, &events);
        let root = directory();
        let mut result = archive_completed_results(&root, &d, &events).unwrap();
        result.receipts[0].sha256 = "0".repeat(64);
        assert_eq!(
            WorkspaceRpcStore::publish_archives(
                &mut conn,
                &principal,
                &d.request.request_id,
                &[],
                &result,
                200
            )
            .err(),
            Some(RpcErrorCode::RequestConflict)
        );
        assert!(
            WorkspaceRpcStore::trusted_status(&conn, &d.request.request_id)
                .unwrap()
                .archives
                .is_empty()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
