//! LOOM orchestration projection: plan, task and dependency facts for one Mission, plus the
//! lease claim that binds a Task to one AgentRun. This module only owns the tables; the write
//! paths are `loom::plan_import`, `loom::task_release` and `loom::claim_acquire`.
use super::*;

const PLAN_TABLE: &str = "loom_plan";
const TASK_TABLE: &str = "loom_task";
const DEPENDENCY_TABLE: &str = "loom_dependency";
const CLAIM_TABLE: &str = "loom_claim";
const CANDIDATE_TABLE: &str = "loom_candidate";
const REVIEW_TABLE: &str = "loom_review";
const VERIFICATION_TABLE: &str = "loom_verification";
const ARTIFACT_TABLE: &str = "loom_artifact";
const CONTROL_POLICY_TABLE: &str = "loom_control_policy";
const CONTROL_COMMAND_TABLE: &str = "loom_control_command";
const STAGE_REVIEW_TABLE: &str = "loom_stage_review";
const CONTROL_DISPATCH_TABLE: &str = "loom_control_dispatch";

/// Task states follow the LOOM control-plane contract
/// (DRAFT → READY → BLOCKED → IN_REVIEW → DONE / CANCELED).
const TASK_STATUS: &str =
    "CHECK(status IN ('DRAFT','READY','BLOCKED','IN_REVIEW','DONE','CANCELED'))";
/// Dependency release conditions come from the same contract.
const DEPENDENCY_CONDITION: &str = "CHECK(condition IN ('TASK_DONE','ARTIFACT_ACCEPTED'))";
/// A Candidate carries the two independent verdict axes of the contract: what the Run
/// itself claims about its delivery, and what the Owner later accepted.
const VERIFICATION_STATUS: &str =
    "CHECK(verification_status IN ('UNVERIFIED','VERIFIED','FAILED'))";
const ACCEPTANCE_STATUS: &str = "CHECK(acceptance_status IN ('PENDING','ACCEPTED','REJECTED'))";
/// A Review is the Owner's verdict on one Candidate: accepted or rejected, nothing else.
const REVIEW_VERDICT: &str = "CHECK(verdict IN ('ACCEPTED','REJECTED'))";
/// Evidence verification is an axis of its own: a Run's claim is not a proof.
const VERIFICATION_RESULT: &str = "CHECK(result IN ('PASSED','FAILED'))";
/// An assistant stage verdict is not the Owner's verdict: `pass` only advances the internal
/// stage, so the persisted literals still stay apart from `loom_review`'s ACCEPTED/REJECTED.
const STAGE_VERDICT: &str = "CHECK(verdict IN ('PASS','REQUEST_CHANGES','BLOCKED'))";
/// The four dispatch kinds the control plane may ask another Run to perform.
const DISPATCH_KIND: &str = "CHECK(kind IN ('EXECUTE','REVIEW','REWORK','HANDOFF'))";
/// A Dispatch is a ledger row: it moves once through these states and is never deleted.
const DISPATCH_STATUS: &str =
    "CHECK(status IN ('WAITING','DISPATCHED','SETTLED','BLOCKED','CANCELLED'))";
/// The only kinds of command the control plane may replay.
const CONTROL_COMMAND_KIND: &str = "CHECK(kind IN ('CONFIGURE','PAUSE','STAGE_REVIEW'))";

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

/// Migration 222: the human review. A Review is written once and never rewritten, so the
/// verdict that released a downstream dependency keeps pointing at the same evidence.
/// `command_id` is unique so a retried submission replays instead of stacking verdicts, and
/// one Candidate can only ever carry one Review.
fn review_sql() -> String {
    format!(
        r#"
        CREATE TABLE {REVIEW_TABLE} (
            review_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            candidate_id TEXT NOT NULL UNIQUE
                REFERENCES {CANDIDATE_TABLE}(candidate_id) ON DELETE CASCADE,
            command_id TEXT NOT NULL UNIQUE,
            acceptance_criteria_version TEXT NOT NULL
                CHECK(length(acceptance_criteria_version) BETWEEN 1 AND 200),
            verdict TEXT NOT NULL {REVIEW_VERDICT},
            reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
            criteria_results_json TEXT NOT NULL
                CHECK(json_valid(criteria_results_json) AND json_type(criteria_results_json)='array'),
            reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) BETWEEN 1 AND 200),
            reviewed_at TEXT NOT NULL,
            FOREIGN KEY(plan_id, task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE
        );
        CREATE INDEX loom_review_plan_idx ON {REVIEW_TABLE}(plan_id, review_id);
        CREATE INDEX loom_review_task_idx ON {REVIEW_TABLE}(task_id, reviewed_at);
        CREATE TRIGGER loom_review_immutable
            BEFORE UPDATE ON {REVIEW_TABLE}
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM review is immutable'); END;
        -- INSERT OR REPLACE would delete and re-insert, slipping past a BEFORE UPDATE guard,
        -- so a second row claiming the same identity is refused outright.
        CREATE TRIGGER loom_review_no_replace
            BEFORE INSERT ON {REVIEW_TABLE}
            WHEN EXISTS(
                SELECT 1 FROM {REVIEW_TABLE}
                WHERE review_id=NEW.review_id
                   OR candidate_id=NEW.candidate_id
                   OR command_id=NEW.command_id
                   OR rowid=NEW.rowid
            )
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM review is immutable'); END;
        -- A direct DELETE is refused while the candidate still exists; only the aggregate
        -- cascade, where the candidate is already gone, may remove the verdict.
        CREATE TRIGGER loom_review_no_direct_delete
            BEFORE DELETE ON {REVIEW_TABLE}
            WHEN EXISTS(SELECT 1 FROM {CANDIDATE_TABLE} WHERE candidate_id=OLD.candidate_id)
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM review is immutable'); END;
        "#
    )
}

/// The review projection is part of the LOOM schema from migration 222 on; earlier markers
/// keep admitting databases that predate the human verdict.
fn review_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('review_id','plan_id','task_id','candidate_id','command_id',
              'acceptance_criteria_version','verdict','reason','criteria_results_json',
              'reviewer_id','reviewed_at')",
        [REVIEW_TABLE],
        |row| row.get(0),
    )?;
    let immutable_triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1
             AND name IN ('loom_review_immutable','loom_review_no_replace',
                          'loom_review_no_direct_delete')",
        [REVIEW_TABLE],
        |row| row.get(0),
    )?;
    let declared = table_sql(connection, REVIEW_TABLE)?.is_some_and(|sql| {
        let sql = sql.split_whitespace().collect::<String>();
        sql.contains(&REVIEW_VERDICT.split_whitespace().collect::<String>())
            && sql.contains("candidate_idTEXTNOTNULLUNIQUE")
            && sql.contains("command_idTEXTNOTNULLUNIQUE")
            && sql.contains("REFERENCESloom_candidate(candidate_id)")
            && sql.contains("REFERENCESloom_task(plan_id,task_id)")
    });
    Ok(columns == 11 && immutable_triggers == 3 && declared)
}

/// Migration 223: the evidence verification of one Candidate. Verification answers a
/// different question than acceptance — can the delivery be reproduced — so it is stored
/// separately, written once, and never retroactively rewritten.
fn verification_sql() -> String {
    format!(
        r#"
        CREATE TABLE {VERIFICATION_TABLE} (
            verification_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            candidate_id TEXT NOT NULL UNIQUE
                REFERENCES {CANDIDATE_TABLE}(candidate_id) ON DELETE CASCADE,
            command_id TEXT NOT NULL UNIQUE,
            method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 200),
            executor_id TEXT NOT NULL CHECK(length(executor_id) BETWEEN 1 AND 200),
            result TEXT NOT NULL {VERIFICATION_RESULT},
            evidence_ids_json TEXT NOT NULL
                CHECK(json_valid(evidence_ids_json) AND json_type(evidence_ids_json)='array'),
            verified_at TEXT NOT NULL,
            FOREIGN KEY(plan_id, task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE
        );
        CREATE INDEX loom_verification_plan_idx ON {VERIFICATION_TABLE}(plan_id, verification_id);
        CREATE INDEX loom_verification_task_idx ON {VERIFICATION_TABLE}(task_id, verified_at);
        CREATE TRIGGER loom_verification_immutable
            BEFORE UPDATE ON {VERIFICATION_TABLE}
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM verification is immutable'); END;
        CREATE TRIGGER loom_verification_no_replace
            BEFORE INSERT ON {VERIFICATION_TABLE}
            WHEN EXISTS(
                SELECT 1 FROM {VERIFICATION_TABLE}
                WHERE verification_id=NEW.verification_id
                   OR candidate_id=NEW.candidate_id
                   OR command_id=NEW.command_id
                   OR rowid=NEW.rowid
            )
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM verification is immutable'); END;
        CREATE TRIGGER loom_verification_no_direct_delete
            BEFORE DELETE ON {VERIFICATION_TABLE}
            WHEN EXISTS(SELECT 1 FROM {CANDIDATE_TABLE} WHERE candidate_id=OLD.candidate_id)
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM verification is immutable'); END;
        "#
    )
}

fn verification_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('verification_id','plan_id','task_id','candidate_id','command_id','method',
              'executor_id','result','evidence_ids_json','verified_at')",
        [VERIFICATION_TABLE],
        |row| row.get(0),
    )?;
    let triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1
             AND name IN ('loom_verification_immutable','loom_verification_no_replace',
                          'loom_verification_no_direct_delete')",
        [VERIFICATION_TABLE],
        |row| row.get(0),
    )?;
    let declared = table_sql(connection, VERIFICATION_TABLE)?.is_some_and(|sql| {
        let sql = sql.split_whitespace().collect::<String>();
        sql.contains(&VERIFICATION_RESULT.split_whitespace().collect::<String>())
            && sql.contains("candidate_idTEXTNOTNULLUNIQUE")
            && sql.contains("command_idTEXTNOTNULLUNIQUE")
            && sql.contains("REFERENCESloom_candidate(candidate_id)")
            && sql.contains("REFERENCESloom_task(plan_id,task_id)")
    });
    Ok(columns == 10 && triggers == 3 && declared)
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

/// Migration 232: the persistent automation authority of one LOOM plan.
///
/// These four tables are the whole control plane, and they are deliberately separate from
/// `loom_candidate`/`loom_review`: an assistant's stage verdict is not the Owner's verdict, so
/// it never lands in the human review table.
///
/// * `loom_control_policy` — one row per plan carrying the whole approved configuration, who
///   approved it, the row counter `revision` and the grant counter `authorization_revision`.
///   `revision` advances on every accepted command (pause/resume included) so a request written
///   against an older reading is refused; `authorization_revision` advances only on a real
///   re-approval, so pausing and resuming cannot launder the standing grant into a new one.
/// * `loom_control_command` — the strict replay ledger: `request_json` holds the normalized
///   request (trusted caller identity included), so a replayed `commandId` can only ever return
///   what that exact request produced.
/// * `loom_stage_review` — one immutable assistant verdict per (candidate, policy revision).
/// * `loom_control_dispatch` — the Delivery association and budget ledger. Rows are never
///   deleted, so re-approving a policy cannot reset what previous revisions already consumed.
fn control_sql() -> String {
    let mut sql = format!(
        r#"
        CREATE TABLE {CONTROL_POLICY_TABLE} (
            plan_id TEXT PRIMARY KEY,
            mission_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 1),
            authorization_revision INTEGER NOT NULL CHECK(authorization_revision >= 1),
            enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
            paused INTEGER NOT NULL CHECK(paused IN (0,1)),
            task_ids_json TEXT NOT NULL
                CHECK(json_valid(task_ids_json) AND json_type(task_ids_json)='array'),
            reviewers_json TEXT NOT NULL
                CHECK(json_valid(reviewers_json) AND json_type(reviewers_json)='array'),
            max_dispatches INTEGER NOT NULL CHECK(max_dispatches BETWEEN 1 AND 1000),
            max_reworks_per_task INTEGER NOT NULL CHECK(max_reworks_per_task BETWEEN 0 AND 20),
            expires_at TEXT,
            approved_by TEXT NOT NULL CHECK(length(approved_by) BETWEEN 1 AND 200),
            approved_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(plan_id) REFERENCES {PLAN_TABLE}(plan_id) ON DELETE CASCADE
        );
        CREATE TABLE {CONTROL_COMMAND_TABLE} (
            command_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            kind TEXT NOT NULL {CONTROL_COMMAND_KIND},
            request_json TEXT NOT NULL CHECK(json_valid(request_json)),
            response_json TEXT NOT NULL CHECK(json_valid(response_json)),
            created_at TEXT NOT NULL
        );
        CREATE INDEX loom_control_command_plan_idx
            ON {CONTROL_COMMAND_TABLE}(plan_id, command_id);
        CREATE TABLE {STAGE_REVIEW_TABLE} (
            stage_review_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            mission_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            candidate_id TEXT NOT NULL
                REFERENCES {CANDIDATE_TABLE}(candidate_id) ON DELETE CASCADE,
            command_id TEXT NOT NULL UNIQUE,
            reviewer_agent_id TEXT NOT NULL CHECK(length(reviewer_agent_id) BETWEEN 1 AND 200),
            reviewer_agent_run_id TEXT NOT NULL CHECK(length(reviewer_agent_run_id) BETWEEN 1 AND 200),
            policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
            manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) BETWEEN 1 AND 200),
            verdict TEXT NOT NULL {STAGE_VERDICT},
            reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000),
            criteria_results_json TEXT NOT NULL
                CHECK(json_valid(criteria_results_json) AND json_type(criteria_results_json)='array'),
            reviewed_at TEXT NOT NULL,
            UNIQUE(candidate_id, policy_revision),
            FOREIGN KEY(plan_id, task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE
        );
        CREATE INDEX loom_stage_review_plan_idx ON {STAGE_REVIEW_TABLE}(plan_id, stage_review_id);
        CREATE INDEX loom_stage_review_task_idx ON {STAGE_REVIEW_TABLE}(task_id, reviewed_at);
        CREATE TRIGGER loom_stage_review_immutable
            BEFORE UPDATE ON {STAGE_REVIEW_TABLE}
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM stage review is immutable'); END;
        -- INSERT OR REPLACE would delete and re-insert, slipping past a BEFORE UPDATE guard,
        -- so a second row claiming the same identity is refused outright.
        CREATE TRIGGER loom_stage_review_no_replace
            BEFORE INSERT ON {STAGE_REVIEW_TABLE}
            WHEN EXISTS(
                SELECT 1 FROM {STAGE_REVIEW_TABLE}
                WHERE stage_review_id=NEW.stage_review_id
                   OR command_id=NEW.command_id
                   OR (candidate_id=NEW.candidate_id AND policy_revision=NEW.policy_revision)
                   OR rowid=NEW.rowid
            )
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM stage review is immutable'); END;
        -- A direct DELETE is refused while the candidate still exists; only the aggregate
        -- cascade, where the candidate is already gone, may remove the verdict.
        CREATE TRIGGER loom_stage_review_no_direct_delete
            BEFORE DELETE ON {STAGE_REVIEW_TABLE}
            WHEN EXISTS(SELECT 1 FROM {CANDIDATE_TABLE} WHERE candidate_id=OLD.candidate_id)
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM stage review is immutable'); END;
        CREATE TABLE {CONTROL_DISPATCH_TABLE} (
            dispatch_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            kind TEXT NOT NULL {DISPATCH_KIND},
            candidate_id TEXT,
            policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
            recipient_agent_id TEXT NOT NULL CHECK(length(recipient_agent_id) BETWEEN 1 AND 200),
            delivery_id TEXT,
            status TEXT NOT NULL {DISPATCH_STATUS},
            reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
            dedupe_key TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(plan_id, task_id)
                REFERENCES {TASK_TABLE}(plan_id, task_id) ON DELETE CASCADE
        );
        CREATE INDEX loom_control_dispatch_plan_idx
            ON {CONTROL_DISPATCH_TABLE}(plan_id, created_at);
        CREATE INDEX loom_control_dispatch_task_idx
            ON {CONTROL_DISPATCH_TABLE}(task_id, kind);
        -- One Delivery can carry at most one dispatch: the association is a fact, not a hint.
        CREATE UNIQUE INDEX loom_control_dispatch_delivery_idx
            ON {CONTROL_DISPATCH_TABLE}(delivery_id) WHERE delivery_id IS NOT NULL;
        -- The identity of a dispatch is immutable: only `delivery_id`, `status`, `reason` and
        -- `updated_at` may move after the row exists.
        CREATE TRIGGER loom_control_dispatch_identity
            BEFORE UPDATE OF dispatch_id, plan_id, task_id, kind, candidate_id, policy_revision,
                             recipient_agent_id, dedupe_key, created_at
            ON {CONTROL_DISPATCH_TABLE}
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM dispatch identity is immutable'); END;
        -- `INSERT OR REPLACE` under the same dispatch id or dedupe key is refused outright. SQLite
        -- only fires the implicit DELETE of a REPLACE when `recursive_triggers` is ON, so a delete
        -- guard alone is not enough: this BEFORE INSERT guard is the one that always holds. The
        -- Delivery lane checks the dedupe key itself and then inserts plainly, never with REPLACE.
        CREATE TRIGGER loom_control_dispatch_no_replace
            BEFORE INSERT ON {CONTROL_DISPATCH_TABLE}
            WHEN EXISTS(
                SELECT 1 FROM {CONTROL_DISPATCH_TABLE}
                WHERE dispatch_id=NEW.dispatch_id
                   OR dedupe_key=NEW.dedupe_key
                   OR rowid=NEW.rowid
            )
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM dispatch is immutable'); END;
        -- A direct DELETE is refused while the parent Task still exists; only the aggregate
        -- cascade, where the Task is already gone, may remove the ledger row.
        CREATE TRIGGER loom_control_dispatch_no_direct_delete
            BEFORE DELETE ON {CONTROL_DISPATCH_TABLE}
            WHEN EXISTS(SELECT 1 FROM {TASK_TABLE}
                        WHERE plan_id=OLD.plan_id AND task_id=OLD.task_id)
            BEGIN SELECT RAISE(ABORT, 'a LOOM dispatch is a permanent budget record'); END;
        "#
    );
    // The artifact snapshot projection is part of the same pre-release schema 232. Its SQL is
    // owned by `crate::loom::snapshot`; appending it here means the control migration, the
    // object-list comparison and the test downgrade all cover it from the first install instead of
    // needing a second migration for a shape nothing has shipped yet.
    sql.push_str(crate::loom::snapshot::MIGRATION_SQL);
    sql
}

/// Statement-level normalisation: whitespace outside literals and quoted identifiers is
/// insignificant, everything else is contract. Copied deliberately from the LOOM archive
/// template in `loom/remote_artifact.rs` so both surfaces compare SQLite's own text the same way.
fn normalized_control_sql(sql: &str) -> String {
    let mut result = String::new();
    let mut quote = None;
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(end) = quote {
            result.push(ch);
            if ch == end {
                if chars.peek() == Some(&end) {
                    result.push(chars.next().unwrap());
                } else {
                    quote = None;
                }
            }
        } else if matches!(ch, '\'' | '"' | '[') || ch as u32 == 96 {
            quote = Some(if ch == '[' { ']' } else { ch });
            result.push(ch);
        } else if !ch.is_ascii_whitespace() {
            result.push(ch);
        }
    }
    result
}

/// Every schema object SQLite itself reports for the four control tables — table, index and
/// trigger with its real `CREATE` text — so a `WHEN 0` stub trigger, a lookalike index name or a
/// wrong partial index cannot pass as the contract.
fn control_schema_objects(
    connection: &Connection,
) -> rusqlite::Result<Vec<(String, String, String, Option<String>)>> {
    let mut statement = connection.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master
         WHERE tbl_name IN ('loom_control_policy','loom_control_command',
                            'loom_stage_review','loom_control_dispatch',
                            'loom_artifact_snapshot')
         ORDER BY type,name",
    )?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, Option<String>>(3)?
                    .map(|sql| normalized_control_sql(&sql)),
            ))
        })?
        .collect()
}

/// The control projection is part of the LOOM schema from migration 232 on; earlier markers
/// keep admitting databases that predate the automation authority.
///
/// The authority is compared by executing this module's own `control_sql()` in a scratch
/// in-memory database and diffing SQLite's reported objects, not by counting columns or looking
/// for index names: only the real table CHECKs, the real unique/partial indexes and the real
/// trigger bodies satisfy the comparison.
fn control_schema_matches_shape_tokens(connection: &Connection) -> rusqlite::Result<bool> {
    let policy_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('plan_id','mission_id','revision','authorization_revision','enabled','paused',
              'task_ids_json','reviewers_json','max_dispatches','max_reworks_per_task',
              'expires_at','approved_by','approved_at','updated_at')",
        [CONTROL_POLICY_TABLE],
        |row| row.get(0),
    )?;
    let stage_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('stage_review_id','plan_id','mission_id','task_id','candidate_id','command_id',
              'reviewer_agent_id','reviewer_agent_run_id','policy_revision','manifest_hash',
              'verdict','reason','criteria_results_json','reviewed_at')",
        [STAGE_REVIEW_TABLE],
        |row| row.get(0),
    )?;
    let dispatch_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('dispatch_id','plan_id','task_id','kind','candidate_id','policy_revision',
              'recipient_agent_id','delivery_id','status','reason','dedupe_key',
              'created_at','updated_at')",
        [CONTROL_DISPATCH_TABLE],
        |row| row.get(0),
    )?;
    let command_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('command_id','plan_id','kind','request_json','response_json','created_at')",
        [CONTROL_COMMAND_TABLE],
        |row| row.get(0),
    )?;
    let stage_triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1
             AND name IN ('loom_stage_review_immutable','loom_stage_review_no_replace',
                          'loom_stage_review_no_direct_delete')",
        [STAGE_REVIEW_TABLE],
        |row| row.get(0),
    )?;
    let dispatch_triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1
             AND name IN ('loom_control_dispatch_identity','loom_control_dispatch_no_replace',
                          'loom_control_dispatch_no_direct_delete')",
        [CONTROL_DISPATCH_TABLE],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN
             ('loom_control_command_plan_idx','loom_stage_review_plan_idx',
              'loom_stage_review_task_idx','loom_control_dispatch_plan_idx',
              'loom_control_dispatch_task_idx','loom_control_dispatch_delivery_idx')",
        [],
        |row| row.get(0),
    )?;
    let normalize = |sql: &str| sql.split_whitespace().collect::<String>();
    let policy_declared = table_sql(connection, CONTROL_POLICY_TABLE)?.is_some_and(|sql| {
        let sql = normalize(&sql);
        sql.contains(&normalize(
            "max_dispatches INTEGER NOT NULL CHECK(max_dispatches BETWEEN 1 AND 1000)",
        )) && sql.contains(&normalize(
            "max_reworks_per_task INTEGER NOT NULL CHECK(max_reworks_per_task BETWEEN 0 AND 20)",
        )) && sql.contains(&normalize("CHECK(enabled IN (0,1))"))
            && sql.contains(&normalize("REFERENCESloom_plan(plan_id)"))
    });
    let stage_declared = table_sql(connection, STAGE_REVIEW_TABLE)?.is_some_and(|sql| {
        let sql = normalize(&sql);
        sql.contains(&normalize(STAGE_VERDICT))
            && sql.contains("UNIQUE(candidate_id,policy_revision)")
            && sql.contains(&normalize("REFERENCESloom_candidate(candidate_id)"))
            && sql.contains(&normalize("REFERENCESloom_task(plan_id,task_id)"))
    });
    let dispatch_declared = table_sql(connection, CONTROL_DISPATCH_TABLE)?.is_some_and(|sql| {
        let sql = normalize(&sql);
        sql.contains(&normalize(DISPATCH_KIND))
            && sql.contains(&normalize(DISPATCH_STATUS))
            && sql.contains(&normalize("dedupe_key TEXT NOT NULL UNIQUE"))
    });
    let delivery_index_declared = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='loom_control_dispatch_delivery_idx'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .is_some_and(|sql| {
            let sql = normalize(&sql);
            sql.contains("ONloom_control_dispatch(delivery_id)")
                && sql.contains("WHEREdelivery_idISNOTNULL")
        });
    Ok(policy_columns == 14
        && stage_columns == 14
        && dispatch_columns == 13
        && command_columns == 6
        && stage_triggers == 3
        && dispatch_triggers == 3
        && indexes == 6
        && policy_declared
        && stage_declared
        && dispatch_declared
        && delivery_index_declared)
}

/// The authoritative control-schema check: the exact object list of this module's own executed
/// SQL, plus the token-level guards above for a readable failure reason.
pub(super) fn control_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(&control_sql())?;
    Ok(control_schema_matches_shape_tokens(connection)?
        && control_schema_objects(connection)? == control_schema_objects(&expected)?)
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

/// Migration 224: the artifact an evidence id may point at. Before this table a Candidate's
/// `evidenceIds` were bare strings — a claim that some artifact existed. The row records the
/// sha256 the Host computed when the artifact was registered, so verification can re-read the
/// bytes and prove they did not change. Rows are immutable: a replaced file is a new artifact,
/// never an edit, because "the evidence changed" must stay visible instead of being overwritten.
/// The three triggers that make a recorded artifact immutable, kept as statements of their own.
///
/// `artifact_sql` writes them and the schema check compares against them, so there is one text and
/// not two: a check that only looked at the trigger *names* accepts
/// `... BEFORE UPDATE ... BEGIN SELECT 1; END;`, and a check that looked for tokens still accepts
/// the real trigger with `WHEN 0` appended, which keeps every token and fires never.
fn artifact_trigger_sql() -> [String; 3] {
    [
        format!(
            "CREATE TRIGGER loom_artifact_immutable
             BEFORE UPDATE ON {ARTIFACT_TABLE}
             BEGIN SELECT RAISE(ABORT, 'a recorded LOOM artifact is immutable'); END"
        ),
        format!(
            "CREATE TRIGGER loom_artifact_no_replace
             BEFORE INSERT ON {ARTIFACT_TABLE}
             WHEN EXISTS(
                 SELECT 1 FROM {ARTIFACT_TABLE}
                 WHERE artifact_id=NEW.artifact_id
                    OR (plan_id=NEW.plan_id AND relative_path=NEW.relative_path)
                    OR rowid=NEW.rowid
             )
             BEGIN SELECT RAISE(ABORT, 'a recorded LOOM artifact is immutable'); END"
        ),
        format!(
            "CREATE TRIGGER loom_artifact_no_direct_delete
             BEFORE DELETE ON {ARTIFACT_TABLE}
             WHEN EXISTS(SELECT 1 FROM {PLAN_TABLE} WHERE plan_id=OLD.plan_id)
             BEGIN SELECT RAISE(ABORT, 'a recorded LOOM artifact is immutable'); END"
        ),
    ]
}

fn artifact_sql() -> String {
    let [immutable, no_replace, no_direct_delete] = artifact_trigger_sql();
    format!(
        r#"
        CREATE TABLE {ARTIFACT_TABLE} (
            artifact_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            task_id TEXT,
            agent_run_id TEXT,
            relative_path TEXT NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 1024),
            sha256 TEXT NOT NULL CHECK(length(sha256)=64),
            size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
            content_type TEXT,
            creator_id TEXT NOT NULL CHECK(length(creator_id) BETWEEN 1 AND 200),
            created_at TEXT NOT NULL,
            FOREIGN KEY(plan_id) REFERENCES {PLAN_TABLE}(plan_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX loom_artifact_plan_path_idx
            ON {ARTIFACT_TABLE}(plan_id, relative_path);
        CREATE INDEX loom_artifact_plan_idx ON {ARTIFACT_TABLE}(plan_id, artifact_id);
        {immutable};
        {no_replace};
        {no_direct_delete};
        "#
    )
}

/// The unique index that has to cover exactly `(plan_id, relative_path)`.
///
/// Both halves of that matter. An index over other columns does not enforce the path rule, and a
/// **partial** unique index enforces nothing for the rows its `WHERE` clause excludes — `WHERE 0`
/// would keep the name, the two columns and the `unique` flag while letting duplicates through.
fn artifact_path_index_covers_plan_and_path(connection: &Connection) -> rusqlite::Result<bool> {
    // `unique` is a keyword, so it has to be quoted to be read as the pragma's column name.
    let mut list =
        connection.prepare("SELECT name, partial FROM pragma_index_list(?1) WHERE \"unique\"=1")?;
    let candidates: Vec<(String, i64)> = list
        .query_map([ARTIFACT_TABLE], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, partial) in candidates {
        if partial != 0 {
            continue;
        }
        let mut info =
            connection.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?;
        // An expression index reports a null name for the expressions it covers, so the column has
        // to be read as optional rather than forced into a string.
        let columns: Vec<Option<String>> = info
            .query_map([name.as_str()], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let names: Vec<&str> = columns.iter().flatten().map(String::as_str).collect();
        if names.as_slice() == ["plan_id", "relative_path"] {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Compare one trigger with the statement this module builds, ignoring whitespace and case.
fn trigger_sql_matches(
    connection: &Connection,
    name: &str,
    expected: &str,
) -> rusqlite::Result<bool> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1",
            [name],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored) = stored else {
        return Ok(false);
    };
    let normalise = |sql: &str| sql.split_whitespace().collect::<String>().to_lowercase();
    Ok(normalise(&stored) == normalise(expected))
}

fn artifact_origin_present(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('loom_artifact') WHERE name='origin_key')",
        [],
        |r| r.get(0),
    )
}

pub(super) fn migrate_remote_artifact_origin(connection: &Connection) -> Result<()> {
    crate::loom::remote_artifact::migrate(connection, &artifact_sql())
}

#[cfg(test)]
pub(super) fn restore_local_artifact_contract_for_test(connection: &Connection) {
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM loom_artifact", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    connection
        .execute_batch("DROP TABLE loom_artifact_archive; DROP TABLE loom_artifact;")
        .unwrap();
    connection.execute_batch(&artifact_sql()).unwrap();
}

fn artifact_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    if artifact_origin_present(connection)? {
        let versioned: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=235)",
            [],
            |row| row.get(0),
        )?;
        return if versioned {
            crate::loom::remote_artifact::versioned_schema_matches(connection, &artifact_sql())
        } else {
            crate::loom::remote_artifact::schema_matches(connection, &artifact_sql())
        };
    }
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name IN
             ('artifact_id','plan_id','task_id','agent_run_id','relative_path','sha256',
              'size_bytes','content_type','creator_id','created_at')",
        [ARTIFACT_TABLE],
        |row| row.get(0),
    )?;
    let trigger_names = [
        "loom_artifact_immutable",
        "loom_artifact_no_replace",
        "loom_artifact_no_direct_delete",
    ];
    let triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1
             AND name IN ('loom_artifact_immutable','loom_artifact_no_replace',
                          'loom_artifact_no_direct_delete')",
        [ARTIFACT_TABLE],
        |row| row.get(0),
    )?;
    let declared = table_sql(connection, ARTIFACT_TABLE)?.is_some_and(|sql| {
        let sql = sql.split_whitespace().collect::<String>();
        sql.contains("CHECK(length(sha256)=64)")
            && sql.contains("CHECK(size_bytes>=0)")
            && sql.contains("REFERENCESloom_plan(plan_id)ONDELETECASCADE")
    });
    let path_index = artifact_path_index_covers_plan_and_path(connection)?;
    let expected = artifact_trigger_sql();
    let mut triggers_match = true;
    for (name, expected_sql) in trigger_names.iter().zip(expected.iter()) {
        if !trigger_sql_matches(connection, name, expected_sql)? {
            triggers_match = false;
        }
    }
    Ok(columns == 10 && triggers == 3 && declared && path_index && triggers_match)
}

/// Migration 235: immutable artifact versions may share one logical path. Replays are scoped
/// to the original producer and bytes; an updated file or a new Run receives its own evidence id.
pub(super) fn migrate_artifact_versions(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 184),
        "LOOM artifact version migration requires schema 184"
    );
    anyhow::ensure!(
        crate::loom::remote_artifact::schema_matches(&tx, &artifact_sql())?,
        "LOOM artifact version migration requires the unchanged prior artifact contract"
    );
    tx.execute_batch(crate::loom::remote_artifact::VERSION_MIGRATION_SQL)?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(235,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=185,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(
        &tx,
        &[
            ARTIFACT_TABLE,
            "loom_artifact_snapshot",
            "loom_artifact_archive",
        ],
    )?;
    anyhow::ensure!(
        crate::loom::remote_artifact::versioned_schema_matches(&tx, &artifact_sql())?,
        "LOOM artifact version schema invalid"
    );
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 185
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "LOOM artifact version schema admission failed");
    tx.commit()?;
    Ok(())
}

/// Only synthetic fixtures reverse this index. Real artifacts are never removed or rewritten.
#[cfg(test)]
pub(super) fn downgrade_artifact_versions_for_test(connection: &Connection) {
    super::local_hook_migration::downgrade_for_test(connection);
    let applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=235)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    if !applied {
        return;
    }
    let expected = Connection::open_in_memory().unwrap();
    expected.execute_batch(&artifact_sql()).unwrap();
    expected
        .execute_batch(crate::loom::remote_artifact::ORIGIN_MIGRATION_SQL)
        .unwrap();
    let legacy: Vec<String> = expected
        .prepare(
            "SELECT sql FROM sqlite_master WHERE name IN
             ('loom_artifact_plan_path_idx','loom_artifact_no_replace') ORDER BY name",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    connection
        .execute_batch(
            "DROP INDEX loom_artifact_plan_path_idx;
             DROP TRIGGER loom_artifact_no_replace;",
        )
        .unwrap();
    for sql in legacy {
        connection.execute_batch(&sql).unwrap();
    }
    connection
        .execute_batch(
            "DELETE FROM schema_migration WHERE version=235;
             UPDATE rovai_data_contract SET projection_schema_version=184
               WHERE singleton=1 AND projection_schema_version=185;",
        )
        .unwrap();
}

/// Migration 224: the artifact row an evidence id can point at.
pub(super) fn migrate_artifact(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 173
        ),
        "LOOM artifact migration requires schema 173"
    );
    tx.execute_batch(&artifact_sql())?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(224,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=174,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(&tx, &[ARTIFACT_TABLE])?;
    anyhow::ensure!(
        artifact_schema_matches(&tx)?,
        "LOOM artifact migration did not create the required table"
    );
    // 174 is only Current while nothing newer exists; a later migration must leave this
    // receipt admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 174
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "LOOM artifact schema admission failed");
    tx.commit()?;
    Ok(())
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
    let review_recorded = projection_schema_version < 172 || review_schema_matches(connection)?;
    let verification_recorded =
        projection_schema_version < 173 || verification_schema_matches(connection)?;
    let artifact_recorded = projection_schema_version < 174
        || (artifact_origin_present(connection)? == (projection_schema_version >= 181)
            && artifact_schema_matches(connection)?);
    let task_host_recorded =
        projection_schema_version < 178 || task_holds_execution_host(connection)?;
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
        && candidate_recorded
        && review_recorded
        && verification_recorded
        && artifact_recorded
        && task_host_recorded)
}

fn task_holds_execution_host(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='execution_host_id')",
        [TASK_TABLE],
        |row| row.get(0),
    )
}

/// Migration 228: a LOOM task may name the execution node that runs it.
/// NULL stays unpinned. A remote node is not the default host.
pub(super) fn migrate_task_execution_host(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 177
        ),
        "task execution host migration requires schema 177"
    );
    tx.execute_batch(
        "ALTER TABLE loom_task ADD COLUMN execution_host_id TEXT
             CHECK(execution_host_id IS NULL OR length(execution_host_id) BETWEEN 1 AND 80);",
    )?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(228,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=178,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    anyhow::ensure!(
        task_holds_execution_host(&tx)?,
        "task execution host migration did not add the column"
    );
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 178
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "task execution host schema admission failed");
    tx.commit()?;
    Ok(())
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

/// Migration 222: the human verdict on a delivery candidate.
pub(super) fn migrate_review(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 171
        ),
        "LOOM review migration requires schema 171"
    );
    tx.execute_batch(&review_sql())?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(222,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=172,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(&tx, &[REVIEW_TABLE])?;
    anyhow::ensure!(
        review_schema_matches(&tx)?,
        "LOOM review migration did not create the required table"
    );
    // 172 is only Current while nothing newer exists; a later migration must leave this
    // receipt admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 172
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "LOOM review schema admission failed");
    tx.commit()?;
    Ok(())
}

/// Migration 223: the evidence verification of a delivery candidate.
pub(super) fn migrate_verification(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 172
        ),
        "LOOM verification migration requires schema 172"
    );
    tx.execute_batch(&verification_sql())?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(223,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=173,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(&tx, &[VERIFICATION_TABLE])?;
    anyhow::ensure!(
        verification_schema_matches(&tx)?,
        "LOOM verification migration did not create the required table"
    );
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 173
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "LOOM verification schema admission failed");
    tx.commit()?;
    Ok(())
}

/// Migration 232: the persistent automation authority of one Plan — the approved policy, the
/// strict command replay ledger, the assistant stage verdicts and the dispatch/budget ledger.
///
/// The receipt is written in the same transaction as the tables, so a half-applied control
/// plane cannot be reopened as current: either all four tables and the receipt exist, or the
/// database still reports schema 181 as an upgrade source.
pub(super) fn migrate_control(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 181
        ),
        "LOOM control migration requires schema 181"
    );
    tx.execute_batch(&control_sql())?;
    tx.execute_batch(
        "INSERT INTO schema_migration VALUES(232,datetime('now'));
         UPDATE rovai_data_contract SET projection_schema_version=182,updated_at=datetime('now') WHERE singleton=1;",
    )?;
    validate_migration_foreign_keys(
        &tx,
        &[
            CONTROL_POLICY_TABLE,
            CONTROL_COMMAND_TABLE,
            STAGE_REVIEW_TABLE,
            CONTROL_DISPATCH_TABLE,
        ],
    )?;
    anyhow::ensure!(
        control_schema_matches(&tx)?,
        "LOOM control migration did not create the required tables"
    );
    // 182 is only Current while nothing newer exists; a later migration must leave this
    // receipt admissible as a supported source instead of pinning Current.
    let admitted = match classify_database_contract(&tx)? {
        DatabaseContractClassification::Current(_) => true,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) => {
            marker.projection_schema_version == 182
        }
        DatabaseContractClassification::Unknown(_) => false,
    };
    anyhow::ensure!(admitted, "LOOM control schema admission failed");
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
            DROP TABLE IF EXISTS loom_claim_execution_target;
            DROP TABLE IF EXISTS agent_run_remote_process;
            DROP TABLE IF EXISTS agent_run_remote_bundle_source;
            DROP TABLE IF EXISTS agent_run_execution_target;
            DROP TABLE IF EXISTS member_execution_target;
            DROP TABLE IF EXISTS remote_runtime_installation;
            DROP TABLE IF EXISTS workspace_rpc_events;
            DROP TABLE IF EXISTS workspace_rpc_audit;
            DROP TABLE IF EXISTS loom_artifact_archive;
            DROP TABLE IF EXISTS workspace_rpc_requests;
            DROP TABLE IF EXISTS loom_artifact_snapshot;
            DROP TABLE IF EXISTS loom_artifact;
            DROP TABLE IF EXISTS loom_verification;
            DROP TABLE IF EXISTS loom_stage_review;
            DROP TABLE IF EXISTS loom_control_dispatch;
            DROP TABLE IF EXISTS loom_control_command;
            DROP TABLE IF EXISTS loom_control_policy;
            DROP TABLE IF EXISTS loom_review;
            DROP TABLE IF EXISTS loom_candidate;
            DROP TABLE IF EXISTS loom_claim;
            DROP TABLE IF EXISTS loom_dependency;
            DROP TABLE IF EXISTS loom_task;
            DROP TABLE IF EXISTS loom_plan;
            PRAGMA foreign_keys=ON;
            DROP TABLE IF EXISTS node_run_bundle;
            DROP TABLE IF EXISTS node_run_credential;
            DROP TABLE IF EXISTS node_dispatch_output;
            DROP TABLE IF EXISTS node_dispatch;
            DROP TABLE IF EXISTS execution_node_cli;
            DROP TABLE IF EXISTS execution_node;
            DROP TABLE IF EXISTS member_capability_tool_claim;
            DROP TABLE IF EXISTS member_capability_choice;
            DROP TABLE IF EXISTS member_capability_item;
            DELETE FROM schema_migration WHERE version IN (218,219,220,221,222,223,224,225,226,227,228,229,230,231,232);
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

    /// The dispatch ledger's identity guards have to hold without `recursive_triggers`: SQLite only
    /// fires the implicit DELETE of `INSERT OR REPLACE` when that pragma is ON, so the BEFORE INSERT
    /// guard — not the delete guard — is what refuses a replaced row.
    ///
    /// The fixture is a real database with a real Plan and Task: the ledger's foreign keys mean a
    /// synthetic parent would only prove that SQLite rejects a missing table, and the legitimate
    /// insert has to succeed first or the two rejections prove nothing.
    #[test]
    fn control_dispatch_refuses_a_replaced_identity_without_recursive_triggers() {
        let mut database = crate::test_support::seeded_runtime_database_owned();
        let directory = database.directory().to_path_buf();
        let mission_id = create_mission(&mut database, &directory, "LOOM dispatch identity");
        let imported = plan_import(
            &mut database,
            LoomPlanImportInput {
                mission_id,
                goal: "Ship the guarded plan".into(),
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
        let plan_id = imported.plan_id.clone();
        let task_id = imported.task_ids[0].clone();
        let connection = database.connection();
        connection
            .execute_batch("PRAGMA recursive_triggers=OFF;")
            .unwrap();

        connection
            .execute(
                "INSERT INTO loom_control_dispatch(dispatch_id,plan_id,task_id,kind,candidate_id,
                        policy_revision,recipient_agent_id,delivery_id,status,reason,dedupe_key,
                        created_at,updated_at)
                 VALUES('dispatch_one',?1,?2,'EXECUTE',NULL,1,'agent_1',NULL,'WAITING',NULL,
                        '[\"EXECUTE\",\"task_a\"]','2026-08-31','2026-08-31')",
                rusqlite::params![&plan_id, &task_id],
            )
            .expect("a legitimate dispatch row must be insertable");

        let replaced = connection.execute(
            "INSERT OR REPLACE INTO loom_control_dispatch(dispatch_id,plan_id,task_id,kind,
                    candidate_id,policy_revision,recipient_agent_id,delivery_id,status,reason,
                    dedupe_key,created_at,updated_at)
             VALUES('dispatch_one',?1,?2,'EXECUTE',NULL,1,'agent_other',NULL,'WAITING',NULL,
                    '[\"EXECUTE\",\"task_a\"]','2026-08-31','2026-08-31')",
            rusqlite::params![&plan_id, &task_id],
        );
        assert!(
            replaced.is_err(),
            "assertion insert_or_replace_cannot_rewrite_a_recorded_dispatch"
        );

        let replaced_dedupe = connection.execute(
            "INSERT OR REPLACE INTO loom_control_dispatch(dispatch_id,plan_id,task_id,kind,
                    candidate_id,policy_revision,recipient_agent_id,delivery_id,status,reason,
                    dedupe_key,created_at,updated_at)
             VALUES('dispatch_two',?1,?2,'EXECUTE',NULL,1,'agent_1',NULL,'WAITING',NULL,
                    '[\"EXECUTE\",\"task_a\"]','2026-08-31','2026-08-31')",
            rusqlite::params![&plan_id, &task_id],
        );
        assert!(
            replaced_dedupe.is_err(),
            "assertion insert_or_replace_cannot_reuse_a_recorded_dedupe_key"
        );

        // The refused replacements left the original identity, recipient and row count untouched.
        let (rows, dispatch_id, recipient): (i64, String, String) = connection
            .query_row(
                "SELECT COUNT(*), MAX(dispatch_id), MAX(recipient_agent_id)
                 FROM loom_control_dispatch",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (rows, dispatch_id.as_str(), recipient.as_str()),
            (1, "dispatch_one", "agent_1"),
            "assertion a_refused_replacement_leaves_the_recorded_dispatch_untouched"
        );

        let rewritten = connection.execute(
            "UPDATE loom_control_dispatch SET dedupe_key='[\"EXECUTE\",\"other\"]'
             WHERE dispatch_id='dispatch_one'",
            [],
        );
        assert!(
            rewritten.is_err(),
            "assertion a_recorded_dispatch_identity_is_immutable"
        );
    }

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

    /// A schema check that only looks at names accepts a table that enforces nothing: a same-named
    /// trigger with an empty body, or a unique index over the wrong columns. Both must be refused,
    /// because either one silently reopens a hole migration 224 was written to close.
    #[test]
    fn artifact_schema_check_refuses_a_neutered_trigger_and_a_partial_index() {
        let database = crate::test_support::seeded_runtime_database_owned();
        let triggers = artifact_trigger_sql();
        assert!(
            artifact_schema_matches(database.connection()).unwrap(),
            "assertion the shipped artifact projection passes its own check"
        );

        // The real trigger with `WHEN 0` appended: every token a spot check looks for is still
        // there, and it never fires. Only comparing the whole statement catches this.
        database
            .connection()
            .execute_batch(&format!(
                "DROP TRIGGER loom_artifact_immutable;
                 CREATE TRIGGER loom_artifact_immutable
                     BEFORE UPDATE ON {ARTIFACT_TABLE}
                     WHEN 0
                     BEGIN SELECT RAISE(ABORT, 'a recorded LOOM artifact is immutable'); END;"
            ))
            .unwrap();
        assert!(
            !artifact_schema_matches(database.connection()).unwrap(),
            "assertion a trigger gated by WHEN 0 is not accepted"
        );

        // Same name, same event, a body that never raises.
        database
            .connection()
            .execute_batch(&format!(
                "DROP TRIGGER loom_artifact_immutable;
                 CREATE TRIGGER loom_artifact_immutable BEFORE UPDATE ON {ARTIFACT_TABLE}
                 BEGIN SELECT 1; END;"
            ))
            .unwrap();
        assert!(
            !artifact_schema_matches(database.connection()).unwrap(),
            "assertion a trigger whose body never raises is not accepted"
        );

        // Restoring the statement this module builds is accepted again.
        database
            .connection()
            .execute_batch(&format!(
                "DROP TRIGGER loom_artifact_immutable; {};",
                triggers[0]
            ))
            .unwrap();
        assert!(
            artifact_schema_matches(database.connection()).unwrap(),
            "assertion the restoring trigger is accepted again"
        );

        // A partial unique index keeps the name, the two columns and the unique flag, while
        // excluding every row from enforcement.
        database
            .connection()
            .execute_batch(&format!(
                "DROP INDEX loom_artifact_plan_path_idx;
                 CREATE UNIQUE INDEX loom_artifact_plan_path_idx
                     ON {ARTIFACT_TABLE}(plan_id, relative_path) WHERE 0;"
            ))
            .unwrap();
        assert!(
            !artifact_schema_matches(database.connection()).unwrap(),
            "assertion a partial unique index is not accepted"
        );

        // Missing altogether is refused as well: the check is about the schema being what was
        // migrated, not only about what an attacker could reach.
        database
            .connection()
            .execute_batch("DROP INDEX loom_artifact_plan_path_idx;")
            .unwrap();
        assert!(
            !artifact_schema_matches(database.connection()).unwrap(),
            "assertion a missing path index is not accepted"
        );
    }

    /// A real archived artifact survives both a failed upgrade and the completed upgrade.
    /// A later revision must neither rewrite that row nor lose its readable snapshot.
    #[test]
    fn artifact_version_migration_preserves_snapshots_and_rolls_back_with_receipt() {
        let mut database = crate::test_support::seeded_runtime_database_owned();
        let directory = database.directory().to_path_buf();
        let mission_id = create_mission(&mut database, &directory, "LOOM version upgrade");
        plan_import(
            &mut database,
            LoomPlanImportInput {
                mission_id: mission_id.clone(),
                goal: "Retain prior evidence while revising the same file".into(),
                acceptance_criteria_version: "ac-v1".into(),
                criteria: vec![LoomPlanImportCriterion {
                    criterion_id: "readable".into(),
                    text: "Archived versions remain readable".into(),
                }],
                tasks: vec![LoomPlanImportTask {
                    task_id: "version-task".into(),
                    title: "Revise report".into(),
                    description: String::new(),
                    assignee_agent_id: None,
                }],
                dependencies: vec![],
            },
        )
        .unwrap();
        let workspace: String = database
            .connection()
            .query_row(
                "SELECT c.project_path FROM mission m JOIN camp c ON c.id=m.camp_id WHERE m.id=?1",
                [&mission_id],
                |row| row.get(0),
            )
            .unwrap();
        let file = std::path::Path::new(&workspace).join("report.md");
        std::fs::write(&file, "before migration").unwrap();
        let input = || crate::loom::LoomArtifactRegisterInput {
            mission_id: mission_id.clone(),
            task_id: None,
            agent_run_id: None,
            relative_path: "report.md".into(),
            content_type: Some("text/plain".into()),
        };
        let first = crate::loom::artifact_register(&mut database, "local_user", input()).unwrap();
        downgrade_artifact_versions_for_test(database.connection());
        assert_eq!(projection_version(&database), 184);
        database.connection().execute_batch(
            "CREATE TEMP TABLE prior_artifact_versions AS SELECT * FROM loom_artifact;
             CREATE TEMP TABLE prior_artifact_snapshots AS SELECT * FROM loom_artifact_snapshot;
             CREATE TEMP TRIGGER fail_artifact_version_receipt BEFORE INSERT ON schema_migration
             WHEN NEW.version=235 BEGIN SELECT RAISE(ABORT,'fixture version receipt failure'); END;",
        ).unwrap();
        assert!(migrate_artifact_versions(&mut database).is_err());
        assert_eq!(projection_version(&database), 184);
        assert_eq!(migration_receipts(&database, 235), 0);
        assert!(
            crate::loom::remote_artifact::schema_matches(database.connection(), &artifact_sql(),)
                .unwrap()
        );
        assert!(
            matches!(classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref m)
                if m.projection_schema_version == 184)
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER fail_artifact_version_receipt;")
            .unwrap();
        migrate_artifact_versions(&mut database).unwrap();
        assert!(matches!(classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 185));
        assert_eq!(migration_receipts(&database, 235), 1);
        crate::db::local_hook_migration::migrate(&mut database).unwrap();
        assert!(connection_has_current_data_contract(database.connection()).unwrap());
        for sql in [
            "SELECT COUNT(*) FROM (SELECT * FROM prior_artifact_versions EXCEPT SELECT * FROM loom_artifact)",
            "SELECT COUNT(*) FROM (SELECT * FROM loom_artifact EXCEPT SELECT * FROM prior_artifact_versions)",
            "SELECT COUNT(*) FROM (SELECT * FROM prior_artifact_snapshots EXCEPT SELECT * FROM loom_artifact_snapshot)",
            "SELECT COUNT(*) FROM (SELECT * FROM loom_artifact_snapshot EXCEPT SELECT * FROM prior_artifact_snapshots)",
            "SELECT COUNT(*) FROM pragma_foreign_key_check",
        ] {
            assert_eq!(
                database
                    .connection()
                    .query_row(sql, [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                0,
                "{sql}"
            );
        }
        std::fs::write(&file, "after migration").unwrap();
        let revised = crate::loom::artifact_register(&mut database, "local_user", input()).unwrap();
        assert_ne!(first.artifact.artifact_id, revised.artifact.artifact_id);
        for (artifact, expected) in [
            (&first.artifact, "before migration"),
            (&revised.artifact, "after migration"),
        ] {
            let preview = crate::loom::artifact_preview(
                &database,
                &directory,
                crate::loom::LoomArtifactPreviewInput {
                    mission_id: mission_id.clone(),
                    artifact_id: artifact.artifact_id.clone(),
                },
            )
            .unwrap();
            assert_eq!(preview.text.as_deref(), Some(expected));
            assert_eq!(preview.sha256, artifact.sha256);
        }
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
        // Migration 222 adds the human review, so the 221 receipt stays an admitted source
        // instead of pinning Current.
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 171
        ));
        migrate_review(&mut database).unwrap();
        assert!(
            review_schema_matches(database.connection()).unwrap(),
            "assertion schema_172_creates_the_loom_review_projection"
        );
        assert_eq!(
            migration_receipts(&database, 222),
            1,
            "assertion schema_migration_records_222_once"
        );
        assert_eq!(
            projection_version(&database),
            172,
            "assertion contract_marker_advances_to_172"
        );
        // Migration 223 adds the evidence verification, so the 222 receipt is a source now.
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 172
        ));
        migrate_verification(&mut database).unwrap();
        assert!(
            verification_schema_matches(database.connection()).unwrap(),
            "assertion schema_173_creates_the_loom_verification_projection"
        );
        assert_eq!(
            migration_receipts(&database, 223),
            1,
            "assertion schema_migration_records_223_once"
        );
        assert_eq!(
            projection_version(&database),
            173,
            "assertion contract_marker_advances_to_173"
        );
        // Migration 224 adds the artifact projection, so the 173 receipt is a source now.
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 173
        ));
        migrate_artifact(&mut database).unwrap();
        assert!(
            artifact_schema_matches(database.connection()).unwrap(),
            "assertion schema_174_creates_the_loom_artifact_projection"
        );
        assert_eq!(
            migration_receipts(&database, 224),
            1,
            "assertion schema_migration_records_224_once"
        );
        assert_eq!(
            projection_version(&database),
            174,
            "assertion contract_marker_advances_to_174"
        );
        // Migration 225 records execution nodes, so the 174 receipt is a source now.
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 174
        ));
        super::execution_nodes::migrate(&mut database).unwrap();
        assert!(
            crate::execution_node::schema_matches(database.connection()).unwrap(),
            "assertion schema_175_creates_the_execution_node_projection"
        );
        assert_eq!(
            migration_receipts(&database, 225),
            1,
            "assertion schema_migration_records_225_once"
        );
        assert_eq!(
            projection_version(&database),
            175,
            "assertion contract_marker_advances_to_175"
        );
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 175
        ));
        super::execution_nodes::migrate_run_credential(&mut database).unwrap();
        assert!(
            crate::execution_node::shim_schema_matches(database.connection()).unwrap(),
            "assertion schema_176_creates_the_shim_credential_projection"
        );
        assert_eq!(
            migration_receipts(&database, 226),
            1,
            "assertion schema_migration_records_226_once"
        );
        assert_eq!(
            projection_version(&database),
            176,
            "assertion contract_marker_advances_to_176"
        );
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 176
        ));
        super::member_capability_migration::migrate(&mut database).unwrap();
        assert!(
            crate::member_capability::schema_matches(database.connection()).unwrap(),
            "assertion schema_177_creates_the_member_capability_catalog"
        );
        assert_eq!(
            migration_receipts(&database, 227),
            1,
            "assertion schema_migration_records_227_once"
        );
        assert_eq!(
            projection_version(&database),
            177,
            "assertion contract_marker_advances_to_177"
        );
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 177
        ));
        migrate_task_execution_host(&mut database).unwrap();
        assert!(
            task_holds_execution_host(database.connection()).unwrap(),
            "assertion schema_178_pins_a_task_to_an_execution_host"
        );
        assert_eq!(
            migration_receipts(&database, 228),
            1,
            "assertion schema_migration_records_228_once"
        );
        assert_eq!(
            projection_version(&database),
            178,
            "assertion contract_marker_advances_to_178"
        );
        let local: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM execution_node WHERE role='local' AND revoked_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            local, 1,
            "assertion the local node is recorded and not revocable"
        );
        // This historical owner intentionally walks through migration 228 only.
        // Current 181 admission and 180 -> 231 are owned by the production
        // preflight test; this remains the exact admitted historical 178 source.
        assert!(matches!(
            classify_database_contract(database.connection()).unwrap(),
            DatabaseContractClassification::SupportedMigrationSource(ref marker)
                if marker.projection_schema_version == 178
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
