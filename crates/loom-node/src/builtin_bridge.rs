//! Node-owned IPC for the EXISTING Rovai CLI binary.
//! The CLI parser and output contract remain in rovai. Local credentials never
//! cross the Node channel; A resolves its own current Core lease from the
//! authenticated process key, owner and monotonic binding receipt.
use std::{
    collections::{BTreeMap, HashMap}, ffi::OsString, path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}}, time::Duration,
};
use loom_protocol::{
    builtin_pipe::{BuiltinCallV1, BuiltinReplyV1, BuiltinResult, BUILTIN_PIPE_VERSION,
        MAX_BUILTIN_FRAME, MAX_PENDING_BUILTINS},
    process_pipe::{AgentRunOwner, BindProcessOwner, ProcessOpenV1, RemoteProcessKey,
        MAX_SAFE_COUNTER},
};
use rovai_local_ipc::{LocalIpcEndpoint, LocalIpcListener, LocalIpcStream};
use rovai_process_boundary::{NativeProcess, ProcessSpec, StdinPolicy, inspect_application_identity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{Semaphore, oneshot, watch},
};

const CONTRACT_VERSION: u32 = 46;
const IPC_VERSION: u32 = 3;
const LOCAL_FRAME_BUDGET: Duration = Duration::from_secs(5);
const CALL_BUDGET: Duration = Duration::from_secs(25);
type CallId = (RemoteProcessKey, u64, String);
type Waiter = oneshot::Sender<Option<Value>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLease {
    execution_root: String, run_tmp: String, lease_id: String,
    lease_generation: u64, lease_token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliContext {
    contract_version: u32, ipc_protocol_version: u32, core_endpoint: LocalIpcEndpoint,
    process_id: String, process_token: String, lease: Option<LocalLease>, tasks_enabled: bool,
}
#[derive(Clone)]
struct Binding {
    owner: Option<AgentRunOwner>, binding_seq: u64, lease: Option<LocalLease>,
    tasks_enabled: bool, receipt: Option<(String, String)>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalCall {
    ipc_protocol_version: u32, process_id: String, process_token: String,
    lease_id: String, lease_generation: u64, lease_token: String,
    kind: String,
    // BuiltinToolIpcRequestBody's existing flattened enum uses this exact name.
    #[serde(rename = "request_id")]
    request_id: String,
    operation: String, input: Value,
    #[serde(default)]
    send_input_file_path: Option<String>,
}
struct PendingCall {
    dispatch_id: uuid::Uuid, call: BuiltinCallV1, digest: String, waiters: Vec<Waiter>,
}
/// Node-local lifetime identity, never serialized onto the authenticated wire.
/// A completed/expired request may be retried with the same business identity;
/// the relay must still send that new pending lifetime to Core's request journal.
#[derive(Clone)]
pub(crate) struct PendingBuiltinDispatch {
    pub(crate) dispatch_id: uuid::Uuid,
    pub(crate) call: BuiltinCallV1,
    pub(crate) request_digest: String,
}
struct ProcessLease {
    key: RemoteProcessKey, controller_id: String, root: PathBuf, context_path: PathBuf,
    run_tmp: PathBuf, execution_root: String, endpoint: LocalIpcEndpoint,
    process_id: String, process_token: String, binding: Mutex<Binding>,
    closed: AtomicBool, close: watch::Sender<bool>, bridge: Weak<BridgeInner>,
}
struct BridgeInner {
    root: PathBuf, helper: ProcessSpec,
    leases: Mutex<HashMap<RemoteProcessKey, Weak<ProcessLease>>>,
    pending: Mutex<HashMap<CallId, PendingCall>>,
    wake: watch::Sender<u64>, capacity: Arc<Semaphore>,
}
#[derive(Clone)]
pub(crate) struct BuiltinBridge { inner: Arc<BridgeInner> }

/// Retain inside the process actor's material guard. Drop only after a positive
/// tree-empty receipt, or before spawn if admission fails.
pub(crate) struct PreparedBuiltin { lease: Arc<ProcessLease>, helper: PathBuf }
impl PreparedBuiltin {
    pub(crate) fn environment(&self) -> BuiltinResult<BTreeMap<OsString, OsString>> {
        let visible = |path: &Path| crate::run_bundle::native_path(path)
            .map(OsString::from).map_err(|_| "builtin_native_path");
        Ok(BTreeMap::from([
            (OsString::from("ROVAI_AGENT_CLI"), visible(&self.helper)?),
            (OsString::from("ROVAI_CLI_CONTEXT"), visible(&self.lease.context_path)?),
            (OsString::from("ROVAI_RUN_TMP"), visible(&self.lease.run_tmp)?),
        ]))
    }
    pub(crate) fn run_tmp(&self) -> &Path { &self.lease.run_tmp }
}
impl Drop for PreparedBuiltin {
    fn drop(&mut self) {
        self.lease.closed.store(true, Ordering::Release);
        self.lease.close.send_replace(true);
        if let Some(bridge) = self.lease.bridge.upgrade() {
            if let Ok(mut pending) = bridge.pending.lock() {
                pending.retain(|(key, _, _), _| key != &self.lease.key);
            }
            if let Ok(mut leases) = bridge.leases.lock() { leases.remove(&self.lease.key); }
        }
        // The root is newly generated and exclusively owned by this guard.
        // Re-admit before cleanup; a replaced or reparse-point root is retained.
        if admit_existing_private_directory(&self.lease.root)
            .is_ok_and(|root| root == self.lease.root) {
            let _ = std::fs::remove_dir_all(&self.lease.root);
        }
    }
}
impl BuiltinBridge {
    /// The Node selects its installed helper locally; no wire path can select it.
    pub(crate) async fn new(data_dir: &Path, helper: &Path) -> BuiltinResult<Self> {
        let root = private_directory(&data_dir.join("builtin-pipes"))?;
        let helper = std::fs::canonicalize(helper).map_err(|_| "builtin_helper_missing")?;
        let mut environment = BTreeMap::new();
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SystemRoot") {
            environment.insert(OsString::from("SystemRoot"), root);
        }
        environment.insert(OsString::from("NO_COLOR"), OsString::from("1"));
        let spec = ProcessSpec::new(helper, vec![OsString::from("--version")], root.clone(),
            environment, StdinPolicy::Null).map_err(|_| "builtin_helper_admission")?;
        verify_helper(&spec).await?;
        Self::from_verified(root, spec)
    }
    fn from_verified(root: PathBuf, helper: ProcessSpec) -> BuiltinResult<Self> {
        let (wake, _) = watch::channel(0);
        Ok(Self { inner: Arc::new(BridgeInner { root, helper,
            leases: Mutex::new(HashMap::new()), pending: Mutex::new(HashMap::new()),
            wake, capacity: Arc::new(Semaphore::new(32)),
        }) })
    }
    /// Test-only native IPC/actor fixture. This deliberately does not prove the
    /// installed Rovai helper's --version or capabilities; the real CLI seam does.
    #[cfg(test)]
    pub(crate) fn from_verified_test_spec(root: PathBuf, helper: ProcessSpec) -> BuiltinResult<Self> {
        Self::from_verified(root, helper)
    }
    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> { self.inner.wake.subscribe() }
    /// Snapshot is retained across websocket replacement. Core's existing
    /// request journal, not a new Node scheduler, owns invocation deduplication.
    pub(crate) fn pending_dispatches(&self) -> BuiltinResult<Vec<PendingBuiltinDispatch>> {
        let mut pending = self.inner.pending.lock().map_err(|_| "builtin_bridge_unavailable")?;
        pending.retain(|_, item| {
            item.waiters.retain(|waiter| !waiter.is_closed());
            !item.waiters.is_empty()
        });
        Ok(pending.values().map(|item| PendingBuiltinDispatch {
            dispatch_id: item.dispatch_id, call: item.call.clone(),
            request_digest: item.digest.clone(),
        }).collect())
    }
    pub(crate) fn complete(&self, reply: BuiltinReplyV1) -> BuiltinResult<()> {
        reply.validate()?;
        let id = (reply.key.clone(), reply.binding_seq, reply.request_id.clone());
        let mut pending = self.inner.pending.lock().map_err(|_| "builtin_bridge_unavailable")?;
        let Some(item) = pending.get(&id) else { return Ok(()); };
        if item.digest != reply.request_digest { return Err("builtin_reply_conflict"); }
        let item = pending.remove(&id).ok_or("builtin_bridge_unavailable")?;
        drop(pending);
        for waiter in item.waiters { let _ = waiter.send(reply.response.clone()); }
        self.inner.wake.send_modify(|n| *n = n.wrapping_add(1));
        Ok(())
    }
    /// Close local admission before attempting a fatal-sync process termination.
    /// This is NOT a tree-empty receipt: the actor keeps its material guard and
    /// private files until the existing native cleanup authority proves that.
    pub(crate) fn fence_process(&self, key: &RemoteProcessKey) -> BuiltinResult<()> {
        let lease = self.inner.leases.lock().map_err(|_| "builtin_bridge_unavailable")?
            .get(key).and_then(Weak::upgrade);
        let Some(lease) = lease else { return Ok(()); };
        lease.closed.store(true, Ordering::Release);
        lease.close.send_replace(true);
        self.inner.pending.lock().map_err(|_| "builtin_bridge_unavailable")?
            .retain(|(pending_key, _, _), _| pending_key != key);
        self.inner.wake.send_modify(|n| *n = n.wrapping_add(1));
        Ok(())
    }
    pub(crate) fn prepare(&self, launch: &ProcessOpenV1)
        -> BuiltinResult<PreparedBuiltin> {
        launch.validate()?;
        let tasks_enabled = launch.builtin_tasks_enabled;
        if inspect_application_identity(self.inner.helper.application())
            .map_err(|_| "builtin_helper_changed")? != self.inner.helper.application_identity_digest() {
            return Err("builtin_helper_changed");
        }
        let execution_root = std::fs::canonicalize(&launch.cwd).map_err(|_| "builtin_workspace")?;
        let mut leases = self.inner.leases.lock().map_err(|_| "builtin_bridge_unavailable")?;
        leases.retain(|_, lease| lease.strong_count() > 0);
        if leases.contains_key(&launch.key) { return Err("builtin_process_exists"); }
        let root = new_private_directory(&self.inner.root.join(uuid::Uuid::new_v4().simple().to_string()))?;
        let run_tmp = match new_private_directory(&root.join("run-tmp")) {
            Ok(path) => path,
            Err(error) => { let _ = std::fs::remove_dir_all(&root); return Err(error); }
        };
        let endpoint = match local_endpoint(&root) {
            Ok(endpoint) => endpoint,
            Err(error) => { let _ = std::fs::remove_dir_all(&root); return Err(error); }
        };
        let listener = match LocalIpcListener::bind(&endpoint) {
            Ok(listener) => listener,
            Err(_) => { let _ = std::fs::remove_dir_all(&root); return Err("builtin_ipc_bind"); }
        };
        let (close, closed) = watch::channel(false);
        let lease = Arc::new(ProcessLease {
            key: launch.key.clone(), controller_id: launch.session.controller_id.clone(),
            context_path: root.join("context.json"), root, run_tmp,
            execution_root: execution_root.to_string_lossy().into_owned(), endpoint,
            process_id: format!("node-cli-{}", uuid::Uuid::new_v4()),
            process_token: token(), binding: Mutex::new(Binding { owner: Some(launch.owner.clone()),
                binding_seq: 0, lease: None, tasks_enabled, receipt: None }),
            closed: AtomicBool::new(false), close, bridge: Arc::downgrade(&self.inner),
        });
        let prepared = PreparedBuiltin { lease: lease.clone(), helper: self.inner.helper.application().into() };
        // Do not drop the guard while holding leases: its Drop removes this key.
        let result = (|| {
            let mut binding = lease.binding.lock().map_err(|_| "builtin_binding_unavailable")?;
            binding.lease = Some(lease_for(&lease, 0)?);
            write_context(&lease, &binding)
        })();
        if let Err(error) = result { drop(leases); drop(prepared); return Err(error); }
        leases.insert(launch.key.clone(), Arc::downgrade(&lease));
        drop(leases);
        tokio::spawn(listen(listener, Arc::downgrade(&lease), closed));
        Ok(prepared)
    }
    /// Call only AFTER the actor's FIFO BindOwner succeeds and BEFORE returning
    /// OwnerBound. On failure the wrapper must fence/stop, never acknowledge it.
    pub(crate) fn bind_owner(&self, request: &BindProcessOwner)
        -> BuiltinResult<()> {
        request.validate()?;
        let tasks_enabled = request.builtin_tasks_enabled;
        let lease = self.inner.leases.lock().map_err(|_| "builtin_bridge_unavailable")?
            .get(&request.key).and_then(Weak::upgrade).ok_or("builtin_process_missing")?;
        if lease.closed.load(Ordering::Acquire) || request.controller_id != lease.controller_id {
            return Err("builtin_process_closed");
        }
        let envelope = request.digest()?;
        let mut current = lease.binding.lock().map_err(|_| "builtin_binding_unavailable")?;
        if request.binding_seq == current.binding_seq {
            return if current.receipt.as_ref() == Some(&(request.request_id.clone(), envelope)) {
                Ok(())
            } else { Err("builtin_binding_conflict") };
        }
        if request.binding_seq != current.binding_seq.checked_add(1).ok_or("builtin_counter_exhausted")?
            || request.previous_owner != current.owner {
            return Err("builtin_binding_conflict");
        }
        let next = Binding {
            owner: request.next_owner.clone(), binding_seq: request.binding_seq,
            lease: request.next_owner.as_ref().map(|_| lease_for(&lease, request.binding_seq)).transpose()?,
            tasks_enabled, receipt: Some((request.request_id.clone(), envelope)),
        };
        write_context(&lease, &next)?;
        *current = next;
        drop(current);
        // Old callers keep their old wire identity. Closing pending waiters
        // cannot reattribute an already dispatched call to the successor Run.
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.retain(|(key, sequence, _), _| key != &request.key || *sequence == request.binding_seq);
        }
        Ok(())
    }
}
fn token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}
fn lease_for(process: &ProcessLease, binding_seq: u64) -> BuiltinResult<LocalLease> {
    let generation = binding_seq.checked_add(1).filter(|n| *n <= MAX_SAFE_COUNTER)
        .ok_or("builtin_counter_exhausted")?;
    Ok(LocalLease { execution_root: process.execution_root.clone(),
        run_tmp: process.run_tmp.to_string_lossy().into_owned(),
        lease_id: format!("node-lease-{}", uuid::Uuid::new_v4()), lease_generation: generation,
        lease_token: token() })
}
fn write_context(process: &ProcessLease, binding: &Binding) -> BuiltinResult<()> {
    let context = CliContext { contract_version: CONTRACT_VERSION, ipc_protocol_version: IPC_VERSION,
        core_endpoint: process.endpoint.clone(), process_id: process.process_id.clone(),
        process_token: process.process_token.clone(), lease: binding.lease.clone(),
        tasks_enabled: binding.owner.is_some() && binding.tasks_enabled };
    let bytes = serde_json::to_vec(&context).map_err(|_| "builtin_context_encoding")?;
    rovai_private_storage::atomic_write_private_bytes(&process.context_path, &bytes)
        .map_err(|_| "builtin_context_write")
}
fn private_directory(path: &Path) -> BuiltinResult<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink()
                && metadata.mode() & 0o077 == 0 => {}
            Ok(_) => return Err("builtin_private_directory"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::DirBuilder::new().mode(0o700).create(path)
                    .map_err(|_| "builtin_private_directory")?;
            }
            Err(_) => return Err("builtin_private_directory"),
        }
    }
    rovai_private_storage::prepare_private_directory(path).map_err(|_| "builtin_private_directory")
}
fn admit_existing_private_directory(path: &Path) -> BuiltinResult<PathBuf> {
    #[cfg(windows)]
    { rovai_private_storage::admit_private_directory(path).map_err(|_| "builtin_private_directory") }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path).map_err(|_| "builtin_private_directory")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.mode() & 0o077 != 0 {
            return Err("builtin_private_directory");
        }
        std::fs::canonicalize(path).map_err(|_| "builtin_private_directory")
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = path; Err("builtin_platform_unsupported") }
}
fn new_private_directory(path: &Path) -> BuiltinResult<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path).map_err(|_| "builtin_private_directory")?;
        std::fs::canonicalize(path).map_err(|_| "builtin_private_directory")
    }
    #[cfg(windows)]
    { rovai_private_storage::create_private_directory(path).map_err(|_| "builtin_private_directory") }
    #[cfg(not(any(unix, windows)))]
    { let _ = path; Err("builtin_platform_unsupported") }
}
fn local_endpoint(root: &Path) -> BuiltinResult<LocalIpcEndpoint> {
    #[cfg(windows)]
    {
        let _ = root;
        Ok(LocalIpcEndpoint::WindowsNamedPipe { name: format!(
            r"\\.\pipe\rovai-ai-{}-{}", std::process::id(), uuid::Uuid::new_v4()) })
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = root.join("cli.sock");
        if path.as_os_str().as_bytes().len() >= 104 { return Err("builtin_ipc_path_too_long"); }
        Ok(LocalIpcEndpoint::UnixSocket {
            path: path.to_str().ok_or("builtin_ipc_path_encoding")?.into(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = root; Err("builtin_platform_unsupported") }
}
async fn verify_helper(spec: &ProcessSpec) -> BuiltinResult<()> {
    let mut child = NativeProcess::spawn(spec).map_err(|_| "builtin_helper_spawn")?;
    let stdout = child.take_stdout().ok_or("builtin_helper_stdout")?;
    let stderr = child.take_stderr().ok_or("builtin_helper_stderr")?;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = stdout.take(4097);
        let mut stderr = stderr.take(4097);
        let (status, read_out, read_err) = tokio::join!(
            child.wait(),
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err));
        let status = status.map_err(|_| "builtin_helper_exit")?;
        read_out.map_err(|_| "builtin_helper_read")?;
        read_err.map_err(|_| "builtin_helper_read")?;
        if !status.success() || out.len() > 4096 || err.len() > 4096 { return Err("builtin_helper_contract"); }
        let version = std::str::from_utf8(&out).map_err(|_| "builtin_helper_contract")?;
        let fields: Vec<_> = version.split_whitespace().collect();
        if fields.len() != 4 || fields[0] != "rovai"
            || fields[2] != format!("contract-v{CONTRACT_VERSION}")
            || fields[3] != format!("ipc-v{IPC_VERSION}") {
            return Err("builtin_helper_contract");
        }
        Ok(())
    }).await.map_err(|_| "builtin_helper_timeout").and_then(|result| result);
    // Even a --version helper must not leave descendants behind.
    let cleanup = child.terminate_and_wait(Duration::from_secs(2)).await
        .map_err(|_| "builtin_helper_cleanup_unconfirmed")?;
    if !cleanup.tree_empty { return Err("builtin_helper_cleanup_unconfirmed"); }
    result
}
async fn listen(mut listener: LocalIpcListener, lease: Weak<ProcessLease>, mut closed: watch::Receiver<bool>) {
    loop {
        if *closed.borrow() { break; }
        tokio::select! {
            changed = closed.changed() => { if changed.is_err() || *closed.borrow() { break; } }
            accepted = listener.accept() => {
                let stream = match accepted {
                    Ok(stream) => stream,
                    Err(error) => {
                        if error.closes_admission() { break; }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                        continue;
                    }
                };
                let Some(process) = lease.upgrade() else { break; };
                let Some(bridge) = process.bridge.upgrade() else { break; };
                let Ok(permit) = bridge.capacity.clone().try_acquire_owned() else { continue; };
                tokio::spawn(async move {
                    let _permit = permit;
                    // Never log request, auth, input, response, or raw error.
                    let _ = handle(stream, process, bridge).await;
                });
            }
        }
    }
}
fn authenticate(process: &ProcessLease, local: LocalCall) -> BuiltinResult<BuiltinCallV1> {
    if local.ipc_protocol_version != IPC_VERSION || local.kind != "invoke"
        || local.process_id != process.process_id || local.process_token != process.process_token
        || process.closed.load(Ordering::Acquire) {
        return Err("builtin_local_auth");
    }
    let binding = process.binding.lock().map_err(|_| "builtin_binding_unavailable")?;
    let lease = binding.lease.as_ref().ok_or("builtin_unbound")?;
    let owner = binding.owner.as_ref().ok_or("builtin_unbound")?;
    if local.lease_id != lease.lease_id || local.lease_generation != lease.lease_generation
        || local.lease_token != lease.lease_token {
        return Err("builtin_local_auth");
    }
    let call = BuiltinCallV1 { version: BUILTIN_PIPE_VERSION, key: process.key.clone(),
        owner: owner.clone(), binding_seq: binding.binding_seq, request_id: local.request_id,
        operation: local.operation, input: local.input, send_input_file_path: local.send_input_file_path };
    call.validate()?;
    Ok(call)
}
async fn handle(mut stream: LocalIpcStream, process: Arc<ProcessLease>, bridge: Arc<BridgeInner>)
    -> BuiltinResult<()> {
    let mut frame = Vec::new();
    tokio::time::timeout(LOCAL_FRAME_BUDGET, async {
        let limited = (&mut stream).take((MAX_BUILTIN_FRAME + 1) as u64);
        BufReader::new(limited).read_until(b'\n', &mut frame).await
    }).await.map_err(|_| "builtin_frame_timeout")?
        .map_err(|_| "builtin_frame_read")?;
    if frame.len() > MAX_BUILTIN_FRAME || frame.last() != Some(&b'\n') {
        return Err("builtin_frame_limit");
    }
    let local: LocalCall = serde_json::from_slice(&frame).map_err(|_| "builtin_frame_invalid")?;
    let call = authenticate(&process, local)?;
    let request_digest = call.digest()?;
    let (sender, receiver) = oneshot::channel();
    publish_call(&process, &bridge, call, request_digest, sender)?;
    // Failure after dispatch closes without manufacturing a failed/successful
    // business outcome. Existing CLI retries its exact serialized request.
    let response = tokio::time::timeout(CALL_BUDGET, receiver).await
        .map_err(|_| "builtin_outcome_unknown")?
        .map_err(|_| "builtin_outcome_unknown")?
        .ok_or("builtin_outcome_unknown")?;
    let mut bytes = serde_json::to_vec(&response).map_err(|_| "builtin_response_encoding")?;
    if bytes.len() >= MAX_BUILTIN_FRAME { return Err("builtin_response_limit"); }
    bytes.push(b'\n');
    tokio::time::timeout(LOCAL_FRAME_BUDGET, async {
        stream.write_all(&bytes).await?;
        stream.flush().await
    }).await.map_err(|_| "builtin_response_timeout")?
        .map_err(|_| "builtin_response_write")?;
    Ok(())
}
fn publish_call(process: &ProcessLease, bridge: &BridgeInner, call: BuiltinCallV1,
    request_digest: String, sender: Waiter) -> BuiltinResult<()> {
    // Authentication and hashing may have completed before an owner rotation.
    // Recheck while holding binding -> pending, the same one-way lock order as
    // binding mutation. No superseded caller can insert after rotation's prune.
    let binding = process.binding.lock().map_err(|_| "builtin_binding_unavailable")?;
    if binding.binding_seq != call.binding_seq || binding.owner.as_ref() != Some(&call.owner)
        || binding.lease.is_none() {
        return Err("builtin_binding_changed");
    }
    let id = (call.key.clone(), call.binding_seq, call.request_id.clone());
    let mut pending = bridge.pending.lock().map_err(|_| "builtin_bridge_unavailable")?;
    // A fatal-sync fence does not need the binding mutex and may race hashing.
    if process.closed.load(Ordering::Acquire) { return Err("builtin_process_closed"); }
    pending.retain(|_, item| {
        item.waiters.retain(|waiter| !waiter.is_closed());
        !item.waiters.is_empty()
    });
    if let Some(item) = pending.get_mut(&id) {
        if item.digest != request_digest { return Err("builtin_request_conflict"); }
        if item.waiters.len() >= 3 { return Err("builtin_request_capacity"); }
        item.waiters.push(sender);
    } else {
        if pending.len() >= MAX_PENDING_BUILTINS { return Err("builtin_request_capacity"); }
        pending.insert(id, PendingCall { dispatch_id: uuid::Uuid::new_v4(),
            call, digest: request_digest, waiters: vec![sender] });
    }
    drop(pending);
    drop(binding);
    bridge.wake.send_modify(|n| *n = n.wrapping_add(1));
    Ok(())
}
#[cfg(test)]
#[path = "builtin_bridge/tests.rs"]
mod tests;
