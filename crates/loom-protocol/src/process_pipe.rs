//! Versioned opaque stdio transport for an A-owned native agent driver.
//! Pipe-written is not native input acceptance; leader exit is not tree cleanup.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROCESS_PIPE_VERSION: u32 = 1;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OUTPUT_CHUNK: usize = 16 * 1024;
pub const MAX_PENDING_INPUTS: usize = 16;
pub const MAX_UNACKED_EVENTS: usize = 64;
pub const MAX_UNACKED_BYTES: usize = 1024 * 1024;
pub const MAX_INPUT_RECEIPTS: usize = 128;
pub const MAX_SAFE_COUNTER: u64 = (1_u64 << 53) - 1;
pub type PipeResult<T> = Result<T, &'static str>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteProcessKey {
    pub node_id: String,
    pub process_id: String,
    pub process_epoch: u64,
}
impl RemoteProcessKey {
    pub fn validate(&self) -> PipeResult<()> {
        if !valid_id(&self.node_id) || !valid_id(&self.process_id)
            || !(1..=MAX_SAFE_COUNTER).contains(&self.process_epoch) {
            return Err("pipe_process_identity");
        }
        Ok(())
    }
}

/// A process can outlive one AgentRun. These epochs have separate authorities.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunOwner {
    pub agent_run_id: String,
    pub execution_epoch: u64,
}
impl AgentRunOwner {
    pub fn validate(&self) -> PipeResult<()> {
        if !valid_id(&self.agent_run_id)
            || !(1..=MAX_SAFE_COUNTER).contains(&self.execution_epoch) {
            return Err("pipe_run_identity");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessSessionOwner {
    pub member_id: String,
    pub logical_session_id: String,
    pub workspace_id: String,
    /// A network reconnect preserves this; a new controller cannot invent
    /// continuity with native parser state it no longer owns.
    pub controller_id: String,
}
impl ProcessSessionOwner {
    pub fn validate(&self) -> PipeResult<()> {
        if [&self.member_id, &self.logical_session_id, &self.workspace_id, &self.controller_id]
            .into_iter().any(|s| !valid_id(s)) {
            return Err("pipe_session_identity");
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProcessArgument {
    Literal { value: String },
    MaterializedFile { path: String },
}

/// A closed request built by trusted Core. Node admission additionally verifies
/// its own published CLI identity and workspace policy before a spec is built.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessOpenV1 {
    pub version: u32,
    pub key: RemoteProcessKey,
    pub session: ProcessSessionOwner,
    pub owner: AgentRunOwner,
    /// Derived from Core's current BuiltinToolRuntimeConfig, never from UI input.
    pub builtin_tasks_enabled: bool,
    pub adapter_kind: String,
    pub catalog_generation: u64,
    pub program_identity: String,
    pub program: String,
    pub cwd: String,
    pub args: Vec<ProcessArgument>,
    #[serde(default)]
    pub environment: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<crate::run_bundle::RunBundleV1>,
    /// v2 only: authenticated Core binds the exact frozen command settings and review.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_hook_grant: Option<crate::command_hooks::CodexHookGrantV1>,
}
impl std::fmt::Debug for ProcessOpenV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessOpenV1").field("key", &self.key)
            .field("argument_count", &self.args.len()).finish_non_exhaustive()
    }
}
impl ProcessOpenV1 {
    pub fn validate(&self) -> PipeResult<()> {
        self.key.validate()?;
        self.session.validate()?;
        self.owner.validate()?;
        if self.version != PROCESS_PIPE_VERSION
            && self.version != crate::command_hooks::CODEX_HOOK_PIPE_VERSION {
            return Err("pipe_version");
        }
        if !valid_id(&self.adapter_kind) || self.catalog_generation == 0
            || !bounded_text(&self.program_identity, 256) || !bounded_text(&self.program, 32768)
            || !bounded_text(&self.cwd, 32768) { return Err("pipe_launch_path"); }
        if self.args.len() > 512 { return Err("pipe_arguments"); }
        let mut bytes = 0usize;
        for arg in &self.args {
            let value = match arg {
                ProcessArgument::Literal { value } => {
                    if value.contains('\0') { return Err("pipe_arguments"); }
                    value
                }
                ProcessArgument::MaterializedFile { path } => {
                    if crate::run_bundle::safe_bundle_relative(path).is_err()
                        || !self.bundle.as_ref().is_some_and(|b| b.files.iter().any(|f| &f.path == path)) {
                        return Err("pipe_material_reference");
                    }
                    path
                }
            };
            bytes = bytes.checked_add(value.len()).ok_or("pipe_arguments")?;
        }
        if bytes > 256 * 1024 { return Err("pipe_arguments"); }
        let mut seen = std::collections::BTreeSet::new();
        if self.environment.len() > 16 { return Err("pipe_environment"); }
        for (name, value) in &self.environment {
            let allowed = match name.as_str() {
                "NO_COLOR" | "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"
                | "CLAUDE_CODE_DISABLE_AUTO_MEMORY" | "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" =>
                    matches!(value.as_str(), "0" | "1"),
                "PYTHONIOENCODING" => matches!(value.as_str(), "utf-8" | "utf-8:strict"),
                _ => false,
            };
            if !allowed || !seen.insert(name.to_ascii_uppercase()) {
                return Err("pipe_environment");
            }
        }
        if let Some(bundle) = &self.bundle {
            if bundle.agent_id != self.session.member_id { return Err("pipe_bundle_owner"); }
            crate::run_bundle::validate(bundle, &crate::run_bundle::BundleExpectation {
                run_id: &self.owner.agent_run_id, attempt: bundle.attempt,
                adapter_kind: &self.adapter_kind,
            }).map_err(|_| "pipe_bundle_invalid")?;
        }
        match (&self.codex_hook_grant, self.version) {
            (None, PROCESS_PIPE_VERSION) => {},
            (Some(grant), crate::command_hooks::CODEX_HOOK_PIPE_VERSION) => {
                let bundle = self.bundle.as_ref().ok_or("pipe_hook_bundle_required")?;
                grant.validate(bundle)?;
            },
            _ => return Err("pipe_hook_grant_version"),
        }
        if serde_json::to_vec(self).map_err(|_| "pipe_encoding")?.len() > 2 * 1024 * 1024 {
            return Err("pipe_frame_limit");
        }
        Ok(())
    }
    pub fn digest(&self) -> PipeResult<String> {
        self.validate()?;
        Ok(digest(&serde_json::to_vec(self).map_err(|_| "pipe_encoding")?))
    }
}

/// Request identity is derived from key+sequence, so a retired request id cannot
/// be reused with a higher sequence. Retired receipts never authorize re-writes.
pub fn input_request_id(key: &RemoteProcessKey, input_seq: u64) -> PipeResult<String> {
    key.validate()?;
    if !(1..=MAX_SAFE_COUNTER).contains(&input_seq) { return Err("pipe_input_identity"); }
    Ok(digest(&serde_json::to_vec(&(key, input_seq)).map_err(|_| "pipe_encoding")?))
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessInputV1 {
    pub key: RemoteProcessKey,
    pub owner: AgentRunOwner,
    pub controller_id: String,
    pub request_id: String,
    pub input_seq: u64,
    pub data: String,
    pub sha256: String,
    #[serde(default)]
    pub close: bool,
}
impl std::fmt::Debug for ProcessInputV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessInputV1").field("key", &self.key)
            .field("input_seq", &self.input_seq).field("encoded_bytes", &self.data.len())
            .field("close", &self.close).finish_non_exhaustive()
    }
}
impl ProcessInputV1 {
    pub fn new(key: RemoteProcessKey, owner: AgentRunOwner, controller_id: String,
        input_seq: u64, bytes: &[u8], close: bool) -> PipeResult<Self> {
        let request_id = input_request_id(&key, input_seq)?;
        let value = Self { key, owner, controller_id, request_id, input_seq,
            data: STANDARD.encode(bytes), sha256: digest(bytes), close };
        value.decode()?;
        Ok(value)
    }
    pub fn decode(&self) -> PipeResult<Vec<u8>> {
        self.owner.validate()?;
        if !valid_id(&self.controller_id)
            || self.request_id != input_request_id(&self.key, self.input_seq)? {
            return Err("pipe_input_identity");
        }
        let bytes = decode_bounded(&self.data, MAX_INPUT_BYTES)?;
        if bytes.is_empty() && !self.close { return Err("pipe_empty_input"); }
        if digest(&bytes) != self.sha256 { return Err("pipe_input_digest"); }
        Ok(bytes)
    }
    pub fn envelope_digest(&self) -> PipeResult<String> {
        self.decode()?;
        Ok(digest(&serde_json::to_vec(self).map_err(|_| "pipe_encoding")?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindProcessOwner {
    pub key: RemoteProcessKey,
    pub controller_id: String,
    pub request_id: String,
    pub binding_seq: u64,
    pub previous_owner: Option<AgentRunOwner>,
    pub next_owner: Option<AgentRunOwner>,
    pub builtin_tasks_enabled: bool,
    pub after_input_seq: u64,
}
impl BindProcessOwner {
    pub fn validate(&self) -> PipeResult<()> {
        self.key.validate()?;
        if !valid_id(&self.controller_id) || !valid_id(&self.request_id)
            || !(1..=MAX_SAFE_COUNTER).contains(&self.binding_seq)
            || self.after_input_seq > MAX_SAFE_COUNTER {
            return Err("pipe_owner_identity");
        }
        if let Some(owner) = &self.previous_owner { owner.validate()?; }
        if let Some(owner) = &self.next_owner { owner.validate()?; }
        if self.next_owner.is_none() && self.builtin_tasks_enabled { return Err("pipe_unbound_tasks"); }
        Ok(())
    }
    pub fn digest(&self) -> PipeResult<String> {
        self.validate()?;
        Ok(digest(&serde_json::to_vec(self).map_err(|_| "pipe_encoding")?))
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ProcessPipeCommand {
    Open { launch: ProcessOpenV1 },
    Input { input: ProcessInputV1 },
    BindOwner { binding: BindProcessOwner },
    Terminate { key: RemoteProcessKey, request_id: String, budget_ms: u32 },
    Release { key: RemoteProcessKey, controller_id: String, request_id: String,
        acked_event_seq: u64, abandon_output: bool },
    Resume { key: RemoteProcessKey, controller_id: String, after_event_seq: u64 },
    Ack { key: RemoteProcessKey, controller_id: String, event_seq: u64 },
}
impl std::fmt::Debug for ProcessPipeCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (operation, key) = match self {
            Self::Open { launch } => ("open", &launch.key),
            Self::Input { input } => ("input", &input.key),
            Self::BindOwner { binding } => ("bindOwner", &binding.key),
            Self::Terminate { key, .. } => ("terminate", key),
            Self::Release { key, .. } => ("release", key),
            Self::Resume { key, .. } => ("resume", key),
            Self::Ack { key, .. } => ("ack", key),
        };
        f.debug_struct("ProcessPipeCommand").field("operation", &operation)
            .field("key", key).finish_non_exhaustive()
    }
}
impl ProcessPipeCommand {
    pub fn validate(&self) -> PipeResult<()> {
        match self {
            Self::Open { launch } => launch.validate(),
            Self::Input { input } => input.decode().map(|_| ()),
            Self::BindOwner { binding } => binding.validate(),
            Self::Terminate { key, request_id, budget_ms } => {
                key.validate()?;
                if !valid_id(request_id) || !(1..=5000).contains(budget_ms) {
                    return Err("pipe_termination_request");
                }
                Ok(())
            }
            Self::Release { key, controller_id, request_id, acked_event_seq, .. } => {
                key.validate()?;
                if !valid_id(controller_id) || !valid_id(request_id) || *acked_event_seq > MAX_SAFE_COUNTER {
                    return Err("pipe_release_identity");
                }
                Ok(())
            }
            Self::Resume { key, controller_id, after_event_seq }
            | Self::Ack { key, controller_id, event_seq: after_event_seq } => {
                key.validate()?;
                if !valid_id(controller_id) || *after_event_seq > MAX_SAFE_COUNTER {
                    return Err("pipe_event_sequence");
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PipeStream { Stdout, Stderr }

/// Only output and stream termination share this bounded ACK/replay sequence.
/// Control replies below cannot be blocked by a full output window.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ProcessOutputBody {
    Output { stream: PipeStream, data: String },
    OutputFault { stream: PipeStream, code: String },
    /// Sent after both stream pumps finish, but says nothing about descendants.
    Exited { exit_code: Option<i32>, signal: Option<i32> },
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessOutputEvent {
    pub key: RemoteProcessKey,
    pub event_seq: u64,
    pub body: ProcessOutputBody,
}
impl std::fmt::Debug for ProcessOutputEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessOutputEvent").field("key", &self.key)
            .field("event_seq", &self.event_seq).finish_non_exhaustive()
    }
}
impl ProcessOutputEvent {
    pub fn validate(&self) -> PipeResult<()> {
        self.key.validate()?;
        if !(1..=MAX_SAFE_COUNTER).contains(&self.event_seq) { return Err("pipe_event_sequence"); }
        match &self.body {
            ProcessOutputBody::Output { data, .. } => {
                if decode_bounded(data, MAX_OUTPUT_CHUNK)?.is_empty() { return Err("pipe_empty_output"); }
            }
            ProcessOutputBody::OutputFault { code, .. } => {
                if !valid_id(code) { return Err("pipe_diagnostic"); }
            }
            ProcessOutputBody::Exited { .. } => {}
        }
        Ok(())
    }
}

/// Node-owned materialization facts for the exact immutable bundle in Open.
/// A reconstructs its known bootstrap with this root; Node never sends new text.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleMaterializationV1 {
    pub bundle_id: String,
    pub bundle_digest: String,
    pub skill_root: String,
}
impl std::fmt::Debug for BundleMaterializationV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BundleMaterializationV1").field("bundle_id",&self.bundle_id)
            .finish_non_exhaustive()
    }
}
impl BundleMaterializationV1 {
    pub fn validate(&self) -> PipeResult<()> {
        if !bounded_text(&self.bundle_id,crate::run_bundle::MAX_BUNDLE_BUNDLE_ID_BYTES)
            || !self.bundle_digest.strip_prefix("sha256:").is_some_and(valid_digest)
            || !bounded_text(&self.skill_root,32768) {
            return Err("pipe_materialization_receipt");
        }
        let bytes=self.skill_root.as_bytes();
        let absolute=self.skill_root.starts_with('/') || self.skill_root.starts_with(r"\\")
            || (bytes.len()>=3 && bytes[0].is_ascii_alphabetic() && bytes[1]==b':'
                && matches!(bytes[2],b'/'|b'\\'));
        if !absolute || self.skill_root.split(['/', '\\']).any(|part| part=="." || part=="..") {
            return Err("pipe_materialization_receipt");
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reply", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ProcessControlBody {
    Opened {
        launch_digest: String,
        node_pid: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        materialization: Option<BundleMaterializationV1>,
    },
    InputWritten { input_seq: u64, request_id: String, envelope_digest: String },
    InputUnknown { input_seq: u64, request_id: String, code: String },
    OwnerBound { request_id: String, binding_seq: u64, owner: Option<AgentRunOwner>,
        builtin_tasks_enabled: bool, input_seq: u64 },
    Terminated { request_id: String, leader_exited: bool, tree_stopped: bool },
    Released { request_id: String, final_event_seq: u64, acked_event_seq: u64, output_abandoned: bool },
    State { owner: Option<AgentRunOwner>, builtin_tasks_enabled: bool, input_seq: u64, prepared_input_seq: u64, binding_seq: u64,
        output_seq: u64, acked_output_seq: u64, leader_exited: bool, tree_stopped: bool,
        input_unknown: bool, stopping: bool },
    Refused { request_id: Option<String>, code: String },
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessControlReply {
    pub key: RemoteProcessKey,
    pub body: ProcessControlBody,
}
impl std::fmt::Debug for ProcessControlReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessControlReply").field("key", &self.key).finish_non_exhaustive()
    }
}
impl ProcessControlReply {
    pub fn validate(&self) -> PipeResult<()> {
        self.key.validate()?;
        match &self.body {
            ProcessControlBody::Opened { launch_digest, node_pid, materialization } => {
                if !valid_digest(launch_digest) || *node_pid == 0 { return Err("pipe_open_receipt"); }
                if let Some(materialization)=materialization { materialization.validate()?; }
            }
            ProcessControlBody::InputWritten { input_seq, request_id, envelope_digest } => {
                if *request_id != input_request_id(&self.key, *input_seq)?
                    || !valid_digest(envelope_digest) { return Err("pipe_input_receipt"); }
            }
            ProcessControlBody::InputUnknown { input_seq, request_id, code } => {
                if *request_id != input_request_id(&self.key, *input_seq)?
                    || !valid_id(code) { return Err("pipe_input_receipt"); }
            }
            ProcessControlBody::OwnerBound { request_id, binding_seq, owner, builtin_tasks_enabled, input_seq } => {
                if !valid_id(request_id) || !(1..=MAX_SAFE_COUNTER).contains(binding_seq)
                    || *input_seq > MAX_SAFE_COUNTER { return Err("pipe_owner_receipt"); }
                if let Some(owner) = owner { owner.validate()?; }
                if owner.is_none() && *builtin_tasks_enabled { return Err("pipe_unbound_tasks"); }
            }
            ProcessControlBody::Terminated { request_id, leader_exited, tree_stopped } => {
                if !valid_id(request_id) || (*tree_stopped && !*leader_exited) {
                    return Err("pipe_termination_receipt");
                }
            }
            ProcessControlBody::Released { request_id, final_event_seq, acked_event_seq, .. } => {
                if !valid_id(request_id) || *final_event_seq > MAX_SAFE_COUNTER || acked_event_seq > final_event_seq {
                    return Err("pipe_release_receipt");
                }
            }
            ProcessControlBody::State { owner, builtin_tasks_enabled, input_seq, prepared_input_seq, binding_seq, output_seq,
                acked_output_seq, leader_exited, tree_stopped, .. } => {
                if let Some(owner) = owner { owner.validate()?; }
                if owner.is_none() && *builtin_tasks_enabled { return Err("pipe_unbound_tasks"); }
                if [input_seq, prepared_input_seq, binding_seq, output_seq, acked_output_seq].into_iter().any(|n| *n > MAX_SAFE_COUNTER)
                    || input_seq > prepared_input_seq
                    || acked_output_seq > output_seq || (*tree_stopped && !*leader_exited) {
                    return Err("pipe_state_receipt");
                }
            }
            ProcessControlBody::Refused { request_id, code } => {
                if request_id.as_ref().is_some_and(|id| !valid_id(id)) || !valid_id(code) {
                    return Err("pipe_diagnostic");
                }
            }
        }
        Ok(())
    }
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b':'))
        && value != "." && value != ".."
}
fn bounded_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.contains(['\0', '\r', '\n'])
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub fn decode_bounded(value: &str, maximum: usize) -> PipeResult<Vec<u8>> {
    if value.len() > maximum.div_ceil(3) * 4 { return Err("pipe_payload_limit"); }
    let bytes = STANDARD.decode(value).map_err(|_| "pipe_base64")?;
    if bytes.len() > maximum { return Err("pipe_payload_limit"); }
    if STANDARD.encode(&bytes) != value { return Err("pipe_base64_canonical"); }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> ProcessInputV1 {
        ProcessInputV1::new(RemoteProcessKey { node_id: "node-1".into(), process_id: "process-1".into(), process_epoch: 3 },
            AgentRunOwner { agent_run_id: "run-1".into(), execution_epoch: 7 },
            "controller-1".into(), 1, b"{\"type\":\"user\"}\n", false).unwrap()
    }
    #[test]
    fn closed_input_wire_preserves_bytes_and_rejects_invalid_envelopes() {
        let original = input();
        assert_eq!(original.decode().unwrap(), b"{\"type\":\"user\"}\n");
        let mut value = serde_json::to_value(&original).unwrap();
        value["program"] = serde_json::json!("arbitrary executable");
        assert!(serde_json::from_value::<ProcessInputV1>(value).is_err());
        for bad in ["", "..", "../outside", "C:/root", "x\nx"] {
            let mut changed = original.clone();
            changed.key.process_id = bad.into();
            assert!(changed.decode().is_err());
        }
        let mut changed = original.clone();
        changed.data = STANDARD.encode(vec![0; MAX_INPUT_BYTES + 1]);
        assert_eq!(changed.decode().unwrap_err(), "pipe_payload_limit");
        changed = original.clone();
        changed.sha256 = "0".repeat(64);
        assert_eq!(changed.decode().unwrap_err(), "pipe_input_digest");
        changed = original.clone();
        changed.request_id.push('x');
        assert_eq!(changed.decode().unwrap_err(), "pipe_input_identity");
        assert!(!format!("{original:?}").contains("type"));
        // This is the exact pre-v2 no-hook serialization, including field
        // order. Optional grants must not change its bytes or digest.
        let legacy = concat!(
            r#"{"version":1,"key":{"nodeId":"node-1","processId":"process-1","processEpoch":3},"#,
            r#""session":{"memberId":"member-1","logicalSessionId":"session-1","workspaceId":"workspace-1","controllerId":"controller-1"},"#,
            r#""owner":{"agentRunId":"run-1","executionEpoch":7},"builtinTasksEnabled":false,"adapterKind":"codex-cli","catalogGeneration":1,"#,
            r#""programIdentity":"identity","program":"/bin/codex","cwd":"/workspace","args":[{"kind":"literal","value":"app-server"}],"environment":[]}"#
        );
        let open: ProcessOpenV1 = serde_json::from_str(legacy).unwrap();
        open.validate().unwrap();
        assert_eq!(serde_json::to_vec(&open).unwrap(),legacy.as_bytes());
        assert_eq!(open.digest().unwrap(),digest(legacy.as_bytes()));
        let mut ambiguous = open.clone();
        ambiguous.version = crate::command_hooks::CODEX_HOOK_PIPE_VERSION;
        assert_eq!(ambiguous.validate(),Err("pipe_hook_grant_version"));
    }
    #[test]
    fn replay_digest_binds_run_owner_sequence_and_close_without_native_acceptance() {
        let original = input();
        let expected = original.envelope_digest().unwrap();
        for variant in 0..3 {
            let mut changed = original.clone();
            match variant {
                0 => changed.owner.execution_epoch += 1,
                1 => { changed.input_seq += 1; changed.request_id = input_request_id(&changed.key, changed.input_seq).unwrap(); }
                _ => changed.close = true,
            }
            assert_ne!(changed.envelope_digest().unwrap(), expected);
        }
        let reply = ProcessControlReply { key: original.key,
            body: ProcessControlBody::InputWritten { input_seq: 1,
                request_id: original.request_id, envelope_digest: expected } };
        reply.validate().unwrap();
        let json = serde_json::to_string(&reply).unwrap();
        assert!(json.contains("inputWritten"));
        assert!(!json.contains("accepted") && !json.contains("eventSeq"));
    }
    #[test]
    fn cleanup_ack_cannot_come_from_an_exit_or_an_impossible_tree_receipt() {
        let key = input().key;
        let output = ProcessOutputEvent { key: key.clone(), event_seq: 1,
            body: ProcessOutputBody::Exited { exit_code: Some(0), signal: None } };
        output.validate().unwrap();
        assert!(!serde_json::to_string(&output).unwrap().contains("treeStopped"));
        let invalid = ProcessControlReply { key, body: ProcessControlBody::Terminated {
            request_id: "stop-1".into(), leader_exited: false, tree_stopped: true } };
        assert_eq!(invalid.validate(), Err("pipe_termination_receipt"));
    }
}
