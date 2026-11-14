//! Node-side admission and private materialization of a frozen member bundle.
//! Native flags are derived here; the wire never supplies flags or absolute destinations.
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use loom_protocol::run_bundle::{
    ADAPTER_CLAUDE_CODE, ADAPTER_CODEX_CLI, BundleArtifact, BundleExpectation, RunBundleV1,
    canonical_adapter_kind, decode_file, validate,
};
use serde_json::Value;

pub(crate) struct PreparedRunBundle {
    root: PathBuf,
    args: Vec<String>,
}

impl PreparedRunBundle {
    pub(crate) fn args(&self) -> &[String] {
        &self.args
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn skill_root(&self) -> Result<String, &'static str> {
        native_path(&self.root.join("skills"))
    }
}

impl Drop for PreparedRunBundle {
    fn drop(&mut self) {
        // Only this fresh UUID-named owner directory is ours. Refuse a replaced
        // symlink/reparse path rather than following it during cleanup.
        if owned_directory(&self.root).is_ok() {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

/// Pure checks happen before filesystem work or process registration.
pub(crate) fn admit(
    bundle: &RunBundleV1,
    run_id: &str,
    attempt: u32,
    adapter_kind: &str,
    args: &[String],
) -> Result<(), &'static str> {
    // Legacy Start never carries a credential reference: only the typed pipe
    // path resolves one. Refuse the newer shape instead of ignoring it.
    if bundle.version != loom_protocol::run_bundle::RUN_BUNDLE_VERSION {
        return Err(loom_protocol::run_bundle::BundleReject::Version.code());
    }
    admit_internal(bundle, run_id, attempt, adapter_kind, args, None)
}

fn admit_internal(
    bundle: &RunBundleV1, run_id: &str, attempt: u32, adapter_kind: &str,
    args: &[String], hook_grant: Option<&loom_protocol::command_hooks::CodexHookGrantV1>,
) -> Result<(), &'static str> {
    validate(
        bundle,
        &BundleExpectation {
            run_id,
            attempt,
            adapter_kind,
        },
    )
    .map_err(|error| error.code())?;
    let runtime = canonical_adapter_kind(adapter_kind).ok_or("bundle_adapter")?;
    validate_base_args(runtime, args)?;
    if runtime == ADAPTER_CODEX_CLI
        && bundle
            .files
            .iter()
            .any(|file| file.artifact == BundleArtifact::RuntimeSettings)
    {
        // Legacy Start never carries a grant. Only v2 typed pipe admission can
        // materialize reviewed definitions; the A native driver still must obtain
        // standard thread-local native trust for the exact metadata hash.
        hook_grant.ok_or("bundle_hooks_trust_required")?.validate(bundle)?;
    } else if hook_grant.is_some() {
        return Err("bundle_hook_grant_unexpected");
    }
    for file in &bundle.files {
        if matches!(
            file.artifact,
            BundleArtifact::McpConfig | BundleArtifact::RuntimeSettings
        ) {
            let bytes = decode_file(file).map_err(|error| error.code())?;
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "bundle_native_config")?;
            let object = value.as_object().ok_or("bundle_native_config")?;
            let key = match file.artifact {
                BundleArtifact::RuntimeSettings => "hooks",
                _ if runtime == ADAPTER_CODEX_CLI => "mcp_servers",
                _ => "mcpServers",
            };
            if file.artifact == BundleArtifact::RuntimeSettings && runtime == ADAPTER_CLAUDE_CODE {
                if object.is_empty()
                    || object.keys().any(|name| name != "hooks" && name != "env")
                    || object.get("hooks").is_some_and(|value| !value.is_object())
                {
                    return Err("bundle_native_config");
                }
                if let Some(env) = object.get("env") {
                    let expected = serde_json::json!({
                        "CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1",
                        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"
                    });
                    if env != &expected {
                        return Err("bundle_native_config");
                    }
                }
            } else if object.len() != 1 || !object.get(key).is_some_and(Value::is_object) {
                return Err("bundle_native_config");
            }
        }
    }
    Ok(())
}

pub(crate) fn materialize(
    data_dir: &Path,
    bundle: &RunBundleV1,
    run_id: &str,
    attempt: u32,
    adapter_kind: &str,
    base_args: &[String],
) -> Result<PreparedRunBundle, &'static str> {
    materialize_internal(
        data_dir,
        bundle,
        run_id,
        attempt,
        adapter_kind,
        base_args,
        CodexMcpMode::LaunchOverride,
        None,
    )
}

#[derive(Clone, Copy)]
enum CodexMcpMode {
    LaunchOverride,
    ThreadConfiguration,
}

fn materialize_internal(
    data_dir: &Path,
    bundle: &RunBundleV1,
    run_id: &str,
    attempt: u32,
    adapter_kind: &str,
    base_args: &[String],
    codex_mcp_mode: CodexMcpMode,
    hook_grant: Option<&loom_protocol::command_hooks::CodexHookGrantV1>,
) -> Result<PreparedRunBundle, &'static str> {
    admit_internal(bundle, run_id, attempt, adapter_kind, base_args, hook_grant)?;
    let codex_hooks = if hook_grant.is_some() {
        Some(loom_protocol::command_hooks::settings(bundle)?
            .ok_or("bundle_hook_settings_required")?.1)
    } else { None };
    let parent = data_dir
        .canonicalize()
        .map_err(|_| "bundle_private_storage")?;
    let root = parent.join(format!(
        "bundle-{run_id}-{attempt}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let root = create_private_directory(&root)?;
    let mut prepared = PreparedRunBundle {
        root,
        args: Vec::new(),
    };
    let skill_root = native_path(&prepared.root.join("skills"))?;
    let runtime = canonical_adapter_kind(adapter_kind).ok_or("bundle_adapter")?;
    let mut instructions = None;
    let mut mcp = None;
    let mut settings = None;
    for file in &bundle.files {
        let mut bytes = decode_file(file).map_err(|error| error.code())?;
        if file.artifact == BundleArtifact::BootstrapPrompt {
            let text = std::str::from_utf8(&bytes).map_err(|_| "bundle_content")?;
            bytes = relocate_skill_roots(
                text,
                bundle.source_skill_root.as_deref(),
                &skill_root,
                bundle,
            )?
            .into_bytes();
            instructions = Some(String::from_utf8(bytes.clone()).map_err(|_| "bundle_content")?);
        }
        let path = prepared.root.join(&file.path);
        private_parents(&prepared.root, path.parent().ok_or("bundle_path")?)?;
        let mut output = rovai_private_storage::create_private_new_file(&path)
            .map_err(|_| "bundle_private_storage")?;
        output
            .write_all(&bytes)
            .map_err(|_| "bundle_private_storage")?;
        output.sync_all().map_err(|_| "bundle_private_storage")?;
        if file.artifact == BundleArtifact::McpConfig {
            mcp =
                Some(serde_json::from_slice::<Value>(&bytes).map_err(|_| "bundle_native_config")?);
        } else if file.artifact == BundleArtifact::RuntimeSettings {
            settings = Some(path);
        }
    }
    let instructions = instructions.ok_or("bundle_missing_bootstrap")?;
    let mut native = Vec::new();
    if runtime == ADAPTER_CLAUDE_CODE {
        native.extend([
            "--append-system-prompt-file".to_string(),
            native_path(&prepared.root.join("bootstrap.txt"))?,
        ]);
        if mcp.is_some() {
            native.extend([
                "--mcp-config".to_string(),
                native_path(&prepared.root.join("mcp.json"))?,
            ]);
        }
        if let Some(path) = settings {
            native.extend(["--settings".to_string(), native_path(&path)?]);
        }
    } else {
        native.extend([
            "-c".to_string(),
            format!(
                "developer_instructions={}",
                toml_expression(&Value::String(instructions))?
            ),
        ]);
        // Persistent app-server Hosts first read actual native configuration.
        // Their selected external MCP is applied by the existing thread config
        // projection; a launch override would falsely appear as native-owned.
        if let Some(mcp) = mcp.filter(|_| matches!(codex_mcp_mode, CodexMcpMode::LaunchOverride)) {
            native.extend([
                "-c".to_string(),
                format!("mcp_servers={}", toml_expression(&mcp["mcp_servers"])?),
            ]);
        }
        if let Some(settings) = codex_hooks {
            // Keys were checked by command_hooks::parse before any filesystem write.
            // No hooks.state, profile, feature or managed-policy switch is introduced.
            for (event, groups) in settings["hooks"].as_object().ok_or("bundle_hook_events_object")? {
                native.extend(["-c".to_string(),
                    format!("hooks.{event}={}", toml_expression(groups)?)]);
            }
        }
    }
    // Prefix native global overrides before the verb/task; an argument after
    // "--" or a positional task must never swallow the bundle's own flags.
    native.extend_from_slice(base_args);
    #[cfg(windows)]
    if native
        .iter()
        .map(|arg| arg.encode_utf16().count() + 3)
        .sum::<usize>()
        > 28_000
    {
        return Err("bundle_native_args_too_large");
    }
    #[cfg(not(windows))]
    if native.iter().any(|arg| arg.len() > 120 * 1024) {
        return Err("bundle_native_args_too_large");
    }
    prepared.args = native;
    Ok(prepared)
}

/// Trusted persistent Host projection. File arguments are typed references into
/// this immutable packet, never A's private absolute paths. The legacy Start
/// validator remains closed to arbitrary caller -c or native config flags.
pub(crate) fn materialize_pipe(
    data_dir: &Path,
    launch: &loom_protocol::process_pipe::ProcessOpenV1,
) -> Result<PreparedRunBundle, &'static str> {
    use loom_protocol::process_pipe::ProcessArgument;
    launch.validate()?;
    let bundle = launch.bundle.as_ref().ok_or("pipe_bundle_required")?;
    let runtime = canonical_adapter_kind(&launch.adapter_kind).ok_or("bundle_adapter")?;
    let mut base = Vec::new();
    let mut controlled = Vec::new();
    let mut bound = BTreeSet::new();
    let mut index = 0;
    while index < launch.args.len() {
        let ProcessArgument::Literal { value } = &launch.args[index] else {
            return Err("pipe_material_argument");
        };
        let file_artifact = match value.as_str() {
            "--append-system-prompt-file" if runtime == ADAPTER_CLAUDE_CODE => {
                Some(BundleArtifact::BootstrapPrompt)
            }
            "--settings" if runtime == ADAPTER_CLAUDE_CODE => Some(BundleArtifact::RuntimeSettings),
            "--mcp-config" if runtime == ADAPTER_CLAUDE_CODE => Some(BundleArtifact::McpConfig),
            _ => None,
        };
        if let Some(artifact) = file_artifact {
            let Some(ProcessArgument::MaterializedFile { path }) = launch.args.get(index + 1)
            else {
                return Err("pipe_material_argument");
            };
            if !bundle
                .files
                .iter()
                .any(|file| file.artifact == artifact && &file.path == path)
                || !bound.insert(artifact)
            {
                return Err("pipe_material_argument");
            }
            index += 2;
            continue;
        }
        if runtime == ADAPTER_CODEX_CLI && value == "-c" {
            let Some(ProcessArgument::Literal {
                value: configuration,
            }) = launch.args.get(index + 1)
            else {
                return Err("pipe_native_config");
            };
            if !matches!(
                configuration.as_str(),
                "allow_login_shell=false"
                    | "features.memories=false"
                    | "memories.generate_memories=false"
                    | "memories.use_memories=false"
            ) || controlled
                .chunks(2)
                .any(|pair: &[String]| pair.get(1) == Some(configuration))
            {
                return Err("pipe_native_config");
            }
            controlled.extend(["-c".to_string(), configuration.clone()]);
            index += 2;
            continue;
        }
        let flag = value.split('=').next().unwrap_or(value);
        if matches!(flag, "--add-dir" | "--cd" | "-C" | "--cwd" | "--directory")
            || flag.starts_with("-C")
        {
            return Err("pipe_workspace_argument");
        }
        base.push(value.clone());
        index += 1;
    }
    validate_base_args(runtime, &base)?;
    let mut prepared = materialize_internal(
        data_dir,
        bundle,
        &launch.owner.agent_run_id,
        bundle.attempt,
        &launch.adapter_kind,
        &base,
        CodexMcpMode::ThreadConfiguration,
        launch.codex_hook_grant.as_ref(),
    )?;
    controlled.extend(std::mem::take(&mut prepared.args));
    prepared.args = controlled;
    // Recheck after trusted policy flags are restored.
    #[cfg(windows)]
    if prepared
        .args
        .iter()
        .map(|arg| arg.encode_utf16().count() + 3)
        .sum::<usize>()
        > 28_000
    {
        return Err("bundle_native_args_too_large");
    }
    Ok(prepared)
}

fn validate_base_args(runtime: &str, args: &[String]) -> Result<(), &'static str> {
    for arg in args {
        let flag = arg.split('=').next().unwrap_or(arg);
        let collision = if runtime == ADAPTER_CLAUDE_CODE {
            matches!(
                flag,
                "--system-prompt"
                    | "--system-prompt-file"
                    | "--append-system-prompt"
                    | "--append-system-prompt-file"
                    | "--mcp-config"
                    | "--settings"
                    | "--setting-sources"
                    | "--plugin-dir"
                    | "--strict-mcp-config"
            )
        } else {
            matches!(
                flag,
                "-c" | "--config" | "-p" | "--profile" | "--dangerously-bypass-hook-trust"
            ) || (flag.starts_with("-c") && flag != "--cd")
        };
        if collision {
            return Err("bundle_native_arg_conflict");
        }
    }
    Ok(())
}

pub(crate) use loom_protocol::run_bundle::relocate_skill_roots;

/// JSON strings use the same escaped basic-string spelling as TOML. Construct
/// inline tables explicitly so config overrides are one expression, not a TOML
/// document whose newlines could escape the intended setting.
fn toml_expression(value: &Value) -> Result<String, &'static str> {
    match value {
        Value::String(value) => serde_json::to_string(value).map_err(|_| "bundle_native_config"),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::Array(values) => {
            let parts = values
                .iter()
                .map(toml_expression)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", parts.join(", ")))
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let parts = entries
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{} = {}",
                        serde_json::to_string(key).map_err(|_| "bundle_native_config")?,
                        toml_expression(value)?
                    ))
                })
                .collect::<Result<Vec<_>, &'static str>>()?;
            Ok(format!("{{ {} }}", parts.join(", ")))
        }
        Value::Null => Err("bundle_native_config"),
    }
}

pub(crate) fn native_path(path: &Path) -> Result<String, &'static str> {
    // This is only a CLI-visible spelling. Admission, ACLs and identity checks
    // keep their canonical paths. Never reinterpret arbitrary device names.
    #[cfg(windows)]
    let visible = {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return Err("bundle_path");
        };
        let mut visible = match prefix.kind() {
            Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", char::from(drive))),
            Prefix::VerbatimUNC(server, share) => {
                let mut prefix = std::ffi::OsString::from(r"\\");
                prefix.push(server);
                prefix.push(r"\");
                prefix.push(share);
                PathBuf::from(prefix)
            }
            Prefix::Disk(_) | Prefix::UNC(_, _) => {
                return path.to_str().map(str::to_string).ok_or("bundle_path");
            }
            Prefix::DeviceNS(_) | Prefix::Verbatim(_) => return Err("bundle_path"),
        };
        for component in components {
            visible.push(component.as_os_str());
        }
        visible
    };
    #[cfg(not(windows))]
    let visible = path.to_path_buf();
    visible.to_str().map(str::to_string).ok_or("bundle_path")
}

fn create_private_directory(path: &Path) -> Result<PathBuf, &'static str> {
    #[cfg(windows)]
    {
        rovai_private_storage::create_private_directory(path).map_err(|_| "bundle_private_storage")
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| "bundle_private_storage")?;
        owned_directory(path)?;
        path.canonicalize().map_err(|_| "bundle_private_storage")
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err("bundle_platform_unsupported")
    }
}

fn owned_directory(path: &Path) -> Result<(), &'static str> {
    #[cfg(windows)]
    {
        rovai_private_storage::admit_private_directory(path)
            .map_err(|_| "bundle_private_storage")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::symlink_metadata(path).map_err(|_| "bundle_private_storage")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("bundle_private_storage");
        }
    }
    #[cfg(not(any(unix, windows)))]
    return Err("bundle_platform_unsupported");
    Ok(())
}

fn private_parents(root: &Path, parent: &Path) -> Result<(), &'static str> {
    let relative = parent.strip_prefix(root).map_err(|_| "bundle_path")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("bundle_path");
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(_) => owned_directory(&current)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_private_directory(&current)?;
            }
            Err(_) => return Err("bundle_private_storage"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[cfg(windows)]
    #[test]
    fn native_windows_path_spelling_preserves_drive_unc_and_refuses_devices() {
        use std::path::Path;
        assert_eq!(
            super::native_path(Path::new(r"\\?\C:\fixture path\tmp")).unwrap(),
            r"C:\fixture path\tmp"
        );
        assert_eq!(
            super::native_path(Path::new(r"\\?\UNC\server\share\fixture path\tmp")).unwrap(),
            r"\\server\share\fixture path\tmp"
        );
        assert_eq!(
            super::native_path(Path::new(r"C:\fixture\tmp")).unwrap(),
            r"C:\fixture\tmp"
        );
        assert_eq!(
            super::native_path(Path::new(r"\\server\share\tmp")).unwrap(),
            r"\\server\share\tmp"
        );
        for value in [
            r"\\.\pipe\fixture",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\tmp",
            r"\\?\Volume{fixture}\tmp",
        ] {
            assert_eq!(super::native_path(Path::new(value)), Err("bundle_path"));
        }
    }
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use loom_protocol::run_bundle::{
        BundleFile, RUN_BUNDLE_VERSION, bundle_digest, bundle_id_for, canonical_path,
    };

    fn fixture(runtime: &str) -> RunBundleV1 {
        let content = b"[SESSION_CHARTER]\nfixture\n[/SESSION_CHARTER]";
        let mut bundle = RunBundleV1 {
            version: RUN_BUNDLE_VERSION,
            bundle_id: bundle_id_for("run_bundle_fixture", 1),
            run_id: "run_bundle_fixture".into(),
            attempt: 1,
            agent_id: "member_fixture".into(),
            adapter_kind: runtime.into(),
            selection_revision: "fixture-revision".into(),
            source_skill_root: None,
            digest: String::new(),
            files: vec![BundleFile {
                artifact: BundleArtifact::BootstrapPrompt,
                label: "bootstrap".into(),
                path: canonical_path(BundleArtifact::BootstrapPrompt, "bootstrap").unwrap(),
                bytes: content.len(),
                content: STANDARD.encode(content),
            }],
        };
        bundle.digest = bundle_digest(&bundle).unwrap();
        bundle
    }

    // Independent owner: actual node-side private creation, publication and
    // failure/drop cleanup. Pure protocol/builder tests cannot observe an ACL.
    // Regression input: a valid fixture plus a later failed write.
    // Lowest-cost command: cargo test -p loom-node --lib run_bundle::tests::
    #[test]
    fn private_bundle_materialization_cleans_its_own_directory_on_success_and_failure() {
        let parent =
            std::env::temp_dir().join(format!("loom-bundle-owner-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&parent).unwrap();
        let sibling = parent.join("unrelated");
        fs::write(&sibling, b"keep").unwrap();
        let bundle = fixture(ADAPTER_CLAUDE_CODE);
        let args = vec!["-p".to_string(), "fixture task".to_string()];
        let prepared = materialize(
            &parent,
            &bundle,
            &bundle.run_id,
            1,
            ADAPTER_CLAUDE_CODE,
            &args,
        )
        .unwrap();
        let owned = prepared.root().to_path_buf();
        assert_eq!(&prepared.args()[0], "--append-system-prompt-file");
        assert_eq!(&prepared.args()[2..], args.as_slice());
        let input = owned.join("bootstrap.txt");
        let bytes = fs::read(&input).unwrap();
        assert_eq!(bytes, decode_file(&bundle.files[0]).unwrap());
        drop(rovai_private_storage::open_private_read_file(&input).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&owned).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&input).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        #[cfg(windows)]
        rovai_private_storage::admit_private_directory(&owned).unwrap();
        drop(prepared);
        assert!(!owned.exists());
        assert_eq!(fs::read(&sibling).unwrap(), b"keep");

        let mut invalid = bundle.clone();
        invalid.digest.push('0');
        assert!(
            materialize(
                &parent,
                &invalid,
                &bundle.run_id,
                1,
                ADAPTER_CLAUDE_CODE,
                &args
            )
            .is_err()
        );
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);

        // Protocol-valid packet, but no matching structured Skill index. This
        // fails after creating the private directory and must clean it too.
        let mut invalid_index = bundle.clone();
        invalid_index.source_skill_root = Some("C:/frozen/skills".into());
        invalid_index.files.push(BundleFile {
            artifact: BundleArtifact::SkillFile,
            label: "fixture/SKILL.md".into(),
            path: "skills/fixture/SKILL.md".into(),
            bytes: 7,
            content: STANDARD.encode(b"fixture"),
        });
        invalid_index.digest = bundle_digest(&invalid_index).unwrap();
        assert_eq!(
            materialize(
                &parent,
                &invalid_index,
                &bundle.run_id,
                1,
                ADAPTER_CLAUDE_CODE,
                &args
            )
            .err(),
            Some("bundle_skill_index")
        );
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);

        // Positive relocation preserves renderer key order, whitespace and an
        // unrelated occurrence of the A root in a rule.
        let original = "[SESSION_CHARTER]\nfixture\n[/SESSION_CHARTER]\n\n[ROVAI_ADDITIONAL_SKILLS]\nCurrent for this run; replaces any earlier Rovai Additional Skills.\n{\"root\":\"C:/frozen/skills\",\"skills\":[{\"name\":\"fixture\",\"desc\":\"unchanged description\"}]}\n[/ROVAI_ADDITIONAL_SKILLS]\n\n  Rule keeps C:/frozen/skills literally.  ";
        let mut indexed = invalid_index;
        indexed.files[0].bytes = original.len();
        indexed.files[0].content = STANDARD.encode(original);
        indexed.digest = bundle_digest(&indexed).unwrap();
        let prepared = materialize(
            &parent,
            &indexed,
            &indexed.run_id,
            1,
            ADAPTER_CLAUDE_CODE,
            &args,
        )
        .unwrap();
        let destination = native_path(&prepared.root().join("skills")).unwrap();
        let expected = original.replacen(
            "\"root\":\"C:/frozen/skills\"",
            &format!("\"root\":{}", serde_json::to_string(&destination).unwrap()),
            1,
        );
        assert_eq!(
            fs::read_to_string(prepared.root().join("bootstrap.txt")).unwrap(),
            expected
        );
        let selected_file = prepared.root().join("skills/fixture/SKILL.md");
        assert_eq!(fs::read(&selected_file).unwrap(), b"fixture");
        drop(rovai_private_storage::open_private_read_file(&selected_file).unwrap());
        drop(prepared);
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
        fs::remove_dir_all(parent).unwrap();
    }

    // Independent owner: native argument placement/escaping and runtime trust
    // refusal. Protocol validity does not imply native settings are applied.
    #[test]
    fn native_arguments_cannot_override_the_bundle_or_silently_skip_untrusted_hooks() {
        for args in [
            vec!["--settings=x".into()],
            vec!["--append-system-prompt".into(), "override".into()],
        ] {
            let bundle = fixture(ADAPTER_CLAUDE_CODE);
            assert_eq!(
                admit(&bundle, &bundle.run_id, 1, ADAPTER_CLAUDE_CODE, &args),
                Err("bundle_native_arg_conflict")
            );
        }
        let mut bundle = fixture(ADAPTER_CODEX_CLI);
        let settings =
            br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo fixture"}]}]}}"#;
        bundle.files.push(BundleFile {
            artifact: BundleArtifact::RuntimeSettings,
            label: "settings".into(),
            path: "settings.json".into(),
            bytes: settings.len(),
            content: STANDARD.encode(settings),
        });
        bundle.digest = bundle_digest(&bundle).unwrap();
        assert_eq!(
            admit(
                &bundle,
                &bundle.run_id,
                1,
                ADAPTER_CODEX_CLI,
                &["exec".into()]
            ),
            Err("bundle_hooks_trust_required")
        );
        // The same immutable MCP bytes have two native injection owners:
        // legacy Start uses CLI config; a persistent app-server uses native
        // thread configuration after its honest native config/read snapshot.
        let parent = std::env::temp_dir().join(format!("loom-mcp-mode-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&parent).unwrap();
        let mut selected = fixture(ADAPTER_CODEX_CLI);
        let mcp = br#"{"mcp_servers":{"selected":{"url":"http://127.0.0.1:23456/mcp"}}}"#;
        selected.files.push(BundleFile {
            artifact: BundleArtifact::McpConfig,
            label: "mcp".into(),
            path: "mcp.json".into(),
            bytes: mcp.len(),
            content: STANDARD.encode(mcp),
        });
        selected.digest = bundle_digest(&selected).unwrap();
        let legacy = materialize(
            &parent,
            &selected,
            &selected.run_id,
            1,
            ADAPTER_CODEX_CLI,
            &["exec".into()],
        )
        .unwrap();
        assert!(
            legacy
                .args()
                .windows(2)
                .any(|pair| pair[0] == "-c" && pair[1].starts_with("mcp_servers="))
        );
        use loom_protocol::process_pipe::{
            AgentRunOwner, PROCESS_PIPE_VERSION, ProcessArgument, ProcessOpenV1,
            ProcessSessionOwner, RemoteProcessKey,
        };
        let mut launch = ProcessOpenV1 {
            codex_hook_grant: None,
            version: PROCESS_PIPE_VERSION,
            key: RemoteProcessKey {
                node_id: "node_fixture".into(),
                process_id: "process_fixture".into(),
                process_epoch: 1,
            },
            session: ProcessSessionOwner {
                member_id: selected.agent_id.clone(),
                logical_session_id: "session_fixture".into(),
                workspace_id: "workspace_fixture".into(),
                controller_id: "controller_fixture".into(),
            },
            owner: AgentRunOwner {
                agent_run_id: selected.run_id.clone(),
                execution_epoch: 1,
            },
            builtin_tasks_enabled: true,
            adapter_kind: ADAPTER_CODEX_CLI.into(),
            catalog_generation: 1,
            program_identity: format!("sha256:{}", "1".repeat(64)),
            program: "fixture-native-program".into(),
            cwd: "fixture-prepared-workspace".into(),
            args: ["-c", "features.memories=false", "app-server"]
                .into_iter()
                .map(|value| ProcessArgument::Literal {
                    value: value.into(),
                })
                .collect(),
            environment: Vec::new(),
            bundle: Some(selected.clone()),
        };
        let persistent = materialize_pipe(&parent, &launch).unwrap();
        assert!(
            !persistent
                .args()
                .iter()
                .any(|arg| arg.starts_with("mcp_servers="))
        );
        assert!(
            persistent
                .args()
                .iter()
                .any(|arg| arg.starts_with("developer_instructions="))
        );
        assert!(
            persistent
                .args()
                .iter()
                .any(|arg| arg == "features.memories=false")
        );
        assert_eq!(fs::read(legacy.root().join("mcp.json")).unwrap(), mcp);
        assert_eq!(fs::read(persistent.root().join("mcp.json")).unwrap(), mcp);
        // Preserve the legacy refusal above; the new path needs both a v2
        // envelope and the exact immutable settings grant before writing files.
        let no_hook_wire = serde_json::to_value(&launch).unwrap();
        assert_eq!(no_hook_wire["version"], 1);
        assert!(no_hook_wire.get("codexHookGrant").is_none());
        let mut reviewed = launch.clone();
        reviewed.bundle = Some(bundle.clone());
        reviewed.codex_hook_grant = Some(loom_protocol::command_hooks::CodexHookGrantV1 {
            version: loom_protocol::command_hooks::CODEX_HOOK_GRANT_VERSION,
            settings_digest: loom_protocol::command_hooks::digest(settings),
            review_digest: format!("sha256:{}", "c".repeat(64)),
        });
        assert_eq!(reviewed.validate(), Err("pipe_hook_grant_version"));
        reviewed.version = loom_protocol::command_hooks::CODEX_HOOK_PIPE_VERSION;
        reviewed.validate().unwrap();
        let original_args = reviewed.args.clone();
        let prepared = materialize_pipe(&parent, &reviewed).unwrap();
        let flags = prepared.args().windows(2).filter(|pair| pair[0] == "-c")
            .map(|pair| pair[1].as_str()).collect::<Vec<_>>();
        assert_eq!(flags.iter().filter(|flag| flag.starts_with("hooks.Stop=")).count(),1);
        assert!(!flags.iter().any(|flag| flag.starts_with("hooks.state")
            || flag.starts_with("features.hooks") || flag.starts_with("profile")
            || flag.contains("bypass-hook-trust")));
        assert_eq!(fs::read(prepared.root().join("settings.json")).unwrap(), settings);
        drop(prepared);
        let before = fs::read_dir(&parent).unwrap().count();
        let mut mismatch = reviewed.clone();
        mismatch.codex_hook_grant.as_mut().unwrap().settings_digest = format!("sha256:{}","0".repeat(64));
        assert_eq!(materialize_pipe(&parent,&mismatch).err(),Some("bundle_hook_grant_settings"));
        let mut missing = reviewed.clone();
        missing.codex_hook_grant = None;
        assert_eq!(materialize_pipe(&parent,&missing).err(),Some("pipe_hook_grant_version"));
        for value in ["hooks.state={}", "features.hooks=true"] {
            reviewed.args = vec![
                ProcessArgument::Literal{value:"-c".into()}, ProcessArgument::Literal{value:value.into()},
                ProcessArgument::Literal{value:"app-server".into()},
            ];
            assert_eq!(materialize_pipe(&parent,&reviewed).err(),Some("pipe_native_config"));
        }
        reviewed.args = vec![
            ProcessArgument::Literal{value:"--dangerously-bypass-hook-trust".into()},
            ProcessArgument::Literal{value:"app-server".into()},
        ];
        assert_eq!(materialize_pipe(&parent,&reviewed).err(),Some("bundle_native_arg_conflict"));
        reviewed.args = original_args;
        let forbidden=br#"{"hooks":{"state":{"arbitrary":{"trusted_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}"#;
        let changed_bundle=reviewed.bundle.as_mut().unwrap();
        let file=changed_bundle.files.iter_mut().find(|file| file.artifact==BundleArtifact::RuntimeSettings).unwrap();
        file.content=STANDARD.encode(forbidden);file.bytes=forbidden.len();
        changed_bundle.digest=bundle_digest(changed_bundle).unwrap();
        reviewed.codex_hook_grant.as_mut().unwrap().settings_digest=loom_protocol::command_hooks::digest(forbidden);
        assert!(materialize_pipe(&parent,&reviewed).is_err());
        assert_eq!(fs::read_dir(&parent).unwrap().count(),before);
        launch.args = ["-c", "mcp_servers={}", "app-server"]
            .into_iter()
            .map(|value| ProcessArgument::Literal {
                value: value.into(),
            })
            .collect();
        assert_eq!(
            materialize_pipe(&parent, &launch).err(),
            Some("pipe_native_config")
        );
        drop(persistent);
        drop(legacy);
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        fs::remove_dir(parent).unwrap();

        assert_eq!(
            toml_expression(&serde_json::json!({"quoted.name": ["a\nb", "\"quoted\""]})).unwrap(),
            r#"{ "quoted.name" = ["a\nb", "\"quoted\""] }"#
        );
    }
}
