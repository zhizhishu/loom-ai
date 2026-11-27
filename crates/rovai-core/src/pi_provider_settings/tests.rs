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
        confined_file(&data.join("runtime-home").join("..").join("pi"), MODELS_FILE).is_err()
    );
    // Only the product home is ever addressed, never the data root itself.
    assert_ne!(confined_file(&home, MODELS_FILE).unwrap(), data.join(MODELS_FILE));
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
    assert_eq!(models["providers"]["loom"]["baseUrl"], "https://gateway.example/v1");
    assert_eq!(models["providers"]["loom"]["models"][0]["id"], "oct-model");
    // Only the single owned section and the two default keys move.
    assert_eq!(models["theme"], "dark");
    assert_eq!(models["providers"]["other"]["baseUrl"], "https://other.example");
    assert_eq!(settings["theme"], "light");
    assert_eq!(settings["defaultProvider"], "loom");
    assert_eq!(settings["defaultModel"], "oct-model");

    // The value lives in the existing encrypted shared runtime environment.
    let stored = common::current(database.connection(), AdapterKind::Pi).unwrap();
    assert_eq!(stored[API_KEY_ENV], "sk-live-secret-1234");
    let ciphertext: Vec<u8> = database
        .connection()
        .query_row("SELECT ciphertext FROM runtime_common_environment", [], |row| {
            row.get(0)
        })
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
