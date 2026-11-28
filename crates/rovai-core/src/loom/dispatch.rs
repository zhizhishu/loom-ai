// upstream: Mikka d59c85cb lib/factory/automatic-dispatch.ts:automaticFactoryDispatch, lib/factory/dispatch.ts:createFactoryDispatch, lib/factory/watchdog.ts:sweepFactoryWatchdog
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
//! Three halves of the upstream module have no counterpart here, and deliberately none of them is a
//! gap a later pass has to fill:
//!
//! * **Cloud dispatch** (`FACTORY_CLOUD_DISPATCH_AVAILABLE`, `switchToCloud`, `CloudKeyConfigured`)
//!   stays unavailable: no pass of this module can start one and no code in it can be turned on to
//!   try, so the upstream `409 cloudDispatchUnavailable` — including the `e2bKeyNotConfigured`
//!   branch behind it — has no path to reach.
//! * **The read-only status half** (`createFactoryDispatchRecovery.status`, BE-16: the reason code is
//!   computed from the device state right now and *nothing* is written) is `dispatch_block_reason`,
//!   which is a pure read of the same facts: no pass, no repair and no mirror write is reachable
//!   from it, so asking it cannot change the answer it is about to give.
//! * **The `#453` clarification payload** (`factoryDispatchClarification`) is a question the upstream
//!   frontend renders with a "wait / switch to cloud" choice, and its two options are exactly the two
//!   facts this module already owns: the wait is the reserved Delivery that resumes by itself, and
//!   the cloud switch is the branch above that does not exist. The Core-facing surface of the same
//!   judgement is `loom_task.blocked_reason`, written only by the durable-fact path and never by a
//!   reader.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use super::super::blocking_dependencies;
use super::super::watchdog::{
    WATCHDOG_MAX_RECOVERIES, WatchdogDecision, WatchdogProgress, WatchdogState,
    factory_watchdog_decision,
};
use super::{LoomControlPolicy, active_member, continuation_successor_run_ids, read_policy};
use crate::agent_profile::{AdapterKind, RuntimeReadiness, RuntimeReadinessStatus};
use crate::collaboration::{
    LoomDispatchAdmission, LoomDispatchAdmissionOutcome, admit_loom_dispatch_message,
};
use crate::db::{
    Database, LoomRecoveryReceipt, WatchdogObservation, next_watchdog_tries,
    record_watchdog_observation, recovery_budget, recovery_exhausted, recovery_receipt,
};

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

/// The one evidence fact that may turn a delivery back to its approved assignee without an
/// explicit `REQUEST_CHANGES`: the trusted Host verification path re-read the Candidate's own
/// evidence and the bytes no longer matched the digest recorded at registration. The receipt is
/// durable and scoped to the standing grant and the exact REVIEW dispatch whose Run performed the
/// check; nothing here trusts an evidence id from the verification payload.
const VERIFICATION_MISMATCH_EVENT: &str = "loom.verification_mismatch";
const VERIFICATION_MISMATCH_REASON: &str = "LOOM_EVIDENCE_HASH_MISMATCH";
const VERIFICATION_MISMATCH_REWORK: &str = "verification_mismatch";

/// The User's own redo decision about a stage-blocked delivery, written by `loom::task_release`.
/// It is the *only* later fact that may hand a `BLOCKED` delivery back to its assignee: the stage
/// verdict itself is never rewritten, deleted or reinterpreted, and a Task someone moved to `READY`
/// by hand still gets no work.
const REWORK_REQUESTED_EVENT: &str = "loom.task_rework_requested";

/// The four `blocked_reason` values the watchdog owns. They are the LOOM spelling of the
/// upstream `attempt.output.watchdog.reasonCode` (`task_stalled`, `external_effect_uncertain`,
/// `stop_unacknowledged`, `recovery_exhausted`): the receipt keeps the upstream literal, this
/// field — the Task's current-state mirror — carries the product-facing code. Nothing else may
/// write these, and the watchdog only ever clears its own.
const WATCHDOG_STALLED_REASON: &str = "loom.watchdog.task_stalled";
const WATCHDOG_EXTERNAL_EFFECT_REASON: &str = "loom.watchdog.external_effect_uncertain";
const WATCHDOG_STOP_TIMEOUT_REASON: &str = "loom.watchdog.stop_unacknowledged";
const WATCHDOG_EXHAUSTED_REASON: &str = "loom.watchdog.recovery_exhausted";
const WATCHDOG_REASONS: [&str; 4] = [
    WATCHDOG_STALLED_REASON,
    WATCHDOG_EXTERNAL_EFFECT_REASON,
    WATCHDOG_STOP_TIMEOUT_REASON,
    WATCHDOG_EXHAUSTED_REASON,
];

/// Upstream `reasonCode` of each hold, as the receipt records it. The decision table compares
/// against the `task_stalled` literal, so the mapping is part of the contract, not a label.
const WATCHDOG_REASON_STALLED: &str = "task_stalled";
const WATCHDOG_REASON_EXTERNAL_EFFECT: &str = "external_effect_uncertain";
const WATCHDOG_REASON_STOP_TIMEOUT: &str = "stop_unacknowledged";
const WATCHDOG_REASON_EXHAUSTED: &str = "recovery_exhausted";

/// Upstream `kind: 'task_watchdog'`: the durable "one actionable blocker" the sweep queues for the
/// Coordinator, and its counterpart once the Task may run again. `event_log.event_id` is unique, so
/// the same hold of the same epoch is stored once whatever happens in between.
///
/// The two identities are per *different* facts, as upstream keys them: a hold is one fact per epoch
/// (`task-watchdog:${task.id}:${task.sourceEventId}`, `watchdog.ts:214`), while a hand-back is one
/// fact per Attempt it minted (`run_redispatched:${runId}`, `dispatch-recovery.ts:150`).
const WATCHDOG_BLOCKED_EVENT: &str = "loom.watchdog_blocked";
const WATCHDOG_RECOVERED_EVENT: &str = "loom.watchdog_recovered";

/// Upstream `LIMIT 40`: one bounded pass never scans an unbounded Task set, so the tick's cost is
/// bounded by the page and the deadline it works against.
const WATCHDOG_SCAN_LIMIT: usize = 40;

/// The marker a retried Attempt's event identity carries. The base event identity is the epoch a
/// watchdog receipt, its budget and its backoff are bound to; a retry is another Attempt of that
/// same epoch, exactly like upstream's `watchdog-retry` event, so the identity is
/// `[<base parts>, "watchdog_retry", <ordinal>]`.
const WATCHDOG_RETRY_MARKER: &str = "watchdog_retry";

/// The reason a superseded Attempt is closed with. A `CANCELLED` dispatch never executed, so the
/// class-level "previous outcome unknown" rule stops treating its failed Run as an unknown result
/// once the watchdog has resolved it by handing the Task back.
const WATCHDOG_SUPERSEDED_REASON: &str = "loom.watchdog.superseded";

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
    /// True for the one trusted evidence-mismatch REWORK: the Task moves `IN_REVIEW` → `READY` in
    /// the same transaction that reserves the repair, while the delivered Candidate stays the chain
    /// head with its `PENDING` acceptance untouched.
    prepare_ready: bool,
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

/// What one LOOM tick did, so the caller can wake exactly the lanes an accepted write created.
///
/// The counters are the upstream sweep's own vocabulary (`scanned`/`recovered`/`blocked`/
/// `deferred`/`failed`), plus the admitted dispatch count the scheduler already reported.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LoomTickOutcome {
    /// Deliveries the admission half of this tick created.
    pub admitted: usize,
    /// Tasks the watchdog observed.
    pub scanned: usize,
    /// Tasks the watchdog handed back to the scheduler after a confirmed stop.
    pub recovered: usize,
    /// Tasks the watchdog held with a durable reason.
    pub blocked: usize,
    /// Tasks whose recorded backoff has not elapsed yet, or whose work was left to another owner.
    pub deferred: usize,
}

impl LoomTickOutcome {
    /// True when a committed hold or recovery has to reach somebody after the write: the blocked
    /// Task needs its Lead, and the resumed Task needs its dispatch lane woken.
    pub(crate) fn watchdog_changed(self) -> bool {
        self.recovered > 0 || self.blocked > 0
    }
}

/// Admit every dispatch the standing policies authorize right now, and report how many Deliveries
/// were created. Reconciliation runs first, so a pass always reacts to what the previous Deliveries
/// actually did instead of re-dispatching on top of an unknown outcome.
pub fn admit_due_dispatches(database: &mut Database) -> Result<usize> {
    Ok(admit_due_dispatches_at(database, chrono::Utc::now())?.admitted)
}

/// The same tick against an explicit clock.
///
/// One tick, in this order and in one `IMMEDIATE` transaction:
///
/// 1. **Reconcile.** Every pending dispatch is folded from the outcome of the Delivery/Run behind it,
///    so nothing below judges a Task against a Run outcome the ledger has not seen yet.
/// 2. **Watchdog.** Each approved Task is observed once (`sweep_watchdog`): the decision table from
///    `loom::watchdog` judges the persisted facts, a hold is written durably, an old executor is
///    asked to stop, and only a Task whose executor demonstrably ended is handed back.
/// 3. **Dispatch.** Due events are admitted, so a Task the watchdog just released is picked up in
///    the very same transaction — and a Task it just held is not, because the hold is part of the
///    event's own admission rules (`event_problem`).
///
/// The clock is an argument rather than a hidden `now()` so a caller — a test, or a future deadline
/// budget — decides which instant the pass judges, exactly as the pure decision table does.
pub(crate) fn admit_due_dispatches_at(
    database: &mut Database,
    now: DateTime<Utc>,
) -> Result<LoomTickOutcome> {
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now_text = now.to_rfc3339();

    reconcile_dispatches(&transaction, &now_text)?;

    // The sweep judges every Task against the instant this pass was opened, never against a second
    // reading of the wall clock halfway through the transaction.
    let watchdog = sweep_watchdog(&transaction, now)?;

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

    let mut admitted = watchdog.admitted;
    for (plan_id, mission_id) in plans {
        if admitted >= MAX_DISPATCHES_PER_TICK {
            break;
        }
        admitted += admit_plan(
            &transaction,
            &plan_id,
            &mission_id,
            &now_text,
            MAX_DISPATCHES_PER_TICK - admitted,
            None,
        )?;
    }
    transaction.commit()?;
    Ok(LoomTickOutcome {
        admitted,
        ..watchdog
    })
}

/// One dispatch the completion hook of a finished Run may fold, selected by the persisted claim.
struct ClaimedDispatch {
    dispatch_id: String,
    plan_id: String,
    task_id: String,
    mission_id: String,
    policy_revision: i64,
    delivery_status: String,
    failure_code: Option<String>,
    run_status: Option<String>,
}

/// The per-Run completion path (upstream BE-9 `reconcile.run`): fold only the dispatch whose
/// Delivery this very Run claimed, at the Run's own execution epoch, then admit the same Task's
/// next due event. The standing authorization, the Task scope and the attempt are re-proved under
/// the write lock, so a callback from a replaced execution, a stale Run, a superseded or expired
/// approval or a Run that is not terminal yet has no effect here and stays the global sweep's
/// work ([`admit_due_dispatches_at`]). No watchdog pass runs here: the hook owns one completed Run,
/// never a Plan's whole lane.
pub(crate) fn reconcile_completed_run_at(
    database: &mut Database,
    agent_run_id: &str,
    execution_epoch: i64,
    now: DateTime<Utc>,
) -> Result<usize> {
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now_text = now.to_rfc3339();

    // Selection is the ledger's own claim chain: camp_message_delivery.claimed_agent_run_id →
    // dispatch → plan/task, pinned to the callback's execution epoch. A replaced execution's stale
    // callback, an ordinary (non-dispatch) Delivery and a Run that claimed no LOOM work select
    // nothing here.
    let mut claimed: Vec<ClaimedDispatch> = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT dispatch.dispatch_id, dispatch.plan_id, dispatch.task_id, plan.mission_id,
                    dispatch.policy_revision, delivery.status, delivery.failure_code, run.status
             FROM loom_control_dispatch dispatch
             JOIN loom_plan plan ON plan.plan_id = dispatch.plan_id
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             JOIN agent_run run ON run.id = delivery.claimed_agent_run_id
             WHERE run.id = ?1 AND run.execution_epoch = ?2
               AND dispatch.status IN ('WAITING','DISPATCHED')
             ORDER BY dispatch.created_at, dispatch.dispatch_id",
        )?;
        let mapped = statement.query_map(params![agent_run_id, execution_epoch], |row| {
            Ok(ClaimedDispatch {
                dispatch_id: row.get(0)?,
                plan_id: row.get(1)?,
                task_id: row.get(2)?,
                mission_id: row.get(3)?,
                policy_revision: row.get(4)?,
                delivery_status: row.get(5)?,
                failure_code: row.get(6)?,
                run_status: row.get(7)?,
            })
        })?;
        for row in mapped {
            claimed.push(row?);
        }
    }

    let mut admitted = 0usize;
    let mut scoped_tasks: Vec<(String, String, String)> = Vec::new();
    for claimed_dispatch in claimed {
        let ClaimedDispatch {
            dispatch_id,
            plan_id,
            task_id,
            mission_id,
            policy_revision,
            delivery_status,
            failure_code,
            run_status,
        } = claimed_dispatch;
        // The facts that admitted this dispatch are re-proved under the write lock, exactly as
        // `admit_plan` proves them before it reserves an event: an approval that has been paused,
        // expired, re-scoped or re-granted since the Run started keeps this callback silent.
        let Some(policy) = read_policy(&transaction, &plan_id)? else {
            continue;
        };
        if !policy.enabled || policy.paused || policy.mission_id != mission_id {
            continue;
        }
        let Some(expires_at) = policy.expires_at.as_deref() else {
            continue;
        };
        if !expiry_is_future(expires_at, &now_text) {
            continue;
        }
        if !policy.task_ids.iter().any(|scoped| *scoped == task_id) {
            continue;
        }
        if policy.authorization_revision != policy_revision {
            continue;
        }
        // The attempt is judged from the terminal state the callback committed. A Run that is
        // still going proves nothing: the fold waits for the success/failure commit, never reads
        // a settlement out of a running Run.
        let terminal = run_status
            .as_deref()
            .is_some_and(|status| matches!(status, "succeeded" | "failed" | "cancelled"));
        if !terminal {
            continue;
        }
        fold_dispatch_outcome(
            &transaction,
            &dispatch_id,
            &delivery_status,
            failure_code.as_deref(),
            run_status.as_deref(),
            &now_text,
        )?;
        if !scoped_tasks
            .iter()
            .any(|(scoped_plan, _, task)| *scoped_plan == plan_id && *task == task_id)
        {
            scoped_tasks.push((plan_id, mission_id, task_id));
        }
    }

    // With the matched dispatch folded, only the same Task's next event is admitted — the shared
    // decision table restricted to this Task, never a second scheduler for the Plan.
    for (plan_id, mission_id, task_id) in scoped_tasks {
        admitted += admit_plan(
            &transaction,
            &plan_id,
            &mission_id,
            &now_text,
            MAX_DISPATCHES_PER_TICK - admitted,
            Some(&task_id),
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
    scoped_task_id: Option<&str>,
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

    let mut events = due_events(transaction, plan_id, mission_id, &policy, now, scoped_task_id)?;
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
                if event.prepare_ready {
                    // The trusted mismatch repair keeps the delivered Candidate exactly as it was —
                    // still the chain head, still `PENDING` — and only returns the Task to READY so
                    // the approved assignee may chain a new Candidate onto it.
                    transaction.execute(
                        "UPDATE loom_task SET status='READY', blocked_reason=NULL,
                                             updated_at=?1, revision=revision+1
                         WHERE plan_id=?2 AND task_id=?3 AND status='IN_REVIEW'",
                        params![now, plan_id, &event.task_id],
                    )?;
                    transaction.execute(
                        "UPDATE loom_claim SET released_at=?1
                         WHERE plan_id=?2 AND task_id=?3 AND released_at IS NULL",
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

/// The single REVIEW dispatch the standing grant wrote for one Candidate, and the Run that actually
/// claimed its Delivery. This is the only source a verification mismatch may be bound to; the
/// evidence ids in a verification payload are never consulted for it.
struct ReviewCheckSource {
    dispatch_id: String,
    agent_run_id: String,
    execution_epoch: i64,
    run_status: String,
}

fn review_check_source(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
    candidate_id: &str,
    policy_revision: i64,
) -> Result<Option<ReviewCheckSource>> {
    let mut rows: Vec<ReviewCheckSource> = Vec::new();
    {
        let mut statement = connection.prepare(
            "SELECT dispatch.dispatch_id, run.id, run.execution_epoch, run.status
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             JOIN agent_run run ON run.id = delivery.claimed_agent_run_id
             WHERE dispatch.plan_id=?1 AND dispatch.task_id=?2 AND dispatch.kind='REVIEW'
               AND dispatch.candidate_id=?3 AND dispatch.policy_revision=?4
               AND dispatch.status <> 'CANCELLED'
             ORDER BY dispatch.created_at, dispatch.dispatch_id",
        )?;
        let mapped = statement.query_map(
            params![plan_id, task_id, candidate_id, policy_revision],
            |row| {
                Ok(ReviewCheckSource {
                    dispatch_id: row.get(0)?,
                    agent_run_id: row.get(1)?,
                    execution_epoch: row.get(2)?,
                    run_status: row.get(3)?,
                })
            },
        )?;
        for row in mapped {
            rows.push(row?);
        }
    }
    // No check source, or more than one competing source, is not a fact this module may act on.
    if rows.len() != 1 {
        return Ok(None);
    }
    Ok(rows.pop())
}

/// The stable receipt identity of one trusted evidence mismatch: the Plan, Task, Candidate, standing
/// authorization, the REVIEW dispatch that asked for the check and the execution epoch of the Run
/// that performed it. A second verification call over the same fact can only replay this id.
fn verification_mismatch_event_id(
    plan_id: &str,
    task_id: &str,
    candidate_id: &str,
    policy_revision: i64,
    dispatch_id: &str,
    execution_epoch: i64,
) -> Result<String> {
    let revision = policy_revision.to_string();
    let epoch = execution_epoch.to_string();
    let identity = dedupe_key(&[
        VERIFICATION_MISMATCH_EVENT,
        plan_id,
        task_id,
        candidate_id,
        revision.as_str(),
        dispatch_id,
        epoch.as_str(),
    ])?;
    Ok(format!(
        "{VERIFICATION_MISMATCH_EVENT}:{:x}",
        Sha256::digest(identity.as_bytes())
    ))
}

/// Record the trusted evidence-mismatch receipt, once per scoped fact.
///
/// The caller is the Host verification path that has already re-read the Candidate's own evidence
/// and produced `LOOM_EVIDENCE_HASH_MISMATCH`. Everything else is re-proved here: the standing
/// authorization, the Task's `IN_REVIEW` state, the Candidate as the chain head with `PENDING`
/// acceptance, and the unique REVIEW dispatch whose claimed Run is the check source. A missing or
/// ambiguous source writes nothing and returns `None`; the verification error is still returned by
/// the caller.
pub(crate) fn record_verification_mismatch(
    connection: &Connection,
    mission_id: &str,
    plan_id: &str,
    task_id: &str,
    candidate_id: &str,
    evidence_id: &str,
    now: &str,
) -> Result<Option<String>> {
    let Some(policy) = read_policy(connection, plan_id)? else {
        return Ok(None);
    };
    if !policy.enabled || policy.paused || policy.mission_id != mission_id {
        return Ok(None);
    }
    let Some(expires_at) = policy.expires_at.as_deref() else {
        return Ok(None);
    };
    if !expiry_is_future(expires_at, now) {
        return Ok(None);
    }
    if !policy.task_ids.iter().any(|scoped| scoped == task_id) {
        return Ok(None);
    }

    let task_status: Option<String> = connection
        .query_row(
            "SELECT status FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![plan_id, task_id],
            |row| row.get(0),
        )
        .optional()?;
    if task_status.as_deref() != Some("IN_REVIEW") {
        return Ok(None);
    }
    let latest: Option<(String, String)> = connection
        .query_row(
            "SELECT candidate_id, acceptance_status FROM loom_candidate
             WHERE plan_id=?1 AND task_id=?2 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![plan_id, task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if !matches!(
        latest,
        Some((ref latest_id, ref acceptance))
            if latest_id == candidate_id && acceptance == "PENDING"
    ) {
        return Ok(None);
    }
    let Some(source) = review_check_source(
        connection,
        plan_id,
        task_id,
        candidate_id,
        policy.authorization_revision,
    )? else {
        return Ok(None);
    };

    let event_id = verification_mismatch_event_id(
        plan_id,
        task_id,
        candidate_id,
        policy.authorization_revision,
        &source.dispatch_id,
        source.execution_epoch,
    )?;
    let camp_id: Option<String> = connection
        .query_row("SELECT camp_id FROM mission WHERE id=?1", [mission_id], |row| {
            row.get(0)
        })
        .optional()?;
    let payload = serde_json::json!({
        "missionId": mission_id,
        "planId": plan_id,
        "taskId": task_id,
        "candidateId": candidate_id,
        "policyRevision": policy.authorization_revision,
        "reviewDispatchId": source.dispatch_id,
        "reviewAgentRunId": source.agent_run_id,
        "executionEpoch": source.execution_epoch,
        "evidenceId": evidence_id,
        "reasonCode": VERIFICATION_MISMATCH_REASON,
    });
    connection.execute(
        "INSERT INTO event_log(event_id,event_type,payload_json,camp_id,entity_type,entity_id,
                               actor_type,actor_id,created_at)
         VALUES(?1,?2,?3,?4,'loom_task',?5,'system','loom.verification',?6)
         ON CONFLICT(event_id) DO NOTHING",
        params![
            &event_id,
            VERIFICATION_MISMATCH_EVENT,
            serde_json::to_string(&payload)
                .context("a LOOM verification mismatch fact must serialise as JSON")?,
            camp_id,
            task_id,
            now
        ],
    )?;
    Ok(Some(event_id))
}

/// The repair fact the scheduler may consume: the same receipt identity, re-proved against the
/// ledger. The original check must have ended, the Candidate must still be the chain head with
/// `PENDING` acceptance, no successor may exist, and no other Run may still hold the Task. The
/// optional `excluding_dispatch_id` is the REWORK reservation being rechecked: its own queued Run
/// is the work about to start, not an "other" live Run.
struct VerificationMismatchFact {
    event_id: String,
}

fn trusted_verification_mismatch(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
    candidate_id: &str,
    policy_revision: i64,
    excluding_dispatch_id: Option<&str>,
) -> Result<Option<VerificationMismatchFact>> {
    let Some(source) = review_check_source(
        connection,
        plan_id,
        task_id,
        candidate_id,
        policy_revision,
    )? else {
        return Ok(None);
    };
    if !matches!(
        source.run_status.as_str(),
        "succeeded" | "failed" | "cancelled"
    ) {
        return Ok(None);
    }
    let latest: Option<(String, String)> = connection
        .query_row(
            "SELECT candidate_id, acceptance_status FROM loom_candidate
             WHERE plan_id=?1 AND task_id=?2 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![plan_id, task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if !matches!(
        latest,
        Some((ref latest_id, ref acceptance))
            if latest_id == candidate_id && acceptance == "PENDING"
    ) {
        return Ok(None);
    }
    let successor: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loom_candidate
                       WHERE plan_id=?1 AND previous_candidate_id=?2 AND candidate_id<>?2)",
        params![plan_id, candidate_id],
        |row| row.get(0),
    )?;
    if successor {
        return Ok(None);
    }
    let live_run: bool = connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_run run
             WHERE run.status IN ('queued','running','waiting')
               AND run.id <> COALESCE(
                   (SELECT delivery.claimed_agent_run_id
                    FROM loom_control_dispatch dispatch
                    JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
                    WHERE dispatch.dispatch_id = ?3), '')
               AND (run.id IN (SELECT claim.agent_run_id FROM loom_claim claim
                               WHERE claim.plan_id=?1 AND claim.task_id=?2
                                 AND claim.released_at IS NULL)
                    OR run.id IN (SELECT delivery.claimed_agent_run_id
                                  FROM loom_control_dispatch dispatch
                                  JOIN camp_message_delivery delivery
                                    ON delivery.id = dispatch.delivery_id
                                  WHERE dispatch.plan_id=?1 AND dispatch.task_id=?2))
         )",
        params![plan_id, task_id, excluding_dispatch_id],
        |row| row.get(0),
    )?;
    if live_run {
        return Ok(None);
    }

    let event_id = verification_mismatch_event_id(
        plan_id,
        task_id,
        candidate_id,
        policy_revision,
        &source.dispatch_id,
        source.execution_epoch,
    )?;
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload_json FROM event_log
             WHERE event_id=?1 AND event_type=?2 AND entity_type='loom_task' AND entity_id=?3",
            params![&event_id, VERIFICATION_MISMATCH_EVENT, task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    let payload: serde_json::Value = serde_json::from_str(&payload)
        .context("a recorded LOOM verification mismatch fact must be JSON")?;
    let same_fact = payload.get("planId").and_then(serde_json::Value::as_str)
        == Some(plan_id)
        && payload.get("taskId").and_then(serde_json::Value::as_str) == Some(task_id)
        && payload.get("candidateId").and_then(serde_json::Value::as_str)
            == Some(candidate_id)
        && payload.get("policyRevision").and_then(serde_json::Value::as_i64)
            == Some(policy_revision)
        && payload.get("reviewDispatchId").and_then(serde_json::Value::as_str)
            == Some(source.dispatch_id.as_str())
        && payload.get("reviewAgentRunId").and_then(serde_json::Value::as_str)
            == Some(source.agent_run_id.as_str())
        && payload
            .get("executionEpoch")
            .and_then(serde_json::Value::as_i64)
            == Some(source.execution_epoch)
        && payload.get("reasonCode").and_then(serde_json::Value::as_str)
            == Some(VERIFICATION_MISMATCH_REASON);
    Ok(same_fact.then_some(VerificationMismatchFact { event_id }))
}

/// Every event the standing policy authorizes right now, in Task order. One Task contributes at
/// most one event per pass: its facts decide which one it is. `scoped_task_id` narrows the pass to
/// one Task's own next event (the per-Run completion path); `None` sweeps the whole policy scope.
fn due_events(
    transaction: &Transaction<'_>,
    plan_id: &str,
    mission_id: &str,
    policy: &LoomControlPolicy,
    now: &str,
    scoped_task_id: Option<&str>,
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
        if scoped_task_id.is_some_and(|scoped| scoped != task_id.as_str()) {
            continue;
        }
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
                    prepare_ready: false,
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
                        // A trusted verification mismatch is the one repair fact that may return
                        // this very Candidate to its approved assignee: the Host re-read the
                        // Candidate's own evidence, the check came from the REVIEW dispatch this
                        // grant actually wrote, that Run has ended, and no successor exists. The
                        // original Candidate and the Owner's acceptance axis stay untouched.
                        if let Some(receipt) = trusted_verification_mismatch(
                            transaction,
                            plan_id,
                            task_id,
                            &candidate_id,
                            policy.authorization_revision,
                            None,
                        )? {
                            let Some(assignee) =
                                assignee.clone().filter(|assignee| !assignee.is_empty())
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
                                    candidate_id.as_str(),
                                    VERIFICATION_MISMATCH_REWORK,
                                    receipt.event_id.as_str(),
                                ])?,
                                release_task: false,
                                prepare_ready: true,
                            }
                        } else {
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
                                prepare_ready: false,
                            }
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
                            prepare_ready: false,
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
                            prepare_ready: false,
                        }
                    }
                    // The User's redo decision: the stage verdict is still `BLOCKED` — never
                    // rewritten — but the Owner released the Task afterwards and asked for the same
                    // delivery to be redone. The REWORK is exactly the one a `REQUEST_CHANGES`
                    // verdict sends: same recipient, same dedupe on that stage verdict, same
                    // per-Task rework budget. A `BLOCKED` verdict nobody released still stops the
                    // Task right here.
                    Some("BLOCKED") => {
                        if status != "READY" {
                            continue;
                        }
                        if !stage_block_rework_requested(
                            transaction,
                            plan_id,
                            task_id,
                            &candidate_id,
                            policy.authorization_revision,
                        )? {
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
                            prepare_ready: false,
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
        match prior_outcome_of_class(
            transaction,
            plan_id,
            &event.task_id,
            event.kind,
            None,
            Some(policy.authorization_revision),
        )? {
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

    // A Task the watchdog holds — a stalled executor, an external effect with an uncertain receipt,
    // a stop the old executor never acknowledged, or an exhausted recovery budget — is not handed
    // out again. The hold is what makes a replay impossible until the watchdog releases it: the
    // scheduler asks this before it mints an event, and the pre-execution recheck asks it again
    // immediately before a reserved Delivery starts. Releasing the hold is the watchdog's own write,
    // so a Task it just resumed is admitted by the very same tick.
    if let Some(reason) = watchdog_hold_reason(transaction, plan_id, task_id)? {
        return Ok(Some(reason));
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
            // Who judges is the Owner's assignment, never a choice this scheduler makes: upstream
            // `automatic-dispatch.ts` queues every stage for its assigned recipient and asks no
            // session-independence question of its own. Whether the reviewer's session is an
            // independent observer is `lib/factory/check-independence.ts`'s rule, applied where a
            // reviewing Run actually exists (`control::stage_review_record`). Judging it here would
            // refuse a legitimate assignment while still being unable to see a continuation edge
            // that no Run has recorded yet.
            // An earlier review of this Candidate must have ended with a verdict before a new
            // authorization may ask for another one: a Candidate that nobody judged is not re-asked
            // under a fresh approval. Only the *standing* authorization counts: a request written
            // under a grant the Owner has since replaced can never be answered — a verdict must be
            // written under the standing revision, and the request's own binding names the old one —
            // so counting it would park the Candidate on a request nobody can satisfy.
            let unjudged_reviews: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM loom_control_dispatch dispatch
                 WHERE dispatch.plan_id=?1 AND dispatch.task_id=?2 AND dispatch.kind='REVIEW'
                   AND dispatch.candidate_id=?3
                   AND dispatch.policy_revision=?5
                   AND dispatch.dispatch_id <> COALESCE(?4,'')
                   AND dispatch.status <> 'CANCELLED'
                   AND NOT EXISTS(SELECT 1 FROM loom_stage_review review
                                  WHERE review.candidate_id=dispatch.candidate_id
                                    AND review.policy_revision=dispatch.policy_revision)",
                params![
                    plan_id,
                    task_id,
                    latest_id,
                    excluding_dispatch_id,
                    authorization_revision
                ],
                |row| row.get(0),
            )?;
            if unjudged_reviews > 0 {
                return Ok(Some(PREVIOUS_OUTCOME_REASON));
            }
        }
        REWORK => {
            let Some((latest_id, acceptance, _)) = latest_candidate else {
                return Ok(Some("loom.dispatch_candidate_missing"));
            };
            if candidate_id != Some(latest_id.as_str()) {
                return Ok(Some("loom.dispatch_candidate_stale"));
            }
            // Normally only an explicit `REQUEST_CHANGES` verdict returns a delivery to its
            // assignee. The one exception is the trusted evidence-mismatch receipt: the Host
            // re-read this very Candidate's evidence, the check came from the standing grant's
            // REVIEW dispatch, and that Run has ended without a successor. A written verdict of
            // any kind still owns the outcome, so the exception only applies while the stage holds
            // no verdict at all.
            let verification_mismatch = if current_stage.is_none() {
                trusted_verification_mismatch(
                    transaction,
                    plan_id,
                    task_id,
                    &latest_id,
                    authorization_revision,
                    excluding_dispatch_id,
                )?
            } else {
                None
            };
            if verification_mismatch.is_some() {
                if task_status != "READY" && task_status != "IN_REVIEW" {
                    return Ok(Some("loom.dispatch_task_not_ready"));
                }
                if acceptance != "PENDING" {
                    return Ok(Some("loom.dispatch_already_settled_by_owner"));
                }
            } else {
                if task_status != "READY" {
                    return Ok(Some("loom.dispatch_task_not_ready"));
                }
                // The same two doors as the decision table: an explicit `REQUEST_CHANGES`, or the
                // User's own redo decision recorded after a `BLOCKED` verdict. The block is read
                // again here, under the lock, so a reserved REWORK Delivery whose Task was parked
                // in the meantime cannot start.
                let rework_requested = match current_stage.as_deref() {
                    Some("REQUEST_CHANGES") => true,
                    Some("BLOCKED") => stage_block_rework_requested(
                        transaction,
                        plan_id,
                        task_id,
                        &latest_id,
                        authorization_revision,
                    )?,
                    _ => false,
                };
                if !rework_requested {
                    return Ok(Some("loom.dispatch_rework_not_requested"));
                }
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
        Some(authorization_revision),
    )? {
        PriorOutcome::Completed | PriorOutcome::NotExecuted => Ok(recipient_problem),
        PriorOutcome::Pending | PriorOutcome::Failed => Ok(Some(PREVIOUS_OUTCOME_REASON)),
    }
}

/// The worst outcome among the earlier dispatches of this Task/kind, or `Completed` when every one
/// of them is either proven finished or never started.
///
/// `standing_authorization` only matters for `REVIEW`: a review request written under an
/// authorization the Owner has since replaced can never be answered, because a verdict has to be
/// written under the standing revision while the request's own binding names the old one. Treating
/// such a request as a pending unknown outcome would keep the Candidate from ever being reviewed
/// again, so it is not counted against the standing grant.
fn prior_outcome_of_class(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
    kind: &str,
    excluding_dispatch_id: Option<&str>,
    standing_authorization: Option<i64>,
) -> Result<PriorOutcome> {
    let mut dispatches: Vec<(String, i64, String)> = Vec::new();
    {
        let mut statement = connection.prepare(
            "SELECT dispatch_id, policy_revision, status FROM loom_control_dispatch
             WHERE plan_id=?1 AND task_id=?2 AND kind=?3
             ORDER BY created_at, dispatch_id",
        )?;
        let rows = statement.query_map(params![plan_id, task_id, kind], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        for row in rows {
            dispatches.push(row?);
        }
    }
    let mut worst = PriorOutcome::Completed;
    for (dispatch_id, policy_revision, status) in dispatches {
        if excluding_dispatch_id == Some(dispatch_id.as_str()) {
            continue;
        }
        // A `CANCELLED` dispatch never executed: its Delivery was cancelled before the work started,
        // or the watchdog closed the Attempt it resolved by handing the Task back. It is not an
        // unknown outcome of this class and must not keep the successor closed.
        if status == "CANCELLED" {
            continue;
        }
        if kind == REVIEW
            && standing_authorization.is_some_and(|standing| policy_revision != standing)
        {
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
        fold_dispatch_outcome(
            &transaction,
            &dispatch_id,
            &delivery_status,
            failure_code.as_deref(),
            run_status.as_deref(),
            now,
        )?;
    }
    reconcile_superseded_handoffs(transaction, now)?;
    reconcile_manual_continuation_dispatches(transaction, now)?;
    Ok(())
}

/// Close a lost verification handoff only when its durable successor fact already exists. This is
/// reconciliation, not replay: the unknown Run is not restarted or treated as successful, but once
/// the current Candidate is no longer awaiting the Owner (or the Task is already done), keeping the
/// handoff blocked would misrepresent a chain whose verification lane has been superseded by the
/// Owner-visible outcome itself.
fn reconcile_superseded_handoffs(transaction: &Transaction<'_>, now: &str) -> Result<()> {
    transaction.execute(
        "UPDATE loom_control_dispatch
         SET status='SETTLED', reason='loom.dispatch_handoff_reconciled', updated_at=?1
         WHERE status='BLOCKED' AND kind='HANDOFF'
           AND reason='accepted_input_outcome_unknown'
           AND candidate_id = (
               SELECT candidate_id FROM loom_candidate latest
               WHERE latest.plan_id=loom_control_dispatch.plan_id
                 AND latest.task_id=loom_control_dispatch.task_id
               ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
           AND EXISTS(
               SELECT 1 FROM loom_task task
               JOIN loom_candidate candidate ON candidate.plan_id=task.plan_id
                    AND candidate.task_id=task.task_id
                    AND candidate.candidate_id=loom_control_dispatch.candidate_id
               WHERE task.plan_id=loom_control_dispatch.plan_id
                 AND task.task_id=loom_control_dispatch.task_id
                 AND (task.status='DONE' OR candidate.acceptance_status<>'PENDING'))",
        [now],
    )?;
    Ok(())
}

/// Whether an explicit User continuation of `source_run_id` produced the durable fact this
/// dispatch was asking for. Starting a continuation proves nothing; only the same successor fact
/// that would have settled the original Run closes the unknown outcome.
fn manual_continuation_output_reached(
    transaction: &Transaction<'_>,
    kind: &str,
    plan_id: &str,
    task_id: &str,
    candidate_id: Option<&str>,
    policy_revision: i64,
    source_run_id: &str,
) -> Result<bool> {
    let successors = continuation_successor_run_ids(transaction, source_run_id)?;
    if successors.is_empty() {
        return Ok(false);
    }
    match kind {
        EXECUTE => {
            for run_id in successors {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM loom_candidate
                                   WHERE plan_id=?1 AND task_id=?2 AND agent_run_id=?3)",
                    params![plan_id, task_id, run_id],
                    |row| row.get(0),
                )?;
                if exists {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        REVIEW => {
            let Some(candidate_id) = candidate_id else {
                return Ok(false);
            };
            for run_id in successors {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM loom_stage_review
                                   WHERE plan_id=?1 AND candidate_id=?2 AND policy_revision=?3
                                     AND reviewer_agent_run_id=?4)",
                    params![plan_id, candidate_id, policy_revision, run_id],
                    |row| row.get(0),
                )?;
                if exists {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        REWORK => {
            let Some(candidate_id) = candidate_id else {
                return Ok(false);
            };
            for run_id in successors {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM loom_candidate
                                   WHERE plan_id=?1 AND previous_candidate_id=?2 AND agent_run_id=?3)",
                    params![plan_id, candidate_id, run_id],
                    |row| row.get(0),
                )?;
                if exists {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        HANDOFF => {
            for run_id in successors {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM camp_message_delivery
                                   WHERE claimed_agent_run_id=?1 AND status='settled')",
                    [run_id],
                    |row| row.get(0),
                )?;
                if exists {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}

/// Close an unknown dispatch only after its User-authorized continuation creates the durable
/// output the original dispatch required. This is still not a replay: the continuation itself is
/// the User's explicit decision, and the ledger listens only for persisted successor facts.
fn reconcile_manual_continuation_dispatches(transaction: &Transaction<'_>, now: &str) -> Result<()> {
    let rows = {
        let mut statement = transaction.prepare(
            "SELECT dispatch.dispatch_id, dispatch.plan_id, dispatch.task_id, dispatch.kind,
                    dispatch.candidate_id, dispatch.policy_revision, delivery.claimed_agent_run_id
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             WHERE dispatch.status='BLOCKED' AND dispatch.reason='accepted_input_outcome_unknown'
               AND delivery.claimed_agent_run_id IS NOT NULL
             ORDER BY dispatch.created_at, dispatch.dispatch_id",
        )?;
        let mapped = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (dispatch_id, plan_id, task_id, kind, candidate_id, policy_revision, source_run_id) in rows {
        if manual_continuation_output_reached(
            transaction,
            &kind,
            &plan_id,
            &task_id,
            candidate_id.as_deref(),
            policy_revision,
            &source_run_id,
        )? {
            transaction.execute(
                "UPDATE loom_control_dispatch
                 SET status='SETTLED', reason='loom.dispatch_manual_continuation_reconciled', updated_at=?2
                 WHERE dispatch_id=?1 AND status='BLOCKED' AND reason='accepted_input_outcome_unknown'",
                params![dispatch_id, now],
            )?;
        }
    }
    Ok(())
}

/// Fold one recorded dispatch's real Delivery/Run outcome into the ledger. The successor-fact
/// reading is shared by the global sweep and the per-Run hook, so both fold a claim from the same
/// judgement and neither invents its own.
fn fold_dispatch_outcome(
    transaction: &Transaction<'_>,
    dispatch_id: &str,
    delivery_status: &str,
    failure_code: Option<&str>,
    run_status: Option<&str>,
    now: &str,
) -> Result<()> {
    let settled = match (delivery_status, run_status) {
        // Transport settlement is not a domain fact for EXECUTE/REVIEW/REWORK. The same
        // successor-fact test used for a succeeded Run decides whether this dispatch truly
        // finished; HANDOFF is the exception encoded inside `prior_dispatch_outcome` itself.
        ("settled", _) => match prior_dispatch_outcome(transaction, dispatch_id)? {
            PriorOutcome::Completed => Some(("SETTLED", None)),
            _ => Some((
                "BLOCKED",
                Some("loom.dispatch_previous_outcome_unknown"),
            )),
        },
        ("failed", _) => Some((
            "BLOCKED",
            Some(failure_code.unwrap_or("loom.dispatch_failed")),
        )),
        ("cancelled", _) => Some(("CANCELLED", None)),
        (_, Some("failed")) => Some(("BLOCKED", Some("loom.dispatch_run_failed"))),
        (_, Some("cancelled")) => Some(("CANCELLED", None)),
        // A Delivery that is still only claimed proves nothing either way, and a Run that is
        // still going proves nothing at all: the ledger may only be folded from a finished Run,
        // and then only from the matching successor fact of that very dispatch — the Candidate
        // produced by this Run, the stage verdict written by this reviewer Run under this
        // Candidate and policy revision, the rework chained onto this Candidate, or a settled
        // handoff.
        (_, Some("succeeded")) => match prior_dispatch_outcome(transaction, dispatch_id)? {
            PriorOutcome::Completed => Some(("SETTLED", None)),
            _ => None,
        },
        _ => None,
    };
    let Some((status, reason)) = settled else {
        return Ok(());
    };
    transaction.execute(
        "UPDATE loom_control_dispatch SET status=?1, reason=?2, updated_at=?3
         WHERE dispatch_id=?4",
        params![status, reason, now, dispatch_id],
    )?;
    Ok(())
}

/// The stable epoch identity of one recorded dispatch (upstream `sourceEventId`).
///
/// A LOOM event identity is the dedupe key: a JSON array of the facts that make one dispatch the
/// dispatch it is. Two things follow. A retried Attempt must stay in the *same* epoch, so the retry
/// suffix is stripped here; and the ledger column is bounded at 120 characters while a legal Task
/// id is up to 200, which makes a REVIEW identity longer than any receipt column may hold. The
/// epoch is therefore a digest of that identity: stable, bounded, and never a value that can abort
/// the whole tick because one identifier happens to be long.
pub(crate) fn request_epoch(dedupe_key: &str) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(base_event_identity(dedupe_key).as_bytes());
    let mut hex = String::with_capacity(70);
    hex.push_str("epoch:");
    for byte in digest.iter() {
        hex.push(DIGITS[usize::from(byte >> 4)] as char);
        hex.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    hex
}

/// The event identity a retried Attempt belongs to: the recorded dedupe key without the
/// `watchdog_retry` suffix. A key that is not that shape is its own base.
fn base_event_identity(dedupe_key: &str) -> String {
    let Ok(parts) = serde_json::from_str::<Vec<String>>(dedupe_key) else {
        return dedupe_key.to_string();
    };
    if parts.len() >= 2 && parts[parts.len() - 2] == WATCHDOG_RETRY_MARKER {
        if let Ok(base) = serde_json::to_string(&parts[..parts.len() - 2]) {
            return base;
        }
    }
    dedupe_key.to_string()
}

/// The event identity of one retried Attempt of `base` (upstream's `watchdog-retry` event).
fn retry_dedupe_key(base: &str, ordinal: i64) -> Result<String> {
    let mut parts: Vec<String> = serde_json::from_str(base)
        .context("a recorded LOOM dispatch identity must be a JSON array of strings")?;
    parts.push(WATCHDOG_RETRY_MARKER.to_string());
    parts.push(ordinal.to_string());
    let parts = parts.iter().map(String::as_str).collect::<Vec<_>>();
    dedupe_key(&parts)
}

/// One Task the sweep observes, with every fact the decision table reads already resolved.
///
/// The facts are the persisted ones and nothing else: the Task row, the current Attempt (its
/// dispatch, its Delivery, its claim) and the Run behind it. Lease and heartbeat timestamps are
/// deliberately absent — `agent_run.execution_lease_expires_at`, `loom_claim.lease_expires_at` and
/// `execution_node.last_heartbeat` say that a process is *alive*, never that it made progress, so a
/// hung executor that keeps renewing its lease must still be stopped.
struct WatchdogSubject {
    plan_id: String,
    mission_id: String,
    camp_id: Option<String>,
    task_id: String,
    /// The current Attempt's identity. The ledger treats it like upstream's `attemptId`: a new
    /// Attempt restarts `tries`, while the epoch budget it inherits stays spent.
    attempt_id: String,
    /// The epoch: the event identity of the current Attempt (upstream `sourceEventId`). A different
    /// event is a different epoch with its own budget; a retry of the same event is not.
    request_epoch: String,
    /// Mikka Task status (`pending` / `running` / `blocked`), mapped from LOOM's own row.
    task_status: &'static str,
    /// Mikka stage (`execute` / `review` / `verify`), derived from the current event kind.
    stage: &'static str,
    run_status: Option<String>,
    active_run: bool,
    uncertain_effect: bool,
    progress_at: DateTime<Utc>,
}

/// What one observation did, so the pass can be counted the way upstream counts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observation {
    /// A healthy, human-owned or already-held Task: the receipt is refreshed and nothing is spent.
    Wait,
    /// The recorded backoff has not elapsed, so this pass did not judge the Task again.
    Deferred,
    /// The Task was held with a durable reason and its executor was asked to stop.
    Blocked,
    /// The old executor demonstrably ended, so the Task was handed back to the scheduler.
    Recovered,
    /// Reconciliation or dispatch: another half of this tick acts, the watchdog only observes.
    HandedOff,
}

/// Observe every Task of an approved Plan once (upstream `sweepFactoryWatchdog`).
///
/// The sweep is the watchdog's *whole* write path: it decides, records the durable receipt, holds
/// the Task, asks a stale executor to stop, and hands a Task back only once that executor is gone.
/// It reuses the tick's own reconciliation and dispatch instead of opening a second execution path,
/// exactly as upstream reuses host reconciliation/dispatch and leaves semantic replanning to the
/// Coordinator's own Decisions API.
fn sweep_watchdog(transaction: &Transaction<'_>, now: DateTime<Utc>) -> Result<LoomTickOutcome> {
    let mut outcome = LoomTickOutcome::default();
    for subject in watchdog_subjects(transaction, now)? {
        outcome.scanned += 1;
        if outcome.admitted < MAX_DISPATCHES_PER_TICK
            && retry_controlled_shutdown_cancellation(transaction, &subject, now)?
        {
            outcome.admitted += 1;
            continue;
        }
        if outcome.admitted < MAX_DISPATCHES_PER_TICK
            && retry_terminal_failure(transaction, &subject, now)?
        {
            outcome.admitted += 1;
            continue;
        }
        match observe_watchdog(transaction, &subject, now)? {
            Observation::Wait | Observation::HandedOff => {}
            Observation::Deferred => outcome.deferred += 1,
            Observation::Blocked => outcome.blocked += 1,
            Observation::Recovered => outcome.recovered += 1,
        }
    }
    Ok(outcome)
}

/// The Tasks one bounded pass observes: those an approved, unexpired and unpaused policy scopes, in
/// the order upstream scans them (`updatedAt`, then identity) and never more than one page of them.
fn watchdog_subjects(
    transaction: &Transaction<'_>,
    now: DateTime<Utc>,
) -> Result<Vec<WatchdogSubject>> {
    let mut rows: Vec<(String, String, String, String, Option<String>, String)> = Vec::new();
    {
        // The approval is part of the *selection*, not a filter after it: a page filled with Tasks
        // no approved policy scopes would otherwise use up the whole bound and the Tasks the sweep
        // may actually repair would never be observed. A Task whose recorded backoff has not
        // elapsed sorts last for the same reason: it is counted as deferred when the page has room,
        // but it can never occupy the head of the page forever.
        let mut statement = transaction.prepare(
            "SELECT task.plan_id, plan.mission_id, task.task_id, task.status, task.blocked_reason,
                    task.updated_at
             FROM loom_task task
             JOIN loom_plan plan ON plan.plan_id = task.plan_id
             JOIN loom_control_policy policy
                  ON policy.plan_id = task.plan_id AND policy.mission_id = plan.mission_id
             WHERE task.status IN ('DRAFT','READY','IN_REVIEW','BLOCKED')
               AND policy.enabled = 1 AND policy.paused = 0
               AND policy.expires_at IS NOT NULL
               AND julianday(policy.expires_at) > julianday(?2)
               AND EXISTS(SELECT 1 FROM json_each(policy.task_ids_json)
                           WHERE value = task.task_id)
             ORDER BY EXISTS(
                          SELECT 1 FROM loom_task_recovery receipt
                           WHERE receipt.task_id = task.task_id
                             AND julianday(receipt.next_at) > julianday(?2)
                             AND receipt.rowid = (SELECT newest.rowid FROM loom_task_recovery newest
                                                   WHERE newest.task_id = task.task_id
                                                   ORDER BY newest.observed_at DESC, newest.rowid DESC
                                                   LIMIT 1)),
                      task.updated_at, task.task_id
             LIMIT ?1",
        )?;
        let mapped = statement.query_map(params![WATCHDOG_SCAN_LIMIT as i64, now.to_rfc3339()], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    // One policy row per Plan, read once per pass: an absent row is remembered as such so a Plan
    // without an approval costs one lookup instead of one per Task.
    let mut policies: std::collections::HashMap<String, Option<LoomControlPolicy>> =
        std::collections::HashMap::new();
    let now_text = now.to_rfc3339();
    let mut subjects = Vec::new();
    for (plan_id, mission_id, task_id, status, blocked_reason, updated_at) in rows {
        if !policies.contains_key(&plan_id) {
            let loaded = read_policy(transaction, &plan_id)?;
            policies.insert(plan_id.clone(), loaded);
        }
        let Some(Some(policy)) = policies.get(&plan_id) else {
            continue;
        };
        // A disabled, paused, expired or foreign policy is not an authority to repair anything:
        // pausing an approval is an explicit human act, and then the human's own path owns the Task.
        if !policy.enabled || policy.paused || policy.mission_id != mission_id {
            continue;
        }
        let Some(expires_at) = policy.expires_at.as_deref() else {
            continue;
        };
        if !expiry_is_future(expires_at, &now_text) {
            continue;
        }
        if !policy.task_ids.iter().any(|scoped| scoped == &task_id) {
            continue;
        }
        let Some(facts) = watchdog_task_facts(
            transaction,
            &plan_id,
            &task_id,
            &status,
            blocked_reason.as_deref(),
            &updated_at,
            now,
        )?
        else {
            continue;
        };
        let camp_id: Option<String> = transaction
            .query_row(
                "SELECT camp_id FROM mission WHERE id=?1",
                [&mission_id],
                |row| row.get(0),
            )
            .optional()?;
        subjects.push(WatchdogSubject {
            plan_id,
            mission_id,
            camp_id,
            task_id,
            attempt_id: facts.attempt_id,
            request_epoch: facts.request_epoch,
            task_status: facts.task_status,
            stage: facts.stage,
            run_status: facts.run_status,
            active_run: facts.active_run,
            uncertain_effect: facts.uncertain_effect,
            progress_at: facts.progress_at,
        });
    }
    Ok(subjects)
}

/// Every Run that holds one Task right now, as `(id, status, startedAt, endedAt)`.
///
/// Two persisted facts say a Run holds a Task: the Delivery of its current Dispatch names it once the
/// claim materialised it, and an unreleased `loom.claim` names the Run that took the Task's write
/// lease. Both are read, because a Task whose Delivery the scheduler has not re-associated yet is
/// still held by the Run the claim names — and a Task that *looks* idle would otherwise be handed out
/// underneath a live executor.
fn task_runs_sql(plan_index: u8, task_index: u8) -> String {
    format!(
        "SELECT run.id, run.status, run.started_at, run.ended_at
           FROM loom_control_dispatch dispatch
           JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
           JOIN agent_run run ON run.id = delivery.claimed_agent_run_id
          WHERE dispatch.plan_id=?{plan_index} AND dispatch.task_id=?{task_index}
         UNION
         SELECT run.id, run.status, run.started_at, run.ended_at
           FROM loom_claim claim
           JOIN agent_run run ON run.id = claim.agent_run_id
          WHERE claim.plan_id=?{plan_index} AND claim.task_id=?{task_index}
            AND claim.released_at IS NULL"
    )
}

/// The facts of one Task's current Attempt, or `None` when the Task is already settled.
struct WatchdogTaskFacts {
    attempt_id: String,
    request_epoch: String,
    task_status: &'static str,
    stage: &'static str,
    run_status: Option<String>,
    active_run: bool,
    uncertain_effect: bool,
    progress_at: DateTime<Utc>,
}

/// Resolve one Task's persisted facts, exactly as upstream's per-candidate state query does, but
/// without reading a heartbeat, a lease or the wall clock behind the caller's back.
fn watchdog_task_facts(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    status: &str,
    blocked_reason: Option<&str>,
    updated_at: &str,
    now: DateTime<Utc>,
) -> Result<Option<WatchdogTaskFacts>> {
    // The current Attempt: the latest dispatch this Task ever recorded. A Task no dispatch reached
    // yet has no Attempt, and the epoch it will be handed out under is the execution event the
    // scheduler is about to mint — the ledger records that identity, so the budget of the first
    // Attempt is already bound to the event that will carry it.
    let attempt: Option<(String, String, String, Option<String>)> = transaction
        .query_row(
            "SELECT dispatch.dispatch_id, dispatch.kind, dispatch.dedupe_key,
                    delivery.claimed_agent_run_id
             FROM loom_control_dispatch dispatch
             LEFT JOIN camp_message_delivery delivery ON delivery.id = dispatch.delivery_id
             WHERE dispatch.plan_id=?1 AND dispatch.task_id=?2
             ORDER BY dispatch.created_at DESC, dispatch.dispatch_id DESC LIMIT 1",
            params![plan_id, task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (attempt_id, event_kind, request_epoch, current_run_id) = match attempt {
        Some((dispatch_id, kind, dedupe_key, run_id)) => {
            (dispatch_id, Some(kind), request_epoch(&dedupe_key), run_id)
        }
        None => {
            // No Attempt has been recorded yet, so the first one will be the EXECUTE event the
            // scheduler is about to mint. Its identity is the epoch the receipt is bound to, and
            // the Attempt id is bounded the same way: `task:{task_id}` would exceed the ledger's
            // 120-character column for a legal long Task id.
            let event = dedupe_key(&[EXECUTE, plan_id, task_id])?;
            (
                format!("task:{}", &request_epoch(&event)["epoch:".len()..]),
                None,
                request_epoch(&event),
                None,
            )
        }
    };

    let mut runs: Vec<(String, String)> = Vec::new();
    {
        let mut statement = transaction.prepare(&task_runs_sql(1, 2))?;
        let mapped = statement.query_map(params![plan_id, task_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        for row in mapped {
            runs.push(row?);
        }
    }
    // Upstream `activeRun`: a Run that still holds the Task. `waiting` is a live Run here, not a
    // finished one, so it keeps the Task from being dispatched a second time.
    let active_run = runs
        .iter()
        .any(|(_, status)| matches!(status.as_str(), "queued" | "running" | "waiting"));
    let run_status = current_run_id
        .as_deref()
        .and_then(|current| runs.iter().find(|(run_id, _)| run_id == current))
        .map(|(_, status)| watchdog_run_status(status).to_string());

    let progress_at = watchdog_progress_at(transaction, plan_id, task_id, updated_at, now)?;
    Ok(Some(WatchdogTaskFacts {
        attempt_id,
        request_epoch,
        task_status: watchdog_task_status(status, blocked_reason),
        stage: watchdog_stage(event_kind.as_deref()),
        run_status,
        active_run,
        uncertain_effect: watchdog_uncertain_effect(transaction, &runs, Some(now))?,
        progress_at,
    }))
}

/// The LOOM Run status in the decision table's vocabulary.
///
/// Mikka's `waiting_input` and LOOM's `waiting` are the same fact — a live Run whose next move needs
/// something a human or another lane owns — so the table's own first branch (which must never stop
/// such a Run) is what protects it here. Every other literal is spelled the same on both sides.
fn watchdog_run_status(status: &str) -> &'static str {
    match status {
        "queued" => "queued",
        "running" => "running",
        "waiting" => "waiting_input",
        "succeeded" => "succeeded",
        "failed" => "failed",
        "cancelled" => "cancelled",
        // An unrecognised literal is a Run that is not provably live: the table's terminal set
        // contains none of this spelling, so it reads as "not terminal" and only ever waits.
        _ => "unknown",
    }
}

/// The LOOM Task row in the decision table's vocabulary.
///
/// LOOM keeps two facts apart that Mikka folds into one status column: the state machine in
/// `loom_task.status` (which a hold never rewrites) and the current hold in `blocked_reason`
/// (which the owner that applied it writes). A Task carrying a reason is therefore *held*, and a
/// held Task whose receipt names a reason this watchdog did not record falls through to `wait` —
/// exactly like upstream's blocked Task whose `watchdog.reasonCode` is not `task_stalled`.
fn watchdog_task_status(status: &str, blocked_reason: Option<&str>) -> &'static str {
    if blocked_reason.is_some() || status == "BLOCKED" {
        return "blocked";
    }
    match status {
        "IN_REVIEW" => "running",
        // `DRAFT` and `READY` are both "nothing is running yet" — the scan never yields anything
        // else, because a finished Task is not observed at all.
        _ => "pending",
    }
}

/// The stage window a Task is measured against. LOOM has no stage column: the current event kind is
/// the stage. `REWORK` is another execution of the same Task, and `HANDOFF` is the Lead's own final
/// verification, so only the review window is short enough to be a separate case.
fn watchdog_stage(event_kind: Option<&str>) -> &'static str {
    match event_kind {
        Some(REVIEW) => "review",
        Some(HANDOFF) => "verify",
        // `EXECUTE`, `REWORK` and a Task no dispatch reached yet: the next event the scheduler mints
        // is an execution, so the long execute window is the honest one.
        _ => "execute",
    }
}

/// Upstream `GREATEST(t.updatedAt, a.createdAt, a.finishedAt, c.createdAt, cp.updatedAt, max tool
/// output)`: the newest *persisted* progress instant.
///
/// Only facts that record work appear here. Lease renewals, execution heartbeats and an
/// `agent_run.updated_at` that a renewal bumps are deliberately left out: they prove a process is
/// alive, never that it advanced, and reading them would let a hung executor hold its Task open
/// forever.
fn watchdog_progress_at(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    task_updated_at: &str,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>> {
    let mut candidates: Vec<Option<String>> = vec![Some(task_updated_at.to_string())];
    let scalar = |sql: &str| -> Result<Option<String>> {
        Ok(transaction
            .query_row(sql, params![plan_id, task_id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten())
    };
    // The Attempt's own start and end, from the facts that record them: the claim the Run took and
    // the Run's own boundaries. The ledger row's `created_at` is the admission instant of the event,
    // which the claim of that very event records again — and its `updated_at` moves when a later
    // pass folds an outcome, which is a judgement about the attempt, not progress it made.
    candidates.push(scalar(
        "SELECT MAX(claimed_at) FROM loom_claim WHERE plan_id=?1 AND task_id=?2",
    )?);
    candidates.push(scalar(
        "SELECT MAX(created_at) FROM loom_candidate WHERE plan_id=?1 AND task_id=?2",
    )?);
    candidates.push(scalar(
        "SELECT MAX(reviewed_at) FROM loom_stage_review WHERE plan_id=?1 AND task_id=?2",
    )?);
    // The Run's own boundaries: when it started and when it ended. Not its `updated_at`, which a
    // lease renewal bumps.
    candidates.push(scalar(&format!(
        "SELECT MAX(started_at) FROM ({})",
        task_runs_sql(1, 2)
    ))?);
    candidates.push(scalar(&format!(
        "SELECT MAX(ended_at) FROM ({})",
        task_runs_sql(1, 2)
    ))?);
    candidates.push(scalar(
        "SELECT MAX(created_at) FROM loom_artifact WHERE plan_id=?1 AND task_id=?2",
    )?);
    // Upstream `max(run_chunks.createdAt) WHERE chunk->>'type'='tool_output'`: the tool result a
    // Run actually persisted is progress, even when no Candidate or artifact exists yet. Without
    // it a long task that keeps completing tool calls — the normal shape of real work — would be
    // judged stalled at the window and its executor stopped for no reason.
    candidates.push(scalar(&format!(
        "SELECT MAX(evidence.occurred_at)
           FROM agent_run_execution_evidence evidence
          WHERE evidence.kind IN ('tool_result','command','file_change')
            AND evidence.agent_run_id IN (SELECT id FROM ({}))",
        task_runs_sql(1, 2)
    ))?);
    Ok(latest_instant(candidates).unwrap_or(now))
}

/// The newest instant of a set of RFC 3339 readings. An unreadable instant is not "long ago" and not
/// "just now": it simply does not extend progress.
fn latest_instant(candidates: impl IntoIterator<Item = Option<String>>) -> Option<DateTime<Utc>> {
    candidates
        .into_iter()
        .flatten()
        .filter_map(|reading| {
            DateTime::parse_from_rfc3339(&reading)
                .ok()
                .map(|at| at.with_timezone(&Utc))
        })
        .max()
}

/// Upstream `uncertainEffect`: an external action of this Task may already have committed, so it
/// must be reconciled before anything is replayed.
///
/// LOOM's external effects are the Remote Workspace operations one Run dispatched to a Node, and
/// only a `Run` operation can change the workspace at all: `List` and `Read` carry no effect, so an
/// in-flight one is ordinary work and never a reason to stop the executor. A `Run` whose receipt
/// is genuinely unsettled is one that is explicitly `unknown`, one that is already cancelling (the
/// cancel race means its process may still be running), or one that is still in flight past its own
/// deadline. A `Run` inside its deadline is running normally, not uncertain.
fn watchdog_uncertain_effect(
    transaction: &Transaction<'_>,
    runs: &[(String, String)],
    now: Option<DateTime<Utc>>,
) -> Result<bool> {
    if runs.is_empty()
        || !crate::remote_execution::authority_table_available(
            transaction,
            "workspace_rpc_requests",
        )?
    {
        return Ok(false);
    }
    let run_ids = serde_json::to_string(
        &runs
            .iter()
            .map(|(run_id, _)| run_id.as_str())
            .collect::<Vec<_>>(),
    )
    .context("a LOOM watchdog run identity list must serialise")?;
    let mut statement = transaction.prepare(
        "SELECT state, dispatch_json FROM workspace_rpc_requests
          WHERE run_id IN (SELECT value FROM json_each(?1))",
    )?;
    let mut rows = statement.query(params![&run_ids])?;
    let now_ms = now.map(|now| now.timestamp_millis());
    while let Some(row) = rows.next()? {
        // `RequestState`: queued 0, dispatched 1, running 2, cancel requested 3, completed 4,
        // failed 5, cancelled 6, unknown 7. A terminal request has a settled receipt.
        let state: i64 = row.get(0)?;
        let dispatch: String = row.get(1)?;
        let Ok(dispatch) = serde_json::from_str::<loom_protocol::workspace_rpc::WorkspaceDispatch>(
            &dispatch,
        ) else {
            // A row this Core cannot read is not proof that nothing committed: fail closed.
            return Ok(true);
        };
        let changes_workspace = matches!(
            dispatch.request.operation,
            loom_protocol::workspace_rpc::WorkspaceOperation::Run { .. }
        );
        let settled = matches!(state, 4 | 5 | 6);
        if settled || !changes_workspace {
            continue;
        }
        let deadline_passed = now_ms.is_none_or(|now| {
            i64::try_from(dispatch.deadline_unix_ms).map_or(true, |deadline| deadline <= now)
        });
        if matches!(state, 7 | 3) || deadline_passed {
            return Ok(true);
        }
    }
    Ok(false)
}

fn retry_terminal_failure(
    transaction: &Transaction<'_>,
    subject: &WatchdogSubject,
    now: DateTime<Utc>,
) -> Result<bool> {
    if subject.run_status.as_deref() != Some("failed")
        || subject.active_run
        || subject.uncertain_effect
    {
        return Ok(false);
    }
    let run_id: Option<String> = transaction
        .query_row(
            "SELECT run.id
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id=dispatch.delivery_id
             JOIN agent_run run ON run.id=delivery.claimed_agent_run_id
             WHERE dispatch.dispatch_id=?1 AND dispatch.status='BLOCKED'
               AND dispatch.kind IN ('EXECUTE','REVIEW','REWORK')
               AND delivery.status='failed' AND run.status='failed'
               AND run.ended_at IS NOT NULL AND run.terminal_resolution_source='runtime_terminal'
               AND run.terminal_reason_code IS NULL AND run.manual_retry_allowed=1
               AND run.cancel_requested_at IS NULL AND run.retry_declined_at IS NULL
               AND CASE WHEN json_valid(run.public_runtime_failure_json)
                        THEN json_type(run.public_runtime_failure_json, '$.retryable')='true'
                        ELSE FALSE END
               AND NOT EXISTS (
                   SELECT 1 FROM agent_run successor WHERE successor.predecessor_agent_run_id=run.id)
               AND NOT EXISTS (
                   SELECT 1 FROM runtime_input_delivery input WHERE input.agent_run_id=run.id
                   AND (input.status='delivery_unknown'
                        OR (input.status='accepted' AND run.runtime_adapter_kind<>'pi')
                        OR (input.status='prepared' AND input.dispatch_started_at IS NOT NULL)))
               AND NOT EXISTS (
                   SELECT 1 FROM loom_claim claim
                   WHERE claim.plan_id=dispatch.plan_id AND claim.task_id=dispatch.task_id
                     AND claim.released_at IS NULL AND claim.agent_run_id<>run.id)
               AND NOT EXISTS (
                   SELECT 1 FROM loom_control_dispatch other
                   JOIN camp_message_delivery pending ON pending.id=other.delivery_id
                   WHERE other.plan_id=dispatch.plan_id AND other.task_id=dispatch.task_id
                     AND other.dispatch_id<>dispatch.dispatch_id
                     AND pending.status IN ('waiting','claimed'))",
            [&subject.attempt_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(run_id) = run_id else {
        return Ok(false);
    };
    if prior_dispatch_outcome(transaction, &subject.attempt_id)? != PriorOutcome::Failed
        || watchdog_uncertain_effect(transaction, &[(run_id, "failed".into())], None)?
        || shared_recovery_budget(transaction, subject)? >= WATCHDOG_MAX_RECOVERIES
    {
        return Ok(false);
    }
    Ok(retry_watchdog_attempt(transaction, subject, now, true, false)?.is_some())
}

/// The controlled-shutdown counterpart of Mikka's `pending + no active run => dispatchNext`
/// reconciliation. The shutdown transaction itself has already proved two things the watchdog
/// otherwise cannot know: the executor was deliberately cancelled (not lost in an unknown state),
/// and its terminal `agent_run.cancelled` fact records whether any action or output effect was
/// still unsettled. Accepted input may be handed back because the retry itself carries Mikka's
/// inspect-existing-work handoff; an uncertain external effect stays closed instead of replaying.
fn retry_controlled_shutdown_cancellation(
    transaction: &Transaction<'_>,
    subject: &WatchdogSubject,
    now: DateTime<Utc>,
) -> Result<bool> {
    if subject.run_status.as_deref() != Some("cancelled")
        || subject.active_run
        || subject.uncertain_effect
    {
        return Ok(false);
    }
    let attempt: Option<(String, String, String, String)> = transaction
        .query_row(
            "SELECT run.id, run.cancel_reason_code, delivery.status, dispatch.status
             FROM loom_control_dispatch dispatch
             JOIN camp_message_delivery delivery ON delivery.id=dispatch.delivery_id
             JOIN agent_run run ON run.id=delivery.claimed_agent_run_id
             WHERE dispatch.dispatch_id=?1",
            [&subject.attempt_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((run_id, cancel_reason, delivery_status, dispatch_status)) = attempt else {
        return Ok(false);
    };
    if dispatch_status != "CANCELLED"
        || delivery_status != "cancelled"
        || !matches!(
            cancel_reason.as_str(),
            "planned_shutdown_cancelled" | "app_shutdown_cancel_all"
        )
    {
        return Ok(false);
    }
    // The terminal fact is the durable receipt the shutdown transaction wrote before closing any
    // prepared or in-flight effect. Accepted input alone is not a replay blocker: the retry body is
    // the Mikka handoff shape and tells the next executor to inspect existing work before acting.
    // An action whose effect is unknown, or a Runtime output checkpoint the shutdown had to close,
    // is an uncertain external effect and fails closed instead.
    let receipt: Option<String> = transaction
        .query_row(
            "SELECT payload_json FROM event_log
             WHERE event_type='agent_run.cancelled' AND entity_type='agent_run' AND entity_id=?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [&run_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(receipt) = receipt else {
        return Ok(false);
    };
    let Ok(receipt) = serde_json::from_str::<serde_json::Value>(&receipt) else {
        return Ok(false);
    };
    let number = |key: &str| receipt.get(key).and_then(serde_json::Value::as_i64).unwrap_or(0);
    let uncertain_action: bool = transaction.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM action_execution
             WHERE agent_run_id=?1 AND status='unknown' AND unknown_disposition='active')",
        [&run_id],
        |row| row.get(0),
    )?;
    let external_effect_uncertain = receipt
        .get("externalEffectEvidencePreserved")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if uncertain_action
        || (external_effect_uncertain
            && (number("actionsMarkedUnknown") > 0 || number("deliveriesClosed") > 0))
        || shared_recovery_budget(transaction, subject)? >= WATCHDOG_MAX_RECOVERIES
    {
        return Ok(false);
    }
    Ok(retry_watchdog_attempt(transaction, subject, now, true, true)?.is_some())
}

fn attempts_in_epoch(connection: &Connection, subject: &WatchdogSubject) -> Result<i64> {
    let mut statement = connection
        .prepare("SELECT dedupe_key FROM loom_control_dispatch WHERE plan_id=?1 AND task_id=?2")?;
    let keys = statement.query_map(params![&subject.plan_id, &subject.task_id], |row| {
        row.get::<_, String>(0)
    })?;
    let mut attempts = 0;
    for key in keys {
        if request_epoch(&key?) == subject.request_epoch {
            attempts += 1;
        }
    }
    Ok(attempts)
}

fn shared_recovery_budget(connection: &Connection, subject: &WatchdogSubject) -> Result<i64> {
    let recorded = recovery_budget(connection, &subject.task_id, &subject.request_epoch)?;
    Ok(recorded.max(attempts_in_epoch(connection, subject)? - 1))
}

/// Observe one Task once and apply what the decision table answered.
fn observe_watchdog(
    transaction: &Transaction<'_>,
    subject: &WatchdogSubject,
    now: DateTime<Utc>,
) -> Result<Observation> {
    let previous: Option<LoomRecoveryReceipt> = recovery_receipt(
        transaction,
        &subject.task_id,
        &subject.attempt_id,
        &subject.request_epoch,
    )?;
    let progress_at = subject.progress_at.to_rfc3339();
    let decision = {
        let progress = WatchdogProgress {
            task_status: subject.task_status,
            task_stage: subject.stage,
            source_event_id: &subject.request_epoch,
            run_status: subject.run_status.as_deref(),
            active_run: subject.active_run,
            uncertain_effect: subject.uncertain_effect,
            // LOOM has no provider-fallback lane yet, so no durable provider intent exists that a
            // dedicated recovery pass would own. The decision's provider branch therefore stays the
            // table's own owner test rather than being fed a fabricated fact here.
            provider_pending: false,
            progress_at: subject.progress_at,
            watchdog: previous.as_ref().map(|receipt| WatchdogState {
                reason_code: receipt.reason_code.as_deref(),
                request_epoch: Some(receipt.request_epoch.as_str()),
                stopped_at: receipt.stopped_at.as_deref(),
            }),
        };
        factory_watchdog_decision(&progress, now)
    };

    // Upstream `if (action === 'wait')`: the branch that spends nothing. It is written even while an
    // earlier backoff is still running, because "this Task is still healthy" is exactly the fact
    // that keeps a progressing Task from permanently occupying the head of a bounded scan.
    if decision == WatchdogDecision::Wait {
        record_watchdog_observation(
            transaction,
            WatchdogObservation {
                task_id: &subject.task_id,
                attempt_id: &subject.attempt_id,
                request_epoch: &subject.request_epoch,
                action: "wait",
                blocked: subject.task_status == "blocked",
                progress_at: Some(&progress_at),
                reason_code: None,
                stopped_at: None,
                now,
            },
        )?;
        return Ok(Observation::Wait);
    }

    // Reconciliation and dispatch stay with the owners this tick already runs: `reconcile_dispatches`
    // folded every Delivery/Run outcome before this sweep started, and `admit_plan` hands out the due
    // events after it. Repeating either here would open a second write path for the same decision.
    if matches!(
        decision,
        WatchdogDecision::Reconcile | WatchdogDecision::Dispatch
    ) {
        return Ok(Observation::HandedOff);
    }

    // Upstream `if (previous?.result?.nextAt > now) { deferred++; return }`: a repair action is not
    // re-judged before the backoff it recorded has elapsed.
    if previous.as_ref().is_some_and(|receipt| receipt.defers(now)) {
        return Ok(Observation::Deferred);
    }

    let action = match decision {
        WatchdogDecision::ExternalEffect => "external_effect",
        WatchdogDecision::Stalled => "stalled",
        WatchdogDecision::StopTimeout => "stop_timeout",
        WatchdogDecision::RecoverStall => "recover_stall",
        WatchdogDecision::Wait | WatchdogDecision::Reconcile | WatchdogDecision::Dispatch => {
            unreachable!("the branches above own these decisions")
        }
    };
    let tries = next_watchdog_tries(previous.as_ref().map(|receipt| receipt.tries), action);
    let budget = shared_recovery_budget(transaction, subject)?;
    let exhausted = recovery_exhausted(tries, action, budget);
    // Upstream `recoverable`: only a stalled Task in an execution stage can be replayed. LOOM has no
    // question-continuation attempt (`originalSessionOnly`), so the stage is the whole condition.
    let recoverable =
        action == "stalled" && matches!(subject.stage, "execute" | "review" | "verify");
    let blocked = matches!(
        decision,
        WatchdogDecision::Stalled
            | WatchdogDecision::ExternalEffect
            | WatchdogDecision::StopTimeout
    ) || exhausted;

    if !blocked {
        // `recover_stall` and nothing else reaches here: the old executor is demonstrably gone, so
        // the Task may be handed back. Reconcile already ran at the top of this tick; what remains
        // is upstream's `store.apply(retry)` followed by `host.dispatch`: close the Attempt this
        // epoch spent, release the fence the dead Run still holds, clear this module's own hold, and
        // mint the next Attempt of the *same* epoch — the retried delivery then starts through the
        // ordinary Delivery/Run path, exactly like the first one did.
        let Some((retry_dispatch_id, _)) =
            retry_watchdog_attempt(transaction, subject, now, false, false)?
        else {
            // No room for another Attempt — the plan's dispatch budget or the Task's rework budget
            // is spent, or the recipient can no longer be addressed. That is upstream's deferred
            // savepoint path: the hold is left as it was, so the Task waits for a human instead of
            // being reported as recovered when nothing was handed back.
            return Ok(Observation::Deferred);
        };
        record_watchdog_fact(
            transaction,
            // Upstream `run_redispatched:${runId}` (`lib/factory/dispatch-recovery.ts:150`, held to
            // "exactly one run_redispatched per run" by `dispatch-recovery.db.test.ts:84,97`): the
            // durable identity of a hand-back is the Attempt it minted, and a dispatch id plays the
            // part of the Run id here. `tries` cannot: it restarts at this Attempt's own first value
            // (`watchdog.ts:183`), so keying the fact on it would fold every recovery of one epoch
            // into the very first row and lose the rest.
            format!(
                "{WATCHDOG_RECOVERED_EVENT}:{}:{}:{}:{retry_dispatch_id}",
                subject.plan_id, subject.task_id, subject.request_epoch
            ),
            WATCHDOG_RECOVERED_EVENT,
            subject,
            serde_json::json!({
                "missionId": subject.mission_id,
                "planId": subject.plan_id,
                "taskId": subject.task_id,
                "requestEpoch": subject.request_epoch,
                "attemptId": retry_dispatch_id,
                "action": action,
                "tries": tries,
                "recoveryTries": previous
                    .as_ref()
                    .map_or(1, |receipt| receipt.recovery_tries + 1),
                "previousRunStatus": subject.run_status,
            }),
            &now.to_rfc3339(),
        )?;
        // Upstream keys the receipt by the Attempt it *observed* and that Attempt's source Event
        // (`factoryEventId('task-watchdog', `${task.attemptId}:${task.sourceEventId}`)`), so the row
        // this pass writes is the one a later observation of that Attempt reads. The hand-back minted
        // a successor Attempt, but the observation — and the `recoveryTries` it spent — belongs to
        // the Attempt whose executor had to stop. The retry keeps the epoch, so the budget summed
        // over every Attempt of the epoch keeps what the earlier hand-backs already spent.
        record_watchdog_observation(
            transaction,
            WatchdogObservation {
                task_id: &subject.task_id,
                attempt_id: &subject.attempt_id,
                request_epoch: &subject.request_epoch,
                action,
                blocked: false,
                progress_at: Some(&progress_at),
                reason_code: None,
                // Upstream rewrites the Attempt's watchdog state only when it applies a hold, so a
                // hand-back keeps the pair it recorded. It is inert: the Task is no longer held, so
                // the decision's held-Task branch cannot be reached by it.
                stopped_at: None,
                now,
            },
        )?;
        return Ok(Observation::Recovered);
    }

    // Upstream chooses the reasonCode before it acts, and `stoppedAt` is the instant this hold
    // requested the stop. Only `stop_timeout` keeps the earlier one: its whole point is that the stop
    // was requested and never acknowledged.
    let (reason_code, reason, stopped_at) = if action == "external_effect" {
        (
            WATCHDOG_REASON_EXTERNAL_EFFECT,
            "An external action has an uncertain receipt. Reconcile it before any replay.",
            Some(now.to_rfc3339()),
        )
    } else if recoverable {
        (
            WATCHDOG_REASON_STALLED,
            "No persisted task progress within the stage window. Check the executor and workspace before resuming.",
            Some(now.to_rfc3339()),
        )
    } else if action == "stop_timeout" {
        (
            WATCHDOG_REASON_STOP_TIMEOUT,
            "The old executor has not acknowledged its stop. Restore or disconnect it before another worker can safely resume.",
            None,
        )
    } else {
        (
            WATCHDOG_REASON_EXHAUSTED,
            "Automatic recovery attempts are exhausted. Restore the executor or credential and explicitly resume this task.",
            Some(now.to_rfc3339()),
        )
    };
    let hold = watchdog_hold_code(reason_code);
    set_watchdog_hold(
        transaction,
        &subject.plan_id,
        &subject.task_id,
        hold,
        &now.to_rfc3339(),
    )?;
    // The old execution is asked to stop whatever the reason is: an uncertain effect must not keep
    // running, and a stalled executor must not be resumed underneath itself. The request is a fence,
    // not a kill: the Executor's own acknowledgement is what makes the Run terminal, and only that
    // acknowledgement lets a later observation replay the Task.
    stop_watchdog_runs(
        transaction,
        &subject.plan_id,
        &subject.task_id,
        hold,
        &now.to_rfc3339(),
    )?;
    record_watchdog_fact(
        transaction,
        format!(
            "{WATCHDOG_BLOCKED_EVENT}:{}:{}:{}:{reason_code}",
            subject.plan_id, subject.task_id, subject.request_epoch
        ),
        WATCHDOG_BLOCKED_EVENT,
        subject,
        serde_json::json!({
            "missionId": subject.mission_id,
            "planId": subject.plan_id,
            "taskId": subject.task_id,
            "requestEpoch": subject.request_epoch,
            "attemptId": subject.attempt_id,
            "action": action,
            "reasonCode": reason_code,
            "reason": reason,
            "stage": subject.stage,
            "stoppedAt": stopped_at,
            "tries": tries,
            "recoveryTries": previous
                .as_ref()
                .map_or(0, |receipt| receipt.recovery_tries),
        }),
        &now.to_rfc3339(),
    )?;
    record_watchdog_observation(
        transaction,
        WatchdogObservation {
            task_id: &subject.task_id,
            attempt_id: &subject.attempt_id,
            request_epoch: &subject.request_epoch,
            action,
            blocked: true,
            progress_at: Some(&progress_at),
            reason_code: Some(reason_code),
            stopped_at: stopped_at.as_deref(),
            now,
        },
    )?;
    Ok(Observation::Blocked)
}

/// The product-facing `blocked_reason` of one upstream `reasonCode`.
fn watchdog_hold_code(reason_code: &str) -> &'static str {
    match reason_code {
        WATCHDOG_REASON_EXTERNAL_EFFECT => WATCHDOG_EXTERNAL_EFFECT_REASON,
        WATCHDOG_REASON_STOP_TIMEOUT => WATCHDOG_STOP_TIMEOUT_REASON,
        WATCHDOG_REASON_EXHAUSTED => WATCHDOG_EXHAUSTED_REASON,
        _ => WATCHDOG_STALLED_REASON,
    }
}

/// The watchdog hold this Task currently carries, when it carries one.
///
/// This is the rule that makes a replay impossible while the watchdog holds the Task: the scheduler
/// asks it before it hands anything out, and so does the pre-execution recheck.
fn watchdog_hold_reason(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
) -> Result<Option<&'static str>> {
    let reason: Option<String> = connection
        .query_row(
            "SELECT blocked_reason FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![plan_id, task_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(reason.as_deref().and_then(|reason| {
        WATCHDOG_REASONS
            .into_iter()
            .find(|candidate| *candidate == reason)
    }))
}

/// Apply the watchdog's hold. A reason another owner wrote is never overwritten, and an unchanged
/// value writes nothing at all: this field is the current-state mirror, while the durable facts live
/// in the domain event log and the recovery ledger.
fn set_watchdog_hold(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    reason: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "UPDATE loom_task SET blocked_reason=?1, updated_at=?2, revision=revision+1
         WHERE plan_id=?3 AND task_id=?4
           AND (blocked_reason IS NULL OR blocked_reason IN (?5,?6,?7,?8))
           AND (blocked_reason IS NULL OR blocked_reason <> ?1)",
        params![
            reason,
            now,
            plan_id,
            task_id,
            WATCHDOG_STALLED_REASON,
            WATCHDOG_EXTERNAL_EFFECT_REASON,
            WATCHDOG_STOP_TIMEOUT_REASON,
            WATCHDOG_EXHAUSTED_REASON
        ],
    )?;
    Ok(())
}

/// Clear this module's own holds — all four — and nothing else.
fn clear_watchdog_hold(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "UPDATE loom_task SET blocked_reason=NULL, updated_at=?1, revision=revision+1
         WHERE plan_id=?2 AND task_id=?3 AND blocked_reason IN (?4,?5,?6,?7)",
        params![
            now,
            plan_id,
            task_id,
            WATCHDOG_STALLED_REASON,
            WATCHDOG_EXTERNAL_EFFECT_REASON,
            WATCHDOG_STOP_TIMEOUT_REASON,
            WATCHDOG_EXHAUSTED_REASON
        ],
    )?;
    Ok(())
}

/// The claim fence a dead Run still holds. Releasing it is part of handing the Task back: until it is
/// released no other Run can claim the Task, and after it is released the ordinary `loom.claim` path
/// is the only way to take it.
fn release_watchdog_claim(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "UPDATE loom_claim SET released_at=?1
         WHERE plan_id=?2 AND task_id=?3 AND released_at IS NULL",
        params![now, plan_id, task_id],
    )?;
    Ok(())
}

/// Hand one held Task back as a new Attempt of the same epoch (upstream `retry` + `dispatch`).
///
/// The whole retry is one savepoint: a retry that cannot be admitted — the plan's dispatch budget
/// is spent, the Task's rework budget is spent, the approval was superseded, or the recipient can
/// no longer be addressed — must leave the hold, the claim and the ledger exactly as they were
/// instead of aborting the tick. The caller counts that as `deferred`, which is upstream's own
/// savepoint rollback path.
fn retry_watchdog_attempt(
    transaction: &Transaction<'_>,
    subject: &WatchdogSubject,
    now: DateTime<Utc>,
    check_event: bool,
    allow_cancelled_attempt: bool,
) -> Result<Option<(String, String)>> {
    transaction.execute_batch("SAVEPOINT watchdog_retry")?;
    match write_watchdog_retry(transaction, subject, now, check_event, allow_cancelled_attempt) {
        Ok(Some(retry)) => {
            transaction.execute_batch("RELEASE SAVEPOINT watchdog_retry")?;
            Ok(Some(retry))
        }
        Ok(None) => {
            transaction.execute_batch(
                "ROLLBACK TO SAVEPOINT watchdog_retry;
                 RELEASE SAVEPOINT watchdog_retry;",
            )?;
            Ok(None)
        }
        Err(error) => {
            transaction.execute_batch(
                "ROLLBACK TO SAVEPOINT watchdog_retry;
                 RELEASE SAVEPOINT watchdog_retry;",
            )?;
            eprintln!(
                "loom watchdog retry for task {} was not admitted: {error:#}",
                subject.task_id
            );
            Ok(None)
        }
    }
}

/// The writes one retry consists of, all inside the caller's savepoint.
fn write_watchdog_retry(
    transaction: &Transaction<'_>,
    subject: &WatchdogSubject,
    now: DateTime<Utc>,
    check_event: bool,
    allow_cancelled_attempt: bool,
) -> Result<Option<(String, String)>> {
    let Some(policy) = read_policy(transaction, &subject.plan_id)? else {
        return Ok(None);
    };
    // A paused, disabled or superseded approval owns the Task again; the watchdog must not spend it.
    if !policy.enabled
        || policy.paused
        || policy.mission_id != subject.mission_id
        || !policy.task_ids.iter().any(|scoped| scoped == &subject.task_id)
    {
        return Ok(None);
    }
    let Some(camp_id) = subject.camp_id.as_deref() else {
        return Ok(None);
    };
    // The Attempt this epoch spent: its kind, Candidate and recipient are what its successor repeats.
    let attempt: Option<(String, String, Option<String>, i64, String, String)> = transaction
        .query_row(
            "SELECT dispatch_id, kind, candidate_id, policy_revision, recipient_agent_id, dedupe_key
             FROM loom_control_dispatch
             WHERE plan_id=?1 AND task_id=?2
             ORDER BY created_at DESC, dispatch_id DESC LIMIT 1",
            params![&subject.plan_id, &subject.task_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((old_dispatch_id, kind, candidate_id, policy_revision, recipient, old_key)) = attempt
    else {
        return Ok(None);
    };
    if policy_revision != policy.authorization_revision {
        return Ok(None);
    }
    let now_text = now.to_rfc3339();
    // A retry is only considered once the old executor is demonstrably gone, so its claim fence and
    // this module's hold are released before any event re-check. The savepoint rolls both back if
    // admission is not possible.
    release_watchdog_claim(transaction, &subject.plan_id, &subject.task_id, &now_text)?;
    clear_watchdog_hold(transaction, &subject.plan_id, &subject.task_id, &now_text)?;
    if check_event
        && event_problem(
            transaction,
            &policy,
            &subject.mission_id,
            &subject.plan_id,
            &subject.task_id,
            &kind,
            candidate_id.as_deref(),
            &recipient,
            policy_revision,
            Some(&old_dispatch_id),
            None,
            false,
        )?
        .is_some()
    {
        return Ok(None);
    }
    // Upstream `checkFactoryRepairBudget`: the dispatch budget and the per-Task rework budget bound
    // automatic repair exactly like they bound the first attempt.
    let spent: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM loom_control_dispatch WHERE plan_id=?1",
        [&subject.plan_id],
        |row| row.get(0),
    )?;
    if spent >= policy.max_dispatches {
        return Ok(None);
    }
    if kind == REWORK {
        let reworks: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM loom_control_dispatch
             WHERE plan_id=?1 AND task_id=?2 AND kind='REWORK'",
            params![&subject.plan_id, &subject.task_id],
            |row| row.get(0),
        )?;
        if reworks >= policy.max_reworks_per_task {
            return Ok(None);
        }
    }
    if !recipient_is_addressable(transaction, camp_id, &recipient)? {
        return Ok(None);
    }

    // The epoch this Attempt belongs to, and the ordinal of the Attempt being minted — counted from
    // the recorded identities, so a replay of this pass derives the same key instead of stacking a
    // second copy of the same retry.
    let base = base_event_identity(&old_key);
    let epoch = request_epoch(&base);
    let attempts = attempts_in_epoch(transaction, subject)?;
    let retry_key = retry_dedupe_key(&base, attempts + 1)?;

    // The Attempt that ended is closed as superseded: a `CANCELLED` dispatch never executed, so the
    // class-level "previous outcome unknown" rule no longer reads its failed Run as an unresolved
    // result. Its history — dispatch row, Delivery and Run — is kept as the record it is.
    let superseded = transaction.execute(
        "UPDATE loom_control_dispatch SET status='CANCELLED', reason=?1, updated_at=?2
         WHERE dispatch_id=?3 AND status IN ('WAITING','DISPATCHED','BLOCKED')",
        params![WATCHDOG_SUPERSEDED_REASON, &now_text, &old_dispatch_id],
    )?;
    if superseded != 1 {
        // Controlled shutdown already folded the old Attempt to `CANCELLED`; that terminal row is
        // closed enough when the caller has separately proved the cancellation was effect-free.
        // Other retry owners still require the row they personally supersede, so a user stop or an
        // ambiguous cancellation cannot become an automatic replay through this shared write path.
        if !allow_cancelled_attempt {
            return Ok(None);
        }
        let already_cancelled: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loom_control_dispatch WHERE dispatch_id=?1 AND status='CANCELLED')",
            [&old_dispatch_id],
            |row| row.get(0),
        )?;
        if !already_cancelled {
            return Ok(None);
        }
    }
    let dispatch_id = format!("dispatch_{}", uuid::Uuid::new_v4().simple());
    let admission = LoomDispatchAdmission {
        mission_id: &subject.mission_id,
        dispatch_id: dispatch_id.as_str(),
        plan_id: &subject.plan_id,
        task_id: &subject.task_id,
        kind: &kind,
        candidate_id: candidate_id.as_deref(),
        policy_revision,
        recipient_agent_id: &recipient,
        dedupe_key: retry_key.as_str(),
        now: &now_text,
    };
    match admit_loom_dispatch_message(transaction, &admission)? {
        LoomDispatchAdmissionOutcome::Admitted { .. } => Ok(Some((dispatch_id, epoch))),
        LoomDispatchAdmissionOutcome::Skipped => Ok(None),
    }
}

/// Ask every live Run of this Task to stop, exactly as upstream's blocked branch does: the first
/// request keeps its instant and its reason, so a repeated observation cannot extend the window in
/// which the old executor is expected to acknowledge.
fn stop_watchdog_runs(
    transaction: &Transaction<'_>,
    plan_id: &str,
    task_id: &str,
    reason_code: &str,
    now: &str,
) -> Result<()> {
    transaction.execute(
        &format!(
            "UPDATE agent_run
                SET cancel_requested_at=COALESCE(cancel_requested_at, ?1),
                    cancel_reason_code=COALESCE(cancel_reason_code, ?2),
                    updated_at=?1,
                    version=version+1
              WHERE status IN ('queued','running','waiting')
                AND id IN (SELECT id FROM ({}))",
            task_runs_sql(3, 4)
        ),
        params![now, reason_code, plan_id, task_id],
    )?;
    Ok(())
}

/// One durable watchdog fact in the domain event log: the blocker a Lead has to see, and the record
/// that the Task may run again. The identity is the upstream dedupe key, so a repeated observation of
/// the same hold of the same epoch stores one row and the history is never rewritten.
fn record_watchdog_fact(
    transaction: &Transaction<'_>,
    event_id: String,
    event_type: &str,
    subject: &WatchdogSubject,
    payload: serde_json::Value,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO event_log(event_id, event_type, payload_json, camp_id, entity_type, entity_id,
                               actor_type, actor_id, created_at)
         VALUES(?1, ?2, ?3, ?4, 'loom_task', ?5, 'system', 'loom.watchdog', ?6)
         ON CONFLICT(event_id) DO NOTHING",
        params![
            event_id,
            event_type,
            serde_json::to_string(&payload)
                .context("a LOOM watchdog fact must serialise as JSON")?,
            subject.camp_id,
            subject.task_id,
            now
        ],
    )?;
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

/// Whether the User has explicitly released the newest `BLOCKED` stage verdict of this Candidate
/// for a redo.
///
/// The release names the exact verdict it is overriding, so nothing here has to guess an order from
/// clocks: a `stageReviewId` can only be quoted once that verdict exists, which makes an event that
/// names this one a decision written *after* it. The verdict itself stays the newest stage judgement
/// — this reads a later fact rather than editing an older one.
///
/// The identity is checked the whole way down: the same Plan, Task and Candidate, that very
/// verdict, and the actor — only `actor_type='user'` with `actor_id`
/// [`crate::current_user::CURRENT_USER_ID`] is the Owner's decision, so a same-named fact written by
/// an Agent or a System component releases nothing. A request naming another (older) verdict, or
/// naming none, is not a decision about this block either — including one a hand-written or migrated
/// event left behind.
fn stage_block_rework_requested(
    connection: &Connection,
    plan_id: &str,
    task_id: &str,
    candidate_id: &str,
    authorization_revision: i64,
) -> Result<bool> {
    let stage_review_id: Option<String> = connection
        .query_row(
            "SELECT stage_review_id FROM loom_stage_review
             WHERE plan_id=?1 AND candidate_id=?2 AND policy_revision=?3 AND verdict='BLOCKED'
             ORDER BY reviewed_at DESC, rowid DESC LIMIT 1",
            params![plan_id, candidate_id, authorization_revision],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stage_review_id) = stage_review_id else {
        return Ok(false);
    };
    let mut statement = connection.prepare(
        "SELECT payload_json FROM event_log
         WHERE event_type=?1 AND entity_type='loom_task' AND entity_id=?2
           AND actor_type='user' AND actor_id=?3
         ORDER BY created_at DESC, rowid DESC",
    )?;
    let records = statement.query_map(
        params![
            REWORK_REQUESTED_EVENT,
            task_id,
            crate::current_user::CURRENT_USER_ID
        ],
        |row| row.get::<_, String>(0),
    )?;
    for record in records {
        let payload: serde_json::Value = serde_json::from_str(&record?)
            .context("a recorded LOOM rework request must be JSON")?;
        let same_decision = payload
            .get("stageReviewId")
            .and_then(serde_json::Value::as_str)
            == Some(stage_review_id.as_str())
            && payload.get("planId").and_then(serde_json::Value::as_str) == Some(plan_id)
            && payload.get("taskId").and_then(serde_json::Value::as_str) == Some(task_id)
            && payload.get("candidateId").and_then(serde_json::Value::as_str)
                == Some(candidate_id);
        if same_decision {
            return Ok(true);
        }
    }
    Ok(false)
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
