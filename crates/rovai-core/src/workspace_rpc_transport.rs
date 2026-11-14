//! Transport for Core-authorized workspace calls. This is independent of the
//! native process launcher: the parent agent remains in its existing session.
//! Dispatches carry trusted Core identity; implementors must fence connection
//! generations and persist admission before delivering any side effect.
use loom_protocol::workspace_rpc::{
    RpcErrorCode, WorkspaceCancel, WorkspaceDispatch, WorkspaceReplay,
};
use std::{future::Future, pin::Pin};

pub type WorkspaceRpcFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, RpcErrorCode>> + Send + 'static>>;

pub trait WorkspaceRpcTransport: Send + Sync {
    fn connection_generation(&self, node_id: String) -> WorkspaceRpcFuture<Option<u64>>;
    fn submit(
        &self,
        dispatch: WorkspaceDispatch,
        connection_generation: u64,
    ) -> WorkspaceRpcFuture<()>;
    fn cancel(
        &self,
        owner_node_id: String,
        connection_generation: u64,
        cancel: WorkspaceCancel,
    ) -> WorkspaceRpcFuture<()>;
    fn replay(
        &self,
        owner_node_id: String,
        connection_generation: u64,
        replay: WorkspaceReplay,
    ) -> WorkspaceRpcFuture<()>;
}
