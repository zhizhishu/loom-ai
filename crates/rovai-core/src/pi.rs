mod file_grant;
mod host;

use std::{fmt, path::Path, time::Duration};

use anyhow::{Context, Result, bail};
use rovai_core::{
    action::ActionResultOutcome,
    agent_profile::{AdapterKind, FrozenAgentRuntimeConfig},
    command::canonical_json_digest,
    runtime_failure::{RuntimeFailureOrigin, RuntimeFailurePhase, RuntimeFailureView},
    storage_layout::ThreadOutputDirectory,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncBufRead;

use crate::acp::CompletedAcpAction;

pub(crate) use file_grant::{
    PI_FILE_ACCESS_KEY, PI_FILE_ACCESS_NATIVE, PI_FILE_ACCESS_WORKSPACE_READ_ONLY,
    PI_FILE_ACCESS_WORKSPACE_READ_WRITE, PI_FILE_ACCESS_WORKSPACE_WORKFLOW,
    PI_FILE_GRANT_READ_ONLY_TOOLS, PI_FILE_GRANT_READ_WRITE_TOOLS, PI_FILE_GRANT_WORKFLOW_TOOLS,
    PI_FILE_GRANT_SCHEMA, PI_LOOM_TOOL_NAME, PiFileAccessMode, PiFileGrant, mode_from_permissions,
    now_epoch_ms,
};
pub(crate) use host::{
    PiActivationFailureKind, PiHost, PiPromptImage, PreparedPiPromptImage, activation_failure_kind,
    machine_ready_probe, model_catalog_probe, prepare_prompt_images,
};
pub use host::{PiAgentRunRuntimeRequest, PiMcpProjection, PiRpcRuntimeAdapter, PiRuntime};

pub(crate) const PI_PROTOCOL_VERSION: &str = "pi-jsonl-rpc-v1";
pub(crate) const PI_HOST_EXTENSION_VERSION: &str = "rovai-pi-host-v11";
/// The schema version of the `rovai-managed-guard-state` acknowledgement (the grant receipt).
///
/// P0 step 2 / plan decision E2: the grant carries the LOOM claim triple
/// (`claimId`/`fenceGeneration`/`leaseExpiresAtEpochMs`), so the receipt moved from v3 to v4 and
/// every older receipt is refused instead of being field-compared against a wider document.
/// P0 step 3: the grant now also carries `requiresClaim` (the boolean that makes every `write`/`edit`
/// require a live claim), so the receipt moves again to v5 and a v4 acknowledgement is refused.
/// It is a SEPARATE constant from the binding/session-state `SCHEMA_VERSION` in `managed-host.ts`
/// because those two documents did not change; the TypeScript side mirrors this with
/// `GRANT_SCHEMA_VERSION`. Both ends must move together — drift here makes `await_guard_ready` refuse
/// every guarded Run.
pub(crate) const PI_MANAGED_GUARD_SCHEMA_VERSION: i64 = 5;
// The managed Host extension validates the OPTIONAL per-Run file grant (`ROVAI_PI_FILE_GRANT_FILE`)
// and publishes `rovai-managed-guard-state`. v10 widened the accepted grant to the two exact frozen
// tool sets (`read` or `read`/`write`/`edit`); v11 adds the third, explicitly chosen
// `workspace_workflow` set (`read`/`write`/`edit` plus the one managed `rovai_loom` business tool)
// and registers that tool at extension load time. Every hard-coded copy of the version string was
// updated in the same change (agent_runtime_adapter host-config metadata, the Host test fixture, and
// `scripts/smoke-member-environment-upgrade.mjs`).
/// The shared Pi file guard is embedded from the single canonical source in `scripts/`. The Core
/// materializes these exact bytes into the private Host root and loads them with an explicit
/// `--extension`, so the production path and the isolated Runner validate with the SAME algorithm.
/// The digest participates in the Host compatibility digest, never just a wrapper hash.
pub(crate) const PI_FILE_GUARD_EXTENSION_SOURCE: &str =
    include_str!("../../../scripts/loom-v2-runtime-file-guard.ts");
pub(crate) const PI_FILE_GUARD_EXTENSION_NAME: &str = "rovai-pi-file-guard.ts";
/// The managed LOOM workflow bridge is the single canonical source of the one Core business tool the
/// `workspace_workflow` policy adds. It is embedded here, written next to the managed Host extension,
/// and imported by it, so production and the Node contract test validate the SAME bytes and the same
/// closed operation table. Its digest is part of the Host compatibility identity.
pub(crate) const MANAGED_WORKFLOW_TOOL_EXTENSION: &str = include_str!("pi/managed-workflow-tool.ts");
pub(crate) const MANAGED_WORKFLOW_TOOL_EXTENSION_NAME: &str = "managed-workflow-tool.ts";
pub(crate) const MANAGED_WORKFLOW_CONTRACT_NAME: &str = "loom-workflow-contract.json";

/// The native tool consumes the existing Core input contracts, never a second schema registry.
pub(crate) fn managed_workflow_contract() -> Value {
    let operations: Vec<Value> = crate::loom_tool::tool_definitions()
        .into_iter()
        .filter(|definition| definition["name"].as_str().is_some_and(crate::loom_tool::is_loom_tool))
        .map(|definition| json!({
            "operation": definition["name"], "inputSchema": definition["inputSchema"]
        }))
        .collect();
    json!({"schemaVersion": 1, "operations": operations})
}
/// The managed Pi MCP extension is a generated bundle: `scripts/build-pi-mcp.mjs`
/// inlines the maintained MCP client so the Pi process needs no node_modules tree.
pub(crate) const PI_MCP_EXTENSION_VERSION: &str = "rovai-pi-mcp-v1";
pub(crate) const MANAGED_MCP_EXTENSION: &str = include_str!("pi/managed-mcp.bundle.mjs");
pub(crate) const PI_MCP_DOCUMENT_SCHEMA_VERSION: u32 = 1;
const PI_MCP_MAX_SERVERS: usize = 32;
// Pi image results may include the same base64 data in content and structuredContent.
// Receive and send budgets are independent; stderr retains its own smaller limit.
pub(super) const PI_MAX_INBOUND_RECORD_BYTES: usize = 64 * 1024 * 1024;
pub(super) const PI_MAX_OUTBOUND_RECORD_BYTES: usize = 4 * 1024 * 1024;
pub(super) const PI_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiTransportFailure {
    FrameTooLarge {
        limit_bytes: usize,
        observed_bytes: usize,
    },
    ProtocolViolation,
    ReadFailed,
}

impl PiTransportFailure {
    pub fn public_failure(self) -> RuntimeFailureView {
        let (origin, code, summary) = match self {
            Self::FrameTooLarge { .. } => (
                RuntimeFailureOrigin::Rovai,
                "pi_rpc_frame_too_large",
                "Pi 返回消息超出接收上限",
            ),
            Self::ProtocolViolation => (
                RuntimeFailureOrigin::Compatibility,
                "pi_rpc_protocol_error",
                "Pi 返回了不兼容的协议消息",
            ),
            Self::ReadFailed => (
                RuntimeFailureOrigin::Environment,
                "pi_rpc_read_failed",
                "无法读取 Pi 运行连接",
            ),
        };
        RuntimeFailureView::new(
            AdapterKind::Pi,
            origin,
            RuntimeFailurePhase::Execution,
            code,
            summary,
            Some(self.to_string()),
            false,
        )
    }
}

impl fmt::Display for PiTransportFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FrameTooLarge {
                limit_bytes,
                observed_bytes,
            } => write!(
                formatter,
                "Pi RPC frame exceeds the receive limit: at least {observed_bytes} bytes, limit {limit_bytes} bytes"
            ),
            Self::ProtocolViolation => formatter.write_str("Pi RPC protocol validation failed"),
            Self::ReadFailed => formatter.write_str("Pi RPC stdout could not be read"),
        }
    }
}

impl std::error::Error for PiTransportFailure {}

#[derive(Debug)]
pub enum PiIncoming {
    Message {
        host_instance_id: String,
        agent_run_id: String,
        execution_epoch: i64,
        native_session_id: String,
        native_prompt_id: String,
        delivery_id: String,
        sequence: u64,
        message: Value,
    },
    Exited {
        host_instance_id: String,
        agent_run_id: String,
        execution_epoch: i64,
        failure: Option<PiTransportFailure>,
    },
    Diagnostic {
        host_instance_id: String,
        agent_run_id: Option<String>,
        execution_epoch: Option<i64>,
        phase: String,
        message: String,
    },
    IngressFlushed {
        acknowledgement: tokio::sync::oneshot::Sender<()>,
    },
}

pub fn unsupported_extension_ui_cancellation(request: &Value) -> Result<Value> {
    if request.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        bail!("Pi message is not an Extension UI request");
    }
    let id = request
        .get("id")
        .filter(|id| !id.is_null())
        .cloned()
        .context("Pi Extension UI request omitted id")?;
    Ok(
        if request.get("method").and_then(Value::as_str) == Some("confirm") {
            json!({"type": "extension_ui_response", "id": id, "confirmed": false})
        } else {
            json!({"type": "extension_ui_response", "id": id, "cancelled": true})
        },
    )
}

pub fn normalize_event(message: &Value) -> (&'static str, Value) {
    match message.get("type").and_then(Value::as_str) {
        Some("message_update")
            if message
                .pointer("/assistantMessageEvent/type")
                .and_then(Value::as_str)
                == Some("text_delta") =>
        {
            (
                "agent.text.delta",
                json!({
                    "delta": message.pointer("/assistantMessageEvent/delta").and_then(Value::as_str).unwrap_or(""),
                    "contentIndex": message.pointer("/assistantMessageEvent/contentIndex"),
                }),
            )
        }
        Some("message_update")
            if message
                .pointer("/assistantMessageEvent/type")
                .and_then(Value::as_str)
                == Some("thinking_delta") =>
        {
            (
                "agent.thought.delta",
                json!({
                    "delta": message.pointer("/assistantMessageEvent/delta").and_then(Value::as_str).unwrap_or(""),
                    "contentIndex": message.pointer("/assistantMessageEvent/contentIndex"),
                }),
            )
        }
        Some("message_update")
            if matches!(
                message
                    .pointer("/assistantMessageEvent/type")
                    .and_then(Value::as_str),
                Some("thinking_start" | "thinking_end")
            ) =>
        {
            let event = if message
                .pointer("/assistantMessageEvent/type")
                .and_then(Value::as_str)
                == Some("thinking_start")
            {
                "agent.thought.started"
            } else {
                "agent.thought.completed"
            };
            (
                event,
                json!({"contentIndex": message.pointer("/assistantMessageEvent/contentIndex")}),
            )
        }
        Some("message_update") => ("runtime.event", json!({"type": "message_update"})),
        Some("tool_execution_start") => (
            "runtime.action",
            json!({
                "toolCallId": message.get("toolCallId"),
                "toolName": message.get("toolName"),
                "status": "in_progress",
                "kind": public_tool_kind(message.get("toolName").and_then(Value::as_str)),
                "input": public_tool_input(message.get("toolName").and_then(Value::as_str), message.get("args")),
            }),
        ),
        Some("tool_execution_update") => (
            "runtime.action",
            json!({
                "runtimePhaseBoundary": false,
                "toolCallId": message.get("toolCallId"),
                "toolName": message.get("toolName"),
                "status": "in_progress",
                "kind": public_tool_kind(message.get("toolName").and_then(Value::as_str)),
                "input": public_tool_input(message.get("toolName").and_then(Value::as_str), message.get("args")),
                "output": public_content_text(message.pointer("/partialResult/content")),
            }),
        ),
        Some("tool_execution_end") => {
            let is_error = message.get("isError").and_then(Value::as_bool) == Some(true);
            let tool_name = message.get("toolName").and_then(Value::as_str);
            let mut payload = json!({
                "toolCallId": message.get("toolCallId"),
                "toolName": message.get("toolName"),
                "status": if is_error { "failed" } else { "completed" },
                "kind": public_tool_kind(tool_name),
                "output": public_content_text(message.pointer("/result/content")),
            });
            if !is_error
                && let Some(tool_name) = tool_name
                && let Some((operation_kind, path)) = terminal_file_operation(message, tool_name)
            {
                payload["runtimeFileOperation"] = json!({
                    "adapterKind": "pi",
                    "protocolFamily": PI_PROTOCOL_VERSION,
                    "sourceEventKind": "tool_execution_end.completed",
                    "operationKind": operation_kind,
                    "path": path,
                });
            }
            if !is_error
                && tool_name == Some("edit")
                && let Some((path, patch)) = terminal_edit_patch(message)
            {
                payload["runtimeDiff"] = json!({
                    "adapterKind": "pi",
                    "protocolFamily": PI_PROTOCOL_VERSION,
                    "sourceEventKind": "tool_execution_end.completed",
                    "semanticKind": "pi_edit_patch",
                    "entries": [{
                        "path": path,
                        "changeKind": "update",
                        "diff": patch,
                    }],
                });
            }
            ("runtime.action", payload)
        }
        Some("agent_settled") => ("runtime.turn.completed", json!({"status": "settled"})),
        Some("compaction_start" | "compaction_end") => (
            "runtime.event",
            json!({"type": message.get("type"), "reason": message.get("reason")}),
        ),
        Some(value) => ("runtime.event", json!({"type": value})),
        None => ("runtime.event", json!({"type": "unknown"})),
    }
}

/// Pi's delta frame contains a contentIndex, not a message identity. Keep that
/// index scoped to this Runtime's explicit message_start/message_end interval.

#[derive(Default)]
pub(super) struct PiTextState {
    message_ordinal: u64,
    native_message_id: Option<String>,
    assistant_active: bool,
}

impl PiTextState {
    fn item_id(&self, index: u64) -> String {
        format!(
            "pi-text-{}-{index}",
            self.native_message_id
                .as_deref()
                .map(str::to_owned)
                .unwrap_or_else(|| self.message_ordinal.to_string())
        )
    }

    pub(super) fn normalize(&mut self, message: &Value) -> Vec<(&'static str, Value)> {
        let event = message.get("type").and_then(Value::as_str);
        let assistant =
            message.pointer("/message/role").and_then(Value::as_str) == Some("assistant");
        if assistant
            && matches!(event, Some("message_start" | "message_end"))
            && !crate::runtime::is_root_output(message)
        {
            return vec![];
        }
        if event == Some("message_start") && assistant {
            self.message_ordinal += 1;
            self.assistant_active = crate::runtime::is_root_output(message);
            self.native_message_id = message
                .pointer("/message/id")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if event == Some("message_end") && assistant {
            self.assistant_active = false;
            return message.pointer("/message/content").and_then(Value::as_array)
                .into_iter().flatten().enumerate().filter_map(|(index, block)| {
                    (block.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| block.get("text").and_then(Value::as_str)).flatten().map(|text| {
                            ("agent.text.completed", json!({
                                "itemId": self.item_id(index as u64), "text": text,
                                "status": match message.pointer("/message/stopReason").and_then(Value::as_str) {
                                    Some("aborted" | "error") => "interrupted", _ => "completed"
                                }
                            }))
                        })
                }).collect();
        }
        let (event_type, mut payload) = normalize_event(message);
        if matches!(
            event_type,
            "agent.thought.delta" | "agent.thought.started" | "agent.thought.completed"
        ) && (!self.assistant_active || !crate::runtime::is_root_output(message))
        {
            return vec![];
        }
        if matches!(
            event_type,
            "agent.text.delta"
                | "agent.thought.delta"
                | "agent.thought.started"
                | "agent.thought.completed"
        ) {
            let index = message
                .pointer("/assistantMessageEvent/contentIndex")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            payload["itemId"] = json!(self.item_id(index));
        }
        if !crate::runtime::is_root_output(message) {
            payload["runtimeRootOutput"] = json!(false);
        }
        vec![(event_type, payload)]
    }
}

pub(crate) fn runtime_compatibility_digest(
    frozen_runtime: &FrozenAgentRuntimeConfig,
    cwd: &Path,
    attachment_authorization: &ThreadOutputDirectory,
) -> Result<String> {
    runtime_compatibility_digest_with_mcp(frozen_runtime, cwd, attachment_authorization, None)
}

/// Same identity, plus the frozen MCP document this Run actually carries.
///
/// Warm reuse is fenced on the whole document digest, so two Runs with different
/// selected servers can never share one Host, and a retry of the same Run keeps
/// reusing the bytes frozen at launch instead of re-reading the live catalog.
pub(crate) fn runtime_compatibility_digest_with_mcp(
    frozen_runtime: &FrozenAgentRuntimeConfig,
    cwd: &Path,
    _attachment_authorization: &ThreadOutputDirectory,
    mcp_document: Option<&Value>,
) -> Result<String> {
    let cwd = cwd
        .canonicalize()
        .with_context(|| format!("failed to resolve execution root {}", cwd.display()))?;
    let executable = Path::new(&frozen_runtime.executable_path)
        .canonicalize()
        .context("failed to resolve qualified Pi executable")?;
    let mut identity = json!({
        "schemaVersion": 4,
        "adapterKind": AdapterKind::Pi,
        "protocolVersion": PI_PROTOCOL_VERSION,
        "executionRoot": cwd,
        "executablePath": executable,
        "reportedVersion": frozen_runtime.reported_version,
        "executableFingerprint": frozen_runtime.executable_fingerprint,
        "hostConfigDigest": frozen_runtime.host_config_digest,
        "managedExtensionVersion": PI_HOST_EXTENSION_VERSION,
        "managedExtensionDigest": format!("{:x}", Sha256::digest(include_str!("pi/managed-host.ts").as_bytes())),
        // The shared guard is part of the same compatibility identity: two Runs that would load a
        // different guard implementation must never share a warm Host.
        "managedFileGuardDigest": format!("{:x}", Sha256::digest(PI_FILE_GUARD_EXTENSION_SOURCE.as_bytes())),
        // The managed workflow bridge is part of the same compatibility identity: two Runs that would
        // load a different bridge implementation must never share a warm Host.
        "managedWorkflowToolDigest": format!("{:x}", Sha256::digest(MANAGED_WORKFLOW_TOOL_EXTENSION.as_bytes())),
        "managedWorkflowContractDigest": canonical_json_digest(&managed_workflow_contract())?,
    });
    if let Some(document) = mcp_document {
        identity["managedMcpExtensionVersion"] = json!(PI_MCP_EXTENSION_VERSION);
        identity["managedMcpExtensionDigest"] = json!(format!("{:x}", Sha256::digest(MANAGED_MCP_EXTENSION.as_bytes())));
        identity["managedMcpDocumentDigest"] = json!(managed_mcp_document_digest(document)?);
    }
    canonical_json_digest(&identity)
}

/// Constant used when this Run selects no MCP server at all.
pub(crate) const PI_MCP_NO_DOCUMENT_DIGEST: &str = "none";

/// One frozen MCP server, in the exact shape the managed extension consumes.
///
/// An absent `cwd` is omitted from the document instead of serialized as `null`:
/// the extension only accepts an absent or a string `cwd`.
pub(crate) fn managed_mcp_server(name: &str, definition: &crate::mcp::McpServerDefinition) -> Result<Value> {
    match definition {
        crate::mcp::McpServerDefinition::Stdio {
            command,
            args,
            cwd,
            env,
        } => {
            let mut entry = serde_json::Map::new();
            entry.insert("name".to_string(), json!(name));
            entry.insert("transport".to_string(), json!("stdio"));
            entry.insert("command".to_string(), json!(command));
            entry.insert("args".to_string(), json!(args));
            entry.insert("env".to_string(), json!(env));
            if let Some(cwd) = cwd {
                entry.insert("cwd".to_string(), json!(cwd));
            }
            Ok(Value::Object(entry))
        }
        crate::mcp::McpServerDefinition::StreamableHttp { url, headers } => Ok(json!({
            "name": name,
            "transport": "streamable_http",
            "url": url,
            "headers": headers,
        })),
    }
}

/// `sha256:` prefix is required by the extension for every digest it verifies.
fn sha256_prefixed(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

///
/// The frozen per-Run MCP document for the managed Pi extension.
///
/// Two different digests exist on purpose:
/// * `config_digest` stamps the canonical configuration *body* (schema + servers).
///   It is what re-identifies the selection; it is not a file stamp.
/// * `file_digest` covers the **exact bytes written**, trailing newline included,
///   because the extension hashes the file it actually read.
///
#[derive(Debug, Clone)]
pub(crate) struct PiMcpDocumentFile {
    pub document: Value,
    pub bytes: Vec<u8>,
    pub config_digest: String,
    pub file_digest: String,
}

/// The single serializer both Core and the Host writer must use.
pub(crate) fn managed_mcp_document_file(
    servers: &std::collections::BTreeMap<String, crate::mcp::McpServerDefinition>,
) -> Result<PiMcpDocumentFile> {
    anyhow::ensure!(
        servers.len() <= PI_MCP_MAX_SERVERS,
        "Pi MCP selection exceeds the managed server limit"
    );
    let mut entries = Vec::with_capacity(servers.len());
    for (name, definition) in servers {
        if name.trim().is_empty() || name.contains('\0') {
            bail!("invalid Pi MCP server name");
        }
        entries.push(managed_mcp_server(name, definition)?);
    }
    let body = json!({
        "schemaVersion": PI_MCP_DOCUMENT_SCHEMA_VERSION,
        "servers": entries,
    });
    let config_digest = format!("sha256:{}", canonical_json_digest(&body)?);
    let document = json!({
        "schemaVersion": PI_MCP_DOCUMENT_SCHEMA_VERSION,
        "configDigest": config_digest,
        "servers": body["servers"].clone(),
    });
    let bytes = managed_mcp_document_bytes(&document)?;
    let file_digest = sha256_prefixed(&bytes);
    Ok(PiMcpDocumentFile {
        document,
        bytes,
        config_digest,
        file_digest,
    })
}

/// Backwards-compatible view for the read-only Run projection.
pub(crate) fn managed_mcp_document(
    servers: &std::collections::BTreeMap<String, crate::mcp::McpServerDefinition>,
) -> Result<Value> {
    Ok(managed_mcp_document_file(servers)?.document)
}

/// Exact on-disk bytes. The Host and the Node-side verifier share this format.
pub(crate) fn managed_mcp_document_bytes(document: &Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(document)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Warm reuse and file admission use the same complete frozen document bytes.
pub(crate) fn managed_mcp_document_digest(document: &Value) -> Result<String> {
    Ok(sha256_prefixed(&managed_mcp_document_bytes(document)?))
}

pub(super) fn completed_action(message: &Value) -> Result<Option<CompletedAcpAction>> {
    let native_item_id = required_string(message, "toolCallId")?.to_string();
    let tool_name = required_string(message, "toolName")?.to_string();
    let is_error = message
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let result_digest = message
        .get("result")
        .map(canonical_json_digest)
        .transpose()?;
    let observation_digest = canonical_json_digest(&json!({
        "toolCallId": native_item_id,
        "toolName": tool_name,
        "resultDigest": result_digest.as_deref(),
        "isError": is_error,
    }))?;
    let file_operation = (!is_error)
        .then(|| terminal_file_operation(message, &tool_name))
        .flatten();
    Ok(Some(CompletedAcpAction {
        native_item_id,
        native_kind: public_tool_kind(Some(&tool_name))
            .unwrap_or("other")
            .to_string(),
        public_command: None,
        public_search_operation_candidate: None,
        public_file_operation_kind: file_operation
            .as_ref()
            .map(|(operation_kind, _)| operation_kind.clone()),
        public_file_operation_path: file_operation.map(|(_, path)| path),
        public_file_operation_change_kind: None,
        public_file_changes: None,
        observation_digest,
        outcome: if is_error {
            ActionResultOutcome::Failed
        } else {
            ActionResultOutcome::Succeeded
        },
        result_code: if is_error {
            "pi_tool_failed".to_string()
        } else {
            "pi_tool_completed".to_string()
        },
        result_summary: if is_error {
            "Pi tool execution failed".to_string()
        } else {
            "Pi tool execution completed".to_string()
        },
        result_data: json!({
            "status": if is_error { "failed" } else { "completed" },
            "resultDigest": result_digest.as_deref(),
        }),
        effect_disposition: if is_error { "unknown" } else { "complete" }.to_string(),
    }))
}

fn terminal_file_operation(message: &Value, tool_name: &str) -> Option<(String, String)> {
    let operation_kind = match tool_name {
        "read" => "read",
        "write" | "edit" => "write",
        _ => return None,
    };
    let path = message
        .pointer("/args/path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())?;
    Some((operation_kind.to_string(), path.to_string()))
}

fn terminal_edit_patch(message: &Value) -> Option<(String, String)> {
    let path = message
        .pointer("/args/path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())?;
    let patch = message
        .pointer("/result/details/patch")
        .and_then(Value::as_str)
        .filter(|patch| !patch.trim().is_empty())?;
    Some((path.to_string(), patch.to_string()))
}

fn reconcile_terminal_tool_message(message: &mut Value, observed: &Value) {
    let Some(message) = message.as_object_mut() else {
        return;
    };
    if !message
        .get("toolName")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        && let Some(value) = observed
            .get("toolName")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
    {
        message.insert("toolName".to_string(), Value::String(value.to_string()));
    }
    if let Some(observed_args) = observed.get("args").and_then(Value::as_object) {
        if let Some(current_args) = message.get_mut("args").and_then(Value::as_object_mut) {
            for (key, value) in observed_args {
                current_args
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
        } else {
            message.insert("args".to_string(), Value::Object(observed_args.clone()));
        }
    }
}

pub(super) fn assistant_message_text(message: &Value) -> Option<String> {
    let text = match message.get("content")? {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

fn public_content_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn public_tool_kind(name: Option<&str>) -> Option<&'static str> {
    match name {
        Some("bash") => Some("execute"),
        Some("write" | "edit") => Some("edit"),
        Some("read" | "grep" | "find" | "ls") => Some("read"),
        _ => None,
    }
}

fn public_tool_input(name: Option<&str>, args: Option<&Value>) -> Option<String> {
    match name {
        Some("bash") => args?.get("command")?.as_str().map(str::to_string),
        _ => None,
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("Pi message has no {key}"))
}

pub(super) fn value_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

pub(super) async fn read_jsonl_record<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>> {
    let mut record = Vec::new();
    loop {
        let buffer = tokio::io::AsyncBufReadExt::fill_buf(reader).await?;
        if buffer.is_empty() {
            if record.is_empty() {
                return Ok(None);
            }
            break;
        }
        let take = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |offset| offset + 1);
        let observed_bytes = record.len().saturating_add(take);
        if observed_bytes > max_bytes {
            return Err(PiTransportFailure::FrameTooLarge {
                limit_bytes: max_bytes,
                observed_bytes,
            }
            .into());
        }
        record.extend_from_slice(&buffer[..take]);
        tokio::io::AsyncBufReadExt::consume(reader, take);
        if record.last() == Some(&b'\n') {
            record.pop();
            if record.last() == Some(&b'\r') {
                record.pop();
            }
            break;
        }
    }
    Ok(Some(record))
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn text_identity_is_scoped_to_message_and_content_index_with_authoritative_terminal() {
        let mut state = PiTextState::default();
        state.normalize(&json!({"type":"message_start","message":{"role":"assistant"}}));
        let a = state.normalize(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"A"}}));
        let b = state.normalize(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":2,"delta":"B"}}));
        let thinking = json!({"type":"message_update","assistantMessageEvent":{
            "type":"thinking_delta","contentIndex":1,"delta":"PRIVATE_THOUGHT_MARKER",
            "partial":{"content":[{"type":"thinking","thinking":"PRIVATE_FULL_BLOCK"}]}
        }});
        let thought = state.normalize(&thinking);
        assert_eq!(thought[0].0, "agent.thought.delta");
        assert_ne!(thought[0].1["itemId"], a[0].1["itemId"]);
        assert!(
            !serde_json::to_string(&thought[0].1)
                .unwrap()
                .contains("PRIVATE_FULL_BLOCK")
        );
        for (native, normalized) in [
            ("thinking_start", "agent.thought.started"),
            ("thinking_end", "agent.thought.completed"),
        ] {
            let frame = json!({"type":"message_update","assistantMessageEvent":{"type":native,"contentIndex":1,"content":"PRIVATE_SIGNATURE"}});
            let events = state.normalize(&frame);
            assert_eq!(events[0].0, normalized);
            assert_eq!(events[0].1["itemId"], thought[0].1["itemId"]);
            assert_eq!(events[0].1.as_object().unwrap().len(), 2);
        }
        assert!(state.normalize(&json!({"type":"message_end","parent_tool_use_id":"child","message":{"role":"assistant","content":[{"type":"text","text":"child"}]}})).is_empty());
        assert!(!state.normalize(&thinking).is_empty());
        for field in ["subagentId", "parent_tool_use_id", "replay", "snapshot"] {
            let mut excluded = thinking.clone();
            excluded["assistantMessageEvent"]["partial"][field] = json!(true);
            assert!(state.normalize(&excluded).is_empty());
        }
        let terminal = state.normalize(&json!({"type":"message_end","message":{"role":"assistant","stopReason":"aborted","content":[{"type":"text","text":"A final"},{"type":"toolCall","id":"tool"},{"type":"text","text":"B partial"}]}}));
        assert_ne!(a[0].1["itemId"], b[0].1["itemId"]);
        assert_eq!(terminal.len(), 2);
        assert_eq!(terminal[0].0, "agent.text.completed");
        assert_eq!(terminal[0].1["itemId"], a[0].1["itemId"]);
        assert_eq!(terminal[1].1["itemId"], b[0].1["itemId"]);
        assert_eq!(terminal[0].1["text"], "A final");
        assert_eq!(terminal[0].1["status"], "interrupted");
        assert!(state.normalize(&thinking).is_empty());
        state.normalize(&json!({"type":"message_start","message":{"role":"assistant"}}));
        let next = state.normalize(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"C"}}));
        assert_ne!(next[0].1["itemId"], a[0].1["itemId"]);
    }

    #[tokio::test]
    async fn jsonl_reader_bounds_records_and_preserves_unicode() {
        use tokio::io::AsyncReadExt;

        for input in [
            b"{\"value\":\"a\xE2\x80\xA8b\xE2\x80\xA9c\"}\n".as_slice(),
            b"{}\r\n",
            b"{}",
        ] {
            let mut reader = BufReader::with_capacity(1, input);
            let record = read_jsonl_record(&mut reader, 1024).await.unwrap().unwrap();
            let value: Value = serde_json::from_slice(&record).unwrap();
            if let Some(value) = value.get("value") {
                assert_eq!(value, "a\u{2028}b\u{2029}c");
            }
            assert!(
                read_jsonl_record(&mut reader, 1024)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        // The wire budget includes the line delimiter. Generate the input as a
        // stream so the boundary cases do not require two 64 MiB input copies.
        for (length, accepted) in [
            (PI_MAX_INBOUND_RECORD_BYTES - 1, true),
            (PI_MAX_INBOUND_RECORD_BYTES, false),
        ] {
            let input = tokio::io::repeat(b'x')
                .take(length as u64)
                .chain(b"\n".as_slice());
            let mut reader = BufReader::new(input);
            let result = read_jsonl_record(&mut reader, PI_MAX_INBOUND_RECORD_BYTES).await;
            if accepted {
                assert_eq!(result.unwrap().unwrap().len(), length);
            } else {
                let error = result.unwrap_err();
                let failure = error.downcast_ref::<PiTransportFailure>().unwrap();
                assert_eq!(
                    *failure,
                    PiTransportFailure::FrameTooLarge {
                        limit_bytes: PI_MAX_INBOUND_RECORD_BYTES,
                        observed_bytes: PI_MAX_INBOUND_RECORD_BYTES + 1,
                    }
                );
                let public = failure.public_failure();
                public.validate().unwrap();
                assert_eq!(public.code, "pi_rpc_frame_too_large");
                assert_eq!(public.origin, RuntimeFailureOrigin::Rovai);
                assert!(!public.retryable);
            }
        }
    }

    #[test]
    fn managed_extension_reports_numeric_session_state_and_injects_bootstrap() {
        let source = include_str!("pi/managed-host.ts");
        assert!(!source.contains("PI_CODING_AGENT_DIR"));
        assert!(!source.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(!source.contains("mcpTools"));
        assert!(!source.contains("mcpProjectionDigest"));
        // Exactly one tool is registered: the managed LOOM workflow bridge, and only for the frozen
        // `workspace_workflow` policy. No MCP bridge and no other tool surface may appear here.
        assert_eq!(source.matches("pi.registerTool(").count(), 1);
        assert!(source.contains("name: LOOM_TOOL_NAME"));
        assert!(!source.contains("namespacedToolName"));
        assert!(!source.contains("Rovai MCP bridge"));
        assert!(!source.contains("pi.setActiveTools"));
        assert!(!source.contains("resources_discover"));
        assert!(!source.contains("skillPaths"));
        assert!(!source.contains("skillRoot"));
        assert!(!source.contains("expectedManagedSkillExposureDigest"));
        assert!(!source.contains("pi.on(\"input\""));
        assert!(!source.contains("pi.on(\"tool_call\""));
        assert!(!source.contains("ctx.ui.confirm"));
        assert!(!source.contains("ctx.ui.input"));
        assert!(!source.contains("ctx.abort"));
        assert!(!source.contains("pi.getAllTools"));
        assert!(!source.contains("GOVERNED_NATIVE_TOOLS"));
        assert!(!source.contains("SettingsManager"));
        assert!(!source.contains("getAgentDir"));
        assert!(!source.contains("getShellConfig"));
        assert!(!source.contains("Rovai partial approval"));
        assert!(!source.contains("Rovai managed input receipt"));
        assert!(!source.contains("approvedBindingDigest"));
        assert_eq!(source.matches("pi.on(").count(), 4);
        assert!(source.contains("ctx.getContextUsage()"));
        assert!(source.contains("rovai-managed-context-usage"));
        assert!(source.contains("pi.on(\"session_start\""));
        assert!(source.contains("pi.on(\"before_agent_start\""));
        assert!(source.contains("const current = loadBinding()"));
        assert!(source.contains("`${event.systemPrompt}\\n\\n${current.bootstrap}`"));
    }

    #[test]
    fn terminal_file_tools_emit_bounded_read_and_write_operations() {        for (tool_name, operation_kind) in [("read", "read"), ("write", "write"), ("edit", "write")]
        {
            let (_, payload) = normalize_event(&json!({
                "type": "tool_execution_end",
                "toolCallId": format!("tool-{tool_name}"),
                "toolName": tool_name,
                "args": {"path": "/repo/src/app.ts"},
                "isError": false,
                "result": {"content": [{"type":"text","text":"done"}]}
            }));
            assert_eq!(
                payload["runtimeFileOperation"]["operationKind"],
                operation_kind
            );
            assert_eq!(payload["runtimeFileOperation"]["path"], "/repo/src/app.ts");
        }
        for tool_name in ["grep", "find", "ls"] {
            let (_, payload) = normalize_event(&json!({
                "type": "tool_execution_end",
                "toolCallId": format!("tool-{tool_name}"),
                "toolName": tool_name,
                "args": {"path": "/repo/src/app.ts"},
                "isError": false
            }));
            assert!(payload.get("runtimeFileOperation").is_none());
        }
    }

    #[test]
    fn successful_edit_emits_the_native_patch_but_write_and_failed_edit_do_not() {
        let patch = concat!(
            "--- /repo/src/app.ts\n",
            "+++ /repo/src/app.ts\n",
            "@@ -1 +1,2 @@\n",
            "-old\n",
            "+new\n",
            "+next\n",
        );
        let (_, edited) = normalize_event(&json!({
            "type": "tool_execution_end",
            "toolCallId": "tool-edit",
            "toolName": "edit",
            "args": {"path": "/repo/src/app.ts"},
            "isError": false,
            "result": {
                "content": [{"type":"text","text":"done"}],
                "details": {"patch": patch}
            }
        }));
        assert_eq!(edited["runtimeDiff"]["semanticKind"], "pi_edit_patch");
        assert_eq!(
            edited["runtimeDiff"]["entries"][0]["path"],
            "/repo/src/app.ts"
        );
        assert_eq!(edited["runtimeDiff"]["entries"][0]["diff"], patch);

        for (tool_name, is_error) in [("write", false), ("edit", true)] {
            let (_, payload) = normalize_event(&json!({
                "type": "tool_execution_end",
                "toolCallId": format!("tool-{tool_name}"),
                "toolName": tool_name,
                "args": {"path": "/repo/src/app.ts"},
                "isError": is_error,
                "result": {"details": {"patch": patch}}
            }));
            assert!(payload.get("runtimeDiff").is_none());
        }
    }

    #[test]
    fn terminal_file_tools_reuse_start_arguments_when_pi_omits_them_at_end() {
        let start = json!({
            "type": "tool_execution_start",
            "toolCallId": "tool-read",
            "toolName": "read",
            "args": {"path": "/repo/src/app.ts"}
        });
        let mut update = json!({
            "type": "tool_execution_update",
            "toolCallId": "tool-read",
            "toolName": "read",
            "args": {"line": 10}
        });
        reconcile_terminal_tool_message(&mut update, &start);
        let (_, progress) = normalize_event(&update);
        assert_eq!(progress["runtimePhaseBoundary"], false);
        let mut terminal = json!({
            "type": "tool_execution_end",
            "toolCallId": "tool-read",
            "isError": false,
            "result": {"content": [{"type":"text","text":"done"}]}
        });

        reconcile_terminal_tool_message(&mut terminal, &update);
        let (_, payload) = normalize_event(&terminal);

        assert_eq!(payload["runtimeFileOperation"]["operationKind"], "read");
        assert_eq!(payload["runtimeFileOperation"]["path"], "/repo/src/app.ts");
    }

    #[test]
    fn terminal_edit_patch_reuses_only_the_same_tool_calls_observed_arguments() {
        let start = json!({
            "type": "tool_execution_start",
            "toolCallId": "tool-edit",
            "toolName": "edit",
            "args": {"path": "/repo/src/app.ts"}
        });
        let mut terminal = json!({
            "type": "tool_execution_end",
            "toolCallId": "tool-edit",
            "isError": false,
            "result": {"details": {"patch": concat!(
                "--- /repo/src/app.ts\n",
                "+++ /repo/src/app.ts\n",
                "@@ -1 +1 @@\n-old\n+new\n"
            )}}
        });

        reconcile_terminal_tool_message(&mut terminal, &start);
        let (_, payload) = normalize_event(&terminal);

        assert_eq!(payload["runtimeFileOperation"]["path"], "/repo/src/app.ts");
        assert_eq!(
            payload["runtimeDiff"]["entries"][0]["path"],
            "/repo/src/app.ts"
        );
    }

    #[test]
    fn unsupported_native_extension_ui_is_cancelled_without_managed_interpretation() {
        for method in ["select", "input", "editor"] {
            let request = json!({
                "type": "extension_ui_request",
                "method": method,
                "id": format!("ui-{method}"),
                "title": "Third-party Pi Extension",
            });
            assert_eq!(
                unsupported_extension_ui_cancellation(&request).unwrap(),
                json!({
                    "type": "extension_ui_response",
                    "id": format!("ui-{method}"),
                    "cancelled": true,
                })
            );
        }
        let confirm = json!({
            "type": "extension_ui_request",
            "method": "confirm",
            "id": "ui-confirm",
            "title": "Third-party Pi Extension",
        });
        assert_eq!(
            unsupported_extension_ui_cancellation(&confirm).unwrap(),
            json!({
                "type": "extension_ui_response",
                "id": "ui-confirm",
                "confirmed": false,
            })
        );
    }
}

#[cfg(test)]
mod managed_workflow_source_tests {
    use super::*;

    #[test]
    fn workflow_tool_sources_agree_on_one_tool_name_and_the_nine_operations() {
        // One fixture owns the Node seam; its contents must remain the actual Core schemas.
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../scripts/fixtures/pi-workflow/core-input-contract.json"
        )).unwrap();
        assert_eq!(managed_workflow_contract(), fixture);
        assert_eq!(fixture["operations"].as_array().unwrap().len(), 9);
        // The name and the operation set live in three places that MUST agree: the Rust contract
        // (file_grant.rs / builtin_tool_transport.rs), the managed Host extension that registers the
        // tool, and the shared guard that re-checks every call. A drift here is a silent policy hole,
        // so it is asserted rather than trusted.
        assert_eq!(PI_LOOM_TOOL_NAME, "rovai_loom");
        for source in [
            include_str!("pi/managed-host.ts"),
            MANAGED_WORKFLOW_TOOL_EXTENSION,
            PI_FILE_GUARD_EXTENSION_SOURCE,
        ] {
            assert!(source.contains("rovai_loom"), "a managed source lost the tool name");
        }
        for operation in crate::builtin_tool_transport::MANAGED_WORKFLOW_OPERATIONS {
            for source in [MANAGED_WORKFLOW_TOOL_EXTENSION, PI_FILE_GUARD_EXTENSION_SOURCE] {
                assert!(
                    source.contains(operation),
                    "{operation} is missing from a managed workflow source"
                );
            }
        }
        // The bridge names no shell, no arbitrary command and no input-file argument.
        for forbidden in [
            "shell: true",
            "execSync",
            "\"--input-file\"",
            "'--input-file'",
            "powershell",
            "cmd.exe",
        ] {
            assert!(
                !MANAGED_WORKFLOW_TOOL_EXTENSION.contains(forbidden),
                "the bridge must not use {forbidden}"
            );
        }
        assert!(MANAGED_WORKFLOW_TOOL_EXTENSION.contains("shell: false"));
        // The bridge must validate the SAME envelope version the CLI emits, or a readable result could
        // be accepted under the wrong contract.
        assert!(
            MANAGED_WORKFLOW_TOOL_EXTENSION.contains(&format!(
                "ENVELOPE_VERSION = {}",
                crate::builtin_tool_transport::BUILTIN_TOOL_ENVELOPE_VERSION
            )),
            "the bridge envelope version drifted from BUILTIN_TOOL_ENVELOPE_VERSION"
        );
        // The legacy tool sets stay representable, unchanged, next to the new one.
        assert_eq!(PI_FILE_GRANT_READ_ONLY_TOOLS, ["read"]);
        assert_eq!(PI_FILE_GRANT_READ_WRITE_TOOLS, ["read", "write", "edit"]);
        assert_eq!(
            PI_FILE_GRANT_WORKFLOW_TOOLS,
            ["read", "write", "edit", PI_LOOM_TOOL_NAME]
        );
    }

    /// P0 step 2: the grant document carries the LOOM claim triple on both ends of one contract, and
    /// the guard receipt's schema version is the same number in `managed-host.ts` and here. Node owns
    /// the behavioural proof; this is the cargo-runnable drift guard that keeps the two ends together.
    #[test]
    fn managed_host_grant_carries_the_claim_and_one_receipt_schema_version() {
        let source = include_str!("pi/managed-host.ts");
        assert!(
            source.contains(&format!(
                "const GRANT_SCHEMA_VERSION = {PI_MANAGED_GUARD_SCHEMA_VERSION};"
            )),
            "the grant receipt schema version drifted from PI_MANAGED_GUARD_SCHEMA_VERSION"
        );
        for key in ["claimId", "fenceGeneration", "leaseExpiresAtEpochMs"] {
            assert!(
                source.contains(&format!("\"{key}\"")),
                "managed-host.ts lost the {key} grant field"
            );
        }
        // The empty (unbound) triple is a legal shape; an incoherent one is not.
        assert!(source.contains("runGrant claim is incomplete"));
        assert!(source.contains("runGrant claim is inconsistent"));
        // P0 step 3: the requirement flag travels on both ends of the same document, exactly once.
        assert!(source.contains("\"requiresClaim\""));
        assert!(source.contains("runGrant requiresClaim is invalid"));
        // The binding and session-state documents did NOT change shape, so they keep the older
        // version: one shared bump would have invalidated evidence this step never widened.
        assert!(source.contains("const SCHEMA_VERSION = 3;"));
    }

    /// P0 step 3: the two managed sources agree on the claim gate vocabulary. A drift in a reason
    /// code would silently turn a refusal into an allow, so it is asserted rather than trusted.
    #[test]
    fn the_guard_and_the_managed_host_agree_on_the_claim_gate() {
        for token in [
            "requiresClaim",
            "claimId",
            "fenceGeneration",
            "leaseExpiresAtEpochMs",
        ] {
            assert!(
                PI_FILE_GUARD_EXTENSION_SOURCE.contains(token),
                "the shared guard lost {token}"
            );
            assert!(
                include_str!("pi/managed-host.ts").contains(token),
                "managed-host.ts lost {token}"
            );
        }
        for token in [
            "claim_missing",
            "claim_expired",
            "guard_requires_claim_missing",
            "guard_claim_incomplete",
            "guard_claim_inconsistent",
        ] {
            assert!(
                PI_FILE_GUARD_EXTENSION_SOURCE.contains(token),
                "the shared guard lost the {token} decision"
            );
        }
        // The gate is on the writing tools only: a `read` is never blocked by a missing claim.
        assert!(PI_FILE_GUARD_EXTENSION_SOURCE.contains("CLAIM_GATE_TOOLS"));
        // Re-issuing the grant is what moves the authorisation after a `loom.claim`, so the guard
        // must consume the file rather than a launch-time snapshot.
        assert!(PI_FILE_GUARD_EXTENSION_SOURCE.contains("loadGrantFromFile(grantPath)"));
    }

    /// P0 step 3: the document the shared guard reads is re-issued for the claim the Run holds now,
    /// and ONLY the claim moves. The guard re-reads this file before every decision, so this is the
    /// whole mechanism that lets a `loom.claim` issued after the Host started take effect — including
    /// on the warm-Host re-use path, which calls exactly this function with `request.live_claim`.
    #[test]
    fn reissuing_the_guard_grant_moves_only_the_claim_fence() {
        use crate::loom::LiveClaim;

        let root = std::env::temp_dir().join(format!(
            "rovai-pi-guard-grant-reissue-{}",
            std::process::id()
        ));
        let config_root = root.join("host-config").join("instance");
        std::fs::create_dir_all(&config_root).unwrap();
        let now = now_epoch_ms();
        // The r9 shape: a LOOM-bound Run launched BEFORE it claims, so the first document requires a
        // claim it does not have yet.
        let launched = PiFileGrant::for_run(
            PiFileAccessMode::WorkspaceWorkflow,
            "run-1",
            "bot-1",
            3,
            &root,
            &root.join("guard.jsonl"),
            now,
            None,
            true,
        )
        .unwrap()
        .unwrap();
        let path = config_root.join("guard-grant.json");
        let bytes = serde_json::to_vec(&launched.to_document().unwrap()).unwrap();
        // An elevated CI token makes a plain write owned by Administrators, which the private file
        // admission rejects; pre-write the document the way the product does.
        #[cfg(windows)]
        crate::platform::atomic_write_private_bytes(&path, &bytes).unwrap();
        #[cfg(not(windows))]
        std::fs::write(&path, &bytes).unwrap();
        let published = || -> Value {
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap()
        };
        assert_eq!(published()["requiresClaim"], json!(true));
        assert_eq!(published()["claimId"], json!(""));

        let claim = LiveClaim {
            claim_id: "claim-1".to_string(),
            agent_run_id: "run-1".to_string(),
            fence_generation: 2,
            lease_expires_at: chrono::DateTime::from_timestamp_millis(now + 90_000)
                .unwrap()
                .to_rfc3339(),
        };
        let reissued = super::host::reissue_guard_grant_file(
            &config_root,
            &launched,
            Some(&claim),
            true,
            now,
        )
        .unwrap()
        .expect("a loom.claim must publish a new guard grant");
        assert_eq!(reissued.fence_generation, 2);
        let document = published();
        assert_eq!(document["claimId"], json!("claim-1"));
        assert_eq!(document["fenceGeneration"], json!(2));
        assert_eq!(document["requiresClaim"], json!(true));
        assert_eq!(
            document["leaseExpiresAtEpochMs"],
            json!(now + 90_000),
            "the published document carries the lease the guard compares"
        );
        // Everything the guard binds to stays byte-identical: a re-issue can never re-point it.
        for key in [
            "schema",
            "runId",
            "botId",
            "executionEpoch",
            "workspaceReal",
            "allowedTools",
            "expiresAtEpochMs",
            "logPath",
        ] {
            assert_eq!(
                document[key],
                launched.to_document().unwrap()[key],
                "assertion a re-issue never moves the guard identity field {key}"
            );
        }
        // The warm-Host re-use path must be idempotent: the same claim is not published twice.
        assert!(
            super::host::reissue_guard_grant_file(&config_root, &reissued, Some(&claim), true, now)
                .unwrap()
                .is_none(),
            "assertion re-issuing the same claim writes nothing"
        );
        // A Run that holds no claim yet and is not bound to a LOOM Task never gets a document that
        // demands one: ordinary chat behaviour is unchanged.
        assert!(
            super::host::reissue_guard_grant_file(&config_root, &launched, None, true, now)
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod managed_mcp_document_tests {
    use super::*;
    use crate::mcp::McpServerDefinition;
    use std::collections::BTreeMap;

    fn selection(cwd: Option<&str>) -> BTreeMap<String, McpServerDefinition> {
        BTreeMap::from([(
            "fixture".to_string(),
            McpServerDefinition::Stdio {
                command: "__NODE_EXECUTABLE__".to_string(),
                args: vec!["__STDIO_FIXTURE__".to_string()],
                cwd: cwd.map(str::to_owned),
                env: BTreeMap::new(),
            },
        )])
    }

    /// The extension hashes the file it read, so Core must stamp those exact bytes.
    #[test]
    fn file_digest_covers_the_exact_written_bytes_including_the_newline() {
        let file = managed_mcp_document_file(&selection(None)).unwrap();
        assert_eq!(file.bytes.last(), Some(&b'\n'), "the document must end with a newline");
        assert_eq!(file.file_digest, sha256_prefixed(&file.bytes));
        assert_eq!(managed_mcp_document_digest(&file.document).unwrap(), file.file_digest);
        assert_eq!(managed_mcp_document_bytes(&file.document).unwrap(), file.bytes);
        assert_eq!(
            file.file_digest,
            format!("sha256:{:x}", Sha256::digest(&file.bytes))
        );
        // The digest must cover the whole file, not just the config body.
        assert_ne!(file.file_digest, file.config_digest);
        assert_eq!(
            serde_json::from_slice::<Value>(&file.bytes).unwrap(),
            file.document
        );
    }

    /// The extension only accepts `sha256:<hex>` and an absent-or-string `cwd`.
    #[test]
    fn config_digest_is_prefixed_and_absent_cwd_is_omitted() {
        let file = managed_mcp_document_file(&selection(None)).unwrap();
        let config_digest = file.document["configDigest"].as_str().unwrap();
        assert!(config_digest.starts_with("sha256:"), "{config_digest}");
        let hex = &config_digest["sha256:".len()..];
        assert_eq!(hex.len(), 64);
        assert!(hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(config_digest, file.config_digest);

        let server = &file.document["servers"][0];
        assert!(server.get("cwd").is_none(), "absent cwd must be omitted: {server}");

        let with_cwd = managed_mcp_document_file(&selection(Some("/synthetic/work"))).unwrap();
        assert_eq!(
            with_cwd.document["servers"][0]["cwd"].as_str(),
            Some("/synthetic/work")
        );
        assert_ne!(with_cwd.config_digest, file.config_digest);
        assert_ne!(with_cwd.file_digest, file.file_digest);
    }

    /// Warm reuse must move with the configuration body.
    #[test]
    fn document_digest_changes_with_the_selection() {
        let plain = selection(None);
        let one = managed_mcp_document_file(&plain).unwrap();
        let two = managed_mcp_document_file(&selection(Some("/synthetic/work"))).unwrap();
        assert_ne!(
            managed_mcp_document_digest(&one.document).unwrap(),
            managed_mcp_document_digest(&two.document).unwrap()
        );
        assert_eq!(managed_mcp_document(&plain).unwrap(), one.document);
        // A Run with no selected server keeps the original identity.
        assert_eq!(PI_MCP_NO_DOCUMENT_DIGEST, "none");
    }

    /// The shared fixture is the same frozen shape both Core and the Node test read.
    #[test]
    fn shared_fixture_matches_the_generated_document_shape() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../scripts/fixtures/pi-mcp/frozen-document.json"))
                .unwrap();
        let generated = managed_mcp_document_file(&selection(None)).unwrap();
        assert_eq!(fixture["schemaVersion"], generated.document["schemaVersion"]);
        assert_eq!(fixture["servers"], generated.document["servers"]);
        // The fixture must carry no configDigest: Core stamps it, the Node test
        // recomputes the file digest over exactly these bytes.
        assert!(fixture.get("configDigest").is_none());
        for server in fixture["servers"].as_array().unwrap() {
            assert!(server.get("cwd").is_none());
            assert!(server.get("transport").is_some());
        }
    }
}
