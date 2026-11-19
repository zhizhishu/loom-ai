//! Native driver process ownership without assuming the process is on Core's host.
//!
//! This wrapper changes only IO and lifecycle transport. Local platform ownership
//! remains in ManagedProcess; remote processes carry an opaque authenticated key.

#[cfg(target_os = "macos")]
use std::path::Path;
use std::{fmt, io, process::ExitStatus, sync::Arc, time::Duration};

use crate::{
    managed_process::{ManagedProcess, ManagedProcessLaunchSpec, ManagedProcessSpawnFailure},
    remote_process::{
        AgentRunOwner, NonSecretEnvironment, RemoteArgument, RemoteExitReceipt, RemoteProcess,
        RemoteProcessError, RemoteProcessKey, RemoteProcessLauncher, RemoteProcessState,
        RemoteRead, RemoteTerminationMode, RemoteWrite, ScopedRemoteLaunch, launch_remote,
    },
};
use anyhow::Result;

pub(crate) type RuntimeStdin = RemoteWrite;
pub(crate) type RuntimeStdout = RemoteRead;
pub(crate) type RuntimeStderr = RemoteRead;

/// A typed launch authority prepared by Core before entering a native driver.
/// It never captures or infers a destination from the process environment.
#[derive(Clone)]
pub(crate) struct RemoteRuntimeLaunch {
    pub launcher: Arc<dyn RemoteProcessLauncher>,
    pub frozen: ScopedRemoteLaunch,
    pub startup_budget: Duration,
    pub builtin: crate::builtin_tool_runtime::BuiltinToolProcessConfig,
}

impl RemoteRuntimeLaunch {
    pub async fn spawn(
        &self,
        arguments: Vec<RemoteArgument>,
        environment: NonSecretEnvironment,
    ) -> Result<RuntimeProcess> {
        anyhow::ensure!(
            self.builtin.remote_process_key() == Some(&self.frozen.key),
            "remote_builtin_launch_identity"
        );
        let mut request = self.frozen.clone();
        request.arguments = arguments;
        request.environment = environment;
        request.builtin_tasks_enabled = self.builtin.tasks_enabled();
        let process = launch_remote(self.launcher.as_ref(), request, self.startup_budget).await?;
        let binding = process.owner_binding_handle();
        let process = RuntimeProcess::Remote(process);
        let synchronized: Result<()> = async {
            self.builtin.install_remote_owner_binding(binding)?;
            anyhow::ensure!(
                self.builtin
                    .synchronize_remote_tasks(self.frozen.initial_owner.clone(),)
                    .await?,
                "remote_builtin_owner_unavailable"
            );
            Ok(())
        }
        .await;
        if let Err(error) = synchronized {
            // Handle-installation/capability failure is still a post-Open error.
            // Obtain bounded cleanup rather than treating Drop as confirmation.
            if let Err(cleanup) = process.confirm_remote_cleanup(Duration::from_secs(5)).await {
                return Err(
                    error.context(format!("remote launch cleanup unconfirmed: {cleanup:#}"))
                );
            }
            return Err(error);
        }
        Ok(process)
    }
}

/// Keep remote status in its own representation instead of manufacturing a
/// platform-local PID, Job handle or OS wait status.
#[derive(Debug, Clone)]
pub(crate) enum RuntimeExitStatus {
    Local(ExitStatus),
    Remote(RemoteExitReceipt),
}

impl RuntimeExitStatus {
    pub fn code(&self) -> Option<i32> {
        match self {
            Self::Local(status) => status.code(),
            Self::Remote(receipt) => receipt.exit_code,
        }
    }

    pub fn success(&self) -> bool {
        match self {
            Self::Local(status) => status.success(),
            Self::Remote(receipt) => receipt.exit_code == Some(0) && receipt.signal.is_none(),
        }
    }

    pub fn signal(&self) -> Option<i32> {
        match self {
            #[cfg(unix)]
            Self::Local(status) => {
                use std::os::unix::process::ExitStatusExt;
                status.signal()
            }
            #[cfg(not(unix))]
            Self::Local(_) => None,
            Self::Remote(receipt) => receipt.signal,
        }
    }
}

impl fmt::Display for RuntimeExitStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local(status) => status.fmt(f),
            Self::Remote(receipt) => match (receipt.exit_code, receipt.signal) {
                (Some(code), None) => write!(f, "remote exit code: {code}"),
                (_, Some(signal)) => write!(f, "remote signal: {signal}"),
                (None, None) => f.write_str("remote exit status unavailable"),
            },
        }
    }
}

pub(crate) enum RuntimeProcess {
    Local(ManagedProcess),
    Remote(RemoteProcess),
}

impl From<ManagedProcess> for RuntimeProcess {
    fn from(value: ManagedProcess) -> Self {
        Self::Local(value)
    }
}

fn remote_io(error: RemoteProcessError) -> io::Error {
    let kind = match error {
        RemoteProcessError::Unavailable | RemoteProcessError::UnknownOutcome => {
            io::ErrorKind::ConnectionAborted
        }
        RemoteProcessError::DeadlineExceeded => io::ErrorKind::TimedOut,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, error)
}

impl RuntimeProcess {
    pub fn spawn(spec: ManagedProcessLaunchSpec) -> Result<Self> {
        ManagedProcess::spawn(spec).map(Self::Local)
    }

    pub(crate) fn spawn_owned(
        spec: ManagedProcessLaunchSpec,
    ) -> std::result::Result<Self, ManagedProcessSpawnFailure> {
        ManagedProcess::spawn_owned(spec).map(Self::Local)
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, Self::Remote(_))
    }

    pub fn remote_key(&self) -> Option<&RemoteProcessKey> {
        match self {
            Self::Remote(process) => Some(process.key()),
            Self::Local(_) => None,
        }
    }

    /// This API is explicitly local. A remote PID must never enter Core's local
    /// process ownership/recovery ledger.
    pub fn id(&self) -> Option<u32> {
        match self {
            Self::Local(process) => process.id(),
            Self::Remote(_) => None,
        }
    }

    pub fn owns_process_id(&self, pid: u32) -> bool {
        match self {
            Self::Local(process) => process.owns_process_id(pid),
            Self::Remote(_) => false,
        }
    }

    #[cfg(windows)]
    pub fn windows_job_name(&self) -> Option<&str> {
        match self {
            Self::Local(process) => Some(process.windows_job_name()),
            Self::Remote(_) => None,
        }
    }

    pub fn take_stdin(&mut self) -> Option<RuntimeStdin> {
        match self {
            Self::Local(process) => process
                .take_stdin()
                .map(|stream| Box::new(stream) as RuntimeStdin),
            Self::Remote(process) => process.take_stdin(),
        }
    }

    pub fn take_stdout(&mut self) -> Option<RuntimeStdout> {
        match self {
            Self::Local(process) => process
                .take_stdout()
                .map(|stream| Box::new(stream) as RuntimeStdout),
            Self::Remote(process) => process.take_stdout(),
        }
    }

    pub fn take_stderr(&mut self) -> Option<RuntimeStderr> {
        match self {
            Self::Local(process) => process
                .take_stderr()
                .map(|stream| Box::new(stream) as RuntimeStderr),
            Self::Remote(process) => process.take_stderr(),
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<RuntimeExitStatus>> {
        match self {
            Self::Local(process) => process
                .try_wait()
                .map(|status| status.map(RuntimeExitStatus::Local)),
            Self::Remote(process) => match process.state() {
                RemoteProcessState::Exited(receipt) => Ok(Some(RuntimeExitStatus::Remote(receipt))),
                RemoteProcessState::Starting | RemoteProcessState::Running => Ok(None),
                RemoteProcessState::Unreachable => Err(remote_io(RemoteProcessError::Unavailable)),
                RemoteProcessState::Unknown => Err(remote_io(RemoteProcessError::UnknownOutcome)),
            },
        }
    }

    pub async fn wait(&mut self) -> io::Result<RuntimeExitStatus> {
        match self {
            Self::Local(process) => process.wait().await.map(RuntimeExitStatus::Local),
            Self::Remote(process) => process
                .wait_exit()
                .await
                .map(RuntimeExitStatus::Remote)
                .map_err(remote_io),
        }
    }

    pub fn request_graceful_termination(&mut self) -> io::Result<()> {
        match self {
            Self::Local(process) => process.request_graceful_termination(),
            Self::Remote(process) => process
                .request_stop(RemoteTerminationMode::Graceful)
                .map_err(remote_io),
        }
    }

    pub fn force_terminate_tree(&mut self) -> io::Result<()> {
        match self {
            Self::Local(process) => process.force_terminate_tree(),
            Self::Remote(process) => process
                .request_stop(RemoteTerminationMode::Force)
                .map_err(remote_io),
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub fn tree_is_empty(&self) -> io::Result<bool> {
        match self {
            Self::Local(process) => process.tree_is_empty(),
            Self::Remote(process) => process.tree_stopped().map_err(remote_io),
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn capture_descendants(&mut self) -> io::Result<()> {
        match self {
            Self::Local(process) => process.capture_descendants(),
            Self::Remote(_) => Ok(()), // Node owns capture; cleanup still requires its receipt.
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn captured_tree_is_empty(&self) -> io::Result<bool> {
        match self {
            Self::Local(process) => process.captured_tree_is_empty(),
            Self::Remote(process) => process.tree_stopped().map_err(remote_io),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn track_descendants(&mut self, directory: &Path) -> io::Result<()> {
        match self {
            Self::Local(process) => process.track_descendants(directory),
            Self::Remote(_) => Ok(()),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn recover_descendants(directory: &Path) -> io::Result<()> {
        ManagedProcess::recover_descendants(directory)
    }

    /// Callers first reach native idle and revoke the previous native tool lease.
    /// This method adds the transport boundary check; it cannot replace those.
    pub fn bind_remote_owner(
        &self,
        owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool,
    ) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        let pending = match self {
            Self::Remote(process) => Some(process.bind_owner(owner, builtin_tasks_enabled)),
            Self::Local(_) => None,
        };
        async move {
            if let Some(pending) = pending {
                pending.await?;
            }
            Ok(())
        }
    }

    /// No borrow of single-owner IO is retained across await.
    pub fn confirm_remote_cleanup(
        &self,
        budget: Duration,
    ) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        let pending = match self {
            Self::Remote(process) => {
                Some(process.terminate_and_confirm(RemoteTerminationMode::Force, budget))
            }
            Self::Local(_) => None,
        };
        async move {
            if let Some(pending) = pending {
                pending.await?;
            }
            Ok(())
        }
    }

    pub fn bundle_materialization(
        &self,
    ) -> Option<&crate::remote_process::RemoteBundleMaterialization> {
        match self {
            Self::Remote(process) => process.bundle_materialization(),
            Self::Local(_) => None,
        }
    }
}
