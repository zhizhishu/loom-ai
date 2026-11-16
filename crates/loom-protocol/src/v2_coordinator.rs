//! LOOM V2 coordinator contract (Lane B): a pure, in-memory reducer for the
//! ACCP-style Assignment DAG / Claim / Lease / Fence / Review lifecycle.
//!
//! Scope (P1-A four-lane slice, `docs/loom/LOOM-V2-P1-FOUR-LANE-SLICE-2026-11-15.md` G1 Lane B):
//! - **No I/O of any kind**: no clock, no DB, no network, no process. Every
//!   decision is driven by the `now_ms` argument passed into
//!   [`CoordinatorState::apply`]. This module is not registered in
//!   `lib.rs` yet; Root registers it as a single `pub mod v2_coordinator;`
//!   line, and deleting this file fully reverts the slice.
//! - **Deadline semantics (Root revision)**: a lease is invalid once
//!   `now_ms >= lease_expires_at_ms`. Completing, extending, or holding a
//!   claim at exactly the deadline is rejected (`LeaseExpired`).
//! - **Fencing (Root revision)**: every claim bumps `claim_generation` and
//!   returns a [`FenceToken`]. Any command carrying an old token is rejected
//!   with [`CoordinatorError::StaleGeneration`]. A late receipt on an expired
//!   lease is rejected with [`CoordinatorError::LeaseExpired`] (the dead lease
//!   is cleared so later claims succeed; the late receipt itself is refused).
//! - **Idempotency (Root revision)**: a repeated command must not produce a
//!   second delivery. `CompleteWork` replayed with the same fence returns
//!   [`CoordinatorError::DuplicateDelivery`]; a repeated `SubmitReview` on an
//!   already-reviewed assignment also returns `DuplicateDelivery`.
//! - **No automatic Goal completion (Root revision)**: the reducer has no API
//!   that marks a Goal accepted. [`GoalProgress::all_reviewed`] is a read-only
//!   aggregate; Goal acceptance stays an explicit outer-Core decision.
//! - **Reviewer authority**: `SubmitReview` records *who* reviewed, but does
//!   not and cannot verify that the reviewer holds approval authority.
//!   Reviewer authorization is a Core-side outer gate, not enforced here.
//! - **DAG**: dependencies must be registered before dependents, so cycles are
//!   structurally impossible; a self-dependency is still rejected explicitly
//!   (`DependencyCycle`) and a forward reference is rejected
//!   (`UnknownDependency`) so the rejection is auditable, not incidental.
//! - **Clock**: `now_ms` must never regress (`TimeRegression`). Time is
//!   observed monotonically even when a command is rejected afterwards.
//! - **Identity**: `GoalId` / `AssignmentId` / `BotId` are opaque, validated
//!   strings local to this module. Unifying them with Lane A's `v2_domain`
//!   IDs is a Root integration decision; no cross-module call is promised.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

const MAX_ID_LEN: usize = 128;

fn validate_id(raw: &str) -> Result<(), CoordinatorError> {
    if raw.is_empty() || raw.chars().any(char::is_control) || raw.len() > MAX_ID_LEN {
        return Err(CoordinatorError::InvalidId);
    }
    Ok(())
}

macro_rules! define_string_id {
    ($name:ident) => {
        /// Opaque, validated identifier. Serialized transparently as its string.
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Non-empty, at most [`MAX_ID_LEN`] bytes, no control characters.
            pub fn new(raw: &str) -> Result<Self, CoordinatorError> {
                validate_id(raw)?;
                Ok(Self(raw.to_string()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

define_string_id!(GoalId);
define_string_id!(AssignmentId);
define_string_id!(BotId);

/// Fencing token handed out by a successful [`CoordinatorCommand::Claim`].
/// Equal to the assignment's `claim_generation` at claim time; any later
/// claim invalidates it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FenceToken(pub u64);

impl fmt::Display for FenceToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "fence#{}", self.0)
    }
}

/// Lifecycle of one assignment inside the reducer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssignmentStatus {
    /// Registered, dependencies not yet all approved, never claimed.
    Registered,
    /// Held under a live lease by one bot with one fence token.
    Claimed,
    /// Work was completed under a valid fence; waiting for review.
    AwaitingReview,
    /// A review approved the work. Terminal in this reducer.
    Approved,
    /// A review rejected the work. Terminal in this reducer.
    Rejected,
    /// The holder reported failure under a valid fence. Terminal here; any
    /// re-assignment is a new, explicitly registered assignment.
    Failed,
}

/// Full observable state of one assignment. Pure data; serde round-trips.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub goal_id: GoalId,
    /// Suggested executor. A claim by a different bot is still recorded as
    /// the lease holder; identity is never fabricated by the reducer.
    pub owner_bot: Option<BotId>,
    /// Assignments that must be `Approved` before this one can be claimed.
    pub depends_on: Vec<AssignmentId>,
    pub status: AssignmentStatus,
    /// Bumped on every claim. Old fence tokens die here.
    pub claim_generation: u64,
    pub lease_holder: Option<BotId>,
    /// Exclusive deadline; invalid once `now_ms >= this` (Root revision).
    pub lease_expires_at_ms: Option<u64>,
    pub result_digest: Option<String>,
    pub fail_reason: Option<String>,
    /// Recorded on review. Reviewer *authority* is an outer Core gate.
    pub reviewed_by: Option<BotId>,
}

/// Commands into the reducer. Every decision uses the `now_ms` argument of
/// [`CoordinatorState::apply`]; commands never carry timestamps themselves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoordinatorCommand {
    RegisterGoal {
        goal_id: GoalId,
    },
    /// Dependencies must already be registered; self-dependency is rejected.
    RegisterAssignment {
        assignment_id: AssignmentId,
        goal_id: GoalId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        owner_bot: Option<BotId>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        depends_on: Vec<AssignmentId>,
    },
    /// Exactly one live claim per assignment. `lease_ms` must be >= 1.
    Claim {
        assignment_id: AssignmentId,
        bot_id: BotId,
        lease_ms: u64,
        /// Optimistic guard: rejected as stale if it differs from the
        /// assignment's current generation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    ExtendLease {
        assignment_id: AssignmentId,
        fence: FenceToken,
        extend_ms: u64,
    },
    /// Only valid under a live lease with the current fence; moves the
    /// assignment to `AwaitingReview`. Never completes a Goal.
    CompleteWork {
        assignment_id: AssignmentId,
        fence: FenceToken,
        result_digest: String,
    },
    FailWork {
        assignment_id: AssignmentId,
        fence: FenceToken,
        fail_reason: String,
    },
    /// Reviewer authority is an outer Core gate; the reducer only records.
    SubmitReview {
        assignment_id: AssignmentId,
        reviewer: BotId,
        approved: bool,
    },
}

/// Acknowledgements returned by successful commands. Pure data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoordinatorOutcome {
    GoalRegistered,
    AssignmentRegistered,
    Claimed {
        fence: FenceToken,
        lease_expires_at_ms: u64,
    },
    LeaseExtended {
        lease_expires_at_ms: u64,
    },
    WorkCompleted,
    WorkFailed,
    ReviewRecorded {
        approved: bool,
    },
}

/// Auditable rejections. Serialized with a stable `code` tag so logs and
/// receipts can carry the exact refusal reason alongside the state evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CoordinatorError {
    InvalidId,
    TimeRegression {
        last_now_ms: u64,
        got_now_ms: u64,
    },
    UnknownGoal,
    DuplicateGoal,
    DuplicateAssignment,
    UnknownAssignment,
    UnknownDependency {
        dependency: AssignmentId,
    },
    /// Self-dependency (and any cycle, by construction) rejected explicitly.
    DependencyCycle {
        assignment_id: AssignmentId,
    },
    DependenciesNotSatisfied {
        pending: Vec<AssignmentId>,
    },
    AlreadyClaimed {
        holder: BotId,
        lease_expires_at_ms: u64,
    },
    /// Late receipt: the lease deadline passed (deadline itself inclusive).
    LeaseExpired {
        lease_expires_at_ms: u64,
        now_ms: u64,
    },
    StaleGeneration {
        current_generation: u64,
        got: u64,
    },
    InvalidTransition {
        current: AssignmentStatus,
    },
    /// The same command already settled; no second delivery is produced.
    DuplicateDelivery {
        current: AssignmentStatus,
    },
    InvalidLease {
        lease_ms: u64,
    },
}

impl fmt::Display for CoordinatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => write!(
                f,
                "id must be non-empty, at most {MAX_ID_LEN} bytes, no control characters"
            ),
            Self::TimeRegression {
                last_now_ms,
                got_now_ms,
            } => write!(
                f,
                "now_ms regressed: got {got_now_ms}, last observed {last_now_ms}"
            ),
            Self::UnknownGoal => write!(f, "goal not registered"),
            Self::DuplicateGoal => write!(f, "goal already registered"),
            Self::DuplicateAssignment => write!(f, "assignment already registered"),
            Self::UnknownAssignment => write!(f, "assignment not registered"),
            Self::UnknownDependency { dependency } => {
                write!(f, "dependency {dependency} not registered yet")
            }
            Self::DependencyCycle { assignment_id } => {
                write!(
                    f,
                    "assignment {assignment_id} depends on itself (cycles are rejected)"
                )
            }
            Self::DependenciesNotSatisfied { pending } => write!(
                f,
                "dependencies not approved yet: {}",
                pending
                    .iter()
                    .map(|id| id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Self::AlreadyClaimed {
                holder,
                lease_expires_at_ms,
            } => write!(
                f,
                "assignment already claimed by {holder} until {lease_expires_at_ms}"
            ),
            Self::LeaseExpired {
                lease_expires_at_ms,
                now_ms,
            } => write!(
                f,
                "lease expired at {lease_expires_at_ms}: late receipt at {now_ms} rejected"
            ),
            Self::StaleGeneration {
                current_generation,
                got,
            } => write!(
                f,
                "stale fence token: assignment generation is {current_generation}, got {got}"
            ),
            Self::InvalidTransition { current } => {
                write!(f, "command not valid while assignment is {current:?}")
            }
            Self::DuplicateDelivery { current } => write!(
                f,
                "duplicate command already settled (assignment is {current:?}); no second delivery"
            ),
            Self::InvalidLease { lease_ms } => {
                write!(f, "lease duration must be >= 1 ms, got {lease_ms}")
            }
        }
    }
}

/// Read-only aggregate over the assignments of one goal. There is
/// deliberately **no** `accepted` flag: Goal acceptance is an explicit outer
/// Core decision and can never be derived automatically by this reducer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalProgress {
    pub total: usize,
    pub approved: usize,
    pub rejected: usize,
    pub failed: usize,
    /// Registered + Claimed + AwaitingReview.
    pub open: usize,
    /// True only when at least one assignment exists and none are open.
    pub all_reviewed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoordinatorState {
    goals: BTreeSet<GoalId>,
    assignments: BTreeMap<AssignmentId, Assignment>,
    last_now_ms: u64,
}

/// A lease is invalid once `now_ms >= expires_at_ms` (deadline inclusive).
fn lease_is_expired(assignment: &Assignment, now_ms: u64) -> bool {
    matches!(assignment.lease_expires_at_ms, Some(expires) if now_ms >= expires)
}

/// Lazily clear a dead lease so reclaim becomes possible. Only called when a
/// lease actually expired at `now_ms`.
fn clear_expired_lease(assignment: &mut Assignment) {
    assignment.lease_holder = None;
    assignment.lease_expires_at_ms = None;
    if assignment.status == AssignmentStatus::Claimed {
        assignment.status = AssignmentStatus::Registered;
    }
}

impl CoordinatorState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Single entry point. `now_ms` is the controlled clock: it must never
    /// regress, and every state transition derives its expiry decisions from
    /// it. No I/O happens here; the state is plain memory.
    pub fn apply(
        &mut self,
        cmd: CoordinatorCommand,
        now_ms: u64,
    ) -> Result<CoordinatorOutcome, CoordinatorError> {
        if now_ms < self.last_now_ms {
            return Err(CoordinatorError::TimeRegression {
                last_now_ms: self.last_now_ms,
                got_now_ms: now_ms,
            });
        }
        self.last_now_ms = now_ms;
        match cmd {
            CoordinatorCommand::RegisterGoal { goal_id } => self.register_goal(goal_id),
            CoordinatorCommand::RegisterAssignment {
                assignment_id,
                goal_id,
                owner_bot,
                depends_on,
            } => self.register_assignment(assignment_id, goal_id, owner_bot, depends_on),
            CoordinatorCommand::Claim {
                assignment_id,
                bot_id,
                lease_ms,
                expected_generation,
            } => self.claim(assignment_id, bot_id, lease_ms, expected_generation, now_ms),
            CoordinatorCommand::ExtendLease {
                assignment_id,
                fence,
                extend_ms,
            } => self.extend_lease(assignment_id, fence, extend_ms, now_ms),
            CoordinatorCommand::CompleteWork {
                assignment_id,
                fence,
                result_digest,
            } => self.complete_work(assignment_id, fence, result_digest, now_ms),
            CoordinatorCommand::FailWork {
                assignment_id,
                fence,
                fail_reason,
            } => self.fail_work(assignment_id, fence, fail_reason, now_ms),
            CoordinatorCommand::SubmitReview {
                assignment_id,
                reviewer,
                approved,
            } => self.submit_review(assignment_id, reviewer, approved),
        }
    }

    pub fn assignment(&self, id: &AssignmentId) -> Option<&Assignment> {
        self.assignments.get(id)
    }

    pub fn goal_registered(&self, goal: &GoalId) -> bool {
        self.goals.contains(goal)
    }

    /// `None` when the goal is unknown. Never derives a Goal acceptance.
    pub fn goal_progress(&self, goal: &GoalId) -> Option<GoalProgress> {
        if !self.goals.contains(goal) {
            return None;
        }
        let mut total = 0usize;
        let mut approved = 0usize;
        let mut rejected = 0usize;
        let mut failed = 0usize;
        let mut open = 0usize;
        for assignment in self.assignments.values() {
            if &assignment.goal_id != goal {
                continue;
            }
            total += 1;
            match assignment.status {
                AssignmentStatus::Approved => approved += 1,
                AssignmentStatus::Rejected => rejected += 1,
                AssignmentStatus::Failed => failed += 1,
                _ => open += 1,
            }
        }
        Some(GoalProgress {
            total,
            approved,
            rejected,
            failed,
            open,
            all_reviewed: total > 0 && open == 0,
        })
    }

    fn register_goal(&mut self, goal_id: GoalId) -> Result<CoordinatorOutcome, CoordinatorError> {
        if !self.goals.insert(goal_id) {
            return Err(CoordinatorError::DuplicateGoal);
        }
        Ok(CoordinatorOutcome::GoalRegistered)
    }

    fn register_assignment(
        &mut self,
        assignment_id: AssignmentId,
        goal_id: GoalId,
        owner_bot: Option<BotId>,
        depends_on: Vec<AssignmentId>,
    ) -> Result<CoordinatorOutcome, CoordinatorError> {
        if !self.goals.contains(&goal_id) {
            return Err(CoordinatorError::UnknownGoal);
        }
        if self.assignments.contains_key(&assignment_id) {
            return Err(CoordinatorError::DuplicateAssignment);
        }
        if depends_on.contains(&assignment_id) {
            return Err(CoordinatorError::DependencyCycle { assignment_id });
        }
        for dependency in &depends_on {
            if !self.assignments.contains_key(dependency) {
                return Err(CoordinatorError::UnknownDependency {
                    dependency: dependency.clone(),
                });
            }
        }
        // Dependencies must be registered before dependents, so cross-
        // assignment cycles cannot be formed; the self-dependency check above
        // makes the impossible-case rejection auditable rather than incidental.
        self.assignments.insert(
            assignment_id,
            Assignment {
                goal_id,
                owner_bot,
                depends_on,
                status: AssignmentStatus::Registered,
                claim_generation: 0,
                lease_holder: None,
                lease_expires_at_ms: None,
                result_digest: None,
                fail_reason: None,
                reviewed_by: None,
            },
        );
        Ok(CoordinatorOutcome::AssignmentRegistered)
    }

    fn claim(
        &mut self,
        assignment_id: AssignmentId,
        bot_id: BotId,
        lease_ms: u64,
        expected_generation: Option<u64>,
        now_ms: u64,
    ) -> Result<CoordinatorOutcome, CoordinatorError> {
        // Scoped mutable borrow: lazily clear a dead lease first, then end
        // the borrow so the dependency check below can read self.assignments
        // immutably without an E0502 conflict.
        {
            let slot = self
                .assignments
                .get_mut(&assignment_id)
                .ok_or(CoordinatorError::UnknownAssignment)?;
            if lease_is_expired(slot, now_ms) {
                clear_expired_lease(slot);
            }
        }
        let assignment = self
            .assignments
            .get(&assignment_id)
            .cloned()
            .ok_or(CoordinatorError::UnknownAssignment)?;
        if let Some(expected) = expected_generation {
            if expected != assignment.claim_generation {
                return Err(CoordinatorError::StaleGeneration {
                    current_generation: assignment.claim_generation,
                    got: expected,
                });
            }
        }
        match assignment.status {
            AssignmentStatus::Registered => {}
            AssignmentStatus::Claimed => {
                return Err(CoordinatorError::AlreadyClaimed {
                    holder: assignment
                        .lease_holder
                        .clone()
                        .expect("claimed assignment always has a holder"),
                    lease_expires_at_ms: assignment
                        .lease_expires_at_ms
                        .expect("claimed assignment always has a deadline"),
                });
            }
            current => return Err(CoordinatorError::InvalidTransition { current }),
        }
        if lease_ms == 0 {
            return Err(CoordinatorError::InvalidLease { lease_ms });
        }
        // Immutable dependency gate: dependencies must be Approved before a
        // claim is admitted (completed-but-unreviewed still blocks).
        let pending: Vec<AssignmentId> = assignment
            .depends_on
            .iter()
            .filter(|dependency| {
                self.assignments
                    .get(*dependency)
                    .is_none_or(|dep| dep.status != AssignmentStatus::Approved)
            })
            .cloned()
            .collect();
        if !pending.is_empty() {
            return Err(CoordinatorError::DependenciesNotSatisfied { pending });
        }
        let slot = self
            .assignments
            .get_mut(&assignment_id)
            .expect("assignment existence checked above");
        slot.claim_generation += 1;
        let expires_at = now_ms + lease_ms;
        slot.lease_holder = Some(bot_id);
        slot.lease_expires_at_ms = Some(expires_at);
        slot.status = AssignmentStatus::Claimed;
        Ok(CoordinatorOutcome::Claimed {
            fence: FenceToken(slot.claim_generation),
            lease_expires_at_ms: expires_at,
        })
    }

    fn extend_lease(
        &mut self,
        assignment_id: AssignmentId,
        fence: FenceToken,
        extend_ms: u64,
        now_ms: u64,
    ) -> Result<CoordinatorOutcome, CoordinatorError> {
        let assignment = self
            .assignments
            .get_mut(&assignment_id)
            .ok_or(CoordinatorError::UnknownAssignment)?;
        if fence.0 != assignment.claim_generation {
            return Err(CoordinatorError::StaleGeneration {
                current_generation: assignment.claim_generation,
                got: fence.0,
            });
        }
        if lease_is_expired(assignment, now_ms) {
            let expires = assignment.lease_expires_at_ms.unwrap_or(now_ms);
            clear_expired_lease(assignment);
            return Err(CoordinatorError::LeaseExpired {
                lease_expires_at_ms: expires,
                now_ms,
            });
        }
        if assignment.status != AssignmentStatus::Claimed {
            return Err(CoordinatorError::InvalidTransition {
                current: assignment.status,
            });
        }
        if extend_ms == 0 {
            return Err(CoordinatorError::InvalidLease {
                lease_ms: extend_ms,
            });
        }
        let expires_at = now_ms + extend_ms;
        assignment.lease_expires_at_ms = Some(expires_at);
        Ok(CoordinatorOutcome::LeaseExtended {
            lease_expires_at_ms: expires_at,
        })
    }

    fn complete_work(
        &mut self,
        assignment_id: AssignmentId,
        fence: FenceToken,
        result_digest: String,
        now_ms: u64,
    ) -> Result<CoordinatorOutcome, CoordinatorError> {
        let assignment = self
            .assignments
            .get_mut(&assignment_id)
            .ok_or(CoordinatorError::UnknownAssignment)?;
        if fence.0 != assignment.claim_generation {
            return Err(CoordinatorError::StaleGeneration {
                current_generation: assignment.claim_generation,
                got: fence.0,
            });
        }
        if lease_is_expired(assignment, now_ms) {
            let expires = assignment.lease_expires_at_ms.unwrap_or(now_ms);
            clear_expired_lease(assignment);
            return Err(CoordinatorError::LeaseExpired {
                lease_expires_at_ms: expires,
                now_ms,
            });
        }
        match assignment.status {
            AssignmentStatus::Claimed => {}
            AssignmentStatus::AwaitingReview => {
                return Err(CoordinatorError::DuplicateDelivery {
                    current: assignment.status,
                });
            }
            current => return Err(CoordinatorError::InvalidTransition { current }),
        }
        assignment.status = AssignmentStatus::AwaitingReview;
        assignment.result_digest = Some(result_digest);
        assignment.lease_holder = None;
        assignment.lease_expires_at_ms = None;
        Ok(CoordinatorOutcome::WorkCompleted)
    }

    fn fail_work(
        &mut self,
        assignment_id: AssignmentId,
        fence: FenceToken,
        fail_reason: String,
        now_ms: u64,
    ) -> Result<CoordinatorOutcome, CoordinatorError> {
        let assignment = self
            .assignments
            .get_mut(&assignment_id)
            .ok_or(CoordinatorError::UnknownAssignment)?;
        if fence.0 != assignment.claim_generation {
            return Err(CoordinatorError::StaleGeneration {
                current_generation: assignment.claim_generation,
                got: fence.0,
            });
        }
        if lease_is_expired(assignment, now_ms) {
            let expires = assignment.lease_expires_at_ms.unwrap_or(now_ms);
            clear_expired_lease(assignment);
            return Err(CoordinatorError::LeaseExpired {
                lease_expires_at_ms: expires,
                now_ms,
            });
        }
        if assignment.status != AssignmentStatus::Claimed {
            return Err(CoordinatorError::InvalidTransition {
                current: assignment.status,
            });
        }
        assignment.status = AssignmentStatus::Failed;
        assignment.fail_reason = Some(fail_reason);
        assignment.lease_holder = None;
        assignment.lease_expires_at_ms = None;
        Ok(CoordinatorOutcome::WorkFailed)
    }

    fn submit_review(
        &mut self,
        assignment_id: AssignmentId,
        reviewer: BotId,
        approved: bool,
    ) -> Result<CoordinatorOutcome, CoordinatorError> {
        let assignment = self
            .assignments
            .get_mut(&assignment_id)
            .ok_or(CoordinatorError::UnknownAssignment)?;
        match assignment.status {
            AssignmentStatus::AwaitingReview => {}
            AssignmentStatus::Approved | AssignmentStatus::Rejected => {
                return Err(CoordinatorError::DuplicateDelivery {
                    current: assignment.status,
                });
            }
            current => return Err(CoordinatorError::InvalidTransition { current }),
        }
        assignment.status = if approved {
            AssignmentStatus::Approved
        } else {
            AssignmentStatus::Rejected
        };
        assignment.reviewed_by = Some(reviewer);
        Ok(CoordinatorOutcome::ReviewRecorded { approved })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal() -> GoalId {
        GoalId::new("goal_1").unwrap()
    }

    fn aid(n: u32) -> AssignmentId {
        AssignmentId::new(&format!("asg_{n}")).unwrap()
    }

    fn bot(name: &str) -> BotId {
        BotId::new(name).unwrap()
    }

    fn base_ms(n: u64) -> u64 {
        1_700_000_000_000 + n
    }

    /// Monotonic helper clock: apply at the state's last observed time so
    /// helpers never trip the production `TimeRegression` guard.
    fn apply_at_last_now(
        state: &mut CoordinatorState,
        cmd: CoordinatorCommand,
    ) -> CoordinatorOutcome {
        let now = state.last_now_ms;
        state.apply(cmd, now).unwrap()
    }

    fn register_goal(state: &mut CoordinatorState) {
        apply_at_last_now(state, CoordinatorCommand::RegisterGoal { goal_id: goal() });
    }

    fn add_assignment(state: &mut CoordinatorState, n: u32, deps: &[u32]) {
        let cmd = CoordinatorCommand::RegisterAssignment {
            assignment_id: aid(n),
            goal_id: goal(),
            owner_bot: Some(bot("owner")),
            depends_on: deps.iter().map(|d| aid(*d)).collect(),
        };
        apply_at_last_now(state, cmd);
    }

    fn claim(
        state: &mut CoordinatorState,
        n: u32,
        name: &str,
        lease_ms: u64,
        at: u64,
    ) -> FenceToken {
        let cmd = CoordinatorCommand::Claim {
            assignment_id: aid(n),
            bot_id: bot(name),
            lease_ms,
            expected_generation: None,
        };
        match state.apply(cmd, base_ms(at)).unwrap() {
            CoordinatorOutcome::Claimed { fence, .. } => fence,
            other => panic!("expected Claimed, got {other:?}"),
        }
    }

    fn complete(state: &mut CoordinatorState, n: u32, fence: FenceToken, at: u64) {
        let cmd = CoordinatorCommand::CompleteWork {
            assignment_id: aid(n),
            fence,
            result_digest: format!("digest_{n}"),
        };
        state.apply(cmd, base_ms(at)).unwrap();
    }

    fn approve(state: &mut CoordinatorState, n: u32) {
        let cmd = CoordinatorCommand::SubmitReview {
            assignment_id: aid(n),
            reviewer: bot("reviewer"),
            approved: true,
        };
        apply_at_last_now(state, cmd);
    }

    #[test]
    fn t01_happy_path_claim_complete_review_approve() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let fence = claim(&mut state, 1, "worker_a", 100, 1_000);
        assert_eq!(fence, FenceToken(1));
        assert_eq!(
            state.assignment(&aid(1)).unwrap().lease_expires_at_ms,
            Some(base_ms(1_100))
        );
        complete(&mut state, 1, fence, 1_050);
        let assignment = state.assignment(&aid(1)).unwrap();
        assert_eq!(assignment.status, AssignmentStatus::AwaitingReview);
        assert_eq!(assignment.result_digest.as_deref(), Some("digest_1"));
        approve(&mut state, 1);
        let assignment = state.assignment(&aid(1)).unwrap();
        assert_eq!(assignment.status, AssignmentStatus::Approved);
        assert_eq!(
            assignment.reviewed_by.as_ref().map(|id| id.as_str()),
            Some("reviewer")
        );
        assert_eq!(assignment.claim_generation, 1);
    }

    #[test]
    fn t02_second_claim_rejected_while_lease_live() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        claim(&mut state, 1, "worker_a", 1_000, 1_000);
        let err = state
            .apply(
                CoordinatorCommand::Claim {
                    assignment_id: aid(1),
                    bot_id: bot("worker_b"),
                    lease_ms: 1_000,
                    expected_generation: None,
                },
                base_ms(1_500),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::AlreadyClaimed {
                holder: bot("worker_a"),
                lease_expires_at_ms: base_ms(2_000),
            }
        );
    }

    #[test]
    fn t03_complete_after_expiry_rejected_late_receipt() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let fence = claim(&mut state, 1, "worker_a", 100, 1_000);
        // Deadline itself is inclusive: now_ms == expires_at_ms is invalid.
        let err = state
            .apply(
                CoordinatorCommand::CompleteWork {
                    assignment_id: aid(1),
                    fence,
                    result_digest: "late".into(),
                },
                base_ms(1_100),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::LeaseExpired {
                lease_expires_at_ms: base_ms(1_100),
                now_ms: base_ms(1_100),
            }
        );
        assert_eq!(
            state.assignment(&aid(1)).unwrap().status,
            AssignmentStatus::Registered
        );
        // A fresh claim by another bot succeeds afterwards.
        let fence2 = claim(&mut state, 1, "worker_b", 100, 1_100);
        assert_eq!(fence2, FenceToken(2));
    }

    #[test]
    fn t04_old_fence_rejected_after_reclaim_by_other_bot() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let old_fence = claim(&mut state, 1, "worker_a", 100, 1_000);
        let new_fence = claim(&mut state, 1, "worker_b", 1_000, 1_100);
        assert_eq!(old_fence, FenceToken(1));
        assert_eq!(new_fence, FenceToken(2));
        let err = state
            .apply(
                CoordinatorCommand::CompleteWork {
                    assignment_id: aid(1),
                    fence: old_fence,
                    result_digest: "stale".into(),
                },
                base_ms(1_105),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::StaleGeneration {
                current_generation: 2,
                got: 1,
            }
        );
        complete(&mut state, 1, new_fence, 1_200);
        assert_eq!(
            state.assignment(&aid(1)).unwrap().status,
            AssignmentStatus::AwaitingReview
        );
    }

    #[test]
    fn t05_claim_blocked_until_dependencies_approved() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        add_assignment(&mut state, 2, &[1]);
        // asg_1 not even claimed: dependency not approved.
        let err = state
            .apply(
                CoordinatorCommand::Claim {
                    assignment_id: aid(2),
                    bot_id: bot("worker_b"),
                    lease_ms: 100,
                    expected_generation: None,
                },
                base_ms(1_000),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::DependenciesNotSatisfied {
                pending: vec![aid(1)],
            }
        );
        // Completed but not yet reviewed: still blocked (approved-only gate).
        let fence = claim(&mut state, 1, "worker_a", 1_000, 1_000);
        complete(&mut state, 1, fence, 1_100);
        let err = state
            .apply(
                CoordinatorCommand::Claim {
                    assignment_id: aid(2),
                    bot_id: bot("worker_b"),
                    lease_ms: 100,
                    expected_generation: None,
                },
                base_ms(1_200),
            )
            .unwrap_err();
        assert!(matches!(
            err,
            CoordinatorError::DependenciesNotSatisfied { .. }
        ));
        approve(&mut state, 1);
        let fence2 = claim(&mut state, 2, "worker_b", 100, 1_300);
        assert_eq!(fence2, FenceToken(1));
    }

    #[test]
    fn t06_no_automatic_goal_completion_after_all_approved() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        add_assignment(&mut state, 2, &[]);
        // Explicit times advance monotonically per iteration so the strict
        // TimeRegression gate is exercised, not bypassed.
        for (i, n) in [1u32, 2].iter().enumerate() {
            let at = 1_000 + (i as u64) * 1_000;
            let fence = claim(&mut state, *n, "worker_a", 1_000, at);
            complete(&mut state, *n, fence, at + 100);
            approve(&mut state, *n);
        }
        let progress = state.goal_progress(&goal()).unwrap();
        assert_eq!(progress.total, 2);
        assert_eq!(progress.approved, 2);
        assert_eq!(progress.open, 0);
        assert!(progress.all_reviewed);
        // Every assignment is Approved and nothing was advanced further: the
        // reducer exposes no goal-accepted state, event, or transition. Goal
        // acceptance can only be an explicit outer-Core decision.
        for n in [1, 2] {
            assert_eq!(
                state.assignment(&aid(n)).unwrap().status,
                AssignmentStatus::Approved
            );
        }
    }

    #[test]
    fn t07_lease_extend_valid_and_stale_fence_paths() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let fence = claim(&mut state, 1, "worker_a", 100, 1_000);
        let outcome = state
            .apply(
                CoordinatorCommand::ExtendLease {
                    assignment_id: aid(1),
                    fence,
                    extend_ms: 200,
                },
                base_ms(1_050),
            )
            .unwrap();
        assert_eq!(
            outcome,
            CoordinatorOutcome::LeaseExtended {
                lease_expires_at_ms: base_ms(1_250),
            }
        );
        let err = state
            .apply(
                CoordinatorCommand::ExtendLease {
                    assignment_id: aid(1),
                    fence: FenceToken(2),
                    extend_ms: 200,
                },
                base_ms(1_060),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::StaleGeneration {
                current_generation: 1,
                got: 2,
            }
        );
    }

    #[test]
    fn t08_time_regression_rejected() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        state
            .apply(
                CoordinatorCommand::RegisterGoal {
                    goal_id: GoalId::new("goal_2").unwrap(),
                },
                base_ms(2_000),
            )
            .unwrap();
        let err = state
            .apply(
                CoordinatorCommand::RegisterGoal {
                    goal_id: GoalId::new("goal_3").unwrap(),
                },
                base_ms(1_999),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::TimeRegression {
                last_now_ms: base_ms(2_000),
                got_now_ms: base_ms(1_999),
            }
        );
    }

    #[test]
    fn t09_duplicate_registration_rejected() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let err = state
            .apply(
                CoordinatorCommand::RegisterAssignment {
                    assignment_id: aid(1),
                    goal_id: goal(),
                    owner_bot: None,
                    depends_on: vec![],
                },
                base_ms(1),
            )
            .unwrap_err();
        assert_eq!(err, CoordinatorError::DuplicateAssignment);
        let err = state
            .apply(
                CoordinatorCommand::RegisterGoal { goal_id: goal() },
                base_ms(2),
            )
            .unwrap_err();
        assert_eq!(err, CoordinatorError::DuplicateGoal);
    }

    #[test]
    fn t10_review_and_fail_rejected_outside_awaiting_review() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let err = state
            .apply(
                CoordinatorCommand::SubmitReview {
                    assignment_id: aid(1),
                    reviewer: bot("reviewer"),
                    approved: true,
                },
                base_ms(1),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::InvalidTransition {
                current: AssignmentStatus::Registered,
            }
        );
        // Generation 0 is the pre-claim generation: any fence-0 work command
        // on a never-claimed assignment is rejected, never honored.
        let err = state
            .apply(
                CoordinatorCommand::FailWork {
                    assignment_id: aid(1),
                    fence: FenceToken(0),
                    fail_reason: "never claimed".into(),
                },
                base_ms(2),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::InvalidTransition {
                current: AssignmentStatus::Registered,
            }
        );
    }

    #[test]
    fn t11_invalid_id_rejected() {
        assert_eq!(GoalId::new(""), Err(CoordinatorError::InvalidId));
        assert_eq!(BotId::new("bad\nid"), Err(CoordinatorError::InvalidId));
        let too_long = "x".repeat(129);
        assert_eq!(
            AssignmentId::new(&too_long),
            Err(CoordinatorError::InvalidId)
        );
        let max_len = "x".repeat(128);
        assert!(AssignmentId::new(&max_len).is_ok());
    }

    #[test]
    fn t12_serde_round_trip_command_outcome_assignment_error() {
        let cmd = CoordinatorCommand::Claim {
            assignment_id: AssignmentId::new("asg_1").unwrap(),
            bot_id: BotId::new("worker_a").unwrap(),
            lease_ms: 1_000,
            expected_generation: None,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"claim\""), "got {json}");
        assert!(json.contains("\"assignmentId\":\"asg_1\""), "got {json}");
        assert_eq!(
            serde_json::from_str::<CoordinatorCommand>(&json).unwrap(),
            cmd
        );

        let outcome = CoordinatorOutcome::Claimed {
            fence: FenceToken(3),
            lease_expires_at_ms: 42,
        };
        let json = serde_json::to_string(&outcome).unwrap();
        assert_eq!(
            serde_json::from_str::<CoordinatorOutcome>(&json).unwrap(),
            outcome
        );

        let assignment = Assignment {
            goal_id: GoalId::new("goal_1").unwrap(),
            owner_bot: Some(BotId::new("owner").unwrap()),
            depends_on: vec![AssignmentId::new("asg_0").unwrap()],
            status: AssignmentStatus::AwaitingReview,
            claim_generation: 2,
            lease_holder: None,
            lease_expires_at_ms: None,
            result_digest: Some("d".into()),
            fail_reason: None,
            reviewed_by: None,
        };
        let json = serde_json::to_string(&assignment).unwrap();
        assert_eq!(
            serde_json::from_str::<Assignment>(&json).unwrap(),
            assignment
        );

        let err = CoordinatorError::StaleGeneration {
            current_generation: 2,
            got: 1,
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"code\":\"stale_generation\""), "got {json}");
        assert_eq!(
            serde_json::from_str::<CoordinatorError>(&json).unwrap(),
            err
        );
        assert_eq!(
            err.to_string(),
            "stale fence token: assignment generation is 2, got 1"
        );
    }

    #[test]
    fn t13_self_dependency_and_forward_reference_rejected() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let err = state
            .apply(
                CoordinatorCommand::RegisterAssignment {
                    assignment_id: aid(2),
                    goal_id: goal(),
                    owner_bot: None,
                    depends_on: vec![aid(2)],
                },
                base_ms(1),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::DependencyCycle {
                assignment_id: aid(2),
            }
        );
        // Forward reference: dependencies must be registered first, which also
        // makes cross-assignment cycles structurally impossible.
        let err = state
            .apply(
                CoordinatorCommand::RegisterAssignment {
                    assignment_id: aid(3),
                    goal_id: goal(),
                    owner_bot: None,
                    depends_on: vec![aid(9)],
                },
                base_ms(2),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::UnknownDependency { dependency: aid(9) }
        );
    }

    #[test]
    fn t14_deadline_equality_invalid_for_extend_and_reclaim() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let fence = claim(&mut state, 1, "worker_a", 100, 1_000);
        // now_ms == expires_at_ms: the lease is already dead.
        let err = state
            .apply(
                CoordinatorCommand::ExtendLease {
                    assignment_id: aid(1),
                    fence,
                    extend_ms: 200,
                },
                base_ms(1_100),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::LeaseExpired {
                lease_expires_at_ms: base_ms(1_100),
                now_ms: base_ms(1_100),
            }
        );
        // Reclaim at exactly the deadline succeeds: the lease is over.
        let fence2 = claim(&mut state, 1, "worker_b", 100, 1_100);
        assert_eq!(fence2, FenceToken(2));
    }

    #[test]
    fn t15_duplicate_complete_and_review_produce_no_second_delivery() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let fence = claim(&mut state, 1, "worker_a", 1_000, 1_000);
        complete(&mut state, 1, fence, 1_100);
        let err = state
            .apply(
                CoordinatorCommand::CompleteWork {
                    assignment_id: aid(1),
                    fence,
                    result_digest: "replay".into(),
                },
                base_ms(1_200),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::DuplicateDelivery {
                current: AssignmentStatus::AwaitingReview,
            }
        );
        assert_eq!(
            state.assignment(&aid(1)).unwrap().result_digest.as_deref(),
            Some("digest_1"),
            "first delivery must win, replay must not overwrite"
        );
        approve(&mut state, 1);
        let err = state
            .apply(
                CoordinatorCommand::SubmitReview {
                    assignment_id: aid(1),
                    reviewer: bot("reviewer_2"),
                    approved: false,
                },
                base_ms(1_300),
            )
            .unwrap_err();
        assert_eq!(
            err,
            CoordinatorError::DuplicateDelivery {
                current: AssignmentStatus::Approved,
            }
        );
        assert_eq!(
            state
                .assignment(&aid(1))
                .unwrap()
                .reviewed_by
                .as_ref()
                .map(|id| id.as_str()),
            Some("reviewer"),
            "second review must not overwrite the first"
        );
    }

    #[test]
    fn t16_zero_lease_and_zero_extend_rejected() {
        let mut state = CoordinatorState::new();
        register_goal(&mut state);
        add_assignment(&mut state, 1, &[]);
        let err = state
            .apply(
                CoordinatorCommand::Claim {
                    assignment_id: aid(1),
                    bot_id: bot("worker_a"),
                    lease_ms: 0,
                    expected_generation: None,
                },
                base_ms(1_000),
            )
            .unwrap_err();
        assert_eq!(err, CoordinatorError::InvalidLease { lease_ms: 0 });
        let fence = claim(&mut state, 1, "worker_a", 100, 1_000);
        let err = state
            .apply(
                CoordinatorCommand::ExtendLease {
                    assignment_id: aid(1),
                    fence,
                    extend_ms: 0,
                },
                base_ms(1_050),
            )
            .unwrap_err();
        assert_eq!(err, CoordinatorError::InvalidLease { lease_ms: 0 });
    }
}
