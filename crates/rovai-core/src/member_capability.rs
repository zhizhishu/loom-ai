//! Per-member capability catalog: toolbox skills, MCP servers, rule snippets, and hooks.
//!
//! Skills and MCP assignments stay in their existing stores. Rule snippets, hooks, tool-name
//! claims, and whether a choice is inherited or explicit live in the tables from migration 227.
//! Saving a skill or MCP membership is the same write the settings pages already perform, so the
//! next Run's additional skills and MCP file follow the checkboxes. Selected rule bodies
//! are frozen as subordinate user guidance in the per-Run bootstrap. Hooks remain
//! runtime-specific and must not be described as loaded by a read-only projection.

mod hook_review;
mod skill_source;
mod skill_visibility;
#[cfg(test)]
pub(crate) use hook_review::test_remote_scope;
pub(crate) use hook_review::{
    FrozenHookReview, HookDefinitionView, HookReviewApproval, SCHEMA_SQL as HOOK_REVIEW_SCHEMA_SQL,
    frozen_review_digest, schema_matches as hook_review_schema_matches,
    validate_frozen as validate_frozen_hook_reviews,
    validate_frozen_local_scope as validate_frozen_local_hook_scope,
    validate_frozen_scope as validate_frozen_hook_scope,
};
pub(crate) use skill_source::{
    ID_PREFIX as SKILL_SOURCE_ID_PREFIX, SCHEMA_SQL as SKILL_SOURCE_SCHEMA_SQL, SelectedSource,
    schema_matches as skill_source_schema_matches, selected_library_sources,
    verify_selected_source as verify_selected_skill_source,
};

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    agent_profile::{AgentProfileService, AgentProfileView},
    command::{ActorRef, CommandEnvelope, CommandResultStatus, canonical_json_digest},
    current_user::CURRENT_USER_ID,
    db::Database,
    managed_skills::{
        SetToolboxMembersCommand, TOOLBOX_SKILLS, set_toolbox_members, toolbox_skill_version,
    },
    mcp::{McpConfigStore, McpMutationResult, McpRiskLevel, SetMcpMembersParams},
    skill::SkillLibraryService,
};

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE member_capability_item (
    item_id TEXT PRIMARY KEY CHECK(length(item_id) BETWEEN 1 AND 80),
    kind TEXT NOT NULL CHECK(kind IN ('rule','hook')),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 400),
    source_label TEXT NOT NULL CHECK(length(source_label) BETWEEN 1 AND 40),
    scope TEXT NOT NULL CHECK(scope IN ('project','cloud')),
    body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 8000),
    created_at TEXT NOT NULL
);
CREATE TABLE member_capability_choice (
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('skill','mcp','rule','hook')),
    item_key TEXT NOT NULL,
    selected INTEGER NOT NULL CHECK(selected IN (0,1)),
    origin TEXT NOT NULL CHECK(origin IN ('inherited','explicit')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, kind, item_key)
);
CREATE TABLE member_capability_tool_claim (
    kind TEXT NOT NULL CHECK(kind IN ('skill','mcp','rule','hook')),
    item_key TEXT NOT NULL,
    tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 80),
    PRIMARY KEY (kind, item_key, tool_name)
);
"#;

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let compact = |sql: &str| sql.split_whitespace().collect::<String>();
    let holds = |table: &str, tokens: &[&str]| -> rusqlite::Result<bool> {
        let sql: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .optional()?;
        Ok(sql.is_some_and(|sql| {
            let sql = compact(&sql);
            tokens.iter().all(|token| sql.contains(&compact(token)))
        }))
    };
    Ok(holds(
        "member_capability_item",
        &[
            "CHECK(kind IN ('rule','hook'))",
            "CHECK(scope IN ('project','cloud'))",
        ],
    )? && holds(
        "member_capability_choice",
        &[
            "PRIMARY KEY (agent_id, kind, item_key)",
            "CHECK(origin IN ('inherited','explicit'))",
        ],
    )? && holds(
        "member_capability_tool_claim",
        &["PRIMARY KEY (kind, item_key, tool_name)"],
    )?)
}

#[derive(Debug)]
pub(crate) struct MemberCapabilityError {
    code: &'static str,
    message: String,
    details: Value,
}

impl MemberCapabilityError {
    fn new(code: &'static str, message: impl Into<String>) -> anyhow::Error {
        Self::with_details(code, message, json!({}))
    }

    fn with_details(
        code: &'static str,
        message: impl Into<String>,
        details: Value,
    ) -> anyhow::Error {
        anyhow::Error::new(Self {
            code,
            message: message.into(),
            details,
        })
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn details(&self) -> &Value {
        &self.details
    }
}

impl std::fmt::Display for MemberCapabilityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MemberCapabilityError {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberCapabilityIdentity {
    pub display_name: String,
    pub team_role: String,
    pub professional_responsibilities: String,
    pub personality_traits: Vec<String>,
    pub working_principles: String,
    pub growth_topic: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberCapabilityItem {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub note: String,
    pub source: String,
    pub scope: String,
    pub visibility_scope: Option<String>,
    pub selected: bool,
    pub origin: Option<String>,
    pub tool_names: Vec<String>,
    pub risk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_definition: Option<HookDefinitionView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_error: Option<String>,
    // Library stamp participates in the catalog revision only; never a second body store.
    #[serde(skip)]
    pub library: Option<skill_source::Stamp>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberCapabilityCatalog {
    pub agent_id: String,
    pub display_name: String,
    pub team_role: String,
    pub runtime: Option<String>,
    pub revision: String,
    pub identity: MemberCapabilityIdentity,
    pub items: Vec<MemberCapabilityItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectedCapability {
    pub id: String,
    pub name: String,
    pub body: String,
    pub origin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberCapabilityGetParams {
    pub agent_id: String,
    #[serde(default)]
    pub local_camp_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberCapabilitySelection {
    pub kind: String,
    pub id: String,
    pub selected: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberCapabilitySetParams {
    pub agent_id: String,
    #[serde(default)]
    pub local_camp_id: Option<String>,
    pub expected_revision: String,
    #[serde(default)]
    pub acknowledge_high_risk: bool,
    pub selections: Vec<MemberCapabilitySelection>,
    #[serde(default)]
    pub reviewed_hooks: Vec<HookReviewApproval>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberCapabilityPutParams {
    #[serde(default)]
    pub item_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub source_label: Option<String>,
    #[serde(default)]
    pub tool_names: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberCapabilityPutResult {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub tool_names: Vec<String>,
}

#[derive(Clone)]
struct StoredChoice {
    selected: bool,
    origin: String,
}

#[derive(Clone)]
struct CatalogPiece {
    id: String,
    kind: String,
    name: String,
    note: String,
    source: String,
    scope: String,
    body: String,
    tool_names: Vec<String>,
    risk: Option<String>,
    selected: bool,
    stored_origin: Option<String>,
    hook_review: Option<hook_review::StoredReview>,
    hook_scope: Option<hook_review::HookReviewScope>,
}

/// Library stamps are held per catalog item id so existing piece owners stay untouched.
fn library_stamps(database: &Database) -> Result<BTreeMap<String, skill_source::Stamp>> {
    Ok(skill_source::list(database)?
        .into_iter()
        .map(|registered| {
            (
                skill_source::item_id(&registered.skill_id),
                registered.stamp,
            )
        })
        .collect())
}

pub(crate) fn get_member_capability_catalog(
    database: &Database,
    store: &McpConfigStore,
    agent_id: &str,
) -> Result<MemberCapabilityCatalog> {
    get_member_capability_catalog_scoped(database, store, agent_id, None)
}

pub(crate) fn get_member_capability_catalog_scoped(
    database: &Database,
    store: &McpConfigStore,
    agent_id: &str,
    local_camp_id: Option<&str>,
) -> Result<MemberCapabilityCatalog> {
    let profile = require_member(database, agent_id)?;
    let pieces = catalog_pieces_scoped(database, store, &profile, local_camp_id)?;
    let stamps = library_stamps(database)?;
    Ok(catalog_from_pieces(&profile, pieces, &stamps)?)
}

pub(crate) fn set_member_capability_catalog(
    database: &mut Database,
    store: &McpConfigStore,
    library: &SkillLibraryService,
    params: &MemberCapabilitySetParams,
) -> Result<MemberCapabilityCatalog> {
    let profile = require_member(database, &params.agent_id)?;
    let current_pieces =
        catalog_pieces_scoped(database, store, &profile, params.local_camp_id.as_deref())?;
    let current =
        catalog_from_pieces(&profile, current_pieces.clone(), &library_stamps(database)?)?;
    if current.revision != params.expected_revision {
        return Err(MemberCapabilityError::with_details(
            "capability.revision_conflict",
            "目录刚被别人改过，请重新读取后再保存。",
            json!({ "revision": current.revision }),
        ));
    }
    let mut desired = BTreeMap::<(String, String), bool>::new();
    for piece in &current_pieces {
        desired.insert((piece.kind.clone(), piece.id.clone()), piece.selected);
    }
    for selection in &params.selections {
        let key = (selection.kind.clone(), selection.id.clone());
        if !desired.contains_key(&key) {
            return Err(MemberCapabilityError::new(
                "capability.invalid_request",
                format!("目录里没有 {} {}", selection.kind, selection.id),
            ));
        }
        desired.insert(key, selection.selected);
    }
    let mut next = current_pieces.clone();
    for piece in &mut next {
        piece.selected = desired[&(piece.kind.clone(), piece.id.clone())];
    }
    if let Some(tool) = first_conflict(&next) {
        return Err(MemberCapabilityError::with_details(
            "capability.conflict",
            format!("「{tool}」被两条勾选同时占用，这次没有保存。"),
            json!({ "toolName": tool }),
        ));
    }
    if let Some(piece) = newly_selected_high_risk(&current_pieces, &next) {
        if !params.acknowledge_high_risk {
            return Err(risk_error(piece));
        }
    }

    if params.local_camp_id.is_some()
        && next
            .iter()
            .any(|p| p.kind == "hook" && p.selected && p.hook_scope.is_none())
    {
        return Err(MemberCapabilityError::new(
            "capability.local_hook_unsupported",
            "这位队员当前的运行环境还不能执行本地 Hook。",
        ));
    }
    let local_hooks: Vec<_> = next
        .iter()
        .filter(|piece| {
            piece.kind == "hook"
                && piece.selected
                && piece
                    .hook_scope
                    .as_ref()
                    .is_some_and(|scope| scope.is_local())
        })
        .map(|piece| ProjectedCapability {
            id: piece.id.clone(),
            name: piece.name.clone(),
            body: piece.body.clone(),
            origin: "explicit".into(),
        })
        .collect();
    if local_hooks.len() > 1 {
        return Err(MemberCapabilityError::new(
            "capability.local_hook_one_required",
            "本地 Hook 目前一次只能启用一个，请先关闭其他 Hook。",
        ));
    }
    if !local_hooks.is_empty() {
        crate::local_hook::settings(&local_hooks).map_err(|_| {
            MemberCapabilityError::new(
                "capability.local_hook_definition_unsupported",
                "本地 Hook 需要使用 PostToolUse、填写一个具体工具名，并把超时设在 5 秒以内。",
            )
        })?;
    }
    // Exact reviews are checked before the existing external Skill/MCP writes.
    let approved_hooks = hook_review::validate_request(&next, &params.reviewed_hooks)?;
    // The write loop below skips unchanged selections, so admission must cover every selected item here.
    for piece in &next {
        if piece.kind != "skill" || !piece.selected {
            continue;
        }
        if let Some(skill_id) = piece.id.strip_prefix(skill_source::ID_PREFIX) {
            skill_source::require_selectable(database.connection(), library, skill_id)?;
        }
    }
    let known = AgentProfileService::default().all_profile_ids(database)?;
    let mut mcp_view = store.get(&known)?;
    let mut digest = mcp_view.config_digest.clone();
    for piece in &next {
        let was_selected = was_selected(&current_pieces, piece);
        if was_selected == piece.selected {
            continue;
        }
        match piece.kind.as_str() {
            "skill" => {
                // A registered Library Skill is a choice of its own; the toolbox write stays untouched.
                if piece.id.starts_with(skill_source::ID_PREFIX) {
                    continue;
                }
                let mut members = skill_members(database.connection(), &piece.id)?;
                if piece.selected {
                    members.insert(profile.agent_id.clone());
                } else {
                    members.remove(&profile.agent_id);
                }
                let execution = set_toolbox_members(
                    database,
                    &user_envelope(SetToolboxMembersCommand {
                        skill_name: piece.id.clone(),
                        member_ids: members.into_iter().collect(),
                        expected_version: toolbox_skill_version(database.connection(), &piece.id)?,
                    }),
                )?;
                if execution.result.status != CommandResultStatus::Applied {
                    return Err(MemberCapabilityError::new(
                        "capability.toolbox_rejected",
                        format!("工具箱没有写成：{}", execution.result.code),
                    ));
                }
            }
            "mcp" => {
                let Some(server) = mcp_view
                    .servers
                    .iter()
                    .find(|server| server.server_id == piece.id)
                else {
                    return Err(MemberCapabilityError::new(
                        "capability.invalid_request",
                        "这个 MCP 已不在全局定义里。",
                    ));
                };
                let mut members = server
                    .assigned_agent_ids
                    .iter()
                    .filter(|id| known.contains(*id))
                    .cloned()
                    .collect::<BTreeSet<_>>();
                if piece.selected {
                    members.insert(profile.agent_id.clone());
                } else {
                    members.remove(&profile.agent_id);
                }
                match store.set_members(
                    SetMcpMembersParams {
                        expected_config_digest: digest.clone(),
                        server_id: piece.id.clone(),
                        agent_ids: members.into_iter().collect(),
                        acknowledge_high_risk: params.acknowledge_high_risk,
                    },
                    &known,
                )? {
                    McpMutationResult::Ok {
                        config_digest,
                        config,
                        ..
                    } => {
                        digest = config_digest;
                        mcp_view = *config;
                    }
                    McpMutationResult::RiskAcknowledgementRequired { server_id } => {
                        return Err(MemberCapabilityError::with_details(
                            "capability.risk_acknowledgement_required",
                            format!(
                                "MCP「{}」是高风险的。确认之后才会勾给这位队员。",
                                piece.name
                            ),
                            json!({ "serverId": server_id, "name": piece.name }),
                        ));
                    }
                    McpMutationResult::Conflict { .. } => {
                        return Err(MemberCapabilityError::new(
                            "capability.revision_conflict",
                            "MCP 定义刚被别人改过，请重新读取后再保存。",
                        ));
                    }
                    McpMutationResult::Invalid { issues } => {
                        let message = issues
                            .first()
                            .map(|issue| issue.message.clone())
                            .unwrap_or_else(|| "MCP 勾选没有写成。".to_string());
                        return Err(MemberCapabilityError::new(
                            "capability.mcp_rejected",
                            message,
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    let transaction = database.connection().unchecked_transaction()?;
    hook_review::revalidate_before_write(
        &transaction,
        &profile.agent_id,
        &next,
        &params.reviewed_hooks,
        params.local_camp_id.as_deref(),
    )?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for piece in &next {
        if was_selected(&current_pieces, piece) == piece.selected {
            continue;
        }
        sync_choice(
            &transaction,
            &profile.agent_id,
            &piece.kind,
            &piece.id,
            piece.selected,
            if piece.kind == "hook" && piece.hook_scope.as_ref().is_some_and(|s| s.is_local()) {
                false
            } else {
                default_selected(&piece.kind, &piece.scope, &piece.id)
            },
            &now,
        )?;
    }
    hook_review::persist(
        &transaction,
        &profile.agent_id,
        &next,
        &approved_hooks,
        &params.expected_revision,
        &now,
    )?;
    transaction.commit()?;
    get_member_capability_catalog_scoped(
        database,
        store,
        &profile.agent_id,
        params.local_camp_id.as_deref(),
    )
}

pub(crate) fn put_capability_item(
    database: &Database,
    store: &McpConfigStore,
    library: &SkillLibraryService,
    params: &MemberCapabilityPutParams,
) -> Result<MemberCapabilityPutResult> {
    let tool_names = normalize_tool_names(&params.tool_names)?;
    let kind = params.kind.as_str();
    let (id, name) = match kind {
        "rule" | "hook" => upsert_snippet(database.connection(), kind, params)?,
        "skill" => {
            let id = required_item_id(params, "技能名称不能为空。")?;
            if let Some(skill_id) = id.strip_prefix(skill_source::ID_PREFIX) {
                skill_source::register(database, library, skill_id)?
            } else if TOOLBOX_SKILLS.contains(&id.as_str()) {
                (id.clone(), id)
            } else {
                return Err(MemberCapabilityError::new(
                    "capability.invalid_request",
                    "这不是工具箱里的技能。",
                ));
            }
        }
        "mcp" => {
            let id = required_item_id(params, "MCP 需要 server id。")?;
            let known = AgentProfileService::default().all_profile_ids(database)?;
            let view = store.get(&known)?;
            let server = view
                .servers
                .iter()
                .find(|server| server.server_id == id)
                .ok_or_else(|| {
                    MemberCapabilityError::new(
                        "capability.invalid_request",
                        "没有这个 MCP 服务器。",
                    )
                })?;
            (id, server.name.clone())
        }
        _ => {
            return Err(MemberCapabilityError::new(
                "capability.invalid_request",
                "kind 只能是 skill、mcp、rule 或 hook。",
            ));
        }
    };
    replace_claims(database.connection(), kind, &id, &tool_names)?;
    Ok(MemberCapabilityPutResult {
        id,
        kind: kind.to_string(),
        name,
        tool_names,
    })
}

pub(crate) fn projection_additions(
    database: &Database,
    store: &McpConfigStore,
    agent_id: &str,
) -> Result<(
    Vec<ProjectedCapability>,
    Vec<ProjectedCapability>,
    Vec<ProjectedCapability>,
)> {
    let profile = require_member(database, agent_id)?;
    let pieces = catalog_pieces(database, store, &profile)?;
    let project = |kind: &str| {
        pieces
            .iter()
            .filter(|piece| piece.kind == kind && piece.selected)
            .map(|piece| ProjectedCapability {
                id: piece.id.clone(),
                name: piece.name.clone(),
                body: piece.body.clone(),
                origin: display_origin(piece).unwrap_or_else(|| "explicit".to_string()),
            })
            .collect::<Vec<_>>()
    };
    Ok((project("skill"), project("rule"), project("hook")))
}

/// The rules this member has selected, read from the capability store alone.
///
/// It deliberately needs no `McpConfigStore`: rules are explicit catalog items
/// plus per-member choices. Selection and origin follow exactly the same truth
/// as [`catalog_pieces`]: a stored choice wins, otherwise [`default_selected`]
/// decides, and `origin` mirrors [`display_origin`]. Deterministic order keeps
/// the composed charter byte-stable.
pub(crate) fn selected_rules(
    connection: &Connection,
    agent_id: &str,
) -> Result<Vec<ProjectedCapability>> {
    let choices = load_choices(connection, agent_id)?;
    let mut statement = connection.prepare(
        "SELECT item_id, name, scope, body FROM member_capability_item\n         WHERE kind='rule' ORDER BY name, item_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut rules = Vec::new();
    for row in rows {
        let (id, name, scope, body) = row?;
        let stored = choices.get(&("rule".to_string(), id.clone()));
        let inherited = default_selected("rule", &scope, &id);
        let selected = stored.map(|choice| choice.selected).unwrap_or(inherited);
        if !selected {
            continue;
        }
        let origin = stored
            .map(|choice| choice.origin.clone())
            .unwrap_or_else(|| if inherited { "inherited" } else { "explicit" }.to_string());
        rules.push(ProjectedCapability {
            id,
            name,
            body,
            origin,
        });
    }
    Ok(rules)
}

pub(crate) fn frozen_hook_reviews(
    database: &Database,
    store: &McpConfigStore,
    agent_id: &str,
) -> Result<Vec<FrozenHookReview>> {
    anyhow::ensure!(
        !database.connection().is_autocommit(),
        "hook_review_transaction_required"
    );
    let profile = require_member(database, agent_id)?;
    hook_review::freeze(&catalog_pieces(database, store, &profile)?)
}

fn catalog_pieces(
    database: &Database,
    store: &McpConfigStore,
    profile: &AgentProfileView,
) -> Result<Vec<CatalogPiece>> {
    catalog_pieces_scoped(database, store, profile, None)
}
fn catalog_pieces_scoped(
    database: &Database,
    store: &McpConfigStore,
    profile: &AgentProfileView,
    local_camp_id: Option<&str>,
) -> Result<Vec<CatalogPiece>> {
    let connection = database.connection();
    let choices = load_choices(connection, &profile.agent_id)?;
    let has_hooks: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM member_capability_item WHERE kind='hook')",
        [],
        |r| r.get(0),
    )?;
    let hook_scope = if has_hooks {
        hook_review::current_scope_for_camp(connection, &profile.agent_id, local_camp_id)?
    } else {
        None
    };
    let reviews = hook_review::load(connection, &profile.agent_id, hook_scope.as_ref())?;
    let claims = load_claims(connection)?;
    let known = AgentProfileService::default().all_profile_ids(database)?;
    let mcp = store.get(&known)?;
    let mut pieces = Vec::new();
    for name in TOOLBOX_SKILLS {
        let id = (*name).to_string();
        let members = skill_members(connection, &id)?;
        let stored = choices.get(&("skill".to_string(), id.clone())).cloned();
        pieces.push(CatalogPiece {
            id: id.clone(),
            kind: "skill".to_string(),
            name: id.clone(),
            note: skill_note(name).to_string(),
            source: "工具箱".to_string(),
            scope: "cloud".to_string(),
            body: skill_note(name).to_string(),
            tool_names: claims
                .get(&("skill".to_string(), id.clone()))
                .cloned()
                .unwrap_or_default(),
            risk: None,
            selected: members.contains(&profile.agent_id),
            stored_origin: stored.map(|choice| choice.origin),
            hook_review: None,
            hook_scope: None,
        });
    }
    // Registered imported Skills are extra catalog rows; the toolbox list above is unchanged.
    for registered in skill_source::list(database)? {
        if !skill_visibility::is_visible_to_agent(
            registered.stamp.owner_agent_id.as_deref(), &registered.stamp.visibility_scope, &profile.agent_id
        ) { continue; }
        let id = skill_source::item_id(&registered.skill_id);
        let stored = choices.get(&("skill".to_string(), id.clone())).cloned();
        pieces.push(CatalogPiece {
            tool_names: claims
                .get(&("skill".to_string(), id.clone()))
                .cloned()
                .unwrap_or_default(),
            hook_review: None,
            hook_scope: None,
            id,
            kind: "skill".to_string(),
            name: registered.name,
            note: registered.description.clone(),
            source: "导入技能".to_string(),
            scope: "cloud".to_string(),
            body: registered.description,
            risk: None,
            selected: stored.as_ref().is_some_and(|choice| choice.selected),
            stored_origin: stored.map(|choice| choice.origin),
        });
    }
    for server in &mcp.servers {
        let stored = choices
            .get(&("mcp".to_string(), server.server_id.clone()))
            .cloned();
        pieces.push(CatalogPiece {
            id: server.server_id.clone(),
            kind: "mcp".to_string(),
            name: server.name.clone(),
            note: server.endpoint.clone(),
            source: "全局定义".to_string(),
            scope: "cloud".to_string(),
            body: server.endpoint.clone(),
            tool_names: claims
                .get(&("mcp".to_string(), server.server_id.clone()))
                .cloned()
                .unwrap_or_default(),
            risk: (server.risk_level == McpRiskLevel::High).then_some("high".to_string()),
            selected: server
                .assigned_agent_ids
                .iter()
                .any(|id| id == &profile.agent_id),
            stored_origin: stored.map(|choice| choice.origin),
            hook_review: None,
            hook_scope: None,
        });
    }
    let mut statement = connection.prepare(
        "SELECT item_id, kind, name, note, source_label, scope, body
         FROM member_capability_item ORDER BY kind, name, item_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    for row in rows {
        let (id, kind, name, note, source, scope, body) = row?;
        let stored = choices.get(&(kind.clone(), id.clone())).cloned();
        let selected = stored
            .as_ref()
            .map(|choice| choice.selected)
            .unwrap_or_else(|| {
                if kind == "hook"
                    && local_camp_id.is_some()
                    && !matches!(
                        hook_scope.as_ref(),
                        Some(hook_review::HookReviewScope::Remote(_))
                    )
                {
                    false
                } else {
                    default_selected(&kind, &scope, &id)
                }
            });
        let risk = ((kind == "hook" && hook_scope.is_some()) || hook_runs_shell(&kind, &body))
            .then_some("high".to_string());
        pieces.push(CatalogPiece {
            tool_names: claims
                .get(&(kind.clone(), id.clone()))
                .cloned()
                .unwrap_or_default(),
            hook_review: if kind == "hook" {
                reviews.get(&id).cloned()
            } else {
                None
            },
            hook_scope: if kind == "hook" {
                hook_scope.clone()
            } else {
                None
            },
            id,
            kind,
            name,
            note,
            source,
            scope,
            body,
            risk,
            selected,
            stored_origin: stored.map(|choice| choice.origin),
        });
    }
    Ok(pieces)
}

/// Read only Hook definitions/choices/reviews inside the claim transaction.
pub(crate) fn freeze_local_hooks(
    connection: &Connection,
    agent_id: &str,
    scope: &crate::local_hook::LocalHookScope,
) -> Result<(Vec<ProjectedCapability>, Vec<FrozenHookReview>)> {
    let scoped = hook_review::HookReviewScope::Local(scope.clone());
    let reviews = hook_review::load(connection, agent_id, Some(&scoped))?;
    let claims = load_claims(connection)?;
    let mut stmt = connection.prepare(
        "SELECT i.item_id,i.name,i.note,i.source_label,i.scope,i.body
         FROM member_capability_item i JOIN member_capability_choice c
           ON c.kind='hook' AND c.item_key=i.item_id AND c.agent_id=?1 AND c.selected=1
         WHERE i.kind='hook' ORDER BY i.item_id",
    )?;
    let rows = stmt.query_map([agent_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut pieces = Vec::new();
    for row in rows {
        let (id, name, note, source, item_scope, body) = row?;
        pieces.push(CatalogPiece {
            tool_names: claims
                .get(&("hook".to_owned(), id.clone()))
                .cloned()
                .unwrap_or_default(),
            hook_review: reviews.get(&id).cloned(),
            hook_scope: Some(scoped.clone()),
            id,
            kind: "hook".into(),
            name,
            note,
            source,
            scope: item_scope,
            body,
            risk: Some("high".into()),
            selected: true,
            stored_origin: Some("explicit".into()),
        });
    }
    let frozen = hook_review::freeze(&pieces)?;
    let hooks = pieces
        .into_iter()
        .map(|p| ProjectedCapability {
            id: p.id,
            name: p.name,
            body: p.body,
            origin: "explicit".into(),
        })
        .collect();
    Ok((hooks, frozen))
}

fn catalog_from_pieces(
    profile: &AgentProfileView,
    mut pieces: Vec<CatalogPiece>,
    stamps: &BTreeMap<String, skill_source::Stamp>,
) -> Result<MemberCapabilityCatalog> {
    pieces.sort_by(|left, right| {
        kind_rank(&left.kind)
            .cmp(&kind_rank(&right.kind))
            .then(left.name.cmp(&right.name))
            .then(left.id.cmp(&right.id))
    });
    let items = pieces
        .iter()
        .map(|piece| {
            Ok(MemberCapabilityItem {
                id: piece.id.clone(),
                kind: piece.kind.clone(),
                name: piece.name.clone(),
                note: piece.note.clone(),
                source: piece.source.clone(),
                scope: piece.scope.clone(),
                visibility_scope: stamps.get(&piece.id).map(|s| s.visibility_scope.clone()),
                selected: piece.selected,
                origin: display_origin(piece),
                tool_names: piece.tool_names.clone(),
                risk: piece.risk.clone(),
                hook_definition: hook_review::view(piece)?,
                source_error: stamps
                    .get(&piece.id)
                    .and_then(skill_source::stamp_source_error),
                library: stamps.get(&piece.id).cloned(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let revision = canonical_json_digest(&json!(
        items
            .iter()
            .map(|item| {
                let mut state = json!({
                    "id":item.id, "kind":item.kind, "origin":item.origin, "selected":item.selected,
                });
                if let Some(stamp) = &item.library {
                    state["libraryRevision"] = json!(stamp.revision_id);
                    state["libraryDigest"] = json!(stamp.content_digest);
                    state["libraryEnabled"] = json!(stamp.enabled);
                    state["libraryLifecycle"] = json!(stamp.lifecycle_status);
                    state["libraryRootDigest"] = json!(stamp.root_digest);
                    state["skillVisibility"] = json!(stamp.visibility_scope);
                    state["skillOwner"] = json!(stamp.owner_agent_id);
                }
                if let Some(definition) = &item.hook_definition {
                    state["hookDefinitionDigest"] = json!(definition.definition_digest);
                    state["hookReviewed"] = json!(definition.reviewed);
                    state["hookScopeDigest"] = json!(definition.scope_digest);
                }
                state
            })
            .collect::<Vec<_>>()
    ))?;
    Ok(MemberCapabilityCatalog {
        agent_id: profile.agent_id.clone(),
        display_name: profile.display_name.clone(),
        team_role: profile.team_role.clone(),
        runtime: profile
            .execution_availability
            .adapter_kind
            .map(|adapter| adapter.as_str().to_string()),
        revision,
        identity: MemberCapabilityIdentity {
            display_name: profile.display_name.clone(),
            team_role: profile.team_role.clone(),
            professional_responsibilities: profile.professional_responsibilities.clone(),
            personality_traits: profile.personality_traits.clone(),
            working_principles: profile.working_principles.clone(),
            growth_topic: profile.growth_topic.clone(),
        },
        items,
    })
}

fn upsert_snippet(
    connection: &Connection,
    kind: &str,
    params: &MemberCapabilityPutParams,
) -> Result<(String, String)> {
    let name = params
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            MemberCapabilityError::new("capability.invalid_request", "规则或 hook 需要名称。")
        })?;
    if name.chars().count() > 120 {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "名称太长。",
        ));
    }
    let scope = params.scope.as_deref().unwrap_or("cloud");
    if scope != "project" && scope != "cloud" {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "scope 只能是 project 或 cloud。",
        ));
    }
    let id = match params
        .item_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => validate_item_id(id)?.to_string(),
        None => format!("{kind}_{}", Uuid::new_v4().simple()),
    };
    let note = params.note.as_deref().unwrap_or("").trim();
    let body = params.body.as_deref().unwrap_or("");
    if note.chars().count() > 400 || body.chars().count() > 8000 {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "说明或正文太长。",
        ));
    }
    let source = params
        .source_label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(if kind == "rule" {
            "规则目录"
        } else {
            "hook 目录"
        });
    if source.chars().count() > 40 {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "来源名称太长。",
        ));
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    connection.execute(
        "INSERT INTO member_capability_item(
            item_id, kind, name, note, source_label, scope, body, created_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(item_id) DO UPDATE SET
            kind=excluded.kind, name=excluded.name, note=excluded.note,
            source_label=excluded.source_label, scope=excluded.scope, body=excluded.body",
        params![id, kind, name, note, source, scope, body, now],
    )?;
    Ok((id, name.to_string()))
}

fn required_item_id(params: &MemberCapabilityPutParams, message: &str) -> Result<String> {
    params
        .item_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            MemberCapabilityError::new("capability.invalid_request", message.to_string())
        })
}

fn validate_item_id(id: &str) -> Result<&str> {
    if (1..=80).contains(&id.chars().count())
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        Ok(id)
    } else {
        Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "条目 id 只能使用字母、数字、下划线和连字符。",
        ))
    }
}

fn normalize_tool_names(names: &[String]) -> Result<Vec<String>> {
    let mut tools = BTreeSet::new();
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if name.chars().count() > 80
            || !name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
            })
        {
            return Err(MemberCapabilityError::new(
                "capability.invalid_request",
                format!("工具名「{name}」无效。"),
            ));
        }
        tools.insert(name.to_string());
    }
    if tools.len() > 16 {
        return Err(MemberCapabilityError::new(
            "capability.invalid_request",
            "一条目录最多占用 16 个工具名。",
        ));
    }
    Ok(tools.into_iter().collect())
}

fn replace_claims(
    connection: &Connection,
    kind: &str,
    item_key: &str,
    tool_names: &[String],
) -> Result<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "DELETE FROM member_capability_tool_claim WHERE kind=?1 AND item_key=?2",
        params![kind, item_key],
    )?;
    for tool_name in tool_names {
        transaction.execute(
            "INSERT INTO member_capability_tool_claim(kind, item_key, tool_name) VALUES(?1,?2,?3)",
            params![kind, item_key, tool_name],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn sync_choice(
    connection: &Connection,
    agent_id: &str,
    kind: &str,
    item_key: &str,
    selected: bool,
    default_selected: bool,
    now: &str,
) -> Result<()> {
    let stored_origin: Option<String> = connection
        .query_row(
            "SELECT origin FROM member_capability_choice
             WHERE agent_id=?1 AND kind=?2 AND item_key=?3",
            params![agent_id, kind, item_key],
            |row| row.get(0),
        )
        .optional()?;
    let back_to_default =
        selected == default_selected && stored_origin.as_deref() != Some("inherited");
    if back_to_default {
        connection.execute(
            "DELETE FROM member_capability_choice WHERE agent_id=?1 AND kind=?2 AND item_key=?3",
            params![agent_id, kind, item_key],
        )?;
        return Ok(());
    }
    connection.execute(
        "INSERT INTO member_capability_choice(agent_id, kind, item_key, selected, origin, updated_at)
         VALUES(?1,?2,?3,?4,'explicit',?5)
         ON CONFLICT(agent_id, kind, item_key) DO UPDATE SET
            selected=excluded.selected, origin='explicit', updated_at=excluded.updated_at",
        params![agent_id, kind, item_key, selected, now],
    )?;
    Ok(())
}

fn load_choices(
    connection: &Connection,
    agent_id: &str,
) -> Result<BTreeMap<(String, String), StoredChoice>> {
    let mut statement = connection.prepare(
        "SELECT kind, item_key, selected, origin FROM member_capability_choice WHERE agent_id=?1",
    )?;
    let rows = statement.query_map([agent_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)? == 1,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut choices = BTreeMap::new();
    for row in rows {
        let (kind, item_key, selected, origin) = row?;
        choices.insert((kind, item_key), StoredChoice { selected, origin });
    }
    Ok(choices)
}

fn load_claims(connection: &Connection) -> Result<BTreeMap<(String, String), Vec<String>>> {
    let mut statement = connection.prepare(
        "SELECT kind, item_key, tool_name FROM member_capability_tool_claim ORDER BY tool_name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut claims = BTreeMap::<(String, String), Vec<String>>::new();
    for row in rows {
        let (kind, item_key, tool_name) = row?;
        claims.entry((kind, item_key)).or_default().push(tool_name);
    }
    Ok(claims)
}

fn skill_members(connection: &Connection, name: &str) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare(
        "SELECT agent_id FROM member_toolbox_skill WHERE skill_name=?1 ORDER BY agent_id",
    )?;
    let rows = statement.query_map([name], |row| row.get::<_, String>(0))?;
    let mut members = BTreeSet::new();
    for row in rows {
        members.insert(row?);
    }
    Ok(members)
}

fn require_member(database: &Database, agent_id: &str) -> Result<AgentProfileView> {
    let agent_id = agent_id.trim();
    if agent_id.is_empty() {
        return Err(MemberCapabilityError::new(
            "capability.member_not_found",
            "需要队员 id。",
        ));
    }
    AgentProfileService::default()
        .list_profiles(database)?
        .into_iter()
        .find(|profile| profile.agent_id == agent_id)
        .ok_or_else(|| MemberCapabilityError::new("capability.member_not_found", "没有这位队员。"))
}

fn default_selected(kind: &str, scope: &str, id: &str) -> bool {
    // New members receive member-studio from the toolbox trigger. Other toolbox
    // skills start unchecked. Project snippets start on; cloud snippets start off.
    match (kind, scope, id) {
        ("skill", _, "member-studio") => true,
        ("rule" | "hook", "project", _) => true,
        _ => false,
    }
}

fn display_origin(piece: &CatalogPiece) -> Option<String> {
    if let Some(origin) = &piece.stored_origin {
        return Some(origin.clone());
    }
    if !piece.selected {
        return None;
    }
    if default_selected(&piece.kind, &piece.scope, &piece.id) {
        Some("inherited".to_string())
    } else {
        Some("explicit".to_string())
    }
}

fn first_conflict(pieces: &[CatalogPiece]) -> Option<String> {
    let mut owners = BTreeMap::<String, usize>::new();
    for piece in pieces.iter().filter(|piece| piece.selected) {
        for tool in &piece.tool_names {
            *owners.entry(tool.clone()).or_default() += 1;
        }
    }
    owners
        .into_iter()
        .find(|(_, count)| *count > 1)
        .map(|(tool, _)| tool)
}

fn newly_selected_high_risk<'a>(
    current: &'a [CatalogPiece],
    next: &'a [CatalogPiece],
) -> Option<&'a CatalogPiece> {
    next.iter().find(|piece| {
        (piece.kind != "hook" || piece.hook_scope.is_none())
            && piece.risk.as_deref() == Some("high")
            && piece.selected
            && !was_selected(current, piece)
    })
}

fn was_selected(current: &[CatalogPiece], piece: &CatalogPiece) -> bool {
    current
        .iter()
        .any(|item| item.kind == piece.kind && item.id == piece.id && item.selected)
}

fn risk_error(piece: &CatalogPiece) -> anyhow::Error {
    let message = if piece.kind == "hook" {
        format!(
            "hook「{}」会执行命令。确认之后才会勾给这位队员。",
            piece.name
        )
    } else {
        format!(
            "MCP「{}」是高风险的。确认之后才会勾给这位队员。",
            piece.name
        )
    };
    MemberCapabilityError::with_details(
        "capability.risk_acknowledgement_required",
        message,
        json!({ "kind": piece.kind, "id": piece.id, "name": piece.name }),
    )
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "skill" => 0,
        "mcp" => 1,
        "rule" => 2,
        "hook" => 3,
        _ => 4,
    }
}

fn skill_note(name: &str) -> &'static str {
    match name {
        "campfire" => "多人讨论，对照方案",
        "grill-duo" => "两人质询一份计划",
        "grill-duo-with-docs" => "质询并维护已确认的文档",
        "member-studio" => "创建队员",
        "review-duo" => "两名队员独立看一份改动",
        _ => "",
    }
}

fn hook_runs_shell(kind: &str, body: &str) -> bool {
    if kind != "hook" {
        return false;
    }
    let body = body.trim();
    if body.is_empty() {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    body.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        line.starts_with("command:")
            || line.starts_with("command ")
            || line.starts_with("bash ")
            || line.starts_with("sh ")
            || line.starts_with("zsh ")
            || line.starts_with("/bin/")
            || line.starts_with("cmd.exe")
            || line.starts_with("powershell")
            || line.starts_with("pwsh ")
    }) || lower.contains("bash -c")
        || lower.contains("sh -c")
        || lower.contains("/bin/sh")
        || lower.contains("/bin/bash")
}

fn user_envelope<P>(payload: P) -> CommandEnvelope<P> {
    CommandEnvelope {
        command_id: Uuid::new_v4().to_string(),
        actor: ActorRef::User {
            user_id: CURRENT_USER_ID.to_string(),
        },
        camp_id: None,
        expected_versions: Vec::new(),
        execution_epoch: None,
        payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{self, render_session_bootstrap};
    use crate::skill::{CommitSkillImportCommand, SetSkillEnabledCommand};
    use std::path::{Path, PathBuf};

    fn write_skill_folder(root: &Path, name: &str, body: &str) -> PathBuf {
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Fixture {name}\n---\n\n{body}\n"),
        )
        .unwrap();
        path
    }
    use crate::mcp::{
        CreateMcpServerParams, MCP_SCHEMA_VERSION, McpConfigFile, McpConfigStore, McpRiskLevel,
        McpRovaiMetadata, McpServerDefinition, McpServerMetadata, McpServerSource,
    };
    use std::fs;

    fn capability_code(error: anyhow::Error) -> &'static str {
        error
            .downcast_ref::<MemberCapabilityError>()
            .unwrap_or_else(|| panic!("{error:#}"))
            .code()
    }

    fn exact_review(catalog: &MemberCapabilityCatalog, id: &str) -> HookReviewApproval {
        let item = catalog
            .items
            .iter()
            .find(|item| item.kind == "hook" && item.id == id)
            .unwrap();
        let definition = item
            .hook_definition
            .as_ref()
            .expect("full review definition");
        HookReviewApproval {
            id: id.to_owned(),
            definition_digest: definition.definition_digest.clone(),
            scope_digest: definition.scope_digest.clone(),
        }
    }

    fn applied_digest(result: McpMutationResult) -> (String, crate::mcp::McpConfigView) {
        match result {
            McpMutationResult::Ok {
                config_digest,
                config,
                ..
            } => (config_digest, *config),
            other => panic!("mcp mutation failed: {other:?}"),
        }
    }

    #[test]
    fn selected_rules_match_the_projected_selection_truth() {
        let directory =
            std::env::temp_dir().join(format!("rovai-selected-rules-{}", Uuid::new_v4()));
        let directory =
            crate::platform::private_storage::prepare_private_directory(&directory).unwrap();
        let database = Database::open(&directory).unwrap();
        let store = McpConfigStore::new(directory.join("mcp.json"));
        let library = SkillLibraryService::new(directory.join("skill-library")).unwrap();
        let profile = AgentProfileService::default()
            .list_profiles(&database)
            .unwrap()
            .into_iter()
            .next()
            .expect("fresh database has a member");
        let agent_id = profile.agent_id.clone();
        for (id, name, scope, body) in [
            ("rule_project", "项目规则", "project", "先读再改。"),
            ("rule_cloud", "云端规则", "cloud", "提交前核对证据。"),
        ] {
            put_capability_item(
                &database,
                &store,
                &library,
                &MemberCapabilityPutParams {
                    item_id: Some(id.to_string()),
                    kind: "rule".to_string(),
                    name: Some(name.to_string()),
                    note: None,
                    scope: Some(scope.to_string()),
                    body: Some(body.to_string()),
                    source_label: None,
                    tool_names: Vec::new(),
                },
            )
            .unwrap();
        }

        // The project rule is selected by the existing inherited default; the
        // cloud rule stays off until the user selects it.
        let rules = selected_rules(database.connection(), &agent_id).unwrap();
        assert_eq!(
            rules
                .iter()
                .map(|rule| rule.id.as_str())
                .collect::<Vec<_>>(),
            ["rule_project"]
        );
        assert_eq!(rules[0].origin, "inherited");

        // The Run projection must show exactly the same set, body and origin.
        let (_, projected, _) = projection_additions(&database, &store, &agent_id).unwrap();
        assert_eq!(
            rules
                .iter()
                .map(|rule| (rule.id.clone(), rule.body.clone(), rule.origin.clone()))
                .collect::<Vec<_>>(),
            projected
                .iter()
                .map(|rule| (rule.id.clone(), rule.body.clone(), rule.origin.clone()))
                .collect::<Vec<_>>(),
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn selection_keeps_inherited_defaults_records_explicit_overrides_and_projects_them() {
        let directory =
            std::env::temp_dir().join(format!("rovai-member-capability-{}", Uuid::new_v4()));
        let directory =
            crate::platform::private_storage::prepare_private_directory(&directory).unwrap();
        let mut database = Database::open(&directory).unwrap();
        let store = McpConfigStore::new(directory.join("mcp.json"));
        let library = SkillLibraryService::new(directory.join("skill-library")).unwrap();
        let profile = AgentProfileService::default()
            .list_profiles(&database)
            .unwrap()
            .into_iter()
            .next()
            .expect("fresh database has a member");
        let agent_id = profile.agent_id.clone();

        // A fixture-unique marker keeps this rule unambiguous: no product
        // sentence, default note, or charter line can collide with it.
        const RULE_NAME: &str = "只读工作区";
        const RULE_BODY: &str = "RULE_SELECTION_MARKER 不要写工作区。";
        const RULE_MARKER: &str = "RULE_SELECTION_MARKER";

        let rule = put_capability_item(
            &database,
            &store,
            &library,
            &MemberCapabilityPutParams {
                item_id: Some("rule_readonly".to_string()),
                kind: "rule".to_string(),
                name: Some(RULE_NAME.to_string()),
                note: Some("样例片段".to_string()),
                scope: Some("project".to_string()),
                body: Some(RULE_BODY.to_string()),
                source_label: None,
                tool_names: vec!["read_file".to_string()],
            },
        )
        .unwrap();
        let hook = put_capability_item(
            &database,
            &store,
            &library,
            &MemberCapabilityPutParams {
                item_id: Some("hook_format".to_string()),
                kind: "hook".to_string(),
                name: Some("format-on-stop".to_string()),
                note: Some("样例 hook".to_string()),
                scope: Some("cloud".to_string()),
                body: Some("stop: format".to_string()),
                source_label: None,
                tool_names: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(rule.id, "rule_readonly");
        assert_eq!(hook.id, "hook_format");

        let known = AgentProfileService::default()
            .all_profile_ids(&database)
            .unwrap();
        let (digest, view) =
            applied_digest(
                store
                    .create(
                        CreateMcpServerParams {
                            expected_config_digest: store.get(&known).unwrap().config_digest,
                            definition_json:
                                r#"{"mcpServers":{"git":{"command":"git","args":["mcp"]}}}"#
                                    .to_string(),
                        },
                        &known,
                    )
                    .unwrap(),
            );
        let git_id = view
            .servers
            .iter()
            .find(|server| server.name == "git")
            .unwrap()
            .server_id
            .clone();
        let _ = digest;
        put_capability_item(
            &database,
            &store,
            &library,
            &MemberCapabilityPutParams {
                item_id: Some(git_id.clone()),
                kind: "mcp".to_string(),
                name: None,
                note: None,
                scope: None,
                body: None,
                source_label: None,
                tool_names: vec!["read_file".to_string()],
            },
        )
        .unwrap();

        let catalog = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let item = |kind: &str, id: &str| {
            catalog
                .items
                .iter()
                .find(|item| item.kind == kind && item.id == id)
                .unwrap_or_else(|| panic!("missing {kind} {id}"))
                .clone()
        };
        let campfire = item("skill", "campfire");
        assert!(!campfire.selected && campfire.origin.is_none());
        let studio = item("skill", "member-studio");
        assert!(studio.selected && studio.origin.as_deref() == Some("inherited"));
        let readonly = item("rule", "rule_readonly");
        assert!(readonly.selected && readonly.origin.as_deref() == Some("inherited"));
        let format_hook = item("hook", "hook_format");
        assert!(!format_hook.selected && format_hook.origin.is_none());

        let mut selections = catalog
            .items
            .iter()
            .map(|item| MemberCapabilitySelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
                selected: item.selected,
            })
            .collect::<Vec<_>>();
        for selection in &mut selections {
            if selection.kind == "skill" && selection.id == "member-studio" {
                selection.selected = false;
            }
            if selection.kind == "skill" && selection.id == "campfire" {
                selection.selected = true;
            }
            if selection.id == "hook_format" {
                selection.selected = true;
            }
        }
        let saved = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: selections.clone(),
            },
        )
        .unwrap();
        let saved_item = |kind: &str, id: &str| {
            saved
                .items
                .iter()
                .find(|item| item.kind == kind && item.id == id)
                .unwrap()
                .clone()
        };
        let studio = saved_item("skill", "member-studio");
        assert!(!studio.selected && studio.origin.as_deref() == Some("explicit"));
        assert!(saved_item("skill", "campfire").origin.as_deref() == Some("explicit"));
        assert!(saved_item("skill", "campfire").selected);
        assert!(
            saved_item("hook", "hook_format").selected
                && saved_item("hook", "hook_format").origin.as_deref() == Some("explicit")
        );
        let choice: (i64, String) = database
            .connection()
            .query_row(
                "SELECT selected, origin FROM member_capability_choice
                 WHERE agent_id=?1 AND kind='skill' AND item_key='member-studio'",
                [&agent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(choice, (0, "explicit".to_string()));

        let stale = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: selections.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(capability_code(stale), "capability.revision_conflict");

        for selection in &mut selections {
            if selection.id == git_id {
                selection.selected = true;
            }
        }
        let conflict = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: saved.revision.clone(),
                acknowledge_high_risk: false,
                selections,
            },
        )
        .unwrap_err();
        assert_eq!(capability_code(conflict), "capability.conflict");
        let after_conflict = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        assert_eq!(after_conflict.revision, saved.revision);
        assert!(
            !after_conflict
                .items
                .iter()
                .any(|item| item.id == git_id && item.selected)
        );

        let (skills, rules, hooks) = projection_additions(&database, &store, &agent_id).unwrap();
        assert!(
            skills
                .iter()
                .any(|skill| skill.id == "campfire" && skill.origin == "explicit")
        );
        assert!(skills.iter().all(|skill| skill.id != "member-studio"));
        assert!(
            rules
                .iter()
                .any(|rule| rule.id == "rule_readonly" && rule.name == RULE_NAME)
        );
        assert!(
            hooks
                .iter()
                .any(|hook| hook.name == "format-on-stop" && hook.origin == "explicit")
        );

        let parts = context::member_projection_bootstrap(
            &database,
            &directory,
            &agent_id,
            crate::agent_profile::AdapterKind::CodexCli,
        )
        .unwrap();
        let bootstrap = render_session_bootstrap(
            &parts.charter,
            &parts.identity,
            parts.team_guidance.as_deref(),
            parts.platform_skills.as_deref(),
            &parts.memory_entrypoint,
        )
        .unwrap();
        let preview = crate::run_projection::preview_member_run_projection(
            &database,
            &directory,
            &store,
            &crate::run_projection::MemberRunProjectionParams {
                member: agent_id.clone(),
                runtime: Some("codex-cli".to_string()),
            },
        )
        .unwrap();
        assert_eq!(preview.bootstrap, bootstrap);
        // A selected rule is user-layer guidance inside the bounded
        // [SELECTED_ASSISTANT_RULES] section of the frozen charter, so the preview
        // bootstrap must quote its body exactly once and nowhere else.
        let (charter_head, rules_section) = preview
            .bootstrap
            .split_once("[SELECTED_ASSISTANT_RULES]")
            .expect("the preview bootstrap carries the selected-rules section");
        assert!(!charter_head.contains(RULE_MARKER));
        assert_eq!(rules_section.matches(RULE_MARKER).count(), 1);
        assert_eq!(preview.rules, rules);
        assert_eq!(preview.hooks, hooks);
        assert_eq!(preview.skills, skills);

        // Same owner case, the negative direction: an explicit unselect through
        // the real catalog write keeps every other choice, yet both the rules
        // projection and the next preview lose the body.
        let selected_catalog = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let deselected = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: selected_catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: selected_catalog
                    .items
                    .iter()
                    .map(|item| MemberCapabilitySelection {
                        kind: item.kind.clone(),
                        id: item.id.clone(),
                        selected: item.selected && item.id != "rule_readonly",
                    })
                    .collect(),
            },
        )
        .unwrap();
        let (_, deselected_rules, deselected_hooks) =
            projection_additions(&database, &store, &agent_id).unwrap();
        assert!(
            deselected_rules
                .iter()
                .all(|rule| !rule.body.contains(RULE_MARKER))
        );
        assert!(
            deselected_hooks
                .iter()
                .any(|hook| hook.name == "format-on-stop")
        );
        let preview_without_rule = crate::run_projection::preview_member_run_projection(
            &database,
            &directory,
            &store,
            &crate::run_projection::MemberRunProjectionParams {
                member: agent_id.clone(),
                runtime: Some("codex-cli".to_string()),
            },
        )
        .unwrap();
        assert!(!preview_without_rule.bootstrap.contains(RULE_MARKER));

        // Restore the exact starting selection so the following import and hook
        // cases keep the catalog this test began with.
        set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: deselected.revision.clone(),
                acknowledge_high_risk: false,
                selections: selected_catalog
                    .items
                    .iter()
                    .map(|item| MemberCapabilitySelection {
                        kind: item.kind.clone(),
                        id: item.id.clone(),
                        selected: item.selected,
                    })
                    .collect(),
            },
        )
        .unwrap();
        let (_, restored_rules, restored_hooks) =
            projection_additions(&database, &store, &agent_id).unwrap();
        assert!(
            restored_rules
                .iter()
                .any(|rule| rule.id == "rule_readonly" && rule.body == RULE_BODY)
        );
        assert!(
            restored_hooks
                .iter()
                .any(|hook| hook.name == "format-on-stop")
        );

        // An imported Library Skill only enters the catalog when the user registers it explicitly.
        let import_source = directory.join("import-source");
        fs::create_dir_all(&import_source).unwrap();
        let folder = write_skill_folder(&import_source, "user-review", "用户导入的复核正文。");
        let inspection = library.inspect_import(&database, &folder).unwrap();
        let commit = |database: &mut Database,
                      token: String,
                      name: String,
                      digest: String,
                      existing: Option<i64>,
                      update: bool| {
            library
                .commit_import(
                    database,
                    &user_envelope(CommitSkillImportCommand {
                        staging_token: token,
                        candidate_name: name,
                        expected_digest: digest,
                        expected_skill_version: existing,
                        confirm_update: update,
                    }),
                )
                .unwrap()
        };
        {
            let candidate = inspection.candidates[0].clone();
            commit(
                &mut database,
                inspection.staging_token.clone(),
                candidate.name,
                candidate.content_digest,
                candidate.existing_skill_version,
                false,
            );
        }
        let imported = library
            .list(&database)
            .unwrap()
            .into_iter()
            .find(|skill| skill.name == "user-review")
            .unwrap();
        let unregistered = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        assert!(
            !unregistered
                .items
                .iter()
                .any(|item| item.name == "user-review")
        );
        let registered = put_capability_item(
            &database,
            &store,
            &library,
            &MemberCapabilityPutParams {
                item_id: Some(format!("library:{}", imported.id)),
                kind: "skill".to_string(),
                name: None,
                note: None,
                scope: None,
                body: None,
                source_label: None,
                tool_names: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(registered.id, format!("library:{}", imported.id));
        assert_eq!(registered.name, "user-review");
        let catalog_a = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let library_item = catalog_a
            .items
            .iter()
            .find(|item| item.id == registered.id)
            .expect("registered library item")
            .clone();
        assert!(!library_item.selected && library_item.origin.is_none());
        assert!(library_item.source_error.is_none());
        let mut library_selections = catalog_a
            .items
            .iter()
            .map(|item| MemberCapabilitySelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
                selected: item.selected || item.id == registered.id,
            })
            .collect::<Vec<_>>();
        let selected_library = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: catalog_a.revision.clone(),
                acknowledge_high_risk: false,
                selections: library_selections.clone(),
            },
        )
        .unwrap();
        assert!(
            selected_library
                .items
                .iter()
                .any(|item| item.id == registered.id && item.selected)
        );
        let persisted = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        assert!(persisted.items.iter().any(|item| item.id == registered.id
            && item.selected
            && item.origin.as_deref() == Some("explicit")));
        // The existing toolbox Skill choice is untouched by the Library row.
        assert!(
            persisted
                .items
                .iter()
                .any(|item| item.id == "campfire" && item.selected)
        );

        // A new Library revision moves the catalog revision, so the old expectation is refused.
        fs::write(
            folder.join("SKILL.md"),
            "---\nname: user-review\ndescription: Fixture user-review\n---\n\n更新后的正文。\n",
        )
        .unwrap();
        let reinspection = library.inspect_import(&database, &folder).unwrap();
        {
            let candidate = reinspection.candidates[0].clone();
            commit(
                &mut database,
                reinspection.staging_token.clone(),
                candidate.name,
                candidate.content_digest,
                candidate.existing_skill_version,
                true,
            );
        }
        let catalog_b = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        assert_ne!(catalog_b.revision, selected_library.revision);
        let stale_library = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: selected_library.revision.clone(),
                acknowledge_high_risk: false,
                selections: library_selections.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(
            capability_code(stale_library),
            "capability.revision_conflict"
        );

        // A disabled source refuses selection but still allows the member to drop it.
        let version = library
            .get(&database, &imported.id)
            .unwrap()
            .unwrap()
            .version;
        library
            .set_enabled(
                &mut database,
                &user_envelope(SetSkillEnabledCommand {
                    skill_id: imported.id.clone(),
                    expected_version: version,
                    enabled: false,
                }),
            )
            .unwrap();
        let catalog_c = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let disabled_item = catalog_c
            .items
            .iter()
            .find(|item| item.id == registered.id)
            .unwrap();
        assert_eq!(disabled_item.source_error.as_deref(), Some("技能已停用"));
        library_selections = catalog_c
            .items
            .iter()
            .map(|item| MemberCapabilitySelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
                selected: item.selected || item.id == registered.id,
            })
            .collect();
        let refused_library = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: catalog_c.revision.clone(),
                acknowledge_high_risk: false,
                selections: library_selections.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(
            capability_code(refused_library),
            "capability.skill_source_unavailable"
        );
        let dropped = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: catalog_c.revision.clone(),
                acknowledge_high_risk: false,
                selections: catalog_c
                    .items
                    .iter()
                    .map(|item| MemberCapabilitySelection {
                        kind: item.kind.clone(),
                        id: item.id.clone(),
                        selected: false,
                    })
                    .collect(),
            },
        )
        .unwrap();
        assert!(
            !dropped
                .items
                .iter()
                .any(|item| item.id == registered.id && item.selected)
        );

        // The catalog binds the admitted Library root; a moved root refuses the old expectation.
        let registered_before_root =
            get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let moved_root = directory
            .join("moved-library")
            .to_string_lossy()
            .to_string();
        database
            .connection()
            .execute(
                "UPDATE member_skill_source SET library_root=?1 WHERE skill_id=?2",
                [moved_root.as_str(), imported.id.as_str()],
            )
            .unwrap();
        let moved = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        assert_ne!(moved.revision, registered_before_root.revision);
        let stale_root = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: registered_before_root.revision.clone(),
                acknowledge_high_risk: false,
                selections: library_selections.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(capability_code(stale_root), "capability.revision_conflict");
        let moved_select = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: moved.revision.clone(),
                acknowledge_high_risk: false,
                selections: moved
                    .items
                    .iter()
                    .map(|item| MemberCapabilitySelection {
                        kind: item.kind.clone(),
                        id: item.id.clone(),
                        selected: item.selected || item.id == registered.id,
                    })
                    .collect(),
            },
        )
        .unwrap_err();
        assert_eq!(
            capability_code(moved_select),
            "capability.skill_source_unavailable"
        );

        write_high_risk_server(&store);
        let risky = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let browser = risky
            .items
            .iter()
            .find(|item| item.kind == "mcp" && item.name == "browser")
            .expect("high risk server");
        assert_eq!(browser.risk.as_deref(), Some("high"));
        let mut risky_selections = risky
            .items
            .iter()
            .map(|item| MemberCapabilitySelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
                selected: item.selected || item.name == "browser",
            })
            .collect::<Vec<_>>();
        let refused = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: risky.revision.clone(),
                acknowledge_high_risk: false,
                selections: risky_selections.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(
            capability_code(refused),
            "capability.risk_acknowledgement_required"
        );
        assert!(
            !get_member_capability_catalog(&database, &store, &agent_id)
                .unwrap()
                .items
                .iter()
                .any(|item| item.name == "browser" && item.selected)
        );
        // The refused save did not change the revision, but the high-risk file replaced git,
        // so the catalog revision already moved when the file was replaced. Re-read it.
        let risky = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        risky_selections = risky
            .items
            .iter()
            .map(|item| MemberCapabilitySelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
                selected: item.selected || item.name == "browser",
            })
            .collect();
        let acknowledged = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: risky.revision,
                acknowledge_high_risk: true,
                selections: risky_selections,
            },
        )
        .unwrap();
        let browser = acknowledged
            .items
            .iter()
            .find(|item| item.name == "browser")
            .unwrap();
        assert!(browser.selected && browser.origin.as_deref() == Some("explicit"));

        put_capability_item(
            &database,
            &store,
            &library,
            &MemberCapabilityPutParams {
                item_id: Some("hook_shell".to_string()),
                kind: "hook".to_string(),
                name: Some("run-format".to_string()),
                note: Some("执行本机命令".to_string()),
                scope: Some("cloud".to_string()),
                body: Some("command: bash -c 'echo hi'".to_string()),
                source_label: None,
                tool_names: Vec::new(),
            },
        )
        .unwrap();
        let with_hook = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let shell = with_hook
            .items
            .iter()
            .find(|item| item.id == "hook_shell")
            .unwrap();
        assert_eq!(shell.risk.as_deref(), Some("high"));
        assert!(!shell.selected);
        let mut hook_selections = with_hook
            .items
            .iter()
            .map(|item| MemberCapabilitySelection {
                kind: item.kind.clone(),
                id: item.id.clone(),
                selected: item.selected || item.id == "hook_shell",
            })
            .collect::<Vec<_>>();
        let refused_hook = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id: agent_id.clone(),
                expected_revision: with_hook.revision.clone(),
                acknowledge_high_risk: false,
                selections: hook_selections.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(
            capability_code(refused_hook),
            "capability.risk_acknowledgement_required"
        );
        hook_selections = get_member_capability_catalog(&database, &store, &agent_id)
            .unwrap()
            .items
            .into_iter()
            .map(|item| MemberCapabilitySelection {
                selected: item.selected || item.id == "hook_shell",
                kind: item.kind,
                id: item.id,
            })
            .collect();
        let current = get_member_capability_catalog(&database, &store, &agent_id).unwrap();
        let kept = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                local_camp_id: None,
                reviewed_hooks: Vec::new(),
                agent_id,
                expected_revision: current.revision,
                acknowledge_high_risk: true,
                selections: hook_selections,
            },
        )
        .unwrap();
        assert!(
            kept.items
                .iter()
                .any(|item| item.id == "hook_shell" && item.selected)
        );

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    // This owner covers the transaction/consent failure boundary, separately
    // from the existing combined catalog projection owner above.
    #[test]
    fn exact_hook_review_survives_only_identical_definitions_and_workspace_scope() {
        let directory = std::env::temp_dir().join(format!("rovai-hook-review-{}", Uuid::new_v4()));
        let directory =
            crate::platform::private_storage::prepare_private_directory(&directory).unwrap();
        let mut database = Database::open(&directory).unwrap();
        let store = McpConfigStore::new(directory.join("mcp.json"));
        let library = SkillLibraryService::new(directory.join("skill-library")).unwrap();
        let agent = AgentProfileService::default()
            .list_profiles(&database)
            .unwrap()[0]
            .agent_id
            .clone();
        let scope = test_remote_scope(&mut database, &agent, &directory);
        let mut definition = MemberCapabilityPutParams {
            item_id: Some("review_hook".into()), kind: "hook".into(), name: Some("Reviewed hook".into()),
            note: Some("Only the exact body is reviewed".into()), source_label: Some("Fixture catalog".into()),
            scope: Some("project".into()), tool_names: Vec::new(),
            body: Some(r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"fixture-command","timeout":5}]}]}}"#.into()),
        };
        put_capability_item(&database, &store, &library, &definition).unwrap();
        let request = |catalog: &MemberCapabilityCatalog,
                       selected: bool,
                       approvals: Vec<HookReviewApproval>| {
            MemberCapabilitySetParams {
                local_camp_id: None,
                agent_id: agent.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: true,
                reviewed_hooks: approvals,
                selections: vec![MemberCapabilitySelection {
                    kind: "hook".into(),
                    id: "review_hook".into(),
                    selected,
                }],
            }
        };
        let catalog = get_member_capability_catalog(&database, &store, &agent).unwrap();
        let initial = catalog
            .items
            .iter()
            .find(|item| item.id == "review_hook")
            .unwrap();
        assert!(initial.selected && initial.origin.as_deref() == Some("inherited"));
        assert!(!initial.hook_definition.as_ref().unwrap().reviewed);
        let before_changes = database.connection().total_changes();
        assert_eq!(
            capability_code(
                set_member_capability_catalog(
                    &mut database,
                    &store,
                    &library,
                    &request(&catalog, true, Vec::new())
                )
                .unwrap_err()
            ),
            "capability.hook_review_required"
        );
        assert_eq!(database.connection().total_changes(), before_changes);

        // The generic acknowledgement and a simultaneous MCP edit cannot stand
        // in for exact hook consent; refusal occurs before the MCP file write.
        write_high_risk_server(&store);
        let catalog = get_member_capability_catalog(&database, &store, &agent).unwrap();
        let before_mcp = fs::read(store.path()).unwrap();
        let mut missing = request(&catalog, true, Vec::new());
        missing.selections.push(MemberCapabilitySelection {
            kind: "mcp".into(),
            id: catalog
                .items
                .iter()
                .find(|item| item.kind == "mcp")
                .unwrap()
                .id
                .clone(),
            selected: true,
        });
        assert_eq!(
            capability_code(
                set_member_capability_catalog(&mut database, &store, &library, &missing)
                    .unwrap_err()
            ),
            "capability.hook_review_required"
        );
        assert_eq!(fs::read(store.path()).unwrap(), before_mcp);
        let approval = exact_review(&catalog, "review_hook");
        let reviewed = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &request(&catalog, true, vec![approval.clone()]),
        )
        .unwrap();
        assert_ne!(reviewed.revision, catalog.revision);
        let reviewed_item = reviewed
            .items
            .iter()
            .find(|item| item.id == "review_hook")
            .unwrap();
        assert!(reviewed_item.hook_definition.as_ref().unwrap().reviewed);
        assert!(!format!("{:?}", reviewed_item.hook_definition).contains("fixture-command"));
        let stamp: (String, String) = database.connection().query_row(
            "SELECT reviewed_revision,reviewed_at FROM member_hook_review WHERE agent_id=?1 AND item_id='review_hook'",
            [&agent], |r| Ok((r.get(0)?,r.get(1)?)),
        ).unwrap();
        assert_eq!(stamp.0, catalog.revision);
        // true->true approval is retained without creating a fake explicit choice.
        assert_eq!(database.connection().query_row(
            "SELECT COUNT(*) FROM member_capability_choice WHERE agent_id=?1 AND kind='hook' AND item_key='review_hook'",
            [&agent], |r|r.get::<_,i64>(0),
        ).unwrap(), 0);
        let idempotent = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &request(&reviewed, true, vec![approval.clone()]),
        )
        .unwrap();
        assert_eq!(idempotent.revision, reviewed.revision);
        assert_eq!(stamp, database.connection().query_row(
            "SELECT reviewed_revision,reviewed_at FROM member_hook_review WHERE agent_id=?1 AND item_id='review_hook'",
            [&agent], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)),
        ).unwrap());

        // Same ID, changed body: both catalog revision and digest change, and
        // neither the stale catalog nor a later catalog with the old review can save.
        definition.body = Some(
            definition
                .body
                .as_ref()
                .unwrap()
                .replace("fixture-command", "fixture-command-v2"),
        );
        put_capability_item(&database, &store, &library, &definition).unwrap();
        let changed = get_member_capability_catalog(&database, &store, &agent).unwrap();
        assert_ne!(changed.revision, reviewed.revision);
        assert_eq!(
            capability_code(
                set_member_capability_catalog(
                    &mut database,
                    &store,
                    &library,
                    &request(&reviewed, true, vec![approval.clone()])
                )
                .unwrap_err()
            ),
            "capability.revision_conflict"
        );
        assert_eq!(
            capability_code(
                set_member_capability_catalog(
                    &mut database,
                    &store,
                    &library,
                    &request(&changed, true, vec![approval])
                )
                .unwrap_err()
            ),
            "capability.hook_review_conflict"
        );
        let body_approval = exact_review(&changed, "review_hook");
        definition.note = Some("Changed execution explanation".into());
        put_capability_item(&database, &store, &library, &definition).unwrap();
        let note_changed = get_member_capability_catalog(&database, &store, &agent).unwrap();
        assert_ne!(note_changed.revision, changed.revision);
        assert_ne!(
            exact_review(&note_changed, "review_hook").definition_digest,
            body_approval.definition_digest
        );
        assert_eq!(
            capability_code(
                set_member_capability_catalog(
                    &mut database,
                    &store,
                    &library,
                    &request(&note_changed, true, vec![body_approval])
                )
                .unwrap_err()
            ),
            "capability.hook_review_conflict"
        );
        let fresh_approval = exact_review(&note_changed, "review_hook");
        let reviewed = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &request(&note_changed, true, vec![fresh_approval.clone()]),
        )
        .unwrap();
        let off = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &request(&reviewed, false, Vec::new()),
        )
        .unwrap();
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM member_hook_review WHERE agent_id=?1",
                    [&agent],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        let on_again = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &request(&off, true, Vec::new()),
        )
        .unwrap();
        assert!(
            on_again
                .items
                .iter()
                .find(|item| item.id == "review_hook")
                .unwrap()
                .hook_definition
                .as_ref()
                .unwrap()
                .reviewed
        );
        set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &request(&on_again, false, Vec::new()),
        )
        .unwrap();
        // Stored consent is no longer usable after a definition change.
        definition.note = Some("Different execution explanation after deselection".into());
        put_capability_item(&database, &store, &library, &definition).unwrap();
        let off = get_member_capability_catalog(&database, &store, &agent).unwrap();
        let fresh_approval = exact_review(&off, "review_hook");
        assert_eq!(
            capability_code(
                set_member_capability_catalog(
                    &mut database,
                    &store,
                    &library,
                    &request(&off, true, Vec::new())
                )
                .unwrap_err()
            ),
            "capability.hook_review_required"
        );
        // A failed new approval rolls the selection DELETE back in the same
        // transaction; retained but stale consent cannot authorize the changed body.
        database
            .connection()
            .execute_batch(
                "CREATE TEMP TRIGGER fail_review BEFORE INSERT ON member_hook_review
             BEGIN SELECT RAISE(ABORT,'fixture review failure'); END;",
            )
            .unwrap();
        assert!(
            set_member_capability_catalog(
                &mut database,
                &store,
                &library,
                &request(&off, true, vec![fresh_approval.clone()])
            )
            .is_err()
        );
        let after_failure = get_member_capability_catalog(&database, &store, &agent).unwrap();
        assert_eq!(after_failure.revision, off.revision);
        assert!(
            !after_failure
                .items
                .iter()
                .find(|item| item.id == "review_hook")
                .unwrap()
                .selected
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER fail_review;")
            .unwrap();
        for invalid in [
            vec![fresh_approval.clone(), fresh_approval.clone()],
            vec![HookReviewApproval {
                id: "unknown-hook".into(),
                definition_digest: fresh_approval.definition_digest.clone(),
                scope_digest: fresh_approval.scope_digest.clone(),
            }],
        ] {
            assert!(
                set_member_capability_catalog(
                    &mut database,
                    &store,
                    &library,
                    &request(&off, true, invalid)
                )
                .is_err()
            );
        }
        let on = set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &request(&off, true, vec![fresh_approval]),
        )
        .unwrap();
        assert!(
            on.items
                .iter()
                .find(|item| item.id == "review_hook")
                .unwrap()
                .hook_definition
                .as_ref()
                .unwrap()
                .reviewed
        );

        // Scope comes from real membership + ready workspace authority. A path
        // or project label alone cannot carry consent to a different workspace.
        let approval_a = exact_review(&on, "review_hook");
        let selected_a: String = database
            .connection()
            .query_row(
                "SELECT selection_json FROM member_execution_target WHERE member_id=?1",
                [&agent],
                |r| r.get(0),
            )
            .unwrap();
        let other = test_remote_scope(&mut database, &agent, &directory);
        assert_ne!(other.workspace_id, scope.workspace_id);
        let changed_scope = get_member_capability_catalog(&database, &store, &agent).unwrap();
        assert_ne!(changed_scope.revision, on.revision);
        assert!(
            !changed_scope
                .items
                .iter()
                .find(|i| i.id == "review_hook")
                .unwrap()
                .hook_definition
                .as_ref()
                .unwrap()
                .reviewed
        );
        assert_eq!(
            capability_code(
                set_member_capability_catalog(
                    &mut database,
                    &store,
                    &library,
                    &request(&changed_scope, true, vec![approval_a.clone()])
                )
                .unwrap_err()
            ),
            "capability.hook_review_conflict"
        );
        database.connection().execute(
            "UPDATE member_execution_target SET selection_json=?1,node_id=?2,revision=revision+1 WHERE member_id=?3",
            params![selected_a,scope.node_id,agent],
        ).unwrap();
        let restored_scope = get_member_capability_catalog(&database, &store, &agent).unwrap();
        assert!(
            restored_scope
                .items
                .iter()
                .find(|i| i.id == "review_hook")
                .unwrap()
                .hook_definition
                .as_ref()
                .unwrap()
                .reviewed
        );
        database
            .connection()
            .execute(
                "UPDATE mission_workspace SET generation=generation+1 WHERE id=?1",
                [&scope.workspace_id],
            )
            .unwrap();
        let rebuilt = get_member_capability_catalog(&database, &store, &agent).unwrap();
        assert_ne!(
            exact_review(&rebuilt, "review_hook").scope_digest,
            approval_a.scope_digest
        );
        assert!(
            !rebuilt
                .items
                .iter()
                .find(|i| i.id == "review_hook")
                .unwrap()
                .hook_definition
                .as_ref()
                .unwrap()
                .reviewed
        );
        database
            .connection()
            .execute(
                "UPDATE mission_workspace SET state='preparing' WHERE id=?1",
                [&scope.workspace_id],
            )
            .unwrap();
        assert!(get_member_capability_catalog(&database, &store, &agent).is_err());

        // The local extension keeps the exact old Remote wire/digest and gets
        // its own authority from a real local Camp, never a manufactured Node.
        assert_eq!(
            serde_json::to_value(hook_review::HookReviewScope::Remote(scope.clone())).unwrap(),
            serde_json::to_value(&scope).unwrap()
        );
        database
            .connection()
            .execute(
                "DELETE FROM member_execution_target WHERE member_id=?1",
                [&agent],
            )
            .unwrap();
        database
            .connection()
            .execute(
                "DELETE FROM member_capability_choice WHERE agent_id=?1 AND kind='hook'",
                [&agent],
            )
            .unwrap();
        let permissions = json!({"adapterKind":"deepseek-harness","schemaVersion":1,
            "values":{"sandbox_mode":"workspace-write","approval_policy":"ask"}});
        database.connection().execute(
            "INSERT INTO adapter_installation(id,adapter_kind,executable_path,command_name,
             installation_class,source,auth_scope,enabled,version,created_at,updated_at)
             VALUES('local-hook-fixture-dsh','deepseek-harness',?1,'dsh','managed_default','custom',
             'test-user',1,1,'fixture','fixture')",
            [std::env::current_exe().unwrap().to_string_lossy().to_string()],
        ).unwrap();
        database.connection().execute(
            "UPDATE agent_profile SET selected_runtime_adapter_kind='deepseek-harness',
             default_runtime_installation_id='local-hook-fixture-dsh',default_model_selection_json=?1,
             default_permission_config_json=?2 WHERE id=?3",
            params![json!({"mode":"explicit","modelId":"local-hook-fixture","options":{}}).to_string(),
                permissions.to_string(),agent],
        ).unwrap();
        let created = crate::collaboration::CollaborationService::default()
            .create_camp(
                &mut database,
                &user_envelope(
                    crate::collaboration::CreateThreadCommand::for_test_with_members(
                        directory.to_string_lossy().into_owned(),
                        &[agent.as_str()],
                        &agent,
                    ),
                ),
            )
            .unwrap();
        let camp = created.result.payload["threadId"]
            .as_str()
            .unwrap()
            .to_owned();
        definition.body=Some(r#"{"hooks":{"PostToolUse":[{"matcher":"read","hooks":[{"type":"command","command":"printf hook-reviewed","timeout":1}]}]}}"#.into());
        put_capability_item(&database, &store, &library, &definition).unwrap();
        let absent =
            get_member_capability_catalog_scoped(&database, &store, &agent, Some("not-this-camp"))
                .unwrap();
        let item = absent.items.iter().find(|i| i.id == "review_hook").unwrap();
        assert!(!item.selected && item.hook_definition.is_none());
        // A missing local context must not silently select an inherited Hook
        // or make an unrelated unchanged capability save fail.
        let mut unrelated = request(&absent, false, vec![]);
        unrelated.local_camp_id = Some("not-this-camp".into());
        unrelated.selections.clear();
        set_member_capability_catalog(&mut database, &store, &library, &unrelated).unwrap();
        let local =
            get_member_capability_catalog_scoped(&database, &store, &agent, Some(&camp)).unwrap();
        let item = local.items.iter().find(|i| i.id == "review_hook").unwrap();
        assert!(!item.selected && !item.hook_definition.as_ref().unwrap().reviewed);
        let authority =
            crate::local_hook::current_scope(database.connection(), &agent, &camp).unwrap();
        let wire = serde_json::to_value(&authority).unwrap();
        assert_eq!(wire["scopeKind"], "local");
        assert!(wire.get("nodeId").is_none());
        assert_eq!(wire["permissions"], permissions);
        let mut local_request = request(&local, true, vec![]);
        local_request.local_camp_id = Some(camp.clone());
        assert_eq!(
            capability_code(
                set_member_capability_catalog(&mut database, &store, &library, &local_request,)
                    .unwrap_err()
            ),
            "capability.hook_review_required"
        );
        local_request.reviewed_hooks = vec![exact_review(&local, "review_hook")];
        let selected =
            set_member_capability_catalog(&mut database, &store, &library, &local_request).unwrap();
        let (hooks, reviews) =
            freeze_local_hooks(database.connection(), &agent, &authority).unwrap();
        let frozen = crate::local_hook::FrozenLocalHooks {
            version: 1,
            agent_run_id: "already-queued-local-run".into(),
            scope: authority.clone(),
            hooks,
            reviews,
        };
        frozen.validate().unwrap();
        crate::local_hook::assert_receipt_pairing_and_run_fence(&frozen);

        // The first contract supports one selected Hook. Reject the entire
        // second selection before any external MCP/Skill write or choice write.
        let second = MemberCapabilityPutParams {
            item_id: Some("second_local_hook".into()),
            kind: "hook".into(),
            name: Some("Second local hook".into()),
            note: definition.note.clone(),
            source_label: definition.source_label.clone(),
            scope: definition.scope.clone(),
            tool_names: vec![],
            body: definition.body.clone(),
        };
        put_capability_item(&database, &store, &library, &second).unwrap();
        let two =
            get_member_capability_catalog_scoped(&database, &store, &agent, Some(&camp)).unwrap();
        let mut second_request = request(&two, true, vec![exact_review(&two, "second_local_hook")]);
        second_request.local_camp_id = Some(camp.clone());
        second_request.selections.push(MemberCapabilitySelection {
            kind: "hook".into(),
            id: "second_local_hook".into(),
            selected: true,
        });
        let before = database.connection().total_changes();
        assert_eq!(
            capability_code(
                set_member_capability_catalog(&mut database, &store, &library, &second_request,)
                    .unwrap_err()
            ),
            "capability.local_hook_one_required"
        );
        assert_eq!(before, database.connection().total_changes());

        let mut off = request(&two, false, vec![]);
        off.local_camp_id = Some(camp.clone());
        set_member_capability_catalog(&mut database, &store, &library, &off).unwrap();
        assert!(
            freeze_local_hooks(database.connection(), &agent, &authority)
                .unwrap()
                .0
                .is_empty()
        );
        // Deselection changes the next Run only; the reviewed earlier snapshot
        // remains exact, independently of mutable catalog choices.
        frozen.validate().unwrap();
        assert_eq!(frozen.hooks.len(), 1);
        let mut changed_permissions = permissions.clone();
        changed_permissions["values"]["sandbox_mode"] = json!("read-only");
        database
            .connection()
            .execute(
                "UPDATE agent_profile SET default_permission_config_json=?1 WHERE id=?2",
                params![changed_permissions.to_string(), agent],
            )
            .unwrap();
        let drift =
            get_member_capability_catalog_scoped(&database, &store, &agent, Some(&camp)).unwrap();
        assert_ne!(
            exact_review(&selected, "review_hook").scope_digest,
            exact_review(&drift, "review_hook").scope_digest
        );
        assert!(
            !drift
                .items
                .iter()
                .find(|i| i.id == "review_hook")
                .unwrap()
                .hook_definition
                .as_ref()
                .unwrap()
                .reviewed
        );
        assert!(
            crate::member_capability::validate_frozen_local_hook_scope(
                &frozen.reviews,
                &crate::local_hook::current_scope(database.connection(), &agent, &camp).unwrap(),
            )
            .is_err()
        );

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    fn write_high_risk_server(store: &McpConfigStore) {
        let mut config = McpConfigFile {
            mcp_servers: BTreeMap::new(),
            rovai: McpRovaiMetadata {
                schema_version: MCP_SCHEMA_VERSION,
                servers: BTreeMap::new(),
                assignments: Vec::new(),
            },
        };
        config.mcp_servers.insert(
            "browser".to_string(),
            McpServerDefinition::Stdio {
                command: "node".to_string(),
                args: vec!["server.js".to_string()],
                cwd: None,
                env: BTreeMap::new(),
            },
        );
        config.rovai.servers.insert(
            "browser".to_string(),
            McpServerMetadata {
                server_id: "6f0b6b1e-7c2a-4f1d-9a55-2b0e4d8c9a11".to_string(),
                enabled: false,
                source: McpServerSource::User,
                risk_level: McpRiskLevel::High,
                risk_acknowledged: false,
            },
        );
        let bytes = serde_json::to_vec_pretty(&config).unwrap();
        #[cfg(unix)]
        {
            fs::create_dir_all(store.path().parent().unwrap()).unwrap();
            fs::write(store.path(), &bytes).unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(store.path(), fs::Permissions::from_mode(0o600)).unwrap();
        }
        #[cfg(windows)]
        crate::platform::private_storage::atomic_write_private_bytes(store.path(), &bytes).unwrap();
    }
}
