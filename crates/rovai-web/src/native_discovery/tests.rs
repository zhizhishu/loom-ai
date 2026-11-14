//! Pure tests for the native discovery surface.
//!
//! Ownership boundary: home admission, the junction rule, parser strictness,
//! masking, content digests, declared-root/alias topology, shared bounds, the
//! error-not-empty rule, preview gates and the consented import preparation.
//! Temporary directories only: no Core, no Runtime, no socket, no process.

use super::scan::{self, Limits, ScanInput};
use super::{
    CatalogItem, CatalogRequest, Locate, NativeDiscovery, PreviewRequest, import, render_preview,
};
use serde_json::json;
use std::path::{Path, PathBuf};

fn fixture() -> PathBuf {
    let unique = format!(
        "loom-native-discovery-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn scan_home(home: &Path, limits: Limits) -> scan::ScanOutcome {
    scan_with(home, limits, false)
}

fn scan_with(home: &Path, limits: Limits, dsh_claude_live: bool) -> scan::ScanOutcome {
    scan::scan(&ScanInput {
        home: home.to_path_buf(),
        workspace: None,
        limits,
        dsh_claude_live,
    })
}

fn item<'a>(outcome: &'a scan::ScanOutcome, kind: &str, name: &str) -> &'a CatalogItem {
    outcome
        .items
        .iter()
        .find(|item| item.kind == kind && item.name == name)
        .unwrap_or_else(|| panic!("missing {kind} {name}: {:?}", outcome.items.len()))
}

fn skill(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n# body\n")
}

#[test]
fn claude_mcp_source_over_64k_is_discovered_with_a_bounded_recheck() {
    let root = fixture();
    let path = root.join(".claude.json");
    // Synthetic payload only; no user configuration or credential values.
    let config = json!({
        "mcpServers": {"sample": {"command": "node", "args": []}},
        "padding": "x".repeat(80 * 1024)
    }).to_string();
    assert!(config.len() > super::parse::MAX_FILE_BYTES as usize);
    assert!(config.len() < super::parse::MAX_CLAUDE_CONFIG_BYTES as usize);
    write(&path, &config);
    assert!(super::parse::read_bounded(&path).is_err());
    let scanned = scan_home(&root, Limits::default());
    let source = item(&scanned, scan::KIND_MCP, "sample");
    assert_eq!(source.runtime, "claude-code-cli");
    let prepared = import::prepare(
        source,
        &import::ImportMcpRequest {
            source_id: source.source_id.clone(),
            expected_digest: source.digest.clone(),
            expected_config_digest: "fixture".into(),
            consent: true,
            thread_id: None,
        },
    ).unwrap_or_else(|_| panic!("bounded Claude MCP import stays usable after scan"));
    assert_eq!(prepared.name, "sample");
    // Limit is finite even for the one admitted larger configuration.
    write(&path, &json!({"padding": "x".repeat(300 * 1024)}).to_string());
    let too_large = scan_home(&root, Limits::default());
    assert!(too_large.items.iter().all(|entry| entry.name != "sample"));
    assert!(too_large.errors.iter().any(|error| error.code == "native_config_unreadable" && error.runtime == "claude-code-cli"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn discovery_home_is_required_absolute_and_never_guessed() {
    let missing = NativeDiscovery {
        root: None,
        dsh_claude_live: false,
    };
    assert_eq!(
        missing.home().err(),
        Some("discovery_home_required"),
        "an unset discovery home must fail closed"
    );

    let root = fixture();
    let file = root.join("file");
    std::fs::write(&file, b"x").unwrap();
    assert!(NativeDiscovery::admitted(file).is_err());
    assert!(NativeDiscovery::admitted(PathBuf::from("relative/home")).is_err());

    let admitted = NativeDiscovery::admitted(root.clone()).unwrap();
    assert_eq!(admitted.home().unwrap(), root.as_path());
    assert!(!admitted.dsh_claude_live());
    // The owner switch is a value, not a filesystem guess.
    assert!(
        NativeDiscovery::admitted_with_dsh_source(root.clone(), true)
            .unwrap()
            .dsh_claude_live()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn junction_is_admitted_only_inside_a_known_native_skill_root() {
    let home = PathBuf::from("/home/user");
    let admitted = vec![
        home.join(".claude").join("skills"),
        home.join(".codex").join("skills"),
    ];
    // ends.json: one Codex junction per skill into the source tree.
    assert!(scan::target_within_admitted_root(
        &home.join(".claude/skills/tool"),
        &admitted
    ));
    assert!(!scan::target_within_admitted_root(
        &home.join(".claude/settings.json"),
        &admitted
    ));
    assert!(!scan::target_within_admitted_root(
        &PathBuf::from("/etc/skills"),
        &admitted
    ));
    assert!(!scan::target_within_admitted_root(
        &home.join(".pi/agent/skills"),
        &admitted
    ));
}

#[cfg(unix)]
#[test]
fn per_skill_junction_is_read_and_an_escape_is_refused() {
    let root = fixture();
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    std::fs::create_dir_all(root.join(".codex/skills")).unwrap();
    std::os::unix::fs::symlink(
        root.join(".claude/skills/tool"),
        root.join(".codex/skills/tool"),
    )
    .unwrap();
    let outside = root.join("outside/elsewhere");
    std::fs::create_dir_all(outside.join("bad")).unwrap();
    write(&outside.join("bad/SKILL.md"), &skill("bad", "d"));
    // A link needs its own parent directory; `create_dir_all` above only builds
    // the target. Without this the fixture fails before the scan runs.
    std::fs::create_dir_all(root.join(".dsh")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".dsh/skills")).unwrap();

    let outcome = scan_with(&root, Limits::default(), false);
    let claude = outcome
        .items
        .iter()
        .find(|item| item.kind == scan::KIND_SKILL && item.runtime == "claude-code-cli")
        .expect("source skill");
    let codex = outcome
        .items
        .iter()
        .find(|item| item.kind == scan::KIND_SKILL && item.runtime == "codex-cli")
        .expect("junctioned skill");
    assert_eq!(claude.digest, codex.digest, "a junction reads the same bytes");
    assert!(outcome.errors.iter().any(|error| error.code == "native_link_refused"
        && error.runtime == "deepseek-harness"));
    let refused = outcome
        .sources
        .iter()
        .find(|source| source.runtime == "deepseek-harness" && source.status == "refused")
        .expect("the refused link has its own diagnostic row");
    assert_eq!(refused.reason_code.as_deref(), Some("native_link_refused"));
    assert_eq!(refused.items, 0);
    assert!(!outcome.items.iter().any(|item| item.name == "bad"));
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn declared_root_is_compared_against_a_canonical_home() {
    let root = fixture();
    let real = root.join("real-home");
    write(&real.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    write(
        &real.join(".pi/agent/settings.json"),
        &json!({"skills": ["~/.claude/skills"]}).to_string(),
    );
    let linked = root.join("linked-home");
    std::os::unix::fs::symlink(&real, &linked).unwrap();

    // The admitted home is reached through a link, so its raw spelling differs
    // from the canonical spelling of every declared root. The fence must still
    // admit the declared root instead of refusing it.
    let outcome = scan_home(&linked, Limits::default());
    let pi_skill = outcome
        .items
        .iter()
        .find(|item| item.kind == scan::KIND_SKILL && item.runtime == "pi")
        .expect("a declared root inside a linked home stays admitted");
    assert_eq!(pi_skill.alias_source.as_deref(), Some("claude-code"));
    assert!(
        !outcome
            .errors
            .iter()
            .any(|error| error.code == "native_declared_root_refused"),
        "a canonical fence never refuses a root that is inside the home"
    );
    let pi_source = outcome
        .sources
        .iter()
        .find(|source| source.runtime == "pi" && source.kind == scan::KIND_SKILL)
        .expect("declared Pi source row");
    assert_eq!(pi_source.status, "read");
    assert_eq!(pi_source.declared, Some(true));
    assert_eq!(pi_source.alias_source.as_deref(), Some("claude-code"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn declared_root_outside_home_is_refused_even_when_it_exists() {
    let home = fixture();
    let outside = fixture();
    write(&outside.join("tool/SKILL.md"), &skill("tool", "d"));
    write(
        &home.join(".pi/agent/settings.json"),
        &json!({"skills": [outside.to_string_lossy()]}).to_string(),
    );

    let outcome = scan_home(&home, Limits::default());
    // An existing directory is still refused: the fence is the home, not
    // existence, and a settings file cannot widen the scan.
    assert!(
        outcome
            .errors
            .iter()
            .any(|error| error.code == "native_declared_root_refused")
    );
    assert!(
        !outcome
            .items
            .iter()
            .any(|item| item.runtime == "pi" && item.kind == scan::KIND_SKILL),
        "no skill outside the admitted home may be listed"
    );
    let refused = outcome
        .sources
        .iter()
        .find(|source| source.runtime == "pi" && source.status == "refused")
        .expect("refused declared source row");
    assert_eq!(
        refused.reason_code.as_deref(),
        Some("native_declared_root_outside_home")
    );
    assert_eq!(refused.path, "<declared>", "the declared text is never echoed");
    assert_eq!(refused.declared, Some(true));
    std::fs::remove_dir_all(home).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[test]
fn source_views_report_each_state_without_content() {
    let root = fixture();
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    let outcome = scan_home(&root, Limits::default());

    let claude = outcome
        .sources
        .iter()
        .find(|source| source.runtime == "claude-code-cli" && source.kind == scan::KIND_SKILL)
        .expect("read source row");
    assert_eq!(claude.status, "read");
    assert_eq!(claude.items, 1);
    assert_eq!(claude.truncated, Some(false));
    assert!(claude.reason_code.is_none());

    let codex = outcome
        .sources
        .iter()
        .find(|source| source.runtime == "codex-cli" && source.kind == scan::KIND_SKILL)
        .expect("absent source row");
    assert_eq!(codex.status, "absent");
    assert_eq!(codex.items, 0);

    let pi = outcome
        .sources
        .iter()
        .find(|source| source.runtime == "pi" && source.kind == scan::KIND_SKILL)
        .expect("Pi default source row");
    assert_eq!(pi.status, "absent");
    assert_eq!(pi.declared, Some(false));

    let settings = outcome
        .sources
        .iter()
        .find(|source| source.kind == "config" && source.path == ".claude/settings.json")
        .expect("absent config source row");
    assert_eq!(settings.status, "absent");

    // The wire shape stays camelCase and carries no content-bearing key.
    let value = serde_json::to_value(claude).unwrap();
    let map = value.as_object().unwrap();
    for key in ["runtime", "scope", "kind", "path", "status", "items"] {
        assert!(map.contains_key(key), "missing {key}");
    }
    assert!(!map.contains_key("content"));
    assert!(!map.contains_key("digest"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn skill_digest_is_content_bytes_and_source_id_is_path_identity() {
    let root = fixture();
    let entry = root.join(".claude/skills/tool/SKILL.md");
    write(&entry, &skill("frontmatter-name", "Frontmatter description."));
    let first = scan_home(&root, Limits::default());
    let first_item = item(&first, scan::KIND_SKILL, "frontmatter-name");
    assert_eq!(
        first_item.digest,
        super::parse::digest(&std::fs::read(&entry).unwrap()),
        "the digest is the SHA-256 of the admitted SKILL.md bytes"
    );
    assert_eq!(first_item.description.as_deref(), Some("Frontmatter description."));
    assert_eq!(
        first_item.source_path,
        // The scanner publishes admitted canonical paths, including Win32's
        // verbatim prefix; compare identity, not caller path spelling.
        root.join(".claude/skills/tool").canonicalize().unwrap().to_string_lossy().into_owned()
    );
    assert_eq!(
        first_item.skill_path.as_deref(),
        Some(entry.canonicalize().unwrap().to_string_lossy().into_owned().as_str())
    );
    let source_id = first_item.source_id.clone();

    // Edited content is the same source with a different digest.
    write(&entry, &skill("frontmatter-name", "Changed body."));
    let second = scan_home(&root, Limits::default());
    let second_item = item(&second, scan::KIND_SKILL, "frontmatter-name");
    assert_eq!(second_item.source_id, source_id, "identity is path+runtime");
    assert_ne!(second_item.digest, first_item.digest, "content integrity moved");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_parsers_reject_malformed_and_deep_documents() {
    assert!(super::parse::parse_json(b"{broken").is_err());
    assert!(super::parse::parse_yaml(b"key: [unclosed").is_err());
    assert!(super::parse::parse_toml(b"key = [unclosed").is_err());
    let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
    assert!(super::parse::parse_json(deep.as_bytes()).is_err());
    assert!(super::parse::parse_json(b"{\"a\":[1,2,3]}").is_ok());
}

#[test]
fn mcp_and_hook_metadata_never_echo_values() {
    let root = fixture();
    write(
        &root.join(".claude.json"),
        &json!({
            "mcpServers": {
                "fixture": {
                    "command": "npx --token=secret-value -y",
                    "args": ["--api-key", "secret-argument"],
                    "env": {"API_KEY": "secret-environment"},
                    "url": "https://user:pw@example.test/mcp?q=secret-query"
                }
            }
        })
        .to_string(),
    );
    write(
        &root.join(".claude/settings.json"),
        &json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "audit --token=secret-hook"}]}]}})
            .to_string(),
    );

    let outcome = scan_home(&root, Limits::default());
    let rendered = serde_json::to_string(&outcome.items).unwrap();
    for secret in [
        "secret-value",
        "secret-argument",
        "secret-environment",
        "secret-query",
        "secret-hook",
        "pw@",
        "-y",
    ] {
        assert!(!rendered.contains(secret), "catalog echoed {secret}: {rendered}");
    }
    assert!(rendered.contains("example.test"));
    assert!(rendered.contains("npx"));

    let hook = item(&outcome, scan::KIND_HOOK, "Stop#0");
    assert_eq!(
        hook.hook.as_ref().map(|hook| (hook.event.as_str(), hook.executed)),
        Some(("Stop", false))
    );
    assert!(
        !hook.importable,
        "a command carrying an assignment is not a normalizable snippet"
    );
    assert_eq!(
        hook.import.as_ref().and_then(|import| import.reason.as_deref()),
        Some("native_hook_contains_sensitive_fields")
    );

    let mcp = item(&outcome, scan::KIND_MCP, "fixture");
    assert!(mcp.importable, "Core mcp.servers.create is the real seam");
    assert_eq!(
        mcp.import.as_ref().and_then(|import| import.operation.as_deref()),
        Some("mcp.servers.create")
    );
    assert_eq!(mcp.compatibility, "native-only");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn codex_and_pi_hooks_stay_native_only() {
    let root = fixture();
    write(
        &root.join(".codex/hooks.json"),
        &json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "py hook.py --host=codex"}]}]}})
            .to_string(),
    );
    write(
        &root.join(".pi/agent/settings.json"),
        &json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "py hook.py"}]}]}}).to_string(),
    );
    let outcome = scan_home(&root, Limits::default());
    for runtime in ["codex-cli", "pi"] {
        let hook = outcome
            .items
            .iter()
            .find(|item| item.kind == scan::KIND_HOOK && item.runtime == runtime)
            .unwrap_or_else(|| panic!("{runtime} hook"));
        assert!(!hook.importable, "{runtime} hook must stay native-only");
        assert_eq!(
            hook.import.as_ref().and_then(|import| import.reason.as_deref()),
            Some("native_hook_not_normalizable")
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rules_are_importable_snippets_and_skills_need_core_inspect() {
    let root = fixture();
    write(&root.join(".codex/AGENTS.md"), "# rules");
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    let outcome = scan_home(&root, Limits::default());
    let rule = item(&outcome, scan::KIND_RULE, "AGENTS.md");
    assert!(rule.importable);
    assert_eq!(
        rule.import.as_ref().and_then(|import| import.operation.as_deref()),
        Some("members.capabilityCatalog.putItem")
    );
    let skill_item = item(&outcome, scan::KIND_SKILL, "tool");
    assert!(!skill_item.importable);
    assert_eq!(
        skill_item.import.as_ref().and_then(|import| import.operation.as_deref()),
        Some("skills.import.inspect")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn hook_bodies_with_quotes_headers_tokens_or_urls_stay_native_only() {
    let root = fixture();
    // Every one of these can carry a credential; none may become a snippet and
    // none may have its body returned.
    for command in [
        "audit --header X-Key: abc",
        "audit -h 'X-Key: abc'",
        "audit \"Authorization: Bearer abc\"",
        "audit API_KEY=abc",
        "audit https://example.test/mcp?token=abc",
        "audit --config=cfg.json",
    ] {
        let path = root.join(".claude/settings.json");
        write(
            &path,
            &json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": command}]}]}})
                .to_string(),
        );
        let outcome = scan_home(&root, Limits::default());
        let hook = outcome
            .items
            .iter()
            .find(|item| item.kind == scan::KIND_HOOK)
            .unwrap_or_else(|| panic!("hook item for {command}"));
        assert!(!hook.importable, "{command} must stay native-only");
        assert_eq!(
            hook.import.as_ref().and_then(|import| import.reason.as_deref()),
            Some("native_hook_contains_sensitive_fields"),
            "{command}"
        );
        let view = preview(hook);
        assert!(!view.available, "{command} body must be withheld");
        assert!(view.content.is_none(), "{command}");
        assert_eq!(
            view.reason.as_ref().map(|reason| reason.code.as_str()),
            Some("hook_body_sensitive_fields"),
            "{command}"
        );
    }

    // A bare program with plain flags is still importable and previewable.
    write(
        &root.join(".claude/settings.json"),
        &json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "audit --dry-run"}]}]}})
            .to_string(),
    );
    let outcome = scan_home(&root, Limits::default());
    let safe = outcome
        .items
        .iter()
        .find(|item| item.kind == scan::KIND_HOOK)
        .expect("safe hook");
    assert!(safe.importable);
    assert!(preview(safe).available);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn aliased_mcp_server_name_is_refused_instead_of_confused_between_keys() {
    let root = fixture();
    let path = root.join(".claude.json");
    write(
        &path,
        &json!({
            "mcp_servers": {"same": {"command": "benign-tool", "args": []}},
            "mcpServers": {"same": {"command": "evil-tool", "env": {"TOKEN": "synthetic-alias-secret"}}}
        })
        .to_string(),
    );
    let outcome = scan_home(&root, Limits::default());
    // Neither alias may be selected: the name is ambiguous inside one digest.
    assert!(
        !outcome
            .items
            .iter()
            .any(|item| item.kind == scan::KIND_MCP && item.name == "same"),
        "an ambiguous alias pair must not produce an importable item"
    );
    assert!(outcome.errors.iter().any(|error| error.code == "native_mcp_alias_ambiguous"));
    let rendered = serde_json::to_string(&outcome.items).unwrap();
    assert!(!rendered.contains("synthetic-alias-secret"));

    // With only the alias key present, the selected key's own definition is used.
    write(
        &path,
        &json!({"mcp_servers": {"same": {"command": "benign-tool", "args": []}}}).to_string(),
    );
    let outcome = scan_home(&root, Limits::default());
    let item = item(&outcome, scan::KIND_MCP, "same");
    let request = import::ImportMcpRequest {
        source_id: item.source_id.clone(),
        expected_digest: item.digest.clone(),
        expected_config_digest: format!("sha256:{}", "0".repeat(64)),
        consent: true,
        thread_id: None,
    };
    let prepared = import::prepare(item, &request).ok().expect("prepared");
    assert!(prepared.definition_json.contains("benign-tool"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn import_extraction_refuses_alias_ambiguity_even_for_a_synthetic_item() {
    let root = fixture();
    let path = root.join(".claude.json");
    write(
        &path,
        &json!({
            "mcp_servers": {"same": {"command": "benign-tool"}},
            "mcpServers": {"same": {"command": "evil-tool", "env": {"TOKEN": "synthetic-alias-secret"}}}
        })
        .to_string(),
    );
    let digest = super::parse::digest(&std::fs::read(&path).unwrap());
    // A synthetic item bypasses the scanner on purpose: the extraction layer must
    // refuse on its own, independent of the catalog's ambiguity check.
    let item = CatalogItem {
        kind: scan::KIND_MCP.to_owned(),
        runtime: "claude-code-cli".to_owned(),
        name: "same".to_owned(),
        description: None,
        source_id: super::source_id(scan::KIND_MCP, "claude-code-cli", "synthetic-alias"),
        source_path: path.to_string_lossy().into_owned(),
        skill_path: None,
        digest: digest.clone(),
        source_scope: "user".to_owned(),
        compatibility: "native-only".to_owned(),
        alias_source: None,
        importable: true,
        import: None,
        masked: None,
        hook: None,
        file: path.clone(),
        locate: Locate::McpServer {
            key: "mcp_servers".to_owned(),
        },
    };
    let request = import::ImportMcpRequest {
        source_id: item.source_id.clone(),
        expected_digest: digest,
        expected_config_digest: format!("sha256:{}", "0".repeat(64)),
        consent: true,
        thread_id: None,
    };
    assert!(matches!(
        import::prepare(&item, &request),
        Err(import::ImportFailure::AmbiguousAlias)
    ));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_ids_are_deterministic_namespaced_and_outside_the_library_namespace() {
    let root = fixture();
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    write(&root.join(".codex/AGENTS.md"), "# rules");
    let first = scan_home(&root, Limits::default());
    let second = scan_home(&root, Limits::default());
    let ids: Vec<&str> = first.items.iter().map(|item| item.source_id.as_str()).collect();
    assert_eq!(
        ids,
        second.items.iter().map(|item| item.source_id.as_str()).collect::<Vec<_>>()
    );
    for id in ids {
        assert!(id.starts_with("native:"), "{id}");
        assert!(!id.starts_with("library:"), "{id}");
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn shared_budget_truncates_and_reports_instead_of_hiding() {
    let root = fixture();
    for index in 0..8 {
        write(
            &root.join(format!(".claude/skills/tool{index}/SKILL.md")),
            &skill(&format!("tool{index}"), "d"),
        );
    }
    let limits = Limits {
        depth: scan::MAX_DEPTH,
        entries: scan::MAX_ENTRIES,
        items: 2,
    };
    let outcome = scan_home(&root, limits);
    assert_eq!(outcome.items.len(), 2);
    assert!(outcome.truncated.limit_hit);
    assert_eq!(outcome.truncated.visited_items, 2);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_or_oversized_config_is_an_error_for_that_runtime_only() {
    let root = fixture();
    write(&root.join(".codex/config.toml"), "model = [unclosed\n");
    write(&root.join(".dsh/settings.yaml"), "model: default\n");
    let outcome = scan_home(&root, Limits::default());
    assert!(outcome.errors.iter().any(|error| error.code == "native_config_invalid"
        && error.runtime == "codex-cli"));
    assert!(!outcome.items.iter().any(|item| item.runtime == "codex-cli"
        && item.kind == scan::KIND_MCP));
    assert!(outcome.errors.iter().all(|error| error.runtime != "deepseek-harness"));

    let oversized = root.join(".pi/agent/settings.json");
    write(&oversized, &"x".repeat((super::parse::MAX_FILE_BYTES as usize) + 1));
    let outcome = scan_home(&root, Limits::default());
    assert!(outcome.errors.iter().any(|error| error.code == "native_config_unreadable"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unknown_config_shape_is_reported_not_fabricated() {
    let root = fixture();
    write(
        &root.join(".claude.json"),
        &json!({"mcpServers": {"broken": "not-an-object"}}).to_string(),
    );
    write(
        &root.join(".claude/settings.json"),
        &json!({"hooks": {"Stop": "not-an-array"}}).to_string(),
    );
    let outcome = scan_home(&root, Limits::default());
    assert!(
        outcome
            .errors
            .iter()
            .filter(|error| error.code == "native_config_unknown_shape")
            .count()
            >= 2
    );
    assert!(!outcome.items.iter().any(|item| matches!(item.kind.as_str(), "mcp" | "hook")));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn pi_declared_root_and_mcp_import_are_admitted_only_inside_home() {
    let root = fixture();
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    write(
        &root.join(".claude.json"),
        &json!({"mcpServers": {"source-server": {"command": "npx", "args": []}}}).to_string(),
    );
    write(
        &root.join(".pi/agent/settings.json"),
        &json!({"skills": ["~/.claude/skills", "/definitely/outside/skills"]}).to_string(),
    );
    write(
        &root.join(".pi/agent/mcp.json"),
        &json!({"imports": ["claude-code", "unknown-end"]}).to_string(),
    );

    let outcome = scan_home(&root, Limits::default());
    let pi_skill = outcome
        .items
        .iter()
        .find(|item| item.kind == scan::KIND_SKILL && item.runtime == "pi")
        .expect("declared Pi root is read");
    assert_eq!(pi_skill.alias_source.as_deref(), Some("claude-code"));
    assert!(
        !pi_skill.source_path.contains(".pi"),
        "Pi owns no skill tree; the declared source is read in place"
    );
    assert!(outcome.errors.iter().any(|error| error.code == "native_declared_root_refused"));
    assert!(outcome.errors.iter().any(|error| error.code == "native_import_clause_unsupported"));

    let pi_mcp = outcome
        .items
        .iter()
        .find(|item| item.kind == scan::KIND_MCP && item.runtime == "pi")
        .expect("the known import clause reads source MCP");
    assert_eq!(pi_mcp.alias_source.as_deref(), Some("claude-code"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn dsh_live_mode_attributes_the_source_and_invents_no_directory() {
    let root = fixture();
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    write(&root.join(".claude.json"), &json!({"mcpServers": {"s": {"command": "npx"}}}).to_string());
    write(&root.join(".claude/CLAUDE.md"), "# rules");

    let off = scan_home(&root, Limits::default());
    assert!(!off.items.iter().any(|item| item.runtime == "deepseek-harness"));

    let on = scan_with(&root, Limits::default(), true);
    let dsh: Vec<&CatalogItem> = on
        .items
        .iter()
        .filter(|item| item.runtime == "deepseek-harness")
        .collect();
    assert!(!dsh.is_empty(), "live mode consumes the source tree");
    for item in &dsh {
        assert_eq!(item.alias_source.as_deref(), Some("claude-code"), "attribution kept");
        assert!(!item.source_path.contains(".dsh"), "no invented DSH directory");
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn request_bodies_admit_no_caller_supplied_path() {
    assert!(serde_json::from_value::<CatalogRequest>(json!({"path": "/etc"})).is_err());
    assert!(
        serde_json::from_value::<PreviewRequest>(json!({
            "sourceId": "native:codex-cli:rule:0",
            "expectedDigest": "0".repeat(64),
            "path": "/etc"
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<import::ImportMcpRequest>(json!({
            "sourceId": "native:codex-cli:mcp:0",
            "expectedDigest": "0".repeat(64),
            "expectedConfigDigest": "sha256:".to_owned() + &"0".repeat(64),
            "consent": true,
            "definitionJson": "{}"
        }))
        .is_err()
    );
    let ok = serde_json::from_value::<CatalogRequest>(json!({"threadId": "thread_1"}))
        .expect("only a thread id is admitted");
    assert_eq!(ok.thread_id.as_deref(), Some("thread_1"));
}

fn preview(item: &CatalogItem) -> super::PreviewResponse {
    render_preview(item).ok().expect("preview renders or withholds")
}

#[test]
fn preview_returns_rule_and_skill_markdown_and_withholds_mcp_and_secret_hooks() {
    let root = fixture();
    write(&root.join(".claude/CLAUDE.md"), &"# rules\n".repeat(20));
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    write(
        &root.join(".claude.json"),
        &json!({"mcpServers": {"fixture": {"command": "npx", "args": []}}}).to_string(),
    );
    write(
        &root.join(".claude/settings.json"),
        &json!({"hooks": {"Stop": [
            {"hooks": [{"type": "command", "command": "audit --token=secret-hook"}]},
            {"hooks": [{"type": "command", "command": "audit --dry-run"}]}
        ]}})
        .to_string(),
    );
    let outcome = scan_home(&root, Limits::default());

    let rule = preview(item(&outcome, scan::KIND_RULE, "CLAUDE.md"));
    assert!(rule.available);
    assert!(rule.content.as_ref().unwrap().text.starts_with("# rules"));

    let skill_view = preview(item(&outcome, scan::KIND_SKILL, "tool"));
    assert!(skill_view.available, "preview is explicit consent to read");
    assert_eq!(skill_view.content.as_ref().unwrap().format, "markdown");

    let mcp = preview(item(&outcome, scan::KIND_MCP, "fixture"));
    assert!(!mcp.available);
    assert!(mcp.content.is_none());
    assert_eq!(
        mcp.reason.as_ref().map(|reason| reason.code.as_str()),
        Some("mcp_body_not_returned")
    );

    let withheld = preview(item(&outcome, scan::KIND_HOOK, "Stop#0"));
    assert!(!withheld.available);
    assert_eq!(
        withheld.reason.as_ref().map(|reason| reason.code.as_str()),
        Some("hook_body_sensitive_fields")
    );

    let hook = preview(item(&outcome, scan::KIND_HOOK, "Stop#1"));
    assert!(hook.available);
    assert_eq!(hook.content.as_ref().unwrap().format, "json");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn preview_digest_mismatch_and_source_validators_refuse() {
    let root = fixture();
    write(&root.join(".codex/AGENTS.md"), "# rules");
    let outcome = scan_home(&root, Limits::default());
    let rule = item(&outcome, scan::KIND_RULE, "AGENTS.md");
    write(&root.join(".codex/AGENTS.md"), "# replacement");
    assert!(matches!(render_preview(rule), Err(super::PreviewFailure::Changed)));
    assert!(super::valid_source_id("native:codex-cli:rule:abc"));
    assert!(!super::valid_source_id("library:skill"));
    assert!(!super::valid_source_id("native:../../etc"));
    assert!(super::valid_config_digest(&"a".repeat(64)));
    assert!(super::valid_config_digest(&format!("sha256:{}", "a".repeat(64))));
    assert!(!super::valid_config_digest("sha256:zz"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn import_requires_consent_and_exact_digest_and_never_returns_values() {
    let root = fixture();
    write(
        &root.join(".claude.json"),
        &json!({"mcpServers": {"fixture": {
            "command": "npx",
            "args": ["--token", "synthetic-token-value"],
            "env": {"API_KEY": "synthetic-env-value"}
        }}})
        .to_string(),
    );
    let outcome = scan_home(&root, Limits::default());
    let mcp = item(&outcome, scan::KIND_MCP, "fixture");
    let request = |consent: bool, digest: &str| import::ImportMcpRequest {
        source_id: mcp.source_id.clone(),
        expected_digest: digest.to_owned(),
        expected_config_digest: format!("sha256:{}", "0".repeat(64)),
        consent,
        thread_id: None,
    };

    // No consent: refused before anything else happens.
    assert!(matches!(
        import::prepare(mcp, &request(false, &mcp.digest)),
        Err(import::ImportFailure::NotConsented)
    ));
    // Stale digest: refused before any Core call would be made.
    assert!(matches!(
        import::prepare(mcp, &request(true, &"f".repeat(64))),
        Err(import::ImportFailure::Changed)
    ));
    // A file that changed after the scan is also stale.
    let prepared_request = request(true, &mcp.digest);
    write(&root.join(".claude.json"), &json!({"mcpServers": {}}).to_string());
    assert!(matches!(
        import::prepare(mcp, &prepared_request),
        Err(import::ImportFailure::Changed)
    ));

    // Unsupported auth/policy fields fail explicitly instead of being stripped.
    write(
        &root.join(".claude.json"),
        &json!({"mcpServers": {"fixture": {"command": "npx", "oauth": {"scopes": ["x"]}}}}).to_string(),
    );
    let rescan = scan_home(&root, Limits::default());
    let oauth = item(&rescan, scan::KIND_MCP, "fixture");
    let oauth_request = import::ImportMcpRequest {
        source_id: oauth.source_id.clone(),
        expected_digest: oauth.digest.clone(),
        expected_config_digest: format!("sha256:{}", "0".repeat(64)),
        consent: true,
        thread_id: None,
    };
    assert!(matches!(
        import::prepare(oauth, &oauth_request),
        Err(import::ImportFailure::UnsupportedField)
    ));

    // A successful preparation carries the definition for Core only; the browser
    // projection carries facts and no value.
    write(
        &root.join(".claude.json"),
        &json!({"mcpServers": {"fixture": {"command": "npx", "env": {"API_KEY": "synthetic-env-value"}}}})
            .to_string(),
    );
    let rescan = scan_home(&root, Limits::default());
    let good = item(&rescan, scan::KIND_MCP, "fixture");
    let good_request = import::ImportMcpRequest {
        source_id: good.source_id.clone(),
        expected_digest: good.digest.clone(),
        expected_config_digest: format!("sha256:{}", "0".repeat(64)),
        consent: true,
        thread_id: None,
    };
    let prepared = import::prepare(good, &good_request).ok().expect("prepared");
    assert!(prepared.definition_json.contains("synthetic-env-value"));
    let projected = import::project(
        &json!({"status": "ok", "configDigest": "sha256:next", "config": {"servers": [{
            "serverId": "server-1", "name": "fixture", "enabled": false, "assignedAgentIds": [],
            "definitionJson": "{\"command\":\"npx\",\"env\":{\"API_KEY\":\"synthetic-env-value\"}}",
            "endpoint": "https://user:pw@example.test/mcp?token=synthetic-token-value"
        }]}}),
        &prepared.name,
    );
    let rendered = serde_json::to_string(&projected).unwrap();
    for secret in [
        "synthetic-token-value",
        "synthetic-env-value",
        "pw@",
        "definitionJson",
        "endpoint",
    ] {
        assert!(!rendered.contains(secret), "projection leaked {secret}: {rendered}");
    }
    assert_eq!(projected["status"], json!("ok"));
    assert_eq!(projected["serverId"], json!("server-1"));
    assert_eq!(projected["enabled"], json!(false), "Core creates disabled");
    assert_eq!(projected["assignedAgentIds"], json!([]), "Core creates unassigned");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn locators_stay_internal() {
    let root = fixture();
    write(&root.join(".claude/skills/tool/SKILL.md"), &skill("tool", "d"));
    let outcome = scan_home(&root, Limits::default());
    let skill_item = item(&outcome, scan::KIND_SKILL, "tool");
    assert!(matches!(&skill_item.locate, Locate::Skill));
    let rendered = serde_json::to_string(&outcome.items).unwrap();
    assert!(!rendered.contains("locate"));
    assert!(!rendered.contains("\"file\":"));
    std::fs::remove_dir_all(root).unwrap();
}
