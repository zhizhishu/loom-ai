//! One immutable per-Run capability bundle.
//!
//! A sends this object once, next to `Start`, and the node writes the files
//! into that Run's private directory. The object never carries native command
//! line flags: each file names a typed artifact and the node derives the
//! native flag from it, so a caller cannot escape the contract with an
//! arbitrary path or an arbitrary flag.
//!
//! This module is pure: no filesystem, database or environment access. The
//! node can therefore refuse a bundle before it creates any directory.
//!
//! Digest: SHA-256 over the deterministic serialization of this struct with
//! `digest` blanked. Field order is fixed at the declaration below and the
//! value contains no maps, so the bytes cannot reorder; every field, including
//! identity, selection revision and the actual file content, participates.
//!
//! This file expects `base64` and `sha2` in `loom-protocol/Cargo.toml`. The
//! supervisor adds them together with `mod run_bundle;`.

use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Wire version. A node refuses anything else instead of guessing.
pub const RUN_BUNDLE_VERSION: u32 = 1;

/// Wire version used *only* by a bundle that carries credential references.
/// A bundle without a reference keeps [`RUN_BUNDLE_VERSION`] and its exact old
/// bytes; nothing else may claim this version, and a v2 bundle without a
/// reference is refused instead of being read as a newer shape.
pub const RUN_BUNDLE_REFERENCE_VERSION: u32 = 2;

/// One reference name: `[A-Z][A-Z0-9_]{0,63}`.
pub const MAX_MCP_REFERENCE_NAME_BYTES: usize = 64;
/// Upper bound for one bundle, so no frame can ask for unbounded mapping work.
pub const MAX_MCP_REFERENCES: usize = 256;

/// Names a bundle may never reference: process configuration, loader settings
/// and the product's own prefixes. A general API key name is deliberately
/// absent, because the receiver maps references explicitly and this module
/// never chooses a source value.
const RESERVED_MCP_REFERENCE_NAMES: [&str; 38] = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "ALLUSERSPROFILE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONSTARTUP",
    "PYTHONUSERBASE",
    "PYTHONNOUSERSITE",
    "LANG",
    "LC_ALL",
    "TZ",
    "SHELL",
    "IFS",
    "CDPATH",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
];
const RESERVED_MCP_REFERENCE_PREFIXES: [&str; 6] =
    ["ROVAI_", "CODEX_", "CLAUDE_", "DSH_", "LD_", "DYLD_"];

/// Strict ASCII uppercase `[A-Z][A-Z0-9_]{0,63}`, minus the reserved names and
/// prefixes. Never a credential value and never an interpolation.
pub fn valid_mcp_reference_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_MCP_REFERENCE_NAME_BYTES {
        return false;
    }
    if !bytes[0].is_ascii_uppercase() {
        return false;
    }
    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
    {
        return false;
    }
    if RESERVED_MCP_REFERENCE_NAMES.contains(&name) {
        return false;
    }
    !RESERVED_MCP_REFERENCE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

pub const MAX_BUNDLE_FILES: usize = 128;
/// Limit for one decoded file.
pub const MAX_BUNDLE_FILE_BYTES: usize = 256 * 1024;
/// Limit for every decoded file together.
pub const MAX_BUNDLE_DECODED_BYTES: usize = 768 * 1024;
/// Limit for the serialized object, so the existing 2 MiB transport frame keeps
/// margin for the rest of the frame.
pub const MAX_BUNDLE_ENCODED_BYTES: usize = 1536 * 1024;
pub const MAX_BUNDLE_PATH_BYTES: usize = 200;
pub const MAX_PATH_SEGMENT_BYTES: usize = 100;
pub const MAX_BUNDLE_RUN_ID_BYTES: usize = 128;
pub const MAX_BUNDLE_BUNDLE_ID_BYTES: usize = 200;
pub const MAX_BUNDLE_AGENT_ID_BYTES: usize = 80;
pub const MAX_BUNDLE_SELECTION_REVISION_BYTES: usize = 200;
pub const MAX_BUNDLE_SOURCE_ROOT_BYTES: usize = 1024;

/// Canonical adapter strings. `claude-code-cli` is the established in-tree
/// spelling of the same runtime; it is accepted on input and never emitted.
pub const ADAPTER_CODEX_CLI: &str = "codex-cli";
pub const ADAPTER_CLAUDE_CODE: &str = "claude-code";

/// Fixed labels of the single-artifact files.
pub const LABEL_BOOTSTRAP: &str = "bootstrap";
pub const LABEL_MCP: &str = "mcp";
pub const LABEL_SETTINGS: &str = "settings";

/// Windows device names that may not be used as a file stem.
const WINDOWS_RESERVED_STEMS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn canonical_adapter_kind(value: &str) -> Option<&'static str> {
    if value == ADAPTER_CODEX_CLI {
        return Some(ADAPTER_CODEX_CLI);
    }
    if value == ADAPTER_CLAUDE_CODE || value == "claude-code-cli" {
        return Some(ADAPTER_CLAUDE_CODE);
    }
    None
}

/// The bundle identity is derived from the attempt, never a fresh UUID, so the
/// same attempt cannot be presented as a second bundle.
pub fn bundle_id_for(run_id: &str, attempt: u32) -> String {
    format!("{run_id}-{attempt}")
}

/// What one file is for. The node maps each artifact to its native flag; the
/// artifact is never chosen to mean "some other path".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BundleArtifact {
    /// `bootstrap.txt`, the frozen additive instructions.
    BootstrapPrompt,
    /// `mcp.json`, the runtime-native MCP document.
    McpConfig,
    /// `settings.json`, native hook settings.
    RuntimeSettings,
    /// `skills/<skill-name>/<safe-relative-file>`.
    SkillFile,
}

impl BundleArtifact {
    /// Rank used by the single canonical file order.
    pub fn rank(self) -> u8 {
        match self {
            Self::BootstrapPrompt => 0,
            Self::McpConfig => 1,
            Self::RuntimeSettings => 2,
            Self::SkillFile => 3,
        }
    }

    /// Artifacts that may appear at most once.
    pub fn is_singleton(self) -> bool {
        !matches!(self, Self::SkillFile)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleFile {
    pub artifact: BundleArtifact,
    /// Stable per-artifact label: a fixed name, or `<skill>/<relative-file>`.
    pub label: String,
    /// Bundle-relative path; must equal [`canonical_path`] for this artifact.
    pub path: String,
    /// Declared decoded size, compared with the decoded content.
    pub bytes: usize,
    /// Base64 of the file content.
    pub content: String,
}

/// The whole per-Run bundle. Field order participates in the digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunBundleV1 {
    pub version: u32,
    pub bundle_id: String,
    pub run_id: String,
    pub attempt: u32,
    pub agent_id: String,
    pub adapter_kind: String,
    /// The selection snapshot this bundle froze, so a later save can only
    /// reach the next Run.
    pub selection_revision: String,
    /// The root value A's renderer already froze inside the section JSON. It is
    /// an A-side path, not a guess at a node path: the node relocates the two
    /// known root values itself with a deterministic transform.
    pub source_skill_root: Option<String>,
    pub digest: String,
    pub files: Vec<BundleFile>,
}

/// One credential the bundle refers to by name. The value stays in the
/// receiver's own private environment; the wire never carries it. The
/// `config_digest` is the receiver's mapping key: sha256 over exactly the
/// native server value this reference came from.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpEnvironmentReference {
    pub server_name: String,
    pub variable: String,
    pub config_digest: String,
}

/// Every environment reference the frozen native MCP document carries, sorted
/// by server then variable and de-duplicated. An empty server map, or no MCP
/// file at all, returns an empty list: that is what keeps a v1 bundle's bytes
/// unchanged. A document that does not carry the native server map is refused
/// instead of being read as "no references".
///
/// The two native dialects differ: Codex names the variable directly
/// (`env_vars`, `env_http_headers`), Claude Code keeps the `${NAME}` whole-value
/// placeholder for the node to expand in its own private file. Only a whole
/// value counts as a reference; a value with any other text, or a partial
/// interpolation, is refused rather than silently read as a literal.
pub fn mcp_environment_references(
    bundle: &RunBundleV1,
) -> Result<Vec<McpEnvironmentReference>, BundleReject> {
    let Some(file) = bundle
        .files
        .iter()
        .find(|file| file.artifact == BundleArtifact::McpConfig)
    else {
        return Ok(Vec::new());
    };
    let document: serde_json::Value =
        serde_json::from_slice(&decode_file(file)?).map_err(|_| BundleReject::Content)?;
    let codex = match canonical_adapter_kind(&bundle.adapter_kind) {
        Some(ADAPTER_CODEX_CLI) => true,
        Some(_) => false,
        None => return Err(BundleReject::Adapter),
    };
    let strict = bundle.version == RUN_BUNDLE_REFERENCE_VERSION;
    let key = if codex { "mcp_servers" } else { "mcpServers" };
    // A document without the native server map is not "no references": the
    // established native gate fails closed, and so does this one.
    let servers = document
        .get(key)
        .and_then(serde_json::Value::as_object)
        .ok_or(BundleReject::Content)?;
    let mut pairs = BTreeSet::new();
    let mut digests = BTreeMap::new();
    for (server, value) in servers {
        for variable in server_reference_variables(codex, value, strict)? {
            pairs.insert((server.clone(), variable));
        }
        let bytes = serde_json::to_vec(value).map_err(|_| BundleReject::Content)?;
        digests.insert(
            server.clone(),
            format!("sha256:{:x}", Sha256::digest(&bytes)),
        );
    }
    if pairs.len() > MAX_MCP_REFERENCES {
        return Err(BundleReject::Count);
    }
    let mut references = Vec::with_capacity(pairs.len());
    for (server_name, variable) in pairs {
        let config_digest = digests
            .get(&server_name)
            .cloned()
            .ok_or(BundleReject::Content)?;
        references.push(McpEnvironmentReference {
            server_name,
            variable,
            config_digest,
        });
    }
    Ok(references)
}

fn server_reference_variables(
    codex: bool,
    value: &serde_json::Value,
    strict: bool,
) -> Result<BTreeSet<String>, BundleReject> {
    let mut variables = BTreeSet::new();
    if codex {
        for field in ["env", "http_headers"] {
            let Some(values) = value.get(field) else {
                continue;
            };
            for entry in values.as_object().ok_or(BundleReject::Content)?.values() {
                // A v2 bundle says every value is a reference, so a raw value
                // here — however harmless its name — would be a value on the
                // wire. Only the empty value keeps its place.
                if strict && !entry.as_str().ok_or(BundleReject::Content)?.is_empty() {
                    return Err(BundleReject::Content);
                }
            }
        }
        if let Some(env_vars) = value.get("env_vars") {
            for entry in env_vars.as_array().ok_or(BundleReject::Content)? {
                variables.insert(reference_name(entry.as_str().ok_or(BundleReject::Content)?)?);
            }
        }
        if let Some(headers) = value.get("env_http_headers") {
            for entry in headers.as_object().ok_or(BundleReject::Content)?.values() {
                variables.insert(reference_name(entry.as_str().ok_or(BundleReject::Content)?)?);
            }
        }
    } else {
        for field in ["env", "headers"] {
            let Some(values) = value.get(field) else {
                continue;
            };
            for entry in values.as_object().ok_or(BundleReject::Content)?.values() {
                let text = entry.as_str().ok_or(BundleReject::Content)?;
                match placeholder_reference(text)? {
                    Some(name) => {
                        variables.insert(name);
                    }
                    None if strict && !text.is_empty() => return Err(BundleReject::Content),
                    None => {}
                }
            }
        }
    }
    Ok(variables)
}

fn placeholder_reference(text: &str) -> Result<Option<String>, BundleReject> {
    if !text.contains("${") {
        return Ok(None);
    }
    let name = text
        .strip_prefix("${")
        .and_then(|rest| rest.strip_suffix('}'))
        .ok_or(BundleReject::Content)?;
    Ok(Some(reference_name(name)?))
}

fn reference_name(name: &str) -> Result<String, BundleReject> {
    valid_mcp_reference_name(name)
        .then(|| name.to_string())
        .ok_or(BundleReject::Content)
}

/// What the receiver already knows about this attempt.
#[derive(Debug, Clone, Copy)]
pub struct BundleExpectation<'a> {
    pub run_id: &'a str,
    pub attempt: u32,
    pub adapter_kind: &'a str,
}

/// Typed refusal. `code()` is the stable wire code; it never carries content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundleReject {
    Version,
    Identity,
    RunIdentity,
    Adapter,
    Digest,
    Path,
    Duplicate,
    Order,
    Count,
    Size,
    Content,
    Artifact,
    MissingBootstrap,
    SkillRoot,
}

impl BundleReject {
    pub fn code(self) -> &'static str {
        match self {
            Self::Version => "bundle_version",
            Self::Identity => "bundle_identity",
            Self::RunIdentity => "bundle_run_identity",
            Self::Adapter => "bundle_adapter",
            Self::Digest => "bundle_digest",
            Self::Path => "bundle_path",
            Self::Duplicate => "bundle_duplicate",
            Self::Order => "bundle_order",
            Self::Count => "bundle_count",
            Self::Size => "bundle_size",
            Self::Content => "bundle_content",
            Self::Artifact => "bundle_artifact",
            Self::MissingBootstrap => "bundle_missing_bootstrap",
            Self::SkillRoot => "bundle_skill_root",
        }
    }
}

impl std::fmt::Display for BundleReject {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for BundleReject {}

/// The one path a file of this artifact may take. `None` means the artifact and
/// label do not describe a file at all.
pub fn canonical_path(artifact: BundleArtifact, label: &str) -> Option<String> {
    match artifact {
        BundleArtifact::BootstrapPrompt => {
            (label == LABEL_BOOTSTRAP).then(|| format!("{LABEL_BOOTSTRAP}.txt"))
        }
        BundleArtifact::McpConfig => (label == LABEL_MCP).then(|| format!("{LABEL_MCP}.json")),
        BundleArtifact::RuntimeSettings => {
            (label == LABEL_SETTINGS).then(|| format!("{LABEL_SETTINGS}.json"))
        }
        BundleArtifact::SkillFile => {
            let (skill, relative) = label.split_once('/')?;
            safe_component(skill).ok()?;
            safe_relative(relative).ok()?;
            Some(format!("skills/{skill}/{relative}"))
        }
    }
}

/// A bundle-relative path: forward slashes, ASCII-only segments, no `.`/`..`,
/// no absolute, drive or UNC form, no separators other than `/`, no
/// Windows-reserved names.
///
/// Segments are ASCII-only by contract, so ASCII case folding is the whole
/// case-folding story for collision detection. A non-ASCII name is refused
/// instead of guessed; the bundle never relies on host Unicode case folding.
pub fn safe_bundle_relative(path: &str) -> Result<(), BundleReject> {
    safe_relative(path)
}

fn safe_relative(path: &str) -> Result<(), BundleReject> {
    if path.is_empty() || path.len() > MAX_BUNDLE_PATH_BYTES {
        return Err(BundleReject::Path);
    }
    // Refused before splitting, so a drive prefix or UNC form cannot be read as
    // an ordinary first segment.
    if path.contains('\\') || path.starts_with('/') {
        return Err(BundleReject::Path);
    }
    for segment in path.split('/') {
        safe_component(segment)?;
    }
    Ok(())
}

fn safe_component(segment: &str) -> Result<(), BundleReject> {
    if segment.is_empty() || segment.len() > MAX_PATH_SEGMENT_BYTES {
        return Err(BundleReject::Path);
    }
    if segment == "." || segment == ".." {
        return Err(BundleReject::Path);
    }
    // Windows silently drops these, which would let two names become one file.
    if segment.ends_with(' ') || segment.ends_with('.') {
        return Err(BundleReject::Path);
    }
    for character in segment.chars() {
        if !character.is_ascii()
            || character.is_ascii_control()
            || matches!(
                character,
                '\\' | '/' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
            )
        {
            return Err(BundleReject::Path);
        }
    }
    let stem = segment.split('.').next().unwrap_or(segment).trim_end();
    if WINDOWS_RESERVED_STEMS.contains(&stem.to_ascii_lowercase().as_str()) {
        return Err(BundleReject::Path);
    }
    Ok(())
}

/// Longest standard (padded) base64 text that can decode to `decoded` bytes.
pub fn base64_encoded_len(decoded: usize) -> usize {
    decoded.div_ceil(3) * 4
}

/// Decode one file without trusting its declaration. The declared size and the
/// encoded length are both bounded before any allocation, so an oversized frame
/// cannot be turned into memory.
pub fn decode_file(file: &BundleFile) -> Result<Vec<u8>, BundleReject> {
    if file.bytes > MAX_BUNDLE_FILE_BYTES {
        return Err(BundleReject::Size);
    }
    if file.content.len() > base64_encoded_len(file.bytes) {
        return Err(BundleReject::Size);
    }
    let decoded = STANDARD
        .decode(file.content.as_bytes())
        .map_err(|_| BundleReject::Content)?;
    if decoded.len() != file.bytes {
        return Err(BundleReject::Size);
    }
    Ok(decoded)
}

pub fn bundle_digest(bundle: &RunBundleV1) -> Result<String, BundleReject> {
    let mut cleared = bundle.clone();
    cleared.digest = String::new();
    let bytes = serde_json::to_vec(&cleared).map_err(|_| BundleReject::Content)?;
    Ok(format!("sha256:{:x}", Sha256::digest(&bytes)))
}

/// Validate without any IO. The receiver calls this before creating a directory.
pub fn validate(bundle: &RunBundleV1, expect: &BundleExpectation<'_>) -> Result<(), BundleReject> {
    if !matches!(
        bundle.version,
        RUN_BUNDLE_VERSION | RUN_BUNDLE_REFERENCE_VERSION
    ) {
        return Err(BundleReject::Version);
    }
    validate_identity(bundle)?;
    if bundle.run_id != expect.run_id || bundle.attempt != expect.attempt {
        return Err(BundleReject::RunIdentity);
    }
    let Some(received) = canonical_adapter_kind(&bundle.adapter_kind) else {
        return Err(BundleReject::Adapter);
    };
    // The bundle itself must use the canonical spelling; only the receiver may
    // still be reached through the established alias.
    if bundle.adapter_kind != received {
        return Err(BundleReject::Adapter);
    }
    if canonical_adapter_kind(expect.adapter_kind) != Some(received) {
        return Err(BundleReject::Adapter);
    }
    if !bundle.digest.starts_with("sha256:") {
        return Err(BundleReject::Digest);
    }
    if bundle.files.len() > MAX_BUNDLE_FILES {
        return Err(BundleReject::Count);
    }

    let mut total: usize = 0;
    for file in &bundle.files {
        let Some(canonical) = canonical_path(file.artifact, &file.label) else {
            return Err(BundleReject::Artifact);
        };
        if file.path != canonical {
            return Err(BundleReject::Path);
        }
        safe_bundle_relative(&file.path)?;
        // Decode one file at a time: both caps are checked before allocation and
        // only the length and UTF-8 validity are needed, so no decoded bodies are
        // retained.
        let content = decode_file(file)?;
        let is_text = matches!(
            file.artifact,
            BundleArtifact::BootstrapPrompt
                | BundleArtifact::McpConfig
                | BundleArtifact::RuntimeSettings
        );
        if is_text && std::str::from_utf8(&content).is_err() {
            return Err(BundleReject::Content);
        }
        total = total.saturating_add(file.bytes);
        if total > MAX_BUNDLE_DECODED_BYTES {
            return Err(BundleReject::Size);
        }
    }

    let mut paths = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut singletons = BTreeSet::new();
    for file in &bundle.files {
        // Case-insensitive: bundle paths are ASCII-only, so ASCII folding is the
        // whole case-folding story and two names that differ only in case cannot
        // become one Windows file.
        if !paths.insert(file.path.to_ascii_lowercase()) {
            return Err(BundleReject::Duplicate);
        }
        if !keys.insert((file.artifact.rank(), file.label.clone())) {
            return Err(BundleReject::Duplicate);
        }
        if file.artifact.is_singleton() && !singletons.insert(file.artifact.rank()) {
            return Err(BundleReject::Duplicate);
        }
    }

    let order = bundle
        .files
        .iter()
        .map(|file| (file.artifact.rank(), file.label.clone()))
        .collect::<Vec<_>>();
    if !order.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(BundleReject::Order);
    }

    let encoded = serde_json::to_vec(bundle).map_err(|_| BundleReject::Content)?;
    if encoded.len() > MAX_BUNDLE_ENCODED_BYTES {
        return Err(BundleReject::Size);
    }

    // The additive instructions are the reason this bundle exists for a member.
    let has_bootstrap = bundle
        .files
        .iter()
        .any(|file| file.artifact == BundleArtifact::BootstrapPrompt && file.bytes > 0);
    if !has_bootstrap {
        return Err(BundleReject::MissingBootstrap);
    }
    let has_skill = bundle
        .files
        .iter()
        .any(|file| file.artifact == BundleArtifact::SkillFile);
    let root = bundle.source_skill_root.as_deref().unwrap_or("").trim();
    if has_skill != !root.is_empty() {
        return Err(BundleReject::SkillRoot);
    }

    // The version describes exactly one property: whether the frozen MCP
    // document refers to credentials by name. A v1 bundle carrying a reference
    // and a v2 bundle carrying none are both refused, so neither can be read as
    // the other shape.
    let has_references = !mcp_environment_references(bundle)?.is_empty();
    if has_references != (bundle.version == RUN_BUNDLE_REFERENCE_VERSION) {
        return Err(BundleReject::Version);
    }

    if bundle_digest(bundle)? != bundle.digest {
        return Err(BundleReject::Digest);
    }
    Ok(())
}

fn validate_identity(bundle: &RunBundleV1) -> Result<(), BundleReject> {
    if !identifier(&bundle.run_id, MAX_BUNDLE_RUN_ID_BYTES) {
        return Err(BundleReject::Identity);
    }
    // Attempts are one-based; zero would make the derived identity ambiguous.
    if bundle.attempt == 0 {
        return Err(BundleReject::Identity);
    }
    if bundle.bundle_id != bundle_id_for(&bundle.run_id, bundle.attempt)
        || bundle.bundle_id.len() > MAX_BUNDLE_BUNDLE_ID_BYTES
    {
        return Err(BundleReject::Identity);
    }
    if !identifier(&bundle.agent_id, MAX_BUNDLE_AGENT_ID_BYTES) {
        return Err(BundleReject::Identity);
    }
    if !plain_text(
        &bundle.selection_revision,
        MAX_BUNDLE_SELECTION_REVISION_BYTES,
    ) {
        return Err(BundleReject::Identity);
    }
    if let Some(root) = bundle.source_skill_root.as_deref()
        && (root.len() > MAX_BUNDLE_SOURCE_ROOT_BYTES || root.chars().any(char::is_control))
    {
        return Err(BundleReject::SkillRoot);
    }
    Ok(())
}

fn identifier(value: &str, maximum: usize) -> bool {
    (1..=maximum).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn plain_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

/// Only two pre-existing structured sections may have their root relocated.
/// Rules or task text containing the old path are never globally substituted.
pub fn relocate_skill_roots(
    text: &str,
    source: Option<&str>,
    destination: &str,
    bundle: &RunBundleV1,
) -> Result<String, &'static str> {
    let Some(source) = source else {
        return Ok(text.to_string());
    };
    let available = bundle
        .files
        .iter()
        .filter(|file| {
            file.artifact == BundleArtifact::SkillFile && file.label.ends_with("/SKILL.md")
        })
        .filter_map(|file| file.label.strip_suffix("/SKILL.md"))
        .collect::<BTreeSet<_>>();
    let mut result = text.to_string();
    let mut seen_names = BTreeSet::new();
    for section in ["ROVAI_PLATFORM_SKILLS", "ROVAI_ADDITIONAL_SKILLS"] {
        let open = format!("[{section}]\n");
        let close = format!("\n[/{section}]");
        let Some(start) = result.find(&open) else {
            continue;
        };
        if result[start + open.len()..].contains(&open) {
            return Err("bundle_skill_index");
        }
        let payload_start = start + open.len();
        let end = result[payload_start..]
            .find(&close)
            .map(|offset| payload_start + offset)
            .ok_or("bundle_skill_index")?;
        let payload = &result[payload_start..end];
        let (prefix, json_text) = if section == "ROVAI_ADDITIONAL_SKILLS" {
            let prefix = "Current for this run; replaces any earlier Rovai Additional Skills.\n";
            (
                prefix,
                payload.strip_prefix(prefix).ok_or("bundle_skill_index")?,
            )
        } else {
            ("", payload)
        };
        let mut value: serde_json::Value = serde_json::from_str(json_text).map_err(|_| "bundle_skill_index")?;
        let object = value.as_object_mut().ok_or("bundle_skill_index")?;
        if object.len() != 2 || object.get("root").and_then(serde_json::Value::as_str) != Some(source) {
            return Err("bundle_skill_index");
        }
        let entries = object
            .get("skills")
            .and_then(serde_json::Value::as_array)
            .ok_or("bundle_skill_index")?;
        for entry in entries {
            let entry = entry.as_object().ok_or("bundle_skill_index")?;
            if entry.len() != 2 || !entry.get("desc").is_some_and(serde_json::Value::is_string) {
                return Err("bundle_skill_index");
            }
            let name = entry
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or("bundle_skill_index")?;
            if !available.contains(name) || !seen_names.insert(name.to_string()) {
                return Err("bundle_skill_index");
            }
        }
        // Preserve every renderer byte except this verified root value. A full
        // Value serialization would reorder entry keys and rewrite whitespace.
        let old_root = format!(
            "\"root\":{}",
            serde_json::to_string(source).map_err(|_| "bundle_skill_index")?
        );
        let new_root = format!(
            "\"root\":{}",
            serde_json::to_string(destination).map_err(|_| "bundle_skill_index")?
        );
        if json_text.matches(&old_root).count() != 1 {
            return Err("bundle_skill_index");
        }
        let json = json_text.replacen(&old_root, &new_root, 1);
        result.replace_range(payload_start..end, &format!("{prefix}{json}"));
    }
    if seen_names
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != available
    {
        return Err("bundle_skill_index");
    }
    Ok(result)
}


#[cfg(test)]
mod tests {
    //! One owner for the wire contract: identity/version/digest refusal, the
    //! path jail, duplicate detection and the size caps.
    //!
    //! Admission (docs/development/testing.md): the contract owner is this pure
    //! validator; before it existed nothing checked a bundle at all, so every
    //! negative case below is a regression the node would have accepted; no
    //! existing owner covers a wire bundle (workspace.rs owns the worktree jail,
    //! not bundle paths); the owner is a pure unit test, so no database, process
    //! or filesystem fixture is needed.

    use super::*;

    fn file(artifact: BundleArtifact, label: &str, content: &[u8]) -> BundleFile {
        BundleFile {
            artifact,
            label: label.to_string(),
            path: canonical_path(artifact, label).expect("canonical path"),
            bytes: content.len(),
            content: STANDARD.encode(content),
        }
    }

    fn raw(artifact: BundleArtifact, label: &str, path: &str, content: &[u8]) -> BundleFile {
        BundleFile {
            artifact,
            label: label.to_string(),
            path: path.to_string(),
            bytes: content.len(),
            content: STANDARD.encode(content),
        }
    }

    fn bundle(files: Vec<BundleFile>, adapter: &str, root: Option<&str>) -> RunBundleV1 {
        let mut bundle = RunBundleV1 {
            version: RUN_BUNDLE_VERSION,
            bundle_id: bundle_id_for("run_ab12", 1),
            run_id: "run_ab12".to_string(),
            attempt: 1,
            agent_id: "agent_1".to_string(),
            adapter_kind: adapter.to_string(),
            selection_revision: "rev_1".to_string(),
            source_skill_root: root.map(str::to_string),
            digest: String::new(),
            files,
        };
        bundle.digest = bundle_digest(&bundle).expect("digest");
        bundle
    }

    fn expect<'a>(run_id: &'a str, adapter: &'a str) -> BundleExpectation<'a> {
        BundleExpectation {
            run_id,
            attempt: 1,
            adapter_kind: adapter,
        }
    }

    fn code(result: Result<(), BundleReject>) -> &'static str {
        result.expect_err("bundle was accepted").code()
    }

    #[test]
    fn a_minimal_bundle_round_trips_and_its_digest_covers_every_field() {
        let minimal = bundle(
            vec![file(
                BundleArtifact::BootstrapPrompt,
                LABEL_BOOTSTRAP,
                b"hi",
            )],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        validate(&minimal, &expect("run_ab12", "claude-code-cli")).expect("valid bundle");
        let json = serde_json::to_string(&minimal).unwrap();
        assert_eq!(serde_json::from_str::<RunBundleV1>(&json).unwrap(), minimal);
        assert_eq!(minimal.bundle_id, "run_ab12-1");
        assert!(minimal.digest.starts_with("sha256:"));

        let baseline = minimal.digest.clone();
        for changed in [
            RunBundleV1 {
                agent_id: "agent_2".to_string(),
                ..minimal.clone()
            },
            RunBundleV1 {
                selection_revision: "rev_2".to_string(),
                ..minimal.clone()
            },
            RunBundleV1 {
                attempt: 2,
                bundle_id: bundle_id_for("run_ab12", 2),
                ..minimal.clone()
            },
            RunBundleV1 {
                files: vec![file(
                    BundleArtifact::BootstrapPrompt,
                    LABEL_BOOTSTRAP,
                    b"ho",
                )],
                ..minimal.clone()
            },
        ] {
            assert_ne!(bundle_digest(&changed).unwrap(), baseline);
        }
        // Blanking the digest is how the digest is defined, so it cannot hide.
        let mut self_signed = minimal.clone();
        self_signed.digest = String::new();
        assert_eq!(bundle_digest(&self_signed).unwrap(), baseline);
    }

    #[test]
    fn unsafe_relative_paths_and_canonical_labels_are_refused() {
        // Segments are ASCII-only by contract, so ASCII case folding is the whole
        // collision story: non-ASCII names are refused instead of guessed.
        for path in [
            "../x",
            "/etc/passwd",
            "C:/x",
            "C:x",
            "\\\\host\\share",
            "a\\b",
            "a//b",
            "a/",
            "/a",
            "./a",
            "a/./b",
            "con",
            "skills/con.txt",
            "skills/CON.md",
            "a/x.",
            "a/x ",
            "a/x:y",
            "a/x?y",
            "a/x*y",
            "a\u{0}b",
            "a\u{7f}b",
            // Non-ASCII: a Kelvin sign, a combining accent and a precomposed
            // letter would each need host-specific case folding.
            "skills/K\u{212a}/SKILL.md",
            "skills/cafe\u{301}/SKILL.md",
            "skills/CAF\u{e9}/SKILL.md",
            "",
        ] {
            assert_eq!(
                safe_bundle_relative(path),
                Err(BundleReject::Path),
                "{path} was accepted"
            );
        }
        assert!(safe_bundle_relative("skills/campfire/SKILL.md").is_ok());
        assert!(safe_bundle_relative("skills/campfire/references/intro doc.md").is_ok());

        // Labels that do not describe a file cannot be papered over with a path.
        assert_eq!(canonical_path(BundleArtifact::McpConfig, "settings"), None);
        assert_eq!(
            canonical_path(BundleArtifact::BootstrapPrompt, "bootstrap.txt"),
            None
        );
        assert_eq!(canonical_path(BundleArtifact::SkillFile, "campfire"), None);
        assert_eq!(
            canonical_path(BundleArtifact::SkillFile, "campfire/../x"),
            None
        );
        assert_eq!(
            canonical_path(BundleArtifact::SkillFile, "/abs/SKILL.md"),
            None
        );
        assert_eq!(
            canonical_path(BundleArtifact::SkillFile, "campfire/\u{2713}.md"),
            None
        );
        assert_eq!(
            canonical_path(BundleArtifact::SkillFile, "campfire/SKILL.md").as_deref(),
            Some("skills/campfire/SKILL.md")
        );
    }

    #[test]
    fn duplicate_case_colliding_and_singleton_files_are_refused() {
        let duplicate = bundle(
            vec![
                file(BundleArtifact::BootstrapPrompt, LABEL_BOOTSTRAP, b"hi"),
                file(BundleArtifact::SkillFile, "campfire/SKILL.md", b"a"),
                file(BundleArtifact::SkillFile, "campfire/SKILL.md", b"b"),
            ],
            ADAPTER_CLAUDE_CODE,
            Some("/srv/skills"),
        );
        assert_eq!(
            code(validate(
                &duplicate,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_duplicate"
        );

        // Two labels that differ only in case land on one Windows file.
        let colliding = bundle(
            vec![
                file(BundleArtifact::BootstrapPrompt, LABEL_BOOTSTRAP, b"hi"),
                file(BundleArtifact::SkillFile, "Campfire/SKILL.md", b"a"),
                file(BundleArtifact::SkillFile, "campfire/SKILL.md", b"b"),
            ],
            ADAPTER_CLAUDE_CODE,
            Some("/srv/skills"),
        );
        assert_eq!(
            code(validate(
                &colliding,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_duplicate"
        );

        let two_bootstraps = bundle(
            vec![
                file(BundleArtifact::BootstrapPrompt, LABEL_BOOTSTRAP, b"hi"),
                raw(
                    BundleArtifact::BootstrapPrompt,
                    "bootstrap",
                    "bootstrap.txt",
                    b"ho",
                ),
            ],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        assert_eq!(
            code(validate(
                &two_bootstraps,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_duplicate"
        );

        // A path that is not the canonical one for its artifact.
        let wrong_path = bundle(
            vec![raw(
                BundleArtifact::BootstrapPrompt,
                LABEL_BOOTSTRAP,
                "skills/bootstrap.txt",
                b"hi",
            )],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        assert_eq!(
            code(validate(
                &wrong_path,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_path"
        );
    }

    #[test]
    fn noncanonical_order_is_refused() {
        let out_of_order = bundle(
            vec![
                file(BundleArtifact::McpConfig, LABEL_MCP, b"{}"),
                file(BundleArtifact::BootstrapPrompt, LABEL_BOOTSTRAP, b"hi"),
            ],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        assert_eq!(
            code(validate(
                &out_of_order,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_order"
        );
    }

    #[test]
    fn size_and_content_caps_are_enforced_before_any_io() {
        let oversized = bundle(
            vec![
                file(BundleArtifact::BootstrapPrompt, LABEL_BOOTSTRAP, b"hi"),
                file(
                    BundleArtifact::SkillFile,
                    "campfire/big.bin",
                    &vec![b'x'; MAX_BUNDLE_FILE_BYTES + 1],
                ),
            ],
            ADAPTER_CLAUDE_CODE,
            Some("/srv/skills"),
        );
        assert_eq!(
            code(validate(
                &oversized,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_size"
        );

        let mut wrong_length = bundle(
            vec![file(
                BundleArtifact::BootstrapPrompt,
                LABEL_BOOTSTRAP,
                b"hi",
            )],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        wrong_length.files[0].bytes = 5;
        wrong_length.digest = bundle_digest(&wrong_length).unwrap();
        assert_eq!(
            code(validate(
                &wrong_length,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_size"
        );

        let mut not_base64 = bundle(
            vec![file(
                BundleArtifact::BootstrapPrompt,
                LABEL_BOOTSTRAP,
                b"hi",
            )],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        not_base64.files[0].content = "!!".into();
        not_base64.digest = bundle_digest(&not_base64).unwrap();
        assert_eq!(
            code(validate(
                &not_base64,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_content"
        );

        let mut too_many = bundle(
            vec![file(
                BundleArtifact::BootstrapPrompt,
                LABEL_BOOTSTRAP,
                b"hi",
            )],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        for index in 0..MAX_BUNDLE_FILES {
            too_many.files.push(file(
                BundleArtifact::SkillFile,
                &format!("skill{index}/SKILL.md"),
                b"x",
            ));
        }
        too_many.digest = bundle_digest(&too_many).unwrap();
        assert_eq!(
            code(validate(
                &too_many,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_count"
        );

        // The body cannot be longer than the standard base64 length of its
        // declared size, so it is refused before any allocation.
        let mut padded = bundle(
            vec![file(
                BundleArtifact::BootstrapPrompt,
                LABEL_BOOTSTRAP,
                b"hi",
            )],
            ADAPTER_CLAUDE_CODE,
            None,
        );
        padded.files[0].bytes = 2;
        padded.files[0].content = STANDARD.encode(vec![b'x'; 64]);
        padded.digest = bundle_digest(&padded).unwrap();
        assert_eq!(
            code(validate(&padded, &expect("run_ab12", ADAPTER_CLAUDE_CODE))),
            "bundle_size"
        );
        assert_eq!(base64_encoded_len(0), 0);
        assert_eq!(base64_encoded_len(1), 4);
        assert_eq!(base64_encoded_len(3), 4);
        assert_eq!(base64_encoded_len(4), 8);

        // `decode_file` owns the same two bounds on its own.
        let oversized_declaration = BundleFile {
            artifact: BundleArtifact::BootstrapPrompt,
            label: LABEL_BOOTSTRAP.to_string(),
            path: "bootstrap.txt".to_string(),
            bytes: MAX_BUNDLE_FILE_BYTES + 1,
            content: String::new(),
        };
        assert_eq!(decode_file(&oversized_declaration), Err(BundleReject::Size));
        let overlong_body = BundleFile {
            artifact: BundleArtifact::BootstrapPrompt,
            label: LABEL_BOOTSTRAP.to_string(),
            path: "bootstrap.txt".to_string(),
            bytes: 3,
            content: STANDARD.encode(vec![b'x'; 12]),
        };
        assert_eq!(decode_file(&overlong_body), Err(BundleReject::Size));
    }

    #[test]
    fn identity_runtime_digest_bootstrap_and_skill_root_are_typed_refusals() {
        let valid = bundle(
            vec![
                file(BundleArtifact::BootstrapPrompt, LABEL_BOOTSTRAP, b"hi"),
                file(BundleArtifact::SkillFile, "campfire/SKILL.md", b"body"),
            ],
            ADAPTER_CLAUDE_CODE,
            Some("/srv/skills"),
        );
        validate(&valid, &expect("run_ab12", ADAPTER_CLAUDE_CODE)).expect("valid bundle");

        let other_run = validate(&valid, &expect("run_other", ADAPTER_CLAUDE_CODE));
        assert_eq!(code(other_run), "bundle_run_identity");
        let other_attempt = validate(
            &valid,
            &BundleExpectation {
                attempt: 2,
                ..expect("run_ab12", ADAPTER_CLAUDE_CODE)
            },
        );
        assert_eq!(code(other_attempt), "bundle_run_identity");
        let other_runtime = validate(&valid, &expect("run_ab12", ADAPTER_CODEX_CLI));
        assert_eq!(code(other_runtime), "bundle_adapter");
        let unknown_runtime = validate(&valid, &expect("run_ab12", "pi"));
        assert_eq!(code(unknown_runtime), "bundle_adapter");

        // Attempts are one-based.
        let mut zero_attempt = valid.clone();
        zero_attempt.attempt = 0;
        zero_attempt.bundle_id = bundle_id_for("run_ab12", 0);
        zero_attempt.digest = bundle_digest(&zero_attempt).unwrap();
        assert_eq!(
            code(validate(
                &zero_attempt,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_identity"
        );

        // The bundle must carry the canonical runtime string; only the receiver
        // may still use the established alias.
        let mut alias = valid.clone();
        alias.adapter_kind = "claude-code-cli".to_string();
        alias.digest = bundle_digest(&alias).unwrap();
        assert_eq!(
            code(validate(&alias, &expect("run_ab12", "claude-code-cli"))),
            "bundle_adapter"
        );

        let mut old_version = valid.clone();
        old_version.version = RUN_BUNDLE_VERSION + 1;
        assert_eq!(
            code(validate(
                &old_version,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_version"
        );

        let mut tampered = valid.clone();
        tampered.files[0].content = STANDARD.encode(b"ho");
        tampered.files[0].bytes = 2;
        assert_eq!(
            code(validate(
                &tampered,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_digest"
        );

        let mut fresh_id = valid.clone();
        fresh_id.bundle_id = "bundle_fresh".to_string();
        fresh_id.digest = bundle_digest(&fresh_id).unwrap();
        assert_eq!(
            code(validate(
                &fresh_id,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_identity"
        );

        let mut empty_revision = valid.clone();
        empty_revision.selection_revision = "  ".to_string();
        empty_revision.digest = bundle_digest(&empty_revision).unwrap();
        assert_eq!(
            code(validate(
                &empty_revision,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_identity"
        );

        let no_bootstrap = RunBundleV1 {
            files: vec![file(
                BundleArtifact::SkillFile,
                "campfire/SKILL.md",
                b"body",
            )],
            ..valid.clone()
        };
        let no_bootstrap = RunBundleV1 {
            digest: bundle_digest(&no_bootstrap).unwrap(),
            ..no_bootstrap
        };
        assert_eq!(
            code(validate(
                &no_bootstrap,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_missing_bootstrap"
        );

        let rootless = RunBundleV1 {
            source_skill_root: None,
            digest: String::new(),
            ..valid.clone()
        };
        let rootless = RunBundleV1 {
            digest: bundle_digest(&rootless).unwrap(),
            ..rootless
        };
        assert_eq!(
            code(validate(
                &rootless,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_skill_root"
        );

        let control_root = RunBundleV1 {
            source_skill_root: Some("/srv/\u{7f}skills".to_string()),
            digest: String::new(),
            ..valid.clone()
        };
        let control_root = RunBundleV1 {
            digest: bundle_digest(&control_root).unwrap(),
            ..control_root
        };
        assert_eq!(
            code(validate(
                &control_root,
                &expect("run_ab12", ADAPTER_CLAUDE_CODE)
            )),
            "bundle_skill_root"
        );
    }

    #[test]
    fn a_maximal_bundle_stays_inside_the_encoded_transport_budget() {
        // 64 files of 12 KiB stay under every cap and demonstrate that the
        // serialized frame keeps margin under the 2 MiB transport limit.
        let mut files = vec![file(
            BundleArtifact::BootstrapPrompt,
            LABEL_BOOTSTRAP,
            b"hi",
        )];
        for index in 0..63 {
            files.push(file(
                BundleArtifact::SkillFile,
                &format!("skill{index:02}/payload.bin"),
                &vec![b'x'; 12 * 1024],
            ));
        }
        let maximal = bundle(files, ADAPTER_CLAUDE_CODE, Some("/srv/skills"));
        validate(&maximal, &expect("run_ab12", ADAPTER_CLAUDE_CODE)).expect("valid bundle");
        let encoded = serde_json::to_vec(&maximal).unwrap().len();
        assert!(encoded < MAX_BUNDLE_ENCODED_BYTES);
        assert!(encoded < 2 * 1024 * 1024);
    }

    fn mcp_bundle(document: &serde_json::Value, adapter: &str) -> RunBundleV1 {
        let mut bundle = bundle(
            vec![
                file(BundleArtifact::BootstrapPrompt, LABEL_BOOTSTRAP, b"hi"),
                file(
                    BundleArtifact::McpConfig,
                    LABEL_MCP,
                    &serde_json::to_vec(document).expect("document"),
                ),
            ],
            adapter,
            None,
        );
        bundle.digest = bundle_digest(&bundle).expect("digest");
        bundle
    }

    fn with_version(mut bundle: RunBundleV1, version: u32) -> RunBundleV1 {
        bundle.version = version;
        bundle.digest = bundle_digest(&bundle).expect("digest");
        bundle
    }

    #[test]
    fn a_reference_free_mcp_document_keeps_the_old_version_and_bytes() {
        let document = serde_json::json!({
            "mcpServers": {"docs": {"type": "stdio", "command": "docs-mcp", "env": {}}}
        });
        let bundle = mcp_bundle(&document, ADAPTER_CLAUDE_CODE);
        assert_eq!(bundle.version, RUN_BUNDLE_VERSION);
        assert!(mcp_environment_references(&bundle).unwrap().is_empty());
        validate(&bundle, &expect("run_ab12", ADAPTER_CLAUDE_CODE)).expect("v1 accepted");
        // An unrecognised native shape fails closed instead of reading as "no
        // references".
        let unknown = mcp_bundle(&serde_json::json!({"servers": {}}), ADAPTER_CLAUDE_CODE);
        assert_eq!(
            code(mcp_environment_references(&unknown).map(|_| ())),
            "bundle_content"
        );
        assert_eq!(
            code(validate(&unknown, &expect("run_ab12", ADAPTER_CLAUDE_CODE))),
            "bundle_content"
        );
        // The same bundle under the reference version is a false new version.
        let claimed = with_version(bundle, RUN_BUNDLE_REFERENCE_VERSION);
        assert_eq!(
            code(validate(&claimed, &expect("run_ab12", ADAPTER_CLAUDE_CODE))),
            "bundle_version"
        );
    }

    #[test]
    fn claude_whole_value_placeholders_are_references_and_the_version_follows_them() {
        let document = serde_json::json!({
            "mcpServers": {
                "remote": {
                    "type": "http",
                    "url": "https://example.test/mcp",
                    "headers": {"Authorization": "${DOCS_TOKEN}", "X-Trace": ""}
                }
            }
        });
        let bundle = mcp_bundle(&document, ADAPTER_CLAUDE_CODE);
        let references = mcp_environment_references(&bundle).unwrap();
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].server_name, "remote");
        assert_eq!(references[0].variable, "DOCS_TOKEN");
        assert!(references[0].config_digest.starts_with("sha256:"));
        // The digest keys the receiver's own mapping: it must cover the whole
        // native server value, not just the variable name.
        let server = &document["mcpServers"]["remote"];
        let expected = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(server).unwrap())
        );
        assert_eq!(references[0].config_digest, expected);

        // A v1 bundle carrying the reference is refused.
        assert_eq!(
            code(validate(&bundle, &expect("run_ab12", ADAPTER_CLAUDE_CODE))),
            "bundle_version"
        );
        let v2 = with_version(bundle, RUN_BUNDLE_REFERENCE_VERSION);
        validate(&v2, &expect("run_ab12", ADAPTER_CLAUDE_CODE)).expect("v2 accepted");

        // v2 says every value is a reference, so a raw literal is refused even
        // when its name looks harmless.
        let literal = serde_json::json!({
            "mcpServers": {"remote": {"type": "http", "url": "https://example.test/mcp",
                "headers": {"Authorization": "plain-value"}}}
        });
        let literal_v2 = with_version(
            mcp_bundle(&literal, ADAPTER_CLAUDE_CODE),
            RUN_BUNDLE_REFERENCE_VERSION,
        );
        assert_eq!(
            code(mcp_environment_references(&literal_v2).map(|_| ())),
            "bundle_content"
        );
    }

    #[test]
    fn codex_native_names_are_references_and_a_partial_interpolation_is_refused() {
        let document = serde_json::json!({
            "mcp_servers": {
                "stdio_probe": {
                    "command": "fixture-mcp",
                    "env_vars": ["FIXTURE_TOKEN"],
                    "env": {}
                },
                "remote": {
                    "url": "https://example.test/mcp",
                    "env_http_headers": {"Authorization": "FIXTURE_TOKEN"}
                }
            }
        });
        let bundle = mcp_bundle(&document, ADAPTER_CODEX_CLI);
        let references = mcp_environment_references(&bundle).unwrap();
        assert_eq!(
            references
                .iter()
                .map(|reference| (reference.server_name.as_str(), reference.variable.as_str()))
                .collect::<Vec<_>>(),
            vec![("remote", "FIXTURE_TOKEN"), ("stdio_probe", "FIXTURE_TOKEN")]
        );

        // The same raw `env` is refused under v2, where a value may not ride on
        // the wire at all.
        let raw_env = serde_json::json!({
            "mcp_servers": {"stdio_probe": {"command": "fixture-mcp",
                "env": {"FIXTURE_TOKEN": "plain-value"}}}
        });
        let raw_env_v2 = with_version(
            mcp_bundle(&raw_env, ADAPTER_CODEX_CLI),
            RUN_BUNDLE_REFERENCE_VERSION,
        );
        assert_eq!(
            code(mcp_environment_references(&raw_env_v2).map(|_| ())),
            "bundle_content"
        );

        for value in ["Bearer ${FIXTURE_TOKEN}", "${FIXTURE_TOKEN} $"] {
            let mixed = serde_json::json!({
                "mcpServers": {"remote": {"type": "http", "url": "https://example.test/mcp",
                    "headers": {"Authorization": value}}}
            });
            assert_eq!(
                code(mcp_environment_references(&mcp_bundle(
                    &mixed,
                    ADAPTER_CLAUDE_CODE
                ))
                .map(|_| ())),
                "bundle_content"
            );
        }
    }

    #[test]
    fn reserved_and_malformed_reference_names_are_refused() {
        for name in ["PATH", "HOME", "USERPROFILE", "SystemRoot", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "ROVAI_MCP_TOKEN", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "DSH_TOKEN", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "api_key", "1KEY", "KEY-NAME", "", &"K".repeat(65)] {
            assert!(!valid_mcp_reference_name(name), "{name} accepted");
        }
        for name in ["API_KEY", "GITHUB_TOKEN", "A", "DOCS_ACCESS_TOKEN_2", &"K".repeat(64)] {
            assert!(valid_mcp_reference_name(name), "{name} refused");
        }
        let literal = serde_json::json!({
            "mcpServers": {"remote": {"type": "http", "url": "https://example.test/mcp",
                "headers": {"Authorization": "${PATH}"}}}
        });
        assert_eq!(
            code(mcp_environment_references(&mcp_bundle(&literal, ADAPTER_CLAUDE_CODE)).map(|_| ())),
            "bundle_content"
        );
    }
}
