//! Remote launch arguments for the existing Claude stream-json driver.
//! This module performs no local filesystem, environment, or credential lookup.
use super::{ClaudeCodeRunRequest, claude_model_effort, launch_session_arguments};
use crate::{
    agent_runtime_adapter::CLAUDE_CODE_RUNTIME_DEFAULT_MODEL_ID,
    remote_process::{NonSecretEnvironment, RemoteArgument},
    runtime_process::{RemoteRuntimeLaunch, RuntimeProcess},
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use loom_protocol::run_bundle::BundleArtifact;

pub(super) fn arguments(
    request: &ClaudeCodeRunRequest,
    remote: &RemoteRuntimeLaunch,
    permission_mode: &str,
    native_session_id: &str,
    legacy_read_only: bool,
) -> Result<Vec<RemoteArgument>> {
    let frozen = &remote.frozen;
    ensure!(
        frozen.initial_owner.agent_run_id == request.agent_run_id
            && i64::try_from(frozen.initial_owner.execution_epoch).ok()
                == Some(request.execution_epoch)
            && frozen.target.workspace_root == request.workspace.execution_root
            && frozen.target.adapter_kind == "claude-code-cli",
        "remote_claude_run_scope"
    );
    ensure!(
        request.runtime.environment.is_none() && request.runtime.custom_api.is_none(),
        "remote_claude_a_environment_refused"
    );
    ensure!(
        request.attachment_access_root.is_none(),
        "remote_claude_a_attachment_path_refused"
    );
    ensure!(
        request
            .builtin_tools
            .as_ref()
            .is_none_or(|config| config.remote_process_key() == Some(&frozen.key)),
        "remote_claude_builtin_scope"
    );
    let bundle = frozen
        .bundle
        .as_ref()
        .context("remote_claude_bundle_required")?;
    let bootstrap = bundle
        .files
        .iter()
        .find(|file| file.artifact == BundleArtifact::BootstrapPrompt)
        .context("remote_claude_bootstrap_required")?;
    let bootstrap_bytes = STANDARD
        .decode(&bootstrap.content)
        .context("remote_claude_bootstrap_invalid")?;
    let expected = request
        .session_bootstrap
        .as_deref()
        .context("remote_claude_bootstrap_required")?;
    ensure!(
        bootstrap_bytes.starts_with(expected.as_bytes()),
        "remote_claude_bootstrap_mismatch"
    );
    let settings = bundle
        .files
        .iter()
        .find(|file| file.artifact == BundleArtifact::RuntimeSettings)
        .context("remote_claude_policy_settings_required")?;
    let settings_json: serde_json::Value = serde_json::from_slice(
        &STANDARD
            .decode(&settings.content)
            .context("remote_claude_settings_invalid")?,
    )
    .context("remote_claude_settings_invalid")?;
    for flag in [
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
    ] {
        ensure!(
            settings_json
                .get("env")
                .and_then(|env| env.get(flag))
                .and_then(|value| value.as_str())
                == Some("1"),
            "remote_claude_managed_policy_missing"
        );
    }
    let mut values = vec![
        "--print".to_string(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--replay-user-messages".into(),
        "--permission-mode".into(),
        permission_mode.into(),
    ];
    if permission_mode == "bypassPermissions" {
        values.push("--dangerously-skip-permissions".into());
    }
    let disallowed = if legacy_read_only {
        "Edit,Write,NotebookEdit,AskUserQuestion"
    } else {
        "AskUserQuestion"
    };
    values.push(format!("--disallowedTools={disallowed}"));
    if request.runtime.model.source == "explicit"
        && request.runtime.model.model_id != CLAUDE_CODE_RUNTIME_DEFAULT_MODEL_ID
    {
        values.extend(["--model".into(), request.runtime.model.model_id.clone()]);
    }
    if let Some(effort) = claude_model_effort(&request.runtime.model.options)? {
        values.extend(["--effort".into(), effort.to_string()]);
    }
    values.extend(launch_session_arguments(
        request.resumable_native_session_id.as_deref(),
        native_session_id,
        None,
        None,
    )?);
    if !request.persist_session {
        values.extend(["--no-session-persistence".into(), "--tools=".into()]);
    }
    let mut arguments = values
        .into_iter()
        .map(|value| RemoteArgument::Literal { value })
        .collect::<Vec<_>>();
    for (flag, file) in [
        ("--append-system-prompt-file", bootstrap),
        ("--settings", settings),
    ] {
        arguments.push(RemoteArgument::Literal { value: flag.into() });
        arguments.push(RemoteArgument::MaterializedFile {
            path: file.path.clone(),
        });
    }
    if let Some(file) = bundle
        .files
        .iter()
        .find(|file| file.artifact == BundleArtifact::McpConfig)
    {
        arguments.push(RemoteArgument::Literal {
            value: "--mcp-config".into(),
        });
        arguments.push(RemoteArgument::MaterializedFile {
            path: file.path.clone(),
        });
    }
    Ok(arguments)
}

pub(super) async fn spawn(
    request: &ClaudeCodeRunRequest,
    remote: &RemoteRuntimeLaunch,
    permission_mode: &str,
    native_session_id: &str,
    legacy_read_only: bool,
) -> Result<RuntimeProcess> {
    let arguments = arguments(
        request,
        remote,
        permission_mode,
        native_session_id,
        legacy_read_only,
    )?;
    let environment = NonSecretEnvironment::from_flags(
        [
            ("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into()),
            ("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS".into(), "1".into()),
            ("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS".into(), "1".into()),
        ]
        .into(),
    )?;
    remote.spawn(arguments, environment).await
}
