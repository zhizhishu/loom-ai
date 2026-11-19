// upstream: Mikka d59c85cb lib/factory/watchdog.ts:factoryWatchdogDecision
//!
//! Factory watchdog decision table, ported from Mikka `lib/factory/watchdog.ts`
//! (`d59c85cb321b2b466616960db49dea8f038c2384`). It is a pure function: `now` is an
//! argument and nothing is read or written, so a caller decides against one clock instant
//! and a test can move time without touching the wall clock. Branch order and every
//! constant are the upstream ones; only the language changed.
//!
//! The upstream table speaks Mikka's Task vocabulary (`pending` / `running` / `blocked`
//! and the stages `spec` / `execute` / `review` / `verify` / `monitor`). The LOOM Task row
//! persists uppercase control-plane literals (`READY` / `BLOCKED` / `IN_REVIEW` / ...), so
//! the caller that wires this table to `loom_task` maps its status onto the Mikka
//! vocabulary at the call site; the table itself stays a literal port.

// The upstream sweep (`sweepFactoryWatchdog`) is the consumer, and its LOOM wiring lands in M5;
// until then nothing outside the tests constructs these types, so the dead-code lint is expected
// rather than a sign that the port is unused.
#![allow(dead_code)]

use chrono::{DateTime, Utc};

/// Upstream `WATCHDOG_MAX_RECOVERIES`: automatic recovery is spent after this many tries
/// and the Task is blocked instead of being replayed forever.
pub(crate) const WATCHDOG_MAX_RECOVERIES: i64 = 3;

/// Upstream `TERMINAL`: a Run in one of these states is over, so a Task still claiming to
/// run has a stale Run that has to be reconciled.
pub(crate) const TERMINAL_RUN_STATUSES: [&str; 5] =
    ["succeeded", "completed", "failed", "stopped", "cancelled"];

/// Upstream literal `5 * 60_000` in the `stop_timeout` branch: after five minutes without
/// acknowledging its stop, the old executor is treated as unreachable.
pub(crate) const STOP_TIMEOUT_MS: i64 = 5 * 60_000;

/// Upstream literal `45 * 60_000`: an `execute` stage has the long window because a real
/// edit/test cycle legitimately runs for a while.
pub(crate) const EXECUTE_STALL_MS: i64 = 45 * 60_000;

/// Upstream literal `20 * 60_000`: every other stage (spec, review, verify, monitor) is
/// expected to produce persisted progress much sooner.
pub(crate) const OTHER_STALL_MS: i64 = 20 * 60_000;

/// The persisted watchdog receipt of an earlier observation. Upstream shape:
/// `{ reasonCode?: string; requestEpoch?: string; stoppedAt?: string }`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WatchdogState<'a> {
    pub reason_code: Option<&'a str>,
    pub request_epoch: Option<&'a str>,
    /// RFC 3339 instant the stop was requested, persisted by a previous blocked observation.
    pub stopped_at: Option<&'a str>,
}

/// One observation of a Task and its current Run. Upstream shape: `Progress` in
/// `lib/factory/watchdog.ts`, minus the database handle: lease/heartbeat timestamps are
/// deliberately absent there too, because only persisted progress counts.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WatchdogProgress<'a> {
    /// Mikka Task status: `pending`, `running`, `blocked`, ...
    pub task_status: &'a str,
    /// Mikka stage: `spec`, `execute`, `review`, `verify`, `monitor`.
    pub task_stage: &'a str,
    /// The Task's `sourceEventId`, the epoch a watchdog receipt has to match to be current.
    pub source_event_id: &'a str,
    /// `None` means the Task has no Run; a terminal value means its Run is over.
    pub run_status: Option<&'a str>,
    pub active_run: bool,
    pub uncertain_effect: bool,
    pub provider_pending: bool,
    /// The newest persisted progress instant (tool output, checkpoint, candidate, ...).
    pub progress_at: DateTime<Utc>,
    pub watchdog: Option<WatchdogState<'a>>,
}

/// What the sweep should do for one observed Task. Upstream returns these as string
/// literals; the variant names keep the upstream spelling so a reader can diff the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatchdogDecision {
    Wait,
    ExternalEffect,
    RecoverStall,
    StopTimeout,
    Reconcile,
    Dispatch,
    Stalled,
}

/// Upstream `factoryWatchdogDecision(value, now)`. The branch order is significant: an
/// explicit human wait wins over an uncertain effect, a durable provider intent wins over
/// stall repair, and only a Task that is neither running a healthy Run nor already owned by
/// another path is ever reported as stalled.
pub(crate) fn factory_watchdog_decision(
    value: &WatchdogProgress<'_>,
    now: DateTime<Utc>,
) -> WatchdogDecision {
    // Explicit human control and input waits are owned by their existing paths.
    if matches!(value.run_status, Some("paused") | Some("waiting_input")) {
        return WatchdogDecision::Wait;
    }
    if value.uncertain_effect {
        return WatchdogDecision::ExternalEffect;
    }
    // The dedicated provider recovery pass below owns this durable intent. A racing
    // observation must not spend transport/watchdog repair attempts.
    if value.provider_pending && value.task_status == "running" {
        return WatchdogDecision::Wait;
    }
    if value.task_status == "blocked" {
        if let Some(watchdog) = value.watchdog {
            if watchdog.reason_code == Some("task_stalled")
                && watchdog.request_epoch == Some(value.source_event_id)
            {
                let run_ended = value
                    .run_status
                    .is_none_or(|status| TERMINAL_RUN_STATUSES.contains(&status));
                if !value.active_run && run_ended {
                    return WatchdogDecision::RecoverStall;
                }
                // `Date.parse(stoppedAt)` rejects garbage instead of treating it as "long
                // ago": an unreadable instant falls through to `wait`, never to a stop.
                if let Some(stopped_at) = watchdog.stopped_at {
                    if let Ok(stopped_at) = DateTime::parse_from_rfc3339(stopped_at) {
                        if now
                            .signed_duration_since(stopped_at.with_timezone(&Utc))
                            .num_milliseconds()
                            >= STOP_TIMEOUT_MS
                        {
                            return WatchdogDecision::StopTimeout;
                        }
                    }
                }
                return WatchdogDecision::Wait;
            }
        }
    }
    if let Some(run_status) = value.run_status {
        if TERMINAL_RUN_STATUSES.contains(&run_status) && value.task_status == "running" {
            return WatchdogDecision::Reconcile;
        }
    }
    if value.task_status == "pending"
        && !value.active_run
        && ["execute", "review", "verify"].contains(&value.task_stage)
    {
        return WatchdogDecision::Dispatch;
    }
    let threshold = if value.task_stage == "execute" {
        EXECUTE_STALL_MS
    } else {
        OTHER_STALL_MS
    };
    if ["pending", "running"].contains(&value.task_status)
        && now
            .signed_duration_since(value.progress_at)
            .num_milliseconds()
            >= threshold
    {
        return WatchdogDecision::Stalled;
    }
    WatchdogDecision::Wait
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).unwrap()
    }

    /// An idle `execute` Task whose Run is gone: the baseline every branch below perturbs.
    fn progress<'a>(now: DateTime<Utc>) -> WatchdogProgress<'a> {
        WatchdogProgress {
            task_status: "pending",
            task_stage: "execute",
            source_event_id: "event_one",
            run_status: None,
            active_run: false,
            uncertain_effect: false,
            provider_pending: false,
            progress_at: now,
            watchdog: None,
        }
    }

    /// Upstream `Progress` with `runStatus: 'paused' | 'waiting_input'`: a human owns the
    /// decision, so the watchdog does not.
    #[test]
    fn paused_and_waiting_input_runs_wait() {
        let now = at(1_000_000);
        for run_status in ["paused", "waiting_input"] {
            let mut value = progress(now);
            value.task_status = "running";
            value.run_status = Some(run_status);
            value.progress_at = now - chrono::Duration::hours(10);
            assert_eq!(
                factory_watchdog_decision(&value, now),
                WatchdogDecision::Wait,
                "assertion a {run_status} Run is owned by its existing path, not the watchdog"
            );
        }
    }

    /// Upstream `if (value.uncertainEffect) return 'external_effect'`: an external action
    /// with an uncertain receipt must be reconciled before any replay.
    #[test]
    fn an_uncertain_external_effect_is_owned_by_the_external_effect_branch() {
        let now = at(1_000_000);
        let mut value = progress(now);
        value.task_status = "running";
        value.run_status = Some("failed");
        value.uncertain_effect = true;
        assert_eq!(
            factory_watchdog_decision(&value, now),
            WatchdogDecision::ExternalEffect,
            "assertion an uncertain external effect wins over both reconcile and stall"
        );
    }

    /// Upstream assertion in `completion-reconcile.db.test.ts`:
    /// "a racing pending observation never consumes watchdog tries".
    #[test]
    fn a_racing_pending_provider_observation_never_spends_a_watchdog_try() {
        let now = at(1_000_000);
        let mut value = progress(now);
        value.task_status = "running";
        value.run_status = Some("failed");
        value.provider_pending = true;
        value.progress_at = at(0);
        assert_eq!(
            factory_watchdog_decision(&value, now),
            WatchdogDecision::Wait,
            "assertion a provider intent pending on a running Task waits instead of repairing"
        );
    }

    /// Upstream `recover_stall`: the blocked Task carries a current `task_stalled` receipt
    /// and no live Run, so the same Task can be resumed once the executor stopped.
    #[test]
    fn a_stalled_blocked_task_recovers_without_an_active_run() {
        let now = at(1_000_000);
        let stopped_at = at(1_000_000).to_rfc3339();
        let state = WatchdogState {
            reason_code: Some("task_stalled"),
            request_epoch: Some("event_one"),
            stopped_at: Some(&stopped_at),
        };
        for run_status in [None, Some("succeeded"), Some("failed"), Some("cancelled")] {
            let mut value = progress(now);
            value.task_status = "blocked";
            value.run_status = run_status;
            value.watchdog = Some(state);
            value.progress_at = at(0);
            assert_eq!(
                factory_watchdog_decision(&value, now),
                WatchdogDecision::RecoverStall,
                "assertion an idle {run_status:?} Run under a current stall receipt recovers"
            );
        }
        // A live Run is never recovered out from under itself.
        let mut live = progress(now);
        live.task_status = "blocked";
        live.active_run = true;
        live.run_status = Some("running");
        live.watchdog = Some(state);
        live.progress_at = at(0);
        assert_eq!(
            factory_watchdog_decision(&live, now),
            WatchdogDecision::Wait,
            "assertion an active Run keeps the blocked Task instead of being recovered away"
        );
    }

    /// Upstream staleness guards around the same branch: a receipt from another epoch, or
    /// another reason code, is not this watchdog's observation at all.
    #[test]
    fn a_stall_receipt_is_bound_to_its_reason_and_request_epoch() {
        let now = at(1_000_000);
        for state in [
            WatchdogState {
                reason_code: Some("external_effect_uncertain"),
                request_epoch: Some("event_one"),
                stopped_at: None,
            },
            WatchdogState {
                reason_code: Some("task_stalled"),
                request_epoch: Some("event_other"),
                stopped_at: None,
            },
            WatchdogState {
                reason_code: Some("task_stalled"),
                request_epoch: None,
                stopped_at: None,
            },
        ] {
            let mut value = progress(now);
            value.task_status = "blocked";
            value.watchdog = Some(state);
            value.progress_at = at(0);
            assert_eq!(
                factory_watchdog_decision(&value, now),
                WatchdogDecision::Wait,
                "assertion a stale receipt ({state:?}) never recovers or stops the Task"
            );
        }
    }

    /// Upstream `stop_timeout`: the old executor has not acknowledged its stop after five
    /// minutes, so another worker must not resume the Task yet.
    #[test]
    fn a_stalled_blocked_task_stops_timing_out_at_exactly_five_minutes() {
        let now = at(1_000_000);
        let mut value = progress(now);
        value.task_status = "blocked";
        value.run_status = Some("running");
        value.active_run = true;
        value.progress_at = at(0);

        let stopped_at = (now - chrono::Duration::milliseconds(STOP_TIMEOUT_MS - 1)).to_rfc3339();
        value.watchdog = Some(WatchdogState {
            reason_code: Some("task_stalled"),
            request_epoch: Some("event_one"),
            stopped_at: Some(&stopped_at),
        });
        assert_eq!(
            factory_watchdog_decision(&value, now),
            WatchdogDecision::Wait,
            "assertion one millisecond short of the window still waits"
        );

        let stopped_at = (now - chrono::Duration::milliseconds(STOP_TIMEOUT_MS)).to_rfc3339();
        value.watchdog = Some(WatchdogState {
            reason_code: Some("task_stalled"),
            request_epoch: Some("event_one"),
            stopped_at: Some(&stopped_at),
        });
        assert_eq!(
            factory_watchdog_decision(&value, now),
            WatchdogDecision::StopTimeout,
            "assertion exactly five minutes without a stop acknowledgement times out"
        );

        // `stoppedAt` that does not parse is not "long ago": upstream `Date.parse` yields
        // NaN and the comparison is false, so the branch falls through to `wait`.
        value.watchdog = Some(WatchdogState {
            reason_code: Some("task_stalled"),
            request_epoch: Some("event_one"),
            stopped_at: Some("not-an-instant"),
        });
        assert_eq!(
            factory_watchdog_decision(&value, now),
            WatchdogDecision::Wait,
            "assertion an unreadable stoppedAt is never read as an expired stop window"
        );
    }

    /// Upstream `reconcile`: a Run that already ended while its Task still says `running`
    /// is reconciled from the persisted Run outcome, never re-run blindly.
    #[test]
    fn a_terminal_run_on_a_running_task_is_reconciled() {
        let now = at(1_000_000);
        for run_status in TERMINAL_RUN_STATUSES {
            let mut value = progress(now);
            value.task_status = "running";
            value.run_status = Some(run_status);
            value.progress_at = now;
            assert_eq!(
                factory_watchdog_decision(&value, now),
                WatchdogDecision::Reconcile,
                "assertion a {run_status} Run under a running Task is reconciled"
            );
        }
        // A pending Task is not reconciled: the Run outcome belongs to a dispatch decision.
        let mut pending = progress(now);
        pending.run_status = Some("failed");
        assert_eq!(
            factory_watchdog_decision(&pending, now),
            WatchdogDecision::Dispatch,
            "assertion only a running Task is reconciled from a terminal Run"
        );
    }

    /// Upstream `dispatch`: a `pending` Task in an execution stage with no active Run is
    /// handed to dispatch, and a Task whose stage is not executable is not.
    #[test]
    fn a_pending_task_in_an_execution_stage_is_dispatched_only_when_idle() {
        let now = at(1_000_000);
        for stage in ["execute", "review", "verify"] {
            let mut value = progress(now);
            value.task_stage = stage;
            assert_eq!(
                factory_watchdog_decision(&value, now),
                WatchdogDecision::Dispatch,
                "assertion an idle pending {stage} Task is dispatched"
            );
        }
        for stage in ["spec", "monitor"] {
            let mut value = progress(now);
            value.task_stage = stage;
            assert_eq!(
                factory_watchdog_decision(&value, now),
                WatchdogDecision::Wait,
                "assertion an idle pending {stage} Task is not dispatched"
            );
        }
        let mut active = progress(now);
        active.active_run = true;
        active.run_status = Some("running");
        assert_eq!(
            factory_watchdog_decision(&active, now),
            WatchdogDecision::Wait,
            "assertion a Task that already owns a Run is not dispatched twice"
        );
    }

    /// Upstream threshold: `execute` gets 45 minutes, every other stage 20 minutes, and the
    /// boundary is inclusive (`>=`).
    #[test]
    fn stage_windows_are_45_minutes_for_execute_and_20_minutes_otherwise() {
        let now = at(1_000_000);
        let mut execute = progress(now);
        // A live Run, so the earlier `dispatch` branch cannot answer first: the threshold is what
        // this test measures.
        execute.task_status = "running";
        execute.run_status = Some("running");
        execute.active_run = true;
        execute.progress_at = now - chrono::Duration::milliseconds(EXECUTE_STALL_MS - 1);
        assert_eq!(
            factory_watchdog_decision(&execute, now),
            WatchdogDecision::Wait,
            "assertion an execute Task still inside 45 minutes is not stalled"
        );
        execute.progress_at = now - chrono::Duration::milliseconds(EXECUTE_STALL_MS);
        assert_eq!(
            factory_watchdog_decision(&execute, now),
            WatchdogDecision::Stalled,
            "assertion an execute Task at 45 minutes is stalled"
        );

        let mut review = progress(now);
        review.task_status = "running";
        review.run_status = Some("running");
        review.task_stage = "review";
        review.progress_at = now - chrono::Duration::milliseconds(OTHER_STALL_MS - 1);
        assert_eq!(
            factory_watchdog_decision(&review, now),
            WatchdogDecision::Wait,
            "assertion a review Task still inside 20 minutes is not stalled"
        );
        review.progress_at = now - chrono::Duration::milliseconds(OTHER_STALL_MS);
        assert_eq!(
            factory_watchdog_decision(&review, now),
            WatchdogDecision::Stalled,
            "assertion a review Task at 20 minutes is stalled"
        );

        // The upstream exhaustion constant the sweep compares against.
        assert_eq!(
            WATCHDOG_MAX_RECOVERIES, 3,
            "assertion automatic recovery is bounded at three tries"
        );
    }
}
