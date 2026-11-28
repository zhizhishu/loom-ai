//! Frozen embedded DeepSeek Harness runtime bundle.
//!
//! The packaged tree is produced by the DSH packaging worker and described by
//! `dsh-runtime-bundle.json`: a standalone Node runtime, the pinned
//! `@deepseek-ai/dsh` JavaScript entry with its dependency closure, a portable
//! launcher, and the complete file ledger.
//!
//! This module only *reads* that tree. It verifies the manifest pin, every
//! admitted file hash and size, the tree digest, and that no symbolic link or
//! unrecorded code file can enter the bundle. It never downloads, installs,
//! copies user DSH configuration, or launches a model.
//!
//! Validation is deliberately uncached: discovery may hash a large Node
//! binary, but a payload change can never be reported as verified merely
//! because an earlier lookup saw the same manifest metadata.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Explicit root of a packaged DSH runtime. `runtime_discovery` resolves it as
/// an explicit package selection: a verified bundle leads the DSH candidate
/// list, while native DSH stays available as a later candidate.
pub const EMBEDDED_DSH_ROOT_ENV: &str = "ROVAI_EMBEDDED_DSH_ROOT";
/// The only DSH version this crate admits for the embedded runtime.
pub const EMBEDDED_DSH_VERSION: &str = crate::dsh::MINIMUM_VERSION;
pub const EMBEDDED_DSH_MANIFEST_FILE: &str = "dsh-runtime-bundle.json";
pub const EMBEDDED_DSH_KIND: &str = "loom-dsh-runtime";
pub const EMBEDDED_DSH_SCHEMA: u64 = 1;
pub const EMBEDDED_DSH_ENTRY: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";

const MANIFEST_KEYS: [&str; 13] = [
    "schemaVersion",
    "kind",
    "platform",
    "arch",
    "nodeVersion",
    "rootVersion",
    "closureComplete",
    "installScripts",
    "launcher",
    "node",
    "entry",
    "files",
    "treeSha256",
];

const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

const CODE_EXTENSIONS: [&str; 16] = [
    "js", "mjs", "cjs", "ts", "mts", "cts", "node", "exe", "dll", "dylib", "cmd", "bat", "ps1",
    "sh", "so", "wasm",
];

/// A verified embedded DSH bundle. Every path is absolute, canonical, and
/// contained in `root`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedDshBundle {
    pub root: PathBuf,
    pub launcher: PathBuf,
    pub node: PathBuf,
    pub entry: PathBuf,
    pub root_version: String,
    pub tree_sha256: String,
}

fn host_launcher() -> &'static str {
    if cfg!(windows) { "dsh.cmd" } else { "dsh" }
}

fn host_node() -> &'static str {
    if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/node"
    }
}

/// Verify the bundle at `root`. This hashes every admitted file exactly once
/// and must be called explicitly (packaging, acceptance, or discovery).
pub fn verify_embedded_dsh(root: &Path) -> Result<EmbeddedDshBundle> {
    let root = root
        .canonicalize()
        .with_context(|| format!("embedded DSH root is missing: {}", root.display()))?;
    let manifest_path = root.join(EMBEDDED_DSH_MANIFEST_FILE);
    let manifest = read_manifest(&manifest_path)?;

    let root_version = required_str(&manifest, "rootVersion")?;
    if root_version != EMBEDDED_DSH_VERSION {
        bail!("embedded DSH manifest is not pinned to {EMBEDDED_DSH_VERSION}: {root_version}");
    }
    if required_str(&manifest, "kind")? != EMBEDDED_DSH_KIND {
        bail!("embedded DSH manifest has an unexpected kind");
    }
    if required_str(&manifest, "platform")? != std::env::consts::OS {
        bail!(
            "embedded DSH bundle targets another platform than {}",
            std::env::consts::OS
        );
    }
    if required_str(&manifest, "arch")? != std::env::consts::ARCH {
        bail!(
            "embedded DSH bundle targets another architecture than {}",
            std::env::consts::ARCH
        );
    }
    if required_str(&manifest, "nodeVersion")?.trim().is_empty() {
        bail!("embedded DSH manifest omitted the Node runtime version");
    }
    if manifest.get("closureComplete").and_then(Value::as_bool) != Some(true) {
        bail!("embedded DSH manifest must declare a complete dependency closure");
    }
    if manifest.get("installScripts").and_then(Value::as_bool) != Some(false) {
        bail!("embedded DSH manifest must declare installScripts=false");
    }

    let launcher_relative = required_str(&manifest, "launcher")?;
    let node_relative = required_str(&manifest, "node")?;
    let entry_relative = required_str(&manifest, "entry")?;
    if launcher_relative != host_launcher() {
        bail!(
            "embedded DSH launcher must be {} on {}",
            host_launcher(),
            std::env::consts::OS
        );
    }
    if node_relative != host_node() {
        bail!(
            "embedded DSH Node runtime must be {} on {}",
            host_node(),
            std::env::consts::OS
        );
    }
    if entry_relative != EMBEDDED_DSH_ENTRY {
        bail!("embedded DSH entry must be {EMBEDDED_DSH_ENTRY}");
    }

    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .context("embedded DSH manifest omitted its file list")?;
    if files.is_empty() {
        bail!("embedded DSH manifest has an empty file list");
    }
    let mut recorded: HashMap<String, (u64, String)> = HashMap::new();
    for file in files {
        let portable = file
            .get("path")
            .and_then(Value::as_str)
            .context("embedded DSH manifest file has no path")?;
        let bytes = file
            .get("bytes")
            .and_then(Value::as_u64)
            .context("embedded DSH manifest file has no size")?;
        let expected = file
            .get("sha256")
            .and_then(Value::as_str)
            .context("embedded DSH manifest file has no digest")?;
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("embedded DSH manifest has an invalid digest for {portable}");
        }
        let expected = expected.to_ascii_lowercase();
        if recorded.contains_key(portable) {
            bail!("embedded DSH manifest repeats {portable}");
        }
        let absolute = admit_file(&root, portable)?;
        let metadata = fs::metadata(&absolute)
            .with_context(|| format!("embedded DSH file is unreadable: {portable}"))?;
        if metadata.len() != bytes {
            bail!("embedded DSH size mismatch: {portable}");
        }
        let digest = file_sha256(&absolute)?;
        if digest != expected {
            bail!("embedded DSH hash mismatch: {portable}");
        }
        recorded.insert(portable.to_string(), (bytes, digest));
    }

    for required in [launcher_relative, node_relative, entry_relative] {
        if !recorded.contains_key(required) {
            bail!("embedded DSH manifest does not cover {required} in its file list");
        }
    }

    let mut sorted: Vec<(&String, &(u64, String))> = recorded.iter().collect();
    sorted.sort_by(|left, right| left.0.cmp(right.0));
    let mut tree = Sha256::new();
    for (portable, (bytes, digest)) in &sorted {
        tree.update(format!("{portable}\t{bytes}\t{digest}\n").as_bytes());
    }
    let tree_sha256 = format!("{:x}", tree.finalize());
    if tree_sha256 != required_str(&manifest, "treeSha256")? {
        bail!("embedded DSH tree digest does not match its manifest");
    }

    let mut undocumented = Vec::new();
    collect_undocumented(&root, "", &recorded, &mut undocumented)?;
    for portable in undocumented {
        if portable == EMBEDDED_DSH_MANIFEST_FILE {
            continue;
        }
        let extension = Path::new(&portable)
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if CODE_EXTENSIONS
            .iter()
            .any(|code| *code == extension.as_str())
        {
            bail!("embedded DSH bundle has an undocumented executable or code file: {portable}");
        }
        bail!("embedded DSH bundle has a file outside its closed manifest: {portable}");
    }

    Ok(EmbeddedDshBundle {
        launcher: admit_file(&root, launcher_relative)?,
        node: admit_file(&root, node_relative)?,
        entry: admit_file(&root, entry_relative)?,
        root_version: root_version.to_string(),
        tree_sha256,
        root,
    })
}

/// Full verification on every lookup. A cache is intentionally omitted: a
/// cached metadata check is weaker than the hash/size manifest this bundle
/// promises, and discovery must never promote an altered payload.
pub fn embedded_dsh_bundle(root: &Path) -> Option<EmbeddedDshBundle> {
    verify_embedded_dsh(root).ok()
}

/// Launcher executable of a verified bundle, computed from the trusted manifest.
pub fn embedded_dsh_launcher(root: &Path) -> Option<PathBuf> {
    embedded_dsh_bundle(root).map(|bundle| bundle.launcher)
}

/// Directories that discovery may append as low-priority candidates. Empty when
/// the override is unset, relative, or fails verification. User DSH state under
/// `HOME` is never read here.
pub fn embedded_dsh_search_directories() -> Vec<PathBuf> {
    let Some(value) = std::env::var_os(EMBEDDED_DSH_ROOT_ENV) else {
        return Vec::new();
    };
    if value.is_empty() {
        return Vec::new();
    }
    let root = PathBuf::from(value);
    if !root.is_absolute() {
        return Vec::new();
    }
    match embedded_dsh_bundle(&root) {
        Some(bundle) => vec![bundle.root],
        None => Vec::new(),
    }
}

/// Owner-configured packaged DSH runtime, resolved through the full manifest,
/// per-file hash verification, and closed-tree check.
///
/// `override_root` is the raw `ROVAI_EMBEDDED_DSH_ROOT` value, passed in so the
/// decision is testable without process environment state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplicitEmbeddedDsh {
    /// No explicit root: discovery keeps its existing source priority.
    Unset,
    /// Fully verified bundle. `launcher` is the manifest launcher.
    Verified(EmbeddedDshBundle),
    /// The root was configured but did not verify. Discovery must refuse instead
    /// of silently selecting an unverified command; the string is the reason.
    Refused(String),
}

/// Resolve an explicit owner-configured bundle without ever trusting path
/// spelling alone: containment, manifest pinning, every file hash, the closed
/// file list, and the tree digest must all pass.
pub fn explicit_embedded_dsh(override_root: Option<&std::ffi::OsStr>) -> ExplicitEmbeddedDsh {
    let Some(value) = override_root else {
        return ExplicitEmbeddedDsh::Unset;
    };
    if value.is_empty() {
        return ExplicitEmbeddedDsh::Unset;
    }
    let root = PathBuf::from(value);
    if !root.is_absolute() {
        return ExplicitEmbeddedDsh::Refused(format!(
            "embedded DSH override root must be an absolute path: {}",
            root.display()
        ));
    }
    if let Some(bundle) = embedded_dsh_bundle(&root) {
        return ExplicitEmbeddedDsh::Verified(bundle);
    }
    // The lookup failed. Re-run verification only to obtain the concrete
    // refusal reason (missing root, pinning, hash, containment, or tree shape).
    match verify_embedded_dsh(&root) {
        Ok(bundle) => ExplicitEmbeddedDsh::Verified(bundle),
        Err(error) => ExplicitEmbeddedDsh::Refused(format!("{error:#}")),
    }
}

fn read_manifest(path: &Path) -> Result<Value> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("embedded DSH manifest is missing: {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("embedded DSH manifest must be a regular file");
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        bail!("embedded DSH manifest is too large");
    }
    let bytes = fs::read(path)
        .with_context(|| format!("embedded DSH manifest is unreadable: {}", path.display()))?;
    let manifest: Value = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "embedded DSH manifest is not valid JSON: {}",
            path.display()
        )
    })?;
    for key in MANIFEST_KEYS {
        if manifest.get(key).is_none() {
            bail!("embedded DSH manifest omitted {key}");
        }
    }
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(EMBEDDED_DSH_SCHEMA) {
        bail!("embedded DSH manifest has an unsupported schema");
    }
    Ok(manifest)
}

fn required_str<'a>(manifest: &'a Value, key: &str) -> Result<&'a str> {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("embedded DSH manifest field {key} is not a string"))
}

/// Split a portable manifest path into validated components. Rejects absolute
/// paths, drive or stream prefixes, parent traversal, and Windows separators.
fn portable_components(portable: &str) -> Result<Vec<&str>> {
    if portable.is_empty() {
        bail!("embedded DSH manifest has an empty path");
    }
    if portable.contains('\\') {
        bail!("embedded DSH manifest path must use forward slashes: {portable}");
    }
    if portable.starts_with('/') {
        bail!("embedded DSH manifest path must be relative: {portable}");
    }
    let mut components = Vec::new();
    for part in portable.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            bail!("embedded DSH manifest path has an unsafe segment: {portable}");
        }
        if part.contains(':') {
            bail!("embedded DSH manifest path has a drive or stream prefix: {portable}");
        }
        components.push(part);
    }
    Ok(components)
}

/// Resolve one manifest path inside `root`, refusing symbolic links and any
/// canonical target that escapes the bundle root.
fn admit_file(root: &Path, portable: &str) -> Result<PathBuf> {
    let components = portable_components(portable)?;
    let mut candidate = root.to_path_buf();
    for component in components {
        candidate.push(component);
    }
    let metadata = fs::symlink_metadata(&candidate)
        .with_context(|| format!("embedded DSH manifest path is missing: {portable}"))?;
    if metadata.file_type().is_symlink() {
        bail!("embedded DSH bundle must not contain symbolic links: {portable}");
    }
    if !metadata.is_file() {
        bail!("embedded DSH manifest path is not a file: {portable}");
    }
    let canonical = candidate
        .canonicalize()
        .with_context(|| format!("embedded DSH manifest path is unresolvable: {portable}"))?;
    if !canonical.starts_with(root) {
        bail!("embedded DSH manifest path escapes the bundle root: {portable}");
    }
    Ok(canonical)
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_undocumented(
    root: &Path,
    prefix: &str,
    recorded: &HashMap<String, (u64, String)>,
    undocumented: &mut Vec<String>,
) -> Result<()> {
    let directory = if prefix.is_empty() {
        root.to_path_buf()
    } else {
        let mut path = root.to_path_buf();
        for component in prefix.split('/') {
            path.push(component);
        }
        path
    };
    for entry in fs::read_dir(&directory)
        .with_context(|| format!("failed to read {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let portable = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            bail!("embedded DSH bundle must not contain symbolic links: {portable}");
        }
        if file_type.is_dir() {
            collect_undocumented(root, &portable, recorded, undocumented)?;
            continue;
        }
        if !recorded.contains_key(&portable) {
            undocumented.push(portable);
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn write_verified_test_bundle(root: &Path) -> PathBuf {
    fn write(root: &Path, portable: &str, contents: &[u8]) -> PathBuf {
        let mut path = root.to_path_buf();
        for part in portable.split('/') {
            path.push(part);
        }
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
    let launcher_name = host_launcher();
    let node_name = host_node();
    let launcher = write(root, launcher_name, b"#!/bin/sh\nexec node\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
    }
    write(root, node_name, b"standalone-node");
    write(root, EMBEDDED_DSH_ENTRY, b"// pinned dsh cli\n");
    write(root, "THIRD_PARTY_NOTICES.md", b"# notices\n");

    let mut files = Vec::new();
    let mut ledger: Vec<(String, u64, String)> = Vec::new();
    for portable in [
        launcher_name,
        node_name,
        EMBEDDED_DSH_ENTRY,
        "THIRD_PARTY_NOTICES.md",
    ] {
        let mut path = root.to_path_buf();
        for part in portable.split('/') {
            path.push(part);
        }
        let bytes = fs::metadata(&path).unwrap().len();
        let digest = file_sha256(&path).unwrap();
        ledger.push((portable.to_string(), bytes, digest.clone()));
        files.push(serde_json::json!({
            "path": portable,
            "bytes": bytes,
            "sha256": digest,
        }));
    }
    ledger.sort_by(|left, right| left.0.cmp(&right.0));
    let mut tree = Sha256::new();
    for (portable, bytes, digest) in &ledger {
        tree.update(format!("{portable}\t{bytes}\t{digest}\n").as_bytes());
    }
    let manifest = serde_json::json!({
        "schemaVersion": EMBEDDED_DSH_SCHEMA,
        "kind": EMBEDDED_DSH_KIND,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "nodeVersion": "v22.19.0",
        "rootVersion": EMBEDDED_DSH_VERSION,
        "closureComplete": true,
        "installScripts": false,
        "launcher": launcher_name,
        "node": node_name,
        "entry": EMBEDDED_DSH_ENTRY,
        "files": files,
        "treeSha256": format!("{:x}", tree.finalize()),
    });
    fs::write(
        root.join(EMBEDDED_DSH_MANIFEST_FILE),
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
    .unwrap();
    launcher.canonicalize().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("rovai-embedded-dsh-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn path(&self, portable: &str) -> PathBuf {
            let mut path = self.root.clone();
            for component in portable.split('/') {
                path.push(component);
            }
            path
        }

        fn write(&self, portable: &str, contents: &[u8]) {
            let path = self.path(portable);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
        }

        /// Build a bundle whose manifest matches its files. Returns the manifest.
        fn build(&self) -> Value {
            write_verified_test_bundle(&self.root);
            serde_json::from_slice(
                &std::fs::read(self.root.join(EMBEDDED_DSH_MANIFEST_FILE)).unwrap(),
            )
            .unwrap()
        }

        fn write_manifest(&self, manifest: &Value) {
            self.write(
                EMBEDDED_DSH_MANIFEST_FILE,
                format!("{}\n", serde_json::to_string_pretty(manifest).unwrap()).as_bytes(),
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn complete_bundle_verifies_with_manifest_relative_paths() {
        let fixture = Fixture::new();
        fixture.build();
        let bundle = verify_embedded_dsh(&fixture.root).unwrap();
        assert_eq!(bundle.root_version, EMBEDDED_DSH_VERSION);
        assert_eq!(bundle.root_version, crate::dsh::MINIMUM_VERSION);
        assert!(crate::dsh::supported_version(Some(&bundle.root_version)));
        assert!(bundle.launcher.ends_with(host_launcher()));
        assert!(bundle.node.ends_with(host_node()));
        assert!(bundle.entry.ends_with("bin.js"));
        assert!(bundle.launcher.is_absolute());
        assert_eq!(bundle.tree_sha256.len(), 64);
    }

    #[test]
    fn manifest_pinning_platform_and_install_policy_are_enforced() {
        let fixture = Fixture::new();
        let base = fixture.build();
        let foreign_platform = if std::env::consts::OS == "windows" {
            "linux"
        } else {
            "windows"
        };
        let cases = [
            ("schemaVersion", serde_json::json!(2)),
            ("kind", serde_json::json!("loom-pi-runtime")),
            ("rootVersion", serde_json::json!("0.1.5-rc.2")),
            ("platform", serde_json::json!(foreign_platform)),
            ("arch", serde_json::json!("sparc64")),
            ("nodeVersion", serde_json::json!("")),
            ("closureComplete", serde_json::json!(false)),
            ("installScripts", serde_json::json!(true)),
            ("launcher", serde_json::json!("dsh.exe")),
            ("node", serde_json::json!("node/other")),
            (
                "entry",
                serde_json::json!("node_modules/@deepseek-ai/dsh/lib/other.js"),
            ),
        ];
        for (key, value) in cases {
            let mut manifest = base.clone();
            manifest[key] = value;
            fixture.write_manifest(&manifest);
            assert!(
                verify_embedded_dsh(&fixture.root).is_err(),
                "expected rejection for {key}"
            );
        }

        let mut missing = base.clone();
        missing.as_object_mut().unwrap().remove("installScripts");
        fixture.write_manifest(&missing);
        assert!(verify_embedded_dsh(&fixture.root).is_err());
    }

    #[test]
    fn every_file_hash_and_size_is_verified_not_only_the_manifest() {
        let fixture = Fixture::new();
        fixture.build();
        verify_embedded_dsh(&fixture.root).unwrap();

        fixture.write("node/node", b"tampered-node");
        assert!(verify_embedded_dsh(&fixture.root).is_err());

        fixture.build();
        fixture.write(EMBEDDED_DSH_ENTRY, b"// tampered dsh cli\n");
        assert!(verify_embedded_dsh(&fixture.root).is_err());

        fixture.build();
        std::fs::remove_file(fixture.path("THIRD_PARTY_NOTICES.md")).unwrap();
        assert!(verify_embedded_dsh(&fixture.root).is_err());
    }

    #[test]
    fn tree_digest_must_match_the_manifest_ledger() {
        let fixture = Fixture::new();
        let mut manifest = fixture.build();
        manifest["treeSha256"] = serde_json::json!("0".repeat(64));
        fixture.write_manifest(&manifest);
        assert!(verify_embedded_dsh(&fixture.root).is_err());
    }

    #[test]
    fn unsafe_and_parent_manifest_paths_are_rejected() {
        let fixture = Fixture::new();
        let base = fixture.build();
        for portable in [
            "/etc/passwd",
            "../outside",
            "node/../../escape",
            "C:/windows",
            "node\\node",
        ] {
            let mut manifest = base.clone();
            manifest["files"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "path": portable,
                    "bytes": 1,
                    "sha256": "0".repeat(64),
                }));
            fixture.write_manifest(&manifest);
            assert!(
                verify_embedded_dsh(&fixture.root).is_err(),
                "expected rejection for {portable}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escapes_are_rejected() {
        let fixture = Fixture::new();
        fixture.build();
        let outside = std::env::temp_dir().join(format!(
            "rovai-embedded-dsh-outside-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&outside, b"outside").unwrap();
        let link = fixture.path("node/escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let error = verify_embedded_dsh(&fixture.root).unwrap_err();
        assert!(error.to_string().contains("symbolic link"));
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn undocumented_files_and_unrecorded_code_are_rejected() {
        let fixture = Fixture::new();
        fixture.build();
        fixture.write("notes.txt", b"inert\n");
        assert!(verify_embedded_dsh(&fixture.root).is_err());

        let fixture = Fixture::new();
        fixture.build();
        fixture.write("smuggled.js", b"// not in manifest\n");
        let error = verify_embedded_dsh(&fixture.root).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("undocumented executable or code file")
        );

        let fixture = Fixture::new();
        let mut manifest = fixture.build();
        manifest["closureComplete"] = serde_json::json!(false);
        fixture.write_manifest(&manifest);
        assert!(verify_embedded_dsh(&fixture.root).is_err());
    }

    #[test]
    fn missing_bundle_is_not_a_launcher_or_search_directory() {
        let fixture = Fixture::new();
        assert!(embedded_dsh_bundle(&fixture.root).is_none());
        assert!(embedded_dsh_launcher(&fixture.root).is_none());
        std::fs::remove_dir_all(&fixture.root).ok();
        assert!(verify_embedded_dsh(&fixture.root).is_err());
    }

    #[test]
    fn explicit_override_is_unset_verified_or_refused_never_silently_ignored() {
        let root = std::env::temp_dir().join(format!(
            "rovai-embedded-dsh-explicit-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();

        assert_eq!(explicit_embedded_dsh(None), ExplicitEmbeddedDsh::Unset);
        assert_eq!(
            explicit_embedded_dsh(Some(std::ffi::OsStr::new(""))),
            ExplicitEmbeddedDsh::Unset
        );
        // A relative root is refused, never resolved against the process cwd.
        assert!(matches!(
            explicit_embedded_dsh(Some(std::ffi::OsStr::new("resources/runtime/dsh"))),
            ExplicitEmbeddedDsh::Refused(_)
        ));
        // A configured but missing root is refused with a reason.
        let missing = root.join("absent");
        assert!(matches!(
            explicit_embedded_dsh(Some(missing.as_os_str())),
            ExplicitEmbeddedDsh::Refused(_)
        ));

        let bundle_root = root.join("bundle");
        fs::create_dir_all(&bundle_root).unwrap();
        let launcher = write_verified_test_bundle(&bundle_root);
        match explicit_embedded_dsh(Some(bundle_root.as_os_str())) {
            ExplicitEmbeddedDsh::Verified(bundle) => {
                assert_eq!(bundle.launcher, launcher);
                assert_eq!(bundle.root_version, EMBEDDED_DSH_VERSION);
            }
            other => panic!("expected a verified explicit bundle, got {other:?}"),
        }

        // A payload changed after verification must refuse, not pass silently.
        fs::write(bundle_root.join("node").join("node"), b"tampered-node").unwrap();
        assert!(matches!(
            explicit_embedded_dsh(Some(bundle_root.as_os_str())),
            ExplicitEmbeddedDsh::Refused(_)
        ));

        fs::remove_dir_all(&root).unwrap();
    }
}
