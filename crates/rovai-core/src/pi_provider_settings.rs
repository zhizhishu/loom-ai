//! The single Pi provider section LOOM edits, plus the environment-referenced key it uses.
//!
//! Pi reads `<agent dir>/models.json` and `<agent dir>/settings.json`. The product exports
//! `PI_CODING_AGENT_DIR=<data>/runtime-home/pi` for the same data root this Core owns
//! (scripts/manage-loom-personal.sh:75, scripts/manage-loom-personal.ps1:276), so the files
//! edited here are exactly the ones a Run reads.
//!
//! The credential never reaches disk: `models.json` keeps `apiKey: "$ENV_NAME"` (Pi resolves
//! `$NAME` through dist/core/resolve-config-value.js, the contract mirrored by
//! scripts/loom-v2-runtime-execution.mjs:333-376) and the value lives in the existing encrypted
//! shared runtime environment (`member_environment::common`). Only that one provider section and
//! `defaultProvider`/`defaultModel` are written; every other key of both files is preserved.
use crate::{agent_profile::AdapterKind, db::Database, member_environment::common};
use anyhow::{Context, Result, ensure};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::path::{Component, Path, PathBuf};

/// The one provider section this editor owns. No second provider is created or edited.
pub const PROVIDER_ID: &str = "loom";
/// Environment name `models.json` references. The value is stored encrypted, never inline.
pub const API_KEY_ENV: &str = "OCT_API_KEY";
const DEFAULT_API: &str = "openai-completions";
/// Numbers a model created through the settings form carries; a profile written by
/// scripts/loom-v2-runtime-execution.mjs:333-376 always keeps the Run's own values instead.
const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
const DEFAULT_MAX_TOKENS: u64 = 32_768;
const MODELS_FILE: &str = "models.json";
const SETTINGS_FILE: &str = "settings.json";
const MODELS_LABEL: &str = "Pi 的 models.json";
const SETTINGS_LABEL: &str = "Pi 的 settings.json";

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

fn normalized_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
}

/// A configuration file is only ever the direct child of the admitted runtime home.
fn confined_file(home: &Path, name: &str) -> Result<PathBuf> {
    ensure!(normalized_absolute(home), "Pi 运行目录必须是规范化的绝对路径。");
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

fn reject_symlink(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => ensure!(
            !metadata.file_type().is_symlink(),
            "Pi 配置文件不能是指向别处的符号链接。"
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
    let section = section
        .as_object()
        .with_context(|| format!("{MODELS_LABEL} 中的 {PROVIDER_ID} 连接必须是一个对象；未写入任何修改。"))?;
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
    characters[characters.len().saturating_sub(4)..].iter().collect()
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
        .or_else(|| {
            model_ids
                .first()
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
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

/// Stores the key through the existing encrypted shared environment revision.
fn save_key(database: &mut Database, api_key: &str, expected_revision: i64) -> Result<()> {
    let mut values = common::current(database.connection(), AdapterKind::Pi)?;
    values.insert(API_KEY_ENV.to_owned(), api_key.to_owned());
    let prepared = common::prepare(
        database.connection(),
        AdapterKind::Pi,
        common::Edit {
            expected_revision,
            json: serde_json::to_string(&values)?,
        },
    )?;
    let transaction = database.connection_mut().transaction()?;
    prepared.commit(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub fn save(database: &mut Database, data_dir: &Path, params: SaveParams) -> Result<Value> {
    let home = runtime_home(data_dir);
    let models_path = confined_file(&home, MODELS_FILE)?;
    let settings_path = confined_file(&home, SETTINGS_FILE)?;
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
    reject_symlink(&models_path)?;
    reject_symlink(&settings_path)?;
    // Corrupt JSON stops here, before the encrypted key or either file is touched.
    let mut models = read_json(&models_path, MODELS_LABEL)?;
    let mut settings = read_json(&settings_path, SETTINGS_LABEL)?;
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
        .with_context(|| format!("{MODELS_LABEL} 中的 providers 必须是一个对象；未写入任何修改。"))?;
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
    if let Some(api_key) = api_key {
        save_key(database, api_key, params.key_revision)?;
    }
    write_json(&models_path, &models)?;
    write_json(&settings_path, &settings)?;
    get(database.connection(), data_dir)
}

#[cfg(test)]
mod tests;
