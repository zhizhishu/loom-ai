//! Real native actor + private IPC + bounded wire owners. The helper contract
//! check is intentionally bypassed only by the bridge's cfg(test) factory;
//! the installed Rovai CLI and real Core/Node E2E have separate acceptance.
use super::*;
use crate::builtin_bridge::BuiltinBridge;
use loom_protocol::builtin_pipe::{BUILTIN_PIPE_VERSION, BuiltinCallV1, BuiltinReplyV1};
use rovai_local_ipc::{LocalIpcClientStream, LocalIpcEndpoint};
use rovai_process_boundary::{ProcessSpec, StdinPolicy};
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsString, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BUDGET: Duration = Duration::from_secs(8);

struct Fixture {
    root: PathBuf,
    pipes: Arc<NodePipes>,
    bridge: BuiltinBridge,
    launch: ProcessOpenV1,
    context_path: PathBuf,
    context: Value,
    endpoint: LocalIpcEndpoint,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("lw-{}", uuid::Uuid::new_v4().simple()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .unwrap();
        }
        #[cfg(windows)]
        rovai_private_storage::create_private_directory(&path).unwrap();
        let root = rovai_private_storage::prepare_private_directory(&path).unwrap();
        let helper = ProcessSpec::new(
            std::env::current_exe().unwrap(),
            vec![],
            root.clone(),
            BTreeMap::new(),
            StdinPolicy::Null,
        )
        .unwrap();
        let bridge_root = root.join("builtins");
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&bridge_root)
                .unwrap();
        }
        #[cfg(windows)]
        rovai_private_storage::create_private_directory(&bridge_root).unwrap();
        let bridge_root = rovai_private_storage::prepare_private_directory(&bridge_root).unwrap();
        let bridge = BuiltinBridge::from_verified_test_spec(bridge_root, helper).unwrap();
        let mut environment = BTreeMap::new();
        environment.insert(
            OsString::from("LOOM_PIPE_CHILD_MODE"),
            OsString::from("echo"),
        );
        let spec = ProcessSpec::new(
            std::env::current_exe().unwrap(),
            [
                "process_pipe::tests::child_helper",
                "--exact",
                "--ignored",
                "--nocapture",
            ]
            .into_iter()
            .map(OsString::from)
            .collect(),
            root.clone(),
            environment,
            StdinPolicy::Piped,
        )
        .unwrap();
        let launch = ProcessOpenV1 {
            codex_hook_grant: None,
            version: PROCESS_PIPE_VERSION,
            key: RemoteProcessKey {
                node_id: "wire-node".into(),
                process_id: "wire-process".into(),
                process_epoch: 1,
            },
            session: ProcessSessionOwner {
                member_id: "wire-member".into(),
                logical_session_id: "wire-session".into(),
                workspace_id: "wire-workspace".into(),
                controller_id: "wire-controller".into(),
            },
            owner: AgentRunOwner {
                agent_run_id: "wire-run".into(),
                execution_epoch: 1,
            },
            builtin_tasks_enabled: true,
            adapter_kind: "claude-code-cli".into(),
            catalog_generation: 1,
            program_identity: spec.application_identity_digest(),
            program: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            cwd: root.to_string_lossy().into_owned(),
            args: vec![],
            environment: vec![],
            bundle: None,
        };
        let materials = bridge.prepare(&launch).unwrap();
        let context_path = PathBuf::from(
            materials
                .environment()
                .unwrap()
                .get(&OsString::from("ROVAI_CLI_CONTEXT"))
                .unwrap(),
        );
        let context: Value =
            serde_json::from_slice(&std::fs::read(&context_path).unwrap()).unwrap();
        let endpoint = serde_json::from_value(context["coreEndpoint"].clone()).unwrap();
        let pipes = NodePipes::new(
            root.clone(),
            &launch.key.node_id,
            InstallationCatalog::open(&root).unwrap(),
            WorkspaceAuthority::open(&root, launch.key.node_id.clone()).unwrap(),
            Some(bridge.clone()),
        )
        .unwrap();
        let opened = pipes
            .manager
            .open(&launch, spec, Some(Box::new(materials)))
            .unwrap();
        assert!(matches!(opened.body, ProcessControlBody::Opened { .. }));
        Self {
            root,
            pipes,
            bridge,
            launch,
            context_path,
            context,
            endpoint,
        }
    }
    fn binding(&self, after_input_seq: u64) -> BindProcessOwner {
        BindProcessOwner {
            key: self.launch.key.clone(),
            controller_id: self.launch.session.controller_id.clone(),
            request_id: "wire-bind".into(),
            binding_seq: 1,
            previous_owner: Some(self.launch.owner.clone()),
            next_owner: Some(AgentRunOwner {
                agent_run_id: "wire-next-run".into(),
                execution_epoch: 2,
            }),
            builtin_tasks_enabled: false,
            after_input_seq,
        }
    }
    async fn finish(self) {
        self.pipes.closed.store(true, Ordering::Release);
        self.pipes.wake();
        self.pipes.manager.shutdown().await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        let root = self.root.clone();
        drop(self);
        let _ = std::fs::remove_dir_all(root);
    }
}
fn request(context: &Value, id: &str) -> Value {
    json!({
        "ipcProtocolVersion":context["ipcProtocolVersion"],
        "processId":context["processId"], "processToken":context["processToken"],
        "leaseId":context["lease"]["leaseId"], "leaseGeneration":context["lease"]["leaseGeneration"],
        "leaseToken":context["lease"]["leaseToken"],
        "kind":"invoke", "request_id":id, "operation":"team.send",
        "input":{"text":"wire-owner-fixture"}
    })
}
async fn send(endpoint: &LocalIpcEndpoint, body: &Value) -> LocalIpcClientStream {
    let mut stream = LocalIpcClientStream::connect(endpoint).await.unwrap();
    let mut bytes = serde_json::to_vec(body).unwrap();
    bytes.push(b'\n');
    stream.write_all(&bytes).await.unwrap();
    stream.flush().await.unwrap();
    stream
}
async fn response(mut stream: LocalIpcClientStream) -> Option<Value> {
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(BUDGET, stream.read_to_end(&mut bytes))
        .await
        .unwrap();
    if let Err(error) = result {
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::UnexpectedEof
        ));
    }
    if bytes.is_empty() {
        None
    } else {
        Some(serde_json::from_slice(&bytes).unwrap())
    }
}
async fn until(predicate: impl Fn() -> bool) {
    tokio::time::timeout(BUDGET, async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("wire owner deadline");
}
fn reply(call: &BuiltinCallV1, response: Option<Value>) -> BuiltinReplyV1 {
    BuiltinReplyV1 {
        version: BUILTIN_PIPE_VERSION,
        key: call.key.clone(),
        binding_seq: call.binding_seq,
        request_id: call.request_id.clone(),
        request_digest: call.digest().unwrap(),
        response,
    }
}
async fn receive_call(rx: &mut mpsc::Receiver<ClientMessage>) -> BuiltinCallV1 {
    tokio::time::timeout(BUDGET, async {
        loop {
            match rx.recv().await.expect("wire control open") {
                ClientMessage::BuiltinCall { call } => break call,
                _ => continue,
            }
        }
    })
    .await
    .expect("builtin relay deadline")
}

#[tokio::test]
async fn refused_actor_binding_preserves_context_and_failed_sync_fences_admission() {
    let fixture = Fixture::new();
    let before = std::fs::read(&fixture.context_path).unwrap();
    let refusal = fixture
        .pipes
        .apply(ProcessPipeCommand::BindOwner {
            binding: fixture.binding(42),
        })
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(refusal.body, ProcessControlBody::Refused { ref code, .. }
        if code == "pipe_owner_boundary_unconfirmed")
    );
    assert_eq!(std::fs::read(&fixture.context_path).unwrap(), before);
    assert!(matches!(
        fixture
            .pipes
            .manager
            .resume(
                &fixture.launch.key,
                &fixture.launch.session.controller_id,
                0
            )
            .await
            .unwrap()
            .body,
        ProcessControlBody::State {
            binding_seq: 0,
            builtin_tasks_enabled: true,
            ..
        }
    ));
    let old = send(
        &fixture.endpoint,
        &request(&fixture.context, "old-still-admitted"),
    )
    .await;
    until(|| fixture.bridge.pending_dispatches().unwrap().len() == 1).await;
    let call = fixture.bridge.pending_dispatches().unwrap().remove(0).call;
    assert_eq!(call.owner, fixture.launch.owner);
    fixture.pipes.complete_builtin(reply(&call, None)).unwrap();
    assert_eq!(response(old).await, None);

    // An actual filesystem failure after actor acceptance cannot leave the old
    // local credentials usable while cleanup is being confirmed.
    let late = LocalIpcClientStream::connect(&fixture.endpoint)
        .await
        .unwrap();
    std::fs::rename(
        &fixture.context_path,
        fixture.context_path.with_extension("saved"),
    )
    .unwrap();
    std::fs::create_dir(&fixture.context_path).unwrap();
    let result = fixture
        .pipes
        .apply(ProcessPipeCommand::BindOwner {
            binding: fixture.binding(0),
        })
        .await;
    assert!(matches!(result, Err("builtin_owner_sync_failed")));
    let mut late = late;
    let mut bytes = serde_json::to_vec(&request(&fixture.context, "late-after-fence")).unwrap();
    bytes.push(b'\n');
    let _ = late.write_all(&bytes).await;
    let _ = late.flush().await;
    assert_eq!(response(late).await, None);
    assert!(fixture.bridge.pending_dispatches().unwrap().is_empty());
    // The wrapper awaited bounded termination after fencing. Once the actor
    // has positive tree-empty evidence its normal monitor may remove materials;
    // absence here is permitted only alongside that positive receipt below.
    assert!(matches!(
        fixture
            .pipes
            .manager
            .resume(
                &fixture.launch.key,
                &fixture.launch.session.controller_id,
                0
            )
            .await
            .unwrap()
            .body,
        ProcessControlBody::State {
            tree_stopped: true,
            ..
        }
    ));
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn relay_reissues_same_request_lifetime_and_drops_conflicting_reply_only() {
    let fixture = Fixture::new();
    let (tx, mut rx) = mpsc::channel(8);
    let (output, _output_rx) = mpsc::channel(8);
    fixture.pipes.attach(tx, output).await;
    let body = request(&fixture.context, "wire-aba");
    let first = send(&fixture.endpoint, &body).await;
    let first_call = receive_call(&mut rx).await;
    let first_dispatch = fixture
        .bridge
        .pending_dispatches()
        .unwrap()
        .remove(0)
        .dispatch_id;
    let mut conflict = reply(&first_call, None);
    conflict.request_digest = "0".repeat(64);
    fixture.pipes.complete_builtin(conflict).unwrap();
    assert!(fixture.pipes.connection().is_some());
    assert_eq!(fixture.bridge.pending_dispatches().unwrap().len(), 1);

    // Hold only the transport snapshot lock on a separate native thread. The
    // real IPC acceptor remains live. This forces the relay to miss the empty
    // pending state between completion and retry, reproducing the former ABA.
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let (unlock_tx, unlock_rx) = std::sync::mpsc::channel();
    let pipes = fixture.pipes.clone();
    let holder = std::thread::spawn(move || {
        let _guard = pipes.connection.lock().unwrap();
        locked_tx.send(()).unwrap();
        let _ = unlock_rx.recv_timeout(Duration::from_secs(10));
    });
    locked_rx.recv_timeout(BUDGET).unwrap();
    fixture
        .pipes
        .complete_builtin(reply(&first_call, None))
        .unwrap();
    assert_eq!(response(first).await, None);
    let retry = send(&fixture.endpoint, &body).await;
    until(|| {
        fixture
            .bridge
            .pending_dispatches()
            .unwrap()
            .first()
            .is_some_and(|dispatch| dispatch.dispatch_id != first_dispatch)
    })
    .await;
    unlock_tx.send(()).unwrap();
    holder.join().unwrap();
    let second_call = receive_call(&mut rx).await;
    assert_eq!(first_call, second_call);
    let accepted = json!({"kind":"envelope","envelope":{"ok":true,"data":{"fixture":true}}});
    fixture
        .pipes
        .complete_builtin(reply(&second_call, Some(accepted.clone())))
        .unwrap();
    assert_eq!(response(retry).await, Some(accepted));
    fixture.finish().await;
}
