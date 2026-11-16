//! LOOM V2 coordinator replay contract (P1-B Lane B): a serializable,
//! append-only event log over the existing pure reducer in
//! [`crate::v2_coordinator`], plus a deterministic replay that rebuilds a
//! [`CoordinatorState`] from envelopes alone.
//!
//! Scope (P1-B Lane B, `docs/loom/LOOM-V2-P1B-PI-RUNTIME-INTEGRATION-2026-11-15.md`):
//! - **No fork of the reducer**: every transition goes through the public
//!   [`CoordinatorState::apply`] (`v2_coordinator.rs`). This module holds no
//!   duplicate lifecycle logic and no private mirror of coordinator state.
//! - **No I/O**: no DB, no files, no clock, no network, no OS access.
//!   `recorded_at_ms` is a caller-supplied logical timestamp.
//! - **Append-only log**: [`ReplayLog::record`] appends one [`EventEnvelope`]
//!   per attempt — successful *and* rejected commands are both recorded,
//!   because `apply` advances its monotonic clock even when a command is
//!   refused; replaying only the successes would not reproduce the live
//!   state. There is no API that removes or rewrites an entry.
//! - **Replay validation**: [`replay`] rejects sequence gaps and duplicate
//!   sequence numbers, non-monotonic `recorded_at_ms`, and any envelope whose
//!   stored [`RecordedAttempt`] disagrees with what `apply` recomputes. The
//!   per-entry divergence check catches forged receipts: a wrong assignment
//!   id, a wrong holder named in an `AlreadyClaimed` receipt, a forged lease
//!   expiry in a `Claimed` receipt, and a late fence token recorded as if its
//!   command had succeeded (`Applied` instead of the recomputed
//!   `LeaseExpired` / `StaleGeneration` rejection).
//! - **Known limitation (honest)**: the reducer's outcomes do not name the
//!   claimant of a successful `Claim` (the holder lives in the rebuilt
//!   state), so swapping the `bot_id` of an `Applied` claim whose outcome is
//!   otherwise identical is not detectable by replay alone. Holder evidence
//!   is the rebuilt `CoordinatorState`'s lease fields, inspected by the
//!   outer Core; the reducer never fabricates identity.
//! - **No automatic Goal acceptance**: replay rebuilds exactly what `apply`
//!   builds. No event, envelope, or API marks a Goal accepted.
//! - **Registration**: not registered in `lib.rs` yet; Root registers the
//!   single `pub mod v2_coordinator_replay;` line, so deleting this file
//!   fully reverts the slice.

use crate::v2_coordinator::{
    CoordinatorCommand, CoordinatorError, CoordinatorOutcome, CoordinatorState,
};
use serde::{Deserialize, Serialize};
use std::fmt;

/// What actually happened when one command was fed to
/// [`CoordinatorState::apply`]. Both branches are recorded: the reducer
/// advances its clock even for refused commands, so rejections are part of
/// the deterministic replay surface, not log noise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RecordedAttempt {
    /// The command was accepted; the outcome is the exact acknowledgement.
    Applied { outcome: CoordinatorOutcome },
    /// The command was refused; the error is the exact rejection reason.
    Rejected { error: CoordinatorError },
}

/// One append-only log entry. Pure data, serde round-trips as JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEnvelope {
    /// Position in the stream, starting at 1 and increasing by exactly 1 per
    /// entry. Gaps, duplicates, and foreign starts are replay errors.
    pub sequence: u64,
    /// Caller-supplied logical timestamp of this attempt. Non-decreasing
    /// across the stream; a strictly regressing value makes replay refuse
    /// the whole stream, even when the entry itself only records a rejection.
    pub recorded_at_ms: u64,
    /// The command as submitted. Reused verbatim from `v2_coordinator`.
    pub command: CoordinatorCommand,
    /// The reducer's verdict for this command, as observed at record time.
    pub attempt: RecordedAttempt,
}

/// Why a stream could not be replayed. Serialized with a stable `code` tag,
/// mirroring [`CoordinatorError`]'s serialization style.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ReplayError {
    /// An envelope's sequence number is not `previous + 1`. Covers gaps,
    /// duplicated sequence numbers, and streams that do not start at 1.
    SequenceGap { expected: u64, got: u64 },
    /// A stream-level non-decreasing check on `recorded_at_ms` failed. This
    /// fires even when the regressing entry only records a rejection, so a
    /// regressing timestamp can never hide inside an "unapplied" envelope.
    TimeRegression {
        last_recorded_at_ms: u64,
        got_recorded_at_ms: u64,
    },
    /// The stored attempt disagrees with what `apply` recomputed for the
    /// stored command at the stored time: forged or tampered receipt.
    Mismatch {
        sequence: u64,
        expected: RecordedAttempt,
        actual: RecordedAttempt,
    },
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SequenceGap { expected, got } => {
                write!(
                    f,
                    "event stream sequence gap: expected {expected}, got {got}"
                )
            }
            Self::TimeRegression {
                last_recorded_at_ms,
                got_recorded_at_ms,
            } => write!(
                f,
                "event stream time regression: recorded_at_ms regressed from {last_recorded_at_ms} to {got_recorded_at_ms}"
            ),
            Self::Mismatch {
                sequence,
                expected,
                actual,
            } => write!(
                f,
                "replay diverged at sequence {sequence}: expected {expected:?}, recomputed {actual:?}"
            ),
        }
    }
}

/// Append-only, in-memory event log paired with one live
/// [`CoordinatorState`]. `record` is the only way in; there is no removal,
/// no rewrite, and no import of foreign envelopes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplayLog {
    entries: Vec<EventEnvelope>,
}

impl ReplayLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one command to the reducer at a logical time and append the
    /// outcome to the log, whatever it is.
    ///
    /// Time authority stays with `apply`: a strictly regressing
    /// `recorded_at_ms` is refused by `apply` itself
    /// ([`CoordinatorError::TimeRegression`], state clock unmoved), and that
    /// refusal is recorded like any other attempt. The log therefore mirrors
    /// the reducer exactly instead of second-guessing it; [`replay`]'s
    /// stream-level monotonicity check is what refuses to rebuild from a
    /// log that ever recorded a regression.
    pub fn record(
        &mut self,
        state: &mut CoordinatorState,
        command: CoordinatorCommand,
        recorded_at_ms: u64,
    ) -> RecordedAttempt {
        let attempt = match state.apply(command.clone(), recorded_at_ms) {
            Ok(outcome) => RecordedAttempt::Applied { outcome },
            Err(error) => RecordedAttempt::Rejected { error },
        };
        let sequence = self.entries.len() as u64 + 1;
        self.entries.push(EventEnvelope {
            sequence,
            recorded_at_ms,
            command,
            attempt: attempt.clone(),
        });
        attempt
    }

    pub fn envelopes(&self) -> &[EventEnvelope] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Deterministically rebuild a [`CoordinatorState`] from envelopes alone.
///
/// For each envelope, in order: the sequence number must be exactly
/// `previous + 1` (first envelope must be 1); `recorded_at_ms` must not
/// regress; the stored command is applied to a fresh state at the stored
/// time and the recomputed attempt must equal the stored attempt. On the
/// first violation the stream is refused; nothing partial is returned.
pub fn replay(
    envelopes: &[EventEnvelope],
) -> Result<(CoordinatorState, Vec<RecordedAttempt>), ReplayError> {
    let mut state = CoordinatorState::new();
    let mut attempts = Vec::with_capacity(envelopes.len());
    let mut last_recorded_at_ms: Option<u64> = None;
    for (index, envelope) in envelopes.iter().enumerate() {
        let expected_sequence = index as u64 + 1;
        if envelope.sequence != expected_sequence {
            return Err(ReplayError::SequenceGap {
                expected: expected_sequence,
                got: envelope.sequence,
            });
        }
        if let Some(last) = last_recorded_at_ms {
            if envelope.recorded_at_ms < last {
                return Err(ReplayError::TimeRegression {
                    last_recorded_at_ms: last,
                    got_recorded_at_ms: envelope.recorded_at_ms,
                });
            }
        }
        last_recorded_at_ms = Some(envelope.recorded_at_ms);
        let actual = match state.apply(envelope.command.clone(), envelope.recorded_at_ms) {
            Ok(outcome) => RecordedAttempt::Applied { outcome },
            Err(error) => RecordedAttempt::Rejected { error },
        };
        if actual != envelope.attempt {
            return Err(ReplayError::Mismatch {
                sequence: envelope.sequence,
                expected: envelope.attempt.clone(),
                actual,
            });
        }
        attempts.push(actual);
    }
    Ok((state, attempts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2_coordinator::{
        AssignmentId, AssignmentStatus, BotId, CoordinatorCommand, CoordinatorError,
        CoordinatorOutcome, CoordinatorState, FenceToken, GoalId,
    };

    const BASE_MS: u64 = 1_700_000_000_000;

    fn goal() -> GoalId {
        GoalId::new("goal_1").unwrap()
    }

    fn other_goal() -> GoalId {
        GoalId::new("goal_2").unwrap()
    }

    fn aid(n: u32) -> AssignmentId {
        AssignmentId::new(&format!("asg_{n}")).unwrap()
    }

    fn bot(name: &str) -> BotId {
        BotId::new(name).unwrap()
    }

    fn at(offset: u64) -> u64 {
        BASE_MS + offset
    }

    fn push(
        state: &mut CoordinatorState,
        log: &mut ReplayLog,
        command: CoordinatorCommand,
        recorded_at_ms: u64,
    ) -> RecordedAttempt {
        log.record(state, command, recorded_at_ms)
    }

    /// Register goal, register asg_1, claim by worker_a (lease 1000 ms,
    /// expires at `at(2_000)`, fence 1).
    fn fixture() -> (CoordinatorState, ReplayLog) {
        let mut state = CoordinatorState::new();
        let mut log = ReplayLog::new();
        push(
            &mut state,
            &mut log,
            CoordinatorCommand::RegisterGoal { goal_id: goal() },
            at(1),
        );
        push(
            &mut state,
            &mut log,
            CoordinatorCommand::RegisterAssignment {
                assignment_id: aid(1),
                goal_id: goal(),
                owner_bot: Some(bot("owner")),
                depends_on: vec![],
            },
            at(2),
        );
        push(
            &mut state,
            &mut log,
            CoordinatorCommand::Claim {
                assignment_id: aid(1),
                bot_id: bot("worker_a"),
                lease_ms: 1_000,
                expected_generation: None,
            },
            at(1_000),
        );
        (state, log)
    }

    fn logged_attempts(envelopes: &[EventEnvelope]) -> Vec<RecordedAttempt> {
        envelopes.iter().map(|e| e.attempt.clone()).collect()
    }

    #[test]
    fn t01_replay_rebuilds_identical_state_from_a_successful_stream() {
        let (mut state, mut log) = fixture();
        push(
            &mut state,
            &mut log,
            CoordinatorCommand::CompleteWork {
                assignment_id: aid(1),
                fence: FenceToken(1),
                result_digest: "digest_1".into(),
            },
            at(1_500),
        );
        push(
            &mut state,
            &mut log,
            CoordinatorCommand::SubmitReview {
                assignment_id: aid(1),
                reviewer: bot("reviewer"),
                approved: true,
            },
            at(1_600),
        );

        let envelopes = log.envelopes().to_vec();
        let (replayed, attempts) = replay(&envelopes).unwrap();
        assert_eq!(replayed, state, "replay must reproduce the exact state");
        assert_eq!(attempts, logged_attempts(&envelopes));
        let progress = replayed.goal_progress(&goal()).unwrap();
        assert_eq!(progress.approved, 1);
        assert!(progress.all_reviewed);
        // Goal acceptance is not derived by anything: the reducer has no
        // accepted flag and replay adds none.
        assert_eq!(
            replayed.assignment(&aid(1)).unwrap().status,
            AssignmentStatus::Approved
        );
    }

    #[test]
    fn t02_rejected_attempts_are_recorded_and_replay_to_the_same_state() {
        let (mut state, mut log) = fixture();
        let duplicate_goal = push(
            &mut state,
            &mut log,
            CoordinatorCommand::RegisterGoal { goal_id: goal() },
            at(1_100),
        );
        let duplicate_assignment = push(
            &mut state,
            &mut log,
            CoordinatorCommand::RegisterAssignment {
                assignment_id: aid(1),
                goal_id: goal(),
                owner_bot: None,
                depends_on: vec![],
            },
            at(1_200),
        );
        let review_while_claimed = push(
            &mut state,
            &mut log,
            CoordinatorCommand::SubmitReview {
                assignment_id: aid(1),
                reviewer: bot("reviewer"),
                approved: true,
            },
            at(1_300),
        );
        assert_eq!(
            duplicate_goal,
            RecordedAttempt::Rejected {
                error: CoordinatorError::DuplicateGoal
            }
        );
        assert_eq!(
            duplicate_assignment,
            RecordedAttempt::Rejected {
                error: CoordinatorError::DuplicateAssignment
            }
        );
        assert_eq!(
            review_while_claimed,
            RecordedAttempt::Rejected {
                error: CoordinatorError::InvalidTransition {
                    current: AssignmentStatus::Claimed
                }
            }
        );

        let envelopes = log.envelopes().to_vec();
        let (replayed, attempts) = replay(&envelopes).unwrap();
        assert_eq!(replayed, state);
        assert_eq!(attempts, logged_attempts(&envelopes));
    }

    #[test]
    fn t03_sequence_gap_is_rejected() {
        let (_state, log) = fixture();
        let mut envelopes = log.envelopes().to_vec();
        envelopes.remove(1); // drop sequence 2, leaving 1, 3
        assert_eq!(
            replay(&envelopes),
            Err(ReplayError::SequenceGap {
                expected: 2,
                got: 3,
            })
        );
    }

    #[test]
    fn t04_duplicate_sequence_number_is_rejected() {
        let (_state, log) = fixture();
        let mut envelopes = log.envelopes().to_vec();
        envelopes[1].sequence = 1; // duplicate of the first sequence
        assert_eq!(
            replay(&envelopes),
            Err(ReplayError::SequenceGap {
                expected: 2,
                got: 1,
            })
        );
    }

    #[test]
    fn t05_stream_not_starting_at_one_is_rejected() {
        let (_state, log) = fixture();
        let mut envelopes = log.envelopes().to_vec();
        envelopes[0].sequence = 2;
        assert_eq!(
            replay(&envelopes),
            Err(ReplayError::SequenceGap {
                expected: 1,
                got: 2,
            })
        );
    }

    #[test]
    fn t06_regressing_recorded_at_ms_is_rejected() {
        let (_state, log) = fixture();
        let mut envelopes = log.envelopes().to_vec();
        envelopes[2].recorded_at_ms = 0;
        assert_eq!(
            replay(&envelopes),
            Err(ReplayError::TimeRegression {
                last_recorded_at_ms: at(2),
                got_recorded_at_ms: 0,
            })
        );
    }

    #[test]
    fn t07_forged_applied_receipt_for_a_wrong_assignment_id_diverges() {
        let (_state, log) = fixture();
        let mut envelopes = log.envelopes().to_vec();
        // The claim was really for asg_1; the forged envelope names an
        // unregistered assignment but keeps the stored Applied receipt.
        envelopes[2].command = CoordinatorCommand::Claim {
            assignment_id: AssignmentId::new("asg_404").unwrap(),
            bot_id: bot("worker_a"),
            lease_ms: 1_000,
            expected_generation: None,
        };
        let expected = envelopes[2].attempt.clone();
        match replay(&envelopes) {
            Err(ReplayError::Mismatch {
                sequence,
                expected: stored,
                actual,
            }) => {
                assert_eq!(sequence, 3);
                assert_eq!(stored, expected);
                assert_eq!(
                    actual,
                    RecordedAttempt::Rejected {
                        error: CoordinatorError::UnknownAssignment
                    }
                );
            }
            other => panic!("expected mismatch, got {other:?}"),
        }
    }

    #[test]
    fn t08_forged_holder_in_a_rejection_receipt_diverges() {
        let (mut state, mut log) = fixture();
        let attempt = push(
            &mut state,
            &mut log,
            CoordinatorCommand::Claim {
                assignment_id: aid(1),
                bot_id: bot("worker_b"),
                lease_ms: 1_000,
                expected_generation: None,
            },
            at(1_200),
        );
        let genuine = CoordinatorError::AlreadyClaimed {
            holder: bot("worker_a"),
            lease_expires_at_ms: at(2_000),
        };
        assert_eq!(
            attempt,
            RecordedAttempt::Rejected {
                error: genuine.clone()
            }
        );

        // Forged receipt names a worker that never held the lease.
        let mut envelopes = log.envelopes().to_vec();
        envelopes[3].attempt = RecordedAttempt::Rejected {
            error: CoordinatorError::AlreadyClaimed {
                holder: bot("worker_forged"),
                lease_expires_at_ms: at(2_000),
            },
        };
        match replay(&envelopes) {
            Err(ReplayError::Mismatch {
                sequence, actual, ..
            }) => {
                assert_eq!(sequence, 4);
                assert_eq!(actual, RecordedAttempt::Rejected { error: genuine });
            }
            other => panic!("expected mismatch, got {other:?}"),
        }
    }

    #[test]
    fn t09_forged_lease_expiry_in_a_claimed_receipt_diverges() {
        let (_state, log) = fixture();
        let mut envelopes = log.envelopes().to_vec();
        envelopes[2].attempt = RecordedAttempt::Applied {
            outcome: CoordinatorOutcome::Claimed {
                fence: FenceToken(1),
                lease_expires_at_ms: 9_999,
            },
        };
        match replay(&envelopes) {
            Err(ReplayError::Mismatch {
                sequence, actual, ..
            }) => {
                assert_eq!(sequence, 3);
                assert_eq!(
                    actual,
                    RecordedAttempt::Applied {
                        outcome: CoordinatorOutcome::Claimed {
                            fence: FenceToken(1),
                            lease_expires_at_ms: at(2_000),
                        }
                    }
                );
            }
            other => panic!("expected mismatch, got {other:?}"),
        }
    }

    #[test]
    fn t10_late_fence_receipt_recorded_as_rejection_replays_cleanly() {
        let (mut state, mut log) = fixture();
        let late = push(
            &mut state,
            &mut log,
            CoordinatorCommand::CompleteWork {
                assignment_id: aid(1),
                fence: FenceToken(1),
                result_digest: "late".into(),
            },
            at(2_500),
        );
        assert_eq!(
            late,
            RecordedAttempt::Rejected {
                error: CoordinatorError::LeaseExpired {
                    lease_expires_at_ms: at(2_000),
                    now_ms: at(2_500),
                }
            }
        );
        // The late receipt cleared the dead lease, so a fresh claim succeeds.
        let reclaimed = push(
            &mut state,
            &mut log,
            CoordinatorCommand::Claim {
                assignment_id: aid(1),
                bot_id: bot("worker_b"),
                lease_ms: 1_000,
                expected_generation: None,
            },
            at(2_600),
        );
        assert_eq!(
            reclaimed,
            RecordedAttempt::Applied {
                outcome: CoordinatorOutcome::Claimed {
                    fence: FenceToken(2),
                    lease_expires_at_ms: at(3_600),
                }
            }
        );

        let envelopes = log.envelopes().to_vec();
        let (replayed, attempts) = replay(&envelopes).unwrap();
        assert_eq!(replayed, state, "honest rejection stream replays fully");
        assert_eq!(attempts, logged_attempts(&envelopes));
    }

    #[test]
    fn t11_forged_applied_late_fence_receipt_is_rejected() {
        let (_state, log) = fixture();
        let mut envelopes = log.envelopes().to_vec();
        // A completion after the lease deadline, recorded as if it succeeded.
        envelopes.push(EventEnvelope {
            sequence: 4,
            recorded_at_ms: at(2_500),
            command: CoordinatorCommand::CompleteWork {
                assignment_id: aid(1),
                fence: FenceToken(1),
                result_digest: "forged".into(),
            },
            attempt: RecordedAttempt::Applied {
                outcome: CoordinatorOutcome::WorkCompleted,
            },
        });
        match replay(&envelopes) {
            Err(ReplayError::Mismatch {
                sequence,
                expected,
                actual,
            }) => {
                assert_eq!(sequence, 4);
                assert_eq!(
                    expected,
                    RecordedAttempt::Applied {
                        outcome: CoordinatorOutcome::WorkCompleted
                    }
                );
                assert_eq!(
                    actual,
                    RecordedAttempt::Rejected {
                        error: CoordinatorError::LeaseExpired {
                            lease_expires_at_ms: at(2_000),
                            now_ms: at(2_500),
                        }
                    }
                );
            }
            other => panic!("expected mismatch, got {other:?}"),
        }
    }

    #[test]
    fn t12_time_regression_attempt_is_recorded_and_makes_replay_refuse_the_stream() {
        let (mut state, mut log) = fixture();
        let attempt = push(
            &mut state,
            &mut log,
            CoordinatorCommand::RegisterGoal {
                goal_id: other_goal(),
            },
            at(999),
        );
        assert_eq!(
            attempt,
            RecordedAttempt::Rejected {
                error: CoordinatorError::TimeRegression {
                    last_now_ms: at(1_000),
                    got_now_ms: at(999),
                }
            }
        );
        // The refusal did not advance the reducer clock: equal-time commands
        // still work afterwards.
        let ok = push(
            &mut state,
            &mut log,
            CoordinatorCommand::RegisterGoal {
                goal_id: other_goal(),
            },
            at(1_000),
        );
        assert_eq!(
            ok,
            RecordedAttempt::Applied {
                outcome: CoordinatorOutcome::GoalRegistered
            }
        );

        let envelopes = log.envelopes().to_vec();
        assert_eq!(envelopes.len(), 5);
        assert_eq!(envelopes[3].sequence, 4);
        assert_eq!(envelopes[3].recorded_at_ms, at(999));
        assert_eq!(
            replay(&envelopes),
            Err(ReplayError::TimeRegression {
                last_recorded_at_ms: at(1_000),
                got_recorded_at_ms: at(999),
            })
        );
    }

    #[test]
    fn t13_envelopes_and_errors_round_trip_through_json() {
        let (mut state, mut log) = fixture();
        // Equal-time duplicate register: rejected, recorded, serialized.
        let attempt = push(
            &mut state,
            &mut log,
            CoordinatorCommand::RegisterGoal { goal_id: goal() },
            at(1_000),
        );
        assert!(matches!(attempt, RecordedAttempt::Rejected { .. }));

        let envelopes = log.envelopes().to_vec();
        let json = serde_json::to_string(&envelopes).unwrap();
        assert!(json.contains("\"kind\":\"rejected\""), "got {json}");
        assert!(json.contains("\"code\":\"duplicate_goal\""), "got {json}");
        assert!(json.contains("\"type\":\"claim\""), "got {json}");
        let parsed: Vec<EventEnvelope> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, envelopes, "envelope JSON must round-trip");
        let (replayed, _) = replay(&parsed).unwrap();
        assert_eq!(replayed, state, "replay must work from deserialized data");

        let err = ReplayError::SequenceGap {
            expected: 7,
            got: 9,
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"code\":\"sequence_gap\""), "got {json}");
        assert_eq!(serde_json::from_str::<ReplayError>(&json).unwrap(), err);
    }

    #[test]
    fn t14_replay_of_an_empty_stream_yields_a_fresh_state() {
        let (state, attempts) = replay(&[]).unwrap();
        assert_eq!(state, CoordinatorState::new());
        assert!(attempts.is_empty());
    }
}
