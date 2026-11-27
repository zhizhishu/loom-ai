//! Common local/remote agent Built-in Tool entry. The parent router has
//! already authenticated the lease and authorized the operation before calling
//! this module. The database guard must be dropped before awaiting this method.
use super::{BuiltinOperationError, Core};
use crate::{
    team_tool::AuthenticatedTeamToolRun,
    workspace_rpc::{
        Admission, CancelOutcome, ReplayResponse, RequestState, TrustedPrincipal,
        WorkspaceArchiveKind, WorkspaceArchiveReceipt, WorkspaceRpcStore,
        archive_completed_results,
    },
    workspace_rpc_authority::resolve_workspace_authority,
};
use base64::Engine as _;
use loom_protocol::workspace_rpc::*;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

fn timeout() -> u64 {
    30_000
}
fn list_limit() -> u32 {
    200
}
fn read_limit() -> u32 {
    65_536
}
fn page_limit() -> usize {
    256
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
fn error(code: RpcErrorCode) -> anyhow::Error {
    BuiltinOperationError {
        code: code.code().to_owned(),
        message: "Workspace operation could not be completed.".into(),
        details: None,
    }
    .into()
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, RpcErrorCode> {
    serde_json::from_value(value.clone()).map_err(|_| RpcErrorCode::InvalidRequest)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    workspace_id: String,
    #[serde(default)]
    path: String,
    #[serde(default = "list_limit")]
    limit: u32,
    #[serde(default = "timeout")]
    timeout_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    workspace_id: String,
    path: String,
    #[serde(default)]
    offset: u64,
    #[serde(default = "read_limit")]
    max_bytes: u32,
    #[serde(default = "timeout")]
    timeout_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteInput {
    workspace_id: String,
    path: String,
    data: String,
    #[serde(default = "timeout")]
    timeout_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunInput {
    workspace_id: String,
    tool_id: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default = "timeout")]
    timeout_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PollInput {
    request_id: String,
    #[serde(default)]
    after_seq: u64,
    #[serde(default = "page_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelInput {
    request_id: String,
}

fn build_request(
    auth: &AuthenticatedTeamToolRun,
    operation: &str,
    input: &Value,
    call_id: &str,
) -> Result<WorkspaceRequest, RpcErrorCode> {
    if call_id.is_empty() || call_id.len() > 4096 {
        return Err(RpcErrorCode::InvalidRequest);
    }
    let mut payload = input.clone();
    let explicit_id = payload
        .as_object_mut()
        .ok_or(RpcErrorCode::InvalidRequest)?
        .remove("requestId");
    let explicit_id = explicit_id
        .map(|value| {
            let text = value.as_str().ok_or(RpcErrorCode::InvalidRequest)?;
            uuid::Uuid::parse_str(text)
                .map(|id| id.to_string())
                .map_err(|_| RpcErrorCode::InvalidRequest)
        })
        .transpose()?;
    let stable_call_id = explicit_id.as_deref().unwrap_or(call_id);
    let input = &payload;
    let identity = serde_json::to_vec(&(
        "loom.workspace.call.v1",
        &auth.agent_run_id,
        auth.execution_epoch,
        stable_call_id,
    ))
    .map_err(|_| RpcErrorCode::InvalidRequest)?;
    let request_id = format!("wrpc_{:x}", Sha256::digest(identity));
    let (workspace_id, timeout_ms, operation) = match operation {
        "loom.workspace.list" => {
            let v: ListInput = decode(input)?;
            (
                v.workspace_id,
                v.timeout_ms,
                WorkspaceOperation::List {
                    path: v.path,
                    limit: v.limit,
                },
            )
        }
        "loom.workspace.read" => {
            let v: ReadInput = decode(input)?;
            (
                v.workspace_id,
                v.timeout_ms,
                WorkspaceOperation::Read {
                    path: v.path,
                    offset: v.offset,
                    max_bytes: v.max_bytes,
                },
            )
        }
        "loom.workspace.write" => {
            let v: WriteInput = decode(input)?;
            (
                v.workspace_id,
                v.timeout_ms,
                WorkspaceOperation::Write {
                    path: v.path,
                    data: v.data,
                },
            )
        }
        "loom.workspace.run" => {
            let v: RunInput = decode(input)?;
            (
                v.workspace_id,
                v.timeout_ms,
                WorkspaceOperation::Run {
                    tool_id: v.tool_id,
                    args: v.args,
                    cwd: v.cwd,
                },
            )
        }
        _ => return Err(RpcErrorCode::InvalidRequest),
    };
    let request = WorkspaceRequest {
        version: RPC_VERSION,
        request_id,
        workspace_id,
        timeout_ms,
        operation,
    };
    request.validate()?;
    Ok(request)
}
fn validate_control_id(id: &str) -> Result<(), RpcErrorCode> {
    let suffix = id
        .strip_prefix("wrpc_")
        .ok_or(RpcErrorCode::InvalidRequest)?;
    if suffix.len() != 64 || !suffix.bytes().all(|b| matches!(b,b'0'..=b'9'|b'a'..=b'f')) {
        return Err(RpcErrorCode::InvalidRequest);
    }
    Ok(())
}
fn control_replay(page: &ReplayResponse, after_seq: u64) -> WorkspaceReplay {
    WorkspaceReplay {
        version: RPC_VERSION,
        request_id: page.status.request_id.clone(),
        run_id: page.status.dispatch.scope.run_id.clone(),
        attempt: page.status.dispatch.scope.attempt,
        request_digest: page.status.dispatch.request_digest.clone(),
        after_seq,
    }
}
fn settled(state: RequestState) -> bool {
    matches!(
        state,
        RequestState::Completed
            | RequestState::Failed
            | RequestState::Cancelled
            | RequestState::Unknown
    )
}

impl Core {
    pub(super) async fn handle_workspace_rpc_operation(
        &self,
        authenticated: &AuthenticatedTeamToolRun,
        operation: &str,
        input: &Value,
        runtime_tool_call_id: &str,
    ) -> anyhow::Result<Value> {
        self.workspace_rpc_operation(authenticated, operation, input, runtime_tool_call_id)
            .await
            .map_err(error)
    }

    async fn workspace_rpc_page(
        &self,
        authenticated: &AuthenticatedTeamToolRun,
        id: &str,
        after: u64,
        limit: usize,
    ) -> Result<ReplayResponse, RpcErrorCode> {
        let mut database = self.database.lock().await;
        let status = WorkspaceRpcStore::trusted_status(database.connection(), id)?;
        let (principal, grant) = resolve_workspace_authority(
            database.connection(),
            authenticated,
            &status.dispatch.request.workspace_id,
            None,
        )?;
        if grant.owner_node_id != status.dispatch.owner_node_id
            || grant.policy_revision != status.dispatch.policy_revision
        {
            return Err(RpcErrorCode::PolicyMismatch);
        }
        WorkspaceRpcStore::replay(database.connection_mut(), &principal, id, after, limit)
    }

    async fn workspace_rpc_operation(
        &self,
        authenticated: &AuthenticatedTeamToolRun,
        operation: &str,
        input: &Value,
        call_id: &str,
    ) -> Result<Value, RpcErrorCode> {
        // Cached status remains readable when no transport is online. New
        // requests still fail closed through the grant's missing generation.
        let transport = self.remote_runtime_services.workspace_transport().ok();
        match operation {
            "loom.workspace.poll" => {
                let input: PollInput = decode(input)?;
                validate_control_id(&input.request_id)?;
                let first = self
                    .workspace_rpc_page(
                        authenticated,
                        &input.request_id,
                        input.after_seq,
                        input.limit,
                    )
                    .await?;
                let mut delivery_error = None;
                if !settled(first.status.state) || first.status.state == RequestState::Unknown {
                    delivery_error = match transport.as_ref() {
                        None => Some(RpcErrorCode::NodeOffline),
                        Some(transport) => match transport
                            .connection_generation(first.status.dispatch.owner_node_id.clone())
                            .await
                        {
                            Ok(Some(generation)) => transport
                                .replay(
                                    first.status.dispatch.owner_node_id.clone(),
                                    generation,
                                    control_replay(&first, first.status.last_seq),
                                )
                                .await
                                .err(),
                            Ok(None) => Some(RpcErrorCode::NodeOffline),
                            Err(code) => Some(code),
                        },
                    };
                }
                let mut result = self
                    .workspace_rpc_wait(
                        authenticated,
                        &input.request_id,
                        input.after_seq,
                        input.limit,
                        Duration::from_millis(150),
                    )
                    .await?;
                if let Some(code) = delivery_error {
                    result["deliveryError"] = json!(code.code());
                }
                Ok(result)
            }
            "loom.workspace.cancel" => {
                let input: CancelInput = decode(input)?;
                validate_control_id(&input.request_id)?;
                let first = self
                    .workspace_rpc_page(authenticated, &input.request_id, 0, 256)
                    .await?;
                let outcome = {
                    let mut database = self.database.lock().await;
                    let (principal, _) = resolve_workspace_authority(
                        database.connection(),
                        authenticated,
                        &first.status.dispatch.request.workspace_id,
                        None,
                    )?;
                    WorkspaceRpcStore::cancel(
                        database.connection_mut(),
                        &principal,
                        &input.request_id,
                        CancelCause::User,
                        now_ms(),
                    )?
                };
                let mut delivery_error = None;
                if let CancelOutcome::Forward(cancel) = outcome {
                    delivery_error = match transport.as_ref() {
                        None => Some(RpcErrorCode::NodeOffline),
                        Some(transport) => match transport
                            .connection_generation(first.status.dispatch.owner_node_id.clone())
                            .await
                        {
                            Ok(Some(generation)) => transport
                                .cancel(
                                    first.status.dispatch.owner_node_id.clone(),
                                    generation,
                                    cancel,
                                )
                                .await
                                .err(),
                            Ok(None) => Some(RpcErrorCode::NodeOffline),
                            Err(code) => Some(code),
                        },
                    };
                }
                let mut result = self
                    .workspace_rpc_wait(
                        authenticated,
                        &input.request_id,
                        0,
                        256,
                        Duration::from_secs(2),
                    )
                    .await?;
                if let Some(code) = delivery_error {
                    result["deliveryError"] = json!(code.code());
                }
                Ok(result)
            }
            "loom.workspace.list" | "loom.workspace.read" | "loom.workspace.write"
            | "loom.workspace.run" => {
                let request = build_request(authenticated, operation, input, call_id)?;
                let owner = {
                    let database = self.database.lock().await;
                    resolve_workspace_authority(
                        database.connection(),
                        authenticated,
                        &request.workspace_id,
                        None,
                    )?
                    .1
                    .owner_node_id
                };
                let generation = match transport.as_ref() {
                    Some(transport) => transport.connection_generation(owner.clone()).await?,
                    None => None,
                };
                let admission = {
                    let mut database = self.database.lock().await;
                    let (principal, grant) = resolve_workspace_authority(
                        database.connection(),
                        authenticated,
                        &request.workspace_id,
                        generation,
                    )?;
                    if grant.owner_node_id != owner {
                        return Err(RpcErrorCode::PolicyMismatch);
                    }
                    WorkspaceRpcStore::admit(
                        database.connection_mut(),
                        &principal,
                        &grant,
                        request.clone(),
                        now_ms(),
                    )?
                };
                let mut delivery_error = None;
                if let Admission::Dispatch(dispatch) = admission {
                    let Some(transport) = transport.as_ref() else {
                        return Err(RpcErrorCode::NodeOffline);
                    };
                    let Some(generation) = generation else {
                        return Err(RpcErrorCode::NodeOffline);
                    };
                    if let Err(code) = transport.submit(dispatch.clone(), generation).await {
                        delivery_error = Some(code);
                        // Prepare/admission failure before MarkDispatched is
                        // known unsent. A delivered/unknown request is retained.
                        let mut database = self.database.lock().await;
                        let status = WorkspaceRpcStore::trusted_status(
                            database.connection(),
                            &request.request_id,
                        )?;
                        if status.state == RequestState::Queued {
                            WorkspaceRpcStore::cancel(
                                database.connection_mut(),
                                &TrustedPrincipal::AgentRun(dispatch.scope),
                                &request.request_id,
                                CancelCause::User,
                                now_ms(),
                            )?;
                        }
                    }
                }
                let mut result = self
                    .workspace_rpc_wait(
                        authenticated,
                        &request.request_id,
                        0,
                        256,
                        Duration::from_secs(2),
                    )
                    .await?;
                if let Some(code) = delivery_error {
                    result["deliveryError"] = json!(code.code());
                }
                Ok(result)
            }
            _ => Err(RpcErrorCode::InvalidRequest),
        }
    }

    /// Archive only an authorized complete journal snapshot. No DB mutex is
    /// held during private filesystem work, and authority is rechecked afterward.
    async fn workspace_rpc_archive_page(
        &self,
        authenticated: &AuthenticatedTeamToolRun,
        page: ReplayResponse,
        after: u64,
        limit: usize,
    ) -> Result<ReplayResponse, RpcErrorCode> {
        if page.status.state != RequestState::Completed {
            return Ok(page);
        }
        let id = page.status.request_id.clone();
        let snapshot = {
            let mut database = self.database.lock().await;
            let (principal, grant) = resolve_workspace_authority(
                database.connection(),
                authenticated,
                &page.status.dispatch.request.workspace_id,
                None,
            )?;
            if grant.owner_node_id != page.status.dispatch.owner_node_id
                || grant.policy_revision != page.status.dispatch.policy_revision
            {
                return Err(RpcErrorCode::PolicyMismatch);
            }
            WorkspaceRpcStore::archive_snapshot(database.connection_mut(), &principal, &id)?
        };
        let expected_previous = snapshot.status.archives.clone();
        let trusted_data_dir = self.data_dir.clone();
        let dispatch = snapshot.status.dispatch.clone();
        let verified = tokio::task::spawn_blocking(move || {
            archive_completed_results(&trusted_data_dir, &dispatch, &snapshot.events)
        })
        .await
        .map_err(|_| RpcErrorCode::StorageUnavailable)??;
        {
            let mut database = self.database.lock().await;
            let (principal, grant) = resolve_workspace_authority(
                database.connection(),
                authenticated,
                &page.status.dispatch.request.workspace_id,
                None,
            )?;
            if grant.owner_node_id != page.status.dispatch.owner_node_id
                || grant.policy_revision != page.status.dispatch.policy_revision
            {
                return Err(RpcErrorCode::PolicyMismatch);
            }
            WorkspaceRpcStore::publish_archives(
                database.connection_mut(),
                &principal,
                &id,
                &expected_previous,
                &verified,
                now_ms(),
            )?;
        }
        self.workspace_rpc_page(authenticated, &id, after, limit)
            .await
    }

    /// Internal sibling adapter for remote loom.evidence: real dispatch, exact
    /// current owner, complete bytes and a Core archive receipt. The caller must
    /// register an archive locator, never reinterpret B's path as a local path.
    pub(super) async fn workspace_rpc_read_archive(
        &self,
        authenticated: &AuthenticatedTeamToolRun,
        workspace_id: &str,
        relative_path: &str,
        original_call_id: &str,
    ) -> Result<(WorkspaceDispatch, WorkspaceArchiveReceipt), RpcErrorCode> {
        let input = json!({"workspaceId":workspace_id,"path":relative_path,"offset":0,
            "maxBytes":MAX_READ_BYTES,"timeoutMs":30_000});
        let request = build_request(
            authenticated,
            "loom.workspace.read",
            &input,
            original_call_id,
        )?;
        // Invoke the same dispatch/authorization implementation; do not parse
        // the public JSON projection to recover a trusted receipt.
        self.workspace_rpc_operation(
            authenticated,
            "loom.workspace.read",
            &input,
            original_call_id,
        )
        .await?;
        let wait_until = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let page = self
                .workspace_rpc_page(authenticated, &request.request_id, 0, 256)
                .await?;
            match page.status.state {
                RequestState::Completed => {
                    let page = self
                        .workspace_rpc_archive_page(authenticated, page, 0, 256)
                        .await?;
                    let receipt = page
                        .status
                        .archives
                        .iter()
                        .find(|r| r.kind == WorkspaceArchiveKind::Read && !r.truncated)
                        .cloned()
                        .ok_or(RpcErrorCode::OutputLimit)?;
                    return Ok((page.status.dispatch, receipt));
                }
                RequestState::Unknown => return Err(RpcErrorCode::UnknownOutcome),
                RequestState::Failed => return Err(RpcErrorCode::InvalidRequest),
                RequestState::Cancelled => return Err(RpcErrorCode::Cancelled),
                _ => {}
            }
            if now_ms() >= page.status.dispatch.deadline_unix_ms
                || tokio::time::Instant::now() >= wait_until
            {
                return Err(RpcErrorCode::DeadlineExceeded);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn workspace_rpc_wait(
        &self,
        authenticated: &AuthenticatedTeamToolRun,
        id: &str,
        after: u64,
        limit: usize,
        budget: Duration,
    ) -> Result<Value, RpcErrorCode> {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let page = self
                .workspace_rpc_page(authenticated, id, after, limit)
                .await?;
            if settled(page.status.state) || tokio::time::Instant::now() >= deadline {
                let page = self
                    .workspace_rpc_archive_page(authenticated, page, after, limit)
                    .await?;
                return render_page(page, after);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Tool responses preserve bounded bytes without duplicating a 1 MiB read as
/// both base64 and text. The wire/journal remain the lossless typed protocol.
fn encoded(data: &str) -> Result<Value, RpcErrorCode> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(json!({"encoding":"utf8","text":text})),
        Err(_) => Ok(json!({"encoding":"base64","data":data})),
    }
}
fn render_page(page: ReplayResponse, after: u64) -> Result<Value, RpcErrorCode> {
    let mut events = Vec::with_capacity(page.events.len());
    for event in &page.events {
        let body = match &event.body {
            WorkspaceEventBody::Output { stream, data } => {
                let mut body = encoded(data)?;
                body["kind"] = json!("output");
                body["stream"] = json!(stream);
                body
            }
            WorkspaceEventBody::Completed {
                result:
                    WorkspaceResult::Read {
                        data,
                        offset,
                        truncated,
                    },
            } => {
                let mut result = encoded(data)?;
                result["kind"] = json!("read");
                result["offset"] = json!(offset);
                result["truncated"] = json!(truncated);
                json!({"kind":"completed","result":result})
            }
            body => serde_json::to_value(body).map_err(|_| RpcErrorCode::StorageUnavailable)?,
        };
        events.push(json!({"seq":event.seq,"body":body}));
    }
    let cursor = page.events.last().map(|e| e.seq).unwrap_or(after);
    Ok(
        json!({"requestId":page.status.request_id,"state":page.status.state,
        "runId":page.status.dispatch.scope.run_id,"sessionId":page.status.dispatch.scope.session_id,
        "attempt":page.status.dispatch.scope.attempt,"deadlineUnixMs":page.status.dispatch.deadline_unix_ms,
        "lastSeq":page.status.last_seq,"nextAfterSeq":cursor,"hasMore":cursor<page.status.last_seq,
        "outputBytes":page.status.output_bytes,"omittedBytes":page.status.omitted_bytes,
        "archives":page.status.archives,"events":events}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_payload_cannot_choose_identity_and_call_ids_are_scoped_stably() {
        let auth = AuthenticatedTeamToolRun {
            camp_id: "camp".into(),
            agent_id: "member".into(),
            agent_run_id: "run".into(),
            execution_epoch: 7,
        };
        let input = json!({"workspaceId":"workspace","path":"data.txt"});
        let a = build_request(&auth, "loom.workspace.read", &input, "call").unwrap();
        assert_eq!(
            a,
            build_request(&auth, "loom.workspace.read", &input, "call").unwrap()
        );
        let mut foreign = input.clone();
        foreign["memberId"] = json!("foreign");
        assert_eq!(
            build_request(&auth, "loom.workspace.read", &foreign, "call").err(),
            Some(RpcErrorCode::InvalidRequest)
        );
        let mut other = auth.clone();
        other.execution_epoch = 8;
        assert_ne!(
            a.request_id,
            build_request(&other, "loom.workspace.read", &input, "call")
                .unwrap()
                .request_id
        );
        assert!(a.request_id.len() < 128);
        validate_control_id(&a.request_id).unwrap();
        assert_eq!(
            validate_control_id("wrpc_incomplete").err(),
            Some(RpcErrorCode::InvalidRequest)
        );
        assert_eq!(
            validate_control_id(&format!("wrpc_{}", "A".repeat(64))).err(),
            Some(RpcErrorCode::InvalidRequest)
        );
        let explicit = json!({"workspaceId":"workspace","path":"data.txt","requestId":"6e71a1b4-6b19-4f86-8c18-988552586a37"});
        let first = build_request(&auth, "loom.workspace.read", &explicit, "transport-a").unwrap();
        let retry = build_request(&auth, "loom.workspace.read", &explicit, "transport-b").unwrap();
        assert_eq!(first, retry);
        let invalid = json!({"workspaceId":"workspace","requestId":"not-a-uuid"});
        assert_eq!(
            build_request(&auth, "loom.workspace.list", &invalid, "call").err(),
            Some(RpcErrorCode::InvalidRequest)
        );
    }
}
