//! Compatibility re-exports for the shared Windows entrypoint owner.
pub(crate) use rovai_runtime_entrypoint::*;

#[cfg(test)]
pub(crate) fn resolve_codex_cmd_shim(shim_path: &std::path::Path) -> Option<std::path::PathBuf> {
    inspect_codex_cmd_shim(shim_path).map(|resolved| resolved.executable)
}
