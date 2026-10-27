//! LOOM orchestration projection: plan, task and dependency facts for one Mission.
//! This migration only creates the tables; the single write path is
//! `loom::plan_import`, which validates the whole graph in one transaction.
use super::*;

const PLAN_TABLE: &str = "loom_plan";
const TASK_TABLE: &str = "loom_task";
const DEPENDENCY_TABLE: &str = "loom_dependency";

/// Task states follow the LOOM control-plane contract
/// (DRAFT → READY → BLOCKED → IN_REVIEW → DONE / CANCELED).
const TASK_STATUS: &str =
    "CHECK(status IN ('DRAFT','READY','BLOCKED','IN_REVIEW','DONE','CANCELED'))";
/// Dependency release conditions come from the same contract.
const DEPENDENCY_CONDITION: &str = "CHECK(condition IN ('TASK_DONE','ARTIFACT_ACCEPTED'))";

fn create_sql() -> String {
    format!(
        r#"
        CREATE TABLE {PLAN_TABLE} (
            plan_id TEXT PRIMARY KEY,
            mission_id TEXT NOT NULL UNIQUE REFERENCES mission(id) ON DELETE CASCADE,
            goal TEXT NOT NULL CHECK(length(goal) BETWEEN 1 AND 4000),
            acceptance_criteria_json TEXT NOT NULL
                CHECK(json_valid(acceptance_criteria_json) AND json_type(acceptance_criteria_json)='array'),
            created_at TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 1)
        );
        CREATE TABLE {TASK_TABLE} (
            task_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL REFERENCES {PLAN_TABLE}(plan_id) ON DELETE CASCADE,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
            description TEXT NOT NULL CHECK(length(description) <= 16000),
            assignee_agent_id TEXT,
            status TEXT NOT NULL {TASK_STATUS},
            acceptance_criteria_json TEXT NOT NULL
                CHECK(json_valid(acceptance_criteria_json) AND json_type(acceptance_criteria_json)='array'),
            blocked_reason TEXT CHECK(blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 2000),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 1),
            UNIQUE(plan_id, task_id)
        );
        CREATE INDEX loom_task_plan_idx ON {TASK_TABLE}(plan_id, task_id);
        CREATE TABLE {DEPENDENCY_TABLE} (
            dependency_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            upstream_task_id TEXT NOT NULL,
            downstream_task_id TEXT NOT NULL,
            condition TEXT NOT NULL {DEPENDENCY_CONDITION},
            resolved_artifact_id TEXT,
            resolved_at TEXT,
            upstream_task_revision INTEGER
                CHECK(upstream_task_revision IS NULL OR upstream_task_revision >= 1),
            candidate_id TEXT,
            review_id TEXT,
            created_at TEXT NOT NULL,
            CHECK(upstream_task_id <> downstream_task_id),
            FOREIGN KEY(plan_id, upstream_task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE,
            FOREIGN KEY(plan_id, downstream_task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE,
            UNIQUE(plan_id, upstream_task_id, downstream_task_id)
        );
        CREATE INDEX loom_dependency_plan_idx ON {DEPENDENCY_TABLE}(plan_id, dependency_id);
        "#
    )
}

fn table_sql(connection: &Connection, table: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get(0),
        )
        .optional()
}

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let compact = |sql: &str| sql.split_whitespace().collect::<String>();
    let holds = |table: &str, tokens: &[&str]| -> rusqlite::Result<bool> {
        Ok(table_sql(connection, table)?.is_some_and(|sql| {
            let sql = compact(&sql);
            tokens.iter().all(|token| sql.contains(&compact(token)))
        }))
    };
    Ok(holds(
        PLAN_TABLE,
        &[
            "mission_id TEXT NOT NULL UNIQUE REFERENCES mission(id) ON DELETE CASCADE",
            "json_valid(acceptance_criteria_json)",
            "revision INTEGER NOT NULL CHECK(revision >= 1)",
        ],
    )? && holds(
        TASK_TABLE,
        &[TASK_STATUS, "UNIQUE(plan_id, task_id)", "json_valid(acceptance_criteria_json)"],
    )? && holds(
        DEPENDENCY_TABLE,
        &[
            DEPENDENCY_CONDITION,
            "CHECK(upstream_task_id <> downstream_task_id)",
            "REFERENCES loom_task(plan_id, task_id)",
        ],
    )?)
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
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::SupportedMigrationSource(ref marker)
                    if marker.projection_schema_version == 167
            ),
            "LOOM projection requires schema 167"
        );
        tx.execute_batch(&create_sql())?;
        tx.execute_batch(
            "INSERT INTO schema_migration VALUES(218,datetime('now'));
            UPDATE rovai_data_contract SET projection_schema_version=168,updated_at=datetime('now') WHERE singleton=1;",
        )?;
        validate_migration_foreign_keys(&tx, &[PLAN_TABLE, TASK_TABLE, DEPENDENCY_TABLE])?;
        anyhow::ensure!(
            matches!(
                classify_database_contract(&tx)?,
                DatabaseContractClassification::Current(_)
            ),
            "LOOM projection schema admission failed"
        );
        tx.commit()?;
        Ok(())
    })();
    let restored = database.connection.execute_batch("PRAGMA foreign_keys=ON;");
    result?;
    restored?;
    Ok(())
}

/// Only synthetic migration fixtures reverse this projection; product code never drops it.
#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    let applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=218)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    if !applied {
        return;
    }
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
            DROP TABLE IF EXISTS loom_dependency;
            DROP TABLE IF EXISTS loom_task;
            DROP TABLE IF EXISTS loom_plan;
            PRAGMA foreign_keys=ON;
            DELETE FROM schema_migration WHERE version=218;
            UPDATE rovai_data_contract SET projection_schema_version=167 WHERE singleton=1;",
        )
        .unwrap();
}
