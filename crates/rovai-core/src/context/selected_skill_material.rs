//! One Run's private materialization of the member's selected Skill sources.
//!
//! This is a per-Run view, never a second content store: every byte is copied
//! out of the already admitted managed root or one registered Library revision,
//! and the copy is verified against its sources before and after the read. The
//! model-facing index points at this Run's own root, so a published Run is read
//! back and re-verified, never rebuilt from a newer selection or revision.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Result, ensure};
use loom_protocol::run_bundle::{
    MAX_BUNDLE_DECODED_BYTES, MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_FILES, safe_bundle_relative,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::managed_skills::{ManagedSkills, SkillIndexEntry, TOOLBOX_SKILLS};
use crate::platform::private_storage::{
    atomic_write_private_bytes, atomic_write_private_json, prepare_private_directory,
};
use crate::remote_run_bundle::{SkillFileSource, additional_skills_section, collect_skill_files};

const SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const CONTENT_DIR: &str = "skills";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

/// The frozen section plus the identity of the material it was rendered from.
pub(super) struct Snapshot {
    pub section: String,
    pub identity_digest: String,
    /// Captured but not published: a candidate prefix of one claim never owns a
    /// directory, only the final claimed Run does.
    pub pending: Option<PendingMaterial>,
}

/// One captured Run's material that has not been published yet.
#[derive(Clone)]
pub(super) struct PendingMaterial {
    run_id: String,
    member_id: String,
    manifest: Manifest,
    files: Vec<SkillFileSource>,
}

impl std::fmt::Debug for PendingMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingMaterial")
            .field("run_id", &self.run_id)
            .field("member_id", &self.member_id)
            .field("files", &self.files.len())
            .finish_non_exhaustive()
    }
}

impl PendingMaterial {
    /// Publishes the captured bytes for the Run this material was captured for.
    /// An existing directory is only ever accepted when it reads back as exactly
    /// this material, so a candidate selection can never overwrite a Run.
    pub(super) fn publish(&self, data_dir: &Path) -> Result<()> {
        let run_root = run_root(data_dir, &self.run_id);
        if exists(&run_root)? {
            let (section, identity_digest) =
                verify_published(&run_root, &self.run_id, &self.member_id)?;
            ensure!(
                identity_digest == self.manifest.identity_digest && section == self.manifest.section,
                "published Skill material does not match this Run"
            );
            return Ok(());
        }
        let root = data_dir.join("runtime").join(CONTENT_PARENT);
        prepare_private_directory(&root)?;
        let staging = root.join(format!(".staging-{}", Uuid::new_v4()));
        let published = (|| -> Result<()> {
            prepare_private_directory(&staging)?;
            for file in &self.files {
                let relative = format!("{}/{}", file.name, file.relative_path);
                let path = staging.join(CONTENT_DIR).join(&relative);
                if let Some(parent) = path.parent() {
                    prepare_private_directory(parent)?;
                }
                atomic_write_private_bytes(&path, &file.content)?;
            }
            // The manifest is the last object written, so a prefix is never published.
            atomic_write_private_json(&staging.join(MANIFEST_FILE), &self.manifest)?;
            commit_directory(&staging, &run_root)
        })();
        if let Err(error) = published {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let (section, identity_digest) = verify_published(&run_root, &self.run_id, &self.member_id)?;
        ensure!(
            identity_digest == self.manifest.identity_digest && section == self.manifest.section,
            "published Skill material does not match this Run"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    run_id: String,
    member_id: String,
    imports: Vec<ImportRecord>,
    files: Vec<FileRecord>,
    section: String,
    identity_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRecord {
    id: String,
    name: String,
    description: String,
    revision_id: String,
    content_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileRecord {
    path: String,
    bytes: usize,
    sha256: String,
}

/// Materializes `runtime/skills/<run_uuid>` when this Run selected an imported
/// Skill. A Run without imported sources keeps the historical section verbatim
/// and owns no directory.
pub(super) fn prepare(
    connection: &Connection,
    data_dir: &Path,
    run_id: &str,
    member_id: &str,
    managed: &ManagedSkills,
    managed_entries: &[SkillIndexEntry],
) -> Result<Option<Snapshot>> {
    let run_root = run_root(data_dir, run_id);
    if exists(&run_root)? {
        // The Run is frozen: its own verified copy wins over any newer selection.
        let (section, identity_digest) = verify_published(&run_root, run_id, member_id)?;
        return Ok(Some(Snapshot {
            section,
            identity_digest,
            pending: None,
        }));
    }
    let imported = crate::member_capability::selected_library_sources(connection, member_id)?;
    if imported.is_empty() {
        return Ok(None);
    }
    ensure!(
        Uuid::parse_str(run_id).is_ok(),
        "Run id is not a Run uuid: {run_id}"
    );

    let mut names = BTreeSet::new();
    for entry in managed_entries {
        ensure!(
            TOOLBOX_SKILLS.contains(&entry.name.as_str()),
            "selected Skill material only copies Toolbox Skills"
        );
        reject_duplicate(&mut names, &entry.name)?;
    }
    for source in &imported {
        reject_duplicate(&mut names, &source.name)?;
    }

    let mut files: Vec<SkillFileSource> = Vec::new();
    let mut total = 0usize;
    for entry in managed_entries {
        let directory = managed.root().join(&entry.name);
        collect_skill_files(&directory, &directory, &entry.name, &mut files, &mut total)?;
    }
    for source in &imported {
        collect_skill_files(&source.path, &source.path, &source.name, &mut files, &mut total)?;
    }
    // Neither the registered revision nor its Library root may move during the
    // read: a changed source is a different source, never a mixed Run snapshot.
    for source in &imported {
        crate::member_capability::verify_selected_skill_source(connection, source)?;
    }

    let mut entries = managed_entries.to_vec();
    entries.extend(imported.iter().map(|source| SkillIndexEntry {
        name: source.name.clone(),
        desc: source.description.clone(),
    }));
    let section = additional_skills_section(&native_path(&run_root.join(CONTENT_DIR))?, &entries)?;

    let imports = imported
        .iter()
        .map(|source| ImportRecord {
            id: source.id.clone(),
            name: source.name.clone(),
            description: source.description.clone(),
            revision_id: source.revision_id.clone(),
            content_digest: source.content_digest.clone(),
        })
        .collect::<Vec<_>>();
    let mut records = files
        .iter()
        .map(|file| FileRecord {
            path: format!("{}/{}", file.name, file.relative_path),
            bytes: file.content.len(),
            sha256: sha256_hex(&file.content),
        })
        .collect::<Vec<_>>();
    // The recorded order is the published order, so a later comparison cannot
    // depend on the member's selection order.
    records.sort();
    let identity_digest = identity_digest(&imports, &records, &section)?;
    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        run_id: run_id.to_string(),
        member_id: member_id.to_string(),
        imports,
        files: records,
        section: section.clone(),
        identity_digest: identity_digest.clone(),
    };
    let pending = PendingMaterial {
        run_id: run_id.to_string(),
        member_id: member_id.to_string(),
        manifest,
        files,
    };
    // A Run row already exists only for the explicit existing-Run fallback. Every
    // candidate prefix of a claim keeps its bytes in memory and publishes none.
    if run_exists(connection, run_id)? {
        pending.publish(data_dir)?;
    }
    Ok(Some(Snapshot {
        section,
        identity_digest,
        pending: Some(pending),
    }))
}

/// Verifies a Run's already published material without reading any source. A
/// marker without its directory is a failure, never a reason to rebuild it.
pub(super) fn validate_existing(
    data_dir: &Path,
    run_id: &str,
    member_id: &str,
    expected_identity_digest: &str,
    expected_section: &str,
) -> Result<()> {
    let (section, identity_digest) = verify_published(&run_root(data_dir, run_id), run_id, member_id)?;
    ensure!(
        identity_digest == expected_identity_digest,
        "frozen Skill material identity changed for Run {run_id}"
    );
    ensure!(
        section == expected_section,
        "frozen Skill material section changed for Run {run_id}"
    );
    Ok(())
}

fn run_exists(connection: &Connection, run_id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run WHERE id = ?1)",
        [run_id],
        |row| row.get::<_, bool>(0),
    )?)
}

const CONTENT_PARENT: &str = "skills";

fn run_root(data_dir: &Path, run_id: &str) -> PathBuf {
    data_dir
        .join("runtime")
        .join(CONTENT_PARENT)
        .join(run_id)
}

fn verify_published(target: &Path, run_id: &str, member_id: &str) -> Result<(String, String)> {
    ensure!(
        !run_id.is_empty()
            && run_id.len() <= 64
            && run_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-'),
        "Run id is not a directory key"
    );
    // Every directory this Run's material is reached through must itself be an
    // admitted private directory, not a link and not silently repaired.
    let Some(parent) = target.parent() else {
        anyhow::bail!("published Skill material has no parent");
    };
    admit_directory(parent)?;
    admit_directory(target)?;
    admit_directory(&target.join(CONTENT_DIR))?;

    let manifest_path = target.join(MANIFEST_FILE);
    ensure!(!is_link(&manifest_path)?, "published Skill manifest is linked");
    let metadata = fs::symlink_metadata(&manifest_path)?;
    ensure!(metadata.is_file(), "published Skill manifest is missing");
    ensure!(
        metadata.len() <= MAX_MANIFEST_BYTES,
        "published Skill manifest is too large"
    );
    let manifest: Manifest = serde_json::from_slice(&read_bounded(&manifest_path, MAX_MANIFEST_BYTES as usize)?)?;
    ensure!(
        manifest.schema_version == SCHEMA_VERSION,
        "published Skill manifest has an unknown schema"
    );
    ensure!(
        manifest.run_id == run_id,
        "published Skill material belongs to another Run"
    );
    ensure!(
        manifest.member_id == member_id,
        "published Skill material belongs to another member"
    );
    let expected = identity_digest(&manifest.imports, &manifest.files, &manifest.section)?;
    ensure!(
        expected == manifest.identity_digest,
        "published Skill manifest is inconsistent"
    );

    let mut expected_files = manifest.files.clone();
    expected_files.sort();
    for file in &expected_files {
        ensure!(
            safe_bundle_relative(&format!("{CONTENT_DIR}/{}", file.path)).is_ok(),
            "published Skill manifest holds an unsafe path"
        );
    }
    let mut observed = BTreeMap::new();
    collect_disk_files(&target.join(CONTENT_DIR), "", &mut observed)?;
    ensure!(
        observed
            .keys()
            .map(|path| path.as_str())
            .eq(expected_files.iter().map(|file| file.path.as_str())),
        "published Skill material holds an unexpected file set"
    );
    for file in &expected_files {
        let actual = observed
            .get(&file.path)
            .ok_or_else(|| anyhow::anyhow!("published Skill file is missing"))?;
        ensure!(
            actual.0 == file.bytes && actual.1 == file.sha256,
            "published Skill file does not match its manifest"
        );
    }
    Ok((manifest.section, manifest.identity_digest))
}

/// Reads every regular file under the Run's content root with the same file and
/// byte budget as a Run bundle, rejecting links and unsupported entries.
fn collect_disk_files(
    directory: &Path,
    prefix: &str,
    out: &mut BTreeMap<String, (usize, String)>,
) -> Result<()> {
    let mut entries = match fs::read_dir(directory) {
        Ok(entries) => entries.collect::<std::io::Result<Vec<_>>>()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        ensure!(!is_link(&path)?, "published Skill material is linked");
        let metadata = fs::symlink_metadata(&path)?;
        let relative = match prefix {
            "" => entry.file_name().to_string_lossy().to_string(),
            _ => format!("{prefix}/{}", entry.file_name().to_string_lossy()),
        };
        if metadata.is_dir() {
            collect_disk_files(&path, &relative, out)?;
        } else if metadata.is_file() {
            ensure!(
                out.len() < MAX_BUNDLE_FILES,
                "published Skill material holds too many files"
            );
            let content = read_bounded(&path, MAX_BUNDLE_FILE_BYTES)?;
            ensure!(
                content.len() as u64 == metadata.len(),
                "published Skill file changed while it was read"
            );
            let total = out
                .values()
                .map(|value| value.0)
                .sum::<usize>()
                .saturating_add(content.len());
            ensure!(
                total <= MAX_BUNDLE_DECODED_BYTES,
                "published Skill material exceeds its byte budget"
            );
            out.insert(relative, (content.len(), sha256_hex(&content)));
        } else {
            anyhow::bail!("published Skill material holds an unsupported entry");
        }
    }
    Ok(())
}

fn read_bounded(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    let mut content = Vec::new();
    fs::File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut content)?;
    ensure!(content.len() <= maximum, "published Skill file is too large");
    Ok(content)
}

fn admit_directory(path: &Path) -> Result<()> {
    ensure!(!is_link(path)?, "Skill material path is linked");
    ensure!(
        fs::symlink_metadata(path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false),
        "Skill material path is not a directory: {}",
        path.display()
    );
    #[cfg(windows)]
    crate::platform::private_storage::admit_private_directory(path)?;
    Ok(())
}

fn native_path(path: &Path) -> Result<String> {
    dunce::simplified(path)
        .to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| anyhow::anyhow!("Skill material root is not UTF-8"))
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn reject_duplicate(names: &mut BTreeSet<String>, name: &str) -> Result<()> {
    ensure!(
        !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains(".."),
        "selected Skill name is unsafe"
    );
    ensure!(
        names.insert(name.to_lowercase()),
        "selected Skill names collide case-insensitively"
    );
    Ok(())
}

fn identity_digest(
    imports: &[ImportRecord],
    files: &[FileRecord],
    section: &str,
) -> Result<String> {
    crate::command::canonical_json_digest(&serde_json::json!({
        "schemaVersion": SCHEMA_VERSION,
        "imports": imports,
        "files": files,
        "section": section,
    }))
}

fn sha256_hex(content: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(content);
    format!("sha256:{:x}", digest.finalize())
}

fn is_link(path: &Path) -> Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || metadata.file_attributes() & 0x400 != 0
    };
    Ok(linked)
}

fn commit_directory(staging: &Path, destination: &Path) -> Result<()> {
    ensure!(!exists(destination)?, "published Skill material already exists");
    #[cfg(windows)]
    crate::platform::private_storage::commit_private_directory_temporary(staging, destination)?;
    #[cfg(not(windows))]
    fs::rename(staging, destination).map_err(|error| {
        anyhow::anyhow!(
            "failed to publish Run Skill material at {}: {error}",
            destination.display()
        )
    })?;
    Ok(())
}
