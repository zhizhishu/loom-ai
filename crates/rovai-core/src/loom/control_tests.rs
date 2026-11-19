//! Stage 1 owners for the LOOM control plane: the approved policy, the assistant stage verdict
//! and the rules that keep the internal stage apart from the Owner's own acceptance.
//!
//! These extend the existing LOOM fixture rather than inventing a second one: the same seeded
//! runtime database, the same real `MissionService` command and the same real
//! `plan_import`/`claim_acquire`/`candidate_record`/`review_record` write paths, so a passing case
//! proves the product path and not a test-only shortcut. Owners are grouped by failure boundary
//! (authority, concurrency, reviewer identity, evidence, outcome, persistence) instead of one test
//! per assertion, because each group has distinct failure semantics.

use super::control::{
    self, LoomControlPauseInput, LoomControlPolicyInput, LoomReviewerAssignment,
    LoomStageReviewInput, LoomStageVerdict,
};
use super::{
    LoomAcceptanceCriterionResult, LoomCandidateRecordInput, LoomClaimAcquireInput,
    LoomCommandError, LoomPlanImportCriterion, LoomPlanImportDependency, LoomPlanImportInput,
    LoomPlanImportTask, LoomReviewRecordInput, LoomReviewVerdict, LoomTaskReleaseInput,
    candidate_record, claim_acquire, plan_import, review_record, task_release,
};
use crate::collaboration::ProjectBindingKind;
use crate::command::{ActorRef, CommandEnvelope};
use crate::db::Database;
use crate::mission::{CreateMissionCommand, MissionService};
use crate::test_support::OwnedTestDatabase;
use rusqlite::params;

const OWNER: &str = "local_user";
const PRODUCER_AGENT: &str = "agent_1";
const REVIEWER_AGENT: &str = "agent_2";
const PRODUCER_RUN: &str = "run_producer";
const REVIEWER_RUN: &str = "run_reviewer";
/// A second executor of the same Camp, so a pass can hand work to two Recipients at once.
const SECOND_PRODUCER_AGENT: &str = "agent_3";
const FUTURE_EXPIRY: &str = "2099-01-01T00:00:00Z";

fn fixture() -> OwnedTestDatabase {
    crate::test_support::seeded_runtime_database_owned()
}

fn command<P>(payload: P) -> CommandEnvelope<P> {
    CommandEnvelope {
        command_id: uuid::Uuid::new_v4().to_string(),
        actor: ActorRef::User {
            user_id: OWNER.into(),
        },
        camp_id: None,
        expected_versions: vec![],
        execution_epoch: None,
        payload,
    }
}

/// A real Mission with the two members every control test works with, so the producer and the
/// reviewer are both present, active members of the same Camp without either of them being invented
/// by the test.
fn create_mission(database: &mut OwnedTestDatabase, title: &str) -> String {
    create_mission_with_members(database, title, &[PRODUCER_AGENT, REVIEWER_AGENT])
}

/// The same real Mission command, with the Camp membership stated explicitly so a test that needs a
/// second executor gets a real membership instead of a hand-written row.
fn create_mission_with_members(
    database: &mut OwnedTestDatabase,
    title: &str,
    members: &[&str],
) -> String {
    let workspace = database
        .directory()
        .join(format!("loom-control-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&workspace).unwrap();
    let created = MissionService::default()
        .create(
            database,
            &command(CreateMissionCommand {
                team: None,
                title: title.into(),
                description: String::new(),
                description_content: None,
                project_path: workspace.to_string_lossy().into_owned(),
                project_binding_kind: ProjectBindingKind::Directory,
                member_agent_ids: members.iter().map(|member| (*member).to_string()).collect(),
                default_lead_agent_id: PRODUCER_AGENT.into(),
                tags: vec![],
                source_attachments: vec![],
            }),
        )
        .unwrap();
    // The reviewer rule requires a *present* profile, not merely a Camp membership row, so the
    // fixture states that precondition — and asserts every member really exists, so a template
    // without the reviewer profile fails loudly here instead of quietly weakening the rule under
    // test.
    for member in members {
        let updated = database
            .connection()
            .execute(
                "UPDATE agent_profile SET profile_status='present' WHERE id=?1",
                [member],
            )
            .unwrap();
        assert_eq!(
            updated, 1,
            "assertion the_fixture_carries_the_member_profiles_the_reviewer_rule_needs"
        );
    }
    created.result.payload["missionId"]
        .as_str()
        .expect("mission creation must return a missionId")
        .to_string()
}

fn plan_input(mission_id: &str) -> LoomPlanImportInput {
    LoomPlanImportInput {
        mission_id: mission_id.into(),
        goal: "Ship the controlled plan".into(),
        acceptance_criteria_version: "ac-v1".into(),
        criteria: vec![
            LoomPlanImportCriterion {
                criterion_id: "criterion_one".into(),
                text: "the delivery is complete".into(),
            },
            LoomPlanImportCriterion {
                criterion_id: "criterion_two".into(),
                text: "the delivery is reproducible".into(),
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
    }
}

fn criterion_result(criterion_id: &str, satisfied: bool) -> LoomAcceptanceCriterionResult {
    LoomAcceptanceCriterionResult {
        criterion_id: criterion_id.into(),
        satisfied,
        evidence_ids: vec![],
        note: None,
    }
}

fn policy_input(mission_id: &str, command_id: &str, reviewer: &str) -> LoomControlPolicyInput {
    LoomControlPolicyInput {
        mission_id: mission_id.into(),
        command_id: command_id.into(),
        expected_revision: 0,
        enabled: true,
        task_ids: vec!["task_a".into()],
        reviewers: vec![LoomReviewerAssignment {
            task_id: "task_a".into(),
            reviewer_agent_id: reviewer.into(),
        }],
        max_dispatches: 10,
        max_reworks_per_task: 2,
        expires_at: Some(FUTURE_EXPIRY.into()),
    }
}

fn pause_input(
    mission_id: &str,
    command_id: &str,
    revision: i64,
    paused: bool,
) -> LoomControlPauseInput {
    LoomControlPauseInput {
        mission_id: mission_id.into(),
        command_id: command_id.into(),
        expected_revision: revision,
        paused,
    }
}

fn stage_input(
    candidate_id: &str,
    revision: i64,
    manifest_hash: &str,
    verdict: LoomStageVerdict,
) -> LoomStageReviewInput {
    LoomStageReviewInput {
        task_id: "task_a".into(),
        candidate_id: candidate_id.into(),
        policy_revision: revision,
        manifest_hash: manifest_hash.into(),
        verdict,
        reason: "the internal stage judged this delivery".into(),
        criteria_results: vec![
            criterion_result("criterion_one", true),
            criterion_result("criterion_two", true),
        ],
    }
}

fn rejection_code(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<LoomCommandError>()
        .unwrap_or_else(|| panic!("expected a LOOM rejection, got: {error}"))
        .code()
}

fn camp_of(database: &OwnedTestDatabase, mission_id: &str) -> String {
    database
        .connection()
        .query_row("SELECT camp_id FROM mission WHERE id=?1", [mission_id], |row| {
            row.get(0)
        })
        .unwrap()
}

/// A real, live AgentRun for one member of the Mission's Camp, built from the same minimal
/// column set the existing agent-run fixtures use. The reviewer's trusted identity is only
/// credible because this row exists: `stage_review_record` resolves the agent through it and
/// refuses a run that is not `running` and not cancelled.
fn seed_run(database: &OwnedTestDatabase, camp_id: &str, agent_id: &str, run_id: &str) {
    let conversation_id = format!("conversation_{run_id}");
    let turn_id = format!("turn_{run_id}");
    database
        .connection()
        .execute_batch(&format!(
            "INSERT INTO conversation(id,camp_id,agent_id,created_at,updated_at)
             VALUES('{conversation_id}','{camp_id}','{agent_id}','2026-08-31','2026-08-31');
             INSERT INTO camp_turn(id,camp_id,trigger_type,trigger_id,status,created_at,updated_at)
             VALUES('{turn_id}','{camp_id}','system_event','{run_id}','running','2026-08-31','2026-08-31');"
        ))
        .unwrap();
    // A non-batch Run must leave direct camp/anchor/tail fields NULL. Its Camp is resolved
    // through `camp_turn`, as read by `COALESCE(run.camp_id, turn.camp_id)`.
    database
        .connection()
        .execute(
            "INSERT INTO agent_run(id,camp_turn_id,conversation_id,
                                   initial_camp_context_through_sequence,
                                   initial_conversation_context_through_sequence,
                                   responsibility_key,start_reason,purpose,completion_role,
                                   effective_config_json,workspace_json,status,idempotency_key,
                                   runtime_adapter_kind,execution_epoch,created_at,started_at,
                                   updated_at)
             VALUES(?1,?2,?3,0,0,?1,'initial','test','required','{}','{}','running',?1,
                    'qoder-cli',1,'2026-08-31','2026-08-31','2026-08-31')",
            params![run_id, turn_id, conversation_id],
        )
        .unwrap();
}

/// One delivery in review: the Task is released, `producer_run` claims it and records a
/// Candidate. Returns `(candidate_id, manifest_hash)`.
fn submitted_candidate(
    database: &mut OwnedTestDatabase,
    mission_id: &str,
    producer_run: &str,
) -> (String, String) {
    task_release(
        database,
        LoomTaskReleaseInput {
            mission_id: mission_id.into(),
            task_id: "task_a".into(),
        },
    )
    .unwrap();
    let claim = claim_acquire(
        database,
        LoomClaimAcquireInput {
            mission_id: mission_id.into(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.into(),
            claimant_agent_id: Some(PRODUCER_AGENT.into()),
            command_id: "command_claim".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    let candidate = candidate_record(
        database,
        LoomCandidateRecordInput {
            mission_id: mission_id.into(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.into(),
            claim_id: claim.claim_id,
            fence_generation: claim.fence_generation,
            command_id: "command_candidate_one".into(),
            content_hash: "sha256:delivery-one".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    let manifest = control::candidate_manifest_hash(database.connection(), &candidate.candidate_id)
        .unwrap();
    (candidate.candidate_id, manifest)
}

fn task_state(database: &OwnedTestDatabase, mission_id: &str, task_id: &str) -> String {
    database
        .connection()
        .query_row(
            "SELECT task.status FROM loom_task task
             JOIN loom_plan plan ON plan.plan_id = task.plan_id
             WHERE plan.mission_id=?1 AND task.task_id=?2",
            params![mission_id, task_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn acceptance_status(database: &OwnedTestDatabase, candidate_id: &str) -> String {
    database
        .connection()
        .query_row(
            "SELECT acceptance_status FROM loom_candidate WHERE candidate_id=?1",
            [candidate_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn count(database: &OwnedTestDatabase, sql: &str) -> i64 {
    database
        .connection()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

/// Authority boundary: automation is off by default, approving it is an Owner act, and the
/// configuration the Owner signs has to be honourable (members, scope, budget, expiry).
#[test]
fn control_stays_off_until_the_owner_approves_a_honourable_policy() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control authority");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();

    let snapshot = control::get(&database, &mission_id).unwrap();
    assert!(
        snapshot.policy.is_none(),
        "assertion automation_is_off_until_the_owner_approves_a_policy"
    );
    assert!(
        snapshot.stage_reviews.is_empty() && snapshot.dispatches.is_empty(),
        "assertion a_plan_without_a_policy_holds_no_control_facts"
    );

    let error = control::configure(
        &mut database,
        PRODUCER_AGENT,
        policy_input(&mission_id, "command_forged_approval", REVIEWER_AGENT),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_NOT_AUTHORIZED",
        "assertion a_member_cannot_approve_automation"
    );
    let error = control::pause(
        &mut database,
        PRODUCER_AGENT,
        pause_input(&mission_id, "command_forged_pause", 0, true),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_NOT_AUTHORIZED",
        "assertion a_member_cannot_pause_automation"
    );

    let error = control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_unknown_reviewer", "agent_missing"),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVIEWER_INVALID",
        "assertion a_reviewer_must_be_a_present_member_of_this_camp"
    );

    let mut missing_reviewer = policy_input(&mission_id, "command_no_reviewer", REVIEWER_AGENT);
    missing_reviewer.reviewers.clear();
    let error = control::configure(&mut database, OWNER, missing_reviewer).unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVIEWER_INVALID",
        "assertion every_task_in_scope_needs_exactly_one_reviewer"
    );

    let mut unknown_task = policy_input(&mission_id, "command_unknown_task", REVIEWER_AGENT);
    unknown_task.task_ids = vec!["task_missing".into()];
    unknown_task.reviewers = vec![LoomReviewerAssignment {
        task_id: "task_missing".into(),
        reviewer_agent_id: REVIEWER_AGENT.into(),
    }];
    let error = control::configure(&mut database, OWNER, unknown_task).unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_TASK_INVALID",
        "assertion a_policy_cannot_scope_a_task_that_does_not_exist"
    );

    let mut unbounded = policy_input(&mission_id, "command_unbounded", REVIEWER_AGENT);
    unbounded.max_dispatches = 1001;
    let error = control::configure(&mut database, OWNER, unbounded).unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_INVALID_INPUT",
        "assertion the_dispatch_budget_has_an_upper_bound"
    );

    let mut no_expiry = policy_input(&mission_id, "command_no_expiry", REVIEWER_AGENT);
    no_expiry.expires_at = None;
    let error = control::configure(&mut database, OWNER, no_expiry).unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_EXPIRES_INVALID",
        "assertion an_enabled_policy_needs_a_future_expiry"
    );

    // An approved policy alone executes nothing: the Tasks in scope carry no explicit assignee in
    // this Plan, and the scheduler never falls back to the Lead to find an executor.
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_no_assignee", REVIEWER_AGENT),
    )
    .unwrap();
    let admitted = control::admit_due_dispatches(&mut database).unwrap();
    assert_eq!(
        admitted, 0,
        "assertion a_task_without_an_explicit_assignee_is_not_dispatched"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
        0,
        "assertion no_assignee_writes_no_dispatch_ledger_row"
    );
}

/// Concurrency boundary: `revision` is the row counter every command compares and sets, while
/// `authorizationRevision` is the version of the grant. Pausing advances only the first, so a
/// stale pause is refused but a stage review taken under the standing grant still works; a new
/// approval advances both, which makes every older stage decision stale.
#[test]
fn control_commands_separate_the_row_revision_from_the_authorization() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control revisions");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);

    let approved = control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve", REVIEWER_AGENT),
    )
    .unwrap();
    let policy = approved.policy.expect("an approval must produce a policy");
    assert_eq!(
        (policy.revision, policy.authorization_revision, policy.approved_by.as_str()),
        (1, 1, OWNER),
        "assertion the_first_approval_starts_at_revision_one_and_authorization_one"
    );

    let stale = control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_stale", REVIEWER_AGENT),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&stale),
        "LOOM_CONTROL_REVISION_CONFLICT",
        "assertion an_approval_written_against_revision_zero_is_stale"
    );

    let replay = control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve", REVIEWER_AGENT),
    )
    .unwrap();
    assert_eq!(
        replay.policy.as_ref().map(|policy| policy.revision),
        Some(1),
        "assertion an_identical_approval_replays_the_recorded_receipt"
    );
    let mut changed = policy_input(&mission_id, "command_approve", REVIEWER_AGENT);
    changed.max_dispatches = 999;
    let error = control::configure(&mut database, OWNER, changed).unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_COMMAND_REUSED",
        "assertion a_reused_command_id_cannot_change_the_request"
    );

    // The stage review is written under authorization revision 1.
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);

    let paused = control::pause(
        &mut database,
        OWNER,
        pause_input(&mission_id, "command_pause", 1, true),
    )
    .unwrap();
    let policy = paused.policy.expect("pausing keeps the policy");
    assert_eq!(
        (policy.revision, policy.authorization_revision, policy.paused),
        (2, 1, true),
        "assertion pausing_advances_the_row_revision_but_not_the_authorization"
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_paused",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_PAUSED",
        "assertion a_paused_plan_cannot_take_the_next_step"
    );

    // A command written against the pre-pause revision is stale even though the grant is the same.
    let stale_pause = control::pause(
        &mut database,
        OWNER,
        pause_input(&mission_id, "command_pause_stale", 1, false),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&stale_pause),
        "LOOM_CONTROL_REVISION_CONFLICT",
        "assertion a_pause_written_against_an_older_revision_is_refused"
    );

    let resumed = control::pause(
        &mut database,
        OWNER,
        pause_input(&mission_id, "command_resume", 2, false),
    )
    .unwrap();
    let policy = resumed.policy.expect("resuming keeps the policy");
    assert_eq!(
        (policy.revision, policy.authorization_revision, policy.paused),
        (3, 1, false),
        "assertion resuming_reuses_the_standing_authorization"
    );

    // Resume spent the same grant, so the verdict written against authorization 1 still lands.
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_after_resume",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        recorded.review.policy_revision, 1,
        "assertion the_verdict_records_the_authorization_it_was_written_under"
    );

    // A new approval advances the authorization, so the older stage decision no longer applies.
    let mut reapprove = policy_input(&mission_id, "command_reapprove", REVIEWER_AGENT);
    reapprove.expected_revision = 3;
    let reapproved = control::configure(&mut database, OWNER, reapprove).unwrap();
    let policy = reapproved.policy.expect("re-approving keeps the policy");
    assert_eq!(
        (policy.revision, policy.authorization_revision),
        (4, 2),
        "assertion re_approving_advances_both_the_revision_and_the_authorization"
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_stale_authorization",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::RequestChanges),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVISION_CONFLICT",
        "assertion a_stage_verdict_under_a_superseded_authorization_is_refused"
    );
}

/// Reviewer identity boundary: the verdict is accepted only from the assigned reviewer, only from
/// a live run of that agent, and never from the delivery's own producer. An unresolvable producer
/// fails closed instead of silently skipping the self-review guard.
#[test]
fn stage_review_refuses_untrusted_reviewers_and_unresolvable_producers() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control reviewer identity");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_identity", REVIEWER_AGENT),
    )
    .unwrap();
    // The delivery names a producing run that no longer exists, so it cannot be excluded from
    // reviewing; every case below must therefore fail closed.
    let (candidate_id, manifest) =
        submitted_candidate(&mut database, &mission_id, "run_producer_gone");

    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        PRODUCER_AGENT,
        PRODUCER_RUN,
        "command_stage_not_assigned",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVIEWER_INVALID",
        "assertion only_the_assigned_reviewer_may_record_the_stage_verdict"
    );

    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        "run_that_does_not_exist",
        "command_stage_unknown_run",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEWER_RUN_INVALID",
        "assertion the_reviewer_run_must_be_a_live_run_of_this_agent"
    );

    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_unresolvable_producer",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEWER_RUN_INVALID",
        "assertion an_unresolvable_producer_fails_closed_instead_of_being_skipped"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        0,
        "assertion a_refused_verdict_leaves_no_stage_review_behind"
    );
}

/// Evidence boundary: the manifest is the Core's own document over the stored Candidate, its
/// criteria text and its artifacts, and a pass has to answer every criterion exactly once.
#[test]
fn stage_review_binds_the_core_manifest_and_a_complete_verdict() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control evidence");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_evidence", REVIEWER_AGENT),
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);

    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_manifest",
        stage_input(
            &candidate_id,
            1,
            "0000000000000000000000000000000000000000000000000000000000000000",
            LoomStageVerdict::Pass,
        ),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_MANIFEST_MISMATCH",
        "assertion a_reviewer_cannot_judge_a_manifest_the_core_did_not_compute"
    );

    let mut partial = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass);
    partial.criteria_results = vec![criterion_result("criterion_one", true)];
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_partial",
        partial,
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_CRITERIA_INCOMPLETE",
        "assertion every_criterion_of_the_pinned_snapshot_must_be_answered_exactly_once"
    );

    let mut unsatisfied = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass);
    unsatisfied.criteria_results = vec![
        criterion_result("criterion_one", true),
        criterion_result("criterion_two", false),
    ];
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_unsatisfied",
        unsatisfied,
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_CRITERIA_INCOMPLETE",
        "assertion a_pass_must_satisfy_every_criterion"
    );

    // The r1 input contract: the shape is refused before the transaction opens.
    let mut foreign_evidence = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass);
    foreign_evidence.criteria_results[0].evidence_ids = vec!["artifact_of_somebody_else".into()];
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_foreign_evidence",
        foreign_evidence,
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_EVIDENCE_NOT_FOUND",
        "assertion a_verdict_may_only_cite_evidence_of_the_candidate_it_judges"
    );

    let mut duplicate_evidence = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass);
    duplicate_evidence.criteria_results[0].evidence_ids =
        vec!["artifact_x".into(), "artifact_x".into()];
    assert_eq!(
        rejection_code(
            &control::stage_review_record(
                &mut database,
                &mission_id,
                REVIEWER_AGENT,
                REVIEWER_RUN,
                "command_stage_duplicate_evidence",
                duplicate_evidence,
            )
            .unwrap_err()
        ),
        "LOOM_INVALID_INPUT",
        "assertion one_criterion_cannot_cite_the_same_evidence_twice"
    );

    let mut uppercase_manifest = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass);
    uppercase_manifest.manifest_hash = manifest.to_uppercase();
    assert_eq!(
        rejection_code(
            &control::stage_review_record(
                &mut database,
                &mission_id,
                REVIEWER_AGENT,
                REVIEWER_RUN,
                "command_stage_uppercase_manifest",
                uppercase_manifest,
            )
            .unwrap_err()
        ),
        "LOOM_INVALID_INPUT",
        "assertion the_manifest_hash_must_be_64_lowercase_hex_characters"
    );

    let mut long_reason = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass);
    long_reason.reason = "x".repeat(4001);
    assert_eq!(
        rejection_code(
            &control::stage_review_record(
                &mut database,
                &mission_id,
                REVIEWER_AGENT,
                REVIEWER_RUN,
                "command_stage_long_reason",
                long_reason,
            )
            .unwrap_err()
        ),
        "LOOM_INVALID_INPUT",
        "assertion the_reason_is_bounded_at_4000_characters"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        0,
        "assertion no_refused_shape_leaves_a_stage_review_behind"
    );
}

/// Outcome boundary: `pass` ends the internal stage and nothing else — no acceptance, no Review
/// row, no Task transition, no dependency release, and a replay cannot change the verdict.
#[test]
fn pass_ends_the_internal_stage_without_accepting_the_candidate() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control pass");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_pass", REVIEWER_AGENT),
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);

    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_pass",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        (recorded.task_status, recorded.review.manifest_hash.as_str()),
        (super::LoomTaskStatus::InReview, manifest.as_str()),
        "assertion a_pass_keeps_the_task_in_review_and_the_computed_manifest"
    );
    assert_eq!(
        task_state(&database, &mission_id, "task_a"),
        "IN_REVIEW",
        "assertion the_task_stays_in_review_after_a_pass"
    );
    assert_eq!(
        acceptance_status(&database, &candidate_id),
        "PENDING",
        "assertion a_pass_never_marks_the_candidate_accepted"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_review"),
        0,
        "assertion a_pass_writes_no_owner_review"
    );
    assert_eq!(
        count(
            &database,
            "SELECT COUNT(*) FROM loom_dependency WHERE resolved_at IS NOT NULL"
        ),
        0,
        "assertion a_pass_releases_no_dependency"
    );

    let replay = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_pass",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert!(
        replay.replayed && replay.review.stage_review_id == recorded.review.stage_review_id,
        "assertion an_identical_stage_command_replays_the_recorded_verdict"
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_pass",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::RequestChanges),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_REPLAY_CONFLICT",
        "assertion a_replayed_command_id_cannot_change_the_verdict"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        1,
        "assertion a_conflicting_replay_writes_no_second_verdict"
    );
}

/// Rework boundary: `request_changes` returns the Task under a new Run and a chained Candidate,
/// never forges the Owner's rejection, and a superseded Candidate can no longer be accepted.
#[test]
fn request_changes_returns_the_task_for_a_new_chained_candidate() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control rework");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_rework", REVIEWER_AGENT),
    )
    .unwrap();
    let (first_candidate_id, manifest) =
        submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);

    let mut request_changes = stage_input(
        &first_candidate_id,
        1,
        &manifest,
        LoomStageVerdict::RequestChanges,
    );
    request_changes.criteria_results = vec![
        criterion_result("criterion_one", true),
        criterion_result("criterion_two", false),
    ];
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_request_changes",
        request_changes,
    )
    .unwrap();
    assert_eq!(
        recorded.task_status,
        super::LoomTaskStatus::Ready,
        "assertion a_request_for_changes_returns_the_task_to_ready"
    );
    assert_eq!(
        acceptance_status(&database, &first_candidate_id),
        "PENDING",
        "assertion a_request_for_changes_is_not_a_human_rejection"
    );
    assert_eq!(
        count(
            &database,
            "SELECT COUNT(*) FROM loom_claim WHERE released_at IS NOT NULL"
        ),
        1,
        "assertion a_request_for_changes_releases_the_old_claim"
    );

    let second_claim = claim_acquire(
        &mut database,
        LoomClaimAcquireInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: "run_rework".into(),
            claimant_agent_id: Some(PRODUCER_AGENT.into()),
            command_id: "command_claim_rework".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    // Omitting the link would let two deliveries both claim to be the current version.
    let unlinked = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: "run_rework".into(),
            claim_id: second_claim.claim_id.clone(),
            fence_generation: second_claim.fence_generation,
            command_id: "command_candidate_unlinked".into(),
            content_hash: "sha256:delivery-two".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&unlinked),
        "LOOM_CANDIDATE_PREVIOUS_INVALID",
        "assertion a_rework_must_chain_to_the_candidate_it_replaced"
    );

    let second = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: "run_rework".into(),
            claim_id: second_claim.claim_id,
            fence_generation: second_claim.fence_generation,
            command_id: "command_candidate_two".into(),
            content_hash: "sha256:delivery-two".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: Some(first_candidate_id.clone()),
        },
    )
    .unwrap();
    assert_eq!(
        second.previous_candidate_id.as_deref(),
        Some(first_candidate_id.as_str()),
        "assertion the_chained_candidate_names_its_predecessor"
    );

    let error = review_record(
        &mut database,
        LoomReviewRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            candidate_id: first_candidate_id.clone(),
            command_id: "command_review_stale".into(),
            acceptance_criteria_version: "ac-v1".into(),
            verdict: LoomReviewVerdict::Accepted,
            reason: "accepting the superseded delivery".into(),
            criteria_results: vec![
                criterion_result("criterion_one", true),
                criterion_result("criterion_two", true),
            ],
            reviewer_id: OWNER.into(),
        },
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CANDIDATE_STALE",
        "assertion a_superseded_candidate_cannot_be_accepted"
    );
}

/// Stop boundary: `blocked` parks the Task with the reviewer's reason and stops it.
#[test]
fn blocked_parks_the_task_with_the_reviewer_reason() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control blocked");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_blocked", REVIEWER_AGENT),
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);

    let mut blocked = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Blocked);
    blocked.reason = "the delivery needs a decision nobody has made".into();
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_blocked",
        blocked,
    )
    .unwrap();
    assert_eq!(
        recorded.task_status,
        super::LoomTaskStatus::Blocked,
        "assertion blocked_parks_the_task"
    );
    let blocked_reason: Option<String> = database
        .connection()
        .query_row(
            "SELECT task.blocked_reason FROM loom_task task
             JOIN loom_plan plan ON plan.plan_id = task.plan_id
             WHERE plan.mission_id=?1 AND task.task_id='task_a'",
            [&mission_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("the delivery needs a decision nobody has made"),
        "assertion the_park_reason_names_the_reviewer_reason"
    );
    assert_eq!(
        acceptance_status(&database, &candidate_id),
        "PENDING",
        "assertion blocking_is_not_a_human_verdict_either"
    );
}

/// Dispatch boundary: the budget is spent against the whole ledger (cancelled rows included), an
/// exhausted budget stops the event without inventing a dispatch, and the pre-execution recheck
/// fails closed on every fact that moved.
#[test]
fn dispatch_admission_spends_the_ledger_and_rechecks_before_running() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control dispatch");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let plan_id: String = database
        .connection()
        .query_row("SELECT plan_id FROM loom_plan WHERE mission_id=?1", [&mission_id], |row| {
            row.get(0)
        })
        .unwrap();

    // A Task that is ready and explicitly assigned: this is the only shape EXECUTE may take.
    database
        .connection()
        .execute_batch(&format!(
            "UPDATE loom_task SET status='READY', assignee_agent_id='{PRODUCER_AGENT}'
             WHERE plan_id='{plan_id}' AND task_id='task_a'"
        ))
        .unwrap();

    let mut policy = policy_input(&mission_id, "command_approve_dispatch", REVIEWER_AGENT);
    policy.max_dispatches = 5;
    // Both Tasks are inside the approved scope, so the dependency case below is decided by the
    // upstream edge and not by a missing scope entry.
    policy.task_ids = vec!["task_a".into(), "task_b".into()];
    policy.reviewers = vec![
        LoomReviewerAssignment {
            task_id: "task_a".into(),
            reviewer_agent_id: REVIEWER_AGENT.into(),
        },
        LoomReviewerAssignment {
            task_id: "task_b".into(),
            reviewer_agent_id: REVIEWER_AGENT.into(),
        },
    ];
    control::configure(&mut database, OWNER, policy).unwrap();

    // The real path: this Task is in scope, ready, explicitly assigned and its dependencies are
    // satisfied, so the scheduler admits exactly one Delivery for it.
    let first_tick = control::admit_due_dispatches(&mut database).unwrap();
    assert_eq!(
        first_tick, 1,
        "assertion one_ready_assigned_task_admits_exactly_one_dispatch"
    );
    let (dispatch_id, delivery_id, dedupe_key): (String, Option<String>, String) = database
        .connection()
        .query_row(
            "SELECT dispatch_id, delivery_id, dedupe_key FROM loom_control_dispatch",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert!(
        delivery_id.is_some(),
        "assertion an_admitted_dispatch_is_bound_to_a_real_delivery"
    );
    assert!(
        dedupe_key.starts_with("[\"EXECUTE\",") && dedupe_key.ends_with(",\"task_a\"]"),
        "assertion the_execution_event_key_is_a_stable_json_identity"
    );

    // A READY Task whose upstream is not satisfied is not handed out either: the dependency gate
    // is re-proved for both DRAFT and READY, not only on release.
    database
        .connection()
        .execute_batch(&format!(
            "UPDATE loom_task SET status='READY', assignee_agent_id='{PRODUCER_AGENT}'
             WHERE plan_id='{plan_id}' AND task_id='task_b'"
        ))
        .unwrap();
    let dependency_tick = control::admit_due_dispatches(&mut database).unwrap();
    assert_eq!(
        dependency_tick, 0,
        "assertion a_ready_task_with_an_unreleased_dependency_is_not_dispatched"
    );
    assert_eq!(
        count(
            &database,
            "SELECT COUNT(*) FROM loom_control_dispatch WHERE task_id='task_b'"
        ),
        0,
        "assertion an_unreleased_dependency_writes_no_ledger_row"
    );
    assert_eq!(
        control::dispatch_block_reason(database.connection(), &dispatch_id, &chrono::Utc::now().to_rfc3339())
            .unwrap(),
        None,
        "assertion an_admitted_execution_passes_its_pre_run_recheck"
    );

    // A second tick must not mistake the already-dispatched event for a new cost.
    assert_eq!(
        control::dispatches_consumed(&database, &mission_id).unwrap(),
        1,
        "assertion the_admitted_dispatch_is_the_one_spent_slot"
    );

    // Shrink the budget to exactly what was already spent. The event that is already out must not
    // be reported as over budget just because the next tick re-reads the ledger.
    let mut shrunk = policy_input(&mission_id, "command_shrink_dispatch", REVIEWER_AGENT);
    shrunk.expected_revision = 1;
    shrunk.max_dispatches = 1;
    shrunk.task_ids = vec!["task_a".into(), "task_b".into()];
    shrunk.reviewers = vec![
        LoomReviewerAssignment {
            task_id: "task_a".into(),
            reviewer_agent_id: REVIEWER_AGENT.into(),
        },
        LoomReviewerAssignment {
            task_id: "task_b".into(),
            reviewer_agent_id: REVIEWER_AGENT.into(),
        },
    ];
    control::configure(&mut database, OWNER, shrunk).unwrap();

    let admitted = control::admit_due_dispatches(&mut database).unwrap();
    assert_eq!(
        admitted, 0,
        "assertion a_repeated_tick_admits_nothing_for_an_event_already_out"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
        1,
        "assertion a_repeated_tick_never_duplicates_the_ledger_row"
    );
    let (status, reason): (String, Option<String>) = database
        .connection()
        .query_row(
            "SELECT status, blocked_reason FROM loom_task WHERE plan_id=?1 AND task_id='task_a'",
            [&plan_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (status.as_str(), reason.as_deref()),
        ("READY", None),
        "assertion a_repeated_tick_never_marks_an_already_dispatched_task_as_over_budget"
    );
    assert_eq!(
        rejection_code(
            &control::stage_review_record(
                &mut database,
                &mission_id,
                REVIEWER_AGENT,
                REVIEWER_RUN,
                "command_stage_after_budget",
                stage_input("candidate_missing", 2, &"0".repeat(64), LoomStageVerdict::Pass),
            )
            .unwrap_err()
        ),
        "LOOM_CANDIDATE_NOT_FOUND",
        "assertion a_task_without_a_candidate_cannot_be_stage_reviewed"
    );

    // A reserved dispatch that was already recorded rechecks every fact before it may run. The
    // earlier execution was admitted but no Run ever claimed its Delivery, so it did not execute —
    // that is not an unknown outcome and must not block the reserved row.
    let authorization = control::get(&database, &mission_id)
        .unwrap()
        .policy
        .expect("the shrinking approval is still a policy")
        .authorization_revision;
    database
        .connection()
        .execute(
            "INSERT INTO loom_control_dispatch(dispatch_id,plan_id,task_id,kind,candidate_id,
                                               policy_revision,recipient_agent_id,delivery_id,
                                               status,reason,dedupe_key,created_at,updated_at)
             VALUES('dispatch_reserved',?1,'task_a','EXECUTE',NULL,?3,?2,NULL,'WAITING',NULL,
                    '[\"EXECUTE\",\"reserved\",\"task_a\"]','2026-08-31','2026-08-31')",
            params![&plan_id, PRODUCER_AGENT, authorization],
        )
        .unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let reserved_reason = control::dispatch_block_reason(
        database.connection(),
        "dispatch_reserved",
        &now,
    )
    .unwrap();
    assert_eq!(
        reserved_reason, None,
        "assertion an_unclaimed_earlier_delivery_is_not_an_unknown_outcome"
    );

    control::pause(
        &mut database,
        OWNER,
        pause_input(&mission_id, "command_pause_dispatch", 2, true),
    )
    .unwrap();
    assert_eq!(
        control::dispatch_block_reason(database.connection(), "dispatch_reserved", &now)
            .unwrap()
            .as_deref(),
        Some("loom.control_paused"),
        "assertion the_recheck_stops_a_reserved_dispatch_once_the_policy_is_paused"
    );
    database
        .connection()
        .execute(
            "UPDATE loom_control_dispatch SET status='CANCELLED' WHERE dispatch_id=?1",
            [&dispatch_id],
        )
        .unwrap();
    assert_eq!(
        control::dispatch_block_reason(database.connection(), &dispatch_id, &now)
            .unwrap()
            .as_deref(),
        Some("loom.dispatch_not_pending"),
        "assertion a_settled_ledger_row_is_never_re_executed"
    );

    // Reconciliation only ever judges a dispatch that a Delivery actually carries: a row that never
    // reached a Delivery is not settled by a later pass, and no pass rewrites the recorded event.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion a_later_pass_admits_nothing_for_an_event_already_recorded"
    );
    let reserved_row: (String, Option<String>, String) = database
        .connection()
        .query_row(
            "SELECT status, delivery_id, dedupe_key FROM loom_control_dispatch
             WHERE dispatch_id='dispatch_reserved'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (reserved_row.0.as_str(), reserved_row.1.as_deref()),
        ("WAITING", None),
        "assertion an_unbound_reserved_dispatch_is_never_settled_by_a_later_pass"
    );
    assert_eq!(
        reserved_row.2, "[\"EXECUTE\",\"reserved\",\"task_a\"]",
        "assertion a_pass_never_rewrites_the_recorded_event_identity"
    );
}

/// Persistence boundary: the approval and the stage verdicts are Core SQLite facts. The database
/// is closed and reopened through the production entry (`Database::open`, which runs the data
/// contract admission), then read back through the product read path — not through a bare SQLite
/// connection that would bypass admission.
#[test]
fn control_facts_survive_a_database_reopen() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control persistence");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_persist", REVIEWER_AGENT),
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);
    control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_persist",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();

    let directory = database.directory().to_path_buf();
    database.close();
    let reopened = Database::open(&directory).expect("the reopened database must be admitted");
    let snapshot = control::get(&reopened, &mission_id).unwrap();
    let policy = snapshot.policy.expect("the approval must survive the reopen");
    assert_eq!(
        (policy.revision, policy.authorization_revision, policy.approved_by.as_str()),
        (1, 1, OWNER),
        "assertion the_approved_policy_is_storage_not_process_state"
    );
    assert_eq!(
        snapshot.stage_reviews.len(),
        1,
        "assertion the_stage_verdict_is_storage_not_process_state"
    );
    assert_eq!(
        snapshot.stage_reviews[0].manifest_hash, manifest,
        "assertion the_reopened_verdict_still_binds_the_same_manifest"
    );
}

/// The `blocked_reason` this module persists for one Task, or `None` when it carries none.
fn task_blocked_reason(database: &OwnedTestDatabase, plan_id: &str, task_id: &str) -> Option<String> {
    database
        .connection()
        .query_row(
            "SELECT blocked_reason FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![plan_id, task_id],
            |row| row.get(0),
        )
        .unwrap()
}

/// The row counter of one Task: the module's own reasons only ever advance it by a real write, so
/// an unchanged value proves that a pass wrote nothing at all.
fn task_row_revision(database: &OwnedTestDatabase, plan_id: &str, task_id: &str) -> i64 {
    database
        .connection()
        .query_row(
            "SELECT revision FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![plan_id, task_id],
            |row| row.get(0),
        )
        .unwrap()
}

/// The runtime installation one Agent is bound to — the facts that decide disabled/offline/harness.
fn installation_of(database: &OwnedTestDatabase, agent_id: &str) -> String {
    database
        .connection()
        .query_row(
            "SELECT default_runtime_installation_id FROM agent_profile WHERE id=?1",
            [agent_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap()
        .unwrap_or_else(|| panic!("agent {agent_id} must be bound to a runtime installation"))
}

/// Deliveries the control plane created: the handoff lane and nothing else.
fn loom_deliveries(database: &OwnedTestDatabase) -> i64 {
    count(
        database,
        "SELECT COUNT(*) FROM camp_message_delivery WHERE message_id IN
             (SELECT id FROM camp_message WHERE author_id='loom-control-scheduler')",
    )
}

/// The one shape an EXECUTE dispatch may take: a Plan whose `task_a` is READY, explicitly assigned
/// and inside an approved policy. `extra_tasks` add further READY Tasks of the same Plan with the
/// assignee they name, so a single pass can hand work to two Recipients at once without inventing a
/// dependency edge the Plan never declared.
fn dispatchable_plan(
    database: &mut OwnedTestDatabase,
    title: &str,
    command_id: &str,
    members: &[&str],
    extra_tasks: &[(&str, &str)],
) -> (String, String) {
    let mission_id = create_mission_with_members(database, title, members);
    plan_import(database, plan_input(&mission_id)).unwrap();
    let plan_id: String = database
        .connection()
        .query_row("SELECT plan_id FROM loom_plan WHERE mission_id=?1", [&mission_id], |row| {
            row.get(0)
        })
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE loom_task SET status='READY', assignee_agent_id=?1
             WHERE plan_id=?2 AND task_id='task_a'",
            params![PRODUCER_AGENT, &plan_id],
        )
        .unwrap();
    let mut scoped = vec!["task_a".to_string()];
    for (task_id, assignee) in extra_tasks {
        database
            .connection()
            .execute(
                "INSERT INTO loom_task(task_id,plan_id,title,description,assignee_agent_id,status,
                                       acceptance_criteria_json,created_at,updated_at,revision)
                 SELECT ?1,plan_id,?1,'A second dispatchable task',?2,'READY',
                        acceptance_criteria_json,created_at,updated_at,revision
                 FROM loom_task WHERE plan_id=?3 AND task_id='task_a'",
                params![task_id, assignee, &plan_id],
            )
            .unwrap();
        scoped.push((*task_id).to_string());
    }
    let mut policy = policy_input(&mission_id, command_id, REVIEWER_AGENT);
    policy.task_ids = scoped.clone();
    policy.reviewers = scoped
        .iter()
        .map(|task_id| LoomReviewerAssignment {
            task_id: task_id.clone(),
            reviewer_agent_id: REVIEWER_AGENT.into(),
        })
        .collect();
    control::configure(database, OWNER, policy).unwrap();
    (mission_id, plan_id)
}

/// The stable identity of the EXECUTE event of one Task, written the same way the scheduler writes
/// it: a JSON array, so a part can never run into its neighbour.
fn execute_event_key(plan_id: &str, task_id: &str) -> String {
    serde_json::to_string(&["EXECUTE", plan_id, task_id]).unwrap()
}

/// Failure-vocabulary boundary, ported from Mikka
/// `lib/factory/dispatch-recovery.ts:factoryDispatchFailureReason`: the reason names the first fact
/// that makes the recipient unusable, in the order switch → presence → harness, and the same
/// vocabulary is what the pre-run recheck hands to the wrapper.
#[test]
fn dispatch_failure_reason_follows_the_disabled_offline_harness_order() {
    let mut database = fixture();
    let (_mission_id, plan_id) =
        dispatchable_plan(
            &mut database,
            "dispatch failure vocabulary",
            "command_approve_vocabulary",
            &[PRODUCER_AGENT, REVIEWER_AGENT],
            &[],
        );
    let camp_id: String = database
        .connection()
        .query_row("SELECT camp_id FROM mission WHERE id=(SELECT mission_id FROM loom_plan WHERE plan_id=?1)", [&plan_id], |row| {
            row.get(0)
        })
        .unwrap();
    let installation_id = installation_of(&database, PRODUCER_AGENT);

    // Every fact is broken at once, so only the *order* of the ladder can decide what is recorded.
    database
        .connection()
        .execute_batch(&format!(
            "UPDATE camp_member SET status='left' WHERE camp_id='{camp_id}' AND agent_id='{PRODUCER_AGENT}';
             UPDATE adapter_installation SET path_state='path_missing' WHERE id='{installation_id}';
             UPDATE agent_profile SET selected_runtime_adapter_kind='claude-code-cli'
             WHERE id='{PRODUCER_AGENT}';"
        ))
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion a_switched_off_recipient_is_never_dispatched"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_disabled"),
        "assertion the_switch_outranks_presence_and_the_harness"
    );

    // The switch comes back but the runtime is still gone and the harness still does not match:
    // presence is the next fact the ladder asks, so it wins over the harness.
    database
        .connection()
        .execute_batch(&format!(
            "UPDATE camp_member SET status='active' WHERE camp_id='{camp_id}' AND agent_id='{PRODUCER_AGENT}';
             UPDATE agent_profile SET profile_status='away' WHERE id='{PRODUCER_AGENT}';"
        ))
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion presence_outranks_the_harness_even_when_the_profile_is_merely_away"
    );

    // A present member, but the runtime it is bound to cannot be reached: still presence.
    database
        .connection()
        .execute(
            "UPDATE agent_profile SET profile_status='present' WHERE id=?1",
            [PRODUCER_AGENT],
        )
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion an_unreachable_runtime_outranks_the_harness_it_would_run"
    );

    // The reserved-Delivery recheck is the same rule set, so it names the same fact.
    database
        .connection()
        .execute(
            "INSERT INTO loom_control_dispatch(dispatch_id,plan_id,task_id,kind,candidate_id,
                                               policy_revision,recipient_agent_id,delivery_id,
                                               status,reason,dedupe_key,created_at,updated_at)
             VALUES('dispatch_reserved',?1,'task_a','EXECUTE',NULL,1,?2,NULL,'WAITING',NULL,
                    '[\\\"EXECUTE\\\",\\\"reserved\\\",\\\"task_a\\\"]','2026-08-31','2026-08-31')",
            params![&plan_id, PRODUCER_AGENT],
        )
        .unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    assert_eq!(
        control::dispatch_block_reason(database.connection(), "dispatch_reserved", &now)
            .unwrap()
            .as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion the_prerun_recheck_reports_the_same_presence_fact"
    );

    // Reachable again, but the harness the Agent must run is not the one installed there.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_harness_unavailable"),
        "assertion a_reachable_recipient_with_the_wrong_harness_is_reported_as_the_harness"
    );
    assert_eq!(
        control::dispatch_block_reason(database.connection(), "dispatch_reserved", &now)
            .unwrap()
            .as_deref(),
        Some("loom.dispatch_harness_unavailable"),
        "assertion the_prerun_recheck_follows_the_same_ladder"
    );

    // The last fact is repaired and nothing is left to explain, so the event is admitted and every
    // recorded reason this module owns is cleared instead of being left behind.
    database
        .connection()
        .execute(
            "UPDATE agent_profile SET selected_runtime_adapter_kind='codex-cli' WHERE id=?1",
            [PRODUCER_AGENT],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion a_fully_available_recipient_is_dispatched"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion a_successful_admission_clears_the_failure_vocabulary"
    );
    assert_eq!(
        control::dispatch_block_reason(database.connection(), "dispatch_reserved", &now).unwrap(),
        None,
        "assertion the_prerun_recheck_passes_once_every_fact_is_repaired"
    );
}

/// Dedupe boundary: one recorded failure per reason, so repeated ticks cannot turn one unavailable
/// recipient into a stream of events, and recovery resumes the *same* event identity instead of
/// minting a second Delivery.
#[test]
fn a_dispatch_failure_is_recorded_once_and_recovery_resumes_the_same_event() {
    let mut database = fixture();
    let (_mission_id, plan_id) =
        dispatchable_plan(
            &mut database,
            "dispatch failure dedupe",
            "command_approve_dedupe",
            &[PRODUCER_AGENT, REVIEWER_AGENT],
            &[],
        );
    let installation_id = installation_of(&database, PRODUCER_AGENT);
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();

    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    let recorded_revision = task_row_revision(&database, &plan_id, "task_a");
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion the_first_unreachable_pass_records_the_presence_fact"
    );

    // A repeated tick re-derives the same conclusion. It must not write a second copy of it: the
    // reason is unchanged and the Task row is not touched at all.
    for _ in 0..3 {
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion a_repeated_tick_admits_nothing_while_the_recipient_is_unreachable"
        );
    }
    assert_eq!(
        task_row_revision(&database, &plan_id, "task_a"),
        recorded_revision,
        "assertion a_repeated_tick_writes_no_second_failure_record"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
        0,
        "assertion an_unreachable_recipient_never_reaches_the_ledger"
    );
    assert_eq!(
        loom_deliveries(&database),
        0,
        "assertion an_unreachable_recipient_creates_no_delivery"
    );

    // The runtime is back: the same Task is handed out under the identity it always had, so the
    // Delivery that finally starts is the one the failed passes named — not a new copy of it.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_recovered_recipient_is_dispatched_by_the_next_pass"
    );
    let (dedupe_key, delivery_id): (String, Option<String>) = database
        .connection()
        .query_row(
            "SELECT dedupe_key, delivery_id FROM loom_control_dispatch WHERE task_id='task_a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        dedupe_key,
        execute_event_key(&plan_id, "task_a"),
        "assertion recovery_reuses_the_same_event_identity_the_failed_passes_named"
    );
    assert!(
        delivery_id.is_some(),
        "assertion the_resumed_event_is_bound_to_a_real_delivery"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion recovery_clears_the_recorded_failure"
    );

    for _ in 0..2 {
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion a_resumed_event_is_never_dispatched_twice"
        );
    }
    assert_eq!(
        (count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"), loom_deliveries(&database)),
        (1, 1),
        "assertion recovery_leaves_exactly_one_ledger_row_and_one_delivery"
    );
}

/// Recovery boundary: a Delivery that is already reserved waits for an unreachable recipient instead
/// of starting. The Delivery *is* the queued work — Core creates the Run from it at claim time — so
/// "the same queued Run continues" means this exact row, and the exact handoff message behind it,
/// survives the outage untouched: nothing is re-queued, nothing is rebuilt, and no second Delivery
/// appears.
#[test]
fn an_unreachable_recipient_holds_the_reserved_delivery_and_the_same_queued_work_continues() {
    let mut database = fixture();
    let (_mission_id, _plan_id) = dispatchable_plan(
        &mut database,
        "dispatch recovery keeps the queued run",
        "command_approve_recovery",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_reachable_plan_reserves_its_first_delivery"
    );
    let (dispatch_id, delivery_id): (String, String) = database
        .connection()
        .query_row(
            "SELECT dispatch_id, delivery_id FROM loom_control_dispatch",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    // The reserved Delivery is the queued work: a real handoff message, one waiting row and no Run
    // yet, because Core materialises the Run when the queue claims it.
    let (message_id, queue_sequence, delivery_status): (String, i64, String) = database
        .connection()
        .query_row(
            "SELECT message_id, queue_sequence, status FROM camp_message_delivery WHERE id=?1",
            [&delivery_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        delivery_status, "waiting",
        "assertion a_reserved_delivery_waits_to_be_claimed"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM agent_run"),
        0,
        "assertion a_waiting_delivery_has_no_run_of_its_own_yet"
    );

    // The recipient drops out after the reservation. The wrapper asks before every start, so the
    // reserved Delivery waits and nothing about it is rebuilt.
    let installation_id = installation_of(&database, PRODUCER_AGENT);
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    assert_eq!(
        control::dispatch_block_reason(database.connection(), &dispatch_id, &now)
            .unwrap()
            .as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion a_reserved_delivery_waits_for_an_unreachable_recipient"
    );
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion waiting_for_the_recipient_is_not_a_second_dispatch"
    );

    // The recipient comes back: the same Delivery, carrying the same queued Run, may start.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(
        control::dispatch_block_reason(database.connection(), &dispatch_id, &now).unwrap(),
        None,
        "assertion the_reserved_delivery_may_start_once_the_recipient_is_reachable"
    );
    let (status, still_the_delivery): (String, bool) = database
        .connection()
        .query_row(
            "SELECT status, id=?2 FROM camp_message_delivery WHERE id=?1",
            params![&delivery_id, &delivery_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (status.as_str(), still_the_delivery),
        ("waiting", true),
        "assertion the_queued_delivery_is_untouched_while_it_waits"
    );
    let (same_message, same_sequence, still_waiting, still_unclaimed): (String, i64, String, bool) =
        database
            .connection()
            .query_row(
                "SELECT message_id, queue_sequence, status, claimed_agent_run_id IS NULL
                 FROM camp_message_delivery WHERE id=?1",
                [&delivery_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
    assert_eq!(
        (same_message.as_str(), same_sequence, still_waiting.as_str(), still_unclaimed),
        (message_id.as_str(), queue_sequence, "waiting", true),
        "assertion the_same_queued_work_continues_after_recovery"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM agent_run"),
        0,
        "assertion recovery_never_queues_the_work_a_second_time"
    );
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion recovery_reuses_the_reservation_instead_of_dispatching_again"
    );
    assert_eq!(
        (count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"), loom_deliveries(&database)),
        (1, 1),
        "assertion recovery_adds_no_second_ledger_row_and_no_second_delivery"
    );
}

/// Concurrency boundary, ported from the upstream rule that a heartbeat which commits while the
/// dispatch write waits for the lock must be observed: the availability of every recipient is read
/// inside the writing transaction, so a pass that waited for the lock dispatches the recipients that
/// came back in the meantime — one Delivery each, never a failure record for a stale reading.
#[test]
fn recipients_that_come_back_while_the_pass_waits_for_the_lock_are_dispatched_once() {
    let mut database = fixture();
    let (_mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch concurrent recovery",
        "command_approve_concurrent",
        &[PRODUCER_AGENT, REVIEWER_AGENT, SECOND_PRODUCER_AGENT],
        &[("task_second", SECOND_PRODUCER_AGENT)],
    );
    let installation_id = installation_of(&database, PRODUCER_AGENT);
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion neither_recipient_is_dispatched_while_the_runtime_is_unreachable"
    );
    for task_id in ["task_a", "task_second"] {
        assert_eq!(
            task_blocked_reason(&database, &plan_id, task_id).as_deref(),
            Some("loom.dispatch_recipient_offline"),
            "assertion every_waiting_recipient_records_the_same_availability_fact"
        );
    }

    // A second connection repairs the runtime and holds the write lock past the moment the pass
    // asks for it. Only a read taken after the lock can see the recovery; a read taken before it
    // would see the stale `path_missing` and write a failure that is already untrue.
    let (locked, waiting) = std::sync::mpsc::channel();
    let database_path = database.path().to_path_buf();
    let repaired_installation = installation_id.clone();
    let holder = std::thread::spawn(move || {
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        connection
            .execute(
                "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
                [&repaired_installation],
            )
            .unwrap();
        locked.send(()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(700));
        connection.execute_batch("COMMIT").unwrap();
    });
    waiting.recv().unwrap();

    let admitted = control::admit_due_dispatches(&mut database).unwrap();
    holder.join().unwrap();

    assert_eq!(
        admitted, 2,
        "assertion a_pass_that_waited_for_the_lock_dispatches_every_recipient_that_came_back"
    );
    for task_id in ["task_a", "task_second"] {
        assert_eq!(
            task_blocked_reason(&database, &plan_id, task_id),
            None,
            "assertion the_recovered_recipient_carries_no_stale_failure_record"
        );
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion a_tick_after_the_recovery_never_dispatches_the_same_event_again"
        );
    }
    let keys: Vec<String> = {
        let mut statement = database
            .connection()
            .prepare("SELECT dedupe_key FROM loom_control_dispatch ORDER BY dedupe_key")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let mut expected = vec![
        execute_event_key(&plan_id, "task_a"),
        execute_event_key(&plan_id, "task_second"),
    ];
    expected.sort();
    assert_eq!(
        keys, expected,
        "assertion each_recovered_recipient_owns_exactly_one_event_identity"
    );
    assert_eq!(
        (count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"), loom_deliveries(&database)),
        (2, 2),
        "assertion concurrent_recovery_creates_no_duplicate_delivery"
    );
}
