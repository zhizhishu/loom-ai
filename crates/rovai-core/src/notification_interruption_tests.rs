// These owners exercise the new transactional source/Thread acknowledgement seam.
// Historical hydration, retention and private source identity retain their existing owners.
#[test]
fn interruption_admission_is_atomic_and_thread_acknowledgement_is_bounded() {
    let (directory, mut db) = test_database();
    let service = NotificationEpisodeService::default();
    crate::db::assert_interruption_upgrade(&mut db);
    for (id, status, reason, error, expected) in [
        (
            "stop",
            "cancelled",
            Some("user_requested_agent_run_stop"),
            None,
            None,
        ),
        (
            "shutdown",
            "cancelled",
            Some("app_shutdown_cancel_all"),
            None,
            Some("app_shutdown"),
        ),
        (
            "planned",
            "cancelled",
            Some("planned_shutdown_cancelled"),
            None,
            Some("app_shutdown"),
        ),
        (
            "lost",
            "failed",
            None,
            Some("accepted_input_outcome_unknown"),
            Some("execution_lost"),
        ),
        (
            "ordinary-failure",
            "failed",
            None,
            Some("runtime_error"),
            None,
        ),
        ("ordinary-incomplete", "cancelled", None, None, None),
    ] {
        insert_camp(&db, id, id);
        insert_batch_run(&db, id, id);
        let before = change_clock(db.connection()).unwrap().0;
        let sql = "UPDATE agent_run SET status=?2,cancel_reason_code=?3,
            cancel_requested_at=CASE WHEN ?3 IS NOT NULL THEN datetime('now') ELSE NULL END,
            last_error_code=?4,ended_at=datetime('now'),updated_at=datetime('now'),version=version+1 WHERE id=?1";
        // Rollback must undo the terminal state, fact and journal together.
        db.connection().execute_batch("SAVEPOINT terminal").unwrap();
        db.connection()
            .execute(sql, params![id, status, reason, error])
            .unwrap();
        assert_eq!(change_clock(db.connection()).unwrap().0 > before, id != "stop");
        db.connection()
            .execute_batch("ROLLBACK TO terminal; RELEASE terminal")
            .unwrap();
        assert_eq!(change_clock(db.connection()).unwrap().0, before);
        db.connection()
            .execute(sql, params![id, status, reason, error])
            .unwrap();
        let admitted = change_clock(db.connection()).unwrap().0;
        db.connection()
            .execute(
                "UPDATE agent_run SET version=version+1,status=status WHERE id=?1",
                [id],
            )
            .unwrap();
        assert_eq!(
            change_clock(db.connection()).unwrap().0,
            admitted,
            "cleanup cannot re-admit"
        );
        let changes = service
            .changes_since(&mut db, CURRENT_USER_ID, before, 100)
            .unwrap();
        let kind: Option<String> = db.connection().query_row(
            "SELECT interruption_kind FROM notification_occurrence WHERE agent_run_id=?1",
            [id], |r| r.get(0)).optional().unwrap().flatten();
        assert_eq!(kind.as_deref(), expected);
        assert_eq!(changes.changes.len(), usize::from(id != "stop"));
        assert!(serde_json::to_value(&changes).unwrap()["changes"].as_array().unwrap()
            .iter().all(|change| change.get("interruptionAdmission").is_none()));
        if status == "cancelled" && reason.is_some() {
            assert!(
                changes.changes.iter().all(|c| c.heads_up_signal.is_none()),
                "stops have no heads-up"
            );
        }
        if expected.is_some() {
            let visible = service.acknowledge_visible_sources(&mut db, &envelope(
                &format!("visible-{id}"), Some(id), AcknowledgeVisibleNotificationSourcesCommand {
                    camp_id: id.into(), observed_through_change_sequence: admitted,
                    visible_message_ids: Vec::new(), visible_camp_turn_ids: Vec::new(),
                    visible_agent_run_ids: vec![id.into()], visible_approval_ids: Vec::new(),
                },
            )).unwrap();
            assert_eq!(visible.result.payload["changed"], 0,
                "Run visibility cannot replace the Thread exit-reminder boundary");
        }
        let projection = service
            .thread_interruptions(&mut db, CURRENT_USER_ID, &[id.into()])
            .unwrap();
        assert_eq!(
            projection.threads[0].has_unread_interruption,
            expected.is_some()
        );
    }
    insert_camp(&db, "legacy-stop", "Legacy stop");
    insert_batch_run(&db, "legacy-stop", "legacy-stop");
    crate::db::assert_exit_attention_upgrade(&mut db, "legacy-stop");
    assert!(!service.thread_interruptions(&mut db, CURRENT_USER_ID, &["legacy-stop".into()])
        .unwrap().threads[0].has_unread_interruption);
    let ids = vec!["shutdown".to_string(), "lost".to_string()];
    let boundary = service
        .thread_interruptions(&mut db, CURRENT_USER_ID, &ids)
        .unwrap()
        .through_change_sequence;
    // A second Run in the same Thread arrives after the user's observed boundary.
    db.connection().execute_batch("INSERT INTO agent_run(
        id,camp_turn_id,conversation_id,initial_camp_context_through_sequence,initial_conversation_context_through_sequence,
        responsibility_key,responsibility_generation,start_reason,purpose,completion_role,effective_config_json,
        permission_semantics,status,idempotency_key,invocation_kind,camp_id,anchor_message_id,current_public_tail_sequence,
        cancel_requested_at,cancel_reason_code,ended_at,version,created_at,updated_at)
        SELECT 'stop-late',NULL,conversation_id,1,0,'batch:stop-late',0,'initial',purpose,'required','{}',
        'runtime_managed_v2','cancelled','batch:stop-late','batch',camp_id,anchor_message_id,1,
        datetime('now'),'app_shutdown_cancel_all',datetime('now'),1,created_at,updated_at
        FROM agent_run WHERE id='shutdown';").unwrap();
    let command = envelope(
        "read-interruptions",
        Some("shutdown"),
        AcknowledgeThreadInterruptionsCommand {
            thread_id: "shutdown".into(),
            observed_through_change_sequence: boundary,
        },
    );
    let result = service
        .acknowledge_thread_interruptions(&mut db, &command)
        .unwrap();
    assert_eq!(
        result.result.status,
        crate::command::CommandResultStatus::Applied
    );
    assert!(
        service
            .acknowledge_thread_interruptions(&mut db, &command)
            .unwrap()
            .replayed
    );
    let projection = service
        .thread_interruptions(&mut db, CURRENT_USER_ID, &ids)
        .unwrap();
    assert!(
        projection.threads.iter().all(|t| t.has_unread_interruption),
        "late same-Thread and other-Thread facts survive"
    );
    let acked: bool = db.connection().query_row("SELECT acknowledged_at IS NOT NULL FROM notification_occurrence_disposition d JOIN notification_occurrence o ON o.id=d.occurrence_id WHERE o.agent_run_id='shutdown'", [], |r| r.get(0)).unwrap();
    assert!(acked);
    let latest = service
        .thread_interruptions(&mut db, CURRENT_USER_ID, &["shutdown".into()])
        .unwrap();
    service
        .acknowledge_thread_interruptions(
            &mut db,
            &envelope(
                "read-late-stop",
                Some("shutdown"),
                AcknowledgeThreadInterruptionsCommand {
                    thread_id: "shutdown".into(),
                    observed_through_change_sequence: latest.through_change_sequence,
                },
            ),
        )
        .unwrap();
    assert!(
        !service
            .thread_interruptions(&mut db, CURRENT_USER_ID, &["shutdown".into()])
            .unwrap()
            .threads[0]
            .has_unread_interruption
    );
    let mut reader = NotificationInterruptionReader::for_database(&db);
    let prior = reader.read(CURRENT_USER_ID, &["lost".into()]).unwrap();
    assert!(prior.threads[0].has_unread_interruption);
    // A retained writer transaction must neither block this WAL reader nor
    // expose uncommitted Dispositions. Each later read observes a fresh boundary.
    db.connection().execute_batch("BEGIN IMMEDIATE;
        UPDATE notification_occurrence_disposition SET acknowledged_at=datetime('now'),updated_at=datetime('now')
        WHERE occurrence_id IN (SELECT id FROM notification_occurrence WHERE agent_run_id='lost');").unwrap();
    let during = reader.read(CURRENT_USER_ID, &["lost".into()]).unwrap();
    assert_eq!(
        during.through_change_sequence,
        prior.through_change_sequence
    );
    assert!(during.threads[0].has_unread_interruption);
    db.connection().execute_batch("COMMIT").unwrap();
    let after = reader.read(CURRENT_USER_ID, &["lost".into()]).unwrap();
    assert!(after.through_change_sequence > prior.through_change_sequence);
    assert!(!after.threads[0].has_unread_interruption);
    drop(reader);
    let before = change_clock(db.connection()).unwrap().0;
    let invalid = service
        .acknowledge_thread_interruptions(
            &mut db,
            &envelope(
                "reject-future",
                Some("lost"),
                AcknowledgeThreadInterruptionsCommand {
                    thread_id: "lost".into(),
                    observed_through_change_sequence: before + 1,
                },
            ),
        )
        .unwrap();
    assert_eq!(
        invalid.result.status,
        crate::command::CommandResultStatus::Rejected
    );
    assert_eq!(change_clock(db.connection()).unwrap().0, before);
    let (episode_id, revision): (String, i64) = db.connection().query_row(
        "SELECT episode_id,admitted_attention_revision FROM notification_occurrence WHERE agent_run_id='planned'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    service
        .clear(
            &mut db,
            &envelope(
                "clear-shutdown",
                Some("planned"),
                ClearNotificationEpisodeCommand {
                    episode_id,
                    through_attention_revision: revision,
                },
            ),
        )
        .unwrap();
    assert!(
        !service
            .thread_interruptions(&mut db, CURRENT_USER_ID, &["shutdown".into()])
            .unwrap()
            .threads[0]
            .has_unread_interruption
    );
    let before = change_clock(db.connection()).unwrap().0;
    drop(db);
    let mut reopened = Database::open(&directory).unwrap();
    assert_eq!(
        change_clock(reopened.connection()).unwrap().0,
        before,
        "opening cannot manufacture facts"
    );
    assert!(
        !service
            .thread_interruptions(&mut reopened, CURRENT_USER_ID, &["shutdown".into()])
            .unwrap()
            .threads[0]
            .has_unread_interruption
    );
    drop(reopened);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn interruption_projection_reads_only_requested_thread_indexes() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let (directory, mut db) = test_database();
    let service = NotificationEpisodeService::default();
    let ids: Vec<String> = vec!["visible-a".into(), "visible-b".into(), "visible-c".into()];
    for id in &ids {
        insert_camp(&db, id, id);
        insert_batch_run(&db, id, id);
        db.connection().execute("UPDATE agent_run SET status='cancelled',cancel_requested_at=datetime('now'),cancel_reason_code='app_shutdown_cancel_all',ended_at=datetime('now') WHERE id=?1",[id]).unwrap();
    }
    let mut previous = 0;
    let mut costs = Vec::new();
    for history in [100, 1_000, 10_000] {
        db.connection().execute_batch("BEGIN").unwrap();
        for n in previous..history {
            let id = format!("history-{n}");
            insert_camp(&db, &id, "History");
            if n % 10 == 0 {
                insert_batch_run(&db, &id, &id);
                db.connection().execute("UPDATE agent_run SET status='cancelled',cancel_requested_at=datetime('now'),cancel_reason_code='app_shutdown_cancel_all',ended_at=datetime('now') WHERE id=?1",[&id]).unwrap();
            }
        }
        db.connection().execute_batch("COMMIT").unwrap();
        previous = history;
        let steps = Arc::new(AtomicUsize::new(0));
        let counter = steps.clone();
        db.connection()
            .progress_handler(
                1,
                Some(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        let started = std::time::Instant::now();
        let projection = service
            .thread_interruptions(&mut db, CURRENT_USER_ID, &ids)
            .unwrap();
        let elapsed = started.elapsed();
        db.connection()
            .progress_handler(0, None::<fn() -> bool>)
            .unwrap();
        assert_eq!(projection.threads.len(), 3);
        assert!(projection.threads.iter().all(|t| t.has_unread_interruption));
        costs.push(steps.load(Ordering::Relaxed));
        eprintln!(
            "interruption projection: history={history}, requested=3, vm_steps={}, elapsed={elapsed:?}",
            costs.last().unwrap()
        );
    }
    assert!(
        costs.windows(2).all(|pair| pair[1] == pair[0]),
        "history must not add SQLite VM work: {costs:?}"
    );
    assert!(
        service
            .thread_interruptions(&mut db, CURRENT_USER_ID, &vec!["visible-a".into(); 201])
            .is_err()
    );
    assert!(
        service
            .thread_interruptions(&mut db, CURRENT_USER_ID, &[])
            .unwrap()
            .threads
            .is_empty()
    );
    assert!(
        !service
            .thread_interruptions(&mut db, CURRENT_USER_ID, &["history-1".into()])
            .unwrap()
            .threads[0]
            .has_unread_interruption
    );
    let plan = db
        .connection()
        .prepare(&format!(
            "EXPLAIN QUERY PLAN {}",
            interruptions::projection_query()
        ))
        .unwrap()
        .query_map(
            params![
                CURRENT_USER_ID,
                serde_json::to_string(&ids).unwrap(),
                i64::MAX
            ],
            |r| r.get::<_, String>(3),
        )
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(
        plan.iter().any(|line| line
            .contains("SEARCH occurrence USING INDEX notification_interruption_thread_idx")),
        "{plan:?}"
    );
    eprintln!("interruption projection query plan: {plan:?}");
    let plan = db
        .connection()
        .prepare(&format!(
            "EXPLAIN QUERY PLAN {}",
            interruptions::acknowledgement_query()
        ))
        .unwrap()
        .query_map(
            params![CURRENT_USER_ID, "visible-a", i64::MAX, "2026-10-21"],
            |r| r.get::<_, String>(3),
        )
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(
        plan.iter().any(|line| line
            .contains("SEARCH occurrence USING INDEX notification_interruption_thread_idx")),
        "{plan:?}"
    );
    eprintln!("interruption acknowledgement query plan: {plan:?}");
    // Concentrated history must not be silently truncated by the Thread limit:
    // one explicit read covers all 1,001 observed occurrences in this Thread.
    db.connection().execute_batch("WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<1000)
        INSERT INTO agent_run(id,camp_turn_id,conversation_id,initial_camp_context_through_sequence,initial_conversation_context_through_sequence,
        responsibility_key,responsibility_generation,start_reason,purpose,completion_role,effective_config_json,
        permission_semantics,status,idempotency_key,invocation_kind,camp_id,anchor_message_id,current_public_tail_sequence,
        cancel_requested_at,cancel_reason_code,ended_at,version,created_at,updated_at)
        SELECT 'dense-'||n.value,NULL,r.conversation_id,1,0,'dense-'||n.value,0,'initial',r.purpose,'required','{}',
        'runtime_managed_v2','cancelled','dense-'||n.value,'batch',r.camp_id,r.anchor_message_id,1,
        datetime('now'),'app_shutdown_cancel_all',datetime('now'),1,r.created_at,r.updated_at
        FROM n JOIN agent_run r ON r.id='visible-a';").unwrap();
    let boundary = change_clock(db.connection()).unwrap().0;
    let started = std::time::Instant::now();
    let read = service
        .acknowledge_thread_interruptions(
            &mut db,
            &envelope(
                "dense-read",
                Some("visible-a"),
                AcknowledgeThreadInterruptionsCommand {
                    thread_id: "visible-a".into(),
                    observed_through_change_sequence: boundary,
                },
            ),
        )
        .unwrap();
    assert_eq!(read.result.payload["changed"], 1001);
    eprintln!(
        "interruption concentrated acknowledgement: occurrences=1001, elapsed={:?}",
        started.elapsed()
    );
    let started = std::time::Instant::now();
    let after = service
        .thread_interruptions(&mut db, CURRENT_USER_ID, &ids)
        .unwrap();
    assert!(!after.threads[0].has_unread_interruption);
    assert!(after.threads[1..].iter().all(|t| t.has_unread_interruption));
    eprintln!(
        "interruption read-history projection: read_occurrences=1001, requested=3, elapsed={:?}",
        started.elapsed()
    );
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}
