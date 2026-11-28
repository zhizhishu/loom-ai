//! Isolated contract test for the global Claude probe using a member gateway
//! overlay.
//!
//! The parent test never sets the Claude opt-in in its own process. It re-execs
//! this test binary so only the child process sees
//! `LOOM_CLAUDE_RUNTIME_ENABLED=1`, keeping the rest of the lib test process on
//! the default "Claude disabled" policy. The child drives the real
//! `Core::deep_probe_candidate` twice:
//!
//! 1. with no member overlay, the fake Claude reports unauthenticated;
//! 2. after a LUOKE Claude gateway overlay is committed, the same probe becomes
//!    ready and the model catalog comes from the fake gateway.
//!
//! Everything is local. The fake never reads a real credential or opens a
//! network connection, and the fixture token must never reach a log or a
//! public probe result.
#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use serde_json::json;

use crate::{
    agent_identity::LUOKE_AGENT_ID,
    agent_profile::{AdapterKind, ModelSelection},
    member_environment::{self, EnvironmentEdit},
    runtime_discovery::RuntimeLaunchPurpose,
    runtime_failure::RuntimeFailurePhase,
};

const CHILD_TEST: &str =
    "application::tests::claude_probe_gateway_tests::claude_gateway_probe_child";
const FAKE_CLAUDE: &str =
    include_str!("../../../tests/fixtures/claude-gateway-probe/fake-claude.sh");
const FIXTURE_BASE_URL: &str = "https://gateway.fixture.invalid";
const FIXTURE_AUTH_TOKEN: &str = "fixture-gateway-token";
const MODEL_CATALOG_INVOCATION: &str = "--print --input-format stream-json --output-format stream-json --verbose --no-session-persistence";

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
        .lines()
        .map(str::to_owned)
        .collect()
}

fn install_fake_claude(root: &Path) -> PathBuf {
    let executable = root.join("claude");
    fs::write(&executable, FAKE_CLAUDE).expect("fake Claude fixture should be written");
    let mut permissions = fs::metadata(&executable)
        .expect("fake Claude fixture metadata should be readable")
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&executable, permissions)
        .expect("fake Claude fixture should be executable");
    executable
}

/// Runs the child in a fresh test process so the opt-in cannot leak into the
/// shared lib test process (whose default-policy assertions must stay strict).
#[test]
fn claude_gateway_probe_contract_runs_in_an_isolated_child() {
    let root = std::env::temp_dir().join(format!(
        "rovai-claude-gateway-probe-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("isolated probe root should be created");

    let mut command = std::process::Command::new(
        std::env::current_exe().expect("current test executable should resolve"),
    );
    command
        .args([
            "--exact",
            CHILD_TEST,
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("LOOM_CLAUDE_RUNTIME_ENABLED", "1")
        .env("LOOM_CLAUDE_PROBE_ROOT", &root);

    // A developer shell may already have real Claude credentials. The child's
    // no-overlay phase must start from a clean host environment.
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    ] {
        command.env_remove(key);
    }
    // `CLAUDE_CODE_USE_*` cannot be enumerated, so the fake also requires the
    // managed-by-host flag and an explicit base URL/token before it accepts a
    // gateway. These two removals cover the remaining process-wide switches.
    command.env_remove("CLAUDE_CONFIG_DIR");
    command.env_remove("LOOM_ENABLED_RUNTIMES");

    let output = command
        .output()
        .expect("isolated Claude gateway probe child should start");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "isolated Claude gateway probe child failed:\nstatus: {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status,
    );
    assert!(
        stdout.contains("1 passed"),
        "child invocation did not select exactly one test; the module/test path is stale:\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    let _ = fs::remove_dir_all(root);
}

/// Child process body. It must only run through the parent test above.
#[tokio::test]
#[ignore = "spawned by claude_gateway_probe_contract_runs_in_an_isolated_child"]
async fn claude_gateway_probe_child() {
    assert_eq!(
        std::env::var("LOOM_CLAUDE_RUNTIME_ENABLED").as_deref(),
        Ok("1"),
        "this child must be the only process with the Claude launch opt-in"
    );
    let root = PathBuf::from(
        std::env::var_os("LOOM_CLAUDE_PROBE_ROOT")
            .expect("the parent test must provide LOOM_CLAUDE_PROBE_ROOT"),
    );
    assert!(root.is_dir(), "probe root {} should exist", root.display());
    let executable = install_fake_claude(&root);

    let database = crate::test_support::fresh_schema_database_at(&root.join("data"));
    let core = super::test_core_for_database(&root, database)
        .expect("isolated test Core should initialize");

    // 1. No member overlay: the fake reports unauthenticated. The global probe
    // must preserve that as authentication_required, not convert it to a
    // generic failure, and it must not enter the model catalog.
    let first = core
        .deep_probe_candidate(
            AdapterKind::ClaudeCodeCli,
            &executable,
            RuntimeLaunchPurpose::InstallationRefresh,
            None,
            None,
            false,
        )
        .await
        .expect("the no-overlay Claude probe should complete");
    assert_eq!(first.snapshot.probe_status, "authentication_required");
    assert_eq!(
        first.snapshot.authentication_status,
        "authentication_required"
    );
    assert!(
        first.snapshot.models.is_empty(),
        "an unauthenticated probe must not publish a model catalog: {:?}",
        first.snapshot.models
    );
    assert!(first.snapshot.last_successful_probe_at.is_none());
    let first_failure = first
        .failure
        .as_ref()
        .expect("authentication failure must be public");
    assert_eq!(first_failure.code, "runtime_authentication_required");
    assert_eq!(first_failure.phase, RuntimeFailurePhase::Authentication);
    assert!(
        !format!("{:?}{:?}", first.snapshot, first.failure).contains(FIXTURE_AUTH_TOKEN),
        "the no-overlay public result must not contain the fixture token"
    );

    let calls_after_first = read_lines(&root.join("calls.log"));
    assert_eq!(
        calls_after_first
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["--version", "--help", "auth status"],
        "the unauthenticated probe must stop after the auth check"
    );
    let environment_after_first = read_lines(&root.join("env.log"));
    assert_eq!(environment_after_first.len(), 3);
    assert!(
        environment_after_first
            .iter()
            .all(|line| line == "gateway=no base=unset key=unset token=unset"),
        "the no-overlay phase must not see a gateway environment: {environment_after_first:?}"
    );

    // 2. Commit LUOKE's Claude gateway overlay. The member scan must route the
    // retry through this exact environment.
    let ledger = {
        let database = core.database.lock().await;
        member_environment::prepare(
            database.connection(),
            LUOKE_AGENT_ID,
            AdapterKind::ClaudeCodeCli,
            &ModelSelection::RuntimeDefault,
            EnvironmentEdit {
                expected_revision: 0,
                json: json!({
                    "ANTHROPIC_BASE_URL": FIXTURE_BASE_URL,
                    "ANTHROPIC_AUTH_TOKEN": FIXTURE_AUTH_TOKEN,
                })
                .to_string(),
                inherit_common: None,
            },
        )
        .expect("LUOKE's Claude gateway overlay should prepare")
    };
    {
        let database = core.database.lock().await;
        ledger
            .commit(database.connection())
            .expect("LUOKE's Claude gateway overlay should commit");
    }

    // 3. The same global probe now retries under the member overlay and becomes
    // ready. The model catalog must come from the fake gateway.
    let second = core
        .deep_probe_candidate(
            AdapterKind::ClaudeCodeCli,
            &executable,
            RuntimeLaunchPurpose::InstallationRefresh,
            None,
            None,
            false,
        )
        .await
        .expect("the overlay Claude probe should complete");
    assert_eq!(second.snapshot.probe_status, "ready");
    assert_eq!(second.snapshot.authentication_status, "authenticated");
    assert!(
        second.failure.is_none(),
        "a ready probe must not retain the first authentication failure: {:?}",
        second.failure
    );
    assert!(second.snapshot.last_successful_probe_at.is_some());
    assert!(second.snapshot.last_error.is_none());
    assert_eq!(
        second.snapshot.models.len(),
        2,
        "the fake gateway should contribute exactly one native model plus the runtime default: {:?}",
        second.snapshot.models
    );
    assert_eq!(
        second.snapshot.models[0].id,
        "claude-code://runtime-default"
    );
    let gateway_model = second
        .snapshot
        .models
        .iter()
        .find(|model| model.id == "gateway-model-a")
        .expect("the fake gateway model should be published");
    assert_eq!(gateway_model.display_name, "Gateway A");
    assert!(!gateway_model.is_default);

    let public_result =
        serde_json::to_string(&second.snapshot).expect("the public probe result should serialize");
    assert!(
        !public_result.contains(FIXTURE_AUTH_TOKEN),
        "the public probe result must not contain the member token"
    );
    assert!(
        !format!("{:?}{:?}", second.snapshot, second.failure).contains(FIXTURE_AUTH_TOKEN),
        "the debug representation of the public probe result must not contain the member token"
    );

    // The call order proves the overlay was only tried after the first
    // authentication failure, and the catalog was queried exactly once.
    let calls = read_lines(&root.join("calls.log"));
    assert_eq!(
        calls.iter().map(String::as_str).collect::<Vec<_>>(),
        vec![
            "--version",
            "--help",
            "auth status",
            "--version",
            "--help",
            "auth status",
            "--version",
            "--help",
            "auth status",
            MODEL_CATALOG_INVOCATION,
        ],
        "the overlay retry must follow the first auth failure and yield one catalog call"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|line| line.starts_with("--print"))
            .count(),
        1,
        "only the successful overlay probe may enter the model catalog"
    );

    // The fake only records set/unset booleans. The token and base URL must
    // never appear in either log.
    let environment = read_lines(&root.join("env.log"));
    assert_eq!(environment.len(), 10, "{environment:?}");
    assert!(
        environment[..3]
            .iter()
            .all(|line| line == "gateway=no base=unset key=unset token=unset"),
        "the first probe must remain gateway-free: {environment:?}"
    );
    assert!(
        environment[3..6]
            .iter()
            .all(|line| line == "gateway=no base=unset key=unset token=unset"),
        "the retry's initial probe must also start gateway-free: {environment:?}"
    );
    assert!(
        environment[6..]
            .iter()
            .all(|line| line == "gateway=yes base=set key=unset token=set"),
        "the overlay retry must see exactly the member gateway environment: {environment:?}"
    );
    let all_logs = format!(
        "{}\n{}",
        fs::read_to_string(root.join("calls.log")).expect("calls log should be readable"),
        fs::read_to_string(root.join("env.log")).expect("environment log should be readable"),
    );
    assert!(!all_logs.contains(FIXTURE_AUTH_TOKEN));
    assert!(!all_logs.contains(FIXTURE_BASE_URL));
}
