//! Owner tests for the A-side pipe registry.
//!
//! These use a **real** private journal on the real filesystem plus a fake
//! authenticated socket (`Hub::attach` + an `mpsc` outbox). They are not a real
//! Node/Web end-to-end run: no native process, no client and no remote node are
//! involved. `spool.rs` has its own 11 owner tests and is not duplicated here.

use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
    task::Poll,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use loom_protocol::CliReport;
use loom_protocol::ServerMessage;
use loom_protocol::builtin_pipe::BUILTIN_PIPE_VERSION;
use loom_protocol::run_bundle::{
    BundleArtifact, BundleFile, RUN_BUNDLE_VERSION, RunBundleV1, bundle_digest,
};
use rovai_core::execution_node::NodeStore;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::{mpsc, oneshot};

use super::super::{Hub, Outbound, Outbox};
use super::*;
use crate::auth::Sessions;

const WAIT: Duration = Duration::from_secs(5);
const QUIET: Duration = Duration::from_millis(150);

fn owner(tag: &str, epoch: u64) -> AgentRunOwner {
    AgentRunOwner {
        agent_run_id: tag.to_owned(),
        execution_epoch: epoch,
    }
}

fn process_key() -> RemoteProcessKey {
    RemoteProcessKey {
        node_id: String::new(), // replaced by the fixture
        process_id: "host-1".into(),
        process_epoch: 3,
    }
}

fn scope() -> RemoteHostScope {
    RemoteHostScope {
        member_id: "member-1".into(),
        logical_session_id: "session-1".into(),
        workspace_id: "work-1".into(),
    }
}

/// The exact CLI identity the fixture's fake socket reports, so the parent's
/// `process_connection_generation` admission sees a pipe-capable node.
fn pipe_cli() -> CliReport {
    CliReport {
        adapter_kind: "claude-code-cli".into(),
        path: "/opt/fixture/claude".into(),
        version: None,
        path_present: true,
        installation_identity: Some(format!("sha256:{}", "a".repeat(64))),
        installation_generation: Some(7),
    }
}

fn open_for(key: &RemoteProcessKey, controller: &str) -> ProcessOpenV1 {
    ProcessOpenV1 {
        codex_hook_grant: None,
        version: PROCESS_PIPE_VERSION,
        key: wire_key(key),
        session: ProcessSessionOwner {
            member_id: "member-1".into(),
            logical_session_id: "session-1".into(),
            workspace_id: "work-1".into(),
            controller_id: controller.to_owned(),
        },
        owner: wire_owner(&owner("run-1", 1)),
        builtin_tasks_enabled: false,
        adapter_kind: "claude-code-cli".into(),
        catalog_generation: 7,
        program_identity: format!("sha256:{}", "a".repeat(64)),
        program: "/opt/fixture/claude".into(),
        cwd: "/opt/fixture/work".into(),
        args: vec![ProcessArgument::Literal {
            value: "--print".into(),
        }],
        environment: Vec::new(),
        bundle: None,
    }
}

fn add_reviewed_codex_hook(open: &mut ProcessOpenV1) {
    let settings=br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"fixture-command","timeout":5}]}]}}"#;
    let bootstrap=b"[SESSION_CHARTER]\nfixture\n[/SESSION_CHARTER]";
    let mut bundle=RunBundleV1 {
        version:RUN_BUNDLE_VERSION,
        bundle_id:loom_protocol::run_bundle::bundle_id_for(&open.owner.agent_run_id,1),
        run_id:open.owner.agent_run_id.clone(),attempt:1,agent_id:open.session.member_id.clone(),
        adapter_kind:"codex-cli".into(),selection_revision:"fixture-revision".into(),
        source_skill_root:None,digest:String::new(),
        files:vec![
            BundleFile{artifact:BundleArtifact::BootstrapPrompt,label:"bootstrap".into(),path:"bootstrap.txt".into(),
                bytes:bootstrap.len(),content:STANDARD.encode(bootstrap)},
            BundleFile{artifact:BundleArtifact::RuntimeSettings,label:"settings".into(),path:"settings.json".into(),
                bytes:settings.len(),content:STANDARD.encode(settings)},
        ],
    };
    bundle.digest=bundle_digest(&bundle).unwrap();
    open.adapter_kind="codex-cli".into();open.program="/opt/fixture/codex".into();
    open.args=vec![ProcessArgument::Literal{value:"app-server".into()}];
    open.version=loom_protocol::command_hooks::CODEX_HOOK_PIPE_VERSION;
    open.codex_hook_grant=Some(loom_protocol::command_hooks::CodexHookGrantV1 {
        version:loom_protocol::command_hooks::CODEX_HOOK_GRANT_VERSION,
        settings_digest:loom_protocol::command_hooks::digest(settings),
        review_digest:format!("sha256:{}","c".repeat(64)),
    });
    open.bundle=Some(bundle);
    open.validate().unwrap();
}

fn output_event(key: &RemoteProcessKey, seq: u64, text: &str) -> ProcessOutputEvent {
    ProcessOutputEvent {
        key: wire_key(key),
        event_seq: seq,
        body: ProcessOutputBody::Output {
            stream: PipeStream::Stdout,
            data: STANDARD.encode(text),
        },
    }
}

fn exited_event(key: &RemoteProcessKey, seq: u64, code: i32) -> ProcessOutputEvent {
    ProcessOutputEvent {
        key: wire_key(key),
        event_seq: seq,
        body: ProcessOutputBody::Exited {
            exit_code: Some(code),
            signal: None,
        },
    }
}

/// A real `Hub` with one fake authenticated socket, plus a real private journal.
struct Fixture {
    hub: Arc<Hub>,
    registry: Arc<PipeRegistry>,
    node_id: String,
    generation: u64,
    rx: mpsc::Receiver<Outbound>,
    data_dir: PathBuf,
    key: RemoteProcessKey,
}

impl Fixture {
    async fn new(label: &str) -> Self {
        let admin = crate::new_token().unwrap();
        let sessions = Arc::new(Sessions::new(&admin).unwrap());
        let hub = Arc::new(Hub::new(sessions, NodeStore::open_ephemeral().unwrap()));
        let (code, _) = hub.issue_pairing().await;
        let issued = hub
            .redeem(&code, IpAddr::V4(Ipv4Addr::LOCALHOST))
            .await
            .expect("pair");
        let (tx, rx) = mpsc::channel(64);
        let (cancel, _cancel_rx) = oneshot::channel();
        let generation = hub
            .attach(
                &issued.node_id,
                Outbox {
                    tx,
                    urgent: None,
                    acks: Arc::new(StdMutex::new(std::collections::HashMap::new())),
                },
                cancel,
                "linux",
                "x86_64",
                vec![pipe_cli()],
            )
            .await
            .expect("attach");
        // Node capabilities must be registered before any managed send.
        hub.set_process_versions(
            &issued.node_id,
            generation,
            vec![PROCESS_PIPE_VERSION],
            Vec::new(),
        )
        .await;
        let data_dir = std::env::temp_dir().join(format!(
            "loom-pipe-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let registry = PipeRegistry::new(Arc::downgrade(&hub), &data_dir).expect("registry");
        registry.node_connected(&issued.node_id, &generation).await;
        let mut key = process_key();
        key.node_id = issued.node_id.clone();
        Self {
            hub,
            registry,
            node_id: issued.node_id,
            generation,
            rx,
            data_dir,
            key,
        }
    }

    fn identity(&self, digest: &str) -> JournalIdentity {
        JournalIdentity::new(
            wire_key(&self.key),
            self.registry.controller_id().to_owned(),
            digest.to_owned(),
        )
        .unwrap()
    }

    fn journal(&self, digest: &str) -> spool::OrphanJournal {
        spool::inspect_existing(self.registry.root(), &self.identity(digest)).expect("journal")
    }

    async fn next_command(&mut self) -> ProcessPipeCommand {
        loop {
            let outbound = tokio::time::timeout(WAIT, self.rx.recv())
                .await
                .expect("timed out waiting for a command")
                .expect("socket closed");
            if let Outbound::Text(text) = outbound {
                match serde_json::from_str::<ServerMessage>(&text).expect("server message") {
                    ServerMessage::ProcessPipe { command } => return command,
                    _ => continue,
                }
            }
        }
    }

    /// Bounded "nothing was sent" assertion.
    async fn expect_quiet(&mut self) {
        match tokio::time::timeout(QUIET, self.rx.recv()).await {
            Err(_) => {}
            Ok(Some(Outbound::Text(text))) => panic!("unexpected command: {text}"),
            Ok(Some(_)) => {}
            Ok(None) => panic!("socket closed"),
        }
    }

    async fn reply(&self, body: ProcessControlBody) {
        self.registry
            .on_reply(
                &self.node_id,
                self.generation,
                ProcessControlReply {
                    key: wire_key(&self.key),
                    body,
                },
            )
            .await;
    }

    async fn output(&self, event: ProcessOutputEvent) {
        self.registry
            .on_output(&self.node_id, self.generation, event)
            .await;
    }

    async fn output_from(&self, generation: u64, event: ProcessOutputEvent) {
        self.registry
            .on_output(&self.node_id, generation, event)
            .await;
    }

    async fn start(&mut self, open: ProcessOpenV1) -> Arc<LivePipe> {
        self.start_with(open, None).await
    }

    /// Starts one pipe through the internal admission seam (the parent's
    /// `revalidate`/`ensure_workspace` workspace gate is not exercised here).
    async fn start_with(
        &mut self,
        open: ProcessOpenV1,
        materialization: Option<BundleMaterializationV1>,
    ) -> Arc<LivePipe> {
        let digest = open.digest().expect("digest");
        let key = core_key(&open.key).expect("key");
        let guard = StartGuard::new(Arc::clone(&self.registry), key.clone(), digest.clone());
        let registry = Arc::clone(&self.registry);
        let scope = scope();
        let task = tokio::spawn(async move {
            let mut guard = guard;
            let result = registry.begin_pipe(open, scope, &mut guard).await;
            if result.is_ok() {
                guard.disarm();
            }
            result
        });
        match self.next_command().await {
            ProcessPipeCommand::Open { launch } => {
                assert_eq!(launch.digest().expect("digest"), digest);
            }
            other => panic!("expected open, got {other:?}"),
        }
        self.reply(ProcessControlBody::Opened {
            launch_digest: digest.clone(),
            node_pid: 4242,
            materialization,
        })
        .await;
        let pipe = task.await.expect("join").expect("pipe");
        // Attach the live socket generation and consume the verbatim replay.
        self.registry
            .node_connected(&self.node_id, &self.generation)
            .await;
        match self.next_command().await {
            ProcessPipeCommand::Open { launch } => {
                assert_eq!(launch.digest().expect("digest"), digest);
            }
            other => panic!("expected replayed open, got {other:?}"),
        }
        match self.next_command().await {
            ProcessPipeCommand::Resume {
                after_event_seq, ..
            } => assert_eq!(after_event_seq, 0),
            other => panic!("expected resume, got {other:?}"),
        }
        pipe
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

// A start future dropped after the journal and `Open` were sent must disable
// `Open` replay, retain the journal, queue a bounded stop for the exact key and
// never leave an unmanaged launch behind.
#[tokio::test]
async fn dropped_start_disables_open_replay_and_queues_stop() {
    let mut fixture = Fixture::new("dropped-start").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let digest = open.digest().unwrap();
    let key = fixture.key.clone();
    let guard = StartGuard::new(Arc::clone(&fixture.registry), key.clone(), digest.clone());
    let registry = Arc::clone(&fixture.registry);
    let task = tokio::spawn(async move {
        // The guard is intentionally not disarmed: this is the dropped-start case.
        let mut guard = guard;
        let _ = registry.begin_pipe(open, scope(), &mut guard).await.is_ok();
    });
    match fixture.next_command().await {
        ProcessPipeCommand::Open { .. } => {}
        other => panic!("expected open, got {other:?}"),
    }
    task.abort();
    let _ = task.await;
    // The dropped future queued a stop for the exact key.
    match fixture.next_command().await {
        ProcessPipeCommand::Terminate {
            key: stopped,
            request_id,
            budget_ms,
        } => {
            assert_eq!(stopped, wire_key(&key));
            assert!(request_id.starts_with("stop."), "{request_id}");
            assert!((1..=MAX_TERMINATE_BUDGET_MS).contains(&budget_ms));
        }
        other => panic!("expected terminate, got {other:?}"),
    }
    // Reconnect replays a resume, never a second `Open`.
    fixture
        .registry
        .node_disconnected(&fixture.node_id, fixture.generation)
        .await;
    fixture
        .registry
        .node_connected(&fixture.node_id, &fixture.generation)
        .await;
    let replayed = fixture.next_command().await;
    assert!(
        !matches!(replayed, ProcessPipeCommand::Open { .. }),
        "dropped start must never replay Open: {replayed:?}"
    );
    // The journal survives as evidence for the exact launch digest.
    let journal = fixture.journal(&digest);
    assert_eq!(journal.highest_received_seq(), 0);
}

// A write returns its count only after a matching receipt, and an ambiguous
// write can never mint a new sequence: the original envelope is retried as-is.
#[tokio::test]
async fn input_receipt_gates_write_and_ambiguous_write_mints_no_sequence() {
    let mut fixture = Fixture::new("input").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let pipe = fixture.start(open).await;
    // Sequence zero comes from the verified `Opened`, with no wire command.
    let receipt = pipe
        .bind(Some(owner("run-1", 1)), false)
        .await
        .expect("bind");
    assert_eq!(receipt.binding_seq, 0);
    fixture.expect_quiet().await;

    let key = fixture.key.clone();
    let writer = Arc::clone(&pipe);
    let task = tokio::spawn(async move { writer.send_input(b"one\n".to_vec()).await });
    let (input_seq, request_id, digest) = match fixture.next_command().await {
        ProcessPipeCommand::Input { input } => {
            assert_eq!(input.input_seq, 1);
            assert_eq!(input.decode().unwrap(), b"one\n");
            (
                input.input_seq,
                input.request_id.clone(),
                input.envelope_digest().unwrap(),
            )
        }
        other => panic!("expected input, got {other:?}"),
    };
    assert!(!task.is_finished(), "write must wait for its receipt");
    fixture
        .reply(ProcessControlBody::InputWritten {
            input_seq,
            request_id,
            envelope_digest: digest,
        })
        .await;
    assert_eq!(task.await.unwrap(), Ok(4));

    // Second write stays unresolved: no new sequence is ever allocated for it.
    let writer = Arc::clone(&pipe);
    let stalled = tokio::spawn(async move { writer.send_input(b"two\n".to_vec()).await });
    let stalled_input = match fixture.next_command().await {
        ProcessPipeCommand::Input { input } => {
            assert_eq!(input.input_seq, 2);
            input
        }
        other => panic!("expected input, got {other:?}"),
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    stalled.abort();
    let _ = stalled.await;
    assert_eq!(pipe.state().ambiguous_input_seq, Some(2));
    assert_eq!(
        pipe.send_input(b"three\n".to_vec()).await,
        Err(RemoteProcessError::UnknownOutcome)
    );
    fixture.expect_quiet().await;
    // The exact original envelope is replayed after a reconnect.
    fixture
        .registry
        .node_disconnected(&fixture.node_id, fixture.generation)
        .await;
    fixture
        .registry
        .node_connected(&fixture.node_id, &fixture.generation)
        .await;
    let mut replayed = None;
    for _ in 0..4 {
        if let ProcessPipeCommand::Input { input } = fixture.next_command().await {
            replayed = Some(input);
            break;
        }
    }
    let replayed = replayed.expect("replayed input");
    assert_eq!(replayed.input_seq, stalled_input.input_seq);
    assert_eq!(replayed.request_id, stalled_input.request_id);
    assert_eq!(
        replayed.envelope_digest().unwrap(),
        stalled_input.envelope_digest().unwrap()
    );
    assert_eq!(replayed.decode().unwrap(), b"two\n");
}

// Output from a socket that is no longer the current generation is fenced: no
// durable advance and no ACK. After the reconnect the same event is journalled
// durably before its ACK.
#[tokio::test]
async fn stale_generation_output_is_fenced_and_current_output_is_durable() {
    let mut fixture = Fixture::new("generation").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let digest = open.digest().unwrap();
    let pipe = fixture.start(open).await;
    let generation = fixture.generation;

    // Detached socket: queued output from it can never advance the state.
    fixture
        .registry
        .node_disconnected(&fixture.node_id, fixture.generation)
        .await;
    fixture
        .output_from(generation, output_event(&fixture.key, 1, "stale"))
        .await;
    fixture.expect_quiet().await;
    let journal = fixture.journal(&digest);
    assert_eq!(journal.highest_received_seq(), 0);
    assert_eq!(journal.pending_count(), 0);

    // Real reconnect at the current generation: replay, then durable output.
    fixture
        .registry
        .node_connected(&fixture.node_id, &generation)
        .await;
    for _ in 0..2 {
        let _ = fixture.next_command().await;
    }
    fixture.output(output_event(&fixture.key, 1, "fresh")).await;
    match fixture.next_command().await {
        ProcessPipeCommand::Ack { event_seq, .. } => assert_eq!(event_seq, 1),
        other => panic!("expected ack, got {other:?}"),
    }
    // The ACK above proves the event was already durable.
    let journal = fixture.journal(&digest);
    assert_eq!(journal.highest_received_seq(), 1);
    assert_eq!(journal.pending_count(), 1);
    assert!(pipe.state().acked_seq >= 1);
}

// Exit evidence comes from the durable `Exited` record, not from consumer
// progress: unread stdout must not delay it or fake a drain.
#[tokio::test]
async fn exit_resolves_without_consumer_drain() {
    let mut fixture = Fixture::new("exit").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let digest = open.digest().unwrap();
    let pipe = fixture.start(open).await;
    fixture
        .output(output_event(&fixture.key, 1, "unread"))
        .await;
    match fixture.next_command().await {
        ProcessPipeCommand::Ack { event_seq, .. } => assert_eq!(event_seq, 1),
        other => panic!("expected ack, got {other:?}"),
    }
    fixture.output(exited_event(&fixture.key, 2, 7)).await;
    match fixture.next_command().await {
        ProcessPipeCommand::Ack { event_seq, .. } => assert_eq!(event_seq, 2),
        other => panic!("expected ack, got {other:?}"),
    }
    let receipt = tokio::time::timeout(WAIT, pipe.wait_exit())
        .await
        .expect("exit must not wait for a reader")
        .expect("exit receipt");
    assert_eq!(receipt.exit_code, Some(7));
    // The unread bytes are still retained as evidence.
    let journal = fixture.journal(&digest);
    assert_eq!(journal.pending_count(), 1);
    assert_eq!(journal.state(), spool::OrphanState::ExitedWithPending);
}

// An exact duplicate `OwnerBound` is idempotent; a different owner at a used
// sequence is rejected instead of silently stealing the binding.
#[tokio::test]
async fn owner_receipt_is_idempotent_and_conflicts_are_rejected() {
    let mut fixture = Fixture::new("owner").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let pipe = fixture.start(open).await;
    assert_eq!(
        pipe.bind(Some(owner("run-1", 1)), false)
            .await
            .unwrap()
            .binding_seq,
        0
    );
    fixture.expect_quiet().await;

    let next = owner("run-2", 1);
    let binder = {
        let pipe = Arc::clone(&pipe);
        let next = next.clone();
        tokio::spawn(async move { pipe.bind(Some(next), false).await })
    };
    let binding = match fixture.next_command().await {
        ProcessPipeCommand::BindOwner { binding } => binding,
        other => panic!("expected bind, got {other:?}"),
    };
    assert_eq!(binding.binding_seq, 1);
    assert_eq!(binding.previous_owner, Some(wire_owner(&owner("run-1", 1))));
    assert_eq!(binding.after_input_seq, 0);
    fixture
        .reply(ProcessControlBody::OwnerBound {
            request_id: binding.request_id.clone(),
            binding_seq: binding.binding_seq,
            owner: Some(wire_owner(&next)),
            builtin_tasks_enabled: false,
            input_seq: binding.after_input_seq,
        })
        .await;
    assert_eq!(binder.await.unwrap().unwrap().binding_seq, 1);
    // Exact duplicate receipt: no fault, no advance.
    fixture
        .reply(ProcessControlBody::OwnerBound {
            request_id: binding.request_id.clone(),
            binding_seq: binding.binding_seq,
            owner: Some(wire_owner(&next)),
            builtin_tasks_enabled: false,
            input_seq: binding.after_input_seq,
        })
        .await;
    assert!(pipe.state().fault.is_none());
    assert_eq!(pipe.state().binding_seq, 1);
    assert_eq!(pipe.state().owner, Some(next.clone()));

    // Same sequence, different owner is never accepted.
    fixture
        .reply(ProcessControlBody::OwnerBound {
            request_id: binding.request_id,
            binding_seq: binding.binding_seq,
            owner: Some(wire_owner(&owner("run-3", 1))),
            builtin_tasks_enabled: false,
            input_seq: binding.after_input_seq,
        })
        .await;
    assert_eq!(pipe.state().fault, Some(PipeFault::ControlIdentity));
    assert_eq!(pipe.state().owner, Some(next));
}

// A normal release records its intent durably before the wire command, records
// the completion durably after the matching receipt, and a restart sees that
// released evidence honestly instead of adopting the key.
#[tokio::test]
async fn normal_release_is_durable_and_restart_sees_it() {
    let mut fixture = Fixture::new("release").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let digest = open.digest().unwrap();
    let pipe = fixture.start(open).await;
    fixture.output(exited_event(&fixture.key, 1, 0)).await;
    match fixture.next_command().await {
        ProcessPipeCommand::Ack { event_seq, .. } => assert_eq!(event_seq, 1),
        other => panic!("expected ack, got {other:?}"),
    }
    let key = fixture.key.clone();
    let registry = Arc::clone(&fixture.registry);
    let releaser = tokio::spawn(async move { registry.release(&key, false).await });
    // The release path re-sends the durable highest ACK on this socket first, so
    // this socket has ACKed before `Release` (existing product behaviour).
    match fixture.next_command().await {
        ProcessPipeCommand::Ack { key, event_seq, .. } => {
            assert_eq!(event_seq, 1, "the pre-release ACK repeats the durable highest");
            assert!(key == wire_key(&fixture.key), "ACK belongs to this pipe");
        }
        other => panic!("expected the pre-release ack, got {other:?}"),
    }
    let (request_id, abandon_output) = match fixture.next_command().await {
        ProcessPipeCommand::Release {
            request_id,
            abandon_output,
            acked_event_seq,
            ..
        } => {
            assert_eq!(acked_event_seq, 1);
            (request_id, abandon_output)
        }
        other => panic!("expected release, got {other:?}"),
    };
    assert!(!abandon_output);
    let receipts = std::fs::read(fixture.registry.root().join("control-receipts.json"))
        .expect("durable release intent");
    let log: serde_json::Value = serde_json::from_slice(&receipts).unwrap();
    assert!(log["receipts"].as_array().unwrap().iter().any(|entry| {
        entry["phase"] == "intent"
            && entry["requestId"] == serde_json::Value::String(request_id.clone())
            && entry["kind"] == "release"
    }));
    fixture
        .reply(ProcessControlBody::Released {
            request_id,
            final_event_seq: 1,
            acked_event_seq: 1,
            output_abandoned: false,
        })
        .await;
    assert_eq!(releaser.await.unwrap(), Ok(()));
    assert!(pipe.state().released);
    // Only a durable receipt frees the slot.
    assert_eq!(
        fixture.registry.release(&fixture.key, false).await,
        Err(RemoteProcessError::Unavailable)
    );
    let log: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.registry.root().join("control-receipts.json")).unwrap(),
    )
    .unwrap();
    assert!(
        log["receipts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["phase"] == "released")
    );

    // Restart: the retained journal plus the durable completion are reported as
    // already released, and the key is never adopted (no second journal).
    let restarted = PipeRegistry::new(Arc::downgrade(&fixture.hub), &fixture.data_dir).unwrap();
    let reports = restarted.orphan_reports();
    let report = reports
        .iter()
        .find(|report| report.key == fixture.key)
        .expect("retained journal is reported");
    assert!(report.released);
    assert_eq!(report.note, "orphan_journal_read_only_no_marker");
    // The guard must describe the very open that is admitted: a digest from the
    // pre-restart open fails the identity check before the orphan gate runs.
    let reopened = open_for(&fixture.key, restarted.controller_id());
    let reopened_digest = reopened.digest().expect("reopened open digest");
    assert_ne!(
        reopened_digest, digest,
        "a new controller id is a different open"
    );
    let mut guard = StartGuard::new(
        Arc::clone(&restarted),
        fixture.key.clone(),
        reopened_digest,
    );
    assert!(matches!(
        restarted.begin_pipe(reopened, scope(), &mut guard).await,
        Err(RemoteProcessError::UnknownOutcome)
    ));
    fixture.expect_quiet().await;
}

// The frozen-target conversion is pure, keeps the adapter identity and the
// bundle digest, and refuses an identity mismatch.
#[test]
fn open_conversion_is_pure_and_refuses_identity_mismatch() {
    let key = RemoteProcessKey {
        node_id: "node-b".into(),
        process_id: "host-1".into(),
        process_epoch: 9,
    };
    let mut launch = ScopedRemoteLaunch {
        codex_hook_grant: None,
        key: key.clone(),
        initial_owner: owner("run-1", 3),
        builtin_tasks_enabled: false,
        host_scope: RemoteHostScope {
            member_id: "member-1".into(),
            logical_session_id: "session-1".into(),
            workspace_id: "work-1".into(),
        },
        target: rovai_core::remote_process::FrozenRemoteTarget {
            node_id: "node-b".into(),
            node_generation: 7,
            workspace_id: "work-1".into(),
            workspace_root: "/opt/fixture/work".into(),
            adapter_kind: "claude-code-cli".into(),
            program: "/opt/fixture/claude".into(),
            program_identity: format!("sha256:{}", "a".repeat(64)),
            configuration_digest: "sha256:frozen".into(),
        },
        arguments: vec![RemoteArgument::Literal {
            value: "--print".into(),
        }],
        environment: rovai_core::remote_process::NonSecretEnvironment::default(),
        bundle: None,
    };
    let open = open_from_launch(&launch, "ctl-test").expect("open");
    assert_eq!(open.session.controller_id, "ctl-test");
    assert_eq!(open.adapter_kind, "claude-code-cli");
    assert_eq!(open.catalog_generation, 7);
    assert_eq!(open.cwd, "/opt/fixture/work");
    assert_eq!(open.args.len(), 1);
    let digest = open.digest().expect("digest");
    assert_eq!(digest.len(), 64);
    let mut codex_wire = open.clone();
    add_reviewed_codex_hook(&mut codex_wire);
    let mut codex = launch.clone();
    codex.target.adapter_kind = codex_wire.adapter_kind.clone();
    codex.target.program = codex_wire.program.clone();
    codex.arguments = vec![RemoteArgument::Literal { value: "app-server".into() }];
    codex.bundle = codex_wire.bundle.clone();
    codex.codex_hook_grant = codex_wire.codex_hook_grant.clone();
    assert_eq!(open_from_launch(&codex, "ctl-test").unwrap(), codex_wire);
    assert_eq!(open.version, PROCESS_PIPE_VERSION);
    assert!(serde_json::to_value(&open).unwrap().get("codexHookGrant").is_none());
    // Owner, epoch and argument changes each change the canonical digest.
    launch.initial_owner = owner("run-2", 3);
    let changed = open_from_launch(&launch, "ctl-test").expect("open");
    assert_ne!(changed.digest().unwrap(), digest);
    // A node/workspace mismatch is refused, never silently repaired.
    launch.target.node_id = "node-other".into();
    assert_eq!(
        open_from_launch(&launch, "ctl-test").map(|open| open.key),
        Err(RemoteProcessError::IdentityMismatch)
    );
}

// Negotiation has a separate enqueue fence: withdrawing v2 while bounded
// capacity is unavailable cannot send a v2 grant to the now-v1 socket.
#[tokio::test]
async fn reviewed_hook_open_requires_current_v2_capability_even_after_backpressure() {
    let mut f=Fixture::new("hook-version").await;
    let mut open=open_for(&f.key,"controller-fixture");
    add_reviewed_codex_hook(&mut open);
    assert_eq!(f.hub.process_connection_generation(&open).await,Err("pipe_version_unsupported"));
    let message=ServerMessage::ProcessPipe{command:ProcessPipeCommand::Open{launch:open.clone()}};
    assert_eq!(f.hub.send_node_message_generation(&f.node_id,f.generation,message.clone(),false).await,
        Err("pipe_version_unsupported"));
    f.expect_quiet().await;
    // v2 extends Open only; stdin/stop/ACK still require the base v1 contract.
    f.hub.set_process_versions(&f.node_id,f.generation,vec![2],Vec::new()).await;
    assert_eq!(f.hub.process_connection_generation(&open).await,Err("pipe_version_unsupported"));
    assert_eq!(f.hub.send_node_message_generation(&f.node_id,f.generation,message.clone(),false).await,
        Err("pipe_version_unsupported"));
    f.expect_quiet().await;
    {
        let mut inner=f.hub.inner.lock().await;
        let node=inner.nodes.get_mut(&f.node_id).unwrap();
        let mut cli=pipe_cli();cli.adapter_kind="codex-cli".into();cli.path=open.program.clone();
        node.clis=vec![cli];
    }
    f.hub.set_process_versions(&f.node_id,f.generation,vec![1,2],Vec::new()).await;
    assert_eq!(f.hub.process_connection_generation(&open).await,Ok(f.generation));
    f.hub.send_node_message_generation(&f.node_id,f.generation,message.clone(),false).await.unwrap();
    assert_eq!(f.next_command().await,ProcessPipeCommand::Open{launch:open});
    let sender={
        let inner=f.hub.inner.lock().await;
        inner.nodes[&f.node_id].outbound.as_ref().unwrap().tx.clone()
    };
    for _ in 0..64 { assert!(sender.try_send(Outbound::Text("owned-backpressure-fixture".into())).is_ok()); }
    let sender_count=sender.strong_count();
    let hub=f.hub.clone();let node=f.node_id.clone();let generation=f.generation;
    let pending=tokio::spawn(async move {
        hub.send_node_message_generation(&node,generation,message,false).await
    });
    tokio::time::timeout(WAIT,async {
        while sender.strong_count()<=sender_count { tokio::task::yield_now().await; }
    }).await.expect("sender reserved by pending dispatch");
    f.hub.set_process_versions(&f.node_id,f.generation,vec![1],Vec::new()).await;
    f.rx.recv().await.unwrap();
    assert_eq!(tokio::time::timeout(WAIT,pending).await.unwrap().unwrap(),Err("pipe_version_unsupported"));
    while let Ok(frame)=f.rx.try_recv() {
        assert!(matches!(frame,Outbound::Text(ref text) if text=="owned-backpressure-fixture"));
    }
    f.expect_quiet().await;
}

// An unbundled launch must not accept a materialization receipt, and a bundled
// launch must prove the exact bundle identity with a stable root.
#[tokio::test]
async fn opened_materialization_must_match_the_launch_bundle() {
    let mut fixture = Fixture::new("materialization").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let digest = open.digest().unwrap();
    let pipe = fixture.start(open).await;
    // Unbundled launch: a node-supplied materialization is refused.
    // The receipt is wire-valid on its own, so the refusal below can only come
    // from the unbundled launch, not from the control identity gate.
    let receipt = BundleMaterializationV1 {
        bundle_id: "bundle-1".into(),
        bundle_digest: format!("sha256:{}", "a".repeat(64)),
        skill_root: "/opt/fixture/materialized".into(),
    };
    assert!(
        receipt.validate().is_ok(),
        "the receipt must be wire-valid before the launch check: {receipt:?}"
    );
    fixture
        .reply(ProcessControlBody::Opened {
            launch_digest: digest.clone(),
            node_pid: 4242,
            materialization: Some(receipt),
        })
        .await;
    assert_eq!(pipe.state().fault, Some(PipeFault::OpenDigest));
}

// The tasks flag travels with the owner binding: same owner + same flag keeps
// sequence zero, a flag-only change advances exactly one, and a stale receipt
// that differs only in the flag can never authorize the binding.
#[tokio::test]
async fn builtin_tasks_flag_is_threaded_through_owner_binding() {
    let mut fixture = Fixture::new("tasks-flag").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    assert!(!open.builtin_tasks_enabled, "never defaulted to true");
    let pipe = fixture.start(open).await;
    let run = owner("run-1", 1);
    // Sequence zero comes from the immutable `Open`, with no wire command.
    let receipt = pipe.bind(Some(run.clone()), false).await.expect("bind");
    assert_eq!(receipt.binding_seq, 0);
    assert!(!receipt.builtin_tasks_enabled);
    fixture.expect_quiet().await;
    // Same owner and same flag stays idempotent at sequence zero.
    assert_eq!(
        pipe.bind(Some(run.clone()), false)
            .await
            .expect("bind")
            .binding_seq,
        0
    );
    fixture.expect_quiet().await;

    // Flag-only change: exactly one increment and the exact wire flag.
    let binder = {
        let pipe = Arc::clone(&pipe);
        let run = run.clone();
        tokio::spawn(async move { pipe.bind(Some(run), true).await })
    };
    let binding = match fixture.next_command().await {
        ProcessPipeCommand::BindOwner { binding } => binding,
        other => panic!("expected bind, got {other:?}"),
    };
    assert_eq!(binding.binding_seq, 1);
    assert!(binding.builtin_tasks_enabled);
    assert_eq!(binding.previous_owner, Some(wire_owner(&run)));
    fixture
        .reply(ProcessControlBody::OwnerBound {
            request_id: binding.request_id.clone(),
            binding_seq: binding.binding_seq,
            owner: Some(wire_owner(&run)),
            builtin_tasks_enabled: true,
            input_seq: binding.after_input_seq,
        })
        .await;
    let accepted = binder.await.unwrap().expect("bind");
    assert_eq!(accepted.binding_seq, 1);
    assert!(accepted.builtin_tasks_enabled);
    assert!(pipe.state().builtin_tasks);

    // A second change whose receipt differs only in the flag is not accepted.
    let stale = {
        let pipe = Arc::clone(&pipe);
        let run = run.clone();
        tokio::spawn(async move { pipe.bind(Some(run), false).await })
    };
    let binding = match fixture.next_command().await {
        ProcessPipeCommand::BindOwner { binding } => binding,
        other => panic!("expected bind, got {other:?}"),
    };
    assert_eq!(binding.binding_seq, 2);
    assert!(!binding.builtin_tasks_enabled);
    fixture
        .reply(ProcessControlBody::OwnerBound {
            request_id: binding.request_id.clone(),
            binding_seq: binding.binding_seq,
            owner: Some(wire_owner(&run)),
            // Stale: the requested flag was false.
            builtin_tasks_enabled: true,
            input_seq: binding.after_input_seq,
        })
        .await;
    assert_eq!(pipe.state().fault, Some(PipeFault::ControlIdentity));
    assert_eq!(
        stale.await.unwrap(),
        Err(RemoteProcessError::UnknownOutcome)
    );
    assert!(
        pipe.state().builtin_tasks,
        "the stale receipt changed nothing"
    );
}

// Core's builtin relay accepts only a currently bound lease on the current
// socket generation. Nothing on the wire becomes Core authority, and the tasks
// flag is not re-judged here (Core's operation policy owns it).
#[tokio::test]
async fn authorize_builtin_requires_current_bound_lease() {
    let mut fixture = Fixture::new("builtin").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let pipe = fixture.start(open).await;
    let run = owner("run-1", 1);
    assert_eq!(
        pipe.bind(Some(run.clone()), false)
            .await
            .expect("bind")
            .binding_seq,
        0
    );
    let call = BuiltinCallV1 {
        version: BUILTIN_PIPE_VERSION,
        key: wire_key(&fixture.key),
        owner: wire_owner(&run),
        binding_seq: 0,
        request_id: "req-1".into(),
        operation: "camp.context".into(),
        input: serde_json::json!({"k": "v"}),
        send_input_file_path: None,
    };
    let invocation = fixture
        .registry
        .authorize_builtin(&fixture.node_id, fixture.generation, &call)
        .expect("authorized lease");
    assert_eq!(invocation.process, fixture.key);
    assert_eq!(invocation.owner, run);
    assert_eq!(invocation.binding_seq, 0);
    match invocation.body {
        BuiltinToolIpcRequestBody::Invoke {
            request_id,
            operation,
            send_input_file_path,
            ..
        } => {
            assert_eq!(request_id, "req-1");
            assert_eq!(operation, "camp.context");
            assert!(send_input_file_path.is_none());
        }
    }
    // Retired generation, foreign node, stale binding and foreign owner.
    assert_eq!(
        fixture
            .registry
            .authorize_builtin(&fixture.node_id, fixture.generation + 1, &call)
            .err(),
        Some("builtin_pipe_generation")
    );
    assert_eq!(
        fixture
            .registry
            .authorize_builtin("node-other", fixture.generation, &call)
            .err(),
        Some("builtin_pipe_node")
    );
    let mut stale = call.clone();
    stale.binding_seq = 1;
    assert_eq!(
        fixture
            .registry
            .authorize_builtin(&fixture.node_id, fixture.generation, &stale)
            .err(),
        Some("builtin_pipe_owner")
    );
    let mut foreign = call.clone();
    foreign.owner = wire_owner(&owner("run-9", 1));
    assert_eq!(
        fixture
            .registry
            .authorize_builtin(&fixture.node_id, fixture.generation, &foreign)
            .err(),
        Some("builtin_pipe_owner")
    );

    // An explicitly unbound pipe is never a caller.
    let unbind = {
        let pipe = Arc::clone(&pipe);
        tokio::spawn(async move { pipe.bind(None, false).await })
    };
    let binding = match fixture.next_command().await {
        ProcessPipeCommand::BindOwner { binding } => binding,
        other => panic!("expected bind, got {other:?}"),
    };
    assert_eq!(binding.binding_seq, 1);
    assert_eq!(binding.next_owner, None);
    fixture
        .reply(ProcessControlBody::OwnerBound {
            request_id: binding.request_id.clone(),
            binding_seq: binding.binding_seq,
            owner: None,
            builtin_tasks_enabled: false,
            input_seq: binding.after_input_seq,
        })
        .await;
    assert!(unbind.await.unwrap().is_ok());
    assert_eq!(
        fixture
            .registry
            .authorize_builtin(&fixture.node_id, fixture.generation, &call)
            .err(),
        Some("builtin_pipe_unbound")
    );
}

// A bundled launch must prove the exact bundle identity with a stable root, and
// the verified receipt is what Core re-validates against its own frozen bundle
// (a Node never supplies prompt text).
#[tokio::test]
async fn bundled_open_requires_matching_materialization() {
    let mut fixture = Fixture::new("bundle-missing").await;
    let mut open = open_for(&fixture.key, fixture.registry.controller_id());
    let mut bundle = RunBundleV1 {
        version: RUN_BUNDLE_VERSION,
        bundle_id: "run-1-1".into(),
        run_id: "run-1".into(),
        attempt: 1,
        agent_id: "member-1".into(),
        // The bundle keeps the canonical spelling; the Open may use the alias.
        adapter_kind: "claude-code".into(),
        selection_revision: "selection-1".into(),
        source_skill_root: None,
        digest: String::new(),
        files: vec![BundleFile {
            artifact: BundleArtifact::BootstrapPrompt,
            label: "bootstrap".into(),
            path: "bootstrap.txt".into(),
            bytes: 1,
            content: "eA==".into(),
        }],
    };
    bundle.digest = bundle_digest(&bundle).expect("bundle digest");
    open.bundle = Some(bundle.clone());
    open.validate().expect("bundled open");
    let digest = open.digest().expect("open digest");

    // Missing materialization: the pipe is never admitted.
    let guard = StartGuard::new(
        Arc::clone(&fixture.registry),
        fixture.key.clone(),
        digest.clone(),
    );
    let registry = Arc::clone(&fixture.registry);
    let scope_for_task = scope();
    let open_for_task = open.clone();
    let task = tokio::spawn(async move {
        let mut guard = guard;
        let result = registry
            .begin_pipe(open_for_task, scope_for_task, &mut guard)
            .await;
        if result.is_ok() {
            guard.disarm();
        }
        result
    });
    match fixture.next_command().await {
        ProcessPipeCommand::Open { launch } => {
            assert_eq!(launch.digest().expect("digest"), digest);
        }
        other => panic!("expected open, got {other:?}"),
    }
    fixture
        .reply(ProcessControlBody::Opened {
            launch_digest: digest.clone(),
            node_pid: 4242,
            materialization: None,
        })
        .await;
    assert!(
        task.await.unwrap().is_err(),
        "bundled launch needs a receipt"
    );

    // Exact materialization: admitted, stored, and accepted by Core's validator.
    let mut ok = Fixture::new("bundle-ok").await;
    let mut open_ok = open_for(&ok.key, ok.registry.controller_id());
    open_ok.bundle = Some(bundle.clone());
    let receipt = BundleMaterializationV1 {
        bundle_id: bundle.bundle_id.clone(),
        bundle_digest: bundle.digest.clone(),
        skill_root: "/opt/fixture/skills".into(),
    };
    let pipe = ok.start_with(open_ok, Some(receipt.clone())).await;
    assert!(pipe.state().fault.is_none());
    assert_eq!(pipe.state().materialization.as_ref(), Some(&receipt));
    let core_receipt = RemoteBundleMaterialization {
        bundle_id: receipt.bundle_id.clone(),
        bundle_digest: receipt.bundle_digest.clone(),
        skill_root: receipt.skill_root.clone(),
    };
    assert_eq!(core_receipt.validate(&bundle), Ok(()));
    let wrong = RemoteBundleMaterialization {
        bundle_id: "run-1-2".into(),
        bundle_digest: bundle.digest.clone(),
        skill_root: receipt.skill_root,
    };
    assert!(
        wrong.validate(&bundle).is_err(),
        "a foreign bundle id is refused"
    );
}

// -- split-reader probes for the queued-generation owner ----------------------

/// One real `poll_read` on the split reader, with the enclosing task's waker.
///
/// This crate's `tokio` has no `io-util` and `futures_util::poll!` needs the
/// `async-await` feature (off here), so the single poll is spelled out: the
/// `poll_fn` below is immediately ready, therefore awaiting it polls the real
/// read path exactly once and hands back what that one poll returned.
async fn poll_read_once(
    reader: &mut super::io::PipeReader,
    buf: &mut [u8],
) -> (Poll<std::io::Result<()>>, usize) {
    std::future::poll_fn(|cx| {
        let mut read = ReadBuf::new(buf);
        let result = Pin::new(&mut *reader).poll_read(cx, &mut read);
        Poll::Ready((result, read.filled().len()))
    })
    .await
}

/// Awaits real progress from the split reader. No fixed sleep: suspension is the
/// reader's own change notification.
async fn read_some(reader: &mut super::io::PipeReader, buf: &mut [u8]) -> std::io::Result<usize> {
    std::future::poll_fn(|cx| {
        let mut read = ReadBuf::new(buf);
        match Pin::new(&mut *reader).poll_read(cx, &mut read) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => Poll::Ready(Ok(read.filled().len())),
        }
    })
    .await
}

/// Reads exactly `want` bytes in order. Each read carries its own `WAIT` budget:
/// every chunk is a real journal fsync, so one budget for all of them expires
/// under load while progress is fine. The total stays finite because progress is
/// strictly positive, so at most `want` reads happen.
async fn read_exactly(reader: &mut super::io::PipeReader, want: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(want);
    while out.len() < want {
        let mut buf = [0u8; 64];
        let got = out.len();
        let filled = tokio::time::timeout(WAIT, read_some(reader, &mut buf))
            .await
            .unwrap_or_else(|_| panic!("read timed out after {got} of {want} bytes"))
            .unwrap_or_else(|error| panic!("read failed after {got} of {want} bytes: {error}"));
        assert!(
            filled > 0,
            "no positive progress before {want} bytes, got {got}: {out:?}"
        );
        out.extend_from_slice(&buf[..filled]);
    }
    out
}

/// One line per phase so a slow or failing run can be located. Never per byte.
fn phase(label: &str, started: std::time::Instant, bytes: usize) {
    eprintln!(
        "pipe-phase {label}: {:.3}s elapsed, {bytes} bytes read",
        started.elapsed().as_secs_f64()
    );
}

/// One bounded receive on the fake socket: `None` means it stayed quiet for
/// `QUIET`. Nothing is skipped silently, so a stray command fails this owner.
async fn quiet_command(fixture: &mut Fixture) -> Option<ProcessPipeCommand> {
    loop {
        match tokio::time::timeout(QUIET, fixture.rx.recv()).await {
            Err(_) => return None,
            Ok(None) => panic!("socket closed"),
            Ok(Some(Outbound::Text(text))) => {
                if let ServerMessage::ProcessPipe { command } =
                    serde_json::from_str::<ServerMessage>(&text).expect("server message")
                {
                    return Some(command);
                }
            }
            Ok(Some(_)) => {}
        }
    }
}

#[tokio::test]
async fn queued_old_socket_output_cannot_be_rebranded_by_reconnect() {
    let mut fixture = Fixture::new("queued-generation").await;
    let open = open_for(&fixture.key, fixture.registry.controller_id());
    let pipe = fixture.start(open).await;
    let old_generation = fixture.generation;
    assert!(pipe.enqueue_output(old_generation, output_event(&fixture.key, 1, "retired")));
    let next = old_generation + 1;
    {
        let mut inner = fixture.hub.inner.lock().await;
        inner.nodes.get_mut(&fixture.node_id).unwrap().generation = next;
    }
    pipe.attach_generation(next);
    fixture.generation = next;
    pipe.clone().output_worker().await;
    assert_eq!(
        pipe.journal_highest().await,
        0,
        "old queued frame must not enter the new generation journal"
    );
    assert!(matches!(
        fixture.next_command().await,
        ProcessPipeCommand::Resume {
            after_event_seq: 0,
            ..
        }
    ));
    fixture
        .output(output_event(&fixture.key, 1, "current"))
        .await;
    assert!(matches!(
        fixture.next_command().await,
        ProcessPipeCommand::Ack { event_seq: 1, .. }
    ));
    assert_eq!(pipe.journal_highest().await, 1);
    assert!(pipe.state().fault.is_none());

    // ---- same owner, independent fixture: a dropped tail is replayable -------
    //
    // A full inbound window refuses the tail and records it as *temporarily*
    // missing (`capture_incomplete` + `dropped_upto`) plus a `Resume` request.
    // That refusal must never reach the reader as a terminal loss while the
    // retained prefix is still pending, and the replayed frame must complete the
    // stream exactly once. Only the durable `Exited` ends it.
    let mut replay = Fixture::new("queued-generation-replay").await;
    let replayed_open = open_for(&replay.key, replay.registry.controller_id());
    let replay_pipe = replay.start(replayed_open).await;
    let generation = replay.generation;

    // 32 distinct one-byte stdout chunks fill the window. The returned bool only
    // means "spawn the worker": the first call reports it and the rest are queued
    // behind the deliberately absent worker. It is not an overflow signal.
    let mut spawn_reports = 0;
    for seq in 1..=32u64 {
        let chunk = char::from(b'A' + (seq - 1) as u8).to_string();
        if replay_pipe.enqueue_output(generation, output_event(&replay.key, seq, &chunk)) {
            spawn_reports += 1;
        }
    }
    assert_eq!(spawn_reports, 1, "only the first frame can report 'spawn'");
    assert_eq!(
        super::INBOUND_OUTPUT_QUEUE,
        32,
        "this owner assumes a 32-frame window"
    );
    assert_eq!(
        super::lock(&replay_pipe.inbound).queue.len(),
        32,
        "the window holds exactly its capacity"
    );
    // Frame 33 does not fit: refused, never queued, tail declared missing.
    assert!(
        !replay_pipe.enqueue_output(generation, output_event(&replay.key, 33, "~")),
        "a full window must refuse frame 33"
    );
    assert_eq!(
        super::lock(&replay_pipe.inbound).queue.len(),
        32,
        "the refused frame is not queued"
    );
    {
        let state = replay_pipe.state();
        assert_eq!(state.dropped_upto, Some(33));
        assert!(
            state.capture_incomplete,
            "a refused tail is declared incomplete"
        );
        assert!(state.fault.is_none());
    }

    let replay_started = std::time::Instant::now();
    let mut reader = super::io::PipeReader::new(Arc::clone(&replay_pipe), PipeStream::Stdout);

    // One real read before any worker runs. The 32 retained bytes are still in
    // the window, so the only correct answer is "wait": a refused tail is
    // replayable, not lost.
    let mut first_buf = [0u8; 8];
    let (first, first_filled) = poll_read_once(&mut reader, &mut first_buf).await;
    // The same instance is polled again: `PipeReader::failure` is sticky, so a
    // loss reported once can never be taken back (the bug this owner pins).
    let mut second_buf = [0u8; 8];
    let (second, _) = poll_read_once(&mut reader, &mut second_buf).await;
    assert_eq!(first_filled, 0);
    assert!(
        matches!(first, Poll::Pending),
        "a refused tail must not make the first read fail: first={first:?} second={second:?}"
    );
    assert!(
        matches!(second, Poll::Pending),
        "the same reader must keep waiting instead of repeating a cached loss: {second:?}"
    );

    // The retained prefix is journalled by the real writer, delivered in order,
    // and every ACK is a durable sequence.
    replay_pipe.clone().output_worker().await;
    let prefix = read_exactly(&mut reader, 32).await;
    phase("prefix", replay_started, prefix.len());
    let expected: Vec<u8> = (1..=32u64).map(|seq| b'A' + (seq - 1) as u8).collect();
    assert_eq!(prefix, expected, "retained bytes arrive once, in order");
    let mut acks = Vec::new();
    let mut resumes = Vec::new();
    while let Some(command) = quiet_command(&mut replay).await {
        match command {
            ProcessPipeCommand::Ack { event_seq, .. } => {
                assert!(event_seq <= 32, "ACK past the durable cursor: {event_seq}");
                acks.push(event_seq);
            }
            ProcessPipeCommand::Resume { after_event_seq, .. } => {
                // The protocol resumes from a durable cursor, so the value may be
                // lower than the highest retained frame; it must never be higher.
                assert!(
                    after_event_seq <= 32,
                    "Resume must carry a durable cursor, got {after_event_seq}"
                );
                resumes.push(after_event_seq);
            }
            ProcessPipeCommand::Open { .. } => panic!("no Open after start"),
            ProcessPipeCommand::Input { .. } => panic!("no Input on this pipe"),
            ProcessPipeCommand::Terminate { .. } => panic!("no Terminate on this pipe"),
            other => panic!("unexpected command: {other:?}"),
        }
    }
    assert_eq!(
        acks,
        (1..=32u64).collect::<Vec<_>>(),
        "exactly the durable sequences, once each"
    );
    assert!(!resumes.is_empty(), "a refused tail must ask for a replay");
    assert_eq!(replay_pipe.journal_highest().await, 32);

    // Replay the refused frame. The reader is polled only once the frame is
    // durable: there is no assumed lock-step order, only the durable cursor.
    replay.output(output_event(&replay.key, 33, "~")).await;
    tokio::time::timeout(WAIT, async {
        loop {
            let durable = replay_pipe.journal_highest().await >= 33;
            let recovered = {
                let state = replay_pipe.state();
                !state.capture_incomplete && state.dropped_upto.is_none()
            };
            if durable && recovered {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the replayed frame must become durable and clear the loss window");
    {
        let state = replay_pipe.state();
        assert!(!state.capture_incomplete, "a durable replay clears the loss flag");
        assert_eq!(state.dropped_upto, None);
        assert!(state.fault.is_none());
    }
    assert_eq!(
        read_exactly(&mut reader, 1).await,
        vec![b'~'],
        "the replayed byte is delivered once"
    );
    phase("replay", replay_started, 33);
    let mut replayed_acks = Vec::new();
    while let Some(command) = quiet_command(&mut replay).await {
        match command {
            ProcessPipeCommand::Ack { event_seq, .. } => replayed_acks.push(event_seq),
            ProcessPipeCommand::Resume { after_event_seq, .. } => assert!(
                after_event_seq <= 33,
                "Resume must carry a durable cursor, got {after_event_seq}"
            ),
            ProcessPipeCommand::Open { .. } => panic!("no Open after start"),
            ProcessPipeCommand::Input { .. } => panic!("no Input on this pipe"),
            ProcessPipeCommand::Terminate { .. } => panic!("no Terminate on this pipe"),
            other => panic!("unexpected command: {other:?}"),
        }
    }
    assert_eq!(
        replayed_acks,
        vec![33],
        "the replayed frame is ACKed once, after it is durable"
    );

    // Only the durable `Exited` ends the stream, and it is the only end: every
    // retained and replayed byte was delivered before it.
    replay.output(exited_event(&replay.key, 34, 0)).await;
    tokio::time::timeout(WAIT, async {
        while replay_pipe.journal_highest().await < 34 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the exit record must become durable");
    let mut tail = [0u8; 8];
    assert_eq!(
        read_some(&mut reader, &mut tail).await.expect("EOF is not an error"),
        0,
        "the durable Exited ends the stream exactly here"
    );
    assert_eq!(
        read_some(&mut reader, &mut tail).await.expect("EOF stays sticky"),
        0
    );
    phase("replay-eof", replay_started, 33);
    let mut exit_acks = Vec::new();
    while let Some(command) = quiet_command(&mut replay).await {
        match command {
            ProcessPipeCommand::Ack { event_seq, .. } => exit_acks.push(event_seq),
            ProcessPipeCommand::Resume { after_event_seq, .. } => assert!(
                after_event_seq <= 34,
                "Resume must carry a durable cursor, got {after_event_seq}"
            ),
            ProcessPipeCommand::Open { .. } => panic!("no Open after start"),
            ProcessPipeCommand::Input { .. } => panic!("no Input on this pipe"),
            ProcessPipeCommand::Terminate { .. } => panic!("no Terminate on this pipe"),
            other => panic!("unexpected command: {other:?}"),
        }
    }
    // Exact once: the bounded drain above was quiet, so no second `Open`, no
    // `Input` and no `Terminate` was ever sent on this socket.
    assert_eq!(exit_acks, vec![34], "the exit record is ACKed once");
    assert!(replay_pipe.state().fault.is_none());

    // ---- same owner, third fixture: an explicit abandon is a real loss ------
    //
    // `capture_incomplete` above is a pending-replay transient. Intentional
    // abandonment is the opposite: producers already stored a prefix, so that
    // prefix must still be delivered and only then may the reader see the
    // explicit loss — never a fake EOF, and never recovered afterwards.
    let mut abandon = Fixture::new("abandoned-output").await;
    let abandoned_open = open_for(&abandon.key, abandon.registry.controller_id());
    let abandon_pipe = abandon.start(abandoned_open).await;
    // The durable producer path: exactly one retained stdout chunk, no worker.
    abandon_pipe
        .record_output(output_event(&abandon.key, 1, "retained"))
        .await
        .expect("the retained chunk is durable");
    // The authoritative abandon decision: persisted first, idempotent, and it
    // consumes no pending bytes (no Release handshake is claimed here).
    abandon_pipe
        .mark_output_abandoned()
        .await
        .expect("the abandon decision is durable");
    {
        let state = abandon_pipe.state();
        assert!(state.output_abandoned, "the abandon decision is authoritative");
        assert!(
            !state.capture_incomplete,
            "an abandon is not a replay window"
        );
        assert!(state.fault.is_none());
    }

    let abandon_started = std::time::Instant::now();
    let mut abandoned_reader =
        super::io::PipeReader::new(Arc::clone(&abandon_pipe), PipeStream::Stdout);
    // Already-stored bytes are delivered before the loss statement.
    assert_eq!(
        read_exactly(&mut abandoned_reader, 8).await,
        b"retained".to_vec(),
        "the stored prefix survives an abandon"
    );
    phase("abandon-retained", abandon_started, 8);
    // Then, and only then, the explicit loss — repeated on every later read.
    let mut sink = [0u8; 8];
    let error = read_some(&mut abandoned_reader, &mut sink)
        .await
        .expect_err("abandoned output is an error, not an EOF");
    assert!(
        error.to_string().contains("pipe_output_incomplete"),
        "explicit loss code expected, got {error}"
    );
    let again = read_some(&mut abandoned_reader, &mut sink)
        .await
        .expect_err("the loss is sticky");
    assert!(
        again.to_string().contains("pipe_output_incomplete"),
        "the same reader keeps the explicit loss, got {again}"
    );
    phase("abandon-loss", abandon_started, 8);
    // A local consumer decision, not a new wire command and not an EOF.
    assert!(
        quiet_command(&mut abandon).await.is_none(),
        "an abandon sends no extra command"
    );
    assert!(abandon_pipe.state().fault.is_none());
}
