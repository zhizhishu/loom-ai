//! Trusted Hub-to-Core Built-in Tool bridge.
//! Hub proves the Node IPC credential, process key and monotonic owner binding;
//! Core resolves the current lease and never accepts Core credentials from Node.

use super::*;
use crate::{
    remote_process::RemoteProcessError,
    remote_runtime_services::{RemoteBuiltinFuture, RemoteBuiltinHandler, RemoteBuiltinInvocation},
};

impl RemoteBuiltinHandler for Core {
    fn invoke(&self, request: RemoteBuiltinInvocation) -> RemoteBuiltinFuture<'_> {
        Box::pin(async move {
            let guard = self.builtin_tool_leases.invocation_guard().await;
            {
                let database = self.database.lock().await;
                crate::remote_execution::validate_running_owner(
                    database.connection(),
                    &request.process,
                    &request.owner,
                )
                .map_err(|_| RemoteProcessError::IdentityMismatch)?;
            }
            let auth = self
                .builtin_tool_leases
                .auth_for_remote_execution(&request.process, &request.owner)
                .await
                .map_err(|_| RemoteProcessError::IdentityMismatch)?;
            drop(guard);
            // The native CLI supplies a Node-relative artifact path. Never pass
            // it through A's local-file registration path before bytes have
            // crossed the bounded workspace transport and been archived.
            let BuiltinToolIpcRequestBody::Invoke {
                operation, input, ..
            } = &request.body;
            let operation = crate::thread_compat::canonical_operation(operation).to_string();
            let has_input_file = matches!(operation.as_str(), "member.create" | "member.update")
                && input
                    .get("avatarFile")
                    .is_some_and(|value| !value.is_null());
            let has_attachments = operation == "thread.message.send"
                && input.get("files").is_some_and(|value| {
                    !value.is_null() && !value.as_array().is_some_and(|files| files.is_empty())
                });
            if has_input_file || has_attachments {
                return Ok(BuiltinToolIpcResponse::ipc_error(
                    "remote_file_transfer_required",
                    "Remote files require an owner-bound byte transfer before this operation",
                ));
            }
            // The CLI already parsed the input file on B. This transport's key
            // and owner identify its origin; a B path is not an A filesystem ref.
            let mut body = request.body;
            let BuiltinToolIpcRequestBody::Invoke {
                send_input_file_path,
                ..
            } = &mut body;
            *send_input_file_path = None;
            let mut response = self
                .handle_builtin_tool_ipc(BuiltinToolIpcRequest {
                    ipc_protocol_version: BUILTIN_TOOL_IPC_PROTOCOL_VERSION,
                    auth,
                    body,
                })
                .await;
            // member.get is read-only. Its existing contract explicitly permits
            // an unavailable avatar; never advertise A's private file as B's.
            if operation == "member.get" {
                if let BuiltinToolIpcResponse::Envelope { envelope } = &mut response {
                    if let Some(result) = envelope.result.as_mut() {
                        if result
                            .get("avatar")
                            .and_then(|avatar| avatar.get("status"))
                            .and_then(Value::as_str)
                            == Some("available")
                        {
                            result["avatar"] =
                                json!({"path": null, "status": "unavailable", "displayCrop": null});
                        }
                    }
                }
            }
            Ok(response)
        })
    }
}

// These helpers are used by the existing App scheduler/native adapter path;
// they never create a substitute AgentRun or export an A-side credential.
impl Core {
    pub(super) async fn register_remote_loom_evidence(
        &self,
        authenticated: &crate::team_tool::AuthenticatedTeamToolRun,
        prepared: crate::loom::remote_artifact::PreparedRemoteArtifact,
        call_id: &str,
    ) -> Result<Value> {
        let (dispatch,receipt) = self.workspace_rpc_read_archive(
            authenticated,prepared.workspace_id(),prepared.relative_path(),call_id,
        ).await.map_err(|error| BuiltinOperationError {
            code:"loom.evidence_unreadable".into(),
            message:format!("Remote evidence was not archived as a complete file of at most 1 MiB: {error:?}"),
            details:Some(json!({"workspaceError":error})),
        })?;
        let previous = {
            let database = self.database.lock().await;
            crate::loom::remote_artifact::registration_snapshot(
                database.connection(), authenticated, &prepared, &receipt.sha256,
            )?
        };
        let data_dir = self.data_dir.clone();
        let verified = tokio::task::spawn_blocking(move || {
            crate::loom::remote_artifact::verify_registration(
                &data_dir, dispatch, receipt, previous,
            )
        })
        .await
        .context("remote evidence archive verification task failed")??;
        let mut database = self.database.lock().await;
        let result = crate::loom::remote_artifact::register(
            &mut database,
            authenticated,
            prepared,
            verified,
        )?;
        Ok(serde_json::to_value(result)?)
    }

    pub(super) async fn remote_run_target(
        &self,
        agent_run_id: &str,
    ) -> Result<Option<crate::remote_execution::FrozenRunTarget>> {
        let database = self.database.lock().await;
        let connection = database.connection();
        if !crate::remote_execution::authority_table_available(
            connection,
            "agent_run_execution_target",
        )? {
            return Ok(None);
        }
        let target = crate::remote_execution::revalidate_run_claim(connection, agent_run_id)?;
        use rusqlite::OptionalExtension;
        let installation: Option<String> = connection
            .query_row(
                "SELECT runtime_installation_id FROM agent_run WHERE id=?1",
                [agent_run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let remote_installation = installation
            .as_deref()
            .map(|id| crate::remote_execution::is_remote_installation(connection, id))
            .transpose()?
            .unwrap_or(false);
        anyhow::ensure!(
            target.is_some() == remote_installation,
            "remote_target_real_binding_required"
        );
        Ok(target)
    }

    pub(super) fn prepare_remote_builtin_process(
        &self,
        node_id: &str,
    ) -> Result<BuiltinToolProcessConfig> {
        let key = crate::remote_process::RemoteProcessKey {
            node_id: node_id.to_string(),
            process_id: uuid::Uuid::new_v4().to_string(),
            // New opaque IDs always begin their own process lifetime at epoch 1.
            process_epoch: 1,
        };
        BuiltinToolProcessConfigFactory::remote(
            &builtin_tool_endpoint(),
            &self.data_dir.join("runtime"),
            key,
        )?
        .create()
    }

    pub(super) async fn prepare_remote_mcp_projection(
        &self,
        execution: &AgentRunExecution,
    ) -> Result<PreparedMcpProjection> {
        let database = self.database.lock().await;
        let source = crate::remote_bundle_owner::load_run_source(
            database.connection(),
            &execution.agent_run_id,
        )?
        .context("remote_bundle_source_required")?;
        source.prepared_mcp_projection()
    }

    /// A remote compatibility identity contains no A-local filesystem state.
    /// A different Run can reuse a Host only while its frozen source and policy
    /// stay identical; per-Run bundle IDs are deliberately not Host identities.
    pub(super) fn remote_codex_runtime_compatibility_digest(
        &self,
        execution: &AgentRunExecution,
        target: &crate::remote_execution::FrozenRunTarget,
        has_references: bool,
    ) -> Result<String> {
        use sha2::{Digest, Sha256};
        anyhow::ensure!(
            target.member_id == execution.agent_id
                && target.conversation_id == execution.conversation_id
                && target.installation_id == execution.runtime.installation_id
                && target.selection.adapter_kind == AdapterKind::CodexCli
                && execution.runtime.environment.is_none()
                && execution.runtime.custom_api.is_none()
                && !target.bundle_source_digest.is_empty(),
            "remote_codex_compatibility_scope"
        );
        target.target.validate()?;
        let mut compatibility = json!({
            "schemaVersion": 3,
            "nativeAutoMemoryPolicy": "disabled-v1",
            "adapterKind": execution.runtime.adapter_kind,
            "memberId": execution.agent_id,
            "conversationId": execution.conversation_id,
            "installationId": execution.runtime.installation_id,
            "installationGeneration": execution.runtime.installation_generation,
            "bindingCompatibilityDigest": execution.runtime.binding_compatibility_digest,
            "hostConfigDigest": execution.runtime.host_config_digest,
            "frozenTarget": target.target,
            "bundleSourceDigest": target.bundle_source_digest,
            "builtinToolContractVersion": crate::builtin_tool_transport::BUILTIN_TOOL_CONTRACT_VERSION,
        });
        // Only a Run that resolves its own credential references needs a process
        // whose environment was prepared for it. A reference-free Run keeps the
        // established identity and its warm-Host reuse, byte for byte.
        if has_references {
            compatibility["referenceRunId"] = json!(execution.agent_run_id);
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&compatibility)?)
        ))
    }

    pub(super) async fn prepare_remote_run_launch(
        &self,
        execution: &AgentRunExecution,
        builtin: &BuiltinToolProcessConfig,
        credential: &BuiltinToolBindingCredential,
        bootstrap: &str,
    ) -> Result<crate::runtime_process::RemoteRuntimeLaunch> {
        use crate::remote_process::{
            AgentRunOwner, NonSecretEnvironment, RemoteHostScope, ScopedRemoteLaunch,
        };
        let key = builtin
            .remote_process_key()
            .context("remote_builtin_process_required")?
            .clone();
        let owner = AgentRunOwner {
            agent_run_id: execution.agent_run_id.clone(),
            execution_epoch: u64::try_from(execution.execution_epoch)
                .context("remote_owner_epoch")?,
        };
        owner.validate()?;
        let launcher = self.remote_runtime_services.launcher()?;
        let database = self.database.lock().await;
        let tx = rusqlite::Transaction::new_unchecked(
            database.connection(),
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let target = crate::remote_execution::validate_running_owner(&tx, &key, &owner)?;
        anyhow::ensure!(
            target.installation_id == execution.runtime.installation_id
                && target.member_id == execution.agent_id
                && target.conversation_id == execution.conversation_id
                && credential.adapter_installation_id == execution.runtime.installation_id
                && !credential.native_binding_id.trim().is_empty(),
            "remote_run_scope"
        );
        let source = crate::remote_bundle_owner::load_run_source(&tx, &execution.agent_run_id)?
            .context("remote_bundle_source_required")?;
        // A warm native Host may serve a later real Run, but its process identity
        // never crosses member/conversation/workspace/source/configuration scope.
        let incompatible: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_run_remote_process p
             JOIN agent_run_execution_target t ON t.agent_run_id=p.agent_run_id
             WHERE p.node_id=?1 AND p.process_id=?2 AND p.process_epoch=?3 AND
              (p.logical_session_id<>?4 OR p.source_digest<>?5 OR p.configuration_digest<>?6
               OR t.member_id<>?7 OR t.conversation_id<>?4 OR t.camp_id<>?8))",
            rusqlite::params![
                key.node_id,
                key.process_id,
                i64::try_from(key.process_epoch)?,
                execution.conversation_id,
                target.bundle_source_digest,
                target.target.configuration_digest,
                execution.agent_id,
                execution.camp_id
            ],
            |row| row.get(0),
        )?;
        anyhow::ensure!(!incompatible, "remote_process_preparation_scope");
        let previous = tx
            .query_row(
                "SELECT bundle_attempt,bundle_digest FROM agent_run_remote_process
             WHERE node_id=?1 AND process_id=?2 AND process_epoch=?3
               AND agent_run_id=?4 AND execution_epoch=?5",
                rusqlite::params![
                    key.node_id,
                    key.process_id,
                    i64::try_from(key.process_epoch)?,
                    owner.agent_run_id,
                    execution.execution_epoch
                ],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let next = match &previous {
            Some((attempt,_)) => *attempt,
            None => tx.query_row(
                "SELECT COALESCE(MAX(bundle_attempt),0)+1 FROM agent_run_remote_process WHERE agent_run_id=?1",
                [&execution.agent_run_id], |row| row.get::<_, i64>(0),
            )?,
        };
        let attempt = u32::try_from(next).context("remote_bundle_attempt_overflow")?;
        let frozen = source.bind_real_run(
            &execution.agent_run_id,
            owner.execution_epoch,
            attempt,
            bootstrap,
        )?;
        if let Some((_, digest)) = &previous {
            anyhow::ensure!(
                *digest == frozen.bundle.digest,
                "remote_process_preparation_conflict"
            );
        }
        let launch = ScopedRemoteLaunch {
            key: key.clone(),
            initial_owner: owner.clone(),
            builtin_tasks_enabled: builtin.tasks_enabled(),
            host_scope: RemoteHostScope {
                member_id: execution.agent_id.clone(),
                logical_session_id: execution.conversation_id.clone(),
                workspace_id: target.target.workspace_id.clone(),
            },
            target: target.target.clone(),
            arguments: Vec::new(),
            environment: NonSecretEnvironment::default(),
            codex_hook_grant: source.codex_hook_grant(&frozen.bundle)?,
            bundle: Some(frozen.bundle.clone()),
        };
        launch.validate()?;
        // This proves preparation only. Native accepted/terminal remain owned
        // by the existing adapter and Core event settlement, never by this row.
        if previous.is_none() {
            tx.execute(
                "INSERT INTO agent_run_remote_process(
                node_id,process_id,process_epoch,agent_run_id,execution_epoch,logical_session_id,
                bundle_attempt,source_digest,bundle_digest,bundle_json,manifest_json,
                configuration_digest,prepared_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                rusqlite::params![
                    key.node_id,
                    key.process_id,
                    i64::try_from(key.process_epoch)?,
                    owner.agent_run_id,
                    execution.execution_epoch,
                    execution.conversation_id,
                    i64::from(attempt),
                    target.bundle_source_digest,
                    frozen.bundle.digest,
                    serde_json::to_string(&frozen.bundle)?,
                    serde_json::to_string(&frozen.manifest)?,
                    target.target.configuration_digest,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(crate::runtime_process::RemoteRuntimeLaunch {
            launcher,
            frozen: launch,
            startup_budget: Duration::from_secs(60),
            builtin: builtin.clone(),
        })
    }
}
