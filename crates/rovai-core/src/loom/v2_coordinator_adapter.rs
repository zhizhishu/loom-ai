//! LOOM V2 coordinator event persistence adapter (P1-C slice): the append-only
//! SQLite ledger for [`loom_protocol::v2_coordinator_replay::EventEnvelope`]
//! streams, one Mission per stream.
//!
//! Scope (P1-C, `docs/loom/LOOM-V2-P1B-ACCEPTANCE-HANDOFF-2026-11-15.md` 交接):
//! - **One table in the existing single Core SQLite database**: this module only
//!   defines the [`MIGRATION_SQL`] constant and the read/append functions over
//!   it. It does not touch any existing table, does not run the migration
//!   itself, and does not fork `loom.rs` / `db.rs` / `db_loom.rs`. The
//!   migration is executed by Root's wiring once, exactly like every other
//!   migration in this crate; until then nothing in the product touches this
//!   table.
//! - **Pure adapter over the pure replay contract**: validation is delegated
//!   to [`loom_protocol::v2_coordinator_replay::replay`] — sequence clock
//!   (contiguous from 1, never regressing `recorded_at_ms`) and anti-forgery
//!   (every stored receipt must match what the reducer recomputes). This
//!   module adds no lifecycle logic of its own.
//! - **Immutable ledger**: the table carries the three-trigger guard used by
//!   the other LOOM ledgers (`loom_review`, `loom_artifact`, …) — no UPDATE, no
//!   `INSERT OR REPLACE` under the same event id or `(mission, sequence)`, no
//!   direct DELETE while the Mission lives. Append is the only write.
//! - **Append semantics**: [`append_envelope`] opens one IMMEDIATE transaction,
//!   re-reads the whole stream of the Mission, replays history plus the new
//!   envelope, and only then inserts. A repeated `event_id` with a byte-equal
//!   payload is an idempotent no-op; the same event id with a different
//!   payload, a different event id on a taken sequence, a foreign Mission, an
//!   unknown Mission, and any replay failure are all refused with nothing
//!   written.
//! - **Owner Review / Stage stay out of this log**: the Owner's verdict is
//!   owned by `loom_review` (`review_record`) and the assistant stage verdict
//!   by `loom_stage_review` (`loom::control`). The reducer's only
//!   review-mutating command is [`CoordinatorCommand::SubmitReview`], so it is
//!   refused here and can never be laundered into the event log. The reducer
//!   has no stage command today; if the protocol ever grows one, this gate
//!   must name it explicitly before it can be persisted.
//! - **Registration**: not registered in `loom.rs` yet; Root registers the
//!   single `mod v2_coordinator_adapter;` line, so deleting this file fully
//!   reverts the slice.

use crate::db::Database;
use anyhow::{Context, Result};
use loom_protocol::v2_coordinator::CoordinatorCommand;
use loom_protocol::v2_coordinator_replay::{EventEnvelope, replay};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

/// Migration SQL for the coordinator event ledger. **Not executed anywhere
/// yet** — Root wires it into the migration chain as a single approved
/// follow-up. The row columns are bound to the envelope payload by CHECKs, so
/// a row can never claim a different sequence or timestamp than the JSON it
/// stores; the immutable triggers are the same shape as the other LOOM
/// ledgers.
pub(crate) const MIGRATION_SQL: &str = r#"
        CREATE TABLE loom_v2_coordinator_event (
            event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 200),
            mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK(sequence >= 1),
            envelope_json TEXT NOT NULL CHECK(
                json_valid(envelope_json)
                AND json_type(envelope_json) = 'object'
                AND json_extract(envelope_json, '$.sequence') = sequence
                AND json_extract(envelope_json, '$.recordedAtMs') = recorded_at
            ),
            recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
            UNIQUE(mission_id, sequence)
        );
        CREATE TRIGGER loom_v2_coordinator_event_immutable
            BEFORE UPDATE ON loom_v2_coordinator_event
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM coordinator event is immutable'); END;
        -- INSERT OR REPLACE would delete and re-insert, slipping past the BEFORE UPDATE
        -- guard, so a second row claiming the same event id or the same stream position
        -- is refused outright.
        CREATE TRIGGER loom_v2_coordinator_event_no_replace
            BEFORE INSERT ON loom_v2_coordinator_event
            WHEN EXISTS(
                SELECT 1 FROM loom_v2_coordinator_event
                WHERE event_id=NEW.event_id
                   OR (mission_id=NEW.mission_id AND sequence=NEW.sequence)
                   OR rowid=NEW.rowid
            )
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM coordinator event is immutable'); END;
        -- A direct DELETE is refused while the Mission still exists; only the aggregate
        -- cascade, where the Mission is already gone, may remove the row.
        CREATE TRIGGER loom_v2_coordinator_event_no_direct_delete
            BEFORE DELETE ON loom_v2_coordinator_event
            WHEN EXISTS(SELECT 1 FROM mission WHERE id=OLD.mission_id)
            BEGIN SELECT RAISE(ABORT, 'a recorded LOOM coordinator event is immutable'); END;
        "#;

/// What [`append_envelope`] did with the submitted envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppendOutcome {
    /// The envelope passed every gate and was appended to the ledger.
    Recorded,
    /// The exact same event id was already recorded with a byte-equal payload;
    /// nothing was written and nothing changed.
    IdempotentReplay,
}

/// Read one Mission's coordinator event stream in sequence order. The stored
/// `sequence` column and the sequence inside the envelope JSON must agree
/// (the schema CHECK already enforces it; re-checked here so a read never
/// silently trusts a tampered row).
pub(crate) fn read_events(connection: &Connection, mission_id: &str) -> Result<Vec<EventEnvelope>> {
    let mut statement = connection.prepare(
        "SELECT sequence, envelope_json FROM loom_v2_coordinator_event
         WHERE mission_id=?1 ORDER BY sequence ASC",
    )?;
    let rows = statement.query_map([mission_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut envelopes = Vec::new();
    for row in rows {
        let (stored_sequence, envelope_json) = row?;
        let envelope: EventEnvelope = serde_json::from_str(&envelope_json).with_context(|| {
            format!(
                "stored LOOM coordinator event JSON for mission {mission_id} is not a valid EventEnvelope"
            )
        })?;
        let envelope_sequence = i64::try_from(envelope.sequence)
            .context("LOOM coordinator event sequence does not fit SQLite")?;
        anyhow::ensure!(
            envelope_sequence == stored_sequence,
            "LOOM coordinator event row for mission {mission_id} claims sequence {stored_sequence} but its envelope says {}",
            envelope.sequence
        );
        envelopes.push(envelope);
    }
    Ok(envelopes)
}

/// Append one envelope to one Mission's coordinator event log inside a single
/// IMMEDIATE transaction. The whole stream is re-read and replayed (history
/// plus the new envelope) before anything is written, so a forged receipt, a
/// sequence gap, a regressing clock, or a duplicate identity is refused with
/// nothing committed.
pub(crate) fn append_envelope(
    database: &mut Database,
    mission_id: &str,
    event_id: &str,
    envelope: &EventEnvelope,
) -> Result<AppendOutcome> {
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let outcome = append_envelope_in_transaction(&transaction, mission_id, event_id, envelope)?;
    transaction.commit()?;
    Ok(outcome)
}

/// The gates of [`append_envelope`], shared with the in-memory fixtures. Runs
/// inside the caller's transaction; nothing here opens its own.
fn append_envelope_in_transaction(
    connection: &Connection,
    mission_id: &str,
    event_id: &str,
    envelope: &EventEnvelope,
) -> Result<AppendOutcome> {
    anyhow::ensure!(
        !event_id.is_empty() && event_id.len() <= 200,
        "LOOM coordinator event rejected: event id must be 1..=200 bytes"
    );
    // Gate 1: the stream belongs to a real Mission. A foreign or unknown
    // Mission is refused before anything else is consulted.
    let mission_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission WHERE id=?1)",
        [mission_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        mission_exists,
        "LOOM coordinator event rejected: mission {mission_id} does not exist"
    );
    // Gate 2: the Owner Review / Stage verdicts are not coordinator events.
    anyhow::ensure!(
        !refuses_owner_review_or_stage(&envelope.command),
        "LOOM coordinator event rejected: command at sequence {} would change the Owner Review / \
         Stage verdict, which is owned by loom_review / loom_control and cannot be recorded here",
        envelope.sequence
    );
    // Gate 3: the event id is a global ledger identity. Same id + same payload
    // is the idempotent replay; same id + different payload, or the same id
    // under another Mission, is refused.
    let existing: Option<(String, String)> = connection
        .query_row(
            "SELECT mission_id, envelope_json FROM loom_v2_coordinator_event WHERE event_id=?1",
            [event_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((existing_mission, existing_json)) = existing {
        anyhow::ensure!(
            existing_mission == mission_id,
            "LOOM coordinator event rejected: event id {event_id} is already recorded for mission {existing_mission}"
        );
        let stored: EventEnvelope = serde_json::from_str(&existing_json).with_context(|| {
            format!(
                "stored LOOM coordinator event JSON for event id {event_id} is not a valid EventEnvelope"
            )
        })?;
        if stored == *envelope {
            return Ok(AppendOutcome::IdempotentReplay);
        }
        anyhow::bail!(
            "LOOM coordinator event rejected: event id {event_id} is already recorded with a different payload"
        );
    }
    // Gate 4: the stream position is not taken by another event id. A new id
    // on a taken sequence would otherwise masquerade as an append.
    let sequence = i64::try_from(envelope.sequence)
        .context("LOOM coordinator event sequence does not fit SQLite")?;
    let taken_by: Option<String> = connection
        .query_row(
            "SELECT event_id FROM loom_v2_coordinator_event
             WHERE mission_id=?1 AND sequence=?2",
            params![mission_id, sequence],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        taken_by.is_none(),
        "LOOM coordinator event rejected: sequence {} of mission {mission_id} is already recorded under event id {}",
        envelope.sequence,
        taken_by.unwrap_or_default()
    );
    // Gate 5: full replay validation. History is contiguous from 1 by the
    // schema, so merging the new envelope and replaying validates the sequence
    // clock and every receipt — the new one included — against the reducer.
    let mut stream = read_events(connection, mission_id)?;
    stream.push(envelope.clone());
    replay(&stream).map_err(|error| {
        anyhow::anyhow!(
            "LOOM coordinator event rejected: stream of mission {mission_id} failed replay validation: {error}"
        )
    })?;
    // Plain INSERT, never REPLACE: the no_replace trigger keeps the ledger
    // append-only even against a caller that tries to bypass this module.
    let recorded_at = i64::try_from(envelope.recorded_at_ms)
        .context("LOOM coordinator event recorded_at does not fit SQLite")?;
    let envelope_json = serde_json::to_string(envelope)
        .context("LOOM coordinator event envelope could not be serialized")?;
    connection.execute(
        "INSERT INTO loom_v2_coordinator_event
             (event_id, mission_id, sequence, envelope_json, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![event_id, mission_id, sequence, envelope_json, recorded_at],
    )?;
    Ok(AppendOutcome::Recorded)
}

/// The Owner's verdict (`loom_review`) and the assistant's stage verdict
/// (`loom_stage_review`) are recorded by their own modules and are not
/// coordinator events. The reducer's only review-mutating command is
/// `SubmitReview`; it is refused here so the event log can never carry — or
/// through replay, reproduce — an Owner Review / Stage transition.
fn refuses_owner_review_or_stage(command: &CoordinatorCommand) -> bool {
    matches!(command, CoordinatorCommand::SubmitReview { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use loom_protocol::v2_coordinator::{
        AssignmentId, BotId, CoordinatorError, CoordinatorOutcome, FenceToken, GoalId,
    };
    use loom_protocol::v2_coordinator_replay::RecordedAttempt;
    use rusqlite::Connection;

    const MISSION: &str = "mission_fixture";
    const MISSION_B: &str = "mission_fixture_b";
    const BASE_MS: u64 = 1_700_000_000_000;

    /// In-memory fixture: a minimal `mission` parent table (the real Core
    /// schema has many more columns; only `id` matters for the FK), the
    /// migration under test, and two real Mission rows. Foreign keys stay ON
    /// so the FK and the delete guard behave as in production.
    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE mission (id TEXT PRIMARY KEY NOT NULL);",
            )
            .unwrap();
        connection.execute_batch(MIGRATION_SQL).unwrap();
        for mission in [MISSION, MISSION_B] {
            connection
                .execute("INSERT INTO mission (id) VALUES (?1)", [mission])
                .unwrap();
        }
        connection
    }

    fn goal() -> GoalId {
        GoalId::new("goal_1").unwrap()
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

    fn applied(outcome: CoordinatorOutcome) -> RecordedAttempt {
        RecordedAttempt::Applied { outcome }
    }

    fn rejected(error: CoordinatorError) -> RecordedAttempt {
        RecordedAttempt::Rejected { error }
    }

    fn env(
        sequence: u64,
        recorded_at_ms: u64,
        command: CoordinatorCommand,
        attempt: RecordedAttempt,
    ) -> EventEnvelope {
        EventEnvelope {
            sequence,
            recorded_at_ms,
            command,
            attempt,
        }
    }

    fn append(
        connection: &Connection,
        mission_id: &str,
        event_id: &str,
        envelope: &EventEnvelope,
    ) -> Result<AppendOutcome> {
        append_envelope_in_transaction(connection, mission_id, event_id, envelope)
    }

    fn row_count(connection: &Connection, mission_id: &str) -> usize {
        connection
            .query_row(
                "SELECT COUNT(*) FROM loom_v2_coordinator_event WHERE mission_id=?1",
                [mission_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap() as usize
    }

    /// seq 1: RegisterGoal, seq 2: RegisterAssignment, seq 3: live Claim
    /// (lease 1000 ms from at(1000), fence 1, expires at(2000)).
    fn honest_prefix() -> Vec<(&'static str, EventEnvelope)> {
        vec![
            (
                "ev_1",
                env(
                    1,
                    at(1),
                    CoordinatorCommand::RegisterGoal { goal_id: goal() },
                    applied(CoordinatorOutcome::GoalRegistered),
                ),
            ),
            (
                "ev_2",
                env(
                    2,
                    at(2),
                    CoordinatorCommand::RegisterAssignment {
                        assignment_id: aid(1),
                        goal_id: goal(),
                        owner_bot: Some(bot("owner")),
                        depends_on: vec![],
                    },
                    applied(CoordinatorOutcome::AssignmentRegistered),
                ),
            ),
            (
                "ev_3",
                env(
                    3,
                    at(1_000),
                    CoordinatorCommand::Claim {
                        assignment_id: aid(1),
                        bot_id: bot("worker_a"),
                        lease_ms: 1_000,
                        expected_generation: None,
                    },
                    applied(CoordinatorOutcome::Claimed {
                        fence: FenceToken(1),
                        lease_expires_at_ms: at(2_000),
                    }),
                ),
            ),
        ]
    }

    fn seed_honest_prefix(connection: &Connection) {
        for (event_id, envelope) in honest_prefix() {
            append(connection, MISSION, event_id, &envelope).unwrap();
        }
    }

    #[test]
    fn t01_migration_creates_the_immutable_event_table() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE mission (id TEXT PRIMARY KEY NOT NULL);")
            .unwrap();
        connection.execute_batch(MIGRATION_SQL).unwrap();
        let tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'
                     AND name='loom_v2_coordinator_event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
        let triggers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='loom_v2_coordinator_event'
                     AND name IN ('loom_v2_coordinator_event_immutable',
                                  'loom_v2_coordinator_event_no_replace',
                                  'loom_v2_coordinator_event_no_direct_delete')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(triggers, 3, "the three immutability triggers must exist");
    }

    #[test]
    fn t02_read_events_of_an_empty_mission_is_empty() {
        let connection = connection();
        assert_eq!(read_events(&connection, MISSION).unwrap(), vec![]);
    }

    #[test]
    fn t03_append_records_an_honest_stream_and_reads_it_back_in_order() {
        let connection = connection();
        for (event_id, envelope) in honest_prefix() {
            assert_eq!(
                append(&connection, MISSION, event_id, &envelope).unwrap(),
                AppendOutcome::Recorded
            );
        }
        let read_back = read_events(&connection, MISSION).unwrap();
        let expected: Vec<EventEnvelope> = honest_prefix()
            .into_iter()
            .map(|(_, envelope)| envelope)
            .collect();
        assert_eq!(read_back, expected);
    }

    #[test]
    fn t04_same_event_id_and_payload_is_an_idempotent_no_op() {
        let connection = connection();
        seed_honest_prefix(&connection);
        let (event_id, envelope) = honest_prefix().pop().unwrap();
        assert_eq!(
            append(&connection, MISSION, event_id, &envelope).unwrap(),
            AppendOutcome::IdempotentReplay
        );
        assert_eq!(row_count(&connection, MISSION), 3);
        assert_eq!(read_events(&connection, MISSION).unwrap().len(), 3);
    }

    #[test]
    fn t05_same_event_id_with_a_different_payload_is_rejected() {
        let connection = connection();
        seed_honest_prefix(&connection);
        let different = env(
            3,
            at(1_000),
            CoordinatorCommand::Claim {
                assignment_id: aid(1),
                bot_id: bot("worker_a"),
                lease_ms: 1_000,
                expected_generation: None,
            },
            applied(CoordinatorOutcome::Claimed {
                fence: FenceToken(1),
                lease_expires_at_ms: at(9_999),
            }),
        );
        let error = append(&connection, MISSION, "ev_3", &different).unwrap_err();
        assert!(
            error.to_string().contains("different payload"),
            "got {error}"
        );
        assert_eq!(row_count(&connection, MISSION), 3);
    }

    #[test]
    fn t06_an_unknown_mission_is_rejected() {
        let connection = connection();
        let (event_id, envelope) = honest_prefix().remove(0);
        let error = append(&connection, "mission_unknown", event_id, &envelope).unwrap_err();
        assert!(error.to_string().contains("does not exist"), "got {error}");
        assert_eq!(row_count(&connection, "mission_unknown"), 0);
        assert_eq!(row_count(&connection, MISSION), 0);
    }

    #[test]
    fn t07_a_sequence_gap_is_rejected_and_nothing_is_written() {
        let connection = connection();
        seed_honest_prefix(&connection);
        let gap = env(
            5,
            at(1_100),
            CoordinatorCommand::CompleteWork {
                assignment_id: aid(1),
                fence: FenceToken(1),
                result_digest: "digest_1".into(),
            },
            applied(CoordinatorOutcome::WorkCompleted),
        );
        let error = append(&connection, MISSION, "ev_5", &gap).unwrap_err();
        assert!(error.to_string().contains("sequence gap"), "got {error}");
        assert_eq!(row_count(&connection, MISSION), 3);
    }

    #[test]
    fn t08_a_taken_sequence_under_a_new_event_id_is_rejected() {
        let connection = connection();
        seed_honest_prefix(&connection);
        let stolen = env(
            3,
            at(1_100),
            CoordinatorCommand::CompleteWork {
                assignment_id: aid(1),
                fence: FenceToken(1),
                result_digest: "digest_1".into(),
            },
            applied(CoordinatorOutcome::WorkCompleted),
        );
        let error = append(&connection, MISSION, "ev_other", &stolen).unwrap_err();
        assert!(
            error.to_string().contains("already recorded"),
            "got {error}"
        );
        assert_eq!(row_count(&connection, MISSION), 3);
    }

    #[test]
    fn t09_a_regressing_clock_is_rejected() {
        let connection = connection();
        seed_honest_prefix(&connection);
        let regressing = env(
            4,
            at(1),
            CoordinatorCommand::RegisterGoal {
                goal_id: GoalId::new("goal_2").unwrap(),
            },
            applied(CoordinatorOutcome::GoalRegistered),
        );
        let error = append(&connection, MISSION, "ev_4", &regressing).unwrap_err();
        assert!(error.to_string().contains("time regression"), "got {error}");
        assert_eq!(row_count(&connection, MISSION), 3);
    }

    #[test]
    fn t10_a_forged_applied_receipt_is_rejected() {
        let connection = connection();
        // Seed legitimate seq 1 and 2 so seq 3 reaches receipt validation,
        // rather than getting rejected by the sequence-gap guard first.
        for (event_id, envelope) in honest_prefix().into_iter().take(2) {
            append(&connection, MISSION, event_id, &envelope).unwrap();
        }
        // seq 3 claims a lease that really expires at(2000), but the receipt
        // names a forged expiry — replay recomputes the truth and refuses.
        let forged = env(
            3,
            at(1_000),
            CoordinatorCommand::Claim {
                assignment_id: aid(1),
                bot_id: bot("worker_a"),
                lease_ms: 1_000,
                expected_generation: None,
            },
            applied(CoordinatorOutcome::Claimed {
                fence: FenceToken(1),
                lease_expires_at_ms: 9_999,
            }),
        );
        let error = append(&connection, MISSION, "ev_3", &forged).unwrap_err();
        assert!(
            error.to_string().contains("replay diverged at sequence 3"),
            "got {error}"
        );
        assert_eq!(row_count(&connection, MISSION), 2);
    }

    #[test]
    fn t11_an_honest_rejection_is_still_a_valid_append() {
        let connection = connection();
        seed_honest_prefix(&connection);
        // A second claim while the lease is live: rejected by the reducer, but
        // the rejection itself is an honest, recordable fact.
        let second_claim = env(
            4,
            at(1_100),
            CoordinatorCommand::Claim {
                assignment_id: aid(1),
                bot_id: bot("worker_b"),
                lease_ms: 1_000,
                expected_generation: None,
            },
            rejected(CoordinatorError::AlreadyClaimed {
                holder: bot("worker_a"),
                lease_expires_at_ms: at(2_000),
            }),
        );
        assert_eq!(
            append(&connection, MISSION, "ev_4", &second_claim).unwrap(),
            AppendOutcome::Recorded
        );
        assert_eq!(row_count(&connection, MISSION), 4);
        let read_back = read_events(&connection, MISSION).unwrap();
        assert_eq!(read_back.last().unwrap(), &second_claim);
    }

    #[test]
    fn t12_submit_review_is_refused_as_an_owner_review_change() {
        let connection = connection();
        seed_honest_prefix(&connection);
        // CompleteWork first, so a SubmitReview would even be a valid reducer
        // transition — the adapter must still refuse it.
        let complete = env(
            4,
            at(1_500),
            CoordinatorCommand::CompleteWork {
                assignment_id: aid(1),
                fence: FenceToken(1),
                result_digest: "digest_1".into(),
            },
            applied(CoordinatorOutcome::WorkCompleted),
        );
        append(&connection, MISSION, "ev_4", &complete).unwrap();
        let review = env(
            5,
            at(1_600),
            CoordinatorCommand::SubmitReview {
                assignment_id: aid(1),
                reviewer: bot("reviewer"),
                approved: true,
            },
            applied(CoordinatorOutcome::ReviewRecorded { approved: true }),
        );
        let error = append(&connection, MISSION, "ev_5", &review).unwrap_err();
        assert!(error.to_string().contains("Owner Review"), "got {error}");
        assert_eq!(row_count(&connection, MISSION), 4);
    }

    #[test]
    fn t13_triggers_refuse_update_replace_and_delete_of_recorded_events() {
        let connection = connection();
        seed_honest_prefix(&connection);
        let update = connection.execute(
            "UPDATE loom_v2_coordinator_event SET envelope_json='{}' WHERE event_id='ev_1'",
            [],
        );
        assert!(update.is_err(), "UPDATE must be refused");
        assert!(
            update.unwrap_err().to_string().contains("immutable"),
            "the UPDATE must fail with the immutability reason"
        );
        let replace = connection.execute(
            "INSERT OR REPLACE INTO loom_v2_coordinator_event
                 (event_id, mission_id, sequence, envelope_json, recorded_at)
             VALUES ('ev_1', ?1, 1, '{}', 0)",
            [MISSION],
        );
        assert!(
            replace.unwrap_err().to_string().contains("immutable"),
            "INSERT OR REPLACE must be refused"
        );
        let delete = connection.execute(
            "DELETE FROM loom_v2_coordinator_event WHERE event_id='ev_1'",
            [],
        );
        assert!(
            delete.unwrap_err().to_string().contains("immutable"),
            "DELETE must be refused"
        );
        assert_eq!(row_count(&connection, MISSION), 3);
        assert_eq!(read_events(&connection, MISSION).unwrap().len(), 3);
    }

    #[test]
    fn t14_missions_are_isolated_and_event_ids_are_global() {
        let connection = connection();
        let (event_id, envelope) = honest_prefix().remove(0);
        append(&connection, MISSION, event_id, &envelope).unwrap();
        // The same payload under another Mission is a legitimate second
        // stream: sequences are per-Mission.
        append(&connection, MISSION_B, "ev_b_1", &envelope).unwrap();
        assert_eq!(row_count(&connection, MISSION), 1);
        assert_eq!(row_count(&connection, MISSION_B), 1);
        assert_eq!(
            read_events(&connection, MISSION_B).unwrap(),
            vec![envelope.clone()]
        );
        // But the same event id cannot be recorded a third time anywhere.
        let error = append(&connection, MISSION_B, "ev_1", &envelope).unwrap_err();
        assert!(
            error.to_string().contains("already recorded for mission"),
            "got {error}"
        );
        assert_eq!(row_count(&connection, MISSION_B), 1);
    }

    #[test]
    fn t15_the_persisted_stream_replays_to_the_reducer_state() {
        let connection = connection();
        seed_honest_prefix(&connection);
        let complete = env(
            4,
            at(1_500),
            CoordinatorCommand::CompleteWork {
                assignment_id: aid(1),
                fence: FenceToken(1),
                result_digest: "digest_1".into(),
            },
            applied(CoordinatorOutcome::WorkCompleted),
        );
        append(&connection, MISSION, "ev_4", &complete).unwrap();

        let persisted = read_events(&connection, MISSION).unwrap();
        let (replayed, attempts) = loom_protocol::v2_coordinator_replay::replay(&persisted)
            .expect("the persisted stream must replay cleanly");
        // The rebuilt state equals the live reducer fed the same commands.
        let mut live = loom_protocol::v2_coordinator::CoordinatorState::new();
        let mut expected_attempts = Vec::new();
        for envelope in &persisted {
            expected_attempts.push(
                match live.apply(envelope.command.clone(), envelope.recorded_at_ms) {
                    Ok(outcome) => RecordedAttempt::Applied { outcome },
                    Err(error) => RecordedAttempt::Rejected { error },
                },
            );
        }
        assert_eq!(replayed, live);
        assert_eq!(attempts, expected_attempts);
    }
}
