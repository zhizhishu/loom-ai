//! Native Rovai CLI calls from Node-local IPC over the authenticated Node channel.
//! No Core process/lease credentials are serialized in these messages.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::process_pipe::{AgentRunOwner, RemoteProcessKey, MAX_SAFE_COUNTER, digest, valid_id};

pub const BUILTIN_PIPE_VERSION: u32 = 1;
pub const MAX_BUILTIN_FRAME: usize = 1024 * 1024;
pub const MAX_PENDING_BUILTINS: usize = 16;
pub type BuiltinResult<T> = Result<T, &'static str>;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuiltinCallV1 {
    pub version: u32,
    pub key: RemoteProcessKey,
    pub owner: AgentRunOwner,
    pub binding_seq: u64,
    pub request_id: String,
    pub operation: String,
    pub input: Value,
    /// Display-only provenance parsed by the existing CLI on B. This must not
    /// become authority to open/register an A-local file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_input_file_path: Option<String>,
}
impl BuiltinCallV1 {
    pub fn validate(&self) -> BuiltinResult<()> {
        if self.version != BUILTIN_PIPE_VERSION { return Err("builtin_pipe_version"); }
        self.key.validate()?;
        self.owner.validate()?;
        if self.binding_seq > MAX_SAFE_COUNTER || !valid_id(&self.request_id) {
            return Err("builtin_pipe_identity");
        }
        if self.operation.is_empty() || self.operation.len() > 128
            || !self.operation.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-') {
            return Err("builtin_pipe_operation");
        }
        if self.send_input_file_path.as_ref().is_some_and(|p|
            p.is_empty() || p.len() > 4096 || p.contains(['\0', '\r', '\n'])) {
            return Err("builtin_pipe_source_path");
        }
        if serde_json::to_vec(self).map_err(|_| "builtin_pipe_encoding")?.len() > MAX_BUILTIN_FRAME {
            return Err("builtin_pipe_frame_limit");
        }
        Ok(())
    }
    pub fn digest(&self) -> BuiltinResult<String> {
        self.validate()?;
        Ok(digest(&serde_json::to_vec(self).map_err(|_| "builtin_pipe_encoding")?))
    }
}
impl std::fmt::Debug for BuiltinCallV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BuiltinCallV1").field("key", &self.key)
            .field("binding_seq", &self.binding_seq).field("request_id", &self.request_id)
            .field("operation", &self.operation).finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuiltinReplyV1 {
    pub version: u32,
    pub key: RemoteProcessKey,
    pub binding_seq: u64,
    pub request_id: String,
    pub request_digest: String,
    /// The existing BuiltinToolIpcResponse. None closes the local connection;
    /// the existing CLI then retries the SAME request or reports uncertainty.
    pub response: Option<Value>,
}
impl BuiltinReplyV1 {
    pub fn validate(&self) -> BuiltinResult<()> {
        if self.version != BUILTIN_PIPE_VERSION { return Err("builtin_pipe_version"); }
        self.key.validate()?;
        if self.binding_seq > MAX_SAFE_COUNTER || !valid_id(&self.request_id)
            || self.request_digest.len() != 64
            || !self.request_digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return Err("builtin_pipe_identity");
        }
        if let Some(response) = &self.response {
            if !response.is_object()
                || !matches!(response.get("kind").and_then(Value::as_str), Some("envelope" | "error")) {
                return Err("builtin_pipe_response");
            }
        }
        if serde_json::to_vec(self).map_err(|_| "builtin_pipe_encoding")?.len() > MAX_BUILTIN_FRAME {
            return Err("builtin_pipe_frame_limit");
        }
        Ok(())
    }
}
impl std::fmt::Debug for BuiltinReplyV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BuiltinReplyV1").field("key", &self.key)
            .field("binding_seq", &self.binding_seq).field("request_id", &self.request_id)
            .field("has_response", &self.response.is_some()).finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call() -> BuiltinCallV1 {
        BuiltinCallV1 { version: 1,
            key: RemoteProcessKey { node_id: "node".into(), process_id: "process".into(), process_epoch: 1 },
            owner: AgentRunOwner { agent_run_id: "run".into(), execution_epoch: 2 },
            binding_seq: 0, request_id: "request".into(), operation: "camp.context".into(),
            input: serde_json::json!({"body":"private-prompt"}), send_input_file_path: None }
    }
    #[test]
    fn typed_call_binds_owner_and_payload_without_debug_leak() {
        let first = call();
        assert!(!format!("{first:?}").contains("private-prompt"));
        // The real CLI operation name is hyphenated. Lexical admission here is
        // not authorization: the dispatch/allowlist still decides what may run.
        let mut legit = call();
        legit.operation = "loom.stage-review".into();
        assert_eq!(legit.validate(), Ok(()));
        assert!(legit.digest().is_ok());
        let roundtrip: BuiltinCallV1 =
            serde_json::from_slice(&serde_json::to_vec(&legit).unwrap()).unwrap();
        assert_eq!(roundtrip, legit);
        assert_eq!(roundtrip.operation.as_str(), "loom.stage-review");
        let too_long = "a".repeat(129);
        for rejected in ["", " ", "a/b", "a\nb", "中文", "$", too_long.as_str()] {
            let mut bad = call();
            bad.operation = rejected.to_owned();
            assert_eq!(bad.validate(), Err("builtin_pipe_operation"), "{rejected:?}");
        }
        // Syntactically valid but unknown stays lexically admitted only.
        let mut unknown = call();
        unknown.operation = "foo.bar".into();
        assert_eq!(unknown.validate(), Ok(()));
        let mut next = first.clone(); next.binding_seq = 1;
        assert_ne!(first.digest().unwrap(), next.digest().unwrap());
        next = first.clone(); next.owner.execution_epoch = 3;
        assert_ne!(first.digest().unwrap(), next.digest().unwrap());
        next = first.clone(); next.input = serde_json::json!({"body":"different"});
        assert_ne!(first.digest().unwrap(), next.digest().unwrap());
        let mut json = serde_json::to_value(first).unwrap();
        json["processToken"] = Value::String("forbidden".into());
        assert!(serde_json::from_value::<BuiltinCallV1>(json).is_err());
    }
    #[test]
    fn reply_and_limits_are_closed_without_inventing_a_success() {
        let request = call();
        let mut reply = BuiltinReplyV1 { version: 1, key: request.key.clone(), binding_seq: 0,
            request_id: request.request_id.clone(), request_digest: request.digest().unwrap(), response: None };
        reply.validate().unwrap();
        reply.response = Some(serde_json::json!({"kind":"error","error":{"code":"scope","message":"private-value"}}));
        reply.validate().unwrap();
        assert!(!format!("{reply:?}").contains("private-value"));
        reply.response = Some(serde_json::json!({"kind":"success"}));
        assert_eq!(reply.validate(), Err("builtin_pipe_response"));
        let mut large = request;
        large.input = Value::String("x".repeat(MAX_BUILTIN_FRAME));
        assert_eq!(large.validate(), Err("builtin_pipe_frame_limit"));
    }
}
