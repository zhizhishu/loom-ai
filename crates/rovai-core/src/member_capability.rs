//! Per-member capability catalog: toolbox skills, MCP servers, rule snippets, and hooks.
//!
//! Skills and MCP assignments stay in their existing stores. Rule snippets, hooks, tool-name
//! claims, and whether a choice is inherited or explicit live in the tables from migration 227.
//! Saving a skill or MCP membership is the same write the settings pages already perform, so the
//! next Run's additional skills and MCP file follow the checkboxes. Rule and hook bodies are
//! reported on the read-only run projection and are not inserted into session bootstrap text.

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
    pub selected: bool,
    pub origin: Option<String>,
    pub tool_names: Vec<String>,
    pub risk: Option<String>,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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
    pub expected_revision: String,
    #[serde(default)]
    pub acknowledge_high_risk: bool,
    pub selections: Vec<MemberCapabilitySelection>,
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
}

pub(crate) fn get_member_capability_catalog(
    database: &Database,
    store: &McpConfigStore,
    agent_id: &str,
) -> Result<MemberCapabilityCatalog> {
    let profile = require_member(database, agent_id)?;
    let pieces = catalog_pieces(database, store, &profile)?;
    Ok(catalog_from_pieces(&profile, pieces)?)
}

pub(crate) fn set_member_capability_catalog(
    database: &mut Database,
    store: &McpConfigStore,
    params: &MemberCapabilitySetParams,
) -> Result<MemberCapabilityCatalog> {
    let profile = require_member(database, &params.agent_id)?;
    let current_pieces = catalog_pieces(database, store, &profile)?;
    let current = catalog_from_pieces(&profile, current_pieces.clone())?;
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
            default_selected(&piece.kind, &piece.scope, &piece.id),
            &now,
        )?;
    }
    transaction.commit()?;
    get_member_capability_catalog(database, store, &profile.agent_id)
}

pub(crate) fn put_capability_item(
    database: &Database,
    store: &McpConfigStore,
    params: &MemberCapabilityPutParams,
) -> Result<MemberCapabilityPutResult> {
    let tool_names = normalize_tool_names(&params.tool_names)?;
    let kind = params.kind.as_str();
    let (id, name) = match kind {
        "rule" | "hook" => upsert_snippet(database.connection(), kind, params)?,
        "skill" => {
            let id = required_item_id(params, "技能名称不能为空。")?;
            if !TOOLBOX_SKILLS.contains(&id.as_str()) {
                return Err(MemberCapabilityError::new(
                    "capability.invalid_request",
                    "这不是工具箱里的技能。",
                ));
            }
            (id.clone(), id)
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

fn catalog_pieces(
    database: &Database,
    store: &McpConfigStore,
    profile: &AgentProfileView,
) -> Result<Vec<CatalogPiece>> {
    let connection = database.connection();
    let choices = load_choices(connection, &profile.agent_id)?;
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
            .unwrap_or_else(|| default_selected(&kind, &scope, &id));
        let risk = hook_runs_shell(&kind, &body).then_some("high".to_string());
        pieces.push(CatalogPiece {
            tool_names: claims
                .get(&(kind.clone(), id.clone()))
                .cloned()
                .unwrap_or_default(),
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

fn catalog_from_pieces(
    profile: &AgentProfileView,
    mut pieces: Vec<CatalogPiece>,
) -> Result<MemberCapabilityCatalog> {
    pieces.sort_by(|left, right| {
        kind_rank(&left.kind)
            .cmp(&kind_rank(&right.kind))
            .then(left.name.cmp(&right.name))
            .then(left.id.cmp(&right.id))
    });
    let items = pieces
        .iter()
        .map(|piece| MemberCapabilityItem {
            id: piece.id.clone(),
            kind: piece.kind.clone(),
            name: piece.name.clone(),
            note: piece.note.clone(),
            source: piece.source.clone(),
            scope: piece.scope.clone(),
            selected: piece.selected,
            origin: display_origin(piece),
            tool_names: piece.tool_names.clone(),
            risk: piece.risk.clone(),
        })
        .collect::<Vec<_>>();
    let revision = canonical_json_digest(&json!(
        items
            .iter()
            .map(|item| json!({
                "id": item.id,
                "kind": item.kind,
                "origin": item.origin,
                "selected": item.selected,
            }))
            .collect::<Vec<_>>()
    ))?;
    Ok(MemberCapabilityCatalog {
        agent_id: profile.agent_id.clone(),
        display_name: profile.display_name.clone(),
        team_role: profile.team_role.clone(),
        runtime: profile
            .runtime_configuration
            .as_ref()
            .map(|configuration| configuration.adapter_kind.as_str().to_string()),
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
        piece.risk.as_deref() == Some("high") && piece.selected && !was_selected(current, piece)
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
    fn selection_keeps_inherited_defaults_records_explicit_overrides_and_projects_them() {
        let directory =
            std::env::temp_dir().join(format!("rovai-member-capability-{}", Uuid::new_v4()));
        let mut database = Database::open(&directory).unwrap();
        let store = McpConfigStore::new(directory.join("mcp.json"));
        let profile = AgentProfileService::default()
            .list_profiles(&database)
            .unwrap()
            .into_iter()
            .next()
            .expect("fresh database has a member");
        let agent_id = profile.agent_id.clone();

        let rule = put_capability_item(
            &database,
            &store,
            &MemberCapabilityPutParams {
                item_id: Some("rule_readonly".to_string()),
                kind: "rule".to_string(),
                name: Some("只读工作区".to_string()),
                note: Some("样例片段".to_string()),
                scope: Some("project".to_string()),
                body: Some("不要写工作区。".to_string()),
                source_label: None,
                tool_names: vec!["read_file".to_string()],
            },
        )
        .unwrap();
        let hook = put_capability_item(
            &database,
            &store,
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
            &MemberCapabilitySetParams {
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
            &MemberCapabilitySetParams {
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
            &MemberCapabilitySetParams {
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
                .any(|rule| rule.name == "只读工作区" && rule.body == "不要写工作区。")
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
        assert!(!preview.bootstrap.contains("不要写工作区"));
        assert_eq!(preview.rules, rules);
        assert_eq!(preview.hooks, hooks);
        assert_eq!(preview.skills, skills);

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
            &MemberCapabilitySetParams {
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
            &MemberCapabilitySetParams {
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
            &MemberCapabilitySetParams {
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
            &MemberCapabilitySetParams {
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
        fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        fs::write(store.path(), serde_json::to_vec_pretty(&config).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(store.path(), fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}
