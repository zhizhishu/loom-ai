use super::*;
use loom_protocol::process_pipe::{ProcessArgument, PROCESS_PIPE_VERSION};
use std::{collections::BTreeMap, ffi::OsString, io::BufRead};

fn launch(id: &str) -> ProcessOpenV1 {
    ProcessOpenV1 {
        codex_hook_grant: None,
        version: PROCESS_PIPE_VERSION,
        key: RemoteProcessKey { node_id: "node-fixture".into(), process_id: id.into(), process_epoch: 4 },
        session: ProcessSessionOwner { member_id: "member-fixture".into(), logical_session_id: "native-session".into(),
            workspace_id: "workspace-fixture".into(), controller_id: "controller-fixture".into() },
        owner: AgentRunOwner { agent_run_id: "run-one".into(), execution_epoch: 9 },
        builtin_tasks_enabled: false,
        adapter_kind: "fixture".into(), catalog_generation: 1,
        program_identity: rovai_process_boundary::inspect_application_identity(&std::env::current_exe().unwrap()).unwrap(),
        program: std::env::current_exe().unwrap().to_string_lossy().into(),
        cwd: std::env::current_dir().unwrap().to_string_lossy().into(),
        args: vec![], environment: vec![], bundle: None,
    }
}
fn private_root(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("loom-pipe-{name}-{}", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    { use std::os::unix::fs::DirBuilderExt; std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap(); }
    #[cfg(windows)]
    { rovai_private_storage::create_private_directory(&path).unwrap(); }
    path
}
fn spec(root: &Path, mode: &str) -> ProcessSpec {
    let mut environment = BTreeMap::new();
    environment.insert(OsString::from("LOOM_PIPE_CHILD_MODE"), OsString::from(mode));
    ProcessSpec::new(std::env::current_exe().unwrap(),
        ["process_pipe::tests::child_helper", "--exact", "--ignored", "--nocapture"]
            .into_iter().map(OsString::from).collect(),
        root.to_path_buf(), environment, StdinPolicy::Piped).unwrap()
}
fn input(launch: &ProcessOpenV1, sequence: u64, bytes: &[u8]) -> ProcessInputV1 {
    ProcessInputV1::new(launch.key.clone(), launch.owner.clone(), launch.session.controller_id.clone(),
        sequence, bytes, false).unwrap()
}
async fn outputs(manager: &PipeManager, key: &RemoteProcessKey, needle: &[u8]) -> Vec<ProcessOutputEvent> {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let events = manager.pending_events(key, "controller-fixture", 0).await.unwrap();
            let bytes: Vec<u8> = events.iter().filter_map(|e| match &e.body {
                ProcessOutputBody::Output { stream: PipeStream::Stdout, data } => STANDARD.decode(data).ok(),
                _ => None,
            }).flatten().collect();
            if bytes.windows(needle.len()).any(|w| w == needle) { return events; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("native output deadline")
}

#[test]
#[ignore = "only launched as the owned native child by the process-pipe tests"]
fn child_helper() {
    let mode = std::env::var("LOOM_PIPE_CHILD_MODE").expect("test-owned child only");
    if mode == "flood" {
        let bytes = vec![b'F'; MAX_OUTPUT_CHUNK];
        let mut stdout = std::io::stdout().lock();
        for _ in 0..256 { stdout.write_all(&bytes).unwrap(); }
        stdout.flush().unwrap();
        return;
    }
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line == "QUIT" { break; }
        std::io::stdout().write_all(format!("PIPE_ECHO:{line}\n").as_bytes()).unwrap();
        std::io::stdout().flush().unwrap();
        std::io::stderr().write_all(b"PIPE_STDERR\n").unwrap();
        std::io::stderr().flush().unwrap();
    }
}

// Real OS child: a reconnect/replayed input must not execute twice. A new owner
// is admitted only at the acknowledged pipe boundary; old input is fenced.
#[tokio::test]
async fn native_pipe_replay_owner_transition_and_completed_tombstone() {
    let root = private_root("replay");
    let manager = PipeManager::new(&root, "node-fixture").unwrap();
    let mut launch = launch("process-replay");
    launch.cwd = root.to_string_lossy().into();
    assert_eq!(manager.replay_open(&launch).unwrap(), None);
    let first = manager.open(&launch, spec(&root, "echo"), None).unwrap();
    assert_eq!(manager.replay_open(&launch).unwrap(), Some(first.clone()));
    let mut changed_open = launch.clone();
    changed_open.session.controller_id = "changed-controller".into();
    assert_eq!(manager.replay_open(&changed_open).unwrap_err(), "pipe_launch_conflict");
    let second = manager.open(&launch, spec(&root, "echo"), None).unwrap();
    assert_eq!(first, second);
    let request = input(&launch, 1, b"one\n");
    let (first_write, concurrent_retry) = tokio::join!(manager.input(request.clone()), manager.input(request.clone()));
    let receipt = first_write.unwrap();
    assert!(matches!(receipt.body, ProcessControlBody::InputWritten { .. }));
    assert_eq!(concurrent_retry.unwrap(), receipt);
    assert_eq!(manager.input(request.clone()).await.unwrap(), receipt);
    assert_eq!(manager.pending_events(&launch.key, "wrong-controller", 0).await.unwrap_err(), "pipe_controller_mismatch");
    assert_eq!(manager.resume(&launch.key, "wrong-controller", 0).await.unwrap_err(), "pipe_controller_mismatch");
    assert!(matches!(manager.resume(&launch.key, &launch.session.controller_id, 0).await.unwrap().body,
        ProcessControlBody::State { input_seq: 1, prepared_input_seq: 1, input_unknown: false, stopping: false, .. }));
    let events = outputs(&manager, &launch.key, b"PIPE_ECHO:one\n").await;
    let bytes: Vec<u8> = events.iter().filter_map(|e| match &e.body {
        ProcessOutputBody::Output { stream: PipeStream::Stdout, data } => Some(STANDARD.decode(data).unwrap()),
        _ => None,
    }).flatten().collect();
    assert_eq!(bytes.windows(b"PIPE_ECHO:one\n".len()).filter(|w| *w == b"PIPE_ECHO:one\n").count(), 1);
    let mut conflicting = request.clone();
    conflicting.data = STANDARD.encode(b"changed\n");
    conflicting.sha256 = digest(b"changed\n");
    assert_eq!(manager.input(conflicting).await.unwrap_err(), "pipe_replay_conflict");
    assert_eq!(manager.ack(&launch.key, &launch.session.controller_id, u64::MAX).await,
        Err("pipe_ack_ahead"));
    let binding = BindProcessOwner { key: launch.key.clone(), controller_id: launch.session.controller_id.clone(),
        request_id: "binding-1".into(), binding_seq: 1, previous_owner: Some(launch.owner.clone()),
        builtin_tasks_enabled: true,
        next_owner: Some(AgentRunOwner { agent_run_id: "run-two".into(), execution_epoch: 2 }), after_input_seq: 1 };
    let bound = manager.bind_owner(binding.clone()).await.unwrap();
    assert!(matches!(bound.body, ProcessControlBody::OwnerBound { builtin_tasks_enabled: true, .. }));
    assert_eq!(manager.bind_owner(binding.clone()).await.unwrap(), bound);
    let stale = manager.input(input(&launch, 2, b"stale\n")).await.unwrap();
    assert!(matches!(stale.body, ProcessControlBody::Refused { ref code, .. } if code == "pipe_owner_mismatch"));
    launch.owner = binding.next_owner.unwrap();
    let next = manager.input(input(&launch, 2, b"two\n")).await.unwrap();
    assert!(matches!(next.body, ProcessControlBody::InputWritten { .. }));
    outputs(&manager, &launch.key, b"PIPE_ECHO:two\n").await;
    let capability = BindProcessOwner { key: launch.key.clone(),
        controller_id: launch.session.controller_id.clone(), request_id: "binding-capability".into(),
        binding_seq: 2, previous_owner: Some(launch.owner.clone()), next_owner: Some(launch.owner.clone()),
        builtin_tasks_enabled: false, after_input_seq: 2 };
    let capability_receipt = manager.bind_owner(capability.clone()).await.unwrap();
    assert!(matches!(capability_receipt.body,
        ProcessControlBody::OwnerBound { binding_seq: 2, builtin_tasks_enabled: false, .. }));
    assert_eq!(manager.bind_owner(capability.clone()).await.unwrap(), capability_receipt);
    let mut conflict = capability; conflict.builtin_tasks_enabled = true;
    assert!(matches!(manager.bind_owner(conflict).await.unwrap().body,
        ProcessControlBody::Refused { ref code, .. } if code == "pipe_owner_receipt_retired_or_conflict"));
    assert!(matches!(manager.resume(&launch.key, &launch.session.controller_id, 0).await.unwrap().body,
        ProcessControlBody::State { binding_seq: 2, builtin_tasks_enabled: false, .. }));
    // close=true must deliver actual OS EOF, not merely flush the Tokio File.
    // The echo child has no QUIT command here and must finish naturally.
    let close = ProcessInputV1::new(launch.key.clone(), launch.owner.clone(),
        launch.session.controller_id.clone(), 3, b"", true).unwrap();
    let close_receipt = manager.input(close.clone()).await.unwrap();
    assert!(matches!(close_receipt.body, ProcessControlBody::InputWritten { input_seq: 3, .. }));
    assert_eq!(manager.input(close).await.unwrap(), close_receipt);
    let natural_exit = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let live = manager.get(&launch.key).unwrap();
            let ledger = live.ledger.lock().await;
            if ledger.leader_exited && ledger.tree_stopped { break; }
            drop(ledger);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await;
    if natural_exit.is_err() {
        // Clean only this test-owned child before reporting the exact failure.
        let _ = manager.terminate(&launch.key, "failed-eof-cleanup", 5000).await;
        panic!("acknowledged close did not deliver EOF to the real native child");
    }
    let stopped = manager.terminate(&launch.key, "stop-1", 5000).await.unwrap();
    assert!(matches!(stopped.body, ProcessControlBody::Terminated { leader_exited: true, tree_stopped: true, .. }));
    assert!(manager.open(&launch, spec(&root, "echo"), None).is_err());
    let saved = read_ledger(&ledger_path(&root.join("process-pipes"), &launch.key)).unwrap();
    assert!(saved.tree_stopped);
    assert_eq!(saved.written_input_seq, 3);
    assert_eq!(saved.binding_seq, 2);
    assert!(!saved.builtin_tasks_enabled);
    let journal = std::fs::read_to_string(ledger_path(&root.join("process-pipes"), &launch.key)).unwrap();
    assert!(!journal.contains("\"data\"") && !journal.contains(&STANDARD.encode(b"one\n")));
    let final_seq = tokio::time::timeout(Duration::from_secs(8), async {
        let mut cursor = 0;
        let mut clean_exit_seen = false;
        loop {
            let events = manager.pending_events(&launch.key, &launch.session.controller_id, cursor).await.unwrap();
            for event in &events {
                if let ProcessOutputBody::Exited { exit_code, signal } = &event.body {
                    assert_eq!(*exit_code, Some(0), "EOF must allow a successful natural exit");
                    assert_eq!(*signal, None);
                    clean_exit_seen = true;
                }
            }
            if let Some(event) = events.last() {
                cursor = event.event_seq;
                manager.ack(&launch.key, &launch.session.controller_id, cursor).await.unwrap();
            }
            if manager.get(&launch.key).unwrap().output_finished.load(Ordering::Acquire) {
                assert!(clean_exit_seen, "natural exit receipt must be observed before release");
                break cursor;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let released = manager.release(&launch.key, &launch.session.controller_id, "complete-release", final_seq, false).await.unwrap();
    assert!(matches!(released.body, ProcessControlBody::Released { output_abandoned: false, .. }));
    assert_eq!(manager.release(&launch.key, &launch.session.controller_id, "complete-release", final_seq, false).await.unwrap(), released);
    assert!(manager.keys().is_empty());
    drop(manager);
    // Reusing a durable process id, even after ACK/manager loss, never spawns.
    let recovered = PipeManager::new(&root, "node-fixture").unwrap();
    launch.owner = AgentRunOwner { agent_run_id: "run-one".into(), execution_epoch: 9 };
    assert_eq!(recovered.open(&launch, spec(&root, "echo"), None).unwrap_err(), "pipe_process_completed");
    recovered.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

// A full output replay window cannot consume the separate termination budget.
#[tokio::test]
async fn saturated_output_is_bounded_and_does_not_block_tree_stop() {
    let root = private_root("backpressure");
    let manager = PipeManager::new(&root, "node-fixture").unwrap();
    let mut launch = launch("process-flood");
    launch.cwd = root.to_string_lossy().into();
    manager.open(&launch, spec(&root, "flood"), None).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let pending = manager.pending_events(&launch.key, &launch.session.controller_id, 0).await.unwrap();
            assert!(pending.len() <= MAX_UNACKED_EVENTS);
            if pending.len() == MAX_UNACKED_EVENTS { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let began = tokio::time::Instant::now();
    let reply = manager.terminate(&launch.key, "stop-full-window", 4000).await.unwrap();
    assert!(began.elapsed() < Duration::from_secs(5));
    assert!(matches!(reply.body, ProcessControlBody::Terminated { leader_exited: true, tree_stopped: true, .. }));
    let first = manager.pending_events(&launch.key, &launch.session.controller_id, 0).await.unwrap();
    let last = first.last().unwrap().event_seq;
    manager.ack(&launch.key, &launch.session.controller_id, last).await.unwrap();
    // Semaphore release must wake the blocked pump without another external event.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !manager.pending_events(&launch.key, &launch.session.controller_id, last).await.unwrap().is_empty() { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    drop(manager);
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn durable_prepare_crash_never_restarts_even_with_a_new_epoch() {
    let root = private_root("crash");
    let manager = PipeManager::new(&root, "node-fixture").unwrap();
    let mut launch = launch("prepared-before-crash");
    launch.cwd = root.to_string_lossy().into();
    let mut ledger = Ledger::prepared(&launch, launch.digest().unwrap());
    ledger.prepared_input_seq = 1;
    let path = ledger_path(&root.join("process-pipes"), &launch.key);
    create_ledger(&path, &ledger).unwrap();
    assert_eq!(manager.open(&launch, spec(&root, "echo"), None).unwrap_err(), "pipe_launch_unknown");
    launch.key.process_epoch += 1;
    assert_eq!(manager.open(&launch, spec(&root, "echo"), None).unwrap_err(), "pipe_launch_conflict");
    assert_eq!(manager.keys().len(), 0);
    drop(manager);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn input_receipt_retirement_and_prepared_write_fence_are_not_replay_permissions() {
    let launch = launch("receipt-ledger");
    let mut ledger = Ledger::prepared(&launch, launch.digest().unwrap());
    for sequence in 1..=(MAX_INPUT_RECEIPTS as u64 + 1) {
        let request = input(&launch, sequence, b"not-persisted-plaintext\n");
        let envelope = request.envelope_digest().unwrap();
        assert!(ledger.check_input(&request, &envelope).unwrap().is_none());
        ledger.prepared_input_seq = sequence;
        ledger.written_input_seq = sequence;
        ledger.retain_receipt(InputReceipt { input_seq: sequence, request_id: request.request_id,
            envelope_digest: envelope, written: true });
    }
    assert_eq!(ledger.receipts.len(), MAX_INPUT_RECEIPTS);
    let old = input(&launch, 1, b"not-persisted-plaintext\n");
    assert!(matches!(ledger.check_input(&old, &old.envelope_digest().unwrap()), Err("pipe_receipt_retired_or_unknown")));
    ledger.prepared_input_seq += 1;
    let uncertain = input(&launch, ledger.prepared_input_seq, b"could-have-been-written\n");
    assert!(matches!(ledger.check_input(&uncertain, &uncertain.envelope_digest().unwrap()), Err("pipe_receipt_retired_or_unknown")));
    let future = input(&launch, ledger.prepared_input_seq + 1, b"must-not-write\n");
    assert!(matches!(ledger.check_input(&future, &future.envelope_digest().unwrap()), Err("pipe_input_fenced")));
    let text = serde_json::to_string(&ledger).unwrap();
    assert!(!text.contains("not-persisted-plaintext") && !text.contains("could-have-been-written"));
}

#[test]
fn launch_debug_and_closed_arguments_do_not_leak_or_accept_source_paths() {
    let mut launch = launch("argument-check");
    launch.args.push(ProcessArgument::Literal { value: "secret-fixture-only".into() });
    assert!(!format!("{launch:?}").contains("secret-fixture-only"));
    launch.args.push(ProcessArgument::MaterializedFile { path: "C:/source/bootstrap.txt".into() });
    assert_eq!(launch.validate(), Err("pipe_material_reference"));
    launch.args.pop();
    assert!(launch.validate().is_ok());
    for name in ["CODEX_HOME", "codex_home", "HOME", "USERPROFILE", "OPENAI_API_KEY"] {
        launch.environment = vec![(name.into(), "controller-private-fixture".into())];
        assert_eq!(launch.validate(), Err("pipe_environment"), "{name}");
        assert!(!format!("{launch:?}").contains("controller-private-fixture"));
    }
    launch.environment = vec![("NO_COLOR".into(), "1".into())];
    assert!(launch.validate().is_ok());
}


// Cancelling while the consumer disappears must have an explicit, durable
// abandonment path. Stop alone retains replay; Release never silently claims
// that unacknowledged native output was consumed or complete.
#[tokio::test]
async fn explicit_abandonment_releases_full_window_without_any_ack() {
    let root = private_root("abandon");
    let manager = PipeManager::new(&root, "node-fixture").unwrap();
    let mut launch = launch("process-abandon");
    launch.cwd = root.to_string_lossy().into();
    let mut wake = manager.subscribe();
    manager.open(&launch, spec(&root, "flood"), None).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if manager.pending_events(&launch.key, &launch.session.controller_id, 0).await.unwrap().len() == MAX_UNACKED_EVENTS { break; }
            wake.changed().await.unwrap();
        }
    }).await.unwrap();
    assert_eq!(manager.release(&launch.key, &launch.session.controller_id, "early-release", 0, true).await.unwrap_err(),
        "pipe_release_unconfirmed");
    manager.terminate(&launch.key, "stop-before-release", 4000).await.unwrap();
    assert_eq!(manager.release(&launch.key, &launch.session.controller_id, "bad-clean-release", 0, false).await.unwrap_err(),
        "pipe_output_not_settled");
    let live = manager.get(&launch.key).unwrap();
    let released = manager.release(&launch.key, &launch.session.controller_id, "abandon-release", 0, true).await.unwrap();
    let final_seq = match released.body {
        ProcessControlBody::Released { final_event_seq, acked_event_seq: 0, output_abandoned: true, .. } => final_event_seq,
        _ => panic!("expected explicit output abandonment"),
    };
    assert!(manager.keys().is_empty());
    assert_eq!(manager.release(&launch.key, &launch.session.controller_id, "abandon-release", 0, true).await.unwrap(), released);
    assert!(manager.release(&launch.key, "wrong-controller", "abandon-release", 0, true).await.is_err());
    tokio::time::timeout(Duration::from_secs(5), async {
        while !live.output_finished.load(Ordering::Acquire) { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    assert_eq!(live.output.lock().await.next_seq, final_seq, "no late output past the recorded release boundary");
    assert!(read_ledger(&ledger_path(&root.join("process-pipes"), &launch.key)).unwrap().release_receipt.unwrap().output_abandoned);
    let mut next = launch.clone();
    next.key.process_id = "new-process-after-abandonment".into();
    manager.open(&next, spec(&root, "echo"), None).unwrap();
    manager.shutdown().await;
    drop(live);
    drop(manager);
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::remove_dir_all(root).unwrap();
}
