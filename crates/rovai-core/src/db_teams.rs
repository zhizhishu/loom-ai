//! Team templates and immutable Thread startup text; old input evidence stays byte-for-byte.
use super::*;

const CONTRACT5: &str = "contract_version IN ('native_session_bootstrap_v3', 'native_session_bootstrap_v4', 'native_session_bootstrap_v5')";
const CONTRACT6: &str = "(contract_version IN ('native_session_bootstrap_v3', 'native_session_bootstrap_v4', 'native_session_bootstrap_v5') OR contract_version = 'native_session_bootstrap_v6')";
const FORMAT5: &str = "bootstrap_formatter_version IN (3, 4, 5)";
const FORMAT6: &str =
    "(bootstrap_formatter_version IN (3, 4, 5) OR bootstrap_formatter_version = 6)";
const GUARD: &str = "native_session_bootstrap_evidence_v5_only_insert";

fn schema(c: &Connection, kind: &str, name: &str) -> rusqlite::Result<String> {
    c.query_row(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
        params![kind, name],
        |r| r.get(0),
    )
}

pub(super) fn schema_matches(c: &Connection, guidance_limit: usize) -> rusqlite::Result<bool> {
    Ok(single_chat_facts::schema_matches(c)?
        && schema(c, "table", "team").is_ok_and(|s| s.contains("CHECK(version >= 1)") && s.contains("json_valid(roster_json)") && s.contains(&format!("CHECK(length(guidance)<={guidance_limit})")))
        && schema(c, "table", "creation_preferences").is_ok_and(|s| s.contains("json_valid(state_json)"))
        && schema(c, "table", "thread_team_bootstrap").is_ok_and(|s| s.contains("REFERENCES camp(id) ON DELETE CASCADE") && s.contains(&format!("CHECK(length(guidance) BETWEEN 1 AND {guidance_limit})")))
        && schema(c, "trigger", "thread_team_bootstrap_immutable").is_ok_and(|s| s.contains("RAISE(ABORT"))
        && schema(c, "table", "native_session_bootstrap_evidence").is_ok_and(|s| s.contains(CONTRACT6) && s.contains(FORMAT6))
        && schema(c, "trigger", GUARD).is_ok_and(|s| s.contains("NEW.contract_version = 'native_session_bootstrap_v6' AND NEW.bootstrap_formatter_version = 6")))
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    database
        .connection
        .execute_batch("PRAGMA foreign_keys=OFF;")?;
    let result = (|| -> Result<()> {
        let tx = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        anyhow::ensure!(
            matches!(classify_database_contract(&tx)?, DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version==162),
            "Teams require schema 162"
        );
        let old = schema(&tx, "table", "native_session_bootstrap_evidence")?;
        anyhow::ensure!(
            old.contains(CONTRACT5) && old.contains(FORMAT5),
            "Unsupported Bootstrap schema"
        );
        let next = replacement_table_schema_v171(old, "native_session_bootstrap_evidence")
            .replace(CONTRACT5, CONTRACT6)
            .replace(FORMAT5, FORMAT6);
        rebuild_table_v171(
            &tx,
            "native_session_bootstrap_evidence",
            &next,
            &[],
            &[GUARD],
        )?;
        tx.execute_batch("CREATE TRIGGER native_session_bootstrap_evidence_v5_only_insert
            BEFORE INSERT ON native_session_bootstrap_evidence
            WHEN (NEW.contract_version IS NOT 'native_session_bootstrap_v5' OR NEW.bootstrap_formatter_version IS NOT 5)
                AND NOT (NEW.contract_version = 'native_session_bootstrap_v6' AND NEW.bootstrap_formatter_version = 6)
            BEGIN SELECT RAISE(ABORT, 'invalid Bootstrap version pair'); END;
            CREATE TABLE team(
                id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
                roster_json TEXT NOT NULL CHECK(json_valid(roster_json)),
                guidance TEXT NOT NULL CHECK(length(guidance)<=1000),
                version INTEGER NOT NULL CHECK(version >= 1), created_at TEXT NOT NULL
            );
            CREATE TABLE creation_preferences(
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                state_json TEXT NOT NULL CHECK(json_valid(state_json))
            );
            CREATE TABLE thread_team_bootstrap(
                camp_id TEXT PRIMARY KEY REFERENCES camp(id) ON DELETE CASCADE,
                guidance TEXT NOT NULL CHECK(length(guidance) BETWEEN 1 AND 1000)
            );
            CREATE TRIGGER thread_team_bootstrap_immutable BEFORE UPDATE ON thread_team_bootstrap
                BEGIN SELECT RAISE(ABORT, 'Thread startup text is immutable'); END;
            INSERT INTO schema_migration VALUES(213,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=163,updated_at=datetime('now') WHERE singleton=1;")?;
        validate_migration_foreign_keys(
            &tx,
            &["native_session_bootstrap_evidence", "thread_team_bootstrap"],
        )?;
        anyhow::ensure!(
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version == 163
            ),
            "Team schema admission failed"
        );
        tx.commit()?;
        Ok(())
    })();
    let restored = database.connection.execute_batch("PRAGMA foreign_keys=ON;");
    result?;
    restored?;
    Ok(())
}

// Only widen the two existing text constraints; retain all rows and triggers.
fn replace_guidance_limit(tx: &Transaction<'_>, from: usize, to: usize) -> Result<()> {
    for (table, constraint) in [
        ("team", "CHECK(length(guidance)<="),
        (
            "thread_team_bootstrap",
            "CHECK(length(guidance) BETWEEN 1 AND ",
        ),
    ] {
        let old = format!("{constraint}{from})");
        let source = schema(tx, "table", table)?;
        anyhow::ensure!(
            source.contains(&old),
            "Unsupported {table} guidance constraint"
        );
        let next = replacement_table_schema_v171(source, table)
            .replace(&old, &format!("{constraint}{to})"));
        rebuild_table_v171(tx, table, &next, &[], &[])?;
    }
    Ok(())
}

pub(super) fn migrate_guidance_limit(database: &mut Database) -> Result<()> {
    database
        .connection
        .execute_batch("PRAGMA foreign_keys=OFF;")?;
    let result = (|| -> Result<()> {
        let tx = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        anyhow::ensure!(
            matches!(classify_database_contract(&tx)?, DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version == 163),
            "Team guidance limit requires schema 163"
        );
        replace_guidance_limit(&tx, 1000, 10000)?;
        tx.execute_batch("INSERT INTO schema_migration VALUES(214,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=164,updated_at=datetime('now') WHERE singleton=1;")?;
        validate_migration_foreign_keys(&tx, &["team", "thread_team_bootstrap"])?;
        anyhow::ensure!(
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::Current(_)
                    | DatabaseContractClassification::SupportedMigrationSource(_)
            ),
            "Team guidance schema admission failed"
        );
        tx.commit()?;
        Ok(())
    })();
    let restored = database.connection.execute_batch("PRAGMA foreign_keys=ON;");
    result?;
    restored?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_guidance_limit_for_test(c: &Connection) {
    automation_naming::downgrade_for_test(c);
    if !c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=214)",
            [],
            |r| r.get::<_, bool>(0),
        )
        .unwrap()
    {
        return;
    }
    c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    let tx = c.unchecked_transaction().unwrap();
    replace_guidance_limit(&tx, 10000, 1000).unwrap();
    tx.execute_batch(
        "DELETE FROM schema_migration WHERE version=214;
        UPDATE rovai_data_contract SET projection_schema_version=163 WHERE singleton=1;",
    )
    .unwrap();
    tx.commit().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
}

#[cfg(test)]
pub(super) fn downgrade_for_test(c: &Connection) {
    downgrade_guidance_limit_for_test(c);
    if !c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=213)",
            [],
            |r| r.get::<_, bool>(0),
        )
        .unwrap()
    {
        return;
    }
    c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    let tx = c.unchecked_transaction().unwrap();
    // Migration fixtures without Team text can retain the previous Bootstrap pair.
    tx.execute_batch("UPDATE native_session_bootstrap_evidence SET contract_version='native_session_bootstrap_v5',bootstrap_formatter_version=5 WHERE contract_version='native_session_bootstrap_v6';").unwrap();
    let next = replacement_table_schema_v171(
        schema(&tx, "table", "native_session_bootstrap_evidence").unwrap(),
        "native_session_bootstrap_evidence",
    )
    .replace(CONTRACT6, CONTRACT5)
    .replace(FORMAT6, FORMAT5);
    rebuild_table_v171(
        &tx,
        "native_session_bootstrap_evidence",
        &next,
        &[],
        &[GUARD],
    )
    .unwrap();
    tx.execute_batch("CREATE TRIGGER native_session_bootstrap_evidence_v5_only_insert BEFORE INSERT ON native_session_bootstrap_evidence
        WHEN NEW.contract_version IS NOT 'native_session_bootstrap_v5' OR NEW.bootstrap_formatter_version IS NOT 5
        BEGIN SELECT RAISE(ABORT, 'new Bootstrap evidence must use v5'); END;
        DROP TABLE thread_team_bootstrap; DROP TABLE creation_preferences; DROP TABLE team;
        DELETE FROM schema_migration WHERE version=213;
        UPDATE rovai_data_contract SET projection_schema_version=162 WHERE singleton=1;").unwrap();
    tx.commit().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    // Schema 163 -> 164 has its own atomic DDL failure/reopen boundary.
    // A save-command test on an already-current schema cannot exercise it.
    #[test]
    fn guidance_limit_upgrade_preserves_rows_and_rolls_back() {
        let root = std::env::temp_dir().join(format!("rovai-team-limit-{}", Uuid::new_v4()));
        let mut db = crate::test_support::fresh_schema_database_fast_at(&root);
        downgrade_guidance_limit_for_test(db.connection());
        db.connection().execute_batch(r#"
            INSERT INTO team VALUES('kept-team','Review','{"memberAgentIds":["agent_1"],"defaultLeadAgentId":"agent_1"}','团队原文🌸',7,'kept-created');
            INSERT INTO creation_preferences VALUES(1,'{"newConversationTeamId":"kept-team","newConversationDefaults":null,"oneClickNewConversationEnabled":true,"newConversationDefaultsRequireConfirmation":false}');
            INSERT INTO camp(id,title,project_binding_kind,project_path,created_at,updated_at)
                VALUES('kept-thread','Keep','directory','/tmp',datetime('now'),datetime('now')),
                      ('long-thread','Long','directory','/tmp',datetime('now'),datetime('now')),
                      ('too-long-thread','Too long','directory','/tmp',datetime('now'),datetime('now'));
            INSERT INTO thread_team_bootstrap VALUES('kept-thread','会话原文\n🌸');
            CREATE TEMP TRIGGER fail_team_limit BEFORE INSERT ON schema_migration WHEN NEW.version=214
                BEGIN SELECT RAISE(ABORT,'limit rollback'); END;
        "#).unwrap();
        let team_before = serde_json::to_value(crate::teams::list(&db).unwrap()).unwrap();
        let preferences_before: String = db
            .connection()
            .query_row("SELECT state_json FROM creation_preferences", [], |r| {
                r.get(0)
            })
            .unwrap();
        let frozen_before = crate::teams::thread_guidance(db.connection(), "kept-thread").unwrap();
        assert!(
            migrate_guidance_limit(&mut db)
                .unwrap_err()
                .to_string()
                .contains("limit rollback")
        );
        assert!(schema_matches(db.connection(), 1000).unwrap());
        assert!(!schema_matches(db.connection(), 10000).unwrap());
        assert!(
            matches!(classify_database_contract(db.connection()).unwrap(), DatabaseContractClassification::SupportedMigrationSource(ref m) if m.projection_schema_version == 163)
        );
        assert!(!db.schema_migration_applied(214).unwrap());
        assert_eq!(
            serde_json::to_value(crate::teams::list(&db).unwrap()).unwrap(),
            team_before
        );
        assert_eq!(
            crate::teams::thread_guidance(db.connection(), "kept-thread").unwrap(),
            frozen_before
        );
        assert_eq!(
            db.connection()
                .query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(
            db.connection()
                .execute("UPDATE team SET guidance=?1", ["花".repeat(1001)])
                .is_err()
        );
        db.connection()
            .execute_batch("DROP TRIGGER fail_team_limit")
            .unwrap();
        drop(db);

        // Production opening must admit the old store and perform the migration.
        let db = Database::open(&root).unwrap();
        assert!(matches!(
            classify_database_contract(db.connection()).unwrap(),
            DatabaseContractClassification::Current(_)
        ));
        assert!(db.schema_migration_applied(214).unwrap());
        assert!(schema_matches(db.connection(), 10000).unwrap());
        assert!(!schema_matches(db.connection(), 1000).unwrap());
        assert_eq!(
            serde_json::to_value(crate::teams::list(&db).unwrap()).unwrap(),
            team_before
        );
        assert_eq!(
            db.connection()
                .query_row("SELECT state_json FROM creation_preferences", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            preferences_before
        );
        assert_eq!(
            crate::teams::thread_guidance(db.connection(), "kept-thread").unwrap(),
            frozen_before
        );
        let longest = "🌸".repeat(10000);
        db.connection()
            .execute("UPDATE team SET guidance=?1", [&longest])
            .unwrap();
        db.connection()
            .execute(
                "INSERT INTO thread_team_bootstrap VALUES('long-thread',?1)",
                [&longest],
            )
            .unwrap();
        assert_eq!(
            crate::teams::thread_guidance(db.connection(), "long-thread")
                .unwrap()
                .as_deref(),
            Some(longest.as_str())
        );
        let too_long = format!("{longest}花");
        assert!(
            db.connection()
                .execute("UPDATE team SET guidance=?1", [&too_long])
                .is_err()
        );
        assert!(
            db.connection()
                .execute(
                    "INSERT INTO thread_team_bootstrap VALUES('too-long-thread',?1)",
                    [&too_long]
                )
                .is_err()
        );
        assert!(db.connection().execute("UPDATE thread_team_bootstrap SET guidance='changed' WHERE camp_id='kept-thread'", []).is_err());
        assert!(
            db.connection()
                .execute(
                    "INSERT INTO thread_team_bootstrap VALUES('missing-thread','invalid')",
                    []
                )
                .is_err()
        );
        db.connection()
            .execute("DELETE FROM camp WHERE id='long-thread'", [])
            .unwrap();
        assert!(
            crate::teams::thread_guidance(db.connection(), "long-thread")
                .unwrap()
                .is_none()
        );
        drop(db);
        let db = Database::open(&root).unwrap();
        assert_eq!(crate::teams::list(&db).unwrap()[0].guidance, longest);
        assert_eq!(
            crate::teams::thread_guidance(db.connection(), "kept-thread").unwrap(),
            frozen_before
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
