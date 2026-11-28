use super::*;

fn data_dir() -> PathBuf {
    std::env::temp_dir().join(format!("rovai-pi-provider-{}", uuid::Uuid::new_v4()))
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn saved_params(api_key: Option<&str>, key_revision: i64) -> SaveParams {
    SaveParams {
        base_url: "https://gateway.example/v1".into(),
        model_id: "oct-model".into(),
        api_key: api_key.map(str::to_owned),
        key_revision,
    }
}

#[test]
fn only_environment_references_are_accepted_as_api_keys() {
    for accepted in ["$OCT_API_KEY", "$_A1"] {
        assert!(env_reference(accepted).is_some(), "{accepted}");
    }
    for rejected in [
        "sk-live-plaintext",
        "OCT_API_KEY",
        "$oct_api_key",
        "$",
        "$1KEY",
        "${OCT_API_KEY}",
        "$OCT-API-KEY",
    ] {
        assert!(env_reference(rejected).is_none(), "{rejected}");
    }
}

#[test]
fn path_escapes_out_of_the_runtime_home_are_rejected() {
    let data = data_dir();
    let home = runtime_home(&data);
    // The product exports exactly this directory as PI_CODING_AGENT_DIR.
    assert_eq!(home, data.join("runtime-home").join("pi"));
    let path = confined_file(&home, MODELS_FILE).unwrap();
    assert_eq!(path, home.join("models.json"));
    assert_eq!(path.parent(), Some(home.as_path()));
    assert!(path.starts_with(&data));
    for escape in [
        "../models.json",
        "../../settings.json",
        "nested/models.json",
        "..",
        "/models.json",
    ] {
        assert!(confined_file(&home, escape).is_err(), "{escape}");
    }
    assert!(confined_file(Path::new("relative"), MODELS_FILE).is_err());
    assert!(
        confined_file(
            &data.join("runtime-home").join("..").join("pi"),
            MODELS_FILE
        )
        .is_err()
    );
    // Only the product home is ever addressed, never the data root itself.
    assert_ne!(
        confined_file(&home, MODELS_FILE).unwrap(),
        data.join(MODELS_FILE)
    );
}

#[test]
fn a_valid_reference_roundtrip_redacts_the_key_and_preserves_other_configuration() {
    let data = data_dir();
    let mut database = crate::test_support::fresh_schema_database_fast_at(&data);
    let home = runtime_home(&data);
    write(
        &home.join(MODELS_FILE),
        r#"{"theme":"dark","providers":{"other":{"baseUrl":"https://other.example","models":[]}}}"#,
    );
    write(&home.join(SETTINGS_FILE), r#"{"theme":"light"}"#);

    let saved = save(
        &mut database,
        &data,
        saved_params(Some("sk-live-secret-1234"), 0),
    )
    .unwrap();
    assert_eq!(saved["providerId"], "loom");
    assert_eq!(saved["baseUrl"], "https://gateway.example/v1");
    assert_eq!(saved["api"], "openai-completions");
    assert_eq!(saved["modelIds"], json!(["oct-model"]));
    assert_eq!(saved["modelId"], "oct-model");
    assert_eq!(saved["apiKeyEnv"], "OCT_API_KEY");
    assert_eq!(saved["keyConfigured"], true);
    assert_eq!(saved["keyLast4"], "1234");
    assert_eq!(saved["keyRevision"], 1);
    // The response carries no key, and neither does anything written to disk.
    assert!(saved.get("apiKey").is_none());
    assert!(!saved.to_string().contains("sk-live-secret-1234"));
    let models = std::fs::read_to_string(home.join(MODELS_FILE)).unwrap();
    let settings = std::fs::read_to_string(home.join(SETTINGS_FILE)).unwrap();
    for written in [&models, &settings] {
        assert!(!written.contains("sk-live-secret-1234"));
    }
    let models: Value = serde_json::from_str(&models).unwrap();
    let settings: Value = serde_json::from_str(&settings).unwrap();
    assert_eq!(models["providers"]["loom"]["apiKey"], "$OCT_API_KEY");
    assert_eq!(models["providers"]["loom"]["name"], "LOOM");
    assert_eq!(
        models["providers"]["loom"]["baseUrl"],
        "https://gateway.example/v1"
    );
    assert_eq!(models["providers"]["loom"]["models"][0]["id"], "oct-model");
    // Only the single owned section and the two default keys move.
    assert_eq!(models["theme"], "dark");
    assert_eq!(
        models["providers"]["other"]["baseUrl"],
        "https://other.example"
    );
    assert_eq!(settings["theme"], "light");
    assert_eq!(settings["defaultProvider"], "loom");
    assert_eq!(settings["defaultModel"], "oct-model");

    // The value lives in the existing encrypted shared runtime environment.
    let stored = common::current(database.connection(), AdapterKind::Pi).unwrap();
    assert_eq!(stored[API_KEY_ENV], "sk-live-secret-1234");
    let ciphertext: Vec<u8> = database
        .connection()
        .query_row(
            "SELECT ciphertext FROM runtime_common_environment",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!String::from_utf8_lossy(&ciphertext).contains("sk-live-secret-1234"));

    // Reloading reports the stored key as configured and never returns it.
    let reloaded = get(database.connection(), &data).unwrap();
    assert_eq!(reloaded["keyConfigured"], true);
    assert_eq!(reloaded["keyLast4"], "1234");
    assert!(!reloaded.to_string().contains("sk-live-secret-1234"));
    // A second save without a key keeps the stored revision and the stored value.
    let kept = save(&mut database, &data, saved_params(None, 1)).unwrap();
    assert_eq!(kept["keyRevision"], 1);
    assert_eq!(kept["keyLast4"], "1234");
    // A stale revision cannot overwrite a key another edit already stored.
    let stale = save(
        &mut database,
        &data,
        saved_params(Some("sk-live-secret-9999"), 0),
    );
    assert!(stale.is_err());
    assert_eq!(
        common::current(database.connection(), AdapterKind::Pi).unwrap()[API_KEY_ENV],
        "sk-live-secret-1234"
    );
}

#[test]
fn a_plaintext_api_key_is_rejected_and_never_rewritten() {
    let data = data_dir();
    let mut database = crate::test_support::fresh_schema_database_fast_at(&data);
    let models_path = runtime_home(&data).join(MODELS_FILE);
    let plaintext = r#"{"providers":{"loom":{"baseUrl":"https://gateway.example","apiKey":"sk-plaintext","models":[]}}}"#;
    write(&models_path, plaintext);
    assert!(get(database.connection(), &data).is_err());
    assert!(
        save(
            &mut database,
            &data,
            saved_params(Some("sk-live-secret-1234"), 0)
        )
        .is_err()
    );
    assert_eq!(std::fs::read_to_string(&models_path).unwrap(), plaintext);
    assert!(
        common::current(database.connection(), AdapterKind::Pi)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn malformed_json_is_reported_and_never_overwritten() {
    let data = data_dir();
    let mut database = crate::test_support::fresh_schema_database_fast_at(&data);
    let home = runtime_home(&data);
    let broken = "{\"providers\": {\"loom\": ";
    write(&home.join(MODELS_FILE), broken);
    assert!(get(database.connection(), &data).is_err());
    let error = save(
        &mut database,
        &data,
        saved_params(Some("sk-live-secret-1234"), 0),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("models.json"), "{error}");
    assert_eq!(
        std::fs::read_to_string(home.join(MODELS_FILE)).unwrap(),
        broken
    );
    assert!(!home.join(SETTINGS_FILE).exists());
    assert!(
        common::current(database.connection(), AdapterKind::Pi)
            .unwrap()
            .is_empty()
    );
}

fn yaml_field<'a>(value: &'a serde_yaml::Value, name: &str) -> Option<&'a serde_yaml::Value> {
    value.as_mapping()?.get(&yaml_key(name))
}

fn yaml_text<'a>(value: &'a serde_yaml::Value, name: &str) -> Option<&'a str> {
    yaml_field(value, name)?.as_str()
}

fn patch_entry<'a>(entries: &'a [serde_yaml::Value], id: &str) -> Option<&'a serde_yaml::Value> {
    entries
        .iter()
        .find(|entry| yaml_text(entry, "id") == Some(id))
}

fn set_common(database: &mut Database, kind: AdapterKind, expected: i64, values: Value) {
    let prepared = common::prepare(
        database.connection(),
        kind,
        common::Edit {
            expected_revision: expected,
            json: values.to_string(),
        },
    )
    .unwrap();
    let transaction = database.connection_mut().transaction().unwrap();
    prepared.commit(&transaction).unwrap();
    transaction.commit().unwrap();
}

#[test]
fn acp_patch_preserves_user_configuration_and_replaces_only_the_owned_route() {
    let data = data_dir();
    let mut database = crate::test_support::fresh_schema_database_fast_at(&data);
    let patch_path = dsh_patch_file(&data).unwrap();
    let original = r#"- id: user-theme
  config:
    theme: dark
    nested: { keep: true }
- id: llm-pi-ai
  config:
    marker: keep
    providers:
      other:
        api: openai-completions
        baseURL: https://other.example/v1
        apiKeyEnv: OTHER_API_KEY
        models:
          - id: other-model
      relay:
        api: old-protocol
        baseURL: https://old.example/v1
        apiKeyEnv: OLD_KEY
        models:
          - id: old-model
- id: acp
  config:
    provider: old-provider
    model: old-model
    extra: keep
- id: user-tail
  config:
    note: keep
"#;
    write(&patch_path, original);
    let original: serde_yaml::Value = serde_yaml::from_str(original).unwrap();
    let secret = format!("sk-synthetic-{}", uuid::Uuid::new_v4());

    let saved = save(&mut database, &data, saved_params(Some(&secret), 0)).unwrap();
    assert_eq!(saved["keyConfigured"], true);
    assert_eq!(saved["baseUrl"], "https://gateway.example/v1");

    let written = std::fs::read_to_string(&patch_path).unwrap();
    assert!(!written.contains(&secret));
    let document: serde_yaml::Value = serde_yaml::from_str(&written).unwrap();
    let entries = document.as_sequence().unwrap();
    assert_eq!(entries.len(), 4);
    let llm = patch_entry(entries, DSH_MODEL_PLUGIN_ID).unwrap();
    let config = yaml_field(llm, "config").unwrap();
    assert_eq!(yaml_text(config, "marker"), Some("keep"));
    let providers = yaml_field(config, "providers").unwrap();
    let other = yaml_field(providers, "other").unwrap();
    assert_eq!(yaml_text(other, "api"), Some("openai-completions"));
    assert_eq!(
        yaml_text(other, "baseURL"),
        Some("https://other.example/v1")
    );
    assert_eq!(yaml_text(other, "apiKeyEnv"), Some("OTHER_API_KEY"));
    assert_eq!(
        yaml_field(other, "models")
            .unwrap()
            .as_sequence()
            .unwrap()
            .len(),
        1
    );
    let relay = yaml_field(providers, DSH_PROVIDER_ID).unwrap();
    assert_eq!(yaml_text(relay, "api"), Some("openai-responses"));
    assert_eq!(
        yaml_text(relay, "baseURL"),
        Some("https://gateway.example/v1")
    );
    assert_eq!(yaml_text(relay, "apiKeyEnv"), Some(API_KEY_ENV));
    let models = yaml_field(relay, "models").unwrap().as_sequence().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(yaml_text(&models[0], "id"), Some(DSH_MODEL_ID));
    assert_eq!(
        yaml_field(&models[0], "contextWindow").unwrap().as_u64(),
        Some(DSH_CONTEXT_WINDOW)
    );
    assert_eq!(
        yaml_field(&models[0], "maxTokens").unwrap().as_u64(),
        Some(DSH_MAX_TOKENS)
    );
    let acp = patch_entry(entries, DSH_ACP_ENTRY_ID).unwrap();
    let acp_config = yaml_field(acp, "config").unwrap();
    assert_eq!(yaml_text(acp_config, "provider"), Some(DSH_PROVIDER_ID));
    assert_eq!(yaml_text(acp_config, "model"), Some(DSH_MODEL_ID));
    assert_eq!(yaml_text(acp_config, "extra"), Some("keep"));
    let original_entries = original.as_sequence().unwrap();
    assert_eq!(
        patch_entry(entries, "user-theme"),
        patch_entry(original_entries, "user-theme")
    );
    assert_eq!(
        patch_entry(entries, "user-tail"),
        patch_entry(original_entries, "user-tail")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&patch_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            std::fs::read_dir(patch_path.parent().unwrap())
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")),
            "the atomic temporary file must be gone"
        );
    }
}

#[test]
fn the_same_key_reaches_both_encrypted_common_environments_with_independent_revisions() {
    let data = data_dir();
    let mut database = crate::test_support::fresh_schema_database_fast_at(&data);
    // Pi is already at revision 2 while DSH is at revision 1: the DSH expectation must
    // come from DSH itself, never from the form's Pi revision.
    set_common(&mut database, AdapterKind::Pi, 0, json!({"PI_KEEP":"one"}));
    set_common(&mut database, AdapterKind::Pi, 1, json!({"PI_KEEP":"two"}));
    set_common(
        &mut database,
        AdapterKind::DeepseekHarness,
        0,
        json!({"DSH_KEEP":"keep"}),
    );
    let secret = format!("sk-synthetic-{}", uuid::Uuid::new_v4());
    save(&mut database, &data, saved_params(Some(&secret), 2)).unwrap();

    let pi = common::current(database.connection(), AdapterKind::Pi).unwrap();
    assert_eq!(pi[API_KEY_ENV], secret);
    assert_eq!(pi["PI_KEEP"], "two");
    let dsh = common::current(database.connection(), AdapterKind::DeepseekHarness).unwrap();
    assert_eq!(dsh[API_KEY_ENV], secret);
    assert_eq!(dsh["DSH_KEEP"], "keep");
    let pi_revision = common::get(database.connection(), AdapterKind::Pi).unwrap()["revision"]
        .as_i64()
        .unwrap();
    let dsh_revision =
        common::get(database.connection(), AdapterKind::DeepseekHarness).unwrap()["revision"]
            .as_i64()
            .unwrap();
    assert_eq!(pi_revision, 3);
    assert_eq!(dsh_revision, 2);

    for (kind, revision) in [
        (AdapterKind::Pi, pi_revision),
        (AdapterKind::DeepseekHarness, dsh_revision),
    ] {
        let ciphertext: Vec<u8> = database
            .connection()
            .query_row(
                "SELECT ciphertext FROM runtime_common_environment WHERE runtime_kind=?1 AND revision=?2",
                rusqlite::params![kind.as_str(), revision],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains(&secret));
    }

    // No patch existed before, so LOOM appends exactly its two owned entries.
    let written = std::fs::read_to_string(dsh_patch_file(&data).unwrap()).unwrap();
    assert!(!written.contains(&secret));
    let document: serde_yaml::Value = serde_yaml::from_str(&written).unwrap();
    let entries = document.as_sequence().unwrap();
    assert_eq!(entries.len(), 2);
    let llm = patch_entry(entries, DSH_MODEL_PLUGIN_ID).unwrap();
    let providers = yaml_field(yaml_field(llm, "config").unwrap(), "providers").unwrap();
    let relay = yaml_field(providers, DSH_PROVIDER_ID).unwrap();
    assert_eq!(yaml_text(relay, "apiKeyEnv"), Some(API_KEY_ENV));
    assert_eq!(
        yaml_text(
            yaml_field(patch_entry(entries, DSH_ACP_ENTRY_ID).unwrap(), "config").unwrap(),
            "provider",
        ),
        Some(DSH_PROVIDER_ID)
    );
}

#[test]
fn malformed_acp_patch_is_reported_and_never_overwritten_or_bypassed() {
    let data = data_dir();
    let mut database = crate::test_support::fresh_schema_database_fast_at(&data);
    let patch_path = dsh_patch_file(&data).unwrap();
    let broken = "- id: [unterminated\n";
    write(&patch_path, broken);
    let error = save(
        &mut database,
        &data,
        saved_params(Some("sk-live-secret-1234"), 0),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("cordis.patch.yml"), "{error}");
    assert_eq!(std::fs::read_to_string(&patch_path).unwrap(), broken);
    assert!(!runtime_home(&data).join(MODELS_FILE).exists());
    assert!(
        common::current(database.connection(), AdapterKind::Pi)
            .unwrap()
            .is_empty()
    );
    assert!(
        common::current(database.connection(), AdapterKind::DeepseekHarness)
            .unwrap()
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_acp_patch_is_refused_before_any_key_is_stored() {
    let data = data_dir();
    let mut database = crate::test_support::fresh_schema_database_fast_at(&data);
    let patch_path = dsh_patch_file(&data).unwrap();
    std::fs::create_dir_all(patch_path.parent().unwrap()).unwrap();
    let target = data.join("outside-patch.yml");
    write(&target, "- id: outside\n");
    std::os::unix::fs::symlink(&target, &patch_path).unwrap();
    let error = save(
        &mut database,
        &data,
        saved_params(Some("sk-live-secret-1234"), 0),
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("symbolic") || error.contains("symlink"),
        "{error}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "- id: outside\n");
    assert!(
        std::fs::symlink_metadata(&patch_path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!runtime_home(&data).join(MODELS_FILE).exists());
    assert!(
        common::current(database.connection(), AdapterKind::Pi)
            .unwrap()
            .is_empty()
    );
    assert!(
        common::current(database.connection(), AdapterKind::DeepseekHarness)
            .unwrap()
            .is_empty()
    );
}
