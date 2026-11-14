//! Consented native MCP import.
//!
//! Two halves, deliberately separate:
//!
//! * [`prepare`] is pure. It re-reads the one admitted file, re-verifies the
//!   digest, extracts **only** the selected server and normalizes it to
//!   `{"mcpServers":{name:definition}}` — the exact shape
//!   `rovai_core::mcp::CreateMcpServerParams` accepts. Nothing here calls Core,
//!   so a refused consent, a stale digest or a non-MCP source performs zero
//!   Core work.
//! * [`project`] turns Core's `McpMutationResult` into browser-safe facts. The
//!   definition (and any credential it carries) never appears in the response,
//!   an error message or a log line.
//!
//! Core `mcp.servers.create` stores the server `enabled: false` with no member
//! assignment (`rovai_core::mcp` `McpConfigStore::create`), so an import never
//! grants a capability by itself.

use super::parse;
use super::scan::KIND_MCP;
use super::{CatalogItem, Locate};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// Definition fields Core already understands. Anything else is refused rather
/// than silently stripped, so an unsupported auth or policy clause cannot look
/// like a successful import.
const SUPPORTED_FIELDS: [&str; 7] = [
    "command", "args", "env", "url", "headers", "type", "transport",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportMcpRequest {
    pub source_id: String,
    pub expected_digest: String,
    pub expected_config_digest: String,
    /// Explicit consent. Anything but `true` is refused.
    pub consent: bool,
    #[serde(default)]
    pub thread_id: Option<String>,
}

/// Extraction result. `definition_json` is handed to Core and dropped: it is
/// never serialized to the browser, logged or attached to an error.
pub(crate) struct PreparedImport {
    pub(crate) name: String,
    pub(crate) definition_json: String,
}

pub(crate) enum ImportFailure {
    NotConsented,
    NotMcp,
    Changed,
    Unreadable,
    UnsupportedField,
    /// The same name exists under both alias keys: no extraction is safe.
    AmbiguousAlias,
}

impl ImportFailure {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::NotConsented => "consent_required",
            Self::NotMcp => "source_not_mcp",
            Self::Changed => "source_changed",
            Self::Unreadable => "source_unreadable",
            Self::UnsupportedField => "source_definition_unsupported",
            Self::AmbiguousAlias => "source_alias_ambiguous",
        }
    }
}

/// Pure preparation. No Core call, no browser value, one bounded re-read.
pub(crate) fn prepare(
    item: &CatalogItem,
    request: &ImportMcpRequest,
) -> std::result::Result<PreparedImport, ImportFailure> {
    if !request.consent {
        return Err(ImportFailure::NotConsented);
    }
    if item.kind != KIND_MCP || !item.importable {
        return Err(ImportFailure::NotMcp);
    }
    // The exact parent key the user selected travels with the item. Without it
    // an aliased server name could select the other key's definition in the same
    // file (same digest, different body): a confused deputy.
    let Locate::McpServer { key } = &item.locate else {
        return Err(ImportFailure::NotMcp);
    };
    if !matches!(key.as_str(), "mcpServers" | "mcp_servers") {
        return Err(ImportFailure::NotMcp);
    }
    if item.source_id != request.source_id || item.digest != request.expected_digest {
        return Err(ImportFailure::Changed);
    }
    let bytes = parse::read_bounded_native_config(&item.file).map_err(|_| ImportFailure::Unreadable)?;
    if parse::digest(&bytes) != item.digest {
        return Err(ImportFailure::Changed);
    }
    let value = super::parse_by_extension(&item.file, &bytes).map_err(|_| ImportFailure::Unreadable)?;
    // Defence in depth: even if an item were produced without the scanner's
    // ambiguity check, a name declared under both aliases is refused here rather
    // than resolved to whichever key happens to be searched first.
    for other in ["mcpServers", "mcp_servers"] {
        if other != key.as_str()
            && value
                .get(other)
                .and_then(|servers| servers.get(item.name.as_str()))
                .is_some()
        {
            return Err(ImportFailure::AmbiguousAlias);
        }
    }
    let definition = find_server(&value, key, &item.name).ok_or(ImportFailure::Changed)?;
    check_supported(definition)?;
    let mut servers = Map::new();
    servers.insert(item.name.clone(), definition.clone());
    let definition_json = serde_json::to_string(&json!({ "mcpServers": Value::Object(servers) }))
        .map_err(|_| ImportFailure::Unreadable)?;
    Ok(PreparedImport {
        name: item.name.clone(),
        definition_json,
    })
}

/// Reads the definition only from the selected parent key. The alias key is
/// never consulted, so a shadowing entry cannot be substituted.
fn find_server<'a>(value: &'a Value, key: &str, name: &str) -> Option<&'a Value> {
    value.get(key)?.get(name)
}

fn check_supported(definition: &Value) -> std::result::Result<(), ImportFailure> {
    let Some(definition) = definition.as_object() else {
        return Err(ImportFailure::UnsupportedField);
    };
    if definition
        .keys()
        .all(|key| SUPPORTED_FIELDS.contains(&key.as_str()))
    {
        return Ok(());
    }
    Err(ImportFailure::UnsupportedField)
}

/// Browser-safe projection of Core's mutation result. Never carries a
/// definition, endpoint, header or environment value.
pub(crate) fn project(result: &Value, name: &str) -> Value {
    let status = result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match status {
        "ok" => {
            let server = result
                .pointer("/config/servers")
                .and_then(Value::as_array)
                .and_then(|servers| {
                    servers
                        .iter()
                        .find(|server| server.get("name").and_then(Value::as_str) == Some(name))
                });
            json!({
                "status": "ok",
                "serverId": server.and_then(|server| server.get("serverId").cloned()).unwrap_or(Value::Null),
                "name": name,
                // Core creates every server disabled and unassigned; restate the
                // observed values instead of promising them.
                "enabled": server.and_then(|server| server.get("enabled").and_then(Value::as_bool)).unwrap_or(false),
                "assignedAgentIds": server
                    .and_then(|server| server.get("assignedAgentIds").cloned())
                    .unwrap_or_else(|| json!([])),
            })
        }
        "conflict" => json!({
            "status": "conflict",
            "actualConfigDigest": result.get("actualConfigDigest").cloned().unwrap_or(Value::Null),
        }),
        "invalid" => json!({
            "status": "invalid",
            "issues": result
                .get("issues")
                .and_then(Value::as_array)
                .map(|issues| {
                    issues
                        .iter()
                        .map(|issue| json!({
                            "code": issue.get("code").cloned().unwrap_or(Value::Null),
                            "field": issue.get("field").cloned().unwrap_or(Value::Null),
                        }))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        }),
        other => json!({ "status": other }),
    }
}
