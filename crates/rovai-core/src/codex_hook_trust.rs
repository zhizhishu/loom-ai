//! Thread-local native trust for an already reviewed, immutable command bundle.
//! No configuration write, feature enablement or approval-policy override lives here.
use anyhow::{Context, Result, ensure};
use loom_protocol::{
    command_hooks::{self, CodexHookGrantV1, CommandHook},
    run_bundle::RunBundleV1,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) struct NativeHookTrust {
    cwd: String,
    windows: bool,
    selected: BTreeMap<String, Value>,
    baseline: BTreeMap<String, Value>,
    global_config_digest: String,
    default_model: Option<String>,
    default_provider: Option<String>,
}

impl NativeHookTrust {
    pub(super) fn prepare(
        bundle: &RunBundleV1,
        grant: &CodexHookGrantV1,
        cwd: &str,
        program: &str,
        config: &Value,
        listed: &Value,
    ) -> Result<Self> {
        grant.validate(bundle).map_err(anyhow::Error::msg)?;
        let (_, settings) = command_hooks::settings(bundle)
            .map_err(anyhow::Error::msg)?
            .context("codex_hook_settings_missing")?;
        Self::from_settings(&settings, cwd, program, config, listed)
    }

    fn from_settings(
        settings: &Value,
        cwd: &str,
        program: &str,
        config: &Value,
        listed: &Value,
    ) -> Result<Self> {
        let definitions = command_hooks::parse(settings, true).map_err(anyhow::Error::msg)?;
        ensure!(
            config
                .pointer("/config/features/hooks")
                .and_then(Value::as_bool)
                == Some(true),
            "codex_hook_feature_unavailable"
        );
        let layers = config
            .get("layers")
            .and_then(Value::as_array)
            .context("codex_hook_layers_unavailable")?;
        let mut session_layers = layers.iter().filter(|layer| {
            layer.pointer("/name/type").and_then(Value::as_str) == Some("sessionFlags")
        });
        let session = session_layers
            .next()
            .context("codex_hook_session_layer_missing")?;
        ensure!(
            session_layers.next().is_none(),
            "codex_hook_session_layer_ambiguous"
        );
        ensure!(
            session.get("disabledReason").is_none_or(Value::is_null)
                && session.pointer("/config/hooks") == settings.get("hooks"),
            "codex_hook_session_definition_mismatch"
        );
        // Exact raw layer equality also rejects state, policy and extra definitions.
        // The native effective config may contain the user's state; it is never replaced.
        // Arrays supplied by a -c event may shadow a lower config/profile
        // array. Until native coexistence is proven, refuse this overlap rather
        // than silently dropping a node-owned inline definition. Separate
        // hooks.json sources remain visible in the native list below.
        let profile = nonempty(config.pointer("/config/profile"));
        for layer in layers.iter().filter(|layer| {
            layer.pointer("/name/type").and_then(Value::as_str) != Some("sessionFlags")
                && layer.get("disabledReason").is_none_or(Value::is_null)
        }) {
            let lower = layer.get("config").context("codex_hook_layer_invalid")?;
            let active_profile = profile.and_then(|name| lower.get("profiles")?.get(name));
            for definition in &definitions {
                for node in [Some(lower), active_profile].into_iter().flatten() {
                    let event = node
                        .get("hooks")
                        .and_then(|hooks| hooks.get(&definition.event));
                    ensure!(
                        event.is_none_or(|value| value.as_array().is_some_and(Vec::is_empty)),
                        "codex_hook_layer_conflict"
                    );
                }
            }
        }
        let windows = windows_program(program);
        let baseline = metadata(listed, cwd, windows)?;
        let mut selected = BTreeMap::new();
        for definition in &definitions {
            let matches = baseline
                .iter()
                .filter(|(_, hook)| {
                    hook.get("source").and_then(Value::as_str) == Some("sessionFlags")
                        && hook
                            .get("key")
                            .and_then(Value::as_str)
                            .is_some_and(|key| key.ends_with(&definition.key_suffix()))
                })
                .collect::<Vec<_>>();
            ensure!(matches.len() == 1, "codex_hook_native_definition_ambiguous");
            let (key, hook) = matches[0];
            check_definition(key, hook, definition, windows)?;
            ensure!(
                selected.insert(key.clone(), hook.clone()).is_none(),
                "codex_hook_native_key_duplicate"
            );
        }
        ensure!(
            baseline
                .values()
                .filter(|hook| hook.get("source").and_then(Value::as_str) == Some("sessionFlags"))
                .count()
                == selected.len(),
            "codex_hook_unreviewed_session_definition"
        );
        Ok(Self {
            cwd: cwd.to_owned(),
            windows,
            selected,
            baseline,
            global_config_digest: config_digest(config)?,
            default_model: nonempty(config.pointer("/config/model")).map(str::to_owned),
            default_provider: nonempty(config.pointer("/config/model_provider")).map(str::to_owned),
        })
    }

    pub(super) fn merge_thread_config(&self, current: Option<Value>) -> Result<Value> {
        let mut value = current.unwrap_or_else(|| json!({}));
        let object = value
            .as_object_mut()
            .context("codex_hook_thread_config_invalid")?;
        // The sole existing caller supplies only its finalized MCP projection.
        ensure!(
            object.keys().all(|key| key == "mcp_servers"),
            "codex_hook_thread_config_conflict"
        );
        let state = self
            .selected
            .iter()
            .map(|(key, hook)| (key.clone(), json!({"trusted_hash": hook["currentHash"]})))
            .collect::<serde_json::Map<_, _>>();
        // Native override paths split on dots. Keep opaque native keys in a JSON
        // object at this single path; never concatenate them into another path.
        object.insert("hooks.state".to_owned(), Value::Object(state));
        Ok(value)
    }

    pub(super) fn verify_launch_response(&self, request: &Value, response: &Value) -> Result<()> {
        let actual_cwd = nonempty(response.get("cwd")).context("codex_hook_thread_cwd_missing")?;
        ensure!(
            same_path(&self.cwd, actual_cwd, self.windows),
            "codex_hook_thread_cwd_changed"
        );
        ensure!(
            response.get("approvalPolicy") == request.get("approvalPolicy")
                && response.get("approvalsReviewer") == request.get("approvalsReviewer"),
            "codex_hook_thread_approval_changed"
        );
        let expected_sandbox = match request.get("sandbox").and_then(Value::as_str) {
            Some("read-only") => "readOnly",
            Some("workspace-write") => "workspaceWrite",
            Some("danger-full-access") => "dangerFullAccess",
            _ => anyhow::bail!("codex_hook_thread_sandbox_unsupported"),
        };
        ensure!(
            response.pointer("/sandbox/type").and_then(Value::as_str) == Some(expected_sandbox),
            "codex_hook_thread_sandbox_changed"
        );
        let actual_model =
            nonempty(response.get("model")).context("codex_hook_thread_model_missing")?;
        if let Some(expected) = nonempty(request.get("model")).or(self.default_model.as_deref()) {
            ensure!(actual_model == expected, "codex_hook_thread_model_changed");
        }
        let actual_provider = nonempty(response.get("modelProvider"))
            .context("codex_hook_thread_provider_missing")?;
        if let Some(expected) = self.default_provider.as_deref() {
            ensure!(
                actual_provider == expected,
                "codex_hook_thread_provider_changed"
            );
        }
        // runtime_default is deliberately native when no model/provider was
        // configured. It is not replaced with the metadata fixture's values.
        Ok(())
    }

    pub(super) fn verify_thread_hooks(&self, listed: &Value) -> Result<()> {
        let actual = metadata(listed, &self.cwd, self.windows)?;
        ensure!(
            actual.len() == self.baseline.len(),
            "codex_hook_thread_catalog_changed"
        );
        for (key, original) in &self.baseline {
            let current = actual
                .get(key)
                .context("codex_hook_thread_definition_missing")?;
            let mut expected = original.clone();
            if self.selected.contains_key(key) {
                expected
                    .as_object_mut()
                    .context("codex_hook_native_metadata_invalid")?
                    .insert(
                        "trustStatus".to_owned(),
                        Value::String("trusted".to_owned()),
                    );
            }
            ensure!(*current == expected, "codex_hook_thread_trust_mismatch");
        }
        Ok(())
    }

    pub(super) fn verify_global_unchanged(&self, config: &Value, listed: &Value) -> Result<()> {
        ensure!(
            config_digest(config)? == self.global_config_digest,
            "codex_hook_global_config_changed"
        );
        ensure!(
            metadata(listed, &self.cwd, self.windows)? == self.baseline,
            "codex_hook_global_catalog_changed"
        );
        Ok(())
    }
}

fn check_definition(
    key: &str,
    hook: &Value,
    definition: &CommandHook,
    windows: bool,
) -> Result<()> {
    let source_path =
        nonempty(hook.get("sourcePath")).context("codex_hook_native_source_missing")?;
    ensure!(
        key == format!("{source_path}{}", definition.key_suffix()),
        "codex_hook_native_key_mismatch"
    );
    ensure!(
        hook.get("eventName").and_then(Value::as_str) == Some(definition.native_event())
            && hook.get("handlerType").and_then(Value::as_str) == Some("command")
            && hook.get("command").and_then(Value::as_str)
                == Some(definition.effective_command(windows))
            && hook.get("matcher") == Some(&serde_json::to_value(&definition.matcher)?)
            && match &definition.timeout {
                Some(expected) =>
                    hook.get("timeoutSec").and_then(Value::as_f64) == expected.as_f64(),
                None => hook.get("timeoutSec").is_some_and(Value::is_null),
            }
            && hook.get("async").and_then(Value::as_bool) == Some(false)
            && hook.get("isManaged").and_then(Value::as_bool) == Some(false)
            && hook.get("pluginId").is_some_and(Value::is_null)
            && hook.get("environmentId").is_some_and(Value::is_null)
            && hook.get("statusMessage").is_some_and(Value::is_null)
            && hook
                .get("additionalContextLimit")
                .is_some_and(Value::is_null),
        "codex_hook_native_definition_mismatch"
    );
    ensure!(
        hook.get("enabled").and_then(Value::as_bool) == Some(true),
        "codex_hook_disabled_by_native_policy"
    );
    ensure!(
        hook.get("currentHash")
            .and_then(Value::as_str)
            .is_some_and(command_hooks::valid_digest),
        "codex_hook_native_hash_invalid"
    );
    ensure!(
        matches!(
            hook.get("trustStatus").and_then(Value::as_str),
            Some("untrusted" | "modified" | "trusted")
        ),
        "codex_hook_native_trust_invalid"
    );
    Ok(())
}

fn metadata(listed: &Value, cwd: &str, windows: bool) -> Result<BTreeMap<String, Value>> {
    let data = listed
        .get("data")
        .and_then(Value::as_array)
        .context("codex_hook_list_unavailable")?;
    ensure!(data.len() == 1, "codex_hook_list_scope");
    let entry = &data[0];
    ensure!(
        nonempty(entry.get("cwd")).is_some_and(|actual| same_path(cwd, actual, windows)),
        "codex_hook_list_scope"
    );
    for field in ["errors", "warnings"] {
        ensure!(
            entry
                .get(field)
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty),
            "codex_hook_list_diagnostics"
        );
    }
    let mut result = BTreeMap::new();
    for hook in entry
        .get("hooks")
        .and_then(Value::as_array)
        .context("codex_hook_list_unavailable")?
    {
        let key = nonempty(hook.get("key")).context("codex_hook_native_key_missing")?;
        ensure!(
            result.insert(key.to_owned(), hook.clone()).is_none(),
            "codex_hook_native_key_duplicate"
        );
    }
    Ok(result)
}
fn config_digest(config: &Value) -> Result<String> {
    // Only the digest is retained. Config/provider/command bodies are never
    // written to an audit log or interpolated into an error/Debug message.
    let value = json!({
        "config": config.get("config").context("codex_hook_config_unavailable")?,
        "layers": config.get("layers").context("codex_hook_layers_unavailable")?,
    });
    Ok(command_hooks::digest(&serde_json::to_vec(&value)?))
}
fn nonempty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}
fn windows_program(program: &str) -> bool {
    program.starts_with("\\\\") || program.as_bytes().get(1) == Some(&b':')
}
fn same_path(left: &str, right: &str, windows: bool) -> bool {
    fn normalize(value: &str, windows: bool) -> String {
        if !windows {
            return value.trim_end_matches('/').to_owned();
        }
        let value = value.replace('/', "\\");
        let value = if let Some(tail) = value.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{tail}")
        } else if value.starts_with("\\\\?\\") && value.as_bytes().get(5) == Some(&b':') {
            value[4..].to_owned()
        } else {
            value
        };
        value.trim_end_matches('\\').to_owned()
    }
    normalize(left, windows) == normalize(right, windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Value, Value, Value, String) {
        let settings = json!({"hooks":{"Stop":[{"hooks":[{
            "type":"command","command":"selected-command","timeout":5
        }]}]}});
        let config = json!({
            "config":{"features":{"hooks":true},"model":"configured-model",
                "model_provider":"node-provider","profile":"node-default",
                "hooks":{"state":{"node-user-key":{"enabled":false,"trusted_hash":"unchanged"}}}},
            "layers":[
                {"name":{"type":"user","profile":"node-default"},"version":"user-version","config":{"model":"configured-model"}},
                {"name":{"type":"sessionFlags"},"version":"flags-version","config":{"hooks":settings["hooks"]}}
            ]
        });
        let key = r"C:\<session-flags>\config.toml:stop:0:0".to_owned();
        let selected = json!({
            "key":key,"source":"sessionFlags","sourcePath":r"C:\<session-flags>\config.toml",
            "eventName":"stop","handlerType":"command","command":"selected-command",
            "matcher":null,"timeoutSec":5,"async":false,"isManaged":false,
            "pluginId":null,"environmentId":null,"statusMessage":null,"additionalContextLimit":null,
            "enabled":true,"currentHash":format!("sha256:{}","a".repeat(64)),"trustStatus":"untrusted"
        });
        let listed = json!({"data":[{"cwd":r"C:\workspace","warnings":[],"errors":[],"hooks":[
            selected,{"key":"node-user-key","source":"user","enabled":false,"trustStatus":"trusted",
                "currentHash":format!("sha256:{}","b".repeat(64))}
        ]}]});
        (settings, config, listed, key)
    }

    // Lowest-cost owner for the native response boundary: no child, network,
    // config write or hook execution. A native H gate is still required.
    #[test]
    fn exact_native_definition_and_thread_scope_are_required_without_global_policy_changes() {
        let (settings, config, listed, key) = fixture();
        let prepare = |config: &Value, listed: &Value| {
            NativeHookTrust::from_settings(
                &settings,
                r"C:\workspace",
                r"C:\native\codex.exe",
                config,
                listed,
            )
        };
        let trust = prepare(&config, &listed).unwrap();
        let mcp = json!({"mcp_servers":{"selected":{"url":"http://127.0.0.1:1/mcp"}}});
        let merged = trust.merge_thread_config(Some(mcp.clone())).unwrap();
        assert_eq!(merged["mcp_servers"], mcp["mcp_servers"]);
        assert_eq!(merged["hooks.state"].as_object().unwrap().len(), 1);
        assert_eq!(
            merged["hooks.state"][&key]["trusted_hash"],
            listed["data"][0]["hooks"][0]["currentHash"]
        );
        assert!(
            merged.get("hooks").is_none()
                && merged.get("profile").is_none()
                && merged.get("features").is_none()
        );
        assert!(
            trust
                .merge_thread_config(Some(json!({"hooks.state":{}})))
                .is_err()
        );
        assert!(
            trust
                .merge_thread_config(Some(json!({"approval_policy":"never"})))
                .is_err()
        );
        let mut thread = listed.clone();
        thread["data"][0]["hooks"][0]["trustStatus"] = json!("trusted");
        trust.verify_thread_hooks(&thread).unwrap();
        trust.verify_global_unchanged(&config, &listed).unwrap();
        for (field, value) in [
            ("enabled", json!(false)),
            ("command", json!("changed-command")),
            ("source", json!("user")),
            ("async", json!(true)),
            ("isManaged", json!(true)),
            ("matcher", json!(7)),
            ("currentHash", json!("invalid")),
            ("timeoutSec", json!(6)),
        ] {
            let mut changed = listed.clone();
            changed["data"][0]["hooks"][0][field] = value;
            let error = prepare(&config, &changed).err().unwrap().to_string();
            assert!(!error.contains("selected-command"), "{field}");
        }
        let mut state = config.clone();
        state["layers"][1]["config"]["hooks"]["state"] = json!({});
        assert!(prepare(&state, &listed).is_err());
        let mut disabled = config.clone();
        disabled["config"]["features"]["hooks"] = json!(false);
        assert!(prepare(&disabled, &listed).is_err());
        for profile_layer in [false, true] {
            let mut overlap = config.clone();
            if profile_layer {
                overlap["layers"][0]["config"]["profiles"] =
                    json!({"node-default":{"hooks":settings["hooks"]}});
            } else {
                overlap["layers"][0]["config"]["hooks"] = settings["hooks"].clone();
            }
            assert!(prepare(&overlap, &listed).is_err());
        }
        let mut changed = thread.clone();
        changed["data"][0]["hooks"][0]["trustStatus"] = json!("modified");
        assert!(trust.verify_thread_hooks(&changed).is_err());
        changed = thread.clone();
        changed["data"][0]["hooks"][1]["enabled"] = json!(true);
        assert!(trust.verify_thread_hooks(&changed).is_err());
        assert!(trust.verify_global_unchanged(&config, &thread).is_err());
        let mut profile = config.clone();
        profile["config"]["profile"] = json!("other-profile");
        assert!(trust.verify_global_unchanged(&profile, &listed).is_err());

        let request = json!({"cwd":r"C:\workspace","sandbox":"workspace-write",
            "approvalPolicy":"on-request","approvalsReviewer":"user"});
        let response = json!({"cwd":r"\\?\C:\workspace","sandbox":{"type":"workspaceWrite"},
            "approvalPolicy":"on-request","approvalsReviewer":"user",
            "model":"configured-model","modelProvider":"node-provider"});
        trust.verify_launch_response(&request, &response).unwrap();
        for (field, value) in [
            ("cwd", json!(r"C:\other")),
            ("model", json!("other-model")),
            ("modelProvider", json!("other-provider")),
            ("approvalPolicy", json!("never")),
            ("approvalsReviewer", json!("auto_review")),
            ("sandbox", json!({"type":"dangerFullAccess"})),
        ] {
            let mut changed = response.clone();
            changed[field] = value;
            assert!(
                trust.verify_launch_response(&request, &changed).is_err(),
                "{field}"
            );
        }
    }
}
