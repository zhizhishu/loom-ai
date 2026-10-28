//! LOOM orchestration projection: plan, task and dependency facts for one Mission, plus the
//! lease claim that binds a Task to one AgentRun. This module only owns the tables; the write
//! paths are `loom::plan_import`, `loom::task_release` and `loom::claim_acquire`.
use super::*;

const PLAN_TABLE: &str = "loom_plan";
const TASK_TABLE: &str = "loom_task";
const DEPENDENCY_TABLE: &str = "loom_dependency";
const CLAIM_TABLE: &str = "loom_claim";
const CANDIDATE_TABLE: &str = "loom_candidate";

/// Task states follow the LOOM control-plane contract
/// (DRAFT → READY → BLOCKED → IN_REVIEW → DONE / CANCELED).
const TASK_STATUS: &str =
    "CHECK(status IN ('DRAFT','READY','BLOCKED','IN_REVIEW','DONE','CANCELED'))";
/// Dependency release conditions come from the same contract.
const DEPENDENCY_CONDITION: &str = "CHECK(condition IN ('TASK_DONE','ARTIFACT_ACCEPTED'))";
/// A Candidate carries the two independent verdict axes of the contract: what the Run
/// itself claims about its delivery, and what the Owner later accepted.
const VERIFICATION_STATUS: &str = "CHECK(verification_status IN ('UNVERIFIED','VERIFIED','FAILED'))";
const ACCEPTANCE_STATUS: &str = "CHECK(acceptance_status IN ('PENDING','ACCEPTED','REJECTED'))";

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

/// Migration 220: the lease claim a Task hands to exactly one AgentRun. The partial
/// unique index keeps at most one unreleased claim per Task, so two Runs can never both
/// hold the same Task; `fence_generation` advances on every expired-lease takeover.
fn claim_sql() -> String {
    format!(
        r#"
        CREATE TABLE {CLAIM_TABLE} (
            claim_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            agent_run_id TEXT NOT NULL,
            claimant_agent_id TEXT,
            command_id TEXT NOT NULL UNIQUE,
            lease_expires_at TEXT NOT NULL,
            fence_generation INTEGER NOT NULL CHECK(fence_generation >= 1),
            claimed_at TEXT NOT NULL,
            released_at TEXT,
            FOREIGN KEY(plan_id, task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX loom_claim_open_task_idx
            ON {CLAIM_TABLE}(task_id) WHERE released_at IS NULL;
        CREATE INDEX loom_claim_plan_idx ON {CLAIM_TABLE}(plan_id, claim_id);
        "#
    )
}

/// Migration 221: the versioned delivery candidate. A Candidate is written once and never
/// rewritten, so the delivered content is immutable; `previous_candidate_id` chains rework
/// versions on the same Task instead of overwriting an earlier verdict.
fn candidate_sql() -> String {
    format!(
        r#"
        CREATE TABLE {CANDIDATE_TABLE} (
            candidate_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            agent_run_id TEXT NOT NULL,
            command_id TEXT NOT NULL UNIQUE,
            content_hash TEXT NOT NULL CHECK(length(content_hash) BETWEEN 1 AND 200),
            evidence_ids_json TEXT NOT NULL
                CHECK(json_valid(evidence_ids_json) AND json_type(evidence_ids_json)='array'),
            acceptance_criteria_version TEXT NOT NULL
                CHECK(length(acceptance_criteria_version) BETWEEN 1 AND 200),
            previous_candidate_id TEXT
                REFERENCES {CANDIDATE_TABLE}(candidate_id) ON DELETE CASCADE,
            verification_status TEXT NOT NULL {VERIFICATION_STATUS},
            acceptance_status TEXT NOT NULL {ACCEPTANCE_STATUS},
            created_at TEXT NOT NULL,
            FOREIGN KEY(plan_id, task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE
        );
        CREATE INDEX loom_candidate_plan_idx ON {CANDIDATE_TABLE}(plan_id, candidate_id);
        CREATE INDEX loom_candidate_task_idx ON {CANDIDATE_TABLE}(task_id, created_at);
        CREATE TRIGGER loom_candidate_immutable
            BEFORE UPDATE OF candidate_id, plan_id, task_id, agent_run_id, command_id,
                             content_hash, evidence_ids_json, acceptance_criteria_version,
                             previous_candidate_id, created_at
            ON {CANDIDATE_TABLE}
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM candidate is immutable'); END;
        "#
    )
}

/// The candidate projection is part of the LOOM schema from migration 221 on; earlier
/// markers keep admitting databases that predate the delivery table.
fn candidate_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('candidate_id','plan_id','task_id','agent_run_id','command_id','content_hash',
              'evidence_ids_json','acceptance_criteria_version','previous_candidate_id',
              'verification_status','acceptance_status','created_at')",
        [CANDIDATE_TABLE],
        |row| row.get(0),
    )?;
    let immutable_trigger: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger'
             AND name='loom_candidate_immutable' AND tbl_name=?1
             AND sql LIKE '%BEFORE UPDATE%')",
        [CANDIDATE_TABLE],
        |row| row.get(0),
    )?;
    let declared = table_sql(connection, CANDIDATE_TABLE)?.is_some_and(|sql| {
        let sql = sql.split_whitespace().collect::<String>();
        sql.contains(&VERIFICATION_STATUS.split_whitespace().collect::<String>())
            && sql.contains(&ACCEPTANCE_STATUS.split_whitespace().collect::<String>())
            && sql.contains("command_idTEXTNOTNULLUNIQUE")
            && sql.contains("REFERENCESloom_task(plan_id,task_id)")
            && sql.contains("REFERENCESloom_candidate(candidate_id)")
    });
    Ok(columns == 12 && immutable_trigger && declared)
}

/// The claim projection is part of the LOOM schema from migration 220 on; earlier
/// markers keep admitting databases that predate the lease table.
fn claim_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('claim_id','plan_id','task_id','agent_run_id','claimant_agent_id',
              'command_id','lease_expires_at','fence_generation','claimed_at','released_at')",
        [CLAIM_TABLE],
        |row| row.get(0),
    )?;
    let open_task_index: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index'
             AND name='loom_claim_open_task_idx' AND sql LIKE '%released_at IS NULL%')",
        [],
        |row| row.get(0),
    )?;
    let declared = table_sql(connection, CLAIM_TABLE)?.is_some_and(|sql| {
        let sql = sql.split_whitespace().collect::<String>();
        sql.contains("CHECK(fence_generation>=1)")
            && sql.contains("REFERENCESloom_task(plan_id,task_id)")
    });
    Ok(columns == 10 && open_task_index && declared)
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

pub(super) fn schema_matches(
    connection: &Connection,
    projection_schema_version: i64,
) -> rusqlite::Result<bool> {
    let compact = |sql: &str| sql.split_whitespace().collect::<String>();
    let holds = |table: &str, tokens: &[&str]| -> rusqlite::Result<bool> {
        Ok(table_sql(connection, table)?.is_some_and(|sql| {
            let sql = compact(&sql);
            tokens.iter().all(|token| sql.contains(&compact(token)))
        }))
    };
    let plan_version_recorded =
        projection_schema_version < 169 || plan_holds_acceptance_criteria_version(connection)?;
    let claim_recorded = projection_schema_version < 170 || claim_schema_matches(connection)?;
    let candidate_recorded =
        projection_schema_version < 171 || candidate_schema_matches(connection)?;
    Ok(holds(
        PLAN_TABLE,
        &[
            "mission_id TEXT NOT NULL UNIQUE REFERENCES mission(id) ON DELETE CASCADE",
            "json_valid(acceptance_criteria_json)",
            "revision INTEGER NOT NULL CHECK(revision >= 1)",
        ],
    )? && plan_version_recorded
        && holds(
            TASK_TABLE,
            &[
                TASK_STATUS,
                "UNIQUE(plan_id, task_id)",
                "json_valid(acceptance_criteria_json)",
            ],
        )?
        && holds(
            DEPENDENCY_TABLE,
            &[
                DEPENDENCY_CONDITION,
                "CHECK(upstream_task_id <> downstream_task_id)",
                "REFERENCES loom_task(plan_id, task_id)",
            ],
        )?
        && claim_recorded
        && candidate_recorded)
}

/// Migration 219 hangs the acceptance criteria version on the Plan; Tasks inherit it.
fn plan_holds_acceptance_criteria_version(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1)
             WHERE name='acceptance_criteria_version' AND type='TEXT'
               AND \"notnull\"=1 AND dflt_value IS NOT NULL)",
        [PLAN_TABLE],
        |row| row.get(0),
    )
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
                DatabaseContractClassification::SupportedMigrationSource(ref marker)
                    if marker.projection_schema_version == 168
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

/// Migration 219: the Plan owns the acceptance criteria version that every Task of the
/// Plan inherits; Tasks carry no version column of their own.
pub(super) fn migrate_acceptance_criteria_version(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 168
        ),
        "LOOM acceptance criteria version migration requires schema 168"
    );
    // Plans imported before this migration have no recorded version; the literal is
    // kept as the snapshot version instead of inventing a revision number.
    tx.execute_batch(
        "ALTER TABLE loom_plan ADD COLUMN acceptance_criteria_version TEXT NOT NULL
             DEFAULT 'legacy';
         INSERT INTO schema_migration VALUES(219,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=169,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    anyhow::ensure!(
        plan_holds_acceptance_criteria_version(&tx)?,
        "LOOM acceptance criteria version migration did not create the required column"
    );
    // 169 is only Current while nothing newer exists; once a later migration lands this
    // step must stay admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(marker) => {
            marker.projection_schema_version == 169
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(
        admitted,
        "LOOM acceptance criteria version schema admission failed"
    );
    tx.commit()?;
    Ok(())
}

/// Migration 220: one Task lease projection. A claim is the only place a Task binds to
/// an AgentRun, so the Task itself keeps its control-plane state (`READY`) untouched.
pub(super) fn migrate_claim_lease(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 169
        ),
        "LOOM claim lease migration requires schema 169"
    );
    tx.execute_batch(&claim_sql())?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(220,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=170,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(&tx, &[CLAIM_TABLE])?;
    anyhow::ensure!(
        claim_schema_matches(&tx)?,
        "LOOM claim lease migration did not create the required table"
    );
    // 170 is only Current while nothing newer exists; once migration 221 lands this
    // receipt must stay admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 170
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "LOOM claim lease schema admission failed");
    tx.commit()?;
    Ok(())
}

/// Migration 221: the delivery candidate a Run submits while it still holds the Task.
/// The submit-side fence lives in `loom::candidate_record`; this step only declares the
/// storage that keeps a recorded candidate immutable.
pub(super) fn migrate_candidate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 170
        ),
        "LOOM candidate migration requires schema 170"
    );
    tx.execute_batch(&candidate_sql())?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(221,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=171,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(&tx, &[CANDIDATE_TABLE])?;
    anyhow::ensure!(
        candidate_schema_matches(&tx)?,
        "LOOM candidate migration did not create the required table"
    );
    // 171 is only Current while nothing newer exists; a later migration must leave this
    // receipt admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 171
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "LOOM candidate schema admission failed");
    tx.commit()?;
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
            DROP TABLE IF EXISTS loom_candidate;
            DROP TABLE IF EXISTS loom_claim;
            DROP TABLE IF EXISTS loom_dependency;
            DROP TABLE IF EXISTS loom_task;
            DROP TABLE IF EXISTS loom_plan;
            PRAGMA foreign_keys=ON;
            DELETE FROM schema_migration WHERE version IN (218,219,220,221);
            UPDATE rovai_data_contract SET projection_schema_version=167 WHERE singleton=1;",
        )
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::ProjectBindingKind;
    use crate::command::{ActorRef, CommandEnvelope};
    use crate::loom::{
        LoomPlanImportCriterion, LoomPlanImportDependency, LoomPlanImportInput, LoomPlanImportTask,
        dependencies_list, plan_get, plan_import, tasks_list,
    };
    use crate::mission::{CreateMissionCommand, MissionService};
    use uuid::Uuid;

    /// A real Mission through the product command, because `loom_plan` is keyed by `mission.id`.
    fn create_mission(database: &mut Database, directory: &std::path::Path, title: &str) -> String {
        let workspace = directory.join(format!("loom-upgrade-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&workspace).unwrap();
        let created = MissionService::default()
            .create(
                database,
                &CommandEnvelope {
                    command_id: Uuid::new_v4().to_string(),
                    actor: ActorRef::User {
                        user_id: "local_user".into(),
                    },
                    camp_id: None,
                    expected_versions: vec![],
                    execution_epoch: None,
                    payload: CreateMissionCommand {
                        team: None,
                        title: title.into(),
                        description: String::new(),
                        description_content: None,
                        project_path: workspace.to_string_lossy().into_owned(),
                        project_binding_kind: ProjectBindingKind::Directory,
                        member_agent_ids: vec!["agent_1".into()],
                        default_lead_agent_id: "agent_1".into(),
                        tags: vec![],
                        source_attachments: vec![],
                    },
                },
            )
            .unwrap();
        created.result.payload["missionId"]
            .as_str()
            .expect("mission creation must return a missionId")
            .to_string()
    }

    fn projection_version(database: &Database) -> i64 {
        database
            .connection()
            .query_row(
                "SELECT projection_schema_version FROM rovai_data_contract WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn migration_receipts(database: &Database, version: i64) -> i64 {
        database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM schema_migration WHERE version=?1",
                [version],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn plan_criteria_version_columns(database: &Database) -> i64 {
        database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info(?1)
                 WHERE name='acceptance_criteria_version'",
                [PLAN_TABLE],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// The upgrade path the deployed 168 databases take: rebuild the LOOM projection at
    /// 167 with the owner's own downgrade, walk 218 back to 168, then apply 219.
    #[test]
    fn acceptance_criteria_version_upgrade_defaults_legacy_and_keeps_loom_writable() {
        let mut database = crate::test_support::seeded_runtime_database_owned();
        let directory = database.directory().to_path_buf();
        let legacy_mission = create_mission(&mut database, &directory, "LOOM legacy plan");
        let imported_mission = create_mission(&mut database, &directory, "LOOM imported plan");

        downgrade_for_test(database.connection());
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 167
        ));

        // Migration 218 rebuilds the three LOOM tables without a criteria version column.
        migrate(&mut database).unwrap();
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 168
        ));
        assert!(schema_matches(database.connection(), 168).unwrap());
        assert!(!plan_holds_acceptance_criteria_version(database.connection()).unwrap());
        assert_eq!(
            plan_criteria_version_columns(&database),
            0,
            "assertion schema_168_plan_has_no_acceptance_criteria_version_column"
        );

        // A Plan imported before 219 carries only its criteria snapshot.
        database
            .connection()
            .execute(
                r#"INSERT INTO loom_plan(plan_id,mission_id,goal,acceptance_criteria_json,created_at,revision)
                   VALUES('plan_legacy',?1,'legacy goal','[{"criterionId":"criterion_one","text":"one"}]','2026-01-01T00:00:00Z',1)"#,
                [&legacy_mission],
            )
            .unwrap();

        migrate_acceptance_criteria_version(&mut database).unwrap();

        assert!(plan_holds_acceptance_criteria_version(database.connection()).unwrap());
        assert_eq!(
            plan_criteria_version_columns(&database),
            1,
            "assertion schema_169_plan_has_acceptance_criteria_version_column"
        );
        let (not_null, default): (i64, Option<String>) = database
            .connection()
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info(?1)
                 WHERE name='acceptance_criteria_version'",
                [PLAN_TABLE],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(not_null, 1, "assertion plan_column_is_not_null");
        assert_eq!(
            default.as_deref(),
            Some("'legacy'"),
            "assertion plan_column_default_is_the_legacy_literal"
        );
        let legacy_version: String = database
            .connection()
            .query_row(
                "SELECT acceptance_criteria_version FROM loom_plan WHERE plan_id='plan_legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            legacy_version, "legacy",
            "assertion pre_219_plan_reads_back_the_default_version"
        );

        assert_eq!(
            migration_receipts(&database, 218),
            1,
            "assertion schema_migration_records_218_once"
        );
        assert_eq!(
            migration_receipts(&database, 219),
            1,
            "assertion schema_migration_records_219_once"
        );

        // Migration 220 adds the Task lease projection and advances the marker to 170.
        migrate_claim_lease(&mut database).unwrap();
        assert!(
            claim_schema_matches(database.connection()).unwrap(),
            "assertion schema_170_creates_the_loom_claim_projection"
        );
        assert_eq!(
            migration_receipts(&database, 220),
            1,
            "assertion schema_migration_records_220_once"
        );
        assert_eq!(
            projection_version(&database),
            170,
            "assertion contract_marker_advances_to_170"
        );
        // Migration 221 adds the delivery candidate and advances the marker to 171, so the
        // claim receipt of 220 has to stay an admitted source instead of pinning Current.
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 170
        ));
        migrate_candidate(&mut database).unwrap();
        assert!(
            candidate_schema_matches(database.connection()).unwrap(),
            "assertion schema_171_creates_the_loom_candidate_projection"
        );
        assert_eq!(
            migration_receipts(&database, 221),
            1,
            "assertion schema_migration_records_221_once"
        );
        assert_eq!(
            projection_version(&database),
            171,
            "assertion contract_marker_advances_to_171"
        );
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::Current(_)
        ));

        // The product write path still stores all three LOOM tables, and reads them back.
        let imported = plan_import(
            &mut database,
            LoomPlanImportInput {
                mission_id: imported_mission.clone(),
                goal: "Ship after the criteria version upgrade".into(),
                acceptance_criteria_version: "ac-v2".into(),
                criteria: vec![
                    LoomPlanImportCriterion {
                        criterion_id: "criterion_one".into(),
                        text: "one".into(),
                    },
                    LoomPlanImportCriterion {
                        criterion_id: "criterion_two".into(),
                        text: "two".into(),
                    },
                ],
                tasks: vec![
                    LoomPlanImportTask {
                        task_id: "task_a".into(),
                        title: "Task A".into(),
                        description: String::new(),
                        assignee_agent_id: None,
                    },
                    LoomPlanImportTask {
                        task_id: "task_b".into(),
                        title: "Task B".into(),
                        description: String::new(),
                        assignee_agent_id: None,
                    },
                ],
                dependencies: vec![LoomPlanImportDependency {
                    upstream_task_id: "task_a".into(),
                    downstream_task_id: "task_b".into(),
                    condition: None,
                }],
            },
        )
        .unwrap();
        assert_eq!(
            imported.acceptance_criteria_version, "ac-v2",
            "assertion imported_plan_echoes_criteria_version"
        );
        let plan = plan_get(&database, &imported_mission).unwrap().unwrap();
        assert_eq!(
            plan.acceptance_criteria.version, "ac-v2",
            "assertion loom_plan_reads_back_the_imported_criteria_version"
        );
        assert_eq!(
            tasks_list(&database, &imported_mission).unwrap().len(),
            2,
            "assertion loom_task_reads_back_both_tasks"
        );
        assert_eq!(
            dependencies_list(&database, &imported_mission)
                .unwrap()
                .len(),
            1,
            "assertion loom_dependency_reads_back_the_edge"
        );
    }

    /// The candidate table's own guards: both verdict axes are closed sets, a candidate can
    /// only point at a Task of its own Plan, and a recorded delivery can never be rewritten.
    #[test]
    fn candidate_schema_guards_close_verdict_sets_and_freeze_recorded_deliveries() {
        let mut database = crate::test_support::seeded_runtime_database_owned();
        let directory = database.directory().to_path_buf();
        let mission_id = create_mission(&mut database, &directory, "LOOM candidate guards");
        let imported = plan_import(
            &mut database,
            LoomPlanImportInput {
                mission_id: mission_id.clone(),
                goal: "Guard the delivery candidate".into(),
                acceptance_criteria_version: "ac-v1".into(),
                criteria: vec![LoomPlanImportCriterion {
                    criterion_id: "criterion_one".into(),
                    text: "one".into(),
                }],
                tasks: vec![LoomPlanImportTask {
                    task_id: "task_a".into(),
                    title: "Task A".into(),
                    description: String::new(),
                    assignee_agent_id: None,
                }],
                dependencies: vec![],
            },
        )
        .unwrap();
        let insert = |candidate_id: &str, task_id: &str, verification: &str, acceptance: &str| {
            database.connection().execute(
                "INSERT INTO loom_candidate(candidate_id,plan_id,task_id,agent_run_id,command_id,
                                            content_hash,evidence_ids_json,acceptance_criteria_version,
                                            previous_candidate_id,verification_status,acceptance_status,created_at)
                 VALUES(?1,?2,?3,'run_one',?4,'sha256:guard','[]','ac-v1',NULL,?5,?6,'2026-01-01T00:00:00Z')",
                rusqlite::params![
                    candidate_id,
                    &imported.plan_id,
                    task_id,
                    format!("command_{candidate_id}"),
                    verification,
                    acceptance,
                ],
            )
        };

        assert_eq!(
            insert("candidate_ok", "task_a", "VERIFIED", "PENDING").unwrap(),
            1,
            "assertion closed_verdicts_stay_writable"
        );
        assert!(
            insert("candidate_bad_verification", "task_a", "MAYBE", "PENDING").is_err(),
            "assertion verification_status_is_a_closed_set"
        );
        assert!(
            insert("candidate_bad_acceptance", "task_a", "UNVERIFIED", "MAYBE").is_err(),
            "assertion acceptance_status_is_a_closed_set"
        );
        assert!(
            insert("candidate_orphan", "task_missing", "UNVERIFIED", "PENDING").is_err(),
            "assertion a_candidate_cannot_reference_a_task_outside_its_plan"
        );

        let tampered = database.connection().execute(
            "UPDATE loom_candidate SET content_hash='sha256:tampered' WHERE candidate_id='candidate_ok'",
            [],
        );
        assert!(
            tampered.is_err(),
            "assertion a_recorded_delivery_cannot_be_rewritten"
        );
        let stored: String = database
            .connection()
            .query_row(
                "SELECT content_hash FROM loom_candidate WHERE candidate_id='candidate_ok'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored, "sha256:guard",
            "assertion the_frozen_delivery_keeps_its_content_hash"
        );

        // Only the delivered content is frozen: the verdict columns belong to Review.
        database
            .connection()
            .execute(
                "UPDATE loom_candidate SET acceptance_status='ACCEPTED' WHERE candidate_id='candidate_ok'",
                [],
            )
            .unwrap();
        let verdict: String = database
            .connection()
            .query_row(
                "SELECT acceptance_status FROM loom_candidate WHERE candidate_id='candidate_ok'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            verdict, "ACCEPTED",
            "assertion the_acceptance_axis_stays_writable_for_review"
        );
    }
}
