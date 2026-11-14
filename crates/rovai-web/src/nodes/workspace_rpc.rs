//! Workspace RPC uses the authenticated node WebSocket and Core's durable
//! journal. It does not create an HTTP execute route or use B4 run credentials.
use super::Hub;
use loom_protocol::{ServerMessage, workspace_rpc::*};
use rovai_core::workspace_rpc_transport::{WorkspaceRpcFuture, WorkspaceRpcTransport};
use std::sync::{Arc, Weak};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
fn current(inner: &super::Inner, node: &str, generation: u64) -> bool {
    !inner.revoked.contains(node)
        && inner.nodes.get(node).is_some_and(|peer| {
            peer.generation == generation
                && peer.outbound.is_some()
                && peer.workspace_rpc_versions.contains(&RPC_VERSION)
        })
}
fn report(code: RpcErrorCode) {
    eprintln!("workspace RPC delivery: {}", code.code());
}

struct HubWorkspaceTransport {
    hub: Weak<Hub>,
}
pub(super) fn transport(hub: &Arc<Hub>) -> Arc<dyn WorkspaceRpcTransport> {
    Arc::new(HubWorkspaceTransport {
        hub: Arc::downgrade(hub),
    })
}
impl WorkspaceRpcTransport for HubWorkspaceTransport {
    fn connection_generation(&self, node_id: String) -> WorkspaceRpcFuture<Option<u64>> {
        let hub = self.hub.clone();
        Box::pin(async move {
            let hub = hub.upgrade().ok_or(RpcErrorCode::NodeOffline)?;
            let inner = hub.inner.lock().await;
            Ok(inner
                .nodes
                .get(&node_id)
                .filter(|peer| current(&inner, &node_id, peer.generation))
                .map(|peer| peer.generation))
        })
    }
    fn submit(&self, dispatch: WorkspaceDispatch, generation: u64) -> WorkspaceRpcFuture<()> {
        let hub = self.hub.clone();
        Box::pin(async move {
            let hub = hub.upgrade().ok_or(RpcErrorCode::NodeOffline)?;
            dispatch.validate()?;
            // This helper reads the durable WorkspaceRecord and performs a real
            // PrepareWorktree. No request cwd/path can enroll a workspace.
            hub.ensure_workspace_authority(&dispatch.request.workspace_id, &dispatch.owner_node_id)
                .await
                .map_err(|_| RpcErrorCode::PolicyMismatch)?;
            {
                let inner = hub.inner.lock().await;
                if !current(&inner, &dispatch.owner_node_id, generation) {
                    return Err(RpcErrorCode::NodeOffline);
                }
                // Revalidate actual Run/Mission authority within the same
                // SQLite write transaction that commits the delivery receipt.
                hub.store
                    .rpc_prepare_dispatch(&dispatch, generation, now_ms())?;
            }
            let node = dispatch.owner_node_id.clone();
            let id = dispatch.request.request_id.clone();
            if hub
                .send_node_message_generation(
                    &node,
                    generation,
                    ServerMessage::WorkspaceRpcDispatch { dispatch },
                    false,
                )
                .await
                .is_err()
            {
                hub.store
                    .rpc_delivery_unknown(&node, generation, &id, now_ms())?;
                return Err(RpcErrorCode::NodeOffline);
            }
            Ok(())
        })
    }
    fn cancel(
        &self,
        node_id: String,
        generation: u64,
        cancel: WorkspaceCancel,
    ) -> WorkspaceRpcFuture<()> {
        let hub = self.hub.clone();
        Box::pin(async move {
            let hub = hub.upgrade().ok_or(RpcErrorCode::NodeOffline)?;
            {
                let inner = hub.inner.lock().await;
                if !current(&inner, &node_id, generation) {
                    return Err(RpcErrorCode::NodeOffline);
                }
                hub.store
                    .rpc_validate_cancel(&node_id, generation, &cancel)?;
            }
            let id = cancel.request_id.clone();
            if hub
                .send_node_message_generation(
                    &node_id,
                    generation,
                    ServerMessage::WorkspaceRpcCancel { cancel },
                    true,
                )
                .await
                .is_err()
            {
                hub.store
                    .rpc_delivery_unknown(&node_id, generation, &id, now_ms())?;
                return Err(RpcErrorCode::NodeOffline);
            }
            Ok(())
        })
    }
    fn replay(
        &self,
        node_id: String,
        generation: u64,
        replay: WorkspaceReplay,
    ) -> WorkspaceRpcFuture<()> {
        let hub = self.hub.clone();
        Box::pin(async move {
            let hub = hub.upgrade().ok_or(RpcErrorCode::NodeOffline)?;
            {
                let inner = hub.inner.lock().await;
                if !current(&inner, &node_id, generation) {
                    return Err(RpcErrorCode::NodeOffline);
                }
                hub.store
                    .rpc_validate_replay(&node_id, generation, &replay)?;
            }
            hub.send_node_message_generation(
                &node_id,
                generation,
                ServerMessage::WorkspaceRpcReplay { replay },
                false,
            )
            .await
            .map_err(|_| RpcErrorCode::NodeOffline)
        })
    }
}

pub(super) async fn node_connected(hub: Arc<Hub>, node_id: String, generation: u64) {
    let controls = {
        let inner = hub.inner.lock().await;
        if !current(&inner, &node_id, generation) {
            return;
        }
        match hub.store.rpc_resume_node(&node_id, generation, now_ms()) {
            Ok(controls) => controls,
            Err(code) => {
                report(code);
                return;
            }
        }
    };
    let transport = transport(&hub);
    for control in controls {
        if let Some(cancel) = control.cancel {
            if let Err(code) = transport.cancel(node_id.clone(), generation, cancel).await {
                report(code);
            }
        }
        if let Err(code) = transport
            .replay(node_id.clone(), generation, control.replay)
            .await
        {
            report(code);
        }
    }
    // A cancelled/ended parent must not keep work alive merely because the
    // node socket reconnected before its original absolute deadline.
    cancel_stale(&hub, &node_id, generation).await;
}
pub(super) async fn node_disconnected(hub: &Hub, node_id: &str, generation: u64) {
    if let Err(code) = hub.store.rpc_disconnected(node_id, generation, now_ms()) {
        report(code);
    }
}
pub(super) async fn handle_event(
    hub: Arc<Hub>,
    node_id: &str,
    generation: u64,
    event: WorkspaceEvent,
) {
    let inner = hub.inner.lock().await;
    if !current(&inner, node_id, generation) {
        return;
    }
    if let Err(code) = hub
        .store
        .rpc_append_event(node_id, generation, &event, now_ms())
    {
        report(code);
    }
}
pub(super) async fn handle_rejection(
    hub: Arc<Hub>,
    node_id: &str,
    generation: u64,
    rejection: WorkspaceRejection,
) {
    let inner = hub.inner.lock().await;
    if !current(&inner, node_id, generation) {
        return;
    }
    if let Err(code) = hub
        .store
        .rpc_rejected(node_id, generation, &rejection, now_ms())
    {
        report(code);
    }
}
async fn cancel_stale(hub: &Arc<Hub>, node_id: &str, generation: u64) {
    let controls = {
        let inner = hub.inner.lock().await;
        if !current(&inner, node_id, generation) {
            return;
        }
        match hub.store.rpc_cancel_stale(node_id, now_ms()) {
            Ok(controls) => controls,
            Err(code) => {
                report(code);
                return;
            }
        }
    };
    let transport = transport(hub);
    for cancel in controls {
        if let Err(code) = transport
            .cancel(node_id.to_owned(), generation, cancel)
            .await
        {
            report(code);
        }
    }
}
/// Called by the existing bounded Hub maintenance tick. Core revocation/end
/// becomes an actual cancel request; it is never reported as confirmed exit.
pub(super) async fn expire(hub: Arc<Hub>) {
    let nodes = {
        let inner = hub.inner.lock().await;
        inner
            .nodes
            .iter()
            .filter(|(id, peer)| current(&inner, id, peer.generation))
            .map(|(id, peer)| (id.clone(), peer.generation))
            .collect::<Vec<_>>()
    };
    for (id, generation) in nodes {
        cancel_stale(&hub, &id, generation).await;
    }
}
