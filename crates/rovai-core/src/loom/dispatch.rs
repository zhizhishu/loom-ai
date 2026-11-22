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
//! * **A failure is a fact, not a silence.** When the recipient cannot take the work right now,
//!   the pass writes exactly one reason: `loom.dispatch_recipient_disabled`, then
//!   `loom.dispatch_recipient_offline`, then `loom.dispatch_harness_unavailable`, judged in that
//!   order — the switch, then presence, then the harness — ported from Mikka
//!   `lib/factory/dispatch-recovery.ts:factoryDispatchFailureReason`. The facts are read inside the
//!   same `IMMEDIATE` transaction as the decision, so a recipient that comes back while the pass
//!   waits for the write lock is dispatched instead of being reported as absent. Presence is the
//!   device that will actually run the work: the local installation the Agent is bound to, or the
//!   remote Node the member explicitly selected — first the Node's own presence (paired, unrevoked,
//!   heartbeating), then the harness it reports — judged by the same launch intent Core already
//!   applies (`light_ready`, `installed_unverified` and a missing snapshot are startable; a stored
//!   probe result is not a dispatch condition, and a live Command Host is admitted by its
//!   installation identity even when the disk entry moved). Once a Run exists, the device is that
//!   Run's frozen target, never a member setting that changed afterwards — and only while that Run
//!   is still `queued` is a device a *dispatch* question at all: upstream records
//!   `run_dispatch_failed` only for a queued Run, so work that already started neither writes a
//!   failure fact nor a recovery fact, and is never parked with an availability reason.
//! * **Unavailable work is still reserved.** A device that is merely gone does not cancel work the
//!   Owner approved: the Dispatch and its Delivery are reserved, the failure is recorded, and the
//!   pre-execution recheck keeps the lane from starting until the device is back. That reservation
//!   is what the Delivery scheduler and the recovery timer can find, so the same queued Run
//!   continues by itself — no pass has to be triggered by hand. The device is judged *after* every
//!   identity rule: a Reservation exists only for an event the Task state, the assignment, the
//!   Candidate, the producer identity and the earlier outcome all allow, because a lane must never
//!   be reserved for work no later pass can start. A Recipient the Camp cannot address at all (no
//!   profile, not a member, switched off, away) has no lane to reserve, so only its failure fact is
//!   written.
//! * **A failure is a durable fact.** Each `(event identity, reason)` is recorded once as a
//!   `loom.dispatch_failed` domain event — a repeated tick stores nothing, an
//!   offline → disabled → offline round trip keeps one row per reason, and recovery never deletes
//!   the history. Reaching the recipient again writes exactly one `loom.dispatch_recovered`, the
//!   counterpart of upstream's `run_redispatched`, and the same Task is handed out under its own
//!   unchanged event identity: recovery resumes the Delivery/queued Run the earlier pass could not
//!   start, and never mints a second one. `loom_task.blocked_reason` is only the current-state
//!   mirror of those facts.
//!
//! The cloud half of the upstream module (`FACTORY_CLOUD_DISPATCH_AVAILABLE`, `switchToCloud`) has
//! no counterpart here: cloud (E2B) dispatch stays unavailable, so no pass of this module can start
//! one and no code in it can be turned on to try.

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use super::super::blocking_dependencies;
use super::{LoomControlPolicy, active_member, read_policy};
use crate::agent_profile::{AdapterKind, RuntimeReadiness, RuntimeReadinessStatus};
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

/// The failure vocabulary of one dispatch, ported from Mikka
/// `lib/factory/dispatch-recovery.ts:FACTORY_DISPATCH_FAILURE_REASONS` (`deviceDisabled`,
/// `deviceOffline`, `harnessUnavailable`). A recipient Agent and the runtime it is bound to are
/// LOOM's device: the switch is the membership/profile, presence is the bound installation and its
/// executable, and the harness is the Adapter kind that installation actually offers.
///
/// These are permanent `loom_task.blocked_reason` codes and are judged in exactly this order, so a
/// recipient that is both switched off and unreachable is reported as switched off.
const RECIPIENT_DISABLED_REASON: &str = "loom.dispatch_recipient_disabled";
const RECIPIENT_OFFLINE_REASON: &str = "loom.dispatch_recipient_offline";
const HARNESS_UNAVAILABLE_REASON: &str = "loom.dispatch_harness_unavailable";

/// The durable event vocabulary of the same ladder, ported from Mikka's
/// `run_dispatch_failed:<runId>:<reasonCode>` and `run_redispatched:<runId>`. The event identity of
/// a dispatch plays the part of the Run id, because the queued Run itself is only materialised when
/// its Delivery is claimed.
const DISPATCH_FAILED_EVENT: &str = "loom.dispatch_failed";
const DISPATCH_RECOVERED_EVENT: &str = "loom.dispatch_recovered";

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

    // The device judged here is the one this queued work was frozen to: once a Run exists, a member
    // setting that changed afterwards cannot reroute or block it. A Run that already started is not
    // a dispatch question at all, so its device is not judged here either.
    let reserved = reserved_execution_of_dispatch(connection, dispatch_id)?;
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
        reserved.frozen.as_ref(),
        reserved.device_is_judged(),
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

    // The Camp every recorded fact belongs to. A missing Mission is not a reason to invent one:
    // the events are stored without a Camp instead of failing the whole pass.
    let camp_id: Option<String> = transaction
        .query_row(
            "SELECT camp_id FROM mission WHERE id=?1",
            [mission_id],
            |row| row.get(0),
        )
        .optional()?;

    let mut events = due_events(transaction, plan_id, mission_id, &policy, now)?;
    let mut admitted = 0usize;
    for event in events.drain(..) {
        if admitted >= remaining_ticks {
            break;
        }
        // An event that is already in the ledger is not a new cost and must never be reported as
        // one: this check runs before any budget decision. It is still judged, because the queued
        // work behind it can stop being reachable while it waits — a Delivery that is reserved but
        // not yet claimed. That writes the same durable failure fact the unqueued path writes, and
        // exactly one recovery fact when the recipient comes back; the reserved Delivery is the
        // queued work, so recovering resumes it instead of admitting a second one.
        let already_recorded: Option<String> = transaction
            .query_row(
                "SELECT dispatch_id FROM loom_control_dispatch WHERE dedupe_key=?1
                 ORDER BY created_at DESC, dispatch_id DESC LIMIT 1",
                [&event.dedupe_key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(recorded_dispatch_id) = already_recorded {
            // The failure and recovery facts are judgements of a *dispatch*, so they exist only
            // while the work they describe is still waiting to start: the queued Run that has not
            // been handed to a Runtime yet, or the reservation no Run exists for. A Run that is
            // already running, waiting or finished proves nothing about a device and must not be
            // reported as a dispatch failure or a dispatch recovery.
            if !reserved_execution_of_dispatch(transaction, &recorded_dispatch_id)?
                .device_is_judged()
            {
                // `blocked_reason` is only the current-state mirror of those facts, so a reason
                // that said "not started yet" is dropped once the work started; no event is
                // written, and nothing about the running work is re-judged here.
                clear_control_blocked_reason(transaction, plan_id, &event.task_id, now)?;
                continue;
            }
            match dispatch_block_reason(transaction, &recorded_dispatch_id, now)? {
                Some(reason) if is_recipient_availability_reason(&reason) => {
                    set_control_blocked_reason(transaction, plan_id, &event.task_id, &reason, now)?;
                    record_dispatch_failure(transaction, camp_id.as_deref(), &event, &reason, now)?;
                }
                None => {
                    record_dispatch_recovery(transaction, camp_id.as_deref(), &event, now)?;
                    clear_control_blocked_reason(transaction, plan_id, &event.task_id, now)?;
                }
                Some(_) => {}
            }
            continue;
        }

        // A device that cannot take the work right now is not a reason to forget the work: the
        // Dispatch and its Delivery are reserved anyway, exactly as upstream keeps the Run row
        // queued, so the scheduler owns a durable pending item it can find again and the
        // pre-execution recheck keeps the Delivery from starting until the device is back. Only the
        // identity and budget rejections below leave nothing behind, because those are not a
        // "wait for the device" fact: a Recipient the Camp cannot address at all (no profile, not a
        // member, switched off, away) has no Delivery lane to reserve, so its failure is recorded
        // as a fact and the Task stays closed for this pass.
        let mut recipient_failure: Option<&'static str> = None;
        // Membership, ownership, assignment, producer identity and Candidate freshness are
        // re-proved here, under the write lock, before the Delivery lane is entered.
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
            None,
            true,
        )? {
            let reservable = match camp_id.as_deref() {
                Some(camp_id) => {
                    reserves_while_unavailable(problem)
                        && recipient_is_addressable(
                            transaction,
                            camp_id,
                            &event.recipient_agent_id,
                        )?
                }
                None => false,
            };
            if reservable {
                // The Recipient is an addressable Member whose device is gone: reserve the work
                // below and record the reason once it exists.
                recipient_failure = Some(problem);
            } else {
                match problem {
                    RECIPIENT_UNAVAILABLE_REASON
                    | RECIPIENT_DISABLED_REASON
                    | RECIPIENT_OFFLINE_REASON
                    | HARNESS_UNAVAILABLE_REASON
                    | PREVIOUS_OUTCOME_REASON
                    | "loom.dispatch_recipient_not_reviewer"
                    | "loom.dispatch_recipient_not_assignee"
                    | "loom.dispatch_recipient_is_assignee"
                    | "loom.dispatch_recipient_is_producer"
                    | "loom.dispatch_recipient_not_lead" => {
                        // The recorded reason is the specific code, not a generic "cannot reach".
                        // `blocked_reason` is only the current-state mirror of the durable fact.
                        set_control_blocked_reason(
                            transaction,
                            plan_id,
                            &event.task_id,
                            problem,
                            now,
                        )?;
                        if is_recipient_availability_reason(problem) {
                            record_dispatch_failure(
                                transaction,
                                camp_id.as_deref(),
                                &event,
                                problem,
                                now,
                            )?;
                        }
                    }
                    _ => {}
                }
                continue;
            }
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
                match recipient_failure {
                    // Reserved, but the device still cannot start it: the queued work is now the
                    // durable pending item the scheduler and the recovery timer find, and the
                    // failure is recorded exactly once per event and reason.
                    Some(reason) => {
                        set_control_blocked_reason(
                            transaction,
                            plan_id,
                            &event.task_id,
                            reason,
                            now,
                        )?;
                        record_dispatch_failure(
                            transaction,
                            camp_id.as_deref(),
                            &event,
                            reason,
                            now,
                        )?;
                    }
                    None => {
                        record_dispatch_recovery(transaction, camp_id.as_deref(), &event, now)?;
                        clear_control_blocked_reason(transaction, plan_id, &event.task_id, now)?;
                    }
                }
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
            PriorOutcome::Pending => {
                // A Run that is still going proves nothing, so this class must not be handed out
                // again. But the work that Run queued can itself become unreachable: the reservation
                // is judged below (its dedupe key is already in the ledger, so no second Delivery
                // can exist) and its failure and recovery are recorded as facts. Without this the
                // queued Run's outage would be silent.
                let reserved: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM loom_control_dispatch WHERE dedupe_key=?1)",
                    [&event.dedupe_key],
                    |row| row.get(0),
                )?;
                if !reserved {
                    continue;
                }
            }
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
    frozen: Option<&FrozenExecution>,
    judge_device: bool,
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
    // The recipient's own availability, in the upstream order disabled → offline → harness. It is
    // read from the transaction that is about to decide, never from an earlier reading: an
    // availability change that commits while this pass waits for the write lock is observed here.
    // The device judged is the one execution will use: the Run's frozen target when this work was
    // already handed out, otherwise the selected remote Node, otherwise the local installation.
    //
    // The answer is held, not returned: a device that is merely gone says nothing about whether this
    // event is allowed to exist. Every identity fact below — the Task state, the assignment, the
    // Candidate's freshness, the producer's identity, the earlier outcome of this class — is judged
    // first, and only an event that passes all of them can be admitted as "waiting for its device"
    // (or reported as unreachable). Otherwise an unavailable device would short-circuit admission
    // and reserve a Delivery that no later pass can ever start. A Run that already started is not a
    // dispatch question at all, so its device is not judged here.
    let recipient_problem = if judge_device {
        recipient_failure_reason(transaction, &camp_id, recipient, frozen)?
    } else {
        None
    };

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
        PriorOutcome::Completed | PriorOutcome::NotExecuted => Ok(recipient_problem),
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

/// The persisted switch of one recipient: the Agent profile and its Camp membership. Read from the
/// connection that is about to decide, so the facts are the ones the write lock ordered.
struct RecipientSwitch {
    profile_status: String,
    profile_removed: bool,
    profile_archived: bool,
    member_status: Option<String>,
    leave_requested: bool,
    /// The Adapter kind the Agent is configured to run, when one is configured at all.
    selected_adapter_kind: Option<String>,
    /// The local installation the Agent is bound to right now.
    installation_id: Option<String>,
}

/// The device that will actually run one dispatch, as the execution path will see it.
///
/// A local installation is a launch intent (`enabled`, the Adapter it offers, and — for every
/// Adapter whose launch reads the disk — a resolvable `path_state`), which is the same fact
/// `agent_profile::runtime_readiness` and `runtime_dispatch_blocker` read. A remote Node is
/// presence (paired, unrevoked, heartbeating now) plus the catalog entry it reported for the
/// selected harness. A stored probe result is *not* part of either: Core starts a Runtime in
/// `light_ready`, `installed_unverified` or without any snapshot, so a probe would be stricter here
/// than the launch it feeds.
enum Device {
    Local {
        installation_id: Option<String>,
        /// The Adapter the work must run, when the Agent named one. `None` asks for no particular
        /// harness, exactly as upstream's device with no harness requirement.
        expected_adapter_kind: Option<String>,
    },
    Remote {
        node_id: String,
        adapter_kind: String,
    },
}

/// Why this device cannot take the work right now, in the upstream order: presence first, then the
/// harness. `None` means it can.
///
/// The order matters: a Node that is also missing its harness is reported as unreachable, never as
/// a harness problem, because presence is judged before anything the Node reported.
fn device_failure_reason(connection: &Connection, device: &Device) -> Result<Option<&'static str>> {
    match device {
        Device::Local {
            installation_id,
            expected_adapter_kind,
        } => {
            let Some(installation_id) = installation_id.as_deref() else {
                return Ok(Some(RECIPIENT_OFFLINE_REASON));
            };
            let installation: Option<(i64, String, String)> = connection
                .query_row(
                    "SELECT enabled, adapter_kind, path_state FROM adapter_installation
                     WHERE id=?1",
                    [installation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((enabled, adapter_kind, path_state)) = installation else {
                return Ok(Some(RECIPIENT_OFFLINE_REASON));
            };
            if enabled != 1 {
                return Ok(Some(RECIPIENT_OFFLINE_REASON));
            }
            // A live Command Host is admitted by its installation identity: only the cold branch
            // resolves the disk entry, exactly as `runtime_dispatch_blocker` splits it.
            let command_host = adapter_kind == AdapterKind::CommandCodeCli.as_str();
            if !command_host && path_state != "valid" {
                return Ok(Some(RECIPIENT_OFFLINE_REASON));
            }
            if let Some(expected) = expected_adapter_kind
                .as_deref()
                .filter(|kind| !kind.is_empty())
                && expected != adapter_kind
            {
                return Ok(Some(HARNESS_UNAVAILABLE_REASON));
            }
            Ok(None)
        }
        Device::Remote {
            node_id,
            adapter_kind,
        } => {
            // Presence: the Node is paired, still trusted, and its own socket opened a session
            // it has not closed. A column read, never a heartbeat window (decision
            // 2026-11-17-2215). `last_heartbeat` is display-only and decides nothing here.
            let node: Option<(String, Option<String>, Option<String>, Option<String>)> = connection
                .query_row(
                    "SELECT role,session_opened_at,session_closed_at,revoked_at FROM execution_node WHERE node_id=?1",
                    [node_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            let Some((role, session_opened_at, session_closed_at, revoked_at)) = node else {
                return Ok(Some(RECIPIENT_OFFLINE_REASON));
            };
            if role != "remote"
                || revoked_at.is_some()
                || !crate::device_presence::is_device_online(
                    &crate::device_presence::device_session_state(
                        session_opened_at.as_deref(),
                        session_closed_at.as_deref(),
                    ),
                )
            {
                return Ok(Some(RECIPIENT_OFFLINE_REASON));
            }
            // Harness: the Node reports one usable installation of the harness the work needs.
            match crate::remote_catalog::load_remote_catalog(connection, node_id, adapter_kind) {
                Ok(_) => Ok(None),
                Err(error) => Ok(Some(if remote_harness_is_missing(error.code()) {
                    HARNESS_UNAVAILABLE_REASON
                } else {
                    RECIPIENT_OFFLINE_REASON
                })),
            }
        }
    }
}

/// The execution target a queued dispatch is already frozen to, when one exists.
///
/// A reservation that produced a Delivery and a Run is judged by the device that Run was frozen to,
/// never by a member setting that changed afterwards: the Run's own target is what the claim and the
/// Host will honor, so a later switch to another (or offline) device cannot block or reroute it.
enum FrozenExecution {
    /// A remote Run frozen to one Node and harness (`agent_run_execution_target`).
    Remote {
        agent_run_id: String,
        node_id: String,
        adapter_kind: String,
    },
    /// A local Run frozen to one installation (`agent_run.runtime_installation_id`).
    Local {
        installation_id: String,
        adapter_kind: Option<String>,
    },
}

/// What one recorded dispatch already handed out: the device it was frozen to, and whether that
/// device is still a *dispatch* question.
struct ReservedExecution {
    /// The frozen device of the Run this dispatch materialised, or `None` while no Run exists yet.
    frozen: Option<FrozenExecution>,
    /// The Run's own status, when a Run exists.
    run_status: Option<String>,
}

impl ReservedExecution {
    /// True while the device can still decide whether this dispatch may start.
    ///
    /// Upstream `recordFactoryDispatchFailure` writes a `run_dispatch_failed` event only for a Run
    /// that is still `queued` and returns `null` for any other status, and
    /// `dispatch-recovery.db.test.ts` asserts that a claimed Run records no dispatch failure. Here
    /// the same rule covers the Run the Delivery claim materialised: only a `queued` Run (or the
    /// reservation no Run exists for yet) is a dispatch waiting on its device. A Run that is
    /// `running`/`waiting`, or that already ended, proves nothing about a device.
    fn device_is_judged(&self) -> bool {
        matches!(self.run_status.as_deref(), None | Some("queued"))
    }
}

/// The frozen target of the Run this dispatch already started, and that Run's own status.
fn reserved_execution_of_dispatch(
    connection: &Connection,
    dispatch_id: &str,
) -> Result<ReservedExecution> {
    let claimed: Option<(String, Option<String>, Option<String>, String)> = connection
        .query_row(
            "SELECT run.id, run.runtime_installation_id, run.runtime_adapter_kind, run.status
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             JOIN agent_run run ON run.id = delivery.claimed_agent_run_id
             WHERE dispatch.dispatch_id=?1",
            [dispatch_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((agent_run_id, installation_id, adapter_kind, run_status)) = claimed else {
        return Ok(ReservedExecution {
            frozen: None,
            run_status: None,
        });
    };
    let reserved = ReservedExecution {
        frozen: Some(FrozenExecution::Local {
            installation_id: installation_id.clone().unwrap_or_default(),
            adapter_kind: adapter_kind.clone(),
        }),
        run_status: Some(run_status),
    };
    if crate::remote_execution::authority_table_available(connection, "agent_run_execution_target")?
        && let Some(frozen) = crate::remote_execution::load_run_target(connection, &agent_run_id)?
    {
        return Ok(ReservedExecution {
            frozen: Some(FrozenExecution::Remote {
                agent_run_id,
                node_id: frozen.target.node_id,
                adapter_kind: frozen.target.adapter_kind,
            }),
            ..reserved
        });
    }
    Ok(reserved)
}

/// Why this recipient cannot take the Delivery right now, or `None` when it can.
///
/// The order is the upstream one — `disabled`, then `offline`, then `harness` — so the reason names
/// the *first* fact that makes the recipient unusable instead of whichever fact was cheapest to
/// read. Each step is asked only when the step above it passed, and an unreadable fact fails closed
/// into the step it belongs to: nothing here answers "maybe".
///
/// The device judged is the one execution will use: the Run's frozen target when the work was
/// already handed out (`frozen`), otherwise the member's explicit remote Node or the local
/// installation the Agent is bound to now.
fn recipient_failure_reason(
    connection: &Connection,
    camp_id: &str,
    agent_id: &str,
    frozen: Option<&FrozenExecution>,
) -> Result<Option<&'static str>> {
    let switch: Option<RecipientSwitch> = connection
        .query_row(
            "SELECT profile.profile_status,
                    profile.removed_at IS NOT NULL,
                    profile.archived_at IS NOT NULL,
                    member.status,
                    member.leave_requested_at IS NOT NULL,
                    profile.selected_runtime_adapter_kind,
                    profile.default_runtime_installation_id
             FROM agent_profile profile
             LEFT JOIN camp_member member
                    ON member.camp_id=?1 AND member.agent_id=profile.id
             WHERE profile.id=?2",
            params![camp_id, agent_id],
            |row| {
                Ok(RecipientSwitch {
                    profile_status: row.get(0)?,
                    profile_removed: row.get(1)?,
                    profile_archived: row.get(2)?,
                    member_status: row.get(3)?,
                    leave_requested: row.get(4)?,
                    selected_adapter_kind: row.get(5)?,
                    installation_id: row.get(6)?,
                })
            },
        )
        .optional()?;
    let Some(switch) = switch else {
        // An Agent with no profile at all cannot be asked: that is the switch, not a transient
        // absence, so it is never reported as merely offline.
        return Ok(Some(RECIPIENT_DISABLED_REASON));
    };

    // 1. disabled — the recipient is switched off, so nothing below can make it usable.
    if switch.profile_removed
        || switch.profile_archived
        || !matches!(switch.profile_status.as_str(), "present" | "away")
        || switch.member_status.as_deref() != Some("active")
        || switch.leave_requested
    {
        return Ok(Some(RECIPIENT_DISABLED_REASON));
    }

    // 2. offline — the member stands, but it is not present now, or the device it is bound to
    //    cannot be reached.
    if switch.profile_status != "present" {
        return Ok(Some(RECIPIENT_OFFLINE_REASON));
    }
    match frozen {
        Some(FrozenExecution::Local {
            installation_id,
            adapter_kind,
        }) => {
            if let Some(reason) = device_failure_reason(
                connection,
                &Device::Local {
                    installation_id: Some(installation_id.clone()),
                    expected_adapter_kind: adapter_kind.clone(),
                },
            )? {
                return Ok(Some(reason));
            }
        }
        Some(FrozenExecution::Remote {
            agent_run_id,
            node_id,
            adapter_kind,
        }) => {
            if let Some(reason) = device_failure_reason(
                connection,
                &Device::Remote {
                    node_id: node_id.clone(),
                    adapter_kind: adapter_kind.clone(),
                },
            )? {
                return Ok(Some(reason));
            }
            // The Node is there and offers the harness. The rest of the frozen Run's own admission
            // (prepared workspace, frozen bundle source, Run/member scope) is the owner's judgement:
            // an unprovable frozen target is an unusable device, never a harness answer.
            if crate::remote_execution::revalidate_run_claim(connection, agent_run_id).is_err() {
                return Ok(Some(RECIPIENT_OFFLINE_REASON));
            }
        }
        None => {
            let selection = current_remote_selection(connection, agent_id)?;
            match selection {
                Some(selection) => {
                    // The explicit remote choice owns execution: the local installation is only a
                    // disabled placeholder for the Run's foreign key and says nothing about the
                    // Node that will run. Presence and harness are judged in the upstream order
                    // above; what remains (prepared workspace, catalog-backed selection) is the
                    // remote owner's own eligibility.
                    if let Some(reason) = device_failure_reason(
                        connection,
                        &Device::Remote {
                            node_id: selection.node_id.clone(),
                            adapter_kind: selection.adapter_kind.as_str().to_string(),
                        },
                    )? {
                        return Ok(Some(reason));
                    }
                    let availability = crate::member_execution_availability::evaluate(
                        connection,
                        agent_id,
                        // Only the local branch reads these, and it is not the branch being judged.
                        None,
                        &RuntimeReadiness {
                            status: RuntimeReadinessStatus::RuntimeNotConfigured,
                            blockers: Vec::new(),
                        },
                    )?;
                    if !availability.can_launch {
                        return Ok(Some(RECIPIENT_OFFLINE_REASON));
                    }
                }
                None => {
                    if let Some(reason) = device_failure_reason(
                        connection,
                        &Device::Local {
                            installation_id: switch.installation_id.clone(),
                            expected_adapter_kind: switch.selected_adapter_kind.clone(),
                        },
                    )? {
                        return Ok(Some(reason));
                    }
                }
            }
        }
    }

    // The Camp membership rule remains the last word: any fact the ladder above did not name still
    // fails closed under the module's generic code instead of being waved through.
    if !active_member(connection, camp_id, agent_id)? {
        return Ok(Some(RECIPIENT_UNAVAILABLE_REASON));
    }
    Ok(None)
}

/// The member's explicit remote execution choice, when one is saved.
fn current_remote_selection(
    connection: &Connection,
    agent_id: &str,
) -> Result<Option<crate::remote_execution::RemoteMemberSelection>> {
    if !crate::remote_execution::authority_table_available(connection, "member_execution_target")? {
        return Ok(None);
    }
    Ok(crate::remote_execution::load_member_target(connection, agent_id)?.selection)
}

/// The catalog codes that mean "this Node has no usable installation of the selected harness"
/// rather than "the Node is not reachable". The same split the upstream ladder makes between an
/// absent device and an absent harness.
fn remote_harness_is_missing(code: &str) -> bool {
    matches!(
        code,
        "remote_catalog_program_unavailable"
            | "remote_catalog_installation_unavailable"
            | "remote_catalog_identity_malformed"
            | "remote_catalog_generation_out_of_range"
            | "remote_catalog_adapter_ambiguous"
            | "remote_catalog_target_changed"
    )
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

/// True for the reasons that mean "this recipient cannot take the work right now": the three
/// upstream codes plus the module's fail-closed membership code. The identity rejections
/// (`..._not_reviewer`, `..._not_assignee`, …) are not availability facts and never write one.
fn is_recipient_availability_reason(reason: &str) -> bool {
    matches!(
        reason,
        RECIPIENT_UNAVAILABLE_REASON
            | RECIPIENT_DISABLED_REASON
            | RECIPIENT_OFFLINE_REASON
            | HARNESS_UNAVAILABLE_REASON
    )
}

/// True for the two reasons whose winner is the device rather than the switch: the Member still
/// stands, so the work can be reserved and wait for the device. Whether the Camp can actually
/// address that Member is a separate fact (`recipient_is_addressable`), because a Recipient that is
/// present but away wins the presence step and still has no Delivery lane.
fn reserves_while_unavailable(reason: &str) -> bool {
    matches!(
        reason,
        RECIPIENT_OFFLINE_REASON | HARNESS_UNAVAILABLE_REASON
    )
}

/// Whether the Camp's own addressing contract would accept this Recipient right now.
///
/// The exact facts `collaboration::active_address_target` reads: an active Member who has not asked
/// to leave, with a present profile, in a Camp that still exists. A Delivery can only be created for
/// such a Member, so this is what makes a reservation possible at all.
fn recipient_is_addressable(
    connection: &Connection,
    camp_id: &str,
    agent_id: &str,
) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM camp_member member
             JOIN camp ON camp.id = member.camp_id
             JOIN agent_profile profile ON profile.id = member.agent_id
             WHERE member.camp_id=?1 AND member.agent_id=?2
               AND member.status='active' AND member.leave_requested_at IS NULL
               AND profile.profile_status='present'
               AND camp.deletion_operation_id IS NULL
         )",
        params![camp_id, agent_id],
        |row| row.get(0),
    )?)
}

/// The stable identity of one recorded failure, keyed exactly like upstream's
/// `run_dispatch_failed:<runId>:<reasonCode>`: one row per event and reason, whatever happens to
/// `blocked_reason` in between. `event_log.event_id` is `UNIQUE`, so the insert is a
/// compare-and-set at the storage layer.
fn dispatch_failure_event_id(event_identity: &str, reason: &str) -> String {
    format!("{DISPATCH_FAILED_EVENT}:{event_identity}:{reason}")
}

/// One dispatch fact in the domain event log. The facts are permanent: recovery never deletes
/// them, so an offline → disabled → offline round trip stays three recorded judgements about the
/// same event, not one mutable slot.
fn record_dispatch_event(
    transaction: &Transaction<'_>,
    event_id: String,
    event_type: &str,
    camp_id: Option<&str>,
    event: &DispatchEvent,
    payload: serde_json::Value,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO event_log(event_id, event_type, payload_json, camp_id, entity_type, entity_id,
                               actor_type, actor_id, created_at)
         VALUES(?1, ?2, ?3, ?4, 'loom_task', ?5, 'system', 'loom.dispatch', ?6)
         ON CONFLICT(event_id) DO NOTHING",
        params![
            event_id,
            event_type,
            serde_json::to_string(&payload)
                .context("a LOOM dispatch fact must serialise as JSON")?,
            camp_id,
            event.task_id,
            now
        ],
    )?;
    Ok(())
}

/// Record that this event of this Task could not be handed out, and why. A repeated tick with the
/// same verdict stores nothing; a different verdict is its own row.
fn record_dispatch_failure(
    transaction: &Transaction<'_>,
    camp_id: Option<&str>,
    event: &DispatchEvent,
    reason: &str,
    now: &str,
) -> Result<()> {
    record_dispatch_event(
        transaction,
        dispatch_failure_event_id(&event.dedupe_key, reason),
        DISPATCH_FAILED_EVENT,
        camp_id,
        event,
        serde_json::json!({
            "taskId": event.task_id,
            "kind": event.kind,
            "recipientAgentId": event.recipient_agent_id,
            "reasonCode": reason,
            "eventIdentity": event.dedupe_key,
        }),
        now,
    )
}

/// Record that this event became reachable again — once, and only when an earlier pass recorded a
/// failure for it. Upstream's `run_redispatched` is exactly this edge; the work itself is resumed
/// through the same Delivery, so nothing here queues it twice.
fn record_dispatch_recovery(
    transaction: &Transaction<'_>,
    camp_id: Option<&str>,
    event: &DispatchEvent,
    now: &str,
) -> Result<()> {
    let failure_prefix = format!("{DISPATCH_FAILED_EVENT}:{}:", event.dedupe_key);
    let failed: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM event_log WHERE substr(event_id, 1, length(?1)) = ?1)",
        [&failure_prefix],
        |row| row.get(0),
    )?;
    if !failed {
        return Ok(());
    }
    record_dispatch_event(
        transaction,
        format!("{DISPATCH_RECOVERED_EVENT}:{}", event.dedupe_key),
        DISPATCH_RECOVERED_EVENT,
        camp_id,
        event,
        serde_json::json!({
            "taskId": event.task_id,
            "kind": event.kind,
            "recipientAgentId": event.recipient_agent_id,
            "eventIdentity": event.dedupe_key,
        }),
        now,
    )
}

/// Write one of this module's reasons. An existing reason written by somebody else — a User or
/// another owner — is never overwritten, and an unchanged value writes nothing at all: this field
/// is the current-state mirror, while the durable `(event identity, reason)` facts live in the
/// domain event log.
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
           AND (blocked_reason IS NULL OR blocked_reason IN (?5,?6,?7,?8,?9,?10,?11))
           AND (blocked_reason IS NULL OR blocked_reason <> ?1)",
        params![
            reason,
            now,
            plan_id,
            task_id,
            BUDGET_EXHAUSTED_REASON,
            REWORK_EXHAUSTED_REASON,
            PREVIOUS_OUTCOME_REASON,
            RECIPIENT_UNAVAILABLE_REASON,
            RECIPIENT_DISABLED_REASON,
            RECIPIENT_OFFLINE_REASON,
            HARNESS_UNAVAILABLE_REASON
        ],
    )?;
    Ok(())
}

/// Clear this module's own reasons — all of them, including the harness code — and nothing else.
fn clear_control_blocked_reason(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "UPDATE loom_task SET blocked_reason=NULL, updated_at=?1, revision=revision+1
         WHERE plan_id=?2 AND task_id=?3 AND blocked_reason IN (?4,?5,?6,?7,?8,?9,?10)",
        params![
            now,
            plan_id,
            task_id,
            BUDGET_EXHAUSTED_REASON,
            REWORK_EXHAUSTED_REASON,
            PREVIOUS_OUTCOME_REASON,
            RECIPIENT_UNAVAILABLE_REASON,
            RECIPIENT_DISABLED_REASON,
            RECIPIENT_OFFLINE_REASON,
            HARNESS_UNAVAILABLE_REASON
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
