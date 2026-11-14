//! In-process capabilities installed by the trusted embedding Host.
//! These are deliberately absent from the public JSON request router.

use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, RwLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{
    builtin_tool_transport::{BuiltinToolIpcRequestBody, BuiltinToolIpcResponse},
    remote_process::{AgentRunOwner, RemoteProcessError, RemoteProcessKey, RemoteProcessLauncher},
    workspace_rpc_transport::WorkspaceRpcTransport,
};

pub struct RemoteBuiltinInvocation {
    pub process: RemoteProcessKey,
    pub owner: AgentRunOwner,
    /// Node's monotonic owner-binding receipt, not the AgentRun epoch.
    pub binding_seq: u64,
    pub body: BuiltinToolIpcRequestBody,
}

pub type RemoteBuiltinFuture<'a> =
    Pin<Box<dyn Future<Output = Result<BuiltinToolIpcResponse, RemoteProcessError>> + Send + 'a>>;

/// Core installs this handler itself after startup. The authenticated Hub can
/// invoke it only through the trusted CoreService capability, never via JSON RPC.
pub trait RemoteBuiltinHandler: Send + Sync {
    fn invoke(&self, request: RemoteBuiltinInvocation) -> RemoteBuiltinFuture<'_>;
}

pub struct RemoteRuntimeServices {
    closed: AtomicBool,
    launcher: RwLock<Option<Arc<dyn RemoteProcessLauncher>>>,
    workspace: RwLock<Option<Arc<dyn WorkspaceRpcTransport>>>,
    builtin: RwLock<Option<Weak<dyn RemoteBuiltinHandler>>>,
    builtin_capacity: tokio::sync::Semaphore,
}

impl Default for RemoteRuntimeServices {
    fn default() -> Self {
        Self {
            closed: AtomicBool::new(false),
            launcher: RwLock::new(None),
            workspace: RwLock::new(None),
            builtin: RwLock::new(None),
            builtin_capacity: tokio::sync::Semaphore::new(16),
        }
    }
}

impl RemoteRuntimeServices {
    pub fn installed_launcher(
        &self,
    ) -> Result<Option<Arc<dyn RemoteProcessLauncher>>, RemoteProcessError> {
        self.launcher
            .read()
            .map_err(|_| RemoteProcessError::Unavailable)
            .map(|value| value.clone())
    }

    /// Reinstalling the same provider is harmless. A replacement would detach
    /// live warm Hosts from their controller and must use an explicit drain.
    pub fn install_launcher(
        &self,
        launcher: Arc<dyn RemoteProcessLauncher>,
    ) -> Result<(), RemoteProcessError> {
        let mut current = self
            .launcher
            .write()
            .map_err(|_| RemoteProcessError::Unavailable)?;
        if self.closed.load(Ordering::Acquire) {
            return Err(RemoteProcessError::Unavailable);
        }
        if let Some(existing) = current.as_ref() {
            return if Arc::ptr_eq(existing, &launcher) {
                Ok(())
            } else {
                Err(RemoteProcessError::IdentityMismatch)
            };
        }
        *current = Some(launcher);
        Ok(())
    }

    /// Workspace requests share the embedding Host lifetime, but have their own
    /// journal and transport authority. Reinstalling the same Arc is idempotent.
    pub fn install_workspace_transport(
        &self, transport: Arc<dyn WorkspaceRpcTransport>,
    ) -> Result<(), RemoteProcessError> {
        let mut current = self.workspace.write().map_err(|_| RemoteProcessError::Unavailable)?;
        if self.closed.load(Ordering::Acquire) {
            return Err(RemoteProcessError::Unavailable);
        }
        if let Some(existing) = current.as_ref() {
            return if Arc::ptr_eq(existing, &transport) { Ok(()) }
                else { Err(RemoteProcessError::IdentityMismatch) };
        }
        *current = Some(transport);
        Ok(())
    }

    pub fn workspace_transport(&self) -> Result<Arc<dyn WorkspaceRpcTransport>, RemoteProcessError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RemoteProcessError::Unavailable);
        }
        self.workspace.read().map_err(|_| RemoteProcessError::Unavailable)?
            .clone().ok_or(RemoteProcessError::Unavailable)
    }

    /// Called only when the unique Core runner has completed or is abandoned.
    /// Web listener stop/start never calls this. Dropping a provider is not a
    /// positive remote-process termination receipt; its durable unknown records remain.
    pub(crate) fn close(&self) {
        if let Ok(mut current) = self.launcher.write() {
            self.closed.store(true, Ordering::Release);
            current.take();
        } else {
            self.closed.store(true, Ordering::Release);
        }
        if let Ok(mut current) = self.builtin.write() {
            current.take();
        }
        if let Ok(mut current) = self.workspace.write() {
            current.take();
        }
        self.builtin_capacity.close();
    }

    pub fn launcher(&self) -> Result<Arc<dyn RemoteProcessLauncher>, RemoteProcessError> {
        self.launcher
            .read()
            .map_err(|_| RemoteProcessError::Unavailable)?
            .clone()
            .ok_or(RemoteProcessError::Unavailable)
    }

    pub(crate) fn install_builtin_handler(&self, handler: &Arc<dyn RemoteBuiltinHandler>) {
        // A weak reference avoids Core -> services -> Core ownership cycles.
        if let Ok(mut current) = self.builtin.write() {
            *current = Some(Arc::downgrade(handler));
        }
    }

    pub async fn invoke_builtin(
        &self,
        request: RemoteBuiltinInvocation,
    ) -> Result<BuiltinToolIpcResponse, RemoteProcessError> {
        let _permit = self
            .builtin_capacity
            .try_acquire()
            .map_err(|_| RemoteProcessError::Unavailable)?;
        request.process.validate()?;
        request.owner.validate()?;
        if request.binding_seq > (1u64 << 53) - 1 {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        if serde_json::to_vec(&request.body)
            .map_err(|_| RemoteProcessError::LaunchRejected)?
            .len()
            > 1024 * 1024
        {
            return Err(RemoteProcessError::LaunchRejected);
        }
        let handler = self
            .builtin
            .read()
            .map_err(|_| RemoteProcessError::Unavailable)?
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or(RemoteProcessError::Unavailable)?;
        handler.invoke(request).await
    }
}
