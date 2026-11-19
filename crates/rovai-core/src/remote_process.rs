//! A-side boundary for an explicitly selected remote Runtime process.
//!
//! Native Claude/Codex/ACP protocols remain in their existing drivers. The
//! transport owns ordered pipe delivery; a pipe receipt is never a native-input
//! acceptance receipt. Process lifetime and AgentRun lifetime are separate.

use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use loom_protocol::run_bundle::{self, BundleExpectation, RunBundleV1, safe_bundle_relative};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

const MAX_COUNTER: u64 = (1u64 << 53) - 1;

pub type RemoteRead = Box<dyn AsyncRead + Send + Unpin>;
pub type RemoteWrite = Box<dyn AsyncWrite + Send + Unpin>;
pub type RemoteFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, RemoteProcessError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteProcessKey {
    pub node_id: String,
    pub process_id: String,
    pub process_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunOwner {
    pub agent_run_id: String,
    pub execution_epoch: u64,
}

/// Stable across sequential Runs on one warm native Host.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteHostScope {
    pub member_id: String,
    pub logical_session_id: String,
    pub workspace_id: String,
}

/// Frozen Core authority, not a target inferred from an environment variable.
/// Paths below belong to the authenticated node's catalog/workspace.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenRemoteTarget {
    pub node_id: String,
    /// Durable installation generation, never a WebSocket attach generation.
    pub node_generation: u64,
    pub workspace_id: String,
    pub workspace_root: String,
    pub adapter_kind: String,
    pub program: String,
    pub program_identity: String,
    pub configuration_digest: String,
}

/// Only selected materialized files may become native launch-file arguments.
/// A source-machine absolute path is never used as a materialization reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RemoteArgument {
    Literal { value: String },
    MaterializedFile { path: String },
}

/// Explicit non-secret policy flags. Node-owned auth/environment is not copied
/// from A. The closed constructor prevents accidental inherited-env forwarding.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NonSecretEnvironment(BTreeMap<String, String>);

impl fmt::Debug for NonSecretEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NonSecretEnvironment")
            .field("names", &self.0.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl NonSecretEnvironment {
    pub fn from_flags(values: BTreeMap<String, String>) -> Result<Self, RemoteProcessError> {
        let result = Self(values);
        result.validate()?;
        Ok(result)
    }

    pub fn entries(&self) -> &BTreeMap<String, String> {
        &self.0
    }

    pub fn validate(&self) -> Result<(), RemoteProcessError> {
        for (name, value) in &self.0 {
            let allowed = match name.as_str() {
                "CLAUDE_CODE_DISABLE_AUTO_MEMORY"
                | "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"
                | "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"
                | "NO_COLOR" => matches!(value.as_str(), "0" | "1"),
                "PYTHONIOENCODING" => matches!(value.as_str(), "utf-8" | "utf-8:strict"),
                _ => false,
            };
            if !allowed {
                return Err(RemoteProcessError::EnvironmentRejected);
            }
        }
        Ok(())
    }
}

/// Ephemeral transport input. It deliberately does not derive Debug because
/// argv and bundle bodies can contain user text. Persistence uses digests and
/// the existing immutable bundle owner, not a debug dump of this request.
#[derive(Clone)]
pub struct ScopedRemoteLaunch {
    pub key: RemoteProcessKey,
    pub initial_owner: AgentRunOwner,
    pub builtin_tasks_enabled: bool,
    pub host_scope: RemoteHostScope,
    pub target: FrozenRemoteTarget,
    pub arguments: Vec<RemoteArgument>,
    pub environment: NonSecretEnvironment,
    pub bundle: Option<RunBundleV1>,
    pub codex_hook_grant: Option<loom_protocol::command_hooks::CodexHookGrantV1>,
}

impl ScopedRemoteLaunch {
    pub fn validate(&self) -> Result<(), RemoteProcessError> {
        self.key.validate()?;
        self.initial_owner.validate()?;
        self.host_scope.validate()?;
        self.target.validate()?;
        if self.key.node_id != self.target.node_id
            || self.host_scope.workspace_id != self.target.workspace_id
        {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        self.environment.validate()?;
        if self.arguments.len() > 512 {
            return Err(RemoteProcessError::LaunchRejected);
        }
        let mut bytes = 0usize;
        for argument in &self.arguments {
            let text = match argument {
                RemoteArgument::Literal { value } => {
                    if value.contains('\0') {
                        return Err(RemoteProcessError::LaunchRejected);
                    }
                    value
                }
                RemoteArgument::MaterializedFile { path } => {
                    if safe_bundle_relative(path).is_err() || self.bundle.is_none() {
                        return Err(RemoteProcessError::MaterializationRejected);
                    }
                    path
                }
            };
            bytes = bytes
                .checked_add(text.len())
                .ok_or(RemoteProcessError::LaunchRejected)?;
        }
        if bytes > 256 * 1024 {
            return Err(RemoteProcessError::LaunchRejected);
        }
        if let Some(grant) = &self.codex_hook_grant {
            let bundle = self.bundle.as_ref().ok_or(RemoteProcessError::MaterializationRejected)?;
            grant.validate(bundle).map_err(|_| RemoteProcessError::MaterializationRejected)?;
        }
        if let Some(bundle) = &self.bundle {
            if bundle.run_id != self.initial_owner.agent_run_id
                || bundle.agent_id != self.host_scope.member_id
            {
                return Err(RemoteProcessError::IdentityMismatch);
            }
            // Bundle attempt, Run execution epoch and process epoch belong to
            // different lifetimes. Core freezes each; they are not aliases.
            run_bundle::validate(
                bundle,
                &BundleExpectation {
                    run_id: &self.initial_owner.agent_run_id,
                    attempt: bundle.attempt,
                    adapter_kind: &self.target.adapter_kind,
                },
            )
            .map_err(|_| RemoteProcessError::MaterializationRejected)?;
            for argument in &self.arguments {
                if let RemoteArgument::MaterializedFile { path } = argument
                    && !bundle.files.iter().any(|file| &file.path == path)
                {
                    return Err(RemoteProcessError::MaterializationRejected);
                }
            }
        }
        Ok(())
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
}

impl RemoteProcessKey {
    pub fn validate(&self) -> Result<(), RemoteProcessError> {
        if valid_id(&self.node_id)
            && valid_id(&self.process_id)
            && (1..=MAX_COUNTER).contains(&self.process_epoch)
        {
            Ok(())
        } else {
            Err(RemoteProcessError::IdentityMismatch)
        }
    }
}

impl AgentRunOwner {
    pub fn validate(&self) -> Result<(), RemoteProcessError> {
        if valid_id(&self.agent_run_id) && (1..=MAX_COUNTER).contains(&self.execution_epoch) {
            Ok(())
        } else {
            Err(RemoteProcessError::IdentityMismatch)
        }
    }
}

impl RemoteHostScope {
    pub fn validate(&self) -> Result<(), RemoteProcessError> {
        if valid_id(&self.member_id)
            && valid_id(&self.logical_session_id)
            && valid_id(&self.workspace_id)
        {
            Ok(())
        } else {
            Err(RemoteProcessError::IdentityMismatch)
        }
    }
}

impl FrozenRemoteTarget {
    pub fn validate(&self) -> Result<(), RemoteProcessError> {
        if !valid_id(&self.node_id)
            || !valid_id(&self.workspace_id)
            || !(1..=MAX_COUNTER).contains(&self.node_generation)
            || !valid_id(&self.adapter_kind)
            || self.program.trim().is_empty()
            || self.program.len() > 32768
            || self.workspace_root.trim().is_empty()
            || self.workspace_root.len() > 32768
            || self.program.contains('\0')
            || self.workspace_root.contains('\0')
            || self.program_identity.trim().is_empty()
            || self.program_identity.len() > 256
            || self.configuration_digest.trim().is_empty()
            || self.configuration_digest.len() > 256
        {
            return Err(RemoteProcessError::LaunchRejected);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteExitReceipt {
    pub key: RemoteProcessKey,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTerminationReceipt {
    pub key: RemoteProcessKey,
    pub leader_exited: bool,
    pub tree_stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteOwnerReceipt {
    pub key: RemoteProcessKey,
    /// Open owns sequence zero; each actual owner replacement increments once.
    pub binding_seq: u64,
    pub owner: Option<AgentRunOwner>,
    pub builtin_tasks_enabled: bool,
    /// Previous pipe writes have unambiguous receipts before owner replacement.
    /// This says nothing about whether native/model input was accepted.
    pub input_boundary_written: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteProcessState {
    Starting,
    Running,
    Exited(RemoteExitReceipt),
    Unreachable,
    /// Ambiguous launch or pipe write. Never automatically restart/replay.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteTerminationMode {
    Graceful,
    Force,
}

/// Errors expose stable codes only, never argv, environment or bundle bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteProcessError {
    IdentityMismatch,
    LaunchRejected,
    MaterializationRejected,
    EnvironmentRejected,
    Unavailable,
    UnknownOutcome,
    InputBoundaryUnconfirmed,
    CleanupUnconfirmed,
    DeadlineExceeded,
}

impl RemoteProcessError {
    pub fn code(self) -> &'static str {
        match self {
            Self::IdentityMismatch => "remote_process_identity_mismatch",
            Self::LaunchRejected => "remote_process_launch_rejected",
            Self::MaterializationRejected => "remote_process_materialization_rejected",
            Self::EnvironmentRejected => "remote_process_environment_rejected",
            Self::Unavailable => "remote_process_unavailable",
            Self::UnknownOutcome => "remote_process_outcome_unknown",
            Self::InputBoundaryUnconfirmed => "remote_process_input_boundary_unconfirmed",
            Self::CleanupUnconfirmed => "remote_process_cleanup_unconfirmed",
            Self::DeadlineExceeded => "remote_process_deadline_exceeded",
        }
    }
}

impl fmt::Display for RemoteProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for RemoteProcessError {}

/// Hub implements the transport, keeps its own replay cursors and validates
/// authenticated node replies. No native CLI protocol is implemented here.
pub trait RemoteProcessLauncher: Send + Sync + std::any::Any {
    fn start(&self, launch: ScopedRemoteLaunch) -> RemoteFuture<'_, RemoteProcess>;
}

pub trait RemoteProcessControl: Send + Sync {
    fn key(&self) -> &RemoteProcessKey;
    fn host_scope(&self) -> &RemoteHostScope;
    fn cached_state(&self) -> RemoteProcessState;
    /// Only a matching explicit tree-stop acknowledgement may populate this.
    fn cached_termination(&self) -> Option<RemoteTerminationReceipt> {
        None
    }
    fn wait_exit(&self) -> RemoteFuture<'_, RemoteExitReceipt>;
    fn bind_owner(
        &self,
        owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool,
    ) -> RemoteFuture<'_, RemoteOwnerReceipt>;
    /// Queue a stop without claiming that a process or descendant has exited.
    fn request_stop(&self, mode: RemoteTerminationMode) -> Result<(), RemoteProcessError>;
    fn terminate(
        &self,
        mode: RemoteTerminationMode,
        budget: Duration,
    ) -> RemoteFuture<'_, RemoteTerminationReceipt>;
}

/// Node reports only a validated bundle identity and its materialized skill
/// root. Core reconstructs its own frozen prompt; Node sends no prompt text.
#[derive(Clone, PartialEq, Eq)]
pub struct RemoteBundleMaterialization {
    pub bundle_id: String,
    pub bundle_digest: String,
    pub skill_root: String,
}
impl fmt::Debug for RemoteBundleMaterialization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteBundleMaterialization")
            .field("bundle_id", &self.bundle_id)
            .finish_non_exhaustive()
    }
}
impl RemoteBundleMaterialization {
    pub fn validate(&self, bundle: &RunBundleV1) -> Result<(), RemoteProcessError> {
        loom_protocol::process_pipe::BundleMaterializationV1 {
            bundle_id: self.bundle_id.clone(),
            bundle_digest: self.bundle_digest.clone(),
            skill_root: self.skill_root.clone(),
        }
        .validate()
        .map_err(|_| RemoteProcessError::MaterializationRejected)?;
        if self.bundle_id != bundle.bundle_id || self.bundle_digest != bundle.digest {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        Ok(())
    }
}

/// Shared owner control contains no stdin/stdout handles. Lease refresh can
/// synchronize capability state without borrowing native-driver process IO.
#[derive(Clone)]
pub(crate) struct RemoteOwnerBinding {
    key: RemoteProcessKey,
    control: Arc<dyn RemoteProcessControl>,
    receipt: Arc<Mutex<Option<RemoteOwnerReceipt>>>,
    gate: Arc<tokio::sync::Mutex<()>>,
}

impl RemoteOwnerBinding {
    pub(crate) fn key(&self) -> &RemoteProcessKey {
        &self.key
    }

    pub(crate) fn same_instance(&self, other: &Self) -> bool {
        self.key == other.key
            && Arc::ptr_eq(&self.gate, &other.gate)
            && Arc::ptr_eq(&self.receipt, &other.receipt)
    }

    fn bind_owner(
        &self,
        owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool,
    ) -> RemoteFuture<'static, ()> {
        let binding = self.clone();
        Box::pin(async move {
            let _gate = binding.gate.lock().await;
            binding.apply(owner, builtin_tasks_enabled).await
        })
    }

    /// Read the latest desired flag while holding the very same gate as native
    /// owner changes. An old delayed refresh cannot restore an obsolete flag or
    /// bind a previous Run over the current owner.
    pub(crate) fn sync_tasks(
        &self,
        expected_owner: AgentRunOwner,
        desired: Arc<AtomicBool>,
    ) -> RemoteFuture<'static, ()> {
        let binding = self.clone();
        Box::pin(async move {
            let _gate = binding.gate.lock().await;
            let current_owner = binding
                .receipt
                .lock()
                .map_err(|_| RemoteProcessError::Unavailable)?
                .as_ref()
                .and_then(|receipt| receipt.owner.clone());
            if current_owner.as_ref() != Some(&expected_owner) {
                return Err(RemoteProcessError::IdentityMismatch);
            }
            let enabled = desired.load(Ordering::Acquire);
            binding.apply(Some(expected_owner), enabled).await
        })
    }

    async fn apply(
        &self,
        owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool,
    ) -> Result<(), RemoteProcessError> {
        if let Some(owner) = &owner {
            owner.validate()?;
        }
        if owner.is_none() && builtin_tasks_enabled {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        let receipt = self
            .control
            .bind_owner(owner.clone(), builtin_tasks_enabled)
            .await?;
        if receipt.key != self.key
            || receipt.owner != owner
            || receipt.builtin_tasks_enabled != builtin_tasks_enabled
            || receipt.binding_seq > MAX_COUNTER
        {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        if !receipt.input_boundary_written {
            return Err(RemoteProcessError::InputBoundaryUnconfirmed);
        }
        let mut current = self
            .receipt
            .lock()
            .map_err(|_| RemoteProcessError::Unavailable)?;
        let valid = match current.as_ref() {
            None => receipt.binding_seq == 0,
            Some(previous)
                if previous.owner == receipt.owner
                    && previous.builtin_tasks_enabled == receipt.builtin_tasks_enabled =>
            {
                receipt.binding_seq == previous.binding_seq
            }
            Some(previous) => previous.binding_seq.checked_add(1) == Some(receipt.binding_seq),
        };
        if !valid {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        *current = Some(receipt);
        Ok(())
    }
}

pub struct RemoteProcess {
    key: RemoteProcessKey,
    host_scope: RemoteHostScope,
    stdin: Option<RemoteWrite>,
    stdout: Option<RemoteRead>,
    stderr: Option<RemoteRead>,
    control: Arc<dyn RemoteProcessControl>,
    stopped: Arc<AtomicBool>,
    owner_receipt: Arc<Mutex<Option<RemoteOwnerReceipt>>>,
    owner_binding_gate: Arc<tokio::sync::Mutex<()>>,
    materialization: Option<RemoteBundleMaterialization>,
}

impl RemoteProcess {
    pub fn new(
        key: RemoteProcessKey,
        host_scope: RemoteHostScope,
        stdin: RemoteWrite,
        stdout: RemoteRead,
        stderr: RemoteRead,
        control: Arc<dyn RemoteProcessControl>,
    ) -> Result<Self, RemoteProcessError> {
        key.validate()?;
        host_scope.validate()?;
        if control.key() != &key || control.host_scope() != &host_scope {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        Ok(Self {
            key,
            host_scope,
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr: Some(stderr),
            control,
            stopped: Arc::new(AtomicBool::new(false)),
            owner_receipt: Arc::new(Mutex::new(None)),
            owner_binding_gate: Arc::new(tokio::sync::Mutex::new(())),
            materialization: None,
        })
    }

    pub fn key(&self) -> &RemoteProcessKey {
        &self.key
    }

    pub fn set_bundle_materialization(
        &mut self,
        receipt: RemoteBundleMaterialization,
        expected: &RunBundleV1,
    ) -> Result<(), RemoteProcessError> {
        receipt.validate(expected)?;
        if self
            .materialization
            .as_ref()
            .is_some_and(|previous| previous != &receipt)
        {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        self.materialization = Some(receipt);
        Ok(())
    }

    pub fn bundle_materialization(&self) -> Option<&RemoteBundleMaterialization> {
        self.materialization.as_ref()
    }
    pub fn host_scope(&self) -> &RemoteHostScope {
        &self.host_scope
    }
    pub fn take_stdin(&mut self) -> Option<RemoteWrite> {
        self.stdin.take()
    }
    pub fn take_stdout(&mut self) -> Option<RemoteRead> {
        self.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<RemoteRead> {
        self.stderr.take()
    }

    pub fn state(&self) -> RemoteProcessState {
        match self.control.cached_state() {
            RemoteProcessState::Exited(receipt) if receipt.key != self.key => {
                RemoteProcessState::Unknown
            }
            other => other,
        }
    }

    pub fn tree_stopped(&self) -> Result<bool, RemoteProcessError> {
        if self.stopped.load(Ordering::Acquire) {
            return Ok(true);
        }
        let Some(receipt) = self.control.cached_termination() else {
            return Ok(false);
        };
        if receipt.key != self.key {
            return Err(RemoteProcessError::IdentityMismatch);
        }
        if receipt.leader_exited && receipt.tree_stopped {
            self.stopped.store(true, Ordering::Release);
            return Ok(true);
        }
        Ok(false)
    }

    // Control futures own control/state handles and never borrow single-owner
    // IO across an await. The native driver's spawned future remains Send.
    pub fn wait_exit(&self) -> RemoteFuture<'static, RemoteExitReceipt> {
        let control = self.control.clone();
        let key = self.key.clone();
        Box::pin(async move {
            let receipt = control.wait_exit().await?;
            if receipt.key != key {
                return Err(RemoteProcessError::IdentityMismatch);
            }
            Ok(receipt)
        })
    }

    pub fn owner_receipt(&self) -> Result<Option<RemoteOwnerReceipt>, RemoteProcessError> {
        self.owner_receipt
            .lock()
            .map(|receipt| receipt.clone())
            .map_err(|_| RemoteProcessError::Unavailable)
    }

    pub(crate) fn owner_binding_handle(&self) -> RemoteOwnerBinding {
        RemoteOwnerBinding {
            key: self.key.clone(),
            control: self.control.clone(),
            receipt: self.owner_receipt.clone(),
            gate: self.owner_binding_gate.clone(),
        }
    }

    pub fn bind_owner(
        &self,
        owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool,
    ) -> RemoteFuture<'static, ()> {
        self.owner_binding_handle()
            .bind_owner(owner, builtin_tasks_enabled)
    }

    pub fn request_stop(&self, mode: RemoteTerminationMode) -> Result<(), RemoteProcessError> {
        self.control.request_stop(mode)
    }

    pub fn terminate_and_confirm(
        &self,
        mode: RemoteTerminationMode,
        budget: Duration,
    ) -> RemoteFuture<'static, RemoteTerminationReceipt> {
        let control = self.control.clone();
        let key = self.key.clone();
        let stopped = self.stopped.clone();
        Box::pin(async move {
            let receipt = tokio::time::timeout(budget, control.terminate(mode, budget))
                .await
                .map_err(|_| RemoteProcessError::DeadlineExceeded)??;
            if receipt.key != key {
                return Err(RemoteProcessError::IdentityMismatch);
            }
            if !receipt.leader_exited || !receipt.tree_stopped {
                return Err(RemoteProcessError::CleanupUnconfirmed);
            }
            stopped.store(true, Ordering::Release);
            Ok(receipt)
        })
    }
}

impl Drop for RemoteProcess {
    fn drop(&mut self) {
        if !self.stopped.load(Ordering::Acquire) {
            // Best effort enqueue only. Durable owner/unknown records are retained
            // until a matching explicit termination receipt is reconciled.
            let _ = self.control.request_stop(RemoteTerminationMode::Force);
        }
    }
}

pub async fn launch_remote(
    launcher: &dyn RemoteProcessLauncher,
    request: ScopedRemoteLaunch,
    startup_budget: Duration,
) -> Result<RemoteProcess, RemoteProcessError> {
    request.validate()?;
    let key = request.key.clone();
    let scope = request.host_scope.clone();
    let owner = request.initial_owner.clone();
    let tasks_enabled = request.builtin_tasks_enabled;
    let expected_bundle = request
        .bundle
        .as_ref()
        .map(|bundle| (bundle.bundle_id.clone(), bundle.digest.clone()));
    let deadline = tokio::time::Instant::now() + startup_budget;
    let process = tokio::time::timeout_at(deadline, launcher.start(request))
        .await
        .map_err(|_| RemoteProcessError::DeadlineExceeded)??;
    if process.key() != &key || process.host_scope() != &scope {
        return Err(RemoteProcessError::IdentityMismatch);
    }
    match (expected_bundle, process.bundle_materialization()) {
        (None, None) => {}
        (Some((id, digest)), Some(receipt))
            if receipt.bundle_id == id && receipt.bundle_digest == digest => {}
        _ => return Err(RemoteProcessError::MaterializationRejected),
    }
    tokio::time::timeout_at(deadline, process.bind_owner(Some(owner), tasks_enabled))
        .await
        .map_err(|_| RemoteProcessError::DeadlineExceeded)??;
    Ok(process)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn key() -> RemoteProcessKey {
        RemoteProcessKey {
            node_id: "node-b".into(),
            process_id: "host-1".into(),
            process_epoch: 9,
        }
    }

    fn scope() -> RemoteHostScope {
        RemoteHostScope {
            member_id: "member-1".into(),
            logical_session_id: "session-1".into(),
            workspace_id: "work-1".into(),
        }
    }

    fn launch() -> ScopedRemoteLaunch {
        ScopedRemoteLaunch {
            codex_hook_grant: None,
            key: key(),
            initial_owner: AgentRunOwner {
                agent_run_id: "run-1".into(),
                execution_epoch: 3,
            },
            builtin_tasks_enabled: false,
            host_scope: scope(),
            target: FrozenRemoteTarget {
                node_id: "node-b".into(),
                node_generation: 7,
                workspace_id: "work-1".into(),
                workspace_root: "C:/fixture/work".into(),
                adapter_kind: "claude-code".into(),
                program: "C:/fixture/claude.exe".into(),
                program_identity: "catalog-identity-1".into(),
                configuration_digest: "sha256:frozen".into(),
            },
            arguments: vec![RemoteArgument::Literal {
                value: "--print".into(),
            }],
            environment: NonSecretEnvironment::default(),
            bundle: None,
        }
    }

    // This boundary accepts explicit policy switches only. Deserialization does
    // not grant a bypass for an inherited A-side environment or local file path.
    #[test]
    fn launch_rejects_deserialized_credentials_and_unmaterialized_paths() {
        let mut request = launch();
        request.environment = serde_json::from_value(serde_json::json!({
            "ANTHROPIC_API_KEY": "fixture-not-a-key"
        }))
        .unwrap();
        assert_eq!(
            request.validate(),
            Err(RemoteProcessError::EnvironmentRejected)
        );
        request.environment = NonSecretEnvironment::default();
        request.arguments.push(RemoteArgument::MaterializedFile {
            path: "C:/source/private/bootstrap.txt".into(),
        });
        assert_eq!(
            request.validate(),
            Err(RemoteProcessError::MaterializationRejected)
        );
        request.arguments.pop();
        request.target.node_id = "other-node".into();
        assert_eq!(
            request.validate(),
            Err(RemoteProcessError::IdentityMismatch)
        );
    }

    #[test]
    fn bundle_epoch_is_distinct_but_bundle_digest_and_identity_are_enforced() {
        use loom_protocol::run_bundle::{BundleArtifact, BundleFile, RUN_BUNDLE_VERSION};
        let mut request = launch();
        let mut bundle = RunBundleV1 {
            version: RUN_BUNDLE_VERSION,
            bundle_id: "run-1-2".into(),
            run_id: "run-1".into(),
            attempt: 2,
            agent_id: "member-1".into(),
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
        bundle.digest = run_bundle::bundle_digest(&bundle).unwrap();
        request.bundle = Some(bundle);
        request.arguments.push(RemoteArgument::MaterializedFile {
            path: "bootstrap.txt".into(),
        });
        assert_eq!(request.validate(), Ok(()));
        request.bundle.as_mut().unwrap().files[0].content = "eQ==".into();
        assert_eq!(
            request.validate(),
            Err(RemoteProcessError::MaterializationRejected)
        );
    }

    struct FakeControl {
        key: RemoteProcessKey,
        scope: RemoteHostScope,
        boundary_written: AtomicBool,
        binding_seq: AtomicU64,
        stall_binding: AtomicBool,
        tree_stopped: AtomicBool,
        wrong_epoch: AtomicBool,
        stop_requests: Mutex<Vec<RemoteTerminationMode>>,
    }

    impl FakeControl {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                key: key(),
                scope: scope(),
                boundary_written: AtomicBool::new(true),
                binding_seq: AtomicU64::new(0),
                stall_binding: AtomicBool::new(false),
                tree_stopped: AtomicBool::new(false),
                wrong_epoch: AtomicBool::new(false),
                stop_requests: Mutex::new(Vec::new()),
            })
        }
        fn receipt_key(&self) -> RemoteProcessKey {
            let mut key = self.key.clone();
            if self.wrong_epoch.load(Ordering::Acquire) {
                key.process_epoch += 1;
            }
            key
        }
    }

    impl RemoteProcessControl for FakeControl {
        fn key(&self) -> &RemoteProcessKey {
            &self.key
        }
        fn host_scope(&self) -> &RemoteHostScope {
            &self.scope
        }
        fn cached_state(&self) -> RemoteProcessState {
            RemoteProcessState::Exited(RemoteExitReceipt {
                key: self.receipt_key(),
                exit_code: Some(0),
                signal: None,
            })
        }
        fn cached_termination(&self) -> Option<RemoteTerminationReceipt> {
            self.tree_stopped
                .load(Ordering::Acquire)
                .then(|| RemoteTerminationReceipt {
                    key: self.receipt_key(),
                    leader_exited: true,
                    tree_stopped: true,
                })
        }
        fn wait_exit(&self) -> RemoteFuture<'_, RemoteExitReceipt> {
            Box::pin(async move {
                Ok(RemoteExitReceipt {
                    key: self.receipt_key(),
                    exit_code: Some(0),
                    signal: None,
                })
            })
        }
        fn bind_owner(
            &self,
            owner: Option<AgentRunOwner>,
            builtin_tasks_enabled: bool,
        ) -> RemoteFuture<'_, RemoteOwnerReceipt> {
            Box::pin(async move {
                if self.stall_binding.load(Ordering::Acquire) {
                    std::future::pending::<()>().await;
                }
                Ok(RemoteOwnerReceipt {
                    key: self.receipt_key(),
                    binding_seq: self.binding_seq.load(Ordering::Acquire),
                    owner,
                    builtin_tasks_enabled,
                    input_boundary_written: self.boundary_written.load(Ordering::Acquire),
                })
            })
        }
        fn request_stop(&self, mode: RemoteTerminationMode) -> Result<(), RemoteProcessError> {
            self.stop_requests.lock().unwrap().push(mode);
            Ok(())
        }
        fn terminate(
            &self,
            _mode: RemoteTerminationMode,
            _budget: Duration,
        ) -> RemoteFuture<'_, RemoteTerminationReceipt> {
            Box::pin(async move {
                Ok(RemoteTerminationReceipt {
                    key: self.receipt_key(),
                    leader_exited: true,
                    tree_stopped: self.tree_stopped.load(Ordering::Acquire),
                })
            })
        }
    }

    fn process(control: Arc<FakeControl>) -> RemoteProcess {
        RemoteProcess::new(
            key(),
            scope(),
            Box::new(tokio::io::sink()),
            Box::new(tokio::io::empty()),
            Box::new(tokio::io::empty()),
            control,
        )
        .unwrap()
    }

    // The process exists across Runs. Neither a stale process epoch, a queued
    // owner change nor a leader-only exit may release the authoritative owner.
    #[tokio::test]
    async fn rebind_and_cleanup_require_matching_positive_receipts() {
        let control = FakeControl::new();
        let process = process(control.clone());
        control.boundary_written.store(false, Ordering::Release);
        let next = Some(AgentRunOwner {
            agent_run_id: "run-2".into(),
            execution_epoch: 1,
        });
        assert_eq!(
            process.bind_owner(next.clone(), false).await,
            Err(RemoteProcessError::InputBoundaryUnconfirmed)
        );
        control.boundary_written.store(true, Ordering::Release);
        assert_eq!(process.bind_owner(next, false).await, Ok(()));
        assert_eq!(
            process
                .terminate_and_confirm(RemoteTerminationMode::Graceful, Duration::from_secs(1))
                .await,
            Err(RemoteProcessError::CleanupUnconfirmed)
        );
        control.tree_stopped.store(true, Ordering::Release);
        control.wrong_epoch.store(true, Ordering::Release);
        assert_eq!(process.state(), RemoteProcessState::Unknown);
        assert_eq!(
            process.wait_exit().await,
            Err(RemoteProcessError::IdentityMismatch)
        );
        assert_eq!(
            process
                .terminate_and_confirm(RemoteTerminationMode::Force, Duration::from_secs(1))
                .await,
            Err(RemoteProcessError::IdentityMismatch)
        );
        control.wrong_epoch.store(false, Ordering::Release);
        assert!(
            process
                .terminate_and_confirm(RemoteTerminationMode::Force, Duration::from_secs(1))
                .await
                .is_ok()
        );
        drop(process);
        assert!(
            control.stop_requests.lock().unwrap().is_empty(),
            "confirmed tree needs no second stop"
        );
    }

    #[tokio::test]
    async fn owner_receipts_reject_stale_rebind_and_accept_initial_zero() {
        let control = FakeControl::new();
        let process = process(control.clone());
        let first = Some(launch().initial_owner);
        assert_eq!(process.bind_owner(first.clone(), false).await, Ok(()));
        assert_eq!(process.owner_receipt().unwrap().unwrap().binding_seq, 0);
        assert_eq!(process.bind_owner(first.clone(), false).await, Ok(()));
        // Replayed seq0 cannot unbind the current Run.
        assert_eq!(
            process.bind_owner(None, false).await,
            Err(RemoteProcessError::IdentityMismatch)
        );
        assert_eq!(process.owner_receipt().unwrap().unwrap().owner, first);
        control.binding_seq.store(1, Ordering::Release);
        assert_eq!(process.bind_owner(None, false).await, Ok(()));
        assert_eq!(
            process.bind_owner(first.clone(), false).await,
            Err(RemoteProcessError::IdentityMismatch)
        );
        control.binding_seq.store(2, Ordering::Release);
        assert_eq!(process.bind_owner(first.clone(), false).await, Ok(()));
        // A flag change is a new binding even with the same owner.
        assert_eq!(
            process.bind_owner(first.clone(), true).await,
            Err(RemoteProcessError::IdentityMismatch)
        );
        control.binding_seq.store(3, Ordering::Release);
        assert_eq!(process.bind_owner(first.clone(), true).await, Ok(()));
        assert!(
            process
                .owner_receipt()
                .unwrap()
                .unwrap()
                .builtin_tasks_enabled
        );
        assert_eq!(
            process.bind_owner(None, true).await,
            Err(RemoteProcessError::IdentityMismatch)
        );
        // Capability refresh and native owner changes share one gate. A delayed
        // refresh must read the latest flag after acquiring it, not at dispatch.
        let binding = process.owner_binding_handle();
        let desired = Arc::new(AtomicBool::new(true));
        let gate = binding.gate.lock().await;
        let refresh = tokio::spawn(binding.sync_tasks(first.clone().unwrap(), desired.clone()));
        tokio::task::yield_now().await;
        desired.store(false, Ordering::Release);
        control.binding_seq.store(4, Ordering::Release);
        drop(gate);
        assert_eq!(refresh.await.unwrap(), Ok(()));
        let receipt = process.owner_receipt().unwrap().unwrap();
        assert!(!receipt.builtin_tasks_enabled);
        assert_eq!(receipt.binding_seq, 4);

        // A refresh future created before a newer change still observes that
        // current desired value when polled, and keeps the idempotent receipt.
        let delayed = binding.sync_tasks(first.clone().unwrap(), desired.clone());
        desired.store(true, Ordering::Release);
        control.binding_seq.store(5, Ordering::Release);
        binding
            .sync_tasks(first.clone().unwrap(), desired.clone())
            .await
            .unwrap();
        delayed.await.unwrap();
        assert!(
            process
                .owner_receipt()
                .unwrap()
                .unwrap()
                .builtin_tasks_enabled
        );
        assert_eq!(process.owner_receipt().unwrap().unwrap().binding_seq, 5);

        let old_owner_refresh = binding.sync_tasks(first.unwrap(), desired.clone());
        control.binding_seq.store(6, Ordering::Release);
        process.bind_owner(None, false).await.unwrap();
        let successor = AgentRunOwner {
            agent_run_id: "successor-run".into(),
            execution_epoch: 2,
        };
        control.binding_seq.store(7, Ordering::Release);
        process
            .bind_owner(Some(successor.clone()), false)
            .await
            .unwrap();
        assert_eq!(
            old_owner_refresh.await,
            Err(RemoteProcessError::IdentityMismatch)
        );
        let current = process.owner_receipt().unwrap().unwrap();
        assert_eq!(current.owner, Some(successor));
        assert!(!current.builtin_tasks_enabled);
        assert_eq!(current.binding_seq, 7);
        // Leader exit alone is not descendant cleanup.
        assert!(!process.tree_stopped().unwrap());
        control.tree_stopped.store(true, Ordering::Release);
        assert!(process.tree_stopped().unwrap());
    }

    struct FakeLauncher {
        control: Arc<FakeControl>,
        stall: bool,
    }
    impl RemoteProcessLauncher for FakeLauncher {
        fn start(&self, _launch: ScopedRemoteLaunch) -> RemoteFuture<'_, RemoteProcess> {
            Box::pin(async move {
                if self.stall {
                    std::future::pending::<()>().await;
                }
                Ok(process(self.control.clone()))
            })
        }
    }

    #[tokio::test]
    async fn startup_and_initial_binding_share_a_bounded_deadline() {
        let control = FakeControl::new();
        let slow_start = FakeLauncher {
            control: control.clone(),
            stall: true,
        };
        // Boxed IO is Send, not Sync. Preserve the native spawned-task contract.
        fn require_send<T: Send>(value: T) -> T {
            value
        }
        let owned = process(control.clone());
        drop(require_send(owned.wait_exit()));
        drop(require_send(
            owned.bind_owner(Some(launch().initial_owner), false),
        ));
        drop(require_send(owned.terminate_and_confirm(
            RemoteTerminationMode::Force,
            Duration::from_secs(1),
        )));
        drop(require_send(launch_remote(
            &slow_start,
            launch(),
            Duration::from_millis(20),
        )));
        control.tree_stopped.store(true, Ordering::Release);
        assert!(owned.tree_stopped().unwrap());
        drop(owned);
        control.tree_stopped.store(false, Ordering::Release);

        assert!(matches!(
            launch_remote(&slow_start, launch(), Duration::from_millis(20)).await,
            Err(RemoteProcessError::DeadlineExceeded)
        ));
        control.stall_binding.store(true, Ordering::Release);
        let slow_binding = FakeLauncher {
            control: control.clone(),
            stall: false,
        };
        assert!(matches!(
            launch_remote(&slow_binding, launch(), Duration::from_millis(20)).await,
            Err(RemoteProcessError::DeadlineExceeded)
        ));
        assert_eq!(
            *control.stop_requests.lock().unwrap(),
            vec![RemoteTerminationMode::Force]
        );
        assert!(!control.tree_stopped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn dropping_unknown_process_only_queues_stop() {
        let control = FakeControl::new();
        let process = process(control.clone());
        control.wrong_epoch.store(true, Ordering::Release);
        assert_eq!(process.state(), RemoteProcessState::Unknown);
        drop(process);
        assert_eq!(
            *control.stop_requests.lock().unwrap(),
            vec![RemoteTerminationMode::Force]
        );
        assert!(!control.tree_stopped.load(Ordering::Acquire));
    }
}
