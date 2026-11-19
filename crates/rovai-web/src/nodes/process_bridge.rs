//! Trusted in-process attachment of Core native drivers to authenticated Node
//! sockets. These capabilities are deliberately absent from the HTTP allowlist.
use super::{
    Hub, Outbound,
    process_pipe::{HubLauncher, PipeRegistry},
};
use crate::auth::Sessions;
use anyhow::{Context, Result, ensure};
use loom_protocol::builtin_pipe::{BuiltinCallV1, BuiltinReplyV1};
use loom_protocol::computer::COMPUTER_VERSION;
use loom_protocol::process_pipe::{PROCESS_PIPE_VERSION, ProcessOpenV1, ProcessPipeCommand};
use loom_protocol::{ClientMessage, ServerMessage};
use rovai_core::{
    application::CoreService,
    execution_node::{NodeStore, WorkspaceRecord},
    remote_process::ScopedRemoteLaunch,
};
use std::{any::Any, path::Path, sync::Arc, time::Duration};

static PROVIDER_INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl Hub {
    /// Reopening the Web listener retains the installed controller and warm
    /// native parsers. A different provider requires an explicit drain.
    pub(crate) fn for_core(
        core: &CoreService,
        sessions: Arc<Sessions>,
        data_dir: &Path,
    ) -> Result<Arc<Self>> {
        let _install = PROVIDER_INSTALL
            .lock()
            .map_err(|_| anyhow::anyhow!("node provider installation unavailable"))?;
        let directory = data_dir
            .canonicalize()
            .context("node storage is unavailable")?;
        if let Some(provider) = core.remote_process_launcher()? {
            let existing = (provider.as_ref() as &dyn Any)
                .downcast_ref::<HubLauncher>()
                .context("remote provider replacement requires drain")?;
            let hub = existing.hub();
            ensure!(
                hub.runtime_directory.get() == Some(&directory),
                "remote provider storage mismatch"
            );
            *hub.sessions
                .write()
                .map_err(|_| anyhow::anyhow!("session store unavailable"))? = sessions;
            let rpc = hub
                .workspace_transport
                .get()
                .context("workspace transport unavailable")?;
            core.install_workspace_rpc_transport(rpc.clone())?;
            return Ok(hub);
        }
        let hub = Self::start(sessions, NodeStore::open(&directory.join("rovai.sqlite"))?);
        hub.core
            .set(core.clone())
            .map_err(|_| anyhow::anyhow!("node core already installed"))?;
        hub.runtime_directory
            .set(directory.clone())
            .map_err(|_| anyhow::anyhow!("node storage already installed"))?;
        let registry = PipeRegistry::new(Arc::downgrade(&hub), &directory)
            .map_err(|code| anyhow::anyhow!(code))?;
        hub.pipes
            .set(registry.clone())
            .map_err(|_| anyhow::anyhow!("node pipe already installed"))?;
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis(),
        )?;
        hub.store
            .rpc_recover(now)
            .map_err(|code| anyhow::anyhow!(code.code()))?;
        let rpc = super::workspace_rpc::transport(&hub);
        hub.workspace_transport
            .set(rpc.clone())
            .map_err(|_| anyhow::anyhow!("workspace transport already installed"))?;
        core.install_remote_process_launcher(Arc::new(HubLauncher::new(hub.clone(), registry)))?;
        core.install_workspace_rpc_transport(rpc)?;
        Ok(hub)
    }

    pub(crate) async fn current_connection(&self, node_id: &str, generation: u64) -> bool {
        let inner = self.inner.lock().await;
        !inner.revoked.contains(node_id)
            && inner.nodes.get(node_id).is_some_and(|node| {
                generation != 0 && node.generation == generation && node.outbound.is_some()
            })
    }

    pub(crate) async fn set_process_versions(
        &self,
        node_id: &str,
        generation: u64,
        pipe: Vec<u32>,
        rpc: Vec<u32>,
    ) {
        let mut inner = self.inner.lock().await;
        if let Some(node) = inner.nodes.get_mut(node_id)
            && node.generation == generation
        {
            node.process_pipe_versions = pipe;
            node.workspace_rpc_versions = rpc;
        }
    }

    /// The catalog generation is an installation fact. This returned number is
    /// only the current socket fence and must never replace it in FrozenTarget.
    pub(crate) async fn process_connection_generation(
        &self,
        open: &ProcessOpenV1,
    ) -> Result<u64, &'static str> {
        let inner = self.inner.lock().await;
        if inner.revoked.contains(&open.key.node_id) {
            return Err("token_revoked");
        }
        let node = inner.nodes.get(&open.key.node_id).ok_or("node_offline")?;
        if node.outbound.is_none() {
            return Err("node_offline");
        }
        if !node.process_pipe_versions.contains(&PROCESS_PIPE_VERSION)
            || !node.process_pipe_versions.contains(&open.version) {
            return Err("pipe_version_unsupported");
        }
        if !node.clis.iter().any(|cli| {
            cli.adapter_kind == open.adapter_kind
                && cli.path_present
                && cli.path == open.program
                && cli.installation_identity.as_deref() == Some(open.program_identity.as_str())
                && cli.installation_generation == Some(open.catalog_generation)
        }) {
            return Err("pipe_installation_changed");
        }
        Ok(node.generation)
    }

    pub(crate) async fn send_node_message(
        &self,
        node_id: &str,
        message: ServerMessage,
        urgent: bool,
    ) -> Result<(), &'static str> {
        let generation = {
            let inner = self.inner.lock().await;
            inner
                .nodes
                .get(node_id)
                .filter(|node| node.outbound.is_some())
                .map(|node| node.generation)
                .ok_or("node_offline")?
        };
        self.send_node_message_generation(node_id, generation, message, urgent)
            .await
    }

    /// Reserve bounded capacity without holding the registry lock, then fence
    /// and enqueue synchronously under the same lock. An obsolete socket can
    /// never receive a request recorded against its replacement generation.
    pub(crate) async fn send_node_message_generation(
        &self,
        node_id: &str,
        generation: u64,
        message: ServerMessage,
        urgent: bool,
    ) -> Result<(), &'static str> {
        let priority = match &message {
            // All other pipe commands, especially ACK and Release, share FIFO.
            ServerMessage::ProcessPipe { command } => {
                matches!(command, ProcessPipeCommand::Terminate { .. })
            }
            ServerMessage::WorkspaceRpcCancel { .. } | ServerMessage::BuiltinReply { .. } => true,
            _ => urgent,
        };
        let text = message.to_json();
        if text.len() > super::MAX_FRAME {
            return Err("node_message_too_large");
        }
        let required_pipe_version = match &message {
            ServerMessage::ProcessPipe { command: ProcessPipeCommand::Open { launch } } => launch.version,
            _ => PROCESS_PIPE_VERSION,
        };
        let needs_pipe = matches!(&message, ServerMessage::ProcessPipe { .. } | ServerMessage::BuiltinReply { .. });
        // A computer frame may only reach a node that announced the capability
        // on *this* connection generation.
        let needs_computer = matches!(&message, ServerMessage::Computer { .. });
        let sender = {
            let inner = self.inner.lock().await;
            if inner.revoked.contains(node_id) {
                return Err("token_revoked");
            }
            let node = inner.nodes.get(node_id).ok_or("node_offline")?;
            if node.generation != generation {
                return Err("node_connection_changed");
            }
            if matches!(
                &message,
                ServerMessage::ProcessPipe { .. } | ServerMessage::BuiltinReply { .. }
            ) && (!node.process_pipe_versions.contains(&PROCESS_PIPE_VERSION)
                || !node.process_pipe_versions.contains(&required_pipe_version))
            {
                return Err("pipe_version_unsupported");
            }
            if matches!(
                &message,
                ServerMessage::WorkspaceRpcDispatch { .. }
                    | ServerMessage::WorkspaceRpcCancel { .. }
                    | ServerMessage::WorkspaceRpcReplay { .. }
            ) && !node
                .workspace_rpc_versions
                .contains(&loom_protocol::workspace_rpc::RPC_VERSION)
            {
                return Err("workspace_rpc_version_unsupported");
            }
            if needs_computer && !node.computer_versions.contains(&COMPUTER_VERSION) {
                return Err("computer_version_unsupported");
            }
            let outbox = node.outbound.as_ref().ok_or("node_offline")?;
            if priority {
                outbox.urgent.as_ref().unwrap_or(&outbox.tx).clone()
            } else {
                outbox.tx.clone()
            }
        };
        let permit = tokio::time::timeout(Duration::from_secs(2), sender.reserve_owned())
            .await
            .map_err(|_| "node_backpressure")?
            .map_err(|_| "node_offline")?;
        let inner = self.inner.lock().await;
        if inner.revoked.contains(node_id)
            || !inner
                .nodes
                .get(node_id)
                .is_some_and(|node| node.generation == generation && node.outbound.is_some())
        {
            return Err("node_connection_changed");
        }
        if needs_pipe && !inner.nodes.get(node_id)
            .is_some_and(|node| node.process_pipe_versions.contains(&PROCESS_PIPE_VERSION)
                && node.process_pipe_versions.contains(&required_pipe_version)) {
            return Err("pipe_version_unsupported");
        }
        if needs_computer
            && !inner
                .nodes
                .get(node_id)
                .is_some_and(|node| node.computer_versions.contains(&COMPUTER_VERSION))
        {
            return Err("computer_version_unsupported");
        }
        permit.send(Outbound::Text(text));
        drop(inner);
        Ok(())
    }

    pub(crate) async fn ensure_remote_workspace(
        &self,
        launch: &ScopedRemoteLaunch,
    ) -> Result<(), &'static str> {
        self.store
            .revalidate_remote_launch(launch)
            .map_err(|_| "remote_launch_not_authorized")?;
        self.ensure_workspace_authority(&launch.host_scope.workspace_id, &launch.key.node_id)
            .await?;
        self.store
            .revalidate_remote_launch(launch)
            .map_err(|_| "remote_launch_not_authorized")?;
        Ok(())
    }

    /// Only a Core-persisted workspace is eligible for a PrepareWorktree. The
    /// request id is the immutable workspace id used by B's private authority.
    pub(crate) async fn ensure_workspace_authority(
        &self,
        workspace_id: &str,
        node_id: &str,
    ) -> Result<(), &'static str> {
        let _prepare = self.workspace_prepare.lock().await;
        let record = self
            .store
            .workspace_by_id(workspace_id)
            .map_err(|_| "workspace_store_unavailable")?
            .ok_or("workspace_not_found")?;
        if record.execution_host_id != node_id || record.owner_role != "remote" {
            return Err("workspace_binding_changed");
        }
        self.prepare_workspace_record(&record).await
    }

    async fn prepare_workspace_record(&self, record: &WorkspaceRecord) -> Result<(), &'static str> {
        let response = self
            .call_fs(
                &record.execution_host_id,
                &record.id,
                ServerMessage::PrepareWorktree {
                    request_id: record.id.clone(),
                    source: record.repository_root.clone(),
                    worktree: record.worktree_path.clone(),
                    branch: record.branch.clone(),
                },
            )
            .await?;
        match response {
            ClientMessage::FsResult {
                code,
                source,
                worktree,
                common_dir,
                branch,
                ..
            } if code.is_empty()
                && source == record.repository_root
                && worktree == record.worktree_path
                && common_dir == record.git_common_dir
                && branch == record.branch =>
            {
                Ok(())
            }
            _ => Err("workspace_binding_changed"),
        }
    }

    /// B owns local IPC credentials; A receives only a typed operation scoped to
    /// a currently bound process lease. Work runs outside the WS reader.
    pub(crate) async fn handle_builtin_call(
        self: &Arc<Self>,
        node_id: &str,
        generation: u64,
        call: BuiltinCallV1,
    ) {
        if !self.current_connection(node_id, generation).await || call.validate().is_err() {
            return;
        }
        let Ok(request_digest) = call.digest() else {
            return;
        };
        let Ok(permit) = self.builtin_jobs.clone().try_acquire_owned() else {
            return;
        };
        let hub = self.clone();
        let node_id = node_id.to_owned();
        tokio::spawn(async move {
            let _permit = permit;
            let mut response = None;
            if hub.current_connection(&node_id, generation).await
                && let (Some(registry), Some(core)) = (hub.pipes.get(), hub.core.get())
                && let Ok(invocation) = registry.authorize_builtin(&node_id, generation, &call)
            {
                response = core
                    .invoke_remote_builtin(invocation)
                    .await
                    .ok()
                    .and_then(|value| serde_json::to_value(value).ok());
            }
            let mut reply = BuiltinReplyV1 {
                version: call.version,
                key: call.key,
                binding_seq: call.binding_seq,
                request_id: call.request_id,
                request_digest,
                response,
            };
            // A response too large to transport is unconfirmed; never invent a
            // smaller successful result. Core retains its idempotency receipt.
            if reply.validate().is_err() {
                reply.response = None;
            }
            let _ = hub
                .send_node_message_generation(
                    &node_id,
                    generation,
                    ServerMessage::BuiltinReply { reply },
                    true,
                )
                .await;
        });
    }
}
