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
use crate::agent_profile::AdapterKind;
use crate::collaboration::ProjectBindingKind;
use crate::command::{ActorRef, CommandEnvelope};
use crate::db::{Database, TestDatabaseOpenMode};
use crate::mission::{CreateMissionCommand, MissionService};
use crate::test_support::OwnedTestDatabase;
use rusqlite::{OptionalExtension, params};

const OWNER: &str = "local_user";
const PRODUCER_AGENT: &str = "agent_1";
const REVIEWER_AGENT: &str = "agent_2";
const PRODUCER_RUN: &str = "run_producer";
const REVIEWER_RUN: &str = "run_reviewer";
/// A reviewer who never took part in the delivery or its session: the independent observer a stage
/// verdict is actually meant to come from.
const INDEPENDENT_REVIEWER_AGENT: &str = "agent_4";
const INDEPENDENT_REVIEWER_RUN: &str = "run_independent_reviewer";
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
        .query_row(
            "SELECT camp_id FROM mission WHERE id=?1",
            [mission_id],
            |row| row.get(0),
        )
        .unwrap()
}

/// A real, live AgentRun for one member of the Mission's Camp, built from the same minimal
/// column set the existing agent-run fixtures use. The reviewer's trusted identity is only
/// credible because this row exists: `stage_review_record` resolves the agent through it and
/// refuses a run that is not `running` and not cancelled.
fn seed_run(database: &OwnedTestDatabase, camp_id: &str, agent_id: &str, run_id: &str) {
    // The real schema keeps exactly one conversation per (Camp, Agent), so a second Run of the same
    // Agent executes in the session that Agent already has. A fixture that minted a private
    // conversation per Run would hide the session-sharing rules the product actually enforces.
    let existing: Option<String> = database
        .connection()
        .query_row(
            "SELECT id FROM conversation WHERE camp_id=?1 AND agent_id=?2",
            params![camp_id, agent_id],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    let conversation_id = match existing {
        Some(conversation_id) => conversation_id,
        None => {
            let conversation_id = format!("conversation_{run_id}");
            database
                .connection()
                .execute(
                    "INSERT INTO conversation(id,camp_id,agent_id,created_at,updated_at)
                     VALUES(?1,?2,?3,'2026-08-31','2026-08-31')",
                    params![&conversation_id, camp_id, agent_id],
                )
                .unwrap();
            conversation_id
        }
    };
    let turn_id = format!("turn_{run_id}");
    database
        .connection()
        .execute(
            "INSERT INTO camp_turn(id,camp_id,trigger_type,trigger_id,status,created_at,updated_at)
             VALUES(?1,?2,'system_event',?3,'running','2026-08-31','2026-08-31')",
            params![&turn_id, camp_id, run_id],
        )
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

/// The conversation one seeded Run executes in, read the way the product reads it.
fn conversation_of(database: &OwnedTestDatabase, run_id: &str) -> String {
    database
        .connection()
        .query_row(
            "SELECT conversation_id FROM agent_run WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .unwrap()
}

/// The Native Session one seeded Run executes in, with the installation that owns it: the pair the
/// schema keeps unique and the product uses as the session identity. `installation_id` is optional
/// because a conversation can carry a Native Session before its owner is known.
fn set_native_session(
    database: &OwnedTestDatabase,
    run_id: &str,
    installation_id: Option<&str>,
    native_session_id: &str,
) {
    // The conversation's installation is a real reference, so the installation has to exist — the
    // same row a discovered Runtime installation would leave behind. A custom installation is
    // unique by (kind, executable path, auth scope), so each seeded installation gets its own path.
    if let Some(installation_id) = installation_id {
        let executable_path = format!("/opt/qoder/{installation_id}");
        database
            .connection()
            .execute(
                "INSERT OR IGNORE INTO adapter_installation(
                     id,adapter_kind,executable_path,command_name,installation_class,source,
                     auth_scope,enabled,generation,path_state,version,created_at,updated_at)
                 VALUES(?1,'qoder-cli',?2,'qoder','custom','manual','user',1,1,
                        'valid',1,'2026-08-31','2026-08-31')",
                params![installation_id, executable_path],
            )
            .unwrap();
    }
    let updated = database
        .connection()
        .execute(
            "UPDATE conversation SET native_adapter_installation_id=?1, native_session_id=?2
             WHERE id = (SELECT conversation_id FROM agent_run WHERE id=?3)",
            params![installation_id, native_session_id, run_id],
        )
        .unwrap();
    assert_eq!(
        updated, 1,
        "assertion the_fixture_bound_the_native_session_this_case_is_about"
    );
}

/// A delivered Run that has already finished: the schema keeps one *active* Run per session, so a
/// history Run is a finished one, exactly as the product leaves it after its Candidate is recorded.
fn finish_run(database: &OwnedTestDatabase, run_id: &str) {
    database
        .connection()
        .execute(
            "UPDATE agent_run SET status='succeeded', ended_at='2026-08-31' WHERE id=?1",
            [run_id],
        )
        .unwrap();
}

/// The open claim one Run already holds on a Task, as the delivery lane wrote it when it admitted
/// that Run to execution. A test that continues a real dispatched delivery reads the claim it
/// already owns instead of asking for a second one.
fn open_claim_of(
    database: &OwnedTestDatabase,
    plan_id: &str,
    task_id: &str,
    run_id: &str,
) -> (String, i64) {
    database
        .connection()
        .query_row(
            "SELECT claim_id, fence_generation FROM loom_claim
             WHERE plan_id=?1 AND task_id=?2 AND agent_run_id=?3 AND released_at IS NULL",
            params![plan_id, task_id, run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

/// A continuation edge between two Runs: `successor` continues `predecessor`'s thread.
fn set_predecessor(database: &OwnedTestDatabase, successor: &str, predecessor: Option<&str>) {
    database
        .connection()
        .execute(
            "UPDATE agent_run SET predecessor_agent_run_id=?1,
                    start_reason=CASE WHEN ?1 IS NULL THEN 'initial' ELSE 'rework' END
             WHERE id=?2",
            params![predecessor, successor],
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
    let manifest =
        control::candidate_manifest_hash(database.connection(), &candidate.candidate_id).unwrap();
    (candidate.candidate_id, manifest)
}

/// The Run the platform bound this Candidate's review to, read from the dispatch ledger: the Run that
/// claimed the REVIEW Delivery of this exact Candidate.
fn review_run_of(database: &OwnedTestDatabase, candidate_id: &str) -> Option<String> {
    database
        .connection()
        .query_row(
            "SELECT delivery.claimed_agent_run_id
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             WHERE dispatch.kind='REVIEW' AND dispatch.candidate_id=?1
             ORDER BY dispatch.created_at DESC, dispatch.dispatch_id DESC
             LIMIT 1",
            [candidate_id],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
        .flatten()
}

/// Hand the review of the latest Candidate to its assigned reviewer through the real scheduler and
/// claim it through the real delivery lane. The Run this returns is the one the ledger names, so it
/// is the only observer a stage verdict may come from: an assignment is a role, not a request.

fn dispatched_review_run(
    database: &mut OwnedTestDatabase,
    camp_id: &str,
    candidate_id: &str,
) -> String {
    assert_eq!(
        control::admit_due_dispatches(database).unwrap(),
        1,
        "assertion the_delivered_candidate_is_handed_to_its_reviewer"
    );
    let mut runs = claim_mission_lane(database, camp_id, 1);
    assert_eq!(
        runs.len(),
        1,
        "assertion the_review_delivery_materialises_exactly_one_run"
    );
    let run_id = runs.pop().unwrap();
    claim_the_run(database, camp_id, &run_id);
    assert_eq!(
        review_run_of(database, candidate_id).as_deref(),
        Some(run_id.as_str()),
        "assertion the_ledger_bound_the_review_to_the_run_that_claimed_it"
    );
    run_id
}

/// The Agent that executes one Run, read the way the product reads it.
fn run_agent(database: &OwnedTestDatabase, run_id: &str) -> String {
    database
        .connection()
        .query_row(
            "SELECT conversation.agent_id FROM agent_run
             JOIN conversation ON conversation.id = agent_run.conversation_id
             WHERE agent_run.id=?1",
            [run_id],
            |row| row.get(0),
        )
        .unwrap()
}

/// The seeded fixture configures a Runtime for the producer, the reviewer and the second executor
/// only; the independent observer needs one too before the platform can hand it a Delivery at all.
fn configure_observer_runtime(database: &OwnedTestDatabase) {
    crate::agent_profile::configure_test_runtime(database, &[INDEPENDENT_REVIEWER_AGENT]);
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

fn count(database: &Database, sql: &str) -> i64 {
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
        (
            policy.revision,
            policy.authorization_revision,
            policy.approved_by.as_str()
        ),
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
        (
            policy.revision,
            policy.authorization_revision,
            policy.paused
        ),
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
        (
            policy.revision,
            policy.authorization_revision,
            policy.paused
        ),
        (3, 1, false),
        "assertion resuming_reuses_the_standing_authorization"
    );

    // Resume spent the same grant, so the platform hands the review out again and the verdict
    // written against authorization 1 still lands — from the Run the Delivery asked.
    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
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
        &reviewer_run,
        "command_stage_stale_authorization",
        stage_input(
            &candidate_id,
            1,
            &manifest,
            LoomStageVerdict::RequestChanges,
        ),
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

/// Self-review boundary with a real, resolvable producer: the Run that delivered the Candidate
/// cannot judge it, and a later live Run of the same Agent cannot judge it either — that is the
/// same author behind another identity. Both refusals happen before any shared-session reasoning,
/// so the code names the actual violation, and neither writes a verdict. An independent reviewer
/// under a new grant still passes, so the fence is not a blanket refusal.
#[test]
fn stage_review_refuses_the_producer_and_a_later_run_of_its_agent() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control self review");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    // The producer is also the assigned reviewer here, so nothing but the self-review rule stands
    // between it and its own delivery.
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_self_review", PRODUCER_AGENT),
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);

    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        PRODUCER_AGENT,
        PRODUCER_RUN,
        "command_stage_producer_itself",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVIEWER_SELF",
        "assertion the_run_that_produced_the_candidate_cannot_review_it"
    );

    // The producing Run ends and its Agent starts another Run in the same session: still the same
    // author, still not an observer.
    finish_run(&database, PRODUCER_RUN);
    seed_run(&database, &camp_id, PRODUCER_AGENT, "run_producer_later");
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        PRODUCER_AGENT,
        "run_producer_later",
        "command_stage_producer_later_run",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVIEWER_SELF",
        "assertion a_later_run_of_the_producing_agent_cannot_review_its_own_delivery"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        0,
        "assertion neither_self_review_attempt_writes_a_verdict"
    );

    // A different Agent, under a fresh grant, is a real observer: the platform hands that Agent the
    // review and the Run that claimed it passes.
    let mut independent =
        policy_input(&mission_id, "command_approve_real_observer", REVIEWER_AGENT);
    independent.expected_revision = 1;
    control::configure(&mut database, OWNER, independent).unwrap();
    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
        "command_stage_real_observer",
        stage_input(&candidate_id, 2, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        (
            recorded.review.reviewer_agent_run_id.as_str(),
            recorded.task_status,
            acceptance_status(&database, &candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        (
            reviewer_run.as_str(),
            super::LoomTaskStatus::InReview,
            "PENDING".to_string(),
            0,
        ),
        "assertion an_independent_pass_is_accepted_and_the_owner_still_decides"
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
    // The platform asks for the review; every refusal below has to come from the observer that was
    // actually asked, so each case is answered by the Run that claimed the review Delivery.
    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);

    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
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
        &reviewer_run,
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
        &reviewer_run,
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
        &reviewer_run,
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
                &reviewer_run,
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
                &reviewer_run,
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
                &reviewer_run,
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
    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);

    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
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
        &reviewer_run,
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
        &reviewer_run,
        "command_stage_pass",
        stage_input(
            &candidate_id,
            1,
            &manifest,
            LoomStageVerdict::RequestChanges,
        ),
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

    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &first_candidate_id);
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
        &reviewer_run,
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

    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    let mut blocked = stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Blocked);
    blocked.reason = "the delivery needs a decision nobody has made".into();
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
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

/// Independence boundary, ported from Mikka `lib/factory/check-independence.ts`: the Run that
/// judges a delivery has to be an observer outside the session that produced it. A review Run that
/// continues the producing Run — or that the producing Run continues — is one working thread
/// judging itself through a second identity, so it is refused; an observer in its own session is
/// accepted and binds the Candidate, the producer, the stage and the authorization it judged.
#[test]
fn stage_review_needs_an_observer_outside_the_production_session() {
    let mut database = fixture();
    configure_observer_runtime(&database);
    let mission_id = create_mission_with_members(
        &mut database,
        "control independent review",
        &[PRODUCER_AGENT, REVIEWER_AGENT, INDEPENDENT_REVIEWER_AGENT],
    );
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    seed_run(
        &database,
        &camp_id,
        INDEPENDENT_REVIEWER_AGENT,
        INDEPENDENT_REVIEWER_RUN,
    );
    control::configure(
        &mut database,
        OWNER,
        policy_input(&mission_id, "command_approve_observer", REVIEWER_AGENT),
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);
    // The independent observer really is a different Agent in a different session.
    assert_ne!(
        conversation_of(&database, PRODUCER_RUN),
        conversation_of(&database, INDEPENDENT_REVIEWER_RUN),
        "assertion the_fixture_keeps_the_independent_observer_in_its_own_session"
    );
    // The reviewing Run continues the producing Run: the verdict would come from the producing
    // thread under another agent identity. A shared session disqualifies the observer on its own, so
    // this is refused before any request for a verdict — and the refusal must not touch the ledger.
    set_predecessor(&database, REVIEWER_RUN, Some(PRODUCER_RUN));
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_reviewer_continues_producer",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEWER_SESSION_SHARED",
        "assertion a_reviewer_run_that_continues_the_producer_cannot_judge_its_own_thread"
    );
    set_predecessor(&database, REVIEWER_RUN, None);

    // The producing Run continues the reviewing Run: the reviewer stands inside the producer's
    // ancestry, so the delivery was built on the reviewer's own earlier thread.
    set_predecessor(&database, PRODUCER_RUN, Some(REVIEWER_RUN));
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_producer_continues_reviewer",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEWER_SESSION_SHARED",
        "assertion a_reviewer_run_inside_the_producers_ancestry_cannot_judge_it"
    );
    set_predecessor(&database, PRODUCER_RUN, None);
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
        ),
        (0, 0),
        "assertion a_shared_session_refusal_writes_neither_a_verdict_nor_a_request"
    );

    // A new approval names the independent observer: the platform hands that Agent the review, and
    // the Run that claimed it lands the verdict under the new grant.
    let mut independent = policy_input(
        &mission_id,
        "command_approve_independent_observer",
        INDEPENDENT_REVIEWER_AGENT,
    );
    independent.expected_revision = 1;
    let approved = control::configure(&mut database, OWNER, independent).unwrap();
    assert_eq!(
        approved
            .policy
            .as_ref()
            .map(|policy| policy.authorization_revision),
        Some(2),
        "assertion the_new_approval_is_the_authorization_the_observer_reviews_under"
    );
    finish_run(&database, INDEPENDENT_REVIEWER_RUN);
    let independent_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    assert_eq!(
        run_agent(&database, &independent_run),
        INDEPENDENT_REVIEWER_AGENT,
        "assertion the_new_grant_asked_the_independent_observer"
    );
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &independent_run,
        "command_stage_independent_pass",
        stage_input(&candidate_id, 2, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        (
            recorded.review.candidate_id.as_str(),
            recorded.review.reviewer_agent_run_id.as_str(),
            recorded.review.policy_revision,
            recorded.review.manifest_hash.as_str(),
            recorded.task_status,
        ),
        (
            candidate_id.as_str(),
            independent_run.as_str(),
            2,
            manifest.as_str(),
            super::LoomTaskStatus::InReview,
        ),
        "assertion an_independent_verdict_binds_the_candidate_run_stage_and_authorization"
    );
    assert_eq!(
        (
            acceptance_status(&database, &candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        ("PENDING".to_string(), 0),
        "assertion even_an_independent_pass_is_not_the_owners_acceptance"
    );
}

/// Session-history boundary: a reviewer cannot judge a Task whose earlier version was produced in
/// the very session they still work in — a review that would ratify its own earlier delivery under
/// a second identity. The same test proves the other direction of the same fence: the stale
/// Candidate is refused, a second verdict on one Candidate under one grant is refused, and none of
/// those refusals — nor an explicit `blocked` — erases the work that was delivered.
#[test]
fn stage_review_history_and_rejections_keep_the_delivered_work() {
    let mut database = fixture();
    configure_observer_runtime(&database);
    let mission_id = create_mission_with_members(
        &mut database,
        "control independent review history",
        &[PRODUCER_AGENT, REVIEWER_AGENT, INDEPENDENT_REVIEWER_AGENT],
    );
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    // The reviewer's Agent already delivered the first version of this Task in its own session,
    // and that Run is finished: one session keeps one active Run.
    seed_run(&database, &camp_id, REVIEWER_AGENT, "run_reviewer_delivery");
    finish_run(&database, "run_reviewer_delivery");
    // The first version is reviewed by the other agent, so the Task reaches a second delivery.
    control::configure(
        &mut database,
        OWNER,
        policy_input(
            &mission_id,
            "command_approve_first_observer",
            PRODUCER_AGENT,
        ),
    )
    .unwrap();
    task_release(
        &mut database,
        LoomTaskReleaseInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
        },
    )
    .unwrap();
    let first_claim = claim_acquire(
        &mut database,
        LoomClaimAcquireInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: "run_reviewer_delivery".into(),
            claimant_agent_id: Some(REVIEWER_AGENT.into()),
            command_id: "command_claim_first_version".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    let first_candidate = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: "run_reviewer_delivery".into(),
            claim_id: first_claim.claim_id,
            fence_generation: first_claim.fence_generation,
            command_id: "command_candidate_first_version".into(),
            content_hash: "sha256:first-version".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    let first_candidate_id = first_candidate.candidate_id;
    let first_manifest =
        control::candidate_manifest_hash(database.connection(), &first_candidate_id).unwrap();
    let mut request_changes = stage_input(
        &first_candidate_id,
        1,
        &first_manifest,
        LoomStageVerdict::RequestChanges,
    );
    request_changes.reason = "the first version needs a rewrite".into();
    request_changes.criteria_results[1].satisfied = false;
    // The platform asks the other agent for the verdict, and the Run that claimed that review is the
    // one that writes it.
    let first_review_run = dispatched_review_run(&mut database, &camp_id, &first_candidate_id);
    assert_eq!(
        run_agent(&database, &first_review_run),
        PRODUCER_AGENT,
        "assertion the_first_grant_asked_the_other_agent"
    );
    control::stage_review_record(
        &mut database,
        &mission_id,
        PRODUCER_AGENT,
        &first_review_run,
        "command_stage_first_version_changes",
        request_changes,
    )
    .unwrap();
    finish_run(&database, &first_review_run);

    // A new approval hands the rework to the other agent, so the second version comes from a
    // different session while the reviewer stays the agent that built the first one.
    let mut second_policy = policy_input(
        &mission_id,
        "command_approve_rework_observer",
        REVIEWER_AGENT,
    );
    second_policy.expected_revision = 1;
    control::configure(&mut database, OWNER, second_policy).unwrap();
    // The rework is delivered by the producer's own Run, which starts after the first review Run
    // ended: one session keeps one active Run.
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    // The reviewer's own Agent is live again in the session that already delivered the first version.
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    let second_claim = claim_acquire(
        &mut database,
        LoomClaimAcquireInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: PRODUCER_RUN.into(),
            claimant_agent_id: Some(PRODUCER_AGENT.into()),
            command_id: "command_claim_second_version".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    let second_candidate = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: PRODUCER_RUN.into(),
            claim_id: second_claim.claim_id,
            fence_generation: second_claim.fence_generation,
            command_id: "command_candidate_second_version".into(),
            content_hash: "sha256:second-version".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: Some(first_candidate_id.clone()),
        },
    )
    .unwrap();
    let second_candidate_id = second_candidate.candidate_id;
    let second_manifest =
        control::candidate_manifest_hash(database.connection(), &second_candidate_id).unwrap();

    // The reviewer's own session built the first version of this Task, so it cannot judge the second
    // one either — not even as the assigned reviewer of this grant. The shared session is refused
    // before any request, so nothing is written to the dispatch ledger and the later grant can still
    // ask a clean observer.
    assert_eq!(
        conversation_of(&database, REVIEWER_RUN),
        conversation_of(&database, "run_reviewer_delivery"),
        "assertion both_reviewer_runs_work_in_the_one_session_their_agent_owns"
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_shared_session_history",
        stage_input(
            &second_candidate_id,
            2,
            &second_manifest,
            LoomStageVerdict::Pass,
        ),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEWER_SESSION_SHARED",
        "assertion a_reviewer_whose_session_delivered_an_earlier_version_cannot_judge_this_task"
    );

    // The superseded first version is old news: only the latest Candidate may be judged.
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_stale_candidate",
        stage_input(
            &first_candidate_id,
            2,
            &first_manifest,
            LoomStageVerdict::Pass,
        ),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_CANDIDATE_STALE",
        "assertion a_superseded_candidate_cannot_be_stage_reviewed"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        1,
        "assertion neither_refusal_writes_a_second_verdict"
    );

    // An independent observer answers the standing grant, once.
    let mut independent = policy_input(
        &mission_id,
        "command_approve_independent_observer",
        INDEPENDENT_REVIEWER_AGENT,
    );
    independent.expected_revision = 2;
    let approved = control::configure(&mut database, OWNER, independent).unwrap();
    assert_eq!(
        approved
            .policy
            .as_ref()
            .map(|policy| policy.authorization_revision),
        Some(3),
        "assertion the_independent_observer_reviews_under_the_third_authorization"
    );
    finish_run(&database, REVIEWER_RUN);
    let independent_run = dispatched_review_run(&mut database, &camp_id, &second_candidate_id);
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &independent_run,
        "command_stage_independent_pass",
        stage_input(
            &second_candidate_id,
            3,
            &second_manifest,
            LoomStageVerdict::Pass,
        ),
    )
    .unwrap();
    assert_eq!(
        recorded.task_status,
        super::LoomTaskStatus::InReview,
        "assertion an_independent_pass_keeps_the_task_in_review_for_the_owner"
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &independent_run,
        "command_stage_second_verdict",
        stage_input(
            &second_candidate_id,
            3,
            &second_manifest,
            LoomStageVerdict::RequestChanges,
        ),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_EXISTS",
        "assertion one_candidate_carries_one_stage_verdict_per_grant"
    );

    // A final `blocked` under a fresh grant stops the Task without touching what was delivered.
    let mut stopped = policy_input(
        &mission_id,
        "command_approve_stopping_observer",
        INDEPENDENT_REVIEWER_AGENT,
    );
    stopped.expected_revision = 3;
    control::configure(&mut database, OWNER, stopped).unwrap();
    let mut blocked = stage_input(
        &second_candidate_id,
        4,
        &second_manifest,
        LoomStageVerdict::Blocked,
    );
    blocked.reason = "the owner has to decide what to do next".into();
    finish_run(&database, &independent_run);
    let blocked_run = dispatched_review_run(&mut database, &camp_id, &second_candidate_id);
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &blocked_run,
        "command_stage_blocked_after_pass",
        blocked,
    )
    .unwrap();
    assert_eq!(
        recorded.task_status,
        super::LoomTaskStatus::Blocked,
        "assertion the_fresh_grant_parks_the_task"
    );

    // Everything that was delivered is still there: both versions, their chain, their content, and
    // the refusal that asked for the rework. A rejection is a stage verdict, not an erasure.
    let stored: Vec<(String, String, String, Option<String>)> = {
        let mut statement = database
            .connection()
            .prepare(
                "SELECT candidate_id, content_hash, acceptance_status, previous_candidate_id
                 FROM loom_candidate ORDER BY created_at, rowid",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert_eq!(
        stored,
        vec![
            (
                first_candidate_id.clone(),
                "sha256:first-version".to_string(),
                "PENDING".to_string(),
                None
            ),
            (
                second_candidate_id.clone(),
                "sha256:second-version".to_string(),
                "PENDING".to_string(),
                Some(first_candidate_id.clone())
            ),
        ],
        "assertion no_rejection_erases_a_delivered_candidate_its_content_or_its_chain"
    );
    let verdicts: Vec<(String, String)> = {
        let mut statement = database
            .connection()
            .prepare(
                "SELECT candidate_id, verdict FROM loom_stage_review ORDER BY reviewed_at, rowid",
            )
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert_eq!(
        verdicts,
        vec![
            (first_candidate_id.clone(), "REQUEST_CHANGES".to_string()),
            (second_candidate_id.clone(), "PASS".to_string()),
            (second_candidate_id.clone(), "BLOCKED".to_string()),
        ],
        "assertion every_stage_verdict_is_kept_alongside_the_work_it_judged"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_claim"),
            count(
                &database,
                "SELECT COUNT(*) FROM loom_claim WHERE released_at IS NULL"
            ),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        (2, 0, 0),
        "assertion claims_are_released_never_deleted_and_no_rejection_forges_the_owners_review"
    );
}

/// Source boundary, aligned with Mikka's `assertFrozenDispatch`: when the platform dispatched the
/// review of a Candidate, the Delivery's claimed Run is the only observer the authorization asked.
/// An unclaimed Delivery asked nobody, and a different live Run of the same assigned agent is not
/// that observer — while the dispatched Run answers with the verdict bound to its own identity.
#[test]
fn stage_review_answers_only_the_run_its_review_was_dispatched_to() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "control review source",
        "command_approve_review_source",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    // A second live Run of the assigned reviewer: live, of the right agent, and still not the Run
    // the review was handed to.
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);

    // The producer delivers through the real dispatch/claim path.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_approved_execution_is_reserved"
    );
    let producer_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the reserved delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &producer_run);
    // The delivery lane already claimed the Task for this very Run, so the delivery continues on
    // that claim instead of asking for a second one.
    let (claim_id, fence_generation) = open_claim_of(&database, &plan_id, "task_a", &producer_run);
    let candidate = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.clone(),
            claim_id,
            fence_generation,
            command_id: "command_candidate_source".into(),
            content_hash: "sha256:dispatched-review".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    let candidate_id = candidate.candidate_id;
    let manifest = control::candidate_manifest_hash(database.connection(), &candidate_id).unwrap();

    // The platform now dispatches the review itself, while the reviewer Agent is still busy with an
    // unrelated Run of its own: the review Delivery waits, and that unrelated Run is not the
    // observer the authorization asked.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_delivered_task_is_handed_to_its_reviewer"
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        REVIEWER_RUN,
        "command_stage_unclaimed_review",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_SOURCE_UNBOUND",
        "assertion a_review_delivery_nobody_claimed_cannot_be_answered"
    );

    // That unrelated Run ends, the review Delivery materialises its own Run, and that Run answers.
    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the review delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &reviewer_run);
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
        "command_stage_dispatched_review",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        (
            recorded.review.reviewer_agent_run_id.as_str(),
            recorded.review.task_id.as_str(),
            recorded.review.candidate_id.as_str(),
            recorded.review.verdict,
        ),
        (
            reviewer_run.as_str(),
            "task_a",
            candidate_id.as_str(),
            LoomStageVerdict::Pass,
        ),
        "assertion the_dispatched_run_answers_and_the_verdict_names_it"
    );
    assert_eq!(
        (
            task_state(&database, &mission_id, "task_a"),
            acceptance_status(&database, &candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        ("IN_REVIEW".to_string(), "PENDING".to_string(), 0),
        "assertion a_dispatched_pass_still_waits_for_the_owners_acceptance"
    );

    // The dispatched reviewer finishes after writing its verdict, as a real review Run does.
    finish_run(&database, &reviewer_run);

    // A later Run of the same Agent cannot stand in for the Run the dispatch named either: the new
    // grant dispatches the review again, that Delivery's Run ends without a verdict, and the Run
    // that starts in the same session afterwards is not the observer that was asked.
    let mut reapproved = policy_input(
        &mission_id,
        "command_approve_second_review_grant",
        REVIEWER_AGENT,
    );
    reapproved.expected_revision = 1;
    control::configure(&mut database, OWNER, reapproved).unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_new_grant_dispatches_the_review_again"
    );
    let replaced_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the second review delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &replaced_run);
    finish_run(&database, &replaced_run);
    seed_run(
        &database,
        &camp_id,
        REVIEWER_AGENT,
        "run_reviewer_replacement",
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        "run_reviewer_replacement",
        "command_stage_replacement_reviewer",
        stage_input(
            &candidate_id,
            2,
            &manifest,
            LoomStageVerdict::RequestChanges,
        ),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_SOURCE_UNBOUND",
        "assertion a_later_run_of_the_same_agent_cannot_replace_the_dispatched_observer"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        1,
        "assertion no_replacement_observer_writes_a_verdict"
    );
}

/// Source boundary, the strict direction: a reviewer assignment is a role, not a request. The Run of
/// the assigned reviewer that is busy with another Task of the same Plan, and a live Run nobody asked
/// for anything at all, both leave the Candidate unjudged: the Host queues every independent stage, so
/// a missing ledger row is nobody's request and is not a human/Lead request either. Only the Run that
/// claimed the platform's REVIEW Delivery may answer, and its pass still waits for the Owner.
#[test]
fn stage_review_answers_no_assignment_and_no_absent_request() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "control review request");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let plan_id: String = database
        .connection()
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| row.get(0),
        )
        .unwrap();
    let camp_id = camp_of(&database, &mission_id);
    // A Task of this Plan that the assigned reviewer is really executing. It is outside the Owner's
    // automation scope, which is exactly why the scheduler never hands it out: the reviewer earned
    // this claim as an executor, not as a reviewer.
    database
        .connection()
        .execute(
            "INSERT INTO loom_task(task_id,plan_id,title,description,assignee_agent_id,status,
                                   acceptance_criteria_json,created_at,updated_at,revision)
             SELECT 'task_c',plan_id,'Task C','A task the reviewer executes',?1,'READY',
                    acceptance_criteria_json,created_at,updated_at,revision
             FROM loom_task WHERE plan_id=?2 AND task_id='task_a'",
            params![REVIEWER_AGENT, &plan_id],
        )
        .unwrap();
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, "run_busy_reviewer");
    control::configure(
        &mut database,
        OWNER,
        policy_input(
            &mission_id,
            "command_approve_review_request",
            REVIEWER_AGENT,
        ),
    )
    .unwrap();
    claim_acquire(
        &mut database,
        LoomClaimAcquireInput {
            mission_id: mission_id.clone(),
            task_id: "task_c".into(),
            agent_run_id: "run_busy_reviewer".into(),
            claimant_agent_id: Some(REVIEWER_AGENT.into()),
            command_id: "command_claim_other_task".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);

    // The reviewer's Run is executing another Task of this Plan. Nobody asked it to review this
    // Candidate, so the verdict it would like to write is not an observation the Owner's grant
    // appointed — the assignment is not a request.
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        "run_busy_reviewer",
        "command_stage_busy_reviewer",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_SOURCE_UNBOUND",
        "assertion a_run_executing_another_task_was_never_asked_to_review"
    );

    // A live Run nobody asked for anything is refused the same way: there is no request to answer.
    finish_run(&database, "run_busy_reviewer");
    seed_run(&database, &camp_id, REVIEWER_AGENT, "run_unasked_reviewer");
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        "run_unasked_reviewer",
        "command_stage_unasked_reviewer",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_SOURCE_UNBOUND",
        "assertion a_live_run_nobody_asked_cannot_volunteer_a_verdict"
    );
    assert_eq!(
        (
            task_state(&database, &mission_id, "task_a"),
            acceptance_status(&database, &candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        ("IN_REVIEW".to_string(), "PENDING".to_string(), 0, 0),
        "assertion neither_unrequested_verdict_writes_a_stage_or_an_owner_decision"
    );

    // The platform's own request is the only source: its Delivery goes to the assigned reviewer, the
    // Run that claimed it writes the verdict, and the Owner still decides.
    finish_run(&database, "run_unasked_reviewer");
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
        "command_stage_requested_review",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        (
            recorded.review.reviewer_agent_run_id.as_str(),
            recorded.review.policy_revision,
            recorded.task_status,
            acceptance_status(&database, &candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        (
            reviewer_run.as_str(),
            1,
            super::LoomTaskStatus::InReview,
            "PENDING".to_string(),
            0,
        ),
        "assertion the_dispatched_review_is_the_only_source_and_the_owner_still_decides"
    );
}

/// Grant boundary: the source binding is the *standing* authorization's dispatch, not merely the
/// revision number a caller quotes. A Run the platform asked under revision 1 cannot answer under a
/// revision 2 the Owner approved later, even before revision 2 has dispatched anything: the old
/// grant is gone, and re-labeling the old Run does not make the new grant ask it.
#[test]
fn stage_review_of_a_reapproved_grant_needs_its_own_review_dispatch() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "control review grant",
        "command_approve_review_grant",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_approved_execution_is_reserved"
    );
    let producer_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the reserved delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &producer_run);
    let (claim_id, fence_generation) = open_claim_of(&database, &plan_id, "task_a", &producer_run);
    let candidate = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.clone(),
            claim_id,
            fence_generation,
            command_id: "command_candidate_review_grant".into(),
            content_hash: "sha256:reapproved-grant".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    let candidate_id = candidate.candidate_id;
    let manifest = control::candidate_manifest_hash(database.connection(), &candidate_id).unwrap();

    // Revision 1 dispatches the review, and its Run claims the Delivery.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_first_grant_dispatches_the_review"
    );
    let review_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the review delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &review_run);

    // The Owner replaces the grant while that Run is still working. Nothing has been dispatched
    // under revision 2 yet, so the old Run quoting revision 2 is exactly the laundering case.
    let mut reapproved = policy_input(
        &mission_id,
        "command_approve_review_grant_again",
        REVIEWER_AGENT,
    );
    reapproved.expected_revision = 1;
    let approved = control::configure(&mut database, OWNER, reapproved).unwrap();
    assert_eq!(
        approved
            .policy
            .as_ref()
            .map(|policy| policy.authorization_revision),
        Some(2),
        "assertion the_reapproval_is_the_standing_grant"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
        2,
        "assertion the_new_grant_has_dispatched_no_review_yet"
    );

    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &review_run,
        "command_stage_old_dispatch_new_grant",
        stage_input(&candidate_id, 2, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_SOURCE_UNBOUND",
        "assertion a_run_the_replaced_grant_asked_cannot_answer_the_new_grant"
    );
    // The old revision is just as stale in the other direction: it is no longer the grant.
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &review_run,
        "command_stage_old_dispatch_old_grant",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVISION_CONFLICT",
        "assertion the_replaced_grant_cannot_be_quoted_back_either"
    );
    let ledger: Vec<(String, i64, Option<String>)> = {
        let mut statement = database
            .connection()
            .prepare(
                "SELECT dispatch.kind, dispatch.policy_revision, delivery.claimed_agent_run_id
                 FROM loom_control_dispatch dispatch
                 LEFT JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
                 WHERE dispatch.task_id='task_a'
                 ORDER BY dispatch.created_at, dispatch.dispatch_id",
            )
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert_eq!(
        ledger,
        vec![
            ("EXECUTE".to_string(), 1, Some(producer_run.clone())),
            ("REVIEW".to_string(), 1, Some(review_run.clone())),
        ],
        "assertion the_only_dispatched_review_belongs_to_the_replaced_grant"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        0,
        "assertion the_laundered_grant_writes_no_verdict"
    );
}

/// Convergence boundary: a review the platform already asked for and nobody answered must never be a
/// dead end. When the Owner replaces the grant while that request is still unanswered, the request becomes
/// unanswerable — a verdict has to be written under the standing revision, and the request's own
/// binding names the replaced one — so the standing grant has to be able to ask somebody else. The
/// dead request is neither erased nor counted as a verdict: the Candidate keeps its history, stays
/// `PENDING`, and no Owner review is written by the new verdict.
#[test]
fn stage_review_a_replaced_grant_can_ask_again_after_its_request_went_unanswered() {
    let mut database = fixture();
    configure_observer_runtime(&database);
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "control review superseded request",
        "command_approve_review_superseded",
        &[PRODUCER_AGENT, REVIEWER_AGENT, INDEPENDENT_REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);

    // The producer delivers through the real dispatch/claim path, then the platform asks the
    // assigned reviewer and that Delivery materialises a Run.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_approved_execution_is_reserved"
    );
    let producer_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the reserved delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &producer_run);
    let (claim_id, fence_generation) = open_claim_of(&database, &plan_id, "task_a", &producer_run);
    let candidate = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.clone(),
            claim_id,
            fence_generation,
            command_id: "command_candidate_superseded_request".into(),
            content_hash: "sha256:superseded-request".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    let candidate_id = candidate.candidate_id;
    let manifest = control::candidate_manifest_hash(database.connection(), &candidate_id).unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_delivered_task_is_handed_to_its_reviewer"
    );
    let unanswered_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the review delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &unanswered_run);
    assert_eq!(
        review_run_of(&database, &candidate_id).as_deref(),
        Some(unanswered_run.as_str()),
        "assertion the_first_grant_asked_the_run_that_claimed_its_review"
    );

    // The Owner replaces the grant while the request is still unanswered: a new reviewer is named.
    let mut reapproved = policy_input(
        &mission_id,
        "command_approve_review_superseded_again",
        INDEPENDENT_REVIEWER_AGENT,
    );
    reapproved.expected_revision = 1;
    let approved = control::configure(&mut database, OWNER, reapproved).unwrap();
    assert_eq!(
        approved
            .policy
            .as_ref()
            .map(|policy| policy.authorization_revision),
        Some(2),
        "assertion the_reapproval_is_the_standing_grant"
    );

    // The replaced grant's Run is no longer the approved reviewer, so it cannot answer under the
    // standing grant — and the refusal writes no verdict.
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &unanswered_run,
        "command_stage_unanswered_request_new_grant",
        stage_input(&candidate_id, 2, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVIEWER_INVALID",
        "assertion a_run_asked_by_the_replaced_grant_cannot_answer_the_standing_one"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        0,
        "assertion the_unanswered_request_writes_no_verdict"
    );

    // The dead request does not park the Candidate: the standing grant asks the Agent it names, and
    // that Run answers under its own authorization.
    let observer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    assert_eq!(
        run_agent(&database, &observer_run),
        INDEPENDENT_REVIEWER_AGENT,
        "assertion the_standing_grant_asked_the_observer_it_names"
    );
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &observer_run,
        "command_stage_unanswered_request_replacement",
        stage_input(&candidate_id, 2, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        (
            recorded.review.policy_revision,
            recorded.review.reviewer_agent_run_id.as_str(),
            recorded.task_status,
        ),
        (2, observer_run.as_str(), super::LoomTaskStatus::InReview),
        "assertion the_replacement_verdict_binds_the_standing_grant_and_its_run"
    );
    assert_eq!(
        (
            acceptance_status(&database, &candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
            count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        ),
        ("PENDING".to_string(), 0, 1),
        "assertion the_replacement_pass_leaves_the_delivery_and_the_owner_decision_alone"
    );

    // Both requests stay in the ledger: the unanswered one is history, not something to erase.
    let ledger: Vec<(String, i64, Option<String>)> = {
        let mut statement = database
            .connection()
            .prepare(
                "SELECT dispatch.kind, dispatch.policy_revision, delivery.claimed_agent_run_id
                 FROM loom_control_dispatch dispatch
                 LEFT JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
                 WHERE dispatch.task_id='task_a'
                 ORDER BY dispatch.created_at, dispatch.dispatch_id",
            )
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert_eq!(
        ledger,
        vec![
            ("EXECUTE".to_string(), 1, Some(producer_run.clone())),
            ("REVIEW".to_string(), 1, Some(unanswered_run.clone())),
            ("REVIEW".to_string(), 2, Some(observer_run.clone())),
        ],
        "assertion the_unanswered_request_is_kept_beside_the_replacement_it_enabled"
    );
}

/// Dispatch boundary, ported from Mikka `lib/factory/automatic-dispatch.ts`: the automatic dispatch
/// never chooses the role that judges a delivery. Who reviews is the Owner's assignment, and the
/// request is written for exactly that Agent; the independence of the reviewer's session is
/// `lib/factory/check-independence.ts`'s rule, applied where a reviewing Run exists. So an
/// assignment naming an Agent whose session already delivered the Task is honoured as a role and
/// then refused by the verdict fence, and the convergence path is a new authorization naming an
/// outside Agent — never a forged verdict and never a silently rewritten assignment. Nothing
/// delivered is erased and the Owner still decides.
#[test]
fn stage_review_independence_is_judged_at_the_verdict_not_by_the_assignment() {
    let mut database = fixture();
    configure_observer_runtime(&database);
    let mission_id = create_mission_with_members(
        &mut database,
        "control review dispatch fence",
        &[PRODUCER_AGENT, REVIEWER_AGENT, INDEPENDENT_REVIEWER_AGENT],
    );
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let plan_id: String = database
        .connection()
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| row.get(0),
        )
        .unwrap();
    let camp_id = camp_of(&database, &mission_id);
    // The reviewer's own session delivers the first version of the Task; the other Agent reviews it
    // and asks for a rewrite.
    seed_run(&database, &camp_id, REVIEWER_AGENT, "run_reviewer_delivery");
    finish_run(&database, "run_reviewer_delivery");
    control::configure(
        &mut database,
        OWNER,
        policy_input(
            &mission_id,
            "command_approve_first_review_observer",
            PRODUCER_AGENT,
        ),
    )
    .unwrap();
    task_release(
        &mut database,
        LoomTaskReleaseInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
        },
    )
    .unwrap();
    let first_claim = claim_acquire(
        &mut database,
        LoomClaimAcquireInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: "run_reviewer_delivery".into(),
            claimant_agent_id: Some(REVIEWER_AGENT.into()),
            command_id: "command_claim_first_version_dispatch_fence".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    let first = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: "run_reviewer_delivery".into(),
            claim_id: first_claim.claim_id,
            fence_generation: first_claim.fence_generation,
            command_id: "command_candidate_first_version_dispatch_fence".into(),
            content_hash: "sha256:dispatch-fence-first".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    let first_candidate_id = first.candidate_id;
    let first_manifest =
        control::candidate_manifest_hash(database.connection(), &first_candidate_id).unwrap();
    let first_review_run = dispatched_review_run(&mut database, &camp_id, &first_candidate_id);
    assert_eq!(
        run_agent(&database, &first_review_run),
        PRODUCER_AGENT,
        "assertion the_first_grant_asked_the_agent_that_did_not_deliver_it"
    );
    let mut request_changes = stage_input(
        &first_candidate_id,
        1,
        &first_manifest,
        LoomStageVerdict::RequestChanges,
    );
    request_changes.reason = "the first version needs a rewrite".into();
    request_changes.criteria_results[1].satisfied = false;
    control::stage_review_record(
        &mut database,
        &mission_id,
        PRODUCER_AGENT,
        &first_review_run,
        "command_stage_first_version_dispatch_fence",
        request_changes,
    )
    .unwrap();
    finish_run(&database, &first_review_run);

    // A new approval names the Agent whose session delivered the first version as the reviewer, and
    // the rework is delivered by the other Agent: the Task now has a Candidate nobody has reviewed
    // and an assignment that could never answer it.
    let mut second_grant = policy_input(
        &mission_id,
        "command_approve_shared_session_reviewer",
        REVIEWER_AGENT,
    );
    second_grant.expected_revision = 1;
    control::configure(&mut database, OWNER, second_grant).unwrap();
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    let rework_claim = claim_acquire(
        &mut database,
        LoomClaimAcquireInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: PRODUCER_RUN.into(),
            claimant_agent_id: Some(PRODUCER_AGENT.into()),
            command_id: "command_claim_dispatch_fence_rework".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    let second = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: PRODUCER_RUN.into(),
            claim_id: rework_claim.claim_id,
            fence_generation: rework_claim.fence_generation,
            command_id: "command_candidate_dispatch_fence_rework".into(),
            content_hash: "sha256:dispatch-fence-second".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: Some(first_candidate_id.clone()),
        },
    )
    .unwrap();
    let second_candidate_id = second.candidate_id;
    let second_manifest =
        control::candidate_manifest_hash(database.connection(), &second_candidate_id).unwrap();

    // An assignment is a role, not an independence judgement: the scheduler writes the request for
    // the Agent the Owner named and the delivery lane claims it, exactly as upstream queues every
    // stage for its assigned recipient and leaves the check's independence to `check-independence`.
    let shared_review_run = dispatched_review_run(&mut database, &camp_id, &second_candidate_id);
    assert_eq!(
        run_agent(&database, &shared_review_run),
        REVIEWER_AGENT,
        "assertion the_request_goes_to_the_agent_the_owner_named"
    );
    // The verdict from that session is refused by the independence fence itself, which is the only
    // place able to judge it: by then a reviewing Run exists and its session can be compared.
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &shared_review_run,
        "command_stage_shared_session_reviewer",
        stage_input(&second_candidate_id, 2, &second_manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEWER_SESSION_SHARED",
        "assertion the_independence_fence_refuses_the_shared_session_verdict"
    );
    // The refusal fabricates nothing: no verdict is written, the Candidate stays the Owner's to
    // accept, and the unanswered request stays in the ledger under the grant that wrote it.
    assert_eq!(
        (
            acceptance_status(&database, &second_candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        ("PENDING".to_string(), 1, 0),
        "assertion the_refused_verdict_writes_no_verdict_and_no_user_acceptance"
    );
    // While that grant stands the Task waits, and a second pass must not write a second copy of the
    // same request: the unanswered request keeps its own revision.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion the_unanswered_request_is_not_handed_out_twice"
    );
    assert_eq!(
        count(
            &database,
            &format!(
                "SELECT COUNT(*) FROM loom_control_dispatch
                 WHERE plan_id='{plan_id}' AND task_id='task_a' AND kind='REVIEW'
                   AND candidate_id='{second_candidate_id}' AND policy_revision=2"
            ),
        ),
        1,
        "assertion the_unanswered_request_stays_the_single_request_of_its_grant"
    );

    // The convergence path is a new authorization, not a forged verdict: an outside Agent is a
    // different session, so its request is an event of its own revision and the platform hands it
    // the review, while the stale request stays history in the ledger.
    let mut observer = policy_input(
        &mission_id,
        "command_approve_dispatch_fence_observer",
        INDEPENDENT_REVIEWER_AGENT,
    );
    observer.expected_revision = 2;
    control::configure(&mut database, OWNER, observer).unwrap();
    let observer_run = dispatched_review_run(&mut database, &camp_id, &second_candidate_id);
    assert_eq!(
        run_agent(&database, &observer_run),
        INDEPENDENT_REVIEWER_AGENT,
        "assertion the_new_grant_asked_the_outside_agent"
    );
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &observer_run,
        "command_stage_dispatch_fence_observer",
        stage_input(&second_candidate_id, 3, &second_manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        (
            recorded.review.policy_revision,
            recorded.review.candidate_id.as_str(),
            recorded.task_status,
            acceptance_status(&database, &second_candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
            count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
        ),
        (
            3,
            second_candidate_id.as_str(),
            super::LoomTaskStatus::InReview,
            "PENDING".to_string(),
            0,
            2,
        ),
        "assertion the_outside_verdict_lands_and_the_owner_still_decides"
    );
}

/// Native Session identity: a session is the (installation, id) pair the schema keeps unique. Two
/// installations that both report `session-1` are separate sessions and their Runs are independent
/// observers. When the owner of an equal id is unknown, no distinct session can be proven, so the
/// reviewer is refused. Same installation with a different id is independent again.
///
/// The schema's unique native-binding index keeps the identical pair out of two conversations, so
/// the reachable cross-conversation shapes are exactly these: equal id with two owners, equal id
/// with one owner, and one owner with two ids. Same-conversation sharing is judged by the
/// conversation identity itself.
#[test]
fn stage_review_compares_a_native_session_with_its_installation() {
    let mut database = fixture();
    configure_observer_runtime(&database);
    let mission_id = create_mission_with_members(
        &mut database,
        "control native session",
        &[PRODUCER_AGENT, REVIEWER_AGENT, INDEPENDENT_REVIEWER_AGENT],
    );
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(
        &database,
        &camp_id,
        INDEPENDENT_REVIEWER_AGENT,
        INDEPENDENT_REVIEWER_RUN,
    );
    control::configure(
        &mut database,
        OWNER,
        policy_input(
            &mission_id,
            "command_approve_native_observer",
            INDEPENDENT_REVIEWER_AGENT,
        ),
    )
    .unwrap();
    let (candidate_id, manifest) = submitted_candidate(&mut database, &mission_id, PRODUCER_RUN);
    set_native_session(
        &database,
        PRODUCER_RUN,
        Some("installation_producer"),
        "session-1",
    );

    // Two installations, one id string each: two Native Sessions, so a real independent verdict.
    // The observer's Native Session belongs to its conversation, so it is set on the Run the review
    // Delivery produced — the identity of the session, not of one process.
    finish_run(&database, INDEPENDENT_REVIEWER_RUN);
    let first_observer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    set_native_session(
        &database,
        &first_observer_run,
        Some("installation_reviewer"),
        "session-1",
    );
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &first_observer_run,
        "command_stage_separate_installations",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        recorded.review.reviewer_agent_run_id, first_observer_run,
        "assertion two_installations_reporting_one_id_string_are_two_sessions"
    );

    // The reviewer now reports the producer's id with no owner recorded: an equal id whose owner
    // cannot be told apart is one session, and the new grant cannot launder it. The platform asks
    // the review again, so the refusal is the verdict fence's own: the Run it produced reports that
    // session.
    let mut second_grant = policy_input(
        &mission_id,
        "command_approve_unowned_native_session",
        INDEPENDENT_REVIEWER_AGENT,
    );
    second_grant.expected_revision = 1;
    control::configure(&mut database, OWNER, second_grant).unwrap();
    finish_run(&database, &first_observer_run);
    let shared_observer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    set_native_session(&database, &shared_observer_run, None, "session-1");
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &shared_observer_run,
        "command_stage_unowned_native_session",
        stage_input(&candidate_id, 2, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEWER_SESSION_SHARED",
        "assertion an_unowned_equal_native_session_is_treated_as_the_producers"
    );
    // The shared session is a refusal, not a deletion: the request that was answered by nobody
    // stays in the ledger, so the next grant has to ask again rather than reuse it.
    assert_eq!(
        count(
            &database,
            &format!(
                "SELECT COUNT(*) FROM loom_stage_review WHERE candidate_id='{candidate_id}'"
            ),
        ),
        1,
        "assertion the_refused_verdict_leaves_the_one_recorded_verdict_alone"
    );

    // Same installation, a different session id: independent again. The refused Run's session is
    // cleared first, so the re-asked review is not judged by that refusal's identity.
    let mut third_grant = policy_input(
        &mission_id,
        "command_approve_other_native_session",
        INDEPENDENT_REVIEWER_AGENT,
    );
    third_grant.expected_revision = 2;
    control::configure(&mut database, OWNER, third_grant).unwrap();
    finish_run(&database, &shared_observer_run);
    database
        .connection()
        .execute(
            "UPDATE conversation SET native_adapter_installation_id=NULL, native_session_id=NULL
             WHERE id = (SELECT conversation_id FROM agent_run WHERE id=?1)",
            [&shared_observer_run],
        )
        .unwrap();
    let own_session_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    set_native_session(
        &database,
        &own_session_run,
        Some("installation_producer"),
        "session-2",
    );
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &own_session_run,
        "command_stage_other_native_session",
        stage_input(&candidate_id, 3, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();
    assert_eq!(
        recorded.review.policy_revision, 3,
        "assertion the_same_installation_in_another_session_is_independent"
    );

    // Same conversation is the strongest shared identity of all, and it is refused even when the
    // Native Session pair differs.
    let mut fourth_grant = policy_input(
        &mission_id,
        "command_approve_same_conversation",
        PRODUCER_AGENT,
    );
    fourth_grant.expected_revision = 3;
    control::configure(&mut database, OWNER, fourth_grant).unwrap();
    finish_run(&database, &own_session_run);
    finish_run(&database, PRODUCER_RUN);
    seed_run(
        &database,
        &camp_id,
        PRODUCER_AGENT,
        "run_producer_reviewing",
    );
    set_native_session(
        &database,
        "run_producer_reviewing",
        Some("installation_producer"),
        "session-3",
    );
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        PRODUCER_AGENT,
        "run_producer_reviewing",
        "command_stage_same_conversation",
        stage_input(&candidate_id, 4, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_CONTROL_REVIEWER_SELF",
        "assertion one_conversation_cannot_judge_its_own_delivery"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
            acceptance_status(&database, &candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        (2, "PENDING".to_string(), 0),
        "assertion only_the_two_independent_verdicts_land_and_the_owner_still_decides"
    );
}

/// Source boundary, the other direction: a Run the platform asked to review one delivery cannot
/// re-aim itself at the rework of the same Task. After its `request_changes` a new Candidate exists
/// that nobody has dispatched yet, so a source check that only reads the *payload's* Candidate would
/// find "no dispatch" and wave the old reviewer through. The rejection has to come from the Run's
/// own binding, under the standing grant and under a later one, and neither refusal may write a
/// verdict; an observer the control plane never asked is still a real human/Lead source.
#[test]
fn stage_review_cannot_reaim_a_run_bound_to_another_candidate() {
    let mut database = fixture();
    configure_observer_runtime(&database);
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "control review re-aim",
        "command_approve_review_reaim",
        &[PRODUCER_AGENT, REVIEWER_AGENT, INDEPENDENT_REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);

    // The producer's Run takes the reserved Delivery and records the first delivery.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_approved_execution_is_reserved"
    );
    let producer_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the reserved delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &producer_run);
    let (claim_id, fence_generation) = open_claim_of(&database, &plan_id, "task_a", &producer_run);
    let first = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.clone(),
            claim_id,
            fence_generation,
            command_id: "command_candidate_reaim_first".into(),
            content_hash: "sha256:reaim-first".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        },
    )
    .unwrap();
    let first_candidate_id = first.candidate_id;
    let first_manifest =
        control::candidate_manifest_hash(database.connection(), &first_candidate_id).unwrap();

    // The platform dispatches the review of that Candidate, its Run claims the Delivery and asks
    // for a rewrite — the one verdict this Task is allowed to carry so far.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_first_delivery_is_handed_to_its_reviewer"
    );
    let reviewer_run = claim_mission_lane(&mut database, &camp_id, 1)
        .pop()
        .expect("the review delivery must materialise one run");
    claim_the_run(&mut database, &camp_id, &reviewer_run);
    let mut changes = stage_input(
        &first_candidate_id,
        1,
        &first_manifest,
        LoomStageVerdict::RequestChanges,
    );
    changes.reason = "the first delivery needs a rewrite".into();
    changes.criteria_results[1].satisfied = false;
    control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
        "command_stage_reaim_first",
        changes,
    )
    .unwrap();

    // The producer delivers the rework under the same grant: a second Candidate, chained on the
    // first, that no REVIEW dispatch names yet.
    let rework_claim = claim_acquire(
        &mut database,
        LoomClaimAcquireInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.clone(),
            claimant_agent_id: Some(PRODUCER_AGENT.into()),
            command_id: "command_claim_reaim_rework".into(),
            lease_seconds: None,
        },
    )
    .unwrap();
    let second = candidate_record(
        &mut database,
        LoomCandidateRecordInput {
            mission_id: mission_id.clone(),
            task_id: "task_a".into(),
            agent_run_id: producer_run.clone(),
            claim_id: rework_claim.claim_id,
            fence_generation: rework_claim.fence_generation,
            command_id: "command_candidate_reaim_second".into(),
            content_hash: "sha256:reaim-second".into(),
            evidence_ids: vec![],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: Some(first_candidate_id.clone()),
        },
    )
    .unwrap();
    let second_candidate_id = second.candidate_id;
    let second_manifest =
        control::candidate_manifest_hash(database.connection(), &second_candidate_id).unwrap();
    let dispatched_for_rework: i64 = database
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM loom_control_dispatch
             WHERE plan_id=?1 AND task_id='task_a' AND kind='REVIEW' AND candidate_id=?2",
            params![&plan_id, &second_candidate_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        dispatched_for_rework, 0,
        "assertion the_rework_has_no_review_dispatch_yet"
    );

    // The Run that reviewed the first delivery re-aims itself at the rework: the payload names a
    // Candidate the ledger never dispatched, so only its own binding can refuse it.
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
        "command_stage_reaim_standing_grant",
        stage_input(
            &second_candidate_id,
            1,
            &second_manifest,
            LoomStageVerdict::Pass,
        ),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_SOURCE_UNBOUND",
        "assertion a_run_asked_to_review_the_old_delivery_cannot_judge_the_rework"
    );

    // A later approval asks nobody either: re-labelling the old Run with the new revision does not
    // make the standing grant ask it.
    let mut reapproved = policy_input(
        &mission_id,
        "command_approve_review_reaim_again",
        REVIEWER_AGENT,
    );
    reapproved.expected_revision = 1;
    control::configure(&mut database, OWNER, reapproved).unwrap();
    let error = control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
        "command_stage_reaim_new_grant",
        stage_input(
            &second_candidate_id,
            2,
            &second_manifest,
            LoomStageVerdict::Pass,
        ),
    )
    .unwrap_err();
    assert_eq!(
        rejection_code(&error),
        "LOOM_STAGE_REVIEW_SOURCE_UNBOUND",
        "assertion the_reapproved_grant_still_has_not_asked_that_run"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_stage_review"),
            acceptance_status(&database, &second_candidate_id),
            task_state(&database, &mission_id, "task_a"),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        (1, "PENDING".to_string(), "IN_REVIEW".to_string(), 0),
        "assertion neither_re-aimed_refusal_writes_a_verdict_or_the_owners_review"
    );

    // A final approval asks a different Agent, and the platform hands that Agent the review of the
    // rework: the fence is not a blanket refusal of every Candidate, only of a verdict nobody asked
    // for. The Run that claimed the new grant's Delivery is the observer.
    let mut observer = policy_input(
        &mission_id,
        "command_approve_review_reaim_observer",
        INDEPENDENT_REVIEWER_AGENT,
    );
    observer.expected_revision = 2;
    control::configure(&mut database, OWNER, observer).unwrap();
    finish_run(&database, &reviewer_run);
    let observer_run = dispatched_review_run(&mut database, &camp_id, &second_candidate_id);
    assert_eq!(
        run_agent(&database, &observer_run),
        INDEPENDENT_REVIEWER_AGENT,
        "assertion the_final_grant_asked_the_named_observer"
    );
    let recorded = control::stage_review_record(
        &mut database,
        &mission_id,
        INDEPENDENT_REVIEWER_AGENT,
        &observer_run,
        "command_stage_reaim_observer",
        stage_input(
            &second_candidate_id,
            3,
            &second_manifest,
            LoomStageVerdict::Pass,
        ),
    )
    .unwrap();
    assert_eq!(
        (
            recorded.review.reviewer_agent_run_id.as_str(),
            recorded.review.policy_revision,
            recorded.task_status,
            acceptance_status(&database, &second_candidate_id),
            count(&database, "SELECT COUNT(*) FROM loom_review"),
        ),
        (
            observer_run.as_str(),
            3,
            super::LoomTaskStatus::InReview,
            "PENDING".to_string(),
            0,
        ),
        "assertion a_dispatched_observer_still_leaves_the_owner_the_decision"
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
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| row.get(0),
        )
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
        control::dispatch_block_reason(
            database.connection(),
            &dispatch_id,
            &chrono::Utc::now().to_rfc3339()
        )
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
                stage_input(
                    "candidate_missing",
                    2,
                    &"0".repeat(64),
                    LoomStageVerdict::Pass
                ),
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
    let reserved_reason =
        control::dispatch_block_reason(database.connection(), "dispatch_reserved", &now).unwrap();
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
    finish_run(&database, REVIEWER_RUN);
    let reviewer_run = dispatched_review_run(&mut database, &camp_id, &candidate_id);
    control::stage_review_record(
        &mut database,
        &mission_id,
        REVIEWER_AGENT,
        &reviewer_run,
        "command_stage_persist",
        stage_input(&candidate_id, 1, &manifest, LoomStageVerdict::Pass),
    )
    .unwrap();

    let directory = database.directory().to_path_buf();
    database.close();
    let reopened = Database::open(&directory).expect("the reopened database must be admitted");
    let snapshot = control::get(&reopened, &mission_id).unwrap();
    let policy = snapshot
        .policy
        .expect("the approval must survive the reopen");
    assert_eq!(
        (
            policy.revision,
            policy.authorization_revision,
            policy.approved_by.as_str()
        ),
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
fn task_blocked_reason(database: &Database, plan_id: &str, task_id: &str) -> Option<String> {
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
fn loom_deliveries(database: &Database) -> i64 {
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
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| row.get(0),
        )
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

/// The durable dispatch facts this module recorded for one Task, in write order:
/// `(event type, reason code)`. A recovery fact carries no reason.
fn dispatch_events(database: &Database, task_id: &str) -> Vec<(String, Option<String>)> {
    let mut statement = database
        .connection()
        .prepare(
            "SELECT event_type, json_extract(payload_json, '$.reasonCode') FROM event_log
             WHERE entity_type='loom_task' AND entity_id=?1
               AND event_type IN ('loom.dispatch_failed','loom.dispatch_recovered')
             ORDER BY id",
        )
        .unwrap();
    statement
        .query_map([task_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn failure_fact(reason: &str) -> (String, Option<String>) {
    ("loom.dispatch_failed".to_string(), Some(reason.to_string()))
}

fn recovered_fact() -> (String, Option<String>) {
    ("loom.dispatch_recovered".to_string(), None)
}

/// Point one member at a remote Node and give that Node the selected harness: a real
/// `member_execution_target` row, a ready `mission_workspace` on that Node and a reported CLI.
/// Returns the workspace id.
fn select_remote_node(
    database: &OwnedTestDatabase,
    camp_id: &str,
    member_id: &str,
    node_id: &str,
    adapter_kind: AdapterKind,
    heartbeat: &str,
) -> String {
    let connection = database.connection();
    let mission_id: String = connection
        .query_row(
            "SELECT id FROM mission WHERE camp_id=?1",
            [camp_id],
            |row| row.get(0),
        )
        .unwrap();
    let workspace_id = format!("workspace_{node_id}");
    let root = format!("/fixture/{node_id}/worktree");
    connection
        .execute(
            "INSERT INTO execution_node(node_id,display_name,role,os,arch,token_digest,paired_at,
                                        revoked_at,last_heartbeat)
             VALUES(?1,'Remote Node','remote',NULL,NULL,?2,?3,NULL,?3)",
            params![node_id, "a".repeat(64), heartbeat],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO execution_node_cli(node_id,adapter_kind,path,version,path_present,
                                            reported_at,installation_identity,
                                            installation_generation)
             VALUES(?1,?2,?3,'9.9.9',1,?4,?5,1)",
            params![
                node_id,
                adapter_kind.as_str(),
                format!("{root}/{}", adapter_kind.as_str()),
                heartbeat,
                format!("sha256:{}", "b".repeat(64))
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO mission_workspace(id,mission_id,camp_id,execution_host_id,
                                           source_directory,repository_root,git_common_dir,
                                           worktree_path,working_directory,base_branch,branch,
                                           base_sha,preparation_token,preparation_kind,generation,
                                           state,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?5,?6,?5,?5,'main','rovai/mission/remote','base',
                    'loom-remote-preparation','create',1,'ready',?7,?7)",
            params![
                workspace_id,
                mission_id,
                camp_id,
                node_id,
                root,
                format!("{root}/.git"),
                heartbeat
            ],
        )
        .unwrap();
    let defaults = crate::agent_profile::member_runtime_defaults(adapter_kind);
    let selection = serde_json::json!({
        "nodeId": node_id,
        "workspaceId": workspace_id,
        "workspaceRoot": root,
        "adapterKind": adapter_kind.as_str(),
        "model": defaults.model,
        "permissions": defaults.permissions,
    });
    connection
        .execute(
            "INSERT INTO member_execution_target(member_id,revision,node_id,selection_json,
                                                 updated_at)
             VALUES(?1,1,?2,?3,?4)",
            params![member_id, node_id, selection.to_string(), heartbeat],
        )
        .unwrap();
    workspace_id
}

/// The prepared Mission workspace the real scheduler hands to a claim, so a Mission lane is claimed
/// exactly as production claims it instead of being deferred as unprepared. Captured immediately
/// before each claim, because the fence is the workspace the claim will re-prove.
fn mission_batch_workspaces(
    database: &mut OwnedTestDatabase,
    camp_id: &str,
) -> crate::delivery_queue::BatchWorkspaces {
    let project_path: String = database
        .connection()
        .query_row(
            "SELECT project_path FROM camp WHERE id=?1",
            [camp_id],
            |row| row.get(0),
        )
        .unwrap();
    let workspace = crate::runtime::AgentRunWorkspace {
        execution_root: project_path.clone(),
        access: "write".into(),
        isolation: "git_worktree".into(),
    };
    let fact = serde_json::json!({
        "workingDirectory": project_path,
        "branch": "rovai/mission/fixture",
    });
    let prepared =
        crate::delivery_queue::capture_prepared_batch_workspace(database, camp_id, workspace, fact)
            .unwrap();
    crate::delivery_queue::BatchWorkspaces::from([(camp_id.to_string(), Ok(prepared))])
}

fn claim_mission_lane(database: &mut OwnedTestDatabase, camp_id: &str, limit: i64) -> Vec<String> {
    let workspaces = mission_batch_workspaces(database, camp_id);
    crate::delivery_queue::claim_waiting_delivery_batches_with_workspaces(
        database,
        limit,
        &workspaces,
    )
    .unwrap()
}

/// The Run's own admission, exactly as the scheduler performs it: the same command, the same system
/// actor and the same frozen workspace facts. A queued Run that the control plane blocks must be
/// rejected here, not merely described.
fn claim_the_run(
    database: &mut OwnedTestDatabase,
    camp_id: &str,
    run_id: &str,
) -> crate::command::CommandExecution {
    let version: i64 = database
        .connection()
        .query_row(
            "SELECT version FROM agent_run WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .unwrap();
    crate::runtime::ExecutionRuntimeService::default()
        .claim_agent_run(
            database,
            &CommandEnvelope {
                command_id: uuid::Uuid::new_v4().to_string(),
                actor: ActorRef::System {
                    component_id: "agent-run-scheduler".into(),
                },
                camp_id: Some(camp_id.to_string()),
                expected_versions: vec![],
                execution_epoch: None,
                payload: crate::runtime::ClaimAgentRunCommand {
                    agent_run_id: run_id.to_string(),
                    expected_version: version,
                    lease_owner: "loom-dispatch-test".into(),
                    lease_seconds: 60,
                    workspace: None,
                    starting_git_observation: None,
                },
            },
        )
        .unwrap()
}

/// The dispatch row the control plane wrote for one Task, and the Run its Delivery produced.
fn dispatch_and_run(database: &OwnedTestDatabase, task_id: &str) -> (String, Option<String>) {
    database
        .connection()
        .query_row(
            "SELECT dispatch.dispatch_id, delivery.claimed_agent_run_id
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             WHERE dispatch.task_id=?1 ORDER BY dispatch.created_at, dispatch.dispatch_id LIMIT 1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn run_status(database: &Database, run_id: &str) -> String {
    database
        .connection()
        .query_row(
            "SELECT status FROM agent_run WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .unwrap()
}

/// Failure-vocabulary boundary, ported from Mikka
/// `lib/factory/dispatch-recovery.ts:factoryDispatchFailureReason`: the reason names the first fact
/// that makes the recipient unusable, in the order switch → presence → harness, and the same
/// vocabulary is what the pre-run recheck hands to the wrapper.
#[test]
fn dispatch_failure_reason_follows_the_disabled_offline_harness_order() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch failure vocabulary",
        "command_approve_vocabulary",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
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

    // A present member, but the runtime it is bound to cannot be reached: still presence. This
    // Recipient is addressable, so the approved work is reserved instead of being forgotten.
    database
        .connection()
        .execute(
            "UPDATE agent_profile SET profile_status='present' WHERE id=?1",
            [PRODUCER_AGENT],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion an_addressable_recipient_whose_device_is_gone_reserves_the_work"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion an_unreachable_runtime_outranks_the_harness_it_would_run"
    );
    assert_eq!(
        (
            count(
                &database,
                "SELECT COUNT(*) FROM loom_control_dispatch WHERE task_id='task_a'"
            ),
            loom_deliveries(&database)
        ),
        (1, 1),
        "assertion the_reserved_work_is_one_ledger_row_and_one_waiting_delivery"
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

    // The last fact is repaired. The stored probe of that installation is stale at the same time:
    // a probe result is not an admission fact, so it cannot keep a launchable Runtime out.
    database
        .connection()
        .execute(
            "UPDATE agent_profile SET selected_runtime_adapter_kind='codex-cli' WHERE id=?1",
            [PRODUCER_AGENT],
        )
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE adapter_capability_snapshot SET probe_status='light_failed'
             WHERE installation_id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion a_repaired_recipient_resumes_its_reservation_instead_of_a_second_dispatch"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion a_successful_admission_clears_the_failure_vocabulary"
    );
    assert_eq!(
        (
            count(
                &database,
                "SELECT COUNT(*) FROM loom_control_dispatch WHERE task_id='task_a'"
            ),
            loom_deliveries(&database)
        ),
        (2, 1),
        "assertion the_repaired_recipient_still_owns_one_reservation_and_one_delivery"
    );
    assert_eq!(
        control::dispatch_block_reason(database.connection(), "dispatch_reserved", &now).unwrap(),
        None,
        "assertion the_prerun_recheck_passes_once_every_fact_is_repaired"
    );
}

/// Presence is launch intent, not a probe: Core's own admission starts a Runtime that is merely
/// `light_ready`, `installed_unverified`, or has no capability snapshot yet, so dispatch must not be
/// stricter than the execution path it feeds.
#[test]
fn dispatch_does_not_require_a_fresh_ready_probe() {
    for probe in [
        Some("light_ready"),
        Some("light_failed"),
        Some("installed_unverified"),
        None,
    ] {
        let mut database = fixture();
        let (_mission_id, plan_id) = dispatchable_plan(
            &mut database,
            "dispatch probe independence",
            "command_approve_probe_independence",
            &[PRODUCER_AGENT, REVIEWER_AGENT],
            &[],
        );
        let installation_id = installation_of(&database, PRODUCER_AGENT);
        match probe {
            Some(status) => {
                database
                    .connection()
                    .execute(
                        "UPDATE adapter_capability_snapshot SET probe_status=?1
                         WHERE installation_id=?2",
                        params![status, &installation_id],
                    )
                    .unwrap();
            }
            None => {
                database
                    .connection()
                    .execute(
                        "DELETE FROM adapter_capability_snapshot WHERE installation_id=?1",
                        [&installation_id],
                    )
                    .unwrap();
            }
        }
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            1,
            "assertion a_{probe:?}_probe_does_not_block_a_launchable_installation"
        );
        assert_eq!(
            task_blocked_reason(&database, &plan_id, "task_a"),
            None,
            "assertion no_failure_is_recorded_for_a_launchable_installation"
        );
        assert_eq!(
            dispatch_events(&database, "task_a"),
            vec![],
            "assertion a_launchable_installation_writes_no_failure_fact"
        );
    }
}

/// Dedupe boundary: one recorded failure per reason, so repeated ticks cannot turn one unavailable
/// recipient into a stream of events, and a verdict that changes and changes back is not recorded
/// twice. Recovery resumes the *same* event identity instead of minting a second Delivery.
#[test]
fn a_dispatch_failure_is_recorded_once_and_recovery_resumes_the_same_event() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch failure dedupe",
        "command_approve_dedupe",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
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
        1,
        "assertion an_unreachable_device_still_reserves_the_approved_work"
    );
    let recorded_revision = task_row_revision(&database, &plan_id, "task_a");
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion the_first_unreachable_pass_records_the_presence_fact"
    );
    let offline_fact = failure_fact("loom.dispatch_recipient_offline");
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![offline_fact.clone()],
        "assertion the_first_unreachable_pass_writes_exactly_one_failure_fact"
    );

    // A repeated tick re-derives the same conclusion. It must not write a second copy of it.
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
        "assertion a_repeated_tick_writes_no_second_current_state_reason"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![offline_fact.clone()],
        "assertion a_repeated_tick_writes_no_second_failure_fact"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database)
        ),
        (1, 1),
        "assertion the_reservation_is_one_ledger_row_and_one_waiting_delivery"
    );

    // Switched off while the offline fact is already on record: the switch is a different fact and
    // is recorded once, on top of — not instead of — the earlier one.
    database
        .connection()
        .execute(
            "UPDATE camp_member SET status='left' WHERE camp_id=?1 AND agent_id=?2",
            params![&camp_id, PRODUCER_AGENT],
        )
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_disabled"),
        "assertion the_switch_replaces_only_the_current_state_mirror"
    );
    let disabled_fact = failure_fact("loom.dispatch_recipient_disabled");
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![offline_fact.clone(), disabled_fact.clone()],
        "assertion one_fact_row_per_event_and_reason_instead_of_one_mutable_slot"
    );

    // The switch comes back but the runtime is still gone: the earlier offline judgement is not
    // recorded a second time, because it is keyed by event and reason.
    database
        .connection()
        .execute(
            "UPDATE camp_member SET status='active' WHERE camp_id=?1 AND agent_id=?2",
            params![&camp_id, PRODUCER_AGENT],
        )
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![offline_fact.clone(), disabled_fact.clone()],
        "assertion an_offline_disabled_offline_round_trip_keeps_one_offline_fact"
    );

    // The runtime is back: exactly one recovery fact, and the same Task is handed out under the
    // identity it always had, so the Delivery that finally starts is the one the failed passes
    // named — not a new copy of it.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion recovery_resumes_the_reservation_instead_of_minting_a_second_dispatch"
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
        "assertion recovery_clears_the_current_state_reason"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![
            offline_fact.clone(),
            disabled_fact.clone(),
            recovered_fact()
        ],
        "assertion recovery_records_one_recovery_fact_after_the_failures"
    );

    for _ in 0..2 {
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion a_resumed_event_is_never_dispatched_twice"
        );
    }
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database)
        ),
        (1, 1),
        "assertion recovery_leaves_exactly_one_ledger_row_and_one_delivery"
    );
    assert_eq!(
        dispatch_events(&database, "task_a").len(),
        3,
        "assertion recovery_never_rewrites_or_deletes_the_failure_history"
    );

    // The facts are storage, not process state: a reopened database still sees them and still
    // refuses to mint a second Delivery.
    let directory = database.directory().to_path_buf();
    database.close();
    let mut reopened = Database::open(&directory).expect("the reopened database must be admitted");
    assert_eq!(
        dispatch_events(&reopened, "task_a"),
        vec![offline_fact, disabled_fact, recovered_fact()],
        "assertion the_dispatch_facts_survive_a_reopen"
    );
    assert_eq!(
        control::admit_due_dispatches(&mut reopened).unwrap(),
        0,
        "assertion a_reopened_database_never_redispatches_the_same_event"
    );
    assert_eq!(
        (
            count(&reopened, "SELECT COUNT(*) FROM loom_control_dispatch"),
            count(
                &reopened,
                "SELECT COUNT(*) FROM camp_message_delivery WHERE message_id IN
                     (SELECT id FROM camp_message WHERE author_id='loom-control-scheduler')"
            )
        ),
        (1, 1),
        "assertion a_reopened_database_keeps_one_ledger_row_and_one_delivery"
    );
}

/// Recovery boundary: the Delivery is the queued work — Core creates the Run from it at claim time —
/// so "the same queued Run continues" means this exact row survives the outage and is the one the
/// real claim materialises. A recipient that is unreachable cannot start it, and recovery starts the
/// same Delivery instead of minting a second one.
#[test]
fn an_unreachable_recipient_holds_the_reserved_delivery_and_the_same_queued_run_continues() {
    let mut database = fixture();
    let (mission_id, _plan_id) = dispatchable_plan(
        &mut database,
        "dispatch recovery keeps the queued run",
        "command_approve_recovery",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
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
    let (message_id, queue_sequence): (String, i64) = database
        .connection()
        .query_row(
            "SELECT message_id, queue_sequence FROM camp_message_delivery WHERE id=?1",
            [&delivery_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    // The recipient drops out after the reservation. The real claim asks the control plane before
    // it starts anything, so this exact Delivery waits and no Run is created.
    let installation_id = installation_of(&database, PRODUCER_AGENT);
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert!(
        claim_mission_lane(&mut database, &camp_id, 1).is_empty(),
        "assertion an_unreachable_recipient_cannot_claim_the_reserved_delivery"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM agent_run"),
        0,
        "assertion the_blocked_claim_starts_no_run"
    );
    let (waiting_status, unclaimed, same_message): (String, bool, bool) = database
        .connection()
        .query_row(
            "SELECT status, claimed_agent_run_id IS NULL, message_id=?2
             FROM camp_message_delivery WHERE id=?1",
            params![&delivery_id, &message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (waiting_status.as_str(), unclaimed, same_message),
        ("waiting", true, true),
        "assertion the_queued_delivery_is_untouched_while_it_waits"
    );

    // A pass during the outage records the failure fact once and, the reservation already standing,
    // admits no second dispatch.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion waiting_for_the_recipient_is_not_a_second_dispatch"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![failure_fact("loom.dispatch_recipient_offline")],
        "assertion the_reserved_work_records_its_presence_fact_once"
    );

    // The recipient comes back. The recovery pass records the recovery fact; the claim then
    // materialises the Run from this very Delivery.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion the_recovery_pass_resumes_the_reservation_instead_of_dispatching_again"
    );
    let claimed = claim_mission_lane(&mut database, &camp_id, 1);
    assert_eq!(
        claimed.len(),
        1,
        "assertion the_recovered_recipient_claims_the_same_queued_work"
    );
    let run_id = claimed[0].clone();
    let (claimed_run, claimed_status, same_message, same_sequence, same_dispatch): (
        Option<String>,
        String,
        bool,
        bool,
        bool,
    ) = database
        .connection()
        .query_row(
            "SELECT delivery.claimed_agent_run_id, delivery.status, delivery.message_id=?2,
                    delivery.queue_sequence=?3,
                    EXISTS(SELECT 1 FROM loom_control_dispatch WHERE dispatch_id=?4)
             FROM camp_message_delivery AS delivery WHERE delivery.id=?1",
            params![&delivery_id, &message_id, queue_sequence, &dispatch_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        (claimed_run.as_deref(), claimed_status.as_str()),
        (Some(run_id.as_str()), "claimed"),
        "assertion the_same_reserved_delivery_started_the_recovered_run"
    );
    assert_eq!(
        (same_message, same_sequence, same_dispatch),
        (true, true, true),
        "assertion the_same_queued_work_continues_after_recovery"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database),
            count(&database, "SELECT COUNT(*) FROM agent_run")
        ),
        (1, 1, 1),
        "assertion recovery_adds_no_second_ledger_row_no_second_delivery_and_no_second_run"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![
            failure_fact("loom.dispatch_recipient_offline"),
            recovered_fact()
        ],
        "assertion the_reserved_work_records_exactly_one_recovery_fact"
    );
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion a_tick_after_the_recovery_never_dispatches_the_same_event_again"
    );
}

/// Presence boundary, ported from the upstream device vocabulary: when a member explicitly selected
/// a remote Node, that Node is the device — its heartbeat is presence and its catalog is the
/// harness. The local installation of that Agent is not the device and must not be consulted.
#[test]
fn a_remote_recipient_is_judged_by_its_node_and_recovers_when_the_node_heartbeats() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch remote device",
        "command_approve_remote_device",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    let stale = (chrono::Utc::now() - chrono::Duration::seconds(3600)).to_rfc3339();
    select_remote_node(
        &database,
        &camp_id,
        PRODUCER_AGENT,
        "node_remote",
        AdapterKind::CodexCli,
        &stale,
    );
    // The Agent's local installation is still present, enabled and launchable. A stale Node must
    // still decide, because the Node is where the work would run.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion a_stale_node_reserves_the_work_without_starting_it"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion a_stale_node_heartbeat_is_reported_as_presence"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![failure_fact("loom.dispatch_recipient_offline")],
        "assertion the_stale_node_writes_one_presence_fact"
    );

    // A fresh heartbeat is presence; the Node reporting no usable installation of the selected
    // harness is the harness step.
    let fresh = chrono::Utc::now().to_rfc3339();
    database
        .connection()
        .execute(
            "UPDATE execution_node SET last_heartbeat=?1 WHERE node_id='node_remote'",
            [&fresh],
        )
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE execution_node_cli SET path_present=0
             WHERE node_id='node_remote' AND adapter_kind='codex-cli'",
            [],
        )
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_harness_unavailable"),
        "assertion a_reachable_node_without_the_selected_harness_is_reported_as_the_harness"
    );

    // The Node reports the harness again: the same Task is dispatched, and the ladder's history is
    // kept as three facts rather than one mutable slot.
    database
        .connection()
        .execute(
            "UPDATE execution_node_cli SET path_present=1
             WHERE node_id='node_remote' AND adapter_kind='codex-cli'",
            [],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion the_recovered_remote_node_resumes_its_reservation"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion the_recovered_remote_node_carries_no_current_failure"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![
            failure_fact("loom.dispatch_recipient_offline"),
            failure_fact("loom.dispatch_harness_unavailable"),
            recovered_fact()
        ],
        "assertion the_remote_ladder_records_each_fact_once_and_keeps_history"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database)
        ),
        (1, 1),
        "assertion the_remote_recovery_mints_one_delivery"
    );
}

/// Concurrency boundary, ported from the upstream rule that a heartbeat which commits while the
/// dispatch write waits for the lock must be observed: the availability of every recipient is read
/// inside the writing transaction, so a pass never records a failure from facts it can no longer
/// see — whichever side wins the lock, the repaired facts are the ones judged.
#[test]
fn recipients_that_come_back_while_the_pass_waits_for_the_lock_are_dispatched_once() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch concurrent recovery",
        "command_approve_concurrent",
        &[PRODUCER_AGENT, REVIEWER_AGENT, SECOND_PRODUCER_AGENT],
        &[("task_second", SECOND_PRODUCER_AGENT)],
    );
    let _ = &mission_id;
    let installation_id = installation_of(&database, PRODUCER_AGENT);
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    database
        .connection()
        .busy_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
        0,
        "assertion no_pass_has_looked_at_these_recipients_yet"
    );

    // A second connection repairs the runtime and holds the write lock. The pass is started while
    // that lock is held, so a read taken before it would see the stale `path_missing`.
    let directory = database.directory().to_path_buf();
    let repaired_installation = installation_id.clone();
    let (locked, lock_held) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let mut holder =
            Database::open_verified_test_clone(&directory, TestDatabaseOpenMode::ProductionLike)
                .unwrap();
        holder
            .connection()
            .busy_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        let transaction = holder
            .connection_mut()
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        transaction
            .execute(
                "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
                [&repaired_installation],
            )
            .unwrap();
        locked.send(()).unwrap();
        released.recv().unwrap();
        transaction.commit().unwrap();
    });
    lock_held.recv().unwrap();

    let admitted = std::thread::scope(|scope| {
        let pass = scope.spawn(|| control::admit_due_dispatches(&mut database).unwrap());
        release.send(()).unwrap();
        pass.join().unwrap()
    });
    holder.join().unwrap();

    assert_eq!(
        admitted, 2,
        "assertion a_pass_never_dispatches_from_a_stale_reading_of_the_device"
    );
    for task_id in ["task_a", "task_second"] {
        assert_eq!(
            task_blocked_reason(&database, &plan_id, task_id),
            None,
            "assertion the_recovered_recipient_carries_no_stale_failure_record"
        );
        assert_eq!(
            dispatch_events(&database, task_id),
            vec![],
            "assertion the_waited_pass_records_no_stale_failure_and_no_recovery"
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
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database)
        ),
        (2, 2),
        "assertion concurrent_recovery_creates_no_duplicate_delivery"
    );
}

/// Single-dispatch boundary, ported from upstream's concurrent `deviceOnline` race: two independent
/// connections admitting the same queued work at the same instant must produce one Dispatch and one
/// Delivery. The write transaction serialises them and the ledger's dedupe key is what the second
/// pass sees, so neither one can mint a second copy.
#[test]
fn concurrent_passes_admit_the_same_queued_work_exactly_once() {
    let mut database = fixture();
    let (_mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch concurrent passes",
        "command_approve_two_passes",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let directory = database.directory().to_path_buf();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let results: Vec<usize> = std::thread::scope(|scope| {
        let mut passes = Vec::new();
        for _ in 0..2 {
            let directory = directory.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            passes.push(scope.spawn(move || {
                let mut pass = Database::open_verified_test_clone(
                    &directory,
                    TestDatabaseOpenMode::ProductionLike,
                )
                .unwrap();
                pass.connection()
                    .busy_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                barrier.wait();
                control::admit_due_dispatches(&mut pass).unwrap()
            }));
        }
        barrier.wait();
        passes
            .into_iter()
            .map(|pass| pass.join().unwrap())
            .collect()
    });
    assert_eq!(
        results.iter().sum::<usize>(),
        1,
        "assertion two_concurrent_passes_admit_the_same_event_exactly_once: {results:?}"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database)
        ),
        (1, 1),
        "assertion concurrent_passes_leave_one_ledger_row_and_one_delivery"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![],
        "assertion a_successful_race_writes_no_failure_fact"
    );
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion a_tick_after_the_race_dispatches_nothing_again"
    );
    let _ = plan_id;
}

/// Recovery boundary for work that was never handed out: the first pass already found the device
/// gone, so nothing but the failure fact existed before. The approved work must still be a pending
/// item the *existing* Delivery scheduler and recovery timer can find, and it must resume without
/// anybody calling the LOOM pass by hand.
#[test]
fn a_reserved_dispatch_is_found_and_resumed_by_the_delivery_recovery_timer() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch recovery timer",
        "command_approve_recovery_timer",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
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
        1,
        "assertion the_first_unreachable_pass_reserves_the_approved_work"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion the_reserved_work_records_the_presence_fact"
    );
    // The one gate the batch scheduler reads before it looks at anything: a waiting Delivery and an
    // unsettled dispatch row. Without this, a device that comes back would never be noticed.
    assert!(
        crate::delivery_queue::has_pending_delivery_batch_work(&database).unwrap(),
        "assertion the_reservation_is_pending_work_the_scheduler_can_see"
    );
    assert!(
        crate::delivery_queue::next_delivery_recovery_due(&database)
            .unwrap()
            .is_some(),
        "assertion the_recovery_timer_has_a_deadline_for_the_reservation"
    );

    // Still gone: the timer's own pass starts nothing.
    let workspaces = mission_batch_workspaces(&mut database, &camp_id);
    let offline_pass =
        crate::delivery_queue::run_delivery_recovery_pass(&mut database, 1, &workspaces, None)
            .unwrap();
    assert!(
        offline_pass.claimed_agent_run_ids.is_empty(),
        "assertion an_unreachable_device_starts_no_run"
    );
    assert_eq!(
        count(&database, "SELECT COUNT(*) FROM agent_run"),
        0,
        "assertion the_blocked_lane_materialises_no_run"
    );

    // The device comes back. Nothing calls `admit_due_dispatches` here: the production claim sweep
    // of the recovery timer is what resumes the reserved work.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    let recovered_pass =
        crate::delivery_queue::run_delivery_recovery_pass(&mut database, 1, &workspaces, None)
            .unwrap();
    assert_eq!(
        recovered_pass.claimed_agent_run_ids.len(),
        1,
        "assertion the_recovery_timer_resumes_the_reserved_work_by_itself"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database),
            count(&database, "SELECT COUNT(*) FROM agent_run")
        ),
        (1, 1, 1),
        "assertion automatic_recovery_adds_no_second_ledger_row_delivery_or_run"
    );
    // `blocked_reason` is only the mirror of the current state: the next ordinary pass finds the
    // reservation reachable, records exactly one recovery fact and clears it. Nothing is dispatched
    // again, because the queued Run already exists.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion the_resumed_work_is_never_dispatched_a_second_time"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion the_resumed_work_carries_no_current_failure"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![
            failure_fact("loom.dispatch_recipient_offline"),
            recovered_fact()
        ],
        "assertion the_resumed_work_records_one_recovery_fact"
    );
}

/// Freeze boundary: a queued Run keeps the device it was frozen to. A member who later points their
/// settings at another (here unreachable) device changes the *next* Run only; the claim of this Run
/// must still be judged by the target it already carries.
#[test]
fn a_queued_run_is_judged_by_its_frozen_device_not_by_a_later_member_switch() {
    let mut database = fixture();
    let (mission_id, _plan_id) = dispatchable_plan(
        &mut database,
        "dispatch frozen device",
        "command_approve_frozen_device",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    let frozen_installation = installation_of(&database, PRODUCER_AGENT);
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_reachable_plan_reserves_its_delivery"
    );
    let claimed = claim_mission_lane(&mut database, &camp_id, 1);
    assert_eq!(claimed.len(), 1, "assertion the_delivery_produces_one_run");
    let run_id = claimed[0].clone();
    let (dispatch_id, run_of_delivery) = dispatch_and_run(&database, "task_a");
    assert_eq!(
        run_of_delivery.as_deref(),
        Some(run_id.as_str()),
        "assertion the_run_belongs_to_this_dispatch"
    );
    let frozen_of_run: String = database
        .connection()
        .query_row(
            "SELECT runtime_installation_id FROM agent_run WHERE id=?1",
            [&run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        frozen_of_run, frozen_installation,
        "assertion the_run_froze_the_installation_it_started_on"
    );

    // The member now points their own settings at a second, unreachable installation.
    database
        .connection()
        .execute(
            "INSERT INTO adapter_installation(id,adapter_kind,executable_path,command_name,
                                              installation_class,source,auth_scope,enabled,
                                              generation,path_state,version,created_at,updated_at)
             VALUES('adapter-test-other','codex-cli','/nonexistent/codex','codex',
                    'managed_default','custom','test-user-other',1,1,'path_missing',1,?1,?1)",
            [chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE agent_profile SET default_runtime_installation_id='adapter-test-other'
             WHERE id=?1",
            [PRODUCER_AGENT],
        )
        .unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    assert_eq!(
        control::dispatch_block_reason(database.connection(), &dispatch_id, &now).unwrap(),
        None,
        "assertion the_queued_run_is_not_blocked_by_the_new_member_setting"
    );
    let claim = claim_the_run(&mut database, &camp_id, &run_id);
    assert_eq!(
        claim.result.status,
        crate::command::CommandResultStatus::Accepted,
        "assertion the_queued_run_starts_on_the_device_it_was_frozen_to: {:?}",
        claim.result
    );
    assert_eq!(
        run_status(&database, &run_id),
        "running",
        "assertion the_frozen_run_actually_started"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![],
        "assertion a_frozen_run_that_can_start_records_no_failure"
    );
}

/// Queued-Run boundary: the Delivery claim materialises the Run, so after that the outage happens in
/// front of the Run's own admission. Its failure and recovery are facts, recorded once, and the same
/// queued Run is the one that finally starts.
#[test]
fn a_queued_run_records_its_outage_once_and_the_same_run_starts_after_recovery() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch queued run outage",
        "command_approve_queued_run",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    let installation_id = installation_of(&database, PRODUCER_AGENT);
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 1);
    let claimed = claim_mission_lane(&mut database, &camp_id, 1);
    assert_eq!(claimed.len(), 1, "assertion the_delivery_produces_one_run");
    let run_id = claimed[0].clone();
    assert_eq!(
        run_status(&database, &run_id),
        "queued",
        "assertion the_materialised_run_waits_queued"
    );

    // The device disappears while the Run is still queued: the admission is refused, and the
    // refusal is the same recorded fact the scheduler writes for unstarted work.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    for tick in 0..3 {
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion a_queued_run_never_mints_a_second_dispatch (tick {tick})"
        );
    }
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion the_queued_run_outage_is_reported_as_presence"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![failure_fact("loom.dispatch_recipient_offline")],
        "assertion the_queued_run_outage_is_recorded_exactly_once"
    );
    let refused = claim_the_run(&mut database, &camp_id, &run_id);
    assert_eq!(
        refused.result.code, "agent_run.loom_control_blocked",
        "assertion the_outage_blocks_the_run_admission: {:?}",
        refused.result
    );
    assert_eq!(
        run_status(&database, &run_id),
        "queued",
        "assertion the_refused_run_stays_queued"
    );

    // The device is back: one recovery fact, and this very Run — the same identity, the same single
    // Delivery — is the one that starts.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion recovery_resumes_the_queued_run_instead_of_dispatching_again"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![
            failure_fact("loom.dispatch_recipient_offline"),
            recovered_fact()
        ],
        "assertion the_queued_run_records_one_recovery_fact"
    );
    let started = claim_the_run(&mut database, &camp_id, &run_id);
    assert_eq!(
        started.result.status,
        crate::command::CommandResultStatus::Accepted,
        "assertion the_same_queued_run_starts_after_recovery: {:?}",
        started.result
    );
    assert_eq!(
        run_status(&database, &run_id),
        "running",
        "assertion the_recovered_run_is_the_one_running"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database),
            count(&database, "SELECT COUNT(*) FROM agent_run")
        ),
        (1, 1, 1),
        "assertion recovery_adds_no_second_ledger_row_delivery_or_run"
    );
}

/// Priority boundary for the remote half of the ladder: a Node that is both unreachable and missing
/// the harness is an *unreachable device*, never a harness problem — presence is judged first, and
/// the catalog owner's own ordering cannot override that.
#[test]
fn an_unreachable_remote_node_outranks_its_missing_harness() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch remote priority",
        "command_approve_remote_priority",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    let stale = (chrono::Utc::now() - chrono::Duration::seconds(3600)).to_rfc3339();
    select_remote_node(
        &database,
        &camp_id,
        PRODUCER_AGENT,
        "node_remote",
        AdapterKind::CodexCli,
        &stale,
    );
    // Every fact is broken at once: the heartbeat is stale *and* the Node reports no usable CLI.
    database
        .connection()
        .execute(
            "UPDATE execution_node_cli SET path_present=0
             WHERE node_id='node_remote' AND adapter_kind='codex-cli'",
            [],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_unreachable_node_still_reserves_the_work"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion presence_outranks_the_harness_a_stale_node_cannot_be_trusted_to_report"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![failure_fact("loom.dispatch_recipient_offline")],
        "assertion only_the_presence_fact_is_recorded"
    );

    // A fresh heartbeat with the same missing CLI is a harness problem, because the device is now
    // reachable and only its harness is missing.
    let fresh = chrono::Utc::now().to_rfc3339();
    database
        .connection()
        .execute(
            "UPDATE execution_node SET last_heartbeat=?1 WHERE node_id='node_remote'",
            [&fresh],
        )
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_harness_unavailable"),
        "assertion a_reachable_node_is_judged_on_its_harness"
    );
}

/// Launch-intent boundary: Core admits a live Command Host by its installation identity even when
/// the disk entry has moved, and only the cold branch resolves that entry. Dispatch must not be
/// stricter than the launch it feeds, so a Command installation that is enabled but no longer
/// resolves on this host is still a device the work can start on.
#[test]
fn a_live_command_host_is_a_device_even_when_its_entry_moved() {
    let mut database = fixture();
    let (_mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch command host",
        "command_approve_command_host",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    database
        .connection()
        .execute(
            "INSERT INTO adapter_installation(id,adapter_kind,executable_path,command_name,
                                              installation_class,source,auth_scope,enabled,
                                              generation,path_state,version,created_at,updated_at)
             VALUES('adapter-test-command','command-code-cli','/moved/command-code','command-code',
                    'managed_default','custom','test-user',1,1,'path_missing',1,?1,?1)",
            [chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    database
        .connection()
        .execute(
            "UPDATE agent_profile
             SET selected_runtime_adapter_kind='command-code-cli',
                 default_runtime_installation_id='adapter-test-command'
             WHERE id=?1",
            [PRODUCER_AGENT],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion a_live_command_host_is_never_blocked_by_a_moved_entry"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion the_command_host_carries_no_failure"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![],
        "assertion a_live_command_host_writes_no_failure_fact"
    );

    // The same installation switched off is still the switch, not a moved entry.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET enabled=0 WHERE id='adapter-test-command'",
            [],
        )
        .unwrap();
    assert_eq!(control::admit_due_dispatches(&mut database).unwrap(), 0);
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a").as_deref(),
        Some("loom.dispatch_recipient_offline"),
        "assertion a_disabled_installation_is_unreachable_even_for_a_command_host"
    );
}

/// Admission-order boundary: "the device is gone" is an answer about an event that is otherwise
/// admissible, never a licence to skip the identity rules. A Candidate whose producer Run cannot be
/// resolved can never be reviewed, so a REVIEW that is also unreachable must not reserve a Delivery
/// for it: that Delivery would consume the budget, block the lane and never start, even after the
/// reviewer's device comes back. The device state must make no difference to the outcome.
#[test]
fn an_unreachable_device_cannot_reserve_work_the_identity_rules_refuse() {
    let mut database = fixture();
    let mission_id = create_mission(&mut database, "dispatch identity before device");
    plan_import(&mut database, plan_input(&mission_id)).unwrap();
    let plan_id: String = database
        .connection()
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| row.get(0),
        )
        .unwrap();
    let camp_id = camp_of(&database, &mission_id);
    seed_run(&database, &camp_id, PRODUCER_AGENT, PRODUCER_RUN);
    seed_run(&database, &camp_id, REVIEWER_AGENT, REVIEWER_RUN);
    control::configure(
        &mut database,
        OWNER,
        policy_input(
            &mission_id,
            "command_approve_identity_first",
            REVIEWER_AGENT,
        ),
    )
    .unwrap();
    // The delivery names a producing Run that no longer exists, so the self-review guard can never
    // be discharged for this Candidate.
    let (candidate_id, _manifest) =
        submitted_candidate(&mut database, &mission_id, "run_producer_gone");
    assert_eq!(
        task_state(&database, &mission_id, "task_a"),
        "IN_REVIEW",
        "assertion the_candidate_is_waiting_for_its_review"
    );
    assert_eq!(
        count(
            &database,
            "SELECT COUNT(*) FROM loom_candidate
             WHERE candidate_id='run_producer_gone' OR candidate_id<>'run_producer_gone'"
        ),
        1,
        "assertion exactly_one_candidate_is_under_review"
    );
    let reviewer_installation = installation_of(&database, REVIEWER_AGENT);

    // The reviewer's device is gone at the same time as the producer identity is broken.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&reviewer_installation],
        )
        .unwrap();
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion a_gone_device_cannot_admit_an_event_the_identity_rules_refuse"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database)
        ),
        (0, 0),
        "assertion the_refused_event_reserves_no_ledger_row_and_no_delivery"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![],
        "assertion an_identity_refusal_is_not_a_device_failure_fact"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion an_identity_refusal_writes_no_availability_mirror"
    );

    // The device comes back. The identity judgement is what refuses the event, so the outcome is
    // the same — the earlier refusal was never a device verdict that could be forgotten.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='valid' WHERE id=?1",
            [&reviewer_installation],
        )
        .unwrap();
    for tick in 0..2 {
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion a_reachable_device_still_cannot_reserve_an_unreviewable_event (tick {tick})"
        );
    }
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database)
        ),
        (0, 0),
        "assertion recovery_does_not_reserve_what_the_identity_rules_never_admitted"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![],
        "assertion no_failure_or_recovery_fact_is_invented_for_a_refused_event"
    );
    assert!(
        !candidate_id.is_empty(),
        "assertion the_refused_review_names_the_candidate_it_could_not_hand_out"
    );
}

/// Started-Run boundary, ported from upstream `recordFactoryDispatchFailure`, which returns `null`
/// for anything that is not still `queued`, and from
/// `dispatch-recovery.db.test.ts`'s "a claimed run is not a dispatch failure". Once a Run has
/// started, a device that disappears is an execution problem, not a dispatch problem: the LOOM
/// layer must not write `loom.dispatch_failed` or `loom.dispatch_recovered` for it, must not park
/// the Task with an availability reason, and must leave the claimed Delivery alone.
#[test]
fn a_run_that_already_started_is_never_a_dispatch_failure() {
    let mut database = fixture();
    let (mission_id, plan_id) = dispatchable_plan(
        &mut database,
        "dispatch started run",
        "command_approve_started_run",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    let installation_id = installation_of(&database, PRODUCER_AGENT);
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_reachable_plan_reserves_its_delivery"
    );
    let claimed = claim_mission_lane(&mut database, &camp_id, 1);
    assert_eq!(claimed.len(), 1, "assertion the_delivery_produces_one_run");
    let run_id = claimed[0].clone();
    let (dispatch_id, run_of_dispatch) = dispatch_and_run(&database, "task_a");
    assert_eq!(
        run_of_dispatch.as_deref(),
        Some(run_id.as_str()),
        "assertion the_run_belongs_to_this_dispatch"
    );
    let started = claim_the_run(&mut database, &camp_id, &run_id);
    assert_eq!(
        started.result.status,
        crate::command::CommandResultStatus::Accepted,
        "assertion the_queued_run_starts_while_its_device_is_present: {:?}",
        started.result
    );
    assert_eq!(
        run_status(&database, &run_id),
        "running",
        "assertion the_run_is_running_before_the_device_disappears"
    );

    // The device disappears after the Run started.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET path_state='path_missing' WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    for tick in 0..3 {
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion a_started_run_is_never_dispatched_again (tick {tick})"
        );
    }
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![],
        "assertion a_running_run_records_no_dispatch_failure_and_no_dispatch_recovery"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion a_running_run_is_not_parked_with_an_availability_reason"
    );
    let now = chrono::Utc::now().to_rfc3339();
    let reason = control::dispatch_block_reason(database.connection(), &dispatch_id, &now).unwrap();
    assert!(
        !matches!(
            reason.as_deref(),
            Some("loom.dispatch_recipient_disabled")
                | Some("loom.dispatch_recipient_offline")
                | Some("loom.dispatch_harness_unavailable")
        ),
        "assertion a_running_run_is_no_longer_judged_by_its_device: {reason:?}"
    );
    let (delivery_status, ledger_status): (String, String) = database
        .connection()
        .query_row(
            "SELECT delivery.status, dispatch.status
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             WHERE dispatch.dispatch_id=?1",
            [&dispatch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (delivery_status.as_str(), ledger_status.as_str()),
        ("claimed", "DISPATCHED"),
        "assertion the_started_work_keeps_its_claimed_delivery"
    );

    // A Run that already ended without writing its successor fact proves nothing either: the
    // ledger stays pending, and the ended Run is still not a dispatch failure.
    database
        .connection()
        .execute(
            "UPDATE agent_run SET status='succeeded', ended_at=?2 WHERE id=?1",
            params![&run_id, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    for tick in 0..3 {
        assert_eq!(
            control::admit_due_dispatches(&mut database).unwrap(),
            0,
            "assertion an_unproved_finished_run_is_never_dispatched_again (tick {tick})"
        );
    }
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![],
        "assertion an_ended_run_that_proved_nothing_is_not_a_dispatch_failure"
    );
    assert_eq!(
        task_blocked_reason(&database, &plan_id, "task_a"),
        None,
        "assertion an_ended_run_is_not_parked_with_an_availability_reason"
    );
    let ledger_after_end: String = database
        .connection()
        .query_row(
            "SELECT status FROM loom_control_dispatch WHERE dispatch_id=?1",
            [&dispatch_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        ledger_after_end, "DISPATCHED",
        "assertion an_unproved_outcome_is_never_read_as_a_settled_dispatch"
    );
}

/// Production launch order, ported from the review's remaining blocker: `dispatch_agent_run_candidate`
/// prepares the Runtime *before* the claim asks the control plane, and Core's preparation answers a
/// disabled installation with a terminal dispatch rejection. The control plane only ever wants such
/// a Run to wait, so the wait has to be decided before the Runtime is prepared. This drives the real
/// scheduler step — not the claim helper — and proves the Run is never failed: it stays `queued`
/// with its Delivery still `claimed`, and that very same Run starts once the device is back.
#[tokio::test]
async fn a_loom_dispatch_waits_for_the_device_before_the_runtime_is_prepared() {
    let mut database = fixture();
    let (mission_id, _plan_id) = dispatchable_plan(
        &mut database,
        "dispatch production order",
        "command_approve_production_order",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    // Production validates the Mission project directory before it prepares anything, so the
    // fixture states that precondition instead of relying on a path that only a Project would have.
    let project_path: String = database
        .connection()
        .query_row(
            "SELECT project_path FROM camp WHERE id=?1",
            [&camp_id],
            |row| row.get(0),
        )
        .unwrap();
    std::fs::create_dir_all(&project_path).unwrap();
    let installation_id = installation_of(&database, PRODUCER_AGENT);

    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_approved_work_is_reserved"
    );
    let claimed = claim_mission_lane(&mut database, &camp_id, 1);
    assert_eq!(
        claimed.len(),
        1,
        "assertion the_reservation_materialises_one_run"
    );
    let run_id = claimed[0].clone();
    assert_eq!(
        run_status(&database, &run_id),
        "queued",
        "assertion the_materialised_run_waits_queued"
    );

    // The device disappears after the Run was materialised but before the scheduler prepared it.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET enabled=0 WHERE id=?1",
            [&installation_id],
        )
        .unwrap();

    let directory = database.directory().to_path_buf();
    database.close();
    let database = Database::open(&directory).expect("the fixture database must reopen");
    crate::application::dispatch_queued_run_for_test(&directory, database, &run_id)
        .await
        .expect("one scheduler step must be runnable");

    // Nothing started and nothing failed: an unavailable device is a wait, never a terminal answer.
    let database = Database::open(&directory).expect("the fixture database must reopen");
    assert_eq!(
        run_status(&database, &run_id),
        "queued",
        "assertion an_unavailable_device_leaves_the_run_queued"
    );
    let (delivery_status, delivery_run, dispatch_status): (String, Option<String>, String) =
        database
            .connection()
            .query_row(
                "SELECT delivery.status, delivery.claimed_agent_run_id, dispatch.status
                 FROM loom_control_dispatch AS dispatch
                 JOIN camp_message_delivery AS delivery ON delivery.id = dispatch.delivery_id
                 WHERE dispatch.task_id='task_a'
                 ORDER BY dispatch.created_at, dispatch.dispatch_id LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
    assert_eq!(
        (
            delivery_status.as_str(),
            delivery_run.as_deref(),
            dispatch_status.as_str()
        ),
        ("claimed", Some(run_id.as_str()), "DISPATCHED"),
        "assertion the_queued_run_keeps_its_claimed_delivery_and_pending_dispatch"
    );
    let terminal: i64 = database
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM event_log
             WHERE entity_type='agent_run' AND entity_id=?1
               AND event_type IN ('agent_run.failed','agent_run.dispatch_rejected')",
            [&run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        terminal, 0,
        "assertion preparation_never_rejects_a_waiting_loom_dispatch"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database),
            count(&database, "SELECT COUNT(*) FROM agent_run")
        ),
        (1, 1, 1),
        "assertion waiting_starts_nothing_and_mints_nothing"
    );

    // The device comes back: the same scheduler step starts this very Run, once.
    database
        .connection()
        .execute(
            "UPDATE adapter_installation SET enabled=1 WHERE id=?1",
            [&installation_id],
        )
        .unwrap();
    drop(database);
    let database = Database::open(&directory).expect("the fixture database must reopen");
    crate::application::dispatch_queued_run_for_test(&directory, database, &run_id)
        .await
        .expect("the recovered scheduler step must be runnable");

    let database = Database::open(&directory).expect("the fixture database must reopen");
    assert_eq!(
        run_status(&database, &run_id),
        "running",
        "assertion the_same_run_starts_once_the_device_is_back"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database),
            count(&database, "SELECT COUNT(*) FROM agent_run")
        ),
        (1, 1, 1),
        "assertion recovery_adds_no_second_ledger_row_delivery_or_run"
    );
}

/// A remote process transport that is installed but never starts anything: the claim of a real
/// remote Run is the last thing a scheduler step does, so this keeps the Run at the state the
/// dispatch reached instead of letting a launch settle it.
struct NeverStartingRemoteLauncher;

impl crate::remote_process::RemoteProcessLauncher for NeverStartingRemoteLauncher {
    fn start(
        &self,
        _launch: crate::remote_process::ScopedRemoteLaunch,
    ) -> crate::remote_process::RemoteFuture<'_, crate::remote_process::RemoteProcess> {
        Box::pin(std::future::pending())
    }
}

/// Remote boundary of the same production order: a Node is the device, and its harness is reported
/// in the catalog the dispatch re-validates *before* the Runtime is prepared. A Node that stops
/// reporting its harness therefore has to be a wait, not the terminal rejection Core's own remote
/// target revalidation would answer with. This drives the real scheduler step on a real remote
/// queued Run — materialised by the real Delivery claim with the real bundle capture — and proves
/// the Run keeps its identity, its Delivery and its target across the outage, then starts on the
/// same facts once the Node reports the harness again.
#[tokio::test]
async fn a_remote_queued_run_waits_for_its_harness_instead_of_being_rejected() {
    let mut database = fixture();
    let (mission_id, _plan_id) = dispatchable_plan(
        &mut database,
        "dispatch remote wait",
        "command_approve_remote_wait",
        &[PRODUCER_AGENT, REVIEWER_AGENT],
        &[],
    );
    let camp_id = camp_of(&database, &mission_id);
    let fresh = chrono::Utc::now().to_rfc3339();
    select_remote_node(
        &database,
        &camp_id,
        PRODUCER_AGENT,
        "node_remote",
        AdapterKind::CodexCli,
        &fresh,
    );
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        1,
        "assertion the_reachable_node_reserves_the_approved_work"
    );

    // The real claim materialises the Run and freezes its Node, workspace and bundle source.
    let directory = database.directory().to_path_buf();
    let store = crate::mcp::McpConfigStore::new(directory.join("fixture-mcp.json"));
    let context = crate::remote_bundle_owner::RemoteBundleCaptureContext {
        data_dir: &directory,
        mcp_store: &store,
    };
    let claimed = crate::delivery_queue::claim_waiting_delivery_batches_with_sources(
        &mut database,
        1,
        &Default::default(),
        Some(&context),
    )
    .expect("the real remote claim must materialise the queued Run");
    assert_eq!(
        claimed.len(),
        1,
        "assertion the_reserved_delivery_materialises_one_run"
    );
    let run_id = claimed[0].clone();
    assert_eq!(
        run_status(&database, &run_id),
        "queued",
        "assertion the_materialised_remote_run_waits_queued"
    );
    let frozen = crate::remote_execution::load_run_target(database.connection(), &run_id)
        .expect("the frozen target must be readable")
        .expect("a remote claim must freeze its Node target");
    assert_eq!(
        frozen.target.node_id, "node_remote",
        "assertion the_run_is_frozen_to_the_selected_node"
    );
    let (dispatch_id, delivery_id): (String, String) = database
        .connection()
        .query_row(
            "SELECT dispatch_id, delivery_id FROM loom_control_dispatch WHERE task_id='task_a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    // The Node stops reporting the harness it will run. Core's own remote target revalidation
    // answers that with a code, and a dispatch must not turn that code into a failed Run.
    database
        .connection()
        .execute(
            "UPDATE execution_node_cli SET path_present=0
             WHERE node_id='node_remote' AND adapter_kind='codex-cli'",
            [],
        )
        .unwrap();

    database.close();
    let database = Database::open(&directory).expect("the fixture database must reopen");
    crate::application::dispatch_queued_run_for_test(&directory, database, &run_id)
        .await
        .expect("one scheduler step must be runnable");

    let mut database = Database::open(&directory).expect("the fixture database must reopen");
    assert_eq!(
        run_status(&database, &run_id),
        "queued",
        "assertion a_node_that_stopped_reporting_its_harness_leaves_the_run_queued"
    );
    let (delivery_status, delivery_run, dispatch_status): (String, Option<String>, String) =
        database
            .connection()
            .query_row(
                "SELECT delivery.status, delivery.claimed_agent_run_id, dispatch.status
                 FROM loom_control_dispatch AS dispatch
                 JOIN camp_message_delivery AS delivery ON delivery.id = dispatch.delivery_id
                 WHERE dispatch.dispatch_id=?1",
                [&dispatch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
    assert_eq!(
        (
            delivery_status.as_str(),
            delivery_run.as_deref(),
            dispatch_status.as_str()
        ),
        ("claimed", Some(run_id.as_str()), "DISPATCHED"),
        "assertion the_remote_run_keeps_its_claimed_delivery_and_pending_dispatch"
    );
    let terminal: i64 = database
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM event_log
             WHERE entity_type='agent_run' AND entity_id=?1
               AND event_type IN ('agent_run.failed','agent_run.dispatch_rejected')",
            [&run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        terminal, 0,
        "assertion a_missing_remote_harness_never_terminally_rejects_the_run"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database),
            count(&database, "SELECT COUNT(*) FROM agent_run")
        ),
        (1, 1, 1),
        "assertion waiting_for_a_remote_harness_starts_and_mints_nothing"
    );
    let (delivery_row, ledger_row): (String, String) = database
        .connection()
        .query_row(
            "SELECT delivery.id, dispatch.delivery_id
             FROM loom_control_dispatch AS dispatch
             JOIN camp_message_delivery AS delivery ON delivery.id = dispatch.delivery_id
             WHERE dispatch.dispatch_id=?1",
            [&dispatch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (delivery_row.as_str(), ledger_row.as_str()),
        (delivery_id.as_str(), delivery_id.as_str()),
        "assertion the_waiting_remote_run_keeps_the_reservation_it_started_with"
    );
    // The ordinary pass of the same control plane records the outage of the reserved work, once,
    // without admitting a second dispatch of it.
    assert_eq!(
        control::admit_due_dispatches(&mut database).unwrap(),
        0,
        "assertion waiting_for_the_remote_harness_is_not_a_second_dispatch"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![failure_fact("loom.dispatch_harness_unavailable")],
        "assertion the_remote_outage_is_recorded_as_the_harness_fact_once"
    );

    // The Node reports the harness again: the same Run is the one the scheduler claims, on the Node
    // and Delivery it already had.
    database
        .connection()
        .execute(
            "UPDATE execution_node_cli SET path_present=1
             WHERE node_id='node_remote' AND adapter_kind='codex-cli'",
            [],
        )
        .unwrap();
    drop(database);
    let database = Database::open(&directory).expect("the fixture database must reopen");
    crate::application::dispatch_queued_run_with_remote_launcher_for_test(
        &directory,
        database,
        &run_id,
        Some(std::sync::Arc::new(NeverStartingRemoteLauncher)),
    )
    .await
    .expect("the recovered scheduler step must be runnable");

    let database = Database::open(&directory).expect("the fixture database must reopen");
    assert_eq!(
        run_status(&database, &run_id),
        "running",
        "assertion the_same_remote_run_starts_once_the_harness_is_reported"
    );
    assert_eq!(
        (
            count(&database, "SELECT COUNT(*) FROM loom_control_dispatch"),
            loom_deliveries(&database),
            count(&database, "SELECT COUNT(*) FROM agent_run")
        ),
        (1, 1, 1),
        "assertion remote_recovery_adds_no_second_ledger_row_delivery_or_run"
    );
    assert_eq!(
        dispatch_events(&database, "task_a"),
        vec![failure_fact("loom.dispatch_harness_unavailable")],
        "assertion the_remote_outage_keeps_its_single_fact_after_recovery"
    );
}
