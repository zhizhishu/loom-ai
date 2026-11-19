//! Bounded, format-aware readers for admitted native configuration files.
//!
//! Nothing here executes configuration, resolves `${VAR}` placeholders, or
//! returns a raw command line, URL path, query, userinfo or environment value.
//! Every format is parsed by its real parser (serde_json / toml / serde_yaml);
//! there is no text or regular-expression interpretation of JSON or YAML.

use anyhow::{Context, Result, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

/// Hard cap for any native file this module reads. Larger files are refused
/// rather than partially interpreted.
pub(crate) const MAX_FILE_BYTES: u64 = 64 * 1024;
/// Claude stores multiple user-level MCP declarations in one .claude.json.
/// Keep a separate finite budget for this one known scanner-owned source;
/// never increase budgets for arbitrary SKILL.md, hooks or project files.
pub(crate) const MAX_CLAUDE_CONFIG_BYTES: u64 = 256 * 1024;
/// Parsed configuration deeper than this is refused as malformed.
pub(crate) const MAX_CONFIG_DEPTH: usize = 32;
/// Replacement text for anything this module declines to echo.
pub(crate) const MASKED: &str = "<masked>";

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Identity digest for facts that are deliberately never read (native Skill
/// entries): the digest binds adapter, scope and canonical path only.
pub(crate) fn identity_digest(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.as_bytes());
        hash.update([0u8]);
    }
    format!("{:x}", hash.finalize())
}

/// Reads at most [`MAX_FILE_BYTES`]. A link is never followed here: admitted
/// links are resolved by the scanner, not by the file reader.
pub(crate) fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    read_bounded_limit(path, MAX_FILE_BYTES)
}

/// Only the known .claude.json user configuration gets a larger cap.
/// The scanner has already admitted its exact fixed path; no request or
/// extension may specify a new location via this helper.
pub(crate) fn read_bounded_native_config(path: &Path) -> Result<Vec<u8>> {
    let limit = if path.file_name() == Some(std::ffi::OsStr::new(".claude.json")) {
        MAX_CLAUDE_CONFIG_BYTES
    } else {
        MAX_FILE_BYTES
    };
    read_bounded_limit(path, limit)
}

fn read_bounded_limit(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).context("native_file_metadata_failed")?;
    if metadata.file_type().is_symlink() {
        bail!("native_file_is_link");
    }
    if !metadata.is_file() {
        bail!("native_file_not_regular");
    }
    if metadata.len() > limit {
        bail!("native_file_too_large");
    }
    let bytes = fs::read(path).context("native_file_read_failed")?;
    if bytes.len() as u64 > limit {
        bail!("native_file_too_large");
    }
    Ok(bytes)
}

pub(crate) fn parse_json(bytes: &[u8]) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes).context("native_json_invalid")?;
    check_depth(&value, 0)?;
    Ok(value)
}

pub(crate) fn parse_toml(bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes).context("native_toml_not_utf8")?;
    let value: toml::Value = toml::from_str(text).context("native_toml_invalid")?;
    let value = serde_json::to_value(value).context("native_toml_normalize_failed")?;
    check_depth(&value, 0)?;
    Ok(value)
}

pub(crate) fn parse_yaml(bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes).context("native_yaml_not_utf8")?;
    let value: Value = serde_yaml::from_str(text).context("native_yaml_invalid")?;
    check_depth(&value, 0)?;
    Ok(value)
}

fn check_depth(value: &Value, depth: usize) -> Result<()> {
    if depth > MAX_CONFIG_DEPTH {
        bail!("native_config_too_deep");
    }
    match value {
        Value::Object(map) => {
            for value in map.values() {
                check_depth(value, depth + 1)?;
            }
        }
        Value::Array(items) => {
            for value in items {
                check_depth(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Only the executable name survives. Arguments, inline tokens and inline
/// environment assignments are dropped without inspecting them.
pub(crate) fn command_basename(command: &str) -> String {
    let program = command.split_whitespace().next().unwrap_or_default();
    let name = program.rsplit(['/', '\\']).next().unwrap_or_default();
    safe_token(name)
}

fn safe_token(name: &str) -> String {
    if !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        name.to_owned()
    } else {
        MASKED.to_owned()
    }
}

/// Scheme and host only: no userinfo, port, path, query or fragment.
pub(crate) fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    if host.is_empty()
        || !host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '[' | ']'))
    {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// Conservative marker test used before any preview body is returned.
pub(crate) fn has_secret_marker(value: &Value) -> bool {
    match value {
        Value::String(text) => text_has_secret(text),
        Value::Object(map) => map
            .iter()
            .any(|(key, value)| key_has_secret(key) || has_secret_marker(value)),
        Value::Array(items) => items.iter().any(has_secret_marker),
        _ => false,
    }
}

fn text_has_secret(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const MARKERS: [&str; 14] = [
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "api_key",
        "apikey",
        "api-key",
        "x-key",
        "x-api",
        "bearer",
        "credential",
        "private_key",
        "header",
    ];
    if MARKERS.iter().any(|marker| lower.contains(marker)) {
        return true;
    }
    // A quoted argument, an environment/flag assignment or a URL with a query
    // can carry a credential without any marker word: treat all three as
    // sensitive rather than guessing which ones are harmless.
    if text.contains(|character: char| matches!(character, '"' | '\'' | '=')) {
        return true;
    }
    if text.contains('?') {
        return true;
    }
    text.split_whitespace()
        .any(|word| word.starts_with("sk-") || word.starts_with("ghp_") || word.starts_with("xoxb-"))
        || text
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|run| {
                run.len() >= 32
                    && run
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            })
}

fn key_has_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    const MARKERS: [&str; 9] = [
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "api_key",
        "apikey",
        "credential",
        "private_key",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Character-budget truncation that never splits a UTF-8 boundary.
pub(crate) fn truncate_chars(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text.to_owned(), false);
    }
    (text.chars().take(limit).collect(), true)
}

/// Bounded SKILL.md frontmatter facts. Only `name` and `description` are read;
/// the body is never interpreted, executed or returned from the catalog.
pub(crate) struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

pub(crate) const MAX_LABEL_CHARS: usize = 200;

pub(crate) fn frontmatter(text: &str) -> Frontmatter {
    let mut lines = text.lines();
    let Some(first) = lines.next() else {
        return Frontmatter { name: None, description: None };
    };
    if first.trim_end() != "---" {
        return Frontmatter { name: None, description: None };
    }
    let mut block = String::new();
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" {
            break;
        }
        if block.len() + trimmed.len() > MAX_FILE_BYTES as usize {
            return Frontmatter { name: None, description: None };
        }
        block.push_str(trimmed);
        block.push('\n');
    }
    let Ok(value) = serde_yaml::from_str::<Value>(&block) else {
        return Frontmatter { name: None, description: None };
    };
    let label = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| truncate_chars(text, MAX_LABEL_CHARS).0)
    };
    Frontmatter { name: label("name"), description: label("description") }
}
