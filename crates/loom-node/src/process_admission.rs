//! Node-owned admission for one persistent native Host. A supplies frozen
//! identities and typed material references; it never supplies an OS environment.
use crate::{
    installation_catalog::InstallationCatalog,
    run_bundle::{self, PreparedRunBundle},
    workspace_authority::WorkspaceAuthority,
};
use loom_protocol::process_pipe::ProcessOpenV1;
use rovai_process_boundary::{ProcessSpec, StdinPolicy};
use std::{collections::BTreeMap, ffi::OsString, path::Path};

pub(crate) fn prepare(
    data_dir: &Path,
    catalog: &InstallationCatalog,
    authority: &WorkspaceAuthority,
    launch: &ProcessOpenV1,
    builtin_environment: &BTreeMap<OsString, OsString>,
) -> Result<(ProcessSpec, PreparedRunBundle), &'static str> {
    launch.validate()?;
    let workspace = authority
        .admit(&launch.session.workspace_id, Path::new(&launch.cwd))
        .map_err(|_| "pipe_workspace_unregistered")?;
    if workspace.node_id() != launch.key.node_id {
        return Err("pipe_workspace_node");
    }
    // Revalidate both the official wrapper layout and exact native application.
    let program = catalog.admit(
        &launch.adapter_kind,
        &launch.program,
        &launch.program_identity,
        launch.catalog_generation,
    )?;
    let materials = run_bundle::materialize_pipe(data_dir, launch)?;
    let mut environment = local_environment(launch, materials.root())?;
    if builtin_environment.len() != 3
        || builtin_environment.keys().any(|key| {
            !["ROVAI_AGENT_CLI", "ROVAI_CLI_CONTEXT", "ROVAI_RUN_TMP"]
                .iter()
                .any(|name| key == &OsString::from(name))
        })
    {
        return Err("pipe_builtin_environment");
    }
    environment.extend(builtin_environment.clone());
    // Node-operator bindings for referenced native MCP credentials. A bundle
    // without references keeps the old path: no file and no environment read.
    let local = environment.clone();
    let referenced = crate::mcp_environment::resolve_launch_environment(data_dir, launch, &local)?;
    referenced.apply(&mut environment);
    let args = materials.args().iter().map(OsString::from).collect();
    let spec = ProcessSpec::new(
        program,
        args,
        workspace.working_directory().to_path_buf(),
        environment,
        StdinPolicy::Piped,
    )
    .map_err(|_| "pipe_process_spec")?;
    if spec.application_identity_digest() != launch.program_identity {
        return Err("pipe_installation_changed");
    }
    // The prepared-worktree facts are rechecked after materialization. The
    // process boundary separately captures the canonical cwd at spawn.
    let _ = authority
        .admit(&launch.session.workspace_id, spec.working_directory())
        .map_err(|_| "pipe_workspace_changed")?;
    // The operator file and every named source variable are read a second time
    // here. A change between preparation and the caller's spawn refuses the
    // attempt instead of spawning with a stale credential.
    crate::mcp_environment::confirm_launch_environment(data_dir, launch, &local, &referenced)?;
    Ok((spec, materials))
}

fn local_environment(
    launch: &ProcessOpenV1,
    material_root: &Path,
) -> Result<BTreeMap<OsString, OsString>, &'static str> {
    let mut environment = local_environment_for_adapter(&launch.adapter_kind, material_root)?;
    for (name, value) in &launch.environment {
        environment.insert(name.into(), value.into());
    }
    Ok(environment)
}

/// B-owned environment only. The caller must separately validate wire overrides.
pub(crate) fn local_environment_for_adapter(
    adapter_kind: &str,
    material_root: &Path,
) -> Result<BTreeMap<OsString, OsString>, &'static str> {
    let mut environment = BTreeMap::new();
    // This is the B host's native configuration boundary. Its normal home
    // directories remain available to the native CLI (including native assets),
    // while A credentials, arbitrary inherited variables and ROVAI auth never
    // travel into this environment.
    for name in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "HOME",
        "USERPROFILE",
        "CODEX_HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
    ] {
        // This native configuration directory is chosen by B's Node operator.
        // The controller's closed ProcessOpen environment cannot supply it.
        if name == "CODEX_HOME" && adapter_kind != "codex-cli" {
            continue;
        }
        if let Some(value) = std::env::var_os(name) {
            if value.to_string_lossy().len() > 32768 {
                return Err("pipe_local_environment");
            }
            environment.insert(name.into(), value);
        }
    }
    let temporary = native_temporary_directory(material_root)?;
    for name in ["TEMP", "TMP", "TMPDIR"] {
        environment.insert(name.into(), temporary.clone().into());
    }
    Ok(environment)
}

fn native_temporary_directory(material_root: &Path) -> Result<String, &'static str> {
    let temporary = material_root.join("tmp");
    rovai_private_storage::prepare_private_directory(&temporary)
        .map_err(|_| "pipe_private_storage")?;
    let canonical = temporary
        .canonicalize()
        .map_err(|_| "pipe_private_storage")?;
    let visible = run_bundle::native_path(&canonical).map_err(|_| "pipe_native_temporary_path")?;
    // Native wrappers (including MSYS) cannot use a verbatim namespace as a
    // display path. Prove that the ordinary spelling still resolves to this
    // exact admitted private directory before it enters the environment.
    let resolved = Path::new(&visible)
        .canonicalize()
        .map_err(|_| "pipe_native_temporary_path")?;
    if resolved != canonical || !resolved.is_dir() {
        return Err("pipe_native_temporary_path");
    }
    Ok(visible)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn native_windows_temporary_directory_roundtrips_to_private_identity() {
        let parent =
            std::env::temp_dir().join(format!("loom-native-temp-{}", uuid::Uuid::new_v4()));
        let root = rovai_private_storage::create_private_directory(&parent).unwrap();
        let result = (|| {
            let visible = native_temporary_directory(&root).unwrap();
            assert!(!visible.starts_with(r"\\?\"));
            assert!(!visible.starts_with(r"\\.\"));
            let expected = root.join("tmp").canonicalize().unwrap();
            assert!(Path::new(&visible).is_dir());
            assert_eq!(Path::new(&visible).canonicalize().unwrap(), expected);
            rovai_private_storage::admit_private_directory(&expected).unwrap();
            std::fs::write(Path::new(&visible).join("same-directory"), b"native-path").unwrap();
            assert_eq!(
                std::fs::read(expected.join("same-directory")).unwrap(),
                b"native-path"
            );
        })();
        std::fs::remove_dir_all(&root).unwrap();
        result
    }
}
