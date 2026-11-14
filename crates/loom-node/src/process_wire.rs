//! Bounded transport glue; one manager survives ordinary WebSocket reconnects.
use crate::{
    installation_catalog::InstallationCatalog, process_pipe::PipeManager,
    workspace_authority::WorkspaceAuthority,
};
use loom_protocol::{ClientMessage, process_pipe::*};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex, Semaphore, mpsc, watch};

struct Flow {
    controller: String,
    acked: u64,
    queued: u64,
    materialization: Option<BundleMaterializationV1>,
}
#[derive(Clone)]
struct Connection {
    generation: u64,
    control: mpsc::Sender<ClientMessage>,
    output: mpsc::Sender<ClientMessage>,
}
pub(crate) struct NodePipes {
    manager: PipeManager,
    builtin: Option<crate::builtin_bridge::BuiltinBridge>,
    catalog: InstallationCatalog,
    authority: WorkspaceAuthority,
    data_dir: PathBuf,
    connection: StdMutex<Option<Connection>>,
    generation: std::sync::atomic::AtomicU64,
    flows: Mutex<HashMap<RemoteProcessKey, Flow>>,
    open_gate: Mutex<()>,
    normal: Arc<Semaphore>,
    urgent: Arc<Semaphore>,
    changed: watch::Sender<u64>,
    closed: AtomicBool,
}
impl NodePipes {
    pub(crate) fn new(
        data_dir: PathBuf,
        node_id: &str,
        catalog: InstallationCatalog,
        authority: WorkspaceAuthority,
        builtin: Option<crate::builtin_bridge::BuiltinBridge>,
    ) -> Result<Arc<Self>, &'static str> {
        let manager = PipeManager::new(&data_dir, node_id)?;
        let (changed, _) = watch::channel(0);
        let this = Arc::new(Self {
            manager,
            builtin,
            catalog,
            authority,
            data_dir,
            connection: StdMutex::new(None),
            generation: std::sync::atomic::AtomicU64::new(0),
            flows: Mutex::new(HashMap::new()),
            open_gate: Mutex::new(()),
            normal: Arc::new(Semaphore::new(16)),
            urgent: Arc::new(Semaphore::new(8)),
            changed,
            closed: AtomicBool::new(false),
        });
        tokio::spawn(this.clone().flush());
        if this.builtin.is_some() {
            tokio::spawn(this.clone().flush_builtins());
        }
        Ok(this)
    }
    pub(crate) fn supported(&self) -> bool {
        self.builtin.is_some()
    }
    pub(crate) fn complete_builtin(
        &self,
        reply: loom_protocol::builtin_pipe::BuiltinReplyV1,
    ) -> Result<(), &'static str> {
        match self
            .builtin
            .as_ref()
            .ok_or("builtin_helper_missing")?
            .complete(reply)
        {
            // A mismatched reply has no authority to consume the pending call
            // or disconnect unrelated sessions on the authenticated socket.
            Err("builtin_reply_conflict") => Ok(()),
            outcome => outcome,
        }
    }
    pub(crate) async fn attach(
        &self,
        control: mpsc::Sender<ClientMessage>,
        output: mpsc::Sender<ClientMessage>,
    ) {
        // Cursor reset and connection replacement share the flow lock with the
        // flusher, so an old socket cannot overwrite a reconnect replay cursor.
        let mut flows = self.flows.lock().await;
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        for flow in flows.values_mut() {
            flow.queued = flow.acked;
        }
        *self.connection.lock().expect("pipe connection") = Some(Connection {
            generation,
            control,
            output,
        });
        drop(flows);
        self.wake();
    }
    pub(crate) fn disconnect(&self) {
        *self.connection.lock().expect("pipe connection") = None;
        self.wake();
    }
    fn disconnect_generation(&self, generation: u64) {
        let mut connection = self.connection.lock().expect("pipe connection");
        if connection
            .as_ref()
            .is_some_and(|value| value.generation == generation)
        {
            *connection = None;
        }
        drop(connection);
        self.wake();
    }
    fn wake(&self) {
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
    }
    fn connection(&self) -> Option<Connection> {
        self.connection.lock().ok()?.clone()
    }
    async fn control(&self, reply: ProcessControlReply) {
        if let Some(connection) = self.connection() {
            // A control backpressure timeout is transport loss, not success.
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                connection
                    .control
                    .send(ClientMessage::ProcessPipeControl { control: reply }),
            )
            .await;
        }
    }
    pub(crate) async fn handle(self: &Arc<Self>, command: ProcessPipeCommand) {
        let (key, request_id) = command_identity(&command);
        if self.closed.load(Ordering::Acquire) {
            self.control(refusal(key, request_id, "pipe_controller_stopped"))
                .await;
            return;
        }
        // ACK cursor updates finish in ingress order before a following Release.
        // They do not wait for native input or process termination.
        if matches!(command, ProcessPipeCommand::Ack { .. }) {
            if let Err(code) = command.validate() {
                self.control(refusal(key, request_id, code)).await;
                return;
            }
            if let Err(code) = self.apply(command).await {
                self.control(refusal(key, request_id, code)).await;
            }
            return;
        }
        if let Err(code) = command.validate() {
            let this = self.clone();
            // Even refusals are bounded by the independent control lane.
            if let Ok(permit) = self.urgent.clone().try_acquire_owned() {
                tokio::spawn(async move {
                    let _permit = permit;
                    this.control(refusal(key, request_id, code)).await;
                });
            }
            return;
        }
        let lane = if matches!(
            command,
            ProcessPipeCommand::Terminate { .. }
                | ProcessPipeCommand::Release { .. }
                | ProcessPipeCommand::Ack { .. }
        ) {
            &self.urgent
        } else {
            &self.normal
        };
        let Ok(permit) = lane.clone().try_acquire_owned() else {
            if let Some(connection) = self.connection() {
                let _ = connection
                    .control
                    .try_send(ClientMessage::ProcessPipeControl {
                        control: refusal(key, request_id, "pipe_transport_capacity"),
                    });
            }
            return;
        };
        let this = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            match this.apply(command).await {
                Ok(Some(reply)) => this.control(reply).await,
                Ok(None) => {}
                Err(code) => this.control(refusal(key, request_id, code)).await,
            }
        });
    }
    async fn apply(
        self: &Arc<Self>,
        command: ProcessPipeCommand,
    ) -> Result<Option<ProcessControlReply>, &'static str> {
        match command {
            ProcessPipeCommand::Open { launch } => {
                // replay_open never creates a process; fresh admission is used
                // only when there is no already live immutable Open identity.
                let _open = self.open_gate.lock().await;
                let (mut reply, materialization) = if let Some(reply) =
                    self.manager.replay_open(&launch)?
                {
                    let receipt = self
                        .flows
                        .lock()
                        .await
                        .get(&launch.key)
                        .and_then(|flow| flow.materialization.clone())
                        .ok_or("pipe_materialization_receipt_missing")?;
                    (reply, receipt)
                } else {
                    let builtin = self
                        .builtin
                        .as_ref()
                        .ok_or("builtin_helper_missing")?
                        .prepare(&launch)?;
                    let builtin_environment = builtin.environment()?;
                    let owner = self.clone();
                    let captured = launch.clone();
                    let (spec, materials) = tokio::task::spawn_blocking(move || {
                        crate::process_admission::prepare(
                            &owner.data_dir,
                            &owner.catalog,
                            &owner.authority,
                            &captured,
                            &builtin_environment,
                        )
                    })
                    .await
                    .map_err(|_| "pipe_admission_unavailable")??;
                    let bundle = launch.bundle.as_ref().ok_or("pipe_bundle_required")?;
                    let receipt = BundleMaterializationV1 {
                        bundle_id: bundle.bundle_id.clone(),
                        bundle_digest: bundle.digest.clone(),
                        skill_root: materials.skill_root()?,
                    };
                    receipt.validate()?;
                    (
                        self.manager
                            .open(&launch, spec, Some(Box::new((materials, builtin))))?,
                        receipt,
                    )
                };
                let mut flows = self.flows.lock().await;
                let flow = flows.entry(launch.key).or_insert(Flow {
                    controller: launch.session.controller_id.clone(),
                    acked: 0,
                    queued: 0,
                    materialization: None,
                });
                if flow.controller != launch.session.controller_id
                    || flow
                        .materialization
                        .as_ref()
                        .is_some_and(|previous| previous != &materialization)
                {
                    return Err("pipe_materialization_receipt");
                }
                flow.materialization = Some(materialization.clone());
                let ProcessControlBody::Opened {
                    materialization: receipt,
                    ..
                } = &mut reply.body
                else {
                    return Err("pipe_open_receipt");
                };
                *receipt = Some(materialization);
                drop(flows);
                self.wake();
                Ok(Some(reply))
            }
            ProcessPipeCommand::Input { input } => self.manager.input(input).await.map(Some),
            ProcessPipeCommand::BindOwner { binding } => {
                let reply = self.manager.bind_owner(binding.clone()).await?;
                // A refused FIFO boundary never changed the actor lease. Do
                // not rotate its local IPC context on an unaccepted request.
                let accepted = if reply.key == binding.key && reply.validate().is_ok() {
                    match &reply.body {
                        ProcessControlBody::Refused { .. } => return Ok(Some(reply)),
                        ProcessControlBody::OwnerBound {
                            request_id,
                            binding_seq,
                            owner,
                            builtin_tasks_enabled,
                            input_seq,
                        } => {
                            request_id == &binding.request_id
                                && *binding_seq == binding.binding_seq
                                && owner == &binding.next_owner
                                && *builtin_tasks_enabled == binding.builtin_tasks_enabled
                                && *input_seq == binding.after_input_seq
                        }
                        _ => false,
                    }
                } else {
                    false
                };
                if !accepted {
                    if let Some(bridge) = self.builtin.as_ref() {
                        let _ = bridge.fence_process(&binding.key);
                    }
                    let _ = self
                        .manager
                        .terminate(
                            &binding.key,
                            &format!("builtin-receipt-failed-{}", binding.binding_seq),
                            5000,
                        )
                        .await;
                    return Err("builtin_owner_receipt_invalid");
                }
                let synchronized = self
                    .builtin
                    .as_ref()
                    .ok_or("builtin_helper_missing")
                    .and_then(|bridge| bridge.bind_owner(&binding));
                if synchronized.is_err() {
                    if let Some(bridge) = self.builtin.as_ref() {
                        let _ = bridge.fence_process(&binding.key);
                    }
                    let _ = self
                        .manager
                        .terminate(
                            &binding.key,
                            &format!("builtin-sync-failed-{}", binding.binding_seq),
                            5000,
                        )
                        .await;
                    return Err("builtin_owner_sync_failed");
                }
                Ok(Some(reply))
            }
            ProcessPipeCommand::Terminate {
                key,
                request_id,
                budget_ms,
            } => self
                .manager
                .terminate(&key, &request_id, budget_ms)
                .await
                .map(Some),
            ProcessPipeCommand::Release {
                key,
                controller_id,
                request_id,
                acked_event_seq,
                abandon_output,
            } => {
                let reply = self
                    .manager
                    .release(
                        &key,
                        &controller_id,
                        &request_id,
                        acked_event_seq,
                        abandon_output,
                    )
                    .await?;
                self.flows.lock().await.remove(&key);
                self.wake();
                Ok(Some(reply))
            }
            ProcessPipeCommand::Resume {
                key,
                controller_id,
                after_event_seq,
            } => {
                let reply = self
                    .manager
                    .resume(&key, &controller_id, after_event_seq)
                    .await?;
                let mut flows = self.flows.lock().await;
                let entry = flows.entry(key).or_insert(Flow {
                    controller: controller_id.clone(),
                    acked: 0,
                    queued: 0,
                    materialization: None,
                });
                if entry.controller != controller_id {
                    return Err("pipe_controller_mismatch");
                }
                entry.queued = after_event_seq;
                drop(flows);
                self.wake();
                Ok(Some(reply))
            }
            ProcessPipeCommand::Ack {
                key,
                controller_id,
                event_seq,
            } => {
                self.manager.ack(&key, &controller_id, event_seq).await?;
                if let Some(entry) = self.flows.lock().await.get_mut(&key) {
                    if entry.controller != controller_id {
                        return Err("pipe_controller_mismatch");
                    }
                    entry.acked = entry.acked.max(event_seq);
                    entry.queued = entry.queued.max(event_seq);
                }
                self.wake();
                Ok(None)
            }
        }
    }
    async fn flush_builtins(self: Arc<Self>) {
        let Some(bridge) = self.builtin.as_ref() else {
            return;
        };
        let mut bridge_changed = bridge.subscribe();
        let mut transport_changed = self.changed.subscribe();
        let mut generation = 0;
        let mut sent = HashMap::<(RemoteProcessKey, u64, String), (uuid::Uuid, String)>::new();
        while !self.closed.load(Ordering::Acquire) {
            let connection = self.connection();
            let mut full = false;
            if let Some(connection) = connection.as_ref() {
                if generation != connection.generation {
                    generation = connection.generation;
                    sent.clear();
                }
                let Ok(calls) = bridge.pending_dispatches() else {
                    self.closed.store(true, Ordering::Release);
                    self.manager.shutdown().await;
                    self.wake();
                    break;
                };
                let ids = calls
                    .iter()
                    .map(|dispatch| {
                        let call = &dispatch.call;
                        (call.key.clone(), call.binding_seq, call.request_id.clone())
                    })
                    .collect::<std::collections::HashSet<_>>();
                sent.retain(|key, _| ids.contains(key));
                for dispatch in calls {
                    let call = dispatch.call;
                    let id = (call.key.clone(), call.binding_seq, call.request_id.clone());
                    let dispatch_identity = (dispatch.dispatch_id, dispatch.request_digest);
                    if sent.get(&id) == Some(&dispatch_identity) {
                        continue;
                    }
                    if self
                        .connection()
                        .is_none_or(|now| now.generation != generation)
                    {
                        break;
                    }
                    match connection
                        .control
                        .try_send(ClientMessage::BuiltinCall { call })
                    {
                        Ok(()) => {
                            sent.insert(id, dispatch_identity);
                        }
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            full = true;
                            break;
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            self.disconnect_generation(generation);
                            break;
                        }
                    }
                }
            }
            if full {
                if let Some(connection) = connection {
                    tokio::select! {
                        _=bridge_changed.changed()=>{},
                        _=transport_changed.changed()=>{},
                        slot=connection.control.reserve()=>{
                            if slot.is_err(){self.disconnect_generation(connection.generation);}
                        },
                    }
                }
            } else {
                tokio::select! {
                    _=bridge_changed.changed()=>{},
                    _=transport_changed.changed()=>{},
                }
            }
        }
    }

    async fn flush(self: Arc<Self>) {
        let mut manager_changed = self.manager.subscribe();
        let mut transport_changed = self.changed.subscribe();
        while !self.closed.load(Ordering::Acquire) {
            let connection = self.connection();
            let mut full = false;
            if let Some(connection) = connection.as_ref() {
                let flows = self
                    .flows
                    .lock()
                    .await
                    .iter()
                    .map(|(key, flow)| (key.clone(), flow.controller.clone(), flow.queued))
                    .collect::<Vec<_>>();
                for (key, controller, after) in flows {
                    let Ok(events) = self.manager.pending_events(&key, &controller, after).await
                    else {
                        continue;
                    };
                    for event in events {
                        if self
                            .connection()
                            .is_none_or(|now| now.generation != connection.generation)
                        {
                            break;
                        }
                        let sequence = event.event_seq;
                        match connection
                            .output
                            .try_send(ClientMessage::ProcessPipeOutput { output: event })
                        {
                            Ok(()) => {
                                let mut flows = self.flows.lock().await;
                                if self
                                    .connection()
                                    .is_some_and(|now| now.generation == connection.generation)
                                    && let Some(flow) = flows.get_mut(&key)
                                {
                                    if flow.controller == controller {
                                        flow.queued = flow.queued.max(sequence);
                                    }
                                }
                            }
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                full = true;
                                break;
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => {
                                break;
                            }
                        }
                    }
                    if full {
                        break;
                    }
                }
            }
            if full {
                if let Some(connection) = connection {
                    tokio::select! {
                        _=manager_changed.changed()=>{},
                        _=transport_changed.changed()=>{},
                        slot=connection.output.reserve()=>{ if slot.is_err() {self.disconnect_generation(connection.generation);} },
                    }
                }
            } else {
                tokio::select! {
                    _=manager_changed.changed()=>{},
                    _=transport_changed.changed()=>{},
                }
            }
        }
    }
    pub(crate) async fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.disconnect();
        self.manager.shutdown().await;
    }
}
fn refusal(
    key: RemoteProcessKey,
    request_id: Option<String>,
    code: &'static str,
) -> ProcessControlReply {
    ProcessControlReply {
        key,
        body: ProcessControlBody::Refused {
            request_id,
            code: code.into(),
        },
    }
}
fn command_identity(command: &ProcessPipeCommand) -> (RemoteProcessKey, Option<String>) {
    match command {
        ProcessPipeCommand::Open { launch } => (launch.key.clone(), None),
        ProcessPipeCommand::Input { input } => (input.key.clone(), Some(input.request_id.clone())),
        ProcessPipeCommand::BindOwner { binding } => {
            (binding.key.clone(), Some(binding.request_id.clone()))
        }
        ProcessPipeCommand::Terminate {
            key, request_id, ..
        }
        | ProcessPipeCommand::Release {
            key, request_id, ..
        } => (key.clone(), Some(request_id.clone())),
        ProcessPipeCommand::Resume { key, .. } | ProcessPipeCommand::Ack { key, .. } => {
            (key.clone(), None)
        }
    }
}

#[cfg(test)]
#[path = "process_wire/tests.rs"]
mod tests;
