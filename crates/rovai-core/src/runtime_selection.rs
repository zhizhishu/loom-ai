//! Which shipped Runtimes this Core process may offer at all.
//!
//! `LOOM_ENABLED_RUNTIMES` is a process-level, comma separated allow list. It
//! exists so one deployment (and its tests) can shrink the Runtime surface
//! without a database migration or a wire-format change.
//!
//! Scope is deliberately narrow. The variable may only restrict the four
//! Runtimes named below; every other [`AdapterKind`] keeps exactly the behavior
//! it had before the variable existed. An entry that cannot be parsed (unknown
//! id, empty field, duplicate) fails that *item* closed instead of silently
//! widening or narrowing the list: an unreadable selection must never grant a
//! Runtime the operator did not write.

use std::collections::BTreeSet;

use crate::agent_profile::AdapterKind;

/// The environment variable owned by this module.
pub const ENABLED_RUNTIMES_ENV: &str = "LOOM_ENABLED_RUNTIMES";

/// Blocker code for "the operator did not enable this Runtime in this process".
///
/// Distinct from `runtime_disabled_by_policy` (a product decision) and from the
/// platform admission codes (evidence decisions), so callers can tell an
/// operator deployment knob from a product or evidence refusal.
pub const RUNTIME_NOT_ENABLED_BLOCKER_CODE: &str = "runtime_not_enabled";

/// The four Runtimes whose availability this variable selects.
///
/// This is the only place the four are spelled out; every gate in the Core
/// derives from it, so the scope can never drift between call sites.
pub const SELECTABLE_RUNTIMES: [AdapterKind; 4] = [
    AdapterKind::CodexCli,
    AdapterKind::Pi,
    AdapterKind::DeepseekHarness,
    AdapterKind::ClaudeCodeCli,
];

/// Canonical ids and their short aliases. Canonical ids win; aliases exist
/// because operators write `pi`/`dsh` far more often than the long form.
const RUNTIME_SELECTION_ALIASES: &[(&str, AdapterKind)] = &[
    ("codex-cli", AdapterKind::CodexCli),
    ("codex", AdapterKind::CodexCli),
    ("pi", AdapterKind::Pi),
    ("deepseek-harness", AdapterKind::DeepseekHarness),
    ("dsh", AdapterKind::DeepseekHarness),
    ("claude-code-cli", AdapterKind::ClaudeCodeCli),
    ("claude", AdapterKind::ClaudeCodeCli),
];

/// One token of the variable, resolved or rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSelectionItem {
    /// A shipped Runtime the operator named.
    Enabled(AdapterKind),
    /// A token that names nothing this Core can start.
    Invalid,
}

/// Parse one raw token. Surrounding whitespace is ignored; everything else is
/// matched exactly (case-sensitively), so `PI` and `codex-cli-2` are invalid
/// rather than being coerced into a neighbor.
pub fn parse_runtime_selection_item(raw: &str) -> RuntimeSelectionItem {
    let token = raw.trim();
    if token.is_empty() {
        return RuntimeSelectionItem::Invalid;
    }
    RUNTIME_SELECTION_ALIASES
        .iter()
        .find(|(id, _)| *id == token)
        .map(|(_, kind)| RuntimeSelectionItem::Enabled(*kind))
        .unwrap_or(RuntimeSelectionItem::Invalid)
}

/// Parse the whole variable.
///
/// * `None` (variable absent) or an all-blank value selects every selectable
///   Runtime: the default deployment is unchanged.
/// * Otherwise the result is exactly the set of named Runtimes. Invalid and
///   duplicate tokens are dropped, so a typo leaves that Runtime off (fail
///   closed) rather than enabling something else.
pub fn parse_enabled_runtimes(raw: Option<&str>) -> BTreeSet<AdapterKind> {
    let Some(raw) = raw else {
        return SELECTABLE_RUNTIMES.into_iter().collect();
    };
    if raw.trim().is_empty() {
        return SELECTABLE_RUNTIMES.into_iter().collect();
    }
    raw.split(',')
        .filter_map(|token| match parse_runtime_selection_item(token) {
            RuntimeSelectionItem::Enabled(kind) => Some(kind),
            RuntimeSelectionItem::Invalid => None,
        })
        .collect()
}

/// Whether one Runtime is available in this process.
///
/// Runtimes outside [`SELECTABLE_RUNTIMES`] always return `true`: the variable
/// must not change any behavior it was never scoped to.
pub fn runtime_enabled_by_selection(enabled: &BTreeSet<AdapterKind>, kind: AdapterKind) -> bool {
    if !SELECTABLE_RUNTIMES.contains(&kind) {
        return true;
    }
    enabled.contains(&kind)
}

/// Read the variable once for this call. This is the only environment read for
/// the feature; tests exercise the pure functions above instead of mutating the
/// process environment.
pub fn enabled_runtimes_from_process() -> BTreeSet<AdapterKind> {
    parse_enabled_runtimes(std::env::var(ENABLED_RUNTIMES_ENV).ok().as_deref())
}

/// [`runtime_enabled_by_selection`] against the process environment.
pub fn runtime_enabled_in_process(kind: AdapterKind) -> bool {
    runtime_enabled_by_selection(&enabled_runtimes_from_process(), kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_ids_and_short_aliases_resolve_to_one_runtime_each() {
        for (raw, expected) in [
            ("codex-cli", AdapterKind::CodexCli),
            ("codex", AdapterKind::CodexCli),
            ("pi", AdapterKind::Pi),
            ("deepseek-harness", AdapterKind::DeepseekHarness),
            ("dsh", AdapterKind::DeepseekHarness),
            ("claude-code-cli", AdapterKind::ClaudeCodeCli),
            ("claude", AdapterKind::ClaudeCodeCli),
            ("  pi  ", AdapterKind::Pi),
        ] {
            assert_eq!(
                parse_runtime_selection_item(raw),
                RuntimeSelectionItem::Enabled(expected),
                "{raw}"
            );
        }
        for raw in [
            "",
            " ",
            "adapter",
            "opencode-cli",
            "cursor",
            "PI",
            "Pi",
            "dsh2",
            "codex-cli-2",
            "claude-code",
            "pi,",
            "deepseek_harness",
        ] {
            assert_eq!(
                parse_runtime_selection_item(raw),
                RuntimeSelectionItem::Invalid,
                "{raw}"
            );
        }
    }

    #[test]
    fn absent_or_blank_selection_enables_all_four() {
        let all: BTreeSet<AdapterKind> = SELECTABLE_RUNTIMES.into_iter().collect();
        assert_eq!(parse_enabled_runtimes(None), all);
        assert_eq!(parse_enabled_runtimes(Some("")), all);
        assert_eq!(parse_enabled_runtimes(Some("  \t\n")), all);
    }

    #[test]
    fn explicit_selection_enables_only_named_runtimes_and_drops_invalid_items() {
        assert_eq!(
            parse_enabled_runtimes(Some("pi")),
            BTreeSet::from([AdapterKind::Pi])
        );
        // Order, padding and duplicates do not matter.
        assert_eq!(
            parse_enabled_runtimes(Some(" dsh , codex ,pi,pi ")),
            BTreeSet::from([
                AdapterKind::DeepseekHarness,
                AdapterKind::CodexCli,
                AdapterKind::Pi
            ])
        );
        // An invalid item fails only itself closed: `claude` stays off even
        // though a neighboring token is valid.
        assert_eq!(
            parse_enabled_runtimes(Some("pi,nonsense")),
            BTreeSet::from([AdapterKind::Pi])
        );
        // A selection with nothing recognizable enables nothing at all.
        assert!(parse_enabled_runtimes(Some("nonsense,,")).is_empty());
    }

    #[test]
    fn selection_only_restricts_the_four_scoped_runtimes() {
        let only_pi = parse_enabled_runtimes(Some("pi"));
        assert!(runtime_enabled_by_selection(&only_pi, AdapterKind::Pi));
        for kind in [
            AdapterKind::CodexCli,
            AdapterKind::DeepseekHarness,
            AdapterKind::ClaudeCodeCli,
        ] {
            assert!(!runtime_enabled_by_selection(&only_pi, kind), "{kind:?}");
        }
        // Every unscoped Adapter keeps its pre-existing availability.
        for kind in AdapterKind::ALL {
            if SELECTABLE_RUNTIMES.contains(&kind) {
                continue;
            }
            assert!(
                runtime_enabled_by_selection(&only_pi, kind),
                "{kind:?} must not be affected by {ENABLED_RUNTIMES_ENV}"
            );
        }
        assert!(runtime_enabled_by_selection(
            &BTreeSet::new(),
            AdapterKind::OpencodeCli
        ));
    }
}
