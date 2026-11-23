//! PiBot@6741737 center-server/data/index.js:33-34 (VISIBILITY_SCOPES, isVisibleToBot), 结构对照。
//! rakazo@51ff52e apps/api/src/bots/taught-skills.ts:304, 结构对照。
//! mikka-current@250d2451 lib/factory/agent-profile-skills.db.test.ts:43-73 (personal vs shared), 结构对照。
pub(super) fn is_visible_to_agent(owner: Option<&str>, scope: &str, agent: &str) -> bool {
    // Assigned stays private until per-assistant assignment lands.
    owner.is_none_or(|owner| owner == agent || scope == "global")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_matches_upstream_for_owned_and_unowned_skills() {
        for scope in ["private", "assigned", "global"] {
            assert!(is_visible_to_agent(None, scope, "other"));
            assert!(is_visible_to_agent(Some("owner"), scope, "owner"));
            assert_eq!(is_visible_to_agent(Some("owner"), scope, "other"), scope == "global");
        }
        assert!(!is_visible_to_agent(Some("owner"), "invalid", "other"));
    }
    #[test]
    fn private_skill_visibility_excludes_other_agents() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE member_skill_source(owner_agent_id TEXT, visibility_scope TEXT);
            INSERT INTO member_skill_source VALUES('A','private');").unwrap();
        let (owner, scope): (String, String) = db.query_row(
            "SELECT owner_agent_id,visibility_scope FROM member_skill_source", [],
            |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert!(is_visible_to_agent(Some(&owner), &scope, "A"));
        assert!(!is_visible_to_agent(Some(&owner), &scope, "B"));
    }
}
