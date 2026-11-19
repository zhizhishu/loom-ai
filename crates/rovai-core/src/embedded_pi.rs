//! Frozen embedded Pi runtime bundle.
//!
//! The packaged tree (`resources/runtime/pi`) is produced by
//! `scripts/package-embedded-pi.mjs`: a standalone Node runtime, the pinned
//! `@earendil-works/pi-coding-agent` entry with its dependency closure, a
//! portable launcher, third-party notices, and `pi-bundle.json`.
//!
//! This module only *reads* that tree. It verifies the manifest, every admitted
//! file hash, and the tree digest; it never downloads, installs, copies user Pi
//! configuration, or launches a model. Discovery reuses the existing
//! `AdapterKind::Pi`; there is no separate Agent kind for the embedded runtime.
//!
//! Full hashing is an explicit, one-shot validation. Repeated lookups (for
//! example a PATH refresh) reuse a cache keyed by the manifest metadata so a
//! discovery query never re-hashes the whole package.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use anyhow::{bail, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Explicit root of a packaged Pi runtime. `runtime_discovery` resolves it as an
/// explicit package selection: a verified bundle leads the Pi candidate list, so
/// a saved PATH-derived entry or a login-shell npm shim cannot displace it,
/// while native Pi stays available as a later candidate.
pub const EMBEDDED_PI_ROOT_ENV: &str = "ROVAI_EMBEDDED_PI_ROOT";
/// The only Pi version this crate admits for the embedded runtime.
pub const EMBEDDED_PI_VERSION: &str = "0.85.1";
pub const EMBEDDED_PI_MANIFEST_FILE: &str = "pi-bundle.json";
pub const EMBEDDED_PI_SCHEMA: u64 = 1;

const MANIFEST_KEYS: [&str; 12] = [
    "schema",
    "piVersion",
    "platform",
    "arch",
    "nodeVersion",
    "closureComplete",
    "launchKind",
    "launcher",
    "node",
    "entry",
    "files",
    "treeSha256",
];

const CODE_EXTENSIONS: [&str; 15] = [
    "js", "mjs", "cjs", "ts", "mts", "cts", "node", "exe", "dll", "cmd", "bat", "ps1", "sh", "so",
    "wasm",
];

/// A verified embedded Pi bundle. Every path is absolute, canonical, and
/// contained in `root`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedPiBundle {
    pub root: PathBuf,
    pub launcher: PathBuf,
    pub node: PathBuf,
    pub entry: PathBuf,
    pub pi_version: String,
    pub tree_sha256: String,
}

#[derive(Clone)]
struct CachedBundle {
    manifest_len: u64,
    manifest_modified_nanos: u128,
    files: Vec<(String, u64, u128)>,
    bundle: EmbeddedPiBundle,
}

struct VerifiedBundle {
    bundle: EmbeddedPiBundle,
    files: Vec<(String, u64, u128)>,
}

fn verified_cache() -> &'static Mutex<HashMap<PathBuf, CachedBundle>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedBundle>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Verify the bundle at `root`. This hashes every admitted file exactly once
/// and must be called explicitly (packaging, acceptance, or a cache miss).
pub fn verify_embedded_pi(root: &Path) -> Result<EmbeddedPiBundle> {
    verify_bundle(root).map(|verified| verified.bundle)
}

fn verify_bundle(root: &Path) -> Result<VerifiedBundle> {
    let root = root
        .canonicalize()
        .with_context(|| format!("embedded Pi root is missing: {}", root.display()))?;
    let manifest_path = root.join(EMBEDDED_PI_MANIFEST_FILE);
    let manifest = read_manifest(&manifest_path)?;
    let manifest_version = required_str(&manifest, "piVersion")?;
    if manifest_version != EMBEDDED_PI_VERSION {
        bail!(
            "embedded Pi manifest is not pinned to {EMBEDDED_PI_VERSION}: {manifest_version}"
        );
    }
    if required_str(&manifest, "platform")? != std::env::consts::OS {
        bail!("embedded Pi bundle targets another platform than {}", std::env::consts::OS);
    }
    if required_str(&manifest, "arch")? != std::env::consts::ARCH {
        bail!("embedded Pi bundle targets another architecture than {}", std::env::consts::ARCH);
    }
    if required_str(&manifest, "nodeVersion")?.trim().is_empty() {
        bail!("embedded Pi manifest omitted the Node runtime version");
    }
    let closure_complete = manifest
        .get("closureComplete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let launcher_relative = required_str(&manifest, "launcher")?;
    let node_relative = required_str(&manifest, "node")?;
    let entry_relative = required_str(&manifest, "entry")?;
    let launch_kind = required_str(&manifest, "launchKind")?;
    let (expected_launcher, accepted_kinds): (&str, &[&str]) = if cfg!(windows) {
        // Windows discovery admits `.exe` entrypoints only, so a command shim can
        // never be the product launcher.
        ("pi.exe", &["native"])
    } else {
        ("pi", &["native", "shell"])
    };
    if !accepted_kinds.contains(&launch_kind) {
        bail!(
            "embedded Pi launcher kind {launch_kind} is not accepted on {}",
            std::env::consts::OS
        );
    }
    if launcher_relative != expected_launcher {
        bail!(
            "embedded Pi launcher must be {expected_launcher} on {}",
            std::env::consts::OS
        );
    }

    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .context("embedded Pi manifest omitted its file list")?;
    if files.is_empty() {
        bail!("embedded Pi manifest has an empty file list");
    }
    let mut recorded: HashMap<String, (u64, String)> = HashMap::new();
    let mut observed: Vec<(String, u64, u128)> = Vec::new();
    for file in files {
        let portable = file
            .get("path")
            .and_then(Value::as_str)
            .context("embedded Pi manifest file has no path")?;
        let bytes = file
            .get("bytes")
            .and_then(Value::as_u64)
            .context("embedded Pi manifest file has no size")?;
        let expected = file
            .get("sha256")
            .and_then(Value::as_str)
            .context("embedded Pi manifest file has no digest")?;
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("embedded Pi manifest has an invalid digest for {portable}");
        }
        let expected = expected.to_ascii_lowercase();
        if recorded.contains_key(portable) {
            bail!("embedded Pi manifest repeats {portable}");
        }
        let absolute = admit_file(&root, portable)?;
        let metadata = fs::metadata(&absolute)
            .with_context(|| format!("embedded Pi file is unreadable: {portable}"))?;
        if metadata.len() != bytes {
            bail!("embedded Pi size mismatch: {portable}");
        }
        let digest = file_sha256(&absolute)?;
        if digest != expected {
            bail!("embedded Pi hash mismatch: {portable}");
        }
        observed.push((portable.to_string(), metadata.len(), file_modified_nanos(&metadata)));
        recorded.insert(portable.to_string(), (bytes, digest));
    }

    for required in [launcher_relative, node_relative, entry_relative] {
        if !recorded.contains_key(required) {
            bail!("embedded Pi manifest does not cover {required} in its file list");
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
        bail!("embedded Pi tree digest does not match its manifest");
    }

    let mut undocumented = Vec::new();
    collect_undocumented(&root, "", &recorded, &mut undocumented)?;
    for portable in undocumented {
        if portable == EMBEDDED_PI_MANIFEST_FILE {
            continue;
        }
        if closure_complete {
            bail!("embedded Pi bundle has a file outside its closed manifest: {portable}");
        }
        let extension = Path::new(&portable)
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if CODE_EXTENSIONS.iter().any(|code| *code == extension.as_str()) {
            bail!("embedded Pi bundle has an undocumented executable or code file: {portable}");
        }
    }

    Ok(VerifiedBundle {
        bundle: EmbeddedPiBundle {
            launcher: admit_file(&root, launcher_relative)?,
            node: admit_file(&root, node_relative)?,
            entry: admit_file(&root, entry_relative)?,
            pi_version: manifest_version.to_string(),
            tree_sha256,
            root,
        },
        files: observed,
    })
}

/// Cached lookup used by discovery. A cache hit hashes nothing; it re-checks the
/// manifest *and* every recorded file's size and modification time, so an altered
/// payload is re-verified (and refused) instead of being reported as verified.
pub fn embedded_pi_bundle(root: &Path) -> Option<EmbeddedPiBundle> {
    let root = root.canonicalize().ok()?;
    let manifest_path = root.join(EMBEDDED_PI_MANIFEST_FILE);
    let metadata = fs::metadata(&manifest_path).ok()?;
    let len = metadata.len();
    let modified = file_modified_nanos(&metadata);
    if let Some(bundle) = cached_lookup(&root, len, modified) {
        return Some(bundle);
    }
    let verified = verify_bundle(&root).ok()?;
    let VerifiedBundle { bundle, files } = verified;
    if let Ok(mut cache) = verified_cache().lock() {
        cache.insert(
            root,
            CachedBundle {
                manifest_len: len,
                manifest_modified_nanos: modified,
                files,
                bundle: bundle.clone(),
            },
        );
    }
    Some(bundle)
}

fn cached_lookup(root: &Path, manifest_len: u64, manifest_modified: u128) -> Option<EmbeddedPiBundle> {
    let cache = verified_cache().lock().ok()?;
    let cached = cache.get(root)?;
    if cached.manifest_len != manifest_len || cached.manifest_modified_nanos != manifest_modified {
        return None;
    }
    for (portable, len, modified) in &cached.files {
        let absolute = admit_file(root, portable).ok()?;
        let metadata = fs::metadata(&absolute).ok()?;
        if metadata.len() != *len || file_modified_nanos(&metadata) != *modified {
            return None;
        }
    }
    Some(cached.bundle.clone())
}

fn file_modified_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

/// Launcher executable of a verified bundle, computed from the trusted manifest.
pub fn embedded_pi_launcher(root: &Path) -> Option<PathBuf> {
    embedded_pi_bundle(root).map(|bundle| bundle.launcher)
}

/// Directories that discovery may append as low-priority candidates. Empty when
/// the override is unset, relative, or fails verification. User Pi state under
/// `HOME` is never read here. `explicit_embedded_pi` is the product entry point:
/// an explicit root leads Pi discovery instead of trailing native `PATH` hits.
pub fn embedded_pi_search_directories() -> Vec<PathBuf> {
    let Some(value) = std::env::var_os(EMBEDDED_PI_ROOT_ENV) else {
        return Vec::new();
    };
    if value.is_empty() {
        return Vec::new();
    }
    let root = PathBuf::from(value);
    if !root.is_absolute() {
        return Vec::new();
    }
    match embedded_pi_bundle(&root) {
        Some(bundle) => vec![bundle.root],
        None => Vec::new(),
    }
}

/// Owner-configured packaged Pi runtime, resolved through the full manifest and
/// per-file hash verification.
///
/// `override_root` is the raw `ROVAI_EMBEDDED_PI_ROOT` value, passed in so the
/// decision is testable without process environment state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplicitEmbeddedPi {
    /// No explicit root: discovery keeps its existing source priority.
    Unset,
    /// Fully verified bundle. `launcher` is the manifest launcher.
    Verified(EmbeddedPiBundle),
    /// The root was configured but did not verify. Discovery must refuse instead
    /// of silently selecting an unverified command; the string is the reason.
    Refused(String),
}

/// Resolve an explicit owner-configured bundle without ever trusting path
/// spelling alone: containment, manifest pinning, every file hash, and the tree
/// digest must all pass.
pub fn explicit_embedded_pi(override_root: Option<&std::ffi::OsStr>) -> ExplicitEmbeddedPi {
    let Some(value) = override_root else {
        return ExplicitEmbeddedPi::Unset;
    };
    if value.is_empty() {
        return ExplicitEmbeddedPi::Unset;
    }
    let root = PathBuf::from(value);
    if !root.is_absolute() {
        return ExplicitEmbeddedPi::Refused(format!(
            "embedded Pi override root must be an absolute path: {}",
            root.display()
        ));
    }
    if let Some(bundle) = embedded_pi_bundle(&root) {
        return ExplicitEmbeddedPi::Verified(bundle);
    }
    // The cached lookup failed. Re-run explicit verification only to obtain the
    // concrete refusal reason (missing root, pinning, hash, or containment).
    match verify_embedded_pi(&root) {
        Ok(bundle) => ExplicitEmbeddedPi::Verified(bundle),
        Err(error) => ExplicitEmbeddedPi::Refused(format!("{error:#}")),
    }
}

fn read_manifest(path: &Path) -> Result<Value> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("embedded Pi manifest is missing: {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("embedded Pi manifest must be a regular file");
    }
    let bytes = fs::read(path)
        .with_context(|| format!("embedded Pi manifest is unreadable: {}", path.display()))?;
    let manifest: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("embedded Pi manifest is not valid JSON: {}", path.display()))?;
    for key in MANIFEST_KEYS {
        if manifest.get(key).is_none() {
            bail!("embedded Pi manifest omitted {key}");
        }
    }
    if manifest.get("schema").and_then(Value::as_u64) != Some(EMBEDDED_PI_SCHEMA) {
        bail!("embedded Pi manifest has an unsupported schema");
    }
    Ok(manifest)
}

fn required_str<'a>(manifest: &'a Value, key: &str) -> Result<&'a str> {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("embedded Pi manifest field {key} is not a string"))
}

/// Split a portable manifest path into validated components. Rejects absolute
/// paths, drive or stream prefixes, parent traversal, and Windows separators.
fn portable_components(portable: &str) -> Result<Vec<&str>> {
    if portable.is_empty() {
        bail!("embedded Pi manifest has an empty path");
    }
    if portable.contains('\\') {
        bail!("embedded Pi manifest path must use forward slashes: {portable}");
    }
    if portable.starts_with('/') {
        bail!("embedded Pi manifest path must be relative: {portable}");
    }
    let mut components = Vec::new();
    for part in portable.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            bail!("embedded Pi manifest path has an unsafe segment: {portable}");
        }
        if part.contains(':') {
            bail!("embedded Pi manifest path has a drive or stream prefix: {portable}");
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
        .with_context(|| format!("embedded Pi manifest path is missing: {portable}"))?;
    if metadata.file_type().is_symlink() {
        bail!("embedded Pi bundle must not contain symbolic links: {portable}");
    }
    if !metadata.is_file() {
        bail!("embedded Pi manifest path is not a file: {portable}");
    }
    let canonical = candidate
        .canonicalize()
        .with_context(|| format!("embedded Pi manifest path is unresolvable: {portable}"))?;
    if !canonical.starts_with(root) {
        bail!("embedded Pi manifest path escapes the bundle root: {portable}");
    }
    Ok(canonical)
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
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
            bail!("embedded Pi bundle must not contain symbolic links: {portable}");
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
    let launcher_name = if cfg!(windows) { "pi.exe" } else { "pi" };
    let entry = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
    let launcher = write(root, launcher_name, b"#!/bin/sh\nexit 0\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
    }
    write(root, "node/node", b"standalone-node");
    write(root, entry, b"// pinned cli\n");
    write(root, "THIRD_PARTY_NOTICES.md", b"# notices\n");

    let mut files = Vec::new();
    let mut ledger: Vec<(String, u64, String)> = Vec::new();
    for portable in [launcher_name, "node/node", entry, "THIRD_PARTY_NOTICES.md"] {
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
        "schema": EMBEDDED_PI_SCHEMA,
        "piVersion": EMBEDDED_PI_VERSION,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "nodeVersion": "v22.19.0",
        "closureComplete": true,
        "launchKind": "native",
        "launcher": launcher_name,
        "node": "node/node",
        "entry": entry,
        "optionalMissing": [],
        "files": files,
        "treeSha256": format!("{:x}", tree.finalize()),
    });
    fs::write(
        root.join(EMBEDDED_PI_MANIFEST_FILE),
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
            let root = std::env::temp_dir().join(format!(
                "rovai-embedded-pi-{}",
                uuid::Uuid::new_v4()
            ));
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
            let launcher = if cfg!(windows) { "pi.exe" } else { "pi" };
            self.write("node/node", b"standalone-node");
            self.write(launcher, b"#!/bin/sh\nexec node\n");
            self.write(
                "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
                b"// pinned cli\n",
            );
            self.write("THIRD_PARTY_NOTICES.md", b"# notices\n");
            let mut files = Vec::new();
            let mut ledger: Vec<(String, u64, String)> = Vec::new();
            for portable in [
                "node/node",
                launcher,
                "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
                "THIRD_PARTY_NOTICES.md",
            ] {
                let absolute = self.path(portable);
                let bytes = std::fs::metadata(&absolute).unwrap().len();
                let digest = file_sha256(&absolute).unwrap();
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
                "schema": EMBEDDED_PI_SCHEMA,
                "piVersion": EMBEDDED_PI_VERSION,
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "nodeVersion": "v22.19.0",
                "closureComplete": true,
                "launchKind": "native",
                "launcher": launcher,
                "node": "node/node",
                "entry": "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
                "optionalMissing": [],
                "files": files,
                "treeSha256": format!("{:x}", tree.finalize()),
            });
            self.write_manifest(&manifest);
            manifest
        }

        fn write_manifest(&self, manifest: &Value) {
            self.write(
                EMBEDDED_PI_MANIFEST_FILE,
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
        let bundle = verify_embedded_pi(&fixture.root).unwrap();
        assert_eq!(bundle.pi_version, EMBEDDED_PI_VERSION);
        assert!(bundle.launcher.ends_with(if cfg!(windows) { "pi.exe" } else { "pi" }));
        assert!(bundle.node.ends_with("node"));
        assert!(bundle.entry.ends_with("cli.js"));
        assert!(bundle.launcher.is_absolute());
        assert!(bundle.tree_sha256.len() == 64);
    }

    #[test]
    fn unpinned_or_foreign_manifests_are_rejected() {
        let fixture = Fixture::new();
        let mut manifest = fixture.build();
        manifest["piVersion"] = serde_json::json!("0.84.4");
        fixture.write_manifest(&manifest);
        assert!(verify_embedded_pi(&fixture.root).is_err());

        let mut manifest = fixture.build();
        manifest["arch"] = serde_json::json!("sparc64");
        fixture.write_manifest(&manifest);
        assert!(verify_embedded_pi(&fixture.root).is_err());

        let mut manifest = fixture.build();
        manifest.as_object_mut().unwrap().remove("nodeVersion");
        fixture.write_manifest(&manifest);
        assert!(verify_embedded_pi(&fixture.root).is_err());
    }

    #[test]
    fn absolute_and_parent_manifest_paths_are_rejected() {
        for portable in ["/etc/passwd", "../outside", "node/../../escape", "C:/windows"] {
            let fixture = Fixture::new();
            let mut manifest = fixture.build();
            manifest["entry"] = serde_json::json!(portable);
            fixture.write_manifest(&manifest);
            assert!(
                verify_embedded_pi(&fixture.root).is_err(),
                "expected rejection for {portable}"
            );
        }
    }

    #[test]
    fn every_file_hash_is_verified_not_only_the_manifest() {
        let fixture = Fixture::new();
        fixture.build();
        verify_embedded_pi(&fixture.root).unwrap();
        fixture.write("node/node", b"tampered-node");
        let error = verify_embedded_pi(&fixture.root).unwrap_err();
        assert!(error.to_string().contains("hash mismatch") || error.to_string().contains("size mismatch"));
    }

    #[test]
    fn undocumented_code_is_rejected_while_inert_extra_files_are_tolerated() {
        let fixture = Fixture::new();
        let manifest = fixture.build();
        fixture.write("notes.txt", b"inert\n");
        // The manifest declares a closed file list, so even inert extras fail.
        assert!(verify_embedded_pi(&fixture.root).is_err());

        let mut open = manifest.clone();
        open["closureComplete"] = serde_json::json!(false);
        fixture.write_manifest(&open);
        assert!(verify_embedded_pi(&fixture.root).is_ok());

        fixture.write("smuggled.js", b"// not in manifest\n");
        assert!(verify_embedded_pi(&fixture.root).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escapes_are_rejected() {
        let fixture = Fixture::new();
        fixture.build();
        let outside = std::env::temp_dir().join(format!(
            "rovai-embedded-pi-outside-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&outside, b"outside").unwrap();
        let link = fixture.path("node/escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let error = verify_embedded_pi(&fixture.root).unwrap_err();
        assert!(error.to_string().contains("symbolic link"));
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn cached_lookup_revalidates_when_a_payload_file_changes() {
        let fixture = Fixture::new();
        fixture.build();
        assert!(embedded_pi_bundle(&fixture.root).is_some());
        // Same manifest, changed payload: the recorded per-file metadata no longer
        // matches, so the cache must not report a verified bundle.
        fixture.write("node/node", b"changed-after-verification");
        assert!(embedded_pi_bundle(&fixture.root).is_none());
        // Restoring the exact bytes restores a verified bundle.
        fixture.write("node/node", b"standalone-node");
        assert!(embedded_pi_bundle(&fixture.root).is_some());
    }

    #[test]
    fn explicit_verification_rehashes_after_a_cache_hit() {
        let fixture = Fixture::new();
        fixture.build();
        assert!(embedded_pi_bundle(&fixture.root).is_some());
        fixture.write(
            "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            b"// tampered cli\n",
        );
        assert!(
            verify_embedded_pi(&fixture.root).is_err(),
            "explicit verification must not trust the cache"
        );
    }

    #[test]
    fn launcher_kind_and_name_must_match_the_platform() {
        let fixture = Fixture::new();
        let manifest = fixture.build();
        let mut shim = manifest.clone();
        shim["launchKind"] = serde_json::json!("npm-shim");
        fixture.write_manifest(&shim);
        assert!(verify_embedded_pi(&fixture.root).is_err());

        let mut unknown = manifest.clone();
        unknown["launchKind"] = serde_json::json!("whatever");
        fixture.write_manifest(&unknown);
        assert!(verify_embedded_pi(&fixture.root).is_err());

        let mut misplaced = manifest.clone();
        misplaced["launcher"] = serde_json::json!("pi.cmd");
        fixture.write_manifest(&misplaced);
        assert!(verify_embedded_pi(&fixture.root).is_err());
    }

    #[test]
    fn missing_bundle_is_not_a_search_directory() {
        let fixture = Fixture::new();
        assert!(embedded_pi_bundle(&fixture.root).is_none());
        assert!(embedded_pi_launcher(&fixture.root).is_none());
        fixture.build();
        assert!(embedded_pi_launcher(&fixture.root).is_some());
    }

    #[test]
    fn explicit_override_is_unset_verified_or_refused_never_silently_ignored() {
        let root = std::env::temp_dir().join(format!(
            "rovai-embedded-pi-explicit-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();

        assert_eq!(explicit_embedded_pi(None), ExplicitEmbeddedPi::Unset);
        assert_eq!(
            explicit_embedded_pi(Some(std::ffi::OsStr::new(""))),
            ExplicitEmbeddedPi::Unset
        );
        // A relative root is refused, never resolved against the process cwd.
        assert!(matches!(
            explicit_embedded_pi(Some(std::ffi::OsStr::new("resources/runtime/pi"))),
            ExplicitEmbeddedPi::Refused(_)
        ));
        // A configured but missing root is refused with a reason.
        let missing = root.join("absent");
        assert!(matches!(
            explicit_embedded_pi(Some(missing.as_os_str())),
            ExplicitEmbeddedPi::Refused(_)
        ));

        let launcher = write_verified_test_bundle(&root);
        match explicit_embedded_pi(Some(root.as_os_str())) {
            ExplicitEmbeddedPi::Verified(bundle) => {
                assert_eq!(bundle.launcher, launcher);
                assert_eq!(bundle.pi_version, EMBEDDED_PI_VERSION);
            }
            other => panic!("expected a verified explicit bundle, got {other:?}"),
        }

        // A payload changed after verification must refuse, not pass silently.
        fs::write(root.join("node").join("node"), b"tampered-node").unwrap();
        assert!(matches!(
            explicit_embedded_pi(Some(root.as_os_str())),
            ExplicitEmbeddedPi::Refused(_)
        ));

        fs::remove_dir_all(&root).unwrap();
    }
}
