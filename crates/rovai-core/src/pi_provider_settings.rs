//! The single Pi provider section LOOM edits, plus the environment-referenced key it uses.
//!
//! Pi reads `<agent dir>/models.json` and `<agent dir>/settings.json`. The product exports
//! `PI_CODING_AGENT_DIR=<data>/runtime-home/pi` for the same data root this Core owns
//! (scripts/manage-loom-personal.sh:75, scripts/manage-loom-personal.ps1:276), so the files
//! edited here are exactly the ones a Run reads.
//!
//! The same save also owns the two entries LOOM needs in the DeepSeek Harness ACP profile patch
//! (`<data>/runtime-home/dsh/profiles/acp/cordis.patch.yml`, exported as `DSH_HOME` by the same
//! manage scripts): the fixed `relay` provider and the explicit ACP default route. Every other
//! patch entry and every other field of those two entries is parsed and preserved.
//!
//! The credential never reaches disk: `models.json` keeps `apiKey: "$ENV_NAME"` (Pi resolves
//! `$NAME` through dist/core/resolve-config-value.js, the contract mirrored by
//! scripts/loom-v2-runtime-execution.mjs:333-376) and the value lives in the existing encrypted
//! shared runtime environment (`member_environment::common`) for both Pi and DeepSeek Harness.
//! Only that one provider section and `defaultProvider`/`defaultModel` are written; every other
//! key of both files is preserved.
use crate::{agent_profile::AdapterKind, db::Database, member_environment::common};
use anyhow::{Context, Result, ensure};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// The one provider section this editor owns. No second provider is created or edited.
pub const PROVIDER_ID: &str = "loom";
/// Environment name `models.json` references. The value is stored encrypted, never inline.
pub const API_KEY_ENV: &str = "OCT_API_KEY";
/// The fixed DSH ACP provider and model LOOM owns in the native profile patch.
const DSH_PROVIDER_ID: &str = "relay";
const DSH_MODEL_ID: &str = "deepseek-v4.1-flash";
const DSH_CONTEXT_WINDOW: u64 = 1_000_000;
const DSH_MAX_TOKENS: u64 = 384_000;
const DSH_MODEL_PLUGIN_ID: &str = "llm-pi-ai";
const DSH_ACP_ENTRY_ID: &str = "acp";
const DEFAULT_API: &str = "openai-completions";
/// Numbers a model created through the settings form carries; a profile written by
/// scripts/loom-v2-runtime-execution.mjs:333-376 always keeps the Run's own values instead.
const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
const DEFAULT_MAX_TOKENS: u64 = 32_768;
const MODELS_FILE: &str = "models.json";
const SETTINGS_FILE: &str = "settings.json";
const DSH_PATCH_FILE: &str = "cordis.patch.yml";
const MODELS_LABEL: &str = "Pi 的 models.json";
const SETTINGS_LABEL: &str = "Pi 的 settings.json";
const DSH_PATCH_LABEL: &str = "DSH 的 profiles/acp/cordis.patch.yml";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveParams {
    pub base_url: String,
    pub model_id: String,
    /// Omitted when the user keeps the stored key.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Shared environment revision the form was rendered from; a concurrent edit is refused.
    pub key_revision: i64,
}

/// `<data>/runtime-home/pi` — the directory the product exports as `PI_CODING_AGENT_DIR`.
pub fn runtime_home(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime-home").join("pi")
}

/// `<data>/runtime-home/dsh` — the directory the product exports as `DSH_HOME`.
pub fn dsh_home(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime-home").join("dsh")
}

/// The one native profile patch LOOM edits. It is always inside the admitted DSH home.
fn dsh_patch_file(data_dir: &Path) -> Result<PathBuf> {
    let home = dsh_home(data_dir);
    ensure!(
        normalized_absolute(&home),
        "DSH 运行目录必须是规范化的绝对路径。"
    );
    let profiles = home.join("profiles");
    let acp = profiles.join("acp");
    let path = acp.join(DSH_PATCH_FILE);
    ensure!(
        path.starts_with(&home) && path.parent() == Some(acp.as_path()),
        "DSH 配置文件必须位于 DSH 运行目录内。"
    );
    Ok(path)
}

fn normalized_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
}

/// A configuration file is only ever the direct child of the admitted runtime home.
fn confined_file(home: &Path, name: &str) -> Result<PathBuf> {
    ensure!(
        normalized_absolute(home),
        "Pi 运行目录必须是规范化的绝对路径。"
    );
    let relative = Path::new(name);
    ensure!(
        relative.components().count() == 1
            && matches!(relative.components().next(), Some(Component::Normal(_))),
        "Pi 配置文件必须直接位于运行目录内。"
    );
    let path = home.join(relative);
    ensure!(
        path.parent() == Some(home),
        "Pi 配置文件必须直接位于运行目录内。"
    );
    Ok(path)
}

fn reject_symlink(path: &Path, label: &str) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => ensure!(
            !metadata.file_type().is_symlink(),
            "{label}不能是指向别处的符号链接。"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn read_json(path: &Path, label: &str) -> Result<Map<String, Value>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        // A missing file is an empty configuration, not an error.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error).with_context(|| format!("无法读取 {label}。")),
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("{label} 不是有效的 JSON；未写入任何修改。"))?;
    match value {
        Value::Object(object) => Ok(object),
        _ => anyhow::bail!("{label} 必须是一个 JSON 对象；未写入任何修改。"),
    }
}

fn write_json(path: &Path, document: &Map<String, Value>) -> Result<()> {
    let text = format!("{}\n", serde_json::to_string_pretty(document)?);
    let name = path
        .file_name()
        .context("Pi 配置文件名无效。")?
        .to_string_lossy()
        .into_owned();
    let temporary = path.with_file_name(format!("{name}.tmp"));
    std::fs::write(&temporary, text.as_bytes())?;
    // Replaces the previous file in one step, so a failure never truncates valid JSON.
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

fn yaml_key(name: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(name.to_owned())
}

fn child_object_mut<'a>(
    parent: &'a mut serde_yaml::Mapping,
    name: &str,
    label: &str,
) -> Result<&'a mut serde_yaml::Mapping> {
    let key = yaml_key(name);
    if !parent.contains_key(&key) {
        parent.insert(
            key.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    parent
        .get_mut(&key)
        .context("DSH 配置结构在读取后发生变化；未写入任何修改。")?
        .as_mapping_mut()
        .with_context(|| format!("{label} 必须是一个对象；未写入任何修改。"))
}

/// The owned entry is addressed by its own id, so every other entry stays untouched.
fn owned_entry_mut<'a>(
    entries: &'a mut Vec<serde_yaml::Value>,
    id: &str,
) -> Result<&'a mut serde_yaml::Mapping> {
    if let Some(index) = entries.iter().position(|entry| {
        entry
            .as_mapping()
            .and_then(|mapping| mapping.get(&yaml_key("id")))
            .and_then(serde_yaml::Value::as_str)
            == Some(id)
    }) {
        return entries[index].as_mapping_mut().with_context(|| {
            format!("{DSH_PATCH_LABEL} 中的 {id} 条目必须是一个对象；未写入任何修改。")
        });
    }
    let mut mapping = serde_yaml::Mapping::new();
    mapping.insert(yaml_key("id"), serde_yaml::Value::String(id.to_owned()));
    entries.push(serde_yaml::Value::Mapping(mapping));
    let index = entries.len() - 1;
    entries[index]
        .as_mapping_mut()
        .context("无法创建 DSH 配置条目；未写入任何修改。")
}

fn read_patch(path: &Path) -> Result<Vec<serde_yaml::Value>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("无法读取 {DSH_PATCH_LABEL}。")),
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    let value: serde_yaml::Value = serde_yaml::from_slice(&bytes)
        .with_context(|| format!("{DSH_PATCH_LABEL} 不是有效的 YAML/JSON；未写入任何修改。"))?;
    match value {
        serde_yaml::Value::Sequence(entries) => Ok(entries),
        _ => anyhow::bail!("{DSH_PATCH_LABEL} 必须是 YAML/JSON 数组；未写入任何修改。"),
    }
}

/// Replace only `config.providers.relay` and the two ACP route fields; preserve all else.
fn update_patch(entries: &mut Vec<serde_yaml::Value>, base_url: &str) -> Result<()> {
    let relay = serde_yaml::to_value(json!({
        "api": "openai-responses",
        "baseURL": base_url,
        "apiKeyEnv": API_KEY_ENV,
        "models": [{
            "id": DSH_MODEL_ID,
            "contextWindow": DSH_CONTEXT_WINDOW,
            "maxTokens": DSH_MAX_TOKENS,
        }],
    }))
    .context("无法构造 DSH relay 配置；未写入任何修改。")?;
    let entry = owned_entry_mut(entries, DSH_MODEL_PLUGIN_ID)?;
    let config = child_object_mut(entry, "config", "DSH 的 llm-pi-ai config")?;
    let providers = child_object_mut(config, "providers", "DSH 的 llm-pi-ai providers")?;
    providers.insert(yaml_key(DSH_PROVIDER_ID), relay);

    let entry = owned_entry_mut(entries, DSH_ACP_ENTRY_ID)?;
    let config = child_object_mut(entry, "config", "DSH 的 acp config")?;
    config.insert(
        yaml_key("provider"),
        serde_yaml::Value::String(DSH_PROVIDER_ID.to_owned()),
    );
    config.insert(
        yaml_key("model"),
        serde_yaml::Value::String(DSH_MODEL_ID.to_owned()),
    );
    Ok(())
}

/// Temporary file plus rename keeps the previous patch intact on every failure.
fn write_patch(path: &Path, entries: &[serde_yaml::Value]) -> Result<()> {
    let parent = path.parent().context("DSH 配置文件路径无效。")?;
    let name = path
        .file_name()
        .context("DSH 配置文件名无效。")?
        .to_string_lossy()
        .into_owned();
    let document = serde_yaml::Value::Sequence(entries.to_vec());
    let mut text = serde_yaml::to_string(&document)
        .with_context(|| format!("无法序列化 {DSH_PATCH_LABEL}；未写入任何修改。"))?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let temporary = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .with_context(|| format!("无法创建 {DSH_PATCH_LABEL} 的临时文件。"))?;
    let result = (|| -> Result<()> {
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
        }
        reject_symlink(path, DSH_PATCH_LABEL)?;
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        {
            let _ = std::fs::File::open(parent).and_then(|directory| directory.sync_all());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.with_context(|| format!("无法写入 {DSH_PATCH_LABEL}；未写入任何修改。"))
}

/// `$NAME` is the only accepted `apiKey` form; a plaintext key is never read or written.
fn env_reference(value: &str) -> Option<&str> {
    let name = value.strip_prefix('$')?;
    let mut characters = name.chars();
    let first = characters.next()?;
    if !(first.is_ascii_uppercase() || first == '_') {
        return None;
    }
    name.chars()
        .all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
        .then_some(name)
}

fn section(models: &Map<String, Value>) -> Result<Option<&Map<String, Value>>> {
    let Some(section) = models
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(PROVIDER_ID))
    else {
        return Ok(None);
    };
    let section = section.as_object().with_context(|| {
        format!("{MODELS_LABEL} 中的 {PROVIDER_ID} 连接必须是一个对象；未写入任何修改。")
    })?;
    if let Some(api_key) = section.get("apiKey") {
        let api_key = api_key.as_str().with_context(|| {
            format!("{MODELS_LABEL} 中的 apiKey 必须是 $ENV 形式的环境变量引用；未写入任何修改。")
        })?;
        ensure!(
            env_reference(api_key).is_some(),
            "{MODELS_LABEL} 中的 apiKey 必须是 $ENV 形式的环境变量引用（例如 $OCT_API_KEY）；明文 Key 不被接受，未写入任何修改。"
        );
    }
    Ok(Some(section))
}

fn text<'a>(section: Option<&'a Map<String, Value>>, field: &str) -> &'a str {
    section
        .and_then(|section| section.get(field))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn last4(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    characters[characters.len().saturating_sub(4)..]
        .iter()
        .collect()
}

/// Current configuration, reported without the key and without any host path.
pub fn get(connection: &Connection, data_dir: &Path) -> Result<Value> {
    let home = runtime_home(data_dir);
    let models = read_json(&confined_file(&home, MODELS_FILE)?, MODELS_LABEL)?;
    let settings = read_json(&confined_file(&home, SETTINGS_FILE)?, SETTINGS_LABEL)?;
    snapshot(connection, section(&models)?, &settings)
}

fn snapshot(
    connection: &Connection,
    section: Option<&Map<String, Value>>,
    settings: &Map<String, Value>,
) -> Result<Value> {
    let model_ids: Vec<Value> = section
        .and_then(|section| section.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("id").and_then(Value::as_str))
                .map(|id| json!(id))
                .collect()
        })
        .unwrap_or_default();
    let api_key_env = section
        .and_then(|section| section.get("apiKey"))
        .and_then(Value::as_str)
        .and_then(env_reference)
        .map(str::to_owned);
    // `defaultModel` belongs to this section only while this section is the default provider.
    let is_default = settings.get("defaultProvider").and_then(Value::as_str) == Some(PROVIDER_ID);
    let model_id = is_default
        .then(|| settings.get("defaultModel").and_then(Value::as_str))
        .flatten()
        .map(str::to_owned)
        .or_else(|| model_ids.first().and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    let stored = common::get(connection, AdapterKind::Pi)?;
    let environment = stored
        .get("environment")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let key = environment
        .get(api_key_env.as_deref().unwrap_or(API_KEY_ENV))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let api = text(section, "api");
    let api = if api.is_empty() { DEFAULT_API } else { api };
    Ok(json!({
        "status": "ready",
        "providerId": PROVIDER_ID,
        "baseUrl": text(section, "baseUrl"),
        "api": api,
        "modelIds": model_ids,
        "modelId": model_id,
        "apiKeyEnv": api_key_env,
        "keyConfigured": key.is_some(),
        "keyLast4": key.map(|value| last4(value)),
        "keyRevision": stored.get("revision").and_then(Value::as_i64).unwrap_or_default(),
    }))
}

fn default_model(model_id: &str) -> Value {
    json!({
        "id": model_id,
        "name": model_id,
        "reasoning": false,
        "input": ["text"],
        "contextWindow": DEFAULT_CONTEXT_WINDOW,
        "maxTokens": DEFAULT_MAX_TOKENS,
    })
}

/// Stores the same key through both independent encrypted shared environments.
fn save_keys(
    database: &mut Database,
    api_key: Option<&str>,
    expected_pi_revision: i64,
) -> Result<()> {
    let stored_pi = common::current(database.connection(), AdapterKind::Pi)?;
    let effective_key = api_key
        .map(str::to_owned)
        .or_else(|| stored_pi.get(API_KEY_ENV).cloned())
        .filter(|value| !value.is_empty())
        .context("请填写 Pi 的 API Key。")?;
    let pi = api_key.map(|_| {
        let mut values = stored_pi;
        values.insert(API_KEY_ENV.to_owned(), effective_key.clone());
        common::prepare(
            database.connection(),
            AdapterKind::Pi,
            common::Edit {
                expected_revision: expected_pi_revision,
                json: serde_json::to_string(&values)?,
            },
        )
    });
    let dsh_expected = common::get(database.connection(), AdapterKind::DeepseekHarness)?
        .get("revision")
        .and_then(Value::as_i64)
        .context("DSH 共享环境版本无效。")?;
    let mut dsh_values = common::current(database.connection(), AdapterKind::DeepseekHarness)?;
    dsh_values.insert(API_KEY_ENV.to_owned(), effective_key);
    let dsh = common::prepare(
        database.connection(),
        AdapterKind::DeepseekHarness,
        common::Edit {
            expected_revision: dsh_expected,
            json: serde_json::to_string(&dsh_values)?,
        },
    )?;
    let pi = pi.transpose()?;
    let transaction = database.connection_mut().transaction()?;
    if let Some(pi) = pi {
        pi.commit(&transaction)?;
    }
    // DSH revisions are independent of Pi's; its own current revision was the expectation.
    dsh.commit(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub fn save(database: &mut Database, data_dir: &Path, params: SaveParams) -> Result<Value> {
    let home = runtime_home(data_dir);
    let models_path = confined_file(&home, MODELS_FILE)?;
    let settings_path = confined_file(&home, SETTINGS_FILE)?;
    let patch_path = dsh_patch_file(data_dir)?;
    let acp_home = patch_path
        .parent()
        .context("DSH 配置文件路径无效。")?
        .to_path_buf();
    let base_url = params.base_url.trim();
    ensure!(!base_url.is_empty(), "请填写网关地址。");
    ensure!(
        base_url.starts_with("https://") || base_url.starts_with("http://"),
        "网关地址必须以 http:// 或 https:// 开头。"
    );
    let model_id = params.model_id.trim();
    ensure!(!model_id.is_empty(), "请填写模型 ID。");
    let api_key = params
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(api_key) = api_key {
        ensure!(
            api_key.len() <= 8192 && !api_key.chars().any(char::is_control),
            "Key 必须是单行文本。"
        );
    }
    // A symlinked home or configuration file is refused before anything is read.
    crate::camp_attachment_view::reject_existing_symlink_components(&home)?;
    std::fs::create_dir_all(&home)?;
    reject_symlink(&models_path, MODELS_LABEL)?;
    reject_symlink(&settings_path, SETTINGS_LABEL)?;
    // Corrupt JSON stops here, before the encrypted key or either file is touched.
    let mut models = read_json(&models_path, MODELS_LABEL)?;
    let mut settings = read_json(&settings_path, SETTINGS_LABEL)?;
    // The DSH patch is parsed even when its directories do not exist yet. A corrupt patch or
    // an owned entry of the wrong shape stops before any key or Pi file is written.
    crate::camp_attachment_view::reject_existing_symlink_components(&dsh_home(data_dir))?;
    crate::camp_attachment_view::reject_existing_symlink_components(&acp_home)?;
    crate::camp_attachment_view::reject_existing_symlink_components(&patch_path)?;
    reject_symlink(&patch_path, DSH_PATCH_LABEL)?;
    let mut patch = read_patch(&patch_path)?;
    update_patch(&mut patch, base_url)?;
    let existing = section(&models)?.cloned();
    let stored_key = common::current(database.connection(), AdapterKind::Pi)?
        .get(API_KEY_ENV)
        .is_some_and(|value| !value.is_empty());
    ensure!(api_key.is_some() || stored_key, "请填写 Pi 的 API Key。");
    let name = existing
        .as_ref()
        .and_then(|section| section.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("LOOM");
    let api = existing
        .as_ref()
        .and_then(|section| section.get("api"))
        .and_then(Value::as_str)
        .filter(|api| !api.is_empty())
        .unwrap_or(DEFAULT_API);
    // A model edited earlier keeps its own numbers; a new id gets the documented fallback.
    let model = existing
        .as_ref()
        .and_then(|section| section.get("models"))
        .and_then(Value::as_array)
        .and_then(|models| {
            models
                .iter()
                .find(|model| model.get("id").and_then(Value::as_str) == Some(model_id))
        })
        .cloned()
        .unwrap_or_else(|| default_model(model_id));
    let providers = models
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .with_context(|| {
            format!("{MODELS_LABEL} 中的 providers 必须是一个对象；未写入任何修改。")
        })?;
    providers.insert(
        PROVIDER_ID.to_owned(),
        json!({
            "name": name,
            "baseUrl": base_url,
            "apiKey": format!("${API_KEY_ENV}"),
            "api": api,
            "models": [model],
        }),
    );
    settings.insert("defaultProvider".into(), json!(PROVIDER_ID));
    settings.insert("defaultModel".into(), json!(model_id));
    // The key is committed first: a later file failure leaves the previous configuration intact.
    save_keys(database, api_key, params.key_revision)?;
    write_json(&models_path, &models)?;
    write_json(&settings_path, &settings)?;
    std::fs::create_dir_all(&acp_home)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&acp_home, std::fs::Permissions::from_mode(0o700))?;
    }
    // Recheck after directory creation so a symlink cannot redirect the final write.
    crate::camp_attachment_view::reject_existing_symlink_components(&dsh_home(data_dir))?;
    crate::camp_attachment_view::reject_existing_symlink_components(&patch_path)?;
    reject_symlink(&patch_path, DSH_PATCH_LABEL)?;
    write_patch(&patch_path, &patch)?;
    get(database.connection(), data_dir)
}

#[cfg(test)]
mod tests;
