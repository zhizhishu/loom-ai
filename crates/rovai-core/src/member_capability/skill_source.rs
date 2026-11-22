//! Explicit registry of imported Skill Library entries a member catalog may offer.
//! Text, revisions and digests stay in the Skill Library; only the admitted source root lives here.
use super::MemberCapabilityError;
use crate::{
    command::canonical_json_digest,
    db::Database,
    managed_skills::PUBLISHED_SKILLS,
    skill::{SkillLibraryService, SkillOrigin},
};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use std::path::{Path, PathBuf};

pub(crate) const SCHEMA_SQL: &str = r#"
CREATE TABLE member_skill_source (
    skill_id TEXT PRIMARY KEY REFERENCES skill(id) ON DELETE CASCADE,
    library_root TEXT NOT NULL CHECK(length(library_root) BETWEEN 1 AND 4096),
    registered_at TEXT NOT NULL
);
"#;

/// Catalog ids of registered Skills keep this prefix; Library uuids stay untouched inside.
pub(crate) const ID_PREFIX: &str = "library:";

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let compact = |sql: &str| sql.split_whitespace().collect::<String>();
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='member_skill_source'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(sql.is_some_and(|sql| {
        let sql = compact(&sql);
        sql.contains(&compact("REFERENCES skill(id) ON DELETE CASCADE"))
            && sql.contains(&compact("library_root TEXT NOT NULL"))
    }))
}

/// The Library revision facts a catalog row is stamped with, never a copy of the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stamp {
    pub revision_id: Option<String>,
    pub content_digest: Option<String>,
    pub enabled: bool,
    pub lifecycle_status: String,
    /// Binds the catalog revision to the admitted Library root without exposing Skill text.
    pub root_digest: String,
    pub owner_agent_id: Option<String>,
    pub visibility_scope: String,
}

impl Stamp {
    fn source_error(&self) -> Option<String> {
        if self.revision_id.is_none() {
            return Some("技能内容缺失".to_string());
        }
        if self.lifecycle_status != "active" {
            return Some("技能正在删除".to_string());
        }
        (!self.enabled).then(|| "技能已停用".to_string())
    }
}

pub(crate) struct Registered {
    pub skill_id: String,
    pub name: String,
    pub description: String,
    pub stamp: Stamp,
    pub library_root: String,
}

pub(crate) fn item_id(skill_id: &str) -> String {
    format!("{ID_PREFIX}{skill_id}")
}

pub(crate) fn stamp_source_error(stamp: &Stamp) -> Option<String> {
    stamp.source_error()
}

pub(crate) fn list(database: &Database) -> Result<Vec<Registered>> {
    let mut statement = database.connection().prepare(
        "SELECT s.id, s.name, COALESCE(r.description,''), s.current_revision_id,
                r.content_digest, s.enabled, s.lifecycle_status, m.library_root, m.owner_agent_id, m.visibility_scope
         FROM member_skill_source AS m JOIN skill AS s ON s.id = m.skill_id
         LEFT JOIN skill_revision AS r ON r.id = s.current_revision_id
         ORDER BY s.name, s.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(Registered {
            skill_id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            stamp: Stamp {
                revision_id: row.get(3)?,
                content_digest: row.get(4)?,
                enabled: row.get::<_, i64>(5)? == 1,
                lifecycle_status: row.get(6)?,
                root_digest: String::new(),
                owner_agent_id: row.get(8)?,
                visibility_scope: row.get(9)?,
            },
            library_root: row.get(7)?,
        })
    })?;
    let mut registered = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for entry in &mut registered {
        entry.stamp.root_digest = canonical_json_digest(&json!(entry.library_root))?;
    }
    Ok(registered)
}

/// Registers one already imported Skill as a selectable member catalog source.
pub(crate) fn register(
    database: &Database,
    library: &SkillLibraryService,
    skill_id: &str,
) -> Result<(String, String)> {
    let skill_id = skill_id.trim();
    let skill = library.get(database, skill_id)?.ok_or_else(|| {
        MemberCapabilityError::new("capability.invalid_request", "没有这个导入技能。")
    })?;
    if skill.origin != SkillOrigin::Imported {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "只有导入的技能能加进队员目录。",
        ));
    }
    if skill.lifecycle_status != "active" {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "这个技能正在删除，不能加进目录。",
        ));
    }
    if !skill.enabled {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "这个技能已停用，不能加进目录。",
        ));
    }
    if PUBLISHED_SKILLS.contains(&skill.name.as_str()) {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "同名技能与内置技能冲突。",
        ));
    }
    let root = admit_library_root(library.root())?;
    library
        .verify_revision_content(&skill.current_revision)
        .map_err(|_| unreadable(&skill.id))?;
    let root = root
        .to_str()
        .ok_or_else(|| unreadable(&skill.id))?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    database.connection().execute(
        "INSERT INTO member_skill_source(skill_id,library_root,registered_at) VALUES(?1,?2,?3)
         ON CONFLICT(skill_id) DO UPDATE SET library_root=excluded.library_root",
        params![skill.id, root, now],
    )?;
    Ok((item_id(&skill.id), skill.name))
}

/// Fail-closed admission for a selected `library:` item; never falls back to a same-named Skill.
pub(crate) fn require_selectable(
    connection: &Connection,
    library: &SkillLibraryService,
    skill_id: &str,
) -> Result<()> {
    let stored_root: Option<String> = connection
        .query_row(
            "SELECT library_root FROM member_skill_source WHERE skill_id = ?1",
            [skill_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored_root) = stored_root else {
        return Err(MemberCapabilityError::with_details(
            "capability.skill_source_unavailable",
            "这个技能没有注册到成员目录。",
            json!({ "skillId": skill_id }),
        ));
    };
    let root = admit_library_root(library.root())?;
    if root.to_str() != Some(stored_root.as_str()) {
        return Err(MemberCapabilityError::with_details(
            "capability.skill_source_unavailable",
            "技能库位置变了，请重新注册这个技能。",
            json!({ "skillId": skill_id }),
        ));
    }
    let Some(skill) = library.get_with_connection(connection, skill_id)? else {
        return Err(unreadable(skill_id));
    };
    if skill.lifecycle_status != "active" || !skill.enabled {
        return Err(MemberCapabilityError::with_details(
            "capability.skill_source_unavailable",
            "这个技能已停用或正在删除，请处理后再勾选。",
            json!({ "skillId": skill_id }),
        ));
    }
    library
        .verify_revision_content(&skill.current_revision)
        .map_err(|_| unreadable(skill_id))
}

/// One selected Library-backed Skill, resolved from the member's own choices.
/// Only the immutable revision facts and its admitted root leave this module;
/// the `path` is a Library revision directory, never a caller-supplied location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelectedSource {
    pub id: String,
    pub name: String,
    pub description: String,
    pub revision_id: String,
    pub content_digest: String,
    pub root: PathBuf,
    pub path: PathBuf,
}

/// Every `library:` Skill this member selected. The selection rows are the
/// starting point on purpose: a selected key that lost its registration,
/// revision or content is an error, never a row the catalog join drops.
pub(crate) fn selected_library_sources(
    connection: &Connection,
    agent_id: &str,
) -> Result<Vec<SelectedSource>> {
    let mut statement = connection.prepare(
        "SELECT item_key FROM member_capability_choice
         WHERE agent_id = ?1 AND kind = 'skill' AND selected = 1
           AND substr(item_key, 1, ?2) = ?3
         ORDER BY item_key",
    )?;
    let keys = statement
        .query_map(
            params![agent_id, ID_PREFIX.len() as i64, ID_PREFIX],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut sources = Vec::with_capacity(keys.len());
    for key in keys {
        let skill_id = key.strip_prefix(ID_PREFIX).unwrap_or_default();
        sources.push(selected_source(connection, &key, skill_id)?);
    }
    Ok(sources)
}

fn selected_source(connection: &Connection, key: &str, skill_id: &str) -> Result<SelectedSource> {
    if skill_id.is_empty() {
        return Err(unreadable(skill_id));
    }
    let stored_root: Option<String> = connection
        .query_row(
            "SELECT library_root FROM member_skill_source WHERE skill_id = ?1",
            [skill_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored_root) = stored_root else {
        return Err(MemberCapabilityError::with_details(
            "capability.skill_source_unavailable",
            "这个技能没有注册到成员目录。",
            json!({ "skillId": skill_id }),
        ));
    };
    // The stored root is re-admitted with the same private-directory rules; no
    // caller path is ever consulted.
    let root = admit_library_root(Path::new(&stored_root))?;
    let library = SkillLibraryService::deferred(root.clone());
    require_selectable(connection, &library, skill_id)?;
    let skill = library
        .get_with_connection(connection, skill_id)?
        .ok_or_else(|| unreadable(skill_id))?;
    ensure!(skill.id == skill_id, "Skill source identity changed");
    if PUBLISHED_SKILLS.contains(&skill.name.as_str()) {
        return Err(MemberCapabilityError::with_details(
            "capability.skill_source_unavailable",
            "同名技能与内置技能冲突。",
            json!({ "skillId": skill_id }),
        ));
    }
    let revision_id = skill.current_revision.id.clone();
    let content_digest = skill.current_revision.content_digest.clone();
    let path = library.revision_content_path(skill_id, &revision_id);
    Ok(SelectedSource {
        id: key.to_string(),
        name: skill.name,
        description: skill.current_revision.description,
        revision_id,
        content_digest,
        root,
        path,
    })
}

/// Re-reads one already admitted source after its content was read. A changed
/// revision, digest or Library root is a different source, never a mixed snapshot.
pub(crate) fn verify_selected_source(connection: &Connection, source: &SelectedSource) -> Result<()> {
    let skill_id = source.id.strip_prefix(ID_PREFIX).unwrap_or_default();
    if skill_id.is_empty() {
        return Err(unreadable(skill_id));
    }
    let stored_root: Option<String> = connection
        .query_row(
            "SELECT library_root FROM member_skill_source WHERE skill_id = ?1",
            [skill_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored_root) = stored_root else {
        return Err(unreadable(skill_id));
    };
    let root = admit_library_root(Path::new(&stored_root))?;
    if root != source.root {
        return Err(unreadable(skill_id));
    }
    let library = SkillLibraryService::deferred(root);
    let skill = library
        .get_with_connection(connection, skill_id)?
        .ok_or_else(|| unreadable(skill_id))?;
    if skill.id != skill_id
        || skill.current_revision.id != source.revision_id
        || skill.current_revision.content_digest != source.content_digest
        || library.revision_content_path(skill_id, &source.revision_id) != source.path
    {
        return Err(unreadable(skill_id));
    }
    library
        .verify_revision_content(&skill.current_revision)
        .map_err(|_| unreadable(skill_id))
}

fn unreadable(skill_id: &str) -> anyhow::Error {
    MemberCapabilityError::with_details(
        "capability.skill_source_unavailable",
        "技能内容读不出来或摘要不符，请重新导入。",
        json!({ "skillId": skill_id }),
    )
}

/// Admits the current Library root exactly where it is; never creates, repairs or follows a link.
fn admit_library_root(root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(root).map_err(|_| {
        MemberCapabilityError::new("capability.skill_source_unavailable", "技能库目录不可用。")
    })?;
    if metadata.file_type().is_symlink() {
        return Err(MemberCapabilityError::new(
            "capability.skill_source_unavailable",
            "技能库根不能是链接。",
        ));
    }
    if !metadata.is_dir() {
        return Err(MemberCapabilityError::new(
            "capability.skill_source_unavailable",
            "技能库根不是目录。",
        ));
    }
    #[cfg(windows)]
    let admitted = crate::platform::private_storage::admit_private_directory(root).map_err(|_| {
        MemberCapabilityError::new(
            "capability.skill_source_unavailable",
            "技能库根没有通过私有目录准入。",
        )
    })?;
    #[cfg(not(windows))]
    let admitted = root.canonicalize().map_err(|_| {
        MemberCapabilityError::new("capability.skill_source_unavailable", "技能库目录不可用。")
    })?;
    ensure!(admitted.is_absolute(), "Skill Library root must be absolute");
    Ok(admitted)
}
