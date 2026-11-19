//! Bounded read-only scan of the four admitted native client homes, using the
//! verified user topology (`skill-cli/tools/ends.json`, `docs/four-ends.md`):
//!
//! * Claude Code is the source tree: `~/.claude/skills`, `~/.claude/settings.json`
//!   (hooks), `~/.claude/CLAUDE.md` (rules), `~/.claude.json` (MCP).
//! * Codex keeps one junction per skill (`~/.codex/skills/<name>` → source),
//!   and its own `config.toml` / generated `hooks.json` / `AGENTS.md`.
//! * Pi holds no copy: `settings.json.skills` points at the source, `mcp.json`
//!   `imports: ["claude-code"]` reads the source MCP, `AGENTS.md` is generated.
//! * DSH with `dsh-claude` in `sourceMode: live` consumes the same source.
//!
//! The scan reads only those files and skill roots. It never writes, never
//! creates a directory, never executes a hook or MCP command and never resolves
//! a path a caller supplied.

use super::parse::{self, MASKED};
use super::{
    CatalogItem, DiscoveryError, HookView, ImportView, Locate, MaskedView, SourceView,
    TruncationView,
};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

pub(crate) const MAX_DEPTH: usize = 6;
pub(crate) const MAX_ENTRIES: usize = 4096;
pub(crate) const MAX_ITEMS: usize = 512;
/// A `settings.json` may declare a handful of roots, never a directory sweep.
const MAX_DECLARED_ROOTS: usize = 16;

pub(crate) const KIND_SKILL: &str = "skill";
pub(crate) const KIND_MCP: &str = "mcp";
pub(crate) const KIND_RULE: &str = "rule";
pub(crate) const KIND_HOOK: &str = "hook";

/// Existing Core seams for importing a discovered item.
pub(crate) const PUT_ITEM_OP: &str = "members.capabilityCatalog.putItem";
pub(crate) const MCP_CREATE_OP: &str = "mcp.servers.create";

/// Attribution marker for an item another client publishes but this one consumes.
pub(crate) const ALIAS_CLAUDE: &str = "claude-code";
/// The only `mcp.json` import clause this build understands.
const PI_IMPORT_CLAUSE: &str = "claude-code";

pub(crate) const RUNTIMES: [&str; 4] = [
    "claude-code-cli",
    "codex-cli",
    "deepseek-harness",
    "pi",
];

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub(crate) depth: usize,
    pub(crate) entries: usize,
    pub(crate) items: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            depth: MAX_DEPTH,
            entries: MAX_ENTRIES,
            items: MAX_ITEMS,
        }
    }
}

/// One budget shared by every runtime, alias and scope.
pub(crate) struct Budget {
    limits: Limits,
    entries: usize,
    items: usize,
    limit_hit: bool,
    visited: HashSet<(String, PathBuf)>,
}

impl Budget {
    fn new(limits: Limits) -> Self {
        Self {
            limits,
            entries: 0,
            items: 0,
            limit_hit: false,
            visited: HashSet::new(),
        }
    }

    fn entry(&mut self) -> bool {
        if self.entries >= self.limits.entries {
            self.limit_hit = true;
            return false;
        }
        self.entries += 1;
        true
    }

    fn item(&mut self) -> bool {
        if self.items >= self.limits.items {
            self.limit_hit = true;
            return false;
        }
        self.items += 1;
        true
    }

    fn depth(&self) -> usize {
        self.limits.depth
    }

    /// Cycle guard: one descent per runtime+canonical directory.
    fn visit(&mut self, runtime: &str, canonical: &Path) -> bool {
        self.visited
            .insert((runtime.to_owned(), canonical.to_path_buf()))
    }
}

pub(crate) struct ScanInput {
    pub(crate) home: PathBuf,
    pub(crate) workspace: Option<PathBuf>,
    pub(crate) limits: Limits,
    /// `LOOM_NATIVE_DSH_SOURCE_MODE=claude-live`, frozen at start-up.
    pub(crate) dsh_claude_live: bool,
}

pub(crate) struct ScanOutcome {
    pub(crate) items: Vec<CatalogItem>,
    pub(crate) errors: Vec<DiscoveryError>,
    pub(crate) truncated: TruncationView,
    /// Additive per-source diagnostics: one row per admitted skill root and one
    /// per admitted config file, whatever its outcome.
    pub(crate) sources: Vec<SourceView>,
}

#[derive(Clone, Copy)]
enum Format {
    Json,
    Toml,
    Yaml,
    Markdown,
}

#[derive(Clone, Copy)]
enum Role {
    /// Parsed for `mcpServers`/`mcp_servers`/`hooks`/`imports` keys only.
    Config,
    Rule,
}

struct FileSpec {
    runtime: &'static str,
    relative: &'static str,
    format: Format,
    role: Role,
    /// Set when another client publishes the file this runtime consumes.
    alias: Option<&'static str>,
}

const fn file(
    runtime: &'static str,
    relative: &'static str,
    format: Format,
    role: Role,
    alias: Option<&'static str>,
) -> FileSpec {
    FileSpec {
        runtime,
        relative,
        format,
        role,
        alias,
    }
}

fn files(dsh_claude_live: bool) -> Vec<FileSpec> {
    let mut specs = vec![
        // Claude Code: the source tree.
        file("claude-code-cli", ".claude/settings.json", Format::Json, Role::Config, None),
        file("claude-code-cli", ".claude.json", Format::Json, Role::Config, None),
        file("claude-code-cli", ".claude/CLAUDE.md", Format::Markdown, Role::Rule, None),
        // Codex: own config, generated hooks and rules, junctioned skills.
        file("codex-cli", ".codex/config.toml", Format::Toml, Role::Config, None),
        file("codex-cli", ".codex/hooks.json", Format::Json, Role::Config, None),
        file("codex-cli", ".codex/AGENTS.md", Format::Markdown, Role::Rule, None),
        // Pi: no copy of anything except its own settings and generated rules.
        file("pi", ".pi/agent/settings.json", Format::Json, Role::Config, None),
        file("pi", ".pi/agent/mcp.json", Format::Json, Role::Config, None),
        file("pi", ".pi/agent/AGENTS.md", Format::Markdown, Role::Rule, None),
        // DSH: its own settings document only.
        file("deepseek-harness", ".dsh/settings.yaml", Format::Yaml, Role::Config, None),
    ];
    if dsh_claude_live {
        // `dsh-claude` in live mode reads the source: hooks from
        // `~/.claude/settings.json`, MCP from `~/.claude.json`, rules from
        // `~/.claude/CLAUDE.md`. Attribution stays with Claude Code; no DSH
        // directory is invented.
        specs.push(file("deepseek-harness", ".claude/settings.json", Format::Json, Role::Config, Some(ALIAS_CLAUDE)));
        specs.push(file("deepseek-harness", ".claude.json", Format::Json, Role::Config, Some(ALIAS_CLAUDE)));
        specs.push(file("deepseek-harness", ".claude/CLAUDE.md", Format::Markdown, Role::Rule, Some(ALIAS_CLAUDE)));
    }
    specs
}

pub(crate) fn skill_root(base: &Path, runtime: &str) -> PathBuf {
    match runtime {
        "claude-code-cli" => base.join(".claude").join("skills"),
        "codex-cli" => base.join(".codex").join("skills"),
        "deepseek-harness" => base.join(".dsh").join("skills"),
        _ => base.join(".pi").join("agent").join("skills"),
    }
}

struct RootSpec {
    runtime: &'static str,
    path: PathBuf,
    scope: &'static str,
    alias: Option<&'static str>,
    /// `Some(true)` for a Pi root declared in `settings.json`, `Some(false)` for
    /// Pi's default root, `None` when the runtime has no declared-root concept.
    declared: Option<bool>,
}

/// Expand a declared `~/...` root without any shell or environment lookup.
fn declared_root(home: &Path, declared: &str) -> Option<PathBuf> {
    let declared = declared.trim();
    if declared.is_empty() || declared.len() > 4096 || declared.contains('\0') {
        return None;
    }
    let path = match declared.strip_prefix("~/").or_else(|| declared.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(declared),
    };
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return None;
    }
    Some(path)
}

/// The admitted skill roots of this scan. Only a real (non-link) directory is an
/// anchor, so a link can never define the set that admits links.
fn admitted_roots(roots: &[RootSpec]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter(|root| {
            std::fs::symlink_metadata(&root.path)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        })
        .filter_map(|root| root.path.canonicalize().ok())
        .collect()
}

/// Pure admission rule: a resolved link target is entered only when it sits
/// inside a known admitted native skill root. This *is* the junction policy that
/// `tools/ends.json` describes (one Codex junction per skill into the source).
pub(crate) fn target_within_admitted_root(target: &Path, admitted: &[PathBuf]) -> bool {
    admitted
        .iter()
        .any(|root| target == root.as_path() || target.starts_with(root))
}

fn resolve_entry(path: &Path, admitted: &[PathBuf]) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_symlink() {
        return Some(path.to_path_buf());
    }
    let target = std::fs::canonicalize(path).ok()?;
    target_within_admitted_root(&target, admitted).then_some(target)
}

pub(crate) fn scan(input: &ScanInput) -> ScanOutcome {
    let mut budget = Budget::new(input.limits);
    let mut items = Vec::new();
    let mut errors = Vec::new();
    let mut sources = Vec::new();
    let roots = declared_roots(input, &mut errors, &mut sources);
    let admitted = admitted_roots(&roots);
    for root in &roots {
        scan_skills(root, &admitted, &mut budget, &mut items, &mut errors, &mut sources);
    }
    for spec in files(input.dsh_claude_live) {
        scan_file(
            &input.home,
            &spec,
            &mut budget,
            &mut items,
            &mut errors,
            &mut sources,
        );
    }
    // Pi `mcp.json` `imports: ["claude-code"]` reads the source MCP file.
    if pi_imports_claude(&input.home, &mut budget, &mut errors) {
        let alias = file("pi", ".claude.json", Format::Json, Role::Config, Some(ALIAS_CLAUDE));
        scan_file(
            &input.home,
            &alias,
            &mut budget,
            &mut items,
            &mut errors,
            &mut sources,
        );
    }
    items.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.runtime.cmp(&right.runtime))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.source_id.cmp(&right.source_id))
    });
    ScanOutcome {
        items,
        errors,
        sources,
        truncated: TruncationView {
            limit_hit: budget.limit_hit,
            visited: budget.entries,
            visited_items: budget.items,
            depth: input.limits.depth,
        },
    }
}

/// User roots plus project roots. A declared Pi root is used instead of the
/// default `.pi/agent/skills` (which Pi does not hold), and never both.
fn declared_roots(
    input: &ScanInput,
    errors: &mut Vec<DiscoveryError>,
    sources: &mut Vec<SourceView>,
) -> Vec<RootSpec> {
    let mut roots = Vec::new();
    for runtime in ["claude-code-cli", "codex-cli"] {
        roots.push(RootSpec {
            runtime,
            path: skill_root(&input.home, runtime),
            scope: "user",
            alias: None,
            declared: None,
        });
    }
    // DSH live mode consumes the source tree; otherwise it owns `.dsh/skills`.
    roots.push(RootSpec {
        runtime: "deepseek-harness",
        path: if input.dsh_claude_live {
            skill_root(&input.home, "claude-code-cli")
        } else {
            skill_root(&input.home, "deepseek-harness")
        },
        scope: "user",
        alias: input.dsh_claude_live.then_some(ALIAS_CLAUDE),
        declared: None,
    });

    let settings = input.home.join(".pi/agent/settings.json");
    let declared = parse::read_bounded(&settings)
        .ok()
        .and_then(|bytes| parse::parse_json(&bytes).ok())
        .and_then(|value| {
            value
                .get("skills")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(Value::as_str)
                        .take(MAX_DECLARED_ROOTS)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
        })
        .unwrap_or_default();
    if declared.is_empty() {
        roots.push(RootSpec {
            runtime: "pi",
            path: skill_root(&input.home, "pi"),
            scope: "user",
            alias: None,
            declared: Some(false),
        });
    } else {
        // Every declared root below is canonicalized before it is compared, so
        // the fence must be the canonical spelling of the admitted home too. A
        // raw home path would refuse a legitimate root whenever `HOME` itself
        // contains a link (common on Linux), and a canonicalize failure must not
        // fall back to that untrusted spelling: without a fence nothing declared
        // is admitted.
        let fence = input.home.canonicalize().ok();
        let source = fence
            .as_ref()
            .map(|fence| skill_root(fence, "claude-code-cli"));
        for entry in declared {
            let Some(path) = declared_root(&input.home, &entry) else {
                errors.push(DiscoveryError::new(
                    "user",
                    "pi",
                    "native_declared_root_refused",
                    Some("<declared>".to_owned()),
                ));
                sources.push(refused_declared_source("native_declared_root_refused"));
                continue;
            };
            let Some(fence) = fence.as_ref() else {
                errors.push(DiscoveryError::new(
                    "user",
                    "pi",
                    "native_declared_root_refused",
                    Some("<declared>".to_owned()),
                ));
                sources.push(refused_declared_source("native_home_unverifiable"));
                continue;
            };
            // A declared root that does not resolve cannot be admitted. It is
            // reported instead of being dropped, and the declared text itself
            // never reaches the payload.
            let Ok(canonical) = path.canonicalize() else {
                errors.push(DiscoveryError::new(
                    "user",
                    "pi",
                    "native_declared_root_refused",
                    Some("<declared>".to_owned()),
                ));
                sources.push(refused_declared_source("native_declared_root_unresolved"));
                continue;
            };
            // A declared root is admitted only when it is inside the discovery
            // home; a settings file cannot point the scan somewhere else.
            if !canonical.starts_with(fence) {
                errors.push(DiscoveryError::new(
                    "user",
                    "pi",
                    "native_declared_root_refused",
                    Some(canonical.to_string_lossy().into_owned()),
                ));
                sources.push(refused_declared_source("native_declared_root_outside_home"));
                continue;
            }
            let alias = source
                .as_ref()
                .filter(|source| canonical.starts_with(source))
                .map(|_| ALIAS_CLAUDE);
            roots.push(RootSpec {
                runtime: "pi",
                path: canonical,
                scope: "user",
                alias,
                declared: Some(true),
            });
        }
    }

    let mut project = Vec::new();
    if let Some(workspace) = input.workspace.as_deref() {
        for runtime in RUNTIMES {
            project.push(RootSpec {
                runtime,
                path: skill_root(workspace, runtime),
                scope: "project",
                alias: None,
                declared: None,
            });
        }
    }
    roots.extend(project);
    roots
}

/// A declared Pi root that was refused never became a scan root, so its row is
/// built here. The path is the stable placeholder, never the declared text.
fn refused_declared_source(reason: &str) -> SourceView {
    let mut source = SourceView::new(
        "pi",
        "user",
        KIND_SKILL,
        "<declared>".to_owned(),
        "refused",
    );
    source.reason_code = Some(reason.to_owned());
    source.declared = Some(true);
    source
}

/// True when Pi declares the only import clause this build understands.
fn pi_imports_claude(home: &Path, budget: &mut Budget, errors: &mut Vec<DiscoveryError>) -> bool {
    let path = home.join(".pi/agent/mcp.json");
    let Ok(bytes) = parse::read_bounded_native_config(&path) else {
        return false;
    };
    let Ok(value) = parse::parse_json(&bytes) else {
        errors.push(DiscoveryError::new(
            "user",
            "pi",
            "native_config_invalid",
            Some(".pi/agent/mcp.json".to_owned()),
        ));
        return false;
    };
    let Some(imports) = value.get("imports") else {
        return false;
    };
    let Some(imports) = imports.as_array() else {
        errors.push(DiscoveryError::new(
            "user",
            "pi",
            "native_config_unknown_shape",
            Some(".pi/agent/mcp.json/imports".to_owned()),
        ));
        return false;
    };
    let _ = budget.entry();
    let mut known = false;
    for clause in imports {
        match clause.as_str() {
            Some(PI_IMPORT_CLAUSE) => known = true,
            _ => errors.push(DiscoveryError::new(
                "user",
                "pi",
                "native_import_clause_unsupported",
                Some(".pi/agent/mcp.json/imports".to_owned()),
            )),
        }
    }
    known
}

fn scan_skills(
    root: &RootSpec,
    admitted: &[PathBuf],
    budget: &mut Budget,
    items: &mut Vec<CatalogItem>,
    errors: &mut Vec<DiscoveryError>,
    sources: &mut Vec<SourceView>,
) {
    // One diagnostic row per admitted source, whatever the outcome. It reports
    // metadata the scan already admitted and never a file body.
    let mut source = SourceView::new(
        root.runtime,
        root.scope,
        KIND_SKILL,
        display_path(&root.path),
        "absent",
    );
    source.alias_source = root.alias.map(str::to_owned);
    source.declared = root.declared;
    let Ok(metadata) = std::fs::symlink_metadata(&root.path) else {
        sources.push(source);
        return;
    };
    let resolved = if metadata.file_type().is_symlink() {
        match resolve_entry(&root.path, admitted) {
            Some(target) => target,
            None => {
                errors.push(DiscoveryError::new(
                    root.scope,
                    root.runtime,
                    "native_link_refused",
                    Some(display_path(&root.path)),
                ));
                source.status = "refused".to_owned();
                source.reason_code = Some("native_link_refused".to_owned());
                sources.push(source);
                return;
            }
        }
    } else {
        root.path.clone()
    };
    let Ok(canonical) = resolved.canonicalize() else {
        errors.push(DiscoveryError::new(
            root.scope,
            root.runtime,
            "native_root_unreadable",
            Some(display_path(&resolved)),
        ));
        source.status = "unreadable".to_owned();
        source.reason_code = Some("native_root_unreadable".to_owned());
        sources.push(source);
        return;
    };
    if !canonical.is_dir() {
        sources.push(source);
        return;
    }
    source.path = display_path(&canonical);
    if !budget.visit(root.runtime, &canonical) {
        source.status = "skipped".to_owned();
        source.reason_code = Some("native_source_already_visited".to_owned());
        sources.push(source);
        return;
    }
    let before = items.len();
    let mut cut = false;
    let mut items_cut = false;
    let mut unreadable = false;
    let mut pending = vec![(canonical, 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            errors.push(DiscoveryError::new(
                root.scope,
                root.runtime,
                "native_root_unreadable",
                Some(display_path(&directory)),
            ));
            unreadable = true;
            continue;
        };
        for entry in entries.flatten() {
            if !budget.entry() {
                cut = true;
                break;
            }
            let path = entry.path();
            let Some(resolved) = resolve_entry(&path, admitted) else {
                errors.push(DiscoveryError::new(
                    root.scope,
                    root.runtime,
                    "native_link_refused",
                    Some(display_path(&path)),
                ));
                continue;
            };
            let Ok(metadata) = std::fs::symlink_metadata(&resolved) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let Ok(entry_root) = resolved.canonicalize() else {
                continue;
            };
            let entry_file = entry_root.join("SKILL.md");
            if std::fs::symlink_metadata(&entry_file).is_ok_and(|metadata| metadata.is_file()) {
                skill_item(
                    root,
                    &entry_root,
                    &entry_file,
                    budget,
                    items,
                    errors,
                    &mut items_cut,
                );
            }
            if depth + 1 < budget.depth() && budget.visit(root.runtime, &entry_root) {
                pending.push((entry_root, depth + 1));
            }
        }
        if cut {
            break;
        }
    }
    source.items = items.len() - before;
    if cut || items_cut {
        source.status = "truncated".to_owned();
        source.reason_code = Some("native_budget_limit".to_owned());
        source.truncated = Some(true);
    } else if source.items == 0 && unreadable {
        source.status = "unreadable".to_owned();
        source.reason_code = Some("native_root_unreadable".to_owned());
    } else {
        source.status = "read".to_owned();
        source.truncated = Some(false);
    }
    sources.push(source);
}

/// A Skill's digest is the SHA-256 of its admitted `SKILL.md` bytes. The
/// `source_id` identifies runtime+path, never content, so an edited file keeps
/// its identity and changes its digest.
fn skill_item(
    root: &RootSpec,
    entry_root: &Path,
    entry_file: &Path,
    budget: &mut Budget,
    items: &mut Vec<CatalogItem>,
    errors: &mut Vec<DiscoveryError>,
    items_cut: &mut bool,
) {
    let Ok(bytes) = parse::read_bounded(entry_file) else {
        errors.push(DiscoveryError::new(
            root.scope,
            root.runtime,
            "native_skill_unreadable",
            Some(display_path(entry_file)),
        ));
        return;
    };
    if !budget.item() {
        *items_cut = true;
        return;
    }
    let digest = parse::digest(&bytes);
    let text = String::from_utf8_lossy(&bytes);
    let front = parse::frontmatter(&text);
    let directory_name = entry_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = front
        .name
        .as_deref()
        .and_then(|name| {
            let (trimmed, truncated) = parse::truncate_chars(name, 120);
            (!truncated).then_some(trimmed)
        })
        .unwrap_or(directory_name);
    let identity = format!("{}|{}|{}", root.runtime, root.scope, display_path(entry_root));
    items.push(CatalogItem {
        kind: KIND_SKILL.to_owned(),
        runtime: root.runtime.to_owned(),
        name,
        description: front.description,
        source_id: super::source_id(KIND_SKILL, root.runtime, &identity),
        source_path: display_path(entry_root),
        skill_path: Some(display_path(entry_file)),
        digest,
        source_scope: root.scope.to_owned(),
        compatibility: "native-only".to_owned(),
        alias_source: root.alias.map(str::to_owned),
        importable: false,
        import: Some(ImportView {
            status: "not-importable".to_owned(),
            operation: Some("skills.import.inspect".to_owned()),
            reason: Some("core_skill_import_requires_inspect".to_owned()),
        }),
        masked: None,
        hook: None,
        file: entry_file.to_path_buf(),
        locate: Locate::Skill,
    });
}

fn scan_file(
    home: &Path,
    spec: &FileSpec,
    budget: &mut Budget,
    items: &mut Vec<CatalogItem>,
    errors: &mut Vec<DiscoveryError>,
    sources: &mut Vec<SourceView>,
) {
    let path = home.join(spec.relative);
    // The row names the admitted relative spec, never a resolved absolute path
    // and never any part of the file body.
    let kind = match spec.role {
        Role::Rule => KIND_RULE,
        Role::Config => "config",
    };
    let mut source = SourceView::new(
        spec.runtime,
        "user",
        kind,
        spec.relative.to_owned(),
        "absent",
    );
    source.alias_source = spec.alias.map(str::to_owned);
    let bytes = match parse::read_bounded_native_config(&path) {
        Ok(bytes) => bytes,
        Err(_) => {
            // Absence is not a fault. A present but unreadable or oversized file
            // is an error for this runtime, never a fabricated empty view.
            if std::fs::symlink_metadata(&path).is_ok() {
                errors.push(DiscoveryError::new(
                    "user",
                    spec.runtime,
                    "native_config_unreadable",
                    Some(spec.relative.to_owned()),
                ));
                source.status = "unreadable".to_owned();
                source.reason_code = Some("native_config_unreadable".to_owned());
            }
            sources.push(source);
            return;
        }
    };
    let digest = parse::digest(&bytes);
    match spec.role {
        Role::Rule => {
            if !budget.item() {
                source.status = "truncated".to_owned();
                source.reason_code = Some("native_budget_limit".to_owned());
                source.truncated = Some(true);
                sources.push(source);
                return;
            }
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            items.push(CatalogItem {
                kind: KIND_RULE.to_owned(),
                runtime: spec.runtime.to_owned(),
                name,
                description: None,
                source_id: super::source_id(KIND_RULE, spec.runtime, &display_path(&path)),
                source_path: display_path(&path),
                skill_path: None,
                digest,
                source_scope: "user".to_owned(),
                compatibility: "native-only".to_owned(),
                alias_source: spec.alias.map(str::to_owned),
                // A Markdown rule is a plain snippet: `putItem` already accepts
                // exactly this shape as a rule body.
                importable: true,
                import: Some(ImportView {
                    status: "importable".to_owned(),
                    operation: Some(PUT_ITEM_OP.to_owned()),
                    reason: Some("rule_snippet_seam".to_owned()),
                }),
                masked: None,
                hook: None,
                file: path,
                locate: Locate::Config,
            });
            source.items = 1;
            source.status = "read".to_owned();
            source.truncated = Some(false);
            sources.push(source);
        }
        Role::Config => {
            let parsed = match spec.format {
                Format::Json => parse::parse_json(&bytes),
                Format::Toml => parse::parse_toml(&bytes),
                Format::Yaml => parse::parse_yaml(&bytes),
                Format::Markdown => Err(anyhow::anyhow!("native_config_format_mismatch")),
            };
            let value = match parsed {
                Ok(value) => value,
                Err(_) => {
                    errors.push(DiscoveryError::new(
                        "user",
                        spec.runtime,
                        "native_config_invalid",
                        Some(spec.relative.to_owned()),
                    ));
                    source.status = "refused".to_owned();
                    source.reason_code = Some("native_config_invalid".to_owned());
                    sources.push(source);
                    return;
                }
            };
            let before = items.len();
            let limit_hit_before = budget.limit_hit;
            scan_mcp(spec, &path, &digest, &value, budget, items, errors);
            scan_hooks(spec, &path, &digest, &value, budget, items, errors);
            source.items = items.len() - before;
            if budget.limit_hit && !limit_hit_before {
                source.status = "truncated".to_owned();
                source.reason_code = Some("native_budget_limit".to_owned());
                source.truncated = Some(true);
            } else {
                source.status = "read".to_owned();
                source.truncated = Some(false);
            }
            sources.push(source);
        }
    }
}

fn scan_mcp(
    spec: &FileSpec,
    path: &Path,
    digest: &str,
    value: &Value,
    budget: &mut Budget,
    items: &mut Vec<CatalogItem>,
    errors: &mut Vec<DiscoveryError>,
) {
    // A file may declare the same server name under both aliases. Iterating the
    // aliases independently would let one item select the other's definition,
    // so an ambiguous name is refused outright and never becomes an item.
    let mut groups: Vec<(&'static str, Map<String, Value>)> = Vec::new();
    for key in ["mcpServers", "mcp_servers"] {
        let Some(servers) = value.get(key) else {
            continue;
        };
        let Some(servers) = servers.as_object() else {
            errors.push(DiscoveryError::new(
                "user",
                spec.runtime,
                "native_config_unknown_shape",
                Some(format!("{}/{key}", spec.relative)),
            ));
            continue;
        };
        groups.push((key, servers.clone()));
    }
    let mut ambiguous: HashSet<String> = HashSet::new();
    if groups.len() > 1 {
        for (name, _) in &groups[0].1 {
            if groups[1..].iter().any(|(_, servers)| servers.contains_key(name)) {
                ambiguous.insert(name.clone());
            }
        }
    }
    for name in &ambiguous {
        errors.push(DiscoveryError::new(
            "user",
            spec.runtime,
            "native_mcp_alias_ambiguous",
            Some(format!("{}/{name}", spec.relative)),
        ));
    }
    for (key, servers) in groups {
        for (name, definition) in &servers {
            if ambiguous.contains(name) {
                continue;
            }
            if definition.as_object().is_none() {
                errors.push(DiscoveryError::new(
                    "user",
                    spec.runtime,
                    "native_config_unknown_shape",
                    Some(format!("{}/{key}/{name}", spec.relative)),
                ));
                continue;
            }
            if !budget.item() {
                return;
            }
            items.push(CatalogItem {
                kind: KIND_MCP.to_owned(),
                runtime: spec.runtime.to_owned(),
                name: name.clone(),
                description: None,
                source_id: super::source_id(
                    KIND_MCP,
                    spec.runtime,
                    &format!("{digest}:{key}:{name}"),
                ),
                source_path: display_path(path),
                skill_path: None,
                digest: digest.to_owned(),
                source_scope: "user".to_owned(),
                compatibility: "native-only".to_owned(),
                alias_source: spec.alias.map(str::to_owned),
                // The exact seam is Core `mcp.servers.create`: created disabled
                // and unassigned (mcp.rs create), definition never returned here.
                importable: true,
                import: Some(ImportView {
                    status: "importable".to_owned(),
                    operation: Some(MCP_CREATE_OP.to_owned()),
                    reason: Some("consented_native_import".to_owned()),
                }),
                masked: Some(mask_server(definition)),
                hook: None,
                file: path.to_path_buf(),
                // The exact parent key travels with the item, so import reads
                // only the alias the user actually selected.
                locate: Locate::McpServer {
                    key: key.to_owned(),
                },
            });
        }
    }
}

/// Only shape metadata leaves this function: an executable basename, argument
/// and environment counts, and a URL origin. No value is echoed.
pub(crate) fn mask_server(definition: &Value) -> MaskedView {
    let command = definition
        .get("command")
        .and_then(Value::as_str)
        .map(parse::command_basename)
        .unwrap_or_else(|| MASKED.to_owned());
    let args_count = definition
        .get("args")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let env_count = definition
        .get("env")
        .and_then(Value::as_object)
        .map_or(0, Map::len);
    let url_origin = definition
        .get("url")
        .and_then(Value::as_str)
        .and_then(parse::url_origin);
    MaskedView {
        command,
        args_count,
        env_count,
        url_origin,
    }
}

fn scan_hooks(
    spec: &FileSpec,
    path: &Path,
    digest: &str,
    value: &Value,
    budget: &mut Budget,
    items: &mut Vec<CatalogItem>,
    errors: &mut Vec<DiscoveryError>,
) {
    let Some(events) = value.get("hooks") else {
        return;
    };
    let Some(events) = events.as_object() else {
        errors.push(DiscoveryError::new(
            "user",
            spec.runtime,
            "native_config_unknown_shape",
            Some(format!("{}/hooks", spec.relative)),
        ));
        return;
    };
    for (event, entries) in events {
        let Value::Array(entries) = entries else {
            errors.push(DiscoveryError::new(
                "user",
                spec.runtime,
                "native_config_unknown_shape",
                Some(format!("{}/hooks/{event}", spec.relative)),
            ));
            continue;
        };
        for (index, entry) in entries.iter().enumerate() {
            if !budget.item() {
                return;
            }
            let name = format!("{event}#{index}");
            // Only a Claude-shaped command hook normalizes losslessly to
            // `{hooks:{event:[...]}}`; a generated or Pi hook stays native-only.
            let normalized = spec.alias.is_some() || spec.runtime == "claude-code-cli";
            // A marker scan cannot prove a command body free of credentials, so
            // a body is importable/previewable only when it passes a strict
            // whitelist: no quotes, assignments, header flags, URLs or queries.
            let body_allowed = safe_command_body(entry);
            let importable = normalized && body_allowed;
            let reason = if importable {
                "normalized_command_hook"
            } else if normalized {
                "native_hook_contains_sensitive_fields"
            } else {
                "native_hook_not_normalizable"
            };
            items.push(CatalogItem {
                kind: KIND_HOOK.to_owned(),
                runtime: spec.runtime.to_owned(),
                name,
                description: None,
                source_id: super::source_id(
                    KIND_HOOK,
                    spec.runtime,
                    &format!("{digest}:{event}:{index}"),
                ),
                source_path: display_path(path),
                skill_path: None,
                digest: digest.to_owned(),
                source_scope: "user".to_owned(),
                compatibility: "native-only".to_owned(),
                alias_source: spec.alias.map(str::to_owned),
                importable,
                import: Some(if importable {
                    ImportView {
                        status: "importable".to_owned(),
                        operation: Some(PUT_ITEM_OP.to_owned()),
                        reason: Some(reason.to_owned()),
                    }
                } else {
                    ImportView {
                        status: "not-importable".to_owned(),
                        operation: None,
                        reason: Some(reason.to_owned()),
                    }
                }),
                masked: None,
                // The hook body is never returned here and never executed.
                hook: Some(HookView {
                    event: event.clone(),
                    executed: false,
                }),
                file: path.to_path_buf(),
                locate: Locate::Hook {
                    event: event.clone(),
                    index,
                    body_allowed,
                },
            });
        }
    }
}

/// Strict whitelist for a hook body: a bare program and plain flags only.
/// Quoted strings, `=`/env assignments, header/credential flags, URLs and query
/// strings all disqualify the body, so no unknown field can reach a snippet.
fn safe_command_body(entry: &Value) -> bool {
    let Some(hooks) = entry.get("hooks").and_then(Value::as_array) else {
        return false;
    };
    if hooks.is_empty() {
        return false;
    }
    hooks.iter().all(|hook| {
        let Some(object) = hook.as_object() else {
            return false;
        };
        if !object
            .keys()
            .all(|key| matches!(key.as_str(), "type" | "command" | "timeout"))
        {
            return false;
        }
        object.get("type").and_then(Value::as_str) == Some("command")
            && object
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(safe_command)
    })
}

fn safe_command(command: &str) -> bool {
    if command.is_empty() || command.len() > 4096 {
        return false;
    }
    if command.contains(|character: char| {
        matches!(
            character,
            '"' | '\'' | '=' | '?' | '&' | '|' | '>' | '<' | '$' | '`' | ';' | '\n' | '\r'
        )
    }) {
        return false;
    }
    let lower = command.to_ascii_lowercase();
    if lower.contains("://") {
        return false;
    }
    const SENSITIVE_WORDS: [&str; 8] = [
        "-h",
        "--header",
        "authorization",
        "bearer",
        "token",
        "api-key",
        "apikey",
        "secret",
    ];
    !lower
        .split_whitespace()
        .any(|word| SENSITIVE_WORDS.contains(&word))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
