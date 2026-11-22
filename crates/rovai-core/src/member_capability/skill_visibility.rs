//! PiBot center-server/data/index.js isVisibleToBot: unowned entries remain public.
pub(super) fn is_visible_to_agent(owner: Option<&str>, scope: &str, agent: &str) -> bool {
    owner.is_none_or(|owner| owner == agent || matches!(scope, "assigned" | "global"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_matches_upstream_for_owned_and_unowned_skills() {
        for scope in ["private", "assigned", "global"] {
            assert!(is_visible_to_agent(None, scope, "other"));
            assert!(is_visible_to_agent(Some("owner"), scope, "owner"));
            assert_eq!(is_visible_to_agent(Some("owner"), scope, "other"), scope != "private");
        }
        assert!(!is_visible_to_agent(Some("owner"), "invalid", "other"));
    }
}
