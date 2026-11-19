//! Closed command definitions shared by bundle admission and native trust matching.
//! This module grants no authority: only Core's frozen member review can do that.
use crate::run_bundle::{BundleArtifact, RunBundleV1};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

pub const CODEX_HOOK_GRANT_VERSION: u32 = 1;
pub const CODEX_HOOK_PIPE_VERSION: u32 = 2;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexHookGrantV1 {
    pub version: u32,
    pub settings_digest: String,
    pub review_digest: String,
}
impl std::fmt::Debug for CodexHookGrantV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexHookGrantV1")
            .field("version", &self.version)
            .field("settings_digest", &self.settings_digest)
            .finish_non_exhaustive()
    }
}
impl CodexHookGrantV1 {
    pub fn validate(&self, bundle: &RunBundleV1) -> Result<(), &'static str> {
        if self.version != CODEX_HOOK_GRANT_VERSION
            || !valid_digest(&self.settings_digest)
            || !valid_digest(&self.review_digest)
        {
            return Err("bundle_hook_grant_invalid");
        }
        if crate::run_bundle::canonical_adapter_kind(&bundle.adapter_kind) != Some("codex-cli") {
            return Err("bundle_hook_grant_adapter");
        }
        let (bytes, settings) = settings(bundle)?.ok_or("bundle_hook_grant_missing_settings")?;
        if digest(&bytes) != self.settings_digest {
            return Err("bundle_hook_grant_settings");
        }
        parse(&settings, true)?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct CommandHook {
    pub event: String,
    pub group_index: usize,
    pub handler_index: usize,
    pub matcher: Option<String>,
    pub command: String,
    pub command_windows: Option<String>,
    pub timeout: Option<Number>,
}
impl CommandHook {
    pub fn effective_command(&self, windows: bool) -> &str {
        if windows {
            self.command_windows.as_deref().unwrap_or(&self.command)
        } else {
            &self.command
        }
    }
    pub fn native_event(&self) -> &'static str {
        match self.event.as_str() {
            "PreToolUse" => "preToolUse",
            "PostToolUse" => "postToolUse",
            "Stop" => "stop",
            "SessionStart" => "sessionStart",
            "SessionEnd" => "sessionEnd",
            _ => unreachable!("closed hook event"),
        }
    }
    pub fn key_suffix(&self) -> String {
        let event = match self.event.as_str() {
            "PreToolUse" => "pre_tool_use",
            "PostToolUse" => "post_tool_use",
            "Stop" => "stop",
            "SessionStart" => "session_start",
            "SessionEnd" => "session_end",
            _ => unreachable!("closed hook event"),
        };
        format!(":{event}:{}:{}", self.group_index, self.handler_index)
    }
}

pub fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}
pub fn settings(bundle: &RunBundleV1) -> Result<Option<(Vec<u8>, Value)>, &'static str> {
    let mut files = bundle
        .files
        .iter()
        .filter(|f| f.artifact == BundleArtifact::RuntimeSettings);
    let Some(file) = files.next() else {
        return Ok(None);
    };
    if files.next().is_some() {
        return Err("bundle_hook_settings_duplicate");
    }
    let bytes =
        crate::run_bundle::decode_file(file).map_err(|_| "bundle_hook_settings_encoding")?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "bundle_hook_settings_json")?;
    Ok(Some((bytes, value)))
}

/// No hooks.state, async command, managed label or policy flag is accepted.
/// Existing bundle event subset and timeout limits are retained.
pub fn parse(value: &Value, codex: bool) -> Result<Vec<CommandHook>, &'static str> {
    let object = value.as_object().ok_or("bundle_hook_settings_object")?;
    if object.len() != 1 || !object.contains_key("hooks") {
        return Err("bundle_hook_settings_keys");
    }
    let events = object["hooks"]
        .as_object()
        .ok_or("bundle_hook_events_object")?;
    if events.is_empty() {
        return Err("bundle_hook_events_empty");
    }
    let mut result = Vec::new();
    for (event, groups) in events {
        if !matches!(
            event.as_str(),
            "PreToolUse" | "PostToolUse" | "Stop" | "SessionStart" | "SessionEnd"
        ) {
            return Err("bundle_hook_event_unsupported");
        }
        let groups = groups
            .as_array()
            .filter(|x| !x.is_empty())
            .ok_or("bundle_hook_groups")?;
        for (group_index, group) in groups.iter().enumerate() {
            let group = group.as_object().ok_or("bundle_hook_group")?;
            if group
                .keys()
                .any(|k| !matches!(k.as_str(), "matcher" | "hooks"))
            {
                return Err("bundle_hook_group_keys");
            }
            let matcher = group
                .get("matcher")
                .map(|v| {
                    v.as_str()
                        .filter(|s| !s.chars().any(char::is_control))
                        .map(str::to_owned)
                        .ok_or("bundle_hook_matcher")
                })
                .transpose()?;
            let handlers = group
                .get("hooks")
                .and_then(Value::as_array)
                .filter(|x| !x.is_empty())
                .ok_or("bundle_hook_handlers")?;
            for (handler_index, handler) in handlers.iter().enumerate() {
                let handler = handler.as_object().ok_or("bundle_hook_handler")?;
                if handler.keys().any(|k| {
                    !matches!(k.as_str(), "type" | "command" | "timeout")
                        && !(codex && k == "commandWindows")
                }) {
                    return Err("bundle_hook_handler_keys");
                }
                if handler.get("type").and_then(Value::as_str) != Some("command") {
                    return Err("bundle_hook_handler_type");
                }
                let command = command_text(handler.get("command"))?.to_owned();
                let command_windows = handler
                    .get("commandWindows")
                    .map(|v| command_text(Some(v)).map(str::to_owned))
                    .transpose()?;
                let timeout = handler
                    .get("timeout")
                    .map(|v| {
                        let n = v.as_number().ok_or("bundle_hook_timeout")?;
                        let seconds = n
                            .as_f64()
                            .filter(|x| x.is_finite() && *x > 0.0 && *x <= 600.0)
                            .ok_or("bundle_hook_timeout")?;
                        if codex && event == "SessionEnd" && seconds > 3.0 {
                            return Err("bundle_hook_timeout");
                        }
                        Ok(n.clone())
                    })
                    .transpose()?;
                result.push(CommandHook {
                    event: event.clone(),
                    group_index,
                    handler_index,
                    matcher: matcher.clone(),
                    command,
                    command_windows,
                    timeout,
                });
            }
        }
    }
    Ok(result)
}
fn command_text(value: Option<&Value>) -> Result<&str, &'static str> {
    value
        .and_then(Value::as_str)
        .filter(|s| {
            !s.trim().is_empty() && !s.chars().any(char::is_control) && !s.contains("********")
        })
        .ok_or("bundle_hook_command")
}
