// upstream: Mikka d59c85cb lib/factory/automatic-dispatch.ts:automaticFactoryDispatch, lib/factory/dispatch.ts:createFactoryDispatch
//! LOOM dispatch scheduling: the Core decides, per Plan, which Task event may carry a Delivery
//! right now, and records that decision in the permanent dispatch ledger.
//!
//! Everything here is derived from persisted facts inside one `IMMEDIATE` transaction whose clock
//! is read after the write lock: the standing policy, the Plan's Tasks, the latest Candidate of
//! each Task, the stage verdicts written under the standing authorization, and the dispatch ledger
//! itself. No model payload and no scheduler state takes part.
//!
//! Four rules shape the module:
//!
//! * **One event, one Delivery.** Every dispatch carries a stable `dedupe_key` built from the event
//!   identity. Before any budget is spent the scheduler asks whether that key already exists, so a
//!   restart, a re-approval or a second pass cannot create a second Delivery — and a Task whose
//!   event is already out is never reported as out of budget.
//! * **Budget is spent, never returned.** `maxDispatches` is judged against every dispatch row the
//!   Plan ever recorded — cancelled ones included — and `maxReworksPerTask` against every rework of
//!   that Task, so cancelling a Delivery or re-approving a policy cannot buy another attempt.
//! * **Unknown is not success.** A dispatch is only complete when a *matching* successor fact
//!   proves it: the Candidate produced by that very Run, the stage verdict written by that very
//!   reviewer Run, the rework chained onto that very Candidate, or a settled handoff Delivery.
//!   Anything else — a Run still going, a Delivery that failed, a Delivery nobody claimed — keeps
//!   the event closed instead of being read as done.
//! * **Nothing illegal reaches the ledger.** Membership, Camp/Plan/Task ownership, the recipient's
//!   current assignment, the producer's identity and the Candidate's freshness are re-proved
//!   before the Delivery lane is entered, so a rejected admission leaves no ledger row and no
//!   Camp message behind.

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use super::super::blocking_dependencies;
use super::{LoomControlPolicy, active_member, read_policy};
use crate::collaboration::{LoomDispatchAdmission, LoomDispatchAdmissionOutcome};
use crate::db::Database;

/// One scheduler pass never starts more than this many dispatches, so an approval of a thousand
/// Tasks cannot turn into a thousand Runs in one tick.
const MAX_DISPATCHES_PER_TICK: usize = 100;

/// The three `blocked_reason` values this module owns. Nothing else may write them, and nothing
/// else is ever cleared by it.
const BUDGET_EXHAUSTED_REASON: &str = "loom.dispatch_budget_exhausted";
const REWORK_EXHAUSTED_REASON: &str = "loom.rework_budget_exhausted";
const PREVIOUS_OUTCOME_REASON: &str = "loom.dispatch_previous_outcome_unknown";
const RECIPIENT_UNAVAILABLE_REASON: &str = "loom.dispatch_recipient_unavailable";

const EXECUTE: &str = "EXECUTE";
const REVIEW: &str = "REVIEW";
const REWORK: &str = "REWORK";
const HANDOFF: &str = "HANDOFF";

/// One event the standing policy authorizes right now.
struct DispatchEvent {
    task_id: String,
    kind: &'static str,
    candidate_id: Option<String>,
    recipient_agent_id: String,
    dedupe_key: String,
    /// True when the Task must move `DRAFT` → `READY` in the same transaction that admits the
    /// dispatch; the release is only worth writing if its execution is actually being handed out.
    release_task: bool,
}

/// How an earlier dispatch of the same event class ended, judged only by facts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PriorOutcome {
    /// A matching successor fact proves the event finished.
    Completed,
    /// Nothing was ever handed to a Run, so the event demonstrably did not execute.
    NotExecuted,
    /// A Run took it and nothing proves the outcome yet.
    Pending,
    /// The Delivery or Run failed or was cancelled.
    Failed,
}

/// Admit every dispatch the standing policies authorize right now, and report how many Deliveries
/// were created. Reconciliation runs first, so a pass always reacts to what the previous Deliveries
/// actually did instead of re-dispatching on top of an unknown outcome.
pub fn admit_due_dispatches(database: &mut Database) -> Result<usize> {
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = chrono::Utc::now().to_rfc3339();

    reconcile_dispatches(&transaction, &now)?;

    let mut plans: Vec<(String, String)> = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT plan_id, mission_id FROM loom_control_policy
             WHERE enabled=1 AND paused=0 ORDER BY plan_id",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        for row in rows {
            plans.push(row?);
        }
    }

    let mut admitted = 0usize;
    for (plan_id, mission_id) in plans {
        if admitted >= MAX_DISPATCHES_PER_TICK {
            break;
        }
        admitted += admit_plan(
            &transaction,
            &plan_id,
            &mission_id,
            &now,
            MAX_DISPATCHES_PER_TICK - admitted,
        )?;
    }
    transaction.commit()?;
    Ok(admitted)
}

/// Why this recorded dispatch may not proceed, or `None` when it may.
///
/// This is a pure read and the authority's second opinion: the wrapper that is about to execute a
/// Delivery asks again, immediately before it starts the Run, whether the facts that justified the
/// dispatch still stand. Every missing or unreadable fact answers with a reason — the check never
/// fails open.
pub(crate) fn dispatch_block_reason(
    connection: &Connection,
    dispatch_id: &str,
    now: &str,
) -> Result<Option<String>> {
    let dispatch: Option<(String, String, String, String, Option<String>, i64, String)> = connection
        .query_row(
            "SELECT plan_id, task_id, kind, status, candidate_id, policy_revision,
                    recipient_agent_id
             FROM loom_control_dispatch WHERE dispatch_id=?1",
            [dispatch_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((plan_id, task_id, kind, status, candidate_id, policy_revision, recipient)) = dispatch
    else {
        return Ok(Some("loom.dispatch_not_found".to_string()));
    };
    if status != "WAITING" && status != "DISPATCHED" {
        return Ok(Some("loom.dispatch_not_pending".to_string()));
    }

    let Some(policy) = read_policy(connection, &plan_id)? else {
        return Ok(Some("loom.control_policy_missing".to_string()));
    };
    if !policy.enabled {
        return Ok(Some("loom.control_disabled".to_string()));
    }
    if policy.paused {
        return Ok(Some("loom.control_paused".to_string()));
    }
    let Some(expires_at) = policy.expires_at.as_deref() else {
        return Ok(Some("loom.control_expired".to_string()));
    };
    if !expiry_is_future(expires_at, now) {
        return Ok(Some("loom.control_expired".to_string()));
    }
    if policy.authorization_revision != policy_revision {
        return Ok(Some("loom.control_authorization_superseded".to_string()));
    }
    if !policy.task_ids.iter().any(|scoped| scoped == &task_id) {
        return Ok(Some("loom.dispatch_task_out_of_scope".to_string()));
    }
    // The policy has to belong to the Mission this Plan belongs to: a policy row cannot be used to
    // drive another Mission's Task merely because it names the same Plan id.
    let mission_id: Option<String> = connection
        .query_row("SELECT mission_id FROM loom_plan WHERE plan_id=?1", [&plan_id], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(mission_id) = mission_id else {
        return Ok(Some("loom.dispatch_task_missing".to_string()));
    };
    if policy.mission_id != mission_id {
        return Ok(Some("loom.control_policy_mission_mismatch".to_string()));
    }

    let problem = event_problem(
        connection,
        &policy,
        &mission_id,
        &plan_id,
        &task_id,
        &kind,
        candidate_id.as_deref(),
        &recipient,
        policy_revision,
        Some(dispatch_id),
    )?;
    Ok(problem.map(str::to_string))
}

#[allow(clippy::too_many_arguments)]
fn admit_plan(
    transaction: &Transaction<'_>,
    plan_id: &str,
    mission_id: &str,
    now: &str,
    remaining_ticks: usize,
) -> Result<usize> {
    let Some(policy) = read_policy(transaction, plan_id)? else {
        return Ok(0);
    };
    if !policy.enabled || policy.paused || policy.mission_id != mission_id {
        return Ok(0);
    }
    let Some(expires_at) = policy.expires_at.as_deref() else {
        return Ok(0);
    };
    if !expiry_is_future(expires_at, now) {
        return Ok(0);
    }

    let mut events = due_events(transaction, plan_id, mission_id, &policy, now)?;
    let mut admitted = 0usize;
    for event in events.drain(..) {
        if admitted >= remaining_ticks {
            break;
        }
        // An event that is already in the ledger is not a new cost and must never be reported as
        // one: this check runs before any budget decision.
        let already_recorded: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loom_control_dispatch WHERE dedupe_key=?1)",
            [&event.dedupe_key],
            |row| row.get(0),
        )?;
        if already_recorded {
            continue;
        }

        // Membership, ownership, assignment, producer identity and Candidate freshness are
        // re-proved here, under the write lock, before the Delivery lane is entered: a rejected
        // admission must leave neither a ledger row nor a Camp message behind.
        if let Some(problem) = event_problem(
            transaction,
            &policy,
            mission_id,
            plan_id,
            &event.task_id,
            event.kind,
            event.candidate_id.as_deref(),
            &event.recipient_agent_id,
            policy.authorization_revision,
            None,
        )? {
            match problem {
                RECIPIENT_UNAVAILABLE_REASON | "loom.dispatch_recipient_not_reviewer"
                | "loom.dispatch_recipient_not_assignee" | "loom.dispatch_recipient_is_assignee"
                | "loom.dispatch_recipient_is_producer" | "loom.dispatch_recipient_not_lead" => {
                    set_control_blocked_reason(
                        transaction,
                        plan_id,
                        &event.task_id,
                        RECIPIENT_UNAVAILABLE_REASON,
                        now,
                    )?;
                }
                PREVIOUS_OUTCOME_REASON => {
                    set_control_blocked_reason(
                        transaction,
                        plan_id,
                        &event.task_id,
                        PREVIOUS_OUTCOME_REASON,
                        now,
                    )?;
                }
                _ => {}
            }
            continue;
        }

        // The budget is judged against the whole ledger, so it is re-read for every event: an
        // earlier event in this same pass may already have spent the last slot.
        let spent: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM loom_control_dispatch WHERE plan_id=?1",
            [plan_id],
            |row| row.get(0),
        )?;
        if spent >= policy.max_dispatches {
            set_control_blocked_reason(
                transaction,
                plan_id,
                &event.task_id,
                BUDGET_EXHAUSTED_REASON,
                now,
            )?;
            continue;
        }
        if event.kind == REWORK {
            let reworks: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM loom_control_dispatch
                 WHERE plan_id=?1 AND task_id=?2 AND kind='REWORK'",
                params![plan_id, &event.task_id],
                |row| row.get(0),
            )?;
            if reworks >= policy.max_reworks_per_task {
                set_control_blocked_reason(
                    transaction,
                    plan_id,
                    &event.task_id,
                    REWORK_EXHAUSTED_REASON,
                    now,
                )?;
                continue;
            }
        }

        let dispatch_id = format!("dispatch_{}", uuid::Uuid::new_v4().simple());
        let admission = LoomDispatchAdmission {
            mission_id,
            dispatch_id: dispatch_id.as_str(),
            plan_id,
            task_id: event.task_id.as_str(),
            kind: event.kind,
            candidate_id: event.candidate_id.as_deref(),
            policy_revision: policy.authorization_revision,
            recipient_agent_id: event.recipient_agent_id.as_str(),
            dedupe_key: event.dedupe_key.as_str(),
            now,
        };
        match crate::collaboration::admit_loom_dispatch_message(transaction, &admission)? {
            LoomDispatchAdmissionOutcome::Admitted { .. } => {
                if event.release_task {
                    // The release and the dispatch that justifies it commit together: a Task is
                    // never left READY because a dispatch was attempted and failed.
                    transaction.execute(
                        "UPDATE loom_task SET status='READY', blocked_reason=NULL,
                                             updated_at=?1, revision=revision+1
                         WHERE plan_id=?2 AND task_id=?3 AND status='DRAFT'",
                        params![now, plan_id, &event.task_id],
                    )?;
                }
                clear_control_blocked_reason(transaction, plan_id, &event.task_id, now)?;
                admitted += 1;
            }
            LoomDispatchAdmissionOutcome::Skipped => {}
        }
    }
    Ok(admitted)
}

/// Every event the standing policy authorizes right now, in Task order. One Task contributes at
/// most one event per pass: its facts decide which one it is.
fn due_events(
    transaction: &Transaction<'_>,
    plan_id: &str,
    mission_id: &str,
    policy: &LoomControlPolicy,
    now: &str,
) -> Result<Vec<DispatchEvent>> {
    let lead: Option<String> = transaction
        .query_row(
            "SELECT camp.default_lead_agent_id FROM camp
             JOIN mission ON mission.camp_id = camp.id WHERE mission.id=?1",
            [mission_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .filter(|lead| !lead.is_empty());

    let mut events = Vec::new();
    for task_id in &policy.task_ids {
        let task: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT status, assignee_agent_id FROM loom_task WHERE plan_id=?1 AND task_id=?2",
                params![plan_id, task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((status, assignee)) = task else {
            continue;
        };
        if status == "DONE" || status == "CANCELED" {
            continue;
        }
        let latest_candidate: Option<(String, String)> = transaction
            .query_row(
                "SELECT candidate_id, acceptance_status FROM loom_candidate
                 WHERE plan_id=?1 AND task_id=?2 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![plan_id, task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let event = match latest_candidate {
            None => {
                // Only an explicit assignee executes. A Lead fallback would put work on somebody
                // the Owner never approved for this Task.
                let Some(assignee) = assignee.filter(|assignee| !assignee.is_empty()) else {
                    continue;
                };
                if status != "DRAFT" && status != "READY" {
                    continue;
                }
                // Dependencies gate the event in *both* states: a Task that is already READY but
                // whose upstream is no longer satisfied must not be handed out either.
                if !blocking_dependencies(transaction, plan_id, task_id)?.is_empty() {
                    continue;
                }
                DispatchEvent {
                    task_id: task_id.clone(),
                    kind: EXECUTE,
                    candidate_id: None,
                    recipient_agent_id: assignee,
                    dedupe_key: dedupe_key(&[EXECUTE, plan_id, task_id.as_str()])?,
                    release_task: status == "DRAFT",
                }
            }
            Some((candidate_id, acceptance)) => {
                let stage = current_stage_verdict(
                    transaction,
                    plan_id,
                    &candidate_id,
                    policy.authorization_revision,
                )?;
                match stage.as_deref() {
                    None => {
                        if status != "IN_REVIEW" {
                            continue;
                        }
                        let Some(assignment) = policy
                            .reviewers
                            .iter()
                            .find(|assignment| assignment.task_id == *task_id)
                        else {
                            continue;
                        };
                        if assignee.as_deref() == Some(assignment.reviewer_agent_id.as_str()) {
                            continue;
                        }
                        DispatchEvent {
                            task_id: task_id.clone(),
                            kind: REVIEW,
                            candidate_id: Some(candidate_id.clone()),
                            recipient_agent_id: assignment.reviewer_agent_id.clone(),
                            dedupe_key: {
                                let authorization = policy.authorization_revision.to_string();
                                dedupe_key(&[
                                    REVIEW,
                                    plan_id,
                                    task_id,
                                    candidate_id.as_str(),
                                    authorization.as_str(),
                                ])?
                            },
                            release_task: false,
                        }
                    }
                    Some("REQUEST_CHANGES") => {
                        if status != "READY" {
                            continue;
                        }
                        let Some(assignee) = assignee.filter(|assignee| !assignee.is_empty()) else {
                            continue;
                        };
                        let Some(stage_review_id) = latest_stage_review_id(
                            transaction,
                            plan_id,
                            &candidate_id,
                            policy.authorization_revision,
                        )?
                        else {
                            continue;
                        };
                        DispatchEvent {
                            task_id: task_id.clone(),
                            kind: REWORK,
                            candidate_id: Some(candidate_id.clone()),
                            recipient_agent_id: assignee,
                            dedupe_key: dedupe_key(&[
                                REWORK,
                                plan_id,
                                task_id.as_str(),
                                stage_review_id.as_str(),
                            ])?,
                            release_task: false,
                        }
                    }
                    Some("PASS") => {
                        if status != "IN_REVIEW" || acceptance != "PENDING" {
                            continue;
                        }
                        let Some(lead) = lead.clone() else {
                            continue;
                        };
                        let Some(stage_review_id) = latest_stage_review_id(
                            transaction,
                            plan_id,
                            &candidate_id,
                            policy.authorization_revision,
                        )?
                        else {
                            continue;
                        };
                        DispatchEvent {
                            task_id: task_id.clone(),
                            kind: HANDOFF,
                            candidate_id: Some(candidate_id.clone()),
                            recipient_agent_id: lead,
                            dedupe_key: dedupe_key(&[
                                HANDOFF,
                                plan_id,
                                task_id.as_str(),
                                stage_review_id.as_str(),
                            ])?,
                            release_task: false,
                        }
                    }
                    // A blocked verdict stops the Task for a User decision: no dispatch at all.
                    Some(_) => continue,
                }
            }
        };

        // An earlier attempt of this same event class that produced no matching successor fact
        // keeps the class closed. A plain wait (nothing handed to a Run yet) is not an unknown
        // outcome and writes no reason: only a started-but-unproved or failed attempt does.
        match prior_outcome_of_class(transaction, plan_id, &event.task_id, event.kind, None)? {
            PriorOutcome::Pending => continue,
            PriorOutcome::Failed => {
                set_control_blocked_reason(
                    transaction,
                    plan_id,
                    &event.task_id,
                    PREVIOUS_OUTCOME_REASON,
                    now,
                )?;
                continue;
            }
            PriorOutcome::Completed | PriorOutcome::NotExecuted => {}
        }
        events.push(event);
    }
    Ok(events)
}

/// Everything that has to be true for one event to be allowed to exist, shared by the scheduler and
/// by the pre-execution recheck so there is exactly one rule set.
#[allow(clippy::too_many_arguments)]
fn event_problem(
    transaction: &Connection,
    policy: &LoomControlPolicy,
    mission_id: &str,
    plan_id: &str,
    task_id: &str,
    kind: &str,
    candidate_id: Option<&str>,
    recipient: &str,
    authorization_revision: i64,
    excluding_dispatch_id: Option<&str>,
) -> Result<Option<&'static str>> {
    // Mission, Plan and Task have to belong together.
    let owning: Option<String> = transaction
        .query_row(
            "SELECT plan.mission_id FROM loom_plan plan
             JOIN loom_task task ON task.plan_id = plan.plan_id
             WHERE plan.plan_id=?1 AND task.task_id=?2",
            params![plan_id, task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(owning_mission) = owning else {
        return Ok(Some("loom.dispatch_task_missing"));
    };
    if owning_mission != mission_id {
        return Ok(Some("loom.dispatch_mission_mismatch"));
    }
    let camp_id: Option<String> = transaction
        .query_row("SELECT camp_id FROM mission WHERE id=?1", [mission_id], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(camp_id) = camp_id else {
        return Ok(Some("loom.dispatch_mission_missing"));
    };
    if !active_member(transaction, &camp_id, recipient)? {
        return Ok(Some(RECIPIENT_UNAVAILABLE_REASON));
    }

    let task_state: Option<(String, Option<String>)> = transaction
        .query_row(
            "SELECT status, assignee_agent_id FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![plan_id, task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((task_status, assignee)) = task_state else {
        return Ok(Some("loom.dispatch_task_missing"));
    };
    let latest_candidate: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT candidate_id, acceptance_status, agent_run_id FROM loom_candidate
             WHERE plan_id=?1 AND task_id=?2 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![plan_id, task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let current_stage: Option<String> = match latest_candidate.as_ref() {
        Some((latest_id, _, _)) => current_stage_verdict(
            transaction,
            plan_id,
            latest_id,
            authorization_revision,
        )?,
        None => None,
    };

    match kind {
        EXECUTE => {
            if latest_candidate.is_some() {
                return Ok(Some("loom.dispatch_execution_delivered"));
            }
            if task_status != "READY" && task_status != "DRAFT" {
                return Ok(Some("loom.dispatch_task_not_ready"));
            }
            if assignee.as_deref() != Some(recipient) {
                return Ok(Some("loom.dispatch_recipient_not_assignee"));
            }
            // Dependencies are re-proved here too: the event may only exist — and an already
            // reserved Delivery may only start — while every upstream edge is satisfied.
            if !blocking_dependencies(transaction, plan_id, task_id)?.is_empty() {
                return Ok(Some("loom.dispatch_dependency_unreleased"));
            }
        }
        REVIEW => {
            let Some((latest_id, _, producer_run_id)) = latest_candidate else {
                return Ok(Some("loom.dispatch_candidate_missing"));
            };
            if candidate_id != Some(latest_id.as_str()) {
                return Ok(Some("loom.dispatch_candidate_stale"));
            }
            if task_status != "IN_REVIEW" {
                return Ok(Some("loom.dispatch_task_not_in_review"));
            }
            if current_stage.is_some() {
                return Ok(Some("loom.dispatch_stage_already_recorded"));
            }
            let assigned = policy
                .reviewers
                .iter()
                .find(|assignment| assignment.task_id == task_id)
                .map(|assignment| assignment.reviewer_agent_id.clone());
            if assigned.as_deref() != Some(recipient) {
                return Ok(Some("loom.dispatch_recipient_not_reviewer"));
            }
            if assignee.as_deref() == Some(recipient) {
                return Ok(Some("loom.dispatch_recipient_is_assignee"));
            }
            // The producer is resolved through its Run; an unresolvable producer fails closed
            // rather than being treated as somebody else.
            let Some(producer_agent_id) = agent_of_run(transaction, &producer_run_id)? else {
                return Ok(Some("loom.dispatch_producer_unknown"));
            };
            if producer_agent_id == recipient {
                return Ok(Some("loom.dispatch_recipient_is_producer"));
            }
            // An earlier review of this Candidate must have ended with a verdict before a new
            // authorization may ask for another one: a Candidate that nobody judged is not re-asked
            // under a fresh approval.
            let unjudged_reviews: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM loom_control_dispatch dispatch
                 WHERE dispatch.plan_id=?1 AND dispatch.task_id=?2 AND dispatch.kind='REVIEW'
                   AND dispatch.candidate_id=?3
                   AND dispatch.dispatch_id <> COALESCE(?4,'')
                   AND NOT EXISTS(SELECT 1 FROM loom_stage_review review
                                  WHERE review.candidate_id=dispatch.candidate_id
                                    AND review.policy_revision=dispatch.policy_revision)",
                params![plan_id, task_id, latest_id, excluding_dispatch_id],
                |row| row.get(0),
            )?;
            if unjudged_reviews > 0 {
                return Ok(Some(PREVIOUS_OUTCOME_REASON));
            }
        }
        REWORK => {
            let Some((latest_id, _, _)) = latest_candidate else {
                return Ok(Some("loom.dispatch_candidate_missing"));
            };
            if candidate_id != Some(latest_id.as_str()) {
                return Ok(Some("loom.dispatch_candidate_stale"));
            }
            if task_status != "READY" {
                return Ok(Some("loom.dispatch_task_not_ready"));
            }
            if current_stage.as_deref() != Some("REQUEST_CHANGES") {
                return Ok(Some("loom.dispatch_rework_not_requested"));
            }
            if assignee.as_deref() != Some(recipient) {
                return Ok(Some("loom.dispatch_recipient_not_assignee"));
            }
        }
        HANDOFF => {
            let Some((latest_id, acceptance, _)) = latest_candidate else {
                return Ok(Some("loom.dispatch_candidate_missing"));
            };
            if candidate_id != Some(latest_id.as_str()) {
                return Ok(Some("loom.dispatch_candidate_stale"));
            }
            if task_status != "IN_REVIEW" {
                return Ok(Some("loom.dispatch_task_not_in_review"));
            }
            if current_stage.as_deref() != Some("PASS") {
                return Ok(Some("loom.dispatch_stage_not_passed"));
            }
            if acceptance != "PENDING" {
                return Ok(Some("loom.dispatch_already_settled_by_owner"));
            }
            let lead: Option<String> = transaction
                .query_row(
                    "SELECT default_lead_agent_id FROM camp WHERE id=?1",
                    [&camp_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            if lead.as_deref() != Some(recipient) {
                return Ok(Some("loom.dispatch_recipient_not_lead"));
            }
        }
        _ => return Ok(Some("loom.dispatch_unknown_kind")),
    }

    // A reserved Delivery may run while the budget is spent; only a *new* dispatch is refused. But
    // an earlier attempt of this class that produced no matching successor fact still blocks.
    match prior_outcome_of_class(
        transaction,
        plan_id,
        task_id,
        kind,
        excluding_dispatch_id,
    )? {
        PriorOutcome::Completed | PriorOutcome::NotExecuted => Ok(None),
        PriorOutcome::Pending | PriorOutcome::Failed => Ok(Some(PREVIOUS_OUTCOME_REASON)),
    }
}

/// The worst outcome among the earlier dispatches of this Task/kind, or `Completed` when every one
/// of them is either proven finished or never started.
fn prior_outcome_of_class(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
    kind: &str,
    excluding_dispatch_id: Option<&str>,
) -> Result<PriorOutcome> {
    let mut dispatches: Vec<String> = Vec::new();
    {
        let mut statement = connection.prepare(
            "SELECT dispatch_id FROM loom_control_dispatch
             WHERE plan_id=?1 AND task_id=?2 AND kind=?3
             ORDER BY created_at, dispatch_id",
        )?;
        let rows = statement.query_map(params![plan_id, task_id, kind], |row| row.get(0))?;
        for row in rows {
            dispatches.push(row?);
        }
    }
    let mut worst = PriorOutcome::Completed;
    for dispatch_id in dispatches {
        if excluding_dispatch_id == Some(dispatch_id.as_str()) {
            continue;
        }
        match prior_dispatch_outcome(connection, &dispatch_id)? {
            PriorOutcome::Completed | PriorOutcome::NotExecuted => {}
            PriorOutcome::Failed => return Ok(PriorOutcome::Failed),
            PriorOutcome::Pending => worst = PriorOutcome::Pending,
        }
    }
    Ok(worst)
}

/// How one recorded dispatch ended, judged only by a *matching* successor fact.
fn prior_dispatch_outcome(connection: &Connection, dispatch_id: &str) -> Result<PriorOutcome> {
    let row: Option<(
        String,
        String,
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT dispatch.plan_id, dispatch.kind, dispatch.task_id, dispatch.candidate_id,
                    dispatch.policy_revision, delivery.status, delivery.claimed_agent_run_id,
                    run.status
             FROM loom_control_dispatch dispatch
             LEFT JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             LEFT JOIN agent_run run ON run.id = delivery.claimed_agent_run_id
             WHERE dispatch.dispatch_id=?1",
            [dispatch_id],
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
                ))
            },
        )
        .optional()?;
    let Some((plan_id, kind, task_id, candidate_id, policy_revision, delivery_status, run_id, run_status)) =
        row
    else {
        return Ok(PriorOutcome::NotExecuted);
    };

    if let Some(run_id) = run_id.as_deref() {
        let completed = match kind.as_str() {
            EXECUTE => connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM loom_candidate
                               WHERE plan_id=?1 AND task_id=?2 AND agent_run_id=?3)",
                params![&plan_id, &task_id, run_id],
                |row| row.get::<_, bool>(0),
            )?,
            REVIEW => {
                let Some(candidate_id) = candidate_id.as_deref() else {
                    return Ok(PriorOutcome::Pending);
                };
                connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM loom_stage_review
                                   WHERE plan_id=?1 AND candidate_id=?2 AND policy_revision=?3
                                     AND reviewer_agent_run_id=?4)",
                    params![&plan_id, candidate_id, policy_revision, run_id],
                    |row| row.get::<_, bool>(0),
                )?
            }
            REWORK => {
                let Some(candidate_id) = candidate_id.as_deref() else {
                    return Ok(PriorOutcome::Pending);
                };
                connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM loom_candidate
                                   WHERE plan_id=?1 AND previous_candidate_id=?2 AND agent_run_id=?3)",
                    params![&plan_id, candidate_id, run_id],
                    |row| row.get::<_, bool>(0),
                )?
            }
            HANDOFF => delivery_status.as_deref() == Some("settled"),
            _ => false,
        };
        if completed {
            return Ok(PriorOutcome::Completed);
        }
        let failed = matches!(delivery_status.as_deref(), Some("failed") | Some("cancelled"))
            || matches!(run_status.as_deref(), Some("failed") | Some("cancelled"));
        return Ok(if failed {
            PriorOutcome::Failed
        } else {
            PriorOutcome::Pending
        });
    }

    // No Run ever claimed this Delivery.
    Ok(match delivery_status.as_deref() {
        Some("failed") | Some("cancelled") => PriorOutcome::Failed,
        // Waiting or claimed-without-a-run: the event demonstrably did not execute. It is not an
        // unknown outcome, and it is not a licence to create a second copy of the same event.
        _ => PriorOutcome::NotExecuted,
    })
}

/// Fold the real Delivery/Run outcome of every pending dispatch back into the ledger. Unknown is
/// never read as success, and no dedupe key is ever reset, so a retry of the same event stays
/// impossible after a restart. Settlement is derived from the dispatch's own successor fact, never
/// from a terminal Run alone, because the Delivery can stay claimed after its Run finished and the
/// ledger would otherwise keep that event out forever.
fn reconcile_dispatches(transaction: &Transaction<'_>, now: &str) -> Result<()> {
    let mut rows: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT dispatch.dispatch_id, delivery.status, delivery.failure_code, run.status
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             LEFT JOIN agent_run run ON run.id = delivery.claimed_agent_run_id
             WHERE dispatch.status IN ('WAITING','DISPATCHED')",
        )?;
        let mapped = statement.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }
    for (dispatch_id, delivery_status, failure_code, run_status) in rows {
        let settled = match (delivery_status.as_str(), run_status.as_deref()) {
            ("settled", _) => Some(("SETTLED", None)),
            ("failed", _) => Some((
                "BLOCKED",
                Some(failure_code.unwrap_or_else(|| "loom.dispatch_failed".to_string())),
            )),
            ("cancelled", _) => Some(("CANCELLED", None)),
            (_, Some("failed")) => {
                Some(("BLOCKED", Some("loom.dispatch_run_failed".to_string())))
            }
            (_, Some("cancelled")) => Some(("CANCELLED", None)),
            // A Delivery that is still only claimed proves nothing either way, and a Run that is
            // still going proves nothing at all: the ledger may only be folded from a *finished*
            // Run, and then only from the successor fact of that very dispatch — the Candidate
            // produced by this Run, the stage verdict written by this reviewer Run under this
            // Candidate and policy revision, the rework chained onto this Candidate, or a settled
            // handoff. A Run that succeeded without writing its fact stays `Pending`, so a
            // settlement is never read out of the Run alone and a running Run is never ended here.
            (_, Some("succeeded")) => match prior_dispatch_outcome(transaction, &dispatch_id)? {
                PriorOutcome::Completed => Some(("SETTLED", None)),
                _ => None,
            },
            _ => None,
        };
        let Some((status, reason)) = settled else {
            continue;
        };
        transaction.execute(
            "UPDATE loom_control_dispatch SET status=?1, reason=?2, updated_at=?3
             WHERE dispatch_id=?4",
            params![status, reason, now, &dispatch_id],
        )?;
    }
    Ok(())
}

/// The current-authorization stage verdict of one Candidate, if one was recorded.
fn current_stage_verdict(
    connection: &Connection,
    plan_id: &str,
    candidate_id: &str,
    authorization_revision: i64,
) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT verdict FROM loom_stage_review
             WHERE plan_id=?1 AND candidate_id=?2 AND policy_revision=?3
             ORDER BY reviewed_at DESC LIMIT 1",
            params![plan_id, candidate_id, authorization_revision],
            |row| row.get(0),
        )
        .optional()?)
}

fn latest_stage_review_id(
    connection: &Connection,
    plan_id: &str,
    candidate_id: &str,
    authorization_revision: i64,
) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT stage_review_id FROM loom_stage_review
             WHERE plan_id=?1 AND candidate_id=?2 AND policy_revision=?3
             ORDER BY reviewed_at DESC LIMIT 1",
            params![plan_id, candidate_id, authorization_revision],
            |row| row.get(0),
        )
        .optional()?)
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

/// Write one of this module's three reasons. An existing reason written by somebody else — a User
/// or another owner — is never overwritten, and an unchanged value writes nothing at all.
fn set_control_blocked_reason(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    reason: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "UPDATE loom_task SET blocked_reason=?1, updated_at=?2, revision=revision+1
         WHERE plan_id=?3 AND task_id=?4
           AND (blocked_reason IS NULL OR blocked_reason IN (?5,?6,?7))
           AND (blocked_reason IS NULL OR blocked_reason <> ?1)",
        params![
            reason,
            now,
            plan_id,
            task_id,
            BUDGET_EXHAUSTED_REASON,
            REWORK_EXHAUSTED_REASON,
            PREVIOUS_OUTCOME_REASON
        ],
    )?;
    Ok(())
}

/// Clear this module's own reasons — all three of them — and nothing else.
fn clear_control_blocked_reason(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "UPDATE loom_task SET blocked_reason=NULL, updated_at=?1, revision=revision+1
         WHERE plan_id=?2 AND task_id=?3 AND blocked_reason IN (?4,?5,?6)",
        params![
            now,
            plan_id,
            task_id,
            BUDGET_EXHAUSTED_REASON,
            REWORK_EXHAUSTED_REASON,
            PREVIOUS_OUTCOME_REASON
        ],
    )?;
    Ok(())
}

/// The stable identity of one event, as a JSON array so the parts can never run into each other and
/// cannot be confused with a path or a delimited string.
fn dedupe_key(parts: &[&str]) -> Result<String> {
    serde_json::to_string(parts).context("a LOOM dispatch dedupe key must serialise")
}

/// An unreadable instant is not proof of a live approval, so it counts as expired.
fn expiry_is_future(expires_at: &str, now: &str) -> bool {
    let Ok(now) = chrono::DateTime::parse_from_rfc3339(now) else {
        return false;
    };
    match chrono::DateTime::parse_from_rfc3339(expires_at) {
        Ok(expires) => expires > now,
        Err(_) => false,
    }
}
