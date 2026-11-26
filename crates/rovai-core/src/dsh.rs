//! DeepSeek Harness's official ACP profile plus a scoped system-prompt section.
//! Transport, process ownership, approvals and LRU remain in the shared ACP host.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use tokio::process::Command;

use crate::{
    agent_profile::{AdapterKind, DshModelSource},
    command::canonical_json_digest,
};

pub const MINIMUM_VERSION: &str = "0.1.5-rc.2";
pub const BOOTSTRAP_REVISION: &str = "dsh-local-hook-private-executor-v9";
const BOOTSTRAP_PLUGIN: &str = include_str!("dsh/bootstrap.mjs");
const MODEL_PLUGIN: &str = include_str!("dsh/models.mjs");
const LOCAL_HOOK_PLUGIN: &str = include_str!("dsh/local-hooks.mjs");
const LOCAL_HOOK_CLIENT: &str = include_str!("dsh/local-hook-executor.mjs");
const LOCAL_HOOK_EXECUTOR: &str = include_str!("../../../resources/dsh-hook-executor/executor.mjs");
const LOCAL_HOOK_VERIFY: &str = include_str!("../../../resources/dsh-hook-executor/verify.mjs");
const LOCAL_HOOK_PACKAGE: &str = include_str!("../../../resources/dsh-hook-executor/package.json");
const LOCAL_HOOK_LOCK: &str =
    include_str!("../../../resources/dsh-hook-executor/package-lock.json");

const MAX_OBSERVED_FILE_CONTENT_BYTES: usize = 2 * 1024 * 1024;

/// The native `skill-filesystem` entry this Host patches. DSH discovers
/// `customSkillDirs[]` roots, reading `<root>/<name>/SKILL.md`, and replaces a
/// patched `config` wholesale, so the entry is addressed by its own id here.
const SKILL_FILESYSTEM_ID: &str = "skill-filesystem";
/// A Run's frozen Skill copy is published by the Context service as
/// `<dataDir>/runtime/skills/<runId>` with this manifest written last.
const SKILL_MATERIAL_ROOT: [&str; 2] = ["runtime", "skills"];
const SKILL_MATERIAL_CONTENT_DIR: &str = "skills";
const SKILL_MATERIAL_MANIFEST: &str = "manifest.json";
const SKILL_MATERIAL_SCHEMA_VERSION: u32 = 1;
const MAX_SKILL_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

pub fn supported_version(version: Option<&str>) -> bool {
    let Some(version) = version.map(str::trim) else {
        return false;
    };
    let version = version.strip_prefix('v').unwrap_or(version);
    let version = version.split_once('+').map_or(version, |(core, _)| core);
    let (core, suffix) = version.split_once('-').unwrap_or((version, ""));
    let numbers = core
        .split('.')
        .map(str::parse::<u64>)
        .collect::<std::result::Result<Vec<_>, _>>();
    let Ok(numbers) = numbers else {
        return false;
    };
    if numbers.len() != 3 {
        return false;
    }
    let numbers = [numbers[0], numbers[1], numbers[2]];
    numbers > [0, 1, 5]
        || (numbers == [0, 1, 5]
            && (suffix.is_empty()
                || suffix
                    .strip_prefix("rc.")
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_some_and(|v| v >= 2)))
}

/// Observe only this Runtime's native configuration. Values never enter argv,
/// prompts or diagnostics; changes invalidate process and Native Binding reuse.
pub fn native_configuration_digest(cwd: &Path) -> Result<String> {
    configuration_digest(&native_home()?, cwd)
}

fn native_home() -> Result<std::path::PathBuf> {
    crate::runtime_discovery::runtime_environment_variable(AdapterKind::DeepseekHarness, "DSH_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            crate::runtime_discovery::runtime_home_directory(AdapterKind::DeepseekHarness)
                .map(|p| p.join(".dsh"))
        })
        .context("DeepSeek Harness native Home is unavailable")
}

fn configuration_digest(home: &Path, cwd: &Path) -> Result<String> {
    configuration_digest_for_workdir(home, Some(cwd))
}

fn configuration_digest_for_workdir(home: &Path, cwd: Option<&Path>) -> Result<String> {
    let mut entries = Vec::new();
    let mut paths = vec![
        home.join("settings.yaml"),
        home.join(".credentials.yaml"),
        home.join(".env"),
        home.join("cordis.patch.yml"),
        home.join("profiles/acp/package.json"),
        home.join("profiles/acp/cordis.yml"),
        home.join("profiles/acp/cordis.patch.yml"),
        home.join("profiles/web/package.json"),
        home.join("profiles/web/cordis.patch.yml"),
    ];
    if let Some(cwd) = cwd {
        paths.push(cwd.join(".env"));
    }
    for path in paths {
        let digest = match fs::read(&path) {
            Ok(bytes) => Some(if path == home.join("profiles/web/cordis.patch.yml") {
                web_model_digest(&bytes)?
            } else {
                format!("{:x}", Sha256::digest(bytes))
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) if path.starts_with(home.join("profiles/web")) => Some("unreadable".to_string()),
            Err(_) => bail!("dsh_native_configuration_unreadable"),
        };
        entries.push((path, digest));
    }
    canonical_json_digest(&json!({"revision": BOOTSTRAP_REVISION, "home": home, "files": entries}))
}

/// Capability probes always have an empty, isolated working directory. Reuse
/// the native digest without including that randomly named directory. This is
/// local observation only; it neither starts DSH nor changes Host reuse rules.
pub fn model_options_context(executable: &Path) -> Result<String> {
    // Probe canonicalization adds a Windows verbatim prefix that catalog
    // commits remove. Both observations must identify the same executable.
    let executable = crate::runtime_discovery::runtime_visible_path(executable.canonicalize()?);
    let mut command = Command::new(&executable);
    crate::runtime_discovery::configure_runtime_command(AdapterKind::DeepseekHarness, &mut command);
    let mut environment =
        crate::runtime_discovery::runtime_environment(AdapterKind::DeepseekHarness);
    for (name, value) in command.as_std().get_envs() {
        if let Some(value) = value {
            environment.insert(
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            );
        }
    }
    let identity = crate::agent_runtime_adapter::observe_executable_file_identity(&executable)?;
    canonical_json_digest(&json!({
        "configuration": configuration_digest_for_workdir(&native_home()?, None)?,
        "executable": executable,
        "identity": [identity.byte_size.to_string(), identity.modified_at_unix_nanos.to_string(), identity.file_id.unwrap_or_default()],
        "environment": environment,
    }))
}

fn web_model_digest(bytes: &[u8]) -> Result<String> {
    // Native Loader still parses/evaluates configuration. This projection only
    // keeps unrelated Web UI edits out of the existing Host reuse fence.
    let Ok(Value::Array(patches)) = serde_yaml::from_slice::<Value>(bytes) else {
        return Ok(format!("{:x}", Sha256::digest(bytes)));
    };
    let relevant: Vec<_> = patches
        .into_iter()
        .filter(|patch| {
            patch["id"]
                .as_str()
                .is_none_or(|id| matches!(id, "llm-pi-ai" | "llm-deepseek"))
        })
        .collect();
    canonical_json_digest(&json!(relevant))
}

fn model_preparation_patch(root: &Path) -> Result<Value> {
    fs::create_dir_all(root)?;
    private_directory(root)?;
    let plugin = root.join("models.mjs");
    fs::write(&plugin, MODEL_PLUGIN)?;
    private_file(&plugin)?;
    Ok(
        json!({"insert":[{"id":"rovai-model-configuration","name":plugin,
        "config":{"resultPath":root.join("models.result.json")}}]}),
    )
}

/// The exact same model preparation as execution, without a Run, Bootstrap,
/// task credentials, permission changes, or Web application startup.
pub fn configure_probe(command: &mut Command, root: &Path) -> Result<()> {
    let patch = json!([model_preparation_patch(root)?]);
    let path = root.join("models.patch.json");
    fs::write(&path, serde_json::to_vec(&patch)?)?;
    private_file(&path)?;
    command.args(["--profile", "acp", "--patch"]).arg(path);
    Ok(())
}

pub async fn await_model_preparation(root: &Path) -> Result<Value> {
    let path = root.join("models.result.json");
    tokio::time::timeout(std::time::Duration::from_secs(25), async {
        loop {
            match fs::read(&path) {
                Ok(bytes) => {
                    let result: Value = serde_json::from_slice(&bytes)
                        .map_err(|_| anyhow::anyhow!("dsh_model_preparation_invalid"))?;
                    if result["schemaVersion"] != 1
                        || !matches!(result["status"].as_str(), Some("ready" | "native_only"))
                    {
                        bail!("dsh_model_preparation_failed");
                    }
                    return Ok(result);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => bail!("dsh_model_preparation_unreadable"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .context("dsh_model_preparation_timed_out")?
}

pub fn model_inputs_unchanged(result: &Value) -> bool {
    result["inputs"].as_array().is_none_or(|inputs| {
        inputs.iter().all(|input| {
            let Some(path) = input["path"].as_str() else {
                return false;
            };
            match fs::read(path) {
                Ok(bytes) => {
                    input["digest"].as_str()
                        == Some(format!("{:x}", Sha256::digest(bytes)).as_str())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    input["digest"].is_null()
                }
                Err(_) => input["digest"] == "unreadable",
            }
        })
    })
}

pub fn annotate_session(session: &mut Value, preparation: &Value) {
    // Private result contains only identities, hashes and fixed diagnostic codes.
    session["_meta"]["rovaiDshModels"] = preparation.clone();
}

pub fn model_provider(model: &str) -> Option<String> {
    let identity: Vec<String> = serde_json::from_str(model).ok()?;
    (identity.len() == 2).then(|| identity[0].clone())
}

pub fn model_source(result: &Value, model: &str) -> DshModelSource {
    if model_provider(model).is_some_and(|provider| {
        result["webProviders"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == &provider))
    }) {
        DshModelSource::Web
    } else {
        DshModelSource::Native
    }
}

pub fn selected_route_available(
    result: &Value,
    model: &str,
    selected: Option<DshModelSource>,
) -> bool {
    // Selections predating Web supplementation retain native semantics. New Web
    // selections carry their source through the existing member/frozen JSON.
    // A failed supplement says nothing about unrelated native plugin routes.
    let selected = selected.unwrap_or(DshModelSource::Native);
    model_source(result, model) == selected
        && (selected != DshModelSource::Web
            || model_provider(model).is_some_and(|provider| {
                !result["rejectedProviders"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == &provider))
            }))
}

pub fn preparation_diagnostic(result: &Value) -> Option<&'static str> {
    let diagnostics = result["diagnostics"].as_array()?;
    if diagnostics
        .iter()
        .any(|row| row["code"] == "native_model_compatibility_unavailable")
    {
        return Some("DSH 模型兼容修正暂不可用，已保留原生配置。");
    }
    if diagnostics.iter().any(|row| {
        row["code"].as_str().is_some_and(|code| {
            code.starts_with("native_model_import") || code == "native_initialization_failed"
        })
    }) {
        Some("DSH 原生配置迁移未完整完成；已保留备份，请检查 DSH 配置。")
    } else if diagnostics
        .iter()
        .any(|row| row["code"] != "native_provider_preferred")
    {
        Some("部分 DSH Web 模型配置无法复用，已保留原生 ACP 配置。")
    } else if !diagnostics.is_empty() {
        Some("同名 Provider 保留原生 ACP 配置。")
    } else {
        None
    }
}

/// One Run's frozen Skill tree as its native provider must read it.
///
/// The root and the identity digest both come from the manifest the Context
/// service already verified and published for this Run. A Run that selected no
/// imported source owns no directory, and that absence is carried explicitly as
/// an empty root list rather than as an unspecified field: a Host is never left
/// free to inherit a directory from an earlier Run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenSkillRoots {
    schema_version: u32,
    custom_skill_dirs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity_digest: Option<String>,
}

impl FrozenSkillRoots {
    /// The state of a Run that selected no imported Skill source.
    fn unselected() -> Self {
        Self {
            schema_version: SKILL_MATERIAL_SCHEMA_VERSION,
            custom_skill_dirs: Vec::new(),
            identity_digest: None,
        }
    }

    pub fn identity_digest(&self) -> Option<&str> {
        self.identity_digest.as_deref()
    }

    /// The per-Run payload the Core hands its own Host spawn. It travels with the
    /// compatibility digest, so a changed selection acquires a new Host instead
    /// of silently reusing the previous Run's provider configuration.
    pub fn encode(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn decode(payload: &str) -> Result<Self> {
        let roots: Self = serde_json::from_str(payload)
            .context("dsh_skill_roots_invalid")?;
        roots.validate()?;
        Ok(roots)
    }

    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.schema_version == SKILL_MATERIAL_SCHEMA_VERSION,
            "dsh_skill_roots_invalid"
        );
        anyhow::ensure!(self.custom_skill_dirs.len() <= 1, "dsh_skill_roots_invalid");
        for root in &self.custom_skill_dirs {
            anyhow::ensure!(
                Path::new(root).is_absolute(),
                "dsh_skill_roots_invalid"
            );
        }
        match self.identity_digest.as_deref() {
            None => anyhow::ensure!(
                self.custom_skill_dirs.is_empty(),
                "dsh_skill_roots_invalid"
            ),
            Some(digest) => anyhow::ensure!(
                !self.custom_skill_dirs.is_empty()
                    && digest.len() == 64
                    && digest
                        .chars()
                        .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()),
                "dsh_skill_roots_invalid"
            ),
        }
        Ok(())
    }
}

/// Reads the manifest of one Run's published Skill material. The bytes are owned
/// and re-verified by the Context service on every claim and replay; this reads
/// that same manifest so the native provider points at exactly one Run's own
/// tree, and refuses the Host when the tree does not describe this Run.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMaterialManifest {
    schema_version: u32,
    run_id: String,
    member_id: String,
    imports: Vec<Value>,
    files: Vec<Value>,
    identity_digest: String,
}

pub fn resolve_frozen_skill_roots(
    data_dir: &Path,
    run_id: &str,
    member_id: &str,
) -> Result<FrozenSkillRoots> {
    anyhow::ensure!(
        !run_id.is_empty()
            && run_id.len() <= 64
            && run_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-'),
        "dsh_skill_material_run_invalid"
    );
    let run_root = SKILL_MATERIAL_ROOT
        .iter()
        .fold(data_dir.to_path_buf(), |path, part| path.join(part))
        .join(run_id);
    let metadata = match fs::symlink_metadata(&run_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FrozenSkillRoots::unselected());
        }
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "dsh_skill_material_root_invalid"
    );
    let content = run_root.join(SKILL_MATERIAL_CONTENT_DIR);
    let content_metadata = fs::symlink_metadata(&content)?;
    anyhow::ensure!(
        content_metadata.is_dir() && !content_metadata.file_type().is_symlink(),
        "dsh_skill_material_content_invalid"
    );
    let manifest_path = run_root.join(SKILL_MATERIAL_MANIFEST);
    let manifest_metadata = fs::symlink_metadata(&manifest_path)
        .context("dsh_skill_material_manifest_missing")?;
    anyhow::ensure!(
        manifest_metadata.is_file()
            && !manifest_metadata.file_type().is_symlink()
            && manifest_metadata.len() <= MAX_SKILL_MANIFEST_BYTES,
        "dsh_skill_material_manifest_invalid"
    );
    let manifest: SkillMaterialManifest = serde_json::from_slice(&fs::read(&manifest_path)?)
        .context("dsh_skill_material_manifest_invalid")?;
    anyhow::ensure!(
        manifest.schema_version == SKILL_MATERIAL_SCHEMA_VERSION
            && manifest.run_id == run_id
            && manifest.member_id == member_id
            && !manifest.imports.is_empty()
            && !manifest.files.is_empty(),
        "dsh_skill_material_manifest_invalid"
    );
    let roots = FrozenSkillRoots {
        schema_version: SKILL_MATERIAL_SCHEMA_VERSION,
        custom_skill_dirs: vec![
            dunce::simplified(&content)
                .to_str()
                .context("dsh_skill_material_root_not_utf8")?
                .to_string(),
        ],
        identity_digest: Some(manifest.identity_digest),
    };
    roots.validate()?;
    Ok(roots)
}

/// Points the existing native `skill-filesystem` entry at this Run's verified
/// frozen tree. DSH replaces a patched `config` wholesale, so the empty state is
/// written out as an empty `customSkillDirs` instead of being left unmentioned.
/// This only ever re-points the provider; it registers no Skill of its own.
pub fn configure_skill_roots(root: &Path, bootstrap: Option<&str>) -> Result<()> {
    let payload = bootstrap.context("dsh_skill_roots_missing")?;
    let roots = FrozenSkillRoots::decode(payload)?;
    let path = root.join("rovai.patch.json");
    let mut patches: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let patches = patches
        .as_array_mut()
        .context("dsh_skill_patch_invalid")?;
    anyhow::ensure!(
        !patches
            .iter()
            .any(|patch| patch["id"] == SKILL_FILESYSTEM_ID),
        "dsh_skill_duplicate_configuration"
    );
    let config = if roots.custom_skill_dirs.is_empty() {
        json!({ "customSkillDirs": [] })
    } else {
        // A Run's frozen tree is the only directory this Host may discover: the
        // native project, user and bundled roots would let the same model read a
        // different copy of a Skill this Run never froze.
        json!({
            "customSkillDirs": roots.custom_skill_dirs,
            "includeDefaultRoots": false,
            "watch": false
        })
    };
    patches.push(json!({ "id": SKILL_FILESYSTEM_ID, "config": config }));
    fs::write(&path, serde_json::to_vec(&patches)?)?;
    private_file(&path)?;
    Ok(())
}

fn native_acp_default_model() -> Option<Value> {
    let path = native_home().ok()?.join("cordis.patch.yml");
    let rows: Value = serde_yaml::from_slice(&fs::read(path).ok()?).ok()?;
    let row = rows
        .as_array()?
        .iter()
        .find(|row| row["id"].as_str() == Some("agent-default-model"))?;
    let provider = row["config"]["provider"].as_str()?;
    let model = row["config"]["model"].as_str()?;
    Some(json!({"provider":provider,"model":model}))
}

pub fn configure_host(
    command: &mut Command,
    root: &Path,
    cwd: &Path,
    permissions: &Value,
    mcp_server_names: &[String],
) -> Result<()> {
    let sandbox = permissions
        .get("sandbox_mode")
        .and_then(Value::as_str)
        .context("DSH sandbox_mode missing")?;
    let approval = permissions
        .get("approval_policy")
        .and_then(Value::as_str)
        .context("DSH approval_policy missing")?;
    if !matches!(
        sandbox,
        "read-only" | "workspace-write" | "danger-full-access"
    ) || !matches!(approval, "ask" | "never")
    {
        bail!("DSH permission configuration invalid");
    }
    let binding_root = root.join("bindings");
    fs::create_dir_all(&binding_root)?;
    private_directory(&binding_root)?;
    let observation_root = root.join("observations");
    fs::create_dir_all(&observation_root)?;
    private_directory(&observation_root)?;
    let plugin_path = root.join("bootstrap.mjs");
    fs::write(&plugin_path, BOOTSTRAP_PLUGIN)?;
    private_file(&plugin_path)?;
    let mut patch = json!([
        {"id":"sandbox-policy","config":{"mode":sandbox,"workspaceRoot":cwd}},
        {"id":"approval","config":{"policy":approval}},
        // The interactive preset service seeds native settings over the two
        // independent knobs, and rejects valid pairs absent from its preset
        // table. ACP has no permission-mode control; this Host's frozen knobs
        // own the policy. Preserve the native settings file untouched.
        {"id":"permission","disabled":true},
        // DSH's ACP app may accept stdio before sibling Loader entries finish.
        // The bootstrap publishes this service only after configured native MCP
        // clients complete their official entry lifecycle.
        {"id":"acp","inject":["acpAppStartup","rovaiDshReady"]},
        {"insert":[{"id":"rovai-bootstrap","name":plugin_path,"config":{"bindingRoot":binding_root,"observationRoot":observation_root,"mcpServerNames":mcp_server_names}}]}
    ]);
    if let Some(config) = native_acp_default_model() {
        patch
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"acp","config":config}));
    }
    // Model overrides are applied only in memory after native initialization.
    // A CLI llm-pi-ai override here can be absorbed into DSH's Profile import.
    patch
        .as_array_mut()
        .unwrap()
        .push(model_preparation_patch(root)?);
    let patch_path = root.join("rovai.patch.json");
    fs::write(&patch_path, serde_json::to_vec(&patch)?)?;
    private_file(&patch_path)?;
    command
        .args(["--profile", "acp", "--patch"])
        .arg(patch_path);
    Ok(())
}

/// Supplement ACP only with an exact, one-shot observation from the official
/// tools/result seam. Missing or mismatched evidence fails the Host rather than
/// reporting an unobserved successful shell exit. No result-text parsing.
pub fn enrich_message(root: &Path, message: &mut Value) -> Result<()> {
    if message["method"] != "session/update" {
        return Ok(());
    }
    let Some(params) = message.get_mut("params") else {
        return Ok(());
    };
    let session_id = params["sessionId"]
        .as_str()
        .context("dsh_session_id_missing")?
        .to_string();
    let update = &mut params["update"];
    append_hook_observations(root, &session_id, update)?;
    if update["sessionUpdate"] == "usage_update" {
        let prefix = format!("{:x}.usage-", Sha256::digest(session_id.as_bytes()));
        let mut observations = Vec::new();
        let mut files = Vec::new();
        for entry in fs::read_dir(root.join("observations"))? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(&prefix) || !name.ends_with(".json") {
                continue;
            }
            if observations.len() >= 1024 {
                bail!("dsh_usage_observation_budget_exceeded");
            }
            let observation: Value = serde_json::from_slice(&fs::read(entry.path())?)?;
            if observation["schemaVersion"] != 1
                || observation["sessionId"] != session_id
                || !observation["seq"].is_u64()
                || !observation["turn"].is_u64()
            {
                bail!("dsh_usage_observation_mismatch");
            }
            observations.push(observation);
            files.push(entry.path());
        }
        observations.sort_by_key(|value| value["seq"].as_u64());
        update["_meta"]["dshUsage"] = json!(observations);
        for file in files {
            fs::remove_file(file)?;
        }
        return Ok(());
    }
    if update["sessionUpdate"] == "tool_call" {
        if let Some(kind) = tool_kind(update["title"].as_str().unwrap_or_default()) {
            update["kind"] = json!(kind);
        }
        return Ok(());
    }
    if update["sessionUpdate"] != "tool_call_update"
        || !matches!(update["status"].as_str(), Some("completed" | "failed"))
    {
        return Ok(());
    }
    let call_id = update["toolCallId"]
        .as_str()
        .context("dsh_tool_call_id_missing")?;
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([session_id, call_id]))?)
    );
    let path = root.join("observations").join(format!("{key}.json"));
    let observation: Value =
        serde_json::from_slice(&fs::read(&path).context("dsh_tool_observation_missing")?)?;
    if observation["schemaVersion"] != 1
        || observation["sessionId"] != session_id
        || observation["callId"] != call_id
        || !observation["isError"].is_boolean()
    {
        bail!("dsh_tool_observation_mismatch");
    }
    let tool = observation["tool"]
        .as_str()
        .context("dsh_tool_name_missing")?;
    if let Some(kind) = tool_kind(tool) {
        update["kind"] = json!(kind);
    }
    if let Some(path) = observation["path"].as_str() {
        update["locations"] = json!([{"path":path}]);
    }
    append_observed_file_diff(update, &observation, tool);
    if matches!(tool, "bash" | "pwsh") {
        update["rawOutput"] = json!({
            "exitCode": observation["exitCode"], "signal": observation["signal"],
            "timedOut": observation["timedOut"], "aborted": observation["aborted"]
        });
        if observation["isError"] == true
            || observation["timedOut"] == true
            || observation["aborted"] == true
            || observation["signal"].is_string()
            || observation["exitCode"]
                .as_i64()
                .is_some_and(|code| code != 0)
        {
            update["status"] = json!("failed");
        }
    }
    fs::remove_file(path)?;
    Ok(())
}

pub(crate) fn configure_local_hooks(
    root: &Path,
    launch: &crate::local_hook::LocalHookLaunch,
) -> Result<()> {
    anyhow::ensure!(
        launch.schema_version == 1 && launch.execution_epoch >= 0,
        "local_hook_launch_invalid"
    );
    let path = root.join("rovai.patch.json");
    let mut patches: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let bootstrap = patches
        .as_array_mut()
        .context("local_hook_patch_invalid")?
        .iter_mut()
        .filter_map(|p| p.get_mut("insert").and_then(Value::as_array_mut))
        .flat_map(|v| v.iter_mut())
        .find(|p| p["id"] == "rovai-bootstrap")
        .context("local_hook_bootstrap_missing")?;
    anyhow::ensure!(
        bootstrap["config"].get("localHook").is_none(),
        "local_hook_duplicate_configuration"
    );
    bootstrap["config"]["localHook"] = serde_json::to_value(launch)?;
    for (name, source) in [
        ("local-hooks.mjs", LOCAL_HOOK_PLUGIN),
        ("local-hook-executor.mjs", LOCAL_HOOK_CLIENT),
    ] {
        let plugin = root.join(name);
        fs::write(&plugin, source)?;
        private_file(&plugin)?;
    }
    let marker = root.join("local-hook-launch.json");
    let launch_bytes = serde_json::to_vec(launch)?;
    fs::write(&marker, &launch_bytes)?;
    private_file(&marker)?;
    let executor = local_hook_executor_configuration(&marker, &launch_bytes)?;
    bootstrap["config"]["localHookExecutor"] = executor.clone();
    let executor_marker = root.join("local-hook-executor.json");
    fs::write(&executor_marker, serde_json::to_vec(&executor)?)?;
    private_file(&executor_marker)?;
    fs::write(&path, serde_json::to_vec(&patches)?)?;
    private_file(&path)?;
    Ok(())
}

fn local_hook_executor_configuration(launch_path: &Path, launch_bytes: &[u8]) -> Result<Value> {
    anyhow::ensure!(cfg!(windows), "local_hook_executor_platform_unsupported");
    let configured_pi = std::env::var_os(crate::embedded_pi::EMBEDDED_PI_ROOT_ENV)
        .map(std::path::PathBuf::from)
        .context("local_hook_bundled_node_unavailable")?;
    anyhow::ensure!(
        configured_pi.is_absolute(),
        "local_hook_bundled_node_unavailable"
    );
    let pi = crate::embedded_pi::embedded_pi_bundle(&configured_pi)
        .context("local_hook_bundled_node_unverified")?;
    // The installed kit keeps both closures under the same runtime directory.
    // The Node binary is admitted by Pi's existing complete bundle verifier.
    let root = configured_pi
        .parent()
        .context("local_hook_bundle_missing")?
        .join("dsh-hook-executor")
        .canonicalize()
        .context("local_hook_bundle_missing")?;
    for (name, expected) in [
        ("executor.mjs", LOCAL_HOOK_EXECUTOR),
        ("verify.mjs", LOCAL_HOOK_VERIFY),
        ("package.json", LOCAL_HOOK_PACKAGE),
        ("package-lock.json", LOCAL_HOOK_LOCK),
    ] {
        let path = root.join(name);
        let meta = fs::symlink_metadata(&path).context("local_hook_bundle_file_missing")?;
        anyhow::ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "local_hook_bundle_file_invalid"
        );
        anyhow::ensure!(
            fs::read(path)? == expected.as_bytes(),
            "local_hook_bundle_source_mismatch"
        );
    }
    let manifest_path = root.join("hook-executor-bundle.json");
    let metadata =
        fs::symlink_metadata(&manifest_path).context("local_hook_bundle_manifest_missing")?;
    anyhow::ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() <= 2 * 1024 * 1024,
        "local_hook_bundle_manifest_invalid"
    );
    let bytes = fs::read(manifest_path)?;
    let manifest: Value = serde_json::from_slice(&bytes)?;
    let candidate_path = configured_pi
        .parent()
        .and_then(Path::parent)
        .context("local_hook_candidate_manifest_missing")?
        .join("candidate-manifest.json");
    let candidate_metadata =
        fs::symlink_metadata(&candidate_path).context("local_hook_candidate_manifest_missing")?;
    anyhow::ensure!(
        candidate_metadata.is_file()
            && !candidate_metadata.file_type().is_symlink()
            && candidate_metadata.len() <= 8 * 1024 * 1024,
        "local_hook_candidate_manifest_invalid"
    );
    let candidate: Value = serde_json::from_slice(&fs::read(candidate_path)?)?;
    let expected = &candidate["dshHookExecutor"];
    let manifest_digest = format!("{:x}", Sha256::digest(&bytes));
    anyhow::ensure!(
        expected["dshVersion"] == MINIMUM_VERSION
            && expected["manifestSha256"] == manifest_digest
            && candidate["files"]["runtime/dsh-hook-executor/hook-executor-bundle.json"]
                == manifest_digest
            && expected["treeSha256"] == manifest["treeSha256"]
            && expected["lockSha256"] == manifest["lockSha256"]
            && expected["packageCount"].as_u64()
                == manifest["packages"]
                    .as_array()
                    .map(|items| items.len() as u64),
        "local_hook_candidate_bundle_mismatch"
    );
    anyhow::ensure!(
        manifest["schemaVersion"] == 1
            && manifest["kind"] == "loom-local-hook-executor"
            && manifest["platform"] == "win32"
            && manifest["arch"] == "x64"
            && manifest["dshVersion"] == MINIMUM_VERSION
            && manifest["closureComplete"] == true
            && manifest["entry"] == "executor.mjs",
        "local_hook_bundle_manifest_invalid"
    );
    // Node cannot load a module through a verbatim (\\?\) path: it re-prefixes
    // the argument and reports MODULE_NOT_FOUND with empty stdout, which reaches
    // the Host as `local_hook_executor_result_missing`. Both handed-over paths
    // are therefore the plain native form; the admitted identity above stays
    // canonicalized.
    let executor_root = dunce::simplified(&root).to_path_buf();
    let executor_launch = dunce::simplified(&launch_path.canonicalize()?).to_path_buf();
    Ok(json!({
        "schemaVersion":1, "node":pi.node, "root":executor_root,
        "manifestDigest":manifest_digest,
        "launchPath":executor_launch,
        "launchDigest":format!("{:x}",Sha256::digest(launch_bytes))
    }))
}

pub(crate) async fn await_local_hook_preparation(root: &Path) -> Result<()> {
    let marker = root.join("local-hook-launch.json");
    if !marker.exists() {
        return Ok(());
    }
    let launch: crate::local_hook::LocalHookLaunch = serde_json::from_slice(&fs::read(marker)?)?;
    let executor: Value =
        serde_json::from_slice(&fs::read(root.join("local-hook-executor.json"))?)?;
    tokio::time::timeout(std::time::Duration::from_secs(25), async {
        loop {
            match fs::read(root.join("observations/local-hook-ready.json")) {
                Ok(bytes) => {
                    let ready: Value = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        ready["schemaVersion"] == 1
                            && ready["status"] == "ready"
                            && ready["agentRunId"] == launch.agent_run_id
                            && ready["executionEpoch"] == launch.execution_epoch
                            && ready["snapshotDigest"] == launch.snapshot_digest
                            && ready["sandboxMode"] == launch.sandbox_mode
                            && ready["chain"] == "private-pinned"
                            && ready["manifestDigest"] == executor["manifestDigest"],
                        "local_hook_preparation_mismatch"
                    );
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => bail!("local_hook_preparation_unreadable"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .context("local_hook_preparation_timed_out")?
}
fn append_hook_observations(root: &Path, session_id: &str, update: &mut Value) -> Result<()> {
    let prefix = format!("{:x}.hook-", Sha256::digest(session_id.as_bytes()));
    let mut rows = Vec::new();
    let mut files = Vec::new();
    for entry in fs::read_dir(root.join("observations"))? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(&prefix) || !name.ends_with(".json") {
            continue;
        }
        anyhow::ensure!(
            rows.len() < 256 && entry.file_type()?.is_file() && entry.metadata()?.len() <= 16384,
            "local_hook_observation_budget"
        );
        let row: crate::local_hook::HookObservation =
            serde_json::from_slice(&fs::read(entry.path())?)?;
        anyhow::ensure!(
            row.session_id == session_id && row.schema_version == 1,
            "local_hook_observation_mismatch"
        );
        rows.push(row);
        files.push(entry.path());
    }
    if !rows.is_empty() {
        rows.sort_by_key(|r| r.seq);
        update["_meta"]["dshHooks"] = serde_json::to_value(rows)?;
        for file in files {
            fs::remove_file(file)?;
        }
    }
    Ok(())
}

pub fn tool_kind(name: &str) -> Option<&'static str> {
    match name {
        "bash" | "pwsh" => Some("execute"),
        "read" | "read_image" => Some("read"),
        "write" => Some("write"),
        "edit" => Some("edit"),
        "glob" | "grep" => Some("file_search"),
        "web_search" => Some("web_search"),
        "web_fetch" => Some("fetch"),
        "skill" => Some("tool"),
        _ => None,
    }
}

fn append_observed_file_diff(update: &mut Value, observation: &Value, tool: &str) {
    if !matches!(tool, "write" | "edit") {
        return;
    }
    let Some(path) = observation["path"].as_str() else {
        return;
    };
    // An explicit null is DSH's complete pre-state for a newly created file.
    // Absence and malformed values remain path-only; edit never accepts null.
    let before = match (tool, observation.get("before")) {
        ("write", Some(Value::Null)) => None,
        ("write" | "edit", Some(Value::String(before))) => Some(before.as_str()),
        _ => return,
    };
    let Some(after) = observation.get("after").and_then(Value::as_str) else {
        return;
    };
    if before.is_some_and(|before| before == after)
        || before.is_some_and(|before| before.len() > MAX_OBSERVED_FILE_CONTENT_BYTES)
        || after.len() > MAX_OBSERVED_FILE_CONTENT_BYTES
    {
        return;
    }
    let block = json!({"type":"diff","path":path,"oldText":before,"newText":after});
    match update.get_mut("content") {
        Some(Value::Array(blocks)) => {
            if !blocks.contains(&block) {
                blocks.push(block);
            }
        }
        Some(Value::Null) => update["content"] = json!([block]),
        None => {
            if let Some(update) = update.as_object_mut() {
                update.insert("content".to_string(), json!([block]));
            }
        }
        Some(_) => {}
    }
}

pub fn resolve_mcp_command(server: &mut Value, cwd: &Path) -> Result<()> {
    let Some(command) = server["command"].as_str() else {
        return Ok(());
    };
    let entry = Path::new(command);
    if entry.is_absolute() {
        return Ok(());
    }
    if entry.components().count() != 1 {
        server["command"] = json!(cwd.join(entry));
        return Ok(());
    }
    let mut runtime = Command::new("dsh");
    crate::runtime_discovery::configure_runtime_command(AdapterKind::DeepseekHarness, &mut runtime);
    let path = server["env"]
        .as_array()
        .and_then(|entries| entries.iter().find(|e| e["name"] == "PATH"))
        .and_then(|entry| entry["value"].as_str())
        .map(std::ffi::OsString::from)
        .or_else(|| {
            runtime
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == "PATH")
                .and_then(|(_, value)| value.map(std::ffi::OsString::from))
        })
        .or_else(|| std::env::var_os("PATH"))
        .context("dsh_mcp_path_unavailable")?;
    for directory in std::env::split_paths(&path) {
        let candidate = if directory.is_absolute() {
            directory.join(entry)
        } else {
            cwd.join(directory).join(entry)
        };
        if candidate.is_file() && {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                candidate.metadata()?.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        } {
            server["command"] = json!(candidate);
            return Ok(());
        }
    }
    bail!("dsh_mcp_command_unresolved");
}

pub fn bind_bootstrap(root: &Path, session_id: &str, bootstrap: &str) -> Result<()> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || bootstrap.trim().is_empty()
    {
        bail!("dsh_bootstrap_binding_invalid");
    }
    let directory = root.join("bindings");
    let path = directory.join(format!("{session_id}.json"));
    let payload = serde_json::to_vec(
        &json!({"schemaVersion":1,"sessionId":session_id,"bootstrap":bootstrap,"sha256":format!("{:x}",Sha256::digest(bootstrap.as_bytes()))}),
    )?;
    // An existing binding owns immutable bytes for its Native Session. A later
    // member identity edit must not hot-rewrite that Session's self identity.
    if path.exists() {
        return Ok(());
    }
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, payload)?;
    private_file(&temporary)?;
    fs::rename(&temporary, &path)?;
    Ok(())
}

fn private_directory(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn private_file(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dsh_native_configuration_fences_profile_and_credentials() {
        let root = std::env::temp_dir().join(format!("rovai-dsh-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("profiles/acp")).unwrap();
        fs::create_dir_all(root.join("profiles/web")).unwrap();
        let mut previous = configuration_digest(&root, &root).unwrap();
        // The old digest omitted the profile composition: changing its model
        // route could silently reuse a Host with the previous configuration.
        for (path, contents) in [
            ("profiles/acp/cordis.yml", "fixture-profile-route"),
            (".credentials.yaml", "fixture-private-key"),
            ("settings.yaml", "fixture-provider-settings"),
            (
                "profiles/web/cordis.patch.yml",
                r#"[{"id":"llm-pi-ai","config":{"providers":{"web":{"api":"openai-responses"}}}}]"#,
            ),
        ] {
            fs::write(root.join(path), contents).unwrap();
            let next = configuration_digest(&root, &root).unwrap();
            assert_ne!(previous, next, "{path} must fence native configuration");
            assert_eq!(next, configuration_digest(&root, &root).unwrap());
            assert!(!next.contains(contents));
            previous = next;
        }
        let web = root.join("profiles/web/cordis.patch.yml");
        fs::write(&web, r#"[{"id":"web-ui","config":{"theme":"dark"}},{"id":"llm-pi-ai","config":{"providers":{"web":{"api":"openai-responses"}}}}]"#).unwrap();
        assert_eq!(previous, configuration_digest(&root, &root).unwrap());
        let bytes = fs::read(&web).unwrap();
        let preparation = json!({"schemaVersion":1,"status":"ready","inputs":[{"path":web,"digest":format!("{:x}",Sha256::digest(&bytes))}]});
        assert!(model_inputs_unchanged(&preparation));
        fs::write(
            root.join("models.result.json"),
            serde_json::to_vec(&preparation).unwrap(),
        )
        .unwrap();
        fs::write(
            &web,
            String::from_utf8(bytes).unwrap().replace("dark", "light"),
        )
        .unwrap();
        assert_eq!(previous, configuration_digest(&root, &root).unwrap());
        assert!(
            !model_inputs_unchanged(&preparation),
            "publication must discard an obsolete probe"
        );
        assert_eq!(
            await_model_preparation(&root).await.unwrap(),
            preparation,
            "a compatible prepared Host reads its result without rechecking raw inputs"
        );
        fs::write(&web, "[]").unwrap();
        assert!(!model_inputs_unchanged(&preparation));
        assert_ne!(previous, configuration_digest(&root, &root).unwrap());
        fs::remove_file(root.join("settings.yaml")).unwrap();
        fs::create_dir(root.join("settings.yaml")).unwrap();
        assert!(configuration_digest(&root, &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn dsh_model_options_context_normalizes_paths_and_preserves_invalidation() {
        use crate::runtime_discovery::{
            RuntimeSearchEnvironment, runtime_visible_path, with_runtime_configuration,
        };
        use crate::runtime_startup::{RuntimeEnvironmentVariable, RuntimeStartupConfiguration};

        let root = std::env::temp_dir().join(format!("rovai-dsh-context-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("dsh.cmd");
        fs::write(&executable, "fixture-executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let canonical = executable.canonicalize().unwrap();
        let visible = runtime_visible_path(canonical.clone());
        #[cfg(windows)]
        assert_ne!(canonical, visible, "exercise both Windows path spellings");
        let kind = AdapterKind::DeepseekHarness;
        let configuration = RuntimeStartupConfiguration {
            environment: vec![RuntimeEnvironmentVariable {
                name: "DSH_HOME".to_string(),
                value: root.to_string_lossy().into_owned(),
            }],
            ..Default::default()
        };
        let search = RuntimeSearchEnvironment::for_test_paths(1, vec![])
            .with_startup_configuration(kind, configuration.clone());
        let original = with_runtime_configuration(kind, &search, async {
            let original = model_options_context(&visible).unwrap();
            assert_eq!(original, model_options_context(&canonical).unwrap());
            fs::write(root.join("settings.yaml"), "fixture-model-configuration").unwrap();
            let configured = model_options_context(&visible).unwrap();
            assert_ne!(
                original, configured,
                "model configuration still invalidates"
            );
            assert_eq!(configured, model_options_context(&canonical).unwrap());
            fs::write(&executable, "changed-fixture-executable-with-new-size").unwrap();
            let replaced = model_options_context(&visible).unwrap();
            assert_ne!(
                configured, replaced,
                "executable identity still invalidates"
            );
            assert_eq!(replaced, model_options_context(&canonical).unwrap());
            replaced
        })
        .await;
        let mut changed_environment = configuration;
        changed_environment
            .environment
            .push(RuntimeEnvironmentVariable {
                name: "ROVAI_DSH_CONTEXT_FIXTURE".to_string(),
                value: "changed".to_string(),
            });
        let changed_search = search.with_startup_configuration(kind, changed_environment);
        with_runtime_configuration(kind, &changed_search, async {
            assert_ne!(original, model_options_context(&visible).unwrap());
            assert_eq!(
                model_options_context(&visible).unwrap(),
                model_options_context(&canonical).unwrap()
            );
        })
        .await;
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dsh_version_requires_the_first_acp_release() {
        for value in [
            None,
            Some("0.1.0-rc.5"),
            Some("0.1.5-rc.1"),
            Some("0.1.5-beta.8"),
            Some("0.0.1"),
            Some("invalid"),
        ] {
            assert!(!supported_version(value), "{value:?}");
        }
        for value in [
            "0.1.5-rc.2",
            "0.1.5-rc.10",
            "0.1.5-rc.2+build.1",
            "0.1.5",
            "0.1.6",
        ] {
            assert!(supported_version(Some(value)), "{value}");
        }
    }

    #[test]
    fn dsh_observation_is_exact_consumed_once_and_never_infers_exit_from_text() {
        let root =
            std::env::temp_dir().join(format!("rovai-dsh-observation-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("observations")).unwrap();
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!(["session-a", "call-a"])).unwrap())
        );
        let file = root.join("observations").join(format!("{key}.json"));
        let mut message = json!({"method":"session/update","params":{"sessionId":"session-a","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-a","status":"completed","content":[{"type":"content","content":{"type":"text","text":"[exit code: 0]"}}]}}});
        fs::write(&file,serde_json::to_vec(&json!({"schemaVersion":1,"sessionId":"session-b","callId":"call-a","tool":"bash","isError":false,"exitCode":7})).unwrap()).unwrap();
        assert!(enrich_message(&root, &mut message).is_err());
        assert!(file.exists());
        fs::write(&file,serde_json::to_vec(&json!({"schemaVersion":1,"sessionId":"session-a","callId":"call-a","tool":"bash","isError":false,"exitCode":7})).unwrap()).unwrap();
        enrich_message(&root, &mut message).unwrap();
        assert_eq!(message["params"]["update"]["status"], "failed");
        assert_eq!(message["params"]["update"]["kind"], "execute");
        assert_eq!(message["params"]["update"]["rawOutput"]["exitCode"], 7);
        assert!(!file.exists());
        assert!(enrich_message(&root, &mut message).is_err());
        let mut unknown = json!({"method":"session/update","params":{"sessionId":"session-a","update":{"sessionUpdate":"tool_call","title":"unknown_tool","kind":"other"}}});
        enrich_message(&root, &mut unknown).unwrap();
        assert_eq!(unknown["params"]["update"]["kind"], "other");
        let prefix = format!("{:x}.usage-12.json", Sha256::digest(b"session-a"));
        fs::write(root.join("observations").join(prefix), serde_json::to_vec(&json!({"schemaVersion":1,"sessionId":"session-a","seq":12,"turn":1,"usage":{"inputTokens":20,"cacheReadTokens":80,"outputTokens":3}})).unwrap()).unwrap();
        let mut usage = json!({"method":"session/update","params":{"sessionId":"session-a","update":{"sessionUpdate":"usage_update","used":100,"size":1000}}});
        enrich_message(&root, &mut usage).unwrap();
        assert_eq!(
            usage.pointer("/params/update/_meta/dshUsage/0/usage/inputTokens"),
            Some(&json!(20))
        );
        enrich_message(&root, &mut usage).unwrap();
        assert_eq!(
            usage.pointer("/params/update/_meta/dshUsage"),
            Some(&json!([]))
        );

        let write_key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!(["session-a", "call-write"])).unwrap())
        );
        let write_file = root.join("observations").join(format!("{write_key}.json"));
        fs::write(
            &write_file,
            serde_json::to_vec(&json!({
                "schemaVersion":1,"sessionId":"session-a","callId":"call-write",
                "tool":"edit","isError":false,"path":"/workspace/example.txt",
                "before":"old\n","after":"new\n"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut write = json!({"method":"session/update","params":{"sessionId":"session-a","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-write","status":"completed","content":[]}}});
        enrich_message(&root, &mut write).unwrap();
        assert_eq!(
            write.pointer("/params/update/content/0"),
            Some(
                &json!({"type":"diff","path":"/workspace/example.txt","oldText":"old\n","newText":"new\n"})
            )
        );
        assert_eq!(
            write.pointer("/params/update/locations/0/path"),
            Some(&json!("/workspace/example.txt"))
        );

        let create_key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!(["session-a", "call-create"])).unwrap())
        );
        fs::write(
            root.join("observations").join(format!("{create_key}.json")),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"sessionId":"session-a","callId":"call-create",
                "tool":"write","isError":false,"path":"/workspace/created.txt",
                "before":null,"after":"created\n"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut create = json!({"method":"session/update","params":{"sessionId":"session-a","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-create","status":"completed","content":[]}}});
        enrich_message(&root, &mut create).unwrap();
        assert_eq!(
            create.pointer("/params/update/content/0"),
            Some(
                &json!({"type":"diff","path":"/workspace/created.txt","oldText":null,"newText":"created\n"})
            )
        );
        assert_eq!(
            create.pointer("/params/update/locations/0/path"),
            Some(&json!("/workspace/created.txt"))
        );

        for (call_id, tool, observation) in [
            (
                "call-write-missing-before",
                "write",
                json!({"path":"/workspace/missing-before.txt","after":"created\n"}),
            ),
            (
                "call-write-missing-after",
                "write",
                json!({"path":"/workspace/missing-after.txt","before":null}),
            ),
            (
                "call-write-malformed-before",
                "write",
                json!({"path":"/workspace/malformed-before.txt","before":0,"after":"created\n"}),
            ),
            (
                "call-edit-null-before",
                "edit",
                json!({"path":"/workspace/invalid-edit.txt","before":null,"after":"changed\n"}),
            ),
            (
                "call-edit-malformed-after",
                "edit",
                json!({"path":"/workspace/malformed-edit.txt","before":"old\n","after":null}),
            ),
        ] {
            let key = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&json!(["session-a", call_id])).unwrap())
            );
            let mut status = json!({
                "schemaVersion":1,"sessionId":"session-a","callId":call_id,
                "tool":tool,"isError":false
            });
            status.as_object_mut().unwrap().extend(
                observation
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
            fs::write(
                root.join("observations").join(format!("{key}.json")),
                serde_json::to_vec(&status).unwrap(),
            )
            .unwrap();
            let mut fallback = json!({"method":"session/update","params":{"sessionId":"session-a","update":{"sessionUpdate":"tool_call_update","toolCallId":call_id,"status":"completed","content":[]}}});
            enrich_message(&root, &mut fallback).unwrap();
            assert_eq!(fallback.pointer("/params/update/content"), Some(&json!([])));
            assert_eq!(
                fallback.pointer("/params/update/locations/0/path"),
                observation.get("path")
            );
        }

        let fallback_key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!(["session-a", "call-fallback"])).unwrap())
        );
        fs::write(
            root.join("observations")
                .join(format!("{fallback_key}.json")),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"sessionId":"session-a","callId":"call-fallback",
                "tool":"write","isError":false,"path":"/workspace/large.txt",
                "before":"","after":"x".repeat(MAX_OBSERVED_FILE_CONTENT_BYTES + 1)
            }))
            .unwrap(),
        )
        .unwrap();
        let mut fallback = json!({"method":"session/update","params":{"sessionId":"session-a","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-fallback","status":"completed","content":[]}}});
        enrich_message(&root, &mut fallback).unwrap();
        assert_eq!(fallback.pointer("/params/update/content"), Some(&json!([])));
        assert_eq!(
            fallback.pointer("/params/update/locations/0/path"),
            Some(&json!("/workspace/large.txt"))
        );
        for (tool, kind) in [
            ("bash", Some("execute")),
            ("read_image", Some("read")),
            ("glob", Some("file_search")),
            ("grep", Some("file_search")),
            ("web_search", Some("web_search")),
            ("web_fetch", Some("fetch")),
            ("skill", Some("tool")),
            ("unknown", None),
        ] {
            assert_eq!(tool_kind(tool), kind, "{tool}");
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn responses_tool_defaults_preserve_native_overrides_and_private_settings() {
        // The same native ID is usable as a native choice, never as a failed Web choice.
        for preparation in [
            json!({"rejectedProviders":["web"]}),
            json!({"webUnavailable":true,"webProviders":["known-web"]}),
        ] {
            for provider in ["native", "web", "other-plugin", "builtin"] {
                let id = json!([provider, "same-model"]).to_string();
                assert!(selected_route_available(
                    &preparation,
                    &id,
                    Some(DshModelSource::Native)
                ));
                assert!(selected_route_available(&preparation, &id, None));
                assert!(!selected_route_available(
                    &preparation,
                    &id,
                    Some(DshModelSource::Web)
                ));
            }
        }
        let available = json!({"webProviders":["web"]});
        assert!(selected_route_available(
            &available,
            r#"["web","same-model"]"#,
            Some(DshModelSource::Web)
        ));
        assert!(!selected_route_available(
            &available,
            r#"["web","same-model"]"#,
            Some(DshModelSource::Native)
        ));
        let root =
            std::env::temp_dir().join(format!("rovai-dsh-responses-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.yaml");
        let settings = json!({
            "llm-pi-ai":{"providers":{
                "gateway":{"api":"openai-responses","baseURL":"https://private.invalid/v1",
                    "headers":{"Authorization":"private-test-credential"},
                    "models":[{"id":"model","compat":{"supportsStrictMode":false}}]},
                "explicit-off":{"api":"openai-responses","compat":{"supportsStrictMode":false}},
                "explicit-on":{"api":"openai-responses","compat":{"supportsStrictMode":true}},
                "invalid-null":{"api":"openai-responses","compat":{"supportsStrictMode":null}},
                "completions":{"api":"openai-completions"},
                "anthropic":{"api":"anthropic-messages"},
                "native-default":{}
            }},
            "unrelated":{"credential":"another-private-test-value"}
        });
        let original = serde_yaml::to_string(&settings).unwrap();
        fs::write(&path, &original).unwrap();
        let mut command = Command::new("dsh");
        configure_host(
            &mut command,
            &root,
            &root,
            &json!({"sandbox_mode":"workspace-write","approval_policy":"ask"}),
            &[],
        )
        .unwrap();
        let patch = fs::read_to_string(root.join("rovai.patch.json")).unwrap();
        assert!(!patch.contains("private-test"));
        assert!(!patch.contains("private.invalid"));
        assert!(!patch.contains("\"models\""));
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let rows: Value = serde_json::from_str(&patch).unwrap();
        assert!(
            rows.as_array()
                .unwrap()
                .iter()
                .all(|row| row["id"] != "llm-pi-ai")
        );
        assert_eq!(rows[5]["insert"][0]["id"], "rovai-model-configuration");
        let mut probe = Command::new("dsh");
        configure_probe(&mut probe, &root).unwrap();
        let probe_patch: Value =
            serde_json::from_slice(&fs::read(root.join("models.patch.json")).unwrap()).unwrap();
        assert_eq!(probe_patch[0], rows[5]);
        // Compatibility field precedence is owned by dsh-host.test.mjs, where
        // the in-process transformation now runs. The command never reads keys.
        fs::write(&path, "credential: [private-test-credential").unwrap();
        configure_probe(&mut probe, &root).unwrap();
        assert!(
            !fs::read_to_string(root.join("models.patch.json"))
                .unwrap()
                .contains("private-test")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn frozen_permissions_preserve_native_values_without_rewriting_native_home() {
        let root =
            std::env::temp_dir().join(format!("rovai-dsh-permissions-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for sandbox in ["read-only", "workspace-write", "danger-full-access"] {
            for approval in ["ask", "never"] {
                let mut command = Command::new("dsh");
                configure_host(
                    &mut command,
                    &root,
                    &root,
                    &json!({"sandbox_mode":sandbox,"approval_policy":approval}),
                    &[],
                )
                .unwrap();
                let patch: Value =
                    serde_json::from_slice(&fs::read(root.join("rovai.patch.json")).unwrap())
                        .unwrap();
                assert_eq!(patch[0]["config"]["mode"], sandbox);
                assert_eq!(patch[1]["config"]["policy"], approval);
                assert_eq!(patch[2], json!({"id":"permission","disabled":true}));
                assert_eq!(
                    patch[3],
                    json!({"id":"acp","inject":["acpAppStartup","rovaiDshReady"]})
                );
                assert!(patch[4]["insert"][0]["config"].get("readOnly").is_none());
                assert!(
                    patch[4]["insert"][0]["config"]
                        .get("approvalPolicy")
                        .is_none()
                );
                assert!(
                    command
                        .as_std()
                        .get_envs()
                        .all(|(key, _)| key != "DSH_HOME")
                );
            }
        }
        fs::remove_dir_all(root).unwrap();
    }
}
