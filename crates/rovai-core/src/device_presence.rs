//! Device presence: a device is online while the session it opened last is open.
//!
//! Presence is a column read, never a call to a gateway. This is availability, not
//! authority: callers still check owner/enabled. Ported from the Mikka
//! `lib/device-presence.ts` decision that replaced the heartbeat window with the
//! device session pair (`2026-11-17-2215`).
//!
//! The session pair is `(session_opened_at, session_closed_at)`: a device that never
//! opened a session is offline, an open session is online whatever time has passed,
//! and an older close belongs to a socket that has since been replaced.

use chrono::{DateTime, Utc};

/// The device session pair a presence answer is read from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeviceSessionState {
    pub session_opened_at: Option<DateTime<Utc>>,
    pub session_closed_at: Option<DateTime<Utc>>,
}

/// The session pair of one stored row. A stamp that is absent or unreadable is absent,
/// which is how every other stamp reader in Core treats a stored time.
pub fn device_session_state(
    session_opened_at: Option<&str>,
    session_closed_at: Option<&str>,
) -> DeviceSessionState {
    DeviceSessionState {
        session_opened_at: parse_stamp(session_opened_at),
        session_closed_at: parse_stamp(session_closed_at),
    }
}

fn parse_stamp(stamp: Option<&str>) -> Option<DateTime<Utc>> {
    let stamp = stamp?;
    DateTime::parse_from_rfc3339(stamp)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

/// One device's presence source: its id plus the session pair.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevicePresence {
    pub id: String,
    pub session: DeviceSessionState,
}

/// The one presence rule. A device is online while the session it opened last is not
/// closed, whatever time has passed: there is no heartbeat clock here.
pub fn is_device_online(device: &DeviceSessionState) -> bool {
    let Some(opened) = device.session_opened_at else {
        return false;
    };
    match device.session_closed_at {
        None => true,
        Some(closed) => closed < opened,
    }
}

/// SQL form of [`is_device_online`] for an `execution_node` row under `alias`.
///
/// This is the same rule written as one predicate, so a query and
/// [`is_device_online`] cannot drift apart. Migration 239 stores the pair in the snake_case
/// columns `session_opened_at` / `session_closed_at`; the upstream camelCase field names are
/// not column names here, so a quoted `"sessionOpenedAt"` would read a column that does not
/// exist instead of the one the writer updates.
pub fn device_session_open_sql(alias: &str) -> String {
    format!(
        "({alias}.session_opened_at IS NOT NULL AND ({alias}.session_closed_at IS NULL OR {alias}.session_closed_at < {alias}.session_opened_at))"
    )
}

/// Presence of a page's devices, by id, in row order.
///
/// The first insertion order of an id is kept and a later row for the same id replaces
/// the earlier answer, which is what the source `Map` did.
pub fn device_online_states(rows: &[DevicePresence]) -> Vec<(String, bool)> {
    let mut states: Vec<(String, bool)> = Vec::with_capacity(rows.len());
    for device in rows {
        let online = is_device_online(&device.session);
        match states.iter_mut().find(|(id, _)| *id == device.id) {
            Some(entry) => entry.1 = online,
            None => states.push((device.id.clone(), online)),
        }
    }
    states
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    const ID: &str = "11111111-1111-4111-8111-111111111111";

    fn instant(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("a legal RFC 3339 instant")
            .with_timezone(&Utc)
    }

    #[test]
    fn a_device_is_online_while_the_session_it_opened_last_is_not_closed_whatever_time_has_passed() {
        let opened = instant("2026-11-17T10:00:00.000Z");
        let online = DeviceSessionState {
            session_opened_at: Some(opened),
            session_closed_at: None,
        };
        assert!(is_device_online(&online));
        assert!(
            is_device_online(&DeviceSessionState {
                session_opened_at: Some(instant("2020-01-01T00:00:00.000Z")),
                session_closed_at: None,
            }),
            "no heartbeat clock: an old open session is still open"
        );
        assert!(
            !is_device_online(&DeviceSessionState {
                session_opened_at: None,
                session_closed_at: None,
            }),
            "never connected"
        );
        assert!(!is_device_online(&DeviceSessionState {
            session_opened_at: Some(opened),
            session_closed_at: Some(opened + Duration::milliseconds(1)),
        }));
        assert!(
            !is_device_online(&DeviceSessionState {
                session_opened_at: Some(opened),
                session_closed_at: Some(opened),
            }),
            "a close at the same instant ends it"
        );
        assert!(
            is_device_online(&DeviceSessionState {
                session_opened_at: Some(opened),
                session_closed_at: Some(opened - Duration::milliseconds(1)),
            }),
            "an older close belongs to a replaced socket"
        );
    }

    #[test]
    fn a_page_reads_presence_from_its_rows() {
        let online = DevicePresence {
            id: ID.to_owned(),
            session: DeviceSessionState {
                session_opened_at: Some(instant("2026-11-17T10:00:00.000Z")),
                session_closed_at: None,
            },
        };
        let never_connected = DevicePresence {
            id: "22222222-2222-4222-8222-222222222222".to_owned(),
            session: DeviceSessionState {
                session_opened_at: None,
                session_closed_at: None,
            },
        };
        assert_eq!(
            device_online_states(&[online, never_connected]),
            vec![
                (ID.to_owned(), true),
                ("22222222-2222-4222-8222-222222222222".to_owned(), false),
            ]
        );
    }

    #[test]
    fn a_stored_stamp_pair_reads_as_the_same_rule() {
        assert_eq!(
            device_session_state(None, None),
            DeviceSessionState::default(),
            "never connected"
        );
        assert!(is_device_online(&device_session_state(
            Some("2026-11-17T10:00:00.000Z"),
            None
        )));
        assert!(!is_device_online(&device_session_state(
            Some("2026-11-17T10:00:00.000Z"),
            Some("2026-11-17T10:00:20.000Z")
        )));
        assert!(
            is_device_online(&device_session_state(
                Some("2026-11-17T10:00:00.000Z"),
                Some("2026-11-17T09:59:00.000Z")
            )),
            "an older close belongs to a replaced socket"
        );
        assert!(
            is_device_online(&device_session_state(
                Some("2026-11-17T10:00:00.000Z"),
                Some("not-a-time")
            )),
            "an unreadable close is absent, so the session it did not close stays open"
        );
    }

    /// The rule as one predicate, and the predicate has to read the columns the store really
    /// has: a quoted upstream field name names a column no migration ever added.
    #[test]
    fn the_sql_predicate_is_the_same_rule() {
        assert_eq!(
            device_session_open_sql("d"),
            "(d.session_opened_at IS NOT NULL AND (d.session_closed_at IS NULL OR d.session_closed_at < d.session_opened_at))"
        );
        let connection = rusqlite::Connection::open_in_memory().expect("an in-memory store");
        connection
            .execute_batch(
                "CREATE TABLE execution_node (
                    node_id TEXT PRIMARY KEY,
                    session_opened_at TEXT,
                    session_closed_at TEXT
                 );
                 INSERT INTO execution_node(node_id,session_opened_at,session_closed_at)
                 VALUES('open','2026-11-17T10:00:00.000Z',NULL),
                       ('closed','2026-11-17T10:00:00.000Z','2026-11-17T10:00:20.000Z'),
                       ('never',NULL,NULL),
                       ('replaced','2026-11-17T10:00:00.000Z','2026-11-17T09:59:00.000Z');",
            )
            .expect("the session columns migration 239 adds");
        let predicate = device_session_open_sql("n");
        let online = |id: &str| -> bool {
            connection
                .query_row(
                    &format!("SELECT {predicate} FROM execution_node AS n WHERE n.node_id=?1"),
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .expect("the predicate must run against the stored session columns")
                == 1
        };
        assert!(online("open"));
        assert!(!online("closed"));
        assert!(!online("never"), "never connected");
        assert!(
            online("replaced"),
            "an older close belongs to a replaced socket"
        );
    }
}
