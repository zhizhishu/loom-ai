//! Private member configuration and ephemeral CLI launch environments.
use crate::{
    agent_profile::{AdapterKind, ModelSelection},
    platform::private_storage,
    runtime_startup::{RuntimeEnvironmentVariable, RuntimeStartupConfiguration},
};
use anyhow::{Context, Result, ensure};
use ring::aead;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{
    Deserialize, Serialize,
    de::{MapAccess, Visitor},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
};

pub mod common;

type Environment = BTreeMap<String, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentEdit {
    pub expected_revision: i64,
    pub json: String,
    #[serde(default)]
    pub inherit_common: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentUpdateReceipt {
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherit_common: Option<bool>,
}

pub struct PreparedEnvironment {
    pub receipt: EnvironmentUpdateReceipt,
    pub changed: bool,
    ciphertext: Vec<u8>,
    inherit_common: bool,
    member_id: String,
    kind: AdapterKind,
}

/// Built only when creating a CLI. Never serialized into a Conversation or Run.
#[derive(Clone, PartialEq)]
pub struct LaunchEnvironment {
    pub values: Option<Environment>,
    pub overlay: Option<Environment>,
}
impl std::fmt::Debug for LaunchEnvironment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaunchEnvironment").finish_non_exhaustive()
    }
}

/// The existing launch future carries a lookup, not environment values. Fleet's
/// creation closure invokes it after reuse has been ruled out. Probe launches
/// outside that future continue to use their existing Adapter configuration.
#[derive(Clone)]
pub struct LaunchEnvironmentSource {
    pub database: std::sync::Arc<tokio::sync::Mutex<crate::db::Database>>,
    pub member_id: String,
    pub kind: AdapterKind,
}
tokio::task_local! {
    static LAUNCH_SOURCE: LaunchEnvironmentSource;
}
pub async fn with_launch_source<F: std::future::Future>(
    source: LaunchEnvironmentSource,
    future: F,
) -> F::Output {
    LAUNCH_SOURCE.scope(source, future).await
}
pub fn launch_source() -> Option<LaunchEnvironmentSource> {
    LAUNCH_SOURCE.try_with(Clone::clone).ok()
}
pub async fn load_for_launch() -> Result<Option<LaunchEnvironment>> {
    resolve_for_launch(launch_source(), None).await
}
/// The source is explicitly carried into Fleet's spawned creation task; Tokio
/// task locals are not inherited by child tasks.
pub async fn resolve_for_launch(
    source: Option<LaunchEnvironmentSource>,
    fallback: Option<LaunchEnvironment>,
) -> Result<Option<LaunchEnvironment>> {
    match source {
        Some(source) => {
            let database = source.database.lock().await;
            current_for_launch(database.connection(), &source.member_id, source.kind).map(Some)
        }
        None => Ok(fallback),
    }
}

pub fn current_for_launch(
    connection: &Connection,
    member: &str,
    kind: AdapterKind,
) -> Result<LaunchEnvironment> {
    launch_with_host(
        connection,
        member,
        kind,
        crate::runtime_discovery::capture_host_runtime_environment,
    )
}
fn launch_with_host(
    connection: &Connection,
    member: &str,
    kind: AdapterKind,
    capture: impl FnOnce() -> Environment,
) -> Result<LaunchEnvironment> {
    let overlay = effective_overlay(connection, member, kind)?;
    let mut values = capture();
    for (name, value) in &overlay {
        if cfg!(windows) {
            values.retain(|key, _| !key.eq_ignore_ascii_case(name));
        }
        values.insert(name.clone(), value.clone());
    }
    if kind == AdapterKind::ClaudeCodeCli && claude_routing_override(&overlay) {
        values.insert("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".into(), "1".into());
    }
    Ok(LaunchEnvironment {
        values: Some(values),
        overlay: Some(overlay),
    })
}

fn key(connection: &Connection) -> Result<Vec<u8>> {
    let path = PathBuf::from(
        connection
            .path()
            .context("Private environment requires a Host database")?,
    );
    let root = path
        .parent()
        .context("Private environment storage is unavailable")?
        .join("member-environment");
    private_storage::prepare_private_directory(&root)?;
    let path = root.join("key");
    if !path.exists() {
        let has_values: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM member_runtime_environment)
            OR EXISTS(SELECT 1 FROM runtime_environment_legacy)",
            [],
            |r| r.get(0),
        )?;
        let has_common = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='runtime_common_environment')",
            [],
            |r| r.get::<_, bool>(0),
        )? && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM runtime_common_environment)",
            [],
            |r| r.get::<_, bool>(0),
        )?;
        ensure!(
            !has_values && !has_common,
            "Private environment key is missing; restore the original Host key"
        );
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("Private environment key generation failed"))?;
        if let Err(error) = private_storage::create_private_new_file(&path).and_then(|mut file| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok(())
        }) {
            if !path.exists() {
                return Err(error);
            }
        }
    }
    let mut bytes = Vec::new();
    private_storage::open_private_read_file(&path)?
        .take(33)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() == 32, "Private environment key is invalid");
    Ok(bytes)
}
fn encrypt(connection: &Connection, context: &str, value: &impl Serialize) -> Result<Vec<u8>> {
    let secret = aead::UnboundKey::new(&aead::AES_256_GCM, &key(connection)?)
        .map_err(|_| anyhow::anyhow!("Private environment encryption failed"))?;
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce)
        .map_err(|_| anyhow::anyhow!("Private environment nonce generation failed"))?;
    let mut bytes = serde_json::to_vec(value)?;
    aead::LessSafeKey::new(secret)
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(context.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| anyhow::anyhow!("Private environment encryption failed"))?;
    Ok([nonce.as_slice(), bytes.as_slice()].concat())
}
fn decrypt<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    context: &str,
    bytes: &[u8],
) -> Result<T> {
    ensure!(bytes.len() >= 28, "Private environment storage is damaged");
    let secret = aead::UnboundKey::new(&aead::AES_256_GCM, &key(connection)?)
        .map_err(|_| anyhow::anyhow!("Private environment decryption failed"))?;
    let mut buffer = bytes[12..].to_vec();
    let data = aead::LessSafeKey::new(secret)
        .open_in_place(
            aead::Nonce::try_assume_unique_for_key(&bytes[..12]).unwrap(),
            aead::Aad::from(context.as_bytes()),
            &mut buffer,
        )
        .map_err(|_| {
            anyhow::anyhow!("Private environment cannot be read; restore the original Host key")
        })?;
    serde_json::from_slice(data).context("Private environment storage is damaged")
}

// Only credential-bearing names contribute values to output scrubbing.
// AUTH_ENABLED, TOKEN_LIMIT and KEY_PATH are settings, not secrets; their
// values must not become global replacement patterns.
fn credential_variable(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    [
        "KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
        "CREDENTIALS",
        "AUTHORIZATION",
    ]
    .iter()
    .any(|suffix| name == *suffix || name.ends_with(&format!("_{suffix}")))
        || name.ends_with("_ACCESS_KEY_ID")
}
fn context(member: &str, kind: AdapterKind, revision: i64) -> String {
    format!("member:{member}:{}:{revision}", kind.as_str())
}
fn latest(connection: &Connection, member: &str, kind: AdapterKind) -> Result<i64> {
    Ok(connection.query_row("SELECT COALESCE(MAX(revision),0) FROM member_runtime_environment WHERE member_id=?1 AND runtime_kind=?2",
        params![member,kind.as_str()], |r| r.get(0))?)
}
fn read_version(
    connection: &Connection,
    member: &str,
    kind: AdapterKind,
    revision: i64,
) -> Result<Environment> {
    if revision == 0 {
        return Ok(Environment::new());
    }
    let bytes: Vec<u8> = connection.query_row("SELECT ciphertext FROM member_runtime_environment WHERE member_id=?1 AND runtime_kind=?2 AND revision=?3",
        params![member,kind.as_str(),revision], |r| r.get(0)).context("Member environment revision is unavailable")?;
    decrypt(connection, &context(member, kind, revision), &bytes)
}
fn require_member(connection: &Connection, member: &str) -> Result<()> {
    ensure!(
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_profile WHERE id=?1 AND profile_status!='removed')",
            [member],
            |r| r.get::<_, bool>(0)
        )?,
        "Member is unavailable"
    );
    Ok(())
}
pub fn get(connection: &Connection, member: &str, kind: AdapterKind) -> Result<Value> {
    require_member(connection, member)?;
    let revision = latest(connection, member, kind)?;
    let values = read_version(connection, member, kind, revision)?;
    let inherit_common = inheritance(connection, member, kind, revision, &values)?;
    Ok(
        json!({"revision":revision,"environment":values,"inheritCommon":inherit_common,
        "common":common::get(connection,kind)?}),
    )
}

fn inheritance(
    c: &Connection,
    member: &str,
    kind: AdapterKind,
    revision: i64,
    values: &Environment,
) -> Result<bool> {
    let saved: Option<bool> = c.query_row("SELECT inherit_common FROM member_environment_inheritance WHERE member_id=?1 AND runtime_kind=?2 AND revision=?3",
        params![member,kind.as_str(),revision], |r| r.get(0)).optional()?;
    Ok(saved.unwrap_or(values.is_empty()))
}
fn merge_common(
    c: &Connection,
    kind: AdapterKind,
    inherit: bool,
    local: &Environment,
) -> Result<Environment> {
    let mut values = if inherit {
        common::current(c, kind)?
    } else {
        Environment::new()
    };
    // Both saved layers are normalized to uppercase on Windows before persistence.
    values.extend(local.clone());
    parse(&serde_json::to_string(&values)?, cfg!(windows))
}
fn effective_overlay(c: &Connection, member: &str, kind: AdapterKind) -> Result<Environment> {
    let revision = latest(c, member, kind)?;
    let local = read_version(c, member, kind, revision)?;
    merge_common(
        c,
        kind,
        inheritance(c, member, kind, revision, &local)?,
        &local,
    )
}

/// Deserialize directly from text so duplicate JSON names cannot disappear in a map parser.
pub fn parse(text: &str, windows: bool) -> Result<Environment> {
    struct Unique;
    impl<'de> Visitor<'de> for Unique {
        type Value = Environment;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an object with unique environment names and string values")
        }
        fn visit_map<A: MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Environment, A::Error> {
            let mut result = Environment::new();
            while let Some((name, value)) = map.next_entry::<String, String>()? {
                if result.insert(name, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate environment name"));
                }
            }
            Ok(result)
        }
    }
    let mut reader =
        serde_json::Deserializer::from_str(if text.trim().is_empty() { "{}" } else { text });
    let values = serde::de::Deserializer::deserialize_map(&mut reader, Unique).map_err(|_| {
        anyhow::anyhow!("Environment must be a JSON object with unique names and string values")
    })?;
    reader
        .end()
        .map_err(|_| anyhow::anyhow!("Environment JSON is invalid"))?;
    RuntimeStartupConfiguration {
        environment: values
            .iter()
            .map(|(name, value)| RuntimeEnvironmentVariable {
                name: name.clone(),
                value: value.clone(),
            })
            .collect(),
        ..Default::default()
    }
    .validated(windows)?;
    for name in values.keys() {
        ensure!(
            name.trim() == name
                && ![
                    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
                    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
                    "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
                    "PI_TELEMETRY"
                ]
                .iter()
                .any(|n| n.eq_ignore_ascii_case(name)),
            "Environment contains a reserved name"
        );
    }
    Ok(if windows {
        values
            .into_iter()
            .map(|(name, value)| (name.to_ascii_uppercase(), value))
            .collect()
    } else {
        values
    })
}
pub fn prepare(
    connection: &Connection,
    member: &str,
    kind: AdapterKind,
    model: &ModelSelection,
    edit: EnvironmentEdit,
) -> Result<PreparedEnvironment> {
    require_member(connection, member)?;
    ensure!(
        edit.expected_revision >= 0 && edit.expected_revision < i64::MAX,
        "Invalid member environment revision"
    );
    let previous = read_version(connection, member, kind, edit.expected_revision)?;
    let previous_inherit_common =
        inheritance(connection, member, kind, edit.expected_revision, &previous)?;
    let inherit_common = edit.inherit_common.unwrap_or(previous_inherit_common);
    let values = parse(&edit.json, cfg!(windows))?;
    // Preserve command replay/conflict detection without hashing environment values.
    // A committed revision is immutable, so an old command must carry the same private values.
    if latest(connection, member, kind)? > edit.expected_revision {
        ensure!(
            read_version(connection, member, kind, edit.expected_revision + 1)? == values
                && inheritance(
                    connection,
                    member,
                    kind,
                    edit.expected_revision + 1,
                    &values
                )? == inherit_common,
            "Member environment changed; reload the saved configuration"
        );
    }
    validate_model(
        kind,
        model,
        &merge_common(connection, kind, inherit_common, &values)?,
    )?;
    parse(&serde_json::to_string(&values)?, cfg!(windows))?;
    let receipt = EnvironmentUpdateReceipt {
        expected_revision: edit.expected_revision,
        inherit_common: edit.inherit_common,
    };
    Ok(PreparedEnvironment {
        changed: values != previous || inherit_common != previous_inherit_common,
        ciphertext: encrypt(
            connection,
            &context(member, kind, edit.expected_revision + 1),
            &values,
        )?,
        receipt,
        inherit_common,
        member_id: member.into(),
        kind,
    })
}
impl PreparedEnvironment {
    pub fn commit(&self, connection: &Connection) -> Result<()> {
        ensure!(
            latest(connection, &self.member_id, self.kind)? == self.receipt.expected_revision,
            "Member environment changed; reload the saved configuration"
        );
        connection.execute("INSERT INTO member_runtime_environment(member_id,runtime_kind,revision,ciphertext) VALUES(?1,?2,?3,?4)",
            params![self.member_id,self.kind.as_str(),self.receipt.expected_revision+1,self.ciphertext])?;
        connection.execute("INSERT INTO member_environment_inheritance(member_id,runtime_kind,revision,inherit_common) VALUES(?1,?2,?3,?4)",
            params![self.member_id,self.kind.as_str(),self.receipt.expected_revision+1,self.inherit_common])?;
        Ok(())
    }
}

fn validate_model(kind: AdapterKind, model: &ModelSelection, values: &Environment) -> Result<()> {
    ensure!(
        kind != AdapterKind::ClaudeCodeCli
            || !matches!(model, ModelSelection::Explicit { .. })
            || !values.keys().any(|name| if cfg!(windows) {
                name.eq_ignore_ascii_case("ANTHROPIC_MODEL")
            } else {
                name == "ANTHROPIC_MODEL"
            }),
        "Remove ANTHROPIC_MODEL or select the Runtime default model"
    );
    Ok(())
}

pub fn validate_saved_model(
    connection: &Connection,
    member: &str,
    kind: AdapterKind,
    model: &ModelSelection,
) -> Result<()> {
    if kind == AdapterKind::ClaudeCodeCli && matches!(model, ModelSelection::Explicit { .. }) {
        validate_model(kind, model, &effective_overlay(connection, member, kind)?)?;
    }
    Ok(())
}

pub(crate) fn configure_values(command: &mut tokio::process::Command, values: &Environment) {
    // ManagedProcess captures explicit env/remove operations; stable Command APIs
    // do not expose env_clear. Preserve that boundary for both pipes and PTYs.
    for (key, _) in std::env::vars_os() {
        let present = key.to_str().is_some_and(|name| {
            values.keys().any(|candidate| {
                if cfg!(windows) {
                    candidate.eq_ignore_ascii_case(name)
                } else {
                    candidate == name
                }
            })
        });
        if !present {
            command.env_remove(key);
        }
    }
    command.envs(values);
}

pub(crate) fn claude_routing_override(overlay: &Environment) -> bool {
    overlay.keys().any(|name| {
        matches!(
            name.as_str(),
            "ANTHROPIC_BASE_URL"
                | "ANTHROPIC_API_KEY"
                | "ANTHROPIC_AUTH_TOKEN"
                | "CLAUDE_CODE_OAUTH_TOKEN"
        ) || name.starts_with("CLAUDE_CODE_USE_")
    })
}

impl LaunchEnvironment {
    pub fn has_overlay(&self) -> bool {
        self.overlay
            .as_ref()
            .is_some_and(|values| !values.is_empty())
    }

    pub fn validate_model_selection(
        &self,
        kind: AdapterKind,
        model: &ModelSelection,
    ) -> Result<()> {
        if let Some(overlay) = &self.overlay {
            validate_model(kind, model, overlay)?;
        }
        Ok(())
    }

    pub fn validate_claude_routing(&self, version: Option<&str>) -> Result<()> {
        if !self.overlay.as_ref().is_some_and(claude_routing_override) {
            return Ok(());
        }
        // Compatibility acceptance: actual parallel requests with conflicting native settings,
        // Claude Code 2.1.287. Older/unknown releases do not silently use native credentials.
        let version = version
            .unwrap_or_default()
            .split(|c: char| !c.is_ascii_digit() && c != '.')
            .find_map(|part| {
                let numbers = part
                    .split('.')
                    .map(str::parse::<u32>)
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .ok()?;
                (numbers.len() == 3).then(|| (numbers[0], numbers[1], numbers[2]))
            });
        ensure!(
            version.is_some_and(|v| v >= (2, 1, 287) && v.0 == 2),
            "Member provider routing requires Claude Code 2.1.287 or a newer compatible 2.x release"
        );
        Ok(())
    }

    pub fn apply(&self, command: &mut tokio::process::Command) -> Result<()> {
        configure_values(
            command,
            self.values
                .as_ref()
                .context("CLI launch environment was not resolved")?,
        );
        Ok(())
    }
    pub fn redactor(&self) -> crate::runtime_custom_api::CredentialRedactor {
        crate::runtime_custom_api::CredentialRedactor::from_values(
            self.values
                .iter()
                .flat_map(|values| values.iter())
                .filter(|(name, _)| credential_variable(name))
                .map(|(_, value)| value.clone())
                .collect(),
        )
    }
}

pub(crate) fn archive_legacy(connection: &Connection) -> Result<()> {
    let mut statement = connection
        .prepare("SELECT runtime_kind,configuration_json FROM runtime_startup_setting")?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (kind, raw) in rows {
        let mut config: Value = serde_json::from_str(&raw)?;
        let entries: Vec<RuntimeEnvironmentVariable> =
            serde_json::from_value(config.get("environment").cloned().unwrap_or(json!([])))?;
        if entries.is_empty() {
            continue;
        }
        let values = entries
            .into_iter()
            .map(|row| (row.name, row.value))
            .collect::<Environment>();
        let previous: Option<(String, Vec<u8>)> = connection
            .query_row(
                "SELECT identity,ciphertext FROM runtime_environment_legacy WHERE runtime_kind=?1",
                [&kind],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let identity = match previous {
            Some((id, bytes))
                if decrypt::<Environment>(connection, &format!("legacy:{kind}"), &bytes)?
                    == values =>
            {
                id
            }
            _ => uuid::Uuid::new_v4().to_string(),
        };
        let encrypted = encrypt(connection, &format!("legacy:{kind}"), &values)?;
        connection.execute("INSERT INTO runtime_environment_legacy(runtime_kind,identity,ciphertext,variable_count) VALUES(?1,?2,?3,?4)
            ON CONFLICT(runtime_kind) DO UPDATE SET identity=excluded.identity,ciphertext=excluded.ciphertext,variable_count=excluded.variable_count",params![kind,identity,encrypted,values.len() as i64])?;
        config["environment"] = json!([]);
        connection.execute(
            "UPDATE runtime_startup_setting SET configuration_json=?2 WHERE runtime_kind=?1",
            params![kind, serde_json::to_string(&config)?],
        )?;
    }
    Ok(())
}
pub fn legacy_list(connection: &Connection) -> Result<Value> {
    let mut query=connection.prepare("SELECT runtime_kind,identity,variable_count,identity=COALESCE(acknowledged_identity,'') FROM runtime_environment_legacy ORDER BY runtime_kind")?;
    let rows=query.query_map([],|r|Ok(json!({"runtimeKind":r.get::<_,String>(0)?,"identity":r.get::<_,String>(1)?,"count":r.get::<_,i64>(2)?,"handled":r.get::<_,bool>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(rows))
}
pub fn legacy_get(connection: &Connection, kind: AdapterKind) -> Result<Value> {
    let bytes: Vec<u8> = connection.query_row(
        "SELECT ciphertext FROM runtime_environment_legacy WHERE runtime_kind=?1",
        [kind.as_str()],
        |r| r.get(0),
    )?;
    let values: Environment = decrypt(connection, &format!("legacy:{}", kind.as_str()), &bytes)?;
    Ok(json!(values))
}
pub fn legacy_acknowledge(
    connection: &Connection,
    kind: AdapterKind,
    expected: &str,
) -> Result<()> {
    ensure!(connection.execute("UPDATE runtime_environment_legacy SET acknowledged_identity=identity WHERE runtime_kind=?1 AND identity=?2",params![kind.as_str(),expected])?==1,"Legacy environment changed; refresh diagnostics");
    Ok(())
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests;
