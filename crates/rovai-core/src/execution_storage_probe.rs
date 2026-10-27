//! One reproducible workload, owned by the existing slow pagination fixture.
//! Legacy modes use the retained writers, not a second implementation of their reducers.
use crate::{
    db::Database,
    execution_evidence::{self, ExecutionEvidenceService},
    execution_window,
    managed_blob::{self, ManagedBlobStore},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{path::Path, time::Instant};

const OPERATIONS: usize = 10_000;
const READ_SAMPLES: usize = 5;

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}
fn blob_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| {
            if e.path().is_dir() {
                blob_size(&e.path())
            } else {
                file_size(&e.path())
            }
        })
        .sum()
}
fn reset_reads() {
    execution_evidence::take_read_counts();
    managed_blob::take_read_count();
}
fn operation_json_bytes(db: &Database, id: &str) -> i64 {
    db.connection().query_row("SELECT length(CAST(payload_preview_json AS BLOB))+
        COALESCE(length(CAST(input_preview_json AS BLOB)),0)+COALESCE(length(CAST(result_preview_json AS BLOB)),0)+
        COALESCE(length(CAST(activity_meta_json AS BLOB)),0)+COALESCE((SELECT length(CAST(diff_projection_json AS BLOB))
            FROM canonical_runtime_activity a WHERE a.agent_run_id=e.agent_run_id AND a.operation_id=e.operation_id),0)
        FROM agent_run_execution_evidence e WHERE id=?1",[id],|r|r.get(0)).unwrap()
}
fn measured<T>(f: impl FnOnce() -> T) -> (T, Value) {
    reset_reads();
    let start = Instant::now();
    let result = f();
    let us = start.elapsed().as_micros();
    let (previews, full) = execution_evidence::take_read_counts();
    let blobs = managed_blob::take_read_count();
    (
        result,
        json!({"us":us,"previewReads":previews,"fullPayloadReads":full,"blobReads":blobs}),
    )
}

pub(crate) fn compare(seed: &Database, camp: &str, run: &str, parent: &Path) {
    let mut reports = Vec::new();
    for format in [1, 2, 3, 4] {
        let directory = parent.join(format!("storage-probe-{format}"));
        std::fs::create_dir_all(&directory).unwrap();
        seed.connection()
            .backup("main", directory.join("rovai.sqlite"), None)
            .unwrap();
        let mut db = Database::open(&directory).unwrap();
        db.connection()
            .execute(
                "UPDATE agent_run SET status='running',runtime_adapter_kind='codex-cli',
            cancel_requested_at=NULL,workspace_json=?2 WHERE id=?1",
                params![
                    run,
                    json!({"executionRoot":parent,"access":"write","isolation":"runtime_managed"})
                        .to_string()
                ],
            )
            .unwrap();
        if format < 3 {
            // The pre-change reader queried the legacy table directly. The test alias is
            // non-materialized and restores that same query plan for the baseline.
            db.connection()
                .execute_batch(
                    "DROP VIEW execution_activity;
                CREATE VIEW execution_activity AS SELECT * FROM canonical_runtime_activity;",
                )
                .unwrap();
        }
        // SQLite statements/JSON values written, not an estimate of physical disk traffic.
        db.connection().execute_batch("CREATE TEMP TABLE storage_writes(inserts INTEGER,updates INTEGER,body_updates INTEGER,json_bytes INTEGER,digest_bytes INTEGER);
            INSERT INTO storage_writes VALUES(0,0,0,0,0);
            CREATE TEMP TRIGGER storage_inserts AFTER INSERT ON agent_run_execution_evidence BEGIN
                UPDATE storage_writes SET inserts=inserts+1,json_bytes=json_bytes+length(CAST(NEW.payload_preview_json AS BLOB))+COALESCE(length(CAST(NEW.input_preview_json AS BLOB)),0)+COALESCE(length(CAST(NEW.result_preview_json AS BLOB)),0),digest_bytes=digest_bytes+COALESCE(length(NEW.result_digest),0); END;
            CREATE TEMP TRIGGER storage_updates AFTER UPDATE ON agent_run_execution_evidence BEGIN
                UPDATE storage_writes SET updates=updates+1; END;
            CREATE TEMP TRIGGER storage_bodies AFTER UPDATE OF input_preview_json,result_preview_json ON agent_run_execution_evidence BEGIN
                UPDATE storage_writes SET body_updates=body_updates+1,json_bytes=json_bytes+length(CAST(NEW.payload_preview_json AS BLOB))+COALESCE(length(CAST(NEW.input_preview_json AS BLOB)),0)+COALESCE(length(CAST(NEW.result_preview_json AS BLOB)),0); END;
            CREATE TEMP TRIGGER storage_metadata AFTER UPDATE OF activity_meta_json ON agent_run_execution_evidence BEGIN
                UPDATE storage_writes SET json_bytes=json_bytes+COALESCE(length(CAST(NEW.activity_meta_json AS BLOB)),0); END;
            CREATE TEMP TRIGGER storage_digest AFTER UPDATE OF result_digest ON agent_run_execution_evidence BEGIN
                UPDATE storage_writes SET digest_bytes=digest_bytes+COALESCE(length(NEW.result_digest),0); END;").unwrap();
        let store = ManagedBlobStore::new(&directory);
        let mut peak_wal = 0;
        let mut write_bytes = 0_i64;
        let mut events = 0;
        let mut file_id = String::new();
        let mut output_id = String::new();
        let initial_pages: i64 = db
            .connection()
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap();
        let write_start = Instant::now();
        execution_evidence::with_operation_storage_for_test(format, || {
            for operation in 0..OPERATIONS {
                // Ten groups separated by narration exercise first page and group cursors.
                if operation % 1000 == 0 {
                    ExecutionEvidenceService.record_runtime_event(&mut db,&store,run,0,"agent.text.delta",
                        &json!({"itemId":format!("narration-{operation}"),"delta":"next group"})).unwrap();
                }
                let is_file = operation % 100 == 99;
                let id = format!("operation-{operation}");
                let item_kind = if is_file {
                    "fileChange"
                } else {
                    "commandExecution"
                };
                for terminal in [false, true] {
                    let mut payload = json!({"item":{"id":id,"type":item_kind,
                        "command":format!("printf fixture-{operation}"),
                        "status":if terminal{"completed"}else{"inProgress"}}});
                    if terminal && is_file {
                        payload["item"]["changes"] = json!([{"path":parent.join(format!("src/file-{operation}.rs")),"kind":{"type":"update"},
                            "diff":format!("@@ -1 +1 @@\n-{}\n+{}\n","a".repeat(20_000),"b".repeat(20_000))}]);
                        payload = crate::codex::normalize_event("item/completed", &payload).1;
                    } else if terminal {
                        payload["item"]["aggregatedOutput"] =
                            json!(format!("{}DISCARDED_PROBE_SUFFIX", "x".repeat(7680)));
                    }
                    let wide_input = operation % 100 == 0;
                    if wide_input {
                        payload = json!({"toolCallId":id,"kind":"execute","toolName":"fixture",
                            "status":if terminal {"completed"} else {"started"},
                            "input":(0..24).map(|i|(format!("field{i}"),json!("a".repeat(4000)))).collect::<serde_json::Map<_,_>>(),
                            "output":if terminal {payload["item"]["aggregatedOutput"].clone()} else {Value::Null}});
                    }
                    let recorded = ExecutionEvidenceService
                        .record_runtime_event(
                            &mut db,
                            &store,
                            run,
                            0,
                            if wide_input {
                                "runtime.action"
                            } else if terminal {
                                "activity.completed"
                            } else {
                                "activity.started"
                            },
                            &payload,
                        )
                        .unwrap()
                        .unwrap();
                    if terminal {
                        if is_file {
                            file_id = recorded.id.clone();
                        } else {
                            output_id = recorded.id.clone();
                        }
                    }
                    write_bytes += operation_json_bytes(&db, &recorded.id);
                    peak_wal = peak_wal.max(file_size(&directory.join("rovai.sqlite-wal")));
                    events += 1;
                }
            }
        });
        let write_ms = write_start.elapsed().as_millis();
        // Updating an old operation outside the fixture override must keep its first format.
        let mut progress_samples = Vec::new();
        let mut previous_progress_revision = None;
        let mut progress_changed_rows = 0;
        for step in 0..128 {
            let (recorded, sample) = measured(|| {
                let record = || {
                    ExecutionEvidenceService.record_runtime_event(&mut db,&store,run,0,"runtime.action",
                    &json!({"toolCallId":"progress-probe","kind":"execute","status":"in_progress",
                        "output":format!("{}DISCARDED_PROGRESS_SUFFIX", "p".repeat(8_000+step*100))})).unwrap().unwrap()
                };
                if step == 0 {
                    execution_evidence::with_operation_storage_for_test(format, record)
                } else {
                    let mut record = record;
                    record()
                }
            });
            // A clipped identical snapshot is observed but does not rewrite the row.
            if recorded.revision != previous_progress_revision {
                write_bytes += operation_json_bytes(&db, &recorded.id);
                previous_progress_revision = recorded.revision;
                progress_changed_rows += 1;
            }
            progress_samples.push(sample);
            peak_wal = peak_wal.max(file_size(&directory.join("rovai.sqlite-wal")));
        }
        let mut read_samples = Vec::new();
        for _ in 0..READ_SAMPLES {
            let (page, first) = measured(|| {
                execution_window::read_block_page(&mut db, camp, run, None, None, 2).unwrap()
            });
            let (_, next) = measured(|| {
                execution_window::read_block_page(
                    &mut db,
                    camp,
                    run,
                    page.next_before_sequence,
                    None,
                    2,
                )
                .unwrap()
            });
            let group = page
                .blocks
                .iter()
                .find(|b| b.kind == "tool_group")
                .unwrap_or_else(|| page.blocks.iter().find(|b| b.tool_count > 0).unwrap());
            let (children, expand) = measured(|| {
                execution_window::read_group_page(
                    &mut db,
                    camp,
                    run,
                    group.sequence,
                    None,
                    None,
                    24,
                )
                .unwrap()
            });
            let (_, group_next) = measured(|| {
                execution_window::read_group_page(
                    &mut db,
                    camp,
                    run,
                    group.sequence,
                    children.next_before_sequence,
                    None,
                    24,
                )
                .unwrap()
            });
            let (_, result) = measured(|| {
                ExecutionEvidenceService
                    .read_full_payload(&db, &store, camp, &output_id)
                    .unwrap()
            });
            let (_, diff) = measured(|| {
                let payload = ExecutionEvidenceService
                    .read_full_payload(&db, &store, camp, &file_id)
                    .unwrap();
                let activity = execution_window::content_canonical(&db, &file_id, &payload)
                    .unwrap()
                    .unwrap();
                let diff = activity.diff_projection.unwrap();
                assert_eq!(diff.status, "available");
                assert!(diff.entries.unwrap()[0].diff.len() > 40_000);
            });
            for metric in [&first, &next, &expand, &group_next] {
                assert_eq!(metric["fullPayloadReads"], 0);
                assert_eq!(metric["blobReads"], 0);
            }
            read_samples.push(json!({"first":first,"next":next,"expandGroup":expand,"groupNext":group_next,
                "expandResult":result,"expandDiff":diff,"firstBytes":serde_json::to_vec(&page).unwrap().len()}));
        }
        let rows:(i64,i64,i64)=db.connection().query_row("SELECT
            (SELECT count(*) FROM agent_run_execution_evidence WHERE operation_id IS NOT NULL),
            (SELECT count(*) FROM canonical_runtime_activity),
            (SELECT count(*) FROM agent_run_execution_evidence WHERE operation_id IS NOT NULL AND storage_version IN (3,4) AND activity_meta_json IS NULL)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(rows.0, OPERATIONS as i64 + 1);
        assert_eq!(rows.2, 0);
        assert_eq!(rows.1, if format < 3 { OPERATIONS as i64 + 1 } else { 0 });
        let logical:i64=db.connection().query_row("SELECT COALESCE(sum(length(CAST(payload_preview_json AS BLOB))+
            COALESCE(length(CAST(input_preview_json AS BLOB)),0)+COALESCE(length(CAST(result_preview_json AS BLOB)),0)+
            COALESCE(length(CAST(activity_meta_json AS BLOB)),0)),0)+(SELECT COALESCE(sum(length(CAST(diff_projection_json AS BLOB))),0)
            FROM canonical_runtime_activity) FROM agent_run_execution_evidence",[],|r|r.get(0)).unwrap();
        let pages: i64 = db
            .connection()
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap();
        let page_size: i64 = db
            .connection()
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap();
        let blob_bytes = blob_size(&directory.join("managed-blobs"));
        let leaked:bool=db.connection().query_row("SELECT EXISTS(SELECT 1 FROM agent_run_execution_evidence WHERE
            instr(payload_preview_json,'DISCARDED_')>0 OR instr(input_preview_json,'DISCARDED_')>0
            OR instr(result_preview_json,'DISCARDED_')>0 OR instr(activity_meta_json,'DISCARDED_')>0)",[],|r|r.get(0)).unwrap();
        assert!(!leaked);
        let writes: (i64, i64, i64, i64, i64) = db
            .connection()
            .query_row(
                "SELECT inserts,updates,body_updates,json_bytes,digest_bytes FROM storage_writes",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        let report = json!({"storageFormat":format,"operations":OPERATIONS,"events":events,"progressUpdates":128,
            "progressChangedRows":progress_changed_rows,"sqlInserts":writes.0,"sqlUpdates":writes.1,"sqlBodyUpdates":writes.2,"jsonValueWriteBytes":writes.3,"digestWriteBytes":writes.4,
            "operationRows":rows.0,"activityCopyRows":rows.1,"previewAndDiffLogicalBytes":logical,
            "eventValueWriteBytes":write_bytes,"inputArgumentCases":OPERATIONS/100,"duplicateNativeDiffCases":OPERATIONS/100,"readSampleCount":READ_SAMPLES,"dbPagesBytes":pages*page_size,"dbGrowthBytes":(pages-initial_pages)*page_size,
            "dbFileBytes":file_size(db.path()),"walPeakBytes":peak_wal,"blobPeakBytes":blob_bytes,
            "writeMs":write_ms,"readSamples":read_samples,"progressSamples":progress_samples});
        eprintln!(
            "storage probe format={format} operations={OPERATIONS} write_ms={write_ms} logical_bytes={logical} db_bytes={} wal_peak={peak_wal} blob_bytes={blob_bytes}",
            pages * page_size
        );
        reports.push(report);
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }
    let path = std::env::temp_dir().join("rovai-storage-pr3-comparison.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
    eprintln!("storage comparison: {}", path.display());
}
