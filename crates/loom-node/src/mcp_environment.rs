//! Node-operator-owned lookup for referenced native MCP credentials.
//!
//! The controller sends only reference names: the MCP server, the variable and
//! the digest of the frozen MCP document. The real value never travels on the
//! wire, is never logged, hashed or returned in a receipt. This module reads the
//! operator-only `mcp-environment-bindings.json` in the node's private data
//! directory, matches exactly one binding by controller, member, workspace,
//! server and document digest, and copies the named local variable into the
//! prepared native environment. A bundle without references keeps the old path:
//! the file is not opened and `std::env` is not consulted.
use std::{
    collections::{BTreeMap, btree_map::Entry},
    ffi::OsString,
    fmt,
    io::Read,
    path::Path,
};

use loom_protocol::{
    process_pipe::ProcessOpenV1,
    run_bundle::{
        ADAPTER_CODEX_CLI, McpEnvironmentReference, RUN_BUNDLE_REFERENCE_VERSION,
        mcp_environment_references, valid_mcp_reference_name,
    },
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Operator file inside the node's private data directory. Only the machine
/// operator may write it; it records binding names and never a real value.
pub(crate) const BINDINGS_FILE: &str = "mcp-environment-bindings.json";
const BINDINGS_VERSION: u32 = 1;
const MAX_BINDINGS_BYTES: u64 = 64 * 1024;
const MAX_BINDINGS: usize = 128;
const MAX_VARIABLES: usize = 32;
const MAX_VALUE_BYTES: usize = 32 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bindings {
    version: u32,
    bindings: Vec<Binding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    controller_id: String,
    member_id: String,
    workspace_id: String,
    server_name: String,
    config_digest: String,
    variables: BTreeMap<String, String>,
}

/// Values resolved for exactly one preparation. `Debug` names them only, so a
/// derived/value-bearing debug line can never print a credential. Equality also
/// covers the exact operator-file bytes: the same value reached through a
/// different source name is not the same preparation.
#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct LaunchEnvironment {
    values: BTreeMap<OsString, OsString>,
    /// Local-only identity of the binding document that produced `values`.
    /// Never rendered, returned or sent to the controller.
    binding_digest: String,
}

impl LaunchEnvironment {
    pub(crate) fn apply(&self, environment: &mut BTreeMap<OsString, OsString>) {
        for (name, value) in &self.values {
            environment.insert(name.clone(), value.clone());
        }
    }
}

impl fmt::Debug for LaunchEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names = self.values.keys().collect::<Vec<_>>();
        formatter
            .debug_struct("LaunchEnvironment")
            .field("names", &names)
            .finish()
    }
}

/// First read, after materialization and the local/builtin environment exist.
pub(crate) fn resolve_launch_environment(
    data_dir: &Path,
    launch: &ProcessOpenV1,
    local: &BTreeMap<OsString, OsString>,
) -> Result<LaunchEnvironment, &'static str> {
    resolve_with(data_dir, launch, local, &|name| std::env::var_os(name))
}

/// Second read, immediately before the caller hands the spec to spawn. Equal
/// snapshots prove the operator file and every named source variable are
/// unchanged since preparation; any difference refuses the attempt.
pub(crate) fn confirm_launch_environment(
    data_dir: &Path,
    launch: &ProcessOpenV1,
    local: &BTreeMap<OsString, OsString>,
    prepared: &LaunchEnvironment,
) -> Result<(), &'static str> {
    confirm_with(data_dir, launch, local, prepared, &|name| std::env::var_os(name))
}

fn confirm_with(
    data_dir: &Path,
    launch: &ProcessOpenV1,
    local: &BTreeMap<OsString, OsString>,
    prepared: &LaunchEnvironment,
    lookup: &dyn Fn(&str) -> Option<OsString>,
) -> Result<(), &'static str> {
    if &resolve_with(data_dir, launch, local, lookup)? != prepared {
        return Err("pipe_mcp_reference_changed");
    }
    Ok(())
}

fn resolve_with(
    data_dir: &Path,
    launch: &ProcessOpenV1,
    local: &BTreeMap<OsString, OsString>,
    lookup: &dyn Fn(&str) -> Option<OsString>,
) -> Result<LaunchEnvironment, &'static str> {
    let references = references(launch)?;
    if references.is_empty() {
        // The unmodified path: no operator file, no environment read.
        return Ok(LaunchEnvironment::default());
    }
    let (bindings, binding_digest) = read_bindings(data_dir)?;
    let mut values = BTreeMap::new();
    for reference in &references {
        if !valid_mcp_reference_name(&reference.variable) {
            return Err("pipe_mcp_reference_name");
        }
        let binding = unique_binding(&bindings, launch, reference)?;
        let source = binding
            .variables
            .get(&reference.variable)
            .ok_or("pipe_mcp_reference_unbound")?;
        let exposed = OsString::from(&reference.variable);
        // A value must never overwrite a local or builtin variable.
        if local.contains_key(&exposed) {
            return Err("pipe_mcp_reference_conflict");
        }
        let value = lookup(source).ok_or("pipe_mcp_reference_missing")?;
        if value.len() > MAX_VALUE_BYTES || value.to_string_lossy().contains('\u{0}') {
            return Err("pipe_mcp_reference_value");
        }
        match values.entry(exposed) {
            Entry::Vacant(entry) => {
                entry.insert(value);
            }
            Entry::Occupied(entry) => {
                if entry.get() != &value {
                    return Err("pipe_mcp_reference_conflict");
                }
            }
        }
    }
    Ok(LaunchEnvironment {
        values,
        binding_digest,
    })
}

fn references(launch: &ProcessOpenV1) -> Result<Vec<McpEnvironmentReference>, &'static str> {
    let bundle = launch
        .bundle
        .as_ref()
        // The typed pipe path already requires a bundle: `materialize_pipe`
        // refuses a bundle-less Open with this same code before preparation
        // reaches here. A bundle that exists without references never reads a
        // value, so the pre-bundle legacy shape is unchanged.
        .ok_or("pipe_bundle_required")?;
    let references = mcp_environment_references(bundle).map_err(|error| error.code())?;
    if references.is_empty() {
        return Ok(references);
    }
    // Only the typed Codex v2 shape reads a value. Claude Code is not a first
    // release consumer, so its placeholder references are refused explicitly.
    if bundle.version != RUN_BUNDLE_REFERENCE_VERSION {
        return Err("bundle_version");
    }
    if bundle.adapter_kind != ADAPTER_CODEX_CLI {
        return Err("pipe_mcp_reference_adapter");
    }
    Ok(references)
}

fn unique_binding<'a>(
    bindings: &'a Bindings,
    launch: &ProcessOpenV1,
    reference: &McpEnvironmentReference,
) -> Result<&'a Binding, &'static str> {
    // No field may fall back: a missing scope field cannot match, and one exact
    // match is required because two rules would make the source ambiguous.
    let mut matched = bindings.bindings.iter().filter(|binding| {
        binding.controller_id == launch.session.controller_id
            && binding.member_id == launch.session.member_id
            && binding.workspace_id == launch.session.workspace_id
            && binding.server_name == reference.server_name
            && binding.config_digest == reference.config_digest
    });
    let binding = matched.next().ok_or("pipe_mcp_reference_unbound")?;
    if matched.next().is_some() {
        return Err("pipe_mcp_reference_ambiguous");
    }
    Ok(binding)
}

fn read_bindings(data_dir: &Path) -> Result<(Bindings, String), &'static str> {
    admit_directory(data_dir)?;
    let path = data_dir.join(BINDINGS_FILE);
    let file = rovai_private_storage::open_private_read_file(&path)
        .map_err(|_| "pipe_mcp_reference_bindings")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file
            .metadata()
            .map_err(|_| "pipe_mcp_reference_bindings")?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("pipe_mcp_reference_bindings");
        }
    }
    // Bounded before allocation: one oversized file is refused, not streamed.
    let mut bytes = Vec::new();
    let mut reader = file.take(MAX_BINDINGS_BYTES + 1);
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| "pipe_mcp_reference_bindings")?;
    if bytes.len() as u64 > MAX_BINDINGS_BYTES {
        return Err("pipe_mcp_reference_bindings");
    }
    // The digest stays inside the process. Confirmation compares it, so a file
    // that now maps the same value from a different source is still a change.
    let binding_digest = format!("sha256:{:x}", Sha256::digest(&bytes));
    parse(&bytes).map(|bindings| (bindings, binding_digest))
}

fn admit_directory(data_dir: &Path) -> Result<(), &'static str> {
    // The file open admits this parent on Windows as well; the explicit form
    // keeps a replaced or permissive directory from being read on either OS.
    #[cfg(windows)]
    rovai_private_storage::admit_private_directory(data_dir)
        .map_err(|_| "pipe_mcp_reference_bindings")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata =
            std::fs::symlink_metadata(data_dir).map_err(|_| "pipe_mcp_reference_bindings")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("pipe_mcp_reference_bindings");
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = data_dir;
        return Err("pipe_mcp_reference_bindings");
    }
    Ok(())
}

fn parse(bytes: &[u8]) -> Result<Bindings, &'static str> {
    let file: Bindings =
        serde_json::from_slice(bytes).map_err(|_| "pipe_mcp_reference_bindings")?;
    if file.version != BINDINGS_VERSION || file.bindings.len() > MAX_BINDINGS {
        return Err("pipe_mcp_reference_bindings");
    }
    for binding in &file.bindings {
        if !valid_identifier(&binding.controller_id)
            || !valid_identifier(&binding.member_id)
            || !valid_identifier(&binding.workspace_id)
            || !valid_identifier(&binding.server_name)
            || !valid_config_digest(&binding.config_digest)
            || binding.variables.len() > MAX_VARIABLES
        {
            return Err("pipe_mcp_reference_bindings");
        }
        for (exposed, source) in &binding.variables {
            // Both sides are plain variable names: no paths, no interpolation
            // and no reserved loader or product variable.
            if !valid_mcp_reference_name(exposed) || !valid_mcp_reference_name(source) {
                return Err("pipe_mcp_reference_name");
            }
        }
    }
    Ok(file)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES && !value.chars().any(char::is_control)
}

fn valid_config_digest(value: &str) -> bool {
    value.len() == 7 + 64
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use loom_protocol::{
        process_pipe::{
            AgentRunOwner, PROCESS_PIPE_VERSION, ProcessOpenV1, ProcessSessionOwner,
            RemoteProcessKey,
        },
        run_bundle::{
            ADAPTER_CLAUDE_CODE, BundleArtifact, BundleFile, RUN_BUNDLE_VERSION, RunBundleV1,
        },
    };
    use serde_json::{Map, Value, json};
    use std::path::{Path, PathBuf};

    fn private_root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("loom-mcp-env-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .unwrap();
        }
        #[cfg(windows)]
        rovai_private_storage::create_private_directory(&path).unwrap();
        path
    }

    fn write_bindings(root: &Path, bytes: &[u8]) {
        use std::io::Write as _;
        let path = root.join(BINDINGS_FILE);
        let _ = std::fs::remove_file(&path);
        let mut file = rovai_private_storage::create_private_new_file(&path).unwrap();
        file.write_all(bytes).unwrap();
    }

    fn bindings_document(bindings: &[Value]) -> Vec<u8> {
        serde_json::to_vec(&json!({"version": 1, "bindings": bindings})).unwrap()
    }

    fn binding(server: &str, digest: &str, variables: Value) -> Value {
        json!({
            "controllerId": "controller_fixture",
            "memberId": "member_fixture",
            "workspaceId": "workspace_fixture",
            "serverName": server,
            "configDigest": digest,
            "variables": variables,
        })
    }

    fn mcp_bundle(adapter: &str, mcp: &Value) -> RunBundleV1 {
        let bytes = serde_json::to_vec(mcp).unwrap();
        RunBundleV1 {
            version: RUN_BUNDLE_REFERENCE_VERSION,
            bundle_id: "bundle_fixture".into(),
            run_id: "run_fixture".into(),
            attempt: 1,
            agent_id: "member_fixture".into(),
            adapter_kind: adapter.into(),
            selection_revision: "revision_fixture".into(),
            source_skill_root: None,
            digest: "sha256:fixture".into(),
            files: vec![BundleFile {
                artifact: BundleArtifact::McpConfig,
                label: "mcp".into(),
                path: "mcp.json".into(),
                bytes: bytes.len(),
                content: STANDARD.encode(&bytes),
            }],
        }
    }

    fn make_launch(bundle: RunBundleV1) -> ProcessOpenV1 {
        ProcessOpenV1 {
            version: PROCESS_PIPE_VERSION,
            key: RemoteProcessKey {
                node_id: "node_fixture".into(),
                process_id: "process_fixture".into(),
                process_epoch: 1,
            },
            session: ProcessSessionOwner {
                member_id: "member_fixture".into(),
                logical_session_id: "session_fixture".into(),
                workspace_id: "workspace_fixture".into(),
                controller_id: "controller_fixture".into(),
            },
            owner: AgentRunOwner {
                agent_run_id: "run_fixture".into(),
                execution_epoch: 1,
            },
            builtin_tasks_enabled: false,
            adapter_kind: ADAPTER_CODEX_CLI.into(),
            catalog_generation: 1,
            program_identity: "sha256:fixture".into(),
            program: "fixture-native-program".into(),
            cwd: "/fixture/work".into(),
            args: Vec::new(),
            environment: Vec::new(),
            bundle: Some(bundle),
            codex_hook_grant: None,
        }
    }

    fn github_digest(bundle: &RunBundleV1) -> String {
        mcp_environment_references(bundle).unwrap()[0]
            .config_digest
            .clone()
    }

    fn decoded_mcp_config(bundle: &RunBundleV1) -> Value {
        // Selected by artifact kind, not by position: the native side must
        // receive the bundle's frozen MCP document, never a document the test
        // rewrote for it.
        let file = bundle
            .files
            .iter()
            .find(|file| matches!(&file.artifact, BundleArtifact::McpConfig))
            .expect("mcp config artifact");
        let bytes = STANDARD.decode(&file.content).expect("mcp config base64");
        serde_json::from_slice(&bytes).expect("mcp config document")
    }

    fn read_records(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .map(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str(line.trim()).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Drops isolated absolute paths and host identity from a receipt. Nothing
    /// secret is retained: no credential, no real config, no environment value.
    fn scrub(value: &Value, isolated: &Path) -> Value {
        let root = isolated.to_string_lossy().into_owned();
        match value {
            Value::String(text) => Value::String(text.replace(&root, "<isolatedRoot>")),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| scrub(item, isolated)).collect())
            }
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, item)| {
                        let redacted = matches!(key.as_str(), "serverName" | "installationId");
                        (
                            key.clone(),
                            if redacted {
                                Value::String("<redacted>".into())
                            } else {
                                scrub(item, isolated)
                            },
                        )
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// Same shape the verified native probe sent, with `config` taken from the
    /// bundle. `loopback_provider` is only used if native refuses without a
    /// provider: no turn is ever started, so that endpoint is never contacted.
    fn native_thread_params(isolated: &Path, config: Value, loopback_provider: bool) -> Value {
        let mut params = json!({
            "cwd": isolated.join("cwd").display().to_string(),
            "model": "fixture",
            "approvalPolicy": "never",
            "sandbox": "read-only",
            "ephemeral": true,
            "config": config,
        });
        if loopback_provider {
            params["config"]["model_provider"] = json!("loom-probe-local");
            params["config"]["model_providers"] = json!({"loom-probe-local": {
                "name": "loom probe loopback (no model traffic)",
                "base_url": "http://127.0.0.1:9/v1",
                "wire_api": "responses",
                "requires_openai_auth": false,
            }});
        }
        params
    }

    struct NativeRpc {
        stdin: rovai_process_boundary::ProcessStdin,
        lines: tokio::sync::mpsc::Receiver<String>,
        sequence: u64,
        notifications: Vec<Value>,
        server_requests: Vec<Value>,
    }

    impl NativeRpc {
        async fn send(&mut self, value: &Value) -> Result<(), String> {
            use tokio::io::AsyncWriteExt as _;
            let mut line = value.to_string();
            line.push('\n');
            self.stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|error| format!("write:{error}"))?;
            self.stdin
                .flush()
                .await
                .map_err(|error| format!("flush:{error}"))
        }

        async fn notify(&mut self, method: &str, params: Value) {
            let _ = self
                .send(&json!({"method": method, "params": params}))
                .await;
        }

        /// Notifications are the only visible evidence of MCP startup; server
        /// requests are refused because this probe authorizes no action.
        async fn absorb(&mut self, message: Value) {
            if message.get("id").is_some() && message.get("method").is_some() {
                let _ = self
                    .send(&json!({
                        "id": message["id"],
                        "error": {"code": -32601, "message": "probe does not authorize client actions"},
                    }))
                    .await;
                self.server_requests.push(message);
            } else if message.get("method").is_some() {
                self.notifications.push(message);
            }
        }

        async fn next_line(&mut self, wait: std::time::Duration) -> Result<Option<String>, String> {
            match tokio::time::timeout(wait, self.lines.recv()).await {
                Ok(Some(line)) => Ok(Some(line)),
                Ok(None) => Ok(None),
                Err(_) => Err("timeout".to_string()),
            }
        }

        async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
            self.sequence += 1;
            let id = self.sequence;
            self.send(&json!({"id": id, "method": method, "params": params}))
                .await?;
            loop {
                let line = self
                    .next_line(std::time::Duration::from_secs(25))
                    .await
                    .map_err(|error| format!("{method}:{error}"))?
                    .ok_or_else(|| format!("{method}:native_eof"))?;
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("id") == Some(&json!(id)) {
                    return Ok(message);
                }
                self.absorb(message).await;
            }
        }

        /// Bounded drain: no new request, anything asked is refused.
        async fn drain(&mut self, wait: std::time::Duration) {
            let deadline = tokio::time::Instant::now() + wait;
            loop {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return;
                }
                let slice = (deadline - now).min(std::time::Duration::from_millis(100));
                match self.next_line(slice).await {
                    Ok(Some(line)) if !line.is_empty() => {
                        if let Ok(message) = serde_json::from_str::<Value>(&line) {
                            self.absorb(message).await;
                        }
                    }
                    _ => return,
                }
            }
        }
    }

    /// Opt-in half of `operator_binding_values_reach_only_the_native_environment`.
    ///
    /// One chain only: production operator file plus production resolver
    /// (`resolve_with` standing in for `resolve_launch_environment` with a
    /// synthetic source value) into the real native environment of a real
    /// `codex app-server` started through the production process owner, which
    /// then performs its own MCP handshake against the stdio fixture.
    /// Deliberately not covered: `process_admission::prepare` catalog/authority
    /// admission, any turn, any model request, any real credential.
    async fn native_reference_probe(
        root: &Path,
        codex_bin: &std::ffi::OsStr,
        python_bin: &std::ffi::OsStr,
        fixture: &Path,
    ) -> bool {
        use rovai_process_boundary::{NativeProcess, ProcessSpec, StdinPolicy};

        let duration = std::time::Duration::from_secs;
        assert!(
            fixture.is_file(),
            "LOOM_TEST_MCP_FIXTURE must name the stdio fixture script"
        );
        let artifact_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("_artifacts/completion-next/mcp-production-probe");
        let isolated = root.join("native");
        for relative in ["home/.codex", "cwd", "tmp"] {
            std::fs::create_dir_all(isolated.join(relative)).unwrap();
        }
        let record_path = isolated.join("stdio-record.jsonl");
        let bundle = mcp_bundle(
            ADAPTER_CODEX_CLI,
            &json!({"mcp_servers": {"github": {
                "command": python_bin.to_string_lossy(),
                "args": [fixture.display().to_string(), "--server", record_path.display().to_string()],
                "env_vars": ["GITHUB_TOKEN"],
                "startup_timeout_sec": 10,
            }}}),
        );
        let config = decoded_mcp_config(&bundle);
        let native_config = config.clone();
        let digest = github_digest(&bundle);
        // Synthetic value: lives only in this process. Only its hash crosses.
        let nonce = format!("synthetic-only-{}", uuid::Uuid::new_v4());
        let expected = format!("{:x}", Sha256::digest(nonce.as_bytes()));
        let lookup =
            |name: &str| (name == "NODE_GITHUB_TOKEN").then(|| OsString::from(nonce.clone()));
        write_bindings(
            root,
            &bindings_document(&[binding(
                "github",
                &digest,
                json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
            )]),
        );
        let launch = make_launch(bundle);
        let mut base = BTreeMap::new();
        for name in ["PATH", "SystemRoot"] {
            if let Some(value) = std::env::var_os(name) {
                base.insert(OsString::from(name), value);
            }
        }
        for (name, value) in [
            ("TEMP", isolated.join("tmp")),
            ("TMP", isolated.join("tmp")),
            ("HOME", isolated.join("home")),
            ("USERPROFILE", isolated.join("home")),
            ("CODEX_HOME", isolated.join("home/.codex")),
        ] {
            base.insert(OsString::from(name), value.into_os_string());
        }
        // Resolve and confirm against the untouched base environment: the
        // exposed name must still be absent while the resolver checks that no
        // local variable is overwritten. Confirmed values are applied for spawn.
        let resolved = resolve_with(root, &launch, &base, &lookup)
            .expect("node resolver must resolve the referenced variable");
        confirm_with(root, &launch, &base, &resolved, &lookup)
            .expect("node resolver must confirm the prepared environment");
        let mut environment = base;
        resolved.apply(&mut environment);

        let spec = ProcessSpec::new(
            PathBuf::from(codex_bin),
            vec![OsString::from("--no-daemon"), OsString::from("app-server")],
            isolated.join("cwd"),
            environment,
            StdinPolicy::Piped,
        )
        .expect("admitted native process spec");
        let mut process = NativeProcess::spawn(&spec).expect("spawn native codex app-server");
        let native_pid = process.id();
        let stdin = process.take_stdin().expect("piped stdin");
        let stdout = process.take_stdout().expect("native stdout");
        let stderr = process.take_stderr().expect("native stderr");
        let (sender, lines) = tokio::sync::mpsc::channel(4096);
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt as _;
            let mut reader = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if sender.send(line).await.is_err() {
                    break;
                }
            }
        });
        let stderr_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt as _;
            let mut stderr = stderr;
            let mut buffer = Vec::new();
            let _ = stderr.read_to_end(&mut buffer).await;
            buffer
        });
        let mut rpc = NativeRpc {
            stdin,
            lines,
            sequence: 0,
            notifications: Vec::new(),
            server_requests: Vec::new(),
        };
        let mut receipt = json!({
            "probe": "node_resolver_to_native_codex_mcp_handshake",
            "scope": "production operator file and production resolver (synthetic source value) into a real native codex app-server started by the production process owner, MCP handshake against a stdio fixture; no process_admission::prepare, no turn and no model request, no real credential. Native startup runs its own plugin/network startup; this round does not claim a network-free startup.",
            "environmentResolver": true,
            "processBoundaryUsed": true,
            "nativeHandshake": false,
            "treeEmpty": false,
            "fullAdmission": false,
            "modelRun": false,
            "expectedSyntheticSha256": expected,
            "isolatedRoot": isolated.display().to_string(),
            "nativePid": native_pid,
            "nativeArgv": ["--no-daemon", "app-server"],
            "notTested": [
                "env_http_headers (HTTP delivery case not run in this round)",
                "process_admission::prepare catalog and authority admission",
                "turn/start, model requests, MCP tools/call",
            ],
        });
        let mut rpc_error = None;
        match rpc
            .call(
                "initialize",
                json!({
                    "clientInfo": {"name": "loom-mcp-production-probe", "version": "1"},
                    "capabilities": {"experimentalApi": true},
                }),
            )
            .await
        {
            Ok(message) => {
                receipt["initializeResponse"] = scrub(&message, &isolated);
                rpc.notify("initialized", json!({})).await;
                let mut response = rpc
                    .call(
                        "thread/start",
                        native_thread_params(&isolated, config.clone(), false),
                    )
                    .await;
                if response
                    .as_ref()
                    .map(|message| message.get("error").is_some())
                    .unwrap_or(false)
                {
                    receipt["threadStartRetryVariant"] = json!("loopback_provider");
                    response = rpc
                        .call("thread/start", native_thread_params(&isolated, config, true))
                        .await;
                }
                match response {
                    Ok(message) => receipt["threadStartResponse"] = scrub(&message, &isolated),
                    Err(error) => rpc_error = Some(format!("thread/start:{error}")),
                }
            }
            Err(error) => rpc_error = Some(format!("initialize:{error}")),
        }
        if let Some(error) = rpc_error {
            receipt["rpcError"] = json!(error);
        }
        // The handshake is the fixture's own record, not merely a spawned child.
        let deadline = tokio::time::Instant::now() + duration(20);
        let mut records = read_records(&record_path);
        while tokio::time::Instant::now() < deadline {
            if records
                .iter()
                .any(|row| row["event"] == "request" && row["method"] == "initialize")
            {
                rpc.drain(duration(1)).await; // let tools/list land
                break;
            }
            rpc.drain(std::time::Duration::from_millis(200)).await;
            records = read_records(&record_path);
        }
        let notifications = std::mem::take(&mut rpc.notifications);
        let server_requests = std::mem::take(&mut rpc.server_requests);
        drop(rpc); // closes native stdin
        let termination =
            tokio::time::timeout(duration(10), process.terminate_and_wait(duration(5))).await;
        let mut cleanup = json!({"processBoundaryUsed": true});
        let tree_empty = match termination {
            Ok(Ok(receipt)) => receipt.tree_empty,
            Ok(Err(error)) => {
                cleanup["terminationError"] = json!(error.to_string());
                false
            }
            Err(_) => {
                cleanup["terminationError"] = json!("terminate_and_wait_timeout");
                false
            }
        };
        let stderr_text = stderr_task.await.unwrap_or_default();
        let stderr_tail: String = {
            let text = String::from_utf8_lossy(&stderr_text).replace(
                &isolated.to_string_lossy().into_owned(),
                "<isolatedRoot>",
            );
            let tail: Vec<char> = text.chars().rev().take(1200).collect();
            tail.into_iter().rev().collect()
        };
        records = read_records(&record_path);
        let start = records.iter().find(|row| row["event"] == "fixture_start");
        let received = start
            .and_then(|row| row["sha256"].as_str())
            .map(str::to_owned);
        let present = start
            .and_then(|row| row["present"].as_bool())
            .unwrap_or(false);
        let handshake = records
            .iter()
            .any(|row| row["event"] == "request" && row["method"] == "initialize");
        let cleanup_confirmed = tree_empty;
        cleanup["treeEmpty"] = json!(tree_empty);
        cleanup["fixturePids"] = json!(records
            .iter()
            .filter(|row| row["event"] == "fixture_start")
            .filter_map(|row| row["pid"].as_i64())
            .collect::<Vec<_>>());
        cleanup["cleanupConfirmed"] = json!(cleanup_confirmed);
        receipt["envVarDeliveredToStdioChild"] =
            json!(present && received.as_deref() == Some(expected.as_str()));
        receipt["receivedSyntheticSha256"] = json!(received);
        receipt["nativeMcpInitializeObserved"] = json!(handshake);
        receipt["nativeHandshake"] = json!(handshake);
        receipt["treeEmpty"] = json!(tree_empty);
        receipt["cleanupConfirmed"] = json!(cleanup_confirmed);
        receipt["stdioRecord"] = json!(records
            .iter()
            .map(|row| scrub(row, &isolated))
            .collect::<Vec<_>>());
        // Names only: the MCP document carries command/args/env_vars, no value.
        receipt["nativeConfig"] = scrub(&native_config, &isolated);
        receipt["startupNotifications"] = json!(notifications
            .iter()
            .map(|message| scrub(message, &isolated))
            .collect::<Vec<_>>());
        receipt["serverRequests"] = json!(server_requests
            .iter()
            .map(|message| scrub(message, &isolated))
            .collect::<Vec<_>>());
        receipt["cleanup"] = cleanup;
        receipt["stderrTail"] = json!(stderr_tail);
        std::fs::create_dir_all(&artifact_dir).unwrap();
        let result_path = artifact_dir.join("result.json");
        std::fs::write(
            &result_path,
            format!("{}\n", serde_json::to_string_pretty(&receipt).unwrap()),
        )
        .unwrap();
        eprintln!("native reference probe receipt: {}", result_path.display());
        assert_eq!(
            receipt["envVarDeliveredToStdioChild"],
            json!(true),
            "resolved value must reach the native MCP child: {receipt}"
        );
        assert_eq!(
            receipt["nativeMcpInitializeObserved"],
            json!(true),
            "native codex must complete the MCP handshake: {receipt}"
        );
        // A tree that is not empty is a real failure, never a pass.
        assert!(
            cleanup_confirmed,
            "the owned native tree must be empty after termination: {receipt}"
        );
        true
    }

    // Independent owner: actual operator-file admission, exact scope matching
    // and value handling. Wire-level reference extraction is a protocol test;
    // this test observes only what the node would put into the native env.
    #[test]
    fn operator_binding_values_reach_only_the_native_environment() {
        let root = private_root();
        let bundle = mcp_bundle(
            ADAPTER_CODEX_CLI,
            &json!({"mcp_servers": {"github": {"env_vars": ["GITHUB_TOKEN"]}}}),
        );
        let digest = github_digest(&bundle);
        write_bindings(
            &root,
            &bindings_document(&[binding(
                "github",
                &digest,
                json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
            )]),
        );
        let launch = make_launch(bundle);
        let local = BTreeMap::from([(OsString::from("PATH"), OsString::from("/fixture/bin"))]);
        let lookup = |name: &str| {
            (name == "NODE_GITHUB_TOKEN").then(|| OsString::from("fixture-secret-value"))
        };
        let resolved = resolve_with(&root, &launch, &local, &lookup).unwrap();
        let mut environment = local.clone();
        resolved.apply(&mut environment);
        assert_eq!(
            environment.get(std::ffi::OsStr::new("GITHUB_TOKEN")),
            Some(&OsString::from("fixture-secret-value"))
        );
        assert_eq!(
            environment.get(std::ffi::OsStr::new("PATH")),
            Some(&OsString::from("/fixture/bin"))
        );
        // Nothing but the exposed name may ever be rendered.
        let rendered = format!("{resolved:?}");
        assert!(rendered.contains("GITHUB_TOKEN"));
        assert!(!rendered.contains("fixture-secret-value"));
        assert!(!rendered.contains("NODE_GITHUB_TOKEN"));
        // Confirmation rereads the file and the named source.
        confirm_with(&root, &launch, &local, &resolved, &lookup).unwrap();
        assert_eq!(
            confirm_with(&root, &launch, &local, &resolved, &|_| {
                Some(OsString::from("changed-value"))
            })
            .err(),
            Some("pipe_mcp_reference_changed")
        );
        // The same resolved value from a different source is still a change:
        // comparing values alone would let a swapped source name pass.
        write_bindings(
            &root,
            &bindings_document(&[binding(
                "github",
                &digest,
                json!({"GITHUB_TOKEN": "NODE_OTHER_TOKEN"}),
            )]),
        );
        assert_eq!(
            confirm_with(&root, &launch, &local, &resolved, &|_| {
                Some(OsString::from("fixture-secret-value"))
            })
            .err(),
            Some("pipe_mcp_reference_changed")
        );
        // Removing the rule is a refusal as well.
        write_bindings(&root, &bindings_document(&[]));
        assert_eq!(
            confirm_with(&root, &launch, &local, &resolved, &lookup).err(),
            Some("pipe_mcp_reference_unbound")
        );
        // Explicit opt-in: only an operator naming real host binaries runs the
        // native half. Unset by default, so an ordinary run is unchanged.
        match (
            std::env::var_os("LOOM_TEST_CODEX_BIN"),
            std::env::var_os("LOOM_TEST_PYTHON"),
            std::env::var_os("LOOM_TEST_MCP_FIXTURE"),
        ) {
            (Some(codex_bin), Some(python_bin), Some(fixture)) => {
                let retained = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("test runtime")
                    .block_on(native_reference_probe(
                        &root,
                        &codex_bin,
                        &python_bin,
                        Path::new(&fixture),
                    ));
                if !retained {
                    // Diagnostic retention: the isolated root is deliberately
                    // kept, so the outer delete must not run on this path.
                    eprintln!(
                        "loom: native probe retained its isolated root for inspection: {}",
                        root.display()
                    );
                    return;
                }
            }
            _ => eprintln!(
                "loom: skipping native reference probe; set LOOM_TEST_CODEX_BIN, LOOM_TEST_PYTHON and LOOM_TEST_MCP_FIXTURE to run it"
            ),
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exact_scope_and_digest_are_required_and_ambiguity_is_refused() {
        let root = private_root();
        let bundle = mcp_bundle(
            ADAPTER_CODEX_CLI,
            &json!({"mcp_servers": {"github": {"env_vars": ["GITHUB_TOKEN"]}}}),
        );
        let digest = github_digest(&bundle);
        let launch = make_launch(bundle);
        let local = BTreeMap::new();
        let lookup = |name: &str| {
            (name == "NODE_GITHUB_TOKEN").then(|| OsString::from("fixture-value"))
        };
        let resolve = |root: &Path| resolve_with(root, &launch, &local, &lookup);

        // No operator file is a refusal, never an empty rule set.
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
        // Missing binding.
        write_bindings(&root, &bindings_document(&[]));
        assert_eq!(
            resolve(&root).err(),
            Some("pipe_mcp_reference_unbound")
        );
        // Every scope field is exact; none may fall back to a wider rule.
        for (field, value) in [
            ("controllerId", "controller_other"),
            ("memberId", "member_other"),
            ("workspaceId", "workspace_other"),
            ("serverName", "other"),
        ] {
            let mut entry = binding(
                "github",
                &digest,
                json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
            );
            entry[field] = json!(value);
            write_bindings(&root, &bindings_document(&[entry]));
            assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_unbound"));
        }
        // A stale document digest and a bound server without the variable.
        let other = format!("sha256:{}", "0".repeat(64));
        write_bindings(
            &root,
            &bindings_document(&[binding(
                "github",
                &other,
                json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
            )]),
        );
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_unbound"));
        write_bindings(
            &root,
            &bindings_document(&[binding(
                "github",
                &digest,
                json!({"OTHER_TOKEN": "NODE_GITHUB_TOKEN"}),
            )]),
        );
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_unbound"));
        // Two identical rules make the source ambiguous.
        let entry = binding(
            "github",
            &digest,
            json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
        );
        write_bindings(&root, &bindings_document(&[entry.clone(), entry]));
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_ambiguous"));
        // The mapped source must exist on this host right now.
        write_bindings(
            &root,
            &bindings_document(&[binding(
                "github",
                &digest,
                json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
            )]),
        );
        assert_eq!(
            resolve_with(&root, &launch, &local, &|_| None).err(),
            Some("pipe_mcp_reference_missing")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    // Independent owner: strict file shape and value invariants. A malformed
    // operator file must refuse the Run, not be repaired or partially read.
    #[test]
    fn malformed_bindings_conflicts_and_bad_values_are_refused() {
        let root = private_root();
        let bundle = mcp_bundle(
            ADAPTER_CODEX_CLI,
            &json!({"mcp_servers": {"github": {"env_vars": ["GITHUB_TOKEN"]}}}),
        );
        let digest = github_digest(&bundle);
        let launch = make_launch(bundle);
        let local = BTreeMap::new();
        let lookup = |name: &str| Some(OsString::from(name));
        let resolve = |root: &Path| resolve_with(root, &launch, &local, &lookup);

        // Both names use the protocol's variable-name contract.
        for variables in [
            json!({"PATH": "NODE_GITHUB_TOKEN"}),
            json!({"github_token": "NODE_GITHUB_TOKEN"}),
            json!({"GITHUB_TOKEN": "PATH"}),
            json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN "}),
        ] {
            write_bindings(&root, &bindings_document(&[binding("github", &digest, variables)]));
            assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_name"));
        }
        // Unknown, missing and unsupported shapes are refused whole.
        let entry = binding(
            "github",
            &digest,
            json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
        );
        let mut extra = entry.clone();
        extra["extra"] = json!(true);
        write_bindings(&root, &bindings_document(&[extra]));
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
        let mut missing = entry;
        missing.as_object_mut().unwrap().remove("variables");
        write_bindings(&root, &bindings_document(&[missing]));
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
        write_bindings(
            &root,
            &serde_json::to_vec(&json!({"version": 2, "bindings": []})).unwrap(),
        );
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
        let too_many = (0..=MAX_BINDINGS)
            .map(|_| {
                binding(
                    "github",
                    &digest,
                    json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
                )
            })
            .collect::<Vec<_>>();
        write_bindings(&root, &bindings_document(&too_many));
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
        let mut variables = Map::new();
        for index in 0..=MAX_VARIABLES {
            variables.insert(format!("TOKEN_{index}"), json!("NODE_GITHUB_TOKEN"));
        }
        write_bindings(
            &root,
            &bindings_document(&[binding("github", &digest, Value::Object(variables))]),
        );
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
        write_bindings(&root, &vec![b' '; MAX_BINDINGS_BYTES as usize + 1]);
        assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
        // The file must keep its private permissions.
        write_bindings(
            &root,
            &bindings_document(&[binding(
                "github",
                &digest,
                json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
            )]),
        );
        assert!(resolve(&root).is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = root.join(BINDINGS_FILE);
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(resolve(&root).err(), Some("pipe_mcp_reference_bindings"));
            write_bindings(
                &root,
                &bindings_document(&[binding(
                    "github",
                    &digest,
                    json!({"GITHUB_TOKEN": "NODE_GITHUB_TOKEN"}),
                )]),
            );
        }
        // A wire-supplied name may not be overwritten by a binding.
        let colliding =
            BTreeMap::from([(OsString::from("GITHUB_TOKEN"), OsString::from("wire"))]);
        assert_eq!(
            resolve_with(&root, &launch, &colliding, &lookup).err(),
            Some("pipe_mcp_reference_conflict")
        );
        // Values are bounded and never carry NUL.
        assert_eq!(
            resolve_with(&root, &launch, &local, &|_| Some(OsString::from("bad\0value"))).err(),
            Some("pipe_mcp_reference_value")
        );
        assert_eq!(
            resolve_with(&root, &launch, &local, &|_| {
                Some(OsString::from("x".repeat(MAX_VALUE_BYTES + 1)))
            })
            .err(),
            Some("pipe_mcp_reference_value")
        );
        assert!(
            resolve_with(&root, &launch, &local, &|_| {
                Some(OsString::from("x".repeat(MAX_VALUE_BYTES)))
            })
            .is_ok()
        );
        // Two servers may name the same exposed variable, but never two values.
        let shared = mcp_bundle(
            ADAPTER_CODEX_CLI,
            &json!({"mcp_servers": {
                "alpha": {"env_vars": ["SHARED_TOKEN"]},
                "beta": {"env_vars": ["SHARED_TOKEN"]},
            }}),
        );
        let references = mcp_environment_references(&shared).unwrap();
        let alpha = references
            .iter()
            .find(|reference| reference.server_name == "alpha")
            .unwrap();
        let beta = references
            .iter()
            .find(|reference| reference.server_name == "beta")
            .unwrap();
        write_bindings(
            &root,
            &bindings_document(&[
                binding("alpha", &alpha.config_digest, json!({"SHARED_TOKEN": "NODE_ALPHA"})),
                binding("beta", &beta.config_digest, json!({"SHARED_TOKEN": "NODE_BETA"})),
            ]),
        );
        let shared_launch = make_launch(shared);
        assert_eq!(
            resolve_with(&root, &shared_launch, &local, &|name| {
                Some(OsString::from(if name == "NODE_ALPHA" { "one" } else { "two" }))
            })
            .err(),
            Some("pipe_mcp_reference_conflict")
        );
        assert!(
            resolve_with(&root, &shared_launch, &local, &|_| Some(OsString::from("one")))
                .is_ok()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn references_are_codex_v2_only_and_absent_references_keep_the_old_path() {
        // No reference: the operator file need not exist and nothing is read.
        let root = private_root();
        let plain = mcp_bundle(
            ADAPTER_CODEX_CLI,
            &json!({"mcp_servers": {"github": {"command": "fixture"}}}),
        );
        assert!(mcp_environment_references(&plain).unwrap().is_empty());
        let mut plain_launch = make_launch(plain);
        plain_launch.bundle.as_mut().unwrap().version = RUN_BUNDLE_VERSION;
        assert_eq!(
            resolve_with(&root, &plain_launch, &BTreeMap::new(), &|_| None).unwrap(),
            LaunchEnvironment::default()
        );
        // Claude Code references are refused before any file is opened.
        let claude = mcp_bundle(
            ADAPTER_CLAUDE_CODE,
            &json!({"mcpServers": {"github": {"env": {"TOKEN": "${GITHUB_TOKEN}"}}}}),
        );
        assert!(!mcp_environment_references(&claude).unwrap().is_empty());
        assert_eq!(
            resolve_with(&root, &make_launch(claude), &BTreeMap::new(), &|_| None).err(),
            Some("pipe_mcp_reference_adapter")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
