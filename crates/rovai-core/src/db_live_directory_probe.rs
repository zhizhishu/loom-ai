//! Extends the existing live/frozen directory owner with the actual bundled SQLite
//! and complete schema. This is a reproducible small probe, not a timing gate.
use crate::camp_message_publication::{self as publication, LAST_VISIBLE_MESSAGE_SQL};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::time::Instant;

fn rows(c: &Connection, sql: &str) -> Vec<(String, String, String)> {
    c.prepare(sql)
        .unwrap()
        .query_map(["excluded-current"], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
fn plan(c: &Connection, sql: &str) -> Value {
    let query_plan: Vec<String> = c
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(["excluded-current"], |r| r.get(3))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    // Preserve the actual VM columns/cursors, including temporary tables, so a
    // zero application Blob-read counter is not mistaken for SQL read evidence.
    let vm: Vec<Value> = c
        .prepare(&format!("EXPLAIN {sql}"))
        .unwrap()
        .query_map(["excluded-current"], |r| {
            Ok(json!([
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?
            ]))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<Value>>>()
        .unwrap()
        .into_iter()
        .filter(|op| {
            matches!(
                op[0].as_str(),
                Some(
                    "Column"
                        | "OpenRead"
                        | "OpenEphemeral"
                        | "SorterOpen"
                        | "SorterInsert"
                        | "DeferredSeek"
                )
            )
        })
        .collect();
    let objects: Vec<Value> = c.prepare("SELECT name,rootpage,sql FROM sqlite_master WHERE tbl_name IN ('camp','camp_message','event_log') AND type IN ('table','index')").unwrap()
        .query_map([], |r| Ok(json!([r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?])))
        .unwrap().collect::<rusqlite::Result<_>>().unwrap();
    json!({"queryPlan":query_plan,"readOpcodes":vm,"schemaObjects":objects})
}
fn samples(c: &Connection, sql: &str, expected: &[(String, String, String)]) -> Vec<f64> {
    (0..7)
        .map(|_| {
            let now = Instant::now();
            let actual = rows(c, sql);
            let ms = now.elapsed().as_secs_f64() * 1000.;
            assert_eq!(actual, expected);
            ms
        })
        .collect()
}

pub(super) fn verify_large_directory() {
    let (mut database, directory) = crate::test_support::fresh_schema_database();
    crate::test_support::assert_production_database_configuration(&database);
    super::downgrade_for_test(database.connection());
    let now = Instant::now();
    {
        let tx = database.connection_mut().transaction().unwrap();
        let body = "history body ".repeat(86);
        for camp in 0..600 {
            let id = format!("directory-{camp:04}");
            tx.execute(
                "INSERT INTO camp(id,title,project_binding_kind,project_path,created_at,updated_at)
                VALUES(?1,?1,'quick_chat','','2026-01-01','2099-01-01')",
                [&id],
            )
            .unwrap();
            for n in 0..200 {
                let message = format!("{id}-{n:04}");
                let at = format!(
                    "2026-09-{:02}T00:{:02}:{:02}Z",
                    camp % 28 + 1,
                    n / 60,
                    n % 60
                );
                tx.prepare_cached("INSERT INTO camp_message(id,camp_id,sequence,author_type,author_id,body,structured_content_json,content_digest,address_mode,addressed_agent_ids_json,version,created_at,updated_at)
                    VALUES(?1,?2,?3,'user','local_user',?4,'[]','digest','default','[]',1,?5,?5)").unwrap().execute(params![message,id,n+1,body,at]).unwrap();
                tx.prepare_cached("INSERT INTO event_log(event_type,camp_id,entity_type,entity_id,payload_json,created_at)
                    VALUES(?1,?2,'camp_message',?3,'{}',?4)").unwrap().execute(params![if n%2==0{"camp_message.sent"}else{"camp_message.public_a2a_sent"},id,message,at]).unwrap();
            }
        }
        tx.execute(
            "INSERT INTO camp(id,title,project_binding_kind,project_path,created_at,updated_at)
            VALUES('empty','empty','quick_chat','','2026-01-02','2099-01-01')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    eprintln!("directory probe seed complete");
    let seed_ms = now.elapsed().as_secs_f64() * 1000.;
    let original_sql = format!(
        "WITH {} SELECT camp.id,camp.title,COALESCE((SELECT m.created_at FROM camp_message m JOIN public_camp_message_publication p ON p.message_id=m.id WHERE m.camp_id=camp.id AND m.tombstoned_at IS NULL AND m.recall_state<>'withdrawn' ORDER BY julianday(m.created_at) DESC,m.id ASC LIMIT 1),camp.created_at) AS activity_at FROM camp WHERE camp.id<>?1 AND deletion_operation_id IS NULL ORDER BY julianday(activity_at) DESC,camp.id ASC",
        publication::public_camp_message_publication_cte()
    );
    let expected = rows(database.connection(), &original_sql);
    assert_eq!(expected.len(), 601);
    let old_samples = samples(database.connection(), &original_sql, &expected);
    let old_plan = plan(database.connection(), &original_sql);
    let now = Instant::now();
    super::migrate(&mut database).unwrap();
    let migration_ms = now.elapsed().as_secs_f64() * 1000.;
    let fallback_sql = publication::live_directory_sql(database.connection()).unwrap();
    let fallback_samples = samples(database.connection(), &fallback_sql, &expected);
    let fallback_plan = plan(database.connection(), &fallback_sql);
    let mut batches = Vec::new();
    loop {
        let now = Instant::now();
        let pending = publication::initialize_directory_activity(&mut database).unwrap();
        batches.push(now.elapsed().as_secs_f64() * 1000.);
        assert_eq!(
            rows(
                database.connection(),
                &publication::live_directory_sql(database.connection()).unwrap()
            ),
            expected
        );
        if !pending {
            break;
        }
    }
    let ready_sql = publication::live_directory_sql(database.connection()).unwrap();
    assert_eq!(ready_sql, publication::LIVE_DIRECTORY_SQL);
    let ready_samples = samples(database.connection(), &ready_sql, &expected);
    let ready_plan = plan(database.connection(), &ready_sql);
    assert!(
        !ready_plan["queryPlan"].as_array().unwrap().iter().any(|v| v
            .as_str()
            .unwrap()
            .contains("event_log")
            || v.as_str().unwrap().contains("camp_message"))
    );
    assert_eq!(database.connection().query_row("SELECT history_activity_initialized=1 AND history_activity_at IS NULL AND history_activity_message_id IS NULL FROM camp WHERE id='empty'",[],|r|r.get::<_,bool>(0)).unwrap(),true);
    // Publication and withdrawal are atomic, and a failed transaction cannot
    // expose summary state. Both event spellings/automatic and explicit sequence
    // allocation are covered by the surrounding fixtures and this dataset.
    let mut publish_ms = Vec::new();
    let mut withdraw_ms = Vec::new();
    for sample in 0..12 {
        let tx = database.connection_mut().transaction().unwrap();
        let id = format!("published-{sample}");
        tx.execute("INSERT INTO camp_message(id,camp_id,sequence,author_type,author_id,body,structured_content_json,content_digest,address_mode,addressed_agent_ids_json,version,created_at,updated_at) VALUES(?1,'directory-0000',?2,'user','local_user','new','[]','new','default','[]',1,'2026-10-14','2026-10-14')",params![id,201+sample]).unwrap();
        let now = Instant::now();
        tx.execute("INSERT INTO event_log(event_type,camp_id,entity_type,entity_id,payload_json,created_at) VALUES('camp_message.sent','directory-0000','camp_message',?1,'{}','2026-10-14')",[&id]).unwrap();
        publish_ms.push(now.elapsed().as_secs_f64() * 1000.);
        assert_eq!(
            tx.query_row(
                "SELECT history_activity_message_id FROM camp WHERE id='directory-0000'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            id
        );
        let now = Instant::now();
        tx.execute(
            "UPDATE camp_message SET recall_state='withdrawn' WHERE id=?1",
            [&id],
        )
        .unwrap();
        withdraw_ms.push(now.elapsed().as_secs_f64() * 1000.);
        assert_eq!(
            tx.query_row(
                "SELECT history_activity_message_id FROM camp WHERE id='directory-0000'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "directory-0000-0199"
        );
        tx.rollback().unwrap();
    }
    assert_eq!(rows(database.connection(), &ready_sql), expected);
    // A trigger that rejects only summary writes proves older-message changes
    // and recall-window closure do not even update/rescan the summary.
    database.connection().execute_batch("CREATE TEMP TRIGGER reject_summary BEFORE UPDATE OF history_activity_at,history_activity_message_id ON camp BEGIN SELECT RAISE(ABORT,'unexpected summary update'); END;
        UPDATE camp_message SET recall_state='withdrawn' WHERE id='directory-0000-0000';
        UPDATE camp_message SET recall_state='closed' WHERE id='directory-0000-0199';
        UPDATE camp SET title='renamed',updated_at='2100-01-01' WHERE id='directory-0000';
        DROP TRIGGER reject_summary;").unwrap();
    // Removing a publication only changes visibility when its last public event
    // disappears; message deletion and tombstone share the per-Camp seek.
    database
        .connection()
        .execute(
            "DELETE FROM event_log WHERE entity_id='directory-0000-0199'",
            [],
        )
        .unwrap();
    assert_eq!(
        database
            .connection()
            .query_row(
                "SELECT history_activity_message_id FROM camp WHERE id='directory-0000'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "directory-0000-0198"
    );
    database
        .connection()
        .execute(
            "DELETE FROM camp_message WHERE id='directory-0000-0198'",
            [],
        )
        .unwrap();
    assert_eq!(
        database
            .connection()
            .query_row(
                "SELECT history_activity_message_id FROM camp WHERE id='directory-0000'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "directory-0000-0197"
    );
    let seek_sql = format!(
        "SELECT ({}) FROM camp WHERE id=?1",
        LAST_VISIBLE_MESSAGE_SQL.replace("m.created_at, m.id", "m.created_at")
    );
    let report = json!({"sqlite":database.connection().query_row("SELECT sqlite_version()",[],|r|r.get::<_,String>(0)).unwrap(),"camps":601,"messages":120000,"directorySamples":7,"maintenanceSamples":12,"seedMs":seed_ms,"migrationIncludingIndexMs":migration_ms,"backfillBatchMs":batches,"beforeDirectoryMs":old_samples,"uninitializedDirectoryMs":fallback_samples,"initializedDirectoryMs":ready_samples,"publicationStatementMs":publish_ms,"withdrawalStatementMs":withdraw_ms,"plans":{"before":old_plan,"uninitialized":fallback_plan,"initialized":ready_plan,"perCampSeek":plan(database.connection(),&seek_sql)},"largeColumnsRead":"directory/index initialization/summary maintenance do not select message bodies, structured content, event payloads, or Blobs; actual VM columns and schema roots are included"});
    if let Ok(path) = std::env::var("ROVAI_DIRECTORY_PROBE_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!(
        "directory_probe {}",
        json!({"sqlite":report["sqlite"],"camps":601,"messages":120000,"migrationMs":report["migrationIncludingIndexMs"],"backfillMs":report["backfillBatchMs"],"beforeMs":report["beforeDirectoryMs"],"fallbackMs":report["uninitializedDirectoryMs"],"readyMs":report["initializedDirectoryMs"],"publishMs":report["publicationStatementMs"],"withdrawMs":report["withdrawalStatementMs"]})
    );
    drop(database);
    std::fs::remove_dir_all(directory).unwrap();
}
