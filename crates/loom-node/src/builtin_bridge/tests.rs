use super::*;
use loom_protocol::process_pipe::{ProcessSessionOwner, PROCESS_PIPE_VERSION};
use rovai_local_ipc::LocalIpcClientStream;

struct Fixture { root: PathBuf, bridge: BuiltinBridge, launch: ProcessOpenV1 }
impl Fixture {
    fn new() -> Self {
        // A short, fresh, private root also keeps native Unix socket paths bounded.
        let root = new_private_directory(&std::env::temp_dir().join(format!(
            "lb-{}", uuid::Uuid::new_v4().simple()))).unwrap();
        let helper = ProcessSpec::new(std::env::current_exe().unwrap(), vec![], root.clone(),
            BTreeMap::new(), StdinPolicy::Null).unwrap();
        // This owner tests the real native IPC seam, not the helper --version
        // admission; the full native CLI smoke owns its installed binary contract.
        let bridge = BuiltinBridge::from_verified_test_spec(root.clone(), helper).unwrap();
        let launch = ProcessOpenV1 {
            codex_hook_grant: None,
            version: PROCESS_PIPE_VERSION,
            key: RemoteProcessKey { node_id: "node-b".into(), process_id: "process-b".into(), process_epoch: 1 },
            session: ProcessSessionOwner { member_id: "member".into(), logical_session_id: "session".into(),
                workspace_id: "workspace".into(), controller_id: "controller".into() },
            owner: AgentRunOwner { agent_run_id: "run-a".into(), execution_epoch: 4 },
            builtin_tasks_enabled: false,
            adapter_kind: "claude-code-cli".into(), catalog_generation: 1,
            program_identity: "fixture-native-identity".into(),
            program: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
            cwd: root.to_string_lossy().into_owned(), args: vec![], environment: vec![], bundle: None,
        };
        Self { root, bridge, launch }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
}
fn context(prepared: &PreparedBuiltin) -> Value {
    serde_json::from_slice(&std::fs::read(&prepared.lease.context_path).unwrap()).unwrap()
}
fn request(context: &Value, id: &str) -> Value {
    json!({
        "ipcProtocolVersion":context["ipcProtocolVersion"],
        "processId":context["processId"], "processToken":context["processToken"],
        "leaseId":context["lease"]["leaseId"],
        "leaseGeneration":context["lease"]["leaseGeneration"],
        "leaseToken":context["lease"]["leaseToken"],
        "kind":"invoke", "request_id":id, "operation":"team.send",
        "input":{"text":"private-body"}, "sendInputFilePath":"B:/private/input.txt"
    })
}
async fn send(endpoint: &LocalIpcEndpoint, value: &Value) -> LocalIpcClientStream {
    let mut stream = LocalIpcClientStream::connect(endpoint).await.unwrap();
    let mut bytes = serde_json::to_vec(value).unwrap(); bytes.push(b'\n');
    stream.write_all(&bytes).await.unwrap();
    stream.flush().await.unwrap();
    stream
}
async fn response(mut stream: LocalIpcClientStream) -> Option<Value> {
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes))
        .await.expect("local IPC response deadline");
    if let Err(error) = result {
        assert!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe |
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof),
            "unexpected local IPC failure: {error}");
    }
    if bytes.is_empty() { None } else { Some(serde_json::from_slice(&bytes).unwrap()) }
}
async fn until(predicate: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !predicate() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.expect("bridge state deadline");
}
fn reply(call: &BuiltinCallV1, response: Option<Value>) -> BuiltinReplyV1 {
    BuiltinReplyV1 { version: BUILTIN_PIPE_VERSION, key: call.key.clone(),
        binding_seq: call.binding_seq, request_id: call.request_id.clone(),
        request_digest: call.digest().unwrap(), response }
}
fn pending(bridge: &BuiltinBridge) -> Vec<BuiltinCallV1> {
    bridge.pending_dispatches().unwrap().into_iter().map(|item| item.call).collect()
}

// Unique owner: actual OS IPC credentials are exchanged for the current Run
// binding; stale credentials, unbind and guard release cannot publish new work.
#[tokio::test]
async fn native_ipc_rotates_local_lease_and_never_exports_core_credentials() {
    let mut fixture = Fixture::new();
    fixture.launch.builtin_tasks_enabled = true;
    let prepared = fixture.bridge.prepare(&fixture.launch).unwrap();
    let first = context(&prepared);
    assert_eq!(first["tasksEnabled"], true);
    let endpoint = prepared.lease.endpoint.clone();
    let env = prepared.environment().unwrap();
    #[cfg(windows)]
    for value in env.values() {
        assert!(!value.to_str().unwrap().starts_with(r"\\?\"));
        assert!(!value.to_str().unwrap().starts_with(r"\\.\"));
    }
    let displayed_context = PathBuf::from(env.get(&OsString::from("ROVAI_CLI_CONTEXT")).unwrap());
    let displayed_tmp = PathBuf::from(env.get(&OsString::from("ROVAI_RUN_TMP")).unwrap());
    assert_eq!(displayed_context.canonicalize().unwrap(), prepared.lease.context_path.canonicalize().unwrap());
    assert_eq!(displayed_tmp.canonicalize().unwrap(), prepared.lease.run_tmp.canonicalize().unwrap());
    let same_context: Value = serde_json::from_slice(&std::fs::read(displayed_context).unwrap()).unwrap();
    assert!(same_context == first);
    assert_eq!(first["lease"]["runTmp"].as_str().unwrap(), prepared.lease.run_tmp.to_str().unwrap());

    assert_eq!(env.len(), 3);
    assert!(env.keys().all(|key| matches!(key.to_str(),
        Some("ROVAI_AGENT_CLI" | "ROVAI_CLI_CONTEXT" | "ROVAI_RUN_TMP"))));
    let stream = send(&endpoint, &request(&first, "request-one")).await;
    until(|| pending(&fixture.bridge).len() == 1).await;
    let call = pending(&fixture.bridge).remove(0);
    assert_eq!(call.owner, fixture.launch.owner);
    assert_eq!(call.binding_seq, 0);
    assert_eq!(call.send_input_file_path.as_deref(), Some("B:/private/input.txt"));
    let wire = serde_json::to_string(&call).unwrap();
    for value in [first["processToken"].as_str().unwrap(), first["lease"]["leaseToken"].as_str().unwrap()] {
        assert!(!wire.contains(value));
    }
    assert!(!wire.contains("processToken"));
    assert!(!wire.contains("leaseToken"));
    let envelope = json!({"kind":"envelope","envelope":{"ok":true,"data":{"delivered":true}}});
    fixture.bridge.complete(reply(&call, Some(envelope.clone()))).unwrap();
    assert_eq!(response(stream).await, Some(envelope));

    let mut invalids = Vec::new();
    let mut wrong = request(&first, "wrong-token"); wrong["leaseToken"] = json!("wrong");
    invalids.push(wrong);
    let mut wrong = request(&first, "wrong-process"); wrong["processId"] = json!("other");
    invalids.push(wrong);
    let mut wrong = request(&first, "wrong-contract"); wrong["ipcProtocolVersion"] = json!(999);
    invalids.push(wrong);
    let mut wrong = request(&first, "unknown-owner"); wrong["owner"] = json!({"agentRunId":"forged"});
    invalids.push(wrong);
    for wrong in invalids {
        assert_eq!(response(send(&endpoint, &wrong).await).await, None);
        assert!(pending(&fixture.bridge).is_empty());
    }

    let old_pending = send(&endpoint, &request(&first, "old-inflight")).await;
    until(|| pending(&fixture.bridge).len() == 1).await;
    let old_call = pending(&fixture.bridge).remove(0);
    // Deterministic scheduling of the real authenticate -> publish boundary:
    // authenticate while old credentials are valid, then rotate before publish.
    let raced_call = authenticate(&prepared.lease,
        serde_json::from_value(request(&first, "rotation-race")).unwrap()).unwrap();
    let raced_digest = raced_call.digest().unwrap();
    let next_owner = AgentRunOwner { agent_run_id:"run-b".into(), execution_epoch:5 };
    let mut binding = BindProcessOwner {
        key:fixture.launch.key.clone(), controller_id:"controller".into(),
        request_id:"bind-one".into(), binding_seq:1,
        previous_owner:Some(fixture.launch.owner.clone()), next_owner:Some(next_owner.clone()),
        after_input_seq:0, builtin_tasks_enabled:false,
    };
    fixture.bridge.bind_owner(&binding).unwrap();
    fixture.bridge.bind_owner(&binding).unwrap();
    let (raced_sender, raced_receiver) = oneshot::channel();
    assert_eq!(publish_call(&prepared.lease, &fixture.bridge.inner, raced_call,
        raced_digest, raced_sender), Err("builtin_binding_changed"));
    assert!(raced_receiver.await.is_err());
    let mut conflicting = binding.clone(); conflicting.builtin_tasks_enabled = true;
    assert_eq!(fixture.bridge.bind_owner(&conflicting), Err("builtin_binding_conflict"));
    assert_eq!(response(old_pending).await, None);
    fixture.bridge.complete(reply(&old_call, Some(json!({"kind":"envelope"})))).unwrap();
    assert!(pending(&fixture.bridge).is_empty());
    assert_eq!(response(send(&endpoint, &request(&first, "stale-lease")).await).await, None);
    let second = context(&prepared);
    assert_eq!(second["tasksEnabled"], false);
    assert_ne!(first["lease"]["leaseToken"], second["lease"]["leaseToken"]);
    assert_eq!(second["lease"]["leaseGeneration"], 2);
    let stream = send(&endpoint, &request(&second, "new-run")).await;
    until(|| pending(&fixture.bridge).len() == 1).await;
    let next_call = pending(&fixture.bridge).remove(0);
    assert_eq!(next_call.owner, next_owner);
    assert_eq!(next_call.binding_seq, 1);
    fixture.bridge.complete(reply(&next_call, None)).unwrap();
    assert_eq!(response(stream).await, None);

    // Even with the SAME Run owner, capability changes rotate the local lease.
    binding.request_id = "same-owner-capability".into();
    binding.binding_seq = 2;
    binding.previous_owner = binding.next_owner.clone();
    binding.builtin_tasks_enabled = true;
    fixture.bridge.bind_owner(&binding).unwrap();
    let third = context(&prepared);
    assert_eq!(third["tasksEnabled"], true);
    assert_eq!(third["lease"]["leaseGeneration"], 3);
    assert_ne!(third["lease"]["leaseToken"], second["lease"]["leaseToken"]);
    assert_eq!(response(send(&endpoint, &request(&second, "old-capability")).await).await, None);
    binding.request_id = "unbind".into();
    binding.binding_seq = 3;
    binding.builtin_tasks_enabled = false;
    binding.previous_owner = binding.next_owner.take();
    let mut invalid = binding.clone(); invalid.builtin_tasks_enabled = true;
    assert_eq!(fixture.bridge.bind_owner(&invalid), Err("pipe_unbound_tasks"));
    fixture.bridge.bind_owner(&binding).unwrap();
    assert!(context(&prepared)["lease"].is_null());
    assert_eq!(response(send(&endpoint, &request(&second, "unbound")).await).await, None);

    // A connection admitted before release must not dispatch after the guard dies.
    let mut late = LocalIpcClientStream::connect(&endpoint).await.unwrap();
    let owned_root = prepared.lease.root.clone();
    drop(prepared);
    let mut bytes = serde_json::to_vec(&request(&second, "late")).unwrap(); bytes.push(b'\n');
    let _ = late.write_all(&bytes).await;
    let _ = late.flush().await;
    assert_eq!(response(late).await, None);
    assert!(pending(&fixture.bridge).is_empty());
    assert!(!owned_root.exists());
}

// Unique owner: bounded pending calls survive transport replacement, while
// conflicting retry bodies, wrong replies and unknown outcomes never fabricate
// a result or create a second business dispatch authority.
#[tokio::test]
async fn native_ipc_bounds_pending_and_preserves_exact_retry_identity() {
    let fixture = Fixture::new();
    let prepared = fixture.bridge.prepare(&fixture.launch).unwrap();
    let ctx = context(&prepared);
    let endpoint = &prepared.lease.endpoint;
    let body = request(&ctx, "same-request");
    let first = send(endpoint, &body).await;
    until(|| pending(&fixture.bridge).len() == 1).await;
    let first_dispatch = fixture.bridge.pending_dispatches().unwrap().remove(0);
    assert_eq!(first_dispatch.request_digest, first_dispatch.call.digest().unwrap());
    let second = send(endpoint, &body).await;
    until(|| fixture.bridge.inner.pending.lock().unwrap().values().next().unwrap().waiters.len() == 2).await;
    assert_eq!(fixture.bridge.pending_dispatches().unwrap()[0].dispatch_id,
        first_dispatch.dispatch_id, "concurrent waiters share one pending lifetime");
    let mut different = body.clone(); different["input"] = json!({"text":"different"});
    assert_eq!(response(send(endpoint, &different).await).await, None);
    assert_eq!(pending(&fixture.bridge).len(), 1);
    let call = pending(&fixture.bridge).remove(0);
    let mut wrong_reply = reply(&call, None); wrong_reply.request_digest = "0".repeat(64);
    assert_eq!(fixture.bridge.complete(wrong_reply), Err("builtin_reply_conflict"));
    assert_eq!(pending(&fixture.bridge).len(), 1);
    // Reconnect reads the same typed request with unchanged owner and digest.
    assert_eq!(pending(&fixture.bridge).remove(0), call);
    let envelope = json!({"kind":"error","error":{"code":"denied","message":"permission denied"}});
    fixture.bridge.complete(reply(&call, Some(envelope.clone()))).unwrap();
    assert_eq!(response(first).await, Some(envelope.clone()));
    assert_eq!(response(second).await, Some(envelope.clone()));

    // A relay may miss the empty snapshot between completion and immediate
    // retry. Its old sent-map entry must not suppress the recreated request.
    // The Node-local dispatch lifetime changes; the exact Core journal key,
    // owner, input and digest do not. Unknown outcomes obey the same rule.
    let retried = send(endpoint, &body).await;
    until(|| pending(&fixture.bridge).len() == 1).await;
    let second_dispatch = fixture.bridge.pending_dispatches().unwrap().remove(0);
    assert_ne!(second_dispatch.dispatch_id, first_dispatch.dispatch_id);
    assert_eq!(second_dispatch.call, call);
    fixture.bridge.complete(reply(&call, None)).unwrap();
    assert_eq!(response(retried).await, None);
    let unknown_retry = send(endpoint, &body).await;
    until(|| pending(&fixture.bridge).len() == 1).await;
    let third_dispatch = fixture.bridge.pending_dispatches().unwrap().remove(0);
    assert_ne!(third_dispatch.dispatch_id, second_dispatch.dispatch_id);
    assert_eq!(third_dispatch.call, call);
    assert_eq!(third_dispatch.call.digest().unwrap(), first_dispatch.call.digest().unwrap());
    fixture.bridge.complete(reply(&call, Some(envelope.clone()))).unwrap();
    assert_eq!(response(unknown_retry).await, Some(envelope));

    let mut streams = Vec::new();
    for i in 0..MAX_PENDING_BUILTINS {
        streams.push(send(endpoint, &request(&ctx, &format!("bounded-{i}"))).await);
        until(|| pending(&fixture.bridge).len() == i+1).await;
    }
    assert_eq!(response(send(endpoint, &request(&ctx, "over-capacity")).await).await, None);
    assert_eq!(pending(&fixture.bridge).len(), MAX_PENDING_BUILTINS);
    for call in pending(&fixture.bridge) { fixture.bridge.complete(reply(&call, None)).unwrap(); }
    for stream in streams { assert_eq!(response(stream).await, None); }
    assert!(pending(&fixture.bridge).is_empty());

    let mut oversize = request(&ctx, "over-frame"); oversize["input"] = json!("x".repeat(MAX_BUILTIN_FRAME));
    let mut raw = LocalIpcClientStream::connect(endpoint).await.unwrap();
    let mut bytes = serde_json::to_vec(&oversize).unwrap(); bytes.push(b'\n');
    let _ = tokio::time::timeout(Duration::from_secs(5), raw.write_all(&bytes)).await;
    assert_eq!(response(raw).await, None);
    assert!(pending(&fixture.bridge).is_empty());
    let held = send(endpoint, &request(&ctx, "fenced-pending")).await;
    until(|| pending(&fixture.bridge).len() == 1).await;
    let private_root = prepared.lease.root.clone();
    fixture.bridge.fence_process(&fixture.launch.key).unwrap();
    fixture.bridge.fence_process(&fixture.launch.key).unwrap();
    assert_eq!(response(held).await, None);
    assert!(pending(&fixture.bridge).is_empty());
    assert!(private_root.exists(), "admission fence must not claim tree cleanup");
    assert_eq!(authenticate(&prepared.lease,
        serde_json::from_value(request(&ctx, "after-fence")).unwrap()),
        Err("builtin_local_auth"));
    drop(prepared);
    assert!(!private_root.exists());
}
