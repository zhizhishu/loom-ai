//! LOOM control plane: the persistent automation authority of one Plan.
//!
//! Three facts live here and nowhere else:
//!
//! * an **approved policy** — who approved it, which Tasks may run unattended, which agent
//!   reviews each Task, and the dispatch/rework budget;
//! * an **assistant stage verdict** — one immutable record per `(candidate, policy revision)`,
//!   deliberately not a [`crate::loom::LoomReview`]: `pass` only ends the internal stage and
//!   never marks the Candidate `ACCEPTED`, never moves a Task to `DONE` and never releases a
//!   `TASK_DONE`/`ARTIFACT_ACCEPTED` dependency. The Owner's final review stays in
//!   `loom.review.record` and is the only path that can accept;
//! * a **dispatch ledger** — the association between a Task and the Delivery that carries it,
//!   plus the budget the policy is spent against. Rows are permanent, so re-approving a policy
//!   cannot reset what earlier revisions already consumed.
//!
//! Every write is one `IMMEDIATE` transaction whose clock is read after the write lock, so a
//! verdict is never stamped with an instant that predates the state it judged.

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use super::{
    LOOM_ACCEPTANCE_CRITERIA_EMPTY, LOOM_CANDIDATE_NOT_FOUND, LOOM_EVIDENCE_NOT_FOUND,
    LOOM_INVALID_INPUT, LOOM_MISSION_NOT_FOUND, LOOM_PLAN_NOT_FOUND, LOOM_TASK_NOT_FOUND,
    LOOM_TASK_NOT_IN_REVIEW, LoomAcceptanceCriterion, LoomAcceptanceCriterionResult,
    LoomCommandError, LoomTaskStatus, criteria_snapshot, required_field, scoped_mission,
};
use crate::current_user::CURRENT_USER_ID;
use crate::db::Database;

#[path = "dispatch.rs"]
mod dispatch;
pub use dispatch::admit_due_dispatches;
pub(crate) use dispatch::{
    LoomTickOutcome, admit_due_dispatches_at, dispatch_block_reason, reconcile_completed_run_at,
    record_verification_mismatch, request_epoch,
};

/// Only the real Owner may grant or pause the authority. There is no other identity that can
/// approve unattended work, so a stolen or forged payload cannot become an approval.
const LOOM_CONTROL_NOT_AUTHORIZED: &str = "LOOM_CONTROL_NOT_AUTHORIZED";
/// Automation stays off until an approved policy exists; an absent row is the default.
const LOOM_CONTROL_POLICY_NOT_FOUND: &str = "LOOM_CONTROL_POLICY_NOT_FOUND";
const LOOM_CONTROL_DISABLED: &str = "LOOM_CONTROL_DISABLED";
/// A compare-and-set on `revision` failed: the caller judged an older approval than the one
/// that stands, and old approvals never carry over to a new revision.
const LOOM_CONTROL_REVISION_CONFLICT: &str = "LOOM_CONTROL_REVISION_CONFLICT";
/// The same `commandId` was reused for a different request.
const LOOM_CONTROL_COMMAND_REUSED: &str = "LOOM_CONTROL_COMMAND_REUSED";
const LOOM_CONTROL_TASK_INVALID: &str = "LOOM_CONTROL_TASK_INVALID";
const LOOM_CONTROL_REVIEWER_INVALID: &str = "LOOM_CONTROL_REVIEWER_INVALID";
const LOOM_CONTROL_REVIEWER_SELF: &str = "LOOM_CONTROL_REVIEWER_SELF";
const LOOM_CONTROL_EXPIRES_INVALID: &str = "LOOM_CONTROL_EXPIRES_INVALID";
/// A paused policy blocks the next step without spending the approval it was paused under.
const LOOM_CONTROL_PAUSED: &str = "LOOM_CONTROL_PAUSED";
const LOOM_CONTROL_EXPIRED: &str = "LOOM_CONTROL_EXPIRED";
/// One Candidate carries at most one stage verdict per policy revision.
const LOOM_STAGE_REVIEW_EXISTS: &str = "LOOM_STAGE_REVIEW_EXISTS";
const LOOM_STAGE_REVIEW_REPLAY_CONFLICT: &str = "LOOM_STAGE_REVIEW_REPLAY_CONFLICT";
/// The manifest the reviewer judged is not the manifest the Candidate currently has: either the
/// payload invented a hash, or the Candidate/its artifacts moved since it was read.
const LOOM_STAGE_MANIFEST_MISMATCH: &str = "LOOM_STAGE_MANIFEST_MISMATCH";
const LOOM_STAGE_CANDIDATE_STALE: &str = "LOOM_STAGE_CANDIDATE_STALE";
const LOOM_STAGE_REVIEWER_RUN_INVALID: &str = "LOOM_STAGE_REVIEWER_RUN_INVALID";
/// The reviewing Run is not an independent observer: it shares the Agent session that produced a
/// delivery of this Task, or it continues (or is continued by) a Run that delivered one.
const LOOM_STAGE_REVIEWER_SESSION_SHARED: &str = "LOOM_STAGE_REVIEWER_SESSION_SHARED";
/// The verdict does not come from the Run this Candidate's review was dispatched to.
const LOOM_STAGE_REVIEW_SOURCE_UNBOUND: &str = "LOOM_STAGE_REVIEW_SOURCE_UNBOUND";
const LOOM_STAGE_CRITERIA_INCOMPLETE: &str = "LOOM_STAGE_CRITERIA_INCOMPLETE";

const MAX_DISPATCH_BUDGET: i64 = 1000;
const MAX_REWORKS_PER_TASK: i64 = 20;

/// One Task's review assignment. The reviewer is an agent, never the Owner: the Owner's own
/// verdict stays a separate, later act.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomReviewerAssignment {
    pub task_id: String,
    pub reviewer_agent_id: String,
}

/// The Owner's approval of unattended work on one Plan.
///
/// `expected_revision` is the compare-and-set: `0` means "there is no policy yet", anything else
/// must equal the standing revision, so a command written against an older approval cannot
/// silently overwrite a newer one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomControlPolicyInput {
    pub mission_id: String,
    pub command_id: String,
    pub expected_revision: i64,
    pub enabled: bool,
    pub task_ids: Vec<String>,
    pub reviewers: Vec<LoomReviewerAssignment>,
    pub max_dispatches: i64,
    pub max_reworks_per_task: i64,
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// The standing approval, as stored. `paused` is part of the authority rather than of the
/// configuration: pausing and resuming keep the same `revision`, so resuming spends the approval
/// that was granted instead of minting a new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomControlPolicy {
    pub mission_id: String,
    pub plan_id: String,
    /// The optimistic-concurrency counter of the row. It advances on every accepted command,
    /// including pause and resume, so a request written against an older reading is refused.
    pub revision: i64,
    /// The version of the *grant*. It advances only when the Owner approves a configuration, so
    /// pausing and resuming cannot launder the standing approval into a new one and cannot
    /// invalidate a reviewer that was assigned under it.
    pub authorization_revision: i64,
    pub enabled: bool,
    pub paused: bool,
    pub task_ids: Vec<String>,
    pub reviewers: Vec<LoomReviewerAssignment>,
    pub max_dispatches: i64,
    pub max_reworks_per_task: i64,
    pub expires_at: Option<String>,
    pub approved_by: String,
    pub approved_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomControlPauseInput {
    pub mission_id: String,
    pub command_id: String,
    pub expected_revision: i64,
    pub paused: bool,
}

/// What the internal stage concluded about one Candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoomStageVerdict {
    /// The internal stage passed. It does not accept the Candidate and does not finish the Task.
    Pass,
    /// The delivery needs rework: the Task returns to `READY` so a new Run can deliver again.
    RequestChanges,
    /// The Task cannot proceed: it is parked as `BLOCKED` with the reason the reviewer gave.
    Blocked,
}

impl LoomStageVerdict {
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "PASS" => Ok(Self::Pass),
            "REQUEST_CHANGES" => Ok(Self::RequestChanges),
            "BLOCKED" => Ok(Self::Blocked),
            other => anyhow::bail!("LOOM stage review has an unknown verdict {other}"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::RequestChanges => "REQUEST_CHANGES",
            Self::Blocked => "BLOCKED",
        }
    }
}

/// An immutable assistant verdict on one Candidate under one policy revision.
///
/// `reviewerAgentId`/`reviewerAgentRunId` are the trusted identities the Host injected, not
/// payload claims, and `manifestHash` is the hash *the Core* computed over the Candidate and the
/// artifacts it cites — so a reviewer cannot judge bytes it never saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomStageReview {
    pub stage_review_id: String,
    pub task_id: String,
    pub candidate_id: String,
    pub reviewer_agent_id: String,
    pub reviewer_agent_run_id: String,
    pub policy_revision: i64,
    pub manifest_hash: String,
    pub verdict: LoomStageVerdict,
    pub reason: String,
    pub criteria_results: Vec<LoomAcceptanceCriterionResult>,
    pub reviewed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomStageReviewInput {
    pub task_id: String,
    pub candidate_id: String,
    pub policy_revision: i64,
    pub manifest_hash: String,
    pub verdict: LoomStageVerdict,
    pub reason: String,
    #[serde(default)]
    pub criteria_results: Vec<LoomAcceptanceCriterionResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomStageReviewRecordResult {
    pub review: LoomStageReview,
    pub task_status: LoomTaskStatus,
    pub replayed: bool,
}

/// The kind of work a dispatch asks another Run to perform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoomDispatchKind {
    Execute,
    Review,
    Rework,
    Handoff,
}

impl LoomDispatchKind {
    #[allow(dead_code)]
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "EXECUTE" => Ok(Self::Execute),
            "REVIEW" => Ok(Self::Review),
            "REWORK" => Ok(Self::Rework),
            "HANDOFF" => Ok(Self::Handoff),
            other => anyhow::bail!("LOOM dispatch has an unknown kind {other}"),
        }
    }

    #[allow(dead_code)]
    fn as_str(self) -> &'static str {
        match self {
            Self::Execute => "EXECUTE",
            Self::Review => "REVIEW",
            Self::Rework => "REWORK",
            Self::Handoff => "HANDOFF",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoomDispatchStatus {
    Waiting,
    Dispatched,
    Settled,
    Blocked,
    Cancelled,
}

impl LoomDispatchStatus {
    #[allow(dead_code)]
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "WAITING" => Ok(Self::Waiting),
            "DISPATCHED" => Ok(Self::Dispatched),
            "SETTLED" => Ok(Self::Settled),
            "BLOCKED" => Ok(Self::Blocked),
            "CANCELLED" => Ok(Self::Cancelled),
            other => anyhow::bail!("LOOM dispatch has an unknown status {other}"),
        }
    }

    #[allow(dead_code)]
    fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "WAITING",
            Self::Dispatched => "DISPATCHED",
            Self::Settled => "SETTLED",
            Self::Blocked => "BLOCKED",
            Self::Cancelled => "CANCELLED",
        }
    }
}

/// One row of the dispatch ledger: which Delivery carried which Task for which policy revision.
/// `deliveryId` stays null until the scheduling line attaches the Delivery it actually wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomDispatch {
    pub dispatch_id: String,
    pub task_id: String,
    pub kind: LoomDispatchKind,
    pub candidate_id: Option<String>,
    pub policy_revision: i64,
    pub recipient_agent_id: String,
    pub delivery_id: Option<String>,
    pub status: LoomDispatchStatus,
    pub reason: Option<String>,
    pub created_at: String,
}

/// Everything the control plane knows about one Mission, read from the same instant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomControlSnapshot {
    pub mission_id: String,
    /// `None` means no approved policy exists (legacy data, no independent reviewer, or a pre-plan Mission).
    pub policy: Option<LoomControlPolicy>,
    pub stage_reviews: Vec<LoomStageReview>,
    pub dispatches: Vec<LoomDispatch>,
    pub evaluated_at: String,
}

/// The control plane of one Mission. A Mission without a plan is not an error here — it simply
/// has no policy, no stage reviews and no dispatches yet.
pub fn get(database: &Database, mission_id: &str) -> Result<LoomControlSnapshot> {
    let mission_id = scoped_mission(mission_id)?;
    let connection = database.connection();
    let evaluated_at = chrono::Utc::now().to_rfc3339();
    ensure_mission_exists(connection, mission_id)?;
    let plan_id: Option<String> = connection
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [mission_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(plan_id) = plan_id else {
        return Ok(LoomControlSnapshot {
            mission_id: mission_id.to_string(),
            policy: None,
            stage_reviews: Vec::new(),
            dispatches: Vec::new(),
            evaluated_at,
        });
    };
    Ok(LoomControlSnapshot {
        mission_id: mission_id.to_string(),
        policy: read_policy(connection, &plan_id)?,
        stage_reviews: read_stage_reviews(connection, &plan_id)?,
        dispatches: read_dispatches(connection, &plan_id)?,
        evaluated_at,
    })
}

/// Approve (or re-approve) the automation policy of one Plan.
///
/// Only the real Owner can call this: `trusted_user_id` is injected by the Host from the trusted
/// identity and is compared with the current user, so a payload cannot nominate its own approver.
/// Every accepted change advances `revision`, and `paused` is preserved — an approval cannot
/// un-pause work the Owner stopped, and re-approving starts from what previous revisions already
/// consumed because the dispatch ledger is never reset.
pub fn configure(
    database: &mut Database,
    trusted_user_id: &str,
    input: LoomControlPolicyInput,
) -> Result<LoomControlSnapshot> {
    ensure_owner(trusted_user_id)?;
    let mission_id = required_field("control configure", "missionId", &input.mission_id)?;
    let command_id = required_field("control configure", "commandId", &input.command_id)?;
    let request_json = serde_json::to_string(&serde_json::json!({
        "kind": "CONFIGURE",
        "trustedUserId": trusted_user_id,
        "input": &input,
    }))?;

    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = chrono::Utc::now().to_rfc3339();

    if let Some(response_json) =
        replay_command(&transaction, &command_id, "CONFIGURE", &request_json)?
    {
        let snapshot: LoomControlSnapshot = serde_json::from_str(&response_json)
            .context("a recorded LOOM control response is not a snapshot")?;
        return Ok(snapshot);
    }

    ensure_mission_exists(&transaction, &mission_id)?;
    let plan_id = plan_id_of(&transaction, &mission_id)?;

    let task_ids = normalized_task_ids(&input.task_ids)?;
    let reviewers = validated_reviewers(&transaction, &mission_id, &plan_id, &task_ids, &input)?;
    if !(1..=MAX_DISPATCH_BUDGET).contains(&input.max_dispatches) {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            format!(
                "maxDispatches must be between 1 and {MAX_DISPATCH_BUDGET}, not {}",
                input.max_dispatches
            ),
        ));
    }
    if !(0..=MAX_REWORKS_PER_TASK).contains(&input.max_reworks_per_task) {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            format!(
                "maxReworksPerTask must be between 0 and {MAX_REWORKS_PER_TASK}, not {}",
                input.max_reworks_per_task
            ),
        ));
    }
    let expires_at = validated_expiry(input.expires_at.as_deref(), input.enabled, &now)?;

    let standing: Option<(i64, i64, bool)> = transaction
        .query_row(
            "SELECT revision, authorization_revision, paused FROM loom_control_policy
             WHERE plan_id=?1",
            [&plan_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (revision, authorization_revision, paused) = match standing {
        Some((revision, authorization_revision, paused)) => {
            // The personal-edition default seeded with the first Plan is not an explicit Owner
            // command. Let the Owner's first explicit `expectedRevision: 0` approval replace it;
            // once any CONFIGURE command exists, normal compare-and-set rules apply unchanged.
            let explicit_configure_exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM loom_control_command
                               WHERE plan_id=?1 AND kind='CONFIGURE')",
                [&plan_id],
                |row| row.get(0),
            )?;
            let replacing_seeded_default =
                input.expected_revision == 0 && !explicit_configure_exists;
            if revision != input.expected_revision && !replacing_seeded_default {
                return Err(LoomCommandError::rejection(
                    LOOM_CONTROL_REVISION_CONFLICT,
                    format!(
                        "plan {plan_id} stands at policy revision {revision}, not the expected {}",
                        input.expected_revision
                    ),
                ));
            }
            (revision + 1, authorization_revision + 1, paused)
        }
        None => {
            if input.expected_revision != 0 {
                return Err(LoomCommandError::rejection(
                    LOOM_CONTROL_REVISION_CONFLICT,
                    format!(
                        "plan {plan_id} has no policy, so the expected revision must be 0, not {}",
                        input.expected_revision
                    ),
                ));
            }
            (1, 1, false)
        }
    };

    let enabled = if input.enabled { 1i64 } else { 0i64 };
    let paused = if paused { 1i64 } else { 0i64 };
    transaction.execute(
        "INSERT INTO loom_control_policy(plan_id,mission_id,revision,authorization_revision,
                                        enabled,paused,task_ids_json,reviewers_json,
                                        max_dispatches,max_reworks_per_task,expires_at,
                                        approved_by,approved_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
         ON CONFLICT(plan_id) DO UPDATE SET
             mission_id=excluded.mission_id,
             revision=excluded.revision,
             authorization_revision=excluded.authorization_revision,
             enabled=excluded.enabled,
             task_ids_json=excluded.task_ids_json,
             reviewers_json=excluded.reviewers_json,
             max_dispatches=excluded.max_dispatches,
             max_reworks_per_task=excluded.max_reworks_per_task,
             expires_at=excluded.expires_at,
             approved_by=excluded.approved_by,
             approved_at=excluded.approved_at,
             updated_at=excluded.updated_at",
        params![
            &plan_id,
            &mission_id,
            revision,
            authorization_revision,
            enabled,
            paused,
            serde_json::to_string(&task_ids)?,
            serde_json::to_string(&reviewers)?,
            input.max_dispatches,
            input.max_reworks_per_task,
            expires_at.as_deref(),
            trusted_user_id,
            &now,
        ],
    )?;

    let snapshot = snapshot_in_transaction(&transaction, &mission_id, &plan_id, &now)?;
    record_command(
        &transaction,
        &command_id,
        &plan_id,
        "CONFIGURE",
        &request_json,
        &serde_json::to_string(&snapshot)?,
        &now,
    )?;
    transaction.commit()?;
    Ok(snapshot)
}

/// Stop or resume a standing approval without minting a new one.
///
/// The compare-and-set is on `revision`, but `revision` does not advance: pausing is not a new
/// grant, so resuming must spend the approval that still stands. Nothing else in the policy moves.
pub fn pause(
    database: &mut Database,
    trusted_user_id: &str,
    input: LoomControlPauseInput,
) -> Result<LoomControlSnapshot> {
    ensure_owner(trusted_user_id)?;
    let mission_id = required_field("control pause", "missionId", &input.mission_id)?;
    let command_id = required_field("control pause", "commandId", &input.command_id)?;
    let request_json = serde_json::to_string(&serde_json::json!({
        "kind": "PAUSE",
        "trustedUserId": trusted_user_id,
        "input": &input,
    }))?;

    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = chrono::Utc::now().to_rfc3339();

    if let Some(response_json) = replay_command(&transaction, &command_id, "PAUSE", &request_json)?
    {
        let snapshot: LoomControlSnapshot = serde_json::from_str(&response_json)
            .context("a recorded LOOM control response is not a snapshot")?;
        return Ok(snapshot);
    }

    ensure_mission_exists(&transaction, &mission_id)?;
    let plan_id = plan_id_of(&transaction, &mission_id)?;
    let revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM loom_control_policy WHERE plan_id=?1",
            [&plan_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(revision) = revision else {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_POLICY_NOT_FOUND,
            format!("plan {plan_id} has no approved policy to pause"),
        ));
    };
    if revision != input.expected_revision {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVISION_CONFLICT,
            format!(
                "plan {plan_id} stands at policy revision {revision}, not the expected {}",
                input.expected_revision
            ),
        ));
    }

    transaction.execute(
        "UPDATE loom_control_policy SET paused=?1, revision=revision+1, updated_at=?2
         WHERE plan_id=?3",
        params![if input.paused { 1i64 } else { 0i64 }, &now, &plan_id],
    )?;

    let snapshot = snapshot_in_transaction(&transaction, &mission_id, &plan_id, &now)?;
    record_command(
        &transaction,
        &command_id,
        &plan_id,
        "PAUSE",
        &request_json,
        &serde_json::to_string(&snapshot)?,
        &now,
    )?;
    transaction.commit()?;
    Ok(snapshot)
}

/// Record the internal stage verdict on one Candidate.
///
/// Everything that makes the verdict trustworthy is derived here, not taken from the payload:
/// the reviewer identity comes from the trusted Run the Host resolved, the reviewed manifest is
/// re-hashed from the stored Candidate and its artifacts, and the policy revision and reviewer
/// assignment must be the ones that stand. A `pass` ends only the internal stage; `request_changes`
/// sends the Task back to `READY` under a new Run and leaves the old Candidate `PENDING`;
/// `blocked` parks the Task and stops it.
#[allow(clippy::too_many_arguments)]
pub fn stage_review_record(
    database: &mut Database,
    mission_id: &str,
    trusted_agent_id: &str,
    trusted_run_id: &str,
    command_id: &str,
    input: LoomStageReviewInput,
) -> Result<LoomStageReviewRecordResult> {
    let mission_id = required_field("stage review", "missionId", mission_id)?;
    let trusted_agent_id = required_field("stage review", "reviewerAgentId", trusted_agent_id)?;
    let trusted_run_id = required_field("stage review", "reviewerAgentRunId", trusted_run_id)?;
    let command_id = required_field("stage review", "commandId", command_id)?;
    let task_id = required_field("stage review", "taskId", &input.task_id)?;
    let candidate_id = required_field("stage review", "candidateId", &input.candidate_id)?;
    let manifest_hash = required_field("stage review", "manifestHash", &input.manifest_hash)?;
    let reason = required_field("stage review", "reason", &input.reason)?;
    let verdict = input.verdict;
    let policy_revision = input.policy_revision;
    let criteria_results = input.criteria_results;
    validate_stage_review_shape(
        &task_id,
        &candidate_id,
        &manifest_hash,
        &reason,
        policy_revision,
        &criteria_results,
    )?;

    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    // The clock is read after the write lock: a policy that expired while this command waited
    // for the lock is expired, not still live.
    let reviewed_at = chrono::Utc::now().to_rfc3339();

    if let Some(stored) = read_stage_review_by_command(&transaction, &command_id)? {
        let same_request = stored.mission_id == mission_id
            && stored.task_id() == task_id.as_str()
            && stored.candidate_id() == candidate_id.as_str()
            && stored.reviewer_agent_id() == trusted_agent_id.as_str()
            && stored.reviewer_agent_run_id() == trusted_run_id.as_str()
            && stored.policy_revision() == policy_revision
            && stored.manifest_hash() == manifest_hash.as_str()
            && stored.verdict() == verdict
            && stored.reason() == reason.as_str()
            && stored.criteria_results() == criteria_results.as_slice();
        if !same_request {
            return Err(LoomCommandError::rejection(
                LOOM_STAGE_REVIEW_REPLAY_CONFLICT,
                format!(
                    "command {command_id} already recorded stage review {} for a different request",
                    stored.review.stage_review_id
                ),
            ));
        }
        // A replay reports the outcome this verdict produced, not whatever the Task looks like
        // now: the Task may have moved on since (a rework was delivered, the User accepted), and a
        // replayed command must not appear to have caused that.
        let status = match stored.verdict() {
            LoomStageVerdict::Pass => LoomTaskStatus::InReview,
            LoomStageVerdict::RequestChanges => LoomTaskStatus::Ready,
            LoomStageVerdict::Blocked => LoomTaskStatus::Blocked,
        };
        transaction.commit()?;
        return Ok(LoomStageReviewRecordResult {
            review: stored.review,
            task_status: status,
            replayed: true,
        });
    }

    ensure_mission_exists(&transaction, &mission_id)?;
    let plan_id = plan_id_of(&transaction, &mission_id)?;
    let policy = read_policy(&transaction, &plan_id)?.ok_or_else(|| {
        LoomCommandError::rejection(
            LOOM_CONTROL_POLICY_NOT_FOUND,
            format!("mission {mission_id} has no approved automation policy"),
        )
    })?;
    if !policy.enabled {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_DISABLED,
            format!("plan {plan_id} has automation disabled"),
        ));
    }
    if policy.paused {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_PAUSED,
            format!("plan {plan_id} is paused; no further step may run"),
        ));
    }
    let expires_at = policy.expires_at.as_deref().ok_or_else(|| {
        LoomCommandError::rejection(
            LOOM_CONTROL_EXPIRED,
            format!("plan {plan_id} has no future expiry, so nothing may run unattended"),
        )
    })?;
    if !expiry_in_future(expires_at, &reviewed_at) {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_EXPIRED,
            format!("plan {plan_id} approval expired at {expires_at}"),
        ));
    }
    // A verdict is bound to the *grant* it was written under, not to the row counter: pausing and
    // resuming only advance `revision`, so a stage review taken under the standing authorization
    // keeps working across them, while re-approving a configuration makes every older stage
    // decision stale.
    if policy.authorization_revision != policy_revision {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVISION_CONFLICT,
            format!(
                "plan {plan_id} stands at authorization revision {}, not the expected {policy_revision}",
                policy.authorization_revision
            ),
        ));
    }
    if !policy.task_ids.iter().any(|scoped| scoped == &task_id) {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_TASK_INVALID,
            format!("task {task_id} is not inside the approved automation scope of plan {plan_id}"),
        ));
    }
    let assigned = policy
        .reviewers
        .iter()
        .find(|assignment| assignment.task_id == task_id)
        .map(|assignment| assignment.reviewer_agent_id.clone());
    if assigned.as_deref() != Some(trusted_agent_id.as_str()) {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVIEWER_INVALID,
            format!("agent {trusted_agent_id} is not the approved reviewer of task {task_id}"),
        ));
    }

    let task: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT status, acceptance_criteria_json, COALESCE(assignee_agent_id,'')
             FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![&plan_id, &task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((task_state, acceptance_criteria_json, assignee_agent_id)) = task else {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_FOUND,
            format!("task {task_id} is not in the plan of mission {mission_id}"),
        ));
    };
    if assignee_agent_id == trusted_agent_id {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVIEWER_SELF,
            format!(
                "agent {trusted_agent_id} is the assignee of task {task_id} and cannot review it"
            ),
        ));
    }

    // The Candidate must be the newest one for the Task: an old approval never carries over to a
    // newer delivery, and an older delivery cannot be judged by a newer approval.
    let latest: Option<String> = transaction
        .query_row(
            "SELECT candidate_id FROM loom_candidate WHERE plan_id=?1 AND task_id=?2
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![&plan_id, &task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(latest) = latest else {
        return Err(LoomCommandError::rejection(
            LOOM_CANDIDATE_NOT_FOUND,
            format!("task {task_id} has no recorded candidate"),
        ));
    };
    if latest != candidate_id {
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_CANDIDATE_STALE,
            format!("candidate {candidate_id} is not the latest candidate of task {task_id}"),
        ));
    }
    if task_state != "IN_REVIEW" {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_IN_REVIEW,
            format!("LOOM task {task_id} is {task_state} and cannot be reviewed"),
        ));
    }

    let candidate: Option<(String, String, String, String)> = transaction
        .query_row(
            "SELECT candidate_id, agent_run_id, acceptance_criteria_version, evidence_ids_json
             FROM loom_candidate WHERE plan_id=?1 AND candidate_id=?2",
            params![&plan_id, &candidate_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((_, producer_run_id, candidate_version, candidate_evidence_json)) = candidate else {
        return Err(LoomCommandError::rejection(
            LOOM_CANDIDATE_NOT_FOUND,
            format!("candidate {candidate_id} is not recorded in plan {plan_id}"),
        ));
    };
    let already_reviewed: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM loom_stage_review WHERE candidate_id=?1 AND policy_revision=?2)",
        params![&candidate_id, policy_revision],
        |row| row.get(0),
    )?;
    if already_reviewed {
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_REVIEW_EXISTS,
            format!(
                "candidate {candidate_id} already carries a stage review at policy revision {policy_revision}"
            ),
        ));
    }
    // Cited evidence has to be evidence of *this* candidate. A verdict that points at somebody
    // else's artifact, or at something that was never registered, is not an observation of this
    // delivery.
    let candidate_evidence_ids: Vec<String> = serde_json::from_str(&candidate_evidence_json)
        .with_context(|| format!("candidate {candidate_id} evidenceIds are not a list"))?;
    for result in &criteria_results {
        for evidence_id in &result.evidence_ids {
            if !candidate_evidence_ids
                .iter()
                .any(|held| held == evidence_id)
            {
                return Err(LoomCommandError::rejection(
                    LOOM_EVIDENCE_NOT_FOUND,
                    format!(
                        "criterion {} cites {evidence_id}, which is not evidence of candidate {candidate_id}",
                        result.criterion_id
                    ),
                ));
            }
        }
    }

    // Identity and membership of the reviewing Run, resolved from the trusted Run the Host named.
    let run: Option<ReviewingRun> = transaction
        .query_row(
            "SELECT COALESCE(run.camp_id, turn.camp_id), conversation.agent_id,
                    run.conversation_id, conversation.native_adapter_installation_id,
                    conversation.native_session_id, run.predecessor_agent_run_id
             FROM agent_run run
             JOIN conversation ON conversation.id = run.conversation_id
             LEFT JOIN camp_turn turn ON turn.id = run.camp_turn_id
             WHERE run.id=?1
               AND run.status='running'
               AND run.cancel_requested_at IS NULL",
            [&trusted_run_id],
            |row| {
                Ok(ReviewingRun {
                    camp_id: row.get(0)?,
                    agent_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    native_installation_id: row.get(3)?,
                    native_session_id: row.get(4)?,
                    predecessor_run_id: row.get(5)?,
                })
            },
        )
        .optional()?;
    let Some(run) = run else {
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_REVIEWER_RUN_INVALID,
            format!(
                "agent run {trusted_run_id} is not a live run; a revoked or finished run cannot review"
            ),
        ));
    };
    let mission_camp_id: String = transaction.query_row(
        "SELECT camp_id FROM mission WHERE id=?1",
        [&mission_id],
        |row| row.get(0),
    )?;
    let run_agent_id = run.agent_id;
    if run_agent_id != trusted_agent_id || run.camp_id != mission_camp_id {
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_REVIEWER_RUN_INVALID,
            format!(
                "agent run {trusted_run_id} does not belong to agent {trusted_agent_id} of this Camp"
            ),
        ));
    }
    if !active_member(&transaction, &mission_camp_id, &trusted_agent_id)? {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVIEWER_INVALID,
            format!("agent {trusted_agent_id} is not an active member of this Camp"),
        ));
    }

    // Nobody reviews their own delivery: neither the producing Run nor the producing agent. This is
    // decided before the session fence so the refusal names the actual violation instead of
    // reporting a shared session between a Run and itself.
    if producer_run_id == trusted_run_id {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVIEWER_SELF,
            format!(
                "agent run {trusted_run_id} produced candidate {candidate_id} and cannot review it"
            ),
        ));
    }
    let Some(producer_agent_id) = agent_of_run(&transaction, &producer_run_id)? else {
        // Fail closed: a Candidate whose producing Run can no longer be resolved cannot prove the
        // reviewer is somebody else, so the verdict is refused instead of waved through.
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_REVIEWER_RUN_INVALID,
            format!(
                "candidate {candidate_id} names producer run {producer_run_id}, which cannot be resolved to an agent"
            ),
        ));
    };
    if producer_agent_id == trusted_agent_id {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVIEWER_SELF,
            format!(
                "agent {trusted_agent_id} produced candidate {candidate_id} and cannot review it"
            ),
        ));
    }

    // Independent observer first: the reviewing Run has to stand outside the Agent session that
    // produced this Task's deliveries. A verdict written from the producing session, or from a Run
    // that continues (or is continued by) a producing Run, is the producer judging itself through a
    // second agent identity — the upstream `factoryCheckIndependent` session/ancestry fence, with no
    // question exemptions here because LOOM has no accepted-answer continuation. This is decided
    // before the request: a shared session is disqualifying on its own, and the refusal names the
    // identity violation instead of what the ledger happens to hold.
    ensure_reviewer_session_is_independent(
        &transaction,
        &plan_id,
        &task_id,
        &producer_run_id,
        &RunSession {
            run_id: trusted_run_id.clone(),
            conversation_id: run.conversation_id,
            native_installation_id: run.native_installation_id,
            native_session_id: run.native_session_id,
            predecessor_run_id: run.predecessor_run_id,
        },
    )?;

    // A verdict answers one persisted review request, and nothing else: the REVIEW dispatch of *this*
    // Candidate, of *this* stage and of *this* standing authorization, whose Delivery this very Run
    // claimed. The reviewer assignment is not a request — an assigned reviewer that is busy with
    // another Task was asked nothing. A missing ledger row is not a human/Lead request either: the
    // Host queues every independent stage, so when no dispatch exists nobody was asked, and the Run
    // that would like to judge is not an observer the Owner's grant appointed. A dispatch written
    // under an authorization the Owner has since replaced named a Run for a grant that no longer
    // stands: re-labeling it with the new revision does not make the standing grant ask it.
    match review_source(
        &transaction,
        &plan_id,
        &task_id,
        &candidate_id,
        policy_revision,
    )? {
        ReviewSource::DispatchedTo(dispatched_run_id) if dispatched_run_id == trusted_run_id => {}
        ReviewSource::DispatchedTo(dispatched_run_id) => {
            return Err(LoomCommandError::rejection(
                LOOM_STAGE_REVIEW_SOURCE_UNBOUND,
                format!(
                    "the review of candidate {candidate_id} was dispatched to agent run {dispatched_run_id}, not to {trusted_run_id}"
                ),
            ));
        }
        ReviewSource::Unclaimed => {
            return Err(LoomCommandError::rejection(
                LOOM_STAGE_REVIEW_SOURCE_UNBOUND,
                format!(
                    "the review of candidate {candidate_id} was dispatched but no agent run has claimed its delivery"
                ),
            ));
        }
        ReviewSource::SupersededAuthorization(dispatched_revision) => {
            return Err(LoomCommandError::rejection(
                LOOM_STAGE_REVIEW_SOURCE_UNBOUND,
                format!(
                    "the review of candidate {candidate_id} was dispatched under authorization revision {dispatched_revision}; the standing grant {policy_revision} has dispatched no review to agent run {trusted_run_id}"
                ),
            ));
        }
        ReviewSource::NeverRequested => {
            return Err(LoomCommandError::rejection(
                LOOM_STAGE_REVIEW_SOURCE_UNBOUND,
                format!(
                    "no review of candidate {candidate_id} was ever dispatched, so nothing asked agent run {trusted_run_id} to judge it; a verdict answers the request the control plane made, not an assignment"
                ),
            ));
        }
    }

    // The manifest is whatever the Core can prove about the stored Candidate right now.
    let current_manifest = candidate_manifest_hash(&transaction, &candidate_id)?;
    if current_manifest != manifest_hash {
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_MANIFEST_MISMATCH,
            format!(
                "candidate {candidate_id} manifest is {current_manifest}, not the reviewed {manifest_hash}"
            ),
        ));
    }

    let snapshot = criteria_snapshot(&acceptance_criteria_json, &candidate_version, "task")?;
    if snapshot.criteria.is_empty() && verdict == LoomStageVerdict::Pass {
        return Err(LoomCommandError::rejection(
            LOOM_ACCEPTANCE_CRITERIA_EMPTY,
            format!(
                "candidate {candidate_id} has no acceptance criteria; a pass requires at least one"
            ),
        ));
    }
    let mut expected: Vec<&str> = snapshot
        .criteria
        .iter()
        .map(|criterion| criterion.criterion_id.as_str())
        .collect();
    expected.sort_unstable();
    let mut recorded: Vec<&str> = criteria_results
        .iter()
        .map(|result| result.criterion_id.as_str())
        .collect();
    recorded.sort_unstable();
    if recorded != expected {
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_CRITERIA_INCOMPLETE,
            format!(
                "a stage review of candidate {candidate_id} must answer every criterion of version {candidate_version} exactly once"
            ),
        ));
    }
    if verdict == LoomStageVerdict::Pass && criteria_results.iter().any(|result| !result.satisfied)
    {
        return Err(LoomCommandError::rejection(
            LOOM_STAGE_CRITERIA_INCOMPLETE,
            format!("a pass of candidate {candidate_id} must satisfy every criterion"),
        ));
    }

    let stage_review_id = format!("stage_{}", uuid::Uuid::new_v4().simple());
    transaction.execute(
        "INSERT INTO loom_stage_review(stage_review_id,plan_id,mission_id,task_id,candidate_id,
                                       command_id,reviewer_agent_id,reviewer_agent_run_id,
                                       policy_revision,manifest_hash,verdict,reason,
                                       criteria_results_json,reviewed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            &stage_review_id,
            &plan_id,
            &mission_id,
            &task_id,
            &candidate_id,
            &command_id,
            &trusted_agent_id,
            &trusted_run_id,
            policy_revision,
            &current_manifest,
            verdict.as_str(),
            &reason,
            serde_json::to_string(&criteria_results)?,
            &reviewed_at,
        ],
    )?;

    let next_status = match verdict {
        // A pass ends the internal stage and nothing else: the Task stays IN_REVIEW, the
        // Candidate stays PENDING and no dependency is released. Only the Owner accepts.
        LoomStageVerdict::Pass => LoomTaskStatus::InReview,
        LoomStageVerdict::RequestChanges => {
            // Rework: the same Task returns to READY so a new Run can claim it and deliver a new
            // Candidate. The old Candidate keeps its PENDING acceptance: a request for changes is
            // not a human rejection, and recording it as one would forge the Owner's verdict.
            transaction.execute(
                "UPDATE loom_task SET status='READY', blocked_reason=NULL, updated_at=?1,
                                     revision=revision+1
                 WHERE plan_id=?2 AND task_id=?3",
                params![&reviewed_at, &plan_id, &task_id],
            )?;
            transaction.execute(
                "UPDATE loom_claim SET released_at=?1
                 WHERE plan_id=?2 AND task_id=?3 AND released_at IS NULL",
                params![&reviewed_at, &plan_id, &task_id],
            )?;
            LoomTaskStatus::Ready
        }
        LoomStageVerdict::Blocked => {
            transaction.execute(
                "UPDATE loom_task SET status='BLOCKED', blocked_reason=?1, updated_at=?2,
                                     revision=revision+1
                 WHERE plan_id=?3 AND task_id=?4",
                params![
                    format!("stage review: {reason}"),
                    &reviewed_at,
                    &plan_id,
                    &task_id
                ],
            )?;
            transaction.execute(
                "UPDATE loom_claim SET released_at=?1
                 WHERE plan_id=?2 AND task_id=?3 AND released_at IS NULL",
                params![&reviewed_at, &plan_id, &task_id],
            )?;
            LoomTaskStatus::Blocked
        }
    };
    transaction.commit()?;

    Ok(LoomStageReviewRecordResult {
        review: LoomStageReview {
            stage_review_id,
            task_id,
            candidate_id,
            reviewer_agent_id: trusted_agent_id,
            reviewer_agent_run_id: trusted_run_id,
            policy_revision,
            manifest_hash: current_manifest,
            verdict,
            reason,
            criteria_results,
            reviewed_at,
        },
        task_status: next_status,
        replayed: false,
    })
}

/// One artifact as the manifest binds it: identity, workspace path and the digest the Host
/// computed at registration, never anything the reviewer sent.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestArtifact<'a> {
    artifact_id: &'a str,
    relative_path: &'a str,
    sha256: &'a str,
    size_bytes: i64,
}

/// The canonical manifest document. It is hashed as JSON rather than as a concatenation of
/// delimited fields, because a joined string lets a path or a hash containing the delimiter
/// collide with a different delivery.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CandidateManifest<'a> {
    candidate_id: &'a str,
    task_id: &'a str,
    content_hash: &'a str,
    criteria_version: &'a str,
    /// The full criterion text, not just the version: re-using a version with different text must
    /// change the manifest a reviewer is asked to sign.
    criteria: &'a [LoomAcceptanceCriterion],
    artifacts: &'a [ManifestArtifact<'a>],
}

/// The manifest a verdict is bound to: the Candidate's own identity and content hash, the full
/// acceptance criteria snapshot it was judged against, and every artifact it cites — all read
/// from the same Plan, sorted and de-duplicated so two reads of the same stored facts always
/// produce the same document.
///
/// Nothing here reads the payload or the disk: a reviewer judges what the Core recorded, and an
/// artifact that moved on disk is a verification matter (the existing evidence path), not a
/// reason for the stage verdict to hash a different manifest than the one under review.
pub fn candidate_manifest_hash(connection: &Connection, candidate_id: &str) -> Result<String> {
    use sha2::Digest;

    let (plan_id, task_id, content_hash, criteria_version, evidence_ids_json) = connection
        .query_row(
            "SELECT plan_id, task_id, content_hash, acceptance_criteria_version,
                    evidence_ids_json
             FROM loom_candidate WHERE candidate_id=?1",
            [candidate_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .with_context(|| format!("LOOM candidate {candidate_id} is missing"))?;
    let acceptance_criteria_json: String = connection
        .query_row(
            "SELECT acceptance_criteria_json FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![&plan_id, &task_id],
            |row| row.get(0),
        )
        .with_context(|| {
            format!("candidate {candidate_id} names task {task_id}, which is not in its plan")
        })?;
    let criteria = criteria_snapshot(&acceptance_criteria_json, &criteria_version, "task")?;

    let mut evidence_ids: Vec<String> = serde_json::from_str(&evidence_ids_json)
        .with_context(|| format!("candidate {candidate_id} evidenceIds are not a list"))?;
    evidence_ids.sort();
    evidence_ids.dedup();

    let mut artifacts: Vec<(String, String, String, i64)> = Vec::with_capacity(evidence_ids.len());
    for artifact_id in &evidence_ids {
        // Scoped by the same Plan: an artifact from another Mission can never join this manifest,
        // and a missing row is a hard failure rather than a silently shorter document.
        let (relative_path, sha256, size_bytes): (String, String, i64) = connection
            .query_row(
                "SELECT relative_path, sha256, size_bytes FROM loom_artifact
                 WHERE plan_id=?1 AND artifact_id=?2",
                params![&plan_id, artifact_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .with_context(|| {
                format!(
                    "candidate {candidate_id} cites artifact {artifact_id} that is not in its plan"
                )
            })?;
        artifacts.push((artifact_id.clone(), relative_path, sha256, size_bytes));
    }
    artifacts.sort_by(|left, right| left.0.cmp(&right.0));
    artifacts.dedup_by(|left, right| left.0 == right.0);
    let artifacts: Vec<ManifestArtifact<'_>> = artifacts
        .iter()
        .map(
            |(artifact_id, relative_path, sha256, size_bytes)| ManifestArtifact {
                artifact_id,
                relative_path,
                sha256,
                size_bytes: *size_bytes,
            },
        )
        .collect();

    let document = CandidateManifest {
        candidate_id,
        task_id: &task_id,
        content_hash: &content_hash,
        criteria_version: &criteria_version,
        criteria: &criteria.criteria,
        artifacts: &artifacts,
    };
    let bytes = serde_json::to_vec(&document)?;
    Ok(sha2::Sha256::new()
        .chain_update(&bytes)
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

/// How many dispatches this Plan has already spent.
///
/// The policy's `maxDispatches` is judged against every dispatch ever recorded for the Plan —
/// cancelled rows included — so neither re-approving the policy nor cancelling a Delivery can
/// hand budget back and let a Task be redispatched around the limit. The scheduling line reads
/// this before it writes a new `loom_control_dispatch` row.
#[allow(dead_code)]
pub(crate) fn dispatches_consumed(database: &Database, mission_id: &str) -> Result<i64> {
    let mission_id = scoped_mission(mission_id)?;
    let connection = database.connection();
    let plan_id: Option<String> = connection
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [mission_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(plan_id) = plan_id else {
        return Ok(0);
    };
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM loom_control_dispatch WHERE plan_id=?1",
        [&plan_id],
        |row| row.get(0),
    )?)
}

fn ensure_owner(trusted_user_id: &str) -> Result<()> {
    let trusted_user_id = required_field("control approval", "trustedUserId", trusted_user_id)?;
    if trusted_user_id != CURRENT_USER_ID {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_NOT_AUTHORIZED,
            "only the Owner can approve, pause or resume LOOM automation",
        ));
    }
    Ok(())
}

fn ensure_mission_exists(connection: &Connection, mission_id: &str) -> Result<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission WHERE id=?1)",
        [mission_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(LoomCommandError::rejection(
            LOOM_MISSION_NOT_FOUND,
            format!("mission {mission_id} does not exist"),
        ));
    }
    Ok(())
}

fn plan_id_of(connection: &Connection, mission_id: &str) -> Result<String> {
    connection
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [mission_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            LoomCommandError::rejection(
                LOOM_PLAN_NOT_FOUND,
                format!("mission {mission_id} has no LOOM plan"),
            )
        })
}

/// Stage input shape from the r1 contract: ids are 1–200, `manifestHash` is exactly 64 lowercase
/// hex characters, `reason` is 1–4000, `criteriaResults` is 1–100 rows, each row answers one
/// criterion and may cite at most 100 distinct evidence ids with a note of at most 4000.
///
/// The Core refuses the shape before it opens a transaction, so a malformed verdict cannot hold the
/// write lock or leave a half-judged Candidate behind.
pub(crate) fn validate_stage_review_shape(
    task_id: &str,
    candidate_id: &str,
    manifest_hash: &str,
    reason: &str,
    policy_revision: i64,
    criteria_results: &[LoomAcceptanceCriterionResult],
) -> Result<()> {
    let id_ok = |value: &str| (1..=200).contains(&value.chars().count());
    if !id_ok(task_id) || !id_ok(candidate_id) {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            "stage review ids must be between 1 and 200 characters",
        ));
    }
    if manifest_hash.chars().count() != 64
        || !manifest_hash
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
    {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            "manifestHash must be 64 lowercase hexadecimal characters",
        ));
    }
    if !(1..=4000).contains(&reason.chars().count()) {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            "reason must be between 1 and 4000 characters",
        ));
    }
    if policy_revision < 1 {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            "policyRevision must be a positive integer",
        ));
    }
    if !(1..=100).contains(&criteria_results.len()) {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            "criteriaResults must carry between 1 and 100 rows",
        ));
    }
    for result in criteria_results {
        if !id_ok(&result.criterion_id) {
            return Err(LoomCommandError::rejection(
                LOOM_INVALID_INPUT,
                "every criterionId must be between 1 and 200 characters",
            ));
        }
        if result.evidence_ids.len() > 100 {
            return Err(LoomCommandError::rejection(
                LOOM_INVALID_INPUT,
                format!(
                    "criterion {} cites more than 100 evidence ids",
                    result.criterion_id
                ),
            ));
        }
        let mut seen: Vec<&str> = Vec::with_capacity(result.evidence_ids.len());
        for evidence_id in &result.evidence_ids {
            if !id_ok(evidence_id) {
                return Err(LoomCommandError::rejection(
                    LOOM_INVALID_INPUT,
                    "every evidenceId must be between 1 and 200 characters",
                ));
            }
            if seen.contains(&evidence_id.as_str()) {
                return Err(LoomCommandError::rejection(
                    LOOM_INVALID_INPUT,
                    format!(
                        "criterion {} cites evidence {evidence_id} twice",
                        result.criterion_id
                    ),
                ));
            }
            seen.push(evidence_id.as_str());
        }
        if let Some(note) = &result.note {
            if note.chars().count() > 4000 {
                return Err(LoomCommandError::rejection(
                    LOOM_INVALID_INPUT,
                    format!(
                        "criterion {} note is longer than 4000 characters",
                        result.criterion_id
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn normalized_task_ids(task_ids: &[String]) -> Result<Vec<String>> {
    if task_ids.is_empty() {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_TASK_INVALID,
            "an approved policy must name at least one Task",
        ));
    }
    let mut normalized: Vec<String> = Vec::with_capacity(task_ids.len());
    for task_id in task_ids {
        let task_id = required_field("control configure", "taskId", task_id)?;
        if normalized.contains(&task_id) {
            return Err(LoomCommandError::rejection(
                LOOM_CONTROL_TASK_INVALID,
                format!("task {task_id} is listed twice in the automation scope"),
            ));
        }
        normalized.push(task_id);
    }
    Ok(normalized)
}

/// Every Task in scope must exist, carry exactly one reviewer, and that reviewer must be a
/// current active member of the Mission's Camp who is not the Task's assignee.
fn validated_reviewers(
    connection: &Connection,
    mission_id: &str,
    plan_id: &str,
    task_ids: &[String],
    input: &LoomControlPolicyInput,
) -> Result<Vec<LoomReviewerAssignment>> {
    let camp_id: String = connection.query_row(
        "SELECT camp_id FROM mission WHERE id=?1",
        [mission_id],
        |row| row.get(0),
    )?;
    let mut reviewers: Vec<LoomReviewerAssignment> = Vec::with_capacity(task_ids.len());
    for assignment in &input.reviewers {
        let task_id = required_field("control configure", "reviewerTaskId", &assignment.task_id)?;
        let reviewer_agent_id = required_field(
            "control configure",
            "reviewerAgentId",
            &assignment.reviewer_agent_id,
        )?;
        if !task_ids.contains(&task_id) {
            return Err(LoomCommandError::rejection(
                LOOM_CONTROL_REVIEWER_INVALID,
                format!(
                    "reviewer assignment names task {task_id}, which is not in the approved scope"
                ),
            ));
        }
        if reviewers.iter().any(|held| held.task_id == task_id) {
            return Err(LoomCommandError::rejection(
                LOOM_CONTROL_REVIEWER_INVALID,
                format!("task {task_id} carries more than one reviewer"),
            ));
        }
        reviewers.push(LoomReviewerAssignment {
            task_id,
            reviewer_agent_id,
        });
    }
    if reviewers.len() != task_ids.len() {
        let missing: Vec<&str> = task_ids
            .iter()
            .map(String::as_str)
            .filter(|task_id| !reviewers.iter().any(|held| held.task_id == *task_id))
            .collect();
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_REVIEWER_INVALID,
            format!(
                "every Task needs exactly one reviewer; missing {}",
                missing.join(", ")
            ),
        ));
    }

    for assignment in &reviewers {
        let assignee: Option<Option<String>> = connection
            .query_row(
                "SELECT assignee_agent_id FROM loom_task WHERE plan_id=?1 AND task_id=?2",
                params![plan_id, &assignment.task_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(assignee) = assignee else {
            return Err(LoomCommandError::rejection(
                LOOM_CONTROL_TASK_INVALID,
                format!(
                    "task {} is not in the plan of this mission",
                    assignment.task_id
                ),
            ));
        };
        if assignee.as_deref() == Some(assignment.reviewer_agent_id.as_str()) {
            return Err(LoomCommandError::rejection(
                LOOM_CONTROL_REVIEWER_SELF,
                format!(
                    "agent {} is the assignee of task {} and cannot review it",
                    assignment.reviewer_agent_id, assignment.task_id
                ),
            ));
        }
        if !active_member(connection, &camp_id, &assignment.reviewer_agent_id)? {
            return Err(LoomCommandError::rejection(
                LOOM_CONTROL_REVIEWER_INVALID,
                format!(
                    "reviewer {} is not an active member of this Camp",
                    assignment.reviewer_agent_id
                ),
            ));
        }
    }
    // Sorted by Task so the stored configuration is a fact, not a submission order.
    reviewers.sort_by(|left, right| left.task_id.cmp(&right.task_id));
    Ok(reviewers)
}

/// `enabled` needs a future expiry; a disabled policy may carry none. An unreadable instant is
/// always refused, because it cannot be judged.
fn validated_expiry(expires_at: Option<&str>, enabled: bool, now: &str) -> Result<Option<String>> {
    let Some(expires_at) = expires_at.map(str::trim).filter(|value| !value.is_empty()) else {
        if enabled {
            return Err(LoomCommandError::rejection(
                LOOM_CONTROL_EXPIRES_INVALID,
                "an enabled policy requires a future expiresAt",
            ));
        }
        return Ok(None);
    };
    if chrono::DateTime::parse_from_rfc3339(expires_at).is_err() {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_EXPIRES_INVALID,
            format!("expiresAt {expires_at} is not an RFC 3339 instant"),
        ));
    }
    if enabled && !expiry_in_future(expires_at, now) {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_EXPIRES_INVALID,
            format!("expiresAt {expires_at} is not in the future"),
        ));
    }
    Ok(Some(expires_at.to_string()))
}

/// An unreadable instant is not proof of a live approval, so it counts as expired.
fn expiry_in_future(expires_at: &str, now: &str) -> bool {
    let Ok(now) = chrono::DateTime::parse_from_rfc3339(now) else {
        return false;
    };
    match chrono::DateTime::parse_from_rfc3339(expires_at) {
        Ok(expires) => expires > now,
        Err(_) => false,
    }
}

fn active_member(connection: &Connection, camp_id: &str, agent_id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM camp_member member
                       JOIN agent_profile profile ON profile.id = member.agent_id
                       WHERE member.camp_id=?1 AND member.agent_id=?2
                         AND member.status='active' AND member.leave_requested_at IS NULL
                         AND profile.profile_status='present')",
        params![camp_id, agent_id],
        |row| row.get(0),
    )?)
}

fn agent_of_run(connection: &Connection, agent_run_id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT conversation.agent_id FROM agent_run run
             JOIN conversation ON conversation.id = run.conversation_id
             WHERE run.id=?1",
            [agent_run_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// The review request a Candidate's verdict is allowed to answer, derived only from the persisted
/// dispatch ledger.
#[derive(Debug, PartialEq, Eq)]
enum ReviewSource {
    /// The standing authorization dispatched the review of this Candidate and this Run claimed its
    /// Delivery: the only Run that may answer.
    DispatchedTo(String),
    /// The standing authorization dispatched the review but no Run claimed the Delivery yet:
    /// nobody was asked.
    Unclaimed,
    /// The newest review dispatch of this Candidate belongs to an authorization the Owner has since
    /// replaced, so the standing grant has not asked any Run.
    SupersededAuthorization(i64),
    /// No review of this Candidate was dispatched under any authorization, so no Run was asked to
    /// judge it. The reviewer assignment alone is a role, not a request.
    NeverRequested,
}

/// Which Run, under which authorization, the platform bound this Candidate's review to.
///
/// The ledger is keyed by `(REVIEW, plan, task, candidate, authorization revision)`, so a Candidate
/// carries at most one such dispatch per grant. Reading the newest dispatch of the Candidate is what
/// makes a re-approved grant observable: a Run named by an older grant stays bound to that grant.
///
/// The request is read from the Candidate the verdict names, never from the asking Run's own wishes:
/// a dispatch of some *other* Candidate (a previous delivery, or another Task) is not this request,
/// and an absent row is not a request either.
fn review_source(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
    candidate_id: &str,
    policy_revision: i64,
) -> Result<ReviewSource> {
    let newest: Option<(i64, Option<String>)> = connection
        .query_row(
            "SELECT dispatch.policy_revision, delivery.claimed_agent_run_id
             FROM loom_control_dispatch dispatch
             LEFT JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             WHERE dispatch.plan_id=?1 AND dispatch.task_id=?2 AND dispatch.kind='REVIEW'
               AND dispatch.candidate_id=?3
             ORDER BY dispatch.policy_revision DESC, dispatch.created_at DESC,
                      dispatch.dispatch_id DESC
             LIMIT 1",
            params![plan_id, task_id, candidate_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((dispatched_revision, claimed_run_id)) = newest else {
        return Ok(ReviewSource::NeverRequested);
    };
    if dispatched_revision != policy_revision {
        return Ok(ReviewSource::SupersededAuthorization(dispatched_revision));
    }
    Ok(match claimed_run_id {
        Some(run_id) => ReviewSource::DispatchedTo(run_id),
        None => ReviewSource::Unclaimed,
    })
}

/// The trusted Run asking to review, resolved from the Host's identity in this Camp.
struct ReviewingRun {
    camp_id: String,
    agent_id: String,
    conversation_id: String,
    /// The installation that owns the Native Session, part of its identity.
    native_installation_id: Option<String>,
    native_session_id: Option<String>,
    predecessor_run_id: Option<String>,
}

/// The Agent session one Run executes in, plus the Run it continues.
struct RunSession {
    run_id: String,
    conversation_id: String,
    native_installation_id: Option<String>,
    native_session_id: Option<String>,
    predecessor_run_id: Option<String>,
}

impl RunSession {
    fn read(connection: &Connection, run_id: &str) -> Result<Option<Self>> {
        Ok(connection
            .query_row(
                "SELECT run.id, run.conversation_id,
                        conversation.native_adapter_installation_id,
                        conversation.native_session_id, run.predecessor_agent_run_id
                 FROM agent_run run
                 JOIN conversation ON conversation.id = run.conversation_id
                 WHERE run.id=?1",
                [run_id],
                |row| {
                    Ok(Self {
                        run_id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        native_installation_id: row.get(2)?,
                        native_session_id: row.get(3)?,
                        predecessor_run_id: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }
}

/// Whether two `(installation, id)` pairs name the same Native Session.
///
/// A Native Session is identified by the installation that owns it *and* its own id — the same
/// pair the schema keeps unique. Two installations that each report `session-1` own two sessions; a
/// matching pair is one. When either side carries no installation identity the owner cannot be
/// told apart, so an equal id is treated as shared rather than assumed independent.
fn native_sessions_match(
    left_installation: Option<&str>,
    left_session: Option<&str>,
    right_installation: Option<&str>,
    right_session: Option<&str>,
) -> bool {
    let (Some(left_id), Some(right_id)) = (left_session, right_session) else {
        return false;
    };
    if left_id != right_id {
        return false;
    }
    match (left_installation, right_installation) {
        (Some(left), Some(right)) => left == right,
        _ => true,
    }
}

/// True when two Runs observe the world through one Agent session: the same conversation, the same
/// Native Session, or a continuation edge in either direction.
fn shares_agent_session(left: &RunSession, right: &RunSession) -> bool {
    left.conversation_id == right.conversation_id
        || native_sessions_match(
            left.native_installation_id.as_deref(),
            left.native_session_id.as_deref(),
            right.native_installation_id.as_deref(),
            right.native_session_id.as_deref(),
        )
        || left.predecessor_run_id.as_deref() == Some(right.run_id.as_str())
        || right.predecessor_run_id.as_deref() == Some(left.run_id.as_str())
}

/// Every production Run of one Task: the Runs that claimed it, or that produced one of its
/// Candidates. These are the sessions a review of this Task must stand outside of.
fn production_run_sessions(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
) -> Result<Vec<RunSession>> {
    let mut sessions: Vec<RunSession> = Vec::new();
    let mut statement = connection.prepare(
        "SELECT run.id, run.conversation_id,
                    conversation.native_adapter_installation_id,
                    conversation.native_session_id, run.predecessor_agent_run_id
         FROM agent_run run
         JOIN conversation ON conversation.id = run.conversation_id
         WHERE run.id IN (
             SELECT claim.agent_run_id FROM loom_claim claim
              WHERE claim.plan_id=?1 AND claim.task_id=?2
             UNION
             SELECT candidate.agent_run_id FROM loom_candidate candidate
              WHERE candidate.plan_id=?1 AND candidate.task_id=?2
         )",
    )?;
    let rows = statement.query_map(params![plan_id, task_id], |row| {
        Ok(RunSession {
            run_id: row.get(0)?,
            conversation_id: row.get(1)?,
            native_installation_id: row.get(2)?,
            native_session_id: row.get(3)?,
            predecessor_run_id: row.get(4)?,
        })
    })?;
    for row in rows {
        sessions.push(row?);
    }
    Ok(sessions)
}

/// Refuse a reviewing Run that is not an independent observer of this Task's deliveries.
///
/// Every Run that claimed this Task or produced one of its Candidates is a production Run. The
/// reviewer may share a session with none of them: not with the Run that produced the Candidate
/// under review, and not with a Run that delivered an earlier version of the same Task. The
/// reviewer may not itself be one of those Runs either — that is the same thread judging its own
/// work through another identity. A producing Run that can no longer be resolved is judged by the
/// caller before this fence, which fails closed on it.
fn ensure_reviewer_session_is_independent(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
    producer_run_id: &str,
    reviewer: &RunSession,
) -> Result<()> {
    let producer = RunSession::read(connection, producer_run_id)?;
    if let Some(producer) = producer.as_ref()
        && shares_agent_session(reviewer, producer)
    {
        return Err(shared_session_error(
            "the Run that produced the Candidate under review",
            &producer.run_id,
        ));
    }

    for production in production_run_sessions(connection, plan_id, task_id)? {
        if production.run_id == reviewer.run_id {
            return Err(shared_session_error("this Task", &production.run_id));
        }
        if shares_agent_session(reviewer, &production) {
            return Err(shared_session_error(
                "an earlier delivery of this Task",
                &production.run_id,
            ));
        }
    }
    Ok(())
}

fn shared_session_error(role: &str, run_id: &str) -> anyhow::Error {
    LoomCommandError::rejection(
        LOOM_STAGE_REVIEWER_SESSION_SHARED,
        format!(
            "agent run {run_id} is not an independent observer: the reviewing Run shares its Agent session, which {role} also used"
        ),
    )
}

fn read_policy(connection: &Connection, plan_id: &str) -> Result<Option<LoomControlPolicy>> {
    let row: Option<(
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        String,
        String,
        i64,
        i64,
        Option<String>,
        String,
        String,
        String,
    )> = connection
        .query_row(
            "SELECT mission_id, plan_id, revision, authorization_revision, enabled, paused,
                        task_ids_json, reviewers_json, max_dispatches, max_reworks_per_task,
                        expires_at, approved_by, approved_at, updated_at
                 FROM loom_control_policy WHERE plan_id=?1",
            [plan_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                ))
            },
        )
        .optional()?;
    let Some((
        mission_id,
        plan_id,
        revision,
        authorization_revision,
        enabled,
        paused,
        task_ids_json,
        reviewers_json,
        max_dispatches,
        max_reworks_per_task,
        expires_at,
        approved_by,
        approved_at,
        updated_at,
    )) = row
    else {
        return Ok(None);
    };
    Ok(Some(LoomControlPolicy {
        mission_id,
        plan_id,
        revision,
        authorization_revision,
        enabled: enabled != 0,
        paused: paused != 0,
        task_ids: serde_json::from_str(&task_ids_json)
            .context("a stored LOOM control policy has unreadable taskIds")?,
        reviewers: serde_json::from_str(&reviewers_json)
            .context("a stored LOOM control policy has unreadable reviewers")?,
        max_dispatches,
        max_reworks_per_task,
        expires_at,
        approved_by,
        approved_at,
        updated_at,
    }))
}

fn read_stage_reviews(connection: &Connection, plan_id: &str) -> Result<Vec<LoomStageReview>> {
    let mut statement = connection.prepare(
        "SELECT stage_review_id, task_id, candidate_id, reviewer_agent_id, reviewer_agent_run_id,
                policy_revision, manifest_hash, verdict, reason, criteria_results_json,
                reviewed_at
         FROM loom_stage_review WHERE plan_id=?1
         ORDER BY reviewed_at, stage_review_id",
    )?;
    let rows = statement.query_map([plan_id], stored_stage_review)?;
    let mut reviews = Vec::new();
    for row in rows {
        reviews.push(row?);
    }
    Ok(reviews)
}

fn stored_stage_review(row: &rusqlite::Row<'_>) -> rusqlite::Result<LoomStageReview> {
    let verdict: String = row.get(7)?;
    let criteria_results_json: String = row.get(9)?;
    Ok(LoomStageReview {
        stage_review_id: row.get(0)?,
        task_id: row.get(1)?,
        candidate_id: row.get(2)?,
        reviewer_agent_id: row.get(3)?,
        reviewer_agent_run_id: row.get(4)?,
        policy_revision: row.get(5)?,
        manifest_hash: row.get(6)?,
        verdict: LoomStageVerdict::parse(&verdict)
            .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?,
        reason: row.get(8)?,
        criteria_results: serde_json::from_str(&criteria_results_json)
            .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?,
        reviewed_at: row.get(10)?,
    })
}

struct StoredStageReview {
    review: LoomStageReview,
    mission_id: String,
}

impl StoredStageReview {
    fn task_id(&self) -> &str {
        &self.review.task_id
    }
    fn candidate_id(&self) -> &str {
        &self.review.candidate_id
    }
    fn reviewer_agent_id(&self) -> &str {
        &self.review.reviewer_agent_id
    }
    fn reviewer_agent_run_id(&self) -> &str {
        &self.review.reviewer_agent_run_id
    }
    fn policy_revision(&self) -> i64 {
        self.review.policy_revision
    }
    fn manifest_hash(&self) -> &str {
        &self.review.manifest_hash
    }
    fn verdict(&self) -> LoomStageVerdict {
        self.review.verdict
    }
    fn reason(&self) -> &str {
        &self.review.reason
    }
    fn criteria_results(&self) -> &[LoomAcceptanceCriterionResult] {
        &self.review.criteria_results
    }
}

fn read_stage_review_by_command(
    connection: &Connection,
    command_id: &str,
) -> Result<Option<StoredStageReview>> {
    let stored: Option<(String, LoomStageReview)> = connection
        .query_row(
            "SELECT mission_id, stage_review_id, task_id, candidate_id,
                    reviewer_agent_id, reviewer_agent_run_id, policy_revision, manifest_hash,
                    verdict, reason, criteria_results_json, reviewed_at
             FROM loom_stage_review WHERE command_id=?1",
            [command_id],
            |row| {
                let verdict: String = row.get(8)?;
                let criteria_results_json: String = row.get(10)?;
                Ok((
                    row.get(0)?,
                    LoomStageReview {
                        stage_review_id: row.get(1)?,
                        task_id: row.get(2)?,
                        candidate_id: row.get(3)?,
                        reviewer_agent_id: row.get(4)?,
                        reviewer_agent_run_id: row.get(5)?,
                        policy_revision: row.get(6)?,
                        manifest_hash: row.get(7)?,
                        verdict: LoomStageVerdict::parse(&verdict).map_err(|error| {
                            rusqlite::Error::InvalidParameterName(error.to_string())
                        })?,
                        reason: row.get(9)?,
                        criteria_results: serde_json::from_str(&criteria_results_json).map_err(
                            |error| rusqlite::Error::InvalidParameterName(error.to_string()),
                        )?,
                        reviewed_at: row.get(11)?,
                    },
                ))
            },
        )
        .optional()?;
    Ok(stored.map(|(mission_id, review)| StoredStageReview { review, mission_id }))
}

fn read_dispatches(connection: &Connection, plan_id: &str) -> Result<Vec<LoomDispatch>> {
    let mut statement = connection.prepare(
        "SELECT dispatch_id, task_id, kind, candidate_id, policy_revision, recipient_agent_id,
                delivery_id, status, reason, created_at
         FROM loom_control_dispatch WHERE plan_id=?1
         ORDER BY created_at, dispatch_id",
    )?;
    let rows = statement.query_map([plan_id], |row| {
        let kind: String = row.get(2)?;
        let status: String = row.get(7)?;
        Ok(LoomDispatch {
            dispatch_id: row.get(0)?,
            task_id: row.get(1)?,
            kind: LoomDispatchKind::parse(&kind)
                .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?,
            candidate_id: row.get(3)?,
            policy_revision: row.get(4)?,
            recipient_agent_id: row.get(5)?,
            delivery_id: row.get(6)?,
            status: LoomDispatchStatus::parse(&status)
                .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?,
            reason: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?;
    let mut dispatches = Vec::new();
    for row in rows {
        dispatches.push(row?);
    }
    Ok(dispatches)
}

fn snapshot_in_transaction(
    transaction: &Transaction<'_>,
    mission_id: &str,
    plan_id: &str,
    evaluated_at: &str,
) -> Result<LoomControlSnapshot> {
    Ok(LoomControlSnapshot {
        mission_id: mission_id.to_string(),
        policy: read_policy(transaction, plan_id)?,
        stage_reviews: read_stage_reviews(transaction, plan_id)?,
        dispatches: read_dispatches(transaction, plan_id)?,
        evaluated_at: evaluated_at.to_string(),
    })
}

/// A replayed `commandId` may only return what that exact request produced. The stored request
/// carries the trusted caller identity too, so the same `commandId` from another caller is a
/// conflict rather than a replay.
fn replay_command(
    transaction: &Transaction<'_>,
    command_id: &str,
    kind: &str,
    request_json: &str,
) -> Result<Option<String>> {
    let stored: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT kind, request_json, response_json FROM loom_control_command
             WHERE command_id=?1",
            [command_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((stored_kind, stored_request, stored_response)) = stored else {
        return Ok(None);
    };
    if stored_kind != kind || stored_request != request_json {
        return Err(LoomCommandError::rejection(
            LOOM_CONTROL_COMMAND_REUSED,
            format!("command {command_id} was already recorded for a different request"),
        ));
    }
    Ok(Some(stored_response))
}

fn record_command(
    transaction: &Transaction<'_>,
    command_id: &str,
    plan_id: &str,
    kind: &str,
    request_json: &str,
    response_json: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO loom_control_command(command_id,plan_id,kind,request_json,response_json,
                                          created_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![command_id, plan_id, kind, request_json, response_json, now],
    )?;
    Ok(())
}
